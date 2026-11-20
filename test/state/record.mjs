// Records a BUSY Bar's answers to the app requests of state/bar-state-1.3.1.json (the groups apps, settings, input
// and quit: the probe app installed, launched twice, its settings read, written and refused, the wheel, OK, Start and a
// short Back while it runs, and quit) as state/bar-state-<firmware>.json, which state.test.mjs replays in an emulator
// on that firmware. The requests are the 1.3.1 recording's, in its order and with its waits; what is new is each
// answer byte for byte and both displays' frames in full where 1.3.1 kept their hashes. Firmware 1.4.1 keeps an app's
// screen on a short Back (4d1c24ac): the frame after `input?key=back` shows it.
//
//   node emulator/test/state/record.mjs [--bar 10.0.4.20]
//   node emulator/test/state/record.mjs --more [--bar 10.0.4.20]
//
// --more records the groups draw and busy of the night's recording, bar-state-1.3.1-more.json (drawing from outside;
// the BUSY timer and its profiles), in its order and with its waits, as bar-state-<firmware>-more.json (EMU-348). A
// request that carries the time it was sent at (snapshot_timestamp_ms, profile_timestamp_ms) carries this computer's
// time at the moment it is sent; one that sends back a time the bar answered with earlier sends the time this bar
// answered with there. The BUSY timer must not be running: the group refuses to start otherwise. Its state and both
// profiles are read first and put back after, whatever happens.
//
// EMU_RECORDINGS names another folder for the recording (own-emulator.mjs, recordingsRoot): the BUSY Bar session's trial
// run against an emulator writes there.
//
// The bar's brightness, volume, name and time zone are not changed and not recorded: the replay gives the emulator a
// brightness and volume of the bar's (read here) and the name "BUSY Bar". Afterwards the probe app is quit and
// removed, with its settings and its localStorage; the bar then shows the apps menu.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../../packages/server/arguments.mjs";
import { targz } from "../package.mjs";

await commandLine(process.argv, { values: ["--bar"], flags: ["--more"] });
const args = process.argv.slice(2);
const bar = args.includes("--bar") ? args[args.indexOf("--bar") + 1] : "10.0.4.20";
const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE = "app.probe.cmp";
const more = args.includes("--more");
const GROUPS = more ? ["draw", "busy"] : ["apps", "settings", "input", "quit"];
const FROM = more ? "bar-state-1.3.1-more.json" : "bar-state-1.3.1.json";
const outDir = process.env.EMU_RECORDINGS ? join(process.env.EMU_RECORDINGS, "state") : here;

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

const source = JSON.parse(readFileSync(join(here, FROM), "utf8"));
const plan = source.requests.filter((r) => GROUPS.includes(r.group));
// The BUSY timer and its profiles as they are, to be put back.
const busyBefore = more
  ? { snapshot: JSON.parse((await call("GET", "busy/snapshot")).text), busy: JSON.parse((await call("GET", "busy/profiles/busy")).text), custom: JSON.parse((await call("GET", "busy/profiles/custom")).text) }
  : null;
