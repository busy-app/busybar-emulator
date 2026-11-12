// busy-emulator uninstall, against a stand-in for the system: the app is stopped when it runs, removed from the
// emulated bar and its projects leave the list, the folders untouched; with --delete-files the one project folder
// goes to the Trash (a stand-in here), only when it is a folder of the list by its real path, never a link to another
// place, the home folder, the data folder or the root. No network, nothing is moved for real.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listProjects, readProjects, rememberProject, registryFile } from "../../projects/registry.mjs";
import { trashableFolder } from "../../path-boundary.mjs";
import { loadCommands, main } from "../busy-emulator.mjs";

const commands = await loadCommands();
const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-uninstall-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const dataDir = path.join(home, "Library", "Application Support", "BUSY Bar Emulator");
  mkdirSync(dataDir, { recursive: true });
  const ctx = { platform: process.platform, kind: "release", development: false, appPath: "/Applications/BUSY Bar Emulator.app", dataDir, runStateFile: path.join(dataDir, "run", "emulator.json"), calledAs: ["busy-emulator"], testLaunch: null, testTerminal: false, nodeTools: { node: "/x/node", npmCli: "/x/npm-cli.js", npxCli: "/x/npx-cli.js", nodeDir: "/x" }, env: {} };
  return { root, home, ctx };
}

function fakeSystem(root, home, { running = true, apps = [], runs = null, trashFails = null } = {}) {
  const sent = [];
  const trashed = [];
  const bar = { apps: [...apps], runs };
  return {
    sent,
    trashed,
    bar,
    cwd: () => root,
    home: () => home,
    atTerminal: () => false,
    readRunState: () => (running ? { state: READY } : { missing: true }),
    alive: () => running,
    probe: async () => (running ? { answering: true } : { answering: false, code: "ECONNREFUSED" }),
    processInfo: () => ({ start: 999_500, exe: READY.exe }),
    // The app's own executable, on any system (its path differs between macOS and Windows).
    samePath: () => true,
    barGet: async (_port, pathname) => {
      if (pathname === "/api/apps/list") return { status: 200, body: JSON.stringify({ apps: bar.apps.map((id) => ({ id })) }) };
      if (pathname === "/_emu/state") return { status: 200, body: JSON.stringify({ running: bar.runs ? { id: bar.runs } : null }) };
      return { status: 404, body: "" };
    },
    barSend: async (_port, method, pathname) => {
      sent.push(`${method} ${pathname}`);
      if (method === "POST" && pathname === "/api/apps/quit") bar.runs = null;
      const removed = /^\/api\/apps\?app_id=(.+)$/.exec(pathname);
      if (method === "DELETE" && removed) {
        if (bar.runs === decodeURIComponent(removed[1])) return { status: 409, body: "running" };
        bar.apps = bar.apps.filter((id) => id !== decodeURIComponent(removed[1]));
      }
      return { status: 200, body: '{"result":"OK"}' };
    },
    trashFolder: async (folder) => {
      if (trashFails) throw new Error(trashFails);
      trashed.push(folder);
    },
    now: () => 5_000_000,
    sleep: async () => {},
  };
}

async function call(argv, ctx, sys) {
  const out = [];
  const code = await main([...argv, "--json"], { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
  return { code, json: JSON.parse(out.at(-1)) };
}

function project(root, ctx, name, id) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id, name: "Clock", version: "0.1.0" }));
  rememberProject(ctx.dataDir, dir, { platform: ctx.platform });
  return realpathSync(dir);
}

test("uninstall <id>: a running app is stopped, then removed from the bar; its project leaves the list and its folder stays", async (t) => {
  const { root, home, ctx } = setup(t);
  const dir = project(home, ctx, "Ρολόι", "app.you.clock");
  const sys = fakeSystem(root, home, { apps: ["app.you.clock", "app.other"], runs: "app.you.clock" });
  const { code, json } = await call(["uninstall", "app.you.clock"], ctx, sys);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json, { ok: true, command: "uninstall", id: "app.you.clock", removed_from_bar: true, was_running: true, forgotten: [dir], kept: [dir], trashed: null });
  assert.deepEqual(sys.sent, ["POST /api/apps/quit", "DELETE /api/apps?app_id=app.you.clock"]);
  assert.deepEqual(sys.bar.apps, ["app.other"]);
  assert.deepEqual(readProjects(ctx.dataDir), []);
  assert.ok(existsSync(dir));
});

