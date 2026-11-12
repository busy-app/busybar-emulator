// The window's own title bar, outside macOS (packages/app/src/title-bar.mjs): the app's logo, the app menu's menus,
// room to drag the window by; the system draws its minimise, maximise and close buttons on the right, over the page.
// macOS has the system's menu bar and frame, and a plain browser has no app menu: there this file does nothing.
//
// The menus are the application menu's own, read from the shell each time one opens (the bridge's "menu.get"), so
// that what is ticked or off is what it is now; an item is run by the shell as the system's menu would run it
// ("menu.run", which needs the person's click or key just before, as every action with consequences). Keys as in the
// system's menus: Alt (or F10) goes to the bar and back, Alt and a menu's letter opens it, the arrows move, Enter or
// Space presses, Esc closes. The menu's accelerators (Ctrl+N, …) are the shell's own and work without this file.
//
// It is loaded first in the body, before the window's other scripts, so that the bar is there at the first paint.
(() => {
  const shell = window.busyShell && typeof window.busyShell.action === "function" ? window.busyShell : null;
  if (!shell) return;
  const SPRITE = "/emulator/icons/busy-sprite.svg";

  let bar = null; // the <header>, once the window is known to have no frame of the system's
  let tops = null; // the menus' buttons' box
  let dropdown = null;
  let menus = []; // describeMenu() of title-bar.mjs
  let open = -1; // the menu that is open
  let keys = false; // the bar was reached by the keyboard: the letters are underlined, the focus is in the bar
  let before = null; // what had the focus before the keyboard came to the bar
  let altAlone = false; // Alt is down and nothing else happened since

  const ask = async (name, arg) => {
    try {
      return await (arg === undefined ? shell.action(name) : shell.action(name, arg));
    } catch {
      return null;
    }
  };

  /** A label with its letter for Alt marked, to be underlined while the keyboard is in the bar. */
  function labelled(element, label, mnemonic) {
    element.textContent = "";
    if (mnemonic === null || mnemonic === undefined) {
      element.textContent = label;
      return;
    }
    const letter = document.createElement("span");
    letter.className = "tb-mn";
    letter.textContent = label[mnemonic];
    element.append(label.slice(0, mnemonic), letter, label.slice(mnemonic + 1));
  }

  function build() {
    if (bar) return;
    document.documentElement.classList.add("has-title-bar");
    bar = document.createElement("header");
    bar.className = "title-bar";
    bar.id = "title-bar";
    const logo = document.createElement("img");
    logo.className = "tb-logo";
    logo.src = "/emulator/icons/emulator-logo.svg";
    logo.alt = "";
    logo.width = 16;
    logo.height = 16;
    logo.draggable = false;
    tops = document.createElement("div");
    tops.className = "tb-menus";
    tops.setAttribute("role", "menubar");
    tops.setAttribute("aria-label", "Menu");
    const title = document.createElement("span");
    title.className = "tb-title";
    title.textContent = document.title || "BUSY Bar Emulator";
    bar.append(logo, tops, title);
    dropdown = document.createElement("div");
    dropdown.className = "tb-dropdown";
    dropdown.id = "title-bar-menu";
    dropdown.setAttribute("role", "menu");
    dropdown.hidden = true;
    document.body.prepend(bar, dropdown);
    renderTops();
  }

  function renderTops() {
    if (!tops) return;
    tops.textContent = "";
    menus.forEach((menu, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tb-top";
      button.tabIndex = -1;
      button.setAttribute("role", "menuitem");
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.dataset.index = String(index);
      labelled(button, menu.label, menu.mnemonic);
      button.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (open === index) close();
        else openMenu(index, { focus: false });
      });
      button.addEventListener("pointerenter", () => open >= 0 && open !== index && openMenu(index, { focus: false }));
      tops.append(button);
    });
  }

  function topButton(index) {
    return tops ? tops.children[index] || null : null;
  }

  function renderDropdown() {
    const menu = menus[open];
    dropdown.textContent = "";
    if (!menu) return;
    for (const item of menu.items) {
      if (item.type === "separator") {
        const line = document.createElement("div");
        line.className = "tb-line";
        line.setAttribute("role", "separator");
        dropdown.append(line);
        continue;
      }
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tb-item";
      row.tabIndex = -1;
      row.dataset.id = item.id;
      const ticks = item.type === "checkbox" || item.type === "radio";
      row.setAttribute("role", ticks ? `menuitem${item.type}` : "menuitem");
      if (ticks) row.setAttribute("aria-checked", String(item.checked));
      if (!item.enabled) row.setAttribute("aria-disabled", "true");
      const mark = document.createElement("span");
      mark.className = "tb-check";
      if (ticks && item.checked) mark.innerHTML = `<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><use href="${SPRITE}#bi-checkmark"/></svg>`;
      const label = document.createElement("span");
      label.className = "tb-label";
      labelled(label, item.label, item.mnemonic);
      const shortcut = document.createElement("span");
      shortcut.className = "tb-keys";
      shortcut.textContent = item.keys || "";
      row.append(mark, label, shortcut);
      row.addEventListener("pointerenter", () => item.enabled && row.focus({ preventScroll: true }));
      row.addEventListener("pointerleave", () => document.activeElement === row && dropdown.focus({ preventScroll: true }));
      row.addEventListener("click", () => press(item));
      dropdown.append(row);
    }
    dropdown.tabIndex = -1;
  }

  function place() {
    const button = topButton(open);
    if (!button) return;
    const box = button.getBoundingClientRect();
    dropdown.style.left = "0px";
    dropdown.style.top = `${Math.round(bar.getBoundingClientRect().bottom + 2)}px`;
    const width = dropdown.offsetWidth;
    dropdown.style.left = `${Math.max(4, Math.min(Math.round(box.left), innerWidth - width - 4))}px`;
  }

  /** Opens menu `index`; focus: "first" or "last" puts the focus on that item, false leaves it with the bar. */
  function openMenu(index, { focus = "first" } = {}) {
    if (!menus[index]) return;
    if (open !== index) close({ restore: false, keepKeys: true });
    open = index;
    bar.classList.add("open");
    for (const button of tops.children) button.setAttribute("aria-expanded", String(button === topButton(index)));
    topButton(index).classList.add("on");
    renderDropdown();
    dropdown.hidden = false;
    place();
    if (focus) moveFocus(focus === "last" ? -1 : 1, true);
    else if (keys) topButton(index).focus({ preventScroll: true });
    // What is ticked or off now: the menu as the shell has it at this moment.
    void load().then(() => {
      if (open !== index) return;
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
      renderDropdown();
      place();
      const again = focused && dropdown.querySelector(`[data-id="${CSS.escape(focused)}"]`);
      if (again) again.focus({ preventScroll: true });
    });
  }

  function enabledItems() {
    return [...dropdown.querySelectorAll(".tb-item:not([aria-disabled='true'])")];
  }

  /** The focus to the next (1) or the previous (-1) item that can be pressed; from the end when `fromEdge`. */
  function moveFocus(step, fromEdge = false) {
    const items = enabledItems();
    if (!items.length) {
      dropdown.focus({ preventScroll: true });
      return;
    }
    const at = items.indexOf(document.activeElement);
    const next = fromEdge || at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  function enterKeys() {
    if (!bar) return;
    if (!keys) before = document.activeElement;
    keys = true;
    bar.classList.add("keys");
    dropdown.classList.add("keys");
    if (open < 0) topButton(0)?.focus({ preventScroll: true });
  }

  /** Closes the open menu; with the keyboard gone too unless keepKeys, the focus back where it was when `restore`. */
  function close({ restore = true, keepKeys = false } = {}) {
    if (!bar) return;
    if (open >= 0) {
      topButton(open)?.classList.remove("on");
      for (const button of tops.children) button.setAttribute("aria-expanded", "false");
      open = -1;
      dropdown.hidden = true;
      dropdown.textContent = "";
      bar.classList.remove("open");
    }
    if (keepKeys) return;
    if (keys) {
      keys = false;
      bar.classList.remove("keys");
      dropdown.classList.remove("keys");
      const back = before;
      before = null;
      if (restore && back && back.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
      // The page itself had the focus (the body takes none), or the element is gone: the bar lets it go.
      if (bar.contains(document.activeElement) || dropdown.contains(document.activeElement)) document.activeElement.blur();
    }
  }

  function press(item) {
    if (!item || !item.enabled) return;
    close();
    void ask("menu.run", item.id).then((answer) => {
      if (answer && !answer.ok) console.error(`The menu's ${item.label}: ${(answer.error && answer.error.message) || "not done"}`);
    });
  }

  const letterOf = (e) => (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : (e.key || "").toLowerCase());
  const mnemonicOf = (entry) => (entry.mnemonic === null || entry.mnemonic === undefined ? "" : entry.label[entry.mnemonic].toLowerCase());

  function onKeyDown(e) {
    if (!bar || !menus.length) return;
    if (e.key === "Alt") {
      altAlone = !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey ? true : altAlone && e.repeat;
      return;
    }
    altAlone = false;
    const swallow = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Alt and a menu's letter: that menu, from anywhere in the window.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const index = menus.findIndex((menu) => mnemonicOf(menu) === letterOf(e));
      if (index >= 0) {
        swallow();
        enterKeys();
        openMenu(index, { focus: "first" });
      }
      return;
    }
    if (e.key === "F10" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      swallow();
      if (keys || open >= 0) close();
      else enterKeys();
      return;
    }
    if (open < 0 && !keys) return;
    // The bar has the keyboard: no key goes on to the bar's buttons or the page.
    if (e.ctrlKey || e.metaKey) return close({ restore: true });
    swallow();
    if (e.repeat && (e.key === "Enter" || e.key === " ")) return;
    const focusedTop = tops.contains(document.activeElement) ? Number(document.activeElement.dataset.index) : -1;
    const current = open >= 0 ? open : focusedTop >= 0 ? focusedTop : 0;
    const step = (by) => (current + by + menus.length) % menus.length;
    switch (e.key) {
      case "Escape":
        if (open >= 0 && keys) {
          const index = open;
          close({ restore: false, keepKeys: true });
          topButton(index)?.focus({ preventScroll: true });
        } else close();
        return;
      case "Tab":
        return close();
      case "ArrowLeft":
      case "ArrowRight": {
        const next = step(e.key === "ArrowRight" ? 1 : -1);
        if (open >= 0) openMenu(next, { focus: "first" });
        else topButton(next)?.focus({ preventScroll: true });
        return;
      }
      case "ArrowDown":
      case "ArrowUp":
        if (open < 0) return openMenu(current, { focus: e.key === "ArrowUp" ? "last" : "first" });
        return moveFocus(e.key === "ArrowDown" ? 1 : -1);
      case "Home":
      case "End":
        if (open >= 0) moveFocus(e.key === "Home" ? 1 : -1, true);
        return;
      case "Enter":
      case " ": {
        if (open < 0) return openMenu(current, { focus: "first" });
        const id = document.activeElement && dropdown.contains(document.activeElement) ? document.activeElement.dataset.id : null;
        const item = id ? menus[open].items.find((one) => one.id === id) : null;
        return item ? press(item) : undefined;
      }
      default: {
        const letter = letterOf(e);
        if (open < 0) {
          const index = menus.findIndex((menu) => mnemonicOf(menu) === letter);
          if (index >= 0) openMenu(index, { focus: "first" });
          return;
        }
        const item = menus[open].items.find((one) => one.type !== "separator" && one.enabled && mnemonicOf(one) === letter);
        if (item) press(item);
      }
    }
  }

  function onKeyUp(e) {
    if (e.key !== "Alt") return;
    if (!altAlone || !bar || !menus.length) return;
    altAlone = false;
    e.preventDefault();
    if (keys || open >= 0) close();
    else enterKeys();
  }

  async function load() {
    const answer = await ask("menu.get");
    if (!answer || !answer.ok || !answer.value) return false;
    if (!answer.value.titleBar) return false;
    const fresh = Array.isArray(answer.value.menus) ? answer.value.menus : [];
    const same = JSON.stringify(fresh.map((menu) => [menu.label, menu.mnemonic])) === JSON.stringify(menus.map((menu) => [menu.label, menu.mnemonic]));
    menus = fresh;
    build();
    if (!same) renderTops();
    return true;
  }

  // A window without the system's frame is one with the system's three buttons over the page: the bar is drawn at
  // once, before the first paint; the menus come from the shell a moment later.
  if (navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible) build();
  void load();

  addEventListener("keydown", onKeyDown, true);
  addEventListener("keyup", onKeyUp, true);
  addEventListener(
    "pointerdown",
    (e) => {
      altAlone = false;
      if (!bar || (open < 0 && !keys)) return;
      if (dropdown.contains(e.target) || tops.contains(e.target)) return;
      close({ restore: false });
    },
    true,
  );
  addEventListener("blur", () => {
    altAlone = false;
    close({ restore: false });
  });
  addEventListener("resize", () => close({ restore: false }));
})();
