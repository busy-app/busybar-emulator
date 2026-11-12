// Every command's output and every error, against a stand-in for the system: no app, no process, no network.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadCommands, main, parseArguments } from "../busy-emulator.mjs";
import { ensureRunning } from "../lifecycle.mjs";
import { GENERATOR } from "../commands/create.mjs";
import { busyCliFacts, generatorFacts } from "../commands/version.mjs";
import { removeServerFilesOf, serverFilesOf } from "../system.mjs";

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const macCtx = {
  platform: "darwin",
  kind: "release",
  development: false,
  resourcesDir: "/Applications/BUSY Bar Emulator.app/Contents/Resources",
  appPath: "/Applications/BUSY Bar Emulator.app",
  version: "1.2.3",
  node: "24.22.2",
  dataDir: "/Users/you/Library/Application Support/BUSY Bar Emulator",
  pointerFile: "/Users/you/Library/Application Support/BUSY Bar Emulator/install.json",
  runStateFile: "/Users/you/Library/Application Support/BUSY Bar Emulator/run/emulator.json",
  calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"],
  testLaunch: null,
};
const winCtx = {
  ...macCtx,
  platform: "win32",
  appPath: "C:\\Program Files\\BUSY Bar Emulator\\BUSY Bar Emulator.exe",
  dataDir: "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator",
  runStateFile: "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator\\run\\emulator.json",
  calledAs: ["C:\\Program Files\\BUSY Bar Emulator\\resources\\bin\\busy-emulator.exe"],
};

const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };

/**
 * A stand-in for system.mjs. `states` is what run/emulator.json holds after each launch (the first before any); the
 * process lives until terminated.
 */
