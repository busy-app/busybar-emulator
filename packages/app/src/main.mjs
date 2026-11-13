// BUSY Bar Emulator: the main process of the desktop shell (ADR-0016).
//
// The shell is thin: it starts the emulator server as a separate process on the bundled Node, keeps it running,
// shows one window and makes sure the app runs once. It holds no product logic and no firmware code.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, screen, session, shell as system } from "electron";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createActions, JOB_CHANNEL, MENU_CHANNEL, NEW_PROJECTS_FOLDER, newAppAuthor, showPath, shownCliPath, windowsRecycleRefusal } from "./actions.mjs";
import { APP_SCHEME, createAppSchemeHandler, SCHEME_PRIVILEGES } from "./app-scheme.mjs";
import { BRIDGE_CHANNEL, createBridge } from "./bridge.mjs";
import { createBuildFeed } from "./build-feed.mjs";
import { buildKindOf, inSourceTree, readBuildMarker } from "./build-kind.mjs";
import { cliEnvironment, startCliProcess } from "./cli-process.mjs";
import { APP_ID, APP_NAME, LOCAL_WEB_PARTITION, resolveConfig } from "./config.mjs";
import { createCaptureActions, createSaveDialog } from "./capture-actions.mjs";
import { CAPTURE_PARTITION, createClipEncoder } from "./capture-window.mjs";
import { createOpener, DOCS_URLS } from "./external.mjs";
import { createFolderDialogs } from "./folder-dialogs.mjs";
import { createGestures } from "./gestures.mjs";
import { askRequest, createGithubPublish, parseCatalog } from "./github/publish-flow.mjs";
import { createPublishRecord } from "./github/publish-record.mjs";
import { ghEnvironment, ghFolders, ghRunner } from "./github/gh.mjs";
import { createIconAnswers, isIconRequest } from "./icons.mjs";
import { ownDataFolder, removeRunState, writeInstallFiles, writeRunState } from "./install-files.mjs";
import { bundlePathOf, checkAppLocation } from "./location-check.mjs";
import { createLog } from "./log.mjs";
import { menuTemplate } from "./menu.mjs";
import { createPersonQuestions } from "./person-question.mjs";
import { createReportActions, NEW_ISSUE, systemOf } from "./report-actions.mjs";
import { messageFor } from "./messages.mjs";
import { allowUpdateNode, configureShellPrograms, runShellProgram, startShellProgram } from "./processes.mjs";
import { createWindowRegistry, FEATURES_OFF, HOST_RESOLVER_RULES, installSecurity, originOf, switchNamesIn } from "./security.mjs";
import { createServerKeeper } from "./server-keeper.mjs";
import { cmdPath, createTerminal, launchTerminal } from "./terminal.mjs";
import { askLatest, createSettings, createUpdateCheck, LATEST_RELEASE_URL, releasePage } from "./update-check.mjs";
import { UPDATE_PUBLIC_KEY } from "./update-manifest.mjs";
import { createUpdatePopup } from "./update-popup.mjs";
import { createUpdater, installPlace, listWindowsProcesses } from "./updater.mjs";
import { describeMenu, runMenuItem, usesTitleBar } from "./title-bar.mjs";
import { createWindows } from "./windows.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.dirname(here);
// The test variant is the same code with one more folder. A release does not have the folder (package.json "files"),
// and without it nothing below can switch the test entry on.
const testHookFile = path.join(appDir, "test-variant", "hook.mjs");
const testVariant = existsSync(testHookFile);
// Release, test variant or development: the marker in the app's own folder says (build-kind.mjs).
const kind = buildKindOf({ marker: readBuildMarker(appDir), sourceTree: inSourceTree(appDir) });
// The release and the test variant take no Chromium switches from their command line (ADR-0016): every switch that
// came in the arguments is removed before anything reads it. Only a run from the source tree keeps them, for the
// developer's --remote-debugging-port and the like. Some switches are read before this file runs, and removing them
// here changes nothing: those of Node itself (--inspect and the like), which the fuses of the release build close,
// and a few of Chromium's own (--enable-logging with --log-file, --force-device-scale-factor: checked 11.11), which
// stay. The command line busy-emulator gives the app no arguments (EMU-202).
if (kind !== "development") {
  for (const name of switchNamesIn(process.argv.slice(1))) app.commandLine.removeSwitch(name);
}
app.commandLine.appendSwitch("disable-features", FEATURES_OFF.join(","));
app.commandLine.appendSwitch("host-resolver-rules", HOST_RESOLVER_RULES);
const startedAt = Date.now();

/** The home by the system's account (the user database, the profile on Windows), not HOME: what a release uses. */
function systemHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

const config = resolveConfig({
  env: process.env,
  platform: process.platform,
  kind,
  testVariant,
  appDir,
  appDataDir: app.getPath("appData"),
  homeDir: os.homedir(),
  systemHomeDir: systemHome(),
});
// What the app starts (processes.mjs): its own Node, and the system's programs from the Windows folder.
configureShellPrograms({ node: config.nodePath, gh: config.github.gh, windowsDir: path.win32.dirname(path.win32.dirname(cmdPath(process.env))) });

app.setName(APP_NAME);
if (process.platform === "win32") app.setAppUserModelId(APP_ID);
// The data folder for the user alone (0700), before Electron, the log or the server make anything inside it.
const dataFolderIs = ownDataFolder(config.dataDir);
app.setPath("userData", config.shellDataDir);
// A hidden run puts nothing on the screen. Its own windows are never shown (windows.mjs), and on macOS the app has
// no Dock icon and cannot become the active app. A window made by anything else — Electron makes one itself for
// window.open, if that were ever allowed — is made fully transparent before it can appear and hidden when it does.
if (config.hidden) {
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  app.on("browser-window-created", (_event, win) => {
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.on("show", () => win.hide());
  });
}
// Every page in the sandbox, whatever a window asks for.
app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: SCHEME_PRIVILEGES }]);

