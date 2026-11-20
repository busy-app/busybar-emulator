// An app's files and sounds where the firmware falls short (EMU-337): what a BUSY Bar did with them on 17.11, firmware
// 1.4.1 (28c175b3, on a U5 of its own build), written down in the task, not recorded by a
// program. The emulator must do the same, shortcomings included: an app is tried in the emulator and runs on a BUSY Bar.
//   A  a binary body in an app's fetch: the firmware sends the body's string (js_fetch_request.c, parse_request_body:
//      jerry_value_to_string, then UTF-8), so an ArrayBuffer is written as "[object ArrayBuffer]", a Uint8Array as
//      "0,1,2,…", body and the Response as "[object Object]"; blob() fails with "unimplemented" (its promise is rejected,
//      js_fetch_body_methods.c, blob_body_collected; the task's "throws" is what await makes of it). Downloading
//      binary works.
//   B  an app's write to its own assets (/ext/user_assets/<id>/…): 400. On a BUSY Bar, with a body of a sound file's
//      size, the app's fetch then never completes (files-api.mjs, storageApi, says why the emulator does not repeat
//      that and what its log says instead).
//   C  audio/play of a file in /ext/data: the path is always put after /ext/user_assets/<id>/ (api_audio.c), /ext/data
//      is not translated, so the file is not found: 404 "Failed to play audio" while the amplifier is warm. A first
//      call on a cold amplifier is answered 200 before the file is even opened (audio.c: the warmup comes first), as
//      the firmware's code says; the BUSY Bar's 404 for both came from a session that had just played sounds.
//   D  an app's rename from /ext/data into its assets: 400.
//   E  the computer's write to the file that plays: 508 "Failed to open file for writing", append=1 too. Its removal
//      and renaming are 400 by the firmware's code (storage_processing.c, FSE_ALREADY_OPEN; a rename is a copy and a
//      removal, so the copy stays): not measured on a BUSY Bar.
// On 1.3.1 /api/storage is not open to apps (403 by the firmware's allowlist), so A, B and D are refused; C and E are
// the same handlers as on 1.4.1. That line is the emulator's, by the firmware's code: no BUSY Bar with 1.3.1 was asked.
//
// test/api.mjs runs it in the emulator alone. Each firmware needs its line in EXPECTED: a firmware without one fails
// until its line is written. Open (the task, EMU-337): what a BUSY Bar with 1.4.1 writes for a string with "\0" in it
// ("A fromCharCode(0..255)" is the emulator's own, not compared), and from what body size the refused write of B
// hangs rather than ending as "Incomplete response body".
import { setTimeout as sleep } from "node:timers/promises";

import { targz } from "./package.mjs";

export const APP = "app.probe.files";
const FOLDER = `/ext/apps_data/js_apps/${APP}`;
const ASSETS = `/ext/user_assets/${APP}`;
const LOCAL_STORAGE = `/ext/apps_data/jsrunner/${APP}.localstorage.json`;
// Silence: raw 16-bit mono PCM at 44100 Hz, as the speaker plays it. The long one must still play when the checks made
// while it plays are over, on a busy machine too: 5 s for well under one at rest. The short one ends by itself.
const SOUND = new Uint8Array(44100 * 2 * 5);
const SHORT_SOUND = new Uint8Array(44100 * 2 / 2);
const SHORT_SOUND_MS = 500;
// 4096 bytes, 0 to 255 over and over: what the app downloads.
const SOURCE = Uint8Array.from({ length: 4096 }, (_, i) => i & 255);