function fakeSystem({ states = [null], probe = { answering: true }, startTime = 999_500, exe = READY.exe, launchError = null, terminateError = null, diesOnTerminate = true } = {}) {
  let clock = 0;
  let launched = 0;
  const calls = [];
  let dead = false;
  const current = () => states[Math.min(launched, states.length - 1)];
  return {
    calls,
    readRunState() {
      const state = current();
      if (state === null) return { missing: true };
      if (state.blocked) return { blocked: state.blocked };
      return { state };
    },
    alive: () => !dead && current() !== null,
    probe: async (port) => (calls.push(["probe", port]), typeof probe === "function" ? probe() : probe),
    processInfo: (pid) => (calls.push(["processInfo", pid]), startTime === null ? null : { start: startTime, exe }),
    samePath: (a, b) => a === b,
    removeRunStateOf: (file, pid) => calls.push(["removeRunState", pid]),
    serverFilesOf: (dataDir) => (calls.push(["serverFilesOf", dataDir]), { lock: "the lock", key: "the key" }),
    removeServerFilesOf: async (dataDir, before) => (calls.push(["removeServerFilesOf", dataDir, before]), { lock: true, key: true }),
    async launchApp(ctx) {
      calls.push(["launch", ctx.testLaunch ?? ctx.appPath]);
      if (launchError) throw launchError;
      launched += 1;
    },
    terminate(pid) {
      calls.push(["terminate", pid]);
      if (terminateError) throw terminateError;
      if (diesOnTerminate) dead = true;
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
}

async function run(argv, { ctx = macCtx, sys = fakeSystem() } = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { ctx, sys, out: (line) => out.push(line), err: (line) => err.push(line) });
  const json = argv.includes("--json") && out.length ? JSON.parse(out.join("\n")) : null;
  return { code, out: out.join("\n"), err: err.join("\n"), json, sys };
}

// ---------------------------------------------------------------- the command line itself

test("--json and --help go anywhere; the first other word is the command", () => {
  const plain = { options: {}, optionProblems: [], progress: false };
  assert.deepEqual(parseArguments(["status", "--json"]), { name: "status", args: [], json: true, help: false, unknownOptions: [], ...plain });
  assert.deepEqual(parseArguments(["--json", "help", "start"]), { name: "help", args: ["start"], json: true, help: false, unknownOptions: [], ...plain });
  assert.deepEqual(parseArguments(["--version"]).name, "version");
  assert.deepEqual(parseArguments(["start", "-x", "--no-window"]).unknownOptions, ["-x", "--no-window"]);
  assert.deepEqual(parseArguments(["-"]).name, "-");
});

test("no command: the help, and the exit code of a wrong call", async () => {
  const { code, out } = await run([]);
  assert.equal(code, 2);
  assert.match(out, /^busy-emulator: the command line of BUSY Bar Emulator\./);
  assert.match(out, /Commands:/);
});

test("an unknown command is a wrong call, and its name comes back as it was given", async () => {
  const strange = `a&b %PATH% ^c "d" 'e' Γειά フォルダ`;
  const { code, json } = await run([strange, "--json"]);
  assert.equal(code, 2);
  assert.equal(json.ok, false);
  assert.equal(json.code, "unknown_command");
  assert.equal(json.argument, strange);
  assert.match(json.hint, /help/);
});

test("arguments a command does not take are a wrong call, and come back as given", async () => {
  const { code, json } = await run(["version", "x y", "100%", "--json"]);
  assert.equal(code, 2);
  assert.equal(json.code, "usage");
  assert.deepEqual(json.arguments, ["x y", "100%"]);
});

test("an option a command does not have is a wrong call", async () => {
  const { code, json, err } = await run(["start", "--no-window", "--json"]);
  assert.equal(code, 2);
  assert.equal(json.code, "usage");
  assert.deepEqual(json.arguments, ["--no-window"]);
  const human = await run(["start", "--no-window"]);
  assert.equal(human.code, 2);
  assert.match(human.err, /^busy-emulator: start has no option --no-window\./);
  assert.equal(err, "");
});

test("help lists every command, says how to call one, and refuses one that does not exist", async () => {
  const all = await run(["help", "--json"]);
  assert.equal(all.code, 0);
  assert.deepEqual(all.json.commands.map((command) => command.name), ["allow-local", "build", "catalog-texts", "check", "create", "dev", "help", "icon", "install", "logs", "mcp", "press", "projects", "publish", "quit", "record", "restart-bar", "run", "screenshot", "settings", "start", "status", "stop", "submit", "time", "trust", "typecheck", "uninstall", "update", "version"]);
  const one = await run(["help", "status"]);
  assert.equal(one.code, 0);
  assert.match(one.out, /\/Users\/you\/\.busy-emulator\/bin\/busy-emulator status \[--json\]/);
  const asked = await run(["status", "--help"]);
  assert.equal(asked.out, one.out);
  assert.equal((await run(["help", "nothing", "--json"])).json.code, "unknown_command");
});

test("version: the emulator's version, its Node, and this command's own path ready to paste", async () => {
  const mac = await run(["version", "--json"]);
  assert.equal(mac.code, 0);
  const { firmware, create_app: createApp, busy_cli: busyCli, ...rest } = mac.json;
  assert.deepEqual(rest, {
    ok: true,
    command: "version",
    version: "1.2.3",
    kind: "release",
    node: "24.22.2",
    app: "/Applications/BUSY Bar Emulator.app",
    update_available: null,
    cli: { path: "/Users/you/.busy-emulator/bin/busy-emulator", argv: ["/Users/you/.busy-emulator/bin/busy-emulator"], sh: "/Users/you/.busy-emulator/bin/busy-emulator" },
  });
  assert.match((await run(["version"])).out, /^busy-emulator 1\.2\.3, Node 24\.22\.2\n/);
  assert.match((await run(["version"])).out, /\nThis command: \/Users\/you\/\.busy-emulator\/bin\/busy-emulator$/);
  // What the emulator is made of: the firmware's commit and API, the template's generator and its range.
  assert.match(firmware.commit, /^[0-9a-f]{40}$/);
  assert.match(firmware.api, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(createApp, { package: "@busy-app/create-app", range: GENERATOR.range, installed: null });
  assert.equal(busyCli, null, "the test runs in a folder that is no project");
  const spaced = await run(["version"], { ctx: { ...macCtx, calledAs: ["/Applications/O'Brien Tools/BUSY Bar Emulator.app/Contents/Resources/bin/busy-emulator"] } });
  assert.match(spaced.out, /This command: '\/Applications\/O'\\''Brien Tools\/BUSY Bar Emulator\.app\/Contents\/Resources\/bin\/busy-emulator'$/);
  const win = await run(["version"], { ctx: winCtx });
  assert.match(win.out, /in PowerShell: & 'C:\\Program Files\\BUSY Bar Emulator\\resources\\bin\\busy-emulator\.exe'\nIn Git Bash: 'C:\/Program Files\/BUSY Bar Emulator\/resources\/bin\/busy-emulator\.exe'\nIn cmd: "C:\\Program Files\\BUSY Bar Emulator\\resources\\bin\\busy-emulator\.exe"$/);
  // The launcher at its fixed path, with no space in it: one form for PowerShell, Git Bash and cmd, the one hints use too.
  const fixed = await run(["version"], { ctx: { ...winCtx, calledAs: ["C:\\Users\\Тест\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe"] } });
  assert.match(fixed.out, /\nThis command, in PowerShell, Git Bash and cmd: C:\/Users\/Тест\/AppData\/Local\/busy-emulator\/bin\/busy-emulator\.exe$/);
  assert.match((await run(["version"], { ctx: { ...macCtx, kind: "test" } })).out, /^busy-emulator 1\.2\.3 \(test\), Node/);
});

test("adding a command is adding one file to commands/", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "busy-cli-"));
  try {
    // Laid out as the app holds it: the command line, the project tools its commands use, programs.mjs, and what
    // allow-local takes from the server (where its lock and key are, what a port is).
    const cli = path.join(folder, "server", "cli");
    cpSync(CLI_DIR, cli, { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
    cpSync(path.join(CLI_DIR, "..", "projects"), path.join(folder, "server", "projects"), { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
    // The catalog's checks, which the app holds too (stage-resources.mjs): create takes the rule for an app's id there.
    cpSync(path.join(CLI_DIR, "..", "readiness"), path.join(folder, "server", "readiness"), { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
    // The publish flow's rule of where it writes (files.mjs), which catalog-texts writes by.
    cpSync(path.join(CLI_DIR, "..", "publish"), path.join(folder, "server", "publish"), { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
    cpSync(path.join(CLI_DIR, "..", "..", "engine", "programs.mjs"), path.join(folder, "engine", "programs.mjs"));
    for (const module of ["data-folder.mjs", "json-store.mjs", "local-access.mjs", "old-files.mjs", "path-boundary.mjs", "process-info.mjs", "same-path.mjs", "server-key.mjs", "tar.mjs", "capture/clip-limits.mjs"]) cpSync(path.join(CLI_DIR, "..", module), path.join(folder, "server", module));
    writeFileSync(
      path.join(cli, "commands", "hello.mjs"),
      `export default { name: "hello", summary: "Say hello", usage: "hello <name>", maxArguments: 1, async run(_ctx, _sys, { args }) { return { data: { hello: args[0] }, text: "Hello, " + args[0] }; } };\n`,
    );
    const commands = await loadCommands(path.join(cli, "commands"));
    const out = [];
    const code = await main(["hello", "bar", "--json"], { ctx: macCtx, sys: fakeSystem(), commands, out: (line) => out.push(line), err: () => {} });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out[0]), { ok: true, command: "hello", hello: "bar" });
    const help = [];
    await main(["help"], { ctx: macCtx, sys: fakeSystem(), commands, out: (line) => help.push(line), err: () => {} });
    assert.match(help.join("\n"), /hello <name> +Say hello/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a failure the command line did not foresee is still one line of JSON with a code", async () => {
  const sys = { ...fakeSystem(), readRunState: () => { throw new Error("boom"); } };
  const { code, json } = await run(["status", "--json"], { sys });
  assert.equal(code, 1);
  assert.equal(json.code, "internal");
});

// ---------------------------------------------------------------- status

test("status: not running is an answer, not a failure", async () => {
  const { code, json, out } = await run(["status", "--json"]);
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, command: "status", running: false, version: "1.2.3", app: "/Applications/BUSY Bar Emulator.app", update_available: null });
  assert.equal((await run(["status"])).out, "The emulator is not running.");
  assert.equal(out.split("\n").length, 1, "one line");
});

test("status: running and answering", async () => {
  const { code, json, out } = await run(["status", "--json"], { sys: fakeSystem({ states: [READY] }) });
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, command: "status", running: true, version: "1.2.3", app: macCtx.appPath, state: "ready", answering: true, url: "http://127.0.0.1:8640", port: 8640, pid: 4242, detail: null, update_available: null });
  assert.equal(out.split("\n").length, 1);
  assert.equal((await run(["status"], { sys: fakeSystem({ states: [READY] }) })).out, "The emulator is running: the BUSY Bar answers at http://127.0.0.1:8640 (process 4242).");
});

test("status: running, but the BUSY Bar is not", async () => {
  assert.match((await run(["status"], { sys: fakeSystem({ states: [{ ...READY, state: "starting" }] }) })).out, /is starting/);
  assert.match((await run(["status"], { sys: fakeSystem({ states: [READY], probe: { answering: false, code: "ECONNREFUSED" } }) })).out, /does not answer at http:\/\/127\.0\.0\.1:8640/);
  const busy = await run(["status", "--json"], { sys: fakeSystem({ states: [{ ...READY, state: "port-busy" }] }) });
  assert.equal(busy.code, 0);
  assert.equal(busy.json.state, "port-busy");
});

test("status: a mirror left by an emulator that died is not a running emulator", async () => {
  const sys = fakeSystem({ states: [READY] });
  sys.alive = () => false;
  assert.equal((await run(["status", "--json"], { sys })).json.running, false);
});

test("status: a sandbox that forbids loopback is named, with what to do (blocked_network)", async () => {
  const { code, json } = await run(["status", "--json"], { sys: fakeSystem({ states: [READY], probe: { blocked: "EPERM" } }) });
  assert.equal(code, 1);
  assert.equal(json.code, "blocked_network");
  assert.match(json.message, /127\.0\.0\.1:8640 \(EPERM\): a sandbox is in the way/);
  assert.match(json.hint, /outside the sandbox/);
});

test("status: a sandbox that forbids reading the data folder is named (blocked_file)", async () => {
  const { code, json, err } = await run(["status", "--json"], { sys: fakeSystem({ states: [{ blocked: "EACCES" }] }) });
  assert.equal(code, 1);
  assert.equal(json.code, "blocked_file");
  assert.match(json.message, /run\/emulator\.json \(EACCES\)/);
  assert.equal(err, "");
  const human = await run(["status"], { sys: fakeSystem({ states: [{ blocked: "EACCES" }] }) });
  assert.match(human.err, /^busy-emulator: This process may not read .*\nRun the same busy-emulator command again outside the sandbox\.$/);
  assert.equal(human.out, "");
});

// ---------------------------------------------------------------- start

test("start: launches this copy of the app and waits until its BUSY Bar answers", async () => {
  const sys = fakeSystem({ states: [null, READY] });
  // After the launch: two reads while it starts, then ready; its bar answers from the second probe on.
  const read = sys.readRunState;
  let reads = 0;
  sys.readRunState = () => {
    const result = read();
    if (result.state && ++reads <= 2) return { state: { ...READY, state: "starting" } };
    return result;
  };
  let probes = 0;
  sys.probe = async () => ({ answering: ++probes > 1 });
  const { code, json, out } = await run(["start", "--json"], { sys });
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, command: "start", already_running: false, url: "http://127.0.0.1:8640", port: 8640, pid: 4242, version: "1.2.3" });
  assert.deepEqual(sys.calls.filter(([what]) => what === "launch"), [["launch", "/Applications/BUSY Bar Emulator.app"]]);
  assert.equal(out.split("\n").length, 1);
});

test("start: a running emulator is launched again, which brings its window to the front", async () => {
  const sys = fakeSystem({ states: [READY] });
  const { code, json, out } = await run(["start", "--json"], { sys });
  assert.equal(code, 0);
  assert.equal(json.already_running, true);
  assert.equal(sys.calls.filter(([what]) => what === "launch").length, 1);
  assert.match(out, /"already_running":true/);
});

test("ensureRunning: a running, ready emulator is left as it is unless the window is to come forward (start)", async () => {
  const sys = fakeSystem({ states: [READY] });
  assert.equal((await ensureRunning(macCtx, sys)).alreadyRunning, true);
  assert.deepEqual(sys.calls.filter(([what]) => what === "launch"), [], "no launch: the window stays where it is");
  await ensureRunning(macCtx, sys, { bringForward: true });
  assert.equal(sys.calls.filter(([what]) => what === "launch").length, 1);
  // One that is not running is still started, window or not.
  const stopped = fakeSystem({ states: [null, READY] });
  assert.equal((await ensureRunning(macCtx, stopped)).alreadyRunning, false);
  assert.equal(stopped.calls.filter(([what]) => what === "launch").length, 1);
});

test("start: the server's trouble comes back with its own code", async () => {
  const cases = [
    ["port-busy", "port_busy", /Port 8640 is in use/],
    ["failed", "server_failed", /did not start \(boom\)/],
    ["gave-up", "server_failed", /did not start/],
    ["move-app", "move_app", /cannot work from where it is/],
  ];
  for (const [state, code, message] of cases) {
    const fresh = await run(["start", "--json"], { sys: fakeSystem({ states: [null, { ...READY, state, detail: "boom" }] }) });
    assert.equal(fresh.code, 1, state);
    assert.equal(fresh.json.code, code, state);
    assert.match(fresh.json.message, message, state);
    // The same when the emulator was already in that state: its window comes forward, the trouble is named.
    const before = await run(["start", "--json"], { sys: fakeSystem({ states: [{ ...READY, state, detail: "boom" }] }) });
    assert.equal(before.json.code, code, `${state}, already running`);
  }
});

test("start: an emulator that never becomes ready is given up on, and the log is named", async () => {
  const sys = fakeSystem({ states: [null, { ...READY, state: "starting" }] });
  const { code, json } = await run(["start", "--json"], { sys });
  assert.equal(code, 1);
  assert.equal(json.code, "start_timeout");
  assert.match(json.message, /within 60 s/);
  assert.match(json.hint, /logs\/shell\.log/);
});

test("start: the system's refusal to start the app is a failure with its words", async () => {
  const { code, json } = await run(["start", "--json"], { sys: fakeSystem({ launchError: new Error("LSOpenURLsWithRole() failed with error -10810") }) });
  assert.equal(code, 1);
  assert.equal(json.code, "start_failed");
  assert.match(json.message, /-10810/);
});

test("start: from the source folder there is no app to start", async () => {
  const ctx = { ...macCtx, kind: "development", appPath: null };
  const { code, json } = await run(["start", "--json"], { ctx });
  assert.equal(code, 1);
  assert.equal(json.code, "no_app");
  assert.equal((await run(["start", "--json"], { ctx, sys: fakeSystem({ states: [READY] }) })).json.already_running, true);
});

test("start: in a sandbox that forbids loopback, start names the sandbox before launching anything", async () => {
  const sys = fakeSystem({ states: [READY], probe: { blocked: "EPERM" } });
  const { json } = await run(["start", "--json"], { sys });
  assert.equal(json.code, "blocked_network");
  assert.equal(sys.calls.filter(([what]) => what === "launch").length, 0);
});

// ---------------------------------------------------------------- quit

test("quit: ends the emulator and waits until its process is gone", async () => {
  const sys = fakeSystem({ states: [READY] });
  const { code, json } = await run(["quit", "--json"], { sys });
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, command: "quit", was_running: true });
  assert.deepEqual(sys.calls.filter(([what]) => what === "terminate"), [["terminate", 4242]]);
});

