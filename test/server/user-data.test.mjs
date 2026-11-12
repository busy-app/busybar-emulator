// Where the command line keeps its data when it is not told: the user's data folder, the one busy-emulator finds
// (resolveContext in packages/server/cli/context.mjs), never the emulator's own folder; and the folder of earlier
// versions, emulator/.data, left as it was.
//
// The user's home is a temporary folder: the tests run the command line from the source tree, which takes the home
// from the environment, and check before it starts that the data folder it will use lies in that temporary folder —
// so that a test never writes to the real data folder of the machine.
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { after, test } from "node:test";

import { resolveContext } from "../../packages/server/cli/context.mjs";
import { targz } from "../package.mjs";
import { finish, get, node, port, request, serverDir, tempDir, until } from "./helpers.mjs";

after(finish);

const windows = process.platform === "win32";
const emulatorDir = resolve(serverDir, "..", "..");
// The repository whose files a day's work must not touch: the git repository around emulator/ — the development one,
// where emulator/ is a folder of it, or the public one, which is the emulator's folder itself (EMU-164); without git,
// the emulator's folder.
const repository = (() => {
  for (let dir = emulatorDir; ; dir = resolve(dir, "..")) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (resolve(dir, "..") === dir) return emulatorDir;
  }
})();

/** The environment of a command line whose user's home is `home`: HOME on macOS, the profile and LOCALAPPDATA on Windows. */
function homeEnv(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") };
  delete env.BUSY_EMULATOR_DATA;
  delete env.EMU_FIRMWARE;
  return env;
}

/** The context busy-emulator of the emulator's folder `tree` works out for `env` and these homes. */
const contextOf = (tree, env, homeDir, systemHomeDir) =>
  resolveContext({ env, platform: process.platform, homeDir, systemHomeDir, scriptPath: join(tree, "packages", "server", "cli", "busy-emulator.mjs"), execPath: process.execPath, nodeVersion: process.versions.node });

/**
 * Where the command line in `tree` puts its data for `env`, by the rule it follows: a development copy, so the home
 * of the environment. The test refuses to go on if that folder is not in the temporary home.
 */
function expectedFolder(tree, env, home) {
  const context = contextOf(tree, env, home, os.userInfo().homedir);
  assert.equal(context.kind, "development", `${tree} is a development copy, which takes the home from the environment`);
  assert.ok(context.dataDir.startsWith(home + sep), `${context.dataDir} lies in the temporary home`);
  return context.dataDir;
}

/** The real data folder of this machine's user (as a release finds it): whether it is there and when it last changed. */
function realDataFolder() {
  const folder = contextOf("/nowhere-at-all", {}, os.homedir(), os.userInfo().homedir).dataDir;
  try {
    return { folder, mtime: statSync(folder).mtimeMs };
  } catch {
    return { folder, mtime: null };
  }
}

