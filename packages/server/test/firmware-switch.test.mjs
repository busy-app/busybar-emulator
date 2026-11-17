// Switching the BUSY Bar's firmware while the server runs (EMU-320; server.mjs, useFirmware): GET and POST
// /_emu/firmware on the management address. What a switch keeps (the apps, their data and settings, the port, the key,
// the window's stream) and what follows it (the API version, the local web, the documentation, what the lock and the
// data folder say), what waits for it and what is refused, and the firmware kept for the next start.
//
//   node --test packages/server/test/firmware-switch.test.mjs      (from emulator/)
//
// A server that mixed the firmwares up, or answered from what it was started with, could still look right with the
// real builds where they agree. The servers here run from a copy of the server and the engine in which every firmware is
// marked as its own (as firmware.test.mjs does): an API version no other has, and its name in the first page of the
// local web and of the documentation. The copy's firmware.json has five, so that `previous` and the order by version
// have something to find: 1.4.1 (the latest), 1.3.1 (previous), 1.2.0 and 1.1.0 (copies of 1.3.1's build, which the
// tests break) and dev (a copy of 1.4.1's under a name that is not a release). The servers listen on 127.0.0.1, on free ports (or those EMU_TEST_PORTS
// names), with data folders in the system's temporary folder; both are gone when the test ends.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { targz } from "../../../test/package.mjs";
import { installApp, port, request, until } from "../../../test/server/helpers.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(server, "../engine");
const config = JSON.parse(readFileSync(join(engine, "firmware.json"), "utf8"));

// Each firmware of the copy: the build it is copied from and its marks.
const COPIES = {
  "1.4.1": { from: "1.4.1", api: "27.91.1" },
  "1.3.1": { from: "1.3.1", api: "27.92.2" },
  "1.2.0": { from: "1.3.1", api: "27.93.3" },
  "1.1.0": { from: "1.3.1", api: "27.94.4" },
  dev: { from: "1.4.1", api: "27.95.5" },
};

let root;
let startServer;
const folders = [];
const servers = [];

before(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "emu-switch-")));
  folders.push(root);
  cpSync(server, join(root, "packages/server"), { recursive: true, filter: (from) => from !== join(server, "test") });
  for (const file of ["checks.mjs", "programs.mjs", "apps-assets.json"]) cpSync(join(engine, file), join(root, "packages/engine", file));
  cpSync(join(engine, "build", "apps-assets"), join(root, "packages/engine/build/apps-assets"), { recursive: true });
  const versions = {};
  for (const [version, { from, api }] of Object.entries(COPIES)) {
    const dir = join(root, "packages/engine/build", version);
    cpSync(join(engine, "build", from), dir, { recursive: true });
    const info = JSON.parse(readFileSync(join(dir, "build-info.json"), "utf8"));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ ...info, api }));
    // Changed, not added: the number of files stays what build-info.json says.
    for (const page of ["web/index.html", "web/200.html", "docs/index.html", "docs/openapi.yaml"]) {
      writeFileSync(join(dir, page), `${page.endsWith(".yaml") ? "#" : "<!--"} the firmware ${version} ${page.endsWith(".yaml") ? "" : "-->"}\n${readFileSync(join(dir, page), "utf8")}`);
    }
    versions[version] = { commit: config.versions[from].commit, summary: `The marked copy of ${from}, as ${version}.` };
  }
  writeFileSync(join(root, "packages/engine/firmware.json"), JSON.stringify({ ...config, default: "1.4.1", versions }));
  ({ startServer } = await import(pathToFileURL(join(root, "packages/server/server.mjs")).href));
});

after(async () => {
  await Promise.all(servers.map((one) => one.stop().catch(() => {})));
  for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const dataFolder = () => {
  const dir = mkdtempSync(join(tmpdir(), "emu-switch-data-"));
  folders.push(dir);
  return dir;
};

async function start(options = {}) {
  const lines = [];
  const events = [];
  const emulator = await startServer({ port: port(servers.length), barSpeed: false, log: (line) => lines.push(line), onFirmware: (event) => events.push(event), ...options });
  servers.push(emulator);
  return { emulator, lines, events };
}

/** GET or POST /_emu/firmware with the server's key: { status, body }. */
async function firmwareOp(emulator, version, { raw = null, method = version === undefined && raw === null ? "GET" : "POST", headers = emulator.controlHeaders() } = {}) {
  const body = raw ?? (method === "POST" ? JSON.stringify({ version }) : undefined);
  const answer = await fetch(`${emulator.control.url}/_emu/firmware`, { method, headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) }, body });
  return { status: answer.status, body: await answer.json() };
}

const json = async (emulator, path) => (await request("GET", `${emulator.url}${path}`)).json();
const text = async (emulator, path) => (await request("GET", `${emulator.url}${path}`)).text;

