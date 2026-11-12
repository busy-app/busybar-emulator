// The emulator against a BUSY Bar's recorded answers to requests that change its state (EMU-232). A server is
// started in this process on firmware 1.3.1, the recorded requests are sent to it in their order, and each answer —
// status, body and, where the recording has them, both displays' frames — must be the bar's. No bar is needed.
//
//   node --test emulator/test/state.test.mjs       [EMU_TEST_PORTS=8801-8809] the ports to use; free ones by default
//                                                  [EMU_STATE_FRAMES=<folder>] PNGs of frames that differ go there
//
// The recordings (state/; each file says where, when and how it was made; state/make.mjs made them from the raw
// recordings, which stay outside the repository):
//   bar-state-1.3.1.json       2026-11-10, a bar with a self-built U5 on 1.3.1: an app installed, launched, its
//                              settings read, written and refused, input, quit; brightness, volume, name, time zone
//   bar-state-1.3.1-more.json  2026-11-11 night, a stock bar on 1.3.1: drawing from outside (display/draw, DELETE)
//                              and the BUSY timer (busy/snapshot, busy/profiles), the timer started, paused, stopped
//
// What is not compared, and why:
//   - values that are the time or chance of the moment: install_key, snapshot_timestamp_ms, profile_timestamp_ms;
//     GET /api/time only by its zone offset;
//   - in the 10.11 recording the white space at either end of an answer (the recording script trimmed it), so this
//     test cannot see the final line feed of an answer there, nor a 405's Allow header: the 405s, their bodies and
//     Allow are checked by packages/server/device-api.test.mjs;
//   - the 12 columns of the back display's status bar (x 148–159) in the night's frames: the bar ran on its battery's
//     57–76 %, the emulator shows 100 %;
//   - parts of frames that move by themselves (an animation's phase depends on when the frame was taken), as each
//     frame's `mask` in the recording names them; and the APPS splash before and after the timer, whose shine moves;
//   - GET display/brightness right after a POST: the bar applies a new brightness about 20 ms after answering (its
//     brightness service saves the setting first), so the GET the recording made at once sometimes saw the value
//     before. The emulator applies it at once; either answer is accepted there (entries with `alsoAccepted`).
//
// The BUSY timer is replayed on a held clock: the emulated bar's clock is set to the time of the recording and moved
// on by hand, so that each request reaches it at the moment it reached the bar (its body's snapshot_timestamp_ms).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { encodeScreenPng } from "../packages/server/capture/png.mjs";
import { startServer } from "../packages/server/server.mjs";
import { targz } from "./package.mjs";
import { finish, port, tempDir } from "./server/helpers.mjs";

after(finish);

const here = dirname(fileURLToPath(import.meta.url));
const recording = (name) => JSON.parse(readFileSync(join(here, "state", name), "utf8"));
const framesOut = process.env.EMU_STATE_FRAMES;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The probe app of the recording, packed as the recording script packed it.
function probeArchive() {
  const dir = join(here, "state", "app.probe.cmp");
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[`app.probe.cmp/${relative(dir, p).split("\\").join("/")}`] = readFileSync(p);
    }
  };
  walk(dir);
  return targz(files);
}

const VOLATILE = /"(install_key|snapshot_timestamp_ms|profile_timestamp_ms)":(\s*)-?\d+/g;
const settled = (text) => text.replace(VOLATILE, '"$1":$2<n>');

/** null if the emulator's answer is the bar's, else what differs. */
function differs(entry, got, exact) {
  const told = (want) => `bar ${want.status} ${JSON.stringify(want.response)}, emulator ${got.status} ${JSON.stringify(got.text)}`;
  const alike = (want) => {
    if (want.status !== got.status) return false;
    if (entry.compare === "offset") return JSON.parse(want.response).timestamp.slice(-6) === JSON.parse(got.text).timestamp.slice(-6);
    return exact ? settled(want.response) === settled(got.text) : settled(want.response.trim()) === settled(got.text.trim());
  };
  if (alike(entry) || (entry.alsoAccepted && alike(entry.alsoAccepted))) {
    if (entry.contentType && got.contentType !== entry.contentType) return `Content-Type: bar ${entry.contentType}, emulator ${got.contentType}`;
    return null;
  }
  return told(entry);
}

