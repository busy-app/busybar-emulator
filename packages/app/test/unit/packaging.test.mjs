// The parts of the packaging (tools/dist.mjs, tools/packaging/) that need no build: the names of the release's files,
// the fuses, SHA256SUMS, the zip of the Windows payload, the lists of what goes into the app, Info.plist. The built
// files themselves are checked by tools/dist.mjs check and test/app/built.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { execProgram } from "../../../engine/programs.mjs";
import { appVersion, build, buildTargets, checkReleaseVersion, insideFolder, repositoryRoot, UNSET_VERSION } from "../../tools/dist.mjs";
import { macPrograms } from "../../tools/packaging/check.mjs";
import { archiveEntries, archiveManifest, archiveProblems, emulatorFiles, emulatorProblems, EXPORT_RECORD, missingImports, sourceCommit, UNPACKED_IN_ARCHIVE } from "../../tools/packaging/composition.mjs";
import { electronArchiveName, electronSum, fetchElectron, machoArch, runsHere } from "../../tools/packaging/electron.mjs";
import { FUSES, fuseFileOf, fuseProblems, readFuseWire, RELEASE_WIRE, SENTINEL, STOCK_WIRE } from "../../tools/packaging/fuses.mjs";
import { appInfoPlist, helperInfoPlist } from "../../tools/packaging/macos.mjs";
import { ALL_RELEASE_FILES, RELEASE_FILES, targetOfFile, targetsBuiltOn } from "../../tools/packaging/names.mjs";
import { markerBytes } from "../../tools/packaging/resources.mjs";
import { checkSums, writeSums } from "../../tools/packaging/sums.mjs";
import { setupVersionProblems } from "../../tools/packaging/windows-check.mjs";
import { installerInfoSource, payloadOf, TRAILER_BYTES, PAYLOAD_MAGIC, windowsVersion } from "../../tools/packaging/windows.mjs";
import { openZip, writeZip } from "../../tools/packaging/zip.mjs";
import { APP_DIR, removeFolder, temporaryFolder } from "../helpers.mjs";

let folder;
before(() => {
  folder = temporaryFolder();
});
after(async () => {
  await removeFolder(folder);
});

test("the files of a release have the names of ADR-0002, the same in every release: no version in them", () => {
  assert.deepEqual(ALL_RELEASE_FILES, [
    "busybar-emulator-mac-arm64.dmg",
    "busybar-emulator-mac-arm64.zip",
    "busybar-emulator-mac-x64.dmg",
    "busybar-emulator-mac-x64.zip",
    "busybar-emulator-win-x64-setup.exe",
    "SHA256SUMS",
  ]);
  assert.deepEqual(Object.keys(RELEASE_FILES), ["darwin-arm64", "darwin-x64", "win32-x64"], "macOS for Apple Silicon and for Intel; no archive for Windows");
  assert.deepEqual(RELEASE_FILES["darwin-x64"], ["busybar-emulator-mac-x64.dmg", "busybar-emulator-mac-x64.zip"]);
  for (const name of ALL_RELEASE_FILES.slice(0, -1)) assert.ok(RELEASE_FILES[targetOfFile(name)].includes(name), name);
  assert.equal(targetOfFile("SHA256SUMS"), null);
  assert.equal(targetOfFile("busybar-emulator-mac-universal.zip"), null);
  for (const name of ALL_RELEASE_FILES) assert.doesNotMatch(name, /\d+\.\d+/);
  const version = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;
  for (const name of ALL_RELEASE_FILES) assert.ok(!name.includes(version));
});

test("the fuses of the release are ADR-0016's nine, and the stock wire is Electron 45.2.3's", () => {
  assert.equal(FUSES.length, 9);
  assert.deepEqual(
    Object.fromEntries(FUSES.map((f) => [f.name, f.release])),
    {
      RunAsNode: false,
      EnableCookieEncryption: false,
      EnableNodeOptionsEnvironmentVariable: false,
      EnableNodeCliInspectArguments: false,
      EnableEmbeddedAsarIntegrityValidation: true,
      OnlyLoadAppFromAsar: true,
      LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: false,
      WasmTrapHandlers: true,
    },
  );
  assert.equal(RELEASE_WIRE, "000011001");
  assert.equal(STOCK_WIRE, "101100011");
});