/** The device window's stream of events, as the window and `dev` read it: every event, and whether it ended. */
function followEvents(emulator) {
  const seen = { events: [], ended: false };
  const req = http.get(`${emulator.url}/_emu/events`, { agent: false }, (res) => {
    let rest = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      rest += chunk;
      for (let at; (at = rest.indexOf("\n\n")) >= 0; rest = rest.slice(at + 2)) {
        const block = rest.slice(0, at);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event) seen.events.push({ event, data: data ? JSON.parse(data) : null });
      }
    });
    res.on("end", () => (seen.ended = true));
  });
  req.on("error", () => (seen.ended = true));
  seen.close = () => req.destroy();
  return seen;
}

describe("a switch on a running server", () => {
  let emulator;
  let lines;
  let events;
  let stream;
  let dir;

  before(async () => {
    dir = dataFolder();
    // A staged package waits for its install as long as the test needs, however slow the machine.
    ({ emulator, lines, events } = await start({ dataDir: dir, stagedWaitMs: 60_000 }));
    stream = followEvents(emulator);
    await until("the window's hello", () => stream.events.some((e) => e.event === "hello"));
  });
  after(() => stream.close());

  test("it starts on the latest, and GET /_emu/firmware lists every firmware newest first, with its alias", async () => {
    const { status, body } = await firmwareOp(emulator);
    assert.equal(status, 200);
    assert.deepEqual(body.firmware, { version: "1.4.1", api: "27.91.1", commit: config.versions["1.4.1"].commit.slice(0, 8), alias: "latest", summary: "The marked copy of 1.4.1, as 1.4.1." });
    assert.deepEqual(body.firmwares.map((f) => [f.version, f.api, f.alias, f.running, f.available]), [
      ["1.4.1", "27.91.1", "latest", true, true],
      ["1.3.1", "27.92.2", "previous", false, true],
      ["1.2.0", "27.93.3", null, false, true],
      ["1.1.0", "27.94.4", null, false, true],
      ["dev", "27.95.5", null, false, true],
    ]);
    assert.deepEqual([body.switching, body.notice], [null, null]);
    const hello = stream.events.find((e) => e.event === "hello").data;
    assert.deepEqual([hello.firmware.version, hello.firmware.api, hello.firmware.alias, hello.apiVersion, hello.notice], ["1.4.1", "27.91.1", "latest", "27.91.1", null]);
    assert.equal(JSON.parse(readFileSync(join(dir, "run", "server.lock"), "utf8")).firmware, "1.4.1");
  });

  test("to previous: the apps, their data and settings stay; the API, the local web and the documentation are the new firmware's", async () => {
    await installApp(emulator.url, "app.test.kept", "setInterval(function () {}, 1000);");
    writeFileSync(join(emulator.barDir, "ext", "apps_data", "app.test.kept.data"), "the app's data");
    const portBefore = emulator.port;
    const keyBefore = emulator.controlHeaders().Authorization;

    const { status, body } = await firmwareOp(emulator, "previous");
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual([body.firmware.version, body.firmware.api, body.firmware.alias, body.from.version, body.changed], ["1.3.1", "27.92.2", "previous", "1.4.1", true]);
    assert.ok(Number.isInteger(body.ms) && body.ms >= 0);

    // The BUSY Bar's own answers.
    assert.deepEqual(await json(emulator, "/api/version"), { api_semver: "27.92.2" });
    assert.equal((await json(emulator, "/api/status/firmware")).version, "1.3.1");
    assert.equal((await json(emulator, "/_emu/state")).api_version, "27.92.2");
    // Its local web, a route of it, its documentation and its API description: the folders of 1.3.1.
    const build = join(root, "packages/engine/build", "1.3.1");
    assert.equal(await text(emulator, "/"), readFileSync(join(build, "web", "index.html"), "utf8"));
    assert.equal(await text(emulator, "/some/route/of/the/app"), readFileSync(join(build, "web", "200.html"), "utf8"));
    assert.ok((await text(emulator, "/docs/")).startsWith("<!-- the firmware 1.3.1 -->"));
    assert.ok((await text(emulator, "/openapi.yaml")).startsWith("# the firmware 1.3.1"));
    // The apps and what they keep.
    assert.ok((await json(emulator, "/api/apps/list")).apps.some((app) => app.id === "app.test.kept"));
    assert.equal(readFileSync(join(emulator.barDir, "ext", "apps_data", "app.test.kept.data"), "utf8"), "the app's data");
    // The same port and key; what the server says of itself, the lock and the kept choice follow.
    assert.equal(emulator.port, portBefore);
    assert.equal(emulator.controlHeaders().Authorization, keyBefore);
    assert.deepEqual([emulator.firmware.name, emulator.apiVersion], ["1.3.1", "27.92.2"]);
    const lock = JSON.parse(readFileSync(join(dir, "run", "server.lock"), "utf8"));
    assert.deepEqual([lock.firmware, lock.apiVersion, lock.pid], ["1.3.1", "27.92.2", process.pid]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "bar", "chosen-firmware.json"), "utf8")), { version: "1.3.1" });
    // The log says it, with the line the window's console shows.
    assert.ok(lines.includes("The BUSY Bar switches to firmware 1.3.1 (asked by a program with the server's key)"), lines.join("\n"));
    assert.ok(lines.includes("The BUSY Bar runs firmware 1.3.1 now"));
  });

  test("the window's stream stayed open and heard the switch; the shell heard the same", async () => {
    await until("the ready event", () => stream.events.some((e) => e.event === "firmware" && e.data.state === "ready" && e.data.firmware.version === "1.3.1"));
    assert.equal(stream.ended, false);
    const told = stream.events.filter((e) => e.event === "firmware").map((e) => e.data);
    assert.deepEqual(told.map((e) => [e.state, e.from?.version, (e.to ?? e.firmware).version]), [["switching", "1.4.1", "1.3.1"], ["ready", "1.4.1", "1.3.1"]]);
    assert.deepEqual(told[1].firmware.summary, "The marked copy of 1.3.1, as 1.3.1.");
    assert.deepEqual(events, told);
    // The console's lines go on coming after the switch, on the same stream.
    assert.ok(stream.events.some((e) => e.event === "log" && e.data.text === "The BUSY Bar runs firmware 1.3.1 now"));
  });

  test("by its exact version, and back to latest; the one that runs already is no switch", async () => {
    assert.equal((await firmwareOp(emulator, "dev")).body.firmware.api, "27.95.5");
    assert.deepEqual(await json(emulator, "/api/version"), { api_semver: "27.95.5" });
    const same = await firmwareOp(emulator, "dev");
    assert.deepEqual([same.status, same.body.changed, same.body.ms], [200, false, 0]);
    assert.equal((await firmwareOp(emulator, "latest")).body.firmware.version, "1.4.1");
    assert.deepEqual(await json(emulator, "/api/version"), { api_semver: "27.91.1" });
  });

  test("a running app stops, as on a restart, and runs again on the new firmware", async () => {
    const launch = async () => (await request("POST", `${emulator.url}/api/apps/launch?app_id=app.test.kept`)).status;
    assert.equal(await launch(), 200);
    await until("the app runs", async () => (await json(emulator, "/_emu/state")).running?.id === "app.test.kept");
    // The app's run ends with the system's, by the power going (device.mjs, shutdown), and nothing starts it again.
    const endedSince = (from) => lines.slice(from).filter((line) => /^App app\.test\.kept exited: /.test(line));
    let from = lines.length;
    assert.equal((await request("POST", `${emulator.url}/_emu/power?action=restart&wait=1`)).status, 200);
    const afterRestart = { running: (await json(emulator, "/_emu/state")).running?.id ?? null, ended: endedSince(from) };
    assert.deepEqual(afterRestart.running, null);
    assert.equal(afterRestart.ended.length, 1, lines.slice(from).join("\n"));
    assert.equal(await launch(), 200);
    await until("the app runs", async () => (await json(emulator, "/_emu/state")).running?.id === "app.test.kept");
    from = lines.length;
    assert.equal((await firmwareOp(emulator, "dev")).status, 200);
    assert.deepEqual({ running: (await json(emulator, "/_emu/state")).running?.id ?? null, ended: endedSince(from) }, afterRestart, "the same as after a restart");
    assert.equal(await launch(), 200);
    await until("the app runs on dev", async () => (await json(emulator, "/_emu/state")).running?.id === "app.test.kept");
    assert.equal((await firmwareOp(emulator, "latest")).status, 200);
  });

  test("an install under way comes to its end before the BUSY Bar goes down", async () => {
    const files = { "app.test.late/appmeta/manifest.json": JSON.stringify({ format_version: 1, id: "app.test.late", name: "late", version: "0.1.0", api_version: "27.0.0" }), "app.test.late/scripts/main.js": "1;" };
    const staged = await request("POST", `${emulator.url}/api/apps/stage`, targz(files));
    const key = staged.json().install_key;
    // Staged, its install not sent yet: the switch waits for it (2 s by default, here a minute), as for busy-cli's
    // install right after the package.
    const switched = firmwareOp(emulator, "dev");
    await until("the switch under way", () => events.some((e) => e.state === "switching" && e.to.version === "dev"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(emulator.firmware.name, "1.4.1", "not switched yet");
    const installed = await request("POST", `${emulator.url}/api/apps/install?install_key=${key}`);
    assert.equal(installed.status, 200, installed.text);
    assert.equal((await switched).status, 200);
    assert.ok((await json(emulator, "/api/apps/list")).apps.some((app) => app.id === "app.test.late"));
    assert.equal((await firmwareOp(emulator, "latest")).status, 200);
  });

  test("a request that needs the BUSY Bar during the switch waits for it, and is answered by the new firmware", async () => {
    let held = null;
    const listener = (event) => {
      // The switch holds the BUSY Bar from the same turn on (there is nothing to wait for): this request is held.
      if (event.state === "switching") held = request("GET", `${emulator.url}/api/version`);
    };
    events.length = 0;
    const onFirmware = events.push.bind(events);
    events.push = (event) => (listener(event), onFirmware(event));
    try {
      assert.equal((await firmwareOp(emulator, "dev")).status, 200);
    } finally {
      events.push = onFirmware;
    }
    assert.ok(held, "the switch was told");
    assert.deepEqual((await held).json(), { api_semver: "27.95.5" });
    assert.equal((await firmwareOp(emulator, "latest")).status, 200);
  });

  test("a second switch to another firmware meanwhile is refused with firmware_switching; to the same one it waits for that switch", async () => {
    // An upload under way keeps the first switch waiting for its quiet moment, so the others come while it runs.
    const upload = http.request(`${emulator.url}/api/apps/stage`, { method: "POST", agent: false, headers: { "Content-Length": 1000, Connection: "close" } });
    const uploaded = new Promise((resolve) => upload.on("response", (res) => (res.resume(), res.on("end", resolve))));
    upload.on("error", () => {});
    upload.write(Buffer.alloc(10));
    // The server takes the package in: another package meanwhile is refused from its headers, as on the bar.
    await until("the upload under way", async () => (await request("POST", `${emulator.url}/api/apps/stage`, Buffer.alloc(1))).status === 508);
    events.length = 0;
    const first = firmwareOp(emulator, "dev");
    await until("the first switch under way", async () => (await firmwareOp(emulator)).body.switching?.to === "dev");
    const [other, same] = [await firmwareOp(emulator, "1.3.1"), firmwareOp(emulator, "dev")];
    assert.equal(other.status, 409);
    assert.equal(other.body.code, "firmware_switching");
    assert.equal(other.body.error, "The emulated BUSY Bar is switching to firmware dev now.");
    assert.equal(other.body.hint, "Wait until it is up, then ask for firmware 1.3.1 again.");
    assert.equal(emulator.firmware.name, "1.4.1", "the first still waits for the upload");
    upload.end(Buffer.alloc(990));
    await uploaded;
    const done = await first;
    assert.equal(done.status, 200);
    assert.deepEqual((await same).body, done.body, "the same switch's answer");
    assert.deepEqual(events.map((e) => e.state), ["switching", "ready"], "one switch");
    assert.equal((await firmwareOp(emulator, "latest")).status, 200);
  });

  test("what is not a firmware: firmware_unknown; a wrong call: usage; without the key: 401", async () => {
    const unknown = await firmwareOp(emulator, "9.9.9");
    assert.deepEqual([unknown.status, unknown.body.code], [400, "firmware_unknown"]);
    assert.equal(unknown.body.error, 'This emulator has no firmware "9.9.9". It has: 1.4.1 (latest), 1.3.1 (previous), 1.2.0, 1.1.0, dev.');
    for (const raw of ["", "{not json", '{"version": 3}', "{}"]) {
      const wrong = await firmwareOp(emulator, null, { raw, method: "POST" });
      assert.deepEqual([wrong.status, wrong.body.code], [400, "usage"], raw);
    }
    const put = await firmwareOp(emulator, null, { method: "PUT", raw: "{}" });
    assert.deepEqual([put.status, put.body.code], [405, "usage"]);
    assert.equal((await firmwareOp(emulator, "dev", { headers: {} })).status, 401);
    // Not on the BUSY Bar's address: the management address's alone.
    assert.equal((await request("POST", `${emulator.url}/_emu/firmware`, Buffer.from('{"version":"dev"}'))).status, 404);
    assert.equal(emulator.firmware.name, "1.4.1");
  });

  test("a firmware whose build cannot be loaded: firmware_start_failed, and the BUSY Bar never stopped", async () => {
    const web = join(root, "packages/engine/build/1.1.0/web/200.html");
    renameSync(web, join(root, "200.html.away"));
    try {
      const boots = (await json(emulator, "/_emu/state")).boots;
      const failed = await firmwareOp(emulator, "1.1.0");
      assert.deepEqual([failed.status, failed.body.code, failed.body.firmware.version], [500, "firmware_start_failed", "1.4.1"]);
      assert.match(failed.body.error, /^Firmware 1\.1\.0 cannot start: The local web of firmware "1\.1\.0" .+ is not whole: \d+ of \d+ files\. /);
      assert.equal(failed.body.hint, "The BUSY Bar runs firmware 1.4.1 as before.");
      assert.equal((await json(emulator, "/_emu/state")).boots, boots, "no restart");
      assert.deepEqual(await json(emulator, "/api/version"), { api_semver: "27.91.1" });
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "bar", "chosen-firmware.json"), "utf8")), { version: "1.4.1" });
      assert.deepEqual(events.at(-1), { state: "failed", firmware: (await firmwareOp(emulator)).body.firmware, to: { version: "1.1.0" }, code: "firmware_start_failed", error: failed.body.error, hint: failed.body.hint, pending: null });
    } finally {
      renameSync(join(root, "200.html.away"), web);
    }
  });

  test("a firmware whose system does not come up: firmware_start_failed, and the BUSY Bar runs the one it had again", async () => {
    const wasm = join(root, "packages/engine/build/1.2.0/screen.wasm");
    const kept = readFileSync(wasm);
    truncateSync(wasm, 1000);
    try {
      const failed = await firmwareOp(emulator, "1.2.0");
      assert.deepEqual([failed.status, failed.body.code, failed.body.firmware.version], [500, "firmware_start_failed", "1.4.1"], JSON.stringify(failed.body));
      assert.equal(failed.body.hint, "The BUSY Bar runs firmware 1.4.1 as before.");
      const state = await json(emulator, "/_emu/state");
      assert.deepEqual([state.powered, state.api_version, state.firmware.name], [true, "27.91.1", "1.4.1"]);
      assert.deepEqual(await json(emulator, "/api/version"), { api_semver: "27.91.1" });
      assert.equal((await json(emulator, "/api/status/firmware")).version, "1.4.1");
      assert.ok(lines.some((line) => /^Firmware 1\.2\.0 did not start \(.+\); the BUSY Bar runs firmware 1\.4\.1 again\.$/.test(line)), lines.slice(-5).join("\n"));
      // And it switches as before.
      assert.equal((await firmwareOp(emulator, "dev")).status, 200);
      assert.equal((await firmwareOp(emulator, "latest")).status, 200);
    } finally {
      writeFileSync(wasm, kept);
    }
  });
});

