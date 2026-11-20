// Golden frames: the same scenes on a bar and in the emulator, compared pixel by pixel. A scene is either a
// display/draw request or a walk through the system screens (the apps menu, an app's card, SETUP, the launcher's
// errors).
//
//   node emulator/test/golden.mjs --record [--bar 10.0.4.20]   play each scene on the bar, save its frames as goldens
//   node emulator/test/golden.mjs [--firmware 1.3.1]             play each scene in an emulator of its own, compare with goldens
//   node emulator/test/golden.mjs --emu 127.0.0.1:8640         the same in an emulator that is already running
//   ... [--only <scene>[,<scene>...]]                           those scenes
//   ... [--images]                                              write the comparison image for matching scenes too
//
// The system scenes need the apps the goldens' bar had. An emulator of its own gets them from test/apps (set.json says
// which and in what order, for each firmware); one at --emu must have them installed, in that order; a bar that is
// recorded must list them (its debug apps aside). They install a broken probe app for the error screen and remove it
// afterwards. A scene that came with a firmware (SINCE: the SETUP screen of 1.4.1) is played on it and later ones.
//
// Goldens live in emulator/test/golden/<firmware>/<scene>.json, a folder for each firmware (the one the bar or the
// emulator reports): the bar they came from and its front and back frames, as GET /api/screen returns them. On a
// mismatch the tool writes bar | emulator | difference to <scene>.png in a folder of the system's temporary folder
// (EMU_TEST_OUT when the gate runs it) and prints its path.
//
// Scenes recorded at the BUSY Bar session (bar-session/run.mjs, EMU-348 and EMU-350: an app's own pictures, text outside
// ASCII, an app that fails while it runs) are AWAITING until their golden is there: without one they are not played
// and the line says so; with one they are compared like any other. The pictures are made here (bar-session/png.mjs)
// and uploaded to the scene's app before it draws them.
//
// One scene is not compared whole: the SETUP hint names the bar's USB address, http://10.0.4.20, and the emulator the
// address it answers on (patches.mjs). The address is left out (golden-compare.mjs, SCENE_MASKS); "Set up via", the
// icon, the arrow and the rest are compared pixel for pixel.
//
// The back display's right 12 columns are the firmware's status bar (BACK_STATUS_BAR_WIDTH in gui_i.h): Wi-Fi, BLE,
// sound, USB and battery. The emulator shows Wi-Fi connected, BLE not shown, sound on, USB in and the battery at 100 %
// (packages/engine/native/emu_status.c), as the 1.3.1 goldens' bar did. The 1.4.1 goldens were taken on battery over
// Wi-Fi: in them the USB icon and the battery are not compared (golden-compare.mjs, POWER_MASKED). Everything else of
// both displays is.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";
import { appSetOf, emulatorFor, firmwareAt, outputDir, recordingsDir, totals } from "./own-emulator.mjs";
import { compare, diffImage, maskOf, SCENE_MASKS } from "./golden-compare.mjs";
import { targz } from "./package.mjs";
import { errorApp } from "./bar-session/apps.mjs";
import { png } from "./bar-session/png.mjs";


const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--emu", "--only", "--firmware"], flags: ["--record", "--images"], emulator: "--emu" });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const record = args.includes("--record");
const appsDir = join(dirname(fileURLToPath(import.meta.url)), "apps");
const only = option("--only", null)?.split(",") ?? null;

const APP = "golden";

const xpm = (rows, colors) =>
  ["! XPM2", `${rows[0].length} ${rows.length} ${Object.keys(colors).length} 1`, ...Object.entries(colors).map(([k, v]) => `${k} c ${v}`), ...rows].join("\n");

const text = (font, extra = {}) => [{ id: "t", type: "text", text: "Aa0 BUSY!", font, x: 0, y: 0, ...extra }];

