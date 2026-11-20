// The BUSY Bar session: every reference the emulator still lacks from a BUSY Bar, recorded in one sitting (EMU-344,
// EMU-347 to EMU-355 and what EMU-337 left open). docs/bar-session.md of the monorepo is the owner's guide.
//
//   node emulator/test/bar-session/run.mjs [--bar 10.0.4.20] [--only EMU-349,EMU-350/failures] [--consent heap,reboot]
//       [--serial <serial number>] [--no-person]
//   node emulator/test/bar-session/run.mjs --emulator 8681 [--firmware 1.3.1] [--verify] [--out <folder>] [...]
//   node emulator/test/bar-session/run.mjs --list
//
// First the BUSY Bar's serial number and firmware are read and printed, and nothing is done until the owner types the
// serial number back (all of it, or its last 6 characters), or --serial names it: so the session never runs on another
// BUSY Bar than the one meant. Then each group (bar-session/groups.mjs) runs its parts. A part that needs the owner's
// consent runs only when --consent names it: heap (the JS heap filled: after 30 s of uptime that restarts the BUSY
// Bar) and reboot (the kit restarts it). A part that needs a person at the BUSY Bar waits for him on this terminal;
// --no-person skips them. Speed and pace run on the standard BUSY Bar only. Whatever is skipped is said, with why.
//
// The BUSY Bar is put back as it was at the end, also after a failure or Ctrl+C: its brightness and volume, no app of
// the kit, nothing drawn by it (lib.mjs, restore). The kit never powers it off, never touches its Wi-Fi, never flashes
// it, and does not walk its Bluetooth or Sound programs.
//
// Where the recordings go: on a BUSY Bar, where the suites read them (test/golden, test/timed, test/state, test/fetch,
// test/api, packages/server/bar-speed.json; the observations of the kit's own probes in
// test/bar-session/recordings/<firmware>/<group>.json, which bar-session.test.mjs replays). With --emulator the kit
// starts an emulator of its own on that port (a data folder of its own in the system's temporary folder, removed
// after) and runs the same groups against it, the person played by the emulator's buttons; everything goes to --out,
// a new temporary folder by default, never the source tree. --verify then runs each suite and bar-session.test.mjs
// against what was written there: the trial of the whole chain from a recording to a check of the gate.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commandLine } from "../../packages/server/arguments.mjs";
import { GROUPS } from "./groups.mjs";
import { GOLDEN_SCENES } from "./groups/emu-348.mjs";
import { ask, control, Device, stopSession, readObservations, restore, runSuite, snapshotOf, STANDARD_BAR_SHA256, sha256, Stop, testDir, writeObservations } from "./lib.mjs";
import { GroupRun } from "./session.mjs";
import { LIGHTS_APP } from "./groups/emu-353.mjs";

const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--emulator", "--firmware", "--only", "--consent", "--serial", "--out"], flags: ["--no-person", "--verify", "--list"] });
const option = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const CONSENTS = ["heap", "reboot"];

if (args.includes("--list")) {
  for (const g of GROUPS) console.log(`${g.id.padEnd(8)} about ${String(g.minutes).padStart(2)} min  ${g.title}\n${" ".repeat(9)}parts: ${g.parts.join("; ")}`);
  console.log(`\nabout ${GROUPS.reduce((s, g) => s + g.minutes, 0)} min in all, with every consent and a person at the BUSY Bar`);
  process.exit(0);
}

const consent = new Set((option("--consent", "") ?? "").split(",").filter(Boolean));
for (const c of consent) if (!CONSENTS.includes(c)) throw new Error(`--consent takes ${CONSENTS.join(", ")}; not ${c}`);
// --only EMU-349,EMU-350/failures: whole groups, or parts of one.
const only = option("--only")?.split(",") ?? null;
const wanted = GROUPS.filter((g) => !only || only.some((o) => o.split("/")[0] === g.id));
if (only) for (const o of only) if (!GROUPS.some((g) => g.id === o.split("/")[0])) throw new Error(`no group ${o.split("/")[0]}: ${GROUPS.map((g) => g.id).join(", ")}`);
const partsOf = (group) => {
  const named = (only ?? []).filter((o) => o.startsWith(`${group.id}/`)).map((o) => o.split("/")[1]);
  return named.length && !(only ?? []).includes(group.id) ? named : null;
};

// ---------------------------------------------------------------- the device: a BUSY Bar, or an emulator of the kit's own

