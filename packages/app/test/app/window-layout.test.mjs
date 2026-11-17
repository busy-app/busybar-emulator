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
const SIZES = [[1920, 1080], [1440, 900], [1440, 760], [1440, 720], [1440, 700], [1440, 600], [1300, 800], [1280, 800], [1200, 800], [1150, 800], [1140, 900], [1140, 760], [1140, 720], [1140, 700], [1140, 650], null];
const LONG = "Status Board for the Whole Open Space Team";
const EXAMPLES = ["focus-timer", "meeting-cost", "status-board"];

let app;
let work;
const q = (text) => JSON.stringify(text);
const page = (code) => app.page(code).catch((e) => Promise.reject(new Error(`${e.message} in: ${code.slice(0, 160)}`)));
const paint = () => page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");

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

/** The window's buttons and fields in a part of the page (window.css, "The buttons and fields of the whole window"): 40 tall,
    or 32 for the smaller size (.small, and every control of the console's head); a segment 4 less than its group;
    none cut. A page function, given to the page's code by its source. */
const CONTROLS = `function controlProblems(root) {
  const problems = [];
  const seen = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest("[hidden]");
  const name = (el) => (el.id ? "#" + el.id : el.className.baseVal ?? el.className) + (el.textContent.trim() ? " " + JSON.stringify(el.textContent.trim().slice(0, 30)) : "");
  for (const el of root.querySelectorAll(".btn, .icon-btn, input.input, select.input, .ov-input:not(textarea), .select, .seg, .seg > button, .seg > .shot-take, .capture-tools .tool, .console-title, .camera-views button")) {
    if (!seen(el)) continue;
    const h = Math.round(el.getBoundingClientRect().height * 10) / 10;
    const small = el.classList.contains("small") || Boolean(el.closest(".console-card .card-head"));
    const seg = el.parentElement?.classList.contains("seg") || el.parentElement?.classList.contains("camera-views") || el.closest(".capture-tools");
    const want = (small ? 32 : 40) - (seg ? 4 : 0);
    if (h !== want) problems.push(name(el) + " is " + h + " tall, not " + want);
    if (el.matches(".btn") && el.scrollWidth > el.clientWidth + 1) problems.push(name(el) + " is cut: " + el.scrollWidth + " > " + el.clientWidth);
  }
  // A text area: the field's sides and corners, at least 84 tall.
  for (const el of root.querySelectorAll("textarea.input, textarea.ov-input")) if (seen(el) && getComputedStyle(el).minHeight !== "84px") problems.push(name(el) + " is at least " + getComputedStyle(el).minHeight + " tall, not 84px");
  return problems;
}`;

