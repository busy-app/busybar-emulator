// The firmware hints of `check` (EMU-321, ../firmware-hints.mjs) on fixture projects: code that uses what only a newer
// firmware has with a lower api_version, and an api_version newer than anything the code was found to use. Only the
// code that goes into the package counts, without comments and strings. The boundary comes from this emulator's
// firmware builds, never from a number written here.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { compareApi, firmwaresHere } from "../../cli/firmware.mjs";
import { loadCommands, main } from "../../cli/busy-emulator.mjs";
import { featureUses, firmwareHints, splitCode } from "../firmware-hints.mjs";

const here = await firmwaresHere();
const byApi = [...here.firmwares].filter((one) => one.available).sort((a, b) => compareApi(a.api, b.api));
const OLDEST = byApi[0];
const NEWEST = byApi.at(-1);
// The command's own path in this system's form, where install puts it; the texts name it as this system's shells
// take it: on Windows a path without spaces in the form PowerShell, cmd and Git Bash all take (cli/output.mjs pasteForms).
const WINDOWS = process.platform === "win32";
const CLI = WINDOWS ? "C:\\Users\\you\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe" : "/Users/you/.busy-emulator/bin/busy-emulator";
const CLI_SAID = WINDOWS ? "C:/Users/you/AppData/Local/busy-emulator/bin/busy-emulator.exe" : CLI;

/** A project in a temporary folder: package.json, the manifest with `api`, and `files` of code. */
function fixture(t, api, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "busy-hints-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { build: "busy-cli build" }, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ format_version: 1, id: "app.you.hints", name: "Hints", version: "1.0.0", api_version: api }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

const hintsOf = (dir, api) => firmwareHints({ dir, api, manifest: "src/appmeta/manifest.json", firmwares: here.firmwares, cli: CLI });

test("the builds of this emulator say where /api/storage and console.warn begin: 1.4.1's API, not 1.3.1's", () => {
  const info = (version) => here.firmwares.find((one) => one.version === version).info;
  assert.equal(Object.hasOwn(info("1.3.1").appAllowlist, "storage"), false);
  assert.equal(info("1.3.1").consoleSeverities.includes("warn"), false);
  assert.equal(Object.hasOwn(info("1.4.1").appAllowlist, "storage"), true);
  assert.equal(info("1.4.1").consoleSeverities.includes("warn"), true);
});

test("not app code (review of PR 193): a Node build script, a test, a trailing comment, a string, a block comment opened mid-line", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hints-review-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const sub of ["src", "scripts", "test"]) mkdirSync(path.join(dir, sub));
  writeFileSync(path.join(dir, "src", "main.ts"), 'const a = 1; // console.warn is not in 1.3.1\nconst s = "see /api/storage";\nlog(); /* start\n console.warn(x)\n*/\n');
  writeFileSync(path.join(dir, "scripts", "build.mjs"), 'console.warn("node build script");\n');
  writeFileSync(path.join(dir, "test", "main.test.ts"), 'console.warn("in a test");\n');
  assert.deepEqual(featureUses(dir), { app_storage: [], console_warn: [] });
});

test("only the package's code: src/ and shared/, not their tests, scripts, tools or node_modules, nor the project's top", (t) => {
  const dir = fixture(t, OLDEST.api, {
    "src/main.ts": 'console.warn("hot");\n',
    "src/main.test.ts": 'console.warn("a test");\n',
    "src/clock.spec.js": 'console.warn("a spec");\n',
    "src/__tests__/a.ts": 'console.warn("a test");\n',
    "src/scripts/gen.mjs": 'console.warn("a script");\n',
    "shared/store.ts": 'export const read = () => device.StorageRead({ path: "/ext/data/a" });\n',
    "shared/tools/x.ts": 'console.warn("a tool");\n',
    "scripts/build.mjs": 'console.warn("a build script");\n',
    "tools/x.mjs": 'fetch("http://localhost/api/storage/list");\n',
    "test/a.test.ts": 'console.warn("a test");\n',
    "vite.config.ts": 'console.warn("config");\n',
    "node_modules/@busy-app/busy-lib/dist/storage.js": "fetch('/api/storage/list'); console.warn('x');\n",
    "types/env.d.ts": "declare const console: { warn(...a: unknown[]): void };\n",
  });
  assert.deepEqual(featureUses(dir), { app_storage: [{ file: "shared/store.ts", line: 1 }], console_warn: [{ file: "src/main.ts", line: 1 }] });
});

