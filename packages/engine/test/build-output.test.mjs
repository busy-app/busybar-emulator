// What is committed in packages/engine/build: the modules, each firmware's local web and build-info.json, the app
// assets. These tests need neither emsdk nor a firmware checkout: they look at the output, not at how it is made.
//
//   node --test "packages/engine/test/*.test.mjs"      (from emulator/)

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { assetsProblems, filesIn, gitTreeId, readManifest } from "../checks.mjs";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(engine, "build");
const config = JSON.parse(readFileSync(join(engine, "firmware.json"), "utf8"));
const versions = Object.keys(config.versions);
const infoOf = (version) => JSON.parse(readFileSync(join(build, version, "build-info.json"), "utf8"));

// What only a build machine has in its paths. Put together here, so that this file holds none of them itself.
const sep = "/";
const MACHINE_PATHS = [
  ["", "Users", ""].join(sep),
  ["", "home", ""].join(sep),
  ["", "private", ""].join(sep),
  ["", "var", "folders"].join(sep),
  ["", "Volumes", ""].join(sep),
  ["", "tmp", ""].join(sep),
  ["", "opt", ""].join(sep),
  ["Library", "Caches"].join(sep),
  ["C:", "Users"].join("\\"),
  "ems" + "dk",
  // The build's work folders, whatever disk or folder they are on: <work>/src/<version>/..., <work>/gen/<version>/...
  // (a mapped path reads gen/furi/..., with no version in it), and the folder of the emulator's own sources.
  ...versions.flatMap((version) => ["src", "gen", "obj", "out"].flatMap((folder) => [`/${folder}/${version}/`, `\\${folder}\\${version}\\`])),
  ["", "engine", "native", ""].join(sep),
  ["", "engine", "native", ""].join("\\"),
].map((text) => Buffer.from(text));
// Emscripten's own file system, in the modules' JS, has a home folder and a temporary folder of these names on every
// machine.
const EMSCRIPTEN_OWN = [["", "home", "web_user"].join(sep), ["", "tmp", ""].join(sep) + '"', ["", "tmp", ""].join(sep) + "'", ["", "tmp"].join(sep) + '"'].map((text) => Buffer.from(text));
// In what the build itself writes (the modules and build-info.json; the local web and the assets are copies checked
// byte for byte elsewhere): a path with a drive letter, a path on a network share (two backslashes, the server, the
// share, then folders), and an absolute path to a C source or header.
const DRIVE_PATH = /(?<![A-Za-z0-9_$])[A-Za-z]:[\\/](?:[\w.+-]+[\\/])+[\w.+-]+/;
const SHARE_PATH = /(?<!\\)\\\\[\w.$-]+\\[\w.$-]+(?:\\[\w.+$-]+)+/;
const ABSOLUTE_SOURCE = /(?<![\w.+-])\/(?:[\w.+-]+\/)+[\w.+-]+\.[ch](?![\w.])/;
// The compiler's own stamp of the day and time of a build: __DATE__ and __TIME__ as C strings.
const COMPILER_DATE = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{4}/;

/** The files under build/ that the build writes or checks; its work folders (build/src, gen, obj, out) are not output. */
function outputFiles() {
  const folders = readdirSync(build, { withFileTypes: true }).filter((e) => e.isDirectory() && !["src", "gen", "obj", "out"].includes(e.name));
  return folders.flatMap((folder) => filesIn(join(build, folder.name)).map((f) => `${folder.name}/${f}`));
}

