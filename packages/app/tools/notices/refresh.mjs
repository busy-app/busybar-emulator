#!/usr/bin/env node
// Writes libraries.json and texts/ beside this file: what the license summary of the app (notices.mjs, EMU-255) says
// about the firmware inside the emulator, read from a firmware checkout at the commits firmware.json pins, and from
// the Emscripten SDK the modules are built with. The packaging cannot read the firmware (a release is built without
// it), so what it needs is recorded here; nothing in libraries.json is typed by hand.
//
//   node tools/notices/refresh.mjs [--firmware-repo <path>] [--emsdk <path>] [--check]
//
// --firmware-repo: the firmware checkout (EMU_FIRMWARE_REPO, or busybar-firmware beside emulator/), as for the
// engine's build; it is only read (git show, git ls-tree). --emsdk: the SDK (EMSDK, or emsdk beside the repository).
// --check: writes nothing; exit code 1 when the files here differ from what the firmware and the SDK say.
//
// What is written by hand is the catalogue below: which libraries of the firmware the build compiles, which license
// each third-party library is under (by its own license file, which is copied), where its version is written. The
// firmware's own code, its assets and the copies of its files are given the license and copyright its REUSE.toml
// says. Every path the engine's build takes from the firmware (build-paths.mjs) must belong to an entry of the
// catalogue or be the firmware's own code by REUSE.toml; refresh stops otherwise.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execProgram } from "../../../engine/programs.mjs";
import { ENGINE_DIR, firmwarePathsOfBuild } from "./build-paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMULATOR_DIR = path.resolve(ENGINE_DIR, "..", "..");
export const LIBRARIES_FILE = path.join(HERE, "libraries.json");
export const TEXTS_DIR = path.join(HERE, "texts");

const define = (name) => new RegExp(`#define\\s+${name}\\s+"?([^"\\s]+)"?`);
const version = (file, ...names) => ({ file, read: (s) => names.map((n) => define(n).exec(s)?.[1]).join(".") });

/**
 * The third-party libraries the build compiles into the modules. paths: the folders or files of the firmware that
 * are this library (the longest one that holds a path wins); via: firmware files whose compilation compiles this
 * library (stb.c defines STB_DS_IMPLEMENTATION). license: the SPDX identifier of the library's license file, which
 * texts copies; reuse: the library is the firmware's own and REUSE.toml says its license.
 */
