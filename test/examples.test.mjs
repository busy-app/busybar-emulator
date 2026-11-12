// The example apps (examples/<name>): each one is what `busy-emulator create <folder> --example <name>` hands an
// author, so each must be a finished project. The first tests read the examples as they lie in the tree. The last one
// does what an author does, with the command line itself against a server this test starts: create from every
// example, build, install, run, look at the bar, press its controls, stop. It needs the npm registry (the template's
// generator and the project's dependencies), like test/server/project-tools.test.mjs.
//
//   node --test emulator/test/examples.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { EXAMPLES_DIR, listExamples } from "../packages/server/cli/examples.mjs";
import { startServer } from "../packages/server/server.mjs";
import { finish, get, node, port, request, tempDir, until } from "./server/helpers.mjs";

after(finish);

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "packages", "server", "cli", "busy-emulator.mjs");
const NAMES = ["focus-timer", "meeting-cost", "status-board"];
/** The heap the examples ask for, the smallest a bar gives an app it starts (from its command line): 96 KiB. */
const HEAP_KIB = 96;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/** Width, height and color type of a PNG, from its header. */
function pngHeader(file) {
  const bytes = readFileSync(file);
  assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG", file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), depth: bytes[24], color: bytes[25] };
}

test("the examples are the three the documents name, each with a name and a one-line description", () => {
  const examples = listExamples();
  assert.deepEqual(examples.map((example) => example.name), NAMES);
  for (const example of examples) {
    assert.ok(example.title.length > 0 && example.title.length <= 20, example.name);
    assert.ok(example.description.length > 20 && !example.description.includes("\n"), example.name);
  }
});

test("every example is a whole project: manifest, settings whose defaults the schema allows, icons the APPS menu can draw, a README with a picture of each display", () => {
  for (const name of NAMES) {
    const dir = join(EXAMPLES_DIR, name);
    for (const file of ["package.json", "tsconfig.json", ".gitignore", ".nvmrc", "README.md", "types/env.d.ts", "shared/device.ts", "shared/screen.ts", "shared/settings.ts", "src/main.ts"]) {
      assert.ok(existsSync(join(dir, file)), `${name}/${file}`);
    }
    assert.equal(readdirSync(dir).includes("AGENTS.md"), false, `${name}: AGENTS.md comes from the official template when the project is created`);

    const manifest = readJson(join(dir, "src", "appmeta", "manifest.json"));
    assert.match(manifest.id, /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,31}$/, name);
    assert.equal(manifest.format_version, 1);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    // Firmware 1.3.1 speaks API 27.14.0: an example must start on it.
    const [major, minor] = manifest.api_version.split(".").map(Number);
    assert.ok(major < 27 || (major === 27 && minor <= 14), `${name}: api_version ${manifest.api_version}`);
    assert.equal(manifest.heap_size_kib, HEAP_KIB, name);
    const pkg = readJson(join(dir, "package.json"));
    assert.equal(pkg.description, manifest.description, name);
    assert.ok(pkg.devDependencies["@busy-app/cli"], name);

    // The settings page: the firmware refuses a schema whose defaults are outside what it allows.
    const settings = readJson(join(dir, "src", "appmeta", "settings.json"));
    assert.equal(settings.format_version, 1);
    assert.ok(Number.isInteger(settings.version) && settings.version >= 1);
    const fields = Object.entries(settings.fields);
    assert.ok(fields.length >= 5, `${name}: a real settings page`);
    for (const [key, field] of fields) {
      const where = `${name} settings.${key}`;
      assert.match(key, /^[a-z][a-z0-9_]*$/, where);
      assert.ok(field.label && field.label.length <= 32, `${where}: a label the bar's own settings screen can show`);
      // The bar's own settings screen draws labels in its ASCII fonts.
      assert.match(`${field.label}${field.description ?? ""}`, /^[\x20-\x7E]+$/, where);
      if (field.type === "integer") {
        const { min = -2147483648, max = 2147483647, step = 1 } = field;
        assert.ok(Number.isInteger(field.default) && field.default >= min && field.default <= max, where);
        assert.equal((max - min) % step, 0, where);
      } else if (field.type === "string") {
        const length = Buffer.byteLength(field.default);
        assert.ok(length >= (field.min_length ?? 0) && length <= (field.max_length ?? 64), where);
      } else if (field.type === "enum") {
        assert.ok(field.options.length >= 1 && field.options.length <= 32, where);
        assert.ok(field.options.some((option) => option.value === field.default), where);
        assert.equal(new Set(field.options.map((option) => option.value)).size, field.options.length, where);
      } else if (field.type === "color") {
        assert.match(field.default, /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/, where);
      } else {
        assert.equal(field.type, "boolean", where);
        assert.equal(typeof field.default, "boolean", where);
      }
      // What the page offers, the app reads: every field's key is in the app's code.
      assert.ok(readFileSync(join(dir, "src", "main.ts"), "utf8").includes(`"${key}"`), `${where}: main.ts never reads it`);
    }

    // The APPS menu: 8x8 in color on the front; on the back 11x11 gray with alpha, the shape in the alpha channel
    // (the menu paints it in its text color; an opaque picture comes out as a filled square).
    const front = pngHeader(join(dir, "src", "appmeta", "icon_front_8x8.png"));
    assert.deepEqual([front.width, front.height], [8, 8], name);
    assert.ok(front.color === 2 || front.color === 6, `${name}: the front icon is in color`);
    const back = pngHeader(join(dir, "src", "appmeta", "icon_back_11x11.png"));
    assert.deepEqual([back.width, back.height, back.color], [11, 11, 4], name);

    // The README shows each display, from docs/: as the bar gives it (72x16, 160x80) and enlarged for people.
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    for (const [file, width, height] of [["front.png", 72, 16], ["back.png", 160, 80]]) {
      const header = pngHeader(join(dir, "docs", file));
      assert.deepEqual([header.width, header.height], [width, height], `${name}/docs/${file}`);
    }
    const pictures = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]);
    assert.ok(pictures.some((picture) => picture.startsWith("docs/front")) && pictures.some((picture) => picture.startsWith("docs/back")), `${name}: README shows both displays`);
    for (const picture of pictures) assert.ok(existsSync(join(dir, picture)), `${name}: README shows ${picture}`);
  }
});

