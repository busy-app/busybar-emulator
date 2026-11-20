// Names in the built package that the BUSY Bar would not unpack as named (EMU-347, ../package-names.mjs): a name
// outside ASCII, and a path over 100 bytes, written the way bsdtar writes them (a PAX header, or a ustar prefix). The
// archives are written here, byte by byte, as a packer writes them: the project's own tar writer makes plain ustar only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { loadCommands, main } from "../../cli/busy-emulator.mjs";
import { packageNameWarnings } from "../package-names.mjs";
import { readPackage } from "../package-file.mjs";
import { makeProject } from "./project-fixture.mjs";

const ID = "io.github.jane-doe.desk_clock";
// A picture named in Cyrillic, written by code point: the export keeps the source free of Cyrillic letters.
const PICTURE = String.fromCharCode(0x43a, 0x430, 0x440, 0x442, 0x438, 0x43d, 0x43a, 0x430);

function header(name, size, type, prefix = "") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(type === "5" ? "0000755\0" : "0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

const pad = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

/** One PAX record: "<length> path=<name>\n", the length counting itself. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

/** A .tgz of files (path to text) as bsdtar's ustar writer makes it: a PAX header for a name outside ASCII or one that no prefix split fits, a prefix for one that splits. */
function bsdtarLike(files) {
  const blocks = [];
  for (const [full, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const ascii = /^[\x20-\x7e]*$/.test(full);
    let name = full;
    let prefix = "";
    let pax = !ascii;
    if (Buffer.byteLength(full) > 100 && ascii) {
      pax = true;
      for (let i = full.indexOf("/"); i >= 0; i = full.indexOf("/", i + 1)) {
        if (i <= 155 && full.length - i - 1 <= 100) {
          prefix = full.slice(0, i);
          name = full.slice(i + 1);
          pax = false;
          break;
        }
      }
    }
    if (pax) {
      const record = paxRecord("path", full);
      blocks.push(header(`PaxHeader/${path.posix.basename(full)}`.slice(0, 100), record.length, "x"), pad(record));
      name = Buffer.from(full).subarray(0, 100).toString("latin1");
    }
    blocks.push(header(name, data.length, "0", prefix), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function packageOf(t, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-names-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "dist"));
  writeFileSync(path.join(dir, "dist", `${ID}.tgz`), bsdtarLike(files));
  return readPackage(dir, ID);
}

const BASE = { [`${ID}/appmeta/manifest.json`]: "{}", [`${ID}/scripts/main.js`]: "x" };

test("a name in Cyrillic warns: the packer wrote it into a PAX header, which the BUSY Bar skips", (t) => {
  const pkg = packageOf(t, { ...BASE, [`${ID}/assets/${PICTURE}.png`]: "png" });
  // The reader applies the PAX header, so the real name is seen.
  assert.ok(pkg.entries.some((entry) => entry.name === `${ID}/assets/${PICTURE}.png`));
  const warnings = packageNameWarnings(pkg);
  assert.deepEqual(warnings.map((one) => one.id), ["package_name_not_ascii"]);
  assert.deepEqual(warnings[0].found, [`${ID}/assets/${PICTURE}.png`]);
  assert.match(warnings[0].message, /outside ASCII.*PAX header, which the BUSY Bar skips/);
  assert.match(warnings[0].fix, /rename it to ASCII under 100 characters/);
});

test("a 120-character name warns: no prefix split fits it, so it goes into a PAX header", (t) => {
  const long = `${ID}/assets/${"a".repeat(120)}.png`;
  const warnings = packageNameWarnings(packageOf(t, { ...BASE, [long]: "png" }));
  assert.deepEqual(warnings.map((one) => one.id), ["package_name_too_long"]);
  assert.deepEqual(warnings[0].found, [long]);
  assert.match(warnings[0].message, /longer than 100 characters.*PAX header, which the BUSY Bar skips/);
  assert.match(warnings[0].fix, /at most 100 characters/);
});

test("a path over 100 bytes that splits at a slash warns too: the BUSY Bar does not read the ustar prefix (microtar.c:205)", (t) => {
  // 130 characters: the packer writes no PAX header (a prefix of 80 bytes and a name of 49 fit), and the BUSY Bar
  // takes the name field alone, so the folders are lost. The same path that "fits ustar" is not a path the BUSY Bar keeps.
  const split = `${ID}/assets/${"d".repeat(40)}/${"e".repeat(30)}/${"f".repeat(15)}.png`;
  assert.equal(split.length >= 100 && split.length <= 130, true);
  const long = `${split}${"g".repeat(130 - split.length)}`;
  assert.equal(long.length, 130);
  const pkg = packageOf(t, { ...BASE, [long]: "png" });
  assert.ok(pkg.entries.some((entry) => entry.name === long));
  const warnings = packageNameWarnings(pkg);
  assert.deepEqual(warnings.map((one) => one.id), ["package_name_too_long"]);
  assert.match(warnings[0].message, /ustar prefix, which the BUSY Bar does not read/);
});

test("short ASCII paths give no warning; 100 bytes is the most", (t) => {
  const exactly = `${ID}/assets/${"b".repeat(100 - `${ID}/assets/`.length)}`;
  assert.equal(exactly.length, 100);
  assert.deepEqual(packageNameWarnings(packageOf(t, { ...BASE, [exactly]: "x" })), []);
  assert.deepEqual(packageNameWarnings(packageOf(t, BASE)), []);
  assert.deepEqual(packageNameWarnings(null), []);
});

test("check --json carries the warnings in package_names; the text lists them under one header; they never fail the check", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pkg-names-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  makeProject(dir);
  writeFileSync(path.join(dir, "dist", `${ID}.tgz`), bsdtarLike({ ...BASE, [`${ID}/assets/${PICTURE}.png`]: "png" }));
  const commands = await loadCommands();
  const ctx = { platform: process.platform, kind: "release", appPath: "/x", dataDir: path.join(dir, ".data"), runStateFile: path.join(dir, ".data", "run", "emulator.json"), calledAs: ["busy-emulator"], env: {}, nodeTools: null };
  const run = async (json) => {
    const out = [];
    const err = [];
    let thrown = null;
    try {
      await main(["check", dir, ...(json ? ["--json"] : [])], { ctx, sys: { cwd: () => dir }, commands, out: (line) => out.push(line), err: (line) => err.push(line) });
    } catch (e) {
      thrown = e;
    }
    return { out: out.join("\n"), err: err.join("\n"), thrown };
  };
  const answer = JSON.parse((await run(true)).out);
  assert.deepEqual(answer.package_names.map((one) => one.id), ["package_name_not_ascii"]);
  assert.ok(!answer.failing.some((check) => check.id.startsWith("package_name")));
  const shown = await run(false);
  const text = `${shown.out}\n${shown.err}`;
  assert.equal(text.split("Names in the package").length, 2, "one header");
  assert.match(text, new RegExp(`\\nNames in the package \\(they do not fail the check\\):\\n {2}"\\S+${PICTURE}\\.png" has characters outside ASCII`));
});
