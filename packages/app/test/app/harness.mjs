// Starts the shell for a test and talks to it through the test entry of the test variant (test-variant/hook.mjs).
//
// Every launch gets its own data folder and its own socket; close() ends the app if the test did not, checks that no
// process and no listener is left, and removes the folder.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants as fsConstants, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

import { APP_DIR, CHROMIUM_GONE_WITHIN_MS, describeProcess, endOnExit, endTree, FAKE_SERVER, HAS_REAL_SERVER, listening, namedAfterExit, NODE, PORTS, processTree, REAL_SERVER, removeFolder, survivors, temporaryFolder, until } from "../helpers.mjs";
import { buildKindOf, inSourceTree, readBuildMarker } from "../../src/build-kind.mjs";
import { GESTURE_MS } from "../../src/external.mjs";
import { connectedInNetLog, connectedSocket, shortCommand, watchSockets } from "./sockets.mjs";

/**
 * The tests keep the app off the screen: windows are made but never shown, and the app stays out of the Dock and the
 * taskbar, so they can run on a machine somebody is using. BUSY_EMULATOR_TEST_VISIBLE=1 runs them with real windows
 * and adds the few tests that need a window on the screen.
 */

/**
 * The clicks the page of the current window has dispatched, counted once each click's handlers have all run (a
 * listener of the window's capture phase, which a handler's stopPropagation does not stop, counts in the next task),
 * and which page counted them (app.clickAt).
 */
const CLICKS = `(() => {
  if (!window.__testClicks) {
    const clicks = { page: Math.random(), n: 0 };
    window.__testClicks = clicks;
    window.addEventListener("click", () => setTimeout(() => (clicks.n += 1), 0), true);
  }
  return { page: window.__testClicks.page, n: window.__testClicks.n };
})()`;

export const VISIBLE = Boolean(process.env.BUSY_EMULATOR_TEST_VISIBLE);
/** What every launch of the app in a test gets, the second launches included. */
export const QUIET_ENV = VISIBLE ? {} : { BUSY_EMULATOR_HIDDEN: "1" };

/**
 * The Electron binary the tests start. On macOS a hidden run needs more than the app's own good behavior: the
 * system puts every starting app in the Dock before any of its code runs, unless the bundle itself says it is an app
 * without a Dock icon. So hidden runs start a copy of Electron's bundle with that one line added to its Info.plist.
 * The copy is made once, beside the installed Electron, as a copy-on-write clone where the disk can do that; the
 * copies of earlier versions of Electron are removed then.
 */
function electronBinary() {
  const installed = createRequire(import.meta.url)("electron");
  const end = installed.indexOf(".app/");
  if (VISIBLE || process.platform !== "darwin" || end < 0) return installed;
  const bundle = installed.slice(0, end + 4);
  const version = JSON.parse(readFileSync(path.join(APP_DIR, "node_modules", "electron", "package.json"), "utf8")).version;
  // Named by when the installed executable was put in as well as by the version: Electron installed again under the
  // same version gets a copy of its own, not the old one (EMU-201 security review, S17). Its time of change is the
  // time of the install (the package's files all carry the same fixed time of modification).
  const copy = path.join(APP_DIR, "node_modules", ".cache", "busy-emulator-tests", `Electron-${version}-${Math.trunc(statSync(installed).ctimeMs)}-hidden.app`);
  if (!existsSync(copy)) {
    const making = `${copy}.making-${process.pid}`;
    mkdirSync(path.dirname(copy), { recursive: true });
    rmSync(making, { recursive: true, force: true });
    cpSync(bundle, making, { recursive: true, verbatimSymlinks: true, mode: fsConstants.COPYFILE_FICLONE });
    execFileSync("/usr/bin/plutil", ["-insert", "LSUIElement", "-bool", "true", path.join(making, "Contents", "Info.plist")]);
    // Whole or not at all: the copy appears under its name only when it is complete.
    try {
      renameSync(making, copy);
    } catch (e) {
      rmSync(making, { recursive: true, force: true });
      if (!existsSync(copy)) throw e;
    }
    for (const old of readdirSync(path.dirname(copy))) {
      if (/^Electron-.+-hidden\.app$/.test(old) && old !== path.basename(copy)) rmSync(path.join(path.dirname(copy), old), { recursive: true, force: true });
    }
  }
  return path.join(copy, installed.slice(end + 5));
}

