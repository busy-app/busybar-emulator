// An app on the emulated bar does not reach this computer (ADR-0012 section 5, EMU-187), as a server runs it: the
// bar's own API works, other ports of localhost and the emulator's own addresses fail as on a bar, a port allowed with
// --allow-local or by a program with the server's key is reached, and no page can allow one — not the app window,
// not a page named with --allow-origin, not anything on the bar's address.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { after, test as nodeTest } from "node:test";

import { startServer } from "../../packages/server/server.mjs";
import { readServerKey } from "../../packages/server/server-key.mjs";
import { finish, installApp, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const WINDOW = "app://window";
const PAGE = "http://localhost:3000";

/** A service of the author's on this computer: answers "ok", counts the connections that reach it. */
async function service(t) {
  const it = { connections: 0 };
  it.server = net.createServer((socket) => {
    it.connections++;
    socket.on("error", () => {});
    socket.on("data", (chunk) => chunk.includes("\r\n\r\n") && socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
  });
  await new Promise((resolve) => it.server.listen(0, "127.0.0.1", resolve));
  it.port = it.server.address().port;
  t.after(() => new Promise((resolve) => it.server.close(resolve)));
  return it;
}

async function start(t, options = {}) {
  const lines = [];
  const emulator = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir: tempDir(t), barSpeed: false, log: (line) => lines.push(line), ...options });
  t.after(() => emulator.stop());
  emulator.lines = lines;
  return emulator;
}

/** A request with headers of its own, on a connection of its own. */
function call(method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers: { Connection: "close", ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (part) => (text += part));
      res.on("end", () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject).end();
  });
}

/** Runs an app that fetches each of `urls` and logs what it got; resolves with url → { status, text } | { error }. */
async function appFetches(emulator, id, urls) {
  const script = `
var urls = ${JSON.stringify(urls)};
urls.forEach(function (url, i) {
  fetch(url).then(function (r) { return r.text().then(function (text) { console.log("got " + i + " " + JSON.stringify({ status: r.status, text: text.slice(0, 20) })); }); },
    function (e) { console.log("got " + i + " " + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) })); });
});
setInterval(function () {}, 1000);`;
  await installApp(emulator.url, id, script);
  assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=${id}`)).status, 200);
  const results = await until(`the answers of ${id}`, () => {
    const got = new Map();
    for (const line of emulator.lines) {
      const m = new RegExp(`^${id.replace(/\./g, "\\.")} log: got (\\d+) (.*)$`).exec(line);
      if (m) got.set(urls[Number(m[1])], JSON.parse(m[2]));
    }
    return got.size === urls.length ? got : null;
  }, 20000);
  await request("POST", `${emulator.url}/api/apps/quit`);
  return results;
}

test("an app reaches its BUSY Bar's API and an allowed port; other ports of localhost and the emulator's own addresses fail as on a BUSY Bar", async (t) => {
  const allowed = await service(t);
  const other = await service(t);
  const emulator = await start(t, { allowLocal: [String(allowed.port)] });
  const urls = {
    barApi: "http://localhost/api/version",
    allowed: `http://127.0.0.1:${allowed.port}/ok`,
    allowedByName: `http://localhost:${allowed.port}/ok`,
    other: `http://localhost:${other.port}/hook?token=abc`,
    otherAgain: `http://127.0.0.1:${other.port}/again`,
    otherNumeric: `http://2130706433:${other.port}/`,
    barAddress: `http://127.0.0.1:${emulator.port}/api/version`,
    control: `http://127.0.0.1:${emulator.control.port}/_emu/state`,
    controlByName: `http://localhost.:${emulator.control.port}/_emu/state`,
  };
  const got = await appFetches(emulator, "app.test.local", Object.values(urls));
  const of = (name) => got.get(urls[name]);
  assert.equal(of("barApi").status, 200);
  assert.deepEqual(of("allowed"), { status: 200, text: "ok" });
  assert.deepEqual(of("allowedByName"), { status: 200, text: "ok" });
  for (const name of ["other", "otherAgain", "barAddress", "control", "controlByName"]) assert.deepEqual(of(name), { error: "socket error" }, name);
  // 2130706433 is no address to the firmware (mongoose's mg_aton) and no name a DNS server knows: not found, as on a bar.
  assert.deepEqual(of("otherNumeric"), { error: "Failed to connect to server" });
  assert.equal(other.connections, 0, "a port nobody allowed was reached");

  // The console explains, once for each port in a run, and does not show the request's path or query.
  const warnings = emulator.lines.filter((line) => line.startsWith("App app.test.local: its request to"));
  const about = (p) => warnings.filter((line) => line.includes(`:${p} was refused`));
  assert.equal(about(other.port).length, 1, warnings.join("\n"));
  // What to do is one command of the emulator's command line (cli/commands/allow-local.mjs, test/server/allow-local.test.mjs);
  // neither the key nor its file is in the console.
  assert.ok(about(other.port)[0].includes(`allow the port with this command: busy-emulator allow-local ${other.port} (`), about(other.port)[0]);
  assert.ok(!warnings.join("\n").includes(emulator.controlHeaders().Authorization.slice(7)), "the key itself is in the console");
  assert.ok(!warnings.join("\n").includes(emulator.dataFolder.keyFile), "the key's file is in the console");
  assert.doesNotMatch(warnings.join("\n"), /token=abc|\/hook/);
  assert.match(about(emulator.port)[0], /emulator's own BUSY Bar address.*http:\/\/localhost\/api\//);
  assert.match(about(emulator.control.port)[0], /management address, which an app may never reach/);
});

