// The firmware's line on an app's first launch (EMU-367): js_localstorage.c cannot open the app's localstorage.json
// before the app has saved anything, and logs it as a warning; a BUSY Bar logs the same and it is normal. The emulator
// keeps the line as it is, as information with a note, so it does not look like the app's failure; every other
// JsLocalStorage line stays as it was.
//
//   node --test emulator/packages/server/first-launch-note.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { targz } from "../../test/package.mjs";
import { jsonLine, shownLine } from "./cli/app-log.mjs";
import { appEvent } from "./cli/bar-console.mjs";
import { Device } from "./device.mjs";
import { loadFirmware } from "./firmware.mjs";
import { FIRST_LAUNCH_NOTE, isFirstLaunchLine } from "./first-launch-note.mjs";

const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

const ID = "app.test.first";
const PATH = `/ext/apps_data/jsrunner/${ID}.localstorage.json`;

test("only 'Failed to open file' for the app's own localstorage.json is the first launch's line", () => {
  assert.equal(isFirstLaunchLine(ID, "JsLocalStorage", `Failed to open file: "${PATH}"`), true);
  assert.equal(isFirstLaunchLine(ID, "JsLocalStorage", `Failed to open file: "${PATH}".`), true, "as the firmware ends it");
  assert.equal(isFirstLaunchLine(ID, "JsLocalStorage", `Failed to open file: "/ext/apps_data/jsrunner/app.test.other.localstorage.json"`), false, "another app's file");
  assert.equal(isFirstLaunchLine(ID, "JsLocalStorage", `Failed to open file: "/ext/apps_data/jsrunner/${ID}.settings.json"`), false, "another file");
  assert.equal(isFirstLaunchLine(ID, "JsLocalStorage", `Failed to write file: "${PATH}"`), false, "a failed write");
  assert.equal(isFirstLaunchLine(ID, "JsLocalStorage", `Failed to parse file: "${PATH}"`), false);
  assert.equal(isFirstLaunchLine(ID, "JsRunner", `Failed to open file: "${PATH}"`), false, "another tag");
});

test("the command line and MCP show the note beside the firmware's line, which is unchanged", () => {
  const line = { kind: "info", text: `${ID} [JsLocalStorage] Failed to open file: "${PATH}"`, time: 0, note: FIRST_LAUNCH_NOTE };
  assert.match(shownLine(line), new RegExp(`Failed to open file: "${PATH}"  \\(no saved data yet`));
  assert.deepEqual(jsonLine(line), { time: new Date(0).toISOString(), kind: "info", text: line.text, note: FIRST_LAUNCH_NOTE });
  assert.equal("note" in jsonLine({ ...line, note: undefined }), false);
  // Not an error for the development loop (run, dev).
  assert.equal(appEvent(line, ID).event, "app_log");
});

test("an app's first launch is logged as information with the note, and no line is an error", async (t) => {
  const firmware = loadFirmware("1.4.1");
  const root = mkdtempSync(join(tmpdir(), "emu-first-launch-"));
  folders.push(root);
  const device = new Device({ dataDir: root, firmware, log: () => {}, sidecars: false });
  t.after(() => device.close());
  await device.start();
  const files = {
    [`${ID}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id: ID, name: "First", version: "1.0.0", api_version: firmware.apiVersion }),
    [`${ID}/scripts/main.js`]: 'const old = localStorage.getItem("n"); localStorage.setItem("n", "1"); console.log("old=" + old);',
  };
  const staged = await device.handle("POST", "http://127.0.0.1/api/apps/stage", {}, new Uint8Array(targz(files)));
  const key = JSON.parse(Buffer.from(staged.body).toString()).install_key;
  assert.equal((await device.handle("POST", `http://127.0.0.1/api/apps/install?install_key=${key}`, {}, null)).status, 200);
  const storageLines = () => device.logLines.filter((l) => l.text.includes("[JsLocalStorage]"));
  const launch = async () => {
    assert.equal((await device.handle("POST", `http://127.0.0.1/api/apps/launch?app_id=${ID}`, {}, null)).status, 200);
    for (let i = 0; i < 400 && !device.logLines.some((l) => l.text.startsWith(`${ID} log: old=`)); i++) await new Promise((r) => setTimeout(r, 25));
  };
  await launch();
  assert.deepEqual(storageLines().map(({ kind, text, note }) => ({ kind, text, note })), [{ kind: "info", text: `${ID} [JsLocalStorage] Failed to open file: "${PATH}".`, note: FIRST_LAUNCH_NOTE }]);
  assert.equal(device.logLines.some((l) => l.kind === "error"), false, "no error line");
});

test("the same warning for a file that exists (it does not open) stays the firmware's warning, without the note", async (t) => {
  const firmware = loadFirmware("1.4.1");
  const root = mkdtempSync(join(tmpdir(), "emu-first-launch-"));
  folders.push(root);
  const device = new Device({ dataDir: root, firmware, log: () => {}, sidecars: false });
  t.after(() => device.close());
  await device.start();
  const files = {
    [`${ID}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id: ID, name: "First", version: "1.0.0", api_version: firmware.apiVersion }),
    [`${ID}/scripts/main.js`]: 'const old = localStorage.getItem("n"); localStorage.setItem("n", "1"); console.log("old=" + old);',
  };
  const staged = await device.handle("POST", "http://127.0.0.1/api/apps/stage", {}, new Uint8Array(targz(files)));
  const key = JSON.parse(Buffer.from(staged.body).toString()).install_key;
  assert.equal((await device.handle("POST", `http://127.0.0.1/api/apps/install?install_key=${key}`, {}, null)).status, 200);
  const storageLines = () => device.logLines.filter((l) => l.text.includes("[JsLocalStorage]"));
  const launch = async () => {
    assert.equal((await device.handle("POST", `http://127.0.0.1/api/apps/launch?app_id=${ID}`, {}, null)).status, 200);
    for (let i = 0; i < 400 && !device.logLines.some((l) => l.text.startsWith(`${ID} log: old=`)); i++) await new Promise((r) => setTimeout(r, 25));
  };
  mkdirSync(join(root, "ext", "apps_data", "jsrunner", `${ID}.localstorage.json`), { recursive: true });
  await launch();
  const kept = storageLines();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].note, undefined);
  assert.notEqual(kept[0].kind, "info");
});
