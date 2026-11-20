// Builds the versions of the update chain (EMU-341; update-chain.mjs runs it): each one the test variant
// (tools/dist.mjs build --kind test) of a commit under a version of its own, and its file as a release carries it for
// this system (the zip of the app on macOS, setup.exe on Windows), made by that commit's own packaging. No window opens
// and nothing is installed: the output is a folder that update-chain.mjs takes.
//
//   node test/update-chain/build.mjs <work folder> [<commit>[=<version>]]... [--plan]
//
// Without commits, the chain people's copies take: 0.1.0-beta.5 (the last release of data folder format 1), then
// 0.1.0-beta.6 (format 2), then this tree's HEAD under a version above beta.6 (its own when that is newer, else
// "<beta.6>.chain"). A commit without "=<version>" keeps the version in its packages/app/package.json; the versions
// must rise from one to the next, as the update offers only a newer one. --plan says what would be built and builds
// nothing.
//
// Each commit is checked out as a git worktree in <work>/src-<n> (removed after its build), with packages/app's
// node_modules of this tree (an APFS clone on macOS, a junction on Windows; the commit must name the same Electron).
// <work>/chain.json lists the versions: { platform, arch, asset, steps: [{ commit, version, format, app, file }] }.
// <work> must lie outside the repository, and on a disk with room: about 1.2 GB a version (2 min each on an M-series
// Mac, 18.11). After a release, DEFAULT_CHAIN moves on: the last release of the oldest data folder format people may
// still have, the last release, HEAD.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execProgram } from "../../../engine/programs.mjs";
import { compareVersions, versionText } from "../../src/update-check.mjs";
import { updateAssetFor } from "../../src/update-manifest.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The default chain: the release commits (docs/release.md, its table of releases; agents-log.md) and HEAD. */
export const DEFAULT_CHAIN = Object.freeze(["aa1b8a02", "826b3156", "HEAD"]);

