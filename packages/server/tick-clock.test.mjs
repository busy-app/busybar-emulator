// The tick clock against a made-up computer: its clock and its timer are the test's, so a second passes at once and a
// host timer can be as late or as coarse as the test says.
//
//   node --test "emulator/packages/**/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_CATCH_UP_MS, TICK_MS, TickClock } from "./tick-clock.mjs";

const T0 = 1_700_000_000_000;

/**
 * A computer: `late` ms are added to every timer, and with `step` a timer fires only on the next multiple of `step`
 * ms (Windows: 15.625). The clock keeps one timer at a time, and the computer checks that.
 */
function computer({ late = 0, step = 0 } = {}) {
  // `t` is time as the timers count it and as the clock shows it; `back` takes the clock back, which the real one
  // (computer-clock.mjs) never does.
  const c = { t: T0, back: 0, pending: null, wakes: 0 };
  c.clock = () => Math.floor(c.t - c.back);
  c.setTimer = (fn, ms) => {
    assert.equal(c.pending, null, "one host timer at a time");
    let at = c.t + Math.max(ms, 1) + late; // Node makes a delay of 0 one of 1
    if (step) at = Math.ceil(at / step) * step;
    c.pending = { fn, at };
    return c.pending;
  };
  c.clearTimer = (handle) => {
    if (c.pending === handle) c.pending = null;
  };
  /** Time passes and the timers fire as they come due. */
  c.pass = (ms) => {
    const end = c.t + ms;
    while (c.pending && c.pending.at <= end) {
      const { fn, at } = c.pending;
      c.pending = null;
      c.t = Math.max(c.t, at);
      c.wakes++;
      fn();
    }
    c.t = end;
  };
  /** Time passes and nothing runs: the event loop is busy, the computer sleeps, a debugger holds the process. */
  c.stall = (ms) => {
    c.t += ms;
  };
  return c;
}

/** A running clock on a computer; `seen` gets what happens: ["tick", the module's time] and ["timer", id, time]. */
function running(options) {
  const c = computer(options);
  const seen = [];
  const clock = new TickClock({
    computer: c.clock,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onTick: () => seen.push(["tick", clock.now()]),
    onTimer: (id) => seen.push(["timer", id, clock.now()]),
  });
  clock.start();
  const ticks = () => seen.filter((e) => e[0] === "tick").map((e) => e[1]);
  return { c, clock, seen, ticks };
}

const everyTickMs = (from, count) => Array.from({ length: count }, (_, i) => from + (i + 1) * TICK_MS);

test("a second of the clock is 125 ticks, each at the time it was due", () => {
  const { c, ticks } = running();
  c.pass(1000);
  assert.deepEqual(ticks(), everyTickMs(T0, 125));
});

test("a host timer that is always late loses no tick", () => {
  const { c, ticks } = running({ late: 1.06 }); // macOS: setInterval(8) came every 9.06 ms
  c.pass(10_000);
  const got = ticks();
  // The last tick may still be waiting for its late timer.
  assert.ok(got.length === 1250 || got.length === 1249, `${got.length} ticks`);
  assert.deepEqual(got, everyTickMs(T0, got.length));
});

test("a host timer that fires every 15.6 ms gives the same ticks, two at a time", () => {
  const { c, ticks, seen } = running({ step: 15.625 }); // Windows
  let most = 0;
  let before = 0;
  const wakes = [];
  for (let ms = 0; ms < 10_000; ms += 15.625) {
    c.pass(15.625);
    wakes.push(seen.length - before);
    most = Math.max(most, seen.length - before);
    before = seen.length;
  }
  const got = ticks();
  assert.ok(got.length === 1250 || got.length === 1249, `${got.length} ticks`);
  assert.deepEqual(got, everyTickMs(T0, got.length));
  assert.equal(most, 2);
  assert.ok(wakes.filter((n) => n === 2).length > wakes.length * 0.9, "nearly every wake carries two ticks");
});

