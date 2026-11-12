// Which app is which project folder (EMU-260): the emulator's list of the app projects it has worked with, so that the
// window can say where the project of an app on the bar lies, and offer to build it. The project commands write it
// (create, build, install, run, dev, stop; the window's actions run the same commands); `busy-emulator projects`
// reads it.
//
// The list lies in the data folder beside the trusted folders, <data>/projects/registry.json:
// { "version": 1, "projects": [{ "path", "volume", "id", "name", "at", "installed"?, "deps"? }] }: the folder's real path, the
// place its disk is mounted at, the app's id and name from its manifest when the folder was last seen, and when that
// was. One entry for a folder; the same id may be in two folders (a copy), and the one seen last comes first.
// "installed": { "id", "mark", "at"? } is there once a command put this project's build on the emulated bar (install,
// run, dev): the app's id, a mark of what the bar held right after (the command line makes it from the app's files on
// the bar) and when (an ISO time). The mark is what says that an app on the bar is this project's, and not one that
// merely has the same id; the time says whether the project's files changed since (`busy-emulator projects`: stale).
//
// The list gives no rights. Whether a folder may be built is the trusted list's to say (trust.mjs); an entry here says
// only that a project command ran there. An app installed on the bar from an archive has no entry: it has no project.
//
// A folder that is gone is one of two things, and the list tells them apart by the folder's disk (`volume`). The disk
// is there and the folder is not: the project was deleted or moved away, and its app goes with it (`busy-emulator
// projects --prune`: the entry is taken out, and the app is removed from the emulated bar when it is still the one
// this project installed; an app of the same id that came from elsewhere, an archive say, stays). The disk itself is not there
// (an external disk unplugged, a network share offline): the project is unavailable, not deleted; the entry and the
// app on the bar stay, and everything works again when the disk is back. Nothing inside a project folder is ever
// deleted from here.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { readJsonFile, updateJsonFile } from "../json-store.mjs";
import { samePath } from "../same-path.mjs";
import { isTrusted } from "./trust.mjs";

export const REGISTRY_FILE = ["projects", "registry.json"];
/** More than anybody works with; the oldest entries go first. */
const MAX_PROJECTS = 200;

export function registryFile(dataDir) {
  return path.join(dataDir, ...REGISTRY_FILE);
}

const LIST = { fallback: () => ({ version: 1, projects: [] }), check: (list) => Array.isArray(list?.projects) };

/**
 * The list, latest first; a missing, unreadable or broken one is an empty list. A broken one is left as it is here:
 * the next change sets it aside (json-store.mjs) instead of writing over it.
 */
export function readProjects(dataDir) {
  try {
    return entriesOf(readJsonFile(registryFile(dataDir), LIST).value);
  } catch {
    return [];
  }
}

// ---- the project's dependencies (create-offline)
//
// "deps" is there while the emulator's npm installs the project's dependencies, and after it failed: { state:
// "installing", pid, at } or { state: "failed", code, message, at }. It goes when an install ends well. So a list read
// later (the window opened again, another command) can tell a project whose install failed or was cut off (the app
// quit, the computer slept) from one that has its dependencies, and node_modules that npm left half-written is
// installed again: busy-cli may be in it while the rest is not.

/** The note of an install, when it is a whole one. */
function depsNoteOf(deps) {
  if (deps?.state === "installing" && Number.isInteger(deps.pid) && typeof deps.at === "string") return { state: "installing", pid: deps.pid, at: deps.at };
  if (deps?.state === "failed" && typeof deps.code === "string" && typeof deps.at === "string") return { state: "failed", code: deps.code, message: typeof deps.message === "string" ? deps.message.slice(0, 2000) : "", at: deps.at };
  return null;
}

/** An install that runs longer than this was cut off, whatever its process id says now (create's watch stops npm sooner). */
const INSTALL_LONGEST_MS = 30 * 60 * 1000;

/** Whether the process `pid` is there (a process of another user answers EPERM: it is there). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/**
 * Notes how the install of the dependencies of the project in `dir` stands: `note` as above, or null when it ended
 * well. Only a project of the list is noted; a list that cannot be written changes nothing.
 */
