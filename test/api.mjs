// The bar's HTTP API outside the apps' part of it: Wi-Fi, Bluetooth, time, name, files, tokens, updates, account,
// smart home.
//
//   node emulator/test/api.mjs [--firmware dev]            the requests that change nothing (HARMLESS) against a
//                                                           bar's recorded answers (test/api/bar-<firmware>.json),
//                                                           then the emulator alone: its answers as the firmware's
//                                                           handlers say, with changes to its state (put back after)
//   node emulator/test/api.mjs --bar [10.0.4.20]           HARMLESS on a bar and in the emulator, live
//   node emulator/test/api.mjs --bar --record              the same, and the bar's answers saved to
//                                                           test/api/bar-<firmware>.json
//
// Compared, live or with a recording: the status code; for an error, its text; for an answer, the shape of the JSON
// (the keys and the types of values, never the values: a recording holds no serial number, name, address or network).
// A request whose answer depends on the bar's own state (BAR_STATE) is compared by its status code only.
//
// Every form starts an emulator of its own (own-emulator.mjs); --addr 127.0.0.1:8640 names one that is already
// running instead. The first form changes the emulator's state (and puts it back); it refuses to run against a bar.
// The others only read the bar, and send requests that it refuses: a bar is left as it was.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";
import { probeSource } from "../packages/server/bar-speed.mjs";
import { emulatorFor, totals } from "./own-emulator.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const recordDir = join(here, "api");
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--addr", "--firmware"], optional: ["--bar"], flags: ["--record"] });
const option = (name, fallback) => (args.includes(name) ? (args[args.indexOf(name) + 1]?.startsWith("--") === false ? args[args.indexOf(name) + 1] : fallback) : null);
const bar = option("--bar", "10.0.4.20");
const record = args.includes("--record");
if (record && !bar) {
  console.error("--record records a bar: give --bar too.");
  process.exit(2);
}
const target = await emulatorFor(args, { flag: "--addr", name: "api" });
const addr = target.addr;

async function call(host, method, path, body) {
  const r = await fetch(`http://${host}/api/${path}`, { method, body, signal: AbortSignal.timeout(10000) });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: r.status, text, json };
}

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  else passed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

// ---------------------------------------------------------------- bar against emulator

// Requests that leave a bar as it was: reads, and requests the bar refuses.
const HARMLESS = [
  ["GET", "version"], ["GET", "transport"], ["GET", "name"], ["GET", "access"], ["GET", "access/tokens"],
  ["GET", "status"], ["GET", "status/system"], ["GET", "status/device"], ["GET", "status/firmware"], ["GET", "status/power"],
  ["GET", "time"], ["GET", "time/timezone"], ["GET", "time/tzlist"],
  ["GET", "wifi/status"], ["GET", "ble/status"],
  ["GET", "update/status"], ["GET", "update/autoupdate"], ["GET", "update/changelog"], ["GET", "update/changelog?version=0.0.0"],
  ["GET", "account/info"], ["GET", "account/status"], ["GET", "account/backend"],
  ["GET", "smart_home/pairing"], ["GET", "smart_home/switch"],
  ["GET", "busy/snapshot"], ["GET", "busy/profiles/busy"], ["GET", "busy/profiles/custom"], ["GET", "busy/profiles/nope"],
  ["GET", "audio/volume"], ["GET", "display/brightness"], ["GET", "apps/list"],
  ["GET", "storage/status"], ["GET", "storage/list?path=/ext"], ["GET", "storage/list?path=/nowhere"], ["GET", "storage/list"],
  ["GET", "storage/read?path=/ext/no-such-file-here"], ["GET", "storage/read?path=/ext/../etc"],
  // Refused before anything changes.
  ["POST", "name", "{}"], ["POST", "name", '{"name":""}'], ["POST", "name", '{"name":"   "}'], ["POST", "name", '{"name":"a name that is far too long for a bar"}'],
  ["PUT", "name"], ["POST", "time/timezone?timezone=Nowhere"], ["POST", "time/timezone"], ["POST", "time/timestamp"], ["POST", "time/timestamp?timestamp=yesterday"],
  ["POST", "wifi/connect", "{}"], ["POST", "wifi/connect", '{"ssid":""}'], ["POST", "wifi/connect", '{"ssid":"x","password":"","security":"Nope"}'],
  ["POST", "update/install"], ["POST", "update/install?version=0.0.0"], ["POST", "access?mode=nope"], ["POST", "access"],
  ["DELETE", "access/tokens/nosuchid"], ["POST", "access/tokens", "{}"],
  ["POST", "audio/volume?volume=500"], ["POST", "display/brightness?value=500"], ["POST", "smart_home/switch", "{}"],
  ["PUT", "account/backend", "not json"], ["POST", "storage/mkdir"], ["POST", "storage/rename?path=/ext/no-such-file-here"],
  ["POST", "log_dump?filename=bad/name"], ["POST", "assets/upload?application_name=bad name&file=x"], ["DELETE", "assets/upload"],
];

