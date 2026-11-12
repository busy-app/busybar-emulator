// The window's network is closed by default (ADR-0016): the page of the device window reaches the server it came
// from and nothing else. Two lines hold it, and each is tested alone here: the proxy of the session, which WebRTC
// keeps to as well, and the rule on requests. (The test with both is in security-review.test.mjs.)
//
// No test here creates an RTCPeerConnection: that alone makes Chromium bind UDP sockets on every network interface,
// and the system may ask the person at the machine about it (security.test.mjs, the WebRTC tests). That the proxy
// keeps WebRTC's TURN over TCP away was shown by the security review of EMU-201 on this Electron; here the proxy
// setting it relies on is checked, address by address.
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { closedNetwork } from "../../src/security.mjs";
import { PORTS, sleep } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const SERVER = `127.0.0.1:${PORTS.app}`;
const ELSEWHERE = `http://127.0.0.1:${PORTS.witness}`;

let app;
let witness; // "another service on this machine"
let reached = [];
let udp; // another program holding UDP on the server's port number
let datagrams = [];

before(async () => {
  witness = createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("elsewhere");
  });
  await new Promise((resolve) => witness.listen(PORTS.witness, "127.0.0.1", resolve));
  udp = dgram.createSocket("udp4");
  udp.on("message", (message) => datagrams.push(message.length));
  await new Promise((resolve) => udp.bind(PORTS.app, "127.0.0.1", resolve));
  app = await launch();
  await app.waitWindow("device");
});
after(async () => {
  try {
    await app?.close();
  } finally {
    witness.closeAllConnections();
    await new Promise((resolve) => witness.close(resolve));
    await new Promise((resolve) => udp.close(resolve));
  }
});

/** What a page could try, each with a name in its address, so that a failure says which one got through. */
const tryEverything = (tag) =>
  app.page(`(async () => {
    const late = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const quiet = (promise) => Promise.race([promise.catch(() => {}), late(2000)]);
    await quiet(fetch("${ELSEWHERE}/${tag}-fetch", { mode: "no-cors" }));
    await quiet(fetch("http://localhost:${PORTS.witness}/${tag}-by-name", { mode: "no-cors" }));
    await quiet(new Promise((resolve) => { const image = new Image(); image.onload = image.onerror = resolve; image.src = "${ELSEWHERE}/${tag}-image"; }));
    navigator.sendBeacon("${ELSEWHERE}/${tag}-beacon", "x");
    await quiet(new Promise((resolve) => { const socket = new WebSocket("ws://127.0.0.1:${PORTS.witness}/${tag}-websocket"); socket.onopen = socket.onerror = resolve; }));
    await late(300);
  })()`);

const resolveProxy = (address) => app.run((_shell, electron, url) => electron.session.defaultSession.resolveProxy(url), address);

test("the proxy of the window's session lets the server's address through and sends everything else nowhere", async () => {
  // The bypass names the server's schemes: https: and wss: to its port go nowhere as well.
  for (const address of [`http://${SERVER}/emulator`, `ws://${SERVER}/api/status/ws`]) assert.equal(await resolveProxy(address), "DIRECT", address);
  for (const address of [
    `${ELSEWHERE}/`,
    `ws://127.0.0.1:${PORTS.witness}/`,
    `http://localhost:${PORTS.app}/`,
    `http://[::1]:${PORTS.app}/`,
    `https://${SERVER}/`,
    `wss://${SERVER}/`,
    "https://api.iconify.design/lucide.json?icons=x",
    "http://192.0.2.1/",
    // How WebRTC asks for a TURN server over TCP (the review's witness got 140 bytes without this setting).
    `https://127.0.0.1:${PORTS.udp}/`,
  ]) {
    assert.equal(await resolveProxy(address), "PROXY 127.0.0.1:0", address);
  }
});

// From the security review of EMU-236 (M1): with an exception by host and port alone, the page's WebTransport (QUIC
// over UDP, which the rule on requests does not see) reached another program's UDP socket on the server's port number.
test("WebTransport to the server's port number reaches nothing but the server", async () => {
  datagrams = [];
  await app.page(`(async () => {
    const transport = new WebTransport("https://127.0.0.1:${PORTS.app}/out");
    await Promise.race([transport.ready.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 2000))]);
  })()`);
  await sleep(300);
  assert.deepEqual(datagrams, [], "QUIC packets reached another program's UDP socket on the server's port number");
});

// From the security review of EMU-236 (M2): <link rel=dns-prefetch> made Chromium ask the system's resolver for a name
// the page chose — data out as DNS queries, with no script and under any content policy. The name is under
// example.com; resolving it is all that would happen. Chromium's own network log says whether the resolver was asked.
test("a page's dns-prefetch makes no DNS query", async () => {
  const name = `emu236-${process.pid}-${Date.now()}.example.com`;
  const file = path.join(os.tmpdir(), `busy-app-netlog-${process.pid}.json`);
  await app.run((_shell, electron, to) => electron.session.defaultSession.netLog.startLogging(to), file);
  await app.page(`(async () => { const link = document.createElement("link"); link.rel = "dns-prefetch"; link.href = "http://${name}/"; document.head.append(link); await new Promise((resolve) => setTimeout(resolve, 2500)); })()`);
  await app.run((_shell, electron) => electron.session.defaultSession.netLog.stopLogging());
  const log = JSON.parse(readFileSync(file, "utf8"));
  rmSync(file, { force: true });
  const types = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([type, number]) => [number, type]));
  const sources = new Set(log.events.filter((event) => JSON.stringify(event.params ?? {}).includes(name)).map((event) => event.source.id));
  const kinds = new Set(log.events.filter((event) => sources.has(event.source.id)).map((event) => types[event.type]));
  assert.ok(log.events.length > 0, "the network log is empty");
  assert.ok(!kinds.has("HOST_RESOLVER_SYSTEM_TASK") && !kinds.has("HOST_RESOLVER_DNS_TASK"), `the resolver was asked for ${name}: ${[...kinds].join(", ")}`);
  assert.match(await app.run((_shell, electron) => electron.app.commandLine.getSwitchValue("host-resolver-rules")), /^MAP \* ~NOTFOUND, EXCLUDE 127\.0\.0\.1$/);
});

