// The firmware's SETTINGS programs and their nested screens, on a bar and in the emulator: the back display after
// each step of a walk through them.
//
//   node emulator/test/settings.mjs                 an emulator of its own against the bar's saved frames (test/settings/)
//   node emulator/test/settings.mjs --firmware dev  the same on another firmware; --emu 127.0.0.1:8640 a running emulator
//   node emulator/test/settings.mjs --record        walk a connected bar (10.0.4.20) and save what it showed
//   node emulator/test/settings.mjs --only time     one walk
//   node emulator/test/settings.mjs --images        bar | emulator sheets in a folder of the system's temporary folder
//
// A walk is a list of keys of POST /api/input. "*" takes the back display's picture and it must be the emulator's;
// "~" takes one that shows the bar's own state (its network, its serial number), which is only reported.
//
// The walks change nothing on a bar: they open lists and screens that only show things, never an item that acts
// (Bluetooth, which starts pairing when opened, and Sound, where the wheel is the volume, are left out). Recording
// is guarded all the same: the emulator walks first, and before every OK the bar's picture must be the emulator's;
// if it is not, the bar is somewhere else than expected and the walk stops there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { commandLine } from "../packages/server/arguments.mjs";
import { emulatorFor, outputDir, totals } from "./own-emulator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const savedDir = join(here, "settings");
// Recordings the public repository does not carry (some show private data of the bar they were recorded on, and the
// others of the same kind are kept out with them): its export lists them here with the reason (test/unpublished.json).
// In the development repository there is no list.
const unpublishedFile = join(here, "unpublished.json");
const unpublished = existsSync(unpublishedFile) ? JSON.parse(readFileSync(unpublishedFile, "utf8")).files : {};
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--emu", "--only", "--firmware"], flags: ["--record", "--images"], emulator: "--emu" });
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const record = args.includes("--record");
const images = args.includes("--images");
const only = option("--only", null);
const bar = option("--bar", "10.0.4.20");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The settings menu lists the programs in this order; the wheel's "up" goes down the list.
const OPEN = ["apps", "settings", "ok"];
const program = (index) => [...OPEN, ...Array(index).fill("up"), "*", "ok"];
const WALKS = {
  // The fifth item, Sound, shows the bar's volume.
  menu: [...OPEN, "*", "up", "*", "up", "*", "up", "*", "up", "~", "up", "*", "up", "*", "up", "*", "up", "*", "up", "*"],
  wifi: [...program(1), "~", "ok", "*", "up", "*", "back", "~"],
  "smart-home": [...program(2), "*"],
  account: [...program(3), "*"],
  brightness: [...program(5), "*"],
  time: [...program(6), "~", "ok", "~", "up", "~", "up", "~", "back", "~", "up", "*", "ok", "*", "back", "~"],
  firmware: [...program(7), "*", "up", "*", "ok", "~", "up", "~", "back", "*", "up", "up", "*"],
  system: [...program(8), "*", "ok", "*", "up", "*", "up", "*", "back", "*", "up", "*", "ok", "*", "back", "*"],
  about: [...program(9), "*", "ok", "~", "up", "~", "up", "~", "back", "*", "up", "ok", "~", "back", "up", "up", "ok", "~", "back", "up", "up", "up", "*", "ok", "*", "up", "*", "up", "*"],
};

const BACK = { width: 160, height: 80 };
// The status bar on the right of the back display shows the device's own state.
const STATUS_BAR_X = 148;

const api = (host, method, path) => fetch(`http://${host}/api/${path}`, { method, signal: AbortSignal.timeout(8000) }).then((r) => r.text());
const backFrame = async (host) => Buffer.from(await api(host, "GET", "screen?display=1"), "base64");
const pixel = (frame, i) => (frame[i >> 1] >> (i & 1 ? 4 : 0)) & 15;

/** How many pixels of two back frames differ, left of the status bar. */
function differ(a, b) {
  let n = 0;
  for (let y = 0; y < BACK.height; y++) for (let x = 0; x < STATUS_BAR_X; x++) if (pixel(a, y * BACK.width + x) !== pixel(b, y * BACK.width + x)) n++;
  return n;
}

/**
 * Walks `keys` on a host; returns the pictures taken, { kind, frame }. With `guard` (the pictures of the same walk
 * elsewhere), every picture taken right before an OK must be the guard's: otherwise the walk stops and returns null.
 */
async function walk(host, keys, guard = null) {
  const shots = [];
  try {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === "*" || key === "~") {
        const frame = await backFrame(host);
        const expected = guard?.[shots.length];
        if (expected && keys[i + 1] === "ok" && key === "*" && differ(frame, expected.frame) > 0) {
          console.log(`         stopped before an OK: the bar's picture ${shots.length + 1} is not the emulator's (${differ(frame, expected.frame)} px)`);
          return null;
        }
        shots.push({ kind: key, frame });
      } else {
        await api(host, "POST", `input?key=${key}`);
        // A program or a mode takes a moment to open; the wheel only moves the selection.
        await sleep(key === "up" || key === "down" ? 500 : 1500);
      }
    }
    return shots;
  } finally {
    await api(host, "POST", "input?key=apps").catch(() => null);
    await sleep(800);
  }
}