test("a Mac builds both architectures of macOS, Windows its own; a release is all of them, the test variant this system's own", () => {
  for (const host of ["darwin-arm64", "darwin-x64"]) assert.deepEqual(targetsBuiltOn(host), ["darwin-arm64", "darwin-x64"], host);
  assert.deepEqual(targetsBuiltOn("win32-x64"), ["win32-x64"]);
  assert.deepEqual(targetsBuiltOn("linux-x64"), []);

  assert.deepEqual(buildTargets({ kind: "release", host: "darwin-arm64" }), ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(buildTargets({ kind: "test", host: "darwin-arm64" }), ["darwin-arm64"], "the tests start the test variant: this Mac's own");
  assert.deepEqual(buildTargets({ kind: "test", host: "darwin-x64" }), ["darwin-x64"]);
  assert.deepEqual(buildTargets({ kind: "test", arch: "x64", host: "darwin-arm64" }), ["darwin-x64"]);
  assert.deepEqual(buildTargets({ kind: "test", arch: "all", host: "darwin-arm64" }), ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(buildTargets({ kind: "release", arch: "arm64", host: "darwin-arm64" }), ["darwin-arm64"]);
  assert.deepEqual(buildTargets({ kind: "release", host: "win32-x64" }), ["win32-x64"]);
  assert.deepEqual(buildTargets({ kind: "release", arch: "all", host: "win32-x64" }), ["win32-x64"]);
  assert.throws(() => buildTargets({ kind: "release", arch: "arm64", host: "win32-x64" }), /does not build win32-arm64/);
  assert.throws(() => buildTargets({ kind: "release", host: "linux-x64" }), /builds no files of a release/);
});

/** The first bytes of a 64-bit Mach-O program for a processor, or of a universal one. */
function machoHeader(cpu) {
  const header = Buffer.alloc(32);
  if (cpu === "universal") header.writeUInt32BE(0xcafebabe, 0);
  else {
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(cpu === "x64" ? 0x01000007 : cpu === "arm64" ? 0x0100000c : 0x01000012, 4);
  }
  return header;
}

test("the architecture of a macOS program is read from its header, without a tool of the system", () => {
  const at = (name, bytes) => {
    const file = path.join(folder, name);
    writeFileSync(file, bytes);
    return file;
  };
  assert.equal(machoArch(at("m-arm64", machoHeader("arm64"))), "arm64");
  assert.equal(machoArch(at("m-x64", machoHeader("x64"))), "x64");
  assert.equal(machoArch(at("m-fat", machoHeader("universal"))), "universal");
  assert.equal(machoArch(at("m-other", machoHeader("ppc64"))), null);
  assert.equal(machoArch(at("m-script", "#!/bin/sh\necho\n")), null);
  assert.equal(machoArch(at("m-short", "ab")), null);
  // This very Node, when it is a Mac's.
  if (process.platform === "darwin") assert.equal(machoArch(process.execPath), process.arch);

  // What of a bundle is a program of the app's architecture: the app, Electron's framework, every helper, Node.
  const app = path.join(folder, "Programs.app");
  for (const helper of ["BUSY Bar Emulator Helper", "BUSY Bar Emulator Helper (GPU)"]) mkdirSync(path.join(app, "Contents", "Frameworks", `${helper}.app`, "Contents", "MacOS"), { recursive: true });
  assert.deepEqual(
    macPrograms(app).map((p) => path.relative(app, p).split(path.sep).join("/")),
    [
      "Contents/MacOS/BUSY Bar Emulator",
      "Contents/Frameworks/Electron Framework.framework/Electron Framework",
      ...readdirSync(path.join(app, "Contents", "Frameworks")).map((n) => `Contents/Frameworks/${n}/Contents/MacOS/${n.replace(/\.app$/, "")}`),
      "Contents/Resources/node/bin/node",
      "Contents/Resources/gh/bin/gh",
    ],
  );

  // Programs of the other architecture run only on Apple Silicon, Intel's, under Rosetta; never the other way.
  assert.equal(runsHere("darwin-arm64", "darwin-arm64"), true);
  assert.equal(runsHere("darwin-arm64", "darwin-x64"), false);
  assert.equal(runsHere("darwin-x64", "win32-x64"), false);
});

test("Electron for macOS's other architecture: the same release's archive, checked against the sum the electron package records", async (t) => {
  const version = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).devDependencies.electron;
  assert.equal(electronArchiveName("45.2.3", "darwin-x64"), "electron-v45.2.3-darwin-x64.zip");
  const installed = existsSync(path.join(APP_DIR, "node_modules", "electron", "checksums.json"));
  await t.test("the sums the installed electron package records", { skip: !installed && "Electron is not installed in packages/app/node_modules (npm ci there)" }, () => {
    for (const target of ["darwin-arm64", "darwin-x64"]) assert.match(electronSum(version, target), /^[0-9a-f]{64}$/, target);
    assert.throws(() => electronSum("0.0.1", "darwin-x64"), /records no sum for electron-v0\.0\.1-darwin-x64\.zip/);
  });

  const cache = path.join(folder, "electron-cache");
  const bytes = Buffer.from("the archive of Electron");
  const sum = createHash("sha256").update(bytes).digest("hex");
  const asked = [];
  const download = async (url, file) => {
    asked.push(url);
    writeFileSync(file, bytes);
  };
  const file = await fetchElectron({ version: "45.2.3", target: "darwin-x64", cacheDir: cache, sum, download });
  assert.equal(file, path.join(cache, "electron", "electron-v45.2.3-darwin-x64.zip"));
  assert.deepEqual(asked, ["https://github.com/electron/electron/releases/download/v45.2.3/electron-v45.2.3-darwin-x64.zip"]);
  await fetchElectron({ version: "45.2.3", target: "darwin-x64", cacheDir: cache, sum, download });
  assert.equal(asked.length, 1, "taken from the cache the second time");
  // A cached archive that changed, and a download that is not the recorded file: refused and removed, never unpacked.
  writeFileSync(file, "changed");
  await assert.rejects(fetchElectron({ version: "45.2.3", target: "darwin-x64", cacheDir: cache, sum, download: async () => assert.fail("no download for a file in the cache") }), /SHA-256 is .* the electron package records/);
  assert.equal(existsSync(file), false);
  await assert.rejects(fetchElectron({ version: "45.2.3", target: "darwin-x64", cacheDir: cache, sum, download: async (_url, to) => writeFileSync(to, "a forged archive") }), /nothing was unpacked/);
  await assert.rejects(fetchElectron({ version: "45.2.3", target: "darwin-x64", cacheDir: cache, sum, download: async (_url, to) => (writeFileSync(to, "half"), Promise.reject(new Error("cut"))) }), /cut/);
  assert.deepEqual(readdirSync(path.join(cache, "electron")), [], "nothing of a refused or broken download is left");
});

const ELECTRON = path.join(APP_DIR, "node_modules", "electron", "dist", process.platform === "darwin" ? "Electron.app" : "electron.exe");
test("the stock wire is read from the installed Electron by our own reader", { skip: !existsSync(ELECTRON) && "Electron's binary is not installed: node node_modules/electron/install.js" }, () => {
  assert.deepEqual(readFuseWire(fuseFileOf(ELECTRON)), { version: 1, wire: STOCK_WIRE });
});

test("the fuse reader finds every wrong fuse, a longer wire and a second wire", () => {
  const wire = (states, length = states.length) => Buffer.concat([Buffer.from("xx"), Buffer.from(SENTINEL), Buffer.from([1, length]), Buffer.from(states), Buffer.from("yy")]);
  const read = (bytes) => readFuseWire("binary", () => bytes);
  assert.deepEqual(fuseProblems(read(wire(RELEASE_WIRE))), []);
  for (let i = 0; i < 9; i++) {
    const flipped = RELEASE_WIRE.split("");
    flipped[i] = flipped[i] === "1" ? "0" : "1";
    const problems = fuseProblems(read(wire(flipped.join(""))));
    assert.equal(problems.length, 1);
    assert.match(problems[0], new RegExp(FUSES[i].name));
  }
  assert.match(fuseProblems(read(wire(`${RELEASE_WIRE}1`))).join(), /10 fuses/);
  assert.throws(() => read(Buffer.concat([wire(RELEASE_WIRE), wire(RELEASE_WIRE)])), /more than one/);
  assert.throws(() => read(Buffer.from("no wire here")), /no fuse wire/);
});

test("the app's archive holds the release files, a trimmed package.json and the marker; the test variant's folder only in the test variant", () => {
  const release = archiveEntries({ kind: "release", marker: markerBytes("release") });
  const names = release.map((e) => e.name);
  assert.ok(names.includes("build.json") && names.includes("src/main.mjs") && names.includes("src/supervisor.mjs"));
  assert.ok(!names.some((n) => n.startsWith("test-variant/") || n.startsWith("test/") || n.startsWith("tools/") || n.includes("node_modules")));
  assert.equal(JSON.parse(release.find((e) => e.name === "build.json").bytes).kind, "release");
  const manifest = JSON.parse(archiveManifest());
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.main, "src/main.mjs");
  assert.deepEqual(archiveProblems({ files: names, expected: names, marker: { kind: "release" } }), []);

  const testNames = archiveEntries({ kind: "test", marker: markerBytes("test") }).map((e) => e.name);
  assert.ok(testNames.includes("test-variant/hook.mjs"));
  // The check of a release's archive refuses the test variant whatever its list says.
  assert.match(archiveProblems({ files: testNames, expected: testNames, marker: { kind: "release" } }).join("\n"), /holds the test variant: test-variant\/hook.mjs/);
  assert.match(archiveProblems({ files: names, expected: names, marker: { kind: "test" } }).join("\n"), /says "test"/);
  assert.match(archiveProblems({ files: [...names, "node_modules/x/index.js"], expected: names, marker: { kind: "release" } }).join("\n"), /dependency/);
  assert.deepEqual(UNPACKED_IN_ARCHIVE, ["src/supervisor.mjs"]);
});

