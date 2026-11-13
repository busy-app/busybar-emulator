#!/usr/bin/env node
// The smoke test of a built app (EMU-017): the app as built is started through the command line inside it, an app is
// installed on its bar and run, and the front display's frame is compared with the expected one. On the way it checks
// that nothing in the app reaches past this machine (ADR-0014), measures the app's size and checks by a list that the
// app holds no tests, engine build sources or development dependencies.
//
//   npm run smoke [-- <app>] [--port <n>] [--keep]
//   node test/smoke.mjs [<app>] [--port <n>] [--keep]
//
// <app> is the test variant `npm run dist -- --kind test` builds (packages/app/README.md): BUSY Bar Emulator.app on
// macOS, the folder that holds BUSY Bar Emulator.exe on Windows. Without it, the one in the build's default output.
// On a Mac with Apple Silicon the test variant for Intel Macs (`--kind test --arch x64`) is run as well, under
// Rosetta: the test says so, and that start is slow (the first one of a new build waits for the translation).
// --port is the emulated bar's port, 8770 by default. --keep leaves the temporary folder (data folder, home, frames,
// Chromium's network log) and prints where it is.
//
// The app is driven through its command line only — `busy-emulator start`, `status`, `screenshot`, `record` (a GIF and
// an MP4), `mcp` (initialize and tools/list), `quit` — and through
// the bar's own HTTP API, as an author's tools reach the bar (the command line has no install or run yet); the test
// entry of the test variant is not connected. So the same steps fit the release files, but a release cannot be run
// here: it takes the user's own data folder, writes ~/.busy-emulator and the pointer file and listens on 8640 (a
// release reads no BUSY_EMULATOR_* variable, ADR-0016). Of a release the test checks what needs no start — its
// contents and size — and ends with exit code 2 (1 if one of those failed).
//
// Everything the app writes goes to a temporary folder: the data folder (BUSY_EMULATOR_DATA), the folder that stands
// for the home (BUSY_EMULATOR_USER_HOME, and HOME on macOS, LOCALAPPDATA on Windows) — the launcher and the pointer
// file land there. Before and after, the test looks at the user's own data folder and launcher and fails if either
// changed (and the folder of each, its top level). Windows are made but never shown (BUSY_EMULATOR_HIDDEN=1); on macOS the app's icon may show in the Dock for
// a moment before its code runs.
//
// The command line starts the app as the test variant allows (BUSY_EMULATOR_TEST_LAUNCH: the app's executable,
// directly), not through Launch Services or Explorer, which would not hand the app this environment. It is given
// Chromium's --log-net-log, which records what Chromium asks of the network — but since EMU-236 the release and the
// test variant remove every Chromium switch they are given (packages/app/src/main.mjs, ADR-0016), so the log is
// written only by a build that keeps it (before 11.11).
//
// What "no outgoing connection" rests on, and how far it goes:
//   1. Chromium's network log, when there is one: every request, name lookup and connection of the app's Chromium
//      (window, pages, network service). Complete for Chromium as long as the log is closed; on Windows `quit` ends
//      the process, and the events of its last moments may be missing. Without it, Chromium is covered by the list of
//      sockets alone (and, not observed here, by the shell's own rule that resolves no name: host-resolver-rules).
//   2. The system's list of sockets (lsof on macOS, netstat on Windows), sampled for every process whose executable
//      lies in the app — Chromium, the bundled Node with the supervisor, the server and the command line: anything
//      connected, connecting, listening or bound beyond 127.0.0.1 and ::1. A socket that lives for less than a sample
//      (about 0.05 s on both systems, measured 11.11) can be missed, and so can a process that lives for less than a
//      listing of the processes.
//   A UDP socket that is only connected sends nothing; Chromium connects one to 2001:4860:4860::8888 to learn whether
//   IPv6 works. It is printed apart and is no failure as long as Chromium's log shows no datagram on it.
//   The app's own JS reaches the bar's API at localhost, which the runtime serves inside the server, without a socket.
//   Not seen: on macOS Node's name lookups (dns.lookup, which fetch uses) go to mDNSResponder, so a lookup by the
//   server or the command line is no socket of the app's, and Chromium's log does not cover Node; processes the app
//   starts from outside its bundle (/usr/bin/open, ps) are not watched.
//
// Stopped by Ctrl+C, SIGTERM or SIGHUP, the test goes no further: it ends the commands of the app's it has going, quits
// the app, removes its temporary folder and ends with exit code 130, once every process it started is gone: the app
// runs on its own, and only the test knows its data folder.
//
// Exit code 0: every check passed; 1: a check failed; 2: a wrong call or an app this test cannot run; 130: stopped.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { spawnProgram } from "../packages/engine/programs.mjs";
import { commandLine } from "../packages/server/arguments.mjs";
import { targz } from "./package.mjs";
import {
  archOfProgram,
  asarFiles,
  defaultTestVariant,
  differingPixels,
  filesBelow,
  forbiddenFiles,
  layoutOf,
  mb,
  parseLsof,
  parseNetstat,
  pastThisMachine,
  readNetLog,
  wildcard,
  readPng,
  releaseFilesOf,
  sizeOf,
} from "./smoke/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_APP = "app.busy.smoke";
/** Where Chromium's IPv6 reachability check connects a UDP socket, sending nothing (net/dns, kIPv6ProbeAddress). */
const IPV6_PROBE = "[2001:4860:4860::8888]:443";
const appSource = path.join(here, "smoke", SMOKE_APP);
const expectedPng = path.join(here, "smoke", "front.png");
const win = process.platform === "win32";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line) => console.log(`smoke: ${line}`);