test("quit: an emulator that is not running is not an error", async () => {
  const sys = fakeSystem();
  const { code, json } = await run(["quit", "--json"], { sys });
  assert.equal(code, 0);
  assert.equal(json.was_running, false);
  assert.equal(sys.calls.length, 0);
});

test("quit: a process number taken over by another program after the emulator died is left alone", async () => {
  // The process started 5 s after the emulator wrote its state: it is not the emulator.
  const sys = fakeSystem({ states: [READY], startTime: READY.started + 5000 });
  const { code, json } = await run(["quit", "--json"], { sys });
  assert.equal(code, 0);
  assert.equal(json.was_running, false);
  assert.equal(sys.calls.filter(([what]) => what === "terminate").length, 0);
});

test("quit: when the system will not say when the process started, nothing is ended", async () => {
  const sys = fakeSystem({ states: [READY], startTime: null });
  const { code, json } = await run(["quit", "--json"], { sys });
  assert.equal((await run(["status", "--json"], { sys: fakeSystem({ states: [READY], startTime: null }) })).json.running, false, "status believes no mirror it cannot check");
  assert.equal(code, 1);
  assert.equal(json.code, "quit_failed");
  assert.equal(sys.calls.filter(([what]) => what === "terminate").length, 0);
});

test("quit: a refusal to end the process and an emulator that does not end are failures", async () => {
  const refused = await run(["quit", "--json"], { sys: fakeSystem({ states: [READY], terminateError: Object.assign(new Error("not permitted"), { code: "EPERM" }) }) });
  assert.equal(refused.json.code, "quit_failed");
  assert.match(refused.json.hint, /outside the sandbox/);
  const stuck = await run(["quit", "--json"], { sys: fakeSystem({ states: [READY], diesOnTerminate: false }) });
  assert.equal(stuck.code, 1);
  assert.equal(stuck.json.code, "quit_timeout");
});