// An app's own pictures (EMU-348), one of each kind a PNG can be: uploaded to the scene's app, drawn by `path`.
const PICTURES = {
  "front-72x16.png": png({ width: 72, height: 16, type: 2, pixel: (x, y) => [(x * 255) / 71, y * 16, 255 - (x * 255) / 71] }),
  "dot-16x16.png": png({ width: 16, height: 16, type: 6, pixel: (x, y) => [255, 220, 0, Math.max(0, Math.min(255, Math.round((7.5 - Math.hypot(x - 7.5, y - 7.5)) * 64)))] }),
  "back-160x80.png": png({ width: 160, height: 80, type: 2, pixel: (x, y) => [(x * 255) / 159, (y * 255) / 79, ((x ^ y) & 16) * 15] }),
  "large-100x24.png": png({ width: 100, height: 24, type: 2, pixel: (x, y) => (((x >> 2) + (y >> 2)) & 1 ? [255, 255, 255] : [0, 80, 255]) }),
  "palette-24x12.png": png({ width: 24, height: 12, type: 3, palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]], alpha: [0], pixel: (x, y) => [(x >> 3) + (y >= 6 ? 1 : 0)] }),
  "gray-32x16.png": png({ width: 32, height: 16, type: 0, pixel: (x) => [x * 8] }),
  "gray-alpha-16x16.png": png({ width: 16, height: 16, type: 4, pixel: (x, y) => [200, ((x + y) & 1) * 255] }),
};
// Text outside ASCII, by code point: the public tree carries no Cyrillic text (npm run check:export).
const HELLO = String.fromCodePoint(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442);
const nonAscii = (font, text) => [{ id: "t", type: "text", text, font, x: 0, y: 2 }];
const picture = (path, extra = {}) => ({ id: "p", type: "image", path, x: 0, y: 0, ...extra });

// Recorded at the BUSY Bar session (EMU-348, EMU-350): played and compared once their golden is there.
const AWAITING = new Set([
  "png-front-full", "png-alpha-over-rect", "png-back", "png-too-large", "png-palette", "png-gray", "png-gray-alpha",
  "text-cyrillic-small", "text-cyrillic-normal", "text-cyrillic-large", "text-diacritics", "text-symbols", "text-emoji",
  "system-error-throw", "system-error-handler", "system-error-rejection",
]);

