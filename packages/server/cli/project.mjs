// What the project commands share (create, build, install, run, stop; EMU-217): the folder of a project, whether it may
// be built, its tools on the bundled Node (../projects/node-tools.mjs), and what a tool's failure is told as. The
// commands are thin: the official generator and the project's own busy-cli do the work, and their failures come back
// in their own words, with their exit codes.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { busyCliScript, fixFontMaps, installArguments, networkFailure, plainText, readProject, tail, usesPnpm } from "../projects/node-tools.mjs";
import { checkSettingsSchema, MINIMAL_EXAMPLE, problemText } from "../projects/settings-schema.mjs";
import { createHash } from "node:crypto";

import { dependencyState, noteDependencies, noteInstalled, readProjects, rememberProject } from "../projects/registry.mjs";
import { isTrusted, trustedElsewhere } from "../projects/trust.mjs";
import { commandLine, emulatorStatus, ready } from "./lifecycle.mjs";
import { CliError, posixWord } from "./output.mjs";
import { SANDBOX_CODES } from "./system.mjs";

/**
 * The option every command that runs a project's code still takes, though it trusts nothing any more (requireTrust):
 * given, it is answered with what to do instead. It is in no command's usage.
 */
export const TRUST_OPTION = Object.freeze({ "--trust": { key: "trust" } });

/** What the tools of a project run with: the bundled Node, the data folder, the caller's environment (cleaned there). */
export function toolSetup(ctx) {
  return { tools: ctx.nodeTools, dataDir: ctx.dataDir, platform: ctx.platform, env: ctx.env ?? {}, windowsDir: ctx.windowsDir ?? null };
}

/** How a command of this command line is spelled in a hint, from the folder the caller is in. */
export function again(ctx, words) {
  return `${commandLine(ctx)} ${words}`;
}

/** A folder for a hint, as the caller can paste it after cd. */
export function shellWord(ctx, text) {
  return ctx.platform === "win32" ? `"${text}"` : posixWord(text);
}

/**
 * A command of this command line for a hint about `project`: with the folder as the caller gave it, so that the hint
 * typed where the caller is acts on the same project (EMU-206 review, R1). `extra` goes after the folder.
 */
export function commandFor(ctx, project, name, extra = "") {
  const folder = project?.given ? ` ${shellWord(ctx, project.given)}` : "";
  return again(ctx, `${name}${folder}${extra}`);
}

/**
 * The project in `folder` (relative to the caller's folder; the caller's folder itself when not given), by its real path.
 * @returns {{ dir: string, manifest: object, id: string|null }}
 */
