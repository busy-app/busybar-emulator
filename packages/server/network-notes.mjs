// The emulator's notes on an app's requests to the network and their answers, which a bar keeps to itself
// (public-docs/differences.md, "The console"). On a bar the app sees only what lib/fetch gives it: a 301 with an empty
// or HTML body, a bare "Inactivity timeout", "out of memory" with no word of the response that caused it. These notes
// name the request and say what to change. They go to the log as "App <id>: emulator: ...", like the device's others.
//
// What they say about the bar is the firmware's behavior, read from its code (1.3.1): lib/fetch/fetch.c does not
// follow redirects; js_readable_stream.c ends a reader's read() with { done: true, value: <the error text> } and rejects
// reader.closed with "cancelled" when a response fails in its middle; js_fetch_body_methods.c collects the whole body
// before text() or json() turn it into a string or objects in the app's heap.

/** What lib/fetch's error texts mean, for the note. */
const FAILURES = Object.freeze({
  "Inactivity timeout": "no data came for 5 s, and a BUSY Bar gives up then too",
  "Failed to establish TLS connection":
    "the TLS handshake failed. The BUSY Bar trusts only the certificate authorities in its firmware's list (Mozilla's, assets/shared/ca/cacert.pem), and so does the emulator",
  "Failed to connect to server": "the name did not resolve (or the BUSY Bar has no Wi-Fi)",
  "Incomplete response body": "the connection closed before the body reached its Content-Length",
  "Connection timeout": "the server did not accept the connection",
  "socket error": "the connection failed or was closed before an answer",
});

/** A URL for a note: as the app wrote it, cut if it is very long. */
function shown(url) {
  return url.length > 160 ? `${url.slice(0, 159)}…` : url;
}

/** KiB with one decimal below 10, whole above. */
function kib(bytes) {
  const k = bytes / 1024;
  return k < 10 ? k.toFixed(1) : String(Math.round(k));
}

/**
 * The note for a redirect the app got.
 * @param {{ method: string, url: string, status: number, location: string | null }} r
 */
export function redirectNote({ method, url, status, location }) {
  const to = location ? ` to ${shown(location)}` : "";
  const https = location && url.startsWith("http:") && location.startsWith("https:") ? " (https: the server does not answer over plain http)" : "";
  return `emulator: ${method} ${shown(url)} answered ${status}, a redirect${to}. A BUSY Bar does not follow redirects: the app gets the ${status} and its body, not the data. Put the final address in the app${https}`;
}

/**
 * The note for a request that failed with lib/fetch's error.
 * @param {{ method: string, url: string, message: string, afterHead: boolean, bytes: number }} e
 */
export function networkErrorNote({ method, url, message, afterHead, bytes }) {
  const why = FAILURES[message] ?? "the request failed";
  if (!afterHead) {
    // The 5 s count from the start of the request: a server that thinks longer before its first byte fails on a bar.
    const slow = message === "Inactivity timeout" ? " (counted from the start of the request: a server that takes longer to begin its answer does not work from a BUSY Bar)" : "";
    return `emulator: ${method} ${shown(url)} failed with "${message}": ${why}${slow}. fetch() rejects with this string`;
  }
  return (
    `emulator: ${method} ${shown(url)} ended after ${bytes} ${bytes === 1 ? "byte" : "bytes"} of its body with "${message}": ${why}. ` +
    `res.json() and res.text() reject with this string; a reader of res.body gets { done: true, value: "${message}" }, not an error, and reader.closed rejects with "cancelled"`
  );
}

/**
 * The note for an app that ran out of memory soon after a large response: what to do instead of parsing it whole.
 * @param {{ heapKib: number, response: { method: string, url: string, bytes: number } }} o
 */
export function memoryNote({ heapKib, response }) {
  return (
    `emulator: the app ran out of its ${heapKib} KiB heap after a ${kib(response.bytes)} KiB response to ${response.method} ${shown(response.url)}. ` +
    "res.text() and res.json() hold the whole body in the heap at once, and parsed JSON takes several times its size. " +
    "Ask for less (only the fields you need, a smaller endpoint), or read res.body.getReader() and keep only what you need from each piece. " +
    `"heap_size_kib" in the app's manifest raises the heap up to 512 KiB (JSON of about ${JSON_FITS_KIB[128]} KiB fits 128 KiB, about ${JSON_FITS_KIB[512]} KiB fits 512)`
  );
}

/**
 * How much JSON res.json() could parse, KiB, by heap: measured in the emulator on 12 Nov 2026 with an array of small
 * objects ({ id, name, value, ok }); res.text() of plain text fitted 123 KiB of 128. Other shapes differ.
 */
const JSON_FITS_KIB = { 128: 70, 512: 275 };

/** The smallest response worth naming when the app runs out of memory, bytes. */
export const MEMORY_NOTE_MIN_BYTES = 4096;

/** Whether an app's line says it used TextDecoder or TextEncoder, which the bar's JS does not have. */
export function usesTextCodec(text) {
  return /\bText(?:De|En)coder is not defined\b/.test(text);
}

export const TEXT_CODEC_NOTE =
  "emulator: the BUSY Bar's JS has no TextDecoder or TextEncoder. Take text with res.text(), or turn the bytes of res.body.getReader() into text yourself: String.fromCharCode(...bytes) for ASCII";
