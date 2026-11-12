// The emulator's watchdog (runtime.mjs SLICE_LIMIT_MS, emu_runner.c engine_halt_callback): an app's JS that does not
// return holds the server's only thread, so after SLICE_LIMIT_MS of the thread's own time the app is stopped, as a long
// Back stops it on a bar, and the thread is free again. JS that is long but returns within the limit runs to its end.
// The slices are measured by the thread's processor time (stats.maxCpuMs), as the watchdog counts them: by the
// clock, a loaded computer (the gate) made a slice of 0.8 s of work take more than the limit (EMU-294). Whatever the
// load, the clock's own bound (SLICE_CLOCK_LIMIT_MS) stops a slice that the thread's time has not stopped yet.
//
//   node --test "packages/server/test/runtime-watchdog.test.mjs"      (from emulator/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { barSpeed } from "../bar-speed.mjs";
import { loadFirmware } from "../firmware.mjs";
import { AppRuntime, SLICE_CLOCK_LIMIT_MS, SLICE_LIMIT_MS } from "../runtime.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const firmwares = Object.keys(JSON.parse(readFileSync(join(server, "../engine/firmware.json"), "utf8")).versions);

// How much later than the limit the stop may come, in the thread's time: the halt handler asks every few thousand
// backward branches, well under a millisecond apart.
const LATE_MS = 1000;

/** The stopped slice ended at one of the watchdog's bounds: SLICE_LIMIT_MS of the thread's time, or the clock's own. */
function stoppedAtLimit(stats) {
  const byThread = stats.maxCpuMs >= SLICE_LIMIT_MS && stats.maxCpuMs < SLICE_LIMIT_MS + LATE_MS;
  const byClock = stats.maxWasmMs >= SLICE_CLOCK_LIMIT_MS && stats.maxWasmMs < SLICE_CLOCK_LIMIT_MS + LATE_MS;
  assert.ok(byThread || byClock, `the slice took ${Math.round(stats.maxCpuMs)} ms of the thread's time, ${Math.round(stats.maxWasmMs)} ms by the clock`);
  assert.ok(stats.maxWasmMs < SLICE_CLOCK_LIMIT_MS + LATE_MS, `the slice took ${Math.round(stats.maxWasmMs)} ms by the clock`);
}

/** Runs `script` as an app at bar speed until it exits; returns how and when, its log and its stats. */
async function run(firmware, script, { waitMs = SLICE_LIMIT_MS + 10_000, onConsole = () => {} } = {}) {
  const log = [];
  let overdue = null;
  let runtime;
  const reason = await new Promise((resolve) => {
    runtime = new AppRuntime({
      firmware,
      appId: "app.test.watchdog",
      heapKib: 96,
      entry: "/test.js",
      readFile: (p) => (p === "/test.js" ? new TextEncoder().encode(script) : null),
      writeFile: () => false,
      localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
      onConsole: (severity, text) => {
        log.push(`${severity}: ${text}`);
        onConsole(text);
      },
      onLog: (level, tag, text) => log.push(`[${tag}] ${text}`),
      onOverdue: (ms) => (overdue = ms),
      onExit: resolve,
      speed: barSpeed(),
    });
    runtime.start();
    setTimeout(resolve, waitMs, "still running");
  });
  runtime.terminate();
  return { reason, log, overdue, stats: runtime.stats };
}

