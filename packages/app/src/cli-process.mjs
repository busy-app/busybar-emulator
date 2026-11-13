// One run of the command line busy-emulator on the bundled Node, for the window's actions (actions.mjs): the shell
// does to a project what the command line does, by running the command line. Nothing here knows about Electron.
//
// On macOS and Linux the run leads a process group of its own, so that what it started (npm, the project's busy-cli)
// is in it and goes with it; on Windows the processes Node starts die with it (libuv's job object).
import path from "node:path";

import { startShellProgram } from "./processes.mjs";

import { serverEnvironment } from "./server-process.mjs";

const posix = process.platform !== "win32";
/** How many of the last lines a run printed are kept: its answer is one line of JSON, the last one. */
const LINES_KEPT = 200;

/**
 * The environment of the command line: the shell's own, cleaned as the server's is. A release's command line finds
 * the data folder and the port by itself and reads no setting; a development run and the test variant are told the
 * shell's own, so that the command line works on the same emulator. It is told to call itself `busy-emulator`
 * (BUSY_EMULATOR_CLI_PATH, the one variable a release reads, and only prints): its hints then name the command by
 * name, never by the path of the Node and the script inside the app or of a launcher, and the window says them in
 * its own words (window-texts.mjs).
 */
export const CLI_NAME_FOR_HINTS = "busy-emulator";

export function cliEnvironment(env, config) {
  const out = serverEnvironment(env);
  if (config.development) Object.assign(out, { BUSY_EMULATOR_DATA: config.dataDir, BUSY_EMULATOR_PORT: String(config.port) });
  // A test's own home for the command line alone (its ~/.npmrc names the test's registry: create takes the generator's
  // registry from there only), never for the app around it; a release reads nothing of this.
  const testHome = env.BUSY_EMULATOR_TEST_CLI_HOME;
  if (config.development && typeof testHome === "string" && path.isAbsolute(testHome)) Object.assign(out, { HOME: testHome, USERPROFILE: testHome });
  out.BUSY_EMULATOR_CLI_PATH = CLI_NAME_FOR_HINTS;
  // The window reads the command line's lines as UTF-8 and shows them: its text as it is, not in the console's ASCII
  // (server/cli/console.mjs, EMU-314).
  out.BUSY_EMULATOR_OUTPUT = "unicode";
  return out;
}

function eachLine(stream, onLine) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop();
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    if (rest) onLine(rest);
    rest = "";
  });
}

function killQuietly(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * @param {object} o
 * @param {string} o.nodePath   the Node to run on (absolute)
 * @param {string} o.cliEntry   busy-emulator.mjs
 * @param {string[]} o.args
 * @param {Record<string, string | undefined>} o.env   cliEnvironment()
 * @param {string} o.cwd
 * @param {(line: string, stream: "out" | "err") => void} [o.onLine]
 * @returns a handle: `pid`, `exited` (a promise of { code, signal, error, lines }: `lines` is the end of what it
 *   printed to its standard output), `interrupt()` (as Ctrl+C: the command ends its work and says so), `killNow()`
 */
export function startCliProcess({ nodePath, cliEntry, args, env, cwd, onLine = () => {} }) {
  const child = startShellProgram(nodePath, [cliEntry, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"], detached: posix, windowsHide: true });
  const lines = [];
  eachLine(child.stdout, (line) => {
    lines.push(line);
    if (lines.length > LINES_KEPT) lines.shift();
    onLine(line, "out");
  });
  eachLine(child.stderr, (line) => onLine(line, "err"));

  function killGroup() {
    // Above 1 only: the group of 1 or 0 would be every process of the user or the shell's own.
    if (posix && child.pid > 1) killQuietly(-child.pid, "SIGKILL");
  }
  const exited = new Promise((resolve) => {
    let result = null;
    const settle = () => resolve({ ...result, lines });
    child.on("error", (e) => {
      result = { code: null, signal: null, error: e.message };
      settle();
    });
    child.on("exit", (code, signal) => {
      result = { code, signal, error: null };
      // Whatever the command started must not outlive it.
      killGroup();
      setTimeout(settle, 500);
    });
    child.on("close", () => result && settle());
  });
  return {
    pid: child.pid,
    exited,
    interrupt: () => void child.kill(posix ? "SIGINT" : undefined),
    killNow() {
      killGroup();
      child.kill("SIGKILL");
    },
  };
}
