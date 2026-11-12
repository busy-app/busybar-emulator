// A real server gives the bar's system 125 GUI ticks for every second (EMU-225). The servers are started in this
// process (startServer) on free ports, left alone for a few seconds and asked for their clock and tick count before
// and after (GET /_emu/state); the test stops them and removes their data.
//
//   node --test emulator/test/ticks.test.mjs        [EMU_TEST_PORTS=8701-8709] the ports to use; free ones by default
//
// What must hold, and why it holds on a busy computer too:
//
//   - every 8 ms of the server's clock in the window is a tick carried out or a tick counted as skipped, give or
//     take one at the window's ends. This is exact however late the server's own timer runs: missed ticks are made
//     up. A server that ticks from a timer and makes nothing up (113 ticks a second on macOS, 64 on Windows) is 10 to
//     50 % short here;
//   - no more than 10 % of the window's ticks are skipped. A tick is skipped only when the server's event loop stood
//     for over half a second (the part of a stall older than 500 ms is not made up), so this lets a computer stall
//     the server for 0.9 s once in the 4 s. A server whose timer does not drive the clock at all would have its ticks
//     made up only by the test's second question, the last half second of them, and skip 85 %;
//   - the server's clock moved as much as the test's own, within a second: the two questions' own time.
//
// Two servers in one process, on different firmwares, each keep that count: a screen has a clock of its own.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../packages/server/server.mjs";
import { port, tempDir } from "./server/helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const TICK_MS = 8;
const WINDOW_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts a server for the test; it is stopped and its data removed when the test is over. */
async function start(t, options = {}) {
  const emulator = await startServer({ port: port(0), dataDir: tempDir(t), ...options });
  t.after(() => emulator.stop());
  return emulator;
}

/** Watches the servers for the window; returns what each one's clock and ticks did in it. */
async function watch(servers) {
  const state = async (emulator) => (await (await fetch(`${emulator.url}/_emu/state`)).json()).clock;
  await sleep(1000); // the bars have started and their first screens are up
  const t0 = performance.now();
  const before = await Promise.all(servers.map(state));
  await sleep(WINDOW_MS);
  const after = await Promise.all(servers.map(state));
  const real = performance.now() - t0;
  return servers.map((emulator, i) => ({ firmware: emulator.firmware.name, real, clock: after[i].now - before[i].now, ticks: after[i].ticks - before[i].ticks, skipped: after[i].skipped - before[i].skipped }));
}

function assert125({ firmware, real, clock, ticks, skipped }) {
  const told = `${firmware}: ${ticks} ticks and ${skipped} skipped in ${clock} ms of the server's clock (${Math.round(real)} ms of the test's): ${((ticks / clock) * 1000).toFixed(1)} ticks a second`;
  assert.ok(Math.abs(ticks + skipped - clock / TICK_MS) <= 1, `not a tick for every 8 ms: ${told}`);
  assert.ok(skipped <= (clock / TICK_MS) * 0.1, `too many ticks skipped: ${told}`);
  assert.ok(Math.abs(clock - real) <= 1000, `the server's clock does not keep time: ${told}`);
  assert.ok(clock >= WINDOW_MS, told);
  return told;
}

test("a running server carries out 125 ticks for every second of real time", async (t) => {
  const [seen] = await watch([await start(t)]);
  t.diagnostic(assert125(seen));
});

test("two servers in one process, on different firmwares, each carry out 125 ticks for every second", async (t) => {
  const servers = [await start(t, { firmware: "1.3.1" }), await start(t, { port: port(1), firmware: "dev" })];
  for (const seen of await watch(servers)) t.diagnostic(assert125(seen));
});

test("the tick meter and the pace probe do not run without an address of their own", async () => {
  // Their old default was the port of the emulator a person runs, where the probe would draw and hold the clock.
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("exit", (code) => resolve({ code, output }));
    });
  const meter = await run([join(here, "ticks.mjs")]);
  assert.equal(meter.code, 2, meter.output);
  assert.match(meter.output, /give --port <port> and --data <folder>/);
  const noData = await run([join(here, "ticks.mjs"), "--port", String(port(0) || 8701)]);
  assert.equal(noData.code, 2, noData.output);
  for (const args of [["--timeline", "nowhere.json"], ["--timeline", "nowhere.json", "--make"]]) {
    const probe = await run([join(here, "pace.mjs"), ...args]);
    assert.equal(probe.code, 2, probe.output);
    assert.match(probe.output, /give --emu <address>/);
  }
});
