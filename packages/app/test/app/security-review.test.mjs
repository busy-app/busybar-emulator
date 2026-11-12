// Tests from the security review of EMU-201 (11.11), taken into the suite by EMU-236. Changed from the review's file
// in one place: the test of S1 no longer makes a WebRTC connection to a TURN server over TCP. The page has no
// RTCPeerConnection now (page-preload.cjs), so the review's code stops there; and a connection made some other way
// would bind UDP sockets on every network interface, which the suite does not do (security.test.mjs). What closed that
// path in the review — the proxy of the session — is checked address by address in network.test.mjs.
//
//   S1  "the window reaches no address but the server's own"         failed on the reviewed branch
//   S2  "a page cannot keep the window from closing"                 failed on the reviewed branch
//   S8  "a frame that is not the window's origin gets no permission"   passed; fails when the origin check in
//       security.mjs (originOf(requester) === registry.originOf(contents)) is taken out — no other test does
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import { PORTS, sleep, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const ELSEWHERE = `http://127.0.0.1:${PORTS.witness}`;

let app;
let witness; // "another service on this machine", over HTTP
let reached = [];

before(async () => {
  witness = createServer((req, res) => {
    reached.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("elsewhere");
  });
  await new Promise((resolve) => witness.listen(PORTS.witness, "127.0.0.1", resolve));
  app = await launch();
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

// S8. Holds the rule "only for the window's own origin: a frame from elsewhere inherits nothing".
test("a frame that is not the window's origin gets no permission, not even the one the window has", async () => {
  const states = await app.page(`(async () => {
    const ask = "navigator.permissions.query({ name: 'clipboard-write' }).then((s) => s.state, (e) => 'error ' + e.name)";
    const inFrame = (attributes) => new Promise((resolve) => {
      const frame = Object.assign(document.createElement("iframe"), attributes);
      const hear = (message) => { if (message.source === frame.contentWindow) { removeEventListener("message", hear); resolve(message.data); } };
      addEventListener("message", hear);
      frame.srcdoc = "<script>" + ask + ".then((state) => parent.postMessage(state, '*'))<\\/script>";
      document.body.append(frame);
      setTimeout(() => resolve("no answer"), 3000);
    });
    return { page: await eval(ask), sameOrigin: await inFrame({}), otherOrigin: await inFrame({ sandbox: "allow-scripts" }), otherOriginDelegated: await inFrame({ sandbox: "allow-scripts", allow: "clipboard-write" }) };
  })()`);
  assert.deepEqual(states, { page: "granted", sameOrigin: "granted", otherOrigin: "denied", otherOriginDelegated: "denied" });
});

// S1. The page of the window talks to the server it came from and to nothing else: not to another port of this
// machine, not by its name, not over WebSocket, and it has no WebRTC to go around the rules with.
test("the window reaches no address but the server's own: fetch, image, beacon, WebSocket; and it has no WebRTC", async () => {
  reached = [];
  const own = await app.page(`fetch("/api/status").then((answer) => answer.status)`);
  assert.equal(own, 200, "the window's own server must stay reachable");
  await app.page(`(async () => {
    const late = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const quiet = (promise) => Promise.race([promise.catch(() => {}), late(2000)]);
    await quiet(fetch("${ELSEWHERE}/fetch", { mode: "no-cors" }));
    await quiet(fetch("http://localhost:${PORTS.witness}/fetch-by-name", { mode: "no-cors" }));
    await quiet(new Promise((resolve) => { const image = new Image(); image.onload = image.onerror = resolve; image.src = "${ELSEWHERE}/image"; }));
    navigator.sendBeacon("${ELSEWHERE}/beacon", "x");
    await quiet(new Promise((resolve) => { const socket = new WebSocket("ws://127.0.0.1:${PORTS.witness}/websocket"); socket.onopen = socket.onerror = resolve; }));
  })()`);
  await sleep(300);
  assert.deepEqual(reached, [], "requests from the window's page reached another service on this machine");
  assert.equal(await app.page("typeof RTCPeerConnection"), "undefined");
});

// S2. Last in the file: it closes the window. After one click of a person in the page, a page that answers
// "beforeunload" kept the window open, and Quit then stopped the server and left the app running.
test("a page cannot keep the window from closing", async () => {
  await app.page(`void (window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = "stay"; return "stay"; })`);
  await app.run((shell) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
  });
  await sleep(300);
  await app.run((shell) => void shell.windows.current.win.close());
  // On Windows the last window closed is a quit (main.mjs): the app ending counts as the window closing.
  const ended = app.exited.then(() => true);
  const closed = () => Promise.race([ended, app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length === 0).catch(() => ended)]);
  try {
    await until(closed, "the window to close", 3000);
  } finally {
    // Whatever the outcome, the app must be able to quit when the suite ends.
    await Promise.race([ended, app.run((_shell, electron) => { for (const win of electron.BrowserWindow.getAllWindows()) win.destroy(); })]).catch(() => {});
  }
});
