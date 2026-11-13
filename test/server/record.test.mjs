// POST /_emu/record (packages/server/capture/record.mjs) as a server runs it, without the app: a GIF of the front
// display, which the server encodes itself; two takes of a scene the firmware animates, each from a held clock, give
// the same frames; and what is refused — a page, --fast, an MP4 with no app to encode it. The MP4 path, through the
// app's hidden window, is tested in packages/app/test/app/record.test.mjs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test as nodeTest } from "node:test";

import { startServer } from "../../packages/server/server.mjs";
import { finish, port, request, tempDir } from "./helpers.mjs";

after(finish);

const test = (name, fn) => nodeTest(name, { timeout: 90_000 }, fn);

async function start(t, options = {}) {
  const emulator = await startServer({ port: port(0), controlPort: port(0) ? port(1) : 0, dataDir: tempDir(t), ...options });
  t.after(() => emulator.stop());
  return emulator;
}

/** A request to the management address with the server's key. */
async function control(emulator, method, path, headers = {}) {
  const response = await fetch(`${emulator.control.url}${path}`, { method, headers: { ...emulator.controlHeaders(), ...headers } });
  return { status: response.status, json: await response.json() };
}

/** A scene the firmware moves by its own clock: a looping animation of its own on the front display. */
const SCENE = JSON.stringify({ application_name: "record-test", elements: [{ id: "a", type: "animation", x: 0, y: 0, stock_path: "shared/coding_72x16.anim", loop: true }] });

/**
 * One take of the scene, set up in held time (ADR-0006): the display is cleared on a running clock (a hold waits for
 * an animation that is under way), the clock is held anew, then the scene is drawn and the GIF recorded.
 */
async function take(emulator) {
  assert.equal((await control(emulator, "POST", "/_emu/time?hold=0")).status, 200);
  await request("DELETE", `${emulator.url}/api/display/draw`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await control(emulator, "POST", "/_emu/time?hold=1")).status, 200);
  const drawn = await request("POST", `${emulator.url}/api/display/draw`, Buffer.from(SCENE));
  assert.equal(drawn.status, 200, drawn.text);
  const answer = await control(emulator, "POST", "/_emu/record?format=gif&seconds=2&fps=25&scale=4");
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json;
}

test("a GIF of the front display: its file in the data folder's captures/, its size and frames as asked; two takes from a held clock are the same", async (t) => {
  const emulator = await start(t);
  const first = await take(emulator);
  assert.equal(dirname(first.file), join(emulator.dataDir, "captures"));
  assert.ok(existsSync(first.file));
  assert.deepEqual([first.format, first.layout, first.width, first.height, first.fps, first.frames], ["gif", "front", 288, 64, 25, 50]);
  assert.equal(first.held_before, true, "the clock was held by the caller and stays held");
  assert.equal(first.sound, false);
  assert.ok(first.distinct_frames > 10, `the animation moves: ${first.distinct_frames} distinct frames`);
  const bytes = readFileSync(first.file);
  assert.equal(bytes.subarray(0, 6).toString("latin1"), "GIF89a");
  assert.equal(first.bytes, bytes.length);

  const second = await take(emulator);
  assert.notEqual(second.file, first.file);
  assert.equal(second.distinct_frames, first.distinct_frames);
  assert.ok(readFileSync(second.file).equals(bytes), "the same frames, byte for byte");
  // The clock the caller held is still held after the take.
  assert.equal((await control(emulator, "GET", "/_emu/state")).json.clock.held, true);
});

test("a take on a running clock holds it for the take and lets it go after", async (t) => {
  const emulator = await start(t);
  const answer = await control(emulator, "POST", "/_emu/record?format=gif&seconds=1&fps=10");
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal(answer.json.held_before, false);
  assert.equal(answer.json.frames, 10);
  assert.equal((await control(emulator, "GET", "/_emu/state")).json.clock.held, false);
});

test("refused: a page, the computer's speed, an MP4 with no app to encode it, wrong options, the bar's address", async (t) => {
  const emulator = await start(t);
  assert.equal((await control(emulator, "POST", "/_emu/record?format=gif", { Origin: emulator.url })).status, 403);
  const noApp = await control(emulator, "POST", "/_emu/record?seconds=1");
  assert.equal(noApp.status, 501);
  assert.equal(noApp.json.code, "no_app");
  const wrong = await control(emulator, "POST", "/_emu/record?seconds=121");
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /seconds takes a whole number from 1 to 120/);
  assert.equal((await control(emulator, "GET", "/_emu/record")).status, 405);
  assert.equal((await request("POST", `${emulator.url}/_emu/record?format=gif`)).status, 404, "only the management address records");

  const fast = await startServer({ port: port(2), controlPort: port(0) ? port(3) : 0, dataDir: tempDir(t), barSpeed: false });
  t.after(() => fast.stop());
  const refused = await control(fast, "POST", "/_emu/record?format=gif");
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, "fast");
});