// ---------------------------------------------------------------- the call

function usage(message) {
  console.error(`smoke: ${message}\nusage: node test/smoke.mjs [<app>] [--port <n>] [--keep]`);
  process.exit(2);
}
await commandLine(process.argv, { values: ["--port"], flags: ["--keep"], positionals: true });
const argv = process.argv.slice(2);
let appArg = null;
let port = 8770;
let keep = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--keep") keep = true;
  else if (a === "--port") {
    const value = argv[++i];
    if (!/^\d{1,5}$/.test(value ?? "") || Number(value) < 1024 || Number(value) > 65535) usage("--port needs a port from 1024 to 65535");
    port = Number(value);
  } else if (a.startsWith("-")) usage(`unknown option ${a}`);
  else if (appArg === null) appArg = a;
  else usage(`one app only, not also ${a}`);
}
if (!["darwin", "win32"].includes(process.platform)) usage(`there is no app for ${process.platform}`);

// The user's own home, from the system's account, not from HOME: the place a release would write to.
const systemHome = os.userInfo().homedir;
const localAppData = win ? process.env.LOCALAPPDATA || path.win32.join(systemHome, "AppData", "Local") : null;
const app = path.resolve(appArg ?? defaultTestVariant({ home: systemHome, localAppData }));
const layout = layoutOf(app);
if (!existsSync(layout.exe) || !existsSync(layout.cli)) {
  usage(`${app} is not a built app (no ${path.relative(app, existsSync(layout.exe) ? layout.cli : layout.exe)}). Build one: npm run dist -- --kind test --allow-uncommitted in packages/app`);
}
let marker;
try {
  marker = JSON.parse(readFileSync(path.join(layout.resources, "build.json"), "utf8"));
} catch (e) {
  usage(`${app} has no readable build.json in its resources (${e.code ?? e.message}): not a build of packages/app/tools/dist.mjs`);
}
const failures = [];
const fail = (line) => {
  failures.push(line);
  say(`FAIL ${line}`);
};
// The app's architecture, from its own executable and its Node; on Apple Silicon an app for Intel runs under Rosetta
// (slower, and its first start waits for the translation). An app this machine cannot run is refused before any start.
const arch = archOfProgram(layout.exe);
const nodeArch = archOfProgram(path.join(layout.resources, "node", win ? "node.exe" : path.join("bin", "node")));
const translated = !win && arch === "x64" && process.arch === "arm64";
say(
  `app ${app} (${marker.kind === "test" ? "test variant" : marker.kind} ${marker.version}, commit ${String(marker.commit).slice(0, 12)}, Node ${marker.node}, ` +
    `for ${process.platform} ${arch ?? "an unknown architecture"}${translated ? ", run here under Rosetta" : ""})`,
);
if (!win && !["arm64", "x64"].includes(arch)) fail(`the app's executable is for ${arch ?? "no Mac"}: a build is for arm64 or for x64`);
if (nodeArch !== arch) fail(`the bundled Node is for ${nodeArch ?? "an unknown architecture"}, the app for ${arch ?? "an unknown architecture"}`);
if (!win && arch === "arm64" && process.arch !== "arm64") usage(`${app} is for Apple Silicon; this Mac (${process.arch}) cannot run it`);

// ---------------------------------------------------------------- what is in the app

