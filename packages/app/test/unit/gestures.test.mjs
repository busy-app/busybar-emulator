// The person's click or key in a window, as the bridge's actions with consequences need it (gestures.mjs): what
// counts, for how long, for which window, and how many actions one gesture carries (all within its two seconds).
import assert from "node:assert/strict";
import { test } from "node:test";

import { GESTURE_MS } from "../../src/external.mjs";
import { CHAIN_MAX, createGestures } from "../../src/gestures.mjs";

function setup() {
  let time = 5_000_000;
  const gestures = createGestures({ now: () => time });
  return { gestures, window: { a: "window" }, other: { another: "window" }, pass: (ms) => (time += ms) };
}

test("without a click or a key in the window nothing begins; with one, for two seconds", () => {
  const { gestures, window, other, pass } = setup();
  assert.equal(gestures.allow(window), false);
  for (const type of ["mouseMove", "mouseWheel", "mouseEnter", "gestureScrollBegin", undefined, null, "keyUp"]) gestures.input(window, type);
  assert.equal(gestures.allow(window), false, "the pointer, the wheel and scrolling are not the person asking");
  for (const type of ["mouseDown", "keyDown", "rawKeyDown", "char", "touchStart", "gestureTap"]) {
    gestures.input(window, type);
    assert.equal(gestures.allow(window), true, type);
    assert.equal(gestures.allow(other), false, "another window's page has no part in it");
    pass(GESTURE_MS + 1);
  }
  gestures.input(window, "mouseDown");
  pass(GESTURE_MS);
  assert.equal(gestures.allow(window), true, "still within the two seconds");
  pass(1);
  assert.equal(gestures.allow(window), false, "two seconds and a millisecond after it");
  for (const none of [null, undefined, "window", 7]) {
    gestures.input(none, "mouseDown");
    assert.equal(gestures.allow(none), false);
  }
});

test("one gesture carries a short chain, all of it within two seconds of the click: what still runs gives no more time", () => {
  const { gestures, window, pass } = setup();
  gestures.input(window, "mouseDown");
  assert.equal(gestures.allow(window), true, "the first action");
  pass(1500);
  assert.equal(gestures.allow(window), true, "its follow-up, within the two seconds");
  // The first action still runs a minute (or ten) later: that is no reason to start another without a new click.
  pass(60_000);
  assert.equal(gestures.allow(window), false, "a minute later, whatever still runs");
  pass(9 * 60_000);
  assert.deepEqual([gestures.allow(window), gestures.allow(window), gestures.allow(window)], [false, false, false], "ten minutes later, three tries");
  // Not without end within the two seconds either: so many actions, then the gesture is used up.
  gestures.input(window, "keyDown");
  const allowed = Array.from({ length: CHAIN_MAX + 3 }, () => gestures.allow(window));
  assert.deepEqual(allowed, [...Array(CHAIN_MAX).fill(true), false, false, false]);
  assert.equal(CHAIN_MAX, 4);
  // A new gesture starts a new chain, with its own two seconds.
  gestures.input(window, "keyDown");
  pass(GESTURE_MS);
  assert.equal(gestures.allow(window), true);
  pass(1);
  assert.equal(gestures.allow(window), false);
  // A clock that went back (the system's time changed) allows nothing until the next click.
  gestures.input(window, "mouseDown");
  pass(-1);
  assert.equal(gestures.allow(window), false);
});
