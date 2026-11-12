// The acceptance command (emulator/docs/quality.md, the section on review; EMU-006): everything that must be green before a merge,
// run with one command, with one summary at the end and a non-zero exit code on any failure.
//
//   npm run gate                          from emulator/: every suite below
//   npm test                              the comparison with the bar only (node test/gate.mjs --comparison)
//   node test/gate.mjs --list             the suites and what each runs
//   node test/gate.mjs --only golden,api  some suites (a name without ":<firmware>" means every firmware)
//   node test/gate.mjs --skip app         all but some
//   EMU_GATE_SKIP='{"app": "why"}'        suites to leave out, each with the reason the summary gives
//
// A run that is not the whole gate (--only, --skip, --firmware, --comparison, EMU_GATE_SKIP) says so in its first line
// and in its total line, and never ends "all green". gate:win names the suites the Windows machine cannot run in
// EMU_GATE_MACHINE_SKIP (the shell's windows, the export check); both lines name them too. Only those two, only
// with EMU_GATE_REMOTE=windows, which gate:win sets with it, and only on Windows: any other suite named there is a skip on request, and the
// run is partial.
//
// A test skipped inside a suite is all right only for a reason on the list ALLOWED_SKIPS (gate-lib.mjs), each of which
// says where that test does run: Windows' tests in gate:win, the release's own files in npm run release, a backlog
// task. The summary names those layers, which did not run here, and any skip for another reason makes the verdict
// "green, but N tests skipped". A test file whose process ended before all its tests finished (process.exit midway)
// fails its suite: a reporter beside TAP (gate-reporter.mjs) counts the tests each file registered and finished.
//   ... --firmware 1.3.1                  the comparison on one firmware (default: every firmware of the emulator)
//   ... --jobs 4                          how many suites run at once in the first phase (default: half the cores, 2-6)
//   ... --out <folder>                    where the logs go (default: a new folder in the system's temporary folder)
//
// Nothing needs to be started first: every comparison suite starts an emulator of its own (own-emulator.mjs) on a free
// port of 127.0.0.1 with a temporary data folder, and the node:test suites start theirs. Nothing is written to the
// source tree: logs and pictures go to the folder printed at the start. --record and --fit are never run here.
//
// Every suite gets a temporary folder of its own (TMPDIR, TEMP, TMP) inside one of the run's, and the run ends what it
// left: after a suite, and when the gate is stopped, the processes whose command line holds that folder (an app a test
// started in a process group of its own; the shell's Electron) are ended by their PIDs, and the folder is removed. A
// suite that finished by itself and left anything there fails: tests must leave nothing behind (quality.md).
//
// Two phases. First the suites whose results do not depend on the machine's load, several at once (--jobs). Then the
// load-sensitive ones (ticks, timed, speed), one at a time with nothing else of this gate running, each with the
// machine's load while it ran: a red one on a busy machine says so. Two gates can run side by side on one machine: their
// folders and ports are their own, and two suites take turns across gates — the load-sensitive ones, one at a time on
// the machine, and the shell's (app), which share an app's single-instance lock and the user's folders. One gate's
// first phase still loads the machine while the other's load-sensitive suites run; the load lines show it.
//
// Exit code: 0 only for "all green" (on the Windows machine: "all green without app, export"); 1 when a suite failed or
// timed out; 3 when everything that ran passed but the run was not the whole gate (partial, a suite skipped, tests
// skipped for a reason not on the list); 2 for a mistake in the options; 130 when stopped.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execProgram } from "../packages/engine/programs.mjs";
import { commandLine } from "../packages/server/arguments.mjs";
import { lockIsStale, machineSkipsOf, partialScope, sortSkips, stillRunning, tallyEvents, tallyExport, tallyTap, tallyTotals, verdictOf } from "./gate-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, ".."); // emulator/
const win = process.platform === "win32";
const started = Date.now();
// The public repository's tree (tools/export writes its record at the top): the export check, the backlog and the
// maintainers' tools stay in the monorepo, so their suites are not part of its gate.
const exported = existsSync(join(root, ".busybar-export.json"));
const MONOREPO_ONLY = ["export", "board", "tools"];

// ---------------------------------------------------------------- options

const args = process.argv.slice(2);
// --help prints the comment at the top; an option it does not know is a wrong call, exit code 2.
await commandLine(process.argv, { values: ["--only", "--skip", "--firmware", "--jobs", "--out"], flags: ["--list", "--comparison", "--exit-with-stdin"] });
function usage(problem) {
  console.error(`gate.mjs: ${problem}. node test/gate.mjs --help lists what it takes.`);
  process.exit(2);
}
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const list = (name) => option(name)?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;

const firmwareFile = JSON.parse(readFileSync(join(root, "packages", "engine", "firmware.json"), "utf8"));
const firmwares = list("--firmware") ?? Object.keys(firmwareFile.versions);
for (const f of firmwares) if (!firmwareFile.versions[f]) usage(`no firmware ${f}: ${Object.keys(firmwareFile.versions).join(", ")}`);
const cores = os.cpus().length;
const jobs = option("--jobs") ? Number(option("--jobs")) : Math.max(2, Math.min(6, Math.floor(cores / 2)));
if (!Number.isInteger(jobs) || jobs < 1) usage("--jobs needs a whole number above 0");

