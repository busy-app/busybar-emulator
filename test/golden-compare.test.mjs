// What golden.mjs compares (golden-compare.mjs): everything, but for the SETUP hint's address and, in the recordings
// of a bar that was not on USB at 100 % (1.4.1's), the USB icon and the battery of the status bar.
//
//   node --test emulator/test/golden-compare.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BACK, compare, FRONT, maskOf, masked, POWER_MASKED, SCENE_MASKS, STATUS_POWER } from "./golden-compare.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const golden = (firmware, scene) => JSON.parse(readFileSync(join(here, "golden", firmware, `${scene}.json`), "utf8"));
const scenes = (firmware) => readdirSync(join(here, "golden", firmware)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

/** The back display's pixel (0-15) at x, y of a frame as GET /api/screen gives it (base64). */
const pixel = (b64, x, y) => {
  const i = y * BACK.width + x;
  return (Buffer.from(b64, "base64")[i >> 1] >> ((i & 1) * 4)) & 15;
};
/** The same frame with the back display's pixel at x, y set to `value`. */
function withPixel(b64, x, y, value) {
  const bytes = Buffer.from(b64, "base64");
  const i = y * BACK.width + x;
  const shift = (i & 1) * 4;
  bytes[i >> 1] = (bytes[i >> 1] & ~(15 << shift)) | (value << shift);
  return bytes.toString("base64");
}
/** The status bar's pixels (x 148-159) of rows `from`-`to`, as a string. */
const statusRows = (b64, from, to) => [...Array(to - from + 1).keys()].map((k) => [...Array(12).keys()].map((dx) => pixel(b64, 148 + dx, from + k).toString(16)).join("")).join("/");
/** A front frame (base64) with the rectangle x0-x1, y0-y1 made black. */
function frontErased(b64, [x0, y0, x1, y1]) {
  const bytes = Buffer.from(b64, "base64");
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bytes.fill(0, (y * FRONT.width + x) * 3, (y * FRONT.width + x) * 3 + 3);
  return bytes.toString("base64");
}
/** A back frame (base64) with the rectangle x0-x1, y0-y1 made black. */
function backErased(b64, [x0, y0, x1, y1]) {
  let back = b64;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) back = withPixel(back, x, y, 0);
  return back;
}

test("the status bar above the USB widget is the same in every golden of both firmwares: BLE not shown, Wi-Fi and sound where the mask leaves them", () => {
  // Rows 0-23: Wi-Fi (2-8) and sound (13-19) with the column's top padding and spacing, as status_bar.c lays them out
  // with BLE not shown. A golden with BLE shown, or another layout, moves them, and the USB widget into the rows the
  // power mask leaves out with them.
  const reference = statusRows(golden("1.3.1", "font-tiny").back, 0, 23);
  const lit = (rows) => rows.split("/").map((r, y) => (/[^0]/.test(r) ? y : null)).filter((y) => y !== null);
  assert.deepEqual(lit(reference), [2, 3, 4, 5, 7, 8, 13, 14, 15, 16, 17, 18, 19]);
  for (const firmware of ["1.3.1", "1.4.1"]) {
    for (const scene of scenes(firmware)) assert.equal(statusRows(golden(firmware, scene).back, 0, 23), reference, `${firmware}/${scene}: the status bar's rows 0-23`);
  }
  for (const [x0, y0, x1] of STATUS_POWER) assert.ok(x0 === 148 && x1 === 159 && y0 >= 24, `${x0}, ${y0}, ${x1}`);
});

test("the power is left out only in the recordings made off USB: 1.4.1's, not 1.3.1's", () => {
  assert.deepEqual(Object.keys(POWER_MASKED), ["1.4.1"]);
  assert.deepEqual(maskOf("font-tiny", "1.3.1"), { front: [], back: [] });
  assert.deepEqual(maskOf("font-tiny", "1.4.1"), { front: [], back: STATUS_POWER });
  // In 1.3.1's goldens the USB icon and the full battery are there, and compared.
  const g = golden("1.3.1", "font-tiny");
  const changed = withPixel(g.back, 152, 30, 15 - pixel(g.back, 152, 30));
  assert.deepEqual(compare(g, { ...g, back: changed }, maskOf("font-tiny", "1.3.1")), { front: 0, back: 1 });
});

test("in 1.4.1's goldens a frame that differs only in the USB icon and the battery agrees; one pixel just outside does not", () => {
  const g = golden("1.4.1", "font-tiny");
  const mask = maskOf("font-tiny", "1.4.1");
  let back = g.back;
  for (const [x0, y0, x1, y1] of STATUS_POWER) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) back = withPixel(back, x, y, 15 - pixel(back, x, y));
  assert.deepEqual(compare(g, { ...g, back }, mask), { front: 0, back: 0 });
  for (const [x, y] of [[148, 23], [159, 36], [148, 50], [159, 79], [147, 24], [147, 78]]) {
    assert.ok(!masked(mask.back, x, y), `${x}, ${y} is outside the mask`);
    const one = withPixel(g.back, x, y, 15 - pixel(g.back, x, y));
    assert.deepEqual(compare(g, { ...g, back: one }, mask), { front: 0, back: 1 }, `the pixel at ${x}, ${y}`);
  }
});

test("the bar's frames of one scene on two days agree through 1.4.1's mask: USB in at 100 % on 1.3.1, on battery on 1.4.1", () => {
  for (const scene of ["font-tiny", "back-text", "rect-solid"]) {
    const [a, b] = [golden("1.3.1", scene), golden("1.4.1", scene)];
    assert.notEqual(statusRows(a.back, 24, 79), statusRows(b.back, 24, 79), `${scene}: the power differs`);
    assert.deepEqual(compare(a, b, maskOf(scene, "1.4.1")), { front: 0, back: 0 }, scene);
  }
});

test('the SETUP hint leaves out its address only: "Set up via" and the arrow are compared', () => {
  const g = golden("1.4.1", "system-setup-hint");
  const mask = maskOf("system-setup-hint", "1.4.1");
  // "Set up via" erased: rows 2-7 of the front between the icon and the arrow, rows 42-51 of the back.
  const label = compare(g, { front: frontErased(g.front, [9, 2, 63, 7]), back: backErased(g.back, [0, 42, 147, 51]) }, mask);
  assert.ok(label.front > 0 && label.back > 0, `the label is compared: ${JSON.stringify(label)}`);
  // The arrow erased (x 64-71).
  assert.ok(compare(g, { ...g, front: frontErased(g.front, [64, 0, 71, 15]) }, mask).front > 0, "the arrow is compared");
  // The address erased: not compared.
  const [front] = SCENE_MASKS["system-setup-hint"].front;
  const [back] = SCENE_MASKS["system-setup-hint"].back;
  assert.deepEqual(compare(g, { front: frontErased(g.front, front), back: backErased(g.back, back) }, mask), { front: 0, back: 0 });
});