// ---------------------------------------------------------------- the mirror is data (review H1, security S1)

test("quit: a forged mirror — a process of another program, a start far in the future — ends nothing", async () => {
  const forged = { ...READY, pid: 777, started: 9_999_999_999_999 };
  for (const sys of [fakeSystem({ states: [forged] }), fakeSystem({ states: [READY], exe: "/usr/bin/perl" })]) {
    const { code, json } = await run(["quit", "--json"], { sys });
    assert.equal(code, 0);
    assert.equal(json.was_running, false);
    assert.equal(sys.calls.filter(([what]) => what === "terminate").length, 0);
  }
});

test("a mirror that names process 0 or 1, or no start, is nobody's", async () => {
  for (const state of [{ ...READY, pid: 1 }, { ...READY, pid: 0 }, { ...READY, started: undefined }]) {
    const sys = fakeSystem({ states: [state] });
    assert.equal((await run(["status", "--json"], { sys })).json.running, false, JSON.stringify(state));
    assert.equal((await run(["quit", "--json"], { sys })).json.was_running, false);
    assert.equal(sys.calls.filter(([what]) => what === "terminate").length, 0);
  }
});

test("status: a stale mirror whose number another program took is not a running emulator, whatever answers the port", async () => {
  const later = fakeSystem({ states: [READY], startTime: READY.started + 3_600_000 });
  assert.equal((await run(["status", "--json"], { sys: later })).json.running, false);
  const other = fakeSystem({ states: [READY], exe: "/usr/bin/python3" });
  assert.equal((await run(["status", "--json"], { sys: other })).json.running, false);
  // The start the app writes comes a moment after its process began; that is ours.
  assert.equal((await run(["status", "--json"], { sys: fakeSystem({ states: [READY], startTime: READY.started - 20_000 }) })).json.running, true);
});

