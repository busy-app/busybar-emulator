// The 3D view's frame at the server (packages/server/stage3d.mjs, ADR-0004, ADR-0012): its files come with a policy
// of their own, a frame without an origin may read them and nothing else, and the device window's stream tells of
// every key the bar takes.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { after, test as nodeTest } from "node:test";

import { WINDOW_POLICY } from "../../packages/server/device-window.mjs";
import { createEntryGuard, STAGE_FRAME_FILES } from "../../packages/server/entry-guard.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { STAGE_FRAME_DIR, STAGE_FRAME_PATH, STAGE_POLICY } from "../../packages/server/stage3d.mjs";
import { finish, port, tempDir } from "./helpers.mjs";

after(finish);
const test = (name, fn) => nodeTest(name, { timeout: 60_000, skip: !existsSync(STAGE_FRAME_DIR) && "this tree has no 3D view (packages/stage)" }, fn);

async function start(t) {
  const emulator = await startServer({ port: port(0), controlPort: port(1), dataDir: tempDir(t), barSpeed: false, log: () => {}, onError: () => {} });
  t.after(() => emulator.stop());
  return emulator;
}

function call(url, { method = "GET", headers = {} } = {}) {
  return new Promise((done, fail) => {
    const req = http.request(url, { method, agent: false, headers: { Connection: "close", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", fail);
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", fail);
    req.end();
  });
}

test("the frame's page comes with the frame's policy, not the window's, and may be framed by the window only", async (t) => {
  const { url } = await start(t);
  const page = await call(`${url}${STAGE_FRAME_PATH}stage.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(page.headers["content-security-policy"], STAGE_POLICY);
  assert.notEqual(STAGE_POLICY, WINDOW_POLICY);
  // What the policy must say, whatever else it says: no source by default, scripts from its own files and
  // WebAssembly, a worker from a blob, its own files for fetch, the window as the only page that may frame it, and
  // a sandbox with scripts and nothing else — no origin, so nothing of the server's is the frame's.
  const directives = Object.fromEntries(STAGE_POLICY.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values.join(" ")]));
  assert.equal(directives["default-src"], "'none'");
  assert.equal(directives["script-src"], "'self' 'wasm-unsafe-eval'");
  assert.equal(directives["worker-src"], "blob:");
  assert.equal(directives["connect-src"], "'self'");
  assert.equal(directives["frame-ancestors"], "'self'");
  assert.equal(directives.sandbox, "allow-scripts");
  assert.doesNotMatch(STAGE_POLICY, /'unsafe-eval'|'unsafe-inline'|\*|https?:|allow-same-origin/);
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  // The page has no code of its own in it: the policy would refuse it.
  assert.doesNotMatch(page.body.toString(), /<script(?![^>]*\bsrc=)[^>]*>|<style|\son[a-z]+=|style=/i);
});

test("the frame's files are served as what they are, and nothing outside its folder is", async (t) => {
  const { url } = await start(t);
  const types = {
    "stage.js": "text/javascript",
    "leds.js": "text/javascript",
    "stage.css": "text/css",
    "scene/bar.json": "application/json",
    "scene/bar.trd": "application/octet-stream",
    "player/tride-web/tride-web.js": "text/javascript",
    "player/tride-web/tride_runtime_api_lite_bg.wasm": "application/wasm",
    "player/filament/filament.wasm": "application/wasm",
    "player/ibl/studio_ibl.ktx": "application/octet-stream",
    "player/LICENSE": "text/plain; charset=utf-8",
    "player/THIRD_PARTY_NOTICES.md": "text/plain; charset=utf-8",
  };
  for (const [file, type] of Object.entries(types)) {
    const answer = await call(`${url}${STAGE_FRAME_PATH}${file}`, { method: "HEAD" });
    assert.equal(answer.status, 200, file);
    assert.equal(answer.headers["content-type"], type, file);
    assert.equal(answer.headers["content-security-policy"], STAGE_POLICY, file);
    assert.ok(Number(answer.headers["content-length"]) > 0, file);
    assert.equal(answer.body.length, 0, `${file}: HEAD has no body`);
  }
  for (const outside of ["", "nothing.js", "..%2Fversions.json", "%2e%2e/%2e%2e/server/server-key.mjs", "player/../../README.md", "scene/%00", "player"]) {
    const answer = await call(`${url}${STAGE_FRAME_PATH}${outside}`);
    assert.notEqual(answer.status, 200, `${STAGE_FRAME_PATH}${outside}`);
  }
  assert.equal((await call(`${url}${STAGE_FRAME_PATH}stage.html`, { method: "POST" })).status, 405);
});

test("a frame without an origin may read the frame's files, and nothing else of the server", async (t) => {
  const { url, control } = await start(t);
  const sandboxed = { Origin: "null" };
  // Its own files: the scripts and what they fetch, across origins (the frame is another origin to everything).
  for (const file of ["stage.js", "player/tride-web/tride_runtime_api_lite_bg.wasm", "scene/bar.trd"]) {
    const answer = await call(`${url}${STAGE_FRAME_PATH}${file}`, { headers: sandboxed });
    assert.equal(answer.status, 200, file);
    assert.equal(answer.headers["access-control-allow-origin"], "*", file);
    assert.equal(answer.headers["cross-origin-resource-policy"], "cross-origin", file);
  }
  // Nothing else: not the API, not the window's own files, not the old paths, not by a path that climbs out, and
  // nothing that changes anything.
  for (const [method, path] of [
    ["GET", "/api/status"],
    ["POST", "/api/input?key=ok"],
    ["GET", "/emulator"],
    ["GET", "/emulator/window.js"],
    ["GET", "/emulator/stage3d/mount.js"],
    ["GET", "/_emu/events"],
    ["POST", "/_emu/key?key=start&action=down"],
    ["GET", `${STAGE_FRAME_PATH}../../window.js`],
    ["GET", `${STAGE_FRAME_PATH}%2e%2e/%2e%2e/%2e%2e/api/status`],
    ["POST", `${STAGE_FRAME_PATH}stage.html`],
    ["PUT", `${STAGE_FRAME_PATH}stage.js`],
    ["DELETE", `${STAGE_FRAME_PATH}scene/bar.trd`],
  ]) {
    const answer = await call(`${url}${path}`, { method, headers: sandboxed });
    assert.equal(answer.status, 403, `${method} ${path}`);
    assert.equal(answer.headers["access-control-allow-origin"], undefined, `${method} ${path}`);
  }
  // Not even the frame's folder's other files, nor its files by another spelling of the path.
  for (const path of ["player/LICENSE", "player/THIRD_PARTY_NOTICES.md", "", "player/", "stage%2ejs", "STAGE.JS"]) {
    const answer = await call(`${url}${STAGE_FRAME_PATH}${path}`, { headers: sandboxed });
    assert.equal(answer.status, 403, `Origin: null, GET ${STAGE_FRAME_PATH}${path}`);
  }
  // A query does not change which file it is.
  assert.equal((await call(`${url}${STAGE_FRAME_PATH}stage.js?v=1`, { headers: sandboxed })).status, 200);
  // A page of another origin is refused for the frame's files as for everything.
  assert.equal((await call(`${url}${STAGE_FRAME_PATH}stage.js`, { headers: { Origin: "https://evil.example" } })).status, 403);
  // The management address knows no such path.
  assert.notEqual((await call(`${control.url}${STAGE_FRAME_PATH}stage.js`, { headers: sandboxed })).status, 200);
});

test("the entry guard's list of the frame's files is exactly the files the frame loads, and admits nothing else with Origin: null", () => {
  const under = (folder, prefix = "") =>
    readdirSync(folder, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? under(path.join(folder, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
  // scene/scene.json is the scene's contract, for the tests and the Tride agent: the frame never loads it.
  const files = under(STAGE_FRAME_DIR).filter((f) => f !== "player/LICENSE" && f !== "player/THIRD_PARTY_NOTICES.md" && f !== "scene/scene.json" && !f.split("/").pop().startsWith("._"));
  assert.deepEqual([...STAGE_FRAME_FILES].sort(), files.sort());
  const { admit } = createEntryGuard();
  const bar = { kind: "bar", port: 9 };
  const req = (method, url) => ({ method, url, rawHeaders: ["Host", "127.0.0.1:9", "Origin", "null"] });
  for (const file of STAGE_FRAME_FILES) {
    assert.equal(admit(bar, req("GET", STAGE_FRAME_PATH + file)).ok, true, file);
    assert.equal(admit(bar, req("HEAD", STAGE_FRAME_PATH + file)).ok, true, file);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) assert.equal(admit(bar, req(method, STAGE_FRAME_PATH + file)).ok, false, `${method} ${file}`);
    assert.equal(admit({ kind: "control", port: 9 }, req("GET", STAGE_FRAME_PATH + file)).ok, false, `control ${file}`);
  }
  for (const url of ["/", "/api/status", "/api/screen?display=0", "/api/input?key=ok", "/_emu/events", "/_emu/key?key=ok&action=down", "/emulator", "/emulator/window.js", "/emulator/stage3d/mount.js", STAGE_FRAME_PATH, `${STAGE_FRAME_PATH}player/LICENSE`, `${STAGE_FRAME_PATH}stage.js/../../../api/status`, `${STAGE_FRAME_PATH}./stage.js`, `${STAGE_FRAME_PATH}player/../stage.js`, `http://127.0.0.1:9${STAGE_FRAME_PATH}stage.js`]) {
    const answer = admit(bar, req("GET", url));
    assert.equal(answer.ok, false, url);
    assert.equal(answer.status, 403, url);
  }
});

test("the window's page loads the 3D view's module, and its stream tells of every key the bar takes", async (t) => {
  const { url } = await start(t);
  const mount = await call(`${url}/emulator/stage3d/mount.js`);
  assert.equal(mount.status, 200);
  assert.equal(mount.headers["content-security-policy"], WINDOW_POLICY);
  assert.match((await call(`${url}/emulator`)).body.toString(), /<script src="\/emulator\/stage3d\/mount\.js"><\/script>/);

  const seen = [];
  const stream = http.get(`${url}/_emu/events`, (res) => {
    let rest = "";
    res.setEncoding("utf8").on("data", (chunk) => {
      const blocks = (rest + chunk).split("\n\n");
      rest = blocks.pop();
      for (const block of blocks) {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        if (event === "key" || event === "hello") seen.push(event === "key" ? JSON.parse(/^data: (.*)$/m.exec(block)[1]) : "hello");
      }
    });
  });
  t.after(() => stream.destroy());
  const wait = async (check, what) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(check(), `${what}: ${JSON.stringify(seen)}`);
  };
  await wait(() => seen.includes("hello"), "the stream opened");
  assert.equal((await call(`${url}/_emu/key?key=start&action=down`, { method: "POST" })).status, 200);
  await wait(() => seen.some((e) => e.key === "start" && e.type === "press"), "Start went down");
  assert.equal((await call(`${url}/_emu/key?key=start&action=up`, { method: "POST" })).status, 200);
  await wait(() => seen.some((e) => e.key === "start" && e.type === "release"), "Start came up");
  assert.equal((await call(`${url}/api/input?key=up`, { method: "POST" })).status, 200);
  await wait(() => seen.some((e) => e.key === "up" && e.type === "press"), "the wheel clicked");
});
