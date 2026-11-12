// The emulator server as a program starts and stops it: the bar's HTTP API on this computer, backed by the firmware's
// JS runtime and screen code in wasm.
//
//   const emulator = await startServer({ port: 0, dataDir, firmware: "1.3.1" });
//   ... http://127.0.0.1:<emulator.port>/api/...
//   await emulator.stop();
//
// Importing this module, or any other module of this folder except the command line (index.mjs), starts nothing and
// reads neither the command line nor the environment: everything a server needs is in startServer's options. Several
// servers, each with its own port, data folder and firmware, run in one process.
//
// A server listens on two addresses of this computer (ADR-0012 section 1):
//   the bar's      (`port`)        /api/*, the state stream /api/status/ws and the bar's local web: what a bar has; and,
//                                  while the present device window lives, its page /emulator and the old /_emu/* paths
//                                  below (the temporary exception of ADR-0012 section 1, removed by EMU-070)
//   management     (`controlPort`) /_emu/*, for tools that send the server's key (server-key.mjs); nothing else
// Before anything else is done with a request — before its body is read — the entry guard (entry-guard.mjs) looks at
// its Host and Origin, on both addresses and on the state stream's WebSocket alike, and refuses with 403 what does not
// come from this emulator's own address, a program on this computer or an origin named at the start.
//
// The old /_emu/* paths, on both addresses (the device window's are in device-window.mjs):
//   GET  /_emu/state                  running app, its heap and timing; the system's clock and tick count
//   POST /_emu/press?key=start[&long=1]   a key as the hardware produces it (long back = force quit)
// None of them does anything outside the emulated bar: no file outside the emulator's data, no process.
//
// One path is the management address's alone: the ports of this computer that apps on the bar may reach (ADR-0012
// section 5, local-access.mjs), a consent of the person's. Only a program that sends the server's key and no Origin
// gives it; a page never does, whatever right it holds (the window's included), and the bar's address does not have
// the path at all:
//   GET    /_emu/local-ports              { ports: [3000, ...] }
//   POST   /_emu/local-ports?port=3000    apps may reach port 3000 of this computer from now on; with the desktop app
//                                         the person is asked first, in its dialog (audit, 11.11), as for trust
//   DELETE /_emu/local-ports?port=3000    not any more
// And the question whether the person trusts a project folder (ADR-0012 section 4), for the same kind of caller:
//   POST   /_emu/trust?folder=<path>      the app asks the person in a dialog of its own; a yes is remembered
// And publishing to GitHub, stage 2 (busy-emulator publish signin|signout|push|pr): the desktop app holds the person's
// token and makes the requests; the server only passes the question on and the answer back:
//   POST   /_emu/github?op=status|signin|signin-existing|signin-wait|signout|push|request[&folder=<path>&name=&catalog=&ai=&login=]
// And the built-in update (busy-emulator update [--check]; packages/app/src/updater.mjs): the app checks now, or asks
// the person in its dialog and, with their yes, downloads, checks and restarts into the new version:
//   POST   /_emu/update?op=check|install[&pid=<the asking command's process>]
// And a clip of the bar for a post (busy-emulator record; capture/record.mjs), which the app's window encodes:
//   POST   /_emu/record?seconds=5&fps=30&layout=post   { file, frames, ... }: the clip, in the data folder's captures/
import { statSync } from "node:fs";
import { createServer, STATUS_CODES } from "node:http";
import { connect } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

import { barSpeed } from "./bar-speed.mjs";
import { openDataFolder } from "./data-folder.mjs";
import { Device } from "./device.mjs";
import { attachDeviceWindow } from "./device-window.mjs";
import { createEntryGuard } from "./entry-guard.mjs";
import { loadFirmware } from "./firmware.mjs";
import { createRecorder, RECORD_PATH, RECORD_STOP_PATH } from "./capture/record.mjs";

/** Stage 2 of publishing, done by the app (POST /_emu/github). */
export const GITHUB_PATH = "/_emu/github";
export const GITHUB_OPS = Object.freeze(["status", "signin", "signin-existing", "signin-wait", "signout", "push", "request"]);
/** The longest an op may take: a sign-in waits for the person's code up to GitHub's 15 minutes. */
const GITHUB_WAIT_MS = 16 * 60_000;
/** The built-in update, done by the app (POST /_emu/update). */
export const UPDATE_PATH = "/_emu/update";
export const UPDATE_OPS = Object.freeze(["check", "install"]);
/** The longest an update may take: the person's answer, then a download of some 250 MB. */
const UPDATE_WAIT_MS = 30 * 60_000;
import { createLocalAccess, LOCAL_PORTS_PATH, parseLocalPort } from "./local-access.mjs";
import { localWeb } from "./local-web.mjs";
import { apiDocs } from "./api-docs.mjs";
import { folderIdentity, isTrusted, trustProject, TRUST_PATH, unshowable } from "./projects/trust.mjs";
import { loadRuntime } from "./runtime.mjs";
import { createServerKey, keyAuthorizes, removeServerKey, writeServerKey } from "./server-key.mjs";
import { attachStateStream } from "./state-stream.mjs";

// The only address a server listens on: this computer.
const HOST = "127.0.0.1";

// What the bar's address adds to every answer it gives itself: other pages may not embed it. No <script>, <img> or
// other subresource of another origin (CORP; nosniff, so that a file of the bar's storage is never run as a script),
// and no frame of another origin (local web: a page that framed it could make a person click its buttons). The device
// window's page sets a stricter policy of its own, which writeHead puts in place of this one.
const BAR_EMBEDDING = [
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["X-Content-Type-Options", "nosniff"],
  ["Content-Security-Policy", "frame-ancestors 'self'"],
  ["X-Frame-Options", "SAMEORIGIN"],
];

// `close`: the connection is closed after the answer. The CORS headers, if the request gets any, are on `res` already
// (setHeader in respond()); writeHead adds these to them.
function send(res, { status, headers, body }, close = false) {
  res.writeHead(status, Object.fromEntries([...headers, ["Content-Length", body.length], ...(close ? [["Connection", "close"]] : [])]));
  res.end(body);
}

const jsonAnswer = (status, value) => ({ status, headers: [["Content-Type", "application/json"]], body: Buffer.from(JSON.stringify(value)) });

// How long a connection stays open after an answer given before its request's body was over.
const LINGER_MS = 1000;

/**
 * Answers a request whose body has not all come, and closes the connection, as the bar does with an upload it refuses
 * or gives up on. The answer is written and the connection half-closed; what the client still sends is read and
 * dropped until it closes its side too, or for LINGER_MS at most. To close at once would leave its bytes unread, and
 * the system would then reset the connection — a client still sending may lose the answer that way. (Through
 * ServerResponse Node closes at once, so the answer is written here, with the headers send() gives.)
 */
