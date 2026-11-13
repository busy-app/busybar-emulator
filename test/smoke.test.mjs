// The parts of the smoke test (test/smoke.mjs) that need no built app: the expected frame, the smoke app, the list of
// what must not be in an app, and the readers of PNG, app.asar, the system's socket lists and Chromium's network log.
// The smoke test itself needs a built app and runs by hand (npm run smoke).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { encodeScreenPng } from "../packages/server/capture/png.mjs";
import { EXPECTED, GOLDEN, expectedPng } from "./smoke/expected.mjs";
import {
  archOfProgram,
  asarFiles,
  defaultTestVariant,
  differingPixels,
  forbiddenFiles,
  layoutOf,
  parseLsof,
  parseNetstat,
  pastThisMachine,
  readNetLog,
  readPng,
  releaseFilesOf,
  wildcard,
} from "./smoke/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the committed expected frame is the golden's front frame, byte for byte", () => {
  assert.ok(expectedPng().equals(readFileSync(EXPECTED)), "run node test/smoke/expected.mjs");
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  // The recording names the bar as "BUSY Bar", not by its serial number (the files are public), and the firmware it ran.
  assert.equal(golden.source.bar, "BUSY Bar", "the golden was recorded on a bar");
  assert.match(golden.source.firmware, /^[0-9a-f]{8}/, "the golden names the firmware of the bar");
  assert.equal(golden.source.serial, undefined, "the golden does not name the bar by its serial number");
  const png = readPng(readFileSync(EXPECTED));
  assert.deepEqual([png.width, png.height, png.channels], [72, 16, 3]);
  assert.ok(png.pixels.some((v) => v !== 0), "the expected frame is not black");
});

test("the smoke app draws the golden's elements", () => {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  const script = readFileSync(path.join(here, "smoke", "app.busy.smoke", "scripts", "main.js"), "utf8");
  const elements = JSON.parse(/const elements = (\[.*\]);/.exec(script)[1]);
  assert.deepEqual(elements, golden.elements);
  const manifest = JSON.parse(readFileSync(path.join(here, "smoke", "app.busy.smoke", "appmeta", "manifest.json"), "utf8"));
  assert.equal(manifest.id, "app.busy.smoke");
  assert.match(script, /application_name: APP/);
  assert.match(script, new RegExp(`const APP = "${manifest.id}"`));
});

/** A PNG with the given row filters, by hand: what readPng must undo. */
function pngWithFilters(width, height, channels, pixels, filters) {
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length];
    const row = Buffer.alloc(stride + 1);
    row[0] = f;
    for (let x = 0; x < stride; x++) {
      const cur = pixels[y * stride + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][f];
      row[x + 1] = (cur - predictor) & 0xff;
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    return out; // readPng does not check the CRC
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, channels === 3 ? 2 : 0, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

test("readPng undoes every row filter, and differingPixels counts pixels, not bytes", () => {
  const width = 9;
  const height = 10;
  for (const channels of [1, 3]) {
    const pixels = Buffer.alloc(width * height * channels);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + (i >> 3) * 11) & 0xff;
    const png = readPng(pngWithFilters(width, height, channels, pixels, [0, 1, 2, 3, 4]));
    assert.deepEqual([png.width, png.height, png.channels], [width, height, channels]);
    assert.ok(png.pixels.equals(pixels), `channels ${channels}`);
  }
  const front = Buffer.alloc(72 * 16 * 3);
  const a = readPng(encodeScreenPng("front", front));
  front[3 * 5] = 1; // one byte of pixel 5
  front[3 * 9 + 2] = 1; // one byte of pixel 9
  front[3 * 9 + 1] = 1; // and another of the same pixel
  const b = readPng(encodeScreenPng("front", front));
  assert.equal(differingPixels(a, a), 0);
  assert.equal(differingPixels(a, b), 2);
  assert.equal(differingPixels(a, readPng(encodeScreenPng("back", Buffer.alloc(160 * 80 / 2)))), null);
  assert.throws(() => readPng(Buffer.from("not a png")), /not a PNG/);
});

