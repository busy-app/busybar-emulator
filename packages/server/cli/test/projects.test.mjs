// busy-emulator projects, against a stand-in for the system (EMU-260): the project commands note the project they
// work on; the list says which app is which folder; --prune lets a project whose folder was deleted go, with its app
// on the bar, and leaves alone one whose disk is not there. No network, no tool is started.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { listProjects } from "../../projects/registry.mjs";
import { trustProject } from "../../projects/trust.mjs";
import { loadCommands, main, parseArguments } from "../busy-emulator.mjs";

const commands = await loadCommands();
const APP_PATH = "/Applications/BUSY Bar Emulator.app";
const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-projects-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const ctx = { platform: process.platform, kind: "release", development: false, appPath: APP_PATH, dataDir, runStateFile: path.join(dataDir, "run", "emulator.json"), calledAs: ["busy-emulator"], testLaunch: null, testTerminal: false, nodeTools: { node: "/x/node", npmCli: "/x/npm-cli.js", npxCli: "/x/npx-cli.js", nodeDir: "/x" }, env: {} };
  return { root, ctx };
}

/**
 * An emulator that runs (or not) with a bar that holds `apps` and runs `running`; what it is sent is kept. `builds`
 * says which build of an app the bar holds (the text of its files, as the bar's storage gives them): "the project's"
 * unless told.
 */
function fakeSystem(root, { running = true, apps = [], runs = null, volumePresent = null, builds = {} } = {}) {
  const sent = [];
  const bar = { apps: [...apps], runs };
  const read = /^\/api\/storage\/read\?path=%2Fext%2Fuser_assets%2F([^%]+)%2F(.+)$/;
  return {
    sent,
    bar,
    cwd: () => root,
    atTerminal: () => false,
    readRunState: () => (running ? { state: READY } : { missing: true }),
    alive: () => running,
    probe: async () => (running ? { answering: true } : { answering: false, code: "ECONNREFUSED" }),
    // The executable of this copy's app as the command line expects it on the platform the test runs on (ctx.platform
    // is process.platform here): on Windows a release's appPath is the executable itself.
    processInfo: (_pid, platform) => ({ start: 999_500, exe: platform === "win32" ? APP_PATH : READY.exe }),
    samePath: (a, b) => a === b,
    barGet: async (_port, pathname) => {
      if (pathname === "/api/apps/list") return { status: 200, body: JSON.stringify({ apps: bar.apps.map((id) => ({ id })) }) };
      if (pathname === "/_emu/state") return { status: 200, body: JSON.stringify({ running: bar.runs ? { id: bar.runs } : null }) };
      const file = read.exec(pathname);
      if (file && bar.apps.includes(file[1])) return { status: 200, body: `${file[2]} of ${builds[file[1]] ?? "the project's build"}` };
      return { status: 404, body: "" };
    },
    builds,
    barSend: async (_port, method, pathname) => {
      sent.push(`${method} ${pathname}`);
      if (method === "POST" && pathname === "/api/apps/quit") bar.runs = null;
      const removed = /^\/api\/apps\?app_id=(.+)$/.exec(pathname);
      if (method === "DELETE" && removed) bar.apps = bar.apps.filter((id) => id !== decodeURIComponent(removed[1]));
      return { status: 200, body: '{"result":"OK"}' };
    },
    runTool: async () => ({ code: 0, signal: null, output: "" }),
    now: () => 5_000_000,
    sleep: async () => {},
    ...(volumePresent ? { volumePresent } : {}),
  };
}

async function call(argv, ctx, sys, { json = true } = {}) {
  const out = [];
  const err = [];
  const code = await main(json ? [...argv, "--json"] : argv, { ctx, sys, commands, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: json && out.length ? JSON.parse(out.at(-1)) : null };
}

/** A project with busy-cli installed, trusted unless told. */
function project(root, ctx, name, id, { trusted = true } = {}) {
  const dir = path.join(root, name);
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(path.join(cli, "dist"), { recursive: true });
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id, name: name.toUpperCase() }));
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(path.join(cli, "dist", "index.js"), "");
  if (trusted) trustProject(ctx.dataDir, dir, "created", { platform: ctx.platform });
  return realpathSync(dir);
}

