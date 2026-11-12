// The bar's local web as the server gives it: the firmware's files (`web` of firmware.mjs), with one change.
//
// The local web reads the bar's state stream (/api/status/ws) through busy-lib's LocalStateStream, which runs its
// WebSocket in a SharedWorker made from a data: address (in 1.3.1 and dev: _nuxt/wifiStore-7c2bd48.js, the constant
// kI). A worker of a data: address has an opaque origin, and Chromium opens its WebSocket with "Origin: null" — which
// the entry refuses, as it refuses every page without an origin (ADR-0012 section 2). So the server gives that
// worker as a file of the local web's own address instead: the data: address in the script is replaced by
// WORKER_PATH, and WORKER_PATH answers with what the data: address held. The worker then connects with the bar's
// address as its origin, and the rule "Origin: null is refused" needs no exception.
//
// The worker is found by its shape, not by where it is: a string literal "data:application/javascript;base64,…"
// whose content opens a WebSocket and takes connections as a SharedWorker. A build in which that is not found exactly
// once is given unchanged, and `notes` says so in a line for the log: its local web's state stream will be refused.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

import { insideFolder } from "./path-boundary.mjs";

export const WORKER_PATH = "/_nuxt/emu-state-worker.js";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff2": "font/woff2", ".json": "application/json",
};

const DATA_URL = /(["'])data:application\/javascript;base64,([A-Za-z0-9+/=]+)\1/g;
/** Whether a script is the state stream's worker: it opens a WebSocket, and takes connections as a SharedWorker. */
const isStateWorker = (source) => /\bnew WebSocket\(/.test(source) && /\bonconnect\b/.test(source);

/**
 * What the server changes in a local web: { files: Map<path, Buffer> of scripts given changed, worker: Buffer | null,
 * notes: string[] }. Paths are as requested ("/_nuxt/x.js").
 */
export function prepareLocalWeb(web, name = "") {
  const files = new Map();
  const found = [];
  const nuxt = join(web, "_nuxt");
  const scripts = existsSync(nuxt) ? readdirSync(nuxt).filter((f) => f.endsWith(".js")) : [];
  for (const file of scripts) {
    const text = readFileSync(join(nuxt, file), "latin1");
    if (!text.includes("data:application/javascript;base64,")) continue;
    for (const match of text.matchAll(DATA_URL)) {
      const source = Buffer.from(match[2], "base64");
      if (isStateWorker(source.toString("utf8"))) found.push({ file, literal: match[0], quote: match[1], source });
    }
  }
  const notes = [];
  if (found.length !== 1 || existsSync(join(web, WORKER_PATH))) {
    notes.push(
      `The local web of firmware ${name} does not have the one state stream worker the emulator knows (found ${found.length}): ` +
        "it is given as the firmware has it, and its state stream (/api/status/ws) will be refused, because the worker connects without an origin.",
    );
    return { files, worker: null, notes };
  }
  const [{ file, literal, quote, source }] = found;
  const text = readFileSync(join(nuxt, file), "latin1");
  files.set(`/_nuxt/${file}`, Buffer.from(text.replace(literal, `${quote}${WORKER_PATH}${quote}`), "latin1"));
  return { files, worker: source, notes };
}

// One preparation for each local web in a process: the files are those of a build, and do not change.
const prepared = new Map();

/** The local web of a firmware, as the server gives it: serve(pathname) → { status, headers, body } | null. */
export function localWeb(firmware) {
  const web = firmware.web;
  if (!prepared.has(web)) prepared.set(web, prepareLocalWeb(web, firmware.name));
  const { files, worker, notes } = prepared.get(web);
  function serve(pathname) {
    if (worker && pathname === WORKER_PATH) return { status: 200, headers: [["Content-Type", "text/javascript"]], body: worker };
    let name;
    try {
      name = decodeURIComponent(pathname).replace(/^\/+/, "").replace(/\/+$/, "");
    } catch {
      return null;
    }
    // A file of the local web's folder by its real path (path-boundary.mjs): "..", a link out and a folder beside it
    // whose name starts the same are not; one that is not there is the single-page app's route.
    let file = name ? insideFolder(web, name, { missing: true }) : web;
    if (file === null) return null;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    // A client-side route: the single-page app's fallback.
    if (!existsSync(file)) file = join(web, "200.html");
    const changed = files.get(pathname);
    return { status: 200, headers: [["Content-Type", MIME[extname(file)] ?? "application/octet-stream"]], body: changed ?? readFileSync(file) };
  }
  return { serve, notes, workerFound: Boolean(worker) };
}
