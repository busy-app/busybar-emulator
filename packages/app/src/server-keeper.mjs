// Keeps the emulator server running: starts it, waits until it is ready, starts it again when it dies — the third
// death within a minute is the last — and stops it. Nothing here knows about Electron; the shell listens to "state".
//
// States: "idle" → "starting" → "ready"; from "ready" a death leads back to "starting" or to "gave-up";
// "port-busy" and "failed" are a start that did not happen; "stopped" is the end. A start that has had no answer for
// a while is "starting" again with `slow: true`, so that the window can say it is starting rather than show nothing
// (or a dead page). A failed start says what went wrong in `cause`: "no-node", "no-server", "no-answer" (stopped after
// the wait), "refused" (the server said why it could not start) or "ended" (its process ended before it was ready).
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import net from "node:net";

import { createRestartPolicy } from "./restart-policy.mjs";
import { startServerProcess } from "./server-process.mjs";

const HOST = "127.0.0.1";
/** How long a start may go without an answer before the window says that the emulator is starting. */
export const SLOW_START_MS = 2000;

/**
 * Whether the address can be listened on right now. A port in use is the one case with its own message. The server
 * itself also refuses a port that something answers on at any address of the computer (0.0.0.0, ::), and says so with
 * the code EADDRINUSE: that is a port in use too.
 */
export function probePort(port, host = HOST) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (e) => resolve({ free: false, busy: e.code === "EADDRINUSE", reserved: e.code === "EACCES", error: e.message }));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve({ free: true })));
  });
}

/**
 * @param {object} o
 * @param {object} o.config                from resolveConfig
 * @param {Record<string, string | undefined>} o.env
 * @param {(line: string) => void} o.log
 * @param {object} [o.policy]              createRestartPolicy()
 * @param {number} [o.slowAfterMs]         SLOW_START_MS
 * @param {(question: object, signal: AbortSignal) => Promise<object>} [o.ask]  a question of the server's to the person
 */
export function createServerKeeper({ config, env, log, policy = createRestartPolicy(), slowAfterMs = SLOW_START_MS, ask = null }) {
  const events = new EventEmitter();
  let state = { name: "idle" };
  let run = null;      // the running server process, if any
  let starts = 0;      // how many times a server process was started
  let stopping = false;
  let attempt = 0;     // guards against the answers of an older start
  let wasReady = false; // the server came up at least once since the app started or the human asked to try again

  function set(next) {
    state = next;
    log(`[shell] server: ${next.name}${next.detail ? ` (${next.detail})` : ""}`);
    events.emit("state", state);
  }

  async function start() {
    if (stopping) return;
    const mine = ++attempt;
    set({ name: "starting" });
    const slow = setTimeout(() => {
      if (mine === attempt && !stopping && state.name === "starting") set({ name: "starting", slow: true, detail: `no answer yet after ${slowAfterMs / 1000} s` });
    }, slowAfterMs);
    try {
      await startOnce(mine);
    } finally {
      clearTimeout(slow);
    }
  }

  async function startOnce(mine) {
    if (!config.nodePath || !existsSync(config.nodePath)) {
      return set({ name: "failed", cause: "no-node", detail: `Node was not found at ${config.nodePath ?? "(no path given)"}` });
    }
    if (!existsSync(config.serverEntry)) {
      return set({ name: "failed", cause: "no-server", detail: `The server was not found at ${config.serverEntry}` });
    }
    const probe = await probePort(config.port);
    if (stopping || mine !== attempt) return;
    if (!probe.free) {
      return set(probe.busy || probe.reserved ? { name: "port-busy", port: config.port, ...(probe.reserved ? { reserved: true } : {}) } : { name: "failed", cause: "refused", detail: probe.error });
    }

    let ready = false;
    let timedOut = false;
    let lastError = "";
    let timer = null;
    starts += 1;
    const current = startServerProcess({
      nodePath: config.nodePath,
      supervisorPath: config.supervisorPath,
      serverEntry: config.serverEntry,
      // The whole data folder: the server keeps its format record, its lock and a bar for each firmware in it
      // (architecture.md section 4, EMU-005), and makes the folder if it is not there.
      serverOptions: { port: config.port, dataDir: config.dataDir },
      env,
      onAsk: ask,
      onLine(line, stream) {
        log(`[server${stream === "err" ? "!" : ""}] ${line}`);
        if (stream === "err" && line.trim()) lastError = line.trim();
      },
      // Ready is the server's own word, with the port it took.
      onReady(facts) {
        if (ready || run !== current) return;
        ready = true;
        clearTimeout(timer);
        wasReady = true;
        const address = typeof facts.url === "string" ? facts.url : `http://${HOST}:${facts.port}`;
        set({ name: "ready", address, port: facts.port, ...(Number.isInteger(facts.controlPort) ? { controlPort: facts.controlPort } : {}) });
      },
    });
    run = current;
    timer = setTimeout(() => {
      timedOut = true;
      current.stop();
    }, config.startTimeoutMs);

    const end = await current.exited;
    clearTimeout(timer);
    if (run === current) run = null;
    if (stopping) return;
    const how = timedOut && !ready
      ? `no answer in ${Math.round(config.startTimeoutMs / 1000)} s`
      : end.error
        ? (end.said ? end.error : `the server process did not start: ${end.error}`)
        : end.signal
          ? `signal ${end.signal}`
          : `exit code ${end.code}`;
    log(`[shell] server ended: ${how}`);
    // The server found the port taken (by something on another address, or since the probe): no round of restarts.
    if (end.errorCode === "EADDRINUSE") return set({ name: "port-busy", port: config.port });
    if (end.errorCode === "EACCES") return set({ name: "port-busy", port: config.port, reserved: true });
    // It said why itself: that is the whole reason. Otherwise the last thing it printed may tell.
    const detail = end.said && end.error ? end.error : [how, lastError].filter(Boolean).join(": ");
    if (!wasReady) {
      // It never came up in this run of the app: nothing to restore, say so at once.
      const cause = timedOut && !ready ? "no-answer" : end.said && end.error ? "refused" : "ended";
      return set({ name: "failed", cause, detail });
    }
    if (policy.died()) return start();
    set({ name: "gave-up", deaths: policy.limit, withinMs: policy.windowMs, detail });
  }

  return {
    on: (name, listener) => events.on(name, listener),
    get state() {
      return state;
    },
    get starts() {
      return starts;
    },
    /** The process of the server, for the log and the tests: it is the supervisor's, both names give the same id. */
    pids: () => (run ? { supervisor: run.pid, server: run.pid } : null),
    start,
    /** The human asked to try again: the count of deaths starts over. */
    retry() {
      if (run || state.name === "starting") return;
      policy.reset();
      wasReady = false;
      return start();
    },
    async stop() {
      stopping = true;
      attempt += 1;
      if (run) await run.stop();
      set({ name: "stopped" });
    },
    /** When the process is going down this instant. */
    killNow() {
      stopping = true;
      run?.killNow();
    },
  };
}