export const CATALOGUE = Object.freeze([
  { id: "jerryscript", name: "JerryScript", modules: ["runtime"], paths: ["lib/jerryscript"], license: "Apache-2.0", texts: ["lib/jerryscript/LICENSE"], upstream: "https://github.com/jerryscript-project/jerryscript", version: version("lib/jerryscript/jerry-core/include/jerryscript.h", "JERRY_API_MAJOR_VERSION", "JERRY_API_MINOR_VERSION", "JERRY_API_PATCH_VERSION") },
  { id: "lvgl", name: "LVGL", modules: ["screen"], paths: ["lib/lvgl"], license: "MIT", texts: ["lib/lvgl/LICENSE.txt"], upstream: "https://github.com/lvgl/lvgl", version: { file: "lib/lvgl/lv_version.h", read: (s) => ["MAJOR", "MINOR", "PATCH"].map((n) => define(`LVGL_VERSION_${n}`).exec(s)[1]).join(".") + (define("LVGL_VERSION_INFO").exec(s)?.[1] ? `-${define("LVGL_VERSION_INFO").exec(s)[1]}` : "") } },
  { id: "lodepng", name: "LodePNG (part of LVGL)", modules: ["screen"], paths: ["lib/lvgl/src/libs/lodepng"], license: "Zlib", texts: ["lib/lvgl/src/libs/lodepng/LICENSE.txt"], upstream: "https://github.com/lvandeve/lodepng", version: { file: "lib/lvgl/src/libs/lodepng/lodepng.c", read: (s) => /LODEPNG_VERSION_STRING = "([^"]+)"/.exec(s)[1] } },
  { id: "qrcodegen", name: "QR Code generator (part of LVGL)", modules: ["screen"], paths: ["lib/lvgl/src/libs/qrcode"], license: "MIT", texts: ["lib/lvgl/src/libs/qrcode/LICENSE.txt"], upstream: "https://github.com/nayuki/QR-Code-generator" },
  { id: "mongoose", name: "Mongoose", modules: ["screen"], paths: ["lib/mongoose"], license: "GPL-2.0-only", texts: ["lib/mongoose/LICENSE"], upstream: "https://github.com/cesanta/mongoose", version: version("lib/mongoose/mongoose.h", "MG_VERSION"), note: "Mongoose is dual-licensed, GPLv2 or commercial; it is distributed here under the GNU General Public License version 2, as in the BUSY Bar firmware." },
  { id: "cjson", name: "cJSON", modules: ["runtime", "screen"], paths: ["lib/cjson"], license: "MIT", texts: ["lib/cjson/LICENSE"], upstream: "https://github.com/DaveGamble/cJSON", version: version("lib/cjson/cJSON.h", "CJSON_VERSION_MAJOR", "CJSON_VERSION_MINOR", "CJSON_VERSION_PATCH") },
  { id: "stb", name: "stb_ds (stb)", modules: ["screen"], paths: ["lib/stb/stb_repo"], via: ["lib/stb/stb.c"], license: "MIT OR Unlicense", texts: ["lib/stb/stb_repo/LICENSE"], upstream: "https://github.com/nothings/stb", version: { file: "lib/stb/stb_repo/stb_ds.h", read: (s) => /stb_ds\.h - (v[\d.]+)/.exec(s)[1] } },
  { id: "mlib", name: "M*LIB", modules: ["runtime", "screen"], paths: ["fbt_layers/core_libs/lib/mlib"], license: "BSD-2-Clause", texts: ["fbt_layers/core_libs/lib/mlib/LICENSE"], upstream: "https://github.com/P-p-H-d/mlib", version: version("fbt_layers/core_libs/lib/mlib/m-core.h", "M_CORE_VERSION_MAJOR", "M_CORE_VERSION_MINOR", "M_CORE_VERSION_PATCHLEVEL") },
  { id: "utz", name: "utz", modules: ["screen"], paths: ["fbt_layers/core_libs/lib/utz"], license: "MIT", texts: ["fbt_layers/core_libs/lib/utz/LICENSE"], upstream: "https://github.com/evq/utz", version: { file: "fbt_layers/core_libs/lib/utz/library.properties", read: (s) => /^version=(\S+)/m.exec(s)[1] } },
  { id: "furi", name: "Furi (the firmware's core library)", modules: ["runtime", "screen"], paths: ["fbt_layers/core_libs/lib/furi"], reuse: true, upstream: "https://github.com/flipperdevices/fbtng-corelibs" },
  { id: "datetime", name: "datetime (the firmware's core library)", modules: ["screen"], paths: ["fbt_layers/core_libs/lib/datetime"], reuse: true, upstream: "https://github.com/flipperdevices/fbtng-corelibs" },
  { id: "furi-hal-headers", name: "Furi HAL headers (fbtng)", modules: ["screen"], paths: ["fbt_layers/fbtng"], reuse: true, upstream: "https://github.com/flipperdevices/fbtng" },
  { id: "internal-images", name: "The firmware's internal images", modules: ["screen"], paths: ["native/screen-assets"], reuse: "assets/images/internal/image.png", source: "assets/images/internal", note: "Converted to C by the firmware's build and copied into packages/engine/native/screen-assets." },
]);

/**
 * Annotations of the firmware's REUSE.toml whose paths match no file, applied to the files they are meant for.
 * The busy_* fonts: their font files declare the SIL Open Font License 1.1, and REUSE.toml gives OFL-1.1 with the
 * copyright of Ark Pixel (TakWolf) and Flipper FZCO to assets/frontend/assets/fonts/ttf/busy_*.ttf and
 * assets/frontend/assets/fonts/busy_*.font, where there are none: the fonts lie in assets/frontend/assets/fonts and
 * assets/shared/fonts. Without the fix they would fall under assets/frontend/** (GPL) and assets/shared/** (CC BY-SA),
 * which their own files contradict. Decided for the summary by the default of the owner's license rules (review of
 * EMU-255, 11 Nov 2026); the firmware team is told. A fix whose annotation is gone, or that REUSE.toml already
 * applies, is reported, so it is removed once the firmware is corrected.
 */
export const REUSE_FIXES = Object.freeze([
  {
    files: /^assets\/(frontend\/assets|shared)\/fonts\/(ttf\/)?busy_[^/]+\.(ttf|font)$/,
    annotation: "assets/frontend/assets/fonts/ttf/busy_*.ttf",
    note: "The firmware's REUSE.toml gives the busy_* fonts OFL-1.1 (Ark Pixel by TakWolf, and Flipper FZCO) at paths that match no file (assets/frontend/assets/fonts/ttf/busy_*.ttf, assets/frontend/assets/fonts/busy_*.font); the fonts' own files declare the SIL Open Font License 1.1. This summary follows the font files.",
  },
]);

/**
 * The JavaScript libraries the firmware's local web is built with (EMU-161): every package its
 * assets/frontend/package.json names, as dependencies or devDependencies. The version each one resolves to is read
 * from the lockfile beside it (pnpm-lock.yaml) at the firmware's commit; what is written here by hand is the license
 * the package's own package.json declares at that version (checked on the npm registry on 11 Nov 2026) and its
 * upstream. refresh stops when the firmware names a package that is not here, or the lockfile resolves one to another
 * version than the one whose license was checked: look at its license again and change the entry.
 */
