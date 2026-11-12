// What a project's own git repository says, read from its .git folder without git (catalog-update): the commit it is
// at, and whether it holds a commit. Publish into an existing repository uses it to see whether GitHub has commits the
// project does not. Nothing is written; anything unexpected is "not known" (null, false).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{40}$/;

/** The .git folder of a project folder (a folder, or a file "gitdir: <path>" of a worktree), or null. */
function gitDir(folder) {
  const dot = path.join(folder, ".git");
  try {
    const stat = statSync(dot);
    if (stat.isDirectory()) return dot;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    return m ? path.resolve(folder, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/** The commit the project's git is at: its HEAD, followed through a branch (loose or packed), or null. */
export function localHead(folder) {
  const dir = gitDir(folder);
  if (!dir) return null;
  try {
    const head = readFileSync(path.join(dir, "HEAD"), "utf8").trim();
    if (SHA.test(head)) return head;
    const ref = /^ref:\s*(refs\/[^\s]+)$/.exec(head)?.[1];
    if (!ref || ref.split("/").includes("..")) return null;
    const loose = path.join(dir, ...ref.split("/"));
    if (existsSync(loose)) {
      const sha = readFileSync(loose, "utf8").trim();
      return SHA.test(sha) ? sha : null;
    }
    const packed = readFileSync(path.join(dir, "packed-refs"), "utf8");
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && SHA.test(sha)) return sha;
    }
  } catch {
    // Not known.
  }
  return null;
}

/** Whether the project's git holds the object `sha`: a loose object, or one in a pack's index (version 2). */
export function localHas(folder, sha) {
  const dir = gitDir(folder);
  if (!dir || !SHA.test(sha)) return false;
  const objects = path.join(dir, "objects");
  if (existsSync(path.join(objects, sha.slice(0, 2), sha.slice(2)))) return true;
  let packs = [];
  try {
    packs = readdirSync(path.join(objects, "pack")).filter((one) => one.endsWith(".idx"));
  } catch {
    return false;
  }
  const wanted = Buffer.from(sha, "hex");
  for (const one of packs) {
    let idx;
    try {
      idx = readFileSync(path.join(objects, "pack", one));
    } catch {
      continue;
    }
    // \377tOc, version 2, then 256 counts (the fan-out) and the sorted object names.
    if (idx.length < 8 + 1024 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) continue;
    const first = wanted[0];
    let lo = first === 0 ? 0 : idx.readUInt32BE(8 + (first - 1) * 4);
    let hi = idx.readUInt32BE(8 + first * 4);
    const names = 8 + 1024;
    if (names + hi * 20 > idx.length) continue;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = names + mid * 20;
      const order = Buffer.compare(idx.subarray(at, at + 20), wanted);
      if (order === 0) return true;
      if (order < 0) lo = mid + 1;
      else hi = mid;
    }
  }
  return false;
}
