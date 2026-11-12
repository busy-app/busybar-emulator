// A stand-in for the emulator server in the shell's tests: a module with the server's startServer (the options it
// takes, the start that a signal calls off, stop()), and switches for the ways a server can go wrong. The switches
// come in FAKE_SERVER_* variables; it runs in the supervisor's process, as the server does.
//
//   FAKE_SERVER_DELAY_MS=<n>     wait before listening
//   FAKE_SERVER_WAIT_FOR=<file>  ... and until this file exists: a test lets the start end when it has seen what
//                                comes before, whatever the machine's load
//   FAKE_SERVER_FAIL=<text>      refuse to start, with the text as the reason
//   FAKE_SERVER_FAIL_CODE=<code> ... and this `code` on the error (EADDRINUSE: the server's own "port in use")
//   FAKE_SERVER_FAIL_TIMES=<n>   ... but only the first n starts (counted in a file in the data folder)
//   FAKE_SERVER_SILENT=1         listen, but never come to the end of the start
//   FAKE_SERVER_DIE_AFTER_MS=<n> the process ends with exit code 3 that long after it is ready, as a crash would
//   FAKE_SERVER_THROW_AFTER_MS=<n> an error nobody catches, that long after it is ready
//   FAKE_SERVER_CHILD=1          start a helper process that runs until the pipe from its parent closes, and is
//                                stopped by stop(): a server that minds what it started
//   FAKE_SERVER_CHILD=stubborn   start one that runs forever and that stop() forgets: what the process group is for
//   FAKE_SERVER_HANG_STOP=1      stop() never comes to its end
//   FAKE_SERVER_CONTROL_PORT=<n> name a management address in what the start gives, as the server does (EMU-009)
//   FAKE_SERVER_REPORT=<file>    write { pid, child, env, node, version, options } there once ready (env: the names of
//                                the variables it got; node and version: the Node it runs on; options: the names of
//                                the options it was given), and <file>.stopped once stop() is over
//
// Besides the page it serves /api/status, /emulator/go?to=<address> (a redirect), /emulator/file.bin (a download),
// /emulator/worker.js (a script for a service worker) and /ask?path=<folder>[&cancel=<ms>]: it asks the person through
// the `askPerson` it was started with, as the server's POST /_emu/trust does, and answers with what came back
// (cancel: it takes the question away after that long).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fake device window</title></head>
<body><h1 id="fake">Fake device window</h1><a id="out" href="https://example.com/" target="_blank">out</a></body></html>`;

/** Whole or not at all: a test that reads the file while it is being written must not find half of it. */
function writeWhole(file, text) {
  const draft = `${file}.${process.pid}`;
  writeFileSync(draft, text);
  try {
    renameSync(draft, file);
  } catch {
    // Windows refuses to replace a file that a reader has open just now; the plain write is the next best thing.
    writeFileSync(file, text);
    rmSync(draft, { force: true });
  }
}

function failing(env, dataDir) {
  if (!env.FAKE_SERVER_FAIL) return false;
  if (!env.FAKE_SERVER_FAIL_TIMES) return true;
  mkdirSync(dataDir, { recursive: true });
  const counter = path.join(dataDir, "fake-starts");
  const starts = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(starts + 1));
  return starts < Number(env.FAKE_SERVER_FAIL_TIMES);
}

const abortable = (signal, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

export async function startServer(options = {}) {
  const { port, dataDir, signal, log = () => {}, askPerson = null } = options;
  const env = process.env;
  signal?.throwIfAborted();
  await abortable(signal, Number(env.FAKE_SERVER_DELAY_MS ?? 0));
  if (env.FAKE_SERVER_WAIT_FOR) while (!existsSync(env.FAKE_SERVER_WAIT_FOR)) await abortable(signal, 20);
  if (failing(env, dataDir)) throw Object.assign(new Error(env.FAKE_SERVER_FAIL), env.FAKE_SERVER_FAIL_CODE ? { code: env.FAKE_SERVER_FAIL_CODE } : {});

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ fake: true, pid: process.pid }));
    }
    if (url.pathname === "/ask") {
      const abort = new AbortController();
      if (url.searchParams.has("cancel")) setTimeout(() => abort.abort(), Number(url.searchParams.get("cancel")));
      const asked = askPerson ? askPerson({ kind: url.searchParams.get("kind") ?? "trust-folder", path: url.searchParams.get("path") }, abort.signal) : Promise.resolve({ answer: "no askPerson" });
      return void asked.then((answer) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(answer));
      });
    }
    if (url.pathname === "/emulator/go") {
      // A redirect to wherever the test says.
      res.writeHead(302, { Location: url.searchParams.get("to") });
      return res.end();
    }
    if (url.pathname === "/emulator/file.bin") {
      // A file to download, from the window's own address.
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="file.bin"' });
      return res.end("bytes");
    }
    if (url.pathname === "/emulator/worker.js") {
      // A script a page could register as its service worker.
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end("self.addEventListener('fetch', () => {});");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));

  let child = null;
  if (env.FAKE_SERVER_CHILD === "stubborn") {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  } else if (env.FAKE_SERVER_CHILD) {
    child = spawn(process.execPath, ["-e", "process.stdin.on('end', () => process.exit(0)).resume(); setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  }
  if (env.FAKE_SERVER_REPORT) {
    writeWhole(env.FAKE_SERVER_REPORT, JSON.stringify({ pid: process.pid, child: child?.pid ?? null, env: Object.keys(env), node: process.execPath, version: process.version, options: Object.keys(options) }));
  }

  let stopping = null;
  const stop = () =>
    (stopping ??= (async () => {
      if (env.FAKE_SERVER_HANG_STOP) await new Promise(() => {});
      if (env.FAKE_SERVER_CHILD && env.FAKE_SERVER_CHILD !== "stubborn") child?.stdin.end();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      if (env.FAKE_SERVER_REPORT) writeFileSync(`${env.FAKE_SERVER_REPORT}.stopped`, "");
    })());

  if (env.FAKE_SERVER_SILENT) {
    // The start never ends: only the signal ends it, as a stop in the middle of a start.
    await new Promise((_resolve, reject) => {
      const off = () => stop().finally(() => reject(signal.reason));
      if (signal?.aborted) off();
      else signal?.addEventListener("abort", off, { once: true });
    });
  }
  signal?.addEventListener("abort", () => stop().catch(() => {}), { once: true });
  log("the fake bar is up");
  if (env.FAKE_SERVER_DIE_AFTER_MS) setTimeout(() => process.exit(3), Number(env.FAKE_SERVER_DIE_AFTER_MS));
  if (env.FAKE_SERVER_THROW_AFTER_MS) {
    setTimeout(() => {
      throw new Error("the fake failed by itself");
    }, Number(env.FAKE_SERVER_THROW_AFTER_MS));
  }
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    dataDir,
    firmware: { name: "fake", info: { firmware: "0" } },
    apiVersion: "0.0.0",
    ...(env.FAKE_SERVER_CONTROL_PORT ? { control: { port: Number(env.FAKE_SERVER_CONTROL_PORT), url: `http://127.0.0.1:${env.FAKE_SERVER_CONTROL_PORT}` } } : {}),
    stop,
  };
}