export const WEB_LICENSES = Object.freeze({
  "@busy-app/busy-lib": { version: "0.21.1", license: "MIT", upstream: "https://github.com/busy-app/busylib-ts" },
  "@iconify-json/ri": { version: "1.2.5", license: "Apache-2.0", upstream: "https://github.com/iconify/icon-sets" },
  "@nuxt/eslint": { version: "1.4.1", license: "MIT", upstream: "https://github.com/nuxt/eslint" },
  "@nuxt/ui": { version: "3.3.4", license: "MIT", upstream: "https://github.com/nuxt/ui" },
  "@nuxtjs/mdc": { version: "0.20.1", license: "MIT", upstream: "https://github.com/nuxt-content/mdc" },
  "@pinia/nuxt": { version: "0.10.1", license: "MIT", upstream: "https://github.com/vuejs/pinia" },
  "@stylistic/eslint-plugin": { version: "5.7.1", license: "MIT", upstream: "https://github.com/eslint-stylistic/eslint-stylistic" },
  eslint: { version: "9.35.0", license: "MIT", upstream: "https://github.com/eslint/eslint" },
  gifenc: { version: "1.0.3", license: "MIT", upstream: "https://github.com/mattdesl/gifenc" },
  "gifuct-js": { version: "2.1.2", license: "MIT", upstream: "https://github.com/matt-way/gifuct-js" },
  konva: { version: "10.2.5", license: "MIT", upstream: "https://github.com/konvajs/konva" },
  maska: { version: "3.2.0", license: "MIT", upstream: "https://github.com/beholdr/maska" },
  nuxt: { version: "3.19.2", license: "MIT", upstream: "https://github.com/nuxt/nuxt" },
  pinia: { version: "3.0.3", license: "MIT", upstream: "https://github.com/vuejs/pinia" },
  "pinia-plugin-persistedstate": { version: "4.5.0", license: "MIT", upstream: "https://github.com/prazdevs/pinia-plugin-persistedstate" },
  qr: { version: "0.5.4", license: "MIT OR Apache-2.0", upstream: "https://github.com/paulmillr/qr" },
  "tailwind-merge": { version: "3.3.1", license: "MIT", upstream: "https://github.com/dcastil/tailwind-merge" },
  tailwindcss: { version: "4.1.13", license: "MIT", upstream: "https://github.com/tailwindlabs/tailwindcss" },
  typescript: { version: "5.9.2", license: "Apache-2.0", upstream: "https://github.com/microsoft/TypeScript" },
  "vite-plugin-eslint2": { version: "5.0.4", license: "MIT", upstream: "https://github.com/ModyQyW/vite-plugin-eslint2" },
  vue: { version: "3.5.21", license: "MIT", upstream: "https://github.com/vuejs/core" },
  "vue-konva": { version: "3.4.0", license: "MIT", upstream: "https://github.com/konvajs/vue-konva" },
  "vue-router": { version: "4.5.1", license: "MIT", upstream: "https://github.com/vuejs/router" },
  "vue-tsc": { version: "3.3.9", license: "MIT", upstream: "https://github.com/vuejs/language-tools" },
  "worker-timers": { version: "8.0.30", license: "MIT", upstream: "https://github.com/chrisguttandin/worker-timers" },
});

/**
 * The packages a pnpm lockfile (version 9) resolves for the project at its root: name -> version, for the sections
 * given. Only what pnpm writes there is read: `importers:`, then `  .:`, then `    <section>:` and two-line entries
 * `      <name>:` / `        version: <version>(<peers>)`.
 */
export function pnpmRootVersions(text, sections = ["dependencies", "devDependencies"]) {
  const out = {};
  let inImporters = false;
  let inRoot = false;
  let section = null;
  let name = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inImporters = line === "importers:";
      inRoot = false;
      continue;
    }
    if (!inImporters) continue;
    let m;
    if ((m = /^ {2}(\S.*):$/.exec(line))) {
      inRoot = m[1] === "." || m[1] === "'.'";
      section = null;
    } else if (inRoot && (m = /^ {4}(\w+):$/.exec(line))) {
      section = sections.includes(m[1]) ? m[1] : null;
    } else if (inRoot && section && (m = /^ {6}(?:'([^']+)'|"([^"]+)"|([^\s:'"]+)):$/.exec(line))) {
      name = m[1] ?? m[2] ?? m[3];
    } else if (inRoot && section && name && (m = /^ {8}version: '?([^('\s]+)/.exec(line))) {
      out[name] = m[1];
      name = null;
    }
  }
  return out;
}

/** Folders build.mjs only adds to the include path: what is compiled from them is named by a deeper path. */
const INCLUDE_ROOTS = Object.freeze(["lib", "fbt_layers/core_libs/lib", "applications/main", "applications/system", "applications/services"]);

