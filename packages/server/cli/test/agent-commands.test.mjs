// What an agent tripped on in the field test, against a stand-in for the system: --help's exit code, create in the
// caller's own folder, a settings file the bar would refuse (build, run), and the agent's hands — press, settings,
// typecheck — and its way to the person, trust. The commands against a real emulated bar are in
// emulator/test/server/agent-hands.test.mjs. No network, no tool is started.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";

import { isTrusted, trustProject } from "../../projects/trust.mjs";
import { SECTION_BEGIN } from "../../projects/template-fixes.mjs";
import { markChecked } from "../../publish/test/stale-support.mjs";
import { loadCommands, main } from "../busy-emulator.mjs";

// Every test here runs against stand-ins and takes well under a second; one that waits on something that never comes
// fails at 30 s instead of holding the unit suite until the gate's limit. (A loop that never yields, like the volumeOf
// walk that spun on Windows, is stopped by no timeout inside the process: only by ending it.)
const TEST_TIMEOUT_MS = 30_000;
const test = (name, fn) => nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);

const commands = await loadCommands();
const SELF = "/Users/you/.busy-emulator/bin/busy-emulator";
const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };
const KEY = "k".repeat(43);
const ID = "app.you.clock";

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-agent-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const ctx = {
    platform: "darwin",
    kind: "release",
    development: false,
    appPath: "/Applications/BUSY Bar Emulator.app",
    dataDir,
    runStateFile: path.join(dataDir, "run", "emulator.json"),
    calledAs: [SELF],
    testLaunch: null,
    nodeTools: { node: "/x/node", npmCli: "/x/npm-cli.js", npxCli: "/x/npx-cli.js", nodeDir: "/x" },
    env: {},
  };
  return { root, ctx };
}

/** A stand-in for system.mjs: an emulator that runs (or not), a bar that keeps what it is sent, tools that are recorded. */
function fakeSystem(root, { running = true, bar = () => ({ status: 200, body: '{"result":"OK"}' }), tool = () => ({ code: 0, signal: null, output: "" }), trust = null, log = [] } = {}) {
  const sent = [];
  const tools = [];
  let now = 5_000_000;
  return {
    sent,
    tools,
    cwd: () => root,
    readRunState: () => (running ? { state: READY } : { missing: true }),
    alive: () => running,
    probe: async () => (running ? { answering: true } : { answering: false, code: "ECONNREFUSED" }),
    processInfo: () => ({ start: 999_500, exe: READY.exe }),
    samePath: (a, b) => a === b,
    readControl: () => ({ port: 51234, barPort: 8640, key: KEY }),
    barGet: async (port, pathname) => (sent.push(["GET", pathname]), bar("GET", pathname, null)),
    barSend: async (port, method, pathname, body = null) => (sent.push([method, pathname, ...(body === null ? [] : [body])]), bar(method, pathname, body)),
    barLog: async () => ({ lines: typeof log === "function" ? log() : log }),
    askTrust: async (port, key, folder, waitMs) => (sent.push(["askTrust", port, key, folder, waitMs]), trust(folder)),
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

/** A project as create leaves it: package.json naming busy-cli (installed), a manifest, trusted unless told. */
function project(root, ctx, name = "clock", { trusted = true, settings = null, scripts = { typecheck: "tsc" } } = {}) {
  const dir = path.join(root, name);
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(path.join(cli, "dist"), { recursive: true });
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id: ID }));
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(path.join(cli, "dist", "index.js"), "");
  if (settings !== null) writeFileSync(path.join(dir, "src", "appmeta", "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  if (trusted) trustProject(ctx.dataDir, dir, "created", { platform: ctx.platform });
  return realpathSync(dir);
}

// ---------------------------------------------------------------- --help

test("--help and -h print the help and end with 0; no command at all is still a wrong call", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root);
  for (const words of [["--help"], ["-h"], ["help"], ["press", "--help"], ["--help", "settings"], ["trust", "-h"]]) {
    const answer = await call(words, ctx, sys, { json: false });
    assert.equal(answer.code, 0, words.join(" "));
    assert.equal(answer.err, "");
  }
  assert.match((await call(["--help"], ctx, sys, { json: false })).out, /^busy-emulator: the command line of BUSY Bar Emulator\.[\s\S]*Commands:/);
  assert.match((await call(["press", "--help"], ctx, sys, { json: false })).out, / press <up\|down\|ok\|back\|start> \[--times <n>\] \[--hold <ms>\] \[--power-on\] \[--json\]$/);
  assert.equal((await call(["--help"], ctx, sys)).json.ok, true);
  assert.equal((await call([], ctx, sys, { json: false })).code, 2);
});

// ---------------------------------------------------------------- create in the caller's own folder

test("create . in a folder with files says what is in the way and the command to give instead", async (t) => {
  const { root, ctx } = setup(t);
  const seat = path.join(root, "seat");
  mkdirSync(path.join(seat, ".claude"), { recursive: true });
  writeFileSync(path.join(seat, "AGENTS.md"), "x");
  const sys = { ...fakeSystem(seat) };
  const refused = await call(["create", ".", "--name", "Focus Timer"], ctx, sys);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "folder_not_empty");
  assert.match(refused.json.message, /seat is not empty \(it holds \.claude, AGENTS\.md\): create makes the project's folder itself/);
  assert.equal(refused.json.hint, `Give a folder name that is not taken; create makes the folder: ${SELF} create focus-timer.`);
  assert.deepEqual(refused.json.holds, [".claude", "AGENTS.md"]);
  assert.equal(refused.json.suggestion, "focus-timer");
  assert.deepEqual(sys.tools, [], "nothing ran");
  // A name that is taken already is not offered; a folder named beside the caller's gets a name beside it.
  mkdirSync(path.join(seat, "focus-timer"));
  assert.equal((await call(["create", ".", "--name", "Focus Timer"], ctx, sys)).json.suggestion, "focus-timer-2");
  mkdirSync(path.join(seat, "apps", "clock"), { recursive: true });
  writeFileSync(path.join(seat, "apps", "clock", "x"), "");
  assert.equal((await call(["create", "apps/clock"], ctx, sys)).json.suggestion, path.join("apps", "clock-2"));
});