const SCRIPT = `
const ID = ${JSON.stringify(APP)};
const base = "http://localhost/api/";
const all = {};
const msg = (e) => String(e && e.message !== undefined ? e.message : e);
const answer = (r) => r.text().then((text) => ({ status: r.status, text }));
const call = (method, path, body) => fetch(base + path, body === undefined ? { method } : { method, body }).then(answer, (e) => ({ error: msg(e) }));
const write = (name, body) => call("POST", "storage/write?path=/ext/data/" + name, body);
const read = () => fetch(base + "storage/read?path=/ext/data/src.bin");
const play = (path) => call("POST", "audio/play", JSON.stringify({ application_name: ID, path }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const chars = (from) => { let s = ""; for (let i = from; i < 256; i++) s += String.fromCharCode(i); return s; };
let sound = "";
for (let i = 0; i < 1024; i++) sound += "snd-snd-";
const steps = [
  ["A arrayBuffer()", () => read().then((r) => r.arrayBuffer()).then((b) => write("a-download.bin", b).then((w) => ({ byteLength: b.byteLength, write: w })))],
  ["A an ArrayBuffer made in JS", () => write("a-buffer.bin", new ArrayBuffer(4))],
  ["A a Uint8Array", () => write("a-uint8.bin", new Uint8Array([0, 1, 2, 3]))],
  ["A bytes()", () => read().then((r) => (typeof r.bytes !== "function" ? "no bytes()" : r.bytes().then((b) => write("a-bytes.bin", b))))],
  ["A body", () => read().then((r) => write("a-body.bin", r.body))],
  ["A the Response", () => read().then((r) => write("a-response.bin", r))],
  ["A blob()", () => read().then((r) => { try { return Promise.resolve(r.blob()).then(() => "resolved", (e) => "rejected " + msg(e)); } catch (e) { return "threw " + msg(e); } })],
  ["A fromCharCode(1..255)", () => write("a-chars.bin", chars(1))],
  ["A fromCharCode(0..255)", () => write("a-chars0.bin", chars(0))],
  ["B a write to the app's assets", () => call("POST", "storage/write?path=/ext/user_assets/" + ID + "/sounds/w.snd", sound)],
  ["B a write with append=2", () => call("POST", "storage/write?path=/ext/data/q.txt&append=2", "two bytes or more")],
  ["C the sound into /ext/data", () => write("w.snd", sound)],
  ["C play w.snd, cold", () => play("w.snd")],
  ["C play w.snd, warm", () => wait(300).then(() => play("w.snd"))],
  ["C play /ext/data/w.snd", () => wait(300).then(() => play("/ext/data/w.snd"))],
  ["D a rename into the app's assets", () => call("POST", "storage/rename?path=/ext/data/w.snd&new_path=/ext/user_assets/" + ID + "/sounds/w.snd")],
];
const one = (i) => {
  if (i >= steps.length) return;
  const [name, step] = steps[i];
  Promise.resolve()
    .then(step)
    .then((value) => value, (e) => ({ thrown: msg(e) }))
    .then((value) => {
      all[name] = value;
      localStorage.setItem("answers", JSON.stringify(all));
      one(i + 1);
    });
};
one(0);
`;

