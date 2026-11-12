// The app runs once: a second launch ends at once and brings the window of the first to the front.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

import { APP_DIR, endOnExit, FAKE_SERVER, CHROMIUM_GONE_WITHIN_MS, NODE, PORTS, survivors, until } from "../helpers.mjs";
import { ELECTRON, launch, QUIET_ENV, VISIBLE } from "./harness.mjs";

let app;
before(async () => {
  app = await launch();
  await app.waitWindow("device");
});
after(() => app?.close());

/** The same app started again by the same user: same data folder, hence the same lock. Resolves with how it ended. */
function secondLaunch() {
  const child = endOnExit(spawn(ELECTRON, [APP_DIR], {
    env: { ...process.env, ...QUIET_ENV, BUSY_EMULATOR_PORT: String(PORTS.app), BUSY_EMULATOR_DATA: app.folder, BUSY_EMULATOR_NODE: NODE, BUSY_EMULATOR_SERVER_ENTRY: FAKE_SERVER, BUSY_EMULATOR_TEST_HOOK: "" },
    stdio: "ignore",
  }));
  return new Promise((resolve) => {
    // A second launch that stays is a second instance: it is ended here and reported as such.
    const timer = setTimeout(() => child.kill("SIGKILL"), CHROMIUM_GONE_WITHIN_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ pid: child.pid, code, signal });
    });
  });
}

test("a second launch ends by itself and starts nothing", async () => {
  const second = await secondLaunch();
  assert.deepEqual({ code: second.code, signal: second.signal }, { code: 0, signal: null });
  assert.deepEqual(await survivors([second.pid], CHROMIUM_GONE_WITHIN_MS), []);
  await until(() => app.run((shell) => shell.secondLaunches === 1), "the first app to hear of the second launch");
  assert.equal(await app.run((shell) => shell.keeper.starts), 1, "a second server was started");
  assert.equal(await app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length), 1);
});

test("the second launch asks the window of the first to the front", async () => {
  const before = await app.run((shell) => shell.windows.raised);
  assert.equal((await secondLaunch()).code, 0);
  await until(() => app.run((shell, _electron, was) => shell.windows.raised === was + 1, before), "the window to be asked to the front");
});

test("on the screen: the second launch brings the minimized window of the first back", { skip: !VISIBLE && "set BUSY_EMULATOR_TEST_VISIBLE=1: the test needs a window on the screen" }, async () => {
  await app.run((shell) => shell.windows.current.win.minimize());
  await until(() => app.run((shell) => shell.windows.current.win.isMinimized()), "the window to be minimized");
  assert.equal((await secondLaunch()).code, 0);
  await until(() => app.run((shell) => !shell.windows.current.win.isMinimized() && shell.windows.current.win.isVisible()), "the window to come back");
});

test("the second launch shows the window again after it was closed (where closing does not quit)", { skip: process.platform !== "darwin" && "closing the last window quits the app on this system" }, async () => {
  await app.run((shell) => void shell.windows.current.win.close());
  await until(() => app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length === 0), "the window to close");
  assert.equal((await app.state()).name, "ready", "the server stopped with the window");
  assert.equal((await secondLaunch()).code, 0);
  await app.waitWindow("device");
  assert.equal(await app.run((shell) => shell.keeper.starts), 1);
});
