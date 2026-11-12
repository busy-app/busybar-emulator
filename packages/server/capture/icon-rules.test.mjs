// The icons' requirements (icon-rules.mjs) and their conversion: what the window's icon block and create --icon say of a
// picture, and that what the conversion makes passes the catalog's own icon rules (catalog-png.mjs).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { checkCatalogPng } from "./catalog-png.mjs";
import { asText, checkPicture, decodePng, defaultIcons, encodePng, iconsFromPicture, backFromPicture } from "./icon.mjs";
import { BACK_FROM_FRONT, checkIcon, DEFAULT_ICON, readPngHeader, REQUIREMENTS } from "./icon-rules.mjs";

/** An RGBA picture: `paint(x, y)` gives [r, g, b, a]. */
function rgba(width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  return encodePng({ width, height, channels: 4, data });
}
/** Gray and alpha: `paint(x, y)` gives [gray, a]. */
function gray(width, height, paint) {
  const data = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 2);
  return encodePng({ width, height, channels: 2, data });
}
/** A PNG of any header, its image data as given (raw rows, deflated here). */
function rawPng({ width, height, depth, color, rows }) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([depth, color, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const ring = (n) => (x, y) => (x === 0 || y === 0 || x === n - 1 || y === n - 1 ? [255, 90, 31, 255] : [0, 0, 0, 0]);
const failed = (verdict) => Object.entries(verdict.results).filter(([, r]) => !r.ok).map(([id]) => id);
const catalog = (bytes, side) => checkCatalogPng(bytes, side === "front" ? "icon_front" : "icon_back").verdict;

test("the requirements: a short list for each side, from the firmware and the catalog", () => {
  assert.deepEqual(REQUIREMENTS.front.map((r) => r.id), ["png", "size", "color", "bytes"]);
  assert.deepEqual(REQUIREMENTS.back.map((r) => r.id), ["png", "size", "color", "bytes"]);
  assert.match(REQUIREMENTS.front[1].text, /8×8/);
  assert.match(REQUIREMENTS.back[1].text, /11×11/);
  assert.match(REQUIREMENTS.back[2].text, /Gray with transparency/);
  assert.match(BACK_FROM_FRONT, /made from the front/);
  for (const r of [...REQUIREMENTS.front, ...REQUIREMENTS.back]) assert.doesNotMatch(r.text, /[\u00b7\u2022]|\bthe bar\b/);
});

test("good icons pass every requirement", () => {
  const front = rgba(8, 8, ring(8));
  const back = gray(11, 11, (x, y) => [255, (x + y) % 2 ? 255 : 0]);
  for (const [bytes, side] of [[front, "front"], [back, "back"]]) {
    const verdict = checkPicture(bytes, side);
    assert.equal(verdict.ok, true, side);
    assert.equal(verdict.fix, null);
    assert.equal(catalog(bytes, side), "pass");
  }
});

test("the wrong size: the size fails, and scaling it is offered; the scaled icon passes the catalog", () => {
  const big = rgba(64, 64, (x, y) => (x > 8 && x < 56 && y > 8 && y < 56 ? [40, 200, 120, 255] : [0, 0, 0, 0]));
  const verdict = checkPicture(big, "front");
  assert.deepEqual(failed(verdict), ["size"]);
  assert.equal(verdict.results.size.problem, "It is 64×64 pixels.");
  assert.match(verdict.results.size.next, /Scale it to 8×8/);
  assert.equal(verdict.fix.label, "Scale to 8×8");
  const made = iconsFromPicture(big);
  assert.equal(checkPicture(made.front, "front").ok, true);
  assert.equal(checkPicture(made.back, "back").ok, true);
  assert.equal(catalog(made.front, "front"), "pass");
  assert.equal(catalog(made.back, "back"), "pass");
  // The back alone, of any size: scaled to 11×11.
  const back = backFromPicture(big);
  assert.equal(readPngHeader(back).width, 11);
  assert.equal(checkPicture(back, "back").ok, true);
});

test("a back icon without transparency fails: the BUSY Bar would show a solid square; the shape can be taken from it", () => {
  const opaque = rgba(11, 11, (x, y) => (x > 2 && x < 8 && y > 2 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const verdict = checkPicture(opaque, "back");
  assert.deepEqual(failed(verdict), ["color"]);
  assert.match(verdict.results.color.problem, /no transparent pixels: the BUSY Bar would show a solid square/);
  assert.equal(verdict.fix.label, "Take the shape from it");
  const made = backFromPicture(opaque);
  assert.equal(asText(made).split("\n")[5], "...#####...");
  assert.equal(checkPicture(made, "back").ok, true);
  // A plain gray picture, no alpha channel and no tRNS, says the same without its pixels.
  const plain = rawPng({ width: 11, height: 11, depth: 8, color: 0, rows: Buffer.alloc(11 * 12, 0) });
  assert.deepEqual(failed(checkIcon("back", { bytes: plain })), ["color"]);
  // The front may be opaque.
  assert.equal(checkPicture(rgba(8, 8, () => [10, 20, 30, 255]), "front").ok, true);
});

test("a back icon in color fails and is made gray; one with nothing to show cannot be mended", () => {
  const colored = rgba(11, 11, (x) => (x < 5 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const verdict = checkPicture(colored, "back");
  assert.deepEqual(failed(verdict), ["color"]);
  assert.equal(verdict.fix.label, "Make it gray");
  const blank = gray(11, 11, () => [255, 0]);
  const empty = checkPicture(blank, "back");
  assert.deepEqual(failed(empty), ["color"]);
  assert.match(empty.results.color.problem, /Every pixel is transparent/);
  assert.equal(empty.fix, null);
});

test("the wrong format: not a PNG, and nothing to convert", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(60)]);
  const verdict = checkPicture(jpeg, "front");
  assert.deepEqual(failed(verdict), ["png"]);
  assert.match(verdict.results.png.next, /Save it as a PNG/);
  assert.equal(verdict.fix, null);
  assert.equal(readPngHeader(new Uint8Array(4)), null);
});

test("too big: more than 64 KiB fails, and saving it again mends it", () => {
  // An 8×8 icon with 70 KiB of a text chunk the catalog does not care for, but counts.
  const plain = rgba(8, 8, ring(8));
  const text = Buffer.alloc(12 + 70 * 1024);
  text.writeUInt32BE(70 * 1024, 0);
  text.write("tEXt", 4, "latin1");
  text.writeUInt32BE(crc32(text.subarray(4, 8 + 70 * 1024)), 8 + 70 * 1024);
  const large = Buffer.concat([plain.subarray(0, 33), text, plain.subarray(33)]);
  const verdict = checkPicture(large, "front");
  assert.deepEqual(failed(verdict), ["bytes"]);
  assert.equal(verdict.results.bytes.problem, "It is 71 KiB.");
  assert.equal(verdict.fix.label, "Save it smaller");
  assert.equal(catalog(large, "front"), "fail");
  const made = iconsFromPicture(large).front;
  assert.ok(made.length < 1024);
  assert.equal(checkPicture(made, "front").ok, true);
});

test("16 bits a channel fails as the catalog says, and is converted to 8; several faults are one conversion", () => {
  const rows = Buffer.alloc(8 * (1 + 8 * 8));
  const deep = rawPng({ width: 8, height: 8, depth: 16, color: 6, rows });
  assert.deepEqual(failed(checkPicture(deep, "front")), ["color"]);
  assert.equal(checkPicture(deep, "front").fix.label, "Convert to 8 bits");
  const both = rgba(16, 16, () => [255, 0, 0, 255]);
  const verdict = checkPicture(both, "back");
  assert.deepEqual(failed(verdict), ["size", "color"]);
  assert.equal(verdict.fix.label, "Convert to 11×11, gray with transparency");
});

test("the default icon: BUSY's apps symbol, both sizes, passing the requirements and the catalog", () => {
  const { front, back } = defaultIcons();
  assert.equal(asText(front), DEFAULT_ICON.front.join("\n"));
  assert.equal(asText(back), DEFAULT_ICON.back.join("\n"));
  assert.equal(checkPicture(front, "front").ok, true);
  assert.equal(checkPicture(back, "back").ok, true);
  assert.equal(catalog(front, "front"), "pass");
  assert.equal(catalog(back, "back"), "pass");
  const { rgba: pixels } = decodePng(front);
  assert.deepEqual([...pixels.subarray(0, 4)], [...DEFAULT_ICON.color, 255]);
  assert.equal(readPngHeader(back).color, 4, "the back is gray with alpha");
});

test("create --icon and --back-icon: checked before anything is made, converted when the conversion mends them", async () => {
  const { iconsGiven } = await import("../cli/commands/create.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "icon-rules-"));
  try {
    const sys = { cwd: () => dir };
    writeFileSync(path.join(dir, "big.png"), rgba(32, 32, ring(32)));
    writeFileSync(path.join(dir, "photo.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(60)]));
    writeFileSync(path.join(dir, "back.png"), gray(11, 11, (x) => [255, x % 2 ? 255 : 0]));
    assert.equal(await iconsGiven({}, sys, {}), null);
    const given = await iconsGiven({}, sys, { icon: "big.png" });
    assert.equal(readPngHeader(given.front).width, 8);
    assert.equal(readPngHeader(given.back).width, 11, "the back made from it");
    assert.match(given.notes[0], /It is 32×32 pixels; converted \(scale to 8×8\)/);
    const own = await iconsGiven({}, sys, { backIcon: "back.png" });
    assert.equal(own.front, null);
    assert.equal(asText(own.back).split("\n")[0], ".#.#.#.#.#.");
    assert.deepEqual(own.notes, []);
    await assert.rejects(iconsGiven({}, sys, { icon: "photo.jpg" }), (e) => e.code === "picture_unreadable" && /not a PNG/.test(e.message) && /Nothing was created/.test(e.hint));
    await assert.rejects(iconsGiven({}, sys, { icon: "missing.png" }), (e) => e.code === "picture_unreadable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
