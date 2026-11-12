// Who may come in at the server's two addresses (ADR-0012 sections 1 and 2). Pure: it looks at a request's line and
// headers and says whether the request is let in and with which CORS headers; the server (server.mjs) and the state
// stream (state-stream.mjs) ask it before anything else is done with a request, before its body is read.
//
// The two addresses:
//   bar      the bar's API, its state stream and its local web; for the present device window also its page and the
//            old /_emu/* paths (the temporary exception of ADR-0012 section 1)
//   control  the management address: /_emu/* for tools that hold the server's key (server-key.mjs)
//
// On both:
// - Host must be this address, by either of the two names a browser on this computer gives it: 127.0.0.1:<port> or
//   localhost:<port>, and only once. Anything else — a name of somebody's domain that was made to point at 127.0.0.1
//   (DNS rebinding), no Host at all, two of them, a request line that names another host — is refused.
// - Origin, when there is one, must be the address itself, by the same name the request came to (a page of
//   http://localhost:<port> calling http://127.0.0.1:<port> is somebody else for a browser, and so it is here), or one
//   that the emulator was told to let in (--allow-origin), or, on the management address only, the app window's
//   origin (--window-origin). "null" is nobody's origin and is refused, with one exception (ADR-0012 section 2): a GET
//   or HEAD on the bar's address for exactly one of the 3D view's static files (STAGE_FRAME_FILES under
//   STAGE_FRAME_PATH). That frame is sandboxed and so has no origin; the files are the player and the scene, the same
//   for everybody, and the answer to such a request reads nothing but its path (stage3d.mjs). No API path, no /_emu,
//   no other file, no other method. A request without Origin comes from a program (busy-cli, curl, an agent) or is a browser's own
//   plain GET; it is let in.
// - CORS headers go only to the origins named by --allow-origin: for those the bar's address answers as a bar does
//   (Access-Control-Allow-Origin: *), the management address names the origin itself. The app window's origin gets
//   its own value on the management address. Nobody else gets any: the bar answers "*" to every page, the emulator
//   does not (a deliberate difference from the bar, written down in public-docs/differences.md).

/**
 * Where the files of the 3D view's frame are served (stage3d.mjs): the one path a page without an origin may GET.
 */
export const STAGE_FRAME_PATH = "/emulator/stage3d/frame/";

/**
 * The frame's static files, the only ones a page without an origin may read: its page, its scripts and style, the
 * player's code, WebAssembly and lighting, the scene. A test holds this list to the files of packages/stage/frame
 * (the player's LICENSE and notices are served too, but not to a frame without an origin: it never asks for them).
 */
export const STAGE_FRAME_FILES = Object.freeze([
  "stage.html",
  "stage.css",
  "stage.js",
  "leds.js",
  "scene/bar.json",
  "scene/bar.trd",
  "player/tride-web/tride-web.js",
  "player/tride-web/tride_runtime_api-Dy6ek_GD.js",
  "player/tride-web/tride_runtime_api_lite_bg.wasm",
  "player/filament/filament.js",
  "player/filament/filament.wasm",
  "player/ibl/studio_ibl.ktx",
  "player/ibl/studio_skybox.ktx",
]);
const STAGE_FRAME_URLS = new Set(STAGE_FRAME_FILES.map((file) => STAGE_FRAME_PATH + file));

/**
 * True for a request that only reads one of the frame's static files: GET or HEAD, and the request's path, as it
 * comes and before any decoding or "..", is exactly one of them (a query is allowed, it is not read).
 */
function readsStageFrame(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (typeof req.url !== "string" || !req.url.startsWith(STAGE_FRAME_PATH)) return false;
  const end = req.url.search(/[?#]/);
  return STAGE_FRAME_URLS.has(end < 0 ? req.url : req.url.slice(0, end));
}

/** What a refusal says, by what was wrong. The texts are for a person reading a browser's console or curl's output. */
const REASONS = {
  host: (port) =>
    `Forbidden: the request was not addressed to this emulator. It answers only requests to 127.0.0.1:${port} or localhost:${port} ` +
    "(a page that reaches it under another name is refused). Use one of these addresses.",
  origin: (origin) =>
    `Forbidden: requests from the web page ${origin} are refused. The emulator answers only its own pages and programs on this computer. ` +
    "To drive it from a page of your own, let a program on this computer make the request for the page: a request without an Origin header is answered. " +
    `The desktop app has no setting that lets a page in; the server started from its source takes --allow-origin ${origin}.`,
  nullOrigin: () =>
    "Forbidden: requests from a page without an origin (Origin: null: a sandboxed frame, a file opened from the disk, a redirect from elsewhere) " +
    "are refused. Let a program on this computer make the request for the page: a request without an Origin header is answered. " +
    "The desktop app has no setting that lets a page in; the server started from its source takes --allow-origin <origin> for a page opened from a web address.",
  twice: (name) => `Forbidden: the request carries the ${name} header more than once.`,
};

/**
 * An origin as a browser writes it, checked: "<scheme>://<host>[:<port>]", in lower case, with nothing after it.
 * Throws a RangeError that says what is wrong, for an option given at the start.
 */
export function normalizeOrigin(text, flag = "--allow-origin") {
  const value = String(text ?? "").trim();
  if (value === "*" || value.toLowerCase() === "null") {
    throw new RangeError(`${flag} names one page's origin, such as http://localhost:3000; "${value}" would let in every page.`);
  }
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s@]+)$/i.exec(value);
  if (!match) {
    throw new RangeError(`${flag} needs an origin: a scheme, "://" and a host with its port if it has one, nothing after them (http://localhost:3000), not ${JSON.stringify(value)}.`);
  }
  const scheme = match[1].toLowerCase();
  const authority = match[2].toLowerCase();
  // For http and https the URL parser says what a browser would send (a default port is left out).
  if (scheme === "http" || scheme === "https") {
    let origin;
    try {
      origin = new URL(`${scheme}://${authority}`).origin;
    } catch {
      throw new RangeError(`${flag}: ${JSON.stringify(value)} is not an address.`);
    }
    return origin;
  }
  return `${scheme}://${authority}`;
}

