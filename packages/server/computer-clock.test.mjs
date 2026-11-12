// The guard between the computer's two clocks (computer-clock.mjs, EMU-235), on clocks the test moves: the monotonic
// one the ticks go by and the time of day the bar's clock follows.
//
//   node --test "emulator/packages/**/*.test.mjs"
import assert from "node:assert/strict";
import { test } from "node:test";

import { ComputerClock, MAX_APART_MS } from "./computer-clock.mjs";

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

/** A computer: `mono` is its monotonic clock, `wall` its time of day; both in ms from T0. */
function computer() {
  const c = { mono: 0, wall: 0 };
  c.clock = new ComputerClock({ monotonic: () => T0 + c.mono, timeOfDay: () => T0 + c.wall });
  c.pass = (ms) => {
    c.mono += ms;
    c.wall += ms;
  };
  /** The bar's clock as it follows the computer's time of day. */
  c.bar = () => c.clock.now() + c.clock.timeOfDayOffset();
  return c;
}

test("the two clocks within a second of each other: nothing moves", () => {
  const c = computer();
  c.pass(5000);
  c.wall += MAX_APART_MS; // the drift of many hours, not yet more than allowed
  assert.equal(c.clock.now(), T0 + 5000);
  assert.equal(c.clock.timeOfDayOffset(), 0);
  c.wall -= 2 * MAX_APART_MS;
  assert.equal(c.clock.now(), T0 + 5000);
  assert.equal(c.clock.timeOfDayOffset(), 0);
  assert.equal(c.clock.steps, 0);
});

test("the computer's clock set forward an hour: the ticks' clock moves forward with it, the bar's clock is right", () => {
  const c = computer();
  c.pass(1000);
  c.wall += HOUR;
  assert.equal(c.clock.now(), T0 + 1000 + HOUR);
  assert.equal(c.clock.timeOfDayOffset(), 0);
  assert.equal(c.bar(), T0 + c.wall);
  c.pass(1000);
  assert.equal(c.bar(), T0 + c.wall);
});

test("the computer's clock set back an hour: the ticks' clock never goes back, the bar's clock does", () => {
  const c = computer();
  c.pass(1000);
  const before = c.clock.now();
  c.wall -= HOUR;
  assert.equal(c.clock.now(), before);
  assert.equal(c.clock.timeOfDayOffset(), -HOUR);
  assert.equal(c.bar(), T0 + c.wall);
  // The ticks go on at their pace.
  c.pass(250);
  assert.equal(c.clock.now(), before + 250);
  assert.equal(c.bar(), T0 + c.wall);
  // Put right again: the bar's clock with it, and the ticks have lost and gained nothing.
  c.wall += HOUR;
  assert.equal(c.clock.timeOfDayOffset(), 0);
  assert.equal(c.clock.now(), before + 250);
  assert.equal(c.bar(), T0 + c.wall);
});

test("set back, then forward past where it was: the ticks' clock moves on by what is ahead of it", () => {
  const c = computer();
  c.wall -= HOUR;
  assert.equal(c.clock.timeOfDayOffset(), -HOUR);
  c.wall += 2 * HOUR;
  assert.equal(c.clock.timeOfDayOffset(), 0);
  assert.equal(c.clock.now(), T0 + HOUR);
  assert.equal(c.bar(), T0 + c.wall);
});

test("a sleep in which the monotonic clock stands still: the first reading after it is right", () => {
  const c = computer();
  c.pass(2000);
  c.wall += HOUR; // asleep: the time of day goes on, the monotonic clock does not
  assert.equal(c.clock.now(), T0 + 2000 + HOUR);
  assert.equal(c.bar(), T0 + c.wall);
});

test("a sleep in which the monotonic clock runs on: nothing to put right", () => {
  const c = computer();
  c.pass(HOUR);
  assert.equal(c.clock.now(), T0 + HOUR);
  assert.equal(c.clock.steps, 0);
});

test("the drift adds up past a second, either way: the bar's clock is put right, the ticks' clock never goes back", () => {
  const c = computer();
  let last = c.clock.now();
  for (let minute = 0; minute < 3000; minute++) {
    c.mono += 60_000;
    c.wall += 60_000 + 1; // the time of day gains a millisecond a minute
    const now = c.clock.now();
    assert.ok(now >= last);
    last = now;
    assert.ok(Math.abs(c.bar() - (T0 + c.wall)) <= MAX_APART_MS);
  }
  assert.equal(c.clock.steps, 2);
  for (let minute = 0; minute < 3000; minute++) {
    c.mono += 60_000;
    c.wall += 60_000 - 1; // and loses it again
    const now = c.clock.now();
    assert.ok(now >= last);
    last = now;
    assert.ok(Math.abs(c.bar() - (T0 + c.wall)) <= MAX_APART_MS);
  }
});
