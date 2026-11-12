// run and logs against a stand-in for the system (the release rehearsal's findings): run installs the built package
// first, so that run before install is no dead end; it then watches the bar's log for the app's first second and says
// whether the app runs, ran to its end or crashed, with the error's first line; logs shows the bar's log. No network,
// no process: test/server/run-logs.test.mjs runs the command line itself against a real server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runOutcome } from "../app-log.mjs";
import { BUILD_FEED_PARTS } from "../build-feed.mjs";
import { LOG_KINDS } from "../commands/logs.mjs";
import { loadCommands, main } from "../busy-emulator.mjs";
import { trustProject } from "../../projects/trust.mjs";

const commands = await loadCommands();
const ID = "app.test.edges";
const APP = "/Applications/BUSY Bar Emulator.app";
const READY = { pid: 4242, exe: `${APP}/Contents/MacOS/BUSY Bar Emulator`, started: 1_000_000, port: 8903, url: "http://127.0.0.1:8903", state: "ready", detail: null };

function setup(t, { built = true } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-run-logs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const ctx = {
    platform: "darwin",
    kind: "release",
    development: false,
    appPath: APP,
    dataDir,
    runStateFile: path.join(dataDir, "run", "emulator.json"),
    calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"],
    testLaunch: null,
    nodeTools: { node: "/x/node", npmCli: "/x/npm-cli.js", npxCli: "/x/npx-cli.js", nodeDir: "/x" },
    env: {},
  };
  // A project of the template's shape with busy-cli installed, trusted as create leaves it.
  const project = path.join(root, "my-app");
  const cli = path.join(project, "node_modules", "@busy-app", "cli");
  mkdirSync(path.join(cli, "dist"), { recursive: true });
  mkdirSync(path.join(project, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(project, "src", "appmeta", "manifest.json"), JSON.stringify({ id: ID }));
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(path.join(cli, "dist", "index.js"), "");
  if (built) {
    mkdirSync(path.join(project, "dist"));
    writeFileSync(path.join(project, "dist", `${ID}.tgz`), "package");
  }
  trustProject(dataDir, project, "created", { platform: "darwin" });
  return { root, ctx, project: realpathSync(project) };
}

/**
 * A stand-in for system.mjs with a running emulator. `log(n)` gives the bar's log lines at the n-th reading after the
 * launch; `onBar` says which apps the bar lists; `tools` answers busy-cli (by its app command: "install", "run").
 */
function fakeSystem(root, { log = () => [], onBar = [], tools = {}, emulator = READY } = {}) {
  let clock = 5_000_000;
  let readings = 0;
  const calls = [];
  return {
    calls,
    cwd: () => root,
    readRunState: () => (emulator ? { state: emulator } : { missing: true }),
    alive: () => Boolean(emulator),
    probe: async () => (emulator ? { answering: true } : { answering: false, code: "ECONNREFUSED" }),
    processInfo: () => ({ start: 999_500, exe: READY.exe }),
    samePath: (a, b) => a === b,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    async runTool(_setup, request) {
      const name = request.args[2];
      calls.push(["busy-cli", ...request.args.slice(1)]);
      return tools[name]?.() ?? { code: 0, signal: null, output: name === "run" ? `◆  Launched ${ID}\n` : `◆  Installed ${ID}\n` };
    },
    async barGet(port, pathname) {
      calls.push(["GET", port, pathname]);
      return { status: 200, body: JSON.stringify({ apps: onBar.map((id) => ({ id })) }) };
    },
    async barLog(port, options = {}) {
      calls.push(["log", port]);
      const lines = typeof log === "function" ? log(readings++, clock) : log;
      if (lines?.failed || lines?.blocked) return lines;
      if (options.follow) {
        options.onKept?.(lines.slice(0, -1));
        options.onLine?.(lines.at(-1));
      }
      return { lines };
    },
  };
}

async function call(argv, ctx, sys) {
  const out = [];
  const err = [];
  const code = await main(argv, { ctx, sys, commands, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err, json: argv.includes("--json") ? JSON.parse(out.at(-1)) : null };
}

const T = 5_000_000;
const launch = { kind: "app", text: `Launch ${ID} (heap 128 KiB)`, time: T + 10 };
const printed = { kind: "log", text: `${ID} log: hello from my app`, time: T + 20 };
const thrown = { kind: "error", text: `${ID} [JsRunner] Error running script: ReferenceError: draw is not defined`, time: T + 30 };
const exitedWithError = { kind: "app", text: `App ${ID} exited: error running main.js: Error running script: ReferenceError: draw is not defined; heap peak 2.7 of 128 KiB`, time: T + 40 };
const finished = { kind: "app", text: `App ${ID} exited: finished; heap peak 2.7 of 128 KiB`, time: T + 40 };
const other = { kind: "log", text: "app.other.one log: not mine", time: T + 25 };

// ---------------------------------------------------------------- run installs what build made

test("run before install: the built package is installed first, then the app is launched", async (t) => {
  const { root, ctx, project } = setup(t);
  const sys = fakeSystem(root, { log: () => [launch, printed] });
  const ran = await call(["run", "my-app", "--json"], ctx, sys);
  assert.equal(ran.code, 0, JSON.stringify(ran.json));
  const tools = sys.calls.filter((one) => one[0] === "busy-cli");
  assert.deepEqual(tools, [
    ["busy-cli", "app", "install", "--addr", "127.0.0.1:8903"],
    ["busy-cli", "app", "run", "--addr", "127.0.0.1:8903"],
  ]);
  assert.equal(ran.json.installed, true);
  assert.equal(ran.json.folder, project);
  assert.match(ran.json.output, /Installed app\.test\.edges\n.*Launched app\.test\.edges/s);
});

test("run of a project that is neither built nor on the BUSY Bar: not_built with the hint to build, and busy-cli is not run", async (t) => {
  const { root, ctx } = setup(t, { built: false });
  const sys = fakeSystem(root, { onBar: ["app.other.one"] });
  const refused = await call(["run", "my-app", "--json"], ctx, sys);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "not_built");
  assert.match(refused.json.message, /app\.test\.edges is not on the emulated BUSY Bar, and the project has no built package to install/);
  // The hint leads on, not in a circle: build, then run.
  assert.match(refused.json.hint, /^Build it first: \S+ build my-app; then run \S+ run my-app again\.$/);
  assert.deepEqual(sys.calls.filter((one) => one[0] === "busy-cli"), []);
});

test("run without a built package starts the app the BUSY Bar already has; a failed install is told as the install's", async (t) => {
  const { root, ctx } = setup(t, { built: false });
  const sys = fakeSystem(root, { onBar: [ID], log: () => [launch] });
  const ran = await call(["run", "my-app", "--json"], ctx, sys);
  assert.equal(ran.code, 0, JSON.stringify(ran.json));
  assert.equal(ran.json.installed, false);
  assert.deepEqual(sys.calls.filter((one) => one[0] === "busy-cli"), [["busy-cli", "app", "run", "--addr", "127.0.0.1:8903"]]);

  const built = setup(t);
  const failing = fakeSystem(built.root, { tools: { install: () => ({ code: 1, signal: null, output: "■  The BUSY Bar answered: Cannot unpack (HTTP 400)\n" }) } });
  const failed = await call(["run", "my-app", "--json"], built.ctx, failing);
  assert.equal(failed.json.code, "tool_failed");
  assert.equal(failed.json.tool, "busy-cli app install");
  assert.match(failed.json.hint, / build my-app\), then run \S+ run my-app again\.$/);
  assert.equal(failing.calls.filter((one) => one[0] === "busy-cli").length, 1, "the launch was not tried");
});

