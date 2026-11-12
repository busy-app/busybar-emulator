// The parts of EMU-232 that the bar's recordings (test/state.test.mjs) do not reach: /api/apps/settings as an app
// asks for it, apps without a schema or with a broken one, documents the firmware refuses before it reads them, the
// settings file an app leaves behind, and what the router answers for a method or a path no handler takes. Each
// expectation names its source: a bar's answer, or the firmware 1.3.1 code (8edd2da4) where no bar was asked.
// Run: node --test emulator/packages/server/device-api.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { targz } from "../../test/package.mjs";
import { Device } from "./device.mjs";
import { loadFirmware } from "./firmware.mjs";

const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

const FIRMWARE = loadFirmware("1.3.1");
const SCHEMA = { format_version: 1, version: 1, fields: { label: { type: "string", label: "Label", default: "hello", min_length: 1, max_length: 12 }, count: { type: "integer", label: "Count", default: 3, min: 0, max: 9 } } };

/** Installs app.test.a as busy-cli does: stage, then install. */
async function install(device, schema) {
  const files = { "app.test.a/appmeta/manifest.json": JSON.stringify({ format_version: 1, id: "app.test.a", name: "A", version: "1.0.0", api_version: FIRMWARE.apiVersion }), "app.test.a/scripts/main.js": "" };
  if (schema !== null) files["app.test.a/appmeta/settings.json"] = schema;
  const staged = await device.handle("POST", "http://127.0.0.1/api/apps/stage", {}, new Uint8Array(targz(files)));
  const key = JSON.parse(Buffer.from(staged.body).toString()).install_key;
  const installed = await device.handle("POST", `http://127.0.0.1/api/apps/install?install_key=${key}`, {}, null);
  assert.equal(installed.status, 200);
}

/** A bar without its screen module (none of these requests reaches it), with app.test.a installed. */
async function bar({ schema = JSON.stringify(SCHEMA) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "emu-device-api-"));
  folders.push(root);
  const lines = [];
  const device = new Device({ dataDir: root, firmware: FIRMWARE, log: (line) => lines.push(line) });
  const call = async (method, path, body = null, headers = {}) => {
    const r = await device.handle(method, `http://127.0.0.1/api/${path}`, headers, body === null ? null : new TextEncoder().encode(body));
    return { status: r.status, headers: Object.fromEntries(r.headers), text: Buffer.from(r.body).toString() };
  };
  await install(device, schema);
  return { device, call, root, lines, settingsFile: join(root, "ext", "apps_data", "jsrunner", "app.test.a.settings.json") };
}
const fromApp = { "x-busybar-fetch": "js" };
const body = (status, error) => ({ status, text: JSON.stringify({ error }) });
const answer = (r) => ({ status: r.status, text: r.text });

test("an app may read its own settings only, after the id and the app are checked (api_apps.c:640–672)", async () => {
  const { device, call } = await bar();
  // Firmware: a bad id is 400 and an app that is not there 404 before the question whose app runs.
  assert.deepEqual(answer(await call("GET", "apps/settings?app_id=bad%20id", null, fromApp)), body(400, "Bad Request"));
  assert.deepEqual(answer(await call("GET", "apps/settings?app_id=app.test.none", null, fromApp)), body(404, "Not Found"));
  // Nothing runs: MG_REPLY_FORBIDDEN, "Forbidden" (the emulator said "Requested application id does not match…").
  assert.deepEqual(answer(await call("GET", "apps/settings?app_id=app.test.a", null, fromApp)), body(403, "Forbidden"));
  device.running = { id: "app.test.other" };
  assert.deepEqual(answer(await call("GET", "apps/settings?app_id=app.test.a", null, fromApp)), body(403, "Forbidden"));
  device.running = { id: "app.test.a" };
  assert.equal((await call("GET", "apps/settings?app_id=app.test.a", null, fromApp)).status, 200);
  device.running = null;
});

