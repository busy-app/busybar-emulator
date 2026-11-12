// busy-emulator logs [--app <id> | --all] [--since-run] [--kind <kinds>] [--since <ms>] [--lines <n>] [--follow]: the
// emulated BUSY Bar's log — what the apps print with console.log, the runtime's errors (a script that throws, a script that
// does not parse), and what the BUSY Bar says of an app's life (installed, launched, exited and why). The answer to "why
// does my app show nothing". The server keeps the latest 500 lines since it started; the command reads them from the
// BUSY Bar's own address (GET /_emu/events) and writes nothing.
//
// The log is the whole BUSY Bar's, every app that ran since the emulator started (in the field test with a real agent most
// of the lines an agent got were of earlier projects). So the lines of one app are shown: the app of --app, or the
// app of the project in the caller's folder; with them the BUSY Bar's own lines (the clock set, time passed, a restart).
// --all shows every app's, as does a call outside a project without --app. --since-run shows only the lines from the
// app's latest launch on.
//
// --kind chooses lines as the filters of the window's console do: console (what apps print, warnings and errors),
// lifecycle (installed, launched, exited), system (the BUSY Bar itself), build (what the window's buttons ran: build,
// install, start, checks; the desktop app keeps those lines in the data folder, build-feed.mjs). Without it every kind
// but build. --since <ms> starts after a moment (Unix ms, the computer's clock): the window's console after Clear.
// The window's "Open in Terminal" runs `logs --follow` with its filters (packages/app/src/terminal.mjs).
import { jsonLine, momentOf, readLog, selectLines, shownLine } from "../app-log.mjs";
import { buildFeedFile, readBuildFeed } from "../build-feed.mjs";
import { commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { asciiJson, CliError } from "../output.mjs";
import { appId } from "../project.mjs";

const DEFAULT_LINES = 50;
const USAGE = "logs [--app <id> | --all] [--since-run] [--kind <kinds>] [--since <ms>] [--lines <n>] [--follow]";
/** The kinds of --kind, in the order the window's filters have them. */
export const LOG_KINDS = Object.freeze(["console", "lifecycle", "build", "system"]);
const DEFAULT_KINDS = Object.freeze(["console", "lifecycle", "system"]);
/** How often --follow looks for new lines of the window's jobs. */
const FEED_EVERY_MS = 250;

/** The kind of a line by --kind's words: the server's "app" is lifecycle, an app's severities are console. */
export function kindOf(line) {
  if (line.kind === "build") return "build";
  if (line.kind === "app") return "lifecycle";
  if (line.kind === "system") return "system";
  return "console";
}

const clockOf = (ms) => {
  const t = new Date(ms);
  return [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};
const listed = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

/** The first line --follow prints for a person: whose lines, which kinds, from when. */
export function followHeader({ app, kinds, since, sinceRun }) {
  const whose = app === null ? (sinceRun ? "the app launched last" : "every app") : app;
  const from = since !== null ? `, from ${clockOf(since)}` : sinceRun ? ", from its latest launch" : "";
  return `The BUSY Bar's log for ${whose}: ${listed(kinds)} lines${from}. Ctrl+C stops.`;
}

export default {
  name: "logs",
  summary: "Show the BUSY Bar's log for the app of this folder's project: its console.log output, its errors, why it ended (--since-run: the latest launch only; --all: every app; --kind: console, lifecycle, build, system; --follow keeps printing)",
  usage: USAGE,
  options: {
    "--lines": { key: "lines", value: "<n>" },
    "--follow": { key: "follow" },
    "--app": { key: "app", value: "<id>" },
    "--all": { key: "all" },
    "--since-run": { key: "sinceRun" },
    "--kind": { key: "kind", value: "<kinds>" },
    "--since": { key: "since", value: "<ms>" },
  },
  async run(ctx, sys, { options, json, print }) {
    const self = commandLine(ctx);
    const usage = `Usage: ${self} ${USAGE}`;
    let count = DEFAULT_LINES;
    if (options.lines !== undefined) {
      count = /^\d{1,4}$/.test(options.lines) ? Number(options.lines) : NaN;
      if (!(count >= 1)) throw new CliError("usage", `--lines takes a whole number from 1 up, not ${JSON.stringify(options.lines)}.`, usage, { option: "--lines" });
    }
    if (options.all && options.app !== undefined) throw new CliError("usage", "--all and --app do not go together: --all shows every app's lines, --app one app's.", usage, { option: "--all" });
    if (options.app !== undefined && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,31}$/.test(options.app)) throw new CliError("usage", `--app takes an app's id, as app.you.clock, not ${JSON.stringify(options.app)}.`, usage, { option: "--app" });
    let kinds = DEFAULT_KINDS;
    if (options.kind !== undefined) {
      const words = String(options.kind).split(",").map((word) => word.trim());
      if (words.some((word) => !LOG_KINDS.includes(word))) throw new CliError("usage", `--kind takes some of ${LOG_KINDS.join(", ")}, with commas between, not ${JSON.stringify(options.kind)}.`, usage, { option: "--kind" });
      kinds = LOG_KINDS.filter((kind) => words.includes(kind));
    }
    let since = null;
    if (options.since !== undefined) {
      since = /^\d{1,15}$/.test(options.since) ? Number(options.since) : NaN;
      if (!Number.isSafeInteger(since)) throw new CliError("usage", `--since takes a moment in Unix milliseconds, as 1762870000000, not ${JSON.stringify(options.since)}.`, usage, { option: "--since" });
    }
    // Whose lines: --app, else the app of the project in the caller's folder, else (and with --all) everybody's.
    const app = options.all ? null : (options.app ?? appId(sys.cwd()));
    const sinceRun = options.sinceRun === true;
    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start, then run ${self} logs again.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar whose log to show (the log is kept while it runs).", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
    }
    const address = `127.0.0.1:${status.port}`;
    const feed = kinds.includes("build") ? buildFeedFile(ctx) : null;
    const wanted = (line) => kinds.includes(kindOf(line)) && (since === null || momentOf(line) > since);
    // The bar's lines and the window's job lines, in the order they came.
    const merged = (bar, build) =>
      [...bar, ...build]
        .map((line, i) => [line, i])
        .sort(([a, i], [b, j]) => momentOf(a) - momentOf(b) || i - j)
        .map(([line]) => line);

    if (options.follow) {
      // The kept lines first (the latest `count`), then every new one as it comes, until the emulator ends the stream
      // or the caller stops this command (Ctrl+C). With --json every line is one JSON object; the answer comes last.
      let printed = 0;
      let whose = app;
      const show = (line) => {
        printed += 1;
        print(json ? asciiJson(jsonLine(line)) : shownLine(line));
      };
      let feedAt = 0;
      let lastBuild = -Infinity;
      let timer = null;
      const lookAtFeed = () => {
        const fresh = readBuildFeed(feed, feedAt);
        feedAt = fresh.next;
        // A file shortened from its front is read again from its top: what was printed is not printed twice.
        for (const line of fresh.lines) {
          if (fresh.restarted && momentOf(line) <= lastBuild) continue;
          lastBuild = Math.max(lastBuild, momentOf(line));
          if (wanted(line)) show(line);
        }
      };
      const onKept = (kept) => {
        if (!json) print(followHeader({ app, kinds, since, sinceRun }));
        const chosen = selectLines(kept, { app, sinceRun });
        whose = chosen.app;
        let build = [];
        if (feed) {
          const first = readBuildFeed(feed, 0);
          feedAt = first.next;
          build = first.lines;
          for (const line of build) lastBuild = Math.max(lastBuild, momentOf(line));
          timer = setInterval(lookAtFeed, FEED_EVERY_MS);
        }
        merged(chosen.lines, build).filter(wanted).slice(-count).forEach(show);
      };
      const onLine = (line) => selectLines([line], { app: whose }).lines.filter(wanted).forEach(show);
      try {
        await readLog(ctx, sys, status.port, { follow: true, onKept, onLine });
      } finally {
        if (timer) clearInterval(timer);
      }
      return { data: { followed: true, app: whose, since_run: sinceRun, kinds, since, lines_printed: printed, address }, text: "The emulator closed the log: it quit, or its BUSY Bar's server restarted." };
    }

    const all = await readLog(ctx, sys, status.port);
    const chosen = selectLines(all, { app, sinceRun });
    const shownAll = merged(chosen.lines, feed ? readBuildFeed(feed, 0).lines : []).filter(wanted);
    const lines = shownAll.slice(-count);
    const whose = chosen.app;
    const notes = [];
    if (shownAll.length > lines.length) notes.push(`the latest ${lines.length} of ${shownAll.length} lines; --lines <n> shows more`);
    if (whose !== null && all.length > chosen.lines.length) notes.push(`${whose}${sinceRun ? " since its latest launch" : ""} and the BUSY Bar's own lines; --all shows every app's`);
    const filtered = since !== null || kinds !== DEFAULT_KINDS;
    let text;
    if (lines.length) text = [...lines.map(shownLine), ...(notes.length ? [`(${notes.join("; ")})`] : [])].join("\n");
    else if (sinceRun && !chosen.launched) text = `${whose ?? "No app"} was not launched since the emulator started${all.length ? `; ${self} logs --all shows the ${all.length} lines the BUSY Bar has` : ""}.`;
    else if (filtered) text = `No ${listed(kinds) || "kind of"} lines${since !== null ? ` since ${clockOf(since)}` : ""}.`;
    else if (all.length) text = `The BUSY Bar's log has no line of ${whose}; ${self} logs --all shows the ${all.length} lines of other apps and the BUSY Bar.`;
    else text = "The BUSY Bar's log is empty: nothing was installed, run or printed since the emulator started.";
    return { data: { address, app: whose, since_run: sinceRun, kinds: [...kinds], since, kept: all.length, lines: lines.map(jsonLine) }, text };
  },
};
