// Screenshots the author made before, brought into the project (busy-emulator publish screenshots --upload, and the
// window's Upload… in the Screenshots step). A picture is a front screenshot when it is 72×16 and a back one when it is
// 160×80, or a whole-number enlargement of either (the @8x copies the emulator and the bar's tools save) when every
// enlarged pixel is one color: it is then made small again exactly, pixel for pixel. Anything else is refused with
// the reason. What is kept is written the way the emulator writes a screenshot it takes (capture/png.mjs): the
// display's own size, which the catalog reads, and an 8× copy for the README.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { decodePng, MAX_PICTURE_BYTES, PictureError } from "../capture/icon.mjs";
import { encodeScaledScreenPng, encodeScreenPng, SCREENS } from "../capture/png.mjs";

/** The enlargement of the README's copy, as for a screenshot taken from the bar. */
export const README_SCALE = 8;

/**
 * Which display a picture of `width`×`height` is of, and how many times it is enlarged: { display, scale }, or null.
 */
export function displayOf(width, height) {
  for (const [display, screen] of Object.entries(SCREENS)) {
    if (width % screen.width !== 0 || height % screen.height !== 0) continue;
    const scale = width / screen.width;
    if (scale >= 1 && height / screen.height === scale) return { display, scale };
  }
  return null;
}

/**
 * A decoded picture ({ width, height, rgba }) as a frame of its display, the way the core holds one (front: B, G, R a
 * pixel; back: 4-bit gray, two pixels a byte, the left one in the low nibble). Transparent parts are on black, as the
 * display shows them. Throws a PictureError for a picture that is not a screenshot.
 */
export function frameOf({ width, height, rgba }) {
  const found = displayOf(width, height);
  if (!found) throw new PictureError(`it is ${width}×${height}: a front screenshot is 72×16 and a back one 160×80, or an exact enlargement of either`);
  const { display, scale } = found;
  const screen = SCREENS[display];
  const at = (x, y) => (y * width + x) * 4;
  // Every enlarged pixel must be one color: then the small picture is exact.
  if (scale > 1) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const corner = at(x - (x % scale), y - (y % scale));
        const here = at(x, y);
        if (rgba[here] !== rgba[corner] || rgba[here + 1] !== rgba[corner + 1] || rgba[here + 2] !== rgba[corner + 2] || rgba[here + 3] !== rgba[corner + 3]) {
          throw new PictureError(`it is ${width}×${height}, ${scale} times the ${display} display, but it is not an exact enlargement (it was smoothed or edited): use the screenshot at ${screen.width}×${screen.height}`);
        }
      }
    }
  }
  const pixel = (x, y) => {
    const i = at(x * scale, y * scale);
    const alpha = rgba[i + 3] / 255;
    return [Math.round(rgba[i] * alpha), Math.round(rgba[i + 1] * alpha), Math.round(rgba[i + 2] * alpha)];
  };
  const frame = new Uint8Array(screen.frameBytes);
  if (display === "front") {
    for (let y = 0; y < screen.height; y++) {
      for (let x = 0; x < screen.width; x++) {
        const [r, g, b] = pixel(x, y);
        frame.set([b, g, r], (y * screen.width + x) * 3);
      }
    }
  } else {
    for (let y = 0; y < screen.height; y++) {
      for (let x = 0; x < screen.width; x++) {
        const [r, g, b] = pixel(x, y);
        // The OLED's 16 levels, as the bar's own local web shows them (level n as n × 17).
        const level = Math.min(15, Math.round((0.299 * r + 0.587 * g + 0.114 * b) / 17));
        const index = y * screen.width + x;
        frame[index >> 1] |= index & 1 ? level << 4 : level;
      }
    }
  }
  return { display, scale, frame };
}

/**
 * Reads one file the author chose: { display, scale, small, large } (the PNG at the display's size and its 8× copy),
 * or { problem } that says why it is not taken.
 */
export function readScreenshotFile(file) {
  const name = path.basename(file);
  try {
    if (!/\.png$/i.test(name)) return { problem: `${name} is not a PNG file.` };
    if (statSync(file).size > MAX_PICTURE_BYTES) return { problem: `${name} is larger than ${MAX_PICTURE_BYTES / 1024 / 1024} MiB.` };
    const { display, scale, frame } = frameOf(decodePng(readFileSync(file)));
    return { display, scale, small: encodeScreenPng(display, frame), large: encodeScaledScreenPng(display, frame, README_SCALE) };
  } catch (e) {
    if (e instanceof PictureError) return { problem: `${name}: ${e.message}.` };
    return { problem: `${name} could not be read (${e?.code ?? e?.message ?? e}).` };
  }
}