// ---------------------------------------------------------------- the suites

const appDir = join(root, "packages", "app");

// Every test file of the tree, found rather than listed: a file no suite takes is a failure of the gate ("files"), so
// a new test cannot be left out by mistake. A test file is *.test.mjs (or .cjs, .js); the first rule that matches
// says whose it is.
const TEST_FILE = /\.test\.(mjs|cjs|js)$/;
const RULES = [
  ["app-unit", (f) => f.startsWith("packages/app/test/unit/")],
  ["app", (f) => f.startsWith("packages/app/")],
  ["server", (f) => f.startsWith("test/server/")],
  ["ticks", (f) => f === "test/ticks.test.mjs"],
  ["tests", (f) => /^test\/[^/]+$/.test(f)],
  ["unit", (f) => f.startsWith("packages/")],
  ["tools", (f) => f.startsWith("tools/")],
];
// The scripts of test/ that are not suites of their own: what the suites share, and tools run by hand or by a test.
const HELPERS = {
  "gate.mjs": "this command",
  "gate-lib.mjs": "what this command reads out of a suite's output, and the allowed reasons to skip a test (gate-lib.test.mjs checks it)",
  "gate-reporter.mjs": "the reporter beside TAP that counts the tests each file registered and finished",
  "own-emulator.mjs": "the comparison suites' own emulator",
  "package.mjs": "app archives for the suites",
  "mirror-apps.mjs": "copies a bar's apps (by hand, with a bar)",
  "convert-data-folder.mjs": "converts a data folder of the old layout (by hand; tested in test/server)",
  "ticks.mjs": "the tick meter (by hand; ticks.test.mjs runs it)",
  "pace.mjs": "the pace probe (by hand; ticks.test.mjs runs it)",
  "smoke.mjs": "the smoke test of a built app (by hand: npm run smoke; smoke.test.mjs checks its parts)",
};
function testFiles(dir = root, rel = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "logs" || entry.name.startsWith(".")) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...testFiles(join(dir, entry.name), path));
    else if (TEST_FILE.test(entry.name)) found.push(path);
  }
  return found.sort();
}
const owner = (file) => RULES.find(([, match]) => match(file))?.[0] ?? null;
const files = testFiles();
const filesOf = (id) => files.filter((f) => owner(f) === id);
// TAP to stdout (the log), and beside it gate-reporter.mjs's count of the tests each file registered and finished, to a
// file of the run's (runHeld puts its path in place of EVENTS).
const EVENTS = "<events>";
const reporter = pathToFileURL(join(here, "gate-reporter.mjs")).href;
const nodeTest = (list, ...extra) => ["--test", "--test-reporter=tap", "--test-reporter-destination=stdout", `--test-reporter=${reporter}`, EVENTS, ...extra, ...list];
const appFiles = (id) => filesOf(id).map((f) => f.slice("packages/app/".length));
const SUITES = [
  { id: "unit", what: "unit tests of the parts: packages/**/*.test.mjs but packages/app", kind: "tap", files: filesOf("unit"), args: nodeTest(filesOf("unit")) },
  { id: "server", what: "the server's start, stop, data folder, uploads, screenshots: test/server/*.test.mjs", kind: "tap", files: filesOf("server"), args: nodeTest(filesOf("server")) },
  { id: "tests", what: "the other test files of test/ (install, state, the gate's own, ...): test/*.test.mjs but ticks", kind: "tap", files: filesOf("tests"), args: nodeTest(filesOf("tests")) },
  { id: "tools", what: "the maintainers' tools: tools/**/*.test.mjs", kind: "tap", files: filesOf("tools"), args: nodeTest(filesOf("tools")) },
  { id: "export", what: "the export check: tools/export-check/export-check.mjs", kind: "export", args: ["tools/export-check/export-check.mjs"], needs: () => (existsSync(join(root, "tools", "export-check")) ? null : "no export check in this tree") },
  { id: "board", what: "the backlog board: docs/backlog/board.mjs --check", kind: "exit", args: ["docs/backlog/board.mjs", "--check"], needs: () => (existsSync(join(root, "docs", "backlog", "board.mjs")) ? null : "no backlog in this tree") },
  {
    id: "app-unit",
    what: "the desktop app's own parts, no Electron (installer, launcher, supervisor, ...): packages/app/test/unit/*.test.mjs, one file at a time; the installer's tests need packages/app/node_modules (npm ci there)",
    kind: "tap",
    cwd: appDir,
    files: appFiles("app-unit"),
    args: nodeTest(appFiles("app-unit"), "--test-concurrency=1"),
    ports: 9,
  },
  {
    id: "app",
    what: "the desktop app in Electron (hidden windows): packages/app/**/*.test.mjs but test/unit, one file at a time",
    kind: "tap",
    cwd: appDir,
    files: appFiles("app"),
    // gate:win --with-app: through a scheduled task in the desktop session of the user logged on to Windows, where the
    // windows can be made (tools/gate/desktop-task.mjs); its output and exit code come back as the suite's own.
    args: [...(process.env.EMU_GATE_APP_DESKTOP === "task" ? [join(root, "tools", "gate", "desktop-task.mjs")] : []), ...nodeTest(appFiles("app"), "--test-concurrency=1")],
    // The test copies of Electron live here, and a test may start the app in a process group of its own.
    strays: [join(appDir, "node_modules")],
    needs: () => (existsSync(join(appDir, "node_modules", "electron", "path.txt")) ? null : "no Electron in packages/app/node_modules (run npm install in emulator/packages/app)"),
    ports: 9,
    timeout: 40,
    // The shell's tests share what an app shares on a machine (its single-instance lock, the user's app folders):
    // two gates run them one after the other.
    machineLock: "app",
  },
  { id: "ticks", what: "125 GUI ticks a second of real time: test/ticks.test.mjs", kind: "tap", files: filesOf("ticks"), args: nodeTest(filesOf("ticks")), load: true },
];
if (exported) SUITES.splice(0, SUITES.length, ...SUITES.filter((s) => !MONOREPO_ONLY.includes(s.id)));
for (const s of SUITES) if (s.kind === "tap" && !s.files.length) s.needs = () => "no test files";
// The comparison suites, on each firmware. Each says what of it is compared with a bar's recordings and what is the
// emulator alone, checked against the firmware's rules: a gate run has no bar (the --bar forms are run by hand).
const COMPARISON = [
  { name: "golden", what: "still frames: draw requests and the system screens, against the bar's frames (test/golden/)" },
  { name: "api", what: "the bar's API outside apps: requests that change nothing against the bar's recorded answers (test/api/), then the emulator alone" },
  { name: "fetch", what: "an app's requests to the network, in the runtime alone; odd URLs against the bar's recorded answers (test/fetch/)" },
  { name: "power", what: "restarts, heap overflow, battery: the emulator alone, no recording of a bar" },
  { name: "settings", what: "the SETTINGS programs, screen by screen, against the bar's frames (test/settings/; frames of the bar's own state only shown)", recordings: "settings" },
  { name: "timed", what: "animations, scrolling text, countdown, OFF in time, against the bar's recordings (test/timed/)", load: true },
  { name: "speed", what: "the speed probe: the frame rate the model predicts against the bar's, and the four numbers the model was fitted to (packages/server/bar-speed.json)", load: true },
];
for (const c of COMPARISON) {
  // The public tree leaves out the bar's recordings of the SETTINGS screens as a whole (tools/export/export.json):
  // with nothing to compare, its suites are the monorepo's alone there, like board and export.
  if (exported && c.recordings && !existsSync(join(here, c.recordings))) continue;
  for (const firmware of firmwares) {
    SUITES.push({ id: `${c.name}:${firmware}`, what: `${c.what}: test/${c.name}.mjs --firmware ${firmware}`, kind: "totals", args: [`test/${c.name}.mjs`, "--firmware", firmware], load: c.load, comparison: true, images: true });
  }
}

