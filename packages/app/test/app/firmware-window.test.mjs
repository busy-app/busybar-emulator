// The BUSY Bar's firmware in the device window (EMU-322), with the real server: the list under the BUSY Bar's name; a
// choice that waits for the restart (Restart BUSY Bar primary, the red line over it) and is still there after the page
// loads again; the restart that applies it, and what the card shows while the BUSY Bar switches; the label of a
// firmware that is not the latest; the mark of an app whose api_version is newer than the BUSY Bar's API, and the
// dialog its Run opens: Switch and run (one action of the desktop app: the switch, then the start), Open manifest (the
// project's manifest in the system's app, the file itself untouched); the notice of a kept firmware that is gone. And
// the card (the owner's design, Figma, 17.11) at six widths from the smallest window in each of these states: its
// layout for its width, its height the same in all, nothing running out of it; the firmware under the pointer.
//
// EMU322_SHOTS=<folder> also saves a picture of the window and one of the card in each state at each width.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";

import { DEVICE_MIN_SIZE } from "../../src/windows.mjs";
import { HAS_REAL_SERVER, removeFolder, sleep, targz, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.EMU322_SHOTS || null;
/** The window's widths: the card at 1440 is 992 wide (Figma's full card), at 1300 is 862 (Restart by its verb), at 1140,
    the smallest window, 750 (the compact card); 1280 is the compact card's widest common window. Under the smallest:
    1093, the minimum a 1366×768 screen at 125 % leaves (fitToScreen), 1000 and 900 (a browser), cards of 705, 612 and
    512, with no back display; the window's minimum is lowered for them. */
const WIDTHS = [1920, 1600, 1440, 1300, 1280, DEVICE_MIN_SIZE.minWidth, 1093, 1000, 900];
const HEIGHT = 800;

let app;
let work;
let manifest; // the Forecast project's manifest
const q = (text) => JSON.stringify(text);
const page = (code) => app.page(code).catch((e) => Promise.reject(new Error(`${e.message} in: ${code.slice(0, 160)}`)));
const label = () => page(`document.querySelector("#firmware").textContent`);
/** The firmware that waits, as the uptime's second line has it: for a screen reader, at full length, by its number. */
const pending = () => page(`[...document.querySelectorAll("#fw-pending > span")].map((el) => el.textContent)`);
const PENDING_131 = ["Restart to switch to firmware 1.3.1", "Next: firmware 1.3.1", "Next: 1.3.1"];
const row = (id) => `#apps li.app[data-id="${id}"]`;

/** An app installed on the BUSY Bar through its own API, as busy-cli does it, with a script that keeps running. */
async function install(id, name, api) {
  const files = {
    [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name, version: "0.1.0", api_version: api }),
    [`${id}/scripts/main.js`]: "console.log('started'); listen('input', () => {});",
  };
  const bytes = targz(files).toString("base64");
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

/** Projects of the emulator, noted and trusted as Create app leaves them: [id, name, the api_version of its manifest]. */
const listed_ = { trusted: [], noted: [] };
function project(id, name, api) {
  const dir = path.join(work, id);
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: id, private: true, devDependencies: { "@busy-app/cli": "0.6.0" } }));
  const file = path.join(dir, "src", "appmeta", "manifest.json");
  writeFileSync(file, `${JSON.stringify({ format_version: 1, id, name, version: "0.1.0", api_version: api }, null, 2)}\n`);
  const stat = statSync(dir, { bigint: true });
  mkdirSync(path.join(app.folder, "projects"), { recursive: true });
  listed_.trusted.push({ path: dir, dev: String(stat.dev), ino: String(stat.ino), how: "created", at: new Date().toISOString() });
  listed_.noted.push({ path: dir, volume: path.parse(dir).root, id, name, at: new Date().toISOString() });
  writeFileSync(path.join(app.folder, "projects", "trusted.json"), JSON.stringify({ version: 2, projects: listed_.trusted }));
  writeFileSync(path.join(app.folder, "projects", "registry.json"), JSON.stringify({ version: 1, projects: listed_.noted }));
  return file;
}

