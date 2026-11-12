// Report a Bug in the running app with the real server (report-bug.js, report-actions.mjs): the dialog opened from the
// app menu's Help, filled in and clicked as the person does. The data folder's log is given the person's home folder, a
// GitHub token, a Wi-Fi name, a serial and a MAC before the app starts; the dialog's text, the address the browser
// would get and every file of the saved archive have none of them. A test run opens no browser and leaves the
// clipboard alone: what it would have opened and copied is in shell.offScreen.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { NEW_ISSUE } from "../../src/report-actions.mjs";
import { readZip } from "../../src/zip.mjs";
import { HAS_REAL_SERVER, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const HOME = os.homedir();
// Put together at run time: the export check keeps these shapes out of the repository's files.
const TOKEN = ["gh", "p_", "R3p0rtAbugT3stT0ken", "AAAAAAAAAAAAAAAAAA"].join("");
const WIFI = "Lab Network 5G";
const SERIAL = ["5eed", "0a1b2c3d4e5f60718293"].join("");
const MAC = ["a4", "83", "e7", "1f", "0c", "9b"].join(":");
const LEAKS = [HOME, TOKEN, WIFI, SERIAL, MAC];

let app;
let data;
let work;
before(async () => {
  if (skip) return;
  data = realpathSync(temporaryFolder());
  work = realpathSync(temporaryFolder());
  mkdirSync(path.join(data, "logs"), { recursive: true });
  writeFileSync(
    path.join(data, "logs", "shell.log"),
    [
      `2026-11-12T10:00:00.000Z [server] project ${path.join(HOME, "BUSY Bar projects", "weather")} opened`,
      `2026-11-12T10:00:01.000Z [github] gh: GH_TOKEN=${TOKEN}`,
      `2026-11-12T10:00:02.000Z [server] {"ssid":"${WIFI}","serial_number":"${SERIAL}","wifi_mac":"${MAC}"}`,
      "",
    ].join("\n"),
  );
  app = await launch({ server: "real", dataDir: data, welcomed: true });
  await app.waitWindow("device");
});
after(async () => {
  await app?.close();
  for (const folder of [data, work]) if (folder) await removeFolder(folder);
});

const q = (value) => JSON.stringify(value);
const shownText = () => app.page(`document.querySelector("#report-bug-text").textContent`);
const isOpen = () => app.page(`(() => { const scrim = document.querySelector(".report-bug-scrim"); return Boolean(scrim) && !scrim.hidden; })()`);
const said = () => app.page(`document.querySelector("#report-bug-said").textContent`);
const type = (selector, text) => app.page(`(() => { const el = document.querySelector(${q(selector)}); el.value = ${q(text)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
/** A click as the person makes it: the pointer comes to the button, then presses (capture.test.mjs says why). */
async function click(selector) {
  const at = await app.page(`(() => { const box = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
  await app.run((shell, _electron, { x, y }) => shell.windows.current.win.webContents.sendInputEvent({ type: "mouseMove", x, y }), at);
  await sleep(150);
  await app.click(selector);
}
const assertClean = (text, where) => {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${where} has ${JSON.stringify(leak)}`);
};

test("Help, Report a Bug… opens the dialog; its text is scrubbed; Open on GitHub opens that text in the new issue form, the screenshot on the clipboard", { skip }, async () => {
  assert.equal(await app.page(`typeof window.openReportBug`), "function");
  assert.equal(await app.run((shell) => shell.reportBug()), "dialog");
  await until(isOpen, "the dialog");
  await type("#report-bug-title-input", "The weather app stops");
  await type("#report-bug-what", `Opened ${path.join(HOME, "BUSY Bar projects", "weather")} and turned the wheel`);
  await type("#report-bug-expected", "The forecast changes");
  await until(async () => (await shownText()).includes("The forecast changes"), "the preview with what was typed");
  const text = await shownText();
  assertClean(text, "the dialog's text");
  assert.match(text, /^### What I did\nOpened <home>/);
  assert.match(text, /- Firmware: 1\.3\.1, API \d+\.\d+\.\d+/);
  assert.match(text, /GH_TOKEN=<(token|hidden)>/);
  assert.match(text, /"ssid":"<wifi>","serial_number":"<serial>","wifi_mac":"<mac>"/);
  // The bar's screenshot was taken when the dialog opened; ticked, it goes on the clipboard.
  await until(() => app.page(`!document.querySelector(".report-bug-thumb").hidden`), "the BUSY Bar's screenshot");
  await app.page(`(() => { const tick = document.querySelector("#report-bug-shot"); tick.checked = true; tick.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await until(async () => (await shownText()).includes("### Screenshot"), "the preview with the screenshot's line");
  const final = await shownText();

  // Without the person's click nothing opens.
  const unclicked = await app.page(`window.emulatorActions.report.open({ what: "x" }).then(() => "opened", (e) => e.code)`);
  assert.equal(unclicked, "no_gesture");
  assert.deepEqual(await app.run((shell) => shell.offScreen.browsed), []);

  await click("#report-bug-open");
  await until(async () => (await app.run((shell) => shell.offScreen.browsed.length)) === 1, "the browser asked to open the form");
  const [url] = await app.run((shell) => shell.offScreen.browsed);
  assert.ok(url.startsWith(`${NEW_ISSUE}?`), url);
  assert.ok(url.length <= (process.platform === "win32" ? 2000 : 8000), `${url.length}`);
  assert.equal(new URL(url).searchParams.get("title"), "The weather app stops");
  assert.equal(new URL(url).searchParams.get("body"), final, "the browser gets the text the dialog shows");
  assertClean(decodeURIComponent(url), "the address");
  const images = await app.run((shell) => shell.offScreen.images);
  assert.equal(images.length, 1);
  assert.ok(images[0] > 1000, `a PNG of ${images[0]} bytes`);
  await until(async () => /Opened in your browser\. The screenshot is on the clipboard/.test(await said()), "the dialog says what happened");
});

test("Save diagnostics: the system's Save dialog, then a .zip where the person said, scrubbed; Show in Finder shows it; Escape closes", { skip }, async () => {
  if (!(await isOpen())) {
    await app.page(`window.openReportBug()`);
    await until(isOpen, "the dialog");
  }
  await until(() => app.page(`!document.querySelector(".report-bug-thumb").hidden`), "the BUSY Bar's screenshot");
  await app.page(`document.querySelector("#report-bug-shot").checked = true`);
  const chosen = path.join(work, "diagnostics");
  await app.run((shell, _electron, answer) => shell.saveDialog.standIn(answer), chosen);
  await click("#report-bug-save");
  await until(async () => /^Saved /.test(await said()), "saved");
  const planned = await app.run((shell) => shell.saveDialog.planned);
  assert.equal(planned.at(-1).kind, "diagnostics");
  assert.equal(planned.at(-1).title, "Save Diagnostics");
  const files = readZip(readFileSync(`${chosen}.zip`));
  for (const name of ["report.md", "about.json", "logs/shell.log", "screenshot.png"]) assert.ok(files.has(name), name);
  for (const [name, bytes] of files) if (name !== "screenshot.png") assertClean(bytes.toString("utf8"), name);
  assert.match(files.get("logs/shell.log").toString("utf8"), /GH_TOKEN=<(token|hidden)>/);

  await click(".report-bug-reveal");
  await until(async () => (await app.run((shell) => shell.offScreen.shown)).includes(`${chosen}.zip`), "the archive shown in Finder or Explorer");

  await app.run((shell) => shell.windows.current.win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" }));
  await until(async () => !(await isOpen()), "Escape closed it");
});

test("the top bar's Emulator Docs and JS Apps Docs open exactly their address, on the person's click only; the Help menu has both and opens them", { skip }, async () => {
  await app.page(`window.closeReportBug?.()`);
  const EMULATOR = "https://go.busy.app/busy-emulator-docs";
  const JS_APPS = "https://go.busy.app/js-apps";
  const links = await app.page(`["#docs-emulator", "#docs-js-apps"].map((id) => { const a = document.querySelector(id); return [a.textContent.trim(), a.href]; })`);
  assert.deepEqual(links, [["Emulator Docs", EMULATOR], ["JS Apps Docs", JS_APPS]]);
  // The page clicking the link by itself opens nothing (the earlier tests' clicks are past their two seconds).
  await sleep(2100);
  await app.page(`document.querySelector("#docs-emulator").click()`);
  assert.deepEqual(await app.run((shell) => shell.opener.opened), []);
  await click("#docs-emulator");
  await until(async () => (await app.run((shell) => shell.opener.opened)).length === 1, "the first address given to the browser");
  await sleep(2100); // one click, one address: the next click is a new one
  await click("#docs-js-apps");
  await until(async () => (await app.run((shell) => shell.opener.opened)).length === 2, "the second address given to the browser");
  assert.deepEqual(await app.run((shell) => shell.opener.opened), [EMULATOR, JS_APPS]);
  // Help in the application menu (the Windows title bar draws the same template): the two items, opening those addresses.
  const help = await app.run((shell, electron) => {
    const menu = electron.Menu.getApplicationMenu();
    const items = ["emulator-docs", "js-apps-docs"].map((id) => menu.getMenuItemById(id));
    for (const item of items) item.click();
    return { ids: items.map((item) => item.label), browsed: shell.offScreen.browsed.slice(-2) };
  });
  assert.deepEqual(help.ids, ["Emulator Docs", "JS Apps Docs"]);
  assert.deepEqual(help.browsed, [EMULATOR, JS_APPS]);
});
