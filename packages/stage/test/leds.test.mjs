// The pictures the 3D view's frame makes of the bar's two displays (frame/leds.js).
import assert from "node:assert/strict";
import { test } from "node:test";

import { BACK, createBackPainter, createLedPainter, FRONT, LED, statusLedLook } from "../frame/leds.js";

const frame = (paint) => {
  const bgr = new Uint8Array(FRONT.width * FRONT.height * 3);
  paint((x, y, r, g, b) => bgr.set([b, g, r], (y * FRONT.width + x) * 3));
  return bgr;
};
const texel = (painter, x, y) => [...painter.data.subarray((y * painter.width + x) * 4, (y * painter.width + x) * 4 + 4)];

test("the front display's picture is the 72x16 frame, a cell of texels for each LED, opaque", () => {
  const painter = createLedPainter(12);
  assert.deepEqual([painter.width, painter.height], [72 * 12, 16 * 12]);
  assert.equal(painter.data.length, painter.width * painter.height * 4);
  painter.paint(frame(() => {}));
  for (let i = 3; i < painter.data.length; i += 4) assert.equal(painter.data[i], 255);
});

test("a lit LED is its color in the middle of its cell, and the frame's bytes are blue, green, red", () => {
  const painter = createLedPainter(12);
  painter.paint(frame((set) => {
    set(0, 0, 255, 0, 0);
    set(10, 5, 0, 200, 40);
    set(71, 15, 10, 20, 250);
  }));
  assert.deepEqual(texel(painter, 6, 6), [255, 0, 0, 255]);
  assert.deepEqual(texel(painter, 10 * 12 + 6, 5 * 12 + 6), [0, 200, 40, 255]);
  assert.deepEqual(texel(painter, 71 * 12 + 6, 15 * 12 + 6), [10, 20, 250, 255]);
});

test("between LEDs there is a gap with a soft glow of the picture, not the LED's color and not black", () => {
  const painter = createLedPainter(12);
  painter.paint(frame((set) => {
    for (let y = 0; y < FRONT.height; y++) for (let x = 0; x < FRONT.width; x++) set(x, y, 255, 255, 255);
  }));
  // The corner of a cell lies between four LEDs.
  const [r, g, b] = texel(painter, 30 * 12, 8 * 12);
  assert.ok(r > 60 && r < 160 && r === g && g === b, `the gap glows at about ${Math.round(255 * LED.glow)}: ${r}`);
  // A lone LED lights its neighbours' cells a little and leaves the far ones dark.
  painter.paint(frame((set) => set(36, 8, 255, 255, 255)));
  const near = texel(painter, 37 * 12 + 1, 8 * 12 + 6)[0];
  const far = texel(painter, 45 * 12 + 1, 8 * 12 + 1)[0];
  assert.ok(near > 5 && near < 120, `beside the LED: ${near}`);
  assert.equal(far, 0);
});

test("a dark LED is barely there; one just above the threshold is lit", () => {
  const painter = createLedPainter(12);
  painter.paint(frame((set) => {
    set(5, 5, 3, 3, 3); // below 4 % of full: dark
    set(20, 5, 12, 12, 12);
  }));
  const dark = texel(painter, 5 * 12 + 6, 5 * 12 + 6)[0];
  assert.ok(dark > 0 && dark <= Math.ceil(255 * LED.dark) + 2, `a dark LED: ${dark}`);
  assert.deepEqual(texel(painter, 20 * 12 + 6, 5 * 12 + 6).slice(0, 3), [12, 12, 12]);
  // Nothing lit at all: only the dark LEDs' faint squares, the gaps black.
  painter.paint(frame(() => {}));
  assert.deepEqual(texel(painter, 0, 0).slice(0, 3), [0, 0, 0]);
});

test("the painter paints the same frame the same way twice, and a new frame leaves nothing of the old", () => {
  const painter = createLedPainter(8);
  const one = frame((set) => set(3, 3, 255, 128, 0));
  painter.paint(one);
  const first = painter.data.slice();
  painter.paint(frame((set) => set(60, 10, 0, 0, 255)));
  assert.notDeepEqual(painter.data, first);
  painter.paint(one);
  assert.deepEqual(painter.data, first);
});

test("the back display's picture is its 160x80 frame, four bits a pixel, the first pixel of a byte in its low half", () => {
  const painter = createBackPainter(1);
  assert.deepEqual([painter.width, painter.height], [160, 80]);
  const bytes = new Uint8Array((BACK.width * BACK.height) / 2);
  bytes[0] = 0xf0; // pixel 0 black, pixel 1 white
  bytes[bytes.length - 1] = 0x07; // the last but one mid gray, the last black
  painter.paint(bytes);
  assert.deepEqual(texel(painter, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(texel(painter, 1, 0), [255, 255, 255, 255]);
  assert.deepEqual(texel(painter, 158, 79), [119, 119, 119, 255]);
  assert.deepEqual(texel(painter, 159, 79), [0, 0, 0, 255]);
  const big = createBackPainter(3);
  big.paint(bytes);
  assert.deepEqual([big.width, big.height], [480, 240]);
  for (const [x, y] of [[3, 0], [5, 2], [4, 1]]) assert.deepEqual(texel(big, x, y), [255, 255, 255, 255]);
  assert.deepEqual(texel(big, 2, 2), [0, 0, 0, 255]);
});

test("a frame of the wrong size is refused", () => {
  assert.throws(() => createLedPainter(12).paint(new Uint8Array(10)), RangeError);
  assert.throws(() => createBackPainter().paint(new Uint8Array(10)), RangeError);
});

test("a status LED shows its hue at full strength, lit as the eye sees the firmware's PWM: plainly on, never off while lit", () => {
  // The BUSY timer's red, 150 of 255, at the default brightness (0.48): 15 % PWM, fully lit on screen.
  assert.deepEqual(statusLedLook([150, 0, 0], 0.48), { hue: [255, 0, 0], glow: 1, halo: 0.5329 });
  // The rest's green keeps its hue.
  assert.deepEqual(statusLedLook([10, 150, 5], 0.48).hue, [17, 255, 9]);
  // The lowest brightness the setting gives (5 %): about half.
  assert.equal(statusLedLook([150, 0, 0], 0.05).glow, 0.4499);
  // The rainbow (HSV value 16 of 255): dimmer than the timer, still visible.
  const rainbow = statusLedLook([255, 128, 0], 0.48, 16 / 255);
  assert.ok(rainbow.glow > 0.6 && rainbow.glow < 0.7 && rainbow.halo < 0.3, JSON.stringify(rainbow));
  // More brightness, a wider halo.
  assert.ok(statusLedLook([150, 0, 0], 0.9).halo > statusLedLook([150, 0, 0], 0.48).halo);
  // Black or level 0: dark.
  assert.equal(statusLedLook([0, 0, 0], 1), null);
  assert.equal(statusLedLook([255, 0, 0], 0), null);
});
