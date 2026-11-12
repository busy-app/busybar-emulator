// A short clip of the running bar, for a post (busy-emulator record; ADR-0006, ADR-0007): the server records a take of
// both displays, the app's window encodes it.
//
//   POST /_emu/record?seconds=5&fps=30&layout=post|front|both&scale=<n>&format=mp4|gif   (management address, key)
//   POST /_emu/record/stop   the take being recorded ends now; its clip is made of the frames it has
//
// The take. Frame i of the clip is what the displays show at i / fps seconds into it. The server steps the bar's own
// clock to that time and reads both displays (Screen.hold / advance, the held clock of ADR-0006): whatever the
// firmware moves by its clock — an .anim, scrolling text, a countdown element, the menus — is exactly where the bar
// has it at that moment, at even steps, and two takes from the same held state give the same frames. The app's own
// JS does not run by that clock (runtime.mjs: its timers and Date.now() are the computer's), so the steps are also
// paced in real time: frame i is read when i / fps seconds have passed since the first. What the app's JS draws is
// therefore where it was at that real moment; a step read later than half a frame after its time (the server was busy
// with the app's JS, which runs in the same thread) is counted as late, and the answer says how many there were.
// A clock that is already held when the take starts (a script that set the scene up in held time) stays held, and
// the take starts from where it stands; otherwise the clock is held for the take and let go after it.
//
// The clip. MP4 (H.264) is encoded by the app's window, in a hidden page of its own (packages/app/src/capture-*.mjs):
// the server hands the take to the shell over the supervisor's channel (startServer's askPerson, a question of kind
// "encode-clip") and gets back the file's facts. A GIF of the front display needs no window: it is encoded here
// (gif.mjs) on a thread of its own (gif-worker.mjs), so that the bar, its API and the window go on answering: each
// distinct front frame is drawn and compressed once, and a step that repeats the one before only lengthens its delay.
// How long and how large a GIF may be is in clip-limits.mjs. The file goes to <data folder>/captures/; the command
// line moves it where it was asked to go.
//
// Only at the bar's speed: with --fast the app runs faster than on a bar, and a clip of it would show the viewer
// something the bar does not do (ADR-0006).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { CLIP_KEEP_MS, removeOlderThan } from "../old-files.mjs";
import { GIF_DEFAULTS, gifTooLarge, LIMITS } from "./clip-limits.mjs";

export { GIF_LIMITS, LIMITS } from "./clip-limits.mjs";
export const RECORD_PATH = "/_emu/record";
export const RECORD_STOP_PATH = "/_emu/record/stop";
export const DEFAULTS = Object.freeze({ seconds: 5, fps: 30, layout: "window", format: "mp4" });
/**
 * The clip's size by layout; `front` is the front display at `scale` px a LED, `window` the app's main window as it is
 * on the screen, whose size the app knows.
 */
export const LAYOUTS = Object.freeze({ window: null, post: { width: 1080, height: 1920 }, both: { width: 1920, height: 1080 }, front: null });
export const DEFAULT_SCALE = Object.freeze({ mp4: 15, gif: GIF_DEFAULTS.scale });
const FRONT_BYTES = 72 * 16 * 3;
const BACK_BYTES = (160 * 80) / 2;
/** How long the window may take to encode a take, beyond its length: a slow machine encodes 1080p at a few frames a second. */
const ENCODE_WAIT_MS = 120_000;

/** The size of a clip: a fixed canvas, or the front display at `scale`. */
export function clipSize(layout, scale) {
  if (layout === "window") return { width: null, height: null };
  return LAYOUTS[layout] ?? { width: 72 * scale, height: 16 * scale };
}

function whole(text, name, [min, max], fallback) {
  if (text === null || text === undefined) return fallback;
  if (!/^\d{1,4}$/.test(text) || Number(text) < min || Number(text) > max) throw new RangeError(`${name} takes a whole number from ${min} to ${max}, not ${JSON.stringify(text)}`);
  return Number(text);
}

