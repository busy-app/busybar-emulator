// "Open in Terminal" (macOS) and "Open in cmd" (Windows) of the window's console: the system's terminal, in the chosen
// app's project folder, running `busy-emulator logs --follow` with the console's filters and from its Clear; when the
// person stops it with Ctrl+C, the terminal stays, in that folder, with busy-emulator on its PATH.
//
// The rules (legacy-window/README.md, "The rules behind it"): only the main window's page asks, just after a click or
// a key (bridge.mjs); the command is built here from known parts alone. The page names an app, a folder, kinds and a
// moment, and each is checked, never pasted: the app must be one the emulator has (a project's or the bar's), the
// folder a trusted project's of the list, the kinds words of a fixed set, the moment a whole number. The command line
// is the app's own launcher, by its full path. Nothing the page sends reaches a shell as text.
//
// Why trusted: the terminal stays in the folder for the person to type in, and on Windows cmd looks in the current
// folder before PATH, so an npm.cmd, git.bat or busy-emulator.cmd that a downloaded project holds would run for
// `npm`, `git` or `busy-emulator` (audit, 11.11). The cmd window gets NoDefaultCurrentDirectoryInExePath=1, which
// stops that look, and an untrusted folder is not opened at all.
//
//   macOS: a script in the data folder (run/terminal/<random>.command, 0700), opened with `open -a Terminal`, which
//          asks for no permission (AppleScript's `do script` would ask for the control of Terminal). The script
//          removes itself first; one that Terminal never ran is removed at the next opening.
//   Windows: `cmd.exe /d /c start "<title>" cmd.exe /d /s /k ""%BUSY_EMULATOR_TERMINAL_CLI%" logs …"` in a process
//          of its own (not in the app's job, so the window stays when the app quits), started in the folder. The
//          launcher's path goes in the environment, so no path is ever read by cmd as text: spaces, letters of any
//          alphabet, & or % in it change nothing.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { shellQuote } from "./install-files.mjs";

/** The console's filters as `logs --kind` names them; console (what apps print) has no filter in the window. */
export const TERMINAL_KINDS = Object.freeze(["console", "lifecycle", "build", "system"]);
/** As many lines as the window's console keeps. */
export const TERMINAL_LINES = 2000;
const APP_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,31}$/;
const MAX_PATH = 4096;
/** A script Terminal has not run in this time never will: the next opening removes it. */
export const STALE_SCRIPT_MS = 60_000;
export const SCRIPT_FOLDER_PARTS = Object.freeze(["run", "terminal"]);
/** The variable that carries the launcher's path into the cmd window. */
export const CLI_VARIABLE = "BUSY_EMULATOR_TERMINAL_CLI";

/** The name of the system's terminal, and the label of the window's button. */
export function terminalName(platform) {
  return platform === "win32" ? "cmd" : platform === "darwin" ? "Terminal" : null;
}

/** The words after the command line's own path: `logs --follow` with the console's filters. Checked parts only. */
export function logsWords({ app = null, kinds, since = null }) {
  const words = ["logs", "--follow"];
  words.push(...(app === null ? ["--all"] : ["--app", app]));
  words.push("--kind", TERMINAL_KINDS.filter((kind) => kinds.includes(kind)).join(","));
  if (since !== null) words.push("--since", String(since));
  words.push("--lines", String(TERMINAL_LINES));
  return words;
}

