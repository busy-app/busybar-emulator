// Two edges of an app's timers at bar speed (EMU-357), both from the firmware's event loop (event_loop_timer.c,
// event_loop.c, js_interval.c; the same in 1.3.1 and 1.4.1).
//
// A cleared timer never runs: clearTimeout frees the timer with a request to the loop, and an expired timer with a free
// request waiting is skipped (furi_event_loop_process_expired_timers) until the loop frees it. On the bar its memory is
// freed only then, so a setTimeout made meanwhile has another address. The emulator's firmware frees it at once
// (furi_shim.c), and the next setTimeout may get the same address, the key the emulator knows the timer by: a run of the
// cleared timer that was still waiting for the app kept the new timer's run out of the queue, and the new timer never
// ran. The cleared run stays a turn of the loop's until the loop takes the request, as the skipped timer on the bar.
//
// An expired timer runs before the next round takes the timer requests: the round of a message hands the app the
// message, then runs one expired timer, and what the message asked for waits for the next round, after that timer's
// callback. The host's timer of an app's timer can fire a fraction of a ms early and wait again (arm), and the drain
// must not take the requests while a timer due by then is still on its way into the queue.
//
//   node --test "packages/server/test/runtime-timer-edges.test.mjs"      (from emulator/)
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

const BUSY = "const busy = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms); };";

// Three timers count before the keys come; the first key keeps the app busy past all three. Then, by the loop's turns:
// the first timer, the second key (it clears the third timer and starts "b", which may get the cleared one's address),
// the second timer (busy, so "b" falls due meanwhile), then "b". The third timer never runs.
const REUSED = `${BUSY}
  let n = 0, a;
  setTimeout(() => console.log("t0"), 10);
  setTimeout(() => { console.log("t1"); busy(1000); }, 15);
  a = setTimeout(() => console.log("a"), 20);
  const unbind = listen("input", () => {
    n++;
    if (n === 1) busy(1000);
    else { clearTimeout(a); setTimeout(() => console.log("b"), 10); unbind(); }
  });`;

// The same, where the key that clears the timer comes in a round that read no Timer flag (the round before asked for
// nothing: the first timer is periodic and is not freed). Its round does not take the free request, and its timer turn
// finds the cleared timer at the front of the loop's list: it runs no timer (process_expired_timers skips a timer with
// a free request waiting). The next round reads the flag, frees it, hands the app the third key, then runs "b".
const SKIPPED = `${BUSY}
  let n = 0, a, tick;
  tick = setInterval(() => {}, 10);
  a = setTimeout(() => console.log("a"), 12);
  setTimeout(() => console.log("b"), 20);
  const unbind = listen("input", () => {
    n++;
    if (n === 1) busy(1000);
    else if (n === 2) { clearTimeout(a); console.log("k2"); }
    else { clearInterval(tick); console.log("k3"); unbind(); }
  });`;

// A timer that falls due while the first key keeps the app busy (its callback works 500 ms of the bar), and a key that
// starts a 100 ms timer as it begins its own 1 s. On the bar the key's round runs the expired timer after the key, and
// the next round takes the key's request: the key's timer counts from the end of the expired timer's callback (the
// anchor), not from the end of the key.
const RACE = `${BUSY}
  let end;
  setTimeout(() => { busy(500); end = Date.now(); }, 20);
  const unbind = listen("input", () => {
    setTimeout(() => console.log("fired " + (Date.now() - end)), 100);
    busy(1000);
    console.log("key");
    unbind();
  });`;