let archiveFiles = [];
{
  const parts = [];
  const asar = path.join(layout.resources, "app.asar");
  if (existsSync(asar)) parts.push({ name: "app.asar", files: (archiveFiles = asarFiles(asar)) });
  else fail("there is no app.asar in the app's resources");
  for (const name of ["app.asar.unpacked", "emulator", "bin"]) {
    const folder = path.join(layout.resources, name);
    if (existsSync(folder)) parts.push({ name: `resources/${name}`, files: filesBelow(folder) });
  }
  if (!parts.some((p) => p.name === "resources/emulator")) fail("there is no emulator folder in the app's resources");
  const pkg = JSON.parse(readFileSync(path.join(here, "..", "packages", "app", "package.json"), "utf8"));
  const devDependencies = Object.keys(pkg.devDependencies ?? {});
  const found = forbiddenFiles(parts, { devDependencies, kind: marker.kind });
  const counted = parts.map((p) => `${p.name} ${p.files.length}`).join(", ");
  if (found.length) {
    for (const f of found.slice(0, 20)) fail(`${f.what} in the app: ${f.part}/${f.file}`);
    if (found.length > 20) fail(`and ${found.length - 20} more files that must not be in the app`);
  } else {
    say(`contents: no tests, engine build sources or development dependencies (${devDependencies.join(", ")}) among ${counted} files`);
  }
}

// ---------------------------------------------------------------- size

{
  const { bytes, files } = sizeOf(app);
  // quality.md, the table of budgets: no limit on the download since 10.11; the size is recorded at every build. EMU-200 measured
  // the zip of the app at 193 MB (macOS arm64) and 224 MB (Windows x64); the first build for Intel Macs (11.11) was 186 MB.
  const reference = win ? 224e6 : arch === "x64" ? 186e6 : 193e6;
  const release = path.join(path.dirname(path.dirname(path.dirname(app))), "release");
  const own = releaseFilesOf(process.platform, arch);
  const download = own.filter((f) => existsSync(path.join(release, f))).map((f) => `${f} ${mb(statSync(path.join(release, f)).size)}`);
  say(
    `size: the app ${mb(bytes)} in ${files} files unpacked${marker.kind === "test" ? " (the test variant: the release and its test entry)" : ""}` +
      (download.length ? `; release files beside it: ${download.join(", ")}` : "; no release files beside it to weigh") +
      `. Budget: none (lifted 10.11, quality.md); for reference the ${!win && arch === "x64" ? "zip of the first Intel build" : "EMU-200 zip"} was ${mb(reference)}`,
  );
}

// A release: what can be checked without starting it is checked above; it is not started. The marker beside the
// resources says "test", and so must what the app itself goes by: its test entry inside the archive (build-kind.mjs,
// main.mjs). An app whose two disagree is not started either.
const testEntry = archiveFiles.some((f) => f.startsWith("test-variant/"));
if (marker.kind === "test" && !testEntry) {
  fail("build.json says test variant, but the app's archive has no test-variant/: the app would run as a release, on the user's own folders");
}
if (marker.kind !== "test" || !testEntry) {
  say(
    `not started: ${marker.kind === "test" ? "this app runs as a release" : marker.kind === "release" ? "this is a release" : `this is a build of kind "${marker.kind}"`}. A release takes the user's own data folder, writes the launcher at ~/.busy-emulator ` +
      `(%LOCALAPPDATA%\\busy-emulator on Windows) and the pointer file, and listens on 8640: it reads no BUSY_EMULATOR_* variable, so it cannot be run apart from the ` +
      `user's own emulator. Build the test variant (npm run dist -- --kind test in packages/app) and run this on it.`,
  );
  say(failures.length ? `${failures.length} check(s) failed` : "the checks without a start passed; the app was not run");
  process.exit(failures.length ? 1 : 2);
}

// ---------------------------------------------------------------- the user's own places, before

// The user's own data folder and the folder of the launcher (their top level: an entry made, removed or replaced there
// changes it), the pointer file and the launcher. A release writes all of them at every start.
const userDataDir = win ? path.win32.join(localAppData, "BUSY Bar Emulator") : path.join(systemHome, "Library", "Application Support", "BUSY Bar Emulator");
const userLauncher = win ? path.win32.join(localAppData, "busy-emulator", "bin", "busy-emulator.exe") : path.join(systemHome, ".busy-emulator", "bin", "busy-emulator");
const userPlaces = [userDataDir, path.join(userDataDir, "install.json"), path.dirname(userLauncher), userLauncher];
const placeState = () =>
  userPlaces.map((file) => {
    try {
      const s = statSync(file);
      return `${file} ${s.size} ${s.mtimeMs}`;
    } catch {
      return `${file} absent`;
    }
  });
const placesBefore = placeState();

// ---------------------------------------------------------------- the app's processes and sockets