/** The macOS script: to the folder, the launcher's folder on PATH, the log, then the person's own shell. */
export function macScript({ cli, words, folder = null, env = {} }) {
  return [
    "#!/bin/sh",
    "# BUSY Bar Emulator: the window's console in Terminal. This file removes itself.",
    'rm -f "$0"',
    folder ? `cd ${shellQuote(folder)} || cd` : "cd",
    `PATH=${shellQuote(path.posix.dirname(cli))}:"$PATH"`,
    "export PATH",
    ...Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}; export ${name}`),
    "clear",
    // Ctrl+C ends the log, not this script: the shell below comes after it.
    "trap : INT",
    [cli, ...words].map(shellQuote).join(" "),
    "trap - INT",
    'exec "${SHELL:-/bin/zsh}" -l',
    "",
  ].join("\n");
}

/** The words of the logs command are a fixed set's: nothing in them is read by cmd as anything but a word. */
const PLAIN_WORD = /^[A-Za-z0-9,._-]+$/;

/**
 * The Windows start: cmd.exe, which starts a new cmd window and ends. Its arguments go to it as they are written here
 * (windowsVerbatimArguments). `%^NAME%` keeps the first cmd from putting the path in: it reads `^N` as N and leaves
 * `%NAME%` for the second, which puts it in between quotes.
 * @returns {{ file: string, args: string[], cwd: string, env: Record<string, string> }}
 */
export function windowsStart({ cmd, cli, words, folder, home, env = {}, baseEnv = {} }) {
  if (!words.every((word) => PLAIN_WORD.test(word))) throw new Error("a word of the logs command is not plain");
  const inner = `""%^${CLI_VARIABLE}%" ${words.join(" ")}"`;
  const line = `/d /c start "busy-emulator logs" "${cmd}" /d /s /k ${inner}`;
  const out = { ...baseEnv };
  const pathKey = Object.keys(out).find((name) => name.toUpperCase() === "PATH") ?? "Path";
  // Only absolute folders, as findProgram (engine/programs.mjs) takes them: "." or another relative entry of PATH is the
  // project's folder, or one inside it, in that window (review of pull request 120).
  const absolute = String(out[pathKey] ?? "").split(";").map((entry) => entry.trim().replace(/^"(.*)"$/, "$1")).filter((entry) => entry && path.win32.isAbsolute(entry));
  for (const name of Object.keys(out)) if (name.toUpperCase() === "PATH") delete out[name];
  out[pathKey] = [path.win32.dirname(cli), ...absolute].join(";");
  // cmd finds a command by its name in PATH alone, not first in the current folder (the project's).
  Object.assign(out, env, { [CLI_VARIABLE]: cli, NoDefaultCurrentDirectoryInExePath: "1" });
  return { file: cmd, args: [line], cwd: folder ?? home, env: out };
}

/** cmd.exe by its full path, from the system's folder; never by name, which would look in the current folder first. */
export function cmdPath(env) {
  const root = [env.SystemRoot, env.SYSTEMROOT, env.windir].find((value) => typeof value === "string" && /^[A-Za-z]:\\[^"%]*$/.test(value)) ?? "C:\\Windows";
  return path.win32.join(root, "System32", "cmd.exe");
}

const refusal = (code, message, hint = null) => ({ ok: false, error: { code, message, hint } });

/**
 * @param {object} o
 * @param {string} o.platform
 * @param {string | null} o.cli     the command line's launcher (config.installFiles.launcher), or null: none
 * @param {Record<string, string>} [o.env]   what the command line must be told in a development run or the test
 *   variant (the data folder and the port, as cliEnvironment does); nothing in a release
 * @param {() => Promise<object[]>} o.projects   the emulator's projects ({ id, folder, exists, unavailable })
 * @param {() => Promise<string[]>} o.barApps    the ids of the apps on the emulated bar
 * @param {(plan: object) => void | Promise<void>} o.launch   opens the terminal: launchTerminal, or a test's record
 * @param {(file: string) => boolean} [o.exists]
 * @param {() => number} [o.now]
 * @param {(line: string) => void} o.log
 */
export function createTerminal({ platform, cli, env = {}, projects, barApps, launch, exists = existsSync, now = Date.now, log }) {
  const name = terminalName(platform);
  function info() {
    if (!name) return { available: false, name: null, label: "Open in a terminal", why: "Not on this system" };
    const label = `Open in ${name}`;
    if (!cli || !exists(cli)) return { available: false, name, label, why: "Needs the busy-emulator command, which the installed app sets up when it starts" };
    return { available: true, name, label, why: null };
  }

  async function open(arg) {
    const can = info();
    if (!can.available) return refusal("no_cli", `${can.label} is not available: ${can.why.toLowerCase()}.`);
    if (!arg || typeof arg !== "object" || Array.isArray(arg) || Object.keys(arg).some((key) => !["app", "folder", "kinds", "since"].includes(key))) {
      return refusal("bad_request", "The window asked for the terminal in a form the app does not know.");
    }
    const { app = null, folder = null, kinds, since = null } = arg;
    if (!Array.isArray(kinds) || kinds.length > TERMINAL_KINDS.length || !kinds.length || kinds.some((kind) => !TERMINAL_KINDS.includes(kind))) {
      return refusal("bad_request", `The console's filters are some of ${TERMINAL_KINDS.join(", ")}.`);
    }
    if (since !== null && !(Number.isSafeInteger(since) && since >= 0 && since <= now() + 86_400_000)) return refusal("bad_request", "The console's start is a moment in Unix milliseconds.");
    if (app !== null && !(typeof app === "string" && APP_ID.test(app))) return refusal("unknown_app", "This is not an app's id.");
    if (folder !== null && !(typeof folder === "string" && folder.length <= MAX_PATH)) return refusal("unknown_project", "This is not a project of the emulator.");
    const list = app !== null || folder !== null ? await projects() : [];
    if (app !== null && !list.some((project) => project.id === app) && !(await barApps()).includes(app)) {
      return refusal("unknown_app", `${app} is not an app of the emulator.`);
    }
    let start = null;
    if (folder !== null) {
      const project = list.find((one) => one.folder === folder);
      if (!project) return refusal("unknown_project", "This folder is not among the emulator's projects.");
      if (project.unavailable || !project.exists) return refusal("folder_unavailable", `The project's folder is not there (${folder}).`);
      if (project.trusted !== true) return refusal("untrusted_project", `The project's folder is not trusted (${folder}), so no terminal is opened in it.`, "Open it with Open App Folder: the emulator asks whether you trust it.");
      start = project.folder;
    }
    const words = logsWords({ app, kinds, since });
    const plan = platform === "win32" ? { platform, cli, words, folder: start, env } : { platform, cli, words, folder: start, script: macScript({ cli, words, folder: start, env }) };
    await launch(plan);
    log(`[shell] terminal: opened ${name} for ${app ?? "every app"}, ${kinds.join(",")}${start ? ` in ${start}` : ""}`);
    return { ok: true, value: { opened: name } };
  }

  return {
    info: () => ({ ok: true, value: info() }),
    async open(arg) {
      try {
        return await open(arg);
      } catch (e) {
        log(`[shell] terminal: could not open ${name}: ${e?.stack ?? e}`);
        return refusal("failed", `${name ?? "The terminal"} did not open.`, String(e?.message ?? e));
      }
    },
  };
}

