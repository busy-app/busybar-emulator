// The app's menu: App Settings, the switch of the update check, and File with New App and Open App Folder, on both
// systems.
import assert from "node:assert/strict";
import { test } from "node:test";

import { menuTemplate } from "../../src/menu.mjs";

const flat = (items) => items.flatMap((item) => [item, ...flat(item.submenu ?? [])]);

function menu(platform, updateCheck = { allowed: true, enabled: true }) {
  const calls = [];
  const template = menuTemplate({ platform, appName: "BUSY Bar Emulator", updateCheck, onAppSettings: () => calls.push("settings"), onUpdateCheck: (on) => calls.push(`updates ${on}`), onNewApp: () => calls.push("new app"), onOpenApp: () => calls.push("open app"), onReportBug: () => calls.push("report bug"), onOpenDocs: (url) => calls.push(`docs ${url}`) });
  return { template, calls, byId: (id) => flat(template).find((item) => item.id === id) };
}

test("both systems have App Settings and the switch of the update check, and they do what they say", () => {
  for (const platform of ["darwin", "win32"]) {
    const { calls, byId } = menu(platform);
    assert.equal(byId("app-settings").label, "App Settings", platform);
    byId("app-settings").click();
    const updates = byId("update-check");
    assert.equal(updates.type, "checkbox", platform);
    assert.equal(updates.checked, true, platform);
    assert.equal(updates.enabled, true, platform);
    updates.click({ checked: false });
    updates.click({ checked: true });
    assert.deepEqual(calls, ["settings", "updates false", "updates true"], platform);
  }
});

test("both systems have File with New App and Open App Folder, which call what the window's buttons call", () => {
  for (const platform of ["darwin", "win32"]) {
    const { template, calls, byId } = menu(platform);
    const file = template.find((item) => item.label === "File");
    assert.deepEqual(file.submenu.map((item) => [item.id, item.label, item.accelerator]), [["new-app", "New App…", "CmdOrCtrl+N"], ["open-app", "Open App Folder…", "CmdOrCtrl+O"]], platform);
    byId("new-app").click();
    byId("open-app").click();
    assert.deepEqual(calls, ["new app", "open app"], platform);
  }
  // Without the two callbacks (an older caller) the items do nothing and do not throw.
  const bare = menuTemplate({ platform: "darwin", appName: "X", updateCheck: { allowed: true, enabled: true }, onAppSettings: () => {}, onUpdateCheck: () => {} });
  flat(bare).find((item) => item.id === "new-app").click();
});

test("the switch shows what is: off when the person switched it off, off and gray in a build that never checks", () => {
  assert.equal(menu("darwin", { allowed: true, enabled: false }).byId("update-check").checked, false);
  const never = menu("win32", { allowed: false, enabled: true }).byId("update-check");
  assert.equal(never.checked, false);
  assert.equal(never.enabled, false);
});

test("macOS keeps the app's own menu with Quit, the edit menu and the window list; Windows has Quit; both end with Help, which has Report a Bug and the two documentation links", () => {
  const mac = menu("darwin").template;
  assert.equal(mac[0].label, "BUSY Bar Emulator");
  assert.ok(mac[0].submenu.some((item) => item.role === "quit"));
  assert.deepEqual(mac.slice(1).map((item) => item.role ?? item.label), ["File", "editMenu", "BUSY Bar", "windowMenu", "Help"]);
  const windows = menu("win32").template;
  assert.ok(flat(windows).some((item) => item.role === "quit"));
  assert.deepEqual(windows.map((item) => item.label), ["File", "BUSY Bar", "Options", "Help"]);
  for (const platform of ["darwin", "win32"]) {
    const { template, calls, byId } = menu(platform);
    const help = template.at(-1);
    // Not Electron's Help, whose items open addresses in the browser: the one item opens the window's own dialog.
    assert.equal(help.role, undefined, platform);
    assert.deepEqual(help.submenu.map((item) => [item.id, item.label, item.role]), [["report-bug", "Report a Bug…", undefined], ["emulator-docs", "Emulator Docs", undefined], ["js-apps-docs", "JS Apps Docs", undefined]], platform);
    byId("report-bug").click();
    byId("emulator-docs").click();
    byId("js-apps-docs").click();
    assert.deepEqual(calls, ["report bug", "docs https://go.busy.app/busy-emulator-docs", "docs https://go.busy.app/js-apps"], platform);
    assert.ok(!flat(template).some((item) => item.role === "help"), platform);
  }
});
