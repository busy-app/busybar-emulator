// Create app's Open existing (actions.mjs `projects.find`): from what the person chose in the system's dialog, a
// folder or any file in it, the app project it belongs to. The walk goes up from there to the nearest folder that is a
// project of BUSY's official tools, as the command line reads one (packages/server/projects/node-tools.mjs
// readProject: a package.json that names @busy-app/cli; a test holds the two to the same answer), and reads the app's
// name and id from its manifest where the template keeps it (src/appmeta/manifest.json, or appmeta/ at the top).
//
// The rules:
//   - the walk starts at the real path of the choice (links followed), from the folder a file is in;
//   - it never looks at the home folder or above it when the choice is inside the home folder, and never at the root
//     of a disk; a folder inside node_modules is never the project (a package of the project's own);
//   - the package.json and the manifest are read only when they are inside their folder by their real paths
//     (path-boundary.mjs): one that is a link to a file elsewhere is refused, and the walk stops there;
//   - a folder with an app's manifest but no such package.json (a built app, a project of other tools) is told as
//     that when nothing better is found above it.
//
// Pure but for the file system it reads: tested on plain Node (test/unit/project-root.test.mjs).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { insideRoots, realOrNull, samePath, within } from "./path-boundary.mjs";

/** The package of the official command line in a project (node-tools.mjs BUSY_CLI_PACKAGE). */
export const BUSY_CLI_PACKAGE = "@busy-app/cli";
/** How many folders up the walk looks at most. */
export const MAX_LEVELS = 48;
/** A package.json or a manifest larger than this is no project's. */
const MAX_FILE = 256 * 1024;
const MANIFESTS = [path.join("src", "appmeta", "manifest.json"), path.join("appmeta", "manifest.json")];

const flavour = (platform) => (platform === "win32" ? path.win32 : path.posix);

function isFolder(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** A JSON file inside `folder` by its real path: { value } | { missing } | { outside } | { unreadable }. */
function jsonIn(folder, relative, platform) {
  const p = flavour(platform);
  const file = p.join(folder, relative);
  if (realOrNull(file) === null) return { missing: true };
  if (insideRoots(file, [folder], { rootItself: false, platform }) === null) return { outside: true, file };
  try {
    if (statSync(file).size > MAX_FILE) return { unreadable: true };
    return { value: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { unreadable: true };
  }
}

/** Whether a package.json names the official command line among its dependencies (readProject's rule). */
export function namesBusyCli(manifest) {
  return [manifest?.dependencies, manifest?.devDependencies].some((deps) => deps && typeof deps === "object" && Object.hasOwn(deps, BUSY_CLI_PACKAGE));
}

/** The app's manifest of a folder: { id, name } | { outside: file } | null when it has none. */
function appManifest(folder, platform) {
  for (const relative of MANIFESTS) {
    const read = jsonIn(folder, relative, platform);
    if (read.outside) return { outside: read.file };
    if (read.value && typeof read.value === "object") return { id: typeof read.value.id === "string" ? read.value.id : null, name: typeof read.value.name === "string" ? read.value.name : null };
  }
  return null;
}

/**
 * The project the person's choice belongs to.
 * @param {string} chosen  a folder or a file, absolute, as the system's dialog gave it
 * @param {object} [o]
 * @param {string | null} [o.home]
 * @param {string} [o.platform]
 * @returns {{ found: true, folder: string, id: string | null, name: string | null, start: string }
 *   | { found: false, start: string | null, message: string, manifestOnly?: string }}
 */
export function findProjectRoot(chosen, { home = null, platform = process.platform } = {}) {
  const p = flavour(platform);
  const none = (message, more = {}) => ({ found: false, start: null, message, ...more });
  if (typeof chosen !== "string" || !p.isAbsolute(chosen)) return none("Choose a folder or a file on this computer.");
  const real = realOrNull(chosen);
  if (real === null) return none(`${chosen} is not there.`);
  const start = isFolder(real) ? real : p.dirname(real);
  const realHome = home ? (realOrNull(home) ?? home) : null;
  // Inside the home folder the walk ends below it; elsewhere (another disk, a share) below the disk's root.
  const ceiling = realHome && within(start, realHome, platform) ? realHome : p.parse(start).root;
  const nothing = { found: false, start, message: "No BUSY app found in this folder or above it." };
  let manifestOnly = null;
  let dir = start;
  for (let level = 0; level < MAX_LEVELS; level++) {
    if (samePath(dir, ceiling, platform) || !within(dir, ceiling, platform)) break;
    const insidePackages = dir.split(/[\\/]+/).includes("node_modules");
    if (!insidePackages) {
      const read = jsonIn(dir, "package.json", platform);
      if (read.outside) return { ...nothing, message: `The package.json in ${dir} is a link to a file outside that folder, so it is not opened.` };
      if (read.value && namesBusyCli(read.value)) {
        const app = appManifest(dir, platform);
        if (app?.outside) return { ...nothing, message: `The app's manifest in ${dir} is a link to a file outside that folder, so it is not opened.` };
        return { found: true, folder: dir, id: app?.id ?? null, name: app?.name ?? null, start };
      }
      if (!manifestOnly) {
        const app = appManifest(dir, platform);
        if (app && !app.outside) manifestOnly = dir;
      }
    }
    const up = p.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (manifestOnly) return { ...nothing, manifestOnly, message: `${manifestOnly} has an app's manifest, but no package.json that names ${BUSY_CLI_PACKAGE}: the emulator opens projects made with BUSY's tools.` };
  return nothing;
}
