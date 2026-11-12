// The wait for the main window's first frame when its recording starts (capture-window.mjs, EMU-299): it lasts while
// the window is at work, up to a ceiling, and when it gives up it says what was wrong: closed or hidden, still
// loading, or on the screen with no frames. A first frame slower than the old fixed 3 s is waited for. The clock is a
// stand-in for the rules; the recording itself runs with stand-in windows and a slow first frame.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { createClipEncoder, FIRST_FRAME_WAIT, waitFirstFrame } from "../../src/capture-window.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const folders = [];
after(async () => {
  for (const folder of folders) await removeFolder(folder);
});

/** A clock of its own: sleeping moves it on; the frame comes when it passes `frameAt`; `state(t)` is the window at t. */
function standIn({ frameAt = Infinity, state = () => ({ closed: false, shown: true, loading: false }) }) {
  let t = 0;
  let resolveFirst;
  const gotFirst = new Promise((resolve) => (resolveFirst = resolve));
  const pokes = [];
  return {
    pokes,
    wait: () =>
      waitFirstFrame({
        gotFirst,
        look: () => state(t),
        poke: () => pokes.push(t),
        now: () => t,
        sleep: async (ms) => {
          t += ms;
          if (t >= frameAt) resolveFirst();
        },
      }),
  };
}

test("the defaults: ten seconds of quiet, a ceiling well past them, the window asked to draw again each half second", () => {
  assert.deepEqual({ ...FIRST_FRAME_WAIT }, { quietMs: 10_000, ceilingMs: 45_000, stepMs: 500 });
});

test("a first frame slower than the old 3 s is waited for; so is one that comes while the page loads, past the quiet time", async () => {
  const slow = standIn({ frameAt: 5_000 });
  const got = await slow.wait();
  assert.equal(got.ok, true);
  assert.equal(got.waited, 5_000);
  assert.ok(slow.pokes.length >= 10, `asked to draw ${slow.pokes.length} times`);

  // Loading for 20 s, the frame at 26 s: the quiet time counts from the end of the loading.
  const loading = standIn({ frameAt: 26_000, state: (t) => ({ closed: false, shown: true, loading: t < 20_000 }) });
  assert.deepEqual(await loading.wait(), { ok: true, waited: 26_000 });
});

test("no frame from a window on the screen: no_frames after the quiet time, with the seconds; it does not say hidden", async () => {
  const answer = await standIn({}).wait();
  assert.equal(answer.ok, false);
  assert.equal(answer.code, "no_frames");
  assert.match(answer.reason, /on the screen but gave no frame in 10 s/);
  assert.doesNotMatch(answer.reason, /hidden/);
  assert.match(answer.hint, /Record again/);
});

test("a hidden or minimized window, one still loading at the ceiling, one closed: each says so, with a next step", async () => {
  const hidden = await standIn({ state: () => ({ closed: false, shown: false, loading: false }) }).wait();
  assert.deepEqual([hidden.code, hidden.reason], ["window_hidden", "it is hidden or minimized and gave no frame in 10 s"]);
  assert.match(hidden.hint, /front/);

  const loading = await standIn({ state: () => ({ closed: false, shown: true, loading: true }) }).wait();
  assert.deepEqual([loading.code, loading.reason], ["window_loading", "its page was still loading after 45 s"]);
  assert.match(loading.hint, /shows the BUSY Bar/);

  const closed = await standIn({ state: (t) => ({ closed: t >= 2_000, shown: true, loading: false }) }).wait();
  assert.deepEqual([closed.code, closed.reason], ["window_hidden", "it was closed before it gave a frame"]);
});

/** The encoder with stand-ins for Electron: the encoding page fails on purpose once it is sent the first frame. */
function encoderWith({ firstFrameAfter, loadingFor = 0, timing }) {
  const dataDir = temporaryFolder();
  folders.push(dataDir);
  mkdirSync(path.join(dataDir, "captures"));
  let handler = null;
  const logs = [];
  let nextId = 1;
  class BrowserWindow {
    constructor() {
      const id = nextId++;
      let destroyed = false;
      this.isDestroyed = () => destroyed;
      this.destroy = () => (destroyed = true);
      const event = { sender: { id } };
      this.webContents = {
        id,
        once() {},
        send(_channel, message) {
          if (message.i === 0 && message.bitmap) handler(event, "fail", { reason: "the stand-in page took the first frame" });
        },
      };
      this.loadURL = async () => setTimeout(() => handler(event, "job"), 5);
    }
  }
  const t0 = Date.now();
  const image = { getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.alloc(16) };
  const contents = {
    beginFrameSubscription: (_dirty, onFrame) => firstFrameAfter !== null && setTimeout(() => onFrame(image), firstFrameAfter),
    endFrameSubscription() {},
    invalidate() {},
    isLoading: () => Date.now() - t0 < loadingFor,
    isWaitingForResponse: () => false,
  };
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, webContents: contents };
  const encoder = createClipEncoder({
    BrowserWindow,
    ipcMain: { handle: (_channel, fn) => (handler = fn) },
    registry: { register() {} },
    session: () => ({}),
    dataDir,
    preloadPath: "capture-preload.cjs",
    art: null,
    windowFor: async () => ({ win, scale: 1 }),
    log: (line) => logs.push(line),
    waitTiming: timing,
  });
  const question = { out: path.join(dataDir, "captures", "clip-1.mp4"), fps: 10, frames: 3 };
  return { record: () => encoder.recordWindow(question, new AbortController().signal), logs };
}

test("recording the window: a first frame after 3.5 s, while the page still loads, past the quiet time, starts the take", async () => {
  const { record } = encoderWith({ firstFrameAfter: 3_500, loadingFor: 3_300, timing: { quietMs: 300, ceilingMs: 6_000, stepMs: 20 } });
  const answer = await record();
  // The take began: the page was sent the first frame (and the stand-in page then ended it).
  assert.deepEqual(answer, { answer: "unavailable", reason: "the stand-in page took the first frame" });
});

test("recording the window: no frame from a window on the screen is no_frames, with the reason and the next step", async () => {
  const { record } = encoderWith({ firstFrameAfter: null, timing: { quietMs: 600, ceilingMs: 2_000, stepMs: 20 } });
  const answer = await record();
  assert.equal(answer.answer, "unavailable");
  assert.equal(answer.code, "no_frames");
  assert.match(answer.reason, /on the screen but gave no frame in 1 s/);
  assert.match(answer.hint, /Record again/);
});
