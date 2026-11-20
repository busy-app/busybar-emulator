// When an app's timer starts counting, at bar speed (EMU-356). On a BUSY Bar setTimeout and setInterval (js_interval.c)
// call furi_event_loop_timer_start, which only queues a request to the event loop (event_loop_timer.c); the timer
// counts from when the loop takes the request, start_time = xTaskGetTickCount() in
// furi_event_loop_process_timer_queue. The loop (furi_event_loop_run, event_loop.c) reads its flags as a round begins,
// hands the app one message if one is ready, takes the timer requests if the Timer flag was among those it read, and
// runs one expired timer. So a timer started in a long piece of JS counts from the end of that piece, not from the
// call: after the message of the round that follows, if one is ready then and the round before asked for no timer.
// A periodic timer keeps the beat it started on (process_expired_timers: start_time += interval * events).
//
// Each case prints how long after an anchor (the end of a slice, read with Date.now() as it ends) its timer ran.
//
//   node --test "packages/server/test/runtime-timer-start.test.mjs"      (from emulator/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { barSpeed } from "../bar-speed.mjs";
import { loadFirmware } from "../firmware.mjs";
import { AppRuntime, InputKey, InputType } from "../runtime.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const firmwares = Object.keys(JSON.parse(readFileSync(join(server, "../engine/firmware.json"), "utf8")).versions);

// The ms after the anchor each run comes at, by firmware, written from its source: event_loop_timer.c, event_loop.c
// and js_interval.c are the same in 1.3.1 and 1.4.1. A firmware not in this table fails the test until its line is
// written from its own source. Before EMU-356 the emulator counted from the call: the timer was due during the slice
// and ran as soon as the app was free (1 or 2 ms, the interval's runs then at 201 or 202), and the keys' timer ran
// between the two keys, before the anchor was set ("fired NaN").
const SAME = {
  // A 200 ms setTimeout made as the app's script starts, which then works for 1 s of the bar's time.
  script: ["fired 200"],
  // The same in a timer's callback.
  timeout: ["fired 200"],
  // A 200 ms setInterval made as a 1 s slice starts: its first run 200 ms after the slice, the next on that beat.
  interval: ["fired 200", "fired 400"],
  // Two keys at once, the first starts a 200 ms timer and works 1 s, the second works 0.5 s: the round of the second
  // key takes the request after its message, so the timer counts from the end of the second slice (the anchor).
  keys: ["fired 200"],
  // The same after a key that asked for a timer of its own: the first key's round read the Timer flag set and takes
  // the request when that key's slice is over; the timer is due during the second key's slice and runs at its end.
  keysAfterRequest: ["fired 0"],
  // Started and stopped in one slice: the request is replaced before the loop takes it, nothing runs, nothing is said.
  cleared: ["done"],
};
const EXPECTED = { "1.3.1": SAME, "1.4.1": SAME };

// Busy for the bar's time of ms: Date.now() advances by the work done (bar-speed.mjs).
const BUSY = "const busy = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms); };";
const KEYS = (first) => `${BUSY}
  let n = 0, end;
  const report = () => console.log("fired " + (Date.now() - end));
  const unbind = listen("input", () => {
    n++;
    if (n === ${first}) { setTimeout(report, 200); busy(1000); }
    else if (n === ${first} + 1) { busy(500); end = Date.now(); unbind(); }
    else setTimeout(() => {}, 1500);
  });`;

const CASES = {
  script: { keys: 0, script: `${BUSY} let end; setTimeout(() => console.log("fired " + (Date.now() - end)), 200); busy(1000); end = Date.now();` },
  timeout: {
    keys: 0,
    script: `${BUSY} let end; setTimeout(() => { setTimeout(() => console.log("fired " + (Date.now() - end)), 200); busy(1000); end = Date.now(); }, 10);`,
  },
  interval: {
    keys: 0,
    script: `${BUSY} let end, runs = 0;
      setTimeout(() => {
        const id = setInterval(() => { console.log("fired " + (Date.now() - end)); if (++runs === 2) clearInterval(id); }, 200);
        busy(1000); end = Date.now();
      }, 10);`,
  },
  // The keys come together once the script is over; the app ends with its last timer, the listener gone.
  keys: { keys: 2, script: KEYS(1) },
  keysAfterRequest: { keys: 3, script: KEYS(2) },
  cleared: { keys: 0, script: `${BUSY} clearTimeout(setTimeout(() => console.log("fired"), 200)); busy(1000); setTimeout(() => console.log("done"), 300);` },
};

async function run(firmware, { script, keys }) {
  const lines = [];
  let runtime;
  const ended = new Promise((resolve) => {
    runtime = new AppRuntime({
      firmware,
      appId: "app.test.timerstart",
      heapKib: 96,
      entry: "/test.js",
      readFile: (p) => (p === "/test.js" ? new TextEncoder().encode(script) : null),
      writeFile: () => false,
      localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
      onConsole: (_, text) => lines.push(text),
      onLog: (_, tag, text) => tag === "JsInterval" && lines.push(`${tag} ${text}`),
      onExit: resolve,
      speed: barSpeed(firmware.name),
    });
  });
  await runtime.start();
  for (let i = 0; i < keys; i++) runtime.input(InputKey.ok, InputType.short);
  const reason = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still running after 10 s"), 10_000).unref())]);
  runtime.terminate();
  return { reason, lines };
}

// Date.now() is read in whole ms at either end, and a slice's own work moves it on a little.
const near = (got, want) =>
  got.length === want.length &&
  got.every((line, i) => {
    const [g, w] = [/^fired (-?\d+)$/.exec(line), /^fired (-?\d+)$/.exec(want[i])];
    return g && w ? Math.abs(Number(g[1]) - Number(w[1])) <= 3 : line === want[i];
  });

for (const name of firmwares) {
  describe(`firmware ${name}: a timer counts from when the event loop takes it`, () => {
    const firmware = loadFirmware(name);
    const want = EXPECTED[name];

    for (const [what, c] of Object.entries(CASES)) {
      test(what, async () => {
        assert.ok(want, `no line in EXPECTED for firmware ${name}`);
        const got = await run(firmware, c);
        assert.equal(got.reason, "finished");
        assert.ok(near(got.lines, want[what]), `got ${JSON.stringify(got.lines)}, want ${JSON.stringify(want[what])} (within 3 ms)`);
      });
    }
  });
}