const log = createLog(config.logFile);
if (dataFolderIs === "tightened") log(`[shell] the data folder was open to other accounts of this computer: it is the user's alone now (0700)`);
if (dataFolderIs === "not_own") log(`[shell] the data folder is a link or another user's: its rights are left as they are`);
const registry = createWindowRegistry();
// What the server asks the person (whether they trust a project folder: busy-emulator trust, ADR-0012 section 4):
// a dialog of the system's, shown by this process and answered by a click in it alone. It always hangs on the app's
// main window: only such a dialog can be taken away when nobody answers (person-question.mjs).
const askPerson = createPersonQuestions({
  windowFor: windowForQuestion,
  showMessageBox: (win, options) => dialog.showMessageBox(win, options),
  config,
  appName: APP_NAME,
  log,
});
// What the server asks of the app itself rather than of the person (busy-emulator record, capture-window.mjs): a clip
// of the bar to encode, or of the main window to record, in a hidden page of its own.
let clips = null;
const askApp = (question, signal) => {
  const kind = { "encode-clip": "encodeClip", "record-window": "recordWindow" }[question?.kind];
  if (question?.kind === "update") return updateForCli(question, signal);
  // A question about a folder the person has just chosen in Open App Folder says so; any other says that a program asks.
  // While a program waits on the app for a clip, a recording or publishing, the update does not restart it.
  if (question?.kind === "github" || kind) {
    questionsOpen += 1;
    const answered = question.kind === "github" ? githubForCli(question, signal) : clips ? clips[kind](question, signal) : Promise.resolve({ answer: "unavailable", reason: "the app is not ready" });
    return Promise.resolve(answered).finally(() => (questionsOpen -= 1));
  }
  return askPerson(question, signal, { opened: actions.isOpening(question?.path) });
};
const keeper = createServerKeeper({ config, env: process.env, log, ...(config.slowStartMs ? { slowAfterMs: config.slowStartMs } : {}), ask: askApp });
// The windows' icon outside macOS (tools/app-icon.mjs makes it): there the app's icon comes from its bundle.
const windowIcon = process.platform === "darwin" ? undefined : path.join(here, "assets", "app-icon.png");
const windows = createWindows({
  BrowserWindow,
  registry,
  config,
  preloadPath: path.join(here, "preload.cjs"),
  devicePreloadPath: path.join(here, "window-preload.cjs"),
  icon: windowIcon,
  // Outside macOS the shell's own title bar with the menu (title-bar.mjs); the message page's is light or dark as the system.
  platform: process.platform,
  systemDark: () => nativeTheme.shouldUseDarkColors,
  // The screen the pointer is on: a window is never opened larger than its work area (windows.mjs, fitToScreen).
  workArea: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize,
  // The development loops of the window's projects end with the window; a recording of it stops and is saved.
  onDeviceClosed: () => {
    actions.stopLoops();
    captureActions.stopRecording();
  },
  log,
});

/** The app's own window, when a dialog can hang on it. */
function dialogParent() {
  const parent = windows.current?.win;
  return parent && !parent.isDestroyed() && parent.isVisible() ? parent : null;
}
function comeForward() {
  if (process.platform === "darwin") app.focus({ steal: true });
  else windows.focus();
}

