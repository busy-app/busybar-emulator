// What the BUSY Apps Catalog says about a screenshot file.
//
// Two parts, of different origin:
//
// 1. The manifest-stage rules (readChunks, readHeader, inflate, checkScanlines and the checks in checkCatalogPng up
//    to the build stage) are a port to JavaScript of `validate_png` and its helpers in `tools/check_png.py` of the
//    catalog repository `busy-app/busy-apps-catalog`, commit cd70f339688523a0d0be6869ed8835f17ad941d4
//    (RULES_COMMIT below): the same steps in the same order, with the same names where JavaScript allows. That file
//    is distributed under the MIT License:
//
//      Copyright (c) 2026 Flipper Devices
//
//      Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//      documentation files (the "Software"), to deal in the Software without restriction, including without
//      limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
//      Software, and to permit persons to whom the Software is furnished to do so, subject to the following
//      conditions:
//
//      The above copyright notice and this permission notice shall be included in all copies or substantial
//      portions of the Software.
//
//      THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
//      TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
//      THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//      CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//      DEALINGS IN THE SOFTWARE.
//
// 2. The build-stage part (buildStage, paletteIndicesFit) is the emulator's own. The catalog's build checks its copy
//    of each screenshot again with the same rules (`screenshot_final`, `back_screenshot_final`) and then re-saves it
//    as RGBA through Pillow (`tools/lib_png.py`); Pillow refuses some files the rules accept. Rather than model
//    Pillow, the build-stage part vouches only for files made of a small set of chunks, each well formed, and says
//    "unverified" for everything else. README.md next to this file lists what is vouched for and what is not.
//
// The catalog stops at the first rule a file breaks and reports one check id for it, so this does too. Every rule of
// a screenshot reports the same id: `screenshot_png` for a front screenshot, `back_screenshot_png` for a back one.
// `reason` tells the rules apart, for tests and for the text shown to the author.
//
// The work grows with the file (up to 2 MiB of chunks, 1 MiB of image data) and runs synchronously; a file of tiny
// chunks takes tens of milliseconds. Do not call it on the bar's tick path.
import { crc32, inflateSync } from "node:zlib";

import { PNG_SIGNATURE } from "./png.mjs";

/** The catalog commit the rules here were ported from; the registry snapshot must name the same one. */
export const RULES_COMMIT = "cd70f339688523a0d0be6869ed8835f17ad941d4";

export const CATALOG_PNG_RULES = Object.freeze({
  front: Object.freeze({ width: 72, height: 16, maxBytes: 2 * 1024 * 1024, id: "screenshot_png", finalId: "screenshot_final" }),
  back: Object.freeze({ width: 160, height: 80, maxBytes: 2 * 1024 * 1024, id: "back_screenshot_png", finalId: "back_screenshot_final" }),
});

/**
 * The catalog's rules for an app's icons (appmeta/icon_front_8x8.png, appmeta/icon_back_11x11.png): the same checks as
 * for a screenshot, with the icon's size and a limit of 64 KiB; the build checks and re-saves them under one check id.
 */
export const CATALOG_ICON_RULES = Object.freeze({
  icon_front: Object.freeze({ width: 8, height: 8, maxBytes: 64 * 1024, id: "icon_png", finalId: "icon_png" }),
  icon_back: Object.freeze({ width: 11, height: 11, maxBytes: 64 * 1024, id: "icon_png", finalId: "icon_png" }),
});

/** The catalog's limit on the decompressed image data. */
export const MAX_DECOMPRESSED = 1024 * 1024;

// Color type → the bit depths PNG allows for it, and its number of samples a pixel.
const DEPTHS = new Map([
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
]);
const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
// Adam7 passes as (x start, y start, x step, y step); an image without interlace is one pass.
const PLAIN = [[0, 0, 1, 1]];
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

