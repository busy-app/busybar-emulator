// Protection at the server's entry (ADR-0012 sections 1-3, EMU-009): the two addresses, Host and Origin on both and
// on the state stream's WebSocket, CORS only for origins named at the start, the management address only with the
// server's key, and the key's file.
//
// Every request here goes over a real connection; those whose headers http.request would not send as given (two Host
// headers, a request line in absolute form) are written out by hand.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import { inspect } from "node:util";
import { after, test as nodeTest } from "node:test";

import { WINDOW_POLICY } from "../../packages/server/device-window.mjs";
import { WORKER_PATH } from "../../packages/server/local-web.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { readServerKey } from "../../packages/server/server-key.mjs";
import { finish, installApp, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

// A stop that leaves a port or a connection behind keeps a test from ending: it fails then, within a minute.
const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

const windows = process.platform === "win32";
const FOREIGN = "https://evil.example";

/** A server for a test (bar's address port(n), management port(n + 1)), stopped when the test is over. */
async function start(t, options = {}, n = 0) {
  const lines = [];
  const errors = [];
  const emulator = await startServer({
    port: port(n),
    controlPort: port(n) ? port(n + 1) : 0,
    dataDir: tempDir(t),
    barSpeed: false,
    log: (line) => lines.push(line),
    onError: (e) => errors.push(e),
    ...options,
  });
  t.after(() => emulator.stop());
  return Object.assign(emulator, { lines, errors });
}

/**
 * One request on a connection of its own: { status, headers, text, json() }. `headers` may set Host and Origin to
 * anything; `body` is sent as it is.
 */
function call(url, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((done, fail) => {
    const req = http.request(url, { method, agent: false, setHost: !("Host" in headers), headers: { Connection: "close", ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", fail);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        done({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
      });
    });
    req.on("error", fail);
    req.end(body ?? undefined);
  });
}

/** Writes a request by hand and gives the answer's status line and the whole answer, once the server has closed. */
function raw(portNumber, text) {
  return new Promise((done, fail) => {
    const socket = net.connect(portNumber, "127.0.0.1", () => socket.write(text));
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", fail);
    socket.on("close", () => {
      const answer = Buffer.concat(chunks).toString("latin1");
      done({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0), answer });
    });
    socket.setTimeout(5000, () => socket.destroy());
  });
}

/** The status line of an attempt to open a WebSocket, and the socket's end. */
function upgrade(portNumber, path, headers) {
  return new Promise((done, fail) => {
    const lines = [`GET ${path} HTTP/1.1`, ...("Host" in headers ? [] : [`Host: 127.0.0.1:${portNumber}`]), "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    const socket = net.connect(portNumber, "127.0.0.1", () => socket.write(lines.join("\r\n") + "\r\n\r\n"));
    socket.on("error", fail);
    socket.once("data", (chunk) => {
      const head = chunk.toString("latin1");
      socket.destroy();
      done({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0), head });
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("no answer to the upgrade")));
  });
}

const own = (emulator) => ({ Origin: `http://127.0.0.1:${emulator.port}` });

/**
 * What a page could change, each read in a way that does not change it; the same before and after an attack means
 * the attack changed nothing of it.
 */
async function observable(emulator) {
  const json = async (path) => (await call(`${emulator.url}${path}`)).json();
  const ext = join(emulator.barDir, "ext");
  return {
    name: await json("/api/name"),
    brightness: await json("/api/display/brightness"),
    volume: await json("/api/audio/volume"),
    apps: (await json("/api/apps/list")).apps.map((app) => app.id),
    status: (await call(`${emulator.url}/_emu/status`)).json(),
    powered: (await json("/_emu/state")).powered,
    clockHeld: (await call(`${emulator.url}/_emu/time`, { method: "POST" })).json().held,
    // The firmware's APPS menu keeps its own settings and writes them when it sees fit (after an install, a while
    // after the start): that is the system's doing, not a request's.
    files: readdirSync(ext, { recursive: true }).filter((name) => !name.startsWith(join("apps_data", "apps_menu"))).sort(),
    staged: existsSync(join(ext, "apps_data", "js_app_installer", "staging")) ? readdirSync(join(ext, "apps_data", "js_app_installer", "staging")) : [],
  };
}