test("build, install, run and stop note the project; a command refused for trust notes nothing", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root);
  const folders = () => listProjects(ctx.dataDir).map((one) => one.folder);
  assert.deepEqual((await call(["projects"], ctx, sys)).json.projects, []);
  const stranger = project(root, ctx, "stranger", "app.you.stranger", { trusted: false });
  assert.equal((await call(["build", stranger], ctx, sys)).json.code, "untrusted_project");
  assert.deepEqual(folders(), []);
  const names = ["build", "install", "run", "stop"];
  const made = names.map((name) => project(root, ctx, `by-${name}`, `app.you.${name}`));
  for (const [i, name] of names.entries()) await call([name, made[i]], ctx, sys);
  assert.deepEqual(folders(), [...made].reverse(), "each command noted its project, the latest first");
  // check runs nothing of the project and notes nothing.
  const checked = project(root, ctx, "checked", "app.you.checked");
  await call(["check", checked], ctx, sys);
  assert.equal(folders().includes(checked), false);
});

test("the list says for each project where it is, whether it is trusted and built, and whether its app is on the BUSY Bar and running", async (t) => {
  const { root, ctx } = setup(t);
  const clock = project(root, ctx, "clock", "app.you.clock");
  const timer = project(root, ctx, "timer", "app.you.timer");
  const sys = fakeSystem(root, { apps: ["app.you.clock", "app.from.archive"], runs: "app.you.clock" });
  await call(["build", timer], ctx, sys);
  await call(["build", clock], ctx, sys);
  mkdirSync(path.join(clock, "dist"));
  writeFileSync(path.join(clock, "dist", "app.you.clock.tgz"), "");
  const listed = await call(["projects"], ctx, sys);
  assert.equal(listed.code, 0);
  assert.equal(listed.json.bar, "ready");
  assert.deepEqual(
    listed.json.projects.map(({ seen: _seen, ...rest }) => rest),
    [
      { id: "app.you.clock", name: "CLOCK", folder: clock, exists: true, unavailable: false, trusted: true, built: true, dependencies: { state: "installed" }, installed: true, running: true, stale: false },
      { id: "app.you.timer", name: "TIMER", folder: timer, exists: true, unavailable: false, trusted: true, built: false, dependencies: { state: "installed" }, installed: false, running: false, stale: false },
    ],
    "an app installed from an archive has no project and is not here",
  );
  const text = (await call(["projects"], ctx, sys, { json: false })).out;
  assert.match(text, new RegExp(`app\\.you\\.clock  ${clock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}  \\(built, running on the BUSY Bar\\)`));

  // Without a running emulator the bar's part is not known, and says so.
  const off = await call(["projects"], ctx, fakeSystem(root, { running: false }));
  assert.equal(off.json.bar, "not_running");
  assert.deepEqual(off.json.projects.map((one) => [one.installed, one.running]), [[null, null], [null, null]]);
});

