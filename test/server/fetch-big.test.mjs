// An app that fetches a response far larger than a bar can hold (the runtime hunt of 2026-11-12: a 200 MB body froze
// the server, its memory grew by hundreds of megabytes, SIGTERM went unanswered). The server as its command line runs
// it, at bar speed, with a service of this test's on this computer streaming 50 MB as fast as it can:
// - r.text(): the firmware collects the whole body before the app gets it, in a heap a bar has about a megabyte of
//   (runtime.mjs SYSTEM_HEAP_FREE_BYTES); the app ends as out of memory soon after that is full, and the server stops
//   reading the response;
// - a reader of r.body that takes each piece as it comes reads all of it: what waits is bounded per request
//   (FETCH_WAITING_BYTES), not the whole response;
// - all the while the server answers the bar's API within a second, its memory stays bounded, and SIGTERM ends it at
//   once.
import assert from "node:assert/strict";
import http from "node:http";
import { after, test as nodeTest } from "node:test";

import { execProgram } from "../../packages/engine/programs.mjs";
import { finish, get, installApp, node, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const test = (name, options, fn) => nodeTest(name, { timeout: 120_000, ...options }, fn);
const windows = process.platform === "win32";
const MB = 1 << 20;
const BODY = 50 * MB;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A service that streams `bytes` of "a" (Infinity: for ever) to every request, and counts what it got out. */
async function stream(t, bytes) {
  const it = { sent: 0 };
  const piece = Buffer.alloc(MB, 97);
  it.server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    const pump = () => {
      while (it.sent < bytes && !res.destroyed) {
        it.sent += piece.length;
        if (!res.write(piece)) return res.once("drain", pump);
      }
      res.end();
    };
    res.on("error", () => {});
    pump();
  });
  await new Promise((resolve) => it.server.listen(port(1), "127.0.0.1", resolve));
  it.port = it.server.address().port;
  t.after(() => {
    it.server.closeAllConnections();
    return new Promise((resolve) => it.server.close(resolve));
  });
  return it;
}

/** The server as its command line, at bar speed, on a data folder of its own, allowed to reach `allow`. */
async function serve(t, allow) {
  const child = node(t, [serverModule("index.mjs"), "--port", String(port(0)), "--data", tempDir(t), "--allow-local", String(allow)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (err += text));
  let ended = false;
  child.exit.then(() => (ended = true));
  const address = await until("the server's first line", () => /^BUSY Bar emulator: http:\/\/127\.0\.0\.1:(\d+) /.exec(out) ?? (ended && "ended"), 30000);
  assert.notEqual(address, "ended", `the server did not start: ${err}`);
  return { child, base: `http://127.0.0.1:${address[1]}`, out: () => out, err: () => err };
}

/** The server's resident memory, MB; null where `ps` cannot tell (Windows). */
function rss(pid) {
  if (windows) return null;
  return Number(execProgram("ps", ["-o", "rss=", "-p", String(pid)]).toString().trim()) / 1024;
}

/**
 * Asks the bar's API every 100 ms until `done()` gives true; returns the slowest answer, ms, and the most memory the
 * server had meanwhile, MB.
 */
async function watch(server, done, ms = 60000) {
  let slowest = 0;
  let memory = rss(server.child.pid);
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`no end within ${ms} ms:\n${server.out()}`);
    const asked = performance.now();
    assert.equal((await get(`${server.base}/api/version`)).status, 200);
    slowest = Math.max(slowest, performance.now() - asked);
    const now = rss(server.child.pid);
    if (now !== null) memory = Math.max(memory, now);
    await pause(100);
  }
  return { slowest, memory };
}

async function launch(server, id, script) {
  await installApp(server.base, id, script);
  assert.equal((await request("POST", `${server.base}/api/apps/launch?app_id=${id}`)).status, 200);
}

test("r.text() of a 50 MB response: the app ends as out of memory, the server answers within a second throughout", {}, async (t) => {
  const source = await stream(t, BODY);
  const server = await serve(t, source.port);
  const ID = "app.test.text";
  const before = rss(server.child.pid);
  await launch(server, ID, `
fetch("http://127.0.0.1:${source.port}/big").then(function (r) { console.log("status " + r.status); return r.text(); })
  .then(function (text) { console.log("length " + text.length); }, function (e) { console.log("error " + e); });
setInterval(function () {}, 1000);`);
  const { slowest, memory } = await watch(server, () => server.out().includes(`App ${ID} exited:`));
  assert.ok(slowest < 1000, `the slowest answer of the API took ${Math.round(slowest)} ms`);
  // The rest of the response is not read: what the service got out is the megabyte the app held and what the
  // connection's buffers took.
  await pause(500);
  assert.ok(source.sent <= 16 * MB, `the service sent ${source.sent / MB} MB`);
  if (before !== null) assert.ok(memory - before < 150, `the server's memory grew from ${Math.round(before)} to ${Math.round(memory)} MB`);
  assert.match(server.out(), new RegExp(`${ID} log: status 200`));
  assert.match(server.out(), /\[JsFetch\] out of memory: the firmware held over 1024 KiB of response data for the app/);
  assert.match(server.out(), new RegExp(`App ${ID} exited: fatal: out of memory;`));
  assert.match(server.out(), new RegExp(`App ${ID}: JS heap overflow: the supervisor takes over`));
  assert.doesNotMatch(server.out(), /length \d+/);
  assert.equal((await get(`${server.base}/api/version`)).status, 200);
  assert.equal(server.err(), "");
});

// The app's reader: each piece as it comes, no chain of promises kept.
const READER = (url) => `
var n = 0;
fetch(${JSON.stringify(url)}).then(function (r) {
  console.log("status " + r.status);
  var reader = r.body.getReader();
  function next() {
    reader.read().then(function (x) {
      if (x.done) return console.log("done " + n);
      n += x.value.length;
      next();
    }, function (e) { console.log("error " + e + " after " + n); });
  }
  next();
}, function (e) { console.log("error " + e); });
setInterval(function () {}, 1000);`;

test("a reader of a 50 MB response gets all of it, and the server answers within a second throughout", {}, async (t) => {
  const source = await stream(t, BODY);
  const server = await serve(t, source.port);
  const ID = "app.test.reader";
  const before = rss(server.child.pid);
  await launch(server, ID, READER(`http://127.0.0.1:${source.port}/big`));
  const { slowest, memory } = await watch(server, () => /log: (done|error)/.test(server.out()) || server.out().includes(`App ${ID} exited:`));
  assert.match(server.out(), new RegExp(`${ID} log: done ${BODY}`));
  assert.ok(slowest < 1000, `the slowest answer of the API took ${Math.round(slowest)} ms`);
  if (before !== null) assert.ok(memory - before < 150, `the server's memory grew from ${Math.round(before)} to ${Math.round(memory)} MB`);
  assert.equal(server.err(), "");
});

test("SIGTERM while an app reads an endless response ends the server at once", { skip: windows && "Windows has no signals to send to a process" }, async (t) => {
  const source = await stream(t, Infinity);
  const server = await serve(t, source.port);
  await launch(server, "app.test.endless", READER(`http://127.0.0.1:${source.port}/endless`));
  await until("the response under way", () => source.sent > 10 * MB, 30000);
  const asked = performance.now();
  server.child.kill("SIGTERM");
  assert.equal(await server.child.exited(10000), 143, server.err());
  const took = performance.now() - asked;
  assert.ok(took < 3000, `the server took ${Math.round(took)} ms to end`);
  assert.equal(server.err(), "");
});
