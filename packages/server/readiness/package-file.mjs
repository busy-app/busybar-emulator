// The built app of a project, as `busy-cli build` leaves it: dist/<id>.tgz, or the folder dist/<id>/ (`--emit dir`).
// Read for the checks only: nothing is unpacked to the disk and nothing in it is run. The archive is read the way a
// general tar reader reads it (ustar prefix, PAX and GNU long names applied), not the way the bar's installer does
// (../tar.mjs): the catalog builds the app itself and looks at what the build put out, by its real names.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;
/** The most an archive may unpack to before the reader gives up: beyond any limit a check has. */
export const MAX_READ = 160 * 1024 * 1024;
const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_WALK = 20_000;

class Unreadable extends Error {}

function text(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.toString("utf8", 0, end < 0 ? length : end);
}

function number(block, start, length) {
  const field = block.subarray(start, start + length);
  if (field[0] & 0x80) {
    let n = field[0] & 0x7f;
    for (let i = 1; i < length; i++) n = n * 256 + field[i];
    return n;
  }
  const digits = field.toString("latin1").replace(/[\0 ]+$/, "").trim();
  if (digits === "") return 0;
  if (!/^[0-7]+$/.test(digits)) throw new Unreadable("a header has a number that is not octal");
  return parseInt(digits, 8);
}

function paxRecords(data) {
  const records = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const length = Number(data.toString("latin1", at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    const record = data.toString("utf8", space + 1, at + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return records;
}

/** Whether a path can be written into a plain (ustar) header: 100 bytes of name, or 155 of prefix, a slash, 100 of name. */
export function fitsPlainTar(name, isFolder) {
  const bytes = Buffer.byteLength(isFolder ? `${name}/` : name);
  if (bytes <= 100) return true;
  if (bytes > 256) return false;
  const full = isFolder ? `${name}/` : name;
  for (let i = full.indexOf("/"); i >= 0 && i < full.length - 1; i = full.indexOf("/", i + 1)) {
    if (Buffer.byteLength(full.slice(0, i)) <= 155 && Buffer.byteLength(full.slice(i + 1)) <= 100) return true;
  }
  return false;
}

/** The parts of an archive path as a POSIX path has them: "." and empty parts dropped, a leading "/" kept as a part. */
export function partsOf(name) {
  const parts = name.split("/").filter((part) => part !== "" && part !== ".");
  return name.startsWith("/") ? ["/", ...parts] : parts;
}

function entriesOfTar(tar) {
  const entries = [];
  let at = 0;
  let pending = {};
  let extended = false;
  while (at + BLOCK <= tar.length) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
    if (number(block, 148, 8) !== sum) throw new Unreadable("a header has a wrong checksum");
    const size = number(block, 124, 12);
    const type = String.fromCharCode(block[156] || 0x30);
    const dataStart = at + BLOCK;
    if (dataStart + size > tar.length) throw new Unreadable("it ends in the middle of a file");
    const data = tar.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      Object.assign(pending, paxRecords(data));
      extended = true;
      continue;
    }
    if (type === "g") {
      extended = true;
      continue;
    }
    if (type === "L") {
      pending.path = data.toString("utf8").replace(/\0+$/, "");
      extended = true;
      continue;
    }
    if (type === "K") continue;
    const ustar = block.toString("latin1", 257, 262) === "ustar";
    const prefix = ustar ? text(block, 345, 155) : "";
    let name = pending.path ?? (prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100));
    pending = {};
    let kind = type === "0" || type === "7" ? "file" : type === "5" ? "folder" : "other";
    if (kind === "file" && name.endsWith("/")) kind = "folder";
    if (kind === "folder") name = name.replace(/\/+$/, "");
    const label = { 1: "a hard link", 2: "a symbolic link", 3: "a device", 4: "a device", 6: "a FIFO" }[type] ?? `an entry of type ${JSON.stringify(type)}`;
    entries.push({ name, kind, label: kind === "other" ? label : kind, size: kind === "file" ? size : 0, read: () => data });
  }
  return { entries, extended };
}

function entriesOfFolder(root, id) {
  const entries = [{ name: id, kind: "folder", label: "folder", size: 0, read: () => Buffer.alloc(0) }];
  const walk = (dir, name) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entries.length > MAX_WALK) return;
      const file = path.join(dir, entry.name);
      const inside = `${name}/${entry.name}`;
      if (entry.isDirectory()) {
        entries.push({ name: inside, kind: "folder", label: "folder", size: 0, read: () => Buffer.alloc(0) });
        walk(file, inside);
      } else if (entry.isFile()) entries.push({ name: inside, kind: "file", label: "file", size: statSync(file).size, read: () => readFileSync(file) });
      else entries.push({ name: inside, kind: "other", label: entry.isSymbolicLink() ? "a symbolic link" : "a special file", size: 0, read: () => Buffer.alloc(0) });
    }
  };
  walk(root, id);
  return entries;
}

/**
 * The built app of the project in `dir` with the id `id`, or null when it is not built.
 * @returns {null | {
 *   kind: "archive"|"folder", file: string, bytes: number|null, modified: number,
 *   unreadable: string|null,       why the archive cannot be read (then `entries` is empty)
 *   tooLarge: boolean,             it unpacks to more than MAX_READ, and was not read further
 *   extended: boolean,             the archive has PAX or GNU long-name headers
 *   entries: Array<{ name: string, kind: "file"|"folder"|"other", label: string, size: number, read: () => Buffer }>,
 *   appleDouble: string[],         "._" files of macOS that were left out of `entries`
 * }}
 */
export function readPackage(dir, id) {
  if (typeof id !== "string" || !id || /[\\/]/.test(id) || id === "." || id === "..") return null;
  const archive = path.join(dir, "dist", `${id}.tgz`);
  const folder = path.join(dir, "dist", id);
  const stat = (file) => {
    try {
      return lstatSync(file);
    } catch {
      return null;
    }
  };
  const result = { kind: "archive", file: archive, bytes: null, modified: 0, unreadable: null, tooLarge: false, extended: false, entries: [], appleDouble: [] };
  const folderStat = stat(folder);
  const archiveStat = stat(archive);
  let found;
  if (folderStat?.isDirectory()) {
    result.kind = "folder";
    result.file = folder;
    result.modified = folderStat.mtimeMs;
    found = entriesOfFolder(folder, id);
  } else if (archiveStat?.isFile()) {
    result.bytes = archiveStat.size;
    result.modified = archiveStat.mtimeMs;
    if (archiveStat.size > MAX_ARCHIVE) {
      result.tooLarge = true;
      return result;
    }
    try {
      let tar;
      try {
        tar = gunzipSync(readFileSync(archive), { maxOutputLength: MAX_READ });
      } catch (e) {
        if (e?.code === "ERR_BUFFER_TOO_LARGE") {
          result.tooLarge = true;
          return result;
        }
        throw new Unreadable("it is not gzip data");
      }
      const read = entriesOfTar(tar);
      found = read.entries;
      result.extended = read.extended;
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      result.unreadable = e.message;
      return result;
    }
  } else return null;
  for (const entry of found) {
    if (path.posix.basename(entry.name).startsWith("._")) result.appleDouble.push(entry.name);
    else result.entries.push(entry);
  }
  return result;
}

/** The entry of a package at `<id>/<inside>`, by its parts: "./id/x" and "id//x" are the same file. */
export function entryAt(pkg, id, inside) {
  const wanted = [id, ...inside.split("/")].join("/");
  return pkg.entries.find((entry) => partsOf(entry.name).join("/") === wanted) ?? null;
}
