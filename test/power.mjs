// What the emulated bar does when things go wrong, and its power: the firmware's supervisor in the screen module.
//
//   node emulator/test/power.mjs [--firmware dev] [--images]
//
// In an emulator of its own (own-emulator.mjs), or the one --addr 127.0.0.1:8640 names (never a bar: the test fills
// the JS heap and powers the device off):
//   - a restart keeps the bar's name and starts the uptime again;
//   - an app that fills the JS heap in the first 30 seconds after start leaves the supervisor's warning on both
//     displays, and the bar takes no input until it is restarted;
//   - the same app later restarts the bar (a bar without the debug flag);
//   - Back and Start held together restart it;
//   - on battery at 1 % the supervisor counts 30 seconds and powers the bar off; a button turns it back on.
// --images saves the warnings' frames to a folder of the system's temporary folder (EMU_TEST_OUT when the gate runs it).
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { commandLine } from "../packages/server/arguments.mjs";
import { emulatorFor, outputDir, totals } from "./own-emulator.mjs";
import { targz } from "./package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--addr", "--firmware"], flags: ["--images"] });
const images = args.includes("--images");
const target = await emulatorFor(args, { flag: "--addr", name: "power" });
const addr = target.addr;
const PROBE = "app.probe.oom";
const probeDir = join(here, "probes", PROBE);

const api = async (method, path, body) => {
  const r = await fetch(`http://${addr}/api/${path}`, { method, body });
  return { status: r.status, text: await r.text() };
};
const emu = async (method, path) => (await fetch(`http://${addr}/_emu/${path}`, { method })).json();
const state = () => emu("GET", "state");
const frame = async (display) => (await api("GET", `screen?display=${display}`)).text;
const lit = (base64) => Buffer.from(base64, "base64").some((b) => b !== 0);

