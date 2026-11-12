// The speed probe (probes/app.probe.speed) on a bar or in the emulator: JS speed, display/draw time and the frame rate
// of an app animating from JS. The bar's numbers are what the emulator's bar speed is set from (packages/server/bar-speed.mjs).
//
//   node emulator/test/speed.mjs --record [--bar 10.0.4.20]   run it on the bar, save its times and the model fitted
//                                                             to them to packages/server/bar-speed.json
//   node emulator/test/speed.mjs --fit                        fit the model again to the saved times (no bar needed)
//   node emulator/test/speed.mjs [--firmware dev]             run it in an emulator of its own, compare with the bar:
//                                                             each number within SPEED_TOLERANCE of the bar's
//   node emulator/test/speed.mjs --emu 127.0.0.1:8640         the same in an emulator that is already running
//
// The probe is installed, run once (about 15 s on a bar) and removed. The model is the bar's price of a byte-code
// instruction and of a heap byte, and its API's time: the fit counts the work of the probe's pieces in the runtime
// (the firmware's own, --firmware as for the server) and solves for the prices that give the bar's times.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";
import { fitModel, probeSource } from "../packages/server/bar-speed.mjs";
import { AppRuntime } from "../packages/server/runtime.mjs";
import { loadFirmware } from "../packages/server/firmware.mjs";
import { emulatorFor, totals } from "./own-emulator.mjs";
import { targz } from "./package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = "app.probe.speed";
const probeDir = join(here, "probes", PROBE);
const barFile = join(here, "..", "packages", "server", "bar-speed.json");

const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--emu", "--firmware"], flags: ["--record", "--fit"], emulator: "--emu" });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const record = args.includes("--record");
const fitOnly = args.includes("--fit");
const firmware = loadFirmware(option("--firmware", process.env.EMU_FIRMWARE));
// How far each of the emulator's numbers may be from the bar's, as a share of the bar's. The emulator is compared with
// one recording of a bar (bar-speed.json), the one the model was fitted to, and its own numbers hardly move from run
// to run: over 100 saved runs on macOS and Windows, both firmwares, and machines 30-70 % busy, step 0.99, XPM 0.98, both
// draws 0.99, FPS 1.038-1.041, each within 1 % (review of EMU-006, 11.11). So the four fitted numbers get ±3 %: a
// change of the model by more than that is caught. FPS is not fitted (it checks the model), and the model puts it 4 %
// above the bar's; ±6 % leaves it only about 2 points before it fails: a model that gets a little faster fails here.
const SPEED_TOLERANCE = { stepMs: 0.03, xpmMs: 0.03, drawTextMs: 0.03, drawFullMs: 0.03, loopFps: 0.06 };
// The bar (--record), nobody (--fit), or the emulator: one at --emu, else one of this test's own, at bar speed.
const target = record ? { addr: option("--bar", "10.0.4.20"), stop: async () => {} } : fitOnly ? { addr: null, stop: async () => {} } : await emulatorFor(args, { name: "speed" });
const addr = target.addr;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The first four are what the model was fitted to: they show the model is applied, not that it predicts. Only the
// last is a prediction of the bar.
const ROWS = [
  ["stepMs", "fitted: fire step, ms"],
  ["xpmMs", "fitted: XPM of a frame, ms"],
  ["drawTextMs", "fitted: draw short text, ms"],
  ["drawFullMs", "fitted: draw full frame, ms"],
  ["loopFps", "predicted: loop, FPS"],
];

// One retry: while the probe's long synchronous loops hold the emulator's event loop, the server's keep-alive timer can
// close a connection just as the next request goes out on it.
async function call(method, path, body, retry = true) {
  try {
    const r = await fetch(`http://${addr}/api/${path}`, { method, body });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    if (retry && e.cause?.code === "ECONNRESET") return call(method, path, body, false);
    throw new Error(`${method} /api/${path}: ${e.cause?.code ?? e.message}`, { cause: e });
  }
}

