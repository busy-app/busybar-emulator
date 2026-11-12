// The security rules of the shell (ADR-0016), one test each, on the device window.
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";

import { PORTS, sleep, until } from "../helpers.mjs";
import { launch, VISIBLE } from "./harness.mjs";

const HOME = `http://127.0.0.1:${PORTS.app}/emulator`;
const ELSEWHERE = `http://127.0.0.1:${PORTS.witness}`;

let app;
let witness;        // an HTTP server that plays "another site" and counts what reaches it
let reached = [];
let udp;            // a UDP socket that counts what reaches it
let packets = 0;

before(async () => {
  witness = createServer((req, res) => {
    reached.push(req.url);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><title>elsewhere</title><p id='elsewhere'>elsewhere</p>");
  });
  await new Promise((resolve) => witness.listen(PORTS.witness, "127.0.0.1", resolve));
  udp = dgram.createSocket("udp4");
  udp.on("message", () => (packets += 1));
  await new Promise((resolve) => udp.bind(PORTS.udp, "127.0.0.1", resolve));
  // With the WebRTC tests switched on, this launch is meant to reach the network.
  app = await launch({ network: process.env.BUSY_EMULATOR_TEST_WEBRTC_OPEN ? "open" : "loopback" });
  await app.waitWindow("device");
});
after(async () => {
  try {
    await app?.close();
  } finally {
    await new Promise((resolve) => witness.close(resolve));
    await new Promise((resolve) => udp.close(resolve));
  }
});
beforeEach(async () => {
  // Every test starts on the device page.
  if ((await currentUrl()) !== HOME) {
    await app.run((shell) => shell.windows.showDevice());
    await until(async () => (await currentUrl()) === HOME && (await app.page("document.readyState")) === "complete", "the device page");
  }
  reached = [];
});

const currentUrl = () => app.run((shell) => shell.windows.current.win.webContents.getURL());
const preferences = () => app.run((shell) => shell.windows.current.win.webContents.getLastWebPreferences());
const windowCount = () => app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length);
const contentsCount = () => app.run((_shell, electron) => electron.webContents.getAllWebContents().length);

test("pages run in the sandbox", async () => {
  assert.equal((await preferences()).sandbox, true);
  const renderers = await app.run((_shell, electron) => electron.app.getAppMetrics().filter((m) => m.type === "Tab").map((m) => m.sandboxed));
  assert.ok(renderers.length >= 1);
  assert.ok(renderers.every((sandboxed) => sandboxed === true), `sandboxed: ${renderers}`);
});

test("context isolation is on", async () => {
  assert.equal((await preferences()).contextIsolation, true);
});

test("pages have no access to Node, in the page and in a worker", async () => {
  const prefs = await preferences();
  assert.deepEqual([prefs.nodeIntegration, prefs.nodeIntegrationInWorker, prefs.nodeIntegrationInSubFrames], [false, false, false]);
  const inPage = await app.page("[typeof process, typeof require, typeof module, typeof Buffer, typeof global, typeof __dirname].join()");
  assert.equal(inPage, "undefined,undefined,undefined,undefined,undefined,undefined");
  const inWorker = await app.page(`new Promise((resolve, reject) => {
    const source = "postMessage([typeof process, typeof require, typeof module, typeof Buffer].join())";
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    worker.onmessage = (e) => resolve(e.data);
    worker.onerror = (e) => reject(new Error(e.message));
  })`);
  assert.equal(inWorker, "undefined,undefined,undefined,undefined");
});

test("<webview> is off: the tag attaches nothing", async () => {
  assert.equal((await preferences()).webviewTag, false);
  const before = await contentsCount();
  const kind = await app.page(`(() => {
    const view = document.createElement("webview");
    view.setAttribute("src", ${JSON.stringify(ELSEWHERE + "/webview")});
    document.body.append(view);
    return Object.getPrototypeOf(view).constructor.name;
  })()`);
  await sleep(700);
  assert.notEqual(kind, "WebViewElement");
  assert.equal(await contentsCount(), before);
  assert.deepEqual(reached, []);
});

