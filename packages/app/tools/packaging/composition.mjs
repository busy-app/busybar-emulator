// What goes into the app: the files of the app's archive, and what the resources folder holds beside it. One list for
// the packaging, which copies by it, and for the check of the produced files, which compares with it. Nothing goes in
// by being in the folder: the app's files come from tools/release-files.mjs, the server's and the engine's from git
// (committed files only, so a stray file in the working tree is never shipped), filtered by the rules below.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execProgram } from "../../../engine/programs.mjs";
import { releaseFiles } from "../release-files.mjs";

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EMULATOR_DIR = path.resolve(APP_DIR, "..", "..");

/** Files of the app's archive that the bundled Node runs, so they lie outside it (Node cannot read app.asar). */
export const UNPACKED_IN_ARCHIVE = Object.freeze(["src/supervisor.mjs"]);

/** The fields of package.json the app needs at run time; the rest (scripts, development dependencies) stays out. */
export const MANIFEST_FIELDS = Object.freeze(["name", "productName", "version", "description", "license", "main", "type"]);

/** The parts of packages/server that are not the server at run time, each with the reason. */
export const SERVER_LEFT_OUT = Object.freeze([
  { test: (p) => p.split("/").includes("test"), why: "tests" },
  { test: (p) => p.endsWith(".test.mjs"), why: "tests" },
  // Test support is named so (capture/test-support.mjs, capture/catalog-test-support.mjs); capture/png-bench.mjs is a
  // benchmark. Every other module of the folder ships: the screenshot's PNG encoder, the catalog's check of such a file
  // (a port of the catalog's code, shipped with its owner's permission), the clip recorder with its limits, the GIF encoder and
  // its worker, the icons. What the server and the command line import is checked against this list by test/unit/packaging.test.mjs.
  // readiness/ is the catalog's checks for `check` and `submit`, with the copy of its registry.
  { test: (p) => p.endsWith("test-support.mjs"), why: "test support" },
  { test: (p) => p === "capture/png-bench.mjs", why: "a benchmark" },
  { test: (p) => path.posix.basename(p) === "README.md", why: "documentation of the source tree" },
]);

/** The parts of packages/engine the server needs: what it reads at run time. The engine's build sources stay out. */
export const ENGINE_TAKEN = Object.freeze([
  { test: (p) => p === "firmware.json", why: "the firmware versions" },
  { test: (p) => p === "checks.mjs", why: "imported by the server's firmware loader" },
  { test: (p) => p === "programs.mjs", why: "how the server and the command line start programs: by full path, never from the current folder" },
  { test: (p) => p.startsWith("build/") && !/^build\/(obj|src|gen|out)\//.test(p), why: "the built engine: runtime and screen modules, local web, apps assets" },
]);

/**
 * The 3D view of the bar (packages/stage): only what its frame loads, the folder the server gives out at
 * /emulator/stage3d/frame/ (packages/server/stage3d.mjs) — the frame's page, the unmodified files of the Tride
 * player with the player's LICENSE and THIRD_PARTY_NOTICES.md beside them, and the scene. The scene's build scripts,
 * the package's README and its tests stay out.
 */
export const STAGE_TAKEN = (p) => p.startsWith("frame/");

/**
 * The example apps `busy-emulator create --example` starts a project from (emulator/examples/<name>): every file of
 * an example, its README and pictures too, since the whole folder becomes the author's project. Not the folder's own
 * README and not tools/, with which the maintainers draw the examples' pictures.
 */
export const EXAMPLE_TAKEN = (p) => p.includes("/") && !p.startsWith("tools/");

/** git, found on PATH and started by its full path (on Windows the current folder must not choose it). */
export function git(args, cwd) {
  return execProgram("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** Committed files of a folder of the repository, relative to it, with forward slashes. */
export function committedFiles(folder) {
  return git(["ls-files", "-z", "--", "."], folder)
    .split("\0")
    .filter(Boolean)
    .sort();
}

/**
 * What git sees in a folder of the working tree, committed or not yet, and that is there, relative, with forward
 * slashes: the files a test lays out an app with (stage-resources.mjs), so that a module not committed yet is in it.
 */
export function workingFiles(folder) {
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], folder).split("\0").filter(Boolean);
  return [...new Set(listed)].filter((f) => existsSync(path.join(folder, ...f.split("/")))).sort();
}

/**
 * What the modules of a release import that the release lacks, read from the modules themselves rather than from the
 * list they were copied by: for every .mjs, .js and .cjs file of `files` (relative to `folder`, with forward slashes),
 * each relative specifier — a static import or export, a dynamic import of a literal, new URL("./x", import.meta.url) —
 * resolved against the module's place in the source tree `source`. One that names a file of the source which is not
 * in `folder` is a problem: "<module> imports <file>, which is missing". A specifier that names no file of the source
 * is text in a module (the template's code that create writes), not an import.
 */
export function missingImports({ folder, files, source = EMULATOR_DIR }) {
  const have = new Set(files);
  const problems = [];
  for (const file of files) {
    if (!/\.(mjs|cjs|js)$/.test(file)) continue;
    const text = readFileSync(path.join(folder, ...file.split("/")), "utf8");
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\bnew URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
      if (have.has(target)) continue;
      const inSource = path.join(source, ...target.split("/"));
      if (!target.startsWith("../") && existsSync(inSource) && statSync(inSource).isFile()) problems.push(`emulator/${file} imports ${m[1]} (emulator/${target}), which is missing`);
      else if (target.startsWith("../") && existsSync(path.resolve(source, target))) problems.push(`emulator/${file} imports ${m[1]}, outside emulator/`);
    }
  }
  return [...new Set(problems)];
}

