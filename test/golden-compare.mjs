// How golden.mjs compares a bar's frames with the emulator's, and the picture of a difference. Apart from golden.mjs so
// that golden-compare.test.mjs can check what is compared and what is not.
//
// Pixel for pixel, both displays, but for what a scene or a firmware's recordings name (maskOf):
//   - SCENE_MASKS: the SETUP hint's address, the bar's USB address on a bar and the emulator's own in the emulator;
//   - POWER_MASKED: the recordings of a bar that was not on USB at 100 %, as the emulator is (emu_status.c), leave out
//     the two parts of the status bar that show the bar's own power, the USB icon and the battery with its charge
//     (Mikhail's decision, 17.11: a bar at exactly 100 % and on USB is too hard to get for a recording). The 1.3.1
//     recordings were taken so and are compared whole. The rest of the status bar (Wi-Fi, BLE, sound) always is.
import { crc32, deflateSync } from "node:zlib";

export const FRONT = { width: 72, height: 16 };
export const BACK = { width: 160, height: 80 };

// The status bar (applications/services/status_bar/status_bar.c): a column BACK_STATUS_BAR_WIDTH (12 px) wide at the
// right of the back display, x 148-159, padded 2 px at the top and 1 px at the bottom, its widgets 3 px apart: BLE
// (shown only while it is on or pairing), Wi-Fi, sound, USB (usb_8x12.image, shown while USB is in), and the battery
// out of the column at the bottom (battery_8x18.image, then 1 px and the charge in the small font). With BLE not shown,
// as in every golden, the USB widget is rows 24-35 and the battery's rows 51-78. Rectangles [x0, y0, x1, y1], inclusive.
export const STATUS_POWER = [
  [148, 24, 159, 35],
  [148, 51, 159, 78],
];

export const decode = (b64) => Buffer.from(b64, "base64");
export const frontPixel = (f, x, y) => {
  const i = (y * FRONT.width + x) * 3;
  return [f[i + 2], f[i + 1], f[i]];
};
export const backPixel = (f, x, y) => {
  const i = y * BACK.width + x;
  const v = ((f[i >> 1] >> ((i & 1) * 4)) & 0xf) * 17;
  return [v, v, v];
};

// The firmwares whose recordings leave out the status bar's power (STATUS_POWER), and why.
export const POWER_MASKED = {
  "1.4.1": "recorded on 17.11 with the bar on Wi-Fi, off USB, its battery below 100 %",
};

// What a scene leaves out, as rectangles [x0, y0, x1, y1] (inclusive) of each display.
export const SCENE_MASKS = {
  // The hint's second line, the address: on the front right of the icon (x 0-7) and left of the arrow (x 64-71), under
  // "Set up via" (rows 0-7); on the back under the icon and "Set up via" (rows 0-52).
  "system-setup-hint": { front: [[9, 8, 63, 15]], back: [[0, 53, 147, 79]] },
};

export const masked = (rects, x, y) => (rects ?? []).some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);

/** The rectangles not compared in `scene` of `firmware`'s recordings: { front, back } (SCENE_MASKS, POWER_MASKED). */
export function maskOf(scene, firmware) {
  const own = SCENE_MASKS[scene] ?? {};
  return { front: own.front ?? [], back: [...(POWER_MASKED[firmware] ? STATUS_POWER : []), ...(own.back ?? [])] };
}

/** The pixels that differ on each display, outside the mask (maskOf). */
export function compare(golden, actual, mask = { front: [], back: [] }) {
  const result = { front: 0, back: 0 };
  const gf = decode(golden.front), af = decode(actual.front);
  for (let y = 0; y < FRONT.height; y++)
    for (let x = 0; x < FRONT.width; x++) if (!masked(mask.front, x, y) && frontPixel(gf, x, y).join() !== frontPixel(af, x, y).join()) result.front++;
  const gb = decode(golden.back), ab = decode(actual.back);
  for (let y = 0; y < BACK.height; y++)
    for (let x = 0; x < BACK.width; x++) if (!masked(mask.back, x, y) && backPixel(gb, x, y).join() !== backPixel(ab, x, y).join()) result.back++;
  return result;
}

// bar | emulator | difference (red where they differ, blue where not compared), front above back, each scaled up.
export function diffImage(golden, actual, mask = { front: [], back: [] }) {
  const scale = 4;
  const gap = 4;
  const panels = [
    { w: FRONT.width * 3 * 2, h: FRONT.height * 2, frames: [golden.front, actual.front], px: frontPixel, s: 2, dw: FRONT.width, dh: FRONT.height, mask: mask.front },
    { w: BACK.width, h: BACK.height, frames: [golden.back, actual.back], px: backPixel, s: 1, dw: BACK.width, dh: BACK.height, mask: mask.back },
  ];
  const width = (BACK.width * 3 + gap * 2) * scale;
  const height = (FRONT.height * 2 + gap + BACK.height) * scale;
  const rgb = Buffer.alloc(width * height * 3, 40);
  let top = 0;
  for (const p of panels) {
    const [g, a] = p.frames.map(decode);
    for (let y = 0; y < p.dh; y++) {
      for (let x = 0; x < p.dw; x++) {
        const gp = p.px(g, x, y), ap = p.px(a, x, y);
        const same = gp.join() === ap.join();
        const cells = [gp, ap, masked(p.mask, x, y) ? [0, 0, 160] : same ? [0, 0, 0] : [255, 0, 0]];
        cells.forEach((c, k) => {
          for (let dy = 0; dy < p.s * scale; dy++) {
            for (let dx = 0; dx < p.s * scale; dx++) {
              const X = k * (BACK.width + gap) * scale + x * p.s * scale + dx;
              const Y = top + y * p.s * scale + dy;
              rgb.set(c, (Y * width + X) * 3);
            }
          }
        });
      }
    }
    top += (p.dh * p.s + gap) * scale;
  }
  return png(width, height, rgb);
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