// The shape of a JSON value: the keys of objects, the shapes an array's items take, the types of the rest.
function shape(value) {
  if (Array.isArray(value)) return [...new Set(value.map((v) => JSON.stringify(shape(v))))].sort();
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k])]));
  return typeof value;
}

// Two shapes agree if they are the same, lists apart: a list may be empty on one side or hold fewer kinds of items
// (a bar's tokens, the files of its /ext), but what it holds must be a kind the other side has too.
function alike(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return !a.length || !b.length || a.every((x) => b.includes(x)) || b.every((x) => a.includes(x));
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    return JSON.stringify(Object.keys(a)) === JSON.stringify(Object.keys(b)) && Object.keys(a).every((k) => alike(a[k], b[k]));
  }
  return a === b;
}

// Requests whose answers depend on the bar's own state, not on the firmware: compared by the status code only.
const BAR_STATE = {};

const nameOf = ([method, path, body]) => `${method} ${path}${body ? ` ${body}` : ""}`;

/** What is compared of an answer: the status, and the error's text or the JSON's shape. Nothing of the values. */
function answerOf(r) {
  return r.status >= 400 ? { status: r.status, error: r.json?.error ?? null } : { status: r.status, shape: shape(r.json) };
}

/** Whether the emulator's answer `e` agrees with the bar's `b` (both answerOf), and what to say. */
function agree(name, b, e) {
  if (b.status !== e.status) return [false, `bar ${b.status} ${b.error ?? ""} | emulator ${e.status} ${e.error ?? ""}`];
  if (BAR_STATE[name]) return [true, `${b.status}; the rest is the bar's own state (${BAR_STATE[name]})`];
  // An error must read the same.
  if (b.status >= 400) return b.error === e.error ? [true, `${b.status} ${b.error ?? ""}`] : [false, `bar "${b.error}" | emulator "${e.error}"`];
  return alike(b.shape, e.shape) ? [true, ""] : [false, `bar ${JSON.stringify(b.shape)} | emulator ${JSON.stringify(e.shape)}`];
}

async function compareWithBar() {
  const device = await call(bar, "GET", "status/device").catch(() => null);
  if (!device?.json) {
    console.error(`No bar at ${bar}.`);
    process.exit(1);
  }
  const firmware = (await call(bar, "GET", "status/firmware")).json;
  // Named by model and firmware, not by its serial number (as bar-speed.json and the recordings are).
  const source = probeSource(firmware);
  console.log(`API: ${source.bar} at ${bar} vs emulator ${addr}`);
  const answers = {};
  for (const request of HARMLESS) {
    const [b, e] = (await Promise.all([call(bar, ...request), call(addr, ...request)])).map(answerOf);
    const name = nameOf(request);
    answers[name] = b;
    check(name, ...agree(name, b, e));
  }
  console.log(failed ? `${failed} requests are answered differently` : "the bar and the emulator answer alike");
  if (record) {
    mkdirSync(recordDir, { recursive: true });
    const file = join(recordDir, `bar-${firmware.version}.json`);
    writeFileSync(file, JSON.stringify({ source, answers }, null, 1) + "\n");
    console.log(`recorded: ${file}`);
  }
}

/** HARMLESS in the emulator against a bar's recorded answers: the recording of the emulator's firmware, else the newest. */
async function compareWithRecording() {
  const version = (await call(addr, "GET", "status/firmware")).json?.version;
  const files = existsSync(recordDir) ? readdirSync(recordDir).filter((f) => /^bar-.+\.json$/.test(f)).sort() : [];
  const file = files.includes(`bar-${version}.json`) ? `bar-${version}.json` : files.at(-1);
  if (!file) {
    console.log("API against a bar's recorded answers: no recording (node emulator/test/api.mjs --bar --record)");
    return { skip: 1 };
  }
  const { source, answers } = JSON.parse(readFileSync(join(recordDir, file), "utf8"));
  console.log(`API: emulator ${addr} (firmware ${version}) against the answers of ${source.bar}, recorded ${source.recorded.slice(0, 10)} (test/api/${file})`);
  for (const request of HARMLESS) {
    const name = nameOf(request);
    if (!answers[name]) {
      check(name, false, `not in the recording (node emulator/test/api.mjs --bar --record)`);
      continue;
    }
    check(name, ...agree(name, answers[name], answerOf(await call(addr, ...request))));
  }
  return { skip: 0 };
}