test("the list catches tests, engine build sources and development dependencies, and lets the app's own files pass", () => {
  const parts = [
    { name: "app.asar", files: ["package.json", "src/main.mjs", "src/pages/shell/index.html", "test-variant/hook.mjs", "node_modules/@electron/fuses/index.js"] },
    {
      name: "resources/emulator",
      files: [
        "packages/server/index.mjs",
        "packages/server/cli/busy-emulator.mjs",
        "packages/engine/build/1.3.1/screen.wasm",
        "packages/engine/build/1.3.1/web/index.html",
        "packages/engine/programs.mjs",
        "packages/server/screen.test.mjs",
        "packages/server/cli/test/commands.test.mjs",
        "packages/server/test/helpers.mjs",
        "packages/engine/native/furi_shim.c",
        "packages/engine/native/emu.h",
        "packages/engine/build.mjs",
        "packages/engine/patches.mjs",
        "packages/engine/build/1.3.1/obj/screen.o",
        "packages/server/capture/png.mjs.map",
        "package-lock.json",
        "resedit/index.js",
      ],
    },
  ];
  const devDependencies = ["@electron/asar", "@electron/fuses", "electron", "resedit"];
  const found = forbiddenFiles(parts, { devDependencies, kind: "test" }).map((f) => `${f.part}/${f.file}: ${f.what}`);
  assert.deepEqual(found, [
    "app.asar/node_modules/@electron/fuses/index.js: a dependency folder",
    "resources/emulator/packages/server/screen.test.mjs: a test",
    "resources/emulator/packages/server/cli/test/commands.test.mjs: a test",
    "resources/emulator/packages/server/test/helpers.mjs: a test",
    "resources/emulator/packages/engine/native/furi_shim.c: an engine build source",
    "resources/emulator/packages/engine/native/emu.h: an engine build source",
    "resources/emulator/packages/engine/build.mjs: an engine build source",
    "resources/emulator/packages/engine/patches.mjs: an engine build source",
    "resources/emulator/packages/engine/build/1.3.1/obj/screen.o: an engine build intermediate",
    "resources/emulator/packages/server/capture/png.mjs.map: a lock file or a source map",
    "resources/emulator/package-lock.json: a lock file or a source map",
    "resources/emulator/resedit/index.js: the development dependency resedit",
  ]);
  // The test entry belongs to the test variant only.
  const release = forbiddenFiles([{ name: "app.asar", files: ["test-variant/hook.mjs"] }], { kind: "release" });
  assert.deepEqual(release.map((f) => f.what), ["the test variant's test entry"]);
});