const REASONS = {
  "too-large": (r) => `is larger than ${r.maxBytes >= 1024 * 1024 ? `${r.maxBytes / 1024 / 1024} MiB` : `${r.maxBytes / 1024} KiB`}`,
  "not-png": () => "is not a PNG file",
  "truncated-chunk": () => "is cut off in the middle of a chunk",
  checksum: () => "has a chunk whose CRC does not match",
  "header-missing": () => "does not start with a valid IHDR chunk",
  "header-duplicate": () => "has a second IHDR chunk",
  dimensions: (r, d) => `is ${d.width}×${d.height}, expected ${r.width}×${r.height}`,
  "header-unsupported": () => "has a color type, bit depth, compression, filter or interlace method PNG does not define",
  "bit-depth-16": () => "uses 16 bits per channel",
  ending: () => "has an IEND chunk with data, or bytes after IEND",
  incomplete: () => "ends before IEND or has no image data",
  "palette-missing": () => "is a palette image without a palette",
  "gray-transparency": () => "has a transparency key on a grayscale image of less than 8 bits",
  "compressed-data": () => "has image data that does not decompress",
  "image-data": () => `has image data that is cut off, followed by extra bytes, or larger than ${MAX_DECOMPRESSED} bytes`,
  scanline: () => "has a row with an unknown filter type",
  "data-length": () => "has image data of the wrong length for its size",
};

class Broken extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.reason = reason;
    this.details = details;
  }
}

// ---------------------------------------------------------------- the manifest-stage rules (ported, see above)

function readHeader(payload, rule) {
  if (payload.length !== 13) throw new Broken("header-missing");
  const width = payload.readUInt32BE(0);
  const height = payload.readUInt32BE(4);
  if (width !== rule.width || height !== rule.height) throw new Broken("dimensions", { width, height });
  const [depth, color, compression, filter, interlace] = payload.subarray(8);
  if (!DEPTHS.get(color)?.includes(depth) || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) {
    throw new Broken("header-unsupported");
  }
  if (depth === 16) throw new Broken("bit-depth-16");
  return { depth, color, interlace };
}

function readChunks(data, rule) {
  let offset = PNG_SIGNATURE.length;
  let header = null;
  let ended = false;
  const idat = [];
  const seen = new Set();
  const chunks = []; // every chunk in order, for the build stage
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset);
    const stop = offset + 12 + size;
    if (stop > data.length) throw new Broken("truncated-chunk");
    const kind = data.toString("latin1", offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, offset + 8 + size);
    if (crc32(data.subarray(offset + 4, offset + 8 + size)) !== data.readUInt32BE(offset + 8 + size)) {
      throw new Broken("checksum");
    }
    if (header === null) {
      if (kind !== "IHDR") throw new Broken("header-missing");
      header = readHeader(payload, rule);
    } else if (kind === "IHDR") {
      throw new Broken("header-duplicate");
    }
    seen.add(kind);
    chunks.push({ kind, payload });
    if (kind === "IDAT") idat.push(payload);
    if (kind === "IEND") {
      if (size !== 0 || stop !== data.length) throw new Broken("ending");
      ended = true;
      break;
    }
    offset = stop;
  }
  if (header === null || !ended || idat.length === 0) throw new Broken("incomplete");
  return { header, idat, seen, chunks };
}

function inflate(idat) {
  const input = Buffer.concat(idat);
  let result;
  try {
    // The catalog inflates with a 32 KiB window whatever the stream's header declares, in one call that stops at
    // the limit; windowBits 15 and one output chunk past the limit do the same here.
    result = inflateSync(input, {
      windowBits: 15,
      chunkSize: MAX_DECOMPRESSED + 1,
      maxOutputLength: MAX_DECOMPRESSED,
      info: true,
    });
  } catch (error) {
    // The stream ends early (zlib wants more input) or grows past the limit: the catalog finds the data incomplete or
    // oversized. Anything else zlib refuses is data that does not decompress.
    if (error.code === "Z_BUF_ERROR" || error.code === "ERR_BUFFER_TOO_LARGE") throw new Broken("image-data");
    throw new Broken("compressed-data");
  }
  if (result.buffer.length > MAX_DECOMPRESSED || result.engine.bytesWritten !== input.length) throw new Broken("image-data");
  return result.buffer;
}

function checkScanlines(pixels, header, rule) {
  const channels = CHANNELS.get(header.color);
  let position = 0;
  for (const [x, y, dx, dy] of header.interlace ? ADAM7 : PLAIN) {
    const passWidth = Math.max(0, Math.floor((rule.width - x + dx - 1) / dx));
    const passHeight = Math.max(0, Math.floor((rule.height - y + dy - 1) / dy));
    if (!passWidth || !passHeight) continue;
    const rowSize = Math.floor((passWidth * channels * header.depth + 7) / 8);
    for (let row = 0; row < passHeight; row++) {
      if (position >= pixels.length || pixels[position] > 4) throw new Broken("scanline");
      position += rowSize + 1;
    }
  }
  if (position !== pixels.length) throw new Broken("data-length");
}