/** What is changed or not committed in the folders a build takes files from. Empty when the build is of a commit. */
export function uncommittedChanges(folders = [APP_DIR, path.join(EMULATOR_DIR, "packages", "server"), path.join(EMULATOR_DIR, "packages", "engine"), path.join(EMULATOR_DIR, "packages", "stage"), path.join(EMULATOR_DIR, "examples")]) {
  const out = [];
  for (const folder of folders) {
    const lines = git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], folder).split("\0").filter(Boolean);
    for (const line of lines) out.push(`${path.relative(EMULATOR_DIR, folder).split(path.sep).join("/")}: ${line}`);
  }
  return out;
}

/** What the export writes at the top of the public tree (tools/export in the internal repository): its record. */
export const EXPORT_RECORD = ".busybar-export.json";

/**
 * The commit a build records in its marker and names in the license summary: a commit of the internal repository.
 * There it is HEAD. In the exported tree — the public repository, which has none of the internal history — it is the
 * commit the export was made from, as the export's record at the top of the tree names it: a release built from the
 * exported tree is then the same bytes as one built from that commit, and the summary names a commit that exists.
 * The record must be committed and unchanged, like every file a release is built from.
 */
export function sourceCommit({ emulatorDir = EMULATOR_DIR, appDir = APP_DIR } = {}) {
  const record = path.join(emulatorDir, EXPORT_RECORD);
  if (!existsSync(record)) return git(["rev-parse", "HEAD"], appDir).trim();
  if (git(["status", "--porcelain=v1", "--untracked-files=all", "--", EXPORT_RECORD], emulatorDir).trim()) throw new Error(`${EXPORT_RECORD} is changed or not committed: it names the commit the build records`);
  const from = JSON.parse(readFileSync(record, "utf8")).from;
  if (!/^[0-9a-f]{40}$/.test(from ?? "")) throw new Error(`${EXPORT_RECORD} names no commit the tree was exported from`);
  return from;
}

/**
 * The files the resources folder gets under emulator/: packages/server without what SERVER_LEFT_OUT names, the
 * part of packages/engine ENGINE_TAKEN names, the 3D view's frame (STAGE_TAKEN) and the example apps. Paths relative
 * to emulator/, with forward slashes, sorted.
 */
export function emulatorFiles({ emulatorDir = EMULATOR_DIR, list = committedFiles } = {}) {
  const server = list(path.join(emulatorDir, "packages", "server")).filter((p) => !SERVER_LEFT_OUT.some((rule) => rule.test(p)));
  const engine = list(path.join(emulatorDir, "packages", "engine")).filter((p) => ENGINE_TAKEN.some((rule) => rule.test(p)));
  const examplesDir = path.join(emulatorDir, "examples");
  const examples = (list !== committedFiles || existsSync(examplesDir) ? list(examplesDir) : []).filter(EXAMPLE_TAKEN);
  // A tree without the 3D view (an export made before it, a test's small tree) is a whole emulator: the flat view.
  const stageDir = path.join(emulatorDir, "packages", "stage");
  const stage = (list !== committedFiles || existsSync(stageDir) ? list(stageDir) : []).filter(STAGE_TAKEN);
  return [...server.map((p) => `packages/server/${p}`), ...engine.map((p) => `packages/engine/${p}`), ...stage.map((p) => `packages/stage/${p}`), ...examples.map((p) => `examples/${p}`)].sort();
}

