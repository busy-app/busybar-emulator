// busy-emulator screenshot against a stand-in for the system: the frame comes from a stand-in of GET /api/screen, the
// files go to a temporary folder. No app, no process, no network. test/server/screenshot.test.mjs runs the command
// line itself against a real server.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadCommands, main, parseArguments } from "../busy-emulator.mjs";
import screenshot, { MAX_SCALE as COMMAND_MAX_SCALE } from "../commands/screenshot.mjs";
import { loadCatalogCheck } from "../system.mjs";
import { MAX_SCALE, SCREENS } from "../../capture/png.mjs";
import { decodePng, framePixel, pngPixel } from "../../capture/test-support.mjs";

const CLI_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// A release on macOS as the command line sees itself; the files it writes are this system's whatever it says.
const ctx = {
  platform: "darwin",
  kind: "release",
  development: false,
  resourcesDir: "/Applications/BUSY Bar Emulator.app/Contents/Resources",
  appPath: "/Applications/BUSY Bar Emulator.app",
  version: "1.2.3",
  node: "24.22.2",
  dataDir: "/nowhere/BUSY Bar Emulator",
  runStateFile: "/nowhere/BUSY Bar Emulator/run/emulator.json",
  calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"],
  testLaunch: null,
};
const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };

// Every LED and pixel its own value, so a pixel in the wrong place shows.
const FRONT = Uint8Array.from({ length: SCREENS.front.frameBytes }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
const BACK = Uint8Array.from({ length: SCREENS.back.frameBytes }, (_, i) => (i * 13 + 5) & 0xff);
const answer = (frame) => ({ status: 200, body: `${Buffer.from(frame).toString("base64")}\n` });

/** A check that says pass, with or without a note, or what it is given. */
const stubCheck = (verdict = { verdict: "pass" }) => async () => ({ check: () => verdict, rules: { front: { id: "screenshot_png" }, back: { id: "back_screenshot_png" } } });

function tempFolder(t) {
  // The real path: on macOS the temporary folder is behind a symbolic link (/var → /private/var).
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-screenshot-")));
  // Folders a test made read-only are made writable again first, or they could not be removed.
  const unlock = (dir) => {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) unlock(path.join(dir, entry.name));
  };
  // On exFAT macOS lists a name decomposed (NFD) but finds the file only by the form it was made with, so a removal by
  // the listed names leaves files behind: each is removed by either form.
  const remove = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) remove(at);
      else for (const name of new Set([entry.name, entry.name.normalize("NFC")])) rmSync(path.join(dir, name), { force: true });
    }
    rmSync(dir, { recursive: true, force: true });
  };
  t.after(() => {
    if (process.platform !== "win32") unlock(folder);
    remove(folder);
  });
  return folder;
}

/** A stand-in of the system with a running, ready emulator whose bar shows FRONT and BACK. */
function fakeSystem(t, { cwd = tempFolder(t), states = [READY], screen = (display) => answer(display === 0 ? FRONT : BACK), catalog = stubCheck() } = {}) {
  const calls = [];
  let launched = 0;
  let clock = 0;
  const current = () => states[Math.min(launched, states.length - 1)];
  return {
    calls,
    cwd: () => cwd,
    readRunState: () => (current() === null ? { missing: true } : { state: current() }),
    alive: () => current() !== null,
    probe: async (port) => (calls.push(["probe", port]), { answering: true }),
    processInfo: () => ({ start: 999_500, exe: READY.exe }),
    samePath: (a, b) => a === b,
    async launchApp() {
      calls.push(["launch"]);
      launched += 1;
    },
    screen: async (port, display) => (calls.push(["screen", port, display]), screen(display)),
    loadCatalogCheck: catalog,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
}

async function run(argv, sys) {
  const out = [];
  const err = [];
  const code = await main(argv, { ctx, sys, out: (line) => out.push(line), err: (line) => err.push(line) });
  const json = argv.includes("--json") && out.length ? JSON.parse(out.join("\n")) : null;
  return { code, out: out.join("\n"), err: err.join("\n"), json };
}

function assertPixels(file, name, frame, scale = 1) {
  const image = decodePng(readFileSync(file));
  assert.equal(image.width, SCREENS[name].width * scale);
  assert.equal(image.height, SCREENS[name].height * scale);
  assert.deepEqual(image.chunks, ["IHDR", "IDAT", "IEND"], "nothing in the file but the image");
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const want = framePixel(name, frame, Math.floor(x / scale), Math.floor(y / scale));
      const got = pngPixel(image, x, y);
      if (got.join() !== want.join()) assert.fail(`${file}: pixel (${x}, ${y}) is ${got}, the frame has ${want}`);
    }
  }
}

