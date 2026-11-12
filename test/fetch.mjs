// An app's requests to the network, against a server of this test's own: what the firmware's lib/fetch does and the
// emulator's client (packages/server/http-client.mjs) repeats — HTTP/1.0, the firmware's headers, no redirects, the body as it
// comes, "Inactivity timeout" after 5 s without body data, "Incomplete response body".
//
//   node emulator/test/fetch.mjs [--firmware dev]    in the emulator's runtime (the firmware's own, as for the server)
//   node emulator/test/fetch.mjs --bar [10.0.4.20]   the same app on a bar, which must reach this computer
//   node emulator/test/fetch.mjs --bar --record      the same, and the bar's answers to the odd URLs saved to
//                                                     test/fetch/bar-<firmware>.json
//   ... --online                                      also the URL with a name in capitals, to a public echo service
//                                                     (httpbin.org); always on a bar
//
// What is compared with a bar. Most checks are the firmware's rules (lib/fetch), checked in the runtime here and on a
// bar with --bar; a gate run has no bar. The odd URLs (a space, Cyrillic, `..`, a fragment, a quote, a query with no
// path) are compared with the bar's recorded answers, test/fetch/bar-<firmware>.json, when there is one: what the
// server received (the request line and the Host header) or the error, byte for byte. Without a recording they are
// checked against what the firmware's source says (FIRMWARE_URLS below), and the line says so.
//
// On a bar the app is installed, run and removed; its results come back through its localStorage, and the server
// listens on this computer's address on the bar's network. In the emulator the server listens on the loopback only
// (nothing reachable from the network, no firewall question on Windows). "localhost" and 127.0.0.1 in an app are the
// bar itself (packages/server/runtime.mjs), so the app is given another loopback address: 127.0.0.2 where the system
// answers on all of 127.0.0.0/8 (Windows, Linux); on macOS, where only 127.0.0.1 is set up, 0.0.0.0, which macOS
// delivers to 127.0.0.1. An app may not reach this computer unless its port is allowed (local-access.mjs, as
// --allow-local does): the test allows its server's port, and port 1 for the closed port the client must meet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";
import { loadFirmware } from "../packages/server/firmware.mjs";
import { probeSource } from "../packages/server/bar-speed.mjs";
import { createLocalAccess } from "../packages/server/local-access.mjs";
import { AppRuntime } from "../packages/server/runtime.mjs";
import { totals } from "./own-emulator.mjs";
import { targz } from "./package.mjs";

const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--firmware"], optional: ["--bar"], flags: ["--record", "--online"] });
// --bar takes the word after it as the bar's address unless that is another option (arguments.mjs).
const barWord = args[args.indexOf("--bar") + 1];
const bar = args.includes("--bar") ? (barWord !== undefined && !barWord.startsWith("-") ? barWord : "10.0.4.20") : null;
const firmware = loadFirmware(args.includes("--firmware") ? args[args.indexOf("--firmware") + 1] : process.env.EMU_FIRMWARE);
const record = args.includes("--record");
if (record && !bar) throw new Error("--record records a bar: give --bar too");
const online = Boolean(bar) || args.includes("--online");
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


/** A loopback address other than 127.0.0.1 that an app can be given, and where to listen for it. */
async function loopback() {
  for (const [listen, ask] of [["127.0.0.2", "127.0.0.2"], ["127.0.0.1", "0.0.0.0"]]) {
    const probe = net.createServer((socket) => socket.destroy());
    const port = await new Promise((resolve) => probe.once("error", () => resolve(null)).listen(0, listen, () => resolve(probe.address().port)));
    const reached =
      port !== null &&
      (await new Promise((resolve) => {
        const socket = net.connect({ host: ask, port }, () => (socket.destroy(), resolve(true)));
        socket.once("error", () => resolve(false));
      }));
    await new Promise((resolve) => (port === null ? resolve() : probe.close(resolve)));
    if (reached) return { listen, ask };
  }
  throw new Error("no loopback address for the app's requests: neither 127.0.0.2 nor 0.0.0.0 reaches this computer");
}