test("stale: the project's files changed after it put its app on the BUSY Bar; what the build and the tools write does not count", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { apps: ["app.you.clock"] });
  const clock = project(root, ctx, "clock", "app.you.clock");
  const stale = async () => (await call(["projects"], ctx, sys)).json.projects[0].stale;
  // Built only, never put on the bar by the project: nothing says how old the app on the bar is.
  await call(["build", clock], ctx, sys);
  assert.equal(await stale(), false);
  await call(["install", clock], ctx, sys);
  assert.equal(await stale(), false, "just installed");
  const later = (Date.now() + 60_000) / 1000;
  for (const rel of ["dist/app.you.clock.tgz", "screenshots/front-1.png", "submission/manifest.yml", "package-lock.json", ".busy/publish.json", "node_modules/x/index.js"]) {
    mkdirSync(path.dirname(path.join(clock, rel)), { recursive: true });
    writeFileSync(path.join(clock, rel), "x");
    utimesSync(path.join(clock, rel), later, later);
  }
  assert.equal(await stale(), false, "the build's, the tools' and the dependencies' files");
  writeFileSync(path.join(clock, "src", "main.ts"), "console.log(2)");
  utimesSync(path.join(clock, "src", "main.ts"), later, later);
  assert.equal(await stale(), true, "a source file written after the install");
  assert.match((await call(["projects"], ctx, sys, { json: false })).out, /its files changed since/);
  // Put on the bar again (a Refresh): the app is as new as the files.
  await call(["install", clock], ctx, sys);
  utimesSync(path.join(clock, "src", "main.ts"), Date.now() / 1000 - 60, Date.now() / 1000 - 60);
  assert.equal(await stale(), false, "installed again after the edit");
  // Not on the bar any more: nothing to refresh there.
  utimesSync(path.join(clock, "src", "main.ts"), later, later);
  assert.equal(await stale(), true);
  sys.bar.apps = [];
  assert.equal(await stale(), false, "its app is not on the BUSY Bar");
});

test("--add takes a trusted project only, --forget takes one out and leaves the folder and the BUSY Bar alone", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { apps: ["app.you.clock"] });
  const clock = project(root, ctx, "clock", "app.you.clock");
  const stranger = project(root, ctx, "stranger", "app.you.stranger", { trusted: false });
  const refused = await call(["projects", "--add", stranger], ctx, sys);
  assert.deepEqual([refused.code, refused.json.code], [1, "untrusted_project"]);
  assert.match(refused.json.hint, / trust /);
  assert.equal((await call(["projects", "--add", path.join(root, "nothing here")], ctx, sys)).json.code, "not_a_project");
  const added = await call(["projects", "--add", "clock"], ctx, sys);
  assert.equal(added.json.added, clock);
  assert.deepEqual(added.json.projects.map((one) => one.folder), [clock]);

  assert.equal((await call(["projects", "--forget", stranger], ctx, sys)).json.code, "not_a_project");
  const forgotten = await call(["projects", "--forget", clock], ctx, sys);
  assert.deepEqual([forgotten.json.forgotten, forgotten.json.projects], [clock, []]);
  assert.ok(existsSync(path.join(clock, "package.json")));
  assert.deepEqual(sys.sent, [], "nothing was sent to the BUSY Bar");
  assert.equal((await call(["projects", "--add", clock, "--forget", clock], ctx, sys)).code, 2);
});

test("--prune: a project whose folder was deleted leaves the list and its app the BUSY Bar, stopped first when it runs", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { apps: ["app.you.clock", "app.you.timer", "app.from.archive"], runs: "app.you.clock" });
  const clock = project(root, ctx, "clock", "app.you.clock");
  const timer = project(root, ctx, "timer", "app.you.timer");
  await call(["install", clock], ctx, sys);
  await call(["install", timer], ctx, sys);
  const kept = readdirSync(timer).sort();

  // Nothing is gone: nothing leaves.
  const calm = await call(["projects", "--prune"], ctx, sys);
  assert.deepEqual([calm.json.removed, sys.sent], [[], []]);

  renameSync(clock, path.join(root, "clock moved away"));
  // Without --prune the list only says so.
  const listed = await call(["projects"], ctx, sys);
  assert.deepEqual(listed.json.projects.map((one) => [one.id, one.exists, one.unavailable]), [["app.you.timer", true, false], ["app.you.clock", false, false]]);
  assert.deepEqual(sys.sent, []);

  const pruned = await call(["projects", "--prune"], ctx, sys);
  assert.deepEqual(pruned.json.removed, [{ id: "app.you.clock", folder: clock, uninstalled: true }]);
  assert.deepEqual(sys.sent, ["POST /api/apps/quit", "DELETE /api/apps?app_id=app.you.clock"]);
  assert.deepEqual(pruned.json.projects.map((one) => one.id), ["app.you.timer"]);
  assert.deepEqual(sys.bar, { apps: ["app.you.timer", "app.from.archive"], runs: null }, "the other project's app and the app from an archive stay");
  assert.deepEqual(readdirSync(timer).sort(), kept);
  assert.ok(existsSync(path.join(root, "clock moved away", "package.json")), "nothing inside a project folder is deleted");
});