// ---------------------------------------------------------------- run says what came of the launch

test("run of a script that throws at once: app_crashed with the first error line, its log, and the hint to logs", async (t) => {
  const { root, ctx } = setup(t);
  // The first reading has only the launch; the crash shows a moment later.
  const sys = fakeSystem(root, { log: (n) => (n === 0 ? [launch] : [other, launch, printed, other, thrown, exitedWithError]) });
  const ran = await call(["run", "my-app", "--json"], ctx, sys);
  assert.equal(ran.code, 1, JSON.stringify(ran.json));
  assert.equal(ran.json.ok, false);
  assert.equal(ran.json.code, "app_crashed");
  assert.equal(ran.json.message, `${ID} started on the emulated BUSY Bar and stopped at once: [JsRunner] Error running script: ReferenceError: draw is not defined`);
  assert.equal(ran.json.error, "[JsRunner] Error running script: ReferenceError: draw is not defined");
  assert.equal(ran.json.running, false);
  assert.equal(ran.json.exited, "error running main.js: Error running script: ReferenceError: draw is not defined");
  assert.deepEqual(ran.json.log.map((line) => line.text), [launch, printed, thrown, exitedWithError].map((line) => line.text), "its own lines, not another app's");
  assert.match(ran.json.hint, /^Its console and the error are in \S+ logs\. Fix the script, then \S+ build my-app and \S+ run my-app again\.$/);
  // For a person: on stderr, exit code 1.
  const person = await call(["run", "my-app"], ctx, fakeSystem(root, { log: () => [launch, thrown, exitedWithError] }));
  assert.equal(person.code, 1);
  assert.match(person.err.join("\n"), /stopped at once: \[JsRunner\] Error running script: ReferenceError/);
});