// Names as NFC: macOS gives the names of an exFAT volume back decomposed.
const listing = (folder) => readdirSync(folder).map((name) => name.normalize("NFC")).sort();

/**
 * Whether a folder made with `mode` here really refuses what the mode forbids: not on Windows (ACLs), and not on a
 * volume without permissions (exFAT, FAT), where every folder can be written and listed.
 */
function permissionsHold(t, mode) {
  if (process.platform === "win32") return false;
  const probe = path.join(tempFolder(t), "probe");
  mkdirSync(probe);
  chmodSync(probe, mode);
  try {
    if (!(mode & 0o200)) writeFileSync(path.join(probe, "x"), "");
    if (!(mode & 0o400)) readdirSync(probe);
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(probe, 0o700);
  }
}

// ---------------------------------------------------------------- options

test("options: a flag, a value after a space or after =, each once; a value that starts with - must use =", () => {
  const optionsOf = (name) => (name === "screenshot" ? screenshot.options : null);
  const parse = (argv) => parseArguments(argv, optionsOf);
  assert.deepEqual(parse(["screenshot", "--back", "--out", "a b.png", "--scale=8", "--json"]).options, { back: true, out: "a b.png", scale: "8" });
  assert.deepEqual(parse(["screenshot", "--out=--odd.png"]).options, { out: "--odd.png" });
  assert.deepEqual(parse(["screenshot", "--out", "-"]).options, { out: "-" }, "a lone - is a value");
  assert.deepEqual(parse(["screenshot", "--out", "--json"]).optionProblems, ['--out needs a value: --out <path>, or --out=<path> for one that starts with "-"']);
  assert.equal(parse(["screenshot", "--out", "--json"]).json, true, "--json is not taken as the value");
  assert.deepEqual(parse(["screenshot", "--scale"]).optionProblems, ['--scale needs a value: --scale <n>, or --scale=<n> for one that starts with "-"']);
  assert.deepEqual(parse(["screenshot", "--back", "--back"]).optionProblems, ["--back is given more than once"]);
  assert.deepEqual(parse(["screenshot", "--back=yes"]).optionProblems, ["--back takes no value"]);
  assert.deepEqual(parse(["screenshot", "--front"]).unknownOptions, ["--front"]);
  // Options belong to the command: before it, or on a command without them, they are unknown.
  assert.deepEqual(parse(["--back", "screenshot"]).unknownOptions, ["--back"]);
  assert.deepEqual(parse(["status", "--back"]).unknownOptions, ["--back"]);
});

test("a wrong call is told before anything is started, asked or written", async (t) => {
  for (const argv of [
    ["screenshot", "--scale", "1"],
    ["screenshot", "--scale", "33"],
    ["screenshot", "--scale", "2.5"],
    ["screenshot", "--scale", "eight"],
    ["screenshot", "--scale=-4"],
    ["screenshot", "--out", "shot.jpg"],
    ["screenshot", "--out="],
    ["screenshot", "--out"],
    ["screenshot", "--back", "--back"],
    ["screenshot", "extra"],
  ]) {
    const sys = fakeSystem(t);
    const { code, json } = await run([...argv, "--json"], sys);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(json.code, "usage", argv.join(" "));
    assert.match(json.hint, /busy-emulator screenshot \[--back\] \[--out <path>\] \[--scale <n>\]$/, argv.join(" "));
    assert.deepEqual(sys.calls, [], `${argv.join(" ")}: nothing asked`);
    assert.deepEqual(listing(sys.cwd()), [], `${argv.join(" ")}: nothing written`);
  }
  const folderless = await run(["screenshot", "--out", "shots", "--json"], fakeSystem(t));
  assert.match(folderless.json.message, /shots, which is neither a folder nor a \.png file; for a new folder end the path with \/\.$/);
  const human = await run(["screenshot", "--scale", "64"], fakeSystem(t));
  assert.equal(human.err, `busy-emulator: --scale takes a whole number from 2 to 32, not "64".\nUsage: /Users/you/.busy-emulator/bin/busy-emulator screenshot [--back] [--out <path>] [--scale <n>]`);
});

