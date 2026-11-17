// The firmware of the emulated BUSY Bar on the command line (EMU-321), against a stand-in for the system that answers
// as the server's /_emu/firmware does: `firmware`, `firmware use`, the firmware in `status` and `version`, the MCP
// tools, and the api_mismatch refusal of install, run and dev. The command line against a real server:
// emulator/test/server/firmware-cli.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { trustProject } from "../../projects/trust.mjs";
import { targz } from "../../../../test/package.mjs";
import { loadCommands, main } from "../busy-emulator.mjs";
import { apiMismatch, compareApi, firmwareFor } from "../firmware.mjs";
import { TOOLS } from "../mcp/tools.mjs";

const commands = await loadCommands();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = "/Users/you/.busy-emulator/bin/busy-emulator";
const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };
const KEY = "k".repeat(43);

const FW = {
  "1.4.1": { version: "1.4.1", api: "27.15.0", commit: "28c175b3b5c8cda231582d07b276690eaf94a136", alias: "latest", summary: "Release 1.4.1." },
  "1.3.1": { version: "1.3.1", api: "27.14.0", commit: "8edd2da42ed2facbab73796c456746e7dcbed2e7", alias: "previous", summary: "Release 1.3.1." },
};
const resolve = (wanted) => (wanted === "latest" ? "1.4.1" : wanted === "previous" ? "1.3.1" : wanted);

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-firmware-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const ctx = {
    platform: "darwin",
    kind: "release",
    development: false,
    appPath: "/Applications/BUSY Bar Emulator.app",
    version: "1.2.3",
    node: "24.22.2",
    dataDir,
    runStateFile: path.join(dataDir, "run", "emulator.json"),
    calledAs: [SELF],
    testLaunch: null,
    nodeTools: { node: "/x/node", npmCli: "/x/npm-cli.js", npxCli: "/x/npx-cli.js", nodeDir: "/x" },
    env: {},
  };
  return { root, ctx };
}

/**
 * A stand-in for system.mjs with an emulator whose server switches firmware as server.mjs does: `bar.runs` is the
 * firmware it runs, `bar.refuse` a refusal the next POST gets, `bar.pending` the one chosen for the next restart.
 */
function fakeSystem(root, { running = true, runs = "1.4.1", chosen = null, refuse = null, pending = null, apps = [], tool = () => ({ code: 0, signal: null, output: "" }) } = {}) {
  const bar = { runs, refuse, pending, apps };
  const sent = [];
  const asked = [];
  const tools = [];
  let now = 5_000_000;
  const facts = (version) => ({ ...FW[version] });
  return {
    bar,
    sent,
    asked,
    tools,
    cwd: () => root,
    readRunState: () => (running ? { state: READY } : { missing: true }),
    alive: () => running,
    probe: async () => (running ? { answering: true } : { answering: false, code: "ECONNREFUSED" }),
    processInfo: () => ({ start: 999_500, exe: READY.exe }),
    samePath: (a, b) => a === b,
    readControl: () => ({ port: 51234, barPort: 8640, key: KEY }),
    chosenFirmware: () => ({ version: chosen, problem: null }),
    async askFirmware(port, key, method, body) {
      asked.push([method, body]);
      assert.equal(key, KEY);
      if (method === "GET") {
        const firmwares = ["1.4.1", "1.3.1"].map((version) => ({ ...facts(version), running: version === bar.runs, available: true }));
        return { status: 200, body: JSON.stringify({ firmware: facts(bar.runs), firmwares, switching: null, pending: bar.pending ? facts(bar.pending) : null, notice: null }) };
      }
      if (bar.refuse) return { status: bar.refuse.status, body: JSON.stringify(bar.refuse.body) };
      const name = resolve(body.version);
      if (!FW[name]) return { status: 400, body: JSON.stringify({ code: "firmware_unknown", error: `This emulator has no firmware ${JSON.stringify(body.version)}. It has: 1.4.1 (latest), 1.3.1 (previous).` }) };
      const from = bar.runs;
      bar.runs = name;
      return { status: 200, body: JSON.stringify({ firmware: facts(name), from: facts(from), changed: from !== name, ms: 1234, pending: null }) };
    },
    async barGet(port, pathname) {
      sent.push(["GET", pathname]);
      if (pathname === "/api/version") return { status: 200, body: JSON.stringify({ api_semver: FW[bar.runs].api }) };
      if (pathname === "/_emu/state") return { status: 200, body: JSON.stringify({ api_version: FW[bar.runs].api, firmware: { name: bar.runs, commit: FW[bar.runs].commit }, running: null }) };
      if (pathname === "/api/apps/list") return { status: 200, body: JSON.stringify({ apps: bar.apps }) };
      return { status: 404, body: "{}" };
    },
    async barSend(port, method, pathname, body = null) {
      sent.push([method, pathname]);
      if (pathname.startsWith("/api/apps/launch")) {
        const id = new URL(pathname, "http://x").searchParams.get("app_id");
        const app = bar.apps.find((one) => one.id === id);
        if (!app) return { status: 404, body: '{"error":"Not Found"}' };
        if (compareApi(app.api_version, FW[bar.runs].api) > 0) return { status: 409, body: '{"error":"API version mismatch, please update firmware"}' };
      }
      return { status: 200, body: '{"result":"OK","install_key":7,"staged":{"id":"x"}}' };
    },
    barLog: async () => ({ lines: [] }),
    runTool: async (_setup, request) => (tools.push(request), tool(request)),
    now: () => (now += 10),
    sleep: async (ms) => void (now += ms),
  };
}

