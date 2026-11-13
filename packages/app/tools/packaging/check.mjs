// The check of the produced files of a release (EMU-203). It opens no window: the app itself is never started (a
// release takes the user's own folders and shows its window; that is EMU-017's smoke test). What it runs are the
// programs inside the app that have no window: the bundled Node, the command line, the server.
//
// For every file present: its name is one of the release's, its sum matches SHA256SUMS, and inside it the fuses, the
// app's archive (its list, the marker, the integrity hash), the resources (by the list of composition.mjs) and, on
// macOS, the signature, Info.plist and the architecture of every program against the one the file is named for. For
// the files of this system also: the bundled Node runs and says its version, the command line says it is a release,
// and the server answers from a read-only copy of the app. A Mac with Apple Silicon runs the files for Intel Macs as
// well, under Rosetta; where they cannot be run they are read, and the check says they were not run.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkEnvironment, GITHUB_TEAM, readPin as readGhPin, versionLine } from "../bundled-gh.mjs";
import { readPin } from "../bundled-node.mjs";
import { NOTICES_FILE, noticesText } from "../notices/notices.mjs";
import { listArchive, loadAsar, unpackedInArchive } from "./app-archive.mjs";
import { APP_DIR, archiveEntries, archiveProblems, emulatorFiles, emulatorProblems, missingImports, UNPACKED_IN_ARCHIVE } from "./composition.mjs";
import { machoArch, runsHere } from "./electron.mjs";
import { fuseFileOf, fuseProblems, fuseTable, readFuseWire } from "./fuses.mjs";
import { icnsProblems, ICNS_SOURCE, MAC_ICON_FILE } from "./icon.mjs";
import { ALL_RELEASE_FILES, APP_BUNDLE, RELEASE_FILES, SUMS_FILE, targetOfFile, targetOfHost, targetsBuiltOn, WINDOWS_EXE } from "./names.mjs";
import { filesUnder, markerBytes } from "./resources.mjs";
import { checkSums, nameProblems, sha256Of, sizesOf } from "./sums.mjs";

export const SMOKE_PORT = 8981;

const appVersion = () => JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;

/** The top of a resources folder, beside the app's archive: nothing else may lie there. */
export const RESOURCES_TOP = Object.freeze({
  darwin: ["LICENSE", "LICENSES.chromium.html", NOTICES_FILE, MAC_ICON_FILE, "app.asar", "app.asar.unpacked", "bin", "build.json", "emulator", "gh", "node"],
  win32: [NOTICES_FILE, "app.asar", "app.asar.unpacked", "bin", "build.json", "emulator", "gh", "node"],
});

/**
 * The license summary in a resources folder against what the build of the marker's commit makes for this system
 * (tools/notices/notices.mjs): missing, edited or stale is a problem, one line each.
 */
export function noticesProblems(resources, platform, marker) {
  let notices;
  try {
    notices = noticesText({ platform, commit: /^[0-9a-f]{40}$/.test(marker?.commit ?? "") ? marker.commit : undefined });
  } catch (e) {
    return [`the license summary cannot be made from the source: ${e.message}`];
  }
  const file = path.join(resources, NOTICES_FILE);
  if (!existsSync(file)) return [`resources/${NOTICES_FILE} is missing`];
  return readFileSync(file).equals(Buffer.from(notices)) ? [] : [`resources/${NOTICES_FILE} differs from the license summary of the source`];
}

