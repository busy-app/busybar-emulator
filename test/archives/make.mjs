// Makes the app archives that install.test.mjs installs: node emulator/test/archives/make.mjs [--macos]
//
// Every archive comes out byte for byte the same on every run: fixed times, owner "user"/"group" with id 0, and gzip
// from Node with a fixed header (for --macos: on a Mac like the one that made them — where the system does not put
// com.apple.provenance on files, or the umask differs, the "._" files' sizes and the modes come out otherwise).
// Nothing of the machine that made them is in them. A bar on firmware 1.3.1 staged these archives on 10.11.2026, and
// bar-stage-1.3.1.json and bar-stage-1.3.1-more.json are what it answered: an archive whose entries change here has
// to be staged on a bar again.
// - Without flags, the archives built here byte by byte are written: a GNU-format archive ("ustar  " magic and a GNU
//   long name entry 'L' for a name over 100 bytes), hostile names and entry types, and broken archives.
// - With --macos (on macOS only), the three archives from the system tar are remade as well, packed as busy-cli build
//   packs an app (packages/cli/src/lib/build.ts: tar -czf <archive> -C <dist> <id>), with extended attributes on the
//   files so that tar adds AppleDouble "._*" files and PAX headers:
//   - bar-probe-appledouble.tgz: the same entries, in the same order, of the same types and sizes, as the archive that
//     was installed on a bar on 10.11.2026 (reports/EMU-223-bar/probe.tgz in the work folder, SHA-256 in
//     install.test.mjs), so that the bar's listing is the expected result; it is a rebuild, not that file;
//   - macos-appledouble.tgz, and macos-clean.tgz with COPYFILE_DISABLE=1 (PAX headers, no "._*").
//   macOS puts its com.apple.provenance attribute on every file a process makes, and its value identifies the machine;
//   it cannot be removed. It is overwritten here with filler of the same length, in the PAX records (raw and base64)
//   and inside the AppleDouble files, so the entry sizes and header checksums stay as tar made them.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { commandLine } from "../../packages/server/arguments.mjs";

await commandLine(process.argv, { flags: ["--macos"] });

const here = dirname(fileURLToPath(import.meta.url));
const MTIME = 1794355200; // 2026-11-11 00:00 UTC

const manifest = (id, extra = {}) =>
  JSON.stringify({ format_version: 1, id, name: "Fixture", version: "1.0.0", api_version: "27.12.0", ...extra }) + "\n";
const MAIN = 'console.log("fixture");\n';

// ---------------------------------------------------------------- hand-built tar

