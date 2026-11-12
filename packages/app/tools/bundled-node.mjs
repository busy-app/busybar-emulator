#!/usr/bin/env node
// The Node inside the app (ADR-0016): one pinned version, taken at build time from the official release archives on
// nodejs.org and checked against the SHA-256 sums recorded in bundled-node.json. Nothing is downloaded while the app runs.
//
//   node tools/bundled-node.mjs pin <version>                     records the version and the sums of its archives
//   node tools/bundled-node.mjs fetch [<target>...] [--cache <dir>]
//                                                                 downloads the archives into the cache and checks them
//   node tools/bundled-node.mjs stage <target> <resources folder> [--cache <dir>]
//                                                                 puts Node into <resources folder>/node
//
// Targets: darwin-arm64, darwin-x64, win32-x64. The cache lies outside the repository: ~/Library/Caches/busy-emulator-
// build/node on macOS, %LOCALAPPDATA%\busy-emulator-build\node on Windows, ~/.cache/busy-emulator-build/node elsewhere.
//
// What goes into the app: the node executable, npm and Node's license. Not the headers, the documentation, corepack,
// and not the links bin/npm and bin/npx or the scripts npm.cmd and npx.cmd: a symbolic link in the bundle fails
// `codesign --verify`, and on Windows npm is started only through the one escaping function of ADR-0012 §6 (EMU-206).
// npm is run as `<node> <npm-cli.js>`; where npm-cli.js lies, layoutOf() says.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const PIN_FILE = path.join(APP_DIR, "bundled-node.json");
export const DIST = "https://nodejs.org/dist/";
export const TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "win32-x64"]);

/** The name nodejs.org gives a target: win32-x64 is "win-x64". */
function distName(target) {
  return target.replace(/^win32-/, "win-");
}

export function archiveName(version, target) {
  return `node-v${version}-${distName(target)}.${target.startsWith("win32-") ? "zip" : "tar.gz"}`;
}

/** Inside the archive, everything lies in one folder of this name. */
export function topFolder(version, target) {
  return `node-v${version}-${distName(target)}`;
}

/** Where the staged files lie inside <resources>/node, as paths relative to it. */
export function layoutOf(target) {
  return target.startsWith("win32-")
    ? { node: "node.exe", npmFolder: "node_modules/npm", npmCli: "node_modules/npm/bin/npm-cli.js", license: "LICENSE" }
    : { node: "bin/node", npmFolder: "lib/node_modules/npm", npmCli: "lib/node_modules/npm/bin/npm-cli.js", license: "LICENSE" };
}

/** SHASUMS256.txt: "<64 hex>  <file name>" per line. */
export function parseShasums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