test("run after `time set` 6 hours back: the crash is told by the computer's clock of the lines (at), not the BUSY Bar's", async (t) => {
  const { root, ctx } = setup(t);
  // The bar's clock is 6 hours behind the computer's: every line's `time` is before the moment run started.
  const shifted = (line, n) => ({ ...line, time: line.time - 6 * 3600_000, at: T + 10 + n });
  const lines = [launch, printed, thrown, exitedWithError].map(shifted);
  const ran = await call(["run", "my-app", "--json"], ctx, fakeSystem(root, { log: () => lines }));
  assert.equal(ran.json.code, "app_crashed", JSON.stringify(ran.json));
  assert.equal(ran.json.error, "[JsRunner] Error running script: ReferenceError: draw is not defined");
  // A launch before run started, by the computer's clock, is not this run's, whatever the bar's clock says.
  const earlier = [launch, finished].map((line) => ({ ...line, time: line.time + 6 * 3600_000, at: T - 1000 }));
  assert.equal(runOutcome(earlier, ID, T).launched, false);
});

test("run of an app that keeps running: ok, running, after a second of watching", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { log: () => [launch, printed] });
  const before = sys.now();
  const ran = await call(["run", "my-app", "--json"], ctx, sys);
  assert.equal(ran.code, 0);
  assert.equal(ran.json.running, true);
  assert.equal(ran.json.exited, null);
  assert.deepEqual(ran.json.errors, []);
  assert.ok(sys.now() - before >= 1000 && sys.now() - before < 1500, `watched for ${sys.now() - before} ms`);
  const person = await call(["run", "my-app"], ctx, fakeSystem(root, { log: () => [launch, printed] }));
  assert.match(person.out.join("\n"), /Started app\.test\.edges on the emulated BUSY Bar at 127\.0\.0\.1:8903; it is running\. Its console: \S+ logs\.$/);
});

test("run of a script that ran to its end at once without an error: ok, not running, said plainly", async (t) => {
  const { root, ctx } = setup(t);
  const ran = await call(["run", "my-app", "--json"], ctx, fakeSystem(root, { log: () => [launch, printed, finished] }));
  assert.equal(ran.code, 0);
  assert.equal(ran.json.ok, true);
  assert.equal(ran.json.running, false);
  assert.equal(ran.json.exited, "finished");
  const person = await call(["run", "my-app"], ctx, fakeSystem(root, { log: () => [launch, printed, finished] }));
  assert.match(person.out.join("\n"), /its script ran to its end at once without an error, so it is not running any more/);
});