test("a request held longer than the switch may take is refused with firmware_switching", async () => {
  const { emulator, events } = await start({ dataDir: dataFolder(), switchWaitMs: 0 });
  let held = null;
  const push = events.push.bind(events);
  events.push = (event) => {
    if (event.state === "switching") held = request("GET", `${emulator.url}/api/version`);
    return push(event);
  };
  assert.equal((await firmwareOp(emulator, "dev")).status, 200);
  const answer = await held;
  assert.equal(answer.status, 503);
  assert.deepEqual(answer.json(), { code: "firmware_switching", error: "The emulated BUSY Bar is switching to firmware dev and was not up again within 0 s. Try again in a moment." });
  await emulator.stop();
});

test("the firmware chosen last is the next start's; one this emulator does not have gives the latest, said once", async () => {
  const dir = dataFolder();
  const first = await start({ dataDir: dir });
  assert.equal((await firmwareOp(first.emulator, "dev")).status, 200);
  await first.emulator.stop();

  // Started again without a firmware named: the one chosen.
  const second = await start({ dataDir: dir });
  assert.deepEqual([second.emulator.firmware.name, (await json(second.emulator, "/api/version")).api_semver, (await firmwareOp(second.emulator)).body.notice], ["dev", "27.95.5", null]);
  await second.emulator.stop();

  // A firmware named for the run is the run's: it is not kept.
  const named = await start({ dataDir: dir, firmware: "1.3.1" });
  assert.equal(named.emulator.firmware.name, "1.3.1");
  await named.emulator.stop();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "bar", "chosen-firmware.json"), "utf8")), { version: "dev" });

  // A newer emulator that no longer has it: the latest, and the person hears it once.
  writeFileSync(join(dir, "bar", "chosen-firmware.json"), JSON.stringify({ version: "0.9.0" }));
  const dropped = await start({ dataDir: dir });
  const notice = "The BUSY Bar runs firmware 1.4.1, the latest: this emulator does not have firmware 0.9.0. It ran 0.9.0 before.";
  assert.equal(dropped.emulator.firmware.name, "1.4.1");
  assert.ok(dropped.lines.includes(notice), dropped.lines.join("\n"));
  assert.equal((await firmwareOp(dropped.emulator)).body.notice, notice);
  const stream = followEvents(dropped.emulator);
  await until("the hello", () => stream.events.find((e) => e.event === "hello"));
  assert.equal(stream.events.find((e) => e.event === "hello").data.notice, notice);
  // And in the console every window shows, among the lines a window gets when it opens.
  await until("the notice in the console", () => stream.events.some((e) => e.event === "log" && e.data.text === notice));
  assert.deepEqual(stream.events.filter((e) => e.event === "log" && e.data.text === notice).map((e) => e.data.kind), ["warn"]);
  stream.close();
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "bar", "chosen-firmware.json"), "utf8")), { version: "1.4.1" });
  await dropped.emulator.stop();

  const quiet = await start({ dataDir: dir });
  assert.equal(quiet.lines.some((line) => line.includes("the latest:")), false);
  assert.equal((await firmwareOp(quiet.emulator)).body.notice, null);
  await quiet.emulator.stop();

  // One it has but cannot start: the same.
  writeFileSync(join(dir, "bar", "chosen-firmware.json"), JSON.stringify({ version: "1.1.0" }));
  const web = join(root, "packages/engine/build/1.1.0/web/200.html");
  renameSync(web, join(root, "200.html.away"));
  try {
    const broken = await start({ dataDir: dir });
    assert.equal(broken.emulator.firmware.name, "1.4.1");
    assert.ok(broken.lines.some((line) => line.startsWith("The BUSY Bar runs firmware 1.4.1, the latest: firmware 1.1.0 cannot start: The local web of firmware")), broken.lines.join("\n"));
    await broken.emulator.stop();
  } finally {
    renameSync(join(root, "200.html.away"), web);
  }
  assert.ok(existsSync(join(dir, "bar", "ext", "user_assets")));
});

