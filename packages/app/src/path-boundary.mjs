// Where the emulator may write, delete or show something on behalf of a page, an app on the bar or an agent: the one
// answer to "is this path inside the folders it may touch?" (ADR-0012 §6, EMU-010).
//
// A path is taken by its real path, links followed, before it is compared: a folder inside the data folder or a
// project that is a link to somewhere else (a symbolic link, a junction on Windows) leads out, and is refused. A path
// with a "." or ".." part is refused before anything is looked at: the system resolves "link/.." from where the link
// leads, so a path that only looks inside once ".." is taken away lexically is not. A path that is not there yet (a
// file about to be written, a folder about to be made) is answered for the nearest folder above it that is there,
// with the rest of the path after it; on Windows the rest may not end a name in a dot or a space (the system drops
// them, so "a." is "a") and may not hold a colon (an alternate data stream). A link that leads nowhere is refused.
//
// Two copies, byte for byte, each with a copy of same-path.mjs beside it: packages/server/path-boundary.mjs, for the
// server and the command line, and packages/app/src/path-boundary.mjs, for the desktop app's main process. The app's
// archive does not carry the server's files, and the bundled Node that runs the server cannot read the archive. A test
// keeps them the same (packages/app/test/unit/path-boundary.test.mjs).
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { samePath } from "./same-path.mjs";

const flavour = (platform) => (platform === "win32" ? path.win32 : path.posix);
const fold = (text, platform) => (platform === "win32" ? text.toLowerCase() : text);

// Two paths are one, letter case aside on Windows: the one rule of same-path.mjs (lexical: give real paths).
export { samePath };

/** `inner` is `outer` or inside it. Lexical, letter case aside on Windows: give real paths. */
export function within(inner, outer, platform = process.platform) {
  const p = flavour(platform);
  const relative = p.relative(fold(outer, platform), fold(inner, platform));
  // "..foo" is a child named so, not a way up: only ".." itself or ".." and a separator leads out.
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

/** The real path of something that is there (links followed, on Windows the long names in the disk's letter case), else null. */
export function realOrNull(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return null;
  }
}

/** Whether something stands at `file`, a link not followed. */
function standsAt(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The parts of an absolute path after its root, or null when one of them is "." or "..". */
function partsOf(target, platform) {
  const p = flavour(platform);
  const root = p.parse(target).root;
  const parts = target.slice(root.length).split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean);
  return parts.some((part) => part === "." || part === "..") ? null : { root, parts };
}

/**
 * The real path `target` stands for, or would stand for once made: the real path of the nearest part that is there,
 * with the parts after it. Null for a path that is not absolute, has a "." or ".." part, a NUL, a link that leads
 * nowhere on the way, or (on Windows) a part not yet there that the system would read as another name.
 */
export function resolvedPath(target, { platform = process.platform, real = realOrNull, exists = standsAt } = {}) {
  const p = flavour(platform);
  if (typeof target !== "string" || !target || target.includes("\0") || !p.isAbsolute(target)) return null;
  const split = partsOf(target, platform);
  if (!split) return null;
  const { root, parts } = split;
  for (let there = parts.length; there >= 0; there--) {
    const at = p.join(root, ...parts.slice(0, there));
    if (there > 0 && !exists(at)) continue;
    const base = real(at);
    if (base === null) return null; // a link that leads nowhere, or a part the system will not resolve
    const rest = parts.slice(there);
    if (platform === "win32" && rest.some((part) => /[.\s]$/.test(part) || part.includes(":"))) return null;
    return rest.length ? p.join(base, ...rest) : base;
  }
  return null;
}

/**
 * The real path of `target` when it is one of `roots` or inside one of them, links followed; else null.
 * @param {string} target
 * @param {string[]} roots  the folders that may be touched; each is taken by its real path too (one that is not there
 *   yet by the real path of the nearest folder above it)
 * @param {object} [o]
 * @param {boolean} [o.missing]    a target that is not there yet is answered for where it would be made (false: it must be there)
 * @param {boolean} [o.rootItself] the root itself counts (false: only what is inside one)
 * @param {string} [o.platform]
 * @returns {string | null}
 */
export function insideRoots(target, roots, { missing = false, rootItself = true, platform = process.platform, real = realOrNull, exists = standsAt } = {}) {
  const resolved = resolvedPath(target, { platform, real, exists });
  if (resolved === null || (!missing && real(resolved) === null)) return null;
  for (const root of roots) {
    const base = typeof root === "string" ? resolvedPath(root, { platform, real, exists }) : null;
    if (base === null || !within(resolved, base, platform)) continue;
    if (!rootItself && samePath(resolved, base, platform)) continue;
    return resolved;
  }
  return null;
}

