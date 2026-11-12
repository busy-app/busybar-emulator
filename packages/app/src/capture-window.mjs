// The clips of busy-emulator record (ADR-0006, ADR-0007), asked for by the server over the supervisor's channel
// (packages/server/capture/record.mjs). Two kinds: "record-window", the app's main window as the person sees it,
// recorded here from the window's own frames; and "encode-clip", a take of both displays the server recorded, drawn
// in a layout. For each one this module makes a hidden window with the page app://capture, which encodes H.264 with
// WebCodecs; the samples it gives back are written into an MP4 (capture-mp4.mjs) in the data folder's captures/, and
// the page's window is destroyed.
//
// The main window's frames come from webContents.beginFrameSubscription: the frames its compositor draws, in device
// pixels. Chosen over desktopCapturer, which needs the Screen Recording permission on macOS, and over capturePage,
// which is a readback per call. It works the same on Windows and gives no pointer.
//
// The page runs as every page of the app does (security.mjs): in the sandbox, in a session of its own whose network
// is closed entirely — it reaches neither the server nor anything else, all it gets comes over its preload's one
// channel. It is never shown, its timers are not slowed down while hidden, and it steps by the encoder's queue rather
// than by frames of drawing (EMU-080: a hidden window on Windows draws about once a second).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { originOfHost } from "./app-scheme.mjs";
import { muxMp4 } from "./capture-mp4.mjs";
import { PAGE_PREFERENCES } from "./security.mjs";

/** The session of the encoding page: in memory only, its network closed (main.mjs names no address for it). */
export const CAPTURE_PARTITION = "busy-capture";
export const CAPTURE_PAGE = `${originOfHost("capture")}/capture.html`;
export const CAPTURE_CHANNEL = "busy-capture";
/** Frames of the main window, from the main process to the encoding page. */
export const CAPTURE_FRAME_CHANNEL = "busy-capture-frame";
/**
 * How long the main window may take to give its first frame (EMU-299). `quietMs` after the last sign of work: the
 * window is given that long once it has finished loading, and longer while it loads; never more than `ceilingMs`
 * in all. Every `stepMs` it is looked at and asked to draw again (a hidden window on Windows draws about once a
 * second; a slow graphics card, a virtual machine or a busy computer takes seconds for the first frame).
 */
export const FIRST_FRAME_WAIT = Object.freeze({ quietMs: 10_000, ceilingMs: 45_000, stepMs: 500 });
/** Frames sent to the page and not yet taken in, at most: past that a frame repeats the one before. */
const MAX_PENDING = 6;

/**
 * @param {object} o
 * @param {Function} o.BrowserWindow
 * @param {object} o.ipcMain
 * @param {object} o.registry         createWindowRegistry()
 * @param {() => object} o.session    the page's session (session.fromPartition(CAPTURE_PARTITION)), once the app is ready
 * @param {string} o.dataDir          clips are written to its captures/ and nowhere else
 * @param {string} o.preloadPath      capture-preload.cjs
 * @param {Uint8Array | null} o.art   the flat picture of the bar (PNG), or null for a plain frame
 * @param {() => Promise<{ win: object, scale: number } | { reason: string }>} o.windowFor  the main window, shown
 *   and in front, with the scale of its screen; or why it cannot be
 * @param {(line: string) => void} o.log
 * @param {{ quietMs: number, ceilingMs: number, stepMs: number }} [o.waitTiming]  FIRST_FRAME_WAIT, or a test's
 * @returns {{ encodeClip: Function, recordWindow: Function }} (question, signal) → the answer for the server
 */