test("an app without a settings schema, or with one that is not JSON (api_apps.c:675–684)", async () => {
  const none = await bar({ schema: null });
  for (const method of ["GET", "PUT", "DELETE"]) {
    assert.deepEqual(answer(await none.call(method, "apps/settings?app_id=app.test.a", method === "PUT" ? "{}" : null)), body(404, "Application has no settings schema"), method);
  }
  const broken = await bar({ schema: "{ not json" });
  assert.deepEqual(answer(await broken.call("GET", "apps/settings?app_id=app.test.a")), body(503, "Application settings schema is invalid"));
  const empty = await bar({ schema: "" });
  assert.deepEqual(answer(await empty.call("GET", "apps/settings?app_id=app.test.a")), body(503, "Application settings schema is invalid"));
});

test("PUT refuses what is not an object with a number version and an object values: 400 Bad Request, the reason in the log", async () => {
  const { call, lines } = await bar();
  // setting_provider_load_document() → json_structure_setup(): the root an object, "version" a number, "values" an object.
  for (const doc of ["null", "[]", "5", '"x"', '{"version":1}', '{"version":1,"values":null}', '{"version":1,"values":[1]}', '{"version":"1","values":{"label":"x","count":1}}']) {
    assert.deepEqual(answer(await call("PUT", "apps/settings?app_id=app.test.a", doc)), body(400, "Bad Request"), doc);
  }
  assert.ok(lines.some((l) => l.includes("app.test.a") && l.includes("Bad Request") && l.includes('"version"')), lines.join("\n"));
  await call("PUT", "apps/settings?app_id=app.test.a", '{"version":1,"values":{"label":"x","count":10}}');
  assert.ok(lines.some((l) => l.includes("Invalid value for count")), lines.join("\n"));
});

test("the settings file is written as the firmware writes it, and one that does not parse is reset (setting_provider.c)", async () => {
  const { call, settingsFile } = await bar();
  assert.equal((await call("PUT", "apps/settings?app_id=app.test.a", '{"version":1,"values":{"label":"x","count":5}}')).status, 200);
  // storage_flush_json(): cJSON_Print(), no line feed after it.
  assert.equal(readFileSync(settingsFile, "utf8"), '{\n\t"version":\t1,\n\t"values":\t{\n\t\t"label":\t"x",\n\t\t"count":\t5\n\t}\n}');
  // GET: cJSON_Print() and a line feed (api_apps_settings_get, "%s\n"; the bar's answers of 10.11 have the tabs).
  assert.equal((await call("GET", "apps/settings?app_id=app.test.a")).text, '{\n\t"version":\t1,\n\t"values":\t{\n\t\t"label":\t"x",\n\t\t"count":\t5\n\t}\n}\n');
  writeFileSync(settingsFile, "{ broken");
  const r = await call("GET", "apps/settings?app_id=app.test.a");
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { version: 1, values: { label: "hello", count: 3 } });
});

test("a settings file that does not parse is kept aside and told in the log, not lost without a word (audit H3)", async () => {
  const { call, settingsFile, lines } = await bar();
  const typed = '{"version":1,"values":{"label":"my token abc","count":5';
  mkdirSync(dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, typed);
  const r = await call("GET", "apps/settings?app_id=app.test.a");
  assert.deepEqual(JSON.parse(r.text), { version: 1, values: { label: "hello", count: 3 } }, "the defaults, as on a bar");
  const folder = dirname(settingsFile);
  const aside = readdirSync(folder).filter((name) => name.startsWith("app.test.a.settings.json.corrupt-"));
  assert.equal(aside.length, 1, readdirSync(folder).join(", "));
  assert.equal(readFileSync(join(folder, aside[0]), "utf8"), typed, "what the person typed is still there");
  assert.ok(lines.some((line) => /The settings of app\.test\.a could not be read .*kept as .*corrupt-/.test(line)), lines.join("\n"));
  // Written in one step: no temporary file is left beside it.
  assert.equal((await call("PUT", "apps/settings?app_id=app.test.a", '{"version":1,"values":{"label":"y","count":4}}')).status, 200);
  assert.deepEqual(readdirSync(folder).sort(), ["app.test.a.settings.json", aside[0]].sort());
});

