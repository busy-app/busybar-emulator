// The device window's layout (V2: the top bar, the side column with All apps or the opened app, the stage with the
// bar, its controls, the bar's card and the console) at the sizes it is used at, in both modes of the side column,
// on each tab of the opened app, with the console collapsed, in 2D and in 3D: from a large screen down to the shell's
// smallest window (DEVICE_MIN_SIZE). With the real server and real data: the three example apps as projects of the
// emulator and on the bar (Focus Timer running, a focus session on both displays), and apps of the same name and of a
// long one. At every size the page does not scroll (neither way); the regions do not overlap (the top bar, the side
// column, the canvas, the bar's card, the console; on the canvas the bar, its controls and the camera's views); the
// controls stand inside the canvas with room at their sides; no head runs out of its region; a long app name is cut
// with an ellipsis and stays clear of its row's buttons. No network.
//
// WINDOW_LAYOUT_SHOTS=<folder> also saves a picture of each state at each size.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { DEVICE_MIN_SIZE } from "../../src/windows.mjs";
import { HAS_REAL_SERVER, removeFolder, sleep, targz, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.WINDOW_LAYOUT_SHOTS || null;
const EMULATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
/** The sizes of the window's page, width by height; null: the smallest the shell allows. */
const SIZES = [[1440, 900], [1280, 800], [1200, 800], [1024, 700], [900, 650], null];
const LONG = "Status Board for the Whole Open Space Team";
const EXAMPLES = ["focus-timer", "meeting-cost", "status-board"];

let app;
let work;
const q = (text) => JSON.stringify(text);
const page = (code) => app.page(code).catch((e) => Promise.reject(new Error(`${e.message} in: ${code.slice(0, 160)}`)));

/** The files of a folder, by their path under it. */
function filesOf(dir, prefix = "") {
  const out = {};
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, filesOf(full, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = readFileSync(full);
  }
  return out;
}

/** An app installed on the bar through its own API, as busy-cli does it: its files, and a script that keeps running. */
async function install(id, files) {
  const all = { ...files, [`${id}/scripts/main.js`]: "console.log('started'); listen('input', () => {});" };
  const bytes = targz(all).toString("base64");
  const answer = await page(`(async () => {
    const body = Uint8Array.from(atob(${q(bytes)}), (c) => c.charCodeAt(0));
    const stage = await fetch("/api/apps/stage", { method: "POST", body });
    const said = await stage.text();
    if (stage.status !== 200) return "stage " + stage.status + " " + said;
    const done = await fetch("/api/apps/install?install_key=" + JSON.parse(said).install_key, { method: "POST" });
    return done.status === 200 ? 200 : "install " + done.status + " " + (await done.text());
  })().catch((e) => String(e))`);
  assert.equal(answer, 200, `install ${id}`);
}
const manifestOnly = (id, name) => ({ [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name, version: "0.1.0", api_version: "27.0.0" }) });

/** The examples as projects of the emulator, noted and trusted as Create app leaves them; their apps on the bar. The
    trusted list is written as the server keeps it (projects/trust.mjs): the folder's real path and its number. */
async function examples() {
  const noted = [];
  const trusted = [];
  for (const example of EXAMPLES) {
    const dir = path.join(work, example);
    cpSync(path.join(EMULATOR, "examples", example), dir, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(dir, "src/appmeta/manifest.json"), "utf8"));
    const real = realpathSync(dir);
    const stat = statSync(real, { bigint: true });
    trusted.push({ path: real, dev: String(stat.dev), ino: String(stat.ino), how: "created", at: new Date().toISOString() });
    noted.push({ path: real, volume: path.parse(real).root, id: manifest.id, name: manifest.name, at: new Date().toISOString() });
    const files = {};
    for (const [rel, bytes] of Object.entries(filesOf(path.join(dir, "src")))) if (!rel.endsWith(".ts")) files[`${manifest.id}/${rel}`] = bytes;
    await install(manifest.id, files);
  }
  mkdirSync(path.join(app.folder, "projects"), { recursive: true });
  writeFileSync(path.join(app.folder, "projects", "trusted.json"), JSON.stringify({ version: 2, projects: trusted }));
  writeFileSync(path.join(app.folder, "projects", "registry.json"), JSON.stringify({ version: 1, projects: noted }));
}

