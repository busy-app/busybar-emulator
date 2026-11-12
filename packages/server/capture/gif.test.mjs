// The GIF of busy-emulator record --gif (gif.mjs, led-raster.mjs) and the options of a clip (record.mjs): decoded here
// by a decoder of the test's own, frame by frame, pixel by pixel.
import assert from "node:assert/strict";
import { test } from "node:test";

import { GIF_LIMITS, gifMaxFrames, gifTooLarge } from "./clip-limits.mjs";
import { encodeFrontGif, encodeGif } from "./gif.mjs";
import { BACKGROUND, DARK_LED, ledMask, renderFront } from "./led-raster.mjs";
import { clipSize, encodeGifOffThread, recordOptions, recordTake } from "./record.mjs";

/** A GIF decoder for what encodeGif writes: frames as RGB, delays in hundredths. */
function decodeGif(bytes) {
  let at = 6;
  const word = () => bytes[at++] | (bytes[at++] << 8);
  const width = word();
  const height = word();
  const flags = bytes[at++];
  at += 2;
  const readTable = (bits) => {
    const table = [];
    for (let i = 0; i < 1 << bits; i++, at += 3) table.push([bytes[at], bytes[at + 1], bytes[at + 2]]);
    return table;
  };
  const global = flags & 0x80 ? readTable((flags & 7) + 1) : null;
  const frames = [];
  let delay = 0;
  let loops = false;
  for (;;) {
    const kind = bytes[at++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = bytes[at++];
      if (label === 0xf9) delay = bytes[at + 2] | (bytes[at + 3] << 8);
      if (label === 0xff) loops = Buffer.from(bytes.subarray(at + 1, at + 12)).toString("latin1") === "NETSCAPE2.0";
      while (bytes[at]) at += bytes[at] + 1;
      at++;
      continue;
    }
    assert.equal(kind, 0x2c, "an image");
    at += 8;
    const imageFlags = bytes[at++];
    const table = imageFlags & 0x80 ? readTable((imageFlags & 7) + 1) : global;
    const minCode = bytes[at++];
    const data = [];
    while (bytes[at]) {
      data.push(...bytes.subarray(at + 1, at + 1 + bytes[at]));
      at += bytes[at] + 1;
    }
    at++;
    const indices = lzwDecode(data, minCode, width * height);
    const rgb = new Uint8Array(width * height * 3);
    indices.forEach((index, i) => rgb.set(table[index], i * 3));
    frames.push({ rgb, delay });
  }
  return { width, height, frames, loops };
}

function lzwDecode(data, minCode, count) {
  const clear = 1 << minCode;
  const out = [];
  let size = minCode + 1;
  let dictionary = [];
  const reset = () => {
    dictionary = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = minCode + 1;
  };
  reset();
  let bit = 0;
  let previous = null;
  const read = () => {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    return code;
  };
  for (;;) {
    const code = read();
    if (code === clear) {
      reset();
      previous = null;
      continue;
    }
    if (code === clear + 1) break;
    let entry;
    if (code < dictionary.length) entry = dictionary[code];
    else entry = [...previous, previous[0]];
    out.push(...entry);
    if (previous) dictionary.push([...previous, entry[0]]);
    previous = entry;
    if (dictionary.length === 1 << size && size < 12) size++;
  }
  assert.equal(out.length, count, "every pixel of the frame");
  return out;
}

/** A front frame (B, G, R) where every LED has a color of its own, moved on by `shift`. */
function frontFrame(shift) {
  const frame = new Uint8Array(72 * 16 * 3);
  for (let i = 0; i < 72 * 16; i++) {
    const v = (i + shift) % 40;
    frame.set([v * 6, 255 - v * 6, v % 2 ? 200 : 0], i * 3);
  }
  return frame;
}

test("a GIF of LED frames decodes to exactly those frames, equal frames merged, delays keeping the clip's time", () => {
  const scale = 4;
  const frames = [0, 0, 0, 1, 2, 2].map((shift) => renderFront(frontFrame(shift), scale));
  const gif = encodeGif(frames, { width: 72 * scale, height: 16 * scale, fps: 25 });
  const decoded = decodeGif(gif);
  assert.equal(decoded.width, 288);
  assert.equal(decoded.height, 64);
  assert.ok(decoded.loops);
  assert.equal(decoded.frames.length, 3, "runs of equal frames are one frame each");
  assert.deepEqual(decoded.frames.map((f) => f.delay), [12, 4, 8]);
  for (const [i, shift] of [0, 1, 2].entries()) assert.deepEqual(decoded.frames[i].rgb, renderFront(frontFrame(shift), scale), `frame ${i}`);
});