test("create . in a folder that holds only .git is refused: someone else's git settings do not become part of a trusted project", async (t) => {
  const { root, ctx } = setup(t);
  const seat = path.join(root, "planted");
  mkdirSync(path.join(seat, ".git"), { recursive: true });
  writeFileSync(path.join(seat, ".git", "config"), "[core]\n\tfsmonitor = ./run-me.sh\n");
  const sys = { ...fakeSystem(seat) };
  const refused = await call(["create", "."], ctx, sys);
  assert.equal(refused.json.code, "folder_not_empty");
  assert.deepEqual(refused.json.holds, [".git"]);
  assert.match(refused.json.message, /it holds \.git; a git repository that is there already is not made part of a trusted project, so run git init after create/);
  assert.deepEqual(sys.tools, [], "nothing ran");
  assert.equal(isTrusted(ctx.dataDir, seat, ctx.platform), false);
});

test("a project inside another git repository is made, and the answer names that repository: its hooks and core.fsmonitor apply", async (t) => {
  const { repositoryAbove } = await import("../commands/create.mjs");
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-repo-above-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const monorepo = path.join(home, "work", "monorepo");
  mkdirSync(path.join(monorepo, ".git"), { recursive: true });
  mkdirSync(path.join(monorepo, "apps"), { recursive: true });
  assert.equal(repositoryAbove(path.join(monorepo, "apps", "clock"), home), monorepo);
  assert.equal(repositoryAbove(path.join(home, "elsewhere", "clock"), home), null, "nothing up to the home folder");
  // A .git above the home folder is not looked for.
  mkdirSync(path.join(root, ".git"));
  assert.equal(repositoryAbove(path.join(home, "elsewhere", "clock"), home), null);
  writeFileSync(path.join(home, ".git"), "gitdir: x\n");
  assert.equal(repositoryAbove(path.join(home, "elsewhere", "clock"), home), home, "a .git file counts as well");
});

test("create . in an empty folder makes the project there, with the settings helper and the AGENTS.md put right", async (t) => {
  const { root, ctx } = setup(t);
  const seat = path.join(root, "empty seat");
  mkdirSync(seat, { recursive: true });
  writeFileSync(path.join(seat, ".DS_Store"), "");
  // A repository above the folder (a monorepo): the project is made, and the answer names it.
  mkdirSync(path.join(root, ".git"));
  let n = 0;
  const sys = fakeSystem(seat, {
    tool(request) {
      n += 1;
      if (n === 1) {
        // The generator's registry is on npm's command line, where the environment does not override it.
        assert.equal(request.args.filter((word) => /^--(?:@busy-app:)?registry=https?:\/\//.test(word)).length, 2, request.args.join(" "));
        assert.ok(request.args.includes("--strict-ssl=true"), request.args.join(" "));
        const pkg = path.join(request.cwd, "node_modules", "@busy-app", "create-app");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.5.0", bin: { "create-app": "dist/index.js" } }));
      } else if (n === 2) {
        // The generator: it is given the folder itself.
        assert.equal(request.args[1], seat);
        mkdirSync(path.join(seat, "shared"));
        writeFileSync(path.join(seat, "package.json"), JSON.stringify({ name: "x", scripts: { typecheck: "tsc" }, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
        writeFileSync(path.join(seat, "shared", "settings.ts"), "function api() { return (globalThis as { Settings?: SettingsApi }).Settings; }\n");
        writeFileSync(path.join(seat, "AGENTS.md"), "# AGENTS.md\n\nIntro.\n\n## Code rules\n\n- run `npm run typecheck`.\n");
      } else {
        const cli = path.join(seat, "node_modules", "@busy-app", "cli");
        mkdirSync(path.join(cli, "dist"), { recursive: true });
        writeFileSync(path.join(cli, "package.json"), JSON.stringify({ bin: { "busy-cli": "dist/index.js" } }));
        writeFileSync(path.join(cli, "dist", "index.js"), "");
      }
      return { code: 0, signal: null, output: "" };
    },
  });
  const made = await call(["create", ".", "--author", "X"], ctx, sys);
  assert.equal(made.code, 0, JSON.stringify(made.json));
  assert.equal(made.json.folder, realpathSync(seat));
  assert.equal(made.json.inside_repository, realpathSync(root), "the repository the project sits inside");
  assert.deepEqual(made.json.template, { settings_helper: "replaced", agents_md: "added" });
  assert.match(readFileSync(path.join(seat, "shared", "settings.ts"), "utf8"), /device\.AppsSettingsGet\(\{ app_id: manifest\.id \}\)/);
  const agents = readFileSync(path.join(seat, "AGENTS.md"), "utf8");
  assert.ok(agents.includes(SECTION_BEGIN));
  assert.match(agents, /run `busy-emulator typecheck`\./);
});

// ---------------------------------------------------------------- a settings file the bar would refuse

test("build fails on an invalid settings file with the field at fault, before any tool runs; a valid one builds", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx, "clock", { settings: { format_version: 1, version: 1, fields: { format: { type: "select", label: "Format", default: "24" } } } });
  const sys = fakeSystem(dir);
  const refused = await call(["build"], ctx, sys);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "settings_invalid");
  assert.equal(refused.json.field, "format");
  assert.equal(refused.json.problem, "unknown type 'select'");
  assert.equal(refused.json.message, `The app's settings file is invalid, ${path.join("src", "appmeta", "settings.json")}, field "format": unknown type 'select'. A BUSY Bar would show "Settings file is invalid." instead of the app.`);
  assert.match(refused.json.hint, /for this one use "enum"\. Fix .*settings\.json, then run \S+ build again\. The smallest valid file: \{"format_version":1,"version":1,"fields":\{/);
  assert.deepEqual(sys.tools, [], "busy-cli did not run");
  // Not JSON at all, and a file's own key.
  writeFileSync(path.join(dir, "src", "appmeta", "settings.json"), "{ fields: ");
  assert.match((await call(["build"], ctx, sys)).json.problem, /^Malformed JSON/);
  writeFileSync(path.join(dir, "src", "appmeta", "settings.json"), JSON.stringify({ format_version: 1, version: 1, fields: { hour24: { type: "boolean", label: "24 h", default: true } } }));
  const built = await call(["build"], ctx, sys);
  assert.equal(built.code, 0, JSON.stringify(built.json));
  assert.equal(built.json.settings, "valid");
  assert.equal(sys.tools.at(-1).args.at(-1), "build");
  // A project without the file has no settings: nothing to check.
  rmSync(path.join(dir, "src", "appmeta", "settings.json"));
  assert.equal((await call(["build"], ctx, sys)).json.settings, "none");
});

test("run fails on an invalid settings file before anything is installed", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx, "clock", { settings: { format_version: 1, version: 1, fields: [] } });
  const sys = fakeSystem(dir);
  const refused = await call(["run"], ctx, sys);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "settings_invalid");
  assert.match(refused.json.hint, /"fields" is a map keyed by each field's id.*not a list/);
  assert.deepEqual([sys.tools, sys.sent], [[], []]);
});

test("run: a launch the BUSY Bar answers with OK while it refuses the package's settings file is a failure, in the firmware's words", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  let launchedAt = 0;
  const sys = fakeSystem(dir, {
    bar: (method, pathname) => (pathname.startsWith("/api/apps/settings") ? { status: 503, body: '{"error":"Application settings schema is invalid"}' } : { status: 200, body: JSON.stringify({ apps: [{ id: ID }] }) }),
    tool: (request) => (request.args.includes("run") && (launchedAt = 5_000_000), { code: 0, signal: null, output: "◆  Launched" }),
    // No "Launch <id>" line: the launcher stopped at the settings file, and the firmware's parser said why.
    log: () => [{ kind: "warn", text: "[JsAppSettings] Field 'format': unknown type 'select'", time: launchedAt + 100 }],
  });
  const refused = await call(["run"], ctx, sys);
  assert.equal(refused.code, 1, JSON.stringify(refused.json));
  assert.equal(refused.json.code, "settings_invalid");
  assert.equal(refused.json.message, `${ID} was not started: the BUSY Bar refuses the settings file in its package (appmeta/settings.json): Field 'format': unknown type 'select'. The BUSY Bar shows "Settings file is invalid." instead of the app.`);
  assert.match(refused.json.hint, /^Build the project again: \S+ build checks src\/appmeta\/settings\.json/);
  assert.equal(refused.json.running, false);
});

// ---------------------------------------------------------------- stop with no app running (the release dry run)

test("stop with no app running is a success that says so; another failure of busy-cli is still one", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  // busy-cli 0.6.0 on the bar's 409 to POST /api/apps/quit.
  const nothing = { code: 1, signal: null, output: "■  BUSY Bar API POST /api/apps/quit failed: 409 Conflict\nNo app is running.\n" };
  const sys = fakeSystem(dir, { tool: () => nothing });
  const idle = await call(["stop"], ctx, sys);
  assert.equal(idle.code, 0, JSON.stringify(idle.json));
  assert.equal(idle.json.ok, true);
  assert.deepEqual([idle.json.stopped, idle.json.was_running, idle.json.id], [false, false, ID]);
  const text = await call(["stop"], ctx, sys, { json: false });
  assert.equal(text.code, 0);
  assert.equal(text.out, "No app was running on the emulated BUSY Bar at 127.0.0.1:8640: there was nothing to stop.");
  // An app that runs is stopped as before.
  const stopped = await call(["stop"], ctx, fakeSystem(dir, { tool: () => ({ code: 0, signal: null, output: "◆  Stopped" }) }));
  assert.deepEqual([stopped.code, stopped.json.stopped, stopped.json.was_running], [0, true, true]);
  // Any other failure stays a failure; install's 409 is not "nothing running".
  const failed = await call(["stop"], ctx, fakeSystem(dir, { tool: () => ({ code: 1, signal: null, output: "The BUSY Bar failed to quit the running app.\n" }) }));
  assert.deepEqual([failed.code, failed.json.code], [1, "tool_failed"]);
  const install = await call(["install"], ctx, fakeSystem(dir, { tool: () => nothing }));
  assert.deepEqual([install.code, install.json.code], [1, "tool_failed"]);
});

