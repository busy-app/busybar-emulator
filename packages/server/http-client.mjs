// An app's request to the network, made the way the firmware's lib/fetch makes it (lib/fetch/fetch.c), so that an
// app meets the same limits here as on a bar:
//
//   - HTTP/1.0 with "Connection: close" and the firmware's own headers (Host, User-Agent, Accept), then the app's;
//     no Accept-Encoding, so servers do not compress;
//   - the URL is read as mongoose reads it (firmwareUrl): the path, the query and a fragment go out as the app wrote
//     them, the name in the Host header as written, nothing normalised;
//   - redirects are not followed: the app gets the 301 or 302 itself;
//   - the response head goes to the app as the server sent it, the body in the pieces it arrives in;
//   - 5 seconds without body data, counted from the start of the request, end it with "Inactivity timeout" — a server
//     that thinks longer than that before its first byte of body fails on a bar;
//   - a body shorter than its Content-Length is "Incomplete response body";
//   - this computer — its loopback and its own network addresses — is not the app's (local-access.mjs, ADR-0012
//     section 5): a request to it fails as a bar's request to a port of its own where nothing listens does, "socket
//     error", unless its port was allowed. The name is resolved once, before the connection, and the connection goes
//     to exactly the addresses checked.
//
//   - certificates are checked against the certificate authorities the bar trusts, its firmware's own list
//     (BAR_CA_FILE), not Node's or the system's: a site whose chain ends at a root the bar does not have fails here
//     as there, "Failed to establish TLS connection".
//
// Checked against a bar on 1.3.1 with emulator/test/fetch.mjs --bar: the same outcomes and error texts (a closed port
// is "socket error" there). Not the same: the bar's TLS is mbedTLS, this is OpenSSL (cipher suites, TLS versions and
// chain building may differ); the texts of name-resolution and TLS errors are not compared.
import { readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

import { createLocalAccess, destination, pinnedLookup, REFUSED_ERROR } from "./local-access.mjs";

export const INACTIVITY_TIMEOUT_MS = 5000; // FETCH_INACTIVITY_TIMEOUT_MS
/**
 * The certificate authorities the bar trusts: the firmware's assets/shared/ca/cacert.pem (ca_storage.c reads it,
 * mongoose_tls.c gives it to mbedTLS), Mozilla's roots as curl extracts them, as of 20 Oct 2026; the same file (git
 * blob c5818b24) in 1.3.1 and dev. Copied byte for byte; a newer firmware with another list needs a new copy.
 */
export const BAR_CA_FILE = new URL("./bar-ca-certificates.txt", import.meta.url);
let barCa = null;
/** The bar's certificate authorities, read once. */
export function barCertificates() {
  barCa ??= readFileSync(BAR_CA_FILE, "utf8");
  return barCa;
}
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"; // FETCH_USER_AGENT

/**
 * The URL as the firmware reads it: mongoose's urlparse(), mg_url_host(), mg_url_uri(), mg_url_port() and
 * mg_url_is_ssl() (lib/mongoose/mongoose.c, "src/url.c"), which lib/fetch uses for the connection, the request line
 * and the Host header. Nothing is normalised, unlike a WHATWG URL: the path goes out as the app wrote it, with `..`
 * and `.` segments and a `#fragment`; the name keeps its case; the scheme is matched in lower case only ("HTTPS://" is
 * not TLS, and without a port of its own goes to port 0); a query with no path before it is not sent (the path is
 * "/"). js_fetch.c has refused before this any URL with a character outside RFC 3986 (a space, Cyrillic, a quote):
 * "Invalid URL", in the emulator too, since that code runs in the runtime.
 * @param {string} url
 * @returns {{ host: string, port: number, uri: string, secure: boolean }} `host` as the Host header has it (an IPv6
 *   address in its brackets); `port` 0 to 65535, as the firmware's unsigned short
 */
export function firmwareUrl(url) {
  const u = { user: 0, pass: 0, host: 0, port: 0, uri: 0 };
  let i = 0;
  for (; i < url.length; i++) {
    const c = url[i];
    if (c === "/" && i > 0 && u.host === 0 && url[i - 1] === "/") {
      u.host = i + 1;
      u.port = 0;
    } else if (c === "]") {
      u.port = 0; // IPv6 URLs, like http://[::1]/bar
    } else if (c === ":" && u.port === 0 && u.uri === 0) {
      u.port = i + 1;
    } else if (c === "@" && u.user === 0 && u.pass === 0 && u.uri === 0) {
      u.user = u.host;
      u.pass = u.port;
      u.host = i + 1;
      u.port = 0;
    } else if (c === "/" && u.host && u.uri === 0) {
      u.uri = i;
    }
  }
  const end = i;
  const hostLength = u.port ? u.port - u.host - 1 : u.uri ? u.uri - u.host : end - u.host;
  let port = 0;
  if (url.startsWith("http:") || url.startsWith("ws:")) port = 80;
  if (url.startsWith("wss:") || url.startsWith("https:")) port = 443;
  if (url.startsWith("mqtt:")) port = 1883;
  if (url.startsWith("mqtts:")) port = 8883;
  if (u.port) {
    // atoi(), then the cast to unsigned short.
    const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(url.slice(u.port));
    port = ((m ? Number(m[1]) : 0) % 65536 + 65536) % 65536;
  }
  return {
    host: url.slice(u.host, u.host + Math.max(0, hostLength)),
    port,
    uri: u.uri ? url.slice(u.uri) : "/",
    secure: ["wss:", "https:", "mqtts:", "ssl:", "tls:", "tcps:"].some((scheme) => url.startsWith(scheme)),
  };
}

/**
 * Where the firmware connects for a host: mongoose's mg_aton() first (an empty host is 0.0.0.0, "localhost" in any
 * case 127.0.0.1, four decimal numbers an IPv4 address, leading zeros and all, an IPv6 address), else the name, which
 * the bar asks its DNS server for. A name a DNS server cannot know (a character no name has, a last label that is a
 * number, as in "127.1" or "0x7f000001") is null: not found there. The system's resolver would read those as
 * addresses instead, differently on each system.
 * @param {string} host the host as firmwareUrl gives it, an IPv6 address without its brackets
 * @returns {string | null} an IP address or a name to resolve
 */
export function firmwareAddress(host) {
  if (host === "") return "0.0.0.0";
  if (host.toLowerCase() === "localhost") return "127.0.0.1";
  const four = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (four) {
    const parts = four.slice(1).map(Number);
    return parts.every((n) => n <= 255) ? parts.join(".") : null;
  }
  if (net.isIPv6(host)) return host;
  if (!/^[A-Za-z0-9_.-]+$/.test(host)) return null;
  const last = host.replace(/\.$/, "").split(".").pop();
  return /^(\d+|0x[0-9a-f]*)$/i.test(last) ? null : host;
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.method
 * @param {string[]} o.headers the app's header lines, "Name: value"
 * @param {Uint8Array | null} o.body
 * @param {(head: Uint8Array) => void} o.onHead the response head, with the empty line that ends it
 * @param {(chunk: Uint8Array) => void} o.onData
 * @param {(message: string) => void} o.onError at most once, before onEnd
 * @param {(ok: boolean) => void} o.onEnd once
 * @param {ReturnType<typeof createLocalAccess>} [o.access] the ports of this computer the app may reach; none by default
 * @param {(refusal: { why: string, port: number, address: string }) => void} [o.onRefused] a request to this
 *   computer was refused (before onError): `why` is "not-allowed", or "bar" or "control" for the emulator's own address
 * @param {(hostname: string) => Promise<{ address: string, family: number }[]>} [o.lookup] the resolver (tests)
 * @param {string | string[]} [o.ca] the certificate authorities to trust: the bar's (barCertificates) unless a test
 *   gives its own
 * @returns {(() => void) & { pause: () => void, resume: () => void }} stops the request: no more callbacks. Its
 *   `pause` stops reading the connection until `resume`, as the bar's fetch thread stops while the app's queue is full
 *   (MAX_FETCH_MESSAGES): no data comes meanwhile, and the inactivity timeout does not run, since that thread is not
 *   there to count it.
 */
export function request({ url, method, headers, body, onHead, onData, onError, onEnd, access = createLocalAccess(), onRefused = () => {}, lookup, ca }) {
  const u = firmwareUrl(url);
  const { secure, port } = u;
  // The name as the URL has it, for the connection and the TLS server name; an IPv6 address without its brackets.
  const hostname = u.host.startsWith("[") && u.host.endsWith("]") ? u.host.slice(1, -1) : u.host;
  let failed = false;
  let done = false;
  let head = null; // the head's bytes until it is complete, then true
  let pending = Buffer.alloc(0);
  let expected = null; // Content-Length, if the server gave one
  let received = 0;
  let timer = null;
  let paused = false;

  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket?.destroy();
    onEnd(!failed);
  };
  const fail = (message) => {
    if (done || failed) return;
    failed = true;
    onError(message);
    finish();
  };
  const alive = () => {
    clearTimeout(timer);
    if (!paused) timer = setTimeout(() => fail("Inactivity timeout"), INACTIVITY_TIMEOUT_MS);
  };

  let socket = null;
  alive();
  const refuse = (refusal) => {
    if (done || failed) return;
    onRefused(refusal);
    fail(REFUSED_ERROR);
  };
  // Where the connection may go, decided once; then the connection, to exactly there.
  const address = firmwareAddress(hostname);
  const where = address !== null ? destination({ hostname: address, port, access, lookup }) : Promise.reject(Object.assign(new Error(`no name "${hostname}"`), { code: "ENOTFOUND" }));
  where.then(
    (where) => {
      if (done) return;
      if (where.refused) return refuse(where.refused);
      // Port 0 (a scheme in capitals, a port that is not a number): nothing to connect to.
      if (!port) return fail("socket error");
      const options = { host: where.host, port, ...(where.addresses ? { lookup: pinnedLookup(where.addresses) } : {}) };
      open(net.connect(options));
    },
    // A name that does not resolve, as the socket's own lookup failed before.
    (e) => fail(e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN" ? "Failed to connect to server" : "socket error"),
  );

  /**
   * The request on a socket that is connecting to an address already checked. The address it did connect to is
   * checked again before anything is sent on it — before the TLS hello too: TLS starts on the connected socket.
   */
  function open(raw) {
    socket = raw;
    if (paused) raw.pause();
    raw.once("connect", () => {
      if (done) return;
      const why = access.isThisComputer(raw.remoteAddress ?? "") ? access.refusal(port) : null;
      if (why) return refuse({ why, port, address: raw.remoteAddress });
      if (!secure) return;
      // From here on the TLS socket is the request's: what happens to the connection comes through it.
      raw.removeListener("error", onSocketError).removeListener("close", onSocketClose).removeListener("data", onSocketData);
      // `host`: the certificate is checked against the URL's name or IP address (without it Node takes "localhost").
      socket = tls.connect({ socket: raw, host: net.isIP(address) ? address : hostname, servername: net.isIP(address) ? undefined : hostname, ca: ca ?? barCertificates() });
      if (paused) socket.pause();
      wire(socket);
    });
    wire(raw);
  }

  function wire(s) {
    // The request goes out once the connection is the app's: on the TLS socket when it is secure, on the plain one
    // after its address was checked.
    if (secure === (s instanceof tls.TLSSocket)) s.once(secure ? "secureConnect" : "connect", send);
    s.on("data", onSocketData);
    s.on("error", onSocketError);
    s.on("close", onSocketClose);
  }

  function send() {
    if (done) return;
    const lines = [
      `${method} ${u.uri} HTTP/1.0`,
      `Host: ${u.host}`,
      `User-Agent: ${USER_AGENT}`,
      "Accept: */*",
      "Connection: close",
      ...(body?.length ? [`Content-length: ${body.length}`] : []),
      ...headers,
    ];
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (body?.length) socket.write(body);
  }

  function data(chunk) {
    if (!chunk.length) return;
    // Only body data counts as activity.
    alive();
    received += chunk.length;
    onData(chunk);
    // fetch_is_rx_complete: the body is in, the connection is not waited for.
    if (expected !== null && received >= expected) finish();
  }

  function onSocketData(chunk) {
    if (done) return;
    if (head === true) return data(chunk);
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf("\r\n\r\n");
    if (end < 0) return;
    const headBytes = pending.subarray(0, end + 4);
    const rest = pending.subarray(end + 4);
    head = true;
    const length = /^content-length:\s*(\d+)\s*$/im.exec(headBytes.toString("latin1"));
    if (length) expected = Number(length[1]);
    onHead(headBytes);
    if (expected === 0) return finish();
    data(rest);
  }

  function onSocketError(e) {
    if (head !== true && (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN")) return fail("Failed to connect to server");
    if (e.code === "ETIMEDOUT") return fail("Connection timeout");
    if (secure && head !== true && !socket.authorized) return fail("Failed to establish TLS connection");
    fail("socket error");
  }

  function onSocketClose() {
    if (done) return;
    if (head !== true) return fail("socket error");
    if (expected !== null && received < expected) return fail("Incomplete response body");
    finish();
  }

  const stop = () => {
    done = true;
    clearTimeout(timer);
    socket?.destroy();
  };
  stop.pause = () => {
    if (done || paused) return;
    paused = true;
    clearTimeout(timer);
    socket?.pause();
  };
  stop.resume = () => {
    if (done || !paused) return;
    paused = false;
    alive();
    socket?.resume();
  };
  return stop;
}
