// create, build and the list of projects when the npm registry cannot be reached or hangs (create-offline), against a
// registry of the test's own on 127.0.0.1 whose network is cut per package (packages/app/test/fixtures/fake-registry.mjs). Nothing here reaches
// the real network: the command line's npm is pointed at that registry, its home and data folder are the test's.
//
// What the owner met on the field test (11.11): Create app pressed with a Wi-Fi out of range, npm waited minutes and nothing said why; the
// project, created without its dependencies, sat in the list as "Not on the bar yet", and creating again made more
// rows of the same name. Here:
// - a registry that refuses: create ends in seconds (npm's own retries took 70 s for one package, 4.5 min for a
//   project), and says network_failed;
// - the template there, the dependencies not: the project is created, trusted and listed, and the list says its
//   dependencies are not installed and why; `build --dependencies-only` with the registry back installs them;
// - a registry that takes the request and never answers: npm is stopped after a while of silence (network_stalled);
// - npm's cache holds the dependencies of a project created before: a new project is created without the network;
// - an install cut off (the app quit) leaves node_modules half-written: the next build installs again.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test as nodeTest } from "node:test";

import { registryFile } from "../../packages/server/projects/registry.mjs";
import { fakeRegistry } from "../../packages/app/test/fixtures/fake-registry.mjs";
import { finish, node, port, serverModule, tempDir } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 180_000 }, fn);
const CLI = serverModule(join("cli", "busy-emulator.mjs"));

let folder;
let registry;
const modes = new Map(); // package → "pass" | "refuse" | "hang"

before(async () => {
  folder = realpathSync(tempDir({ after: () => {} }));
  registry = await fakeRegistry({ port: port(1), mode: (name) => modes.get(name) ?? "pass" });
});
after(() => registry?.close());

/** A home and a data folder of their own: npm's cache in it starts empty. */
function place(name) {
  const root = join(folder, name);
  const home = join(root, "home");
  const work = join(root, "work");
  const data = join(root, "data");
  for (const dir of [home, work, data]) mkdirSync(dir, { recursive: true });
  // create takes the generator's registry from ~/.npmrc only, never from the environment (create.mjs,
  // generatorRegistry): the test's home names the test's registry.
  writeFileSync(join(home, ".npmrc"), `registry=${registry.url}\n`);
  return { root, home, work, data };
}

function environment(at, extra = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(BUSY_EMULATOR_|npm_)/i.test(name)));
  return {
    ...clean,
    HOME: at.home,
    USERPROFILE: at.home,
    APPDATA: join(at.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(at.home, "AppData", "Local"),
    BUSY_EMULATOR_DATA: at.data,
    // No emulator listens there: create and build need none.
    BUSY_EMULATOR_PORT: String(port(2) || 9509),
    npm_config_registry: registry.url,
    ...extra,
  };
}

