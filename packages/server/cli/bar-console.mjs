// The emulated bar's console as the development loop reads it (commands/dev.mjs): the bar's log lines as they come,
// and what a line says about one app.
//
// The server sends its log to whoever opens its stream of events (GET /_emu/events on the bar's address,
// device-window.mjs): "log" events { kind, text, time } — the kept lines first, then a "state" event, then every new
// line as it is written. The lines are device.mjs's (this.log): what an app prints comes as "<id> <severity>: <text>"
// with the severity as the kind, the runtime's own errors as "<id> [JsRunner] <text>", the bar's words about an app as
// "App <id>: …", the end of a run as "App <id> exited: <reason>; heap peak …", its start as "Launch <id> (heap …)".
import http from "node:http";

import { SANDBOX_CODES } from "./system.mjs";

/** How long the stream may take to answer and send the kept lines. */
const OPEN_TIMEOUT_MS = 5000;

/**
 * Opens the bar's stream of events and gives every log line written from now on to `onLine`; the lines kept from
 * before are left out. `onEnd` is called once when the stream ends by itself after it opened (the emulator quit, or its
 * server restarted); not after close().
 * @param {number} port
 * @param {{ onLine: (line: { kind: string, text: string, time: number }) => void, onEnd?: () => void, timeoutMs?: number }} o
 * @returns {{ opened: Promise<{ ok: true } | { failed: string } | { blocked: string }>, close(): void }}
 */
export function followConsole(port, { onLine, onEnd = () => {}, timeoutMs = OPEN_TIMEOUT_MS }) {
  let closed = false;
  let live = false; // the kept lines are over: the first "state" came
  let settle;
  const opened = new Promise((resolve) => (settle = resolve));
  const end = (answer) => {
    if (live && !closed) {
      closed = true;
      onEnd();
    }
    settle(answer);
  };
  const request = http.get({ host: "127.0.0.1", port, path: "/_emu/events", agent: false, timeout: timeoutMs, headers: { Accept: "text/event-stream" } }, (response) => {
    if (response.statusCode !== 200) {
      response.resume();
      request.destroy();
      return end({ failed: `HTTP ${response.statusCode}` });
    }
    let rest = "";
    response.setEncoding("utf8");
    response.on("data", (text) => {
      rest += text;
      for (;;) {
        const at = rest.indexOf("\n\n");
        if (at < 0) break;
        const block = rest.slice(0, at);
        rest = rest.slice(at + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        if (event === "state" && !live) {
          live = true;
          request.setTimeout(0);
          settle({ ok: true });
        } else if (event === "log" && live && !closed) {
          let line = null;
          try {
            line = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
          } catch {
            // not a line of the log
          }
          if (line && typeof line.text === "string") onLine(line);
        }
      }
    });
    response.on("end", () => end({ failed: "the stream ended before the BUSY Bar's state came" }));
    response.on("error", (e) => end({ failed: e?.code ?? String(e) }));
  });
  request.on("timeout", () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
  request.on("error", (e) => end(SANDBOX_CODES.has(e?.code) ? { blocked: e.code } : { failed: e?.code ?? String(e) }));
  return {
    opened,
    close() {
      closed = true;
      request.destroy();
    },
  };
}

/** The reasons of an end that is not the script's failure: it ran to its end, or it was stopped. */
const CALM_ENDS = new Set(["finished", "quit"]);

/**
 * What a line of the bar's log says about the app `id`, or null when it is not about it:
 *   { event: "app_log", level, text }      what the app printed (console.log, .info, .warn, .debug), or a warning of
 *                                          the bar about it (level "warn")
 *   { event: "app_error", text }           console.error, an error of the runtime (a script that throws or does not
 *                                          parse), the JS engine's failure
 *   { event: "app_exited", reason, crashed }   the run ended: "finished", "quit", "error running main.js: …"
 *   { event: "app_launched" }              a run began
 */
export function appEvent(line, id) {
  const { kind, text } = line;
  if (text.startsWith(`${id} `)) {
    const said = text.slice(id.length + 1);
    // The app's console: "<severity>: <text>", the kind is the severity.
    const own = said.startsWith(`${kind}: `) ? said.slice(kind.length + 2) : null;
    if (kind === "error") return { event: "app_error", text: own ?? said };
    return { event: "app_log", level: kind, text: own ?? said };
  }
  if (kind === "app" && text.startsWith(`Launch ${id} `)) return { event: "app_launched" };
  if (text.startsWith(`App ${id} exited: `)) {
    const reason = /^(.*?)(; heap peak .*)?$/.exec(text.slice(`App ${id} exited: `.length))[1];
    return { event: "app_exited", reason, crashed: !CALM_ENDS.has(reason) };
  }
  if (text.startsWith(`App ${id}: `)) {
    const said = text.slice(`App ${id}: `.length);
    return kind === "error" ? { event: "app_error", text: said } : { event: "app_log", level: kind === "system" ? "info" : kind, text: said };
  }
  return null;
}

/** Whether an error line is the JS engine's failure, after which the app is stuck and will not end by itself. */
export function engineFailed(text) {
  return /^JS (heap overflow|fatal error)/.test(text);
}
