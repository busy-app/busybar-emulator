// The front display as LED dots, in whole pixels: for the GIF, which keeps only the colors it is given (gif.mjs).
// The dots follow the device window's look (busy-lib's LedRenderer: a square LED with rounded corners, 85 % of its
// cell, a dark LED faintly visible), drawn without smoothing so that every pixel is either a LED's own color, a dark
// LED's or the background's.
export const FRONT = Object.freeze({ width: 72, height: 16 });
export const LED = Object.freeze({ size: 0.85, radius: 0.5, darkThreshold: 0.04 * 255 * 3 });
export const BACKGROUND = Object.freeze([0, 0, 0]);
export const DARK_LED = Object.freeze([16, 16, 16]);

/** Which pixels of a cell `scale` px wide the LED covers: a rounded square, centred. */
export function ledMask(scale) {
  const size = Math.max(1, Math.round(scale * LED.size));
  const offset = Math.floor((scale - size) / 2);
  const radius = (size / 2) * Math.sqrt(LED.radius);
  const mask = new Uint8Array(scale * scale);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The distance of the pixel's centre from the nearest corner's centre, where it is in a corner.
      const cx = x + 0.5 < radius ? radius : x + 0.5 > size - radius ? size - radius : x + 0.5;
      const cy = y + 0.5 < radius ? radius : y + 0.5 > size - radius ? size - radius : y + 0.5;
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2) mask[(y + offset) * scale + x + offset] = 1;
    }
  }
  return mask;
}

/**
 * The front frame (B, G, R bytes, 72×16, as GET /api/screen sends it) as RGB pixels, (72 × scale) × (16 × scale).
 * @returns {Uint8Array}
 */
export function renderFront(frame, scale) {
  const width = FRONT.width * scale;
  const out = new Uint8Array(width * FRONT.height * scale * 3);
  const mask = ledMask(scale);
  for (let ly = 0; ly < FRONT.height; ly++) {
    for (let lx = 0; lx < FRONT.width; lx++) {
      const i = (ly * FRONT.width + lx) * 3;
      const b = frame[i], g = frame[i + 1], r = frame[i + 2];
      const color = r + g + b < LED.darkThreshold ? DARK_LED : [r, g, b];
      for (let y = 0; y < scale; y++) {
        let o = ((ly * scale + y) * width + lx * scale) * 3;
        for (let x = 0; x < scale; x++, o += 3) {
          const c = mask[y * scale + x] ? color : BACKGROUND;
          out[o] = c[0];
          out[o + 1] = c[1];
          out[o + 2] = c[2];
        }
      }
    }
  }
  return out;
}
