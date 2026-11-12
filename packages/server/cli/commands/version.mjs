// busy-emulator version: the emulator's version, the Node it runs on, this command line's own path, and what it is made
// of (the firmware's commit and API, the app template's generator, the busy-cli of the project in this folder), so
// that one command says what a report is about. `update_available` is the newer version the app has found, if any.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { busyCliVersion, readProject } from "../../projects/node-tools.mjs";
import { updateOf } from "../lifecycle.mjs";
import { pasteForms, selfLines } from "../output.mjs";
import { GENERATOR } from "./create.mjs";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "engine");

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The firmware the emulator runs by default: { name, commit, api } from the engine beside the server, or null. */
export function firmwareFacts(engine = ENGINE) {
  const config = readJson(path.join(engine, "firmware.json"));
  const name = config?.default;
  const commit = config?.versions?.[name]?.commit;
  if (!name || !commit) return null;
  const info = readJson(path.join(engine, "build", name, "build-info.json"));
  return { name, commit, api: typeof info?.api === "string" && info.commit === commit ? info.api : null };
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
  summary: "Print the emulator's version, its Node, the firmware and tools it is made of, and the path of this command",
  usage: "version",
  async run(ctx, sys) {
    const paste = pasteForms(ctx.calledAs, ctx.platform);
    const firmware = firmwareFacts();
    const generator = generatorFacts(ctx.dataDir);
    const busyCli = busyCliFacts(process.cwd());
    const update = newerVersion(ctx, sys);
    const lines = [`busy-emulator ${ctx.version ?? "(unknown version)"}${ctx.kind === "release" ? "" : ` (${ctx.kind})`}, Node ${ctx.node}`];
    if (firmware) lines.push(`Firmware ${firmware.name}, commit ${firmware.commit.slice(0, 8)}${firmware.api ? `, API ${firmware.api}` : ""}`);
    lines.push(`App template ${generator.package} ${generator.installed ?? "(not fetched yet)"}, asked for as ${generator.range}`);
    if (busyCli) lines.push(`busy-cli in ${busyCli.project}: ${busyCli.installed ?? "(dependencies not installed)"}`);
    lines.push(...selfLines(paste));
    if (update) lines.push(`A newer version of the emulator is available: ${update.version} (${update.url}).`);
    return {
      data: { version: ctx.version, kind: ctx.kind, node: ctx.node, app: ctx.appPath, firmware, create_app: generator, busy_cli: busyCli, update_available: update, cli: { path: ctx.calledAs.length === 1 ? ctx.calledAs[0] : null, argv: ctx.calledAs, ...paste } },
      text: lines.join("\n"),
    };
  },
};