async function call(argv, ctx, sys, { json = true } = {}) {
  const out = [];
  const err = [];
  const code = await main(json ? [...argv, "--json"] : argv, { ctx, sys, commands, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: json && out.length ? JSON.parse(out.at(-1)) : null };
}

/** A project with a built package for API `api`, trusted. */
function project(root, ctx, { id = "app.you.weather", api = "27.15.0" } = {}) {
  const dir = path.join(root, "weather");
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(path.join(cli, "dist"), { recursive: true });
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: {}, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  const manifest = JSON.stringify({ format_version: 1, id, name: "Weather", version: "1.0.0", api_version: api });
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), manifest);
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(path.join(cli, "dist", "index.js"), "");
  writeFileSync(path.join(dir, "dist", `${id}.tgz`), targz({ [`${id}/appmeta/manifest.json`]: manifest, [`${id}/scripts/main.js`]: "console.log(1);\n" }));
  trustProject(ctx.dataDir, dir, "created", { platform: ctx.platform });
  return realpathSync(dir);
}

// ---------------------------------------------------------------- help and words

test("help firmware: its first line as the epic words it; no word of flashing, installing, upgrading or updating but the update command", async (t) => {
  const { root, ctx } = setup(t);
  const help = await call(["help", "firmware"], ctx, fakeSystem(root), { json: false });
  assert.equal(help.code, 0);
  assert.equal(help.out.split("\n")[0], "Switches the emulated BUSY Bar to another firmware. Apps, their data and settings stay. Does not update the emulator app (that is `update`) and touches no real BUSY Bar.");
  const command = commands.find((one) => one.name === "firmware");
  const source = readFileSync(path.join(HERE, "..", "commands", "firmware.mjs"), "utf8");
  const head = source.split("\n").filter((line) => line.startsWith("//")).join("\n");
  // Every text: the head (the reference's text of the command), the help, the outputs, the MCP tools.
  const sys = fakeSystem(root);
  const outputs = [
    (await call(["firmware"], ctx, sys, { json: false })).out,
    (await call(["firmware", "use", "previous"], ctx, sys, { json: false })).out,
    (await call(["firmware", "use", "previous"], ctx, sys, { json: false })).out,
    (await call(["firmware", "use", "9.9"], ctx, sys, { json: false })).err,
    (await call(["firmware"], ctx, fakeSystem(root, { running: false }), { json: false })).out,
    (await call(["firmware", "use", "latest"], ctx, fakeSystem(root, { running: false }), { json: false })).err,
  ];
  const tools = TOOLS.filter((tool) => tool.name.startsWith("firmware"));
  assert.deepEqual(tools.map((tool) => tool.name), ["firmware_get", "firmware_use"]);
  const texts = [command.name, command.usage, command.summary.replace("Does not update the emulator app (that is `update`)", ""), ...command.details, head, ...outputs, ...tools.flatMap((tool) => [tool.name, tool.title, tool.description, JSON.stringify(tool.inputSchema)])];
  for (const text of texts) assert.doesNotMatch(text, /flash|install|upgrade|update/i, text);
});

