// What the shell is told from outside and where its own things live.
//
// Pure: the caller passes the environment and the paths in, so the rules can be tested on plain Node and for either
// system. A release takes nothing from the environment: the overrides below work only in a development run (the app
// is run from its source folder) or in the test variant. Which of the three a build is, the marker inside its archive
// says (build-kind.mjs), not the name of its executable.
import path from "node:path";

export const APP_NAME = "BUSY Bar Emulator";
export const APP_ID = "app.busy.emulator";
export const DEFAULT_PORT = 8640;
export const START_TIMEOUT_MS = 30_000;
/** The command line's name, and the name of its folder under the user's home (ADR-0002, section 7a). */
export const CLI_NAME = "busy-emulator";
/** The storage of the local web's window, apart from the device window's (EMU-209). */
export const LOCAL_WEB_PARTITION = "persist:local-web";

/** An address on this machine a test's stand-in for GitHub listens on; null for anything else. */
function loopbackAddress(text) {
  try {
    const url = new URL(text ?? "");
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && portFrom(url.port) ? url.href : null;
  } catch {
    return null;
  }
}

function portFrom(text) {
  if (!/^\d{1,5}$/.test(text ?? "")) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Where the launcher of the command line goes: a fixed path without spaces, the same on every machine but for the
 * user's own folder (ADR-0002, section 7a). `userHome` is the user's home on macOS and %LOCALAPPDATA% on Windows.
 */
export function launcherPathIn(userHome, platform) {
  return platform === "win32"
    ? path.win32.join(userHome, CLI_NAME, "bin", `${CLI_NAME}.exe`)
    : path.posix.join(userHome, `.${CLI_NAME}`, "bin", CLI_NAME);
}

/**
 * The app itself, from its resources folder: the bundle on macOS (Name.app/Contents/Resources), the executable on
 * Windows (<folder>\resources beside <folder>\BUSY Bar Emulator.exe).
 */
export function appPathOf(resourcesDir, platform) {
  if (platform === "win32") return path.win32.join(path.win32.dirname(resourcesDir), `${APP_NAME}.exe`);
  return path.posix.dirname(path.posix.dirname(resourcesDir));
}

/**
 * @param {object} o
 * @param {Record<string, string | undefined>} o.env
 * @param {string} o.platform       process.platform
 * @param {"release" | "test" | "development"} o.kind   buildKindOf()
 * @param {boolean} o.testVariant   the folder test-variant/ exists in the app
 * @param {string} o.appDir         the app's folder (where package.json is): the source folder, resources/app or app.asar
 * @param {string} o.appDataDir     app.getPath("appData")
 * @param {string} o.homeDir        os.homedir(): the home a development run and the test variant use
 * @param {string} [o.systemHomeDir] os.userInfo().homedir: the home by the system's account, which a release uses
 */
export function resolveConfig({ env, platform, kind, testVariant, appDir, appDataDir, homeDir, systemHomeDir = homeDir }) {
  if (!["release", "test", "development"].includes(kind)) throw new Error(`Not a kind of build: ${kind}`);
  const p = platform === "win32" ? path.win32 : path.posix;
  const packaged = kind !== "development";
  const development = kind !== "release";
  const given = (name) => (development && env[name] ? env[name] : null);

  // The user's data folder (architecture.md, section 4). On Windows it is under %LOCALAPPDATA%, which Electron has no
  // name for.
  // A release takes the user's folders from the system, not from HOME or LOCALAPPDATA (ADR-0016): whoever sets the
  // environment of a command must not choose where the app and its command line look.
  const home = development ? homeDir : systemHomeDir;
  const localAppData = platform === "win32" ? (development && env.LOCALAPPDATA) || p.join(home, "AppData", "Local") : null;
  const dataRoot = p.join(localAppData ?? appDataDir, APP_NAME);
  const dataDir = given("BUSY_EMULATOR_DATA") ? p.resolve(given("BUSY_EMULATOR_DATA")) : dataRoot;

  // A packaged app's folder lies in its resources folder (resources/app.asar, or resources/app), and so does
  // everything that runs on the bundled Node: Node itself, the server, the command line. The folder is found from the
  // app's folder rather than from process.resourcesPath, so that a test can lay out a packaged app anywhere.
  const resourcesDir = packaged ? p.dirname(appDir) : null;
  const bundledNode = packaged ? p.join(resourcesDir, "node", platform === "win32" ? "node.exe" : p.join("bin", "node")) : null;
  // GitHub CLI, beside Node (tools/bundled-gh.mjs).
  const bundledGh = packaged ? p.join(resourcesDir, "gh", "bin", platform === "win32" ? "gh.exe" : "gh") : null;
  // Seam for EMU-203: where the packager puts the server, and the supervisor outside the app's archive (the bundled
  // Node cannot read a file inside app.asar). The server is named by its module, the one that exports startServer:
  // the supervisor runs it in its own process (EMU-004, EMU-239).
  const bundledServer = packaged ? p.join(resourcesDir, "emulator", "packages", "server", "server.mjs") : p.join(appDir, "..", "server", "server.mjs");
  // The command line lies beside the server; the window's actions run it (actions.mjs).
  const cliEntry = p.join(p.dirname(bundledServer), "cli", `${CLI_NAME}.mjs`);
  const supervisorPath = p.join(/\.asar$/i.test(appDir) ? `${appDir}.unpacked` : appDir, "src", "supervisor.mjs");

  // The command line (ADR-0002, sections 7 and 7a) lies inside the app; a launcher at a fixed path, which the app
  // rewrites at every start, runs it, and the pointer file in the data folder names the launcher. A release writes
  // both to the user's real places. A development run and the test variant write them only where
  // BUSY_EMULATOR_USER_HOME says (the folder that stands for the home on macOS and for %LOCALAPPDATA% on Windows), so
  // that they never touch the user's own; a run from the source folder has no command line inside it and writes none.
  const userHome = development ? (given("BUSY_EMULATOR_USER_HOME") ? p.resolve(given("BUSY_EMULATOR_USER_HOME")) : null) : (localAppData ?? home);
  const installFiles =
    packaged && userHome
      ? {
          launcher: launcherPathIn(userHome, platform),
          pointer: p.join(dataDir, "install.json"),
          appPath: appPathOf(resourcesDir, platform),
          node: bundledNode,
          cli: p.join(resourcesDir, "emulator", "packages", "server", "cli", `${CLI_NAME}.mjs`),
          inAppLauncher: p.join(resourcesDir, "bin", platform === "win32" ? `${CLI_NAME}.exe` : CLI_NAME),
        }
      : null;

  const port = portFrom(given("BUSY_EMULATOR_PORT")) ?? DEFAULT_PORT;
  // The update check (EMU-205, ADR-0014): a release asks GitHub, unless BUSY_EMULATOR_NO_UPDATE_CHECK=1 — the one
  // variable a release reads, and it can only make the app do less. The test variant and a run from the source folder
  // never ask GitHub: they check only when a test names its stand-in, an address on this machine.
  const updateStandIn = loopbackAddress(given("BUSY_EMULATOR_UPDATE_URL"));
  const updateCheck = {
    allowed: env.BUSY_EMULATOR_NO_UPDATE_CHECK !== "1" && (development ? Boolean(updateStandIn) : true),
    url: development ? updateStandIn : null,
  };
  // The built-in update (EMU-221): a release takes its files from GitHub's releases and checks them with the key in
  // its code. The test variant and a run from the source folder update only from a test's stand-in on this machine
  // (BUSY_EMULATOR_UPDATE_RELEASES, the releases' download address there), with the test's own public key
  // (BUSY_EMULATOR_TEST_UPDATE_KEY, a PEM file); a run from the source folder needs the app bundle to replace named too
  // (BUSY_EMULATOR_TEST_UPDATE_TARGET). BUSY_EMULATOR_TEST_UPDATE_ANSWER ("yes" or "no") stands for the person's
  // click in the Restart dialog of a hidden test run. A release reads none of these.
  const updateReleases = loopbackAddress(given("BUSY_EMULATOR_UPDATE_RELEASES"));
  const updater = {
    allowed: updateCheck.allowed && (development ? Boolean(updateReleases && given("BUSY_EMULATOR_TEST_UPDATE_KEY")) : true),
    base: development ? (updateReleases ? updateReleases.replace(/\/+$/, "") : null) : "https://github.com/busy-app/busybar-emulator/releases/download",
    keyFile: given("BUSY_EMULATOR_TEST_UPDATE_KEY") ? p.resolve(given("BUSY_EMULATOR_TEST_UPDATE_KEY")) : null,
    target: kind === "development" && given("BUSY_EMULATOR_TEST_UPDATE_TARGET") ? p.resolve(given("BUSY_EMULATOR_TEST_UPDATE_TARGET")) : null,
    testAnswer: ["yes", "no"].includes(given("BUSY_EMULATOR_TEST_UPDATE_ANSWER")) ? given("BUSY_EMULATOR_TEST_UPDATE_ANSWER") : null,
    // Where Windows' setup puts the app for a person: an install there gets its shortcut back from the update.
    windowsFolder: platform === "win32" ? p.join(localAppData, "Programs", APP_NAME) : null,
  };
  const slowStart = Number(given("BUSY_EMULATOR_TEST_SLOW_START_MS"));
  return {
    kind,
    development,
    port,
    windowUrl: `http://127.0.0.1:${port}/emulator`,
    // The bar's local web, in a window of its own (EMU-209): the server's page that sets the tab and goes on to "/".
    localWebUrl: `http://127.0.0.1:${port}/`,
    appSettingsUrl: `http://127.0.0.1:${port}/emulator/local-web.html?tab=apps`,
    updateCheck,
    updater,
    // The app's own settings (the switch of the update check, when it last asked and what it was told).
    settingsFile: p.join(dataDir, "app-settings.json"),
    dataDir,
    // Chromium's own files (cache, storage of the pages) stay out of the documented layout of the data folder.
    shellDataDir: p.join(dataDir, "shell"),
    logFile: p.join(dataDir, "logs", "shell.log"),
    // What the command line reads to know whether the emulator runs and where: a mirror, not a way to send commands.
    runStateFile: p.join(dataDir, "run", "emulator.json"),
    resourcesDir,
    // A release runs the server on its own Node only; the test variant may be given another; a development run from
    // the source folder has none of its own and must be given one (npm start does).
    nodePath: given("BUSY_EMULATOR_NODE") ? p.resolve(given("BUSY_EMULATOR_NODE")) : bundledNode,
    serverEntry: given("BUSY_EMULATOR_SERVER_ENTRY") ? p.resolve(given("BUSY_EMULATOR_SERVER_ENTRY")) : bundledServer,
    supervisorPath,
    cliEntry,
    installFiles,
    startTimeoutMs: START_TIMEOUT_MS,
    // The macOS location check looks at the real place of the app; a test names another one.
    appLocation: given("BUSY_EMULATOR_APP_LOCATION"),
    checkLocation: packaged || Boolean(given("BUSY_EMULATOR_APP_LOCATION")),
    // Windows are made but never shown, and the app stays out of the Dock and the taskbar: for tests on a machine
    // somebody is using.
    hidden: Boolean(given("BUSY_EMULATOR_HIDDEN")),
    // The update's pop-up (update-popup.mjs): never in a hidden run or under a test, unless the test asks for it.
    updatePopup: given("BUSY_EMULATOR_HIDDEN") || (development && testVariant && env.BUSY_EMULATOR_TEST_HOOK) ? given("BUSY_EMULATOR_TEST_UPDATE_POPUP") === "1" : true,
    // For the tests of busy-emulator trust: what stands in for the person's click in the trust dialog, "trust" or
    // "refuse" (person-question.mjs). Never in a release: given() reads nothing there, so only a click answers.
    testTrustAnswer: ["trust", "refuse"].includes(given("BUSY_EMULATOR_TEST_TRUST_ANSWER")) ? given("BUSY_EMULATOR_TEST_TRUST_ANSWER") : null,
    // Publish stage 2 (GitHub sign-in, repository, pull request to the catalog) goes through GitHub CLI. A release
    // runs the gh bundled in its resources folder (tools/bundled-gh.mjs) and reads none of this. A development run and
    // the test variant may name another (BUSY_EMULATOR_GH): a program, or a .mjs that the given Node runs (the tests'
    // stand-in, test/fixtures/fake-gh.mjs); "none" for a build without it. A run from the source folder without one
    // has no gh, and the window says publishing needs it.
    // gh's configuration is the person's own (gh.mjs): gh's default folder, ~/.config/gh or %APPDATA%\GitHub CLI.
    // A development run and the test variant may name another (BUSY_EMULATOR_GH_CONFIG_DIR): the tests never touch
    // the person's GitHub CLI.
    github: {
      gh: given("BUSY_EMULATOR_GH") === "none" ? null : given("BUSY_EMULATOR_GH") ? p.resolve(given("BUSY_EMULATOR_GH")) : bundledGh,
      configDir: given("BUSY_EMULATOR_GH_CONFIG_DIR") ? p.resolve(given("BUSY_EMULATOR_GH_CONFIG_DIR")) : platform === "win32" ? p.join(appDataDir, "GitHub CLI") : p.join(home, ".config", "gh"),
      // Where a release's app package may be downloaded from: github.com's hosts over HTTPS (publish-flow.mjs). The
      // tests name their stand-in for GitHub on this machine (BUSY_EMULATOR_GITHUB_DOWNLOADS); a release reads none.
      downloads: loopbackAddress(given("BUSY_EMULATOR_GITHUB_DOWNLOADS")),
    },
    // For the shell's tests of the start: how long a start goes without an answer before the window says it is
    // starting (server-keeper.mjs, SLOW_START_MS), so that a test that is not about that page never sees it, however
    // slow the machine. Never in a release.
    slowStartMs: Number.isInteger(slowStart) && slowStart > 0 ? slowStart : null,
    // For the shell's tests: a new data folder is a first run, whose greeting covers the window; a test that is not
    // about it starts as if the person had answered it (test/app/harness.mjs). Never in a release.
    greeted: given("BUSY_EMULATOR_TEST_GREETED") === "1",
    // Where the test hook connects. Only the test variant has the hook at all, and a release never connects it.
    testHook: development && testVariant && env.BUSY_EMULATOR_TEST_HOOK ? env.BUSY_EMULATOR_TEST_HOOK : null,
  };
}
