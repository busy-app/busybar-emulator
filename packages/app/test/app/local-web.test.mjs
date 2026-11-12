// The bar's local web in a window of its own (EMU-209): opened by the device window's "App settings" and by the menu,
// on the Apps tab; a storage of its own and no bridge; the rules of the device window; its Lucide icons answered
// inside the app, with the network as closed as before.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { PORTS, sleep, until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

const REAL = HAS_REAL_SERVER;
const realOnly = { skip: !REAL && "the server is not beside this package" };
const SERVER = `127.0.0.1:${PORTS.app}`;
const HOME = `http://${SERVER}/`;
const APP_SETTINGS = `http://${SERVER}/emulator/local-web.html?tab=apps`;
const ELSEWHERE = `http://127.0.0.1:${PORTS.witness}`;
const ICON_HOSTS = ["api.iconify.design", "api.simplesvg.com", "api.unisvg.com"];

let app;
let witness; // "the control address", or any other service of this machine
let reached = [];

before(async () => {
  witness = createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
    res.end("elsewhere");
  });
  await new Promise((resolve) => witness.listen(PORTS.witness, "127.0.0.1", resolve));
  app = await launch({ server: REAL ? "real" : "fake" });
  await app.waitWindow("device");
});
after(async () => {
  try {
    await app?.close();
  } finally {
    witness.closeAllConnections();
    await new Promise((resolve) => witness.close(resolve));
  }
});

/** Runs code in the page of the local web's window. */
const web = (code) => app.run((shell, _electron, source) => shell.windows.localWeb.win.webContents.executeJavaScript(source, true), code);
const webUrl = () => app.run((shell) => shell.windows.localWeb?.win.webContents.getURL() ?? null);
const windowCount = () => app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length);
/** Waits for the local web's window to be there, loaded and (in a hidden run: where it would be) shown. */
const waitLocalWeb = () =>
  until(
    () =>
      app.run((shell, _electron, real) => {
        const entry = shell.windows.localWeb;
        if (!entry?.presented || entry.win.webContents.isLoading()) return false;
        // The real server's page for the tab goes on to the local web itself.
        return real ? new URL(entry.win.webContents.getURL()).pathname === "/" : true;
      }, REAL),
    "the local web's window",
  );
const resolveProxy = (address) => app.run((shell, _electron, url) => shell.windows.localWeb.win.webContents.session.resolveProxy(url), address);
const fetchIcons = (host, icons) => web(`fetch("https://${host}/lucide.json?icons=${icons}").then(async (answer) => ({ status: answer.status, body: await answer.json() }), (e) => ({ failed: e.name }))`);

test("the device window's App settings opens the local web in a window of its own, beside the device window", async () => {
  assert.equal(await app.run((shell) => shell.windows.localWeb), null);
  assert.equal(await app.page(`document.querySelector("#app-settings")?.getAttribute("href") ?? "(the stand-in has no such link)"`), REAL ? "/emulator/local-web.html?tab=apps" : "(the stand-in has no such link)");
  // A click on the link asks for a new window; the stand-in's page, which has no link, asks for it itself.
  await app.page(REAL ? `document.querySelector("#app-settings").click()` : `void window.open(${JSON.stringify(APP_SETTINGS)})`);
  await waitLocalWeb();
  assert.equal(await windowCount(), 2);
  assert.equal(await webUrl(), REAL ? HOME : APP_SETTINGS);
  const kinds = await app.run((shell) => ({ main: shell.windows.current.kind, web: shell.registry.kindOf(shell.windows.localWeb.win.webContents), mainUrl: shell.windows.current.win.webContents.getURL() }));
  assert.deepEqual(kinds, { main: "device", web: "local-web", mainUrl: `http://${SERVER}/emulator` });
  // The shell showed the window itself: the page got none, and nothing was refused or sent to the browser.
  assert.doesNotMatch(app.log(), /refused a new window/);
  assert.deepEqual(await app.run((shell) => shell.opener.opened), []);
});

test("it opens on the Apps tab", realOnly, async () => {
  assert.equal(JSON.parse(await web(`localStorage.getItem("tabStore")`)).currentTab, "apps");
  await until(() => web(`document.body.innerText.includes("Your apps")`), "the Apps tab of the local web");
});

