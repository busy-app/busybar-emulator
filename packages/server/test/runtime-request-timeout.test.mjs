// A request to the bar's own API with a timeout, as the BusyBar client of @busy-app/busy-lib 0.21.1 makes every one
// (createApiClient's execute: a 3 s setTimeout that calls `new AbortController().abort(new DOMException(...))`, and
// clearTimeout in `finally`), while the app is busy for longer than the timeout before it takes the answer: as an app
// is while it reads a year of a calendar over TLS and parses it (EMU-344).
//
// On a BUSY Bar AbortController and DOMException are stubs (js_stubs.c: constructors that make an empty object), so the
// timer's callback calls `undefined` and throws: "Uncaught: TypeError: Expected a function" in the app's console. The
// request is not stopped, and its answer comes after; `finally` clears the timer that already ran, and the firmware logs
// "Interval with ID N is not found" (js_interval.c). That the timer runs before the answer is over is the firmware's
// event loop (furi_event_loop_run): one message to the app a round, then one expired timer, so after a busy slice the
// answer's head and the timer take turns, whatever came first (runtime.mjs, nextReady). An answer with an empty body is
// two messages, its head and its end: the timer runs between them.
//
// The app is busy in a slice of its own, a timer after the request: on the bar a timer the app starts is only queued
// (furi_event_loop_timer_start) and its time counts from the loop's next round (furi_event_loop_process_timer_queue),
// so a timer started at the start of a long slice is due 3 s after the slice, not after the call. The emulator does
// the same (EMU-356, runtime-timer-start.test.mjs); here the timer is made in the script, which is short.
//
//   node --test "packages/server/test/runtime-request-timeout.test.mjs"      (from emulator/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { barSpeed } from "../bar-speed.mjs";
import { loadFirmware } from "../firmware.mjs";
import { AppRuntime } from "../runtime.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const firmwares = Object.keys(JSON.parse(readFileSync(join(server, "../engine/firmware.json"), "utf8")).versions);

// What the app's console and the firmware's log say, by firmware, written from its source: js_stubs.c makes the same
// three stubs and js_interval.c logs the same line in both. A firmware not in this table fails the test until its line
// is written from its own source.
// The lines in the order they come: the app's console and the firmware's JsInterval log together.
const late = (body) => ["head", "Uncaught: TypeError: Expected a function", "JsInterval Interval with ID 0 is not found", `drawn ${body}`];
const EXPECTED = {
  "1.3.1": { late, inTime: (body) => ["head", `drawn ${body}`] },
  "1.4.1": { late, inTime: (body) => ["head", `drawn ${body}`] },
};

const execute = `
  async function execute(requestFn, timeoutMs) {
    let timeoutId;
    const timeoutController = new AbortController();
    timeoutId = setTimeout(() => timeoutController.abort(new DOMException("Request timed out after " + timeoutMs + "ms", "TimeoutError")), timeoutMs);
    try {
      return await requestFn(timeoutController.signal);
    } finally {
      clearTimeout(timeoutId);
    }
  }
  const draw = () => execute((signal) => fetch("http://localhost/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"application_name":"app.test.timeout","elements":[]}', signal }).then((r) => { console.log("head"); return r.text(); }), 3000)
    .then((t) => console.log("drawn " + t), (e) => console.log("failed " + e));
  // Busy for the bar's time of ms: Date.now() advances by the work done (bar-speed.mjs).
  const busy = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms); };
`;

const SCRIPTS = {
  // Busy past the timeout just after the request goes out: its answer waits for the app.
  late: `${execute} draw(); setTimeout(() => busy(3500), 1);`,
  // Busy for less: the answer is taken in time, and the timer is cleared before it runs.
  inTime: `${execute} draw(); setTimeout(() => busy(500), 1);`,
};

async function run(firmware, script, body) {
  const lines = [];
  let runtime;
  const ended = new Promise((resolve) => {
    runtime = new AppRuntime({
      firmware,
      appId: "app.test.timeout",
      heapKib: 96,
      entry: "/test.js",
      readFile: (p) => (p === "/test.js" ? new TextEncoder().encode(script) : null),
      writeFile: () => false,
      localApi: async () => ({ status: 200, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode(body) }),
      onConsole: (_, text) => lines.push(text),
      onLog: (_, tag, text) => tag === "JsInterval" && lines.push(`${tag} ${text}`),
      onExit: resolve,
      speed: barSpeed(firmware.name),
    });
  });
  await runtime.start();
  // The app has nothing left to do once the answer is taken and the timer is gone: it finishes.
  const reason = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("still running after 10 s"), 10_000).unref())]);
  runtime.terminate();
  return { reason, lines };
}

for (const name of firmwares) {
  describe(`firmware ${name}: busy-lib's request timeout`, () => {
    const firmware = loadFirmware(name);
    const want = EXPECTED[name];

    // An answer with a body (head, body, end) and one without (head, end).
    for (const body of ['{"result":"OK"}', ""]) {
      const what = body ? "an answer with a body" : "an answer with an empty body";
      test(`busy past the 3 s timeout, ${what}: the head, then the timer throws, then the end, and clearTimeout finds no timer, as on a BUSY Bar`, async () => {
        assert.ok(want, `no line in EXPECTED for firmware ${name}`);
        const got = await run(firmware, SCRIPTS.late, body);
        assert.equal(got.reason, "finished");
        assert.deepEqual(got.lines, want.late(body));
      });

      test(`busy for less, ${what}: the answer comes in time and nothing is said`, async () => {
        const got = await run(firmware, SCRIPTS.inTime, body);
        assert.equal(got.reason, "finished");
        assert.deepEqual(got.lines, want.inTime(body));
      });
    }
  });
}