// ---------------------------------------------------------------- firmware

test("firmware: what the BUSY Bar runs, the firmwares with their API and marks, and the one chosen for the next restart", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root);
  const shown = await call(["firmware"], ctx, sys);
  assert.equal(shown.code, 0);
  const { firmware, firmwares, pending, running } = shown.json;
  assert.deepEqual({ firmware, pending, running }, { firmware: { version: "1.4.1", api: "27.15.0", alias: "latest" }, pending: null, running: true });
  assert.deepEqual(firmwares.map(({ version, api, alias, running: runs, available }) => [version, api, alias, runs, available]), [["1.4.1", "27.15.0", "latest", true, true], ["1.3.1", "27.14.0", "previous", false, true]]);
  assert.deepEqual(sys.asked, [["GET", null]], "asked the management address, nothing switched");
  const text = (await call(["firmware"], ctx, sys, { json: false })).out;
  assert.equal(text, ["The emulated BUSY Bar runs firmware 1.4.1 (latest), API 27.15.0.", "  1.4.1  latest    API 27.15.0  running", "  1.3.1  previous  API 27.14.0", `Switch: ${SELF} firmware use previous`].join("\n"));
  // Not on the latest: the catalog's firmware and the way back, last.
  assert.equal((await call(["firmware"], ctx, fakeSystem(root, { runs: "1.3.1" }), { json: false })).out, ["The emulated BUSY Bar runs firmware 1.3.1 (previous), API 27.14.0.", "  1.4.1  latest    API 27.15.0", "  1.3.1  previous  API 27.14.0  running", "The catalog checks apps against 1.4.1, API 27.15.0. Back:", `  ${SELF} firmware use latest`].join("\n"));
  // Chosen for the next restart in the window: said, with what applies it.
  const waiting = fakeSystem(root, { pending: "1.3.1" });
  assert.deepEqual((await call(["firmware"], ctx, waiting)).json.pending, { version: "1.3.1", api: "27.14.0", alias: "previous" });
  assert.match((await call(["firmware"], ctx, waiting, { json: false })).out, new RegExp(`\\nChosen for the next restart: 1\\.3\\.1 \\(previous\\)\\. ${SELF.replace(/\./g, "\\.")} restart-bar applies it\\.\\n`));
  // The management address cannot be asked (no lock here): the BUSY Bar's own /_emu/state and the engine's list.
  const lockless = { ...fakeSystem(root, { runs: "1.3.1" }), readControl: () => ({ missing: "there is no run/server.lock" }) };
  const plain = await call(["firmware"], ctx, lockless);
  assert.equal(plain.code, 0, JSON.stringify(plain.json));
  assert.deepEqual([plain.json.firmware.version, plain.json.firmware.alias, plain.json.pending], ["1.3.1", "previous", null]);
  assert.match(plain.json.pending_unknown, /there is no run\/server\.lock/);
  assert.equal(plain.json.firmwares.find((one) => one.running).version, "1.3.1");
  // And switching needs it: no_management.
  assert.equal((await call(["firmware", "use", "latest"], ctx, lockless)).json.code, "no_management");
});