/** What is wrong with an app's resources folder, one line each (the same for an unpacked .app and a Windows folder). */
export async function resourcesProblems(resources, platform) {
  const problems = [];
  const asar = await loadAsar();
  const top = readdirSync(resources).filter((n) => !(platform === "darwin" && n.endsWith(".lproj")));
  for (const n of top) if (!RESOURCES_TOP[platform].includes(n)) problems.push(`resources/${n} is not on the list of the resources folder`);
  for (const n of RESOURCES_TOP[platform]) if (!top.includes(n)) problems.push(`resources/${n} is missing`);
  if (problems.length) return { problems };

  const archive = path.join(resources, "app.asar");
  const files = listArchive(archive, asar);
  let marker = null;
  try {
    marker = JSON.parse(asar.extractFile(archive, "build.json").toString("utf8"));
  } catch (e) {
    problems.push(`app.asar has no readable build.json: ${e.message}`);
  }
  // The marker as a build of this commit writes it, with the commit the files say they were built from; whether the
  // files are those of that commit, the byte comparison below says.
  if (marker && !/^[0-9a-f]{40}$/.test(marker.commit ?? "")) problems.push("the marker in app.asar records no commit: a release names the commit it was built from");
  const expected = archiveEntries({ kind: "release", marker: markerBytes("release", /^[0-9a-f]{40}$/.test(marker?.commit ?? "") ? marker.commit : undefined) });
  problems.push(...archiveProblems({ files, expected: expected.map((e) => e.name), marker }));
  // The same bytes as the build of this commit would put there: the archive is checked against the source, not only
  // by its list.
  for (const entry of expected) {
    if (!files.includes(entry.name)) continue;
    const want = entry.bytes ?? readFileSync(entry.file);
    const have = UNPACKED_IN_ARCHIVE.includes(entry.name) ? readFileSync(path.join(`${archive}.unpacked`, ...entry.name.split("/"))) : asar.extractFile(archive, entry.name.split("/").join(path.sep));
    if (!want.equals(have)) problems.push(`app.asar: ${entry.name} differs from the source`);
  }
  const unpacked = unpackedInArchive(archive, asar);
  if (JSON.stringify(unpacked) !== JSON.stringify([...UNPACKED_IN_ARCHIVE].sort())) problems.push(`unpacked from app.asar: ${unpacked.join(", ") || "nothing"}, expected ${UNPACKED_IN_ARCHIVE.join(", ")}`);
  const outside = filesUnder(path.join(resources, "app.asar.unpacked"));
  if (JSON.stringify(outside) !== JSON.stringify([...UNPACKED_IN_ARCHIVE].sort())) problems.push(`app.asar.unpacked holds ${outside.join(", ")}, expected ${UNPACKED_IN_ARCHIVE.join(", ")}`);

  problems.push(...noticesProblems(resources, platform, marker));

  const resourcesMarker = JSON.parse(readFileSync(path.join(resources, "build.json"), "utf8"));
  if (resourcesMarker.kind !== "release") problems.push(`resources/build.json says ${JSON.stringify(resourcesMarker.kind)}, not "release"`);
  if (marker && JSON.stringify(resourcesMarker) !== JSON.stringify(marker)) problems.push("resources/build.json and the marker in app.asar differ");

  const emulator = filesUnder(path.join(resources, "emulator"));
  const expectedEmulator = emulatorFiles();
  problems.push(...emulatorProblems({ files: emulator, expected: expectedEmulator }));
  // The list above is the one the build copied by, so a file it leaves out is missing from both alike: what the
  // release's own modules import is the independent check.
  problems.push(...missingImports({ folder: path.join(resources, "emulator"), files: emulator }));
  for (const f of expectedEmulator) {
    const at = path.join(resources, "emulator", ...f.split("/"));
    if (existsSync(at) && !readFileSync(at).equals(readFileSync(path.join(APP_DIR, "..", "..", ...f.split("/"))))) problems.push(`emulator/${f} differs from the source`);
  }

  const bin = readdirSync(path.join(resources, "bin"));
  const wantBin = platform === "win32" ? ["busy-emulator.exe"] : ["busy-emulator"];
  if (JSON.stringify(bin) !== JSON.stringify(wantBin)) problems.push(`resources/bin holds ${bin.join(", ")}, expected ${wantBin.join(", ")}`);
  const node = filesUnder(path.join(resources, "node"));
  const wantNodeTop = platform === "win32" ? ["LICENSE", "node.exe", "node_modules"] : ["LICENSE", "bin", "lib"];
  const nodeTop = readdirSync(path.join(resources, "node")).sort();
  if (JSON.stringify(nodeTop) !== JSON.stringify(wantNodeTop)) problems.push(`resources/node holds ${nodeTop.join(", ")}, expected ${wantNodeTop.join(", ")}`);
  if (platform === "darwin" && JSON.stringify(readdirSync(path.join(resources, "node", "bin"))) !== JSON.stringify(["node"])) problems.push("resources/node/bin holds more than node");
  problems.push(...ghLayoutProblems(resources, platform));
  const links = [];
  const walkLinks = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isSymbolicLink()) links.push(path.join(p, e.name));
      else if (e.isDirectory()) walkLinks(path.join(p, e.name));
    }
  };
  walkLinks(resources);
  if (links.length) problems.push(`links in the resources folder: ${links.join(", ")}`);
  const asarHash = createHash("sha256").update(asar.getRawHeader(archive).headerString).digest("hex");
  const tree = mkdtempSync(path.join(os.tmpdir(), "busy-emulator-publication-"));
  let publication;
  try {
    publication = await publicationFindings(await treeOfApp(resources, tree));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  return { problems, archiveFiles: files.length, emulatorFiles: emulator.length, nodeFiles: node.length, marker, asarHash, publication };
}