test("comments and strings are left out; a string that is the storage API's path or URL counts, in quotes or a template", () => {
  const text = [
    'const url = "http://localhost/api/storage/write?path=/ext/data/a";', // 1: a URL of the API
    "await fetch(`http://localhost/api/storage/read?path=${encodeURIComponent(p)}`);", // 2: a template, with ${…}
    "const prose = 'see /api/storage for files';", // 3: prose, not a path
    "log(`console.warn ${x}`); // console.warn", // 4: in a template and a comment
    "/* a block", // 5
    "   console.warn(1) */ const b = 2;", // 6: in the block
    "console.warn(`template ${a ? `in ${b}` : '}'} end`);", // 7: code, with nested templates
    'const q = "it\\"s console.warn";', // 8: an escaped quote in a string
  ].join("\n");
  const { code, strings } = splitCode(text);
  const lines = code.split("\n");
  assert.equal(lines.length, 8, "lines kept");
  assert.deepEqual(lines.map((line, i) => /console\s*\.\s*warn/.test(line) && i + 1).filter(Boolean), [7]);
  assert.ok(strings.some((one) => one.line === 1 && one.text === "http://localhost/api/storage/write?path=/ext/data/a"));
  assert.ok(strings.some((one) => one.line === 2 && one.text === "http://localhost/api/storage/read?path="));
  assert.ok(!/encodeURIComponent/.test(strings.map((one) => one.text).join(" ")), "a template's ${…} is code, not string");
  assert.match(lines[1], /encodeURIComponent\(p\)/);
});

test("code that uses console.warn or the app's /api/storage with the oldest firmware's api_version: a hint for each, with where", (t) => {
  const dir = fixture(t, OLDEST.api, {
    "src/main.ts": 'import { device } from "../shared/device";\n// console.warn only in a comment\n/* console.warn\n   in a block */\nconsole.warn("hot");\n',
    "shared/store.ts": 'export const save = () => fetch("http://localhost/api/storage/write?path=/ext/data/a", { method: "POST" });\nexport const read = () => device.StorageRead({ path: "/ext/data/a" });\n',
  });
  assert.deepEqual(featureUses(dir), { app_storage: [{ file: "shared/store.ts", line: 1 }, { file: "shared/store.ts", line: 2 }], console_warn: [{ file: "src/main.ts", line: 5 }] });
  const hints = hintsOf(dir, OLDEST.api);
  assert.deepEqual(hints.map((hint) => hint.id), ["needs_app_storage", "needs_console_warn"]);
  assert.equal(hints[0].message, `shared/store.ts:1, shared/store.ts:2 use /api/storage, which firmware ${OLDEST.version} lacks, but api_version is ${OLDEST.api}: the app installs on ${OLDEST.version} and fails there.`);
  const warn = hints[1];
  assert.equal(warn.message, `src/main.ts:5 uses console.warn, which firmware ${OLDEST.version} lacks, but api_version is ${OLDEST.api}: the app installs on ${OLDEST.version} and fails there.`);
  assert.equal(warn.fix, `set api_version to ${NEWEST.api} in src/appmeta/manifest.json, or do without console.warn.`);
  assert.deepEqual(warn.found, [{ file: "src/main.ts", line: 5, uses: "console.warn" }]);
  assert.deepEqual(hintsOf(dir, "27.0.0").map((hint) => hint.id), ["needs_app_storage", "needs_console_warn"], "lower still: the same");
  assert.deepEqual(hintsOf(dir, NEWEST.api), [], "with the api_version it needs: nothing to say");
});

test("an api_version newer than anything the code was found to use: lower api_version first, then try it on the older firmware", (t) => {
  const dir = fixture(t, NEWEST.api, { "src/main.ts": 'console.log("tick"); // console.warn later\n' });
  const hints = hintsOf(dir, NEWEST.api);
  assert.deepEqual(hints.map((hint) => hint.id), ["api_version_higher_than_needed"]);
  assert.equal(hints[0].message, `api_version is ${NEWEST.api}, but the code uses nothing only ${NEWEST.version} has (/api/storage, console.warn): BUSY Bars on ${OLDEST.version} refuse the app. A difference the code's text does not show, such as how fetch encodes a URL, may still need ${NEWEST.version}; a dependency's code is not read.`);
  assert.equal(hints[0].fix, `if it runs on ${OLDEST.version}, set api_version to ${OLDEST.api} in src/appmeta/manifest.json, then try it there:\n  ${CLI} firmware use ${OLDEST.alias}`);
  assert.deepEqual(hintsOf(fixture(t, OLDEST.api, { "src/main.ts": 'console.log("tick");\n' }), OLDEST.api), [], "the oldest firmware's api_version and plain code: nothing");
  assert.deepEqual(hintsOf(dir, "27.15"), [], "no api_version of three numbers: nothing to say from");
});

