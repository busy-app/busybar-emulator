// A drawing from outside sent as soon as the bar is up (EMU-253). The firmware's canvas service sizes its back display
// by the GUI's main layer when it opens its screen (canvas_screen_open in canvas.c), and LVGL lays that layer out on
// the GUI's first refresh: before it the layer is 0×0, and a drawing then shows on the front display only, with the
// back one left as it was until the drawing is over. A bar's web server answers long after its GUI first drew; the
// emulator's start (Device.start, and so the server's readiness) waits for that first frame too.
//
// The bar and its screen module run on a made-up computer here: nothing ticks until the test moves the clock, so what
// happens before and after the first tick is the same on every run. The frames are a bar's (test/state, the night's
// recording, its first request), on both firmwares.
//
//   node --test emulator/packages/server/first-frame.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Device } from "./device.mjs";
import { attachDeviceWindow } from "./device-window.mjs";
import { loadFirmware } from "./firmware.mjs";
import { FIRST_FRAME_MS, Screen } from "./screen.mjs";
import { TICK_MS } from "./tick-clock.mjs";

const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

const here = dirname(fileURLToPath(import.meta.url));
// The bar's answer to a drawing of one text on the front display: the text there, and on the back display the
// mirror card (ACTIVE) with a copy of the front.
const recorded = JSON.parse(readFileSync(join(here, "../../test/state/bar-state-1.3.1-more.json"), "utf8")).requests[0];
assert.equal(recorded.path, "display/draw");
const DRAW = new TextEncoder().encode(recorded.body);
const BAR = { front: Buffer.from(recorded.frames.front, "base64"), back: Buffer.from(recorded.frames.back, "base64") };

/** A computer whose clock and timer are the test's (as in screen.test.mjs): nothing fires until pass(). */
function computer() {
  const c = { t: 1_700_000_000_000, pending: null };
  c.computer = () => Math.floor(c.t);
  c.setTimer = (fn, ms) => (c.pending = { fn, at: c.t + Math.max(ms, 1) });
  c.clearTimer = (handle) => {
    if (c.pending === handle) c.pending = null;
  };
  c.pass = (ms) => {
    const end = c.t + ms;
    while (c.pending && c.pending.at <= end) {
      const { fn, at } = c.pending;
      c.pending = null;
      c.t = Math.max(c.t, at);
      fn();
    }
    c.t = end;
  };
  return c;
}

/** Pixels of a frame that are not the bar's; on the back display not the status bar (x 148–159: the bar's battery). */
function apart(display, emu) {
  const bar = BAR[display];
  if (display === "front") return emu.reduce((n, byte, i) => n + (byte !== bar[i] ? 1 : 0), 0);
  let n = 0;
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 148; x++) {
      const i = y * 160 + x;
      if (((emu[i >> 1] >> ((i & 1) * 4)) & 0xf) !== ((bar[i >> 1] >> ((i & 1) * 4)) & 0xf)) n++;
    }
  }
  return n;
}

const turns = async (n) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

/** A bar on a made-up computer, its screen module loaded and its clock standing; `up` says whether start() is over. */
async function bar(t, firmware, { patch } = {}) {
  const root = mkdtempSync(join(tmpdir(), "emu-first-frame-"));
  folders.push(root);
  const c = computer();
  const lines = [];
  const device = new Device({ dataDir: root, firmware, log: (line) => lines.push(line), sidecars: false, clockHost: c });
  t.after(() => device.close());
  const state = { up: false, failed: null };
  const started = device.start().then(() => (state.up = true), (e) => (state.failed = e));
  await loaded(device, null, patch);
  return { c, device, lines, state, started };
}

