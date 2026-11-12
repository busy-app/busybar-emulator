// Helpers for the capture tests: a PNG reader that shares no code with the encoder, a builder for PNGs by hand, and
// temporary folders. Not used by the server. Nothing here comes from the catalog, so this file is public; what runs
// the catalog's own checker is in catalog-test-support.mjs, which is not (see README.md).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync, inflateSync } from "node:zlib";

// ---------------------------------------------------------------- reading a PNG

/**
 * Decodes an 8-bit, non-interlaced grayscale or RGB PNG into rows of samples, checking every chunk's CRC. Undoes all
 * five filter types, so it does not rely on the encoder using filter 0.
 */
export function decodePng(bytes) {
  const data = Buffer.from(bytes);
  if (!data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error("no signature");
  const chunks = [];
  for (let at = 8; at < data.length; ) {
    const size = data.readUInt32BE(at);
    const type = data.toString("latin1", at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + size);
    if (crc32(data.subarray(at + 4, at + 8 + size)) !== data.readUInt32BE(at + 8 + size)) throw new Error(`bad CRC in ${type}`);
    chunks.push({ type, body });
    at += 12 + size;
  }
  const ihdr = chunks[0].body;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const [depth, color, , , interlace] = ihdr.subarray(8);
  if (depth !== 8 || interlace !== 0 || (color !== 0 && color !== 2)) throw new Error("the test reader takes 8-bit gray or RGB only");
  const bpp = color === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.body)));
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) throw new Error(`image data is ${raw.length} bytes`);
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`filter ${filter}`);
      out[y * stride + i] = (line[i] + predictor) & 0xff;
    }
  }
  return { width, height, color, chunks: chunks.map((c) => c.type), samples: out };
}

/** The color the bar shows at (x, y), as [R, G, B], read straight from a frame in the core's format. */
export function framePixel(name, frame, x, y) {
  if (name === "front") {
    const i = (y * 72 + x) * 3;
    return [frame[i + 2], frame[i + 1], frame[i]];
  }
  const i = y * 160 + x;
  const level = (frame[Math.floor(i / 2)] >> (i % 2 === 0 ? 0 : 4)) & 0x0f;
  return [level * 17, level * 17, level * 17];
}

/** The same pixel from a decoded PNG. */
export function pngPixel(image, x, y) {
  if (image.color === 2) {
    const i = (y * image.width + x) * 3;
    return [image.samples[i], image.samples[i + 1], image.samples[i + 2]];
  }
  const v = image.samples[y * image.width + x];
  return [v, v, v];
}

// ---------------------------------------------------------------- frames in the core's format

/** A front frame: fill(i) gives [B, G, R] of LED i (rows top to bottom). */
export const frontFrame = (fill) => {
  const f = new Uint8Array(72 * 16 * 3);
  for (let i = 0; i < 72 * 16; i++) f.set(fill(i), i * 3);
  return f;
};

/** A back frame: level(i) gives the 4-bit level of pixel i (rows top to bottom). */
export const backFrame = (level) => {
  const f = new Uint8Array((160 * 80) / 2);
  for (let i = 0; i < 160 * 80; i++) f[i >> 1] |= (level(i) & 0x0f) << ((i & 1) * 4);
  return f;
};

// Every LED a color of its own: blue and green spell the LED's number, red mixes it, so no two are alike.
export const allDifferent = frontFrame((i) => [i & 0xff, i >> 8, (i * 97 + 31) & 0xff]);

/** [display, label, frame]: the frames at the edges of what each display can show. */
export const EDGE_FRAMES = [
  ["front", "front-black", frontFrame(() => [0, 0, 0])],
  ["front", "front-white", frontFrame(() => [255, 255, 255])],
  ["front", "front-every-led-different", allDifferent],
  ["front", "front-channels", frontFrame((i) => [[255, 0, 0], [0, 255, 0], [0, 0, 255]][i % 3])],
  ["back", "back-black", backFrame(() => 0)],
  ["back", "back-white", backFrame(() => 15)],
  // each of the 16 levels on its own, and all of them side by side in every row (odd and even pixels)
  ...Array.from({ length: 16 }, (_, level) => ["back", `back-level-${level}`, backFrame(() => level)]),
  ["back", "back-levels-across", backFrame((i) => i % 160)],
  ["back", "back-levels-checker", backFrame((i) => (Math.floor(i / 160) + i) % 16)],
];

// ---------------------------------------------------------------- building PNGs by hand, for the broken cases

export function pngChunk(type, body = Buffer.alloc(0)) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

export function ihdr(width, height, depth, color, interlace = 0) {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body.set([depth, color, 0, 0, interlace], 8);
  return pngChunk("IHDR", body);
}

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Raw rows of zeros (filter 0) for an image of this format, interlaced (Adam7) or not. */
export function zeroRows(width, height, depth, channels, interlace = 0) {
  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let size = 0;
  for (const [x, y, dx, dy] of passes) {
    const w = Math.ceil((width - x) / dx);
    const h = Math.ceil((height - y) / dy);
    if (w > 0 && h > 0) size += h * (Math.ceil((w * channels * depth) / 8) + 1);
  }
  return Buffer.alloc(size);
}

/** A whole PNG from its parts: IHDR, any chunks, IDAT of `rows`, IEND. */
export function buildPng({ header, before = [], rows, after = [] }) {
  return Buffer.concat([SIGNATURE, header, ...before, pngChunk("IDAT", deflateSync(rows)), ...after, pngChunk("IEND")]);
}

/** A temporary folder that the test removes when it ends. */
export function tempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "busy-capture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeFiles(dir, files) {
  return files.map(([display, name, bytes]) => {
    const file = path.join(dir, name);
    writeFileSync(file, bytes);
    return [display, file];
  });
}
