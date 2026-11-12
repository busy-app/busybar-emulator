// The permission rule installSecurity puts on every session, held with stand-ins for Electron's app, session and pages:
// a frame of another origin in a window, which no page of the app can make today, so the app tests cannot see the rule
// break (EMU-201 review, point 8). The second lock on <webview> (point 9) is held by test/unit/security.test.mjs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createWindowRegistry, installSecurity } from "../../src/security.mjs";

const DEVICE_ORIGIN = "http://127.0.0.1:8640";

/** A session that records the handlers it is given, as test/unit/security.test.mjs makes one. */
function fakeSession() {
  const ses = new EventEmitter();
  Object.assign(ses, {
    handlers: {},
    setPermissionRequestHandler: (fn) => (ses.handlers.request = fn),
    setPermissionCheckHandler: (fn) => (ses.handlers.check = fn),
    setDevicePermissionHandler: (fn) => (ses.handlers.device = fn),
    setSpellCheckerEnabled: () => {},
    registerPreloadScript: () => {},
    setProxy: async () => {},
    webRequest: { onBeforeRequest: () => {}, onBeforeSendHeaders: () => {} },
  });
  return ses;
}

function fakeContents() {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  contents.setWebRTCIPHandlingPolicy = () => {};
  return contents;
}

async function install() {
  const app = new EventEmitter();
  app.isReady = () => true;
  app.whenReady = async () => {};
  const registry = createWindowRegistry();
  const ses = fakeSession();
  const logged = [];
  await installSecurity({ app, session: ses, registry, log: (line) => logged.push(line), addressesOf: () => ["127.0.0.1:8640"], pagePreload: "/app/src/page-preload.cjs" });
  const device = fakeContents();
  registry.register(device, { kind: "device", origin: DEVICE_ORIGIN, allows: () => true });
  app.emit("web-contents-created", {}, device);
  return { app, handlers: ses.handlers, logged, device: { contents: device } };
}

const request = (handlers, contents, permission, requestingUrl) =>
  new Promise((resolve) => handlers.request(contents, permission, resolve, { requestingUrl }));

test("a permission is given only to a page of the window's own origin: a frame of another origin inherits nothing", async () => {
  const { handlers, device } = await install();
  assert.equal(await request(handlers, device.contents, "clipboard-sanitized-write", `${DEVICE_ORIGIN}/emulator`), true);
  for (const other of ["http://127.0.0.1:8641/emulator", "http://localhost:8640/emulator", "app://shell/message.html", "https://example.com/", "blob:null/x", "", undefined]) {
    assert.equal(await request(handlers, device.contents, "clipboard-sanitized-write", other), false, String(other));
  }
  assert.equal(handlers.check(device.contents, "clipboard-sanitized-write", DEVICE_ORIGIN), true);
  for (const other of ["http://127.0.0.1:8641", "https://example.com", "null", ""]) {
    assert.equal(handlers.check(device.contents, "clipboard-sanitized-write", other), false, other);
  }
});

test("a permission not on the window's list is refused, even for its own origin; a page that is no window gets none", async () => {
  const { handlers, device, logged } = await install();
  assert.equal(await request(handlers, device.contents, "media", `${DEVICE_ORIGIN}/emulator`), false);
  assert.equal(handlers.check(device.contents, "geolocation", DEVICE_ORIGIN), false);
  const stray = fakeContents();
  assert.equal(await request(handlers, stray.contents, "clipboard-sanitized-write", `${DEVICE_ORIGIN}/emulator`), false);
  assert.equal(handlers.check(null, "clipboard-sanitized-write", DEVICE_ORIGIN), false);
  assert.equal(handlers.device(), false);
  assert.ok(logged.some((line) => line.startsWith("[shell] refused permission media for http://127.0.0.1:8640")), logged.join("|"));
});
