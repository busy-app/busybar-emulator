import assert from "node:assert/strict";
import { test } from "node:test";

import { appPathOf, launcherPathIn, resolveConfig } from "../../src/config.mjs";

const macResources = "/Applications/BUSY Bar Emulator.app/Contents/Resources";
const winResources = "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\resources";
const mac = { platform: "darwin", appDir: `${macResources}/app.asar`, appDataDir: "/Users/you/Library/Application Support", homeDir: "/Users/you" };
const macSource = { ...mac, appDir: "/apps/emulator/packages/app" };
const win = { platform: "win32", appDir: `${winResources}\\app.asar`, appDataDir: "C:\\Users\\you\\AppData\\Roaming", homeDir: "C:\\Users\\you" };
const overrides = {
  BUSY_EMULATOR_PORT: "8831",
  BUSY_EMULATOR_DATA: "/tmp/data",
  BUSY_EMULATOR_NODE: "/opt/node/bin/node",
  BUSY_EMULATOR_SERVER_ENTRY: "/tmp/fake.mjs",
  BUSY_EMULATOR_APP_LOCATION: "/tmp/Some.app",
  BUSY_EMULATOR_TEST_HOOK: "/tmp/hook.sock",
  BUSY_EMULATOR_HIDDEN: "1",
  BUSY_EMULATOR_USER_HOME: "/tmp/user-dir",
  BUSY_EMULATOR_TEST_SLOW_START_MS: "600000",
};

test("a release takes nothing from the environment", () => {
  const config = resolveConfig({ ...mac, env: overrides, kind: "release", testVariant: false });
  assert.equal(config.development, false);
  assert.equal(config.port, 8640);
  assert.equal(config.windowUrl, "http://127.0.0.1:8640/emulator");
  assert.equal(config.dataDir, "/Users/you/Library/Application Support/BUSY Bar Emulator");
  assert.equal(config.nodePath, `${macResources}/node/bin/node`);
  assert.equal(config.serverEntry, `${macResources}/emulator/packages/server/server.mjs`);
  assert.equal(config.cliEntry, `${macResources}/emulator/packages/server/cli/busy-emulator.mjs`);
  assert.equal(config.supervisorPath, `${macResources}/app.asar.unpacked/src/supervisor.mjs`);
  assert.equal(config.appLocation, null);
  assert.equal(config.checkLocation, true);
  assert.equal(config.testHook, null);
  assert.equal(config.hidden, false);
  assert.equal(config.slowStartMs, null);
  assert.equal(config.installFiles.launcher, "/Users/you/.busy-emulator/bin/busy-emulator");
});

test("a release that has the test variant's folder still has no test hook", () => {
  const config = resolveConfig({ ...mac, env: overrides, kind: "release", testVariant: true });
  assert.equal(config.testHook, null);
  assert.equal(config.port, 8640);
});

test("a development run takes the port, the data folder, Node and the server from the environment, but has no test hook", () => {
  const config = resolveConfig({ ...macSource, env: overrides, kind: "development", testVariant: false });
  assert.equal(config.development, true);
  assert.equal(config.port, 8831);
  assert.equal(config.dataDir, "/tmp/data");
  assert.equal(config.shellDataDir, "/tmp/data/shell");
  assert.equal(config.logFile, "/tmp/data/logs/shell.log");
  assert.equal(config.barDataDir, undefined, "the server is given the whole data folder");
  assert.equal(config.runStateFile, "/tmp/data/run/emulator.json");
  assert.equal(config.nodePath, "/opt/node/bin/node");
  assert.equal(config.serverEntry, "/tmp/fake.mjs");
  // The command line stays the one beside the real server, whatever server a test names.
  assert.match(config.cliEntry, /[\\/]server[\\/]cli[\\/]busy-emulator\.mjs$/);
  assert.equal(config.testHook, null);
  assert.equal(config.hidden, true);
});