describe("a firmware chosen for the next restart", () => {
  let emulator;
  let events;
  let lines;
  let dir;
  before(async () => {
    dir = dataFolder();
    ({ emulator, events, lines } = await start({ dataDir: dir }));
    await installApp(emulator.url, "app.probe.oom", readFileSync(join(server, "../../test/probes/app.probe.oom/scripts/main.js"), "utf8"));
  });

  const choose = (version) => firmwareOp(emulator, null, { raw: JSON.stringify({ version, when: "restart" }), method: "POST" });
  const state = () => json(emulator, "/_emu/state");
  const state_ = state;
  const bar = (method, path) => request(method, `${emulator.url}${path}`);

  test("is chosen at once, and the BUSY Bar runs on as it is; GET /_emu/firmware and the event say it", async () => {
    const boots = (await state()).boots;
    events.length = 0;
    const chosen = await choose("previous");
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.deepEqual([chosen.body.firmware.version, chosen.body.pending.version, chosen.body.pending.api, chosen.body.pending.alias, chosen.body.changed], ["1.4.1", "1.3.1", "27.92.2", "previous", false]);
    assert.equal((await state()).boots, boots, "no restart");
    assert.deepEqual(await json(emulator, "/api/version"), { api_semver: "27.91.1" });
    assert.equal((await firmwareOp(emulator)).body.pending.version, "1.3.1");
    assert.deepEqual(events, [{ state: "pending", firmware: chosen.body.firmware, pending: chosen.body.pending }]);
    assert.ok(lines.includes("Firmware 1.3.1 is chosen for the BUSY Bar: it runs it from its next restart"));
    // A window opened now (or loaded again) hears it in its hello, with the list (EMU-322).
    const stream = followEvents(emulator);
    try {
      await until("the hello", () => stream.events.some((e) => e.event === "hello"));
      const hello = stream.events.find((e) => e.event === "hello").data;
      assert.deepEqual([hello.firmware.version, hello.pending, hello.switching], ["1.4.1", chosen.body.pending, null]);
      assert.deepEqual(hello.firmwares, (await firmwareOp(emulator)).body.firmwares);
      assert.deepEqual(hello.firmwares.slice(0, 2).map((f) => [f.version, f.alias]), [["1.4.1", "latest"], ["1.3.1", "previous"]]);
      assert.ok(hello.firmwares.every((f) => "news" in f), "each with its line for the window's list");
    } finally {
      stream.close();
    }
    // Nothing is kept until a restart applies it.
    assert.equal(existsSync(join(dir, "bar", "chosen-firmware.json")), false);
  });

  /** Each way the BUSY Bar restarts applies the firmware chosen for it, in that one restart. */
  const paths = [
    ["the window's Restart (POST /_emu/power)", () => bar("POST", "/_emu/power?action=restart&wait=1")],
    ["busy-emulator restart-bar (the same path, why=cli)", () => bar("POST", "/_emu/power?action=restart&wait=1&why=cli")],
    [
      "Back and Start held together",
      async () => {
        // Held until the BUSY Bar restarts (device.mjs, keyDown), then let go of.
        const boots = (await state()).boots;
        await bar("POST", "/_emu/key?key=back&action=down");
        await bar("POST", "/_emu/key?key=start&action=down");
        await until("the restart by the buttons", async () => (await state()).boots > boots);
        await bar("POST", "/_emu/key?key=start&action=up");
        await bar("POST", "/_emu/key?key=back&action=up");
      },
    ],
    [
      "the firmware's supervisor after a JS heap overflow (past the first 30 s)",
      async () => {
        await bar("POST", "/_emu/time?hold=1");
        await bar("POST", "/_emu/time?advance=31000");
        await bar("POST", "/_emu/time?hold=0");
        assert.equal((await bar("POST", "/api/apps/launch?app_id=app.probe.oom")).status, 200);
      },
    ],
  ];
  const targets = ["1.3.1", "dev", "1.3.1", "dev"];
  for (const [i, [how, restart]] of paths.entries()) {
    test(`${how} applies it`, async () => {
      const target = targets[i];
      if (i > 0) assert.equal((await choose(target)).body.pending.version, target);
      const before = await state();
      events.length = 0;
      await restart();
      const after = await until("the BUSY Bar up on the chosen firmware", async () => {
        const now = await state();
        return now.firmware.name === target && now.powered && (await bar("GET", "/api/version")).status === 200 ? now : null;
      });
      assert.equal(after.boots, before.boots + 1, "one restart, not two");
      assert.equal((await json(emulator, "/api/version")).api_semver, COPIES[target].api);
      assert.equal((await firmwareOp(emulator)).body.pending, null);
      assert.deepEqual(events.map((e) => e.state), ["switching", "ready"]);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "bar", "chosen-firmware.json"), "utf8")), { version: target });
      // A restart with nothing chosen is a restart: the firmware stays.
      assert.equal((await bar("POST", "/_emu/power?action=restart&wait=1")).status, 200);
      assert.equal((await state()).firmware.name, target);
    });
  }

  test("choosing the one that runs clears the choice", async () => {
    const running = emulator.firmware.name;
    assert.equal((await choose("latest")).body.pending.version, "1.4.1");
    events.length = 0;
    const cleared = await choose(running);
    assert.deepEqual([cleared.status, cleared.body.pending, cleared.body.firmware.version], [200, null, running]);
    assert.deepEqual(events.map((e) => [e.state, e.pending]), [["pending", null]]);
    assert.equal((await bar("POST", "/_emu/power?action=restart&wait=1")).status, 200);
    assert.equal((await state()).firmware.name, running);
  });

  test("a switch now to a third firmware clears it", async () => {
    assert.equal(emulator.firmware.name, "dev");
    assert.equal((await choose("1.3.1")).body.pending.version, "1.3.1");
    const now = await firmwareOp(emulator, "latest");
    assert.deepEqual([now.status, now.body.firmware.version, now.body.pending], [200, "1.4.1", null]);
    assert.equal((await firmwareOp(emulator)).body.pending, null);
    assert.equal((await bar("POST", "/_emu/power?action=restart&wait=1")).status, 200);
    assert.equal((await state()).firmware.name, "1.4.1");
  });

  test("one whose build cannot be loaded is refused when it is chosen; a wrong `when` is a wrong call", async () => {
    const web = join(root, "packages/engine/build/1.1.0/web/200.html");
    renameSync(web, join(root, "200.html.away"));
    try {
      const refused = await choose("1.1.0");
      assert.deepEqual([refused.status, refused.body.code, refused.body.pending], [500, "firmware_start_failed", null]);
    } finally {
      renameSync(join(root, "200.html.away"), web);
    }
    const wrong = await firmwareOp(emulator, null, { raw: JSON.stringify({ version: "dev", when: "later" }), method: "POST" });
    assert.deepEqual([wrong.status, wrong.body.code], [400, "usage"]);
  });

  test("the restart applies a chosen firmware that does not come up: the BUSY Bar is back on its own, the choice is gone", async () => {
    const running = emulator.firmware.name;
    const wasm = join(root, "packages/engine/build/1.2.0/screen.wasm");
    const kept = readFileSync(wasm);
    assert.equal((await choose("1.2.0")).body.pending.version, "1.2.0");
    truncateSync(wasm, 1000);
    try {
      events.length = 0;
      assert.equal((await bar("POST", "/_emu/power?action=restart&wait=1")).status, 200);
      const state = await state_();
      assert.deepEqual([state.firmware.name, state.powered], [running, true]);
      assert.equal((await firmwareOp(emulator)).body.pending, null);
      assert.deepEqual(events.map((e) => e.state), ["switching", "failed"]);
    } finally {
      writeFileSync(wasm, kept);
    }
  });

  test("the restart applies a chosen firmware that no longer loads: it is still a restart, on the firmware the BUSY Bar runs", async () => {
    const running = emulator.firmware.name;
    assert.equal((await choose("1.1.0")).body.pending.version, "1.1.0");
    const web = join(root, "packages/engine/build/1.1.0/web/200.html");
    renameSync(web, join(root, "200.html.away"));
    try {
      const before = (await state_()).boots;
      events.length = 0;
      assert.equal((await bar("POST", "/_emu/power?action=restart&wait=1")).status, 200);
      const after = await state_();
      assert.deepEqual([after.firmware.name, after.powered, after.boots], [running, true, before + 1]);
      assert.deepEqual(events.map((e) => e.state), ["failed"]);
      assert.equal((await firmwareOp(emulator)).body.pending, null);
    } finally {
      renameSync(join(root, "200.html.away"), web);
    }
  });

  test("it is not kept: a new start runs the firmware applied last", async () => {
    assert.equal((await choose("dev")).body.pending.version, "dev");
    await emulator.stop();
    const again = await start({ dataDir: dir });
    assert.deepEqual([again.emulator.firmware.name, (await firmwareOp(again.emulator)).body.pending], ["1.4.1", null]);
    await again.emulator.stop();
  });
});