test("the boundary moves with the builds: a third firmware that brings console.warn later moves its hint", (t) => {
  const firmwares = [
    { version: "2.0.0", api: "28.0.0", alias: "latest", available: true, info: { consoleSeverities: ["log", "info", "warn", "error"], appAllowlist: { storage: "prefix" } } },
    { version: "1.9.0", api: "27.20.0", alias: "previous", available: true, info: { consoleSeverities: ["log", "info", "error"], appAllowlist: { storage: "prefix" } } },
  ];
  const dir = fixture(t, "27.20.0", { "src/main.ts": 'console.warn("x");\n' });
  const hints = firmwareHints({ dir, api: "27.20.0", manifest: "src/appmeta/manifest.json", firmwares, cli: CLI });
  assert.deepEqual(hints.map((hint) => [hint.id, hint.fix]), [["needs_console_warn", "set api_version to 28.0.0 in src/appmeta/manifest.json, or do without console.warn."]]);
  assert.match(hints[0].message, /which firmware 1\.9\.0 lacks/);
  // Storage used, at 28.0.0: storage needs only 27.20.0, so 28.0.0 is higher than needed.
  const store = fixture(t, "28.0.0", { "src/main.ts": 'fetch("http://localhost/api/storage/list?path=/ext/data");\n' });
  const higher = firmwareHints({ dir: store, api: "28.0.0", manifest: "src/appmeta/manifest.json", firmwares, cli: CLI });
  assert.deepEqual(higher.map((hint) => hint.id), ["api_version_higher_than_needed"]);
  assert.match(higher[0].message, /^api_version is 28\.0\.0, but the code uses nothing only 2\.0\.0 has \(console\.warn\): BUSY Bars on 1\.9\.0 refuse the app\./);
  assert.match(higher[0].fix, /set api_version to 27\.20\.0 .*\n {2}\S+ firmware use previous$/);
});

test("check --json carries the hints in firmware_hints and the text lists them under one header; they never fail the check", async (t) => {
  const dir = fixture(t, OLDEST.api, { "src/main.ts": 'console.warn("hot");\n' });
  const commands = await loadCommands();
  const ctx = { platform: process.platform, kind: "release", appPath: "/x", dataDir: path.join(dir, ".data"), runStateFile: path.join(dir, ".data", "run", "emulator.json"), calledAs: [CLI], env: {}, nodeTools: null };
  const sys = { cwd: () => dir };
  const run = async (json) => {
    const out = [];
    const err = [];
    await main(["check", dir, ...(json ? ["--json"] : [])], { ctx, sys, commands, out: (line) => out.push(line), err: (line) => err.push(line) });
    return { out: out.join("\n"), err: err.join("\n") };
  };
  const answer = JSON.parse((await run(true)).out);
  // The project is not built, so the catalog's checks fail; the hints are there all the same, and no check of theirs.
  assert.deepEqual(answer.firmware_hints.map((hint) => hint.id), ["needs_console_warn"]);
  assert.ok(!answer.failing.some((check) => check.id.startsWith("needs_")));
  const text = (await run(false)).err;
  assert.equal(text.split("Firmware hints").length, 2, "one header");
  assert.match(text, /\nFirmware hints, from reading the code's text \(they do not fail the check\):\n {2}src\/main\.ts:1 uses console\.warn, which firmware \S+ lacks, but api_version is \S+: the app installs on \S+ and fails there\.\n {4}Change: set api_version to \S+ in src\/appmeta\/manifest\.json, or do without console\.warn\.\n/);
  // The higher one names this command line, and its command on a line of its own.
  const high = fixture(t, NEWEST.api, { "src/main.ts": 'console.log("x");\n' });
  const out = [];
  await main(["check", high], { ctx, sys: { cwd: () => high }, commands, out: (line) => out.push(line), err: (line) => out.push(line) });
  assert.match(out.join("\n"), new RegExp(`\\n {4}Change: if it runs on \\S+, set api_version to \\S+ in src/appmeta/manifest\\.json, then try it there:\\n {6}${CLI_SAID.replace(/\./g, "\\.")} firmware use previous\\n`));
});