export const ELECTRON = electronBinary();
export { HAS_REAL_SERVER };

/**
 * The marker of the app a built executable would load, read as the app reads it: in its archive, or, where there is
 * none, in the app/ folder Electron would take instead. Null when there is none.
 */
async function markerInArchive(executable) {
  const resources = process.platform === "darwin" ? path.join(executable, "..", "..", "Resources") : path.join(path.dirname(executable), "resources");
  if (!existsSync(path.join(resources, "app.asar"))) return readBuildMarker(path.join(resources, "app"));
  const asar = await import("@electron/asar");
  try {
    return JSON.parse(asar.extractFile(path.join(resources, "app.asar"), "build.json").toString("utf8"));
  } catch {
    return null;
  }
}

let launches = 0;

/** How long close() waits for an app's answer about its processes and its quit before it goes on without them. */
const LEARN_PIDS_MS = 10_000;

/** A wait that keeps nobody's process alive. */
const giveUp = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

function hookAddress(folder) {
  launches += 1;
  return process.platform === "win32" ? `\\\\.\\pipe\\busy-emulator-test-${process.pid}-${launches}` : path.join(folder, "hook.sock");
}

/**
 * @param {object} [o]
 * @param {"fake" | "real" | string} [o.server]  which server the shell starts; a path names another entry
 * @param {number} [o.port]
 * @param {Record<string, string>} [o.env]       more environment: FAKE_SERVER_* switches, shell settings
 * @param {string} [o.appDir]                    the app's folder, when it is not this package
 * @param {string} [o.dataDir]                   reuse a data folder (a second launch of the same app)
 * @param {boolean} [o.welcomed]                 the first run's greeting already answered (app-settings.json)
 * @param {boolean} [o.hook]                     false: do not wait for the test entry (a launch that must not have one)
 * @param {string[]} [o.args]                    more command line arguments for Electron
 * @param {"loopback" | "open"} [o.network]      "open": this launch is meant to reach the network (see sockets.mjs)
 * @param {string} [o.executable]                a built app's own executable (the test variant built by tools/dist.mjs):
 *                                               it is started without an app folder, and "bundled" as the server
 *                                               leaves it its own Node and server
 */
