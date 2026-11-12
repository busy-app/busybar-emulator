// An animated GIF (GIF89a) from RGB frames, for places that take no video. The emulator's own encoder, Node's standard
// library only: frames that repeat the one before are merged into its delay, a frame of 256 colors or fewer keeps
// every color exactly (the LED dots of led-raster.mjs have few), one of more loses low bits of each channel until it
// fits. One palette for the whole file when all frames together fit in 256 colors, a palette per frame otherwise.
// The file loops for ever.
import { BACKGROUND, DARK_LED, FRONT, LED, ledMask } from "./led-raster.mjs";

/**
 * @param {Uint8Array[]} frames  RGB, width × height × 3 each
 * @param {{ width: number, height: number, fps: number }} o
 * @returns {Buffer}
 */
export function encodeGif(frames, { width, height, fps }) {
  if (!frames.length) throw new RangeError("a GIF needs at least one frame");
  // Runs of equal frames become one frame with a longer delay. Delays are in hundredths of a second, so each run ends
  // at the hundredth nearest its true end: the file keeps time with the clip.
  const runs = [];
  for (let i = 0; i < frames.length; i++) {
    if (i > 0 && equal(frames[i], frames[i - 1])) runs.at(-1).end = i + 1;
    else runs.push({ frame: frames[i], start: i, end: i + 1 });
  }
  const at = (n) => Math.round((n * 100) / fps);
  const images = runs.map((run) => ({ ...indexed(run.frame), delay: Math.max(1, at(run.end) - at(run.start)) }));

  const all = new Map();
  for (const image of images) for (const color of image.palette) all.set(color, true);
  const global = all.size <= 256 ? [...all.keys()] : null;

  const out = [];
  const bytes = (...values) => out.push(Buffer.from(values));
  const word = (n) => [n & 0xff, (n >> 8) & 0xff];
  out.push(Buffer.from("GIF89a", "latin1"));
  const globalBits = global ? tableBits(global.length) : 0;
  bytes(...word(width), ...word(height), global ? 0x80 | ((globalBits - 1) << 4) | (globalBits - 1) : 0, 0, 0);
  if (global) out.push(table(global, globalBits));
  // NETSCAPE2.0: loop for ever.
  bytes(0x21, 0xff, 0x0b);
  out.push(Buffer.from("NETSCAPE2.0", "latin1"));
  bytes(0x03, 0x01, 0, 0, 0x00);

  for (const image of images) {
    let palette = image.palette;
    let pixels = image.pixels;
    if (global) {
      const where = new Map(global.map((color, i) => [color, i]));
      pixels = pixels.map((i) => where.get(palette[i]));
      palette = global;
    }
    // Graphic control: no transparency, the frame stays until the next (disposal 1), its delay.
    bytes(0x21, 0xf9, 0x04, 0x04, ...word(image.delay), 0, 0x00);
    const bits = tableBits(palette.length);
    bytes(0x2c, 0, 0, 0, 0, ...word(width), ...word(height), global ? 0 : 0x80 | (bits - 1));
    if (!global) out.push(table(palette, bits));
    const minCode = Math.max(2, bits);
    bytes(minCode);
    const data = lzw(pixels, minCode);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.subarray(i, i + 255);
      bytes(block.length);
      out.push(Buffer.from(block));
    }
    bytes(0x00);
  }
  bytes(0x3b);
  return Buffer.concat(out);
}

/**
 * A GIF of the front display as LED dots (led-raster.mjs), made straight from the bar's own frames: no frame is drawn
 * in RGB. A dot is a LED's color or the background, so a frame is indexed once at the size of the display (72×16)
 * and its indices are spread over the dots; each distinct frame is compressed once, however often the clip shows it,
 * and the steps that repeat the one before only lengthen its delay. What it holds at a time is one frame of indices
 * (width × height bytes) and the compressed frames: a take of a still screen costs one frame, whatever its length.
 * The picture is the one encodeGif(steps.map((i) => renderFront(fronts[i], scale))) gives.
 * @param {Uint8Array[]} fronts  the distinct front frames: B, G, R bytes, 72×16, as GET /api/screen sends them
 * @param {number[]} steps       for each step of the clip, the index in `fronts` of the frame it shows
 * @param {{ scale: number, fps: number }} o
 * @returns {Buffer}
 */