test("asked for again — from the device window, from the menu — the open window comes to the front; there is no second one", async () => {
  const before = await app.run((shell) => ({ raised: shell.windows.raised, id: shell.windows.localWeb.win.id }));
  await app.page(`void window.open(${JSON.stringify(APP_SETTINGS)})`);
  await until(() => app.run((shell, _electron, was) => shell.windows.raised === was + 1, before.raised), "the window brought to the front");
  const item = await app.run((_shell, electron) => {
    const found = electron.Menu.getApplicationMenu().getMenuItemById("app-settings");
    found.click();
    return { label: found.label, enabled: found.enabled };
  });
  assert.deepEqual(item, { label: "App Settings", enabled: true });
  await until(() => app.run((shell, _electron, was) => shell.windows.raised === was + 2, before.raised), "the window brought to the front by the menu");
  assert.equal(await windowCount(), 2);
  assert.equal(await app.run((shell) => shell.windows.localWeb.win.id), before.id);
});

test("the menu opens it when it is closed", async () => {
  await app.run((shell) => shell.windows.closeLocalWeb());
  await until(async () => (await windowCount()) === 1, "the local web's window closed");
  assert.equal(await app.run((shell) => shell.windows.current.kind), "device", "closing the local web leaves the device window");
  await app.run((_shell, electron) => electron.Menu.getApplicationMenu().getMenuItemById("app-settings").click());
  await waitLocalWeb();
  assert.equal(await windowCount(), 2);
});

test("its storage is its own: what the device window keeps is not there, and the other way round", async () => {
  const partition = await app.run((shell, electron) => ({
    own: shell.windows.localWeb.win.webContents.session === electron.session.fromPartition("persist:local-web"),
    notDefault: shell.windows.localWeb.win.webContents.session !== electron.session.defaultSession,
    device: shell.windows.current.win.webContents.session === electron.session.defaultSession,
  }));
  assert.deepEqual(partition, { own: true, notDefault: true, device: true });
  await app.page(`localStorage.setItem("emu209-device", "1"); document.cookie = "emu209device=1; path=/"`);
  await web(`localStorage.setItem("emu209-web", "1")`);
  assert.deepEqual(await web(`[location.origin, localStorage.getItem("emu209-device"), document.cookie.includes("emu209device")]`), [`http://${SERVER}`, null, false]);
  assert.equal(await app.page(`localStorage.getItem("emu209-web")`), null);
});

test("it has no bridge: no preload of its own, nothing of the shell in the page", async () => {
  const preferences = await app.run((shell) => shell.windows.localWeb.win.webContents.getLastWebPreferences());
  assert.equal(preferences.preload ?? null, null);
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(await web("typeof window.busyShell"), "undefined");
  assert.equal(await web("Object.keys(window).filter((k) => /shell|electron|ipc/i.test(k)).join()"), "");
  assert.deepEqual(await web("[typeof require, typeof process, typeof RTCPeerConnection]"), ["undefined", "undefined", "undefined"]);
  // The one preload its session has is the one every page gets, which gives a page nothing.
  const preloads = await app.run((shell) => shell.windows.localWeb.win.webContents.session.getPreloadScripts().map((p) => p.filePath.split(/[\\/]/).pop()));
  assert.deepEqual(preloads, ["page-preload.cjs"]);
});

test("it reaches the server it came from and nothing else: not another port of this machine (the control address), not the network", async () => {
  assert.equal(await web(`fetch("/api/status").then((answer) => answer.status)`), 200);
  assert.equal(await resolveProxy(`http://${SERVER}/`), "DIRECT");
  reached = [];
  const outcomes = await web(`(async () => {
    const quiet = (promise) => Promise.race([promise.then(() => "reached", () => "failed"), new Promise((resolve) => setTimeout(() => resolve("no answer"), 2000))]);
    return [
      await quiet(fetch("${ELSEWHERE}/operation", { method: "POST", mode: "no-cors" })),
      await quiet(fetch("http://localhost:${PORTS.witness}/by-name", { mode: "no-cors" })),
      await quiet(fetch("https://example.com/", { mode: "no-cors" })),
      await quiet(new Promise((resolve, reject) => { const socket = new WebSocket("ws://127.0.0.1:${PORTS.witness}/socket"); socket.onopen = resolve; socket.onerror = reject; })),
    ];
  })()`);
  await sleep(300);
  assert.deepEqual(outcomes, ["failed", "failed", "failed", "failed"]);
  assert.deepEqual(reached, [], "requests of the local web's page reached another service on this machine");
  for (const address of [`${ELSEWHERE}/`, `http://localhost:${PORTS.app}/`, "https://example.com/", "http://192.0.2.1/"]) assert.equal(await resolveProxy(address), "PROXY 127.0.0.1:0", address);
  assert.match(app.log(), /refused a request: http:\/\/127\.0\.0\.1:\d+\/operation/);
});

