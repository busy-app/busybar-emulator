// The checker against the catalog: for one file per rule, it reports the check id the catalog's own code reports;
// what it calls "pass" the catalog accepts at both stages; what it cannot vouch for it calls "unverified".
//
//   node --test "emulator/packages/server/capture/*.test.mjs"
//
// The comparison with the catalog's code runs when BUSY_CATALOG_CHECKOUT names a checkout of the catalog repository
// and Python 3 is installed (Pillow for the build stage); it reads the commit the registry snapshot is pinned to.
// Otherwise it is skipped and says why; the checker's own verdicts are tested either way.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { constants, deflateRawSync, deflateSync } from "node:zlib";

import { CATALOG_PNG_RULES, checkCatalogPng, MAX_DECOMPRESSED, RULES_COMMIT } from "./catalog-png.mjs";
import { encodeScreenPng, SCREENS } from "./png.mjs";
import { catalogChecker, REGISTRY } from "./catalog-test-support.mjs";
import { buildPng, EDGE_FRAMES, framePixel, ihdr, pngChunk, SIGNATURE, tempDir, writeFiles, zeroRows } from "./test-support.mjs";

after(() => catalogChecker().cleanup?.());

const MIB2 = 2 * 1024 * 1024;
const good = encodeScreenPng("front", new Uint8Array(SCREENS.front.frameBytes));
const goodBack = encodeScreenPng("back", new Uint8Array(SCREENS.back.frameBytes));
const rgb = (rows = zeroRows(72, 16, 8, 3)) => ({ header: ihdr(72, 16, 8, 2), rows });
const IEND_AT = good.length - 12;
const idatAt = 8 + 25; // after the signature and IHDR

const flip = (bytes, at) => {
  const copy = Buffer.from(bytes);
  copy[at] ^= 0x01;
  return copy;
};
const withIdat = (header, ...bodies) => Buffer.concat([SIGNATURE, header, ...bodies.map((b) => pngChunk("IDAT", b)), pngChunk("IEND")]);
const rawIdat = (body) => withIdat(ihdr(72, 16, 8, 2), body);
const deflated = deflateSync(zeroRows(72, 16, 8, 3));
const text = (keyword, value) => pngChunk("tEXt", Buffer.from(`${keyword}\0${value}`, "latin1"));

/** A zlib stream whose header declares another window size (CINFO), with a valid header check. */
function declareWindow(stream, cinfo) {
  const out = Buffer.from(stream);
  out[0] = (cinfo << 4) | 8;
  out[1] = out[1] & 0xc0;
  out[1] += (31 - ((out[0] * 256 + out[1]) % 31)) % 31;
  return out;
}

// The back display as 8-bit RGB, black but for 40 equal bytes in rows 0 and 40: deflate copies the second run from
// 19 240 bytes back, further than a 256-byte or 16 KiB window reaches.
const farMatch = (() => {
  const rows = zeroRows(160, 80, 8, 3);
  for (const row of [0, 40]) rows.fill(0x5a, row * 481 + 1, row * 481 + 41);
  return deflateSync(rows, { level: 9 });
})();
const backRgb = (stream) => withIdat(ihdr(160, 80, 8, 2), stream);

/** A file of exactly `size` bytes: a valid front screenshot padded with a text chunk. */
function ofSize(size) {
  const base = good.length + 12 + 2; // the text chunk's frame, keyword "p" and its NUL
  return Buffer.concat([good.subarray(0, IEND_AT), text("p", "x".repeat(size - base)), good.subarray(IEND_AT)]);
}

// A palette image of the front display with `entries` colors and every pixel index 0.
const palette = (plte, { before = [], after = [], rows = zeroRows(72, 16, 8, 1) } = {}) =>
  buildPng({ header: ihdr(72, 16, 8, 3), before: [...before, ...(plte ? [pngChunk("PLTE", plte)] : [])], rows, after });