/** POST /_emu/firmware on the management address, with the key the server wrote for this start; not waited for. */
async function useFirmware(version, when = "now") {
  const { controlPort } = await app.run((shell) => shell.keeper.state);
  const key = readFileSync(path.join(app.folder, "key"), "utf8").trim();
  return fetch(`http://127.0.0.1:${controlPort}/_emu/firmware`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ version, when }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

/** Clicks through the shell, as the person's (a gesture: the desktop app does the action). */
const click = (selector) => app.click(selector);

/** A row's button, which shows under the pointer or with the focus (a hidden window has no pointer over it): the focus
    comes to it first, then the click. */
async function clickInRow(selector) {
  // The list is drawn again as things change (the projects come, a job ends): the focus is given again until it holds.
  await until(
    () => page(`new Promise((resolve) => {
      const button = document.querySelector(${q(selector)});
      button?.focus();
      setTimeout(() => resolve(Boolean(button?.isConnected && document.activeElement === button && getComputedStyle(button).opacity === "1")), 250);
    })`),
    "the row's buttons shown",
  );
  await app.click(selector);
}

/** The page at a width, laid out and painted. A hidden window paints again when its size changes: a pixel less first. */
async function resize(w, h = HEIGHT) {
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h - 1), [w, h]);
  await sleep(80);
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h), [w, h]);
  await sleep(350);
  await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  return page("document.documentElement.clientWidth");
}

/** What is wrong with the BUSY Bar's card now: plain sentences, empty when nothing is. By the card's own width
    (window.css): from 917 everything at full length; 851 to 916 Restart by its verb; under 851 the controls 233 wide,
    the tiles without their names and sliders; under 744 no back display. At every width one row, 166 tall; the back
    display, where it is, 236 by 126. */
const CARD_PROBLEMS = `(() => {
  const problems = [];
  const card = document.querySelector(".device-card");
  const box = card.getBoundingClientRect();
  const width = Math.round(box.width);
  const seen = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest(".unseen");
  const size = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
  if (width < 484) problems.push("the card is under 484, the narrowest it holds: " + width);
  if (card.scrollWidth > card.clientWidth + 1) problems.push("the card scrolls sideways: " + card.scrollWidth + " > " + card.clientWidth);
  if (Math.round(box.height) !== 166) problems.push("the card is " + box.height + " tall, not 166");
  const frame = document.querySelector(".oled-frame");
  const oled = size(frame);
  if (width >= 744 && (oled[0] !== 236 || oled[1] !== 126)) problems.push("the back display is " + oled.join(" by "));
  if (width < 744 && seen(frame)) problems.push("the back display is in a card of " + width);
  for (const el of card.querySelectorAll(".device-body *")) {
    if (!seen(el) || el.closest("svg")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) problems.push((el.id || el.className || el.tagName) + " runs out of the card: " + [r.left, r.right, r.top, r.bottom].map(Math.round).join(","));
  }
  // The lines, the buttons and the tiles are whole: nothing cut, nothing on a second line.
  for (const el of card.querySelectorAll(".device-head, .fw-line, .device-links, .bar-address, .address-field, .fw-pick, #api, #bar-address, #device-uptime, #fw-pending, #power-restart, .set > span, .set .value")) {
    if (!seen(el)) continue;
    const name = el.id || el.className;
    if (el.scrollWidth > el.clientWidth + 1) problems.push(name + " is cut: " + el.scrollWidth + " > " + el.clientWidth);
    if (el.getClientRects().length > 1 || el.getBoundingClientRect().height > 40) problems.push(name + " wraps");
  }
  // The address line fills the controls' width at every width: the field, 3, Local Web (40) against the right edge;
  // Copy at the field's right end, 4 from it (an icon button inside a field).
  const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
  const [column, field, copy, web] = [".device-controls", ".address-field", "#bar-address-copy", "#local-web"].map(rect);
  if (Math.abs(field.width + 3 + web.width - column.width) > 0.5 || Math.abs(web.right - column.right) > 0.5 || web.width !== 40) problems.push("the address line does not fill the controls: field " + field.width + ", Local Web " + web.width + " at " + web.right + ", the column " + column.width + " to " + column.right);
  if (Math.abs(copy.right + 4 - field.right) > 0.5) problems.push("Copy is not at the field's right end: " + copy.right + " and " + field.right);
  // An address with the widest five-digit port is whole too (the port is the one part that changes).
  const address = document.querySelector("#bar-address");
  const own = address.textContent;
  address.textContent = "http://127.0.0.1:44444";
  if (address.scrollWidth > address.clientWidth + 1) problems.push("the address with a port of five digits is cut: " + address.scrollWidth + " > " + address.clientWidth);
  address.textContent = own;
  // The layout for the card's width.
  const restart = [...document.querySelectorAll("#power-restart .label, #power-restart .label-short")].filter(seen).map((el) => el.textContent);
  const controls = size(document.querySelector(".device-controls"));
  const named = [...card.querySelectorAll(".set > span:not(.icon):not(.value), .set .slider")].filter(seen).length;
  const idle = document.querySelector("#power-restart").getAttribute("aria-busy") !== "true";
  const want = width >= 917 ? { restart: "Restart BUSY Bar", controls: 340, named: 4 } : width >= 851 ? { restart: "Restart", controls: 340, named: 4 } : { restart: "Restart", controls: 233, named: 0 };
  if (idle && restart.join() !== want.restart) problems.push("Restart says " + JSON.stringify(restart) + " at " + width + ", not " + want.restart);
  if (controls[0] !== want.controls || controls[1] !== 126) problems.push("the controls are " + controls.join(" by ") + " at " + width);
  if (named !== want.named) problems.push(named + " tile names and sliders shown at " + width + ", not " + want.named);
  // The firmware that waits: its words as shown (the long or the short ones) whole in its line.
  const pending = document.querySelector("#fw-pending");
  if (seen(pending)) {
    const shown = [...pending.children].filter((one) => seen(one) && one.getClientRects().length);
    const words = document.createRange();
    if (shown.length !== 1) problems.push("the firmware that waits shows " + shown.length + " of its wordings");
    else {
      words.selectNodeContents(shown[0]);
      const w = words.getBoundingClientRect().width;
      if (w > pending.getBoundingClientRect().width + 0.5) problems.push("the firmware that waits is cut: " + JSON.stringify(shown[0].textContent) + " is " + Math.round(w) + " in " + Math.round(pending.getBoundingClientRect().width));
    }
  }
  // The uptime and the firmware that waits: one line or two, in the 40 of the button's row.
  const lines = [...document.querySelectorAll(".device-uptime > span")].filter(seen);
  if (Math.round(size(document.querySelector(".device-uptime"))[1]) !== 40) problems.push("the uptime's block is not 40 tall");
  if (!document.querySelector("#fw-pending").hidden && lines.at(-1)?.id !== "fw-pending") problems.push("the firmware that waits is not the uptime's second line");
  return problems;
})()`;