test("a chosen firmware that loads but does not start: the latest starts instead, said once, and kept", async () => {
  const dir = dataFolder();
  const first = await start({ dataDir: dir });
  assert.equal((await firmwareOp(first.emulator, "1.2.0")).status, 200);
  await first.emulator.stop();
  const wasm = join(root, "packages/engine/build/1.2.0/screen.wasm");
  const kept = readFileSync(wasm);
  truncateSync(wasm, 1000);
  try {
    const again = await start({ dataDir: dir });
    assert.deepEqual([again.emulator.firmware.name, (await json(again.emulator, "/api/version")).api_semver], ["1.4.1", "27.91.1"]);
    const notice = (await firmwareOp(again.emulator)).body.notice;
    assert.match(notice, /^The BUSY Bar runs firmware 1\.4\.1, the latest: firmware 1\.2\.0 did not start: .+\. It ran 1\.2\.0 before\.$/);
    assert.equal(again.lines.filter((line) => line === notice).length, 1, "said once");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "bar", "chosen-firmware.json"), "utf8")), { version: "1.4.1" });
    assert.equal(JSON.parse(readFileSync(join(dir, "run", "server.lock"), "utf8")).firmware, "1.4.1");
    await again.emulator.stop();
  } finally {
    writeFileSync(wasm, kept);
  }
});