const EMSCRIPTEN_TEXTS = Object.freeze([
  { file: "upstream/emscripten/LICENSE", title: "Emscripten" },
  { file: "upstream/emscripten/system/lib/libc/musl/COPYRIGHT", title: "musl libc (Emscripten's C library)" },
  { file: "upstream/emscripten/system/lib/compiler-rt/LICENSE.TXT", title: "compiler-rt (LLVM)" },
]);

// ---------------------------------------------------------------- the firmware, read through git

function gitIn(repo, args, binary = false) {
  return execProgram("git", ["-C", repo, ...args], { encoding: binary ? "buffer" : "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
}

/** The submodules of a repository at a commit: path -> commit. */
function linksOf(repo, commit) {
  const links = new Map();
  for (const line of gitIn(repo, ["ls-tree", "-r", commit]).split("\n")) {
    const m = /^160000 commit ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m) links.set(m[2], m[1]);
  }
  return links;
}

class Firmware {
  constructor(repo, commit) {
    this.repo = repo;
    this.commit = commit;
    // Every submodule at this commit, nested ones too (core_libs holds mlib and utz), as a path of the firmware ->
    // { dir, commit }. Nested ones are read when a path inside their parent is first asked about.
    this.links = new Map([...linksOf(repo, commit)].map(([p, c]) => [p, { dir: path.join(repo, p), commit: c, nested: null }]));
    this.reuseCache = new Map();
  }

  /** The innermost submodule that holds a firmware path, or null (the firmware's own tree). */
  linkOf(p) {
    let best = null;
    for (;;) {
      let next = null;
      for (const sub of this.links.keys()) if ((p === sub || p.startsWith(`${sub}/`)) && sub.length > (best?.length ?? -1) && (!next || sub.length > next.length)) next = sub;
      if (!next) return best;
      best = next;
      const link = this.links.get(best);
      if (link.nested === null) {
        link.nested = [];
        for (const [rel, c] of linksOf(link.dir, link.commit)) {
          const full = `${best}/${rel}`;
          link.nested.push(full);
          this.links.set(full, { dir: path.join(link.dir, rel), commit: c, nested: null });
        }
      }
    }
  }

  /** Where a submodule's commit comes from: the commit its parent records. */
  commitOf(sub) {
    return sub ? this.links.get(sub).commit : this.commit;
  }

  /** A file of the firmware at this commit, through its submodules; null if it is not there. */
  read(p, binary = false) {
    const sub = this.linkOf(p);
    try {
      if (!sub) return gitIn(this.repo, ["show", `${this.commit}:${p}`], binary);
      const link = this.links.get(sub);
      return gitIn(link.dir, ["show", `${link.commit}:${p.slice(sub.length + 1)}`], binary);
    } catch {
      return null;
    }
  }

  /** git blob hash -> path of every file of the firmware's own tree under a folder. */
  blobs(folder) {
    const out = new Map();
    for (const line of gitIn(this.repo, ["ls-tree", "-r", this.commit, "--", folder]).split("\n")) {
      const m = /^100\d{3} blob ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (m && !out.has(m[1])) out.set(m[1], m[2]);
    }
    return out;
  }

  /**
   * What REUSE.toml says of a file: { license, copyright, root } (root: the submodule whose REUSE.toml it is; a
   * submodule without one says nothing, and its parent's REUSE.toml does not speak for it).
   */
  reuse(p) {
    const sub = this.linkOf(p);
    const root = sub ?? "";
    if (!this.reuseCache.has(root)) {
      const text = this.read(root ? `${root}/REUSE.toml` : "REUSE.toml");
      this.reuseCache.set(root, text ? parseReuse(text) : []);
    }
    const rel = sub ? p.slice(sub.length + 1) : p;
    let found = null;
    // The last annotation that names the file wins (REUSE 3.2, "Precedence" of REUSE.toml).
    for (const a of this.reuseCache.get(root)) if (a.paths.some((re) => re.test(rel))) found = a;
    const fix = root === "" ? REUSE_FIXES.find((f) => f.files.test(rel)) : null;
    if (fix) {
      const meant = this.reuseCache.get(root).find((a) => a.globs.includes(fix.annotation));
      if (!meant) throw new Error(`REUSE.toml no longer has the annotation ${fix.annotation} that REUSE_FIXES in refresh.mjs applies to ${p}: look at the fix again`);
      if (meant === found) throw new Error(`REUSE.toml now gives ${p} its license itself: remove the fix in REUSE_FIXES of refresh.mjs`);
      return { license: meant.license, copyright: meant.copyright, root, note: fix.note };
    }
    return found && { license: found.license, copyright: found.copyright, root };
  }
}

/** The [[annotations]] of a REUSE.toml: path globs, the license and the copyright. Only what REUSE.toml files use. */
export function parseReuse(text) {
  const blocks = text.split(/^\[\[annotations\]\]\s*$/m).slice(1);
  return blocks.map((block) => {
    const values = {};
    for (const m of block.matchAll(/^([A-Za-z-]+)\s*=\s*(\[[\s\S]*?\]|"(?:[^"\\]|\\.)*")/gm)) {
      const raw = m[2];
      values[m[1]] = raw.startsWith("[") ? [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => JSON.parse(`"${s[1]}"`)) : JSON.parse(raw);
    }
    const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
    if (!values.path || !values["SPDX-License-Identifier"]) throw new Error("a REUSE.toml annotation without path or license");
    return { globs: list(values.path), paths: list(values.path).map(reuseGlob), license: values["SPDX-License-Identifier"], copyright: list(values["SPDX-FileCopyrightText"]) };
  });
}

/** A REUSE.toml path: '*' within one folder, '**' across folders. */
export function reuseGlob(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "\\" && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A path build.mjs names is a file if its last part has an extension; a folder stands for a file in it. */
const sampleFile = (p) => (/\.[a-z0-9]+$/i.test(path.posix.basename(p)) ? p : `${p}/file.c`);

const blobHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

// ---------------------------------------------------------------- what gets recorded

/** The catalogue entry a firmware path of the build belongs to, or null. */
export function libraryOf(p, catalogue = CATALOGUE) {
  let best = null;
  let length = -1;
  for (const lib of catalogue) {
    if ((lib.via ?? []).includes(p) && p.length > length) {
      best = lib;
      length = p.length;
    }
    for (const owned of lib.paths) if ((p === owned || p.startsWith(`${owned}/`)) && owned.length > length) {
      best = lib;
      length = owned.length;
    }
  }
  return best;
}

const reuseLine = (r) => ({ license: r.license, copyright: r.copyright, ...(r.note ? { note: r.note } : {}) });

/** Whether a TrueType font's own name table says the SIL Open Font License (Windows UTF-16BE or Mac ASCII names). */
export function declaresOfl(bytes) {
  const words = "Open Font License";
  const be = Buffer.alloc(words.length * 2);
  for (let i = 0; i < words.length; i++) be.writeUInt16BE(words.charCodeAt(i), i * 2);
  return bytes.includes(be) || bytes.includes(Buffer.from(words, "latin1"));
}

function firmwareRecord(fw, { problems, textsWanted }) {
  const record = { commit: fw.commit, libraries: {}, compiled: {} };
  for (const lib of CATALOGUE) {
    const at = lib.paths.find((p) => !p.startsWith("native/")) ?? null;
    const sub = at ? fw.linkOf(at) : null;
    const entry = { commit: fw.commitOf(sub), in: sub ?? "the firmware's own tree" };
    if (lib.version) {
      const text = fw.read(lib.version.file);
      if (text === null) problems.push(`${fw.commit.slice(0, 8)}: ${lib.version.file} is not there (the version of ${lib.name})`);
      else entry.version = lib.version.read(text);
    }
    if (lib.reuse) {
      const r = fw.reuse(typeof lib.reuse === "string" ? lib.reuse : sampleFile(at));
      if (!r) problems.push(`${fw.commit.slice(0, 8)}: REUSE.toml says nothing of ${lib.name}`);
      else {
        Object.assign(entry, reuseLine(r));
        textsWanted.add(JSON.stringify({ spdx: r.license, root: r.root, fw: fw.commit }));
      }
      if (lib.source) entry.source = lib.source;
    } else {
      for (const t of lib.texts) if (fw.read(t) === null) problems.push(`${fw.commit.slice(0, 8)}: ${t} is not there (the license of ${lib.name})`);
    }
    record.libraries[lib.id] = entry;
  }
  // Every path the build takes, with its owner; the firmware's own code by what REUSE.toml says of it.
  const own = new Map();
  for (const p of firmwarePathsOfBuild()) {
    const lib = libraryOf(p);
    if (lib) {
      record.compiled[p] = lib.id;
      continue;
    }
    if (INCLUDE_ROOTS.includes(p)) {
      record.compiled[p] = "firmware (include path)";
      continue;
    }
    if (fw.linkOf(p)) {
      problems.push(`build.mjs takes ${p} from the firmware's submodule ${fw.linkOf(p)}, and no entry of the catalogue in refresh.mjs names it: add the library with its license`);
      continue;
    }
    const r = fw.reuse(sampleFile(p));
    if (!r || !r.copyright.some((c) => /Flipper FZCO/.test(c))) {
      problems.push(`build.mjs takes ${p}, which REUSE.toml does not give to Flipper FZCO (${r ? `${r.license}, ${r.copyright.join("; ")}` : "no annotation"}): add it to the catalogue in refresh.mjs`);
      continue;
    }
    own.set(JSON.stringify(reuseLine(r)), reuseLine(r));
    textsWanted.add(JSON.stringify({ spdx: r.license, root: r.root, fw: fw.commit }));
    record.compiled[p] = "firmware";
  }
  if (own.size !== 1) problems.push(`${fw.commit.slice(0, 8)}: the firmware's own code the build takes is under ${own.size} licenses; the summary expects one`);
  record.firmware = [...own.values()][0] ?? null;
  return record;
}

function webRecord(fw, info, { problems, textsWanted }) {
  const web = { from: info.web.from, tree: info.web.tree, files: info.web.files, source: "assets/frontend" };
  const r = fw.reuse(`${info.web.from}/index.html`);
  if (!r) problems.push(`${fw.commit.slice(0, 8)}: REUSE.toml says nothing of ${info.web.from}`);
  else {
    Object.assign(web, reuseLine(r));
    textsWanted.add(JSON.stringify({ spdx: r.license, root: r.root, fw: fw.commit }));
  }
  // The fonts of the web build are copies of the firmware's assets/frontend fonts: found by their bytes, licensed by
  // what REUSE.toml says of the original.
  const originals = fw.blobs("assets/frontend");
  web.fonts = [];
  const built = path.join(ENGINE_DIR, "build", info.version, "web");
  const walk = (dir, rel = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith("._")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), p);
      else if (/\.(ttf|otf|woff2?)$/i.test(e.name)) {
        const source = originals.get(blobHash(readFileSync(path.join(dir, e.name))));
        if (!source) {
          problems.push(`${info.version}: the font web/${p} is not a copy of a file in the firmware's assets/frontend`);
          continue;
        }
        const fr = fw.reuse(source);
        // A fix follows the font file: its own name table must say so.
        if (fr.note && /\.(ttf|otf)$/i.test(e.name) && !declaresOfl(readFileSync(path.join(dir, e.name)))) problems.push(`${info.version}: web/${p} is given OFL-1.1 by REUSE_FIXES, and its own name table does not say so`);
        web.fonts.push({ file: p, source, ...reuseLine(fr) });
        textsWanted.add(JSON.stringify({ spdx: fr.license, root: fr.root, fw: fw.commit }));
      }
    }
  };
  walk(built);
  web.dependencies = webDependencies(fw, info.version, problems);
  return web;
}

