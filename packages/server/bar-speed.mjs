// Bar speed: apps run as fast as on a BUSY Bar, not as fast as the computer. On by default; --fast turns it off.
//
// The app's JS runs at the computer's speed, and the emulator counts the work it did: byte-code instructions JerryScript
// executed and bytes it allocated on its heap (two counters built into the runtime, packages/engine/patches.mjs). The bar's time
// for that work is
//
//     opMs × instructions + allocByteMs × bytes
//
// and the app stays busy for that long: timers, keys and fetch answers wait, and Date.now() inside a piece of JS
// advances by the same count (runtime.mjs). Counting, unlike timing a piece that takes microseconds here, gives the
// same time on every run and on every computer.
//
// The bar's own HTTP API answers a request from the app no sooner than the bar would, counted from the call:
// apiMs + apiByteMs × the request body's bytes. That time includes the firmware's fetch and HTTP server, which are
// not the app's JS.
//
// A request to the network takes no less than that either, and an https one `network.tlsMs` more: the TLS handshake.
//
// The four numbers are `model` in bar-speed.json. emulator/test/speed.mjs fits them: the speed probe's times on a bar
// (--record) against the work the same pieces of the probe take in the runtime (--fit).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// One object for every server in the process, so nobody may change it.
const frozen = (value) => {
  if (value && typeof value === "object") Object.values(Object.freeze(value)).forEach(frozen);
  return value;
};
export const bar = frozen(JSON.parse(readFileSync(join(here, "bar-speed.json"), "utf8")));

/**
 * `source` of bar-speed.json: which bar the probe's times come from, named by model and firmware version from the
 * bar's GET /api/status/firmware answer. Never by its serial number: the file is in every release and in the public
 * repository, and a serial number points at one owner's bar.
 */
export function probeSource(firmware, recorded = new Date()) {
  return { bar: `BUSY Bar, firmware ${firmware.version}`, firmware: firmware.commit_hash, recorded: recorded.toISOString() };
}

/** Bar speed for AppRuntime's `speed`, from a model as in bar-speed.json. */
export function barSpeed({ opMs, allocByteMs, apiMs, apiByteMs } = bar.model) {
  return {
    /** The bar's time, ms, for JS that executed `ops` instructions and allocated `bytes` on the heap. */
    jsMs: (ops, bytes) => ops * opMs + bytes * allocByteMs,
    /** The bar's API time for a request of `bytes` from an app, ms, without the app's JS. */
    localApiMs: (bytes) => Math.max(0, apiMs + bytes * apiByteMs),
    /**
     * The least a request to the network takes on a bar, ms: the firmware's fetch as for the bar's own API, and for
     * https the TLS handshake, which the bar's processor computes for over a second (`network` in bar-speed.json).
     */
    networkMs: (url, bytes) => Math.max(0, apiMs + bytes * apiByteMs) + (url.startsWith("https:") ? (bar.network?.tlsMs ?? 0) : 0),
  };
}

/**
 * The model that gives the bar's times for the probe's pieces. `times` are the bar's (stepMs, xpmMs, drawTextMs,
 * drawFullMs and the draws' body sizes), `work` is what the pieces take in the runtime: { step, xpm, drawText,
 * drawFull }, each { ops, allocBytes }.
 *
 * The step is nearly all instructions and the XPM frame is mostly strings, so the two give the two JS prices. A draw
 * is its JS at those prices plus the API's time; the two draws differ in body size and give the API's line.
 */
export function fitModel(times, work) {
  const { step, xpm, drawText, drawFull } = work;
  const det = step.ops * xpm.allocBytes - xpm.ops * step.allocBytes;
  let opMs = (times.stepMs * xpm.allocBytes - times.xpmMs * step.allocBytes) / det;
  let allocByteMs = (step.ops * times.xpmMs - xpm.ops * times.stepMs) / det;
  // A bar whose strings cost nothing would be a measuring error; then all the time goes to instructions.
  if (!(opMs > 0) || !(allocByteMs >= 0)) {
    opMs = times.stepMs / step.ops;
    allocByteMs = 0;
  }
  const jsMs = (w) => w.ops * opMs + w.allocBytes * allocByteMs;
  const textApi = times.drawTextMs - jsMs(drawText);
  const fullApi = times.drawFullMs - jsMs(drawFull);
  const apiByteMs = Math.max(0, (fullApi - textApi) / (times.drawFullBytes - times.drawTextBytes));
  const apiMs = Math.max(0, textApi - apiByteMs * times.drawTextBytes);
  return { opMs, allocByteMs, apiMs, apiByteMs };
}
