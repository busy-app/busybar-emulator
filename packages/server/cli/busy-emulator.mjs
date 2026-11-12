#!/usr/bin/env node
// busy-emulator: the command line of BUSY Bar Emulator (ADR-0002 sections 7 and 7a, ADR-0010). It lies inside the app
// and runs on the Node inside it; the launchers in the app (resources/bin) and at the fixed path the app writes
// (~/.busy-emulator/bin/busy-emulator, %LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe) run this file.
//
//   busy-emulator <command> [arguments] [--json] [--progress]
//
// Each command is one file in commands/, found by this folder's listing: adding a command is adding a file that
// exports { name, summary, usage, maxArguments?, options?, run(ctx, sys, { args, options, commands, json, progress, print, main })
// → { data, text } }.
import { readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveContext } from "./context.mjs";
import { commandLine } from "./lifecycle.mjs";
import { CliError, emit, unknownCommand } from "./output.mjs";
import { system } from "./system.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DIR = path.join(here, "commands");

/** Every command, sorted by name. */
export async function loadCommands(folder = COMMANDS_DIR) {
  const files = readdirSync(folder).filter((name) => name.endsWith(".mjs") && !name.startsWith(".")).sort();
  const commands = [];
  for (const file of files) {
    const command = (await import(pathToFileURL(path.join(folder, file)).href)).default;
    if (!command?.name || typeof command.run !== "function") throw new Error(`${file} is not a command`);
    commands.push(command);
  }
  return commands;
}

/**
 * Splits the command line: --json, --progress and --help anywhere, the first other word is the command. After the command come
 * its own options, as `optionsOf(name)` describes them: `{ "--back": { key: "back" }, "--out": { key: "out", value:
 * "<path>" } }` — a flag, or an option with a value, given as `--out <value>` or `--out=<value>`. The value is the
 * next word unless that starts with "-" (a value forgotten before --json must not become a file named "--json"); such
 * a value goes after "=". Every other word that starts with "-" is an unknown option. After a word "--" every word is
 * an argument, even one that starts with "-" (a key=value of settings set whose key a model chose), but for --json and
 * --progress themselves, which the MCP server puts at the end (a key=value word always holds a "=").
 * @returns {{ name: string|null, args: string[], json: boolean, progress: boolean, help: boolean, unknownOptions: string[],
 *   options: Record<string, string|true>, optionProblems: string[] }}
 */
export function parseArguments(argv, optionsOf = () => null) {
  const words = [];
  const unknownOptions = [];
  const options = {};
  const optionProblems = [];
  let json = false;
  let progress = false;
  let help = false;
  const isOption = (word) => word.startsWith("-") && word.length > 1;
  let rest = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--json") json = true;
    else if (word === "--progress") progress = true;
    else if (rest) words.push(word);
    else if (word === "--" && words.length) rest = true;
    else if (word === "--help" || word === "-h") help = true;
    else if (word === "--version" && words.length === 0) words.push("version");
    else if (isOption(word)) {
      const equals = word.startsWith("--") ? word.indexOf("=") : -1;
      const flag = equals > 0 ? word.slice(0, equals) : word;
      const spec = words.length ? optionsOf(words[0]) : null;
      const option = spec && Object.hasOwn(spec, flag) ? spec[flag] : null;
      if (!option) unknownOptions.push(word);
      else if (Object.hasOwn(options, option.key)) optionProblems.push(`${flag} is given more than once`);
      else if (!option.value) {
        if (equals > 0) optionProblems.push(`${flag} takes no value`);
        else options[option.key] = true;
      } else if (equals > 0) options[option.key] = word.slice(equals + 1);
      else if (i + 1 < argv.length && !isOption(argv[i + 1])) options[option.key] = argv[++i];
      else optionProblems.push(`${flag} needs a value: ${flag} ${option.value}, or ${flag}=${option.value} for one that starts with "-"`);
    } else words.push(word);
  }
  const [name = null, ...args] = words;
  return { name, args, json, progress, help, unknownOptions, options, optionProblems };
}

