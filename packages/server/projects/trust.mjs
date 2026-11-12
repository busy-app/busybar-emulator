// Which project folders may be built (ADR-0012 §4, the first cut without the operations layer). Building a project, and
// installing its dependencies, runs code from its folder: its node_modules, its .npmrc (which can name the git or the
// shell npm runs), its build configuration. A project the emulator created itself is trusted; any other folder only
// after the person said so, and that is remembered for the folder. The person says so in one way: their click in the
// app's dialog, which `busy-emulator trust <folder>` asks for through the running server (TRUST_PATH; server.mjs
// writes the entry then, cli/commands/trust.mjs only asks). Nothing on the command line trusts a folder: --trust "from
// a terminal" was consent any program could give itself with a pseudo-terminal, and is gone (cli/project.mjs).
//
// The folder, not its path: an entry holds the real path and the folder's number on its file system (device and inode
// of statSync with bigint; on Windows the volume's serial number and the file index). A folder deleted or renamed away,
// and another one put at its path (a second clone of the same repository, a stranger's project under the tutorial's
// name), has another number and is not trusted (EMU-206 security review, M1). The real path is taken by the system
// (realpathSync.native): the letter case of the name on disk on macOS, the long names instead of 8.3 ones on Windows.
//
// The list lies in the data folder, <data>/projects/trusted.json:
// { "version": 2, "projects": [{ "path", "dev", "ino", "how", "at" }] } ("how": "created" or "trusted"). An entry
// without the folder's number (version 1 of the list) trusts nothing. The open projects of the operations layer
// (EMU-040) take the list over.
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { readJsonFile, updateJsonFile } from "../json-store.mjs";
import { samePath } from "../same-path.mjs";

export const TRUST_FILE = ["projects", "trusted.json"];
/** Where a program with the server's key asks the running emulator to ask the person (server.mjs, cli/commands/trust.mjs). */
export const TRUST_PATH = "/_emu/trust";

export function trustFile(dataDir) {
  return path.join(dataDir, ...TRUST_FILE);
}

/** The folder as the list holds it: its real path, and its number on the file system as strings. */
export function folderIdentity(dir) {
  const real = realpathSync.native(dir);
  const stat = statSync(real, { bigint: true });
  return { path: real, dev: String(stat.dev), ino: String(stat.ino) };
}

// Paths: on Windows letter case does not tell them apart (same-path.mjs); the folder's number decides the rest.

const LIST = { fallback: () => ({ version: 2, projects: [] }), check: (list) => Array.isArray(list?.projects) };
const entriesOf = (list) => list.projects.filter((entry) => typeof entry?.path === "string");

/**
 * The list; a missing, unreadable or broken one is an empty list (nothing is trusted by mistake). A broken one is
 * left as it is here: the next change sets it aside (json-store.mjs) instead of writing over it.
 */
export function readTrusted(dataDir) {
  try {
    return entriesOf(readJsonFile(trustFile(dataDir), LIST).value);
  } catch {
    return [];
  }
}

const matches = (entry, folder, platform) => samePath(entry.path, folder.path, platform) && entry.dev === folder.dev && entry.ino === folder.ino;

export function isTrusted(dataDir, dir, platform = process.platform) {
  const folder = folderIdentity(dir);
  return readTrusted(dataDir).some((entry) => matches(entry, folder, platform));
}

/**
 * The place a folder was trusted at before it was moved or renamed: the entry of the list that holds this folder's
 * number under another path. Null when there is none (the folder was never trusted, or was copied: a copy is another
 * folder). It trusts nothing; it is what the refusal says, so that the person knows why their own project is refused.
 */
export function trustedElsewhere(dataDir, dir, platform = process.platform) {
  const folder = folderIdentity(dir);
  const entry = readTrusted(dataDir).find((one) => one.dev === folder.dev && one.ino === folder.ino && !samePath(one.path, folder.path, platform));
  return entry ? { path: entry.path, how: entry.how ?? null } : null;
}

/**
 * Adds the folder to the list (once). `how`: "created" by the emulator, or "trusted" by the person's word. An entry
 * of the same path for another folder (the one that was there before) is replaced.
 */
export function trustProject(dataDir, dir, how, { platform = process.platform, now = Date.now() } = {}) {
  const folder = folderIdentity(dir);
  if (readTrusted(dataDir).some((entry) => matches(entry, folder, platform))) return false;
  // Read again under the lock, and merged: another process may have added a folder since (audit C4).
  let added = false;
  updateJsonFile(
    trustFile(dataDir),
    (list) => {
      const entries = entriesOf(list);
      if (entries.some((entry) => matches(entry, folder, platform))) return undefined;
      added = true;
      return { version: 2, projects: [...entries.filter((entry) => !samePath(entry.path, folder.path, platform)), { ...folder, how, at: new Date(now).toISOString() }] };
    },
    LIST,
  );
  return added;
}

/** The longest path the question shows. */
export const TRUST_PATH_MAX = 1024;

/**
 * Why a path cannot be shown to the person as it is, or null when it can. The dialog shows the folder's name as the
 * person will read it, so a name may hold nothing they cannot see and nothing that writes the dialog's text:
 * - control characters and the line and paragraph separators (a name with line feeds adds lines to the dialog);
 * - format characters, Unicode's category Cf: the marks that turn the direction of text (U+202E, U+2066, U+061C; a
 *   name then reads as another), zero-width spaces and joiners (U+200B, U+200D, U+2060, U+FEFF), the soft hyphen, the
 *   interlinear annotation marks (U+FFF9) and the tag characters (U+E0041): all invisible;
 * - more than one space in a row, of any kind: a run of spaces pushes a sentence of the name's own away from the
 *   name, where it reads as the dialog's ("…          Verified. Safe to trust.").
 */
export function unshowable(folderPath) {
  if (folderPath.length > TRUST_PATH_MAX) return `it is longer than ${TRUST_PATH_MAX} characters`;
  const hidden = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.exec(folderPath);
  if (hidden) {
    const code = hidden[0].codePointAt(0);
    const kind = /\p{Cf}/u.test(hidden[0]) ? "an invisible format character" : "a control character";
    return `it holds ${kind} (U+${code.toString(16).toUpperCase().padStart(4, "0")}), which a person cannot see in the question`;
  }
  if (/[\p{Zs}\t]{2,}/u.test(folderPath)) return "it holds more than one space in a row, which can push text of the name's own away from the name";
  return null;
}