export function createClipEncoder({ BrowserWindow, ipcMain, registry, session, dataDir, preloadPath, art, windowFor, log, waitTiming = FIRST_FRAME_WAIT }) {
  const folder = path.resolve(dataDir, "captures");
  const jobs = new Map(); // webContents id → { job, settle }

  ipcMain.handle(CAPTURE_CHANNEL, (event, what, payload) => {
    const entry = jobs.get(event.sender.id);
    if (!entry) throw new Error("not the encoding page");
    if (what === "job") return entry.job();
    if (what === "ack") return void entry.ack();
    if (what === "finish") return entry.settle({ finished: payload });
    if (what === "fail") return entry.settle({ failed: payload });
    throw new Error(`no call ${what}`);
  });

  /**
   * Opens the encoding page with `job`, runs `drive(page)` while it works (the window recording feeds it frames), and
   * gives back what the page finished with, or why it failed. The page's window is destroyed afterwards.
   */
  async function withPage(job, signal, drive = null) {
    const win = new BrowserWindow({
      width: 320,
      height: 240,
      show: false,
      skipTaskbar: true,
      title: "Clip",
      webPreferences: { ...PAGE_PREFERENCES, devTools: false, session: session(), preload: preloadPath, backgroundThrottling: false },
    });
    registry.register(win.webContents, { kind: "capture", origin: originOfHost("capture"), allows: (url) => url.pathname === "/capture.html" });
    const id = win.webContents.id;
    let settle;
    const settled = new Promise((resolve) => (settle = resolve));
    let ready;
    const started = new Promise((resolve) => (ready = resolve));
    const acks = { count: 0, wake: null };
    jobs.set(id, {
      job: () => (ready(), job),
      ack: () => {
        acks.count++;
        acks.wake?.();
      },
      settle: (value) => (settle(value), true),
    });
    const abort = () => settle({ failed: { reason: signal.reason?.name === "TimeoutError" ? "it took too long" : "the request was canceled" } });
    signal?.addEventListener("abort", abort, { once: true });
    win.webContents.once("render-process-gone", (_event, details) => settle({ failed: { reason: `the page ended (${details.reason})` } }));
    win.loadURL(CAPTURE_PAGE).catch((e) => settle({ failed: { reason: `the page did not load: ${e.message}` } }));
    try {
      if (drive) {
        const page = {
          started,
          settled,
          send: (message) => !win.isDestroyed() && win.webContents.send(CAPTURE_FRAME_CHANNEL, message),
          acks,
        };
        const driven = await Promise.race([drive(page).then((extra) => ({ extra })), settled]);
        if (driven.failed) return driven;
        const result = await settled;
        return result.finished ? { finished: result.finished, extra: driven.extra } : result;
      }
      return await settled;
    } finally {
      signal?.removeEventListener("abort", abort);
      jobs.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
  }

  function write(out, finished, started) {
    const { samples, avcC, width, height, fps, encoder } = finished;
    const mp4 = muxMp4({ width, height, fps, avcC, samples });
    mkdirSync(folder, { recursive: true });
    writeFileSync(out, mp4);
    log(`[shell] encoded a clip: ${samples.length} frames ${width}×${height} at ${fps} a second, ${mp4.length} bytes, ${encoder}, in ${Date.now() - started} ms`);
    return mp4.length;
  }

  const outOf = (question) => {
    const out = path.resolve(String(question?.out ?? ""));
    return path.dirname(out) === folder && out.endsWith(".mp4") ? out : null;
  };
  const failure = (result) => ({ answer: "unavailable", reason: String(result.failed.reason ?? "unknown"), ...(result.failed.missing ? { missing: String(result.failed.missing) } : {}), ...(result.failed.code ? { code: result.failed.code } : {}) });

  /** A clip of the take the server recorded (layouts post, front, both). */
  async function encodeClip(question, signal) {
    const out = outOf(question);
    if (!out) return { answer: "unavailable", reason: "the clip's file is not in the data folder's captures/" };
    const started = Date.now();
    const job = { ...question, art: art ?? null };
    delete job.out;
    try {
      const result = await withPage(job, signal);
      if (result.failed) return failure(result);
      const bytes = write(out, result.finished, started);
      return { answer: "encoded", bytes, codec: result.finished.codec, encoder: result.finished.encoder, decoded: result.finished.decoded };
    } catch (e) {
      return { answer: "unavailable", reason: String(e?.message ?? e) };
    }
  }

  /**
   * A clip of the app's main window as the person sees it (layout window): the window's own frames, as its compositor
   * hands them over (webContents.beginFrameSubscription), at its size in device pixels, taken `fps` times a second in
   * real time for `frames` frames and streamed to the encoding page. Frames the page could not take in time repeat the
   * one before and are counted. The pointer is not in them: the frames are the page's, not the screen's.
   *
   * `until` (the window's Record button, capture-actions.mjs): `stop` is an AbortSignal that ends the take early, at
   * the frame it comes to, with the frames taken so far; `onStarted()` is called once the window's first frame came.
   * `frames` is then the longest the take may be.
   */
  async function recordWindow(question, signal, until = {}) {
    const out = outOf(question);
    if (!out) return { answer: "unavailable", reason: "the clip's file is not in the data folder's captures/" };
    const fps = Number(question.fps);
    const frames = Number(question.frames);
    const target = await windowFor();
    if (!target?.win) return { answer: "unavailable", code: "window_hidden", reason: target?.reason ?? "the app's window cannot be shown" };
    const contents = target.win.webContents;
    const started = Date.now();
    let latest = null;
    let first = null;
    let firstFrame;
    const gotFirst = new Promise((resolve) => (firstFrame = resolve));
    const stats = { repeated: 0, resized: false, late: 0 };
    try {
      const result = await withPage({ kind: "window", fps, frames }, signal, async (page) => {
        await page.started;
        contents.beginFrameSubscription(false, (image) => {
          latest = image;
          firstFrame();
        });
        const win = target.win;
        const waited = await waitFirstFrame({
          gotFirst,
          look: () => (win.isDestroyed() ? { closed: true, shown: false, loading: false } : { closed: false, shown: win.isVisible() && !win.isMinimized(), loading: contents.isLoading() || contents.isWaitingForResponse() }),
          poke: () => !win.isDestroyed() && contents.invalidate(),
          timing: waitTiming,
        });
        if (!waited.ok) throw Object.assign(new Error(waited.reason), { code: waited.code, hint: waited.hint });
        if (waited.waited > 3000) log(`[shell] capture: the window's first frame came after ${waited.waited} ms`);
        until.onStarted?.();
        let sent = null;
        let pending = 0;
        let taken = 0;
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) {
          if (until.stop?.aborted && i > 0) break;
          const due = t0 + (i * 1000) / fps;
          const ahead = due - performance.now();
          if (ahead > 1) await new Promise((resolve) => setTimeout(resolve, ahead));
          if (performance.now() - due > 500 / fps) stats.late++;
          pending = i - page.acks.count;
          const image = latest;
          if (image !== sent && pending < MAX_PENDING) {
            const size = image.getSize(target.scale);
            const bitmap = image.toBitmap({ scaleFactor: target.scale });
            const width = size.width;
            const height = bitmap.length / 4 / width;
            first ??= { width, height };
            if (width !== first.width || height !== first.height) stats.resized = true;
            page.send({ i, bitmap, width, height });
            sent = image;
          } else {
            if (image !== sent) stats.repeated++;
            page.send({ i, repeat: true });
          }
          taken = i + 1;
        }
        page.send({ end: true, frames: taken });
        return null;
      });
      if (result.failed) return failure(result);
      const bytes = write(out, result.finished, started);
      return { answer: "encoded", bytes, codec: result.finished.codec, encoder: result.finished.encoder, decoded: result.finished.decoded, width: result.finished.width, height: result.finished.height, repeated: stats.repeated, late: stats.late, resized: stats.resized };
    } catch (e) {
      return { answer: "unavailable", reason: String(e?.message ?? e), ...(e?.code ? { code: e.code } : {}), ...(e?.hint ? { hint: e.hint } : {}) };
    } finally {
      try {
        contents.endFrameSubscription();
      } catch {
        // The window is gone.
      }
    }
  }

  return { encodeClip, recordWindow };
}