/** GitHub CLI in a resources folder (tools/bundled-gh.mjs): gh/bin/gh (gh.exe) and gh/LICENSE, nothing else. */
export function ghLayoutProblems(resources, platform) {
  const folder = path.join(resources, "gh");
  if (!existsSync(folder)) return ["resources/gh is missing"];
  const want = ["LICENSE", platform === "win32" ? "bin/gh.exe" : "bin/gh"];
  const have = filesUnder(folder);
  return JSON.stringify(have) === JSON.stringify(want) ? [] : [`resources/gh holds ${have.join(", ")}, expected ${want.join(", ")}`];
}

/**
 * gh in a built app: the pinned version, run from the app's place with a configuration folder of its own; on macOS it
 * carries GitHub's own signature, or, in an app signed with Developer ID (EMU-204), the app's: `appTeam` is the team
 * of the app's signature, null for an ad hoc one. Nothing that would look into the system's store or ask GitHub: gh
 * auth status would find the active token of the person's own gh there, whatever the configuration folder (gh.mjs).
 */
export function ghProblems({ resources, platform, workDir, appTeam = null, run = execFileSync }) {
  const problems = [];
  const results = {};
  const gh = path.join(resources, "gh", "bin", platform === "win32" ? "gh.exe" : "gh");
  const pin = readGhPin().version;
  const config = path.join(workDir, "gh-config");
  mkdirSync(config, { recursive: true });
  const env = checkEnvironment(config, platform);
  try {
    results.gh = run(gh, ["--version"], { encoding: "utf8", env, cwd: workDir, windowsHide: true }).split(/\r?\n/)[0].trim();
    if (!versionLine(pin).test(results.gh)) problems.push(`the bundled gh says ${results.gh}, the pin is ${pin}`);
  } catch (e) {
    problems.push(`the bundled gh does not run: ${e.message}`);
  }
  if (platform === "darwin" && process.platform === "darwin") {
    try {
      run("/usr/bin/codesign", ["--verify", "--strict", gh], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      problems.push(`codesign --verify --strict on gh: ${String(e.stderr ?? e.message).trim()}`);
    }
    results.ghSignature = signatureOf(gh, run);
    if (appTeam) {
      if (results.ghSignature.team !== appTeam) problems.push(`gh is not signed by the app's team (team ${results.ghSignature.team ?? "none"}, not ${appTeam}): the release's signature missed it`);
    } else if (results.ghSignature.team !== GITHUB_TEAM) {
      problems.push(`gh is not signed by GitHub (team ${results.ghSignature.team ?? "none"}, not ${GITHUB_TEAM}): the build replaced its signature`);
    }
  }
  return { problems, results };
}

/** What codesign -dv says of a program: its team and its authorities (codesign writes it on stderr). */
export function signatureOf(gh, run = execFileSync) {
  const out = run("/bin/sh", ["-c", '/usr/bin/codesign -dv --verbose=2 "$0" 2>&1', gh], { encoding: "utf8" });
  return { team: /^TeamIdentifier=(\S+)$/m.exec(out)?.[1] ?? null, authority: /^Authority=(.+)$/m.exec(out)?.[1] ?? null };
}

/**
 * Where the export check is, when it is not in this tree: a release is built and checked in the exported tree, which
 * does not hold it, with the export check of the internal repository (dist.mjs check --export-check <folder>).
 */
let exportCheckDir = null;
export function useExportCheck(folder) {
  exportCheckDir = folder ? path.resolve(folder) : null;
}

/**
 * What in the app must not be published, by the export check itself (ADR-0003 §5, ADR-0015): its whole rule set —
 * forbidden files and every content rule (serial numbers, MAC and private addresses, places, private patterns,
 * Cyrillic) — run over a folder that holds what the app holds, laid out as in emulator/ (packages/server/...,
 * packages/engine/..., packages/app/<file of the archive>). No exception applies: an exception lets a file stay in the
 * private repository, it does not make the file publishable. The export check lives in the monorepo only, and without
 * its private patterns it cannot see everything; either way the answer is "not checked", never "publishable".
 * @returns {Promise<{ checked: boolean, reason?: string, files: { file: string, why: string }[] }>}
 */
export async function publicationFindings(tree, emulatorDir = path.join(APP_DIR, "..", "..")) {
  const tool = exportCheckDir ?? path.join(emulatorDir, "tools", "export-check");
  if (!existsSync(path.join(tool, "check.mjs"))) return { checked: false, reason: "the export check is not here (it lives in the monorepo)", files: [] };
  const ec = await import(pathToFileURL(path.join(tool, "check.mjs")).href);
  const layer = ec.loadLayer(path.join(tool, "layer.json"));
  // The private patterns must lie outside every repository involved: the tree, this one, and the export check's own.
  const priv = ec.loadPrivate({ env: process.env, repoRoots: [tree, path.resolve(emulatorDir, ".."), ...(exportCheckDir ? [emulatorDir, path.resolve(exportCheckDir, "..", "..", "..")] : [])] });
  const result = ec.check({ root: tree, layer, exceptions: [], privatePatterns: priv.patterns, fingerprintKey: priv.fingerprintKey, source: "fs", wholeTree: true, reveal: false });
  const seen = new Map();
  for (const finding of result.uncovered) {
    const file = finding.loc.split("!")[0];
    // The rule only: a value the rule found is never printed.
    const why = finding.rule === "forbidden-file" ? "a file the export check never publishes (layer.json, forbidden)" : `the export check's rule "${finding.rule}" finds something in it`;
    if (!seen.has(file)) seen.set(file, new Set());
    seen.get(file).add(why);
  }
  const files = [...seen].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([file, whys]) => ({ file, why: [...whys].join("; ") }));
  if (!priv.patterns.length) return { checked: false, reason: "the export check has no private patterns here, so it cannot see everything", files };
  return { checked: true, files };
}

