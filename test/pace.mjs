// The pace of animations in an emulator that runs by itself, in real time.
//
// timed.mjs plays its scenes with the emulator's clock held, so it says nothing about how the server delivers ticks:
// a server that gives the firmware half the ticks passes it all the same (EMU-225). This probe draws the same
// animations, lets the emulator run, reads its display as fast as it answers and lays what it saw over the nominal
// timeline of the animation: every frame at the animation's own rate, in whole ticks. The pace is the time the
// emulator took per nominal time. A bar's recording (test/timed/) is laid over the same timeline, so the two can be
// compared; for frame rates no recording has, the pace a stock bar was measured at stands in (the night of 11-12 Nov
// 2026, reports/bar-night-2026-11-12.md, the same method): 60 frames a second 1.216 of the timeline, 33 1.035, 30 to
// 25 1.00 (a frame every five ticks).
//
//   node emulator/test/pace.mjs --emu <address> --timeline <file> --make
//       make the nominal timelines: the emulator at this address must run with --fast (its GUI draws in no time);
//       its clock is held and stepped 8 ms at a time
//   node emulator/test/pace.mjs --emu <address> --timeline <file> [--only anim-loop] [--json <file>] [--expect]
//       measure an emulator that runs at bar speed
//
// The address must be given: the probe draws over whatever the emulator shows and, with --make, holds its clock, so
// it must not land on an emulator somebody is using.
//
// It is a measurement: the pace of 60 frames a second differs by several percent from one run to the next, on a bar
// and in the emulator alike. With --expect it is a check as well: the exit code is 1 unless every scene comes in the
// timeline's order and at the bar's pace within the scene's tolerance: 8 % at 60 frames a second (timed.mjs's; an
// emulator that gets half the ticks plays them 25 % slower than a bar), 2 % at 33, whose ticks a bar misses now and
// then (the full animation's runs spread ±0.3 % around 1.035, the emulator's ±1 %), 3 % for the small animation at
// 33 against its one recording (the bar's runs spread 1.005-1.043, the recording 1.019; the emulator's drawing time
// does not shrink with what is drawn, so it plays it ~1.5 % slower than the bar's mean of 1.025), and 1 % where a bar
// shows a frame every five ticks without fail (its runs spread less than 0.3 %; a live look at the display is ~30 ms
// late or early, which over 8 s is up to 0.4 %).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--emu", "--timeline", "--only", "--json"], flags: ["--make", "--expect"], emulator: "--emu" });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const addr = option("--emu");
const timelineFile = option("--timeline");
if (!addr) {
  console.error("pace.mjs: give --emu <address> of an emulator started for this probe: it draws over the display and may hold the clock.");
  process.exit(2);
}
const only = option("--only", null);
const make = args.includes("--make");
if (!timelineFile) throw new Error("--timeline <file>: where the nominal timelines are kept");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = "emu.pace";
const STEP_MS = 8;

const stock = (name, extra = {}) => [{ id: "a", type: "animation", x: 0, y: 0, stock_path: `shared/${name}`, ...extra }];
// The firmware's coding_72x16.anim (60 frames a second) with another frame rate in its header, uploaded as the app's
// own file: no stock animation runs at these rates.
const uploaded = (fps) => ({
  upload: { from: "coding_72x16.anim", fps, as: `pace${fps}.anim` },
  elements: [{ id: "a", type: "animation", x: 0, y: 0, path: `pace${fps}.anim`, loop: true }],
});
// `seconds`: how long the emulator is watched (as long as a bar's recording, which must fall within the timeline);
// `bar`: the scene of timed.mjs a bar was recorded playing, or the pace
// a stock bar was measured at (`barPace`); `tolerance`: how far from the bar's pace the emulator's may be.
// The animation player's timer runs every 1000 / fps ms (anim_player.c): 16, 30, 33, 38 and 40 ms.
const SCENES = {
  "anim-loop": { fps: 60, seconds: 8, bar: "anim-loop", tolerance: 0.08, elements: stock("coding_72x16.anim", { loop: true }) },
  "anim-once": { fps: 60, seconds: 6, bar: "anim-once", tolerance: 0.08, elements: stock("meeting_72x16.anim", { loop: false }) },
  "anim-small": { fps: 33, seconds: 20, bar: "anim-small", tolerance: 0.03, elements: [{ ...stock("spinner_front_8x8.anim", { loop: true })[0], x: 32, y: 4 }] },
  "anim-33": { fps: 33, seconds: 8, barPace: 1.035, tolerance: 0.02, ...uploaded(33) },
  "anim-30": { fps: 30, seconds: 24, bar: "anim-30", tolerance: 0.01, ...uploaded(30) },
  "anim-26": { fps: 26, seconds: 8, barPace: 0.999, tolerance: 0.01, ...uploaded(26) },
  "anim-25": { fps: 25, seconds: 24, bar: "anim-25", tolerance: 0.01, ...uploaded(25) },
};

