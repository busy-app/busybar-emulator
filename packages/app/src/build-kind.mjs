// Release, test variant or development: decided by a marker inside the app's archive, not by app.isPackaged, which
// looks only at the name of the executable (ADR-0016). A renamed release stays a release.
//
//   build.json   { "kind": "release" | "test", "version": "0.1.0", "node": "24.22.2" }
//
// The packaging writes it into the app's folder (inside app.asar) and the same file into the resources folder beside
// it, where the command line, which runs on plain Node and cannot read the archive, finds it (tools/stage-resources.mjs).
// The source tree has no marker. Without a marker only the source tree is development: whatever goes wrong with the
// marker, the result is the stricter build. The marker is not a security boundary: whoever can change it can change
// the code beside it.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const BUILD_MARKER = "build.json";
export const KINDS = Object.freeze(["release", "test", "development"]);

/** The marker in a folder: the parsed file, null when there is none, or { invalid } when it cannot be used. */
export function readBuildMarker(folder, read = readFileSync) {
  let text;
  try {
    text = read(path.join(folder, BUILD_MARKER), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    return { invalid: e?.code ?? String(e) };
  }
  try {
    const marker = JSON.parse(text);
    if (marker && (marker.kind === "release" || marker.kind === "test")) return marker;
    return { invalid: `unknown kind ${JSON.stringify(marker?.kind)}` };
  } catch (e) {
    return { invalid: e.message };
  }
}

/**
 * True when the app runs from its source tree: packages/app with packages/server beside it, as in the repository. A
 * packaged app has neither (its folder is resources/app or resources/app.asar, the server lies in
 * resources/emulator/packages/server).
 */
export function inSourceTree(appDir, exists = existsSync) {
  return path.basename(path.dirname(appDir)) === "packages" && !/\.asar$/i.test(appDir) && exists(path.join(appDir, "..", "server", "cli", "busy-emulator.mjs"));
}

/**
 * One rule for the shell and the command line (packages/server/cli/context.mjs): whatever is unclear makes a release.
 * A marker says release or test; a marker that says anything else, or cannot be read, makes a release; without a
 * marker only a run from the source tree is development, any other app is a release.
 * @param {object} o
 * @param {object | null} o.marker      readBuildMarker(appDir)
 * @param {boolean} o.sourceTree        inSourceTree(appDir)
 * @returns {"release" | "test" | "development"}
 */
export function buildKindOf({ marker, sourceTree }) {
  if (marker && !marker.invalid) return marker.kind;
  if (marker?.invalid) return "release";
  return sourceTree ? "development" : "release";
}
