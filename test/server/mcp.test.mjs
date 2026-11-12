// busy-emulator mcp, the command line's MCP server, as a chat client meets it: the command started as a process, MCP
// spoken on its stdin and stdout, against a server this test starts (a stand-in of the app's mirror names this
// process, as in test/server/run-logs.test.mjs). The project is made by the real generator, and built by its real
// busy-cli: `create_app` needs the npm registry, as test/server/created-project.test.mjs does.
//
// - initialize, tools/list, then tools/call: status, create_app, build, run, screenshot (an image block that is a
//   PNG of the display's size, enlarged), stop;
// - a folder the emulator did not create is refused with untrusted_project and the instruction for the person; an
//   emulator that is not running is not_running;
// - what is not MCP (no JSON, an unknown method, wrong params) gets JSON-RPC's errors, and the server goes on;
// - stdout carries only JSON-RPC messages, and the server ends with 0 when stdin ends.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test as nodeTest } from "node:test";

import { startServer } from "../../packages/server/server.mjs";
import { finish, knownPort, node, port, serverModule, tempDir } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 600_000 }, fn);
const CLI = serverModule(join("cli", "busy-emulator.mjs"));
const ID = "app.emu.mcp_e2e";

let folder;
let emulator;
let data;
let home;
let client;
const leftovers = [];
const later = { after: (fn) => leftovers.push(fn) };

function environment(more = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BUSY_EMULATOR_/i.test(name)));
  return { ...clean, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port), ...more };
}

/** `busy-emulator mcp` as a process, and a client of it: request(), notify(), raw() and close(). */
function mcp(t, env) {
  const child = node(t, [CLI, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const waiting = new Map();
  const unaddressed = [];
  const unaddressedWaiters = [];
  let stderr = "";
  let rest = "";
  let next = 1;
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  child.stdout.setEncoding("utf8").on("data", (text) => {
    rest += text;
    let end;
    while ((end = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, end);
      rest = rest.slice(end + 1);
      lines.push(line);
      const message = JSON.parse(line); // anything on stdout that is no JSON fails the test here
      assert.equal(message.jsonrpc, "2.0", line);
      if (message.id === null) {
        const waiter = unaddressedWaiters.shift();
        if (waiter) waiter(message);
        else unaddressed.push(message);
      } else waiting.get(message.id)?.(message);
    }
  });
  const send = (value) => child.stdin.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  return {
    child,
    lines,
    stderr: () => stderr,
    request(method, params) {
      const id = next++;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      return answer;
    },
    notify: (method, params) => send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    /** A line as it is; the answer with id null it gets. */
    raw(text) {
      const answer = unaddressed.length ? Promise.resolve(unaddressed.shift()) : new Promise((resolve) => unaddressedWaiters.push(resolve));
      send(text);
      return answer;
    },
    async call(name, args) {
      const answer = await this.request("tools/call", { name, arguments: args });
      assert.ok(answer.result, `${name}: ${JSON.stringify(answer)}\n${stderr}`);
      return answer.result;
    },
    async close() {
      child.stdin.end();
      return child.exited(30_000);
    },
  };
}

async function initialized(t, env) {
  const one = mcp(t, env);
  const answer = await one.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "emulator-test", version: "1" } });
  assert.equal(answer.result.protocolVersion, "2025-11-25");
  one.notify("notifications/initialized");
  return one;
}

