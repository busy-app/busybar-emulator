// busy-emulator time, the command line itself, against a real server: time advance lets time pass at once for the
// bar and its app (the field test with a real agent, 11.11: a 25-minute timer could not be checked without waiting
// 25 minutes), time set sets the clock as the bar's own API does, time reset puts it right again.
//
// - after time advance 25m an app's 25-minute setTimeout has fired, its Date.now() is 25 minutes on, its 10-minute
//   interval fired once (not once a period), and a timer due later has not fired; GET /api/time is 25 minutes on;
// - time set 14:59:50 sets the bar's clock to that time of today; time reset makes it the computer's again;
// - a wrong duration is a wrong call (exit code 2), before the emulator is asked.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startServer } from "../../packages/server/server.mjs";
import { finish, get, installApp, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const CLI = serverModule(join("cli", "busy-emulator.mjs"));
const MIN = 60_000;

let emulator;
let data;
const lines = [];
const leftovers = [];

before(async () => {
  data = tempDir({ after: (fn) => leftovers.push(fn) });
  emulator = await startServer({ port: port(0), dataDir: join(data, "bar"), barSpeed: false, log: (line) => lines.push(line) });
  mkdirSync(join(data, "run"));
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

async function cli(t, args) {
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const child = node(t, [CLI, ...args], { cwd: data, env: { ...clean, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(60000);
  return { code, stdout, stderr, json: args.includes("--json") && stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()) : null };
}

const barTime = async () => Date.parse((await get(`${emulator.url}/api/time`)).json().timestamp);
/** The app's printed lines, "<word> <number>", as [word, number]. */
const printed = () => lines.flatMap((line) => /app\.test\.timers log: (\w+) (\d+)/.exec(line)?.slice(1) ?? []).reduce((pairs, v, i, all) => (i % 2 ? pairs : [...pairs, [v, Number(all[i + 1])]]), []);
const said = (word) => printed().filter(([w]) => w === word);

test("time advance 25m: the app's 25-minute timer fires, its clock is 25 minutes on, an interval fires once, a later timer waits; the bar's clock moved too", async (t) => {
  await installApp(
    emulator.url,
    "app.test.timers",
    [
      "console.log('start ' + Date.now());",
      `setTimeout(function () { console.log('due ' + Date.now()); }, ${25 * MIN});`,
      "var ticks = 0;",
      `setInterval(function () { ticks++; console.log('tick ' + ticks); }, ${10 * MIN});`,
      `setTimeout(function () { console.log('later ' + Date.now()); }, ${40 * MIN});`,
    ].join("\n"),
  );
  assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=app.test.timers`)).status, 200);
  const [[, start]] = await until("the app's first line", () => said("start").length && said("start"));
  // The app's clock also moves with the time the test itself takes (seconds on a busy machine): the bounds allow it.
  const begun = Date.now();
  const slack = () => Date.now() - begun + 2000;
  const barBefore = await barTime();
  assert.deepEqual(said("due"), []);

  const advanced = await cli(t, ["time", "advance", "25m", "--json"]);
  assert.equal(advanced.code, 0, advanced.stdout + advanced.stderr);
  assert.equal(advanced.json.advanced_ms, 25 * MIN);
  assert.equal(advanced.json.app, "app.test.timers");
  assert.deepEqual(advanced.json.not_moved, ["the app's requests to the network"]);
  const [[, due]] = await until("the 25-minute timer", () => said("due").length && said("due"));
  assert.ok(due - start >= 25 * MIN && due - start < 25 * MIN + slack(), `the app's Date.now() moved ${due - start} ms`);
  assert.deepEqual(said("tick"), [["tick", 1]], "an interval fires once for the periods passed over, not once a period");
  assert.deepEqual(said("later"), []);
  const barAfter = await barTime();
  assert.ok(barAfter - barBefore >= 25 * MIN - 1000 && barAfter - barBefore < 25 * MIN + slack(), `the bar's clock moved ${barAfter - barBefore} ms`);
  const shown = await cli(t, ["time", "--json"]);
  assert.equal(shown.code, 0);
  assert.ok(Math.abs(shown.json.ahead_ms - 25 * MIN) <= 2000, `ahead ${shown.json.ahead_ms} ms`);

  // The rest of the 40 minutes: the later timer fires, at its own time by the app's clock.
  assert.equal((await cli(t, ["time", "advance", "15m"])).code, 0);
  const [[, later]] = await until("the 40-minute timer", () => said("later").length && said("later"));
  assert.ok(later - start >= 40 * MIN && later - start < 40 * MIN + slack(), `${later - start} ms`);
  await request("POST", `${emulator.url}/api/apps/quit`);
});

test("time set 14:59:50 sets the bar's clock to that time of today; time reset makes it the computer's again", async (t) => {
  const set = await cli(t, ["time", "set", "14:59:50", "--json"]);
  assert.equal(set.code, 0, set.stdout + set.stderr);
  const bar = (await get(`${emulator.url}/api/time`)).json().timestamp;
  assert.match(bar, /T14:59:5\d/);
  assert.match(set.stdout, /14:59:5\d/);
  const reset = await cli(t, ["time", "reset", "--json"]);
  assert.equal(reset.code, 0, reset.stdout + reset.stderr);
  assert.equal(reset.json.ahead_ms, 0);
  assert.ok(Math.abs((await barTime()) - Date.now()) < 2500);
});

test("time with a wrong duration or action is a wrong call, exit code 2", async (t) => {
  for (const args of [["advance", "soon"], ["advance", "25h"], ["advance"], ["later"], ["set", "noon"]]) {
    const refused = await cli(t, ["time", ...args, "--json"]);
    assert.equal(refused.code, 2, `${args.join(" ")}: ${refused.stdout}`);
    assert.equal(refused.json.code, "usage");
  }
});