/** The modules a module imports by a relative path, statically or by a dynamic import of a literal: absolute paths. */
function relativeImports(file) {
  const source = readFileSync(file, "utf8");
  // new URL("./gif-worker.mjs", import.meta.url): a worker's module, or a file a module reads.
  const found = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\bnew URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);
  // A specifier that names no file is text in a module (the template's code that create writes), not an import.
  return found.map((spec) => path.resolve(path.dirname(file), spec)).filter((target) => existsSync(target));
}

test("everything the server and the command line import, however deep, is in the resources (the packaged app found no capture/record.mjs)", () => {
  const emulatorDir = path.resolve(APP_DIR, "..", "..");
  const shipped = new Set(emulatorFiles());
  // The command line loads every file of cli/commands/ by its path, and the screenshot's catalog check by
  // new URL("../capture/catalog-png.mjs"): those are entries too.
  const commands = readdirSync(path.join(emulatorDir, "packages", "server", "cli", "commands")).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  const entries = ["packages/server/server.mjs", "packages/server/index.mjs", "packages/server/cli/busy-emulator.mjs", "packages/server/capture/catalog-png.mjs", ...commands.map((name) => `packages/server/cli/commands/${name}`)].map((p) => path.join(emulatorDir, p));
  const seen = new Set();
  const missing = [];
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const rel = path.relative(emulatorDir, file).split(path.sep).join("/");
    if (!shipped.has(rel)) missing.push(rel);
    if (/\.m?js$/.test(file)) queue.push(...relativeImports(file));
  }
  assert.ok(seen.size > 60, `only ${seen.size} modules reached: the walk is broken`);
  assert.deepEqual(missing, [], "imported but not packaged");
});