// ---------------------------------------------------------------- press

test("press: the BUSY Bar's input API, once or --times; --hold holds the button down and lets it go", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root);
  const once = await call(["press", "ok"], ctx, sys);
  assert.deepEqual(once.json, { ok: true, command: "press", key: "ok", times: 1, hold_ms: null, address: "127.0.0.1:8640" });
  assert.deepEqual(sys.sent, [["POST", "/api/input?key=ok"]]);
  sys.sent.length = 0;
  assert.equal((await call(["press", "down", "--times", "3"], ctx, sys)).json.times, 3);
  assert.deepEqual(sys.sent, Array(3).fill(["POST", "/api/input?key=down"]));
  sys.sent.length = 0;
  const before = sys.now();
  const held = await call(["press", "START", "--hold=800"], ctx, sys);
  assert.equal(held.json.hold_ms, 800);
  assert.deepEqual(sys.sent, [["GET", "/_emu/state"], ["POST", "/_emu/key?key=start&action=down"], ["POST", "/_emu/key?key=start&action=up"]]);
  assert.ok(sys.now() - before >= 800, "it waited while the button was down");
  const said = await call(["press", "back"], ctx, sys, { json: false });
  assert.match(said.out, /^Pressed Back on the emulated BUSY Bar at 127\.0\.0\.1:8640\. To see what the app made of it: \S+ screenshot --scale 8, \S+ logs\.$/);
});

test("press: wrong calls are told before anything is sent; no emulator is not_running", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root);
  for (const [words, text] of [[[], /press needs a key: up, down, ok, back, start/], [["left"], /There is no key "left"/], [["ok", "--times", "0"], /--times takes a whole number from 1 to 100/], [["ok", "--hold", "abc"], /--hold takes a whole number from 1 to 10000/], [["up", "--hold", "500"], /--hold is for a button/], [["ok", "start"], /takes no argument "start"/]]) {
    const wrong = await call(["press", ...words], ctx, sys);
    assert.equal(wrong.code, 2, words.join(" "));
    assert.match(wrong.json.message, text);
  }
  assert.deepEqual(sys.sent, []);
  const off = await call(["press", "ok"], ctx, fakeSystem(root, { running: false }));
  assert.deepEqual([off.code, off.json.code], [1, "not_running"]);
  assert.match(off.json.hint, / start, then run \S+ press ok again\.$/);
  const refusedKey = await call(["press", "ok"], ctx, fakeSystem(root, { bar: () => ({ status: 400, body: '{"error":"Bad Request"}' }) }));
  assert.deepEqual([refusedKey.code, refusedKey.json.code], [1, "press_failed"]);
  assert.match(refusedKey.json.message, /\(HTTP 400: Bad Request\)\.$/);
});

