// busy-emulator dev, the command line itself, on a project of the official template with its real busy-cli: the
// development loop against a server this test starts, with a stand-in of the app's mirror naming this process (as
// test/server/screenshot.test.mjs does). The project is made once with `create`, which needs the npm registry (the
// template and its dependencies), as test/server/project-commands.test.mjs does. The command line runs from this tree,
// on the Node that runs the test; the home and the data folder are the test's.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { trustProject } from "../../packages/server/projects/trust.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, node, port, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const CLI = serverModule(join("cli", "busy-emulator.mjs"));
const ID = "app.emu.dev_e2e";
const windows = process.platform === "win32";
// A round on a loaded machine (the gate runs other suites beside this one) can take long.
const WAIT = 90_000;

let folder;
let emulator;
let data;
let home;
let project;
let template; // src/main.ts as the template has it
const leftovers = [];

/** The command line's data folder with the mirror the app would write, naming this process as the app. */
function mirror(dir, server) {
  mkdirSync(join(dir, "run"), { recursive: true });
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(dir, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: server.port, url: server.url, state: "ready", detail: null, since: Date.now() }));
}

function environment(extra = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BUSY_EMULATOR_/i.test(name)));
  return { ...clean, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port), ...extra };
}

/** Starts the command line in `cwd`; `lines` are the lines of its standard output so far, `events` those that are JSON. */
function start(t, words, cwd, env = environment()) {
  const child = node(t, [CLI, ...words], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, stdout: "", stderr: "", lines: [], events: [] };
  let rest = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    run.stdout += text;
    rest += text;
    const whole = rest.split(/\r?\n/);
    rest = whole.pop();
    for (const line of whole) {
      run.lines.push(line);
      try {
        run.events.push(JSON.parse(line));
      } catch {
        // a line for a person
      }
    }
  });
  child.stderr.setEncoding("utf8").on("data", (text) => (run.stderr += text));
  /** Waits for an event that `match` takes, among those from `from` on. */
  run.event = (what, match, from = 0) => until(`${what}\n${run.stdout}\n${run.stderr}`, () => run.events.slice(from).find(match), WAIT);
  run.count = (name) => run.events.filter((event) => event.event === name).length;
  return run;
}

/** Runs the command line to its end: { code, json (its last line), events, stdout, stderr }. */
async function cli(t, words, cwd, env = environment()) {
  const run = start(t, words, cwd, env);
  const code = await run.child.exited(300_000);
  return { code, json: run.events.at(-1) ?? null, events: run.events, stdout: run.stdout, stderr: run.stderr };
}

const front = async (server = emulator) => Buffer.from((await get(`${server.url}/api/screen?display=0`)).text, "base64");
/** The rows of the front display where the template draws its title; its counter is below them. */
const title = (frame) => frame.subarray(0, 9 * 72 * 3).toString("base64");
const lit = (frame) => frame.some((byte) => byte !== 0);
const state = async (server = emulator) => (await get(`${server.url}/_emu/state`)).json().running;
const running = async (server = emulator) => (await state(server))?.id ?? null;
/**
 * The title the app shows, once it has drawn and the picture stands still: after a start the bar shows the launcher's
 * own screens for a moment. Waits until the title is not `other` (the title of the version before).
 */
async function shownTitle(other = null) {
  let seen;
  await until("the app's own frame, standing still", async () => {
    const app = await state();
    if (app?.id !== ID || app.stats.draws < 2) return false;
    const first = title(await front());
    await new Promise((resolve) => setTimeout(resolve, 300));
    seen = await front();
    return lit(seen) && title(seen) === first && first !== other;
  }, WAIT);
  return title(seen);
}

const source = () => join(project, "src", "main.ts");
const save = (text) => writeFileSync(source(), text);
const titled = (word) => template.replace('text: "Hello"', `text: "${word}"`);