// The window's actions on app projects (EMU-260, EMU-261, EMU-262): done here, by running the command line; folders
// are chosen in the system's dialogs, shown from here. A hidden run and a run under a test show no folder in Finder
// and leave the clipboard alone; what they would have shown and copied is kept for the tests to read.
const folderDialogs = createFolderDialogs({
  showOpenDialog: (options) => (dialogParent() ? dialog.showOpenDialog(dialogParent(), options) : dialog.showOpenDialog(options)),
  config,
  startFolder: app.getPath("documents"),
  log,
  comeForward,
});
const offScreen = { shown: [], copied: [], terminals: [], opened: [], browsed: [], trashed: [], images: [], asked: [] };
// Under a test: the answers that stand for the person's click in the dialog that asks whether to install a package
// (actions.mjs), in the order they are asked for; what the dialog would have said is kept in offScreen.asked.
const packageAnswers = [];
// Publish stage 2 (github/publish-flow.mjs): GitHub CLI signs the person in, keeps the token in the system's store and
// makes every call to GitHub; this process never holds a token. gh's accounts are the person's own GitHub CLI's
// (gh.mjs): its configuration folder is theirs, its state, data and cache folders are the app's. Only pages of
// github.com are opened in the browser for it: the page for the code, and the page to revoke access.
const github = createGithubPublish({
  gh: config.github.gh ? ghFor(config.github.gh) : null,
  dataDir: config.dataDir,
  configDir: config.github.configDir,
  record: createPublishRecord(config.dataDir),
  downloads: config.github.downloads ? { origins: [{ protocol: "http:", host: new URL(config.github.downloads).host }] } : null,
  openExternal: (address) => {
    if (!/^https:\/\/github\.com\//.test(address)) return log("[github] refused to open an address that is not github.com's");
    if (config.hidden || config.testHook) offScreen.browsed.push(address);
    else void system.openExternal(address);
  },
  log,
});

/** gh as the app runs it: the program itself, or a .mjs stand-in run by the given Node (development and tests only). */
function ghFor(file) {
  const folders = ghFolders(config.dataDir);
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const script = config.development && /\.mjs$/.test(file);
  return { run: ghRunner({ command: script ? config.nodePath : file, prefix: script ? [file] : [], env: ghEnvironment(process.env, config.dataDir, config.github.configDir), cwd: folders.root }) };
}
// The window's Build lines, for `busy-emulator logs --kind build` in the terminal the console opens (build-feed.mjs).
const buildFeed = createBuildFeed({ dataDir: config.dataDir, log });
// The app's own settings, in its data folder: the update check's, and whether the first run's greeting was answered.
const appSettings = createSettings(config.settingsFile);
// The person's clicks and keys in each window: the bridge's actions with consequences need one just before.
const gestures = createGestures();
const actions = createActions({
  startCli: (args, onLine) => startCliProcess({ nodePath: config.nodePath, cliEntry: config.cliEntry, args, env: cliEnvironment(process.env, config), cwd: os.homedir(), onLine }),
  dialogs: folderDialogs,
  // Show in Finder/Explorer: a folder opens with its files in view, a file is selected in its folder (showPath).
  show: (target) => (config.hidden || config.testHook ? void offScreen.shown.push(target) : showPath(target, { openPath: (folder) => system.openPath(folder), showItemInFolder: (item) => system.showItemInFolder(item), log })),
  copy: (text) => (config.hidden || config.testHook ? void offScreen.copied.push(text) : clipboard.writeText(text)),
  open: (file) => (config.hidden || config.testHook ? void offScreen.opened.push(file) : void system.openPath(file)),
  // The bar card's links: the bar's address and its API documentation, in the system's browser.
  browse: (address) => (config.hidden || config.testHook ? void offScreen.browsed.push(address) : void system.openExternal(address)),
  barOrigin: originOf(config.localWebUrl),
  // Delete in the Apps list: a project folder to the Trash or the Recycle Bin, never deleted for good. A test run
  // notes the folder and leaves it where it is.
  trash: (folder) => (config.hidden || config.testHook ? Promise.resolve(void offScreen.trashed.push(folder)) : system.trashItem(folder)),
  // Where Windows has no Recycle Bin for the folder (a USB stick, a share) its call would delete for good: refused.
  trashRefusal: (folder) => (process.platform === "win32" ? windowsRecycleRefusal(folder, { env: process.env, run: runShellProgram }) : null),
  send: (job) => {
    buildFeed.take(job);
    notePublishProgress(job);
    const current = windows.current;
    if (current?.kind === "device" && !current.win.isDestroyed()) current.win.webContents.send(JOB_CHANNEL, job);
  },
  dataDir: config.dataDir,
  logFile: config.logFile,
  log,
  // Create app's default place for a new project's folder: ~/BUSY Bar projects; under a test, a folder of its own data
  // folder, never the person's home.
  newProjects: config.testHook ? path.join(config.dataDir, "test-home", NEW_PROJECTS_FOLDER) : path.join(os.homedir(), NEW_PROJECTS_FOLDER),
  home: config.testHook ? path.join(config.dataDir, "test-home") : os.homedir(),
  // A new app's author and id namespace: the GitHub login signed in, else git's user.name, else the account's name;
  // never a name many computers share (newAppAuthor): Create app then asks for it. Under a test, the test's own home
  // and an account's name of its own: the machine's ("User" on the Windows one) does not decide what the form asks.
  author: () =>
    config.testHook
      ? newAppAuthor(path.join(config.dataDir, "test-home"), { login: github.knownLogin(), userName: () => "emulator-tester" })
      : newAppAuthor(os.homedir(), { configHome: process.env.XDG_CONFIG_HOME, login: github.knownLogin() }),
  // The first run's greeting (EMU-207): the text for agents names the command line by the path the pointer file gives.
  github,
  // Install a package: the person's yes in a dialog of the app's (a test's stand-in under a test), and the emulated
  // BUSY Bar's own API for the upload.
  confirm: async (question) => {
    if (config.testHook && packageAnswers.length) {
      offScreen.asked.push(question);
      log(`[shell] question (${question.about}): answered by the test's stand-in (${packageAnswers[0]})`);
      return packageAnswers.shift();
    }
    return (await askPerson.confirm(question)).answer;
  },
  bar: { send: (method, pathname, body) => barRequest(config.port, method, pathname, body) },
  welcome: {
    settings: config.greeted ? { ...appSettings, read: () => ({ ...appSettings.read(), welcomed: true }) } : appSettings,
    platform: process.platform,
    cli: () => shownCliPath({ pointer: config.installFiles?.pointer, launcher: config.installFiles?.launcher, home: os.homedir() }),
  },
});

// The canvas's Screenshot and Record buttons (capture-actions.mjs): screenshots by the command line, the window's
// recording by the clip encoder below; where a file goes, the person says in the system's Save dialog, which a hidden
// run and a run under a test do not show (what they would have asked is kept in saveDialog.planned).
const saveDialog = createSaveDialog({
  showSaveDialog: (options) => (dialogParent() ? dialog.showSaveDialog(dialogParent(), options) : dialog.showSaveDialog(options)),
  config,
  log,
  comeForward,
});
const captureActions = createCaptureActions({
  startCli: (args, { onLine } = {}) => startCliProcess({ nodePath: config.nodePath, cliEntry: config.cliEntry, args, env: cliEnvironment(process.env, config), cwd: os.homedir(), ...(onLine ? { onLine } : {}) }),
  projectFor: (folder) => actions.projectFor(folder),
  recordWindow: (question, signal, until) => (clips ? clips.recordWindow(question, signal, until) : Promise.resolve({ answer: "unavailable", reason: "the app is not ready" })),
  dialog: saveDialog,
  show: (file) => (config.hidden || config.testHook ? void offScreen.shown.push(file) : system.showItemInFolder(file)),
  send: (event) => {
    const current = windows.current;
    if (current?.kind === "device" && !current.win.isDestroyed()) current.win.webContents.send(JOB_CHANNEL, event);
  },
  folders: { pictures: app.getPath("pictures"), videos: app.getPath("videos") },
  dataDir: config.dataDir,
  logFile: config.logFile,
  log,
});

// Report a Bug (report-actions.mjs, EMU-277): the new issue's form of the public repository in the person's browser,
// filled in and scrubbed, and Save diagnostics. Only that form's address is opened. A hidden run and a run under a test
// open no browser and leave the clipboard alone: what they would have done is kept for the tests to read.
const reportActions = createReportActions({
  dataDir: config.dataDir,
  logFile: config.logFile,
  about: () => ({ version: app.getVersion(), build: config.kind ?? null, system: systemOf({ platform: process.platform, version: process.getSystemVersion?.() ?? os.release() }), electron: process.versions.electron }),
  openExternal: (address) => {
    if (!address.startsWith(`${NEW_ISSUE}?`)) return log("[shell] report: refused to open an address that is not the new issue's form");
    if (config.hidden || config.testHook) offScreen.browsed.push(address);
    else void system.openExternal(address);
  },
  copyImage: (png) => (config.hidden || config.testHook ? void offScreen.images.push(png.length) : clipboard.writeImage(nativeImage.createFromBuffer(png))),
  dialog: saveDialog,
  show: (file) => (config.hidden || config.testHook ? void offScreen.shown.push(file) : system.showItemInFolder(file)),
  folders: { downloads: app.getPath("downloads") },
  // What the scrubber takes out: the person's own, never a test's stand-in for them only.
  person: { home: os.homedir(), user: safeUserName(), host: os.hostname(), temp: temporaryFolders() },
  log,
});

/** The system's temporary folder as programs write it and by its real path (on macOS /var is /private/var). */
function temporaryFolders() {
  const folders = [os.tmpdir(), process.env.TEMP, process.env.TMP].filter((one) => typeof one === "string" && path.isAbsolute(one));
  for (const one of [...folders]) {
    try {
      folders.push(realpathSync.native(one));
    } catch {
      // not there
    }
  }
  return folders;
}

function safeUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

// The console in the system's terminal (terminal.mjs): the app's own launcher runs `logs --follow` there. A hidden
// run and a run under a test open no terminal; what they would have opened is kept for the tests to read.
const terminal = createTerminal({
  platform: process.platform,
  cli: config.installFiles?.launcher ?? null,
  env: config.development ? { BUSY_EMULATOR_DATA: config.dataDir, BUSY_EMULATOR_PORT: String(config.port) } : {},
  projects: async () => {
    const answer = await actions.call("projects.list");
    if (!answer.ok) throw new Error(answer.error.message);
    return answer.value;
  },
  barApps: () => barAppIds(config.port),
  launch: (plan) => (config.hidden || config.testHook ? void offScreen.terminals.push(plan) : launchTerminal(plan, { spawn: startShellProgram, dataDir: config.dataDir, home: os.homedir(), baseEnv: process.env })),
  log,
});

/** One request to the emulated bar's API, a package's upload among them: { status, body }, or { failed }. */
function barRequest(port, method, pathname, body = null) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, agent: false, timeout: 120_000, headers: { "Content-Length": body ? body.length : 0, ...(body ? { "Content-Type": "application/octet-stream" } : {}) } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (text = (text + chunk).slice(0, 1_000_000)));
      response.on("end", () => resolve({ status: response.statusCode, body: text }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("no answer"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    request.end(body ?? undefined);
  });
}

