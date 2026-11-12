// busy-emulator allow-local, the command line itself, against a real server (EMU-256): a server this test starts in
// a data folder of its own, and in the same folder — as in the app — a stand-in of the app's mirror that names this
// process. The command line is pointed at the folder (BUSY_EMULATOR_DATA, read outside a release) and finds the
// server's management address and key there. No app and no window; nothing of the user's.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, before, test as nodeTest } from "node:test";

import { startServer } from "../../packages/server/server.mjs";
import { finish, installApp, knownPort, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 120_000 }, fn);
const CLI = serverModule(join("cli", "busy-emulator.mjs"));

let emulator;
let data;
const lines = [];
const leftovers = [];

before(async () => {
  data = tempDir({ after: (fn) => leftovers.push(fn) });
  emulator = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir: data, barSpeed: false, log: (line) => lines.push(line) });
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

/** A service of the author's on this computer: answers "ok", counts the connections that reach it. */
async function service(t) {
  const it = { connections: 0 };
  it.server = net.createServer((socket) => {
    it.connections++;
    socket.on("error", () => {});
    socket.on("data", (chunk) => chunk.includes("\r\n\r\n") && socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
  });
  await new Promise((resolve) => it.server.listen(port(2), "127.0.0.1", resolve));
  it.port = it.server.address().port;
  t.after(() => new Promise((resolve) => it.server.close(resolve)));
  return it;
}

/** Runs `busy-emulator allow-local …` to its end; returns { code, stdout, stderr, json }. */
async function allowLocal(t, args, { dataDir = data, barPort = emulator.port } = {}) {
  const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
  const child = node(t, [CLI, "allow-local", ...args], { env: { ...clean, BUSY_EMULATOR_DATA: dataDir, BUSY_EMULATOR_PORT: String(barPort) }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(60000);
  return { code, stdout, stderr, json: args.includes("--json") && stdout ? JSON.parse(stdout) : null };
}

/** Runs an app that fetches `url` and logs what it got: { status, text } or { error }. */
async function appFetch(id, url) {
  const script = `
fetch(${JSON.stringify(url)}).then(function (r) { return r.text().then(function (text) { console.log("got " + JSON.stringify({ status: r.status, text: text.slice(0, 20) })); }); },
  function (e) { console.log("got " + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) })); });
setInterval(function () {}, 1000);`;
  await installApp(emulator.url, id, script);
  assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=${id}`)).status, 200);
  const prefix = `${id} log: got `;
  const line = await until(`the answer of ${id}`, () => lines.find((one) => one.startsWith(prefix)) ?? null, 20000);
  await request("POST", `${emulator.url}/api/apps/quit`);
  return JSON.parse(line.slice(prefix.length));
}

test("the command allows a port and an app reaches it; without it the app gets socket error; --remove closes it", async (t) => {
  const mine = await service(t);
  const url = `http://127.0.0.1:${mine.port}/ok`;
  const key = emulator.controlHeaders().Authorization.slice(7);

  // Nothing allowed yet: the app is refused, and its console names the command.
  const none = await allowLocal(t, ["--json"]);
  assert.equal(none.code, 0, none.stdout + none.stderr);
  assert.deepEqual(none.json, { ok: true, command: "allow-local", action: "listed", ports: [] });
  assert.deepEqual(await appFetch("app.test.before", url), { error: "socket error" });
  assert.equal(mine.connections, 0);
  assert.ok(lines.some((line) => line.includes(`busy-emulator allow-local ${mine.port} `)), lines.join("\n"));

  const allowed = await allowLocal(t, [String(mine.port), "--json"]);
  assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
  assert.equal(allowed.stderr, "");
  assert.deepEqual(allowed.json, { ok: true, command: "allow-local", action: "allowed", port: mine.port, ports: [mine.port] });
  assert.deepEqual(emulator.localPorts(), [mine.port]);
  assert.deepEqual(await appFetch("app.test.after", url), { status: 200, text: "ok" });
  assert.equal(mine.connections, 1);

  // For a person: what holds now and how to take it back; the list.
  const again = await allowLocal(t, [String(mine.port)]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`^Apps on the emulated BUSY Bar may reach port ${mine.port} of this computer now, until the emulator quits\\. Take it back with .* allow-local --remove ${mine.port}\\.\\r?\\nAllowed ports: ${mine.port}\\.\\r?\\n$`));
  assert.match((await allowLocal(t, [])).stdout, new RegExp(`may reach these ports of this computer: ${mine.port}\\.`));

  const removed = await allowLocal(t, ["--remove", String(mine.port), "--json"]);
  assert.equal(removed.code, 0, removed.stdout + removed.stderr);
  assert.deepEqual(removed.json, { ok: true, command: "allow-local", action: "removed", port: mine.port, was_allowed: true, ports: [] });
  assert.deepEqual(await appFetch("app.test.closed", url), { error: "socket error" });
  assert.equal(mine.connections, 1);
  assert.equal((await allowLocal(t, ["--remove", String(mine.port), "--json"])).json.was_allowed, false);

  // The key is sent to the management address and shown nowhere.
  for (const run of [none, allowed, again, removed]) assert.ok(!(run.stdout + run.stderr).includes(key), "the key is in the command's output");
});

test("what is not a port an app could be given: a wrong call (2), or the emulator's own address (1)", async (t) => {
  for (const args of [["abc"], ["0"], ["70000"], ["80"], ["--remove", "x"], ["3000", "--remove", "3000"], ["3000", "3001"], ["--remove"]]) {
    const wrong = await allowLocal(t, [...args, "--json"]);
    assert.equal(wrong.code, 2, args.join(" "));
    assert.equal(wrong.json.code, "usage", args.join(" "));
  }
  for (const [own, text] of [[emulator.port, /own BUSY Bar address/], [emulator.control.port, /management address/]]) {
    const refused = await allowLocal(t, [String(own), "--json"]);
    assert.equal(refused.code, 1);
    assert.equal(refused.json.code, "port_refused");
    assert.match(refused.json.message, text);
  }
  assert.deepEqual(emulator.localPorts(), []);
});

test("no emulator running: not_running, exit code 1", async (t) => {
  // A data folder with no mirror, and a port nothing listens on.
  for (const args of [["3000"], ["--remove", "3000"], []]) {
    const answer = await allowLocal(t, [...args, "--json"], { dataDir: tempDir(t), barPort: await knownPort(3) });
    assert.equal(answer.code, 1, answer.stdout + answer.stderr);
    assert.equal(answer.json.code, "not_running");
    assert.match(answer.json.hint, /start, then run .* allow-local/);
  }
  assert.deepEqual(emulator.localPorts(), []);
});