test("Windows: a path whose closing quote PowerShell 5.1 kept is refused with what happened, in JSON if --json was swallowed", { skip: path.sep !== "\\" && "a \" is a letter of a path elsewhere" }, async (t) => {
  // PowerShell 5.1 hands `--out "C:\my dir\" --json` over as one argument.
  for (const [argv, asJson] of [[["screenshot", "--out", 'C:\\my dir" --json'], true], [["screenshot", "--out", 'C:\\my dir" --scale 4'], false], [["screenshot", "--out", 'C:\\my dir"'], false]]) {
    const sys = fakeSystem(t);
    const out = [];
    const err = [];
    const code = await main(argv, { ctx, sys, out: (l) => out.push(l), err: (l) => err.push(l) });
    assert.equal(code, 2, argv.join(" "));
    const text = (asJson ? out : err).join("\n");
    assert.doesNotMatch(text, /end the path with \\ or \//, text);
    assert.match(text, /holds a \\?", which a Windows path cannot have/, text);
    assert.match(text, /End a folder with \/ instead/, text);
    if (asJson) assert.deepEqual([JSON.parse(text).code, JSON.parse(text).swallowed], ["usage", ["--json"]]);
    else assert.equal(out.length, 0, "text, as the caller asked");
    assert.deepEqual(sys.calls, [], "nothing asked");
  }
});

test("elsewhere a \" is a letter of a file name like any other", { skip: path.sep === "\\" && "Windows" }, async (t) => {
  const sys = fakeSystem(t);
  const { code, json } = await run(["screenshot", "--out", 'say "cheese".png', "--json"], sys);
  assert.equal(code, 0);
  assert.equal(json.file, path.join(sys.cwd(), 'say "cheese".png'));
});

test("the command's largest enlargement is the encoder's", () => {
  assert.equal(COMMAND_MAX_SCALE, MAX_SCALE);
});

// ---------------------------------------------------------------- where the files go

test("without --out: screenshots/front-1.png in the current folder, then the next number; --back gives back-<n>", async (t) => {
  const sys = fakeSystem(t);
  const folder = path.join(sys.cwd(), "screenshots");
  const first = await run(["screenshot", "--json"], sys);
  assert.equal(first.code, 0, first.out);
  const file = path.join(folder, "front-1.png");
  assert.deepEqual(first.json, {
    ok: true,
    command: "screenshot",
    display: "front",
    width: 72,
    height: 16,
    file,
    replaced: false,
    bytes: readFileSync(file).length,
    sha256: first.json.sha256,
    scaled: null,
    catalog: { verdict: "pass", id: "screenshot_png", note: null, message: null },
  });
  assert.match(first.json.sha256, /^[0-9a-f]{64}$/);
  assertPixels(file, "front", FRONT);
  assert.deepEqual(sys.calls.filter(([what]) => what === "screen"), [["screen", 8640, 0]], "the port the running emulator's mirror names");

  assert.equal((await run(["screenshot", "--json"], sys)).json.file, path.join(folder, "front-2.png"));
  const back = await run(["screenshot", "--back", "--json"], sys);
  assert.equal(back.json.file, path.join(folder, "back-1.png"));
  assert.equal(back.json.catalog.id, "back_screenshot_png");
  assert.deepEqual([back.json.width, back.json.height], [160, 80]);
  assertPixels(back.json.file, "back", BACK);
  assert.deepEqual(listing(folder), ["back-1.png", "front-1.png", "front-2.png"]);
  assert.deepEqual(listing(sys.cwd()), ["screenshots"], "nothing beside the folder it made");
  // The same frame gives the same file.
  assert.ok(readFileSync(path.join(folder, "front-1.png")).equals(readFileSync(path.join(folder, "front-2.png"))));
});

test("in a folder the number goes past every name taken, an enlarged copy's too, and nothing is replaced", async (t) => {
  const sys = fakeSystem(t);
  const folder = path.join(sys.cwd(), "screenshots");
  mkdirSync(folder);
  writeFileSync(path.join(folder, "front-3.png"), "mine");
  writeFileSync(path.join(folder, "front-7@4x.png"), "mine too");
  writeFileSync(path.join(folder, "front-x.png"), "not a number");
  writeFileSync(path.join(folder, "back-12.png"), "another display");
  const { json } = await run(["screenshot", "--json"], sys);
  assert.equal(json.file, path.join(folder, "front-8.png"));
  assert.equal(readFileSync(path.join(folder, "front-3.png"), "utf8"), "mine");
  assert.equal(readFileSync(path.join(folder, "front-7@4x.png"), "utf8"), "mine too");
});

test("in a folder it may write in but not list, it finds the free name and replaces nothing", async (t) => {
  if (!permissionsHold(t, 0o300)) return t.skip("no folder here can be closed to listing: Windows (ACLs), or a volume without permissions");
  const sys = fakeSystem(t);
  const box = path.join(sys.cwd(), "box");
  mkdirSync(box);
  writeFileSync(path.join(box, "front-1.png"), "mine");
  writeFileSync(path.join(box, "front-2.png"), "mine too");
  chmodSync(box, 0o300);
  const { code, json } = await run(["screenshot", "--out", box, "--json"], sys);
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.file, path.join(box, "front-3.png"));
  chmodSync(box, 0o700);
  assert.equal(readFileSync(path.join(box, "front-1.png"), "utf8"), "mine");
  assert.equal(readFileSync(path.join(box, "front-2.png"), "utf8"), "mine too");
  assertPixels(path.join(box, "front-3.png"), "front", FRONT);
});

test("--out <file>: that file, made or replaced whole; a relative path is from the caller's folder", async (t) => {
  const sys = fakeSystem(t);
  const named = path.join("deep", "a b", "Γειά σου フォルダ.png");
  const made = await run(["screenshot", "--out", named, "--json"], sys);
  assert.equal(made.code, 0, made.out);
  assert.equal(made.json.file, path.join(sys.cwd(), named));
  assertPixels(made.json.file, "front", FRONT);
  writeFileSync(made.json.file, "old");
  // On exFAT macOS gives the file this test wrote an AppleDouble companion of its own; the command leaves one it did
  // not make, so it goes here.
  rmSync(path.join(path.dirname(made.json.file), `._${path.basename(made.json.file)}`), { force: true });
  assert.equal(made.json.replaced, false);
  const again = await run(["screenshot", "--back", "--out", made.json.file, "--json"], sys);
  assert.equal(again.json.file, made.json.file);
  assert.equal(again.json.replaced, true, "the file that was there is said to be replaced");
  assertPixels(made.json.file, "back", BACK);
  assert.deepEqual(listing(path.dirname(made.json.file)), ["Γειά σου フォルダ.png"], "no temporary file is left");
  // The text says so too, for the file and for the enlarged copy.
  const text = await run(["screenshot", "--out", made.json.file, "--scale", "2"], sys);
  assert.match(text.out, /^Replaced the file with the front display, 72×16 px: .+\.png\nEnlarged 2 times, 144×32 px, not for the catalog: .+@2x\.png\n/);
  const textAgain = await run(["screenshot", "--out", made.json.file, "--scale", "2", "--json"], sys);
  assert.deepEqual([textAgain.json.replaced, textAgain.json.scaled.replaced], [true, true]);
  assert.match((await run(["screenshot", "--out", made.json.file, "--scale", "2"], sys)).out.split("\n")[1], /^Replaced the file with the frame enlarged 2 times, 144×32 px, not for the catalog: .+@2x\.png$/);
  // Upper-case .PNG is a PNG too.
  assert.equal((await run(["screenshot", "--out", "SHOT.PNG", "--json"], sys)).json.file, path.join(sys.cwd(), "SHOT.PNG"));
});

test("--out <folder>: a folder that is there, or a path that ends in a separator, gets the next number", async (t) => {
  const sys = fakeSystem(t);
  mkdirSync(path.join(sys.cwd(), "there.png"));
  assert.equal((await run(["screenshot", "--out", "there.png", "--json"], sys)).json.file, path.join(sys.cwd(), "there.png", "front-1.png"));
  const slash = await run(["screenshot", "--out", `new${path.sep}`, "--json"], sys);
  assert.equal(slash.json.file, path.join(sys.cwd(), "new", "front-1.png"));
  if (path.sep === "\\") assert.equal((await run(["screenshot", "--out", "other/", "--json"], sys)).json.file, path.join(sys.cwd(), "other", "front-1.png"));
});

test("--scale: the enlarged copy beside the file, as <name>@<n>x.png, every pixel a square of the frame's", async (t) => {
  const sys = fakeSystem(t);
  const numbered = await run(["screenshot", "--scale", "8", "--json"], sys);
  const file = path.join(sys.cwd(), "screenshots", "front-1.png");
  assert.equal(numbered.json.file, file);
  assert.deepEqual(numbered.json.scaled, { file: path.join(sys.cwd(), "screenshots", "front-1@8x.png"), replaced: false, scale: 8, width: 576, height: 128, bytes: readFileSync(path.join(sys.cwd(), "screenshots", "front-1@8x.png")).length });
  assertPixels(file, "front", FRONT);
  assertPixels(numbered.json.scaled.file, "front", FRONT, 8);
  // The next screenshot does not take number 1 again although only its enlarged copy might have been there.
  const named = await run(["screenshot", "--back", "--out", "shot.PNG", "--scale=3", "--json"], sys);
  assert.equal(named.json.scaled.file, path.join(sys.cwd(), "shot@3x.png"));
  assertPixels(named.json.scaled.file, "back", BACK, 3);
  const text = await run(["screenshot", "--scale", "2"], sys);
  assert.equal(
    text.out,
    [
      `Saved the front display, 72×16 px: ${path.join(sys.cwd(), "screenshots", "front-2.png")}`,
      `Enlarged 2 times, 144×32 px, not for the catalog: ${path.join(sys.cwd(), "screenshots", "front-2@2x.png")}`,
      "The catalog takes it as a front screenshot (its check screenshot_png).",
    ].join("\n"),
  );
});

// ---------------------------------------------------------------- the catalog's check

test("the catalog's note is shown to the author, in the text and in the JSON", async (t) => {
  const note = "The file marks #000000 as transparent (a tRNS chunk): the catalog keeps every pixel of that color fully transparent.";
  const sys = fakeSystem(t, { catalog: stubCheck({ verdict: "pass", note }) });
  const text = await run(["screenshot"], sys);
  assert.equal(text.code, 0);
  assert.equal(text.out.split("\n").at(-1), `Note: ${note}`);
  assert.equal((await run(["screenshot", "--json"], sys)).json.catalog.note, note);
});

test("a copy without the catalog's rules says that it did not check, and still saves the file", async (t) => {
  const sys = fakeSystem(t, { catalog: async () => null });
  const json = await run(["screenshot", "--json"], sys);
  assert.equal(json.code, 0);
  assert.equal(json.json.catalog, null);
  assert.ok(existsSync(json.json.file));
  assert.match((await run(["screenshot"], sys)).out, /\nThis copy of the emulator does not have the catalog's rules: the file was not checked against them\.$/);
});

test("a file the catalog would not take is a failure, which names the file it saved", async (t) => {
  for (const verdict of [
    { verdict: "fail", id: "screenshot_png", reason: "dimensions", message: "The file is 73×16, expected 72×16. Save it as an 8-bit PNG of exactly 72×16 pixels." },
    { verdict: "unverified", id: "screenshot_final", reason: "build-unverified", detail: "x", message: "The file passes the catalog's PNG checks, but x." },
  ]) {
    const sys = fakeSystem(t, { catalog: stubCheck(verdict) });
    const { code, json } = await run(["screenshot", "--json"], sys);
    assert.equal(code, 1);
    assert.equal(json.code, "catalog_check");
    assert.equal(json.catalog.verdict, verdict.verdict);
    assert.ok(existsSync(json.file));
    assert.match(json.message, new RegExp(`^Saved .+front-1\\.png, but the catalog would not take it: ${verdict.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  }
});

test("the real loader gives the catalog's check where its file is, and nothing where it is not", async () => {
  assert.equal(await loadCatalogCheck(path.join(os.tmpdir(), "no-such-folder-019", "catalog-png.mjs")), null);
  // The module is part of the server and of every release: missing here, it is missing from what ships (a release once
  // went out without capture/).
  const real = path.join(CLI_DIR, "..", "capture", "catalog-png.mjs");
  assert.ok(existsSync(real), `${real} is missing`);
  const loaded = await loadCatalogCheck();
  assert.equal(typeof loaded?.check, "function");
  assert.equal(loaded.rules.front.id, "screenshot_png");
  assert.equal(loaded.rules.back.id, "back_screenshot_png");
});

// ---------------------------------------------------------------- the emulator and its bar

test("an emulator that is not running is not started: not_running, with what to do, and nothing written", async (t) => {
  for (const states of [[null], [{ ...READY, state: "starting" }], [{ ...READY, state: "failed", detail: "the firmware did not load" }]]) {
    const sys = fakeSystem(t, { states });
    const { code, json } = await run(["screenshot", "--json"], sys);
    assert.equal(code, 1, JSON.stringify(states));
    assert.equal(json.code, "not_running");
    assert.match(json.hint, /^Run \/Users\/you\/\.busy-emulator\/bin\/busy-emulator start, open your app on the BUSY Bar, then take the screenshot\.$/);
    assert.deepEqual(sys.calls.filter(([what]) => what !== "probe"), [], "nothing launched, no frame asked for");
    assert.deepEqual(listing(sys.cwd()), [], "nothing written");
  }
  assert.match((await run(["screenshot"], fakeSystem(t, { states: [null] }))).err, /^busy-emulator: The emulator is not running, so there is no BUSY Bar to take a screenshot of\./);
  assert.match((await run(["screenshot", "--json"], fakeSystem(t, { states: [{ ...READY, state: "starting" }] }))).json.message, /its BUSY Bar is not ready: starting\.$/);
  // In the source folder (no app to start) the answer is the same.
  const source = { ...ctx, kind: "development", development: true, appPath: null };
  const out = [];
  assert.equal(await main(["screenshot", "--json"], { ctx: source, sys: fakeSystem(t, { states: [null] }), out: (l) => out.push(l), err: () => {} }), 1);
  assert.equal(JSON.parse(out[0]).code, "not_running");
});

test("a screenshot of a running, ready emulator does not launch the app, so its window is not brought forward", async (t) => {
  const sys = fakeSystem(t);
  assert.equal((await run(["screenshot", "--json"], sys)).code, 0);
  assert.deepEqual(sys.calls.filter(([what]) => what === "launch"), []);
});

test("a BUSY Bar that gives no frame: screen_failed with why, and nothing is written", async (t) => {
  const cases = [
    [{ failed: "ECONNRESET" }, /gave no frame of its front display: ECONNRESET\.$/, /status/],
    [{ status: 503, body: '{"error":"The emulated BUSY Bar is powered off: press one of its buttons to turn it on"}\n' }, /it answered 503 \(The emulated BUSY Bar is powered off: press one of its buttons to turn it on\)\.$/, /turn it on in the emulator's window/],
    [{ status: 404, body: "nope" }, /it answered 404\.$/, /status/],
    [{ status: 200, body: "not base64 at all!" }, /its answer is not base64\.$/, /status/],
    [{ status: 200, body: Buffer.alloc(3455).toString("base64") }, /the frame is 3455 bytes, not 3456\.$/, /status/],
  ];
  for (const [given, message, hint] of cases) {
    const sys = fakeSystem(t, { screen: () => given });
    const { code, json } = await run(["screenshot", "--json"], sys);
    assert.equal(code, 1, JSON.stringify(given));
    assert.equal(json.code, "screen_failed");
    assert.match(json.message, /^The BUSY Bar at 127\.0\.0\.1:8640 gave no frame/);
    assert.match(json.message, message);
    assert.match(json.hint, hint);
    assert.deepEqual(listing(sys.cwd()), [], "nothing written");
  }
});

test("a sandbox that closes loopback when the frame is asked for: blocked_network", async (t) => {
  const { code, json } = await run(["screenshot", "--json"], fakeSystem(t, { screen: () => ({ blocked: "EPERM" }) }));
  assert.equal(code, 1);
  assert.equal(json.code, "blocked_network");
  assert.match(json.hint, /outside the sandbox/);
});

test("a file that cannot be written: write_failed, with the path and the system's code", async (t) => {
  const sys = fakeSystem(t);
  writeFileSync(path.join(sys.cwd(), "a-file"), "");
  const under = await run(["screenshot", "--out", path.join("a-file", "shot.png"), "--json"], sys);
  assert.equal(under.code, 1);
  assert.equal(under.json.code, "write_failed");
  assert.match(under.json.message, /^Could not write .+a-file.* \((ENOTDIR|EEXIST|ENOENT)\)\.$/);
  if (!permissionsHold(t, 0o500)) return t.skip("no folder here can be made read-only (Windows, or a volume without permissions): the read-only half did not run");
  const locked = path.join(sys.cwd(), "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o500);
  for (const out of [locked, path.join(locked, "shot.png")]) {
    const { code, json } = await run(["screenshot", "--out", out, "--json"], sys);
    assert.equal(code, 1, out);
    assert.equal(json.code, "write_failed", out);
    assert.match(json.message, /\(EACCES\)\.$/, out);
    assert.match(json.hint, /read-only, or a sandbox may forbid writing there/);
    assert.deepEqual(readdirSync(locked), [], `${out}: no temporary file is left`);
  }
});

// ---------------------------------------------------------------- a copy without the encoder

test("a copy of the command line without the encoder still runs every other command, and screenshot says what is missing", async (t) => {
  const folder = tempFolder(t);
  const cli = path.join(folder, "packages", "server", "cli");
  cpSync(CLI_DIR, cli, { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
  // What the app holds beside it (packages/app/tools/stage-resources.mjs): the project tools, programs.mjs and the
  // three modules of the server allow-local reads, and the clip's limits record checks a call against.
  cpSync(path.join(CLI_DIR, "..", "projects"), path.join(folder, "packages", "server", "projects"), { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
  cpSync(path.join(CLI_DIR, "..", "readiness"), path.join(folder, "packages", "server", "readiness"), { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
  // The publish flow's rule of where it writes (files.mjs), which catalog-texts writes by.
  cpSync(path.join(CLI_DIR, "..", "publish"), path.join(folder, "packages", "server", "publish"), { recursive: true, filter: (source) => !source.includes(`${path.sep}test`) });
  cpSync(path.join(CLI_DIR, "..", "..", "engine", "programs.mjs"), path.join(folder, "packages", "engine", "programs.mjs"));
  for (const module of ["data-folder.mjs", "json-store.mjs", "local-access.mjs", "old-files.mjs", "path-boundary.mjs", "process-info.mjs", "same-path.mjs", "server-key.mjs", "tar.mjs", "capture/clip-limits.mjs"]) cpSync(path.join(CLI_DIR, "..", module), path.join(folder, "packages", "server", module));
  const commands = await loadCommands(path.join(cli, "commands"));
  const out = [];
  assert.equal(await main(["version", "--json"], { ctx, sys: fakeSystem(t), commands, out: (line) => out.push(line), err: () => {} }), 0);
  const missing = [];
  assert.equal(await main(["screenshot", "--json"], { ctx, sys: fakeSystem(t), commands, out: (line) => missing.push(line), err: () => {} }), 1);
  const json = JSON.parse(missing[0]);
  assert.equal(json.code, "internal");
  assert.match(json.message, /no PNG encoder \(packages\/server\/capture\/png\.mjs\)/);
});