test("asarFiles reads the list of an archive from its header", () => {
  const tree = { files: { "package.json": { size: 2, offset: "0" }, src: { files: { "main.mjs": { size: 1, offset: "2" }, pages: { files: { "a.html": { size: 1, offset: "3" } } } } } } };
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  const dir = mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-test-smoke-"));
  try {
    const file = path.join(dir, "app.asar");
    writeFileSync(file, Buffer.concat([header, Buffer.from("{}xy")]));
    assert.deepEqual(asarFiles(file), ["package.json", "src/main.mjs", "src/pages/a.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the app's places on each system", () => {
  assert.deepEqual(layoutOf("/A/BUSY Bar Emulator.app", "darwin"), {
    app: "/A/BUSY Bar Emulator.app",
    exe: "/A/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator",
    resources: "/A/BUSY Bar Emulator.app/Contents/Resources",
    cli: "/A/BUSY Bar Emulator.app/Contents/Resources/bin/busy-emulator",
  });
  assert.equal(layoutOf("C:\\A\\BUSY Bar Emulator", "win32").cli, "C:\\A\\BUSY Bar Emulator\\resources\\bin\\busy-emulator.exe");
  assert.equal(
    defaultTestVariant({ platform: "darwin", arch: "arm64", home: "/H" }),
    "/H/Library/Caches/busy-emulator-build/dist/test-variant/darwin-arm64/BUSY Bar Emulator.app",
  );
  assert.equal(
    defaultTestVariant({ platform: "win32", arch: "x64", home: "C:\\H", localAppData: "C:\\H\\Local" }),
    "C:\\H\\Local\\busy-emulator-build\\dist\\test-variant\\win32-x64\\BUSY Bar Emulator",
  );
});

test("the app's architecture is read from its program, and names the release files that hold it", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-smoke-arch-"));
  try {
    const program = (name, cpu) => {
      const header = Buffer.alloc(32);
      if (cpu === null) header.write("#!/bin/sh\n");
      else if (cpu === 0) header.writeUInt32BE(0xcafebabe, 0);
      else {
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(cpu, 4);
      }
      writeFileSync(path.join(folder, name), header);
      return path.join(folder, name);
    };
    assert.equal(archOfProgram(program("arm64", 0x0100000c), "darwin"), "arm64");
    assert.equal(archOfProgram(program("x64", 0x01000007), "darwin"), "x64");
    assert.equal(archOfProgram(program("universal", 0), "darwin"), "universal");
    assert.equal(archOfProgram(program("script", null), "darwin"), null);
    assert.equal(archOfProgram("C:\\A\\BUSY Bar Emulator.exe", "win32"), "x64");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  assert.deepEqual(releaseFilesOf("darwin", "arm64"), ["busybar-emulator-mac-arm64.zip", "busybar-emulator-mac-arm64.dmg"]);
  assert.deepEqual(releaseFilesOf("darwin", "x64"), ["busybar-emulator-mac-x64.zip", "busybar-emulator-mac-x64.dmg"]);
  assert.deepEqual(releaseFilesOf("win32", "x64"), ["busybar-emulator-win-x64-setup.exe"]);
});

test("sockets: what stays on this machine and what reaches past it", () => {
  const lsof = [
    "p100",
    "f20",
    "PTCP",
    "n127.0.0.1:8770",
    "TST=LISTEN",
    "f21",
    "PTCP",
    "n127.0.0.1:50000->127.0.0.1:8770",
    "TST=ESTABLISHED",
    "f22",
    "PUDP",
    "n*:*",
    "p101",
    "f5",
    "PTCP",
    "n[::1]:8771",
    "TST=LISTEN",
    "f6",
    "PTCP",
    "n198.51.100.5:50001->192.0.2.10:443",
    "TST=SYN_SENT",
    "f7",
    "PUDP",
    "n*:5353",
    "f8",
    "PTCP",
    "n*:8772",
    "TST=LISTEN",
    "f9",
    "PUDP",
    "n[fe80::1]:50002->[2001:4860:4860::8888]:443",
    "",
  ].join("\n");
  const past = parseLsof(lsof).map(pastThisMachine);
  assert.deepEqual(past, [
    null,
    null,
    null,
    null,
    "TCP to 192.0.2.10:443 (SYN_SENT)",
    "UDP bound on *:5353",
    "TCP listening on *:8772",
    "UDP to [2001:4860:4860::8888]:443",
  ]);
  const netstat = [
    "",
    "Active Connections",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:8770         0.0.0.0:0              LISTENING       200",
    "  TCP    0.0.0.0:8773           0.0.0.0:0              LISTENING       200",
    "  TCP    127.0.0.1:50010        127.0.0.1:8770         ESTABLISHED     201",
    "  TCP    203.0.113.2:50011       192.0.2.20:443          ESTABLISHED     201",
    "  TCP    203.0.113.2:50012       192.0.2.20:443          ESTABLISHED     999",
    "  TCP    [::1]:8774             [::]:0                 LISTENING       200",
    "  UDP    0.0.0.0:5353           *:*                                    201",
    "  UDP    127.0.0.1:50013        *:*                                    201",
    // A connected UDP socket: netstat gives only its own end, an address of this machine.
    "  UDP    [2001:db8::5]:51411    *:*                                    201",
  ].join("\r\n");
  const sockets = parseNetstat(netstat, new Set([200, 201]));
  assert.equal(sockets.length, 8, "the process 999 is not the app's");
  assert.deepEqual(sockets.map(pastThisMachine), [
    null,
    "TCP listening on 0.0.0.0:8773",
    null,
    "TCP to 192.0.2.20:443 (ESTABLISHED)",
    null,
    "UDP bound on 0.0.0.0:5353",
    null,
    "UDP bound on [2001:db8::5]:51411",
  ]);
  // smoke.mjs keeps a UDP socket on a single address apart (matched with Chromium's probes); one on every address is
  // always a failure.
  assert.deepEqual(["0.0.0.0:5353", "[::]:5353", "*:5353", "[2001:db8::5]:51411", "198.51.100.5:500"].map(wildcard), [true, true, true, false, false]);
});

/** A network log as Chromium writes it: the constants, then one event a line. */
function netLog(events, { closed = true } = {}) {
  const constants = {
    logEventTypes: { TCP_CONNECT: 1, UDP_CONNECT: 2, UDP_BYTES_SENT: 3, HOST_RESOLVER_MANAGER_REQUEST: 4, URL_REQUEST_START_JOB: 5, SOCKET_ALIVE: 6, UDP_LOCAL_ADDRESS: 7 },
    logSourceType: { SOCKET: 1, UDP_SOCKET: 2, HOST_RESOLVER_IMPL_JOB: 3, URL_REQUEST: 4, UDP_CLIENT_SOCKET: 5 },
  };
  const lines = events.map((e) => JSON.stringify(e));
  return `{"constants":${JSON.stringify(constants)},\n"events": [\n${lines.join(",\n")}${closed ? '\n],\n"polledData": {}\n}\n' : ",\n"}`;
}

test("Chromium's network log: requests, lookups, connections and datagrams beyond this machine", () => {
  const ev = (type, source, id, params) => ({ type, source: { type: source, id }, params });
  const quiet = [
    ev(5, 4, 1, { url: "http://127.0.0.1:8770/emulator", method: "GET" }),
    ev(5, 4, 2, { url: "app://shell/index.html" }),
    ev(4, 3, 3, { host: "http://127.0.0.1:8770" }),
    ev(1, 1, 4, { address: "127.0.0.1:8770" }),
    // The IPv6 reachability check: connected, nothing sent.
    ev(6, 2, 5, { source_dependency: { id: 6, type: 5 } }),
    ev(2, 2, 5, { address: "[2001:4860:4860::8888]:443" }),
    // Its own end, an address of this machine (Windows, where IPv6 works): not a destination.
    ev(7, 2, 5, { address: "[2001:db8::5]:51411" }),
  ];
  assert.deepEqual(readNetLog(netLog(quiet)), {
    events: 7,
    complete: true,
    named: true,
    reached: [],
    probes: ["[2001:4860:4860::8888]:443"],
    probeLocals: ["[2001:db8::5]:51411"],
  });

  const loud = [
    ...quiet,
    ev(5, 4, 7, { url: "https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic" }),
    ev(4, 3, 8, { host: "clients2.google.com:443" }),
    ev(1, 1, 9, { address: "142.250.0.1:443" }),
    ev(2, 2, 10, { address: "8.8.8.8:53" }),
    ev(3, 2, 10, { byte_count: 40 }),
    // Datagrams on the client socket that depends on a connected UDP socket count too.
    ev(6, 2, 11, { source_dependency: { id: 12, type: 5 } }),
    ev(2, 2, 11, { address: "1.1.1.1:53" }),
    ev(3, 5, 12, { byte_count: 40 }),
  ];
  const read = readNetLog(netLog(loud));
  assert.deepEqual(read.reached, [
    "UDP datagrams to 1.1.1.1:53",
    "UDP datagrams to 8.8.8.8:53",
    "connection to 142.250.0.1:443",
    "lookup clients2.google.com:443",
    "request https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic",
  ]);
  assert.deepEqual(read.probes, ["[2001:4860:4860::8888]:443"]);

  // A log the process did not close is read up to where it stops.
  const cut = readNetLog(netLog(loud.slice(0, 11), { closed: false }).slice(0, -3));
  assert.equal(cut.complete, false);
  assert.equal(cut.named, true);
  assert.deepEqual(cut.reached, ["connection to 142.250.0.1:443", "lookup clients2.google.com:443", "request https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic"]);
  assert.equal(readNetLog("").named, false);
});

// The smoke test itself stopped in the middle (EMU-017 review, M1): the app it started runs on its own, and only the
// test knows its data folder, so the test must quit it and remove its folder before it ends. Needs a built test
// variant: BUSY_EMULATOR_SMOKE_APP=<the app npm run dist -- --kind test built>. macOS only: on Windows one process
// cannot send another a signal it can handle (child.kill ends it outright).
const builtApp = process.env.BUSY_EMULATOR_SMOKE_APP;
const interruptSkip =
  process.platform !== "darwin"
    ? "macOS only: Windows has no signal one process can send another to be handled"
    : !builtApp
      ? "set BUSY_EMULATOR_SMOKE_APP to a test variant built by npm run dist -- --kind test"
      : false;
// The third case lands while `record` runs, a step of seconds: the run that went on after a signal did so there.
for (const [signal, after] of [
  ["SIGINT", /^smoke: start: ready/m],
  ["SIGTERM", /^smoke: app: /m],
  ["SIGHUP", /^smoke: frame: /m],
]) {
  test(`${signal} in the middle of a run quits the app and leaves nothing (after "${after.source.slice(8)}")`, { skip: interruptSkip, timeout: 180_000 }, async () => {
    const app = path.resolve(builtApp);
    const port = 8778;
    const smokeFolders = () => readdirSync(os.tmpdir()).filter((f) => f.startsWith("busybar-emulator-smoke-"));
    const before = new Set(smokeFolders());
    const appProcesses = () => {
      const { stdout } = spawnSyncPs();
      return stdout.split("\n").filter((line) => line.includes(`${app}/`));
    };
    assert.deepEqual(appProcesses(), [], "the app is not running before the test");
    const child = spawn(process.execPath, [path.join(here, "smoke.mjs"), app, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (out += c));
    const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    for (const until = Date.now() + 90_000; !after.test(out); ) {
      assert.ok(Date.now() < until, `the run did not get that far:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(appProcesses().length > 0, "the app runs when the signal comes");
    child.kill(signal);
    const code = await exited;
    assert.equal(code, 130, out);
    assert.match(out, new RegExp(`stopped by ${signal}`));
    // The run goes no further than the signal: no step of it, and no failure, after the line that says so. It went
    // on before (13.11, the release's gate of beta.2 and beta.4): to a screenshot, `record` against an app that was
    // quitting and `busy-emulator mcp`, whose process was still running when the test ended.
    assert.doesNotMatch(out.slice(out.indexOf(`stopped by ${signal}`)), /^smoke: (frame|record|mcp|FAIL)/m, out);
    assert.deepEqual(appProcesses(), [], `no process of the app is left:\n${out}`);
    const listening = await new Promise((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    assert.equal(listening, false, `nothing listens on ${port}`);
    assert.deepEqual(smokeFolders().filter((f) => !before.has(f)), [], "the temporary folder is removed");
  });
}

function spawnSyncPs() {
  return spawnSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8", env: { LC_ALL: "C", LC_CTYPE: "UTF-8" } });
}