/** Requests that change the bar or its files, as a page would send them. */
const ATTACKS = [
  ["POST", "/api/storage/write?path=/ext/planted.txt", "planted"],
  ["POST", "/api/apps/stage", "x".repeat(2048)],
  ["POST", "/api/name", JSON.stringify({ name: "Planted" })],
  ["POST", "/api/display/brightness?value=7"],
  ["POST", "/api/audio/volume?volume=3&silent=1"],
  ["POST", "/api/input?key=start"],
  ["POST", "/api/time/timestamp?timestamp=0"],
  ["DELETE", "/api/apps?app_id=app.test.kept"],
  ["PUT", "/api/apps/settings?app_id=app.test.kept", "{}"],
  ["POST", "/_emu/power?action=off"],
  ["POST", "/_emu/status?wifi=0&usb=0&battery=1"],
  ["POST", "/_emu/time?hold=1"],
  ["POST", "/_emu/press?key=ok"],
  ["POST", "/_emu/key?key=ok&action=down"],
];
/** Requests that read, as a page would send them to read the answer. */
const READS = ["/api/status", "/api/version", "/api/apps/list", "/api/storage/read?path=/ext/apps_data", "/api/screen?display=0", "/_emu/state", "/_emu/status", "/", "/emulator"];

test("a page of another origin can neither change nor read anything on the bar's address", async (t) => {
  const emulator = await start(t);
  await installApp(emulator.url, "app.test.kept", "console.log('kept');");
  const before = await observable(emulator);
  for (const origin of [FOREIGN, "null", `http://localhost:${emulator.port}`, `http://127.0.0.1:${emulator.control.port}`, "app://window"]) {
    for (const [method, path, body] of ATTACKS) {
      const answer = await call(`${emulator.url}${path}`, { method, headers: { Origin: origin, "Content-Type": "text/plain" }, body });
      assert.equal(answer.status, 403, `${origin} ${method} ${path}`);
      assert.equal(answer.headers["access-control-allow-origin"], undefined, `${origin} ${method} ${path}: no CORS header`);
      assert.equal(answer.headers.connection, "close");
    }
    for (const path of READS) {
      const answer = await call(`${emulator.url}${path}`, { headers: { Origin: origin } });
      assert.equal(answer.status, 403, `${origin} GET ${path}`);
      assert.equal(answer.headers["access-control-allow-origin"], undefined);
      assert.match(answer.json().error, /^Forbidden/);
    }
  }
  assert.deepEqual(await observable(emulator), before, "nothing changed");
  assert.deepEqual(emulator.errors, []);
});

test("a refused upload is answered from its headers: no byte of the body goes to the disk (EMU-240 S7)", async (t) => {
  const emulator = await start(t);
  const file = join(emulator.barDir, "ext", "big.bin");
  // 8 MiB announced, a little sent, then nothing: the answer comes without the rest.
  const answer = await new Promise((done, fail) => {
    const socket = net.connect(emulator.port, "127.0.0.1", () =>
      socket.write(`POST /api/storage/write?path=/ext/big.bin HTTP/1.1\r\nHost: 127.0.0.1:${emulator.port}\r\nOrigin: ${FOREIGN}\r\nContent-Length: 8388608\r\n\r\n${"y".repeat(4096)}`),
    );
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("error", fail);
    socket.on("close", () => done(text));
  });
  assert.match(answer, /^HTTP\/1\.1 403 /);
  assert.equal(existsSync(file), false);
  // A client that waits for "100 Continue" is refused without it, and sends nothing.
  const waiting = await raw(emulator.port, `POST /api/storage/write?path=/ext/big.bin HTTP/1.1\r\nHost: 127.0.0.1:${emulator.port}\r\nOrigin: ${FOREIGN}\r\nExpect: 100-continue\r\nContent-Length: 8388608\r\n\r\n`);
  assert.equal(waiting.status, 403);
  assert.doesNotMatch(waiting.answer, /100 Continue/);
  assert.equal(existsSync(file), false);
});

