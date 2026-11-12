// Run by lifecycle.test.mjs in a process of its own:
//   node --expose-gc lifecycle.child.mjs <port> <data folder> [restart]
//
// Starts a server, keeps it busy, stops it — with "restart", while the bar is restarting — and reports what the
// server left in the process as one line of JSON:
//   left       what was made between the start and the end of the stop and is still there a moment later — timers
//              (those that do not keep the process running too), sockets, servers — each with where it was made
//   memory     megabytes outside the JS heap, where wasm instances keep their memory: before the start, while the
//              bar ran an app, and after the stop
// Then it returns without process.exit(): if anything of the server still kept the event loop busy, the process
// would not end, and the test would see that.
import { createHook } from "node:async_hooks";
import net from "node:net";

import { startServer } from "../../packages/server/server.mjs";
import { installApp, request, until } from "./helpers.mjs";

const [port, dataDir, scenario] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const turn = () => new Promise((resolve) => setImmediate(resolve));
const megabytes = () => {
  globalThis.gc();
  return process.memoryUsage().external / 1048576;
};

// Every async resource made while `watching`, until it is destroyed. Promises are left out (they are destroyed when
// collected, not when settled), and so is the DNS resolver Node makes once per process when a server first listens.
const live = new Map();
let watching = false;
createHook({
  init(id, type) {
    if (watching && type !== "PROMISE" && type !== "DNSCHANNEL") live.set(id, { type, made: new Error().stack.split("\n").slice(2).filter((line) => !line.includes("node:internal/async_hooks")).slice(0, 8).join("\n") });
  },
  destroy(id) {
    live.delete(id);
  },
}).enable();

const memory = { before: megabytes() };
watching = true;

const lines = [];
const emulator = await startServer({ port, dataDir, log: (line) => lines.push(line) });
const base = emulator.url;

// An app with a timer and requests to the bar's API always under way.
await installApp(base, "app.test.lifecycle", `
  setInterval(function () { fetch("http://localhost/api/status"); }, 50);
  console.log("the app is up");
`);
await request("POST", `${base}/api/apps/launch?app_id=app.test.lifecycle`);
await until("the app to run", () => lines.some((line) => line.includes("the app is up")));

// The device window's event stream and the state stream, switched on, as an open local web has them.
const open = (head, then = "") =>
  new Promise((resolve, reject) => {
    const socket = net.connect(emulator.port, "127.0.0.1", () => socket.write(head.join("\r\n") + "\r\n\r\n"));
    socket.on("error", () => {});
    socket.once("data", () => {
      if (then) socket.write(then);
      resolve(socket);
    });
    socket.once("error", reject);
  });
// A masked WebSocket text frame.
const text = (payload) => Buffer.concat([Buffer.from([0x81, 0x80 | payload.length, 0, 0, 0, 0]), Buffer.from(payload)]);
const sockets = [
  await open(["GET /_emu/events HTTP/1.1", `Host: localhost:${emulator.port}`]),
  await open(["GET /api/status/ws HTTP/1.1", `Host: localhost:${emulator.port}`, "Connection: Upgrade", "Upgrade: websocket", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"], text('{"enable":true}')),
];
// A button held down, a sound, the bar's clock set, a request the bar takes 3 s to answer.
await request("POST", `${base}/_emu/key?key=ok&action=down`);
await request("POST", `${base}/api/audio/volume?volume=30`);
request("POST", `${base}/api/account/link`).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 400));
memory.running = megabytes();

// A restart is a new screen module, loaded while the old one is already gone: the stop comes in between.
if (scenario === "restart") {
  const boots = lines.length;
  await request("POST", `${base}/_emu/power?action=restart`);
  if (!lines.slice(boots).some((line) => line.startsWith("The BUSY Bar restarts"))) throw new Error("the bar did not start to restart");
}
await emulator.stop();
watching = false;

// The other ends of the connections the server closed, which are this script's own, close a moment later.
await Promise.all(sockets.map((socket) => (socket.destroyed ? null : new Promise((resolve) => socket.once("close", resolve)))));
for (let i = 0; i < 50 && live.size; i++) await turn();
memory.after = megabytes();
for (let i = 0; i < 20 && memory.after > memory.before + 4; i++) {
  await turn();
  memory.after = megabytes();
}

// Not the server's: the second for which Node's http keeps the text of the Date header.
const left = [...live.values()].filter((one) => !/\bat utcDate \(node:internal\/http/.test(one.made));
console.log(JSON.stringify({ left, memory }));
