#!/usr/bin/env node
// Builds the files of a release (ADR-0002, section 3) and checks them (EMU-203). Each system builds its own files:
// a Mac the .dmg and the .zip for Apple Silicon and for Intel, Windows the setup.exe; SHA256SUMS is written once all
// are in one folder. What is downloaded: Node's pinned archive for each target (tools/bundled-node.mjs) and, for the
// architecture of macOS that is not this Mac's own, Electron's archive of the installed release, checked against the
// sum the electron package records (tools/packaging/electron.mjs); this system's own Electron comes from the installed
// electron package. The output lies outside the repository.
//
//   node tools/dist.mjs build [--kind release|test] [--arch arm64|x64|all] [--out <dir>] [--allow-uncommitted (test variant only)]
//                                                         --arch: which of this system's targets. A release builds
//                                                         all of them by default (on a Mac: both), the test variant
//                                                         this system's own.
//   node tools/dist.mjs sums [<release folder>]           SHA256SUMS for a folder holding every file of the release
//   node tools/dist.mjs check [<release folder>] [--partial] [--export-check <tools/export-check>]
//                                                         the produced files: names, sums, fuses, contents; on this
//                                                         system's own files also the bundled Node, the command line
//                                                         and the server, all without opening a window. Exit code 0:
//                                                         sound and publishable; 1: a problem; 3: sound, but holding
//                                                         what the export check refuses to publish, or not all of it
//                                                         checked (another system's files; no export check here).
//                                                         --export-check names the export check of the internal
//                                                         repository, for a check run in the exported tree
//
// <out> holds release/ (the files of a release and nothing else), reports/ (what each build and check found),
// work/ (the unpacked app as built) and test-variant/ (the test variant, never part of a release).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultCacheDir, readPin } from "./bundled-node.mjs";
import { APP_DIR, git, sourceCommit, uncommittedChanges } from "./packaging/composition.mjs";
import { MIN_FREE_GB, MIN_FREE_GB_TEST, requireFreeSpace } from "./packaging/disk.mjs";
import { electronFor } from "./packaging/electron.mjs";
import { RELEASE_WIRE } from "./packaging/fuses.mjs";
import { DIST_TARGETS, RELEASE_FILES, SUMS_FILE, targetOfHost, targetsBuiltOn } from "./packaging/names.mjs";
import { sizesOf, writeSums } from "./packaging/sums.mjs";

export function defaultOutDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  return path.join(path.dirname(defaultCacheDir({ env, platform, home })), "dist");
}

/** The repository the app lies in; the output must be outside it, so that nothing built is ever committed. */
export function repositoryRoot(from = APP_DIR) {
  return git(["rev-parse", "--show-toplevel"], from).trim();
}