/** The request's options, checked; a RangeError says what is wrong. */
export function recordOptions(params) {
  const format = params.get("format") ?? DEFAULTS.format;
  if (!["mp4", "gif"].includes(format)) throw new RangeError(`format is mp4 or gif, not ${JSON.stringify(format)}`);
  const layout = params.get("layout") ?? (format === "gif" ? "front" : DEFAULTS.layout);
  if (!Object.hasOwn(LAYOUTS, layout)) throw new RangeError(`layout is window, post, front or both, not ${JSON.stringify(layout)}`);
  if (format === "gif" && layout !== "front") throw new RangeError("a GIF holds the front display only: layout front");
  const seconds = whole(params.get("seconds"), "seconds", LIMITS.seconds, DEFAULTS.seconds);
  const fps = whole(params.get("fps"), "fps", format === "gif" ? LIMITS.gifFps : LIMITS.fps, format === "gif" ? GIF_DEFAULTS.fps : DEFAULTS.fps);
  const scale = whole(params.get("scale"), "scale", LIMITS.scale, DEFAULT_SCALE[format]);
  const tooLarge = format === "gif" ? gifTooLarge({ seconds, fps, scale }) : null;
  if (tooLarge) throw new RangeError(tooLarge);
  return { format, layout, seconds, fps, scale, frames: seconds * fps, ...clipSize(layout, scale) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The GIF of a take, encoded by gif-worker.mjs on a thread of its own; rejects with code "canceled" when `signal`
 * aborts (the thread is stopped then), with the encoder's error otherwise.
 * @param {{ fronts: Uint8Array[], steps: number[], scale: number, fps: number, signal?: AbortSignal }} o
 * @returns {Promise<Buffer>}
 */
export function encodeGifOffThread({ fronts, steps, scale, fps, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./gif-worker.mjs", import.meta.url), { workerData: { fronts, steps, scale, fps }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      fn(value);
    };
    const abort = () => settle(reject, Object.assign(new Error("the caller went away"), { code: "canceled" }));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (answer) => (answer.error ? settle(reject, new Error(answer.error)) : settle(resolve, Buffer.from(answer.gif.buffer, answer.gif.byteOffset, answer.gif.byteLength))));
    worker.once("error", (e) => settle(reject, e));
    worker.once("exit", (code) => settle(reject, new Error(`the GIF encoder stopped (exit code ${code})`)));
  });
}

/**
 * Records a take: `frames` frames of both displays at `fps`, stepped by the held clock and paced in real time.
 * @param {object} o
 * @param {() => object} o.screen   the device's present screen (Screen), read anew at every step: a restart replaces it
 * @param {number} o.frames
 * @param {number} o.fps
 * @param {() => number} [o.now]    the computer's clock, ms
 * @param {(ms: number) => Promise<void>} [o.wait]
 * @param {AbortSignal} [o.stop]    ends the take early, at the step it comes to, with at least one frame
 * @returns {Promise<{ front: Buffer[], back: Buffer[], index: [number, number][], late: number, maxLateMs: number,
 *   heldBefore: boolean, clockStart: number }>} frames kept once each (front, back), and for each step the pair it shows
 */
export async function recordTake({ screen, frames, fps, now = () => performance.now(), wait = sleep, stop = null }) {
  const first = screen();
  const heldBefore = first.held;
  if (!heldBefore) first.hold();
  const clockStart = first.now();
  const unique = { front: new Map(), back: new Map() };
  const kept = { front: [], back: [], index: [] };
  const keep = (name, bytes) => {
    const key = bytes.toString("base64");
    if (!unique[name].has(key)) {
      unique[name].set(key, kept[name].length);
      kept[name].push(bytes);
    }
    return unique[name].get(key);
  };
  let late = 0;
  let maxLateMs = 0;
  const start = now();
  try {
    for (let i = 0; i < frames; i++) {
      if (stop?.aborted && i > 0) break;
      const due = start + (i * 1000) / fps;
      const ahead = due - now();
      if (ahead > 1) await wait(ahead);
      if (stop?.aborted && i > 0) break;
      const lateMs = now() - due;
      if (lateMs > 500 / fps) late++;
      maxLateMs = Math.max(maxLateMs, lateMs);
      const s = screen();
      if (s !== first || s.disposed) throw Object.assign(new Error("the BUSY Bar restarted or went off during the take"), { code: "restarted" });
      if (i > 0) s.advance(Math.round((i * 1000) / fps) - Math.round(((i - 1) * 1000) / fps));
      kept.index.push([keep("front", Buffer.from(s.frame(0))), keep("back", Buffer.from(s.frame(1)))]);
    }
  } finally {
    const s = screen();
    if (!heldBefore && s === first && !s.disposed) s.release();
  }
  return { ...kept, late, maxLateMs: Math.round(maxLateMs), heldBefore, clockStart };
}