/**
 * The JavaScript libraries of the local web: every package assets/frontend/package.json names, with the section it is
 * in, the version pnpm-lock.yaml resolves it to and the license WEB_LICENSES records for that version.
 */
export function webDependencies(fw, label, problems, catalogue = WEB_LICENSES) {
  const pkg = fw.read("assets/frontend/package.json");
  const lock = fw.read("assets/frontend/pnpm-lock.yaml");
  if (pkg === null || lock === null) {
    problems.push(`${label}: assets/frontend/${pkg === null ? "package.json" : "pnpm-lock.yaml"} is not there`);
    return [];
  }
  const manifest = JSON.parse(pkg);
  const resolved = pnpmRootVersions(lock);
  const out = [];
  for (const kind of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(manifest[kind] ?? {}).sort()) {
      const version = resolved[name];
      const known = Object.hasOwn(catalogue, name) ? catalogue[name] : null;
      if (!version) problems.push(`${label}: assets/frontend/pnpm-lock.yaml resolves no version of ${name}`);
      else if (!known) problems.push(`${label}: the local web is built with ${name} ${version}, which WEB_LICENSES in refresh.mjs does not name: add it with the license its package.json declares`);
      else if (known.version !== version) problems.push(`${label}: the local web is built with ${name} ${version}; WEB_LICENSES in refresh.mjs checked the license of ${known.version}: look at it again`);
      if (version && known) out.push({ name, kind, version, license: known.license, upstream: known.upstream });
    }
  }
  return out;
}