// ---------------------------------------------------------------- restart-bar

test("restart-bar: asks the restart and waits for it, then for the BUSY Bar's API; says how long it took", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { bar: (method, pathname) => (pathname.startsWith("/_emu/power") ? { status: 200, body: '{"powered":true,"ms":900}' } : { status: 200, body: '{"api_semver":"27.14.0"}' }) });
  const done = await call(["restart-bar"], ctx, sys);
  assert.equal(done.code, 0);
  assert.deepEqual(sys.sent, [["POST", "/_emu/power?action=restart&wait=1&why=cli"], ["GET", "/api/version"]]);
  assert.equal(done.json.command, "restart-bar");
  assert.equal(done.json.address, "127.0.0.1:8640");
  assert.equal(done.json.restarted, true);
  assert.ok(Number.isInteger(done.json.ms) && done.json.ms > 0);
  const said = await call(["restart-bar"], ctx, sys, { json: false });
  assert.match(said.out, /^The emulated BUSY Bar at 127\.0\.0\.1:8640 restarted, as holding Back and Start does on a real BUSY Bar, and answers again after \d+\.\d s\. The installed apps and their settings are kept/);
  const wrong = await call(["restart-bar", "now"], ctx, sys);
  assert.equal(wrong.code, 2);
  const off = await call(["restart-bar"], ctx, fakeSystem(root, { running: false }));
  assert.deepEqual([off.code, off.json.code], [1, "not_running"]);
  const dark = await call(["restart-bar"], ctx, fakeSystem(root, { bar: () => ({ status: 503, body: '{"powered":false}' }) }));
  assert.deepEqual([dark.code, dark.json.code], [1, "restart_failed"]);
  assert.match(dark.json.message, /is off after the restart/);
  const silent = await call(["restart-bar"], ctx, fakeSystem(root, { bar: (method, pathname) => (pathname.startsWith("/_emu/power") ? { status: 200, body: "{}" } : { failed: "ECONNREFUSED" }) }));
  assert.deepEqual([silent.code, silent.json.code], [1, "restart_failed"]);
  assert.match(silent.json.message, /its API does not answer/);
});

test("press on a BUSY Bar that is powered off: bar_off, which says why and how to turn it on; --power-on turns it on", async (t) => {
  const { root, ctx } = setup(t);
  const state = { powered: false };
  const bar = (method, pathname) => {
    if (pathname === "/_emu/state") return { status: 200, body: JSON.stringify({ powered: state.powered }) };
    if (pathname.startsWith("/_emu/press")) return ((state.powered = true), { status: 200, body: '{"result":"OK"}' });
    if (!state.powered) return { status: 503, body: '{"error":"The emulated BUSY Bar is powered off: press one of its buttons to turn it on"}' };
    return { status: 200, body: '{"result":"OK"}' };
  };
  for (const words of [["ok"], ["start", "--hold", "500"]]) {
    const sys = fakeSystem(root, { bar });
    const off = await call(["press", ...words], ctx, sys);
    assert.deepEqual([off.code, off.json.code], [1, "bar_off"], words.join(" "));
    assert.match(off.json.message, /^The emulated BUSY Bar at 127\.0\.0\.1:8640 is powered off, so the key \w+ reached nothing: a BUSY Bar that is off answers nothing over its API, and a press of one of its own buttons only turns it on\.$/);
    assert.match(off.json.hint, /^Turn it on with \S+ press \w+ --power-on \(or a button in the emulator's window\), then press again\.$/);
    assert.equal(state.powered, false, "nothing turned it on");
    assert.ok(!sys.sent.some(([, pathname]) => pathname.startsWith("/_emu/key")), "a held press would have turned it on");
  }
  const sys = fakeSystem(root, { bar });
  const on = await call(["press", "start", "--power-on"], ctx, sys);
  assert.equal(on.code, 0, on.out);
  assert.equal(on.json.powered_on, true);
  assert.equal(on.json.up, true);
  assert.deepEqual(sys.sent, [["GET", "/_emu/state"], ["POST", "/_emu/press?key=start"], ["GET", "/api/version"]]);
  assert.equal(state.powered, true);
  // On a bar that is on, --power-on is a press like any other.
  sys.sent.length = 0;
  assert.equal((await call(["press", "ok", "--power-on"], ctx, sys)).json.times, 1);
  assert.deepEqual(sys.sent, [["GET", "/_emu/state"], ["POST", "/api/input?key=ok"]]);
});

// ---------------------------------------------------------------- settings

/** A bar that holds one app's settings document, as /api/apps/settings does. */
function settingsBar(values, { refuse = null } = {}) {
  const state = { document: { version: 3, values }, puts: [], launched: 0, quit: 0, refused: [] };
  const bar = (method, pathname, body) => {
    if (pathname === "/api/apps/quit") return (state.quit++, { status: 200, body: '{"result":"OK"}' });
    if (pathname.startsWith("/api/apps/launch")) return (state.launched++, { status: 200, body: '{"result":"OK"}' });
    if (pathname === "/_emu/state") return { status: 200, body: JSON.stringify({ running: { id: ID } }) };
    assert.equal(pathname, `/api/apps/settings?app_id=${ID}`);
    if (method === "GET") return { status: 200, body: `${JSON.stringify(state.document)}\n` };
    if (method === "DELETE") return ((state.document = { version: 3, values: { hour24: true, minutes: 25, title: "FOCUS", place: { mode: "auto", name: "Here" }, look: { theme: "amber" } } }), { status: 200, body: '{"result":"OK"}' });
    const sent = JSON.parse(body);
    state.puts.push(sent);
    if (refuse) return (state.refused.push({ kind: "warn", text: `The settings sent for ${ID} were refused (the BUSY Bar answers only "Bad Request"): ${refuse}`, time: 5_000_500 }), { status: 400, body: '{"error":"Bad Request"}' });
    state.document = sent;
    return { status: 200, body: '{"result":"OK"}' };
  };
  return { state, bar };
}
const VALUES = () => ({ hour24: true, minutes: 25, title: "FOCUS", place: { mode: "auto", name: "Here" }, look: { theme: "amber" } });

test("settings get: the values the BUSY Bar holds, for the project's app, for --app, and outside a project for the app that runs", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx, "clock", { trusted: false });
  const { bar } = settingsBar(VALUES());
  const got = await call(["settings", "get"], ctx, fakeSystem(dir, { bar }));
  assert.equal(got.code, 0, JSON.stringify(got.json));
  assert.deepEqual(got.json, { ok: true, command: "settings", id: ID, address: "127.0.0.1:8640", version: 3, values: VALUES() });
  assert.deepEqual((await call(["settings", "get", "clock"], ctx, fakeSystem(root, { bar }))).json.values, VALUES());
  assert.equal((await call(["settings", "get", "--app", ID], ctx, fakeSystem(root, { bar }))).json.id, ID);
  // Outside a project and without a name: the app that runs.
  assert.equal((await call(["settings", "get"], ctx, fakeSystem(root, { bar }))).json.id, ID);
  const text = await call(["settings", "get"], ctx, fakeSystem(dir, { bar }), { json: false });
  assert.match(text.out, /  hour24 = true\n  minutes = 25\n  title = "FOCUS"\n  place = \{"mode":"auto","name":"Here"\}\n  look\.theme = "amber"\n/);
});