test("the release check reads what the release's modules import, not the list they were copied by: a module the list missed is found", () => {
  const source = path.join(folder, "missing-imports", "source");
  const release = path.join(folder, "missing-imports", "release");
  const files = {
    "packages/server/cli/a.mjs": 'import { b } from "../b.mjs";\nconst w = new URL("./worker.mjs", import.meta.url);\nconst t = "import x from \'./template-only.mjs\'";\nexport const lazy = () => import("../capture/png.mjs");\n',
    "packages/server/b.mjs": 'export { c } from "./c.mjs";\nexport const b = 1;\n',
    "packages/server/c.mjs": "export const c = 1;\n",
    "packages/server/cli/worker.mjs": "",
    "packages/server/capture/png.mjs": "",
  };
  for (const [name, text] of Object.entries(files)) {
    for (const root of [source, release]) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), text);
    }
  }
  const all = Object.keys(files);
  assert.deepEqual(missingImports({ folder: release, files: all, source }), []);
  const without = all.filter((f) => f !== "packages/server/c.mjs" && f !== "packages/server/capture/png.mjs");
  assert.deepEqual(missingImports({ folder: release, files: without, source }).sort(), [
    "emulator/packages/server/b.mjs imports ./c.mjs (emulator/packages/server/c.mjs), which is missing",
    "emulator/packages/server/cli/a.mjs imports ../capture/png.mjs (emulator/packages/server/capture/png.mjs), which is missing",
  ]);
  // The real tree: every module of what a release takes finds what it imports.
  assert.deepEqual(missingImports({ folder: path.resolve(APP_DIR, "..", ".."), files: emulatorFiles() }), []);
});