test("deleting an app leaves its settings, and the app installed again gets them back", async () => {
  // A bar on 1.3.1 (10.11, a bar with a self-built U5): after DELETE /api/apps the file stayed in
  // /ext/apps_data/jsrunner. js_app_registry_uninstall_app() removes the app's folder only.
  const { device, call, settingsFile } = await bar();
  await call("PUT", "apps/settings?app_id=app.test.a", '{"version":1,"values":{"label":"kept","count":7}}');
  assert.equal((await call("DELETE", "apps?app_id=app.test.a")).status, 200);
  assert.ok(existsSync(settingsFile));
  assert.deepEqual(answer(await call("GET", "apps/settings?app_id=app.test.a")), body(404, "Not Found"));
  await install(device, JSON.stringify(SCHEMA));
  assert.deepEqual(JSON.parse((await call("GET", "apps/settings?app_id=app.test.a")).text), { version: 1, values: { label: "kept", count: 7 } });
});

test("a method a handler does not take is 405 with the methods it takes", async () => {
  const { call } = await bar();
  // Recorded on bars on 1.3.1: GET input, PUT display/brightness, PUT audio/volume (10.11) → 405 Method Not Allowed.
  // The Allow header from the handlers' masks (api_root.c, api_display.c, api_audio.c, api_apps.c, api_status.c).
  // Allow names them in the order of web_server.c's http_methods: GET, POST, DELETE, PUT.
  const cases = [
    ["GET", "input", "POST"], ["PUT", "display/brightness", "GET, POST"], ["PUT", "audio/volume", "GET, POST"],
    ["GET", "audio/play", "POST, DELETE"], ["POST", "apps/list", "GET"], ["GET", "apps/launch", "POST"], ["GET", "apps/quit", "POST"],
    ["GET", "apps/stage", "POST"], ["GET", "apps/install", "POST"], ["POST", "apps/settings", "GET, DELETE, PUT"],
    ["GET", "apps", "DELETE"], ["POST", "status", "GET"], ["DELETE", "status/device", "GET"], ["PUT", "screen", "GET"],
    ["POST", "version", "GET"], ["DELETE", "transport", "GET"], ["GET", "log_dump", "POST"], ["GET", "status/ws", "GET"],
    // A handler takes every path that starts with its uri, "/" or not (http_handle_request), so its methods decide.
    ["GET", "inputs/x", "POST"], ["HEAD", "version", "GET"],
  ];
  for (const [method, path, allow] of cases) {
    const r = await call(method, path);
    assert.deepEqual([r.status, r.headers.Allow, r.text], [405, allow, '{"error":"Method Not Allowed"}\n'], `${method} ${path}`);
  }
});

test("a method web_server.c does not know is refused by /api itself: 405 with all four methods, the connection closed", async () => {
  // handlers_root's /api is of all methods and takes every path under /api first (web_server.c:26–35, :470–473,
  // :520–523): by code, not checked on a bar. Node passes such methods through (PROPFIND, LOCK, PURGE, …).
  const { call } = await bar();
  for (const [method, path] of [["PROPFIND", "input"], ["PROPFIND", "apps/settings?app_id=app.test.a"], ["LOCK", "display/brightness"], ["PURGE", "nope"], ["PROPFIND", "status/ws"]]) {
    const r = await call(method, path);
    assert.deepEqual([r.status, r.headers.Allow, r.headers.Connection, r.text], [405, "GET, POST, DELETE, PUT", "close", '{"error":"Method Not Allowed"}\n'], `${method} ${path}`);
  }
});

test("a path no handler takes: GET is the local web's 404 page, any other method 405 with GET (web_server.c)", async () => {
  const { call, device } = await bar();
  const page = readFileSync(join(device.firmware.web, "404.html"));
  for (const path of ["nope", "apps/nope", "display/nope", "status/nope", "version/x"]) {
    const r = await call("GET", path);
    assert.deepEqual([r.status, r.headers["Content-Type"], r.text === page.toString()], [404, "text/html", true], path);
    const p = await call("POST", path);
    assert.deepEqual([p.status, p.headers.Allow], [405, "GET"], `POST ${path}`);
  }
});
