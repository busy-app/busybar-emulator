// The bar's API documentation, as the bar serves it: the Swagger UI page at /docs/ (/docs is sent there) and the
// OpenAPI description it shows at /openapi.yaml. The files are the firmware's own, made by its build's scripts
// (packages/engine/build.mjs, buildDocs) into build/<version>/docs; nothing is fetched from the network.
//
// Three things differ from the bar. The description's example serial number is the emulated bar's, EMULATOR, not a
// real bar's (build.mjs, buildDocs). The description names the address it was asked on as its server, so that "Try it
// out" and a copy of the description used elsewhere both go to the emulated bar; the bar's description names no
// server, and Swagger UI then takes the page's own address, which on the bar is the same thing. And the folder also
// holds Swagger UI's LICENSE and NOTICE (Apache-2.0), served beside the page as text.
//
// The scripts and styles are kept gzipped, as the firmware keeps them, and are given so (Content-Encoding: gzip),
// as the bar gives them.
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

export const DOCS_PATH = "/docs";
export const SPEC_PATH = "/openapi.yaml";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".yaml": "text/plain; charset=utf-8", "": "text/plain; charset=utf-8",
};
// The files of the page, by their names in the folder; no other name is looked up.
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The description as the emulator gives it: the firmware's, with a `servers` entry for `origin` before its first
 * top-level key after `info`.
 */
export function withServer(spec, origin) {
  const entry = `servers:\n  - url: ${origin}\n    description: BUSY Bar Emulator\n\n`;
  const info = spec.search(/^info:/m);
  const next = info < 0 ? -1 : spec.indexOf("\n", info) + 1;
  // The first top-level key that comes after info; at the end if there is none.
  const after = next <= 0 ? -1 : spec.slice(next).search(/^[A-Za-z]/m);
  if (after < 0) return `${spec.replace(/\n*$/, "\n")}\n${entry.trimEnd()}\n`;
  const index = next + after;
  return spec.slice(0, index) + entry + spec.slice(index);
}

/** The documentation of a firmware: serve(pathname, origin) → { status, headers, body } | null for a path not its. */
export function apiDocs(firmware) {
  const dir = firmware.docs;
  const spec = dir && existsSync(join(dir, "openapi.yaml")) ? readFileSync(join(dir, "openapi.yaml"), "utf8") : null;
  function serve(pathname, origin) {
    if (!dir) return null;
    if (pathname === SPEC_PATH && spec !== null) {
      return { status: 200, headers: [["Content-Type", MIME[".yaml"]]], body: Buffer.from(withServer(spec, origin)) };
    }
    // As on the bar: the folder's address without its slash is sent to the one with it.
    if (pathname === DOCS_PATH) return { status: 301, headers: [["Location", `${DOCS_PATH}/`]], body: Buffer.alloc(0) };
    if (!pathname.startsWith(`${DOCS_PATH}/`)) return null;
    const name = pathname.slice(DOCS_PATH.length + 1) || "index.html";
    if (!FILE.test(name) || name.endsWith(".gz") || name === "openapi.yaml") return null;
    const type = MIME[extname(name)];
    if (type === undefined) return null;
    if (existsSync(join(dir, `${name}.gz`))) {
      return { status: 200, headers: [["Content-Type", type], ["Content-Encoding", "gzip"]], body: readFileSync(join(dir, `${name}.gz`)) };
    }
    if (existsSync(join(dir, name))) return { status: 200, headers: [["Content-Type", type]], body: readFileSync(join(dir, name)) };
    return null;
  }
  return { serve, available: Boolean(dir && spec !== null) };
}
