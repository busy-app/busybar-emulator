#!/usr/bin/env node
// GitHub CLI inside the app (Publish stage 2, src/github/gh.mjs): one pinned release of github.com/cli/cli, taken at
// build time from the release's archives and checked against the SHA-256 sums recorded in bundled-gh.json, which come
// from the release's own checksums file. Nothing is downloaded while the app runs. gh is put in unchanged: on macOS
// it keeps GitHub's signature and notarisation (Developer ID Application: GitHub, team VEKTX9H2N7), which the
// packaging's ad hoc signature of the bundle does not replace (it signs code in Contents/Resources as data).
//
//   node tools/bundled-gh.mjs pin <version>                       records the version and the sums of its archives,
//                                                                 from gh_<version>_checksums.txt of the release
//   node tools/bundled-gh.mjs fetch [<target>...] [--cache <dir>] downloads the archives into the cache and checks them
//   node tools/bundled-gh.mjs stage <target> <resources folder> [--cache <dir>]
//                                                                 puts gh into <resources folder>/gh
//
// Targets: darwin-arm64, darwin-x64, win32-x64. The cache lies beside Node's (bundled-node.mjs): ~/Library/Caches/
// busy-emulator-build/gh on macOS, %LOCALAPPDATA%\busy-emulator-build\gh on Windows.
//
// What goes into the app: <resources>/gh/bin/gh (gh.exe on Windows) and gh's LICENSE. Not its manual pages.
import { execFileSync } from "node:child_process";
import { constants, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { defaultCacheDir as nodeCacheDir, sha256File, systemTar } from "./bundled-node.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PIN_FILE = path.join(APP_DIR, "bundled-gh.json");
export const RELEASES = "https://github.com/cli/cli/releases/download/";
export const TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "win32-x64"]);
/** GitHub's team in the signature of gh for macOS. */
export const GITHUB_TEAM = "VEKTX9H2N7";

/** The name the release gives a target's archive. */
export function archiveName(version, target) {
  const name = { "darwin-arm64": "macOS_arm64", "darwin-x64": "macOS_amd64", "win32-x64": "windows_amd64" }[target];
  if (!name) throw new Error(`No gh for ${target}; the targets are ${TARGETS.join(", ")}`);
  return `gh_${version}_${name}.zip`;
}

export const checksumsName = (version) => `gh_${version}_checksums.txt`;

/** Inside the archive: macOS's lie in one folder named like the archive, Windows's at the top. */
export function membersOf(version, target) {
  if (target.startsWith("win32-")) return { gh: "bin/gh.exe", license: "LICENSE" };
  const top = archiveName(version, target).replace(/\.zip$/, "");
  return { gh: `${top}/bin/gh`, license: `${top}/LICENSE` };
}

/** Where the staged files lie inside <resources>/gh. */
export function layoutOf(target) {
  return { gh: target.startsWith("win32-") ? "bin/gh.exe" : "bin/gh", license: "LICENSE" };
}

/** The release's checksums file: "<64 hex>  <file name>" per line. */
export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

export function pinFrom(version, checksumsText) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a gh version: ${version}`);
  const sums = parseChecksums(checksumsText);
  const archives = {};
  for (const target of TARGETS) {
    const file = archiveName(version, target);
    if (!sums.has(file)) throw new Error(`${checksumsName(version)} names no ${file}`);
    archives[target] = { file, sha256: sums.get(file) };
  }
  return { version, source: `${RELEASES}v${version}/`, checksums: checksumsName(version), archives };
}

/** The pinned version; refuses a file that does not say exactly what is needed. */
export function readPin(file = PIN_FILE) {
  const pin = JSON.parse(readFileSync(file, "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? "")) throw new Error(`${file}: no version`);
  if (pin.source !== `${RELEASES}v${pin.version}/`) throw new Error(`${file}: the source must be ${RELEASES}v${pin.version}/`);
  if (pin.checksums !== checksumsName(pin.version)) throw new Error(`${file}: the checksums file must be ${checksumsName(pin.version)}`);
  for (const target of TARGETS) {
    const entry = pin.archives?.[target];
    if (entry?.file !== archiveName(pin.version, target) || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "")) throw new Error(`${file}: the archive for ${target} is missing or malformed`);
  }
  return pin;
}

export function defaultCacheDir(options) {
  return path.join(path.dirname(nodeCacheDir(options)), "gh");
}

/** Downloads a file of the pinned release. Only github.com/cli/cli's release downloads are used. */
async function httpsDownload(url, file) {
  if (!url.startsWith(RELEASES)) throw new Error(`Only the releases of github.com/cli/cli are used, not ${url}`);
  // GitHub answers a release download with a redirect to its storage for release files.
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const host = new URL(response.url).hostname;
  if (host !== "github.com" && host !== "objects.githubusercontent.com" && host !== "release-assets.githubusercontent.com") throw new Error(`${url} came from ${host}, not GitHub's storage for release files`);
  await pipeline(response.body, createWriteStream(file));
}

/**
 * The archive for a target in the cache, checked against the pin; downloaded first if it is not there. A file whose
 * sum does not match is removed and refused, never used.
 * @returns {Promise<string>} the archive's path
 */
