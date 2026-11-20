// What a project's own git repository says, read from its .git folder without git (catalog-update): the commit it is
// at, whether it holds a commit, and its remote. Publish into an existing repository uses it to see whether GitHub has
// commits the project does not; the remote names the repository Publish to GitHub offers (EMU-358). Nothing is
// written; anything unexpected is "not known" (null, false).
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{40}$/;
/** The most a small file of git's is read: .git of a worktree, commondir, HEAD, a ref. */
const SMALL = 4096;
const MAX_PACKED_REFS = 8 * 1024 * 1024;

/**
 * A regular file, opened without waiting: { fd, size }, or null for anything else (a FIFO, a device, a folder), which
 * the project may put anywhere under .git. O_NONBLOCK keeps a FIFO's open from hanging the app's main process; the
 * descriptor's own fstat says what was opened, so a file swapped for another between a stat and the read is not read.
 */
function openRegular(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile()) return { fd, size: stat.size };
  } catch {
    // Not known.
  }
  closeSync(fd);
  return null;
}

/** `length` bytes of an open file from `at`, or null when it has fewer. */
function readAt(fd, at, length) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, bytes, done, length - done, at + done);
    if (!n) return null;
    done += n;
  }
  return bytes;
}

/** The text of a regular file of at most `max` bytes, else null. */
function readText(file, max = SMALL) {
  const open = openRegular(file);
  if (!open) return null;
  try {
    return open.size > max ? null : (readAt(open.fd, 0, open.size)?.toString("utf8") ?? null);
  } catch {
    return null;
  } finally {
    closeSync(open.fd);
  }
}

/** The .git folder of a project folder (a folder, or a file "gitdir: <path>" of a worktree), or null. */
function gitDir(folder) {
  const dot = path.join(folder, ".git");
  let stat;
  try {
    // A stat never waits, even for a FIFO; only a regular file is read (readText).
    stat = statSync(dot);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dot;
  const m = /^gitdir:\s*(.+)$/m.exec(readText(dot) ?? "");
  return m ? path.resolve(folder, m[1].trim()) : null;
}

/** The folder of the repository's own files (config, refs, objects): a worktree names it in its file commondir. */
function commonDir(dir) {
  const named = readText(path.join(dir, "commondir"))?.trim();
  return named ? path.resolve(dir, named) : dir;
}

/** The commit the project's git is at: its HEAD, followed through a branch (loose or packed), or null. */
export function localHead(folder) {
  const dir = gitDir(folder);
  if (!dir) return null;
  const head = readText(path.join(dir, "HEAD"))?.trim();
  if (!head) return null;
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(refs\/[^\s]+)$/.exec(head)?.[1];
  if (!ref || ref.split("/").includes("..")) return null;
  // A worktree's branches are the repository's: in its common folder.
  for (const at of new Set([dir, commonDir(dir)])) {
    const loose = path.join(at, ...ref.split("/"));
    if (existsSync(loose)) {
      const sha = readText(loose)?.trim();
      return sha && SHA.test(sha) ? sha : null;
    }
  }
  for (const line of (readText(path.join(commonDir(dir), "packed-refs"), MAX_PACKED_REFS) ?? "").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && SHA.test(sha)) return sha;
  }
  return null;
}

/** Whether a pack's index (version 2) names the object `wanted` (20 bytes): read where the search looks, not whole. */
function indexHas(file, wanted) {
  const open = openRegular(file);
  if (!open) return false;
  try {
    // \377tOc, version 2, then 256 counts (the fan-out) and the sorted object names.
    const names = 8 + 1024;
    if (open.size < names) return false;
    const top = readAt(open.fd, 0, names);
    if (!top || top.readUInt32BE(0) !== 0xff744f63 || top.readUInt32BE(4) !== 2) return false;
    const first = wanted[0];
    let lo = first === 0 ? 0 : top.readUInt32BE(8 + (first - 1) * 4);
    let hi = top.readUInt32BE(8 + first * 4);
    if (lo > hi || names + hi * 20 > open.size) return false;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const name = readAt(open.fd, names + mid * 20, 20);
      if (!name) return false;
      const order = Buffer.compare(name, wanted);
      if (order === 0) return true;
      if (order < 0) lo = mid + 1;
      else hi = mid;
    }
  } catch {
    // Not known.
  } finally {
    closeSync(open.fd);
  }
  return false;
}

/** Whether the project's git holds the object `sha`: a loose object, or one in a pack's index (version 2). */
export function localHas(folder, sha) {
  const dir = gitDir(folder);
  if (!dir || !SHA.test(sha)) return false;
  const objects = path.join(commonDir(dir), "objects");
  if (existsSync(path.join(objects, sha.slice(0, 2), sha.slice(2)))) return true;
  let packs = [];
  try {
    packs = readdirSync(path.join(objects, "pack")).filter((one) => one.endsWith(".idx"));
  } catch {
    return false;
  }
  const wanted = Buffer.from(sha, "hex");
  return packs.some((one) => indexHas(path.join(objects, "pack", one), wanted));
}

// ---------------------------------------------------------------- the remote (EMU-358)

const MAX_CONFIG = 1024 * 1024;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);

/** A value of a git config line: quoted (with git's escapes), or up to a comment (# or ;). */
function configValue(raw) {
  let out = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') quoted = !quoted;
    else if (c === "\\" && i + 1 < raw.length) out += { n: "\n", t: "\t", b: "\b" }[raw[++i]] ?? raw[i];
    else if (!quoted && (c === "#" || c === ";")) break;
    else out += c;
  }
  return out.trim();
}

