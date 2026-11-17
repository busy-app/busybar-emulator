// The firmwares the emulator can run: the versions in emulator/packages/engine/firmware.json. Each has its own runtime
// and screen modules, its own local web and its own API version in emulator/packages/engine/build/<version>: the
// engine's build puts there everything the server takes from the firmware, so the server runs with no firmware
// checkout around. Which one a server runs is said by whoever starts it (startServer's `firmware` in server.mjs);
// nothing here reads the command line or the environment, and nothing is kept between calls.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  if (!info.commit || !info.buildDate || !info.api || !info.appAllowlist || !info.web) {
    throw new FirmwareError("old-build", `The build of firmware "${name}" in ${dir} was made by an older build script: its build-info.json does not record the firmware commit and its date, the API version, what apps may reach and the local web.`, rebuild);
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
    /** The files of /ext/apps_assets this firmware does not have (appsAssetFile). */
    assetsAfter: assetsAfter(name, engine),
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

/**
 * The firmwares of firmware.json as the person chooses among them (EMU-320). A released firmware has a version of
 * numbers and dots; `latest` is the default of firmware.json, `previous` the newest released one below it. Others
 * (dev) are chosen by their name only. However many there are, the list is newest first by version, the others after.
 * Reads firmware.json once, when called; resolve() throws a FirmwareError "unknown-firmware" for a name or alias
 * without a firmware behind it.
 * @returns {{ versions: string[], latest: string, previous: string | null, aliasOf: (name: string) => "latest" |
 *   "previous" | null, summaryOf: (name: string) => string | null, newsOf: (name: string) => string | null, resolve:
 *   (wanted: string) => string }}  newsOf: what the firmware brings an app's author, in one line (the window's list)
 */
export function firmwareChoices(engine = core) {
  const config = JSON.parse(readFileSync(join(engine, "firmware.json"), "utf8"));
  const released = (name) => /^\d+(\.\d+)*$/.test(name);
  const parts = (name) => name.split(".").map(Number);
  const newer = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  };
  const names = Object.keys(config.versions);
  const versions = [...names.filter(released).sort(newer), ...names.filter((name) => !released(name))];
  const latest = config.default;
  const previous = released(latest) ? (versions.find((name) => released(name) && newer(name, latest) > 0) ?? null) : null;
  const aliasOf = (name) => (name === latest ? "latest" : name === previous ? "previous" : null);
  const resolve = (wanted) => {
    const name = wanted === "latest" ? latest : wanted === "previous" ? previous : wanted;
    if (name && config.versions[name]) return name;
    const have = versions.map((v) => (aliasOf(v) ? `${v} (${aliasOf(v)})` : v)).join(", ");
    const why = wanted === "previous" ? "This emulator has no released firmware older than the latest." : `This emulator has no firmware ${JSON.stringify(String(wanted))}.`;
    throw new FirmwareError("unknown-firmware", why, `It has: ${have}.`);
  };
  return { versions, latest, previous, aliasOf, summaryOf: (name) => config.versions[name]?.summary ?? null, newsOf: (name) => config.versions[name]?.news ?? null, resolve };
}

/** /ext/apps_assets, the same for all versions: shared fonts, images and animations, and the system apps' own. */
export const appsAssets = join(core, "build", "apps-assets");

/**
 * The files of /ext/apps_assets (paths in build/apps-assets) that a later release than `name` added: apps-assets.json
 * says since which release ("since"). A firmware whose name is not a release number (a build of its own) has them all.
 */
function assetsAfter(name, engine) {
  const file = join(engine, "apps-assets.json");
  const release = (version) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number) ?? null;
  const own = release(name);
  if (!own || !existsSync(file)) return new Set();
  const older = (a, b) => {
    const i = a.findIndex((n, k) => n !== b[k]);
    return i >= 0 && a[i] < b[i];
  };
  const files = JSON.parse(readFileSync(file, "utf8")).files;
  return new Set(Object.keys(files).filter((path) => files[path].since && release(files[path].since) && older(own, release(files[path].since))));
}

/**
 * The file in build/apps-assets that /ext/apps_assets/`path` names on the BUSY Bar running `firmware`, or null: a path
 * outside the folder, or a file that firmware does not have (it came with a later release). `firmware` is read when
 * this is called, so a BUSY Bar switched to another firmware sees that firmware's files.
 */
export function appsAssetFile(firmware, path) {
  const file = resolve(appsAssets, path);
  if (file !== appsAssets && !file.startsWith(appsAssets + sep)) return null;
  // In any letter case: on macOS and Windows the file system finds the file whatever the case of the name, and a BUSY
  // Bar with a firmware before the file's release has it in none.
  const named = relative(appsAssets, file).split(sep).join("/").toLowerCase();
  return [...(firmware.assetsAfter ?? [])].some((later) => later.toLowerCase() === named) ? null : file;
}