/** Removes the scripts Terminal did not run: older than STALE_SCRIPT_MS. */
export function removeStaleScripts(folder, now = Date.now()) {
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const entry of names) {
    if (!entry.endsWith(".command")) continue;
    const file = path.join(folder, entry);
    try {
      if (now - statSync(file).mtimeMs > STALE_SCRIPT_MS) rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}

/**
 * Opens the terminal of a plan from createTerminal. Started detached, waited for by nobody.
 * @param {object} plan
 * @param {object} o
 * @param {Function} o.spawn   node:child_process spawn
 * @param {string} o.dataDir
 * @param {string} o.home
 * @param {Record<string, string | undefined>} o.baseEnv   the app's own environment
 */
export function launchTerminal(plan, { spawn, dataDir, home, baseEnv }) {
  let child;
  if (plan.platform === "win32") {
    const start = windowsStart({ cmd: cmdPath(baseEnv), cli: plan.cli, words: plan.words, folder: plan.folder, home, env: plan.env, baseEnv });
    child = spawn(start.file, start.args, { cwd: start.cwd, env: start.env, detached: true, stdio: "ignore", windowsVerbatimArguments: true });
  } else {
    const folder = path.join(dataDir, ...SCRIPT_FOLDER_PARTS);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    removeStaleScripts(folder);
    const file = path.join(folder, `console-${randomBytes(6).toString("hex")}.command`);
    writeFileSync(file, plan.script, { mode: 0o700, flag: "wx" });
    child = spawn("/usr/bin/open", ["-a", "Terminal", file], { detached: true, stdio: "ignore" });
  }
  child.on?.("error", () => {});
  child.unref?.();
}