test("an app does not reach this computer by its own network addresses either, unless the port is allowed", async (t) => {
  // Every address of this computer's interfaces but the loopback and link-local: the home network, IPv6, a VPN, the
  // bar's USB network. The services listen on 127.0.0.1 only (one on all interfaces would ask the firewall on
  // Windows), so a request that went out would find nothing there either: what shows the refusal is the console's
  // line, one for each port, which only a refused request gets. Each address gets a port of its own.
  const own = Object.values(os.networkInterfaces()).flat().filter((a) => !a.internal && !a.address.startsWith("fe80"));
  if (!own.length) return t.skip("this computer has no network address");
  const ports = [];
  for (let i = 0; i <= own.length; i++) ports.push((await service(t)).port);
  const allowed = ports[own.length];
  const emulator = await start(t, { allowLocal: [String(allowed)] });
  const url = (a, p) => `http://${a.family === "IPv6" ? `[${a.address}]` : a.address}:${p}/`;
  const urls = own.map((a, i) => url(a, ports[i]));
  const got = await appFetches(emulator, "app.test.own", [...urls, url(own[0], allowed)]);
  for (const [i, u] of urls.entries()) {
    assert.deepEqual(got.get(u), { error: "socket error" }, u);
    const line = emulator.lines.find((l) => l.startsWith("App app.test.own: its request to") && l.includes(`:${ports[i]} was refused`));
    assert.ok(line, `${u} was not refused as this computer`);
    assert.match(line, /it leads to this computer/);
  }
  // An allowed port is let through to the address (where nothing listens on it: the service is on 127.0.0.1 only).
  assert.ok(!emulator.lines.some((l) => l.includes(`:${allowed} was refused`)), "an allowed port was refused on an own address");
});