function header(name, { size = 0, type = "0", linkname = "", gnu = false, prefix = "" } = {}) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write(type === "5" ? "0000755\0" : "0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(MTIME.toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  if (gnu) h.write("ustar  \0", 257);
  else h.write("ustar\x0000", 257);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** entries: [name, content | null for a folder, options]; returns the uncompressed tar with its end record. */
function tar(entries, { end = true } = {}) {
  const blocks = [];
  for (const [name, content, options = {}] of entries) {
    if (content === null) {
      blocks.push(header(name, { type: "5", ...options }));
      continue;
    }
    const data = Buffer.from(content);
    blocks.push(header(name, { size: data.length, ...options }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  if (end) blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const app = (id, more = []) => [
  [`${id}/`, null],
  [`${id}/appmeta/`, null],
  [`${id}/scripts/`, null],
  [`${id}/appmeta/manifest.json`, manifest(id)],
  [`${id}/scripts/main.js`, MAIN],
  ...more,
];

const write = (file, bytes) => {
  writeFileSync(join(here, file), bytes);
  console.log(`${file}: ${bytes.length} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`);
};
// gzip from Node: no name and time 0 in the header; the OS byte set to 3 (Unix) on every system.
const tgz = (bytes) => {
  const gz = gzipSync(bytes, { level: 9 });
  gz[9] = 3;
  return gz;
};

// ---------------------------------------------------------------- the system tar of macOS (--macos)

/** Overwrites the value of com.apple.provenance with filler of the same length wherever tar put it. */
function scrubProvenance(raw) {
  const tarBytes = Buffer.from(raw);
  const text = tarBytes.toString("latin1");
  const values = new Set();
  for (const m of text.matchAll(/\d+ SCHILY\.xattr\.com\.apple\.provenance=/g)) {
    const length = Number(m[0].split(" ")[0]);
    values.add(text.slice(m.index + m[0].length, m.index + length - 1)); // the record ends with "\n"
  }
  for (const m of text.matchAll(/LIBARCHIVE\.xattr\.com\.apple\.provenance=([A-Za-z0-9+/=]+)\n/g)) values.add(m[1]);
  // The AppleDouble files hold the raw value; base64 is only in the PAX records.
  let out = text;
  for (const v of values) out = out.split(v).join(/^[A-Za-z0-9+/=]+$/.test(v) && v.length > 12 ? "A".repeat(v.length) : "\0".repeat(v.length));
  return Buffer.from(out, "latin1");
}

function systemTar(work, id, { appledouble }) {
  const { COPYFILE_DISABLE, ...env } = process.env;
  const args = ["-cf", "-", "--uid", "0", "--gid", "0", "--uname", "user", "--gname", "group", "-C", work, id];
  const raw = execFileSync("/usr/bin/tar", args, { env: appledouble ? env : { ...env, COPYFILE_DISABLE: "1" }, maxBuffer: 1 << 24 });
  return scrubProvenance(raw);
}

/** files: { "appmeta/manifest.json": text, … } under <tmp>/<id>, every file and folder with time MTIME and `attribute`. */
function onDisk(id, files, attribute) {
  const work = mkdtempSync(join(tmpdir(), "emu-archive-"));
  const paths = new Set([""]);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(work, id, dirname(name)), { recursive: true });
    writeFileSync(join(work, id, name), text);
    paths.add(name);
    for (let d = dirname(name); d !== "."; d = dirname(d)) paths.add(d);
  }
  for (const p of [...paths].sort().reverse()) {
    execFileSync("/usr/bin/xattr", ["-w", attribute, "1", join(work, id, p)]);
    utimesSync(join(work, id, p), MTIME, MTIME);
  }
  return work;
}

if (process.argv.includes("--macos")) {
  if (process.platform !== "darwin") throw new Error("--macos needs macOS: the archives come from its system tar");
  // The bar probe: the manifest (230 bytes) and main.js (30 bytes) of the archive installed on the bar.
  const probeId = "app.probe.appledouble";
  const probeFiles = {
    "appmeta/manifest.json":
      '{\n  "format_version": 1,\n  "id": "app.probe.appledouble",\n  "name": "Archive probe",\n  "version": "0.1.0",\n' +
      '  "api_version": "27.14.0",\n  "description": "Checks what the installer does with AppleDouble entries",\n  "debug": false\n}\n',
    "scripts/main.js": 'console.log("archive probe");\n',
  };
  let work = onDisk(probeId, probeFiles, "com.example.probe");
  write("bar-probe-appledouble.tgz", tgz(systemTar(work, probeId, { appledouble: true })));
  rmSync(work, { recursive: true, force: true });

  const id = "app.fixture.mac";
  work = onDisk(id, { "appmeta/manifest.json": manifest(id), "scripts/main.js": MAIN }, "com.example.fixture");
  write("macos-appledouble.tgz", tgz(systemTar(work, id, { appledouble: true })));
  write("macos-clean.tgz", tgz(systemTar(work, id, { appledouble: false })));
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------- GNU format (hand-built)

// A file name over 100 bytes: GNU writes the whole name in an 'L' entry and the first 100 bytes in the header.
const LONG = `app.fixture.gnu/scripts/${"long-name-".repeat(9)}end.js`;
write(
  "gnu-tar.tgz",
  tgz(
    tar([
      ...app("app.fixture.gnu").map(([n, c, o]) => [n, c, { ...o, gnu: true }]),
      ["././@LongLink", Buffer.from(LONG + "\0"), { type: "L", gnu: true }],
      [LONG.slice(0, 100), MAIN, { gnu: true }],
    ]),
  ),
);

// ---------------------------------------------------------------- hostile and broken archives (hand-built)

const ID = "app.fixture.hostile";
// "../" and "./" parts: FatFs on the bar has no relative paths and refuses the name, so the whole unpack fails.
write("traversal-parent.tgz", tgz(tar(app(ID, [[`${ID}/../evil.js`, "evil"]]))));
write("traversal-top.tgz", tgz(tar([["../evil.js", "evil"], ...app(ID)])));
write("traversal-dot.tgz", tgz(tar([["./", null], ...app(ID).map(([n, c]) => [`./${n}`, c])])));
// An absolute name: path_append drops the leading "/", so the file lands inside the staging folder, not in /.
write("absolute.tgz", tgz(tar([["/abs/evil.js", "evil"], ...app(ID)])));
// Links are not extracted at all (tar_archive.c: only regular files and folders).
write(
  "links.tgz",
  tgz(tar(app(ID, [[`${ID}/scripts/sym.js`, "", { type: "2", linkname: "/etc/passwd" }], [`${ID}/scripts/hard.js`, "", { type: "1", linkname: `${ID}/scripts/main.js` }]]))),
);
// A folder named "._<id>" holding an app, before the real one: it is a folder, so the installer looks in it, but its
// name is not the manifest's id, so it is not an app.
write("dot-underscore-dir.tgz", tgz(tar([...app(ID).map(([n, c]) => [`._${n}`, c]), ...app(ID)])));
write("dot-underscore-dir-only.tgz", tgz(tar(app(ID).map(([n, c]) => [`._${n}`, c]))));
// Two app folders: the first one made wins.
write("two-apps.tgz", tgz(tar([...app("app.fixture.first"), ...app("app.fixture.second")])));
// A folder that is not an app first, then the app.
write("not-app-first.tgz", tgz(tar([["notes/readme.txt", "notes"], ...app(ID)])));
// The ustar prefix field is not read: the file lands at its name field alone, at the top of the staging folder.
write("ustar-prefix.tgz", tgz(tar(app(ID, [["extra.js", MAIN, { prefix: `${ID}/scripts` }]]))));
// A file that says it is larger than the archive.
const oversized = tar(app(ID));
oversized.write((10 * 1024 * 1024).toString(8).padStart(11, "0") + "\0", 512 * 3 + 124); // the manifest's size field
{
  const h = oversized.subarray(512 * 3, 512 * 4);
  h.write("        ", 148);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
}
write("oversized-entry.tgz", tgz(oversized));
// No main.js: the folder is not an app; the bar answers "Wrong app manifest".
write("no-main.tgz", tgz(tar(app(ID).filter(([n]) => !n.endsWith("main.js")))));
// A newer API than firmware 1.3.1's 27.14.0.
write("api-newer.tgz", tgz(tar(app(ID).map(([n, c]) => [n, n.endsWith("manifest.json") ? manifest(ID, { api_version: "99.0.0" }) : c]))));
// Broken archives: a bad header checksum, a tar cut short, a gzip stream cut short, bytes that are not an archive.
const badSum = tar(app(ID));
badSum[512 * 3 + 0] ^= 0x01;
write("bad-checksum.tgz", tgz(badSum));
write("no-end-record.tgz", tgz(tar(app(ID), { end: false })));
const whole = tgz(tar(app(ID)));
write("cut-gzip.tgz", whole.subarray(0, Math.floor(whole.length / 2)));
write("not-an-archive.tgz", Buffer.from("this is not a tar archive\n".repeat(40)));
// Small archives that make a great many folders. 10 000 folder entries, each 49 levels deep (the most a 100-byte name
// holds), 490 000 folders in all (from the second review of EMU-223, where it held the server for 57 s). The emulator
// refuses them before writing; the bar would make them all.
{
  const deep = [];
  for (let i = 0; i < 10_000; i++) deep.push([`${i.toString(36).padStart(3, "0")}${"/a".repeat(48)}/`, null]);
  write("deep-folders.tgz", tgz(tar(deep)));
  // And one with shallow paths: 5 000 entries three levels deep, 15 000 folders.
  const many = [];
  for (let i = 0; i < 5_000; i++) many.push([`${i.toString(36).padStart(3, "0")}/a/b/`, null]);
  write("many-folders.tgz", tgz(tar(many)));
}
// macos-clean.tgz with one byte of the gzip CRC changed (the data intact), and with one byte changed in the middle
// of the deflate stream — the two archives a bar staged on 10.11.2026 (bar-stage-1.3.1-more.json).
{
  const clean = readFileSync(join(here, "macos-clean.tgz"));
  const badCrc = Buffer.from(clean);
  badCrc[badCrc.length - 8] ^= 0xff;
  write("gzip-bad-crc.tgz", badCrc);
  const damaged = Buffer.from(clean);
  damaged[Math.floor(damaged.length / 2)] ^= 0x55;
  write("gzip-damaged-mid.tgz", damaged);
}