/**
 * Waits for the window's first frame while there is reason to (EMU-299): resolves { ok: true, waited } once it came,
 * or { ok: false, code, reason, hint } with what was wrong when it gave up: the window closed or hidden
 * ("window_hidden"), its page still loading ("window_loading"), or on the screen and loaded but giving no frames
 * ("no_frames"). The reason is a clause the server puts after "The app's window cannot be recorded: ".
 *
 * @param {object} o
 * @param {Promise<unknown>} o.gotFirst  settles with the first frame
 * @param {() => { closed: boolean, shown: boolean, loading: boolean }} o.look  the window as it is now
 * @param {() => void} [o.poke]  asks the window to draw again
 * @param {{ quietMs: number, ceilingMs: number, stepMs: number }} [o.timing]
 * @param {() => number} [o.now]
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
export async function waitFirstFrame({ gotFirst, look, poke = () => {}, timing = FIRST_FRAME_WAIT, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let came = false;
  gotFirst.then(() => (came = true));
  const start = now();
  let busySince = start; // the last time the window was seen at work: loading
  const seconds = (ms) => `${Math.round(ms / 1000)} s`;
  for (;;) {
    if (came) return { ok: true, waited: now() - start };
    const state = look();
    const at = now();
    if (state.closed) return { ok: false, code: "window_hidden", reason: "it was closed before it gave a frame", hint: "Open the emulator's window, then record again." };
    if (state.loading) busySince = at;
    const deadline = Math.min(start + timing.ceilingMs, busySince + timing.quietMs);
    if (at >= deadline) {
      const waited = seconds(at - start);
      if (state.loading) return { ok: false, code: "window_loading", reason: `its page was still loading after ${waited}`, hint: "Wait until the window shows the BUSY Bar, then record again." };
      if (!state.shown) return { ok: false, code: "window_hidden", reason: `it is hidden or minimized and gave no frame in ${waited}`, hint: "Bring the emulator's window to the front, then record again." };
      return { ok: false, code: "no_frames", reason: `it is on the screen but gave no frame in ${waited}; the computer's graphics may be busy`, hint: "Record again in a moment; if it keeps failing, quit the emulator and start it again." };
    }
    poke();
    await Promise.race([gotFirst, sleep(Math.min(timing.stepMs, deadline - at))]);
  }
}
