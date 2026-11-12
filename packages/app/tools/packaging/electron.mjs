// Electron for a build target. For this system's own target it is the installed electron package's (fetched and
// checked against its checksums when the package was installed). For the other architecture of macOS the same
// release's archive is taken from Electron's releases on GitHub, checked against the SHA-256 the installed package
// records for it (node_modules/electron/checksums.json; the package itself is pinned by package-lock.json), kept in
// the build's cache and unpacked anew for every build. Nothing of that archive is run by the build.
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { sha256File } from "../bundled-node.mjs";
import { APP_DIR } from "./composition.mjs";
import { targetOfHost } from "./names.mjs";

export const ELECTRON_RELEASES = "https://github.com/electron/electron/releases/download/";

/** The Electron package.json pins, and the installed package's own folder for this system. */
export function installedElectron(appDir = APP_DIR) {
  const dist = path.join(appDir, "node_modules", "electron", "dist");
  const pinned = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")).devDependencies.electron;
  const installed = existsSync(path.join(dist, "version")) ? readFileSync(path.join(dist, "version"), "utf8").trim() : null;
  if (installed !== pinned) throw new Error(`The installed Electron is ${installed ?? "not there"}, package.json pins ${pinned}: run npm ci and node node_modules/electron/install.js`);
  return { dist, version: pinned };
}

export function electronArchiveName(version, target) {
  return `electron-v${version}-${target}.zip`;
}

/** The sum the installed electron package records for an archive of its own release. */
export function electronSum(version, target, appDir = APP_DIR) {
  const file = path.join(appDir, "node_modules", "electron", "checksums.json");
  if (!existsSync(file)) throw new Error(`${file} is not there: run npm ci`);
  const sum = JSON.parse(readFileSync(file, "utf8"))[electronArchiveName(version, target)];
  if (!/^[0-9a-f]{64}$/.test(sum ?? "")) throw new Error(`${file} records no sum for ${electronArchiveName(version, target)}`);
  return sum;
}

async function httpsDownload(url, file) {
  if (!url.startsWith(ELECTRON_RELEASES)) throw new Error(`Only Electron's releases ${ELECTRON_RELEASES} are used, not ${url}`);
  // GitHub answers with a redirect to where the file lies; what arrives is checked against the recorded sum.
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(file));
}

/**
 * Electron's archive for a target in the cache, checked against the recorded sum; downloaded first if it is not
 * there. A file whose sum does not match is removed and refused, never unpacked.
 * @returns {Promise<string>} the archive's path
 */
export async function fetchElectron({ version, target, cacheDir, sum = electronSum(version, target), download = httpsDownload, log = () => {} }) {
  const name = electronArchiveName(version, target);
  const folder = path.join(cacheDir, "electron");
  const file = path.join(folder, name);
  if (!existsSync(file)) {
    mkdirSync(folder, { recursive: true });
    const partial = `${file}.${process.pid}.part`;
    const url = `${ELECTRON_RELEASES}v${version}/${name}`;
    log(`downloading ${url}`);
    try {
      await download(url, partial);
      renameSync(partial, file);
    } finally {
      rmSync(partial, { force: true });
    }
  }
  const actual = await sha256File(file);
  if (actual !== sum) {
    rmSync(file, { force: true });
    throw new Error(`${name}: SHA-256 is ${actual}, the electron package records ${sum}. The file was removed; nothing was unpacked.`);
  }
  return file;
}

/** Unpacks a checked archive of Electron for macOS into <to>: Electron.app, its licenses and its version beside it. */
export function unpackElectron({ archive, to, version }) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  // ditto keeps the links of the frameworks.
  execFileSync("/usr/bin/ditto", ["-x", "-k", archive, to], { stdio: ["ignore", "ignore", "pipe"] });
  const said = existsSync(path.join(to, "version")) ? readFileSync(path.join(to, "version"), "utf8").trim() : null;
  if (said !== version) throw new Error(`${archive} holds Electron ${said ?? "without a version"}, expected ${version}`);
  for (const name of ["Electron.app", "LICENSE", "LICENSES.chromium.html"]) if (!existsSync(path.join(to, name))) throw new Error(`${archive} holds no ${name}`);
  return to;
}

/**
 * Electron's folder for a target: the installed package's for this system's own, a fresh unpack of the checked
 * archive in <scratch> for macOS's other architecture.
 * @returns {Promise<{ dist: string, version: string, from: string }>}
 */
export async function electronFor({ target, scratch, cacheDir, host = targetOfHost(), log = () => {} }) {
  const { dist, version } = installedElectron();
  if (target === host) return { dist, version, from: "the installed electron package" };
  if (!target.startsWith("darwin-") || !host.startsWith("darwin-")) throw new Error(`Electron for ${target} is not taken on ${host}: each system builds its own, a Mac both of macOS`);
  const archive = await fetchElectron({ version, target, cacheDir, log });
  log(`unpacking ${path.basename(archive)}`);
  return { dist: unpackElectron({ archive, to: scratch, version }), version, from: `${ELECTRON_RELEASES}v${version}/${path.basename(archive)}` };
}

const CPU = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

/**
 * The architecture a Mach-O program is for, read from its header: "arm64", "x64", "universal" for a program of
 * several, null for a file that is no 64-bit Mach-O program. No tool of the system is asked (lipo comes with Xcode).
 */
export function machoArch(file) {
  const header = Buffer.alloc(8);
  const fd = openSync(file, "r");
  try {
    if (readSync(fd, header, 0, 8, 0) < 8) return null;
  } finally {
    closeSync(fd);
  }
  const magic = header.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) return "universal";
  if (magic !== 0xcffaedfe) return null;
  return CPU.get(header.readUInt32LE(4)) ?? null;
}

/** Whether this Mac runs programs of a target: its own, and on Apple Silicon Intel's when Rosetta is installed. */
export function runsHere(target, host = targetOfHost()) {
  if (target === host) return true;
  if (host !== "darwin-arm64" || target !== "darwin-x64") return false;
  try {
    return execFileSync("/usr/bin/arch", ["-x86_64", "/usr/bin/uname", "-m"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "x86_64";
  } catch {
    return false;
  }
}