function runtimeFor(firmware, script, lines, resolve) {
  return new AppRuntime({
    firmware,
    appId: "app.test.timeredges",
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
}

/** Runs the app: `prepare(runtime)` once its script is over, then, once its timers count, `keys` keys at once. */
async function run(firmware, script, { keys, prepare = () => {} }) {
  const lines = [];
  let runtime;
  const ended = new Promise((resolve) => (runtime = runtimeFor(firmware, script, lines, resolve)));
  await runtime.start();
  prepare(runtime, lines);
  // The script's timers count from its end (startTimers, once the app is free): the keys come after.
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < keys; i++) runtime.input(InputKey.ok, InputType.short);
  // Not unref'd: a timer the emulator lost leaves nothing else to keep the process alive.
  let wait;
  const reason = await Promise.race([ended, new Promise((resolve) => (wait = setTimeout(() => resolve("still running after 6 s"), 6000)))]);
  clearTimeout(wait);
  runtime.terminate();
  return { reason, lines };
}

/**
 * The firmware's malloc gives the timer the app starts after a clearTimeout an address of its own (calloc after free
 * is free to): the host's key of the first timer the app starts after it stops one is made the stopped one's, and
 * the runtime's calls back are given the timer's own address.
 */
function reuseAddress(runtime, lines) {
  const M = runtime.M;
  const { timerStart, timerStop } = M.host;
  const fire = M._emu_timer_fire;
  const address = new Map(); // key → the timer's own address
  let stopped = null;
  M.host.timerStop = (timer) => {
    stopped = timer;
    timerStop(timer);
  };
  M.host.timerStart = (timer, ms, periodic) => {
    const key = stopped ?? timer;
    stopped = null;
    if (key !== timer) lines.push("same key");
    address.set(key, timer);
    timerStart(key, ms, periodic);
  };
  M._emu_timer_fire = (key) => fire(address.get(key) ?? key);
}

/**
 * The host's timer of the timer the script started fires early and waits again (arm) for as long as the first key's
 * slice has not ended a few ms ago in the computer's time: the drain is free to take the key's request before that
 * timer is in the queue, as when Node fires a fraction of a ms early.
 */
function lateIntoQueue(runtime, lines) {
  const arm = runtime.arm.bind(runtime);
  runtime.arm = (t, delay) => {
    const held = t.ms === 20 && !(lines.includes("key") && runtime.wall() > runtime.busyUntil + 3);
    if (!held) return arm(t, delay);
    clearTimeout(t.handle);
    t.handle = setTimeout(() => {
      t.handle = null;
      runtime.arm(t);
    }, 1);
  };
}

// Date.now() is read in whole ms at either end, and a slice's own work moves it on a little.
const near = (got, want) => Math.abs(got - want) <= 3;

for (const name of firmwares) {
  describe(`firmware ${name}: the edges of an app's timers`, () => {
    const firmware = loadFirmware(name);

    test("a cleared timer's run waiting for the app does not keep out a new timer at its address", async () => {
      const got = await run(firmware, REUSED, { keys: 2, prepare: reuseAddress });
      // Before EMU-357 "b" never ran, and the app went on waiting for it.
      assert.deepEqual(got, { reason: "finished", lines: ["t0", "same key", "t1", "b"] });
    });

    test("a cleared timer at the front of the list keeps its round's turn until the loop takes the request", async () => {
      const got = await run(firmware, SKIPPED, { keys: 3 });
      // Had the cleared run gone from the queue at once, "b" would have run in that turn, before the third key.
      assert.deepEqual(got, { reason: "finished", lines: ["k2", "k3", "b"] });
    });

    test("the next round takes the timer requests after the expired timer, though it comes into the queue late", async () => {
      const got = await run(firmware, RACE, { keys: 1, prepare: lateIntoQueue });
      assert.equal(got.reason, "finished");
      // Before EMU-357 the key's timer counted from the end of the key and ran at once after the expired one: "fired 0".
      const fired = got.lines.map((line) => /^fired (-?\d+)$/.exec(line)?.[1]).filter(Boolean).map(Number);
      assert.ok(got.lines[0] === "key" && fired.length === 1 && near(fired[0], 100), `got ${JSON.stringify(got.lines)}, want ["key", "fired 100"] (within 3 ms)`);
    });
  });
}