function answerEarly(req, { status, headers, body }, cors = []) {
  const socket = req.socket;
  if (socket.destroyed) return;
  const head = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}`, ...headers.map(([k, v]) => `${k}: ${v}`), ...cors.map(([k, v]) => `${k}: ${v}`), `Content-Length: ${body.length}`, "Connection: close"];
  socket.end(Buffer.concat([Buffer.from(head.join("\r\n") + "\r\n\r\n"), Buffer.from(body)]));
  req.resume();
  const timer = setTimeout(() => socket.destroy(), LINGER_MS);
  socket.once("close", () => clearTimeout(timer));
}

// How much of a request the bar's web server holds at most: the request line, the headers and the body together
// (MG_MAX_RECV_SIZE in the firmware's targets/f21/mongoose/mongoose_config.h). Every request but the uploads
// (Device's reception) is held whole before it is answered; one that comes to more is not answered, the connection is
// closed (mongoose's ioalloc: mg_error "MG_MAX_RECV_SIZE"). On the bar the limit falls somewhere up to 656 bytes above
// this, by how the bytes came in; here it is this.
const RECV_MAX = 256 * 1024;

const lowerCase = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));

/** The length of a request's line and headers, as they came (near enough: the request line is rebuilt). */
const headLength = (req) => Buffer.byteLength(`${req.method} ${req.url} HTTP/1.1\r\n`) + req.rawHeaders.reduce((n, s) => n + Buffer.byteLength(s) + 2, 0) + 2;

/**
 * Takes in the body of a request, as Device's reception says: at most `limit` bytes, into `upload` if there is one,
 * answered with `timeout.answer` if it stops coming for `timeout.ms`. Resolves with what it came to: the body (null
 * if there is none) or, for a body that went into a file, the upload's answer. Resolves with undefined if the request
 * is over without one: the client went away or the server stops (a file being written is undone), more came than
 * may be held (the connection is closed without an answer), or the body stopped coming or could not be written (that
 * was answered).
 */
function receive(req, { limit = Infinity, upload = null, timeout = null }) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let timer = null;
    const over = (outcome) => {
      clearTimeout(timer);
      req.off("data", onData).off("end", onEnd).off("close", onClose);
      resolve(outcome);
    };
    const answered = (answer) => {
      over(undefined);
      answerEarly(req, answer);
    };
    const awake = () => {
      if (!timeout) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        upload?.abort();
        answered(timeout.answer);
      }, timeout.ms);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        upload?.abort();
        req.socket.destroy();
        return over(undefined);
      }
      if (!upload) chunks.push(chunk);
      else {
        const failed = upload.write(chunk);
        if (failed) return answered(failed);
      }
      awake();
    };
    const onEnd = () => over(upload ? upload.finish() : chunks.length ? new Uint8Array(Buffer.concat(chunks)) : null);
    // Before the end: the connection went away, the client's doing or stop()'s.
    const onClose = () => {
      upload?.abort();
      over(undefined);
    };
    req.on("data", onData).once("end", onEnd).once("close", onClose);
    awake();
  });
}

const inUse = (port, cause, what = "") =>
  Object.assign(new Error(`Port ${port}${what} on ${HOST} is in use: another emulator or another program listens on it. Stop it, or start this one on another port.`, { cause }), { code: "EADDRINUSE" });
const CONTROL = " (the management address)";

// The old /_emu/* paths of the device window that it uses: on the bar's address too, while it lives (ADR-0012
// section 1). Every one of them changes only the emulated bar.
const WINDOW_PATHS = new Set(["/_emu/events", "/_emu/key", "/_emu/audio", "/_emu/status", "/_emu/power"]);
// The old paths of tools and tests, on the bar's address too until they move to /_emu/v1 (EMU-023) and go (EMU-070).
// They do nothing beyond the emulated bar itself. Some of it is not in the bar's API (power off and restart, holding
// the clock, draining the battery), but none of it reaches further than what /api/* on the same address already
// gives: installing and running an app.
const TOOL_PATHS = new Set(["/_emu/state", "/_emu/press", "/_emu/time"]);
const OLD_PATHS = new Set([...WINDOW_PATHS, ...TOOL_PATHS]);

const PAGE_MAY_NOT_ALLOW =
  "Forbidden: a page may not let apps reach this computer, whatever rights it has. A port is allowed by the person: " +
  "with --allow-local <port> when the emulator starts, or by a program that sends the server's key and no Origin.";

const PAGE_MAY_NOT_ASK =
  "Forbidden: a page may not have the person asked to trust a folder, whatever rights it has. The question is asked for a " +
  "program that sends the server's key and no Origin (busy-emulator trust <folder>), and answered by the person's click alone.";

// The question whether the person trusts a project folder (ADR-0012 section 4): how long it waits for the answer
// unless the caller says, and the longest it may.
const TRUST_WAIT_MS = 120_000;
const TRUST_WAIT_MAX_MS = 600_000;
// How long after the person's "Don't Trust" the same folder is not put before them again: a caller in a loop would
// otherwise bring the dialog up, and the app to the front, as fast as it can ask (the security review of pull
// request 59: 40 questions in 14 ms).
const TRUST_REFUSAL_PAUSE_MS = 30_000;
const UNAUTHORIZED =
  "Unauthorized: the emulator's management address answers only programs that send the server's key. " +
  'A program on this computer reads it from the file "key" in the emulator\'s data folder and sends it as "Authorization: Bearer <key>".';

// How long the question "does anybody listen there?" may go unanswered. On this computer's own address a refusal
// or a connection comes within a millisecond; silence means something filters the address (a firewall that drops
// packets instead of refusing them).
const PROBE_MS = 500;

/**
 * Whether a connection to the port on this computer is taken up by somebody. No answer in PROBE_MS counts as nobody:
 * the start then goes on as it did before there was this question, and a port that is really taken on 127.0.0.1 is
 * still refused when the server asks for it. To count silence as "in use" would keep the emulator from starting at
 * all on a computer that filters the address, with a message that is not true. Rejects with the signal's reason if a
 * stop is asked meanwhile.
 */
function someoneListens(port, signal) {
  return new Promise((resolve, reject) => {
    const probe = connect({ host: HOST, port });
    const settle = (answer) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stopped);
      probe.destroy();
      answer();
    };
    const stopped = () => settle(() => reject(signal.reason));
    const timer = setTimeout(() => settle(() => resolve(false)), PROBE_MS);
    signal?.addEventListener("abort", stopped, { once: true });
    probe.once("error", () => settle(() => resolve(false)));
    probe.once("connect", () => settle(() => resolve(true)));
  });
}

/**
 * Starts an emulated bar and the server in front of it. Resolves when the server is ready: the bar is up — its system
 * has started and its GUI has drawn the first frame on both displays, as a bar's has long before its web server
 * answers (Device.start) — and from then on every request is answered. Before that nobody gets an answer: a
 * connection is refused while the port is not taken yet, and once it is taken a connection is accepted and closed
 * without an answer — as soon as this thread is free, which while the runtime compiles (a fraction of a second, once
 * per firmware in a process) is not at once.
 *
 * The data folder (data-folder.mjs, architecture.md section 4) holds a bar for each firmware, bar/<firmware>, whose
 * ext plays the bar's /ext: installed apps, their data and settings. One server uses a data folder at a time: the
 * server takes its lock (run/server.lock) before the bar starts and lets go of it when it stops, and a second server
 * — in this process or another — is refused while the first runs. A lock left by a server that ended without
 * stopping (killed, crashed) is cleared by the next one, once it has made sure the process the lock names is gone or
 * is another program now. A new folder gets the format number; a folder of a newer format, or of the layout before
 * format numbers, is refused and left exactly as it is.
 *
 * It fails without leaving anything behind — no listening socket, no timer, no lock, and no file in the data folder if
 * the port could not be taken: an unknown firmware, a port that is in use (the error's `code` is "EADDRINUSE"), a data
 * folder that cannot be used (`code` "EMU_DATA_FOLDER"; what was made of it on the way stays), one of another format
 * (`code` "EMU_DATA_FORMAT"; nothing in it is touched), one that another server uses (`code` "EMU_DATA_IN_USE"), a
 * stop asked through `signal` before the start was over (the error is the signal's reason).
 *
 * @param {object} o
 * @param {string} o.dataDir the data folder. Made, for the user alone, if it is not there.
 * @param {number} [o.port] the port on 127.0.0.1; 0 takes a free one, which the result names. 8640 by default.
 * @param {string} [o.firmware] a version in packages/engine/firmware.json; its default version when left out
 * @param {boolean} [o.barSpeed] apps run at a BUSY Bar's speed (bar-speed.mjs), which is the default; false lets
 *   them run as fast as the computer
 * @param {boolean} [o.verbose] API requests that the emulator has no answer for go to `log`
 * @param {(number|string)[]} [o.allowLocal] ports of this computer (its loopback and own addresses) that apps on the bar may reach
 *   (--allow-local; local-access.mjs); none by default. Never port 80 (the bar's own API) or the server's own ports.
 * @param {(line: string) => void} [o.log] what happens on the bar, a line at a time; nowhere by default
 * @param {(error: unknown) => void} [o.onError] an error in answering a request; console.error by default
 * @param {(question: { kind: "trust-folder", path: string }, signal: AbortSignal) => Promise<{ answer: string, reason?: string }>} [o.askPerson]
 *   how the person is asked what only they may answer: the desktop app gives it (its supervisor passes the question
 *   to the app's main process, which shows a dialog of the system's; `answer` is "trust", "refuse" or "unavailable").
 *   Aborting `signal` takes the question away. A server without it (the command line index.mjs, a test) has nobody
 *   to ask: POST /_emu/trust answers 501.
 * @param {number} [o.trustRefusalPauseMs] how long after the person's "Don't Trust" the same folder is not asked
 *   about again; 30 s. For the tests, which cannot wait that long.
 * @param {() => number} [o.trustClock] the clock that pause is measured by, Unix ms; Date.now by default. For the
 *   tests: they move it past the pause, or keep it inside, instead of waiting by the computer's clock.
 * @param {AbortSignal} [o.signal] aborting it stops the server: during the start, which then fails, or any time after
 * @returns {Promise<{ port: number, url: string, control: { port: number, url: string }, controlHeaders: () =>
 *   { Authorization: string }, dataDir: string, barDir: string, dataFolder: { format: number, created: boolean,
 *   lockFile: string, keyFile: string }, firmware: object, apiVersion: string, barSpeed: boolean,
 *   localPorts: () => number[], stop: () => Promise<void> }>} `localPorts()` gives the ports of this computer that apps
 *   may reach now. `control` is the management address. `controlHeaders()` gives the header that
 *   carries the server's key, for a program in this process; the key itself is the value of no property, so that a
 *   result that is logged does not show it. Another process reads it from `dataFolder.keyFile` (readServerKey in
 *   server-key.mjs): written for the user alone before the server answers anybody, made anew at every start, removed
 *   by stop(). `barDir` is the bar's folder in the data folder, bar/<firmware>.
 *   `dataFolder.created` says the folder was new (had no format record) and is made now. What a person should hear
 *   about the folder — a lock left by a server that did not stop was cleared, the file system does not keep the
 *   rights — goes to `log` during the start. `firmware` is what firmware.mjs's loadFirmware gives. stop()
 *   closes every connection and stops the bar; when its promise resolves, nothing of the server is left running, so
 *   `log` and `onError` are not called again and the process can end by itself. (Node may go on naming the closed
 *   listening socket among its active resources for a few more turns of the event loop, longer on Windows; it does
 *   nothing and keeps nothing alive.) Calling it again gives the same promise.
 */
export async function startServer({ dataDir, port = 8640, controlPort = 0, allowOrigins = [], windowOrigin = null, allowLocal = [], firmware: firmwareName, barSpeed: atBarSpeed = true, verbose = false, log = () => {}, onError = console.error, askPerson = null, trustRefusalPauseMs = TRUST_REFUSAL_PAUSE_MS, trustClock = Date.now, signal } = {}) {
  if (typeof dataDir !== "string" || !dataDir) throw new TypeError("startServer needs a data folder: { dataDir }");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`The port must be a whole number from 0 to 65535, not ${port}`);
  if (!Number.isInteger(controlPort) || controlPort < 0 || controlPort > 65535) throw new RangeError(`The management port must be a whole number from 0 to 65535, not ${controlPort}`);
  if (controlPort !== 0 && controlPort === port) throw new RangeError(`The management address needs a port of its own, not the BUSY Bar's ${port}`);
  if (!Array.isArray(allowOrigins)) throw new TypeError("allowOrigins is a list of origins");
  // Throws, before anything is touched, for an origin that is not one.
  const guard = createEntryGuard({ allowOrigins, windowOrigin });
  if (!Array.isArray(allowLocal)) throw new TypeError("allowLocal is a list of ports");
  // And for a port that is not one, or is the bar's API or one of the server's own (asked for by number).
  for (const value of allowLocal) {
    const local = parseLocalPort(value);
    if (local === port || local === controlPort) throw new RangeError(`--allow-local ${local}: it is the port of the emulator's own ${local === port ? "BUSY Bar address" : "management address"}, which an app may never reach.`);
  }
  signal?.throwIfAborted();
  const firmware = loadFirmware(firmwareName);
  const root = resolve(dataDir);
  const speed = atBarSpeed ? barSpeed() : null;
  // The firmware's local web, with its state stream's worker as a file of its own (local-web.mjs).
  const web = localWeb(firmware);
  // The bar's API documentation, /docs/ and /openapi.yaml (api-docs.mjs).
  const docs = apiDocs(firmware);

  let device = null;
  let dataFolder = null;
  let deviceWindow = null;
  let stateStream = null;
  // The server's key: made once the data folder is the server's, written there before anybody is answered.
  let key = null;
  let keyFile = null;
  // The uploads that are going into files right now: a stop undoes them before it is over.
  const uploads = new Set();

  // The two addresses: the bar's and the management address (ADR-0012 section 1). `port` is the one asked for, and
  // the one taken once it is.
  const bar = { kind: "bar", port, server: createServer((req, res) => respond(bar, req, res, false)) };
  const control = { kind: "control", port: controlPort, server: createServer((req, res) => respond(control, req, res, false)) };
  const addresses = [bar, control];
  // The ports of this computer apps may reach. The server's own two are never among them, whatever was asked.
  const localAccess = createLocalAccess({ allow: allowLocal, ownPorts: () => ({ bar: bar.port, control: control.port }) });
  for (const address of addresses) {
    // A client that waits for "100 Continue" before it sends the body gets it once the body is wanted, and not for a
    // request that is answered from its headers. (The bar sends none; such a client sends the body after a wait.)
    address.server.on("checkContinue", (req, res) => respond(address, req, res, true));
  }

  /** A request refused at the entry: answered from its headers, its body (if any comes) read and dropped. */
  const refuse = (req, verdict) => answerEarly(req, jsonAnswer(verdict.status, { error: verdict.error }));

  async function respond(address, req, res, expectsContinue) {
    // An error of the request itself is the end of it; nobody needs to hear of it.
    req.on("error", () => {});
    // Host and Origin first: nothing of a refused request is looked at, its body is not taken in.
    const verdict = guard.admit(address, req);
    if (!verdict.ok) return refuse(req, verdict);
    for (const [name, value] of verdict.cors) res.setHeader(name, value);
    if (address.kind === "control") return respondControl(req, res, verdict);
    for (const [name, value] of BAR_EMBEDDING) res.setHeader(name, value);
    // What an answer written by hand (answerEarly) carries: the CORS headers and these.
    const extra = [...verdict.cors, ...BAR_EMBEDDING];

    let target = null;
    try {
      target = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      // Answered below, once the body has been taken in.
    }
    // A request that uploads a file is told from its headers how its body is taken in, or answered from them.
    let reception = null;
    if (target?.pathname.startsWith("/api/")) {
      try {
        reception = await device.reception(req.method, target.href, lowerCase(req.headers));
      } catch (e) {
        onError(e);
        return answerEarly(req, jsonAnswer(500, { error: String(e?.message ?? e) }), extra);
      }
    }
    // The client went away meanwhile.
    if (req.destroyed) {
      reception?.upload?.abort();
      return reception?.done?.();
    }
    if (reception?.answer) return answerEarly(req, reception.answer, extra);
    if (expectsContinue) res.writeContinue();
    if (reception?.upload) uploads.add(reception.upload);
    const received = await receive(req, reception ?? { limit: RECV_MAX - headLength(req) });
    uploads.delete(reception?.upload);
    // Nobody to answer, or answered already.
    if (received === undefined) return reception?.done?.();
    // A body that went into a file: what came of it.
    if (reception?.upload) return send(res, received, true);
    const body = received;
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "OPTIONS") return preflight(res, verdict, "GET,POST,PUT,DELETE", "*");
      if (url.pathname.startsWith("/api/")) {
        let response;
        try {
          response = await device.handle(req.method, url.href, lowerCase(req.headers), body);
        } finally {
          // A package is over once it has been handled.
          reception?.done?.();
        }
        // Nothing of the API took it (a 404 page, or a 405 the bar would give too): worth a line for an app's author.
        if ((response.status === 404 || response.status === 405) && verbose) log(`? ${req.method} ${url.pathname}${url.search}`);
        return send(res, response, !!reception);
      }
      // The present device window's page, and the old /_emu/* paths: the temporary exception of ADR-0012 section 1.
      if (url.pathname === "/emulator" || url.pathname.startsWith("/emulator/")) return void deviceWindow(req, res, url);
      if (url.pathname.startsWith("/_emu/")) return oldPath(req, res, url);
      // The request's own address, which the entry has checked is the bar's: the documentation's "Try it out" goes there.
      const docsPage = req.method === "GET" || req.method === "HEAD" ? docs.serve(url.pathname, `http://${req.headers.host}`) : null;
      if (docsPage) return send(res, docsPage);
      const page = req.method === "GET" ? web.serve(url.pathname) : null;
      if (page) return send(res, page);
      send(res, jsonAnswer(404, { error: "Not Found" }));
    } catch (e) {
      onError(e);
      send(res, jsonAnswer(500, { error: String(e?.message ?? e) }));
    }
  }

  /**
   * An answer to a CORS preflight. A page that may call this address hears which methods and headers it may use; one
   * of the emulator's own (which a browser does not ask) and a program hear nothing of CORS.
   */
  function preflight(res, verdict, methods, headers) {
    const cors = verdict.cors.length ? { "Access-Control-Allow-Methods": methods, "Access-Control-Allow-Headers": headers } : {};
    res.writeHead(204, cors);
    res.end();
  }

  /**
   * The management address: the old /_emu/* paths, each for a program that sends the server's key, and nothing
   * else. A body is not read: none of them takes one.
   */
  function respondControl(req, res, verdict) {
    req.resume();
    try {
      // A preflight carries no key (a browser does not send it): it says what a page that may call here may send.
      if (req.method === "OPTIONS" && verdict.cors.length) return preflight(res, verdict, "GET,POST", "Authorization");
      if (!keyAuthorizes(req.headers.authorization, key)) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="busy-emulator"');
        return send(res, jsonAnswer(401, { error: UNAUTHORIZED }));
      }
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === LOCAL_PORTS_PATH) return localPorts(req, res, url, verdict);
      if (url.pathname === TRUST_PATH) return void trustQuestion(req, res, url, verdict).catch((e) => (onError(e), send(res, jsonAnswer(500, { error: String(e?.message ?? e) }))));
      if (url.pathname === GITHUB_PATH) return void githubQuestion(req, res, url, verdict).catch((e) => (onError(e), send(res, jsonAnswer(500, { error: String(e?.message ?? e) }))));
      if (url.pathname === UPDATE_PATH) return void updateQuestion(req, res, url, verdict).catch((e) => (onError(e), send(res, jsonAnswer(500, { error: String(e?.message ?? e) }))));
      if (url.pathname === RECORD_PATH) return void recordClip(req, res, url, verdict).catch((e) => (onError(e), send(res, jsonAnswer(500, { error: String(e?.message ?? e) }))));
      if (url.pathname === RECORD_STOP_PATH) return stopClip(req, res, verdict);
      if (OLD_PATHS.has(url.pathname)) return oldPath(req, res, url);
      send(res, jsonAnswer(404, { error: "Not Found" }));
    } catch (e) {
      onError(e);
      send(res, jsonAnswer(500, { error: String(e?.message ?? e) }));
    }
  }

  /**
   * The ports of this computer apps may reach: a consent, given by a program that holds the server's key (checked by
   * the caller, on the management address) and is not a page. A page sends Origin with every request that changes
   * something and every one it reads; the app window's origin is let in on this address, but its right is not a
   * consent (ADR-0012 section 3), and this is checked here, not left to whatever right a page may get later.
   */
  function localPorts(req, res, url, verdict) {
    if (verdict.origin !== null) return send(res, jsonAnswer(403, { error: PAGE_MAY_NOT_ALLOW }));
    const answer = (extra = {}) => send(res, jsonAnswer(200, { ports: localAccess.ports(), ...extra }));
    if (req.method === "GET") return answer();
    if (req.method !== "POST" && req.method !== "DELETE") {
      res.setHeader("Allow", "GET, POST, DELETE");
      return send(res, jsonAnswer(405, { error: "Method Not Allowed" }));
    }
    let local;
    try {
      local = parseLocalPort(url.searchParams.get("port") ?? "", "A local port");
      // The emulator's own ports are refused before anybody is asked: allow() says why.
      if (req.method === "POST" && ["control", "bar"].includes(localAccess.refusal(local))) localAccess.allow(local);
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return send(res, jsonAnswer(400, { error: e.message }));
    }
    if (req.method === "POST") {
      if (localAccess.ports().includes(local)) return answer();
      // With the desktop app, the person decides in its dialog: the key alone is what any program on this computer,
      // an agent's shell included, can read (ADR-0012 section 5, audit 11.11). Without the app, whoever started the
      // server could give --allow-local as well.
      if (typeof askPerson === "function") return void askLocalPort(req, res, local).catch((e) => (onError(e), send(res, jsonAnswer(500, { error: String(e?.message ?? e) }))));
      localAccess.allow(local);
      device.log(`Apps may reach port ${local} of this computer now: a program with the server's key allowed it.`);
      return answer();
    }
    const withdrawn = localAccess.withdraw(local);
    if (withdrawn) device.log(`Apps may not reach port ${local} of this computer any more: a program with the server's key took it back.`);
    return answer({ withdrawn });
  }

  /**
   * The person's answer whether apps may reach `local`: one question at a time with the trust question, the same pause
   * after a "Don't Allow". Answers 200 { ports, allowed, asked: true, answer: "allow" | "refuse" | "no_answer" |
   * "canceled" | "unavailable", reason? }; 409 while another question is open; 429 { retry_after_s } after a refusal.
   */
  async function askLocalPort(req, res, local) {
    const key = `port:${local}`;
    const refusedAt = refusals.get(key);
    if (refusedAt !== undefined) {
      const left = refusedAt + trustRefusalPauseMs - trustClock();
      if (left > 0) {
        res.setHeader("Retry-After", String(Math.ceil(left / 1000)));
        return send(res, jsonAnswer(429, { error: `The person chose not to let apps reach port ${local} a moment ago; they are not asked about it again for ${Math.ceil(left / 1000)} s.`, retry_after_s: Math.ceil(left / 1000), port: local }));
      }
      refusals.delete(key);
    }
    if (asking) return send(res, jsonAnswer(409, { error: `Another question to the person is open in the emulator (about ${asking.path}). It takes one at a time.` }));
    const abort = new AbortController();
    asking = { path: `port ${local}`, abort };
    let why = null;
    const timer = setTimeout(() => ((why = "no_answer"), abort.abort(new Error("no answer in time"))), TRUST_WAIT_MS);
    const gone = () => res.writableEnded || ((why ??= "canceled"), abort.abort(new Error("the caller went away")));
    res.on("close", gone);
    device.log(`A program with the server's key asks to let apps reach port ${local} of this computer: the person is asked.`);
    let said;
    try {
      said = await askPerson({ kind: "local-port", port: local }, abort.signal);
    } catch (e) {
      said = { answer: why ?? "unavailable", reason: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
      res.off("close", gone);
      asking = null;
    }
    if (why) said = { answer: why };
    const answer = ["allow", "refuse", "unavailable", "no_answer", "canceled"].includes(said?.answer) ? said.answer : "unavailable";
    if (answer !== "allow") {
      if (answer === "refuse") {
        refusals.set(key, trustClock());
        if (refusals.size > 256) refusals.delete(refusals.keys().next().value);
      }
      device.log(`Apps may still not reach port ${local} of this computer: ${answer === "refuse" ? "the person chose not to allow it" : answer === "no_answer" ? "nobody answered in time" : answer === "canceled" ? "the program that asked went away" : `the person could not be asked${said?.reason ? ` (${said.reason})` : ""}`}.`);
      return send(res, jsonAnswer(200, { ports: localAccess.ports(), allowed: false, asked: true, answer, ...(typeof said?.reason === "string" ? { reason: said.reason } : {}) }));
    }
    localAccess.allow(local);
    device.log(`Apps may reach port ${local} of this computer now: the person allowed it.`);
    return send(res, jsonAnswer(200, { ports: localAccess.ports(), allowed: true, asked: true, answer }));
  }

  let recorder = null;
  /** POST /_emu/record: a clip of the bar (capture/record.mjs), for a program that holds the key, not a page. */
  async function recordClip(req, res, url, verdict) {
    if (verdict.origin !== null) return send(res, jsonAnswer(403, { error: "Forbidden: a page may not record the BUSY Bar." }));
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, jsonAnswer(405, { error: "Method Not Allowed" }));
    }
    recorder ??= newRecorder();
    const gone = new AbortController();
    res.on("close", () => res.writableFinished || gone.abort());
    const { status, body } = await recorder(url.searchParams, gone.signal);
    return send(res, jsonAnswer(status, body));
  }

  /** POST /_emu/record/stop: the take being recorded ends now, with the frames it has; the clip is made of them. */
  function stopClip(req, res, verdict) {
    if (verdict.origin !== null) return send(res, jsonAnswer(403, { error: "Forbidden: a page may not record the BUSY Bar." }));
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, jsonAnswer(405, { error: "Method Not Allowed" }));
    }
    return send(res, jsonAnswer(200, recorder ? recorder.stop() : { stopped: false }));
  }

  function newRecorder() {
    return createRecorder({ device: { get running() { return device.running; }, get powered() { return device.powered; }, get screen() { return device.screen; }, manifest: (id) => device.manifest(id) }, dataDir: root, barSpeed: atBarSpeed, askShell: askPerson, log: (line) => device.log(line) });
  }

  /**
   * POST /_emu/update?op=check|install: the built-in update, for a program that holds the key, not a page. The app
   * does it; install is asked of the person in the app's dialog first, one question at a time (409) as the others.
   * Answers 200 with the app's answer ({ ok: true, … } or { ok: false, code, message, hint }); 501 without an app.
   */
  async function updateQuestion(req, res, url, verdict) {
    if (verdict.origin !== null) return send(res, jsonAnswer(403, { error: "Forbidden: a page may not update the emulator." }));
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, jsonAnswer(405, { error: "Method Not Allowed" }));
    }
    const op = url.searchParams.get("op") ?? "";
    if (!UPDATE_OPS.includes(op)) return send(res, jsonAnswer(400, { error: `op is one of ${UPDATE_OPS.join(", ")}.` }));
    if (!askPerson) return send(res, jsonAnswer(501, { error: "This emulator runs without its app, which is what updates it." }));
    const asksPerson = op === "install";
    if (asksPerson && asking) return send(res, jsonAnswer(409, { error: `Another question to the person is open in the emulator (about ${asking.path}). It takes one at a time.` }));
    const gone = new AbortController();
    if (asksPerson) asking = { path: "the update of the emulator", abort: gone };
    res.on("close", () => res.writableFinished || gone.abort());
    let said;
    try {
      // The asking command's process (busy-emulator update gives its own): on Windows it is not counted among the
      // programs that keep the app's folder in use, as it ends with the answer.
      const requester = /^\d{1,10}$/.test(url.searchParams.get("pid") ?? "") ? Number(url.searchParams.get("pid")) : null;
      said = await askPerson({ kind: "update", op, ...(requester ? { requester } : {}) }, AbortSignal.any([gone.signal, AbortSignal.timeout(UPDATE_WAIT_MS)]));
    } finally {
      if (asksPerson && asking?.abort === gone) asking = null;
    }
    if (said?.answer === "unavailable") return send(res, jsonAnswer(503, { error: `The emulator's app could not do it: ${said.reason ?? "it gave no reason"}.` }));
    return send(res, jsonAnswer(200, said?.value && typeof said.value === "object" ? said.value : { ok: false, code: "failed", message: "The app gave no answer." }));
  }

  /**
   * POST /_emu/github?op=…: stage 2 of publishing, for a program that holds the key, not a page. The app does it
   * (packages/app/src/github/): pushing and opening the pull request are asked of the person in the app's own dialog
   * first. Answers 200 with the app's answer ({ ok: true, … } or { ok: false, code, message, hint }); 501 without an
   * app (a server run from the command line).
   */
  async function githubQuestion(req, res, url, verdict) {
    if (verdict.origin !== null) return send(res, jsonAnswer(403, { error: "Forbidden: a page may not publish." }));
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, jsonAnswer(405, { error: "Method Not Allowed" }));
    }
    const op = url.searchParams.get("op") ?? "";
    if (!GITHUB_OPS.includes(op)) return send(res, jsonAnswer(400, { error: `op is one of ${GITHUB_OPS.join(", ")}.` }));
    const question = { kind: "github", op };
    for (const field of ["folder", "name", "catalog", "ai", "login"]) {
      const value = url.searchParams.get(field);
      if (value === null) continue;
      if (value.length > 4096) return send(res, jsonAnswer(400, { error: `${field} is too long.` }));
      question[field] = value;
    }
    if (!askPerson) return send(res, jsonAnswer(501, { error: "This emulator runs without its app, which is what publishes to GitHub." }));
    // Publishing and sending to the catalog are put before the person as the trust question is: a folder whose path
    // can be shown as it is, one question at a time (409), and after a Cancel a pause before the same is asked again
    // (429). The app's dialog adds its own rules (person-question.mjs).
    const asksPerson = op === "push" || op === "request" || op === "signin-existing";
    let key = null;
    if (asksPerson) {
      let folder = "";
      if (op !== "signin-existing") {
        // The folder by its real path: another spelling of the same folder (a link, "..", letter case) is the same
        // question, and the same pause after a Cancel (security review F7).
        const shown = unshowable(question.folder ?? "");
        if (shown) return send(res, jsonAnswer(400, { reason: "unshowable", error: `The folder's path cannot be shown to the person as it is: ${shown}. Rename the folder.` }));
        try {
          if (!isAbsolute(question.folder ?? "")) throw new Error("not an absolute path");
          folder = folderIdentity(question.folder).path;
        } catch (e) {
          return send(res, jsonAnswer(400, { error: `folder is the project's absolute path (${e?.code ?? e?.message ?? e}).` }));
        }
        const hidden = unshowable(folder);
        if (hidden) return send(res, jsonAnswer(400, { reason: "unshowable", error: `The folder's path cannot be shown to the person as it is: ${hidden}. Rename the folder.` }));
        // The app's dialog names the folder by its real path too.
        question.folder = folder;
      }
      key = `${op}\n${folder}`;
      const refusedAt = githubRefusals.get(key);
      if (refusedAt !== undefined) {
        const left = refusedAt + trustRefusalPauseMs - trustClock();
        if (left > 0) {
          res.setHeader("Retry-After", String(Math.ceil(left / 1000)));
          return send(res, jsonAnswer(429, { error: `The person chose Cancel for this a moment ago; they are not asked again for ${Math.ceil(left / 1000)} s.`, retry_after_s: Math.ceil(left / 1000), folder }));
        }
        githubRefusals.delete(key);
      }
      if (asking) return send(res, jsonAnswer(409, { error: `Another question to the person is open in the emulator (about ${asking.path}). It takes one at a time.` }));
    }
    const gone = new AbortController();
    if (asksPerson) asking = { path: question.folder ?? "the GitHub account to publish with", abort: gone };
    res.on("close", () => res.writableFinished || gone.abort());
    let said;
    try {
      said = await askPerson(question, AbortSignal.any([gone.signal, AbortSignal.timeout(GITHUB_WAIT_MS)]));
    } finally {
      if (asksPerson && asking?.abort === gone) asking = null;
    }
    if (said?.answer === "unavailable") return send(res, jsonAnswer(503, { error: `The emulator's app could not do it: ${said.reason ?? "it gave no reason"}.` }));
    if (key && said?.value?.code === "refused") {
      githubRefusals.set(key, trustClock());
      if (githubRefusals.size > 256) githubRefusals.delete(githubRefusals.keys().next().value);
    }
    return send(res, jsonAnswer(200, said?.value && typeof said.value === "object" ? said.value : { ok: false, code: "failed", message: "The app gave no answer." }));
  }

  // The question to the person that is open now: one at a time.
  let asking = null;
  // The folders the person refused to trust, and when: for the pause before they are asked about one again.
  const refusals = new Map();
  // The same for publishing: "<op>\n<folder>" the person chose Cancel for, and when.
  const githubRefusals = new Map();

  /**
   * POST /_emu/trust?folder=<absolute path>[&wait=<ms>]: has the person asked whether they trust a project folder,
   * and remembers a yes (ADR-0012 section 4; busy-emulator trust). The caller holds the server's key and is not a
   * page; it only asks. The answer is the person's click in the app's own dialog (askPerson): nothing on either
   * address takes an answer, so neither a page nor a program can give one. The dialog names the folder's real path
   * as this process resolved it, and a yes is kept for that very folder (its number on the file system), if it is
   * still at that path when the answer comes. A refusal is not written anywhere; for TRUST_REFUSAL_PAUSE_MS after it
   * the same folder is not asked about again (429), then the next call asks again.
   * Answers 200 { trusted, answer: "already" | "trust" | "refuse" | "no_answer" | "canceled" | "unavailable",
   * folder, reason? }; 400 for what is not a folder or cannot be shown (unshowable(): `reason: "unshowable"`); 409
   * while another question is open; 429 { retry_after_s } after a refusal; 501 when this server has no app to ask
   * through.
   */
  async function trustQuestion(req, res, url, verdict) {
    if (verdict.origin !== null) return send(res, jsonAnswer(403, { error: PAGE_MAY_NOT_ASK }));
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return send(res, jsonAnswer(405, { error: "Method Not Allowed" }));
    }
    const given = url.searchParams.get("folder") ?? "";
    const asked = Number(url.searchParams.get("wait") ?? TRUST_WAIT_MS);
    const wait = Number.isFinite(asked) ? Math.min(Math.max(Math.round(asked), 1000), TRUST_WAIT_MAX_MS) : TRUST_WAIT_MS;
    let folder;
    try {
      if (!isAbsolute(given)) throw new Error("not an absolute path");
      folder = folderIdentity(given);
      if (!statSync(folder.path).isDirectory()) throw new Error("not a folder");
    } catch (e) {
      return send(res, jsonAnswer(400, { error: `Not a folder that can be trusted: ${JSON.stringify(given.slice(0, 200))} (${e?.code ?? e?.message ?? e}).` }));
    }
    const hidden = unshowable(folder.path);
    if (hidden) return send(res, jsonAnswer(400, { reason: "unshowable", error: `The folder's path cannot be shown to the person as it is: ${hidden}. Rename the folder.` }));
    if (isTrusted(root, folder.path)) return send(res, jsonAnswer(200, { trusted: true, answer: "already", folder: folder.path }));
    // The person said no to this folder a moment ago: it is not put before them again yet.
    const refusedAt = refusals.get(folder.path);
    if (refusedAt !== undefined) {
      const left = refusedAt + trustRefusalPauseMs - trustClock();
      if (left > 0) {
        res.setHeader("Retry-After", String(Math.ceil(left / 1000)));
        return send(res, jsonAnswer(429, { error: `The person chose not to trust ${folder.path} a moment ago; they are not asked about it again for ${Math.ceil(left / 1000)} s.`, retry_after_s: Math.ceil(left / 1000), folder: folder.path }));
      }
      refusals.delete(folder.path);
    }
    if (typeof askPerson !== "function") {
      return send(res, jsonAnswer(501, { error: "This emulator runs without its app, so it has no dialog to ask the person in." }));
    }
    if (asking) return send(res, jsonAnswer(409, { error: `Another question to the person is open in the emulator (about ${asking.path}). It takes one at a time.` }));

    const abort = new AbortController();
    asking = { path: folder.path, abort };
    let why = null;
    const timer = setTimeout(() => ((why = "no_answer"), abort.abort(new Error("no answer in time"))), wait);
    // The caller that goes away (its command was stopped) takes its question with it.
    const gone = () => res.writableEnded || ((why ??= "canceled"), abort.abort(new Error("the caller went away")));
    res.on("close", gone);
    device.log(`A program with the server's key asks whether the project folder ${folder.path} is trusted: the person is asked.`);
    let said;
    try {
      said = await askPerson({ kind: "trust-folder", path: folder.path }, abort.signal);
    } catch (e) {
      said = { answer: why ?? "unavailable", reason: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
      res.off("close", gone);
      asking = null;
    }
    if (why) said = { answer: why };
    const answer = ["trust", "refuse", "unavailable", "no_answer", "canceled"].includes(said?.answer) ? said.answer : "unavailable";
    if (answer === "refuse") {
      // Kept in memory only, for the pause; the oldest go when there are many.
      refusals.set(folder.path, trustClock());
      if (refusals.size > 256) refusals.delete(refusals.keys().next().value);
    }
    if (answer !== "trust") {
      device.log(`The project folder ${folder.path} stays untrusted: ${answer === "refuse" ? "the person chose not to trust it" : answer === "no_answer" ? "nobody answered in time" : answer === "canceled" ? "the program that asked went away" : `the person could not be asked${said?.reason ? ` (${said.reason})` : ""}`}.`);
      return send(res, jsonAnswer(200, { trusted: false, answer, folder: folder.path, ...(typeof said?.reason === "string" ? { reason: said.reason } : {}) }));
    }
    // The folder the person saw named, still at its place: one put there while the dialog was open is another.
    let same = false;
    try {
      const now = folderIdentity(folder.path);
      same = now.path === folder.path && now.dev === folder.dev && now.ino === folder.ino;
    } catch {
      // Gone: nothing to trust.
    }
    if (!same) {
      device.log(`The project folder ${folder.path} changed while the person was asked: nothing was trusted.`, "warn");
      return send(res, jsonAnswer(200, { trusted: false, answer: "unavailable", folder: folder.path, reason: "the folder was replaced or removed while the person was asked" }));
    }
    trustProject(root, folder.path, "trusted");
    device.log(`The person trusted the project folder ${folder.path}.`);
    return send(res, jsonAnswer(200, { trusted: true, answer: "trust", folder: folder.path }));
  }

  /** The old /_emu/* paths, the same on both addresses. */
  function oldPath(req, res, url) {
    if (!OLD_PATHS.has(url.pathname)) return send(res, jsonAnswer(404, { error: "Not Found" }));
    if (url.pathname === "/_emu/state") {
      const running = device.running;
      const state = {
        api_version: firmware.apiVersion,
        firmware: { name: firmware.name, commit: firmware.info.firmware },
        running: running ? { id: running.id, stats: running.runtime.stats } : null,
        // Whether the bar is on, and how many times it has restarted since the emulator started.
        powered: device.powered,
        boots: device.boots,
        // The system's clock (Unix ms), the GUI ticks it has carried out since the bar started and those it left out
        // after stalls: 125 ticks for every second of the clock (tick-clock.mjs). null while the bar is off.
        clock: device.screen.clockState?.() ?? null,
        // The status lights: { preset, color, brightness }, as the device window's event "lights" has them.
        lights: device.lightsState(),
      };
      return send(res, { status: 200, headers: [["Content-Type", "application/json"]], body: Buffer.from(JSON.stringify(state, null, 2)) });
    }
    if (url.pathname === "/_emu/press" && req.method === "POST") {
      const pressed = device.pressKey(url.searchParams.get("key") ?? "", url.searchParams.get("long") === "1");
      return send(res, { status: pressed ? 200 : 400, headers: [["Content-Type", "application/json"]], body: Buffer.from(pressed ? '{"result":"OK"}' : '{"error":"Bad Request"}') });
    }
    if (deviceWindow(req, res, url)) return;
    send(res, jsonAnswer(404, { error: "Not Found" }));
  }

  // The ports are taken before the bar starts, but until the bar is up nobody is answered: a connection made meanwhile
  // is closed at once. A client that waits for the emulator by trying again sees what it saw when the port was taken
  // last: no answer means not ready, an answer means ready.
  let ready = false;
  for (const { server } of addresses) server.on("connection", (socket) => ready || socket.destroy());

  let listening = null; // from the moment the first port is asked for: settles when both are taken or one is refused
  let stopping = null;
  const stop = () => (stopping ??= close());
  // Every part is let go of even if another fails; the first failure is what stop() rejects with.
  async function close() {
    const failures = [];
    const attempt = (step) => {
      try {
        step();
      } catch (e) {
        failures.push(e);
      }
    };
    signal?.removeEventListener("abort", onAbort);
    // A question to the person is taken away with the server.
    attempt(() => asking?.abort.abort(new Error("the server stops")));
    // A port that is being taken right now is let go of once it is known whether it was taken; Node cannot call
    // the taking off. (For a server that runs this is no wait at all.)
    await listening?.catch(() => {});
    const closed = addresses.filter(({ server }) => server.listening).map(({ server }) => new Promise((resolve) => server.close(resolve)));
    attempt(() => stateStream?.close());
    attempt(() => deviceWindow?.close());
    for (const { server } of addresses) attempt(() => server.closeAllConnections());
    // The connections' requests learn that they are over a turn later; what was written of their files goes now.
    for (const upload of uploads) attempt(() => upload.abort());
    uploads.clear();
    // The bar may have a restart under way: the stop is over when that has come to its end too.
    let down;
    attempt(() => (down = device?.close()));
    await down;
    await Promise.all(closed);
    // Nobody can be answered any more: the key goes, then (last: until the bar is down, it may still write to the
    // folder) the lock.
    if (key) attempt(() => removeServerKey(root, key));
    attempt(() => dataFolder?.release());
    if (failures.length) throw failures[0];
  }
  const onAbort = () => stop().catch(onError);
  signal?.addEventListener("abort", onAbort, { once: true });

  /** Takes an address's port, or fails as the start does: a port in use is EADDRINUSE with a message that names it. */
  async function take(address, what) {
    // A program that listens on every address of the computer (0.0.0.0 or ::) does not stop this server from taking
    // the same port on 127.0.0.1, on any system; requests to 127.0.0.1 would then come here and the rest go there.
    // So the port counts as taken if anything answers on it now.
    if (address.port !== 0 && (await someoneListens(address.port, signal))) throw inUse(address.port, undefined, what);
    signal?.throwIfAborted();
    const { server } = address;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(address.port, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((e) => {
      throw e?.code === "EADDRINUSE" ? inUse(address.port, e, what) : e;
    });
    server.on("error", onError);
    address.port = server.address().port;
  }

  try {
    listening = (async () => {
      await take(bar, "");
      // A free port asked for both could come out the same only if the first were let go of meanwhile; it is not.
      await take(control, CONTROL);
    })();
    await listening;
    signal?.throwIfAborted();
    // The runtime's wasm is compiled here rather than when the first app starts.
    await loadRuntime(firmware);
    signal?.throwIfAborted();
    dataFolder = await openDataFolder(root, {
      firmware: firmware.name,
      record: {
        port: bar.port, url: `http://${HOST}:${bar.port}`, control: { port: control.port, url: `http://${HOST}:${control.port}` },
        firmware: firmware.name, apiVersion: firmware.apiVersion,
      },
      signal,
    });
    // A lock cleared, rights the file system does not keep: for a person, with what the bar says.
    for (const notice of dataFolder.notices) log(notice);
    for (const note of web.notes) log(note);
    signal?.throwIfAborted();
    // A new key for every start: the folder is this server's now, and nobody is answered before the key is there.
    key = createServerKey();
    keyFile = join(root, "key");
    let kept;
    try {
      kept = writeServerKey(root, key);
    } catch (e) {
      throw Object.assign(new Error(`The data folder ${root} cannot be used: the server's key ${keyFile} cannot be written (${e?.code ?? e?.message ?? e}). Name another folder, or put this one right.`, { cause: e }), { code: "EMU_DATA_FOLDER" });
    }
    if (!kept && dataFolder.rightsKept) {
      log(`The file system of ${root} did not keep the rights of the server's key ${keyFile}: other users of this computer may read it. Keep the data folder on the system disk.`);
    }
    device = new Device({ dataDir: dataFolder.barDir, speed, firmware, log, localAccess, barAddress: () => `http://${HOST}:${bar.port}` });
    await device.start();
    signal?.throwIfAborted();
    deviceWindow = attachDeviceWindow(device, { apiVersion: firmware.apiVersion });
    // The state stream is the bar's; the management address takes no WebSocket.
    stateStream = attachStateStream(bar.server, device, { admit: (req) => guard.admit(bar, req) });
    control.server.on("upgrade", (req, socket) => {
      socket.on("error", () => socket.destroy());
      const verdict = guard.admit(control, req);
      const keyed = verdict.ok && keyAuthorizes(req.headers.authorization, key);
      const status = !verdict.ok ? verdict.status : keyed ? 404 : 401;
      const text = JSON.stringify({ error: !verdict.ok ? verdict.error : keyed ? "Not Found" : UNAUTHORIZED });
      socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
    });
  } catch (e) {
    await stop().catch(() => {});
    // A data folder opened after a stop asked through `signal` had begun.
    dataFolder?.release();
    // Whatever a stop in the middle of the start made fail, the start failed because it was asked to stop.
    throw signal?.aborted ? signal.reason : e;
  }
  ready = true;

  const controlHeaders = () => ({ Authorization: `Bearer ${key}` });
  return {
    port: bar.port, url: `http://${HOST}:${bar.port}`,
    control: { port: control.port, url: `http://${HOST}:${control.port}` }, controlHeaders,
    dataDir: root, barDir: dataFolder.barDir,
    dataFolder: { format: dataFolder.format, created: dataFolder.created, lockFile: dataFolder.lockFile, keyFile },
    firmware, apiVersion: firmware.apiVersion, barSpeed: atBarSpeed,
    localPorts: () => localAccess.ports(), stop,
  };
}