test("the lock names the firmware from the start", async () => {
  const dir = dataFolder();
  writeFileSync(join(dir, "format"), "2\n");
  mkdirSync(join(dir, "bar", "ext"), { recursive: true });
  writeFileSync(join(dir, "bar", "chosen-firmware.json"), JSON.stringify({ version: "1.3.1" }));
  // A lock left by a process that is gone: the server clears it and says so, after its own lock is taken and before
  // the BUSY Bar starts, which is when the lock is read here.
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(join(dir, "run"));
  writeFileSync(join(dir, "run", "server.lock"), JSON.stringify({ pid: gone, started: Date.now() - 60_000, exe: process.execPath, since: new Date().toISOString(), nonce: "0".repeat(24) }));
  let seen = null;
  const { emulator } = await start({ dataDir: dir, log: (line) => line.includes("lock was left") && (seen ??= JSON.parse(readFileSync(join(dir, "run", "server.lock"), "utf8"))) });
  assert.ok(seen, "the cleared lock was said during the start");
  assert.equal(seen.pid, process.pid, "the lock read is this server's");
  assert.deepEqual([seen.firmware, seen.apiVersion], ["1.3.1", "27.92.2"]);
  await emulator.stop();
});

test("a stop during a switch: the switch is answered, the stop ends, nothing of the server is left", async () => {
  const dir = dataFolder();
  let stopped = null;
  const { emulator } = await start({ dataDir: dir, onFirmware: (event) => event.state === "switching" && (stopped ??= emulator.stop()) });
  const answer = await firmwareOp(emulator, "dev").catch((e) => ({ status: null, error: e }));
  assert.ok(stopped, "the stop was asked during the switch");
  await stopped;
  assert.ok(answer.status === null || (answer.status === 503 && answer.body.code === "stopped"), JSON.stringify(answer.body ?? String(answer.error)));
  assert.equal(existsSync(join(dir, "run", "server.lock")), false, "the lock is let go of");
  await assert.rejects(fetch(`${emulator.url}/api/version`));
});

test("a take being recorded when the firmware switches ends, and its answer says why", async () => {
  // Takes are recorded at the BUSY Bar's speed only.
  const { emulator } = await start({ dataDir: dataFolder(), barSpeed: true });
  const take = fetch(`${emulator.control.url}/_emu/record?seconds=3&fps=10&layout=front&format=gif`, { method: "POST", headers: emulator.controlHeaders() });
  await until("the take under way", async () => (await json(emulator, "/_emu/state")).clock?.held === true);
  assert.equal((await firmwareOp(emulator, "1.3.1")).status, 200);
  const answer = await take;
  assert.equal(answer.status, 503);
  assert.deepEqual(await answer.json(), { code: "off", error: "The take stopped: the BUSY Bar switched to firmware 1.3.1 during the take." });
  await emulator.stop();
});
