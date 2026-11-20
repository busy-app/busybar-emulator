// What the gate reads out of node --test's output (gate-lib.mjs), checked against the real output of this Node: test
// files written for the case, run with --test-reporter=tap as the gate runs them.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execProgram } from "../packages/engine/programs.mjs";
import { ALLOWED_SKIPS, failuresOf, fileOutcome, flakeVerdict, KNOWN_FLAKES, lockIsStale, machineSkipsOf, NO_REASON, partialScope, referencesOf, sortFailures, sortSkips, stillRunning, tallyEvents, tallyTap, tallyTotals, touchedTests, verdictOf } from "./gate-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "busybar-emulator-gate-lib-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * node --test --test-reporter=tap on files of the given sources, from their folder; returns the tally. Without
 * NODE_TEST_CONTEXT, which this test's own runner sets: with it the inner runner reports to the outer one, not in TAP.
 */
function tally(sources) {
  const files = Object.keys(sources);
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
  // As the gate runs it: TAP to stdout, and the gate's reporter to a file.
  const events = join(dir, "events.jsonl");
  rmSync(events, { force: true });
  const reporter = pathToFileURL(join(here, "gate-reporter.mjs")).href;
  let text;
  let code = 0;
  try {
    text = execFileSync(process.execPath, ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${reporter}`, `--test-reporter-destination=${events}`, ...files], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: withoutTestContext });
  } catch (e) {
    text = String(e.stdout);
    code = e.status;
  }
  const recorded = existsSync(events) ? readFileSync(events, "utf8") : null;
  return { ...tallyTap(text, files), code, recorded, unfinished: tallyEvents(recorded), failures: failuresOf(recorded) };
}

const withoutTestContext = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));

/**
 * The environment for a gate this test starts: its temporary folders (the run's bg-* folder among them) inside this
 * test's own folder, which is removed at the end, so that a nested gate that is stopped leaves nothing in the suite's.
 */
let nested = 0;
function gateEnv(extra = {}) {
  const tmp = join(dir, `nested-tmp-${++nested}`);
  mkdirSync(tmp, { recursive: true });
  const env = { ...withoutTestContext, TMPDIR: tmp, TEMP: tmp, TMP: tmp, ...extra };
  for (const k of ["EMU_GATE_SKIP", "EMU_GATE_MACHINE_SKIP", "EMU_GATE_REMOTE"]) if (!(k in extra)) delete env[k];
  return env;
}
const PASSING = 'import { test } from "node:test";\ntest("passes", () => {});\n';

test("a file whose tests end before they ran is a failure, not a passing test", () => {
  const t = tally({
    "early-exit.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("would fail", async () => { await new Promise((r) => setTimeout(r, 200)); assert.fail(); });\nsetTimeout(() => process.exit(0), 50);\n',
    "fine.test.mjs": PASSING,
  });
  assert.equal(t.fail, 1, JSON.stringify(t));
  assert.match(t.problems.join("\n"), /early-exit\.test\.mjs: the file ran no test/);
});

test("a file that ends its process midway, after a test passed, is seen: its other tests never finished", () => {
  const t = tally({
    "midway.test.mjs": [
      'import { test } from "node:test";',
      'import assert from "node:assert";',
      'test("a passes", () => {});',
      'test("b ends the process", async () => { await new Promise((r) => setTimeout(r, 50)); process.exit(0); });',
      'test("c would fail", () => assert.fail());',
    ].join("\n"),
    "fine.test.mjs": PASSING,
  });
  // What node --test and TAP say: a success with two passing tests, nothing failed.
  assert.equal(t.code, 0);
  assert.equal(t.fail, 0, JSON.stringify(t));
  assert.equal(t.unfinished.length, 1, t.unfinished.join("\n"));
  assert.match(t.unfinished[0], /midway\.test\.mjs: 2 of \d+ registered tests never finished \("b ends the process", "c would fail"\)/);
});

test("a run whose files all finish has nothing unfinished; a run with no record of them is a problem", () => {
  const t = tally({ "fine.test.mjs": PASSING, "subtests.test.mjs": 'import { describe, test } from "node:test";\ndescribe("block", () => { test("x", () => {}); test("y", { skip: "why" }, () => {}); });\ntest("z", async (t) => { await t.test("inner", () => {}); });\n' });
  assert.deepEqual(t.unfinished, []);
  assert.equal(tallyEvents(null).length, 1);
});

test("a file that registers no test is a failure", () => {
  const t = tally({ "empty.test.mjs": "// nothing here\n", "fine.test.mjs": PASSING });
  assert.equal(t.fail, 1);
  assert.match(t.problems[0], /empty\.test\.mjs: the file ran no test/);
});

test("a skip with a reason is listed under its reason; one without a reason, describe.skip included, is a failure", () => {
  const t = tally({
    "skips.test.mjs": [
      'import { describe, test } from "node:test";',
      "import assert from 'node:assert';",
      'test("runs", () => {});',
      'test("windows", { skip: "Windows only" }, () => {});',
      'test("no reason", { skip: true }, () => {});',
      'test.skip("dot skip", () => {});',
      'describe.skip("a block", () => { test("x", () => assert.fail()); });',
    ].join("\n"),
  });
  assert.deepEqual([...t.reasons], [["Windows only", 1]]);
  assert.equal(t.problems.length, 3, t.problems.join("\n"));
  assert.equal(t.fail, 3);
});

test("a todo test is a failure, failing or not", () => {
  const t = tally({ "todo.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert";\ntest("fails", { todo: true }, () => assert.fail());\ntest("later", { todo: "later" }, () => {});\n' });
  assert.equal(t.fail, 2, t.problems.join("\n"));
});

test("what a test prints that looks like the summary does not count: the runner's last lines do", () => {
  const t = tally({ "prints.test.mjs": 'import { test } from "node:test";\ntest("prints", () => console.log("# pass 0\\n# fail 9"));\ntest("again", () => {});\n' });
  assert.equal(t.pass, 2);
  assert.equal(t.fail, 0);
});

test("a comparison suite's totals: its last line of them", () => {
  assert.deepEqual(tallyTotals("# totals pass=1 fail=0 skip=0\nmore\n# totals pass=27 fail=1 skip=0\n"), { pass: 27, fail: 1, skip: 0, reasons: new Map() });
  assert.ok(Number.isNaN(tallyTotals("all checks passed\n").pass));
});

test("a comparison suite's skips without a reason count as such, and no allowed reason takes them", () => {
  const c = tallyTotals("# skip 1 a reason\n# totals pass=3 fail=0 skip=4\n");
  assert.deepEqual(c.reasons, new Map([["a reason", 1], [NO_REASON, 3]]));
  assert.deepEqual(sortSkips(new Map([[NO_REASON, 3]])).unexpected, [[NO_REASON, 3]]);
  assert.deepEqual(sortSkips(new Map([[NO_REASON, 3]]), { exported: true }).unexpected, [[NO_REASON, 3]]);
  // The api suite's skip without a recording, and the settings walks the public tree leaves out (there only).
  const api = "no recording of a BUSY Bar's API answers in test/api/ (node emulator/test/api.mjs --bar --record)";
  assert.equal(sortSkips(new Map([[api, 1]])).allowed[0].layer, "the recording of a BUSY Bar's API answers");
  const unpublished = "a recording left out of the public tree (test/unpublished.json)";
  assert.deepEqual(sortSkips(new Map([[unpublished, 1]])).unexpected, [[unpublished, 1]]);
  assert.deepEqual(sortSkips(new Map([[unpublished, 1]]), { exported: true }).unexpected, []);
});

test("a comparison suite's skips with a reason are sorted like a test's", () => {
  const why = "the engine is built by hand: EMU_FIRMWARE_REPO is not set";
  const c = tallyTotals(`  skip one\n# skip 2 ${why}\n# totals pass=15 fail=0 skip=2\n`);
  assert.deepEqual(c, { pass: 15, fail: 0, skip: 2, reasons: new Map([[why, 2]]) });
  const sorted = sortSkips(c.reasons);
  assert.deepEqual(sorted.unexpected, []);
  assert.equal(sorted.allowed[0].layer, "the engine's build");
  // A reason no allowed layer names is not allowed.
  assert.deepEqual(sortSkips(new Map([["awaiting a recording of a bar", 1]])).unexpected, [["awaiting a recording of a bar", 1]]);
});

test("a run that is not the whole gate is named; the Windows gate's own two skips are not partial", () => {
  assert.equal(partialScope({}), null);
  assert.equal(partialScope({ only: ["board"] }), "--only board");
  assert.equal(partialScope({ comparison: true, firmware: ["1.3.1"] }), "--comparison; --firmware 1.3.1");
  assert.equal(partialScope({ skip: ["golden"] }), "skipped on request: golden");
  assert.equal(partialScope({ skip: ["app", "export"], expectedSkips: ["app", "export"] }), null);
  assert.equal(partialScope({ skip: ["app", "export", "golden"], expectedSkips: ["app", "export"] }), "skipped on request: golden");
});

test("a machine lock that is empty, not a number, PID 0 or 1, or a gone holder's is stale; a live holder's is not", () => {
  const alive = (pid) => pid === 4242;
  for (const text of ["", " \n", "abc", "0", "1", "-5", "12.5"]) assert.equal(lockIsStale(text, { alive, ageMs: 60_000 }), true, JSON.stringify(text));
  assert.equal(lockIsStale("", { alive, ageMs: 100 }), false, "an empty lock just made by another gate is given a moment");
  assert.equal(lockIsStale("4242", { alive }), false);
  assert.equal(lockIsStale("4242\n", { alive }), false);
  assert.equal(lockIsStale("999999", { alive }), true);
});

test("machine skips count only from gate:win, and only for app and export; anything else is a skip on request", () => {
  const all = { unit: "x", server: "x", app: "no desktop", export: "patterns stay on the Mac" };
  assert.deepEqual(machineSkipsOf(all, undefined), { machine: {}, requested: all });
  assert.deepEqual(machineSkipsOf(all, "linux"), { machine: {}, requested: all });
  assert.deepEqual(machineSkipsOf(all, "windows", "win32"), { machine: { app: "no desktop", export: "patterns stay on the Mac" }, requested: { unit: "x", server: "x" } });
  // The variables alone are no Windows machine: on a Mac or Linux they give nothing.
  for (const platform of ["darwin", "linux"]) assert.deepEqual(machineSkipsOf(all, "windows", platform), { machine: {}, requested: all }, platform);
});

test("a skip is allowed only for a listed reason on a system where it holds; any other is counted", () => {
  const reasons = new Map([
    ["Windows only", 9],
    ["BUSY_EMULATOR_TEST_INSTALL_BUILD names no build", 3],
    ["set NEVER_SET to run", 2],
  ]);
  const mac = sortSkips(reasons, { platform: "darwin" });
  assert.deepEqual(mac.unexpected, [["set NEVER_SET to run", 2]]);
  assert.deepEqual(mac.allowed.map((l) => [l.layer, l.count]), [["tests of Windows", 9], ["the release's own files", 3]]);
  // On Windows a test of Windows that skips is not one another gate runs.
  const win = sortSkips(reasons, { platform: "win32" });
  assert.deepEqual(win.unexpected.map(([why]) => why), ["Windows only", "set NEVER_SET to run"]);
  assert.deepEqual(sortSkips(new Map([["macOS only", 1]]), { platform: "darwin" }).unexpected, [["macOS only", 1]]);
  // The shell's Electron tests of Windows (its own title bar) run in gate:win --with-app, and are not allowed to skip
  // on Windows itself.
  assert.deepEqual(sortSkips(new Map([["macOS", 3]]), { platform: "darwin" }).allowed.map((l) => l.layer), ["the shell's Electron tests of Windows"]);
  assert.deepEqual(sortSkips(new Map([["macOS", 3]]), { platform: "win32" }).allowed.map((l) => l.layer), ["tests of macOS and POSIX systems"]);
  // The reasons gate:win gave for its tests of macOS and POSIX systems, 12.11.
  for (const why of ["Windows", "no folder here can be made read-only (Windows, or a volume without permissions): the read-only half did not run", "permissions cannot be taken away on Windows, FAT or exFAT", "a Mac's build", "closing the last window quits the app on this system"]) {
    assert.deepEqual(sortSkips(new Map([[why, 1]]), { platform: "win32" }).unexpected, [], why);
  }
  // Electron's missing binary is allowed only when the run leaves the app suite out (gate:win without --with-app).
  const noElectron = new Map([["Electron's binary is not installed: node node_modules/electron/install.js", 1]]);
  assert.deepEqual(sortSkips(noElectron, { platform: "win32", appLeftOut: true }).unexpected, []);
  assert.equal(sortSkips(noElectron, { platform: "win32" }).unexpected.length, 1);
  assert.equal(sortSkips(new Map([["Electron is slow", 1]]), { platform: "win32", appLeftOut: true }).unexpected.length, 1);
  // The guide's pictures are taken by hand: their test skips without GUIDE_SHOTS, on every system.
  for (const platform of ["darwin", "win32"]) assert.deepEqual(sortSkips(new Map([["GUIDE_SHOTS=<folder> takes the guide's pictures", 1]]), { platform }).allowed.map((l) => l.layer), ["the guide's pictures"], platform);
  // The release's own files are where the release's run of the gate runs them: there their skip counts.
  assert.deepEqual(sortSkips(reasons, { platform: "darwin", release: true }).unexpected.map(([why]) => why), ["BUSY_EMULATOR_TEST_INSTALL_BUILD names no build", "set NEVER_SET to run"]);
  // What the public tree leaves out is allowed there only.
  assert.equal(sortSkips(new Map([["the export check lives in the monorepo", 2]]), { platform: "darwin" }).unexpected.length, 1);
  assert.equal(sortSkips(new Map([["the export check lives in the monorepo", 2]]), { platform: "darwin", exported: true }).unexpected.length, 0);
  assert.equal(sortSkips(new Map([["the registry tool (emulator/tools/catalog-registry) is not in this tree: the catalog's own checker is not run", 4]]), { platform: "darwin", exported: true }).unexpected.length, 0);
  for (const entry of ALLOWED_SKIPS) assert.ok(entry.layer && entry.where && entry.match.length, JSON.stringify(entry));
});

test("exit code 0 only for all green; 3 for green that is not the whole gate; 1 failed; 130 stopped", () => {
  assert.deepEqual(verdictOf({}), { code: 0, text: "all green" });
  assert.deepEqual(verdictOf({ machine: "without app, export, which this machine does not run (see skipped)" }), { code: 0, text: "all green without app, export, which this machine does not run (see skipped)" });
  assert.equal(verdictOf({ partial: "--only board" }).code, 3);
  assert.match(verdictOf({ partial: "--only board" }).text, /^green, but a PARTIAL RUN/);
  assert.deepEqual(verdictOf({ skippedSuites: ["app"] }), { code: 3, text: "green, but 1 suites skipped (app) (see skipped)" });
  assert.deepEqual(verdictOf({ unexpectedTests: 2 }), { code: 3, text: "green, but 2 tests skipped for reasons not on the list of allowed ones (see skipped)" });
  assert.equal(verdictOf({ failed: ["unit"], partial: "--only unit" }).code, 1);
  assert.equal(verdictOf({ interrupted: true, failed: ["unit"] }).code, 130);
});

test("the gate itself: suites left out in EMU_GATE_MACHINE_SKIP without gate:win make a partial run with exit code 3, not all green", () => {
  const gate = join(here, "gate.mjs");
  const list = execFileSync(process.execPath, [gate, "--list"], { encoding: "utf8", env: withoutTestContext });
  const ids = list.split("\n\n")[0].split("\n").map((l) => l.split(/\s+/)[0]).filter((id) => id !== "board");
  const skip = JSON.stringify(Object.fromEntries(ids.map((id) => [id, "x"])));
  const out = join(dir, "gate-out");
  // On Windows with EMU_GATE_REMOTE=windows the other suites named there are still skips on request; elsewhere all are.
  for (const remote of [undefined, "windows"]) {
    const env = gateEnv({ EMU_GATE_MACHINE_SKIP: skip, ...(remote ? { EMU_GATE_REMOTE: remote } : {}) });
    const r = spawnSync(process.execPath, [gate, "--out", out], { encoding: "utf8", env, timeout: 120_000 });
    assert.equal(r.status, 3, `${remote ?? "no remote"}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /PARTIAL RUN, not the gate: skipped on request: /);
    assert.match(r.stdout, /— green, but a PARTIAL RUN, not the gate .*\(exit code 3\)$/m);
    assert.doesNotMatch(r.stdout, /all green/);
    rmSync(out, { recursive: true, force: true });
  }
});

test("a file that loops synchronously is named as still running when its run is stopped (the gate's time limit is all that ends it)", async () => {
  writeFileSync(join(dir, "loops.test.mjs"), 'import { test } from "node:test";\ntest("loops", () => { for (;;) {} });\n');
  writeFileSync(join(dir, "fine.test.mjs"), PASSING);
  const events = join(dir, "loop-events.jsonl");
  const reporter = pathToFileURL(join(here, "gate-reporter.mjs")).href;
  const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${reporter}`, `--test-reporter-destination=${events}`, "fine.test.mjs", "loops.test.mjs"], { cwd: dir, env: withoutTestContext, stdio: "ignore", detached: process.platform !== "win32" });
  const ended = new Promise((resolve) => child.once("exit", resolve));
  // Until the passing file has ended and the looping one has started: then only the looping one is running.
  const deadline = Date.now() + 30_000;
  const seen = () => (existsSync(events) ? readFileSync(events, "utf8") : "");
  while (Date.now() < deadline && !(/"running":"[^"]*loops\.test\.mjs"/.test(seen()) && /"ended":"[^"]*fine\.test\.mjs"/.test(seen()))) await new Promise((r) => setTimeout(r, 100));
  // Ended by its PID with what it started, as the gate ends a suite: its process group, or its tree on Windows.
  if (process.platform === "win32") {
    // The runner first, then what it started: a tree taken from its leaves lets the runner see the looping file end
    // and say so before it goes itself (seen on the Windows test machine, 12.11).
    const system = join(process.env.SystemRoot || "C:\\Windows", "System32");
    const powershell = join(system, "WindowsPowerShell", "v1.0", "powershell.exe");
    const kids = String(execProgram(powershell, ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${child.pid}').ProcessId`], { encoding: "utf8", windowsHide: true })).split(/\s+/).filter((one) => /^\d+$/.test(one));
    for (const [pid, tree] of [[String(child.pid), false], ...kids.map((one) => [one, true])]) {
      try {
        execProgram(join(system, "taskkill.exe"), ["/PID", pid, ...(tree ? ["/T"] : []), "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        // taskkill says it failed when a process of the tree was gone before it got to it; the tree is ended all the same.
      }
    }
  } else process.kill(-child.pid, "SIGKILL");
  await ended;
  const running = stillRunning(readFileSync(events, "utf8"));
  assert.equal(running.length, 1, readFileSync(events, "utf8"));
  assert.match(running[0], /loops\.test\.mjs$/);
  assert.deepEqual(stillRunning('{"running":"a"}\n{"ended":"a"}\n{"running":"b"}\n{"runn'), ["b"]);
});

test("the gate stopped while it waits for a machine lock does not run the suite without it, and says how long it waited", async () => {
  const locks = join(dir, "locks");
  mkdirSync(locks, { recursive: true });
  // Held by a live process: this one.
  writeFileSync(join(locks, "lock-load"), String(process.pid));
  // Stopped the way gate:win stops it, by the end of its input: Windows has no signal one process can send another to
  // be handled (child.kill ends it outright there, with no exit code), so a signal would test nothing there.
  const child = spawn(process.execPath, [join(here, "gate.mjs"), "--only", "ticks", "--exit-with-stdin", "--out", join(dir, "lock-out")], { env: gateEnv({ EMU_GATE_LOCK_DIR: locks }), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d) => (out += d));
  const ended = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !/waiting: another gate \(PID \d+\) runs its load-sensitive suites/.test(out)) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 1500));
  child.stdin.end();
  const code = await ended;
  assert.equal(code, 130, out);
  assert.match(out, /gate: the connection closed: stopping 0 running suites/);
  assert.match(out, /skip {2}ticks +skipped: not run: the gate was stopped while it waited \d+\.\d s for the load lock/);
  assert.doesNotMatch(out, /^ {2}(ok|FAIL) {2}ticks/m, "the suite did not run");
  assert.match(out, /waits for the machine's locks[^]*ticks +\d+\.\d s for the load lock/);
  assert.equal(readFileSync(join(locks, "lock-load"), "utf8"), String(process.pid), "the holder's lock is left as it was");
  rmSync(join(dir, "lock-out"), { recursive: true, force: true });
});

test("the gate on a system other than Windows: EMU_GATE_REMOTE=windows with app left out is a partial run, exit code 3, never all green", { skip: process.platform === "win32" && "a test of a Mac or Linux: there the two variables must give nothing" }, () => {
  const env = gateEnv({ EMU_GATE_REMOTE: "windows", EMU_GATE_MACHINE_SKIP: JSON.stringify({ app: "no desktop" }) });
  // The backlog's board is the quickest suite, but the public tree has none (MONOREPO_ONLY): there the ticks.
  const one = existsSync(join(here, "..", "docs", "backlog", "board.mjs")) ? "board" : "ticks";
  const r = spawnSync(process.execPath, [join(here, "gate.mjs"), "--only", one, "--out", join(dir, "remote-out")], { encoding: "utf8", env, timeout: 120_000 });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`PARTIAL RUN, not the gate: --only ${one}; skipped on request: app`));
  assert.doesNotMatch(r.stdout, /all green|which this machine does not run/);
  rmSync(join(dir, "remote-out"), { recursive: true, force: true });
});

test("the failures the reporter records: each test, hook and file that failed, with its file and the first line of its error; not the blocks around them", () => {
  const t = tally({
    "flaky.test.mjs": [
      'import { describe, test } from "node:test";',
      'test("the 3D probe", () => { throw new Error("in the app: Error: The 3D view did not answer\\n    at mount.js:254"); });',
      'describe("block", () => { test("inside", () => { throw new Error("another"); }); });',
      'test("passes", () => {});',
    ].join("\n"),
    "hook.test.mjs": 'import { after, test } from "node:test";\ntest("fine", () => {});\nafter(() => { throw new Error("UDP 0.0.0.0:53975"); });\n',
  });
  const seen = t.failures.map((f) => [f.file.split(/[\\/]/).pop(), f.name.split(/[\\/]/).pop(), f.error]).sort();
  assert.deepEqual(seen, [
    ["flaky.test.mjs", "inside", "another"],
    ["flaky.test.mjs", "the 3D probe", "in the app: Error: The 3D view did not answer"],
    ["hook.test.mjs", "hook.test.mjs", "UDP 0.0.0.0:53975"],
  ]);
});

test("a failure is a known flake only when suite, system, file, test and error all match its entry; anything else counts", () => {
  const ledger = [{ key: "EMU-001", suite: "app", on: ["win32"], file: "test/app/x.test.mjs", test: /^the probe/, error: /did not answer/, why: "w" }];
  // A Windows checkout's folder, put together here (a path written whole would read as somebody's own to the export check).
  const cwd = ["C:", "work", "emulator", "packages", "app"].join("\\");
  const failure = (over = {}) => ({ file: `${cwd}\\test\\app\\x.test.mjs`, name: "the probe of the view", nesting: 0, type: "testCodeFailure", error: "in the app: Error: The view did not answer", ...over });
  const sort = (failures, platform = "win32", suite = "app") => sortFailures(failures, { suite, cwd, platform, ledger });
  assert.deepEqual(sort([failure()]).known.map((k) => [k.key, k.file]), [["EMU-001", "test/app/x.test.mjs"]]);
  assert.equal(sort([failure()]).unknown.length, 0);
  for (const [why, sorted] of [
    ["another system", sort([failure()], "darwin")],
    ["another suite", sort([failure()], "win32", "app-unit")],
    ["another file", sort([failure({ file: `${cwd}\\test\\app\\y.test.mjs` })])],
    ["another test", sort([failure({ name: "a click" })])],
    ["another error", sort([failure({ error: "AssertionError: 1 !== 2" })])],
  ]) assert.deepEqual([sorted.known.length, sorted.unknown.length], [0, 1], why);
  // One known and one other: the other keeps the suite red (gate.mjs turns a suite green only with no unknown).
  assert.deepEqual(((r) => [r.known.length, r.unknown.length])(sort([failure(), failure({ name: "a click" })])), [1, 1]);
});

test("a known flake turns its suite green only when nothing else is wrong: no file stopped midway, no other failure", () => {
  // The review of EMU-330: a known flake in one file and another file that ended its process after 2 of its 4 tests
  // was green, since the unfinished tests were looked at only for exit code 0.
  const ledger = [{ key: "EMU-001", suite: "app", file: "test/app/flaky.test.mjs", test: /^the probe/, error: /did not answer/, why: "w" }];
  const cwd = ["", "work", "emulator", "packages", "app"].join("/");
  const flaky = { file: `${cwd}/test/app/flaky.test.mjs`, name: "the probe", nesting: 0, type: "testCodeFailure", error: "The 3D view did not answer (probe full)" };
  const events = [
    JSON.stringify({ failed: flaky }),
    JSON.stringify({ file: `${cwd}/test/app/cut.test.mjs`, registered: 4, finished: 2, unfinished: ["second ends the process", "third, never runs"] }),
    JSON.stringify({ file: flaky.file, registered: 2, finished: 2, unfinished: [] }),
  ].join("\n");
  const verdict = (over) => flakeVerdict({ failures: failuresOf(events), suite: "app", cwd, platform: "darwin", ledger, fail: 1, ...over });
  assert.equal(verdict({ unfinished: [] }).green, true, "the flake alone");
  const unfinished = tallyEvents(events);
  assert.equal(unfinished.length, 1);
  assert.equal(verdict({ unfinished }).green, false, "a file that stopped midway");
  assert.equal(verdict({ unfinished: [], fail: 2 }).green, false, "more failed tests than known failures (one the reporter did not name)");
  assert.equal(verdict({ unfinished: [], problems: ["a skip without a reason"] }).green, false, "another problem of the tally");
  assert.equal(flakeVerdict({ failures: [], suite: "app", cwd, ledger, fail: 0 }).green, false, "no failure: not a flake's green");
});

test("EMU-328's entry takes only the full probe's timeout, not any request of the 3D view that went unanswered", () => {
  const cwd = ["C:", "work", "emulator", "packages", "app"].join("\\");
  const failure = (error) => ({ file: `${cwd}\\test\\app\\stage3d.test.mjs`, name: "the RGB LEDs at the ends of Start follow the state the page gives: the hue", nesting: 0, type: "testCodeFailure", error });
  const sort = (error) => ((r) => [r.known.length, r.unknown.length])(sortFailures([failure(error)], { suite: "app", cwd, platform: "win32" }));
  assert.deepEqual(sort("in the app: Error: The 3D view did not answer (probe full)"), [1, 0]);
  for (const other of ["in the app: Error: The 3D view did not answer (probe)", "in the app: Error: The 3D view did not answer (lights)", "in the app: Error: The 3D view did not answer"]) assert.deepEqual(sort(other), [0, 1], other);
  // The text the entry reads is the one mount.js gives: what was asked, "full" for a full probe.
  const mount = readFileSync(join(here, "..", "packages", "server", "legacy-window", "stage3d", "mount.js"), "utf8");
  assert.match(mount, /The 3D view did not answer \(\$\{\[message\?\.type, message\?\.full \? "full" : null\]/);
});

test("gate:repeat counts a file as passed in a run only when a test of it passed and none failed, a known flake included", () => {
  const at = (name) => ["", "w", "emulator", "packages", "app", "test", "app", name].join("/");
  const summary = (name, over = {}) => JSON.stringify({ file: at(name), registered: 3, finished: 3, unfinished: [], passed: 3, skipped: 0, ...over });
  const failed = (name) => JSON.stringify({ failed: { file: at(name), name: "the probe", nesting: 0, type: "testCodeFailure", error: "The 3D view did not answer (probe full)" } });
  const file = "packages/app/test/app/a.test.mjs";
  assert.equal(fileOutcome([summary("a.test.mjs")], file, true), "passed");
  assert.equal(fileOutcome([`${failed("a.test.mjs")}\n${summary("a.test.mjs", { passed: 2 })}`], file, true), "failed", "a known flake that the gate let through");
  assert.equal(fileOutcome([summary("a.test.mjs", { passed: 0, skipped: 3 })], file, true), "not run", "every test skipped itself");
  assert.equal(fileOutcome([], file, true), "not run", "the suite left out (a Mac without Electron)");
  assert.equal(fileOutcome([summary("a.test.mjs", { finished: 1, unfinished: ["b", "c"], passed: 1 })], file, false), "failed", "stopped midway");
  assert.equal(fileOutcome([summary("a.test.mjs")], file, false), "failed", "a red run that no test explains");
  assert.equal(fileOutcome([`${failed("b.test.mjs")}\n${summary("a.test.mjs")}`], file, false), "passed", "another file failed");
  assert.equal(fileOutcome([summary("a.test.mjs")], `emulator/${file}`, true), "passed", "named from the repository's top");
});

test("the gate's reporter counts each file's passed and skipped tests, which gate:repeat goes by", () => {
  const t = tally({
    "some.test.mjs": 'import { test } from "node:test";\ntest("passes", () => {});\ntest("skips", { skip: "why" }, () => {});\ntest("to do", { todo: "later" }, () => {});\n',
    "none.test.mjs": 'import { test } from "node:test";\ntest("skips", { skip: "why" }, () => {});\n',
  });
  const summaries = t.recorded.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.registered !== undefined);
  const of = (name) => summaries.find((e) => e.file.endsWith(name));
  assert.deepEqual([of("some.test.mjs").passed, of("some.test.mjs").skipped], [1, 2]);
  assert.deepEqual([of("none.test.mjs").passed, of("none.test.mjs").skipped], [0, 1]);
  assert.equal(fileOutcome([t.recorded], "some.test.mjs", true), "passed");
  assert.equal(fileOutcome([t.recorded], "none.test.mjs", true), "not run");
});

test("every known flake names a task of the backlog that is still open", { skip: !existsSync(join(here, "..", "docs", "backlog")) && "the backlog lives in the monorepo, not in the public tree" }, () => {
  const backlog = join(here, "..", "docs", "backlog");
  const text = readdirSync(backlog)
    .filter((f) => /^E\d+-.*\.md$/.test(f))
    .map((f) => readFileSync(join(backlog, f), "utf8"))
    .join("\n");
  // The statuses of a task that is over, by their places in board.mjs's list (new, ready, in work, in review, done,
  // blocked, canceled, obsolete); read from there, since the public tree has no Cyrillic.
  const statuses = JSON.parse(/^const STATUSES = (\[.*\]);$/m.exec(readFileSync(join(backlog, "board.mjs"), "utf8"))[1]);
  assert.equal(statuses.length, 8, "board.mjs's statuses are not the eight this test knows");
  const closed = [statuses[4], statuses[6], statuses[7]];
  for (const entry of KNOWN_FLAKES) {
    assert.match(entry.key, /^EMU-\d{3}$/);
    const status = new RegExp(`^### ${entry.key} .*\\n\`[^\`]*, ([^,\`]+)\`;`, "m").exec(text)?.[1];
    assert.ok(status, `${entry.key} is not a task of the backlog`);
    assert.ok(!closed.includes(status), `${entry.key} is ${status}: take its entry out of KNOWN_FLAKES`);
    for (const field of ["suite", "file", "test", "error", "why"]) assert.ok(entry[field], `${entry.key}: ${field}`);
  }
});

test("a targeted run takes the changed test files and those that reach a changed file through their imports or new URL()", () => {
  assert.deepEqual(referencesOf('import a from "./a.mjs";\nimport { b } from "../b.mjs";\nimport "./side.mjs";\nawait import("./late.mjs");\nnew URL("../../src/x.mjs", import.meta.url);\nimport fs from "node:fs";').sort(), ["../../src/x.mjs", "../b.mjs", "./a.mjs", "./late.mjs", "./side.mjs"]);
  const tree = {
    "pkg/test/one.test.mjs": 'import { h } from "./helper.mjs";',
    "pkg/test/two.test.mjs": 'const f = new URL("../src/read.mjs", import.meta.url);',
    "pkg/test/three.test.mjs": 'import x from "node:fs";',
    "pkg/test/helper.mjs": 'import { y } from "../src/deep.mjs";',
    "pkg/src/deep.mjs": "export const y = 1;",
    "pkg/src/read.mjs": "",
  };
  const read = (f) => tree[f] ?? null;
  const tests = ["pkg/test/one.test.mjs", "pkg/test/two.test.mjs", "pkg/test/three.test.mjs"];
  const touched = touchedTests(["pkg/src/deep.mjs", "pkg/src/read.mjs", "pkg/test/three.test.mjs"], tests, read);
  assert.deepEqual(touched.files.sort(), tests.slice().sort());
  assert.equal(touched.why.get("pkg/test/one.test.mjs"), "reaches pkg/src/deep.mjs");
  assert.equal(touched.why.get("pkg/test/three.test.mjs"), "changed");
  assert.deepEqual(touchedTests(["pkg/src/other.mjs"], tests, read).files, []);
});