export function noteDependencies(dataDir, dir, note, { platform = process.platform } = {}) {
  try {
    const real = realpathSync.native(dir);
    let found = false;
    change(dataDir, (list) => {
      const at = list.findIndex((one) => samePath(one.path, real, platform));
      if (at < 0) return undefined;
      found = true;
      const { deps: _before, ...rest } = list[at];
      const whole = depsNoteOf(note);
      list[at] = whole ? { ...rest, deps: whole } : rest;
      return list;
    });
    return found;
  } catch {
    return false;
  }
}

/**
 * How the project's dependencies stand: "installed" (busy-cli is there and no install is pending), "missing" (never
 * installed: a clone), "installing" (the emulator's npm works on it now), "failed" (the last install failed: `code`
 * and `message` say why) or "interrupted" (an install was cut off: node_modules may be half-written).
 * @returns {{ state: "installed"|"missing"|"installing"|"failed"|"interrupted", code?: string, message?: string, at?: string }}
 */
export function dependencyState(entry, { isAlive = alive, now = Date.now() } = {}) {
  const note = entry.deps ?? null;
  if (note?.state === "failed") return { state: "failed", code: note.code, message: note.message, at: note.at };
  if (note?.state === "installing") {
    const young = now - Date.parse(note.at) < INSTALL_LONGEST_MS;
    return young && isAlive(note.pid) ? { state: "installing", at: note.at } : { state: "interrupted", at: note.at };
  }
  return { state: existsSync(path.join(entry.path, "node_modules", "@busy-app", "cli", "package.json")) ? "installed" : "missing" };
}

function entriesOf(list) {
  return list.projects
    .filter((entry) => typeof entry?.path === "string" && path.isAbsolute(entry.path))
    .map((entry) => ({ ...(markOf(entry.installed) ? { installed: markOf(entry.installed) } : {}), ...(depsNoteOf(entry.deps) ? { deps: depsNoteOf(entry.deps) } : {}), path: entry.path, volume: typeof entry.volume === "string" && path.isAbsolute(entry.volume) ? entry.volume : path.parse(entry.path).root, id: typeof entry.id === "string" ? entry.id : null, name: typeof entry.name === "string" ? entry.name : null, at: typeof entry.at === "string" ? entry.at : null }));
}

/** The note of what a project installed on the bar, when it is a whole one. */
function markOf(installed) {
  if (typeof installed?.id !== "string" || typeof installed?.mark !== "string" || !installed.mark) return null;
  return { id: installed.id, mark: installed.mark, ...(typeof installed.at === "string" ? { at: installed.at } : {}) };
}

/**
 * Changes the list under its lock: `change(entries)` gets the list as it is on the disk now, read again under the lock
 * (another process may have changed it since: audit C4), and returns the new one, or undefined to leave it.
 */
function change(dataDir, fn) {
  updateJsonFile(
    registryFile(dataDir),
    (list) => {
      const next = fn(entriesOf(list));
      return next === undefined ? undefined : { version: 1, projects: next };
    },
    LIST,
  );
}

/** The app's id and name from the project's manifest, where the official template keeps it; nulls when it has none. */
export function appOf(dir) {
  for (const file of [path.join(dir, "src", "appmeta", "manifest.json"), path.join(dir, "appmeta", "manifest.json")]) {
    try {
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      return { id: typeof manifest?.id === "string" ? manifest.id : null, name: typeof manifest?.name === "string" ? manifest.name : null };
    } catch {
      // the next place
    }
  }
  return { id: null, name: null };
}

const deviceOf = (dir) => {
  try {
    return String(statSync(dir, { bigint: true }).dev);
  } catch {
    return null;
  }
};

/**
 * Where the disk of the folder `real` (a real path that exists) is mounted: the highest folder above it that is on the
 * same disk. On Windows: the root of its drive or of its share.
 */
export function volumeOf(real, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const root = p.parse(real).root;
  if (platform === "win32") return root;
  const device = deviceOf(real);
  let mount = real;
  // The walk ends at the root, or wherever dirname goes no higher: a path the posix rules do not read as absolute (a
  // Windows path such as C:\x, a relative one) climbs to ".", whose dirname is "." again, and never meets the root "".
  for (let parent = p.dirname(mount); mount !== root && parent !== mount && device !== null && deviceOf(parent) === device; parent = p.dirname(mount)) mount = parent;
  return device === null ? root : mount;
}

