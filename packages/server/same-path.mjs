// Whether two paths are one: one place for what the project lists, the trusted folders, the removal of a project and
// the command line used to say each in a copy of its own (the codebase audit of 11.11).
import { realpathSync } from "node:fs";
import path from "node:path";

/** The paths as written: equal, letter case aside on Windows (where it does not tell names apart). */
export function samePath(a, b, platform = process.platform) {
  if (platform === "win32") return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
  return a === b;
}

/** The same file: by real path where it can be told (a link, 8.3 names), else by the path as written. */
export function sameRealPath(a, b, platform = process.platform) {
  const real = (file) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  };
  return samePath(real(a), real(b), platform);
}
