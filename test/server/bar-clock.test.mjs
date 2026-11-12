// The bar's clock on a real server when the computer's clock is set or the computer sleeps (EMU-235): the firmware's
// own clock (GET /api/time), the state stream's time, the boot time in /api/status and an app's Date.now() are one
// clock, within a second of the computer's time of day; the ticks never go back, and the ticks of a jump forward are
// skipped, not played. The computer's clocks are the process's (computer-clock.mjs): the test moves them by swapping
// what the process's ComputerClock reads, and puts them back after.
//
//   node --test emulator/test/server/bar-clock.test.mjs      [EMU_TEST_PORTS=8701-8709] the ports to use
import assert from "node:assert/strict";
import { test } from "node:test";

import { computerClock, computerNow, MAX_APART_MS } from "../../packages/server/computer-clock.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { MAX_CATCH_UP_MS } from "../../packages/server/tick-clock.mjs";
import { get, installApp, port, request, tempDir, until } from "./helpers.mjs";

const HOUR = 3_600_000;
const TICK_MS = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The computer's clocks as the test sets them: `set` ms from the real time of day; sleep(ms) stops the process for
 * that long with its monotonic clock standing still meanwhile, as a computer whose monotonic clock does not count
 * sleep (computer-clock.mjs) sleeps.
 */
function moveClocks(t) {
  const kept = { ...computerClock };
  const { monotonic, timeOfDay } = computerClock;
  const moved = { set: 0, stood: 0 };
  computerClock.timeOfDay = () => timeOfDay() + moved.set;
  computerClock.monotonic = () => monotonic() - moved.stood;
  moved.sleep = (ms) => {
    const end = monotonic() + ms;
    while (monotonic() < end); // nothing in the process runs: the server is asleep with it
    moved.stood += ms;
  };
  // Afterwards the process's clock is as it was: the next test does not start an hour ahead.
  t.after(() => Object.assign(computerClock, kept));
  return moved;
}

/**
 * How far the computer's time of day is ahead of the ticks' clock now, ms. Not 0: the process's monotonic reference
 * (performance.timeOrigin) and the time of day are read at different moments of its start, and on a busy computer
 * tens of ms apart, always with the monotonic clock ahead; within MAX_APART_MS nothing corrects that
 * (computer-clock.mjs). A jump of the time of day by `ms` therefore moves the ticks' clock by `ms` plus this, and the
 * ticks skipped are counted from that.
 */
const timeOfDayAhead = () => computerClock.timeOfDay() - computerNow();

/**
 * A server with an app that prints Date.now() every 50 ms; `bar()` reads every clock the bar shows, each with the
 * computer's time of day as it was read, plus the ticks' clock and counts.
 */
async function emulator(t) {
  const lines = [];
  const server = await startServer({ port: port(0), dataDir: tempDir(t), log: (line) => lines.push([computerClock.timeOfDay(), line]) });
  t.after(() => server.stop());
  await installApp(server.url, "app.test.clock", "setInterval(() => console.log('now ' + Date.now()), 50);");
  assert.equal((await request("POST", `${server.url}/api/apps/launch?app_id=app.test.clock`)).status, 200);
  const appNow = async () => {
    // The first line the app prints from here on (by the order of the lines: the clock may have been set back).
    const from = lines.length;
    const [at, line] = await until("a line of the app after now", () => lines.slice(from).find(([, l]) => / now \d+/.test(l)));
    return { at, value: Number(line.match(/ now (\d+)/)[1]) };
  };
  const streamNow = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/status/ws`);
    ws.binaryType = "arraybuffer";
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    const message = new Promise((resolve) => (ws.onmessage = (e) => resolve(new Uint8Array(e.data))));
    const at = computerClock.timeOfDay();
    ws.send(JSON.stringify({ enable: true }));
    const bytes = await message;
    ws.close();
    // State.timestamp: field 1, fixed64, first in the message.
    assert.equal(bytes[0], 0x09);
    return { at, value: Number(new DataView(bytes.buffer, bytes.byteOffset + 1, 8).getBigUint64(0, true)) };
  };
  const apiNow = async () => {
    const at = computerClock.timeOfDay();
    return { at, value: Date.parse((await get(`${server.url}/api/time`)).json().timestamp) };
  };
  const clock = async () => (await get(`${server.url}/_emu/state`)).json().clock;
  /**
   * The app's next `n` values of Date.now(), one from each run of its 50 ms timer: the steps between them, and for
   * each step how far behind the computer's time of day the app was at the line after it (ms).
   */
  const appSteps = async (n) => {
    const from = lines.length;
    const seen = await until(`${n} lines of the app`, () => {
      const found = lines.slice(from).flatMap(([at, l]) => (/ now (\d+)/.test(l) ? [[at, Number(l.match(/ now (\d+)/)[1])]] : []));
      return found.length >= n && found.slice(0, n);
    });
    return seen.slice(1).map(([at, v], i) => ({ step: v - seen[i][1], behind: at - v }));
  };
  return { server, appNow, streamNow, apiNow, clock, appSteps };
}

/** Each of the bar's clocks is the computer's time of day as it was read, within the allowed second (and the API's whole seconds). */
async function sameAsComputer(bar, label) {
  const api = await bar.apiNow();
  assert.ok(api.at - api.value >= -MAX_APART_MS && api.at - api.value < 1000 + MAX_APART_MS, `${label}: GET /api/time is ${api.value - api.at} ms from the computer's`);
  const stream = await bar.streamNow();
  assert.ok(Math.abs(stream.value - stream.at) <= MAX_APART_MS, `${label}: the state stream is ${stream.value - stream.at} ms from the computer's`);
  const app = await bar.appNow();
  // The app prints every 50 ms and its line is read at the next look (until(): every 50 ms).
  assert.ok(Math.abs(app.value - app.at) <= MAX_APART_MS + 200, `${label}: the app's Date.now() is ${app.value - app.at} ms from the computer's`);
}

