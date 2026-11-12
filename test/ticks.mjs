// The tick meter: how many of the GUI's ticks the screen module gets per second of real time, how late they come
// and what the server's process costs meanwhile. The budget is in emulator/docs/quality.md: 125 ticks a second.
//
//   node emulator/test/ticks.mjs --port 8701 --data <dir> [--firmware dev] [--fast]
//                                [--seconds 60] [--load idle|app|app+requests|app+http] [--json <file>] [--expect]
//
// It starts the server in its own process (the same options as packages/server/index.mjs; the port and the data
// folder must be given: it installs a probe app, and must not land on an emulator somebody is using), with every call
// of the module's emu_tick() timed, sets up the load, lets things settle for 5 s and measures:
//
//   idle       the bar as it starts: the apps menu, no app runs
//   app        probes/app.probe.anim runs: the firmware plays a 60 frames a second animation, the app's JS draws a
//              counter five times a second
//   app+requests the same, and a client in another process asks for GET /api/status and then GET /api/screen (the
//              front and back displays in turn), then waits 100 ms: about 7 pairs a second, as a screenshot command run
//              again and again does (EMU-019b, EMU-248)
//   app+http   the same as app, and a client in another process keeps the device window's event stream open and reads
//              /api/screen as fast as it is answered (thousands of times a second on macOS; about 70 on Windows,
//              where Node's fetch takes 15 ms a request)
//
// What it reports:
//
//   ticks/s    ticks in the window per second of it; "behind" is how many ticks short of 8 ms each the window is
//   gap        time from the start of one tick to the start of the next
//   lateness   how long after it was due a tick started. A server that counts ticks by the clock gives each tick the
//              time it was due at (the module's clock during the tick), and lateness is the real time past that. A
//              server that only has a timer has no due times: there it is the gap less 8 ms
//   host timer how many times a second the clock's own timer fired (a server that counts by the clock)
//   burst      ticks that started within 1 ms of the one before count as one burst
//   work       time inside emu_tick()
//   control    a process of its own that only waits on a 1 ms timer through the window: its worst wait past what it
//              asked for, and how many were over 17 ms. When the server's ticks are late and so is this, the computer
//              (other processes, its scheduler) kept them, not the server (EMU-248)
//   CPU        the process's user and system time over the window, in percent of one core; and "loop busy", the share
//              of the window the server's event loop was not waiting (performance.eventLoopUtilization). Windows
//              counts a process's time by sampling at its timer's interrupts, and work that starts on a timer and
//              is over well before the next interrupt is hardly ever caught: there the second number is the one to
//              trust
//
// With --expect it is a check as well: the exit code is 1 unless the window holds a tick for every 8 ms, give or take
// four at its ends (the meter's window starts and ends by a timer of its own, and on Windows the ticks come two and
// three at a time; ticks skipped after a stall of over half a second count as missing). A server that ticks from a
// timer is 10 % short on macOS and 50 % on Windows.
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--port", "--data", "--firmware", "--seconds", "--load", "--json", "--client", "--control"], flags: ["--fast", "--expect", "--requests"] });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK_MS = 8;
const SETTLE_MS = 5000;
const PROBE = "app.probe.anim";

// ---------------------------------------------------------------- the control: a process that only waits

if (args.includes("--control")) {
  // "<settle ms>,<window ms>": it starts with the server's settling, so that starting a process (several ms of the
  // server's thread on Windows) does not fall into the window.
  const [settle, window] = option("--control").split(",").map(Number);
  const from = performance.now() + settle;
  const end = from + window;
  const late = [];
  let last = performance.now();
  const wait = () => {
    const now = performance.now();
    if (now > from) late.push(now - last - 1);
    last = now;
    if (now < end) setTimeout(wait, 1);
    else process.stdout.write(JSON.stringify({ wakes: late.length, worstMs: Math.max(...late), over17: late.filter((l) => l > 17).length }), () => process.exit(0));
  };
  setTimeout(wait, 1);
  await new Promise(() => {});
}

// ---------------------------------------------------------------- the client of the "app+http" load

if (args.includes("--client") && args.includes("--requests")) {
  const addr = option("--client");
  for (let i = 0; ; i++) {
    await (await fetch(`http://${addr}/api/status`)).arrayBuffer();
    await (await fetch(`http://${addr}/api/screen?display=${i % 2}`)).arrayBuffer();
    await sleep(100);
  }
}
if (args.includes("--client")) {
  const addr = option("--client");
  // The device window's stream: while it is open the server compares frames 30 times a second and sends the new ones.
  const events = await fetch(`http://${addr}/_emu/events`);
  (async () => {
    for await (const chunk of events.body) void chunk;
  })().catch(() => {});
  for (;;) {
    await (await fetch(`http://${addr}/api/screen?display=0`)).arrayBuffer();
    await (await fetch(`http://${addr}/api/screen?display=1`)).arrayBuffer();
  }
}