test("a release believes only a process of its own app; the test variant the executable its mirror names", async () => {
  const theirs = { ...READY, exe: "/tmp/Other.app/Contents/MacOS/Other" };
  // A release: the process runs this copy's executable, whatever the mirror claims.
  assert.equal((await run(["status", "--json"], { sys: fakeSystem({ states: [theirs], exe: READY.exe }) })).json.running, true);
  assert.equal((await run(["status", "--json"], { sys: fakeSystem({ states: [READY], exe: theirs.exe }) })).json.running, false);
  const test = { ...macCtx, kind: "test" };
  assert.equal((await run(["status", "--json"], { ctx: test, sys: fakeSystem({ states: [theirs], exe: theirs.exe }) })).json.running, true);
  assert.equal((await run(["status", "--json"], { ctx: test, sys: fakeSystem({ states: [theirs], exe: READY.exe }) })).json.running, false);
});

test("start: a stale mirror that said failed does not stop start from waiting for the app it launched", async () => {
  const stale = { ...READY, state: "failed", detail: "exit code 1", started: READY.started - 3_600_000 };
  const sys = fakeSystem({ states: [stale, READY] });
  const { code, json } = await run(["start", "--json"], { sys });
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.already_running, false);
});

test("quit: the mirror of the process it ended goes (on Windows the app cannot remove it)", async () => {
  const sys = fakeSystem({ states: [READY] });
  await run(["quit", "--json"], { sys });
  assert.deepEqual(sys.calls.filter(([what]) => what === "removeRunState"), [["removeRunState", 4242]]);
});

test("quit: the lock and the key of the server that went with the app go too, as read before the app was ended", async () => {
  const sys = fakeSystem({ states: [READY] });
  await run(["quit", "--json"], { sys });
  const order = sys.calls.map(([what]) => what).filter((what) => ["serverFilesOf", "terminate", "removeServerFilesOf"].includes(what));
  assert.deepEqual(order, ["serverFilesOf", "terminate", "removeServerFilesOf"]);
  assert.deepEqual(sys.calls.find(([what]) => what === "removeServerFilesOf"), ["removeServerFilesOf", macCtx.dataDir, { lock: "the lock", key: "the key" }]);

  // An emulator that was not running, or did not end: nothing of a server's is removed.
  for (const other of [fakeSystem(), fakeSystem({ states: [READY], diesOnTerminate: false })]) {
    await run(["quit", "--json"], { sys: other });
    assert.equal(other.calls.some(([what]) => what === "removeServerFilesOf"), false);
  }
});

