// Unpacks an app package the way the firmware does (js_app_installer.c handle_stage → tar_archive_unpack_to): the
// reader is microtar (lib/microtar/src/microtar.c), the writer lib/toolbox/tar/tar_archive.c, the names go through
// path_append (lib/toolbox/path.c) and FatFs (fbt_layers/core_libs/lib/fatfs/ff.c, _FS_RPATH 0 in
// targets/f21/config/ffconf.h). What that means for an archive:
// - Only directories ('5') and regular files ('0', or a NUL type) are written. Every other entry — PAX headers ('x',
//   'g'), GNU long names ('L', 'K'), links ('1', '2'), devices, FIFOs, contiguous files ('7') — is skipped, and its
//   data with it (tar_archive.c:483–486). PAX and GNU long names are not applied: the name is the 100-byte name field
//   alone. The ustar prefix field is not read either (microtar.c:205–206). Checked on a bar, 1.3.1, 10.11.
// - Files whose names start with "._" are ordinary files and are written like any other (checked on a bar, 10.11).
// - White space and a leading or trailing "/" are dropped from a name (path.c:88–99), so "/x" lands inside the target.
//   A "." or ".." part, or a part with one of "*:<>?|\x7F, is not a valid FAT name, and the whole unpack fails
//   (ff.c:2633–2668); trailing dots and spaces of a part are dropped. Checked on a bar, 1.3.1, for "." and "..".
// - A bad checksum, a number field that is not octal, or an archive that ends before its end record fails it too;
//   what was written before the fault stays, and a file whose data the archive cuts off is written as far as it goes
//   (tar_archive.c:437–443; checked on a bar, 1.3.1, with oversized-entry.tgz).
//
// Where this differs from the bar, knowingly: "\" is taken as a folder separator everywhere (FatFs takes it so, but
// the bar's storage layer makes parent folders by "/" only, so "a\b\c.js" without "a" made first fails there); names
// are read as UTF-8 (the bar hands the bytes to FatFs as code page 850); a gzip stream with two members is read only
// to the end of the first; heatshrink packages are not read. Real packers write none of these.
//
// Letter case: FAT finds a name whatever its case (ff.c cmp_lfn, ff_wtoupper), so "twin.js" after "Twin.js" is the
// same file — written again, and still named "Twin.js" — and "lib/" after "Lib/" the same folder. The unpacker does
// the same on every volume, for ASCII letters, so a volume that tells the two apart (Linux, case-sensitive APFS) gets
// what NTFS and APFS make by themselves. By the firmware's code; not checked on a bar.
//
// Windows device names (CON, NUL, aux.js, …) are ordinary names on FAT and are written as they are: Node reaches the
// file by its "\\?\" path. Explorer and the command prompt cannot open or delete such a file, so the log says so.
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { constants, crc32, inflateRawSync } from "node:zlib";

import { within } from "./path-boundary.mjs";

// The bar's limits are its SD card and its patience. The emulator refuses, before it writes anything, a package that
// would hold up the computer (the server does nothing else while it unpacks): more than 256 MiB unpacked, 10 000
// entries, 1 000 files and folders made, or a path more than 32 levels deep. The largest app in this repository has
// about 60 files 4 levels deep (a macOS archive has three entries a file, two of them skipped or small); the name
// field allows 50 levels. Measured on a Mac (EMU-223 report): 1 000 folders take under 0.11 s to make and 0.1 s to
// clear on the system disk, up to 1.8 s and 2.1 s on exFAT; 10 000 took 3.3 s and 42 s, so the limit is 1 000.
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRIES = 10_000;
export const MAX_MADE = 1_000;
export const MAX_DEPTH = 32;

export class UnpackError extends Error {}

const UINT_MAX = 0xffffffff;

// microtar.c parse_octal: digits (it lets 8 and 9 through) up to a space or NUL, then only spaces; a 32-bit result.
function parseOctal(field) {
  let n = 0;
  let i = 0;
  for (; i < field.length && field[i] !== 0; i++) {
    const c = field[i];
    if (c === 0x20) break;
    if (c < 0x30 || c > 0x39) throw new UnpackError("overflow");
    if (n > Math.floor(UINT_MAX / 8)) throw new UnpackError("overflow");
    n = n * 8 + (c - 0x30);
    if (n > UINT_MAX) throw new UnpackError("overflow");
  }
  for (; i < field.length && field[i] !== 0; i++) if (field[i] !== 0x20) throw new UnpackError("overflow");
  return n;
}

