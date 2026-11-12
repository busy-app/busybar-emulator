#!/usr/bin/env node
// BUSY Bar emulator server: the bar's HTTP API on localhost, backed by the firmware's JS runtime in wasm.
//
//   node emulator/packages/server/index.mjs [--port 8640] [--control-port <port>] [--data <dir>] [--firmware 1.3.1|dev]
//       [--allow-origin <origin>]... [--window-origin <origin>] [--allow-local <port>]... [--fast] [--verbose]
//   node emulator/packages/server/index.mjs --help | --version
//
// An option it does not know, or one without its value, is a wrong call: one line on stderr, exit code 2, and nothing
// is started (arguments.mjs). --help prints every option with its default, the data folder and the exit codes.
//
// Two addresses (ADR-0012): the bar's on --port, and the management address on --control-port (a free port unless
// named; the second line of the output names it), which answers only programs that send the server's key from the
// file "key" in the data folder. Pages of other origins are refused on both unless named with --allow-origin, once
// for each origin; --window-origin names the app window's origin, which is the emulator's own on the management
// address.
//
// An app on the bar does not reach this computer: on a bar, localhost is the bar itself, so a request of an app to this
// computer — its loopback or its own network addresses — on any port but the bar's API fails as on a bar (ADR-0012
// section 5, local-access.mjs).
// --allow-local <port>, once for each port, lets apps reach a service of the author's on that port; a program with the
// server's key can allow a port later, on the management address (POST /_emu/local-ports?port=<port>), as the command
// line does: busy-emulator allow-local <port>.
//
// The data — the emulated bar's apps and settings, a bar for each firmware — lives in the user's data folder:
// ~/Library/Application Support/BUSY Bar Emulator on macOS, %LOCALAPPDATA%\BUSY Bar Emulator on Windows; --data names
// another folder. Nothing is written into the emulator's own folder. The folder is the one busy-emulator and the app
// use, found by the same function (resolveContext in cli/context.mjs): a run from the source tree takes the home from
// the environment (HOME; USERPROFILE and LOCALAPPDATA on Windows; BUSY_EMULATOR_DATA names the folder outright), a
// release takes it from the system and reads no variable.
//
// Apps run at a BUSY Bar's speed (bar-speed.mjs); --fast lets them run as fast as the computer.
//
// Then, from an app folder:  npx busy-cli app install --addr 127.0.0.1:8640  and  npx busy-cli app run --addr 127.0.0.1:8640
//
// The device window — both displays, the buttons and the wheel, the app console — is at http://127.0.0.1:8640/emulator
// (device-window.mjs).
//
// This file is the command line and nothing else: it reads the arguments and the environment, starts one server
// (startServer in server.mjs, which is what a program imports) and prints where it is.
//
// For a program that starts this one and waits for it: the server is ready when the first line of stdout,
// "BUSY Bar emulator: http://127.0.0.1:<port>  (...)", is there, and not before; with --port 0 that line is where the
// port is named, and the next one, "Management: http://127.0.0.1:<port>  (...)", names the management address.
// Nothing comes before them: what the bar says while it starts (an app put back after an install that did not
// finish, a note about the data folder's volume) is held and printed after the five start-up lines. A program that
// started it with a channel (child_process with "ipc") gets the same news as one message, { type: "ready", port, url,
// controlPort, controlUrl, firmware, apiVersion, dataDir, barSpeed }, just before the line. The server's key is in
// none of them. A start that
// fails prints nothing to stdout and sends nothing: the reason is the last line of stderr (the only one, unless the
// bar had said something before it failed), exit code 1.
//
// SIGINT (Ctrl+C), SIGTERM and SIGHUP stop the server through the `signal` of startServer, as stop() does — uploads
// under way are undone, the bar is shut down and the data folder let go of — also while it is still starting; the
// process then ends by itself, with the code a shell gives a process ended by the signal (130, 143, 129). A second
// one ends it at once.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine, runAgain } from "./arguments.mjs";
import { resolveContext } from "./cli/context.mjs";
import { startServer } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
// Every word is checked first: an option this command does not know is a wrong call (exit code 2), never a start on
// the default port with the user's own data folder. --help and --version start nothing and touch no folder.
await commandLine(process.argv, {
  // --allow-origin may come more than once: every value counts.
  values: ["--port", "--control-port", "--data", "--firmware", "--allow-origin", "--window-origin", "--allow-local"],
  flags: ["--fast", "--verbose"],
  help: () => help(),
  versionText: () => {
    const { version, kind } = context();
    return `BUSY Bar emulator server ${version ?? "(unknown version)"}${kind === "release" ? "" : ` (${kind})`}, Node ${process.versions.node}`;
  },
});
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
// Every value of an option that may be given more than once.
const options = (name) => argv.flatMap((arg, i) => (arg === name && i + 1 < argv.length ? [argv[i + 1]] : []));
const time = () => new Date().toTimeString().slice(0, 8);
const verbose = argv.includes("--verbose");