/** How many times a header comes in a request's raw headers (Node keeps only one of some, such as Host). */
function countOf(rawHeaders, name) {
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name) n++;
  return n;
}

/**
 * @param {object} o
 * @param {string[]} [o.allowOrigins]  origins that are let in on both addresses and get CORS headers (--allow-origin)
 * @param {string} [o.windowOrigin]    the app window's origin: its own on the management address (--window-origin)
 * @returns {{ admit: (address: { kind: "bar" | "control", port: number }, req: { method: string, url: string,
 *   rawHeaders: string[] }) => ({ ok: true, origin: string | null, cors: [string, string][] } | { ok: false,
 *   status: 403, reason: string, error: string }), allowOrigins: string[], windowOrigin: string | null }}
 *   `admit` gives, for a request let in, its Origin (null when it has none) and the CORS headers its answers carry;
 *   for one refused, the status, which check refused it ("host", "origin") and the text of the answer.
 */
export function createEntryGuard({ allowOrigins = [], windowOrigin = null } = {}) {
  const allowed = new Set(allowOrigins.map((o) => normalizeOrigin(o)));
  const window = windowOrigin ? normalizeOrigin(windowOrigin, "--window-origin") : null;
  if (window && allowed.has(window)) allowed.delete(window);
  const refuse = (reason, error) => ({ ok: false, status: 403, reason, error });

  function admit(address, req) {
    const raw = req.rawHeaders ?? [];
    // Host: once, and this address by one of its two names.
    if (countOf(raw, "host") !== 1) return refuse("host", countOf(raw, "host") ? REASONS.twice("Host") : REASONS.host(address.port));
    let host = "";
    for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === "host") host = raw[i + 1].trim().toLowerCase();
    if (host !== `127.0.0.1:${address.port}` && host !== `localhost:${address.port}`) return refuse("host", REASONS.host(address.port));
    // A request line in absolute form names its own host, which wins over the header (RFC 9112 section 3.2.2).
    if (!req.url.startsWith("/")) {
      let named = null;
      try {
        named = new URL(req.url).host.toLowerCase();
      } catch {
        // Not an address: "*" (OPTIONS *) or nonsense.
      }
      if (named !== host) return refuse("host", REASONS.host(address.port));
    }

    // Origin: absent, the address itself by the name the request came to, or one the emulator was told of.
    const origins = countOf(raw, "origin");
    if (origins > 1) return refuse("origin", REASONS.twice("Origin"));
    if (origins === 0) return { ok: true, origin: null, cors: [] };
    let origin = "";
    for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === "origin") origin = raw[i + 1].trim().toLowerCase();
    if (origin === `http://${host}`) return { ok: true, origin, cors: [] };
    if (address.kind === "control" && window && origin === window) return { ok: true, origin, cors: [["Access-Control-Allow-Origin", window], ["Vary", "Origin"]] };
    if (allowed.has(origin)) {
      // As a bar answers every page (web_server_i.h: HEADER_CORS) on the bar's address; the origin itself on the
      // management address, which is not a bar's.
      // Vary: the answer depends on Origin now, and a browser's cache must not give it to another page.
      const cors = address.kind === "bar" ? [["Access-Control-Allow-Origin", "*"], ["Access-Control-Allow-Headers", "*"], ["Vary", "Origin"]] : [["Access-Control-Allow-Origin", origin], ["Vary", "Origin"]];
      return { ok: true, origin, cors };
    }
    // The sandboxed frame of the 3D view reads its own files; it gets no CORS header from here (the files' answer
    // carries its own) and nothing else of the server.
    if (origin === "null" && address.kind === "bar" && readsStageFrame(req)) return { ok: true, origin, cors: [] };
    return refuse("origin", origin === "null" ? REASONS.nullOrigin() : REASONS.origin(origin));
  }

  return { admit, allowOrigins: [...allowed], windowOrigin: window };
}
