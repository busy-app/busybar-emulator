// The emulator's life as the command line sees it: is it running, start it, end it. The app writes a mirror of its
// state (run/emulator.json in the data folder: pid, start, port, the server's state). The mirror is data, not a
// trusted source: it may be left behind by an app that did not end cleanly (on Windows after every quit), and anyone
// who can write the data folder can write it. So every command goes through one check, runningApp(): the process it
// names is alive, started when the mirror says, and is this copy's app. The app takes no commands through the mirror.
import path from "node:path";

import { APP_NAME } from "./context.mjs";
import { CliError, pasteForms, selfCall } from "./output.mjs";

export const START_TIMEOUT_MS = 60_000;
export const QUIT_TIMEOUT_MS = 30_000;
const STEP_MS = 250;
/**
 * How the start of the process may lie around the start the app wrote: the app writes it once its code runs, a moment
 * after the process began (Electron loads first); `ps` gives the start to the second.
 */
export const STARTED_BEFORE_MS = 60_000;
export const STARTED_AFTER_MS = 1500;

/** How to run this command line again, for the texts. */
export function commandLine(ctx) {
  return selfCall(pasteForms(ctx.calledAs, ctx.platform));
}

/** The mark `start` leaves while it waits for the app (system.mjs writeStartMark), beside the mirror. */
export function startMarkFile(ctx) {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  return p.join(p.dirname(ctx.runStateFile), "starting.json");
}

/** How much longer than a start can last its mark is believed: after that it is some other process's number. */
const START_MARK_SLACK_MS = 30_000;

/** Whether a `start` of this command line is waiting for the app right now, by its mark: its process is alive. */
export function startUnderWay(ctx, sys) {
  const mark = sys.readStartMark?.(startMarkFile(ctx));
  if (!mark || mark.quit || mark.pid === sys.pid?.()) return false;
  const age = sys.now() - mark.at;
  return age >= -START_MARK_SLACK_MS && age < START_TIMEOUT_MS + START_MARK_SLACK_MS && sys.alive(mark.pid);
}

/** The note a quit leaves when it found nothing to quit (system.mjs writeQuitNote), beside the mirror. */
export function quitNoteFile(ctx) {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  return p.join(p.dirname(ctx.runStateFile), "quit-asked.json");
}

function logFile(ctx) {
  return (ctx.platform === "win32" ? path.win32 : path.posix).join(ctx.dataDir, "logs", "shell.log");
}

function blockedFile(ctx, code) {
  return new CliError(
    "blocked_file",
    `This process may not read ${ctx.runStateFile} (${code}): a sandbox is in the way.`,
    "Run the same busy-emulator command again outside the sandbox.",
  );
}

export function blockedNetwork(port, code) {
  return new CliError(
    "blocked_network",
    `This process may not connect to 127.0.0.1:${port} (${code}): a sandbox is in the way.`,
    "Run the same busy-emulator command again outside the sandbox: it needs to reach 127.0.0.1.",
  );
}

/**
 * The executable a process of this copy's app runs. A release knows its own; the test variant and a development run
 * take the one the mirror names (their app is Electron from npm), so a stale mirror still fails on a reused number.
 */
export function appExecutable(ctx, state) {
  if (ctx.kind === "release") return ctx.platform === "win32" ? ctx.appPath : path.posix.join(ctx.appPath, "Contents", "MacOS", APP_NAME);
  return typeof state.exe === "string" && state.exe ? state.exe : null;
}

/**
 * Whether the mirror describes this copy's app, running now. The one check every command makes before it believes the
 * mirror (status, start, quit).
 * @returns {{ ours: true } | { ours: false, why: string } | { unknown: true }}
 */