/** Focus Timer runs, and a focus session is on both displays, as the app draws it. */
async function session() {
  const id = "app.example.focus_timer";
  await page(`fetch("/api/apps/launch?app_id=${id}", { method: "POST" }).then((r) => r.status)`);
  await until(() => page(`Boolean(document.querySelector('#apps li.app.on[data-id="${id}"]'))`), "Focus Timer running");
  const ends = String(Math.round(Date.now() / 1000) + 21 * 60 + 33);
  const line = (key, text, font, y) => ({ id: key, type: "text", text, font, x: 74, y, align: "top_mid", display: "back" });
  const elements = [
    { id: "ground", type: "rectangle", x: 0, y: 15, width: 72, height: 1, fill: "gradient_h", fill_colors: ["#3F7A22FF", "#12300EFF"], border_width: 0, z_index: 0 },
    { id: "tree", type: "animation", path: "animations/tree_apple.anim", section: "grow8", loop: true, x: 0, y: 0, z_index: 1 },
    { id: "time", type: "countdown", timestamp: ends, direction: "time_left", show_hours: "when_non_zero", color: "#FFFFFFFF", x: 72, y: -1, align: "top_right", z_index: 2 },
    ...[0, 1, 2].map((i) => ({ id: `forest${i}`, type: "image", path: "images/small_apple.png", x: 72 - 8 * (i + 1) + 1, y: 7, z_index: 1 })),
    line("b_title", "FOCUS", "normal", 1),
    { id: "b_time", type: "countdown", timestamp: ends, direction: "time_left", show_hours: "when_non_zero", color: "#FFFFFFFF", x: 74, y: 20, align: "top_mid", display: "back" },
    line("b_forest", "3 trees in the forest", "small", 34),
    line("b_start", "START  pause", "small", 50),
    line("b_back", "BACK  give up", "small", 62),
  ];
  const body = JSON.stringify({ application_name: id, priority: 50, elements });
  assert.equal(await page(`fetch("/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body: ${q(body)} }).then((r) => r.status)`), 200);
}

/** The page at a size, laid out and painted. A hidden window paints again when its size changes: a pixel less first. */
async function resize(size) {
  const [w, h] = size ?? [1, 1];
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h - 1), [w, h]);
  await sleep(100);
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h), [w, h]);
  await sleep(500);
  await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  return page("[document.documentElement.clientWidth, document.documentElement.clientHeight]");
}