test("firmware without the emulator: the firmware the next start runs, the default or the one last switched to, from the engine", async (t) => {
  const { root, ctx } = setup(t);
  const engine = JSON.parse(readFileSync(path.join(HERE, "..", "..", "..", "engine", "firmware.json"), "utf8"));
  const off = await call(["firmware"], ctx, fakeSystem(root, { running: false }));
  assert.equal(off.code, 0);
  assert.equal(off.json.running, false);
  assert.equal(off.json.firmware.version, engine.default);
  assert.equal(off.json.firmware.alias, "latest");
  assert.equal(off.json.starts_with, "default");
  assert.deepEqual(off.json.firmwares.map((one) => one.version), Object.keys(engine.versions).sort().reverse());
  assert.ok(off.json.firmwares.every((one) => /^\d+\.\d+\.\d+$/.test(one.api) && one.running === false));
  const offText = (await call(["firmware"], ctx, fakeSystem(root, { running: false }), { json: false })).out.split("\n");
  assert.match(offText[0], /^The emulator is not running\. It starts on firmware \S+ \(latest\), API [\d.]+\.$/);
  assert.equal(offText.at(-1), `To switch: ${SELF} start, then ${SELF} firmware use previous`);
  const previous = off.json.firmwares.find((one) => one.alias === "previous");
  const chosen = await call(["firmware"], ctx, fakeSystem(root, { running: false, chosen: previous.version }));
  assert.deepEqual([chosen.json.firmware.version, chosen.json.starts_with], [previous.version, "chosen"]);
  const chosenText = (await call(["firmware"], ctx, fakeSystem(root, { running: false, chosen: previous.version }), { json: false })).out.split("\n");
  assert.equal(chosenText[0], `The emulator is not running. It starts on firmware ${previous.version} (previous), API ${previous.api}, the one it was last switched to.`);
  assert.equal(chosenText.at(-1), `To switch: ${SELF} start, then ${SELF} firmware use latest`);
  // One this copy does not have: the latest, as the server falls back.
  assert.equal((await call(["firmware"], ctx, fakeSystem(root, { running: false, chosen: "0.9.0" }))).json.firmware.version, engine.default);
});

test("firmware use: switches now, waits until the BUSY Bar's API answers with the new API, says from and to", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root);
  const done = await call(["firmware", "use", "previous"], ctx, sys);
  assert.equal(done.code, 0, JSON.stringify(done.json));
  assert.deepEqual(sys.asked.map(([method]) => method), ["GET", "POST"]);
  assert.deepEqual(sys.asked[1], ["POST", { version: "previous", when: "now" }]);
  const { firmware, from, changed, switch_ms: switchMs, pending } = done.json;
  assert.deepEqual({ firmware, from, changed, switchMs, pending }, { firmware: { version: "1.3.1", api: "27.14.0", alias: "previous" }, from: { version: "1.4.1", api: "27.15.0", alias: "latest" }, changed: true, switchMs: 1234, pending: null });
  assert.ok(Number.isInteger(done.json.ms));
  assert.ok(sys.sent.some(([method, pathname]) => method === "GET" && pathname === "/api/version"), "it waited for the BUSY Bar's API");
  sys.bar.runs = "1.4.1";
  const said = await call(["firmware", "use", "previous"], ctx, sys, { json: false });
  const text = said.out.split("\n");
  assert.equal(said.err, "Switching the emulated BUSY Bar's firmware to previous");
  assert.match(text[0], /^The emulated BUSY Bar runs firmware 1\.3\.1 \(previous\), API 27\.14\.0, and keeps it after restarts\. Switched in \d+ ms\.$/);
  assert.deepEqual(text.slice(1), ["Apps and their settings stay; the running app stopped.", "The catalog checks apps against 1.4.1, API 27.15.0. Back:", `  ${SELF} firmware use latest`]);
  // The one that runs: nothing changes, and it says so.
  const same = await call(["firmware", "use", "1.3.1"], ctx, sys);
  assert.deepEqual([same.code, same.json.changed], [0, false]);
  const already = await call(["firmware", "use", "previous"], ctx, sys, { json: false });
  assert.equal(already.out, "The emulated BUSY Bar already runs firmware 1.3.1 (previous), API 27.14.0.");
  assert.equal(already.err, "", "no line of switching when nothing changes");
  assert.equal((await call(["firmware", "use", "9.9"], ctx, sys, { json: false })).err.split("\n")[0], "busy-emulator: This emulator has no firmware \"9.9\". It has: 1.4.1 (latest), 1.3.1 (previous).", "nor for one there is not");
  // Back to the latest: no line about the latest any more.
  const back = await call(["firmware", "use", "latest"], ctx, sys, { json: false });
  assert.doesNotMatch(back.out, /catalog checks/);
});