export function runningApp(ctx, sys, state) {
  const { pid, started } = state;
  if (!Number.isInteger(pid) || pid <= 1 || !Number.isFinite(started)) return { ours: false, why: "the mirror names no usable process" };
  if (!sys.alive(pid)) return { ours: false, why: "its process is gone" };
  const info = sys.processInfo(pid, ctx.platform, ctx.windowsDir);
  if (!info) return { unknown: true };
  // A number taken over by another program after the emulator died: that program started at another time.
  if (info.start > started + STARTED_AFTER_MS || info.start < started - STARTED_BEFORE_MS) return { ours: false, why: "its process started at another time" };
  const expected = appExecutable(ctx, state);
  if (expected === null ? ctx.kind === "release" : !sys.samePath(info.exe, expected, ctx.platform)) return { ours: false, why: "its process is another program" };
  return { ours: true };
}

/** A version as the app writes it into the mirror: three numbers, then an optional pre-release ("0.1.0-beta.2"). */
const UPDATE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/;
/** The page of a release among the emulator's own; built here from the version, never taken from the mirror. */
export const RELEASE_PAGE = "https://github.com/busy-app/busybar-emulator/releases/tag/";

/**
 * The newer version of the emulator the app has found (it asks GitHub at its start, update-check.mjs) and wrote into
 * its mirror: { version, url }, or null when it found none or the mirror says anything else.
 */
export function updateOf(state) {
  const version = state?.update?.version;
  return typeof version === "string" && UPDATE_VERSION.test(version) ? { version, url: `${RELEASE_PAGE}v${version}` } : null;
}

/** The port to look at: the mirror's, or the bar's own when there is none. */
function portOf(ctx, read) {
  const port = read.state?.port;
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : (ctx.defaultPort ?? 8640);
}

/**
 * What the emulator is doing now. The bar's address is asked first, mirror or not: in a sandbox that closes loopback
 * even a closed port answers EPERM, so the sandbox is named before anything else is tried.
 * @returns {Promise<{ running: boolean, state?: string, detail?: string|null, answering?: boolean, pid?: number, port?: number, url?: string }>}
 */
export async function emulatorStatus(ctx, sys) {
  const read = sys.readRunState(ctx.runStateFile);
  if (read.blocked) throw blockedFile(ctx, read.blocked);
  const port = portOf(ctx, read);
  const answer = await sys.probe(port);
  if (answer.blocked) throw blockedNetwork(port, answer.blocked);
  if (read.missing || read.invalid) return { running: false };
  const { state } = read;
  if (!runningApp(ctx, sys, state).ours) return { running: false };
  return { running: true, state: state.state, detail: state.detail ?? null, answering: answer.answering, pid: state.pid, port: state.port, url: state.url, started: state.started, update: updateOf(state) };
}

/** A state of the app's server in which it will not become ready without a person: the error to give for it. */
function troubleOf(status, ctx) {
  const detail = status.detail ? ` (${status.detail})` : "";
  switch (status.state) {
    case "port-busy":
      return new CliError(
        "port_busy",
        `Port ${status.port} is in use by another program, so the emulated BUSY Bar cannot listen there.`,
        "Stop the other program (most likely another copy of the emulator), then run start again.",
      );
    case "failed":
    case "gave-up":
      return new CliError(
        "server_failed",
        `The emulator is running, but its server did not start${detail}.`,
        `The log is at ${logFile(ctx)}. Choose Try again in the emulator's window or run quit and then start.`,
      );
    case "move-app":
      return new CliError(
        "move_app",
        `The emulator cannot work from where it is${detail}: macOS runs it from a temporary read-only place or from Downloads.`,
        "Quit the emulator, move BUSY Bar Emulator to the Applications folder and run start again.",
      );
    default:
      return null;
  }
}

export const ready = (status) => status.running && status.state === "ready" && status.answering;

/**
 * Starts the emulator if it is not running and waits until its bar answers. Seam for EMU-217: the commands that need
 * the emulator call this first. An emulator that runs and is ready is left as it is, unless `bringForward` (only the
 * start command sets it): then it is started again, which brings its window to the front. A command an agent calls
 * again and again must not pull the window over what the person is doing (EMU-019b review, S1).
 * @returns {Promise<{ alreadyRunning: boolean, status: object }>}
 */