/** What is wrong with the layout as it is now: a list of plain sentences, empty when nothing is. */
const PROBLEMS = `(() => {
  const problems = [];
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth) problems.push("the page scrolls sideways: " + root.scrollWidth + " > " + root.clientWidth);
  if (root.scrollHeight > root.clientHeight) problems.push("the page scrolls down: " + root.scrollHeight + " > " + root.clientHeight);
  const shown = (el) => el && !el.closest("[hidden]") && getComputedStyle(el).display !== "none" && getComputedStyle(el).visibility !== "hidden";
  const box = (selector) => { const el = document.querySelector(selector); if (!shown(el)) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? r : null; };
  const overlap = (a, b) => a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const inside = (a, b) => a && b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
  const in3d = Boolean(document.querySelector("#device-view .stage3d"));
  const mode = document.querySelector("#side").dataset.mode;
  const r = { top: box(".topbar"), side: box(".side"), pane: box(mode === "app" ? "#app-pane" : "#apps-pane"), canvas: box(".canvas"), card: box(".device-card"), console: box(".console-card"),
    camera: box("#camera-views"), bar: box("#bar"), strip: box("#strip"), oled: box(".oled-frame"), shot: box("#shot-float"), view: box("#canvas-tools-top"), publish: box("#publish") };
  for (const key of ["top", "side", "pane", "canvas", "card", "console", "strip", "oled", "shot", "view", "publish"]) if (!r[key]) problems.push("no " + key);
  if (in3d && !r.camera) problems.push("no camera's views in 3D");
  if (!in3d && !r.bar) problems.push("no BUSY Bar in 2D");
  const pairs = [["top", "side"], ["top", "canvas"], ["side", "canvas"], ["side", "card"], ["side", "console"], ["canvas", "card"], ["canvas", "console"], ["card", "console"],
    ["camera", "strip"], ["bar", "strip"], ["bar", "camera"], ["shot", "view"], ["view", "publish"], ["shot", "publish"]];
  for (const [a, b] of pairs) if (overlap(r[a], r[b])) problems.push(a + " overlaps " + b);
  for (const key of ["camera", "strip", "bar"]) if (r[key] && r.canvas && !inside(r[key], r.canvas)) problems.push(key + " is not inside the canvas");
  for (const key of ["shot", "view", "publish"]) if (r[key] && r.top && !inside(r[key], r.top)) problems.push(key + " is not inside the top bar");
  if (r.oled && r.card && !inside(r.oled, r.card)) problems.push("the back display is not inside the BUSY Bar's card");
  if (r.pane && r.side && !inside(r.pane, r.side)) problems.push("the side column's pane is not inside it");
  // Beside the controls, room for a drag that turns the BUSY Bar in 3D.
  const dock = box("#dock");
  if (dock && r.canvas && (dock.left - r.canvas.left < 24 || r.canvas.right - dock.right < 24)) problems.push("the dock has no room at its sides: " + Math.round(dock.left - r.canvas.left) + " and " + Math.round(r.canvas.right - dock.right));
  for (const key of ["side", "card", "console"]) if (r[key] && !inside(r[key], root.getBoundingClientRect())) problems.push(key + " is not inside the window");
  const top = document.querySelector(".topbar");
  if (top.scrollWidth > top.clientWidth + 1) problems.push("the top bar runs out: " + top.scrollWidth + " > " + top.clientWidth);
  for (const head of document.querySelectorAll(".pane-head, .pane-nav, .console-card .card-head, #app-actions, #app-tabs, .device-card")) {
    if (!shown(head)) continue;
    if (head.scrollWidth > head.clientWidth + 1) problems.push("the head " + (head.id || head.className) + " runs out: " + head.scrollWidth + " > " + head.clientWidth);
    const card = head.getBoundingClientRect();
    for (const child of head.querySelectorAll("h2, button, .toggle, a")) { if (!shown(child)) continue; const c = child.getBoundingClientRect(); if (c.width && !inside(c, card)) problems.push((child.id || child.textContent.trim() || child.className) + " is outside " + (head.id || head.className)); }
  }
  // An app's name: cut with an ellipsis when long, and clear of the row's buttons.
  if (mode === "all") for (const li of document.querySelectorAll("#apps li.app")) {
    const name = li.querySelector(".app-name");
    const style = getComputedStyle(name);
    if (style.textOverflow !== "ellipsis" || style.whiteSpace !== "nowrap") problems.push("the name of " + li.dataset.id + " is not cut with an ellipsis");
    const n = name.getBoundingClientRect();
    for (const button of li.querySelectorAll(".row-actions button:not(.row-more)")) if (overlap(n, button.getBoundingClientRect())) problems.push("the name of " + li.dataset.id + " runs under its buttons");
    if (!inside(n, li.getBoundingClientRect())) problems.push("the name of " + li.dataset.id + " is outside its row");
  }
  if (mode === "app") {
    const title = document.querySelector("#app-title");
    if (title.scrollWidth > title.clientWidth + 1 && getComputedStyle(title).textOverflow !== "ellipsis") problems.push("the app's name runs out of its head");
    for (const button of document.querySelectorAll("#app-actions button")) if (button.scrollWidth > button.clientWidth + 1) problems.push("the button " + button.textContent.trim() + " is cut");
  }
  return problems;
})()`;