test("settings through MCP (ctx.mcp): a sensitive value reads as (hidden) in every answer and can still be set; a person sees it", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  const values = () => ({ url: "http://example.com/", header: "Authorization: Bearer abc123", empty: "", look: { token: "t0ken", theme: "amber" } });
  const schema = { format_version: 1, version: 3, fields: { url: { type: "string", label: "URL", default: "" }, header: { type: "string", label: "Header", default: "", sensitive: true }, empty: { type: "string", label: "E", default: "", sensitive: true }, look: { type: "group", label: "Look", fields: { token: { type: "string", label: "T", default: "", sensitive: true }, theme: { type: "string", label: "Theme", default: "amber" } } } } };
  const schemaPath = `/api/storage/read?path=${encodeURIComponent(`/ext/user_assets/${ID}/appmeta/settings.json`)}`;
  const withSchema = (answer) => {
    const { state, bar } = settingsBar(values(), { refuse: answer.refuse });
    return { state, bar: (method, pathname, body) => (pathname === schemaPath ? answer.schema : bar(method, pathname, body)) };
  };
  const mcp = { ...ctx, mcp: true };
  const secret = /abc123|t0ken/;

  const one = withSchema({ schema: { status: 200, body: JSON.stringify(schema) } });
  const got = await call(["settings", "get"], mcp, fakeSystem(dir, { bar: one.bar }));
  assert.deepEqual(got.json.values, { url: "http://example.com/", header: "(hidden)", empty: "", look: { token: "(hidden)", theme: "amber" } });
  assert.doesNotMatch(got.out, secret);
  const text = await call(["settings", "get"], mcp, fakeSystem(dir, { bar: one.bar }), { json: false });
  assert.match(text.out, /  header = "\(hidden\)"\n/);
  assert.doesNotMatch(text.out, secret);

  // Set: the real value goes to the bar, the answer hides it again.
  const set = await call(["settings", "set", "header=X-Key: new-secret", "url=http://example.org/"], mcp, fakeSystem(dir, { bar: one.bar }));
  assert.equal(set.code, 0, JSON.stringify(set.json));
  assert.deepEqual(one.state.puts.at(-1).values, { ...values(), header: "X-Key: new-secret", url: "http://example.org/" });
  assert.equal(set.json.values.header, "(hidden)");
  assert.doesNotMatch(JSON.stringify(set.json.values), /new-secret|t0ken/);
  // A wrong key and a refusal carry the values too: hidden there as well.
  const wrong = await call(["settings", "set", "nope=1"], mcp, fakeSystem(dir, { bar: one.bar }));
  assert.equal(wrong.json.code, "usage");
  assert.doesNotMatch(wrong.out, /new-secret|t0ken/);
  const refusing = withSchema({ schema: { status: 200, body: JSON.stringify(schema) }, refuse: "Invalid value for url" });
  const refused = await call(["settings", "set", "url=x"], mcp, fakeSystem(dir, { bar: refusing.bar, log: () => refusing.state.refused }));
  assert.equal(refused.json.code, "settings_refused");
  assert.doesNotMatch(refused.out, secret);

  // The schema cannot be read: every text value is hidden.
  const blind = withSchema({ schema: { status: 404, body: '{"error":"Not Found"}' } });
  assert.deepEqual((await call(["settings", "get"], mcp, fakeSystem(dir, { bar: blind.bar }))).json.values, { url: "(hidden)", header: "(hidden)", empty: "", look: { token: "(hidden)", theme: "(hidden)" } });

  // The command line for a person (or an agent in a terminal, which can read the data folder anyway) shows them.
  const shown = await call(["settings", "get"], ctx, fakeSystem(dir, { bar: one.bar }));
  assert.equal(shown.json.values.header, "X-Key: new-secret");
});

test("settings set: each value is read by the kind of the one it replaces, and the whole document goes to the BUSY Bar", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  const { state, bar } = settingsBar(VALUES());
  const sys = fakeSystem(dir, { bar });
  // A geolocation is given as JSON (the coordinates are made here, so that no line reads as somebody's place).
  const place = ((north, east) => ({ mode: "fixed", name: "Home", lat: north, lon: east }))(1, 2);
  const set = await call(["settings", "set", "hour24=false", "minutes=-5", "title=two words = here", "look.theme=blue", `place=${JSON.stringify(place)}`], ctx, sys);
  assert.equal(set.code, 0, JSON.stringify(set.json));
  assert.deepEqual(state.puts, [{ version: 3, values: { hour24: false, minutes: -5, title: "two words = here", place, look: { theme: "blue" } } }]);
  assert.deepEqual(set.json.changed, ["hour24", "minutes", "title", "look.theme", "place"]);
  assert.equal(set.json.values.hour24, false);
  assert.deepEqual([set.json.restarted, state.launched], [false, 0]);
  const said = await call(["settings", "set", "hour24=true"], ctx, sys, { json: false });
  assert.match(said.out, /An app reads its settings when it starts: start it again to see them \(\S+ settings set hour24=true --restart, or \S+ run\)\.$/);
});