/** Width and height of a PNG, from its IHDR. */
function pngSize(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG signature");
  assert.equal(bytes.subarray(12, 16).toString("latin1"), "IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

before(async () => {
  folder = realpathSync(tempDir(later));
  emulator = await startServer({ port: port(0), dataDir: join(folder, "bar"), barSpeed: false, log: () => {} });
  data = join(folder, "data");
  mkdirSync(join(data, "run"), { recursive: true });
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
  home = join(folder, "home");
  mkdirSync(home);
  client = await initialized(later, environment());
});
after(async () => {
  await client?.close().catch(() => {});
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

test("tools/list: every tool with a description and an object schema; status says the emulator runs", async () => {
  const listed = await client.request("tools/list");
  const names = listed.result.tools.map((tool) => tool.name);
  for (const name of ["status", "start", "create_app", "list_examples", "projects", "build", "run", "refresh", "stop", "logs", "screenshot", "press", "settings_get", "settings_set", "check", "submit"]) {
    assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
  }
  assert.ok(!names.some((name) => /trust/.test(name)), "no tool trusts");
  assert.ok(!names.some((name) => /allow|local|port/.test(name)), "no tool opens a port of this computer");
  for (const tool of listed.result.tools) {
    assert.ok(tool.description.length > 40, tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
  }
  const status = await client.call("status", {});
  assert.equal(status.isError, false);
  assert.equal(status.structuredContent.running, true);
  assert.equal(status.structuredContent.port, emulator.port);
  assert.match(status.content[0].text, /^The emulator is running/);
});

test("create_app, build, run, screenshot: the app runs on the bar and the picture is the front display, enlarged", async () => {
  const target = join(folder, "projects", "mcp-app");
  mkdirSync(join(folder, "projects"));
  const created = await client.call("create_app", { folder: target, author: "Emulator Test", id: ID, name: "MCP Test" });
  assert.equal(created.isError, false, created.content[0].text);
  assert.equal(created.structuredContent.folder, target);
  assert.equal(created.structuredContent.id, ID);

  const projects = await client.call("projects", {});
  assert.deepEqual(projects.structuredContent.projects.map((one) => [one.folder, one.how, one.present]), [[target, "created", true]]);

  const built = await client.call("build", { folder: target });
  assert.equal(built.isError, false, built.content[0].text);
  assert.ok(readdirSync(join(target, "dist")).includes(`${ID}.tgz`));

  const ran = await client.call("run", { folder: target });
  assert.equal(ran.isError, false, ran.content[0].text);
  assert.equal(ran.structuredContent.running, true, ran.content[0].text);

  const shot = await client.call("screenshot", { folder: target });
  assert.equal(shot.isError, false, shot.content[0].text);
  const image = shot.content.find((block) => block.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(pngSize(Buffer.from(image.data, "base64")), { width: 72 * 8, height: 16 * 8 });
  assert.equal(shot.structuredContent.scaled.file, join(target, "screenshots", "front-1@8x.png"));
  assert.equal(shot.structuredContent.file, join(target, "screenshots", "front-1.png"));

  const back = await client.call("screenshot", { display: "back", scale: 1 });
  assert.equal(back.isError, false, back.content[0].text);
  assert.deepEqual(pngSize(Buffer.from(back.content[1].data, "base64")), { width: 160, height: 80 });
  assert.equal(back.structuredContent.file, join(data, "mcp", "screenshots", "back-1.png"));

  const stopped = await client.call("stop", { folder: target });
  assert.equal(stopped.isError, false, stopped.content[0].text);
});

test("a model cannot read a service of this computer through an app: no allow_local, the request is refused, a sensitive header is hidden", async (t) => {
  // The chain a security pass found (the model alone, no person): create_app from status-board, allow_local on a port
  // of this computer, refresh, settings_set with that port's URL, a JSON field and a header, restart, then logs gave
  // the field's value. Now there is no tool to allow the port, the app's request is refused before it connects (so
  // a port that listens and one that does not look the same: no port scan either), and settings_get hides the header.
  const asked = [];
  const service = createServer((request, response) => {
    asked.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ token: `SECRET-${request.headers["x-probe"]}` }));
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  t.after(() => service.close());
  const local = service.address().port;

  const allow = await client.request("tools/call", { name: "allow_local", arguments: { port: local } });
  assert.equal(allow.error?.code, -32602, JSON.stringify(allow));

  const target = join(folder, "projects", "status-probe");
  mkdirSync(join(folder, "projects"), { recursive: true });
  const created = await client.call("create_app", { folder: target, example: "status-board", author: "Emulator Test", id: "app.emu.status_probe" });
  assert.equal(created.isError, false, created.content[0].text);
  const refreshed = await client.call("refresh", { folder: target });
  assert.equal(refreshed.isError, false, refreshed.content[0].text);
  const set = await client.call("settings_set", { folder: target, restart: true, values: { url: `http://127.0.0.1:${local}/`, field: "token", header: "X-Probe: viaHeader", interval: 5 } });
  assert.equal(set.isError, false, set.content[0].text);
  assert.equal(set.structuredContent.values.header, "(hidden)");
  assert.equal(set.structuredContent.values.url, `http://127.0.0.1:${local}/`);
  const got = await client.call("settings_get", { folder: target });
  assert.equal(got.structuredContent.values.header, "(hidden)");
  assert.doesNotMatch(JSON.stringify(got), /viaHeader/);

  let lines = [];
  for (let i = 0; i < 40 && !lines.some((line) => /was refused/.test(line)); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    lines = (await client.call("logs", { lines: 200 })).structuredContent.lines.map((line) => line.text);
  }
  assert.ok(lines.some((line) => line.includes(`its request to http://127.0.0.1:${local} was refused`) && line.includes(`busy-emulator allow-local ${local}`)), lines.join("\n"));
  assert.ok(!lines.some((line) => /SECRET/.test(line)), lines.join("\n"));
  assert.deepEqual(asked, [], "the service was never asked");
  await client.call("stop", { folder: target });
});

test("a folder the emulator did not create: untrusted_project, for check too, with the person's command and no way around it", async () => {
  const stranger = join(folder, "stranger");
  mkdirSync(join(stranger, "src", "appmeta"), { recursive: true });
  writeFileSync(join(stranger, "package.json"), JSON.stringify({ name: "x", private: true, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(join(stranger, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.emu.stranger" }));
  for (const name of ["build", "check", "refresh"]) {
    const refused = await client.call(name, { folder: stranger });
    assert.equal(refused.isError, true, name);
    assert.equal(refused.structuredContent.code, "untrusted_project", name);
    assert.equal(refused.structuredContent.reason, "unknown_folder");
    assert.match(refused.structuredContent.mcp_hint, / trust .*stranger/);
    assert.match(refused.content[0].text, /^untrusted_project: /);
  }
  const relative = await client.call("build", { folder: "stranger" });
  assert.equal(relative.structuredContent.code, "usage");
  assert.match(relative.structuredContent.message, /absolute path/);
});

test("an emulator that is not running: not_running, with start in the hint", async (t) => {
  const empty = tempDir(t);
  const closed = await knownPort(9);
  const alone = await initialized(t, environment({ BUSY_EMULATOR_DATA: empty, BUSY_EMULATOR_PORT: String(closed) }));
  const shot = await alone.call("screenshot", {});
  assert.equal(shot.isError, true);
  assert.equal(shot.structuredContent.code, "not_running");
  assert.match(shot.structuredContent.hint, / start/);
  const status = await alone.call("status", {});
  assert.equal(status.structuredContent.running, false);
  assert.equal(await alone.close(), 0);
});

test("what is not MCP gets JSON-RPC's errors and the server goes on; stdout holds only JSON-RPC; it ends with stdin", async (t) => {
  const one = mcp(t, environment());
  // Before initialize: only initialize, ping and server/discover.
  assert.equal((await one.request("tools/list")).error.code, -32600);
  assert.equal((await one.raw("{not json")).error.code, -32700);
  assert.equal((await one.raw("[1, 2]")).error.code, -32600);
  assert.equal((await one.raw('{"jsonrpc":"1.0","method":"ping"}')).error.code, -32600);
  assert.deepEqual((await one.request("ping")).result, {});
  const init = await one.request("initialize", { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "old", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-11-25", "a version it does not have: its own latest");
  assert.ok(init.result.capabilities.tools);
  assert.equal((await one.request("initialize", {})).error.code, -32602);
  assert.equal((await one.request("tools/unknown")).error.code, -32601);
  assert.equal((await one.request("tools/call", {})).error.code, -32602);
  assert.equal((await one.request("tools/call", { name: "no_such_tool" })).error.code, -32602);
  assert.equal((await one.request("tools/call", { name: "status", arguments: [1] })).error.code, -32602);
  assert.equal((await one.request("tools/call", "status")).error.code, -32602);
  const wrong = await one.request("tools/call", { name: "press", arguments: { key: "left" } });
  assert.equal(wrong.result.isError, true);
  assert.equal(wrong.result.structuredContent.code, "usage");
  const extra = await one.request("tools/call", { name: "status", arguments: { folder: "/" } });
  assert.equal(extra.result.structuredContent.code, "usage");
  // The modern era: per-request version, server/discover, resultType.
  const modern = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "new", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } };
  const discovered = await one.request("server/discover", modern);
  assert.deepEqual(discovered.result.supportedVersions, ["2026-07-28"]);
  assert.equal(discovered.result.resultType, "complete");
  const status = await one.request("tools/call", { ...modern, name: "status", arguments: {} });
  assert.equal(status.result.resultType, "complete");
  assert.equal(status.result.structuredContent.running, true);
  const unsupported = await one.request("ping", { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } });
  assert.equal(unsupported.error.code, -32022);
  // Resources.
  const resources = await one.request("resources/list");
  assert.deepEqual(resources.result.resources.map((one) => one.uri), ["busy-emulator://guide/start", "busy-emulator://guide/project"]);
  const read = await one.request("resources/read", { uri: "busy-emulator://guide/project" });
  assert.match(read.result.contents[0].text, /settings\.json/);
  assert.equal((await one.request("resources/read", { uri: "file:///etc/passwd" })).error.code, -32002);
  // Still serving.
  assert.equal((await one.call("status", {})).structuredContent.running, true);
  assert.equal(await one.close(), 0);
  for (const line of one.lines) assert.doesNotThrow(() => JSON.parse(line), line);
  assert.match(one.stderr(), /busy-emulator mcp: serving/);
});
