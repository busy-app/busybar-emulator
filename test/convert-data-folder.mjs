// Moves a data folder of the layout from before the format number (EMU-005) into today's: the bar's storage, ext,
// goes to bar/<firmware>/ext. Run it once on a folder the emulator now refuses with EMU_DATA_FORMAT ("the layout of an
// earlier emulator") — the comparison copies (emulator/.data-golden, a master copy of them) and the app's own folder
// from before (its bar/ext). The emulator itself never does this: a folder of another format is not touched (EMU-219
// moves the formats that will come).
//
//   node emulator/test/convert-data-folder.mjs <folder> [--firmware 1.3.1] ...
//
// <folder>/ext — a comparison copy, or a folder given with --data before — and <folder>/bar/ext — the app's data
// folder, whose bar/ was the server's --data — are both understood. The storage is moved to the bar of the first
// firmware and copied to the bars of the others; without --firmware, every firmware the emulator has (as
// test/mirror-apps.mjs does, so that `--firmware dev` finds the same apps). The format record is not written: the
// emulator writes it when it first opens the folder. Nothing is done to a folder that has a format record, a lock, or
// a bar there already.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--firmware"], positionals: true });
const given = args.filter((arg, i) => arg !== "--firmware" && args[i - 1] !== "--firmware");
const named = args.flatMap((arg, i) => (args[i - 1] === "--firmware" ? [arg] : []));
const known = Object.keys(JSON.parse(readFileSync(join(here, "../packages/engine/firmware.json"), "utf8")).versions);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (given.length !== 1) fail("Name one data folder: node emulator/test/convert-data-folder.mjs <folder> [--firmware <version>] ...");
const root = resolve(given[0]);
const firmwares = named.length ? named : known;
for (const firmware of firmwares) if (!known.includes(firmware)) fail(`Unknown firmware "${firmware}". The emulator has: ${known.join(", ")}.`);

const isFolder = (path) => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

if (!isFolder(root)) fail(`${root} is not a folder.`);
if (existsSync(join(root, "format"))) fail(`${root} has a format record already: it is in today's layout, and is left as it is.`);
if (existsSync(join(root, "run", "server.lock"))) fail(`An emulator holds ${root} (run/server.lock). Stop it first.`);
const storage = isFolder(join(root, "ext")) ? join(root, "ext") : isFolder(join(root, "bar", "ext")) ? join(root, "bar", "ext") : null;
if (!storage) fail(`${root} has no bar's storage of the layout before (neither ext nor bar/ext): nothing to move.`);
const targets = firmwares.map((firmware) => join(root, "bar", firmware, "ext"));
for (const target of targets) if (existsSync(target)) fail(`${target} is there already: nothing is moved.`);

// The folders the emulator makes are for the user alone (packages/server/data-folder.mjs).
for (const target of targets) mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
renameSync(storage, targets[0]);
console.log(`moved ${storage} to ${targets[0]}`);
for (const target of targets.slice(1)) {
  cpSync(targets[0], target, { recursive: true });
  console.log(`copied it to ${target}`);
}