/** build/apps-assets: grouped by the license REUSE.toml gives the firmware file each asset is made from. */
function assetsRecord(fw, { problems, textsWanted }) {
  const manifest = JSON.parse(readFileSync(path.join(ENGINE_DIR, "apps-assets.json"), "utf8"));
  if (manifest.firmware.commit !== fw.commit) problems.push(`apps-assets.json names firmware ${manifest.firmware.commit.slice(0, 8)}, the default firmware is ${fw.commit.slice(0, 8)}`);
  const groups = new Map();
  for (const [file, entry] of Object.entries(manifest.files)) {
    const r = fw.reuse(entry.source);
    if (!r) {
      problems.push(`REUSE.toml says nothing of ${entry.source}, which build/apps-assets/${file} is made from`);
      continue;
    }
    textsWanted.add(JSON.stringify({ spdx: r.license, root: r.root, fw: fw.commit }));
    const key = JSON.stringify(reuseLine(r));
    if (!groups.has(key)) groups.set(key, { ...reuseLine(r), files: 0, sources: new Set() });
    const g = groups.get(key);
    g.files++;
    g.sources.add(entry.source.split("/").slice(0, 3).join("/"));
  }
  return [...groups.values()].sort((a, b) => b.files - a.files || (a.license < b.license ? -1 : 1)).map((g) => ({ ...g, sources: [...g.sources].sort() }));
}

