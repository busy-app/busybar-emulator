// The files of a release (ADR-0002, section 3): the same names from release to release, so that the address of the
// latest one never changes. No version number is in a name; the version is inside the app.
export const PREFIX = "busybar-emulator";
export const SUMS_FILE = "SHA256SUMS";

/**
 * What each build target makes. macOS has two: Apple Silicon and Intel, each with an Electron and a Node of its own
 * architecture; the rest of the app is the same (the engine is WebAssembly, the app has no native module).
 */
export const RELEASE_FILES = Object.freeze({
  "darwin-arm64": Object.freeze([`${PREFIX}-mac-arm64.dmg`, `${PREFIX}-mac-arm64.zip`]),
  "darwin-x64": Object.freeze([`${PREFIX}-mac-x64.dmg`, `${PREFIX}-mac-x64.zip`]),
  "win32-x64": Object.freeze([`${PREFIX}-win-x64-setup.exe`]),
});
export const DIST_TARGETS = Object.freeze(Object.keys(RELEASE_FILES));

/**
 * The targets a system builds. A Mac builds both of macOS, whichever it is itself: Electron and Node for the other
 * architecture are downloaded and checked against their sums, and the ad-hoc signature needs no program of that
 * architecture to run. Windows builds its own.
 */
export function targetsBuiltOn(host = targetOfHost()) {
  if (host.startsWith("darwin-")) return DIST_TARGETS.filter((target) => target.startsWith("darwin-"));
  return DIST_TARGETS.includes(host) ? [host] : [];
}

/** The target a release file is of, by its name; null for SHA256SUMS and for a name that is no file of a release. */
export function targetOfFile(name) {
  return DIST_TARGETS.find((target) => RELEASE_FILES[target].includes(name)) ?? null;
}

/** Every file of a release, SHA256SUMS last. */
export const ALL_RELEASE_FILES = Object.freeze([...DIST_TARGETS.flatMap((target) => RELEASE_FILES[target]).sort(), SUMS_FILE]);

/** The app as it lies on the disk once installed: the bundle on macOS, the executable on Windows. */
export const APP_BUNDLE = "BUSY Bar Emulator.app";
export const WINDOWS_EXE = "BUSY Bar Emulator.exe";
/** The folder setup.exe puts the app in, under %LOCALAPPDATA% (the place per-user programs go on Windows). */
export const WINDOWS_INSTALL_FOLDER = ["Programs", "BUSY Bar Emulator"];

export function targetOfHost(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}