test("the page has no WebRTC: its constructors are gone before the page's own scripts run", async () => {
  assert.deepEqual(await app.page("[typeof RTCPeerConnection, typeof webkitRTCPeerConnection]"), ["undefined", "undefined"]);
  // The preload that does it is the only one the session has, and it gives the page nothing (window.test.mjs).
  const preloads = await app.run((_shell, electron) => electron.session.defaultSession.getPreloadScripts().map((p) => ({ id: p.id, type: p.type, file: p.filePath.split(/[\\/]/).pop() })));
  assert.deepEqual(preloads, [{ id: "busy-emulator-page", type: "frame", file: "page-preload.cjs" }]);
  // mDNS of WebRTC, which binds UDP port 5353 on every interface as soon as a connection is made, is off for the app.
  assert.match(await app.run((_shell, electron) => electron.app.commandLine.getSwitchValue("disable-features")), /(^|,)WebRtcHideLocalIpsWithMdns(,|$)/);
});

test("a service worker cannot be registered on the server's origin", async () => {
  const outcome = await app.page(`navigator.serviceWorker.register("/emulator/worker.js", { scope: "/emulator/" }).then(() => "registered", (e) => e.name)`);
  assert.notEqual(outcome, "registered");
  assert.equal(await app.page("navigator.serviceWorker.getRegistrations().then((all) => all.length)"), 0);
  assert.match(app.log(), /refused a service worker: http:\/\/127\.0\.0\.1:\d+\/emulator\/worker\.js/);
});

test("a session the shell did not name is closed entirely and has the same handlers", async () => {
  const stray = await app.run(async (_shell, electron, server) => {
    const ses = electron.session.fromPartition("busy-test-stray");
    // The handlers come as the session is made; give them a moment, as a window made right after would.
    await new Promise((resolve) => setTimeout(resolve, 300));
    ses.protocol.handle("app", () => new Response("<!doctype html><title>stray</title>", { headers: { "content-type": "text/html" } }));
    const win = new electron.BrowserWindow({ show: false, webPreferences: { partition: "busy-test-stray", sandbox: true, contextIsolation: true } });
    try {
      await win.loadURL("app://stray/");
      return {
        server: await ses.resolveProxy(`http://${server}/emulator`),
        clipboard: await win.webContents.executeJavaScript(`navigator.permissions.query({ name: "clipboard-write" }).then((s) => s.state)`, true),
        spellcheck: ses.isSpellCheckerEnabled(),
        preloads: ses.getPreloadScripts().length,
        webrtc: await win.webContents.executeJavaScript("typeof RTCPeerConnection", true),
      };
    } finally {
      win.destroy();
      ses.protocol.unhandle("app");
    }
  }, SERVER);
  assert.deepEqual(stray, { server: "PROXY 127.0.0.1:0", clipboard: "denied", spellcheck: false, preloads: 1, webrtc: "undefined" });
});

test("the rule on requests alone keeps the page from the witness, and says so in the log", async () => {
  await app.run((_shell, electron) => electron.session.defaultSession.setProxy({ mode: "direct" }));
  try {
    reached = [];
    await tryEverything("rule-alone");
    await sleep(300);
    assert.deepEqual(reached, [], "with the proxy direct, requests reached another service on this machine");
    assert.match(app.log(), /refused a request: http:\/\/127\.0\.0\.1:\d+\/rule-alone-fetch/);
    assert.match(app.log(), /refused a request: ws:\/\/127\.0\.0\.1:\d+\/rule-alone-websocket/);
  } finally {
    await app.run((_shell, electron, config) => electron.session.defaultSession.setProxy(config), closedNetwork([SERVER]));
  }
  assert.equal(await resolveProxy(`${ELSEWHERE}/`), "PROXY 127.0.0.1:0");
});

// Last in the file: it takes the rule on requests away for good.
test("the proxy alone keeps the page from the witness", async () => {
  await app.run((_shell, electron) => {
    electron.session.defaultSession.webRequest.onBeforeRequest(null);
    electron.session.defaultSession.webRequest.onBeforeSendHeaders(null);
  });
  reached = [];
  const before = app.log().length;
  await tryEverything("proxy-alone");
  await sleep(300);
  assert.deepEqual(reached, [], "with the rule on requests gone, requests reached another service on this machine");
  // The rule really was gone: it did not refuse these.
  assert.doesNotMatch(app.log().slice(before), /proxy-alone/);
  // The page still has its own server.
  assert.equal(await app.page(`fetch("/api/status").then((answer) => answer.status)`), 200);
});