// ---------------------------------------------------------------- pictures

function png(width, height, gray) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 0, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) gray.copy(rows, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** A sheet of a walk: a column per picture, the bar above the emulator. */
function sheet(barShots, emuShots) {
  const scale = 2;
  const cell = { w: BACK.width * scale + 6, h: BACK.height * scale + 6 };
  const width = cell.w * barShots.length;
  const gray = Buffer.alloc(width * cell.h * 2, 70);
  [barShots, emuShots].forEach((shots, row) =>
    shots.forEach((shot, col) => {
      for (let y = 0; y < BACK.height * scale; y++)
        for (let x = 0; x < BACK.width * scale; x++)
          gray[(row * cell.h + y) * width + col * cell.w + x] = pixel(shot.frame, Math.floor(y / scale) * BACK.width + Math.floor(x / scale)) * 17;
    }),
  );
  return png(width, cell.h * 2, gray);
}

// ---------------------------------------------------------------- run

if (only && !WALKS[only]) throw new Error(`no walk ${only}: ${Object.keys(WALKS).join(", ")}`);
if (record) mkdirSync(savedDir, { recursive: true });
// Recording walks the emulator first too: one of its own unless --emu names one.
const target = await emulatorFor(args, { name: "settings" });
const emu = target.addr;
// The time zones are listed around the bar's own zone: the emulator takes it for the walks, and gets its own back.
const emuZone = JSON.parse(await api(emu, "GET", "time/timezone")).name;
const setZone = (zone) => api(emu, "POST", `time/timezone?timezone=${encodeURIComponent(zone)}`);
if (record) await setZone(JSON.parse(await api(bar, "GET", "time/timezone")).name);

let failed = 0;
let passed = 0;
let skipped = 0;
for (const [name, keys] of Object.entries(WALKS)) {
  if (only && name !== only) continue;
  const file = join(savedDir, `${name}.json`);
  const why = Object.hasOwn(unpublished, `test/settings/${name}.json`) ? unpublished[`test/settings/${name}.json`] : null;
  if (!record && why && !existsSync(file)) {
    // Said and counted as skipped, never as a walk that agrees.
    skipped++;
    console.log(`  SKIP ${name}: its recording is not published: ${why}`);
    continue;
  }
  if (!record && existsSync(file)) await setZone(JSON.parse(readFileSync(file, "utf8")).zone);
  const emuShots = await walk(emu, keys);
  let barShots;
  if (record) {
    barShots = await walk(bar, keys, emuShots);
    if (!barShots) {
      failed++;
      console.log(`  STOP ${name}`);
      continue;
    }
    writeFileSync(file, JSON.stringify({ zone: JSON.parse(await api(bar, "GET", "time/timezone")).name, shots: barShots.map((s) => ({ kind: s.kind, frame: s.frame.toString("base64") })) }) + "\n");
  } else {
    if (!existsSync(file)) {
      // A walk that cannot be compared is not a walk that agrees.
      failed++;
      console.log(`  FAIL ${name}: no recording of a bar (node emulator/test/settings.mjs --record --only ${name})`);
      continue;
    }
    barShots = JSON.parse(readFileSync(file, "utf8")).shots.map((s) => ({ kind: s.kind, frame: Buffer.from(s.frame, "base64") }));
  }
  const diffs = barShots.map((s, i) => differ(s.frame, emuShots[i].frame));
  const wrong = diffs.filter((d, i) => d > 0 && barShots[i].kind === "*").length;
  const own = diffs.map((d, i) => (barShots[i].kind === "~" ? d : null)).filter((d) => d !== null);
  if (wrong) failed++;
  else passed++;
  console.log(`  ${wrong ? "DIFF" : "ok  "} ${name}: ${diffs.filter((d, i) => barShots[i].kind === "*" && d === 0).length} of ${barShots.filter((s) => s.kind === "*").length} screens are the bar's${own.length ? `; ${own.length} more show the bar's own state and are not compared (${own.join(", ")} px differ)` : ""}`);
  if (wrong) console.log(`         differ: ${diffs.map((d, i) => (d > 0 && barShots[i].kind === "*" ? `picture ${i + 1} by ${d} px` : null)).filter(Boolean).join(", ")}`);
  if (images) {
    writeFileSync(join(outputDir("settings"), `${name}.png`), sheet(barShots, emuShots));
  }
}
await setZone(emuZone);
console.log(failed ? `${failed} walks differ from the bar` : record ? "recorded" : skipped ? (passed ? `the other walks agree with the bar; ${skipped} skipped` : `no walk compared; ${skipped} skipped`) : "all walks agree with the bar");
if (images) console.log(`images: ${outputDir("settings")}`);
await target.stop();
if (!record) totals({ pass: passed, fail: failed, skip: skipped });
process.exit(record ? (failed ? 1 : 0) : process.exitCode);