test("a name that is not this address is refused on every path of both addresses and on the WebSocket (DNS rebinding)", async (t) => {
  const emulator = await start(t);
  const key = emulator.controlHeaders();
  const hosts = [`evil.example:${emulator.port}`, "evil.example", `127.0.0.1`, `localhost`, `127.0.0.2:${emulator.port}`, `[::1]:${emulator.port}`];
  for (const host of hosts) {
    for (const path of [...READS, "/nowhere"]) {
      const answer = await call(`${emulator.url}${path}`, { headers: { Host: host } });
      assert.equal(answer.status, 403, `${host} ${path}`);
      assert.match(answer.json().error, /not addressed to this emulator/);
    }
    for (const [method, path, body] of ATTACKS) assert.equal((await call(`${emulator.url}${path}`, { method, headers: { Host: host }, body })).status, 403, `${host} ${method} ${path}`);
    for (const path of ["/_emu/state", "/_emu/events", "/nowhere"]) {
      assert.equal((await call(`${emulator.control.url}${path}`, { headers: { Host: host, ...key } })).status, 403, `management ${host} ${path}`);
    }
    assert.equal((await upgrade(emulator.port, "/api/status/ws", { Host: host })).status, 403, `ws ${host}`);
    assert.equal((await upgrade(emulator.control.port, "/api/status/ws", { Host: host, ...key })).status, 403, `management ws ${host}`);
  }
  // The other address's port is another address.
  assert.equal((await call(`${emulator.url}/api/version`, { headers: { Host: `127.0.0.1:${emulator.control.port}` } })).status, 403);
  assert.equal((await call(`${emulator.control.url}/_emu/state`, { headers: { Host: `127.0.0.1:${emulator.port}`, ...key } })).status, 403);
  // No Host, two of them, a request line that names another host.
  assert.equal((await raw(emulator.port, "GET /api/version HTTP/1.0\r\n\r\n")).status, 403);
  assert.equal((await raw(emulator.port, `GET /api/version HTTP/1.1\r\nHost: evil.example\r\nHost: 127.0.0.1:${emulator.port}\r\nConnection: close\r\n\r\n`)).status, 403);
  assert.equal((await raw(emulator.port, `GET /api/version HTTP/1.1\r\nHost: 127.0.0.1:${emulator.port}\r\nHost: 127.0.0.1:${emulator.port}\r\nConnection: close\r\n\r\n`)).status, 403);
  assert.equal((await raw(emulator.port, `GET http://evil.example/api/version HTTP/1.1\r\nHost: 127.0.0.1:${emulator.port}\r\nConnection: close\r\n\r\n`)).status, 403);
  assert.equal((await raw(emulator.port, `GET http://127.0.0.1:${emulator.port}/api/version HTTP/1.1\r\nHost: 127.0.0.1:${emulator.port}\r\nConnection: close\r\n\r\n`)).status, 200);
  // Both of its names are its own.
  assert.equal((await call(`${emulator.url}/api/version`, { headers: { Host: `localhost:${emulator.port}` } })).status, 200);
  assert.equal((await call(`${emulator.url}/api/version`, { headers: { Host: `LocalHost:${emulator.port}` } })).status, 200);
  assert.deepEqual(emulator.errors, []);
});

test("localhost and 127.0.0.1 are each its own origin only when the request came by that name", async (t) => {
  const emulator = await start(t);
  const at = (host, origin) => call(`${emulator.url}/api/version`, { headers: { Host: `${host}:${emulator.port}`, Origin: `http://${origin}:${emulator.port}` } });
  assert.equal((await at("127.0.0.1", "127.0.0.1")).status, 200);
  assert.equal((await at("localhost", "localhost")).status, 200);
  assert.equal((await at("127.0.0.1", "localhost")).status, 403);
  assert.equal((await at("localhost", "127.0.0.1")).status, 403);
});