test("settings set --restart stops the app, starts it again and says whether it runs", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  const { state, bar } = settingsBar(VALUES());
  const sys = fakeSystem(dir, { bar, log: () => (state.launched ? [{ kind: "app", text: `Launch ${ID} (heap 128 KiB)`, time: 9_000_000 }, { kind: "log", text: `${ID} log: hour24 false`, time: 9_000_001 }] : []) });
  const set = await call(["settings", "set", "hour24=false", "--restart"], ctx, sys);
  assert.equal(set.code, 0, JSON.stringify(set.json));
  assert.deepEqual([state.quit, state.launched], [1, 1]);
  assert.deepEqual([set.json.restarted, set.json.running], [true, true]);
  assert.deepEqual(set.json.log.map((line) => line.text), [`Launch ${ID} (heap 128 KiB)`, `${ID} log: hour24 false`]);
  assert.deepEqual(sys.sent.filter(([method]) => method === "POST").map(([, pathname]) => pathname), ["/api/apps/quit", `/api/apps/launch?app_id=${ID}`]);
});

test("settings set: what cannot be set is told with the settings there are; what the BUSY Bar refuses, with its reason", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  const { state, bar } = settingsBar(VALUES());
  const sys = fakeSystem(dir, { bar });
  for (const [pair, text] of [["nope=1", /the app has no setting "nope"; it has hour24, minutes, title, place, look\.theme/], ["hour24=yes", /it is a switch: true or false/], ["minutes=2.5", /it is a whole number/], ["look=blue", /"look" is a group: name a field of it, as in look\.theme=…/], ["place=Home", /it is an object: give JSON/]]) {
    const wrong = await call(["settings", "set", pair], ctx, sys);
    assert.equal(wrong.code, 2, pair);
    assert.match(wrong.json.message, text);
  }
  assert.deepEqual(state.puts, [], "nothing was sent");
  const refusing = settingsBar(VALUES(), { refuse: "Invalid value for look.theme" });
  const refused = await call(["settings", "set", "look.theme=pink"], ctx, fakeSystem(dir, { bar: refusing.bar, log: () => refusing.state.refused }));
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "settings_refused");
  assert.equal(refused.json.message, `The BUSY Bar refused the new settings of ${ID}: Invalid value for look.theme. Nothing was changed.`);
  assert.equal(refused.json.refused, "Invalid value for look.theme");
});

test("settings reset goes back to the defaults; wrong calls; an app without settings, not installed, with a refused file", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  const { bar } = settingsBar({ hour24: false, minutes: 1, title: "x", place: { mode: "auto", name: "Here" }, look: { theme: "blue" } });
  const reset = await call(["settings", "reset"], ctx, fakeSystem(dir, { bar }));
  assert.equal(reset.code, 0, JSON.stringify(reset.json));
  assert.deepEqual(reset.json.values, VALUES());
  for (const [words, text] of [[[], /settings needs an action: get, set or reset/], [["put"], /no action "put"/], [["set"], /settings set needs what to set/], [["get", "a=b"], /takes no key=value/], [["get", "--restart"], /nothing to restart/], [["get", "one", "two"], /takes one folder/], [["get", "--app", "bad id"], /--app takes an app's id/], [["get", "clock", "--app", ID], /a folder or --app <id>, not both/]]) {
    const wrong = await call(["settings", ...words], ctx, fakeSystem(root, { bar }));
    assert.equal(wrong.code, 2, words.join(" "));
    assert.match(wrong.json.message, text);
  }
  const answers = { no_settings: { status: 404, body: '{"error":"Application has no settings schema"}' }, not_installed: { status: 404, body: '{"error":"Not Found"}' }, settings_invalid: { status: 503, body: '{"error":"Application settings schema is invalid"}' } };
  for (const [code, answer] of Object.entries(answers)) {
    const failed = await call(["settings", "get"], ctx, fakeSystem(dir, { bar: () => answer }));
    assert.deepEqual([failed.code, failed.json.code], [1, code]);
  }
  assert.match((await call(["settings", "get"], ctx, fakeSystem(dir, { bar: () => answers.no_settings }))).json.hint, /src\/appmeta\/settings\.json of the project \(the format is in the project's AGENTS\.md\)/);
  assert.equal((await call(["settings", "get"], ctx, fakeSystem(dir, { running: false }))).json.code, "not_running");
  // Outside a project, with no app running and none named.
  assert.equal((await call(["settings", "get"], ctx, fakeSystem(root, { bar: () => ({ status: 200, body: '{"running":null}' }) }))).json.code, "no_app_named");
});

// ---------------------------------------------------------------- typecheck

test("typecheck runs the project's typecheck script with the bundled npm; type errors are typecheck_failed with the compiler's lines", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  const clean = fakeSystem(dir);
  const passed = await call(["typecheck"], ctx, clean);
  assert.equal(passed.code, 0, JSON.stringify(passed.json));
  assert.deepEqual(clean.tools.map((request) => [request.tool, request.args, request.cwd]), [["npm", ["run", "--silent", "--no-workspaces", "typecheck"], dir]]);
  assert.deepEqual(passed.json.errors, []);
  const output = "src/main.ts(14,3): error TS2304: Cannot find name 'devcie'.\nshared/settings.ts(2,1): error TS1005: ';' expected.\n";
  const failed = await call(["typecheck"], ctx, fakeSystem(dir, { tool: () => ({ code: 2, signal: null, output }) }));
  assert.deepEqual([failed.code, failed.json.code], [1, "typecheck_failed"]);
  assert.deepEqual(failed.json.errors, [{ file: "src/main.ts", line: 14, column: 3, code: "TS2304", message: "Cannot find name 'devcie'." }, { file: "shared/settings.ts", line: 2, column: 1, code: "TS1005", message: "';' expected." }]);
  assert.match(failed.json.message, /^2 type errors in app\.you\.clock:\nsrc\/main\.ts\(14,3\): error TS2304/);
  // The script failed some other way: the tool's failure, in its words.
  assert.equal((await call(["typecheck"], ctx, fakeSystem(dir, { tool: () => ({ code: 127, signal: null, output: "sh: tsc: command not found\n" }) }))).json.code, "tool_failed");
});

test("typecheck: a project without the script says so; an untrusted project is not checked", async (t) => {
  const { root, ctx } = setup(t);
  const plain = project(root, ctx, "plain", { scripts: { build: "busy-cli build" } });
  const none = await call(["typecheck"], ctx, fakeSystem(plain));
  assert.deepEqual([none.code, none.json.code], [1, "no_typecheck"]);
  const stranger = project(root, ctx, "stranger", { trusted: false });
  const sys = fakeSystem(stranger);
  assert.equal((await call(["typecheck"], ctx, sys)).json.code, "untrusted_project");
  assert.deepEqual(sys.tools, []);
});

// ---------------------------------------------------------------- trust

test("trust asks the running emulator with the server's key and takes the person's answer: yes, no, nobody there", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx, "stranger", { trusted: false });
  // Yes: the emulator wrote its list, and the command reads the folder as trusted from it.
  const yes = fakeSystem(root, { trust: (folder) => (trustProject(ctx.dataDir, folder, "trusted", { platform: "darwin" }), { status: 200, body: JSON.stringify({ trusted: true, answer: "trust", folder }) }) });
  const trusted = await call(["trust", "stranger"], ctx, yes);
  assert.equal(trusted.code, 0, JSON.stringify(trusted.json));
  assert.deepEqual(trusted.json, { ok: true, command: "trust", folder: dir, id: ID, asked: true, answer: "trust", trusted: "now" });
  assert.deepEqual(yes.sent, [["askTrust", 51234, KEY, dir, 120_000]]);
  // Asked again: trusted already, nobody is asked.
  const again = await call(["trust", "stranger"], ctx, yes);
  assert.deepEqual([again.json.trusted, again.json.asked, yes.sent.length], ["before", false, 1]);

  const other = project(root, ctx, "other", { trusted: false });
  const no = await call(["trust", "other", "--wait", "30"], ctx, fakeSystem(root, { trust: (folder) => ({ status: 200, body: JSON.stringify({ trusted: false, answer: "refuse", folder }) }) }));
  assert.deepEqual([no.code, no.json.code], [1, "trust_refused"]);
  assert.match(no.json.message, /^The person chose "Don't Trust" for .*other: it stays untrusted/);
  assert.match(no.json.hint, /^Do not ask again unless the person tells you to\./);
  assert.equal(isTrusted(ctx.dataDir, other), false);
  const silent = await call(["trust", "other", "--wait", "30"], ctx, fakeSystem(root, { trust: (folder) => ({ status: 200, body: JSON.stringify({ trusted: false, answer: "no_answer", folder }) }) }));
  assert.deepEqual([silent.code, silent.json.code], [1, "trust_no_answer"]);
  assert.match(silent.json.message, /within 30 s; the dialog was taken away/);
  assert.match(silent.json.hint, / trust other again/);
});