/** Files of the emulator's own tree that are copies of the firmware's files, found by their bytes. */
function copiesRecord(fw, { textsWanted }) {
  const originals = fw.blobs("assets");
  // A font is a copy of a font of assets/frontend, as the fonts of the built local web are (webRecord): the built
  // local web in the firmware's tree holds the same bytes under the license of the firmware's own code, and the
  // font's license is the one REUSE.toml gives the original.
  const fonts = fw.blobs("assets/frontend");
  const out = [];
  const list = gitIn(EMULATOR_DIR, ["ls-files", "-z", "--", "packages/server", "packages/engine/native"]).split("\0").filter(Boolean);
  for (const f of list.sort()) {
    if (/\.(m?js|c|h|json|md|css|html)$/.test(f)) continue;
    const hash = blobHash(readFileSync(path.join(EMULATOR_DIR, f)));
    const source = (/\.(ttf|otf|woff2?)$/i.test(f) && fonts.get(hash)) || originals.get(hash);
    if (!source) continue;
    const r = fw.reuse(source);
    textsWanted.add(JSON.stringify({ spdx: r.license, root: r.root, fw: fw.commit }));
    out.push({ file: f, source, ...reuseLine(r) });
  }
  return out;
}

/**
 * Everything refresh writes: { "libraries.json": text, "texts/<name>.txt": text, ... }, and the problems found. A
 * problem leaves the files as they are.
 */
export function collect({ firmwareRepo, emsdk }) {
  const problems = [];
  const textsWanted = new Set();
  const config = JSON.parse(readFileSync(path.join(ENGINE_DIR, "firmware.json"), "utf8"));
  const out = { firmwareRepository: "https://github.com/busy-app/busybar-firmware", default: config.default, firmware: {} };
  const firmware = {};
  for (const [v, { commit }] of Object.entries(config.versions)) {
    const info = JSON.parse(readFileSync(path.join(ENGINE_DIR, "build", v, "build-info.json"), "utf8"));
    if (info.commit !== commit) problems.push(`build/${v}/build-info.json says commit ${info.commit}, firmware.json ${commit}`);
    const fw = new Firmware(firmwareRepo, commit);
    firmware[v] = fw;
    const record = firmwareRecord(fw, { problems, textsWanted });
    // The modules were built from these: the commits build-info.json records must be the ones read here.
    if (record.libraries.jerryscript.commit !== info.jerryscript) problems.push(`${v}: build-info.json says JerryScript ${info.jerryscript}, the firmware ${record.libraries.jerryscript.commit}`);
    if (record.libraries.lvgl.commit !== info.lvgl) problems.push(`${v}: build-info.json says LVGL ${info.lvgl}, the firmware ${record.libraries.lvgl.commit}`);
    record.web = webRecord(fw, { ...info, version: v }, { problems, textsWanted });
    out.firmware[v] = record;
  }
  const fw = firmware[config.default];
  out.assets = assetsRecord(fw, { problems, textsWanted });
  out.copies = copiesRecord(fw, { problems, textsWanted });

  // The SDK: the modules hold its C library and the compiler's runtime.
  const sdkVersion = existsSync(path.join(emsdk, "upstream/emscripten/emscripten-version.txt")) ? JSON.parse(readFileSync(path.join(emsdk, "upstream/emscripten/emscripten-version.txt"), "utf8")) : null;
  if (sdkVersion !== config.emscripten) problems.push(`the Emscripten SDK at --emsdk is ${sdkVersion ?? "not there"}, firmware.json names ${config.emscripten}`);
  out.emscripten = { version: config.emscripten, license: "MIT OR NCSA", upstream: "https://github.com/emscripten-core/emscripten", parts: EMSCRIPTEN_TEXTS.map((t) => t.title) };

  const files = {};
  const texts = {};
  if (sdkVersion === config.emscripten) {
    texts["emscripten.txt"] = EMSCRIPTEN_TEXTS.map((t) => `----- ${t.title} -----\n\n${readFileSync(path.join(emsdk, t.file), "utf8").trimEnd()}\n`).join("\n");
  }
  // A third-party library's own license files, from the default firmware; another firmware with other texts stops.
  for (const lib of CATALOGUE.filter((l) => !l.reuse)) {
    const text = (f) => lib.texts.map((t) => f.read(t)?.trimEnd() ?? "").join("\n\n") + "\n";
    const name = `${lib.id}.txt`;
    texts[name] = text(fw);
    for (const [v, other] of Object.entries(firmware)) if (text(other) !== texts[name]) problems.push(`${v}: the license of ${lib.name} differs from the default firmware's; the summary carries one text`);
  }
  // The licenses REUSE.toml names, from the LICENSES folder beside each REUSE.toml; one text per license.
  for (const wanted of [...textsWanted].sort()) {
    const { spdx, root, fw: commit } = JSON.parse(wanted);
    const f = Object.values(firmware).find((x) => x.commit === commit);
    const t = f.read(root ? `${root}/LICENSES/${spdx}.txt` : `LICENSES/${spdx}.txt`);
    if (t === null) {
      problems.push(`${commit.slice(0, 8)}: ${root ? `${root}/` : ""}LICENSES/${spdx}.txt is not there`);
      continue;
    }
    const name = `${spdx}.txt`;
    const body = `${t.trimEnd()}\n`;
    if (texts[name] !== undefined && texts[name] !== body) problems.push(`two texts of ${spdx} in the firmware differ (${root || "the firmware's root"})`);
    texts[name] = body;
  }
  out.libraries = CATALOGUE.map((lib) => {
    const { paths, via, texts: _texts, version: _version, reuse, ...rest } = lib;
    return { ...rest, paths, ...(via ? { via } : {}), ...(reuse ? {} : { text: `${lib.id}.txt` }) };
  });
  out.texts = Object.keys(texts).sort();
  const header = {
    $comment: "Written by tools/notices/refresh.mjs from the firmware checkout and the Emscripten SDK; do not edit. What the app's license summary (tools/notices/notices.mjs) says about the firmware inside the emulator: for each firmware build, the commits and versions of the libraries compiled into its modules, every path the engine's build takes and whose it is, the local web and its fonts; the licenses of the app assets and of the copies of firmware files; the license texts in texts/.",
  };
  files["libraries.json"] = `${JSON.stringify({ ...header, ...out }, null, 2)}\n`;
  for (const [name, body] of Object.entries(texts)) files[`texts/${name}`] = body;
  return { files, problems };
}

