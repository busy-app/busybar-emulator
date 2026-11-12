// The agent's hands and its way to the person, the command line itself against a real server (the field test with a
// real agent, 11.11): a server this test starts in a data folder of its own and, in the same folder, as in the app, a
// stand-in of the app's mirror that names this process. The apps are real scripts run by the emulated bar; no npm
// registry, no app, no window.
//
// - press: an app's input handler gets the button, the wheel's click, and a long press with --hold;
// - settings get/set/reset: what the command saved through the bar's API is what the app reads after --restart;
// - a settings file the firmware refuses: the bar's own parser (the firmware's code, in the screen module) says the
//   same words about the same field as the emulator's check that `build` uses; `run` is a failure, not "launched";
// - POST /_emu/trust and `busy-emulator trust`: only a program with the server's key may ask, never a page; the
//   answer is the app's (a stand-in for its dialog here) and nothing else; a yes is remembered; after a no the same
//   folder is not asked about again for a while (here a fraction of a second, 30 s in the app); a name the person
//   could not read as it is, is not shown to them; and nothing on the command line trusts a folder, not --trust and
//   not --trust under a pseudo-terminal (the security review of pull request 59).
// - a settings file nested thousands of levels deep is a refused schema (503), not a failure of the server.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { after, before, test as nodeTest } from "node:test";

import { spawnProgram } from "../../packages/engine/programs.mjs";
import { checkSettingsSchema, problemText } from "../../packages/server/projects/settings-schema.mjs";
import { BROKEN } from "../../packages/server/projects/test/settings-cases.mjs";
import { isTrusted, trustProject, TRUST_PATH } from "../../packages/server/projects/trust.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { targz } from "../package.mjs";
import { finish, get, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 120_000 }, fn);
const CLI = serverModule(join("cli", "busy-emulator.mjs"));

let emulator;
let data;
const lines = [];
const leftovers = [];
// What stands in for the app's dialog: the test sets what the person "clicks", and sees what was asked.
const person = { answer: "refuse", asked: [], hold: null, github: () => ({ answer: "unavailable", reason: "no app" }) };
// How long after a "Don't Trust" this test's server does not ask about the same folder again: the app's 30 s. The
// pause is measured by a clock of the test's (trustClock), the computer's moved on by `ahead`: what must fall inside
// the pause (forty questions, two runs of the command line) does whatever the machine's load, and "after the pause"
// is the clock moved past it, not a wait. A pause of 0.5 s, then 4 s, by the computer's clock was missed on a loaded
// machine: the second run came after it and the person was asked again.
const PAUSE_MS = 30_000;
const PAUSE_S = Math.ceil(PAUSE_MS / 1000);
const trustClock = { ahead: 0, now: () => Date.now() + trustClock.ahead };
const afterThePause = async () => {
  trustClock.ahead += PAUSE_MS + 1;
};

before(async () => {
  data = realpathSync(tempDir({ after: (fn) => leftovers.push(fn) }));
  emulator = await startServer({
    port: port(0),
    controlPort: port(0) ? port(1) : 0,
    dataDir: data,
    barSpeed: false,
    log: (line) => lines.push(line),
    trustRefusalPauseMs: PAUSE_MS,
    trustClock: () => trustClock.now(),
    async askPerson(question, signal) {
      if (question.kind === "github") return person.github(question);
      person.asked.push(question);
      if (person.hold) await person.hold(signal);
      return { answer: person.answer };
    },
  });
  writeMirror(data, emulator);
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

/** Writes what the app writes for the command line: which process the emulator is and where its bar answers. */
function writeMirror(dataDir, server) {
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(dataDir, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: server.port, url: server.url, state: "ready", detail: null, since: Date.now() }));
}