let listen;
let address;
if (bar) {
  // This computer's address on the bar's network.
  const addresses = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
  address = addresses.find((a) => a.split(".").slice(0, 3).join(".") === bar.split(".").slice(0, 3).join("."));
  if (!address) throw new Error(`this computer has no address on the network of the bar ${bar}`);
  listen = "0.0.0.0";
} else {
  ({ listen, ask: address } = await loopback());
}

const seen = {};
// A raw server: the test needs the request as it was sent and answers a Node http server would not give.
const server = net.createServer((socket) => {
  let text = "";
  socket.on("error", () => {});
  socket.on("data", (d) => {
    text += d.toString("latin1");
    if (!text.includes("\r\n\r\n")) return;
    const path = text.split(" ")[1];
    // By method too: the GET and the POST to /ok race each other, and either may come last.
    seen[path] = text;
    seen[`${text.split(" ")[0]} ${path}`] = text;
    const reply = (head, body = "") => socket.write(`HTTP/1.1 ${head}\r\n\r\n${body}`);
    // The odd URLs: what came, the request line and the Host header, as the body (latin1 both ways: bytes as sent).
    if (path.startsWith("/u/") || path === "/") {
      const echo = Buffer.from(text.split("\r\n").slice(0, 2).join("\n"), "latin1");
      return socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${echo.length}\r\n\r\n`), echo]));
    }
    if (path === "/ok") return socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello`);
    if (path === "/redirect") return socket.end(`HTTP/1.1 302 Found\r\nLocation: /ok\r\nContent-Length: 0\r\n\r\n`);
    if (path === "/short") return socket.end(`HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nhello`);
    // No Content-Length: the body ends when the connection does. A piece a second, as a streamed answer comes.
    if (path === "/stream") {
      reply("200 OK\r\nContent-Type: text/plain");
      let n = 0;
      const tick = setInterval(() => {
        socket.write(`piece${n++};`);
        if (n === 7) {
          clearInterval(tick);
          socket.end();
        }
      }, 1000);
      return;
    }
    // The head at once, the body never.
    if (path === "/stall") return reply("200 OK\r\nContent-Length: 5");
    // Thinks for 7 s before the first byte.
    if (path === "/slow") return setTimeout(() => socket.end(`HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nlate`), 7000);
    socket.end(`HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n`);
  });
});
await new Promise((r) => server.listen(0, listen, r));
const base = `http://${address}:${server.address().port}`;

// The odd URLs: {host} is this computer's address the app is given, {port} the server's port. The server answers with
// the request line and the Host header it received.
// Cyrillic letters by their code points: the public tree carries no Cyrillic text (npm run check:export).
const cyrillic = (...codes) => String.fromCodePoint(...codes);
const URLS = {
  "url-space": "http://{host}:{port}/u/a b",
  "url-cyrillic-path": `http://{host}:{port}/u/${cyrillic(0x43f, 0x443, 0x442, 0x44c)}`,
  "url-cyrillic-query": `http://{host}:{port}/u/q?city=${cyrillic(0x41c, 0x43e, 0x441, 0x43a, 0x432, 0x430)}`,
  "url-encoded": "http://{host}:{port}/u/%D0%BF?city=%D0%9C&x=a%20b",
  "url-dots": "http://{host}:{port}/u/a/../b/./c",
  "url-dots-encoded": "http://{host}:{port}/u/a/%2e%2e/b",
  "url-fragment": "http://{host}:{port}/u/f?x=1#part",
  "url-quote": "http://{host}:{port}/u/q?name='x'",
  "url-no-path": "http://{host}:{port}?x=1",
  "url-userinfo": "http://user:pw@{host}:{port}/u/userinfo",
  "url-scheme-capitals": "HTTP://{host}:{port}/u/scheme",
};
// A name in capitals needs a name, so a public echo service; what it saw of the Host header and the path comes back.
// (Only the name: the service refuses a raw `..` or `#` in the path.)
const ONLINE_URL = "http://HTTPBIN.ORG/anything/name-in-capitals";
// What the firmware's source says (busybar-firmware applications/services/js_runner/js_fetch.c: a URL with a character
// outside RFC 3986 is "Invalid URL"; lib/fetch/fetch.c and mongoose's src/url.c: the rest goes out as written).
const FIRMWARE_URLS = {
  "url-space": { error: "Invalid URL" },
  "url-cyrillic-path": { error: "Invalid URL" },
  "url-cyrillic-query": { error: "Invalid URL" },
  "url-encoded": { status: 200, text: "GET /u/%D0%BF?city=%D0%9C&x=a%20b HTTP/1.0\nHost: {host}" },
  "url-dots": { status: 200, text: "GET /u/a/../b/./c HTTP/1.0\nHost: {host}" },
  "url-dots-encoded": { status: 200, text: "GET /u/a/%2e%2e/b HTTP/1.0\nHost: {host}" },
  "url-fragment": { status: 200, text: "GET /u/f?x=1#part HTTP/1.0\nHost: {host}" },
  "url-quote": { status: 200, text: "GET /u/q?name='x' HTTP/1.0\nHost: {host}" },
  "url-no-path": { status: 200, text: "GET / HTTP/1.0\nHost: {host}" },
  "url-userinfo": { status: 200, text: "GET /u/userinfo HTTP/1.0\nHost: {host}" },
  "url-scheme-capitals": { status: 200, text: "GET /u/scheme HTTP/1.0\nHost: {host}" },
  "url-name-capitals": { status: 200, host: "HTTPBIN.ORG", url: "http://HTTPBIN.ORG/anything/name-in-capitals" },
};
const serverPort = server.address().port;
// A value with this computer's address and the server's port put back as {host} and {port}: the same on a bar and here.
const general = (value) => JSON.parse(JSON.stringify(value).replaceAll(`${address}:${serverPort}`, "{host}:{port}").replaceAll(address, "{host}"));