/** The ids of the apps on the emulated bar, as its API lists them; none when it does not answer. */
function barAppIds(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/apps", agent: false, timeout: 2000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body = (body + chunk).slice(0, 1_000_000)));
      response.on("end", () => {
        try {
          const apps = JSON.parse(body)?.apps;
          resolve(Array.isArray(apps) ? apps.map((one) => one?.id).filter((id) => typeof id === "string") : []);
        } catch {
          resolve([]);
        }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve([]));
  });
}

// Addresses for the user's browser: a link in a window that points outside, the release page of a new version; only
// just after a click or a key in that window (external.mjs). A hidden run and a run under a test open nothing; what
// they would have opened is kept for the tests to read.
const opener = createOpener({ open: (address) => (config.hidden || config.testHook ? undefined : system.openExternal(address)), log });
// The notice of a new version (EMU-205): the one request the app makes by itself, from this process.
const updateAddress = config.updateCheck.url ?? LATEST_RELEASE_URL;
// The newer version the check found, for the mirror the command line reads (status and version tell it to an agent).
let updateNotice = null;
const updates = createUpdateCheck({
  current: app.getVersion(),
  allowed: config.updateCheck.allowed,
  settings: appSettings,
  ask: () => askLatest(updateAddress, updateAddress.startsWith("http:") ? http : https),
  log,
  onNotice: (notice) => {
    windows.setNotice(notice);
    updateNotice = notice;
    updater.offer(notice);
    if (lastMirrored) mirrorState(lastMirrored);
  },
});

// The built-in update (EMU-221, updater.mjs): Update to <version>, then Restart to update, both the person's clicks
// in the window (or the person's yes in the dialog that busy-emulator update asks for). Where this copy cannot replace
// itself the window keeps the Download line and says why.
let questionsOpen = 0; // what a program waits on the app for (a clip, a recording of the window, publishing)
const updater = createUpdater({
  current: app.getVersion(),
  kind,
  platform: process.platform,
  arch: process.arch,
  allowed: config.updater.allowed,
  base: config.updater.base ?? "https://github.com/busy-app/busybar-emulator/releases/download",
  publicKey: config.updater.keyFile ? readFileSync(config.updater.keyFile, "utf8") : UPDATE_PUBLIC_KEY,
  dataDir: config.dataDir,
  place: config.updater.allowed ? installPlace({ platform: process.platform, arch: process.arch, exe: app.getPath("exe"), target: config.updater.target, homeDir: os.homedir(), defaultWindowsFolder: config.updater.windowsFolder }) : { ok: false, why: "This build does not update itself." },
  nodePath: config.nodePath,
  helperFile: path.join(here, "update-helper.mjs"),
  transports: { http, https },
  run: runShellProgram,
  start: startShellProgram,
  allowNode: allowUpdateNode,
  busy: busyForUpdate,
  confirm: async (question, signal) => {
    // The tests' stand-in for the click in a hidden run; null in a release whatever its environment says.
    if (config.updater.testAnswer) {
      log(`[shell] question (${question.about}): answered by the test's stand-in (${config.updater.testAnswer})`);
      return config.updater.testAnswer;
    }
    return (await askPerson.confirm(question, signal)).answer;
  },
  settings: appSettings,
  quit: () => app.quit(),
  log,
  env: process.env,
  pid: process.pid,
  // Windows: what else runs from the install folder (an agent's busy-emulator mcp), which the setup could not replace.
  listProcesses: () => (process.platform === "win32" ? listWindowsProcesses({ start: startShellProgram, windowsDir: path.win32.dirname(path.win32.dirname(cmdPath(process.env))) }) : Promise.resolve(null)),
  onState: (state) => {
    const current = windows.current;
    if (current?.kind === "device" && !current.win.isDestroyed()) current.win.webContents.send(JOB_CHANNEL, { update: true, ...state });
  },
});

// The update's pop-up (update-popup.mjs): the window asks whether to show it; once a version per run.
const updatePopup = createUpdatePopup({ enabled: config.updatePopup, state: () => updater.state, notice: () => updateNotice, busy: busyForUpdate, log });

/** What the app is doing that a restart would break, in words; null when nothing. */
function busyForUpdate() {
  const kinds = Object.values(actions.jobs());
  const word = { build: "a build", dev: "a development loop", publish: "publishing", import: "an import from GitHub", run: "a run", refresh: "a refresh", check: "a check", submit: "a submission", dependencies: "installing dependencies", open: "opening a project" };
  if (kinds.length) return `${word[kinds[0]] ?? `a ${kinds[0]}`} is running in the window`;
  if (captureActions.recording()) return "the window is being recorded";
  if (questionsOpen > 0) return "a program is waiting on the emulator (a recording, a clip or publishing)";
  return null;
}

/** The window's Update and Restart: what went wrong is said in a dialog, with Download beside OK. */
async function updateFromWindow(name) {
  const answer = name === "update.download" ? await updater.download() : await updater.restart({ by: "window" });
  const problem = name === "update.download" ? (answer.state === "failed" ? { message: answer.message, hint: answer.hint } : null) : answer.ok || answer.code === "refused" ? null : { message: answer.message, hint: answer.hint };
  if (problem && !config.hidden) {
    const options = { type: "warning", title: APP_NAME, message: problem.message, detail: problem.hint ?? "", buttons: ["OK", "Download"], defaultId: 0, cancelId: 0, noLink: true };
    const { response } = await (dialogParent() ? dialog.showMessageBox(dialogParent(), options) : dialog.showMessageBox(options));
    const version = updater.state.version;
    // The release page, made from the version alone (update-check.mjs releasePage): the Download line's own address.
    if (response === 1 && version) {
      if (config.testHook) offScreen.browsed.push(releasePage(version));
      else void system.openExternal(releasePage(version));
    }
  }
  return { ok: true, value: name === "update.download" ? answer : { ...updater.state, restart: answer } };
}

/**
 * busy-emulator update [--check], through the server: the check now, or the whole update. The update is asked of the
 * person in the app's dialog first, as publishing is (person-question.mjs); with their yes the app downloads, checks
 * and restarts into the new version without asking again.
 */