test("programs without Origin — busy-cli, curl, agents — work on the bar's address as before, and get no CORS header", async (t) => {
  const emulator = await start(t);
  // What busy-cli does: stage, install, launch, quit; and a file written.
  await installApp(emulator.url, "app.test.tool", "setInterval(function () {}, 1000);");
  for (const [method, path, body] of [["POST", "/api/apps/launch?app_id=app.test.tool"], ["GET", "/api/apps/list"], ["POST", "/api/storage/write?path=/ext/tool.txt", "ok"], ["GET", "/api/storage/read?path=/ext/tool.txt"], ["POST", "/api/input?key=ok"], ["GET", "/api/status"], ["GET", "/_emu/state"], ["POST", "/_emu/time?hold=0"], ["GET", "/"]]) {
    const answer = await call(`${emulator.url}${path}`, { method, body });
    assert.equal(answer.status, 200, `${method} ${path}: ${answer.text}`);
    assert.equal(answer.headers["access-control-allow-origin"], undefined, `${method} ${path}`);
  }
  assert.equal(readFileSync(join(emulator.barDir, "ext", "tool.txt"), "utf8"), "ok");
  await until("the app to run", async () => (await call(`${emulator.url}/_emu/state`)).json().running?.id === "app.test.tool");
  assert.equal((await call(`${emulator.url}/api/apps/quit`, { method: "POST" })).status, 200);
  // A page of its own address too: the local web and the device window.
  assert.equal((await call(`${emulator.url}/api/input?key=ok`, { method: "POST", headers: own(emulator) })).status, 200);
  const preflight = await call(`${emulator.url}/api/apps/list`, { method: "OPTIONS", headers: own(emulator) });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);
});

