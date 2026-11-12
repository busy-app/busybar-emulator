// Requests and keys after which a thread of the firmware waits for another one: the BUSY timer started through the
// API (its service waits for the BUSY program), a restart and a factory reset from the system settings (their program
// waits for the bar to go down). The emulator used to hang on each of them for good. Here a real server gets them, and
// every request has a time limit: a server that stops answering fails the test. And what the server does when a
// thread waits for something that never comes: it stops the system and restarts the bar.
//
//   node --test "packages/server/test/*.test.mjs"      (from emulator/)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { tempDir } from "../../../test/server/helpers.mjs";
import { sleep, withServer } from "./waits.test-support.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engine = join(here, "../../engine");
const config = JSON.parse(readFileSync(join(engine, "firmware.json"), "utf8"));

const SETTINGS = { theme: "on_call", show_work_phase_only: false, trigger_smart_home: false };
const CARD = "00000000-0000-0000-0000-000000000000";
// A timer's state as PUT /api/busy/snapshot takes it.
const TIMERS = {
  "a running timer": { type: "SIMPLE", card_id: CARD, time_left_ms: 600000, is_paused: false },
  "a paused timer": { type: "SIMPLE", card_id: CARD, time_left_ms: 600000, is_paused: true },
  "an endless timer": { type: "INFINITE", card_id: CARD, is_paused: false },
  "an interval timer": {
    type: "INTERVAL",
    card_id: CARD,
    is_paused: false,
    current_interval: 0,
    current_interval_time_total_ms: 1500000,
    current_interval_time_left_ms: 1500000,
    interval_settings: { interval_work_ms: 1500000, interval_rest_ms: 300000, interval_work_cycles_count: 4, is_autostart_enabled: true },
  },
};
const STOPPED = { type: "NOT_STARTED" };
// The snapshot GET /api/busy/snapshot answers with once `timer` is set at `sent`: what was sent; the firmware writes the
// interval settings with their type.
const answered = (timer, sent) => ({
  snapshot: { ...timer, ...(timer.interval_settings && { interval_settings: { type: "INTERVAL", ...timer.interval_settings } }), busy_bar_settings: SETTINGS },
  snapshot_timestamp_ms: sent,
});

// A newer snapshot has a later time stamp; the timer's service drops any other.
let lastStamp = 0;
const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

async function put(ask, timer) {
  const sent = stamp();
  const answer = await ask("PUT", "/api/busy/snapshot", JSON.stringify({ snapshot: { ...timer, busy_bar_settings: SETTINGS }, snapshot_timestamp_ms: sent }));
  assert.deepEqual(answer, { status: 200, text: '{"result":"OK"}' });
  return sent;
}

async function get(ask) {
  const answer = await ask("GET", "/api/busy/snapshot");
  assert.equal(answer.status, 200);
  return JSON.parse(answer.text);
}

const frontDisplay = async (ask) => (await ask("GET", "/api/screen?display=0")).text;
const state = async (ask) => JSON.parse((await ask("GET", "/_emu/state")).text);

/** Presses keys of POST /api/input one after another; a program takes a moment to open, the wheel only moves. */
async function press(ask, keys) {
  for (const key of keys) {
    assert.equal((await ask("POST", `/api/input?key=${key}`)).status, 200, key);
    await sleep(key === "up" || key === "down" ? 300 : 1200);
  }
}

// The settings menu lists the system settings ninth; "up" is the wheel's step down a list. Their first screen lists
// Power, Debug, Factory reset; Power lists Shut down, Restart device, Info. A question opens on "Cancel".
const SYSTEM_SETTINGS = ["apps", "settings", "ok", ...Array(8).fill("up"), "ok"];
const RESTART = [...SYSTEM_SETTINGS, "ok", "up", "ok", "down", "ok"];
const FACTORY_RESET = [...SYSTEM_SETTINGS, "up", "up", "ok", "down", "ok"];