test("run: an error printed by a script that then ends \"finished\" is a crash; a log that cannot be read claims nothing", async (t) => {
  const { root, ctx } = setup(t);
  const uncaught = { kind: "error", text: `${ID} error: Uncaught: ReferenceError: undefinedFunction is not defined`, time: T + 30 };
  const crashed = await call(["run", "my-app", "--json"], ctx, fakeSystem(root, { log: () => [launch, uncaught, finished] }));
  assert.equal(crashed.json.code, "app_crashed");
  assert.equal(crashed.json.error, "Uncaught: ReferenceError: undefinedFunction is not defined");
  const blind = await call(["run", "my-app", "--json"], ctx, fakeSystem(root, { log: () => ({ failed: "HTTP 404" }) }));
  assert.equal(blind.code, 0);
  assert.equal(blind.json.running, null);
  // A launch from before this run (the same app started earlier) is not this run's.
  const old = await call(["run", "my-app", "--json"], ctx, fakeSystem(root, { log: () => [{ ...launch, time: T - 60_000 }, { ...thrown, time: T - 59_000 }, { ...exitedWithError, time: T - 58_000 }] }));
  assert.equal(old.code, 0);
  assert.equal(old.json.running, null);
});

test("runOutcome: the latest launch of the app, its own lines only, the engine's fatal errors", () => {
  const second = { ...launch, time: T + 100 };
  const outcome = runOutcome([launch, thrown, exitedWithError, second, printed], ID, T);
  assert.deepEqual(outcome, { launched: true, exited: null, crashed: false, errors: [], lines: [second, printed] });
  assert.equal(runOutcome([other], ID, T).launched, false);
  const fatal = { kind: "error", text: `App ${ID}: JS heap overflow: the supervisor takes over, as on a BUSY Bar`, time: T + 50 };
  const stuck = runOutcome([launch, fatal], ID, T);
  assert.deepEqual([stuck.errors, stuck.crashed, stuck.exited], [["JS heap overflow: the supervisor takes over, as on a BUSY Bar"], true, null]);
  // Stopped by somebody (stop, a button) is an end, not a crash.
  const quit = runOutcome([launch, { kind: "app", text: `App ${ID} exited: quit; heap peak 2.7 of 128 KiB`, time: T + 50 }], ID, T);
  assert.deepEqual([quit.exited, quit.crashed], ["quit", false]);
});

// ---------------------------------------------------------------- logs

test("logs: the BUSY Bar's latest lines, console.log and errors, as JSON and for a person", async (t) => {
  const { root, ctx } = setup(t);
  const lines = [launch, printed, thrown, exitedWithError];
  const sys = fakeSystem(root, { log: lines });
  const answer = await call(["logs", "--json"], ctx, sys);
  assert.equal(answer.code, 0, JSON.stringify(answer.json));
  assert.equal(answer.json.address, "127.0.0.1:8903");
  assert.equal(answer.json.kept, 4);
  assert.deepEqual(answer.json.lines[1], { time: new Date(T + 20).toISOString(), kind: "log", text: `${ID} log: hello from my app` });
  assert.equal(answer.json.lines[2].kind, "error");
  const person = await call(["logs"], ctx, sys);
  assert.equal(person.out.length, 1);
  const shown = person.out[0].split("\n");
  assert.equal(shown.length, 4);
  assert.match(shown[1], /^\d\d:\d\d:\d\d  log     app\.test\.edges log: hello from my app$/);
  assert.match(shown[2], /^\d\d:\d\d:\d\d  error   app\.test\.edges \[JsRunner\] Error running script/);
});