before(async () => {
  if (skip) return;
  work = realpathSync(temporaryFolder());
  app = await launch({ server: "real", welcomed: true });
  await app.waitWindow("device");
  await until(() => page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected");
  await examples();
  await install("app.test.clock", manifestOnly("app.test.clock", "Clock"));
  await install("app.test.clock-two", manifestOnly("app.test.clock-two", "Clock"));
  await install("app.test.long", manifestOnly("app.test.long", LONG));
  await page(`document.querySelector("#refresh-apps").click(), true`);
  await until(() => page(`document.querySelectorAll("#apps li.app").length === 6`), "six apps listed");
  await session();
  await page(`(() => { const kind = document.querySelector('.filters input[data-kind="system"]'); if (!kind.checked) kind.click(); return true; })()`);
  await until(() => page(`document.querySelectorAll("#console .line").length > 0`), "lines in the console");
});
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

/** The window in a state: All apps, the opened app on a tab, the console collapsed. */
async function state(name) {
  const [mode, tab] = name.split("-");
  await page(`(() => {
    const side = document.querySelector("#side");
    const collapsed = document.querySelector("#console-card").classList.contains("collapsed");
    if (collapsed !== ${name === "app-collapsed"}) document.querySelector("#console-collapse").click();
    if (${q(mode)} === "all" && side.dataset.mode !== "all") document.querySelector("#all-apps").click();
    if (${q(mode)} === "app") {
      if (side.dataset.mode !== "app") document.querySelector('#apps li.app[data-id="app.example.focus_timer"]').click();
      document.querySelector("#tab-" + (${q(tab)} === "collapsed" ? "catalog" : ${q(tab)})).click();
    }
    return true;
  })()`);
  const ready = { catalog: ".ac-folds", collapsed: ".ac-folds", files: ".files li", settings: ".settings .field" }[tab];
  if (!ready) return;
  try {
    await until(() => page(`Boolean(document.querySelector("#app-body ${ready}"))`), `the ${tab} page`);
  } catch (e) {
    throw new Error(`${e.message}; the page says: ${await page(`document.querySelector("#app-body").textContent.slice(0, 300)`)}`);
  }
}

const STATES = ["all", "app-settings", "app-catalog", "app-files", "app-collapsed"];

async function check(view, t, states = STATES) {
  for (const size of SIZES) {
    const [w, h] = await resize(size);
    for (const name of states) {
      await state(name);
      await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await sleep(300);
        const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
        writeFileSync(path.join(SHOTS, `${view}-${name}-${w}x${h}${size ? "" : "-min"}.png`), Buffer.from(png, "base64"));
      }
      assert.deepEqual(await page(PROBLEMS), [], `${view}, ${name}, at ${w}×${h}${size ? "" : ", the smallest window"}`);
    }
  }
  await state("all");
  t.diagnostic(`checked ${states.join(", ")} at ${SIZES.map((s) => (s ? s.join("×") : "the smallest")).join(", ")}`);
}

test("the device window is no smaller than its layout holds", { skip }, async () => {
  assert.deepEqual(await app.run((shell) => shell.windows.current.win.getMinimumSize()), [DEVICE_MIN_SIZE.minWidth, DEVICE_MIN_SIZE.minHeight]);
  const [w, h] = await resize(null);
  assert.ok(w >= 860 && h >= 540, `the smallest page is ${w}×${h}`);
});

test("2D: no scroll, no overlap, heads and names fit, in both modes and on every tab, at every size", { skip }, async (t) => {
  assert.equal(await page(`document.querySelector("#view-2d").classList.contains("on")`), true);
  await check("2d", t);
});

