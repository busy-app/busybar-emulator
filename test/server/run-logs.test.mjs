// busy-emulator run and logs, the command line itself, against a real server (the release rehearsal's findings): a
// server this test starts and a stand-in of the app's mirror naming this process, as test/server/screenshot.test.mjs
// does. The project's busy-cli is a stand-in that does what busy-cli does over the bar's API (stage, install, launch),
// so no npm registry is needed; the apps are real scripts run by the emulated bar.
//
// - run before install installs the built package and starts the app, and says that it runs;
// - run of a script that throws at once answers app_crashed with the error's first line, exit code 1;
// - logs shows the app's console.log output and the runtime's error; --follow goes on with what comes;
// - logs shows the emulator's own notes, which a bar keeps to itself: a promise rejected with nothing to handle it, and
//   a request of the app that the bar's API refused, with the bar's words; the app goes on as on a bar.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { trustProject } from "../../packages/server/projects/trust.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { targz } from "../package.mjs";
import { finish, get, node, port, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const CLI = serverModule(join("cli", "busy-emulator.mjs"));

let emulator;
let data;
const leftovers = [];

before(async () => {
  data = tempDir({ after: (fn) => leftovers.push(fn) });
  emulator = await startServer({ port: port(0), dataDir: join(data, "bar"), barSpeed: false, log: () => {} });
  mkdirSync(join(data, "run"));
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

/** What busy-cli does for `app install`, `app run` and `app stop`, over the bar's API, in its words. */
const STAND_IN_BUSY_CLI = [
  'import { readFileSync } from "node:fs";',
  // Its words as busy-cli reads them (written so that the check of command lines does not take this file for one).
  `const [, , , name, , address] = ${["process", "argv"].join(".")};`,
  'const id = JSON.parse(readFileSync("src/appmeta/manifest.json", "utf8")).id;',
  "async function post(path, body) {",
  "  const answer = await fetch(`http://${address}${path}`, { method: 'POST', body });",
  "  const text = await answer.text();",
  "  if (!answer.ok) { console.error(`■  The BUSY Bar answered: ${text} (HTTP ${answer.status})`); process.exit(1); }",
  "  return text ? JSON.parse(text) : {};",
  "}",
  'if (name === "install") {',
  "  const staged = await post('/api/apps/stage', readFileSync(`dist/${id}.tgz`));",
  "  await post(`/api/apps/install?install_key=${staged.install_key}`);",
  "  console.log(`◆  Installed ${id}`);",
  '} else if (name === "run") {',
  "  await post(`/api/apps/launch?app_id=${id}`);",
  "  console.log(`◆  Launched ${id}`);",
  "} else {",
  "  await post('/api/apps/quit');",
  "  console.log('◆  Stopped');",
  "}",
].join("\n");

/** A project as create leaves it (trusted, busy-cli installed) whose app is `script`; built unless `built` is false. */
function project(t, id, script, { built = true } = {}) {
  const dir = join(tempDir(t), "my app");
  const cli = join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(join(cli, "dist"), { recursive: true });
  mkdirSync(join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", private: true, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id }));
  writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", type: "module", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(join(cli, "dist", "index.js"), STAND_IN_BUSY_CLI);
  if (built) {
    mkdirSync(join(dir, "dist"));
    writeFileSync(
      join(dir, "dist", `${id}.tgz`),
      targz({
        [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.0.0" }),
        [`${id}/scripts/main.js`]: script,
      }),
    );
  }
  trustProject(data, dir, "created");
  return dir;
}

/** Starts the command line in `cwd`; `done` resolves { code, stdout, stderr, json } when it ends. */
function start(t, args, cwd) {
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const child = node(t, [CLI, ...args], { cwd, env: { ...clean, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port) }, stdio: ["ignore", "pipe", "pipe"] });
  const run = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (text) => (run.stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (run.stderr += text));
  run.done = child.exited(60000).then((code) => ({ code, stdout: run.stdout, stderr: run.stderr, json: args.includes("--json") && run.stdout.trim() ? JSON.parse(run.stdout.trim().split("\n").pop()) : null }));
  return run;
}
const cli = (t, args, cwd) => start(t, args, cwd).done;

const installed = async () => (await get(`${emulator.url}/api/apps/list`)).json().apps.map((app) => app.id);
const running = async () => (await get(`${emulator.url}/_emu/state`)).json().running?.id ?? null;

test("run before install: the built package is installed and the app started; the answer says it is running", async (t) => {
  const id = "app.edges.runs";
  const dir = project(t, id, "console.log('started'); setInterval(function () {}, 1000);");
  assert.ok(!(await installed()).includes(id));
  const ran = await cli(t, ["run", "--json"], dir);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.equal(ran.json.ok, true);
  assert.equal(ran.json.installed, true);
  assert.equal(ran.json.running, true);
  assert.equal(ran.json.exited, null);
  assert.ok((await installed()).includes(id));
  assert.equal(await running(), id);
  assert.ok(ran.json.log.some((line) => line.text === `${id} log: started`), JSON.stringify(ran.json.log));
  const stopped = await cli(t, ["stop", "--json"], dir);
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  await until("the app to stop", async () => (await running()) === null);
});

test("run of a script that throws at once: app_crashed with the first error line; logs shows what it printed and why it stopped", async (t) => {
  const id = "app.edges.throws";
  const dir = project(t, id, "console.log('before the error'); draw();");
  const ran = await cli(t, ["run", "--json"], dir);
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.equal(ran.json.ok, false);
  assert.equal(ran.json.code, "app_crashed");
  assert.match(ran.json.message, /^app\.edges\.throws started on the emulated BUSY Bar and stopped at once: \[JsRunner\] Error running script: ReferenceError: draw is not defined/);
  assert.equal(ran.json.running, false);
  assert.match(ran.json.hint, / logs\. Fix the script/);
  assert.equal(await running(), null);
  // For a person: the same on stderr, exit code 1, and nothing that says "Started".
  const person = await cli(t, ["run"], dir);
  assert.equal(person.code, 1);
  assert.match(person.stderr, /stopped at once: \[JsRunner\] Error running script: ReferenceError: draw is not defined/);
  assert.doesNotMatch(person.stdout, /Started/);

  // logs, from any folder: the app's console.log, the runtime's error, the end of the run.
  const logs = await cli(t, ["logs", "--json"], data);
  assert.equal(logs.code, 0, logs.stdout + logs.stderr);
  const texts = logs.json.lines.map((line) => line.text);
  const printed = texts.lastIndexOf(`${id} log: before the error`);
  assert.ok(printed >= 0, texts.join("\n"));
  assert.match(texts[printed + 1], /^app\.edges\.throws \[JsRunner\] Error running script: ReferenceError: draw is not defined/);
  assert.equal(logs.json.lines[printed + 1].kind, "error");
  assert.match(texts[printed + 2], /^App app\.edges\.throws exited: error running main\.js/);
  assert.match(logs.json.lines[printed].time, /^\d{4}-\d\d-\d\dT/);
  const shown = await cli(t, ["logs", "--lines", "2"], data);
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /^\d\d:\d\d:\d\d  error   app\.edges\.throws \[JsRunner\] Error running script: [^\n]*\n\d\d:\d\d:\d\d  app     App app\.edges\.throws exited: [^\n]*\n\(the latest 2 of \d+ lines; --lines <n> shows more\)\n$/);
});

test("run of a script that ends at once without an error is told so; one that is neither built nor on the BUSY Bar: not_built", async (t) => {
  const ended = await cli(t, ["run", "--json"], project(t, "app.edges.ends", "console.log('once');"));
  assert.equal(ended.code, 0, ended.stdout + ended.stderr);
  assert.equal(ended.json.running, false);
  assert.equal(ended.json.exited, "finished");
  const missing = await cli(t, ["run", "--json"], project(t, "app.edges.nowhere", "", { built: false }));
  assert.equal(missing.code, 1);
  assert.equal(missing.json.code, "not_built");
  assert.match(missing.json.hint, /^Build it first: .* build; then run .* run again\.$/);
});

test("logs --follow: the kept lines, then what an app prints while the command goes on", async (t) => {
  const id = "app.edges.follows";
  const dir = project(t, id, "console.log('said while followed'); setInterval(function () {}, 1000);");
  const follow = start(t, ["logs", "--follow", "--lines", "5", "--json"], data);
  follow.done.catch(() => {});
  // The stream is open once the kept lines are out (the tests before left some).
  await until("the kept lines", () => follow.stdout.includes("\n"));
  assert.doesNotMatch(follow.stdout, /said while followed/);
  const ran = await cli(t, ["run", "--json"], dir);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  await until("the app's line in the followed log", () => follow.stdout.includes("said while followed"));
  const line = follow.stdout.split("\n").map((text) => (text ? JSON.parse(text) : null)).find((one) => one?.text === `${id} log: said while followed`);
  assert.equal(line.kind, "log");
  follow.child.kill();
  await cli(t, ["stop", "--json"], dir);
});

test("logs: the emulator's notes of an unhandled rejection and of a refused API request; the app runs on as on a BUSY Bar", async (t) => {
  const id = "app.edges.mistakes";
  const script = [
    "async function load() { throw new Error('no data'); }",
    "load();",
    "Promise.reject('a plain string');",
    "const caught = Promise.reject(new Error('caught later'));",
    "caught.catch(function () { console.log('caught it'); });",
    "const element = { id: 't', type: 'text', text: 'hi', x: 0, y: 0, z_index: -1, display: 'front' };",
    `fetch('http://localhost/api/display/draw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ application_name: '${id}', elements: [element] }) })`,
    "  .then(function (answer) { console.log('draw answered ' + answer.status); });",
    "setTimeout(function () { console.log('still running'); }, 100);",
    "setInterval(function () {}, 1000);",
  ].join("\n");
  const dir = project(t, id, script);
  const ran = await cli(t, ["run", "--json"], dir);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.equal(ran.json.running, true);
  const texts = async () => (await cli(t, ["logs", "--json"], data)).json.lines.filter((line) => line.text.includes(id));
  await until("the app's line after its mistakes", async () => (await texts()).some((line) => line.text === `${id} log: still running`));
  const lines = await texts();
  const of = (text) => lines.find((line) => line.text === text);
  // The rejections nothing handled, each with its reason and where it came from; the one caught later is not there.
  const thrown = of(`App ${id}: emulator: unhandled rejection: Error: no data, at main.js:1:25 (the BUSY Bar logs nothing for this)`);
  assert.ok(thrown, lines.map((line) => line.text).join("\n"));
  assert.equal(thrown.kind, "error");
  assert.ok(of(`App ${id}: emulator: unhandled rejection: "a plain string", at main.js:3:1 (the BUSY Bar logs nothing for this)`), lines.map((line) => line.text).join("\n"));
  assert.ok(!lines.some((line) => line.text.includes("caught later")));
  assert.ok(of(`${id} log: caught it`));
  // The refusal with the bar's own words, beside what the app got: the same answer as on a bar.
  const refused = of(`App ${id}: emulator: POST /api/display/draw refused: 400 elements[0].z_index value is invalid; must be >= 0 (busy-lib turns this into "Expected a function")`);
  assert.ok(refused, lines.map((line) => line.text).join("\n"));
  assert.equal(refused.kind, "warn");
  assert.ok(of(`${id} log: draw answered 400`));
  assert.equal(await running(), id, "the app runs on");
  await cli(t, ["stop", "--json"], dir);
});
