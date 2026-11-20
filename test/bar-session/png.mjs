// PNG files written byte by byte, of every color type an app may upload: the pictures the BUSY Bar session draws on a BUSY
// Bar (golden.mjs, the scenes of EMU-348) and an app of EMU-347 carries. No library: the emulator's own decoder must not
// be what makes them.
import { deflateSync } from "node:zlib";

const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// Color type → samples a pixel: 0 gray, 2 RGB, 3 palette index, 4 gray and alpha, 6 RGBA.
const SAMPLES = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * A PNG of `width` × `height` with 8-bit samples. `pixel(x, y)` gives the pixel's samples as an array: [gray], [r, g, b],
 * [index], [gray, alpha] or [r, g, b, a] for color type `type`. `palette`: [[r, g, b], ...] for type 3, and `alpha`:
 * the tRNS entries of the palette (type 3) when some are see-through.
 */
export function png({ width, height, type, pixel, palette = null, alpha = null }) {
  const samples = SAMPLES[type];
  if (!samples) throw new Error(`color type ${type}`);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, type, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * samples + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y);
      for (let s = 0; s < samples; s++) raw[y * (width * samples + 1) + 1 + x * samples + s] = value[s];
    }
  }
  const parts = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head)];
  if (type === 3) {
    parts.push(chunk("PLTE", Buffer.from(palette.flat())));
    if (alpha) parts.push(chunk("tRNS", Buffer.from(alpha)));
  }
  parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}