export function insideFolder(folder, root) {
  const real = (p) => {
    let at = path.resolve(p);
    const rest = [];
    while (!existsSync(at)) {
      rest.unshift(path.basename(at));
      at = path.dirname(at);
    }
    return path.join(realpathSync(at), ...rest);
  };
  const relative = path.relative(real(root), real(folder));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The targets one call builds: --arch names one of this system's, or all of them. Without it a release is all of
 * them, the test variant this system's own (it is the one the tests start).
 */
export function buildTargets({ kind = "release", arch = null, host = targetOfHost() } = {}) {
  const mine = targetsBuiltOn(host);
  if (!mine.length) throw new Error(`This system (${host}) builds no files of a release; the targets are ${DIST_TARGETS.join(", ")}`);
  if (arch === null) return kind === "release" || !mine.includes(host) ? mine : [host];
  if (arch === "all") return mine;
  const target = `${host.split("-")[0]}-${arch}`;
  if (!mine.includes(target)) throw new Error(`--arch ${arch}: this system (${host}) does not build ${target}; it builds ${mine.join(", ")}`);
  return [target];
}

/** The version no release has: what package.json holds until a release is named. */
export const UNSET_VERSION = "0.0.0";

/**
 * A release is built under a version of its own: the app tells the person its version, writes it into the command
 * line's pointer file and compares it with the latest release, and a build that calls itself 0.0.0 would be offered
 * every release for ever. The test variant is not a release and keeps whatever version the tree has.
 */
export function checkReleaseVersion(kind, version) {
  if (kind !== "release" || version !== UNSET_VERSION) return;
  throw new Error(
    `The version in packages/app/package.json is ${UNSET_VERSION}: a release is not built under it. Set the version of this release first, from emulator/:\n` +
      "  npm --prefix packages/app version <version> --no-git-tag-version\n" +
      "(for example 0.1.0-beta.1; the command changes package.json and package-lock.json), commit that, and build again. The steps of a release are in docs/release.md. The test variant (--kind test) builds under any version.",
  );
}

/** The app's version: package.json's. */
export function appVersion() {
  return JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;
}

function commitTime() {
  return Number(git(["log", "-1", "--format=%ct"], APP_DIR).trim());
}

/**
 * Builds this system's files of a release into <out>/release (or the test variant into <out>/test-variant), one
 * target after another. `version` is the app's own, package.json's: a test names another to see what the build says
 * to it, and no build goes on under a version that is not package.json's. A macOS build starts only with the free space
 * it needs (packaging/disk.mjs); `statfs` is for tests.
 * @returns {Promise<object[]>} the report of each target, also written to <out>/reports/build-<kind>-<target>.json
 */
export async function build({ kind = "release", arch = null, out = defaultOutDir(), cacheDir = defaultCacheDir(), allowUncommitted = false, log = () => {}, version = appVersion(), statfs = null } = {}) {
  const targets = buildTargets({ kind, arch });
  if (insideFolder(out, repositoryRoot())) throw new Error(`The output ${out} lies inside the repository: built files must never be committed. Name a folder outside it.`);
  if (kind === "release" && allowUncommitted) throw new Error("A release is built from a commit only: --allow-uncommitted is for the test variant (--kind test).");
  checkReleaseVersion(kind, version);
  if (version !== appVersion()) throw new Error(`The build takes its version from package.json (${appVersion()}), not ${version}.`);
  // A macOS build on a nearly full disk made a broken disk image and still ended with 0 (the release dry run): it
  // starts only with room enough.
  if (targets.some((target) => target.startsWith("darwin-"))) {
    requireFreeSpace(out, { ...(kind === "release" ? { minimum: MIN_FREE_GB, what: "a release build" } : { minimum: MIN_FREE_GB_TEST, what: "a build of the test variant" }), ...(statfs ? { statfs } : {}) });
  }
  const changes = uncommittedChanges();
  if (changes.length && !allowUncommitted) {
    throw new Error(`The build takes committed files only, and these are changed or not committed:\n  ${changes.join("\n  ")}\nCommit them, or pass --allow-uncommitted with --kind test for a build that is not a release.`);
  }
  const reports = [];
  for (const target of targets) reports.push(await buildTarget({ target, kind, version, out, cacheDir, changes, log: targets.length > 1 ? (line) => log(`${target}: ${line}`) : log }));
  return reports;
}

async function buildTarget({ target, kind, version, out, cacheDir, changes, log }) {
  // Electron of the other architecture is unpacked beside the build's work and removed with it.
  const scratch = path.join(out, "work", `electron-${target}`);
  const { dist, version: electron, from: electronFrom } = await electronFor({ target, scratch, cacheDir, log });
  const sourceTime = commitTime();
  const work = path.join(out, "work", `${kind}-${target}`);
  const commit = sourceCommit();
  const report = { target, kind, version, commit, uncommitted: changes, electron, electronFrom, node: readPin().version, sourceTime, built: new Date().toISOString(), host: `${os.type()} ${os.release()} ${process.arch}` };

  let built;
  if (target.startsWith("darwin-")) {
    const { buildMacApp, dmgApp, zipApp } = await import("./packaging/macos.mjs");
    try {
      built = await buildMacApp({ target, electronDist: dist, work, kind, version, cacheDir, sourceTime, commit, log });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    if (kind === "release") {
      const release = path.join(out, "release");
      mkdirSync(release, { recursive: true });
      const [dmg, zip] = RELEASE_FILES[target];
      log(`zipping into ${zip}`);
      zipApp(built.app, path.join(release, zip));
      log(`making ${dmg}`);
      dmgApp(built.app, path.join(release, dmg), { work });
      report.files = sizesOf(release, RELEASE_FILES[target]);
    } else {
      const to = path.join(out, "test-variant", target);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      execFileSync("/usr/bin/ditto", [built.app, path.join(to, path.basename(built.app))]);
      report.app = path.join(to, path.basename(built.app));
    }
  } else {
    const { buildWindowsApp, buildSetup } = await import("./packaging/windows.mjs");
    built = await buildWindowsApp({ electronDist: dist, work, kind, version, cacheDir, commit, log });
    if (kind === "release") {
      const release = path.join(out, "release");
      mkdirSync(release, { recursive: true });
      const [setup] = RELEASE_FILES[target];
      log(`making ${setup}`);
      report.setup = buildSetup({ appFolder: built.appFolder, work, out: path.join(release, setup), version, log });
      report.files = sizesOf(release, RELEASE_FILES[target]);
    } else {
      const to = path.join(out, "test-variant", target);
      rmSync(to, { recursive: true, force: true });
      mkdirSync(path.dirname(to), { recursive: true });
      cpSync(built.appFolder, path.join(to, path.basename(built.appFolder)), { recursive: true });
      report.app = path.join(to, path.basename(built.appFolder));
    }
  }
  report.fuses = { wire: built.fuses.wire, expected: RELEASE_WIRE };
  report.archive = { headerHash: built.headerHash, files: built.archiveFiles.length };
  report.emulatorFiles = built.emulatorFiles.length;
  report.parts = built.parts ?? null;
  mkdirSync(path.join(out, "reports"), { recursive: true });
  writeFileSync(path.join(out, "reports", `build-${kind}-${target}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main(argv) {
  const args = [...argv];
  const command = args.shift();
  const take = (name) => {
    const at = args.indexOf(name);
    if (at < 0) return null;
    const value = args[at + 1];
    if (value === undefined) throw new Error(`${name} needs a value`);
    args.splice(at, 2);
    return value;
  };
  const flag = (name) => {
    const at = args.indexOf(name);
    if (at >= 0) args.splice(at, 1);
    return at >= 0;
  };
  const log = (line) => console.error(`dist: ${line}`);
  if (command === "build") {
    const kind = take("--kind") ?? "release";
    const arch = take("--arch");
    if (arch !== null && !["arm64", "x64", "all"].includes(arch)) throw new Error(`--arch takes arm64, x64 or all, not ${arch}`);
    const out = path.resolve(take("--out") ?? defaultOutDir());
    const cacheDir = take("--cache");
    const allowUncommitted = flag("--allow-uncommitted");
    if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    const reports = await build({ kind, arch, out, cacheDir: cacheDir ? path.resolve(cacheDir) : undefined, allowUncommitted, log });
    // One document: the report of the one target built, or the list of them.
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
    return 0;
  }
  if (command === "sums") {
    const folder = path.resolve(args.shift() ?? path.join(defaultOutDir(), "release"));
    if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    for (const line of await writeSums(folder)) console.log(line);
    log(`wrote ${path.join(folder, SUMS_FILE)}`);
    return 0;
  }
  if (command === "check") {
    const { checkRelease, useExportCheck } = await import("./packaging/check.mjs");
    const partial = flag("--partial");
    const exportCheck = take("--export-check");
    const folder = path.resolve(args.shift() ?? path.join(defaultOutDir(), "release"));
    if (exportCheck) {
      if (!existsSync(path.join(exportCheck, "check.mjs"))) throw new Error(`--export-check ${exportCheck}: no export check there (tools/export-check of the internal repository)`);
      useExportCheck(exportCheck);
    }
    if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
    const result = await checkRelease({ folder, partial, log });
    const reports = path.join(path.dirname(folder), "reports");
    mkdirSync(reports, { recursive: true });
    writeFileSync(path.join(reports, `check-${targetOfHost()}.json`), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    if (result.problems.length) {
      console.error(`dist: ${result.problems.length} problem(s):\n  ${result.problems.join("\n  ")}`);
      return 1;
    }
    // Sound files that must not be published yet, or that this system could not read: a code of their own, so that
    // a release cannot go out by mistake.
    if (result.skipped.length) {
      console.error(`dist: the files this system can read are sound; these were not checked here (check them on their own system):\n  ${result.skipped.join("\n  ")}`);
      return 3;
    }
    if (result.publication.files.length) {
      console.error(`dist: the files are sound, but ${result.publication.files.length} file(s) in the app must not be published:\n  ${result.publication.files.map((f) => `${f.file}: ${f.why}`).join("\n  ")}`);
      return 3;
    }
    if (!result.publication.checked) {
      console.error(`dist: the files are sound; whether they may be published was not checked: ${result.publication.reasons.join("; ") || "no file was read"}`);
      return 3;
    }
    return 0;
  }
  console.error("usage: dist.mjs build [--kind release|test] [--arch arm64|x64|all] [--out <dir>] [--cache <dir>] [--allow-uncommitted]\n       dist.mjs sums [<release folder>]\n       dist.mjs check [<release folder>] [--partial] [--export-check <folder>]");
  return 2;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`dist: ${e.message}`);
      process.exitCode = 1;
    },
  );
}

