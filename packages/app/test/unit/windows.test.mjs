// The one window, with a stand-in for Electron's BrowserWindow: what is created, when it is put on the screen, and
// that a hidden run never puts anything there.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createWindowRegistry } from "../../src/security.mjs";
import { createWindows, deviceAddress, MESSAGE_PAGE } from "../../src/windows.mjs";

function setup({ hidden, devicePreloadPath = null, platform = "darwin", systemDark = () => false }) {
  const made = [];
  const closed = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.calls = [];
      this.minimized = false;
      this.webContents = { loadURL: (url) => (this.calls.push(`load ${url}`), Promise.resolve()) };
      made.push(this);
    }
    loadURL(url) {
      return this.webContents.loadURL(url);
    }
    show() {
      this.calls.push("show");
    }
    focus() {
      this.calls.push("focus");
    }
    restore() {
      this.calls.push("restore");
      this.minimized = false;
    }
    isMinimized() {
      return this.minimized;
    }
    destroy() {
      this.calls.push("destroy");
      this.emit("closed");
    }
    isDestroyed() {
      return false;
    }
    setTitleBarOverlay(options) {
      this.calls.push(`overlay ${options.color}`);
    }
  }
  const registry = createWindowRegistry();
  const config = {
    hidden,
    development: false,
    windowUrl: "http://127.0.0.1:8640/emulator",
    localWebUrl: "http://127.0.0.1:8640/",
    appSettingsUrl: "http://127.0.0.1:8640/emulator/local-web.html?tab=apps",
  };
  const windows = createWindows({ BrowserWindow: FakeWindow, registry, config, preloadPath: "/app/src/preload.cjs", devicePreloadPath, onDeviceClosed: () => closed.push("device"), platform, systemDark, log: () => {} });
  return { windows, made, registry, closed };
}

test("the device window gets its own preload (the actions on app projects), never the message page's; its end is told, closed or replaced", () => {
  const { windows, made, closed } = setup({ hidden: false, devicePreloadPath: "/app/src/window-preload.cjs" });
  windows.showDevice();
  assert.equal(made[0].options.webPreferences.preload, "/app/src/window-preload.cjs");
  assert.equal(made[0].options.webPreferences.sandbox, true);
  assert.equal(made[0].options.webPreferences.contextIsolation, true);
  // Replaced by the message window: the device window is gone.
  windows.showMessage();
  assert.equal(made[1].options.webPreferences.preload, "/app/src/preload.cjs");
  assert.deepEqual(closed, ["device"]);
  // The message window's end is not the device window's.
  windows.showDevice();
  assert.deepEqual(closed, ["device"]);
  // Closed by the person.
  made[2].emit("closed");
  assert.deepEqual(closed, ["device", "device"]);
  assert.equal(windows.dismissed, true);
  // The local web's window never gets a preload.
  windows.showLocalWeb();
  assert.equal(made[3].options.webPreferences.preload, undefined);
});

test("the windows get the icon the shell is given (outside macOS: the title bar and the taskbar), and none when it gives none", () => {
  const made = [];
  class IconWindow {
    constructor(options) {
      this.options = options;
      this.webContents = { id: made.length + 1, on() {}, once() {}, loadURL: () => Promise.resolve(), setWindowOpenHandler() {} };
      made.push(this);
    }
    once() {}
    on() {}
    loadURL() {
      return Promise.resolve();
    }
  }
  const config = { hidden: true, development: false, windowUrl: "http://127.0.0.1:8640/emulator", localWebUrl: "http://127.0.0.1:8640/", appSettingsUrl: "http://127.0.0.1:8640/emulator/local-web.html?tab=apps" };
  const withIcon = createWindows({ BrowserWindow: IconWindow, registry: createWindowRegistry(), config, preloadPath: "/app/src/preload.cjs", icon: "/app/src/assets/app-icon.png", log: () => {} });
  withIcon.showDevice();
  withIcon.showLocalWeb();
  assert.deepEqual(made.map((win) => win.options.icon), ["/app/src/assets/app-icon.png", "/app/src/assets/app-icon.png"]);
  made.length = 0;
  createWindows({ BrowserWindow: IconWindow, registry: createWindowRegistry(), config, preloadPath: "/app/src/preload.cjs", log: () => {} }).showDevice();
  assert.ok(!("icon" in made[0].options), "macOS: the app's icon comes from its bundle");
});