async function updateForCli(question, signal) {
  const done = (value) => ({ answer: "done", value });
  const facts = () => {
    const s = updater.state;
    return { current: app.getVersion(), latest: appSettings.read().updateLatest ?? null, available: updateNotice?.version ?? null, page: updateNotice?.page ?? null, state: s.state, can_update: s.canInstall, ...(s.canInstall ? {} : { why_not: s.why }), ...(s.state === "downloading" ? { received: s.received, total: s.total } : {}), ...(s.state === "failed" ? { problem: s.message, hint: s.hint } : {}) };
  };
  if (!updates.enabled()) return done({ ok: false, code: "check_off", message: "The update check is switched off in the emulator's menu.", hint: "Switch on Check for Updates in the menu, then run this again." });
  try {
    await updates.check({ force: true });
  } catch (e) {
    return done({ ok: false, code: "network", message: `GitHub did not answer the check (${e?.message ?? e}).`, hint: "Check the connection and run this again." });
  }
  if (question.op === "check") return done({ ok: true, ...facts() });
  if (!updateNotice) return done({ ok: false, code: "no_update", message: `This is the newest version, ${app.getVersion()}.`, hint: null, ...facts() });
  const s = updater.state;
  if (!s.canInstall) return done({ ok: false, code: "cannot_update", message: `${updateNotice.version} is out, but this copy cannot update itself: ${s.why}`, hint: `Download it: ${updateNotice.page}`, ...facts() });
  const doing = busyForUpdate();
  if (doing) return done({ ok: false, code: "busy", message: `Not now: ${doing}.`, hint: "Wait until it is done, then run this again." });
  // Windows: the command that asks ends with the answer; anything else from the folder (an agent's MCP) is said now,
  // before the person is asked and before anything is downloaded.
  const requester = Number.isSafeInteger(question.requester) ? question.requester : null;
  const inUse = await updater.folderInUse({ requester });
  if (inUse) return done({ ...inUse, ...facts() });
  const said = await updater.confirmFirst({ by: "cli", signal });
  if (!said.ok) return done({ ...said, ...facts() });
  const ready = await updater.download();
  if (ready.state !== "ready") return done({ ok: false, code: ready.code ?? "failed", message: ready.message ?? "The update failed.", hint: `${ready.hint ?? ""} Or download it: ${updateNotice.page}`.trim(), ...facts() });
  const restarted = await updater.restart({ by: "cli", confirmed: true, requester });
  return done(restarted.ok ? { ok: true, version: restarted.version, restarting: true, message: `The emulator restarts into ${restarted.version}.` } : { ...restarted, ...facts() });
}