const emulatorPort = option("--emulator");
const mode = emulatorPort ? "trial" : "bar";
let emulator = null;
let device;
let out;
if (emulatorPort) {
  for (const taken of [8640, 8652, 8653, 8790]) if (Number(emulatorPort) === taken) throw new Error(`port ${taken} is not for tests: take another`);
  out = option("--out") ?? mkdtempSync(join(tmpdir(), "busybar-bar-session-"));
  mkdirSync(out, { recursive: true });
  emulator = await startEmulator(Number(emulatorPort), option("--firmware", "1.4.1"));
  device = new Device({ addr: `127.0.0.1:${emulatorPort}`, emulator: true, helperPort: Number(emulatorPort) + 1 });
} else {
  if (option("--out")) throw new Error("--out is for --emulator: on a BUSY Bar the recordings go where the suites read them");
  out = testDir;
  device = new Device({ addr: option("--bar", "10.0.4.20"), helperPort: 8688 });
}
const suiteEnv = mode === "trial" ? { EMU_RECORDINGS: out, EMU_FETCH_PORT: String(Number(emulatorPort) + 2) } : {};

/** An emulator of the kit's own: index.mjs on `port`, a data folder of its own, the kit's helper ports let in. */
async function startEmulator(port, firmware) {
  const dataDir = mkdtempSync(join(tmpdir(), "busybar-bar-session-data-"));
  const allow = [port + 1, port + 2, 1].flatMap((p) => ["--allow-local", String(p)]);
  const child = spawn(process.execPath, [join(testDir, "..", "packages", "server", "index.mjs"), "--port", String(port), "--data", dataDir, "--firmware", firmware, ...allow], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  // In a process group of its own: a Ctrl+C of the session reaches the session, which puts the emulator's BUSY Bar back
  // and then stops it.
  let errors = "";
  child.stderr.on("data", (d) => (errors += d));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => d.toString().includes("BUSY Bar emulator: http://") && resolve());
    child.once("exit", (code) => reject(new Error(`the emulator ended with ${code}: ${errors.trim().split("\n").at(-1)}`)));
  });
  console.log(`an emulator of the kit's own on 127.0.0.1:${port}, firmware ${firmware}, data folder ${dataDir}`);
  return {
    dataDir,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill("SIGTERM");
      }).then(() => rmSync(dataDir, { recursive: true, force: true })),
  };
}

// ---------------------------------------------------------------- which BUSY Bar

const identity = await device.identity();
const standard = sha256(identity.serial) === STANDARD_BAR_SHA256;
console.log(`\n${mode === "trial" ? "Emulator" : "BUSY Bar"} at ${device.addr}`);
console.log(`  serial number  ${identity.serial}${standard ? "  (the standard BUSY Bar: speed and pace are measured)" : mode === "bar" ? "  (not the standard BUSY Bar: speed and pace are skipped)" : ""}`);
console.log(`  firmware       ${identity.firmware.version} (${identity.firmware.commit_hash}), API ${identity.api}, ${identity.security}`);
const given = option("--serial");
const typed = given ?? (await ask("\nType the serial number above (or its last 6 characters) to go on with this BUSY Bar: "));
if (!typed || !(typed === identity.serial || (typed.length >= 6 && identity.serial.endsWith(typed)))) {
  console.log(`${given ? "--serial" : "The serial number typed"} is not this one's: nothing was done.`);
  await emulator?.stop();
  process.exit(2);
}
const person = mode === "trial" || (!args.includes("--no-person") && process.stdin.isTTY);
const consentSaid = mode === "trial" ? "all (an emulator)" : consent.size ? [...consent].join(", ") : "none (the parts that may fill the heap or restart the BUSY Bar are skipped)";
console.log(`\nconsent: ${consentSaid}; person at the BUSY Bar: ${mode === "trial" ? "played by the kit" : person ? "yes" : "no"}`);
console.log(`recordings: ${out}\n`);

// ---------------------------------------------------------------- the session

const before = await snapshotOf(device);
let restored = false;
const putBack = async () => {
  if (restored) return [];
  restored = true;
  return restore(device, before, [LIGHTS_APP, "golden", "emu.timed", "app.probe.draw"]);
};
// Ctrl+C, a terminal closed (SIGHUP), a kill (SIGTERM): the session stops sending, waits for the part and the suite it
// runs to end, puts the BUSY Bar back and ends. A second signal ends it at once, without putting anything back.
// Output to a terminal that is gone must not end it before the BUSY Bar is put back.
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (control.stopped) {
      console.log(`\n${signal} again: ending at once; nothing more is put back (docs/bar-session.md says what to check)`);
      process.exit(130);
    }
    stopSession(`stopped by ${signal}`);
    console.log(`\n${signal}: stopping; the part ends at its next request, then the BUSY Bar is put back (${signal} again ends at once)`);
    control.child?.kill("SIGINT");
  });
}
// The Mac kept awake while the session runs (it may take half an hour): asleep, it would cut the BUSY Bar off mid-part.
if (process.platform === "darwin" && existsSync("/usr/bin/caffeinate")) spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" }).unref();

