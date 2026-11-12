// The windows' own title bar outside macOS. Windows (and Linux) would put the app menu in a white strip of the
// system's under the window's title; there the shell's windows have no frame of the system's instead: the system draws
// only its minimise, maximise and close buttons (Electron's titleBarOverlay, which keeps the snap layouts of Windows 11
// and the system's own look of those three), and the page draws the rest of the bar: the logo, the menus, the room to
// drag the window by (legacy-window/title-bar.js).
//
// The menu stays the application menu of menu.mjs: it is still set, so its accelerators work as before, and the page's
// menus are drawn from it as it is now (describeMenu), its items run as the menu's own clicks (runMenuItem). The two
// cannot drift: there is one menu, the page only shows it. macOS keeps its own menu bar and window frame.

/** The bar's height, px: the system's three buttons are as tall. The page's bar reads it from env(titlebar-area-height). */
export const TITLE_BAR_HEIGHT = 36;

/** True where the windows get the shell's own title bar. */
export const usesTitleBar = (platform) => platform === "win32" || platform === "linux";

/**
 * The colors of the system's three buttons, as the page's bar under them: the device window is dark, as the bar's
 * local web; the message page follows the system's light or dark.
 */
export const OVERLAY_COLORS = Object.freeze({
  dark: Object.freeze({ color: "#0a0a0a", symbolColor: "#e5e5e5" }),
  // The message page's own colors (Chromium's Canvas and CanvasText).
  "system-dark": Object.freeze({ color: "#121212", symbolColor: "#ffffff" }),
  "system-light": Object.freeze({ color: "#ffffff", symbolColor: "#000000" }),
});

/**
 * What a window's options need for the bar: nothing on macOS; elsewhere no frame of the system's but its three
 * buttons, in the colors named.
 * @param {string} platform
 * @param {keyof typeof OVERLAY_COLORS} colors
 */
export function titleBarOptions(platform, colors) {
  if (!usesTitleBar(platform)) return {};
  return { titleBarStyle: "hidden", titleBarOverlay: { ...OVERLAY_COLORS[colors], height: TITLE_BAR_HEIGHT } };
}

/** An accelerator as the menu of the system shows it: Ctrl+N on Windows for CmdOrCtrl+N. */
export function shownAccelerator(accelerator, platform) {
  if (typeof accelerator !== "string" || accelerator === "") return null;
  const mac = platform === "darwin";
  const names = { CommandOrControl: mac ? "Cmd" : "Ctrl", CmdOrCtrl: mac ? "Cmd" : "Ctrl", Command: "Cmd", Cmd: "Cmd", Control: "Ctrl", Ctrl: "Ctrl", Option: "Alt", AltGr: "AltGr", Super: "Win", Meta: "Win", Return: "Enter", Esc: "Esc", Plus: "+" };
  return accelerator
    .split("+")
    .map((part) => names[part] ?? (part.length === 1 || /^f\d{1,2}$/i.test(part) ? part.toUpperCase() : part))
    .join("+");
}

/** A label without the system's mnemonic marks ("E&xit" is "Exit"), and the letter they mark, or its first letter. */
export function labelOf(text) {
  const raw = String(text ?? "");
  let label = "";
  let mnemonic = null;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "&" && i + 1 < raw.length) {
      i += 1;
      if (raw[i] !== "&" && mnemonic === null) mnemonic = label.length;
    }
    label += raw[i];
  }
  if (mnemonic === null) mnemonic = label.search(/[A-Za-z0-9]/);
  return { label, mnemonic: mnemonic >= 0 && mnemonic < label.length ? mnemonic : null };
}

/** The id an item goes by in the page: its own, or its role's. Items with neither are not shown. */
const idOf = (item) => (typeof item.id === "string" && item.id !== "" && !/^\d+$/.test(item.id) ? item.id : item.role ? `role:${item.role}` : null);

/** The items of a menu the page shows: the visible ones, separators folded so that none leads, trails or repeats. */
function shownItems(items, platform) {
  const out = [];
  for (const item of items ?? []) {
    if (item.visible === false) continue;
    if (item.type === "separator") {
      if (out.length && out.at(-1).type !== "separator") out.push({ type: "separator" });
      continue;
    }
    const id = idOf(item);
    // A submenu inside a menu the bar does not have; nor does menu.mjs make one.
    if (!id || item.type === "submenu") continue;
    const { label, mnemonic } = labelOf(item.label);
    const ticks = item.type === "checkbox" || item.type === "radio";
    const accelerator = item.accelerator ?? (typeof item.getDefaultRoleAccelerator === "function" ? item.getDefaultRoleAccelerator() : null);
    out.push({ id, type: ticks ? item.type : "normal", label, mnemonic, enabled: item.enabled !== false, checked: ticks ? Boolean(item.checked) : false, keys: shownAccelerator(accelerator, platform) });
  }
  while (out.at(-1)?.type === "separator") out.pop();
  return out;
}

/**
 * The menus of the application menu as the page draws them: [{ label, mnemonic, items: [{ id, type, label, mnemonic,
 * enabled, checked, keys } | { type: "separator" }] }]. `keys` is the accelerator as the system shows it, or null;
 * `mnemonic` the index of the letter Alt goes with.
 * @param {{ items: object[] } | null} menu  Electron's Menu (Menu.getApplicationMenu())
 * @param {string} platform
 */
export function describeMenu(menu, platform) {
  if (!menu) return [];
  return menu.items
    .filter((top) => top.visible !== false && top.submenu)
    .map((top) => ({ ...labelOf(top.label), items: shownItems(top.submenu.items, platform) }))
    .filter((top) => top.items.length > 0);
}

/**
 * Runs the item the page names, as a click in the menu would: the menu's own click, with a checkbox switched by it and
 * a role's item doing its role. Only an item the page was shown and may press: visible, enabled, in a menu of the bar.
 * @returns {{ ok: true, value: null } | { ok: false, error: { code: string, message: string, hint: null } }}
 */
export function runMenuItem(menu, id, { window = undefined, contents = undefined } = {}) {
  const refused = (message) => ({ ok: false, error: { code: "no_item", message, hint: null } });
  if (!menu || typeof id !== "string") return refused("There is no such item in the menu.");
  for (const top of menu.items) {
    if (top.visible === false || !top.submenu) continue;
    for (const item of top.submenu.items) {
      if (item.visible === false || item.type === "separator" || item.type === "submenu" || idOf(item) !== id) continue;
      if (item.enabled === false) return refused("That item of the menu is off now.");
      item.click(undefined, window, contents);
      return { ok: true, value: null };
    }
  }
  return refused("There is no such item in the menu.");
}