test("the Lucide icons are answered inside the app, on Iconify's three hosts, in the API's format", async () => {
  for (const host of ICON_HOSTS) {
    const answer = await fetchIcons(host, "check,chevron-down,x,no-such-icon");
    assert.equal(answer.status, 200, host);
    assert.equal(answer.body.prefix, "lucide", host);
    assert.deepEqual(Object.keys(answer.body.icons).sort(), ["check", "chevron-down", "x"], host);
    assert.match(answer.body.icons.check.body, /^<path /, host);
    assert.deepEqual(answer.body.not_found, ["no-such-icon"], host);
    assert.equal(answer.body.width, 24, host);
  }
  // Another icon set is "not found", as the API says it; nothing else on those hosts is answered at all.
  assert.equal(await web(`fetch("https://api.iconify.design/mdi.json?icons=home").then((answer) => answer.status, () => "failed")`), 404);
  assert.equal(await web(`fetch("https://api.iconify.design/collect?data=secret", { mode: "no-cors" }).then(() => "reached", () => "failed")`), "failed");
  assert.equal(await web(`fetch("https://api.iconify.design/lucide.json?icons=check", { method: "POST", body: "secret" }).then((answer) => answer.status, () => "failed")`), 403);
  assert.match(app.log(), /refused a request: https:\/\/api\.iconify\.design\/collect/);
});

test("every Lucide icon the local web names is answered", realOnly, async () => {
  const { namesInBuilds } = await import("../../tools/local-web-icons.mjs");
  const names = namesInBuilds();
  const answer = await fetchIcons("api.iconify.design", names.join(","));
  assert.deepEqual(Object.keys(answer.body.icons).sort(), names);
  assert.equal(answer.body.not_found, undefined);
});

test("the device window gets no icons: the answer is the local web's session's alone", async () => {
  assert.equal(await app.page(`fetch("https://api.iconify.design/lucide.json?icons=check").then((answer) => answer.status, () => "failed")`), "failed");
});

test("a request to Iconify's real hosts never leaves the machine: the proxy still sends them nowhere, and without the app's answer they fail", async () => {
  // The session's proxy is the closed one, untouched by the icons.
  for (const host of ICON_HOSTS) {
    for (const address of [`https://${host}/lucide.json?icons=check`, `https://${host}/`, `http://${host}/lucide.json?icons=check`, `wss://${host}/`]) {
      assert.equal(await resolveProxy(address), "PROXY 127.0.0.1:0", address);
    }
  }
  // Then the app's answer is taken away: the rule on requests still lets the icon addresses through, and the network
  // has nowhere to take them.
  await app.run((shell) => shell.windows.localWeb.win.webContents.session.protocol.unhandle("https"));
  try {
    for (const host of ICON_HOSTS) assert.deepEqual(await fetchIcons(host, "check"), { failed: "TypeError" }, host);
    assert.equal(await web(`fetch("/api/status").then((answer) => answer.status)`), 200);
  } finally {
    // As main.mjs sets it.
    await app.run((shell, electron) => electron.session.fromPartition("persist:local-web").protocol.handle("https", shell.answerIcons));
  }
  assert.equal((await fetchIcons("api.iconify.design", "check")).status, 200);
});

