// The screen module halting in the middle of a call, a tick or a batch of ticks, on a made-up computer (as in
// screen.test.mjs: the firmware's own code, the clock and the timer the test's). A halt is the firmware taking the bar
// down inside power_reboot(), or the module stopping a thread that waits without end (furi_shim.c, "waits"); the
// test makes the second happen with the module's probe, a call in which a thread sleeps as many times as it is told.
//
//   node --test "emulator/packages/**/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadFirmware } from "./firmware.mjs";
import { LauncherStatus, Screen } from "./screen.mjs";
import { TICK_MS } from "./tick-clock.mjs";

const T0 = 1_700_000_000_000;
// More sleeps than the module allows in one call (10000), and fewer.
const WITHOUT_END = 1_000_000;
const MANY = 6000;

/** A computer whose clock and timer are the test's. */
function computer() {
  const c = { t: T0, pending: null };
  c.clock = () => Math.floor(c.t);
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
  c.stall = (ms) => {
    c.t += ms;
  };
  return c;
}

/**
 * A screen on such a computer, with no files. `inTick(n, M)` runs inside the n-th emu_tick(), after the firmware's
 * own tick; `ticks` counts them, `stuck` the times the screen said its system hung, `settings` what the firmware told
 * the host, `errors` the module's log at the level of an error.
 */
async function screenOn(c, { inTick = () => {}, ...callbacks } = {}) {
  const seen = { ticks: 0, stuck: 0, settings: [], errors: [] };
  const screen = await Screen.create({
    firmware: loadFirmware(),
    readFile: () => null,
    writeFile: () => true,
    listDir: () => [],
    remove: () => true,
    onAppStart: () => {},
    onAppAbort: () => {},
    onLog: (level, tag, text) => level <= 2 && seen.errors.push(`[${tag}] ${text}`),
    onStuck: () => seen.stuck++,
    onSettingChanged: (name, value) => seen.settings.push([name, value]),
    barSpeed: true,
    clockHost: { computer: c.clock, setTimer: c.setTimer, clearTimer: c.clearTimer },
    ...callbacks,
  });
  const tick = screen.M._emu_tick;
  screen.M._emu_tick = () => {
    tick();
    inTick(++seen.ticks, screen.M);
  };
  return { screen, seen };
}

/** What a screen that is over answers, and that nothing of it runs any more. */
async function assertOver(screen, c, seen) {
  assert.equal(screen.disposed, true);
  assert.equal(c.pending, null, "the clock's timer is stopped");
  const ticks = seen.ticks;
  c.pass(1000);
  screen.sync();
  assert.equal(seen.ticks, ticks, "no tick after the halt");
  assert.equal((await screen.request("GET", "busy/snapshot", "", null)).status, 503);
  assert.ok(screen.frame(0).every((byte) => byte === 0), "the front display is dark");
  assert.equal(screen.frame(0).length, 72 * 16 * 3);
  assert.equal(screen.asleep(), true);
  assert.equal(screen.launch("app.nobody"), LauncherStatus.error);
  assert.equal(screen.quit(), LauncherStatus.error);
  screen.input(4, 0);
  screen.status({ volume: 10 });
}

test("ticks made up in one go after a stall are not a hang, however much the firmware sleeps in each", async () => {
  const c = computer();
  const { screen, seen } = await screenOn(c, { inTick: (n, M) => M._emu_wait_probe(MANY) });
  c.stall(400);
  // Fifty ticks in one task of the host, 300000 sleeps between them: the limit is for one call into the module.
  screen.sync();
  assert.equal(seen.ticks, 400 / TICK_MS);
  assert.equal(seen.stuck, 0);
  assert.deepEqual(seen.errors, []);
  assert.equal(screen.disposed, undefined);
  assert.equal((await screen.request("GET", "busy/snapshot", "", null)).status, 200);
  screen.dispose();
});

test("a thread that hangs in one tick of such a batch is stopped there: the batch ends, the screen is over, its owner is told once", async () => {
  const c = computer();
  const { screen, seen } = await screenOn(c, { inTick: (n, M) => n === 11 && M._emu_wait_probe(WITHOUT_END) });
  c.stall(400);
  screen.sync();
  assert.equal(seen.ticks, 11, "the ticks after the one that hung are not carried out");
  assert.equal(seen.stuck, 1);
  assert.equal(seen.errors.length, 1);
  assert.match(seen.errors[0], /^\[Emulator\] The firmware waited 10000 times in a row/);
  await assertOver(screen, c, seen);
  assert.equal(seen.stuck, 1);
});

test("a hang in a tick the host's timer brings: the timer's task ends, nothing is thrown into the host", async () => {
  const c = computer();
  const { screen, seen } = await screenOn(c, { inTick: (n, M) => n === 3 && M._emu_wait_probe(WITHOUT_END) });
  c.pass(100);
  assert.equal(seen.ticks, 3);
  assert.equal(seen.stuck, 1);
  await assertOver(screen, c, seen);
});

test("a hang in a tick that was due before a request: the request is answered as by a bar that is down", async () => {
  const c = computer();
  const { screen, seen } = await screenOn(c, { inTick: (n, M) => n === 2 && M._emu_wait_probe(WITHOUT_END) });
  c.stall(100);
  assert.equal((await screen.request("GET", "busy/snapshot", "", null)).status, 503);
  assert.equal(seen.ticks, 2);
  assert.equal(seen.stuck, 1);
  await assertOver(screen, c, seen);
});

test("a hang in a call into the module: the call ends with the answer of a system that is down", async () => {
  const c = computer();
  const { screen, seen } = await screenOn(c);
  c.pass(80);
  assert.equal(screen.enter((M) => M._emu_wait_probe(MANY)), MANY);
  assert.equal(screen.enter((M) => M._emu_wait_probe(WITHOUT_END), "down"), "down");
  assert.equal(seen.stuck, 1);
  await assertOver(screen, c, seen);
});

test("a hang in a call that a callback of the module's made from inside another call ends both", async () => {
  const c = computer();
  let inner = "not called";
  const { screen, seen } = await screenOn(c, {
    // The firmware tells the host that its clock was set, from inside the request that sets it.
    onSettingChanged: (name) => {
      if (name === "clock") inner = screen.enter((M) => M._emu_wait_probe(WITHOUT_END), "the inner call returned");
    },
  });
  c.pass(80);
  const reply = await screen.request("POST", "time/timestamp", "timestamp=2031-05-06T07:08:09Z", null);
  assert.equal(inner, "not called", "the halt went through the callback, it did not return into the module");
  assert.equal(reply.status, 503);
  assert.equal(seen.stuck, 1);
  await assertOver(screen, c, seen);
});

test("a restart by the firmware halts the module inside the call, after the host is told, and is not a hang", async () => {
  const c = computer();
  const { screen, seen } = await screenOn(c);
  // The supervisor restarts the bar after a fatal JS error once 30 s have passed since the start.
  c.pass(31_000);
  screen.jsFatal(true);
  assert.deepEqual(seen.settings.filter(([name]) => name === "power"), [["power", "reboot"]]);
  assert.equal(seen.stuck, 0);
  assert.deepEqual(seen.errors, []);
  await assertOver(screen, c, seen);
});