test("the files a server leaves when it is ended without its clean-up: removed once its process is gone, and only its own", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "busy-emulator-quit-"));
  try {
    const lockFile = path.join(dataDir, "run", "server.lock");
    const key = "k".repeat(43);
    const write = (pid, theKey = key) => {
      mkdirSync(path.dirname(lockFile), { recursive: true });
      writeFileSync(lockFile, JSON.stringify({ pid, nonce: "n" }));
      writeFileSync(path.join(dataDir, "key"), `${theKey}\n`);
    };
    let clock = 0;
    const time = { now: () => clock, sleep: async (ms) => void (clock += ms) };

    // The server went with the app: both files go.
    write(4243);
    let before = serverFilesOf(dataDir);
    assert.deepEqual(before, { lock: JSON.stringify({ pid: 4243, nonce: "n" }), key });
    let dies = 3;
    assert.deepEqual(await removeServerFilesOf(dataDir, before, { ...time, isAlive: () => dies-- > 0 }), { lock: true, key: true });
    assert.deepEqual([existsSync(lockFile), existsSync(path.join(dataDir, "key"))], [false, false]);

    // A server that keeps running (not the app's own) keeps its files.
    write(4243);
    before = serverFilesOf(dataDir);
    assert.deepEqual(await removeServerFilesOf(dataDir, before, { ...time, isAlive: () => true }), { lock: false, key: false });
    assert.deepEqual([existsSync(lockFile), existsSync(path.join(dataDir, "key"))], [true, true]);

    // Another server took the folder meanwhile: its lock and its key are other texts, and stay.
    before = serverFilesOf(dataDir);
    write(5000, "n".repeat(43));
    assert.deepEqual(await removeServerFilesOf(dataDir, before, { ...time, isAlive: () => false }), { lock: false, key: false });
    assert.equal(readFileSync(path.join(dataDir, "key"), "utf8").trim(), "n".repeat(43));

    // No lock, or one that names no process: nothing is touched.
    rmSync(lockFile);
    assert.deepEqual(await removeServerFilesOf(dataDir, serverFilesOf(dataDir), { ...time, isAlive: () => false }), { lock: false, key: false });
    assert.ok(existsSync(path.join(dataDir, "key")));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the sandbox before the launch (review H3)

test("start, nothing running, inside a sandbox: blocked_network before anything is launched", async () => {
  const sys = fakeSystem({ probe: { blocked: "EPERM" }, launchError: new Error("LSOpenURLsWithRole() failed with error -10810 for the file /Applications/BUSY Bar Emulator.app.") });
  const { code, json } = await run(["start", "--json"], { sys });
  assert.equal(code, 1);
  assert.equal(json.code, "blocked_network");
  assert.match(json.hint, /outside the sandbox/);
  assert.equal(sys.calls.filter(([what]) => what === "launch").length, 0);
  // With no mirror the bar's own port is the one asked.
  assert.deepEqual(sys.calls.find(([what]) => what === "probe"), ["probe", 8640]);
  assert.deepEqual((await run(["status", "--json"], { sys: fakeSystem({ probe: { blocked: "EPERM" } }) })).json.code, "blocked_network");
});

test("start: the system's words end the message with one full stop", async () => {
  const { json } = await run(["start", "--json"], { sys: fakeSystem({ launchError: new Error("It failed.") }) });
  assert.match(json.message, /It failed\.$/);
});

// ---------------------------------------------------------------- quit racing a start that is under way (the rehearsal)

const STARTER = 777; // the process of the `start` command that waits
const T0 = 1_700_000_000_000;

/**
 * A stand-in with a clock and things that happen at their times: `events` is a list of [ms after T0, (world) => …].
 * The world holds the app's mirror, the start mark and the processes that are alive.
 */
function world({ events = [], pid = STARTER } = {}) {
  const w = { clock: T0, mirror: null, mark: null, alive: new Set(), calls: [] };
  const due = events.map(([after, happen]) => ({ at: T0 + after, happen, done: false }));
  const tick = () => {
    for (const event of due) {
      if (event.done || event.at > w.clock) continue;
      event.done = true;
      event.happen(w);
    }
  };
  w.sys = {
    readRunState: () => (tick(), w.mirror ? { state: w.mirror } : { missing: true }),
    alive: (one) => (tick(), w.alive.has(one)),
    probe: async () => (tick(), w.mirror?.state === "ready" && w.alive.has(w.mirror.pid) ? { answering: true } : { answering: false, code: "ECONNREFUSED" }),
    processInfo: () => (w.mirror ? { start: w.mirror.started - 500, exe: READY.exe } : null),
    samePath: (a, b) => a === b,
    removeRunStateOf: (_file, one) => void (w.mirror?.pid === one && (w.mirror = null)),
    writeStartMark: (file, mark) => (w.calls.push(["mark", file, mark]), (w.mark = mark), true),
    readStartMark: () => (tick(), w.mark),
    removeStartMark: (_file, one) => void (w.mark?.pid === one && (w.calls.push(["unmark", one]), (w.mark = null))),
    quitStartMark: () => (w.calls.push(["quit-mark"]), (w.mark = w.mark && { ...w.mark, quit: true })),
    writeQuitNote: (file, note) => (w.calls.push(["quit-note", file, note]), (w.quitNote = note), true),
    readQuitNote: () => (tick(), w.quitNote ?? null),
    startedAt: () => T0 - 40, // Node took 40 ms to start before the command's first line
    pid: () => pid,
    launchApp: async () => void w.calls.push(["launch"]),
    terminate: (one) => (w.calls.push(["terminate", one]), w.alive.delete(one), (w.mirror = null)),
    now: () => w.clock,
    sleep: async (ms) => void ((w.clock += ms), tick()),
  };
  return w;
}
const appComesUp = (state = "starting") => (w) => (w.alive.add(READY.pid), (w.mirror = { ...READY, state, started: w.clock }));
const appEnds = (w) => (w.alive.delete(READY.pid), (w.mirror = null));
const MARK_FILE = "/Users/you/Library/Application Support/BUSY Bar Emulator/run/starting.json";

test("start: an app that ends while it is starting is start_interrupted at once, not a wait of 60 s", async () => {
  // The app writes its mirror ("starting") 300 ms after the launch and is quit 400 ms later.
  const w = world({ events: [[300, appComesUp()], [700, appEnds]] });
  const { code, json } = await run(["start", "--json"], { sys: w.sys });
  assert.equal(code, 1);
  assert.equal(json.code, "start_interrupted");
  assert.equal(json.pid, READY.pid);
  assert.match(json.message, /^The emulator \(process 4242\) ended before its BUSY Bar was ready: it was quit while it was starting/);
  assert.match(json.hint, /^Run start again/);
  assert.ok(w.clock - T0 < 2000, `it waited ${w.clock - T0} ms`);
  // Its mark was there while it waited, and is gone.
  assert.deepEqual(w.calls.filter((call) => call[0] !== "launch"), [["mark", MARK_FILE, { pid: STARTER, at: T0 }], ["unmark", STARTER]]);
  assert.equal(w.mark, null);
});

test("start: a quit that ended the app between two looks (its mirror never seen) says so in the mark, and the start ends at once", async () => {
  const w = world({ events: [[400, (world) => (world.mark = { ...world.mark, quit: true })]] });
  const { code, json } = await run(["start", "--json"], { sys: w.sys });
  assert.equal(code, 1);
  assert.equal(json.code, "start_interrupted");
  assert.equal(json.pid, null);
  assert.ok(w.clock - T0 < 2000, `it waited ${w.clock - T0} ms`);
  assert.equal(w.mark, null, "the start removes its mark itself");
  // Another start's mark in its place, or a mark that is gone (another start ended and removed its own), is not a
  // quit: the wait goes on to its end.
  const other = world({ events: [[400, (world) => (world.mark = { pid: 999, at: world.clock, quit: true })]] });
  assert.equal((await run(["start", "--json"], { sys: other.sys })).json.code, "start_timeout");
  const gone = world({ events: [[400, (world) => (world.mark = null)]] });
  assert.equal((await run(["start", "--json"], { sys: gone.sys })).json.code, "start_timeout");
});

test("start: the mark is removed after a start that succeeded, too; where it cannot be written the start goes on", async () => {
  const w = world({ events: [[300, appComesUp("starting")], [900, (world) => (world.mirror = { ...world.mirror, state: "ready" })]] });
  const started = await run(["start", "--json"], { sys: w.sys });
  assert.equal(started.code, 0, JSON.stringify(started.json));
  assert.equal(w.mark, null);
  const sandboxed = world({ events: [[300, appComesUp("ready")]] });
  sandboxed.sys.writeStartMark = () => false;
  sandboxed.sys.readStartMark = () => null;
  assert.equal((await run(["start", "--json"], { sys: sandboxed.sys })).code, 0);
});

test("quit while a start is under way and the app has no mirror yet: it waits for the app, ends it, and tells the start", async () => {
  // Another process (the start) left its mark 100 ms ago and is alive; the app names itself 500 ms from now.
  const w = world({ pid: 888, events: [[500, appComesUp()]] });
  w.mark = { pid: STARTER, at: T0 - 100 };
  w.alive.add(STARTER);
  const { code, json } = await run(["quit", "--json"], { sys: w.sys });
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, command: "quit", was_running: true, during_start: true });
  assert.deepEqual(w.calls, [["terminate", READY.pid], ["quit-mark"]]);
  assert.deepEqual(w.mark, { pid: STARTER, at: T0 - 100, quit: true }, "the start learns of it from its mark");
  // A mark that says quit is no start under way any more: a second quit does not wait for it.
  const again = await run(["quit", "--json"], { sys: w.sys });
  assert.equal(again.json.was_running, false);
  assert.ok(w.clock - T0 >= 500 && w.clock - T0 < 1500, `it waited ${w.clock - T0} ms`);
  const person = world({ pid: 888, events: [[500, appComesUp()]] });
  person.mark = { pid: STARTER, at: T0 - 100 };
  person.alive.add(STARTER);
  assert.match((await run(["quit"], { sys: person.sys })).out, /^The emulator \(process 4242\) was still starting; it has quit, and the start that was under way ends\.$/);
});