// What no suite takes: test files the rules above do not place, scripts of test/ that are neither a suite nor a helper.
const scripts = readdirSync(here).filter((f) => f.endsWith(".mjs") && !TEST_FILE.test(f));
// What git tracks or would track but the walk above does not see (a test file in a folder named logs or .something).
const gitFiles = (() => {
  try {
    const listed = execProgram("git", ["ls-files", "-co", "--exclude-standard", "--", "."], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return listed.split("\n").filter((f) => TEST_FILE.test(f));
  } catch {
    return [];
  }
})();
const unplaced = [
  ...gitFiles.filter((f) => !files.includes(f)).map((f) => `${f} (a test file git knows that the gate's walk does not find: move it out of logs/ or a folder starting with a dot)`),
  ...files.filter((f) => !owner(f)).map((f) => `${f} (a test file in no suite: add a rule to RULES in test/gate.mjs)`),
  ...scripts.filter((f) => !HELPERS[f] && !COMPARISON.some((c) => `${c.name}.mjs` === f)).map((f) => `test/${f} (neither a comparison suite nor a helper: add it to COMPARISON or HELPERS in test/gate.mjs)`),
];

if (args.includes("--list")) {
  for (const s of SUITES) console.log(`${s.id.padEnd(16)} ${s.load ? "load-sensitive " : ""}${s.what}`);
  console.log(`\n${files.length} test files, each in one suite above${unplaced.length ? `, except:\n  ${unplaced.join("\n  ")}` : ""}`);
  for (const [f, why] of Object.entries(HELPERS)) console.log(`not a suite: test/${f} — ${why}`);
  process.exit(0);
}

const only = list("--only");
const skipped = list("--skip") ?? [];
/** Suites to leave out with their reasons, {"<suite>": "<why>"}, from an environment variable. */
function skipsFrom(name) {
  try {
    const value = JSON.parse(process.env[name] || "{}");
    if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string")) return value;
  } catch {
    // Below.
  }
  usage(`${name} is not {"<suite>": "<why>"}`);
}
// Left out by whoever runs the gate (a partial run), and left out because this machine cannot run them (gate:win: only
// app and export, only with EMU_GATE_REMOTE=windows; anything else named there is a skip on request).
const machineNamed = machineSkipsOf(skipsFrom("EMU_GATE_MACHINE_SKIP"), process.env.EMU_GATE_REMOTE);
const requestedSkips = { ...skipsFrom("EMU_GATE_SKIP"), ...machineNamed.requested };
const machineSkips = machineNamed.machine;
const skipReasons = { ...requestedSkips, ...machineSkips };
skipped.push(...Object.keys(skipReasons));
const partial = partialScope({
  only,
  comparison: args.includes("--comparison"),
  firmware: list("--firmware"),
  skip: [...(list("--skip") ?? []), ...Object.keys(requestedSkips)],
});
const machineText = Object.keys(machineSkips).length ? `without ${Object.keys(machineSkips).join(", ")}, which this machine does not run (see skipped)` : null;
const matches = (s, names) => names.some((n) => s.id === n || s.id.split(":")[0] === n);
for (const n of [...(only ?? []), ...skipped]) if (!SUITES.some((s) => matches(s, [n]))) usage(`no suite ${n} (--list names them)`);
const chosen = SUITES.filter((s) => (!only || matches(s, only)) && (!args.includes("--comparison") || s.comparison));
const results = new Map(); // id → { state: "pass"|"fail"|"skip", pass, fail, skip, ms, note, reasons, load }
// The check that every test file is in a suite comes first, whatever was chosen.
const FILES = { id: "files", what: "every test file of the tree is in a suite" };
chosen.unshift(FILES);
const placed = files.filter(owner).length;
results.set("files", { state: unplaced.length ? "fail" : "pass", pass: NaN, note: unplaced.length ? `${unplaced.length} not in any suite (listed at the start)` : `${placed} test files, each in a suite`, ms: 0 });
for (const s of chosen) {
  if (matches(s, skipped)) results.set(s.id, { state: "skip", note: skipReasons[s.id] ?? skipReasons[s.id.split(":")[0]] ?? "left out with --skip" });
  else if (s.needs?.()) results.set(s.id, { state: "skip", note: s.needs() });
}

// ---------------------------------------------------------------- where things go

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
const PREFIX = "busybar-emulator-gate-";
const runDir = option("--out") ?? mkdtempSync(join(os.tmpdir(), `${PREFIX}${stamp}-`));
mkdirSync(runDir, { recursive: true });
// Runs of the gate older than a week are removed: their logs were read or never will be.
for (const name of readdirSync(os.tmpdir())) {
  if (!name.startsWith(PREFIX) || join(os.tmpdir(), name) === runDir) continue;
  try {
    if (Date.now() - statSync(join(os.tmpdir(), name)).mtimeMs > 7 * 24 * 3600 * 1000) rmSync(join(os.tmpdir(), name), { recursive: true, force: true });
  } catch {
    // Somebody else's, or in use.
  }
}
const logOf = (s) => join(runDir, `${s.id.replace(":", "-")}.log`);

// The suites' temporary folders: one folder of the run's, short (a test builds paths of over 200 characters on it),
// in the system's temporary folder; its path is written down in the logs, for gate:win to remove it if the gate
// itself is ended before it could.
const tmpRoot = mkdtempSync(join(os.tmpdir(), "bg-"));
writeFileSync(join(runDir, "tmp-root.txt"), tmpRoot);
let tmpCount = 0;

// Locks that every gate of this user on this machine sees, whatever TMPDIR each was started with (an agent's sandbox
// sets its own): in the user's cache folder.
// EMU_GATE_LOCK_DIR: another folder, for the gate's own tests only (a real run must share the machine's).
const lockDir = process.env.EMU_GATE_LOCK_DIR
  ? process.env.EMU_GATE_LOCK_DIR
  : win
  ? join(process.env.LOCALAPPDATA || join(os.homedir(), "AppData", "Local"), "busybar-emulator-gate")
  : process.platform === "darwin"
    ? join(os.homedir(), "Library", "Caches", "busybar-emulator-gate")
    : join(process.env.XDG_CACHE_HOME || join(os.homedir(), ".cache"), "busybar-emulator-gate");
mkdirSync(lockDir, { recursive: true });

// ---------------------------------------------------------------- ports

/** Whether nobody listens on `port` of 127.0.0.1 or of every address, and this process can take it. */
function free(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
  });
}