// ---------------------------------------------------------------- the server, with its ticks timed

if (!option("--port") || !option("--data")) {
  console.error("ticks.mjs: give --port <port> and --data <folder>: the meter starts a server of its own there and installs a probe app in it.");
  process.exit(2);
}
const port = Number(option("--port"));
const seconds = Number(option("--seconds", "60"));
const load = option("--load", "idle");
if (!["idle", "app", "app+requests", "app+http"].includes(load)) throw new Error(`--load ${load}: idle, app, app+requests or app+http`);
const addr = `127.0.0.1:${port}`;

/** A performance.now() reading on the clock the server counts ticks by (packages/server/computer-clock.mjs). */
const wall = (p) => performance.timeOrigin + p;

let recording = null; // { start, work, due } arrays while the window is open
let counted = false; // the server counts ticks by the clock: a tick knows when it was due
let screen = null;
let wakes = 0; // times the clock's host timer fired, on such a server
const { Screen } = await import("../packages/server/screen.mjs");
const start = Screen.prototype.start;
Screen.prototype.start = async function () {
  await start.call(this);
  counted = typeof this.sync === "function";
  screen = this;
  if (counted) {
    const setTimer = this.clock.setTimer;
    this.clock.setTimer = (fn, ms) =>
      setTimer(() => {
        if (recording) wakes++;
        fn();
      }, ms);
  }
  const tick = this.M._emu_tick;
  this.M._emu_tick = () => {
    const t0 = performance.now();
    // During a tick the module's clock is the time the tick was due at, on a server that counts by the clock.
    const due = this.now() - this.skew;
    tick();
    if (recording && !this.held) {
      recording.start.push(t0);
      recording.work.push(performance.now() - t0);
      recording.due.push(due);
    }
  };
};
// The same options as the server's command line.
const { startServer } = await import("../packages/server/server.mjs");
const server = await startServer({
  port,
  dataDir: resolve(option("--data")),
  firmware: option("--firmware", process.env.EMU_FIRMWARE),
  barSpeed: !args.includes("--fast"),
  log: (line) => console.log(line),
});
console.log(`the meter's server: ${server.url}, firmware ${server.firmware.name}, data ${server.dataDir}`);

async function call(method, path, body) {
  const r = await fetch(`http://${addr}/api/${path}`, { method, body });
  return { status: r.status, text: await r.text() };
}
for (let i = 0; ; i++) {
  try {
    await call("GET", "version");
    break;
  } catch (e) {
    if (i === 100) throw e;
    await sleep(100);
  }
}

function files(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

let client = null;
if (load !== "idle") {
  const dir = join(here, "probes", PROBE);
  const { targz } = await import("./package.mjs");
  const entries = Object.fromEntries(files(dir).map((f) => [`${PROBE}/${relative(dir, f).replaceAll("\\", "/")}`, readFileSync(f)]));
  const staged = await fetch(`http://${addr}/api/apps/stage`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: targz(entries) });
  const { install_key } = await staged.json();
  const installed = await call("POST", `apps/install?install_key=${install_key}`);
  if (installed.status !== 200) throw new Error(`install: ${installed.status} ${installed.text}`);
  await sleep(500);
  const launched = await call("POST", `apps/launch?app_id=${PROBE}`);
  if (launched.status !== 200) throw new Error(`launch: ${launched.status} ${launched.text}`);
}
if (load === "app+http" || load === "app+requests") {
  client = spawn(process.execPath, [fileURLToPath(import.meta.url), "--client", addr, ...(load === "app+requests" ? ["--requests"] : [])], { stdio: "ignore" });
}

const control = spawn(process.execPath, [fileURLToPath(import.meta.url), "--control", `${SETTLE_MS},${seconds * 1000}`], { stdio: ["ignore", "pipe", "ignore"] });
let controlOutput = "";
control.stdout.on("data", (chunk) => (controlOutput += chunk));
const controlDone = new Promise((resolve) => control.on("close", resolve));
await sleep(SETTLE_MS);
recording = { start: [], work: [], due: [] };
const cpu0 = process.cpuUsage();
const loop0 = performance.eventLoopUtilization();
const skipped0 = screen.clock?.skipped ?? 0;
const t0 = performance.now();
await sleep(seconds * 1000);
const elapsed = performance.now() - t0;
const cpu = process.cpuUsage(cpu0);
const loop = performance.eventLoopUtilization(loop0);
const { start: starts, work, due } = recording;
recording = null;
const late = starts.map((p, i) => wall(p) - due[i]);

