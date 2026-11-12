// An app's two icons, made from a picture or from one or two letters (busy-emulator icon), so that nobody has to draw
// PNG files by hand: in the field test with a real agent the catalog step ended without an icon.
//
//   appmeta/icon_front_8x8.png    8×8, color with transparency (8-bit RGBA, color type 6): the front display's menu
//                                 and the catalog show it as it is
//   appmeta/icon_back_11x11.png   11×11, gray with transparency (8-bit gray + alpha, color type 4): the back display's
//                                 menu takes only the shape from the alpha channel and paints it in the text's color,
//                                 so an opaque picture would be a solid square there
//
// Both are the formats of the emulator's example apps, and both pass the catalog's icon rules (catalog-png.mjs,
// CATALOG_ICON_RULES; a test checks every icon made here). The files hold IHDR, one IDAT and IEND, nothing else, as
// the screenshots do (png.mjs). Node's standard library only; nothing here reads the clock or the disk.
import { crc32, deflateSync, inflateSync } from "node:zlib";

import { checkIcon, backPixels, defaultIconPixels, frontPixels, ICON_SIDES, MAX_PICTURE_BYTES, MAX_PICTURE_SIDE, resample, withShape } from "./icon-rules.mjs";
import { COMPRESSION_LEVEL, PNG_SIGNATURE } from "./png.mjs";

export const ICONS = ICON_SIDES;
export { MAX_PICTURE_BYTES, MAX_PICTURE_SIDE };

/** A picture that cannot be read, said in words for the author. */
export class PictureError extends Error {}

// ---------------------------------------------------------------- PNG out

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit PNG of `channels` samples a pixel: 4 is RGBA (color type 6), 2 is gray and alpha (color type 4). */
export function encodePng({ width, height, channels, data }) {
  if (channels !== 4 && channels !== 2) throw new TypeError("channels: 4 (RGBA) or 2 (gray and alpha)");
  if (data.length !== width * height * channels) throw new RangeError(`the data is ${data.length} bytes, not ${width}×${height}×${channels}`);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, channels === 4 ? 6 : 4, 0, 0, 0], 8);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height); // filter 0 on every row
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: COMPRESSION_LEVEL })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- PNG in

const SAMPLES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/**
 * Reads a PNG into RGBA, 8 bits a channel: every color type and bit depth of the standard, not interlaced. Throws a
 * PictureError that says what is wrong with the file.
 * @returns {{ width: number, height: number, rgba: Uint8Array }}
 */
