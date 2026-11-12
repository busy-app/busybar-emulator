// What a project folder holds that the catalog's checks look at: the app's manifest, the built package, the catalog
// details the author wrote (catalog.json), the screenshots, the icons, the license and lock files, and the git
// repository around it. Reading only: nothing is written, nothing of the project is run, no program is started.
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { insideFolder } from "../path-boundary.mjs";
import { readGit } from "./git-folder.mjs";
import { entryAt, readPackage } from "./package-file.mjs";
import { LICENSE_FILE, LIMITS } from "./rules.mjs";

/** The author's catalog details, in the project's folder. */
export const DETAILS_FILE = "catalog.json";
/** The fields of catalog.json; the first four are the author's to write. */
export const DETAILS_FIELDS = Object.freeze(["category", "short_description", "description", "changelog", "screenshots", "back_screenshots"]);
/** Where `busy-emulator screenshot` puts its files. */
export const SCREENSHOTS_FOLDER = "screenshots";
/** The folder `submit` writes. */
export const SUBMISSION_FOLDER = "submission";

const ICONS = Object.freeze({ front: "icon_front_8x8.png", back: "icon_back_11x11.png" });
const SOURCE_SKIPPED = new Set([".git", "node_modules", "dist", SUBMISSION_FOLDER]);
const MAX_SOURCE_FILES = 50_000;

function readBytes(file, limit = Infinity) {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { missing: true };
    if (stat.size > limit) return { tooLarge: stat.size };
    return { bytes: readFileSync(file) };
  } catch {
    return { missing: true };
  }
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function readJson(file) {
  const read = readBytes(file, 64 * 1024 * 1024);
  if (!read.bytes) return { exists: false, bytes: null, json: undefined, error: null };
  try {
    return { exists: true, bytes: read.bytes, json: JSON.parse(read.bytes.toString("utf8")), error: null };
  } catch (e) {
    return { exists: true, bytes: read.bytes, json: undefined, error: e.message };
  }
}

/** Where the catalog reads the app's id from, in the app's folder of the repository, and the most it reads there. */
export const CATALOG_MANIFEST = "src/appmeta/manifest.json";
export const CATALOG_MANIFEST_BYTES = 4096;

/**
 * The app's manifest in the project: src/appmeta/manifest.json of the official template, or appmeta/ at the top,
 * which busy-cli builds as well. `inSrc` says it is where the catalog looks; `link` that it is a symbolic link, which
 * the catalog does not follow.
 */
export function sourceManifest(dir) {
  for (const inside of [["src", "appmeta"], ["appmeta"]]) {
    const file = path.join(dir, ...inside, "manifest.json");
    if (isFile(file)) {
      let link = false;
      try {
        link = lstatSync(file).isSymbolicLink();
      } catch {
        // gone meanwhile
      }
      return { file, relative: [...inside, "manifest.json"].join("/"), folder: path.join(dir, ...inside), folderRelative: inside.join("/"), inSrc: inside.length === 2, link, ...readJson(file) };
    }
  }
  return { file: null, relative: CATALOG_MANIFEST, folder: null, folderRelative: "src/appmeta", inSrc: true, link: false, exists: false, bytes: null, json: undefined, error: null };
}

/** A path of catalog.json inside the project, or null when it leaves it (absolute, "..", a backslash). */
export function safeRelative(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split("/").includes("..");
}

/**
 * What git keeps of a file of the project: { kept: true }, { kept: false, spelled } (`spelled`: the path git keeps
 * that differs only in letter case, or null), or null when that is not known (no repository, no commit, an index this
 * copy does not read). `relative` is from the project's folder, with forward slashes.
 */
export function keptByGit(git, relative) {
  if (!git?.index) return null;
  const fromTop = git.subdir ? `${git.subdir}/${relative}` : relative;
  if (git.index.has(fromTop)) return { kept: true, spelled: null };
  const spelled = git.index.spelled(fromTop);
  return { kept: false, spelled: spelled && git.subdir ? spelled.slice(git.subdir.length + 1) : spelled };
}

function image(dir, relative, git) {
  const safe = safeRelative(relative);
  const read = safe ? readBytes(path.join(dir, ...relative.split("/")), 16 * 1024 * 1024) : { missing: true };
  // The catalog takes no path through a .git folder, and no link that leads out of the app's folder.
  const inGit = safe && relative.split("/").includes(".git");
  const plain = safe ? relative.split("/").filter((part) => part && part !== ".").join("/") : null;
  const outside = Boolean(safe && read.bytes && insideFolder(dir, plain) === null);
  return { path: relative, safe, inGit, outside, bytes: read.bytes ?? null, tooLarge: read.tooLarge ?? null, git: safe ? keptByGit(git, plain) : null };
}

/** screenshots/front-<n>.png and back-<n>.png, in the order of their numbers: the names `busy-emulator screenshot` gives. */
function conventionScreenshots(dir, display) {
  let names = [];
  try {
    names = readdirSync(path.join(dir, SCREENSHOTS_FOLDER));
  } catch {
    // no folder: no screenshots
  }
  const pattern = new RegExp(`^${display}-(\\d+)\\.png$`);
  return names
    .map((name) => ({ name, n: Number(pattern.exec(name)?.[1] ?? NaN) }))
    .filter((entry) => Number.isInteger(entry.n))
    .sort((a, b) => a.n - b.n)
    .map((entry) => `${SCREENSHOTS_FOLDER}/${entry.name}`);
}

