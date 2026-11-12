// Runs on the bundled Node, and the emulator server runs inside it: the shell starts this script, the script starts
// the server in its own process through the server's module (startServer, EMU-004). There is no second process.
//
//   node supervisor.mjs <the server's module>
//
// Over the Node channel (the shell starts it with one) the shell sends { type: "start", options }: what startServer
// takes, as data — the port, the data folder and whatever else it learns to take; the supervisor adds only `signal`,
// `log` and `onError`. Options go over the channel rather than on the command line, where every user of the computer
// can read them. The shell hears { type: "ready", port, url, ... } — the plain values of what startServer gave, a
// management port among them when the server has one — once the server answers, and { type: "exit", code, stopped,
// error, errorCode } as the last word. The server's log and errors go to the standard output and error, which the
// shell writes to its log.
//
// One thing goes the other way: a question only the person may answer (whether they trust a project folder, ADR-0012
// section 4). The server gets `askPerson` from here; the supervisor sends { type: "ask", id, question } and the shell,
// which shows the question in a dialog of its own, answers { type: "answer", id, answer }. { type: "ask-cancel", id }
// takes a question away. The channel is the shell's alone: nothing that reaches the server over HTTP can answer.
//
// The server stops through its own stop() when the shell asks (it closes this process's standard input) and when the
// shell is gone without asking: the standard input closes then too, the channel disconnects, and a parent that died
// without either (the pipe was inherited by someone else) shows as a change of parent. A terminate signal is a stop
// as well. Then the process ends, and on macOS and Linux takes its process group with it: what the server started
// and left behind (the shell starts this process as the leader of a group of its own). On Windows a process that
// Node started dies with that Node (libuv keeps its children in a job that is closed with the parent), which does
// the same from the top down.
//
// Exit codes: 2 a wrong call (no module, more arguments, no channel). Otherwise the code is in the last message; on
// macOS and Linux the process itself then ends by the signal that takes its group.
//
// No imports from the rest of the app: after packaging this file lies outside the app's archive.
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/** A stop() that has not come to its end by then is not waited for. */
const STOP_WAIT_MS = 4000;
const posix = process.platform !== "win32";
const [serverModule, ...extra] = process.argv.slice(2);
if (!serverModule || extra.length) {
  console.error("supervisor: usage: node supervisor.mjs <the server's module>");
  process.exit(2);
}
if (!process.send) {
  console.error("supervisor: started without a channel to the shell");
  process.exit(2);
}

const quit = new AbortController();
let phase = "waiting"; // for the options; then "starting", "running"
let emulator = null;
let ending = false;

// Questions to the person that wait for the shell's answer: id → what settles them.
const asked = new Map();
let asks = 0;

/** startServer's `askPerson`: the question goes to the shell, the promise settles with its answer. */
function askPerson(question, signal) {
  return new Promise((resolve) => {
    if (!process.connected) return resolve({ answer: "unavailable", reason: "the app is gone" });
    const id = ++asks;
    const settle = (answer) => {
      if (!asked.delete(id)) return;
      signal?.removeEventListener("abort", cancel);
      resolve(answer);
    };
    const cancel = () => {
      try {
        process.send({ type: "ask-cancel", id }, () => {});
      } catch {
        // The shell is gone, and its dialog with it.
      }
      settle({ answer: "unavailable", reason: "the question was taken away" });
    };
    asked.set(id, settle);
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      process.send({ type: "ask", id, question }, (e) => e && settle({ answer: "unavailable", reason: "the question did not reach the app" }));
    } catch {
      settle({ answer: "unavailable", reason: "the question did not reach the app" });
    }
  });
}

const time = () => new Date().toTimeString().slice(0, 8);
const say = (line) => console.log(`${time()} ${line}`);

/** The plain values of what startServer gave: what the shell may need to know, and nothing that is an object. */
function factsOf(server) {
  const facts = {};
  for (const [name, value] of Object.entries(server)) {
    if (["string", "number", "boolean"].includes(typeof value)) facts[name] = value;
  }
  if (typeof server.firmware?.name === "string") facts.firmware = server.firmware.name;
  // The management address (EMU-009), named as the server's own command line names it in its message.
  if (Number.isInteger(server.control?.port)) facts.controlPort = server.control.port;
  if (typeof server.control?.url === "string") facts.controlUrl = server.control.url;
  return facts;
}

// Nobody may be reading any more (the shell is gone): a write that fails is not an error of the server's.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

/**
 * Waits until what was written to the standard output and error has gone out (a pipe on macOS takes it later), or
 * could not go out; not longer than a second.
 */
const flushed = () =>
  Promise.race([
    new Promise((resolve) => process.stdout.write("", () => process.stderr.write("", resolve))),
    new Promise((resolve) => setTimeout(resolve, 1000).unref()),
  ]);