test("an origin named with --allow-origin gets what a bar gives every page; the others are still refused", async (t) => {
  const page = "http://localhost:3000";
  const emulator = await start(t, { allowOrigins: [page] });
  const answer = await call(`${emulator.url}/api/version`, { headers: { Origin: page } });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["access-control-allow-origin"], "*");
  assert.equal(answer.headers["access-control-allow-headers"], "*");
  assert.equal(answer.headers.vary, "Origin");
  const preflight = await call(`${emulator.url}/api/apps/list`, { method: "OPTIONS", headers: { Origin: page, "Access-Control-Request-Method": "DELETE" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "*");
  assert.equal(preflight.headers["access-control-allow-methods"], "GET,POST,PUT,DELETE");
  assert.equal(preflight.headers["access-control-allow-headers"], "*");
  assert.equal((await call(`${emulator.url}/api/input?key=ok`, { method: "POST", headers: { Origin: page } })).status, 200);
  // An answer given from the headers alone carries them too.
  const early = await call(`${emulator.url}/api/apps/stage`, { method: "POST", headers: { Origin: page } });
  assert.equal(early.status, 400);
  assert.equal(early.headers["access-control-allow-origin"], "*");
  // On the management address it is let in, the key is still asked, and the origin is named.
  const control = await call(`${emulator.control.url}/_emu/state`, { headers: { Origin: page, ...emulator.controlHeaders() } });
  assert.equal(control.status, 200);
  assert.equal(control.headers["access-control-allow-origin"], page);
  assert.equal((await call(`${emulator.control.url}/_emu/state`, { headers: { Origin: page } })).status, 401);
  for (const other of [FOREIGN, "http://localhost:3001", "null"]) {
    const refused = await call(`${emulator.url}/api/version`, { headers: { Origin: other } });
    assert.equal(refused.status, 403, other);
    assert.equal(refused.headers["access-control-allow-origin"], undefined);
  }
  // With no origin named, nobody gets a CORS header (the bar answers "*" to every page; the emulator does not).
  const plain = await start(t, {}, 2);
  assert.equal((await call(`${plain.url}/api/version`, { headers: own(plain) })).headers["access-control-allow-origin"], undefined);
  assert.equal((await call(`${plain.url}/api/version`, { headers: { Origin: page } })).status, 403);
});

test("the app window's origin is the emulator's own on the management address; any other origin is refused there", async (t) => {
  const emulator = await start(t, { windowOrigin: "app://window" });
  const key = emulator.controlHeaders();
  const answer = await call(`${emulator.control.url}/_emu/state`, { headers: { Origin: "app://window", ...key } });
  assert.equal(answer.status, 200);
  assert.equal(answer.headers["access-control-allow-origin"], "app://window");
  // A preflight carries no key; the window hears what it may send.
  const preflight = await call(`${emulator.control.url}/_emu/press?key=ok`, { method: "OPTIONS", headers: { Origin: "app://window", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "app://window");
  assert.equal(preflight.headers["access-control-allow-headers"], "Authorization");
  // The event stream carries the header too.
  const events = await new Promise((done, fail) => {
    const req = http.get(`${emulator.control.url}/_emu/events`, { agent: false, headers: { Origin: "app://window", ...key } }, (res) => {
      done(res.headers);
      res.destroy();
    });
    req.on("error", fail);
  });
  assert.equal(events["access-control-allow-origin"], "app://window");
  assert.equal(events["content-type"], "text/event-stream");
  for (const origin of ["app://stage", "app://shell", FOREIGN, "null", `http://127.0.0.1:${emulator.port}`]) {
    assert.equal((await call(`${emulator.control.url}/_emu/state`, { headers: { Origin: origin, ...key } })).status, 403, origin);
  }
  // Not on the bar's address: there it is a page of another origin.
  assert.equal((await call(`${emulator.url}/api/version`, { headers: { Origin: "app://window" } })).status, 403);
});

test("the management address refuses everything without the server's key, and does nothing for it", async (t) => {
  const emulator = await start(t);
  const wrong = { Authorization: `Bearer ${"A".repeat(43)}` };
  const paths = [
    ["GET", "/_emu/state"], ["POST", "/_emu/press?key=ok"], ["POST", "/_emu/time?hold=1"], ["GET", "/_emu/events"], ["POST", "/_emu/key?key=ok&action=down"],
    ["GET", "/_emu/audio?id=1"], ["GET", "/_emu/status"], ["POST", "/_emu/status?wifi=0"], ["POST", "/_emu/power?action=off"], ["GET", "/_emu/v1/emulator.info"],
    ["GET", "/api/version"], ["GET", "/"], ["GET", "/emulator"], ["OPTIONS", "/_emu/state"], ["DELETE", "/_emu/state"],
  ];
  for (const headers of [{}, wrong, { Authorization: "Bearer" }, { Authorization: readServerKey(emulator.dataDir) }, { Origin: emulator.control.url }]) {
    for (const [method, path] of paths) {
      const answer = await call(`${emulator.control.url}${path}`, { method, headers });
      assert.equal(answer.status, 401, `${JSON.stringify(headers)} ${method} ${path}`);
      assert.match(answer.json().error, /^Unauthorized: .*Authorization: Bearer <key>/);
      assert.equal(answer.headers["www-authenticate"], 'Bearer realm="busy-emulator"');
    }
    assert.equal((await upgrade(emulator.control.port, "/api/status/ws", headers)).status, 401);
  }
  // Nothing of it was done.
  assert.equal((await call(`${emulator.url}/_emu/state`)).json().powered, true);
  assert.deepEqual((await call(`${emulator.url}/_emu/status`)).json().wifi, true);
  assert.equal((await call(`${emulator.url}/_emu/time`, { method: "POST" })).json().held, false);
  // With the key: the old paths, and nothing that is the bar's.
  const key = emulator.controlHeaders();
  assert.equal((await call(`${emulator.control.url}/_emu/state`, { headers: key })).status, 200);
  assert.equal((await call(`${emulator.control.url}/_emu/time?hold=1`, { method: "POST", headers: key })).json().held, true);
  assert.equal((await call(`${emulator.control.url}/_emu/time?hold=0`, { method: "POST", headers: key })).json().held, false);
  for (const path of ["/api/version", "/", "/emulator", "/emulator/window.js", "/_emu/v1/emulator.info"]) {
    assert.equal((await call(`${emulator.control.url}${path}`, { headers: key })).status, 404, path);
  }
  assert.equal((await upgrade(emulator.control.port, "/api/status/ws", key)).status, 404);
  // A page of another origin is refused before the key is looked at.
  assert.equal((await call(`${emulator.control.url}/_emu/state`, { headers: { Origin: FOREIGN, ...key } })).status, 403);
});

test("the state stream's WebSocket is let in by the same rules", async (t) => {
  const emulator = await start(t, { allowOrigins: ["http://localhost:3000"] });
  const at = (headers) => upgrade(emulator.port, "/api/status/ws", { Host: `127.0.0.1:${emulator.port}`, ...headers });
  assert.equal((await at(own(emulator))).status, 101, "the local web");
  assert.equal((await at({})).status, 101, "a program");
  assert.equal((await at({ Origin: "http://localhost:3000" })).status, 101, "a named origin");
  for (const origin of [FOREIGN, "null", `http://localhost:${emulator.port}`, "app://window"]) {
    const refused = await at({ Origin: origin });
    assert.equal(refused.status, 403, origin);
    assert.doesNotMatch(refused.head, /Sec-WebSocket-Accept/i);
  }
  // Refused before the path is looked at.
  assert.equal((await at({ Origin: FOREIGN, Host: "evil.example" })).status, 403);
  assert.equal((await upgrade(emulator.port, "/nowhere", { Host: `127.0.0.1:${emulator.port}`, Origin: FOREIGN })).status, 403);
  assert.equal((await upgrade(emulator.port, "/nowhere", { Host: `127.0.0.1:${emulator.port}` })).status, 404);
});

test("the present device window: its page under a policy without inline code or other addresses, its files as what they are", async (t) => {
  const emulator = await start(t);
  for (const path of ["/emulator", "/emulator/window.js", "/emulator/window.css", "/emulator/busybar-device.png", "/emulator/nothing"]) {
    const answer = await call(`${emulator.url}${path}`);
    assert.equal(answer.headers["content-security-policy"], WINDOW_POLICY, path);
    assert.equal(answer.headers["x-content-type-options"], "nosniff", path);
  }
  assert.equal((await call(`${emulator.url}/emulator/busybar-device.png`)).headers["content-type"], "image/png");
  assert.equal(WINDOW_POLICY, "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  // The page itself has nothing that policy would stop: no inline script or style, no handler attributes.
  const page = (await call(`${emulator.url}/emulator`)).text;
  assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(page, /\son[a-z]+=|\sstyle=|<style/i);
});

test("the key: new at every start, the user's alone, removed by the stop, and in no answer, log line or property", async (t) => {
  const dataDir = tempDir(t);
  const first = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir, barSpeed: false });
  t.after(() => first.stop());
  const key = readServerKey(dataDir);
  assert.ok(key);
  assert.equal(first.dataFolder.keyFile, join(dataDir, "key"));
  if (!windows) assert.equal(statSync(first.dataFolder.keyFile).mode & 0o777, 0o600);
  assert.deepEqual(first.controlHeaders(), { Authorization: `Bearer ${key}` });
  // A logged result does not show it.
  assert.doesNotMatch(inspect(first, { depth: 10, showHidden: false }), new RegExp(key));
  assert.doesNotMatch(JSON.stringify({ ...first, firmware: null }), new RegExp(key));
  // Nor do the lock record and the answers of either address.
  assert.doesNotMatch(readFileSync(first.dataFolder.lockFile, "utf8"), new RegExp(key));
  const lock = JSON.parse(readFileSync(first.dataFolder.lockFile, "utf8"));
  assert.deepEqual(lock.control, first.control);
  for (const [base, path, headers] of [[first.url, "/api/status"], [first.url, "/_emu/state"], [first.url, "/emulator"], [first.control.url, "/_emu/state", first.controlHeaders()], [first.control.url, "/_emu/state"], [first.control.url, "/nowhere", first.controlHeaders()]]) {
    const answer = await call(`${base}${path}`, { headers });
    assert.doesNotMatch(JSON.stringify(answer.headers) + answer.text, new RegExp(key), `${base}${path}`);
  }
  await first.stop();
  assert.equal(existsSync(join(dataDir, "key")), false, "the stop removes the key");
  await assert.rejects(call(`${first.control.url}/_emu/state`), { code: "ECONNREFUSED" });
  await assert.rejects(call(`${first.url}/api/version`), { code: "ECONNREFUSED" });
  // The next start makes another.
  const second = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir, barSpeed: false });
  t.after(() => second.stop());
  const next = readServerKey(dataDir);
  assert.notEqual(next, key);
  assert.equal((await call(`${second.control.url}/_emu/state`, { headers: { Authorization: `Bearer ${key}` } })).status, 401, "the old key opens nothing");
  assert.equal((await call(`${second.control.url}/_emu/state`, { headers: second.controlHeaders() })).status, 200);
});