test("a page cannot leave for another address: by script, by link, by form, by redirect", async () => {
  const attempts = [
    `location.href = ${JSON.stringify(ELSEWHERE + "/by-script")}`,
    `location.replace(${JSON.stringify(ELSEWHERE + "/by-replace")})`,
    `(() => { const a = document.createElement("a"); a.href = ${JSON.stringify(ELSEWHERE + "/by-link")}; document.body.append(a); a.click(); })()`,
    `(() => { const f = document.createElement("form"); f.action = ${JSON.stringify(ELSEWHERE + "/by-form")}; document.body.append(f); f.submit(); })()`,
    `location.href = "/emulator/go?to=" + encodeURIComponent(${JSON.stringify(ELSEWHERE + "/by-redirect")})`,
    `location.href = "https://example.com/"`,
    `location.href = "file:///etc/hosts"`,
  ];
  for (const attempt of attempts) {
    await app.page(`void (${attempt})`);
    await sleep(400);
    assert.match(await currentUrl(), /^http:\/\/127\.0\.0\.1:\d+\/emulator/, attempt);
    assert.equal(await app.page("document.getElementById('elsewhere') === null"), true, attempt);
  }
  assert.deepEqual(reached, []);
  assert.match(app.log(), /refused a navigation: http:\/\/127\.0\.0\.1:\d+\/by-script/);
});

test("the device window stays on the device page: the rest of the server's address is not its place", async () => {
  await app.page(`void (location.href = "/")`);
  await sleep(400);
  assert.equal(await currentUrl(), HOME);
  // Its own addresses work, so the rule is not simply "nothing moves".
  await app.page(`void (location.href = "/emulator?again=1")`);
  await until(async () => (await currentUrl()) === `${HOME}?again=1`, "a navigation within the device page");
});

test("a frame in the page cannot load another address either", async () => {
  await app.page(`(() => { const f = document.createElement("iframe"); f.src = ${JSON.stringify(ELSEWHERE + "/in-frame")}; document.body.append(f); })()`);
  await sleep(700);
  assert.deepEqual(reached, []);
});

