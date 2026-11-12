// How state/bar-state-1.3.1.json and state/bar-state-1.3.1-more.json were made from the recordings of EMU-232
// (spikes/bar-compare.md and the night of 11-12.11). The recordings themselves are not in the repository: they were
// made on the owner's bars and hold more than the test needs (the bars' app lists, serial numbers, time zone). This
// keeps what the test needs and leaves the rest out; what it leaves out it prints.
//
//   node emulator/test/state/make.mjs <bar-compare folder> <the night's EMU-232 folder>
//
// <bar-compare folder> holds m2/log-*.json and logs/m2-brightness.txt (state-compare.mjs, 10.11); the night's
// folder holds replay-draw.json and replay-busy.json (state-night.mjs, 11.11).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../../packages/server/arguments.mjs";

await commandLine(process.argv, { positionals: true });
const [compareDir, nightDir] = process.argv.slice(2);
if (!compareDir || !nightDir) {
  console.error("usage: node make.mjs <bar-compare folder> <the night's EMU-232 folder>");
  process.exit(2);
}
const m2 = (g) => JSON.parse(readFileSync(join(compareDir, "m2", `log-${g}.json`), "utf8"));
const out = dirname(fileURLToPath(import.meta.url));
const left = [];

// ---------------------------------------------------------------- 10.11 evening
// The waits replay.mjs used before reading frames (the recording script waited about as long).
const WAIT = { "POST apps/launch?app_id=app.probe.cmp": 2500, "POST apps/quit": 1500, "POST input?key=back": 1000 };
const evening = [];
for (const g of ["apps", "settings", "input", "quit"]) {
  for (const l of m2(g).log) {
    const [, method, path, rest] = l.request.replace("<from stage>", "<staged>").match(/^(\w+) \/api\/(\S*)(?: (.*))?$/s);
    if (path === "apps/list") {
      left.push(`10.11 ${g}: GET apps/list left out: the bar's answer lists the apps of the owner's bar (and was cut at 600 characters)`);
      continue;
    }
    const entry = { group: g, method, path };
    if (path === "apps/stage") entry.archive = "app.probe.cmp";
    else if (method !== "GET" && rest !== undefined) entry.body = rest;
    if (l.note) entry.note = l.note;
    entry.status = l.bar.status;
    entry.response = l.bar.body;
    // The 8 frames replay.mjs compared (apps, settings, input): sha1 of the frame as GET /api/screen gives it, first 10.
    if (l.frames && ["apps", "settings", "input"].includes(g)) {
      entry.wait = WAIT[`${method} ${path}`] ?? 700;
      entry.frameHashes = { front: l.frames.front.bar, back: l.frames.back.bar };
    } else if (l.frames) left.push(`10.11 ${g}: frames of ${method} ${path} not kept: the APPS list behind them is the owner's bar's`);
    else if (WAIT[`${method} ${path}`]) entry.wait = WAIT[`${method} ${path}`];
    evening.push(entry);
  }
}
{
  const lines = readFileSync(join(compareDir, "logs", "m2-brightness.txt"), "utf8").split("\n");
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\[[^\]]+\] (\w+) \/api\/(\S*)$/);
    if (!m) continue;
    const bar = lines[i + 1].trim().match(/^bar (\d+) (.*)$/);
    const entry = { group: "brightness", method: m[1], path: m[2], status: Number(bar[1]), response: bar[2] };
    const lastPost = prev?.method === "POST" && prev.status === 200 ? prev.path : null;
    if (m[1] === "GET" && lastPost) {
      // The bar's GET right after a POST that it took: its brightness service applies the value about 20 ms later
      // (api_display.c → brightness_control.c do_set_*: the settings file is saved before the state is updated).
      const value = lastPost.match(/value=([^&]*)/)?.[1];
      const now = { status: 200, response: JSON.stringify({ value }) };
      if (now.response !== entry.response) {
        entry.alsoAccepted = now;
        entry.note = "right after the POST: the bar still gave the value before it; the emulator gives the new one at once (EMU-232: not emulated)";
      }
    }
    prev = entry;
    evening.push(entry);
  }
}
for (const g of ["volume", "name", "name-raw", "timezone"]) {
  for (const l of m2(g).log) {
    if (!l.bar) continue; // the emulator's own events, no answer of the bar
    if (l.request === "GET /api/time (offset only)") {
      evening.push({ group: g, method: "GET", path: "time", status: l.bar.status, response: l.bar.body, compare: "offset", note: "only the time zone's offset at the end is compared: the time is the time of the recording" });
      continue;
    }
    const [, method, path, rest] = l.request.match(/^(\w+) \/api\/(\S*)(?: (.*))?$/s);
    const entry = { group: g, method, path };
    if (method !== "GET" && rest !== undefined) entry.body = rest;
    if (l.note) entry.note = l.note;
    entry.status = l.bar.status;
    entry.response = l.bar.body;
    if (l.frames) left.push(`10.11 ${g}: frames of ${method} ${path} not kept: the APPS list behind them is the owner's bar's`);
    evening.push(entry);
  }
}
writeFileSync(
  join(out, "bar-state-1.3.1.json"),
  JSON.stringify(
    {
      recorded: "2026-11-10, evening",
      bar: "a bar with a self-built U5: firmware 1.3.1 (8edd2da4-dirty), API 27.14.0",
      script: "bar-compare/state-compare.mjs (EMU-232 spike, spikes/bar-compare.md); each request went to the bar and then to the emulator",
      exact: false,
      exactNote: "the recording script trimmed white space at both ends of every answer: a final line feed is not recorded",
      start: { brightness: "100", volume: 100, name: "BB" },
      requests: evening,
    },
    null,
    1,
  ) + "\n",
);

