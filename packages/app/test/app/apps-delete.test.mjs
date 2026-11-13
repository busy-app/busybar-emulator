// The Apps list's menu and Delete in the running app with the real server: a fresh data folder lists no app; a
// right-click on a row opens the row's menu at the pointer, Escape and a click outside close it, Shift+F10 opens it
// from the keyboard with its first item in focus; Delete… asks in a dialog, Cancel first. An app from a package has
// one choice; a project has two, with its folder shown: removed from the emulator its folder stays, removed with its
// files its folder goes to the Trash (a stand-in in a test run: the folder is noted, not moved). Script alone deletes
// nothing. No network.
//
// APPS_DELETE_SHOTS=<folder> also saves pictures at 1200×800 and 900×650.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { HAS_REAL_SERVER, removeFolder, sleep, targz, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.APPS_DELETE_SHOTS || null;
/** How long a wait that needs the projects read anew may take. */
const PROJECTS_READ_MS = 60_000;

let app;
let work;
before(async () => {
  if (skip) return;
  work = realpathSync(temporaryFolder());
  app = await launch({ server: "real", welcomed: true });
  await app.waitWindow("device");
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
  await until(() => page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected");
});
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

const q = (text) => JSON.stringify(text);
/** Code run in the window's page; a failure names the code. */
const page = (code) => app.page(code).catch((e) => Promise.reject(new Error(`${e.message} in: ${code.slice(0, 160)}`)));
const input = (events) =>
  app.run((shell, _electron, list) => {
    const contents = shell.windows.current.win.webContents;
    for (const event of list) contents.sendInputEvent(event);
  }, events);
const centre = (selector) => page(`(() => { const el = document.querySelector(${q(selector)}); if (!el) return null; const box = el.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
const rightClick = async (selector) => {
  const { x, y } = await centre(selector);
  await input([
    { type: "mouseDown", x, y, button: "right", clickCount: 1 },
    { type: "mouseUp", x, y, button: "right", clickCount: 1 },
  ]);
  return { x, y };
};
const clickAt = ({ x, y }) =>
  input([
    { type: "mouseDown", x, y, button: "left", clickCount: 1 },
    { type: "mouseUp", x, y, button: "left", clickCount: 1 },
  ]);
const click = async (selector) => clickAt(await centre(selector));
const key = (keyCode, modifiers = []) =>
  input([
    { type: "keyDown", keyCode, modifiers },
    { type: "keyUp", keyCode, modifiers },
  ]);
const row = (id) => `#apps li.app[data-id=${q(id)}]`;
const menu = () => page(`(() => { const el = document.querySelector(".row-menu"); return el ? [...el.querySelectorAll(".menu-item")].map((item) => item.textContent.trim()) : null; })()`);
const dialog = () => page(`(() => { const el = document.querySelector(".delete-dialog"); return el ? { title: el.querySelector("h2").textContent, choices: [...el.querySelectorAll(".choice b")].map((b) => b.textContent), folder: el.querySelector(".folder .path")?.title ?? null, buttons: [...el.querySelectorAll(".delete-foot button")].map((b) => b.textContent.trim()), focused: document.activeElement?.textContent?.trim() ?? null, said: el.querySelector(".delete-said").textContent } : null; })()`);
/** Whether the row is the app's project (it has Refresh), not only an app on the bar. */
const isProject = (id) => page(`Boolean(document.querySelector(${q(`${row(id)} .row-actions [aria-label^="Refresh"]`)}))`);
const listed = () => page(`[...document.querySelectorAll("#apps li.app")].map((li) => li.dataset.id)`);
const onTheBar = async () => JSON.parse(await page(`fetch("/api/apps/list").then((r) => r.text())`)).apps.map((one) => one.id);
const reload = () => page(`document.querySelector("#refresh-apps").click(), true`);

/** An app of one script, installed on the bar through its own API, as busy-cli does it. */
async function install(id, name) {
  const files = {
    [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name, version: "0.1.0", api_version: "27.0.0" }),
    [`${id}/scripts/main.js`]: "listen('input', () => {});",
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

/** A project folder of the app, noted in the emulator's list as the project commands note one. */
function projectOf(id, name, folderName) {
  const dir = path.join(work, folderName);
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id, name, version: "0.1.0" }));
  writeFileSync(path.join(dir, "package.json"), "{}");
  const real = realpathSync(dir);
  const file = path.join(app.folder, "projects", "registry.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const list = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).projects : [];
  writeFileSync(file, JSON.stringify({ version: 1, projects: [{ path: real, volume: path.parse(real).root, id, name, at: new Date().toISOString() }, ...list.filter((one) => one.path !== real)] }));
  return real;
}

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1200, 800],
    [900, 650],
  ]) {
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await sleep(1000);
    await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `${name}-${w}x${h}.png`), Buffer.from(png, "base64"));
  }
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
  await sleep(300);
}

