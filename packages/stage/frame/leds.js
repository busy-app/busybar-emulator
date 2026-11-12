// The bar's two displays as pictures for the scene. No page, no canvas: typed arrays in, RGBA out, so the same code
// runs in the frame and in a test under Node.
//
// The front display is drawn the way the flat view draws it (legacy-window/window.js, the LED look of busy-lib's
// LedRenderer): each of the 72x16 LEDs a square with rounded corners, a gap between them, a soft glow of the picture
// under them, and the dark ones barely there. The scene shows the result as it is; it adds only its own bloom.

export const FRONT = Object.freeze({ width: 72, height: 16 });
export const BACK = Object.freeze({ width: 160, height: 80 });

/** The LED look, in shares of a cell. */
export const LED = Object.freeze({ size: 0.85, radius: 0.5, darkThreshold: 0.04 * 255 * 3, glow: 0.45, dark: 0.028 });

/** How much of each texel of a cell the LED covers, 0..1: a rounded square, its edge smoothed (4x4 samples a texel). */
function ledMask(cell) {
  const mask = new Float32Array(cell * cell);
  const half = (cell * LED.size) / 2;
  const radius = half * Math.sqrt(LED.radius);
  const centre = cell / 2;
  const N = 4;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      let inside = 0;
      for (let sy = 0; sy < N; sy++) {
        for (let sx = 0; sx < N; sx++) {
          const dx = Math.abs(x + (sx + 0.5) / N - centre);
          const dy = Math.abs(y + (sy + 0.5) / N - centre);
          if (dx > half || dy > half) continue;
          const cx = dx - (half - radius);
          const cy = dy - (half - radius);
          if (cx > 0 && cy > 0 && cx * cx + cy * cy > radius * radius) continue;
          inside++;
        }
      }
      mask[y * cell + x] = inside / (N * N);
    }
  }
  return mask;
}

/**
 * A painter of the front display for one cell size.
 * @param {number} cell  texels a LED's cell takes on each side (the picture is 72*cell by 16*cell)
 * @returns {{ width: number, height: number, data: Uint8ClampedArray, paint: (bgr: Uint8Array) => void }}
 *   `paint` takes the display's frame as the bar gives it (BGR888, 72x16, rows top to bottom) and fills `data`, RGBA.
 */
export function createLedPainter(cell = 12) {
  const { width: W, height: H } = FRONT;
  const width = W * cell;
  const height = H * cell;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const mask = ledMask(cell);
  // The glow is the picture itself, softened: each LED with its neighbours (1 2 1 each way), then spread smoothly
  // between the LEDs' centres.
  const soft = new Float32Array(W * H * 3);
  const row = new Float32Array(W * H * 3);
  // Where a texel column or row lies between two LEDs' centres: the first one's index and the share of the second.
  const at = (n, count) => {
    const first = new Int32Array(n * cell);
    const share = new Float32Array(n * cell);
    for (let i = 0; i < n * cell; i++) {
      const p = Math.min(Math.max((i + 0.5) / cell - 0.5, 0), count - 1);
      first[i] = Math.min(Math.floor(p), count - 2);
      share[i] = p - first[i];
    }
    return { first, share };
  };
  const columns = at(W, W);
  const rows = at(H, H);

  function paint(bgr) {
    if (bgr.length !== W * H * 3) throw new RangeError(`The front display's frame is ${W * H * 3} bytes, not ${bgr.length}`);
    // 1 2 1 along the rows, then along the columns; the result in RGB.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const l = x > 0 ? i - 3 : i;
        const r = x < W - 1 ? i + 3 : i;
        row[i] = (bgr[l + 2] + 2 * bgr[i + 2] + bgr[r + 2]) / 4;
        row[i + 1] = (bgr[l + 1] + 2 * bgr[i + 1] + bgr[r + 1]) / 4;
        row[i + 2] = (bgr[l] + 2 * bgr[i] + bgr[r]) / 4;
      }
    }
    let lit = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const u = y > 0 ? i - W * 3 : i;
        const d = y < H - 1 ? i + W * 3 : i;
        for (let c = 0; c < 3; c++) {
          soft[i + c] = ((row[u + c] + 2 * row[i + c] + row[d + c]) / 4) * LED.glow;
          if (soft[i + c] > 0) lit = true;
        }
      }
    }
    const darkAdd = 255 * LED.dark;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 3;
        const b = bgr[s], g = bgr[s + 1], r = bgr[s + 2];
        const on = r + g + b >= LED.darkThreshold;
        for (let cy = 0; cy < cell; cy++) {
          const ty = y * cell + cy;
          const r0 = rows.first[ty] * W;
          const r1 = r0 + W;
          const fy = rows.share[ty];
          let out = (ty * width + x * cell) * 4;
          let m = cy * cell;
          for (let cx = 0; cx < cell; cx++, out += 4, m++) {
            const k = mask[m];
            if (on && k === 1) {
              // Inside a lit LED nothing of the glow shows.
              data[out] = r;
              data[out + 1] = g;
              data[out + 2] = b;
              continue;
            }
            let gr = 0, gg = 0, gb = 0;
            if (lit) {
              const tx = x * cell + cx;
              const fx = columns.share[tx];
              const a = (r0 + columns.first[tx]) * 3;
              const c = (r1 + columns.first[tx]) * 3;
              const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
              gr = soft[a] * w00 + soft[a + 3] * w10 + soft[c] * w01 + soft[c + 3] * w11;
              gg = soft[a + 1] * w00 + soft[a + 4] * w10 + soft[c + 1] * w01 + soft[c + 4] * w11;
              gb = soft[a + 2] * w00 + soft[a + 5] * w10 + soft[c + 2] * w01 + soft[c + 5] * w11;
            }
            if (on) {
              data[out] = gr + (r - gr) * k;
              data[out + 1] = gg + (g - gg) * k;
              data[out + 2] = gb + (b - gb) * k;
            } else {
              const add = darkAdd * k;
              data[out] = gr + add;
              data[out + 1] = gg + add;
              data[out + 2] = gb + add;
            }
          }
        }
      }
    }
  }

  return { width, height, data, paint };
}