async function api(method, path, body) {
  const r = await fetch(`http://${addr}/api/${path}`, { method, body });
  return { status: r.status, text: await r.text() };
}
const time = async (query) => (await fetch(`http://${addr}/_emu/time?${query}`, { method: "POST" })).json();
const hashOf = (frame) => createHash("sha1").update(frame).digest("hex").slice(0, 12);
const screen = async () => hashOf(await (await fetch(`http://${addr}/api/screen?display=0`)).text());

async function prepare(scene) {
  await api("DELETE", `display/draw?application_name=${APP}`);
  if (scene.upload) {
    const bytes = readFileSync(join(here, "../packages/engine/build/apps-assets/shared/animations", scene.upload.from));
    bytes.writeUInt16LE(scene.upload.fps, 16); // the frame rate in a .anim header
    const sent = await api("POST", `assets/upload?application_name=${APP}&file=${scene.upload.as}`, bytes);
    if (sent.status !== 200) throw new Error(`upload: ${sent.status} ${sent.text}`);
  }
}

async function draw(scene) {
  const drawn = await api("POST", "display/draw", JSON.stringify({ application_name: APP, priority: 100, elements: scene.elements }));
  if (drawn.status !== 200) throw new Error(`draw: ${drawn.status} ${drawn.text}`);
}

async function cleanUp(scene) {
  await api("DELETE", `display/draw?application_name=${APP}`);
  if (scene.upload) await api("DELETE", `assets/upload?application_name=${APP}`);
}

/** Adds a look at the display to `runs`: runs of equal frames, [hash, start ms]. */
function look(runs, hash, at) {
  if (runs[runs.length - 1]?.[0] !== hash) runs.push([hash, Math.round(at * 10) / 10]);
}

/** The nominal timeline: the clock held and moved 8 ms at a time, in an emulator whose GUI draws in no time. */
async function nominal(scene) {
  await prepare(scene);
  await sleep(300);
  await time("hold=1");
  try {
    await draw(scene);
    const runs = [];
    // A little longer than the emulator is watched for: an animation that keeps time may get a frame or two ahead.
    for (let at = 0; at <= scene.seconds * 1200; at += STEP_MS) {
      look(runs, await screen(), at);
      await time(`advance=${STEP_MS}`);
    }
    return runs.slice(1); // the first is what was there before the draw
  } finally {
    await time("hold=0");
    await cleanUp(scene);
  }
}

/** The emulator running by itself: what its display shows for `seconds` after the draw. */
async function live(scene) {
  await prepare(scene);
  await sleep(700);
  await draw(scene);
  const t0 = performance.now();
  const runs = [];
  let looks = 0;
  while (performance.now() - t0 < scene.seconds * 1000) {
    const hash = await screen();
    look(runs, hash, performance.now() - t0);
    looks++;
  }
  await cleanUp(scene);
  return { runs, looks };
}

/**
 * Runs laid over a timeline, as timed.mjs does it: each run is matched with the next run of the same frame in the
 * timeline, going forward only. Returns the slope of the line through the pairs (the runs' time per the timeline's)
 * and how many runs found no place.
 */