// The bar's log: each line with the time it was said. Until the start-up lines are out the lines are held, so that
// the first line of stdout is always the one that says the server is ready and where.
let held = [];
const say = (line) => {
  const text = `${time()} ${line}`;
  if (held) held.push(text);
  else console.log(text);
};

const given = option("--data");
/**
 * The context of the command line beside this file (its context is worked out from where its script lies, which is
 * next to this one in the source tree and in the app alike): the user's data folder, the version.
 */
function context() {
  let systemHome;
  try {
    systemHome = os.userInfo().homedir;
  } catch {
    systemHome = os.homedir();
  }
  return resolveContext({
    env: process.env,
    platform: process.platform,
    homeDir: os.homedir(),
    systemHomeDir: systemHome,
    scriptPath: join(here, "cli", "busy-emulator.mjs"),
    execPath: process.execPath,
    nodeVersion: process.versions.node,
  });
}
/** The user's data folder, as busy-emulator and the app find it. */
function userDataFolder() {
  return context().dataDir;
}

/** What --help prints: every option with its default, where the data is, the exit codes. */
function help() {
  const firmwares = JSON.parse(readFileSync(join(here, "..", "engine", "firmware.json"), "utf8"));
  let dataDir;
  try {
    dataDir = userDataFolder();
  } catch (e) {
    dataDir = `(this computer gives no home folder: ${e?.message ?? e})`;
  }
  return [
    "BUSY Bar emulator server: the BUSY Bar's HTTP API, its local web and the emulator's window on 127.0.0.1.",
    "",
    `Usage: ${runAgain(join(here, "index.mjs"))} [options]   (from emulator/, npm start -- [options] does the same)`,
    "",
    "Options:",
    "  --port <port>        the port on 127.0.0.1, 0 for a free one (default 8640)",
    "  --control-port <port>  the port of the management address on 127.0.0.1, which answers only programs that",
    "                       send the server's key from the file \"key\" in the data folder (default 0, a free one;",
    "                       the second line of the output names it)",
    "  --allow-origin <origin>  a web page's origin, such as http://localhost:3000, that may call the emulator and",
    "                       read its answers; pages of other origins are refused. Give it once for each origin",
    "  --window-origin <origin>  the origin of the app's window, its own on the management address (the app passes it)",
    "  --allow-local <port>  a port of this computer that apps on the BUSY Bar may reach, such as the port of a service the",
    "                       app talks to; other ports of localhost and of this computer's own network addresses are",
    "                       refused (on a BUSY Bar, localhost is the BUSY Bar itself). Give it once for each port (default: none)",
    "  --data <folder>      the data folder: the emulated BUSY Bar's apps and settings, a BUSY Bar for each firmware",
    `                       (default: the user's data folder, here ${dataDir})`,
    `  --firmware <name>    the firmware to run: ${Object.keys(firmwares.versions).join(", ")} (default ${firmwares.default}, or EMU_FIRMWARE)`,
    "  --fast               apps run at this computer's speed, not at a BUSY Bar's",
    "  --verbose            also print requests the emulator has no answer for, and where a failed start failed",
    "  --version            print the version and exit",
    "  -h, --help           print this help and exit",
    "",
    "The user's data folder is ~/Library/Application Support/BUSY Bar Emulator on macOS and",
    "%LOCALAPPDATA%\\BUSY Bar Emulator on Windows, the one busy-emulator and the app use; a run from the source folder",
    "takes the home from HOME (USERPROFILE and LOCALAPPDATA on Windows), and BUSY_EMULATOR_DATA names the folder outright.",
    "",
    "Exit codes: 0 after --help or --version; 1 the server could not start (stderr says why; with --verbose, where),",
    "or did not stop cleanly after a signal; 2 a wrong call (an unknown option, an option without its value), nothing",
    "started; 130, 143, 129 stopped by SIGINT, SIGTERM, SIGHUP.",
  ].join("\n");
}