/** What a program (always named by its full path) prints, whatever its exit code: lsof ends with one when a process on its list is gone. */
function output(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawnProgram(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"], ...options });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.on("error", () => resolve(stdout));
    child.on("close", () => resolve(stdout));
  });
}
const systemRoot = win ? (process.env.SystemRoot && path.win32.isAbsolute(process.env.SystemRoot) ? process.env.SystemRoot : "C:\\Windows") : null;
const powershell = win ? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
const inApp = (exe) => {
  if (!exe) return false;
  const prefix = app + path.sep;
  return win ? exe.toLowerCase().startsWith(prefix.toLowerCase()) : exe.startsWith(prefix);
};

// Windows: every process with its executable, from WMI, which names it for the sandboxed processes of Chromium too
// (Get-Process does not: their path is closed to the caller).
const WINDOWS_PROCESSES =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Property ProcessId,ExecutablePath | Where-Object { $_.ExecutablePath } | ForEach-Object { [Console]::Out.WriteLine(\"$($_.ProcessId)|$($_.ExecutablePath)\") }";

/** The processes whose executable lies in the app, { pid: exe }. */
async function appProcesses() {
  const found = new Map();
  if (win) {
    for (const line of (await output(powershell, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESSES])).split(/\r?\n/)) {
      const [pid, exe] = line.trim().split("|");
      if (inApp(exe)) found.set(Number(pid), exe);
    }
  } else {
    for (const line of (await output("/bin/ps", ["-axo", "pid=,comm="], { env: { LC_ALL: "C", LC_CTYPE: "UTF-8" } })).split("\n")) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (match && inApp(match[2])) found.set(Number(match[1]), match[2]);
    }
  }
  return found;
}

/**
 * Samples the sockets of the app's processes until stopped: the list of processes in one loop (on Windows through
 * PowerShell, which is slow), the sockets of those known so far in another, as often as the system answers.
 */
function watch() {
  const seen = new Map(); // pid -> exe
  const reached = new Map(); // text -> first pid
  const udpConnected = new Map(); // remote -> first pid: sends nothing unless datagrams go (Chromium's log says)
  // Windows: netstat names no remote for UDP, so a connected UDP socket shows as bound to the address the system gave
  // it — one of this machine's own, beyond loopback. Kept apart, to be matched with Chromium's log.
  const udpOwnAddress = new Map(); // local -> first pid
  const listening = new Set();
  let samples = 0;
  let first = 0;
  let last = 0;
  let stopped = false;
  const record = (sockets) => {
    samples++;
    last = Date.now();
    if (!first) first = last;
    for (const s of sockets) {
      const past = pastThisMachine(s);
      if (past && s.protocol === "UDP" && s.remote) {
        if (!udpConnected.has(s.remote)) udpConnected.set(s.remote, s.pid);
      } else if (past && s.protocol === "UDP" && !wildcard(s.local)) {
        const own = udpOwnAddress.get(s.local) ?? { pid: s.pid, samples: 0 };
        own.samples++;
        udpOwnAddress.set(s.local, own);
      } else if (past) {
        if (!reached.has(past)) reached.set(past, s.pid);
      } else if (s.state === "LISTEN" || s.state === "LISTENING") listening.add(s.local);
    }
  };
  // macOS: ps, a few hundredths of a second each. Windows: one PowerShell that lists the processes again and again,
  // since starting one takes longer than the start of the app; it ends by itself when this process is gone.
  let lister = null;
  const processes = win
    ? new Promise((resolve) => {
        lister = spawnProgram(powershell, ["-NoProfile", "-NonInteractive", "-Command", `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { ${WINDOWS_PROCESSES}; Start-Sleep -Milliseconds 100 }`], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        let rest = "";
        lister.stdout.setEncoding("utf8").on("data", (chunk) => {
          const lines = (rest + chunk).split(/\r?\n/);
          rest = lines.pop();
          for (const line of lines) {
            const [pid, exe] = line.trim().split("|");
            if (inApp(exe)) seen.set(Number(pid), exe);
          }
        });
        lister.on("exit", resolve);
        lister.on("error", resolve);
      })
    : (async () => {
        while (!stopped) {
          for (const [pid, exe] of await appProcesses()) seen.set(pid, exe);
          await sleep(20);
        }
      })();
  const sockets = (async () => {
    const netstat = win ? path.win32.join(systemRoot, "System32", "NETSTAT.EXE") : null;
    while (!stopped) {
      const pids = new Set(seen.keys());
      if (!pids.size) await sleep(20);
      else if (win) record(parseNetstat(await output(netstat, ["-ano"]), pids));
      else record(parseLsof(await output("/usr/sbin/lsof", ["-nP", "-a", "-p", [...pids].join(","), "-i", "-F", "pfPnT"])));
    }
  })();
  const named = (pid) => `${path.basename(seen.get(pid) ?? String(pid))} (${pid})`;
  let stopping = null;
  return {
    stop() {
      stopping ??= (async () => {
        stopped = true;
        lister?.kill();
        await Promise.all([processes, sockets]);
        return {
          samples,
          every: samples > 1 ? (last - first) / (samples - 1) : null,
          reached: [...reached].map(([text, pid]) => `${text} by ${named(pid)}`),
          udpConnected: [...udpConnected].map(([remote, pid]) => ({ remote, by: named(pid) })),
          udpOwnAddress: [...udpOwnAddress].map(([local, { pid, samples }]) => ({ local, by: named(pid), node: /[\\/]node(\.exe)?$/i.test(seen.get(pid) ?? ""), samples })),
          listening: [...listening].sort(),
          processes: seen.size,
        };
      })();
      return stopping;
    },
  };
}

// ---------------------------------------------------------------- the run

const already = await appProcesses();
if (already.size) {
  console.error(`smoke: this copy of the app is running already (process ${[...already.keys()].join(", ")}): quit it, or test another copy`);
  process.exit(2);
}
const portBusy = await new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.once("connect", () => (socket.destroy(), resolve(true)));
  socket.once("error", () => resolve(false));
});
if (portBusy) {
  console.error(`smoke: port ${port} is in use on 127.0.0.1: stop what listens there, or give --port another`);
  process.exit(2);
}

