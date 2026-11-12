// The rules of security.mjs that need no Electron: the network of a session, the switches of the command line, and
// what installSecurity puts on a session and on a page — checked on stand-ins, so that the second lines, which no
// page can show (there is never a device to choose; <webview> is already off), are pinned as well.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { closedNetwork, createWindowRegistry, FEATURES_OFF, installSecurity, NOWHERE, PAGE_PREFERENCES, requestAllowed, switchNamesIn } from "../../src/security.mjs";

const SERVER = "127.0.0.1:8640";

test("a closed session's proxy sends everything to port 0 of the loopback address but the named addresses", () => {
  assert.equal(NOWHERE, "127.0.0.1:0");
  assert.deepEqual(closedNetwork([SERVER]), { mode: "fixed_servers", proxyRules: "127.0.0.1:0", proxyBypassRules: "<-loopback>;http://127.0.0.1:8640;ws://127.0.0.1:8640" });
  // Nothing named: nothing bypasses, the loopback address included.
  assert.deepEqual(closedNetwork([]), { mode: "fixed_servers", proxyRules: "127.0.0.1:0", proxyBypassRules: "<-loopback>" });
});

test("the rule on requests: the server's address over HTTP and WebSocket, the app's own schemes, nothing else", () => {
  for (const address of [`http://${SERVER}/emulator`, `ws://${SERVER}/api/status/ws`, `http://${SERVER}/api/x?y=1`, "app://shell/message.html", "data:text/plain,x", "blob:http://127.0.0.1:8640/0b5c"]) {
    assert.equal(requestAllowed(address, [SERVER]), true, address);
  }
  for (const address of [
    "http://127.0.0.1:8641/",
    "http://localhost:8640/",
    "http://[::1]:8640/",
    `https://${SERVER}/`,
    `wss://${SERVER}/`,
    "https://api.iconify.design/lucide.json?icons=x",
    "http://192.0.2.1/",
    "http://127.0.0.1/",
    "file:///etc/hosts",
    "ftp://127.0.0.1:8640/",
    "chrome://gpu",
    "javascript:1",
    "not an address",
  ]) {
    assert.equal(requestAllowed(address, [SERVER]), false, address);
  }
  // The default port counts as the port.
  assert.equal(requestAllowed("http://127.0.0.1/", ["127.0.0.1:80"]), true);
  assert.equal(requestAllowed(`http://${SERVER}/`, []), false);
});

test("every switch of the command line is found: both prefixes, with and without a value, in any case", () => {
  const args = ["/Applications/BUSY Bar Emulator.app", "--disable-web-security", "--proxy-server=127.0.0.1:1", "-js-flags=--expose-gc", "--Host-Rules=MAP * x", "--", "--after-the-end", "-psn_0_1", "plain"];
  assert.deepEqual(switchNamesIn(args, "darwin").sort(), ["Host-Rules", "after-the-end", "disable-web-security", "host-rules", "js-flags", "proxy-server", "psn_0_1"].sort());
  // On Windows a slash starts a switch as well, and so a path would be read as one: removing a switch that is not
  // there does nothing.
  assert.deepEqual(switchNamesIn(["/remote-debugging-port=9", "C:\\x"], "win32").sort(), ["remote-debugging-port"]);
  assert.deepEqual(switchNamesIn(["/remote-debugging-port=9"], "darwin"), []);
  assert.deepEqual(switchNamesIn(["--", "-", "--=x"], "darwin"), []);
});

test("pages show no system dialog and check no spelling; mDNS of WebRTC is off", () => {
  assert.equal(PAGE_PREFERENCES.disableDialogs, true);
  assert.equal(PAGE_PREFERENCES.spellcheck, false);
  assert.deepEqual(FEATURES_OFF, ["WebRtcHideLocalIpsWithMdns"]);
});

// ---------------------------------------------------------------- installSecurity on stand-ins