test("a fresh data folder: no app on the bar, and the list says so with Create app", { skip }, async () => {
  assert.deepEqual(await onTheBar(), []);
  await until(() => page(`document.querySelector("#apps li.empty")?.textContent.includes("No apps yet")`), "the empty list");
  assert.deepEqual(await listed(), []);
  await shot("4-empty-list");
});

test("the row's menu: right-click at the pointer; Escape, a click outside and a scroll close it; Shift+F10 from the keyboard", { skip }, async () => {
  await install("app.test.package", "Package App");
  const clock = projectOf("app.test.clock", "Clock", "Ρολόι έργου");
  await install("app.test.clock", "Clock");
  await reload();
  // The bar's rows come at once; the project's row moves to the top when the desktop app has read the projects, a run
  // of the command line: seconds on a loaded Windows machine, so these waits are as long as a removal's.
  await until(async () => (await listed()).join() === "app.test.clock,app.test.package" && (await isProject("app.test.clock")), "both rows, the project first, then the package", PROJECTS_READ_MS);
  assert.match(await page(`document.querySelector(${q(`${row("app.test.package")} .app-note`)}).textContent`), /from a package/);

  // A right-click: the menu at the pointer.
  const at = await rightClick(row("app.test.clock"));
  await until(() => menu(), "the menu");
  // The row's own Start or Stop button is not repeated in its menu.
  assert.deepEqual(await menu(), ["Show in Finder", "Delete…"].map((label) => (process.platform === "win32" ? label.replace("Finder", "Explorer") : label)));
  const box = await page(`(() => { const b = document.querySelector(".row-menu").getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top) }; })()`);
  assert.ok(Math.abs(box.left - at.x) <= 2 && Math.abs(box.top - at.y) <= 2, `the menu at ${JSON.stringify(box)}, the pointer at ${JSON.stringify(at)}`);
  await shot("1-menu-open");
  await key("Escape");
  await until(async () => (await menu()) === null, "Escape to close the menu");
  assert.equal(await page(`document.querySelector("#apps li.app.menu-open") === null`), true);

  // A click outside closes it, and so does a scroll.
  await rightClick(row("app.test.package"));
  await until(() => menu(), "the menu");
  assert.deepEqual(await menu(), ["Delete…"], "an app from a package has no folder to show");
  await click("#app-title");
  await until(async () => (await menu()) === null, "a click outside to close the menu");
  await rightClick(row("app.test.package"));
  await until(() => menu(), "the menu");
  await page(`document.querySelector("#apps").dispatchEvent(new Event("scroll")), true`);
  await until(async () => (await menu()) === null, "a scroll to close the menu");

  // From the keyboard: Shift+F10 on the row's button opens it with the first item in focus; the arrows move.
  await page(`document.querySelector(${q(`${row("app.test.clock")} .row-more`)}).focus(), true`);
  await key("F10", ["shift"]);
  await until(() => menu(), "Shift+F10 to open the menu");
  assert.match(await page(`document.activeElement.textContent.trim()`), /^Show in /);
  await key("Down");
  assert.equal(await page(`document.activeElement.textContent.trim()`), "Delete…");
  await key("Home");
  assert.match(await page(`document.activeElement.textContent.trim()`), /^Show in /);
  await key("End");
  assert.equal(await page(`document.activeElement.textContent.trim()`), "Delete…");
  await key("Escape");
  await until(async () => (await menu()) === null, "Escape");
  assert.equal(await page(`document.activeElement.classList.contains("row-more")`), true, "the focus is back on the row's button");
  // The More button opens it too.
  await click(`${row("app.test.clock")} .row-more`);
  await until(() => menu(), "the More button to open the menu");
  await key("Escape");
  assert.ok(existsSync(clock));
});