// The real path: on macOS the temporary folder lies behind /var -> /private/var.
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-smoke-")));
const dataDir = path.join(root, "data");
const homeDir = path.join(root, "home");
const shots = path.join(root, "shots");
const netLog = path.join(root, "netlog.json");
for (const dir of [dataDir, homeDir, shots]) mkdirSync(dir, { recursive: true });

const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BUSY_EMULATOR_/i.test(name) && !/^ELECTRON_/i.test(name)));
Object.assign(env, {
  BUSY_EMULATOR_DATA: dataDir,
  BUSY_EMULATOR_PORT: String(port),
  BUSY_EMULATOR_HIDDEN: "1",
  BUSY_EMULATOR_USER_HOME: homeDir,
  BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([layout.exe, `--log-net-log=${netLog}`]),
});
if (win) env.LOCALAPPDATA = homeDir;
else env.HOME = homeDir;

// Stopped by a signal (below), the run goes no further: it starts no command of the app's but the quit, and gets no
// answer from one it has going, which is ended. Before, the run went on beside the signal's handler: after SIGTERM it
// took a screenshot, recorded against an app that was quitting and started `busy-emulator mcp`, and the test ended
// with that command's process still running (13.11, the release's gate of beta.2 and beta.4).
class Stopped extends Error {}
let stopping = false;
// The app's command-line processes the run has going, each with whether a signal ends it: all but the quit, and the
// start, which is let finish so that the quit after it finds the app it started.
const commands = new Map(); // child -> { stoppable, gone }
function track(child, stoppable) {
  const gone = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  commands.set(child, { stoppable, gone });
  gone.then(() => commands.delete(child));
}
/** Ends the commands a signal ends, then waits until every command the run started is gone. */
async function endCommands() {
  for (const [child, { stoppable }] of commands) if (stoppable) child.kill();
  await Promise.all([...commands.values()].map((c) => c.gone));
}

/**
 * One command of the app's command line, with --json: its answer, parsed. Done when the command's process ends, not
 * when its output closes: on Windows the app that `start` launches directly inherits the command's output handles and
 * keeps them open as long as it runs. Once the run is stopped it rejects with Stopped, but for the quit (`quitting`).
 */
function cli(args, timeoutMs = 120_000, { quitting = false } = {}) {
  if (stopping && !quitting) return Promise.reject(new Stopped());
  return new Promise((resolve, reject) => {
    const child = spawnProgram(layout.cli, [...args, "--json"], { env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    track(child, !quitting && args[0] !== "start");
    let stdout = "";
    let stderr = "";
    let ended = 0;
    let finished = false;
    let code = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      let answer = null;
      try {
        answer = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
      } catch {
        // Below: no answer.
      }
      if (stopping && !quitting) reject(new Stopped());
      else resolve({ code, answer, stdout, stderr });
    };
    child.stdout.setEncoding("utf8").on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    for (const stream of [child.stdout, child.stderr]) stream.once("end", () => ++ended === 2 && code !== null && finish());
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      stderr += String(e.message);
      finish();
    });
    child.on("exit", (exitCode, signal) => {
      code = exitCode ?? signal;
      // What it wrote is read to the end; a handle another process holds open is not waited for.
      if (ended === 2) finish();
      else setTimeout(finish, 1500);
    });
  });
}
const told = (r) => (r.answer ? JSON.stringify(r.answer) : `exit ${r.code}: ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`);