test("new windows are refused: window.open and a link with a target", async () => {
  const opened = await app.page(`window.open(${JSON.stringify(ELSEWHERE + "/opened")}) === null`);
  assert.equal(opened, true);
  await app.page(`document.getElementById("out").click()`);
  await sleep(500);
  assert.equal(await windowCount(), 1);
  assert.equal(await contentsCount(), 1);
  assert.deepEqual(reached, []);
  assert.match(app.log(), /refused a new window: http:\/\/127\.0\.0\.1:\d+\/opened/);
  assert.match(app.log(), /refused a new window: https:\/\/example\.com\//);
});

test("permissions go by the window's list: the device window may write to the clipboard and nothing else", async () => {
  const state = (name) => app.page(`navigator.permissions.query({ name: ${JSON.stringify(name)} }).then((s) => s.state, (e) => "error: " + e.message)`);
  assert.equal(await state("clipboard-write"), "granted");
  for (const name of ["clipboard-read", "geolocation", "notifications", "camera", "microphone", "midi"]) {
    assert.equal(await state(name), "denied", name);
  }
  // Asking, not only querying. The position is not asked for: Chromium gives a page that is not visible (a window
  // covered by another one) no answer at all, so that request says more about the desktop than about the shell.
  const asked = await app.page(`(async () => {
    // An answer that never comes (a system prompt would be one) is a failure of its own, not a hang of the test.
    const late = (ms) => new Promise((resolve) => setTimeout(() => resolve("no answer"), ms));
    const refused = (what, ms = 3000) => Promise.race([what().then(() => "allowed", (e) => e.name), late(ms)]);
    return {
      notification: await Promise.race([Notification.requestPermission(), late(3000)]),
      // The devices get longer: on Windows the first look for a camera took over 3 s once in four runs (the Windows test machine, 11.11).
      microphone: await refused(() => navigator.mediaDevices.getUserMedia({ audio: true }), 10_000),
      camera: await refused(() => navigator.mediaDevices.getUserMedia({ video: true }), 10_000),
      screen: await refused(() => navigator.mediaDevices.getDisplayMedia({ video: true })),
      clipboardRead: await refused(() => navigator.clipboard.readText()),
      midi: await refused(() => navigator.requestMIDIAccess({ sysex: true })),
    };
  })()`);
  // A machine without a camera or a microphone answers "not found" before the permission is asked.
  for (const device of ["microphone", "camera"]) {
    assert.ok(["NotAllowedError", "NotFoundError"].includes(asked[device]), `${device}: ${asked[device]}`);
    delete asked[device];
  }
  assert.deepEqual(asked, {
    notification: "denied",
    screen: "NotAllowedError",
    clipboardRead: "NotAllowedError",
    midi: "NotAllowedError",
  });
});

test("a page that is not one of the shell's windows gets no permission and cannot move", async () => {
  const result = await app.run(async (_shell, electron, home) => {
    const stray = new electron.BrowserWindow({ show: false });
    try {
      await stray.loadURL(home);
      const clipboard = await stray.webContents.executeJavaScript(`navigator.permissions.query({ name: "clipboard-write" }).then((s) => s.state)`, true);
      await stray.webContents.executeJavaScript(`void (location.href = "/emulator?moved=1")`, true);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { clipboard, url: stray.webContents.getURL(), sandbox: stray.webContents.getLastWebPreferences().sandbox };
    } finally {
      stray.destroy();
    }
  }, HOME);
  assert.deepEqual(result, { clipboard: "denied", url: HOME, sandbox: true });
});

test("nothing is downloaded from a page", async () => {
  const downloads = await app.run(async (shell, electron, address) => {
    const seen = [];
    // The item is destroyed once it is canceled, so its end is noted as it happens.
    const note = (_event, item) => {
      const entry = { savedTo: item.getSavePath(), end: null };
      seen.push(entry);
      item.once("done", (_e, state) => (entry.end = state));
    };
    electron.session.defaultSession.on("will-download", note);
    shell.windows.current.win.webContents.downloadURL(address);
    await new Promise((resolve) => setTimeout(resolve, 700));
    electron.session.defaultSession.off("will-download", note);
    return seen;
  }, `${HOME}/file.bin`);
  // From the window's own address, which the network rules let through: what stops it is the rule on downloads.
  assert.deepEqual(downloads, [{ savedTo: "", end: "cancelled" }]);
});

test("a page shows no system dialog: alert and confirm answer at once and show nothing", async () => {
  // The setting first: without it the calls below would put a dialog on the screen of the person at the machine.
  assert.equal((await preferences()).disableDialogs, true);
  const answers = await app.page(`(() => {
    const started = performance.now();
    const answers = [String(alert("from the page")), confirm("from the page")];
    // Electron has no prompt() at all.
    try { prompt("from the page"); answers.push("prompt answered"); } catch (e) { answers.push(e.message); }
    return { answers, ms: performance.now() - started };
  })()`);
  assert.deepEqual(answers.answers, ["undefined", false, "prompt() is not supported."]);
  assert.ok(answers.ms < 1000, `the dialogs took ${answers.ms} ms`);
});

test("spelling is checked nowhere: the windows' session has it off", async () => {
  // The window's own preference (PAGE_PREFERENCES.spellcheck) is not given back by Electron; test/unit/security.test.mjs
  // holds it.
  assert.equal(await app.run((_shell, electron) => electron.session.defaultSession.isSpellCheckerEnabled()), false);
});

test("what a page is refused fills the log only so far", async () => {
  const before = app.log().length;
  // As in the review: thousands of new windows, each with a long address that carries data in its query.
  await app.page(`(() => { const tail = "?secret=" + "s".repeat(1500); for (let i = 0; i < 3000; i++) window.open("https://example.com/flood/" + i + tail); })()`);
  await sleep(300);
  const added = app.log().slice(before);
  assert.ok(added.length < 20_000, `the log grew by ${added.length} characters`);
  assert.match(added, /refused a new window: https:\/\/example\.com\/flood\/0 \(and a query\)/);
  assert.doesNotMatch(added, /secret=/);
});

test("the app's menu is its own, not Electron's: no Help items that open addresses", async () => {
  // menu.mjs, with its own tests: the app's menu (macOS), File, Edit, Bar, Window; on Windows File, Bar and Options;
  // on both Help with Report a Bug… alone, which opens the window's own dialog (EMU-277), not an address.
  const menu = await app.run((_shell, electron) => {
    const all = (items) => items.flatMap((item) => [{ role: item.role ?? null, label: item.label, id: item.id }, ...all(item.submenu?.items ?? [])]);
    const top = electron.Menu.getApplicationMenu().items;
    return { top: top.map((item) => item.role ?? item.label), all: all(top), help: top.at(-1).submenu.items.map((item) => item.id) };
  });
  assert.deepEqual(menu.top, process.platform === "darwin" ? ["BUSY Bar Emulator", "File", "editmenu", "BUSY Bar", "windowmenu", "Help"] : ["File", "BUSY Bar", "Options", "Help"]);
  assert.deepEqual(menu.help, ["report-bug", "emulator-docs", "js-apps-docs"]);
  assert.deepEqual(menu.all.filter((item) => item.role === "help" || (item.label !== "Help" && /help|learn more|documentation|community|search issues/i.test(item.label))), []);
});

test("WebRTC: the window has the rule that closes direct UDP", async () => {
  assert.equal(await app.run((shell) => shell.windows.current.win.webContents.getWebRTCIPHandlingPolicy()), "disable_non_proxied_udp");
});

// The two tests below make a real WebRTC connection, and that reaches outside the app whatever the rule says: as soon
// as a page creates an RTCPeerConnection, Chromium binds UDP port 5353 on every network interface (to hide local
// addresses behind .local names), and while the connection gathers its addresses, two more UDP sockets. The rule
// keeps packets from going out; it does not keep the sockets from being bound. On Windows the firewall asks the
// person at the machine about it. So they are off unless asked for, and no other test creates such a connection.
const webrtcTests = Boolean(process.env.BUSY_EMULATOR_TEST_WEBRTC_OPEN);
const webrtcSkip = !webrtcTests && "set BUSY_EMULATOR_TEST_WEBRTC_OPEN=1: the app then binds UDP sockets on every network interface and the firewall may ask about it";

// A connection that looks for its own addresses through a STUN server on this machine: with direct UDP open, packets
// reach the witness.
const gatherCandidates = () =>
  app.page(`new Promise((resolve) => {
    const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${PORTS.udp}" }] });
    peer.createDataChannel("probe");
    peer.onicegatheringstatechange = () => { if (peer.iceGatheringState === "complete") { peer.close(); resolve("complete"); } };
    peer.createOffer().then((offer) => peer.setLocalDescription(offer));
    setTimeout(() => { peer.close(); resolve("timeout"); }, 4000);
  })`);

test("WebRTC with the rule: no UDP packet leaves for the witness", { skip: webrtcSkip }, async () => {
  packets = 0;
  await gatherCandidates();
  await sleep(300);
  assert.equal(packets, 0, "UDP packets reached the witness with the policy on");
});

test("WebRTC without the rule: the same probe does reach the witness", { skip: webrtcSkip }, async () => {
  await app.run((shell) => shell.windows.current.win.webContents.setWebRTCIPHandlingPolicy("default"));
  try {
    packets = 0;
    await gatherCandidates();
    await until(() => packets > 0, "a UDP packet without the policy", 5000);
  } finally {
    await app.run((shell) => shell.windows.current.win.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"));
  }
});

const clipboardTest = Boolean(process.env.BUSY_EMULATOR_TEST_CLIPBOARD) && VISIBLE;
test("the window can really write to the clipboard", { skip: !clipboardTest && "set BUSY_EMULATOR_TEST_CLIPBOARD=1 and BUSY_EMULATOR_TEST_VISIBLE=1: the test needs a focused window and replaces what is in the system clipboard" }, async () => {
  const before = await app.run((_shell, electron) => electron.clipboard.readText());
  try {
    await app.run((shell) => shell.windows.current.win.focus());
    assert.equal(await app.page(`navigator.clipboard.writeText("busy-app-test").then(() => "written", (e) => e.name)`), "written");
    assert.equal(await app.run((_shell, electron) => electron.clipboard.readText()), "busy-app-test");
  } finally {
    await app.run((_shell, electron, text) => electron.clipboard.writeText(text), before);
  }
});

// Last in the file: it ends the app. A page that answers "beforeunload" (after one click of a person in it) must not
// hold Quit up: before the rule, Quit stopped the server and the window then refused to close, leaving the app running.
test("a page cannot hold Quit up", async () => {
  await app.page(`void (window.onbeforeunload = (event) => { event.preventDefault(); event.returnValue = "stay"; return "stay"; })`);
  await app.run((shell) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
  });
  await sleep(300);
  const ended = await Promise.race([app.quit(), sleep(10_000).then(() => "still running")]);
  assert.notEqual(ended, "still running");
});
