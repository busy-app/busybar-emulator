// Records the data folder a release of the emulator leaves, as a fixture for the tests of the move between formats
// (EMU-341; data-format.test.mjs reads them). The release's own server, taken from its commit (git archive, nothing of
// this tree runs in it), is started on a new data folder and used as a person uses it: an app installed on the BUSY Bar,
// its settings changed, a file written into its data, the firmware switched and a second app installed there. A
// project is remembered and trusted by the release's own modules (projects/registry.mjs, projects/trust.mjs). The files
// of the app's shell (app-settings.json, install.json, logs/, shell/) need Electron to be written by the release
// itself: they are put down here in their shape, so that a move between formats is seen to keep them too.
//
//   node test/server/data-folders/record.mjs <release> <commit> [--work <folder>] [--port <port>]
//
// writes test/server/data-folders/<release>.json. Paths of this machine are not kept: the projects' folder is written
// as $PROJECTS and the folders' numbers on the disk as fixed ones; the server's key and the lock are not kept. The
// server listens on --port (default 18941) and on a free management port; --work (default the system's temporary
// folder) holds the release's files and the data folder while it runs, and nothing is left there after.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execProgram } from "../../../packages/engine/programs.mjs";
import { targz } from "../../package.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const workParent = path.resolve(option("--work", os.tmpdir()));
const PORT = Number(option("--port", "18941"));
const [release, commit] = args;
if (!release || !commit || ![8640, 8652, 8653, 8790].every((p) => p !== PORT)) {
  console.error("node test/server/data-folders/record.mjs <release> <commit> [--work <folder>] [--port <port, not 8640, 8652, 8653 or 8790>]");
  process.exit(2);
}