const locks = [];
/**
 * `count` free ports in a row for a suite that needs fixed ones (the shell's tests): a range from 20000 to 47999 —
 * below the systems' ephemeral ports — that is free now and that no other gate on this machine holds (a lock file in
 * lockDir, removed at the end).
 */
async function portRange(count) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = 20000 + Math.floor(Math.random() * 2800) * 10;
    const lock = join(lockDir, `ports-${first}.lock`);
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
    } catch {
      continue;
    }
    let ok = true;
    for (let p = first; p < first + count && ok; p++) ok = await free(p);
    if (ok) {
      locks.push(lock);
      return `${first}-${first + count - 1}`;
    }
    rmSync(lock, { force: true });
  }
  throw new Error(`no ${count} free ports in a row found`);
}
// Locks of gates that are gone are taken away.
for (const name of readdirSync(lockDir)) {
  if (!name.startsWith("ports-")) continue;
  try {
    process.kill(Number(readFileSync(join(lockDir, name), "utf8")), 0);
  } catch (e) {
    if (e.code !== "EPERM") rmSync(join(lockDir, name), { force: true });
  }
}

// ---------------------------------------------------------------- the machine's load

/** The machine's CPU time so far, all cores: { busy, total } in ms. */
function cpuTimes() {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.idle + times.irq;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

/** Samples the machine's load every second until stopped; returns { mean, max, loadBefore, loadAfter } (percent of all cores). */
function watchLoad() {
  const samples = [];
  const loadBefore = os.loadavg()[0];
  let last = cpuTimes();
  const timer = setInterval(() => {
    const now = cpuTimes();
    if (now.total > last.total) samples.push((100 * (now.busy - last.busy)) / (now.total - last.total));
    last = now;
  }, 1000);
  return () => {
    clearInterval(timer);
    const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
    return { mean, max: samples.length ? Math.max(...samples) : null, loadBefore, loadAfter: os.loadavg()[0] };
  };
}
const loadText = (l) =>
  l.mean === null
    ? "too short to measure"
    : `CPU busy mean ${Math.round(l.mean)} %, max ${Math.round(l.max)} % of ${cores} cores` + (win ? "" : `; load average ${l.loadBefore.toFixed(1)} → ${l.loadAfter.toFixed(1)}`);

// ---------------------------------------------------------------- running a suite

const running = new Map(); // id → child
let interrupted = false;

/**
 * Stops a suite so that its own clean-up runs where the system lets it: on macOS and Linux SIGINT to the test process
 * alone, then SIGTERM to its group, then SIGKILL; each after a pause, if it is still running. Windows has no signal to
 * send: the tree is ended at once, and what its exit handlers would have removed goes with the suite's folder.
 */
async function softStop(child, exited) {
  const wait = (ms) => Promise.race([exited, new Promise((r) => setTimeout(r, ms))]);
  if (!win) {
    try {
      process.kill(child.pid, "SIGINT");
    } catch {
      // Gone already.
    }
    await wait(5000);
    killTree(child, "SIGTERM");
    await wait(5000);
  }
  killTree(child, "SIGKILL");
}

/** Ends a suite's process and everything it started: its process group (macOS, Linux) or its tree (Windows), by its PID. */
function killTree(child, signal = "SIGTERM") {
  if (win) {
    // A tree is found through a living parent only; what an ended one left is found by endStrays.
    if (child.exitCode !== null || child.signalCode !== null) return;
    // By full path: a taskkill.exe lying in the current folder must not run instead.
    try {
      execProgram(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      // Gone already.
    }
  } else {
    // The group outlives its first process while any member runs.
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Gone already.
    }
  }
}

function counts(s, text) {
  if (s.kind === "tap") return tallyTap(text, s.files);
  if (s.kind === "totals") return tallyTotals(text);
  if (s.kind === "export") return tallyExport(text);
  return { pass: NaN, fail: NaN, skip: NaN };
}

/**
 * The processes whose command line holds one of `markers` (a suite's temporary folder, the shell's node_modules):
 * what a suite started and left, also outside its process group (an app a test starts in a group of its own, as
 * busy-emulator start does). Ended by their PIDs; never by a program's name. Returns how many.
 */
function endStrays(markers) {
  let listed = "";
  try {
    listed = win
      ? execProgram(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", "$ProgressPreference='SilentlyContinue'; Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
      : execProgram("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return 0;
  }
  let ended = 0;
  for (const row of listed.split(/\r?\n/)) {
    const m = row.match(win ? /^(\d+)\t(.*)$/ : /^\s*(\d+)\s+(.*)$/);
    if (!m || Number(m[1]) === process.pid || !markers.some((marker) => m[2].includes(marker))) continue;
    ended++;
    if (win) {
      try {
        execProgram(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", m[1], "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        // Gone already.
      }
    } else {
      try {
        process.kill(Number(m[1]), "SIGKILL");
      } catch {
        // Gone already.
      }
    }
  }
  return ended;
}

const removeFolder = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Reported by whoever looks: the folder is named in the logs.
  }
};

/**
 * Holds a lock that every gate on this machine respects (a file in lockDir with the holder's PID; a
 * holder that is gone does not count). Waits for it, saying so once. Returns the function that lets it go, or null
 * when the gate is stopped while it waits: the suite must not run then, since another gate holds the lock.
 */
async function machineLock(name) {
  const file = join(lockDir, `lock-${name}`);
  let said = false;
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      locks.push(file);
      return () => {
        rmSync(file, { force: true });
        locks.splice(locks.indexOf(file), 1);
      };
    } catch {
      let holder = NaN;
      let text = "";
      let ageMs = 0;
      try {
        text = readFileSync(file, "utf8");
        ageMs = Date.now() - statSync(file).mtimeMs;
        holder = Number(text.trim());
      } catch {
        continue; // let go of meanwhile: try again
      }
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (e) {
          return e.code !== "ESRCH";
        }
      };
      if (lockIsStale(text, { alive, ageMs })) {
        rmSync(file, { force: true });
        continue;
      }
      if (interrupted) return null;
      if (!said) console.log(`        waiting: another gate (PID ${holder}) runs its ${name === "load" ? "load-sensitive suites" : `${name} suite`}`);
      said = true;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const lockWaits = []; // { id, lock, ms }: how long each suite waited for a machine lock
async function run(s) {
  // One at a time across every gate of the machine: the load-sensitive suites, and suites that share the machine's state.
  const name = s.load || s.machineLock ? (s.machineLock ?? "load") : null;
  const t0 = Date.now();
  const release = name ? await machineLock(name) : () => {};
  const waited = Date.now() - t0;
  if (name) lockWaits.push({ id: s.id, lock: name, ms: waited });
  if (!release) {
    // Stopped while another gate held the lock: never run without it.
    const result = { state: "skip", note: `not run: the gate was stopped while it waited ${secs(waited)} for the ${name} lock` };
    results.set(s.id, result);
    console.log(line(s, result));
    return result;
  }
  if (interrupted) {
    release();
    const result = { state: "skip", note: "not run: the gate was stopped" };
    results.set(s.id, result);
    return result;
  }
  if (waited >= 1000) console.log(`        ${s.id}: waited ${secs(waited)} for the ${name} lock`);
  try {
    return await runHeld(s);
  } finally {
    release();
  }
}

async function runHeld(s) {
  const env = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  // Ports a person set for their own runs would make suites that run side by side take the same ones.
  delete env.EMU_TEST_PORTS;
  delete env.BUSY_APP_TEST_PORTS;
  if (s.images) env.EMU_TEST_OUT = join(runDir, s.id.replace(":", "-"));
  // A temporary folder of the suite's own: what it leaves there is seen, and removed with it.
  const tmp = join(tmpRoot, String(++tmpCount));
  mkdirSync(tmp);
  env.TMPDIR = env.TEMP = env.TMP = tmp;
  let ports = null;
  if (s.ports) env.BUSY_APP_TEST_PORTS = ports = await portRange(s.ports);
  const events = join(runDir, `${s.id.replace(":", "-")}.tests.jsonl`);
  const args = s.args.map((a) => (a === EVENTS ? `--test-reporter-destination=${events}` : a));
  const log = openSync(logOf(s), "w");
  writeFileSync(log, `node ${args.join(" ")}\n(in ${s.cwd ?? root}${ports ? `, ports ${ports}` : ""})\n\n`);
  const t0 = Date.now();
  const stopLoad = s.load ? watchLoad() : null;
  const child = spawn(process.execPath, args, { cwd: s.cwd ?? root, env, stdio: ["ignore", log, log], detached: !win, windowsHide: true });
  const exited = new Promise((resolve) => child.once("exit", (c, signal) => resolve(c ?? signal)));
  child.softStop = () => softStop(child, exited);
  running.set(s.id, child);
  // EMU_GATE_TIMEOUT_S: a shorter limit for every suite, for the gate's own test of a suite that hangs.
  const limit = process.env.EMU_GATE_TIMEOUT_S ? Number(process.env.EMU_GATE_TIMEOUT_S) * 1000 : (s.timeout ?? 20) * 60 * 1000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.softStop();
  }, limit);
  const code = await exited;
  clearTimeout(timer);
  // What it started and left behind: its group (a test runner's children), then whatever names its folders.
  killTree(child, "SIGKILL");
  const strays = endStrays([tmp + sep, ...(s.strays ?? [])]);
  running.delete(s.id);
  closeSync(log);
  // What the runtime keeps there by itself is no test's leftover: Node's compile cache, which npm turns on and which
  // goes to the temporary folder unless NODE_COMPILE_CACHE names another (Node 24 on Windows); the two files
  // PowerShell writes there to try its execution policy (__PSScriptPolicyTest_<random>.ps1 and .psm1).
  const runtimeCache = (name) => name === "node-compile-cache" || /^__PSScriptPolicyTest_[\w.]+\.psm?1$/.test(name);
  const left = existsSync(tmp) ? readdirSync(tmp).filter((name) => !runtimeCache(name)) : [];
  removeFolder(tmp);
  const ms = Date.now() - t0;
  const load = stopLoad?.();
  const text = readFileSync(logOf(s), "utf8");
  const c = counts(s, text);
  // Tests a file registered that never finished: its process ended midway, which TAP does not show.
  if (s.kind === "tap" && code === 0 && !timedOut && !interrupted) {
    const unfinished = tallyEvents(existsSync(events) ? readFileSync(events, "utf8") : null);
    c.problems = [...(c.problems ?? []), ...unfinished];
    c.fail += unfinished.length;
  }
  let state = code === 0 && !timedOut ? "pass" : "fail";
  let note = "";
  if (timedOut) {
    // The files still running: a file that loops synchronously is ended by nothing but this limit.
    const stuck = s.kind === "tap" && existsSync(events) ? stillRunning(readFileSync(events, "utf8")).map((f) => relative(s.cwd ?? root, f).split(sep).join("/")) : [];
    note = `TIMED OUT: stopped after ${secs(limit)}${stuck.length ? `; still running: ${stuck.join(", ")}` : ""}`;
  }
  else if (interrupted) note = "stopped";
  else if (code !== 0 && s.kind === "export" && code === 3) note = "the private patterns' fingerprint key is missing or another (export-check.mjs exit 3)";
  else if (code !== 0) note = `exit code ${code}`;
  if (s.kind !== "exit" && Number.isNaN(c.pass)) {
    state = "fail";
    note ||= "no totals in its output";
    if (code === 0) note = "exit code 0 but no totals in its output";
  } else if (state === "pass" && (c.fail > 0 || c.pass + c.fail === 0)) {
    state = "fail";
    note = c.fail ? `${c.fail} failed with exit code 0` : "nothing was checked";
  }
  // Tests leave nothing behind (quality.md): not after a run that ended by itself.
  const leftovers = [];
  if (!timedOut && !interrupted && left.length) leftovers.push(`left in its temporary folder: ${left.slice(0, 5).join(", ")}${left.length > 5 ? ` and ${left.length - 5} more` : ""}`);
  if (!timedOut && !interrupted && strays) leftovers.push(`left ${strays} processes running (ended by PID)`);
  if (leftovers.length) {
    state = "fail";
    note = [note, ...leftovers].filter(Boolean).join("; ");
  }
  const result = { state, ...c, ms, note, load, code, ports, images: s.images && existsSync(env.EMU_TEST_OUT) ? env.EMU_TEST_OUT : null };
  results.set(s.id, result);
  console.log(line(s, result));
  if (load) console.log(`        load: ${loadText(load)}`);
  for (const p of c.problems ?? []) console.log(`        ${p}`);
  if (state === "fail") console.log(`        log: ${logOf(s)}`);
  return result;
}