/** The page is as wide as asked, or a pixel less: a display's scale (Windows at 175 %) rounds the width in device pixels down. */
const sameWidth = (w, width) => assert.ok(w === width || w === width - 1, `the page is ${w} wide, not ${width}`);

/** The card at every width in the state it is in now; a picture of the window and of the card at each when asked for. */
async function checkWidths(name) {
  const found = [];
  for (const width of WIDTHS) {
    sameWidth(await resize(width), width);
    for (const problem of await page(CARD_PROBLEMS)) found.push(`${name} at ${width}: ${problem}`);
    if (SHOTS) await shoot(`${name}-${width}x${HEIGHT}`);
  }
  return found;
}

/** The pointer at a point of the page, as the system moves it (the browser's own input, so :hover is the page's). */
const pointer = (x, y) =>
  app.run(
    async (shell, _electron, event) => {
      const { debugger: dbg } = shell.windows.current.win.webContents;
      if (!dbg.isAttached()) dbg.attach("1.3");
      await dbg.sendCommand("Input.dispatchMouseEvent", event);
    },
    { type: "mouseMoved", x: Math.round(x), y: Math.round(y), button: "none", buttons: 0, clickCount: 0 },
  );

/** The firmware under the pointer at every width: its word and its caret white, nothing else of it changes (no plate),
    and the whole of its 32 is the pointer's (its edge as well as its middle). */
