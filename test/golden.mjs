// Golden frames: the same scenes on a bar and in the emulator, compared pixel by pixel. A scene is either a
// display/draw request or a walk through the system screens (the apps menu, an app's card, the launcher's errors).
//
//   node emulator/test/golden.mjs --record [--bar 10.0.4.20]   play each scene on the bar, save its frames as goldens
//   node emulator/test/golden.mjs [--firmware dev]             play each scene in an emulator of its own, compare with goldens
//   node emulator/test/golden.mjs --emu 127.0.0.1:8640         the same in an emulator that is already running
//   ... [--only <scene>]                                        one scene
//   ... [--images]                                              write the comparison image for matching scenes too
//
// The system scenes need the apps the goldens' bar had. An emulator of its own gets them from test/apps (set.json says
// which and in what order); one at --emu must have them installed, in that order. They install a broken probe app for
// the error screen and remove it afterwards.
//
// Goldens live in emulator/test/golden/<scene>.json: the bar they came from and its front and back frames, as
// GET /api/screen returns them. On a mismatch the tool writes bar | emulator | difference to <scene>.png in a folder of
// the system's temporary folder (EMU_TEST_OUT when the gate runs it) and prints its path.
//
// The back display's right 12 columns are the firmware's status bar (BACK_STATUS_BAR_WIDTH in gui_i.h): Wi-Fi, BLE,
// sound, USB and battery. The emulator shows the state the goldens' bar had (packages/engine/native/emu_status.c), so the whole
// back display is compared.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import { commandLine } from "../packages/server/arguments.mjs";
import { emulatorFor, outputDir, totals } from "./own-emulator.mjs";
import { targz } from "./package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(here, "golden");

const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--emu", "--only", "--firmware"], flags: ["--record", "--images"], emulator: "--emu" });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const record = args.includes("--record");
const only = option("--only", null);

const APP = "golden";
const FRONT = { width: 72, height: 16 };
const BACK = { width: 160, height: 80 };

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
};

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

// ---------------------------------------------------------------- comparing

const decode = (b64) => Buffer.from(b64, "base64");
const frontPixel = (f, x, y) => {
  const i = (y * FRONT.width + x) * 3;
  return [f[i + 2], f[i + 1], f[i]];
};
const backPixel = (f, x, y) => {
  const i = y * BACK.width + x;
  const v = ((f[i >> 1] >> ((i & 1) * 4)) & 0xf) * 17;
  return [v, v, v];
};

function compare(golden, actual) {
  const result = { front: 0, back: 0 };
  const gf = decode(golden.front), af = decode(actual.front);
  for (let y = 0; y < FRONT.height; y++)
    for (let x = 0; x < FRONT.width; x++) if (frontPixel(gf, x, y).join() !== frontPixel(af, x, y).join()) result.front++;
  const gb = decode(golden.back), ab = decode(actual.back);
  for (let y = 0; y < BACK.height; y++)
    for (let x = 0; x < BACK.width; x++) if (backPixel(gb, x, y).join() !== backPixel(ab, x, y).join()) result.back++;
  return result;
}

// bar | emulator | difference (red where they differ), front above back, each scaled up.
function diffImage(golden, actual) {
  const scale = 4;
  const gap = 4;
  const panels = [
    { w: FRONT.width * 3 * 2, h: FRONT.height * 2, frames: [golden.front, actual.front], px: frontPixel, s: 2, dw: FRONT.width, dh: FRONT.height },
    { w: BACK.width, h: BACK.height, frames: [golden.back, actual.back], px: backPixel, s: 1, dw: BACK.width, dh: BACK.height },
  ];
  const width = (BACK.width * 3 + gap * 2) * scale;
  const height = (FRONT.height * 2 + gap + BACK.height) * scale;
  const rgb = Buffer.alloc(width * height * 3, 40);
  let top = 0;
  for (const p of panels) {
    const [g, a] = p.frames.map(decode);
    for (let y = 0; y < p.dh; y++) {
      for (let x = 0; x < p.dw; x++) {
        const gp = p.px(g, x, y), ap = p.px(a, x, y);
        const same = gp.join() === ap.join();
        const cells = [gp, ap, same ? [0, 0, 0] : [255, 0, 0]];
        cells.forEach((c, k) => {
          for (let dy = 0; dy < p.s * scale; dy++) {
            for (let dx = 0; dx < p.s * scale; dx++) {
              const X = k * (BACK.width + gap) * scale + x * p.s * scale + dx;
              const Y = top + y * p.s * scale + dy;
              rgb.set(c, (Y * width + X) * 3);
            }
          }
        });
      }
    }
    top += (p.dh * p.s + gap) * scale;
  }
  return png(width, height, rgb);
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- main

const names = [...Object.keys(scenes), ...Object.keys(flows)].filter((n) => !only || n === only);
if (!names.length) throw new Error(`no scene ${only}: ${[...Object.keys(scenes), ...Object.keys(flows)].join(", ")}`);
// The bar, or the emulator: one at --emu, else one of this test's own (with the apps of test/apps for the system scenes).
const target = record ? { addr: option("--bar", "10.0.4.20"), stop: async () => {} } : await emulatorFor(args, { apps: names.some((n) => flows[n]), name: "golden" });
const addr = target.addr;

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
if (record) mkdirSync(goldenDir, { recursive: true });

if (record) {
  const firmware = JSON.parse((await call("GET", "status/firmware")).text);
  console.log(`recording from the bar at ${target.addr}, firmware ${firmware.version} ${firmware.commit_hash}`);
  for (const name of names) {
    const frames = await play(name);
    // The bar is named by its model only: the recordings are published, and a serial number is the owner's (EMU-163).
    const source = { bar: "BUSY Bar", firmware: firmware.commit_hash, recorded: new Date().toISOString() };
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
      console.log(`  FAIL ${name}: no golden (node emulator/test/golden.mjs --record --only ${name} with a bar)`);
      continue;
    }
    const golden = JSON.parse(readFileSync(file, "utf8"));
    const actual = await play(name);
    const d = compare(golden, actual);
    const ok = d.front === 0 && d.back === 0;
    if (!ok) failed++;
    const image = !ok || args.includes("--images") ? join(outputDir("golden"), `${name}.png`) : null;
    if (image) writeFileSync(image, diffImage(golden, actual));
    console.log(`  ${ok ? "ok  " : "DIFF"} ${name}${ok ? "" : `: front ${d.front} px, back ${d.back} px differ (${image})`}`);
  }
  await call("DELETE", `display/draw?application_name=${APP}`);
  console.log(failed ? `${failed} of ${names.length} scenes differ from the bar` : `all ${names.length} scenes match the bar`);
  if (args.includes("--images")) console.log(`images: ${outputDir("golden")}`);
  await target.stop();
  totals({ pass: names.length - failed, fail: failed });
}
