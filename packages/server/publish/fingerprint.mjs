// What Pre-flight check and Build and package saw of the project, so that a later step can tell whether it is still
// the same project (stale-check). The product owner passed the check in the release build, broke src/main.ts in an editor and
// came back: the window still said the check passed and let him go on. Now each of those steps records a
// fingerprint of the files that matter, in the project's .busy/publish.json, and every later step compares it with
// the project as it is: when a file changed, the step is stale ("Changed since the check") and the check runs again.
//
// The files that matter are the ones that get published or built: every file the public repository would get (what
// git would take, publish/tree.mjs: src/, the appmeta, package.json, the lock file, the assets, README, LICENSE,
// catalog.json, screenshots, tsconfig.json, shared/ …), and for the package also submission/, which the package step
// writes and the catalog's request sends. Left out: the flow's own .busy/, the build's dist/, node_modules/, and the
// files the system makes beside others (.DS_Store, ._*, Thumbs.db, desktop.ini), which change on their own.
//
// Each file is hashed whole (SHA-256 of its bytes, with its path and size): a normal project is a few hundred
// kilobytes, read in milliseconds, and no clock or copy can make a changed file look the same. A link is hashed by
// where it points, never followed. The record keeps the hash of every file (up to MAX_LISTED of them), so that the
// window names what changed and the push can compare the very bytes it uploads with the ones the check saw.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

import { projectTree } from "./tree.mjs";

/** The flow's own folders, the build's and the dependencies': never part of what was checked. */
const NOT_SOURCE = /^(?:\.busy|submission|dist|node_modules)(?:\/|$)/;
/** What the system puts beside files by itself. */
const SYSTEM_FILE = /(?:^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/i;
/** What installing the dependencies may write while the check builds: not a change of the person's. */
export const INSTALL_FILES = Object.freeze(["package-lock.json", "pnpm-lock.yaml"]);
/** The most files whose hashes the record keeps; past it only the whole hash is kept. */
export const MAX_LISTED = 5000;
/** How many changed files an answer names. */
const NAMED = 20;

/** The files the public repository would get, as `rel` paths, without the flow's own and the system's. */
export function sourceFiles(dir) {
  return projectTree(dir).published.filter((rel) => !NOT_SOURCE.test(rel) && !SYSTEM_FILE.test(rel));
}

/** The files of submission/, links not followed. */
function submissionFiles(dir) {
  const out = [];
  const walk = (folder, rel) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const at = `${rel}/${entry.name}`;
      if (SYSTEM_FILE.test(at)) continue;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), at);
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(at);
      if (out.length >= MAX_LISTED) return;
    }
  };
  walk(path.join(dir, "submission"), "submission");
  return out;
}

/** One file as the fingerprint takes it: "<size>:<sha256>", "link:<sha256 of its target>", or null when it is none. */
export function fileEntry(file) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  try {
    if (stat.isSymbolicLink()) return `link:${sha256(Buffer.from(readlinkSync(file)))}`;
    if (!stat.isFile()) return null;
    const bytes = readFileSync(file);
    return `${bytes.length}:${sha256(bytes)}`;
  } catch (e) {
    return `unreadable:${e?.code ?? "error"}`;
  }
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The fingerprint of the project in `dir`: { hash, count, files } with `files` { rel: entry } (null past MAX_LISTED
 * files). `scope`: "check" (the source) or "package" (the source and submission/).
 */
export function fingerprint(dir, { scope = "check" } = {}) {
  const rels = [...sourceFiles(dir), ...(scope === "package" ? submissionFiles(dir) : [])].sort();
  const whole = createHash("sha256");
  const files = {};
  let count = 0;
  for (const rel of rels) {
    const entry = fileEntry(path.join(dir, ...rel.split("/")));
    if (entry === null) continue;
    files[rel] = entry;
    whole.update(`${rel}\0${entry}\n`);
    count++;
  }
  return { hash: whole.digest("hex"), count, files: count <= MAX_LISTED ? files : null };
}

/** The paths that differ between two fingerprints' files (changed, added or removed), sorted; null when unknown. */
export function differences(a, b) {
  if (!a?.files || !b?.files) return null;
  const all = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  return [...all].filter((rel) => a.files[rel] !== b.files[rel]).sort();
}

/**
 * Whether the project is still what a step recorded (`recorded`, its fingerprint) against `now`: { stale, changed }.
 * A step recorded without one (an older emulator's record) is stale: nothing says what it saw. `changed` names up
 * to NAMED paths, `more` how many beyond them.
 */
export function compare(recorded, now) {
  if (!recorded || typeof recorded.hash !== "string") return { stale: true, changed: [], more: 0, unknown: true };
  if (recorded.hash === now.hash) return { stale: false, changed: [], more: 0 };
  const all = differences(recorded, now) ?? [];
  return { stale: true, changed: all.slice(0, NAMED), more: Math.max(0, all.length - NAMED) };
}

/**
 * What a check records of a run that built the project: the fingerprint taken after it (`after`), unless the files
 * changed while it ran in more than what installing the dependencies writes; then the one taken before (`before`),
 * so that the next look finds the step stale and the check runs again.
 */
export function settled(before, after) {
  const moved = differences(before, after);
  if (moved === null) return before.hash === after.hash ? after : before;
  return moved.every((rel) => INSTALL_FILES.includes(rel) || (rel === "catalog.json" && !before.files[rel])) ? after : before;
}

/**
 * A step's fingerprint renewed after the flow's own write of `rels` (the manifest stage 2 fills in, What's new of an
 * update): the one of now when nothing but those paths changed since `recorded`; else null, and the step stays stale.
 */
export function renewed(recorded, now, rels) {
  const moved = differences(recorded, now);
  if (moved === null) return null;
  return moved.every((rel) => rels.includes(rel)) ? now : null;
}

// The changed files in a few words, as the window says them (one rule for both: publish-steps.mjs imports nothing).
export { changedWords } from "../legacy-window/publish-steps.mjs";