test("the resources get the server, the catalog's checks and what the engine needs at run time; no tests, no engine build sources", () => {
  const files = emulatorFiles();
  for (const needed of ["packages/server/index.mjs", "packages/server/cli/busy-emulator.mjs", "packages/server/capture/png.mjs", "packages/server/capture/catalog-png.mjs", "packages/server/capture/record.mjs", "packages/server/capture/clip-limits.mjs", "packages/server/capture/gif.mjs", "packages/server/capture/gif-worker.mjs", "packages/server/capture/led-raster.mjs", "packages/server/readiness/catalog-registry.json", "packages/server/readiness/check.mjs", "packages/server/readiness/rules.mjs", "packages/server/readiness/submission.mjs", "packages/server/cli/commands/check.mjs", "packages/server/cli/commands/submit.mjs", "packages/engine/firmware.json", "packages/engine/checks.mjs", "packages/engine/programs.mjs", "packages/engine/build/1.3.1/screen.wasm", "packages/engine/build/dev/runtime.wasm", "examples/focus-timer/src/main.ts", "examples/focus-timer/README.md", "examples/meeting-cost/src/appmeta/settings.json", "examples/status-board/src/animations/pulse.anim"]) {
    assert.ok(files.includes(needed), needed);
  }
  // The 3D view: what its frame loads, with the player's license and notices beside the player; not the scripts
  // that build the scene, not the package's README, its record or its tests.
  for (const needed of ["packages/server/stage3d.mjs", "packages/server/legacy-window/stage3d/mount.js", "packages/stage/frame/stage.html", "packages/stage/frame/stage.js", "packages/stage/frame/leds.js", "packages/stage/frame/scene/bar.trd", "packages/stage/frame/scene/bar.json", "packages/stage/frame/player/LICENSE", "packages/stage/frame/player/THIRD_PARTY_NOTICES.md", "packages/stage/frame/player/tride-web/tride-web.js", "packages/stage/frame/player/filament/filament.wasm"]) {
    assert.ok(files.includes(needed), needed);
  }
  for (const f of files) assert.doesNotMatch(f, /^packages\/stage\/(?!frame\/)/, f);
  for (const f of files) {
    assert.doesNotMatch(f, /(^|\/)test\/|\.test\.mjs$/, f);
    assert.doesNotMatch(f, /^packages\/engine\/(native\/|patches\.mjs|build\.mjs|test\/)/, f);
    assert.doesNotMatch(f, /test-support\.mjs$|^packages\/server\/capture\/png-bench\.mjs$/, f);
    // The examples: whole projects, without the maintainers' drawing tools and the folder's own README.
    assert.doesNotMatch(f, /^examples\/(tools\/|[^/]+$)/, f);
  }
  assert.deepEqual(emulatorProblems({ files, expected: files }), []);
  // The rules, on a made-up tree: a test's own data is a test, whatever its name.
  const made = emulatorFiles({
    list: (folder) =>
      path.basename(folder) === "server"
        ? ["index.mjs", "cli/test/fixture.json", "test/data.bin", "x.test.mjs", "capture/png.mjs", "capture/catalog-png.mjs", "capture/png.test.mjs", "capture/catalog-png.test.mjs", "capture/catalog-test-support.mjs", "capture/png-bench.mjs", "readiness/catalog-registry.json", "readiness/check.mjs", "readiness/test/check.test.mjs", "readiness/README.md", "cli/README.md"]
        : path.basename(folder) === "examples"
          ? ["README.md", "tools/make-art.py", "clock/README.md", "clock/src/main.ts"]
          : path.basename(folder) === "stage"
            ? ["README.md", "versions.json", "scene-build/build_glb.py", "test/files.test.mjs", "frame/stage.html", "frame/player/LICENSE"]
            : ["firmware.json", "checks.mjs", "programs.mjs", "build.mjs", "patches.mjs", "native/host.c", "test/a.test.mjs", "build/1.3.1/screen.wasm", "build/obj/x.o", "apps-assets.json"],
  });
  assert.deepEqual(made, ["examples/clock/README.md", "examples/clock/src/main.ts", "packages/engine/build/1.3.1/screen.wasm", "packages/engine/checks.mjs", "packages/engine/firmware.json", "packages/engine/programs.mjs", "packages/server/capture/catalog-png.mjs", "packages/server/capture/png.mjs", "packages/server/index.mjs", "packages/server/readiness/catalog-registry.json", "packages/server/readiness/check.mjs", "packages/stage/frame/player/LICENSE", "packages/stage/frame/stage.html"]);
  const found = emulatorProblems({ files: [...files, "packages/engine/native/host.c", "packages/server/cli/test/x.test.mjs"], expected: [...files, "packages/engine/native/host.c", "packages/server/cli/test/x.test.mjs"] }).join("\n");
  assert.match(found, /build source of the engine: emulator\/packages\/engine\/native\/host.c/);
  assert.match(found, /a test: emulator\/packages\/server\/cli\/test\/x.test.mjs/);
});

test("Info.plist names the app, records the archive, and drops the descriptions of access and the open network exception", () => {
  const stock = { CFBundleName: "Electron", CFBundleIdentifier: "com.github.Electron", NSCameraUsageDescription: "x", NSMicrophoneUsageDescription: "x", NSBluetoothAlwaysUsageDescription: "x", NSAudioCaptureUsageDescription: "x", NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }, ElectronAsarIntegrity: { "Resources/default_app.asar": {} }, LSMinimumSystemVersion: "13.0" };
  const release = appInfoPlist(stock, { version: "1.2.3", headerHash: "ab", kind: "release" });
  assert.equal(release.CFBundleIdentifier, "app.busy.emulator");
  assert.equal(release.CFBundleExecutable, "BUSY Bar Emulator");
  assert.equal(release.CFBundleShortVersionString, "1.2.3");
  assert.deepEqual(release.ElectronAsarIntegrity, { "Resources/app.asar": { algorithm: "SHA256", hash: "ab" } });
  assert.equal(release.LSMinimumSystemVersion, "13.5", "the bundled Node needs macOS 13.5, Electron alone 13.0");
  for (const key of Object.keys(release)) assert.doesNotMatch(key, /UsageDescription$|^NSAppTransportSecurity$|^LSUIElement$/);
  const testVariant = appInfoPlist(stock, { version: "1.2.3", headerHash: "ab", kind: "test" });
  assert.equal(testVariant.LSUIElement, true);
  assert.notEqual(testVariant.CFBundleIdentifier, "app.busy.emulator");
  assert.equal(helperInfoPlist({ CFBundleName: "Electron Helper (GPU)" }, { name: "BUSY Bar Emulator Helper (GPU)", kind: "release" }).CFBundleExecutable, "BUSY Bar Emulator Helper (GPU)");
});

