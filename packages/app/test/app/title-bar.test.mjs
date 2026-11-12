// The window's own title bar (title-bar.mjs, legacy-window/title-bar.js). On Windows the device window has no frame of
// the system's and no strip of the native menu: the page's bar has the application menu's menus, which open with
// the mouse and with the keys, and run their items as the menu does. On macOS nothing changes: the system's frame and
// menu bar, and no bar in the page.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { PORTS, until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch, VISIBLE } from "./harness.mjs";

const OWN_BAR = process.platform === "win32" || process.platform === "linux";
// The device window's own page, which only the real server serves.
const realOnly = { skip: !HAS_REAL_SERVER && "the server is not beside this package" };

let app;
before(async () => {
  if (!HAS_REAL_SERVER) return;
  // A stand-in address for the update check, where nothing answers: the test variant has the menu's switch on only then.
  app = await launch({ server: "real", welcomed: true, env: { BUSY_EMULATOR_UPDATE_URL: `http://127.0.0.1:${PORTS.other}/latest` } });
  await app.waitWindow("device");
});
after(() => app?.close());

/** Keys sent the way the system sends the person's (a gesture for the shell), to the main window. */
const keys = (strokes) =>
  app.run(async (shell, _electron, list) => {
    const contents = shell.windows.current.win.webContents;
    for (const [keyCode, modifiers = []] of list) {
      contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      if (keyCode.length === 1 && !modifiers.length) contents.sendInputEvent({ type: "char", keyCode, modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }, strokes);

const native = () =>
  app.run((_shell, electron) =>
    electron.Menu.getApplicationMenu()
      .items.filter((top) => top.visible && top.submenu)
      .map((top) => ({ label: top.label.replace(/&/g, ""), items: top.submenu.items.filter((one) => one.visible).map((one) => (one.type === "separator" ? "-" : `${one.label.replace(/&/g, "")}${one.type === "checkbox" ? (one.checked ? " [x]" : " [ ]") : ""}${one.enabled ? "" : " (off)"}`)) })),
  );

/** The open menu of the page's bar as the person sees it, or null. */
const shown = () =>
  app.page(`(() => {
    const menu = document.getElementById("title-bar-menu");
    if (!menu || menu.hidden) return null;
    const top = document.querySelector("#title-bar .tb-top.on");
    return {
      label: top && top.textContent,
      items: [...menu.children].map((one) => one.classList.contains("tb-line") ? "-" : one.querySelector(".tb-label").textContent + (one.getAttribute("role") === "menuitemcheckbox" ? (one.getAttribute("aria-checked") === "true" ? " [x]" : " [ ]") : "") + (one.getAttribute("aria-disabled") === "true" ? " (off)" : "")),
      focused: document.activeElement && document.activeElement.classList.contains("tb-item") ? document.activeElement.querySelector(".tb-label").textContent : null,
    };
  })()`);

test("Windows: the window has no frame or menu strip of the system's; the page's bar has the menu's menus", { ...realOnly, skip: realOnly.skip || (!OWN_BAR && "macOS keeps the system's frame and menu bar") }, async () => {
  const frame = await app.run((shell) => {
    const win = shell.windows.current.win;
    return { menuBar: win.isMenuBarVisible(), window: win.getBounds().height, content: win.getContentBounds().height };
  });
  assert.equal(frame.menuBar, false, "the native menu bar is shown");
  // A pixel of the system's border at most, not a title bar.
  assert.ok(frame.window - frame.content <= 2, `the window has a frame of the system's: ${JSON.stringify(frame)}`);
  await until(() => app.page(`document.querySelectorAll("#title-bar .tb-top").length > 0`), "the bar's menus");
  assert.equal(await app.page(`document.documentElement.classList.contains("has-title-bar")`), true);
  assert.equal(await app.page(`navigator.windowControlsOverlay ? navigator.windowControlsOverlay.visible : "none"`), true);
  const menus = await native();
  assert.deepEqual(await app.page(`[...document.querySelectorAll("#title-bar .tb-top")].map((one) => one.textContent)`), menus.map((menu) => menu.label));
  assert.deepEqual(menus.map((menu) => menu.label), ["File", "BUSY Bar", "Options", "Help"]);
});

test("Windows: a menu opens with a click and shows the native one's items; another click elsewhere closes it", { ...realOnly, skip: realOnly.skip || (!OWN_BAR && "macOS") }, async () => {
  const menus = await native();
  for (const [index, menu] of menus.entries()) {
    await app.click(`#title-bar .tb-top[data-index="${index}"]`);
    await until(async () => (await shown())?.label === menu.label, `the ${menu.label} menu`);
    // The page reads the menu again when it opens: give it that moment.
    await until(async () => JSON.stringify((await shown()).items) === JSON.stringify(menu.items), `the ${menu.label} menu's items`);
    await app.click(".console-card");
    await until(async () => (await shown()) === null, "the menu closed");
  }
  assert.deepEqual(await app.page(`[...document.querySelectorAll("#title-bar-menu .tb-keys")].length`), 0);
  await app.click(`#title-bar .tb-top[data-index="0"]`);
  await until(async () => (await shown())?.label === "File", "File");
  assert.deepEqual(await app.page(`[...document.querySelectorAll("#title-bar-menu .tb-keys")].map((one) => one.textContent)`), ["Ctrl+N", "Ctrl+O"]);
  await keys([["Escape"]]);
  await until(async () => (await shown()) === null, "Esc closed it");
});

test("Windows: the keys: Alt and a letter opens a menu, the arrows move, Esc closes, Enter runs the item as the menu does", { ...realOnly, skip: realOnly.skip || (!OWN_BAR && "macOS") }, async () => {
  const was = await app.run((_shell, electron) => electron.Menu.getApplicationMenu().getMenuItemById("update-check").checked);
  await keys([["O", ["alt"]]]);
  await until(async () => (await shown())?.label === "Options", "Alt+O opened Options");
  assert.equal((await shown()).focused, "Check for New Versions at Start");
  await keys([["Left"]]);
  await until(async () => (await shown())?.label === "BUSY Bar", "Left moved to BUSY Bar");
  assert.equal((await shown()).focused, "App Settings");
  await keys([["Down"]]);
  await until(async () => (await shown())?.focused === "Exit", "Down moved to Exit");
  await keys([["Right"], ["Escape"]]);
  await until(async () => (await shown()) === null, "Esc closed Options");
  // Esc leaves the keyboard on the bar; a second Esc takes it away.
  assert.equal(await app.page(`document.getElementById("title-bar").classList.contains("keys")`), true);
  await keys([["Escape"]]);
  assert.equal(await app.page(`document.getElementById("title-bar").classList.contains("keys")`), false);
  // Alt alone goes to the bar; Down opens the menu there; Enter runs its item: the switch of the update check.
  await keys([["Alt"]]);
  await until(() => app.page(`document.getElementById("title-bar").classList.contains("keys")`), "Alt went to the bar");
  await keys([["Right"], ["Right"], ["Down"]]);
  await until(async () => (await shown())?.label === "Options", "Options from the bar");
  await keys([["Enter"]]);
  await until(() => app.run((_shell, electron, before) => electron.Menu.getApplicationMenu().getMenuItemById("update-check").checked !== before, was), "the switch switched by the bar");
  assert.equal(await app.run((shell) => shell.updates.enabled()), !was);
  await keys([["O", ["alt"]]]);
  await until(async () => (await shown())?.items[0] === `Check for New Versions at Start ${!was ? "[x]" : "[ ]"}`, "the menu shows the switch as it is now");
  await keys([["Enter"]]);
  await until(() => app.run((shell, _electron, before) => shell.updates.enabled() === before, was), "switched back");
});

test("Windows: an item clicked in the bar runs: App Settings opens the local web's window; the menu's accelerators still work", { ...realOnly, skip: realOnly.skip || (!OWN_BAR && "macOS") }, async () => {
  await app.click(`#title-bar .tb-top[data-index="1"]`);
  await until(async () => (await shown())?.label === "BUSY Bar", "BUSY Bar");
  await app.click(`#title-bar-menu .tb-item[data-id="app-settings"]`);
  await until(() => app.run((shell) => Boolean(shell.windows.localWeb?.presented)), "the local web's window");
  const localWeb = await app.run((shell) => {
    const win = shell.windows.localWeb.win;
    return { menuBar: win.isMenuBarVisible(), framed: win.getContentBounds().height < win.getBounds().height - 20 };
  });
  assert.deepEqual(localWeb, { menuBar: false, framed: true }, "the local web keeps the system's title bar, without the menu's strip");
  await app.run((shell) => shell.windows.closeLocalWeb());
  await until(() => app.run((shell) => shell.windows.localWeb === null), "the local web closed");
  // Ctrl+, is the menu's own accelerator: the system's menu is still there, out of sight. The system takes a key for
  // an accelerator only in the window in front, which a hidden run has none of.
  if (!VISIBLE) return;
  await app.run((shell) => shell.windows.current.win.focus());
  await keys([[",", ["control"]]]);
  await until(() => app.run((shell) => Boolean(shell.windows.localWeb?.presented)), "Ctrl+, opened the local web's window");
  await app.run((shell) => shell.windows.closeLocalWeb());
});

test("the page may not press an item of the menu without the person's click or key, nor one it was not shown", realOnly, async () => {
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal((await app.page(`window.busyShell.action("menu.run", "app-settings")`)).error.code, "no_gesture");
  // A key just before, and the call at once after it, in one go: a slow machine does not let the key go stale.
  const answer = await app.run((shell) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
    return contents.executeJavaScript(`window.busyShell.action("menu.run", "role:about-not-there")`, true);
  });
  assert.equal(answer.error.code, "no_item");
  assert.equal(await app.run((shell) => shell.windows.localWeb), null);
});

test("macOS: the system's frame and menu bar as before; the page draws no bar", { ...realOnly, skip: realOnly.skip || (OWN_BAR && "Windows and Linux have the bar") }, async () => {
  const menu = await app.run((_shell, electron) => electron.Menu.getApplicationMenu().items.map((top) => top.label || top.role));
  assert.equal(menu[0], "BUSY Bar Emulator");
  const frame = await app.run((shell) => {
    const win = shell.windows.current.win;
    return { window: win.getBounds().height, content: win.getContentBounds().height };
  });
  assert.ok(frame.content < frame.window, "the window has the system's title bar");
  const answer = await app.page(`window.busyShell.action("menu.get")`);
  assert.equal(answer.value.titleBar, false);
  assert.deepEqual(await app.page(`[Boolean(document.getElementById("title-bar")), document.documentElement.classList.contains("has-title-bar"), navigator.windowControlsOverlay ? navigator.windowControlsOverlay.visible : false]`), [false, false, false]);
});