// The local web's Lucide icons (EMU-209), answered from the app's own file: the handler of https: in its session.
const iconAnswers = createIconAnswers(path.join(here, "icons", "lucide.json"));
function answerIcons(request) {
  const { status, headers, body } = iconAnswers({ method: request.method, url: request.url });
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

// What the message page shows: the app's own trouble (it must move), or the server's.
let trouble = null;

const shell = {
  config,
  keeper,
  windows,
  registry,
  testVariant,
  /** Counted so that a test can see the second launch arrive. */
  secondLaunches: 0,
  opener,
  updates,
  updater,
  updatePopup,
  updateFromWindow,
  askPerson,
  gestures,
  actions,
  terminal,
  folderDialogs,
  capture: captureActions,
  report: reportActions,
  reportBug,
  saveDialog,
  offScreen,
  /** For the tests: what the next dialog about installing a package answers ("yes" or "no"). Nothing without the test entry. */
  packageAnswer: (answer) => void (config.testHook && packageAnswers.push(answer)),
  github,
  fromMenu,
  newApp,
  // The window's own title bar (title-bar.mjs, bridge.mjs): the application menu as it is now, and its items pressed.
  titleBar: {
    menu: () => ({ ok: true, value: { titleBar: usesTitleBar(process.platform), menus: describeMenu(Menu.getApplicationMenu(), process.platform) } }),
    run: (id) => {
      const win = windows.current?.win;
      return runMenuItem(Menu.getApplicationMenu(), id, { window: win, contents: win?.webContents });
    },
  },
  showAppSettings,
  answerIcons,
  currentMessage: () => messageFor(trouble ?? keeper.state, config),
  retry: () => (trouble ? undefined : keeper.retry()),
  quit: () => app.quit(),
};

/**
 * "New App…" and "Open App Folder…" of the menu: the same actions the window's buttons call. The window comes to the
 * front and hears of the job as of any other; a failure nobody would see otherwise is told in a dialog.
 */
async function fromMenu(name) {
  showAgain();
  const answer = await actions.call(name);
  if (answer.ok || config.hidden) return answer;
  const options = { type: "warning", title: APP_NAME, message: answer.error.message, detail: answer.error.hint ?? "", buttons: ["OK"], noLink: true };
  await (dialogParent() ? dialog.showMessageBox(dialogParent(), options) : dialog.showMessageBox(options));
  return answer;
}

/**
 * The menu's New App…: the device window's Create app pop-up, the same as its button. Without the device window (the
 * server is not ready: the message window shows) there is no pop-up to open, and the folder dialog asks as before.
 */
function newApp() {
  showAgain();
  const current = windows.current;
  if (current?.kind === "device" && !current.win.isDestroyed() && !current.win.webContents.isLoading()) {
    current.win.webContents.send(MENU_CHANNEL, "create");
    return "pop-up";
  }
  void fromMenu("projects.create");
  return "dialog";
}

/**
 * The menu's Report a Bug…: the device window's dialog, which shows the text before anything leaves. Without the
 * device window (the server is not ready) there is no dialog to show: the window comes forward, and nothing opens.
 */
function reportBug() {
  showAgain();
  const current = windows.current;
  if (current?.kind === "device" && !current.win.isDestroyed() && !current.win.webContents.isLoading()) {
    current.win.webContents.send(MENU_CHANNEL, "report");
    return "dialog";
  }
  log("[shell] report: Report a Bug needs the BUSY Bar's window, which is not up");
  return "none";
}

/** The menu's Emulator Docs and JS Apps Docs: the two documentation addresses (external.mjs) in the browser, no other. */
function openDocs(address) {
  if (!DOCS_URLS.includes(address)) return log("[shell] docs: refused to open an address that is not the documentation's");
  if (config.hidden || config.testHook) offScreen.browsed.push(address);
  else void system.openExternal(address);
}

let updateFinished = false;
function showForState(state) {
  if (state.name === "ready") {
    // An update that brought this version tells its helper so, once the emulator is up (updater.mjs).
    if (!updateFinished) {
      updateFinished = true;
      try {
        updater.afterStart();
      } catch (e) {
        log(`[shell] update: the end of the update could not be noted: ${e?.message ?? e}`);
      }
    }
    // The app in the emulator is its project folder: projects whose folder was deleted leave now, and the folders
    // are looked at every few seconds from here on.
    actions.watch();
    if (!windows.dismissed) windows.showDevice();
  } else if (state.name === "port-busy" || state.name === "failed" || state.name === "gave-up") {
    windows.showMessage();
  } else if (state.name === "starting" && ((state.slow && !windows.dismissed) || windows.current?.kind === "message")) {
    // A start without an answer for a while (the first one, or one after a death) shows that it is starting rather
    // than nothing or a dead page.
    windows.showMessage();
  }
}

function showAppSettingsAt(address) {
  windows.showLocalWeb(address);
  return true;
}

/** "App Settings": the bar's local web on its Apps tab, in its own window; an open one comes to the front. */
function showAppSettings() {
  if (trouble || keeper.state.name !== "ready") return false;
  windows.showLocalWeb(config.appSettingsUrl);
  return true;
}

/** How long a window that was just made may take to appear before a question gives up on it. */
const WINDOW_APPEARS_WITHIN_MS = 10_000;

/**
 * The app's main window, on the screen and in front of the other apps, for a question to the person to hang on:
 * an open one is restored and raised, a closed one is opened again (the device window, or the message page when the
 * server is not up). Null when the app shows no window (a hidden run) or none came up.
 */
// agent-path: what a publishing job of the window's flow says while it works, by project folder, for the command line
// that waits on it (publish push polls status with the folder): its latest line and the upload's numbers. In memory
// only; a job that ended stays a minute.
const publishProgress = new Map();
function notePublishProgress(job) {
  if (job?.kind !== "publish" || typeof job.folder !== "string") return;
  const before = publishProgress.get(job.folder) ?? {};
  publishProgress.set(job.folder, { state: job.state, line: job.line ?? before.line ?? null, upload: job.upload ?? before.upload ?? null, at: Date.now() });
  for (const [folder, one] of publishProgress) if (one.state !== "running" && Date.now() - one.at > 60_000) publishProgress.delete(folder);
}

/**
 * Stage 2 of publishing asked by the command line (busy-emulator publish signin|signout|push|pr, through the server):
 * done by the same flow as the window's. Pushing and opening the pull request are the person's decision: the app asks
 * them in a dialog of its own on its window first, and the catalog's author checklist is the dialog's checkbox, which
 * nothing ticks for them. Answers { answer: "done", value: { ok, … } }.
 */
async function githubForCli(question, signal) {
  const done = (value) => ({ answer: "done", value });
  const failed = (code, message, hint = null) => done({ ok: false, code, message, hint });
  const asAction = (answer) => (answer.ok ? done(answer.value?.ok === false ? answer.value : { ok: true, ...answer.value }) : failed(answer.error.code, answer.error.message, answer.error.hint));
  const flowAnswer = async (call) => {
    try {
      return done({ ok: true, ...(await call()) });
    } catch (e) {
      return failed(e?.code ?? "failed", String(e?.message ?? e), e?.hint ?? null);
    }
  };
  switch (question.op) {
    case "status":
      return flowAnswer(async () => ({ ...(await github.status()), ...(typeof question.folder === "string" ? { progress: publishProgress.get(question.folder) ?? null } : {}) }));
    case "signin":
      return flowAnswer(() => github.signIn());
    case "signin-existing": {
      // A program may not bind the emulator to GitHub CLI's account: the person agrees in the app's dialog, as for
      // publishing (person-question.mjs; security review F10).
      // agent-path: the account the caller names (publish signin --user <login>), one of GitHub CLI's; else the one it uses.
      const chosen = typeof question.login === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(question.login) ? question.login : null;
      const named = chosen ?? (await github.cliAccount().catch(() => null));
      if (!named) return failed("no_existing", "GitHub CLI on this computer is not signed in to GitHub.", "Run publish signin --new-account.");
      const asked = await askPerson.confirm(
        {
          about: "publish signin --use-existing",
          message: `Publish with GitHub CLI's account ${named}?`,
          detail: `A program on this computer (busy-emulator publish signin --use-existing, most likely your coding agent) asks to publish apps to GitHub with the account GitHub CLI on this computer is signed in as, ${named}.\n\nThis sign-in belongs to GitHub CLI on this computer: other programs, including AI agents, can use it too. The emulator's confirmations cover only its own commands; it asks you again before each upload and request.`,
          buttons: ["Cancel", `Use ${named}`],
          yes: 1,
        },
        signal,
      );
      if (asked.answer === "unavailable") return failed("window_hidden", `The person could not be asked: ${asked.reason}.`, "Open the BUSY Bar Emulator window, then run this again.");
      if (asked.answer !== "yes") return failed("refused", "The person chose Cancel: the emulator does not use GitHub CLI's account.", "Do not ask again unless the person tells you to.");
      return flowAnswer(() => github.useExisting({ expected: named, ...(chosen ? { login: chosen } : {}) }));
    }
    case "signin-wait":
      // The command line that goes away stops the sign-in it started.
      signal?.addEventListener("abort", () => github.cancelSignIn(), { once: true });
      return flowAnswer(() => github.waitSignIn());
    case "signout":
      return flowAnswer(() => github.signOut({ open: false }));
    case "push":
    case "request": {
      if (typeof question.folder !== "string") return failed("usage", "Name the project's folder.");
      const push = question.op === "push";
      // What will happen, named before the person is asked: where the files go and whether they replace a
      // repository's; which repository and commit the request names.
      let where = null;
      if (push) {
        const planned = await actions.call("github.name", { folder: question.folder, name: question.name ?? null });
        if (!planned.ok) return failed(planned.error.code, planned.error.message, planned.error.hint);
        if (planned.value?.ok === false) return done(planned.value);
        where = planned.value;
        // The person's own repository, not published to from here, and one with commits the project lacks (catalog-update):
        // publishing into it is confirmed in the window, which names what changes.
        if (where.mode === "existing") return failed("confirm_existing", `You have github.com/${where.owner}/${where.name} already, and this project was not published to it from here.`, "Publish into it from the app's window (Publish, GitHub), which asks first; or run it with --name <another name>.");
        if (where.mode === "diverged") return failed("remote_ahead", `github.com/${where.owner}/${where.name} has commits this project doesn't have, made on GitHub or on another computer. Nothing was sent.`, "Import it again in Create app (Import from GitHub), carry the changes over and publish from there.");
        if (where.mode === "taken") return failed("name_taken", `You have a repository named ${where.name} already, and this project was not published to it from here.`, where.suggestion ? `Run it with --name ${where.suggestion}, a free name.` : "Run it with --name <another name>.");
      }
      const target = push ? null : github.requestTarget(question.folder);
      // The catalog as the request will name it, parsed before the person sees it (security review F6).
      let catalog = null;
      if (!push) {
        const facts = question.catalog === undefined ? await actions.call("publish.status", question.folder) : null;
        catalog = parseCatalog(question.catalog ?? (facts?.ok ? facts.value?.catalog : null) ?? "busy-app/busy-apps-catalog");
      }
      if (!push && !catalog) return failed("bad_catalog", "The catalog is a GitHub repository: owner/name, or its address.", "Run it with --catalog owner/name.");
      if (!push && !target) return failed("not_pushed", "The app is not on GitHub from this computer yet.", "Run busy-emulator publish push first.");
      // The catalog's checklist, as its template says (read now, or the copy bundled with the app): shown whole in the
      // dialog, and its one tick is the person's for every required item of it; each optional item has its own.
      let list = null;
      if (!push) {
        try {
          list = await github.checklist({ catalog: `${catalog.owner}/${catalog.name}` });
        } catch (e) {
          return failed(e?.code ?? "failed", String(e?.message ?? e), e?.hint ?? null);
        }
      }
      // Asked as the trust question is (person-question.mjs): one question at a time, a dialog on the main window that
      // goes when the caller stops waiting, Cancel first and the default, and a yes within a second of the dialog's
      // appearing not taken. The server keeps the rest: 409 while a question is open, a pause after Cancel.
      // The questions of a request (publish-flow.mjs askRequest): the checklist with one tick for its required items,
      // then each optional item with its own checkbox, unticked (EMU-313); a catalog that is not BUSY's is named in the
      // first and asked about again by its name (security review L3). Only the person's ticks are sent.
      if (!push) {
        const named = `${catalog.owner}/${catalog.name}`;
        const asked = await askRequest({ confirm: askPerson.confirm, folder: question.folder, catalog, target, ai: question.ai, list }, signal);
        if (asked.answer === "unavailable") return failed("window_hidden", `The person could not be asked: ${asked.reason}.`, "Open the BUSY Bar Emulator window, then run this again.");
        if (asked.answer === "not_ticked") return failed("not_ticked", "The person did not tick the catalog's checklist: nothing was sent.", null);
        if (asked.answer !== "yes") return failed("refused", `The person chose Cancel: nothing was sent${asked.other ? ` to ${named}` : ""}.`, "Do not ask again unless the person tells you to.");
        return asAction(await actions.call("github.request", { folder: question.folder, catalog: named, ticked: asked.ticked, ai: question.ai, ...(asked.other ? { otherCatalog: named } : {}) }));
      }
      const asked = await askPerson.confirm(
        {
          about: `publish push ${question.folder}`,
          message: where.mode === "replace" ? `Replace the files of github.com/${where.owner}/${where.name}?` : `Publish this app to a new public repository, github.com/${where.owner}/${where.name}?`,
          detail: `${question.folder}\n\nA program on this computer (busy-emulator publish push, most likely your coding agent) asks to publish the project's files to ${where.mode === "replace" ? `github.com/${where.owner}/${where.name}, which this project was published to before: its files become the project's` : `a new public repository of your GitHub account, github.com/${where.owner}/${where.name}`}. Anyone can see them.`,
          buttons: ["Cancel", "Publish"],
          yes: 1,
          checkboxLabel: null,
        },
        signal,
      );
      if (asked.answer === "unavailable") return failed("window_hidden", `The person could not be asked: ${asked.reason}.`, "Open the BUSY Bar Emulator window, then run this again.");
      if (asked.answer !== "yes") return failed("refused", "The person chose Cancel: nothing was sent.", "Do not ask again unless the person tells you to.");
      return asAction(await actions.call("github.push", { folder: question.folder, name: where.name }));
    }
    default:
      return failed("usage", "No such step.");
  }
}

async function windowForQuestion() {
  if (config.hidden) return null;
  showAgain();
  const win = windows.current?.win;
  if (!win) return null;
  // A window just made appears once its page has something to show.
  const deadline = Date.now() + WINDOW_APPEARS_WITHIN_MS;
  while (!win.isDestroyed() && !win.isVisible() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (win.isDestroyed() || !win.isVisible() || windows.current?.win !== win) return null;
  if (win.isMinimized()) win.restore();
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
  return win;
}

/**
 * The device window for busy-emulator record: shown, restored and in front (a closed one is opened again), with the
 * scale of its screen; or why it cannot be had. A hidden run shows nothing: its window is recorded as it is made.
 */
async function windowForRecording() {
  if (trouble || keeper.state.name !== "ready") return { reason: "the emulator is not ready" };
  if (config.hidden) {
    if (!windows.current) windows.showDevice();
  } else showAgain();
  const entry = windows.current;
  if (!entry?.win) return { reason: "the app has no window" };
  if (entry.kind !== "device") return { reason: "the app's window shows a message, not the BUSY Bar" };
  const win = entry.win;
  const deadline = Date.now() + WINDOW_APPEARS_WITHIN_MS;
  while (!win.isDestroyed() && !(entry.presented && (config.hidden || win.isVisible())) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (win.isDestroyed() || !entry.presented || (!config.hidden && !win.isVisible())) return { reason: "the app's window did not come up" };
  if (!config.hidden && win.isMinimized()) win.restore();
  return { win, scale: screen.getDisplayMatching(win.getBounds()).scaleFactor };
}

function showAgain() {
  if (windows.focus()) return;
  if (trouble || ["port-busy", "failed", "gave-up", "starting"].includes(keeper.state.name)) windows.showMessage();
  else if (keeper.state.name === "ready") windows.showDevice();
}

// The mirror the command line reads (run/emulator.json): which process the emulator is, where its bar listens and
// what state it is in. It is a mirror only; the app takes no commands through it.
let lastMirrored = null;
let mirroredSince = 0;
function mirrorState(state) {
  // `since` is when this state began: a rewrite for a new notice does not move it.
  if (state !== lastMirrored) {
    lastMirrored = state;
    mirroredSince = Date.now();
  }
  try {
    writeRunState(config.runStateFile, {
      pid: process.pid,
      exe: process.execPath,
      started: startedAt,
      port: config.port,
      url: `http://127.0.0.1:${config.port}`,
      state: state.name,
      detail: state.detail ?? state.reason ?? null,
      since: mirroredSince,
      ...(updateNotice ? { update: { version: updateNotice.version } } : {}),
    });
  } catch (e) {
    log(`[shell] could not write ${config.runStateFile}: ${e.message}`);
  }
}

// The launcher of the command line and the pointer file, rewritten at every start (ADR-0002, sections 7 and 7a).
function writeInstall() {
  if (!config.installFiles) return;
  const result = writeInstallFiles(config.installFiles, { platform: process.platform, version: app.getVersion() });
  if (result.ok) log(`[shell] command line: ${config.installFiles.launcher} (pointer ${config.installFiles.pointer})`);
  else log(`[shell] could not write the command line's launcher or pointer: ${result.error}`);
}

function setMenu() {
  // The menu proper is EMU-213; menu.mjs has what the first cut needs.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        platform: process.platform,
        appName: APP_NAME,
        updateCheck: { allowed: updates.allowed, enabled: updates.enabled() },
        onAppSettings: () => void showAppSettings(),
        onUpdateCheck: (on) => updates.setEnabled(on),
        onNewApp: () => newApp(),
        onOpenApp: () => void fromMenu("projects.open"),
        onReportBug: () => void reportBug(),
        onOpenDocs: (address) => openDocs(address),
      }),
    ),
  );
}

