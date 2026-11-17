// busy-emulator firmware [use <latest|previous|version>]: the firmware of the emulated BUSY Bar (EMU-321, epic E12).
//
//   firmware              the firmware the BUSY Bar runs, the ones this emulator has with their API and the marks
//                         latest and previous, and the one chosen for its next restart, if the window chose one. While
//                         the emulator does not run: the firmware its next start runs, the one the BUSY Bar was last
//                         switched to, or else the latest.
//   firmware use <which>  switches now: the BUSY Bar restarts on that firmware, and the command answers once its API
//                         answers again. <which> is latest, previous or a version that `firmware` lists.
//
// One BUSY Bar whatever the firmware, as a real one keeps its apps when its firmware is replaced: the apps, their data
// and settings stay; the app that ran stops, as at any restart. The choice is kept in the data folder, and the next
// start runs it. Nothing here touches a real BUSY Bar or the emulator app itself. `use` needs the emulator running
// (not_running otherwise); the switch is its server's (POST /_emu/firmware on the management address, with the
// server's key), and the server's refusals keep their codes: firmware_unknown, firmware_switching, firmware_start_failed.
import { askEmulator, firmwaresHere, named, nextStart, runningFirmware, shownVersion } from "../firmware.mjs";
import { commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

const USAGE = "firmware [use <latest|previous|version>]";
/** How long a switch may take: the server waits up to 10 s for a quiet moment, then the BUSY Bar starts again. */
const SWITCH_WAIT_MS = 60_000;
/** After the switch, how many times the BUSY Bar's API is asked, and how long apart. */
const PROBES = 20;
const PROBE_GAP_MS = 250;

/** The list as a person reads it: version, mark, API, and which one runs. */
function rows(firmwares) {
  const width = Math.max(...firmwares.map((one) => one.version.length));
  return firmwares.map((one) => {
    const state = one.available === false ? "  not in this copy of the emulator" : one.running ? "  running" : "";
    return `  ${one.version.padEnd(width)}  ${(one.alias ?? "").padEnd(8)}  API ${one.api ?? "unknown"}${state}`;
  });
}

const listed = (one, running) => ({ version: one.version, api: one.api ?? null, alias: one.alias ?? null, summary: one.summary ?? null, running, available: one.available !== false });

/** The one to offer next: back to the latest, or else the previous. */
function other(firmware, firmwares) {
  if (firmware?.alias !== "latest") return firmwares.some((one) => one.alias === "latest") ? "latest" : null;
  return firmwares.some((one) => one.alias === "previous" && one.available !== false) ? "previous" : null;
}

/** The lines about a firmware that is not the latest: the catalog checks against the latest's API, and the way back. */
function notLatest(firmware, firmwares, self) {
  const latest = firmwares.find((one) => one.alias === "latest");
  if (!latest || firmware?.alias === "latest") return [];
  return [`The catalog checks apps against ${latest.version}, API ${latest.api}. Back:`, `  ${self} firmware use latest`];
}

async function show(ctx, sys, self) {
  const status = await emulatorStatus(ctx, sys);
  if (status.running && !ready(status)) {
    throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, `Wait a moment and run ${self} firmware again, or ${self} status.`, { state: status.state ?? null });
  }
  if (!status.running) {
    const here = await firmwaresHere();
    if (!here) throw new CliError("firmware_unknown", "This copy of the emulator cannot read its own firmwares (packages/engine/firmware.json).", `Start the emulator with ${self} start, then run ${self} firmware again.`);
    const next = nextStart(ctx, sys, here);
    const firmwares = here.firmwares.map((one) => listed(one, false));
    const offer = other(next.firmware, firmwares);
    const lines = [
      `The emulator is not running. It starts on firmware ${shownVersion(next.firmware)}, API ${next.firmware.api ?? "unknown"}${next.source === "chosen" ? ", the one it was last switched to" : ""}.`,
      ...rows(firmwares),
      ...(offer ? [`To switch: ${self} start, then ${self} firmware use ${offer}`] : []),
    ];
    return { data: { running: false, firmware: named(next.firmware), starts_with: next.source, firmwares, pending: null }, text: lines.join("\n") };
  }
  let body;
  try {
    const answer = await askEmulator(ctx, sys, status, { again: `${self} firmware` });
    body = answer.body;
    if (answer.status !== 200 || typeof body?.firmware?.version !== "string" || !Array.isArray(body.firmwares)) {
      throw new CliError("no_management", `The emulator did not say its firmware (HTTP ${answer.status}).`, `Run ${self} quit, then ${self} start, then ${self} firmware again.`);
    }
  } catch (e) {
    // The management address cannot be asked (its lock or key cannot be read here): the BUSY Bar's own answer and the
    // engine's list say what runs; what is chosen for the next restart stays unknown.
    if (!(e instanceof CliError)) throw e;
    body = await withoutManagement(ctx, sys, status, e);
    if (!body) throw e;
  }
  const firmware = named(body.firmware);
  const firmwares = body.firmwares.map((one) => listed(one, one.running === true));
  const pending = named(body.pending);
  const offer = other(firmware, firmwares);
  const lines = [
    `The emulated BUSY Bar runs firmware ${shownVersion(firmware)}, API ${firmware.api}.`,
    ...(body.switching ? [`It is switching to firmware ${body.switching.to} now.`] : []),
    ...rows(firmwares),
    ...(pending ? [`Chosen for the next restart: ${shownVersion(pending)}. ${self} restart-bar applies it.`] : []),
    ...(body.notice ? [body.notice] : []),
    ...(body.unknown ? [`Whether a firmware is chosen for its next restart could not be read: ${body.unknown}`] : []),
    ...notLatest(firmware, firmwares, self),
    ...(offer && !notLatest(firmware, firmwares, self).length ? [`Switch: ${self} firmware use ${offer}`] : []),
  ];
  // pending_unknown: why the one chosen for the next restart could not be read (the management address could not be asked).
  return { data: { running: true, firmware, firmwares, pending, switching: body.switching?.to ?? null, notice: body.notice ?? null, ...(body.unknown ? { pending_unknown: body.unknown } : {}) }, text: lines.join("\n") };
}

