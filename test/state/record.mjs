// Records a BUSY Bar's answers to the app requests of state/bar-state-1.3.1.json (the groups apps, settings, input
// and quit: the probe app installed, launched twice, its settings read, written and refused, the wheel, OK, Start and a
// short Back while it runs, and quit) as state/bar-state-<firmware>.json, which state.test.mjs replays in an emulator
// on that firmware. The requests are the 1.3.1 recording's, in its order and with its waits; what is new is each
// answer byte for byte and both displays' frames in full where 1.3.1 kept their hashes. Firmware 1.4.1 keeps an app's
// screen on a short Back (4d1c24ac): the frame after `input?key=back` shows it.
//
//   node emulator/test/state/record.mjs [--bar 10.0.4.20]
//
// The bar's brightness, volume, name and time zone are not changed and not recorded: the replay gives the emulator a
// brightness and volume of the bar's (read here) and the name "BUSY Bar". Afterwards the probe app is quit and
// removed, with its settings and its localStorage; the bar then shows the apps menu.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../../packages/server/arguments.mjs";
import { targz } from "../package.mjs";

await commandLine(process.argv, { values: ["--bar"] });
const args = process.argv.slice(2);
const bar = args.includes("--bar") ? args[args.indexOf("--bar") + 1] : "10.0.4.20";
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE = "app.probe.cmp";
const GROUPS = ["apps", "settings", "input", "quit"];

// The probe app, packed as state.test.mjs packs it.
function probeArchive() {
  const dir = join(here, PROBE);
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[`${PROBE}/${relative(dir, p).split("\\").join("/")}`] = readFileSync(p);
    }
  };
  walk(dir);
  return targz(files);
}

async function call(method, path, body = null) {
  const r = await fetch(`http://${bar}/api/${path}`, { method, body: method === "GET" ? null : body, signal: AbortSignal.timeout(15000) });
  return { status: r.status, contentType: r.headers.get("content-type"), text: await r.text() };
}
const frame = async (display) => (await call("GET", `screen?display=${display}`)).text;

const firmware = JSON.parse((await call("GET", "status/firmware")).text);
const api = JSON.parse((await call("GET", "version")).text).api_semver;
const brightness = JSON.parse((await call("GET", "display/brightness")).text);
const volume = JSON.parse((await call("GET", "audio/volume")).text);
if ((await call("GET", "apps/list")).text.includes(`"${PROBE}"`)) throw new Error(`${PROBE} is installed on the bar: remove it first`);

const source = JSON.parse(readFileSync(join(here, "bar-state-1.3.1.json"), "utf8"));
const plan = source.requests.filter((r) => GROUPS.includes(r.group));
console.log(`recording ${plan.length} requests on the bar at ${bar}, firmware ${firmware.version} (${firmware.commit_hash})`);
const requests = [];
let staged = null;
try {
  for (const step of plan) {
    const body = step.archive ? probeArchive() : step.body ?? null;
    const path = step.path.replace("<staged>", String(staged));
    const got = await call(step.method, path, body);
    if (step.path === "apps/stage") staged = JSON.parse(got.text).install_key;
    const entry = { group: step.group, method: step.method, path: step.path };
    if (step.archive) entry.archive = step.archive;
    else if (step.body !== undefined) entry.body = step.body;
    if (step.note) entry.note = step.note;
    Object.assign(entry, { status: got.status, contentType: got.contentType, response: got.text });
    if (step.wait) entry.wait = step.wait;
    if (step.frameHashes) {
      // As long as the 1.3.1 recording waited before it looked, then both displays as GET /api/screen gives them.
      await sleep(step.wait ?? 700);
      entry.frames = { front: await frame(0), back: await frame(1) };
    } else if (step.wait) await sleep(step.wait);
    requests.push(entry);
    console.log(`  ${step.method} /api/${path}: ${got.status}${entry.frames ? ", frames" : ""}`);
  }
} finally {
  await call("POST", "apps/quit");
  await sleep(1500);
  await call("DELETE", `apps?app_id=${PROBE}`);
  // The bar keeps an app's settings after the app is removed (DELETE apps/settings writes the defaults back).
  await call("DELETE", `storage/remove?path=/ext/apps_data/jsrunner/${PROBE}.settings.json`);
  await call("DELETE", `storage/remove?path=/ext/apps_data/jsrunner/${PROBE}.localstorage.json`);
}

const out = join(here, `bar-state-${firmware.version}.json`);
const recording = {
  recorded: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  bar: `a stock bar: firmware ${firmware.version} (${firmware.commit_hash}), API ${api}, the mode selector in APPS, no app running`,
  script: "test/state/record.mjs: the requests of the groups apps, settings, input and quit of bar-state-1.3.1.json, in its order and with its waits",
  exact: true,
  exactNote: "answers byte for byte, a final line feed included; frames as GET /api/screen gives them, base64, taken after the request's wait",
  start: { brightness: String(brightness.value), volume: volume.volume, name: "BUSY Bar" },
  requests,
};
writeFileSync(out, JSON.stringify(recording) + "\n");
console.log(`recorded: ${out}`);
