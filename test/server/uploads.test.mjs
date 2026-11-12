// Request bodies, written by hand on a socket: uploads the bar refuses from their headers, clients that go away or go
// quiet in the middle of a body, bodies larger than the bar holds, and the same for the state stream's frames — for
// every kind of place where the server takes in what a client sends. Most of the tests run the server as its command
// line (index.mjs), so that a fault that ends the server's process ends that process only, and the test says so.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { Device } from "../../packages/server/device.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { targz } from "../package.mjs";
import { activeResourcesAtRest, activeResourcesSettled, finish, get, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const here = dirname(fileURLToPath(import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MiB = 1024 * 1024;

/**
 * The server as its command line, on a data folder of its own, ended when the test is over. Returns { child, base,
 * port, dataDir, barDir (the bar's folder in the data folder, bar/<firmware>), stderr(), alive() }: alive() fails the
 * test if the process has ended, and otherwise asks it for /api/version.
 */
async function serve(t) {
  const dataDir = tempDir(t);
  const child = node(t, [serverModule("index.mjs"), "--port", String(port(0)), "--data", dataDir, "--fast"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (err += text));
  let ended = false;
  child.exit.then(() => (ended = true));
  const address = await until("the server's first line", () => /^BUSY Bar emulator: http:\/\/127\.0\.0\.1:(\d+) .*, firmware (\S+) /.exec(out) ?? (ended && "ended"), 30000);
  assert.notEqual(address, "ended", `the server did not start: ${err}`);
  const barDir = join(dataDir, "bar", address[2]);
  // The APPS menu writes its settings a while after the start (see tree): before that the data folder is still
  // changing by itself.
  await until("the APPS menu's settings", () => existsSync(join(barDir, "ext", "apps_data", "apps_menu", "settings.json")), 10000);
  const taken = Number(address[1]);
  hostPort = taken;
  const server = { child, port: taken, base: `http://127.0.0.1:${taken}`, dataDir, barDir, stderr: () => err };
  server.alive = async (what) => {
    // A process that a fault has ended has gone a moment after the fault.
    await pause(50);
    assert.ok(!ended && child.exitCode === null, `the server's process has ended (${what}):\n${err}`);
    assert.equal((await get(`${server.base}/api/version`)).status, 200, `the server answers (${what})`);
  };
  return server;
}

/** A connection to the server for a request written by hand. `text()` is what came back; `closed` settles when it is closed. */
async function connect(server) {
  const socket = net.connect(server.port, "127.0.0.1");
  await once(socket, "connect");
  const connection = { socket, received: Buffer.alloc(0), error: null };
  socket.on("data", (bytes) => (connection.received = Buffer.concat([connection.received, bytes])));
  socket.on("error", (e) => (connection.error = e.code));
  // (events.once would fail on the error a client may see when the server closes.)
  connection.closed = new Promise((resolve) => socket.once("close", resolve));
  connection.text = () => connection.received.toString("latin1");
  return connection;
}

/** Waits for `promise`, at most `ms`; then fails with `what`. Leaves no timer behind. */
async function within(promise, ms, what) {
  let timer;
  const late = new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(what)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Waits for the server to close the connection, at most `ms`. */
const closedWithin = (connection, ms) => within(connection.closed, ms, `the connection is still open after ${ms} ms`);

// The port of the server the test at hand started: a request written by hand names it in Host, as a client does (the
// emulator refuses a request whose Host is not its address, ADR-0012 section 2).
let hostPort = null;
const head = (method, path, headers = {}) =>
  `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:${hostPort}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;

/** Writes `bytes` and waits until they have gone out (or the connection is gone). */
const write = (connection, bytes) => new Promise((resolve) => (connection.socket.destroyed ? resolve() : connection.socket.write(bytes, () => resolve())));

/** An answer as it came: { status line, headers (lower-case names, values without the spaces around them), body }. */
function parse(text) {
  const end = text.indexOf("\r\n\r\n");
  const [line, ...fields] = text.slice(0, end).split("\r\n");
  const headers = Object.fromEntries(fields.map((f) => [f.slice(0, f.indexOf(":")).toLowerCase(), f.slice(f.indexOf(":") + 1).trim()]));
  return { line, headers, body: text.slice(end + 4, end + 4 + Number(headers["content-length"])), rest: text.slice(end + 4 + Number(headers["content-length"])) };
}

/**
 * Every file and folder in the data folder, with each file's length and a digest of what is in it. The APPS menu's
 * settings are left out: the menu writes them on its own.
 */
function tree(dir, at = dir) {
  return readdirSync(at, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const path = join(at, entry.name);
      const name = path.slice(dir.length + 1).replaceAll("\\", "/");
      if (name.endsWith("ext/apps_data/apps_menu")) return [];
      if (entry.isDirectory()) return [`${name}/`, ...tree(dir, path)];
      return [`${name} ${statSync(path).size} ${createHash("sha1").update(readFileSync(path)).digest("hex").slice(0, 12)}`];
    });
}

const appPackage = (id) =>
  targz({
    [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.0.0" }),
    [`${id}/scripts/main.js`]: "console.log('up');",
  });

// The bar's answers, as it sent them (test/archives/bar-413-1.3.1.json).
const BAR_413 = JSON.parse(readFileSync(join(here, "..", "archives", "bar-413-1.3.1.json"), "utf8")).requests;

/**
 * The places that take a body as a file, each with a path that it takes one at. `check(server)` says what must be
 * true once an upload to it has been cut off: besides an unchanged data folder, for apps/stage, that the app staged
 * before is still staged with its key.
 */
const RECEIVERS = [
  ["apps/stage", "/api/apps/stage"],
  ["update", "/api/update"],
  ["storage/write", "/api/storage/write?path=/ext/new/folders/file.bin"],
  ["storage/write, appending", "/api/storage/write?path=/ext/kept.txt&append=1"],
  ["assets/upload", "/api/assets/upload?application_name=app.test.assets&file=images/new.png"],
];

test("an app package over 100 MiB is refused from its headers, as the bar refuses it, and the package staged before still installs", async (t) => {
  const server = await serve(t);
  const staged = await request("POST", `${server.base}/api/apps/stage`, appPackage("app.test.before"));
  assert.equal(staged.status, 200);
  const before = tree(server.dataDir);

  for (const [i, { request: what, answer: bar }] of BAR_413.entries()) {
    await t.test(`as recorded on a bar: ${what}`, async () => {
      const connection = await connect(server);
      await write(connection, head("POST", "/api/apps/stage", { "Content-Length": i === 0 ? 104857601 : 209715200 }));
      if (i === 0) await write(connection, Buffer.alloc(4096, 0x78));
      // The client keeps its connection open and sends no more: the server answers, and closes it.
      const started = Date.now();
      await until("the server to close the connection", () => connection.socket.readableEnded || connection.socket.destroyed, 5000);
      assert.ok(Date.now() - started < 2500, "the connection is closed soon after the answer");
      const answer = parse(connection.text());
      const recorded = parse(bar);
      assert.equal(answer.line, recorded.line);
      assert.equal(answer.line, "HTTP/1.1 413 Payload Too Large");
      assert.equal(answer.body, recorded.body);
      assert.equal(answer.body, '{"error":"Payload Too Large"}\n');
      // The headers the bar sends, but for its CORS headers: the bar gives every page "*", the emulator gives CORS
      // headers only to the origins named with --allow-origin, and this request has none (ADR-0012 section 2; that it
      // has them then, the entry's tests show). Access-Control-Allow-Headers it does not send with an answer from
      // the headers either way (EMU-234).
      const { "access-control-allow-headers": _all, "access-control-allow-origin": _origin, ...barHeaders } = recorded.headers;
      // And the emulator adds what keeps other pages from embedding its answers, which a bar does not send (ADR-0012
      // section 2; the entry's tests show them).
      const embedding = ["cross-origin-resource-policy", "x-content-type-options", "content-security-policy", "x-frame-options"];
      const emulatorHeaders = Object.fromEntries(Object.entries(answer.headers).filter(([name]) => !embedding.includes(name)));
      assert.deepEqual(embedding.map((name) => typeof answer.headers[name]), ["string", "string", "string", "string"]);
      assert.deepEqual(emulatorHeaders, barHeaders);
      // The bar's second answer, 508, is a fault of its firmware: the emulator sends one answer only.
      assert.match(recorded.rest, /^HTTP\/1\.1 508 /);
      assert.equal(answer.rest, "");
      connection.socket.destroy();
    });
  }

  await t.test("a client that goes on sending gets the answer, and the connection is closed", async () => {
    const connection = await connect(server);
    await write(connection, head("POST", "/api/apps/stage", { "Content-Length": 200 * MiB }));
    const chunk = Buffer.alloc(MiB, 0x78);
    for (let sent = 0; sent < 200 && !connection.socket.destroyed && !connection.socket.readableEnded; sent++) await write(connection, chunk);
    await connection.closed;
    assert.equal(parse(connection.text()).line, "HTTP/1.1 413 Payload Too Large");
  });

  await t.test("a client that has sent more than the server has read, and reads late, still gets the answer", async () => {
    // A connection closed with bytes of the client's unread is reset by the system, and what the client had not read
    // yet of the answer is lost with it: the server reads and drops the rest before it closes.
    const connection = await connect(server);
    connection.socket.pause();
    await write(connection, Buffer.concat([Buffer.from(head("POST", "/api/apps/stage", { "Content-Length": 200 * MiB })), Buffer.alloc(2 * MiB, 0x78)]));
    await pause(300);
    connection.socket.resume();
    await closedWithin(connection, 5000);
    assert.equal(parse(connection.text()).line, "HTTP/1.1 413 Payload Too Large", `what came: ${JSON.stringify(connection.text())}, ${connection.error}`);
  });

  await t.test("a client that goes on sending after the answer, and reads late, still gets it", async () => {
    // The server drains the connection for a while before it closes it: closed at once, the client's later bytes
    // would make the system reset the connection, and the answer the client has not read yet would be lost.
    const connection = await connect(server);
    connection.socket.pause();
    connection.socket.write(head("POST", "/api/apps/stage", { "Content-Length": 200 * MiB }));
    const chunk = Buffer.alloc(256 * 1024, 0x78);
    for (const end = Date.now() + 300; Date.now() < end && !connection.socket.destroyed; ) {
      connection.socket.write(chunk);
      await pause(10);
    }
    connection.socket.resume();
    await closedWithin(connection, 5000);
    assert.equal(parse(connection.text()).line, "HTTP/1.1 413 Payload Too Large", `what came: ${JSON.stringify(connection.text())}, ${connection.error}`);
  });

  await t.test("a client that asks to be told to go on is not told so", async () => {
    const connection = await connect(server);
    await write(connection, head("POST", "/api/apps/stage", { "Content-Length": 104857601, Expect: "100-continue" }));
    await closedWithin(connection, 3000);
    assert.match(connection.text(), /^HTTP\/1\.1 413 Payload Too Large\r\n/);
  });

  await t.test("100 MiB is not too much: the body is waited for", async () => {
    const connection = await connect(server);
    await write(connection, head("POST", "/api/apps/stage", { "Content-Length": 100 * MiB }));
    await pause(300);
    assert.equal(connection.text(), "");
    connection.socket.destroy();
  });

  await t.test("an update bundle over 100 MiB is refused the same way", async () => {
    const connection = await connect(server);
    await write(connection, head("POST", "/api/update", { "Content-Length": 104857601 }));
    await closedWithin(connection, 3000);
    const answer = parse(connection.text());
    assert.equal(answer.line, "HTTP/1.1 413 Payload Too Large");
    assert.equal(answer.body, '{"error":"Payload Too Large"}\n');
  });

  await server.alive("after the refusals");
  assert.deepEqual(tree(server.dataDir), before, "nothing in the data folder has changed");
  const installed = await request("POST", `${server.base}/api/apps/install?install_key=${staged.json().install_key}`);
  assert.equal(installed.status, 200, "the key the earlier package was staged with still installs it");
});

test("an upload cut off by the client anywhere takes nothing down and leaves nothing behind, in every place that takes a file", async (t) => {
  const server = await serve(t);
  const staged = await request("POST", `${server.base}/api/apps/stage`, appPackage("app.test.before"));
  assert.equal(staged.status, 200);
  assert.equal((await request("POST", `${server.base}/api/storage/write?path=/ext/kept.txt`, Buffer.from("kept as it was"))).status, 200);
  const before = tree(server.dataDir);
  const length = 300 * 1024;
  const body = Buffer.alloc(length, 0x61);

  for (const [name, path] of RECEIVERS) {
    const whole = head("POST", path, { "Content-Length": length });
    const points = [
      ["in the headers", whole.slice(0, whole.indexOf("Content-Length") + 6), null],
      ["right after the headers", whole, null],
      ["in the middle of the body", whole, body.subarray(0, length / 2)],
      ["one byte before the end", whole, body.subarray(0, length - 1)],
    ];
    for (const [where, headPart, bodyPart] of points) {
      // A client that closes its connection, and one whose system resets it (on Windows the server then sees
      // ECONNRESET rather than the end of the connection).
      for (const how of ["closed", "reset"]) {
        await t.test(`${name}: ${where}, ${how}`, async () => {
          const connection = await connect(server);
          await write(connection, headPart);
          if (bodyPart) await write(connection, bodyPart);
          // A moment for the server to take in what came, and to start writing it where it goes.
          await pause(30);
          if (how === "reset") connection.socket.resetAndDestroy();
          else connection.socket.destroy();
          await connection.closed;
          await server.alive(`${name}, ${where}, ${how}`);
          await until("the data folder to be as it was", () => JSON.stringify(tree(server.dataDir)) === JSON.stringify(before), 3000).catch(() => {});
          assert.deepEqual(tree(server.dataDir), before, "nothing of the upload is left");
        });
      }
    }
  }

  // The same uploads, whole, still work.
  for (const [name, path] of RECEIVERS.filter(([n]) => n !== "apps/stage" && n !== "update")) {
    assert.equal((await request("POST", `${server.base}${path}`, Buffer.from("whole"))).status, 200, `${name} takes a whole upload`);
  }
  assert.equal(readFileSync(join(server.barDir, "ext", "kept.txt"), "utf8"), "kept as it waswhole");
  const installed = await request("POST", `${server.base}/api/apps/install?install_key=${staged.json().install_key}`);
  assert.equal(installed.status, 200, "the package staged before the cut-off uploads still installs");
});

test("an upload that stops coming is answered 408 and undone, as on the bar: after 5 s for a package, 3 s for a file", async (t) => {
  const server = await serve(t);
  assert.equal((await request("POST", `${server.base}/api/storage/write?path=/ext/kept.txt`, Buffer.from("kept as it was"))).status, 200);
  const before = tree(server.dataDir);
  const quiet = { "apps/stage": 5000, update: 5000, "storage/write": 3000, "storage/write, appending": 3000, "assets/upload": 3000 };
  await Promise.all(
    RECEIVERS.map(async ([name, path]) => {
      const connection = await connect(server);
      await write(connection, head("POST", path, { "Content-Length": 1000 }));
      await write(connection, Buffer.alloc(400, 0x61));
      const started = Date.now();
      await closedWithin(connection, quiet[name] + 3000);
      const took = Date.now() - started;
      assert.ok(took >= quiet[name] - 100 && took < quiet[name] + 1500, `${name}: answered after ${took} ms`);
      const answer = parse(connection.text());
      assert.equal(answer.line, "HTTP/1.1 408 Request Timeout", name);
      assert.equal(answer.body, '{"error":"Upload timeout"}\n', name);
      assert.equal(answer.headers.connection, "close", name);
    }),
  );
  await server.alive("after the timeouts");
  assert.deepEqual(tree(server.dataDir), before, "nothing of the uploads is left");

  await t.test("a client that sends slowly, but sends, is waited for", async () => {
    const connection = await connect(server);
    await write(connection, head("POST", "/api/storage/write?path=/ext/slow.txt", { "Content-Length": 3 }));
    for (const byte of ["a", "b", "c"]) {
      await pause(1800);
      await write(connection, byte);
    }
    await connection.closed;
    assert.equal(parse(connection.text()).line, "HTTP/1.1 200 OK");
    assert.equal(readFileSync(join(server.barDir, "ext", "slow.txt"), "utf8"), "abc");
  });
});

test("the body of any other request is held up to the bar's 256 KiB; more closes the connection unanswered, and a cut-off one takes nothing down", async (t) => {
  const server = await serve(t);
  // A request of the bar's API with a body, one of the emulator's own, and one for the local web.
  const others = [
    ["the bar's API", "PUT", "/api/apps/settings?app_id=app.test.none"],
    ["the emulator's own", "POST", "/_emu/press?key=ok"],
    ["the local web", "POST", "/index.html"],
  ];
  for (const [name, method, path] of others) {
    await t.test(`${name}: a body the bar holds is answered`, async () => {
      const connection = await connect(server);
      await write(connection, head(method, path, { "Content-Length": 200 * 1024 }));
      await write(connection, Buffer.alloc(200 * 1024, 0x20));
      await until("an answer", () => connection.text().includes("\r\n\r\n"), 5000);
      assert.match(connection.text(), /^HTTP\/1\.1 \d{3} /);
      connection.socket.destroy();
    });
    await t.test(`${name}: a body larger than the bar holds closes the connection, unanswered`, async () => {
      const connection = await connect(server);
      await write(connection, head(method, path, { "Content-Length": 4 * MiB }));
      for (let i = 0; i < 8 && !connection.socket.destroyed; i++) await write(connection, Buffer.alloc(512 * 1024, 0x20));
      await connection.closed;
      assert.equal(connection.text(), "");
    });
    for (const how of ["closed", "reset"]) {
      await t.test(`${name}: cut off in the middle of the body, ${how}`, async () => {
        const connection = await connect(server);
        await write(connection, head(method, path, { "Content-Length": 100 * 1024 }));
        await write(connection, Buffer.alloc(50 * 1024, 0x20));
        await pause(30);
        if (how === "reset") connection.socket.resetAndDestroy();
        else connection.socket.destroy();
        await connection.closed;
        await server.alive(`${name}, ${how}`);
      });
    }
  }
});

test("the state stream: a client cut off in its upgrade or in a frame, or refused, takes nothing down; a frame larger than the bar holds closes the connection", async (t) => {
  const server = await serve(t);
  const upgrade = (path) => head("GET", path, { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": 13 });
  // A masked frame's head: FIN, the opcode, and a length in the form it needs.
  const frameHead = (opcode, length) => {
    if (length < 126) return Buffer.from([0x80 | opcode, 0x80 | length, 1, 2, 3, 4]);
    const head = Buffer.alloc(14);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
    head.set([1, 2, 3, 4], 10);
    return head;
  };

  await t.test("refused upgrades, reset at once by the client", async () => {
    for (const path of ["/nowhere", "/api/status/ws?no-key", "//[x"]) {
      for (let i = 0; i < 10; i++) {
        const connection = await connect(server);
        const text = path === "/api/status/ws?no-key" ? head("GET", path, { Connection: "Upgrade", Upgrade: "websocket" }) : upgrade(path);
        connection.socket.write(text);
        connection.socket.resetAndDestroy();
        await connection.closed;
      }
      await server.alive(`refused upgrades to ${path}`);
    }
  });

  for (const how of ["closed", "reset"]) {
    await t.test(`a client of the stream cut off in the middle of a frame, ${how}`, async () => {
      const connection = await connect(server);
      await write(connection, upgrade("/api/status/ws"));
      await until("the upgrade", () => connection.text().startsWith("HTTP/1.1 101 "), 5000);
      await write(connection, Buffer.concat([frameHead(1, 1000), Buffer.alloc(500)]));
      await pause(30);
      if (how === "reset") connection.socket.resetAndDestroy();
      else connection.socket.destroy();
      await connection.closed;
      await server.alive(`a frame cut off, ${how}`);
    });
  }

  await t.test("a frame larger than the bar holds", async () => {
    const connection = await connect(server);
    await write(connection, upgrade("/api/status/ws"));
    await until("the upgrade", () => connection.text().startsWith("HTTP/1.1 101 "), 5000);
    await write(connection, Buffer.concat([frameHead(1, 1024 * MiB), Buffer.alloc(64 * 1024)]));
    await closedWithin(connection, 3000);
    await server.alive("a frame too large");
  });
});

test("an upload goes into its file as it comes, not into the server's memory", async (t) => {
  const emulator = await startServer({ port: port(1), dataDir: tempDir(t), barSpeed: false });
  hostPort = emulator.port;
  t.after(() => emulator.stop());
  const length = 256 * MiB;
  const socket = net.connect(emulator.port, "127.0.0.1");
  await once(socket, "connect");
  let answer = "";
  socket.on("data", (bytes) => (answer += bytes));
  const closed = once(socket, "close");
  const start = process.memoryUsage().arrayBuffers;
  let most = 0;
  const watch = setInterval(() => (most = Math.max(most, process.memoryUsage().arrayBuffers - start)), 5);
  socket.write(head("POST", "/api/storage/write?path=/ext/big.bin", { "Content-Length": length }));
  const chunk = Buffer.alloc(MiB, 0x62);
  for (let sent = 0; sent < length; sent += chunk.length) if (!socket.write(chunk)) await once(socket, "drain");
  await closed;
  clearInterval(watch);
  assert.match(answer, /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(statSync(join(emulator.barDir, "ext", "big.bin")).size, length);
  assert.ok(most < 64 * MiB, `the server held ${Math.round(most / MiB)} MiB of a ${length / MiB} MiB upload at once`);
});

test("a stop in the middle of an upload undoes it, and leaves no timer or socket behind", async (t) => {
  const before = await activeResourcesAtRest();
  const errors = [];
  const emulator = await startServer({ port: port(1), dataDir: tempDir(t), barSpeed: false, onError: (e) => errors.push(e) });
  hostPort = emulator.port;
  t.after(() => emulator.stop());
  mkdirSync(join(emulator.barDir, "ext", "kept"), { recursive: true });
  writeFileSync(join(emulator.barDir, "ext", "kept", "file.txt"), "kept as it was");
  const uploads = [
    ["/api/storage/write?path=/ext/half/file.bin", join("ext", "half", "file.bin")],
    ["/api/storage/write?path=/ext/kept/file.txt&append=1", join("ext", "kept", "file.txt")],
    ["/api/assets/upload?application_name=app.test.half&file=half.bin", join("ext", "user_assets", "app.test.half", "half.bin")],
    ["/api/apps/stage", null],
  ];
  const sockets = await Promise.all(
    uploads.map(async ([path]) => {
      const socket = net.connect(emulator.port, "127.0.0.1");
      socket.on("error", () => {});
      await once(socket, "connect");
      socket.write(head("POST", path, { "Content-Length": 1000 }) + "x".repeat(500));
      return socket;
    }),
  );
  await until("the uploads to be under way", () => existsSync(join(emulator.barDir, uploads[0][1])) && statSync(join(emulator.barDir, uploads[0][1])).size === 500);
  await emulator.stop();
  await Promise.all(sockets.map((socket) => (socket.destroyed ? null : once(socket, "close"))));
  assert.ok(!existsSync(join(emulator.barDir, "ext", "half")), "the file being written, and the folder made for it, are gone");
  assert.equal(readFileSync(join(emulator.barDir, "ext", "kept", "file.txt"), "utf8"), "kept as it was", "the file being appended to is as it was");
  assert.ok(!existsSync(join(emulator.barDir, uploads[2][1])), "the asset being written is gone");
  assert.deepEqual(errors, []);
  assert.deepEqual(await activeResourcesSettled(before), before, "no socket or timer is left");
});

test("a file that an upload has open is not opened by another upload: it is refused 508, as on the bar, and the first one's undoing leaves the file alone", async (t) => {
  const server = await serve(t);
  for (const append of [false, true]) {
    await t.test(append ? "appending" : "written anew", async () => {
      const path = `/ext/same/${append ? "append" : "new"}.bin`;
      const query = `path=${path}${append ? "&append=1" : ""}`;
      if (append) assert.equal((await request("POST", `${server.base}/api/storage/write?path=${path}`, Buffer.from("BASE"))).status, 200);
      const first = await connect(server);
      await write(first, head("POST", `/api/storage/write?${query}`, { "Content-Length": MiB }));
      await write(first, Buffer.alloc(1024, 0x41));
      await until("the first upload to have begun", () => existsSync(join(server.barDir, "ext", "same", `${append ? "append" : "new"}.bin`)));
      // The same file, by another name case: the bar's file system does not tell them apart.
      const second = await request("POST", `${server.base}/api/storage/write?${query.replace("same", "SAME")}`, Buffer.from("second"));
      assert.equal(second.status, 508);
      assert.equal(second.text, '{"error":"Failed to open file for writing"}\n');
      first.socket.resetAndDestroy();
      await first.closed;
      await server.alive("after the first upload was cut off");
      const read = await get(`${server.base}/api/storage/read?path=${path}`);
      if (append) assert.equal(read.text, "BASE", "the file appended to is as it was");
      else assert.equal(read.status, 400, "the file written anew is gone");
      // Once the first is over, the file can be written again.
      assert.equal((await request("POST", `${server.base}/api/storage/write?${query}`, Buffer.from("third"))).status, 200);
      assert.equal((await get(`${server.base}/api/storage/read?path=${path}`)).text, append ? "BASEthird" : "third");
    });
  }
});

test("one package of each kind comes in at a time: another meanwhile is refused 508 from its headers, as on the bar", async (t) => {
  const server = await serve(t);
  for (const path of ["/api/apps/stage", "/api/update"]) {
    await t.test(path, async () => {
      const first = await connect(server);
      await write(first, head("POST", path, { "Content-Length": 50 * MiB }));
      await write(first, Buffer.alloc(MiB, 0x78));
      await pause(100);
      const second = await connect(server);
      await write(second, head("POST", path, { "Content-Length": 50 * MiB }));
      await closedWithin(second, 3000);
      const answer = parse(second.text());
      assert.equal(answer.line, "HTTP/1.1 508 Loop Detected");
      assert.equal(answer.body, '{"error":"Failed to save update package (file init error)."}\n');
      assert.equal(answer.headers.connection, "close");
      first.socket.destroy();
      await first.closed;
      await pause(50);
    });
  }
  // The first one over, the next is taken in.
  const staged = await request("POST", `${server.base}/api/apps/stage`, appPackage("app.test.after"));
  assert.equal(staged.status, 200);
  await server.alive("after the packages");
});

test("the body of another request may be 256 KiB with its request line and headers, and not a byte more", async (t) => {
  const server = await serve(t);
  // The request line and headers as written here, for a Content-Length of six digits.
  const headFor = (length) => head("POST", "/_emu/press?key=ok", { "Content-Length": length, Connection: "close" });
  const most = 256 * 1024 - headFor(100000).length;
  for (const [length, answered] of [[most, true], [most + 1, false]]) {
    const connection = await connect(server);
    await write(connection, Buffer.concat([Buffer.from(headFor(length)), Buffer.alloc(length, 0x20)]));
    await closedWithin(connection, 5000);
    if (answered) assert.match(connection.text(), /^HTTP\/1\.1 200 OK\r\n/, `${length} bytes of body are taken`);
    else assert.equal(connection.text(), "", `${length} bytes of body are too many`);
  }
});

test("a client that waits for 100 Continue is told to go on when its body is wanted", async (t) => {
  const server = await serve(t);
  const connection = await connect(server);
  await write(connection, head("POST", "/api/storage/write?path=/ext/continue.txt", { "Content-Length": 5, Expect: "100-continue" }));
  await until("100 Continue", () => connection.text().startsWith("HTTP/1.1 100 Continue\r\n\r\n"), 3000);
  await write(connection, "hello");
  await closedWithin(connection, 3000);
  assert.match(connection.text().slice("HTTP/1.1 100 Continue\r\n\r\n".length), /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(readFileSync(join(server.barDir, "ext", "continue.txt"), "utf8"), "hello");
});

test("a client that goes away while the server is still looking at its headers leaves no file open or behind", async (t) => {
  // Device's reception can take a while (a bar that restarts answers once it is up): it is held here until the
  // client has gone.
  const original = Device.prototype.reception;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  Device.prototype.reception = async function (...args) {
    await held;
    return original.apply(this, args);
  };
  t.after(() => (Device.prototype.reception = original));
  const emulator = await startServer({ port: port(1), dataDir: tempDir(t), barSpeed: false });
  hostPort = emulator.port;
  t.after(() => emulator.stop());
  const socket = net.connect(emulator.port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(head("POST", "/api/storage/write?path=/ext/gone/file.bin", { "Content-Length": 1000 }) + "x".repeat(100));
  await pause(50);
  socket.destroy();
  await pause(50);
  release();
  await pause(100);
  Device.prototype.reception = original;
  assert.ok(!existsSync(join(emulator.barDir, "ext", "gone")), "nothing of the upload is left");
  // Nor is the file still open: another upload may write it.
  assert.equal((await request("POST", `${emulator.url}/api/storage/write?path=/ext/gone/file.bin`, Buffer.from("next"))).status, 200);
});

test("the state stream: a control frame longer than 125 bytes is a protocol error, and a client that does not read is let go of", async (t) => {
  const emulator = await startServer({ port: port(1), dataDir: tempDir(t), barSpeed: false });
  hostPort = emulator.port;
  t.after(() => emulator.stop());
  const open = async () => {
    const socket = net.connect(emulator.port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(head("GET", "/api/status/ws", { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": 13 }));
    const [first] = await once(socket, "data");
    assert.match(String(first), /^HTTP\/1\.1 101 /);
    return socket;
  };
  // A masked ping (zero mask: the payload as it is) of `length` bytes, 125 at most in its short form.
  const ping = (length) => {
    const frameHead = length < 126 ? Buffer.from([0x89, 0x80 | length, 0, 0, 0, 0]) : Buffer.from([0x89, 0x80 | 126, length >> 8, length & 0xff, 0, 0, 0, 0]);
    return Buffer.concat([frameHead, Buffer.alloc(length, 0x70)]);
  };

  await t.test("a ping of 126 bytes: a closing frame with 1002, and the connection is closed", async () => {
    const socket = await open();
    let got = Buffer.alloc(0);
    socket.on("data", (bytes) => (got = Buffer.concat([got, bytes])));
    const closed = new Promise((resolve) => socket.once("close", resolve));
    socket.write(ping(126));
    await within(closed, 3000, "the connection is still open");
    assert.deepEqual([...got], [0x88, 0x02, 0x03, 0xea]);
  });

  await t.test("a ping of 125 bytes is answered", async () => {
    const socket = await open();
    socket.write(ping(125));
    const [pong] = await once(socket, "data");
    assert.deepEqual([...pong.subarray(0, 2)], [0x8a, 125]);
    socket.destroy();
  });

  await t.test("pings from a client that reads nothing: it is let go of, and the server does not hold its pongs", async () => {
    const socket = await open();
    socket.pause();
    const closed = new Promise((resolve) => socket.once("close", resolve));
    let ended = false;
    closed.then(() => (ended = true));
    socket.on("end", () => (ended = true));
    const start = process.memoryUsage().arrayBuffers;
    let most = 0;
    const pings = Buffer.concat(Array.from({ length: 1000 }, () => ping(125)));
    for (let sent = 0; sent < 64 * MiB && !ended; sent += pings.length) {
      if (!socket.write(pings)) await within(Promise.race([new Promise((resolve) => socket.once("drain", resolve)), closed]), 1000, "").catch(() => {});
      most = Math.max(most, process.memoryUsage().arrayBuffers - start);
    }
    socket.resume();
    await within(closed, 5000, "the server kept the client");
    assert.ok(most < 16 * MiB, `the server held ${Math.round(most / MiB)} MiB for a client that read nothing`);
  });
});

test("a request to end the command line (SIGTERM) stops the server the usual way: an upload under way is undone", { skip: process.platform === "win32" && "Windows has no SIGTERM to send a process: it is ended outright" }, async (t) => {
  const server = await serve(t);
  const connection = await connect(server);
  await write(connection, head("POST", "/api/storage/write?path=/ext/signal/file.bin", { "Content-Length": 1000 }));
  await write(connection, Buffer.alloc(500, 0x61));
  const file = join(server.barDir, "ext", "signal", "file.bin");
  await until("the upload to be under way", () => existsSync(file) && statSync(file).size === 500);
  server.child.kill("SIGTERM");
  assert.equal(await server.child.exited(10000), 143, `the exit code of a process ended by SIGTERM:\n${server.stderr()}`);
  assert.ok(!existsSync(join(server.barDir, "ext", "signal")), "the upload is undone");
});