test("firmware use: the server's refusals keep their codes, with a hint; a wrong call is usage; no emulator is not_running", async (t) => {
  const { root, ctx } = setup(t);
  const unknown = await call(["firmware", "use", "9.9"], ctx, fakeSystem(root));
  assert.deepEqual([unknown.code, unknown.json.code], [1, "firmware_unknown"]);
  assert.match(unknown.json.message, /no firmware "9\.9"/);
  assert.match(unknown.json.hint, /firmware lists the firmwares/);
  const switching = await call(["firmware", "use", "previous"], ctx, fakeSystem(root, { refuse: { status: 409, body: { code: "firmware_switching", error: "The emulated BUSY Bar is switching to firmware 1.4.1 now.", hint: "Wait until it is up, then ask for firmware 1.3.1 again." } } }));
  assert.deepEqual([switching.code, switching.json.code, switching.json.hint], [1, "firmware_switching", "Wait until it is up, then ask for firmware 1.3.1 again."]);
  const failed = await call(["firmware", "use", "previous"], ctx, fakeSystem(root, { refuse: { status: 500, body: { code: "firmware_start_failed", error: "Firmware 1.3.1 cannot start: broken.", hint: "The BUSY Bar runs firmware 1.4.1 as before.", firmware: FW["1.4.1"] } } }));
  assert.deepEqual([failed.json.code, failed.json.firmware], ["firmware_start_failed", { version: "1.4.1", api: "27.15.0", alias: "latest" }]);
  assert.match(failed.json.hint, /^The BUSY Bar runs firmware 1\.4\.1 as before\. .* logs says more\.$/);
  for (const words of [["firmware", "use"], ["firmware", "flash", "1.3.1"], ["firmware", "use", "1.3.1", "now"]]) {
    const wrong = await call(words, ctx, fakeSystem(root));
    assert.deepEqual([wrong.code, wrong.json.code], [2, "usage"], words.join(" "));
  }
  const off = await call(["firmware", "use", "previous"], ctx, fakeSystem(root, { running: false }));
  assert.deepEqual([off.code, off.json.code], [1, "not_running"]);
  assert.match(off.json.hint, / start, then run .* firmware use previous\.$/);
});

// ---------------------------------------------------------------- status and version

