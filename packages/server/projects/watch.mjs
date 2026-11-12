// Watching a project's source files for the development loop (busy-emulator dev): which files changed since the last
// look, told once the saving has been quiet for a moment, and a runner that never does two rounds at once.
//
// The system's notifications (fs.watch, recursive: FSEvents on macOS, ReadDirectoryChangesW on Windows) only say
// "look now". What changed is found by looking: the files' sizes, times and contents against the last look. So a
// notification about nothing (macOS tells of what happened shortly before the watch began; Windows tells twice; a tool
// rewrites a file with the same bytes) starts nothing, a save through a temporary file and a rename is seen as the
// change of the file it ends in, and a notification without a name is as good as one with it.
//
// Not watched: what the build and the tools write, and what is not source — dist/, screenshots/ and media/ (the clips
// of record) at the top, node_modules/ anywhere, every name that starts with "." (.git, .busy, .DS_Store, the "._"
// files of macOS, an editor's swap file) and every name that ends with "~" (an editor's backup). Links are not
// followed.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, watch as watchFolder } from "node:fs";
import path from "node:path";

/** How long the saving must be quiet before a round starts, and the longest a round waits for the quiet. */
export const DEBOUNCE_MS = 150;
export const LONGEST_WAIT_MS = 2000;

/** A file larger than this is compared by size and time only. */
const HASH_LIMIT = 8 * 1024 * 1024;

/** How many times a file that cannot be read is looked at again. */
const UNREAD_RETRIES = 20;

const TOP_FOLDERS = new Set(["dist", "screenshots", "media"]);
const ANY_FOLDERS = new Set(["node_modules"]);

/** Whether a path inside the project (relative, with either slash) is not watched. */
export function ignored(relative) {
  const parts = String(relative).split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  if (TOP_FOLDERS.has(parts[0].toLowerCase())) return true;
  return parts.some((part) => part.startsWith(".") || part.endsWith("~") || ANY_FOLDERS.has(part.toLowerCase()));
}

/** The content's hash; null for a file too large to read each time; undefined when it cannot be read now. */
function contentOf(file, size) {
  if (size > HASH_LIMIT) return null;
  try {
    return createHash("sha1").update(readFileSync(file)).digest("base64");
  } catch {
    return undefined; // being written by a program that shares it with nobody (Windows), or gone again
  }
}

/**
 * The watched files of a project as they are now: relative path (with "/") → { size, mtimeMs, hash }. A file whose
 * size and time are as in `before` keeps its entry, unread. A file that changed and cannot be read at this moment is
 * left as it was in `before` and named in `unread`: whoever looks, looks again shortly.
 * @param {string} dir
 * @param {Map<string, { size: number, mtimeMs: number, hash: string|null }>|null} [before]
 * @param {string[]} [unread]
 */
export function look(dir, before = null, unread = []) {
  const files = new Map();
  const walk = (folder, prefix) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return; // removed meanwhile
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored(relative)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file, relative);
      else if (entry.isFile()) {
        let stat;
        try {
          stat = lstatSync(file);
        } catch {
          continue;
        }
        const old = before?.get(relative);
        if (old && old.size === stat.size && old.mtimeMs === stat.mtimeMs) {
          files.set(relative, old);
          continue;
        }
        const hash = contentOf(file, stat.size);
        if (hash !== undefined) files.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, hash });
        else {
          unread.push(relative);
          if (old) files.set(relative, old);
        }
      }
    }
  };
  walk(dir, "");
  return files;
}

/**
 * The time (ms) the newest watched file of the project was last written, or 0 when it has none: a quick look, by the
 * files' times only, with the watcher's rules of what is not source. Also left out here: what the publishing flow
 * writes beside the app (submission/) and the lock files installing the dependencies may rewrite.
 * @param {string} dir
 */
export function newestChange(dir) {
  let newest = 0;
  const walk = (folder, prefix) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignored(relative) || NOT_BUILT.test(relative)) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file, relative);
      else if (entry.isFile()) {
        try {
          newest = Math.max(newest, lstatSync(file).mtimeMs);
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(dir, "");
  return newest;
}
const NOT_BUILT = /^(?:submission(?:\/|$)|package-lock\.json$|pnpm-lock\.yaml$)/i;

/** The files that differ between two looks: new, gone, or with other bytes. Sorted. */
export function changedBetween(before, after) {
  const changed = [];
  for (const [name, now] of after) {
    const old = before.get(name);
    if (!old) changed.push(name);
    else if (old !== now && !(old.hash !== null && old.hash === now.hash && old.size === now.size)) changed.push(name);
  }
  for (const name of before.keys()) if (!after.has(name)) changed.push(name);
  return changed.sort();
}

/**
 * Watches the project in `dir`. `onChange(files)` is called with the files that changed (relative, "/"), once nothing
 * was saved for `debounceMs`: a hundred saves in a row are one call. `onError(e)`: the system stopped watching (the
 * folder is gone).
 * @returns {{ close(): void }}
 */
export function watchProject(dir, { onChange, onError = () => {}, debounceMs = DEBOUNCE_MS, longestWaitMs = LONGEST_WAIT_MS, watch = watchFolder }) {
  let files = look(dir);
  let timer = null;
  let waitingSince = 0;
  let closed = false;
  let retries = 0;
  const settle = () => {
    timer = null;
    waitingSince = 0;
    if (closed) return;
    const unread = [];
    const now = look(dir, files, unread);
    const changed = changedBetween(files, now);
    files = now;
    // A file that could not be read is looked at again in a moment, a few times: its change is told then.
    if (unread.length && retries < UNREAD_RETRIES) {
      retries += 1;
      timer = setTimeout(settle, debounceMs);
    } else retries = 0;
    if (changed.length) onChange(changed);
  };
  const told = (_kind, name) => {
    if (closed || (name != null && ignored(name))) return;
    const at = Date.now();
    if (timer) clearTimeout(timer);
    if (!waitingSince) waitingSince = at;
    // Something that never stops writing (a log inside the project) must not put the round off for ever.
    timer = setTimeout(settle, Math.max(0, Math.min(debounceMs, waitingSince + longestWaitMs - at)));
  };
  const watcher = watch(dir, { recursive: true }, told);
  watcher.on("error", (e) => {
    if (!closed) onError(e);
  });
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher.close();
    },
  };
}

/**
 * Runs `round(files)` for what `push(files)` brings, never two at once: what comes while a round runs is kept as one
 * more round, which starts when the running one has ended, with all the files that came meanwhile.
 * @param {(files: string[]) => Promise<void>} round  must not reject
 * @returns {{ push(files: string[]): void, idle(): Promise<void>, close(): void }}
 */
export function oneAtATime(round) {
  let running = null;
  let waiting = null;
  let closed = false;
  const start = (files) => {
    running = Promise.resolve()
      .then(() => round(files))
      .catch(() => {})
      .then(() => {
        running = null;
        if (waiting && !closed) {
          const next = waiting;
          waiting = null;
          start(next);
        }
      });
  };
  return {
    push(files) {
      if (closed) return;
      if (running) waiting = [...new Set([...(waiting ?? []), ...files])].sort();
      else start(files);
    },
    /** Resolves when no round runs and none waits. */
    async idle() {
      while (running) await running;
    },
    /** No round starts any more; the running one goes on to its end. */
    close() {
      closed = true;
      waiting = null;
    },
  };
}