// The app really ran: its draws are counted by the server.
let draws = null;
if (load !== "idle") {
  const state = await (await fetch(`http://${addr}/_emu/state`)).json();
  draws = state.running?.id === PROBE ? state.running.stats.draws : null;
  await call("POST", "apps/quit");
  await call("DELETE", `apps?app_id=${PROBE}`);
}
client?.kill();
await controlDone;
let controlResult = null;
try {
  controlResult = JSON.parse(controlOutput);
} catch {
  // It did not report: the line below says so.
}

const spread = (values) => {
  const v = [...values].sort((a, b) => a - b);
  const at = (q) => v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? 0;
  return { median: at(0.5), p95: at(0.95), p99: at(0.99), worst: v[v.length - 1] ?? 0 };
};
const gaps = starts.slice(1).map((t, i) => t - starts[i]);
const bursts = {};
let size = 1;
for (const gap of gaps) {
  if (gap < 1) size++;
  else {
    bursts[size] = (bursts[size] ?? 0) + 1;
    size = 1;
  }
}
bursts[size] = (bursts[size] ?? 0) + 1;

const result = {
  platform: `${process.platform} ${process.arch}, Node ${process.version}`,
  load,
  barSpeed: !args.includes("--fast"),
  seconds: elapsed / 1000,
  countedByClock: counted,
  ticks: starts.length,
  ticksPerSecond: starts.length / (elapsed / 1000),
  behind: elapsed / TICK_MS - starts.length,
  // Ticks the server left out on purpose after a stall longer than it makes up.
  skipped: counted ? screen.clock.skipped - skipped0 : null,
  // How often the clock's host timer fired; the rest of the ticks were carried out before a request or a look.
  hostWakesPerSecond: counted ? wakes / (elapsed / 1000) : null,
  gapMs: spread(gaps),
  latenessMs: spread(counted ? late : gaps.map((g) => g - TICK_MS)),
  bursts,
  workMs: spread(work),
  cpuPercent: ((cpu.user + cpu.system) / 1000 / elapsed) * 100,
  loopBusyPercent: loop.utilization * 100,
  tickWorkPercent: (work.reduce((sum, w) => sum + w, 0) / elapsed) * 100,
  appDraws: draws,
  control: controlResult,
};
const ms = (s) => `${s.median.toFixed(2)} / ${s.p95.toFixed(2)} / ${s.p99.toFixed(2)} / ${s.worst.toFixed(2)}`;
console.log(`\n${result.platform}; load ${load}; ${result.barSpeed ? "bar speed" : "--fast"}; ${result.seconds.toFixed(1)} s`);
console.log(`  ticks/s    ${result.ticksPerSecond.toFixed(1)} (${result.ticks} ticks, ${result.behind.toFixed(0)} behind the clock${result.skipped ? `, ${result.skipped} skipped after stalls` : ""})`);
console.log(`  gap        ${ms(result.gapMs)} ms (median / 95% / 99% / worst)`);
console.log(`  lateness   ${ms(result.latenessMs)} ms${counted ? "" : " (gap less 8 ms: the server has no due times)"}`);
if (counted) console.log(`  host timer ${result.hostWakesPerSecond.toFixed(1)} wakes/s`);
console.log(`  burst      ${Object.entries(bursts).map(([n, count]) => `${count} of ${n}`).join(", ")}`);
console.log(`  work       ${ms(result.workMs)} ms per tick`);
console.log(`  CPU        ${result.cpuPercent.toFixed(1)}% of one core; loop busy ${result.loopBusyPercent.toFixed(1)}%, of which inside ticks ${result.tickWorkPercent.toFixed(1)}%`);
if (draws !== null) console.log(`  the app's draws since it started: ${draws}`);
console.log(controlResult ? `  control    a process that only waits on a 1 ms timer: worst ${controlResult.worstMs.toFixed(2)} ms late, ${controlResult.over17} waits over 17 ms of ${controlResult.wakes}` : "  control    did not report");
if (option("--json")) writeFileSync(option("--json"), JSON.stringify(result, null, 2) + "\n");
if (args.includes("--expect")) {
  const missing = elapsed / TICK_MS - starts.length;
  const ok = Math.abs(missing) <= 4;
  console.log(ok ? "  as expected: a tick for every 8 ms" : `  NOT as expected: ${Math.abs(missing).toFixed(1)} ticks ${missing > 0 ? "missing" : "too many"} in the window`);
  process.exit(ok ? 0 : 1);
}
process.exit(0);
