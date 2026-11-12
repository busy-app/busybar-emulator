// busy-emulator time [set <time> | advance <duration> | reset]: the emulated BUSY Bar's clock, so that "the 25-minute timer
// ends" or "the color changes on the hour" can be checked without waiting (the field test with a real agent, 11.11:
// one run saw the hour change only because it happened to start at 14:59).
//
//   time                      the BUSY Bar's time, and how far it is from this computer's
//   time set <ISO or HH:MM>   sets the clock, as the BUSY Bar's own API does (POST /api/time/timestamp): what time it is
//                             changes, nothing that waits is hurried. HH:MM[:SS] is today in the BUSY Bar's time zone; an
//                             ISO time without a zone is in the BUSY Bar's zone too
//   time advance <duration>   lets that much time pass at once (POST /_emu/time?pass=ms): the clock is that far on
//                             (the app's Date.now() too), the app's setTimeout and setInterval count from the new
//                             time, so what was due in between fires now (an interval once, not once a period), and
//                             the firmware lives through it: a countdown element, an animation, a scrolling text, an
//                             element's timeout, the BUSY timer. Not hurried: the app's requests to the network
//   time reset                the clock is this computer's again; timers that fired stay fired
//
// The command does not start the emulator and writes nothing.
import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

const USAGE = "time [set <ISO or HH:MM> | advance <duration> | reset]";
/** The most `advance` takes at once, as the server does (device-window.mjs MAX_PASS_MS): every tick of it is carried out. */
export const MAX_ADVANCE_MS = 24 * 3600 * 1000;
const UNITS = { ms: 1, s: 1000, sec: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/** "25m", "90s", "2h", "1h30m", "500ms" → ms; null when it is not a duration. */
export function parseDuration(text) {
  const parts = [...String(text).toLowerCase().matchAll(/(\d+(?:\.\d+)?)(ms|sec|min|s|m|h|d)/g)];
  if (!parts.length || parts.map((part) => part[0]).join("") !== String(text).toLowerCase()) return null;
  const ms = Math.round(parts.reduce((sum, [, number, unit]) => sum + Number(number) * UNITS[unit], 0));
  return Number.isFinite(ms) ? ms : null;
}

/** ms as a person says it: "25 min", "1 h 30 min", "90 s", "500 ms". */
export function durationText(ms) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  const parts = [[Math.floor(seconds / 3600), "h"], [Math.floor((seconds % 3600) / 60), "min"], [seconds % 60, "s"]].filter(([n]) => n > 0);
  return parts.map(([n, unit]) => `${n} ${unit}`).join(" ");
}

