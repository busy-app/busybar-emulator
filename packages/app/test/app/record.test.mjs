// busy-emulator record, the whole way: the command line asks the server's management address, the server records a
// take of the bar and asks the shell over the supervisor's channel to encode it, the shell's hidden page encodes
// H.264 with WebCodecs and decodes it back, the shell writes the MP4, the command line moves it where it was asked
// to go. The file is read here box by box (src/capture-mp4.mjs readMp4). The app on the bar is the smoke test's app
// (emulator/test/smoke/app.busy.smoke), which draws from its own JS.
//
// A machine whose Chromium has no H.264 encoder at all (neither the system's nor the software one) gets encode_failed
// with `missing`; the tests that need one are skipped there with that reason.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { readMp4 } from "../../src/capture-mp4.mjs";
import { APP_DIR, HAS_REAL_SERVER, NODE, PORTS, removeFolder, sleep, targz, temporaryFolder } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const CLI = path.join(APP_DIR, "..", "server", "cli", "busy-emulator.mjs");
const SMOKE = path.join(APP_DIR, "..", "..", "test", "smoke", "app.busy.smoke");
const skip = !HAS_REAL_SERVER && "the server is not beside this package";

let app;
let work;
afterEach(async () => {
  await app?.close();
  app = null;
  if (work) await removeFolder(work);
  work = null;
});

/** The command line of this tree, as an agent runs it: no terminal, the app's data folder and port. */
function cli(args, cwd) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BUSY_EMULATOR_/i.test(name)));
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args, "--json"], { cwd, env: { ...clean, BUSY_EMULATOR_DATA: app.folder, BUSY_EMULATOR_PORT: String(app.port) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, json: JSON.parse(stdout.trim().split("\n").pop()) });
      } catch {
        reject(new Error(`busy-emulator ${args.join(" ")} printed no JSON (exit code ${code}):\n${stdout}`));
      }
    });
  });
}

/** The app with the smoke app running on its bar. */
async function appWithSmoke() {
  app = await launch({ server: "real" });
  await app.waitState("ready");
  const api = `http://127.0.0.1:${PORTS.app}/api/`;
  const files = {};
  for (const name of ["appmeta/manifest.json", "scripts/main.js"]) files[`app.busy.smoke/${name}`] = readFileSync(path.join(SMOKE, name), "utf8");
  const { install_key: key } = await (await fetch(`${api}apps/stage`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: targz(files) })).json();
  assert.equal((await fetch(`${api}apps/install?install_key=${key}`, { method: "POST" })).status, 200);
  assert.equal((await fetch(`${api}apps/launch?app_id=app.busy.smoke`, { method: "POST" })).status, 200);
  await sleep(1500);
  work = temporaryFolder();
  // The real path: on macOS the temporary folder is behind a symbolic link (/var → /private/var).
  return realpathSync(work);
}

/** Skips the test where this machine has no H.264 encoder, which the answer names. */
function encoderOr(t, result) {
  if (result.json.code === "encode_failed" && result.json.missing) {
    t.skip(`no ${result.json.missing} on this machine: ${result.json.message}`);
    return false;
  }
  return true;
}

const windows = () => app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length);

test("record: a vertical clip for a post, 1080×1920, 2 s at 30 a second: 60 frames of H.264 that decode, in media/ of the current folder", { skip, timeout: 180_000 }, async (t) => {
  const cwd = await appWithSmoke();
  const before = await windows();
  const result = await cli(["record", "--seconds", "2", "--layout", "post"], cwd);
  if (!encoderOr(t, result)) return;
  assert.equal(result.code, 0, JSON.stringify(result.json));
  const answer = result.json;
  assert.equal(answer.file, path.join(cwd, "media", "clip-1.mp4"));
  assert.deepEqual([answer.width, answer.height, answer.fps, answer.frames, answer.decoded_frames], [1080, 1920, 30, 60, 60]);
  assert.deepEqual(answer.app, { id: "app.busy.smoke", name: "Smoke" });
  assert.equal(answer.sound, false);
  assert.match(answer.encoder, /^H\.264 \((hardware|software) encoder\)$/);

  const mp4 = readMp4(readFileSync(answer.file));
  assert.equal(answer.bytes, readFileSync(answer.file).length);
  assert.deepEqual(mp4.order, ["ftyp", "moov", "mdat"]);
  assert.equal(mp4.codec, "avc1");
  assert.deepEqual([mp4.width, mp4.height, mp4.frames, mp4.fps, mp4.duration], [1080, 1920, 60, 30, 2]);
  assert.deepEqual(mp4.keys, [1, 31], "a key frame every second");
  assert.ok([66, 77, 100].includes(mp4.profile), `profile ${mp4.profile}`);
  assert.ok(mp4.dataInPlace);
  assert.deepEqual([mp4.tracks, mp4.audio.codec, mp4.audio.sampleRate, mp4.audio.channels], [["vide", "soun"], "mp4a", 48000, 2], "a silent AAC track");
  assert.ok(mp4.audio.duration >= mp4.duration && mp4.audio.duration - mp4.duration < 0.03);

  // Nothing is left: the encoding page's window is gone, and so is the file in the data folder.
  assert.equal(await windows(), before);
  assert.deepEqual(readdirSync(path.join(app.folder, "captures")), []);

  // The next one takes the next number.
  const again = await cli(["record", "--seconds", "1", "--layout", "both"], cwd);
  assert.equal(again.code, 0, JSON.stringify(again.json));
  assert.equal(again.json.file, path.join(cwd, "media", "clip-2.mp4"));
  assert.deepEqual([again.json.width, again.json.height], [1920, 1080]);
  assert.deepEqual([readMp4(readFileSync(again.json.file)).width, readMp4(readFileSync(again.json.file)).frames], [1920, 30]);
});

