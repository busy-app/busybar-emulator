// What an app's two icons must be, checked the same way by the command line (create --icon, icon) and by the window's
// icon block (Application Info, Create app), and the conversion that makes a picture into them. No import, no file,
// no clock: the server serves this file to the window as it is (device-window.mjs), and capture/icon.mjs builds the
// PNG files on it.
//
// Where the rules come from:
//   - the firmware (busybar-firmware, documentation/JavaScript Applications.dox.md, "appmeta directory"):
//     icon_front_8x8.png must be an 8×8 PNG color image, icon_back_11x11.png an 11×11 PNG gray image; without one the BUSY Bar shows a default icon. The back display's menu takes only the shape, from the
//     alpha channel, and paints it itself: an opaque back icon is a solid square there (checked on the bar, 10.11).
//   - the catalog (busy-apps-catalog-dev, tools/check_png.py ICON_FRONT and ICON_BACK, tools/pipeline_build.py): a
//     valid PNG of exactly 8×8 and 11×11, not 16 bits a channel, at most 64 KiB; the build re-saves both.
//   - busy-cli build copies appmeta/ as it is: it checks nothing of the icons.
// The window's upload decodes the picture itself (a canvas) and sends what it shows, re-encoded; the command line's
// icon command re-encodes it again (capture/icon.mjs): the files written are always plain 8-bit PNGs, RGBA for the
// front and gray with alpha for the back, whatever the upload was (interlaced, a palette, 16 bits).

export const ICON_SIDES = Object.freeze({
  front: Object.freeze({ size: 8, file: "icon_front_8x8.png", kind: "icon_front", maxBytes: 64 * 1024 }),
  back: Object.freeze({ size: 11, file: "icon_back_11x11.png", kind: "icon_back", maxBytes: 64 * 1024 }),
});

/** The largest picture the conversion reads: its bytes, and its side in pixels. */
export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
export const MAX_PICTURE_SIDE = 4096;

/** The requirements, as the icon block lists them: an id and a short line each. */
export const REQUIREMENTS = Object.freeze({
  front: Object.freeze([
    Object.freeze({ id: "png", text: "A PNG file" }),
    Object.freeze({ id: "size", text: "8×8 pixels" }),
    Object.freeze({ id: "color", text: "In color, 8 bits a channel; transparent pixels stay dark" }),
    Object.freeze({ id: "bytes", text: "64 KiB at most" }),
  ]),
  back: Object.freeze([
    Object.freeze({ id: "png", text: "A PNG file" }),
    Object.freeze({ id: "size", text: "11×11 pixels" }),
    Object.freeze({ id: "color", text: "Gray with transparency: the BUSY Bar lights the opaque pixels in its own color" }),
    Object.freeze({ id: "bytes", text: "64 KiB at most" }),
  ]),
});

/** What happens without a back icon, said under the back's list. */
export const BACK_FROM_FRONT = "Without one, it is made from the front: the front's shape, scaled to 11×11.";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The PNG's header and whether it has a tRNS chunk, read from its bytes without decompressing anything; null when it
 * is no PNG (no signature, or no IHDR first).
 * @param {Uint8Array} bytes
 */
export function readPngHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (view.getUint32(8) !== 13 || type(12) !== "IHDR") return null;
  const header = { width: view.getUint32(16), height: view.getUint32(20), depth: bytes[24], color: bytes[25], interlace: bytes[28], transparency: false };
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at);
    const kind = type(at + 4);
    if (kind === "tRNS") header.transparency = true;
    if (kind === "IEND" || kind === "IDAT") break;
    at += 12 + length;
  }
  return header;
}

/** Color types with an alpha channel (gray and alpha, RGBA); 0 gray, 2 RGB, 3 palette have one only with tRNS. */
const ALPHA_TYPES = new Set([4, 6]);
const COLOR_TYPES = new Set([2, 3, 6]);

/** What the pixels hold: whether any is see-through, whether all are, whether any has a color that is not gray. */
function pixelFacts({ width, height, rgba }) {
  let clear = 0;
  let seeThrough = false;
  let colored = false;
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 255) seeThrough = true;
    if (a === 0) clear++;
    else if (rgba[i * 4] !== rgba[i * 4 + 1] || rgba[i * 4 + 1] !== rgba[i * 4 + 2]) colored = true;
  }
  return { seeThrough, blank: clear === width * height, colored };
}