test("the test variant has the hook, from the source folder or packaged", () => {
  for (const [kind, where] of [["test", mac], ["development", macSource]]) {
    const config = resolveConfig({ ...where, env: overrides, kind, testVariant: true });
    assert.equal(config.testHook, "/tmp/hook.sock", kind);
    assert.equal(config.slowStartMs, 600_000, kind);
    assert.equal(config.development, true, kind);
    assert.equal(config.port, 8831, kind);
  }
});

test("without overrides a development run finds the server beside the app and has no Node", () => {
  const config = resolveConfig({ ...macSource, env: {}, kind: "development", testVariant: true });
  assert.equal(config.serverEntry, "/apps/emulator/packages/server/server.mjs");
  assert.equal(config.cliEntry, "/apps/emulator/packages/server/cli/busy-emulator.mjs");
  assert.equal(config.supervisorPath, "/apps/emulator/packages/app/src/supervisor.mjs");
  assert.equal(config.nodePath, null);
  assert.equal(config.resourcesDir, null);
  assert.equal(config.checkLocation, false);
  assert.equal(config.hidden, false);
});

test("Node: a release has only its own; the test variant its own unless told; a development run what it is told", () => {
  const without = { ...overrides, BUSY_EMULATOR_NODE: undefined };
  assert.equal(resolveConfig({ ...mac, env: overrides, kind: "release", testVariant: false }).nodePath, `${macResources}/node/bin/node`);
  assert.equal(resolveConfig({ ...mac, env: without, kind: "test", testVariant: true }).nodePath, `${macResources}/node/bin/node`);
  assert.equal(resolveConfig({ ...mac, env: overrides, kind: "test", testVariant: true }).nodePath, "/opt/node/bin/node");
  assert.equal(resolveConfig({ ...macSource, env: overrides, kind: "development", testVariant: false }).nodePath, "/opt/node/bin/node");
});

test("a packaged app found in resources/app (unpacked) has its resources and its supervisor there", () => {
  const config = resolveConfig({ ...mac, appDir: "/tmp/Lay out/X.app/Contents/Resources/app", env: {}, kind: "test", testVariant: true });
  assert.equal(config.resourcesDir, "/tmp/Lay out/X.app/Contents/Resources");
  assert.equal(config.nodePath, "/tmp/Lay out/X.app/Contents/Resources/node/bin/node");
  assert.equal(config.supervisorPath, "/tmp/Lay out/X.app/Contents/Resources/app/src/supervisor.mjs");
});