/** What `firmware` shows when the management address cannot be asked, or null when the BUSY Bar does not say either. */
async function withoutManagement(ctx, sys, status, why) {
  const { askFirmware: _unused, ...plain } = sys;
  const running = await runningFirmware(ctx, plain, status);
  const here = await firmwaresHere();
  if (!running || !here) return null;
  const firmwares = here.firmwares.map((one) => ({ ...one, running: one.version === running.version }));
  const alias = here.firmwares.find((one) => one.version === running.version)?.alias ?? null;
  return { firmware: { ...running, alias }, firmwares, switching: null, pending: null, notice: null, unknown: why.message.replace(/\.$/, "") + "." };
}

/** The server's refusal of a switch, with its code kept. */
function refused(answer, which, self) {
  const again = `${self} firmware use ${which}`;
  const body = answer.body ?? {};
  const said = typeof body.error === "string" ? body.error : `HTTP ${answer.status}`;
  switch (body.code) {
    case "firmware_unknown":
      return new CliError("firmware_unknown", said, `${self} firmware lists the firmwares of this emulator; give latest, previous or one of their versions.`, { argument: which });
    case "firmware_switching":
      return new CliError("firmware_switching", said, body.hint ?? `Wait a moment, then run ${again} again.`, { argument: which });
    case "firmware_start_failed":
      return new CliError("firmware_start_failed", said, `${body.hint ? `${body.hint} ` : ""}${self} logs says more.`, { argument: which, firmware: named(body.firmware) });
    case "usage":
      return new CliError("usage", said, `Usage: ${self} ${USAGE}`, { argument: which });
    case "stopped":
      return new CliError("not_running", "The emulator is stopping, so its BUSY Bar cannot switch firmware.", `Start it with ${self} start, then run ${again} again.`);
    default:
      return new CliError("firmware_failed", `The emulator did not switch the BUSY Bar's firmware: ${said}.`, `${self} logs says what happened; ${self} firmware says what runs now.`, { argument: which });
  }
}

