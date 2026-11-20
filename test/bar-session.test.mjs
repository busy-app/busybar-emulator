// The BUSY Bar session's observations as checks of the gate: each recording of bar-session/recordings/<firmware>/<group>.json
// (written on a BUSY Bar by bar-session/run.mjs) is replayed in an emulator of that firmware, the group's own parts
// run again as the recording ran them (the person played from what the recording says he did), and every value
// compared as the recording says: exact, within a tolerance, or raw (shown, not compared). A group the session has not
// recorded yet has no test here; the suites that record at the session (golden, timed, state, fetch, api, speed)
// compare their own recordings.
//
//   node --test emulator/test/bar-session.test.mjs     EMU_RECORDINGS=<folder>: the recordings under that folder
//                                                      instead of test/ (the session's trial run, run.mjs --verify)
//
// Also checked here, without an emulator: the kit's own parts (what a recording keeps of the log, the comparisons).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { test } from "node:test";

import { groupOf, GROUPS } from "./bar-session/groups.mjs";
import { ask, cleanLog, compareObservations, control, Device, eventsApart, readObservations, sha256, STANDARD_BAR_SHA256, Stop, stopSession } from "./bar-session/lib.mjs";
import { GroupRun } from "./bar-session/session.mjs";
import { ownEmulator, recordingsRoot } from "./own-emulator.mjs";

const root = recordingsRoot();
const recordings = join(root, "bar-session", "recordings");

test("the kit's groups: one each of the tasks, none twice", () => {
  const ids = GROUPS.map((g) => g.id);
  assert.deepEqual([...new Set(ids)], ids);
  assert.deepEqual([...ids].sort(), ["EMU-344", "EMU-347", "EMU-348", "EMU-349", "EMU-350", "EMU-351", "EMU-352", "EMU-353", "EMU-354", "EMU-355", "EMU-363"]);
  for (const g of GROUPS) assert.ok(g.minutes > 0 && typeof g.run === "function", g.id);
});

test("a recording keeps the log lines of apps and their services, without the network's and without addresses", () => {
  // Addresses of the documentation's own ranges and a made-up MAC, put together here: no file carries one.
  const ip = ["198", "51", "100", "20"].join(".");
  const mac = ["02", "aa", "bb", "cc", "dd", "ee"].join(":");
  const lines = cleanLog(
    [
      "1234 [I][JsRunner] app.probe.kit.timers started",
      "1235 [I][WiFi] connected to MyHomeNetwork",
      "1236 [E][JsInterval] Interval with ID 3 is not found",
      `1237 [I][Mongoose] fetch to ${ip} from 127.0.0.1`,
      `1238 [I][Storage] app.probe.kit.x of serial SERIAL0001 at ${mac}`,
      "1239 [I][Display] brightness 50",
    ],
    "SERIAL0001",
  );
  assert.deepEqual(lines, [
    "1234 [I][JsRunner] app.probe.kit.timers started",
    "1236 [E][JsInterval] Interval with ID 3 is not found",
    "1237 [I][Mongoose] fetch to <ip> from 127.0.0.1",
    "1238 [I][Storage] app.probe.kit.x of serial <serial> at <mac>",
  ]);
});

test("observations compare as they say: exact, within, events; raw is shown and never fails", () => {
  const recorded = {
    observations: {
      "a: exact": { value: "200 OK", compare: "exact" },
      "a: within": { value: 100, compare: { within: 10 } },
      "a: raw": { value: [1, 2], compare: "raw" },
      "a: events": { value: [["ok", "press", 0], ["ok", "short", 90], ["ok", "release", 92]], compare: { events: 40 } },
    },
  };
  const ok = compareObservations(recorded, { observations: { "a: exact": { value: "200 OK" }, "a: within": { value: 108 }, "a: raw": { value: 3 }, "a: events": { value: [["ok", "press", 0], ["ok", "short", 120], ["ok", "release", 121]] } } });
  assert.deepEqual(ok.map(([, pass]) => pass), [true, true, true, true]);
  const bad = compareObservations(recorded, { observations: { "a: exact": { value: "404 x" }, "a: within": { value: 120 }, "a: events": { value: [["ok", "press", 0], ["ok", "long", 500]] } } });
  assert.deepEqual(bad.map(([, pass]) => pass), [false, false, true, false]);
  assert.match(eventsApart([["ok", "press", 0], ["ok", "release", 100]], [["ok", "press", 0], ["ok", "release", 200]], 40), /further apart than 40 ms: ok release 100\/200/);
});

test("the standard BUSY Bar is known by the hash of its serial number, not by the number", () => {
  assert.equal(STANDARD_BAR_SHA256.length, 64);
  assert.notEqual(sha256("EMULATOR"), STANDARD_BAR_SHA256);
});