/** The app every release gets: a script that does nothing, settings of three kinds. */
export const PROBE = "app.chain.probe";
/** The second app, on the other firmware. */
export const OTHER = "app.chain.other";
const SETTINGS = { format_version: 1, version: 1, fields: { minutes: { type: "integer", label: "Minutes", default: 25, min: 1, max: 180 }, tree: { type: "enum", label: "Tree", default: "apple", options: [{ value: "apple", label: "Apple" }, { value: "sakura", label: "Sakura" }] }, sound: { type: "boolean", label: "Sound", default: true } } };
const appFiles = (id) => ({
  [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.14.0" }),
  [`${id}/appmeta/settings.json`]: JSON.stringify(SETTINGS),
  [`${id}/scripts/main.js`]: "setInterval(function () {}, 1000);\n",
});

function request(method, url, body = null, headers = {}) {
  return new Promise((done, fail) => {
    const req = http.request(url, { method, agent: false, headers: { Connection: "close", ...headers, ...(body ? { "Content-Length": body.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      res.on("error", fail);
    });
    req.on("error", fail);
    req.end(body ?? undefined);
  });
}
async function ok(what, answer) {
  const got = await answer;
  assert.ok(got.status >= 200 && got.status < 300, `${what}: ${got.status} ${got.text.slice(0, 300)}`);
  return got.text ? JSON.parse(got.text) : null;
}

// By its real path: the modules of the release keep real paths, and $PROJECTS stands for this one.
const work = realpathSync.native(mkdtempSync(path.join(workParent, `record-${release}-`)));
const tree = path.join(work, "tree");
const data = path.join(work, "data");
const projects = path.join(work, "projects");
let server = null;

/** The release's server on the data folder, until its line "BUSY Bar emulator: http://..." says it is ready. */
async function start(firmware = null) {
  const child = spawn(process.execPath, [path.join(tree, "packages", "server", "index.mjs"), "--port", String(PORT), "--data", data, ...(firmware ? ["--firmware", firmware] : [])], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (out += text));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const deadline = Date.now() + 60_000;
  while (!/BUSY Bar emulator: http/.test(out)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`the server of ${commit} did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  server = { child, exited, out: () => out, base: `http://127.0.0.1:${PORT}` };
  return server;
}
async function stop() {
  if (!server) return;
  server.child.kill("SIGTERM");
  await server.exited;
  server = null;
}
async function install(id) {
  const staged = await ok(`stage ${id}`, request("POST", `${server.base}/api/apps/stage`, targz(appFiles(id))));
  await ok(`install ${id}`, request("POST", `${server.base}/api/apps/install?install_key=${staged.install_key}`));
}
const putSettings = (id, values) => ok(`settings of ${id}`, request("PUT", `${server.base}/api/apps/settings?app_id=${id}`, Buffer.from(JSON.stringify({ version: 1, values }))));
const writeData = (id, name, text) => ok(`data of ${id}`, request("POST", `${server.base}/api/storage/write?path=/ext/apps_data/js_apps/${id}/${name}`, Buffer.from(text)));

/** The management address and the key, as the lock and the key file of the running server name them. */
function control() {
  const lock = JSON.parse(readFileSync(path.join(data, "run", "server.lock"), "utf8"));
  return { url: lock.control.url, key: readFileSync(path.join(data, "key"), "utf8").trim() };
}

/** Every folder and file of the data folder, by its path in it with "/": files as text when they are UTF-8, else base64. */
function snapshot(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const at = path.join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(at);
      if (stat.isDirectory()) {
        out[`${key}/`] = null;
        walk(at, key);
      } else {
        const bytes = readFileSync(at);
        const text = bytes.toString("utf8");
        out[key] = Buffer.from(text, "utf8").equals(bytes) ? { text } : { base64: bytes.toString("base64") };
      }
    }
  };
  walk(root, "");
  return out;
}

try {
  // From the repository's top: run in a folder of it, git archive takes only that folder.
  const top = execProgram("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  execProgram("git", ["-C", top, "archive", "--format=tar", "-o", path.join(work, "tree.tar"), `${commit}:emulator`]);
  mkdirSync(tree);
  execProgram("tar", ["-xf", path.join(work, "tree.tar"), "-C", tree]);
  rmSync(path.join(work, "tree.tar"));
  const firmwares = JSON.parse(readFileSync(path.join(tree, "packages", "engine", "firmware.json"), "utf8"));
  const { FORMAT } = await import(pathToFileURL(path.join(tree, "packages", "server", "data-folder.mjs")).href);
  const version = JSON.parse(readFileSync(path.join(tree, "packages", "app", "package.json"), "utf8")).version;
  const names = Object.keys(firmwares.versions);
  const first = firmwares.default ?? firmwares.latest;
  const second = names.find((name) => name !== first);
  console.log(`${release}: ${version} at ${commit}, data folder format ${FORMAT}, firmwares ${names.join(", ")} (default ${first})`);

  // The first app on the default firmware: installed, its settings changed, a file in its data.
  await start();
  await install(PROBE);
  await putSettings(PROBE, { minutes: 40, tree: "sakura", sound: false });
  await writeData(PROBE, "progress.json", '{"sessions":7}\n');
  // The firmware switched and the second app installed on it: a release of format 1 keeps a BUSY Bar for each firmware
  // and switches by a start on it; one of format 2 switches at runtime and keeps the choice (EMU-320).
  if (FORMAT >= 2) {
    const { url, key } = control();
    await ok("switch the firmware", request("POST", `${url}/_emu/firmware`, Buffer.from(JSON.stringify({ version: second })), { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }));
  } else {
    await stop();
    await start(second);
  }
  await install(OTHER);
  await putSettings(OTHER, { minutes: 15, tree: "apple", sound: true });
  await stop();

  // A project, remembered and trusted by the release's own modules.
  const project = path.join(projects, "focus");
  cpSync(path.join(tree, "examples", "focus-timer"), project, { recursive: true, filter: (src) => !src.includes("node_modules") });
  const registry = await import(pathToFileURL(path.join(tree, "packages", "server", "projects", "registry.mjs")).href);
  const trust = await import(pathToFileURL(path.join(tree, "packages", "server", "projects", "trust.mjs")).href);
  registry.rememberProject(data, project);
  trust.trustProject(data, project, "created");
  // The shell's files, in their shape (they need Electron to be written by the release itself).
  writeFileSync(path.join(data, "app-settings.json"), `${JSON.stringify({ welcomed: true, updateCheck: true }, null, 2)}\n`);
  writeFileSync(path.join(data, "install.json"), `${JSON.stringify({ app: "$APP", cli: "$HOME/.busy-emulator/bin/busy-emulator", version }, null, 2)}\n`);
  mkdirSync(path.join(data, "logs"), { recursive: true });
  writeFileSync(path.join(data, "logs", "shell.log"), `[shell] started: BUSY Bar Emulator ${version}\n`);
  mkdirSync(path.join(data, "shell", "Local Storage", "leveldb"), { recursive: true });
  writeFileSync(path.join(data, "shell", "Local Storage", "leveldb", "000003.log"), "window storage\n");

  const files = snapshot(data);
  // Not kept: the key (made anew at every start), what a running server holds (run/), the numbers of this machine's
  // folders on its disk, and this machine's paths.
  delete files.key;
  for (const name of Object.keys(files)) if (name.startsWith("run/") && name !== "run/") delete files[name];
  const machine = (text) => text.split(JSON.stringify(projects).slice(1, -1)).join("$PROJECTS").split(projects).join("$PROJECTS").replace(/"dev": ?"\d+"/g, '"dev": "1"').replace(/"ino": ?"\d+"/g, '"ino": "2"').replace(/"volume": ?"[^"]*"/g, '"volume": "$VOLUME"');
  for (const [name, value] of Object.entries(files)) if (value?.text !== undefined) value.text = machine(value.text);
  const fixture = { release, version, commit, format: FORMAT, firmwares: names, apps: { [first]: [PROBE], [second]: [OTHER] }, recorded: new Date().toISOString().slice(0, 10), by: "test/server/data-folders/record.mjs", files };
  const out = path.join(here, `${release}.json`);
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  console.log(`${out}: ${Object.keys(files).length} entries, ${readFileSync(out).length} bytes`);
} catch (e) {
  console.error(e);
  if (server) console.error(server.out());
  process.exitCode = 1;
} finally {
  await stop().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