// Static scenes: nothing in them moves, so a frame taken a moment after drawing is the same on both sides.
export const scenes = {
  "font-tiny": text("tiny"),
  "font-small": text("small"),
  "font-normal": text("normal"),
  "font-condensed": text("condensed"),
  "font-bold": text("bold"),
  "font-large": text("large"),
  "font-extra_large": text("extra_large"),
  "font-global": text("global"),
  "font-superscript": text("superscript"),
  "text-color-center": [{ id: "t", type: "text", text: "Focus 25:00", font: "normal", x: 36, y: 8, align: "center", color: "#00C0FFFF" }],
  "text-align-bottom-right": [{ id: "t", type: "text", text: "12%", font: "small", x: 72, y: 16, align: "bottom_right", color: "#FF4040FF" }],
  "text-width-clip": [{ id: "t", type: "text", text: "A long line that does not fit", font: "normal", x: 2, y: 4, width: 40 }],
  "text-alpha": [
    { id: "r", type: "rectangle", x: 0, y: 0, width: 72, height: 16, fill: "solid", fill_colors: ["#2040FFFF"], border_width: 0 },
    { id: "t", type: "text", text: "50% alpha", font: "normal", x: 2, y: 4, color: "#FFFFFF80" },
  ],
  "rect-solid": [{ id: "r", type: "rectangle", x: 4, y: 2, width: 30, height: 12, fill: "solid", fill_colors: ["#FF8000FF"], border_width: 0 }],
  "rect-default-border": [{ id: "r", type: "rectangle", x: 4, y: 2, width: 30, height: 12, fill: "solid", fill_colors: ["#008040FF"] }],
  "rect-gradient-h-radius": [
    { id: "r", type: "rectangle", x: 2, y: 1, width: 68, height: 14, radius: 4, fill: "gradient_h", fill_colors: ["#00FF00FF", "#0000FFFF"], border_width: 1, border_color: "#FFFFFFFF" },
  ],
  "rect-gradient-v": [{ id: "r", type: "rectangle", x: 10, y: 0, width: 52, height: 16, fill: "gradient_v", fill_colors: ["#FF0000FF", "#000000FF"], border_width: 0 }],
  "rect-border-only": [{ id: "r", type: "rectangle", x: 1, y: 1, width: 70, height: 14, radius: 2, fill: "none", border_width: 2, border_color: "#FFFF00FF" }],
  "z-index": [
    { id: "a", type: "rectangle", x: 10, y: 2, width: 30, height: 12, fill: "solid", fill_colors: ["#FF0000FF"], border_width: 0, z_index: 20 },
    { id: "b", type: "rectangle", x: 25, y: 4, width: 30, height: 10, fill: "solid", fill_colors: ["#0000FFFF"], border_width: 0, z_index: 10 },
  ],
  "xpm": [
    {
      id: "x",
      type: "xpmbitmap",
      x: 4,
      y: 2,
      data: xpm(["..##..oo", ".#..#.oo", "#....#..", "######..", "#....#oo", "#....#oo"], { ".": "none", "#": "#40FF80", o: "#FF2060" }),
    },
  ],
  "stock-image": [{ id: "i", type: "image", stock_path: "images/checkmark_front_8x8.image", x: 4, y: 4 }],
  "back-text": [
    { id: "f", type: "text", text: "front", font: "normal", x: 0, y: 0 },
    { id: "b", type: "text", text: "Back screen 123", font: "large", display: "back", x: 4, y: 4 },
  ],
  "back-shapes": [
    { id: "f", type: "text", text: "front", font: "normal", x: 0, y: 0 },
    { id: "r", type: "rectangle", display: "back", x: 4, y: 20, width: 100, height: 40, radius: 6, fill: "gradient_h", fill_colors: ["#FFFFFFFF", "#000000FF"], border_width: 1, border_color: "#808080FF" },
    { id: "i", type: "image", display: "back", stock_path: "images/checkmark_back_11x11.image", x: 120, y: 30 },
    { id: "t", type: "text", display: "back", text: "superscript", font: "superscript", x: 110, y: 60, align: "center" },
  ],
  "png-front-full": [picture("front-72x16.png")],
  "png-alpha-over-rect": [
    { id: "r", type: "rectangle", x: 0, y: 0, width: 72, height: 16, fill: "solid", fill_colors: ["#2040FFFF"], border_width: 0 },
    picture("dot-16x16.png", { x: 28, z_index: 10 }),
  ],
  "png-back": [{ id: "f", type: "text", text: "front", font: "normal", x: 0, y: 0 }, picture("back-160x80.png", { display: "back" })],
  "png-too-large": [picture("large-100x24.png")],
  "png-palette": [
    { id: "r", type: "rectangle", x: 0, y: 0, width: 72, height: 16, fill: "solid", fill_colors: ["#808080FF"], border_width: 0 },
    picture("palette-24x12.png", { x: 4, y: 2, z_index: 10 }),
  ],
  "png-gray": [picture("gray-32x16.png", { x: 20 })],
  "png-gray-alpha": [
    { id: "r", type: "rectangle", x: 0, y: 0, width: 72, height: 16, fill: "solid", fill_colors: ["#FF0000FF"], border_width: 0 },
    picture("gray-alpha-16x16.png", { x: 28, z_index: 10 }),
  ],
  "text-cyrillic-small": nonAscii("small", HELLO),
  "text-cyrillic-normal": nonAscii("normal", HELLO),
  "text-cyrillic-large": nonAscii("large", HELLO),
  "text-diacritics": nonAscii("normal", "caf\u00e9 \u00fc\u00f1"),
  "text-symbols": nonAscii("normal", "\u00b0 \u20ac \u2014 \u2713"),
  "text-emoji": nonAscii("normal", "a\u{1F600}b"),
};