test("uninstall of an app from a package: it leaves the bar; --delete-files is refused before anything changes", async (t) => {
  const { root, home, ctx } = setup(t);
  const sys = fakeSystem(root, home, { apps: ["app.jane.status-board"] });
  const refused = await call(["uninstall", "app.jane.status-board", "--delete-files"], ctx, sys);
  assert.deepEqual([refused.code, refused.json.code], [1, "no_project_folder"]);
  assert.deepEqual(sys.sent, []);
  const { json } = await call(["uninstall", "app.jane.status-board"], ctx, sys);
  assert.deepEqual([json.ok, json.removed_from_bar, json.forgotten], [true, true, []]);
  assert.deepEqual(sys.bar.apps, []);
  // Nothing there at all: said so.
  assert.equal((await call(["uninstall", "app.jane.status-board"], ctx, sys)).json.code, "not_found");
});

test("uninstall --delete-files: the project's folder, by its real path, goes to the Trash after the app is removed; by the folder too", async (t) => {
  const { root, home, ctx } = setup(t);
  const dir = project(home, ctx, "Ρολόι", "app.you.clock");
  const sys = fakeSystem(root, home, { apps: ["app.you.clock"] });
  const { json } = await call(["uninstall", "app.you.clock", "--delete-files"], ctx, sys);
  assert.deepEqual([json.ok, json.trashed, json.kept], [true, dir, []]);
  assert.deepEqual(sys.trashed, [dir]);
  assert.deepEqual(readProjects(ctx.dataDir), []);

  // Named by its folder: the project of that folder.
  const again = project(home, ctx, "Ρολόι", "app.you.clock");
  sys.bar.apps.push("app.you.clock");
  const byFolder = await call(["uninstall", path.join(home, "Ρολόι"), "--delete-files"], ctx, sys);
  assert.deepEqual([byFolder.json.id, byFolder.json.trashed], ["app.you.clock", again]);
});

test("uninstall --delete-files refuses a folder that is not the project's own: a link to another place, the home or data folder; and says when the Trash fails", async (t) => {
  const { root, home, ctx } = setup(t);
  const elsewhere = path.join(root, "somebody else's");
  mkdirSync(path.join(elsewhere, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(elsewhere, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.you.clock" }));
  const dir = project(home, ctx, "clock", "app.you.clock");
  // The project folder is replaced by a link to another place.
  rmSync(dir, { recursive: true });
  try {
    symlinkSync(elsewhere, dir, "junction");
  } catch {
    t.skip("this system makes no links here");
    return;
  }
  const sys = fakeSystem(root, home, { apps: ["app.you.clock"] });
  const linked = await call(["uninstall", "app.you.clock", "--delete-files"], ctx, sys);
  assert.deepEqual([linked.code, linked.json.code], [1, "not_deletable"]);
  assert.match(linked.json.message, /link to another place/);
  assert.deepEqual([sys.sent, sys.trashed], [[], []]);
  assert.equal(listProjects(ctx.dataDir).length, 1, "the list is as it was");

  // The rule for the other places, as the command applies it.
  const rule = (folder, registered = [folder]) => trashableFolder(folder, { registered, dataDir: ctx.dataDir, home, platform: ctx.platform });
  assert.match(rule(ctx.dataDir).refused.message, /data folder/);
  assert.match(rule(path.join(home, "Library")).refused.message, /data folder/);
  assert.match(rule(home).refused.message, /home folder/);
  assert.match(rule(root).refused.message, /home folder/);
  assert.match(rule(path.parse(root).root).refused.message, /root of a disk|home folder/);
  assert.match(rule(elsewhere, [dir]).refused.message, /not among the emulator's projects/);
  assert.deepEqual(rule(elsewhere), { folder: elsewhere });

  // A Trash that would not take the folder: the app is removed, the failure is said, the folder stays.
  rmSync(dir);
  const real = project(home, ctx, "clock", "app.you.clock");
  const stuck = fakeSystem(root, home, { apps: ["app.you.clock"], trashFails: "Permission denied" });
  const failed = await call(["uninstall", "app.you.clock", "--delete-files"], ctx, stuck);
  assert.equal(failed.json.code, "trash_failed");
  assert.match(failed.json.message, /was removed from the emulator, but its folder .* could not be moved to the (Trash|Recycle Bin): Permission denied/);
  assert.ok(existsSync(real));
  assert.ok(!existsSync(registryFile(ctx.dataDir)) || readProjects(ctx.dataDir).length === 0);
});

test("uninstall needs a running emulator, and an id or a folder", async (t) => {
  const { root, home, ctx } = setup(t);
  project(home, ctx, "clock", "app.you.clock");
  const off = fakeSystem(root, home, { running: false });
  assert.equal((await call(["uninstall", "app.you.clock"], ctx, off)).json.code, "not_running");
  assert.equal(listProjects(ctx.dataDir).length, 1);
  assert.equal((await call(["uninstall"], ctx, off)).json.code, "usage");
  assert.equal((await call(["uninstall", "not an id"], ctx, off)).json.code, "usage");
  assert.equal((await call(["uninstall", "./nowhere"], ctx, off)).json.code, "not_a_project");
});