before(async () => {
  folder = realpathSync(tempDir({ after: (fn) => leftovers.push(fn) }));
  emulator = await startServer({ port: port(0), dataDir: join(folder, "bar"), barSpeed: false, log: () => {} });
  data = join(folder, "data");
  mirror(data, emulator);
  home = join(folder, "home");
  mkdirSync(home);
  const made = await cli({ after: (fn) => leftovers.push(fn) }, ["create", "dev-app", "--author", "Emulator Test", "--id", ID, "--json"], folder);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  project = made.json.folder;
  template = readFileSync(source(), "utf8");
  assert.ok(template.includes('text: "Hello"'), "the template draws Hello");
});
after(async () => {
  for (const fn of leftovers) await fn();
  await emulator?.stop();
});

test("dev: the first round runs the app; a save makes one round and the new frame; a failed build is told and the loop goes on; the console comes as events", async (t) => {
  save(template);
  const dev = start(t, ["dev", "--json"], project);
  const first = await dev.event("the first round", (event) => event.event === "running");
  assert.equal(first.cycle, 1);
  assert.equal(first.id, ID);
  assert.ok(first.ms >= first.build_ms && first.build_ms > 0 && first.install_ms > 0 && first.run_ms > 0, JSON.stringify(first));
  assert.deepEqual(dev.events.map((event) => event.event), ["watching", "build_started", "installed", "running"]);
  assert.deepEqual(dev.events[1].changed, []);
  const hello = await shownTitle();

  // A save: one round, and the bar shows what was saved; the app's console.log comes as an event.
  let seen = dev.events.length;
  save(titled("Howdy").replace("function main(): void {", 'function main(): void {\n  console.log("said by the app");'));
  const second = await dev.event("the round of the save", (event) => event.event === "running", seen);
  assert.equal(second.cycle, 2);
  assert.deepEqual(dev.events.find((event) => event.event === "build_started" && event.cycle === 2).changed, ["src/main.ts"]);
  const said = await dev.event("the app's console.log", (event) => event.event === "app_log", seen);
  assert.deepEqual({ level: said.level, text: said.text }, { level: "log", text: "said by the app" });
  const howdy = await shownTitle(hello);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(dev.count("build_started"), 2, "the save made exactly one round");
  assert.equal(dev.count("app_exited"), 0, "the end of the replaced run is the loop's own doing, not told");

  // A build that fails: busy-cli's text, nothing installed, the app on the bar as it was, and the loop goes on.
  seen = dev.events.length;
  save(`${titled("Wrong")}\nconst broken = = 1;\n`);
  const failed = await dev.event("the failed build", (event) => event.event === "build_failed", seen);
  assert.equal(failed.cycle, 3);
  assert.equal(failed.tool, "busy-cli build");
  assert.equal(failed.exit_code, 1);
  assert.match(failed.output, /main\.ts/);
  assert.match(failed.output, /broken/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(dev.child.exitCode, null, "the loop goes on");
  assert.equal(dev.events.slice(seen).some((event) => event.event === "installed" || event.event === "running"), false);
  assert.equal(title(await front()), howdy, "the BUSY Bar still shows the last good version");
  assert.equal(await running(), ID);

  // The loop survived: the next save is built and runs. This one throws when it starts: the runtime's error and the
  // end of the run come as events, after the round's own.
  seen = dev.events.length;
  save(`${titled("Later")}\nthrow new Error("thrown at the start");\n`);
  const fourth = await dev.event("the round after the failed one", (event) => event.event === "running", seen);
  assert.equal(fourth.cycle, 4);
  const error = await dev.event("the runtime's error", (event) => event.event === "app_error", seen);
  assert.match(error.text, /thrown at the start/);
  const exited = await dev.event("the end of the run", (event) => event.event === "app_exited", seen);
  assert.equal(exited.crashed, true);
  assert.match(exited.reason, /^error running main\.js: .*thrown at the start/);
  const order = dev.events.slice(seen).map((event) => event.event);
  assert.ok(order.indexOf("running") < order.indexOf("app_error") && order.indexOf("app_error") < order.indexOf("app_exited"), order.join(", "));

  // And a good one again; then Ctrl+C: the watching stops with 0, the app stays.
  seen = dev.events.length;
  save(titled("Again"));
  await dev.event("the good round", (event) => event.event === "running" && event.cycle === 5, seen);
  await until("the app running again", async () => (await running()) === ID, WAIT);
  if (windows) return t.skip("Windows has no signal Node can send a child as Ctrl+C: the half with Ctrl+C ran on macOS and Linux"); // the test's end ends it
  dev.child.kill("SIGINT");
  assert.equal(await dev.child.exited(30_000), 0, dev.stdout + dev.stderr);
  const answer = dev.events.at(-1);
  assert.deepEqual({ ok: answer.ok, command: answer.command, stopped: answer.stopped, rounds: answer.rounds }, { ok: true, command: "dev", stopped: "interrupted", rounds: 5 });
  assert.equal(dev.stderr, "", "--json says nothing on stderr");
  assert.equal(await running(), ID, "Ctrl+C stops the watching, not the app");
});

test("dev for a person: one line for each round with its time, the build's own text when it fails", async (t) => {
  save(titled("Person"));
  const dev = start(t, ["dev"], project);
  await until(`the first round's line\n${dev.stdout}`, () => dev.lines.some((line) => /ready\s+app\.emu\.dev_e2e was started on the BUSY Bar \(\d+\.\d\d s: build \d+\.\d\d s, install \d+\.\d\d s, start \d+\.\d\d s\)/.test(line)), WAIT);
  assert.match(dev.lines[0], /watch\s+.*dev-app \(app\.emu\.dev_e2e\) for the emulated BUSY Bar at 127\.0\.0\.1:\d+\. Ctrl\+C stops watching; the app stays on the BUSY Bar\./);
  const before = dev.lines.length;
  save(`${titled("Person")}\nconst broken = = 1;\n`);
  await until(`the failed build's lines\n${dev.stdout}`, () => dev.lines.slice(before).some((line) => /still watching/.test(line)), WAIT);
  const told = dev.lines.slice(before).join("\n");
  assert.match(told, /build\s+src\/main\.ts changed/);
  assert.match(told, /failed\s+busy-cli build failed with exit code 1:/);
  assert.match(told, /const broken = = 1;/, "busy-cli's own text, with the line of the source");
  assert.equal(dev.child.exitCode, null);
});

test("dev --once: one round and the end; 0 when the app runs, 1 with the tool's words when the build fails, 1 when the app stops at once", async (t) => {
  save(titled("Once"));
  const good = await cli(t, ["dev", "--once", "--json"], project);
  assert.equal(good.code, 0, good.stdout + good.stderr);
  assert.deepEqual(good.events.map((event) => event.event ?? "answer"), ["build_started", "installed", "running", "answer"]);
  assert.deepEqual({ ok: good.json.ok, command: good.json.command, id: good.json.id, running: good.json.running, exited: good.json.exited, errors: good.json.errors }, { ok: true, command: "dev", id: ID, running: true, exited: null, errors: [] });
  assert.equal(good.json.address, `127.0.0.1:${emulator.port}`);
  assert.equal(good.json.package, join(project, "dist", `${ID}.tgz`));
  assert.equal(good.stderr, "");
  const shown = await shownTitle();

  // From another folder, the project named; for a person.
  const named = await cli(t, ["dev", "dev-app", "--once"], folder);
  assert.equal(named.code, 0, named.stdout + named.stderr);
  assert.match(named.stdout, /app\.emu\.dev_e2e is running on the emulated BUSY Bar at 127\.0\.0\.1:\d+: built, installed and started in \d+\.\d\d s\./);

  save(`${titled("Once")}\nconst broken = = 1;\n`);
  const broken = await cli(t, ["dev", "--once", "--json"], project);
  assert.equal(broken.code, 1, broken.stdout);
  assert.deepEqual({ ok: broken.json.ok, code: broken.json.code, tool: broken.json.tool, exit_code: broken.json.exit_code }, { ok: false, code: "tool_failed", tool: "busy-cli build", exit_code: 1 });
  assert.match(broken.json.message, /main\.ts/);
  assert.deepEqual(broken.events.map((event) => event.event ?? "answer"), ["build_started", "build_failed", "answer"]);
  assert.equal(await shownTitle(), shown, "nothing was installed");

  save(`${titled("Once")}\nthrow new Error("thrown at the start");\n`);
  const crashed = await cli(t, ["dev", "--once", "--json"], project);
  assert.equal(crashed.code, 1, crashed.stdout);
  assert.equal(crashed.json.code, "app_crashed");
  assert.match(crashed.json.error, /thrown at the start/);
  assert.match(crashed.json.message, /stopped at once/);
  assert.equal(crashed.json.running, false);
  assert.ok(crashed.events.some((event) => event.event === "app_error" && /thrown at the start/.test(event.text)));
});

test("dev without an emulator: not_running with the hint to start it; an untrusted folder: the trust refusal; no project: not_a_project", async (t) => {
  save(template);
  const other = join(folder, "data-without-emulator");
  mkdirSync(other, { recursive: true });
  for (const words of [["dev", "--json"], ["dev", "--once", "--json"]]) {
    const answer = await cli(t, words, project, environment({ BUSY_EMULATOR_DATA: other, BUSY_EMULATOR_PORT: "1" }));
    // The other data folder does not know the project: its trust is asked first, as with every project command.
    assert.equal(answer.code, 1, answer.stdout);
    assert.equal(answer.json.code, "untrusted_project");
    assert.match(answer.json.hint, /^Run .* trust (?:\.|"\."): the emulator asks the person/);
    assert.deepEqual(answer.events.length, 1, "nothing was built");
  }
  // The same folders, the project trusted there by the person (what their click in the emulator's dialog leaves in
  // the list): now it is the emulator that is missing.
  trustProject(other, project, "trusted");
  const trusting = environment({ BUSY_EMULATOR_DATA: other, BUSY_EMULATOR_PORT: "1" });
  for (const words of [["dev", "--json"], ["dev", "--once", "--json"]]) {
    const answer = await cli(t, words, project, trusting);
    assert.equal(answer.code, 1, answer.stdout);
    assert.equal(answer.json.code, "not_running");
    assert.match(answer.json.hint, / start, then run .* dev/);
    assert.deepEqual(answer.events.length, 1, "nothing was built");
  }
  const nothing = await cli(t, ["dev", "--json"], folder);
  assert.equal(nothing.code, 1);
  assert.equal(nothing.json.code, "not_a_project");
  const usage = await cli(t, ["dev", "a", "b", "--json"], folder);
  assert.equal(usage.code, 2);
  assert.equal(usage.json.code, "usage");
});

test("the emulator quits while dev watches: the command ends with not_running", async (t) => {
  save(template);
  const second = await startServer({ port: port(1), dataDir: join(folder, "bar-2"), barSpeed: false, log: () => {} });
  t.after(() => second.stop());
  const otherData = join(folder, "data-2");
  mirror(otherData, second);
  trustProject(otherData, project, "trusted");
  const env = environment({ BUSY_EMULATOR_DATA: otherData, BUSY_EMULATOR_PORT: String(second.port) });
  const dev = start(t, ["dev", "--json"], project, env);
  await dev.event("the first round", (event) => event.event === "running");
  await until("the app on the second bar", async () => (await running(second)) === ID, WAIT);
  await second.stop();
  assert.equal(await dev.child.exited(30_000), 1, dev.stdout + dev.stderr);
  const answer = dev.events.at(-1);
  assert.equal(answer.code, "not_running");
  assert.match(answer.hint, / start, then run .* dev/);
});