test("--prune: a folder whose disk is not there is unavailable, not deleted: the project and its app stay, and it works again when the disk is back", async (t) => {
  const { root, ctx } = setup(t);
  let diskThere = false;
  const asked = [];
  const sys = fakeSystem(root, { apps: ["app.you.clock"], runs: "app.you.clock", volumePresent: (volume) => (asked.push(volume), diskThere) });
  const clock = project(root, ctx, "clock", "app.you.clock");
  await call(["install", clock], ctx, sys);
  // The disk is unplugged: the folder is gone and so is the place its disk was mounted at.
  renameSync(clock, path.join(root, "unplugged"));
  for (let round = 0; round < 2; round++) {
    const away = await call(["projects", "--prune"], ctx, sys);
    assert.deepEqual(away.json.removed, []);
    assert.deepEqual(away.json.projects.map((one) => [one.id, one.exists, one.unavailable, one.installed, one.running]), [["app.you.clock", false, true, true, true]]);
  }
  assert.deepEqual(sys.sent, [], "nothing was stopped or removed on the BUSY Bar");
  assert.ok(asked.length > 0);
  assert.match((await call(["projects"], ctx, sys, { json: false })).out, /the folder's disk is not there/);
  // The disk is back.
  renameSync(path.join(root, "unplugged"), clock);
  const back = await call(["projects", "--prune"], ctx, sys);
  assert.deepEqual(back.json.projects.map((one) => [one.exists, one.unavailable, one.trusted]), [[true, false, true]]);
  // And when the disk is there and the folder is not, the project was deleted.
  renameSync(clock, path.join(root, "deleted"));
  diskThere = true;
  assert.deepEqual((await call(["projects", "--prune"], ctx, sys)).json.removed, [{ id: "app.you.clock", folder: clock, uninstalled: true }]);
});

test("--prune removes nothing without a running emulator, keeps an app another project still is, and an app the BUSY Bar would not remove keeps its project", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { apps: ["app.you.clock"] });
  const clock = project(root, ctx, "clock", "app.you.clock");
  const copy = project(root, ctx, "clock copy", "app.you.clock");
  await call(["install", clock], ctx, sys);
  await call(["install", copy], ctx, sys);
  rmSync(clock, { recursive: true });

  const off = await call(["projects", "--prune"], ctx, fakeSystem(root, { running: false }));
  assert.deepEqual([off.json.removed, off.json.projects.length], [[], 2]);

  const pruned = await call(["projects", "--prune"], ctx, sys);
  assert.deepEqual(pruned.json.removed, [{ id: "app.you.clock", folder: clock, uninstalled: false }]);
  assert.deepEqual([sys.sent, sys.bar.apps], [[], ["app.you.clock"]], "the copy is the same app: it stays on the BUSY Bar");

  rmSync(copy, { recursive: true });
  const stubborn = { ...sys, barSend: async (_port, method, pathname) => (sys.sent.push(`${method} ${pathname}`), { status: 500, body: "" }) };
  const kept = await call(["projects", "--prune"], ctx, stubborn);
  assert.deepEqual([kept.json.removed, kept.json.projects.map((one) => one.exists)], [[], [false]]);
});