/**
 * The back display's frame as the bar gives it (4 bits a pixel, two pixels a byte, the first in the low half) as
 * RGBA, each pixel `scale` texels on each side, so that it stays crisp when the scene smooths the picture.
 */
export function createBackPainter(scale = 1) {
  const { width: W, height: H } = BACK;
  const width = W * scale;
  const height = H * scale;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  function paint(bytes) {
    if (bytes.length !== (W * H) / 2) throw new RangeError(`The back display's frame is ${(W * H) / 2} bytes, not ${bytes.length}`);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const v = ((bytes[i >> 1] >> ((i & 1) * 4)) & 0xf) * 17;
        for (let sy = 0; sy < scale; sy++) {
          let out = ((y * scale + sy) * width + x * scale) * 4;
          for (let sx = 0; sx < scale; sx++, out += 4) data[out] = data[out + 1] = data[out + 2] = v;
        }
      }
    }
  }
  return { width, height, data, paint };
}

// ---------------------------------------------------------------- the RGB status LEDs: how lit they look
// The firmware drives each channel of a status LED at component / 255 × level^1.85 of full PWM (status_lights_backend.c,
// status_lights_scale_component), `level` the brightness the lights run at: 0.05 to 0.9 by the brightness setting
// (brightness_conv.c, 5 + 85 % of the user's 0..100), 1 for a notification. A real LED at a few percent of PWM still
// reads as plainly lit and fully saturated: the eye takes light roughly as a cube root, and the LED is a point far
// brighter than a screen. Its color times its duty on a screen looks dull and dark. So the screen shows the LED's own
// hue at full strength (its largest channel at 255) and how lit it looks, `glow` 0..1: the cube root of the duty,
// doubled, eased. Anything the firmware lights shows at about half or more; the BUSY timer's red (150, 0, 0) at the
// default brightness (0.48) at full; the rainbow (HSV value 16 of 255) at about two thirds. The flat view's LEDs use
// the same curve (legacy-window/window.js, ledLook).

/**
 * How a status LED looks on screen.
 * @param {number[]} rgb  the firmware's color, sRGB bytes
 * @param {number} level  the brightness the lights run at, 0..1
 * @param {number} [value]  the color's strength, 0..1: its largest channel over 255 unless given (the rainbow's 16/255)
 * @returns {{ hue: number[], glow: number, halo: number } | null}  the hue at full strength (bytes); glow 0..1; halo
 *   0..1, the cube root of the duty, for what grows on with the brightness past full glow. null when dark.
 */
export function statusLedLook(rgb, level, value) {
  const peak = Math.max(...rgb);
  if (!(peak > 0) || !(level > 0)) return null;
  const halo = Math.cbrt(Math.min(1, value ?? peak / 255) * Math.min(1, level) ** 1.85);
  return { hue: rgb.map((v) => Math.round((v / peak) * 255)), glow: Math.round(Math.min(1, 2 * halo) ** 0.6 * 1e4) / 1e4, halo: Math.round(halo * 1e4) / 1e4 };
}