test("the module sees the same things happen at the same times whatever the host's timer is", () => {
  // Timers that restart themselves and each other, as the firmware's do, next to the ticks.
  const play = (options) => {
    const c = computer(options);
    const seen = [];
    const clock = new TickClock({
      computer: c.clock,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      onTick: () => {
        seen.push(`tick ${clock.now() - T0}`);
        if (clock.ticks % 40 === 0) clock.startTimer("from a tick", 13, false);
      },
      onTimer: (id) => {
        seen.push(`${id} ${clock.now() - T0}`);
        if (id === "chain") clock.startTimer("chain", 37, false);
        if (id === "every 100" && clock.now() % 300 === 0) clock.startTimer("from a timer", 1, false);
      },
    });
    clock.start();
    clock.startTimer("chain", 37, false);
    clock.startTimer("every 100", 100, true);
    clock.startTimer("every 16", 16, true); // due with every other tick
    c.pass(5000);
    return seen;
  };
  const exact = play();
  assert.ok(exact.length > 1000);
  for (const options of [{ late: 1.06 }, { step: 15.625 }, { step: 15.625, late: 3 }, { late: 40 }]) {
    const got = play(options);
    // Only the last few may still be waiting for the host.
    assert.ok(exact.length - got.length <= 16, `${JSON.stringify(options)}: ${exact.length - got.length} short`);
    assert.deepEqual(got, exact.slice(0, got.length), JSON.stringify(options));
  }
});

test("no tick is carried out before it is due", () => {
  const { c, clock } = running({ step: 15.625 });
  for (let ms = 0; ms < 2000; ms += 3.3) {
    c.pass(3.3);
    clock.sync();
    assert.ok(clock.ticks <= Math.floor((c.clock() - T0) / TICK_MS));
  }
});

test("a stall shorter than the limit is made up in full, in order", () => {
  const { c, ticks } = running();
  c.pass(100);
  c.stall(300);
  c.pass(100);
  assert.deepEqual(ticks(), everyTickMs(T0, 62)); // 500 ms
});

test("after a long stall only the last MAX_CATCH_UP_MS are made up and the clock jumps", () => {
  const { c, clock, ticks } = running();
  c.pass(80);
  assert.equal(clock.ticks, 10);
  c.stall(60_000); // the computer slept for a minute
  c.pass(1); // its timer fires at last
  const made = ticks().slice(10);
  const now = c.clock();
  assert.ok(made.length <= MAX_CATCH_UP_MS / TICK_MS + 1, `${made.length} ticks made up`);
  assert.ok(made.length >= MAX_CATCH_UP_MS / TICK_MS - 1);
  assert.ok(made[0] >= now - MAX_CATCH_UP_MS, "nothing older than the limit");
  assert.ok(made[made.length - 1] <= now);
  // The ticks stay on their 8 ms grid, and every tick of the minute was either carried out or counted as skipped.
  assert.ok(made.every((t) => (t - T0) % TICK_MS === 0));
  assert.equal(clock.ticks + clock.skipped, Math.floor((now - T0) / TICK_MS));
  assert.ok(clock.skipped > 7000);
  // And it goes on as before.
  const before = clock.ticks;
  c.pass(1000);
  assert.equal(clock.ticks - before, 125);
});

test("ticks and timers happen in the order they were due, a tick first when both are due at the same ms", () => {
  const { c, clock, seen } = running();
  clock.startTimer("a", 20, false);
  clock.startTimer("b", 16, false);
  clock.startTimer("c", 3, false);
  c.stall(30);
  clock.sync();
  assert.deepEqual(seen, [
    ["timer", "c", T0 + 3],
    ["tick", T0 + 8],
    ["tick", T0 + 16],
    ["timer", "b", T0 + 16],
    ["timer", "a", T0 + 20],
    ["tick", T0 + 24],
  ]);
});

