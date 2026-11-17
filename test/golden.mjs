// Golden frames: the same scenes on a bar and in the emulator, compared pixel by pixel. A scene is either a
// display/draw request or a walk through the system screens (the apps menu, an app's card, SETUP, the launcher's
// errors).
//
//   node emulator/test/golden.mjs --record [--bar 10.0.4.20]   play each scene on the bar, save its frames as goldens
//   node emulator/test/golden.mjs [--firmware 1.3.1]             play each scene in an emulator of its own, compare with goldens
//   node emulator/test/golden.mjs --emu 127.0.0.1:8640         the same in an emulator that is already running
//   ... [--only <scene>]                                        one scene
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


const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--emu", "--only", "--firmware"], flags: ["--record", "--images"], emulator: "--emu" });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const record = args.includes("--record");
const appsDir = join(dirname(fileURLToPath(import.meta.url)), "apps");
const only = option("--only", null);

const APP = "golden";

const xpm = (rows, colors) =>
  ["! XPM2", `${rows[0].length} ${rows.length} ${Object.keys(colors).length} 1`, ...Object.entries(colors).map(([k, v]) => `${k} c ${v}`), ...rows].join("\n");

const text = (font, extra = {}) => [{ id: "t", type: "text", text: "Aa0 BUSY!", font, x: 0, y: 0, ...extra }];

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

async function capture(elements) {
  await call("DELETE", `display/draw?application_name=${APP}`);
  await sleep(150);
  const r = await call("POST", "display/draw", { application_name: APP, priority: 100, elements });
  if (r.status !== 200) throw new Error(`draw: ${r.status} ${r.text}`);
  // Two LVGL refresh periods and the back display's mirror timer are well under this.
  await sleep(400);
  return { front: await frame(0), back: await frame(1) };
}

// ---------------------------------------------------------------- main

const all = [...Object.keys(scenes), ...Object.keys(flows)];
if (only && !all.includes(only)) throw new Error(`no scene ${only}: ${all.join(", ")}`);
// The bar, or the emulator: one at --emu, else one of this test's own (with the apps of test/apps for the system scenes).
const target = record ? { addr: option("--bar", "10.0.4.20"), stop: async () => {} } : await emulatorFor(args, { apps: !only || Boolean(flows[only]), name: "golden" });
const addr = target.addr;
// The firmware the bar or the emulator runs: its goldens, and its scenes.
const firmware = target.firmware ?? (await firmwareAt(addr));
const goldenDir = recordingsDir("golden", firmware);
const names = all.filter((n) => (!only || n === only) && (!SINCE[n] || later(firmware, SINCE[n])));
if (!names.length) throw new Error(`the scene ${only} came with firmware ${SINCE[only]}; this is ${firmware}`);

/** Plays a scene and takes its frames; a system scene cleans up after itself. */
async function play(name) {
  if (scenes[name]) return capture(scenes[name]);
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
  if (names.some((n) => flows[n])) {
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
    writeFileSync(join(goldenDir, `${name}.json`), JSON.stringify({ source, ...what, ...frames }, null, 2) + "\n");
    console.log(`  ${name}`);
  }
  await call("DELETE", `display/draw?application_name=${APP}`);
} else {
  let failed = 0;
  for (const name of names) {
    const file = join(goldenDir, `${name}.json`);
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
    const ok = d.front === 0 && d.back === 0;
    if (!ok) failed++;
    const image = !ok || args.includes("--images") ? join(outputDir("golden"), `${name}.png`) : null;
    if (image) writeFileSync(image, diffImage(golden, actual, mask));
    const left = SCENE_MASKS[name] ? " (the address not compared)" : "";
    console.log(`  ${ok ? "ok  " : "DIFF"} ${name}${ok ? left : `: front ${d.front} px, back ${d.back} px differ${left} (${image})`}`);
  }
  await call("DELETE", `display/draw?application_name=${APP}`);
  console.log(failed ? `${failed} of ${names.length} scenes differ from the bar on ${firmware}` : `all ${names.length} scenes match the bar on ${firmware}`);
  if (args.includes("--images")) console.log(`images: ${outputDir("golden")}`);
  await target.stop();
  totals({ pass: names.length - failed, fail: failed });
}