test("SHA256SUMS is written only for a whole release, and the check finds a changed, a missing and a foreign file", async () => {
  const release = path.join(folder, "release");
  mkdirSync(release, { recursive: true });
  const files = ALL_RELEASE_FILES.filter((n) => n !== "SHA256SUMS");
  for (const name of files.slice(1)) writeFileSync(path.join(release, name), name);
  await assert.rejects(writeSums(release), /not a whole release: missing/);
  writeFileSync(path.join(release, files[0]), files[0]);
  const lines = await writeSums(release);
  assert.equal(lines.length, files.length);
  assert.match(readFileSync(path.join(release, "SHA256SUMS"), "utf8"), /^[0-9a-f]{64} {2}busybar-emulator-mac-arm64\.dmg\n/);
  assert.deepEqual(await checkSums(release), []);
  writeFileSync(path.join(release, files[1]), "changed");
  assert.deepEqual(await checkSums(release), [`${files[1]} does not match its line in SHA256SUMS`]);
  writeFileSync(path.join(release, files[1]), files[1]);
  writeFileSync(path.join(release, "busybar-emulator-0.1.0-mac-arm64.zip"), "a versioned name");
  assert.deepEqual(await checkSums(release), ["not a file of the release: busybar-emulator-0.1.0-mac-arm64.zip"]);
  await assert.rejects(writeSums(release), /not a file of the release/);
});

test("the payload zip is the same bytes every time, reads back, and refuses names that leave the folder or collide on Windows", () => {
  const entries = [
    { name: "BUSY Bar Emulator.exe", bytes: Buffer.from("exe") },
    { name: "resources/app.asar", bytes: Buffer.alloc(10000, 7) },
    { name: "resources/Γειά.txt", bytes: Buffer.from("non-Latin name") },
  ];
  const a = path.join(folder, "a.zip");
  const b = path.join(folder, "b.zip");
  writeZip(a, entries);
  writeZip(b, entries);
  assert.ok(readFileSync(a).equals(readFileSync(b)));
  const zip = openZip(a);
  try {
    assert.deepEqual(zip.entries.map((e) => e.name), entries.map((e) => e.name));
    for (const e of entries) assert.ok(zip.read(e.name).equals(e.bytes));
  } finally {
    zip.close();
  }
  for (const bad of ["../x", "a/../../x", "/abs", "a\\b", "a//b"]) assert.throws(() => writeZip(path.join(folder, "bad.zip"), [{ name: bad, bytes: Buffer.from("") }]), /Not a name/);
  assert.throws(() => writeZip(path.join(folder, "case.zip"), [{ name: "app.asar", bytes: Buffer.from("") }, { name: "App.Asar", bytes: Buffer.from("") }]), /Twice/);
});

test("the trailer of setup.exe is found and checked; the installer's version is one it can compile", () => {
  const payload = Buffer.from("PK payload");
  const trailer = Buffer.alloc(TRAILER_BYTES);
  // A wrong sum: found, not intact.
  trailer.writeBigUInt64LE(BigInt(payload.length), 32);
  trailer.write(PAYLOAD_MAGIC, 40, "ascii");
  const file = path.join(folder, "setup.exe");
  writeFileSync(file, Buffer.concat([Buffer.from("MZ stub"), payload, trailer]));
  const found = payloadOf(file);
  assert.equal(found.offset, 7);
  assert.equal(found.length, payload.length);
  assert.equal(found.intact, false);
  writeFileSync(file, Buffer.from("MZ stub without a payload, long enough to hold a trailer of forty-eight bytes"));
  assert.throws(() => payloadOf(file), /no payload of ours/);
  assert.deepEqual(windowsVersion("0.1.2"), [0, 1, 2, 0]);
  assert.throws(() => installerInfoSource('1.0"; evil'), /Not a version/);
});