/** Offsets of the filter byte of every row in Adam7 order. */
function adam7Rows(width, height, depth, channels) {
  const starts = [];
  let at = 0;
  for (const [x, y, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    const w = Math.ceil((width - x) / dx);
    const h = Math.ceil((height - y) / dy);
    if (w <= 0 || h <= 0) continue;
    for (let r = 0; r < h; r++, at += Math.ceil((w * channels * depth) / 8) + 1) starts.push({ at, w });
  }
  return starts;
}

// 1-bit palette, one color, Adam7: the first pass has 9 pixels a row, so the second byte of its rows carries one
// pixel (the high bit) and seven padding bits. Padding set to 1 is not a pixel; read from the wrong end it would be.
const paddedPalette = (() => {
  const rows = zeroRows(72, 16, 1, 1, 1);
  for (const { at, w } of adam7Rows(72, 16, 1, 1)) if (w === 9) rows[at + 2] = 0x7f;
  return buildPng({ header: ihdr(72, 16, 1, 3, 1), before: [pngChunk("PLTE", Buffer.from([9, 9, 9]))], rows });
})();
// 8-bit palette, three colors, Adam7, every pixel 0 under the Paeth filter: read as one plain image instead of
// seven passes, the filter bytes (4) would land among the pixels.
const paethAdam7Palette = (() => {
  const rows = zeroRows(72, 16, 8, 1, 1);
  for (const { at } of adam7Rows(72, 16, 8, 1)) rows[at] = 4;
  return buildPng({ header: ihdr(72, 16, 8, 3, 1), before: [pngChunk("PLTE", Buffer.alloc(9))], rows });
})();

// [label, display, bytes, expected verdict: the rule a file breaks, "pass" or "unverified",
//  and for "unverified" files what the catalog's build does: "accept" or "reject"]
const CASES = [
  // what the catalog rejects, one file per rule
  ["larger than 2 MiB", "front", buildPng({ ...rgb(), before: [pngChunk("zzZz", Buffer.alloc(MIB2))] }), "too-large"],
  ["2 MiB and one byte", "front", ofSize(MIB2 + 1), "too-large"],
  ["not a PNG", "front", Buffer.from("GIF89a\x48\x00\x10\x00"), "not-png"],
  ["empty file", "front", Buffer.alloc(0), "not-png"],
  ["cut off in the image data", "front", good.subarray(0, idatAt + 20), "truncated-chunk"],
  ["cut off before IEND", "front", good.subarray(0, IEND_AT), "incomplete"],
  ["cut off inside IEND", "front", good.subarray(0, good.length - 4), "incomplete"],
  ["a bad CRC in IDAT", "front", flip(good, idatAt + 10), "checksum"],
  ["a bad CRC in IHDR", "front", flip(good, 8 + 21), "checksum"],
  ["a bad CRC in IEND", "front", flip(good, good.length - 1), "checksum"],
  ["a bad CRC in an ancillary chunk", "front", (() => { const f = buildPng({ ...rgb(), before: [text("a", "b")] }); return flip(f, 33 + 12 + 2); })(), "checksum"],
  ["a chunk before IHDR", "front", Buffer.concat([SIGNATURE, text("a", "b"), good.subarray(8)]), "header-missing"],
  ["a short IHDR", "front", Buffer.concat([SIGNATURE, pngChunk("IHDR", Buffer.alloc(12)), good.subarray(33)]), "header-missing"],
  ["a second IHDR", "front", buildPng({ ...rgb(), before: [ihdr(72, 16, 8, 2)] }), "header-duplicate"],
  ["73×16", "front", buildPng({ header: ihdr(73, 16, 8, 2), rows: zeroRows(73, 16, 8, 3) }), "dimensions"],
  ["16×72", "front", buildPng({ header: ihdr(16, 72, 8, 2), rows: zeroRows(16, 72, 8, 3) }), "dimensions"],
  ["a back screenshot offered as a front one", "front", goodBack, "dimensions"],
  ["a front screenshot offered as a back one", "back", good, "dimensions"],
  ["160×81", "back", buildPng({ header: ihdr(160, 81, 8, 0), rows: zeroRows(160, 81, 8, 1) }), "dimensions"],
  ["color type 1", "front", buildPng({ header: ihdr(72, 16, 8, 1), rows: zeroRows(72, 16, 8, 3) }), "header-unsupported"],
  ["RGB at 4 bits", "front", buildPng({ header: ihdr(72, 16, 4, 2), rows: zeroRows(72, 16, 4, 3) }), "header-unsupported"],
  ["interlace method 2", "front", buildPng({ header: ihdr(72, 16, 8, 2, 2), rows: zeroRows(72, 16, 8, 3) }), "header-unsupported"],
  ["16-bit RGB", "front", buildPng({ header: ihdr(72, 16, 16, 2), rows: zeroRows(72, 16, 16, 3) }), "bit-depth-16"],
  ["16-bit gray", "back", buildPng({ header: ihdr(160, 80, 16, 0), rows: zeroRows(160, 80, 16, 1) }), "bit-depth-16"],
  ["bytes after IEND", "front", Buffer.concat([good, Buffer.from([0])]), "ending"],
  ["a chunk after IEND", "front", Buffer.concat([good, text("a", "b")]), "ending"],
  ["IEND with data", "front", Buffer.concat([good.subarray(0, IEND_AT), pngChunk("IEND", Buffer.from([0]))]), "ending"],
  ["no IDAT", "front", Buffer.concat([SIGNATURE, ihdr(72, 16, 8, 2), pngChunk("IEND")]), "incomplete"],
  ["a palette image without PLTE", "front", palette(null), "palette-missing"],
  ["4-bit gray with tRNS", "back", buildPng({ header: ihdr(160, 80, 4, 0), before: [pngChunk("tRNS", Buffer.from([0, 0]))], rows: zeroRows(160, 80, 4, 1) }), "gray-transparency"],
  ["image data that is not zlib", "front", rawIdat(Buffer.from("not zlib at all")), "compressed-data"],
  ["image data with a bad zlib checksum", "front", rawIdat(flip(deflated, deflated.length - 1)), "compressed-data"],
  ["image data cut off", "front", rawIdat(deflated.subarray(0, deflated.length - 2)), "image-data"],
  ["empty image data", "front", rawIdat(Buffer.alloc(0)), "image-data"],
  ["bytes after the image data", "front", rawIdat(Buffer.concat([deflated, Buffer.from([0])])), "image-data"],
  ["image data of 1 MiB and one byte", "front", rawIdat(deflateSync(Buffer.alloc(MAX_DECOMPRESSED + 1))), "image-data"],
  ["image data past 1 MiB with a bad zlib checksum", "front", rawIdat((() => { const z = deflateSync(Buffer.alloc(MAX_DECOMPRESSED + 2)); return flip(z, z.length - 1); })()), "image-data"],
  ["image data of exactly 1 MiB", "front", rawIdat(deflateSync(Buffer.alloc(MAX_DECOMPRESSED))), "data-length"],
  ["filter type 5", "front", buildPng(rgb(Buffer.from(zeroRows(72, 16, 8, 3)).fill(5, 217, 218))), "scanline"],
  ["a row too few", "front", buildPng(rgb(zeroRows(72, 15, 8, 3))), "scanline"],
  ["a byte too many", "front", buildPng(rgb(Buffer.concat([zeroRows(72, 16, 8, 3), Buffer.from([0])]))), "data-length"],

  // what passes both stages
  ["the encoder's front file", "front", good, "pass"],
  ["the encoder's back file", "back", goodBack, "pass"],
  ["exactly 2 MiB", "front", ofSize(MIB2), "pass"],
  ["a zlib header declaring a 256-byte window", "back", backRgb(declareWindow(farMatch, 0)), "pass"],
  ["a zlib header declaring a 16 KiB window", "back", backRgb(declareWindow(farMatch, 6)), "pass"],
  ["a zlib header declaring a 32 KiB window", "back", backRgb(declareWindow(farMatch, 7)), "pass"],
  ["Adam7 interlace", "front", buildPng({ header: ihdr(72, 16, 8, 2, 1), rows: zeroRows(72, 16, 8, 3, 1) }), "pass"],
  ["Adam7 interlace, back", "back", buildPng({ header: ihdr(160, 80, 8, 0, 1), rows: zeroRows(160, 80, 8, 1, 1) }), "pass"],
  ["a text chunk", "front", buildPng({ ...rgb(), before: [text("Software", "test")] }), "pass"],
  ["a time chunk", "front", buildPng({ ...rgb(), after: [pngChunk("tIME", Buffer.from([7, 234, 11, 10, 12, 0, 0]))] }), "pass"],
  ["IDAT in two chunks", "front", withIdat(ihdr(72, 16, 8, 2), deflated.subarray(0, 9), deflated.subarray(9)), "pass"],
  ["8-bit RGBA", "front", buildPng({ header: ihdr(72, 16, 8, 6), rows: zeroRows(72, 16, 8, 4) }), "pass"],
  ["4-bit gray", "back", buildPng({ header: ihdr(160, 80, 4, 0), rows: zeroRows(160, 80, 4, 1) }), "pass"],
  ["8-bit gray with tRNS", "back", buildPng({ header: ihdr(160, 80, 8, 0), before: [pngChunk("tRNS", Buffer.from([0, 0]))], rows: zeroRows(160, 80, 8, 1) }), "pass-with-note"],
  ["RGB with a transparency key", "front", buildPng({ ...rgb(), before: [pngChunk("tRNS", Buffer.alloc(6))] }), "pass-with-note"],
  // the key is 16 bits a sample; the catalog's image library matches its low byte (here 0, 0, 0) with the pixels
  ["RGB with a transparency key above 255", "front", buildPng({ ...rgb(), before: [pngChunk("tRNS", Buffer.from([1, 0, 0, 0, 0, 0]))] }), "pass-with-note"],
  ["8-bit gray with a transparency key above 255", "back", buildPng({ header: ihdr(160, 80, 8, 0), before: [pngChunk("tRNS", Buffer.from([0xff, 0]))], rows: zeroRows(160, 80, 8, 1) }), "pass-with-note"],
  ["an 8-bit palette image", "front", palette(Buffer.from([1, 2, 3])), "pass"],

  // what passes the manifest-stage rules but is outside what the checker vouches for at the build stage
  ["an unknown critical chunk", "front", buildPng({ ...rgb(), before: [pngChunk("ABCD", Buffer.from("x"))] }), "unverified", "accept"],
  ["a chunk between two IDAT chunks", "front", Buffer.concat([SIGNATURE, ihdr(72, 16, 8, 2), pngChunk("IDAT", deflated.subarray(0, 9)), text("a", "b"), pngChunk("IDAT", deflated.subarray(9)), pngChunk("IEND")]), "unverified", "reject"],
  ["pHYs of 0 bytes", "front", buildPng({ ...rgb(), before: [pngChunk("pHYs")] }), "unverified", "reject"],
  ["sRGB of 0 bytes", "front", buildPng({ ...rgb(), before: [pngChunk("sRGB")] }), "unverified", "reject"],
  ["gAMA of 1 byte", "front", buildPng({ ...rgb(), before: [pngChunk("gAMA", Buffer.from([1]))] }), "unverified", "reject"],
  ["cHRM of 4 bytes after the image data", "front", buildPng({ ...rgb(), after: [pngChunk("cHRM", Buffer.alloc(4))] }), "unverified", "accept"],
  ["8-bit gray with a tRNS of 1 byte", "front", buildPng({ header: ihdr(72, 16, 8, 0), before: [pngChunk("tRNS", Buffer.from([0]))], rows: zeroRows(72, 16, 8, 1) }), "unverified", "reject"],
  ["iCCP with compression method 1", "front", buildPng({ ...rgb(), before: [pngChunk("iCCP", Buffer.from("icc\0\x01x"))] }), "unverified", "reject"],
  ["zTXt with compression method 1", "front", buildPng({ ...rgb(), before: [pngChunk("zTXt", Buffer.from("key\0\x01x"))] }), "unverified", "reject"],
  ["zTXt inflating past 1 MiB", "front", buildPng({ ...rgb(), before: [pngChunk("zTXt", Buffer.concat([Buffer.from("key\0\0"), deflateSync(Buffer.alloc(MIB2))]))] }), "unverified", "reject"],
  ["fdAT of 0 bytes", "front", buildPng({ ...rgb(), before: [pngChunk("fdAT")] }), "unverified", "reject"],
  ["acTL of 1 byte", "front", buildPng({ ...rgb(), before: [pngChunk("acTL", Buffer.from([1]))] }), "unverified", "reject"],
  ["a chunk type of four zero bytes", "front", buildPng({ ...rgb(), before: [pngChunk("\0\0\0\0")] }), "unverified", "reject"],
  ["PLTE after the image data", "front", palette(null, { after: [pngChunk("PLTE", Buffer.from([1, 2, 3]))] }), "unverified", "reject"],
  ["PLTE of 4 bytes", "front", palette(Buffer.from([1, 2, 3, 4])), "unverified", "accept"],
  ["PLTE of 257 colors", "front", palette(Buffer.alloc(771)), "unverified", "reject"],
  ["PLTE of 0 bytes", "front", palette(Buffer.alloc(0)), "unverified", "reject"],
  ["tRNS of 257 entries", "front", buildPng({ header: ihdr(72, 16, 8, 3), before: [pngChunk("PLTE", Buffer.alloc(768)), pngChunk("tRNS", Buffer.alloc(257))], rows: zeroRows(72, 16, 8, 1) }), "unverified", "reject"],
  ["tEXt keyword bbox", "front", buildPng({ header: ihdr(72, 16, 8, 0), before: [text("bbox", "1")], rows: zeroRows(72, 16, 8, 1) }), "unverified", "reject"],
  ["tEXt keyword interlace", "front", buildPng({ ...rgb(), before: [text("interlace", "1")] }), "unverified", "reject"],
  ["tEXt keyword transparency", "front", buildPng({ ...rgb(), before: [text("transparency", "1")] }), "unverified", "reject"],
  ["iTXt keyword transparency after the image data", "front", buildPng({ ...rgb(), after: [pngChunk("iTXt", Buffer.from("transparency\0\0\0\0\0x"))] }), "unverified", "reject"],
  ["tEXt keyword transparency in a palette image", "front", palette(Buffer.from([1, 2, 3]), { before: [text("transparency", "1")] }), "unverified", "reject"],
  ["tEXt keyword Transparency (other case)", "front", buildPng({ ...rgb(), before: [text("Transparency", "1")] }), "pass"],
  ["padding bits after the last pixel of a 1-bit palette row", "front", paddedPalette, "pass"],
  ["an Adam7 palette image filtered with Paeth", "front", paethAdam7Palette, "pass"],
  ["bKGD in RGB", "front", buildPng({ ...rgb(), before: [pngChunk("bKGD", Buffer.from([0, 255, 0, 255, 0, 255]))] }), "pass"],
  ["bKGD in 8-bit gray", "back", buildPng({ header: ihdr(160, 80, 8, 0), before: [pngChunk("bKGD", Buffer.from([0, 255]))], rows: zeroRows(160, 80, 8, 1) }), "pass"],
  ["bKGD in a palette image", "front", buildPng({ header: ihdr(72, 16, 8, 3), before: [pngChunk("PLTE", Buffer.alloc(6)), pngChunk("bKGD", Buffer.from([1]))], rows: zeroRows(72, 16, 8, 1) }), "pass"],
  ["bKGD of the wrong length", "front", buildPng({ ...rgb(), before: [pngChunk("bKGD", Buffer.from([0, 255]))] }), "unverified", "accept"],
  ["bKGD naming no color of the palette", "front", buildPng({ header: ihdr(72, 16, 8, 3), before: [pngChunk("PLTE", Buffer.alloc(6)), pngChunk("bKGD", Buffer.from([2]))], rows: zeroRows(72, 16, 8, 1) }), "unverified", "accept"],
  ["bKGD after the image data", "front", buildPng({ ...rgb(), after: [pngChunk("bKGD", Buffer.alloc(6))] }), "unverified", "accept"],
  ["cICP for Display P3", "front", buildPng({ ...rgb(), before: [pngChunk("cICP", Buffer.from([12, 13, 0, 1]))] }), "pass"],
  ["cICP of 3 bytes", "front", buildPng({ ...rgb(), before: [pngChunk("cICP", Buffer.from([12, 13, 0]))] }), "unverified", "accept"],
  ["cICP with a non-RGB matrix", "front", buildPng({ ...rgb(), before: [pngChunk("cICP", Buffer.from([12, 13, 1, 1]))] }), "unverified", "accept"],
  ["cICP after the image data", "front", buildPng({ ...rgb(), after: [pngChunk("cICP", Buffer.from([12, 13, 0, 1]))] }), "unverified", "accept"],
  ["a palette index equal to the number of colors", "front", palette(Buffer.alloc(6), { rows: Buffer.from(zeroRows(72, 16, 8, 1)).fill(2, 1, 2) }), "unverified", "reject"],
  ["the highest palette index inside the palette", "front", palette(Buffer.alloc(6), { rows: Buffer.from(zeroRows(72, 16, 8, 1)).fill(1, 1, 73) }), "pass"],
  ["a palette index out of range only after the Up filter", "front", palette(Buffer.alloc(6), { rows: (() => { const r = Buffer.from(zeroRows(72, 16, 8, 1)).fill(1, 1, 73); r[73] = 2; r[74] = 1; return r; })() }), "unverified", "reject"],
  ["iCCP with method 1 and a valid stream", "front", buildPng({ ...rgb(), before: [pngChunk("iCCP", Buffer.concat([Buffer.from("icc\0\x01"), deflateSync(Buffer.alloc(100))]))] }), "unverified", "reject"],
  ["iCCP of exactly 1 MiB", "front", buildPng({ ...rgb(), before: [pngChunk("iCCP", Buffer.concat([Buffer.from("icc\0\0"), deflateSync(Buffer.alloc(MAX_DECOMPRESSED))]))] }), "pass"],
  ["iCCP of 1 MiB and one byte", "front", buildPng({ ...rgb(), before: [pngChunk("iCCP", Buffer.concat([Buffer.from("icc\0\0"), deflateSync(Buffer.alloc(MAX_DECOMPRESSED + 1))]))] }), "unverified", "reject"],
  ["a palette index outside the palette", "front", palette(Buffer.from([1, 2, 3]), { rows: Buffer.from(zeroRows(72, 16, 8, 1)).fill(5, 1, 73) }), "unverified", "reject"],
];

function expectVerdict(label, display, bytes, expected) {
  const verdict = checkCatalogPng(bytes, display);
  const rule = CATALOG_PNG_RULES[display];
  if (expected === "pass" || expected === "pass-with-note") {
    assert.equal(verdict.verdict, "pass", `${label}: ${verdict.message}`);
    if (expected === "pass") assert.deepEqual(verdict, { verdict: "pass" }, label);
    else assert.match(verdict.note, /^The file marks (gray level \d+|#[0-9A-F]{6}) as transparent/, label);
  } else if (expected === "unverified") {
    assert.equal(verdict.verdict, "unverified", `${label}: ${verdict.verdict} ${verdict.reason}`);
    assert.equal(verdict.id, rule.finalId, label);
    assert.match(verdict.message, /may refuse to re-save it/, label);
  } else {
    assert.equal(verdict.verdict, "fail", `${label}: ${verdict.verdict}`);
    assert.equal(verdict.reason, expected, `${label}: ${verdict.reason}`);
    assert.equal(verdict.id, rule.id, label);
    assert.match(verdict.message, /^The file .+\. Save it as an 8-bit PNG of exactly \d+×\d+ pixels\.$/, label);
  }
}

test("each file gets the verdict the catalog's rules give it, with the catalog's check id", () => {
  const wrong = [];
  for (const [label, display, bytes, expected] of CASES) {
    try {
      expectVerdict(label, display, bytes, expected);
    } catch (error) {
      wrong.push(error.message.split("\n")[0]);
    }
  }
  assert.deepEqual(wrong, []);
});

test("the rules were derived from the commit the registry snapshot names", () => {
  assert.equal(
    REGISTRY.source.commit,
    RULES_COMMIT,
    `readiness/catalog-registry.json names catalog commit ${REGISTRY.source.commit}, but catalog-png.mjs was ported from ` +
      `${RULES_COMMIT}. Re-derive the rules from tools/check_png.py and tools/lib_png.py at the new commit, update ` +
      "catalog-png.mjs and RULES_COMMIT, and run these tests with BUSY_CATALOG_CHECKOUT set.",
  );
});

test("the ids and sizes are the ones in the registry snapshot", () => {
  const checks = new Map(REGISTRY.checks.map((c) => [c.id, c]));
  for (const [display, rule] of Object.entries(CATALOG_PNG_RULES)) {
    for (const id of [rule.id, rule.finalId]) {
      assert.ok(checks.has(id), `${id} is in the registry`);
      assert.equal(checks.get(id).stage, "build", id);
      assert.equal(checks.get(id).severity, "blocking", id);
      assert.ok(checks.get(id).problem.includes(`${rule.width}×${rule.height}`), `${id} names ${rule.width}×${rule.height}`);
    }
    assert.equal(rule.width, SCREENS[display].width);
    assert.equal(rule.height, SCREENS[display].height);
  }
});

test("the checker reads the bytes it is given, whatever buffer holds them", () => {
  const padded = new Uint8Array(good.length + 10);
  padded.set(good, 5);
  assert.deepEqual(checkCatalogPng(padded.subarray(5, 5 + good.length), "front"), { verdict: "pass" });
  assert.equal(checkCatalogPng(padded.subarray(5, 6 + good.length), "front").reason, "ending");
  assert.throws(() => checkCatalogPng(good, "side"), /Unknown display "side"/);
  assert.throws(() => checkCatalogPng("png", "front"), TypeError);
});

// A zlib stream of 1 GiB of zeros built from 1 MiB pieces, so the test itself never holds the 1 GiB.
function gibibyteOfZeros() {
  const piece = deflateRawSync(Buffer.alloc(1024 * 1024), { finishFlush: constants.Z_FULL_FLUSH });
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE((((2 ** 30) % 65521) * 65536 + 1) >>> 0);
  return Buffer.concat([Buffer.from([0x78, 0xda]), ...Array(1024).fill(piece), Buffer.from([0x03, 0x00]), adler]);
}

test("the 1 MiB limit holds while inflating, not after", () => {
  const bomb = rawIdat(gibibyteOfZeros());
  assert.ok(bomb.length < MIB2, `the file is ${bomb.length} bytes`);
  const before = process.resourceUsage().maxRSS;
  assert.equal(checkCatalogPng(bomb, "front").reason, "image-data");
  const grown = (process.resourceUsage().maxRSS - before) / 1024; // MiB
  assert.ok(grown < 256, `inflating took ${grown.toFixed(0)} MiB more memory`);
});

// Words of the catalog's detail for each rule, so a failure for another reason under the same id does not pass.
const DETAIL = {
  "too-large": /larger than 2 MiB/,
  "not-png": /not a PNG file/,
  "truncated-chunk": /Truncated/,
  checksum: /checksum/,
  "header-missing": /header missing/,
  "header-duplicate": /Duplicate/,
  dimensions: /expected \d+×\d+/,
  "header-unsupported": /Unsupported/,
  "bit-depth-16": /16 bits/,
  ending: /ending/,
  incomplete: /Incomplete/,
  "palette-missing": /Palette/,
  "gray-transparency": /transparency/,
  "compressed-data": /Invalid compressed/,
  "image-data": /oversized/,
  scanline: /scanline/,
  "data-length": /length/,
};

function expectCatalog(label, display, r, expected, build) {
  const rule = CATALOG_PNG_RULES[display];
  if (expected === "pass" || expected === "pass-with-note") {
    assert.equal(r.id, null, `${label}: the catalog says ${r.id} ${r.detail}`);
    assert.equal(r.stage, "build", `${label}: passes the build stage too`);
  } else if (expected === "unverified") {
    assert.equal(r.stage, "build", `${label}: passes the catalog's manifest stage`);
    if (build === "accept") assert.equal(r.id, null, `${label}: the catalog's build says ${r.id} ${r.detail}`);
    else assert.equal(r.id, rule.finalId, `${label}: the catalog's build says ${r.id}`);
  } else {
    assert.equal(r.id, rule.id, `${label}: the catalog says ${r.id}`);
    assert.match(r.detail, DETAIL[expected], `${label}: the catalog's detail "${r.detail}"`);
  }
}

test("the catalog's own checker gives the same verdict for every file", (t) => {
  const catalog = catalogChecker();
  if (catalog.skip) return t.skip(catalog.skip);
  if (!catalog.pillow) return t.skip("Pillow is not installed: the catalog's build stage cannot run");
  const results = catalog.run(writeFiles(tempDir(t), CASES.map(([, display, bytes], i) => [display, `case-${i}.png`, bytes])));
  assert.equal(results.length, CASES.length);
  for (const [i, [label, display, , expected, build]] of CASES.entries()) expectCatalog(label, display, results[i], expected, build);
  t.diagnostic(`${catalog.versions}; ${CASES.length} files`);
});

// Every kind of file the checker calls "pass": each color type and bit depth, with and without interlace, on both
// displays, with arbitrary pixels, alone and with each chunk the build stage vouches for, before and after the image.
function vouchedFiles() {
  let seed = 12345;
  const random = (n) => {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
    return out;
  };
  const randomRows = (width, height, depth, channels, interlace) => {
    const rows = zeroRows(width, height, depth, channels, interlace);
    const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
    let at = 0;
    for (const [x, y, dx, dy] of passes) {
      const w = Math.ceil((width - x) / dx);
      const h = Math.ceil((height - y) / dy);
      if (w <= 0 || h <= 0) continue;
      const size = Math.ceil((w * channels * depth) / 8);
      for (let r = 0; r < h; r++, at += size + 1) {
        rows[at] = r % 5; // every filter type
        random(size).copy(rows, at + 1);
      }
    }
    return rows;
  };
  const icc = pngChunk("iCCP", Buffer.concat([Buffer.from("sRGB IEC61966-2.1\0\0"), deflateSync(random(3144))]));
  const extras = [
    [],
    [pngChunk("pHYs", Buffer.from([0, 0, 11, 19, 0, 0, 11, 19, 1]))],
    [pngChunk("gAMA", Buffer.from([0, 0, 177, 143]))],
    [pngChunk("cHRM", random(32))],
    [pngChunk("sRGB", Buffer.from([0]))],
    [pngChunk("tIME", Buffer.from([7, 234, 11, 10, 12, 0, 0]))],
    [text("Software", "an editor"), text("Comment", "")],
    [pngChunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"))],
    [pngChunk("eXIf", random(40))],
    [pngChunk("cICP", Buffer.from([12, 13, 0, 1]))],
  ];
  const formats = [[0, 1], [0, 2], [0, 4], [0, 8], [2, 8], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [6, 8]];
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const files = [];
  for (const display of ["front", "back"]) {
    const { width, height } = SCREENS[display];
    for (const [color, depth] of formats) {
      for (const interlace of [0, 1]) {
        const rows = randomRows(width, height, depth, channels[color], interlace);
        const head = [];
        if (color === 3) head.push(pngChunk("PLTE", random(3 * 2 ** depth)), pngChunk("tRNS", random(2 ** depth)));
        if (color === 0 && depth === 8) head.push(pngChunk("tRNS", Buffer.from([0, 7])));
        if (color === 2) head.push(pngChunk("tRNS", Buffer.from([0, 1, 0, 2, 0, 3])));
        head.push(pngChunk("bKGD", color === 3 ? Buffer.from([2 ** depth - 1]) : color === 2 || color === 6 ? Buffer.from([0, 255, 0, 255, 0, 255]) : Buffer.from([0, 1])));
        for (const [n, extra] of extras.entries()) {
          const cicp = extra[0]?.subarray(4, 8).toString("latin1") === "cICP";
          const where = cicp ? { before: [...extra, ...head] } : n % 2 ? { before: [...head, ...extra] } : { before: head, after: extra };
          files.push([display, `${display}-c${color}d${depth}i${interlace}-x${n}`, buildPng({ header: ihdr(width, height, depth, color, interlace), rows, ...where })]);
        }
        files.push([display, `${display}-c${color}d${depth}i${interlace}-icc`, buildPng({ header: ihdr(width, height, depth, color, interlace), before: [icc, ...head], rows })]);
      }
    }
  }
  return files;
}

test("every kind of file the checker calls pass passes the catalog's build stage", (t) => {
  const files = vouchedFiles();
  // grayscale (8-bit) and RGB files carry a transparency key, so their pass comes with a note
  const keyed = (label) => (/-c0d8|-c2d8/.test(label) ? "pass-with-note" : "pass");
  for (const [display, label, bytes] of files) expectVerdict(label, display, bytes, keyed(label));
  const catalog = catalogChecker();
  if (catalog.skip) return t.skip(catalog.skip);
  if (!catalog.pillow) return t.skip("Pillow is not installed: the catalog's build stage cannot run");
  const dir = tempDir(t);
  for (let i = 0; i < files.length; i += 100) {
    const part = files.slice(i, i + 100);
    const results = catalog.run(writeFiles(dir, part.map(([display, label, bytes]) => [display, `${label}.png`, bytes])));
    for (const [j, [display, label]] of part.entries()) expectCatalog(label, display, results[j], "pass");
  }
  t.diagnostic(`${catalog.versions}; ${files.length} files`);
});

// ---------------------------------------------------------------- the encoder's files

test("the encoder's files pass the catalog's rules, with no note", () => {
  for (const [name, label, frame] of EDGE_FRAMES) assert.deepEqual(checkCatalogPng(encodeScreenPng(name, frame), name), { verdict: "pass" }, label);
});

test("the catalog's own checker accepts the encoder's files and keeps their pixels when it re-saves them", (t) => {
  const catalog = catalogChecker();
  if (catalog.skip) return t.skip(catalog.skip);
  const dir = tempDir(t);
  const files = writeFiles(dir, EDGE_FRAMES.map(([name, label, frame]) => [name, `${label}.png`, encodeScreenPng(name, frame)]));
  const results = catalog.run(files);
  assert.equal(results.length, EDGE_FRAMES.length);
  for (const [i, [name, label, frame]] of EDGE_FRAMES.entries()) {
    const r = results[i];
    assert.equal(r.id, null, `${label}: ${r.id} ${r.detail}`);
    if (!catalog.pillow) continue;
    assert.equal(r.stage, "build", label);
    assert.equal(r.mode, "RGBA", label);
    const { width, height } = SCREENS[name];
    const want = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) want.set([...framePixel(name, frame, x, y), 255], (y * width + x) * 4);
    }
    assert.equal(r.rgba, want.toString("hex"), `${label}: the catalog's re-saved pixels`);
  }
  t.diagnostic(catalog.versions);
  if (!catalog.pillow) t.diagnostic("Pillow is not installed: only the catalog's manifest-stage check ran");
});

// ---------------------------------------------------------------- the transparency note

// Files with a transparency key whose pixels hold every 8-bit value, so that whatever color the key names is there:
// [label, display, file, the color the note must name as [R, G, B]]. The keys above 255 are the case the catalog's
// image library reads by their low byte.
function keyedFiles() {
  const grayRows = (width, height) => {
    const rows = zeroRows(width, height, 8, 1);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = (y * width + x) & 0xff;
    return rows;
  };
  const rgbRows = () => {
    const rows = zeroRows(72, 16, 8, 3);
    for (let i = 0; i < 72 * 16; i++) rows.set([i & 0xff, (i + 2) & 0xff, (i + 255) & 0xff], Math.floor(i / 72) * 217 + 1 + (i % 72) * 3);
    return rows;
  };
  const key = (...samples) => Buffer.from(samples.flatMap((v) => [v >> 8, v & 0xff]));
  const files = [];
  for (const k of [0x0000, 0x0007, 0x00ff, 0x0100, 0x0107, 0x01ff, 0xff07, 0xffff]) {
    files.push([`back gray key 0x${k.toString(16)}`, "back", buildPng({ header: ihdr(160, 80, 8, 0), before: [pngChunk("tRNS", key(k))], rows: grayRows(160, 80) }), [k & 0xff, k & 0xff, k & 0xff]]);
    files.push([`front gray key 0x${k.toString(16)}`, "front", buildPng({ header: ihdr(72, 16, 8, 0), before: [pngChunk("tRNS", key(k))], rows: grayRows(72, 16) }), [k & 0xff, k & 0xff, k & 0xff]]);
  }
  // pixel i of the RGB file is (i, i + 2, i - 1) by its low bytes, so these keys name pixels 0, 7 and 200
  for (const [r, g, b] of [[0, 2, 255], [0x0100, 0x0102, 0x01ff], [7, 9, 6], [0xff07, 0x0109, 0x8006], [0x00c8, 0x00ca, 0x00c7], [0xabc8, 0xcdca, 0xefc7]]) {
    files.push([`front RGB key ${[r, g, b].map((v) => `0x${v.toString(16)}`).join(" ")}`, "front", buildPng({ header: ihdr(72, 16, 8, 2), before: [pngChunk("tRNS", key(r, g, b))], rows: rgbRows() }), [r & 0xff, g & 0xff, b & 0xff]]);
  }
  return files;
}

/** The color a transparency note names, as [R, G, B]. */
function noteColor(note) {
  const gray = /^The file marks gray level (\d+) as transparent/.exec(note);
  if (gray) return [Number(gray[1]), Number(gray[1]), Number(gray[1])];
  const rgbKey = /^The file marks #([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2}) as transparent/.exec(note);
  assert.ok(rgbKey, `a note that names a color: ${note}`);
  return rgbKey.slice(1).map((h) => parseInt(h, 16));
}

test("the transparency note names the key's low byte, which a key above 255 has too", () => {
  for (const [label, display, bytes, color] of keyedFiles()) {
    const verdict = checkCatalogPng(bytes, display);
    assert.equal(verdict.verdict, "pass", label);
    assert.deepEqual(noteColor(verdict.note), color, label);
  }
});

test("the color the note names is exactly the color the catalog's re-save makes transparent", (t) => {
  const catalog = catalogChecker();
  if (catalog.skip) return t.skip(catalog.skip);
  if (!catalog.pillow) return t.skip("Pillow is not installed: the catalog's build stage cannot run");
  const files = keyedFiles();
  const results = catalog.run(writeFiles(tempDir(t), files.map(([, display, bytes], i) => [display, `keyed-${i}.png`, bytes])));
  for (const [i, [label, display, bytes]] of files.entries()) {
    const r = results[i];
    assert.equal(r.id, null, `${label}: the catalog says ${r.id} ${r.detail}`);
    const named = noteColor(checkCatalogPng(bytes, display).note).join();
    const rgba = Buffer.from(r.rgba, "hex");
    let transparent = 0;
    for (let p = 0; p < rgba.length; p += 4) {
      const same = [rgba[p], rgba[p + 1], rgba[p + 2]].join() === named;
      assert.equal(rgba[p + 3], same ? 0 : 255, `${label}: pixel ${p / 4} is ${[...rgba.subarray(p, p + 4)]}, the note names ${named}`);
      if (same) transparent++;
    }
    assert.ok(transparent > 0, `${label}: some pixel has the color the note names`);
  }
  t.diagnostic(`${catalog.versions}; ${files.length} files`);
});
