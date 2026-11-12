import assert from "node:assert/strict";
import { test } from "node:test";

import { readFileSync } from "node:fs";

import { gestureFor, NO_GESTURE_NEEDED, WINDOW_ACTIONS } from "../../src/actions.mjs";
import { CAPTURE_ACTIONS } from "../../src/capture-actions.mjs";
import { ACTIONS, BridgeRefusal, createBridge, MENU_ACTION_NAMES, NO_GESTURE } from "../../src/bridge.mjs";
import { CHAIN_MAX, createGestures } from "../../src/gestures.mjs";
import { REPORT_ACTIONS, REPORT_NO_GESTURE } from "../../src/report-actions.mjs";

const SERVER = "http://127.0.0.1:8640";
const OWN = ["message.get", "server.retry", "app.quit"];
const TERMINAL = ["terminal.info", "terminal.open"];
const MENU = ["menu.get", "menu.run"];
const UPDATE = ["update.state", "update.download", "update.restart", "update.popup"];

function setup() {
  const done = [];
  const lines = [];
  const shell = { currentMessage: () => ({ title: "t" }), retry: () => done.push("retry"), quit: () => done.push("quit"), actions: { call: (name, arg) => (done.push([name, arg]), { ok: true, value: name }) } };
  // A page of the shell in the message window, calling from its top frame.
  const frame = { origin: "app://shell" };
  const sender = { mainFrame: frame, kind: "message" };
  // A person who has always just clicked, unless a test brings its own.
  const bridge = createBridge({ shell, kindOf: (contents) => contents.kind, log: (line) => lines.push(line), serverOrigin: SERVER, gestures: { allow: () => true } });
  return { bridge, done, lines, shell, event: { sender, senderFrame: frame } };
}

/** The same, called by the device window's page from its top frame. */
function fromDevice() {
  const all = setup();
  const frame = { origin: SERVER };
  return { ...all, event: { sender: { mainFrame: frame, kind: "device" }, senderFrame: frame } };
}