// What a write would change, for every entry of the tree: size and time of change (a folder's time changes when an
// entry is made or removed in it, so a file made and removed again shows too). Left out: git's own folder, the
// firmware's submodule (31 GB where it is checked out; nothing of the emulator refers to it) and installed packages.
const SKIPPED = new Set([".git", "busybar-firmware", "node_modules"]);
function treeSnapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    const stat = lstatSync(dir);
    out.set(relative(root, dir) || ".", `dir ${stat.mtimeMs}`);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const at = join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else {
        const s = lstatSync(at);
        out.set(relative(root, at), `${entry.isSymbolicLink() ? "link" : "file"} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out;
}
function treeChanges(before, after) {
  const changes = [];
  for (const [path, was] of before) if (after.get(path) !== was) changes.push(`${path}: ${was} -> ${after.get(path) ?? "gone"}`);
  for (const path of after.keys()) if (!before.has(path)) changes.push(`${path}: new`);
  return changes;
}

/** The command line `index.mjs` of `serverFolder` in a process of its own; `lines()` is what it printed so far. */
function commandLine(t, serverFolder, args, env) {
  const proc = node(t, [join(serverFolder, "index.mjs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  proc.stderr.on("data", (chunk) => (err += chunk));
  proc.lines = () => out.split("\n").filter(Boolean);
  proc.errors = () => err;
  let ready = null;
  const started = () =>
    until("the command line's first line", () => (proc.lines()[0]?.startsWith("BUSY Bar emulator: ") ? proc.lines()[0] : null), 60000).catch((e) => {
      throw new Error(`${e.message}; it said on stderr: ${err}`);
    });
  Object.defineProperty(proc, "ready", { get: () => (ready ??= started()) });
  return proc;
}
const baseOf = (line) => /http:\/\/127\.0\.0\.1:\d+/.exec(line)[0];

/** Ends the command line as the app does: SIGTERM on macOS and Linux; on Windows the process is terminated. */
async function end(proc) {
  proc.kill("SIGTERM");
  return proc.exited();
}

const SETTINGS = { format_version: 1, version: 1, fields: { on: { type: "boolean", label: "On", default: false } } };
async function installWithSettings(base, id) {
  const files = {
    [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.0.0" }),
    [`${id}/appmeta/settings.json`]: JSON.stringify(SETTINGS),
    [`${id}/scripts/main.js`]: "setInterval(function () {}, 1000);",
  };
  const staged = await request("POST", `${base}/api/apps/stage`, targz(files));
  assert.equal(staged.status, 200, staged.text);
  assert.equal((await request("POST", `${base}/api/apps/install?install_key=${staged.json().install_key}`)).status, 200);
}

test("without --data the data lives in the user's data folder, and after a day's work not a file of the emulator's own tree is new or changed", async (t) => {
  const home = tempDir(t);
  const env = homeEnv(home);
  const folder = expectedFolder(emulatorDir, env, home);
  const real = realDataFolder();
  const before = treeSnapshot(repository);

  const cli = commandLine(t, serverDir, ["--port", String(port(0))], env);
  const first = await cli.ready;
  assert.ok(first.includes(`data ${folder})`), first);
  const base = baseOf(first);
  // Install an app, change its settings and the bar's, start it, restart the bar, install over it, take it off.
  await installWithSettings(base, "app.test.tree");
  assert.equal((await request("PUT", `${base}/api/apps/settings?app_id=app.test.tree`, Buffer.from(JSON.stringify({ version: 1, values: { on: true } })))).status, 200);
  assert.equal((await request("POST", `${base}/api/name`, Buffer.from(JSON.stringify({ name: "Tree" })))).status, 200);
  assert.equal((await request("POST", `${base}/api/audio/volume?volume=7&silent=1`)).status, 200);
  assert.equal((await request("POST", `${base}/api/apps/launch?app_id=app.test.tree`)).status, 200);
  assert.equal((await request("POST", `${base}/api/log_dump`)).status, 200);
  const boots = (await get(`${base}/_emu/state`)).json().boots;
  assert.equal((await request("POST", `${base}/_emu/power?action=restart`)).status, 200);
  await until("the bar back after the restart", async () => {
    const state = (await get(`${base}/_emu/state`)).json();
    return state.boots > boots && state.powered ? state : null;
  }, 30000);
  await installWithSettings(base, "app.test.tree");
  await installWithSettings(base, "app.test.gone");
  assert.equal((await request("DELETE", `${base}/api/apps?app_id=app.test.gone`)).status, 200);
  // Ended by SIGTERM: the code a shell gives a process ended by it.
  if (!windows) assert.equal(await end(cli), 143);
  else await end(cli);

  // Everything went to the data folder, laid out as architecture.md section 4 says.
  assert.equal(readFileSync(join(folder, "format"), "utf8"), "1\n");
  assert.ok(existsSync(join(folder, "bar", "1.3.1", "ext", "user_assets", "app.test.tree", "appmeta", "manifest.json")));
  assert.ok(existsSync(join(folder, "bar", "1.3.1", "ext", "apps_data", "jsrunner", "app.test.tree.settings.json")));
  assert.ok(existsSync(join(folder, "bar", "1.3.1", "ext", "log.txt")));
  // A terminated process leaves its lock (Windows); one that was asked to stop does not.
  if (!windows) assert.ok(!existsSync(join(folder, "run", "server.lock")));
  // Nothing in the emulator's tree, and the machine's real data folder as it was.
  assert.deepEqual(treeChanges(before, treeSnapshot(repository)), []);
  assert.deepEqual(realDataFolder(), real);
});

// A user name in Greek and Chinese ("user" in both), as escapes: committed files stay in ASCII.
const NON_LATIN = "\u03a7\u03c1\u03ae\u03c3\u03c4\u03b7\u03c2 \u7528\u6237";

test("a home named in letters outside Latin, deep enough that the data folder's paths pass 260 characters", async (t) => {
  // Windows keeps paths to 260 characters unless a program asks for more; Node does, and so must everything here.
  // The home itself stays shorter: Windows will not give a profile path over 260 characters (os.homedir() fails).
  const home = join(tempDir(t), NON_LATIN, ...Array.from({ length: 3 }, (_, i) => `a-rather-long-folder-name-${i}-${"x".repeat(12)}`));
  assert.ok(home.length < 240, `the home is ${home.length} characters`);
  mkdirSync(home, { recursive: true });
  const env = homeEnv(home);
  const folder = expectedFolder(emulatorDir, env, home);
  const cli = commandLine(t, serverDir, ["--port", String(port(0))], env);
  const first = await cli.ready;
  assert.ok(first.includes(`data ${folder})`), first);
  await installWithSettings(baseOf(first), "app.test.deep");
  const manifest = join(folder, "bar", "1.3.1", "ext", "user_assets", "app.test.deep", "appmeta", "manifest.json");
  assert.ok(manifest.length > 260, `${manifest.length} characters`);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).id, "app.test.deep");
  await end(cli);
  // Started again, the folder is the same one, with the app in it.
  const again = commandLine(t, serverDir, ["--port", String(port(0))], env);
  const line = await again.ready;
  assert.deepEqual((await get(`${baseOf(line)}/api/apps/list`)).json().apps.map((app) => app.id), ["app.test.deep"]);
  await end(again);
});

test("a home the system will not give is a failed start: one line, exit code 1", { skip: !windows && "only Windows refuses a long home (a profile path over 260 characters)" }, async (t) => {
  const home = join(tempDir(t), ...Array.from({ length: 6 }, (_, i) => `a-rather-long-folder-name-${i}-${"x".repeat(12)}`));
  mkdirSync(home, { recursive: true });
  const proc = node(t, [join(serverDir, "index.mjs"), "--port", String(port(0))], { env: homeEnv(home), stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  proc.stderr.on("data", (chunk) => (err += chunk));
  assert.equal(await proc.exited(), 1);
  assert.equal(out, "");
  assert.match(err, /^A system error occurred: uv_os_homedir returned ENOBUFS[^\n]*\n$/);
});

test("the command line's --data and the default: a relative --data is counted from the folder it is started in", async (t) => {
  const home = tempDir(t);
  const env = homeEnv(home);
  const work = join(home, "work");
  mkdirSync(work);
  const proc = node(t, [join(serverDir, "index.mjs"), "--port", String(port(0)), "--data", "here-data"], { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  const first = await until("the first line", () => (out.includes("\n") ? out.split("\n")[0] : null), 60000);
  // The folder it was started in, as the system names it (on macOS the temporary folder is reached through a link).
  assert.ok(first.includes(`data ${join(realpathSync(work), "here-data")})`), first);
  assert.ok(existsSync(join(work, "here-data", "format")));
  assert.ok(!existsSync(join(home, "Library")) && !existsSync(join(home, "AppData")), "the default folder is not made");
  await end(proc);
});

/**
 * A copy of the emulator's server beside an engine it shares with this tree, in a temporary folder laid out as the
 * repository is (so that it is a development copy): a tree the test may put an old emulator/.data into.
 */
function treeCopy(t) {
  const root = join(tempDir(t), "tree");
  const packages = join(root, "emulator", "packages");
  mkdirSync(join(packages, "app"), { recursive: true });
  writeFileSync(join(packages, "app", "package.json"), JSON.stringify({ name: "stand-in", version: "0.0.0" }));
  cpSync(serverDir, join(packages, "server"), { recursive: true });
  // The engine is only read: a link to this tree's (a junction on Windows, which needs no privilege).
  symlinkSync(resolve(serverDir, "..", "engine"), join(packages, "engine"), "junction");
  return root;
}

test("the folder of earlier versions, emulator/.data, is left as it was, and the first start says where the data lives now", async (t) => {
  const tree = treeCopy(t);
  const legacy = join(realpathSync(tree), "emulator", ".data");
  mkdirSync(join(legacy, "ext", "user_assets", "app.old"), { recursive: true });
  writeFileSync(join(legacy, "ext", "user_assets", "app.old", "kept.txt"), "kept");
  const legacyBefore = treeSnapshot(legacy);
  const home = tempDir(t);
  const env = homeEnv(home);
  const folder = expectedFolder(join(tree, "emulator"), env, home);
  const server = join(tree, "emulator", "packages", "server");

  const cli = commandLine(t, server, ["--port", String(port(0))], env);
  await cli.ready;
  await until("the notice", () => cli.lines().length > 5);
  assert.match(
    cli.lines()[5],
    new RegExp(
      `^\\d\\d:\\d\\d:\\d\\d The emulator keeps its data in ${escape(folder)} now\\. The folder ${escape(legacy)} of earlier versions is left as it was and is not read\\. ` +
        `To keep its apps, stop the emulator and move ${escape(join(legacy, "ext"))} to ${escape(join(folder, "bar", "1.3.1", "ext"))}\\.$`,
    ),
  );
  assert.deepEqual((await get(`${baseOf(cli.lines()[0])}/api/apps/list`)).json().apps, [], "nothing is read from it");
  await end(cli);
  assert.deepEqual(treeChanges(legacyBefore, treeSnapshot(legacy)), []);

  // Said once, when the new folder is made; not on the starts after.
  const again = commandLine(t, server, ["--port", String(port(0))], env);
  await again.ready;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(again.lines().filter((line) => line.includes("earlier versions")).length, 0);
  await end(again);
  // With --data nothing is said about it either.
  const given = commandLine(t, server, ["--port", String(port(0)), "--data", join(home, "given")], env);
  await given.ready;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(given.lines().filter((line) => line.includes("earlier versions")).length, 0);
  await end(given);
});

function escape(text) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
