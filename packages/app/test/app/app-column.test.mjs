// The side column's card (app-column): the opened app's folder at its top, under the app's id and over Run, Stop and
// Refresh, with Copy prompt for AI, whose text holds the project's real folder and the command line's path; and the
// files-changed notice: a source file written after the app was put on the bar shows it, Refresh takes it away, and
// it is not there while the folder is watched. With the real server; the project has a stand-in for busy-cli, so
// nothing goes to the network.
//
// APP_COLUMN_SHOTS=<folder> also saves pictures of All apps (empty and with apps) and of the opened app.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { HAS_REAL_SERVER, removeFolder, sleep, targz, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.APP_COLUMN_SHOTS || null;
const EMULATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SIZES = [[1440, 900], [1200, 800], [900, 650]];
const ID = "app.example.meeting_cost";

/** A stand-in for the project's busy-cli: build writes the package's file, the rest does nothing; all end with 0. */
const BUSY_CLI = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const words = process.argv.slice(2);
if (words[0] === "build") {
  const id = JSON.parse(readFileSync("src/appmeta/manifest.json", "utf8")).id;
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/" + id + ".tgz", "");
}
console.log("busy-cli stand-in: " + words.join(" "));
`;

let app;
let work;
let dir;
const q = (text) => JSON.stringify(text);
const page = (code) => app.page(code).catch((e) => Promise.reject(new Error(`${e.message} in: ${code.slice(0, 160)}`)));
const paint = () => page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");

function filesOf(folder, prefix = "") {
  const out = {};
  for (const name of readdirSync(folder)) {
    const full = path.join(folder, name);
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

async function resize([w, h]) {
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h - 1), [w, h]);
  await sleep(100);
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h), [w, h]);
  await sleep(400);
  await paint();
}

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const size of SIZES) {
    await resize(size);
    await sleep(300);
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `${name}-${size.join("x")}.png`), Buffer.from(png, "base64"));
  }
  await resize([1440, 900]);
}

/** The Meeting Cost example as a project of the emulator, trusted and noted, its app on the bar, put there `at`. */
async function project() {
  dir = path.join(work, "meeting-cost");
  cpSync(path.join(EMULATOR, "examples", "meeting-cost"), dir, { recursive: true });
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", type: "module", bin: { "busy-cli": "cli.mjs" } }));
  writeFileSync(path.join(cli, "cli.mjs"), BUSY_CLI);
  dir = realpathSync(dir);
  const files = {};
  for (const [rel, bytes] of Object.entries(filesOf(path.join(dir, "src")))) if (!rel.endsWith(".ts")) files[`${ID}/${rel}`] = bytes;
  await install(ID, files);
  // Every file of the project older than the note of the install.
  const before = Date.now() / 1000 - 120;
  for (const rel of Object.keys(filesOf(dir))) utimesSync(path.join(dir, rel), before, before);
  const stat = statSync(dir, { bigint: true });
  mkdirSync(path.join(app.folder, "projects"), { recursive: true });
  writeFileSync(path.join(app.folder, "projects", "trusted.json"), JSON.stringify({ version: 2, projects: [{ path: dir, dev: String(stat.dev), ino: String(stat.ino), how: "created", at: new Date().toISOString() }] }));
  writeFileSync(path.join(app.folder, "projects", "registry.json"), JSON.stringify({ version: 1, projects: [{ path: dir, volume: path.parse(dir).root, id: ID, name: "Meeting Cost", at: new Date().toISOString(), installed: { id: ID, mark: "test", at: new Date().toISOString() } }] }));
}

before(async () => {
  if (skip) return;
  work = realpathSync(temporaryFolder());
  app = await launch({ server: "real", welcomed: true });
  await app.waitWindow("device");
  await until(() => page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected");
  await resize([1440, 900]);
});
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

test("All apps is a card of the local web: its radius, surface and ring; empty, it offers Create app", { skip }, async () => {
  await until(() => page(`Boolean(document.querySelector("#apps li.empty .btn"))`), "the empty list");
  const card = await page(`(() => { const s = getComputedStyle(document.querySelector("#apps-pane")); return { radius: s.borderTopLeftRadius, background: s.backgroundColor, ring: s.boxShadow.includes("inset"), padding: s.paddingLeft }; })()`);
  assert.deepEqual(card, { radius: "24px", background: "rgba(38, 38, 38, 0.5)", ring: true, padding: "24px" });
  await shot("all-empty");
});

test("the opened app: its folder under its id and over Run, Stop and Refresh; Copy prompt for AI copies the real folder and command", { skip }, async () => {
  await project();
  await page(`document.querySelector("#refresh-apps").click(), true`);
  await until(() => page(`Boolean(document.querySelector('#apps li.app[data-id="${ID}"]'))`), "the project listed");
  await shot("all-apps");
  await page(`document.querySelector('#apps li.app[data-id="${ID}"]').click(), true`);
  await until(() => page(`Boolean(document.querySelector("#app-folder .folder-line .path"))`), "the folder section");
  const order = await page(`(() => {
    const at = (el) => [...document.querySelectorAll("#app-pane *")].indexOf(el);
    return { id: at(document.querySelector("#app-facts code")), folder: at(document.querySelector("#app-folder")), actions: at(document.querySelector("#app-actions")), tabs: at(document.querySelector("#app-tabs")),
      path: document.querySelector("#app-folder .path").title, open: document.querySelector("#app-folder .folder-open").ariaLabel,
      prompt: document.querySelector("#copy-prompt").textContent, primary: getComputedStyle(document.querySelector("#copy-prompt")).backgroundColor,
      inOverview: Boolean(document.querySelector("#app-body .folder")) };
  })()`);
  assert.ok(order.id < order.folder && order.folder < order.actions && order.actions < order.tabs, JSON.stringify(order));
  assert.equal(order.path, dir);
  assert.equal(order.open, process.platform === "win32" ? "Show in Explorer" : "Open in Finder");
  assert.equal(order.prompt, "Copy prompt for AI");
  assert.equal(order.primary, "rgb(255, 255, 255)", "white, the primary button");
  assert.equal(order.inOverview, false, "the folder is no longer in Overview");
  // The inputs are the local web's field.
  await until(() => page(`Boolean(document.querySelector("#ov-name"))`), "Overview's fields");
  const field = await page(`(() => { const s = getComputedStyle(document.querySelector("#ov-name")); return { height: s.height, radius: s.borderTopLeftRadius, background: s.backgroundColor, border: s.borderTopColor }; })()`);
  assert.deepEqual(field, { height: "34px", radius: "6px", background: "rgba(38, 38, 38, 0.75)", border: "rgb(38, 38, 38)" });

  const facts = await page("window.emulatorActions.welcome.get()");
  await app.run((shell) => shell.offScreen.copied.splice(0));
  await app.click("#copy-prompt");
  await until(() => app.run((shell) => shell.offScreen.copied.length > 0), "the prompt copied");
  const [text] = await app.run((shell) => shell.offScreen.copied.splice(0));
  const call = process.platform === "win32" ? (facts.cli ? null : `& "$env:LOCALAPPDATA\\busy-emulator\\bin\\busy-emulator.exe"`) : (facts.cli ?? "~/.busy-emulator/bin/busy-emulator");
  assert.ok(text.includes(`The project is in this folder: ${dir}\n`), text);
  assert.match(text, /^Work with me on my BUSY Bar app "Meeting Cost" \(app\.example\.meeting_cost\)\./);
  if (call) assert.ok(text.includes(`by its full path: ${call}\n`) && text.includes(`1. ${call} dev --once`), text);
  assert.match(text, /Ask me before you publish/);
  assert.equal(await page(`document.querySelector("#copy-prompt").textContent`), "Copied", "the button says so");
  await sleep(2200);
  assert.equal(await page(`document.querySelector("#copy-prompt").textContent`), "Copy prompt for AI");

  await app.click("#app-folder .folder-line .icon-btn");
  await until(() => app.run((shell) => shell.offScreen.copied.length > 0), "the path copied");
  assert.deepEqual(await app.run((shell) => shell.offScreen.copied.splice(0)), [dir]);
  await shot("app-open");
});

test("files changed after the install: the notice with Refresh; not while the folder is watched; Refresh takes it away", { skip, timeout: 300_000 }, async () => {
  const notice = () => page(`Boolean(document.querySelector("#app-status .files-changed"))`);
  const look = () => page(`(dispatchEvent(new Event("focus")), true)`);
  assert.equal(await page(`document.querySelector("#side").dataset.mode`), "app");
  await look();
  await sleep(2500);
  assert.equal(await notice(), false, "the files are older than the app on the bar");

  const later = Date.now() / 1000 + 5;
  writeFileSync(path.join(dir, "src", "main.ts"), `${readFileSync(path.join(dir, "src", "main.ts"), "utf8")}\n// an agent's edit\n`);
  utimesSync(path.join(dir, "src", "main.ts"), later, later);
  await until(async () => (await look(), notice()), "the notice after the edit", 30_000, 500);
  assert.equal(await page(`document.querySelector("#app-status .files-changed .said").textContent`), "Files changed. Refresh to run the new version");
  await shot("app-files-changed");

  // Watching the folder: dev builds by itself, so no notice, even for files newer than all it put on the bar.
  const touch = (seconds) => utimesSync(path.join(dir, "src", "main.ts"), seconds, seconds);
  const watching = () => page(`[...document.querySelectorAll("#app-status .job-line")].some((line) => line.textContent === "Watching the folder")`);
  await app.press();
  await page(`window.emulatorActions.projects.dev.start(${q(dir)}).then(() => true, (e) => String(e.code))`);
  await until(watching, "the folder watched", 60_000, 200);
  touch(Date.now() / 1000 + 3600);
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    await look();
    assert.equal(await notice(), false, "no notice while the folder is watched");
  }
  await app.press();
  await page(`window.emulatorActions.projects.dev.stop(${q(dir)}).then(() => true, (e) => String(e.code))`);
  await until(async () => !(await watching()), "the watching stopped", 60_000, 200);
  await until(async () => (await look(), notice()), "the notice back once the watching stopped", 30_000, 500);
  touch(Date.now() / 1000 - 2);

  // Refresh, from the notice.
  await app.click("#files-changed-refresh");
  await until(async () => (await page(`[...document.querySelectorAll("#app-status .job-line")].some((line) => line.textContent !== "Refreshing" && !line.classList.contains("working"))`)) && !(await notice()), "the Refresh to end and the notice to go", 120_000, 200);
  await look();
  await sleep(2500);
  assert.equal(await notice(), false, "after Refresh the app on the bar is as new as its files");
});
