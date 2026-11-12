// The bar's address and what goes with it (bar-address): the API documentation at /docs/ as a bar serves it, and
// Restart BUSY Bar (`busy-emulator restart-bar`, the window's button) on a bar an app has hung.
//
//   node --test emulator/test/server/bar-address.test.mjs
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { after, before, test as nodeTest } from "node:test";

import { loadFirmware } from "../../packages/server/firmware.mjs";
import { withServer } from "../../packages/server/api-docs.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, installApp, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 120_000 }, fn);
const CLI = serverModule(join("cli", "busy-emulator.mjs"));

let emulator;
let data;
const leftovers = [];

before(async () => {
  data = realpathSync(tempDir({ after: (fn) => leftovers.push(fn) }));
  emulator = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir: data, barSpeed: false, log: () => {} });
  // What the app writes for the command line: which process the emulator is and where its bar answers.
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

async function cli(t, args) {
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const child = node(t, [CLI, ...args], { cwd: data, env: { ...clean, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  const code = await child.exited(90_000);
  return { code, stdout, json: args.includes("--json") && stdout.trim() ? JSON.parse(stdout.trim().split("\n").pop()) : null };
}

// ---------------------------------------------------------------- /docs

test("/docs: the bar's Swagger UI page and its OpenAPI description, the firmware's own files, offline", async () => {
  const firmware = loadFirmware();
  const moved = await get(`${emulator.url}/docs`);
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.location, "/docs/");
  const page = await get(`${emulator.url}/docs/`);
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /^text\/html/);
  assert.equal(page.text, readFileSync(join(firmware.docs, "index.html"), "utf8"));
  assert.match(page.text, /swagger-ui-bundle\.js/);
  // Scripts and styles gzipped, as the bar gives them.
  const bundle = await get(`${emulator.url}/docs/swagger-ui-bundle.js`);
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers["content-encoding"], "gzip");
  assert.match(bundle.headers["content-type"], /^text\/javascript/);
  assert.match(gunzipSync(bundle.body).toString("utf8", 0, 4000), /SwaggerUI|swagger/i);
  for (const file of ["swagger-ui.css", "swagger-ui-standalone-preset.js", "favicon-32x32.png", "LICENSE", "NOTICE"]) assert.equal((await get(`${emulator.url}/docs/${file}`)).status, 200, file);
  // The description: the firmware's API version, and this emulator as its server ("Try it out" goes here).
  const spec = await get(`${emulator.url}/openapi.yaml`);
  assert.equal(spec.status, 200);
  assert.equal(/^\s+version:\s*([\d.]+)\s*$/m.exec(spec.text)?.[1], firmware.apiVersion);
  assert.match(spec.text, new RegExp(`^servers:\\n  - url: ${emulator.url.replaceAll(".", "\\.")}\\n`, "m"));
  assert.equal(spec.text, withServer(readFileSync(join(firmware.docs, "openapi.yaml"), "utf8"), emulator.url));
  // Nothing else of the folder, nothing around it; the entry's rules hold as for every page of the bar's address.
  for (const path of ["/docs/openapi.yaml", "/docs/swagger-ui-bundle.js.gz", "/docs/..%2Fbuild-info.json", "/docs/%2e%2e/web/index.html"]) {
    const answer = await get(`${emulator.url}${path}`);
    assert.ok(answer.status === 404 || !/swagger|openapi:/i.test(answer.text.slice(0, 200)), path);
  }
  const foreign = await request("GET", `${emulator.url}/docs/`, null);
  assert.equal(foreign.status, 200);
  assert.equal(await refusedFrom("http://evil.example"), 403);
});

/** The status of /docs/ asked with another page's Origin. */
async function refusedFrom(origin) {
  const http = await import("node:http");
  return new Promise((done, fail) => {
    const req = http.request(`${emulator.url}/docs/`, { headers: { Origin: origin, Connection: "close" }, agent: false }, (res) => (res.resume(), done(res.statusCode)));
    req.on("error", fail);
    req.end();
  });
}