test("the device window without a preload given: none, registered as the device window, shown once its page is ready", () => {
  const { windows, made, registry } = setup({ hidden: false });
  windows.showDevice();
  const [win] = made;
  assert.equal(win.options.show, false);
  assert.equal(win.options.skipTaskbar, false);
  assert.equal(win.options.webPreferences.preload, undefined);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.devTools, false);
  assert.equal(registry.kindOf(win.webContents), "device");
  assert.deepEqual(win.calls, ["load http://127.0.0.1:8640/emulator"]);
  assert.equal(windows.current.presented, false);
  win.emit("ready-to-show");
  assert.deepEqual(win.calls, ["load http://127.0.0.1:8640/emulator", "show"]);
  assert.equal(windows.current.presented, true);
});

test("the device window keeps to /emulator on the server's address", () => {
  const { windows, made, registry } = setup({ hidden: false });
  windows.showDevice();
  const contents = made[0].webContents;
  for (const address of ["http://127.0.0.1:8640/emulator", "http://127.0.0.1:8640/emulator/window.js", "http://127.0.0.1:8640/emulator?x=1"]) {
    assert.equal(registry.allows(contents, address), true, address);
  }
  for (const address of ["http://127.0.0.1:8640/", "http://127.0.0.1:8640/emulatorx", "http://127.0.0.1:8641/emulator", "http://localhost:8640/emulator", "https://127.0.0.1:8640/emulator", "app://shell/message.html", "file:///emulator", "not an address"]) {
    assert.equal(registry.allows(contents, address), false, address);
  }
});

test("the message window: the shell's page with the preload; it replaces the device window, and the new one exists first", () => {
  const { windows, made, registry } = setup({ hidden: false });
  windows.showDevice();
  windows.showMessage();
  const [device, message] = made;
  assert.equal(message.options.webPreferences.preload, "/app/src/preload.cjs");
  assert.equal(registry.kindOf(message.webContents), "message");
  assert.deepEqual(message.calls, [`load ${MESSAGE_PAGE}`]);
  assert.deepEqual(device.calls.at(-1), "destroy");
  assert.equal(windows.current.kind, "message");
  assert.equal(windows.dismissed, false, "replacing a window is not the human closing it");
  assert.equal(registry.allows(message.webContents, "app://shell/message.html"), true);
  assert.equal(registry.allows(message.webContents, "http://127.0.0.1:8640/emulator"), false);
});

test("showing the kind that is already there loads its page again in the same window", () => {
  const { windows, made } = setup({ hidden: false });
  windows.showDevice();
  windows.showDevice();
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].calls, ["load http://127.0.0.1:8640/emulator", "load http://127.0.0.1:8640/emulator"]);
});

test("a window the human closed is gone and marked so; showing a window again clears the mark", () => {
  const { windows, made } = setup({ hidden: false });
  windows.showDevice();
  made[0].emit("closed");
  assert.equal(windows.current, null);
  assert.equal(windows.dismissed, true);
  assert.equal(windows.focus(), false);
  windows.showDevice();
  assert.equal(windows.dismissed, false);
  assert.equal(made.length, 2);
});

test("focus brings the window to the front, restoring it when it is minimized", () => {
  const { windows, made } = setup({ hidden: false });
  windows.showDevice();
  made[0].minimized = true;
  assert.equal(windows.focus(), true);
  assert.deepEqual(made[0].calls.slice(1), ["restore", "show", "focus"]);
  assert.equal(windows.raised, 1);
});

test("a hidden run does all of it and puts nothing on the screen", () => {
  const { windows, made } = setup({ hidden: true });
  windows.showDevice();
  const [win] = made;
  assert.equal(win.options.show, false);
  assert.equal(win.options.skipTaskbar, true);
  win.emit("ready-to-show");
  assert.equal(windows.current.presented, true);
  win.minimized = true;
  assert.equal(windows.focus(), true);
  assert.equal(windows.raised, 1);
  windows.showMessage();
  made[1].emit("ready-to-show");
  windows.focus();
  for (const one of made) assert.ok(!one.calls.includes("show") && !one.calls.includes("focus") && !one.calls.includes("restore"), one.calls.join());
});