test("the rules of the device window hold here: no other origin, no new window; an https link the person clicked goes to the user's browser", async () => {
  const start = await webUrl();
  const opened = () => app.run((shell) => shell.opener.opened);
  const refusedBrowser = () => (app.log().match(/not opened in the browser, no click or key in the window just before/g) ?? []).length;
  // A page that asks by itself, with no click or key of the person in its window: no window, and nothing for the
  // browser either.
  await web(`void window.open("https://example.com/by-itself")`);
  await until(() => refusedBrowser() === 1, "the refusal of an address the page asked for by itself");
  await web(`void (location.href = "https://example.org/by-itself")`);
  await until(() => refusedBrowser() === 2, "the refusal of an address the page left for by itself");
  // A key in the other window is not this window's.
  await app.press("current");
  await web(`void window.open("https://example.com/the-other-window-was-clicked")`);
  await until(() => refusedBrowser() === 3, "the refusal of an address asked for after a key in another window");
  assert.deepEqual(await opened(), []);
  // A new window for an outside address just after the person's key in this window: none is made; the address is for
  // the browser.
  await app.press("local-web");
  await web(`void window.open("https://example.com/docs?from=local-web")`);
  await until(async () => (await opened()).includes("https://example.com/docs?from=local-web"), "the link given to the browser");
  assert.equal(await windowCount(), 2);
  // One key opens one address.
  await web(`void window.open("https://example.com/second-for-one-key")`);
  await until(() => refusedBrowser() === 4, "the refusal of a second address for one key");
  // Leaving the local web by navigation: refused; the address is for the browser too.
  await app.press("local-web");
  await web(`void (location.href = "https://example.org/left")`);
  await until(async () => (await opened()).includes("https://example.org/left"), "the address the page left for, given to the browser");
  // What is not https: goes nowhere: another service of this machine, a file, the device window's own page.
  await app.press("local-web");
  await web(`void window.open("${ELSEWHERE}/window")`);
  await web(`void (location.href = "${ELSEWHERE}/navigation")`);
  await web(`void (location.href = "file:///etc/hosts")`);
  await web(`void (location.href = "/emulator")`);
  await web(`void window.open("/emulator")`);
  await sleep(500);
  assert.equal(await webUrl(), start);
  assert.equal(await windowCount(), 2);
  assert.deepEqual(await opened(), ["https://example.com/docs?from=local-web", "https://example.org/left"]);
  assert.deepEqual(reached.filter((line) => /window|navigation/.test(line)), []);
  assert.match(app.log(), /refused a new window: https:\/\/example\.com\/docs/);
  assert.match(app.log(), /refused a navigation: https:\/\/example\.org\/left/);
  assert.match(app.log(), /refused a navigation: http:\/\/127\.0\.0\.1:\d+\/emulator/);
  // A hidden run and a run under a test give the browser nothing for real; the log says what a release would open.
  assert.match(app.log(), /opened in the browser: https:\/\/example\.com/);
});

test("a window that asks for the browser without end takes nothing from the person's click in the other window", async () => {
  const opened = () => app.run((shell) => shell.opener.opened);
  const before = await opened();
  // The local web's page asks again and again, with the person's keys behind it as well: its own turns run out.
  for (let i = 0; i < 6; i++) {
    await app.press("local-web");
    await web(`void window.open("https://spam.example/${i}")`);
  }
  await web(`for (let i = 0; i < 200; i++) void window.open("https://spam.example/by-itself-" + i)`);
  await until(() => /not opened in the browser, too many in a row: https:\/\/spam\.example/.test(app.log()), "the local web's window out of turns");
  const spam = (await opened()).filter((address) => address.startsWith("https://spam.example/"));
  assert.ok(spam.length >= 1 && spam.length <= 3, `${spam.length} addresses of the spamming window were opened`);
  // The device window's link, clicked by the person at that moment, opens all the same.
  await app.press("current");
  await app.page(`void window.open("https://example.com/the-device-window-link")`);
  await until(async () => (await opened()).includes("https://example.com/the-device-window-link"), "the device window's link given to the browser");
  assert.equal((await opened()).length, before.length + spam.length + 1);
});

test("only an address of the local web gets its window: the device window's other requests for a window get none", async () => {
  await app.run((shell) => shell.windows.closeLocalWeb());
  await until(async () => (await windowCount()) === 1, "the local web's window closed");
  for (const address of ["https://example.net/not-the-local-web", `${ELSEWHERE}/`, `http://localhost:${PORTS.app}/`, `http://${SERVER}/_emu/state`]) {
    await app.page(`void window.open(${JSON.stringify(address)})`);
  }
  await sleep(400);
  assert.equal(await windowCount(), 1);
  assert.equal(await app.run((shell) => shell.windows.localWeb), null);
});

test("without a server there is nothing to show: App Settings does nothing until the server is ready again", async () => {
  const shown = await app.run((shell) => {
    const state = shell.keeper.state;
    // What the menu's item calls, with the server in another state.
    Object.defineProperty(shell.keeper, "state", { configurable: true, get: () => ({ name: "starting" }) });
    try {
      return shell.showAppSettings();
    } finally {
      Object.defineProperty(shell.keeper, "state", { configurable: true, get: () => state });
    }
  });
  assert.equal(shown, false);
  assert.equal(await app.run((shell) => shell.windows.localWeb), null);
});