test("Delete…: an app from a package has one choice; Cancel is first and keeps it", { skip }, async () => {
  await rightClick(row("app.test.package"));
  await until(() => menu(), "the menu");
  await click(".row-menu .menu-item.danger");
  await until(() => dialog(), "the dialog");
  assert.deepEqual(await dialog(), { title: "Delete Package App?", choices: [], folder: null, buttons: ["Cancel", "Remove from the emulator"], focused: "Cancel", said: "" });
  await shot("3-modal-package");
  await click(".delete-foot .btn:not(.danger)");
  await until(async () => (await dialog()) === null, "Cancel to close the dialog");
  assert.deepEqual((await onTheBar()).sort(), ["app.test.clock", "app.test.package"]);

  // Escape cancels too, and presses no key of the bar.
  await rightClick(row("app.test.package"));
  await until(() => menu(), "the menu");
  await click(".row-menu .menu-item.danger");
  await until(() => dialog(), "the dialog");
  await key("Escape");
  await until(async () => (await dialog()) === null, "Escape to close the dialog");

  // Script alone deletes nothing: the desktop app wants the person's click (a moment after the last one).
  await sleep(2500);
  const scripted = await page(`window.emulatorActions.apps.delete({ id: "app.test.package" }).then(() => "done", (e) => e.code)`);
  assert.equal(scripted, "no_gesture");
  assert.ok((await onTheBar()).includes("app.test.package"));

  // Remove from the emulator: off the bar, out of the list.
  await rightClick(row("app.test.package"));
  await until(() => menu(), "the menu");
  await click(".row-menu .menu-item.danger");
  await until(() => dialog(), "the dialog");
  await click(".delete-foot .btn.danger");
  await until(async () => (await dialog()) === null, "the dialog to close after the removal", 60_000);
  assert.deepEqual(await onTheBar(), ["app.test.clock"]);
  await until(async () => !(await listed()).includes("app.test.package"), "the row to go");
});

test("Delete…: a project has two choices and shows its folder; removed from the emulator, its folder stays; with its files, it goes to the Trash", { skip }, async () => {
  const clock = realpathSync(path.join(work, "Ρολόι έργου"));
  await rightClick(row("app.test.clock"));
  await until(() => menu(), "the menu");
  await click(".row-menu .menu-item.danger");
  await until(() => dialog(), "the dialog");
  const shown = await dialog();
  assert.deepEqual(shown, { title: "Delete Clock?", choices: ["Remove from the emulator", "Remove and delete its files"], folder: clock, buttons: ["Cancel", "Remove"], focused: "Cancel", said: "" });
  await click(".delete-choices .choice:last-child");
  await until(async () => (await dialog()).buttons[1] === (process.platform === "win32" ? "Move to Recycle Bin" : "Move to Trash"), "the button to say where the folder goes");
  await shot("2-modal-project");
  // Back to the first choice: the folder stays.
  await click(".delete-choices .choice:first-child");
  await click(".delete-foot .btn.danger");
  await until(async () => (await dialog()) === null, "the dialog to close after the removal", 60_000);
  assert.deepEqual(await onTheBar(), []);
  assert.ok(existsSync(clock), "the folder stays");
  assert.deepEqual(await app.run((shell) => shell.offScreen.trashed), []);
  assert.deepEqual(JSON.parse(readFileSync(path.join(app.folder, "projects", "registry.json"), "utf8")).projects, []);

  // Again, with its files: the folder goes to the Trash (noted, in a test run).
  projectOf("app.test.clock", "Clock", "Ρολόι έργου");
  await install("app.test.clock", "Clock");
  await reload();
  await until(() => isProject("app.test.clock"), "the row back, as the project", PROJECTS_READ_MS);
  await rightClick(row("app.test.clock"));
  await until(() => menu(), "the menu");
  await click(".row-menu .menu-item.danger");
  await until(() => dialog(), "the dialog");
  await click(".delete-choices .choice:last-child");
  await click(".delete-foot .btn.danger");
  await until(async () => (await dialog()) === null, "the dialog to close after the removal", 60_000);
  assert.deepEqual(await app.run((shell) => shell.offScreen.trashed), [clock]);
  assert.deepEqual(await onTheBar(), []);
  await until(() => page(`document.querySelector("#apps li.empty")?.textContent.includes("No apps yet")`), "the empty list again", PROJECTS_READ_MS);
});