test("trust: an answer the emulator did not write to its list is not believed; what cannot be asked says how the person can trust instead", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx, "stranger", { trusted: false });
  // "trusted: true" from whatever answers at that port, with nothing in the list: not trusted.
  const forged = await call(["trust", "stranger"], ctx, fakeSystem(root, { trust: (folder) => ({ status: 200, body: JSON.stringify({ trusted: true, answer: "trust", folder }) }) }));
  assert.deepEqual([forged.code, forged.json.code], [1, "trust_unavailable"]);
  assert.equal(isTrusted(ctx.dataDir, dir), false);
  for (const answer of [{ status: 501, body: '{"error":"This emulator runs without its app, so it has no dialog to ask the person in."}' }, { status: 404, body: '{"error":"Not Found"}' }, { failed: "ECONNREFUSED" }, { status: 200, body: JSON.stringify({ trusted: false, answer: "unavailable", reason: "the emulator runs hidden and shows no dialog" }) }]) {
    const failed = await call(["trust", "stranger"], ctx, fakeSystem(root, { trust: () => answer }));
    assert.deepEqual([failed.code, failed.json.code], [1, "trust_unavailable"], JSON.stringify(answer));
    assert.match(failed.json.hint, /^Tell the person: a folder is trusted only in the emulator's dialog, which needs the emulator's app running with its window \(\S+ start\)\. Then run \S+ trust stranger again\.$/);
    assert.doesNotMatch(failed.json.hint, /--trust/);
  }
  // The person said no a moment ago: the emulator does not ask them again yet, and the caller is told not to either.
  const soon = await call(["trust", "stranger"], ctx, fakeSystem(root, { trust: (folder) => ({ status: 429, body: JSON.stringify({ error: "…", retry_after_s: 27, folder }) }) }));
  assert.deepEqual([soon.code, soon.json.code, soon.json.retry_after_s], [1, "trust_refused_recently", 27]);
  assert.match(soon.json.message, /chose "Don't Trust" for .*stranger a moment ago, so the emulator does not ask them again yet \(for another 27 s\)/);
  assert.match(soon.json.hint, /^Do not ask again unless the person tells you to\./);
  // A folder whose name cannot be shown to the person as it is: nobody is asked, and the answer says why.
  const hidden = await call(["trust", "stranger"], ctx, fakeSystem(root, { trust: () => ({ status: 400, body: JSON.stringify({ reason: "unshowable", error: "The folder's path cannot be shown to the person as it is: it holds an invisible format character (U+200B), which a person cannot see in the question. Rename the folder." }) }) }));
  assert.deepEqual([hidden.code, hidden.json.code, hidden.json.reason], [1, "trust_refused_path", "unshowable"]);
  assert.match(hidden.json.message, /an invisible format character \(U\+200B\).*stays untrusted, and nobody was asked\.$/);
  assert.match(hidden.json.hint, /^Rename the folder/);
  assert.equal((await call(["trust", "stranger"], ctx, fakeSystem(root, { trust: () => ({ status: 409, body: '{"error":"Another question to the person is open in the emulator (about /x). It takes one at a time."}' }) }))).json.code, "trust_busy");
  assert.equal((await call(["trust", "stranger"], ctx, fakeSystem(root, { trust: () => ({ blocked: "EPERM" }) }))).json.code, "blocked_network");
  const off = await call(["trust", "stranger"], ctx, fakeSystem(root, { running: false }));
  assert.deepEqual([off.code, off.json.code], [1, "not_running"]);
  assert.match(off.json.hint, / start, then run \S+ trust stranger again/);
  assert.equal((await call(["trust", "stranger", "--wait", "1"], ctx, fakeSystem(root))).json.code, "usage");
  assert.equal((await call(["trust", "no-such-folder"], ctx, fakeSystem(root))).json.code, "not_a_project");
});