/**
 * The real path of `relative` inside `folder`, links followed; else null. For a path that a file of a project or a
 * request names (catalog.json's screenshots, an address of the local web or of the window's pages): forward slashes,
 * relative to the folder. Refused before anything is looked at: an empty path, an absolute one, one with a drive, a
 * backslash or a NUL, and one with an empty, "." or ".." part. The folder itself is never the answer.
 * @param {string} folder
 * @param {string} relative
 * @param {object} [o]
 * @param {boolean} [o.missing]  a path that is not there yet is answered for where it would be made
 * @param {string} [o.platform]
 * @returns {string | null}
 */
export function insideFolder(folder, relative, { missing = false, platform = process.platform, real, exists } = {}) {
  if (typeof folder !== "string" || typeof relative !== "string" || !relative || relative.length > 4096) return null;
  if (/[\\\0]/.test(relative) || relative.startsWith("/") || /^[A-Za-z]:/.test(relative)) return null;
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return insideRoots(flavour(platform).join(folder, ...parts), [folder], { missing, rootItself: false, platform, real, exists });
}

/**
 * The folder Delete may move to the Trash (the window's Delete in the Apps list, `busy-emulator uninstall
 * --delete-files`): a project folder of the emulator's list, by its real path, which must be the one the list names (a
 * project folder replaced by a link to another place is refused); never the root of a disk, the home folder or a
 * folder above it, the data folder, inside it or above it. A folder is moved to the Trash, never deleted.
 * @param {string} folder  the project's folder, as the list names it
 * @param {object} o
 * @param {string[]} o.registered  the folders of the emulator's list
 * @param {string} o.dataDir
 * @param {string | null} o.home
 * @param {string} [o.platform]
 * @returns {{ folder: string } | { refused: { code: string, message: string } }}
 */
export function trashableFolder(folder, { registered, dataDir, home, platform = process.platform }) {
  const no = (message) => ({ refused: { code: "not_deletable", message } });
  const p = flavour(platform);
  if (typeof folder !== "string" || !p.isAbsolute(folder)) return no("That is not a project folder.");
  if (!registered.some((one) => samePath(one, folder, platform))) return no(`${folder} is not among the emulator's projects, so it is not deleted.`);
  let link;
  try {
    link = lstatSync(folder).isSymbolicLink();
  } catch {
    return no(`The folder ${folder} is not there.`);
  }
  const target = realOrNull(folder);
  if (link || target === null || !samePath(target, folder, platform)) return no(`${folder} is a link to another place now, so it is not deleted.`);
  try {
    if (!statSync(target).isDirectory()) return no(`${folder} is not a folder.`);
  } catch {
    return no(`The folder ${folder} is not there.`);
  }
  if (p.parse(target).root === target || p.dirname(target) === target) return no("The root of a disk is never deleted.");
  // By path, and by the file system's own number for the folder: a path can name the home folder another way
  // (through the data volume's firmlink on macOS, the disk's administrative share on Windows); its device and inode
  // cannot.
  const self = identityOf(target);
  const kept = home ? [home, realOrNull(home)].filter(Boolean) : [];
  for (const one of kept) {
    if (within(one, target, platform)) return no(`${folder} is your home folder or holds it, so it is not deleted.`);
  }
  if (self && kept.some((one) => foldersUpFrom(one, platform).some((above) => sameIdentity(self, identityOf(above))))) return no(`${folder} is your home folder or holds it, so it is not deleted.`);
  const data = dataDir ? [dataDir, realOrNull(dataDir)].filter(Boolean) : [];
  for (const one of data) {
    if (within(target, one, platform) || within(one, target, platform)) return no(`${folder} holds the emulator's data folder or is inside it, so it is not deleted.`);
  }
  if (self && data.some((one) => foldersUpFrom(one, platform).some((above) => sameIdentity(self, identityOf(above))))) return no(`${folder} holds the emulator's data folder or is inside it, so it is not deleted.`);
  return { folder: target };
}

/** The device and the file's number of what is at `file` (links followed), or null. Big integers: Windows' file numbers are 64-bit. */
function identityOf(file) {
  try {
    const stat = statSync(file, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}
const sameIdentity = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
/** `folder` and every folder above it, up to the root. */
function foldersUpFrom(folder, platform) {
  const p = flavour(platform);
  const out = [];
  for (let at = folder; ; at = p.dirname(at)) {
    out.push(at);
    if (p.dirname(at) === at) return out;
  }
}
