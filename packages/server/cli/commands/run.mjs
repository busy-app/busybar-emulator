// busy-emulator run [<folder> | <app-id>]: the project's app, started on the emulated BUSY Bar by the project's own busy-cli
// (`busy-cli app run --addr <the emulator>`) on the Node inside the app (EMU-217).
//
// Two things of its own around busy-cli, because an agent trips without them (the release rehearsal):
// - It installs first. When the project has a built package (dist/<id>.tgz, made by build), `busy-cli app install`
//   puts it on the BUSY Bar before the launch: the BUSY Bar then runs what was built last, not what was installed some time
//   ago, and run before install is no dead end. Without a package the app already on the BUSY Bar is started; when it is
//   not there either, the answer is not_built with the hint to build.
// - It looks at what came of the launch. The BUSY Bar answers "launched" for a script that throws on its first line. So
//   the command watches the BUSY Bar's log for a second (app-log.mjs): an app that ended with an error is app_crashed,
//   with the error's first line; one that ran to its end at once is told so; otherwise it is running.
// - It does not take "launched" for an app whose settings file the BUSY Bar refuses. The BUSY Bar then shows "Settings file is
//   invalid." in place of the app and still answers the launch with OK (the field test: `run` said it had started
//   the app). The project's settings file is checked before anything is installed, as build checks it; and when the
//   launch left no trace in the BUSY Bar's log, the BUSY Bar is asked for the app's settings: a schema it refuses is
//   settings_invalid too (a package built some other way).
import { existsSync } from "node:fs";
import path from "node:path";

