// Colour theme: light / dark.
//
// The theme is a `data-theme` attribute on <html>; style.css redefines its colour variables for
// "dark". Choice: saved choice > the system setting (prefers-color-scheme). The attribute is set
// right here, while the page is still loading (this file is loaded in <head>), so there is no flash
// of the wrong theme. The toggle button is added next to the language switch.
//
//   window.theme.get()        "light" | "dark"
//   window.theme.set(name)    switch + remember the choice
(function () {
  "use strict";

  var STORAGE_KEY = "chaincalc.theme";
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function saved() {
    try {
      var value = window.localStorage.getItem(STORAGE_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch (e) { return null; }
  }

  function system() {
    return media && media.matches ? "dark" : "light";
  }

  function apply(name) {
    root.setAttribute("data-theme", name);
    var button = document.getElementById("themeToggle");
    if (button) {
      var dark = name === "dark";
      button.textContent = dark ? "☀" : "☾";          // sun when dark (go light), moon when light
      var label = dark ? "Светлая тема" : "Тёмная тема";
      button.setAttribute("title", label);
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", dark ? "true" : "false");
    }
  }

  function get() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function set(name) {
    if (name !== "light" && name !== "dark") return;
    try { window.localStorage.setItem(STORAGE_KEY, name); } catch (e) { /* storage may be blocked */ }
    apply(name);
  }

  apply(saved() || system());

  // follow the system while the visitor has not chosen by hand
  if (media && media.addEventListener) {
    media.addEventListener("change", function () { if (!saved()) apply(system()); });
  }

  function addButton() {
    if (document.getElementById("themeToggle")) return;
    var box = document.getElementById("topControls");
    if (!box) {
      box = document.createElement("div");
      box.id = "topControls";
      box.className = "topControls";
      document.body.appendChild(box);
    }
    var button = document.createElement("button");
    button.type = "button";
    button.id = "themeToggle";
    button.className = "themeToggle";
    button.addEventListener("click", function () { set(get() === "dark" ? "light" : "dark"); });
    box.insertBefore(button, box.firstChild);
    apply(get());
  }

  window.theme = { get: get, set: set };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addButton);
  else addButton();
})();
