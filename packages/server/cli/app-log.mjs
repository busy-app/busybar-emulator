// The emulated bar's log as the command line reads it (logs; run, which looks at what its app did in its first
// second). The lines are the server's (device.mjs, this.log): { kind, text, time }, where kind is the severity of an
// app's console ("log", "info", "warn", "error", "debug"), "app" for an app's life (installed, launched, exited) or
// "system" for the bar itself. What a line says about one app is read by bar-console.mjs (appEvent), which the
// development loop (dev) follows the console with: both commands judge a run the same way.
import { appEvent, engineFailed } from "./bar-console.mjs";
import { blockedNetwork, commandLine } from "./lifecycle.mjs";
import { CliError } from "./output.mjs";

/** How long run watches its app after the launch, and how often it looks. */
export const WATCH_MS = 1000;
export const WATCH_STEP_MS = 150;

/**
 * The bar's kept log lines, oldest first.
 * @returns {Promise<{ kind: string, text: string, time: number }[]>}
 */
export async function readLog(ctx, sys, port, options = {}) {
  const answer = await sys.barLog(port, options);
  if (answer.blocked) throw blockedNetwork(port, answer.blocked);
  if (answer.failed) throw new CliError("log_failed", `The emulator at 127.0.0.1:${port} gave no log (${answer.failed}).`, `Check that it is the emulator that listens there: ${commandLine(ctx)} status.`);
  return answer.lines;
}

/**
 * When a line came, by the computer's clock: the server says so (`at`); a line without it, by the bar's (`time`). The
 * bar's clock is the computer's plus the offset `time set` gives it, so a line's `time` is never compared with the
 * computer's clock (audit C7: after `time set` 6 hours back, run did not see its app crash).
 */
export const momentOf = (line) => (Number.isFinite(line?.at) ? line.at : line?.time);

/** A line for a person: the time of day, the kind, the text. */
export function shownLine(line) {
  const time = new Date(line.time);
  const clock = Number.isFinite(time.getTime()) ? [time.getHours(), time.getMinutes(), time.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":") : "--:--:--";
  return `${clock}  ${String(line.kind ?? "").padEnd(6)}  ${line.text}`;
}

/** A line for --json: the time as ISO 8601. */
export function jsonLine(line) {
  const time = new Date(line.time);
  return { time: Number.isFinite(time.getTime()) ? time.toISOString() : null, kind: line.kind ?? null, text: line.text };
}

/** The app a line of the log is about, by the forms device.mjs writes; null for a line of the bar itself. */
export function lineApp(line) {
  const text = String(line?.text ?? "");
  const named = /^(?:Launch|Installed|Removed|Put) (\S+)/.exec(text) ?? /^Cannot install ([^\s:]+)/.exec(text) ?? /^App (\S+?)(?::| exited:| was running)/.exec(text) ?? /^The settings sent for (\S+) were refused/.exec(text);
  if (named) return named[1];
  // What an app printed, "<id> <severity>: <text>", and the runtime's own lines about it, "<id> [JsRunner] <text>".
  return (/^(\S+) (?:log|info|warn|error|debug): /.exec(text) ?? /^(\S+) \[[A-Za-z]\w*\] /.exec(text))?.[1] ?? null;
}

/**
 * The lines to show for one app: its own and the bar's own (the clock set, time passed, a restart), without the lines
 * of other apps. The notes of a package ("App package: …") go with the install that follows them. With `sinceRun`,
 * only from the app's latest launch on; `app` null then means the app launched last.
 * @returns {{ app: string|null, lines: object[], launched: boolean }} `launched`: a launch was found (sinceRun)
 */
export function selectLines(lines, { app = null, sinceRun = false } = {}) {
  let from = 0;
  let launched = false;
  if (sinceRun) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const id = /^Launch (\S+) /.exec(lines[i].text ?? "")?.[1];
      if (lines[i].kind === "app" && id && (app === null || id === app)) {
        app ??= id;
        from = i;
        launched = true;
        break;
      }
    }
    if (!launched) return { app, lines: [], launched };
  }
  if (app === null) return { app, lines: lines.slice(from), launched };
  const out = [];
  let notes = []; // the notes of a package, until the line that says whose install it was
  for (const line of lines.slice(from)) {
    const about = lineApp(line);
    if (about === null && /^(App package: |Cannot unpack the app package)/.test(line.text ?? "")) {
      notes.push(line);
      continue;
    }
    if (about === null || about === app) out.push(...(about === app ? notes : []), line);
    notes = [];
  }
  return { app, lines: [...out, ...notes], launched };
}

/**
 * What the app `id` did since its latest launch that is not older than `since` (ms; the moment before the launch was
 * asked), by the log's lines, read as the development loop reads them (bar-console.mjs appEvent).
 * @returns {{ launched: boolean, exited: string|null, crashed: boolean, errors: string[], lines: object[] }} `exited`
 *   is the reason the bar gives ("finished", "quit", "error running main.js: …"), null while the app runs; `crashed`
 *   says the end was the script's failure, or the JS engine's, after which the app is stuck; `errors` are its error
 *   lines without the id in front; `lines` everything of this run.
 */
export function runOutcome(lines, id, since) {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (appEvent(lines[i], id)?.event === "app_launched") {
      start = i;
      break;
    }
  }
  const outcome = { launched: false, exited: null, crashed: false, errors: [], lines: [] };
  if (start < 0 || momentOf(lines[start]) < since) return outcome;
  outcome.launched = true;
  for (const line of lines.slice(start)) {
    const event = appEvent(line, id);
    if (!event) continue;
    outcome.lines.push(line);
    if (event.event === "app_error") {
      outcome.errors.push(event.text);
      if (engineFailed(event.text)) outcome.crashed = true;
    } else if (event.event === "app_exited") {
      outcome.exited = event.reason;
      outcome.crashed ||= event.crashed;
    }
  }
  return outcome;
}

/**
 * Watches the app for its first second on the bar. Returns the outcome (runOutcome) with `running`: true when the app
 * has not ended, false when it has, null when the log could not be read or shows no launch (nothing is claimed then).
 */
export async function watchStart(sys, port, id, since, { watchMs = WATCH_MS, stepMs = WATCH_STEP_MS } = {}) {
  const deadline = sys.now() + watchMs;
  let outcome = { launched: false, exited: null, crashed: false, errors: [], lines: [] };
  for (;;) {
    const answer = await sys.barLog(port);
    if (answer.blocked || answer.failed) return { ...outcome, running: null };
    outcome = runOutcome(answer.lines, id, since);
    // The engine's failure leaves the app "running" for the bar, stuck: that is the end too.
    const stuck = outcome.crashed && outcome.exited === null;
    if (outcome.exited !== null || stuck) return { ...outcome, exited: outcome.exited ?? "the JS engine failed", running: false };
    if (sys.now() >= deadline) return { ...outcome, running: outcome.launched ? true : null };
    await sys.sleep(stepMs);
  }
}
