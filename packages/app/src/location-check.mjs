// macOS runs an app opened straight from a disk image or from Downloads out of a random read-only path (App
// Translocation). From there the path of the command line would change on every launch, so the shell asks to move the
// app first (ADR-0002, section 5).
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";

/** The folder of the app: "/x/Name.app" for "/x/Name.app/Contents/MacOS/Name", otherwise the executable's folder. */
export function bundlePathOf(exePath) {
  const parts = exePath.split("/");
  const at = parts.findIndex((part) => part.endsWith(".app"));
  return at > 0 ? parts.slice(0, at + 1).join("/") : path.posix.dirname(exePath);
}

/** True when the path is on a volume mounted read-only, as a disk image and a translocated app are. */
export function onReadOnlyVolume(target) {
  try {
    accessSync(target, constants.W_OK);
    return false;
  } catch (e) {
    return e?.code === "EROFS";
  }
}

function real(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * @returns {{ ok: true } | { ok: false, reason: "translocated" | "read-only-volume" | "downloads", path: string }}
 */
export function checkAppLocation({ platform, bundlePath, homeDir, readOnly = onReadOnlyVolume, realpath = real }) {
  if (platform !== "darwin") return { ok: true };
  const place = realpath(bundlePath);
  const refuse = (reason) => ({ ok: false, reason, path: bundlePath });
  if (place.split("/").includes("AppTranslocation")) return refuse("translocated");
  if (readOnly(place)) return refuse("read-only-volume");
  const downloads = realpath(path.posix.join(homeDir, "Downloads"));
  if (place === downloads || place.startsWith(downloads + "/")) return refuse("downloads");
  return { ok: true };
}