// microtar.c checksum: 256 for the checksum field taken as spaces, plus every other byte.
function checksum(header) {
  let sum = 256;
  for (let i = 0; i < 148; i++) sum += header[i];
  for (let i = 156; i < 512; i++) sum += header[i];
  return sum;
}

const cString = (bytes) => {
  const end = bytes.indexOf(0);
  return Buffer.from(end >= 0 ? bytes.subarray(0, end) : bytes).toString("utf8");
};

/** The entries of an uncompressed tar as microtar's mtar_foreach reads them: { type, name, prefix, data }. */
function* tarEntries(tar) {
  let offset = 0;
  for (let count = 0; ; count++) {
    if (offset + 512 > tar.length) throw new UnpackError("could not read"); // the archive ends without an end record
    const header = tar.subarray(offset, offset + 512);
    if (header[148] === 0) return; // a null record ends the archive (microtar.c:180–181)
    if (count >= MAX_ENTRIES) {
      throw Object.assign(new UnpackError(`more than ${MAX_ENTRIES} entries (a limit of the emulator, not of the BUSY Bar)`), {
        limit: true,
      });
    }
    if (parseOctal(header.subarray(148, 156)) !== checksum(header)) throw new UnpackError("bad checksum");
    for (const [start, length] of [[100, 8], [108, 8], [116, 8], [136, 12]]) parseOctal(header.subarray(start, start + length));
    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const posix = header.subarray(257, 263).toString("latin1") === "ustar\0"; // GNU's "ustar  " has no prefix field
    const dataEnd = offset + 512 + size;
    const truncated = dataEnd > tar.length; // the reader of a file writes what there is, then fails
    yield {
      type,
      name: cString(header.subarray(0, 100)),
      prefix: posix ? cString(header.subarray(345, 500)) : "",
      data: tar.subarray(offset + 512, Math.min(dataEnd, tar.length)),
      truncated,
    };
    if (truncated) throw new UnpackError("could not read");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

/**
 * An archive name → the parts of its path under the target, as path_append and FatFs make them; [] for the target
 * itself. Throws for a name FatFs refuses.
 */
export function nameParts(name) {
  let s = name.replace(/^[ \n\r\t]+|[ \n\r\t]+$/g, "").replace(/^\/+|\/+$/g, "");
  const control = s.search(/[\x00-\x1f]/); // FatFs takes a control character for the end of the path
  if (control >= 0) s = s.slice(0, control);
  if (s === "") return [];
  return s.split(/[/\\]+/).map((part) => {
    if (/["*:<>?|\x7f]/.test(part)) throw new UnpackError(`invalid name "${name}"`);
    const kept = part.replace(/[ .]+$/, "");
    if (kept === "") throw new UnpackError(`invalid name "${name}"`);
    return kept;
  });
}

// The bar decodes gzip as a stream while it reads the tar (lib/toolbox/compress.c): what a cut stream holds is still
// unpacked up to the cut (checked on a bar, cut-gzip.tgz), and the CRC and whatever follows the stream are never read
// (checked on a bar: a wrong CRC installs). So: skip the gzip header (RFC 1952), inflate what there is, and leave the
// end to the tar reader. A stream damaged in the middle fails here before anything is written; a bar, for the one
// such archive tried (gzip-damaged-mid.tgz), left nothing either — one damage position, not every one.
//
// Returns { tar, note }. The bar installs a package whose CRC is wrong, and so does the emulator; but a wrong CRC
// means the bytes are not the ones that were packed, which the author of the app wants to know, so `note` is a line
// for the log then. Only a stream that runs to its end has a CRC to compare.
function gunzipLikeTheBar(bytes, maxBytes) {
  const flags = bytes[3];
  let at = 10;
  if (flags & 4) at += 2 + (bytes[at] | (bytes[at + 1] << 8)); // FEXTRA
  if (flags & 8) at = bytes.indexOf(0, at) + 1; // FNAME
  if (flags & 16) at = bytes.indexOf(0, at) + 1; // FCOMMENT
  if (flags & 2) at += 2; // FHCRC
  if (at <= 0 || at > bytes.length) throw new Error("bad gzip header");
  const { buffer: tar, engine } = inflateRawSync(bytes.subarray(at), { finishFlush: constants.Z_SYNC_FLUSH, maxOutputLength: maxBytes, info: true });
  const trailer = at + engine.bytesWritten; // the CRC-32 of the data, then its length, follow the stream (RFC 1952)
  if (trailer + 4 > bytes.length) return { tar, note: null };
  const packed = (bytes[trailer] | (bytes[trailer + 1] << 8) | (bytes[trailer + 2] << 16) | (bytes[trailer + 3] << 24)) >>> 0;
  const unpacked = crc32(tar);
  if (packed === unpacked) return { tar, note: null };
  const hex = (n) => n.toString(16).padStart(8, "0");
  return {
    tar,
    note:
      `the gzip checksum does not match (CRC-32 ${hex(packed)} in the archive, ${hex(unpacked)} of its data): the archive ` +
      "changed after it was packed. The BUSY Bar does not read this checksum and installs the package all the same, and so does the emulator; pack the app again",
  };
}

// Windows keeps these names, with any extension, for devices (CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9).
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const SKIPPED = {
  x: "PAX header", g: "PAX global header", L: "GNU long name", K: "GNU long link name", 1: "hard link", 2: "symbolic link",
  3: "character device", 4: "block device", 6: "FIFO", 7: "contiguous file",
};

/**
 * Unpacks a package (.tgz or .tar) into `dir`, an empty folder, as tar_archive_unpack_to does. Returns
 * { topDirs, notes }: the folders made at the top of `dir` in the order they were made — the order a FAT directory
 * lists them in, and so the order the installer looks for the app in — and a line for each kind of entry that was not
 * written as it is named, for the log (the bar logs "not extracting unsupported type"). Throws UnpackError, with the
 * notes so far, where the firmware's unpack fails.
 */
export function unpackPackage(bytes, dir, { maxBytes = MAX_UNPACKED_BYTES, platform = process.platform } = {}) {
  let tar = bytes;
  let gzipNote = null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08) {
    try {
      ({ tar, note: gzipNote } = gunzipLikeTheBar(bytes, maxBytes));
    } catch (e) {
      throw new UnpackError(e?.code === "ERR_BUFFER_TOO_LARGE" ? `larger than ${maxBytes} bytes unpacked` : "bad gzip stream");
    }
  }
  if (tar.length > maxBytes) throw new UnpackError(`larger than ${maxBytes} bytes unpacked`);

  // The real path, so that the check below holds even when a folder above the target is a link (ADR-0012 §6).
  const root = realpathSync(dir);
  const topDirs = [];
  // FAT finds a name whatever its case: each path is written under the spelling that made it first. `dir` starts
  // empty, so every name in it is one this unpack made.
  const spelled = new Map(); // the path with ASCII letters in lower case → its parts as first written
  const asFirstSpelled = (parts) => {
    const out = [];
    for (const part of parts) {
      const key = [...out, part].join("/").replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (!spelled.has(key)) spelled.set(key, part);
      out.push(spelled.get(key));
    }
    return out;
  };
  const local = (parts) => {
    const p = resolve(root, ...parts);
    // nameParts leaves no "." or ".." and no absolute part, and no entry makes a link; this is the second lock.
    if (!within(p, root)) throw new UnpackError("outside the target");
    return p;
  };
  // storage_simply_mkpath: each folder on the way; one that exists, as a folder or as a file, counts as made
  // (storage_simply_mkdir takes FSE_EXIST for success).
  const mkpath = (parts) => {
    for (let i = 1; i <= parts.length; i++) {
      const p = local(parts.slice(0, i));
      let exists = true;
      try {
        statSync(p);
      } catch {
        exists = false;
      }
      if (exists) continue;
      try {
        mkdirSync(p);
      } catch {
        throw new UnpackError(`cannot make "${parts.slice(0, i).join("/")}"`);
      }
      if (i === 1) topDirs.push(parts[0]);
    }
  };

  const skipped = new Map(); // kind → { count, example }
  const note = (kind, example) => {
    const s = skipped.get(kind) ?? { count: 0, example };
    s.count++;
    skipped.set(kind, s);
  };
  const devices = new Set(); // paths with a part that is a device name on Windows
  const notes = () => [
    ...(gzipNote ? [gzipNote] : []),
    ...[...skipped].map(([kind, { count, example }]) =>
      kind === "prefix"
        ? `${count} ${count === 1 ? "entry has" : "entries have"} a ustar prefix, which the BUSY Bar does not read: "${example.full}" is written as "${example.name}"`
        : `skipped ${count} ${kind} ${count === 1 ? "entry" : "entries"}, as the BUSY Bar does ("${example}")`,
    ),
    ...(devices.size
      ? [
          `${devices.size} ${devices.size === 1 ? "name is a device name" : "names are device names"} on Windows ("${[...devices][0]}"): written all the same, as FAT ` +
            "has no such names, but Explorer and the command prompt cannot open or delete such a file; remove the app through the emulator",
        ]
      : []),
  ];
  const named = (name) => {
    const parts = asFirstSpelled(nameParts(name));
    if (platform === "win32") {
      parts.forEach((part, i) => WINDOWS_DEVICE.test(part) && devices.add(parts.slice(0, i + 1).join("/")));
    }
    return parts;
  };

  // The limits are checked before anything is written, so a package over them costs no time on a slow disk; any
  // other fault is left to the pass that writes, which stops where the bar's unpack stops.
  const made = new Set();
  const limit = (text) => Object.assign(new UnpackError(`${text} (a limit of the emulator, not of the BUSY Bar)`), { limit: true });
  try {
    for (const entry of tarEntries(tar)) {
      if (entry.type !== "5" && entry.type !== "0") continue;
      const parts = nameParts(entry.name);
      if (parts.length > MAX_DEPTH) throw limit(`a path more than ${MAX_DEPTH} levels deep`);
      for (let i = 1; i <= parts.length; i++) made.add(parts.slice(0, i).join("/"));
      if (made.size > MAX_MADE) throw limit(`more than ${MAX_MADE} files and folders`);
    }
  } catch (e) {
    if (e instanceof UnpackError && e.limit) throw e;
  }

  try {
    for (const entry of tarEntries(tar)) {
      if (entry.type !== "5" && entry.type !== "0") {
        note(SKIPPED[entry.type] ?? `type '${entry.type}'`, entry.name);
        continue; // "not extracting unsupported type" (tar_archive.c:483–486)
      }
      if (entry.prefix) note("prefix", { full: `${entry.prefix}/${entry.name}`, name: entry.name });
      if (entry.type === "5") {
        if (entry.name !== "/") mkpath(named(entry.name));
        continue;
      }
      const parts = named(entry.name);
      if (parts.length === 0) throw new UnpackError(`cannot write "${entry.name}"`);
      mkpath(parts.slice(0, -1));
      try {
        writeFileSync(local(parts), entry.data);
      } catch {
        throw new UnpackError(`cannot write "${entry.name}"`);
      }
      if (entry.truncated) throw new UnpackError("could not read");
    }
  } catch (e) {
    if (e instanceof UnpackError) e.notes = notes();
    throw e;
  }
  return { topDirs, notes: notes() };
}

/**
 * The entries of a package (.tgz or .tar) read in memory, nothing written: [{ type, name, prefix, data }], as
 * unpackPackage reads them, with the gzip checksum's note (or null). For a look at a package before it is installed
 * (projects/app-package.mjs). Throws UnpackError where the bar's unpack fails to read the archive, and for the
 * emulator's own limits.
 */
export function readPackage(bytes, { maxBytes = MAX_UNPACKED_BYTES } = {}) {
  let tar = bytes;
  let gzipNote = null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08) {
    try {
      ({ tar, note: gzipNote } = gunzipLikeTheBar(bytes, maxBytes));
    } catch (e) {
      throw new UnpackError(e?.code === "ERR_BUFFER_TOO_LARGE" ? `larger than ${maxBytes} bytes unpacked` : "bad gzip stream");
    }
  }
  if (tar.length > maxBytes) throw new UnpackError(`larger than ${maxBytes} bytes unpacked`);
  const entries = [];
  for (const entry of tarEntries(tar)) entries.push({ type: entry.type, name: entry.name, prefix: entry.prefix, data: entry.data });
  return { entries, gzipNote };
}

// Windows refuses to move or delete a folder while another program has a file in it open or stands in it — an
// antivirus or the indexer for a moment, an editor or a terminal for as long as it likes. There these errors are tried
// again, ten times over 2.25 s (the server waits meanwhile); a hold of 0.4 s is outlasted, a lasting one is not
// (measured on Windows 10, EMU-228). On macOS and Linux they are lasting refusals and are not tried again.
const BUSY = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
/** Whether an error is one that Windows gives while another program is using the file or folder. */
export const isBusy = (e) => process.platform === "win32" && BUSY.has(e?.code);
export function retrying(action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (e) {
      if (!isBusy(e) || attempt === 10) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

/**
 * Empties a folder, making it if needed (js_app_installer.c prepare_staging_folder). rmSync's own maxRetries does not
 * try again here: on Windows, Node 24 gives up at once on a file that is open elsewhere (measured, EMU-228).
 */
export function emptyFolder(dir) {
  retrying(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(dir, { recursive: true });
}