/** Runs the command line to its end; returns { code, stdout, stderr, json }. `at`: another emulator than this file's. */
async function cli(t, args, cwd = data, at = { data, port: emulator.port }) {
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const child = node(t, [CLI, ...args], { cwd, env: { ...clean, BUSY_EMULATOR_DATA: at.data, BUSY_EMULATOR_PORT: String(at.port) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(90_000);
  return { code, stdout, stderr, json: args.includes("--json") && stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()) : null };
}

const manifest = (id) => JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.0.0" });

/** Puts an app on the bar: its script, and its settings file when it has one (text as it is). */
async function install(id, script, settings = null) {
  const files = { [`${id}/appmeta/manifest.json`]: manifest(id), ...(settings === null ? {} : { [`${id}/appmeta/settings.json`]: settings }), [`${id}/scripts/main.js`]: script };
  const staged = await request("POST", `${emulator.url}/api/apps/stage`, targz(files));
  assert.equal(staged.status, 200, staged.text);
  const installed = await request("POST", `${emulator.url}/api/apps/install?install_key=${staged.json().install_key}`);
  assert.equal(installed.status, 200, installed.text);
}
const launch = (id) => request("POST", `${emulator.url}/api/apps/launch?app_id=${id}`);
const quit = () => request("POST", `${emulator.url}/api/apps/quit`);
const running = async () => (await get(`${emulator.url}/_emu/state`)).json().running?.id ?? null;
const said = (id, from = 0) => lines.slice(from).filter((line) => line.includes(`${id} log: `)).map((line) => line.split(`${id} log: `)[1]);

// ---------------------------------------------------------------------------------------------------------- press

test("press: the app's input handler gets the button, the wheel's clicks, and a long press with --hold", async (t) => {
  const id = "app.hands.keys";
  await install(id, 'listen("input", function (e) { console.log("key " + e.key + " " + e.action + (e.delta === undefined ? "" : " " + e.delta)); });');
  assert.equal((await launch(id)).status, 200);
  await until("the app to run", async () => (await running()) === id);
  const from = lines.length;

  const ok = await cli(t, ["press", "ok", "--json"]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.deepEqual(ok.json, { ok: true, command: "press", key: "ok", times: 1, hold_ms: null, address: `127.0.0.1:${emulator.port}` });
  await until("the short press", () => said(id, from).includes("key ok short"));

  const wheel = await cli(t, ["press", "up", "--times", "2", "--json"]);
  assert.equal(wheel.code, 0, wheel.stdout + wheel.stderr);
  await until("two clicks of the wheel", () => said(id, from).filter((line) => line.startsWith("key encoder ")).length === 2);
  const down = await cli(t, ["press", "down", "--json"]);
  assert.equal(down.code, 0, down.stdout + down.stderr);
  await until("a click the other way", () => new Set(said(id, from).filter((line) => line.startsWith("key encoder "))).size === 2);

  const held = await cli(t, ["press", "start", "--hold", "700", "--json"]);
  assert.equal(held.code, 0, held.stdout + held.stderr);
  await until("the long press", () => said(id, from).includes("key start long"));
  await until("the release", () => said(id, from).includes("key start release"));
  assert.ok(!said(id, from).includes("key start short"), "a held button is not a short press");
  await quit();
  await until("the app to stop", async () => (await running()) === null);
});

test("press on a BUSY Bar that is powered off: bar_off with how to turn it on; --power-on turns it on, and keys go in again", async (t) => {
  assert.equal((await request("POST", `${emulator.url}/_emu/power?action=off`)).status, 200);
  const powered = async () => (await get(`${emulator.url}/_emu/state`)).json().powered;
  assert.equal(await powered(), false);
  const off = await cli(t, ["press", "ok", "--json"]);
  assert.equal(off.code, 1, off.stdout + off.stderr);
  assert.equal(off.json.code, "bar_off");
  assert.match(off.json.message, /is powered off, so the key ok reached nothing/);
  assert.match(off.json.hint, / press ok --power-on /);
  assert.equal(await powered(), false, "the refused press turned nothing on");
  const on = await cli(t, ["press", "ok", "--power-on", "--json"]);
  assert.equal(on.code, 0, on.stdout + on.stderr);
  assert.deepEqual([on.json.powered_on, on.json.up], [true, true]);
  assert.equal(await powered(), true);
  const again = await cli(t, ["press", "ok", "--json"]);
  assert.equal(again.code, 0, again.stdout + again.stderr);
});

// ------------------------------------------------------------------------------------------------------- settings

const SETTINGS = JSON.stringify({
  format_version: 1,
  version: 1,
  fields: {
    hour24: { type: "boolean", label: "24-hour clock", default: true },
    minutes: { type: "integer", label: "Minutes", default: 25, min: 1, max: 120 },
    theme: { type: "enum", label: "Theme", default: "amber", options: [{ value: "amber", label: "Amber" }, { value: "blue", label: "Blue" }] },
  },
});
// What the settings helper of a created project does (shared/settings.ts): the bar's API, the app's own id.
const READS_SETTINGS = (id) => `fetch("http://localhost/api/apps/settings?app_id=${id}").then(function (r) { return r.json(); }).then(function (d) { console.log("values " + JSON.stringify(d.values)); }); setInterval(function () {}, 1000);`;

test("settings: a value saved with the command is what the app reads after --restart; reset goes back to the file's defaults", async (t) => {
  const id = "app.hands.settings";
  await install(id, READS_SETTINGS(id), SETTINGS);
  const defaults = { hour24: true, minutes: 25, theme: "amber" };

  const got = await cli(t, ["settings", "get", "--app", id, "--json"]);
  assert.equal(got.code, 0, got.stdout + got.stderr);
  assert.deepEqual(got.json.values, defaults, "nothing saved: the defaults of settings.json");

  let from = lines.length;
  const set = await cli(t, ["settings", "set", "hour24=false", "minutes=45", "theme=blue", "--app", id, "--restart", "--json"]);
  assert.equal(set.code, 0, set.stdout + set.stderr);
  assert.deepEqual(set.json.values, { hour24: false, minutes: 45, theme: "blue" });
  assert.deepEqual([set.json.restarted, set.json.running], [true, true]);
  await until("the app to read its settings", () => said(id, from).length > 0);
  assert.deepEqual(JSON.parse(said(id, from)[0].slice("values ".length)), { hour24: false, minutes: 45, theme: "blue" }, "the app read what was saved");
  assert.equal(await running(), id);

  // What the bar refuses is told with the emulated bar's reason, and nothing changes.
  const refused = await cli(t, ["settings", "set", "theme=pink", "--app", id, "--json"]);
  assert.deepEqual([refused.code, refused.json.code], [1, "settings_refused"]);
  assert.match(refused.json.message, /: Invalid value for theme\. Nothing was changed\.$/);
  assert.deepEqual((await cli(t, ["settings", "get", "--app", id, "--json"])).json.values, { hour24: false, minutes: 45, theme: "blue" });

  from = lines.length;
  const reset = await cli(t, ["settings", "reset", "--app", id, "--restart", "--json"]);
  assert.equal(reset.code, 0, reset.stdout + reset.stderr);
  assert.deepEqual(reset.json.values, defaults);
  await until("the app to read the defaults", () => said(id, from).length > 0);
  assert.deepEqual(JSON.parse(said(id, from)[0].slice("values ".length)), defaults);

  // An app without a settings file, and one that is not there.
  await install("app.hands.plain", "setInterval(function () {}, 1000);");
  assert.equal((await cli(t, ["settings", "get", "--app", "app.hands.plain", "--json"])).json.code, "no_settings");
  assert.equal((await cli(t, ["settings", "get", "--app", "app.hands.nowhere", "--json"])).json.code, "not_installed");
  await quit();
  await until("the app to stop", async () => (await running()) === null);
});

// --------------------------------------------------------------------------- a settings file the firmware refuses

test("the firmware's own parser says of each broken settings file what the emulator's check says, about the same field", async () => {
  const id = "app.hands.broken";
  const mismatches = [];
  for (const [fields, field, problem] of BROKEN) {
    const text = JSON.stringify({ format_version: 1, version: 1, fields });
    const own = checkSettingsSchema(text);
    assert.equal(own.ok, false);
    await install(id, "setInterval(function () {}, 1000);", text);
    const from = lines.length;
    // The bar answers the launch with OK and shows "Settings file is invalid." (js_app_launcher_error.c).
    await launch(id);
    const logged = await until(`the firmware's word on ${field}: ${problem}`, () => lines.slice(from).find((line) => line.includes("[JsAppSettings] ")), 5000).catch(() => null);
    const firmware = logged?.split("[JsAppSettings] ")[1] ?? "(the firmware said nothing)";
    if (firmware !== `Field '${field}': ${problem}`) mismatches.push(`${text}\n  firmware: ${firmware}\n  emulator: ${problemText(own)}`);
    assert.equal(await running(), null, "the app was not started");
    // And the bar's API refuses the schema, as a bar's does.
    const api = await get(`${emulator.url}/api/apps/settings?app_id=${id}`);
    assert.equal(api.status, 503, text);
    await quit();
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

/** What busy-cli does for `app install` and `app run`, over the bar's API, in its words (as in run-logs.test.mjs). */
const STAND_IN_BUSY_CLI = [
  'import { readFileSync } from "node:fs";',
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
  "} else await post('/api/apps/quit');",
].join("\n");

/** A project as create leaves it (busy-cli installed, trusted unless told) with a built package of `files`. */
function project(t, id, files, { trusted = true, sourceSettings = null } = {}) {
  const dir = join(realpathSync(tempDir(t)), "my app");
  const busyCli = join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(join(busyCli, "dist"), { recursive: true });
  mkdirSync(join(dir, "src", "appmeta"), { recursive: true });
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", private: true, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id }));
  if (sourceSettings !== null) writeFileSync(join(dir, "src", "appmeta", "settings.json"), sourceSettings);
  writeFileSync(join(busyCli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", type: "module", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(join(busyCli, "dist", "index.js"), STAND_IN_BUSY_CLI);
  writeFileSync(join(dir, "dist", `${id}.tgz`), targz({ [`${id}/appmeta/manifest.json`]: manifest(id), ...files }));
  if (trusted) trustProject(data, dir, "created");
  return dir;
}

test("run: an app whose settings file the BUSY Bar refuses is a failure with the field at fault, not \"launched\"", async (t) => {
  const id = "app.hands.refused";
  const broken = JSON.stringify({ format_version: 1, version: 1, fields: { format: { type: "select", label: "Format", default: "24" } } });
  // The package holds the broken file; the project's source has none (a package built some other way).
  const dir = project(t, id, { [`${id}/appmeta/settings.json`]: broken, [`${id}/scripts/main.js`]: "setInterval(function () {}, 1000);" });
  const ran = await cli(t, ["run", "--json"], dir);
  assert.equal(ran.code, 1, ran.stdout + ran.stderr);
  assert.equal(ran.json.code, "settings_invalid");
  assert.equal(ran.json.message, `${id} was not started: the BUSY Bar refuses the settings file in its package (appmeta/settings.json): Field 'format': unknown type 'select'. The BUSY Bar shows "Settings file is invalid." instead of the app.`);
  assert.equal(await running(), null);
  // The same file in the project's source: refused before anything is sent to the bar, by build's check.
  const withSource = project(t, "app.hands.refused2", { ["app.hands.refused2/scripts/main.js"]: "setInterval(function () {}, 1000);" }, { sourceSettings: broken });
  const early = await cli(t, ["run", "--json"], withSource);
  assert.deepEqual([early.code, early.json.code, early.json.field, early.json.problem], [1, "settings_invalid", "format", "unknown type 'select'"]);
  assert.ok(!(await get(`${emulator.url}/api/apps/list`)).json().apps.some((app) => app.id === "app.hands.refused2"), "nothing was installed");
  const built = await cli(t, ["build", "--json"], withSource);
  assert.deepEqual([built.code, built.json.code, built.json.field], [1, "settings_invalid", "format"]);
  await quit();
});

// ---------------------------------------------------------------------------------------------------------- trust

function ask(folder, { headers = emulator.controlHeaders(), wait = null, method = "POST", base = emulator.control.url } = {}) {
  return new Promise((done, fail) => {
    const url = new URL(`${base}${TRUST_PATH}?folder=${encodeURIComponent(folder)}${wait === null ? "" : `&wait=${wait}`}`);
    const req = http.request(url, { method, agent: false, headers: { Connection: "close", "Content-Length": 0, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode, json: body ? JSON.parse(body) : null, req }));
    });
    req.on("error", fail);
    req.end();
  });
}

function folder(t, name = "stranger") {
  const dir = join(realpathSync(tempDir(t)), name);
  mkdirSync(dir);
  return dir;
}

test("POST /_emu/trust: a program with the key asks, the person's answer decides; a yes is remembered", async (t) => {
  const dir = folder(t);
  person.asked.length = 0;
  person.answer = "refuse";
  const no = await ask(dir);
  assert.deepEqual([no.status, no.json], [200, { trusted: false, answer: "refuse", folder: dir }]);
  assert.deepEqual(person.asked, [{ kind: "trust-folder", path: dir }], "the person was shown the real path");
  assert.equal(isTrusted(data, dir), false);
  // The refusal is written nowhere: once the pause after it is over, the next call asks again.
  await afterThePause();
  person.answer = "trust";
  const yes = await ask(dir);
  assert.deepEqual([yes.status, yes.json], [200, { trusted: true, answer: "trust", folder: dir }]);
  assert.equal(person.asked.length, 2);
  assert.equal(isTrusted(data, dir), true);
  assert.deepEqual(JSON.parse(readFileSync(join(data, "projects", "trusted.json"), "utf8")).projects.filter((entry) => entry.path === dir).map((entry) => entry.how), ["trusted"]);
  // Trusted: nobody is asked again.
  assert.deepEqual((await ask(dir)).json, { trusted: true, answer: "already", folder: dir });
  assert.equal(person.asked.length, 2);
});

test("POST /_emu/trust: after a \"Don't Trust\" the same folder is not put before the person again for a while, however often it is asked", async (t) => {
  const dir = folder(t);
  const other = folder(t, "other");
  person.asked.length = 0;
  person.answer = "refuse";
  assert.equal((await ask(dir)).json.answer, "refuse");
  // The flood of the review: forty questions at once. Not one more dialog.
  for (let n = 0; n < 40; n++) {
    const again = await ask(dir);
    assert.equal(again.status, 429, `question ${n + 2}`);
    assert.ok(again.json.retry_after_s >= 1 && again.json.retry_after_s <= PAUSE_S, `retry_after_s ${again.json.retry_after_s}`);
    assert.match(again.json.error, /^The person chose not to trust .* a moment ago; they are not asked about it again for (\d+) s\.$/);
    assert.equal(Number(/for (\d+) s\.$/.exec(again.json.error)[1]), again.json.retry_after_s);
  }
  assert.equal(person.asked.length, 1, "the person saw one dialog");
  // The same folder by another way to it (a link) is the same folder.
  if (process.platform !== "win32") {
    const link = join(realpathSync(tempDir(t)), "link");
    symlinkSync(dir, link);
    assert.equal((await ask(link)).status, 429);
  }
  // Another folder is another question; a "Trust" would have ended the matter, so only a refusal pauses.
  assert.equal((await ask(other)).status, 200);
  assert.equal(person.asked.length, 2);
  await afterThePause();
  person.answer = "trust";
  assert.deepEqual((await ask(dir)).json, { trusted: true, answer: "trust", folder: dir });
  // The command line says it in its own code, and tells the caller not to ask again. These two runs ask an emulator
  // of their own, as the app runs it: the app's 30 s by the computer's clock, which two runs fall well inside.
  const refusedDir = folder(t, "refused");
  mkdirSync(join(refusedDir, "src", "appmeta"), { recursive: true });
  writeFileSync(join(refusedDir, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  const patientData = realpathSync(mkdtempSync(join(realpathSync(tempDir(t)), "data-")));
  let asked = 0;
  const patient = await startServer({
    port: port(0) ? port(2) : 0,
    controlPort: port(0) ? port(3) : 0,
    dataDir: patientData,
    barSpeed: false,
    log: () => {},
    async askPerson() {
      asked++;
      return { answer: "refuse" };
    },
  });
  try {
    writeMirror(patientData, patient);
    const at = { data: patientData, port: patient.port };
    assert.equal((await cli(t, ["trust", refusedDir, "--json"], data, at)).json.code, "trust_refused");
    const soon = await cli(t, ["trust", refusedDir, "--json"], data, at);
    assert.deepEqual([soon.code, soon.json.code], [1, "trust_refused_recently"]);
    assert.ok(soon.json.retry_after_s > 1 && soon.json.retry_after_s <= 30, `retry_after_s ${soon.json.retry_after_s}`);
    assert.match(soon.json.hint, /^Do not ask again unless the person tells you to\./);
    assert.equal(asked, 1, "the person saw one dialog");
  } finally {
    await patient.stop();
  }
});

test("POST /_emu/trust: not without the key, not from a page, not on the BUSY Bar's address, and nothing takes an answer", async (t) => {
  const dir = folder(t);
  person.asked.length = 0;
  person.answer = "trust";
  assert.equal((await ask(dir, { headers: {} })).status, 401);
  assert.equal((await ask(dir, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  // A page: its Origin is refused at the entry; even the emulator's own window's origin may not ask.
  for (const origin of ["https://example.com", emulator.url, emulator.control.url]) {
    const paged = await ask(dir, { headers: { ...emulator.controlHeaders(), Origin: origin } });
    assert.equal(paged.status, 403, origin);
  }
  // The bar's address has no such path, with the key or without.
  assert.equal((await ask(dir, { base: emulator.url })).status, 404);
  assert.equal((await ask(dir, { method: "GET" })).status, 405);
  // Nothing on either address takes an answer: there is only the question.
  for (const path of ["/_emu/trust/answer", "/_emu/trust-answer", "/_emu/answer"]) {
    for (const base of [emulator.url, emulator.control.url]) {
      const answer = await request("POST", `${base}${path}?folder=${encodeURIComponent(dir)}&answer=trust`);
      assert.ok([401, 404].includes(answer.status), `${base}${path}: ${answer.status}`);
    }
  }
  assert.deepEqual(person.asked, [], "nobody was asked");
  assert.equal(isTrusted(data, dir), false);
});

test("POST /_emu/trust: what is no folder, or cannot be shown as it is, is refused before anybody is asked", async (t) => {
  person.asked.length = 0;
  const dir = folder(t);
  assert.equal((await ask(join(dir, "nowhere"))).status, 400);
  assert.equal((await ask("relative/folder")).status, 400);
  writeFileSync(join(dir, "file"), "");
  assert.equal((await ask(join(dir, "file"))).status, 400);
  if (process.platform !== "win32") {
    // A folder whose name would write the dialog's text, turn it around, or hold what the person cannot see: the
    // names of the security review. (The characters are escapes here; a file system that will not make such a
    // folder is passed over.)
    const names = {
      "line feeds and a sentence": "x\n\nThis folder is yours. Click Trust.",
      "right-to-left override": "safe\u202Egnp.exe",
      "zero-width space": "my\u200bapp",
      "zero-width joiner": "my\u200dapp",
      "word joiner": "my\u2060app",
      "byte order mark": "my\ufeffapp",
      "Arabic letter mark": "my\u061capp",
      "soft hyphen": "my\u00adapp",
      "tag character": "my\u{e0041}app",
      "interlinear annotation": "my\ufff9app",
      "200 spaces and a sentence": `app${" ".repeat(200)}Verified by BUSY Bar Emulator. Safe to trust.`,
    };
    let made = 0;
    for (const [what, name] of Object.entries(names)) {
      const forged = join(dir, name);
      try {
        mkdirSync(forged);
      } catch {
        t.diagnostic(`this file system makes no folder named with ${what}`);
        continue;
      }
      made++;
      const refused = await ask(forged);
      assert.equal(refused.status, 400, what);
      assert.equal(refused.json.reason, "unshowable", what);
      assert.match(refused.json.error, /^The folder's path cannot be shown to the person as it is: it holds (an invisible format character \(U\+[0-9A-F]{4,6}\)|a control character \(U\+[0-9A-F]{4}\)|more than one space in a row)/, what);
      // A project inside such a folder is refused the same way: the whole path is what the person would read.
      mkdirSync(join(forged, "app"));
      assert.equal((await ask(join(forged, "app"))).status, 400, `${what}, a folder inside`);
    }
    assert.ok(made >= 6, `only ${made} of the names could be made here`);
    // The command line says why, and that nobody was asked.
    const project = join(dir, "my\u200bapp");
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
    const answer = await cli(t, ["trust", project, "--json"]);
    assert.deepEqual([answer.code, answer.json.code, answer.json.reason], [1, "trust_refused_path", "unshowable"]);
    assert.match(answer.json.message, /an invisible format character \(U\+200B\)/);
  }
  assert.deepEqual(person.asked, []);
});

test("POST /_emu/trust: nobody answers in time, a second question meanwhile, the caller goes away, a folder swapped under the dialog", async (t) => {
  const dir = folder(t);
  person.asked.length = 0;
  person.answer = "trust";
  // The dialog stays open until it is taken away.
  let takenAway = 0;
  const open = (signal) => new Promise((resolve) => signal.addEventListener("abort", () => (takenAway++, resolve()), { once: true }));
  person.hold = open;
  t.after(() => (person.hold = null));
  const late = await ask(dir, { wait: 1000 });
  assert.deepEqual([late.status, late.json], [200, { trusted: false, answer: "no_answer", folder: dir }]);
  assert.equal(takenAway, 1, "the question was taken away");
  assert.equal(isTrusted(data, dir), false, "a yes that comes after the time is not taken");

  // While one question is open, a second is refused. When the first caller goes away, its question goes with it.
  const first = http.request(`${emulator.control.url}${TRUST_PATH}?folder=${encodeURIComponent(dir)}&wait=60000`, { method: "POST", agent: false, headers: { ...emulator.controlHeaders(), "Content-Length": 0 } });
  first.on("error", () => {});
  first.end();
  await until("the first question to be open", () => person.asked.length === 2);
  const another = folder(t, "another");
  const second = await ask(another);
  assert.equal(second.status, 409);
  assert.match(second.json.error, /^Another question to the person is open in the emulator/);
  assert.equal(person.asked.length, 2, "the second was not shown");
  first.destroy();
  await until("the first question to be taken away", () => takenAway === 2);
  assert.equal(isTrusted(data, dir), false);
  // And the next question is asked.
  person.hold = null;
  person.answer = "refuse";
  await until("the server to take questions again", async () => (await ask(another)).status === 200);

  // A folder replaced while the person looks at the dialog: the yes was for the folder that was there.
  const swapped = folder(t, "swapped");
  person.answer = "trust";
  person.hold = async () => {
    rmSync(swapped, { recursive: true });
    mkdirSync(swapped);
    writeFileSync(join(swapped, "planted"), "");
  };
  const answer = await ask(swapped);
  person.hold = null;
  // The same path, another folder; a file system that gave the new folder the old one's number cannot tell them apart.
  if (answer.json.trusted) t.diagnostic("the file system reused the folder's number; the swap could not be told");
  else assert.deepEqual([answer.json.answer, isTrusted(data, swapped)], ["unavailable", false]);
});

test("a server without the app has nobody to ask: 501, and the command says how the person can trust instead", async (t) => {
  const own = realpathSync(mkdtempSync(join(realpathSync(tempDir(t)), "data-")));
  const plain = await startServer({ port: 0, dataDir: own, barSpeed: false, log: () => {} });
  t.after(() => plain.stop());
  const dir = folder(t);
  const answer = await ask(dir, { headers: plain.controlHeaders(), base: plain.control.url });
  assert.equal(answer.status, 501);
  assert.equal(isTrusted(own, dir), false);
});

test("busy-emulator trust: the person's yes lets build go on; their no leaves the project untrusted; no terminal is needed", async (t) => {
  const id = "app.hands.trusted";
  const dir = project(t, id, { [`${id}/scripts/main.js`]: "setInterval(function () {}, 1000);" }, { trusted: false });
  person.asked.length = 0;
  // As an agent meets it: build refuses, in one line why, and names the command that asks the person.
  const refused = await cli(t, ["run", "--json"], dir);
  assert.equal(refused.json.code, "untrusted_project");
  assert.match(refused.json.message, /is not trusted: it was not created by this emulator's create /);
  assert.match(refused.json.hint, /^Run .* trust (?:\.|"\."): the emulator asks the person, in a dialog on their screen/);
  assert.doesNotMatch(refused.json.hint, /--trust/);

  person.answer = "refuse";
  const no = await cli(t, ["trust", ".", "--json"], dir);
  assert.deepEqual([no.code, no.json.code], [1, "trust_refused"]);
  assert.equal((await cli(t, ["run", "--json"], dir)).json.code, "untrusted_project", "still untrusted");
  // --trust, the option that once trusted a folder from a terminal, trusts nothing.
  assert.equal((await cli(t, ["run", "--trust", "--json"], dir)).json.code, "trust_needs_person");

  await afterThePause();
  person.answer = "trust";
  const yes = await cli(t, ["trust", "--json"], dir);
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.deepEqual([yes.json.trusted, yes.json.asked, yes.json.folder], ["now", true, dir]);
  assert.deepEqual(person.asked.map((question) => question.path), [dir, dir], "asked once for each call, with the real path");
  const ran = await cli(t, ["run", "--json"], dir);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.equal(ran.json.running, true);
  await quit();
  await until("the app to stop", async () => (await running()) === null);
});

// ------------------------------------------------------------ nothing on the command line trusts a folder

/** A stranger's project whose busy-cli leaves a mark when it runs: what build would run once the folder is trusted. */
function strangerWithMark(t) {
  const dir = join(realpathSync(tempDir(t)), "stranger");
  const busyCli = join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(join(busyCli, "dist"), { recursive: true });
  mkdirSync(join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stranger", private: true, devDependencies: { "@busy-app/cli": "*" } }));
  writeFileSync(join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.hands.stranger" }));
  writeFileSync(join(busyCli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "9.9.9", type: "module", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(join(busyCli, "dist", "index.js"), 'import { writeFileSync } from "node:fs";\nwriteFileSync("the-strangers-code-ran", "");\n');
  return { dir, mark: join(dir, "the-strangers-code-ran") };
}

const SCRIPT = "/usr/bin/script";
const noPty = process.platform === "win32" ? "script(1) is not Windows'" : !existsSync(SCRIPT) && `there is no ${SCRIPT}`;

nodeTest("--trust under a pseudo-terminal, with nobody at it, trusts nothing and runs nothing (the review's pty-trust)", { skip: noPty, timeout: 120_000 }, async (t) => {
  const { dir, mark } = strangerWithMark(t);
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const env = { ...clean, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port) };
  // script(1) gives the command a terminal for its standard input and output: once that was "a person at a terminal".
  const words = [CLI, "build", dir, "--trust", "--json"];
  const args = process.platform === "darwin" ? ["-q", "/dev/null", process.execPath, ...words] : ["-qc", [process.execPath, ...words].map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(" "), "/dev/null"];
  const child = spawnProgram(SCRIPT, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (out += text));
  await new Promise((resolve) => child.on("close", resolve));
  // script(1) writes what the terminal echoes ("^D" for the end of its input) before the command's line.
  const line = out.split(/\r?\n/).find((one) => one.includes('{"ok"'));
  assert.ok(line, `the command printed no JSON under script(1): ${out}`);
  const answer = JSON.parse(line.slice(line.indexOf('{"ok"')));
  assert.deepEqual([answer.ok, answer.code], [false, "trust_needs_person"], out);
  assert.match(answer.hint, / trust /);
  assert.equal(existsSync(mark), false, "the stranger's code ran");
  assert.equal(isTrusted(data, dir), false, "the folder was trusted with nobody there");
  // Without the pseudo-terminal the same, and for every command that takes the option.
  for (const name of ["build", "install", "run", "dev", "stop"]) {
    const plain = await cli(t, [name, dir, "--trust", "--json"]);
    assert.deepEqual([plain.code, plain.json.code], [1, "trust_needs_person"], name);
  }
  assert.equal(existsSync(mark), false);
  assert.equal(isTrusted(data, dir), false);
});

// ------------------------------------------------------------------------- a settings file nested without end

test("a settings file of twenty thousand nested groups is a refused schema: 503, and the server goes on (the review's deep-settings)", async (t) => {
  const id = "app.hands.deep";
  const depth = 20_000;
  const deep = `{"format_version":1,"version":1,"fields":{"a":${'{"type":"group","label":"g","fields":{"a":'.repeat(depth)}{"type":"boolean","label":"x","default":true}${"}}".repeat(depth)}}}`;
  await install(id, "setInterval(function () {}, 1000);", deep);
  for (const [method, body] of [["GET", null], ["PUT", Buffer.from('{"version":1,"values":{}}')], ["DELETE", null]]) {
    const answer = await request(method, `${emulator.url}/api/apps/settings?app_id=${id}`, body);
    assert.equal(answer.status, 503, `${method}: ${answer.text.slice(0, 200)}`);
    assert.deepEqual(answer.json(), { error: "Application settings schema is invalid" }, method);
  }
  // The launcher refuses it too, the app does not start, and the bar answers as before.
  await launch(id);
  assert.equal(await running(), null);
  assert.equal((await get(`${emulator.url}/api/status/firmware`)).status, 200);
  assert.equal((await cli(t, ["settings", "get", "--app", id, "--json"])).json.code, "settings_invalid");
  await quit();
});

test("POST /_emu/github: stage 2 of publishing goes to the app and its answer comes back; not without the key, not from a page", async (t) => {
  const questions = [];
  person.github = (question) => (questions.push(question), { answer: "done", value: { ok: true, signedIn: false, revokePage: "https://github.com/settings/applications" } });
  const out = await cli(t, ["publish", "signout", "--json"]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(out.json.revokePage, "https://github.com/settings/applications");
  assert.deepEqual(questions, [{ kind: "github", op: "signout" }]);
  const post = (query, headers) =>
    new Promise((done, fail) => {
      const req = http.request(new URL(`${emulator.control.url}/_emu/github?${query}`), { method: "POST", agent: false, headers: { Connection: "close", "Content-Length": 0, ...headers } }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (chunk) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
      });
      req.on("error", fail);
      req.end();
    });
  assert.equal((await post("op=status", {})).status, 401);
  assert.equal((await post("op=status", { ...emulator.controlHeaders(), Origin: emulator.url })).status, 403);
  assert.equal((await post("op=nothing", emulator.controlHeaders())).status, 400);
  assert.equal(questions.length, 1, "none of these reached the app");
  person.github = () => ({ answer: "unavailable", reason: "no app" });
});

test("POST /_emu/github push and request are asked as the trust question is: a path that can be shown, one question at a time, a pause after Cancel", async (t) => {
  const post = (query, headers = emulator.controlHeaders()) =>
    new Promise((done, fail) => {
      const req = http.request(new URL(`${emulator.control.url}/_emu/github?${query}`), { method: "POST", agent: false, headers: { Connection: "close", "Content-Length": 0, ...headers } }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (chunk) => (body += chunk));
        res.on("end", () => done({ status: res.statusCode, json: body ? JSON.parse(body) : null }));
      });
      req.on("error", fail);
      req.end();
    });
  const dir = folder(t, "publish-asked");
  const questions = [];
  person.github = (question) => (questions.push(question), { answer: "done", value: { ok: false, code: "refused", message: "The person chose Cancel: nothing was sent.", hint: null } });
  t.after(() => (person.github = () => ({ answer: "unavailable", reason: "no app" })));
  // A path that cannot be shown as it is, and one that is not absolute: nobody is asked.
  assert.deepEqual([(await post(`op=push&folder=${encodeURIComponent(`${dir}\u202e`)}`)).json.reason], ["unshowable"]);
  assert.equal((await post("op=push&folder=relative")).status, 400);
  assert.equal(questions.length, 0);
  // Cancel, then the same again at once: 429, not asked; another project, or the other question, is asked.
  assert.deepEqual([(await post(`op=push&folder=${encodeURIComponent(dir)}`)).json.code], ["refused"]);
  const again = await post(`op=push&folder=${encodeURIComponent(dir)}`);
  assert.deepEqual([again.status, again.json.retry_after_s > 0], [429, true]);
  assert.equal((await post(`op=request&folder=${encodeURIComponent(dir)}&ai=none`)).status, 200);
  assert.equal(questions.length, 2);
  // Another spelling of the same folder is the same question, in the same pause (security review F7).
  const spelled = await post(`op=push&folder=${encodeURIComponent(join(dir, "..", "publish-asked"))}`);
  assert.equal(spelled.status, 429);
  const linked = join(dir, "..", "publish-asked-link");
  // A junction on Windows: a symbolic link needs a right a standard user's terminal does not have (Developer Mode off).
  symlinkSync(dir, linked, process.platform === "win32" ? "junction" : undefined);
  assert.equal((await post(`op=push&folder=${encodeURIComponent(linked)}`)).status, 429);
  await afterThePause();
  assert.equal((await post(`op=push&folder=${encodeURIComponent(linked)}`)).status, 200);
  assert.equal(questions.at(-1).folder, dir, "the app is asked about the real path");
  await afterThePause();
  assert.equal((await post(`op=push&folder=${encodeURIComponent(dir)}`)).status, 200, "after the pause it is asked again");
  // Using GitHub CLI's account is asked the same way: Cancel, then a pause (security review F10).
  assert.deepEqual([(await post("op=signin-existing")).json.code], ["refused"]);
  assert.equal((await post("op=signin-existing")).status, 429);
  // While a question is open (a trust question here), a publish question is refused, and the other way round.
  let release;
  person.github = (question) => new Promise((resolve) => (questions.push(question), (release = () => resolve({ answer: "done", value: { ok: true } }))));
  const other = folder(t, "publish-other");
  const open = post(`op=push&folder=${encodeURIComponent(other)}`);
  await until("the publish question to be open", () => Boolean(release));
  const trust = await ask(folder(t, "trust-while-publish"));
  assert.equal(trust.status, 409);
  const second = await post(`op=request&folder=${encodeURIComponent(dir)}&ai=none`);
  assert.equal(second.status, 409);
  release();
  assert.equal((await open).status, 200);
});