const kib = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`);

/**
 * Checks a picture against the icon's requirements.
 * @param {"front"|"back"} side
 * @param {{ bytes: Uint8Array, pixels?: { width: number, height: number, rgba: Uint8Array }|null }} picture
 *   `pixels`: the picture decoded (8-bit RGBA), when it could be; without them the checks of the pixels are left out.
 * @returns {{ ok: boolean, results: Record<string, { ok: boolean, problem?: string, next?: string }>, fix: { label: string }|null }}
 *   `results` by requirement id; `fix` is the conversion that makes a valid icon of it (convertIcon), when there is one.
 */
export function checkIcon(side, { bytes, pixels = null }) {
  const rule = ICON_SIDES[side];
  if (!rule) throw new TypeError(`side: "front" or "back", not ${JSON.stringify(side)}`);
  const n = rule.size;
  const results = Object.fromEntries(REQUIREMENTS[side].map(({ id }) => [id, { ok: true }]));
  const header = readPngHeader(bytes);
  // Decoded, a picture can be converted, unless it is too large to read.
  const readable = Boolean(pixels) && bytes.length <= MAX_PICTURE_BYTES && pixels.width <= MAX_PICTURE_SIDE && pixels.height <= MAX_PICTURE_SIDE;
  const fixes = [];
  if (!header) {
    results.png = { ok: false, problem: "It is not a PNG file.", next: "Save it as a PNG and upload it again." };
    return { ok: false, results, fix: null };
  }
  if (header.width !== n || header.height !== n) {
    results.size = { ok: false, problem: `It is ${header.width}×${header.height} pixels.`, next: readable ? `Scale it to ${n}×${n}, or draw it at ${n}×${n}.` : `Draw it at ${n}×${n} pixels.` };
    fixes.push(`Scale to ${n}×${n}`);
  }
  if (header.depth === 16) {
    results.color = { ok: false, problem: "It has 16 bits a channel; the catalog takes 8.", next: "Convert it to 8 bits, or save it again with 8 bits a channel." };
    fixes.push("Convert to 8 bits");
  }
  const facts = pixels ? pixelFacts(pixels) : null;
  if (side === "back" && results.color.ok) {
    const hasAlpha = ALPHA_TYPES.has(header.color) || header.transparency;
    if (facts?.blank) {
      results.color = { ok: false, problem: "Every pixel is transparent: there is nothing to show.", next: "Draw the shape in opaque pixels and upload it again." };
    } else if (!hasAlpha || (facts && !facts.seeThrough)) {
      results.color = { ok: false, problem: "It has no transparent pixels: the BUSY Bar would show a solid square.", next: "Take the shape from what differs from its corners, or save it with a transparent background." };
      fixes.push("Take the shape from it");
    } else if (facts ? facts.colored : COLOR_TYPES.has(header.color)) {
      results.color = { ok: false, problem: "It is in color: the BUSY Bar keeps only its shape.", next: "Make it gray with transparency." };
      fixes.push("Make it gray");
    }
  }
  if (bytes.length > rule.maxBytes) {
    results.bytes = { ok: false, problem: `It is ${kib(bytes.length)}.`, next: "Save it again without extra data, or let the emulator save it." };
    fixes.push("Save it smaller");
  }
  const ok = Object.values(results).every((r) => r.ok);
  // One conversion fixes all of it, when the picture could be read and has something to show.
  const fixable = !ok && readable && !(facts?.blank && side === "back");
  return { ok, results, fix: fixable ? { label: fixes.length === 1 ? fixes[0] : `Convert to ${n}×${n}${side === "back" ? ", gray with transparency" : ""}` } : null };
}

// ---------------------------------------------------------------- the conversion

/**
 * The picture as `size`×`size` RGBA: the whole of it, its proportions kept, in the middle, the rest transparent. A
 * larger picture is averaged area by area (with the colors weighted by their opacity); a smaller one is enlarged
 * pixel by pixel.
 */
export function resample({ width, height, rgba }, size) {
  const scale = size / Math.max(width, height);
  const w = Math.max(1, Math.min(size, Math.round(width * scale)));
  const h = Math.max(1, Math.min(size, Math.round(height * scale)));
  const left = Math.floor((size - w) / 2);
  const top = Math.floor((size - h) / 2);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * width + sx) * 4;
          const alpha = rgba[at + 3];
          r += rgba[at] * alpha;
          g += rgba[at + 1] * alpha;
          b += rgba[at + 2] * alpha;
          a += alpha;
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const at = ((top + y) * size + left + x) * 4;
      if (a > 0) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / count)], at);
    }
  }
  return out;
}

/**
 * The picture with its shape in the alpha channel, for the back icon. A picture with transparency has its shape
 * already. An opaque one has none of its own, so the color of its corners is taken for the background and a pixel is
 * as opaque as it is far from that color, the farthest fully.
 */
export function withShape({ width, height, rgba }) {
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) if (rgba[i * 4 + 3] !== 255) return { width, height, rgba };
  const corners = [0, width - 1, pixels - width, pixels - 1];
  const background = [0, 1, 2].map((c) => Math.round(corners.reduce((sum, i) => sum + rgba[i * 4 + c], 0) / corners.length));
  const far = new Uint8Array(pixels);
  let most = 1;
  for (let i = 0; i < pixels; i++) {
    far[i] = Math.max(Math.abs(rgba[i * 4] - background[0]), Math.abs(rgba[i * 4 + 1] - background[1]), Math.abs(rgba[i * 4 + 2] - background[2]));
    if (far[i] > most) most = far[i];
  }
  const out = new Uint8Array(rgba);
  for (let i = 0; i < pixels; i++) out[i * 4 + 3] = Math.round((far[i] * 255) / most);
  return { width, height, rgba: out };
}

/** The front icon from a decoded picture of any size: 8×8 RGBA. */
export function frontPixels(picture) {
  return resample(picture, ICON_SIDES.front.size);
}

/**
 * The back icon from a decoded picture: 11×11, gray and alpha (two bytes a pixel, the gray always white). Its shape is
 * its transparency, or, for an opaque picture, what differs from its corners (withShape). A picture of another size
 * is scaled, and then thin lines that averaged down to a faint shape are made opaque in proportion, the strongest
 * pixel fully; one drawn at 11×11 is taken pixel for pixel.
 */
export function backPixels(picture) {
  const size = ICON_SIDES.back.size;
  const shaped = withShape(picture);
  const exact = picture.width === size && picture.height === size;
  const shape = exact ? shaped.rgba : resample(shaped, size);
  let most = 255;
  if (!exact) {
    most = 0;
    for (let i = 0; i < size * size; i++) most = Math.max(most, shape[i * 4 + 3]);
  }
  const out = new Uint8Array(size * size * 2);
  for (let i = 0; i < size * size; i++) out.set([255, most ? Math.round((shape[i * 4 + 3] * 255) / most) : 0], i * 2);
  return out;
}

/** Gray and alpha, two bytes a pixel, as RGBA (to draw it, or to check it). */
export function grayToRgba(gray) {
  const out = new Uint8Array((gray.length / 2) * 4);
  for (let i = 0; i < gray.length / 2; i++) out.set([gray[i * 2], gray[i * 2], gray[i * 2], gray[i * 2 + 1]], i * 4);
  return out;
}

// ---------------------------------------------------------------- the default icon

// The icon an app gets when nobody gave it one (create without --icon, Create app without an upload): BUSY's "apps"
// symbol (bi-apps, four rounded squares in outline), drawn at the two sizes, in a neutral gray on the front. "#" is a
// pixel, "." none.
export const DEFAULT_ICON = Object.freeze({
  color: Object.freeze([163, 163, 163]),
  front: Object.freeze(["###..###", "#.#..#.#", "###..###", "........", "........", "###..###", "#.#..#.#", "###..###"]),
  back: Object.freeze([".###...###.", "#...#.#...#", "#...#.#...#", "#...#.#...#", ".###...###.", "...........", ".###...###.", "#...#.#...#", "#...#.#...#", "#...#.#...#", ".###...###."]),
});

/** The default icon's pixels: front 8×8 RGBA, back 11×11 gray and alpha. */
export function defaultIconPixels() {
  const front = new Uint8Array(8 * 8 * 4);
  DEFAULT_ICON.front.forEach((row, y) => [...row].forEach((p, x) => p === "#" && front.set([...DEFAULT_ICON.color, 255], (y * 8 + x) * 4)));
  const back = new Uint8Array(11 * 11 * 2);
  DEFAULT_ICON.back.forEach((row, y) => [...row].forEach((p, x) => back.set([255, p === "#" ? 255 : 0], (y * 11 + x) * 2)));
  return { front, back };
}