/**
 * Whether the disk mounted at `volume` (volumeOf) is there now. The root of the file system always is; any other
 * place is there when it exists and is the root of a disk of its own: a folder left behind where a disk was mounted
 * is on its parent's disk.
 */
export function volumePresent(volume, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!existsSync(volume)) return false;
  if (platform === "win32" || volume === p.parse(volume).root) return true;
  const device = deviceOf(volume);
  return device !== null && device !== deviceOf(p.dirname(volume));
}

/**
 * Puts the project folder `dir` at the head of the list, with the app its manifest names now. The folder goes in by
 * its real path. Returns the entry.
 */
export function rememberProject(dataDir, dir, { platform = process.platform, now = Date.now() } = {}) {
  const real = realpathSync.native(dir);
  const seen = { path: real, volume: volumeOf(real, platform), ...appOf(real), at: new Date(now).toISOString() };
  let entry = seen;
  change(dataDir, (list) => {
    const was = list.find((one) => samePath(one.path, real, platform));
    // What the project installed on the bar stays noted: seeing the folder again changes nothing on the bar.
    entry = { ...seen, ...(was?.installed ? { installed: was.installed } : {}), ...(was?.deps ? { deps: was.deps } : {}) };
    return [entry, ...list.filter((one) => one !== was)].slice(0, MAX_PROJECTS);
  });
  return entry;
}

/**
 * Notes that the project in `dir` has just put its app `id` on the bar, and the mark of what the bar holds now
 * (null: the bar would not say, so nothing on the bar counts as this project's). The project is noted too.
 */
export function noteInstalled(dataDir, dir, id, mark, options = {}) {
  const entry = rememberProject(dataDir, dir, options);
  const installed = markOf({ id, mark, at: new Date(options.now ?? Date.now()).toISOString() });
  const { installed: _before, ...rest } = entry;
  const next = installed ? { ...rest, installed } : rest;
  change(dataDir, (list) => list.map((one) => (one.path === entry.path ? next : one)));
  return next;
}

/** Takes the folder out of the list, by the path it is listed under (the folder itself may be gone). True when it was there. */
export function forgetProject(dataDir, folder, { platform = process.platform } = {}) {
  let gone = false;
  change(dataDir, (list) => {
    const rest = list.filter((one) => !samePath(one.path, folder, platform));
    gone = rest.length !== list.length;
    return gone ? rest : undefined;
  });
  return gone;
}

function isFolder(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The list as the window and `busy-emulator projects` show it: for every entry whether the folder is still there,
 * whether it is trusted, and whether it holds a built package of its app. A folder that is gone is `unavailable` when
 * its disk is not there either (it comes back with the disk), and deleted otherwise. The app's id and name are read
 * from the folder when it is there (the author may have renamed the app), otherwise they are the ones last seen.
 * `present(volume)` stands in for the look at the disk in a test.
 * `put` is the note of what the project installed on the bar ({ id, mark, at? }), or null: it never did.
 * `dependencies` is dependencyState() of a folder that is there, otherwise null.
 * @returns {{ id: string|null, name: string, folder: string, exists: boolean, unavailable: boolean, trusted: boolean, built: boolean, dependencies: object|null, seen: string|null, put: object|null }[]}
 */
export function listProjects(dataDir, { platform = process.platform, present = (volume) => volumePresent(volume, platform) } = {}) {
  return readProjects(dataDir).map((entry) => {
    const exists = isFolder(entry.path);
    const app = exists ? appOf(entry.path) : { id: null, name: null };
    const id = app.id ?? entry.id;
    let trusted = false;
    if (exists) {
      try {
        trusted = isTrusted(dataDir, entry.path, platform);
      } catch {
        // A folder that cannot be read is not trusted.
      }
    }
    return {
      id,
      name: app.name ?? entry.name ?? path.basename(entry.path),
      folder: entry.path,
      exists,
      unavailable: !exists && !present(entry.volume),
      trusted,
      built: exists && id !== null && existsSync(path.join(entry.path, "dist", `${id}.tgz`)),
      dependencies: exists ? dependencyState(entry) : null,
      seen: entry.at,
      put: entry.installed ?? null,
    };
  });
}