test("the list of actions is exactly these: three for the shell's own page only, and the actions on app projects the console's terminal the canvas's tools and the title bar's menu for the device window's page only", () => {
  assert.deepEqual(MENU_ACTION_NAMES, MENU);
  assert.deepEqual(Object.keys(ACTIONS), [...OWN, ...WINDOW_ACTIONS, ...TERMINAL, ...CAPTURE_ACTIONS, ...REPORT_ACTIONS, ...MENU, ...UPDATE]);
  // The built-in update's: where it stands reads only; Update and Restart are the person's clicks.
  assert.deepEqual(UPDATE.map((name) => [ACTIONS[name].pages.map((page) => page.kind), ACTIONS[name].takes, ACTIONS[name].gesture]), [[["device"], undefined, undefined], [["device"], undefined, true], [["device"], undefined, true], [["device"], undefined, undefined]]);
  // Report a Bug's: the preview reads only; the browser, the clipboard and the Save dialog are the person's doing.
  assert.deepEqual(REPORT_ACTIONS.map((name) => [name, ACTIONS[name].pages.map((page) => page.kind), ACTIONS[name].takes, ACTIONS[name].gesture]), REPORT_ACTIONS.map((name) => [name, ["device"], 1, !REPORT_NO_GESTURE.includes(name)]));
  // The title bar's: the menu reads only; pressing an item of it is the person's doing, as in the system's menu.
  assert.deepEqual(MENU.map((name) => [ACTIONS[name].pages.map((page) => page.kind), ACTIONS[name].takes, ACTIONS[name].gesture]), [[["device"], undefined, undefined], [["device"], 1, true]]);
  for (const name of TERMINAL) assert.deepEqual(ACTIONS[name].pages.map((page) => page.kind), ["device"], name);
  assert.deepEqual([ACTIONS["terminal.info"].takes, ACTIONS["terminal.info"].gesture, ACTIONS["terminal.open"].takes, ACTIONS["terminal.open"].gesture], [undefined, undefined, 1, true]);
  for (const name of OWN) assert.deepEqual(ACTIONS[name].pages, [{ kind: "message", origin: "app://shell" }]);
  for (const name of [...WINDOW_ACTIONS, ...CAPTURE_ACTIONS]) assert.deepEqual([ACTIONS[name].pages.map((page) => page.kind), ACTIONS[name].takes], [["device"], 1], name);
  assert.deepEqual(WINDOW_ACTIONS, ["projects.list", "projects.examples", "projects.place", "projects.place.choose", "projects.create", "projects.open", "projects.find", "projects.import", "projects.refresh", "projects.dependencies", "projects.dependencies.auto", "projects.build", "projects.run", "projects.stop", "projects.dev.start", "projects.dev.stop", "projects.check", "projects.submit", "projects.package.install", "apps.delete", "publish.status", "publish.check", "publish.texts", "publish.icon", "publish.screenshots", "publish.readme", "publish.license", "publish.files", "publish.package", "github.status", "github.signin", "github.use", "github.signin.wait", "github.signin.cancel", "github.code.open", "github.signout", "github.name", "github.push", "github.cancel", "github.checklist", "github.request", "github.entry", "github.lookup", "github.import", "github.release.install", "reveal", "open", "copy", "browse", "welcome.get", "welcome.seen"]);
  // No action is about trust or answers a question of the app's: that is the dialog's alone.
  assert.deepEqual(Object.keys(ACTIONS).filter((name) => /trust|ask|answer|dialog/i.test(name)), []);
  // The page's half of the contract calls exactly these names.
  const page = readFileSync(new URL("../../../server/legacy-window/actions.js", import.meta.url), "utf8");
  assert.deepEqual([...page.matchAll(/call\("([a-z.]+)"/g)].map((match) => match[1]).sort(), [...WINDOW_ACTIONS, ...TERMINAL, ...CAPTURE_ACTIONS, ...REPORT_ACTIONS, ...UPDATE].sort());
});

test("the device window's page may call the actions on app projects, with one argument at most; the shell's own three are not its", async () => {
  const { bridge, done, lines, event } = fromDevice();
  assert.deepEqual(bridge(event, "projects.list"), { ok: true, value: "projects.list" });
  assert.deepEqual(await bridge(event, "projects.build", "/a project"), { ok: true, value: "projects.build" });
  assert.deepEqual(done, [["projects.list", undefined], ["projects.build", "/a project"]]);
  assert.throws(() => bridge(event, "projects.build", "/a project", "--trust"), BridgeRefusal);
  for (const name of OWN) assert.throws(() => bridge(event, name), BridgeRefusal, name);
  assert.equal(done.length, 2);
  assert.match(lines[0], /refused "projects\.build" from http:\/\/127\.0\.0\.1:8640: unexpected arguments/);
});

test("an action with consequences needs the person's click or key in that window just before; reading the list, the examples and the greeting's facts needs none", async () => {
  const { shell, done, lines, event } = fromDevice();
  let time = 1_000_000;
  const gestures = createGestures({ now: () => time });
  const bridge = createBridge({ shell, kindOf: (contents) => contents.kind, log: (line) => lines.push(line), serverOrigin: SERVER, gestures });
  const withConsequences = WINDOW_ACTIONS.filter((name) => !NO_GESTURE_NEEDED.includes(name));
  assert.deepEqual(withConsequences, ["projects.place.choose", "projects.create", "projects.open", "projects.find", "projects.import", "projects.refresh", "projects.dependencies", "projects.build", "projects.run", "projects.stop", "projects.dev.start", "projects.dev.stop", "projects.check", "projects.submit", "projects.package.install", "apps.delete", "publish.texts", "publish.icon", "publish.screenshots", "publish.readme", "publish.license", "publish.files", "publish.package", "github.signin", "github.use", "github.code.open", "github.signout", "github.push", "github.request", "github.import", "github.release.install", "reveal", "open", "copy", "browse", "welcome.seen"]);
  for (const name of WINDOW_ACTIONS) assert.equal(ACTIONS[name].gesture, name === "publish.files" ? gestureFor(name) : withConsequences.includes(name), name);
  // Repository files: reading the plan needs no click; writing, keeping out or in, replacing the README does.
  const files = ACTIONS["publish.files"].gesture;
  assert.deepEqual([files({ folder: "/p" }), files({ folder: "/p", write: undefined, keepOut: undefined, keepIn: undefined, readme: undefined }), files({ folder: "/p", write: false })], [false, false, false]);
  assert.deepEqual([files({ folder: "/p", write: true }), files({ folder: "/p", keepOut: "a" }), files({ folder: "/p", keepIn: "a" }), files({ folder: "/p", readme: "replace" }), files(undefined), files("/p")], [true, true, true, true, true, true]);
  assert.deepEqual(await bridge(event, "publish.files", { folder: "/p" }), { ok: true, value: "publish.files" });
  done.length = 0;

  // No input ever: script alone gets none of them, and is told so in an answer with a code.
  for (const name of withConsequences) assert.equal(await bridge(event, name, "/a project"), NO_GESTURE, name);
  assert.deepEqual(NO_GESTURE, { ok: false, error: { code: "no_gesture", message: "The app does this only just after a click or a key in its window.", hint: null } });
  assert.deepEqual(done, []);
  assert.match(lines[0], /bridge: projects\.place\.choose not done, no click or key in the window just before/);
  for (const name of NO_GESTURE_NEEDED) assert.deepEqual(bridge(event, name), { ok: true, value: name });

  // Moving the pointer and the wheel are no gesture; a click in another window is not this window's.
  gestures.input(event.sender, "mouseMove");
  gestures.input(event.sender, "mouseWheel");
  gestures.input({ another: "window" }, "mouseDown");
  assert.equal(await bridge(event, "copy", "x"), NO_GESTURE);
  // A click: the action runs; two seconds later a new action needs a new click.
  gestures.input(event.sender, "mouseDown");
  time += 1500;
  assert.deepEqual(await bridge(event, "projects.refresh", "/a project"), { ok: true, value: "projects.refresh" });
  time += 2001;
  assert.equal(await bridge(event, "projects.build", "/a project"), NO_GESTURE);

  // One gesture carries a short chain, all of it within two seconds of the click: an action that still runs a minute
  // later gives the page no right to start another (finding C1 of the audit). Build and package is one action for that reason.
  let finish;
  shell.actions.call = (name) => (name === "projects.check" ? new Promise((resolve) => (finish = () => resolve({ ok: true, value: name }))) : { ok: true, value: name });
  gestures.input(event.sender, "keyDown");
  const checking = bridge(event, "projects.check", "/a project");
  time += 1500;
  assert.deepEqual(await bridge(event, "projects.submit", "/a project"), { ok: true, value: "projects.submit" }, "within the two seconds");
  time += 60_000;
  await Promise.resolve();
  for (const name of ["apps.delete", "github.request", "copy"]) assert.equal(await bridge(event, name, "/a project"), NO_GESTURE, `${name}, a minute later while the check still runs`);
  time += 9 * 60_000;
  assert.equal(await bridge(event, "reveal", "/a project"), NO_GESTURE, "ten minutes later");
  finish();
  await checking;
  assert.equal(await bridge(event, "reveal", "/a project"), NO_GESTURE, "nor when it has ended");
  gestures.input(event.sender, "keyDown");
  const answers = [];
  for (let n = 0; n < CHAIN_MAX + 2; n++) answers.push((await bridge(event, "copy", "x")).ok);
  assert.deepEqual(answers, [true, true, true, true, false, false]);
  // An action that fails ends its turn in the chain too.
  gestures.input(event.sender, "keyDown");
  shell.actions.call = () => Promise.reject(new Error("failed"));
  await assert.rejects(bridge(event, "copy", "x"));
  shell.actions.call = (name) => ({ ok: true, value: name });
  time += 2001;
  assert.equal(await bridge(event, "copy", "x"), NO_GESTURE);
  // A bridge without the gestures allows none.
  const without = createBridge({ shell, kindOf: (contents) => contents.kind, log: () => {}, serverOrigin: SERVER });
  assert.equal(await without(event, "copy", "x"), NO_GESTURE);
});

test("the actions on app projects are refused for every caller but the top frame of the device window at the server's address", () => {
  const callers = {
    "the local web's window, at the same address": (e) => (e.sender.kind = "local-web"),
    "the shell's message window": (e) => (e.sender.kind = "message"),
    "the shell's own page": (e) => ((e.sender.kind = "message"), (e.senderFrame.origin = "app://shell")),
    "a window of no kind": (e) => (e.sender.kind = null),
    "another port of this computer in the device window": (e) => (e.senderFrame.origin = "http://127.0.0.1:8641"),
    "the same port under another name": (e) => (e.senderFrame.origin = "http://localhost:8640"),
    "a page of the network": (e) => (e.senderFrame.origin = "https://example.com"),
    "no origin": (e) => (e.senderFrame.origin = "null"),
    "a frame inside the page": (e) => (e.senderFrame = { origin: SERVER }),
    "a frame that is gone": (e) => (e.senderFrame = null),
  };
  for (const [who, change] of Object.entries(callers)) {
    const { bridge, done, event } = fromDevice();
    change(event);
    for (const name of WINDOW_ACTIONS) assert.throws(() => bridge(event, name, "/a project"), BridgeRefusal, `${who}: ${name}`);
    assert.deepEqual(done, [], who);
  }
  // A bridge that was not told the server's address takes the device window for no page at all.
  const { event } = fromDevice();
  const untold = createBridge({ shell: { actions: { call: () => assert.fail("must not run") } }, kindOf: (contents) => contents.kind, log: () => {} });
  assert.throws(() => untold(event, "projects.list"), BridgeRefusal);
  event.senderFrame.origin = "the server's";
  assert.throws(() => untold(event, "projects.list"), BridgeRefusal, "the placeholder of the list is no origin a page can have");
});

test("the shell's page in the message window may call them", () => {
  const { bridge, done, event } = setup();
  assert.deepEqual(bridge(event, "message.get"), { title: "t" });
  assert.equal(bridge(event, "server.retry"), undefined);
  assert.equal(bridge(event, "app.quit"), undefined);
  assert.deepEqual(done, ["retry", "quit"]);
});

test("a call from any other page is refused and nothing runs", () => {
  const callers = {
    "another origin in the message window": (e) => (e.senderFrame.origin = "http://127.0.0.1:8640"),
    "the same host under another scheme": (e) => (e.senderFrame.origin = "https://shell"),
    "no origin": (e) => (e.senderFrame.origin = "null"),
    "the shell's page in a window of another kind": (e) => (e.sender.kind = "device"),
    "a window of no kind": (e) => (e.sender.kind = null),
    "a frame inside the page": (e) => (e.senderFrame = { origin: "app://shell" }),
    "a frame that is gone": (e) => (e.senderFrame = null),
  };
  for (const [who, change] of Object.entries(callers)) {
    const { bridge, done, lines, event } = setup();
    change(event);
    for (const name of OWN) assert.throws(() => bridge(event, name), BridgeRefusal, `${who}: ${name}`);
    assert.deepEqual(done, [], who);
    assert.equal(lines.length, 3, who);
    assert.match(lines[0], /^\[shell\] bridge: refused "message\.get" from /);
  }
});

test("an unknown action, a name that is not a string and unexpected arguments are refused", () => {
  const { bridge, done, event } = setup();
  for (const name of ["nope", "constructor", "__proto__", "toString", "", null, undefined, 7, {}, ["app.quit"]]) {
    assert.throws(() => bridge(event, name), BridgeRefusal, String(name));
  }
  assert.throws(() => bridge(event, "app.quit", "now"), BridgeRefusal);
  assert.throws(() => bridge(event, "server.retry", {}), BridgeRefusal);
  assert.deepEqual(done, []);
});

test("the refusal tells the page nothing about why", () => {
  const { bridge, event } = setup();
  event.senderFrame.origin = "http://127.0.0.1:8640";
  assert.throws(() => bridge(event, "app.quit"), { message: "This page may not ask the app for that." });
});

test("the console's terminal: opening it needs the person's click in the device window, and goes to the shell's terminal with its one argument; whether there is one reads only", async () => {
  const { shell, lines, event } = fromDevice();
  const asked = [];
  shell.terminal = { info: () => ({ ok: true, value: { available: true } }), open: (arg) => (asked.push(arg), { ok: true, value: { opened: "Terminal" } }) };
  let time = 1_000_000;
  const gestures = createGestures({ now: () => time });
  const bridge = createBridge({ shell, kindOf: (contents) => contents.kind, log: (line) => lines.push(line), serverOrigin: SERVER, gestures });
  const wanted = { app: null, folder: "/p/one", kinds: ["console", "lifecycle"], since: 5 };
  assert.deepEqual(bridge(event, "terminal.info"), { ok: true, value: { available: true } });
  assert.throws(() => bridge(event, "terminal.info", "x"), BridgeRefusal);
  assert.equal(await bridge(event, "terminal.open", wanted), NO_GESTURE);
  assert.deepEqual(asked, []);
  gestures.input(event.sender, "mouseDown");
  assert.deepEqual(await bridge(event, "terminal.open", wanted), { ok: true, value: { opened: "Terminal" } });
  assert.deepEqual(asked, [wanted]);
  assert.throws(() => bridge(event, "terminal.open", wanted, "more"), BridgeRefusal);
  // Not the shell's own page, not a frame.
  const own = setup();
  own.shell.terminal = shell.terminal;
  assert.throws(() => own.bridge(own.event, "terminal.open", wanted), BridgeRefusal);
  const frame = { origin: SERVER };
  assert.throws(() => bridge({ sender: { mainFrame: { origin: SERVER }, kind: "device" }, senderFrame: frame }, "terminal.open", wanted), BridgeRefusal);
  assert.equal(asked.length, 1);
});

test("the title bar's menu: the device window's page reads it freely; it presses an item only just after the person's click or key; the shell's own page has neither", async () => {
  const { shell, lines, event } = fromDevice();
  const pressed = [];
  shell.titleBar = { menu: () => ({ ok: true, value: { titleBar: true, menus: [] } }), run: (id) => (pressed.push(id), { ok: true, value: null }) };
  const gestures = createGestures();
  const bridge = createBridge({ shell, kindOf: (contents) => contents.kind, log: (line) => lines.push(line), serverOrigin: SERVER, gestures });
  assert.deepEqual(bridge(event, "menu.get"), { ok: true, value: { titleBar: true, menus: [] } });
  assert.throws(() => bridge(event, "menu.get", "more"), BridgeRefusal);
  assert.equal(await bridge(event, "menu.run", "new-app"), NO_GESTURE);
  assert.deepEqual(pressed, []);
  gestures.input(event.sender, "mouseUp");
  assert.deepEqual(await bridge(event, "menu.run", "new-app"), { ok: true, value: null });
  assert.deepEqual(pressed, ["new-app"]);
  assert.throws(() => bridge(event, "menu.run", "new-app", "more"), BridgeRefusal);
  const message = setup();
  message.shell.titleBar = shell.titleBar;
  for (const name of MENU) assert.throws(() => message.bridge(message.event, name), BridgeRefusal, name);
  assert.deepEqual(pressed, ["new-app"]);
});
