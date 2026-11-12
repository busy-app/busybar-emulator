// The PNG encoder: its files hold the frame's pixels and nothing else, read back by a reader that shares no code with
// the encoder, and from a running emulator. Whether the catalog accepts them is tested in catalog-png.test.mjs, beside
// the catalog's rules; this file uses nothing of the catalog.
//
//   node --test "emulator/packages/server/capture/*.test.mjs"
//
// The live test starts the emulator in this process on a free port (with BUSY_CAPTURE_TEST_PORT, on the first of nine
// ports from it that is not in use) and stops it at the end. Without a built firmware in packages/engine/build or a
// free port the live test is skipped with a warning on stderr; with BUSY_CAPTURE_LIVE=required it fails instead.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { COMPRESSION_LEVEL, encodeScaledScreenPng, encodeScreenPng, MAX_SCALE, SCREENS } from "./png.mjs";
import { FirmwareError, loadFirmware } from "../firmware.mjs";
import { startServer } from "../server.mjs";
import { allDifferent, backFrame, decodePng, EDGE_FRAMES, framePixel, pngPixel, tempDir } from "./test-support.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.resolve(HERE, "../../../test/golden");

function assertSamePixels(name, frame, png) {
  const image = decodePng(png);
  const { width, height } = SCREENS[name];
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const want = framePixel(name, frame, x, y);
      const got = pngPixel(image, x, y);
      if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) {
        assert.fail(`${name} pixel (${x}, ${y}) is ${got}, the frame has ${want}`);
      }
    }
  }
  return image;
}

// ---------------------------------------------------------------- the format

test("a front frame becomes an 8-bit RGB PNG of 72×16, a back frame an 8-bit grayscale PNG of 160×80", () => {
  for (const [name, color] of [["front", 2], ["back", 0]]) {
    const png = encodeScreenPng(name, new Uint8Array(SCREENS[name].frameBytes));
    const header = png.subarray(16, 29);
    assert.equal(header.readUInt32BE(0), SCREENS[name].width);
    assert.equal(header.readUInt32BE(4), SCREENS[name].height);
    assert.deepEqual([...header.subarray(8)], [8, color, 0, 0, 0]);
  }
});

test("the file holds IHDR, one IDAT and IEND and nothing after IEND", () => {
  for (const [name, , frame] of EDGE_FRAMES) {
    const png = encodeScreenPng(name, frame);
    assert.deepEqual(decodePng(png).chunks, ["IHDR", "IDAT", "IEND"]);
    assert.deepEqual([...png.subarray(-12)], [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  }
});

test("the same frame gives the same bytes", () => {
  for (const [name, , frame] of EDGE_FRAMES) {
    const copy = Uint8Array.from(frame);
    assert.ok(encodeScreenPng(name, frame).equals(encodeScreenPng(name, copy)));
  }
  assert.equal(COMPRESSION_LEVEL, 9);
});

test("the encoder does not change the frame it is given", () => {
  const frame = Uint8Array.from(allDifferent);
  encodeScreenPng("front", frame);
  assert.deepEqual(frame, allDifferent);
});

test("a frame of the wrong length or an unknown display is refused", () => {
  assert.throws(() => encodeScreenPng("front", new Uint8Array(3455)), /front frame is 3455 bytes, expected 3456 \(72×16\)/);
  assert.throws(() => encodeScreenPng("back", new Uint8Array(6401)), /back frame is 6401 bytes, expected 6400 \(160×80\)/);
  assert.throws(() => encodeScreenPng("back", new Uint8Array(SCREENS.front.frameBytes)), RangeError);
  assert.throws(() => encodeScreenPng("side", new Uint8Array(3456)), /Unknown display "side"/);
  assert.throws(() => encodeScreenPng("toString", new Uint8Array(3456)), /Unknown display/);
  assert.throws(() => encodeScreenPng("front", "AAAA"), TypeError);
});

// ---------------------------------------------------------------- pixels

test("edge frames: every pixel reads back as the bar shows it", () => {
  for (const [name, , frame] of EDGE_FRAMES) assertSamePixels(name, frame, encodeScreenPng(name, frame));
});

test("back levels 0..15 are written as 0, 17, 34 .. 255", () => {
  for (let level = 0; level < 16; level++) {
    const image = decodePng(encodeScreenPng("back", backFrame(() => level)));
    assert.ok(image.samples.every((v) => v === level * 17), `level ${level}`);
  }
});

test("every LED of the front frame keeps its own color", () => {
  const image = assertSamePixels("front", allDifferent, encodeScreenPng("front", allDifferent));
  const colors = new Set();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 72; x++) colors.add(pngPixel(image, x, y).join());
  assert.equal(colors.size, 72 * 16);
});

// ---------------------------------------------------------------- the enlarged copy

test("an enlarged copy: every pixel of the frame is a square of its color, in the display's format", () => {
  const frames = EDGE_FRAMES.filter(([, l]) => /every-led|channels|across|checker/.test(l));
  // The largest only on one frame of each display: the reader here is slow on 13 million pixels.
  const runs = [2, 3, 8].flatMap((scale) => frames.map((f) => [scale, ...f])).concat(frames.filter(([, l]) => /every-led|checker/.test(l)).map((f) => [MAX_SCALE, ...f]));
  for (const [scale, name, label, frame] of runs) {
    const image = decodePng(encodeScaledScreenPng(name, frame, scale));
    const { width, height, colorType } = SCREENS[name];
    assert.equal(image.width, width * scale, label);
    assert.equal(image.height, height * scale, label);
    assert.equal(image.color, colorType, label);
    assert.deepEqual(image.chunks, ["IHDR", "IDAT", "IEND"], label);
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const want = framePixel(name, frame, Math.floor(x / scale), Math.floor(y / scale));
        const got = pngPixel(image, x, y);
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) assert.fail(`${label} ×${scale}: pixel (${x}, ${y}) is ${got}, the frame has ${want}`);
      }
    }
  }
});

