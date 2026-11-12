// The hidden page that turns a take of the bar into H.264 (busy-emulator record; ../../capture-window.mjs). It gets
// the take over its preload's channel, draws every frame of the clip on a canvas of its own — the front display as
// LED dots in the device window's look, on the flat picture of the bar, the back display below it — encodes the
// frames with WebCodecs, decodes the result back to count its frames, and hands the samples to the main process,
// which writes the MP4. It reaches no network and steps by the encoder's queue, not by frames of drawing.
"use strict";

const FRONT = { width: 72, height: 16 };
const BACK = { width: 160, height: 80 };
// The LED look of the device window (packages/server/legacy-window/window.js, after busy-lib's LedRenderer): square
// LEDs with rounded corners, a gap between them, dark ones faintly visible, a soft glow of the picture under them.
const LED = { size: 0.85, radius: 0.5, darkThreshold: 0.04 * 255 * 3 };
const COLORS = { background: "#0a0a0a", text: "#a1a1a1", body: "#1c1c1c", edge: "#2e2e2e" };
// Where the front display lies on the bar's picture (busybar-device.png, 768×248), as the device window places it.
const ART = { width: 768, height: 248, front: { left: 0.0325, top: 0.246, width: 0.935, height: 0.644 } };
// H.264 High, then Main, then Baseline; level 4.0 (4.2 where 4.0 is too small). The hardware encoder first.
const PROFILES = ["6400", "4d00", "42e0"];

const decode64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function level(width, height, fps) {
  // H.264's levels by the largest frame and the most macroblocks a second (Table A-1): 4.0, 4.2, 5.0, 5.1, 5.2. A
  // window on a Retina screen is larger than 4.x allows.
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const perSecond = frame * fps;
  const levels = [["28", 8192, 245760], ["2a", 8704, 522240], ["32", 22080, 589824], ["33", 36864, 983040], ["34", 36864, 2073600]];
  return (levels.find(([, f, s]) => frame <= f && perSecond <= s) ?? levels.at(-1))[0];
}

/** The first H.264 configuration this machine can encode, hardware before software. */
async function chooseConfig(width, height, fps) {
  const bitrate = Math.max(1_000_000, Math.round((8_000_000 * width * height) / (1080 * 1920)));
  const tried = [];
  for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"]) {
    for (const profile of PROFILES) {
      const config = { codec: `avc1.${profile}${level(width, height, fps)}`, width, height, bitrate, framerate: fps, hardwareAcceleration, avc: { format: "avc" } };
      tried.push(`${config.codec} ${hardwareAcceleration}`);
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, hardware: hardwareAcceleration === "prefer-hardware" };
      } catch {
        // A configuration this Chromium does not know: the next.
      }
    }
  }
  const error = new Error(`no H.264 encoder on this machine takes a ${width}×${height} clip (tried ${tried.join(", ")})`);
  error.missing = "H.264 encoder";
  throw error;
}