/** The remotes of a git config's text, read as data: name → its first url. Includes are not followed. */
export function remotesOf(text) {
  const remotes = new Map();
  let current = null;
  for (const raw of String(text).split("\n")) {
    let line = raw.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      current = section[1].toLowerCase() === "remote" && section[2] !== undefined ? section[2].replace(/\\(.)/g, "$1") : null;
      line = line.slice(section[0].length).trim();
    }
    const url = /^url\s*=(.*)$/i.exec(line);
    if (current !== null && url && !remotes.has(current)) remotes.set(current, configValue(url[1]));
  }
  return remotes;
}

/**
 * Where a remote's address points: { host, github }. `github` is { owner, name } for a repository on github.com in
 * the forms git takes (https:// or http://, ssh://, git://, or the SSH form [user@]github.com:owner/name; with or
 * without ".git" and a trailing slash, any case), else null. `host` is the address's host in lower case (null for a
 * folder on this computer); `unreadable` for an address with "://" of a form this does not read. Nothing of a user name, password or token in the address is kept.
 */
export function remoteAddress(url) {
  const text = String(url ?? "").trim();
  let host = null;
  let where = null;
  const full = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/\s]*@)?(\[[^\]\s]*\]|[^/:\s]*)(?::\d*)?(\/[^?#\s]*)?$/i.exec(text);
  const scp = full ? null : /^(?:[^@/\s:]+@)?([^/:\s]{2,}):(?!\/\/)([^\s]*)$/.exec(text);
  if (full) {
    if (full[1].toLowerCase() !== "file") {
      host = full[2].toLowerCase();
      where = full[3] ?? "";
    }
  } else if (scp) {
    host = scp[1].toLowerCase();
    where = scp[2];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^file:/i.test(text)) {
    // An address of a form this does not read (a query, a "/" in a password): not a folder, and not said to be one.
    return { host: null, github: null, unreadable: true };
  }
  if (host !== null) host = host.replace(/\.$/, "");
  if (host !== null && !/^[a-z0-9.[\]:-]{1,253}$/.test(host)) host = "another host";
  let github = null;
  if (host !== null && GITHUB_HOSTS.has(host) && (!full || ["https", "http", "ssh", "git", "git+ssh", "ssh+git"].includes(full[1].toLowerCase()))) {
    const parts = where.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
    if (parts.length === 2 && LOGIN.test(parts[0]) && REPO.test(parts[1]) && !/^\.+$/.test(parts[1])) github = { owner: parts[0], name: parts[1] };
  }
  return { host, github };
}

/**
 * The project's own git remote, read from its .git as data (no git is started, nothing in the project runs): origin,
 * else its only remote. { remote, host, github } (remoteAddress), or null when the project's folder has no git of its
 * own, or no such remote. A git folder above the project's (a repository it is a part of) is not the project's.
 */
export function localRemote(folder) {
  const dir = gitDir(folder);
  if (!dir) return null;
  const text = readText(path.join(commonDir(dir), "config"), MAX_CONFIG);
  if (text === null) return null;
  const remotes = remotesOf(text);
  const remote = remotes.has("origin") ? "origin" : remotes.size === 1 ? [...remotes.keys()][0] : null;
  return remote === null ? null : { remote, ...remoteAddress(remotes.get(remote)) };
}

// ---------------------------------------------------------------- who git signs as (EMU-366)

/** A plain e-mail address, as a commit may name it: no spaces, no angle brackets, one @, at most 254 characters. */
export const EMAIL = /^[^\s<>@,;"]{1,64}@[^\s<>@,;"]{1,189}$/;

/** The [user] name and email of a git config's text, read as data: { name, email }, each null when it has none. */
export function userOf(text) {
  const out = { name: null, email: null };
  let current = false;
  for (const raw of String(text).split("\n")) {
    let line = raw.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      current = section[1].toLowerCase() === "user" && section[2] === undefined;
      line = line.slice(section[0].length).trim();
    }
    const pair = /^(name|email)\s*=(.*)$/i.exec(line);
    // git takes the last value of a key.
    if (current && pair) out[pair[1].toLowerCase()] = configValue(pair[2]) || null;
  }
  if (out.email !== null && !EMAIL.test(out.email)) out.email = null;
  if (out.name !== null && (out.name.length > 200 || /[<>\n]/.test(out.name))) out.name = null;
  return out;
}

/**
 * The address `git config user.email` answers in the project's folder, read as data (no git is started): the
 * project's own .git/config, else the person's ~/.gitconfig, else $XDG_CONFIG_HOME/git/config; and the name of the
 * same file, so that a name never comes from one file and the address from another (a project's own .git/config may
 * be someone else's). Includes are not followed. { name, email }: both null when no file gives an address.
 */
export function localUser(folder, { home = null, xdg = null } = {}) {
  const read = (file) => (file ? userOf(readText(file, MAX_CONFIG) ?? "") : { name: null, email: null });
  const dir = folder ? gitDir(folder) : null;
  const layers = [dir ? read(path.join(commonDir(dir), "config")) : { name: null, email: null }, read(home ? path.join(home, ".gitconfig") : null), read(xdg ? path.join(xdg, "git", "config") : home ? path.join(home, ".config", "git", "config") : null)];
  const layer = layers.find((one) => one.email);
  return layer ? { name: layer.name, email: layer.email } : { name: null, email: null };
}
