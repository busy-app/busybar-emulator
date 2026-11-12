// What the engine's build (packages/engine/build.mjs) takes from the firmware into the WebAssembly modules: every
// firmware path it compiles, includes or copies, read from the build script's text. The license summary
// (notices.mjs) must name a library for each of them, and refresh.mjs records them in libraries.json; a test compares
// that record with this reading, so a library added to the build without a notice fails the test.
//
// The script is read, not run: it builds when imported. What it names is a call join(<folder>, "<path>"...) with a
// folder variable of the firmware (fw, furi, services, ...), and the LVGL source folders it lists in lvglDirs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "engine");

/**
 * The folders build.mjs names by a variable, as paths in the firmware ("" is its root). `native` is the emulator's
 * own code, kept as native/...; `gen` holds copies the build makes of firmware files (Furi's headers, LVGL's patched
 * bin decoder, lv_conf.h).
 */
export const FOLDERS = Object.freeze({
  fw: "",
  furi: "fbt_layers/core_libs/lib/furi",
  services: "applications/services",
  jsRunner: "applications/services/js_runner",
  amalgam: "lib/jerryscript/amalgam",
  lvgl: "lib/lvgl",
  addons: "lib/lvgl_addons",
  gui: "applications/services/gui",
  native: "native",
});

/** What the build's own copies in `gen` are copies of. */
const GENERATED = Object.freeze({
  furi: "fbt_layers/core_libs/lib/furi",
  "lv_bin_decoder_patched.c": "lib/lvgl/src/libs/bin_decoder/lv_bin_decoder.c",
  "lv_conf.h": "targets/f21/config/lv_conf.h",
});

/** Folders build.mjs joins that are not the firmware's: its own output, the work folders, the compiler. */
const NOT_FIRMWARE = new Set(["here", "out", "dest", "dir", "from", "to", "emsdk", "firmwareRepo", "src", "staging", "objDir", "work", "repo"]);

/**
 * The firmware paths build.mjs uses, sorted and without duplicates: "lib/cjson/cJSON.c", "lib/toolbox" (a folder:
 * every file of it the build may take), "native/screen-assets" (the emulator's own folder of firmware images).
 * Paths of the emulator's other own code (native/*.c, native/include) are left out. Throws on a folder variable it
 * does not know, so that a new one is looked at rather than passed over.
 */
export function firmwarePathsOfBuild(source = readFileSync(path.join(ENGINE_DIR, "build.mjs"), "utf8")) {
  const constants = {};
  for (const m of source.matchAll(/^const ([A-Z_]+) = "([^"]+)";/gm)) constants[m[1]] = m[2];
  const found = new Set();
  const add = (p) => {
    const clean = path.posix.normalize(p).replace(/\/+$/, "");
    if (clean.startsWith("..")) throw new Error(`build.mjs names a path outside the firmware: ${p}`);
    found.add(clean);
  };
  for (const m of source.matchAll(/\bjoin\((\w+),\s*(?:(["`])([^"`]*?)(?:\$\{|\2)|([A-Z_]+)\b|(\w+))/g)) {
    const [, folder, , literal, constant, other] = m;
    if (NOT_FIRMWARE.has(folder)) continue;
    if (folder === "gen") {
      const first = (literal ?? "").split("/")[0];
      if (first === "patched") continue; // gen/patched/<path>: a patched copy of a source the build lists by its own path
      const copy = GENERATED[first];
      if (copy === undefined) throw new Error(`build.mjs joins gen with ${JSON.stringify(literal ?? constant ?? other)}, a copy this reading does not know`);
      add(first === "furi" ? path.posix.join(copy, (literal ?? "").slice("furi".length)) : copy);
      continue;
    }
    if (!(folder in FOLDERS)) throw new Error(`build.mjs joins a folder this reading does not know: ${folder}`);
    const base = FOLDERS[folder];
    let rest;
    if (literal !== undefined) rest = literal;
    else if (constant !== undefined) {
      if (!(constant in constants)) throw new Error(`build.mjs joins ${folder} with ${constant}, which is not a string constant`);
      rest = constants[constant];
    } else rest = ""; // join(lvgl, d): somewhere in the folder itself
    const full = path.posix.join(base || ".", rest);
    if (folder === "native" && !full.startsWith("native/screen-assets")) continue;
    add(full);
  }
  // The LVGL source folders the build compiles: the list lib/lvgl.scons globs, written out in build.mjs.
  const dirs = /const lvglDirs = \[([\s\S]*?)\];/.exec(source);
  if (!dirs) throw new Error("build.mjs has no lvglDirs list");
  for (const m of dirs[1].matchAll(/"([^"]+)"/g)) add(path.posix.join("lib/lvgl", m[1]));
  return [...found].sort();
}