async function checkHover() {
  const found = [];
  const look = `(() => {
    const fw = document.querySelector("#firmware");
    const style = getComputedStyle(fw);
    return { hover: fw.matches(":hover"), word: getComputedStyle(fw.querySelector(".fw-label")).color, caret: getComputedStyle(fw.querySelector("svg")).color, plate: style.backgroundColor, height: fw.getBoundingClientRect().height };
  })()`;
  try {
    for (const width of WIDTHS) {
      sameWidth(await resize(width), width);
      const r = await page(`(() => { const r = document.querySelector("#firmware").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
      const want = { hover: true, word: "rgb(255, 255, 255)", caret: "rgb(255, 255, 255)", plate: "rgba(0, 0, 0, 0)", height: 32 };
      // Above the word (the 32 is taller than its line), and beside the caret.
      for (const [x, y, where] of [[r.x + r.w / 2, r.y + 2, "above the word"], [r.x + r.w - 2, r.y + r.h / 2, "at the caret's edge"]]) {
        await pointer(x, y);
        await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
        const seen = await page(look);
        if (JSON.stringify(seen) !== JSON.stringify(want)) found.push(`hover ${where} at ${width}: ${JSON.stringify(seen)}`);
      }
      if (SHOTS) await shoot(`hover-firmware-${width}x${HEIGHT}`);
      await pointer(r.x - 100, r.y + 10); // over the back display
      await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
      const away = await page(look);
      if (away.hover || away.word !== "rgb(161, 161, 161)" || away.caret !== "rgb(115, 115, 115)") found.push(`away at ${width}: ${JSON.stringify(away)}`);
    }
  } finally {
    await app.run((shell) => shell.windows.current.win.webContents.debugger.isAttached() && shell.windows.current.win.webContents.debugger.detach());
  }
  return found;
}

/** A picture of the window, and one of the BUSY Bar's card alone (to lay beside Figma's frames). */
async function shoot(name) {
  mkdirSync(SHOTS, { recursive: true });
  // The test's clicks leave the focus on the firmware's button, ringed: the pictures are of the card as it is looked at.
  await page(`(document.activeElement?.blur(), true)`);
  const card = await page(`(() => { const r = document.querySelector(".device-card").getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const [whole, alone] = await app.run(async (shell, _electron, rect) => {
    const contents = shell.windows.current.win.webContents;
    return [(await contents.capturePage()).toPNG().toString("base64"), (await contents.capturePage(rect)).toPNG().toString("base64")];
  }, card);
  writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(whole, "base64"));
  writeFileSync(path.join(SHOTS, `card-${name}.png`), Buffer.from(alone, "base64"));
}

/** The list's items as they read: [version, checked, words]. */
const listed = () =>
  page(`[...document.querySelectorAll(".fw-menu .menu-item")].map((item) => [item.dataset.version, item.getAttribute("aria-checked"), [...item.querySelectorAll(".words > *")].map((one) => one.textContent)])`);

before(async () => {
  if (skip) return;
  work = realpathSync(temporaryFolder());
  app = await launch({ server: "real", welcomed: true });
  await app.waitWindow("device");
  await until(() => page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected");
  await until(async () => (await label()) === "Firmware 1.4.1", "the firmware's label");
  // Weather asks for the API of 1.4.1, Clock for that of 1.3.1; Forecast and Radar are projects (below).
  await install("app.test.weather", "Weather", "27.15.0");
  await install("app.test.clock", "Clock", "27.14.0");
  manifest = project("app.test.forecast", "Forecast", "27.15.0");
  // The copies on the BUSY Bar ask for other APIs than the manifests now: Forecast's an older one, Radar's a newer one.
  await install("app.test.forecast", "Forecast", "27.14.0");
  project("app.test.radar", "Radar", "27.14.0");
  await install("app.test.radar", "Radar", "27.15.0");
  await page(`document.querySelector("#refresh-apps").click(), true`);
  await until(() => page(`document.querySelectorAll("#apps li.app").length === 4`), "four apps listed");
  // Under the smallest window too (WIDTHS): as a small screen lowers the minimum (fitToScreen).
  await app.run((shell) => shell.windows.current.win.setMinimumSize(880, 600));
  await resize(1440);
});

after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

test("the list under the name; a choice waits for the restart, stays after the page loads again, and is taken back", { skip }, async () => {
  assert.equal(await page(`document.querySelector("#firmware").classList.contains("behind")`), false);
  assert.equal(await page(`document.querySelector("#api").textContent`), "API 27.15.0");
  // The card's row: the back display, what the BUSY Bar is (its name and the firmware's line on top, Restart and the
  // uptime with the firmware that waits at the foot), the controls (the address with Copy and Local Web, the settings).
  assert.deepEqual(await page(`[...document.querySelector(".device-body").children].map((el) => el.className)`), ["oled-frame", "device-about", "device-controls"]);
  const parts = `[...document.querySelectorAll(".device-about > *, .about-top > *, .device-links > *, .device-uptime > *, .bar-address > *")].map((el) => el.id || el.className)`;
  assert.deepEqual(await page(parts), ["about-top", "device-head", "builds fw-line", "device-links", "power-restart", "restart-said", "device-uptime", "device-uptime", "fw-pending", "address-field", "local-web"]);

  await click("#firmware");
  await until(() => page(`Boolean(document.querySelector(".fw-menu"))`), "the list open");
  assert.equal(await page(`document.querySelector(".fw-menu .menu-head").textContent`), "Apps, their data and settings stay. The catalog checks apps against the latest, 1.4.1.");
  assert.deepEqual(await listed(), [
    ["1.4.1", "true", ["1.4.1, latest, API 27.15.0", "Storage for apps, console.warn, fetch encodes URLs"]],
    ["1.3.1", "false", ["1.3.1, previous, API 27.14.0"]],
  ]);
  await click(`.fw-menu .menu-item[data-version="1.3.1"]`);
  await until(() => page(`!document.querySelector("#fw-pending").hidden`), "the line over Restart");
  assert.deepEqual(await pending(), PENDING_131);
  // Its words are shortened: its descriptor is the whole sentence (the window's tooltips; no title on worded elements).
  assert.deepEqual(await page(`[document.querySelector("#fw-pending").dataset.tip, document.querySelector("#fw-pending").getAttribute("title")]`), ["Restart to switch to firmware 1.3.1", null]);
  assert.equal(await label(), "Firmware 1.4.1", "the label names the firmware that runs");
  assert.equal(await page(`document.querySelector("#power-restart").classList.contains("solid")`), true);
  assert.equal((await useFirmware("1.3.1", "restart")).body.pending.version, "1.3.1", "the server has it");

  await click("#firmware");
  await until(() => page(`Boolean(document.querySelector(".fw-menu"))`), "the list open again");
  assert.deepEqual(await listed(), [
    ["1.4.1", "false", ["1.4.1, latest, API 27.15.0", "Storage for apps, console.warn, fetch encodes URLs", "Running now"]],
    ["1.3.1", "true", ["1.3.1, previous, API 27.14.0", "After restart"]],
  ]);
  assert.equal(await page(`getComputedStyle(document.querySelector(".fw-state.pending")).color === getComputedStyle(document.querySelector("#fw-pending")).color`), true, "After restart in the red of the line");
  await click("#firmware");
  assert.equal(await page(`Boolean(document.querySelector(".fw-menu"))`), false, "a second click closes it");

  // A window loaded again shows the choice: it comes from the server.
  await app.run((shell) => shell.windows.current.win.webContents.reload());
  await until(() => page(`document.querySelector("#link")?.classList.contains("live") && !document.querySelector("#fw-pending").hidden`).catch(() => false), "the choice after the page loaded again");
  assert.deepEqual(await pending(), PENDING_131);
  assert.equal(await page(`document.querySelector("#power-restart").classList.contains("solid")`), true);

  // The one that runs, chosen again: nothing waits any more.
  await click("#firmware");
  await until(() => page(`Boolean(document.querySelector(".fw-menu"))`), "the list open");
  await click(`.fw-menu .menu-item[data-version="1.4.1"]`);
  await until(() => page(`document.querySelector("#fw-pending").hidden`), "the line gone");
  assert.equal(await page(`document.querySelector("#power-restart").classList.contains("solid")`), false);
  assert.equal((await useFirmware("1.4.1", "restart")).body.pending, null);
});

test("Restart BUSY Bar applies the choice; while it switches the card says so; on 1.3.1 the label is marked, with no tooltip", { skip }, async () => {
  await click("#firmware");
  await until(() => page(`Boolean(document.querySelector(".fw-menu"))`), "the list open");
  await click(`.fw-menu .menu-item[data-version="1.3.1"]`);
  await until(() => page(`!document.querySelector("#fw-pending").hidden`), "the choice");
  // What the card shows at each change of the stage while it switches.
  await page(`(() => {
    window.__seen = [];
    const look = () => window.__seen.push({
      switching: document.querySelector("#stage").classList.contains("switching"),
      label: document.querySelector("#firmware").textContent,
      api: document.querySelector("#api").hidden,
      restart: document.querySelector("#power-restart").getAttribute("aria-busy"),
      localWeb: document.querySelector("#local-web").getAttribute("aria-disabled"),
      dock: document.querySelector("#dock").inert,
      sets: document.querySelector(".device-card .sets").inert,
      pending: document.querySelector("#fw-pending").hidden,
    });
    new MutationObserver(look).observe(document.querySelector("#stage"), { attributes: true, attributeFilter: ["class"] });
    return true;
  })()`);
  await click("#power-restart");
  await until(async () => (await label()) === "Firmware 1.3.1", "the BUSY Bar on 1.3.1", 30_000);
  const seen = await page("window.__seen");
  assert.deepEqual(seen[0], { switching: true, label: "Switching to 1.3.1", api: true, restart: "true", localWeb: "true", dock: true, sets: true, pending: true });
  const { restart: _restart, ...last } = seen.at(-1); // Restart's own handler says when the BUSY Bar is back up
  assert.deepEqual(last, { switching: false, label: "Firmware 1.3.1", api: false, localWeb: "false", dock: false, sets: false, pending: true });
  await until(() => page(`document.querySelector("#power-restart").getAttribute("aria-busy") === "false"`), "Restart done");
  assert.equal(await page(`document.querySelector("#api").textContent`), "API 27.14.0");
  assert.equal(await page(`document.querySelector("#power-restart").classList.contains("solid")`), false);
  // Not the latest: the label in the warning color (the sound's), and no tooltip on it.
  assert.deepEqual(await page(`(() => {
    const fw = document.querySelector("#firmware");
    const probe = document.createElement("span");
    probe.style.color = "var(--warning)";
    document.body.append(probe);
    const warning = getComputedStyle(probe).color;
    probe.remove();
    return { behind: fw.classList.contains("behind"), warning: getComputedStyle(fw).color === warning, title: fw.getAttribute("title"), tip: fw.dataset.tip ?? null };
  })()`), { behind: true, warning: true, title: null, tip: null });
});

test("what Restart says while it restarts and after: heard through its live region; under 917 it takes the uptime's room", { skip }, async () => {
  const look = () => page(`({ said: document.querySelector("#power-restart").classList.contains("said"), busy: document.querySelector("#power-restart").getAttribute("aria-busy"), live: document.querySelector("#restart-said").textContent, liveRole: document.querySelector("#restart-said").getAttribute("aria-live"), uptime: getComputedStyle(document.querySelector("#device-uptime")).display, name: document.querySelector("#power-restart").getAttribute("aria-label") })`);
  for (const [width, uptime] of [[1440, "block"], [DEVICE_MIN_SIZE.minWidth, "none"]]) {
    await resize(width);
    await until(async () => (await look()).busy === "false" && !(await look()).said, "Restart idle");
    await click("#power-restart");
    await until(async () => (await look()).said, "Restart says how it went", 30_000);
    const seen = await look();
    assert.match(seen.live, /^Back up in \d+\.\d s$/, `the live region at ${width}`);
    assert.deepEqual({ ...seen, live: "" }, { said: true, busy: "false", live: "", liveRole: "polite", uptime, name: "Restart BUSY Bar" }, `at ${width}`);
    await until(async () => !(await look()).said, "its name again", 10_000);
    const after = await look();
    assert.equal(after.live, "");
    assert.notEqual(after.uptime, "none", `the uptime back at ${width}`);
  }
  await resize(1440);
});

test("an app for a newer API is marked with the firmware it needs; one for an older API is not", { skip }, async () => {
  // The projects come from the desktop app a moment after the BUSY Bar's list.
  await until(() => page(`["app.test.weather", "app.test.forecast", "app.test.radar"].every((id) => document.querySelector('#apps li.app[data-id="' + id + '"] .fw-chip'))`), "the marks");
  const chip = (id) => page(`(() => { const c = document.querySelector('${row(id)} .fw-chip'); return c && [c.textContent, c.dataset.tip, c.dataset.tipDetail]; })()`);
  // Radar's manifest asks for 1.3.1's API, the copy on the BUSY Bar for 1.4.1's: marked for that copy.
  assert.deepEqual(await chip("app.test.radar"), ["Needs firmware 1.4.1", "This BUSY Bar runs 1.3.1", "Switch it to 1.4.1 to run Radar."]);
  // Its descriptor from the keyboard too.
  assert.equal(await page(`document.querySelector('${row("app.test.weather")} .fw-chip').tabIndex`), 0);
  assert.deepEqual(await chip("app.test.weather"), ["Needs firmware 1.4.1", "This BUSY Bar runs 1.3.1", "Switch it to 1.4.1 to run Weather."]);
  assert.deepEqual(await chip("app.test.forecast"), ["Needs firmware 1.4.1", "This BUSY Bar runs 1.3.1", "Switch it to 1.4.1 to run Forecast."]);
  assert.equal(await chip("app.test.clock"), null);
  // Whole at the side column's widest and narrowest, clear of the row's buttons.
  for (const width of [1440, DEVICE_MIN_SIZE.minWidth]) {
    await resize(width);
    assert.deepEqual(await page(`[...document.querySelectorAll("#apps .fw-chip")].flatMap((c) => {
      const r = c.getBoundingClientRect();
      const li = c.closest("li").getBoundingClientRect();
      const buttons = c.closest("li").querySelector(".row-actions").getBoundingClientRect();
      return [c.scrollWidth > c.clientWidth + 1 && "cut", (r.left < li.left || r.right > li.right) && "out of the row", r.top < buttons.bottom && r.right > buttons.left && "under the buttons"].filter(Boolean).map((p) => c.closest("li").dataset.id + ": " + p);
    })`), [], `at ${width}`);
  }
  await resize(1440);
});

test("Run of such an app opens the dialog; Open manifest opens the project's manifest, which the emulator does not edit", { skip }, async () => {
  const before = readFileSync(manifest);
  await clickInRow(`${row("app.test.forecast")} button[aria-label="Refresh Forecast"]`);
  await until(() => page(`Boolean(document.querySelector(".fw-dialog"))`), "the dialog");
  assert.deepEqual(await page(`(() => {
    const box = document.querySelector(".fw-dialog");
    return { title: box.querySelector("h2").textContent, about: box.querySelector(".delete-about").textContent, buttons: [...box.querySelectorAll("button")].map((b) => b.textContent), note: box.querySelector(".run-alt p").textContent };
  })()`), {
    title: "Forecast needs firmware 1.4.1",
    about: "This BUSY Bar runs 1.3.1. Switch it to 1.4.1 to run Forecast. Your apps stay.",
    buttons: ["Cancel", "Switch to 1.4.1 and run", "Open manifest"],
    note: 'Should Forecast run on 1.3.1 too? Set "api_version" to "27.14.0" in its manifest.',
  });
  assert.equal(await page(`document.activeElement.textContent`), "Cancel");
  await app.run((shell) => shell.offScreen.opened.splice(0));
  await click("#fw-dialog-manifest");
  await until(() => app.run((shell) => shell.offScreen.opened.length > 0), "the manifest opened");
  assert.deepEqual(await app.run((shell) => shell.offScreen.opened.splice(0)), [realpathSync(manifest)]);
  assert.equal(await page(`Boolean(document.querySelector(".fw-dialog"))`), false, "the dialog closes");
  assert.deepEqual(readFileSync(manifest), before, "the manifest is as it was");
  assert.equal(await label(), "Firmware 1.3.1", "nothing switched");

  // Cancel: nothing happens either.
  await clickInRow(`${row("app.test.forecast")} button[aria-label="Refresh Forecast"]`);
  await until(() => page(`Boolean(document.querySelector(".fw-dialog"))`), "the dialog again");
  await click(".fw-dialog .delete-foot .btn:not(.solid)");
  assert.equal(await page(`Boolean(document.querySelector(".fw-dialog"))`), false);
  assert.equal(await label(), "Firmware 1.3.1");
});

test("Start starts the copy on the BUSY Bar, so its API decides; Refresh builds from the manifest, so the manifest's does", { skip }, async () => {
  // Forecast: the manifest asks for 1.4.1's API (Refresh asked, above), the copy on the BUSY Bar for 1.3.1's: it starts.
  await clickInRow(`${row("app.test.forecast")} button[aria-label="Start Forecast"]`);
  await until(() => page(`Boolean(document.querySelector('${row("app.test.forecast")}.on'))`), "Forecast running", 30_000);
  assert.equal(await page(`Boolean(document.querySelector(".fw-dialog"))`), false, "no dialog");
  await page(`fetch("/api/apps/quit", { method: "POST" }).then((r) => r.status)`);
  await until(() => page(`!document.querySelector('${row("app.test.forecast")}.on')`), "Forecast stopped");
  // Radar: the copy on the BUSY Bar asks for 1.4.1's: Start asks first.
  await clickInRow(`${row("app.test.radar")} button[aria-label="Start Radar"]`);
  await until(() => page(`Boolean(document.querySelector(".fw-dialog"))`), "Radar's dialog");
  assert.equal(await page(`document.querySelector(".fw-dialog h2").textContent`), "Radar needs firmware 1.4.1");
  await click(".fw-dialog .delete-foot .btn:not(.solid)");
  assert.equal(await label(), "Firmware 1.3.1");
});

test("Switch to 1.4.1 and run: the BUSY Bar switches now, then the app starts", { skip }, async () => {
  await clickInRow(`${row("app.test.weather")} button[aria-label="Start Weather"]`);
  await until(() => page(`Boolean(document.querySelector(".fw-dialog"))`), "the dialog");
  assert.equal(await page(`document.querySelector(".fw-dialog .run-alt .btn")`), null, "an app with no project has no manifest to open");
  await click("#fw-dialog-switch");
  await until(async () => (await label()) === "Firmware 1.4.1", "the BUSY Bar on 1.4.1", 30_000);
  await until(() => page(`Boolean(document.querySelector('${row("app.test.weather")}.on'))`), "Weather running", 30_000);
  assert.equal(await page(`Boolean(document.querySelector('${row("app.test.weather")} .fw-chip'))`), false, "no mark on 1.4.1");
  assert.equal(await page(`document.querySelector("#firmware").classList.contains("behind")`), false);
  await page(`fetch("/api/apps/quit", { method: "POST" }).then((r) => r.status)`);
});

test("the BUSY Bar's card at 1920, 1600, 1440, 1300, 1280 and the smallest window: its layout for its width, nothing runs out of it, in every state", { skip }, async (t) => {
  const problems = [];
  // The latest; the firmware under the pointer; a choice waiting for the restart.
  problems.push(...(await checkWidths("latest")));
  problems.push(...(await checkHover()));
  await useFirmware("1.3.1", "restart");
  await until(() => page(`!document.querySelector("#fw-pending").hidden`), "the choice");
  problems.push(...(await checkWidths("pending-1.3.1")));
  await resize(1440);
  await click("#firmware");
  await until(() => page(`Boolean(document.querySelector(".fw-menu"))`), "the list open");
  // The tick is a picture of the icons' sprite: drawn once the sprite is there.
  await until(() => page(`(document.querySelector('.fw-menu .menu-item[aria-checked="true"] svg use')?.getBBox().width ?? 0) > 0`), "the tick drawn");
  await sleep(100);
  if (SHOTS) {
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `pending-list-open-1440x${HEIGHT}.png`), Buffer.from(png, "base64"));
  }
  await click("#firmware");

  // Switching: held at its quiet moment by a request of the BUSY Bar's that is under way (an upload not finished), so
  // that the card can be looked at in that state; the server is paused meanwhile where the system can do that.
  const { port } = await app.run((shell) => shell.keeper.state);
  const upload = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => upload.once("connect", resolve));
  upload.write(`POST /api/apps/stage HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100000\r\n\r\n`);
  upload.write(Buffer.alloc(100));
  await sleep(200);
  const switched = useFirmware("1.3.1", "now");
  await until(() => page(`document.querySelector("#stage").classList.contains("switching")`), "the card switching");
  const pid = process.platform === "win32" ? null : (await app.run((shell) => shell.keeper.pids())).server;
  if (pid) process.kill(pid, "SIGSTOP");
  try {
    assert.equal(await label(), "Switching to 1.3.1");
    problems.push(...(await checkWidths("switching")));
  } finally {
    if (pid) process.kill(pid, "SIGCONT");
    upload.destroy();
  }
  assert.equal((await switched).status, 200);
  await until(async () => (await label()) === "Firmware 1.3.1", "on 1.3.1", 30_000);
  await until(() => page(`document.querySelector("#power-restart").getAttribute("aria-busy") === "false"`), "Restart idle");
  // On 1.3.1, the apps list with its marks; the dialog.
  await until(() => page(`Boolean(document.querySelector('${row("app.test.weather")} .fw-chip'))`), "Weather's mark");
  problems.push(...(await checkWidths("on-1.3.1-apps-marked")));
  await resize(1440);
  // The mark's descriptor, as the pointer over it shows it (a hidden window does not paint it for a picture: the
  // picture of it is taken in a browser, see the pull request).
  await page(`document.querySelector('${row("app.test.weather")} .fw-chip').dispatchEvent(new PointerEvent("pointerover", { bubbles: true }))`);
  await until(() => page(`!document.querySelector("#ac-tip").hidden && document.querySelector("#ac-tip").textContent === "This BUSY Bar runs 1.3.1Switch it to 1.4.1 to run Weather."`), "the mark's descriptor");
  await clickInRow(`${row("app.test.forecast")} button[aria-label="Refresh Forecast"]`);
  await until(() => page(`Boolean(document.querySelector(".fw-dialog"))`), "the dialog");
  problems.push(...(await checkWidths("dialog")));
  await click(".fw-dialog .delete-foot .btn:not(.solid)");
  t.diagnostic(`checked latest, pending-1.3.1, switching, on-1.3.1-apps-marked and dialog at ${WIDTHS.join(", ")}`);
  assert.deepEqual(problems, []);
  await resize(1440);
});

test("a firmware kept for the BUSY Bar that this emulator does not have: the window says so once, the BUSY Bar runs the latest", { skip }, async () => {
  // As after an update that took 1.3.1 away: the data folder names a firmware there is none of.
  writeFileSync(path.join(app.folder, "bar", "chosen-firmware.json"), `${JSON.stringify({ version: "1.2.0" })}\n`);
  const pid = (await app.run((shell) => shell.keeper.pids())).server;
  const starts = await app.run((shell) => shell.keeper.starts);
  process.kill(pid, "SIGKILL");
  await until(() => app.run((shell, _e, n) => shell.keeper.starts > n && shell.keeper.state.name === "ready", starts), "the server started again", 60_000);
  await until(() => page(`!document.querySelector("#fw-toast").hidden`).catch(() => false), "the window's notice", 30_000);
  assert.equal(await page(`document.querySelector("#fw-toast-said").textContent`), "The BUSY Bar runs firmware 1.4.1, the latest: this emulator does not have firmware 1.2.0. It ran 1.2.0 before.");
  assert.equal(await label(), "Firmware 1.4.1");
  if (SHOTS) {
    await resize(1440);
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `notice-1440x${HEIGHT}.png`), Buffer.from(png, "base64"));
  }
  await click("#fw-toast-ok");
  assert.equal(await page(`document.querySelector("#fw-toast").hidden`), true);
  // Said once: the page loaded again does not say it again.
  await app.run((shell) => shell.windows.current.win.webContents.reload());
  await until(() => page(`document.querySelector("#link")?.classList.contains("live")`).catch(() => false), "the page connected again");
  await sleep(500);
  assert.equal(await page(`document.querySelector("#fw-toast").hidden`), true);
});