function makeDrawing(job, art) {
  const { width, height, layout } = job;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  const frontSource = new OffscreenCanvas(FRONT.width, FRONT.height);
  const frontCtx = frontSource.getContext("2d");
  const backSource = new OffscreenCanvas(BACK.width, BACK.height);
  const backCtx = backSource.getContext("2d");
  const fronts = job.front.map(decode64);
  const backs = job.back.map(decode64);

  function putFront(pixels) {
    const image = frontCtx.createImageData(FRONT.width, FRONT.height);
    for (let i = 0; i < FRONT.width * FRONT.height; i++) image.data.set([pixels[i * 3 + 2], pixels[i * 3 + 1], pixels[i * 3], 255], i * 4);
    frontCtx.putImageData(image, 0, 0);
  }

  /** The front display as LEDs in the box x, y, w, h. */
  function drawLeds(pixels, x, y, w, h) {
    const cell = w / FRONT.width;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.45;
    ctx.filter = `blur(${cell * 0.9}px)`;
    ctx.drawImage(frontSource, x, y, w, h);
    ctx.restore();
    const size = cell * LED.size;
    const radius = (size / 2) * Math.sqrt(LED.radius);
    const offset = (cell - size) / 2;
    for (let ly = 0; ly < FRONT.height; ly++) {
      for (let lx = 0; lx < FRONT.width; lx++) {
        const i = (ly * FRONT.width + lx) * 3;
        const b = pixels[i], g = pixels[i + 1], r = pixels[i + 2];
        ctx.fillStyle = r + g + b < LED.darkThreshold ? "rgba(255,255,255,0.035)" : `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.roundRect(x + lx * cell + offset, y + ly * (h / FRONT.height) + offset, size, size, radius);
        ctx.fill();
      }
    }
  }

  /** The back display: 4-bit gray, whole pixels, in a black frame like the device window's. */
  function drawBack(bytes, x, y, scale) {
    const image = backCtx.createImageData(BACK.width, BACK.height);
    for (let i = 0; i < BACK.width * BACK.height; i++) {
      const v = ((bytes[i >> 1] >> ((i & 1) * 4)) & 0xf) * 17;
      image.data.set([v, v, v, 255], i * 4);
    }
    backCtx.putImageData(image, 0, 0);
    const pad = Math.round(scale * 7);
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.roundRect(x - pad, y - pad, BACK.width * scale + 2 * pad, BACK.height * scale + 2 * pad, pad);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(backSource, x, y, BACK.width * scale, BACK.height * scale);
    ctx.imageSmoothingEnabled = true;
  }

  /** The bar at x, y, w wide: its picture, or a plain body when there is none, and the front display on it. */
  function drawBar(pixels, x, y, w) {
    const h = (w * ART.height) / ART.width;
    // The light of the display on the desk around the bar.
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.filter = `blur(${Math.round(w / 14)}px)`;
    ctx.drawImage(frontSource, x + w * 0.05, y + h * 0.15, w * 0.9, h * 0.9);
    ctx.restore();
    if (art) ctx.drawImage(art, x, y, w, h);
    else {
      ctx.fillStyle = COLORS.body;
      ctx.beginPath();
      ctx.roundRect(x, y + h * 0.16, w, h * 0.84, h * 0.12);
      ctx.fill();
      ctx.strokeStyle = COLORS.edge;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.roundRect(x + w * 0.02, y + h * 0.21, w * 0.96, h * 0.74, h * 0.06);
      ctx.fill();
    }
    const f = ART.front;
    drawLeds(pixels, x + w * f.left - 0.5, y + h * f.top, w * f.width, h * f.height);
    return h;
  }

  function caption(text, y, size) {
    if (!text) return;
    ctx.fillStyle = COLORS.text;
    ctx.font = `500 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, width / 2, y, width * 0.8);
  }

  return {
    canvas,
    draw([f, b]) {
      const front = fronts[f];
      const back = backs[b];
      putFront(front);
      ctx.fillStyle = layout === "front" ? "#000" : COLORS.background;
      ctx.fillRect(0, 0, width, height);
      if (layout === "front") return drawLeds(front, 0, 0, width, height);
      if (layout === "post") {
        const barW = 1000;
        const barH = (barW * ART.height) / ART.width;
        const scale = 4;
        const backH = BACK.height * scale + 2 * scale * 7;
        const gap = 120;
        const top = Math.round((height - (barH + gap + backH)) / 2) - 40;
        drawBar(front, (width - barW) / 2, top, barW);
        drawBack(back, (width - BACK.width * scale) / 2, top + barH + gap + scale * 7, scale);
        caption(job.name, height - 220, 40);
        return;
      }
      // both: 1920×1080
      const barW = 1280;
      const barH = (barW * ART.height) / ART.width;
      const scale = 3;
      const backH = BACK.height * scale + 2 * scale * 7;
      const gap = 64;
      const top = Math.round((height - (barH + gap + backH)) / 2) - 24;
      drawBar(front, (width - barW) / 2, top, barW);
      drawBack(back, (width - BACK.width * scale) / 2, top + barH + gap + scale * 7, scale);
      caption(job.name, height - 36, 30);
    },
  };
}

async function encode(job) {
  const { width, height, fps, frames } = job;
  if (typeof VideoEncoder !== "function") throw Object.assign(new Error("this Chromium has no WebCodecs"), { missing: "WebCodecs" });
  const art = job.art && job.layout !== "front" ? await createImageBitmap(new Blob([job.art], { type: "image/png" })).catch(() => null) : null;
  const drawing = makeDrawing(job, art);
  const { config, hardware } = await chooseConfig(width, height, fps);

  const samples = [];
  let avcC = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === "key", timestamp: chunk.timestamp });
      const description = meta?.decoderConfig?.description;
      if (description && !avcC) avcC = new Uint8Array(ArrayBuffer.isView(description) ? description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength) : description.slice(0));
    },
    error(e) {
      failure ??= e;
    },
  });
  encoder.configure(config);
  const dequeued = () => new Promise((resolve) => encoder.addEventListener("dequeue", resolve, { once: true }));
  for (let i = 0; i < frames; i++) {
    if (failure) throw failure;
    drawing.draw(job.index[i]);
    const frame = new VideoFrame(drawing.canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: i % fps === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 3 && !failure) await dequeued();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!avcC) throw new Error("the encoder gave no decoder configuration (avcC)");
  if (samples.length !== frames) throw new Error(`the encoder gave ${samples.length} samples for ${frames} frames`);
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].timestamp <= samples[i - 1].timestamp) throw new Error("the encoder gave its samples out of order (B-frames), which this clip's file cannot hold");
  }

  const decoded = await decodeBack(samples, config.codec, avcC, width, height);

  return {
    samples: samples.map(({ data, key }) => ({ data, key })),
    avcC,
    codec: config.codec,
    encoder: `H.264 (${hardware ? "hardware" : "software"} encoder)`,
    decoded,
    width,
    height,
    fps,
  };
}