const SCRIPT = `
const base = ${JSON.stringify(base)};
const t0 = Date.now();
const all = [];
const report = (name, value) => {
  all.push({ name, ms: Date.now() - t0, value });
  console.log(JSON.stringify(all[all.length - 1]));
  localStorage.setItem("fetch", JSON.stringify(all));
};
const run = (name, path, init, read) =>
  fetch(base + path, init)
    .then((r) => (read ? read(r) : r.text().then((text) => ({ status: r.status, text }))))
    .then((value) => report(name, value), (e) => report(name, { error: String(e && e.message !== undefined ? e.message : e) }));
run("ok", "/ok");
run("post", "/ok", { method: "POST", headers: { "X-Test": "1" }, body: "abc" });
run("redirect", "/redirect", undefined, (r) => r.text().then((text) => ({ status: r.status, location: r.headers.get("location"), text })));
run("short", "/short");
run("stall", "/stall");
run("slow", "/slow");
// The pieces of a streamed body, with the time each came.
run("stream", "/stream", undefined, (r) => {
  const reader = r.body.getReader();
  const times = [];
  let text = "";
  const pump = () =>
    reader.read().then((part) => {
      if (part.done) return { status: r.status, pieces: times.length, firstMs: times[0], lastMs: times[times.length - 1], text };
      times.push(Date.now() - t0);
      // The runtime has no TextDecoder.
      for (let i = 0; i < part.value.length; i++) text += String.fromCharCode(part.value[i]);
      return pump();
    });
  return pump();
});
fetch("http://${address}:1/").then(() => report("refused", "answered"), (e) => report("refused", { error: String(e && e.message !== undefined ? e.message : e) }));
// The odd URLs, one after another (the "/" of the one without a path is the server's only "/").
const urls = ${JSON.stringify(Object.entries(URLS).map(([name, url]) => [name, url.replaceAll("{host}", address).replaceAll("{port}", String(serverPort))]))};
const odd = (i) => {
  if (i >= urls.length) return;
  const [name, url] = urls[i];
  // The runtime throws on some URLs before fetch returns a promise.
  let p;
  try {
    p = fetch(url);
  } catch (e) {
    p = Promise.reject(e);
  }
  p.then((r) => r.text().then((text) => ({ status: r.status, text })))
    .then((value) => report(name, value), (e) => report(name, { error: String(e && e.message !== undefined ? e.message : e) }))
    .then(() => odd(i + 1));
};
odd(0);
${online ? `fetch(${JSON.stringify(ONLINE_URL)}).then((r) => r.json().then((j) => ({ status: r.status, host: j.headers && j.headers.Host, url: j.url })))
  .then((value) => report("url-name-capitals", value), (e) => report("url-name-capitals", { error: String(e && e.message !== undefined ? e.message : e) }));` : ""}
`;