test("--prune removes only an app this project installed: an app of the same id from an archive stays, and so does one installed over the project's", async (t) => {
  const { root, ctx } = setup(t);
  // The bar holds an app that came from an archive. A project whose manifest has the same id is opened and built,
  // never installed; then its folder is deleted (the security pass on pull request 64).
  const sys = fakeSystem(root, { apps: ["app.you.clock"], runs: "app.you.clock", builds: { "app.you.clock": "the archive" } });
  const clone = project(root, ctx, "clone", "app.you.clock");
  await call(["projects", "--add", clone], ctx, sys);
  await call(["build", clone], ctx, sys);
  rmSync(clone, { recursive: true });
  const pruned = await call(["projects", "--prune"], ctx, sys);
  assert.deepEqual(pruned.json.removed, [{ id: "app.you.clock", folder: clone, uninstalled: false }]);
  assert.deepEqual(pruned.json.projects, []);
  assert.deepEqual([sys.sent, sys.bar], [[], { apps: ["app.you.clock"], runs: "app.you.clock" }], "the archive's app is as it was, still running");

  // A project installs its build; then something else installs another build of the same id over it (an archive
  // through the local web, an agent with busy-cli). The folder is deleted: what is on the bar is no longer its own.
  const timer = project(root, ctx, "timer", "app.you.timer");
  const other = fakeSystem(root, { apps: ["app.you.timer"] });
  await call(["install", timer], ctx, other);
  other.builds["app.you.timer"] = "somebody else's build";
  rmSync(timer, { recursive: true });
  const after = await call(["projects", "--prune"], ctx, other);
  assert.deepEqual([after.json.removed, other.sent, other.bar.apps], [[{ id: "app.you.timer", folder: timer, uninstalled: false }], [], ["app.you.timer"]]);

  // The author renamed the app after the install: the id that was installed is not the one the project has now.
  const renamed = project(root, ctx, "renamed", "app.you.old");
  const third = fakeSystem(root, { apps: ["app.you.old", "app.you.new"] });
  await call(["install", renamed], ctx, third);
  writeFileSync(path.join(renamed, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.you.new" }));
  await call(["build", renamed], ctx, third);
  rmSync(renamed, { recursive: true });
  assert.deepEqual([(await call(["projects", "--prune"], ctx, third)).json.removed.map((one) => one.uninstalled), third.sent], [[false], []]);
});

test("install, run and dev note what they put on the BUSY Bar; build, stop and seeing the folder again keep the note; a BUSY Bar that would not show the app leaves none", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root, { apps: ["app.you.clock"] });
  const clock = project(root, ctx, "clock", "app.you.clock");
  const note = () => JSON.parse(readFileSync(path.join(ctx.dataDir, "projects", "registry.json"), "utf8")).projects.find((one) => one.path === clock)?.installed ?? null;
  await call(["build", clock], ctx, sys);
  assert.equal(note(), null);
  await call(["install", clock], ctx, sys);
  const first = note();
  assert.deepEqual([first.id, /^[0-9a-f]{64}$/.test(first.mark)], ["app.you.clock", true]);
  for (const name of ["build", "stop"]) await call([name, clock], ctx, sys);
  assert.deepEqual(note(), first);
  // Another build of the project on the bar: another mark.
  sys.builds["app.you.clock"] = "the project's next build";
  mkdirSync(path.join(clock, "dist"), { recursive: true });
  writeFileSync(path.join(clock, "dist", "app.you.clock.tgz"), "");
  await call(["run", clock], ctx, sys);
  assert.notEqual(note().mark, first.mark);
  // The list never shows the mark.
  assert.equal(JSON.stringify((await call(["projects"], ctx, sys)).json).includes(note().mark), false);
  // The bar does not hold the app after the install (it would not say): no note, so nothing there is the project's.
  sys.bar.apps = [];
  await call(["install", clock], ctx, sys);
  assert.equal(note(), null);
});

test("--progress with --json says on standard error what a long command is doing; without it --json is silent there", async (t) => {
  const { root, ctx } = setup(t);
  const sys = fakeSystem(root);
  const clock = project(root, ctx, "clock", "app.you.clock");
  assert.equal((await call(["build", clock], ctx, sys)).err, "");
  const aloud = await call(["build", clock, "--progress"], ctx, sys);
  assert.equal(aloud.err, "busy-cli build");
  assert.equal(aloud.json.ok, true);
  assert.deepEqual([parseArguments(["--progress", "build"]).progress, parseArguments(["build"]).progress], [true, false]);
});