/** Runs the command line to its end: { code, json (its last line), progress (its progress lines), ms }. */
async function cli(t, at, words, extra = {}) {
  const started = Date.now();
  const child = node(t, [CLI, ...words, "--json", "--progress"], { cwd: at.work, env: environment(at, extra), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(150_000);
  let json = null;
  try {
    json = JSON.parse(stdout.trim().split(/\r?\n/).pop());
  } catch {
    // not an answer
  }
  return { code, json, stdout, stderr, ms: Date.now() - started };
}

const listed = async (t, at) => (await cli(t, at, ["projects"])).json.projects;
const pass = () => modes.clear();

test("a registry that refuses: create ends in seconds with network_failed, and nothing is half-made", async (t) => {
  const at = place("refused");
  modes.set("@busy-app/create-app", "refuse").set("@busy-app/cli", "refuse");
  t.after(pass);
  const run = await cli(t, at, ["create", "focus-timer", "--author", "Tester"]);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.equal(run.json.code, "network_failed", JSON.stringify(run.json));
  assert.match(run.json.message, /could not reach http:\/\/127\.0\.0\.1:\d+\/@busy-app%2fcreate-app/);
  assert.ok(run.ms < 30_000, `it took ${run.ms} ms`);
  assert.equal(existsSync(join(at.work, "focus-timer")), false, "no project folder without the template");
});

test("the template there, the dependencies not: the project is created and listed as failed; Retry with the registry back installs them", async (t) => {
  const at = place("retry");
  modes.set("@busy-app/cli", "refuse");
  t.after(pass);
  const run = await cli(t, at, ["create", "focus-timer", "--author", "Tester"]);
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.equal(run.json.code, "network_failed", JSON.stringify(run.json));
  assert.equal(run.json.created, true);
  const dir = realpathSync(join(at.work, "focus-timer"));
  assert.equal(run.json.folder, dir);
  assert.match(run.json.id, /^app\.tester\.focus/);
  assert.match(run.json.hint, /The project is created in .*focus-timer, without its dependencies: check the connection/);
  assert.ok(run.ms < 30_000, `it took ${run.ms} ms`);
  // The console says what happened, as it went.
  assert.match(run.stderr, /Installing the dependencies \(npm install/);
  assert.match(run.stderr, /The npm registry cannot be reached: trying npm's cache/);

  let [project] = await listed(t, at);
  assert.equal(project.folder, dir);
  assert.equal(project.trusted, true);
  assert.equal(project.dependencies.state, "failed");
  assert.equal(project.dependencies.code, "network_failed");
  assert.match(project.dependencies.message, /could not reach/);

  // Retry while the network is still down: the same failure, said again.
  const still = await cli(t, at, ["build", dir, "--dependencies-only"]);
  assert.equal(still.json.code, "network_failed", JSON.stringify(still.json));

  // The network is back.
  pass();
  const retried = await cli(t, at, ["build", dir, "--dependencies-only"]);
  assert.equal(retried.code, 0, retried.stdout + retried.stderr);
  assert.equal(retried.json.dependencies, "installed");
  assert.equal(retried.json.busy_cli, "0.6.0");
  [project] = await listed(t, at);
  assert.equal(project.dependencies.state, "installed");
  assert.equal(JSON.parse(readFileSync(registryFile(at.data), "utf8")).projects[0].deps, undefined, "no note is left once it went well");
  // Nothing more to do: present.
  assert.equal((await cli(t, at, ["build", dir, "--dependencies-only"])).json.dependencies, "present");
});

test("a registry that takes the request and never answers: npm is stopped after its silence, network_stalled", async (t) => {
  const at = place("hang");
  modes.set("@busy-app/cli", "hang");
  t.after(pass);
  // The short silence is the dependencies' install's only: the generator's npm, starting on a machine the gate loads,
  // says nothing for longer than 4 s too, and stopped so it left no template and no project (created undefined).
  const run = await cli(t, at, ["create", "focus-timer", "--author", "Tester"], { BUSY_EMULATOR_TEST_NPM_QUIET: "4:dependencies" });
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.equal(run.json.code, "network_stalled", JSON.stringify(run.json));
  assert.match(run.json.message, /got no answer from http:\/\/127\.0\.0\.1:\d+\/ for 4 s, so it was stopped: the connection hangs/);
  assert.equal(run.json.created, true, JSON.stringify(run.json) + run.stderr);
  assert.match(run.stderr, /No answer from the npm registry for \d+ s…/);
  assert.ok(run.ms < 60_000, `it took ${run.ms} ms`);
  const [project] = await listed(t, at);
  assert.equal(project.dependencies.state, "failed");
  assert.equal(project.dependencies.code, "network_stalled");
});

test("npm's cache holds what a project created before needed: a new one is created without the network", async (t) => {
  const at = place("cache");
  const first = await cli(t, at, ["create", "first-app", "--author", "Tester"]);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.equal(first.json.dependencies, "installed");
  modes.set("@busy-app/create-app", "refuse").set("@busy-app/cli", "refuse");
  t.after(pass);
  const second = await cli(t, at, ["create", "second-app", "--author", "Tester"]);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.equal(second.json.dependencies, "cache");
  assert.match(second.stderr, /Installed from npm's cache: the registry was not reached/);
  assert.ok(existsSync(join(second.json.folder, "node_modules", "@busy-app", "cli", "dist", "index.js")));
  assert.ok(second.ms < 30_000, `it took ${second.ms} ms`);
});

test("an install that was cut off (the app quit) is installed again, though busy-cli is in node_modules", async (t) => {
  const at = place("cut");
  const made = await cli(t, at, ["create", "focus-timer", "--author", "Tester"]);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  const dir = made.json.folder;
  // As a killed npm may leave it: busy-cli there, the rest maybe not; the note says an install ran, by a process that
  // is gone.
  const file = registryFile(at.data);
  const list = JSON.parse(readFileSync(file, "utf8"));
  list.projects[0].deps = { state: "installing", pid: 2 ** 22 + 17, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(list));
  const [project] = await listed(t, at);
  assert.equal(project.dependencies.state, "interrupted");
  const again = await cli(t, at, ["build", dir, "--dependencies-only"]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.json.dependencies, "installed");
  assert.ok(existsSync(join(dir, "node_modules", "@busy-app", "cli", "dist", "index.js")));
  assert.equal((await listed(t, at))[0].dependencies.state, "installed");
});