describe("the engine's build output", () => {
  test("holds no path of the machine it was built on", () => {
    const found = [];
    for (const file of outputFiles()) {
      const bytes = readFileSync(join(build, file));
      for (const needle of MACHINE_PATHS) {
        for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) {
          if (EMSCRIPTEN_OWN.some((own) => bytes.subarray(at, at + own.length).equals(own))) continue;
          found.push(`${file} @${at}: ${JSON.stringify(bytes.subarray(at, at + 60).toString("latin1"))}`);
          break;
        }
      }
      if (!/^[^/]+\/(runtime|screen)\.(mjs|wasm)$|build-info\.json$/.test(file)) continue;
      const text = bytes.toString("latin1");
      for (const pattern of [DRIVE_PATH, SHARE_PATH, ABSOLUTE_SOURCE]) {
        const match = pattern.exec(text);
        if (match) found.push(`${file} @${match.index}: ${JSON.stringify(match[0].slice(0, 80))}`);
      }
    }
    assert.deepEqual(found, []);
  });

  test("holds no day or time of the build", () => {
    const found = [];
    for (const file of outputFiles().filter((f) => /\.(wasm|mjs)$/.test(f) && !f.includes("/web/"))) {
      const match = COMPILER_DATE.exec(readFileSync(join(build, file)).toString("latin1"));
      if (match) found.push(`${file} @${match.index}: ${match[0]}`);
    }
    assert.deepEqual(found, []);
    // The build makes the compiler refuse the macros that would bring one in.
    const flags = /const common = \[(.*?)\n\];/s.exec(readFileSync(join(engine, "build.mjs"), "utf8"))[1];
    assert.match(flags, /"-Wno-everything",[^]*"-Wdate-time",\s*"-Werror=date-time"/, "-Werror=date-time has to come after -Wno-everything");
  });

  for (const version of versions) {
    describe(`firmware ${version}`, () => {
      const info = infoOf(version);

      test("is built from the commit firmware.json names, optimized, with the compiler firmware.json names", () => {
        assert.equal(info.version, version);
        assert.equal(info.commit, config.versions[version].commit);
        assert.equal(info.firmware, config.versions[version].commit.slice(0, 8));
        assert.equal(info.optimized, true, "a --debug build keeps the build machine's paths and is not for committing");
        assert.equal(info.emscripten, config.emscripten);
        assert.match(info.api, /^\d+\.\d+\.\d+$/);
      });

      test("reports a build date that is a date of the firmware, the same in build-info.json and in the module", () => {
        assert.match(info.buildDate, /^20\d\d-\d\d-\d\d$/);
        assert.ok(info.screenDefines.includes(`EMU_FW_BUILD_DATE="${info.buildDate}"`), "the screen module was not compiled with this date");
        assert.ok(readFileSync(join(build, version, "screen.wasm")).includes(Buffer.from(`${info.buildDate}\0`)), "the date is not in screen.wasm");
      });

      test("has both modules", () => {
        for (const file of ["runtime.mjs", "runtime.wasm", "screen.mjs", "screen.wasm"]) assert.ok(statSync(join(build, version, file)).size > 0, file);
      });

      test("has the whole local web, byte for byte the firmware's tree", () => {
        const web = join(build, version, "web");
        const files = filesIn(web);
        assert.equal(files.length, info.web.files);
        assert.equal(files.reduce((sum, f) => sum + statSync(join(web, f)).size, 0), info.web.bytes);
        assert.equal(gitTreeId(web), info.web.tree);
      });
    });
  }

  test("the app assets are the files apps-assets.json lists, with the bytes it records", () => {
    assert.deepEqual(assetsProblems(readManifest(join(engine, "apps-assets.json")), join(build, "apps-assets")), []);
  });
});

describe("build.mjs", () => {
  test("checks the app assets before it builds or needs anything, and writes nothing when they are wrong", () => {
    // A copy of the build script with its list and assets, and nothing else: no firmware checkout, no compiler.
    const tmp = mkdtempSync(join(tmpdir(), "emu-engine-build-"));
    try {
      for (const file of ["build.mjs", "checks.mjs", "patches.mjs", "programs.mjs", "firmware.json", "apps-assets.json"]) cpSync(join(engine, file), join(tmp, "engine", file));
      cpSync(join(build, "apps-assets"), join(tmp, "engine/build/apps-assets"), { recursive: true });
      const run = () => spawnSync(process.execPath, [join(tmp, "engine/build.mjs"), "--emsdk", join(tmp, "no-emsdk"), "--firmware-repo", join(tmp, "no-firmware"), "--work", join(tmp, "work")], { encoding: "utf8", env: { ...process.env, EMSDK: "", PATH: "" } });

      // The assets as committed: the build gets past them and stops at the compiler it does not have.
      const whole = run();
      assert.equal(whole.status, 1);
      assert.match(whole.stderr, /Cannot run the Emscripten compiler/);
      assert.doesNotMatch(whole.stderr, /apps-assets/);

      // One file with other bytes, one that is not listed: the build stops there, before the compiler is looked for.
      const sound = join(tmp, "engine/build/apps-assets/shared/sounds/volume_change.snd");
      writeFileSync(sound, Buffer.concat([readFileSync(sound), Buffer.from([0])]));
      writeFileSync(join(tmp, "engine/build/apps-assets/shared/extra.bin"), "?");
      const wrong = run();
      assert.equal(wrong.status, 1);
      assert.match(wrong.stderr, /shared\/sounds\/volume_change\.snd does not have the bytes apps-assets\.json records/);
      assert.match(wrong.stderr, /shared\/extra\.bin is not in apps-assets\.json/);
      assert.match(wrong.stderr, /Nothing was built\./);
      assert.doesNotMatch(wrong.stderr, /Emscripten/);
      assert.deepEqual(readdirSync(join(tmp, "engine/build")), ["apps-assets"], "nothing but the assets in build/");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
