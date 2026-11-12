#!/usr/bin/env node
// The parts of a packaged app's resources folder that EMU-202 owns, laid out as the shell and the command line expect
// them. The packaging (EMU-203) calls these functions; the tests call stageResources() to lay out an app anywhere, with
// the same files a release gets.
//
//   <resources>/build.json                           the marker: { kind, version, node } (also inside the app's archive)
//   <resources>/node/                                the bundled Node (tools/bundled-node.mjs)
//   <resources>/gh/                                  GitHub CLI, for publishing (tools/bundled-gh.mjs): bin/gh, LICENSE
//   <resources>/bin/busy-emulator                    macOS: the command line's entry inside the app (a sh script)
//   <resources>/bin/busy-emulator.exe                Windows: the same, a real executable (tools/windows-launcher.mjs)
//   <resources>/emulator/                            the server with its command line, the part of the engine it runs
//                                                    on, the 3D view's frame and the example apps: the one list of
//                                                    packaging/composition.mjs (emulatorFiles), which a release copies
//   <resources>/app/                                 for tests only: the app's own files, unpacked (a release has
//                                                    app.asar, made by the packaging)
//
//   node tools/stage-resources.mjs <target> <resources folder> --kind release|test [--cache <dir>] [--app]
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchArchive as fetchGhArchive, readPin as readGhPin, stageGh } from "./bundled-gh.mjs";
import { defaultCacheDir, fetchArchive, readPin, stageNode } from "./bundled-node.mjs";
import { committedFiles, EMULATOR_DIR, emulatorFiles } from "./packaging/composition.mjs";
import { releaseFiles } from "./release-files.mjs";
import { buildWindowsLauncher } from "./windows-launcher.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BUILD_MARKER = "build.json";

const appVersion = () => JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;

/**
 * The marker that makes a build a release or the test variant (src/build-kind.mjs). The packaging also records the
 * commit the build was made from (the sources that match the app, which the GPL asks to name; ADR-0003).
 */
export function writeBuildMarker(folder, { kind, version = appVersion(), node = readPin().version, commit = undefined }) {
  if (kind !== "release" && kind !== "test") throw new Error(`A build is a release or the test variant, not ${kind}`);
  if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Not a commit: ${commit}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, BUILD_MARKER), `${JSON.stringify(commit === undefined ? { kind, version, node } : { kind, version, node, commit })}\n`);
}

/**
 * <resources>/emulator: the files of emulatorFiles() (packaging/composition.mjs), the list a release is copied by
 * and checked against. `list` gives a folder's files: the committed ones for a release; a test lays out what git
 * sees in the working tree (workingFiles), so that a module not yet committed is there too. Returns the command
 * line's folder and the files.
 */
export function stageEmulator(resourcesDir, { list = committedFiles } = {}) {
  const to = path.join(resourcesDir, "emulator");
  rmSync(to, { recursive: true, force: true });
  const files = emulatorFiles({ list });
  for (const file of files) {
    const out = path.join(to, ...file.split("/"));
    mkdirSync(path.dirname(out), { recursive: true });
    copyFileSync(path.join(EMULATOR_DIR, ...file.split("/")), out);
  }
  return { cli: path.join(to, "packages", "server", "cli"), files };
}

/** The command line's entry inside the app: the sh script on macOS, the executable on Windows. */
export function placeInAppLauncher({ target, resourcesDir, windowsLauncher = null }) {
  const bin = path.join(resourcesDir, "bin");
  mkdirSync(bin, { recursive: true });
  if (target.startsWith("win32-")) {
    const out = path.join(bin, "busy-emulator.exe");
    if (windowsLauncher) copyFileSync(windowsLauncher, out);
    else buildWindowsLauncher(out);
    return out;
  }
  const out = path.join(bin, "busy-emulator");
  copyFileSync(path.join(APP_DIR, "launcher", "macos", "busy-emulator"), out);
  chmodSync(out, 0o755);
  return out;
}

/** For tests: the app's own files unpacked in <resources>/app, with the marker; the test variant has its folder. */
export function stageAppFolder({ resourcesDir, kind }) {
  const to = path.join(resourcesDir, "app");
  rmSync(to, { recursive: true, force: true });
  for (const file of releaseFiles()) {
    mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    copyFileSync(path.join(APP_DIR, file), path.join(to, file));
  }
  if (kind === "test") cpSync(path.join(APP_DIR, "test-variant"), path.join(to, "test-variant"), { recursive: true });
  writeBuildMarker(to, { kind });
  return to;
}

/**
 * Lays out a resources folder.
 * @param {object} o
 * @param {string} o.target            darwin-arm64 | darwin-x64 | win32-x64
 * @param {string} o.resourcesDir
 * @param {"release" | "test"} o.kind
 * @param {string} [o.cacheDir]        where the Node archives are kept (gh's: beside it, in gh/)
 * @param {string} [o.windowsLauncher] a built busy-emulator.exe to use instead of building one
 * @param {boolean} [o.appFolder]      also the app's files in <resources>/app (tests)
 * @param {Function} [o.list]          a folder's files for emulatorFiles(): committed (default), or workingFiles (tests)
 */
export async function stageResources({ target, resourcesDir, kind, cacheDir = defaultCacheDir(), windowsLauncher = null, appFolder = false, commit = undefined, list = committedFiles, log = () => {} }) {
  const pin = readPin();
  mkdirSync(resourcesDir, { recursive: true });
  const archive = await fetchArchive({ pin, target, cacheDir, log });
  const node = stageNode({ pin, target, archive, resourcesDir });
  const ghPin = readGhPin();
  const ghCache = path.join(path.dirname(cacheDir), "gh");
  const gh = stageGh({ pin: ghPin, target, archive: await fetchGhArchive({ pin: ghPin, target, cacheDir: ghCache, log }), resourcesDir });
  const launcher = placeInAppLauncher({ target, resourcesDir, windowsLauncher });
  const { cli, files } = stageEmulator(resourcesDir, { list });
  writeBuildMarker(resourcesDir, { kind, node: pin.version, commit });
  const app = appFolder ? stageAppFolder({ resourcesDir, kind }) : null;
  return { resourcesDir, node, launcher, cli, app, emulatorFiles: files };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const take = (name) => {
    const at = args.indexOf(name);
    if (at < 0) return null;
    return args.splice(at, 2)[1];
  };
  const kind = take("--kind");
  const cacheDir = take("--cache");
  const appFolder = args.includes("--app");
  const [target, resourcesDir] = args.filter((word) => word !== "--app");
  if (!target || !resourcesDir || !kind) {
    console.error("usage: stage-resources.mjs <target> <resources folder> --kind release|test [--cache <dir>] [--app]");
    process.exit(2);
  }
  stageResources({ target, resourcesDir: path.resolve(resourcesDir), kind, cacheDir: cacheDir ? path.resolve(cacheDir) : undefined, appFolder, log: (line) => console.error(line) })
    .then((staged) => console.log(JSON.stringify(staged, null, 2)))
    .catch((e) => {
      console.error(`stage-resources: ${e.message}`);
      process.exit(1);
    });
}