export function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("the picture must be a Uint8Array or a Buffer");
  if (bytes.length > MAX_PICTURE_BYTES) throw new PictureError(`it is ${(bytes.length / 1024 / 1024).toFixed(1)} MiB; the most is ${MAX_PICTURE_BYTES / 1024 / 1024} MiB`);
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (file.length < 8 || !file.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE))) throw new PictureError("it is not a PNG file (convert a JPEG, SVG or WebP to PNG first)");
  let header = null;
  let palette = null;
  let transparency = null;
  const data = [];
  for (let at = 8; at + 12 <= file.length; ) {
    const length = file.readUInt32BE(at);
    const type = file.toString("latin1", at + 4, at + 8);
    const payload = file.subarray(at + 8, at + 8 + length);
    if (payload.length !== length) throw new PictureError("it is cut short");
    if (type === "IHDR" && length === 13) header = { width: payload.readUInt32BE(0), height: payload.readUInt32BE(4), depth: payload[8], color: payload[9], interlace: payload[12] };
    else if (type === "PLTE") palette = payload;
    else if (type === "tRNS") transparency = payload;
    else if (type === "IDAT") data.push(payload);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!header) throw new PictureError("it has no header");
  const { width, height, depth, color, interlace } = header;
  if (!DEPTHS[color]?.includes(depth)) throw new PictureError("its color type or bit depth is not one PNG defines");
  if (interlace !== 0) throw new PictureError("it is interlaced; save it without interlacing");
  if (!(width >= 1 && height >= 1 && width <= MAX_PICTURE_SIDE && height <= MAX_PICTURE_SIDE)) throw new PictureError(`it is ${width}×${height}; the most is ${MAX_PICTURE_SIDE}×${MAX_PICTURE_SIDE}`);
  if (color === 3 && !palette) throw new PictureError("it has no palette");
  const samples = SAMPLES[color];
  const pixelBytes = Math.max(1, (samples * depth) / 8);
  const stride = Math.ceil((width * samples * depth) / 8);
  let raw;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height });
  } catch {
    throw new PictureError("its image data does not decompress");
  }
  if (raw.length < (stride + 1) * height) throw new PictureError("its image data is cut short");
  // The filters of each row, undone in place: a sample is predicted from the one to its left, above, and above left.
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const a = x >= pixelBytes ? lines[row + x - pixelBytes] : 0;
      const b = y > 0 ? lines[row - stride + x] : 0;
      const c = x >= pixelBytes && y > 0 ? lines[row - stride + x - pixelBytes] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new PictureError("a row has a filter PNG does not define");
      lines[row + x] = (value + predicted) & 0xff;
    }
  }
  // A sample as it is in the file, and as 8 bits.
  const sample = (y, index) => {
    const row = y * stride;
    if (depth === 8) return lines[row + index];
    if (depth === 16) return lines.readUInt16BE(row + index * 2);
    const bit = index * depth;
    return (lines[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const to8 = (value) => (depth === 16 ? value >> 8 : depth === 8 ? value : Math.round((value * 255) / ((1 << depth) - 1)));
  // tRNS of a gray or RGB picture names one color, in the file's own depth, that is transparent.
  const key = transparency && color === 0 && transparency.length >= 2 ? [transparency.readUInt16BE(0)] : transparency && color === 2 && transparency.length >= 6 ? [0, 2, 4].map((i) => transparency.readUInt16BE(i)) : null;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (color === 3) {
        const index = sample(y, x);
        if (index * 3 + 2 >= palette.length) throw new PictureError("a pixel uses a color outside the palette");
        rgba.set([palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], transparency && index < transparency.length ? transparency[index] : 255], out);
      } else if (color === 0 || color === 4) {
        const gray = sample(y, x * samples);
        const alpha = color === 4 ? to8(sample(y, x * 2 + 1)) : key && gray === key[0] ? 0 : 255;
        rgba.set([to8(gray), to8(gray), to8(gray), alpha], out);
      } else {
        const colors = [0, 1, 2].map((i) => sample(y, x * samples + i));
        const alpha = color === 6 ? to8(sample(y, x * 4 + 3)) : key && colors.every((value, i) => value === key[i]) ? 0 : 255;
        rgba.set([...colors.map(to8), alpha], out);
      }
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- a picture to an icon

// The conversion itself is icon-rules.mjs's, shared with the window, which shows its result before it is saved.
export { resample, withShape };

/** Both icons from a PNG file's bytes. Throws PictureError. */
export function iconsFromPicture(bytes) {
  const picture = decodePng(bytes);
  return {
    front: encodePng({ width: ICONS.front.size, height: ICONS.front.size, channels: 4, data: frontPixels(picture) }),
    back: encodePng({ width: ICONS.back.size, height: ICONS.back.size, channels: 2, data: backPixels(picture) }),
    source: { width: picture.width, height: picture.height },
  };
}

/**
 * The back icon alone from a picture (`icon --back`, `create --back-icon`, the window's uploads): one drawn at 11×11 is
 * taken pixel for pixel, another size is scaled (backPixels); its transparency is the shape, or, for an opaque
 * picture, what differs from its corners. Throws PictureError.
 */
export function backFromPicture(bytes) {
  const picture = decodePng(bytes);
  return encodePng({ width: ICONS.back.size, height: ICONS.back.size, channels: 2, data: backPixels(picture) });
}

/**
 * A picture checked against the icon's requirements (icon-rules.mjs, checkIcon), decoded here when it can be: the
 * same answer the window's icon block gives for an upload.
 */
export function checkPicture(bytes, side) {
  let pixels = null;
  try {
    if (bytes.length <= MAX_PICTURE_BYTES) {
      const picture = decodePng(bytes);
      pixels = { width: picture.width, height: picture.height, rgba: picture.rgba };
    }
  } catch {
    // Not one the conversion reads: checkIcon says what is wrong, and offers no conversion.
  }
  return checkIcon(side, { bytes, pixels });
}

/** The default icon (icon-rules.mjs, DEFAULT_ICON) as the two PNG files. */
export function defaultIcons() {
  const { front, back } = defaultIconPixels();
  return { front: encodePng({ width: 8, height: 8, channels: 4, data: front }), back: encodePng({ width: 11, height: 11, channels: 2, data: back }) };
}

// ---------------------------------------------------------------- letters to an icon

// Capital letters and digits, 3 pixels wide and 5 high: five rows of three bits, the left pixel the high bit.
const GLYPHS = Object.freeze({
  A: "010 101 111 101 101", B: "110 101 110 101 110", C: "011 100 100 100 011", D: "110 101 101 101 110", E: "111 100 110 100 111",
  F: "111 100 110 100 100", G: "011 100 101 101 011", H: "101 101 111 101 101", I: "111 010 010 010 111", J: "001 001 001 101 010",
  K: "101 101 110 101 101", L: "100 100 100 100 111", M: "101 111 111 101 101", N: "110 101 101 101 101", O: "010 101 101 101 010",
  P: "110 101 110 100 100", Q: "010 101 101 110 011", R: "110 101 110 101 101", S: "011 100 010 001 110", T: "111 010 010 010 010",
  U: "101 101 101 101 111", V: "101 101 101 101 010", W: "101 101 111 111 101", X: "101 101 010 101 101", Y: "101 101 010 010 010",
  Z: "111 001 010 100 111", 0: "111 101 101 101 111", 1: "010 110 010 010 111", 2: "110 001 010 100 111", 3: "110 001 010 001 110",
  4: "101 101 111 001 001", 5: "111 100 110 001 110", 6: "011 100 111 101 111", 7: "111 001 010 010 010", 8: "111 101 111 101 111",
  9: "111 101 111 001 110",
});

/** What --text takes: one or two letters or digits. Returns them in capitals, or null. */
export function iconText(text) {
  const letters = String(text ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{1,2}$/.test(letters) ? letters : null;
}

/** "#RRGGBB" as [r, g, b], or null. */
export function iconColor(text) {
  const hex = /^#?([0-9a-f]{6})$/i.exec(String(text ?? ""))?.[1];
  return hex ? [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null;
}

/** The pixels of the letters, 5 rows of 3 (one letter) or 7 (two, a column between them): rows of booleans. */
function letterRows(letters) {
  const glyphs = [...letters].map((letter) => GLYPHS[letter].split(" "));
  return [0, 1, 2, 3, 4].map((y) => [...glyphs.map((glyph) => glyph[y]).join("0")].map((bit) => bit === "1"));
}

/**
 * Both icons from one or two letters or digits (iconText). Front: the letters in `color` with a line under them, on
 * nothing. Back: a tile with rounded corners and the letters cut out of it, since the bar's menu paints the shape in
 * one color.
 */
export function iconsFromText(letters, color = [255, 255, 255]) {
  const rows = letterRows(letters);
  const width = rows[0].length;
  const front = new Uint8Array(8 * 8 * 4);
  const frontLeft = Math.ceil((8 - width) / 2);
  const put = (x, y) => front.set([...color, 255], (y * 8 + x) * 4);
  rows.forEach((row, y) => row.forEach((on, x) => on && put(frontLeft + x, y + 1)));
  for (let x = 0; x < width; x++) put(frontLeft + x, 7);
  const back = new Uint8Array(11 * 11 * 2);
  const backLeft = Math.floor((11 - width) / 2);
  for (let y = 0; y < 11; y++) {
    for (let x = 0; x < 11; x++) {
      const corner = (x === 0 || x === 10) && (y === 0 || y === 10);
      const letter = y >= 3 && y < 8 && x >= backLeft && x < backLeft + width && rows[y - 3][x - backLeft];
      back.set([255, corner || letter ? 0 : 255], (y * 11 + x) * 2);
    }
  }
  return {
    front: encodePng({ width: 8, height: 8, channels: 4, data: front }),
    back: encodePng({ width: 11, height: 11, channels: 2, data: back }),
  };
}

/** A picture as lines of text, for a test and for a look without a viewer: "#" opaque, "+" half, "." clear. */
export function asText(bytes) {
  const { width, height, rgba } = decodePng(bytes);
  return Array.from({ length: height }, (_, y) => Array.from({ length: width }, (_, x) => (rgba[(y * width + x) * 4 + 3] > 191 ? "#" : rgba[(y * width + x) * 4 + 3] > 63 ? "+" : ".")).join("")).join("\n");
}