export async function launch({ server = "fake", port = PORTS.app, env = {}, appDir = APP_DIR, dataDir = null, hook = true, args = [], network = "loopback", executable = null, welcomed = false } = {}) {
  // A launch the app would take for a release reads none of the test's settings and would use the user's own data
  // folder and port 8640: never. A built app's marker is the one inside its archive.
  const marker = executable ? await markerInArchive(executable) : readBuildMarker(appDir);
  if (buildKindOf({ marker, sourceTree: executable ? false : inSourceTree(appDir) }) === "release") {
    throw new Error(`${executable ?? appDir} would run as a release (no marker, not the source tree); mark it as the test variant`);
  }

  const ownsFolder = !dataDir;
  const folder = dataDir ?? temporaryFolder();
  // welcomed: the first run's greeting (EMU-207) already answered, as after a person's first run, so that it does not
  // cover the window of a test that clicks on it.
  if (welcomed) writeFileSync(path.join(folder, "app-settings.json"), `${JSON.stringify({ welcomed: true })}\n`);
  const address = hookAddress(folder);
  const reportFile = path.join(folder, `fake-report-${launches}.json`);
  let socket = null;
  let pending = new Map();
  let nextId = 1;
  let connected;
  const connection = new Promise((resolve) => (connected = resolve));

  const listener = net.createServer((incoming) => {
    socket = incoming;
    let rest = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        const answer = JSON.parse(line);
        const waiter = pending.get(answer.id);
        pending.delete(answer.id);
        if (answer.ok) waiter?.resolve(answer.value);
        else waiter?.reject(new Error(`in the app: ${answer.error}`));
      }
    });
    const drop = () => {
      for (const waiter of pending.values()) waiter.reject(new Error("the app closed the test entry"));
      pending = new Map();
    };
    incoming.on("close", drop);
    incoming.on("error", drop);
    connected(true);
  });
  await new Promise((resolve, reject) => listener.once("error", reject).listen(address, resolve));

  const serverEnv = server === "bundled" ? {} : { BUSY_EMULATOR_NODE: NODE, BUSY_EMULATOR_SERVER_ENTRY: server === "fake" ? FAKE_SERVER : server === "real" ? REAL_SERVER : server };
  // Chromium's log of the network, with its sockets and what made each one. On Windows always: netstat shows a UDP
  // socket Chromium connected to one peer as bound to every address, and only the log tells it apart (close(),
  // connectedInNetLog). BUSY_EMULATOR_TEST_NET_LOG=<folder> keeps the log of every launch there, as
  // net-<test process>-<launch>.json, for finding who opened a socket the checks of close() name.
  const netLogFolder = process.env.BUSY_EMULATOR_TEST_NET_LOG || (process.platform === "win32" ? temporaryFolder() : null);
  const netLogFile = netLogFolder ? path.join(netLogFolder, `net-${process.pid}-${launches}.json`) : null;
  const netLog = netLogFile ? [`--log-net-log=${netLogFile}`] : [];
  // Before the spawn: a process of the tree close() takes started after this (helpers.mjs, treeOf).
  const spawnedAt = Date.now();
  const child = endOnExit(spawn(executable ?? ELECTRON, executable ? [...args, ...netLog] : [appDir, ...args, ...netLog], {
    env: {
      ...process.env,
      BUSY_EMULATOR_PORT: String(port),
      BUSY_EMULATOR_DATA: folder,
      ...serverEnv,
      BUSY_EMULATOR_TEST_HOOK: address,
      FAKE_SERVER_REPORT: reportFile,
      // The first run's greeting would cover the window: only its own tests see it (welcome.test.mjs sets this to "").
      BUSY_EMULATOR_TEST_GREETED: "1",
      // No test touches the person's GitHub CLI: gh's configuration is a folder of the test's (publish-flow.mjs).
      BUSY_EMULATOR_GH_CONFIG_DIR: path.join(folder, "person", "gh"),
      // Nor the person's git settings: the name and address git config gives are a folder of the test's (EMU-366).
      BUSY_EMULATOR_GIT_HOME: path.join(folder, "person"),
      ...QUIET_ENV,
      ...env,
    },
    // Not the app's folder: nothing may depend on where the app was started from.
    cwd: folder,
    stdio: ["ignore", "ignore", "pipe"],
  }));
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  // The app's own processes (the supervisor, the server, what the server started) and Chromium's (the main process
  // and its helpers): they end in different ways and are given different times to do it.
  const own = new Set();
  const chromium = new Set([child.pid]);
  let asked = 0;
  async function learnPids() {
    if (socket && !socket.destroyed) {
      const now = await app
        .run((shell, electron) => ({ chromium: electron.app.getAppMetrics().map((m) => m.pid), own: Object.values(shell.keeper.pids() ?? {}) }))
        .catch(() => ({ chromium: [], own: [] }));
      for (const pid of now.chromium) if (pid) chromium.add(pid);
      for (const pid of now.own) if (pid) own.add(pid);
    }
    if (existsSync(reportFile)) {
      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      for (const pid of [report.pid, report.child]) if (pid) own.add(pid);
    }
    return [...chromium, ...own];
  }
  // What the app listens on, for as long as it lives. The app is asked for its processes a few times a second.
  const sockets = watchSockets(child.pid, async () => {
    if (Date.now() - asked < 300) return [...chromium, ...own];
    asked = Date.now();
    return learnPids();
  });
  // Once the app's main process has ended, what is left of it is close()'s to find; the watching ends (a test that
  // quit its app and goes on with another must not pay for listing the sockets of the first ten times a second).
  void exited.then(() => sockets.stop());

  const app = {
    pid: child.pid,
    port,
    folder,
    exited,
    logFile: path.join(folder, "logs", "shell.log"),
    log: () => (existsSync(app.logFile) ? readFileSync(app.logFile, "utf8") : ""),
    stderr: () => stderr,
    /** True once the app has connected to the test entry. */
    hooked: () => socket !== null,

    /** Runs fn(shell, electron, arg) in the app's main process and returns what it returns (as JSON). */
    run(fn, arg) {
      assert.ok(socket, "the app has not connected to the test entry");
      // An app that has gone answers nothing: say so rather than wait for ever.
      if (socket.destroyed) return Promise.reject(new Error("the app closed the test entry"));
      const id = nextId++;
      const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.write(`${JSON.stringify({ id, code: `return (${fn})(shell, electron, arg)`, arg })}\n`);
      return answer;
    },
    /** Runs code in the page of the current window, as if the user had done it. */
    page: (code) => app.run((shell, _electron, source) => shell.windows.current.win.webContents.executeJavaScript(source, true), code),
    /**
     * A key pressed in a window ("current": the main one; "local-web"), sent the way the system sends the person's
     * input (webContents.sendInputEvent), not from the page: what the shell takes for the person's own doing. The
     * key is Shift, which does nothing to a page.
     */
    press: (which = "current") =>
      app.run((shell, _electron, name) => {
        const contents = (name === "local-web" ? shell.windows.localWeb : shell.windows.current).win.webContents;
        contents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
        contents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
      }, which),
    /**
     * The person's key in the current window, then `code` run in its page, as one step of the app's main process, so
     * that what lies between the two is the page's own time, as for a person's key: not two trips between this
     * process and the app, which on a loaded machine have taken longer than the two seconds a key allows an action
     * (gestures.mjs; EMU-330: "the person's no in the trust dialog" got no_gesture on Windows).
     *
     * The page's own time can still run out (EMU-361). The key's time is taken when the main process sends it
     * (Chromium's input-event comes then), and the bridge checks it when the page's call arrives, after a trip through
     * the page: about 0.1 s on a fresh window, even with every core busy. A stall of the page or of the main process
     * longer than GESTURE_MS in between gets no_gesture, as it would for a person whose key the app took that late;
     * the Mac's gate of 18.11 had such stalls (other tests of that run took 3 to 11 times their usual time). So each
     * check of this window's gesture during the step is noted with its time (shell.gestures.allow, passed through).
     * When the first one was refused more than GESTURE_MS after the key, nothing with consequences has run: the key
     * is pressed once more and the step done again, and the test's output says so with the delay measured. A
     * refusal of the first check within GESTURE_MS of the key is no stall but a fault of the gesture, and fails the
     * step; a second stall in a row is returned as it is, for the test to fail on.
     */
    async act(code) {
      for (let attempt = 1; ; attempt += 1) {
        const step = await app.run((shell, _electron, source) => {
          const contents = shell.windows.current.win.webContents;
          const gestures = shell.gestures;
          const allow = gestures.allow;
          const checks = [];
          gestures.allow = (window) => {
            const allowed = allow(window);
            if (window === contents) checks.push({ allowed, at: Date.now() });
            return allowed;
          };
          const key = Date.now();
          contents.sendInputEvent({ type: "keyDown", keyCode: "Shift" });
          contents.sendInputEvent({ type: "keyUp", keyCode: "Shift" });
          return contents
            .executeJavaScript(source, true)
            .then((value) => ({ value, key, checks }))
            .finally(() => {
              gestures.allow = allow;
            });
        }, code);
        const first = step.checks[0];
        if (!first || first.allowed) return step.value;
        const delay = first.at - step.key;
        if (delay <= GESTURE_MS) throw new Error(`act: the app refused the key ${delay} ms after it, within the ${GESTURE_MS} ms a key allows: not a stall, a fault of the gesture`);
        if (attempt === 2) {
          console.error(`harness: act: the page asked ${delay} ms after the key pressed again too, past the ${GESTURE_MS} ms a key allows: the refusal is returned`);
          return step.value;
        }
        console.error(`harness: act: the page asked ${delay} ms after the key, past the ${GESTURE_MS} ms a key allows (a stall of the app): the key once more`);
      }
    },
    /** A click of the mouse at the middle of the element `selector` names in the current window's page, sent the same way. */
    async click(selector) {
      const at = await app.page(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
      await app.clickAt(at);
    },
    /**
     * A click of the mouse at a point of the current window's page, sent as the system sends the person's, and done:
     * it resolves once the page has dispatched the click and its handlers have run, not once it was sent. The input
     * reaches the page on a channel of its own, and a read of the page sent right after the click can come first: on
     * a loaded machine the test then read the page as it was before the click (EMU-294, publish: "How to use: write
     * what Back does" read as ""; a row's field not there yet).
     */
    async clickAt({ x, y }) {
      const before = await app.page(CLICKS);
      await app.run((shell, _electron, point) => {
        const contents = shell.windows.current.win.webContents;
        contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      }, { x, y });
      // Another page, or none (the click opened another window or closed this one), counts as done: its handlers ran
      // before it went.
      await until(async () => {
        const now = await app.page(CLICKS).catch(() => null);
        return now === null || now.page !== before.page || now.n > before.n;
      }, `the click at ${x}, ${y} to reach the page`, 60_000, 10);
    },
    state: () => app.run((shell) => shell.keeper.state),
    waitState: (name, timeoutMs = 30_000) => until(async () => (await app.state()).name === name, `the server state "${name}"`, timeoutMs),
    /** Waits for the one window to be of this kind, loaded and shown (in a hidden run: at the point where it would be). */
    waitWindow: (kind, timeoutMs = 30_000) =>
      until(
        () =>
          app.run((shell, electron, wanted) => {
            const current = shell.windows.current;
            const all = electron.BrowserWindow.getAllWindows();
            const shown = current?.presented && current.win.isVisible() === !shell.config.hidden;
            return all.length === 1 && current?.kind === wanted && shown && !current.win.webContents.isLoading() && current.win.webContents.getURL() !== "";
          }, kind),
        `the ${kind} window`,
        timeoutMs,
      ),
    /** Every process of the app that is known so far: Electron's own, the supervisor, the server, the fake's child. */
    pids: learnPids,
    fakeReport: () => until(() => existsSync(reportFile) && JSON.parse(readFileSync(reportFile, "utf8")), "the fake server's report"),

    /** Quits the way the menu does and waits for the process to end. */
    async quit() {
      await app.pids();
      await app.run((_shell, electron) => void setImmediate(() => electron.app.quit()));
      return exited;
    },

    /** Ends an app that has no test entry: a terminate signal, or on Windows, where there is none, the end of the process. */
    async terminate() {
      child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      return exited;
    },

    /**
     * Ends the test's use of the app: nothing may be left of it, and it must have kept to this machine. Whatever the
     * app left is ended before anything is checked — its whole tree of processes (what its main process started, the
     * development loop's command line among them, and what that started), not only the processes the app names —
     * and the folder is removed, so that a failed check here fails this one test and leaves nothing to the next. A
     * second call answers as the first.
     */
    close() {
      closing ??= closeOnce();
      return closing;
    },
  };
  let closing = null;

  async function closeOnce() {
    // The tree while its root runs: a process whose parent has ended is not found below it any more (Windows). Only
    // while this ChildProcess has not ended: after its exit the number may be another process's already (Windows
    // gives numbers again soon), whose tree this must not take (EMU-330 review); and only processes started since
    // the spawn.
    const tree = child.exitCode === null && child.signalCode === null ? await processTree([child.pid], { since: spawnedAt }) : [];
    // An app that no longer answers (its main process stuck) must not hold the test here: what it would say is
    // only more PIDs.
    await Promise.race([learnPids(), giveUp(LEARN_PIDS_MS)]);
    if (child.exitCode === null && child.signalCode === null) {
      if (socket && !socket.destroyed) await Promise.race([app.run((_shell, electron) => void setImmediate(() => electron.app.quit())).catch(() => {}), giveUp(LEARN_PIDS_MS)]);
      const left = await survivors([child.pid], CHROMIUM_GONE_WITHIN_MS);
      if (left.length) child.kill("SIGKILL");
    }
    await exited;
    const seen = await sockets.stop();
    socket?.destroy();
    await new Promise((resolve) => listener.close(resolve));
    // Each process with the time it is given to end by itself: Chromium's (its helpers, which the main process names,
    // and its crash handler, which it does not) the longer one; the app's own (the supervisor, the server) and the
    // rest of the tree (the command lines the window's actions started, and what they started) the shorter one.
    // The main process has ended here: its number is not looked at again (namedAfterExit).
    const after = namedAfterExit({ own, chromium, main: child.pid });
    const chromiumOf = (p) => after.chromium.includes(p.pid) || /--type=|crashpad/i.test(p.command ?? "");
    const named = new Set([...after.own, ...after.chromium, child.pid]);
    const others = tree.filter((p) => !named.has(p.pid));
    const leftPids = (
      await Promise.all([
        survivors([...after.own, ...others.filter((p) => !chromiumOf(p)).map((p) => p.pid)]),
        survivors([...after.chromium, ...others.filter(chromiumOf).map((p) => p.pid)], CHROMIUM_GONE_WITHIN_MS),
      ])
    ).flat();
    const byPid = new Map(tree.map((p) => [p.pid, p]));
    const left = leftPids.map((pid) => (byPid.get(pid)?.command ? `${pid} (${shortCommand(byPid.get(pid).command)})` : describeProcess(pid)));
    await endTree(leftPids.map((pid) => byPid.get(pid) ?? { pid, started: null }));
    // Said on the test's output as well: when the test has already failed (its time was up), node:test shows that
    // failure and not this one.
    if (left.length) console.error(`harness: ended ${left.length} processes the app left: ${left.join(", ")}`);
    // A UDP socket Chromium connected to one peer takes datagrams from that peer alone: on Windows only its log says
    // which sockets those were (sockets.mjs, connectedInNetLog).
    const connected = netLogFile && seen.sockets.length && existsSync(netLogFile) ? connectedInNetLog(readFileSync(netLogFile, "utf8")) : [];
    const excused = seen.sockets.filter((one) => chromium.has(one.pid) && connectedSocket(one, connected));
    for (const one of excused) console.error(`harness: ${one.protocol} ${one.local} of ${one.pid} is a socket Chromium connected to one peer (its net log): not reachable from the network`);
    const reachable = seen.sockets.filter((one) => !excused.includes(one)).map((one) => `${one.protocol} ${one.local}`).sort();
    if (netLogFolder && !process.env.BUSY_EMULATOR_TEST_NET_LOG) await removeFolder(netLogFolder);
    const portTaken = await listening(port);
    if (ownsFolder) await removeFolder(folder);
    assert.deepEqual(left, [], `processes left behind by the app, ended now (stderr: ${stderr.slice(-400)})`);
    assert.equal(portTaken, false, `port ${port} is still taken after the app ended`);
    assert.ok(seen.samples > 0, "the app's sockets were never looked at");
    if (network === "loopback") {
      assert.deepEqual(reachable, [], `the app listened on an address other than 127.0.0.1 and ::1: the network can reach it, and on Windows the firewall asks about it${seen.owners.length ? ` (${seen.owners.join("; ")})` : ""}`);
    }
  }

  if (hook) {
    await Promise.race([
      connection,
      exited.then(async ({ code, signal }) => {
        // Only for an app that never connected: one that did is ended and cleaned up by close().
        if (socket) return;
        // Nothing of this launch may keep the test's process alive: the test fails here, it does not hang.
        await sockets.stop().catch(() => {});
        await new Promise((resolve) => listener.close(resolve));
        if (netLogFolder && !process.env.BUSY_EMULATOR_TEST_NET_LOG) await removeFolder(netLogFolder);
        if (ownsFolder) await removeFolder(folder);
        throw new Error(`the app ended before it connected to the test entry (code ${code}, signal ${signal}): ${stderr.slice(-800)}`);
      }),
    ]);
  }
  return app;
}