/** Decoded back in the same Chromium: the file's frames are what was encoded, and every one of them decodes. */
async function decodeBack(samples, codec, avcC, width, height) {
  let decoded = 0;
  let decodeFailure = null;
  const decoder = new VideoDecoder({
    output(frame) {
      decoded++;
      frame.close();
    },
    error(e) {
      decodeFailure ??= e;
    },
  });
  decoder.configure({ codec, description: avcC, codedWidth: width, codedHeight: height });
  for (const sample of samples) decoder.decode(new EncodedVideoChunk({ type: sample.key ? "key" : "delta", timestamp: sample.timestamp, data: sample.data }));
  await decoder.flush();
  decoder.close();
  if (decodeFailure) throw new Error(`the clip does not decode: ${decodeFailure.message}`);

  return decoded;
}

/** Checks what the encoder gave: every frame, in order, with its configuration. */
function checkSamples(samples, frames, avcC) {
  if (!avcC) throw new Error("the encoder gave no decoder configuration (avcC)");
  if (samples.length !== frames) throw new Error(`the encoder gave ${samples.length} samples for ${frames} frames`);
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].timestamp <= samples[i - 1].timestamp) throw new Error("the encoder gave its samples out of order (B-frames), which this clip's file cannot hold");
  }
}

/** An encoder that keeps its samples and the decoder configuration it gives. */
function makeEncoder(state) {
  return new VideoEncoder({
    output(chunk, meta) {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      state.samples.push({ data, key: chunk.type === "key", timestamp: chunk.timestamp });
      const description = meta?.decoderConfig?.description;
      if (description && !state.avcC) state.avcC = new Uint8Array(ArrayBuffer.isView(description) ? description.buffer.slice(description.byteOffset, description.byteOffset + description.byteLength) : description.slice(0));
    },
    error(e) {
      state.failure ??= e;
    },
  });
}

/**
 * The size of a clip of the window: the window's own in device pixels, made smaller to fit 1920×1080 (1080×1920 for a
 * window taller than wide), to even numbers. Instagram takes a clip at most 1920 wide, and a larger one needs H.264
 * level 5, which not every network's processing takes; a window on a Retina screen is about 2400×1600.
 */
