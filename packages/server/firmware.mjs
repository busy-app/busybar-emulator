// The firmwares the emulator can run: the versions in emulator/packages/engine/firmware.json. Each has its own runtime
// and screen modules, its own local web and its own API version in emulator/packages/engine/build/<version>: the
// engine's build puts there everything the server takes from the firmware, so the server runs with no firmware
// checkout around. Which one a server runs is said by whoever starts it (startServer's `firmware` in server.mjs);
// nothing here reads the command line or the environment, and nothing is kept between calls.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { filesIn } from "../engine/checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const core = resolve(here, "../engine");

/**
 * A firmware the emulator cannot run. `code` names the reason (unknown-firmware, not-built, old-build, other-commit,
 * web-not-whole); `message` is one line: what is wrong and what to do.
 */
export class FirmwareError extends Error {
  constructor(code, problem, advice) {
    super(`${problem} ${advice}`);
    this.name = "FirmwareError";
    this.code = code;
  }
}

/**
 * The firmware `name` (the default of firmware.json when not given) as the engine in `engine` has it built: what the
 * server needs to know to run it. Reads nothing but that folder and keeps nothing: every call checks the build again.
 * Throws a FirmwareError when the build is not there or is not the one firmware.json names.
 */
export function loadFirmware(name, engine = core) {
  const config = JSON.parse(readFileSync(join(engine, "firmware.json"), "utf8"));
  name ||= config.default;
  if (!config.versions[name]) {
    throw new FirmwareError("unknown-firmware", `Unknown firmware "${name}".`, `The emulator has: ${Object.keys(config.versions).join(", ")} (emulator/packages/engine/firmware.json).`);
  }
  const dir = join(engine, "build", name);
  const rebuild = `Build it again: node emulator/packages/engine/build.mjs --firmware ${name} (needs emsdk and a firmware checkout: --emsdk <path>, --firmware-repo <path>).`;
  if (!existsSync(join(dir, "build-info.json"))) {
    throw new FirmwareError("not-built", `Firmware "${name}" is not built: there is no build-info.json in ${dir}.`, rebuild);
  }
  const info = JSON.parse(readFileSync(join(dir, "build-info.json"), "utf8"));
  const { commit, summary } = config.versions[name];
  if (!info.commit || !info.buildDate || !info.api || !info.web) {
    throw new FirmwareError("old-build", `The build of firmware "${name}" in ${dir} was made by an older build script: its build-info.json does not record the firmware commit and its date, the API version and the local web.`, rebuild);
  }
  if (info.commit !== commit) {
    throw new FirmwareError("other-commit", `The build of firmware "${name}" in ${dir} was made from firmware commit ${info.commit}, and firmware.json names ${commit}.`, rebuild);
  }
  // The local web has to be whole: a build that stopped half-way, or a copy of the folder that lost files, is not served.
  const web = join(dir, "web");
  const webFiles = filesIn(web).length;
  if (webFiles !== info.web.files) {
    throw new FirmwareError("web-not-whole", `The local web of firmware "${name}" in ${web} is not whole: ${webFiles} of ${info.web.files} files.`, rebuild);
  }
  // The API documentation the same way, when the build made it (build.mjs, buildDocs); a build without it serves no /docs.
  const docs = join(dir, "docs");
  if (info.docs && filesIn(docs).length !== info.docs.files) {
    throw new FirmwareError("web-not-whole", `The API documentation of firmware "${name}" in ${docs} is not whole: ${filesIn(docs).length} of ${info.docs.files} files.`, rebuild);
  }
  return {
    name,
    commit,
    /** What this firmware is, for the person using the emulator: the tooltip of the device window's firmware badge. */
    summary,
    dir,
    info,
    /** The API version this firmware reports, as in its own sources. */
    apiVersion: info.api,
    /** The build date this firmware reports: the date of its commit, by the rule of the firmware's own build script (not checked on a bar). */
    buildDate: info.buildDate,
    /** This firmware's local web, as it ships it. */
    web,
    /** This firmware's API documentation as its build makes it (openapi.yaml and the Swagger UI page), or null. */
    docs: info.docs ? docs : null,
    versions: Object.keys(config.versions),
  };
}

/** /ext/apps_assets, the same for all versions: shared fonts, images and animations, and the system apps' own. */
export const appsAssets = join(core, "build", "apps-assets");
