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
// After a draw the bar's GUI redraws the display: JS that runs after the answer counts twice until it has taken
// redrawMs more, the cost of a frame of the speed probe's loop that its JS and its draw do not explain (likely the
// GUI's thread, at a higher priority than the app's, on the same processor).
//
// The bar's own HTTP API answers a request from the app no sooner than the bar would, counted from the call:
// apiMs + apiByteMs × the request body's bytes. That time includes the firmware's fetch and HTTP server, which are
// not the app's JS.
//
// A request to the network takes no less than that either, and an https one `network.tlsMs` more: the TLS handshake.
//
// The four numbers are `model` in bar-speed.json, one for each firmware: a bar on 1.4.1 answers its API sooner for a
// long body than on 1.3.1 (EMU-317). emulator/test/speed.mjs fits them: the speed probe's times on a bar (--record)
// against the work the same pieces of the probe take in the runtime (--fit). An app runs at the speed of the firmware
// the emulated bar runs when the time is counted, so a firmware switched on the same bar takes its own model.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFirmware } from "./firmware.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// One object for every server in the process, so nobody may change it.
const frozen = (value) => {
  if (value && typeof value === "object") Object.values(Object.freeze(value)).forEach(frozen);
  return value;
};
/** The recordings by firmware: { "1.3.1": { source, stepMs, ..., network, model }, ... }. */
export const bars = frozen(JSON.parse(readFileSync(join(here, "bar-speed.json"), "utf8")).firmwares);

/** The recording and model of a bar on `firmware` (a name of firmware.json). */
export function barOf(firmware) {
  if (!Object.hasOwn(bars, firmware)) throw new Error(`bar-speed.json has no speed of a BUSY Bar on firmware ${firmware} (node emulator/test/speed.mjs --record with a bar on it)`);
  return bars[firmware];
}

/**
 * `source` of bar-speed.json: which bar the probe's times come from, named by model and firmware version from the
 * bar's GET /api/status/firmware answer. Never by its serial number: the file is in every release and in the public
 * repository, and a serial number points at one owner's bar.
 */
export function probeSource(firmware, recorded = new Date()) {
  return { bar: `BUSY Bar, firmware ${firmware.version}`, firmware: firmware.commit_hash, recorded: recorded.toISOString() };
}

/**
 * Bar speed for AppRuntime's `speed`. `firmware`: the firmware whose model it takes, a name, or a function that
 * names it each time a time is counted (the running firmware of a bar that can switch); the emulator's default
 * firmware without one.
 */
export function barSpeed(firmware = loadFirmware().name) {
  const now = typeof firmware === "function" ? () => barOf(firmware()) : ((one) => () => one)(barOf(firmware));
  return {
    /** The bar's time, ms, for JS that executed `ops` instructions and allocated `bytes` on the heap. */
    jsMs: (ops, bytes) => {
      const { opMs, allocByteMs } = now().model;
      return ops * opMs + bytes * allocByteMs;
    },
    /**
     * The redraw after an app's draw, ms: JS that runs after a draw's answer counts twice until it has taken this much
     * more (runtime.mjs). A frame of the probe's loop takes this much longer on a bar than its JS and its draw; its
     * likely cause is the GUI redrawing the display on the same processor, at a higher priority than the app's JS
     * (gui.c sets the GUI thread to FuriThreadPriorityHigh). Not measured apart from the loop. Fitted to it (fitModel);
     * 0 for a model without it.
     */
    redrawMs: () => now().model.redrawMs ?? 0,
    /** The bar's API time for a request of `bytes` from an app, ms, without the app's JS. */
    localApiMs: (bytes) => {
      const { apiMs, apiByteMs } = now().model;
      return Math.max(0, apiMs + bytes * apiByteMs);
    },
    /**
     * The least a request to the network takes on a bar, ms: the firmware's fetch as for the bar's own API, and for
     * https the TLS handshake, which the bar's processor computes for over a second (`network` in bar-speed.json).
     */
    networkMs: (url, bytes) => {
      const { model, network } = now();
      return Math.max(0, model.apiMs + bytes * model.apiByteMs) + (url.startsWith("https:") ? (network?.tlsMs ?? 0) : 0);
    },
  };
}

/**
 * The model that gives the bar's times for the probe's pieces. `times` are the bar's (stepMs, xpmMs, drawTextMs,
 * drawFullMs, loopFps and the draws' body sizes), `work` is what the pieces take in the runtime: { step, xpm,
 * drawText, drawFull, loop } (loop: one frame of the probe's loop, a step, the frame's XPM and its draw), each
 * { ops, allocBytes }.
 *
 * The step is nearly all instructions and the XPM frame is mostly strings, so the two give the two JS prices. A draw
 * is its JS at those prices plus the API's time; the two draws differ in body size and give the API's line. JS that
 * runs after a draw's answer runs during the redraw (redrawMs, below), so the part of a draw's own JS that does
 * (afterDraw of each piece, counted in the runtime), a couple of ms, counts twice. The loop's frame is its JS, the
 * redraw it waits for, and a full draw's API time: what is left is redrawMs.
 */
export function fitModel(times, work) {
  const { step, xpm, drawText, drawFull, loop } = work;
  const det = step.ops * xpm.allocBytes - xpm.ops * step.allocBytes;
  let opMs = (times.stepMs * xpm.allocBytes - times.xpmMs * step.allocBytes) / det;
  let allocByteMs = (step.ops * times.xpmMs - xpm.ops * times.stepMs) / det;
  // A bar whose strings cost nothing would be a measuring error; then all the time goes to instructions.
  if (!(opMs > 0) || !(allocByteMs >= 0)) {
    opMs = times.stepMs / step.ops;
    allocByteMs = 0;
  }
  const jsMs = (w) => w.ops * opMs + w.allocBytes * allocByteMs;
  // The part of a draw's JS that runs after the previous draw's answer (afterDraw) is shorter than the redraw (checked
  // below), so it all counts twice.
  const twice = (w) => jsMs(w) + jsMs(w.afterDraw ?? { ops: 0, allocBytes: 0 });
  const textApi = times.drawTextMs - twice(drawText);
  const fullApi = times.drawFullMs - twice(drawFull);
  const apiByteMs = Math.max(0, (fullApi - textApi) / (times.drawFullBytes - times.drawTextBytes));
  const apiMs = Math.max(0, textApi - apiByteMs * times.drawTextBytes);
  const fullDrawApiMs = apiMs + apiByteMs * times.drawFullBytes;
  const redrawMs = loop && times.loopFps ? Math.max(0, 1000 / times.loopFps - jsMs(loop) - fullDrawApiMs) : 0;
  if (redrawMs && (jsMs(drawText.afterDraw) > redrawMs || jsMs(drawFull.afterDraw) > redrawMs || jsMs(loop) < redrawMs)) {
    throw new Error(`the fit assumes a draw's JS is shorter than the redraw and a loop frame's JS longer: draw ${jsMs(drawFull).toFixed(1)} ms, loop ${jsMs(loop).toFixed(1)} ms, redraw ${redrawMs.toFixed(1)} ms`);
  }
  return { opMs, allocByteMs, apiMs, apiByteMs, redrawMs };
}