async function start() {
  session.defaultSession.protocol.handle(APP_SCHEME, createAppSchemeHandler(here));
  // The windows' sessions reach the server's address and nothing else; any other session reaches nothing. The local
  // web has a session of its own (its storage is apart from the device window's), made here, before the rules, so
  // that its network is closed before its window can exist.
  const server = new URL(config.windowUrl).host;
  const localWeb = session.fromPartition(LOCAL_WEB_PARTITION);
  // The page that encodes a clip: its own session in memory, which reaches nothing (no address is named for it below).
  const capture = session.fromPartition(CAPTURE_PARTITION);
  capture.protocol.handle(APP_SCHEME, createAppSchemeHandler(here));
  // Its requests to Iconify's API for the Lucide icons are answered from the app's own file. The handler takes every
  // https: request of that session and passes none on.
  localWeb.protocol.handle("https", answerIcons);
  await installSecurity({
    app,
    session: session.defaultSession,
    sessions: [localWeb, capture],
    registry,
    log,
    addressesOf: (ses) => (ses === session.defaultSession || ses === localWeb ? [server] : []),
    answeredInside: (ses) => (ses === localWeb ? isIconRequest : null),
    pagePreload: path.join(here, "page-preload.cjs"),
    // The device window's "App settings" (a link to the local web that asks for a new window) gets the local web's
    // window; a page of another window gets none.
    onWindowAsked: (contents, address) => registry.kindOf(contents) === "device" && windows.isLocalWebAddress(address) && showAppSettingsAt(address),
    onExternal: (contents, address) => void opener.open(address, contents),
    onInput: (contents, type) => {
      opener.input(contents, type);
      gestures.input(contents, type);
    },
  });
  ipcMain.handle(BRIDGE_CHANNEL, createBridge({ shell, kindOf: registry.kindOf, log, serverOrigin: originOf(config.windowUrl), gestures }));
  // The person came back to the app: a project folder may have gone meanwhile.
  app.on("browser-window-focus", () => void actions.look());
  const artFile = path.join(here, "pages", "capture", "busybar-device.png");
  clips = createClipEncoder({ BrowserWindow, ipcMain, registry, session: () => capture, dataDir: config.dataDir, preloadPath: path.join(here, "capture-preload.cjs"), art: existsSync(artFile) ? readFileSync(artFile) : null, windowFor: windowForRecording, log });
  setMenu();
  nativeTheme.on("updated", () => windows.retheme());
  keeper.on("state", showForState);
  keeper.on("state", mirrorState);

  if (testVariant && config.testHook) {
    const { connectTestHook } = await import("../test-variant/hook.mjs");
    await connectTestHook(config.testHook, shell);
  }

  log(`[shell] started: ${APP_NAME} ${app.getVersion()}, Electron ${process.versions.electron}, ${process.platform} ${process.arch}`);

  // Before anything else: an app that macOS runs from a random read-only place asks to be moved.
  if (config.checkLocation) {
    const location = checkAppLocation({
      platform: process.platform,
      bundlePath: config.appLocation ?? bundlePathOf(app.getPath("exe")),
      homeDir: os.homedir(),
    });
    if (!location.ok) {
      log(`[shell] the app must be moved: ${location.reason} (${location.path})`);
      trouble = { name: "move-app", reason: location.reason, path: location.path };
      mirrorState(trouble);
      windows.showMessage();
      return;
    }
  }
  // Only from a place that stays: from a random one, the launcher would name a path that is gone after this run.
  writeInstall();
  updates.start();
  await keeper.start();
}

