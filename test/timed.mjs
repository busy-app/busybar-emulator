// Scenes that change with time — animations, scrolling text, a countdown — on a bar and in the emulator.
//
// A bar and the emulator cannot be started at the same instant, and a bar's display can only be looked at about 35
// times a second (GET /api/screen), in bursts. So a bar is watched for a while and what it showed is saved; the
// emulator then plays the same scene with its clock held, 8 ms at a time (POST /_emu/time), which gives every frame it
// shows and the exact time of each. A held clock plays the same each time (screen.mjs), so the emulator's side of the
// comparison does not depend on the computer, its load or what ran before.
//
// Each scene is played in two ways. Once with drawing that takes the GUI no time (hold=1&jitter=0): then the
// emulator shows every frame an animation has, at its nominal times — the nominal timeline. Then at bar speed, with
// the time a bar's GUI takes to draw, which makes it miss ticks, its sequence started from each of SEEDS in turn
// (hold=1&seed=N). The two are compared like this:
//
//   frames   every frame the bar showed must be in the nominal timeline, pixel for pixel;
//   order    the bar's frames must come in the nominal timeline's order;
//   pace     laid over the nominal timeline, the bar's frames and the emulator's at bar speed must come at the same
//            rate: the bar's time per the emulator's (the mean over the seeds) is 1.00 when they keep the same rhythm;
//   start    the time until the picture first changes must agree, at bar speed with every seed;
//   slowdown an animation's own: the emulator's time at bar speed over its nominal timeline (the mean over the seeds)
//            must be a stock bar's, measured at each frame rate (BAR_SLOWDOWN).
//
// So frames and order do not depend on which ticks the drawing time happens to make the emulator miss, and the pace
// is that of the emulator's drawing time, measured the same way on every run.
//
//   node emulator/test/timed.mjs                    an emulator of its own against the bar's saved recordings (test/timed/)
//   node emulator/test/timed.mjs --firmware dev     the same on another firmware; --emu 127.0.0.1:8640 a running emulator
//   node emulator/test/timed.mjs --record           watch a connected bar (10.0.4.20) and save what it showed
//   node emulator/test/timed.mjs --only scroll      one scene
//   node emulator/test/timed.mjs --images           the bar's frames the emulator never showed, in a folder of the
//                                                   system's temporary folder (EMU_TEST_OUT when the gate runs it)
//   node emulator/test/timed.mjs --signatures       also a signature of each of the emulator's playbacks (its frames
//                                                   and their times): the same in every run when the hold works
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest, Agent } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { commandLine } from "../packages/server/arguments.mjs";
import { emulatorFor, outputDir, totals } from "./own-emulator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const savedDir = join(here, "timed");
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--emu", "--only", "--firmware"], flags: ["--record", "--images", "--signatures"], emulator: "--emu" });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const record = args.includes("--record");
const only = option("--only", null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = "emu.timed";
// GUI_TICK_PERIOD_MS: the GUI redraws at most this often, so the emulator's picture changes only at these steps.
const STEP_MS = 8;
// How long the emulator's held clock moves on between preparing a scene and drawing it (it was a real pause of 300 ms).
const PREPARE_MS = 304;
// Where the sequence of the GUI's drawing time starts at bar speed, one playback each. The pace of a 60 frames a second
// animation differs by a few percent from one seed to another, as from one run of a bar to the next; their mean is
// what is compared.
const SEEDS = [0x9e3779b9, 0x2545f491, 0x6c8e9cf5];

const text = (extra) => [{ id: "t", type: "text", font: "small", x: 0, y: 4, width: 72, text: "A long line of text that does not fit the display", ...extra }];
const animation = (name, extra = {}) => [{ id: "a", type: "animation", x: 0, y: 0, stock_path: `shared/${name}`, ...extra }];
// The firmware's coding_72x16.anim (60 frames a second) with another frame rate in its header, as the app's own file.
const uploaded = (fps) => ({
  upload: { from: "coding_72x16.anim", fps, as: `pace${fps}.anim` },
  elements: [{ id: "a", type: "animation", x: 0, y: 0, path: `pace${fps}.anim`, loop: true }],
});

// seconds: how long the bar is watched.
const SCENES = {
  "anim-loop": { seconds: 8, slowdown: "60", elements: animation("coding_72x16.anim", { loop: true }) },
  "anim-once": { seconds: 6, slowdown: "60", elements: animation("meeting_72x16.anim", { loop: false }) },
  "anim-small": { seconds: 6, slowdown: "spinner", elements: [{ ...animation("spinner_front_8x8.anim", { loop: true })[0], x: 32, y: 4 }] },
  // 25 and 30 frames a second: timers of 40 and 33 ms, both every five ticks on a bar.
  "anim-25": { seconds: 24, slowdown: "25", ...uploaded(25) },
  "anim-30": { seconds: 24, slowdown: "30", ...uploaded(30) },
  scroll: { seconds: 20, elements: text({ scroll_rate: 600 }) },
  "scroll-delays": { seconds: 20, elements: text({ scroll_rate: 1200, scroll_start_delay: 1500, scroll_repeat_delay: 2500 }) },
  countdown: { seconds: 6, countdown: 3600 },
  // The mode selector moved to OFF: the firmware's power-off animation, then dark displays. It starts from SETTINGS,
  // whose menu stands still (the apps menu's title is animated); `restore` puts the selector back afterwards.
  off: { seconds: 5, key: "off", from: "settings", restore: "apps" },
};

/**
 * A request to the device: { status, text }. Through node:http with a kept-alive connection rather than fetch: on
 * Windows fetch takes ~15 ms a request on the loopback (node:http 0.2 ms), and the emulator's side of a scene is
 * thousands of requests.
 */
const agent = new Agent({ keepAlive: true });
function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`http://${addr}${path}`, { method, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const api = (method, path, body) => call(method, `/api/${path}`, body);
const screen = async () => (await call("GET", "/api/screen?display=0")).text;

const hashOf = (frame) => createHash("sha1").update(frame).digest("hex").slice(0, 12);

/** Clears the scene's elements and returns the function that draws it; `now` is the device's clock, Unix ms. */
async function prepare(scene) {
  if (scene.key) {
    await api("POST", `input?key=${scene.from}`);
    return async () => {
      const pressed = await api("POST", `input?key=${scene.key}`);
      if (pressed.status !== 200) throw new Error(`key: ${pressed.status} ${pressed.text}`);
    };
  }
  await api("DELETE", `display/draw?application_name=${APP}`);
  if (scene.upload) {
    const bytes = readFileSync(join(here, "../packages/engine/build/apps-assets/shared/animations", scene.upload.from));
    bytes.writeUInt16LE(scene.upload.fps, 16); // the frame rate in a .anim header
    const sent = await api("POST", `assets/upload?application_name=${APP}&file=${scene.upload.as}`, bytes);
    if (sent.status !== 200) throw new Error(`upload: ${sent.status} ${sent.text}`);
  }
  return async (now = Date.now()) => {
    const elements = scene.countdown
      ? [{ id: "c", type: "countdown", x: 36, y: 8, align: "center", font: "small", timestamp: String(Math.floor(now / 1000) + scene.countdown), direction: "time_left", show_hours: "when_non_zero" }]
      : scene.elements;
    // Above whatever the bar's own screen holds (the apps menu's title card takes draws of a lower priority only after
    // 1.5 s, and then refuses them).
    const drawn = await api("POST", "display/draw", JSON.stringify({ application_name: APP, priority: 100, elements }));
    if (drawn.status !== 200) throw new Error(`draw: ${drawn.status} ${drawn.text}`);
  };
}

/** Puts the device back as it was before the scene. */
async function cleanUp(scene) {
  if (scene.key) return api("POST", `input?key=${scene.restore}`);
  await api("DELETE", `display/draw?application_name=${APP}`);
  if (scene.upload) await api("DELETE", `assets/upload?application_name=${APP}`);
}

/** Adds a look at the display to `runs`: runs of equal frames, { hash, start, end } in ms from the draw. */
function look(runs, frames, frame, at) {
  const hash = hashOf(frame);
  frames.set(hash, frame);
  const last = runs[runs.length - 1];
  if (last?.hash === hash) last.end = at;
  else runs.push({ hash, start: at, end: at });
}

/** A bar: what its front display shows for `seconds` after the scene is drawn, looked at as often as it answers. */
async function watchBar(scene) {
  const draw = await prepare(scene);
  await sleep(700);
  await draw();
  const t0 = performance.now();
  const frames = new Map(); // hash → the frame, base64
  const runs = [];
  while (performance.now() - t0 < scene.seconds * 1000) {
    const frame = await (await fetch(`http://${addr}/api/screen?display=0`)).text();
    look(runs, frames, frame, performance.now() - t0);
  }
  await cleanUp(scene);
  return { frames, runs };
}

/**
 * The emulator: the same, with its clock held and moved 8 ms at a time, so that no frame is missed; `hold` is how the
 * clock is held ("jitter=0", "seed=N").
 */
async function watchEmulator(scene, seconds, hold) {
  const time = (query) => call("POST", `/_emu/time?${query}`);
  // The clock is held first and everything after happens in held time: what the scene starts from (a cleared
  // display, a mode's menu) is then the same on every run, whatever the computer's load made of the pauses.
  // The emulator's clock is ahead of the computer's by what earlier scenes moved it.
  const held = await time(`hold=1&${hold}`);
  if (held.status !== 200) throw new Error(`hold: ${held.status} ${held.text}`);
  let { now, wander } = JSON.parse(held.text);
  const draw = await prepare(scene);
  await time(`advance=${PREPARE_MS}`);
  now += PREPARE_MS;
  // A countdown changes when the clock's seconds do: drawn at the same point of a second, it plays the same each time.
  // (Give or take the 16 ms the hold puts the display's refresh on, by which the wait is counted.)
  if (scene.countdown) {
    const wait = Math.ceil((1000 - (now % 1000)) / 16) * 16;
    await time(`advance=${wait}`);
    now += wait;
  }
  try {
    // A key scene starts from a screen of the bar's own, which may be animated (a menu's icon): what it shows
    // before the key is not the scene.
    const before = new Set();
    for (let at = 0; scene.key && at < 1500; at += STEP_MS) {
      before.add(hashOf(await screen()));
      await time(`advance=${STEP_MS}`);
    }
    await draw(now);
    const frames = new Map();
    const runs = [];
    for (let at = 0; at <= seconds * 1000; at += STEP_MS) {
      look(runs, frames, await screen(), at);
      await time(`advance=${STEP_MS}`);
    }
    return { frames, runs, before, wander };
  } finally {
    await time("hold=0");
    await cleanUp(scene);
  }
}

/**
 * Runs laid over the nominal timeline: each run is matched with the next run of the same frame in the timeline, going
 * forward only. Returns the pairs of times, how many of the runs found no place (a frame out of the timeline's order),
 * and the line through the pairs: the runs' ms = offset + pace × the timeline's ms.
 */
function overlay(runs, timeline) {
  const pairs = [];
  let unplaced = 0;
  let at = 0;
  for (const run of runs) {
    let j = at;
    while (j < timeline.length && timeline[j].hash !== run.hash) j++;
    if (j === timeline.length) {
      unplaced++;
      continue;
    }
    pairs.push([timeline[j].start, run.start]);
    at = j;
  }
  if (pairs.length < 2) return { pairs, unplaced, pace: null, offset: null };
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const pace = sxx ? pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx : null;
  return { pairs, unplaced, pace, offset: pace === null ? null : my - pace * mx };
}

// ---------------------------------------------------------------- pictures of what differs

function png(width, height, rgb) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
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
  head.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A frame as the bar gives it (BGR888, 72×16) → PNG, 6 times larger. */
function framePng(base64) {
  const bgr = Buffer.from(base64, "base64");
  const scale = 6;
  const rgb = Buffer.alloc(72 * 16 * 3 * scale * scale);
  for (let y = 0; y < 16 * scale; y++) {
    for (let x = 0; x < 72 * scale; x++) {
      const s = (Math.floor(y / scale) * 72 + Math.floor(x / scale)) * 3;
      const d = (y * 72 * scale + x) * 3;
      rgb[d] = bgr[s + 2];
      rgb[d + 1] = bgr[s + 1];
      rgb[d + 2] = bgr[s];
    }
  }
  return png(72 * scale, 16 * scale, rgb);
}

// ---------------------------------------------------------------- run

const fmt = (ms) => (ms === null || ms === undefined ? "—" : `${Math.round(ms)} ms`);
// The picture first changes at the same time, give or take the time between two looks at a bar and its answer to the
// draw (~30 ms each).
const START_TOLERANCE_MS = 100;
// The same rhythm: the bar's time per emulator's time within 8% of 1. A bar's own pace of a 60 frames a second
// animation differs by that much from one run to the next (1.10 to 1.24 of the nominal time), and the emulator's from
// one seed to another: both miss ticks by chance (packages/engine/native/furi_shim.c). Text scrolls by the clock and
// keeps within 1%.
const PACE_TOLERANCE = 0.08;
// A key scene: how long after the key a bar may still show the screen it started from, fading out.
const LEAD_MS = 400;
// A stock bar's slowdown of an animation over its nominal timeline (whole ticks: 16 ms a frame at 60 frames a second,
// 32 at 33, 40 at 30 to 25), the mean of 5 runs at each frame rate (a stock bar on firmware 1.3.1, night of 11-12 Nov
// 2026: reports/bar-night-2026-11-12.md, the EMU-231 section). The emulator's own slowdown at bar speed, the mean
// over SEEDS, must be within `tolerance` of it. The pace check above is a ratio of two slopes over the nominal
// timeline and cannot see the timeline itself go wrong; this one does: a nominal timeline played with the drawing
// time gives ~1.00, drawing that takes no time 1.00 everywhere, the emulator before EMU-231 (a wander of 0..2 ms on
// every tick) 1.083 at 25 frames a second and 0.946 at 30. Each tolerance is about the spread of the bar's own runs,
// plus what three seeds of the emulator leave of theirs:
//   60       1.216; the runs spread 1.144-1.249 (-6 % / +3 %; the recordings in test/timed/ give 1.204 and 1.246):
//            3 %, as before;
//   spinner  33 frames a second, the small animation: 1.025; the runs spread 1.005-1.043 (±2 %): 2 % (the emulator
//            gives ~1.04: its drawing time does not shrink with what is drawn);
//   30, 25   40 ms a frame: 0.998 (0.997-0.999) and 1.001 (0.999-1.002), the bar's clock and the computer's a
//            0.1-0.2 % apart; the emulator keeps 40 ms after its first frames: 0.5 %.
const BAR_SLOWDOWN = {
  60: { value: 1.216, tolerance: 0.03 },
  spinner: { value: 1.025, tolerance: 0.02 },
  30: { value: 0.998, tolerance: 0.005 },
  25: { value: 1.001, tolerance: 0.005 },
};

if (only && !SCENES[only]) throw new Error(`no scene ${only}: ${Object.keys(SCENES).join(", ")}`);
if (record) mkdirSync(savedDir, { recursive: true });
// The bar, or the emulator: one at --emu, else one of this test's own (at bar speed: the scenes need the wander).
const target = record ? { addr: option("--bar", "10.0.4.20"), stop: async () => {} } : await emulatorFor(args, { name: "timed" });
const addr = target.addr;
// An emulator that has just started shows the apps menu's title card for its first 1.5 s, and a draw in that time
// starts blended with it. Its clock is moved past that first, whatever the computer's load made of the start.
if (!record) {
  const time = (query) => call("POST", `/_emu/time?${query}`);
  if ((await time("hold=1")).status !== 200) throw new Error("hold: no emulator at " + addr);
  await time("advance=2000");
  await time("hold=0");
}
let failed = 0;
let passed = 0;
for (const [name, scene] of Object.entries(SCENES)) {
  if (only && name !== only) continue;
  const file = join(savedDir, `${name}.json`);
  if (record) {
    const seen = await watchBar(scene);
    // The frames themselves are kept: the emulator must show each of them.
    const frames = [...seen.frames.entries()].map(([hash, frame]) => ({ hash, frame }));
    writeFileSync(file, JSON.stringify({ runs: seen.runs.map((r) => [r.hash, Math.round(r.start), Math.round(r.end)]), frames }) + "\n");
    console.log(`  ${name}: ${seen.frames.size} frames in ${seen.runs.length} runs`);
    continue;
  }
  if (!existsSync(file)) {
    // A scene that cannot be compared is not a scene that agrees.
    failed++;
    console.log(`  FAIL ${name}: no recording of a bar (node emulator/test/timed.mjs --record --only ${name})`);
    continue;
  }
  const bar = JSON.parse(readFileSync(file, "utf8"));
  let barRuns = bar.runs.map(([hash, start, end]) => ({ hash, start, end }));
  // The first look may still catch what was on the display before the draw: the bar's own menu, not the scene.
  const background = barRuns.slice(1).some((r) => r.hash === barRuns[0].hash) ? null : barRuns[0].hash;
  if (background) barRuns = barRuns.slice(1);
  // Longer than the bar was watched: a bar that runs slow gets less far into the scene, a fast one further. The
  // nominal timeline a little longer still, so that the playbacks at bar speed do not get past it: a countdown
  // changes when the seconds of the clock do, which come at another point of each playback.
  const nominal = await watchEmulator(scene, scene.seconds * 1.4 + 1.5, "jitter=0");
  const timeline = nominal.runs.slice(1); // the first is what was there before the draw
  // A countdown's first picture comes with the draw, the next when the clock's second changes, at whatever point of a
  // second the scene was drawn: its pace is that of the changes after the first.
  const paced = scene.countdown ? 1 : 0;
  const atBarSpeed = [];
  for (const seed of SEEDS) {
    const emu = await watchEmulator(scene, scene.seconds * 1.4, `seed=${seed}`);
    atBarSpeed.push({ seed, ...emu, laid: overlay(emu.runs.slice(1 + paced), timeline) });
  }
  // A key takes effect later on a bar (it has a program to close and another to load): until then it goes on
  // showing the screen the scene started from, and then fades it out. A fade's frames depend on the instants they
  // are drawn at, so the bar's are not the emulator's; they are over well within LEAD_MS.
  const lead = new Set();
  while (scene.key && barRuns.length && (nominal.before.has(barRuns[0].hash) || (!nominal.frames.has(barRuns[0].hash) && barRuns[0].start < LEAD_MS))) lead.add(barRuns.shift().hash);
  const barFrames = bar.frames.filter((f) => f.hash !== background && !lead.has(f.hash));
  const missing = barFrames.filter((f) => !nominal.frames.has(f.hash));
  const placed = barRuns.filter((r) => nominal.frames.has(r.hash));
  const laid = overlay(placed, timeline);
  const barPace = (paced ? overlay(placed.slice(paced), timeline) : laid).pace;
  const emuPaces = atBarSpeed.map((e) => e.laid.pace);
  const emuPace = emuPaces.includes(null) ? null : emuPaces.reduce((a, b) => a + b, 0) / emuPaces.length;
  const pace = barPace === null || !emuPace ? null : barPace / emuPace;
  const barStart = barRuns[0]?.start ?? null;
  const emuStarts = atBarSpeed.map((e) => e.runs[1]?.start ?? null);

  const problems = [];
  // The two kinds of playback are what they are meant to be: the nominal one without the drawing time, the others with it.
  if (nominal.wander !== 0) problems.push(`the nominal playback has a drawing time of up to ${nominal.wander} ms (hold=1&jitter=0 is not taken)`);
  for (const e of atBarSpeed) if (!(e.wander > 0)) problems.push(`seed ${e.seed}: the playback at bar speed has no drawing time (is the emulator run with --fast?)`);
  if (missing.length) problems.push(`${missing.length} of the bar's ${barFrames.length} frames are not the emulator's`);
  if (laid.unplaced) problems.push(`${laid.unplaced} of the bar's runs come out of the emulator's nominal order`);
  // At bar speed the emulator only leaves out frames of the nominal timeline, so its pace over it is sound. (Not a key
  // scene's: its fade has other frames at other instants.)
  for (const e of atBarSpeed) if (e.laid.unplaced && !scene.key) problems.push(`seed ${e.seed}: ${e.laid.unplaced} of the emulator's runs at bar speed come out of its nominal order`);
  if (scene.key) {
    // A change of mode loads the bar (it closes one program and starts another), and its animation stalls and catches
    // up; what must agree is when the display settles on its last picture.
    const settled = (runs) => runs[runs.length - 1]?.start ?? null;
    const barEnd = settled(barRuns);
    for (const e of atBarSpeed) {
      if (barRuns[barRuns.length - 1]?.hash !== e.runs[e.runs.length - 1]?.hash) problems.push(`seed ${e.seed}: the display ends on another picture`);
      if (Math.abs(barEnd - settled(e.runs)) > START_TOLERANCE_MS) problems.push(`seed ${e.seed}: the display settles after ${fmt(barEnd)} on the bar, ${fmt(settled(e.runs))} in the emulator`);
    }
  } else {
    const slowdown = BAR_SLOWDOWN[scene.slowdown];
    if (slowdown && (emuPace === null || Math.abs(emuPace / slowdown.value - 1) > slowdown.tolerance)) problems.push(`the emulator plays it at ${emuPace?.toFixed(3) ?? "?"} of the nominal time, a stock bar at ${slowdown.value} (± ${slowdown.tolerance * 100} %)`);
    if (pace === null || Math.abs(pace - 1) > PACE_TOLERANCE) problems.push(`pace: the bar takes ${pace?.toFixed(3) ?? "?"} of the emulator's time`);
    atBarSpeed.forEach((e, i) => {
      if (Math.abs(barStart - emuStarts[i]) > START_TOLERANCE_MS) problems.push(`seed ${e.seed}: the picture first changes after ${fmt(barStart)} on the bar, ${fmt(emuStarts[i])} in the emulator`);
    });
  }
  if (problems.length) failed++;
  else passed++;
  const timing = scene.key
    ? `settles after ${fmt(barRuns[barRuns.length - 1]?.start)} / ${atBarSpeed.map((e) => fmt(e.runs[e.runs.length - 1]?.start)).join(", ")}`
    : `pace ${pace?.toFixed(3) ?? "—"} (of the nominal time: bar ${barPace?.toFixed(3) ?? "—"}, emulator ${emuPaces.map((p) => p?.toFixed(3) ?? "—").join(", ")}); ` +
      `first change ${fmt(barStart)} / ${emuStarts.map(fmt).join(", ")}`;
  console.log(`  ${problems.length ? "DIFF" : "ok  "} ${name}: ${barFrames.length - missing.length} of ${barFrames.length} bar frames are the emulator's (it shows ${nominal.frames.size - 1}); ${timing}`);
  for (const p of problems) console.log(`         ${p}`);
  if (args.includes("--signatures")) {
    const signature = (runs) => hashOf(runs.map((r) => `${r.hash}@${r.start}`).join(",")).slice(0, 8);
    console.log(`         playbacks: nominal ${signature(timeline)}, at bar speed ${atBarSpeed.map((e) => signature(e.runs.slice(1))).join(", ")}`);
  }
  if (missing.length && args.includes("--images")) {
    const dir = join(outputDir("timed"), name);
    mkdirSync(dir, { recursive: true });
    for (const f of missing.slice(0, 20)) writeFileSync(join(dir, `bar-${f.hash}.png`), framePng(f.frame));
    console.log(`         the bar's frames: ${dir}`);
  }
}
agent.destroy();
await target.stop();
if (!record) {
  console.log(failed ? `${failed} scenes differ from the bar` : "all scenes agree with the bar");
  totals({ pass: passed, fail: failed });
}
process.exit(record ? (failed ? 1 : 0) : process.exitCode);