test("trust takes no answer from its caller: it has no option or argument that gives one", () => {
  const trust = commands.find((command) => command.name === "trust");
  assert.deepEqual(Object.keys(trust.options), ["--wait"]);
  assert.equal(trust.maxArguments, 1);
});

// ---------------------------------------------------------------- publish, stage 2: asked of the emulator's app

test("publish signin, push, pr and signout ask the emulator's app through the server and say what it answered", async (t) => {
  const { root, ctx } = setup(t);
  const dir = project(root, ctx);
  // Checked and packaged as it is (stale-check): push and pr refuse a project that is not.
  await markChecked(dir);
  const asked = [];
  let signedIn = false;
  const answers = {
    status: () => ({ ok: true, configured: true, signedIn, login: signedIn ? "octo" : null }),
    signin: () => ({ ok: true, userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device", expiresAt: 0 }),
    "signin-wait": () => ((signedIn = true), { ok: true, login: "octo" }),
    signout: () => ((signedIn = false), { ok: true, signedIn: false, revokePage: "https://github.com/settings/applications" }),
    push: () => ({ ok: true, owner: "octo", name: "clock", page: "https://github.com/octo/clock", commit: "a".repeat(40), files: 7, uploaded: 7, created: true, unchanged: false }),
    request: (q) => (q.ai === "none" ? { ok: true, url: "https://github.com/busy-app/busy-apps-catalog/pull/7", number: 7, created: true, direct: false } : { ok: false, code: "not_author", message: "The person did not tick that they are the app's author.", hint: null }),
  };
  const sys = { ...fakeSystem(root), askGithub: async (port, key, query, waitMs) => (asked.push([query, waitMs]), { status: 200, body: JSON.stringify(answers[query.op](query)) }) };

  const signin = await call(["publish", "signin"], ctx, sys, { json: false });
  assert.equal(signin.code, 0, signin.err);
  assert.match(signin.err, /Open https:\/\/github\.com\/login\/device and enter the code WDJB-MJHT/);
  assert.match(signin.out, /Signed in to GitHub as octo\./);
  assert.deepEqual(asked.map(([q]) => q.op), ["status", "signin", "signin-wait"]);
  assert.equal(asked.at(-1)[1], 16 * 60_000, "the wait lasts as long as GitHub's code");
  assert.equal((await call(["publish", "signin"], ctx, sys)).json.before, true, "signed in already: no new code");

  const pushed = await call(["publish", "push", dir, "--name", "clock"], ctx, sys);
  assert.deepEqual([pushed.code, pushed.json.page, pushed.json.commit], [0, "https://github.com/octo/clock", "a".repeat(40)]);
  assert.deepEqual(asked.at(-1)[0], { op: "push", folder: dir, name: "clock" });

  assert.equal((await call(["publish", "pr", dir], ctx, sys)).json.code, "usage", "--ai is never chosen for the person");
  const pr = await call(["publish", "pr", dir, "--ai", "none", "--catalog", "some-owner/busy-apps-catalog-demo"], ctx, sys);
  assert.deepEqual([pr.code, pr.json.url], [0, "https://github.com/busy-app/busy-apps-catalog/pull/7"]);
  assert.deepEqual(asked.at(-1)[0], { op: "request", folder: dir, ai: "none", catalog: "some-owner/busy-apps-catalog-demo" });
  const refused = await call(["publish", "pr", dir, "--ai", "partly"], ctx, sys);
  assert.deepEqual([refused.code !== 0, refused.json.code], [true, "not_author"]);
  assert.equal("catalog" in asked.at(-1)[0], false, "without --catalog the app uses its default: the BUSY catalog (the project's status names it)");
  assert.equal((await call(["publish", "status", dir], ctx, sys)).json.catalog, "busy-app/busy-apps-catalog", "the default catalog is the public one");

  const out = await call(["publish", "signout"], ctx, sys, { json: false });
  assert.match(out.out, /https:\/\/github\.com\/settings\/applications/);

  // GitHub CLI on this computer signed in already: the command never chooses the account for the person.
  signedIn = false;
  answers.status = () => ({ ok: true, configured: true, signedIn, login: signedIn ? "octo" : null, existing: "octo-own" });
  answers["signin-existing"] = () => ((signedIn = true), { ok: true, login: "octo-own", origin: "existing" });
  answers["signin-wait"] = () => ((signedIn = true), { ok: true, login: "octo", origin: "app", previous: "octo-own" });
  const choose = await call(["publish", "signin"], ctx, sys);
  assert.deepEqual([choose.json.code, choose.json.existing], ["choose_account", "octo-own"]);
  assert.match(choose.json.hint, /--use-existing.*--new-account/);
  assert.equal((await call(["publish", "signin", "--use-existing", "--new-account"], ctx, sys)).json.code, "usage");
  const used = await call(["publish", "signin", "--use-existing"], ctx, sys, { json: false });
  assert.match(used.out, /Signed in to GitHub as octo-own, the account GitHub CLI on this computer is signed in as\./);
  assert.equal(asked.at(-1)[0].op, "signin-existing");
  signedIn = false;
  const another = await call(["publish", "signin", "--new-account"], ctx, sys, { json: false });
  assert.match(another.out, /GitHub CLI on this computer now uses octo too, instead of octo-own\./);

  // Without the app: the server answers 501, and the command says to start it.
  const alone = { ...sys, askGithub: async () => ({ status: 501, body: JSON.stringify({ error: "This emulator runs without its app, which is what publishes to GitHub." }) }) };
  const none = await call(["publish", "push", dir], ctx, alone);
  assert.equal(none.json.code, "github_unavailable");
});