// Frames: the front display 72×16 BGR, the back 160×80 at 4 bits a pixel, two pixels a byte (low nibble first).
const SIZE = { front: [72, 16], back: [160, 80] };
const STATUS_BAR_X = 148;
const pixel = (name, frame, x, y) => {
  const i = y * SIZE[name][0] + x;
  return name === "front" ? frame.readUIntLE(i * 3, 3) : (frame[i >> 1] >> ((i & 1) * 4)) & 0xf;
};
/** Pixels that differ, outside the status bar and the masked rectangles [x0, y0, x1, y1) of the display. */
function pixelsApart(name, bar, emu, masks = []) {
  const [w, h] = SIZE[name];
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (name === "back" && x >= STATUS_BAR_X) continue;
      if (masks.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) continue;
      if (pixel(name, bar, x, y) !== pixel(name, emu, x, y)) n++;
    }
  }
  return n;
}
const hash = (frame) => createHash("sha1").update(frame).digest("hex").slice(0, 10);

/** The replay of one recording on a server of its own. Returns the list of differences. */
async function replay(t, file, portIndex) {
  const rec = recording(file);
  const emulator = await startServer({ port: port(portIndex), dataDir: tempDir(t), firmware: "1.3.1", barSpeed: false });
  t.after(() => emulator.stop());
  // No wait after the server is ready: a drawing from outside right away reaches both displays (EMU-253).
  const base = emulator.url;
  const call = async (method, path, body = null) => {
    const r = await fetch(`${base}/api/${path}`, { method, body, signal: AbortSignal.timeout(15000) });
    return { status: r.status, contentType: r.headers.get("content-type"), text: await r.text() };
  };
  const frame = async (name) => Buffer.from((await call("GET", `screen?display=${name === "front" ? 0 : 1}`)).text, "base64");
  const clock = async (query) => (await (await fetch(`${base}/_emu/time?${query}`, { method: "POST" })).json()).now;
  const start = async () => {
    const s = rec.start;
    await call("POST", `display/brightness?value=${s.brightness}`);
    await call("POST", `audio/volume?volume=${s.volume}&silent=1`);
    await call("POST", "name", JSON.stringify({ name: s.name }));
    if (s.timezone) await call("POST", `time/timezone?timezone=${encodeURIComponent(s.timezone)}`);
  };

  const problems = [];
  const responses = [];
  const seen = new Set(); // timestamps the bar's answers had: a body that sends one again sends an old one
  let group = null;
  let staged = null;
  let held = null; // the bar's clock (Unix ms) while the clock is held for the timer
  const moveOn = async (ms) => {
    if (ms <= 0) return;
    if (held === null) return sleep(ms);
    await clock(`advance=${ms}`);
    held += ms;
  };
  for (const [i, entry] of rec.requests.entries()) {
    if (entry.group !== group) {
      group = entry.group;
      await start();
      if (group === "busy") {
        // The bar's clock held at a whole second before the first request of the timer, as the API sets it.
        const first = rec.requests.find((r) => r.group === "busy" && /"snapshot_timestamp_ms":\d+/.test(r.body ?? ""));
        held = Math.floor(Number(first.body.match(/"snapshot_timestamp_ms":(\d+)/)[1]) / 1000) * 1000 - 1000;
        await clock("hold=1");
        const set = await call("POST", `time/timestamp?timestamp=${new Date(held).toISOString().slice(0, 19)}Z`);
        assert.equal(set.status, 200, `setting the bar's clock: ${set.text}`);
      }
    }
    for (const first of entry.emulatorFirst ?? []) await call(first.method, first.path, responses[first.fromResponseOf]);
    await moveOn(entry.before ?? 0);
    let body = entry.body ?? null;
    if (entry.archive) body = probeArchive();
    // A request that carries the time it was sent at reaches the emulated bar at that time.
    for (const [, stamp] of (body && typeof body === "string" ? body.matchAll(/"(?:snapshot|profile)_timestamp_ms":(\d+)/g) : [])) {
      if (held !== null && !seen.has(stamp)) await moveOn(Number(stamp) - held);
    }
    const path = entry.path.replace("<staged>", String(staged));
    const got = await call(entry.method, path, entry.method === "GET" ? null : body);
    responses[i] = entry.response;
    for (const [, stamp] of entry.response.matchAll(/_timestamp_ms":(\d+)/g)) seen.add(stamp);
    if (entry.path === "apps/stage") staged = JSON.parse(got.text).install_key;
    const what = `#${i} ${entry.method} /api/${path}${entry.note ? ` (${entry.note})` : ""}`;
    const answer = differs(entry, got, rec.exact);
    if (answer) problems.push(`${what}: ${answer}`);

    if (entry.frameHashes) {
      // The frames of the 10.11 recording are kept as hashes: the app draws when its runtime gets to it.
      const end = Date.now() + entry.wait + 3000;
      let f;
      do {
        await sleep(50);
        f = { front: hash(await frame("front")), back: hash(await frame("back")) };
      } while ((f.front !== entry.frameHashes.front || f.back !== entry.frameHashes.back) && Date.now() < end);
      if (f.front !== entry.frameHashes.front || f.back !== entry.frameHashes.back) {
        problems.push(`${what}: frames front ${entry.frameHashes.front} / emulator ${f.front}, back ${entry.frameHashes.back} / emulator ${f.back}`);
      }
    } else if (entry.frames) {
      // On the held clock the frame is the one of that moment. On the running clock (drawing from outside) the GUI
      // shows a drawing on one of its next ticks, later on a busy computer: the frames are read until they are the
      // bar's, for as long as the recording waited and 3 s more.
      const compared = ["front", "back"].filter((name) => entry.mask?.[name] !== "all");
      const read = async () => Object.fromEntries(await Promise.all(compared.map(async (name) => [name, await frame(name)])));
      const apart = (emu) => Object.fromEntries(compared.map((name) => [name, pixelsApart(name, Buffer.from(entry.frames[name], "base64"), emu[name], entry.mask?.[name])]));
      let emu, n;
      if (held !== null) {
        await moveOn(entry.wait ?? 0);
        emu = await read();
        n = apart(emu);
      } else {
        const end = Date.now() + (entry.wait ?? 0) + 3000;
        do {
          await sleep(50);
          emu = await read();
          n = apart(emu);
        } while (Object.values(n).some(Boolean) && Date.now() < end);
      }
      for (const name of compared) {
        const bar = Buffer.from(entry.frames[name], "base64");
        if (n[name]) {
          problems.push(`${what}: ${n[name]} pixels of the ${name} display differ`);
          if (framesOut) {
            mkdirSync(framesOut, { recursive: true });
            const stem = join(framesOut, `${file.replace(/\.json$/, "")}-${String(i).padStart(3, "0")}-${name}`);
            writeFileSync(`${stem}-bar.png`, encodeScreenPng(name, bar));
            writeFileSync(`${stem}-emu.png`, encodeScreenPng(name, emu[name]));
          }
        }
      }
    } else if (entry.wait) await moveOn(entry.wait);
  }
  if (held !== null) await clock("hold=0");
  return { problems, count: rec.requests.length };
}

test("the 10.11 recording: an app's install, launch, settings and input; brightness, volume, name, time zone", async (t) => {
  const { problems, count } = await replay(t, "bar-state-1.3.1.json", 0);
  assert.deepEqual(problems, [], `${problems.length} of ${count} answers are not the bar's`);
});

test("the night's recording: drawing from outside, the BUSY timer and its profiles", async (t) => {
  const { problems, count } = await replay(t, "bar-state-1.3.1-more.json", 1);
  assert.deepEqual(problems, [], `${problems.length} of ${count} answers are not the bar's`);
});