/**
 * Lays out what an app holds as publicationFindings() reads it: resources/emulator, the files of app.asar under
 * packages/app, and the license summary at the top (where the public repository's root files are).
 */
export async function treeOfApp(resources, tree) {
  const asar = await loadAsar();
  if (existsSync(path.join(resources, NOTICES_FILE))) {
    mkdirSync(tree, { recursive: true });
    writeFileSync(path.join(tree, NOTICES_FILE), readFileSync(path.join(resources, NOTICES_FILE)));
  }
  for (const f of filesUnder(path.join(resources, "emulator"))) {
    const to = path.join(tree, ...f.split("/"));
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(path.join(resources, "emulator", ...f.split("/"))));
  }
  const archive = path.join(resources, "app.asar");
  const unpacked = unpackedInArchive(archive, asar);
  for (const f of listArchive(archive, asar)) {
    const to = path.join(tree, "packages", "app", ...f.split("/"));
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, unpacked.includes(f) ? readFileSync(path.join(`${archive}.unpacked`, ...f.split("/"))) : asar.extractFile(archive, f.split("/").join(path.sep)));
  }
  return tree;
}

/** The same, for a list of paths taken from the source tree (what a build of this checkout would put in the app). */
export async function closedForPublication(emulatorPaths, emulatorDir = path.join(APP_DIR, "..", "..")) {
  const tree = mkdtempSync(path.join(os.tmpdir(), "busy-emulator-publication-"));
  try {
    for (const p of emulatorPaths) {
      const from = path.join(emulatorDir, ...p.split("/"));
      if (!existsSync(from)) continue; // build.json: made by the build, not in the source
      const to = path.join(tree, ...p.split("/"));
      mkdirSync(path.dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(from));
    }
    return await publicationFindings(tree, emulatorDir);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

/** The programs of a macOS bundle, each of which must be for the architecture the file's name says. */
export function macPrograms(app) {
  const contents = path.join(app, "Contents");
  const frameworks = path.join(contents, "Frameworks");
  const helpers = existsSync(frameworks) ? readdirSync(frameworks).filter((n) => /Helper.*\.app$/.test(n)).map((n) => path.join(frameworks, n, "Contents", "MacOS", n.replace(/\.app$/, ""))) : [];
  return [path.join(contents, "MacOS", "BUSY Bar Emulator"), path.join(frameworks, "Electron Framework.framework", "Electron Framework"), ...helpers, path.join(contents, "Resources", "node", "bin", "node"), path.join(contents, "Resources", "gh", "bin", "gh")];
}

/** What is wrong with the icon in a macOS bundle's Resources: it is the app's own, with every size, not Electron's. */
export function macIconProblems(file) {
  if (!existsSync(file)) return [`the bundle has no ${MAC_ICON_FILE}: the app would show no icon of its own`];
  const bytes = readFileSync(file);
  const problems = icnsProblems(bytes).map((line) => `${MAC_ICON_FILE}: ${line}`);
  if (!problems.length && !bytes.equals(readFileSync(ICNS_SOURCE))) problems.push(`${MAC_ICON_FILE} is not the icon of the source (icon/emulator.icns)`);
  return problems;
}

/**
 * The checks of an unpacked macOS bundle that need no program to run but the system's own tools. `arch` is what the
 * file's name says the app is for (arm64 or x64): every program in it must be for that, and no other.
 */
export async function macAppProblems(app, arch = null) {
  const problems = [];
  const contents = path.join(app, "Contents");
  if (arch) {
    for (const program of macPrograms(app)) {
      const found = existsSync(program) ? machoArch(program) : null;
      if (found !== arch) problems.push(`${path.relative(app, program)} is ${found ? `for ${found}` : "not a program of macOS"}, the file is named for ${arch}`);
    }
  }
  const plist = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", path.join(contents, "Info.plist")], { encoding: "utf8" }));
  const want = { CFBundleIdentifier: "app.busy.emulator", CFBundleName: "BUSY Bar Emulator", CFBundleExecutable: "BUSY Bar Emulator", CFBundleShortVersionString: appVersion(), CFBundleIconFile: MAC_ICON_FILE };
  for (const [key, value] of Object.entries(want)) if (plist[key] !== value) problems.push(`Info.plist ${key} is ${JSON.stringify(plist[key])}, expected ${JSON.stringify(value)}`);
  for (const key of Object.keys(plist)) if (/UsageDescription$/.test(key) || key === "NSAppTransportSecurity" || key === "LSUIElement") problems.push(`Info.plist has ${key}`);
  const integrity = plist.ElectronAsarIntegrity ?? {};
  if (JSON.stringify(Object.keys(integrity)) !== JSON.stringify(["Resources/app.asar"])) problems.push(`Info.plist records the integrity of ${Object.keys(integrity).join(", ") || "nothing"}, expected Resources/app.asar`);
  problems.push(...macIconProblems(path.join(contents, "Resources", MAC_ICON_FILE)));
  const fuses = readFuseWire(fuseFileOf(app));
  problems.push(...fuseProblems(fuses));
  const resources = await resourcesProblems(path.join(contents, "Resources"), "darwin");
  problems.push(...resources.problems);
  if (resources.asarHash && integrity["Resources/app.asar"]?.hash !== resources.asarHash) problems.push("the integrity hash in Info.plist is not the hash of app.asar's header");
  for (const helper of readdirSync(path.join(contents, "Frameworks")).filter((n) => /Helper/.test(n))) {
    if (!helper.startsWith("BUSY Bar Emulator Helper")) problems.push(`a helper keeps Electron's name: ${helper}`);
  }
  if (process.platform === "darwin") {
    try {
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      problems.push(`codesign --verify --deep --strict: ${String(e.stderr).trim()}`);
    }
  }
  return { problems, fuses: fuseTable(fuses.wire), wire: fuses.wire, resources };
}

/** The programs inside an app that have no window, run from the app's own place. */
export async function runProblems({ resources, platform, workDir, log = () => {} }) {
  const problems = [];
  const results = {};
  const node = path.join(resources, "node", platform === "win32" ? "node.exe" : path.join("bin", "node"));
  const pin = readPin().version;
  const env = cleanEnvironment(platform);
  try {
    results.node = execFileSync(node, ["--version"], { encoding: "utf8", env, cwd: workDir }).trim();
    if (results.node !== `v${pin}`) problems.push(`the bundled Node says ${results.node}, the pin is v${pin}`);
  } catch (e) {
    problems.push(`the bundled Node does not run: ${e.message}`);
  }
  const cli = path.join(resources, "bin", platform === "win32" ? "busy-emulator.exe" : "busy-emulator");
  try {
    const said = execFileSync(cli, ["version", "--json"], { encoding: "utf8", env, cwd: workDir }).trim();
    results.cli = JSON.parse(said);
    if (results.cli.ok !== true || results.cli.kind !== "release" || results.cli.node !== pin || results.cli.version !== appVersion()) {
      problems.push(`busy-emulator version --json says ${said}, expected ok, kind "release", node ${pin}, version ${appVersion()}`);
    }
  } catch (e) {
    problems.push(`busy-emulator version --json failed: ${e.message}`);
  }
  // The team of the app's own signature: an app signed with Developer ID signs gh too (sign-mac.mjs).
  const appTeam = platform === "darwin" && process.platform === "darwin" ? signatureOf(path.join(resources, "..", "MacOS", "BUSY Bar Emulator")).team : null;
  const gh = ghProblems({ resources, platform, workDir, appTeam });
  problems.push(...gh.problems);
  Object.assign(results, gh.results);
  log("starting the server from the app on the bundled Node");
  results.server = await serverSmoke({ node, entry: path.join(resources, "emulator", "packages", "server", "index.mjs"), dataDir: path.join(workDir, "bar-data"), env, cwd: workDir });
  if (!results.server.ok) problems.push(`the server in the app did not answer: ${results.server.error}`);
  return { problems, results };
}

/** An environment with nothing of the caller's that changes how Node or the command line start. */
export function cleanEnvironment(platform) {
  if (platform === "win32") {
    const keep = ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH", "PATHEXT", "ComSpec"];
    const env = {};
    for (const k of keep) if (process.env[k]) env[k] = process.env[k];
    env.PATH = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
    return env;
  }
  return { PATH: "/usr/bin:/bin", HOME: os.homedir(), LANG: "C", TMPDIR: os.tmpdir() };
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  });
}

