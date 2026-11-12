// The window's own title bar outside macOS (title-bar.mjs): its menus are the application menu's, drawn from the same
// template (menu.mjs) with the same items, states and keys, and an item runs as the menu's own click. A stand-in for
// Electron's Menu here; test/app/title-bar.test.mjs holds the real one to the same.
import assert from "node:assert/strict";
import { test } from "node:test";

import { menuTemplate } from "../../src/menu.mjs";
import { describeMenu, labelOf, OVERLAY_COLORS, runMenuItem, shownAccelerator, TITLE_BAR_HEIGHT, titleBarOptions, usesTitleBar } from "../../src/title-bar.mjs";

/** What Electron's Menu.buildFromTemplate makes of a template, as far as the bar reads it: role items get the role's label. */
function buildMenu(template, platform, clicks) {
  const roleLabel = (role) => ({ quit: platform === "win32" ? "Exit" : "Quit BUSY Bar Emulator", about: "About BUSY Bar Emulator" })[role] ?? role;
  const item = (one) => {
    const made = {
      id: one.id,
      role: one.role,
      label: one.label ?? roleLabel(one.role),
      type: one.type ?? (one.submenu ? "submenu" : "normal"),
      enabled: one.enabled ?? true,
      visible: one.visible ?? true,
      checked: one.checked ?? false,
      accelerator: one.accelerator,
      submenu: Array.isArray(one.submenu) ? { items: one.submenu.map(item) } : null,
    };
    // Electron's MenuItem.click: a checkbox switches, then its click (or its role) runs.
    made.click = () => {
      if (made.type === "checkbox") made.checked = !made.checked;
      if (one.role) clicks.push(`role ${one.role}`);
      else one.click?.(made);
    };
    return made;
  };
  return { items: template.map(item) };
}

function setup(platform = "win32", updateCheck = { allowed: true, enabled: true }) {
  const clicks = [];
  const template = menuTemplate({
    platform,
    appName: "BUSY Bar Emulator",
    updateCheck,
    onAppSettings: () => clicks.push("settings"),
    onUpdateCheck: (on) => clicks.push(`updates ${on}`),
    onNewApp: () => clicks.push("new app"),
    onOpenApp: () => clicks.push("open app"),
    onReportBug: () => clicks.push("report bug"),
    onOpenDocs: (url) => clicks.push(`docs ${url}`),
  });
  const menu = buildMenu(template, platform, clicks);
  return { template, menu, clicks };
}

test("the bar's menus are the template's, item for item, with their states and the keys as Windows shows them", () => {
  const { menu } = setup("win32");
  assert.deepEqual(describeMenu(menu, "win32"), [
    {
      label: "File",
      mnemonic: 0,
      items: [
        { id: "new-app", type: "normal", label: "New App…", mnemonic: 0, enabled: true, checked: false, keys: "Ctrl+N" },
        { id: "open-app", type: "normal", label: "Open App Folder…", mnemonic: 0, enabled: true, checked: false, keys: "Ctrl+O" },
      ],
    },
    {
      label: "BUSY Bar",
      mnemonic: 0,
      items: [
        { id: "app-settings", type: "normal", label: "App Settings", mnemonic: 0, enabled: true, checked: false, keys: "Ctrl+," },
        { type: "separator" },
        { id: "role:quit", type: "normal", label: "Exit", mnemonic: 0, enabled: true, checked: false, keys: null },
      ],
    },
    {
      label: "Options",
      mnemonic: 0,
      items: [{ id: "update-check", type: "checkbox", label: "Check for New Versions at Start", mnemonic: 0, enabled: true, checked: true, keys: null }],
    },
    {
      label: "Help",
      mnemonic: 0,
      items: [
        { id: "report-bug", type: "normal", label: "Report a Bug…", mnemonic: 0, enabled: true, checked: false, keys: null },
        { id: "emulator-docs", type: "normal", label: "Emulator Docs", mnemonic: 0, enabled: true, checked: false, keys: null },
        { id: "js-apps-docs", type: "normal", label: "JS Apps Docs", mnemonic: 0, enabled: true, checked: false, keys: null },
      ],
    },
  ]);
});

test("every item of the template is in the bar, and nothing else: the two cannot drift", () => {
  const { template, menu } = setup("win32");
  const fromTemplate = template.map((top) => [top.label, top.submenu.filter((one) => one.type !== "separator").map((one) => one.id ?? `role:${one.role}`)]);
  const fromBar = describeMenu(menu, "win32").map((top) => [top.label, top.items.filter((one) => one.type !== "separator").map((one) => one.id)]);
  assert.deepEqual(fromBar, fromTemplate);
});