test("quit: a start under way that ends without an app, a mark left by a start that is gone, an old mark: not running, without a wait", async () => {
  // The start gives up after 2 s (its process ends); no app ever came.
  const gaveUp = world({ pid: 888, events: [[2000, (world) => world.alive.delete(STARTER)]] });
  gaveUp.mark = { pid: STARTER, at: T0 - 100 };
  gaveUp.alive.add(STARTER);
  assert.deepEqual((await run(["quit", "--json"], { sys: gaveUp.sys })).json, { ok: true, command: "quit", was_running: false });
  assert.ok(gaveUp.clock - T0 >= 2000 && gaveUp.clock - T0 < 3000);

  const dead = world({ pid: 888 });
  dead.mark = { pid: STARTER, at: T0 - 100 };
  assert.equal((await run(["quit", "--json"], { sys: dead.sys })).json.was_running, false);
  assert.equal(dead.clock, T0, "no wait for a start whose process is gone");

  // A number that some other program has now: the mark is older than any start lasts.
  const old = world({ pid: 888 });
  old.mark = { pid: STARTER, at: T0 - 10 * 60_000 };
  old.alive.add(STARTER);
  assert.equal((await run(["quit", "--json"], { sys: old.sys })).json.was_running, false);
  assert.equal(old.clock, T0);
});

