// A project fresh from `busy-emulator create`, as an agent gets it (the field test with a real agent, 11.11): its
// settings work out of the box. The command line itself, on a project of the official template with its real
// busy-cli and TypeScript, against a server this test starts (a stand-in of the app's mirror names this process, as
// in test/server/dev.test.mjs). `create` needs the npm registry: the template and its dependencies.
//
// - the template's settings helper, whose loadValues() is always null on the released firmware, is replaced: the app
//   built from the project reads the defaults of its settings.json, and after `settings set … --restart` the value
//   that was saved through the bar's API;
// - the project's AGENTS.md has the emulator's section, and the template's `npm run …` lines are gone;
// - `typecheck` runs the template's TypeScript check on the Node that runs the command line, and names an error's
//   file and line;
// - `build` refuses a settings file the bar would refuse, with the field at fault.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test as nodeTest } from "node:test";

import { SECTION_BEGIN, SECTION_END } from "../../packages/server/projects/template-fixes.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, node, port, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 600_000 }, fn);
const CLI = serverModule(join("cli", "busy-emulator.mjs"));
const ID = "app.emu.settings_e2e";

let folder;
let emulator;
let data;
let home;
let project;
let created;
const lines = [];
const leftovers = [];

function environment() {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BUSY_EMULATOR_/i.test(name)));
  return { ...clean, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port) };
}

