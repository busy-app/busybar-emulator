// busy-emulator dev [<folder>]: the development loop. One command builds the project, installs it on the emulated BUSY Bar
// and starts it, then watches the project's source files and on every save does the round again — build, install,
// start — printing the build's errors and the app's console (console.log, the runtime's errors) until Ctrl+C.
//
// Thin, as the other project commands are: every step is the project's own busy-cli on the Node inside the app
// (`busy-cli build`, `busy-cli app install --addr <the emulated BUSY Bar>`, `busy-cli app run --addr …`), one after another.
// What is its own: the watching (../../projects/watch.mjs), the BUSY Bar's console (../bar-console.mjs), and that it goes on.
//
// - A save starts a round once nothing was saved for 150 ms. Rounds never overlap: saves during a round make one more
//   round after it, however many they were.
// - A build that fails prints busy-cli's text and the loop goes on watching; the version of the app that runs on the
//   BUSY Bar stays as it is.
// - After each round one line says what came of it and how long it took.
// - --json: every event is one line of JSON on standard output, { "event": …, "time": … } and its fields; the
//   command's answer ({ "ok": … }) is the last line, as with every command.
// - --once: one round, no watching; it looks at the app for a second after the start and ends with 0 when the app
//   runs (or ran to its end without an error), 1 otherwise — for a caller that cannot hold a process.
// - Ctrl+C stops the watching, not the app: it stays on the BUSY Bar as the last round left it.
// - It does not start the emulator: not_running, with the hint to run start.
import { existsSync } from "node:fs";
import path from "node:path";

import { busyCliScript } from "../../projects/node-tools.mjs";
import { oneAtATime, watchProject } from "../../projects/watch.mjs";
import { appEvent, engineFailed, followConsole } from "../bar-console.mjs";
import { blockedNetwork, emulatorStatus, ready } from "../lifecycle.mjs";
import { fontWarnings, fontWarningText } from "../../projects/font-check.mjs";
import { asciiJson, CliError } from "../output.mjs";
import { again, buildFailureHint, commandFor, ensureDependencies, fixBusyCli, installedFromProject, projectAt, remember, requireTrust, requireValidSettings, runTool, shown, toolFailed, TRUST_OPTION } from "../project.mjs";

/** How long --once looks at the app after its start, and how often. */
const LOOK_MS = 1000;
const LOOK_STEP_MS = 50;

/** Ends when the caller stops the command (Ctrl+C, or the terminal goes): calls `stop` once. Returns how to let go. */
function onInterrupt(stop) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const handler = () => stop();
  for (const signal of signals) process.on(signal, handler);
  return () => signals.forEach((signal) => process.off(signal, handler));
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