/**
 * Runs one command line and gives its exit code.
 * @param {string[]} argv
 * @param {object} o
 * @param {object} o.ctx       resolveContext()
 * @param {object} o.sys       the system (system.mjs), or a stand-in
 * @param {(line: string) => void} o.out
 * @param {(line: string) => void} o.err
 * @param {(answer: object) => void} [o.answer]  given the answer before it is printed: { ok, command, data, text } or
 *   { ok: false, command, error } (the MCP server's tools, mcp/tools.mjs)
 */
export async function main(argv, { ctx, sys, out, err, commands, answer = () => {} }) {
  commands ??= await loadCommands();
  const find = (wanted) => commands.find((command) => command.name === wanted);
  const { name, args, json, progress: aloud, help, unknownOptions, options, optionProblems } = parseArguments(argv, (wanted) => find(wanted)?.options ?? null);
  const self = commandLine(ctx);
  let command = name === null || help ? find("help") : find(name);
  let commandArgs = name === null || help ? (name === null ? [] : [name]) : args;
  try {
    if (!command) throw unknownCommand(name, self);
    if (unknownOptions.length) {
      throw new CliError("usage", `${command.name} has no option ${unknownOptions.join(", ")}.`, `Run ${self} help ${command.name}.`, { arguments: unknownOptions });
    }
    if (optionProblems.length && !(name === null || help)) {
      throw new CliError("usage", `${command.name}: ${optionProblems.join("; ")}.`, `Usage: ${self} ${command.usage}`);
    }
    if (commandArgs.length > (command.maxArguments ?? 0)) {
      const extra = commandArgs.slice(command.maxArguments ?? 0);
      throw new CliError("usage", `${command.name} takes no argument ${extra.map((word) => JSON.stringify(word)).join(" ")}.`, `Usage: ${self} ${command.usage}`, { arguments: extra });
    }
    // What a long command says while it works (installing, building): to stderr for a person, nothing with --json,
    // unless --progress asks for it (the app's window shows the lines while it waits for the one line of JSON).
    const progress = json && !aloud ? () => {} : (line) => err(line);
    // `print`: a line to standard output before the answer, for a command that goes on (dev, logs --follow).
    const result = await command.run(ctx, sys, { args: commandArgs, options: name === null || help ? {} : options, commands, json, progress, print: out, main });
    answer({ ok: true, command: command.name, data: result.data, text: result.text });
    const code = emit({ ok: true, command: command.name, data: result.data, text: result.text }, { json, out, err });
    // No command given at all is a wrong call, even though it shows the help; asking for the help (--help, -h) is not.
    return name === null && !help ? 2 : code;
  } catch (e) {
    const error = e instanceof CliError ? e : new CliError("internal", `Unexpected failure: ${e?.stack ?? e}`, "Report this with the text above.");
    // A command may tell that the caller asked for JSON in a way the parser could not see (a --json a shell glued into
    // the value of an option: screenshot, PowerShell 5.1).
    answer({ ok: false, command: command?.name ?? name, error });
    return emit({ ok: false, command: command?.name ?? name, error }, { json: json || error.answerAsJson === true, out, err });
  }
}

/** True when Node was started on this file, by whatever path: one with links, quotes or Cyrillic in it too. */
function startedHere() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** The home by the system's account (the user database, the profile on Windows), not HOME. */
function systemHome() {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

if (startedHere()) {
  const ctx = resolveContext({
    env: process.env,
    platform: process.platform,
    homeDir: os.homedir(),
    systemHomeDir: systemHome(),
    scriptPath: fileURLToPath(import.meta.url),
    execPath: process.execPath,
    nodeVersion: process.versions.node,
  });
  const code = await main(process.argv.slice(2), { ctx, sys: system, out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) });
  process.exitCode = code;
}
