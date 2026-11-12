// What a folder's git repository says about it, read from the repository's own files: where its top is, which commit
// is checked out, where its remote is, whether this copy has seen that commit on the remote, and which files git
// keeps (its index: what `git add` put there). No git is started (the command line starts no program it does not
// carry), so what only git can tell is not told: whether what is added is committed too, and whether a commit that is
// not a remote branch's tip is on the remote all the same.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- the index

const MAX_INDEX = 64 * 1024 * 1024;

/**
 * The paths of git's index (versions 2 to 4, SHA-1 names), as git wrote them, relative to the repository's top; null
 * when there is no index or it is not one this reads whole: a split or sparse index, SHA-256 names, a damaged file.
 * A file added only as an intention (`git add -N`) is not counted: the next commit would not have it.
 */
export function readIndexPaths(file) {
  let bytes;
  try {
    if (statSync(file).size > MAX_INDEX) return null;
    bytes = readFileSync(file);
  } catch {
    return null;
  }
  if (bytes.length < 12 + 20 || bytes.toString("latin1", 0, 4) !== "DIRC") return null;
  const version = bytes.readUInt32BE(4);
  const count = bytes.readUInt32BE(8);
  if (version < 2 || version > 4) return null;
  const end = bytes.length - 20;
  const paths = [];
  let at = 12;
  let previous = Buffer.alloc(0);
  for (let i = 0; i < count; i++) {
    const start = at;
    if (at + 62 > end) return null;
    const flags = bytes.readUInt16BE(at + 60);
    at += 62;
    let intent = false;
    if (flags & 0x4000) {
      if (version < 3 || at + 2 > end) return null;
      intent = Boolean(bytes.readUInt16BE(at) & 0x2000);
      at += 2;
    }
    let name;
    if (version === 4) {
      // The path is the previous one without its last N bytes, then the bytes up to a NUL.
      let cut = 0;
      let byte;
      let first = true;
      do {
        if (at >= end) return null;
        byte = bytes[at++];
        cut = first ? byte & 127 : (cut + 1) * 128 + (byte & 127);
        first = false;
        if (cut > previous.length + 128) return null;
      } while (byte & 128);
      const stop = bytes.indexOf(0, at);
      if (stop < 0 || stop >= end || cut > previous.length) return null;
      name = Buffer.concat([previous.subarray(0, previous.length - cut), bytes.subarray(at, stop)]);
      at = stop + 1;
    } else {
      const stop = bytes.indexOf(0, at);
      if (stop < 0 || stop >= end) return null;
      name = bytes.subarray(at, stop);
      // The entry is padded with NULs to a multiple of eight bytes, one at least.
      at = start + Math.ceil((stop - start + 1) / 8) * 8;
    }
    if (!name.length) return null;
    previous = name;
    if (!intent) paths.push(name.toString("utf8"));
  }
  // What follows the entries: extensions (a name of four bytes, a size, the data) up to the checksum. A split index
  // ("link") keeps most entries in another file, a sparse one ("sdir") keeps folders for files: neither is read here.
  while (at < end) {
    if (at + 8 > end) return null;
    const name = bytes.toString("latin1", at, at + 4);
    const size = bytes.readUInt32BE(at + 4);
    if (name === "link" || name === "sdir") return null;
    at += 8 + size;
  }
  return at === end ? paths : null;
}

/** The index as the checks ask it: whether a path (from the repository's top) is there, and under which spelling. */
function indexOf(gitDir) {
  const paths = readIndexPaths(path.join(gitDir, "index"));
  if (!paths) return null;
  const exact = new Set(paths.map((name) => name.normalize("NFC")));
  let folded = null;
  return {
    size: exact.size,
    /** Whether git keeps the file at this path, spelled exactly so. */
    has: (name) => exact.has(name.normalize("NFC")),
    /** The path git keeps that differs from this one only in letter case, or null. */
    spelled(name) {
      folded ??= new Map([...exact].map((kept) => [kept.toLowerCase(), kept]));
      const kept = folded.get(name.normalize("NFC").toLowerCase());
      return kept && kept !== name.normalize("NFC") ? kept : null;
    },
  };
}

const SHA = /^[0-9a-f]{40}$/;

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** The folder with `.git` at or above `dir`, and where that repository's files are. */
function locate(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    const dot = path.join(at, ".git");
    let stat = null;
    try {
      stat = statSync(dot);
    } catch {
      // no .git here
    }
    if (stat?.isDirectory()) return { top: at, gitDir: dot };
    if (stat?.isFile()) {
      // A worktree or a submodule: ".git" is a file that names the folder.
      const named = /^gitdir:\s*(.+)$/m.exec(readText(dot) ?? "")?.[1]?.trim();
      if (named) return { top: at, gitDir: path.resolve(at, named) };
    }
    if (path.dirname(at) === at) return null;
  }
}