test("setup.exe's version information: the product, the company, a description and the app's version, which dist check asserts (the release dry run)", async () => {
  // What the C# compiler makes of the assembly attributes in the generated source.
  const source = installerInfoSource("0.1.0-beta.1");
  for (const line of ['[assembly: AssemblyTitle("BUSY Bar Emulator Setup")]', '[assembly: AssemblyCompany("Flipper FZCO")]', '[assembly: AssemblyProduct("BUSY Bar Emulator")]', '[assembly: AssemblyFileVersion("0.1.0.0")]', '[assembly: AssemblyVersion("0.1.0.0")]', '[assembly: AssemblyInformationalVersion("0.1.0-beta.1")]']) assert.ok(source.includes(line), line);
  assert.match(source, /\[assembly: AssemblyDescription\("[^"]+"\)\]/);
  // The version information as the compiler writes it (language 0, Unicode), read back from an executable by resedit.
  const ResEdit = await import("resedit");
  const versioned = (strings, numbers) => {
    const executable = ResEdit.NtExecutable.createEmpty(false, false);
    const resources = ResEdit.NtExecutableResource.from(executable);
    const info = ResEdit.Resource.VersionInfo.createEmpty();
    info.setFileVersion(...numbers, 0);
    info.setStringValues({ lang: 0, codepage: 1200 }, strings);
    info.outputToResourceEntries(resources.entries);
    resources.outputResource(executable);
    const read = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(executable.generate()));
    return ResEdit.Resource.VersionInfo.fromEntries(read.entries)[0];
  };
  const good = versioned({ Comments: "Installs and removes BUSY Bar Emulator.", CompanyName: "Flipper FZCO", FileDescription: "BUSY Bar Emulator Setup", FileVersion: "0.1.0.0", ProductName: "BUSY Bar Emulator", ProductVersion: "0.1.0-beta.1" }, [0, 1, 0]);
  assert.deepEqual(setupVersionProblems(good, "0.1.0-beta.1").problems, []);
  assert.deepEqual(setupVersionProblems(good).problems, []);
  assert.deepEqual(setupVersionProblems(good, "0.2.0").problems, ['the installer\'s ProductVersion is "0.1.0-beta.1", the app\'s "0.2.0"', "the installer's file version is 0.1.0.0, expected 0.2.0.0"]);
  // The dry run's setup.exe: the compiler's defaults, no names, 0.0.0.0.
  const empty = versioned({ FileDescription: " ", FileVersion: "0.0.0.0", LegalCopyright: " ", OriginalFilename: "setup-stub.exe", ProductVersion: "0.0.0.0" }, [0, 0, 0]);
  assert.deepEqual(setupVersionProblems(empty, "0.1.0-beta.1").problems, [
    'the installer\'s ProductName is null, expected "BUSY Bar Emulator"',
    'the installer\'s CompanyName is null, expected "Flipper FZCO"',
    'the installer\'s FileDescription is " ", expected "BUSY Bar Emulator Setup"',
    "the installer's version information has no description (Comments)",
    'the installer\'s ProductVersion is "0.0.0.0", the app\'s "0.1.0-beta.1"',
    "the installer's file version is 0.0.0.0, expected 0.1.0.0",
  ]);
  assert.match(setupVersionProblems(empty).problems.join("\n"), /ProductVersion is "0\.0\.0\.0"/);
  assert.deepEqual(setupVersionProblems(undefined).problems, ["the installer has no version information"]);
});

test("a file git ignores in the app's folder is never packed, whatever lies there", () => {
  const app = path.join(folder, "ignored-app");
  mkdirSync(path.join(app, "src"), { recursive: true });
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", main: "src/main.mjs", files: ["src"] }));
  writeFileSync(path.join(app, "src", "main.mjs"), "// main\n");
  writeFileSync(path.join(app, "src", "notes.log"), "a log of the owner's\n");
  writeFileSync(path.join(app, "src", "secret.txt"), "a local secret\n");
  writeFileSync(path.join(app, ".gitignore"), "*.log\nsrc/secret.txt\n");
  execProgram("git", ["init", "-q", app]);
  const names = archiveEntries({ kind: "release", marker: markerBytes("release"), appDir: app }).map((e) => e.name);
  assert.deepEqual(names, ["build.json", "package.json", "src/main.mjs"]);
});

test("the marker of a build names its commit; a malformed one is refused", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(JSON.parse(markerBytes("release", commit)).commit, commit);
  assert.equal(JSON.parse(markerBytes("test")).commit, undefined);
  assert.throws(() => markerBytes("release", "HEAD"), /Not a commit/);
});

test("a release is never built from a working tree with changes: --allow-uncommitted is for the test variant", async () => {
  await assert.rejects(build({ kind: "release", out: path.join(folder, "out-uncommitted"), allowUncommitted: true }), /built from a commit only/);
});