function windowClipSize(width, height) {
  const [boxW, boxH] = width >= height ? [1920, 1080] : [1080, 1920];
  const scale = Math.min(1, boxW / width, boxH / height);
  return { width: Math.max(2, Math.round(width * scale) & ~1), height: Math.max(2, Math.round(height * scale) & ~1) };
}

/**
 * The app's main window, frame by frame as the main process sends them (BGRA, device pixels): frame i at i / fps, a
 * frame that did not come in time repeats the one before. The clip has the size of the first frame made to fit
 * windowClipSize; a later frame of another size is scaled to it. Every frame is drawn on a canvas of the clip's size
 * and encoded from there: the encoder then takes video range (yuv420p, BT.709), as for the layouts of the bar; a frame
 * of raw BGRA bytes it takes as full range (yuvj420p), which the networks' specifications do not name.
 */
async function encodeWindow(job) {
  const { fps, frames } = job;
  if (typeof VideoEncoder !== "function") throw Object.assign(new Error("this Chromium has no WebCodecs"), { missing: "WebCodecs" });
  const next = () => (frameQueue.length ? Promise.resolve(frameQueue.shift()) : new Promise((resolve) => (frameWake = () => ((frameWake = null), resolve(frameQueue.shift())))));
  const state = { samples: [], avcC: null, failure: null };
  let encoder = null;
  let chosen = null;
  let size = null;
  let last = null;
  let canvas = null;
  let total = frames;
  for (;;) {
    const message = await next();
    if (message.end) {
      // A take the window's Record button ended early says how many frames it has.
      if (Number.isInteger(message.frames)) total = message.frames;
      break;
    }
    if (state.failure) throw state.failure;
    const timestamp = Math.round((message.i * 1e6) / fps);
    let frame;
    if (message.repeat) {
      if (!last) throw new Error("the window's first frame did not come");
      frame = new VideoFrame(last, { timestamp, duration: Math.round(1e6 / fps) });
    } else {
      if (!encoder) {
        size = windowClipSize(message.width, message.height);
        chosen = await chooseConfig(size.width, size.height, fps);
        encoder = makeEncoder(state);
        encoder.configure(chosen.config);
        canvas = new OffscreenCanvas(size.width, size.height);
      }
      // A frame of another size than the first (the window was resized during the take) is scaled to the clip's.
      const source = new VideoFrame(message.bitmap, { format: "BGRA", codedWidth: message.width, codedHeight: message.height, timestamp });
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, size.width, size.height);
      source.close();
      frame = new VideoFrame(canvas, { timestamp, duration: Math.round(1e6 / fps) });
      last?.close();
      last = frame.clone();
    }
    encoder.encode(frame, { keyFrame: message.i % fps === 0 });
    frame.close();
    window.busyCapture.ack(message.i);
    while (encoder.encodeQueueSize > 4 && !state.failure) await new Promise((resolve) => encoder.addEventListener("dequeue", resolve, { once: true }));
  }
  last?.close();
  if (!encoder) throw new Error("the window gave no frame");
  await encoder.flush();
  encoder.close();
  if (state.failure) throw state.failure;
  checkSamples(state.samples, total, state.avcC);
  const decoded = await decodeBack(state.samples, chosen.config.codec, state.avcC, size.width, size.height);
  return {
    samples: state.samples.map(({ data, key }) => ({ data, key })),
    avcC: state.avcC,
    codec: chosen.config.codec,
    encoder: `H.264 (${chosen.hardware ? "hardware" : "software"} encoder)`,
    decoded,
    width: size.width,
    height: size.height,
    fps,
  };
}

// The main window's frames, kept from the moment the page runs: none may come before there is somebody to take it.
const frameQueue = [];
let frameWake = null;
window.busyCapture.onFrame((message) => {
  frameQueue.push(message);
  frameWake?.();
});

(async () => {
  let job;
  try {
    job = await window.busyCapture.job();
    await window.busyCapture.finish(await (job.kind === "window" ? encodeWindow(job) : encode(job)));
  } catch (e) {
    await window.busyCapture.fail({ reason: String(e?.message ?? e), ...(e?.missing ? { missing: e.missing } : {}) });
  }
})();
