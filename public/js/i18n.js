// Interface language: Russian (source language of the whole UI) <-> English.
//
// The UI texts live in app.js / index.html / server messages as Russian strings. Instead of
// rewriting thousands of them, this module translates the *rendered* page: it walks the DOM
// (text nodes + title/placeholder/aria-label/alt attributes), looks every Russian fragment up in
// the dictionary from i18n-en.js and keeps watching the DOM for new content. Switching back to
// Russian restores the original strings, so nothing is lost either way.
//
//   window.i18n.lang()        current language ("ru" | "en")
//   window.i18n.setLang(l)    switch + remember the choice
//   window.i18n.t(text)       translate a string that does not go through the DOM (alert, files)
//   window.i18n.locale()      "ru-RU" / "en-US" for toLocaleString
//   window.i18n.registerDataset(ds)   learn English names for the items/recipes of a dump
//
// Language choice: saved choice > browser/system language (Russian -> ru, anything else -> en).
(function () {
  "use strict";

  var STORAGE_KEY = "chaincalc.lang";
  var CYR = /[А-Яа-яЁё]/;
  var CYR_LETTER = "А-Яа-яЁё";
  var ATTRS = ["title", "placeholder", "aria-label", "alt"];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };

  function detectLang() {
    try {
      var saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "ru" || saved === "en") return saved;
    } catch (e) { /* storage may be blocked */ }
    var candidates = [];
    if (navigator.languages && navigator.languages.length) candidates.push(navigator.languages[0]);
    if (navigator.language) candidates.push(navigator.language);
    try { candidates.push(Intl.DateTimeFormat().resolvedOptions().locale); } catch (e) { /* ignore */ }
    for (var i = 0; i < candidates.length; i++) {
      if (/^ru(\b|-|_)/i.test(String(candidates[i] || ""))) return "ru";
    }
    return "en";
  }

  var lang = detectLang();

  // ---------------------------------------------------------------- dictionary
  var phrases = window.__I18N_EN || {};
  var phraseCache = new Map();
  var trie = null;
  var HEAD_LETTER = new RegExp("[" + CYR_LETTER + "0-9]");
  var CYR_UPPER = /[А-ЯЁ]/;

  // Trie over all phrases: findPhrases() reports every phrase starting at every position, so
  // overlapping candidates can compete (see translateCore).
  function buildTrie() {
    trie = {};
    // The UI lower-cases some names ("Качество" -> "качество" in a sentence): every phrase that
    // starts with a capital also gets a lower-case-initial twin.
    Object.keys(phrases).forEach(function (key) {
      var first = key.charAt(0);
      var lower = first.toLowerCase();
      if (first !== lower && CYR_UPPER.test(first)) {
        var twin = lower + key.slice(1);
        if (phrases[twin] === undefined) {
          phrases[twin] = phrases[key].charAt(0).toLowerCase() + phrases[key].slice(1);
        }
      }
    });
    Object.keys(phrases).forEach(function (key) {
      var node = trie;
      for (var i = 0; i < key.length; i++) {
        var ch = key.charAt(i);
        node = node[ch] || (node[ch] = {});
      }
      node.$ = key;
    });
  }

  function findPhrases(text) {
    if (!trie) buildTrie();
    var found = [];
    var n = text.length;
    for (var i = 0; i < n; i++) {
      if (!trie[text.charAt(i)]) continue;
      var prevIsLetter = i > 0 && LETTER_RE.test(text.charAt(i - 1));
      var node = trie;
      for (var j = i; j < n; j++) {
        node = node[text.charAt(j)];
        if (!node) break;
        var key = node.$;
        if (key === undefined) continue;
        if (HEAD_LETTER.test(key.charAt(0)) && prevIsLetter) continue;
        if (HEAD_LETTER.test(key.charAt(key.length - 1)) && j + 1 < n && LETTER_RE.test(text.charAt(j + 1))) continue;
        found.push({ start: i, end: j + 1, en: phrases[key] });
      }
    }
    return found;
  }

  // Item / recipe / machine names of the loaded dump: Russian display name -> English name made
  // from the internal id ("iron-plate" -> "Iron plate").
  var names = new Map();            // ru display name -> en
  var namesByFirstWord = new Map(); // first word -> [ru names, longest first]
  var WORD_RE = new RegExp("[" + CYR_LETTER + "][" + CYR_LETTER + "0-9\\-]*", "g");
  var LETTER_RE = new RegExp("[" + CYR_LETTER + "]");

  function prettify(id) {
    return String(id || "").replace(/[-_]+/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); });
  }

  function registerDataset(ds) {
    if (!ds || typeof ds !== "object") return;
    var changed = false;
    ["items", "fluids", "recipes", "entities"].forEach(function (table) {
      var rows = ds[table];
      if (!rows || typeof rows !== "object") return;
      Object.keys(rows).forEach(function (key) {
        var row = rows[key];
        var ru = row && row.display_name;
        if (!ru || !CYR.test(ru)) return;
        ru = String(ru).replace(/\s+/g, " ").trim();
        if (names.has(ru)) return;
        names.set(ru, prettify(row.name || key));
        changed = true;
      });
    });
    if (!changed) return;
    namesByFirstWord = new Map();
    names.forEach(function (_en, ru) {
      var m = ru.match(WORD_RE);
      var first = m && ru.indexOf(m[0]) === 0 ? m[0] : null;
      if (!first) return;
      if (!namesByFirstWord.has(first)) namesByFirstWord.set(first, []);
      namesByFirstWord.get(first).push(ru);
    });
    namesByFirstWord.forEach(function (list) { list.sort(function (a, b) { return b.length - a.length; }); });
    phraseCache.clear();
    if (lang === "en") scheduleRefresh();
  }

  // Every dump name found in `text`: [{ start, end, en }].
  function findNames(text) {
    var found = [];
    if (!names.size) return found;
    var m;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(text)) !== null) {
      var start = m.index;
      if (start > 0 && LETTER_RE.test(text.charAt(start - 1))) continue;
      var list = namesByFirstWord.get(m[0]);
      if (!list) continue;
      for (var i = 0; i < list.length; i++) {
        var cand = list[i];
        if (text.substr(start, cand.length) !== cand) continue;
        var after = text.charAt(start + cand.length);
        if (after && LETTER_RE.test(after)) continue;
        found.push({ start: start, end: start + cand.length, en: names.get(cand) });
        break; // longest name for this start
      }
    }
    return found;
  }

  // Phrases and dump names compete for the same text ("Лента последнего блока (" vs the item
  // "Лента"): the longest match wins, so a name never breaks a sentence and a UI word never
  // breaks a name ("Паровой манипулятор").
  function translateCore(core) {
    var cands = findNames(core);
    cands = cands.concat(findPhrases(core));
    if (!cands.length) return core;
    cands.sort(function (a, b) { return (b.end - b.start) - (a.end - a.start) || a.start - b.start; });
    var taken = [];
    cands.forEach(function (c) {
      for (var i = 0; i < taken.length; i++) {
        if (c.start < taken[i].end && taken[i].start < c.end) return;
      }
      taken.push(c);
    });
    taken.sort(function (a, b) { return a.start - b.start; });
    var out = "";
    var pos = 0;
    taken.forEach(function (c) { out += core.slice(pos, c.start) + c.en; pos = c.end; });
    return out + core.slice(pos);
  }

  // Translate one string (any whitespace is collapsed; leading/trailing spaces are kept).
  function translate(s) {
    if (!s || !CYR.test(s)) return s;
    var lead = (s.match(/^\s*/) || [""])[0];
    var tail = (s.match(/\s*$/) || [""])[0];
    var core = s.slice(lead.length, s.length - tail.length).replace(/\s+/g, " ");
    var hit = phraseCache.get(core);
    if (hit === undefined) {
      hit = phrases[core];
      if (hit === undefined) hit = translateCore(core);
      hit = hit.replace(/[«»]/g, '"');
      phraseCache.set(core, hit);
    }
    return lead + hit + tail;
  }

  // Multi-line strings (alert/confirm/file contents): line by line, whole-message as a fallback.
  function translateText(s) {
    s = String(s == null ? "" : s);
    if (lang !== "en" || !CYR.test(s)) return s;
    if (s.indexOf("\n") === -1) return translate(s);
    var perLine = s.split("\n").map(translate).join("\n");
    if (!CYR.test(perLine)) return perLine;
    var whole = translate(s);
    return CYR.test(whole) ? perLine : whole;
  }

  // ---------------------------------------------------------------- DOM
  var textRecs = new WeakMap();   // Text node -> { ru, en, shown }
  var attrRecs = new WeakMap();   // Element -> { attr: { ru, en, shown } }

  function targetOf(rec) {
    if (lang === "en") {
      if (rec.en === null) rec.en = translate(rec.ru);
      return rec.en;
    }
    return rec.ru;
  }

  // Names typed by the user (saved chains list) are data, not interface: leave them alone.
  function isUserData(el) {
    if (el.closest && el.closest("[data-i18n-ui]")) return false;   // подпись-заглушка в списке: это интерфейс
    return !!(el.closest && el.closest("#savedChainsSelect, [data-no-i18n]"));
  }

  function syncText(node) {
    var parent = node.parentNode;
    if (parent && (SKIP_TAGS[parent.nodeName] || isUserData(parent))) return;
    var cur = node.data;
    var rec = textRecs.get(node);
    if (rec && cur === rec.shown) {
      var want = targetOf(rec);
      if (cur !== want) { node.data = want; rec.shown = want; }
      return;
    }
    if (!CYR.test(cur)) { if (rec) textRecs.delete(node); return; }
    rec = { ru: cur, en: null, shown: cur };
    var target = targetOf(rec);
    if (target !== cur) node.data = target;
    rec.shown = target;
    textRecs.set(node, rec);
  }

  function syncAttr(el, attr) {
    var cur = el.getAttribute(attr);
    if (cur === null) return;
    var map = attrRecs.get(el);
    var rec = map && map[attr];
    if (rec && cur === rec.shown) {
      var want = targetOf(rec);
      if (cur !== want) { el.setAttribute(attr, want); rec.shown = want; }
      return;
    }
    if (!CYR.test(cur)) { if (rec) delete map[attr]; return; }
    rec = { ru: cur, en: null, shown: cur };
    var target = targetOf(rec);
    if (target !== cur) el.setAttribute(attr, target);
    rec.shown = target;
    if (!map) { map = {}; attrRecs.set(el, map); }
    map[attr] = rec;
  }

  function isButtonInput(el) {
    return el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type || "");
  }

  function syncElementAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      if (el.hasAttribute(ATTRS[i])) syncAttr(el, ATTRS[i]);
    }
    if (isButtonInput(el) && el.hasAttribute("value")) {
      syncAttr(el, "value");
    }
  }

  function syncTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { syncText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      syncElementAttrs(root);
    }
    var walker = document.createTreeWalker(root, 1 | 4, null);
    var n = walker.nextNode();
    while (n) {
      if (n.nodeType === 3) syncText(n);
      else syncElementAttrs(n);
      n = walker.nextNode();
    }
  }

  var observer = null;
  function onMutations(records) {
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === "characterData") syncText(r.target);
      else if (r.type === "attributes") {
        // "value" is data on most elements; only button-like inputs carry a label there
        if (r.attributeName === "value" && !isButtonInput(r.target)) continue;
        syncAttr(r.target, r.attributeName);
      }
      else if (r.type === "childList") {
        for (var j = 0; j < r.addedNodes.length; j++) syncTree(r.addedNodes[j]);
      }
    }
  }

  var refreshTimer = 0;
  function refreshAll() {
    refreshTimer = 0;
    syncTree(document.documentElement);
  }
  function scheduleRefresh() {
    if (!refreshTimer) refreshTimer = setTimeout(refreshAll, 0);
  }

  function updateSwitch() {
    var box = document.getElementById("langSwitch");
    if (!box) return;
    var btns = box.querySelectorAll("button[data-lang]");
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute("data-lang") === lang;
      btns[i].classList.toggle("active", on);
      btns[i].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  function setLang(next) {
    if (next !== "ru" && next !== "en") return;
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch (e) { /* ignore */ }
    if (next === lang) { updateSwitch(); return; }
    lang = next;
    document.documentElement.lang = lang;
    updateSwitch();
    refreshAll();
    try { window.dispatchEvent(new CustomEvent("langchange", { detail: { lang: lang } })); } catch (e) { /* ignore */ }
  }

  function buildSwitch() {
    if (document.getElementById("langSwitch")) return;
    var box = document.createElement("div");
    box.id = "langSwitch";
    box.className = "langSwitch";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Language");
    [["en", "EN", "English"], ["ru", "RU", "Русский"]].forEach(function (l) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("data-lang", l[0]);
      b.textContent = l[1];
      b.title = l[2];
      b.addEventListener("click", function () { setLang(l[0]); });
      box.appendChild(b);
    });
    var controls = document.getElementById("topControls");
    if (!controls) {
      controls = document.createElement("div");
      controls.id = "topControls";
      controls.className = "topControls";
      document.body.appendChild(controls);
    }
    controls.appendChild(box);
    updateSwitch();
  }

  function wrapDialogs() {
    ["alert", "confirm", "prompt"].forEach(function (name) {
      var orig = window[name];
      if (typeof orig !== "function") return;
      window[name] = function (message) {
        var args = Array.prototype.slice.call(arguments);
        args[0] = translateText(message);
        if (name === "prompt" && args.length > 1 && typeof args[1] === "string") args[1] = translateText(args[1]);
        return orig.apply(window, args);
      };
    });
  }

  function init() {
    document.documentElement.lang = lang;
    buildTrie();
    buildSwitch();
    wrapDialogs();
    syncTree(document.documentElement);
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS.concat(["value"]),
    });
  }

  window.i18n = {
    lang: function () { return lang; },
    setLang: setLang,
    t: translateText,
    locale: function () { return lang === "en" ? "en-US" : "ru-RU"; },
    registerDataset: registerDataset,
  };

  // The script sits at the end of <body>, so the markup is already there: translate before the
  // first paint instead of flashing Russian first.
  if (document.body) init();
  else document.addEventListener("DOMContentLoaded", init);
})();