/** Refs of packed-refs: name → commit. */
function packedRefs(commonDir) {
  const refs = new Map();
  for (const line of (readText(path.join(commonDir, "packed-refs")) ?? "").split("\n")) {
    const m = /^([0-9a-f]{40,64}) (\S+)$/.exec(line);
    if (m) refs.set(m[2], m[1]);
  }
  return refs;
}

function looseRefs(folder, prefix, into) {
  let names;
  try {
    names = readdirNames(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(folder, name);
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue;
    }
    if (stat.isDirectory()) looseRefs(file, `${prefix}${name}/`, into);
    else {
      const value = (readText(file) ?? "").trim();
      if (/^[0-9a-f]{40,64}$/.test(value)) into.set(`${prefix}${name}`, value);
    }
  }
}

import { readdirSync } from "node:fs";
const readdirNames = (folder) => readdirSync(folder);

/** The remotes of a git config: name → url. */
function remotesOf(config) {
  const remotes = new Map();
  let current = null;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section) {
      current = section[1].toLowerCase() === "remote" && section[2] !== undefined ? section[2].replace(/\\(.)/g, "$1") : null;
      continue;
    }
    const url = /^url\s*=\s*(.*)$/i.exec(line);
    if (current !== null && url && !remotes.has(current)) remotes.set(current, url[1].trim().replace(/^"(.*)"$/, "$1"));
  }
  return remotes;
}

/**
 * A remote's address as a GitHub repository, or null. The forms git writes: https://github.com/<owner>/<repo>, with
 * or without ".git" and a user name before the host, and the two SSH forms (the user "git" at github.com, then
 * ":<owner>/<repo>" or, after "ssh://", "/<owner>/<repo>"). Nothing of a user name, password or token in the address
 * is kept.
 */
export function githubRepository(url) {
  const m =
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i.exec(url) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?\/?$/i.exec(url);
  if (!m) return null;
  return { owner: m[1], repo: m[2], https: `https://github.com/${m[1]}/${m[2]}.git`, page: `https://github.com/${m[1]}/${m[2]}` };
}

/** A remote's host for a message, without the user name, password or token an address may carry. */
export function remoteHost(url) {
  return /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)/i.exec(url)?.[1] ?? "another host";
}

/**
 * @returns {null | {
 *   top: string,                  the folder the repository starts at
 *   subdir: string,               `dir` inside it, with forward slashes; "" when `dir` is the top
 *   head: string|null,            the commit checked out (40 hex digits), or null when there is none yet
 *   branch: string|null,          the branch checked out, or null (a detached HEAD)
 *   remote: { name: string, host: string, github: object|null } | null,
 *   remotes: number,
 *   seenOnRemote: string|null,    the remote branch of this copy that points at `head` ("origin/main"), or null
 *   index: { size: number, has(path): boolean, spelled(path): string|null } | null,
 *                                 the files git keeps, by their paths from the top; null when that is not known
 * }}
 */
export function readGit(dir) {
  const found = locate(dir);
  if (!found) return null;
  const { top, gitDir } = found;
  const common = (() => {
    const named = readText(path.join(gitDir, "commondir"))?.trim();
    return named ? path.resolve(gitDir, named) : gitDir;
  })();
  const refs = packedRefs(common);
  looseRefs(path.join(common, "refs"), "refs/", refs);
  if (common !== gitDir) looseRefs(path.join(gitDir, "refs"), "refs/", refs);

  const headText = (readText(path.join(gitDir, "HEAD")) ?? "").trim();
  const symbolic = /^ref:\s*(\S+)$/.exec(headText)?.[1] ?? null;
  const commit = symbolic ? (refs.get(symbolic) ?? null) : headText;
  const head = commit && SHA.test(commit) ? commit : null;

  const remotes = existsSync(path.join(common, "config")) ? remotesOf(readText(path.join(common, "config")) ?? "") : new Map();
  const name = remotes.has("origin") ? "origin" : remotes.size === 1 ? [...remotes.keys()][0] : null;
  const url = name === null ? null : remotes.get(name);
  let seenOnRemote = null;
  if (head && name !== null) {
    const prefix = `refs/remotes/${name}/`;
    for (const [ref, value] of refs) {
      if (ref.startsWith(prefix) && value === head && !ref.endsWith("/HEAD")) {
        seenOnRemote = `${name}/${ref.slice(prefix.length)}`;
        break;
      }
    }
  }
  return {
    top,
    subdir: path.relative(top, dir).split(path.sep).join("/"),
    head,
    unusualHead: commit && !head ? commit.length : null,
    branch: symbolic?.startsWith("refs/heads/") ? symbolic.slice("refs/heads/".length) : null,
    remote: name === null ? null : { name, host: remoteHost(url), github: githubRepository(url) },
    remotes: remotes.size,
    seenOnRemote,
    // Only with a commit: before the first one nothing is in the catalog's reach whatever the index holds.
    index: head ? indexOf(gitDir) : null,
  };
}