export async function fetchArchive({ pin, target, cacheDir, download = httpsDownload, log = () => {} }) {
  const entry = pin.archives[target];
  if (!entry) throw new Error(`No pinned gh for ${target}; the targets are ${TARGETS.join(", ")}`);
  const file = path.join(cacheDir, entry.file);
  if (!existsSync(file)) {
    mkdirSync(cacheDir, { recursive: true });
    const partial = `${file}.${process.pid}.part`;
    log(`downloading ${pin.source}${entry.file}`);
    try {
      await download(`${pin.source}${entry.file}`, partial);
      renameSync(partial, file);
    } finally {
      rmSync(partial, { force: true });
    }
  }
  const actual = await sha256File(file);
  if (actual !== entry.sha256) {
    rmSync(file, { force: true });
    throw new Error(`${entry.file}: SHA-256 is ${actual}, the pin says ${entry.sha256}. The file was removed; nothing was unpacked.`);
  }
  return file;
}

/** The environment gh is checked with: nothing of the caller's that would make it read a token or a configuration. */
export function checkEnvironment(configDir, platform = process.platform, env = process.env) {
  const keep = platform === "win32" ? ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH"] : ["HOME", "TMPDIR"];
  const out = {};
  for (const name of keep) if (env[name]) out[name] = env[name];
  out.PATH = platform === "win32" ? path.win32.join(env.SystemRoot || "C:\\Windows", "System32") : "/usr/bin:/bin";
  return Object.assign(out, { GH_CONFIG_DIR: configDir, XDG_STATE_HOME: configDir, XDG_DATA_HOME: configDir, XDG_CACHE_HOME: configDir, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_TELEMETRY: "0", NO_COLOR: "1" });
}

/** What `gh --version` says for the pinned version: "gh version 2.103.3 (2026-10-26)". */
export const versionLine = (version) => new RegExp(`^gh version ${version.replace(/\./g, "\\.")} \\(\\d{4}-\\d{2}-\\d{2}\\)$`);

/**
 * Unpacks the checked archive's gh and LICENSE into <resourcesDir>/gh, replacing what was there; on its own system it
 * runs gh --version and checks the version.
 * @returns {{ ghDir: string, gh: string, license: string, version: string }}
 */
export function stageGh({ pin, target, archive, resourcesDir, tar = systemTar(), host = `${process.platform}-${process.arch}` }) {
  const members = membersOf(pin.version, target);
  const layout = layoutOf(target);
  const work = path.join(resourcesDir, `.gh-${process.pid}`);
  const ghDir = path.join(resourcesDir, "gh");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    // As for Node: tar works on a copy under a plain name in the folder it starts in (tar.exe of Windows takes no path
    // outside the system's code page). The system's tar reads zip archives on macOS and on Windows 10 and later.
    copyFileSync(archive, path.join(work, "gh.zip"), constants.COPYFILE_FICLONE);
    try {
      execFileSync(tar, ["-xf", "gh.zip", members.gh, members.license], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      throw new Error(`${tar} could not unpack ${archive}: ${String(e.stderr ?? e.message).trim()}`);
    }
    for (const name of [members.gh, members.license]) if (!existsSync(path.join(work, ...name.split("/")))) throw new Error(`${archive} has no ${name}`);
    const staged = path.join(work, "staged");
    mkdirSync(path.join(staged, "bin"), { recursive: true });
    renameSync(path.join(work, ...members.gh.split("/")), path.join(staged, ...layout.gh.split("/")));
    renameSync(path.join(work, ...members.license.split("/")), path.join(staged, layout.license));
    rmSync(ghDir, { recursive: true, force: true });
    renameSync(staged, ghDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const gh = path.join(ghDir, ...layout.gh.split("/"));
  // The one program from the archive this runs: the gh just checked against the pin, on its own system, with a
  // configuration folder of its own that is removed after.
  if (target === host) {
    const config = path.join(resourcesDir, `.gh-check-${process.pid}`);
    try {
      const said = execFileSync(gh, ["--version"], { encoding: "utf8", env: checkEnvironment(config), windowsHide: true }).split(/\r?\n/)[0].trim();
      if (!versionLine(pin.version).test(said)) throw new Error(`${gh} says ${said}, the pin is ${pin.version}`);
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  }
  return { ghDir, gh, license: path.join(ghDir, layout.license), version: pin.version };
}

function optionValue(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const value = args[at + 1];
  args.splice(at, 2);
  if (!value) throw new Error(`${name} needs a value`);
  return value;
}

async function main(argv) {
  const args = [...argv];
  const cacheDir = path.resolve(optionValue(args, "--cache") ?? defaultCacheDir());
  const [command, ...rest] = args;
  const log = (line) => console.error(line);
  if (command === "pin" && rest.length === 1) {
    mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, checksumsName(rest[0]));
    await httpsDownload(`${RELEASES}v${rest[0]}/${checksumsName(rest[0])}`, file);
    const pin = pinFrom(rest[0], readFileSync(file, "utf8"));
    writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`${PIN_FILE}: gh ${pin.version}`);
  } else if (command === "fetch") {
    const pin = readPin();
    for (const target of rest.length ? rest : TARGETS) console.log(await fetchArchive({ pin, target, cacheDir, log }));
  } else if (command === "stage" && rest.length === 2) {
    const [target, resourcesDir] = rest;
    const pin = readPin();
    const archive = await fetchArchive({ pin, target, cacheDir, log });
    console.log(JSON.stringify(stageGh({ pin, target, archive, resourcesDir: path.resolve(resourcesDir) }), null, 2));
  } else {
    console.error("usage: bundled-gh.mjs pin <version> | fetch [<target>...] | stage <target> <resources folder>   [--cache <dir>]");
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`bundled-gh: ${e.message}`);
    process.exit(1);
  });
}
