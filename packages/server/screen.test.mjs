// The screen module on a made-up computer: the firmware's own code (the screen module of the default firmware), its
// clock and timer the test's. What is checked is the wiring between the two: that the GUI gets its ticks from the
// tick clock, and when a call into the module may and may not carry ticks out.
//
//   node --test "emulator/packages/**/*.test.mjs"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { appsAssets, loadFirmware } from "./firmware.mjs";
import { ComputerClock } from "./computer-clock.mjs";
import { BAR_DRAW_MS, Screen } from "./screen.mjs";
import { TICK_MS } from "./tick-clock.mjs";

const T0 = 1_700_000_000_000;

/** A computer whose clock and timer are the test's; with `step`, its timer fires only every `step` ms (Windows). */
function computer({ step = 0 } = {}) {
  const c = { t: T0, pending: null };
  c.clock = () => Math.floor(c.t);
  c.setTimer = (fn, ms) => {
    let at = c.t + Math.max(ms, 1);
    if (step) at = Math.ceil(at / step) * step;
    c.pending = { fn, at };
    return c.pending;
  };
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

/** A screen on such a computer, with no files; `ticks` gets the module's time at every emu_tick(). */
async function screenOn(c, callbacks = {}) {
  const ticks = [];
  const screen = await Screen.create({
    firmware: loadFirmware(),
    readFile: () => null,
    writeFile: () => true,
    listDir: () => [],
    remove: () => true,
    onAppStart: () => {},
    onAppAbort: () => {},
    onLog: () => {},
    barSpeed: true,
    clockHost: { computer: c.clock, setTimer: c.setTimer, clearTimer: c.clearTimer },
    ...callbacks,
  });
  const tick = screen.M._emu_tick;
  screen.M._emu_tick = () => {
    ticks.push(screen.clock.now());
    tick();
  };
  return { screen, ticks };
}

const everyTickMs = (from, count) => Array.from({ length: count }, (_, i) => from + (i + 1) * TICK_MS);

test("the GUI gets 125 ticks for every second of the clock, each at its due time, from a timer that fires every 15.6 ms", async () => {
  const c = computer({ step: 15.625 });
  const { screen, ticks } = await screenOn(c);
  c.pass(10_000);
  screen.sync();
  assert.deepEqual(ticks, everyTickMs(T0, 1250));
  assert.deepEqual(screen.clockState(), { now: T0 + 10_000, ticks: 1250, skipped: 0, held: false });
  screen.dispose();
});

test("a look at the display, a key and the clock's own reading first carry out what was due", async () => {
  const c = computer({ step: 15.625 });
  const { screen, ticks } = await screenOn(c);
  c.stall(20); // the host's timer has not fired yet
  screen.frame(0);
  assert.deepEqual(ticks, [T0 + 8, T0 + 16]);
  c.stall(20);
  screen.input(4, 0);
  assert.deepEqual(ticks, everyTickMs(T0, 5));
  c.stall(20);
  assert.equal(screen.now(), T0 + 60);
  assert.deepEqual(ticks, everyTickMs(T0, 7));
  // And the next tick still sees its own due time, not the time of that reading.
  c.stall(10);
  screen.sync();
  assert.deepEqual(ticks, everyTickMs(T0, 8));
  screen.dispose();
});

test("a callback of the module's that reaches back into the screen does not get ticks run inside the call", async () => {
  const c = computer();
  let seenInside = null;
  let frameInside = null;
  const { screen, ticks } = await screenOn(c, {
    // The firmware tells the host that its clock was set, from inside the request that sets it.
    onSettingChanged: (name) => {
      if (name !== "clock") return;
      c.stall(100); // the handler took its time
      screen.sync();
      frameInside = screen.frame(0);
      assert.throws(() => screen.hold(), /inside a call/);
      seenInside = ticks.length;
    },
  });
  c.pass(80);
  assert.equal(ticks.length, 10);
  const reply = await screen.request("POST", "time/timestamp", "timestamp=2031-05-06T07:08:09Z", null);
  assert.equal(reply.status, 200);
  assert.equal(seenInside, 10, "no tick inside the call into the module");
  assert.equal(frameInside.length, 72 * 16 * 3);
  // They are carried out by whatever comes next.
  screen.sync();
  assert.deepEqual(ticks, everyTickMs(T0, 22));
  screen.dispose();
});

test("the bar's real-time clock follows the computer's time of day, set forward or back; the ticks never go back", async () => {
  const HOUR = 3_600_000;
  const c = computer({ step: 15.625 });
  // The computer's time of day: its monotonic clock (c.t) and how far somebody set it from that.
  let set = 0;
  const cc = new ComputerClock({ monotonic: () => c.t, timeOfDay: () => c.t + set });
  const settings = [];
  const { screen, ticks } = await screenOn(c, {
    clockHost: { computer: () => Math.floor(cc.now()), timeOfDayOffset: () => cc.timeOfDayOffset(), setTimer: c.setTimer, clearTimer: c.clearTimer },
    onSettingChanged: (name, value) => settings.push([name, value]),
  });
  const rtc = () => screen.M._emu_screen_rtc_now();
  const timeOfDay = () => c.t + set;
  const ascending = () => ticks.every((t, i) => i === 0 || t > ticks[i - 1]);
  c.pass(1000);
  assert.ok(Math.abs(rtc() - timeOfDay()) <= TICK_MS);

  // Forward an hour: a long stall for the ticks, skipped, not played; the bar's clock is right at the next look.
  set = HOUR;
  let from = ticks.length;
  screen.sync();
  assert.equal(rtc(), screen.rtcNow());
  assert.ok(Math.abs(rtc() - timeOfDay()) <= TICK_MS, `${rtc() - timeOfDay()} ms off`);
  assert.ok(screen.clockState().skipped >= (HOUR - 500) / TICK_MS - 1, `skipped ${screen.clockState().skipped}`);
  assert.ok(ticks.length - from <= 500 / TICK_MS + 1, `${ticks.length - from} ticks played at once`);
  c.pass(1000);
  assert.ok(Math.abs(rtc() - timeOfDay()) <= 16);

  // Back two hours: the ticks go on at 125 a second, the bar's clock goes back — at the next tick, with nothing else
  // looking at the module (the host's timer alone carries the ticks out).
  const skipped = screen.clockState().skipped;
  from = ticks.length;
  set = -HOUR;
  c.pass(1000);
  assert.ok(Math.abs(rtc() - timeOfDay()) <= 16, `${rtc() - timeOfDay()} ms off after the host's timer`);
  screen.sync();
  assert.equal(ticks.length - from, 125);
  assert.equal(screen.clockState().skipped, skipped);
  assert.ok(ascending());
  assert.ok(Math.abs(rtc() - timeOfDay()) <= TICK_MS, `${rtc() - timeOfDay()} ms off`);

  // The bar's own setting is counted from the computer's time of day, not from the ticks' clock.
  const reply = await screen.request("POST", "time/timestamp", "timestamp=2031-05-06T07:08:09Z", null);
  assert.equal(reply.status, 200);
  const target = Date.UTC(2031, 4, 6, 7, 8, 9);
  const [, value] = settings.findLast(([name]) => name === "clock");
  assert.ok(Math.abs(Number(value) - (target - timeOfDay())) <= TICK_MS, `offset ${value}`);
  assert.ok(Math.abs(rtc() - target) <= TICK_MS);

  // Put right again: the bar's clock moves an hour on, the ticks lose nothing.
  set = 0;
  from = ticks.length;
  c.pass(1000);
  screen.sync();
  assert.equal(ticks.length - from, 125);
  assert.equal(screen.clockState().skipped, skipped);
  assert.ok(Math.abs(rtc() - (target + 1000 + HOUR)) <= 16);
  assert.ok(ascending());

  // A held clock does not tick, and the bar's clock still follows the computer's at the next look.
  screen.hold();
  set = -HOUR;
  from = ticks.length;
  screen.frame(0);
  assert.equal(ticks.length, from);
  assert.ok(Math.abs(rtc() - (target + 1000)) <= 16, `${rtc() - (target + 1000)} ms off while held`);
  screen.dispose();
});

// Past the start, whose screens the GUI draws for the first 2.5 s (the power-on screen, the apps menu's title card):
// from here the GUI has nothing to draw.
const QUIET_MS = 2600;

test("held, the screen's clock is stepped; a disposed screen ticks no more", async () => {
  const c = computer();
  const { screen, ticks } = await screenOn(c);
  c.pass(QUIET_MS);
  const from = ticks.length;
  const Q = T0 + QUIET_MS;
  // The GUI has nothing to draw: the hold stops on the next tick.
  screen.hold();
  assert.deepEqual(ticks.slice(from), everyTickMs(Q, 1));
  c.pass(1000);
  assert.deepEqual(ticks.slice(from), everyTickMs(Q, 1));
  screen.advance(24);
  assert.deepEqual(ticks.slice(from), everyTickMs(Q, 4));
  screen.release();
  c.pass(16);
  assert.deepEqual(ticks.slice(from), everyTickMs(Q, 6));
  screen.dispose();
  c.pass(1000);
  screen.sync();
  assert.equal(ticks.length, from + 6);
  assert.equal(c.pending, null);
});

test("at bar speed a hold 1 ms before a tick stops on that tick when the GUI has nothing to draw", async () => {
  const c = computer();
  const { screen, ticks } = await screenOn(c);
  c.pass(QUIET_MS);
  const from = ticks.length;
  c.stall(7);
  screen.hold();
  assert.deepEqual(ticks.slice(from), everyTickMs(T0 + QUIET_MS, 1));
  assert.equal(screen.now(), T0 + QUIET_MS + 8);
  screen.dispose();
});

test("at bar speed a hold while the GUI draws stops on the first tick by which it is done", async () => {
  const c = computer();
  const { screen, ticks } = await screenOn(c);
  c.pass(QUIET_MS);
  // A draw: canvas puts it on both displays (the back one shows a copy of the front), which takes the GUI ~20 ms.
  assert.equal((await screen.request("POST", "display/draw", "", drawing({ id: "t", type: "text", font: "small", x: 0, y: 4, text: "Hi" }))).status, 200);
  const from = ticks.length;
  screen.hold();
  const stop = screen.now();
  assert.ok(ticks.length - from >= 2, `stopped after ${ticks.length - from} ticks, before the drawing was done`);
  assert.equal(screen.M._emu_screen_drawing(), 0);
  assert.equal((stop - T0) % TICK_MS, 0);
  screen.dispose();
});

test("without the drawing time (--fast) a hold stops on the next tick", async () => {
  const c = computer();
  const { screen, ticks } = await screenOn(c, { barSpeed: false });
  c.stall(13);
  screen.hold();
  assert.deepEqual(ticks, everyTickMs(T0, 2));
  assert.equal(screen.now(), T0 + 16);
  screen.dispose();
});

// ---------------------------------------------------------------- a held clock plays the same each time (EMU-224)

const drawing = (element) => new TextEncoder().encode(JSON.stringify({ application_name: "test", priority: 100, elements: [element] }));
const meeting = drawing({ id: "a", type: "animation", x: 0, y: 0, stock_path: "shared/meeting_72x16.anim", loop: false });
// 33 frames a second, over 11 s: the playback crosses the module's timer that fires every 5 s.
const spinner = drawing({ id: "a", type: "animation", x: 32, y: 4, stock_path: "shared/spinner_front_8x8.anim", loop: true });

/**
 * Holds the clock, draws an animation of 60 frames a second, steps 8 ms at a time; the front frames' hashes from the
 * first change on.
 */
async function playHeld(screen, hold, steps = 600, scene = meeting) {
  screen.hold(hold);
  const drawn = await screen.request("POST", "display/draw", "", scene);
  assert.equal(drawn.status, 200);
  const frames = [];
  for (let i = 0; i < steps; i++) {
    frames.push(createHash("sha1").update(screen.frame(0)).digest("hex").slice(0, 12));
    screen.advance(TICK_MS);
  }
  screen.release();
  assert.equal((await screen.request("DELETE", "display/draw", "application_name=test", null)).status, 200);
  // Until the first change the display shows what was there before the draw (the apps menu, animated): not the scene.
  return frames.slice(frames.findIndex((f) => f !== frames[0]));
}

/** Eight playbacks on one screen, each after the clock ran freely for another while (ticks with the drawing time). */
async function eightAfterHistories(screen, c, hold, steps, scene) {
  // Past the apps menu's title card of the first 1.5 s, which takes the draws in its own way.
  c.pass(2000);
  const plays = [];
  for (const wait of [301, 37, 1000, 5, 250, 777, 64, 13]) {
    c.pass(wait);
    plays.push(await playHeld(screen, hold, steps, scene));
  }
  return plays;
}

test("at bar speed, eight holds after different histories play an animation the same, frame for frame", async () => {
  const c = computer({ step: 15.625 });
  const { screen } = await screenOn(c);
  const plays = await eightAfterHistories(screen, c, undefined);
  for (const [i, play] of plays.entries()) assert.deepEqual(play, plays[0], `playback ${i} differs from the first`);
  // It is the drawing time that plays: ticks are missed, as on a bar.
  assert.ok(new Set(plays[0]).size < new Set(await playHeld(screen, { jitter: false })).size);
  screen.dispose();
});

test("at bar speed, eight long playbacks after different histories are the same, whenever the 5 s timer fell", async () => {
  const c = computer({ step: 15.625 });
  const { screen } = await screenOn(c);
  const plays = await eightAfterHistories(screen, c, undefined, 1400, spinner);
  for (const [i, play] of plays.entries()) assert.deepEqual(play, plays[0], `playback ${i} differs from the first`);
  screen.dispose();
});

test("a hold in the middle of the apps menu's standby animation waits for it and then plays as a hold at a quiet moment", async () => {
  // The apps menu plays a background animation of about 1.1 s every 5 s (apps_menu_scene_start.c). One that a hold
  // finds under way would go on under the scene and move the display's refresh (review of EMU-224, S1).
  const c = computer({ step: 15.625 });
  const { screen } = await screenOn(c);
  c.pass(2000);
  c.pass(3900); // quiet: the next standby animation is due ~140 ms after this playback ends
  const quiet = await playHeld(screen, { jitter: false }, 120, spinner);
  assert.equal(screen.wander, 13, "released: the drawing takes a bar's time again");
  c.pass(4300); // the hold put the 5 s timer at hold + 5000; this is ~260 ms into the standby animation
  assert.ok(screen.M._emu_screen_running_timers() > 0, "the standby animation runs");
  const during = await playHeld(screen, { jitter: false }, 120, spinner);
  assert.deepEqual(during, quiet);
  screen.dispose();
});

test("held with drawing that takes no time, every frame of the animation is shown, the same each time; at bar speed only some", async () => {
  const c = computer({ step: 15.625 });
  const { screen } = await screenOn(c);
  screen.hold({ jitter: false });
  assert.equal(screen.wander, 0);
  screen.release();
  const plays = await eightAfterHistories(screen, c, { jitter: false });
  for (const [i, play] of plays.entries()) assert.deepEqual(play, plays[0], `playback ${i} differs from the first`);
  const nominal = new Set(plays[0]);
  for (const seed of [1, 0x2545f491, 0xdeadbeef]) {
    const wandered = new Set(await playHeld(screen, { seed }));
    for (const frame of wandered) assert.ok(nominal.has(frame), `seed ${seed}: a frame the nominal playback does not have`);
    assert.ok(wandered.size < nominal.size, `seed ${seed}: no frame left out`);
  }
  screen.dispose();
});

test("other seeds give other playbacks at bar speed, each the same every time", async () => {
  const c = computer();
  const { screen } = await screenOn(c);
  c.pass(2000);
  const a = await playHeld(screen, { seed: 0x2545f491 });
  c.pass(123);
  const b = await playHeld(screen, { seed: 0x6c8e9cf5 });
  c.pass(45);
  assert.deepEqual(await playHeld(screen, { seed: 0x2545f491 }), a);
  assert.notDeepEqual(a, b);
  assert.throws(() => screen.hold({ seed: 0 }), /must not be 0/);
  screen.dispose();
});

test("a release puts the drawing time's sequence back where the hold found it; running freely it is not reset", async () => {
  const c = computer();
  const { screen } = await screenOn(c);
  // Setting the drawing time with seed 0 changes nothing and tells where the sequence is.
  const state = () => screen.setDrawTime(true, 0);
  // Past the start's animations, which a hold would wait for on ticks that move the sequence on as free ticks do.
  c.pass(2600);
  for (const hold of [{ seed: 0x2545f491 }, { jitter: false }]) {
    const before = state();
    screen.hold(hold);
    // Held, the GUI draws an animation: the sequence moves on from the seed (or not at all).
    assert.equal((await screen.request("POST", "display/draw", "", meeting)).status, 200);
    screen.advance(400);
    screen.release();
    assert.equal(state(), before);
    c.pass(200);
    assert.equal((await screen.request("DELETE", "display/draw", "application_name=test", null)).status, 200);
    assert.notEqual(state(), before, "the GUI's drawing while the clock runs freely moves the sequence on");
    c.pass(1000);
  }
  screen.dispose();
});

// ---------------------------------------------------------------- the time the GUI takes to draw (EMU-231)

test("at bar speed a hold just after the display was cleared waits for its redraw, and plays the same whatever the wait", async () => {
  // Clearing the display leaves the GUI something to draw, which takes a bar's time when it comes (EMU-231): a hold
  // that stopped before it would have it fall into what is played after the stop. As timed.mjs plays a scene: the
  // clock held first, the display cleared and the scene drawn in held time, cleared again after the release.
  const c = computer();
  const { screen } = await screenOn(c);
  const loop = drawing({ id: "a", type: "animation", x: 0, y: 0, stock_path: "shared/coding_72x16.anim", loop: true });
  c.pass(2000);
  const plays = [];
  for (const wait of [0, 37, 300, 5, 777, 120, 1, 13]) {
    c.pass(wait);
    screen.hold();
    assert.equal((await screen.request("DELETE", "display/draw", "application_name=test", null)).status, 200);
    screen.advance(304);
    assert.equal((await screen.request("POST", "display/draw", "", loop)).status, 200);
    const frames = [];
    for (let i = 0; i < 300; i++) {
      frames.push(createHash("sha1").update(screen.frame(0)).digest("hex").slice(0, 12));
      screen.advance(TICK_MS);
    }
    screen.release();
    assert.equal((await screen.request("DELETE", "display/draw", "application_name=test", null)).status, 200);
    plays.push(frames);
  }
  for (const [i, play] of plays.entries()) assert.deepEqual(play, plays[0], `playback ${i} differs from the first`);
  screen.dispose();
});

// With an animation on both displays the GUI has more to draw than time (EMU-231 review, H1): on a bar it falls
// behind and shows fewer frames, never more than the animation has. Before its ticks waited for the drawing, the
// module's clock ran up to 0.3 s ahead of the computer's and showed 90 frames a second of a 60 frames a second
// animation in a 400 ms window.
// Both with the bar's drawing time and with more of it (6-7 ms on the front too): either way the GUI is overloaded.
for (const [displays, front] of [[["front", "back"], null], [["back"], null], [["front", "back"], [6, 7]], [["back"], [6, 7]]]) {
  test(`at bar speed an animation of 60 frames a second on ${displays.join(" and ")} never shows frames faster than that${front ? ", the front's drawing taking time too" : ""}`, async () => {
    const c = computer();
    const { screen } = await screenOn(c);
    if (front) screen.M._emu_gui_draw_time(front[0], front[1], BAR_DRAW_MS.back[0], BAR_DRAW_MS.back[1], 0);
    const wander = front ? front[1] + BAR_DRAW_MS.back[1] : screen.wander;
    c.pass(3000);
    const elements = displays.map((display) => ({ id: display, type: "animation", display, x: 0, y: 0, stock_path: "shared/coding_72x16.anim", loop: true }));
    assert.equal((await screen.request("POST", "display/draw", "", new TextEncoder().encode(JSON.stringify({ application_name: "test", priority: 100, elements })))).status, 200);
    c.pass(500);
    const hash = (d) => createHash("sha1").update(screen.frame(d)).digest("hex");
    const WINDOW_MS = 400;
    let last = [hash(0), hash(1)];
    let changes = [0, 0];
    for (let i = 1; i <= 20_000 / TICK_MS; i++) {
      c.pass(TICK_MS);
      for (const d of [0, 1]) {
        const h = hash(d);
        if (h !== last[d]) changes[d]++;
        last[d] = h;
      }
      if ((i * TICK_MS) % WINDOW_MS) continue;
      // A frame every two ticks at the most: 25 in 400 ms.
      for (const d of [0, 1]) assert.ok(changes[d] <= WINDOW_MS / 16, `${changes[d]} frames on display ${d} in ${WINDOW_MS} ms`);
      // And the module's clock keeps to the computer's: no further ahead than one pass draws.
      assert.ok(screen.M._emu_gui_lead() <= wander, `the module's clock ${screen.M._emu_gui_lead()} ms ahead`);
      changes = [0, 0];
    }
    screen.dispose();
  });
}

/** A loop of coding_72x16.anim with `fps` in its header (offset 16), as an app's own file. */
function animationAt(fps) {
  const bytes = readFileSync(join(appsAssets, "shared/animations/coding_72x16.anim"));
  bytes.writeUInt16LE(fps, 16);
  return new Uint8Array(bytes);
}

/** Runs of equal frames, [frame, step], in a playback of one frame every step. */
const runsOf = (frames) => frames.flatMap((f, i) => (i && f === frames[i - 1] ? [] : [[f, i]]));

/**
 * The runs laid over a timeline of runs, as timed.mjs does it (each matched with the timeline's next run of the same
 * frame, going forward only): the slope of the runs' steps per the timeline's.
 */
function paceOver(runs, timeline) {
  const pairs = [];
  let at = 0;
  for (const [frame, step] of runs) {
    let j = at;
    while (j < timeline.length && timeline[j][0] !== frame) j++;
    if (j === timeline.length) continue;
    pairs.push([timeline[j][1], step]);
    at = j;
  }
  const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
  const my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
  return pairs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pairs.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
}

/**
 * How many times its nominal timeline an animation of `fps` frames a second takes, held at bar speed with `seed`:
 * the nominal timeline is the same animation held with drawing that takes no time (jitter: false), 1.4 times as long.
 */
async function slowdown(fps, seed) {
  const c = computer();
  const file = animationAt(fps);
  const { screen } = await screenOn(c, { readFile: (path) => (path.endsWith(`/p${fps}.anim`) ? file : null) });
  c.pass(2000);
  const scene = drawing({ id: "a", type: "animation", x: 0, y: 0, path: `p${fps}.anim`, loop: true });
  const timeline = runsOf(await playHeld(screen, { jitter: false }, 1400, scene));
  const pace = paceOver(runsOf(await playHeld(screen, { seed }, 1000, scene)), timeline);
  screen.dispose();
  return pace;
}

// A stock bar on 1.3.1, the night of 11-12 Nov 2026 (5 runs each, reports/bar-night-2026-11-12.md): per frame, over
// the nominal timeline (whole ticks), 60 frames a second 1.216 (1.144-1.249), 33 1.035 (1.033-1.037), 30 0.998, 26
// 0.999, 25 1.001. The emulator's three seeds of timed.mjs must come within the tolerance of timed.mjs.
for (const [fps, bar, tolerance] of [[60, 1.216, 0.03], [33, 1.035, 0.015], [30, 0.998, 0.005], [26, 0.999, 0.005], [25, 1.001, 0.005]]) {
  test(`at bar speed ${fps} frames a second play ${bar} times the nominal ticks, as on a stock bar`, async () => {
    const paces = [];
    for (const seed of [0x9e3779b9, 0x2545f491, 0x6c8e9cf5]) paces.push(await slowdown(fps, seed));
    const mean = paces.reduce((a, b) => a + b) / paces.length;
    assert.ok(Math.abs(mean / bar - 1) <= tolerance, `${mean.toFixed(4)} (${paces.map((p) => p.toFixed(4)).join(", ")}), a stock bar ${bar}`);
  });
}
