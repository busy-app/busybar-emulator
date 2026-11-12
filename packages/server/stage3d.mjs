// The 3D view's frame (ADR-0004, ADR-0016): the files of packages/stage/frame, served at /emulator/stage3d/frame/
// with a policy of their own. The device window shows them in a sandboxed <iframe> (legacy-window/stage3d/mount.js):
// the frame draws the bar with the Tride player and talks to the window by messages only.
//
//   GET /emulator/stage3d/frame/<file>   a file of the frame: its page, its scripts, the player, the scene
//
// The frame has no origin: its sandbox leaves it scripts and nothing else, so its own requests for its own files come
// with "Origin: null". The entry guard lets those in for GET and HEAD of the files it lists, STAGE_FRAME_FILES, alone
// (entry-guard.mjs, ADR-0012 section 2); nothing here
// reads the request beyond its path, and nothing but the files of that folder is given out. They are the same files
// for everybody and say nothing of the bar or of this computer.
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STAGE_FRAME_PATH } from "./entry-guard.mjs";
import { insideFolder } from "./path-boundary.mjs";

export { STAGE_FRAME_PATH };

/**
 * The frame's policy. The player needs 'wasm-unsafe-eval' (its runtime and Filament are WebAssembly), a worker from a
 * blob (the picture decoder) and to fetch its own files; it gets nothing else: no network but its own folder's origin,
 * no code that is not in a file, no forms, no other base. `sandbox allow-scripts` repeats the frame's attribute in the
 * answer itself, so the page is without an origin, and without the server's, however it is opened. Only the device
 * window may frame it.
 */
export const STAGE_POLICY =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; connect-src 'self'; style-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".md": "text/plain; charset=utf-8",
  "": "text/plain; charset=utf-8", // the player's LICENSE
};

const here = dirname(fileURLToPath(import.meta.url));
/** packages/stage/frame, beside packages/server in the source tree and in the app alike. */
export const STAGE_FRAME_DIR = resolve(here, "..", "stage", "frame");

/**
 * Answers a request for a file of the frame.
 * @param {{ method: string }} req
 * @param {import("node:http").ServerResponse} res
 * @param {URL} url   its pathname starts with STAGE_FRAME_PATH
 * @param {string} [root]  the folder with the frame's files (tests)
 */
export function serveStageFrame(req, res, url, root = STAGE_FRAME_DIR) {
  // The answer's own headers take the place of the bar's (server.mjs, BAR_EMBEDDING): a frame without an origin is
  // "another origin" to everything, its own files included, so they are readable across origins; the policy says who
  // may frame the page.
  const headers = {
    "Content-Security-Policy": STAGE_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };
  const fail = (status, text) => {
    res.writeHead(status, { ...headers, "Content-Type": "text/plain" });
    res.end(text);
  };
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "Method Not Allowed");
  let name;
  try {
    name = decodeURIComponent(url.pathname.slice(STAGE_FRAME_PATH.length));
  } catch {
    return fail(404, "Not found");
  }
  // A file of the frame's folder by its real path (path-boundary.mjs).
  const file = insideFolder(root, name);
  const type = MIME[extname(name)] ?? "application/octet-stream";
  let body;
  try {
    if (file === null) throw new Error("outside");
    body = readFileSync(file);
  } catch {
    return fail(404, "Not found");
  }
  res.writeHead(200, { ...headers, "Content-Type": type, "Content-Length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}