async function main(argv) {
  const args = [...argv];
  const take = (name) => {
    const at = args.indexOf(name);
    if (at < 0) return null;
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
    args.splice(at, 2);
    return value;
  };
  const firmwareRepo = path.resolve(take("--firmware-repo") ?? process.env.EMU_FIRMWARE_REPO ?? path.join(EMULATOR_DIR, "..", "busybar-firmware"));
  const emsdk = path.resolve(take("--emsdk") ?? process.env.EMSDK ?? path.join(EMULATOR_DIR, "..", "..", "emsdk"));
  const check = args.includes("--check");
  const unknown = args.filter((a) => a !== "--check");
  if (unknown.length) {
    console.error(`refresh.mjs: unknown option ${unknown[0]}. Usage: node tools/notices/refresh.mjs [--firmware-repo <path>] [--emsdk <path>] [--check]`);
    return 2;
  }
  if (!existsSync(path.join(firmwareRepo, ".git"))) {
    console.error("refresh.mjs: no firmware checkout there: give --firmware-repo <path> (or EMU_FIRMWARE_REPO)");
    return 2;
  }
  const { files, problems } = collect({ firmwareRepo, emsdk });
  if (problems.length) {
    console.error(`refresh.mjs: ${problems.length} problem(s), nothing written:\n  ${problems.join("\n  ")}`);
    return 1;
  }
  const current = {};
  if (existsSync(LIBRARIES_FILE)) current["libraries.json"] = readFileSync(LIBRARIES_FILE, "utf8");
  if (existsSync(TEXTS_DIR)) for (const n of readdirSync(TEXTS_DIR).filter((n) => !n.startsWith("."))) current[`texts/${n}`] = readFileSync(path.join(TEXTS_DIR, n), "utf8");
  const differ = [...new Set([...Object.keys(files), ...Object.keys(current)])].filter((n) => files[n] !== current[n]).sort();
  if (check) {
    if (differ.length) {
      console.error(`refresh.mjs --check: these differ from what the firmware says; run refresh.mjs:\n  ${differ.join("\n  ")}`);
      return 1;
    }
    console.log(`refresh.mjs --check: ${Object.keys(files).length} files as the firmware says`);
    return 0;
  }
  rmSync(TEXTS_DIR, { recursive: true, force: true });
  mkdirSync(TEXTS_DIR, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(HERE, ...name.split("/")), body);
  console.log(`refresh.mjs: wrote ${Object.keys(files).length} files${differ.length ? `; changed: ${differ.join(", ")}` : ", nothing changed"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(`refresh.mjs: ${e.message}`);
      process.exitCode = 1;
    },
  );
}