test("the computer's clock set forward an hour, then back two, then right: the bar's clocks follow, the ticks never go back", async (t) => {
  const moved = moveClocks(t);
  const bar = await emulator(t);
  await sleep(500);
  await sameAsComputer(bar, "at the start");

  // Forward: the hour's ticks are skipped, not played; the ticks' clock jumps with the computer's.
  let before = await bar.clock();
  const jump = HOUR + timeOfDayAhead();
  moved.set = HOUR;
  await sleep(1000);
  let after = await bar.clock();
  await sameAsComputer(bar, "an hour forward");
  assert.ok(after.skipped - before.skipped >= (jump - 500) / TICK_MS - 1, `${after.skipped - before.skipped} ticks skipped of a jump of ${jump} ms`);
  assert.ok(after.ticks - before.ticks <= (1000 + 500) / TICK_MS + 30, `${after.ticks - before.ticks} ticks played in a second`);
  assert.ok(after.now - before.now >= jump);
  // And the app's timer keeps the app's own time again: each run a period after the one before, by the app's clock,
  // whenever the computer's timer fired (runtime.mjs).
  // A step may be longer only by the rule of runtime.mjs: a computer too busy to run the timer on time (the host's
  // timer drops the runs it was late for, the app's due times do not) leaves the app behind its clock, and once that
  // is more than the ticks make up (MAX_CATCH_UP_MS) the timer goes on from now. Such a step is more than that plus a
  // period, and after it the app is on the computer's time again; an hour's jump is neither.
  const steps = await bar.appSteps(12);
  const said = `the app's timer, by its Date.now(): ${steps.map((s) => `${s.step} (${s.behind} behind)`).join(", ")} ms apart`;
  assert.ok(steps.every(({ step, behind }) => Math.abs(step - 50) <= 1 || (step >= MAX_CATCH_UP_MS + 50 && step < 2 * MAX_CATCH_UP_MS + 50 && behind < MAX_CATCH_UP_MS)), said);

  // Back two hours: the ticks go on as before, none skipped, their clock does not go back; the bar's clock does.
  before = await bar.clock();
  moved.set = -HOUR;
  await sleep(1000);
  after = await bar.clock();
  await sameAsComputer(bar, "an hour back");
  assert.equal(after.skipped, before.skipped);
  assert.ok(after.now > before.now && after.now - before.now < 3000, `the ticks' clock moved ${after.now - before.now} ms`);

  // Right again.
  before = after;
  moved.set = 0;
  await sleep(1000);
  after = await bar.clock();
  await sameAsComputer(bar, "put right");
  assert.equal(after.skipped, before.skipped);
});

test("a sleep in which the monotonic clock stands still: after it the bar's clocks are right without a restart", async (t) => {
  const moved = moveClocks(t);
  const bar = await emulator(t);
  await sleep(500);
  const before = await bar.clock();
  const jump = 3000 + timeOfDayAhead();
  moved.sleep(3000);
  await sameAsComputer(bar, "after the sleep");
  const after = await bar.clock();
  // The 3 s are skipped, but for the half second that is made up; nothing ticked while the process slept.
  assert.ok(after.skipped - before.skipped >= (jump - 500) / TICK_MS - 1, `${after.skipped - before.skipped} ticks skipped of a jump of ${jump} ms`);
  assert.ok(after.now - before.now >= jump);
});

test("the boot time in /api/status is the bar's clock at the start, the uptime the ticks'", async (t) => {
  const moved = moveClocks(t);
  const bar = await emulator(t);
  const status = async () => (await get(`${bar.server.url}/api/status/system`)).json();
  const start = await status();
  moved.set = -HOUR;
  await sleep(200);
  const back = await status();
  // A clock set back changes neither: the bar booted when it booted, and has been up as long as it has.
  assert.equal(back.boot_time, start.boot_time);
  assert.ok(back.uptime >= start.uptime, `${start.uptime} → ${back.uptime}`);
  assert.ok(Math.abs(start.boot_time * 1000 - (Date.now() - 2000)) < 60_000);
});