test("a timer due before the next tick wakes the host in time", () => {
  const { c, clock, seen } = running();
  c.pass(1);
  clock.startTimer("soon", 2, false);
  c.pass(2);
  assert.deepEqual(seen, [["timer", "soon", T0 + 3]]);
});

test("a periodic timer keeps its own grid under a late host timer, and can be stopped", () => {
  const { c, clock, seen } = running({ late: 1.06 });
  clock.startTimer("p", 100, true);
  c.pass(1050);
  const fired = seen.filter((e) => e[0] === "timer").map((e) => e[2]);
  assert.deepEqual(fired, Array.from({ length: 10 }, (_, i) => T0 + (i + 1) * 100));
  clock.stopTimer("p");
  c.pass(1000);
  assert.equal(seen.filter((e) => e[0] === "timer").length, 10);
});

test("a timer restarted from its own callback counts from the time it was due", () => {
  const c = computer({ step: 15.625 });
  const fired = [];
  const clock = new TickClock({
    computer: c.clock,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onTick: () => {},
    onTimer: (id) => {
      fired.push(clock.now());
      clock.startTimer(id, 50, false);
    },
  });
  clock.start();
  clock.startTimer("again", 50, false);
  c.pass(1000);
  assert.deepEqual(fired, Array.from({ length: fired.length }, (_, i) => T0 + (i + 1) * 50));
  assert.ok(fired.length >= 19);
});