test("what the examples share is the same in each: the screen and settings helpers and the template's own files", () => {
  for (const file of ["shared/screen.ts", "shared/settings.ts", "shared/device.ts", "types/env.d.ts", "tsconfig.json", ".gitignore", ".nvmrc"]) {
    const [first, ...rest] = NAMES.map((name) => readFileSync(join(EXAMPLES_DIR, name, file), "utf8"));
    for (const other of rest) assert.equal(other, first, file);
  }
});

// ---------------------------------------------------------------- the command line, as an author runs it

/** Runs the command line from the source tree with --json and gives its exit code and its one line of JSON. */
async function cli(t, words, { cwd, data, barPort }) {
  const child = node(t, [CLI, ...words, "--json"], { cwd, env: { ...process.env, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(barPort) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(600000);
  let json = null;
  try {
    json = JSON.parse(stdout.trim().split(/\r?\n/).pop());
  } catch {
    // Not JSON: the assertion that follows shows what it printed.
  }
  return { code, json, stdout, stderr };
}

test("create --examples lists them; an example that does not exist is a wrong call that names the ones there are", async (t) => {
  const folder = realpathSync(tempDir(t));
  const where = { cwd: folder, data: join(folder, "data"), barPort: 9 };
  const listed = await cli(t, ["create", "--examples"], where);
  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  assert.deepEqual(listed.json.examples.map((example) => example.name), NAMES);
  for (const example of listed.json.examples) assert.deepEqual(Object.keys(example), ["name", "title", "description"]);

  const missing = await cli(t, ["create", "x", "--example", "no-such-example"], where);
  assert.equal(missing.code, 2);
  assert.equal(missing.json.code, "usage");
  assert.match(missing.json.message, /no example app "no-such-example": the examples are focus-timer, meeting-cost, status-board/);
  assert.match(missing.json.hint, /create --examples/);
  assert.equal(existsSync(join(folder, "x")), false);
});

test("each example, created with create --example, builds, installs and runs on the bar: it draws, stays within its heap, takes the controls and stops", async (t) => {
  const folder = realpathSync(tempDir(t));
  const lines = [];
  const emulator = await startServer({ port: port(0), dataDir: join(folder, "bar"), log: (line) => lines.push(line) });
  t.after(() => emulator.stop());
  // The command line's data folder, with the mirror the app would write, naming this process as the app
  // (as test/server/project-commands.test.mjs does).
  const data = join(folder, "data");
  mkdirSync(join(data, "run"), { recursive: true });
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
  const where = { cwd: folder, data, barPort: emulator.port };

  const frame = async (display) => (await get(`${emulator.url}/api/screen?display=${display}`)).text;
  const lit = (text) => Buffer.from(text, "base64").some((byte) => byte !== 0);
  const state = async () => (await get(`${emulator.url}/_emu/state`)).json();
  const press = (key) => request("POST", `${emulator.url}/api/input?key=${key}`);
  /** What the server logs when an app's script fails or the app is ended for what it did. */
  const failures = () => lines.filter((line) => /Error running script|exited: error|JS heap overflow|JS fatal error|Uncaught|was refused/.test(line));

  for (const name of NAMES) {
    const made = await cli(t, ["create", name, "--example", name, "--author", "Emulator Test"], where);
    assert.equal(made.code, 0, `create --example ${name}:\n${made.stdout}${made.stderr}`);
    const project = join(folder, name);
    // The project is the example under the identity create gives any new project.
    const id = `app.emulator_test.${name}`;
    assert.equal(made.json.id, id);
    assert.equal(made.json.example, name);
    const example = readJson(join(EXAMPLES_DIR, name, "src", "appmeta", "manifest.json"));
    const manifest = readJson(join(project, "src", "appmeta", "manifest.json"));
    assert.deepEqual(manifest, { ...example, id, author: "Emulator Test" });
    assert.equal(readJson(join(project, "package.json")).author, "Emulator Test");
    assert.equal(readFileSync(join(project, "src", "main.ts"), "utf8"), readFileSync(join(EXAMPLES_DIR, name, "src", "main.ts"), "utf8"));
    assert.ok(existsSync(join(project, "AGENTS.md")), "the template's AGENTS.md stays");
    assert.ok(existsSync(join(project, "docs", "front.png")));
    // The project's own screenshots folder, where the catalog's checks look, starts empty: the pictures of the example are not the author's app.
    assert.equal(existsSync(join(project, "screenshots")), false);

    const built = await cli(t, ["build", name], where);
    assert.equal(built.code, 0, `build ${name}:\n${built.stdout}${built.stderr}`);
    assert.ok(existsSync(join(project, "dist", `${id}.tgz`)));
    const installed = await cli(t, ["install", name], where);
    assert.equal(installed.code, 0, `install ${name}:\n${installed.stdout}${installed.stderr}`);

    // The settings page shows the example's fields with their defaults.
    const settings = (await get(`${emulator.url}/api/apps/settings?app_id=${id}`)).json();
    const schema = readJson(join(EXAMPLES_DIR, name, "src", "appmeta", "settings.json"));
    assert.deepEqual(Object.keys(settings.values), Object.keys(schema.fields), name);
    if (name === "status-board") {
      // Its default address is a public status page; the test asks nothing outside this computer.
      const saved = await request("PUT", `${emulator.url}/api/apps/settings?app_id=${id}`, Buffer.from(JSON.stringify({ version: settings.version, values: { ...settings.values, url: "demo" } })));
      assert.equal(saved.status, 200, saved.text);
    }

    const before = await frame(0);
    const backBefore = await frame(1);
    const ran = await cli(t, ["run", name], where);
    assert.equal(ran.code, 0, `run ${name}:\n${ran.stdout}${ran.stderr}`);
    await until(`${name}'s first frame`, async () => {
      const now = await frame(0);
      return now !== before && lit(now) && (await state()).running?.id === id;
    }, 20000);
    // A few seconds of running: timers fire, the firmware animates, a check or a tick or two happen.
    await sleep(4000);
    assert.deepEqual(failures(), [], `${name} failed on the bar`);
    let now = await state();
    assert.equal(now.running?.id, id, `${name} is still running`);
    assert.ok(lit(await frame(0)), `${name} draws on the front display`);
    assert.notEqual(await frame(1), backBefore, `${name} draws on the back display`);

    // The controls: the wheel and Start are taken without an error, and Start changes what the front display shows.
    const still = await frame(0);
    await press("up");
    await press("start");
    await until(`${name}'s answer to Start`, async () => (await frame(0)) !== still, 10000);
    await press("down");
    await press("ok");
    await sleep(2500);
    assert.deepEqual(failures(), [], `${name} failed after the controls`);
    now = await state();
    assert.equal(now.running?.id, id, `${name} is still running after the controls`);
    assert.ok(now.running.stats.heapPeak <= HEAP_KIB * 1024, `${name}: heap peak ${now.running.stats.heapPeak} of ${HEAP_KIB} KiB`);
    assert.ok(now.running.stats.heapSize <= (HEAP_KIB + 4) * 1024, `${name}: runs on a heap of ${now.running.stats.heapSize}`);

    // Back, short: every example leaves (focus-timer first gives the session up, then leaves).
    await press("back");
    if (name === "focus-timer") {
      await sleep(700);
      assert.equal((await state()).running?.id, id, "the first Back gives the session up");
      await press("back");
    }
    await until(`${name} to leave on Back`, async () => (await state()).running === null, 10000);
    assert.deepEqual(failures(), [], `${name} failed on leaving`);
    assert.ok(lines.some((line) => line.includes(`App ${id} exited: `)), lines.slice(-5).join("\n"));
  }
});