function files(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

async function install() {
  const entries = Object.fromEntries(files(probeDir).map((f) => [`${PROBE}/${relative(probeDir, f).replaceAll("\\", "/")}`, readFileSync(f)]));
  const staged = await fetch(`http://${addr}/api/apps/stage`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: targz(entries) });
  const { install_key } = await staged.json();
  if (!install_key) throw new Error("stage failed");
  const installed = await call("POST", `apps/install?install_key=${install_key}`);
  if (installed.status !== 200) throw new Error(`install: ${installed.status} ${installed.text}`);
  await sleep(500);
}

// What the probe left in its localStorage, or null while it runs.
async function result() {
  const r = await call("GET", `storage/read?path=/ext/apps_data/jsrunner/${PROBE}.localstorage.json`);
  if (r.status !== 200) return null;
  // js_local_storage.c's file: {"format_version": 1, "data": {key: value}}.
  const value = JSON.parse(r.text).data?.speed;
  return value ? JSON.parse(value) : null;
}

async function run() {
  await call("POST", `apps/quit`);
  await install();
  // A result from an earlier run must not count.
  await call("DELETE", `storage/remove?path=/ext/apps_data/jsrunner/${PROBE}.localstorage.json`);
  const launched = await call("POST", `apps/launch?app_id=${PROBE}`);
  if (launched.status !== 200) throw new Error(`launch: ${launched.status} ${launched.text}`);
  const t0 = Date.now();
  let r = null;
  while (!r && Date.now() - t0 < 90000) {
    await sleep(1000);
    r = await result();
  }
  await call("POST", `apps/quit`);
  await call("DELETE", `apps?app_id=${PROBE}`);
  if (!r) throw new Error("no result in 90 s");
  return r;
}

const fmt = (v) => (v === undefined ? "—" : v.toFixed(v < 10 ? 2 : 1));

// The work of the probe's pieces: instructions and heap bytes of one fire step, one XPM frame and one draw of each
// kind (the JS around the request; the API answers at once). The pieces are the probe's own definitions, run in a
// runtime at the computer's speed; the counters are read at the marks the script logs.
async function probeWork() {
  const STEPS = 50;
  const FRAMES = 10;
  const DRAWS = 10;
  const source = readFileSync(join(probeDir, "scripts", "main.js"), "utf8");
  const definitions = source.slice(0, source.indexOf("// The measurements."));
  if (!definitions) throw new Error("the probe's definitions end with the comment '// The measurements.'");
  const script = `${definitions}
    const texts = [], frames = [];
    for (let i = 0; i < ${DRAWS}; i++) texts.push(textBody(i));
    for (let i = 0; i < ${DRAWS}; i++) frames.push(frameBody());
    // As timedDraws does: one draw after another.
    function draws(bodies) {
      let chain = Promise.resolve();
      for (let i = 0; i < ${DRAWS}; i++) chain = chain.then(() => draw(bodies[i]));
      return chain;
    }
    console.log("start");
    for (let i = 0; i < ${STEPS}; i++) step(i);
    console.log("step");
    for (let i = 0; i < ${FRAMES}; i++) xpm();
    console.log("xpm");
    draws(texts)
      .then(() => {
        console.log("drawText");
        return draws(frames);
      })
      .then(() => console.log("drawFull"));
  `;
  const marks = [];
  let runtime;
  await new Promise((resolve, reject) => {
    runtime = new AppRuntime({
      firmware,
      appId: PROBE,
      heapKib: 96,
      entry: "/probe.js",
      readFile: (p) => (p === "/probe.js" ? new TextEncoder().encode(script) : null),
      writeFile: () => false,
      localApi: async () => ({ status: 200, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode('{"result":"OK"}') }),
      onConsole: (severity, text) => marks.push({ name: text, ...runtime.work() }),
      onLog: () => {},
      onExit: (reason) => (reason === "finished" ? resolve() : reject(new Error(`counting the probe's work: ${reason}`))),
    });
    runtime.start().catch(reject);
  });
  const piece = (name, count) => {
    const i = marks.findIndex((m) => m.name === name);
    if (i < 1) throw new Error(`counting the probe's work: no "${name}" mark`);
    return { ops: (marks[i].ops - marks[i - 1].ops) / count, allocBytes: (marks[i].bytes - marks[i - 1].bytes) / count };
  };
  return { step: piece("step", STEPS), xpm: piece("xpm", FRAMES), drawText: piece("drawText", DRAWS), drawFull: piece("drawFull", DRAWS) };
}