test("what is ticked or off is what the menu has now: the switch in a build that never checks, or after a click", () => {
  const never = describeMenu(setup("win32", { allowed: false, enabled: true }).menu, "win32").find((top) => top.label === "Options").items[0];
  assert.deepEqual([never.checked, never.enabled], [false, false]);
  const { menu, clicks } = setup("win32");
  assert.deepEqual(runMenuItem(menu, "update-check"), { ok: true, value: null });
  assert.deepEqual(clicks, ["updates false"]);
  assert.equal(describeMenu(menu, "win32").find((top) => top.label === "Options").items[0].checked, false);
});

test("an item runs as the menu's own click: New App, Open App Folder, App Settings, Report a Bug, and Exit by its role", () => {
  const { menu, clicks } = setup("win32");
  for (const id of ["new-app", "open-app", "app-settings", "report-bug", "emulator-docs", "js-apps-docs", "role:quit"]) assert.deepEqual(runMenuItem(menu, id), { ok: true, value: null }, id);
  assert.deepEqual(clicks, ["new app", "open app", "settings", "report bug", "docs https://go.busy.app/busy-emulator-docs", "docs https://go.busy.app/js-apps", "role quit"]);
});

test("the page may not run what it was not shown: no such id, an item that is off or hidden, a menu's own title, not a string", () => {
  const { menu, clicks } = setup("win32", { allowed: false, enabled: false });
  menu.items[0].submenu.items[1].visible = false;
  for (const id of ["update-check", "open-app", "File", "nothing", "role:about", 3, null, undefined, { id: "new-app" }]) {
    const answer = runMenuItem(menu, id);
    assert.equal(answer.ok, false, String(id));
    assert.equal(answer.error.code, "no_item", String(id));
  }
  assert.deepEqual(clicks, []);
  assert.equal(runMenuItem(null, "new-app").ok, false);
  // A hidden item is not drawn either.
  assert.ok(!describeMenu(menu, "win32")[0].items.some((one) => one.id === "open-app"));
});

test("separators: none leads, trails or comes twice once hidden items are left out", () => {
  const menu = {
    items: [
      {
        label: "&Edit",
        submenu: {
          items: [
            { type: "separator" },
            { id: "a", label: "&Undo", type: "normal", accelerator: "CommandOrControl+Z" },
            { type: "separator" },
            { id: "b", label: "Hidden", type: "normal", visible: false },
            { type: "separator" },
            { id: "c", label: "Save && Close", type: "normal" },
            { type: "separator" },
          ],
        },
      },
      { label: "Empty", submenu: { items: [{ type: "separator" }] } },
      { label: "Gone", visible: false, submenu: { items: [{ id: "d", label: "D" }] } },
    ],
  };
  const [edit, ...rest] = describeMenu(menu, "win32");
  assert.deepEqual(rest, []);
  assert.deepEqual([edit.label, edit.mnemonic], ["Edit", 0]);
  assert.deepEqual(edit.items.map((one) => one.type === "separator" ? "-" : `${one.label} ${one.keys}`), ["Undo Ctrl+Z", "-", "Save & Close null"]);
});

test("labels lose the system's & marks and keep the letter they mark; accelerators read as the system shows them", () => {
  assert.deepEqual(labelOf("E&xit"), { label: "Exit", mnemonic: 1 });
  assert.deepEqual(labelOf("Tom && Jerry"), { label: "Tom & Jerry", mnemonic: 0 });
  assert.deepEqual(labelOf("…"), { label: "…", mnemonic: null });
  assert.equal(shownAccelerator("CmdOrCtrl+Shift+N", "win32"), "Ctrl+Shift+N");
  assert.equal(shownAccelerator("CmdOrCtrl+,", "win32"), "Ctrl+,");
  assert.equal(shownAccelerator("Alt+f4", "win32"), "Alt+F4");
  assert.equal(shownAccelerator("CmdOrCtrl+N", "darwin"), "Cmd+N");
  assert.equal(shownAccelerator(undefined, "win32"), null);
});

test("Windows and Linux get the bar, macOS keeps the system's frame and menu bar", () => {
  assert.deepEqual(["win32", "linux", "darwin"].map(usesTitleBar), [true, true, false]);
  assert.deepEqual(titleBarOptions("darwin", "dark"), {});
  assert.deepEqual(titleBarOptions("win32", "dark"), { titleBarStyle: "hidden", titleBarOverlay: { color: "#0a0a0a", symbolColor: "#e5e5e5", height: TITLE_BAR_HEIGHT } });
  assert.equal(titleBarOptions("win32", "system-light").titleBarOverlay.color, OVERLAY_COLORS["system-light"].color);
});