/** The session's stop, put back as it was for the next test. */
function freshControl(t) {
  t.after(() => {
    control.stopped = null;
    control.restoring = false;
    control.waiters.clear();
  });
}

test("a question to the person ends with no answer when the terminal closes or the session stops", async (t) => {
  freshControl(t);
  const closed = new PassThrough();
  const asked = ask("? ", { input: closed, output: new PassThrough() });
  closed.end();
  assert.equal(await asked, "");
  const open = new PassThrough();
  const waiting = ask("? ", { input: open, output: new PassThrough() });
  stopSession("stopped by SIGTERM");
  assert.equal(await waiting, "");
  assert.equal(control.waiters.size, 0);
});

/** A stand-in BUSY Bar that answers status/system with `system` and never restarts. */
async function standIn(t, system) {
  const server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/api/status/firmware") ? { version: "1.4.1" } : system));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return new Device({ addr: `127.0.0.1:${server.address().port}` });
}

test("an uptime that cannot be read is too early: read again, then the part fails", async (t) => {
  freshControl(t);
  const device = await standIn(t, { uptime: "soon", boot_time: 1 });
  assert.equal(await device.uptime(), null);
  const said = [];
  await assert.rejects(device.pastFirstSeconds((line) => said.push(line), { tries: 2, pauseMs: 10 }), /uptime could not be read/);
  assert.equal(said.length, 2);
});

test("a restart that does not happen stops the session and says to hold Back and Start", async (t) => {
  freshControl(t);
  const device = await standIn(t, { uptime: "00d 00h 05m 00s", boot_time: 1 });
  // The CLI does not answer (telnet refused): cli() gives null, the BUSY Bar keeps its boot_time.
  device.cli = async () => null;
  await assert.rejects(device.reboot({ downMs: 300 }), (e) => e instanceof Stop && /hold Back and Start/.test(e.message));
  assert.match(control.stopped, /could not restart the BUSY Bar/);
});

test("a part stopped half way leaves no observations, so it replaces nothing recorded before", async () => {
  const run = new GroupRun({ group: { id: "EMU-000" }, device: null, mode: "trial", identity: { serial: "x", firmware: { version: "1.4.1" } }, say: () => {} });
  await run.part("whole", {}, async () => run.observe("whole: a", 1));
  await assert.rejects(
    run.part("cut", {}, async () => {
      run.observe("cut: b", 2);
      throw new Stop("stopped by SIGINT");
    }),
    Stop,
  );
  assert.deepEqual(Object.keys(run.observations), ["whole: a"]);
  assert.deepEqual(run.recording().parts, ["whole"]);
});

/** A port of this computer that is free now: the kit's own server listens there in the replay. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const firmwares = existsSync(recordings) ? readdirSync(recordings).filter((f) => /^\d+\.\d+\.\d+$/.test(f)).sort() : [];
for (const firmware of firmwares) {
  for (const file of readdirSync(join(recordings, firmware)).filter((f) => f.endsWith(".json")).sort()) {
    const id = file.replace(/\.json$/, "");
    const recorded = readObservations(root, firmware, id);
    test(`${firmware}, ${id}: the emulator does what the BUSY Bar did (${recorded.parts.join(", ")})`, { timeout: 15 * 60 * 1000 }, async (t) => {
      const group = groupOf(id);
      assert.ok(group, `bar-session/groups.mjs has no group ${id}`);
      const helperPort = await freePort();
      const emulator = await ownEmulator({ firmware, allowLocal: [helperPort, 1], name: "bar-session" });
      t.after(() => emulator.stop());
      const device = new Device({ addr: emulator.addr, emulator: true, helperPort });
      const identity = await device.identity();
      const run = new GroupRun({ group, device, mode: "replay", identity, recorded, say: (line) => t.diagnostic(line.trim()) });
      await group.run(run);
      assert.deepEqual(run.failed, [], "parts that failed in the replay");
      // The values of the parts the replay ran; a part of raw values only is shown as recorded.
      const ran = { observations: Object.fromEntries(Object.entries(recorded.observations).filter(([key]) => run.parts.some((p) => key.startsWith(`${p}: `)) || recorded.observations[key].compare === "raw")) };
      const lines = compareObservations(ran, run);
      for (const [name, pass, detail] of lines) t.diagnostic(`${pass ? "ok  " : "DIFF"} ${name}: ${detail}`);
      const differ = lines.filter(([, pass]) => !pass).map(([name, , detail]) => `${name}: ${detail}`);
      assert.deepEqual(differ, [], `${differ.length} of ${lines.length} values are not the BUSY Bar's (${recorded.source.bar}, ${recorded.source.recorded.slice(0, 10)})`);
    });
  }
}