export function projectAt(ctx, sys, folder) {
  const given = path.resolve(sys.cwd(), folder ?? ".");
  let dir;
  try {
    dir = realpathSync.native(given);
  } catch (e) {
    if (SANDBOX_CODES.has(e?.code)) throw new CliError("blocked_file", `This process may not read ${given} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
    throw new CliError("not_a_project", `There is no folder ${given}.`, `Run it in the folder of an app project, or name the folder: ${again(ctx, "build <folder>")}.`, { folder: given });
  }
  const read = readProject(dir);
  if (!read.project) {
    throw new CliError("not_a_project", `${dir} is not an app project: ${read.why}.`, `Run it in the folder of an app project, or create one with ${again(ctx, "create <folder>")}.`, { folder: dir });
  }
  return { dir, given: folder ?? null, manifest: read.manifest, id: appId(dir) };
}

/**
 * Notes the project in the emulator's list of projects (projects/registry.mjs), which says where the project of an app
 * on the bar lies. Every command that works on a project does it once the project may be worked on; a list that
 * cannot be written (a sandbox) is never the command's failure.
 */
export function remember(ctx, project) {
  try {
    rememberProject(ctx.dataDir, project.dir, { platform: ctx.platform });
  } catch {
    // The command goes on without the note.
  }
}

/** The files of an installed app that say which build it is. */
const MARKED_FILES = ["appmeta/manifest.json", "scripts/main.js"];

/**
 * A mark of the app `id` as the bar holds it now: a hash of its manifest and its script, read through the bar's own
 * API. Null when the bar does not hold the app or would not give the files. Two installs of the same build have the
 * same mark; an app of the same id from elsewhere (an archive, another project) has another.
 */
export async function barAppMark(sys, port, id) {
  const hash = createHash("sha256");
  for (const file of MARKED_FILES) {
    const answer = await sys.barGet?.(port, `/api/storage/read?path=${encodeURIComponent(`/ext/user_assets/${id}/${file}`)}`);
    if (!answer || answer.status !== 200 || typeof answer.body !== "string") return null;
    hash.update(`${file}\0${answer.body.length}\0${answer.body}\0`);
  }
  return hash.digest("hex");
}

/**
 * Notes that this project's build has just been installed on the bar, with the mark of what the bar holds now: what
 * makes the app on the bar this project's (projects --prune removes only such an app with its folder). Never a
 * command's failure.
 */
export async function installedFromProject(ctx, sys, project, port) {
  if (!project.id) return;
  try {
    noteInstalled(ctx.dataDir, project.dir, project.id, await barAppMark(sys, port, project.id), { platform: ctx.platform });
  } catch {
    // The command goes on without the note: the app then counts as nobody's, and nothing removes it.
  }
}

/** The app's id from its manifest, where the official template keeps it (src/appmeta, or appmeta at the top). */
export function appId(dir) {
  for (const file of [path.join(dir, "src", "appmeta", "manifest.json"), path.join(dir, "appmeta", "manifest.json")]) {
    try {
      const id = JSON.parse(readFileSync(file, "utf8")).id;
      if (typeof id === "string") return id;
    } catch {
      // the next place
    }
  }
  return null;
}

/** The project's settings file where the official template keeps it (beside the manifest), or null when it has none. */
export function settingsFile(dir) {
  for (const file of [path.join(dir, "src", "appmeta", "settings.json"), path.join(dir, "appmeta", "settings.json")]) {
    if (existsSync(file)) return file;
  }
  return null;
}

/** The failure for a settings file the firmware would refuse: which file, which field, what to change. */
export function settingsInvalid(ctx, project, file, check, { onTheBar = false } = {}) {
  const shown = path.relative(project.dir, file) || file;
  const where = check.field === null ? shown : `${shown}, field "${check.field}"`;
  return new CliError(
    "settings_invalid",
    `The app's settings file is invalid, ${where}: ${check.problem}.${onTheBar ? ' The BUSY Bar shows "Settings file is invalid." instead of the app.' : ' A BUSY Bar would show "Settings file is invalid." instead of the app.'}`,
    `${check.advice ? `${check.advice} ` : ""}Fix ${shown}, then run ${commandFor(ctx, project, "build")} again. The smallest valid file: ${JSON.stringify(MINIMAL_EXAMPLE)} ("fields" is a map keyed by the field's id; every field has "type", "label" and "default").`,
    { folder: project.dir, file, field: check.field, problem: check.problem, summary: problemText(check), example: MINIMAL_EXAMPLE },
  );
}

/**
 * The project's settings file, checked as the firmware checks it (projects/settings-schema.mjs): a file the bar would
 * refuse is a failure here, with the field at fault — the bar itself says only "Settings file is invalid." and the
 * launch still answers "launched" (the field test). A project without the file has no settings: nothing to check.
 * @returns {"none" | "valid"}
 */
export function requireValidSettings(ctx, project) {
  const file = settingsFile(project.dir);
  if (!file) return "none";
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new CliError("settings_invalid", `The app's settings file ${file} cannot be read (${e?.code ?? e?.message ?? e}).`, `Make the file readable, then run ${commandFor(ctx, project, "build")} again.`, { folder: project.dir, file });
  }
  const check = checkSettingsSchema(text);
  if (!check.ok) throw settingsInvalid(ctx, project, file, check);
  return "valid";
}

/** `busy-emulator trust <folder>` for a hint: with the folder as the caller gave it, or "." for the caller's own. */
export function trustCommand(ctx, project) {
  return again(ctx, `trust ${shellWord(ctx, project?.given ?? ".")}`);
}

