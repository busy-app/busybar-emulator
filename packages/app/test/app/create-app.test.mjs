// Create app's pop-up in the real shell (create-app.js and the window's actions): an empty app with its name, short
// description, category and a back icon of its own (the front the default one), made in the default place by the person's clicks; then a copy of an example
// in a place chosen with Change (the tests' stand-in for the system's dialog). The files are looked at: the manifest's
// name and id, catalog.json's texts, both icons in the formats the catalog takes, the example's own icons kept. With the real server and the real
// tools: it needs the npm registry, like actions-project.test.mjs. The second pop-up is opened by the menu's New App….
// Each ends with the app running on the bar (one Refresh after create).
//
// CREATE_SHOTS=<folder> also saves a picture of each way at 1200×800 and 900×650.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { encodePng, shapeOf } from "../fixtures/png.mjs";
import { HAS_REAL_SERVER, removeFolder, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "examples");
const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.CREATE_SHOTS || null;

let app;
let work;
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

const q = (text) => JSON.stringify(text);
const chooses = (folder) => app.run((shell, _electron, answer) => shell.folderDialogs.standIn(answer), folder);
/** A click of the mouse at the middle of an element the page's code finds, brought into view first: the person's. */
async function clickOn(find, what) {
  const at = await app.page(`(() => {
    const one = ${find};
    if (!one) return null;
    one.scrollIntoView({ block: "center" });
    const box = one.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  assert.ok(at, what);
  await app.run((shell, _electron, { x, y }) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }, at);
}
const button = (text) => clickOn(`[...document.querySelectorAll(".create-app button")].find((b) => b.textContent.trim() === ${q(text)} || b.title === ${q(text)})`, `the button ${text}`);
const way = (id) => clickOn(`document.querySelector(${q(`.create-app-way[data-way='${id}']`)})`, `the way ${id}`);
/** Types into a field of the pop-up, as the person does: the value, then the event. */
const type = (part, value) => app.page(`(() => { const el = document.querySelector(${q(`.create-app [data-part='${part}']`)}); el.value = ${q(value)}; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); return true; })()`);
const createState = () => app.page(`(() => { const b = document.querySelector(".create-app [data-part=create]"); return b ? { disabled: b.ariaDisabled, why: b.title } : null; })()`);
/** Create app: the Apps section's button, or the empty list's own when there is no app yet. */
/** The side column back on All apps (layout V2: a created app is opened in it). */
const allApps = () => app.page(`(document.querySelector("#side").dataset.mode === "app" && document.querySelector("#all-apps").click(), true)`);
const openCreate = async () => {
  await allApps();
  await clickOn(`[document.querySelector("#create-app"), document.querySelector("#apps .empty button")].find((b) => b && b.offsetParent !== null)`, "a Create app button");
};
const isOpen = () => app.page(`!(document.querySelector(".create-app-scrim")?.hidden ?? true)`);
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1200, 800],
    [900, 650],
  ]) {
    // A hidden window paints again when its size changes: one pixel less first, so that the picture is of the page
    // as it is now.
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1] - 1), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `${name}-${w}x${h}.png`), Buffer.from(png, "base64"));
  }
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
}
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
/** The id of the app that runs on the emulated bar now. */
const running = async () => JSON.parse(await app.page(`fetch("/_emu/state").then((r) => r.text())`)).running?.id ?? null;
/** A PNG's width, height and color type, from its header. */
const header = (file) => {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), color: bytes[25] };
};

test("Create app: an empty app with its name, texts and icon in the default place; a copy of an example where the person chose", { skip, timeout: 900_000 }, async () => {
  work = realpathSync(temporaryFolder());
  app = await launch({ server: "real", network: "open", welcomed: true });
  await app.waitWindow("device");
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
  // The examples are read when the page loads: the pop-up shows them at once.
  await until(() => app.page(`document.querySelector("#create-app")?.ariaDisabled === "false"`), "Create app to be there to press");

  // ---- the pop-up, on Templates
  await openCreate();
  await until(isOpen, "the pop-up");
  await until(() => app.page(`document.querySelectorAll(".create-app-card").length === 4`), "the template and the three examples");
  assert.deepEqual(await app.page(`[...document.querySelectorAll(".create-app-card b")].map((b) => b.textContent)`), ["Official template", "Focus Timer", "Meeting Cost", "Status Board"]);
  assert.equal(await app.page(`[...document.querySelectorAll(".create-app-card .screen img")].filter((img) => img.complete && img.naturalWidth === 72).length`), 3, "a frame of each example's front display");
  assert.deepEqual(await createState(), { disabled: "true", why: "Choose a template" });
  await shot("1-templates");
  await clickOn(`[...document.querySelectorAll(".create-app-card")][1]`, "the Focus Timer card");
  await until(async () => (await createState()).disabled === "false", "Create to be there to press for the template");
  await shot("2-template-chosen");

  // ---- Import from GitHub: the repository, as which account it is read, where it goes (create-app-open.test.mjs
  // imports one).
  await way("github");
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part=repo]"))`), "the repository's field");
  assert.match(await app.page(`document.querySelector(".create-app-pane").innerText`), /Repository[\s\S]*Location/);
  assert.ok(await app.page(`document.querySelector(".create-app [data-part=import]")?.ariaDisabled === "true"`), "nothing to import yet");
  await shot("3-github");

  // ---- Empty app, written by the person
  await way("empty");
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part=name]"))`), "the empty app's form");
  await type("name", String.fromCodePoint(0x41c, 0x43e, 0x439, 0x20, 0x442, 0x430, 0x439, 0x43c, 0x435, 0x440));
  await until(async () => /Latin letters/.test((await createState()).why), "the name refused by the catalog's rule");
  await type("name", "Focus Timer");
  await type("short", "Short");
  await until(async () => /at least 10/.test((await createState()).why), "the short description refused");
  await type("short", "Shows the focus time left on the BUSY Bar");
  // The categories come with the catalog's rules, which the page loads when the pop-up opens (create-app.js
  // loadRules): on a slower machine (the Windows test machine) they are not there yet at once, and the choice would be lost.
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part=category] option[value=productivity]"))`), "the catalog's categories");
  await type("category", "productivity");
  // The icons: the icon block, no configurator; the default icon on both sides until something is uploaded.
  assert.equal(await app.page(`document.querySelectorAll(".create-app-icon-pick, .create-app-color").length`), 0, "no drawn icons, no colors");
  await until(async () => (await app.page(`[...document.querySelectorAll(".create-app .icon-side .caption")].map((one) => one.textContent).join()`)) === "Default,Default", "the default icon on both sides");
  // A back icon of the person's own, 11×11 gray with transparency: the system's file dialog answered by a stand-in.
  const answer = (name, bytes) => app.page(`(window.emulatorIconBlock.chooseFile = async () => ({ name: ${q(name)}, url: ${q(`data:image/png;base64,${bytes.toString("base64")}`)}, bytes: Uint8Array.from(atob(${q(bytes.toString("base64"))}), (c) => c.charCodeAt(0)) }), true)`);
  // First a picture that breaks two requirements: 16×16, opaque. They turn into errors; the conversion is offered.
  await answer("photo.png", encodePng({ width: 16, height: 16, channels: 4, data: Uint8Array.from({ length: 1024 }, (_, i) => (i % 4 === 3 ? 255 : (i >> 6) % 2 ? 230 : 20)) }));
  await clickOn(`document.querySelector('.create-app [data-part="upload-back"]')`, "the back's Upload");
  await until(async () => (await app.page(`[...document.querySelectorAll(".create-app .icon-back li.bad")].map((li) => li.dataset.need).join()`)) === "size,color", "the size and the shape turned into errors");
  assert.equal(await app.page(`document.querySelector('.create-app [data-part="fix-back"]')?.innerText.trim()`), "Convert to 11×11, gray with transparency");
  if (SHOTS) await app.page(`document.querySelector(".create-app .icon-back .actions").scrollIntoView({ block: "end" })`);
  await shot("4a-empty-icon-failing");
  const back = encodePng({ width: 11, height: 11, channels: 2, data: Uint8Array.from({ length: 242 }, (_, i) => (i % 2 ? (Math.floor(i / 2) % 3 ? 0 : 255) : 255)) });
  await answer("back.png", back);
  await clickOn(`document.querySelector('.create-app [data-part="upload-back"]')`, "the back's Upload");
  await until(() => app.page(`Boolean(document.querySelector(".create-app .icon-back .tile.new img"))`), "the back icon taken");
  assert.equal(await app.page(`document.querySelectorAll(".create-app .icon-back li.ok").length`), 4, "it meets every requirement");
  if (SHOTS) await app.page(`document.querySelector(".create-app .icon-back .actions").scrollIntoView({ block: "end" })`);
  await shot("4b-empty-icons");
  await until(async () => (await createState()).disabled === "false", "Create to be there to press");
  const place = await app.page(`document.querySelector(".create-app-place .path").textContent`);
  // From ~ where the home folder is written so (macOS, Linux); on Windows the whole path, as Explorer shows it.
  assert.equal(place, process.platform === "win32" ? path.join(app.folder, "test-home", "BUSY Bar projects", "focus-timer") : "~/BUSY Bar projects/focus-timer");
  await shot("4-empty");
  await button("Advanced");
  await shot("5-empty-advanced");
  const id = await app.page(`document.querySelector(".create-app [data-part=id]").value`);
  assert.match(id, /^app\.[a-z0-9_-]+\.focus_timer$/);

  await button("Create");
  await until(() => app.page(`document.querySelector(".create-app-said")?.classList.contains("working") ?? false`), "the pop-up to say it works", 10_000, 100);
  await shot("6-creating");
  await until(async () => !(await isOpen()), "the app created and the pop-up gone", 600_000, 500);
  const dir = path.join(app.folder, "test-home", "BUSY Bar projects", "focus-timer");
  const manifest = json(path.join(dir, "src", "appmeta", "manifest.json"));
  assert.deepEqual([manifest.name, manifest.id, manifest.description], ["Focus Timer", id, "Shows the focus time left on the BUSY Bar"]);
  const catalog = json(path.join(dir, "catalog.json"));
  assert.deepEqual([catalog.category, catalog.short_description], ["productivity", "Shows the focus time left on the BUSY Bar"]);
  assert.deepEqual(header(path.join(dir, "src", "appmeta", "icon_front_8x8.png")), { width: 8, height: 8, color: 6 });
  assert.deepEqual(header(path.join(dir, "src", "appmeta", "icon_back_11x11.png")), { width: 11, height: 11, color: 4 });
  // The default front: BUSY's apps symbol (capture/icon-rules.mjs, DEFAULT_ICON).
  assert.equal(shapeOf(readFileSync(path.join(dir, "src", "appmeta", "icon_front_8x8.png"))), ["###..###", "#.#..#.#", "###..###", "........", "........", "###..###", "#.#..#.#", "###..###"].join("\n"), "the default front");
  assert.equal(shapeOf(readFileSync(path.join(dir, "src", "appmeta", "icon_back_11x11.png"))), shapeOf(back), "the back uploaded");
  // The new app is listed and chosen.
  await until(() => app.page(`document.querySelector("#app-title")?.textContent === "Focus Timer"`), "the new app chosen");
  // Create app ends with the app running on the bar: the Refresh that follows built, installed and started it.
  assert.equal(await running(), id);
  assert.match(await app.page(`document.querySelector("#app-status .job .job-line")?.textContent ?? ""`), /is running\.$/);
  assert.deepEqual(readFileSync(path.join(dir, "src", "appmeta", "icon_front_8x8.png")).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // ---- a copy of an example, in a place the person chose with Change; the pop-up opened by the menu's New App…
  assert.equal(await app.run((shell) => shell.newApp()), "pop-up");
  await until(isOpen, "the pop-up again, from the menu");
  await until(() => app.page(`document.querySelectorAll(".create-app-card").length === 4`), "the cards");
  await clickOn(`[...document.querySelectorAll(".create-app-card")][2]`, "the Meeting Cost card");
  await until(async () => (await createState()).disabled === "false", "Create for the template");
  const elsewhere = path.join(work, "my apps");
  mkdirSync(elsewhere, { recursive: true });
  await chooses(elsewhere);
  await button("Change");
  await until(async () => (await app.page(`document.querySelector(".create-app-place .path").textContent`)).endsWith(path.join("my apps", "meeting-cost")), "the place chosen");
  await button("Create");
  await until(async () => !(await isOpen()), "the copy created", 600_000, 500);
  const copy = path.join(elsewhere, "meeting-cost");
  const copied = json(path.join(copy, "src", "appmeta", "manifest.json"));
  assert.equal(copied.name, "Meeting Cost");
  assert.match(copied.id, /^app\.[a-z0-9_-]+\.meeting_cost$/);
  assert.ok(existsSync(path.join(copy, "src", "animations", "fire.anim")), "the example's own files");
  assert.ok(readFileSync(path.join(copy, "src", "appmeta", "icon_back_11x11.png")).equals(readFileSync(path.join(EXAMPLES, "meeting-cost", "src", "appmeta", "icon_back_11x11.png"))), "the example's own icons, not the default");
  await until(() => app.page(`document.querySelector("#app-title")?.textContent === "Meeting Cost"`), "the copy chosen");
  assert.equal(await running(), copied.id, "the copy runs on the BUSY Bar too");
});