const MODEL_NOTE =
  "The bar's time for an app's work, fitted by emulator/test/speed.mjs to the times above: JS takes opMs per byte-code " +
  "instruction plus allocByteMs per heap byte allocated; the bar's API answers a request in apiMs plus apiByteMs per " +
  "byte of its body. work: instructions and heap bytes of the probe's pieces, counted in the runtime of `firmware`.";

// The bar's times with the model that reproduces them.
async function saveWithModel(times) {
  const work = await probeWork();
  const model = fitModel(times, work);
  const { model: _old, api: _older, ...rest } = times;
  // A recording made before EMU-250 named the bar by its serial number; --fit must not write it back.
  if (rest.source?.serial !== undefined) throw new Error(`${relative(process.cwd(), barFile)}: source names the bar by its serial number; record again or name it as probeSource does`);
  // `network` is measured apart from the probe (see its note) and stays through a new recording.
  const network = rest.network ?? JSON.parse(readFileSync(barFile, "utf8")).network;
  writeFileSync(barFile, JSON.stringify({ ...rest, network, model: { note: MODEL_NOTE, ...model, firmware: firmware.name, work } }, null, 2) + "\n");
  const us = (ms) => (ms * 1000).toFixed(2);
  console.log(`model: ${us(model.opMs)} us per instruction, ${us(model.allocByteMs)} us per heap byte; API ${model.apiMs.toFixed(1)} ms + ${us(model.apiByteMs)} us per body byte`);
  console.log(`saved ${relative(process.cwd(), barFile)}`);
}

if (fitOnly) {
  await saveWithModel(JSON.parse(readFileSync(barFile, "utf8")));
} else if (record) {
  // The bar is named by model and firmware (probeSource), not by its serial number: bar-speed.json ships.
  const source = probeSource(JSON.parse((await call("GET", "status/firmware")).text));
  console.log(`speed probe on ${source.bar} (${source.firmware})`);
  const r = await run();
  for (const [key, label] of ROWS) console.log(`  ${label.padEnd(26)} ${fmt(r[key])}`);
  await saveWithModel({ source, ...r });
} else {
  const bar = JSON.parse(readFileSync(barFile, "utf8"));
  const r = await run();
  console.log(`speed probe: ${bar.source.bar} (${bar.source.firmware}) vs emulator ${addr}`);
  console.log(`  ${"".padEnd(31)} ${"bar".padStart(8)} ${"emulator".padStart(9)}  ratio  allowed`);
  let passed = 0;
  let failed = 0;
  for (const [key, label] of ROWS) {
    const ratio = bar[key] && r[key] ? r[key] / bar[key] : null;
    const allowed = SPEED_TOLERANCE[key];
    const ok = ratio !== null && Math.abs(ratio - 1) <= allowed;
    if (ok) passed++;
    else failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(26)} ${fmt(bar[key]).padStart(8)} ${fmt(r[key]).padStart(9)}  ${ratio?.toFixed(3) ?? "—"}  ±${allowed * 100} %`);
  }
  console.log(`  draw bodies: text ${r.drawTextBytes} B, full frame ${r.drawFullBytes} B`);
  console.log(failed ? `${failed} numbers are further off the bar's than allowed` : "all numbers within what is allowed of the bar's");
  await target.stop();
  totals({ pass: passed, fail: failed });
}
