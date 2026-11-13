// An app whose JS never returns (for (;;) {}), on the server as its command line runs it (the codebase audit of
// 2026-11-11: such an app held the server until SIGKILL). The app's JS shares the server's only thread, so the
// emulator's watchdog stops it after SLICE_LIMIT_MS (runtime.mjs), as a long Back stops it on a bar:
// - a request made while the app loops is answered once the app is stopped, and the server answers as usual after;
// - the log says why the app ended, and the bar is back at the app's page in the APPS menu, as after a long Back;
// - buttons pressed while the app held the thread were the hung app's: they do not reach the APPS menu (a long Back
//   held during the loop would otherwise come as a Back that leaves the app's page);
// - SIGTERM or SIGINT sent while the app loops stops the server the usual way once the app is stopped: the exit code of
//   the signal, the data folder's lock let go of.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { SLICE_LIMIT_MS } from "../../packages/server/runtime.mjs";
import { finish, get, installApp, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const windows = process.platform === "win32";
const ID = "app.test.loop";
// The loop starts half a second after the launch, once the app runs. Its line goes out before the loop holds the
// server's thread: the server writes its log to stdout as it comes.
const LOOP = "console.log('started'); setTimeout(function () { console.log('looping'); for (;;) {} }, 500);";
// How much later than the limit an answer may come: the stop itself is within a millisecond of the limit (the
// halt handler asks every few thousand backward branches), the rest is a loaded machine.
const LATE_MS = 3000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server as its command line, on a data folder of its own, at bar speed; the app installed. */
async function serve(t) {
  const dataDir = tempDir(t);
  const child = node(t, [serverModule("index.mjs"), "--port", String(port(0)), "--data", dataDir], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (err += text));
  let ended = false;
  child.exit.then(() => (ended = true));
  const address = await until("the server's first line", () => /^BUSY Bar emulator: http:\/\/127\.0\.0\.1:(\d+) /.exec(out) ?? (ended && "ended"), 30000);
  assert.notEqual(address, "ended", `the server did not start: ${err}`);
  const base = `http://127.0.0.1:${address[1]}`;
  await installApp(base, ID, LOOP);
  return { child, base, dataDir, out: () => out, err: () => err };
}

/**
 * Launches the app and waits until its loop has begun: this launch's line that says so, not the line of a launch
 * before. Returns performance.now() then, no earlier than the loop's start.
 *
 * It waited for the line "started" and then 700 ms before (EMU-294, the release's gate of 13.11): a second launch in
 * one test found the first launch's line at once, and on a loaded computer the app started again more than 200 ms
 * slower than the 700 ms allowed, so the presses meant for the loop came before it, reached the app and, after the
 * stop, the APPS menu.
 */
async function launchLoop(server) {
  const loops = () => server.out().split(`${ID} log: looping`).length - 1;
  const before = loops();
  assert.equal((await request("POST", `${server.base}/api/apps/launch?app_id=${ID}`)).status, 200);
  await until("the app's loop", () => loops() > before);
  return performance.now();
}

const running = async (base) => (await get(`${base}/_emu/state`)).json().running;
// Both displays, as the bar's API gives them.
const screens = async (base) => [(await get(`${base}/api/screen?display=0`)).text, (await get(`${base}/api/screen?display=1`)).text];

test("an app that loops for ever is stopped within the limit, and the server answers during and after", async (t) => {
  const server = await serve(t);
  const loop = await launchLoop(server);
  const asked = performance.now();
  const answer = await get(`${server.base}/api/version`);
  const answered = performance.now();
  assert.equal(answer.status, 200);
  assert.ok(answered - loop < SLICE_LIMIT_MS + LATE_MS, `answered ${Math.round(answered - loop)} ms after the loop began`);
  assert.ok(answered - asked > 500, "the request waited for the loop: the test did not see the hang");
  assert.equal(await running(server.base), null, "the app is not running");
  assert.match(server.out(), new RegExp(`App ${ID}: emulator: the app's JS ran ${SLICE_LIMIT_MS / 1000} s without returning and was stopped`));
  assert.match(server.out(), new RegExp(`App ${ID} exited: stopped: did not return for ${SLICE_LIMIT_MS / 1000} s;`));
  // Back where a long Back takes the bar: the app's page in the APPS menu. A short Back from there goes further.
  await pause(300);
  const stopped = await screens(server.base);
  assert.equal((await request("POST", `${server.base}/api/input?key=back`)).status, 200);
  await pause(500);
  assert.notDeepEqual(await screens(server.base), stopped, "a Back after the stop reaches the APPS menu");
  assert.equal((await get(`${server.base}/api/version`)).status, 200);
  assert.equal(server.err(), "");
});

test("buttons pressed while the app loops do not reach the APPS menu after the stop", async (t) => {
  const server = await serve(t);
  // The app's page with Start highlighted, where the watchdog's stop leaves the bar: an OK there starts the app again.
  await launchLoop(server);
  assert.equal((await request("POST", `${server.base}/api/input?key=ok`)).status, 200);
  await pause(1000);
  assert.equal(await running(server.base), null, "the OK pressed during the loop did not start the app again");
  // The window's long Back, held and let go of during the loop, goes nowhere either: the screen stays.
  const loop = await launchLoop(server);
  const down = request("POST", `${server.base}/_emu/key?key=back&action=down`).then((answer) => ({ answer, at: performance.now() }));
  const up = pause(400).then(() => request("POST", `${server.base}/_emu/key?key=back&action=up`));
  const [held, letGo] = await Promise.all([down, up]);
  assert.equal(held.answer.status, 200);
  assert.equal(letGo.status, 200);
  assert.ok(held.at - loop > 500, "the press waited for the loop: the test did not see the hang");
  await pause(500);
  const stopped = await screens(server.base);
  await pause(500);
  assert.deepEqual(await screens(server.base), stopped);
  // A press after the stop does reach the menu: this OK starts the app.
  assert.equal((await request("POST", `${server.base}/api/input?key=ok`)).status, 200);
  await until("the app's start", async () => (await running(server.base)) !== null, 3000);
});

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  test(`${signal} while the app loops stops the server once the app is stopped: exit code ${code}, the lock let go of`, { skip: windows && "Windows has no signals to send to a process" }, async (t) => {
    const server = await serve(t);
    const loop = await launchLoop(server);
    assert.ok(existsSync(join(server.dataDir, "run", "server.lock")));
    server.child.kill(signal);
    assert.equal(await server.child.exited(SLICE_LIMIT_MS + 10_000), code, server.err());
    assert.ok(performance.now() - loop < SLICE_LIMIT_MS + 10_000);
    assert.ok(!existsSync(join(server.dataDir, "run", "server.lock")), "the lock is let go of");
    assert.equal(server.err(), "");
  });
}
