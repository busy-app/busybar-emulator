// The app's own scheme. Pages that ship with the app are served as app://<host>/<file>, never as file://: such a
// page has a real origin (app://shell), which the bridge and, later, the server's origin check can name
// (ADR-0016, ADR-0012 section 2).
//
// Chromium does not apply CORS to this scheme and the handler is not told who asks (EMU-200), so nothing here may be
// a secret: every host serves a fixed folder of static files and nothing else.
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const APP_SCHEME = "app";

/**
 * Host → folder under src/. The whole list; app://window and app://stage join it with the new window. app://capture is
 * the hidden page that encodes a clip (capture-window.mjs).
 */
export const APP_HOSTS = Object.freeze({ shell: "pages/shell", capture: "pages/capture" });

/** What may be served, by extension. */
const TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png", // the pages' icon
});

/** The policy of the shell's own pages: their own files only, no inline code, no network. */
export const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true, supportFetchAPI: true });

export const originOfHost = (host) => `${APP_SCHEME}://${host}`;

/**
 * The file an app:// address names, or null when it names nothing that may be served.
 * @param {string} address  the request's URL
 * @param {string} root     the folder the hosts' folders are in (src/)
 * @returns {{ file: string, type: string } | null}
 */
export function resolveAppFile(address, root) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || !Object.hasOwn(APP_HOSTS, url.hostname) || url.port || url.username || url.password) return null;

  let segments;
  try {
    segments = url.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  // A name is a plain file name: no way up, no separator of either system, nothing hidden.
  if (segments.length === 0 || segments.some((s) => s === "" || s.startsWith(".") || /[\\/:\0]/.test(s))) return null;

  const type = TYPES[path.extname(segments.at(-1)).toLowerCase()];
  if (!type) return null;

  try {
    const folder = realpathSync(path.join(root, APP_HOSTS[url.hostname]));
    // The real place of the file, so that a link inside the folder cannot lead out of it.
    const file = realpathSync(path.join(folder, ...segments));
    if (!file.startsWith(folder + path.sep) || !statSync(file).isFile()) return null;
    return { file, type };
  } catch {
    return null;
  }
}

const refusal = (status, text) => new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

/** The handler for protocol.handle(APP_SCHEME, ...). */
export function createAppSchemeHandler(root) {
  return (request) => {
    if (request.method !== "GET") return refusal(405, "Method not allowed");
    const found = resolveAppFile(request.url, root);
    if (!found) return refusal(404, "Not found");
    return new Response(readFileSync(found.file), {
      status: 200,
      headers: {
        "Content-Type": found.type,
        "Content-Security-Policy": PAGE_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  };
}