// Where the data lay before it moved to the user's data folder (EMU-005). It is not read, moved or removed.
const legacyDataDir = join(here, "..", "..", ".data");

const quit = new AbortController();
for (const [name, number] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) {
  process.on(name, () => {
    if (quit.signal.aborted) process.exit(128 + number);
    process.exitCode = 128 + number;
    quit.abort(Object.assign(new Error(`Stopped by ${name}`), { code: "EMU_STOPPED" }));
  });
}

try {
  // In the start's try: a home the system cannot give (Windows refuses a profile path over 260 characters with
  // ENOBUFS) is a failed start like any other, one line on stderr.
  const dataDir = given ? resolve(given) : userDataFolder();
  const emulator = await startServer({
    signal: quit.signal,
    port: Number(option("--port", "8640")),
    controlPort: Number(option("--control-port", "0")),
    allowOrigins: options("--allow-origin"),
    allowLocal: options("--allow-local"),
    windowOrigin: option("--window-origin", null),
    dataDir,
    // --firmware <version>, or EMU_FIRMWARE; otherwise the default in emulator/packages/engine/firmware.json.
    firmware: option("--firmware", process.env.EMU_FIRMWARE),
    barSpeed: !argv.includes("--fast"),
    verbose,
    log: say,
  });
  const { port, firmware, control } = emulator;
  process.send?.({ type: "ready", port, url: emulator.url, controlPort: control.port, controlUrl: control.url, firmware: firmware.name, apiVersion: emulator.apiVersion, dataDir: emulator.dataDir, barSpeed: emulator.barSpeed });
  console.log(`BUSY Bar emulator: http://127.0.0.1:${port}  (API ${emulator.apiVersion}, firmware ${firmware.name} ${firmware.info.firmware}, data ${emulator.dataDir})`);
  // The file's name, not what is in it: the key is never printed.
  console.log(`Management: ${control.url}  (for programs that send the server's key, from ${emulator.dataFolder.keyFile})`);
  console.log(`Window: http://127.0.0.1:${port}/emulator`);
  console.log(
    emulator.barSpeed
      ? "Apps run at BUSY Bar speed: their JS takes the time it would take on a BUSY Bar (--fast to turn off)"
      : "Apps run at this computer's speed (--fast); on a BUSY Bar they will be much slower",
  );
  console.log(`From an app folder: npx busy-cli app install --addr 127.0.0.1:${port}, then npx busy-cli app run --addr 127.0.0.1:${port}`);
  if (!given && emulator.dataFolder.created && existsSync(legacyDataDir)) {
    say(
      `The emulator keeps its data in ${emulator.dataDir} now. The folder ${resolve(legacyDataDir)} of earlier versions is left as it was ` +
        `and is not read. To keep its apps, stop the emulator and move ${join(resolve(legacyDataDir), "ext")} to ${join(emulator.barDir, "ext")}.`,
    );
  }
  const local = emulator.localPorts();
  if (local.length) say(`Apps on the BUSY Bar may reach ${local.length === 1 ? "port" : "ports"} ${local.join(", ")} of this computer (--allow-local)`);
  for (const text of held) console.log(text);
  held = null;
  // The stop a signal asks for is the server's own (startServer's `signal`), and so is the message if it fails;
  // this is the same stop, for its outcome.
  quit.signal.addEventListener("abort", () => emulator.stop().catch(() => (process.exitCode = 1)), { once: true });
} catch (e) {
  // Nothing is left running after a failed start, so the process ends by itself. What the bar had said by then goes
  // to stderr: stdout says nothing of a server that did not start, and the lines are not dropped, because they can
  // tell of something the bar already did to the data folder (an app put back) or of why it could not start. The
  // last line of stderr says why the start failed; --verbose adds where.
  for (const text of held ?? []) console.error(text);
  // A start called off by a signal did not fail: the exit code says which signal it was.
  if (!quit.signal.aborted) {
    console.error(verbose ? e : (e?.message ?? e));
    process.exitCode = 1;
  }
}