async function bar(method, route, body, headers = {}) {
  if (stopping) throw new Stopped();
  const r = await fetch(`http://127.0.0.1:${port}/api/${route}`, { method, body, headers });
  const text = await r.text();
  if (stopping) throw new Stopped();
  return { status: r.status, text };
}

/** `busy-emulator mcp` over stdio, as a chat client starts it: initialize, then tools/list. { tools } or { error }. */
function mcpHandshake(timeoutMs = 30_000) {
  if (stopping) return Promise.reject(new Stopped());
  return new Promise((resolve, reject) => {
    const child = spawnProgram(layout.cli, ["mcp"], { env, cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    track(child, true);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref();
      if (stopping) reject(new Stopped());
      else resolve(result);
    };
    const timer = setTimeout(() => finish({ error: `no answer to tools/list within ${timeoutMs / 1000} s: ${(stderr || stdout).trim().slice(-300)}` }), timeoutMs);
    child.on("error", (e) => finish({ error: e.message }));
    child.stderr.setEncoding("utf8").on("data", (c) => (stderr += c));
    child.stdout.setEncoding("utf8").on("data", (c) => {
      stdout += c;
      const answers = stdout.split("\n").filter((line) => line.trim()).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      });
      const init = answers.find((a) => a?.id === 1);
      const list = answers.find((a) => a?.id === 2);
      if (init?.error || list?.error) finish({ error: JSON.stringify(init?.error ?? list?.error) });
      else if (init && list) finish(init.result?.serverInfo && list.result?.tools?.length ? { tools: list.result.tools.length } : { error: `unexpected answers: ${stdout.slice(0, 300)}` });
    });
    for (const message of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function appArchive() {
  const files = {};
  for (const file of filesBelow(appSource)) files[`${SMOKE_APP}/${file}`] = readFileSync(path.join(appSource, file), "utf8");
  return targz(files);
}

/**
 * Ends what the test started: the app through `busy-emulator quit`, then whatever of it is left, by its PIDs. Once,
 * whether the run ends by itself or by a signal.
 */
let ending = null;
function endApp() {
  ending ??= (async () => {
    if (started || (await appProcesses()).size) {
      const quit = await cli(["quit"], 60_000, { quitting: true });
      if (!(quit.code === 0 && quit.answer?.ok)) fail(`busy-emulator quit: ${told(quit)}`);
    }
    // Every process of the app gone, the port free: what the test started, it ends.
    let left = await appProcesses();
    for (const until = Date.now() + 20_000; left.size && Date.now() < until; left = await appProcesses()) await sleep(250);
    if (left.size) {
      fail(`processes of the app left after quit: ${[...left].map(([pid, exe]) => `${pid} ${path.basename(exe)}`).join(", ")}; ending them`);
      for (const pid of left.keys()) {
        try {
          process.kill(pid);
        } catch {
          // Gone meanwhile.
        }
      }
    }
  })();
  return ending;
}

function removeRoot() {
  if (keep) return say(`kept ${root}`);
  rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  if (existsSync(root)) say(`could not remove ${root} entirely: ${readdirSync(root).join(", ")}`);
}

// Ctrl+C, a closed terminal, a kill: the app runs on its own (start detaches it) and only this test knows its data
// folder, so the test quits it and removes its folder before it ends, with exit code 130. A second signal ends the
// test at once.
let interrupted = null;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    say(`stopped by ${signal}: quitting the app and removing the temporary folder`);
    stopping = true;
    interrupted = (async () => {
      try {
        // What the run had going first, then the app; the test ends only once every command it started is gone.
        await endCommands();
        await endApp();
        await watcher.stop();
        await endCommands();
      } finally {
        removeRoot();
        process.exit(130);
      }
    })();
  });
}