/**
 * The handler of POST /_emu/record on the management address.
 * @param {object} o
 * @param {object} o.device
 * @param {string} o.dataDir         the server's data folder; clips go to its captures/
 * @param {boolean} o.barSpeed
 * @param {Function|null} o.askShell  startServer's askPerson: the channel to the app's main process
 * @param {(line: string, kind?: string) => void} o.log
 */
export function createRecorder({ device, dataDir, barSpeed, askShell, log }) {
  let busy = false;
  let stopping = null; // the take being recorded: its stop, until its frames are in
  let count = 0;
  const folder = join(dataDir, "captures");

  /**
   * The app's main window as the person sees it: the app records it itself, in real time (capture-window.mjs); the
   * server only names the file and waits.
   */
  async function recordWindow(options, id, signal) {
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `clip-${id}.mp4`);
    const running = device.running;
    const manifest = running ? device.manifest(running.id) : null;
    log(`Recording the app's window for ${options.seconds} s at ${options.fps} frames a second.`);
    const started = Date.now();
    const answer = await askShell(
      { kind: "record-window", out: file, fps: options.fps, frames: options.frames, seconds: options.seconds },
      AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(ENCODE_WAIT_MS + options.seconds * 1000)]),
    );
    if (answer?.answer !== "encoded") {
      rmSync(file, { force: true });
      // The window's own trouble (EMU-299): hidden or closed, its page still loading, or on the screen with no frames.
      if (["window_hidden", "window_loading", "no_frames"].includes(answer?.code)) return { status: 409, body: { code: answer.code, error: `The app's window cannot be recorded: ${String(answer.reason ?? "it is not on the screen").replace(/\.$/, "")}.`, ...(typeof answer.hint === "string" ? { hint: answer.hint } : {}) } };
      return { status: 502, body: { code: "encode_failed", error: `The app could not record its window: ${answer?.reason ?? "it gave no reason"}.`, ...(answer?.missing ? { missing: answer.missing } : {}) } };
    }
    return {
      status: 200,
      body: {
        file,
        format: "mp4",
        layout: "window",
        width: answer.width,
        height: answer.height,
        fps: options.fps,
        seconds: options.seconds,
        frames: options.frames,
        app: running ? { id: running.id, name: manifest?.name ?? running.id } : null,
        stepped: false,
        late_frames: answer.late,
        repeated_frames: answer.repeated,
        resized: answer.resized,
        cursor: false,
        sound: false,
        bytes: answer.bytes,
        encoder: answer.encoder,
        codec: answer.codec,
        decoded_frames: answer.decoded,
        encode_ms: Date.now() - started,
      },
    };
  }

  /** @returns {Promise<{ status: number, body: object }>} */
  async function record(params, signal) {
    let options;
    try {
      options = recordOptions(params);
    } catch (e) {
      if (e instanceof RangeError) return { status: 400, body: { error: `${e.message}.`, code: "usage" } };
      throw e;
    }
    if (!barSpeed) return { status: 409, body: { code: "fast", error: "The emulator runs at the computer's speed (--fast): a clip would show the app faster than a BUSY Bar runs it. Start it at the BUSY Bar's speed to record." } };
    if (options.format === "mp4" && typeof askShell !== "function") return { status: 501, body: { code: "no_app", error: "This emulator runs without its app, which is what encodes a video: start it with busy-emulator start." } };
    if (busy) return { status: 409, body: { code: "busy", error: "Another clip is being recorded." } };
    if (options.layout !== "window" && (!device.powered || device.screen?.disposed)) return { status: 503, body: { code: "off", error: "The BUSY Bar is off." } };
    busy = true;
    // A clip its command gave up waiting for is never moved away: it goes once it is old (audit H12).
    removeOlderThan(folder, CLIP_KEEP_MS, { match: (name) => /^clip-.+\.(mp4|gif)$/i.test(name) });
    const id = `${process.pid}-${Date.now()}-${++count}`;
    try {
      if (options.layout === "window") return await recordWindow(options, id, signal);
      const running = device.running;
      const manifest = running ? device.manifest(running.id) : null;
      const app = running ? { id: running.id, name: manifest?.name ?? running.id } : null;
      log(`Recording a clip of ${options.seconds} s at ${options.fps} frames a second (${options.format}, ${options.layout}).`);
      const takeStarted = Date.now();
      stopping = new AbortController();
      let take;
      try {
        take = await recordTake({ screen: () => device.screen, frames: options.frames, fps: options.fps, stop: stopping.signal });
      } finally {
        stopping = null;
      }
      const recordMs = Date.now() - takeStarted;
      // A take stopped early (POST /_emu/record/stop) is as long as the frames it has.
      const stopped = take.index.length < options.frames;
      if (stopped) {
        options.frames = take.index.length;
        options.seconds = Math.round((options.frames / options.fps) * 100) / 100;
        log(`The clip was stopped at ${options.seconds} s.`);
      }
      if (signal?.aborted) return { status: 499, body: { code: "canceled", error: "The caller went away." } };
      mkdirSync(folder, { recursive: true });
      const file = join(folder, `clip-${id}.${options.format}`);
      const facts = {
        file,
        format: options.format,
        layout: options.layout,
        width: options.width,
        height: options.height,
        fps: options.fps,
        seconds: options.seconds,
        frames: options.frames,
        app,
        stopped,
        stepped: true,
        held_before: take.heldBefore,
        late_frames: take.late,
        max_late_ms: take.maxLateMs,
        distinct_frames: new Set(take.index.map(([f, b]) => `${f}/${b}`)).size,
        sound: false,
        record_ms: recordMs,
      };
      const encodeStarted = Date.now();
      if (options.format === "gif") {
        let gif;
        try {
          gif = await encodeGifOffThread({ fronts: take.front, steps: take.index.map(([f]) => f), scale: options.scale, fps: options.fps, signal });
        } catch (e) {
          if (e?.code === "canceled") return { status: 499, body: { code: "canceled", error: "The caller went away." } };
          return { status: 502, body: { code: "encode_failed", error: `The GIF could not be encoded: ${String(e?.message ?? e).split("\n")[0]}.` } };
        }
        writeFileSync(file, gif);
        return { status: 200, body: { ...facts, bytes: gif.length, encoder: "gif (the emulator's own)", encode_ms: Date.now() - encodeStarted } };
      }
      const answer = await askShell(
        {
          kind: "encode-clip",
          out: file,
          layout: options.layout,
          width: options.width,
          height: options.height,
          scale: options.scale,
          fps: options.fps,
          frames: options.frames,
          name: app?.name ?? null,
          front: take.front.map((b) => b.toString("base64")),
          back: take.back.map((b) => b.toString("base64")),
          index: take.index,
        },
        AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(ENCODE_WAIT_MS + options.seconds * 1000)]),
      );
      if (answer?.answer !== "encoded") {
        rmSync(file, { force: true });
        return { status: 502, body: { code: "encode_failed", error: `The app could not encode the clip: ${answer?.reason ?? "it gave no reason"}.`, ...(answer?.missing ? { missing: answer.missing } : {}) } };
      }
      return { status: 200, body: { ...facts, bytes: answer.bytes, encoder: answer.encoder, codec: answer.codec, decoded_frames: answer.decoded, encode_ms: Date.now() - encodeStarted } };
    } catch (e) {
      if (e?.code === "restarted") return { status: 503, body: { code: "off", error: `The take stopped: ${e.message}.` } };
      throw e;
    } finally {
      busy = false;
    }
  }
  /** Ends the take being recorded now: { stopped: true }, or { stopped: false } when there is none (a window's
      recording, which runs to its length, is not one). */
  record.stop = () => {
    if (!stopping) return { stopped: false };
    stopping.abort();
    return { stopped: true };
  };
  return record;
}

export { FRONT_BYTES, BACK_BYTES };