/**
 * Building a project runs code from its folder (ADR-0012 §4): only a trusted one. A project the emulator created is.
 * Another one the person trusts, in one way only: their click in the dialog of the running app, which
 * `busy-emulator trust <folder>` asks for (commands/trust.mjs). Nothing on the command line trusts a folder. --trust,
 * which a person at a terminal could once give, trusts nothing any more: "a terminal" was told by isTTY, and any
 * program can give a command a pseudo-terminal (`script -q /dev/null busy-emulator build <folder> --trust`), so it
 * was consent without a person (the security review of pull request 59). The option is still taken, so that an old
 * instruction gets an answer that says what to do: trust_needs_person, with the same hint as untrusted_project.
 */
export function requireTrust(ctx, sys, project, options, commandName) {
  if (isTrusted(ctx.dataDir, project.dir, ctx.platform)) return { trusted: "before" };
  const asking = trustCommand(ctx, project);
  // The project the emulator knew at another place: moved or renamed after create (or after the person trusted it).
  // Trust is not carried along (the rule stays: only a person trusts a folder the emulator does not know at its
  // place), but the answer says that this is the cause and names the one command, so that nobody takes their own
  // project for a stranger's.
  const moved = trustedElsewhere(ctx.dataDir, project.dir, ctx.platform);
  const extra = moved ? { folder: project.dir, reason: "moved", trusted_as: moved.path, ask: asking } : { folder: project.dir, reason: "unknown_folder", ask: asking };
  const then = `then run ${commandFor(ctx, project, commandName)} again`;
  const running = `The emulator must be running for it: if it is not, run ${again(ctx, "start")} first.`;
  const askThePerson = moved
    ? `Run ${asking}: the emulator asks the person, in a dialog on their screen, to trust the folder at its new place; ${then}. ${running} (Or move the folder back to ${moved.path}.)`
    : `Run ${asking}: the emulator asks the person, in a dialog on their screen, whether they trust the folder; ${then}. ${running}`;
  const cause = moved
    ? `${project.dir} is the project the emulator ${moved.how === "created" ? "created" : "trusted"} as ${moved.path}; it was moved or renamed since, and trust is kept for a folder at its place, so here it has to be trusted again`
    : null;
  if (options.trust) {
    throw new CliError(
      "trust_needs_person",
      `${cause ? `${cause}. ` : ""}--trust trusts nothing: a folder is trusted only by the person's click in the emulator's own dialog, so ${project.dir} stays untrusted.`,
      askThePerson,
      extra,
    );
  }
  throw new CliError(
    "untrusted_project",
    cause
      ? `${cause}: building it runs code from it, and only a person can say that a folder at a new place is still theirs.`
      : `${project.dir} is not trusted: it was not created by this emulator's create (it was made by npm create or by hand, cloned or copied), and building it runs its code on this computer: its node_modules, its .npmrc, its build settings.`,
    askThePerson,
    extra,
  );
}

/**
 * Runs one tool of a project through the system (sys.runTool: runNodeTool) and gives its result. The failures of the
 * start itself become errors here; the tool's own exit code is the caller's to judge.
 */