const watcher = watch();
let started = false;
try {
  const t0 = Date.now();
  let start = await cli(["start"]);
  // Under Rosetta the first start of a new build waits for the translation of Electron's code (30-50 s on an M3 Pro,
  // more on a busy machine), which may be longer than the command line waits (60 s). The app is still starting then.
  // It is waited for through `status`, not started again: a second launch would race the first for the app's
  // single-instance lock and could be left running after the first has quit. Only under Rosetta; anywhere else a
  // start that takes that long is a failure.
  if (translated && start.answer?.code === "start_timeout") {
    say("start: not ready within the time the command line waits, under Rosetta (the translation of a new build); waiting up to 60 s more for the same app, without starting it again");
    for (const until = Date.now() + 60_000; Date.now() < until; await sleep(1000)) {
      const status = await cli(["status"]);
      if (status.code === 0 && status.answer?.ok && status.answer.state === "ready" && status.answer.answering) {
        start = { code: 0, answer: { ok: true, url: status.answer.url, pid: status.answer.pid } };
        break;
      }
    }
  }
  const startMs = Date.now() - t0;
  if (start.code === 0 && start.answer?.ok) {
    started = true;
    // quality.md: from the start of the app to its window with the bar, 3 s on macOS and 5 s on Windows, on the
    // reference machine. Here only seen: the command line's own start and its polling are in it.
    say(`start: ready in ${(startMs / 1000).toFixed(1)} s${translated ? " under Rosetta" : ""} (budget for the window ${win ? 5 : 3} s, not enforced here), ${start.answer.url}, process ${start.answer.pid}`);
  } else {
    fail(`busy-emulator start: ${told(start)}`);
  }

  if (started) {
    const status = await cli(["status"]);
    if (!(status.code === 0 && status.answer?.ok && status.answer.running !== false)) fail(`busy-emulator status: ${told(status)}`);
    if (status.answer?.port !== undefined && status.answer.port !== port) fail(`busy-emulator status names port ${status.answer.port}, not ${port}`);

    const staged = await bar("POST", "apps/stage", appArchive(), { "Content-Type": "application/octet-stream" });
    const key = staged.status === 200 ? JSON.parse(staged.text).install_key : null;
    const installed = key ? await bar("POST", `apps/install?install_key=${encodeURIComponent(key)}`) : null;
    const launched = installed?.status === 200 ? await bar("POST", `apps/launch?app_id=${SMOKE_APP}`) : null;
    if (launched?.status !== 200) {
      fail(`installing and running ${SMOKE_APP}: stage ${staged.status} ${staged.text.slice(0, 200)}${installed ? `, install ${installed.status} ${installed.text.slice(0, 200)}` : ""}${launched ? `, launch ${launched.status} ${launched.text.slice(0, 200)}` : ""}`);
    } else {
      say(`app: ${SMOKE_APP} installed and running on the bar`);
      const expected = readPng(readFileSync(expectedPng));
      const shot = path.join(shots, "front.png");
      let last = null;
      let tries = 0;
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        tries++;
        const taken = await cli(["screenshot", "--out", shot]);
        if (!(taken.code === 0 && taken.answer?.ok)) {
          last = `busy-emulator screenshot: ${told(taken)}`;
        } else {
          const differ = differingPixels(readPng(readFileSync(shot)), expected);
          last = differ === null ? "a frame of another size" : `${differ} of ${expected.width * expected.height} pixels differ`;
          if (differ === 0) {
            last = null;
            say(`frame: the front display matches test/smoke/front.png pixel for pixel (screenshot ${tries})`);
            break;
          }
        }
        await sleep(500);
      }
      if (last) fail(`the front display did not match test/smoke/front.png within 20 s: ${last}${keep ? ` (last frame: ${shot})` : ""}`);
      // The clip recorder in both formats: the server's capture/ modules, the GIF's worker (loaded by its URL, which
      // the packaging test's walk of imports does not see) and the window's MP4 encoder, as the packaged app has them.
      for (const [format, args] of [["gif", ["--gif"]], ["mp4", ["--layout", "post"]]]) {
        const file = path.join(shots, `clip.${format}`);
        const clip = await cli(["record", ...args, "--seconds", "1", "--out", file], 120_000);
        if (!(clip.code === 0 && clip.answer?.ok && existsSync(file) && statSync(file).size > 0)) fail(`busy-emulator record ${args.join(" ")}: ${told(clip)}`);
        else say(`record: a ${format.toUpperCase()} of ${clip.answer.frames} frames, ${statSync(file).size} bytes`);
      }
      const mcp = await mcpHandshake();
      if (mcp.error) fail(`busy-emulator mcp: ${mcp.error}`);
      else say(`mcp: initialize and tools/list answered (${mcp.tools} tools)`);
      const stopped = await bar("POST", `apps/quit?app_id=${SMOKE_APP}`);
      if (stopped.status !== 200) fail(`stopping ${SMOKE_APP}: ${stopped.status} ${stopped.text.slice(0, 200)}`);
    }
  }
} catch (e) {
  // Stopped by a signal: whatever failed after it is the stop's doing.
  if (!stopping) fail(`the run stopped: ${e?.stack ?? e}`);
} finally {
  await endApp();
}
// Stopped by a signal: its handler quits the app, removes the folder and ends the process.
if (interrupted) await new Promise(() => {});