async function until(what, check, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// The clock of the system, moved on by `ms` without waiting for them.
async function skip(ms) {
  await emu("POST", "time?hold=1");
  await emu("POST", `time?advance=${ms}`);
  await emu("POST", "time?hold=0");
}

async function restart() {
  const before = (await state()).boots;
  await emu("POST", "power?action=restart");
  await until("the restart", async () => (await state()).boots > before && (await api("GET", "version")).status === 200);
}

function files(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

async function install() {
  const entries = Object.fromEntries(files(probeDir).filter((f) => !/[\\/]\._/.test(f)).map((f) => [`${PROBE}/${relative(probeDir, f).replaceAll("\\", "/")}`, readFileSync(f)]));
  const staged = await fetch(`http://${addr}/api/apps/stage`, { method: "POST", body: targz(entries) });
  const { install_key } = await staged.json();
  if (!install_key) throw new Error("stage failed");
  const installed = await api("POST", `apps/install?install_key=${install_key}`);
  if (installed.status !== 200) throw new Error(`install: ${installed.status} ${installed.text}`);
}

// A PNG of a display's frame, for a look at the warnings.
function png(width, height, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

async function save(name) {
  if (!images) return;
  const dir = outputDir("power");
  const front = Buffer.from(await frame(0), "base64"); // B, G, R
  const rgb = Buffer.alloc(72 * 16 * 3);
  for (let i = 0; i < 72 * 16; i++) rgb.set([front[i * 3 + 2], front[i * 3 + 1], front[i * 3]], i * 3);
  writeFileSync(join(dir, `${name}-front.png`), png(72, 16, rgb));
  const back = Buffer.from(await frame(1), "base64"); // 4 bits a pixel
  const gray = Buffer.alloc(160 * 80 * 3);
  for (let i = 0; i < 160 * 80; i++) gray.fill(((back[i >> 1] >> (i & 1 ? 4 : 0)) & 15) * 17, i * 3, i * 3 + 3);
  writeFileSync(join(dir, `${name}-back.png`), png(160, 80, gray));
}

let failed = 0;
let passed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  else passed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

const first = await state().catch(() => null);
if (!first) {
  console.error(`No emulator at ${addr}. Start one: node emulator/packages/server/index.mjs`);
  process.exit(1);
}
if (!("boots" in first)) {
  console.error(`${addr} is not an emulator: this test powers the device off and must not run against a bar`);
  process.exit(1);
}

console.log(`power and failures: emulator ${addr}`);

// ---------------------------------------------------------------- a restart
{
  await api("POST", "name", JSON.stringify({ name: "Power test" }));
  await sleep(1100);
  await restart();
  const name = JSON.parse((await api("GET", "name")).text).name;
  const uptime = JSON.parse((await api("GET", "status/system")).text).uptime;
  check("a restart keeps the bar's name", name === "Power test", name);
  check("a restart starts the uptime again", /00d 00h 00m 0[0-3]s/.test(uptime), uptime);
  await api("POST", "name", JSON.stringify({ name: "BUSY Bar Emulator" }));
}

await install();

// ---------------------------------------------------------------- the JS heap fills right after start
{
  await restart();
  await api("POST", `apps/launch?app_id=${PROBE}`);
  await sleep(2500);
  const [front, back] = [await frame(0), await frame(1)];
  await save("heap-overflow");
  const s = await state();
  check("heap overflow in the first 30 s: the bar does not restart", s.powered && s.running?.id === PROBE, `running ${s.running?.id}`);
  check("heap overflow in the first 30 s: a warning is on both displays", lit(front) && lit(back));
  // The supervisor takes all input: neither Back nor the mode selector changes the picture.
  await api("POST", "input?key=back");
  await api("POST", "input?key=busy");
  await sleep(400);
  check("heap overflow in the first 30 s: no input is taken", (await frame(0)) === front);
  await api("POST", "input?key=apps");
}

// ---------------------------------------------------------------- the JS heap fills later
{
  await restart();
  await skip(31000);
  const before = (await state()).boots;
  await api("POST", `apps/launch?app_id=${PROBE}`);
  const s = await until("the restart after a heap overflow", async () => {
    const now = await state();
    return now.boots > before && now.powered && (await api("GET", "version")).status === 200 ? now : null;
  });
  check("heap overflow after 30 s: the bar restarts", s.boots > before && !s.running, `running ${s.running?.id ?? "nothing"}`);
}

// ---------------------------------------------------------------- Back and Start held together
{
  const before = (await state()).boots;
  await emu("POST", "key?key=back&action=down");
  await emu("POST", "key?key=start&action=down");
  const s = await until("the restart by buttons", async () => {
    const now = await state();
    return now.boots > before && (await api("GET", "version")).status === 200 ? now : null;
  });
  check("Back and Start held together restart the bar", s.boots > before);
}

await api("DELETE", `apps?app_id=${PROBE}`);

// ---------------------------------------------------------------- the battery runs out
{
  await restart();
  await emu("POST", "status?usb=0&battery=1");
  await sleep(500);
  const front = await frame(0);
  await save("battery-critical");
  check("battery at 1 %: a warning is on the front display", lit(front));
  await skip(32000);
  const off = await until("the power-off", async () => ((await state()).powered ? null : await state()));
  check("battery at 1 %: the bar powers off after 30 s", off.powered === false);
  check("a bar that is off answers nothing", (await api("GET", "version")).status === 503);
  await emu("POST", "status?usb=1&battery=100");
  await emu("POST", "key?key=ok&action=down");
  const on = await until("the power-on", async () => {
    const now = await state();
    return now.powered && (await api("GET", "version")).status === 200 ? now : null;
  });
  check("a button turns the bar back on", on.powered);
}

console.log(failed ? `${failed} checks failed` : "all checks passed");
if (images) console.log(`images: ${outputDir("power")}`);
await target.stop();
totals({ pass: passed, fail: failed });
process.exit(process.exitCode);