/** Starts the server, waits for GET /api/status, stops it. Nothing is left: the process and its port are checked. */
export async function serverSmoke({ node, entry, dataDir, env, cwd, port = SMOKE_PORT, timeoutMs = 30_000 }) {
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(node, [entry, "--port", String(port), "--data", dataDir], { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (c) => (output += c));
  child.stderr.setEncoding("utf8").on("data", (c) => (output += c));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let gone = null;
  exited.then((e) => (gone = e));
  const started = Date.now();
  let result = { ok: false, error: "no answer" };
  while (Date.now() - started < timeoutMs) {
    if (gone) {
      result = { ok: false, error: `the server ended (${gone.code ?? gone.signal}): ${output.trim().split("\n").slice(-3).join(" / ")}` };
      break;
    }
    try {
      const status = await get(`http://127.0.0.1:${port}/api/status`);
      const firmware = await get(`http://127.0.0.1:${port}/api/status/firmware`);
      result = status.status === 200 ? { ok: true, status: JSON.parse(status.body), firmware: JSON.parse(firmware.body), ms: Date.now() - started } : { ok: false, error: `HTTP ${status.status}` };
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!gone) child.kill();
  await exited;
  result.firstLine = output.split("\n")[0];
  return result;
}

function unpackZip(zip, to) {
  mkdirSync(to, { recursive: true });
  execFileSync("/usr/bin/ditto", ["-x", "-k", zip, to]);
}

/** Read-only, as an app is when macOS runs it from a disk image or a random place: the server must not write there. */
function setWritable(folder, writable) {
  const walk = (p) => {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const e of readdirSync(p)) walk(path.join(p, e));
    chmodSync(p, writable ? stat.mode | 0o200 : stat.mode & ~0o222);
  };
  walk(folder);
}

/**
 * The checks of a release signed with Developer ID and notarized (dist.mjs check --signed), on the app as it lies in
 * the zip or the disk image. Gatekeeper with the quarantine mark of a download is asked on the disk image only
 * (quarantinedDmgProblems), where the app lies on a read-only volume: a notarized app that Gatekeeper has assessed
 * with the mark comes under macOS's App Management protection, and a process of another team (this check, run from a
 * terminal) can then neither change nor remove it. The zip is what agents fetch with curl, which leaves no mark.
 */
async function signedChecks(app, { log }) {
  const { signedAppProblems } = await import("./sign-mac.mjs");
  log(`the signature of every program, the ticket, Gatekeeper: ${path.basename(app)}`);
  const signed = signedAppProblems(app);
  return { problems: signed.problems, results: signed.results };
}

/** The disk image as a browser leaves it: a copy (a clone, on APFS) with the quarantine mark, attached; its app is assessed. */
async function quarantinedDmgProblems(file, { scratch, log }) {
  const { quarantine, quarantined, quarantinedAppProblem } = await import("./sign-mac.mjs");
  const copy = path.join(scratch, `downloaded-${path.basename(file)}`);
  copyFileSync(file, copy, fsConstants.COPYFILE_FICLONE);
  const mount = path.join(scratch, "dmg-downloaded");
  mkdirSync(mount, { recursive: true });
  try {
    quarantine(copy);
    log(`attaching ${path.basename(file)} with the quarantine mark of a download`);
    execFileSync("/usr/bin/hdiutil", ["attach", "-quiet", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, copy]);
    try {
      const app = path.join(mount, APP_BUNDLE);
      // The system mounts a quarantined image with the quarantine option: what lies on it counts as downloaded,
      // without a mark of its own on each file.
      const real = realpathSync(mount);
      const flags = execFileSync("/sbin/mount", [], { encoding: "utf8" }).split("\n").find((l) => l.includes(` on ${real} (`)) ?? "";
      const problem = /\bquarantine\b/.test(flags) || quarantined(app) ? quarantinedAppProblem(app, { mounted: true }) : `the disk image with the quarantine mark is not mounted as quarantined (${flags || "not in the list of mounts"}), so the check would prove nothing`;
      return { problems: problem ? [problem] : [], result: problem ?? "mounts as quarantined; the app on it is accepted as notarized" };
    } finally {
      execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", mount]);
    }
  } finally {
    rmSync(copy, { force: true });
  }
}

async function checkMacZip(file, { scratch, arch, runHere, signed = false, log }) {
  // On a volume of its own (scratch-volume.mjs): once the programs of a notarized app have run, macOS lets no process
  // of another team change or remove it, and the volume goes whole.
  const { attachScratchVolume } = await import("./scratch-volume.mjs");
  const volume = attachScratchVolume(scratch, { name: "zip" });
  try {
    const to = path.join(volume.mount, "unpacked");
    log(`unpacking ${path.basename(file)}`);
    unpackZip(file, to);
    const top = readdirSync(to);
    const problems = [];
    if (JSON.stringify(top) !== JSON.stringify([APP_BUNDLE])) problems.push(`the zip holds ${top.join(", ")}, expected only ${APP_BUNDLE}`);
    const app = path.join(to, APP_BUNDLE);
    const result = existsSync(app) ? await macAppProblems(app, arch) : { problems: [] };
    problems.push(...result.problems);
    if (signed && existsSync(app)) {
      const s = await signedChecks(app, { log });
      problems.push(...s.problems);
      result.signature = s.results;
    }
    if (runHere && existsSync(app)) {
      // Read-only, as an app is when macOS runs it from a disk image or a random place; it stays so, the volume goes.
      setWritable(app, false);
      const work = mkdtempSync(path.join(scratch, "run-"));
      const ran = await runProblems({ resources: path.join(app, "Contents", "Resources"), platform: "darwin", workDir: work, log });
      problems.push(...ran.problems);
      result.run = ran.results;
    }
    return { ...result, problems };
  } finally {
    volume.remove();
  }
}

async function checkMacDmg(file, { scratch, arch, runHere, signed = false, log }) {
  const mount = path.join(scratch, "dmg-mount");
  mkdirSync(mount, { recursive: true });
  log(`attaching ${path.basename(file)} read-only, out of sight of the Finder`);
  execFileSync("/usr/bin/hdiutil", ["attach", "-quiet", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, file]);
  const problems = [];
  let result = { problems: [] };
  try {
    const top = readdirSync(mount).filter((n) => !n.startsWith("."));
    if (JSON.stringify(top.sort()) !== JSON.stringify([APP_BUNDLE, "Applications"].sort())) problems.push(`the disk image holds ${top.join(", ")}, expected ${APP_BUNDLE} and Applications`);
    const link = path.join(mount, "Applications");
    if (!existsSync(link) || !lstatSync(link).isSymbolicLink() || readlinkSync(link) !== "/Applications") problems.push("Applications in the disk image is not a link to /Applications");
    const app = path.join(mount, APP_BUNDLE);
    if (existsSync(app)) result = await macAppProblems(app, arch);
    problems.push(...result.problems);
    if (signed && existsSync(app)) {
      const { signedDmgProblems } = await import("./sign-mac.mjs");
      const image = signedDmgProblems(file);
      problems.push(...image.problems);
      const s = await signedChecks(app, { log });
      problems.push(...s.problems);
      result.signature = { dmg: image.results, app: s.results };
    }
    // The image is mounted read-only, as macOS runs an app opened from it: what runs must not write into the app.
    if (runHere && existsSync(app)) {
      const work = mkdtempSync(path.join(scratch, "run-"));
      const ran = await runProblems({ resources: path.join(app, "Contents", "Resources"), platform: "darwin", workDir: work, log });
      problems.push(...ran.problems);
      result.run = ran.results;
    }
  } finally {
    execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", mount]);
  }
  if (signed) {
    const downloaded = await quarantinedDmgProblems(file, { scratch, log });
    problems.push(...downloaded.problems);
    if (result.signature) result.signature.downloaded = downloaded.result;
  }
  return { ...result, problems };
}

/**
 * Checks a release folder.
 * @param {object} o
 * @param {string} o.folder
 * @param {boolean} [o.partial]  only this system's files are there yet (before SHA256SUMS is written)
 * @param {boolean} [o.signed]   the macOS files must be signed with Developer ID and notarized (EMU-204)
 */
export async function checkRelease({ folder, partial = false, signed = false, log = () => {} }) {
  const names = readdirSync(folder);
  const problems = [];
  const host = targetOfHost();
  if (partial) {
    const mine = targetsBuiltOn(host).flatMap((target) => RELEASE_FILES[target]);
    problems.push(...nameProblems(names, mine));
  } else {
    problems.push(...(await checkSums(folder)));
  }
  const scratch = mkdtempSync(path.join(os.tmpdir(), "busy-emulator-check-"));
  const files = {};
  try {
    for (const name of names.filter((n) => ALL_RELEASE_FILES.includes(n) && n !== SUMS_FILE)) {
      const file = path.join(folder, name);
      const entry = { bytes: statSync(file).size, sha256: await sha256Of(file) };
      const sub = path.join(scratch, name.replace(/[^a-z0-9.-]/gi, "_"));
      mkdirSync(sub, { recursive: true });
      let result;
      try {
        result = await checkOne(name, file, { sub, host, signed, log });
      } catch (e) {
        result = { problems: [`the check could not go on: ${e.message}`] };
      }
      for (const p of result.problems) problems.push(`${name}: ${p}`);
      files[name] = { ...entry, ...result, problems: undefined };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // What the files really hold, as each check laid it out (resourcesProblems); one answer for the release.
  const publication = { checked: Object.keys(files).length > 0, files: [], reasons: [] };
  const byFile = new Map();
  for (const result of Object.values(files)) {
    const p = result.resources?.publication;
    if (!p) {
      publication.checked = false;
      continue;
    }
    if (!p.checked) {
      publication.checked = false;
      publication.reasons.push(p.reason);
    }
    for (const f of p.files) byFile.set(f.file, f.why);
  }
  publication.files = [...byFile].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([file, why]) => ({ file, why }));
  publication.reasons = [...new Set(publication.reasons)];
  const skipped = Object.entries(files).filter(([, r]) => r.skipped).map(([name, r]) => `${name}: ${r.skipped}`);
  return {
    skipped, folder, host, partial, signed, checked: new Date().toISOString(), sizes: sizesOf(folder, ALL_RELEASE_FILES), files, problems, publication };
}

async function checkOne(name, file, { sub, host, signed = false, log }) {
  const target = targetOfFile(name);
  if (target === "win32-x64") {
    const { checkSetup } = await import("./windows-check.mjs");
    return checkSetup(file, { scratch: sub, runHere: host === "win32-x64", log });
  }
  if (process.platform !== "darwin") return { problems: [], skipped: "read on macOS" };
  // The programs inside run on this Mac when they are of its own architecture, and Intel's on Apple Silicon when
  // Rosetta is installed. Otherwise the file is read but not run, and the check says so.
  const runHere = runsHere(target, host);
  const result = await (name.endsWith(".zip") ? checkMacZip : checkMacDmg)(file, { scratch: sub, arch: target.split("-")[1], runHere, signed, log });
  if (!runHere) result.skipped = `read, but its programs were not run: this Mac (${host}) does not run ${target}${host === "darwin-arm64" ? " without Rosetta" : ""}`;
  else result.ranUnder = target === host ? "this Mac's own architecture" : "Rosetta";
  return result;
}