const results = [];
const started = Date.now();
try {
  for (const group of wanted) {
    if (control.stopped) break;
    const t0 = Date.now();
    console.log(`${group.id}: ${group.title}`);
    const run = new GroupRun({ group, device, mode, consent: mode === "trial" ? new Set(CONSENTS) : consent, person, identity, suiteEnv, askPerson: ask, onlyParts: partsOf(group), snapshot: before });
    try {
      await group.run(run);
    } catch (e) {
      if (!(e instanceof Stop)) {
        run.failed.push({ part: "(the group)", error: e.message });
        console.log(`    FAIL ${group.id}: ${e.stack ?? e.message}`);
      }
    }
    let file = null;
    if (run.observed) {
      // A part run again replaces its own observations; the group's other parts keep theirs.
      const old = readObservations(out, identity.firmware.version, group.id);
      const recording = run.recording();
      if (old) {
        const kept = Object.fromEntries(Object.entries(old.observations).filter(([name]) => !recording.parts.some((p) => name.startsWith(`${p}: `))));
        recording.observations = { ...kept, ...recording.observations };
        recording.parts = [...new Set([...old.parts, ...recording.parts])];
      }
      file = writeObservations(out, identity.firmware.version, group.id, recording);
    }
    results.push({ group, run, file, seconds: Math.round((Date.now() - t0) / 1000) });
  }
} finally {
  // A suite still running is waited for: it ends on the signal it was passed.
  while (control.child) await new Promise((resolve) => setTimeout(resolve, 200));
  const did = await putBack().catch((e) => [`could not put the BUSY Bar back: ${e.message}`]);
  console.log(`\nput back: ${did.length ? did.join("; ") : "nothing had changed"}`);
}

// ---------------------------------------------------------------- what was done

console.log(`\nSummary (${Math.round((Date.now() - started) / 60000)} min in all)`);
for (const { group, run, file, seconds } of results) {
  console.log(`  ${group.id} (${seconds} s)`);
  for (const s of run.suites) console.log(`    recorded by ${s.script} ${s.args}${s.code ? ` (NOT WHOLE: exit ${s.code})` : ""}: ${s.what}`);
  if (file) console.log(`    observations of ${run.parts.join(", ")}: ${file}`);
  for (const s of run.skipped.filter((one) => !one.why.startsWith("not asked for"))) console.log(`    skipped ${s.part}: ${s.why}`);
  for (const f of run.failed) console.log(`    FAILED ${f.part}: ${f.error.split("\n")[0]}`);
}
const failed = results.flatMap((r) => r.run.failed);
if (control.stopped) console.log(`\nThe session stopped: ${control.stopped}. What was recorded before is kept; the groups after were not run.`);

if (args.includes("--verify") && mode === "trial" && !control.stopped) failed.push(...(await verify()));
await emulator?.stop();
process.exit(control.stopped ? 130 : failed.length ? 1 : 0);

/**
 * The trial's recordings read by the suites that read a BUSY Bar's, against emulators of their own: the chain from a
 * recording to a check of the gate.
 */
async function verify() {
  console.log("\nVerify: the suites against what was recorded here");
  const env = { EMU_RECORDINGS: out };
  const fw = identity.firmware.version;
  // A part that ran to its end.
  const ran = (id, part) => results.some((r) => r.group.id === id && r.run.parts.includes(part));
  const checks = [];
  if (ran("EMU-348", "golden") || ran("EMU-350", "golden")) checks.push(["golden.mjs", ["--firmware", fw, "--only", [...(ran("EMU-348", "golden") ? GOLDEN_SCENES : []), ...(ran("EMU-350", "golden") ? ["system-error-throw", "system-error-handler", "system-error-rejection"] : [])].join(",")]]);
  if (ran("EMU-348", "timed")) checks.push(["timed.mjs", ["--firmware", fw, "--only", "anim-back"]]);
  if (ran("EMU-348", "state")) checks.push(["--test", ["--test-name-pattern", "drawing from outside", join(testDir, "state.test.mjs")]]);
  if (ran("EMU-351", "record")) checks.push(["fetch.mjs", ["--firmware", fw]]);
  if (ran("EMU-354", "records-1.3.1")) checks.push(["api.mjs", ["--firmware", fw]], ["fetch.mjs", ["--firmware", fw]]);
  if (ran("EMU-344", "speed")) checks.push(["speed.mjs", ["--firmware", fw]]);
  if (results.some((r) => r.file)) checks.push(["--test", [join(testDir, "bar-session.test.mjs")]]);
  const bad = [];
  for (const [script, list] of checks) {
    console.log(`  ${script === "--test" ? `node --test ${list.at(-1)}` : script} ${script === "--test" ? "" : list.join(" ")}`);
    const code = script === "--test" ? await runNodeTest(list, env) : await runSuite(script, list, env);
    console.log(`  ${code === 0 ? "ok" : "FAILED"}: ${script}`);
    if (code !== 0) bad.push({ part: `verify ${script}`, error: `exit ${code}` });
  }
  return bad;
}

function runNodeTest(list, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...list], { env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