export async function ensureRunning(ctx, sys, { timeoutMs = START_TIMEOUT_MS, bringForward = false } = {}) {
  // A quit asked after this process began, which found no app yet: this start is what it meant (quitNoteFile).
  const began = sys.startedAt?.() ?? sys.now();
  const quitAsked = () => {
    const note = sys.readQuitNote?.(quitNoteFile(ctx)) ?? null;
    return note !== null && note.at >= began;
  };
  const before = await emulatorStatus(ctx, sys);
  if (ready(before) && !bringForward) return { alreadyRunning: true, status: before };
  if (!ctx.appPath && !ctx.testLaunch) {
    if (ready(before)) return { alreadyRunning: true, status: before };
    throw new CliError(
      "no_app",
      "This command line is not inside the emulator app: it runs from the source folder.",
      "Start the emulator from its folder (npm start in emulator/packages/app), or use the command line inside the app.",
    );
  }
  // The mark of a start under way, for a quit that comes before the app has written its mirror (quitEmulator). A
  // quit that ends the app says so in the mark: `quitCame()`.
  const markFile = startMarkFile(ctx);
  const me = sys.pid?.() ?? null;
  const marked = me !== null && sys.writeStartMark?.(markFile, { pid: me, at: sys.now() }) === true;
  const quitCame = () => {
    const mark = marked ? sys.readStartMark(markFile) : null;
    return mark !== null && mark.pid === me && mark.quit === true;
  };
  const interrupted = (pid, byQuit = false) =>
    new CliError(
      "start_interrupted",
      byQuit
        ? `A quit command came while the emulator was starting, so this start ended it${pid === null ? "" : ` (process ${pid})`}: the emulator is not running.`
        : `The emulator${pid === null ? "" : ` (process ${pid})`} ended before its BUSY Bar was ready: it was quit while it was starting (a quit command, or a person), or it failed.`,
      byQuit ? "Run start again when you want it running." : `Run start again when you want it running; if it ends by itself again, the log is at ${logFile(ctx)}.`,
      { pid },
    );
  try {
    try {
      await sys.launchApp(ctx);
    } catch (e) {
      throw new CliError("start_failed", `Could not start ${ctx.appPath ?? "the emulator"}: ${String(e.message).replace(/\.$/, "")}.`, "Open the emulator by hand once to see what the system says.");
    }
    if (before.running) {
      const trouble = troubleOf(before, ctx);
      if (trouble) throw trouble;
    }
    const deadline = sys.now() + timeoutMs;
    // The app's process, once its mirror has named it: when it is gone before the bar answered, the app has ended
    // (quit was called meanwhile, a person closed it, or it failed), and waiting the whole time out tells nobody so.
    let seen = before.running ? before.pid : null;
    for (;;) {
      const now = await emulatorStatus(ctx, sys);
      if (quitAsked()) {
        // The quit found nothing and said so; the app this start launched is ended here, as soon as it names itself.
        const app = appToQuit(ctx, sys);
        if (app) {
          await endApp(ctx, sys, app.pid, QUIT_TIMEOUT_MS);
          throw interrupted(app.pid, true);
        }
        if (seen !== null && !sys.alive(seen)) throw interrupted(seen, true);
      } else if (ready(now)) return { alreadyRunning: ready(before), status: now };
      if (now.running) {
        seen = now.pid;
        const trouble = troubleOf(now, ctx);
        if (trouble) throw trouble;
      } else if (seen !== null && !sys.alive(seen)) {
        throw interrupted(seen);
      } else if (quitCame()) {
        // The app came up and was quit between two looks of this loop: its mirror was never seen here.
        throw interrupted(null);
      }
      if (sys.now() >= deadline) {
        throw new CliError(
          "start_timeout",
          `The emulator did not become ready within ${Math.round(timeoutMs / 1000)} s.`,
          `Look at its window, or at the log at ${logFile(ctx)}.`,
        );
      }
      await sys.sleep(STEP_MS);
    }
  } finally {
    if (marked) sys.removeStartMark?.(markFile, me);
  }
}