test("record: the front display alone at a scale, at 25 a second; and a GIF of it, with no window", { skip, timeout: 180_000 }, async (t) => {
  const cwd = await appWithSmoke();
  const out = path.join(cwd, "clips", "front.mp4");
  const result = await cli(["record", "--seconds", "1", "--fps", "25", "--layout", "front", "--scale", "10", "--out", out], cwd);
  if (!encoderOr(t, result)) return;
  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.file, out);
  const mp4 = readMp4(readFileSync(out));
  assert.deepEqual([mp4.width, mp4.height, mp4.frames, mp4.fps], [720, 160, 25, 25]);
  assert.equal(result.json.decoded_frames, 25);

  const gif = await cli(["record", "--seconds", "1", "--out", path.join(cwd, "front.gif")], cwd);
  assert.equal(gif.code, 0, JSON.stringify(gif.json));
  assert.deepEqual([gif.json.format, gif.json.width, gif.json.height, gif.json.frames], ["gif", 576, 128, 25]);
  assert.equal(readFileSync(path.join(cwd, "front.gif")).subarray(0, 6).toString("latin1"), "GIF89a");
  assert.ok(!existsSync(path.join(cwd, "media")));
});

test("record: by default the main window as it is on the screen, at its size in device pixels made to fit 1920×1080, video range; a closed window is opened again first", { skip, timeout: 180_000 }, async (t) => {
  const cwd = await appWithSmoke();
  const expected = await app.run((shell, electron) => {
    const win = shell.windows.current.win;
    const { width, height } = win.getContentBounds();
    const scale = electron.screen.getDisplayMatching(win.getBounds()).scaleFactor;
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }).then(({ width, height }) => {
    // Made smaller to fit 1920×1080 (1080×1920 upright), to even numbers, as the encoding page does.
    const [boxW, boxH] = width >= height ? [1920, 1080] : [1080, 1920];
    const fit = Math.min(1, boxW / width, boxH / height);
    return { width: Math.max(2, Math.round(width * fit) & ~1), height: Math.max(2, Math.round(height * fit) & ~1) };
  });
  const result = await cli(["record", "--seconds", "1"], cwd);
  if (!encoderOr(t, result)) return;
  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.layout, "window");
  assert.deepEqual([result.json.width, result.json.height], [expected.width, expected.height]);
  assert.equal(result.json.cursor, false);
  const mp4 = readMp4(readFileSync(result.json.file));
  assert.deepEqual([mp4.width, mp4.height, mp4.frames, mp4.fps], [expected.width, expected.height, 30, 30]);
  assert.equal(result.json.decoded_frames, 30);
  assert.ok(mp4.level <= 42, `level ${mp4.level}: 4.x, as the networks take`);
  assert.equal(mp4.fullRange, false, "video range (yuv420p), not full range (yuvj420p)");

  // The person closed the window: the recording opens it again rather than recording nothing. Only macOS keeps the
  // app running without its window; elsewhere closing it quits the app (lifecycle.test.mjs).
  if (process.platform !== "darwin") return t.diagnostic("a closed window: macOS only, elsewhere closing the window quits the app");
  await app.run((shell) => shell.windows.current.win.close());
  await sleep(500);
  assert.equal(await app.run((shell) => shell.windows.current === null), true);
  const again = await cli(["record", "--seconds", "1", "--fps", "10"], cwd);
  assert.equal(again.code, 0, JSON.stringify(again.json));
  assert.deepEqual([again.json.width, again.json.height, again.json.frames], [expected.width, expected.height, 10]);
  assert.equal(await app.run((shell) => shell.windows.current?.kind), "device");
});