test("the command line names the management address and the key's file, never the key; the key is not in its arguments or environment", async (t) => {
  const dataDir = tempDir(t);
  const args = [serverModule("index.mjs"), "--port", String(port(0)), "--control-port", String(port(0) ? port(1) : 0), "--data", dataDir, "--fast", "--verbose", "--allow-origin", "http://localhost:3000", "--allow-origin", "http://localhost:3001", "--window-origin", "app://window"];
  const child = node(t, args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const ready = await new Promise((resolve) => child.on("message", resolve));
  await until("the start-up lines", () => out.split("\n").length > 5);
  const key = readServerKey(dataDir);
  assert.ok(key);
  const [first, second] = out.split("\n");
  assert.match(first, new RegExp(`^BUSY Bar emulator: http://127\\.0\\.0\\.1:${ready.port}  `));
  assert.equal(second, `Management: ${ready.controlUrl}  (for programs that send the server's key, from ${join(dataDir, "key")})`);
  assert.equal(ready.controlUrl, `http://127.0.0.1:${ready.controlPort}`);
  // Requests that the bar has no answer for are logged with --verbose; one with the key in its address is not the key's way in.
  assert.equal((await call(`http://127.0.0.1:${ready.controlPort}/_emu/state`, { headers: { Authorization: `Bearer ${key}` } })).status, 200);
  await call(`http://127.0.0.1:${ready.port}/api/nowhere`);
  // Every --allow-origin counts, and --window-origin is the window's.
  for (const origin of ["http://localhost:3000", "http://localhost:3001"]) {
    assert.equal((await call(`http://127.0.0.1:${ready.port}/api/version`, { headers: { Origin: origin } })).headers["access-control-allow-origin"], "*", origin);
  }
  assert.equal((await call(`http://127.0.0.1:${ready.port}/api/version`, { headers: { Origin: "http://localhost:3002" } })).status, 403);
  assert.equal((await call(`http://127.0.0.1:${ready.controlPort}/_emu/state`, { headers: { Origin: "app://window", Authorization: `Bearer ${key}` } })).headers["access-control-allow-origin"], "app://window");
  child.kill("SIGTERM");
  await child.exited();
  for (const text of [out, err, JSON.stringify(ready), args.join(" "), JSON.stringify(process.env)]) assert.doesNotMatch(text, new RegExp(key));
  // A signal is a stop on macOS and Linux. Windows has no signals: kill() ends the process outright, and the key is
  // left in its file, as the lock is (data-folder.mjs); it opens nothing, and the next start writes its own.
  if (windows) assert.equal(readServerKey(dataDir), key);
  else assert.equal(existsSync(join(dataDir, "key")), false, "a stop by a signal removes the key too");
});

test("both addresses are taken and let go of together; a management port in use fails the start and leaves nothing", async (t) => {
  const dataDir = tempDir(t);
  // The management port in use by another program.
  const other = net.createServer();
  await new Promise((resolve, reject) => other.once("error", reject).listen(port(1), "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const busy = other.address().port;
  await assert.rejects(startServer({ port: port(0), controlPort: busy, dataDir, barSpeed: false }), (e) => {
    assert.equal(e.code, "EADDRINUSE");
    assert.match(e.message, new RegExp(`^Port ${busy} \\(the management address\\) on 127\\.0\\.0\\.1 is in use`));
    return true;
  });
  assert.deepEqual(readdirSync(dataDir), [], "not a file in the data folder");
  if (port(0)) await assert.rejects(call(`http://127.0.0.1:${port(0)}/api/version`), { code: "ECONNREFUSED" });
  // Options that cannot work, refused before anything is touched.
  await assert.rejects(startServer({ port: 8691, controlPort: 8691, dataDir }), RangeError);
  await assert.rejects(startServer({ port: 0, controlPort: -1, dataDir }), RangeError);
  await assert.rejects(startServer({ port: 0, allowOrigins: ["*"], dataDir }), RangeError);
  await assert.rejects(startServer({ port: 0, allowOrigins: "http://localhost:3000", dataDir }), TypeError);
  await assert.rejects(startServer({ port: 0, windowOrigin: "null", dataDir }), RangeError);
  assert.deepEqual(readdirSync(dataDir), []);
});

test("the GET answers of the management address and of the bar are the same old paths: a hash of the state agrees", async (t) => {
  const emulator = await start(t);
  const key = emulator.controlHeaders();
  const strip = (state) => ({ ...state, clock: null });
  const a = strip((await call(`${emulator.url}/_emu/state`)).json());
  const b = strip((await call(`${emulator.control.url}/_emu/state`, { headers: key })).json());
  assert.equal(createHash("sha256").update(JSON.stringify(a)).digest("hex"), createHash("sha256").update(JSON.stringify(b)).digest("hex"));
  assert.equal((await request("POST", `${emulator.url}/_emu/press?key=ok`)).status, 200);
});

test("no other page may embed what the bar's address gives: not as a script, a picture or a frame", async (t) => {
  const emulator = await start(t);
  const embedding = {
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "content-security-policy": "frame-ancestors 'self'",
    "x-frame-options": "SAMEORIGIN",
  };
  const pick = (headers) => Object.fromEntries(Object.keys(embedding).map((name) => [name, headers[name]]));
  assert.equal((await call(`${emulator.url}/api/storage/write?path=/ext/leak.js`, { method: "POST", body: "window.leak = 1;" })).status, 200);
  // The API, a file of the storage, the local web and its fallback, the old paths, a 404, a method the bar refuses.
  for (const [method, path] of [["GET", "/api/version"], ["GET", "/api/storage/read?path=/ext/leak.js"], ["GET", "/api/screen?display=0"], ["GET", "/"], ["GET", "/apps"], ["GET", "/_nuxt/entry-7c2bd48.js"], ["GET", "/_emu/state"], ["GET", "/_emu/status"], ["GET", "/nowhere/x.js"], ["POST", "/api/version"]]) {
    const answer = await call(`${emulator.url}${path}`, { method });
    assert.deepEqual(pick(answer.headers), embedding, `${method} ${path}`);
  }
  // An answer written from the headers alone carries them too.
  assert.deepEqual(pick((await call(`${emulator.url}/api/apps/stage`, { method: "POST" })).headers), embedding);
  // The device window's page keeps its own, stricter policy.
  const page = await call(`${emulator.url}/emulator`);
  assert.equal(page.headers["content-security-policy"], WINDOW_POLICY);
  assert.equal(page.headers["cross-origin-resource-policy"], "same-origin");
});

test("the local web's state stream worker comes from the bar's address, so it connects with that origin", async (t) => {
  for (const [n, firmware] of [[0, "1.3.1"], [2, "dev"]]) {
    const emulator = await start(t, { firmware }, n);
    const script = (await call(`${emulator.url}/_nuxt/wifiStore-7c2bd48.js`)).text;
    assert.ok(script.includes(`"${WORKER_PATH}"`), firmware);
    assert.doesNotMatch(script, /data:application\/javascript;base64,/);
    const worker = await call(`${emulator.url}${WORKER_PATH}`);
    assert.equal(worker.status, 200);
    assert.equal(worker.headers["content-type"], "text/javascript");
    assert.match(worker.text, /new WebSocket\(/);
    assert.equal(emulator.lines.filter((line) => /state stream worker/.test(line)).length, 0, "no note about the worker");
    // What such a worker sends, with the bar's address as its origin, is let in; Origin: null still is not.
    assert.equal((await upgrade(emulator.port, "/api/status/ws", own(emulator))).status, 101);
    assert.equal((await upgrade(emulator.port, "/api/status/ws", { Origin: "null" })).status, 403);
  }
});