export function pinFrom(version, shasumsText) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a Node version: ${version}`);
  const sums = parseShasums(shasumsText);
  const archives = {};
  for (const target of TARGETS) {
    const file = archiveName(version, target);
    if (!sums.has(file)) throw new Error(`SHASUMS256.txt of Node ${version} names no ${file}`);
    archives[target] = { file, sha256: sums.get(file) };
  }
  return { version, source: `${DIST}v${version}/`, archives };
}

/** The pinned version; refuses a file that does not say exactly what is needed. */
export function readPin(file = PIN_FILE) {
  const pin = JSON.parse(readFileSync(file, "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(pin.version ?? "")) throw new Error(`${file}: no version`);
  if (pin.source !== `${DIST}v${pin.version}/`) throw new Error(`${file}: the source must be ${DIST}v${pin.version}/`);
  for (const target of TARGETS) {
    const entry = pin.archives?.[target];
    if (entry?.file !== archiveName(pin.version, target) || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? "")) {
      throw new Error(`${file}: the archive for ${target} is missing or malformed`);
    }
  }
  return pin;
}

export function defaultCacheDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "busy-emulator-build", "node");
  if (platform === "win32") return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local"), "busy-emulator-build", "node");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "busy-emulator-build", "node");
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/** Downloads a URL of the official release folder to a file. */
async function httpsDownload(url, file) {
  if (!url.startsWith(DIST)) throw new Error(`Only the official release folder ${DIST} is used, not ${url}`);
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(file));
}

/**
 * The archive for a target in the cache, checked against the pin; downloaded first if it is not there. A file whose
 * sum does not match is removed and refused, never used.
 * @returns {Promise<string>} the archive's path
 */
export async function fetchArchive({ pin, target, cacheDir, download = httpsDownload, log = () => {} }) {
  const entry = pin.archives[target];
  if (!entry) throw new Error(`No pinned Node for ${target}; the targets are ${TARGETS.join(", ")}`);
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

/** The system's tar, by full path: on Windows a program of that name in the current folder must not run instead. */
export function systemTar(platform = process.platform, env = process.env) {
  if (platform === "win32") return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return "/usr/bin/tar";
}

function symbolicLinksIn(folder) {
  const found = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) found.push(full);
    else if (entry.isDirectory()) found.push(...symbolicLinksIn(full));
  }
  return found;
}

/**
 * Unpacks the checked archive's needed files into <resourcesDir>/node, replacing what was there.
 * @returns {{ nodeDir: string, node: string, npmCli: string, license: string, version: string }}
 */
export function stageNode({ pin, target, archive, resourcesDir, tar = systemTar(), host = `${process.platform}-${process.arch}` }) {
  const top = topFolder(pin.version, target);
  const layout = layoutOf(target);
  const work = path.join(resourcesDir, `.node-${process.pid}`);
  const nodeDir = path.join(resourcesDir, "node");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const members = [layout.node, layout.npmFolder, layout.license].map((name) => `${top}/${name}`);
    // tar works in the folder it is started in, on a copy of the archive there under a plain name: no path but
    // ASCII names reaches tar, because tar.exe of Windows does not take paths outside the system's code page (a
    // user's folder with non-Latin letters). Reading a zip from standard input instead is not reliable: that tar.exe
    // then misses members.
    const local = archive.endsWith(".zip") ? "node.zip" : "node.tar.gz";
    copyFileSync(archive, path.join(work, local), constants.COPYFILE_FICLONE);
    try {
      execFileSync(tar, [archive.endsWith(".zip") ? "-xf" : "-xzf", local, ...members], { cwd: work, stdio: ["ignore", "ignore", "pipe"] });
    } catch (e) {
      throw new Error(`${tar} could not unpack ${archive}: ${String(e.stderr ?? e.message).trim()}`);
    }
    const unpacked = path.join(work, top);
    for (const name of [layout.node, layout.npmCli, layout.license]) {
      if (!existsSync(path.join(unpacked, name))) throw new Error(`${archive} has no ${top}/${name}`);
    }
    const links = symbolicLinksIn(unpacked);
    if (links.length) throw new Error(`Node's files hold symbolic links, which fail the code signature check: ${links.join(", ")}`);
    rmSync(nodeDir, { recursive: true, force: true });
    renameSync(unpacked, nodeDir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const node = path.join(nodeDir, layout.node);
  // The one program from the archive this ever runs: the Node just checked against the pin, on its own system.
  if (target === host) {
    const said = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
    if (said !== `v${pin.version}`) throw new Error(`${node} says ${said}, the pin is v${pin.version}`);
  }
  return { nodeDir, node, npmCli: path.join(nodeDir, layout.npmCli), license: path.join(nodeDir, layout.license), version: pin.version };
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
    const url = `${DIST}v${rest[0]}/SHASUMS256.txt`;
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const pin = pinFrom(rest[0], await response.text());
    writeFileSync(PIN_FILE, `${JSON.stringify(pin, null, 2)}\n`);
    console.log(`${PIN_FILE}: Node ${pin.version}`);
  } else if (command === "fetch") {
    const pin = readPin();
    for (const target of rest.length ? rest : TARGETS) console.log(await fetchArchive({ pin, target, cacheDir, log }));
  } else if (command === "stage" && rest.length === 2) {
    const [target, resourcesDir] = rest;
    const pin = readPin();
    const archive = await fetchArchive({ pin, target, cacheDir, log });
    const staged = stageNode({ pin, target, archive, resourcesDir: path.resolve(resourcesDir) });
    console.log(JSON.stringify(staged, null, 2));
  } else {
    console.error("usage: bundled-node.mjs pin <version> | fetch [<target>...] | stage <target> <resources folder>   [--cache <dir>]");
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`bundled-node: ${e.message}`);
    process.exit(1);
  });
}
