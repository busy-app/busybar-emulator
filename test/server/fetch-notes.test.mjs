// The emulator's notes on an app's requests to the network (packages/server/network-notes.mjs), found with real
// public APIs on 12 Nov 2026 (net-live): a redirect the bar does not follow, a response that stops in its middle, a
// large response that runs the app out of memory, TextDecoder. The server as its command line runs it, at bar speed,
// against a service of this test's on this computer (allowed with --allow-local); never the internet.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test as nodeTest } from "node:test";

import { loadFirmware } from "../../packages/server/firmware.mjs";
import { finish, get, installApp, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 90_000 }, fn);

/** A service with the cases: a redirect, a response that stalls after its first byte, a large JSON. */
async function service(t) {
  const it = {};
  it.server = http.createServer((req, res) => {
    res.on("error", () => {});
    if (req.url === "/moved") {
      res.writeHead(301, { Location: `https://example.invalid/data`, "Content-Type": "text/html", "Content-Length": 20 });
      return res.end("<html>moved</html>\r\n");
    }
    if (req.url === "/stall") {
      // The head and one byte, then nothing: a stream whose next event is more than 5 s away.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.write("x");
    }
    if (req.url === "/big") {
      const items = [];
      for (let i = 0; i < 4000; i++) items.push({ id: i, name: `item number ${i}`, value: i * 1.5 });
      const body = JSON.stringify(items);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      return res.end(body);
    }
    res.writeHead(404, { "Content-Length": 0 });
    res.end();
  });
  await new Promise((resolve) => it.server.listen(port(1), "127.0.0.1", resolve));
  it.port = it.server.address().port;
  t.after(() => {
    it.server.closeAllConnections();
    return new Promise((resolve) => it.server.close(resolve));
  });
  return it;
}

/** The server as its command line, at bar speed, allowed to reach `allow`. */
async function serve(t, allow, firmware) {
  const child = node(t, [serverModule("index.mjs"), "--port", String(port(0)), "--data", tempDir(t), "--allow-local", String(allow), "--firmware", firmware], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (err += text));
  let ended = false;
  child.exit.then(() => (ended = true));
  const address = await until("the server's first line", () => /^BUSY Bar emulator: http:\/\/127\.0\.0\.1:(\d+) /.exec(out) ?? (ended && "ended"), 30000);
  assert.notEqual(address, "ended", `the server did not start: ${err}`);
  return { base: `http://127.0.0.1:${address[1]}`, out: () => out, err: () => err };
}

async function launch(server, id, script) {
  await installApp(server.base, id, script);
  assert.equal((await request("POST", `${server.base}/api/apps/launch?app_id=${id}`)).status, 200);
}

