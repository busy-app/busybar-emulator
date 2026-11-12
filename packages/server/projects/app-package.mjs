// A look at an app package (.tgz) before it is installed: what app it holds and whether the emulated BUSY Bar would
// take it, read in memory with nothing written (`busy-emulator install <file.tgz> --check`, and before every package
// install; the window's Install a package shows what this says in its trust dialog).
//
// The rules are the bar's (tar.mjs, device.mjs stage and loadApp), and a few stricter ones of the emulator's, for
// someone else's package:
//   - at most 100 MiB, what the bar takes (MAX_UPLOAD_FILE_SIZE); not empty;
//   - a gzip stream and a tar the bar's reader reads to its end;
//   - no absolute path and no "." or ".." part in any name: the bar drops a leading "/" and fails on "." and "..", but
//     a name like that means the archive was not made by busy-cli, and it is refused before anything is sent;
//   - an app folder at the top with scripts/main.js and appmeta/manifest.json whose id is the folder's name, a name,
//     format_version 1, version and api_version as MAJOR.MINOR.PATCH, heap_size_kib from 1 to 512 when given: the
//     first such folder, in the order the archive makes them, is the app, as on the bar.
// What the bar installs all the same but the author would want to know is a note: macOS's "._*" files (AppleDouble,
// packed by tar on macOS without COPYFILE_DISABLE=1), entries the bar skips (links, PAX headers), a wrong gzip CRC.
import { nameParts, readPackage, UnpackError } from "../tar.mjs";

/** The most a package may hold: the bar takes 100 MiB (MAX_UPLOAD_FILE_SIZE). */
export const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;

const APP_ID_RE = /^[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]{0,31}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** A package the bar would not take, or one the emulator refuses: `code`, a sentence, and what to do. */
export class PackageProblem extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

const SKIPPED = { x: "PAX header", g: "PAX global header", L: "GNU long name", K: "GNU long link name", 1: "hard link", 2: "symbolic link", 3: "character device", 4: "block device", 6: "FIFO", 7: "contiguous file" };
const REBUILD = "Build the package again with busy-cli build, or ask its author for one.";
/** tar.mjs's words for an archive it cannot read, as the person reads them. */
const READ_FAULTS = { "could not read": "the archive ends before its end, or is no archive", "bad gzip stream": "its gzip stream is damaged", "bad checksum": "a header of the archive is damaged", overflow: "a header of the archive is damaged" };
const shownName =(name) => JSON.stringify(String(name).slice(0, 120));

/** Why an archive name is refused: an absolute path, or a "." or ".." part; null for a plain one. */
function unsafeName(name) {
  const plain = name.replace(/^[ \n\r\t]+|[ \n\r\t]+$/g, "");
  if (/^[/\\]/.test(plain) || /^[A-Za-z]:/.test(plain)) return "an absolute path";
  const parts = plain.split(/[/\\]+/);
  if (parts.includes("..")) return 'a ".." part';
  if (parts.includes(".")) return 'a "." part';
  return null;
}

/** Why a manifest is not one the bar installs, or null. */
function manifestProblem(m, folder) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "it is not a JSON object";
  if (m.format_version !== 1) return "format_version is not 1";
  if (typeof m.id !== "string" || !APP_ID_RE.test(m.id)) return "id is not an app id (letters, digits, _, - and ., at most 32)";
  if (m.id !== folder) return `id ${shownName(m.id)} is not the name of its folder, ${shownName(folder)}`;
  if (typeof m.name !== "string" || !m.name.trim()) return "it has no name";
  if (!SEMVER_RE.test(m.version ?? "")) return "version is not MAJOR.MINOR.PATCH";
  if (!SEMVER_RE.test(m.api_version ?? "")) return "api_version is not MAJOR.MINOR.PATCH";
  if (m.heap_size_kib !== undefined && !(m.heap_size_kib >= 1 && m.heap_size_kib <= 512)) return "heap_size_kib is not from 1 to 512";
  return null;
}

/**
 * The app a package holds: { id, name, version, api_version, folder, files, size, notes }; `size` the package's own
 * bytes, `files` the files of the app folder, `notes` lines for the person. Throws PackageProblem: package_too_large,
 * broken_package, unsafe_path, bad_manifest, no_app.
 */