export function encodeFrontGif(fronts, steps, { scale, fps }) {
  if (!steps.length) throw new RangeError("a GIF needs at least one frame");
  const width = FRONT.width * scale;
  const height = FRONT.height * scale;
  const runs = [];
  for (let i = 0; i < steps.length; i++) {
    if (i > 0 && steps[i] === steps[i - 1]) runs.at(-1).end = i + 1;
    else runs.push({ front: steps[i], start: i, end: i + 1 });
  }
  const at = (n) => Math.round((n * 100) / fps);

  // Each LED's color as 0xRRGGBB, as renderFront draws it; the background is in a frame where the LEDs leave gaps.
  const mask = ledMask(scale);
  const gaps = mask.includes(0);
  const background = (BACKGROUND[0] << 16) | (BACKGROUND[1] << 8) | BACKGROUND[2];
  const dark = (DARK_LED[0] << 16) | (DARK_LED[1] << 8) | DARK_LED[2];
  const used = [...new Set(steps)];
  const leds = new Map(
    used.map((f) => {
      const frame = fronts[f];
      const colors = new Uint32Array(FRONT.width * FRONT.height);
      for (let p = 0, i = 0; p < colors.length; p++, i += 3) {
        const b = frame[i], g = frame[i + 1], r = frame[i + 2];
        colors[p] = r + g + b < LED.darkThreshold ? dark : (r << 16) | (g << 8) | b;
      }
      return [f, colors];
    }),
  );
  const all = new Set(gaps ? [background] : []);
  for (const colors of leds.values()) for (const color of colors) all.add(color);
  const global = all.size <= 256 ? [...all] : null;

  /** A frame's palette and LED indices: the global palette, or its own, low bits dropped until it fits (indexed()). */
  const paletteOf = (colors) => {
    for (let drop = 0; drop <= 7; drop++) {
      const keep = ((0xff << drop) & 0xff) * 0x010101;
      const where = new Map();
      const palette = [];
      const index = new Uint8Array(colors.length);
      let fits = true;
      for (const [p, color] of [...(gaps ? [[-1, background]] : []), ...colors.entries()]) {
        const c = color & keep;
        let i = where.get(c);
        if (i === undefined) {
          if (palette.length === 256) {
            fits = false;
            break;
          }
          i = palette.length;
          where.set(c, i);
          palette.push(c);
        }
        if (p >= 0) index[p] = i;
      }
      if (fits) return { palette, index, background: where.get(background & keep) ?? 0 };
    }
    throw new Error("unreachable: one bit a channel always fits");
  };
  const globalWhere = global ? new Map(global.map((color, i) => [color, i])) : null;

  const pixels = new Uint8Array(width * height);
  const compressed = new Map();
  const encode = (f) => {
    const colors = leds.get(f);
    let palette;
    let index;
    let back;
    if (global) {
      palette = global;
      index = Uint8Array.from(colors, (color) => globalWhere.get(color));
      back = globalWhere.get(background) ?? 0;
    } else ({ palette, index, background: back } = paletteOf(colors));
    for (let ly = 0; ly < FRONT.height; ly++) {
      for (let y = 0; y < scale; y++) {
        let o = (ly * scale + y) * width;
        for (let lx = 0; lx < FRONT.width; lx++) {
          const led = index[ly * FRONT.width + lx];
          for (let x = 0; x < scale; x++) pixels[o++] = mask[y * scale + x] ? led : back;
        }
      }
    }
    const bits = tableBits(palette.length);
    const minCode = Math.max(2, bits);
    return { palette, bits, minCode, data: lzw(pixels, minCode) };
  };

  const out = [];
  const bytes = (...values) => out.push(Buffer.from(values));
  const word = (n) => [n & 0xff, (n >> 8) & 0xff];
  out.push(Buffer.from("GIF89a", "latin1"));
  const globalBits = global ? tableBits(global.length) : 0;
  bytes(...word(width), ...word(height), global ? 0x80 | ((globalBits - 1) << 4) | (globalBits - 1) : 0, 0, 0);
  if (global) out.push(table(global, globalBits));
  bytes(0x21, 0xff, 0x0b);
  out.push(Buffer.from("NETSCAPE2.0", "latin1"));
  bytes(0x03, 0x01, 0, 0, 0x00);
  for (const run of runs) {
    if (!compressed.has(run.front)) compressed.set(run.front, encode(run.front));
    const image = compressed.get(run.front);
    bytes(0x21, 0xf9, 0x04, 0x04, ...word(Math.max(1, at(run.end) - at(run.start))), 0, 0x00);
    bytes(0x2c, 0, 0, 0, 0, ...word(width), ...word(height), global ? 0 : 0x80 | (image.bits - 1));
    if (!global) out.push(table(image.palette, image.bits));
    bytes(image.minCode);
    for (let i = 0; i < image.data.length; i += 255) {
      const block = image.data.subarray(i, i + 255);
      bytes(block.length);
      out.push(Buffer.from(block));
    }
    bytes(0x00);
  }
  bytes(0x3b);
  return Buffer.concat(out);
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The frame as indices into a palette of at most 256 colors (0xRRGGBB numbers). */
function indexed(rgb) {
  for (let drop = 0; drop <= 7; drop++) {
    const keep = (0xff << drop) & 0xff;
    const where = new Map();
    const palette = [];
    const pixels = new Uint8Array(rgb.length / 3);
    let fits = true;
    for (let p = 0, i = 0; i < rgb.length; i += 3, p++) {
      const color = ((rgb[i] & keep) << 16) | ((rgb[i + 1] & keep) << 8) | (rgb[i + 2] & keep);
      let index = where.get(color);
      if (index === undefined) {
        if (palette.length === 256) {
          fits = false;
          break;
        }
        index = palette.length;
        where.set(color, index);
        palette.push(color);
      }
      pixels[p] = index;
    }
    if (fits) return { palette, pixels };
  }
  throw new Error("unreachable: one bit a channel always fits");
}

/** Bits of a color table that holds n colors: 1 to 8. */
function tableBits(n) {
  let bits = 1;
  while (1 << bits < n) bits++;
  return bits;
}

function table(palette, bits) {
  const out = Buffer.alloc(3 * (1 << bits));
  palette.forEach((color, i) => {
    out[i * 3] = color >> 16;
    out[i * 3 + 1] = (color >> 8) & 0xff;
    out[i * 3 + 2] = color & 0xff;
  });
  return out;
}

/**
 * GIF's variable-length LZW, codes packed from the lowest bit. The dictionary is a table indexed by prefix and pixel
 * (no code in it is 0: the first one made is end + 1), emptied at each clear code; the packing is written out where
 * a code is emitted, without a closure over the counters, which V8 kept as heap numbers. A frame of a large GIF has
 * near a million pixels: with a Map and a closure it took 150 ms, this way 10.
 */
function lzw(pixels, minCode) {
  const clear = 1 << minCode;
  const end = clear + 1;
  // A code is at most 12 bits for each pixel, and three more codes: the clear codes are fewer than the pixels.
  const out = new Uint8Array(pixels.length * 2 + 16);
  let length = 0;
  let buffer = 0;
  let filled = 0;
  let size = minCode + 1;
  const dictionary = new Uint16Array(4096 * 256);
  let next = end + 1;
  buffer |= clear << filled;
  filled += size;
  while (filled >= 8) {
    out[length++] = buffer & 0xff;
    buffer >>>= 8;
    filled -= 8;
  }
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const pixel = pixels[i];
    const key = (prefix << 8) | pixel;
    const known = dictionary[key];
    if (known !== 0) {
      prefix = known;
      continue;
    }
    buffer |= prefix << filled;
    filled += size;
    while (filled >= 8) {
      out[length++] = buffer & 0xff;
      buffer >>>= 8;
      filled -= 8;
    }
    if (next < 4096) {
      dictionary[key] = next++;
      if (next - 1 === 1 << size && size < 12) size++;
    } else {
      buffer |= clear << filled;
      filled += size;
      while (filled >= 8) {
        out[length++] = buffer & 0xff;
        buffer >>>= 8;
        filled -= 8;
      }
      dictionary.fill(0);
      next = end + 1;
      size = minCode + 1;
    }
    prefix = pixel;
  }
  for (const code of [prefix, end]) {
    buffer |= code << filled;
    filled += size;
    while (filled >= 8) {
      out[length++] = buffer & 0xff;
      buffer >>>= 8;
      filled -= 8;
    }
  }
  if (filled > 0) out[length++] = buffer & 0xff;
  return out.slice(0, length);
}