const gitIn = (repo) => (args) => execProgram("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

/** "<commit>" or "<commit>=<version>": { commit, version | null }. */
export function parseSpec(text) {
  const at = text.indexOf("=");
  const commit = at < 0 ? text : text.slice(0, at);
  const version = at < 0 ? null : text.slice(at + 1);
  if (!/^[0-9A-Za-z._/~^-]+$/.test(commit)) throw new Error(`Not a commit: ${JSON.stringify(commit)}`);
  if (version !== null && versionText(version) !== version) throw new Error(`Not a version: ${JSON.stringify(version)} (as 0.1.0-beta.7)`);
  return { commit, version };
}

/**
 * What each step is: { commit (full), version, format, electron }, read from the commit with `git` (a function of git's
 * arguments). Versions must rise; a step without a version takes its package.json's, and the last step of the default
 * chain (HEAD) one above the step before it when its own is not.
 */
export function planChain(specs, { git, defaults = specs.length === 0 }) {
  const wanted = (defaults ? DEFAULT_CHAIN.map((commit) => ({ commit, version: null })) : specs.map(parseSpec));
  if (wanted.length < 2) throw new Error("A chain is two versions at least: the one installed and the one it updates to.");
  const steps = [];
  for (const [i, { commit, version }] of wanted.entries()) {
    const full = git(["rev-parse", "--verify", `${commit}^{commit}`]).trim();
    const show = (file) => git(["show", `${full}:emulator/${file}`]);
    const app = JSON.parse(show("packages/app/package.json"));
    const format = Number(/export const FORMAT = (\d+);/.exec(show("packages/server/data-folder.mjs"))?.[1]);
    let chosen = version ?? app.version;
    const before = steps.at(-1);
    if (defaults && i === wanted.length - 1 && version === null && before && !(compareVersions(chosen, before.version) > 0)) chosen = `${before.version}.chain`;
    if (before && !(compareVersions(chosen, before.version) > 0)) throw new Error(`${chosen} (${commit}) is not newer than ${before.version} (${before.commit.slice(0, 8)}): the update offers only a newer version.`);
    steps.push({ commit: full, version: chosen, format, electron: app.devDependencies?.electron ?? null });
  }
  return steps;
}

/** packages/app/node_modules of this tree in `appDir` of a worktree: a clone of the files on macOS, a junction on Windows. */
function lendNodeModules(appDir) {
  const from = path.join(APP_DIR, "node_modules");
  const to = path.join(appDir, "node_modules");
  if (!existsSync(path.join(from, "electron"))) throw new Error(`${from} has no Electron: npm ci in packages/app first.`);
  if (process.platform === "win32") symlinkSync(from, to, "junction");
  else if (process.platform === "darwin") execFileSync("/bin/cp", ["-cR", from, to]);
  else cpSync(from, to, { recursive: true });
}

/** Takes the lent node_modules out of a worktree's `appDir`: a junction (or link) is unlinked, never followed. */
export function unlendNodeModules(appDir, { lstat = lstatSync, unlink = unlinkSync, rmdir = rmdirSync } = {}) {
  const at = path.join(appDir, "node_modules");
  let stat;
  try {
    stat = lstat(at);
  } catch {
    return "none";
  }
  if (!stat.isSymbolicLink()) return "copy";
  try {
    unlink(at);
  } catch {
    // A junction on Windows is a directory to unlink: rmdir takes the junction itself, not what it points to.
    rmdir(at);
  }
  return "unlinked";
}

async function buildStep(step, n, { work, repo, git, log }) {
  const src = path.join(work, `src-${n}`);
  const out = path.join(work, `out-${n}`);
  rmSync(src, { recursive: true, force: true });
  git(["worktree", "add", "--detach", "--force", src, step.commit]);
  try {
    const appDir = path.join(src, "emulator", "packages", "app");
    const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
    const ours = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).devDependencies.electron;
    if (pkg.devDependencies.electron !== ours) throw new Error(`${step.commit.slice(0, 8)} names Electron ${pkg.devDependencies.electron}, this tree's node_modules has ${ours}: build that version by hand.`);
    pkg.version = step.version;
    writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    lendNodeModules(appDir);
    log(`${n}: building ${step.version} of ${step.commit.slice(0, 8)} (the test variant) into ${out}`);
    execFileSync(process.execPath, [path.join(appDir, "tools", "dist.mjs"), "build", "--kind", "test", "--allow-uncommitted", "--out", out], { cwd: appDir, stdio: "inherit" });
    const target = `${process.platform === "win32" ? "win32" : "darwin"}-${process.arch}`;
    const report = JSON.parse(readFileSync(path.join(out, "reports", `build-test-${target}.json`), "utf8"));
    if (report.version !== step.version) throw new Error(`the build of ${step.commit.slice(0, 8)} says version ${report.version}, not ${step.version}`);
    const asset = updateAssetFor(process.platform, process.arch);
    const file = path.join(work, `v${n}`, asset);
    mkdirSync(path.dirname(file), { recursive: true });
    // The commit's own packaging makes its file, as its release would.
    const packaging = (name) => import(pathToFileURL(path.join(appDir, "tools", "packaging", name)).href);
    if (process.platform === "darwin") (await packaging("macos.mjs")).zipApp(report.app, file);
    else {
      const setupWork = path.join(out, "work", "setup");
      mkdirSync(setupWork, { recursive: true });
      (await packaging("windows.mjs")).buildSetup({ appFolder: report.app, work: setupWork, out: file, version: step.version, log });
    }
    return { ...step, app: report.app, file };
  } finally {
    // The built app stays in <out>; the worktree goes. node_modules first, when it is a junction: git would delete
    // through it, into this tree's own packages/app/node_modules.
    unlendNodeModules(path.join(src, "emulator", "packages", "app"));
    git(["worktree", "remove", "--force", src]);
  }
}

async function main(argv) {
  const plan = argv.includes("--plan");
  const [work, ...specs] = argv.filter((a) => a !== "--plan");
  if (!work) {
    console.error("node test/update-chain/build.mjs <work folder> [<commit>[=<version>]]... [--plan]");
    return 2;
  }
  const repo = execProgram("git", ["-C", APP_DIR, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = gitIn(repo);
  const at = path.resolve(work);
  if (!path.relative(repo, at).startsWith("..") && !path.isAbsolute(path.relative(repo, at))) throw new Error(`${at} lies in the repository: name a folder outside it.`);
  const steps = planChain(specs, { git });
  const asset = updateAssetFor(process.platform, process.arch);
  if (!asset) throw new Error(`No update for ${process.platform}-${process.arch}.`);
  for (const [i, s] of steps.entries()) console.log(`${i + 1}. ${s.version} at ${s.commit.slice(0, 8)}, data folder format ${s.format}, Electron ${s.electron}`);
  if (plan) return 0;
  mkdirSync(at, { recursive: true });
  const built = [];
  for (const [i, step] of steps.entries()) built.push(await buildStep(step, i + 1, { work: at, repo, git, log: (line) => console.log(line) }));
  const chain = { platform: process.platform, arch: process.arch, asset, built: new Date().toISOString(), steps: built };
  writeFileSync(path.join(at, "chain.json"), `${JSON.stringify(chain, null, 2)}\n`);
  console.log(`${path.join(at, "chain.json")}: ${built.map((s) => s.version).join(" -> ")}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e?.message ?? e);
      process.exitCode = 1;
    },
  );
}
