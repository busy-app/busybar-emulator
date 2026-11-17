// busy-emulator version: the emulator's version, the Node it runs on, this command line's own path, and what it is made
// of (the firmware's commit and API, the app template's generator, the busy-cli of the project in this folder), so
// that one command says what a report is about. `update_available` is the newer version the app has found, if any.
//
// The firmware is the one the emulated BUSY Bar runs, as `status` names it (`firmware: { version, api, alias }`, and here its
// commit): asked of the running emulator. While the emulator does not run, it is the firmware the next start runs,
// and `firmware_source` says which: "chosen" (the one the BUSY Bar was last switched to) or "default" (the latest).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { busyCliVersion, readProject } from "../../projects/node-tools.mjs";
import { firmwaresHere, nextStart, runningFirmware, shownVersion } from "../firmware.mjs";
import { emulatorStatus, ready, updateOf } from "../lifecycle.mjs";
import { pasteForms, selfLines } from "../output.mjs";
import { GENERATOR } from "./create.mjs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The firmware of version's answer: { firmware: { version, api, commit }, source }, source "running" (the BUSY Bar
 * runs it now), "chosen" or "default" (the emulator does not run, and its next start runs it); firmware null when the
 * engine cannot be read.
 */
export async function firmwareFacts(ctx, sys) {
  let status = null;
  try {
    status = await emulatorStatus(ctx, sys);
  } catch {
    status = null;
  }
  const running = status ? await runningFirmware(ctx, sys, status) : null;
  if (running) return { firmware: { version: running.version, api: running.api, commit: running.commit, alias: running.alias }, source: "running" };
  if (status && ready(status)) return { firmware: null, source: "running" };
  const here = await firmwaresHere();
  if (!here) return { firmware: null, source: null };
  const next = nextStart(ctx, sys, here);
  if (!next.firmware) return { firmware: null, source: null };
  return { firmware: { version: next.firmware.version, api: next.firmware.api, commit: next.firmware.commit, alias: next.firmware.alias }, source: next.source };
}

/** The app template's generator: the range the emulator asks for and the version the data folder holds (null before the first create). */
export function generatorFacts(dataDir) {
  const installed = readJson(path.join(dataDir, "tools", "create-app", "node_modules", ...GENERATOR.name.split("/"), "package.json"))?.version;
  return { package: GENERATOR.name, range: GENERATOR.range, installed: typeof installed === "string" ? installed : null };
}

/** The busy-cli installed in the project of `folder` (null when it is no project, or its dependencies are not installed). */
export function busyCliFacts(folder) {
  try {
    if (!existsSync(path.join(folder, "package.json")) || !readProject(folder).project) return null;
    return { project: folder, installed: busyCliVersion(folder) };
  } catch {
    return null;
  }
}

/** The newer version the running app told in its mirror, or null: nothing here asks the network. */
function newerVersion(ctx, sys) {
  try {
    const read = sys.readRunState(ctx.runStateFile);
    return read.state && sys.alive(read.state.pid) ? updateOf(read.state) : null;
  } catch {
    return null;
  }
}

export default {
  name: "version",
  summary: "Print the emulator's version, its Node, the firmware its BUSY Bar runs, the tools it is made of, and the path of this command",
  usage: "version",
  async run(ctx, sys) {
    const paste = pasteForms(ctx.calledAs, ctx.platform);
    const { firmware: facts, source } = await firmwareFacts(ctx, sys);
    const generator = generatorFacts(ctx.dataDir);
    const busyCli = busyCliFacts(process.cwd());
    const update = newerVersion(ctx, sys);
    const lines = [`busy-emulator ${ctx.version ?? "(unknown version)"}${ctx.kind === "release" ? "" : ` (${ctx.kind})`}, Node ${ctx.node}`];
    if (facts) {
      lines.push(`Firmware ${shownVersion(facts)}, API ${facts.api ?? "unknown"}${facts.commit ? `, commit ${facts.commit.slice(0, 8)}` : ""} (${source === "running" ? "running" : "not running; starts on it"})`);
    } else if (source === "running") lines.push("Firmware: the running emulator did not say which.");
    lines.push(`App template ${generator.package} ${generator.installed ?? "(not fetched yet)"}, asked for as ${generator.range}`);
    if (busyCli) lines.push(`busy-cli in ${busyCli.project}: ${busyCli.installed ?? "(dependencies not installed)"}`);
    lines.push(...selfLines(paste));
    if (update) lines.push(`A newer version of the emulator is available: ${update.version} (${update.url}).`);
    return {
      data: { version: ctx.version, kind: ctx.kind, node: ctx.node, app: ctx.appPath, firmware: facts ? { version: facts.version, api: facts.api, alias: facts.alias ?? null, commit: facts.commit } : null, firmware_source: source, create_app: generator, busy_cli: busyCli, update_available: update, cli: { path: ctx.calledAs.length === 1 ? ctx.calledAs[0] : null, argv: ctx.calledAs, ...paste } },
      text: lines.join("\n"),
    };
  },
};