test("the opened app's Catalog: a row a field, each opens in place; the icons and what the controls do; its folder is over it", { skip }, async () => {
  await resize([1440, 900]);
  await state("app-catalog");
  const open = (key) => page(`(document.querySelector('#app-body .ac-fold[data-key="${key}"] .ac-fold-row').click(), true)`);
  await open("icons");
  await open("usage");
  const shown = await page(`({
    rows: [...document.querySelectorAll("#app-body .ac-fold-label")].map((label) => label.textContent),
    name: document.querySelector('#app-body .ac-fold[data-key="name"] .ac-fold-value').textContent,
    version: document.querySelector('#app-body .ac-fold[data-key="version"] .ac-fold-value').textContent,
    opened: [...document.querySelectorAll("#app-body .ac-fold-row[aria-expanded=true]")].map((row) => row.closest(".ac-fold").dataset.key),
    keycaps: [...document.querySelectorAll("#app-body .keycap")].map((k) => k.textContent),
    icons: [...document.querySelectorAll("#app-body .icon-tile img")].length,
    uploads: [...document.querySelectorAll("#app-body .icon-tile button")].map((b) => b.ariaLabel),
    chips: [...document.querySelectorAll("#app-body .keycap img")].map((img) => img.complete && img.naturalWidth > 0),
    folder: document.querySelector("#app-folder .ac-path")?.dataset.tipDetail ?? null,
  })`);
  assert.deepEqual(shown.rows, ["Name", "Icons", "Short description", "Description", "Category", "Controls", "Version"]);
  assert.equal(shown.name, "Focus Timer");
  assert.match(shown.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(shown.opened, ["icons", "usage"]);
  assert.deepEqual(shown.keycaps, ["Start", "Wheel turn", "Wheel press", "Back"]);
  assert.equal(shown.icons, 2, "the front and the back icon");
  assert.deepEqual(shown.uploads, ["Upload the front icon", "Upload the back icon"]);
  assert.deepEqual(shown.chips, [true, true, true, true], "each control's chip");
  if (SHOTS) {
    await page(`(document.querySelector("#app-body .controls-list").scrollIntoView({ block: "center" }), true)`);
    await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    await sleep(600);
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, "2d-app-catalog-controls-1440x900.png"), Buffer.from(png, "base64"));
  }
  assert.equal(shown.folder, realpathSync(path.join(work, "focus-timer")));
  await open("icons");
  await open("usage");
  await state("all");
});

test("with the window's own title bar, as on Windows (36 px over the page): the smallest window still holds", { skip }, async () => {
  // On Windows the system's bar is the page's own (title-bar.js): its room is taken from the page's height. Here, on
  // any system, the page is given the class and the room the script gives it, at the smallest window.
  const [w, h] = await resize(null);
  await page(`document.documentElement.classList.add("has-title-bar"), true`);
  try {
    await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    assert.equal(await page(`parseFloat(getComputedStyle(document.body).paddingTop)`), 36, "the page starts under the BUSY Bar");
    for (const name of ["all", "app-catalog"]) {
      await state(name);
      assert.deepEqual(await page(PROBLEMS), [], `2D, ${name}, at ${w}×${h} with the title bar`);
    }
  } finally {
    await state("all");
    await page(`document.documentElement.classList.remove("has-title-bar"), true`);
  }
});

test("3D: no scroll, no overlap, heads and names fit, at every size", { skip }, async (t) => {
  if (await page(`document.querySelector("#view-3d").ariaDisabled === "true"`)) return t.skip(`no 3D view in this run's hidden window: ${await page(`document.querySelector("#view-3d").title`)}`);
  await resize([1200, 800]);
  await page(`document.querySelector("#view-3d").click(), true`);
  await until(() => page(`Boolean(document.querySelector("#device-view .stage3d")) && !document.querySelector("#camera-views").hidden`), "the 3D view");
  await check("3d", t, ["all", "app-catalog", "app-collapsed"]);
  await page(`document.querySelector("#view-2d").click(), true`);
  await until(() => page(`!document.querySelector("#device-view .stage3d")`), "the 2D view again");
});