// Each firmware: the notes are the emulator's, what the app gets is its firmware's.
for (const firmware of loadFirmware().versions) {
  test(`${firmware}: a redirect: the app gets the 301, and the log names where it points and says the BUSY Bar does not follow it`, async (t) => {
    const source = await service(t);
    const server = await serve(t, source.port, firmware);
    const ID = "app.test.moved";
    await launch(server, ID, `
fetch("http://127.0.0.1:${source.port}/moved").then(function (r) { console.log("status " + r.status); return r.json(); })
  .then(function () { console.log("parsed"); }, function (e) { console.log("error " + e); });
setInterval(function () {}, 1000);`);
    await until("the app's end of it", () => /log: (parsed|error)/.test(server.out()), 30000);
    assert.match(server.out(), new RegExp(`${ID} log: status 301`));
    const note = `App ${ID}: emulator: GET http://127.0.0.1:${source.port}/moved answered 301, a redirect to https://example.invalid/data. A BUSY Bar does not follow redirects`;
    assert.ok(server.out().includes(note), server.out());
    assert.match(server.out(), /\(https: the server does not answer over plain http\)/);
    // Said once, before the app's own line about it.
    assert.equal(server.out().split(note).length, 2);
    assert.ok(server.out().indexOf(note) < server.out().indexOf(`${ID} log: status 301`));
    assert.equal(server.err(), "");
  });

  test(`${firmware}: a response that stops after its head: the reader ends with done and the error text, and the log explains it`, async (t) => {
    const source = await service(t);
    const server = await serve(t, source.port, firmware);
    const ID = "app.test.stall";
    await launch(server, ID, `
fetch("http://127.0.0.1:${source.port}/stall").then(function (r) {
  var reader = r.body.getReader();
  reader.closed.then(null, function (e) { console.log("closed " + String(e)); });
  function next() {
    reader.read().then(function (x) {
      if (x.done) return console.log("done " + x.value);
      console.log("got " + x.value.length);
      next();
    }, function (e) { console.log("read error " + e); });
  }
  next();
}, function (e) { console.log("error " + e); });
setInterval(function () {}, 1000);`);
    await until("the end of the stream", () => /log: (done|read error|error)/.test(server.out()), 30000);
    // The firmware's js_readable_stream.c: no rejection, a done with the error's text, and reader.closed rejected: with
    // the string "cancelled" on 1.3.1 (checked on a bar), with TypeError("Stream error") since 7afbacbd and d111b6e1 on
    // 1.4.1 (by its code; not checked on a bar).
    assert.match(server.out(), new RegExp(`${ID} log: got 1`));
    assert.match(server.out(), new RegExp(`${ID} log: done Inactivity timeout`));
    const closed = { "1.3.1": "cancelled", "1.4.1": "TypeError: Stream error" }[firmware];
    await until("reader.closed", () => server.out().includes(`${ID} log: closed ${closed}`), 5000);
    assert.ok(
      server.out().includes(`App ${ID}: emulator: GET http://127.0.0.1:${source.port}/stall ended after 1 byte of its body with "Inactivity timeout": no data came for 5 s`),
      server.out(),
    );
    assert.match(server.out(), /a reader of res\.body gets \{ done: true, value: "Inactivity timeout" \}, not an error/);
    // The note says what this firmware does, as the app's own line above shows it.
    const said = { "1.3.1": 'reject with this string; a reader', "1.4.1": 'reject with a TypeError with this message; a reader' }[firmware];
    assert.ok(server.out().includes(said), server.out());
    assert.ok(server.out().includes(`reader.closed rejects with ${{ "1.3.1": '"cancelled"', "1.4.1": 'TypeError("Stream error")' }[firmware]}`), server.out());
    assert.equal(server.err(), "");
  });

  test(`${firmware}: res.json() of a large response runs the app out of memory, and the log names the response and what to do`, async (t) => {
    const source = await service(t);
    const server = await serve(t, source.port, firmware);
    const ID = "app.test.bigjson";
    await launch(server, ID, `
fetch("http://127.0.0.1:${source.port}/big").then(function (r) { console.log("status " + r.status); return r.json(); })
  .then(function (x) { console.log("items " + x.length); }, function (e) { console.log("error " + e); });
setInterval(function () {}, 1000);`);
    await until("the app's end", () => server.out().includes(`App ${ID} exited:`), 30000);
    const note = new RegExp(`App ${ID}: emulator: the app ran out of its 128 KiB heap after a (\\d+) KiB response to GET http://127\\.0\\.0\\.1:${source.port}/big\\. .*res\\.body\\.getReader\\(\\)`);
    // The lines after the end come in pieces of the server's output of their own: the test read the log between them
    // twice (17.11, EMU-330: once before "JS heap overflow", once before the note).
    await until("the emulator's note after the end", () => note.test(server.out()), 10000).catch(() => {});
    assert.match(server.out(), new RegExp(`App ${ID} exited: fatal: out of memory;`));
    assert.match(server.out(), new RegExp(`App ${ID}: JS heap overflow`));
    const said = note.exec(server.out());
    assert.ok(said, server.out());
    assert.ok(Number(said[1]) >= 150 && Number(said[1]) <= 250, `the note names ${said[1]} KiB`);
    assert.doesNotMatch(server.out(), /log: items/);
    assert.equal(server.err(), "");
  });

  test(`${firmware}: TextDecoder, which the BUSY Bar's JS lacks: the app's error, then the emulator's note on what to use`, async (t) => {
    const server = await serve(t, 1, firmware);
    const ID = "app.test.decoder";
    await launch(server, ID, `
try { new TextDecoder(); } catch (e) { console.error(String(e)); }
setInterval(function () {}, 1000);`);
    await until("the note", () => server.out().includes(`App ${ID}: emulator: the BUSY Bar's JS has no TextDecoder or TextEncoder`), 30000);
    assert.match(server.out(), /String\.fromCharCode\(\.\.\.bytes\) for ASCII/);
    assert.equal((await get(`${server.base}/api/version`)).status, 200);
    assert.equal(server.err(), "");
  });
}