test("withServer puts the server entry after info, and at the end when there is no key after it", () => {
  assert.equal(withServer("openapi: 3.1.0\ninfo:\n  title: X\n  version: 1.0.0\n\npaths:\n  /a: {}\n", "http://127.0.0.1:8640"), "openapi: 3.1.0\ninfo:\n  title: X\n  version: 1.0.0\n\nservers:\n  - url: http://127.0.0.1:8640\n    description: BUSY Bar Emulator\n\npaths:\n  /a: {}\n");
  assert.equal(withServer("openapi: 3.1.0\ninfo:\n  title: X\n", "http://127.0.0.1:1"), "openapi: 3.1.0\ninfo:\n  title: X\n\nservers:\n  - url: http://127.0.0.1:1\n    description: BUSY Bar Emulator\n");
});

// ---------------------------------------------------------------- Restart BUSY Bar on a hung bar

const OOM = "app.test.oom";
// Runs for a second, then keeps everything it allocates until the heap is full (test/probes/app.probe.oom).
const OOM_SCRIPT = 'var kept = [];\nsetTimeout(function () {\n  for (;;) kept.push("0123456789abcdef" + kept.length);\n}, 1000);\n';
const HELLO = "app.test.hello";
const HELLO_SCRIPT = 'console.log("hello up");\nsetInterval(function () {}, 1000);\n';

const api = (method, path, body = null) => request(method, `${emulator.url}/api/${path}`, body === null ? null : Buffer.from(body));
const state = async () => (await get(`${emulator.url}/_emu/state`)).json();
const frame = async (display) => (await api("GET", `screen?display=${display}`)).text;

test("restart-bar brings back a bar an app hung, as the firmware's own restart does: apps, settings and name kept", async (t) => {
  await installApp(emulator.url, OOM, OOM_SCRIPT);
  await installApp(emulator.url, HELLO, HELLO_SCRIPT);
  assert.equal((await api("POST", "name", JSON.stringify({ name: "Hung test" }))).status, 200);
  assert.equal((await api("POST", "audio/volume?volume=37")).status, 200);

  // The JS heap fills in the bar's first 30 s: the supervisor's warning, and no key does anything (test/power.mjs).
  assert.equal((await api("POST", `apps/launch?app_id=${OOM}`)).status, 200);
  await new Promise((r) => setTimeout(r, 2500));
  const hung = [await frame(0), await frame(1)];
  await api("POST", "input?key=back");
  await api("POST", "input?key=ok");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(await frame(0), hung[0], "the hung bar takes no keys");
  const before = await state();
  assert.equal(before.running?.id, OOM);

  const done = await cli(t, ["restart-bar", "--json"]);
  assert.equal(done.code, 0, done.stdout);
  assert.equal(done.json.restarted, true);
  assert.equal(done.json.address, `127.0.0.1:${emulator.port}`);
  assert.ok(done.json.ms > 0 && done.json.ms < 30_000, `${done.json.ms} ms`);

  // Up again, as after the firmware's restart (power.mjs "the JS heap fills later"): one boot more, powered, no app,
  // the warning gone; the apps, the bar's name and its volume kept.
  const after = await state();
  assert.equal(after.boots, before.boots + 1);
  assert.equal(after.powered, true);
  assert.equal(after.running, null);
  assert.notEqual(await frame(0), hung[0]);
  assert.equal((await api("GET", "name")).json().name, "Hung test");
  assert.equal((await api("GET", "audio/volume")).json().volume, 37);
  const apps = (await api("GET", "apps/list")).json();
  const ids = (apps.apps ?? apps).map((app) => app.id ?? app.app_id);
  assert.ok(ids.includes(OOM) && ids.includes(HELLO), JSON.stringify(apps));
  assert.match((await api("GET", "status/system")).json().uptime, /^0d 0h 0m [0-9]s$|^00d 00h 00m 0[0-9]s$/);

  // Later launches behave as on a freshly started bar: an app starts and runs, keys reach it.
  assert.equal((await api("POST", `apps/launch?app_id=${HELLO}`)).status, 200);
  await until("the app after the restart", async () => (await state()).running?.id === HELLO);
  assert.equal((await api("POST", "apps/quit")).status, 200);
  await until("the app quit", async () => (await state()).running === null);
});