const pad = (n) => String(n).padStart(2, "0");
/** Unix ms as the firmware's API takes a time: whole seconds, UTC. */
const stamp = (ms) => `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;

/**
 * The time `text` names, Unix ms, or null. `bar` is the bar's time as GET /api/time gives it
 * ("2026-11-11T15:53:12+01:00"): HH:MM[:SS] is that day in that zone, an ISO time without a zone is in that zone.
 */
export function parseTime(text, bar) {
  const zone = /(Z|[+-]\d\d:?\d\d)$/.exec(bar)?.[1] ?? "Z";
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (clock) return Date.parse(`${bar.slice(0, 10)}T${pad(Number(clock[1]))}:${clock[2]}:${clock[3] ?? "00"}${zone}`);
  const iso = /^(20\d\d-\d\d-\d\d)[T ](\d\d:\d\d)(:\d\d)?(Z|[+-]\d\d:?\d\d)?$/i.exec(text);
  if (!iso) return null;
  const at = Date.parse(`${iso[1]}T${iso[2]}${iso[3] ?? ":00"}${(iso[4] ?? zone).toUpperCase()}`);
  return Number.isFinite(at) ? at : null;
}

/** The bar's time for a person, in the bar's zone: "2026-11-11 15:53:12 (+01:00)". */
const shown = (bar) => `${bar.slice(0, 10)} ${bar.slice(11, 19)} (${/(Z|[+-]\d\d:?\d\d)$/.exec(bar)?.[1].replace("Z", "+00:00") ?? "UTC"})`;

export default {
  name: "time",
  summary: "Show the emulated BUSY Bar's clock, set it, or let time pass at once (time advance 25m: the app's timers that were due fire now)",
  usage: USAGE,
  maxArguments: 2,
  async run(ctx, sys, { args }) {
    const self = commandLine(ctx);
    const [action = "show", value] = args;
    const usage = (message, extra = {}) => new CliError("usage", message, `Usage: ${self} ${USAGE}. For example: ${self} time advance 25m, ${self} time set 14:59:50.`, extra);
    if (!["show", "set", "advance", "reset"].includes(action)) throw usage(`time has no action ${JSON.stringify(action)}: it takes set, advance or reset, or nothing to show the clock.`, { argument: action });
    if ((action === "show" || action === "reset") && value !== undefined) throw usage(`time ${action === "show" ? "" : "reset "}takes no argument ${JSON.stringify(value)}.`.replace("time takes", "time show takes"), { argument: value });
    let advance = null;
    if (action === "advance") {
      advance = value === undefined ? null : parseDuration(value);
      if (value === undefined) throw usage("time advance needs a duration: 25m, 90s, 2h, 1h30m.");
      if (advance === null || advance < 1) throw usage(`${JSON.stringify(value)} is not a duration: a number with ms, s, m or h, as 25m, 90s, 2h or 1h30m.`, { argument: value });
      if (advance > MAX_ADVANCE_MS) throw usage(`time advance takes 24 h at most at once (every moment of it is lived through), not ${value}. For a longer jump set the clock: ${self} time set <ISO time>.`, { argument: value });
    }
    if (action === "set" && value === undefined) throw usage("time set needs a time: HH:MM or HH:MM:SS (today, in the BUSY Bar's time zone), or an ISO time as 2026-12-31T23:59:50.");

    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start, then run ${self} time again.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar whose clock to read.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
    }
    const { port } = status;
    const address = `127.0.0.1:${port}`;
    const failed = (what, answer) => new CliError("time_failed", `The emulated BUSY Bar at ${address} ${what} (${answer.failed ?? `HTTP ${answer.status}${answer.body ? `: ${answer.body.slice(0, 200)}` : ""}`}).`, `Check that it is the emulator that listens there: ${self} status.`);
    const read = async () => {
      const answer = await sys.barGet(port, "/api/time");
      if (answer.blocked) throw blockedNetwork(port, answer.blocked);
      let bar = null;
      try {
        bar = answer.status === 200 ? JSON.parse(answer.body).timestamp : null;
      } catch {
        // Said below.
      }
      if (typeof bar !== "string" || !Number.isFinite(Date.parse(bar))) throw failed("did not say what time it is", answer);
      // How far the bar's clock is from this computer's; within two seconds it is the computer's (the bar's API
      // tells whole seconds).
      const apart = Date.parse(bar) - sys.now();
      return { bar, ahead_ms: Math.abs(apart) < 2000 ? 0 : Math.round(apart / 1000) * 1000 };
    };
    const send = async (pathname, what) => {
      const answer = await sys.barSend(port, "POST", pathname);
      if (answer.blocked) throw blockedNetwork(port, answer.blocked);
      // A bar that is off has no clock to move. The hint names no command: `press` does not turn an emulated bar on
      // cleanly (a short press is answered 503; a held one turns it on and then reports a failure), so the way on that
      // is sure is a button in the emulator's window.
      if (answer.status === 409) throw new CliError("bar_off", `The emulated BUSY Bar at ${address} is off (powered down in the emulator's window, or its battery ran out there), so no time can pass on it.`, "Turn it on with any button in the emulator's window, then run this again.");
      if (answer.failed || answer.status !== 200) throw failed(what, answer);
      try {
        return JSON.parse(answer.body);
      } catch {
        return {};
      }
    };
    const data = (now, more = {}) => ({ action, bar_time: now.bar, ahead_ms: now.ahead_ms, ...more, address });
    const apartText = (now) => (now.ahead_ms === 0 ? "this computer's time" : `${durationText(Math.abs(now.ahead_ms))} ${now.ahead_ms > 0 ? "ahead of" : "behind"} this computer's`);

    if (action === "show") {
      const now = await read();
      return { data: data(now), text: `The emulated BUSY Bar's clock: ${shown(now.bar)}, ${apartText(now)}. ${self} time advance 25m lets time pass at once; ${self} time set 14:59:50 sets the clock.` };
    }
    if (action === "set") {
      const before = await read();
      const at = parseTime(value, before.bar);
      if (at === null || !Number.isFinite(at)) throw usage(`${JSON.stringify(value)} is not a time: HH:MM or HH:MM:SS (today, in the BUSY Bar's time zone), or an ISO time as 2026-12-31T23:59:50 (in the BUSY Bar's zone; with Z or +01:00 in that one).`, { argument: value });
      await send(`/api/time/timestamp?timestamp=${encodeURIComponent(stamp(at))}`, "did not take the time");
      const now = await read();
      return {
        data: data(now, { set_to: stamp(at) }),
        text: `Set the emulated BUSY Bar's clock to ${shown(now.bar)}, ${apartText(now)}. This is setting a watch: the app's Date.now() and a countdown element follow, a timer that waits keeps its wait. To let time pass: ${self} time advance <duration>.`,
      };
    }
    if (action === "reset") {
      await send(`/api/time/timestamp?timestamp=${encodeURIComponent(stamp(sys.now() + 500))}`, "did not take the time");
      const now = await read();
      return { data: data(now), text: `The emulated BUSY Bar's clock is this computer's again: ${shown(now.bar)}. Timers that fired stay fired.` };
    }
    const answer = await send(`/_emu/time?pass=${advance}`, "did not let the time pass");
    // An emulator from before this command answers the old request (the held clock) and says nothing of what passed.
    if (!(answer.passed > 0)) throw new CliError("time_failed", `The emulated BUSY Bar at ${address} did not let the time pass: the running emulator is older than this command line.`, `Quit and start it: ${self} quit, ${self} start.`);
    const now = await read();
    const app = typeof answer.app === "string" ? answer.app : null;
    const length = durationText(advance);
    return {
      data: data(now, {
        advanced_ms: advance,
        app,
        moved: ["the BUSY Bar's clock", "the app's Date.now()", "the app's setTimeout and setInterval (what was due fired; an interval once)", "the firmware's own timers: countdown elements, animations, scrolling text, element timeouts, the BUSY timer"],
        not_moved: ["the app's requests to the network"],
      }),
      text: [
        `${length} passed at once on the emulated BUSY Bar: its clock is ${shown(now.bar)}, ${apartText(now)}.`,
        app
          ? `${app}: Date.now() is ${length} on, and every setTimeout and setInterval due in those ${length} fired now (an interval once, not once a period). A countdown element and the firmware's animations moved with it. Requests to the network are not hurried.`
          : "No app is running. An app started now reads the new time.",
        `To see what the app made of it: ${self} screenshot --scale 8, ${self} logs.`,
      ].join("\n"),
    };
  },
};