/** The trimmed package.json of the archive. */
export function archiveManifest(appDir = APP_DIR) {
  const manifest = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
  const out = {};
  for (const field of MANIFEST_FIELDS) if (manifest[field] !== undefined) out[field] = manifest[field];
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * The entries of app.asar: { name, file } or { name, bytes }. The release has the files of tools/release-files.mjs
 * (package.json trimmed) and the marker; the test variant has its folder as well.
 */
export function archiveEntries({ kind, marker, appDir = APP_DIR }) {
  if (kind !== "release" && kind !== "test") throw new Error(`A build is a release or the test variant, not ${kind}`);
  const entries = [];
  // What git sees, committed or not yet: a file git ignores (a log, notes, a local secret) is never packed, wherever
  // it lies. A release is built from a commit only (dist.mjs), so there the two lists are the same.
  const known = new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], appDir).split("\0").filter(Boolean));
  for (const name of releaseFiles(appDir).filter((n) => known.has(n))) {
    entries.push(name === "package.json" ? { name, bytes: Buffer.from(archiveManifest(appDir)) } : { name, file: path.join(appDir, ...name.split("/")) });
  }
  if (kind === "test") {
    for (const name of committedFiles(path.join(appDir, "test-variant"))) entries.push({ name: `test-variant/${name}`, file: path.join(appDir, "test-variant", ...name.split("/")) });
  }
  entries.push({ name: "build.json", bytes: Buffer.from(marker) });
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * What is wrong with the list of files in a release's app.asar, one line each: compared with the expected list, and
 * against the rules that hold whatever the list says (no test variant, no tests, no dependencies, the marker says
 * release).
 */
export function archiveProblems({ files, expected, marker }) {
  const problems = [];
  const have = new Set(files);
  const want = new Set(expected);
  for (const f of files) if (!want.has(f)) problems.push(`app.asar has ${f}, which is not on the list`);
  for (const f of expected) if (!have.has(f)) problems.push(`app.asar lacks ${f}`);
  for (const f of files) {
    if (f === "test-variant" || f.startsWith("test-variant/")) problems.push(`app.asar holds the test variant: ${f}`);
    if (f.split("/").includes("test") || /\.test\.m?js$/.test(f)) problems.push(`app.asar holds a test: ${f}`);
    if (f.split("/").includes("node_modules")) problems.push(`app.asar holds a dependency: ${f}`);
  }
  if (marker?.kind !== "release") problems.push(`the marker in app.asar says ${JSON.stringify(marker?.kind)}, not "release"`);
  return problems;
}

/**
 * What is wrong with the files under <resources>/emulator, one line each: compared with the expected list, and against
 * the rules (no tests, no engine build sources, no dependencies).
 */
export function emulatorProblems({ files, expected }) {
  const problems = [];
  const have = new Set(files);
  const want = new Set(expected);
  for (const f of files) if (!want.has(f)) problems.push(`emulator/${f} is not on the list`);
  for (const f of expected) if (!have.has(f)) problems.push(`emulator/${f} is missing`);
  for (const f of files) {
    if (f.split("/").includes("test") || /\.test\.m?js$/.test(f)) problems.push(`a test: emulator/${f}`);
    if (/^packages\/engine\/(native|test)\//.test(f) || /^packages\/engine\/(build|patches)\.mjs$/.test(f)) problems.push(`a build source of the engine: emulator/${f}`);
    if (f.split("/").includes("node_modules")) problems.push(`a dependency: emulator/${f}`);
    if (/^packages\/(app|contract)\//.test(f)) problems.push(`not part of the server: emulator/${f}`);
  }
  return problems;
}

/** Bytes of a list of files under a folder: the sum of their sizes, not the space they take (exFAT counts more). */
export function bytesOf(folder, files) {
  return files.reduce((sum, f) => sum + statSync(path.join(folder, ...f.split("/"))).size, 0);
}