test("quit that finds nothing leaves a note; a start that was already on its way ends its app when it sees it", async () => {
  const QUIT_NOTE = "/Users/you/Library/Application Support/BUSY Bar Emulator/run/quit-asked.json";
  const quit = world({ pid: 888 });
  assert.deepEqual((await run(["quit", "--json"], { sys: quit.sys })).json, { ok: true, command: "quit", was_running: false });
  assert.deepEqual(quit.calls, [["quit-note", QUIT_NOTE, { at: T0 }]]);

  // The start's process began 40 ms before T0; the quit ran 10 ms before T0, before the start had left its mark, and
  // found nothing. The app names itself 400 ms later: the start ends it, and nothing is left running.
  const w = world({ events: [[400, appComesUp()]] });
  w.quitNote = { at: T0 - 10 };
  const { code, json } = await run(["start", "--json"], { sys: w.sys });
  assert.equal(code, 1);
  assert.equal(json.code, "start_interrupted");
  assert.equal(json.message, "A quit command came while the emulator was starting, so this start ended it (process 4242): the emulator is not running.");
  assert.deepEqual(w.calls.filter((call) => call[0] === "terminate"), [["terminate", READY.pid]]);
  assert.equal(w.alive.has(READY.pid), false);
  assert.ok(w.clock - T0 < 2000, `it waited ${w.clock - T0} ms`);

  // An app that is ready at once is ended all the same: the quit came after this start began.
  const fast = world({ events: [[0, appComesUp("ready")]] });
  fast.quitNote = { at: T0 - 10 };
  assert.equal((await run(["start", "--json"], { sys: fast.sys })).json.code, "start_interrupted");
  assert.equal(fast.alive.has(READY.pid), false);

  // A quit from before this start began is not about it.
  const later = world({ events: [[300, appComesUp("ready")]] });
  later.quitNote = { at: T0 - 5000 };
  const started = await run(["start", "--json"], { sys: later.sys });
  assert.equal(started.code, 0, JSON.stringify(started.json));
  assert.equal(later.alive.has(READY.pid), true);
});

test("quit of a running emulator with no start under way says nothing of a start", async () => {
  const w = world({ pid: 888 });
  appComesUp("ready")(w);
  assert.deepEqual((await run(["quit", "--json"], { sys: w.sys })).json, { ok: true, command: "quit", was_running: true });
  assert.deepEqual(w.calls, [["terminate", READY.pid]]);
});

test('after a word "--" every word is an argument; before the command it is not one', () => {
  const optionsOf = () => ({ "--app": { key: "app", value: "<id>" } });
  const parsed = parseArguments(["settings", "set", "--app=a", "--", "--app=b", "--help", "-x", "--json"], optionsOf);
  assert.deepEqual([parsed.name, parsed.args, parsed.options, parsed.help, parsed.json, parsed.unknownOptions], ["settings", ["set", "--app=b", "--help", "-x"], { app: "a" }, false, true, []]);
  assert.deepEqual(parseArguments(["--", "status"]).unknownOptions, ["--"]);
});

test("version: the generator and the busy-cli it reports are the installed ones", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "busy-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(generatorFacts(root).installed, null);
  mkdirSync(path.join(root, "tools", "create-app", "node_modules", "@busy-app", "create-app"), { recursive: true });
  writeFileSync(path.join(root, "tools", "create-app", "node_modules", "@busy-app", "create-app", "package.json"), JSON.stringify({ version: "0.5.3" }));
  assert.deepEqual(generatorFacts(root), { package: "@busy-app/create-app", range: GENERATOR.range, installed: "0.5.3" });
  const project = path.join(root, "app");
  mkdirSync(path.join(project, "node_modules", "@busy-app", "cli"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  assert.deepEqual(busyCliFacts(project), { project, installed: null });
  writeFileSync(path.join(project, "node_modules", "@busy-app", "cli", "package.json"), JSON.stringify({ version: "0.6.1" }));
  assert.deepEqual(busyCliFacts(project), { project, installed: "0.6.1" });
  assert.equal(busyCliFacts(root), null);
});

test("status and version tell an agent that a newer version of the emulator is there: version and page, built here", async () => {
  const mirror = { ...READY, update: { version: "0.1.1", page: "https://evil.example/x" } };
  const status = await run(["status", "--json"], { sys: fakeSystem({ states: [mirror] }) });
  assert.deepEqual(status.json.update_available, { version: "0.1.1", url: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.1" });
  assert.match((await run(["status"], { sys: fakeSystem({ states: [mirror] }) })).out, /A newer version of the emulator is available: 0\.1\.1 \(https:\/\/github\.com\/busy-app\/busybar-emulator\/releases\/tag\/v0\.1\.1\)\./);
  const version = await run(["version", "--json"], { sys: fakeSystem({ states: [mirror] }) });
  assert.equal(version.json.update_available.version, "0.1.1");
  // Anything that is not a version in the mirror is no notice.
  for (const bad of ['0.1.1" onclick="x', "latest", 5, null]) {
    const odd = await run(["status", "--json"], { sys: fakeSystem({ states: [{ ...READY, update: { version: bad } }] }) });
    assert.equal(odd.json.update_available, null, String(bad));
  }
});