test("after a long stall a one-shot timer fires once and a periodic one does not replay the stall", () => {
  const { c, clock, seen } = running();
  clock.startTimer("once", 1000, false);
  clock.startTimer("every", 100, true);
  c.stall(60_000);
  clock.sync();
  const now = c.clock();
  const once = seen.filter((e) => e[1] === "once");
  const every = seen.filter((e) => e[1] === "every");
  assert.equal(once.length, 1);
  assert.equal(once[0][2], now - MAX_CATCH_UP_MS, "it sees the clock no earlier than the limit");
  // One firing for all the periods left out, then those of the last MAX_CATCH_UP_MS.
  assert.equal(every.length, 1 + MAX_CATCH_UP_MS / 100);
  // The module's clock never went back on the way.
  const times = seen.map((e) => e[e.length - 1]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("sync brings the module up to the clock before something looks at it", () => {
  const { c, clock, ticks } = running({ step: 15.625 });
  c.stall(20); // the host timer has not fired yet
  assert.equal(clock.ticks, 0);
  clock.sync(); // a request comes in
  assert.deepEqual(ticks(), [T0 + 8, T0 + 16]);
  assert.equal(clock.now(), T0 + 20);
  clock.sync();
  assert.equal(clock.ticks, 2, "nothing is carried out twice");
  // The timer that was pending finds those ticks done, and the next ones come with the host's next steps.
  c.pass(30);
  assert.deepEqual(ticks(), everyTickMs(T0, 5));
});

test("sync from inside a tick does nothing", () => {
  const c = computer();
  let depth = 0;
  let deepest = 0;
  const clock = new TickClock({
    computer: c.clock,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onTick: () => {
      deepest = Math.max(deepest, ++depth);
      clock.sync();
      depth--;
    },
    onTimer: () => {},
  });
  clock.start();
  c.stall(100);
  clock.sync();
  assert.equal(clock.ticks, 12);
  assert.equal(deepest, 1);
});

test("the clock a late tick sees does not go back behind what the module was shown since", () => {
  const { c, clock, ticks } = running({ step: 15.625 });
  c.stall(12);
  clock.sync();
  c.stall(6);
  // The module reads the clock without a sync, after the second tick was due and before the host got round to it.
  assert.equal(clock.now(), T0 + 18);
  c.pass(20);
  assert.deepEqual(ticks(), [T0 + 8, T0 + 18, T0 + 24]);
});

test("while held nothing moves by itself; advance carries out what falls into its ms, at exact times", () => {
  const { c, clock, seen } = running();
  c.pass(100);
  clock.hold();
  const held = clock.now();
  assert.equal(held, T0 + 100);
  seen.length = 0;
  c.pass(5000);
  assert.deepEqual(seen, []);
  assert.equal(clock.now(), held);
  assert.equal(c.pending, null, "no host timer while held");

  clock.startTimer("t", 20, false);
  clock.startTimer("p", 8, true);
  clock.advance(7);
  assert.deepEqual(seen, []);
  clock.advance(1);
  // The first tick is a period after the hold; a tick goes before a timer due at the same ms.
  assert.deepEqual(seen, [
    ["tick", held + 8],
    ["timer", "p", held + 8],
  ]);
  seen.length = 0;
  clock.advance(16);
  assert.deepEqual(seen, [
    ["tick", held + 16],
    ["timer", "p", held + 16],
    ["timer", "t", held + 20],
    ["tick", held + 24],
    ["timer", "p", held + 24],
  ]);
  assert.equal(clock.now(), held + 24);
});

test("advance has no limit: a minute is 7500 ticks", () => {
  const { clock } = running();
  clock.hold();
  const before = clock.ticks;
  clock.advance(60_000);
  assert.equal(clock.ticks - before, 7500);
  assert.equal(clock.skipped, 0);
});

test("advance needs a held clock", () => {
  const { clock } = running();
  assert.throws(() => clock.advance(8), /not held/);
});

test("released, the clock runs on from the time it was held at", () => {
  const { c, clock, ticks } = running();
  c.pass(100);
  clock.hold();
  clock.advance(1000);
  const held = clock.now();
  c.stall(3000); // the test took its time
  clock.release();
  assert.equal(clock.now(), held, "no jump at the release");
  const before = ticks().length;
  c.pass(1000);
  const after = ticks().slice(before);
  assert.equal(after.length, 125, "and none of the held time is made up or skipped");
  assert.deepEqual(after, everyTickMs(held, 125));
  assert.equal(clock.skipped, 0);
  assert.equal(clock.now(), c.clock() + clock.skew);
  assert.equal(clock.skew, 1000 - 3000);
});

test("hold first carries out what was due", () => {
  const { c, clock, ticks } = running({ step: 15.625 });
  c.stall(20);
  clock.hold();
  assert.deepEqual(ticks(), [T0 + 8, T0 + 16]);
  assert.equal(clock.now(), T0 + 20);
});

test("held on a tick, the clock stops on the first tick at least `lead` ms ahead, with onTick() at that tick's time", () => {
  for (const [stall, lead, stopsAt] of [
    [20, 0, 24], // the next tick
    [20, 4, 24], // 4 ms ahead is still that one
    [20, 5, 32], // 5 ms ahead is the one after
    [17, 64, 88], // the first at least 64 ms after T0 + 17
  ]) {
    const { c, clock, seen } = running({ step: 15.625 });
    clock.startTimer("t", 30, false); // due at T0 + 30: before the stop or after it
    c.stall(stall);
    let onTickAt = null;
    clock.hold({ lead, onTick: () => (onTickAt = [clock.now(), seen.length]) });
    const ticks = seen.filter((e) => e[0] === "tick").map((e) => e[1]);
    assert.deepEqual(ticks, everyTickMs(T0, stopsAt / TICK_MS), `stall ${stall}, lead ${lead}`);
    // onTick() comes at the stop's time, after everything due before it and before its tick.
    assert.deepEqual(onTickAt, [T0 + stopsAt, seen.findIndex((e) => e[0] === "tick" && e[1] === T0 + stopsAt)]);
    assert.equal(clock.now(), T0 + stopsAt);
    assert.equal(seen.some((e) => e[0] === "timer"), 30 <= stopsAt, "the timer fired only if it was due by the stop");
    // Held there: the next tick is a period on, as after any hold.
    clock.advance(TICK_MS);
    assert.deepEqual(seen.filter((e) => e[0] === "tick").at(-1), ["tick", T0 + stopsAt + TICK_MS]);
    assert.equal(c.pending, null, "no host timer while held");
  }
});

test("held on a tick, a periodic timer counts its period from the stop; a one-shot timer keeps its time", () => {
  for (const wait of [3, 1000, 2717, 4999]) {
    const { c, clock, seen } = running();
    clock.startTimer("every-5s", 5000, true);
    clock.startTimer("once", 6000, false);
    c.pass(wait);
    clock.hold({ lead: 2, onTick: () => {} });
    const stop = clock.now();
    seen.length = 0;
    clock.advance(10_000);
    const fired = seen.filter((e) => e[0] === "timer").map((e) => [e[1], e[2]]);
    assert.deepEqual(fired, [
      ["every-5s", stop + 5000],
      ["once", T0 + 6000],
      ["every-5s", stop + 10_000],
    ].sort((a, b) => a[1] - b[1]), `after ${wait} ms`);
  }
});

test("held on a tick while the module is busy, the stop moves on a tick at a time until it is not, or at most maxWait", () => {
  for (const [busyUntil, maxWait, stopsAt] of [
    [0, 1000, 8], // not busy: the next tick
    [40, 1000, 48], // busy until the tick at 40 is done: the stop is the tick after it
    [5000, 100, 104], // busy for longer than the wait: ticks up to 100 ms on are waited for, the stop is the next
  ]) {
    const { c, clock, ticks } = running();
    let onTickAt = null;
    clock.hold({ lead: 0, busy: () => clock.now() < T0 + busyUntil, maxWait, onTick: () => (onTickAt = clock.now()) });
    assert.equal(onTickAt, T0 + stopsAt, `busy until ${busyUntil}, at most ${maxWait}`);
    assert.deepEqual(ticks(), everyTickMs(T0, stopsAt / TICK_MS));
    assert.equal(c.pending, null, "no host timer while held");
  }
});

test("held on a tick, the ticks keep their grid: holds after any history stop a whole number of periods apart", () => {
  const { c, clock } = running();
  const stops = [];
  for (const wait of [5, 13, 100, 7, 64, 1, 250, 33]) {
    c.pass(wait);
    clock.hold({ lead: 3, onTick: () => {} });
    stops.push(clock.now());
    clock.advance(wait % 3 ? 40 : 8);
    clock.release();
  }
  for (const at of stops) assert.equal((at - T0) % TICK_MS, 0, `stopped at T0 + ${at - T0}`);
});

test("a clock that goes back holds the module's time until it has caught up, and leaves nothing behind", () => {
  const { c, clock, ticks } = running();
  c.pass(1000);
  const before = clock.now();
  c.back = 10_000; // ten seconds back
  c.pass(1000);
  assert.equal(clock.now(), before, "the module's clock does not go back");
  assert.equal(ticks().length, 125, "and nothing is due meanwhile");
  c.back = 0; // and forward again
  c.pass(1000);
  assert.equal(clock.now(), c.clock(), "the module's clock is the computer's again");
  assert.equal(clock.skew, 0);
  // The second in between is made up as any stall is: its last half second.
  assert.equal(clock.ticks + clock.skipped, 375);
  assert.deepEqual(ticks().slice(-125), everyTickMs(T0 + 2000, 125));
});

test("the default clock does not follow the computer's time of day when that is set back or forward", async () => {
  // The real clock and the real timer, for a fifth of a second each way; Date.now() plays the time of day being set.
  const dateNow = Date.now;
  let step = 0;
  Date.now = () => dateNow() + step;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const seen = [];
  let clock;
  let started;
  try {
    clock = new TickClock({ onTick: () => seen.push(clock.now()), onTimer: () => {} });
    clock.start();
    started = clock.nextTick - TICK_MS;
    await wait(100);
    for (step of [-10_000, +10_000, +3_600_000, -3_600_000]) await wait(50);
    clock.sync();
  } finally {
    Date.now = dateNow;
  }
  const elapsed = clock.now() - started;
  clock.stop();
  // A step of the time of day would show as ten seconds or an hour here.
  assert.ok(elapsed >= 300 && elapsed < 5000, `${elapsed} ms by the module's clock`);
  // Every 8 ms of it is a tick on the grid, in order (or, on a computer that stood still for over half a second
  // meanwhile, a tick counted as skipped), and no skew is left.
  assert.equal(seen.length + clock.skipped, Math.floor(elapsed / TICK_MS));
  assert.ok(seen.every((t, i) => (t - started) % TICK_MS === 0 && (i === 0 || t > seen[i - 1])));
  if (!clock.skipped) assert.deepEqual(seen, everyTickMs(started, seen.length));
  assert.equal(clock.skew, 0);
});

test("a timer started again goes after the timers due at the same ms that were started before it", () => {
  const { clock, seen } = running();
  clock.hold();
  clock.startTimer("A", 5, false);
  clock.startTimer("B", 5, false);
  clock.startTimer("A", 5, false);
  clock.startTimer("C", 5, false);
  clock.advance(6);
  assert.deepEqual(
    seen.map((e) => e[1]),
    ["B", "A", "C"],
  );
});

test("a periodic timer with no period fires every millisecond, not for ever", () => {
  const c = computer();
  const fired = [];
  const clock = new TickClock({
    computer: c.clock,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onTick: () => {},
    onTimer: () => {
      fired.push(clock.now() - T0);
      assert.ok(fired.length <= 1000, "the timer fires for ever");
    },
  });
  clock.start();
  clock.hold();
  clock.startTimer("p", 0, true);
  clock.advance(20);
  assert.deepEqual(fired, Array.from({ length: 21 }, (_, i) => i));
});

test("stopped from inside a tick, the clock carries out nothing more", () => {
  const c = computer();
  let ticks = 0;
  const clock = new TickClock({
    computer: c.clock,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    onTick: () => {
      if (++ticks === 3) clock.stop();
    },
    onTimer: () => assert.fail("a timer after the stop"),
  });
  clock.start();
  clock.startTimer("later", 30, false);
  c.stall(100);
  clock.sync();
  c.pass(100);
  assert.equal(ticks, 3);
  assert.equal(c.pending, null);
});

test("a timer that restarts itself with no delay takes its turns with the ticks", () => {
  const spinning = (hold) => {
    const c = computer({ step: 15.625 });
    const seen = [];
    const clock = new TickClock({
      computer: c.clock,
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
      onTick: () => seen.push(["tick", clock.now() - T0]),
      onTimer: (id) => {
        seen.push([id, clock.now() - T0]);
        if (seen.length < 5000) clock.startTimer(id, 0, false);
      },
    });
    clock.start();
    if (hold) clock.hold();
    clock.startTimer("spin", 0, false);
    return { c, clock, seen };
  };
  // Running: it fires once a millisecond of the clock, and the ticks come between its firings.
  const { c, seen } = spinning(false);
  c.pass(100);
  const ticks = seen.filter((e) => e[0] === "tick").map((e) => e[1]);
  const spins = seen.filter((e) => e[0] === "spin").map((e) => e[1]);
  assert.deepEqual(ticks, everyTickMs(0, ticks.length));
  assert.ok(ticks.length >= 11, `${ticks.length} ticks`);
  assert.deepEqual(spins, Array.from({ length: spins.length }, (_, i) => i));
  assert.ok(spins.length >= 90, `${spins.length} firings`);
  // Held: as before, it is due at the same millisecond (this test stops it after 5000 firings).
  const held = spinning(true);
  held.clock.advance(1);
  assert.equal(held.seen.length, 5000);
  assert.ok(held.seen.every((e) => e[0] === "spin" && e[1] === 0));
});

test("a stopped clock does nothing more", () => {
  const { c, clock, seen } = running();
  clock.startTimer("t", 50, false);
  c.pass(16);
  clock.stop();
  c.pass(1000);
  clock.sync();
  assert.equal(seen.length, 2);
  assert.equal(c.pending, null);
});