const net1 = await watcher.stop();
{
  const portFree = await new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(true));
  });
  if (!portFree) fail(`port ${port} still answers after quit`);
}

// ---------------------------------------------------------------- the network

{
  let log = null;
  if (!existsSync(netLog)) {
    say("chromium: no network log: the app removes the Chromium switches it is given (EMU-236), --log-net-log with them; Chromium is covered by the list of sockets alone");
  } else {
    log = readNetLog(readFileSync(netLog, "utf8"));
    if (!log.named) fail("Chromium's network log has no names for its events: it cannot be read");
    for (const r of log.reached) fail(`Chromium's network log: ${r}`);
    say(
      `chromium: ${log.events} events in its network log${log.complete ? "" : " (cut short: the process was ended, its last events may be missing)"}; ` +
        (log.reached.length ? `${log.reached.length} beyond this machine` : "no request, lookup or connection beyond this machine") +
        (log.probes.length ? `; UDP connected without a datagram (the IPv6 reachability check): ${log.probes.join(", ")}` : ""),
    );
  }
  // A UDP socket connected to an address beyond this machine sends nothing by being connected. With Chromium's log it
  // is let through when the log names it as a probe that sent nothing; without the log, only Chromium's IPv6 probe
  // address itself is, and it is said that the log did not confirm it.
  const bare = (address) => address.replace(/^\[|\]/g, "");
  for (const u of net1.udpConnected) {
    if (log ? log.probes.some((p) => bare(p) === bare(u.remote)) : bare(u.remote) === bare(IPV6_PROBE)) {
      if (!log) say(`note: UDP connected to ${u.remote} by ${u.by}: Chromium's IPv6 reachability check, which sends no datagram; no network log to confirm it`);
    } else fail(`a UDP socket connected beyond this machine, not known as a probe that sends nothing: ${u.remote} by ${u.by}`);
  }
  // Windows: netstat shows a connected UDP socket as bound to an address of this machine. It is the probe's when
  // Chromium's log gives the probe that address as its own end; without the log, when a Chromium process held it for
  // one sample only, as the probe does (connect, read its own address, close). Anything else is bound for the
  // network to reach.
  for (const u of net1.udpOwnAddress) {
    if (log ? log.probeLocals.some((p) => bare(p) === bare(u.local)) : !u.node && u.samples === 1) {
      if (!log) say(`note: UDP on ${u.local} by ${u.by} for one sample: the shape of Chromium's IPv6 reachability check; no network log to confirm it`);
    } else fail(`a socket beyond this machine: UDP bound on ${u.local} by ${u.by}${log ? "" : ` (${u.samples} samples)`}`);
  }
  for (const r of net1.reached) fail(`a socket beyond this machine: ${r}`);
  say(
    `sockets: ${net1.samples} samples${net1.every ? `, one every ${(net1.every / 1000).toFixed(2)} s,` : ""} of ${net1.processes} processes of the app; ` +
      (net1.reached.length ? `${net1.reached.length} beyond this machine` : "none connected, listening or bound beyond 127.0.0.1 and ::1") +
      (net1.udpConnected.length ? ` (UDP connected only: ${net1.udpConnected.map((u) => u.remote).join(", ")})` : "") +
      (net1.udpOwnAddress.length ? ` (UDP on this machine's own address: ${net1.udpOwnAddress.map((u) => u.local).join(", ")})` : "") +
      `; listening on ${net1.listening.join(", ") || "nothing seen"}`,
  );
}

// ---------------------------------------------------------------- the user's own places, after

{
  const after = placeState();
  const changed = after.filter((line, i) => line !== placesBefore[i]);
  for (const line of changed) fail(`the user's own place changed during the test: ${line.split(" ")[0]}`);
  const launcher = path.join(homeDir, ...(win ? ["busy-emulator", "bin", "busy-emulator.exe"] : [".busy-emulator", "bin", "busy-emulator"]));
  const pointer = path.join(dataDir, "install.json");
  for (const file of [launcher, pointer]) if (!existsSync(file)) fail(`the app wrote no ${path.basename(file)} in the temporary folder (${file}): where did it write it?`);
  if (!changed.length) {
    say(
      "isolation: the user's own data folder (its top level), install.json, launcher folder and launcher unchanged (size and time, or absent before and after); " +
        `the app wrote its launcher and pointer file in the temporary folder`,
    );
  }
}

removeRoot();
say(failures.length ? `${failures.length} check(s) failed` : "all checks passed");
process.exit(failures.length ? 1 : 0);
