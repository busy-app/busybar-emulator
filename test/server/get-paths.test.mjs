// A GET changes nothing (ADR-0012 section 2). A page of another origin cannot read an answer of the emulator, but it
// can still make a browser send a plain GET without Origin (a picture, a script, a link): such a request passes the
// entry, so none may change the bar, its files or the emulator.
//
// Every GET path is called here and the state is compared before and after: the paths of the handlers written for the
// emulator, which the test finds in their source so that a new one cannot be left out, and those of the firmware's
// own handlers, as its API description (openapi/*.yaml of the firmware 1.3.1) lists them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { join, relative } from "node:path";
import { after, test } from "node:test";

import { startServer } from "../../packages/server/server.mjs";
import { targz } from "../package.mjs";
import { finish, get, port, request, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

/** The GET routes of device.mjs's own switch, as its source names them. */
function ownSwitchRoutes() {
  return [...readFileSync(serverModule("device.mjs"), "utf8").matchAll(/case "GET ([^"]+)":/g)].map((m) => m[1]).sort();
}

// device.mjs's switch: kept equal to its source (the first test), so that a GET added there is added here.
const OWN_SWITCH = ["apps/list", "apps/settings", "audio/volume", "display/brightness", "screen", "status", "status/device", "status/firmware", "status/power", "status/system", "transport", "version"];
// The other handlers written for the emulator: storage (files-api.mjs), access (access-api.mjs), the old /_emu/* paths
// and the device window (server.mjs, device-window.mjs), the bar's local web (served from the firmware's files).
const OWN_OTHER = ["/api/storage/read?path=/ext/note.txt", "/api/storage/list?path=/ext", "/api/storage/status", "/api/access", "/api/access/tokens", "/_emu/state", "/_emu/status", "/_emu/audio?id=1", "/_emu/events", "/emulator", "/emulator/window.js", "/", "/apps", "/nowhere"];
// The firmware's GET operations of the handlers it brings itself (FIRMWARE_API in device.mjs), from openapi/*.yaml of
// 1.3.1: account, ble, busy, name, smart_home, time, update, wifi. Their descriptions say "get", "returns",
// "retrieves"; /api/wifi/networks "scans" for networks, which changes no setting.
const FIRMWARE = [
  "/api/account/info", "/api/account/status", "/api/account/backend", "/api/ble/status", "/api/busy/snapshot", "/api/busy/profiles/busy",
  "/api/busy/profiles/custom", "/api/name", "/api/smart_home/pairing", "/api/smart_home/switch", "/api/time", "/api/time/timezone", "/api/time/tzlist",
  "/api/update/status", "/api/update/changelog?version=1.3.1", "/api/update/autoupdate", "/api/wifi/status", "/api/wifi/networks",
];

/** A GET with headers; a stream is read for `ms` and closed. Resolves with the status. */
function getWith(url, headers = {}, ms = 0) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false, headers }, (res) => {
        res.resume();
        if (ms) setTimeout(() => (res.destroy(), resolve(res.statusCode)), ms);
        else res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}

/** Every file of the data folder, with a hash of what is in it. */
function files(dir) {
  const out = {};
  for (const name of readdirSync(dir, { recursive: true })) {
    const path = join(dir, name);
    if (statSync(path).isFile()) out[relative(dir, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return out;
}

/** What a request could change, read without changing it: the files, the bar's settings and the emulator's state. */
async function state(emulator) {
  const read = async (path) => (await get(`${emulator.url}${path}`)).text;
  const emu = JSON.parse(await read("/_emu/state"));
  const { system, ...firmware } = JSON.parse(await read("/api/status"));
  return {
    files: files(emulator.dataDir),
    // The clock and the counters of the running app move by themselves.
    emu: { ...emu, clock: null, running: emu.running?.id ?? null },
    status: { ...firmware, system: { ...system, uptime: null } },
    reads: await Promise.all(
      ["/api/name", "/api/display/brightness", "/api/audio/volume", "/api/apps/list", "/api/time/timezone", "/api/busy/snapshot", "/api/wifi/status", "/api/ble/status", "/api/update/autoupdate", "/api/account/info", "/api/smart_home/switch", "/api/access", "/_emu/status"].map(read),
    ),
  };
}

test("the GET routes of device.mjs are the ones this test calls", () => {
  assert.deepEqual(ownSwitchRoutes(), OWN_SWITCH);
});

test("no GET changes anything: neither the emulator's own handlers nor the firmware's", async (t) => {
  const dataDir = tempDir(t);
  const emulator = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir, barSpeed: false });
  t.after(() => emulator.stop());
  // An app with settings, launched, and a file: so that the reads have something to read.
  const schema = { format_version: 1, version: 1, fields: { greeting: { type: "string", label: "Greeting", default: "hi" } } };
  const id = "app.test.reader";
  const staged = await request("POST", `${emulator.url}/api/apps/stage`, targz({
    [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.0.0" }),
    [`${id}/appmeta/settings.json`]: JSON.stringify(schema),
    [`${id}/scripts/main.js`]: "setInterval(function () {}, 1000);",
  }));
  assert.equal(staged.status, 200, staged.text);
  assert.equal((await request("POST", `${emulator.url}/api/apps/install?install_key=${staged.json().install_key}`)).status, 200);
  assert.equal((await request("POST", `${emulator.url}/api/storage/write?path=/ext/note.txt`, Buffer.from("note"))).status, 200);
  assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=app.test.reader`)).status, 200);
  // The first read of an app's settings writes its defaults, on the bar too (setting_provider_load in the firmware's
  // lib/setting_provider writes the file when it has none: by the firmware's code, not checked on a bar). From then on
  // reading changes nothing.
  assert.equal((await get(`${emulator.url}/api/apps/settings?app_id=app.test.reader`)).status, 200);
  // The APPS menu of the firmware writes its own settings a while after an app has been installed and launched.
  await until("the APPS menu to have written its settings", async () => {
    const a = JSON.stringify(await state(emulator));
    await new Promise((resolve) => setTimeout(resolve, 300));
    return a === JSON.stringify(await state(emulator));
  });

  const paths = [...OWN_SWITCH.map((route) => `/api/${route}${{ "apps/settings": "?app_id=app.test.reader", screen: "?display=0" }[route] ?? ""}`), ...OWN_OTHER, ...FIRMWARE];
  for (const path of paths) {
    const before = await state(emulator);
    const status = await getWith(`${emulator.url}${path}`, {}, path === "/_emu/events" ? 200 : 0);
    assert.ok(status < 500, `${path}: ${status}`);
    assert.deepEqual(await state(emulator), before, `GET ${path} changed something`);
  }
  // And on the management address, with the key.
  for (const path of ["/_emu/state", "/_emu/status", "/_emu/audio?id=1"]) {
    const before = await state(emulator);
    const response = await getWith(`${emulator.control.url}${path}`, emulator.controlHeaders());
    assert.ok(response < 500, `${path}: ${response}`);
    assert.deepEqual(await state(emulator), before, `GET ${path} on the management address changed something`);
  }
});