import { jsonLine, momentOf, watchStart } from "../app-log.mjs";
import { blockedNetwork, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";
import { again, barAddress, busyCli, commandFor, installedFromProject, projectAt, remember, requireTrust, requireValidSettings, runTool, shown, toolFailed, TRUST_OPTION } from "../project.mjs";

/** Whether the bar has the app: true, false, or null when it would not say. */
async function onTheBar(sys, port, id) {
  const answer = await sys.barGet?.(port, "/api/apps/list");
  if (!answer || answer.status !== 200) return null;
  try {
    const apps = JSON.parse(answer.body).apps;
    return Array.isArray(apps) ? apps.some((app) => app?.id === id) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the bar refuses the settings schema of the app `id` (GET /api/apps/settings answers 503 then, as a bar's
 * api_apps.c does): the bar's words for it, or null when it takes the schema, has none, or would not say.
 */
async function barRefusesSettings(sys, port, id) {
  const answer = await sys.barGet?.(port, `/api/apps/settings?app_id=${encodeURIComponent(id)}`);
  if (!answer || answer.status !== 503) return null;
  try {
    return String(JSON.parse(answer.body).error ?? "the BUSY Bar refuses the app's settings schema");
  } catch {
    return "the BUSY Bar refuses the app's settings schema";
  }
}

/** An app's id, as `busy-cli app run <app-id>` takes one: app.<author>.<name>. */
const APP_ID = /^app\.[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/;

/**
 * run <app-id> (agent-path, as busy-cli app run <app-id>): an app that is on the emulated bar already, started by its
 * id with no project (POST /api/apps/launch), and watched for a second as a project's.
 */
async function runById(ctx, sys, id, progress) {
  const status = await emulatorStatus(ctx, sys);
  if (!ready(status)) throw new CliError("not_running", status.running ? `The emulator is running, but its BUSY Bar is not ready (${status.state}).` : "The emulator is not running, so there is no BUSY Bar to run the app on.", `Start it with ${again(ctx, "start")}, then run this again.`);
  const port = status.port;
  const address = `127.0.0.1:${port}`;
  const logs = again(ctx, `logs --app ${id}`);
  const since = sys.now();
  progress(`Launching ${id} on the emulated BUSY Bar at ${address}`);
  const launched = await sys.barSend(port, "POST", `/api/apps/launch?app_id=${encodeURIComponent(id)}`, null);
  if (launched.blocked) throw blockedNetwork(port, launched.blocked);
  if (launched.status === 404) throw new CliError("not_installed", `${id} is not on the emulated BUSY Bar.`, `Install it first: ${again(ctx, "install")} <its project folder or package.tgz>.`, { id });
  if (launched.status !== 200) {
    let said = null;
    try {
      said = JSON.parse(launched.body).error ?? null;
    } catch {
      // not JSON
    }
    throw new CliError("run_failed", `The emulated BUSY Bar did not start ${id}: ${said ?? launched.failed ?? `HTTP ${launched.status}`}.`, `Look at ${logs}.`, { id });
  }
  const seen = await watchStart(sys, port, id, since);
  const data = { id, address, running: seen.running, exited: seen.exited, errors: seen.errors, log: seen.lines.map(jsonLine) };
  if (seen.running === false && (seen.errors.length || seen.crashed)) {
    const first = seen.errors[0] ?? seen.exited;
    throw new CliError("app_crashed", `${id} started on the emulated BUSY Bar and stopped at once: ${first}`, `Its console and the error are in ${logs}.`, { ...data, error: first });
  }
  const said = seen.running === true ? `Started ${id} on the emulated BUSY Bar at ${address}; it is running. Its console: ${logs}.` : seen.running === false ? `Started ${id} on the emulated BUSY Bar at ${address}; it is not running any more (${seen.exited}).` : `Started ${id} on the emulated BUSY Bar at ${address}.`;
  return { data, text: said };
}

export default {
  name: "run",
  summary: "Install the project's built app on the emulated BUSY Bar and start it, or start an app the BUSY Bar has by its id; report whether it runs or why it stopped",
  usage: "run [<folder> | <app-id>]",
  maxArguments: 1,
  options: TRUST_OPTION,
  async run(ctx, sys, { args, options, progress }) {
    if (typeof args[0] === "string" && APP_ID.test(args[0]) && !existsSync(path.resolve(sys.cwd(), args[0]))) return runById(ctx, sys, args[0], progress);
    const project = projectAt(ctx, sys, args[0]);
    const trust = requireTrust(ctx, sys, project, options, "run");
    remember(ctx, project);
    requireValidSettings(ctx, project);
    const script = busyCli(ctx, project);
    const address = await barAddress(ctx, sys, project, "run");
    const port = Number(address.split(":")[1]);
    const build = commandFor(ctx, project, "build");
    const rerun = commandFor(ctx, project, "run");
    const outputs = [];

    // The package build made, onto the bar.
    const pack = project.id ? path.join(project.dir, "dist", `${project.id}.tgz`) : null;
    let installed = false;
    if (pack && existsSync(pack)) {
      progress(`busy-cli app install --addr ${address}`);
      const install = await runTool(ctx, sys, { tool: "node", args: [script, "app", "install", "--addr", address], cwd: project.dir });
      if (install.code !== 0) throw toolFailed(ctx, "busy-cli app install", install, `The built package did not install. Fix what busy-cli says (build again if the package is at fault: ${build}), then run ${rerun} again.`);
      outputs.push(shown(install.output));
      installed = true;
      await installedFromProject(ctx, sys, project, port);
    } else if (project.id && (await onTheBar(sys, port, project.id)) === false) {
      throw new CliError("not_built", `${project.id} is not on the emulated BUSY Bar, and the project has no built package to install (${pack}).`, `Build it first: ${build}; then run ${rerun} again.`, { folder: project.dir, id: project.id });
    }

    const since = sys.now();
    progress(`busy-cli app run --addr ${address}`);
    const run = await runTool(ctx, sys, { tool: "node", args: [script, "app", "run", "--addr", address], cwd: project.dir });
    if (run.code !== 0) {
      const missing = /HTTP 404/.test(run.output);
      throw toolFailed(ctx, "busy-cli app run", run, missing ? `The app is not on the BUSY Bar. Build it: ${build}; then run ${rerun} again (it installs the built package).` : `Fix what busy-cli says, then run ${rerun} again.`);
    }
    outputs.push(shown(run.output));
    const output = outputs.filter(Boolean).join("\n");

    // What came of it, by the bar's log.
    const logs = again(ctx, "logs");
    const seen = project.id ? await watchStart(sys, port, project.id, since) : { running: null, exited: null, crashed: false, errors: [], lines: [] };
    const log = seen.lines.map(jsonLine);
    const name = project.id ?? "the app";
    // No launch in the log: the launcher did not get as far as the script. When the bar refuses the app's settings
    // schema, that is why, and its screen says "Settings file is invalid." The firmware's own line says which field.
    if (project.id && seen.launched === false && seen.running === null) {
      const refused = await barRefusesSettings(sys, port, project.id);
      if (refused) {
        const lines = (await sys.barLog(port)).lines ?? [];
        const said = lines.filter((line) => momentOf(line) >= since && line.text.startsWith("[JsAppSettings] ")).at(-1)?.text.slice("[JsAppSettings] ".length) ?? null;
        throw new CliError(
          "settings_invalid",
          `${name} was not started: the BUSY Bar refuses the settings file in its package (appmeta/settings.json)${said ? `: ${said}` : ""}. The BUSY Bar shows "Settings file is invalid." instead of the app.`,
          `Build the project again: ${build} checks src/appmeta/settings.json and names the field at fault; then ${rerun}.`,
          { folder: project.dir, id: project.id, address, installed, running: false, problem: said ?? refused },
        );
      }
    }
    const data = { folder: project.dir, id: project.id, address, trusted: trust.trusted, installed, running: seen.running, exited: seen.exited, errors: seen.errors, log, output };
    // As dev --once judges it: an end with an error, or one that is the script's failure.
    if (seen.running === false && (seen.errors.length || seen.crashed)) {
      const first = seen.errors[0] ?? seen.exited;
      throw new CliError(
        "app_crashed",
        `${name} started on the emulated BUSY Bar and stopped at once: ${first}`,
        `Its console and the error are in ${logs}. Fix the script, then ${build} and ${rerun} again.`,
        { ...data, error: first },
      );
    }
    let said;
    if (seen.running === false && seen.exited !== "finished") said = `Started ${name} on the emulated BUSY Bar at ${address}; it was stopped at once (${seen.exited}) and is not running any more.`;
    else if (seen.running === false) said = `Started ${name} on the emulated BUSY Bar at ${address}; its script ran to its end at once without an error, so it is not running any more and the BUSY Bar is back in its menu. What it printed: ${logs}.`;
    else if (seen.running === true) said = `Started ${name} on the emulated BUSY Bar at ${address}; it is running${seen.errors.length ? `, and has printed an error: ${seen.errors[0]}` : ""}. Its console: ${logs}.`;
    else said = `Started ${name} on the emulated BUSY Bar at ${address}. Whether it still runs could not be read from the BUSY Bar's log; look with ${logs}.`;
    return { data, text: [output, said].filter(Boolean).join("\n") };
  },
};
