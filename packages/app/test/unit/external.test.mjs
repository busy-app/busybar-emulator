// What the shell gives to the user's browser, and how much of it (EMU-209, EMU-205).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createOpener, externalAddress, GESTURE_MS, isGesture, MAX_OPENS, OPENS_WINDOW_MS } from "../../src/external.mjs";
import { REFUSALS_PER_MINUTE } from "../../src/log.mjs";

test("only an https: address without a user name goes to the browser", () => {
  assert.equal(externalAddress("https://github.com/busy-app/busybar-emulator/releases/tag/v0.2.0"), "https://github.com/busy-app/busybar-emulator/releases/tag/v0.2.0");
  assert.equal(externalAddress("https://busy.app"), "https://busy.app/");
  for (const address of ["http://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "smb://server/share", "ms-settings:", "busy-emulator://x", "https://user:secret@example.com/", "https://", "", null, undefined, "C:\\Windows\\System32\\calc.exe"]) {
    assert.equal(externalAddress(address), null, String(address));
  }
});

/** An opener with a clock a test moves, and what it gave the system and wrote down. */
function setup({ open = null } = {}) {
  const given = [];
  const lines = [];
  const clock = { now: 1_000_000 };
  const opener = createOpener({ open: open ?? ((address) => given.push(address)), log: (line) => lines.push(line), now: () => clock.now });
  /** The person clicks in the window: the button goes down and comes up. */
  const click = (window) => {
    opener.input(window, "mouseDown");
    opener.input(window, "mouseUp");
  };
  return { opener, given, lines, clock, click };
}

test("the opener gives the system what passes, keeps what it gave, and logs the origin only", () => {
  const { opener, given, lines, click } = setup();
  const window = {};
  click(window);
  assert.equal(opener.open("https://example.com/docs?token=abc", window), true);
  click(window);
  assert.equal(opener.open("http://example.com/", window), false);
  assert.equal(opener.open("file:///Applications/Calculator.app", window), false);
  assert.deepEqual(given, ["https://example.com/docs?token=abc"]);
  assert.deepEqual(opener.opened, ["https://example.com/docs?token=abc"]);
  assert.deepEqual(lines, ["[shell] opened in the browser: https://example.com"]);
});

test("without a click or a key in the window nothing is opened: a page cannot open the browser by itself", () => {
  const { opener, given, lines, clock } = setup();
  const window = {};
  assert.equal(opener.open("https://example.com/by-itself", window), false);
  // Not an input of the person: the pointer moving over the window, the wheel, a type the shell does not know.
  for (const type of ["mouseMove", "mouseEnter", "mouseLeave", "mouseWheel", "gestureScrollBegin", "keyUp", "", undefined, "click"]) {
    assert.equal(isGesture(type), false, String(type));
    opener.input(window, type);
  }
  assert.equal(opener.open("https://example.com/after-a-move", window), false);
  // An address that names no window, or something that is not one, has no click behind it either.
  assert.equal(opener.open("https://example.com/no-window"), false);
  for (const key of [null, 5, "window"]) {
    opener.input(key, "mouseDown");
    assert.equal(opener.open("https://example.com/no-window", key), false, String(key));
  }
  // A click long ago is not this address's click.
  opener.input(window, "mouseUp");
  clock.now += GESTURE_MS + 1;
  assert.equal(opener.open("https://example.com/late", window), false);
  // Nor is one from a clock that went back.
  opener.input(window, "mouseUp");
  clock.now -= 5000;
  assert.equal(opener.open("https://example.com/earlier", window), false);
  assert.deepEqual(given, []);
  assert.deepEqual(opener.opened, []);
  assert.equal(lines[0], "[shell] not opened in the browser, no click or key in the window just before: https://example.com");
  assert.ok(!lines.some((line) => /opened in the browser: /.test(line) && !/^\[shell\] not opened/.test(line)));
});

test("just after a click or a key in the window the address is opened: once for each", () => {
  for (const type of ["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "char", "touchStart", "touchEnd", "gestureTap"]) {
    const { opener, given, clock } = setup();
    const window = {};
    assert.equal(isGesture(type), true, type);
    opener.input(window, type);
    clock.now += GESTURE_MS;
    assert.equal(opener.open("https://example.com/asked", window), true, type);
    // The same click does not open a second address; the next click does.
    assert.equal(opener.open("https://example.com/again", window), false, type);
    opener.input(window, type);
    assert.equal(opener.open("https://example.com/next", window), true, type);
    assert.deepEqual(given, ["https://example.com/asked", "https://example.com/next"]);
  }
});

test("a click in one window opens nothing for another", () => {
  const { opener, given, click } = setup();
  const clicked = {};
  const other = {};
  click(clicked);
  assert.equal(opener.open("https://example.com/other", other), false);
  assert.equal(opener.open("https://example.com/clicked", clicked), true);
  assert.deepEqual(given, ["https://example.com/clicked"]);
});

test("a page cannot fill the browser with tabs: so many in a row from a window, then none until time has passed", () => {
  const { opener, given, clock, click } = setup();
  const window = {};
  for (let i = 0; i < MAX_OPENS + 5; i++) {
    click(window);
    opener.open(`https://example.com/${i}`, window);
  }
  assert.equal(given.length, MAX_OPENS);
  clock.now += OPENS_WINDOW_MS + 1;
  click(window);
  assert.equal(opener.open("https://example.com/later", window), true);
  assert.equal(given.length, MAX_OPENS + 1);
});

test("what another window asks for, however often, does not take the person's click away", () => {
  const { opener, given, clock, click } = setup();
  const spamming = {};
  const device = {};
  // A page asks without end and by itself: nothing opens, and nothing of it is counted.
  for (let i = 0; i < 500; i++) opener.open(`https://spam.example/${i}`, spamming);
  assert.deepEqual(given, []);
  // The same page with the person's clicks behind it uses up its own window's turns, and only those.
  for (let i = 0; i < MAX_OPENS + 5; i++) {
    click(spamming);
    opener.open(`https://spam.example/clicked-${i}`, spamming);
  }
  assert.equal(given.length, MAX_OPENS);
  for (let i = 0; i < 500; i++) opener.open(`https://spam.example/more-${i}`, spamming);
  // The person's click on "Download" in the device window, at the same moment: it opens.
  click(device);
  assert.equal(opener.open("https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.0-beta.2", device), true);
  assert.equal(given.at(-1), "https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.0-beta.2");
  assert.equal(given.length, MAX_OPENS + 1);
  // And in the spamming window itself, asking by itself in between does not use up the click that follows.
  clock.now += OPENS_WINDOW_MS + 1;
  for (let i = 0; i < 500; i++) opener.open(`https://spam.example/between-${i}`, spamming);
  click(spamming);
  assert.equal(opener.open("https://example.com/the-link-clicked", spamming), true);
});

test("what is not opened fills the log only so far, however often a page asks", () => {
  const { opener, lines, click } = setup({ open: () => {} });
  const window = {};
  for (let i = 0; i < 3000; i++) opener.open(`https://example.com/${i}?secret=${"s".repeat(100)}`, window);
  assert.ok(lines.length <= REFUSALS_PER_MINUTE, `${lines.length} lines`);
  for (let i = 0; i < 3000; i++) {
    click(window);
    opener.open(`https://example.com/${i}?secret=${"s".repeat(100)}`, window);
  }
  assert.ok(lines.length <= MAX_OPENS + 2 * REFUSALS_PER_MINUTE, `${lines.length} lines`);
  assert.equal(lines.at(-1), "[shell] not opened in the browser, too many in a row: https://example.com");
  assert.ok(!lines.some((line) => line.includes("secret")));
});

test("a browser that does not open takes nothing down", async () => {
  const lines = [];
  const window = {};
  const thrown = createOpener({ open: () => { throw new Error("no browser"); }, log: (line) => lines.push(line) });
  thrown.input(window, "mouseUp");
  assert.equal(thrown.open("https://example.com/", window), true);
  const rejected = createOpener({ open: () => Promise.reject(new Error("no handler")), log: (line) => lines.push(line) });
  rejected.input(window, "keyDown");
  assert.equal(rejected.open("https://example.com/", window), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines.filter((line) => /did not open/.test(line)), ["[shell] the browser did not open: no browser", "[shell] the browser did not open: no handler"]);
});
