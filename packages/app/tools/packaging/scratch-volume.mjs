// A scratch volume on macOS: a sparse disk image, attached out of sight of the Finder, removed whole afterwards. For
// an app of a notarized release whose programs a check runs: once code of a notarized app has run, macOS's App
// Management protection keeps every process of another team (a check started from a terminal) from changing or
// removing the bundle, so an app unpacked into a plain folder could not be cleaned up. On a volume of its own it goes
// with the image.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const hdiutil = (args) => execFileSync("/usr/bin/hdiutil", args, { stdio: ["ignore", "pipe", "pipe"] });

/**
 * Makes and attaches a sparse APFS image in `parent`; `mount` is where it is attached (a folder in `parent`).
 * `remove()` detaches it (by force if a process still holds it) and deletes the image and the mount point.
 * @returns {{ mount: string, remove: () => void }}
 */
export function attachScratchVolume(parent, { name = "scratch", size = "4g" } = {}) {
  const image = path.join(parent, `${name}.sparseimage`);
  const mount = path.join(parent, `${name}-volume`);
  mkdirSync(mount, { recursive: true });
  hdiutil(["create", "-quiet", "-size", size, "-type", "SPARSE", "-fs", "APFS", "-volname", name, path.join(parent, name)]);
  try {
    hdiutil(["attach", "-quiet", "-nobrowse", "-noautoopen", "-mountpoint", mount, image]);
  } catch (e) {
    rmSync(image, { force: true });
    throw e;
  }
  let removed = false;
  return {
    mount,
    remove() {
      if (removed) return;
      removed = true;
      try {
        hdiutil(["detach", "-quiet", mount]);
      } catch {
        hdiutil(["detach", "-quiet", "-force", mount]);
      }
      rmSync(image, { force: true });
      rmSync(mount, { recursive: true, force: true });
    },
  };
}
