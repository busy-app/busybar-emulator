// A packaged app laid out in a temporary folder, as tools/stage-resources.mjs lays it out for the packaging: the
// bundled Node, the command line's entry, the marker, emulator/ by the same list a release is copied by
// (emulatorFiles(), here of the working tree), and the app's own files unpacked in resources/app. The folders on the
// way have spaces, quotes and letters outside Latin in their names, as a user's may.
//
// The Node archive comes from the cache (BUSY_EMULATOR_NODE_CACHE, or the build's default cache outside the
// repository); a missing one is downloaded from nodejs.org and checked against the pin, as at build time.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { defaultCacheDir, readPin } from "../../tools/bundled-node.mjs";
import { APP_DIR, EMULATOR_DIR, git, workingFiles } from "../../tools/packaging/composition.mjs";
import { stageResources } from "../../tools/stage-resources.mjs";

export const HARD_NAME = "Φάκελος with 'quotes' フォルダ";
export const TARGET = `${process.platform}-${process.arch}`;
export const PIN = readPin();
export const NODE_CACHE = path.resolve(process.env.BUSY_EMULATOR_NODE_CACHE || defaultCacheDir());
// The tests write nothing into the source tree: a cache named relative to it (a "~" the shell did not expand) is refused.
// The tree is git's top folder: the monorepo's, or the public repository's, whose parent may well hold the cache (a
// clone in the home folder, the cache in ~/Library/Caches or %LOCALAPPDATA%).
const REPOSITORY = (() => {
  try {
    return path.resolve(git(["rev-parse", "--show-toplevel"], APP_DIR).trim());
  } catch {
    return EMULATOR_DIR; // not a git checkout: the tree is the emulator's folder
  }
})();
if (NODE_CACHE === REPOSITORY || NODE_CACHE.startsWith(REPOSITORY + path.sep)) {
  throw new Error(`BUSY_EMULATOR_NODE_CACHE lies inside the repository (${NODE_CACHE}); name a folder outside it.`);
}

/** Where the resources folder of an app lies inside `place`, as the packaging names it on this system. */
export function resourcesIn(place) {
  return process.platform === "win32"
    ? path.join(place, "BUSY Bar Emulator", "resources")
    : path.join(place, "BUSY Bar Emulator.app", "Contents", "Resources");
}

/**
 * Lays out an app inside <folder>/<HARD_NAME>/.
 * @returns {Promise<{ place: string, resources: string, appDir: string, node: string, launcher: string, cli: string }>}
 */
export async function layOutApp(folder, { kind = "test", windowsLauncher = null } = {}) {
  const place = path.join(folder, HARD_NAME);
  const resources = resourcesIn(place);
  mkdirSync(resources, { recursive: true });
  const staged = await stageResources({ target: TARGET, resourcesDir: resources, kind, cacheDir: NODE_CACHE, appFolder: true, windowsLauncher, list: workingFiles });
  return { place, resources, appDir: staged.app, node: staged.node.node, launcher: staged.launcher, cli: path.join(staged.cli, "busy-emulator.mjs") };
}

export const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
