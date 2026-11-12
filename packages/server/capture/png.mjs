// PNG files of the bar's two displays at their own size, for the catalog's screenshots (ADR-0006, "Output for the
// catalog"). The input is a frame exactly as the core holds it and GET /api/screen sends it (after base64):
//
//   front  72×16, three bytes a pixel in the order B, G, R, rows top to bottom
//   back   160×80, 4-bit gray, two pixels a byte, the left pixel in the low nibble, rows top to bottom
//
// The front display becomes an 8-bit RGB PNG (color type 2). The back display becomes an 8-bit grayscale PNG
// (color type 0): the OLED has one channel, and level n of 0..15 is written as n × 17, the mapping the bar's own
// local web uses to show this frame. The file holds IHDR, one IDAT and IEND, nothing else: no time, no software name,
// no color profile. Every row uses filter 0 and the data is deflated by Node's zlib at level 9, so the same frame
// always gives the same bytes with the same Node. Nothing here reads the clock, the disk or the environment.
//
// README.md next to this file says how the result meets the catalog's rules.
import { crc32, deflateSync } from "node:zlib";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** The two displays: the `display` number GET /api/screen takes, the size, the frame's length and the PNG's format. */
export const SCREENS = Object.freeze({
  front: Object.freeze({ display: 0, width: 72, height: 16, frameBytes: 72 * 16 * 3, colorType: 2, channels: 3 }),
  back: Object.freeze({ display: 1, width: 160, height: 80, frameBytes: (160 * 80) / 2, colorType: 0, channels: 1 }),
});

/** zlib level for IDAT. The images are a few KiB of raw data; see README.md for why the level does not matter. */
export const COMPRESSION_LEVEL = 9;

function screenOf(name) {
  const screen = Object.hasOwn(SCREENS, name) ? SCREENS[name] : undefined;
  if (!screen) throw new TypeError(`Unknown display "${name}": use "front" or "back".`);
  return screen;
}

function checkFrame(screen, name, frame) {
  if (!(frame instanceof Uint8Array)) throw new TypeError(`The ${name} frame must be a Uint8Array or a Buffer.`);
  if (frame.length !== screen.frameBytes) {
    throw new RangeError(
      `The ${name} frame is ${frame.length} bytes, expected ${screen.frameBytes} (${screen.width}×${screen.height}).`,
    );
  }
}

/**
 * The PNG's raw image data before compression: each row is a filter byte (0) and the row's samples, R, G, B for the
 * front display and one gray byte for the back.
 */
export function scanlines(name, frame) {
  const screen = screenOf(name);
  checkFrame(screen, name, frame);
  const { width, height, channels } = screen;
  const stride = width * channels + 1;
  const raw = new Uint8Array(stride * height); // filter bytes stay 0
  if (name === "front") {
    for (let y = 0; y < height; y++) {
      let out = y * stride + 1;
      let at = y * width * 3;
      for (let x = 0; x < width; x++, at += 3) {
        raw[out++] = frame[at + 2];
        raw[out++] = frame[at + 1];
        raw[out++] = frame[at];
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const out = y * stride + 1;
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        raw[out + x] = ((frame[i >> 1] >> ((i & 1) * 4)) & 0x0f) * 17;
      }
    }
  }
  return raw;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(screen, width, height, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, screen.colorType, 0, 0, 0], 8); // 8 bits, color type, deflate, adaptive filtering, no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: COMPRESSION_LEVEL })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG bytes of a frame of the "front" or "back" display, at the display's own size. */
export function encodeScreenPng(name, frame) {
  const screen = screenOf(name);
  return png(screen, screen.width, screen.height, scanlines(name, frame));
}

/** The largest enlargement: the back display at 32 times is 5120×2560, 13 MB of image data before compression. */
export const MAX_SCALE = 32;

/**
 * PNG bytes of the same frame enlarged `scale` times (a whole number from 2 to MAX_SCALE): every pixel becomes a square
 * of scale × scale pixels of its color, nothing in between or blended, in the same format as encodeScreenPng gives.
 * For people and for models that read pictures; the catalog takes only the display's own size.
 */
export function encodeScaledScreenPng(name, frame, scale) {
  const screen = screenOf(name);
  if (!Number.isInteger(scale) || scale < 2 || scale > MAX_SCALE) throw new RangeError(`The scale must be a whole number from 2 to ${MAX_SCALE}, not ${scale}.`);
  const small = scanlines(name, frame);
  const { width, height, channels } = screen;
  const stride = width * channels + 1;
  const wide = width * scale * channels + 1;
  const raw = new Uint8Array(wide * height * scale); // filter bytes stay 0
  for (let y = 0; y < height; y++) {
    const first = y * scale * wide;
    let out = first + 1;
    for (let x = 0; x < width; x++) {
      const at = y * stride + 1 + x * channels;
      for (let k = 0; k < scale; k++) for (let c = 0; c < channels; c++) raw[out++] = small[at + c];
    }
    for (let k = 1; k < scale; k++) raw.copyWithin(first + k * wide, first, first + wide);
  }
  return png(screen, width * scale, height * scale, raw);
}