export async function runTool(ctx, sys, request) {
  try {
    return await sys.runTool(toolSetup(ctx), request);
  } catch (e) {
    if (e?.code === "no_node_tools") {
      throw new CliError("no_node_tools", `This copy of the emulator has no Node to run the project's tools on: ${e.message}.`, "Install the emulator again: the app is incomplete.");
    }
    if (SANDBOX_CODES.has(e?.code)) {
      throw new CliError("blocked_file", `This process may not write ${e.path ?? ctx.dataDir} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
    }
    throw e;
  }
}

/** npm's lines of a JavaScript stack ("npm error     at …"): long, and nothing for the reader. */
const STACK_LINE = /^npm (error|ERR!)\s+at /;
/** npm's line for each answer of the registry (--loglevel=http): the watch's, not the reader's. */
const HTTP_LINE = /^npm http /;

/** The end of a tool's output for an answer, without npm's stack lines and its lines for each request. */
function outputOf(run) {
  return tail(plainText(run.output).split("\n").filter((line) => !STACK_LINE.test(line) && !HTTP_LINE.test(line)).join("\n"));
}

/** The lines of a tool's output that say what went wrong: npm's "npm error" lines, otherwise the end of it. */
function errorLines(output) {
  const text = tail(plainText(output).split("\n").filter((line) => !HTTP_LINE.test(line)).join("\n"), { lines: 60, chars: 8000 });
  const npm = text.split("\n").filter((line) => /^npm (error|ERR!)/.test(line) && !STACK_LINE.test(line));
  return npm.length ? npm.slice(0, 12).join("\n") : tail(text, { lines: 12, chars: 2000 });
}

/**
 * The error for a tool that ended with a code other than 0: its own words and its exit code. npm that could not reach
 * the registry is told apart: a sandbox that refused the connection (blocked_network) or no way there (network_failed);
 * `networkHint(kind)` gives a command's own next step for those (create: the project is there, build goes on). A tool
 * stopped by a signal (Ctrl+C) was interrupted, not failed.
 */
export function toolFailed(ctx, tool, run, hint, { networkHint = null, extra: more = {} } = {}) {
  const extra = { ...more, tool, exit_code: run.code, signal: run.signal ?? null, output: outputOf(run) };
  // Stopped by the watch (runNpm): a request failed twice, npm hung on the registry, or ran too long.
  if (run.stopped === "network") {
    const { url, reason } = run.because;
    if (SANDBOX_REASON.test(reason)) return new CliError("blocked_network", `${tool} may not connect to ${url} (${reason}): a sandbox is in the way.`, networkHint?.("blocked") ?? "Run the same busy-emulator command again outside the sandbox: npm needs the registry.", extra);
    return new CliError("network_failed", `${tool} could not reach ${url}: ${reason}.`, networkHint?.("failed") ?? "Check the connection; a registry or proxy of your own goes into your .npmrc, which the emulator's npm reads.", extra);
  }
  if (run.stopped) return stalledError(ctx, tool, run, networkHint?.("failed") ?? hint, more);
  if (run.signal) return new CliError("interrupted", `${tool} was stopped (${run.signal}) before it ended.`, "Run the same command again when you want it to go on.", extra);
  const network = networkFailure(run.output);
  if (network?.kind === "blocked") {
    return new CliError("blocked_network", `${tool} may not connect to ${network.url ?? "the npm registry"} (${network.reason}): a sandbox is in the way.`, networkHint?.("blocked") ?? "Run the same busy-emulator command again outside the sandbox: npm needs the registry.", extra);
  }
  if (network) {
    return new CliError("network_failed", `${tool} could not reach ${network.url ?? "the npm registry"}: ${network.reason}.`, networkHint?.("failed") ?? "Check the connection; a registry or proxy of your own goes into your .npmrc, which the emulator's npm reads.", extra);
  }
  return new CliError("tool_failed", `${tool} failed with exit code ${run.code}:\n${errorLines(run.output)}`, hint, extra);
}

/**
 * What to do about a `busy-cli build` that failed: `otherwise`, unless the failure is one the emulator knows the way
 * out of. On Windows busy-cli packs with the system's tar.exe, which takes no path with letters outside the system's
 * code page; busy-cli's own words ("Command failed: tar ...") do not say so. The same hint for every command that
 * builds (build, dev).
 */
export function buildFailureHint(ctx, project, run, otherwise) {
  if (ctx.platform === "win32" && /Command failed: tar /.test(run.output ?? "") && /[^\x00-\x7f]/.test(project.dir)) {
    return "busy-cli packs with Windows' own tar.exe, which takes no path with letters outside the system's code page: move the project to a folder whose path has only Latin letters.";
  }
  return otherwise;
}

// ---- npm and the network (create-offline)

/**
 * How long npm may say nothing before it is stopped, how long it may run at all, and how often the silence is told.
 * npm prints a line for every request it gets an answer to (--loglevel=http), so a minute of silence is a minute in
 * which no answer came: the Wi-Fi out of range, whose connection stays open. A test names shorter times
 * (BUSY_EMULATOR_TEST_NPM_QUIET, in seconds; never in a release), for every run or for `kind` "dependencies" only (the
 * installs of a project's dependencies, not of the template's generator): an npm that is starting on a loaded machine
 * says nothing for seconds too, and a test that means the dependencies' install to hang does not stop the
 * generator's for that.
 */
export function npmWatch(ctx, progress, kind = null) {
  const quietMs = ctx.npmQuietMs != null && (!ctx.npmQuietFor || ctx.npmQuietFor === kind) ? ctx.npmQuietMs : 45_000;
  return {
    quietMs,
    failsOn: retryFailed,
    limitMs: 15 * 60_000,
    tellMs: Math.max(1000, Math.min(15_000, Math.round(quietMs / 4))),
    onQuiet: (ms) => progress?.(`No answer from the npm registry for ${Math.round(ms / 1000)} s…`),
  };
}

/**
 * A request npm retried and that failed again ("npm http fetch GET <url> attempt 2 failed with ECONNRESET"): the
 * network is down, and npm would go on so for every package, 12 s each, before it takes the stale ones of its cache
 * (4.5 min for a project, measured). Null when the piece of output has none.
 */
export function retryFailed(text) {
  for (const match of plainText(text).matchAll(/^npm http fetch \S+ (\S+) attempt (\d+) failed with (\S+)/gm)) {
    if (Number(match[2]) >= 2) return { url: match[1], reason: match[3] };
  }
  return null;
}

/** The registry npm asks, as the caller's environment names it, for a message. */
function registryOf(ctx) {
  const env = ctx.env ?? {};
  const named = Object.entries(env).find(([key]) => key.toLowerCase() === "npm_config_registry")?.[1];
  return typeof named === "string" && named ? named : "https://registry.npmjs.org/";
}

const SANDBOX_REASON = /\b(EPERM|EACCES)\b/;

/** The codes of the failures that are the network's: what a retry with the network back may cure. */
export const NETWORK_CODES = new Set(["network_failed", "network_stalled"]);

/**
 * Runs npm for a project or a tool folder with the watch on: its progress told as it goes (how many answers came,
 * the silence), and stopped when it hangs. Gives the run, as runTool does.
 */
export async function runNpm(ctx, sys, { args, cwd, progress, what, kind = null }) {
  let answers = 0;
  let toldAt = 0;
  const watch = npmWatch(ctx, progress, kind);
  const run = await runTool(ctx, sys, {
    tool: "npm",
    args: [...args, "--loglevel=http"],
    cwd,
    watch,
    onOutput: (text) => {
      answers += (plainText(text).match(/^npm http fetch \S+ \d{3} /gm) ?? []).length;
      const now = Date.now();
      if (answers && now - toldAt >= 5000) {
        toldAt = now;
        progress?.(`${what}: ${answers} ${answers === 1 ? "file" : "files"} fetched so far…`);
      }
    },
  });
  return { ...run, quietMs: watch.quietMs };
}

/** The error of an npm the watch stopped: it hung (no answer for a while) or ran too long. */
function stalledError(ctx, tool, run, hint, extra) {
  const seconds = Math.round((run.quietMs ?? npmWatch(ctx).quietMs) / 1000);
  const message = run.stopped === "limit" ? `${tool} ran for 15 minutes without ending, so it was stopped.` : `${tool} got no answer from ${registryOf(ctx)} for ${seconds} s, so it was stopped: the connection hangs.`;
  return new CliError("network_stalled", message, hint, { ...extra, tool, exit_code: run.code, signal: run.signal ?? null, output: outputOf(run) });
}

/** A short line of why an install failed, for the window's row (and its note in the list). */
function failureWords(error) {
  return String(error?.message ?? "npm failed").split("\n")[0].slice(0, 300);
}

/**
 * Installs the dependencies of the project in `dir` with the bundled npm (npm ci with a lock file, npm install
 * without; no install scripts): the one way create, build, dev and typecheck do it. The list of projects notes the
 * install while it runs and when it fails (projects/registry.mjs, noteDependencies), so that a list read later can
 * say so and the next build installs again over what npm may have left half-written.
 *
 * When the registry cannot be reached (no network, or no answer), npm is tried once more with --offline: from its
 * cache in the data folder, where the packages of every project created before lie. `networkDown` (the error of a
 * step just before, create's template) goes to --offline at once.
 * @returns {Promise<"installed"|"cache">}
 */
export async function installDependencies(ctx, sys, dir, { progress, hint, networkHint = null, networkDown = null, extra = {} }) {
  refuseWhileInstalling(ctx, dir);
  const args = installArguments(dir);
  const pnpm = usesPnpm(dir);
  const tool = `npm ${args[0]}`;
  noteDependencies(ctx.dataDir, dir, { state: "installing", pid: process.pid, at: new Date().toISOString() }, { platform: ctx.platform });
  const fail = (error) => {
    noteDependencies(ctx.dataDir, dir, { state: "failed", code: error.code, message: failureWords(error), at: new Date().toISOString() }, { platform: ctx.platform });
    return error;
  };
  let error = networkDown;
  if (!networkDown) {
    progress?.(`Installing the dependencies (${tool}, without install scripts${pnpm ? "; the project is pnpm's: pnpm-lock.yaml is left as it is and no package-lock.json is written" : ""})…`);
    const run = await runNpm(ctx, sys, { args, cwd: dir, progress, what: "Installing the dependencies", kind: "dependencies" });
    if (run.code === 0 && !run.stopped) return finished(ctx, dir, tool, "installed");
    error = toolFailed(ctx, tool, run, hint, { networkHint, extra });
    if (!NETWORK_CODES.has(error.code)) throw fail(error);
  }
  // The network is down: npm's cache may hold all of it.
  progress?.(`${error.code === "network_stalled" ? "The npm registry does not answer" : "The npm registry cannot be reached"}: trying npm's cache…`);
  const cached = await runNpm(ctx, sys, { args: [...args, "--offline"], cwd: dir, progress, what: "Installing from npm's cache", kind: "dependencies" });
  if (cached.code === 0 && !cached.stopped) {
    progress?.("Installed from npm's cache: the registry was not reached.");
    return finished(ctx, dir, tool, "cache");
  }
  // The network's error of a step before (create's template) said nothing of this folder.
  if (error === networkDown) error = new CliError(error.code, `The dependencies were not installed: ${error.message.replace(/\.$/, "")}, and npm's cache does not hold all of them.`, networkHint?.("failed") ?? hint, { ...error.extra, ...extra, tool });
  throw fail(error);
}

function finished(ctx, dir, tool, how) {
  if (!busyCliScript(dir)) {
    const error = new CliError("tool_failed", `${tool} ended, but ${dir} still has no busy-cli in node_modules.`, "Check that @busy-app/cli is among the project's devDependencies.", { folder: dir });
    noteDependencies(ctx.dataDir, dir, { state: "failed", code: error.code, message: failureWords(error), at: new Date().toISOString() }, { platform: ctx.platform });
    throw error;
  }
  noteDependencies(ctx.dataDir, dir, null, { platform: ctx.platform });
  return how;
}

/**
 * Another command of this command line (the window's button, an agent) installs this project's dependencies right now:
 * the list of projects notes a live install (registry.mjs, noteDependencies). A second npm in the same node_modules, or
 * a build over a node_modules that npm is still writing, fails in ways that name neither cause; so the second command
 * is told, and the person or the agent runs it again when the first one has ended.
 */
export function refuseWhileInstalling(ctx, dir) {
  const same = (a, b) => (ctx.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  const entry = readProjects(ctx.dataDir).find((one) => same(one.path, dir));
  if (entry?.deps?.state !== "installing" || entry.deps.pid === process.pid) return;
  if (dependencyState(entry).state !== "installing") return;
  throw new CliError(
    "install_running",
    `Another command is installing the dependencies of ${dir} right now (process ${entry.deps.pid}, since ${entry.deps.at}).`,
    "Wait until it has ended, then run this command again.",
    { folder: dir, pid: entry.deps.pid, since: entry.deps.at },
  );
}

/**
 * Whether the project's dependencies must be installed: its busy-cli is not there, or the last install of the
 * emulator's own failed or was cut off (node_modules may be half-written, busy-cli in it and the rest not).
 */
export function dependenciesNeeded(ctx, dir) {
  if (!busyCliScript(dir)) return true;
  const entry = readProjects(ctx.dataDir).find((one) => (ctx.platform === "win32" ? one.path.toLowerCase() === dir.toLowerCase() : one.path === dir));
  if (!entry?.deps) return false;
  const state = dependencyState(entry).state;
  return state === "failed" || state === "interrupted";
}

/** Installs the project's dependencies when they are needed (dependenciesNeeded): "present", "installed" or "cache". */
export async function ensureDependencies(ctx, sys, project, progress) {
  refuseWhileInstalling(ctx, project.dir);
  if (!dependenciesNeeded(ctx, project.dir)) return "present";
  return installDependencies(ctx, sys, project.dir, { progress, hint: `Fix what npm says, then run ${commandFor(ctx, project, "build")} again.`, extra: { folder: project.dir } });
}

/** busy-cli's fonts path on Windows (projects/node-tools.mjs): fixed in the project, told only when it was. */
export function fixBusyCli(ctx, project) {
  return fixFontMaps(project.dir, ctx.platform);
}

/** The project's busy-cli, which install, run and stop need installed. */
export function busyCli(ctx, project) {
  const script = busyCliScript(project.dir);
  if (!script) {
    throw new CliError("no_dependencies", `${project.dir} has no busy-cli in node_modules: its dependencies are not installed.`, `Run ${commandFor(ctx, project, "build")} first: it installs them.`, { folder: project.dir });
  }
  return script;
}

/** The address of the emulated bar, for busy-cli's --addr; the emulator must be running and its bar ready. */
export async function barAddress(ctx, sys, project, commandName) {
  const status = await emulatorStatus(ctx, sys);
  if (!ready(status)) {
    const hint = `Start it with ${again(ctx, "start")}, then run ${commandFor(ctx, project, commandName)} again.`;
    if (!status.running) throw new CliError("not_running", `The emulator is not running, so there is no BUSY Bar to ${commandName === "install" ? "install the app on" : commandName === "run" ? "run the app on" : "stop the app on"}.`, hint);
    throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
  }
  return `127.0.0.1:${status.port}`;
}

/** A tool's output for a person: the text without color codes, or nothing. */
export function shown(output) {
  return tail(output, { lines: 200, chars: 20000 });
}

/** busy-cli's words for the bar's 409 to POST /api/apps/quit (@busy-app/cli 0.6, lib/device.js). */
const NOTHING_RUNNING = /No app is running/;

/**
 * install and stop (and what run starts with; commands/run.mjs): `busy-cli app <name> --addr <the emulated bar>` of
 * the project, in its folder. Nothing of their own: the emulator must be running, the dependencies installed (build installs them), and busy-cli's failure
 * comes back in its words.
 */
export function appCommand({ name, summary, done }) {
  const usage = `${name} [<folder>]`;
  return {
    name,
    summary,
    usage,
    maxArguments: 1,
    options: TRUST_OPTION,
    async run(ctx, sys, { args, options, progress }) {
      const project = projectAt(ctx, sys, args[0]);
      const trust = requireTrust(ctx, sys, project, options, name);
      remember(ctx, project);
      const script = busyCli(ctx, project);
      const address = await barAddress(ctx, sys, project, name);
      progress(`busy-cli app ${name} --addr ${address}`);
      const run = await runTool(ctx, sys, { tool: "node", args: [script, "app", name, "--addr", address], cwd: project.dir });
      // stop with no app running: busy-cli fails on the bar's 409 ("No app is running."), but what was asked for is
      // so already, and the answer says it (the release dry run).
      if (name === "stop" && run.code !== 0 && !run.signal && NOTHING_RUNNING.test(run.output ?? "")) {
        return {
          data: { folder: project.dir, id: project.id, address, trusted: trust.trusted, stopped: false, was_running: false, output: shown(run.output) },
          text: `No app was running on the emulated BUSY Bar at ${address}: there was nothing to stop.`,
        };
      }
      if (run.code !== 0) {
        const nothing = /Nothing to install/.test(run.output);
        throw toolFailed(ctx, `busy-cli app ${name}`, run, nothing ? `Build it first: ${commandFor(ctx, project, "build")}.` : `Fix what busy-cli says, then run ${commandFor(ctx, project, name)} again.`);
      }
      if (name === "install") await installedFromProject(ctx, sys, project, Number(address.split(":")[1]));
      const output = shown(run.output);
      return {
        data: { folder: project.dir, id: project.id, address, trusted: trust.trusted, ...(name === "stop" ? { stopped: true, was_running: true } : {}), output },
        text: [output, done(project, address)].filter(Boolean).join("\n"),
      };
    },
  };
}
