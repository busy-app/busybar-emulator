// busy-emulator record against a stand-in for the system: the emulator's answer to POST /_emu/record and the clip it
// leaves in the data folder are stand-ins, the files go to a temporary folder. No app, no process, no network.
// test/server/record.test.mjs runs the server's side, packages/app/test/app/record.test.mjs the whole way.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CLIP_KEEP_MS, MCP_SCREENSHOT_KEEP_MS, removeOlderThan } from "../../old-files.mjs";
import { main } from "../busy-emulator.mjs";

function tempFolder(t) {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-record-")));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };

function contextIn(dataDir) {
  return {
    platform: "darwin",
    kind: "release",
    development: false,
    resourcesDir: "/Applications/BUSY Bar Emulator.app/Contents/Resources",
    appPath: "/Applications/BUSY Bar Emulator.app",
    version: "1.2.3",
    node: "24.22.2",
    dataDir,
    runStateFile: path.join(dataDir, "run", "emulator.json"),
    calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"],
    testLaunch: null,
  };
}

/** The emulator's answer to a clip: it writes the clip into the data folder's captures/, as the server does. */
function answering(dataDir, { status = 200, body = {}, format = "mp4" } = {}) {
  const calls = [];
  const recordClip = async (port, key, query, waitMs) => {
    calls.push({ port, key, query: Object.fromEntries(new URLSearchParams(query)), waitMs });
    if (status !== 200) return { status, body: JSON.stringify(body) };
    const file = path.join(dataDir, "captures", `clip-1.${format}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "the clip");
    return { status, body: JSON.stringify({ file, format, layout: "post", width: 1080, height: 1920, fps: 30, seconds: 5, frames: 150, app: { id: "app.x", name: "X" }, late_frames: 0, max_late_ms: 2, bytes: 8, encoder: "H.264 (hardware encoder)", decoded_frames: 150, encode_ms: 900, sound: false, ...body }) };
  };
  return { calls, recordClip };
}

function fakeSystem({ cwd, running = true, recordClip }) {
  return {
    cwd: () => cwd,
    readRunState: () => (running ? { state: READY } : { missing: true }),
    alive: () => running,
    probe: async () => ({ answering: true }),
    processInfo: () => ({ start: 999_500, exe: READY.exe }),
    samePath: (a, b) => a === b,
    readControl: () => ({ port: 9999, barPort: 8640, key: "k" }),
    recordClip,
    now: () => 0,
    sleep: async () => {},
  };
}

async function run(argv, ctx, sys) {
  const out = [];
  const err = [];
  const code = await main([...argv, "--json"], { ctx, sys, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, json: JSON.parse(out.join("\n")) };
}

test("record: the clip goes from the data folder to media/clip-<n>.mp4 of the current folder, with the options asked for", async (t) => {
  const root = tempFolder(t);
  const dataDir = path.join(root, "data");
  const cwd = path.join(root, "project");
  mkdirSync(path.join(cwd, "media"), { recursive: true });
  writeFileSync(path.join(cwd, "media", "clip-3.mp4"), "older");
  const emulator = answering(dataDir);
  const { code, json } = await run(["record", "--seconds", "6", "--fps", "60"], contextIn(dataDir), fakeSystem({ cwd, recordClip: emulator.recordClip }));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.file, path.join(cwd, "media", "clip-4.mp4"));
  assert.equal(readFileSync(json.file, "utf8"), "the clip");
  assert.equal(existsSync(path.join(dataDir, "captures", "clip-1.mp4")), false, "moved, not copied");
  assert.deepEqual(emulator.calls[0].query, { seconds: "6", layout: "window", format: "mp4", fps: "60" });
  assert.equal(emulator.calls[0].port, 9999);
  assert.ok(emulator.calls[0].waitMs > 6000);
});

test("record --gif and --out <name>.gif ask for a GIF of the front display; --out names the file", async (t) => {
  const root = tempFolder(t);
  const dataDir = path.join(root, "data");
  for (const argv of [["--gif"], ["--out", "loop.gif"]]) {
    const emulator = answering(dataDir, { format: "gif", body: { format: "gif", layout: "front" } });
    const { code, json } = await run(["record", ...argv], contextIn(dataDir), fakeSystem({ cwd: root, recordClip: emulator.recordClip }));
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(emulator.calls[0].query.format, "gif");
    assert.equal(emulator.calls[0].query.layout, "front");
    assert.match(json.file, /\.gif$/);
  }
});

test("record: wrong calls are refused before anything is asked", async (t) => {
  const root = tempFolder(t);
  const emulator = answering(root);
  const sys = fakeSystem({ cwd: root, recordClip: emulator.recordClip });
  for (const argv of [
    ["--seconds", "0"],
    ["--seconds", "121"],
    ["--stop", "--seconds", "5"],
    ["--fps", "61"],
    ["--layout", "square"],
    ["--layout", "window", "--scale", "4"],
    ["--scale", "8"],
    ["--gif", "--layout", "post"],
    ["--gif", "--out", "a.mp4"],
    ["--out", "a.mov"],
    ["--gif", "--seconds", "30", "--fps", "50", "--scale", "26"],
    ["--gif", "--seconds", "6", "--scale", "26"],
    ["--gif", "--seconds", "30", "--fps", "26"],
  ]) {
    const { code, json } = await run(["record", ...argv], contextIn(root), sys);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(json.code, "usage", argv.join(" "));
  }
  assert.equal(emulator.calls.length, 0);
  // A GIF too large names its limits and what to change.
  const huge = await run(["record", "--gif", "--seconds", "30", "--fps", "50", "--scale", "26"], contextIn(root), sys);
  assert.match(huge.json.message, /^A GIF of 30 s at 50 frames a second is 1500 frames, too many at scale 26: a GIF has at most 750 frames \(seconds × fps\), and frames × scale × scale at most 96000, which at scale 26 is 142 frames \(2 s at 50 frames a second\)\. Record fewer seconds, fewer frames a second or a smaller scale, or an MP4\.$/);
  // What is not too large is asked for: 30 s at the defaults, 5 s at scale 26.
  for (const argv of [["--gif", "--seconds", "30"], ["--gif", "--seconds", "5", "--scale", "26"]]) assert.notEqual((await run(["record", ...argv], contextIn(root), sys)).json.code, "usage", argv.join(" "));
});

test("record --stop: the emulator's take ends; nothing being recorded is not_recording; not running is not_running", async (t) => {
  const root = tempFolder(t);
  for (const [answer, expected] of [
    [{ status: 200, body: JSON.stringify({ stopped: true }) }, null],
    [{ status: 200, body: JSON.stringify({ stopped: false }) }, "not_recording"],
    [{ status: 404, body: JSON.stringify({ error: "Not Found" }) }, "no_app"],
  ]) {
    const calls = [];
    const sys = { ...fakeSystem({ cwd: root }), stopClip: async (port, key) => (calls.push({ port, key }), answer) };
    const { code, json } = await run(["record", "--stop"], contextIn(root), sys);
    assert.deepEqual(calls, [{ port: 9999, key: "k" }]);
    if (expected) assert.deepEqual([code, json.code], [1, expected]);
    else assert.deepEqual([code, json.stopped], [0, true]);
  }
  const off = await run(["record", "--stop"], contextIn(root), { ...fakeSystem({ cwd: root, running: false }), stopClip: async () => assert.fail("asked") });
  assert.equal(off.json.code, "not_running");
});

test("record: not_running when the emulator is not running; nothing is started or written", async (t) => {
  const root = tempFolder(t);
  const emulator = answering(root);
  const { code, json } = await run(["record"], contextIn(root), fakeSystem({ cwd: root, running: false, recordClip: emulator.recordClip }));
  assert.equal(code, 1);
  assert.equal(json.code, "not_running");
  assert.match(json.hint, /start/);
  assert.equal(emulator.calls.length, 0);
  assert.equal(existsSync(path.join(root, "media")), false);
});

test("record: the emulator's refusals become the command's codes", async (t) => {
  const root = tempFolder(t);
  for (const [status, body, expected] of [
    [409, { code: "fast", error: "The emulator runs at the computer's speed." }, "fast_mode"],
    [409, { code: "busy", error: "Another clip is being recorded." }, "record_busy"],
    [409, { code: "window_hidden", error: "The app's window cannot be recorded: the app's window did not come up." }, "window_hidden"],
    [409, { code: "window_loading", error: "The app's window cannot be recorded: its page was still loading after 45 s." }, "window_loading"],
    [409, { code: "no_frames", error: "The app's window cannot be recorded: it is on the screen but gave no frame in 10 s." }, "no_frames"],
    [501, { code: "no_app", error: "This emulator runs without its app." }, "no_app"],
    [502, { code: "encode_failed", error: "The app could not encode the clip: no H.264 encoder.", missing: "H.264 encoder" }, "encode_failed"],
    [503, { code: "off", error: "The bar is off." }, "not_running"],
    [400, { code: "usage", error: "a GIF of 30 s at 50 frames a second is 1500 frames, too many at scale 26." }, "usage"],
  ]) {
    const emulator = answering(root, { status, body });
    const { code, json } = await run(["record"], contextIn(root), fakeSystem({ cwd: root, recordClip: emulator.recordClip }));
    assert.equal(code, expected === "usage" ? 2 : 1);
    assert.equal(json.code, expected, `${status} ${body.code}`);
    if (expected === "encode_failed") assert.equal(json.missing, "H.264 encoder");
  }
});

test("record: takes at once never get the same clip-<n> name, so none writes over another's clip (audit H12)", async (t) => {
  const folder = path.join(tempFolder(t), "media");
  // Processes of their own, as two terminals or two agents are: each takes a name, and they start together.
  const url = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "commands", "record.mjs")).href;
  const at = Date.now() + 1000;
  const code = `const { claimName } = await import(${JSON.stringify(url)}); while (Date.now() < ${at}); console.log(claimName(${JSON.stringify(folder)}, "mp4"));`;
  const names = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => execFile(process.execPath, ["--input-type=module", "-e", code], (error, stdout) => resolve(error ? String(error) : stdout.trim())))));
  assert.equal(new Set(names).size, 8, names.join("\n"));
  assert.deepEqual(readdirSync(folder).sort(), names.map((one) => path.basename(one)).sort());
});

test("old clips in captures/ and an agent's old screenshots go after their time to keep; new ones and other files stay", (t) => {
  const folder = tempFolder(t);
  const old = (Date.now() - CLIP_KEEP_MS - 60_000) / 1000;
  for (const name of ["clip-1.mp4", "clip-2.gif", "clip-3.mp4", "notes.txt"]) writeFileSync(path.join(folder, name), "x");
  for (const name of ["clip-1.mp4", "clip-2.gif", "notes.txt"]) utimesSync(path.join(folder, name), old, old);
  mkdirSync(path.join(folder, "clip-9.mp4"));
  const removed = removeOlderThan(folder, CLIP_KEEP_MS, { match: (name) => /^clip-.+\.(mp4|gif)$/i.test(name) });
  assert.deepEqual(removed.sort(), ["clip-1.mp4", "clip-2.gif"]);
  assert.deepEqual(readdirSync(folder).sort(), ["clip-3.mp4", "clip-9.mp4", "notes.txt"]);
  assert.deepEqual(removeOlderThan(path.join(folder, "none"), 0), []);
  assert.ok(MCP_SCREENSHOT_KEEP_MS >= CLIP_KEEP_MS);
});