test("a release is not built under the version 0.0.0, and the refusal says how to set one; the test variant builds under any", async () => {
  // Whatever the tree's version is today, a release named 0.0.0 stops before anything is built or looked at.
  const refusal = await build({ kind: "release", out: path.join(folder, "out-unset-version"), version: "0.0.0" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(refusal, "a release was built under 0.0.0");
  assert.match(refusal.message, /The version in packages\/app\/package\.json is 0\.0\.0: a release is not built under it/);
  assert.match(refusal.message, /npm --prefix packages\/app version <version> --no-git-tag-version/);
  assert.match(refusal.message, /docs\/release\.md/);
  assert.equal(existsSync(path.join(folder, "out-unset-version")), false);
  assert.equal(UNSET_VERSION, "0.0.0");
  assert.throws(() => checkReleaseVersion("release", "0.0.0"), /a release is not built under it/);
  // A version of its own passes, a beta's as well; the test variant passes with any, 0.0.0 included.
  for (const version of ["0.1.0-beta.1", "0.1.0", "1.0.0"]) assert.doesNotThrow(() => checkReleaseVersion("release", version), version);
  for (const version of ["0.0.0", "0.1.0-beta.1"]) assert.doesNotThrow(() => checkReleaseVersion("test", version), version);
  // The tree's own version is what a build is made under: 0.0.0 until a release is named, and then the build of a
  // release must take it.
  const own = appVersion();
  assert.equal(own, JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version);
  if (own === UNSET_VERSION) {
    await assert.rejects(build({ kind: "release", out: path.join(folder, "out-unset-version") }), /a release is not built under it/);
  } else {
    assert.doesNotThrow(() => checkReleaseVersion("release", own));
  }
  // No build goes on under a version that is not package.json's.
  await assert.rejects(build({ kind: "test", out: path.join(folder, "out-other-version"), allowUncommitted: true, version: "9.9.9-not-this-tree" }), /takes its version from package\.json/);
  assert.equal(existsSync(path.join(folder, "out-other-version")), false);
});

test("both programs compiled for Windows make System32 the only folder for DLLs by name, as the first thing in Main", () => {
  // The setup runs from the Downloads folder, where a DLL may have been put beside it (EMU-203 security review, S2).
  for (const source of ["installer/windows/setup.cs", "launcher/windows/busy-emulator.cs"]) {
    const text = readFileSync(path.join(APP_DIR, ...source.split("/")), "utf8");
    const main = /static int Main\(\)\s*\{([\s\S]*?);/.exec(text.replace(/^\s*\/\/.*$/gm, ""));
    assert.ok(main, `${source} has a Main`);
    assert.match(main[1], /SetDefaultDllDirectories\(LOAD_LIBRARY_SEARCH_SYSTEM32\)$/, `${source}: the first statement of Main`);
    assert.match(text, /LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800;/);
  }
});

test("the build refuses an output folder inside the repository, before it builds anything", async () => {
  const root = repositoryRoot();
  assert.equal(insideFolder(path.join(root, "emulator", "dist"), root), true);
  assert.equal(insideFolder(path.join(folder, "out"), root), false);
  await assert.rejects(build({ out: path.join(APP_DIR, "dist-out"), allowUncommitted: true }), /inside the repository/);
});

// A release is built from the exported tree (docs/release.md in the internal repository): that tree is a repository
// of its own, with one commit that the internal repository never had. What the build records — the marker, the
// license summary — is the internal commit the export was made from, as the export's record says.
test("a build in the exported tree records the commit the export was made from, not the tree's own", () => {
  const tree = path.join(folder, "exported");
  mkdirSync(path.join(tree, "packages", "app"), { recursive: true });
  const git = (...args) => execProgram("git", ["-C", tree, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const dirs = { emulatorDir: tree, appDir: path.join(tree, "packages", "app") };
  git("init", "-q");
  writeFileSync(path.join(tree, "packages", "app", "package.json"), "{}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "a tree without the record");
  const own = git("rev-parse", "HEAD").trim();
  assert.equal(sourceCommit(dirs), own, "without the export's record the build records HEAD");

  const from = "0123456789abcdef0123456789abcdef01234567";
  writeFileSync(path.join(tree, EXPORT_RECORD), JSON.stringify({ format: 1, from, files: [] }));
  assert.throws(() => sourceCommit(dirs), /not committed/, "a record that is not committed is refused");
  git("add", "-A");
  git("commit", "-q", "-m", "export");
  assert.notEqual(git("rev-parse", "HEAD").trim(), from);
  assert.equal(sourceCommit(dirs), from);

  writeFileSync(path.join(tree, EXPORT_RECORD), JSON.stringify({ format: 1, from: "f".repeat(40), files: [] }));
  assert.throws(() => sourceCommit(dirs), /changed or not committed/, "a changed record is refused");
  writeFileSync(path.join(tree, EXPORT_RECORD), JSON.stringify({ format: 1, files: [] }));
  git("add", "-A");
  git("commit", "-q", "-m", "a record without a commit");
  assert.throws(() => sourceCommit(dirs), /names no commit/);
});
