// Firmware threads that sleep or wait for one another, in the screen module's single thread (native/furi_shim.c,
// "waits"): the one that waits lets the others run, a wait that nothing ends is stopped, and a restart stops the
// firmware where a bar's processor resets. Each scenario runs the committed module in a process of its own
// (screen-driver.mjs) under a time limit: a module that never returns fails the test instead of hanging it.
//
//   node --test "packages/engine/test/*.test.mjs"      (from emulator/)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "..", "firmware.json"), "utf8"));
const LIMIT_MS = 30_000;

/** The outcome of a scenario of screen-driver.mjs on one firmware version. */
function play(version, scenario) {
  const run = spawnSync(process.execPath, [join(here, "screen-driver.mjs"), version, scenario], { timeout: LIMIT_MS, killSignal: "SIGKILL", encoding: "utf8" });
  assert.notEqual(run.error?.code, "ETIMEDOUT", `the screen module did not return from "${scenario}" in ${LIMIT_MS / 1000} s: a firmware thread is spinning`);
  assert.equal(run.status, 0, `"${scenario}" failed:\n${run.stderr}`);
  return JSON.parse(run.stdout);
}

/** The mean difference between the bytes of two frames given in hex. */
function distance(a, b) {
  const [x, y] = [Buffer.from(a, "hex"), Buffer.from(b, "hex")];
  assert.equal(x.length, y.length);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

for (const version of Object.keys(config.versions)) {
  describe(`waits in the screen module, firmware ${version}`, () => {
    test("the BUSY timer's service gets the BUSY program it waits for, within the request and with no time passing", () => {
      const r = play(version, "busy-start");
      assert.deepEqual(r.before, ["Power On", "apps_menu"], "the bar settled in the apps menu");
      assert.deepEqual(r.put, { status: 200, body: '{"result":"OK"}' });
      // The desktop took its turn while the timer's service waited: the apps menu is closed and the BUSY program runs.
      assert.deepEqual(r.after, ["Power On", "apps_menu", "busy"]);
      const { snapshot } = JSON.parse(r.get.body);
      assert.equal(r.get.status, 200);
      assert.equal(snapshot.type, "SIMPLE");
      assert.equal(snapshot.is_paused, false);
      assert.equal(snapshot.time_left_ms, 600000);
      assert.deepEqual(r.halts, []);
      assert.deepEqual(r.errors, []);
    });

    test("a thread that sleeps a hundred times in a row comes back, and its loop takes no message while it sleeps", () => {
      const r = play(version, "sleeps-100");
      // -1 would say that the second message in the thread's queue reached it before it was done with the first.
      assert.equal(r.returned, 100);
      assert.deepEqual(r.halts, []);
      assert.deepEqual(r.errors, []);
    });

    test("a sleep lets the GUI draw: a timer set paused from the apps menu shows the timer's screen behind PAUSED, as one paused while running does", () => {
      const [atOnce, whileRunning, appsMenu] = ["paused-at-once", "paused-while-running", "apps-menu"].map((scenario) => play(version, scenario));
      assert.deepEqual(atOnce.put, { status: 200, body: '{"result":"OK"}' });
      assert.deepEqual(whileRunning.put, { status: 200, body: '{"result":"OK"}' });
      // The picture behind PAUSED is a blurred copy of the screen, taken after the BUSY program slept for the GUI to
      // draw it. Without that drawing it is a copy of what was there before, the apps menu. Distances are the mean
      // difference of the frames' bytes (0-255): 4.9 between the two paused screens, 46 from either to the apps menu;
      // with no drawing in the sleep the first becomes 20.6.
      assert.ok(distance(whileRunning.front, appsMenu.front) > 30, "the paused timer's screen is not the apps menu's");
      assert.ok(distance(atOnce.front, whileRunning.front) < 10, `the two paused screens are alike: ${distance(atOnce.front, whileRunning.front).toFixed(1)}`);
    });

    test("waits of calls that follow one another do not add up to the limit", () => {
      const r = play(version, "sleeps-in-calls");
      assert.deepEqual(r.returned, [6000, 6000, 6000]);
      assert.deepEqual(r.halts, []);
      assert.deepEqual(r.errors, []);
    });

    test("a thread that never stops waiting is stopped: the module says so in the log and halts as stuck", () => {
      const r = play(version, "sleeps-forever");
      assert.equal(r.returned, undefined);
      assert.match(r.threw, /halted/);
      assert.deepEqual(r.halts, [true]);
      assert.equal(r.errors.length, 1);
      assert.match(r.errors[0], /^\[Emulator\] The firmware waited 10000 times in a row for something that did not happen \(the last wait: a sleep, 1 ticks\)/);
    });

    test("a restart stops the firmware inside power_reboot, after the host is told", () => {
      const r = play(version, "restart");
      assert.equal(r.returned, undefined);
      assert.match(r.threw, /halted/);
      assert.deepEqual(r.halts, [false]);
      assert.deepEqual(r.settings.filter(([name]) => name === "power"), [["power", "reboot"]]);
      assert.deepEqual(r.errors, []);
    });
  });
}