function fakeSession({ proxyFails = false } = {}) {
  const ses = new EventEmitter();
  Object.assign(ses, {
    handlers: {},
    proxy: null,
    spellcheck: true,
    preloads: [],
    setPermissionRequestHandler: (fn) => (ses.handlers.request = fn),
    setPermissionCheckHandler: (fn) => (ses.handlers.check = fn),
    setDevicePermissionHandler: (fn) => (ses.handlers.device = fn),
    setSpellCheckerEnabled: (on) => (ses.spellcheck = on),
    registerPreloadScript: (script) => ses.preloads.push(script),
    setProxy: async (config) => {
      if (proxyFails) throw new Error("no proxy today");
      ses.proxy = config;
    },
    webRequest: {
      onBeforeRequest: (fn) => (ses.handlers.beforeRequest = fn),
      onBeforeSendHeaders: (fn) => (ses.handlers.beforeSendHeaders = fn),
    },
  });
  return ses;
}

function fakeApp() {
  const app = new EventEmitter();
  app.isReady = () => true;
  app.whenReady = async () => {};
  return app;
}

function fakeContents() {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = (fn) => (contents.windowOpen = fn);
  contents.setWebRTCIPHandlingPolicy = (policy) => (contents.webrtc = policy);
  return contents;
}

const prevented = (fields = {}) => {
  const event = { ...fields, prevented: false, preventDefault: () => (event.prevented = true) };
  return event;
};

async function install(o = {}) {
  const app = fakeApp();
  const ses = o.session ?? fakeSession();
  const lines = [];
  const done = installSecurity({ app, session: ses, registry: createWindowRegistry(), log: (line) => lines.push(line), addressesOf: (s) => (s === ses || o.sessions?.includes(s) ? [SERVER] : []), pagePreload: "/app/src/page-preload.cjs", ...o.more, ...(o.sessions ? { sessions: o.sessions } : {}) });
  return { app, ses, lines, done };
}

test("the windows' session: three permission handlers, no downloads, no spelling, the page preload, the proxy", async () => {
  const { ses, done } = await install();
  await done;
  assert.deepEqual(Object.keys(ses.handlers).sort(), ["beforeRequest", "beforeSendHeaders", "check", "device", "request"]);
  // The second line for devices: no page is ever given one.
  assert.equal(ses.handlers.device({ deviceType: "hid", origin: "http://127.0.0.1:8640", device: {} }), false);
  assert.equal(ses.spellcheck, false);
  assert.deepEqual(ses.preloads, [{ type: "frame", id: "busy-emulator-page", filePath: "/app/src/page-preload.cjs" }]);
  assert.deepEqual(ses.proxy, closedNetwork([SERVER]));
  const download = prevented();
  ses.emit("will-download", download, {});
  assert.equal(download.prevented, true);
});

test("the rule on requests answers by the session's addresses, and a service worker's script is refused", async () => {
  const { ses, lines, done } = await install();
  await done;
  const answer = (handler, details) => new Promise((resolve) => ses.handlers[handler](details, resolve));
  assert.deepEqual(await answer("beforeRequest", { url: `http://${SERVER}/emulator` }), { cancel: false });
  assert.deepEqual(await answer("beforeRequest", { url: "http://127.0.0.1:8641/secret?token=abc" }), { cancel: true });
  assert.match(lines.at(-1), /^\[shell\] refused a request: http:\/\/127\.0\.0\.1:8641\/secret \(and a query\)$/);
  assert.deepEqual(await answer("beforeSendHeaders", { url: `http://${SERVER}/emulator/worker.js`, requestHeaders: { "Service-Worker": "script" } }), { cancel: true });
  assert.deepEqual(await answer("beforeSendHeaders", { url: `http://${SERVER}/emulator/window.js`, requestHeaders: { Accept: "*/*" } }), { cancel: false });
});

test("a session made later gets the same handlers, and its network is closed entirely", async () => {
  const { app, done } = await install();
  await done;
  const later = fakeSession();
  app.emit("session-created", later);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(Object.keys(later.handlers).sort(), ["beforeRequest", "beforeSendHeaders", "check", "device", "request"]);
  assert.deepEqual(later.proxy, closedNetwork([]));
  assert.equal(later.spellcheck, false);
  assert.equal(later.preloads.length, 1);
  // Given twice, a session is secured once.
  app.emit("session-created", later);
  assert.equal(later.preloads.length, 1);
});

test("a windows' session whose network cannot be closed stops the start", async () => {
  const { done } = await install({ session: fakeSession({ proxyFails: true }) });
  await assert.rejects(done, /no proxy today/);
});

