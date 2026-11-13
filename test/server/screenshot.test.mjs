// busy-emulator screenshot, the command line itself, against a real server: a server this test starts (startServer,
// a data folder of its own) and a stand-in of the app's mirror that names this process, in a data folder the command
// line is pointed at (BUSY_EMULATOR_DATA, read outside a release). No app and no window; nothing of the user's.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { startServer } from "../../packages/server/server.mjs";
import { decodePng, framePixel, pngPixel } from "../../packages/server/capture/test-support.mjs";
import { finish, get, knownPort, node, port, request, serverModule, tempDir } from "./helpers.mjs";

after(finish);

const CLI = serverModule(join("cli", "busy-emulator.mjs"));
const GOLDEN = join(serverModule(""), "..", "..", "test", "golden");
const CHECKER = serverModule(join("capture", "catalog-png.mjs"));

let emulator;
let data;
const leftovers = [];

before(async () => {
  // A data folder of the command line's: the mirror the app would write, naming this process as the app. It goes
  // when the file's tests are over (and with finish() if they stop halfway).
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

/** Runs the command line in `cwd` to its end; returns { code, stdout, stderr, json }. */
async function screenshot(t, args, cwd, { dataDir = data, barPort = emulator.port } = {}) {
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const child = node(t, [CLI, "screenshot", ...args], { cwd, env: { ...clean, BUSY_EMULATOR_DATA: dataDir, BUSY_EMULATOR_PORT: String(barPort) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(60000);
  return { code, stdout, stderr, json: args.includes("--json") && stdout ? JSON.parse(stdout) : null };
}

/** Draws a scene recorded on a bar (test/golden) and waits until the displays show it. */
async function showGolden(name) {
  const golden = JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), "utf8"));
  await request("DELETE", `${emulator.url}/api/display/draw?application_name=capture`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const drawn = await request("POST", `${emulator.url}/api/display/draw`, Buffer.from(JSON.stringify({ application_name: "capture", priority: 100, elements: golden.elements })));
  assert.equal(drawn.status, 200, drawn.text);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { front: Buffer.from(golden.front, "base64"), back: Buffer.from(golden.back, "base64") };
}

function assertPixels(file, name, frame, scale = 1) {
  const image = decodePng(readFileSync(file));
  assert.deepEqual(image.chunks, ["IHDR", "IDAT", "IEND"]);
  const width = name === "front" ? 72 : 160;
  const height = name === "front" ? 16 : 80;
  assert.equal(image.width, width * scale);
  assert.equal(image.height, height * scale);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const want = framePixel(name, frame, Math.floor(x / scale), Math.floor(y / scale));
      const got = pngPixel(image, x, y);
      if (got.join() !== want.join()) assert.fail(`${file}: pixel (${x}, ${y}) is ${got}, the frame has ${want}`);
    }
  }
}

test("the file's pixels are the frame GET /api/screen gives and the BUSY Bar's own recording of the scene", async (t) => {
  const cwd = tempDir(t);
  for (const [scene, name] of [["text-color-center", "front"], ["back-text", "back"]]) {
    const golden = await showGolden(scene);
    const shot = await screenshot(t, [...(name === "back" ? ["--back"] : []), "--scale", "4", "--json"], cwd);
    assert.equal(shot.code, 0, shot.stdout + shot.stderr);
    assert.equal(shot.stderr, "");
    const { json } = shot;
    assert.equal(realpathSync(json.file), realpathSync(join(cwd, "screenshots", `${name}-1.png`)));
    const api = Buffer.from((await get(`${emulator.url}/api/screen?display=${name === "front" ? 0 : 1}`)).text, "base64");
    assertPixels(json.file, name, api);
    assertPixels(json.file, name, golden[name]);
    assertPixels(json.scaled.file, name, golden[name], 4);
    assert.equal(json.replaced, false);
    if (existsSync(CHECKER)) assert.deepEqual(json.catalog, { verdict: "pass", id: name === "front" ? "screenshot_png" : "back_screenshot_png", note: null, message: null });
    else assert.equal(json.catalog, null);
  }
  assert.deepEqual(readdirSync(join(cwd, "screenshots")).sort(), ["back-1.png", "back-1@4x.png", "front-1.png", "front-1@4x.png"]);
});

test("--out with spaces and letters outside Latin, and the text a person reads", async (t) => {
  const cwd = tempDir(t);
  const golden = await showGolden("text-color-center");
  // Letters outside Latin whose decomposed form is the same (no accents): macOS lists names on exFAT decomposed, and
  // the shared clean-up of the tests' folders removes by the listed name.
  const out = join("ΛΗΨΕΙΣ 画面", "front shot.png");
  const shot = await screenshot(t, ["--out", out], cwd);
  assert.equal(shot.code, 0, shot.stderr);
  assert.equal(shot.stderr, "");
  // The command line's folder is the real one: the temporary folder on macOS is behind a link (/var → /private/var).
  const file = join(realpathSync(cwd), out);
  assertPixels(file, "front", golden.front);
  const lines = shot.stdout.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], `Saved the front display, 72x16 px: ${file}`);
  assert.equal(lines[1], existsSync(CHECKER) ? "The catalog takes it as a front screenshot (its check screenshot_png)." : "This copy of the emulator does not have the catalog's rules: the file was not checked against them.");
  assert.equal(lines.length, 2);
});

test("a wrong call ends with exit code 2 and writes nothing; a BUSY Bar that is off, with 1 and says so", async (t) => {
  const cwd = tempDir(t);
  const wrong = await screenshot(t, ["--scale", "0", "--json"], cwd);
  assert.equal(wrong.code, 2);
  assert.equal(wrong.json.code, "usage");
  assert.deepEqual(readdirSync(cwd), []);
  const off = await request("POST", `${emulator.url}/_emu/power?action=off`);
  assert.equal(off.status, 200, off.text);
  t.after(() => request("POST", `${emulator.url}/_emu/power?action=on`));
  const dark = await screenshot(t, ["--json"], cwd);
  assert.equal(dark.code, 1);
  assert.equal(dark.json.code, "screen_failed");
  assert.match(dark.json.message, /answered 503 \(The emulated BUSY Bar is powered off/);
  assert.deepEqual(readdirSync(cwd), []);
});

test("screenshots taken at the same moment into one folder each get a name of their own", async (t) => {
  const cwd = tempDir(t);
  const shots = await Promise.all(Array.from({ length: 6 }, () => screenshot(t, ["--scale", "2", "--json"], cwd)));
  for (const shot of shots) assert.equal(shot.code, 0, shot.stdout + shot.stderr);
  const files = shots.map((shot) => shot.json.file).sort();
  assert.equal(new Set(files).size, 6, files.join("\n"));
  const names = Array.from({ length: 6 }, (_, i) => [`front-${i + 1}.png`, `front-${i + 1}@2x.png`]).flat().sort();
  assert.deepEqual(readdirSync(join(cwd, "screenshots")).sort(), names, "six files and their copies, nothing else");
});

test("no emulator running: not_running, exit code 1, nothing started or written", async (t) => {
  const cwd = tempDir(t);
  // A data folder with no mirror, and a port nothing listens on.
  const shot = await screenshot(t, ["--json"], cwd, { dataDir: tempDir(t), barPort: await knownPort(1) });
  assert.equal(shot.code, 1, shot.stdout + shot.stderr);
  assert.equal(shot.json.code, "not_running");
  assert.match(shot.json.hint, / start, open your app on the BUSY Bar, then take the screenshot\.$/);
  assert.deepEqual(readdirSync(cwd), []);
});