// Walks through the system screens. Each starts from the apps list: an app launched through the API and quit again
// leaves the apps menu showing its list, with the first app selected.
const PROBE = "app.golden.syntax";
const keys = async (...names) => {
  for (const key of names) {
    await call("POST", `input?key=${key}`);
    await sleep(500);
  }
};
async function toAppsList() {
  const apps = JSON.parse((await call("GET", "apps/list")).text).apps.filter((a) => a.id !== PROBE);
  if (!apps.length) {
    throw new Error(
      "the system scenes need the apps of test/apps/set.json, installed in that order: run without --emu, and the test starts an emulator " +
        "with them. Or --only <scene> for the draw scenes",
    );
  }
  await call("POST", `apps/launch?app_id=${apps[0].id}`);
  await sleep(2500);
  await call("POST", "apps/quit");
  // The desktop's switch animation, then the menu.
  await sleep(2000);
}

export const flows = {
  "system-apps-list": async () => toAppsList(),
  "system-apps-list-scrolled": async () => {
    await toAppsList();
    await keys("up");
  },
  "system-app-card": async () => {
    await toAppsList();
    await keys("ok");
    await sleep(1000);
  },
  "system-app-card-setup": async () => {
    await toAppsList();
    await keys("ok");
    await sleep(1000);
    await keys("up");
  },
  // Not here: the APPS title card. Its icon is animated, so the frame depends on the moment it is taken; checked by eye
  // (logs of 26.10): the same but for the icon's animation frame.
  "system-error-syntax": async () => {
    await installProbe({ "scripts/main.js": "const x = ;\n" });
    await call("POST", `apps/launch?app_id=${PROBE}`);
    await sleep(2500);
  },
  // An app that fails while it runs (EMU-350): what the BUSY Bar shows 5 s after the start, well past the failure.
  "system-error-throw": async () => {
    await installProbe({ "scripts/main.js": errorApp("throw", PROBE) });
    await call("POST", `apps/launch?app_id=${PROBE}`);
    await sleep(5000);
  },
  "system-error-handler": async () => {
    await installProbe({ "scripts/main.js": errorApp("handler", PROBE) });
    await call("POST", `apps/launch?app_id=${PROBE}`);
    await sleep(1500);
    await call("POST", "input?key=ok");
    await sleep(3500);
  },
  "system-error-rejection": async () => {
    await installProbe({ "scripts/main.js": errorApp("rejection", PROBE) });
    await call("POST", `apps/launch?app_id=${PROBE}`);
    await sleep(5000);
  },
  // SETUP of 1.4.1 (0a11d1f9), of the second app in the list (Weather): its settings, the wheel moved to a switch, and
  // the hint OK opens on its first setting, a place, which the bar cannot edit. Not the first app's (Clock): the front
  // display scrolls a label that does not fit ("Time Format"), and its frame depends on the moment it is taken.
  "system-setup": async () => {
    await toSetup(1);
  },
  "system-setup-scrolled": async () => {
    await toSetup(1);
    await keys("up", "up");
  },
  "system-setup-hint": async () => {
    await toSetup(1);
    await keys("ok");
    await sleep(1000);
  },
};

// The apps of the error scenes (EMU-350): bar-session/apps.mjs, the same ones the BUSY Bar session watches. Each draws a
// line first, so that what the BUSY Bar does with a failing app is seen over the app's own screen; the one with the
// rejection draws it again each second.
// The firmware a scene came with: it is played on that firmware and later ones (a bar on 1.3.1 has another SETUP).
const SINCE = {
  "system-setup": "1.4.1",
  "system-setup-scrolled": "1.4.1",
  "system-setup-hint": "1.4.1",
};
const later = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return true;
};

/** From the apps list to SETUP of the app `index` places down the list. */
async function toSetup(index = 0) {
  await toAppsList();
  await keys(...Array(index).fill("up"), "ok");
  await sleep(1000);
  await keys("up", "ok");
  await sleep(1000);
}

// The system scenes that show the apps menu, and so need the apps of test/apps/set.json; the error scenes do not.
const needsAppsList = (name) => Boolean(flows[name]) && !name.startsWith("system-error");

