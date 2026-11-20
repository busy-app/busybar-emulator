// A process of its own that opens a data folder for data-format.test.mjs and is killed in the middle of the move
// between formats, as a crash or a power cut would end it.
//
//   node data-format.child.mjs <data folder> <n>        (EMU_TEST_NO_STEPS=1: with no steps between formats)
//
// Every rename the data folder's code makes (the steps' moves, the format record written whole) is counted; the n-th
// is not made: the process kills itself with SIGKILL just before it, so nothing of its own lets go of the folder.
// With n = 0 nothing is killed, and the process prints { renames } (how many there were) and ends.
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";

const [root, at] = process.argv.slice(2);
const crashAt = Number(at);
const rename = fs.renameSync;
let renames = 0;
fs.renameSync = (from, to) => {
  renames += 1;
  if (renames === crashAt) process.kill(process.pid, "SIGKILL");
  return rename(from, to);
};
// data-folder.mjs imports renameSync by name: its binding follows the module's property from here on.
syncBuiltinESMExports();

const { openDataFolder } = await import("../../packages/server/data-folder.mjs");
// EMU_TEST_NO_STEPS=1: a folder this start cannot move (no steps), so that it is set aside.
const folder = await openDataFolder(root, { record: { port: 1 }, ...(process.env.EMU_TEST_NO_STEPS === "1" ? { migrations: {} } : {}) });
folder.release();
process.stdout.write(`${JSON.stringify({ renames })}\n`);