test("logs --lines: the latest n, with a note of how many there are; a wrong n is a wrong call; an empty log says so", async (t) => {
  const { root, ctx } = setup(t);
  const many = Array.from({ length: 80 }, (_, n) => ({ kind: "log", text: `${ID} log: line ${n}`, time: T + n }));
  const sys = fakeSystem(root, { log: many });
  const usual = await call(["logs", "--json"], ctx, sys);
  assert.equal(usual.json.lines.length, 50);
  assert.equal(usual.json.lines.at(-1).text, `${ID} log: line 79`);
  assert.equal(usual.json.kept, 80);
  const three = await call(["logs", "--lines", "3"], ctx, sys);
  assert.deepEqual(three.out[0].split("\n").map((line) => line.replace(/^\d\d:\d\d:\d\d\s+\S+\s+/, "")), [`${ID} log: line 77`, `${ID} log: line 78`, `${ID} log: line 79`, "(the latest 3 of 80 lines; --lines <n> shows more)"]);
  for (const wrong of ["0", "many", "1.5"]) {
    const refused = await call(["logs", "--lines", wrong, "--json"], ctx, sys);
    assert.equal(refused.code, 2, wrong);
    assert.equal(refused.json.code, "usage");
  }
  const empty = await call(["logs"], ctx, fakeSystem(root, { log: [] }));
  assert.match(empty.out[0], /^The BUSY Bar's log is empty/);
});

test("logs --follow: the kept lines, then every new one as it comes, each a line of its own; the answer last", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { log: [launch, printed, thrown] });
  const followed = await call(["logs", "--follow", "--lines", "1", "--json"], ctx, sys);
  assert.equal(followed.code, 0);
  // --lines 1 of the two kept ones, then the new one, then the answer.
  assert.deepEqual(followed.out.slice(0, 2).map((line) => JSON.parse(line).text), [printed.text, thrown.text]);
  assert.deepEqual(JSON.parse(followed.out[2]), { ok: true, command: "logs", followed: true, app: null, since_run: false, kinds: ["console", "lifecycle", "system"], since: null, lines_printed: 2, address: "127.0.0.1:8903" });
  // In the project's folder only its app's lines are followed: the other app's new line is not printed.
  const { root: inside, ctx: here, project } = setup(t);
  const mine = fakeSystem(inside, { log: [launch, printed, other] });
  mine.cwd = () => project;
  const own = await call(["logs", "--follow", "--json"], here, mine);
  assert.deepEqual(own.out.slice(0, -1).map((line) => JSON.parse(line).text), [launch.text, printed.text]);
  assert.equal(JSON.parse(own.out.at(-1)).app, ID);
});

test("logs of one app: in a project's folder its app's lines and the BUSY Bar's own, --app names another, --all every app's, --since-run from the latest launch", async (t) => {
  const { root, ctx, project } = setup(t);
  const earlier = { kind: "log", text: `${ID} log: from the run before`, time: T + 1 };
  const clockSet = { kind: "system", text: "The BUSY Bar's clock was set to 2026-11-11 10:00:00", time: T + 2 };
  const otherLaunch = { kind: "app", text: "Launch app.other.one (heap 128 KiB)", time: T + 22 };
  const lines = [earlier, clockSet, launch, printed, otherLaunch, other, thrown];
  const sys = fakeSystem(root, { log: lines });
  const texts = (answer) => answer.json.lines.map((line) => line.text);

  // Outside a project: every line.
  assert.deepEqual(texts(await call(["logs", "--json"], ctx, sys)), lines.map((line) => line.text));
  sys.cwd = () => project;
  const own = await call(["logs", "--json"], ctx, sys);
  assert.equal(own.json.app, ID);
  assert.deepEqual(texts(own), [earlier.text, clockSet.text, launch.text, printed.text, thrown.text]);
  const shown = await call(["logs"], ctx, sys);
  assert.match(shown.out[0], /\(app\.test\.edges and the BUSY Bar's own lines; --all shows every app's\)$/);
  assert.deepEqual(texts(await call(["logs", "--all", "--json"], ctx, sys)), lines.map((line) => line.text));
  assert.deepEqual(texts(await call(["logs", "--app", "app.other.one", "--json"], ctx, sys)), [clockSet.text, otherLaunch.text, other.text]);

  const latest = await call(["logs", "--since-run", "--json"], ctx, sys);
  assert.equal(latest.json.since_run, true);
  assert.deepEqual(texts(latest), [launch.text, printed.text, thrown.text]);
  // Outside a project, --since-run follows the app launched last.
  sys.cwd = () => root;
  const last = await call(["logs", "--since-run", "--json"], ctx, sys);
  assert.equal(last.json.app, "app.other.one");
  assert.deepEqual(texts(last), [otherLaunch.text, other.text]);
  const never = await call(["logs", "--since-run", "--app", "app.never.ran"], ctx, sys);
  assert.match(never.out[0], /^app\.never\.ran was not launched since the emulator started; .* logs --all shows the 7 lines the BUSY Bar has\.$/);
  for (const wrong of [["--all", "--app", ID], ["--app", "not an id"]]) assert.equal((await call(["logs", ...wrong, "--json"], ctx, sys)).json.code, "usage");
});

