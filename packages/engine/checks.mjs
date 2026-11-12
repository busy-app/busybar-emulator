// Checks of what the engine's build reads and writes, shared by the build (build.mjs), the server (it counts a
// firmware's local web before serving it) and the tests. Nothing here needs emsdk; git is needed only by dirtyEntries.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { runProgram } from "./programs.mjs";

/** "._name" is what macOS leaves beside name on a disk without extended attributes; .DS_Store is Finder's. */
const isClutter = (name) => name.startsWith("._") || name === ".DS_Store";

/** The files under `dir`, as sorted paths relative to it with forward slashes; none if it is not there. */
export function filesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !isClutter(e.name))
    .map((e) => relative(dir, join(e.parentPath, e.name)).replaceAll("\\", "/"))
    .sort();
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The id git gives the tree of `dir` when every file in it is a plain one (mode 100644), as in the firmware's local
 * web: `git rev-parse <commit>:<path>` in the firmware gives the same id for the folder the copy was made from.
 */
export function gitTreeId(dir) {
  const object = (type, body) => createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest();
  const tree = (path) => {
    const entries = readdirSync(path, { withFileTypes: true })
      .filter((e) => !isClutter(e.name))
      .map((e) => (e.isDirectory() ? { name: e.name, mode: "40000", id: tree(join(path, e.name)) } : { name: e.name, mode: "100644", id: object("blob", readFileSync(join(path, e.name))) }));
    // Git sorts a tree's entries by name as bytes, a folder as if its name ended in "/".
    const key = (e) => Buffer.from(e.mode === "40000" ? `${e.name}/` : e.name);
    entries.sort((a, b) => Buffer.compare(key(a), key(b)));
    return object("tree", Buffer.concat(entries.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), e.id])));
  };
  return tree(dir).toString("hex");
}

// ---------------------------------------------------------------- the list of app assets (apps-assets.json)

export const readManifest = (file) => JSON.parse(readFileSync(file, "utf8"));

/** apps-assets.json as it is kept: the head as usual JSON, then one line per file. */
export function manifestText(manifest) {
  const { files, ...head } = manifest;
  const record = (value) => `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;
  const lines = Object.keys(files).sort().map((path) => `    ${JSON.stringify(path)}: ${record(files[path])}`);
  return `${JSON.stringify(head, null, 2).slice(0, -2)},\n  "files": {\n${lines.join(",\n")}\n  }\n}\n`;
}

/**
 * What is wrong between the list and the folder: a file that is not listed, a listed file that is not there, a file
 * whose bytes are not the ones the list records. One line each; none when they agree.
 */
export function assetsProblems(manifest, dir) {
  const listed = Object.keys(manifest.files);
  const present = filesIn(dir);
  const problems = [];
  for (const f of present) if (!listed.includes(f)) problems.push(`build/apps-assets/${f} is not in apps-assets.json: add it with where it comes from and its sha256`);
  for (const f of listed) {
    if (!present.includes(f)) problems.push(`apps-assets.json lists ${f}, which is not in build/apps-assets`);
    else if (sha256(readFileSync(join(dir, f))) !== manifest.files[f].sha256) problems.push(`build/apps-assets/${f} does not have the bytes apps-assets.json records (sha256): restore the file, or record where the new one comes from`);
  }
  return problems;
}

/**
 * Takes the assets that came from a firmware build (origin "firmware-build") again from `from`, the
 * resources/apps_assets folder of such a build. Files read from a bar are left alone, whatever folder they are in.
 * Stops before writing anything when `from` lacks a listed file or has one that is not listed in the same folders.
 * `write(bytes, file)` puts a changed file in place. Returns the problems, or the paths whose bytes changed (their
 * sha256 in `manifest` is updated).
 */
export function refreshAssets(manifest, from, to, write) {
  const origin = (f) => manifest.files[f]?.origin;
  const mine = Object.keys(manifest.files).filter((f) => origin(f) === "firmware-build").sort();
  const folders = [...new Set(mine.map((f) => f.slice(0, f.lastIndexOf("/"))))];
  const theirs = folders.flatMap((folder) => filesIn(join(from, folder)).map((f) => `${folder}/${f}`));
  const problems = [
    ...mine.filter((f) => !theirs.includes(f)).map((f) => `${from} has no ${f}, which apps-assets.json lists as coming from a firmware build`),
    ...theirs.filter((f) => origin(f) === undefined).map((f) => `${from} has ${f}, which is not in apps-assets.json: add it with the firmware source it is made from`),
  ];
  if (problems.length) return { problems, changed: [] };
  const changed = [];
  for (const f of mine) {
    const bytes = readFileSync(join(from, f));
    const hash = sha256(bytes);
    if (hash === manifest.files[f].sha256) continue;
    write(bytes, join(to, f));
    manifest.files[f].sha256 = hash;
    changed.push(f);
  }
  return { problems, changed };
}

// ---------------------------------------------------------------- the firmware checkout and the compiler

/**
 * What `git status` reports in the checkout at `repo`: changed, added, removed and untracked files, without the
 * clutter macOS leaves. Does not take git's optional locks, so nothing is written to the checkout.
 */
export function dirtyEntries(repo) {
  return runProgram("git", ["--no-optional-locks", "-C", repo, "status", "--porcelain"], { maxBuffer: 1 << 26 })
    .toString()
    .split("\n")
    .filter((line) => line && !isClutter(line.slice(3).replace(/^"|"$/g, "").split("/").pop()));
}

/** "7.0.0" from the first line of `emcc --version`; null when it is not there. */
export const emscriptenVersion = (text) => /\b(\d+\.\d+\.\d+)\b/.exec(text.split("\n")[0])?.[1] ?? null;
