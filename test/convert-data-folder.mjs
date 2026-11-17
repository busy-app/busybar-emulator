// Moves a data folder of the layout from before the format number (EMU-005) into today's: the bar's storage, ext,
// goes to bar/ext. Run it once on a folder the emulator now refuses with EMU_DATA_FORMAT ("the layout of an earlier
// emulator"): the comparison copies (emulator/.data-golden, a master copy of them). The app's own folder from before
// has its storage in bar/ext already, which is today's place: the emulator opens it as it is. The emulator itself
// never does this: a folder of another format is not touched (MIGRATIONS in data-folder.mjs moves the formats since).
//
//   node emulator/test/convert-data-folder.mjs <folder>
//
// The format record is not written: the emulator writes it when it first opens the folder. Nothing is done to a folder
// that has a format record, a lock, or a bar/ext there already.
import { existsSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

import { commandLine } from "../packages/server/arguments.mjs";

const args = process.argv.slice(2);
await commandLine(process.argv, { positionals: true });

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (args.length !== 1) fail("Name one data folder: node emulator/test/convert-data-folder.mjs <folder>");
const root = resolve(args[0]);

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
const target = join(root, "bar", "ext");
if (existsSync(target)) fail(`${target} is there already: the emulator opens this folder as it is, and nothing is moved.`);
const storage = join(root, "ext");
if (!isFolder(storage)) fail(`${root} has no bar's storage of the layout before (no ext at its top): nothing to move.`);

// The folders the emulator makes are for the user alone (packages/server/data-folder.mjs).
mkdirSync(join(root, "bar"), { recursive: true, mode: 0o700 });
renameSync(storage, target);
console.log(`moved ${storage} to ${target}`);