test("an enlarged copy is the same bytes for the same frame, and leaves the frame as it was", () => {
  const frame = Uint8Array.from(allDifferent);
  const once = encodeScaledScreenPng("front", frame, 8);
  assert.ok(once.equals(encodeScaledScreenPng("front", Uint8Array.from(allDifferent), 8)));
  assert.deepEqual(frame, allDifferent);
});

test("an enlargement other than a whole number from 2 to 32, or a wrong frame, is refused", () => {
  const frame = new Uint8Array(SCREENS.front.frameBytes);
  for (const scale of [1, 0, -2, 2.5, 33, NaN, "8", undefined]) {
    assert.throws(() => encodeScaledScreenPng("front", frame, scale), /whole number from 2 to 32/, String(scale));
  }
  assert.throws(() => encodeScaledScreenPng("back", frame, 2), /back frame is 3456 bytes/);
  assert.throws(() => encodeScaledScreenPng("side", frame, 2), /Unknown display "side"/);
});

// ---------------------------------------------------------------- a running emulator

/**
 * Starts the emulator in this process (startServer) on a free port — or, when BUSY_CAPTURE_TEST_PORT names one, on
 * the first of nine from it that is not in use. It is stopped when the test is over, and ends with this process.
 */
async function startEmulator(t) {
  const first = process.env.BUSY_CAPTURE_TEST_PORT ? Number(process.env.BUSY_CAPTURE_TEST_PORT) : null;
  const data = tempDir(t);
  for (const port of first === null ? [0] : Array.from({ length: 9 }, (_, i) => first + i)) {
    try {
      const emulator = await startServer({ port, dataDir: data, barSpeed: false });
      t.after(() => emulator.stop());
      return { base: `${emulator.url}/api` };
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  return { skip: `ports ${first}–${first + 8} are all taken` };
}

/** A live test that cannot run is skipped loudly, or fails when the environment says it is required. */
function cannotRun(t, why) {
  if (process.env.BUSY_CAPTURE_LIVE === "required") assert.fail(`The live test is required (BUSY_CAPTURE_LIVE=required) but ${why}.`);
  process.stderr.write(`WARNING: the live /api/screen test is skipped: ${why}. Pixels were not compared with a running emulator.\n`);
  t.skip(why);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test("a frame from GET /api/screen of a running emulator encodes to the same pixels, which match the bar's golden", async (t) => {
  // The emulator runs from the engine's build of its default firmware, local web included; no firmware checkout.
  try {
    loadFirmware();
  } catch (e) {
    if (!(e instanceof FirmwareError)) throw e;
    return cannotRun(t, `the emulator's firmware cannot run: ${e.message}`);
  }
  const emulator = await startEmulator(t);
  if (emulator.skip) return cannotRun(t, emulator.skip);
  const { base } = emulator;
  // Two scenes recorded on a bar: colored text on the front, text on the back (whose right 12 columns are the
  // firmware's status bar in the state the golden's bar had).
  for (const scene of ["text-color-center", "back-text"]) {
    const golden = JSON.parse(readFileSync(path.join(GOLDEN, `${scene}.json`), "utf8"));
    await fetch(`${base}/display/draw?application_name=capture`, { method: "DELETE" });
    await sleep(150);
    const draw = await fetch(`${base}/display/draw`, {
      method: "POST",
      body: JSON.stringify({ application_name: "capture", priority: 100, elements: golden.elements }),
    });
    assert.equal(draw.status, 200, await draw.text());
    await sleep(400);
    for (const [name, key] of [["front", "front"], ["back", "back"]]) {
      const response = await fetch(`${base}/screen?display=${SCREENS[name].display}`);
      assert.equal(response.status, 200);
      const frame = Buffer.from(await response.text(), "base64");
      const png = encodeScreenPng(name, frame);
      assertSamePixels(name, frame, png);
      assertSamePixels(name, Buffer.from(golden[key], "base64"), png);
    }
  }
});