function screenshots(dir, details, field, display, git) {
  const listed = details.json && typeof details.json === "object" ? details.json[field] : undefined;
  if (Array.isArray(listed)) return { from: DETAILS_FILE, wrong: listed.filter((item) => typeof item !== "string").length, files: listed.filter((item) => typeof item === "string").map((item) => image(dir, item, git)) };
  return { from: `${SCREENSHOTS_FOLDER}/${display}-<n>.png`, wrong: listed === undefined ? 0 : 1, files: conventionScreenshots(dir, display).map((item) => image(dir, item, git)) };
}

function licenseFiles(folder, where, git, fromProject) {
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => ({ name, where, file: path.join(folder, name) }))
    .filter(({ file }) => {
      try {
        const stat = lstatSync(file);
        return stat.isFile();
      } catch {
        return false;
      }
    })
    .map((entry) => {
      const read = readBytes(entry.file, LIMITS.licenseBytes);
      // `fromProject`: the folder's path from the project's folder ("" for the project itself, null for a folder
      // above it, whose files are named from the repository's top).
      const kept = !git?.index ? null : fromProject === null ? { kept: git.index.has(entry.name), spelled: null } : keptByGit(git, entry.name);
      return { ...entry, text: read.bytes ? read.bytes.toString("utf8") : null, git: kept };
    });
}

/** The bytes of the project's files that could be committed: everything but .git, node_modules, dist and submission. */
function sourceSize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (folder) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files > MAX_SOURCE_FILES) return;
      if (entry.isDirectory()) {
        if (!(folder === dir && SOURCE_SKIPPED.has(entry.name))) walk(path.join(folder, entry.name));
      } else if (entry.isFile()) {
        files++;
        try {
          bytes += statSync(path.join(folder, entry.name)).size;
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(dir);
  return { bytes, files, counted: files <= MAX_SOURCE_FILES };
}

/** The newest change among the files of a folder, in ms, or 0. */
function newestIn(folder) {
  let newest = 0;
  let seen = 0;
  const walk = (at) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen++ > 5000) return;
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        try {
          newest = Math.max(newest, statSync(file).mtimeMs);
        } catch {
          // gone meanwhile
        }
      }
    }
  };
  walk(folder);
  return newest;
}

/**
 * Everything the checks read of the project in `dir`.
 * @param {string} dir  the project's folder, by its real path
 * @param {object} o
 * @param {{ name: string, api: string }|null} o.firmware  the released firmware of this emulator
 */
export function gatherFacts(dir, { firmware = null } = {}) {
  const manifest = sourceManifest(dir);
  const id = manifest.json && typeof manifest.json === "object" && typeof manifest.json.id === "string" ? manifest.json.id : null;
  const pkg = id ? readPackage(dir, id) : null;
  // The manifest of the build, where there is one: that is what the catalog packs.
  let built = null;
  if (pkg && !pkg.unreadable && !pkg.tooLarge) {
    const entry = entryAt(pkg, id, "appmeta/manifest.json");
    if (entry?.kind === "file") {
      const bytes = entry.read();
      built = { bytes, json: undefined, error: null };
      try {
        built.json = JSON.parse(bytes.toString("utf8"));
      } catch (e) {
        built.error = e.message;
      }
    }
  }
  const details = { file: path.join(dir, DETAILS_FILE), ...readJson(path.join(dir, DETAILS_FILE)) };
  const git = readGit(dir);
  const icons = {};
  for (const [side, name] of Object.entries(ICONS)) {
    const inPackage = pkg && !pkg.unreadable && !pkg.tooLarge ? entryAt(pkg, id, `appmeta/${name}`) : null;
    if (inPackage?.kind === "file") icons[side] = { path: `appmeta/${name} of the built package`, bytes: inPackage.read() };
    else if (manifest.folder) {
      const read = readBytes(path.join(manifest.folder, name), 16 * 1024 * 1024);
      icons[side] = read.bytes ? { path: `${manifest.folderRelative}/${name}`, bytes: read.bytes } : null;
    } else icons[side] = null;
  }
  const packageJson = readJson(path.join(dir, "package.json"));
  const srcNewest = Math.max(newestIn(path.join(dir, "src")), manifest.file ? newestIn(path.dirname(manifest.file)) : 0);
  return {
    dir,
    id,
    manifest,
    built,
    pkg,
    stale: Boolean(pkg && srcNewest > pkg.modified + 2000),
    details,
    screenshots: { front: screenshots(dir, details, "screenshots", "front", git), back: screenshots(dir, details, "back_screenshots", "back", git) },
    icons,
    licenses: [...licenseFiles(dir, "the app's folder", git, ""), ...(git && git.top !== dir ? licenseFiles(git.top, "the repository's top folder", git, null) : [])],
    locks: {
      npm: isFile(path.join(dir, "package-lock.json")),
      pnpm: isFile(path.join(dir, "pnpm-lock.yaml")),
      npmJson: readJson(path.join(dir, "package-lock.json")),
      pnpmText: readBytes(path.join(dir, "pnpm-lock.yaml"), 32 * 1024 * 1024).bytes?.toString("utf8") ?? null,
      // What git keeps of each (keptByGit), or null when that is not known: the catalog sees only what is committed.
      npmGit: keptByGit(git, "package-lock.json"),
      pnpmGit: keptByGit(git, "pnpm-lock.yaml"),
    },
    // What git keeps of the app's manifest where the catalog reads it.
    manifestGit: manifest.exists && manifest.inSrc ? keptByGit(git, CATALOG_MANIFEST) : null,
    packageJson,
    git,
    source: sourceSize(dir),
    firmware,
    // Filled by check.mjs: what each script of the build imports (import-probe.mjs), or why that is not known.
    imports: null,
    // Filled by check.mjs: the PNG checker (../capture/catalog-png.mjs), or null where this copy has none.
    png: null,
  };
}