// ---------------------------------------------------------------- the build stage (the emulator's own)

// Ancillary chunks vouched for, with the length PNG gives them; each may appear once, before or after the image data.
const FIXED_LENGTH = new Map([
  ["pHYs", 9],
  ["gAMA", 4],
  ["cHRM", 32],
  ["sRGB", 1],
  ["tIME", 7],
]);

// Names Pillow keeps in an image's `info` dictionary, where it also files the keywords of text chunks: a tEXt or iTXt
// chunk with one of these keywords overwrites Pillow's own decoding state (`transparency`, `interlace` and `bbox` make
// the catalog's re-save fail). Every quoted key read or written as `info[...]`, `im_info[...]`, `info.get(...)` or
// `... in info` in PIL/PngImagePlugin.py of Pillow 12.2.0; not checked against Pillow 11.3.0, which the catalog pins.
const PILLOW_INFO_KEYS = new Set([
  "append_images", "aspect", "bbox", "bits", "blend", "chromaticity", "compress_level", "compress_type",
  "default_image", "dictionary", "disposal", "dpi", "duration", "exif", "gamma", "icc_profile", "interlace", "loop",
  "optimize", "pnginfo", "srgb", "transparency", "xmp",
]);
const keyword = (payload, end) => payload.toString("latin1", 0, end);

