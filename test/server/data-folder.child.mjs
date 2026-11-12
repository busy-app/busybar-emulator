// A process of its own that opens a data folder for data-folder.test.mjs, as a server in another process would.
//
//   node data-folder.child.mjs <data folder> hold|exit
//
// Prints one line of JSON — { ok: true, notices } or { ok: false, code, message } — and then:
//   hold   keeps the folder until its standard input closes (or it is killed), then lets go of it and ends
//   exit   ends at once with process.exit(0), without letting go of the folder itself
import { openDataFolder } from "../../packages/server/data-folder.mjs";

const [root, mode] = process.argv.slice(2);
let folder;
try {
  folder = await openDataFolder(root, { firmware: "1.3.1", record: { port: 1 } });
  process.stdout.write(JSON.stringify({ ok: true, notices: folder.notices }) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, code: e?.code ?? null, message: e?.message ?? String(e) }) + "\n");
  process.exit(0);
}
if (mode === "exit") process.exit(0);
process.stdin.on("close", () => folder.release());
process.stdin.resume();