test("the GIF of a take, from the bar's own frames: the same picture as the RGB way, each distinct frame drawn once", () => {
  const scale = 4;
  const fronts = [frontFrame(0), frontFrame(1), frontFrame(2)];
  const steps = [0, 0, 0, 1, 2, 2, 0];
  const gif = encodeFrontGif(fronts, steps, { scale, fps: 25 });
  const reference = encodeGif(steps.map((f) => renderFront(fronts[f], scale)), { width: 72 * scale, height: 16 * scale, fps: 25 });
  const [mine, theirs] = [decodeGif(gif), decodeGif(reference)];
  assert.deepEqual([mine.width, mine.height, mine.loops], [288, 64, true]);
  assert.deepEqual(mine.frames.map((f) => f.delay), [12, 4, 8, 4]);
  assert.deepEqual(mine.frames.map((f) => f.delay), theirs.frames.map((f) => f.delay));
  for (const [i, frame] of mine.frames.entries()) assert.deepEqual(frame.rgb, theirs.frames[i].rgb, `frame ${i}`);

  // More than 256 colors on the display: a palette for each frame, low bits dropped, as the RGB way does.
  const noisy = new Uint8Array(72 * 16 * 3).map((_, i) => (i * 37) & 0xff);
  const one = decodeGif(encodeFrontGif([noisy], [0], { scale: 3, fps: 10 }));
  const other = decodeGif(encodeGif([renderFront(noisy, 3)], { width: 216, height: 48, fps: 10 }));
  assert.deepEqual(one.frames[0].rgb, other.frames[0].rgb);
});

test("a still screen for 1500 steps at scale 26 is one frame drawn once: no RGB copy for each step", () => {
  const before = process.memoryUsage().rss;
  const started = performance.now();
  const gif = encodeFrontGif([frontFrame(3)], Array(1500).fill(0), { scale: 26, fps: 50 });
  const ms = performance.now() - started;
  const decoded = decodeGif(gif);
  assert.equal(decoded.frames.length, 1);
  assert.equal(decoded.frames[0].delay, 3000);
  // The old way held 1500 frames of 1872 × 416 × 3 bytes: 3.5 GB. One frame of indices is under 1 MB.
  assert.ok(process.memoryUsage().rss - before < 200e6, `${Math.round((process.memoryUsage().rss - before) / 1e6)} MB more`);
  assert.ok(ms < 5000, `${Math.round(ms)} ms`);
});

test("a GIF's limits: frames (seconds × fps) and frames × scale × scale, with what to change; MP4 is not limited so", () => {
  assert.equal(GIF_LIMITS.frames, 750);
  assert.equal(gifMaxFrames(8), 750);
  assert.equal(gifMaxFrames(26), 142);
  assert.equal(gifTooLarge({ seconds: 30, fps: 25, scale: 8 }), null, "30 s at the defaults");
  assert.equal(gifTooLarge({ seconds: 5, fps: 25, scale: 26 }), null);
  const said = gifTooLarge({ seconds: 30, fps: 50, scale: 26 });
  assert.match(said, /^a GIF of 30 s at 50 frames a second is 1500 frames, too many at scale 26: a GIF has at most 750 frames \(seconds × fps\), and frames × scale × scale at most 96000, which at scale 26 is 142 frames \(2 s at 50 frames a second\)\. Record fewer seconds, fewer frames a second or a smaller scale, or an MP4$/);
  assert.match(gifTooLarge({ seconds: 20, fps: 50, scale: 4 }), /1000 frames, too many at scale 4: .* which at scale 4 is 750 frames/);
  const options = (query) => recordOptions(new URLSearchParams(query));
  assert.throws(() => options("format=gif&seconds=30&fps=50&scale=26"), { name: "RangeError", message: said });
  assert.throws(() => options("format=gif&seconds=6&scale=26"), RangeError, "150 frames at the default 25 a second");
  assert.equal(options("format=gif&seconds=5&scale=26").frames, 125);
  assert.equal(options("layout=front&seconds=30&fps=60&scale=26").frames, 1800, "an MP4 is encoded by the window");
});

