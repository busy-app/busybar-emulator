// The license summary of the app (tools/notices, EMU-255): it names every library the engine's build compiles into
// the modules, with the version and the license libraries.json records for each firmware build; it stops the build
// when libraries.json is older than what the build ships; its record of the firmware is what the firmware checkout
// says (when there is one here). No window, no network; the firmware checkout is only read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { noticesProblems, publicationFindings } from "../../tools/packaging/check.mjs";
import { ENGINE_DIR, firmwarePathsOfBuild } from "../../tools/notices/build-paths.mjs";
import { ASSETS_ATTRIBUTION, COPYRIGHT, EMULATOR_REPOSITORY, NOTICES_FILE, noticeSources, noticesText } from "../../tools/notices/notices.mjs";
import { CATALOGUE, libraryOf, parseReuse, pnpmRootVersions, reuseGlob, WEB_LICENSES, webDependencies } from "../../tools/notices/refresh.mjs";
import { APP_DIR } from "../helpers.mjs";

const NOTICES = path.join(APP_DIR, "tools", "notices");
const libraries = JSON.parse(readFileSync(path.join(NOTICES, "libraries.json"), "utf8"));
const firmware = JSON.parse(readFileSync(path.join(ENGINE_DIR, "firmware.json"), "utf8"));
const BUILD = readFileSync(path.join(ENGINE_DIR, "build.mjs"), "utf8");
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

test("every path build.mjs takes from the firmware is recorded for every firmware build, with its library", () => {
  const paths = firmwarePathsOfBuild();
  // The reading sees the libraries the build is known to compile (build.mjs, its header comment).
  for (const p of ["lib/jerryscript/amalgam/jerryscript.c", "lib/mongoose/mongoose.c", "lib/cjson/cJSON.c", "lib/stb/stb.c", "lib/lvgl/src/libs/lodepng", "lib/lvgl/src/libs/qrcode", "fbt_layers/core_libs/lib/utz/utz.c", "fbt_layers/core_libs/lib/datetime/datetime.c", "fbt_layers/core_libs/lib/mlib", "native/screen-assets"]) {
    assert.ok(paths.includes(p), `the reading of build.mjs misses ${p}`);
  }
  assert.deepEqual(Object.keys(libraries.firmware).sort(), Object.keys(firmware.versions).sort());
  for (const [v, record] of Object.entries(libraries.firmware)) {
    assert.equal(record.commit, firmware.versions[v].commit, `firmware ${v}`);
    assert.deepEqual(Object.keys(record.compiled).sort(), paths, `firmware ${v}: the paths libraries.json records are those build.mjs takes (run refresh.mjs)`);
    for (const [p, owner] of Object.entries(record.compiled)) {
      const lib = libraryOf(p);
      assert.equal(owner, lib ? lib.id : owner.startsWith("firmware") ? owner : "?", `firmware ${v}: ${p}`);
    }
  }
  // Every library of the catalogue is compiled; none is listed for nothing.
  const used = new Set(Object.values(libraries.firmware).flatMap((r) => Object.values(r.compiled)));
  for (const lib of CATALOGUE) assert.ok(used.has(lib.id), `${lib.id} is in the catalogue, and build.mjs takes nothing of it`);
});

