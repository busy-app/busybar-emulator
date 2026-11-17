// The redraw after an app's draw at bar speed (bar-speed.mjs, redrawMs; runtime.mjs): JS that runs right after a
// draw's answer counts twice until it has taken redrawMs more; once the redraw's time has passed, JS counts once,
// whether or not any ran meanwhile (EMU-317 review: an app that draws, waits a second and then computes pays nothing).
//
// Nothing here depends on how busy the computer is. The computer's clock is node:test's mock clock, which moves only
// when the test moves it, so every event of the app runs at the time it is due and none is caught up to a later one
// (runtime.mjs, caughtUp). The work is timed by the app's own clock read from the runtime (runtime.now(): the slice's
// start plus the bar's time for the work counted so far), to the fraction of a millisecond, not by the app's
// Date.now(), which is whole milliseconds.
//
//   node --test "packages/server/test/runtime-redraw.test.mjs"      (from emulator/)
import assert from "node:assert/strict";
import { test } from "node:test";

import { barSpeed } from "../bar-speed.mjs";
import { computerClock } from "../computer-clock.mjs";
import { loadFirmware } from "../firmware.mjs";
import { AppRuntime } from "../runtime.mjs";

// The same JS three times, between two marks: right after a draw's answer, a second later, and in an app that never
// draws. About 59 ms of JS at bar speed, longer than the redraw.
const WORK = "let s = 0; for (let i = 0; i < 3000; i++) s += i;";
const timed = (name) => `console.log("${name} start"); ${WORK} console.log("${name} end");`;
const draw = (then) => `fetch("http://localhost/api/display/draw", { method: "POST", body: "{}" }).then(() => { ${then} });`;
// Each in an app of its own: no JS runs between the draw and the late work.
const NEAR = draw(timed("near"));
const LATE = draw(`setTimeout(() => { ${timed("late")} }, 1000);`);
const QUIET = `setTimeout(() => { ${timed("quiet")} }, 100);`;

/**
 * Runs `script` at 1.4.1's bar speed on the mock clock until it has timed `name`; returns the app's time between the
 * two marks, ms.
 */
async function timeOf(t, script, name) {
  const marks = {};
  const runtime = new AppRuntime({
    firmware: loadFirmware("1.4.1"),
    appId: "app.test.redraw",
    heapKib: 96,
    entry: "/a.js",
    readFile: (p) => (p === "/a.js" ? new TextEncoder().encode(script) : null),
    writeFile: () => false,
    localApi: async () => ({ status: 200, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode('{"result":"OK"}\n') }),
    speed: barSpeed("1.4.1"),
    // Inside the slice: the app's time at the mark.
    onConsole: (severity, text) => (marks[text] = runtime.now()),
    onLog: () => {},
    onExit: () => {},
  });
  t.after(() => runtime.terminate());
  await runtime.start();
  // The mock clock moves a millisecond at a time; between steps, what the step made due runs (the local API's answer
  // is a promise, the runtime's events are timers).
  for (let ms = 0; ms < 3000 && !(`${name} end` in marks); ms++) {
    t.mock.timers.tick(1);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(`${name} end` in marks, `${name}: the app timed its work within 3 s of the mock clock`);
  return marks[`${name} end`] - marks[`${name} start`];
}

test("JS right after a draw waits out the redraw; a second later it does not", { timeout: 60_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { monotonic, timeOfDay } = computerClock;
  computerClock.monotonic = computerClock.timeOfDay = () => Date.now();
  t.after(() => Object.assign(computerClock, { monotonic, timeOfDay }));

  const redraw = barSpeed("1.4.1").redrawMs();
  assert.ok(redraw > 0, "1.4.1's model has a redraw");
  const quiet = await timeOf(t, QUIET, "quiet");
  const near = await timeOf(t, NEAR, "near");
  const late = await timeOf(t, LATE, "late");
  assert.ok(quiet > redraw, `the work (${quiet.toFixed(2)} ms) is longer than the redraw (${redraw.toFixed(2)} ms)`);
  // Right after the answer: the redraw on top of the work, but for what the JS between the answer and the first mark
  // took of it (the Response object, the promise's callback, console.log: 0.81 ms of the 25.04 on 1.4.1's model).
  const extra = near - quiet;
  assert.ok(extra > redraw - 1.5 && extra <= redraw, `right after the draw ${near.toFixed(2)} ms, the work alone ${quiet.toFixed(2)} ms, the redraw ${redraw.toFixed(2)} ms`);
  // A second later the redraw is long over: the work takes what it takes in an app that never draws.
  assert.ok(Math.abs(late - quiet) < 0.01, `a second after the draw ${late.toFixed(2)} ms, the work alone ${quiet.toFixed(2)} ms`);
});