test("status and version name the firmware the BUSY Bar runs the same way: firmware { version, api }", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { runs: "1.3.1" });
  const status = await call(["status"], ctx, sys);
  const version = await call(["version"], ctx, sys);
  assert.deepEqual(status.json.firmware, { version: "1.3.1", api: "27.14.0", alias: "previous" });
  const { firmware: shown } = await call(["firmware"], ctx, sys).then((one) => one.json);
  assert.deepEqual(shown, status.json.firmware, "firmware, status and version: the same object");
  const { commit, ...same } = version.json.firmware;
  assert.deepEqual(same, status.json.firmware);
  assert.equal(commit, FW["1.3.1"].commit);
  assert.equal(version.json.firmware_source, "running");
  assert.match((await call(["status"], ctx, sys, { json: false })).out, /^The emulator is running: the BUSY Bar answers at http:\/\/127\.0\.0\.1:8640 \(process 4242\), on firmware 1\.3\.1 \(previous\), API 27\.14\.0\.$/);
  assert.match((await call(["version"], ctx, sys, { json: false })).out, /\nFirmware 1\.3\.1 \(previous\), API 27\.14\.0, commit 8edd2da4 \(running\)\n/);
  // Without the management address (a stand-in with no key): the BUSY Bar's own /_emu/state says it.
  const plain = { ...fakeSystem(root, { runs: "1.3.1" }), askFirmware: undefined };
  assert.deepEqual((await call(["status"], ctx, plain)).json.firmware, { version: "1.3.1", api: "27.14.0", alias: "previous" });
  // Not running: status has none; version names the one the next start runs.
  assert.equal((await call(["status"], ctx, fakeSystem(root, { running: false }))).json.firmware, null);
  const next = await call(["version"], ctx, fakeSystem(root, { running: false, chosen: "1.3.1" }));
  assert.deepEqual([next.json.firmware.version, next.json.firmware_source], ["1.3.1", "chosen"]);
  assert.match((await call(["version"], ctx, fakeSystem(root, { running: false, chosen: "1.3.1" }), { json: false })).out, /\nFirmware 1\.3\.1 \(previous\), API 27\.14\.0, commit 8edd2da4 \(not running; starts on it\)\n/);
});

// ---------------------------------------------------------------- MCP

test("MCP: firmware_get runs firmware and only reads; firmware_use runs firmware use, a version that starts with - stays one", async () => {
  const get = TOOLS.find((tool) => tool.name === "firmware_get");
  const use = TOOLS.find((tool) => tool.name === "firmware_use");
  assert.deepEqual(get.words({}), ["firmware"]);
  assert.equal(get.annotations.readOnlyHint, true);
  assert.equal(get.parallel, true);
  assert.deepEqual(use.words({ version: "previous" }), ["firmware", "use", "--", "previous"]);
  assert.deepEqual(use.inputSchema.required, ["version"]);
  assert.equal(use.annotations.readOnlyHint, false);
  assert.match(get.description, /api_mismatch/);
  assert.match(use.description, /Apps and their settings stay; the running app stops/);
});

// ---------------------------------------------------------------- api_mismatch

test("the firmware that runs an app: the oldest whose API is not older than the app's; where things came from, by the builds", () => {
  const three = [
    { version: "1.5.0", api: "27.16.0", alias: "latest", info: { consoleSeverities: ["log", "warn"], appAllowlist: { storage: "" } } },
    { version: "1.4.1", api: "27.15.0", alias: "previous", info: { consoleSeverities: ["log", "warn"], appAllowlist: { storage: "" } } },
    { version: "1.3.1", api: "27.14.0", alias: null, info: { consoleSeverities: ["log"], appAllowlist: {} } },
  ].map((one) => ({ ...one, available: true }));
  assert.equal(firmwareFor("27.15.0", three).version, "1.4.1");
  assert.equal(firmwareFor("27.14.5", three).version, "1.4.1");
  assert.equal(firmwareFor("27.12.0", three).version, "1.3.1");
  assert.equal(firmwareFor("27.17.0", three), null);
  assert.equal(firmwareFor("27.15.0", three.map((one) => (one.version === "1.4.1" ? { ...one, available: false } : one))).version, "1.5.0");
});