// ---------------------------------------------------------------- the local web's window (EMU-209)

const APP_SETTINGS = "http://127.0.0.1:8640/emulator/local-web.html?tab=apps";

test("the local web's window: beside the main one, its own storage, no preload, registered as the local web", () => {
  const { windows, made, registry } = setup({ hidden: false });
  windows.showDevice();
  windows.showLocalWeb(APP_SETTINGS);
  assert.equal(made.length, 2);
  const [device, web] = made;
  assert.equal(windows.current.win, device, "the main window stays");
  assert.ok(!device.calls.includes("destroy"));
  assert.equal(windows.localWeb.win, web);
  assert.equal(web.options.webPreferences.partition, "persist:local-web");
  assert.equal(device.options.webPreferences.partition, undefined);
  assert.equal(web.options.webPreferences.preload, undefined);
  assert.equal(web.options.webPreferences.sandbox, true);
  assert.equal(web.options.webPreferences.contextIsolation, true);
  assert.equal(web.options.show, false);
  assert.equal(registry.kindOf(web.webContents), "local-web");
  assert.deepEqual(web.calls, [`load ${APP_SETTINGS}`]);
  web.emit("ready-to-show");
  assert.deepEqual(web.calls, [`load ${APP_SETTINGS}`, "show"]);
  assert.equal(windows.localWeb.presented, true);
});

test("asked for again, the local web's window comes to the front: no second window, no new load", () => {
  const { windows, made } = setup({ hidden: false });
  windows.showLocalWeb();
  made[0].minimized = true;
  windows.showLocalWeb(APP_SETTINGS);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].calls, ["load http://127.0.0.1:8640/", "restore", "show", "focus"]);
  assert.equal(windows.raised, 1);
  // Closed by the person, it is made anew the next time.
  made[0].emit("closed");
  assert.equal(windows.localWeb, null);
  windows.showLocalWeb();
  assert.equal(made.length, 2);
});

test("the local web's window keeps to the local web: not the device window, not its old paths, no other origin", () => {
  const { windows, made, registry } = setup({ hidden: false });
  windows.showLocalWeb();
  const contents = made[0].webContents;
  for (const address of ["http://127.0.0.1:8640/", "http://127.0.0.1:8640/login", "http://127.0.0.1:8640/_nuxt/entry.js", APP_SETTINGS, "http://127.0.0.1:8640/emulator/local-web.html?tab=settings"]) {
    assert.equal(registry.allows(contents, address), true, address);
    assert.equal(windows.isLocalWebAddress(address), true, address);
  }
  for (const address of ["http://127.0.0.1:8640/emulator", "http://127.0.0.1:8640/emulator/window.js", "http://127.0.0.1:8640/_emu/state", "http://127.0.0.1:8641/", "http://localhost:8640/", "https://127.0.0.1:8640/", "https://example.com/", "app://shell/message.html", "not an address"]) {
    assert.equal(registry.allows(contents, address), false, address);
    assert.equal(windows.isLocalWebAddress(address), false, address);
  }
});

test("an address that is not the local web's is not loaded into its window: the local web itself is", () => {
  const { windows, made } = setup({ hidden: false });
  windows.showLocalWeb("https://example.com/");
  assert.deepEqual(made[0].calls, ["load http://127.0.0.1:8640/"]);
});

test("a hidden run never puts the local web's window on the screen", () => {
  const { windows, made } = setup({ hidden: true });
  windows.showLocalWeb();
  made[0].emit("ready-to-show");
  windows.showLocalWeb();
  assert.equal(made[0].options.skipTaskbar, true);
  assert.deepEqual(made[0].calls, ["load http://127.0.0.1:8640/"]);
  assert.equal(windows.raised, 1);
});

// ---------------------------------------------------------------- the notice of a new version (EMU-205)