if (busyBefore && busyBefore.snapshot.snapshot?.type !== "NOT_STARTED") throw new Error(`the BUSY timer runs (${busyBefore.snapshot.snapshot?.type}): stop it on the BUSY Bar first; the recording starts and stops it`);
// The times a request carries: the recording's → this run's (stamps).
// The night's requests after which the displays show the BUSY Bar's own menu (by their notes).
const OWN_MENU = ["all of it", "no application_name: clears what the nameless draw may have left", "before", "stop"];
const STAMP = /"(snapshot|profile)_timestamp_ms":(\d+)/g;
const stamps = new Map();
const restamp = (body) => (typeof body === "string" ? body.replace(STAMP, (all, kind, ms) => {
  if (!stamps.has(ms)) stamps.set(ms, String(Date.now()));
  return `"${kind}_timestamp_ms":${stamps.get(ms)}`;
}) : body);
console.log(`recording ${plan.length} requests on the bar at ${bar}, firmware ${firmware.version} (${firmware.commit_hash})`);
const requests = [];
let staged = null;
if (more) {
  // From where the night's recording started: the mode selector in APPS, the APPS splash on both displays (no app's
  // list): what the BUSY Bar shows once a drawing is gone is compared too.
  await call("POST", "apps/quit");
  await call("POST", "input?key=settings");
  await sleep(1500);
  await call("POST", "input?key=apps");
  await sleep(3000);
}
try {
  for (const step of plan) {
    if (step.before) await sleep(step.before);
    const sent = restamp(step.body);
    const body = step.archive ? probeArchive() : sent ?? null;
    const path = step.path.replace("<staged>", String(staged));
    const got = await call(step.method, path, body);
    // A time the bar answered with, which a later request may send back: the recording's → this bar's.
    const old = [...(step.response ?? "").matchAll(/_timestamp_ms":(\d+)/g)].map((m) => m[1]);
    const now = [...got.text.matchAll(/_timestamp_ms":(\d+)/g)].map((m) => m[1]);
    old.forEach((ms, i) => now[i] !== undefined && !stamps.has(ms) && stamps.set(ms, now[i]));
    if (step.path === "apps/stage") staged = JSON.parse(got.text).install_key;
    const entry = { group: step.group, method: step.method, path: step.path };
    if (step.archive) entry.archive = step.archive;
    else if (step.body !== undefined) entry.body = sent;
    if (step.note) entry.note = step.note;
    if (step.before) entry.before = step.before;
    // The bar's own profiles, given to the emulator first: from this recording's answers to their GETs.
    if (step.emulatorFirst) {
      entry.emulatorFirst = step.emulatorFirst.map((first) => ({ ...first, fromResponseOf: requests.findLastIndex((r) => r.method === "GET" && r.path === first.path) }));
    }
    for (const key of ["mask", "maskNote", "compare", "alsoAccepted"]) if (step[key] !== undefined) entry[key] = step[key];
    // Once the drawing is gone and while no timer runs, the displays show the BUSY Bar's own menu: its apps, which the
    // replay's emulator does not have. Its frames are kept, not compared.
    if (more && step.frames && OWN_MENU.includes(step.note)) {
      entry.mask = { front: "all", back: "all" };
      entry.maskNote = "the BUSY Bar's own APPS menu, with its own apps";
    }
    Object.assign(entry, { status: got.status, contentType: got.contentType, response: got.text });
    if (step.wait) entry.wait = step.wait;
    if (step.frameHashes || step.frames) {
      // As long as the 1.3.1 recording waited before it looked, then both displays as GET /api/screen gives them. (The
      // night's frames were taken right after the answer when it had no wait: the replay looks at that moment too.)
      await sleep(step.wait ?? (step.frames ? 0 : 700));
      entry.frames = { front: await frame(0), back: await frame(1) };
    } else if (step.wait) await sleep(step.wait);
    requests.push(entry);
    console.log(`  ${step.method} /api/${path}: ${got.status}${entry.frames ? ", frames" : ""}`);
  }
} finally {
  if (busyBefore) {
    // The timer stopped as it was before, and both profiles back, with times of now so that the bar takes them.
    await call("PUT", "busy/snapshot", JSON.stringify({ ...busyBefore.snapshot, snapshot_timestamp_ms: Date.now() }));
    await call("PUT", "busy/profiles/busy", JSON.stringify({ ...busyBefore.busy, profile_timestamp_ms: Date.now() }));
    await call("PUT", "busy/profiles/custom", JSON.stringify({ ...busyBefore.custom, profile_timestamp_ms: Date.now() }));
    await call("DELETE", "display/draw?application_name=app.probe.draw");
    await call("DELETE", "display/draw");
  }
  await call("POST", "apps/quit");
  await sleep(1500);
  await call("DELETE", `apps?app_id=${PROBE}`);
  // The bar keeps an app's settings after the app is removed (DELETE apps/settings writes the defaults back).
  await call("DELETE", `storage/remove?path=/ext/apps_data/jsrunner/${PROBE}.settings.json`);
  await call("DELETE", `storage/remove?path=/ext/apps_data/jsrunner/${PROBE}.localstorage.json`);
}

mkdirSync(outDir, { recursive: true });
const out = join(outDir, `bar-state-${firmware.version}${more ? "-more" : ""}.json`);
const recording = {
  recorded: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  bar: `a stock bar: firmware ${firmware.version} (${firmware.commit_hash}), API ${api}, the mode selector in APPS, no app running`,
  script: `test/state/record.mjs${more ? " --more" : ""}: the requests of the groups ${GROUPS.join(", ")} of ${FROM}, in its order and with its waits`,
  exact: true,
  exactNote: "answers byte for byte, a final line feed included; frames as GET /api/screen gives them, base64, taken after the request's wait",
  start: { brightness: String(brightness.value), volume: volume.volume, name: "BUSY Bar" },
  requests,
};
writeFileSync(out, JSON.stringify(recording) + "\n");
console.log(`recorded: ${out}`);