/** Waits for the device's new screen module (not `old`, not the dark stand-in) and lets its start go as far as it goes. */
async function loaded(device, old, patch) {
  for (let i = 0; i < 2000 && !(device.screen?.M && device.screen !== old); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(device.screen?.M && device.screen !== old, "the screen module loaded");
  patch?.(device.screen.M);
  await turns(50);
}

/** Moves the clock a tick at a time until `done()`, for at most `ticks` ticks; the ticks it took. */
async function tickUntil(c, done, ticks) {
  for (let n = 0; n < ticks; n++) {
    await turns(5);
    if (done()) return n;
    c.pass(TICK_MS);
  }
  await turns(5);
  return done() ? ticks : -1;
}

for (const name of ["1.3.1", "dev"]) {
  const firmware = loadFirmware(name);

  test(`${name}: the bar is up only once its GUI has drawn, and a drawing sent at once is on both displays`, async (t) => {
    const { c, device, state } = await bar(t, firmware);
    assert.equal(device.screen.clockState().ticks, 0);
    // The drawing goes as soon as the bar is up: before any tick if it is up by now, else on the tick that brings it
    // up. A bar that is not up in 10 ticks fails the test here rather than keep it waiting.
    const upBeforeTick = state.up;
    const ticks = await tickUntil(c, () => state.up || state.failed, 10);
    assert.equal(state.failed, null);
    assert.notEqual(ticks, -1, "up within 10 ticks");
    const ticksWhenUp = device.screen.clockState().ticks;
    const drawn = await device.handle("POST", "http://127.0.0.1/api/display/draw", {}, DRAW);
    assert.equal(drawn.status, 200);
    c.pass(600); // the recording waited as long
    assert.deepEqual({ front: apart("front", device.screen.frame(0)), back: apart("back", device.screen.frame(1)) }, { front: 0, back: 0 }, "pixels that are not the bar's");
    assert.equal(upBeforeTick, false, "the bar is not up before the GUI's first tick");
    assert.equal(ticksWhenUp, 1, "up on the first tick");
  });

  test(`${name}: the clock held while a restart waits for its first frame stops after that frame, and the restart ends`, async (t) => {
    const { c, device, state } = await bar(t, firmware);
    await tickUntil(c, () => state.up, 10);
    const old = device.screen;
    let restarted = false;
    const restart = device.reboot("asked by the test").then(() => (restarted = true));
    await loaded(device, old);
    assert.equal(device.screen.clockState().ticks, 0, "the restart waits for its first tick");
    // As POST /_emu/time?hold=1 holds it: the stop goes on past the first frame (Screen.hold's busy()).
    device.screen.hold();
    await turns(20);
    assert.equal(restarted, true, "the restart is over with the clock held");
    assert.equal(device.screen.held, true);
    assert.equal((await device.handle("GET", "http://127.0.0.1/api/version")).status, 200);
    await restart;
  });

  test(`${name}: POST /_emu/time during a restart is carried out once the bar is up, as /api/* is`, async (t) => {
    const { c, device, state } = await bar(t, firmware);
    await tickUntil(c, () => state.up, 10);
    const window = attachDeviceWindow(device, { apiVersion: firmware.apiVersion });
    t.after(() => window.close());
    const old = device.screen;
    device.reboot("asked by the test");
    // Asked while the restart's screen module loads: the clock of the dark stand-in is no clock to hold (EMU-253, S3).
    let answer = null;
    const res = { writeHead: (status) => (answer = { status }), end: (body) => (answer.body = JSON.parse(body)) };
    assert.equal(window({ method: "POST" }, res, new URL("http://127.0.0.1/_emu/time?hold=1")), true);
    await loaded(device, old);
    assert.equal(answer, null, "no answer while the bar is not up");
    c.pass(TICK_MS);
    await turns(20);
    assert.equal(answer?.status, 200);
    assert.equal(answer.body.held, true, "the clock of the bar that came up is held");
    assert.equal(device.screen.held, true);
    assert.equal((await device.handle("GET", "http://127.0.0.1/api/version")).status, 200);
  });

  test(`${name}: a system that draws no first frame: the start fails, a restart leaves the bar off, each saying why`, async (t) => {
    const backNever = (M) => (M._emu_screen_drawn = () => 1);
    const { c, device, state } = await bar(t, firmware, { patch: backNever });
    const ticks = FIRST_FRAME_MS / TICK_MS;
    await tickUntil(c, () => state.up || state.failed, ticks + 2);
    assert.equal(state.up, false);
    assert.equal(state.failed?.code, "EMU_FIRST_FRAME");
    assert.match(state.failed.message, /did not draw a first frame on its back display within 3 s/);

    // A restart: the bar that came up (the module as it is) restarts into one that does not draw.
    const ok = await bar(t, firmware);
    await tickUntil(ok.c, () => ok.state.up, 10);
    const old = ok.device.screen;
    let restarted = false;
    const restart = ok.device.reboot("asked by the test").then(() => (restarted = true));
    await loaded(ok.device, old, (M) => (M._emu_screen_drawn = () => 0));
    await tickUntil(ok.c, () => restarted, ticks + 2);
    await restart;
    assert.equal(ok.device.powered, false, "the bar is off");
    assert.ok(ok.lines.some((line) => /^The BUSY Bar is off after a restart\. The BUSY Bar's system did not draw a first frame on its front and back display.*Press one of its buttons/.test(line)), ok.lines.join("\n"));
    const answer = await ok.device.handle("GET", "http://127.0.0.1/api/version");
    assert.equal(answer.status, 503);
  });

  test(`${name}: the firmware as it is now — a drawing before the GUI's first tick misses the back display`, async (t) => {
    // Pins the firmware's present behavior, which is why the bar waits for its first frame: canvas_screen_open() reads
    // the size of a layer that LVGL has not laid out yet. A firmware that lays the layer out itself would fail this
    // test without any fault of the emulator; the test (and perhaps the wait) can then be dropped.
    const c = computer();
    const screen = await Screen.create({
      firmware, readFile: () => null, writeFile: () => true, listDir: () => [], remove: () => true,
      onAppStart: () => {}, onAppAbort: () => {}, onLog: () => {}, barSpeed: false, clockHost: c,
    });
    t.after(() => screen.dispose());
    let first = false;
    screen.firstFrame().then(() => (first = true));
    await turns(5);
    assert.equal(first, false, "no frame before the first tick");
    assert.equal((await screen.request("POST", "display/draw", "", DRAW)).status, 200);
    c.pass(600);
    await turns(5);
    assert.equal(first, true, "the first frame came with the ticks");
    assert.equal(apart("front", screen.frame(0)), 0, "the front display is the bar's");
    assert.ok(apart("back", screen.frame(1)) > 1000, "the back display still shows what was there before the drawing (the APPS screen)");
  });
}