/** Whether every palette index in the image data is below `entries`. Undoes the row filters to read the indices. */
function paletteIndicesFit(pixels, header, rule, entries) {
  const { depth } = header;
  let position = 0;
  for (const [x, y, dx, dy] of header.interlace ? ADAM7 : PLAIN) {
    const passWidth = Math.max(0, Math.floor((rule.width - x + dx - 1) / dx));
    const passHeight = Math.max(0, Math.floor((rule.height - y + dy - 1) / dy));
    if (!passWidth || !passHeight) continue;
    const rowSize = Math.floor((passWidth * depth + 7) / 8);
    let previous = new Uint8Array(rowSize);
    for (let row = 0; row < passHeight; row++) {
      const filter = pixels[position];
      const line = pixels.subarray(position + 1, position + 1 + rowSize);
      const current = new Uint8Array(rowSize);
      for (let i = 0; i < rowSize; i++) {
        const a = i > 0 ? current[i - 1] : 0;
        const b = previous[i];
        const c = i > 0 ? previous[i - 1] : 0;
        let p = 0;
        if (filter === 1) p = a;
        else if (filter === 2) p = b;
        else if (filter === 3) p = (a + b) >> 1;
        else if (filter === 4) {
          const q = a + b - c;
          const qa = Math.abs(q - a);
          const qb = Math.abs(q - b);
          const qc = Math.abs(q - c);
          p = qa <= qb && qa <= qc ? a : qb <= qc ? b : c;
        }
        current[i] = (line[i] + p) & 0xff;
      }
      for (let px = 0; px < passWidth; px++) {
        const bit = px * depth;
        const index = (current[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        if (index >= entries) return false;
      }
      previous = current;
      position += rowSize + 1;
    }
  }
  return true;
}

/**
 * Null when the file is of the kind whose re-save by the catalog's build is vouched for, otherwise what puts it
 * outside that kind.
 */
function buildStage(header, chunks, pixels, rule) {
  let idatSeen = false;
  let idatOver = false;
  let entries = 0;
  let transparency = false;
  const once = new Set();
  for (const { kind, payload } of chunks) {
    if (kind === "IHDR" || kind === "IEND") continue;
    if (kind === "IDAT") {
      if (idatOver) return "a chunk stands between two IDAT chunks";
      idatSeen = true;
      continue;
    }
    if (idatSeen) idatOver = true;
    if (kind === "PLTE") {
      if (header.color !== 3) return "it has a suggested palette (PLTE in an image that is not a palette image)";
      if (entries || transparency || idatSeen) return "its PLTE chunk is repeated or out of place";
      if (payload.length === 0 || payload.length % 3 !== 0 || payload.length > 768) {
        return `its PLTE chunk is ${payload.length} bytes, not 1 to 256 colors`;
      }
      entries = payload.length / 3;
    } else if (kind === "tRNS") {
      if (transparency || idatSeen) return "its tRNS chunk is repeated or after the image data";
      const want = header.color === 0 ? 2 : header.color === 2 ? 6 : null;
      if (header.color === 3) {
        if (!entries || payload.length === 0 || payload.length > entries) return `its tRNS chunk has ${payload.length} entries for ${entries} colors`;
      } else if (want === null || payload.length !== want) {
        return `its tRNS chunk is ${payload.length} bytes`;
      }
      transparency = true;
    } else if (FIXED_LENGTH.has(kind)) {
      if (once.has(kind)) return `its ${kind} chunk is repeated`;
      once.add(kind);
      if (payload.length !== FIXED_LENGTH.get(kind)) return `its ${kind} chunk is ${payload.length} bytes, not ${FIXED_LENGTH.get(kind)}`;
      if (kind === "sRGB" && payload[0] > 3) return "its sRGB chunk names an unknown rendering intent";
    } else if (kind === "bKGD") {
      // A background color (ImageMagick writes one by default): once, before the image data, in the image's format.
      if (once.has(kind) || idatSeen) return "its bKGD chunk is repeated or after the image data";
      once.add(kind);
      if (header.color === 3) {
        if (!entries || payload.length !== 1 || payload[0] >= entries) return "its bKGD chunk is not a color of the palette";
      } else if (payload.length !== (header.color === 2 || header.color === 6 ? 6 : 2)) {
        return `its bKGD chunk is ${payload.length} bytes`;
      }
    } else if (kind === "cICP") {
      // Coding-independent code points (macOS writes them for Display P3): once, before PLTE and the image data,
      // 4 bytes, matrix 0 (RGB) and a full-range flag of 0 or 1.
      if (once.has(kind) || entries || idatSeen) return "its cICP chunk is repeated or out of place";
      once.add(kind);
      if (payload.length !== 4 || payload[2] !== 0 || payload[3] > 1) return "its cICP chunk is malformed";
    } else if (kind === "tEXt") {
      const end = payload.indexOf(0);
      if (end < 1 || end > 79) return "its tEXt chunk has no valid keyword";
      if (PILLOW_INFO_KEYS.has(keyword(payload, end))) return `its tEXt keyword "${keyword(payload, end)}" is a name the catalog's image library uses itself`;
    } else if (kind === "iTXt") {
      // Uncompressed international text only: keyword, NUL, flag 0, method 0, then language and translated keyword.
      const end = payload.indexOf(0);
      if (end < 1 || end > 79) return "its iTXt chunk has no valid keyword";
      if (PILLOW_INFO_KEYS.has(keyword(payload, end))) return `its iTXt keyword "${keyword(payload, end)}" is a name the catalog's image library uses itself`;
      if (payload[end + 1] !== 0 || payload[end + 2] !== 0) return "its iTXt chunk is compressed or malformed";
      const rest = payload.subarray(end + 3);
      const lang = rest.indexOf(0);
      if (lang < 0 || rest.indexOf(0, lang + 1) < 0) return "its iTXt chunk is malformed";
    } else if (kind === "iCCP") {
      // A color profile: name, NUL, method 0, a zlib stream of at most 1 MiB (the limit of the catalog's Pillow).
      if (once.has(kind) || entries || idatSeen) return "its iCCP chunk is repeated or out of place";
      once.add(kind);
      const end = payload.indexOf(0);
      if (end < 1 || end > 79 || payload[end + 1] !== 0) return "its iCCP chunk is malformed";
      try {
        inflateSync(payload.subarray(end + 2), { windowBits: 15, maxOutputLength: 1024 * 1024 });
      } catch {
        return "its iCCP chunk holds a color profile that does not decompress within 1 MiB";
      }
    } else if (kind === "eXIf") {
      if (once.has(kind)) return "its eXIf chunk is repeated";
      once.add(kind);
    } else {
      return `it has a ${JSON.stringify(kind)} chunk`;
    }
  }
  if (header.color === 3 && !paletteIndicesFit(pixels, header, rule, entries)) return "a pixel uses a color outside the palette";
  return null;
}

/**
 * A grayscale or RGB image with a tRNS chunk names one color as transparent. The catalog accepts it and its RGBA copy
 * makes every pixel of that color fully transparent: the file passes, but the author should know. Null otherwise.
 *
 * The key has 16 bits a sample, the images here 8. Pillow compares only the key's low byte with a pixel: its convert
 * to RGBA ends in rgbT2rgba (libImaging/Convert.c), which takes `r & 0xff`, `g & 0xff`, `b & 0xff`, and an 8-bit gray
 * image goes the same way with r = g = b. So a key of 0x0100 makes black transparent, as 0x0000 does, although by the
 * PNG standard it matches no 8-bit pixel. The note names the color Pillow matches; catalog-png.test.mjs checks that
 * against the catalog's own re-save.
 */
function transparencyKeyNote(header, chunks) {
  if (header.color !== 0 && header.color !== 2) return null;
  const trns = chunks.find((c) => c.kind === "tRNS");
  if (!trns) return null;
  const key = (header.color === 0 ? [0] : [0, 2, 4]).map((i) => trns.payload.readUInt16BE(i) & 0xff);
  const color = header.color === 0 ? `gray level ${key[0]}` : `#${key.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  return (
    `The file marks ${color} as transparent (a tRNS chunk): the catalog keeps every pixel of that color ` +
    "fully transparent. If that is not meant, save it again without transparency."
  );
}

// ---------------------------------------------------------------- the answer

/**
 * Checks PNG bytes as the catalog checks a screenshot of the "front" or "back" display. Returns one of:
 *
 * - `{ verdict: "fail", id, reason, message }`: the catalog's manifest-stage check `id` rejects the file.
 * - `{ verdict: "unverified", id, reason: "build-unverified", detail, message }`: the file passes the manifest-stage
 *   rules, but it is outside the kind of file whose re-save by the catalog's build is vouched for; `id` is the build
 *   check that may still reject it. This is not "ready".
 * - `{ verdict: "pass" }`: the file passes the manifest-stage rules and is of the kind vouched for at the build
 *   stage. Only this means ready. A grayscale or RGB file with a transparency key gets `{ verdict: "pass", note }`:
 *   the catalog accepts it, and the note says which color its copy makes transparent.
 */
export function checkCatalogPng(bytes, name) {
  const rule = Object.hasOwn(CATALOG_PNG_RULES, name) ? CATALOG_PNG_RULES[name] : Object.hasOwn(CATALOG_ICON_RULES, name) ? CATALOG_ICON_RULES[name] : undefined;
  if (!rule) throw new TypeError(`Unknown display "${name}": use "front" or "back" (or "icon_front", "icon_back" for an app's icons).`);
  if (!(bytes instanceof Uint8Array)) throw new TypeError("The PNG must be a Uint8Array or a Buffer.");
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fix = `Save it as an 8-bit PNG of exactly ${rule.width}×${rule.height} pixels.`;
  let header;
  let chunks;
  let pixels;
  try {
    if (data.length > rule.maxBytes) throw new Broken("too-large");
    if (data.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((b, i) => data[i] === b)) throw new Broken("not-png");
    let idat;
    let seen;
    ({ header, idat, seen, chunks } = readChunks(data, rule));
    if (header.color === 3 && !seen.has("PLTE")) throw new Broken("palette-missing");
    if (header.color === 0 && header.depth < 8 && seen.has("tRNS")) throw new Broken("gray-transparency");
    pixels = inflate(idat);
    checkScanlines(pixels, header, rule);
  } catch (error) {
    if (!(error instanceof Broken)) throw error;
    return { verdict: "fail", id: rule.id, reason: error.reason, message: `The file ${REASONS[error.reason](rule, error.details)}. ${fix}` };
  }
  const detail = buildStage(header, chunks, pixels, rule);
  if (detail === null) {
    const note = transparencyKeyNote(header, chunks);
    return note ? { verdict: "pass", note } : { verdict: "pass" };
  }
  return {
    verdict: "unverified",
    id: rule.finalId,
    reason: "build-unverified",
    detail,
    message:
      `The file passes the catalog's PNG checks, but ${detail}, and the catalog's build may refuse to re-save it ` +
      `(${rule.finalId}). To be sure, save it again as plain 8-bit RGB or grayscale without extra chunks.`,
  };
}