test("on every page: no new window, no <webview>, no holding the window open, the WebRTC policy", async () => {
  const { app, lines, done } = await install();
  await done;
  const contents = fakeContents();
  app.emit("web-contents-created", {}, contents);
  assert.deepEqual(contents.windowOpen({ url: "https://example.com/?q=1" }), { action: "deny" });
  assert.equal(lines.at(-1), "[shell] refused a new window: https://example.com/ (and a query)");
  for (const name of ["will-attach-webview", "will-prevent-unload"]) {
    const event = prevented();
    contents.emit(name, event);
    assert.equal(event.prevented, true, name);
  }
  assert.equal(contents.webrtc, "disable_non_proxied_udp");
  // A page of no window of the shell may go nowhere.
  const navigation = prevented({ url: `http://${SERVER}/emulator`, isMainFrame: true });
  contents.emit("will-frame-navigate", navigation);
  assert.equal(navigation.prevented, true);
});

// ---------------------------------------------------------------- the local web's session and its window (EMU-209)

test("the other sessions of the shell's windows are closed before the start goes on, and one that cannot be stops it", async () => {
  const web = fakeSession();
  const { ses, done } = await install({ sessions: [web] });
  await done;
  assert.deepEqual(web.proxy, closedNetwork([SERVER]));
  assert.deepEqual(ses.proxy, closedNetwork([SERVER]));
  assert.equal(web.preloads.length, 1);
  await assert.rejects((await install({ sessions: [fakeSession({ proxyFails: true })] })).done, /no proxy today/);
});

test("what a session's own handler answers inside the app passes the rule on requests in that session only; the proxy stays closed", async () => {
  const web = fakeSession();
  const icons = (address) => address.startsWith("https://api.iconify.design/lucide.json?");
  const { ses, done } = await install({ sessions: [web], more: { answeredInside: (s) => (s === web ? icons : null) } });
  await done;
  const answer = (session, url) => new Promise((resolve) => session.handlers.beforeRequest({ url }, resolve));
  assert.deepEqual(await answer(web, "https://api.iconify.design/lucide.json?icons=check"), { cancel: false });
  assert.deepEqual(await answer(web, "https://api.iconify.design/other"), { cancel: true });
  assert.deepEqual(await answer(web, "https://example.com/"), { cancel: true });
  assert.deepEqual(await answer(ses, "https://api.iconify.design/lucide.json?icons=check"), { cancel: true });
  // Nothing about the proxy changes: an address answered inside still has nowhere to go on the network.
  assert.deepEqual(web.proxy, closedNetwork([SERVER]));
});

test("a new window a page asks for: one the shell shows itself, an address for the browser, or nothing", async () => {
  const asked = [];
  const external = [];
  const inputs = [];
  const { app, lines, done } = await install({
    more: {
      onWindowAsked: (_contents, address) => (asked.push(address), address === `http://${SERVER}/`),
      onExternal: (from, address) => external.push([from, address]),
      onInput: (from, type) => inputs.push([from, type]),
    },
  });
  await done;
  const contents = fakeContents();
  app.emit("web-contents-created", {}, contents);
  // What the person does in a window reaches the rule on addresses for the browser, with the window it was done in.
  contents.emit("input-event", {}, { type: "mouseDown" });
  contents.emit("input-event", {}, { type: "mouseMove" });
  assert.deepEqual(inputs, [[contents, "mouseDown"], [contents, "mouseMove"]]);
  // The shell's own window: denied to the page all the same, and neither logged as a refusal nor sent to the browser.
  assert.deepEqual(contents.windowOpen({ url: `http://${SERVER}/` }), { action: "deny" });
  assert.deepEqual(lines, []);
  assert.deepEqual(external, []);
  assert.deepEqual(contents.windowOpen({ url: "https://example.com/docs" }), { action: "deny" });
  assert.equal(lines.at(-1), "[shell] refused a new window: https://example.com/docs");
  assert.deepEqual(external, [[contents, "https://example.com/docs"]]);
  // An address a page leaves for by navigation: refused, and for the browser too, from the window's own frame only.
  const leaving = (isMainFrame) => contents.emit("will-frame-navigate", { url: "https://example.org/left", isMainFrame, preventDefault() {} });
  leaving(false);
  assert.equal(external.length, 1);
  leaving(true);
  assert.deepEqual(external.at(-1), [contents, "https://example.org/left"]);
  assert.deepEqual(asked, [`http://${SERVER}/`, "https://example.com/docs"]);
});