// ---------------------------------------------------------------- one instance
if (!app.requestSingleInstanceLock()) {
  // The app is running already: it has been told to come to the front; this process has nothing to do.
  app.exit(0);
} else {
  app.on("second-instance", () => {
    shell.secondLaunches += 1;
    log(`[shell] launched again: the window comes to the front (server: ${keeper.state.name})`);
    showAgain();
  });
  app.on("activate", showAgain);

  // ---------------------------------------------------------------- quitting
  // Quit waits for the server to stop; the process does not end with a server left behind.
  let serverStopped = false;
  let quitting = false;
  app.on("before-quit", (event) => {
    if (serverStopped) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    log("[shell] quitting");
    // The jobs of the window's projects (a build, a development loop) end with the app; a recording is deleted.
    actions.endAll();
    captureActions.endAll();
    // A sign-in under way: its gh would wait for the code for up to 15 minutes more.
    github.cancelSignIn();
    keeper.stop().finally(() => {
      serverStopped = true;
      app.quit();
    });
  });
  // A terminate signal (busy-emulator quit on macOS) Electron itself turns into a quit, through before-quit above, as
  // the menu's Quit; test/app/bundled.test.mjs holds it to that.
  // The last resort for an exit that did not come through quit. On every way out the mirror of the state goes: the
  // command line must not take a gone app for a running one.
  process.on("exit", () => {
    actions.endAll();
    captureActions.endAll();
    keeper.killNow();
    try {
      removeRunState(config.runStateFile);
    } catch {
      // Nothing more can be done on the way out.
    }
  });
  process.on("uncaughtException", (e) => {
    log(`[shell] uncaught: ${e?.stack ?? e}`);
    actions.endAll();
    keeper.killNow();
    app.exit(1);
  });

  app.on("window-all-closed", () => {
    // The custom of each system; what stays in the tray and when is EMU-213.
    if (process.platform !== "darwin") app.quit();
  });

  app.whenReady().then(start).catch((e) => {
    log(`[shell] did not start: ${e?.stack ?? e}`);
    keeper.killNow();
    app.exit(1);
  });
}