test("the kinds and the file of Build lines are the desktop app's: its console's filters, its run/build-lines.jsonl", () => {
  const terminal = readFileSync(new URL("../../../app/src/terminal.mjs", import.meta.url), "utf8");
  const feed = readFileSync(new URL("../../../app/src/build-feed.mjs", import.meta.url), "utf8");
  assert.match(terminal, /TERMINAL_KINDS = Object\.freeze\(\["console", "lifecycle", "build", "system"\]\)/);
  assert.deepEqual(LOG_KINDS, ["console", "lifecycle", "build", "system"]);
  assert.match(feed, /BUILD_FEED_PARTS = Object\.freeze\(\["run", "build-lines\.jsonl"\]\)/);
  assert.deepEqual(BUILD_FEED_PARTS, ["run", "build-lines.jsonl"]);
});

test("logs --kind and --since: the window's console filters (console, lifecycle, build, system) and its start after Clear", async (t) => {
  const { root, ctx } = setup(t);
  const clockSet = { kind: "system", text: "The BUSY Bar's clock was set to the computer's", time: T + 5, at: T + 5 };
  // The bar's clock is an hour ahead: --since goes by the computer's (at), as the window's Clear does.
  const ahead = (line, at) => ({ ...line, time: line.time + 3_600_000, at });
  const lines = [clockSet, ahead(launch, T + 10), ahead(printed, T + 20), ahead(thrown, T + 30), ahead(exitedWithError, T + 40)];
  // What the window's buttons ran, as the desktop app keeps it in the data folder.
  mkdirSync(path.join(ctx.dataDir, "run"), { recursive: true });
  const feedLine = (text, at) => JSON.stringify({ kind: "build", text, time: at, at });
  writeFileSync(path.join(ctx.dataDir, "run", "build-lines.jsonl"), [feedLine("> busy-cli build", T + 8), feedLine("Built", T + 25), '{"broken'].join("\n") + "\n");
  const sys = fakeSystem(root, { log: lines });
  const texts = async (...argv) => (await call(["logs", "--all", ...argv, "--json"], ctx, sys)).json.lines.map((line) => line.text);

  // Without --kind: every kind of the bar's, and no build line.
  assert.deepEqual(await texts(), lines.map((line) => line.text));
  assert.deepEqual(await texts("--kind", "lifecycle"), [launch.text, exitedWithError.text]);
  assert.deepEqual(await texts("--kind", "system,console"), [clockSet.text, printed.text, thrown.text]);
  // Build lines among the bar's, in the order they came.
  assert.deepEqual(await texts("--kind", "build,lifecycle"), ["> busy-cli build", launch.text, "Built", exitedWithError.text]);
  assert.deepEqual(await texts("--kind", "console,lifecycle,build", "--since", String(T + 20)), ["Built", thrown.text, exitedWithError.text]);
  const json = (await call(["logs", "--all", "--kind", "build", "--since", String(T + 8), "--json"], ctx, sys)).json;
  assert.deepEqual([json.kinds, json.since, json.lines], [["build"], T + 8, [{ time: new Date(T + 25).toISOString(), kind: "build", text: "Built" }]]);
  const none = await call(["logs", "--all", "--kind", "system", "--since", String(T + 6)], ctx, sys);
  assert.match(none.out[0], /^No system lines since \d\d:\d\d:\d\d\.$/);
  for (const wrong of [["--kind", "everything"], ["--kind", ""], ["--kind", "console,"], ["--since", "yesterday"], ["--since", "-5"], ["--since", "1.5"]]) {
    const refused = await call(["logs", ...wrong, "--json"], ctx, sys);
    assert.equal(refused.code, 2, wrong.join(" "));
    assert.equal(refused.json.code, "usage", wrong.join(" "));
  }
});