for (const version of Object.keys(config.versions)) {
  describe(`firmware ${version}: the BUSY timer started through the API`, () => {
    for (const [name, timer] of Object.entries(TIMERS)) {
      test(`${name} set while the apps menu is on screen: the request answers, the timer is set, the bar shows it and goes on answering`, { timeout: 60_000 }, (t) =>
        withServer(t, version, async (ask) => {
          const appsMenu = await frontDisplay(ask);
          await put(ask, STOPPED);
          const sent = await put(ask, timer);
          // What a bar on firmware 1.3.1 answered right after the same request for a running timer (11.11.2026): the
          // snapshot as it was sent.
          assert.deepEqual(await get(ask), answered(timer, sent));

          // The BUSY program has taken the screen from the apps menu, and a running timer's minutes and seconds on it
          // count down. (The snapshot does not: the service keeps it as of the last change of the timer.)
          await sleep(2500);
          const shown = await frontDisplay(ask);
          assert.notEqual(shown, appsMenu);
          await sleep(1500);
          if (timer.type === "SIMPLE" && !timer.is_paused) assert.notEqual(await frontDisplay(ask), shown, "the time on the front display moves");
          assert.deepEqual(await get(ask), answered(timer, sent));

          await put(ask, STOPPED);
          assert.equal((await get(ask)).snapshot.type, "NOT_STARTED");
          assert.equal((await ask("GET", "/api/version")).status, 200);
        }),
      );
    }

    test("a running timer set in the BUSY mode, where the BUSY program is already on screen", { timeout: 60_000 }, (t) =>
      withServer(t, version, async (ask) => {
        await press(ask, ["busy"]);
        const sent = await put(ask, TIMERS["a running timer"]);
        assert.deepEqual(await get(ask), answered(TIMERS["a running timer"], sent));
        await put(ask, STOPPED);
        assert.equal((await get(ask)).snapshot.type, "NOT_STARTED");
      }),
    );
  });

  describe(`firmware ${version}: a thread of the system waits without end`, () => {
    test("the server stops the system, says what it waited for and restarts the bar", { timeout: 60_000 }, (t) => {
      const run = spawnSync(process.execPath, [join(here, "stuck-device.test-support.mjs"), tempDir(t), version], { timeout: 30_000, killSignal: "SIGKILL", encoding: "utf8" });
      assert.notEqual(run.error?.code, "ETIMEDOUT", "the device did not come back in 30 s");
      assert.equal(run.status, 0, run.stderr);
      const { before, down, after, lines } = JSON.parse(run.stdout);
      assert.equal(before.version, 200);
      // The call into the module ended, and the module is used no more: no answers, dark displays.
      assert.deepEqual(down, { returned: "the system is down", disposed: true, request: 503, frame: true });
      // Then the bar restarted, with a new system, and answers.
      assert.deepEqual(after, { version: 200, boots: before.boots + 1, powered: true, sameScreen: false });
      const log = lines.join("\n");
      assert.match(log, /\[Emulator\] The firmware waited 10000 times in a row for something that did not happen \(the last wait: a sleep, 1 ticks\)/);
      assert.match(log, /The BUSY Bar's system is stuck and was stopped/);
      assert.match(log, /The BUSY Bar restarts \(the system was stuck\)/);
    });
  });

  describe(`firmware ${version}: the system settings take the bar down`, () => {
    for (const [name, keys, why] of [
      ["Restart device", RESTART, "restart"],
      ["Factory reset", FACTORY_RESET, "factory reset"],
    ]) {
      test(`${name}, confirmed: the bar restarts and answers again`, { timeout: 90_000 }, (t) =>
        withServer(t, version, async (ask, output) => {
          const before = (await state(ask)).boots;
          await press(ask, keys);
          let now;
          for (let i = 0; i < 50 && !(now?.boots > before && now.powered); i++) {
            await sleep(100);
            now = await state(ask);
          }
          assert.equal(now.boots, before + 1, `the bar restarted once:\n${output()}`);
          assert.equal((await ask("GET", "/api/version")).status, 200);
          assert.match(output(), new RegExp(`The BUSY Bar restarts \\(${why}\\)`));
          assert.doesNotMatch(output(), /stuck/);
        }),
      );
    }
  });
}
