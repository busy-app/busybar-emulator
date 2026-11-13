// The app's periodic timer when this computer is too busy to run the host's timers on time: a stall of the process
// stands in for a build running next to the emulator. On the bar the timer would have run every period; here its
// runs within MAX_CATCH_UP_MS are made up afterwards, each at its own time by the app's clock, so the app's
// Date.now() steps by the period, it is never ahead of the computer's clock and falls behind it by no more than a
// stall, and it never jumps. A longer stall is skipped: one run, then the period again (runtime.mjs).
//
//   node --test "packages/server/test/runtime-timers.test.mjs"      (from emulator/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { barSpeed } from "../bar-speed.mjs";
import { computerClock, computerNow } from "../computer-clock.mjs";
import { loadFirmware } from "../firmware.mjs";
import { AppRuntime } from "../runtime.mjs";
import { MAX_CATCH_UP_MS } from "../tick-clock.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const firmwares = Object.keys(JSON.parse(readFileSync(join(server, "../engine/firmware.json"), "utf8")).versions);

const PERIOD = 50;
// The app prints its Date.now() on every run of its timer; the computer's clock is read as the line comes.
const SCRIPT = `setInterval(function () { console.log('now ' + Date.now()); }, ${PERIOD});`;

/** Holds this thread for `ms`, as a computer too busy to give the process its turn does. */
function stall(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end);
}

/**
 * Runs the app for `ms` while `stalls` (a list of [at, length] in ms from the start) hold the process, and returns
 * each run of its timer: the app's Date.now() and the computer's clock (ticks' clock, as the app's is) at that moment.
 */
async function run({ firmware, speed, ms, stalls }) {
  const runs = [];
  const runtime = new AppRuntime({
    firmware,
    appId: "app.test.timer",
    heapKib: 96,
    entry: "/test.js",
    readFile: (p) => (p === "/test.js" ? new TextEncoder().encode(SCRIPT) : null),
    writeFile: () => false,
    localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
    // The app's clock is the ticks' clock: no offset, so the two can be compared.
    clockOffset: () => 0,
    onConsole: (_, text) => runs.push({ app: Number(text.slice(4)), computer: computerNow() }),
    onLog: () => {},
    onExit: () => {},
    speed,
  });
  await runtime.start();
  const started = performance.now();
  const timers = stalls.map(([at, length]) => setTimeout(() => stall(length), at));
  await new Promise((resolve) => setTimeout(resolve, ms));
  timers.forEach(clearTimeout);
  runtime.terminate();
  return { runs, started };
}

const steps = (runs) => runs.slice(1).map((r, i) => r.app - runs[i].app);
const report = (runs) => runs.map((r, i) => `${i ? r.app - runs[i - 1].app : 0}/${Math.round(r.computer - r.app)}`).join(" ");

const isPeriod = (d) => Math.abs(d - PERIOD) <= 1;
const ahead = (runs) => runs.filter((r) => r.app > r.computer + 1);