function clock(time) {
  const at = new Date(time);
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** An event as a person reads it: the time of day, a word, the text. */
function shownEvent(event) {
  const line = (word, text) => `${clock(event.time)}  ${word.padEnd(7)}  ${text}`;
  switch (event.event) {
    case "watching":
      return line("watch", `${event.folder} (${event.id ?? "the app"}) for the emulated BUSY Bar at ${event.address}. Ctrl+C stops watching; the app stays on the BUSY Bar.`);
    case "build_started":
      return line("build", event.changed.length ? `${event.changed.slice(0, 3).join(", ")}${event.changed.length > 3 ? ` and ${event.changed.length - 3} more` : ""} changed` : "the project as it is");
    case "build_failed":
    case "install_failed":
    case "run_failed":
      return [
        line("failed", `${event.tool} failed${event.exit_code === null || event.exit_code === undefined ? "" : ` with exit code ${event.exit_code}`}${event.message && !event.output ? `: ${event.message}` : ":"}`),
        ...(event.output ? [event.output] : []),
        ...(event.bar ?? []).map((text) => `The BUSY Bar: ${text}`),
        ...(event.hint ? [event.hint] : []),
        ...(event.watching ? [line("watch", "still watching: save a file to try again. The app on the BUSY Bar is as it was.")] : []),
      ].join("\n");
    case "build_warning":
      return line("warning", event.message);
    case "installed":
      return null; // a person gets one line for the round: the one of "running"
    case "running":
      return line("ready", `${event.id ?? "the app"} was started on the BUSY Bar (${seconds(event.ms)}: build ${seconds(event.build_ms)}, install ${seconds(event.install_ms)}, start ${seconds(event.run_ms)})`);
    case "app_log":
      return line(event.level, event.text);
    case "app_error":
      return line("error", event.text);
    case "app_exited":
      return line("exited", event.crashed ? `the app stopped: ${event.reason}` : event.reason === "finished" ? "the app's script ran to its end, so the app is not running any more" : `the app was stopped (${event.reason})`);
    default:
      return null;
  }
}

export default {
  name: "dev",
  summary: "Build, install and start the project's app, then do it again on every save, showing the app's console (--once: one round)",
  usage: "dev [<folder>] [--once] [--no-minify] [--bundle]",
  maxArguments: 1,
  options: { ...TRUST_OPTION, "--once": { key: "once" }, "--no-minify": { key: "noMinify" }, "--bundle": { key: "bundle" } },
  async run(ctx, sys, { args, options, json, progress, print }) {
    const project = projectAt(ctx, sys, args[0]);
    const trust = requireTrust(ctx, sys, project, options, "dev");
    remember(ctx, project);
    const self = commandFor(ctx, project, "dev", options.once ? " --once" : "");

    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${again(ctx, "start")}, then run ${self} again.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar to run the app on.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
    }
    const address = `127.0.0.1:${status.port}`;
    const id = project.id;
    const name = id ?? "the app";

    const say = (event, fields = {}, time = sys.now()) => {
      const whole = { event, time, ...fields };
      if (json) return print(asciiJson({ ...whole, time: new Date(whole.time).toISOString() }));
      const text = shownEvent(whole);
      if (text !== null) print(text);
    };

    // ------------------------------------------------------------------------------------------- the app's console
    // What the running app did since its latest launch, by the bar's log; `quiet` while a round replaces the app, when
    // the end of the old run is the round's own doing.
    let app = { launched: false, exited: null, errors: [], log: [] };
    let quiet = false;
    // While the start step runs, what the console brings is held back, so that the round's own line ("running", with
    // its time) always comes first and what the app then said and did comes after it, in that order.
    let held = null;
    let barErrors = []; // the bar's own error lines during a round (why an install was refused)
    let ended = null;
    const consoleEnded = new Promise((resolve) => (ended = resolve));
    const follow = sys.followConsole ?? followConsole;
    const bar = follow(status.port, {
      onLine(line) {
        const event = id ? appEvent(line, id) : null;
        if (!event) {
          if (line.kind === "error") barErrors.push(line.text);
          return;
        }
        if (event.event === "app_launched") {
          app = { launched: true, exited: null, errors: [], log: [] };
          return;
        }
        const { event: kind, ...fields } = event;
        if (kind === "app_exited") {
          app.exited = fields.reason;
          if (quiet && fields.reason === "quit") return;
        } else {
          if (kind === "app_error") app.errors.push(fields.text);
          app.log.push({ time: new Date(line.time).toISOString(), level: kind === "app_error" ? "error" : fields.level, text: fields.text });
        }
        if (held) held.push([kind, fields, line.time]);
        else say(kind, fields, line.time);
      },
      onEnd: () => ended(),
    });
    const opened = await bar.opened;
    if (opened.blocked) throw blockedNetwork(status.port, opened.blocked);
    if (opened.failed) throw new CliError("not_running", `The emulated BUSY Bar at ${address} gave no console (${opened.failed}).`, `Check that it is the emulator that listens there: ${again(ctx, "status")}.`);

    // ---------------------------------------------------------------------------------------------------- one round
    let stopping = false;
    let rounds = 0;
    let last = null; // the latest round's outcome: { ok, error?, … }
    const tool = async (words) => {
      const started = sys.now();
      const run = await runTool(ctx, sys, { tool: "node", args: [busyCliScript(project.dir), ...words], cwd: project.dir });
      return { run, ms: sys.now() - started };
    };
    /** A step that failed: the event, and the error --once ends with. */
    const failed = (event, cycle, toolName, run, hint, way = null) => {
      const error = toolFailed(ctx, toolName, run, hint);
      const errors = barErrors.splice(0);
      say(event, { cycle, tool: toolName, exit_code: run.code, output: shown(run.output), ...(errors.length ? { bar: errors } : {}), ...(way ? { hint: way } : {}), watching: !options.once });
      return { ok: false, error };
    };

    /** What the console brought during the start step, now. */
    const release = () => {
      const lines = held ?? [];
      held = null;
      for (const [kind, fields, time] of lines) say(kind, fields, time);
    };

    async function round(changed) {
      const cycle = ++rounds;
      const started = sys.now();
      barErrors = [];
      say("build_started", { cycle, changed });
      try {
        // As build does: a settings file the bar would refuse fails the round, with the field at fault.
        requireValidSettings(ctx, project);
        await ensureDependencies(ctx, sys, project, progress);
        fixBusyCli(ctx, project);
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        say("build_failed", { cycle, tool: e.extra?.tool ?? (e.code === "settings_invalid" ? "settings.json" : "npm"), exit_code: e.extra?.exit_code ?? null, message: e.message, output: e.extra?.output ?? "", watching: !options.once });
        return { ok: false, error: e };
      }
      // busy-cli build's own options for reading the app's code (agent-path): the package stays dist/<id>.tgz.
      const build = await tool(["build", ...(options.noMinify ? ["--no-minify"] : []), ...(options.bundle ? ["--bundle"] : [])]);
      if (stopping) return { ok: false, stopped: true };
      if (build.run.code !== 0) {
        // A failure the emulator knows the way out of (build says the same): the loop's event carries it too, since
        // saving the file again would not help.
        const way = buildFailureHint(ctx, project, build.run, null);
        return failed("build_failed", cycle, "busy-cli build", build.run, way ?? `Fix what busy-cli says, then ${options.once ? `run ${self} again` : "save the file: the round starts again"}.`, way);
      }

      // As build does: a font the build could not bundle, which the app would fail on only when it runs.
      const fonts = fontWarnings(project.dir);
      const warnings = fonts.length ? [{ code: "font_not_bundled", message: fontWarningText(fonts), places: fonts }] : [];
      for (const warning of warnings) say("build_warning", { cycle, ...warning });

      quiet = true;
      try {
        const install = await tool(["app", "install", "--addr", address]);
        if (stopping) return { ok: false, stopped: true };
        if (install.run.code !== 0) return failed("install_failed", cycle, "busy-cli app install", install.run, `Fix what busy-cli says, then run ${self} again.`);
        await installedFromProject(ctx, sys, project, status.port);
        say("installed", { cycle, id, ms: install.ms });

        app = { launched: false, exited: null, errors: [], log: [] };
        held = [];
        const start = await tool(["app", "run", "--addr", address]);
        if (stopping) return { ok: false, stopped: true };
        if (start.run.code !== 0) return failed("run_failed", cycle, "busy-cli app run", start.run, `Fix what busy-cli says, then run ${self} again.`);
        const times = { ms: sys.now() - started, build_ms: build.ms, install_ms: install.ms, run_ms: start.ms };
        say("running", { cycle, id, ...times });
        release();

        // --once says what came of the start: it looks at the app for a second. The loop does not wait: the console
        // tells of an end when it comes.
        if (options.once) {
          const deadline = sys.now() + LOOK_MS;
          while (app.exited === null && !app.errors.some(engineFailed) && sys.now() < deadline) await sys.sleep(LOOK_STEP_MS);
        }
        const gone = app.exited !== null || app.errors.some(engineFailed);
        return { ok: true, running: !gone, exited: app.exited ?? (gone ? "the JS engine failed" : null), errors: [...app.errors], warnings, ...times };
      } finally {
        quiet = false;
        release();
      }
    }

    const done = () => ({ folder: project.dir, id, address, trusted: trust.trusted, package: packageOf(project) });

    // ------------------------------------------------------------------------------------------------------- --once
    if (options.once) {
      let outcome;
      try {
        outcome = await round([]);
      } finally {
        bar.close();
      }
      if (!outcome.ok) throw outcome.error;
      const data = { ...done(), running: outcome.running, exited: outcome.exited, errors: outcome.errors, warnings: outcome.warnings, log: app.log, ms: outcome.ms, build_ms: outcome.build_ms, install_ms: outcome.install_ms, run_ms: outcome.run_ms };
      const crashed = !outcome.running && (outcome.errors.length > 0 || outcome.exited !== "finished");
      if (crashed) {
        const first = outcome.errors[0] ?? outcome.exited;
        throw new CliError("app_crashed", `${name} was built, installed and started on the emulated BUSY Bar, and stopped at once: ${first}`, `Fix the script, then run ${self} again.`, { ...data, error: first });
      }
      const text = outcome.running
        ? `${name} is running on the emulated BUSY Bar at ${address}: built, installed and started in ${seconds(outcome.ms)}.`
        : `${name} was built, installed and started on the emulated BUSY Bar at ${address} in ${seconds(outcome.ms)}; its script ran to its end at once without an error, so it is not running any more.`;
      return { data, text };
    }

    // ----------------------------------------------------------------------------------------------------- the loop
    say("watching", { folder: project.dir, id, address });
    const loop = oneAtATime(async (changed) => {
      try {
        last = await round(changed);
      } catch (e) {
        last = { ok: false, error: e };
        say("build_failed", { cycle: rounds, tool: "busy-emulator", exit_code: null, message: e instanceof CliError ? e.message : String(e?.stack ?? e), output: "", watching: true });
      }
    });
    let watchError = null;
    let lost = null;
    const watchLost = new Promise((resolve) => (lost = resolve));
    const watch = sys.watchProject ?? watchProject;
    let watcher;
    try {
      watcher = watch(project.dir, {
        onChange: (files) => loop.push(files),
        onError: (e) => {
          watchError = e;
          lost();
        },
      });
    } catch (e) {
      bar.close();
      throw new CliError("watch_failed", `The system would not watch ${project.dir} (${e?.code ?? e?.message ?? e}).`, `${commandFor(ctx, project, "dev", " --once")} does one round without watching.`);
    }
    let interrupt = null;
    const interrupted = new Promise((resolve) => (interrupt = resolve));
    const letGo = (sys.onInterrupt ?? onInterrupt)(() => {
      stopping = true;
      interrupt();
    });
    loop.push([]);
    const why = await Promise.race([interrupted.then(() => "interrupted"), consoleEnded.then(() => "console"), watchLost.then(() => "watch")]);
    stopping = true;
    watcher.close();
    loop.close();
    await loop.idle();
    letGo();
    bar.close();
    if (why === "console") {
      throw new CliError("not_running", "The emulator closed the BUSY Bar's console: it quit, or its server restarted. The watching stopped.", `Start it with ${again(ctx, "start")}, then run ${self} again.`, { rounds });
    }
    if (why === "watch") {
      throw new CliError("watch_failed", `The system stopped watching ${project.dir} (${watchError?.code ?? watchError?.message ?? watchError}).`, `Run ${self} again.`, { rounds });
    }
    return {
      data: { ...done(), stopped: "interrupted", rounds, last_ok: last?.ok ?? null },
      text: `Stopped watching after ${rounds} ${rounds === 1 ? "round" : "rounds"}. ${name} stays on the emulated BUSY Bar as it is; ${commandFor(ctx, project, "stop")} stops it.`,
    };
  },
};

/** The package the build makes, when it is there. */
function packageOf(project) {
  const file = project.id ? path.join(project.dir, "dist", `${project.id}.tgz`) : null;
  return file && existsSync(file) ? file : null;
}