export function checkAppPackage(bytes, { maxBytes = MAX_PACKAGE_BYTES } = {}) {
  if (!bytes?.length) throw new PackageProblem("broken_package", "The package is empty.", REBUILD);
  if (bytes.length > maxBytes) throw new PackageProblem("package_too_large", `The package is larger than the BUSY Bar takes (${Math.round(maxBytes / 1048576)} MiB).`, "Build a smaller package.");
  let read;
  try {
    read = readPackage(bytes);
  } catch (e) {
    if (e instanceof UnpackError) throw new PackageProblem("broken_package", `The package cannot be read: ${READ_FAULTS[e.message] ?? e.message}.`, REBUILD);
    throw e;
  }
  const notes = read.gzipNote ? [read.gzipNote] : [];
  const skipped = new Map();
  // FAT finds a name whatever its case: the paths are compared in lower case, each folder kept as first spelled.
  const spelled = new Map();
  const files = new Map(); // lower-case path → { path, data }
  const tops = []; // the folders at the top, in the order the archive makes them
  let appleDouble = 0;
  for (const entry of read.entries) {
    if (entry.type !== "0" && entry.type !== "5") {
      const kind = SKIPPED[entry.type] ?? `type '${entry.type}'`;
      skipped.set(kind, (skipped.get(kind) ?? 0) + 1);
      continue;
    }
    const why = unsafeName(entry.name);
    if (why) throw new PackageProblem("unsafe_path", `The package has ${shownName(entry.name)}, ${why}: an app package made by busy-cli has none.`, REBUILD);
    let parts;
    try {
      parts = nameParts(entry.name);
    } catch (e) {
      throw new PackageProblem("broken_package", `The package has a name the BUSY Bar cannot write: ${shownName(entry.name)}.`, REBUILD);
    }
    if (!parts.length) continue;
    const first = parts.map((_, i) => {
      const key = parts.slice(0, i + 1).join("/").toLowerCase();
      if (!spelled.has(key)) spelled.set(key, parts[i]);
      return spelled.get(key);
    });
    if (!tops.some((top) => top.toLowerCase() === first[0].toLowerCase()) && (entry.type === "5" || parts.length > 1)) tops.push(first[0]);
    if (entry.type === "0") {
      if (parts.at(-1).startsWith("._")) appleDouble += 1;
      files.set(first.join("/").toLowerCase(), { path: first.join("/"), data: entry.data });
    }
  }
  if (appleDouble) notes.push(`It holds ${appleDouble} macOS "._" ${appleDouble === 1 ? "file" : "files"} (tar on macOS packs them without COPYFILE_DISABLE=1). The BUSY Bar installs them as they are; they do no harm.`);
  for (const [kind, count] of skipped) notes.push(`It holds ${count} ${kind} ${count === 1 ? "entry" : "entries"}, which the BUSY Bar skips.`);

  let firstProblem = null;
  for (const top of tops) {
    const manifest = files.get(`${top}/appmeta/manifest.json`.toLowerCase());
    if (!manifest || !files.has(`${top}/scripts/main.js`.toLowerCase())) continue;
    let m;
    try {
      m = JSON.parse(Buffer.from(manifest.data).toString("utf8"));
    } catch {
      firstProblem ??= `${top}/appmeta/manifest.json is not JSON`;
      continue;
    }
    const problem = manifestProblem(m, top);
    if (problem) {
      firstProblem ??= `in ${top}/appmeta/manifest.json, ${problem}`;
      continue;
    }
    const inApp = [...files.keys()].filter((key) => key.startsWith(`${top.toLowerCase()}/`)).length;
    return { id: m.id, name: m.name.trim().slice(0, 100), version: m.version, api_version: m.api_version, folder: top, files: inApp, size: bytes.length, notes };
  }
  if (firstProblem) throw new PackageProblem("bad_manifest", `The package's app manifest is not one the BUSY Bar installs: ${firstProblem}.`, REBUILD);
  throw new PackageProblem("no_app", "The package holds no app: no folder at its top has scripts/main.js and appmeta/manifest.json.", "Choose an app package, as busy-cli build makes it (dist/<id>.tgz).");
}