async function use(ctx, sys, self, which, progress) {
  const again = `${self} firmware use ${which}`;
  const status = await emulatorStatus(ctx, sys);
  if (!ready(status)) {
    const hint = `Start it with ${self} start, then run ${again}.`;
    if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar to switch to another firmware.", hint);
    throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, `Wait a moment and run ${again} again, or ${self} status.`, { state: status.state ?? null });
  }
  const from = sys.now();
  // What there is and what runs: the switch is said only when it is one (a firmware this emulator has, not the one
  // that runs). The server decides all the same.
  const known = await askEmulator(ctx, sys, status, { again });
  const firmwares = Array.isArray(known.body?.firmwares) ? known.body.firmwares : [];
  const wanted = firmwares.find((one) => (which === "latest" || which === "previous" ? one.alias === which : one.version === which));
  if (wanted && !wanted.running) progress(`Switching the emulated BUSY Bar's firmware to ${which}`);
  const answer = await askEmulator(ctx, sys, status, { method: "POST", body: { version: which, when: "now" }, waitMs: SWITCH_WAIT_MS, again });
  if (answer.status !== 200 || typeof answer.body?.firmware?.version !== "string") throw refused(answer, which, self);
  const body = answer.body;
  const firmware = named(body.firmware);
  const before = named(body.from) ?? firmware;
  const data = { firmware, from: before, changed: body.changed === true, ms: 0, switch_ms: Number.isFinite(body.ms) ? body.ms : null, pending: named(body.pending) };
  if (!data.changed) {
    data.ms = sys.now() - from;
    return { data, text: `The emulated BUSY Bar already runs firmware ${shownVersion(firmware)}, API ${firmware.api}.` };
  }
  // Up: the BUSY Bar's own API answers again, with the API of the firmware it runs now.
  let up = false;
  for (let n = 0; n < PROBES && !up; n++) {
    if (n) await sys.sleep(PROBE_GAP_MS);
    const probe = await sys.barGet(status.port, "/api/version");
    try {
      up = probe.status === 200 && JSON.parse(probe.body).api_semver === firmware.api;
    } catch {
      up = false;
    }
  }
  if (!up) throw new CliError("firmware_start_failed", `The emulated BUSY Bar switched to firmware ${firmware.version}, but its API does not answer.`, `${self} logs says what happened; ${self} restart-bar starts it again.`, { argument: which, firmware });
  data.ms = sys.now() - from;
  const lines = [
    `The emulated BUSY Bar runs firmware ${shownVersion(firmware)}, API ${firmware.api}, and keeps it after restarts. Switched in ${data.ms < 1000 ? `${data.ms} ms` : `${(data.ms / 1000).toFixed(1)} s`}.`,
    "Apps and their settings stay; the running app stopped.",
    ...notLatest(firmware, firmwares, self),
  ];
  return { data, text: lines.join("\n") };
}

export default {
  name: "firmware",
  summary: "Switches the emulated BUSY Bar to another firmware. Apps, their data and settings stay. Does not update the emulator app (that is `update`) and touches no real BUSY Bar",
  usage: USAGE,
  maxArguments: 2,
  options: {},
  details: [
    "firmware             which firmware the BUSY Bar runs, and the others with their API.",
    "firmware use <which> switch now (latest, previous or a version) and wait until the BUSY Bar answers.",
  ],
  async run(ctx, sys, { args, progress }) {
    const self = commandLine(ctx);
    if (args.length === 0) return show(ctx, sys, self);
    if (args[0] !== "use") {
      throw new CliError("usage", `firmware has no action ${JSON.stringify(args[0])}: it is use, or none to show the firmware.`, `Usage: ${self} ${USAGE}. For example: ${self} firmware use previous.`, { argument: args[0] });
    }
    if (args.length < 2) throw new CliError("usage", "firmware use needs a firmware: latest, previous or a version.", `Usage: ${self} ${USAGE}. ${self} firmware lists them.`);
    return use(ctx, sys, self, args[1], progress);
  },
};
