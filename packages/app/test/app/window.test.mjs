// The shell shows one window: the device window, loaded from the server's own address. Of the shell it has one thing:
// the bridge's function for the actions on app projects (actions.test.mjs holds those to their rules).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { sleep } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch, VISIBLE } from "./harness.mjs";

let app;
before(async () => {
  app = await launch({ server: HAS_REAL_SERVER ? "real" : "fake" });
  await app.waitWindow("device");
});
after(() => app?.close());

test("there is one window, and it shows the page at the server's own address", async () => {
  const windows = await app.run((shell, electron) => electron.BrowserWindow.getAllWindows().map((w) => ({ url: w.webContents.getURL(), shown: shell.windows.current.presented })));
  assert.deepEqual(windows, [{ url: `http://127.0.0.1:${app.port}/emulator`, shown: true }]);
  assert.equal(await app.page("location.origin"), `http://127.0.0.1:${app.port}`);
});

test("the page is the real device window and it talks to the server", { skip: !HAS_REAL_SERVER && "the server is not beside this package" }, async () => {
  assert.equal(await app.page("document.title"), "BUSY Bar Emulator");
  const status = await app.page("fetch('/api/status').then((r) => r.json())");
  assert.equal(status.device.serial_number, "EMULATOR");
});

test("the device window has the bridge's one function and nothing else of the shell: no Node, no Electron, no channel of its own", async () => {
  assert.deepEqual(await app.page("Object.keys(window.busyShell).sort()"), ["action", "onJob", "onMenu"]);
  assert.equal(await app.page("Object.keys(window).filter((k) => /shell|electron|ipc/i.test(k)).join()"), "busyShell");
  assert.deepEqual(await app.page("[typeof require, typeof process, typeof module, typeof ipcRenderer]"), ["undefined", "undefined", "undefined", "undefined"]);
  // The message page's actions are not this page's: the main process decides by the window and the page.
  const answers = await app.page(`Promise.all(["message.get", "server.retry", "app.quit"].map((name) => window.busyShell.action(name).then(() => "allowed", () => "refused")))`);
  assert.deepEqual(answers, ["refused", "refused", "refused"]);
});

test("a hidden run keeps a window off the screen even when something makes one to be shown", { skip: VISIBLE && "a run with windows on the screen has no such rule" }, async () => {
  // What Electron does for window.open, if that were allowed: a window that shows itself. One pixel, in case the rule fails.
  const stray = await app.run(async (_shell, electron) => {
    const win = new electron.BrowserWindow({ show: true, width: 1, height: 1, x: 0, y: 0, frame: false, focusable: false, hasShadow: false, skipTaskbar: true });
    const opacityAtBirth = win.getOpacity();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const state = { opacityAtBirth, visible: win.isVisible(), opacity: win.getOpacity() };
    win.destroy();
    return state;
  });
  assert.deepEqual(stray, { opacityAtBirth: 0, visible: false, opacity: 0 });
  await sleep(100);
  assert.equal(await app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length), 1);
});