function overlay(runs, timeline) {
  const pairs = [];
  let unplaced = 0;
  let at = 0;
  for (const [hash, start] of runs) {
    let j = at;
    while (j < timeline.length && timeline[j][0] !== hash) j++;
    if (j === timeline.length) {
      unplaced++;
      continue;
    }
    pairs.push([timeline[j][1], start]);
    at = j;
  }
  if (pairs.length < 2) return { pace: null, unplaced, placed: pairs.length };
  const n = pairs.length;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const pace = sxx ? pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx : null;
  return { pace, unplaced, placed: n };
}

if (make) {
  const timelines = {};
  for (const [name, scene] of Object.entries(SCENES)) {
    timelines[name] = await nominal(scene);
    console.log(`  ${name}: ${timelines[name].length} runs, ${new Set(timelines[name].map((r) => r[0])).size} frames`);
  }
  writeFileSync(timelineFile, JSON.stringify(timelines) + "\n");
  process.exit(0);
}

const timelines = JSON.parse(readFileSync(timelineFile, "utf8"));
const results = {};
const fmt = (v) => (v === null || v === undefined ? "—" : v.toFixed(3));
for (const [name, scene] of Object.entries(SCENES)) {
  if (only && name !== only) continue;
  const timeline = timelines[name];
  const frames = new Set(timeline.map((r) => r[0]));
  const seen = await live(scene);
  // What the display held before the draw took effect is not the scene.
  const runs = seen.runs.filter((r) => frames.has(r[0]));
  const emu = overlay(runs, timeline);
  let bar = null;
  const barFile = scene.bar && join(here, "timed", `${scene.bar}.json`);
  if (barFile && existsSync(barFile)) {
    const recorded = JSON.parse(readFileSync(barFile, "utf8")).runs.map(([hash, start]) => [hash, start]);
    bar = overlay(recorded.filter((r) => frames.has(r[0])), timeline);
  }
  const span = runs.length > 1 ? (runs[runs.length - 1][1] - runs[0][1]) / 1000 : 0;
  results[name] = {
    fps: scene.fps,
    pace: emu.pace,
    unplaced: emu.unplaced,
    changesPerSecond: span ? (runs.length - 1) / span : null,
    looksPerSecond: seen.looks / scene.seconds,
    barPace: bar?.pace ?? scene.barPace ?? null,
    barRecorded: !!bar,
    barUnplaced: bar?.unplaced ?? null,
    tolerance: scene.tolerance,
  };
  results[name].toBar = results[name].barPace && emu.pace ? emu.pace / results[name].barPace : null;
  const r = results[name];
  console.log(
    `  ${name} (${scene.fps} frames/s): the emulator takes ${fmt(r.pace)} of the nominal time` +
      (r.barPace ? `, the bar${r.barRecorded ? "'s recording" : " (measured)"} ${fmt(r.barPace)}, the emulator to the bar ${fmt(r.toBar)}` : ", no pace of a bar") +
      `; ${r.changesPerSecond?.toFixed(1) ?? "—"} frame changes/s seen in ${r.looksPerSecond.toFixed(0)} looks/s` +
      (r.unplaced ? `; ${r.unplaced} runs out of the timeline's order` : ""),
  );
}
let failed = 0;
if (args.includes("--expect")) {
  for (const [name, r] of Object.entries(results)) {
    const problems = [];
    if (r.unplaced) problems.push(`${r.unplaced} runs out of the timeline's order`);
    if (r.toBar === null) problems.push("no pace of a bar to compare with");
    else if (Math.abs(r.toBar - 1) > r.tolerance) problems.push(`${fmt(r.toBar)} of the bar's time (± ${r.tolerance * 100} %)`);
    if (r.pace === null) problems.push("no pace");
    if (problems.length) {
      failed++;
      console.log(`  NOT as expected: ${name}: ${problems.join("; ")}`);
    }
  }
  if (!failed) console.log("  as expected: every scene keeps the bar's pace");
}
if (option("--json")) writeFileSync(option("--json"), JSON.stringify({ platform: `${process.platform} ${process.arch}, Node ${process.version}`, results }, null, 2) + "\n");
process.exit(failed ? 1 : 0);