/**
 * The app the mirror names, if it is this copy's and runs: what quit ends.
 * @returns {{ pid: number } | null}
 */
function appToQuit(ctx, sys) {
  const read = sys.readRunState(ctx.runStateFile);
  if (read.blocked) throw blockedFile(ctx, read.blocked);
  if (read.missing || read.invalid) return null;
  const { pid } = read.state;
  const verdict = runningApp(ctx, sys, read.state);
  if (verdict.unknown) {
    throw new CliError("quit_failed", `Could not tell whether process ${pid} is the emulator: the system would not describe it.`, "Quit the emulator from its menu.");
  }
  // Not ours (a stale or forged mirror): nothing is ended.
  return verdict.ours ? { pid } : null;
}

/**
 * Ends the emulator and waits until its process is gone. A start that is under way is not left behind: an app that
 * was started a moment ago has no mirror yet, so while a `start` of this command line waits for it (its mark,
 * startUnderWay) quit waits too, until the app has named itself, and ends it then; the start sees its app gone and
 * ends with start_interrupted. Without this a quit a fraction of a second after a start said "not running" and the
 * emulator came up and stayed (the release rehearsal).
 * @returns {Promise<{ wasRunning: boolean, pid?: number, duringStart?: boolean }>}
 */
export async function quitEmulator(ctx, sys, { timeoutMs = QUIT_TIMEOUT_MS, startWaitMs = START_TIMEOUT_MS } = {}) {
  let found = appToQuit(ctx, sys);
  const duringStart = startUnderWay(ctx, sys);
  if (!found && duringStart) {
    const waitUntil = sys.now() + startWaitMs;
    while (!found && sys.now() < waitUntil && startUnderWay(ctx, sys)) {
      await sys.sleep(STEP_MS);
      found = appToQuit(ctx, sys);
    }
    // The start has ended meanwhile: its app may have come up in its last step.
    found ??= appToQuit(ctx, sys);
  }
  if (!found) {
    // For a start that is on its way but has shown nothing yet (its process began, its mark is not written): it ends
    // its app when it sees this.
    sys.writeQuitNote?.(quitNoteFile(ctx), { at: sys.now() });
    return { wasRunning: false };
  }
  const { pid } = found;
  if (!(await endApp(ctx, sys, pid, timeoutMs))) return { wasRunning: false };
  // The start that was waiting for this app learns of it here, even if it never saw the app's mirror.
  if (duringStart) sys.quitStartMark?.(startMarkFile(ctx));
  return { wasRunning: true, pid, duringStart };
}

/** Ends the app's process and waits until it is gone. False when it was gone already. */
async function endApp(ctx, sys, pid, timeoutMs) {
  // What the app's server would remove when it stops, read while it still runs (see below).
  const serverFiles = sys.serverFilesOf?.(ctx.dataDir);
  try {
    sys.terminate(pid, ctx.platform);
  } catch (e) {
    if (e?.code === "ESRCH") return false;
    throw new CliError("quit_failed", `Could not end process ${pid}: ${e.message}.`, e?.code === "EPERM" ? "Run the same busy-emulator command again outside the sandbox." : "Quit the emulator from its menu.");
  }
  const deadline = sys.now() + timeoutMs;
  while (sys.alive(pid)) {
    if (sys.now() >= deadline) throw new CliError("quit_timeout", `The emulator (process ${pid}) did not end within ${Math.round(timeoutMs / 1000)} s.`, "Quit it from its menu.");
    await sys.sleep(STEP_MS);
  }
  // On Windows the app is ended without its own clean-up: its mirror stays, and so do the lock and the key of its
  // server, which goes with the app before it can remove them. They go here, as a quit from the app's menu leaves it.
  sys.removeRunStateOf(ctx.runStateFile, pid);
  if (serverFiles) await sys.removeServerFilesOf?.(ctx.dataDir, serverFiles);
  return true;
}