// After the error screen: back to the list, the probe uninstalled.
async function removeProbe() {
  await keys("back");
  await sleep(1500);
  await call("DELETE", `apps?app_id=${PROBE}`);
}

async function installProbe(files) {
  const manifest = { format_version: 1, id: PROBE, name: "Golden probe", version: "0.1.0", api_version: "27.0.0", debug: false };
  const tgz = targz({ [`${PROBE}/appmeta/manifest.json`]: JSON.stringify(manifest), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${PROBE}/${k}`, v])) });
  const staged = await fetch(`http://${addr}/api/apps/stage`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: tgz });
  const { install_key } = await staged.json();
  if (!install_key) throw new Error("stage failed");
  await call("POST", `apps/install?install_key=${install_key}`);
  await sleep(500);
}

// ---------------------------------------------------------------- talking to a bar or the emulator

async function call(method, path, body) {
  const r = await fetch(`http://${addr}/api/${path}`, { method, body: body && JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}

async function frame(display) {
  const r = await call("GET", `screen?display=${display}`);
  if (r.status !== 200) throw new Error(`GET /api/screen?display=${display}: ${r.status} ${r.text}`);
  return r.text;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function capture(elements, refusable = false) {
  await call("DELETE", `display/draw?application_name=${APP}`);
  // The scene's own pictures, in the app's assets.
  for (const path of new Set(elements.map((e) => e.path).filter(Boolean))) {
    const r = await fetch(`http://${addr}/api/assets/upload?application_name=${APP}&file=${path}`, { method: "POST", body: PICTURES[path] });
    if (r.status !== 200) throw new Error(`upload ${path}: ${r.status} ${await r.text()}`);
  }
  await sleep(150);
  const r = await call("POST", "display/draw", { application_name: APP, priority: 100, elements });
  // A scene of the BUSY Bar session may be refused (a picture larger than the display): the answer is then part of it.
  if (r.status !== 200 && !refusable) throw new Error(`draw: ${r.status} ${r.text}`);
  // Two LVGL refresh periods and the back display's mirror timer are well under this.
  await sleep(400);
  return { ...(r.status !== 200 ? { refused: { status: r.status, text: r.text } } : {}), front: await frame(0), back: await frame(1) };
}

// ---------------------------------------------------------------- main

const all = [...Object.keys(scenes), ...Object.keys(flows)];
for (const one of only ?? []) if (!all.includes(one)) throw new Error(`no scene ${one}: ${all.join(", ")}`);
// The bar, or the emulator: one at --emu, else one of this test's own (with the apps of test/apps for the system scenes).
const target = record ? { addr: option("--bar", "10.0.4.20"), stop: async () => {} } : await emulatorFor(args, { apps: !only || only.some(needsAppsList), name: "golden" });
const addr = target.addr;
// The firmware the bar or the emulator runs: its goldens, and its scenes.
const firmware = target.firmware ?? (await firmwareAt(addr));
const goldenDir = recordingsDir("golden", firmware);
const names = all.filter((n) => (!only || only.includes(n)) && (!SINCE[n] || later(firmware, SINCE[n])));
if (!names.length) throw new Error(`the scenes ${only.join(", ")} came with a later firmware than ${firmware}`);

/** Plays a scene and takes its frames; a system scene cleans up after itself. */
async function play(name) {
  if (scenes[name]) return capture(scenes[name], AWAITING.has(name));
  // Nothing left on the canvas from the draw scenes.
  await call("DELETE", `display/draw?application_name=${APP}`);
  await flows[name]();
  const frames = { front: await frame(0), back: await frame(1) };
  if (name.startsWith("system-error")) await removeProbe();
  return frames;
}
if (record) {
  const info = JSON.parse((await call("GET", "status/firmware")).text);
  console.log(`recording from the bar at ${target.addr}, firmware ${info.version} ${info.commit_hash}, into ${goldenDir}`);
  // The system scenes show the bar's apps by name and icon: the bar must list the names of the set the emulator installs
  // for this firmware, in its order (a stand-in may have another id).
  if (names.some(needsAppsList)) {
    const listed = JSON.parse((await call("GET", "apps/list")).text).apps.filter((a) => !a.is_debug).map((a) => a.name);
    const set = appSetOf(firmware).map((id) => JSON.parse(readFileSync(join(appsDir, id, "appmeta", "manifest.json"), "utf8")).name);
    if (listed.join() !== set.join()) throw new Error(`the bar lists ${listed.join(", ")}; test/apps/set.json has ${set.join(", ")} for ${firmware}`);
  }
  mkdirSync(goldenDir, { recursive: true });
  for (const name of names) {
    const frames = await play(name);
    // The bar is named by its model only: the recordings are published, and a serial number is the owner's (EMU-163).
    const source = { bar: "BUSY Bar", firmware: info.commit_hash, recorded: new Date().toISOString() };
    const what = scenes[name] ? { elements: scenes[name] } : { flow: name };
    // Text outside ASCII as \u escapes: the same JSON, and the public tree carries no Cyrillic text.
    const text = JSON.stringify({ source, ...what, ...frames }, null, 2).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    writeFileSync(join(goldenDir, `${name}.json`), text + "\n");
    console.log(`  ${name}`);
  }
  await call("DELETE", `display/draw?application_name=${APP}`);
  await call("DELETE", `assets/upload?application_name=${APP}`);
} else {
  let failed = 0;
  let awaiting = 0;
  for (const name of names) {
    const file = join(goldenDir, `${name}.json`);
    if (!existsSync(file) && AWAITING.has(name)) {
      // Not a check yet: the BUSY Bar session records it (docs/bar-session.md).
      awaiting++;
      console.log(`  wait ${name}: no golden of ${firmware} yet; the BUSY Bar session records it (node emulator/test/bar-session/run.mjs)`);
      continue;
    }
    if (!existsSync(file)) {
      // A scene that cannot be compared is not a scene that agrees.
      failed++;
      console.log(`  FAIL ${name}: no golden of ${firmware} (node emulator/test/golden.mjs --record --only ${name} with a bar on ${firmware})`);
      continue;
    }
    const golden = JSON.parse(readFileSync(file, "utf8"));
    const actual = await play(name);
    const mask = maskOf(name, firmware);
    const d = compare(golden, actual, mask);
    // A refused draw must be refused alike, with the same answer.
    const refusal = JSON.stringify(golden.refused ?? null) === JSON.stringify(actual.refused ?? null) ? "" : `; the draw: bar ${JSON.stringify(golden.refused ?? "200")}, emulator ${JSON.stringify(actual.refused ?? "200")}`;
    // A refused draw draws nothing: what shows is the device's own screen, which is not the scene's. Its answer is.
    if (golden.refused) d.front = d.back = 0;
    const ok = d.front === 0 && d.back === 0 && !refusal;
    if (!ok) failed++;
    const image = !ok || args.includes("--images") ? join(outputDir("golden"), `${name}.png`) : null;
    if (image) writeFileSync(image, diffImage(golden, actual, mask));
    const left = SCENE_MASKS[name] ? " (the address not compared)" : "";
    console.log(`  ${ok ? "ok  " : "DIFF"} ${name}${ok ? left : `: front ${d.front} px, back ${d.back} px differ${left}${refusal} (${image})`}`);
  }
  await call("DELETE", `display/draw?application_name=${APP}`);
  await call("DELETE", `assets/upload?application_name=${APP}`);
  const played = names.length - awaiting;
  console.log(`${failed ? `${failed} of ${played} scenes differ from the bar on ${firmware}` : `all ${played} scenes match the bar on ${firmware}`}${awaiting ? `; ${awaiting} wait for the BUSY Bar session` : ""}`);
  if (args.includes("--images")) console.log(`images: ${outputDir("golden")}`);
  await target.stop();
  totals({ pass: played - failed, fail: failed });
}