// ---------------------------------------------------------------- the emulator alone

async function expect(method, path, body, status, want) {
  const r = await call(addr, method, path, body);
  const ok = r.status === status && (want === undefined || (typeof want === "function" ? want(r.json, r.text) : JSON.stringify(r.json) === JSON.stringify(want)));
  check(`${method} ${path}${body && body.length < 60 ? ` ${body}` : ""}`, ok, ok ? "" : `${r.status} ${r.text.trim().slice(0, 160)}`);
  return r;
}

async function emulatorAlone() {
  console.log(`API: emulator ${addr}`);
  const OK = { result: "OK" };
  const error = (text) => ({ error: text });

  // Name: device_name.c's rules.
  await expect("POST", "name", '{"name":"Test bar"}', 200, OK);
  await expect("GET", "name", null, 200, { name: "Test bar" });
  await expect("POST", "name", '{"name":""}', 400, error("Name is empty"));
  await expect("POST", "name", '{"name":"  "}', 400, error("Name consists of only spaces"));
  await expect("POST", "name", '{"name":"twenty-one characters"}', 400, error("Name is too long"));
  await expect("POST", "name", '{"name":"имя"}', 400, error("Name contains disallowed character"));
  await expect("POST", "name", '{"name":"x","more":1}', 400, error("Bad Request"));
  await expect("PUT", "name", null, 405, error("Method Not Allowed"));
  await expect("POST", "name", '{"name":"BUSY Bar Emulator"}', 200, OK);

  // Time: the zone and the clock.
  const zone = (await call(addr, "GET", "time/timezone")).json;
  await expect("GET", "time/tzlist", null, 200, (j) => j.list.length > 100 && j.list.every((z) => /^[+-]\d\d:\d\d$/.test(z.offset)));
  await expect("POST", "time/timezone?timezone=Tokyo", null, 200, OK);
  await expect("GET", "time/timezone", null, 200, { name: "Tokyo", offset: "+09:00", abbr: "JST" });
  await expect("GET", "time", null, 200, (j) => /\+09:00$/.test(j.timestamp));
  await expect("POST", "time/timezone?timezone=Nowhere", null, 400, error("Bad Request"));
  await expect("POST", `time/timezone?timezone=${encodeURIComponent(zone.name)}`, null, 200, OK);
  await expect("POST", "time/timestamp?timestamp=2030-01-02T03:04:05Z", null, 200, OK);
  await expect("GET", "time", null, 200, (j) => j.timestamp.startsWith("2030-01-0"));
  await expect("POST", "time/timestamp?timestamp=2030-01-02T03:04:05", null, 400, error("Bad Request"));
  await expect("POST", `time/timestamp?timestamp=${new Date().toISOString().slice(0, 19)}Z`, null, 200, OK);
  await expect("GET", "time", null, 200, (j) => j.timestamp.startsWith(String(new Date().getUTCFullYear())) || j.timestamp.startsWith(String(new Date().getFullYear())));

  // Wi-Fi: off the network, the list, back on it.
  await expect("GET", "wifi/networks", null, 400, error("Scan not possible when connected"));
  await expect("POST", "wifi/disconnect", null, 200, OK);
  await expect("GET", "wifi/status", null, 200, { state: "disconnected" });
  await expect("POST", "wifi/disconnect", null, 400, error("Already disconnected"));
  await expect("GET", "wifi/networks", null, 200, (j) => j.count === 2 && j.networks[0].ssid === "Emulator" && j.networks[0].rssi < 0);
  const join = (ssid, password, security, ip = { ip_method: "dhcp" }) => JSON.stringify({ ssid, password, security, ip_config: ip });
  await expect("POST", "wifi/connect", join("Nobody", "12345678", "WPA2"), 400, error("Access point not found"));
  await expect("POST", "wifi/connect", join("Emulator", "short", "WPA2"), 400, error("Authentication failed"));
  await expect("POST", "wifi/connect", join("Emulator", "12345678", "Nope"), 400, error("Nope is not valid security mode"));
  await expect("POST", "wifi/connect", '{"ssid":"Emulator","password":"12345678","security":"WPA2"}', 400, error("ip_config is missing"));
  await expect("POST", "wifi/connect", join("Emulator", "12345678", "WPA2", { ip_method: "static", address: "10.0.0.5", mask: "255.255.255.0", gateway: "10.0.0.1" }), 200, OK);
  await expect("GET", "wifi/status", null, 200, (j) => j.state === "connected" && j.ssid === "Emulator" && j.ip_config.ip_method === "static" && j.ip_config.address === "10.0.0.5");
  await expect("POST", "wifi/connect", join("Emulator", "12345678", "WPA2"), 400, error("Already connected"));
  await expect("POST", "wifi/disconnect", null, 200, OK);
  await expect("POST", "wifi/connect", join("Emulator", "12345678", "WPA2"), 200, OK);
  await expect("GET", "wifi/status", null, 200, (j) => j.ip_config.ip_method === "dhcp" && j.ip_config.address === "192.168.1.100");

  // Bluetooth.
  await expect("POST", "ble/enable", null, 200, OK);
  await expect("GET", "ble/status", null, 200, { status: "enabled" });
  await expect("POST", "ble/disable", null, 200, OK);
  await expect("GET", "ble/status", null, 200, { status: "disabled" });
  await expect("DELETE", "ble/pairing", null, 200, OK);

  // Updates: nothing to update to.
  await expect("POST", "update/check", null, 200, OK);
  await expect("GET", "update/status", null, 200, (j) => j.install.is_allowed === true && j.check.status === "not_available" && j.check.event === "stop");
  await expect("GET", "update/changelog", null, 400, error("Version parameter missing"));
  await expect("GET", "update/changelog?version=9.9.9", null, 400, error("Changelog not available"));
  await expect("POST", "update/install?version=9.9.9", null, 400, { error: "Update not available", error_code: "not_available" });
  await expect("POST", "update/autoupdate", '{"is_enabled":true,"interval_start":"01:30"}', 200, OK);
  await expect("GET", "update/autoupdate", null, 200, { is_enabled: true, interval_start: "01:30", interval_end: "05:00" });
  await expect("POST", "update/autoupdate", '{"is_enabled":false,"interval_start":"02:00"}', 200, OK);
  await expect("POST", "update", "a bundle", 400, (j) => j.error.startsWith("Update not allowed"));

  // Account and smart home: no cloud, no home.
  await expect("GET", "account/info", null, 200, { linked: false });
  await expect("GET", "account/backend", null, 200, { server_url: "default", client_cert_type: "default", ignore_server_cert: false });
  await expect("PUT", "account/backend", "not json", 400, error("Malformed request"));
  const asked = Date.now();
  await expect("POST", "account/link", null, 503, error("PIN request timeout"));
  check("the pairing code is waited for 3 seconds", Date.now() - asked >= 2900 && Date.now() - asked < 4500, `${Date.now() - asked} ms`);
  await expect("GET", "smart_home/pairing", null, 200, { fabric_count: 0, latest_pairing_status: { value: "never_started" } });
  await expect("POST", "smart_home/pairing", null, 503, error("Smart home unavailable"));
  await expect("GET", "smart_home/switch", null, 200, { state: true });
  await expect("POST", "smart_home/switch", '{"state":false}', 200, OK);
  await expect("GET", "smart_home/switch", null, 200, { state: false });
  await expect("POST", "smart_home/switch", '{"state":true,"startup":"last"}', 200, OK);
  await expect("POST", "smart_home/switch", '{"startup":"sometimes"}', 503, error("Smart home unavailable"));
  await expect("POST", "smart_home/switch", "{}", 400, error("Bad Request"));

  // Files.
  const dir = "/ext/api_test";
  await expect("POST", `storage/mkdir?path=${dir}/a/b`, null, 200, OK);
  await expect("POST", `storage/write?path=${dir}/a/one.txt`, "one", 200, OK);
  await expect("POST", `storage/write?path=${dir}/a/one.txt&append=1`, " two", 200, OK);
  await expect("GET", `storage/read?path=${dir}/a/one.txt`, null, 200, (j, text) => text === "one two");
  await expect("POST", `storage/write?path=${dir}/a/one.txt&append=2`, "x", 400, error("Bad Request"));
  await expect("POST", `storage/write?path=${dir}/a/b`, "x", 508, error("Failed to open file for writing"));
  await expect("POST", `storage/rename?path=${dir}/a/one.txt&new_path=${dir}/two.txt`, null, 200, OK);
  await expect("GET", `storage/list?path=${dir}`, null, 200, (j) => JSON.stringify(j.list.sort((x, y) => x.name.localeCompare(y.name))) === JSON.stringify([{ type: "dir", name: "a" }, { type: "file", name: "two.txt", size: 7 }]));
  await expect("GET", `storage/list?path=${dir}/nothing`, null, 400, error("Bad Request"));
  await expect("GET", `storage/read?path=${dir}/a`, null, 400, error("Bad Request"));
  await expect("GET", "storage/read?path=/ext/../secret", null, 400, error("Bad Request"));
  await expect("GET", "storage/read?path=/elsewhere/file", null, 400, error("Bad Request"));
  await expect("GET", "storage/status", null, 200, (j) => j.total_bytes === j.used_bytes + j.free_bytes && j.total_bytes > 0);
  await expect("DELETE", `storage/remove?path=${dir}`, null, 200, OK);
  await expect("DELETE", `storage/remove?path=${dir}`, null, 200, OK);
  await expect("GET", `storage/list?path=${dir}`, null, 400, error("Bad Request"));
  await expect("PUT", "storage/status", null, 405, error("Method Not Allowed"));

  // An app's assets.
  await expect("POST", "assets/upload?application_name=api.test&file=img/one.png", "png", 200, OK);
  await expect("GET", "storage/read?path=/ext/user_assets/api.test/img/one.png", null, 200, (j, text) => text === "png");
  await expect("POST", "assets/upload?application_name=api.test&file=../one.png", "png", 400, error("Bad Request"));
  await expect("POST", "assets/upload?application_name=bad name&file=one.png", "png", 400, error("Bad Request"));
  await expect("DELETE", "assets/upload?application_name=api.test", null, 200, OK);

  // The log.
  await expect("POST", "log_dump?filename=api_test_log", null, 200, { result: "OK", path: "/ext/api_test_log.txt" });
  await expect("GET", "storage/read?path=/ext/api_test_log.txt", null, 200);
  await expect("POST", "log_dump?filename=bad/name", null, 400, error("Bad Request"));
  await expect("DELETE", "storage/remove?path=/ext/api_test_log.txt", null, 200, OK);

  // Access over Wi-Fi and its tokens.
  const access = (await call(addr, "GET", "access")).json;
  await expect("POST", "access?mode=key&key=12", null, 400, error("Bad Request"));
  await expect("POST", "access?mode=key&key=123456", null, 200, OK);
  await expect("GET", "access", null, 200, { mode: "key", key_valid: true });
  await expect("POST", `access?mode=${access.mode}`, null, 200, OK);
  const minted = await expect("POST", "access/tokens", '{"name":"api test"}', 200, (j) => j.token.length === 32 && j.short_id === j.token.slice(0, 8) && j.name === "api test");
  await expect("GET", "access/tokens", null, 200, (j) => j.tokens.some((t) => t.short_id === minted.json?.short_id && !("token" in t)));
  await expect("POST", "access/tokens", "{}", 400, error("Bad Request"));
  await expect("DELETE", `access/tokens/${minted.json?.short_id}`, null, 200, OK);
  await expect("DELETE", `access/tokens/${minted.json?.short_id}`, null, 404, error("Not Found"));

  // The client's API version.
  const versioned = async (version) => (await fetch(`http://${addr}/api/name`, { headers: { "X-API-Sem-Ver": version } })).status;
  const major = (await call(addr, "GET", "version")).json.api_semver.split(".")[0];
  check("a client of the same major API version is served", (await versioned(`${major}.0.0`)) === 200);
  check("a client of another major API version is refused", (await versioned(`${Number(major) + 1}.0.0`)) === 405);

  await sleep(100);
  console.log(failed ? `${failed} checks failed` : "all checks passed");
}

let skip = 0;
if (bar) await compareWithBar();
else {
  const state = await fetch(`http://${addr}/_emu/state`).then((r) => r.json()).catch(() => null);
  if (!state || !("boots" in state)) {
    console.error(`No emulator at ${addr} (this form changes the device's state and does not run against a bar). Start one: node emulator/packages/server/index.mjs`);
    process.exit(1);
  }
  // On the emulator as it starts, before the checks below change its state.
  ({ skip } = await compareWithRecording());
  await emulatorAlone();
}
await target.stop();
totals({ pass: passed, fail: failed, skip });
process.exit(process.exitCode);