const stopped = (code = 0, error = null) => ({ type: "exit", code, stopped: true, ...(error ? { error } : {}) });

// The last word to the shell, then out, with the process group.
function finish(message) {
  if (ending) return;
  ending = true;
  clearInterval(watch);
  const leave = () =>
    flushed().then(() => {
      if (posix) {
        try {
          process.kill(-process.pid, "SIGKILL");
        } catch {
          // Not the leader of a group: there is no group of its own to take.
        }
      }
      process.exit(message.code);
    });
  if (!process.connected) return leave();
  try {
    process.send(message, leave);
  } catch {
    leave();
  }
}

/** Ends the server's run through its own stop(), and waits for it a limited time. */
function stopRunning() {
  const timer = setTimeout(() => {
    console.error(`supervisor: the server did not stop within ${STOP_WAIT_MS / 1000} s`);
    finish(stopped(1, `the server did not stop within ${STOP_WAIT_MS / 1000} s`));
  }, STOP_WAIT_MS);
  emulator
    .stop()
    .then(
      () => finish(stopped()),
      (e) => {
        console.error(`supervisor: the server's stop failed: ${e?.message ?? e}`);
        finish(stopped(1, String(e?.message ?? e)));
      },
    )
    .finally(() => clearTimeout(timer));
}

function stop() {
  if (ending || quit.signal.aborted) return;
  quit.abort(Object.assign(new Error("The shell asked the server to stop, or is gone"), { code: "EMU_STOPPED" }));
  // Not started yet: nothing to stop. Starting: the start sees the abort and ends (start() below).
  if (phase === "waiting") return finish(stopped());
  if (phase === "running") stopRunning();
}

async function start(options) {
  phase = "starting";
  try {
    const { startServer } = await import(pathToFileURL(serverModule).href);
    if (typeof startServer !== "function") throw new Error(`${serverModule} has no startServer`);
    if (quit.signal.aborted) return finish(stopped());
    emulator = await startServer({ ...options, signal: quit.signal, log: say, onError: (e) => console.error(e?.stack ?? e), askPerson });
  } catch (e) {
    // A start called off by the shell did not fail.
    if (quit.signal.aborted) return finish(stopped());
    // The last line of the standard error says why, as it does for the server's own command line.
    console.error(e?.message ?? e);
    return finish({ type: "exit", code: 1, stopped: false, error: String(e?.message ?? e), errorCode: e?.code ?? null });
  }
  phase = "running";
  // Asked to stop just as the start came to its end.
  if (quit.signal.aborted) return stopRunning();
  const firmware = emulator.firmware?.name ? `, firmware ${emulator.firmware.name}${emulator.firmware.info?.firmware ? ` ${emulator.firmware.info.firmware}` : ""}` : "";
  console.log(`BUSY Bar emulator: ${emulator.url}  (API ${emulator.apiVersion ?? "?"}${firmware}, data ${emulator.dataDir ?? "?"})`);
  process.send({ type: "ready", ...factsOf(emulator) }, () => {});
}

process.on("message", (message) => {
  if (message?.type === "answer") return void asked.get(message.id)?.(message.answer && typeof message.answer === "object" ? message.answer : { answer: "unavailable" });
  if (message?.type !== "start" || phase !== "waiting" || quit.signal.aborted) return;
  start(message.options && typeof message.options === "object" ? message.options : {});
});

// A failure nobody caught is the end of the server: said, and out. A lock it leaves in the data folder is cleared by
// the next server, which first makes sure the process the lock names is gone.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (e) => {
    if (ending) return;
    console.error(`supervisor: ${event}: ${e?.stack ?? e}`);
    finish({ type: "exit", code: 1, stopped: false, error: `the server failed: ${e?.message ?? e}` });
  });
}

process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.on("error", stop);
process.stdin.resume();
process.on("disconnect", stop);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);

// A parent that died without closing the pipe still shows here: the process is handed to another parent. Windows
// keeps the old number, and there the job does the work.
const parent = process.ppid;
const watch = setInterval(() => {
  if (process.ppid !== parent) stop();
}, 1000);

// The server may hold this thread for ever (an app on the bar that never returns runs in it): then nothing above
// learns that the shell is gone. A second thread does: it sees the change of parent and, when this thread has not
// ended the process within the time a stop may take, ends it with its group.
if (posix) {
  new Worker(
    `const { workerData } = require("node:worker_threads");
     let since = 0;
     setInterval(() => {
       if (process.ppid === workerData.parent) return;
       since ||= Date.now();
       if (Date.now() - since < workerData.wait) return;
       try { process.kill(-process.pid, "SIGKILL"); } catch {}
       process.kill(process.pid, "SIGKILL");
     }, 500);`,
    { eval: true, workerData: { parent, wait: STOP_WAIT_MS + 2000 }, stdin: false, stdout: false, stderr: false },
  ).unref();
}