const APP = "app.probe.fetch";
const COUNT = 8 + Object.keys(URLS).length + (online ? 1 : 0);
const results = {};
if (bar) {
  const api = async (method, path, body) => {
    const res = await fetch(`http://${bar}/api/${path}`, { method, body });
    return { status: res.status, text: await res.text() };
  };
  const manifest = { format_version: 1, id: APP, name: "Fetch probe", version: "0.1.0", api_version: "27.14.0", description: "Checks how fetch behaves", debug: true };
  const staged = JSON.parse((await api("POST", "apps/stage", targz({ [`${APP}/appmeta/manifest.json`]: JSON.stringify(manifest), [`${APP}/scripts/main.js`]: SCRIPT }))).text);
  if (!staged.install_key) throw new Error(`stage: ${JSON.stringify(staged)}`);
  await api("POST", "apps/quit");
  const installed = await api("POST", `apps/install?install_key=${staged.install_key}`);
  if (installed.status !== 200) throw new Error(`install: ${installed.text}`);
  await sleep(500);
  const storage = `/ext/apps_data/jsrunner/${APP}.localstorage.json`;
  await api("DELETE", `storage/remove?path=${storage}`);
  const launched = await api("POST", `apps/launch?app_id=${APP}`);
  if (launched.status !== 200) throw new Error(`launch: ${launched.text}`);
  for (let i = 0; i < 30 && Object.keys(results).length < COUNT; i++) {
    await sleep(1000);
    const file = await api("GET", `storage/read?path=${storage}`);
    if (file.status !== 200) continue;
    for (const one of JSON.parse(JSON.parse(file.text).data?.fetch ?? "[]")) results[one.name] = one;
  }
  await api("POST", "apps/quit");
  await api("DELETE", `apps?app_id=${APP}`);
  await api("DELETE", `storage/remove?path=${storage}`);
} else {
  await new Promise((resolve, reject) => {
    const store = {};
    const runtime = new AppRuntime({
      firmware,
      appId: APP,
      heapKib: 128,
      entry: "/test.js",
      readFile: (p) => (p === "/test.js" ? new TextEncoder().encode(SCRIPT) : store[p] ?? null),
      writeFile: (p, bytes) => ((store[p] = bytes), true),
      localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
      localAccess: createLocalAccess({ allow: [server.address().port, 1] }),
      onConsole: (severity, text) => {
        try {
          const one = JSON.parse(text);
          results[one.name] = one;
        } catch {
          console.log(`app ${severity}: ${text}`);
        }
      },
      onLog: (level, tag, text) => level <= 2 && console.log(`[${tag}] ${text}`),
      onExit: (reason) => (reason === "finished" ? resolve() : reject(new Error(reason))),
    });
    runtime.start().catch(reject);
    setTimeout(() => reject(new Error("the app did not finish in 30 s")), 30000).unref();
  });
}
server.close();