/** What is wrong with the layout as it is now: a list of plain sentences, empty when nothing is. */
const PROBLEMS = `(() => {
  ${CONTROLS}
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
  // The card holds its one row from 744 up (window.css): the smallest window is chosen for that (DEVICE_MIN_SIZE).
  if (r.card && r.card.width < 744) problems.push("the BUSY Bar's card is under 744: " + r.card.width);
  if (r.pane && r.side && !inside(r.pane, r.side)) problems.push("the side column's pane is not inside it");
  // Beside the controls, room for a drag that turns the BUSY Bar in 3D.
  const dock = box("#dock");
  if (dock && r.canvas && (dock.left - r.canvas.left < 24 || r.canvas.right - dock.right < 24)) problems.push("the dock has no room at its sides: " + Math.round(dock.left - r.canvas.left) + " and " + Math.round(r.canvas.right - dock.right));
  for (const key of ["side", "card", "console"]) if (r[key] && !inside(r[key], root.getBoundingClientRect())) problems.push(key + " is not inside the window");
  const top = document.querySelector(".topbar");
  if (top.scrollWidth > top.clientWidth + 1) problems.push("the top bar runs out: " + top.scrollWidth + " > " + top.clientWidth);
  // Its words at every size (no name beside the logo; the logo is named for a screen reader).
  for (const words of document.querySelectorAll("#report-bug span, .top-doc span")) if (!shown(words) || words.scrollWidth > words.clientWidth + 1) problems.push("the top bar's words " + JSON.stringify(words.textContent) + " are not whole");
  if (document.querySelector(".brand").textContent.trim() || document.querySelector("#logo").alt !== "BUSY Bar Emulator") problems.push("the top bar's logo is not as it should be: words beside it, or no name");
  for (const head of document.querySelectorAll(".pane-head, .pane-nav, .console-card .card-head, #app-actions, #app-tabs, .device-card")) {
    if (!shown(head)) continue;
    if (head.scrollWidth > head.clientWidth + 1) problems.push("the head " + (head.id || head.className) + " runs out: " + head.scrollWidth + " > " + head.clientWidth);
    const card = head.getBoundingClientRect();
    for (const child of head.querySelectorAll("h2, button, .toggle, a")) { if (!shown(child)) continue; const c = child.getBoundingClientRect(); if (c.width && !inside(c, card)) problems.push((child.id || child.textContent.trim() || child.className) + " is outside " + (head.id || head.className)); }
  }
  problems.push(...controlProblems(document));
  // An app's name: cut with an ellipsis when long, and clear of the row's buttons.
  if (mode === "all") for (const li of document.querySelectorAll("#apps li.app")) {
    const name = li.querySelector(".app-name");
    const style = getComputedStyle(name);
    if (style.textOverflow !== "ellipsis" || style.whiteSpace !== "nowrap") problems.push("the name of " + li.dataset.id + " is not cut with an ellipsis");
    const n = name.getBoundingClientRect();
    // Hidden, the row's buttons leave the name the whole row: nothing of it under them. Shown (under the pointer or with
    // the focus), they stand over its end: what is left of the name before them is still read (48 px, or the whole
    // name), and the name's descriptor gives it whole.
    const words = document.createRange();
    words.selectNodeContents(name);
    const text = words.getBoundingClientRect();
    const shownButtons = [...li.querySelectorAll(".row-actions > *")].filter((b) => getComputedStyle(b).opacity !== "0" && b.getClientRects().length);
    const end = Math.min(text.right, n.right);
    // "Running" stands beside the name, never over it.
    const live = li.querySelector(".live-state");
    if (live?.getClientRects().length && getComputedStyle(live).opacity !== "0" && overlap({ left: text.left, right: end, top: n.top, bottom: n.bottom }, live.getBoundingClientRect())) problems.push("the name of " + li.dataset.id + " runs under Running");
    if (shownButtons.length) {
      const cover = li.querySelector(".row-actions").getBoundingClientRect().left;
      const read = Math.min(end, cover) - text.left;
      if (read < Math.min(end - text.left, 48)) problems.push("the name of " + li.dataset.id + " has " + Math.round(read) + " px left to read beside its buttons");
    }
    if (name.dataset.tip !== name.textContent) problems.push("the name of " + li.dataset.id + " has no descriptor with it whole");
    if (!inside(n, li.getBoundingClientRect())) problems.push("the name of " + li.dataset.id + " is outside its row");
  }
  if (mode === "app") {
    const title = document.querySelector("#app-title");
    if (title.scrollWidth > title.clientWidth + 1 && getComputedStyle(title).textOverflow !== "ellipsis") problems.push("the app's name runs out of its head");
    for (const button of document.querySelectorAll("#app-actions button")) if (button.scrollWidth > button.clientWidth + 1) problems.push("the button " + button.textContent.trim() + " is cut");
    // The prompt's words cut with an ellipsis inside the button count too ("Prompt fo…").
    for (const words of document.querySelectorAll("#copy-prompt span")) if (shown(words) && words.scrollWidth > words.clientWidth + 1) problems.push("the prompt's words " + JSON.stringify(words.textContent) + " are cut: " + words.scrollWidth + " > " + words.clientWidth);
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

/** The paddings and margins of the side column that must not change with the window's size (no step as it is
    resized): its pane, the app's folder, buttons and tabs. (The stage's gap and foot and the margins round the BUSY Bar
    follow the height smoothly instead, window.css.) */
const CHROME = `(() => {
  const css = (selector, props) => { const el = document.querySelector(selector); if (!el || el.closest("[hidden]")) return null; const st = getComputedStyle(el); return props.map((p) => st[p]).join(" "); };
  return { pane: css(".pane:not([hidden])", ["paddingTop", "paddingLeft", "paddingRight"]), actions: css("#app-pane:not([hidden]) #app-actions", ["marginTop"]), tabs: css("#app-pane:not([hidden]) #app-tabs", ["marginTop"]), folder: css("#app-pane:not([hidden]) #app-folder", ["marginTop"]) };
})()`;

async function check(view, t, states = STATES) {
  const chrome = {};
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
      chrome[name] ??= { at: `${w}×${h}`, values: await page(CHROME) };
      assert.deepEqual(await page(CHROME), chrome[name].values, `${view}, ${name}: the chrome at ${w}×${h} as at ${chrome[name].at}`);
    }
  }
  await state("all");
  t.diagnostic(`checked ${states.join(", ")} at ${SIZES.map((s) => (s ? s.join("×") : "the smallest")).join(", ")}`);
}

test("the device window is no smaller than its layout holds", { skip }, async () => {
  assert.deepEqual(await app.run((shell) => shell.windows.current.win.getMinimumSize()), [DEVICE_MIN_SIZE.minWidth, DEVICE_MIN_SIZE.minHeight]);
  const [w, h] = await resize(null);
  assert.ok(w >= DEVICE_MIN_SIZE.minWidth - 20 && h >= 540, `the smallest page is ${w}×${h}`);
  // There the BUSY Bar's card is about 750 (750 on a 1140 page: Figma's compact frame), and 166 tall as at every width.
  const [cardWidth, cardHeight] = await page(`(() => { const r = document.querySelector(".device-card").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })()`);
  assert.ok(cardWidth >= 744 && cardWidth <= 760, `the card at the smallest window is ${cardWidth}`);
  assert.equal(cardHeight, 166);
});

test("2D: no scroll, no overlap, heads and names fit, in both modes and on every tab, at every size", { skip }, async (t) => {
  assert.equal(await page(`document.querySelector("#view-2d").getAttribute("aria-pressed")`), "true");
  await check("2d", t);
});

test("a running app with a long name: Running beside the name, the name cut before it, at the widest and the smallest window", { skip }, async () => {
  const id = "app.test.long";
  await page(`fetch("/api/apps/launch?app_id=${id}", { method: "POST" }).then((r) => r.status)`);
  await until(() => page(`Boolean(document.querySelector('#apps li.app.on[data-id="${id}"] .live-state'))`), "the long one running");
  try {
    for (const size of [[1920, 1080], null]) {
      const [w, h] = await resize(size);
      await state("all");
      await page(`(document.activeElement?.blur(), true)`);
      assert.deepEqual(await page(PROBLEMS), [], `at ${w}×${h}`);
      // The name is cut with an ellipsis before Running, and Running is whole.
      assert.deepEqual(await page(`(() => {
        const li = document.querySelector('#apps li.app[data-id="${id}"]');
        const name = li.querySelector(".app-name").getBoundingClientRect();
        const live = li.querySelector(".live-state").getBoundingClientRect();
        return { cut: li.querySelector(".app-name").scrollWidth > li.querySelector(".app-name").clientWidth, before: name.right <= live.left + 0.5, whole: li.querySelector(".live-state").scrollWidth <= li.querySelector(".live-state").clientWidth + 1 };
      })()`), { cut: true, before: true, whole: true }, `at ${w}×${h}`);
    }
  } finally {
    await session();
    await resize([1440, 900]);
  }
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

test("the BUSY Bar's card under the smallest window (a small screen lowers it; a browser): no back display, nothing out of it", { skip }, async () => {
  await app.run((shell) => shell.windows.current.win.setMinimumSize(880, 600));
  try {
    for (const width of [1093, 1000, 900]) {
      const [w] = await resize([width, 700]);
      assert.ok(w === width || w === width - 1, `the page is ${w} wide, not ${width}`); // a pixel less where the display's scale rounds the width (Windows at 175 %)
      assert.deepEqual(await page(`(() => {
        const problems = [];
        const card = document.querySelector(".device-card");
        const box = card.getBoundingClientRect();
        if (card.scrollWidth > card.clientWidth + 1) problems.push("the card scrolls sideways");
        if (document.querySelector(".oled-frame").getClientRects().length) problems.push("the back display is in a card of " + Math.round(box.width));
        for (const el of card.querySelectorAll(".device-body *")) {
          const r = el.getBoundingClientRect();
          if (!r.width || el.closest(".unseen, svg")) continue;
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5) problems.push((el.id || el.className || el.tagName) + " runs out of the card");
        }
        for (const el of card.querySelectorAll("#power-restart, #device-uptime, .fw-line, #bar-address")) if (el.getClientRects().length && el.scrollWidth > el.clientWidth + 1) problems.push((el.id || el.className) + " is cut");
        return problems;
      })()`), [], `at ${width}`);
    }
  } finally {
    await app.run((shell, _electron, size) => shell.windows.current.win.setMinimumSize(size.minWidth, size.minHeight), DEVICE_MIN_SIZE);
    await resize([1440, 900]);
  }
});

/** A key pressed as the system sends the person's. */
const key = (keyCode) =>
  app.run((shell, _electron, code) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode: code });
    contents.sendInputEvent({ type: "keyUp", keyCode: code });
  }, keyCode);

/** What is wrong with the dialog the selector names: its controls, and nothing of it out of the window or out of the box. */
const dialogProblems = (box) => page(`(() => {
  ${CONTROLS}
  const root = document.querySelector(${q(box)});
  if (!root) return ["no " + ${q(box)}];
  const problems = controlProblems(root);
  const r = root.getBoundingClientRect();
  // Painted and on top: the page's element at the dialog's middle is the dialog's.
  const middle = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!root.contains(middle)) problems.push("the dialog is not what is at its middle: " + (middle?.className || middle?.nodeName));
  if (r.left < -0.5 || r.top < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) problems.push("the dialog runs out of the window: " + [r.left, r.top, r.right, r.bottom].map(Math.round).join(","));
  for (const el of root.querySelectorAll("button, input, select, textarea, a")) {
    const e = el.getBoundingClientRect();
    if (!e.width || el.closest("[hidden]")) continue;
    if (e.left < r.left - 0.5 || e.right > r.right + 0.5) problems.push((el.id || el.className || el.tagName) + " runs out of the dialog sideways");
  }
  return problems;
})()`);

test("the dialogs at 1440×900 and at the smallest window: the window's buttons and fields, nothing cut or out", { skip }, async (t) => {
  const dialogs = {
    "Create app": { open: () => page(`(document.querySelector("#create-app").click(), true)`), box: ".create-app" },
    "Report a Bug": { open: () => page(`(window.openReportBug(), true)`), box: ".report-bug" },
    "Getting started": { open: () => page(`(document.querySelector(".welcome-link").click(), true)`), box: ".welcome-card" },
    Publish: { open: async () => (await state("app-catalog"), page(`(document.querySelector("#publish").click(), true)`)), box: ".publish" },
    "Delete…": {
      open: async () => {
        await until(async () => (await state("all"), page(`document.querySelector("#side").dataset.mode === "all"`)), "All apps");
        // The row's More, pressed once. What closes a row's menu (window.js: a pointerdown outside it, a scroll, the
        // window's resize or blur) is noted meanwhile, so that a menu that did not stay open says why.
        await page(`(() => {
          window.__menuEvents = [];
          if (!window.__menuNoting) {
            window.__menuNoting = true;
            const note = (e) => window.__menuEvents.push(e.type + (e.type === "scroll" ? " of " + (e.target.id || e.target.className || e.target.nodeName) : ""));
            for (const type of ["scroll", "resize", "blur", "pointerdown"]) addEventListener(type, note, true);
          }
          document.querySelector('#apps li.app[data-id="app.test.clock"] .row-more').click();
          return true;
        })()`);
        const menuOpen = `[...document.querySelectorAll(".row-menu .menu-item")].some((one) => one.textContent.trim() === "Delete…")`;
        await until(() => page(menuOpen), "the row's menu", 5000).catch(async (e) => {
          throw new Error(`${e.message}: ${await page(`(() => { const b = document.querySelector('#apps li.app[data-id="app.test.clock"] .row-more'); const r = b.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return JSON.stringify({ more: [r.left, r.top, r.width, r.height].map(Math.round), at: at?.className, mode: document.querySelector("#side").dataset.mode, items: [...document.querySelectorAll(".row-menu .menu-item")].map((i) => i.textContent.trim()), events: window.__menuEvents }); })()`)}`);
        });
        return page(`([...document.querySelectorAll(".row-menu .menu-item")].find((one) => one.textContent.trim() === "Delete…").click(), true)`);
      },
      box: ".delete-dialog",
    },
  };
  for (const size of [[1440, 900], null]) {
    const [w, h] = await resize(size);
    for (const [title, { open, box }] of Object.entries(dialogs)) {
      await open();
      await until(() => page(`Boolean(document.querySelector(${q(box)})?.getClientRects().length)`), `${title} open`);
      await sleep(400);
      await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
      if (SHOTS) {
        const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
        writeFileSync(path.join(SHOTS, `dialog-${title.replace(/\W+/g, "-").toLowerCase()}-${w}x${h}.png`), Buffer.from(png, "base64"));
      }
      assert.deepEqual(await dialogProblems(box), [], `${title} at ${w}×${h}`);
      await key("Escape");
      await until(() => page(`!document.querySelector(${q(box)})?.getClientRects().length`), `${title} closed`);
    }
  }
  await state("all");
  await page(`(document.activeElement?.blur(), true)`);
  t.diagnostic(`checked ${Object.keys(dialogs).join(", ")} at 1440×900 and the smallest window`);
});

// EMU-325: what the style sheet lays out by itself, which the script measured before.

test("the console's height is the style sheet's: dragged tall it stops where the canvas keeps 252, a lower window takes it back down to 112, a taller one gives it back", { skip }, async () => {
  const sizes = `(() => { const h = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height); return { console: h("#console-card"), canvas: h(".canvas"), kept: document.querySelector("#console-card").style.getPropertyValue("--console-h") }; })()`;
  await state("all");
  await resize([1440, 900]);
  const was = await page(sizes);
  assert.equal(was.kept, "", "no height of the script's until the console is dragged");
  // Dragged up with the keyboard (24 a press), far past what the stage has.
  await page(`(document.querySelector("#console-grip").focus(), true)`);
  try {
    for (let i = 0; i < 30; i++) await key("Up");
    await paint();
    const tall = await page(sizes);
    assert.ok(Math.abs(tall.canvas - 252) <= 1, `the canvas keeps 252 under a console dragged tall: ${JSON.stringify(tall)}`);
    // Dragged past where the stage stops it, the console keeps the height it was shown at, nothing more.
    assert.equal(tall.kept, `${tall.console}px`, "the console's height is the one shown");
    assert.equal(await page(`JSON.parse(localStorage.getItem("busy-emulator.console")).height`), tall.console, "the height kept is the one shown");
    assert.deepEqual(await page(PROBLEMS), [], "dragged tall at 1440×900");
    // The smallest window: the console gives way first, to 112; the page does not scroll.
    await resize(null);
    const low = await page(sizes);
    assert.equal(low.console, 112, `the console at its least in the smallest window: ${JSON.stringify(low)}`);
    assert.equal(low.kept, tall.kept, "the window's size changes nothing the script keeps");
    assert.deepEqual(await page(PROBLEMS), [], "dragged tall, the smallest window");
    // The large window again: the console as tall as it was dragged.
    await resize([1440, 900]);
    assert.equal((await page(sizes)).console, tall.console);
  } finally {
    await page(`(localStorage.removeItem("busy-emulator.console"), document.querySelector("#console-card").style.removeProperty("--console-h"), document.activeElement?.blur(), true)`);
    await resize([1440, 900]);
  }
  assert.equal((await page(sizes)).console, was.console, "back to the height by the page's");
});

test("a setting's description is measured again when the column's width changes: cut where it is cut, a button only then", { skip }, async () => {
  await resize([1920, 1080]);
  await state("app-settings");
  const LONG_WORDS = "One line of a description, and another, and a third, so that at the column's narrowest it takes three lines or more.";
  const look = `(() => { const d = document.querySelector("#app-body .ac-desc"); return { clamped: d.dataset.clamped, role: d.getAttribute("role"), cut: d.scrollHeight > d.clientHeight + 1 }; })()`;
  const original = await page(`document.querySelector("#app-body .ac-desc").textContent`);
  try {
    // Words that take two lines in the widest column (400) and three in the narrowest (342): the same description is
    // whole at one width and cut at the other.
    let found = null;
    for (let n = 60; n <= LONG_WORDS.length && !found; n += 3) {
      const words = LONG_WORDS.slice(0, n);
      await page(`(document.querySelector("#app-body .ac-desc").textContent = ${q(words)}, true)`);
      await resize([1920, 1080]);
      const wide = await page(look);
      if (wide.cut) break;
      await resize(null);
      const narrow = await page(look);
      if (narrow.cut) found = { words, wide, narrow };
    }
    assert.ok(found, "words that are cut in the narrow column only");
    assert.deepEqual([found.wide, found.narrow], [{ clamped: "no", role: null, cut: false }, { clamped: "yes", role: "button", cut: true }], `"${found.words}"`);
    await resize([1920, 1080]);
    assert.deepEqual(await page(look), found.wide, "wide again: not cut, not a button");
  } finally {
    await page(`(document.querySelector("#app-body .ac-desc").textContent = ${q(original)}, true)`);
    await resize([1440, 900]);
    await state("all");
  }
});

test("the project's folder: its own name whole at the field's end at every width, the folders before it cut at their end", { skip }, async () => {
  await state("app-settings");
  const look = `(() => {
    const field = document.querySelector("#app-folder .ac-path");
    const [head, tail] = [field.querySelector(".head"), field.querySelector(".tail")];
    const f = field.getBoundingClientRect(), t = tail.getBoundingClientRect();
    return { tail: tail.textContent, whole: tail.scrollWidth <= tail.clientWidth + 1, inside: t.left >= f.left - 0.5 && t.right <= f.right + 0.5, headCut: head.scrollWidth > head.clientWidth + 1, ellipsis: getComputedStyle(head).textOverflow };
  })()`;
  try {
    for (const size of [[1920, 1080], null, [1440, 900], null]) {
      const [w, h] = await resize(size);
      const at = await page(look);
      // The separator before the project's folder is the tail's: the head's ellipsis does not take it.
      assert.deepEqual({ ...at, headCut: undefined }, { tail: `${path.sep}focus-timer`, whole: true, inside: true, headCut: undefined, ellipsis: "ellipsis" }, `at ${w}×${h}: ${JSON.stringify(at)}`);
      // The test's folder is a long temporary path: in the smallest window its start gives way.
      if (!size) assert.equal(at.headCut, true, `the folders before it cut in the smallest window: ${JSON.stringify(at)}`);
    }
  } finally {
    await resize([1440, 900]);
    await state("all");
  }
});

test("keys typed in the project's folder field (a read-only field, role=textbox) stay there: none reaches the BUSY Bar; Select all selects the path", { skip }, async () => {
  await resize([1440, 900]);
  await state("app-settings");
  await app.run((shell) => shell.windows.current.win.webContents.focus());
  // The column is drawn again as the apps load (which replaces the field and drops its focus): let that settle first.
  await sleep(2000);
  await page(`(window.__targets = [], addEventListener("keydown", (e) => window.__targets.push(e.target.className || e.target.tagName), true), window.__sent = [], window.__fetch = window.fetch, window.fetch = (u, o) => (window.__sent.push(String(u)), window.__fetch(u, o)), document.querySelector("#app-folder .ac-path").focus(), true)`);
  assert.equal(await page(`document.activeElement.matches("#app-folder .ac-path")`), true, "the field has the focus");
  for (const k of ["Right", "Left", "Space", "Enter"]) await key(k);
  await sleep(300);
  const sent = await page(`(window.fetch = window.__fetch, window.__sent.filter((u) => /\\/api\\/input|\\/_emu\\/key/.test(u)))`);
  const targets = await page(`window.__targets`);
  assert.deepEqual(targets, ["path ac-path", "path ac-path", "path ac-path", "path ac-path"], "the keys went to the field");
  assert.deepEqual(sent, [], "arrows, Space and Enter in a read-only text field went to the BUSY Bar");
  // Select all (Cmd+A, Ctrl+A) in the field: the path, not the page.
  await app.run((shell) => {
    const contents = shell.windows.current.win.webContents;
    const modifiers = [process.platform === "darwin" ? "meta" : "control"];
    contents.sendInputEvent({ type: "keyDown", keyCode: "A", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "A", modifiers });
  });
  await sleep(200);
  assert.equal(await page(`getSelection().rangeCount ? getSelection().getRangeAt(0).cloneContents().textContent : ""`), await page(`document.querySelector("#app-folder .ac-path").textContent`), "the selection is the path");
  // Copied, it is the path as it reads (the browser puts a break between its two parts; the field takes it out).
  assert.equal(await page(`(() => { const data = new DataTransfer(); document.querySelector("#app-folder .ac-path").dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true })); return data.getData("text/plain"); })()`), await page(`document.querySelector("#app-folder .ac-path").textContent`), "what is copied");
  await page(`(getSelection().removeAllRanges(), document.activeElement?.blur(), true)`);
});

// From the review of PR 201: Select all looked at e.key, which a Russian layout makes a Cyrillic letter (the page's
// own Select all came back); the copy took every line break out of any selection that started in the field, and the
// spaces round them.
test("the project's folder field: Select all on a Russian layout selects the path; a selection in it copies its own characters, a space at a folder's end kept; one that goes past it copies as the browser has it", { skip }, async () => {
  await resize([1440, 900]);
  await state("app-settings");
  await sleep(2000); // the column drawn again as the apps load (see the test above)
  const field = `document.querySelector("#app-folder .ac-path")`;
  const copied = `(() => { const data = new DataTransfer(); const e = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }); ${field}.dispatchEvent(e); return { prevented: e.defaultPrevented, text: data.getData("text/plain") }; })()`;
  try {
    // Cmd+A (Ctrl+A) where the A key types a Cyrillic letter (U+0444): the key's place is KeyA.
    const russian = await page(`(() => {
      getSelection().removeAllRanges();
      const e = new KeyboardEvent("keydown", { key: String.fromCharCode(0x444), code: "KeyA", ${process.platform === "darwin" ? "metaKey" : "ctrlKey"}: true, bubbles: true, cancelable: true });
      ${field}.dispatchEvent(e);
      return { prevented: e.defaultPrevented, selected: getSelection().rangeCount ? getSelection().getRangeAt(0).cloneContents().textContent : "" };
    })()`);
    assert.deepEqual(russian, { prevented: true, selected: await page(`${field}.textContent`) }, "Select all on a Russian layout");
    // On AZERTY the key at KeyA types "q": Cmd+Q (Ctrl+Q) is not Select all, the field leaves it alone.
    const azerty = await page(`(() => {
      getSelection().removeAllRanges();
      const e = new KeyboardEvent("keydown", { key: "q", code: "KeyA", ${process.platform === "darwin" ? "metaKey" : "ctrlKey"}: true, bubbles: true, cancelable: true });
      ${field}.dispatchEvent(e);
      return { prevented: e.defaultPrevented, ranges: getSelection().rangeCount };
    })()`);
    assert.deepEqual(azerty, { prevented: false, ranges: 0 }, "Cmd+Q on AZERTY, at KeyA, is not Select all");
    // A folder whose name ends with a space, before the project's own folder: copied whole, its space kept.
    const spaced = await page(`(() => { const head = ${field}.querySelector(".head"); head.textContent += " "; getSelection().selectAllChildren(${field}); return ${field}.textContent; })()`);
    assert.ok(spaced.endsWith(` ${path.sep}focus-timer`), spaced);
    assert.deepEqual(await page(copied), { prevented: true, text: spaced }, "the path with a space at a folder's end");
    // From the path's start down into the column: the field leaves it to the browser, line breaks and all.
    const past = await page(`(() => {
      const range = document.createRange();
      range.setStart(${field}.querySelector(".head").firstChild, 0);
      range.setEndAfter(document.querySelector("#app-actions"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return getSelection().toString();
    })()`);
    assert.match(past, /\n/, `the selection runs over several lines: ${JSON.stringify(past)}`);
    assert.deepEqual(await page(copied), { prevented: false, text: "" }, "a selection past the field is not the field's to copy");
  } finally {
    await page(`(getSelection().removeAllRanges(), ${field}.querySelector(".head").textContent = ${field}.querySelector(".head").textContent.replace(/ $/, ""), true)`);
  }
});

test("in a row with Retry, Retry does not move away from under the pointer as the row's other buttons show", { skip }, async () => {
  await resize([1440, 900]);
  await state("all");
  // A row as the window builds it for an app whose dependencies did not come: Start and More, then Retry at the end.
  const at = await page(`(() => {
    const li = document.querySelector('#apps li.app[data-id="app.example.focus_timer"]');
    const actions = li.querySelector(".row-actions");
    for (const b of [...actions.children]) if (!b.matches(".row-more") && !b.ariaLabel?.startsWith("Start")) b.remove();
    const retry = document.createElement("button");
    retry.className = "btn row-retry";
    retry.textContent = "Retry";
    actions.append(retry);
    const r = retry.getBoundingClientRect();
    return { x: Math.round(r.right - 6), y: Math.round(r.top + r.height / 2), right: r.right, left: r.left };
  })()`);
  // The pointer comes onto Retry's right end from above, as a hand moving to it does.
  await app.run((shell, _e, p) => shell.windows.current.win.webContents.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y - 40 }), at);
  await app.run((shell, _e, p) => shell.windows.current.win.webContents.sendInputEvent({ type: "mouseMove", x: p.x, y: p.y }), at);
  await paint();
  const under = await page(`(() => { const el = document.elementFromPoint(${at.x}, ${at.y}); const r = document.querySelector("#apps .row-retry").getBoundingClientRect(); return { under: el?.closest("button")?.className ?? el?.className, retryLeft: r.left, retryRight: r.right }; })()`);
  await page(`(document.querySelector("#refresh-apps")?.click(), true)`);
  assert.match(String(under.under), /row-retry/, `what is under the pointer where Retry was: ${JSON.stringify({ before: at, after: under })}`);
});

test("a narrow console: the kinds of line are a pop-up under their button, closed by a click elsewhere or Escape", { skip }, async () => {
  await app.run((shell) => shell.windows.current.win.setMinimumSize(880, 600));
  try {
    await resize([900, 700]);
    await state("all");
    const look = `(() => {
      const kinds = document.querySelector("#console-kinds"), button = document.querySelector("#console-kinds-btn");
      const k = kinds.getBoundingClientRect(), b = button.getBoundingClientRect();
      // Under the button, or over it where the window has no room under it; 6 apart; its right edge at the button's.
      return { button: b.width > 0, open: kinds.matches(":popover-open"), shown: k.width > 0, apart: Math.round(k.top >= b.bottom ? k.top - b.bottom : b.top - k.bottom), right: Math.round(k.right - b.right), inside: k.left >= 0 && k.top >= 0 && k.bottom <= innerHeight, kinds: [...kinds.querySelectorAll(".toggle span")].map((s) => s.textContent) };
    })()`;
    const closed = await page(look);
    assert.deepEqual([closed.button, closed.open, closed.shown], [true, false, false], "the button, the pop-up closed");
    await app.click("#console-kinds-btn");
    const open = await page(look);
    assert.deepEqual(open, { button: true, open: true, shown: true, apart: 6, right: 0, inside: true, kinds: ["Lifecycle", "Build", "System"] });
    // A kind ticked off in it: the menu stays.
    await app.click("#console-kinds .toggle:nth-child(3)");
    assert.equal((await page(look)).open, true, "a tick in the menu keeps it open");
    await app.click("#console-kinds .toggle:nth-child(3)");
    // A click elsewhere closes it; so does Escape.
    await app.click("#console");
    assert.equal((await page(look)).open, false, "a click elsewhere closes it");
    await app.click("#console-kinds-btn");
    assert.equal((await page(look)).open, true);
    // Escape is the browser's close request: it goes to the page that has the keyboard (a hidden window's is given it).
    await app.run((shell) => shell.windows.current.win.webContents.focus());
    await key("Escape");
    await until(async () => !(await page(look)).open, "Escape to close it");
    // Open as the window is made wider: the resize closes it, and the wide console has the kinds in its head.
    await app.click("#console-kinds-btn");
    assert.equal((await page(look)).open, true);
    await resize([1440, 900]);
    const wide = await page(look);
    assert.deepEqual([wide.open, wide.button, wide.shown], [false, false, true]);
    assert.deepEqual(await page(PROBLEMS), [], "the wide console after the pop-up");
  } finally {
    await app.run((shell, _electron, size) => shell.windows.current.win.setMinimumSize(size.minWidth, size.minHeight), DEVICE_MIN_SIZE);
    await resize([1440, 900]);
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

// From the review of PR 204: a selection of the path made with the pointer that ends just past the field (a triple-click on
// the folder's name; a drag from the path's start that ends on the Copy button beside it) runs into the blocks after
// the field. Copied, it is still the path: no break between its two parts, no line breaks after it (ada65349 had this).
test("the project's folder field: a triple-click on its folder, or a drag a little past its end, copies the path without line breaks", { skip }, async () => {
  await resize([1440, 900]);
  await state("app-settings");
  await app.run((shell) => shell.windows.current.win.webContents.focus());
  await sleep(2000); // the column drawn again as the apps load
  const field = `document.querySelector("#app-folder .ac-path")`;
  const geo = await page(`(() => { const t = ${field}.querySelector(".tail").getBoundingClientRect(); const h = ${field}.querySelector(".head").getBoundingClientRect(); const c = document.querySelector("#app-folder .ac-path-btn").getBoundingClientRect(); return { y: Math.round(t.top + t.height / 2), head: Math.round(h.left + 2), tail: Math.round((t.left + t.right) / 2), copy: Math.round((c.left + c.right) / 2) }; })()`);
  // What Cmd+C copies: the copy event goes to the element where the selection starts; not prevented, the browser's text.
  const copied = `(() => {
    const s = getSelection();
    const start = s.getRangeAt(0).startContainer;
    const data = new DataTransfer();
    const e = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
    (start.nodeType === 3 ? start.parentElement : start).dispatchEvent(e);
    return e.defaultPrevented ? data.getData("text/plain") : s.toString();
  })()`;
  const mouse = (events) => app.run((shell, _e, events) => { const c = shell.windows.current.win.webContents; for (const one of events) c.sendInputEvent(one); }, events);
  const press = (x, n) => [{ type: "mouseDown", x, y: geo.y, button: "left", clickCount: n }, { type: "mouseUp", x, y: geo.y, button: "left", clickCount: n }];
  try {
    const tail = await page(`${field}.querySelector(".tail").textContent`);
    await page(`(getSelection().removeAllRanges(), true)`);
    await mouse([...press(geo.tail, 1), ...press(geo.tail, 2), ...press(geo.tail, 3)]);
    await sleep(300);
    assert.equal(await page(copied), tail, "a triple-click on the project's folder");
    await page(`(getSelection().removeAllRanges(), true)`);
    await mouse([{ type: "mouseDown", x: geo.head, y: geo.y, button: "left", clickCount: 1 }, { type: "mouseMove", x: geo.tail, y: geo.y, button: "left" }, { type: "mouseMove", x: geo.copy, y: geo.y, button: "left" }, { type: "mouseUp", x: geo.copy, y: geo.y, button: "left", clickCount: 1 }]);
    await sleep(300);
    assert.equal(await page(copied), await page(`${field}.textContent`), "a drag from the path's start to the Copy button");
  } finally {
    await page(`(getSelection().removeAllRanges(), true)`);
  }
});
