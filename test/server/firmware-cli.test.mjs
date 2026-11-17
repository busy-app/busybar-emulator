// The firmware on the command line against a real server (EMU-321): `firmware`, `firmware use`, the firmware that
// `status` and `version` name, and the api_mismatch refusal of install and run, on both firmwares of the emulator. A
// server this test starts in a data folder of its own, and the app's mirror naming this process, as agent-hands does.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test as nodeTest } from "node:test";

import { trustProject } from "../../packages/server/projects/trust.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { targz } from "../package.mjs";
import { finish, get, node, port, serverModule, tempDir } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 120_000 }, fn);
const CLI = serverModule(join("cli", "busy-emulator.mjs"));

let emulator;
let data;
let folder;
const leftovers = [];

before(async () => {
  data = realpathSync(tempDir({ after: (fn) => leftovers.push(fn) }));
  emulator = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir: data, barSpeed: false, log: () => {} });
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
  // A package for API 27.15.0 (1.4.1's), in a folder the person trusted.
  folder = join(data, "weather");
  mkdirSync(folder);
  const manifest = JSON.stringify({ format_version: 1, id: "app.you.weather", name: "Weather", version: "1.0.0", api_version: "27.15.0" });
  writeFileSync(join(folder, "weather.tgz"), targz({ "app.you.weather/appmeta/manifest.json": manifest, "app.you.weather/scripts/main.js": 'console.log("up");\n' }));
  trustProject(data, folder, "trusted", { platform: process.platform });
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

/** Runs the command line to its end with --json; returns { code, json, stderr }. */
async function cli(t, args) {
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const child = node(t, [CLI, ...args, "--json"], { cwd: data, env: { ...clean, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(90_000);
  return { code, stderr, json: stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()) : null };
}

test("firmware, status and version name the firmware the BUSY Bar runs; use switches it and the apps stay; api_mismatch on the older one", async (t) => {
  const shown = await cli(t, ["firmware"]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(shown.json.firmware, { version: "1.4.1", api: "27.15.0", alias: "latest" });
  assert.deepEqual(shown.json.firmwares.map((one) => [one.version, one.api, one.alias, one.running]), [["1.4.1", "27.15.0", "latest", true], ["1.3.1", "27.14.0", "previous", false]]);
  assert.equal(shown.json.pending, null);
  const status = await cli(t, ["status"]);
  assert.deepEqual(status.json.firmware, { version: "1.4.1", api: "27.15.0", alias: "latest" });
  const version = await cli(t, ["version"]);
  assert.deepEqual([version.json.firmware.version, version.json.firmware.api, version.json.firmware_source], ["1.4.1", "27.15.0", "running"]);

  // On 1.4.1 the app goes on the BUSY Bar.
  const installed = await cli(t, ["install", join(folder, "weather.tgz")]);
  assert.equal(installed.code, 0, JSON.stringify(installed.json));

  const switched = await cli(t, ["firmware", "use", "previous"]);
  assert.equal(switched.code, 0, JSON.stringify(switched.json));
  assert.deepEqual([switched.json.from.version, switched.json.firmware.version, switched.json.changed], ["1.4.1", "1.3.1", true]);
  assert.equal((await get(`${emulator.url}/api/version`)).json().api_semver, "27.14.0", "the BUSY Bar answers with 1.3.1's API");
  assert.deepEqual((await cli(t, ["status"])).json.firmware, { version: "1.3.1", api: "27.14.0", alias: "previous" });
  // One BUSY Bar: the app is still there.
  assert.ok((await get(`${emulator.url}/api/apps/list`)).json().apps.some((app) => app.id === "app.you.weather"));

  // The older firmware refuses it, said as firmware and API with both ways out.
  for (const words of [["install", join(folder, "weather.tgz")], ["run", "app.you.weather"]]) {
    const refused = await cli(t, words);
    assert.deepEqual([refused.code, refused.json.code], [1, "api_mismatch"], words.join(" "));
    assert.deepEqual(refused.json.firmware, { version: "1.3.1", api: "27.14.0" });
    assert.deepEqual(refused.json.needs_firmware, { version: "1.4.1", api: "27.15.0", alias: "latest" });
    assert.match(refused.json.message, /^(?:Weather|app\.you\.weather) needs API 27\.15\.0; this BUSY Bar runs firmware 1\.3\.1, API 27\.14\.0\.$/);
    assert.match(refused.json.hint, /^If (?:Weather|app\.you\.weather) needs nothing newer, set api_version to 27\.14\.0 in its project's manifest and build again\. Or switch:\n {2}.* firmware use latest$/);
  }

  const unknown = await cli(t, ["firmware", "use", "0.0.1"]);
  assert.deepEqual([unknown.code, unknown.json.code], [1, "firmware_unknown"]);
  const back = await cli(t, ["firmware", "use", "latest"]);
  assert.equal(back.code, 0, JSON.stringify(back.json));
  assert.equal(back.json.firmware.version, "1.4.1");
  const again = await cli(t, ["firmware", "use", "latest"]);
  assert.equal(again.json.changed, false);
});
