// Where the command line is and what it works with: its own copy of the app, the user's data folder, the mirror of
// the emulator's state. Pure: the caller passes the environment, the system and the script's path in.
//
// The command line lies inside the app at <resources>/emulator/packages/server/cli/busy-emulator.mjs and runs on the
// Node at <resources>/node. The resources folder holds build.json (the copy of the marker inside the app's archive,
// written by the packaging) — it says release or test variant. The rule is the shell's (packages/app/src/
// build-kind.mjs): whatever is unclear makes a release; a development run is only a run from the source tree, told
// by the tree itself (packages/app beside packages/server, no bundled Node). As in the shell, a release reads no
// BUSY_EMULATOR_* variable except BUSY_EMULATOR_CLI_PATH, which its own launchers set to say how it was called and
// which is only printed, and takes the user's folders from the system, not from HOME or LOCALAPPDATA.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { nodeToolsAt } from "../projects/node-tools.mjs";

export const APP_NAME = "BUSY Bar Emulator";
export const CLI_NAME = "busy-emulator";
export const BUILD_MARKER = "build.json";

function readMarker(folder, read) {
  let text;
  try {
    text = read(path.join(folder, BUILD_MARKER), "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    return { invalid: e?.code ?? String(e) };
  }
  try {
    const marker = JSON.parse(text);
    return marker && (marker.kind === "release" || marker.kind === "test") ? marker : { invalid: "unknown kind" };
  } catch (e) {
    return { invalid: e.message };
  }
}

function windowsFolder(given) {
  return given && path.win32.isAbsolute(given) ? path.win32.normalize(given) : "C:\\Windows";
}

function readVersion(file, read) {
  try {
    return JSON.parse(read(file, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {Record<string, string | undefined>} o.env
 * @param {string} o.platform    process.platform
 * @param {string} o.homeDir     os.homedir(): the home a development run and the test variant use
 * @param {string} o.systemHomeDir  os.userInfo().homedir: the home by the system's account, which a release uses
 * @param {string} o.scriptPath  the absolute path of busy-emulator.mjs
 * @param {string} o.execPath    process.execPath: the Node it runs on
 * @param {string} o.nodeVersion process.versions.node
 * @param {(file: string, encoding: string) => string} [o.read]
 * @param {(file: string) => boolean} [o.exists]
 */
/** A test's time of npm's silence (BUSY_EMULATOR_TEST_NPM_QUIET): seconds, and the runs it is for. */
function npmQuiet(value) {
  const match = /^(\d{1,4})(?::(dependencies))?$/.exec(value ?? "");
  return match ? { npmQuietMs: Number(match[1]) * 1000, npmQuietFor: match[2] ?? null } : { npmQuietMs: null, npmQuietFor: null };
}

export function resolveContext({ env, platform, homeDir, systemHomeDir = homeDir, scriptPath, execPath, nodeVersion, read = readFileSync, exists = existsSync }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const cliDir = p.dirname(scriptPath);
  const resourcesDir = p.resolve(cliDir, "..", "..", "..", "..");
  const marker = readMarker(resourcesDir, read);
  // packages/app beside packages/server: in the development repository, where they lie under emulator/, and in the
  // public repository, where they lie at its root (EMU-164); never in an app, which has no packages/app.
  const sourceTree = readVersion(p.join(cliDir, "..", "..", "app", "package.json"), read) !== null && !exists(p.join(resourcesDir, "node"));
  const kind = marker === null ? (sourceTree ? "development" : "release") : marker.invalid ? "release" : marker.kind;
  const development = kind !== "release";
  const given = (name) => (development && env[name] ? env[name] : null);

  // The same data folder as the shell's (packages/app/src/config.mjs; a test checks that both agree).
  const home = development ? homeDir : systemHomeDir;
  const localAppData = platform === "win32" ? (development && env.LOCALAPPDATA) || p.join(home, "AppData", "Local") : null;
  const dataRoot = platform === "win32" ? p.join(localAppData, APP_NAME) : p.join(home, "Library", "Application Support", APP_NAME);
  const dataDir = given("BUSY_EMULATOR_DATA") ? p.resolve(given("BUSY_EMULATOR_DATA")) : dataRoot;

  // The app around this command line: the bundle on macOS, the executable on Windows. A development run has none.
  const appPath = kind === "development" ? null : platform === "win32" ? p.join(p.dirname(resourcesDir), `${APP_NAME}.exe`) : p.dirname(p.dirname(resourcesDir));
  const version = kind === "development" ? readVersion(p.join(cliDir, "..", "..", "app", "package.json"), read) : (marker?.version ?? null);
  // The bar's own port, which the command line looks at when there is no mirror; a test names another.
  const port = /^\d{1,5}$/.test(given("BUSY_EMULATOR_PORT") ?? "") ? Number(given("BUSY_EMULATOR_PORT")) : 8640;

  // How this command line was called, to print it back in a form one can paste: the launcher's path when a launcher
  // ran it, otherwise Node and the script.
  const calledAs = env.BUSY_EMULATOR_CLI_PATH ? [env.BUSY_EMULATOR_CLI_PATH] : [execPath, scriptPath];

  // A test starts the app its own way instead of through the system (which would put a window on the screen): a
  // JSON array, the program and its arguments. Never in a release.
  let testLaunch = null;
  if (given("BUSY_EMULATOR_TEST_LAUNCH")) {
    try {
      const parsed = JSON.parse(given("BUSY_EMULATOR_TEST_LAUNCH"));
      if (Array.isArray(parsed) && parsed.length && parsed.every((part) => typeof part === "string")) testLaunch = parsed;
    } catch {
      // Ignored: the system's way is used.
    }
  }

  return {
    platform,
    kind,
    development,
    resourcesDir: kind === "development" ? null : resourcesDir,
    appPath,
    version,
    node: nodeVersion,
    dataDir,
    pointerFile: p.join(dataDir, "install.json"),
    runStateFile: p.join(dataDir, "run", "emulator.json"),
    defaultPort: port > 0 && port < 65536 ? port : 8640,
    // The Windows folder: the system's own, which the Windows launcher reads with GetWindowsDirectory and hands over
    // (busy-emulator.cs, over whatever the caller set); never SystemRoot of the caller, which would choose Explorer
    // and PowerShell (security S5). Without the launcher (Node started on the script by hand): the usual folder.
    windowsDir: platform === "win32" ? windowsFolder(env.BUSY_EMULATOR_WINDOWS_DIR) : null,
    calledAs,
    testLaunch,
    // The Node and npm the project commands run the project's tools on (EMU-206): the app's own, by full path; a
    // development run's are the Node it runs on and the npm beside it.
    nodeTools: nodeToolsAt({ platform, resourcesDir: kind === "development" ? null : resourcesDir, execPath }),
    // The caller's environment, which the tools of a project get, cleaned (projects/node-tools.mjs toolEnvironment).
    env,
    // How long npm may say nothing before it is taken for hung (project.mjs npmWatch): a test's shorter time, for
    // every npm run ("4") or for the installs of a project's dependencies only ("4:dependencies").
    ...npmQuiet(given("BUSY_EMULATOR_TEST_NPM_QUIET")),
  };
}