test("Windows: the data folder is under the profile's AppData\\Local and the paths are Windows paths", () => {
  const config = resolveConfig({ ...win, env: { LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" }, kind: "release", testVariant: false });
  assert.equal(config.dataDir, "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator");
  assert.equal(config.logFile, "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator\\logs\\shell.log");
  assert.equal(config.nodePath, `${winResources}\\node\\node.exe`);
  assert.equal(config.serverEntry, `${winResources}\\emulator\\packages\\server\\server.mjs`);
  assert.equal(config.cliEntry, `${winResources}\\emulator\\packages\\server\\cli\\busy-emulator.mjs`);
  assert.equal(config.supervisorPath, `${winResources}\\app.asar.unpacked\\src\\supervisor.mjs`);
});

test("a port that is not a port is ignored", () => {
  for (const bad of ["0", "65536", "80a", "-1", " 8831", "8831.5", "1e3"]) {
    const config = resolveConfig({ ...macSource, env: { BUSY_EMULATOR_PORT: bad }, kind: "development", testVariant: true });
    assert.equal(config.port, 8640, bad);
  }
});

test("the launcher's fixed path has no spaces of its own (ADR-0002, section 7a)", () => {
  assert.equal(launcherPathIn("/Users/you", "darwin"), "/Users/you/.busy-emulator/bin/busy-emulator");
  assert.equal(launcherPathIn("C:\\Users\\you\\AppData\\Local", "win32"), "C:\\Users\\you\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe");
});

test("the app is found from its resources folder", () => {
  assert.equal(appPathOf(macResources, "darwin"), "/Applications/BUSY Bar Emulator.app");
  assert.equal(appPathOf(winResources, "win32"), "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\BUSY Bar Emulator.exe");
});

test("a release writes the launcher to the user's home and the pointer to the data folder, naming this copy", () => {
  assert.deepEqual(resolveConfig({ ...mac, env: overrides, kind: "release", testVariant: false }).installFiles, {
    launcher: "/Users/you/.busy-emulator/bin/busy-emulator",
    pointer: "/Users/you/Library/Application Support/BUSY Bar Emulator/install.json",
    appPath: "/Applications/BUSY Bar Emulator.app",
    node: `${macResources}/node/bin/node`,
    cli: `${macResources}/emulator/packages/server/cli/busy-emulator.mjs`,
    inAppLauncher: `${macResources}/bin/busy-emulator`,
  });
  assert.deepEqual(resolveConfig({ ...win, env: { LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" }, kind: "release", testVariant: false }).installFiles, {
    launcher: "C:\\Users\\you\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe",
    pointer: "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator\\install.json",
    appPath: "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\BUSY Bar Emulator.exe",
    node: `${winResources}\\node\\node.exe`,
    cli: `${winResources}\\emulator\\packages\\server\\cli\\busy-emulator.mjs`,
    inAppLauncher: `${winResources}\\bin\\busy-emulator.exe`,
  });
});

test("outside a release the launcher and the pointer are written only where BUSY_EMULATOR_USER_HOME says", () => {
  const told = resolveConfig({ ...mac, env: overrides, kind: "test", testVariant: true });
  assert.equal(told.installFiles.launcher, "/tmp/user-dir/.busy-emulator/bin/busy-emulator");
  assert.equal(told.installFiles.pointer, "/tmp/data/install.json");
  assert.equal(resolveConfig({ ...mac, env: { ...overrides, BUSY_EMULATOR_USER_HOME: undefined }, kind: "test", testVariant: true }).installFiles, null);
  // A run from the source folder has no command line inside it to point to.
  assert.equal(resolveConfig({ ...macSource, env: overrides, kind: "development", testVariant: true }).installFiles, null);
});

test("a kind of build that is not one of the three is refused, not taken for a packaged app", () => {
  for (const kind of [undefined, "", "packaged", true]) {
    assert.throws(() => resolveConfig({ ...mac, env: {}, kind, testVariant: false }), /Not a kind of build/, String(kind));
  }
});

test("a release takes the user's folders from the system, not from HOME or LOCALAPPDATA (security S1)", () => {
  const winRelease = resolveConfig({ ...win, homeDir: "C:\\project", systemHomeDir: "C:\\Users\\you", env: { LOCALAPPDATA: "C:\\Users\\Public\\local" }, kind: "release", testVariant: false });
  assert.equal(winRelease.dataDir, "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator");
  assert.equal(winRelease.installFiles.launcher, "C:\\Users\\you\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe");
  const macRelease = resolveConfig({ ...mac, homeDir: "/tmp/project", systemHomeDir: "/Users/you", env: {}, kind: "release", testVariant: false });
  assert.equal(macRelease.installFiles.launcher, "/Users/you/.busy-emulator/bin/busy-emulator");
  // The test variant may be pointed elsewhere.
  const winTest = resolveConfig({ ...win, homeDir: "C:\\project", systemHomeDir: "C:\\Users\\you", env: { LOCALAPPDATA: "C:\\Users\\Public\\local" }, kind: "test", testVariant: true });
  assert.equal(winTest.dataDir, "C:\\Users\\Public\\local\\BUSY Bar Emulator");
});

// ---------------------------------------------------------------- the local web's window and the update check

test("the local web and its page for the Apps tab are at the server's address", () => {
  const config = resolveConfig({ ...macSource, env: { BUSY_EMULATOR_PORT: "8831" }, kind: "development", testVariant: false });
  assert.equal(config.localWebUrl, "http://127.0.0.1:8831/");
  assert.equal(config.appSettingsUrl, "http://127.0.0.1:8831/emulator/local-web.html?tab=apps");
  assert.equal(config.settingsFile, "/Users/you/Library/Application Support/BUSY Bar Emulator/app-settings.json");
});

test("a release checks for a new version at GitHub, unless BUSY_EMULATOR_NO_UPDATE_CHECK=1; it takes no other address", () => {
  const release = (env) => resolveConfig({ ...mac, env, kind: "release", testVariant: false }).updateCheck;
  assert.deepEqual(release({}), { allowed: true, url: null });
  assert.deepEqual(release({ BUSY_EMULATOR_UPDATE_URL: "http://127.0.0.1:8835/latest" }), { allowed: true, url: null });
  assert.deepEqual(release({ BUSY_EMULATOR_NO_UPDATE_CHECK: "1" }), { allowed: false, url: null });
  // Only "1" switches it off; and nothing in the environment can switch on what the variable switched off.
  assert.deepEqual(release({ BUSY_EMULATOR_NO_UPDATE_CHECK: "0" }), { allowed: true, url: null });
});

test("the test variant and a development run never ask GitHub: they check only a stand-in on this machine a test names", () => {
  for (const [kind, base] of [["test", mac], ["development", macSource]]) {
    const check = (env) => resolveConfig({ ...base, env, kind, testVariant: kind === "test" }).updateCheck;
    assert.deepEqual(check({}), { allowed: false, url: null }, kind);
    assert.deepEqual(check({ BUSY_EMULATOR_UPDATE_URL: "http://127.0.0.1:8835/latest" }), { allowed: true, url: "http://127.0.0.1:8835/latest" }, kind);
    assert.deepEqual(check({ BUSY_EMULATOR_UPDATE_URL: "http://127.0.0.1:8835/latest", BUSY_EMULATOR_NO_UPDATE_CHECK: "1" }), { allowed: false, url: "http://127.0.0.1:8835/latest" }, kind);
    for (const elsewhere of ["https://api.github.com/repos/busy-app/busybar-emulator/releases/latest", "http://localhost:8835/latest", "http://192.0.2.1:8835/latest", "http://127.0.0.1/latest", "https://127.0.0.1:8835/latest", "not an address"]) {
      assert.deepEqual(check({ BUSY_EMULATOR_UPDATE_URL: elsewhere }), { allowed: false, url: null }, `${kind} ${elsewhere}`);
    }
  }
});

test("GitHub CLI: a release runs the gh inside it with GitHub CLI's default settings folder, whatever its environment says (security review F8); a test names its own", () => {
  const env = { BUSY_EMULATOR_GH: "/tmp/fake-gh.mjs", BUSY_EMULATOR_GH_CONFIG_DIR: "/tmp/gh-config", GH_CONFIG_DIR: "/tmp/elsewhere", XDG_CONFIG_HOME: "/tmp/xdg", BUSY_EMULATOR_GITHUB_DOWNLOADS: "http://127.0.0.1:8123" };
  const release = resolveConfig({ ...mac, env, kind: "release", testVariant: false });
  // A release's packages come from github.com's own hosts only: it reads no stand-in for them.
  assert.deepEqual(release.github, { gh: `${macResources}/gh/bin/gh`, configDir: "/Users/you/.config/gh", downloads: null });
  const windows = resolveConfig({ ...win, env, kind: "release", testVariant: false });
  assert.deepEqual(windows.github, { gh: `${winResources}\\gh\\bin\\gh.exe`, configDir: "C:\\Users\\you\\AppData\\Roaming\\GitHub CLI", downloads: null });
  const test = resolveConfig({ ...macSource, env, kind: "development", testVariant: true });
  assert.deepEqual(test.github, { gh: "/tmp/fake-gh.mjs", configDir: "/tmp/gh-config", downloads: "http://127.0.0.1:8123/" });
  assert.equal(resolveConfig({ ...macSource, env: { BUSY_EMULATOR_GH: "none" }, kind: "development", testVariant: true }).github.gh, null);
  assert.equal(resolveConfig({ ...macSource, env: {}, kind: "development", testVariant: false }).github.gh, null, "a run from the source folder has no gh of its own");
});
