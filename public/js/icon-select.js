/* Выпадающие списки с иконками.
 *
 * В нативном <select> картинок не бывает, поэтому любой <select>, у чьих <option> есть data-icon, заменяется
 * своим списком: кнопка с выбранным пунктом и меню с иконками. Сам <select> остаётся в странице скрытым —
 * весь остальной код читает select.value и слушает "change", как раньше. Новые списки (карточки результата
 * перерисовываются целиком) подхватывает MutationObserver. */
(function () {
  "use strict";

  const ICON = 18;
  let openBox = null;

  function iconNode(url) {
    const blank = () => Object.assign(document.createElement("span"), { className: "isIcon isNoIcon" });
    if (!url) return blank();
    const img = document.createElement("img");
    img.className = "isIcon";
    img.width = ICON;
    img.height = ICON;
    img.alt = "";
    img.src = url;
    img.addEventListener("error", () => img.replaceWith(blank()));
    return img;
  }

  function closeMenu() {
    if (!openBox) return;
    openBox.classList.remove("open");
    const menu = openBox.querySelector(".isMenu");
    if (menu) menu.style.cssText = "";
    openBox = null;
  }

  function fill(target, option) {
    target.textContent = "";
    target.append(iconNode(option && option.dataset.icon));
    const text = document.createElement("span");
    text.className = "isText";
    text.textContent = option ? option.textContent : "";
    target.append(text);
  }

  function refresh(select, box) {
    const option = select.options[select.selectedIndex] || null;
    fill(box.querySelector(".isBtn"), option);
    const menu = box.querySelector(".isMenu");
    menu.textContent = "";
    Array.from(select.options).forEach((opt, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "isOpt" + (index === select.selectedIndex ? " active" : "");
      row.disabled = opt.disabled;
      fill(row, opt);
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        closeMenu();
        if (select.selectedIndex !== index) {
          select.selectedIndex = index;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        refresh(select, box);
      });
      menu.append(row);
    });
  }

  function placeMenu(box) {
    const btn = box.querySelector(".isBtn");
    const menu = box.querySelector(".isMenu");
    const r = btn.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const height = Math.min(menu.scrollHeight, 320);
    const up = below < height + 8 && r.top > below;
    menu.style.position = "fixed";
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 280)) + "px";
    menu.style.minWidth = r.width + "px";
    menu.style.maxHeight = Math.max(120, Math.min(320, (up ? r.top : below) - 12)) + "px";
    if (up) menu.style.bottom = window.innerHeight - r.top + 2 + "px";
    else menu.style.top = r.bottom + 2 + "px";
  }

  function enhance(select) {
    if (select.dataset.iconSelect || !select.options.length) return;
    if (!Array.from(select.options).some((o) => o.dataset.icon)) return;
    select.dataset.iconSelect = "1";
    const box = document.createElement("span");
    box.className = "iconSelect";
    box.innerHTML = '<button type="button" class="isBtn select"></button><span class="isMenu"></span>';
    select.after(box);
    select.classList.add("isHidden");
    const btn = box.querySelector(".isBtn");
    btn.title = select.title || "";
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (openBox === box) return closeMenu();
      closeMenu();
      refresh(select, box);
      box.classList.add("open");
      openBox = box;
      placeMenu(box);
    });
    refresh(select, box);
    // программная смена значения (select.value = …) и перерисовка пунктов тоже обновляют кнопку
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    Object.defineProperty(select, "value", {
      configurable: true,
      get() {
        return proto.get.call(this);
      },
      set(v) {
        proto.set.call(this, v);
        refresh(select, box);
      },
    });
    new MutationObserver(() => refresh(select, box)).observe(select, { childList: true, subtree: true, characterData: true });
    select.addEventListener("change", () => refresh(select, box));
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches("select")) enhance(root);
    root.querySelectorAll("select").forEach(enhance);
  }

  function start() {
    scan(document.body);
    new MutationObserver((mutations) => {
      for (const m of mutations) m.addedNodes.forEach((node) => node.nodeType === 1 && scan(node));
      document.querySelectorAll("select:not([data-icon-select])").forEach(enhance); // иконки могли появиться позже
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", (e) => e.key === "Escape" && closeMenu());
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);
  }

  window.IconSelect = { scan };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