const secs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);
function countText(r) {
  if (r.state === "skip") return `skipped: ${r.note}`;
  if (Number.isNaN(r.pass)) return r.note || (r.state === "pass" ? "exit code 0" : "");
  const unit = r.unit ? ` ${r.unit}` : "";
  const parts = [`${r.pass}${unit} passed`];
  if (r.fail) parts.push(`${r.fail} failed`);
  if (r.skip) parts.push(`${r.skip} skipped`);
  return parts.join(", ") + (r.note ? `; ${r.note}` : "");
}
function line(s, r) {
  const label = { pass: "ok  ", fail: "FAIL", skip: "skip" }[r.state];
  return `  ${label}  ${s.id.padEnd(16)} ${countText(r).padEnd(44)} ${r.ms === undefined ? "" : secs(r.ms).padStart(9)}`;
}

// ---------------------------------------------------------------- the run

function git(...a) {
  try {
    return execProgram("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
const commit = git("rev-parse", "--short=12", "HEAD");
const dirty = commit && git("status", "--porcelain", "--", ".") ? " with uncommitted changes" : "";
const bundled = (() => {
  try {
    return JSON.parse(readFileSync(join(appDir, "bundled-node.json"), "utf8")).version;
  } catch {
    return null;
  }
})();
const system = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] ?? process.platform;
const scopeText = partial ? ` — PARTIAL RUN, not the gate: ${partial}` : machineText ? ` — ${machineText}` : "";
console.log(`gate: emulator${exported ? " (the exported public tree)" : ""} ${commit ?? "(not a git checkout)"}${dirty} on ${system} ${os.release()} ${process.arch}, ${cores} cores, Node ${process.versions.node}${bundled && bundled !== process.versions.node ? ` (the app bundles ${bundled})` : ""}${scopeText}`);
console.log(`logs: ${runDir}`);
console.log(`suites: ${chosen.length}, first phase ${jobs} at a time, then the load-sensitive ones one by one; firmwares ${firmwares.join(", ")}`);
if (!win) console.log(`machine before the run: load average ${os.loadavg()[0].toFixed(1)} on ${cores} cores`);
console.log(line(FILES, results.get("files")));
for (const u of unplaced) console.log(`        not in any suite: ${u}`);
for (const s of chosen) if (results.get(s.id)?.state === "skip") console.log(line(s, results.get(s.id)));

function stop(why) {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log(`\ngate: ${why}: stopping ${running.size} running suites`);
  for (const child of running.values()) child.softStop();
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stop(signal));
// Run from another machine (gate:win): when the connection goes, stdin ends, and the gate stops what it started.
if (args.includes("--exit-with-stdin")) {
  process.stdin.on("end", () => stop("the connection closed"));
  process.stdin.resume();
}
process.on("exit", () => {
  for (const lock of locks) rmSync(lock, { force: true });
});

const toRun = chosen.filter((s) => !results.has(s.id));
// The first phase, longest first so that the slow ones do not start last.
const ORDER = ["settings", "unit", "app", "power", "golden", "server", "tools", "tests", "api", "fetch", "export", "board"];
const first = toRun.filter((s) => !s.load).sort((a, b) => ORDER.indexOf(a.id.split(":")[0]) - ORDER.indexOf(b.id.split(":")[0]));
const second = toRun.filter((s) => s.load);
if (first.length) console.log("\nfirst phase");
await new Promise((resolve) => {
  let next = 0;
  let active = 0;
  const pump = () => {
    while (!interrupted && active < jobs && next < first.length) {
      active++;
      run(first[next++]).finally(() => {
        active--;
        pump();
      });
    }
    if (active === 0 && (next >= first.length || interrupted)) resolve();
  };
  pump();
});
if (second.length && !interrupted) console.log("\nload-sensitive, one at a time");
for (const s of second) {
  if (interrupted) break;
  await run(s);
}
for (const s of chosen) if (!results.has(s.id)) results.set(s.id, { state: "skip", note: "not run: the gate was stopped" });

// ---------------------------------------------------------------- summary

const all = chosen.map((s) => ({ s, r: results.get(s.id) }));
const failed = all.filter(({ r }) => r.state === "fail");
console.log("\nsummary");
console.log(`  ${"result".padEnd(4)}  ${"suite".padEnd(16)} ${"checks".padEnd(44)} ${"time".padStart(9)}`);
for (const { s, r } of all) console.log(line(s, r));
// Tests skipped inside the suites, by reason: the allowed ones by the layer that did not run here and where it runs;
// the rest count against the verdict.
const reasonCounts = new Map();
const reasonSuites = new Map();
for (const { s, r } of all) {
  for (const [why, n] of r.reasons ?? []) {
    reasonCounts.set(why, (reasonCounts.get(why) ?? 0) + n);
    reasonSuites.set(why, [...(reasonSuites.get(why) ?? []), s.id]);
  }
}
// The release's run (npm run release, stage 3): the tests of the release's own files must run, not skip.
const sorted = sortSkips(reasonCounts, { exported, release: process.env.EMU_GATE_RELEASE === "1", appLeftOut: "app" in machineSkips });
const unexpectedTests = sorted.unexpected.reduce((sum, [, n]) => sum + n, 0);
const skippedSuites = all.filter(({ r }) => r.state === "skip");
const ranSuites = all.filter(({ s, r }) => r.state !== "skip" && s !== FILES);
console.log(`\nlayers that ran: ${ranSuites.map(({ s }) => s.id).join(", ") || "none"}`);
if (sorted.allowed.length) console.log("layers that did not run here (tests skipped for an allowed reason; where each runs):");
for (const l of sorted.allowed) {
  console.log(`  ${l.layer}: ${l.count} tests; ${l.where}`);
  for (const [why, n] of l.reasons) console.log(`      ${n} — ${why} (${[...new Set(reasonSuites.get(why))].join(", ")})`);
}
const byMachine = ({ s }) => Object.hasOwn(machineSkips, s.id) || Object.hasOwn(machineSkips, s.id.split(":")[0]);
if (skippedSuites.some(byMachine)) console.log("\nleft out by this machine (gate:win; the Mac's gate runs them)");
for (const { s, r } of skippedSuites.filter(byMachine)) console.log(`  ${s.id}: ${r.note}`);
const counted = skippedSuites.filter((x) => !byMachine(x));
if (counted.length || sorted.unexpected.length) console.log("\nskipped, and counted against the verdict");
for (const { s, r } of counted) console.log(`  ${s.id}: the whole suite — ${r.note}`);
for (const [why, n] of sorted.unexpected) console.log(`  ${[...new Set(reasonSuites.get(why))].join(", ")}: ${n} tests — ${why} (not on the list of allowed reasons, test/gate-lib.mjs ALLOWED_SKIPS)`);
if (lockWaits.some((w) => w.ms >= 1000)) console.log("\nwaits for the machine's locks (other gates of this machine held them)");
for (const w of lockWaits.filter((x) => x.ms >= 1000)) console.log(`  ${w.id.padEnd(16)} ${secs(w.ms)} for the ${w.lock} lock`);
const loads = all.filter(({ r }) => r.load);
if (loads.length) console.log("\nmachine load during the load-sensitive suites (all processes of the machine)");
for (const { s, r } of loads) console.log(`  ${s.id.padEnd(16)} ${loadText(r.load)}`);
const pictures = all.filter(({ r }) => r.images);
if (pictures.length) console.log(`\npictures and the emulators' logs: ${runDir} (a folder per suite${process.env.EMU_GATE_REMOTE ? "; gate:win copies it back and removes it here" : ""})`);
// The suites' temporary folders: whatever a stopped suite left, with the processes that name them.
endStrays([tmpRoot + sep]);
removeFolder(tmpRoot);
const verdict = verdictOf({ interrupted, failed: failed.map(({ s }) => s.id), partial, machine: machineText, skippedSuites: counted.map(({ s }) => s.id), unexpectedTests });
console.log(`\ntotal ${secs(Date.now() - started)}: ${all.filter(({ r }) => r.state === "pass").length} passed, ${failed.length} failed, ${skippedSuites.length} skipped — ${verdict.text} (exit code ${verdict.code})`);
console.log(`logs: ${runDir}`);
process.exit(verdict.code);