test("logs --follow for a person starts with one line: whose lines, which kinds, from when; then the lines, the new build lines too", async (t) => {
  const { root, ctx } = setup(t);
  const feed = path.join(ctx.dataDir, "run", "build-lines.jsonl");
  mkdirSync(path.dirname(feed), { recursive: true });
  writeFileSync(feed, `${JSON.stringify({ kind: "build", text: "> busy-cli build", time: T + 1, at: T + 1 })}\n`);
  const sys = fakeSystem(root, { log: [launch, printed, thrown] });
  // The stream stays open a moment, as the emulator's does, while a new build line is written.
  const barLog = sys.barLog;
  sys.barLog = async (port, options) => {
    const answer = await barLog(port, { ...options, onLine: null });
    writeFileSync(feed, `${JSON.stringify({ kind: "build", text: "Built", time: T + 50, at: T + 50 })}\n`, { flag: "a" });
    await new Promise((resolve) => setTimeout(resolve, 600));
    options.onLine(thrown);
    return answer;
  };
  const followed = await call(["logs", "--follow", "--all", "--kind", "console,build", "--since", String(T)], ctx, sys);
  assert.equal(followed.code, 0, followed.err.join("\n"));
  assert.match(followed.out[0], /^The BUSY Bar's log for every app: console and build lines, from \d\d:\d\d:\d\d\. Ctrl\+C stops\.$/);
  assert.deepEqual(followed.out.slice(1, -1).map((line) => line.replace(/^\d\d:\d\d:\d\d\s+\S+\s+/, "")), ["> busy-cli build", printed.text, "Built", thrown.text]);
  assert.match(followed.out.at(-1), /^The emulator closed the log/);
  // With --json there is no such line: every line is the log's.
  const json = await call(["logs", "--follow", "--all", "--json"], ctx, fakeSystem(root, { log: [launch, printed] }));
  assert.deepEqual(json.out.slice(0, -1).map((line) => JSON.parse(line).text), [launch.text, printed.text]);
});

test("logs without an emulator: not_running with the hint to start; a BUSY Bar that gives no log: log_failed; a sandbox: blocked_network", async (t) => {
  const { root, ctx } = setup(t);
  const none = await call(["logs", "--json"], ctx, fakeSystem(root, { emulator: null }));
  assert.equal(none.code, 1);
  assert.equal(none.json.code, "not_running");
  assert.match(none.json.hint, / start, then run \S+ logs again\.$/);
  const failed = await call(["logs", "--json"], ctx, fakeSystem(root, { log: { failed: "HTTP 404" } }));
  assert.equal(failed.json.code, "log_failed");
  const blocked = await call(["logs", "--json"], ctx, fakeSystem(root, { log: { blocked: "EPERM" } }));
  assert.equal(blocked.json.code, "blocked_network");
});