// ---------------------------------------------------------------- 11-12.11 night
const night = (g) => JSON.parse(readFileSync(join(nightDir, `replay-${g}.json`), "utf8"));
const draw = night("draw");
const busy = night("busy");
const more = [];
// state-night.mjs: what each step waited before its frames were taken, and the sleep before the "3 s later" GET.
const BUSY_WAIT = { 1: 1500, 4: 1000, 6: 1500, 8: 1000, 10: 1500, 23: 1500 };
// What moves by itself in the timer's frames and is left out of the comparison: the APPS splash's shine, the
// particles of the BUSY plate and the shimmer of the red INFINITE plate, the blurred picture of the plate behind
// PAUSED (taken at a moment of those animations). On the back the plate is the box x 0–147, y 22–57; the rest (ACTIVE
// and its arrows, the line under the plate) is compared. On the front the running SIMPLE timer's time (x 40–71) is.
const PLATE = [[0, 22, 148, 58]];
const BUSY_MASK = {
  0: { mask: { front: "all" }, maskNote: "the APPS splash's shine moves" },
  1: { mask: { front: [[0, 0, 40, 16]], back: PLATE }, maskNote: "the BUSY plate's particles move" },
  3: { mask: { front: [[0, 0, 40, 16]], back: PLATE }, maskNote: "the BUSY plate's particles move" },
  4: { mask: { front: "all", back: PLATE }, maskNote: "behind PAUSED: a blurred picture of the plate, taken at a moment of its animation" },
  6: { mask: { front: "all", back: PLATE }, maskNote: "the red INFINITE plate's shimmer moves" },
  8: { mask: { front: "all", back: PLATE }, maskNote: "behind PAUSED: a blurred picture of the plate, taken at a moment of its animation" },
  10: { mask: { front: "all", back: PLATE }, maskNote: "the refused INTERVAL left the paused INFINITE timer: as the frame before" },
  20: {
    wait: 100,
    mask: { front: "all", back: PLATE },
    maskNote:
      "taken in the middle of the change from PAUSED to the finished timer. The recording has no time for the frame; the bar's answers to the two requests before it took 13 and 25 ms. On the emulator's clock the same step of the change is 100 ms after the PUT with time_left_ms -5 (found by looking at 0–400 ms)",
  },
  23: { mask: { front: "all" }, maskNote: "the APPS splash's shine moves" },
};
const DRAW_WAIT = { 0: 600, 1: 600, 2: 600, 13: 400, 20: 400, 21: 400, 26: 600, 28: 600 };
for (const [i, r] of draw.requests.entries()) {
  const entry = { group: "draw", method: r.method, path: r.path };
  if (r.body !== null) entry.body = r.body;
  if (r.note) entry.note = r.note;
  Object.assign(entry, { status: r.status, contentType: r.contentType, response: r.response });
  if (r.frames) Object.assign(entry, { wait: DRAW_WAIT[i], frames: r.frames });
  more.push(entry);
}
for (const [i, r] of busy.requests.entries()) {
  const entry = { group: "busy", method: r.method, path: r.path };
  if (r.body !== null) entry.body = r.body;
  if (r.note) entry.note = r.note;
  if (i === 3) entry.before = 3000;
  Object.assign(entry, { status: r.status, contentType: r.contentType, response: r.response });
  if (BUSY_WAIT[i] !== undefined) entry.wait = BUSY_WAIT[i];
  if (r.frames) entry.frames = r.frames;
  if (BUSY_MASK[i]) Object.assign(entry, BUSY_MASK[i]);
  // Before the second reading of the profiles the recording script put the bar's two profiles into the emulator.
  if (i === 35) entry.emulatorFirst = [{ method: "PUT", path: "busy/profiles/busy", fromResponseOf: 28 }, { method: "PUT", path: "busy/profiles/custom", fromResponseOf: 29 }];
  more.push(entry);
}
writeFileSync(
  join(out, "bar-state-1.3.1-more.json"),
  JSON.stringify(
    {
      recorded: "2026-11-11, night (03:07–03:10 UTC)",
      bar: "a stock bar: firmware 1.3.1 (8edd2da4), the mode selector in APPS, no app running",
      script: "bar-night/scripts/state-night.mjs (state-compare.mjs with bar-only steps, answers byte for byte and frames in full)",
      exact: true,
      exactNote: "answers byte for byte, a final line feed included; frames as GET /api/screen gives them, base64",
      start: { brightness: draw.orig["display/brightness"].value, volume: draw.orig["audio/volume"].volume, name: draw.orig.name.name, timezone: draw.orig["time/timezone"].name },
      requests: more,
    },
    null,
    1,
  ) + "\n",
);
console.log(`10.11: ${evening.length} requests; night: ${more.length} requests (draw ${draw.requests.length}, busy ${busy.requests.length})`);
for (const l of left) console.log(`  ${l}`);