const NOTICE = { version: "0.2.0", page: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.2.0" };
const WITH_NOTICE = "http://127.0.0.1:8640/emulator#update=0.2.0&page=https%3A%2F%2Fgithub.com%2Fbusy-app%2Fbusybar-emulator%2Freleases%2Ftag%2Fv0.2.0";

test("a notice goes to the device window in its address's fragment: the page is not loaded anew", () => {
  assert.equal(deviceAddress("http://127.0.0.1:8640/emulator", NOTICE), WITH_NOTICE);
  assert.equal(deviceAddress("http://127.0.0.1:8640/emulator", null), "http://127.0.0.1:8640/emulator");
  const { windows, made } = setup({ hidden: false });
  windows.showDevice();
  windows.setNotice(NOTICE);
  // The same notice again changes nothing.
  windows.setNotice({ ...NOTICE });
  assert.deepEqual(made[0].calls, ["load http://127.0.0.1:8640/emulator", `load ${WITH_NOTICE}`]);
  // Taken away, the address keeps a fragment: without one the page would load again.
  windows.setNotice(null);
  assert.equal(made[0].calls.at(-1), "load http://127.0.0.1:8640/emulator#");
  assert.equal(made[0].calls.length, 3);
});

test("a notice that came before the device window is in the address the window is loaded with; the message page gets none", () => {
  const { windows, made } = setup({ hidden: false });
  windows.setNotice(NOTICE);
  assert.equal(made.length, 0);
  windows.showMessage();
  assert.deepEqual(made[0].calls, [`load ${MESSAGE_PAGE}`]);
  windows.showDevice();
  assert.deepEqual(made[1].calls, [`load ${WITH_NOTICE}`]);
  assert.deepEqual(windows.notice, NOTICE);
});

test("outside macOS the device window and the message page have the shell's own title bar, the local web the system's without the menu's strip; macOS keeps its frame", () => {
  let dark = false;
  const win = setup({ hidden: false, platform: "win32", systemDark: () => dark });
  win.windows.showDevice();
  assert.equal(win.made[0].options.titleBarStyle, "hidden");
  assert.deepEqual(win.made[0].options.titleBarOverlay, { color: "#0a0a0a", symbolColor: "#e5e5e5", height: 36 });
  win.windows.showLocalWeb();
  assert.equal(win.made[1].options.titleBarStyle, undefined);
  assert.equal(win.made[1].options.autoHideMenuBar, true);
  // The message page is as light or dark as the system, and follows it.
  win.windows.showMessage();
  assert.equal(win.made[2].options.titleBarOverlay.color, "#ffffff");
  dark = true;
  win.windows.retheme();
  assert.ok(win.made[2].calls.includes("overlay #121212"));
  // The device window is dark whatever the system is: retheme leaves it.
  win.windows.showDevice();
  win.windows.retheme();
  assert.ok(!win.made[3].calls.some((call) => call.startsWith("overlay")));

  const mac = setup({ hidden: false, platform: "darwin" });
  mac.windows.showDevice();
  mac.windows.showLocalWeb();
  mac.windows.showMessage();
  for (const made of mac.made) {
    assert.equal(made.options.titleBarStyle, undefined);
    assert.equal(made.options.titleBarOverlay, undefined);
    assert.equal(made.options.autoHideMenuBar, undefined);
  }
});

test("a window is never opened larger than the screen's work area: a 1366x768 laptop or a full-HD one at 150 %", async () => {
  const { fitToScreen, DEVICE_MIN_SIZE } = await import("../../src/windows.mjs");
  const want = { width: 1180, height: 760, ...DEVICE_MIN_SIZE };
  assert.deepEqual(fitToScreen(want, { width: 1920, height: 1040 }), want, "room enough: as asked, and not centred by force");
  assert.deepEqual(fitToScreen(want, null), want, "no work area known: as asked");
  const small = fitToScreen(want, { width: 1280, height: 693 });
  assert.equal(small.height, 693);
  assert.equal(small.width, 1180);
  assert.equal(small.center, true);
  const tiny = fitToScreen(want, { width: 1093, height: 582 });
  assert.equal(tiny.height, 582);
  assert.equal(tiny.minHeight, 582, "the smallest size gives way as well, or the window could not be made to fit");
  assert.equal(tiny.minWidth, 880);
});