test("the summary names every library compiled into the modules, its version, its commit and its license, per firmware", () => {
  for (const platform of ["darwin", "win32"]) {
    const text = noticesText({ platform, commit: COMMIT });
    for (const [v, record] of Object.entries(libraries.firmware)) {
      assert.ok(text.includes(`### Firmware ${v}`), `${platform}: firmware ${v}`);
      assert.ok(text.includes(record.commit), `${platform}: the commit of firmware ${v}`);
      const section = text.slice(text.indexOf(`### Firmware ${v}`)).split(/\n### Firmware |\n## /)[0];
      for (const id of new Set(Object.values(record.compiled))) {
        if (id.startsWith("firmware")) continue;
        const lib = libraries.libraries.find((l) => l.id === id);
        const entry = record.libraries[id];
        const row = section.split("\n").find((line) => line.startsWith(`| [${lib.name}]`));
        assert.ok(row, `${platform}, firmware ${v}: no row for ${lib.name}`);
        assert.ok(row.includes(lib.license ?? entry.license), `${platform}, firmware ${v}: the license of ${lib.name}`);
        if (entry.version) assert.ok(row.includes(` ${entry.version} `), `${platform}, firmware ${v}: the version of ${lib.name}`);
        assert.ok(row.includes(entry.commit.slice(0, 8)), `${platform}, firmware ${v}: the commit of ${lib.name}`);
      }
      assert.ok(section.includes(`[\`assets/frontend\`](${libraries.firmwareRepository}/tree/${record.commit}/assets/frontend)`), `${platform}, firmware ${v}: where the local web's source is`);
    }
    for (const want of [COPYRIGHT, "GPL-2.0-or-later", ASSETS_ATTRIBUTION, EMULATOR_REPOSITORY, `commit \`${COMMIT}\``, libraries.firmwareRepository, `Electron ${JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).devDependencies.electron}`, `Node.js ${JSON.parse(readFileSync(path.join(APP_DIR, "bundled-node.json"), "utf8")).version}`, `Emscripten ${firmware.emscripten}`, "GNU GENERAL PUBLIC LICENSE", "Apache License", "Attribution-ShareAlike 4.0", "SIL OPEN FONT LICENSE"]) {
      assert.ok(text.includes(want), `${platform}: the summary does not say ${want}`);
    }
    assert.doesNotMatch(text, /<year>|<copyright holders>/, `${platform}: a license template is left unfilled`);
  }
  const mac = noticesText({ platform: "darwin", commit: COMMIT });
  const win = noticesText({ platform: "win32", commit: COMMIT });
  assert.ok(mac.includes("BUSY Bar Emulator.app/Contents/Resources/LICENSES.chromium.html"));
  assert.ok(win.includes("`LICENSES.chromium.html`") && win.includes("resources\\node\\LICENSE"));
  assert.equal(noticesText({ platform: "darwin", commit: COMMIT }), mac, "the same inputs give the same bytes");
});

test("a library added to build.mjs without a refresh stops the summary, and so the build", () => {
  const added = BUILD.replace('join(fw, "lib/xpm/xpm.c"),', 'join(fw, "lib/xpm/xpm.c"),\n    join(fw, "lib/heatshrink/heatshrink_decoder.c"),');
  assert.notEqual(added, BUILD, "the test's change to build.mjs did not apply");
  assert.throws(() => noticeSources({ buildSource: added }), /lib\/heatshrink\/heatshrink_decoder\.c, which libraries\.json does not name/);
  // A folder the reading does not know is a stop too, not a path passed over.
  assert.throws(() => firmwarePathsOfBuild(BUILD.replace('join(fw, "lib/xpm/xpm.c")', 'join(somewhere, "lib/xpm/xpm.c")')), /a folder this reading does not know: somewhere/);
  assert.doesNotThrow(() => noticeSources());
});

test("REUSE.toml as the summary reads it: '*' stays in a folder, '**' crosses them, the last annotation wins", () => {
  assert.ok(reuseGlob("lib/*").test("lib/x.scons"));
  assert.ok(!reuseGlob("lib/*").test("lib/toolbox/x.c"));
  assert.ok(reuseGlob("lib/toolbox/**").test("lib/toolbox/a/b.c"));
  assert.ok(reuseGlob("assets/fonts/busy_*.ttf").test("assets/fonts/busy_bold_7px.ttf"));
  const annotations = parseReuse(`version = 1

[[annotations]]
path = [
    "assets/**",
    "lib/*",
]
SPDX-FileCopyrightText = "2024-2026 Flipper FZCO"
SPDX-License-Identifier = "GPL-2.0-or-later"

[[annotations]]
path = "assets/fonts/Inter.ttf"
SPDX-FileCopyrightText = ["2016 The Inter Project Authors"]
SPDX-License-Identifier = "OFL-1.1"
`);
  const of = (p) => annotations.filter((a) => a.paths.some((re) => re.test(p))).at(-1)?.license;
  assert.equal(of("assets/fonts/Inter.ttf"), "OFL-1.1");
  assert.equal(of("assets/images/x.png"), "GPL-2.0-or-later");
  assert.equal(of("lib/toolbox/x.c"), undefined);
});

test("the summary passes the export check: it may be published", async (t) => {
  if (!existsSync(path.join(APP_DIR, "..", "..", "tools", "export-check", "check.mjs"))) return t.skip("the export check lives in the monorepo");
  const tree = mkdtempSync(path.join(os.tmpdir(), "emu255-notices-"));
  try {
    for (const platform of ["darwin", "win32"]) {
      writeFileSync(path.join(tree, NOTICES_FILE), noticesText({ platform, commit: COMMIT }));
      const found = await publicationFindings(tree);
      assert.deepEqual(found.files, [], `${platform}: the export check finds something in the summary`);
    }
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

// The record is what the firmware says: with a firmware checkout and the Emscripten SDK here, refresh.mjs --check
// reads them again and compares (read-only: git show and git ls-tree).
const FIRMWARE = process.env.EMU_FIRMWARE_REPO ?? path.join(APP_DIR, "..", "..", "..", "busybar-firmware");
const EMSDK = process.env.EMSDK ?? path.join(os.homedir(), "emsdk");
const canRefresh = existsSync(path.join(FIRMWARE, ".git")) && existsSync(path.join(EMSDK, "upstream", "emscripten"));
test("libraries.json and texts/ are what the firmware checkout and the SDK say", { skip: !canRefresh && "needs a firmware checkout (EMU_FIRMWARE_REPO) and the Emscripten SDK (EMSDK)" }, () => {
  const out = execFileSync(process.execPath, [path.join(NOTICES, "refresh.mjs"), "--firmware-repo", FIRMWARE, "--emsdk", EMSDK, "--check"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(out, /as the firmware says/);
});

// Review of EMU-255, M1: the public repository is an export without history (ADR-0015), so the commit a release is
// built from (the internal repository's HEAD, sourceCommit()) never exists there. The GPL source offer must point to
// what the public repository will have: the release tag of this version.
test("the source the summary points to in the public repository can exist there: the release tag, not the build's commit", () => {
  const commit = execFileSync("git", ["-C", APP_DIR, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); // what the build records
  const version = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version;
  for (const platform of ["darwin", "win32"]) {
    const text = noticesText({ platform, commit });
    const named = [...text.matchAll(new RegExp(`${EMULATOR_REPOSITORY.replace(/[.]/g, "\\.")}[^\\n]{0,40}?([0-9a-f]{40})`, "g"))].map((m) => m[1]);
    assert.deepEqual(named, [], `${platform}: the summary names a commit of the public repository; the export has no commits of the repository a release is built from`);
    assert.ok(text.includes(`${EMULATOR_REPOSITORY}/tree/v${version}`), `${platform}: the summary points to the release tag v${version}`);
    assert.ok(text.includes(commit), `${platform}: the build's own commit is still named, as the internal one`);
  }
});

// Review of EMU-255: dist:check refuses a license summary that is not the one the build of the marker's commit makes —
// edited, missing, made for another commit or for the other system.
test("the release check refuses a changed, missing or stale THIRD_PARTY_NOTICES.md", () => {
  const resources = mkdtempSync(path.join(os.tmpdir(), "emu255-notices-check-"));
  try {
    const marker = { kind: "release", commit: COMMIT };
    const file = path.join(resources, NOTICES_FILE);
    const good = noticesText({ platform: "darwin", commit: COMMIT });
    writeFileSync(file, good);
    assert.deepEqual(noticesProblems(resources, "darwin", marker), []);
    const differs = [`resources/${NOTICES_FILE} differs from the license summary of the source`];
    writeFileSync(file, good.replace("| GPL-2.0-only |", "| MIT |"));
    assert.deepEqual(noticesProblems(resources, "darwin", marker), differs, "one license name changed");
    writeFileSync(file, `${good}\n`);
    assert.deepEqual(noticesProblems(resources, "darwin", marker), differs, "one byte added");
    writeFileSync(file, good);
    assert.deepEqual(noticesProblems(resources, "darwin", { ...marker, commit: "f".repeat(40) }), differs, "made for another commit");
    assert.deepEqual(noticesProblems(resources, "win32", marker), differs, "made for the other system");
    rmSync(file);
    assert.deepEqual(noticesProblems(resources, "darwin", marker), [`resources/${NOTICES_FILE} is missing`]);
  } finally {
    rmSync(resources, { recursive: true, force: true });
  }
});

// EMU-161: the local web's JavaScript libraries, with the version its lockfile resolves and the license checked for it.
const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@scope/lib':
        specifier: ^1.0.0
        version: 1.2.3(vue@3.5.21(typescript@5.9.2))
      plain:
        specifier: 2.0.0
        version: 2.0.0
    devDependencies:
      tool:
        specifier: ^5.0.0
        version: 5.1.0

  sub:
    dependencies:
      plain:
        specifier: 9.9.9
        version: 9.9.9

packages:

  plain@2.0.0:
    resolution: {integrity: sha512-x}
`;

test("the lockfile's versions are those of the root project, peers cut off, other importers not read", () => {
  assert.deepEqual(pnpmRootVersions(LOCK), { "@scope/lib": "1.2.3", plain: "2.0.0", tool: "5.1.0" });
  assert.deepEqual(pnpmRootVersions(LOCK.replace(/\n/g, "\r\n")), { "@scope/lib": "1.2.3", plain: "2.0.0", tool: "5.1.0" }, "CRLF too");
});

test("every library of the local web has a license checked for the version it is built with; otherwise refresh stops", () => {
  const fw = (pkg) => ({ read: (p) => (p.endsWith("package.json") ? JSON.stringify(pkg) : p.endsWith("pnpm-lock.yaml") ? LOCK : null) });
  const catalogue = { "@scope/lib": { version: "1.2.3", license: "MIT", upstream: "u1" }, plain: { version: "2.0.0", license: "Apache-2.0", upstream: "u2" }, tool: { version: "5.1.0", license: "MIT", upstream: "u3" } };
  const problems = [];
  const deps = webDependencies(fw({ dependencies: { plain: "2.0.0", "@scope/lib": "^1" }, devDependencies: { tool: "^5" } }), "1.3.1", problems, catalogue);
  assert.deepEqual(problems, []);
  assert.deepEqual(deps.map((d) => [d.name, d.kind, d.version, d.license]), [["@scope/lib", "dependencies", "1.2.3", "MIT"], ["plain", "dependencies", "2.0.0", "Apache-2.0"], ["tool", "devDependencies", "5.1.0", "MIT"]]);

  const stale = { ...catalogue, plain: { ...catalogue.plain, version: "1.9.0" } };
  const { tool: _t, ...missing } = catalogue;
  for (const [cat, pkg, message] of [
    [stale, { dependencies: { plain: "2.0.0" } }, /plain 2\.0\.0; WEB_LICENSES in refresh\.mjs checked the license of 1\.9\.0/],
    [missing, { devDependencies: { tool: "^5" } }, /tool 5\.1\.0, which WEB_LICENSES in refresh\.mjs does not name/],
    [catalogue, { dependencies: { absent: "1" } }, /resolves no version of absent/],
  ]) {
    const found = [];
    webDependencies(fw(pkg), "1.3.1", found, cat);
    assert.equal(found.length, 1, String(message));
    assert.match(found[0], message);
  }
  // What libraries.json records is what the catalogue says, for every firmware.
  for (const [v, record] of Object.entries(libraries.firmware)) {
    assert.ok(record.web.dependencies.length > 0, `firmware ${v}`);
    for (const d of record.web.dependencies) assert.deepEqual({ version: d.version, license: d.license, upstream: d.upstream }, WEB_LICENSES[d.name], `firmware ${v}: ${d.name}`);
  }
});

test("the summary of the source repository names where each built app keeps its license files", () => {
  const text = noticesText({ platform: "source" });
  assert.match(text, /root of the source repository, written by the export; every built app carries its own \(`BUSY Bar Emulator\.app\/Contents\/Resources\/THIRD_PARTY_NOTICES\.md` on macOS, `resources\\THIRD_PARTY_NOTICES\.md` on Windows\)/);
  assert.match(text, /Its license: `BUSY Bar Emulator\.app\/Contents\/Resources\/LICENSE` on macOS, `LICENSE` on Windows, in a built app\./);
  assert.match(text, /\| \[qr\]\(https:\/\/github\.com\/paulmillr\/qr\) \| 0\.5\.4 \| dependencies \| MIT OR Apache-2\.0 \|/);
});