console.log(bar ? `fetch on the bar ${bar}, server ${base}` : `fetch in the emulator's runtime, server ${base}`);
let failed = 0;
let passed = 0;
const check = (name, ok, what) => {
  if (!ok) failed++;
  else passed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: ${what}${ok ? "" : `   got ${JSON.stringify(results[name])}`}`);
};
const r = results;
const plain = seen["GET /ok"] ?? "";
const request = seen["POST /ok"] ?? "";
check("ok", r.ok?.value?.status === 200 && r.ok.value.text === "hello", "a plain answer");
check("ok", /^GET \/ok HTTP\/1\.0\r\n/.test(plain) && /\r\nConnection: close\r\n/.test(plain) && /\r\nUser-Agent: Mozilla\/5\.0 /.test(plain) && !/accept-encoding/i.test(plain), "HTTP/1.0 with the firmware's headers, no Accept-Encoding");
check("post", r.post?.value?.status === 200 && /\r\nContent-length: 3\r\n/.test(request) && /\r\nX-Test: 1\r\n/i.test(request) && /\r\nX-busybar-fetch: js\r\n/i.test(request) && request.endsWith("\r\n\r\nabc"), "a POST carries its body, the app's header and the firmware's mark");
check("redirect", r.redirect?.value?.status === 302 && r.redirect.value.location === "/ok", "a redirect is not followed");
check("short", r.short?.value?.error !== undefined, "a body shorter than Content-Length is an error");
check("stall", r.stall?.value?.error !== undefined && r.stall.ms >= 4900 && r.stall.ms < 7500, "5 s without body data end the request");
check("slow", r.slow?.value?.error !== undefined && r.slow.ms >= 4900 && r.slow.ms < 7500, "a server that thinks for 7 s times out at 5 s");
check("stream", r.stream?.value?.pieces >= 6 && r.stream.value.lastMs - r.stream.value.firstMs > 4500 && r.stream.value.text.endsWith("piece6;"), "a streamed body comes piece by piece, past 5 s in all");
check("refused", r.refused?.value?.error !== undefined, "a closed port is an error");
// The odd URLs: against the bar's recording for this firmware if there is one, else against the firmware's source.
const recordFile = join(here, "fetch", `bar-${firmware.version}.json`);
const recording = !bar && existsSync(recordFile) ? JSON.parse(readFileSync(recordFile, "utf8")) : null;
const want = recording?.urls ?? FIRMWARE_URLS;
const against = bar ? "the firmware's source, on the bar" : recording ? `the bar's recorded answer (${recording.source.bar})` : "the firmware's source (no recording of a bar for this firmware)";
for (const name of Object.keys(URLS)) {
  const got = r[name] ? general(r[name].value) : undefined;
  const ok = JSON.stringify(got) === JSON.stringify(want[name]);
  check(name, ok, `${JSON.stringify(URLS[name])} as ${against}${ok ? "" : `; wanted ${JSON.stringify(want[name])}`}`);
}
if (online) {
  const ok = JSON.stringify(r["url-name-capitals"]?.value) === JSON.stringify(want["url-name-capitals"]);
  check("url-name-capitals", ok, `${JSON.stringify(ONLINE_URL)} as ${against}${ok ? "" : `; wanted ${JSON.stringify(want["url-name-capitals"])}`}`);
} else {
  console.log("  (not run) url-name-capitals: a name in capitals needs a public echo service; --online runs it");
}
if (record) {
  const fw = JSON.parse(await (await fetch(`http://${bar}/api/status/firmware`)).text());
  const urls = Object.fromEntries(Object.keys(URLS).map((name) => [name, r[name] ? general(r[name].value) : null]));
  if (r["url-name-capitals"]) urls["url-name-capitals"] = r["url-name-capitals"].value;
  mkdirSync(dirname(join(here, "fetch", "x")), { recursive: true });
  const file = join(here, "fetch", `bar-${fw.version}.json`);
  writeFileSync(file, JSON.stringify({ source: probeSource(fw), urls }, null, 2) + "\n");
  console.log(`recorded: ${file}`);
}
// Without Wi-Fi (the device window's switch) a request to the network fails; only the emulator is asked.
if (!bar) {
  let offline;
  await new Promise((resolve) => {
    const runtime = new AppRuntime({
      firmware,
      appId: APP,
      heapKib: 64,
      entry: "/offline.js",
      readFile: (p) => (p === "/offline.js" ? new TextEncoder().encode(`fetch(${JSON.stringify(base + "/ok")}).then(() => console.log("answered"), (e) => console.log(String(e && e.message !== undefined ? e.message : e)));`) : null),
      writeFile: () => false,
      localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
      online: () => false,
      onConsole: (severity, text) => (offline = text),
      onLog: () => {},
      onExit: resolve,
    });
    runtime.start();
  });
  results.offline = { name: "offline", value: offline };
  check("offline", offline === "Failed to connect to server", "without Wi-Fi a request to the network fails");
}
console.log(failed ? `${failed} checks failed` : "all checks passed");
console.log(Object.values(results).map((x) => `    ${x.name} ${x.ms} ms ${JSON.stringify(x.value)}`).join("\n"));
totals({ pass: passed, fail: failed });
process.exit(process.exitCode);