test("the GIF is encoded on a thread of its own, and a caller that goes away stops it", async () => {
  const fronts = [frontFrame(0), frontFrame(5)];
  const gif = await encodeGifOffThread({ fronts, steps: [0, 1, 1], scale: 4, fps: 25 });
  assert.deepEqual(gif, encodeFrontGif(fronts, [0, 1, 1], { scale: 4, fps: 25 }));
  const stop = new AbortController();
  const encoding = encodeGifOffThread({ fronts: Array.from({ length: 140 }, (_, k) => frontFrame(k)), steps: Array.from({ length: 140 }, (_, k) => k), scale: 26, fps: 50, signal: stop.signal });
  stop.abort();
  await assert.rejects(encoding, { code: "canceled" });
});

test("a frame of more than 256 colors still encodes, with low bits of each channel dropped", () => {
  const width = 64;
  const height = 64;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set([i & 0xff, (i >> 4) & 0xff, (i * 3) & 0xff], i * 3);
  const decoded = decodeGif(encodeGif([rgb], { width, height, fps: 10 }));
  const colors = new Set();
  for (let i = 0; i < rgb.length; i += 3) colors.add(decoded.frames[0].rgb.subarray(i, i + 3).join());
  assert.ok(colors.size <= 256);
  for (let i = 0; i < rgb.length; i++) assert.ok(Math.abs(decoded.frames[0].rgb[i] - rgb[i]) < 32);
});

test("the LED raster: a rounded LED in every cell, a dark LED faintly lit, the gap black", () => {
  const mask = ledMask(10);
  assert.equal(mask[0], 0, "a corner of the cell is the gap");
  assert.equal(mask[5 * 10 + 5], 1, "the middle is the LED");
  const rgb = renderFront(new Uint8Array(72 * 16 * 3), 10);
  assert.deepEqual([...rgb.subarray(0, 3)], BACKGROUND);
  const middle = (5 * 720 + 5) * 3;
  assert.deepEqual([...rgb.subarray(middle, middle + 3)], DARK_LED);
});

test("a clip's options: defaults, the sizes of the layouts, and what is refused", () => {
  const options = (query) => recordOptions(new URLSearchParams(query));
  assert.deepEqual(options(""), { format: "mp4", layout: "window", seconds: 5, fps: 30, scale: 15, frames: 150, width: null, height: null });
  assert.deepEqual(options("layout=post"), { format: "mp4", layout: "post", seconds: 5, fps: 30, scale: 15, frames: 150, width: 1080, height: 1920 });
  assert.deepEqual(clipSize("both", 0), { width: 1920, height: 1080 });
  assert.deepEqual(options("layout=front&scale=10"), { format: "mp4", layout: "front", seconds: 5, fps: 30, scale: 10, frames: 150, width: 720, height: 160 });
  assert.deepEqual(options("format=gif"), { format: "gif", layout: "front", seconds: 5, fps: 25, scale: 8, frames: 125, width: 576, height: 128 });
  for (const bad of ["seconds=0", "seconds=121", "fps=61", "fps=2.5", "layout=square", "format=webm", "format=gif&layout=post", "scale=1"]) {
    assert.throws(() => options(bad), RangeError, bad);
  }
});

test("a take steps the held clock by the clip's frame times and reads both displays at each step", async () => {
  const steps = [];
  let held = false;
  let released = 0;
  let time = 0;
  const screen = {
    get held() {
      return held;
    },
    hold: () => (held = true),
    release: () => ((held = false), released++),
    now: () => time,
    advance: (ms) => ((time += ms), steps.push(ms)),
    frame: (display) => new Uint8Array(display === 0 ? 3456 : 6400).fill(Math.floor(time / 100) % 3),
  };
  let clock = 0;
  const take = await recordTake({ screen: () => screen, frames: 7, fps: 30, now: () => clock, wait: async (ms) => (clock += ms) });
  assert.deepEqual(steps, [33, 34, 33, 33, 34, 33], "frame i at round(i × 1000 / 30) ms");
  assert.equal(take.index.length, 7);
  assert.deepEqual(take.index.map(([f]) => f), [0, 0, 0, 1, 1, 1, 2], "a frame kept once, then pointed at");
  assert.equal(take.front.length, 3);
  assert.equal(take.late, 0);
  assert.equal(released, 1, "a clock the take held is let go");
  assert.equal(take.heldBefore, false);

  // A clock held before the take stays held: a script set the scene in held time.
  held = true;
  await recordTake({ screen: () => screen, frames: 2, fps: 30, now: () => clock, wait: async (ms) => (clock += ms) });
  assert.equal(held, true);
  assert.equal(released, 1);
});