for (const name of firmwares) {
  describe(`firmware ${name}: a 50 ms timer on a busy computer`, () => {
    const firmware = loadFirmware(name);

    test("at bar speed: three stalls of 200 ms a second apart; every run is made up, a period apart by the app's clock, and the app is on the computer's clock again after each", async () => {
      const { runs } = await run({ firmware, speed: barSpeed(), ms: 3800, stalls: [[300, 200], [1300, 200], [2300, 200]] });
      const said = `step/behind: ${report(runs)}`;
      assert.deepEqual(ahead(runs), [], `ahead of the computer's clock; ${said}`);
      assert.ok(steps(runs).every(isPeriod), said);
      // Before: the host's setInterval dropped the runs it was late for and the app stayed 150 ms behind per stall.
      assert.ok(runs.length >= 3800 / PERIOD - 6, `${runs.length} runs; ${said}`);
      assert.ok(runs.slice(-5).every((r) => r.computer - r.app < PERIOD), `behind at the end; ${said}`);
    });

    test("at bar speed: stalls of 150 ms in every 250 ms for 4 s; the runs are made up, the app's clock steps by the period or, past what is made up, by no more than the time that passed", async () => {
      const stalls = Array.from({ length: 16 }, (_, i) => [200 + i * 250, 150]);
      const { runs } = await run({ firmware, speed: barSpeed(), ms: 4600, stalls });
      const said = `step/behind: ${report(runs)}`;
      const s = steps(runs);
      const skips = s.filter((d) => !isPeriod(d));
      console.log(`${runs.length} runs in 4.6 s, ${skips.length} skips (${skips.join(", ")} ms), worst behind ${Math.round(Math.max(...runs.map((r) => r.computer - r.app)))} ms`);
      assert.deepEqual(ahead(runs), [], `ahead of the computer's clock; ${said}`);
      // A skip only after the app fell more than MAX_CATCH_UP_MS behind, which a computer this loaded may still do.
      assert.ok(skips.every((d) => d > MAX_CATCH_UP_MS), said);
      // Before: about half the runs were lost (45 of 92) and the app skipped 0.65 s every second. What a skip passed
      // over (the app more than MAX_CATCH_UP_MS behind, which a gate's load adds to the test's own stalls) has no
      // runs; the rest of the time has its runs (EMU-294: 54 runs with three skips of 0.6 to 0.8 s).
      const skipped = skips.reduce((sum, d) => sum + d - PERIOD, 0);
      assert.ok(runs.length >= 0.7 * ((4600 - skipped) / PERIOD), `${runs.length} runs, ${skipped} ms skipped; ${said}`);
    });

    test("at the computer's speed: stalls of 150 ms in every 250 ms; the runs the host was late for are one run, and the next is on the timer's beat", async () => {
      const stalls = Array.from({ length: 8 }, (_, i) => [200 + i * 250, 150]);
      const { runs } = await run({ firmware, speed: null, ms: 2600, stalls });
      const said = `step/behind: ${report(runs)}`;
      assert.deepEqual(ahead(runs), [], `ahead of the computer's clock; ${said}`);
      // Never twice for one period, nor two runs in one ms of the app's clock (the host's timer may fire a fraction of a
      // ms early; a late run may land a fraction of a ms before the next period: the test below).
      assert.ok(steps(runs).every((d) => d > 0), said);
      assert.ok(runs.length <= 2600 / PERIOD + 2, `${runs.length} runs; ${said}`);
    });

    // The case the test above meets by chance on a loaded computer (EMU-294, the release's gate of 13.11: "200/0 0/1"),
    // set up exactly: the host's timers and the computer's clock are node:test's mock timers. The app reads its clock
    // in whole ms; the host is late for its timer by 150 ms and fires it at x.25, half a ms before the next period's
    // time x.75. That run stands for the runs the host was late for; the next period's run, at x.75 by the host's
    // timer, would come in the same whole ms of the app's clock, which the bar's tick of a ms never gives: it comes
    // at the app's next ms, and the period stays on its beat after it.
    test("at the computer's speed: the run after a late one is in a later whole ms of the app's clock, though the next period is half a ms away", async (t) => {
      const base = 1_000_000.75;
      t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: base });
      const { monotonic, timeOfDay } = computerClock;
      computerClock.monotonic = computerClock.timeOfDay = () => Date.now();
      t.after(() => Object.assign(computerClock, { monotonic, timeOfDay }));
      const seen = [];
      let offset = 0;
      const runtime = new AppRuntime({
        firmware,
        appId: "app.test.timer",
        heapKib: 96,
        entry: "/test.js",
        readFile: (p) => (p === "/test.js" ? new TextEncoder().encode(SCRIPT) : null),
        writeFile: () => false,
        localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
        clockOffset: () => offset,
        onConsole: (_, text) => seen.push(Number(text.slice(4)) - Math.floor(base)),
        onLog: () => {},
        onExit: () => {},
        speed: null,
      });
      await runtime.start();
      t.after(() => runtime.terminate());
      // Due at .75 + 50; the host fires it 150 ms late, at 200.25: one run for the three periods.
      t.mock.timers.tick(199.5);
      assert.deepEqual(seen, [200]);
      // The next period's time, 200.75: the app's clock is still in ms 200.
      t.mock.timers.tick(0.5);
      assert.deepEqual(seen, [200], "a second run in the app's ms 200");
      t.mock.timers.tick(0.25);
      assert.deepEqual(seen, [200, 201]);
      // On the beat again: 250.75.
      t.mock.timers.tick(49.5);
      assert.deepEqual(seen, [200, 201]);
      t.mock.timers.tick(0.25);
      assert.deepEqual(seen, [200, 201, 250]);
      // The bar's clock set back 10 s (POST /api/time/timestamp): its ms are all before the last run's, and the timer
      // goes on by the period; it does not wait for the clock to come back to that ms.
      offset = -10_000;
      t.mock.timers.tick(50);
      assert.deepEqual(seen, [200, 201, 250, 300 - 10_000]);
    });

    test("at bar speed: a stall longer than is made up is skipped; one run, then the period again, the app on the computer's clock", async () => {
      const { runs } = await run({ firmware, speed: barSpeed(), ms: 2600, stalls: [[300, MAX_CATCH_UP_MS + 700]] });
      const said = `step/behind: ${report(runs)}`;
      assert.deepEqual(ahead(runs), [], `ahead of the computer's clock; ${said}`);
      // One step over the stall, no longer than the time that passed (the app is never ahead), and only one.
      const long = steps(runs).filter((d) => !isPeriod(d));
      assert.equal(long.length, 1, said);
      assert.ok(long[0] > MAX_CATCH_UP_MS, said);
      assert.ok(runs.slice(-5).every((r) => r.computer - r.app < PERIOD), `behind at the end; ${said}`);
    });
  });
}
