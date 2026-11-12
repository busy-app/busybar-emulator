// One run of the emulator server: the supervisor on the bundled Node, with the server inside its process.
//
// The shell sends the server's options over the Node channel and hears there that the server is ready (with its
// port) and how the run ended. Over the same channel the server asks what only the person may answer (`onAsk`: the
// shell shows a dialog) and gets the answer; nothing else can give one. It holds the supervisor's standard input: closing it is the request to stop — the
// server stops through its own stop() — and its closing by itself (the shell died) is what stops the server without
// the shell. Nothing here knows about Electron.
//
// On macOS and Linux the supervisor leads a process group of its own, so that whatever the server started is in it:
// the supervisor takes the group with it when it ends, and when it ended without doing so (killed, crashed) the
// shell takes it. On Windows the processes Node starts die with it (libuv's job object), the supervisor with the
// shell and the server's children with the supervisor.
import { startShellProgram } from "./processes.mjs";

import { NODE_ENVIRONMENT_UNSET } from "./install-files.mjs";

const STOP_WAIT_MS = 5000;
const CLOSE_WAIT_MS = 500;
const posix = process.platform !== "win32";
const UNSET = new Set(NODE_ENVIRONMENT_UNSET.map((name) => name.toUpperCase()));

/**
 * The environment of the server: the shell's own, without what would change how a Node starts (the list the command
 * line's launchers use, ADR-0016), without Electron's settings and without the shell's own. The names are compared
 * in any case: Windows reads them so.
 */
export function serverEnvironment(env) {
  const out = { ...env };
  for (const name of Object.keys(out)) {
    const upper = name.toUpperCase();
    if (UNSET.has(upper) || upper.startsWith("ELECTRON_") || upper.startsWith("BUSY_EMULATOR_")) delete out[name];
  }
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
 * @param {string} o.nodePath        the Node to run on (absolute)
 * @param {string} o.supervisorPath  supervisor.mjs
 * @param {string} o.serverEntry     the server's module: the file that exports startServer
 * @param {object} o.serverOptions   what startServer takes, as plain data (port, dataDir, ...)
 * @param {Record<string, string | undefined>} o.env
 * @param {(line: string, stream: "out" | "err") => void} o.onLine  every line the server prints
 * @param {(facts: object) => void} [o.onReady]  the server answers: { port, url, ... } as the supervisor tells it
 * @param {(question: object, signal: AbortSignal) => Promise<object>} [o.onAsk]  a question of the server's to the
 *   person; what it resolves with goes back as the answer. Without it every question is answered "unavailable".
 * @returns a handle: `pid` (the supervisor's process, which is the server's), `exited` (a promise of how the run
 *   ended: { code, signal, error, errorCode, stopped, said }; `said` is true when the supervisor told it itself),
 *   `stop()`, `killNow()`
 */
export function startServerProcess({ nodePath, supervisorPath, serverEntry, serverOptions, env, onLine, onReady = () => {}, onAsk = null }) {
  const child = startShellProgram(nodePath, [supervisorPath, serverEntry], {
    env: serverEnvironment(env),
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    detached: posix,
    windowsHide: true,
  });
  let ending = null;
  let stopped = false;

  eachLine(child.stdout, (line) => onLine(line, "out"));
  eachLine(child.stderr, (line) => onLine(line, "err"));
  // The other end may be gone already; closing is all this pipe is for.
  child.stdin.on("error", () => {});
  // The questions the shell is answering now: id → what takes one away.
  const questions = new Map();
  const answer = (id, value) => {
    if (!questions.delete(id) || !child.connected) return;
    try {
      child.send({ type: "answer", id, answer: value }, () => {});
    } catch {
      // The server is gone; nobody waits for the answer.
    }
  };
  child.on("message", (message) => {
    if (message?.type === "ready" && Number.isInteger(message.port)) onReady(message);
    if (message?.type === "exit") ending = message;
    if (message?.type === "ask" && Number.isInteger(message.id) && !questions.has(message.id)) {
      const abort = new AbortController();
      questions.set(message.id, abort);
      Promise.resolve()
        .then(() => (onAsk ? onAsk(message.question, abort.signal) : { answer: "unavailable", reason: "this app answers no questions" }))
        .then((value) => answer(message.id, value), (e) => answer(message.id, { answer: "unavailable", reason: String(e?.message ?? e) }));
    }
    if (message?.type === "ask-cancel") questions.get(message.id)?.abort();
  });
  // A server that is gone takes its questions with it: their dialogs close.
  child.on("exit", () => {
    for (const abort of questions.values()) abort.abort();
  });
  try {
    child.send({ type: "start", options: serverOptions }, (e) => e && onLine(`the server's options did not reach the supervisor: ${e.message}`, "err"));
  } catch {
    // The process did not start; "error" below tells.
  }

  // Everything in the supervisor's group, when the supervisor can no longer be asked.
  function killGroup() {
    // Above 1 only: the group of 1 or 0 would be every process of the user or the shell's own.
    if (posix && child.pid > 1) killQuietly(-child.pid, "SIGKILL");
  }

  const exited = new Promise((resolve) => {
    let result = null;
    const settle = () => {
      const said = ending !== null;
      resolve({
        code: said ? (ending.code ?? null) : result.code,
        signal: said ? null : result.signal,
        error: said ? (ending.error ?? null) : result.error,
        errorCode: said ? (ending.errorCode ?? null) : null,
        stopped: stopped || Boolean(ending?.stopped),
        said,
      });
    };
    child.on("error", (e) => {
      result = { code: null, signal: null, error: e.message };
      settle();
    });
    child.on("exit", (code, signal) => {
      result = { code, signal, error: null };
      // Whatever the server started must not outlive this run, however it ended.
      killGroup();
      // "close" comes once the output has been read to the end, so the last lines are not lost; it is not waited
      // for longer than this, in case something else still holds the pipe.
      setTimeout(settle, CLOSE_WAIT_MS);
    });
    child.on("close", () => result && settle());
  });

  return {
    pid: child.pid,
    exited,
    /** Asks the server to stop and waits until it has; after a while stops it by force. */
    async stop() {
      stopped = true;
      child.stdin.end();
      const timer = setTimeout(() => {
        killGroup();
        child.kill("SIGKILL");
      }, STOP_WAIT_MS);
      await exited;
      clearTimeout(timer);
    },
    /** For the moment the shell itself is going down and cannot wait: no promises, only signals. */
    killNow() {
      stopped = true;
      killGroup();
      child.kill("SIGKILL");
    },
  };
}