test("a program with the server's key allows and takes back a port while the emulator runs", async (t) => {
  const later = await service(t);
  const emulator = await start(t);
  const path = `${emulator.control.url}/_emu/local-ports`;
  const keyed = emulator.controlHeaders();
  assert.deepEqual((await call("GET", path, keyed)).json(), { ports: [] });
  assert.equal((await appFetches(emulator, "app.test.before", [`http://127.0.0.1:${later.port}/`])).get(`http://127.0.0.1:${later.port}/`).error, "socket error");

  const allowed = await call("POST", `${path}?port=${later.port}`, keyed);
  assert.equal(allowed.status, 200, allowed.text);
  assert.deepEqual(allowed.json(), { ports: [later.port] });
  assert.ok(emulator.lines.some((line) => line === `Apps may reach port ${later.port} of this computer now: a program with the server's key allowed it.`));
  assert.deepEqual((await appFetches(emulator, "app.test.after", [`http://127.0.0.1:${later.port}/`])).get(`http://127.0.0.1:${later.port}/`), { status: 200, text: "ok" });

  const back = await call("DELETE", `${path}?port=${later.port}`, keyed);
  assert.deepEqual(back.json(), { ports: [], withdrawn: true });
  assert.deepEqual((await call("DELETE", `${path}?port=${later.port}`, keyed)).json(), { ports: [], withdrawn: false });
  const connections = later.connections;
  assert.equal((await appFetches(emulator, "app.test.again", [`http://127.0.0.1:${later.port}/`])).get(`http://127.0.0.1:${later.port}/`).error, "socket error");
  assert.equal(later.connections, connections);

  // What is not a port of this computer an app could be given.
  for (const [value, text] of [["80", /BUSY Bar's own API/], [String(emulator.port), /own BUSY Bar address/], [String(emulator.control.port), /management address/], ["abc", /from 1 to 65535/], ["", /from 1 to 65535/], ["70000", /from 1 to 65535/]]) {
    const refused = await call("POST", `${path}?port=${encodeURIComponent(value)}`, keyed);
    assert.equal(refused.status, 400, value);
    assert.match(refused.json().error, text, value);
  }
  assert.equal((await call("PUT", `${path}?port=${later.port}`, keyed)).status, 405);
  assert.deepEqual(emulator.localPorts(), []);
});

test("with the app, a port is allowed only by the person's click in its dialog: the key alone does not do it", async (t) => {
  const service1 = await service(t);
  const asked = [];
  let reply = { answer: "refuse" };
  const emulator = await start(t, { askPerson: async (question) => (asked.push(question), reply), trustRefusalPauseMs: 60_000 });
  const path = `${emulator.control.url}/_emu/local-ports`;
  const keyed = emulator.controlHeaders();
  const url = `http://127.0.0.1:${service1.port}/`;
  const refused = await call("POST", `${path}?port=${service1.port}`, keyed);
  assert.deepEqual([refused.status, refused.json()], [200, { ports: [], allowed: false, asked: true, answer: "refuse" }]);
  assert.deepEqual(asked, [{ kind: "local-port", port: service1.port }]);
  assert.deepEqual(emulator.localPorts(), []);
  assert.equal((await appFetches(emulator, "app.test.refused", [url])).get(url).error, "socket error");
  assert.equal(service1.connections, 0);
  // Asked again at once: not put before the person again.
  const soon = await call("POST", `${path}?port=${service1.port}`, keyed);
  assert.equal(soon.status, 429);
  assert.equal(asked.length, 1);
  // Another port, allowed by the person.
  const other = await service(t);
  reply = { answer: "allow" };
  const allowed = await call("POST", `${path}?port=${other.port}`, keyed);
  assert.deepEqual(allowed.json(), { ports: [other.port], allowed: true, asked: true, answer: "allow" });
  assert.ok(emulator.lines.includes(`Apps may reach port ${other.port} of this computer now: the person allowed it.`));
  assert.deepEqual((await appFetches(emulator, "app.test.allowed", [`http://127.0.0.1:${other.port}/`])).get(`http://127.0.0.1:${other.port}/`), { status: 200, text: "ok" });
  // Allowed already: nobody is asked; taking one back needs nobody either; the emulator's own ports are refused unasked.
  assert.deepEqual((await call("POST", `${path}?port=${other.port}`, keyed)).json(), { ports: [other.port] });
  assert.equal((await call("POST", `${path}?port=${emulator.control.port}`, keyed)).status, 400);
  assert.deepEqual((await call("DELETE", `${path}?port=${other.port}`, keyed)).json(), { ports: [], withdrawn: true });
  assert.equal(asked.length, 2);
  // No answer that is not "allow" opens it.
  for (const answer of [{ answer: "trust" }, { answer: "unavailable", reason: "no window" }, null]) {
    reply = answer;
    const third = await service(t);
    assert.equal((await call("POST", `${path}?port=${third.port}`, keyed)).json().allowed, false, JSON.stringify(answer));
  }
  assert.deepEqual(emulator.localPorts(), []);
});

test("no page can allow a port: not the app window, not a page named with --allow-origin, not the BUSY Bar's address", async (t) => {
  const emulator = await start(t, { windowOrigin: WINDOW, allowOrigins: [PAGE] });
  const path = `${emulator.control.url}/_emu/local-ports`;
  const keyed = emulator.controlHeaders();
  // Without the key nobody is answered on the management address; the window's origin does not change that.
  for (const origin of [null, WINDOW, PAGE]) {
    const headers = origin ? { Origin: origin } : {};
    assert.equal((await call("POST", `${path}?port=3000`, headers)).status, 401, String(origin));
    assert.equal((await call("GET", path, headers)).status, 401, String(origin));
  }
  // With the key, but from a page — a page never has the key, and holding a right of the window is not a consent.
  for (const origin of [WINDOW, PAGE, `http://127.0.0.1:${emulator.control.port}`]) {
    for (const method of ["POST", "DELETE", "GET"]) {
      const answer = await call(method, `${path}?port=3000`, { ...keyed, Origin: origin });
      assert.equal(answer.status, 403, `${origin} ${method}`);
      assert.match(answer.json().error, /a page may not let apps reach this computer/);
    }
  }
  // The bar's address, where the present device window and local web live, has no such path at all.
  for (const headers of [{}, keyed, { Origin: `http://127.0.0.1:${emulator.port}` }]) {
    assert.equal((await call("POST", `${emulator.url}/_emu/local-ports?port=3000`, headers)).status, 404);
  }
  // Nor do the device window's own paths take a port.
  for (const p of ["/_emu/status?allow_local=3000", "/_emu/power?allow_local=3000", "/_emu/key?allow_local=3000"]) await call("POST", `${emulator.url}${p}`, { Origin: `http://127.0.0.1:${emulator.port}` });
  assert.deepEqual(emulator.localPorts(), []);
  assert.deepEqual((await call("GET", path, keyed)).json(), { ports: [] });
});

test("startServer refuses a port that is not one, port 80 and its own ports before it starts anything", async (t) => {
  const dataDir = tempDir(t);
  await assert.rejects(startServer({ dataDir, port: 0, allowLocal: ["80"] }), /BUSY Bar's own API/);
  await assert.rejects(startServer({ dataDir, port: 0, allowLocal: ["x"] }), /from 1 to 65535/);
  // The ports are checked against the ones asked for before any is taken: these are never listened on.
  await assert.rejects(startServer({ dataDir, port: 18765, allowLocal: [18765] }), /emulator's own BUSY Bar address/);
  await assert.rejects(startServer({ dataDir, port: 0, controlPort: 18766, allowLocal: [18766] }), /management address/);
  await assert.rejects(startServer({ dataDir, port: 0, allowLocal: "3000" }), /list of ports/);
});

test("--allow-local on the command line: once for each port, a line that names them, and the wrong calls", async (t) => {
  const dataDir = tempDir(t);
  const child = node(t, [serverModule("index.mjs"), "--port", String(port(0)), "--data", dataDir, "--fast", "--allow-local", "3000", "--allow-local", "5173"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  const line = await until("the line about the ports", () => out.split(/\r?\n/).find((l) => / Apps on the BUSY Bar may reach ports /.test(l)), 30000);
  assert.match(line, /^\d\d:\d\d:\d\d Apps on the BUSY Bar may reach ports 3000, 5173 of this computer \(--allow-local\)$/);
  const control = /^Management: (http:\/\/127\.0\.0\.1:\d+) /m.exec(out)[1];
  assert.deepEqual((await call("GET", `${control}/_emu/local-ports`, { Authorization: `Bearer ${readServerKey(dataDir)}` })).json(), { ports: [3000, 5173] });
  child.kill();
  await child.exit;

  for (const [args, code, text] of [[["--allow-local"], 2, /--allow-local needs a value/], [["--allow-local", "80"], 1, /BUSY Bar's own API/], [["--allow-local", "3000x"], 1, /from 1 to 65535/]]) {
    const wrong = node(t, [serverModule("index.mjs"), "--port", String(port(0)), "--data", tempDir(t), ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let stdout = "";
    wrong.stderr.setEncoding("utf8").on("data", (part) => (err += part));
    wrong.stdout.setEncoding("utf8").on("data", (part) => (stdout += part));
    assert.equal(await wrong.exited(30000), code, args.join(" "));
    assert.match(err, text, args.join(" "));
    assert.equal(stdout, "", args.join(" "));
  }
});