test("api_mismatch: both numbers as firmware and API, then both ways out in order; the firmware named is the one that runs the app", (t) => {
  const { ctx } = setup(t);
  const firmwares = [FW["1.4.1"], FW["1.3.1"]].map((one) => ({ ...one, available: true }));
  const refusal = apiMismatch(ctx, { id: "app.you.weather", name: "Weather", api: "27.15.0", manifest: "src/appmeta/manifest.json", running: { version: "1.3.1", api: "27.14.0" }, firmwares });
  assert.equal(refusal.code, "api_mismatch");
  assert.equal(refusal.message, "Weather needs API 27.15.0; this BUSY Bar runs firmware 1.3.1, API 27.14.0.");
  assert.equal(refusal.hint, `If Weather needs nothing newer, set api_version to 27.14.0 in src/appmeta/manifest.json and build again. Or switch:\n  ${SELF} firmware use latest`);
  assert.deepEqual(refusal.extra, { id: "app.you.weather", api_version: "27.15.0", firmware: { version: "1.3.1", api: "27.14.0" }, needs_firmware: { version: "1.4.1", api: "27.15.0", alias: "latest" }, manifest: "src/appmeta/manifest.json" });
  // Newer than every firmware here: no firmware to name, and the way to a newer emulator.
  const none = apiMismatch(ctx, { name: "Weather", api: "28.0.0", manifest: "src/appmeta/manifest.json", running: { version: "1.4.1", api: "27.15.0" }, firmwares });
  assert.equal(none.message, "Weather needs API 28.0.0; this BUSY Bar runs firmware 1.4.1, API 27.15.0. No firmware here has API 28.0.0; the newest is 1.4.1, API 27.15.0.");
  assert.equal(none.hint, `Set api_version to 27.15.0 or lower, or look for a newer emulator:\n  ${SELF} update --check`);
  assert.equal(none.extra.needs_firmware, null);
});

test("install, run and dev refuse a package for a newer API than the firmware's before busy-cli runs, with api_mismatch", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  for (const words of [["install", dir], ["run", dir], ["dev", dir, "--once"]]) {
    const sys = fakeSystem(root, { runs: "1.3.1" });
    if (words[0] === "dev") sys.followConsole = () => ({ opened: Promise.resolve({}), close() {} });
    const refused = await call(words, ctx, sys);
    assert.deepEqual([refused.code, refused.json.code], [1, "api_mismatch"], words.join(" ") + JSON.stringify(refused.json));
    assert.deepEqual(refused.json.firmware, { version: "1.3.1", api: "27.14.0" });
    assert.deepEqual(refused.json.needs_firmware, { version: "1.4.1", api: "27.15.0", alias: "latest" });
    assert.equal(refused.json.hint, `If app.you.weather needs nothing newer, set api_version to 27.14.0 in src/appmeta/manifest.json and build again. Or switch:\n  ${SELF} firmware use latest`);
    assert.ok(!sys.tools.some((request) => request.args.includes("install")), `${words[0]}: busy-cli app install never ran`);
  }
  // dev tells it as its round's event, and goes on watching without --once.
  const sys = fakeSystem(root, { runs: "1.3.1" });
  sys.followConsole = () => ({ opened: Promise.resolve({}), close() {} });
  const text = await call(["dev", dir, "--once"], ctx, sys, { json: false });
  assert.match(text.out, /failed +app\.you\.weather needs API 27\.15\.0; this BUSY Bar runs firmware 1\.3\.1, API 27\.14\.0\.\nIf app\.you\.weather needs nothing newer, set api_version to 27\.14\.0/);
  // On a firmware that takes it: busy-cli installs it.
  const fits = fakeSystem(root, { runs: "1.4.1" });
  const installed = await call(["install", dir], ctx, fits);
  assert.equal(installed.code, 0, JSON.stringify(installed.json));
  assert.ok(fits.tools.some((request) => request.args.includes("install")));
});

test("run <app-id>: an app on the BUSY Bar for a newer API is api_mismatch, not run_failed", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { runs: "1.3.1", apps: [{ id: "app.you.weather", api_version: "27.15.0" }] });
  const refused = await call(["run", "app.you.weather"], ctx, sys);
  assert.deepEqual([refused.code, refused.json.code, refused.json.api_version], [1, "api_mismatch", "27.15.0"]);
  assert.match(refused.json.hint, /in its project's manifest and build again\. Or switch:\n {2}.* firmware use latest$/);
});