test("a take stopped early (POST /_emu/record/stop) is as long as the frames it has; no take, nothing to stop; only the key's program", async (t) => {
  const emulator = await start(t);
  assert.deepEqual((await control(emulator, "POST", "/_emu/record/stop")).json, { stopped: false }, "nothing is being recorded");
  const asked = control(emulator, "POST", "/_emu/record?format=gif&seconds=60&fps=10&scale=4");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await control(emulator, "POST", "/_emu/record/stop", { Origin: emulator.url })).status, 403, "a page may not stop it");
  assert.equal((await control(emulator, "GET", "/_emu/record/stop")).status, 405);
  assert.deepEqual((await control(emulator, "POST", "/_emu/record/stop")).json, { stopped: true });
  const answer = await asked;
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.equal(answer.json.stopped, true);
  assert.ok(answer.json.frames >= 3 && answer.json.frames < 600, `${answer.json.frames} frames`);
  assert.equal(answer.json.seconds, answer.json.frames / 10);
  assert.ok(existsSync(answer.json.file));
  assert.deepEqual((await control(emulator, "POST", "/_emu/record/stop")).json, { stopped: false }, "the take is over");
  assert.equal((await request("POST", `${emulator.url}/_emu/record/stop`)).status, 404, "only the management address");
});

test("a GIF too large to post is refused at once, naming the limits; nothing is recorded", async (t) => {
  const emulator = await start(t);
  const started = Date.now();
  const refused = await control(emulator, "POST", "/_emu/record?format=gif&seconds=30&fps=50&scale=26");
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "usage");
  assert.match(refused.json.error, /1500 frames, too many at scale 26: a GIF has at most 750 frames \(seconds × fps\), and frames × scale × scale at most 96000, which at scale 26 is 142 frames/);
  assert.equal(existsSync(join(emulator.dataDir, "captures")), false);
});

test("the bar answers while a GIF of a moving screen at scale 26 is taken and encoded", async (t) => {
  // The server runs in this process, as does the client that asks it: a server's thread blocked by an encode blocks
  // the asking too. The encode the GIF had before (every step drawn in RGB and encoded on the server's thread) held it
  // here for 5 s. What is measured is the thread's own work between two answers (its processor time): a block by an
  // encode is that. The time by the clock between two answers is not measured: on a loaded computer it holds the time
  // the thread waited for a core too (EMU-294: 543 ms by the clock between two answers in a gate's server suite at load
  // 7, with the encode on its own thread).
  const work = () => {
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
  };
  const emulator = await start(t);
  const drawn = await request("POST", `${emulator.url}/api/display/draw`, Buffer.from(SCENE));
  assert.equal(drawn.status, 200, drawn.text);
  let done = false;
  const answered = [];
  const asking = (async () => {
    while (!done) {
      const answer = await request("GET", `${emulator.url}/api/status`);
      assert.equal(answer.status, 200);
      answered.push({ at: performance.now(), work: work() });
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  const answer = await control(emulator, "POST", "/_emu/record?format=gif&seconds=5&fps=25&scale=26");
  // The record's own answer closes the last gap: a blocked thread answers it first, when the block ends.
  answered.push({ at: performance.now(), work: work() });
  done = true;
  await asking;
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  assert.deepEqual([answer.json.width, answer.json.height, answer.json.frames], [1872, 416, 125]);
  assert.ok(answer.json.distinct_frames > 10, `the animation moves: ${answer.json.distinct_frames} distinct frames`);
  assert.ok(answered.length > 50, `${answered.length} answers`);
  const gaps = answered.slice(1).map((a, i) => ({ work: a.work - answered[i].work, clock: a.at - answered[i].at }));
  const busiest = gaps.reduce((a, b) => (b.work > a.work ? b : a));
  const longest = Math.max(...gaps.map((g) => g.clock));
  assert.ok(busiest.work < 200, `${Math.round(busiest.work)} ms of the server's thread's work between two answers of /api/status, in ${Math.round(busiest.clock)} ms by the clock (the longest gap by the clock ${Math.round(longest)} ms; the GIF's encoding took ${answer.json.encode_ms} ms)`);
});