describe("the watchdog stops an app whose JS does not return", () => {
  for (const name of firmwares) {
    test(`${name}: a loop in the script itself`, async () => {
      const firmware = await loadFirmware(name);
      const { reason, overdue, stats } = await run(firmware, "for (;;) {}");
      assert.equal(reason, `stopped: did not return for ${SLICE_LIMIT_MS / 1000} s`);
      assert.equal(overdue, SLICE_LIMIT_MS);
      // The slice that was stopped, from its start to its end.
      stoppedAtLimit(stats);
    });

    test(`${name}: a loop in a timer, and the thread is free right after the stop`, async () => {
      const firmware = await loadFirmware(name);
      // A timer of this process set as the loop begins, due at once: it can run only once the app has been stopped.
      let freed = false;
      const loop = "setTimeout(function () { console.log('loop'); while (true) {} }, 100);";
      const { reason, log, stats } = await run(firmware, loop, { onConsole: (text) => text === "loop" && setTimeout(() => (freed = true), 0) });
      // onExit comes in the slice that was stopped; the timer, at the next turn of this thread.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(reason, `stopped: did not return for ${SLICE_LIMIT_MS / 1000} s`);
      stoppedAtLimit(stats);
      assert.ok(freed, "this process's timer, due while the app looped, ran right after the stop");
      // The firmware's own words for a script it aborts, as after a long Back on a bar.
      assert.ok(log.some((line) => /aborted/.test(line)), log.join("\n"));
    });

    test(`${name}: a loop that gets little of the processor is stopped by the clock`, async () => {
      const firmware = await loadFirmware(name);
      // Each round a millisecond or so of work, then the host holds the thread 10 ms without using the processor, as
      // a computer busy with other programs takes it from the JS: the thread's time grows a tenth as fast as the clock.
      const asleep = new Int32Array(new SharedArrayBuffer(4));
      const loop = "for (;;) { for (var i = 0; i < 20000; i++) {} console.log('round'); }";
      const { reason, stats } = await run(firmware, loop, { onConsole: () => Atomics.wait(asleep, 0, 0, 10) });
      assert.equal(reason, `stopped: did not return for ${SLICE_LIMIT_MS / 1000} s`);
      assert.ok(stats.maxWasmMs >= SLICE_CLOCK_LIMIT_MS && stats.maxWasmMs < SLICE_CLOCK_LIMIT_MS + LATE_MS, `the slice took ${Math.round(stats.maxWasmMs)} ms by the clock`);
      assert.ok(stats.maxCpuMs < SLICE_LIMIT_MS, `the slice took ${Math.round(stats.maxCpuMs)} ms of the thread's time`);
    });

    test(`${name}: JS that takes long but returns within the limit runs to its end`, async () => {
      const firmware = await loadFirmware(name);
      // How long a loop of this computer takes, to make one of about 40 % of the limit. A quarter of a second or so:
      // Windows counts a thread's time in steps of 15.6 ms.
      const probe = await run(firmware, "var n = 0; for (var i = 0; i < 1000000; i++) n = (n + i) | 0; console.log('n ' + n);");
      assert.equal(probe.reason, "finished");
      const rounds = Math.round((1000000 * SLICE_LIMIT_MS * 0.4) / Math.max(probe.stats.maxCpuMs, 1));
      const long = await run(firmware, `var n = 0; for (var i = 0; i < ${rounds}; i++) n = (n + i) | 0; console.log('done');`);
      assert.equal(long.reason, "finished", long.log.join("\n"));
      assert.deepEqual(long.log, ["log: done"]);
      assert.equal(long.overdue, null);
      // It did hold the thread for a good part of the limit.
      assert.ok(long.stats.maxCpuMs > SLICE_LIMIT_MS * 0.15, `the slice took ${Math.round(long.stats.maxCpuMs)} ms of the thread's time`);
    });
  }
});

// A chain of promise reactions that never ends has no backward branch: JerryScript's job queue never empties, and
// before the watchdog was also asked between jobs (patches.mjs) the app held the server's thread for good. Tasks for
// Notion without a token did it (its read() returns at once, and the .then() after it starts the next read).
describe("the watchdog stops an app whose promise jobs never end", () => {
  for (const name of firmwares) {
    test(`${name}: a .then() that starts the next one`, async () => {
      const firmware = await loadFirmware(name);
      const { reason, overdue, stats } = await run(firmware, "function next() { Promise.resolve().then(next); } next();");
      assert.equal(reason, `stopped: did not return for ${SLICE_LIMIT_MS / 1000} s`);
      assert.equal(overdue, SLICE_LIMIT_MS);
      stoppedAtLimit(stats);
    });

    test(`${name}: an async function that calls itself after an await, started by a timer`, async () => {
      const firmware = await loadFirmware(name);
      const { reason, log } = await run(firmware, "async function again() { await null; again(); } setTimeout(function () { console.log('start'); again(); }, 100);");
      assert.equal(reason, `stopped: did not return for ${SLICE_LIMIT_MS / 1000} s`);
      assert.ok(log.includes("log: start"), log.join("\n"));
    });

    test(`${name}: many promise jobs that end run to their end`, async () => {
      const firmware = await loadFirmware(name);
      const { reason, log, overdue } = await run(firmware, "var n = 0; function next() { if (++n < 20000) Promise.resolve().then(next); else console.log('done ' + n); } next();");
      assert.equal(reason, "finished", log.join("\n"));
      assert.deepEqual(log, ["log: done 20000"]);
      assert.equal(overdue, null);
    });
  }
});