const STEPS = (SCRIPT.match(/^ {2}\["[^"]+"/gm) ?? []).map((s) => s.slice(4, -1));
// The files the app writes in its folder, read back from the computer.
const FILES = ["a-download.bin", "a-buffer.bin", "a-uint8.bin", "a-bytes.bin", "a-body.bin", "a-response.bin", "a-chars.bin", "a-chars0.bin", "w.snd"];

/** What came back of an app's request: the status and the error's text or the body, or the fetch's error. */
function answerOf(value) {
  if (!value || typeof value !== "object") return value ?? "no answer";
  // The fetch's own error, or one of the body's methods (text() of an answer that ends wrong).
  if (value.text === undefined) return value.error ?? value.thrown ?? JSON.stringify(value);
  let body = value.text;
  try {
    const json = JSON.parse(value.text);
    body = json.error ?? json.result ?? body;
  } catch {}
  return `${value.status} ${body}`.trim();
}

/**
 * Runs A to E on the emulator at `host`. Returns { "<step>": what the app got, "file <name>": the file's bytes as
 * text (latin1 for "a-chars*", where the bytes are the point) or "none", "log …": whether the log has the line,
 * "E …": the computer's answers }.
 */
export async function probeAppFiles(host) {
  const api = async (method, path, body, headers) => {
    const r = await fetch(`http://${host}/api/${path}`, { method, body, headers, signal: AbortSignal.timeout(10000) });
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  const text = (r) => new TextDecoder().decode(r.bytes);
  const short = (r) => {
    let body = text(r);
    try {
      body = JSON.parse(body).error ?? JSON.parse(body).result ?? body;
    } catch {}
    return `${r.status} ${body}`;
  };
  const manifest = { format_version: 1, id: APP, name: "Files probe", version: "0.1.0", api_version: "27.14.0", description: "An app's files and sounds (EMU-337)", debug: true };
  const archive = targz({ [`${APP}/appmeta/manifest.json`]: JSON.stringify(manifest), [`${APP}/scripts/main.js`]: SCRIPT, [`${APP}/sounds/e.snd`]: Buffer.from(SOUND), [`${APP}/sounds/f.snd`]: Buffer.from(SHORT_SOUND) });
  const staged = JSON.parse(text(await api("POST", "apps/stage", archive)));
  if (!staged.install_key) throw new Error(`stage: ${JSON.stringify(staged)}`);
  const installed = await api("POST", `apps/install?install_key=${staged.install_key}`);
  if (installed.status !== 200) throw new Error(`install: ${text(installed)}`);
  await sleep(500);
  await api("DELETE", `storage/remove?path=${LOCAL_STORAGE}`);
  await api("DELETE", `storage/remove?path=${FOLDER}`);
  await api("POST", `storage/write?path=${FOLDER}/src.bin`, SOURCE);
  const got = {};
  const answers = {};
  try {
    const launched = await api("POST", `apps/launch?app_id=${APP}`);
    if (launched.status !== 200) throw new Error(`launch: ${text(launched)}`);
    for (let i = 0; i < 40 && Object.keys(answers).length < STEPS.length; i++) {
      await sleep(1000);
      const file = await api("GET", `storage/read?path=${LOCAL_STORAGE}`);
      if (file.status !== 200) continue;
      Object.assign(answers, JSON.parse(JSON.parse(text(file)).data?.answers ?? "{}"));
    }
    await api("POST", "apps/quit");
    for (const name of STEPS) {
      const value = answers[name];
      got[name] = value && typeof value === "object" && "byteLength" in value ? `byteLength ${value.byteLength}, ${answerOf(value.write)}` : answerOf(value);
    }
    for (const name of FILES) {
      const r = await api("GET", `storage/read?path=${FOLDER}/${name}`);
      got[`file ${name}`] = r.status !== 200 ? "none" : name.startsWith("a-chars") ? Buffer.from(r.bytes).toString("hex") : text(r);
    }
    // The log: the firmware's audio service names the file it could not open; the emulator's note for B.
    await api("POST", "log_dump?filename=emu_probe_files");
    const log = text(await api("GET", "storage/read?path=/ext/emu_probe_files.txt"));
    await api("DELETE", "storage/remove?path=/ext/emu_probe_files.txt");
    got["log names w.snd under the assets"] = log.includes(`${ASSETS}/w.snd`);
    got["log names /ext/data/w.snd under the assets"] = log.includes(`${ASSETS}//ext/data/w.snd`);
    got["log says the write of B may hang on a BUSY Bar"] = /write to \/ext\/user_assets\/\S+ is refused with 400: an app writes only under \/ext\/data\. On a BUSY Bar .* may hang the app's fetch/.test(log);
    got["log names append=2 as the reason"] = /write to \/ext\/data\/q\.txt is refused with 400: append is neither 0 nor 1\./.test(log);
    // E: the computer plays the app's sound and writes to it meanwhile; then stops it and writes again.
    const sounds = `${ASSETS}/sounds`;
    const e = `storage/write?path=${sounds}/e.snd`;
    const play = (path) => api("POST", "audio/play", JSON.stringify({ application_name: APP, path }));
    const folder = async () => (JSON.parse(text(await api("GET", `storage/list?path=${sounds}`))).list ?? []).map((f) => f.name).sort().join(", ");
    await api("POST", `storage/write?path=${sounds}/x.snd`, SHORT_SOUND);
    got["E play the app's sound"] = short(await play("sounds/e.snd"));
    await sleep(300); // past the amplifier's warmup: the file is open
    const bit = SOUND.subarray(0, 64); // what is refused is refused before the body, so a small one does
    got["E write to it while it plays"] = short(await api("POST", e, bit));
    got["E append to it while it plays"] = short(await api("POST", `${e}&append=1`, bit));
    got["E remove it while it plays"] = short(await api("DELETE", `storage/remove?path=${sounds}/e.snd`));
    got["E rename it while it plays"] = short(await api("POST", `storage/rename?path=${sounds}/e.snd&new_path=${sounds}/e2.snd`));
    got["E rename another file onto it while it plays"] = short(await api("POST", `storage/rename?path=${sounds}/x.snd&new_path=${sounds}/e.snd`));
    got["E the folder after"] = await folder();
    // 200, not 410 "No audio is playing": the sound still played through all of the above.
    got["E stop"] = short(await api("DELETE", "audio/play"));
    got["E write to it after the stop"] = short(await api("POST", e, bit));
    // A sound that ends by itself closes its file: a wait well past its end (and the amplifier's warmup).
    got["E play a short sound"] = short(await play("sounds/f.snd"));
    await sleep(SHORT_SOUND_MS + 2000);
    got["E write to it after it ended by itself"] = short(await api("POST", `storage/write?path=${sounds}/f.snd`, bit));
  } finally {
    await api("POST", "apps/quit");
    await sleep(500);
    await api("DELETE", `apps?app_id=${APP}`);
    await api("DELETE", `storage/remove?path=${LOCAL_STORAGE}`);
    await api("DELETE", `storage/remove?path=${FOLDER}`);
  }
  return got;
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const chars = (from) => String.fromCharCode(...Array.from({ length: 256 - from }, (_, i) => i + from));
const SOUND_TEXT = "snd-snd-".repeat(1024);
// The C, D and E lines: the same handlers on both firmwares.
const AUDIO = {
  "C play w.snd, cold": "200 OK",
  "C play w.snd, warm": "404 Failed to play audio",
  "C play /ext/data/w.snd": "404 Failed to play audio",
  "log names w.snd under the assets": true,
  "log names /ext/data/w.snd under the assets": true,
  "E play the app's sound": "200 OK",
  "E write to it while it plays": "508 Failed to open file for writing",
  "E append to it while it plays": "508 Failed to open file for writing",
  "E remove it while it plays": "400 Bad Request",
  "E rename it while it plays": "400 Bad Request",
  "E rename another file onto it while it plays": "400 Bad Request",
  // The rename that failed left its copy, e2.snd; the one onto the playing file changed nothing.
  "E the folder after": "e.snd, e2.snd, f.snd, x.snd",
  "E stop": "200 OK",
  "E write to it after the stop": "200 OK",
  "E play a short sound": "200 OK",
  "E write to it after it ended by itself": "200 OK",
};

const CODE = "from the firmware's code, not measured on a BUSY Bar";
/**
 * The lines of the 1.4.1 line that are not what the BUSY Bar did on 17.11, and where they come from. (The 1.3.1 line
 * is all the emulator's, by the firmware's code: no BUSY Bar with 1.3.1 was asked.)
 */
export const NOT_FROM_THE_BAR = {
  "A blob()": `${CODE}: the promise is rejected (js_fetch_body_methods.c, blob_body_collected); the BUSY Bar's "Error: unimplemented" is the same message, how it came was not noted`,
  "B a write to the app's assets": "the emulator's own: the BUSY Bar ended a 1-byte body so (test/api/bar-1.4.1.json) and hung on a sound-sized one, which the emulator does not repeat",
  "log says the write of B may hang on a BUSY Bar": "the emulator's own note",
  "B a write with append=2": "the emulator's own, as for any refused write (B)",
  "log names append=2 as the reason": "the emulator's own note",
  "C play w.snd, cold": `${CODE}: on a cold amplifier the warmup comes first and the file is opened after the answer (audio.c)`,
  "E play the app's sound": CODE,
  "E remove it while it plays": `${CODE} (storage_processing.c, storage_process_common_remove: FSE_ALREADY_OPEN)`,
  "E rename it while it plays": `${CODE} (storage_external_api.c, storage_common_rename: the copy is made, the removal fails)`,
  "E rename another file onto it while it plays": `${CODE} (the copy cannot open the file that plays)`,
  "E the folder after": CODE,
  "E stop": CODE,
  "E write to it after the stop": CODE,
  "E play a short sound": CODE,
  "E write to it after it ended by itself": CODE,
};
const OK = "200 OK";
const BAD = "400 Bad Request";

/**
 * What each firmware does, by its name. Not here: "A fromCharCode(0..255)" and its file, the emulator's own until a
 * BUSY Bar is measured (open in EMU-337).
 */
export const EXPECTED = {
  // The BUSY Bar, 17.11 (EMU-337), but for NOT_FROM_THE_BAR.
  "1.4.1": {
    "A arrayBuffer()": `byteLength 4096, ${OK}`,
    "A an ArrayBuffer made in JS": OK,
    "A a Uint8Array": OK,
    "A bytes()": OK,
    "A body": OK,
    "A the Response": OK,
    "A blob()": "rejected unimplemented",
    "A fromCharCode(1..255)": OK,
    "B a write to the app's assets": "Incomplete response body",
    "B a write with append=2": "Incomplete response body",
    "C the sound into /ext/data": OK,
    "D a rename into the app's assets": BAD,
    "file a-download.bin": "[object ArrayBuffer]",
    "file a-buffer.bin": "[object ArrayBuffer]",
    "file a-uint8.bin": "0,1,2,3",
    "file a-bytes.bin": Array.from(SOURCE).join(","),
    "file a-body.bin": "[object Object]",
    "file a-response.bin": "[object Object]",
    "file a-chars.bin": hex(Buffer.from(chars(1), "utf8")),
    "file w.snd": SOUND_TEXT,
    "log says the write of B may hang on a BUSY Bar": true,
    "log names append=2 as the reason": true,
    ...AUDIO,
  },
  // /api/storage is the firmware's 403 to an app; C and E as on 1.4.1. The emulator's, by the firmware's code.
  "1.3.1": {
    "A arrayBuffer()": "byteLength 22, 403 Forbidden",
    "A an ArrayBuffer made in JS": "403 Forbidden",
    "A a Uint8Array": "403 Forbidden",
    "A bytes()": "403 Forbidden",
    "A body": "403 Forbidden",
    "A the Response": "403 Forbidden",
    "A blob()": "rejected unimplemented",
    "A fromCharCode(1..255)": "403 Forbidden",
    "B a write to the app's assets": "403 Forbidden",
    "B a write with append=2": "403 Forbidden",
    "C the sound into /ext/data": "403 Forbidden",
    "D a rename into the app's assets": "403 Forbidden",
    "file a-download.bin": "none",
    "file a-buffer.bin": "none",
    "file a-uint8.bin": "none",
    "file a-bytes.bin": "none",
    "file a-body.bin": "none",
    "file a-response.bin": "none",
    "file a-chars.bin": "none",
    "file w.snd": "none",
    "log says the write of B may hang on a BUSY Bar": false,
    "log names append=2 as the reason": false,
    ...AUDIO,
  },
};

/** Each line of a probe (probeAppFiles) against EXPECTED for `firmware`, as [name, ok, detail]. */
export function compareAppFiles(firmware, got) {
  const want = EXPECTED[firmware];
  if (!want) return [[`app files: firmware ${firmware}`, false, `no line in EXPECTED of test/app-files.mjs for firmware ${firmware}`]];
  const show = (v) => (typeof v === "string" && v.length > 80 ? `${v.slice(0, 80)}… (${v.length})` : JSON.stringify(v));
  const source = (name) => (firmware === "1.4.1" && NOT_FROM_THE_BAR[name] ? ` (${NOT_FROM_THE_BAR[name]})` : "");
  const lines = Object.entries(want).map(([name, value]) => [`app files: ${name}`, got[name] === value, `${got[name] === value ? show(value) : `want ${show(value)} | emulator ${show(got[name])}`}${source(name)}`]);
  // Not compared: the emulator's own, for the task.
  lines.push(["app files: A fromCharCode(0..255) (not measured on a BUSY Bar)", true, `${got["A fromCharCode(0..255)"]}, file ${show(got["file a-chars0.bin"])}`]);
  return lines;
}