/** Runs the command line to its end: { code, json (its last line), stdout, stderr }. */
async function cli(t, words, cwd = project) {
  const child = node(t, [CLI, ...words], { cwd, env: environment(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(300_000);
  let json = null;
  try {
    json = JSON.parse(stdout.trim().split(/\r?\n/).pop());
  } catch {
    // text for a person
  }
  return { code, json, stdout, stderr };
}

const said = (from = 0) => lines.slice(from).filter((line) => line.includes(`${ID} log: settings `)).map((line) => JSON.parse(line.split(`${ID} log: settings `)[1]));
const running = async () => (await get(`${emulator.url}/_emu/state`)).json().running?.id ?? null;

const SETTINGS = {
  format_version: 1,
  version: 1,
  fields: {
    hour24: { type: "boolean", label: "24-hour clock", default: true },
    minutes: { type: "integer", label: "Minutes", default: 25, min: 1, max: 120 },
    theme: { type: "enum", label: "Theme", default: "amber", options: [{ value: "amber", label: "Amber" }, { value: "blue", label: "Blue" }] },
  },
};

before(async () => {
  folder = realpathSync(tempDir({ after: (fn) => leftovers.push(fn) }));
  emulator = await startServer({ port: port(0), dataDir: join(folder, "bar"), barSpeed: false, log: (line) => lines.push(line) });
  data = join(folder, "data");
  mkdirSync(join(data, "run"), { recursive: true });
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
  home = join(folder, "home");
  mkdirSync(home);
  created = await cli({ after: (fn) => leftovers.push(fn) }, ["create", "settings-app", "--author", "Emulator Test", "--id", ID, "--json"], folder);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  project = created.json.folder;
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

test("create puts the template right: the settings helper asks the bar's API, AGENTS.md has the emulator's section", () => {
  assert.deepEqual(created.json.template, { settings_helper: "replaced", agents_md: "added" });
  const helper = readFileSync(join(project, "shared", "settings.ts"), "utf8");
  assert.match(helper, /device\.AppsSettingsGet\(\{ app_id: manifest\.id \}\)/);
  assert.doesNotMatch(helper, /globalThis/);
  const agents = readFileSync(join(project, "AGENTS.md"), "utf8");
  const section = agents.slice(agents.indexOf(SECTION_BEGIN), agents.indexOf(SECTION_END));
  assert.ok(section.length > 500, "the section is there");
  assert.ok(agents.indexOf(SECTION_BEGIN) < agents.indexOf("\n## Firmware API boundary"), "before the template's first section");
  for (const command of ["dev --once", "build", "run", "typecheck", "logs", "screenshot --scale 8", "press ok", "settings get", "settings set hour24=false --restart", "check"]) assert.ok(section.includes(`\`busy-emulator ${command}\``), command);
  // The template's own lines no longer send an agent to npm, or to a helper that saves.
  assert.doesNotMatch(agents, /npm run (build|typecheck|app:install|app:run|app:stop)/);
  assert.doesNotMatch(agents, /persist with `saveValues\(\)`/);
});

test("the project as created passes its type check and builds; a type error is named with its file and line", async (t) => {
  const clean = await cli(t, ["typecheck", "--json"]);
  assert.equal(clean.code, 0, clean.stdout + clean.stderr);
  assert.deepEqual(clean.json.errors, []);
  const main = join(project, "src", "main.ts");
  const source = readFileSync(main, "utf8");
  t.after(() => writeFileSync(main, source));
  writeFileSync(main, `${source}\nconst wrong: number = "text";\n`);
  const failed = await cli(t, ["typecheck", "--json"]);
  assert.deepEqual([failed.code, failed.json.code], [1, "typecheck_failed"], failed.stdout + failed.stderr);
  assert.equal(failed.json.errors[0].file, "src/main.ts");
  assert.equal(failed.json.errors[0].line, source.split("\n").length + 1);
  assert.match(failed.json.errors[0].code, /^TS\d+$/);
});

test("the app reads its settings through the created helper: the file's defaults, then what settings set saved, after --restart", async (t) => {
  writeFileSync(join(project, "src", "appmeta", "settings.json"), JSON.stringify(SETTINGS, null, 2));
  const main = join(project, "src", "main.ts");
  const source = readFileSync(main, "utf8");
  // What an agent writes: loadValues() from @shared/settings, at the start of the app.
  writeFileSync(
    main,
    source
      .replace('import { device } from "@shared/device";', 'import { device } from "@shared/device";\nimport { loadValues } from "@shared/settings";')
      .replace("  void draw(ticks).catch(report);\n", '  void loadValues().then((values) => console.log("settings " + JSON.stringify(values))).catch(report);\n  void draw(ticks).catch(report);\n'),
  );
  assert.match(readFileSync(main, "utf8"), /loadValues\(\)\.then/, "the template's main.ts was changed");
  assert.equal((await cli(t, ["typecheck", "--json"])).code, 0, "the app with the helper passes the type check");

  let from = lines.length;
  const ran = await cli(t, ["dev", "--once", "--json"]);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  assert.equal(ran.json.running, true);
  await until("the app to read its settings", () => said(from).length > 0, 30_000);
  assert.deepEqual(said(from)[0], { hour24: true, minutes: 25, theme: "amber" }, "nothing saved yet: the defaults of settings.json, not null");

  from = lines.length;
  const set = await cli(t, ["settings", "set", "hour24=false", "minutes=50", "theme=blue", "--restart", "--json"]);
  assert.equal(set.code, 0, set.stdout + set.stderr);
  assert.deepEqual([set.json.id, set.json.restarted, set.json.running], [ID, true, true]);
  await until("the app to read the saved settings", () => said(from).length > 0, 30_000);
  assert.deepEqual(said(from)[0], { hour24: false, minutes: 50, theme: "blue" }, "the app read what was saved through the bar's API");
  assert.equal(await running(), ID);

  // The bar's own API holds the same document: what its web page and a real bar's settings screen would show.
  assert.deepEqual((await get(`${emulator.url}/api/apps/settings?app_id=${ID}`)).json(), { version: 1, values: { hour24: false, minutes: 50, theme: "blue" } });
  const stopped = await cli(t, ["stop", "--json"]);
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  await until("the app to stop", async () => (await running()) === null, 30_000);
  // Again, with nothing running: busy-cli's "No app is running." (the bar's 409) is a success that says so.
  const idle = await cli(t, ["stop", "--json"]);
  assert.equal(idle.code, 0, idle.stdout + idle.stderr);
  assert.deepEqual([idle.json.stopped, idle.json.was_running], [false, false]);
});

test("build refuses a settings file the bar would refuse, with the field at fault; dev --once the same", async (t) => {
  const file = join(project, "src", "appmeta", "settings.json");
  t.after(() => writeFileSync(file, JSON.stringify(SETTINGS, null, 2)));
  // What the agent of the field test guessed: fields as a list, the type "select".
  writeFileSync(file, JSON.stringify({ format_version: 1, version: 1, fields: { format: { type: "select", label: "Format", options: ["12", "24"], default: "24" } } }));
  const built = await cli(t, ["build", "--json"]);
  assert.deepEqual([built.code, built.json.code, built.json.field, built.json.problem], [1, "settings_invalid", "format", "unknown type 'select'"], built.stdout + built.stderr);
  const once = await cli(t, ["dev", "--once", "--json"]);
  assert.deepEqual([once.code, once.json.code, once.json.field], [1, "settings_invalid", "format"], once.stdout + once.stderr);
  assert.ok(once.stdout.split(/\r?\n/).some((line) => line.includes('"event":"build_failed"') && line.includes('"tool":"settings.json"')), once.stdout);
});
