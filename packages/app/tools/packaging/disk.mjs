// Free space for a build (the release dry run, 11.11): on a nearly full disk hdiutil wrote a truncated disk image and
// still ended with 0, and so did the build. A macOS build now starts only with room enough (dist.mjs), and every disk
// image is verified once it is made (macos.mjs dmgApp). npm run release asks for the same room (tools/release).
import { existsSync, statfsSync } from "node:fs";
import path from "node:path";

/** What a release needs while it builds: both macOS targets, their zips and disk images, the work folders. */
export const MIN_FREE_GB = 6;
/** What the test variant of one target needs: the app as built and its copy, no zip, no disk image. */
export const MIN_FREE_GB_TEST = 2;

/** The nearest folder of `dir` that exists: the build's output folder may not be there yet. */
function existing(dir) {
  let at = path.resolve(dir);
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

/** Gigabytes (10^9 bytes) free for this user on the disk of `dir`. */
export function freeGigabytes(dir, { statfs = statfsSync } = {}) {
  const free = statfs(existing(dir));
  return (Number(free.bavail) * Number(free.bsize)) / 1e9;
}

/** Throws, with how much is free and how much is needed, when the disk of `dir` has less than `minimum` GB free. */
export function requireFreeSpace(dir, { minimum, what, statfs = statfsSync } = {}) {
  const gb = freeGigabytes(dir, { statfs });
  if (gb < minimum) {
    throw new Error(`Only ${gb.toFixed(1)} GB free on the disk of ${dir}; ${what} needs about ${minimum} GB while it builds. Free some space, then build again: on a full disk hdiutil writes a broken disk image.`);
  }
  return gb;
}
