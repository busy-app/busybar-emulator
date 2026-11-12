// The check of the produced files (tools/packaging/check.mjs) on real builds, without opening a window:
//
//   BUSY_EMULATOR_TEST_RELEASE=<out>/release   the files tools/dist.mjs built pass the check (on this system's own
//                                               files it also runs the bundled Node, the command line and the server;
//                                               before SHA256SUMS is written, only this system's files are expected)
//   BUSY_EMULATOR_TEST_BUILT=<test variant app> the test variant, packed under a release's name, fails it: the check
//                                               sees the test variant's folder, its marker, its Info.plist
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { checkRelease, resourcesProblems } from "../../tools/packaging/check.mjs";
import { machoArch, runsHere } from "../../tools/packaging/electron.mjs";
import { RELEASE_FILES, SUMS_FILE, targetOfHost, targetsBuiltOn } from "../../tools/packaging/names.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const RELEASE = process.env.BUSY_EMULATOR_TEST_RELEASE;
const BUILT = process.env.BUSY_EMULATOR_TEST_BUILT;
const host = targetOfHost();

let folder;
before(() => {
  folder = temporaryFolder();
});
after(async () => {
  await removeFolder(folder);
});

test("the built files of a release pass the check", { skip: !RELEASE && "BUSY_EMULATOR_TEST_RELEASE=<the release folder tools/dist.mjs built>" }, async () => {
  const result = await checkRelease({ folder: RELEASE, partial: !existsSync(path.join(RELEASE, SUMS_FILE)) });
  assert.deepEqual(result.problems, []);
  // Publishable (EMU-255): since the owner's decision of 11 Nov the firmware's local web ships unchanged under
  // GPL-2.0-or-later, and nothing the export check refuses is left in the app. The list is pinned empty, so any file
  // the export check closes fails here; that the gate still closes such files is shown by
  // test/unit/publication-gate.test.mjs, which plants them.
  // Without the export check's private patterns (they live on the owner's Mac only) the answer is "not checked",
  // never "publishable"; what the rules find without them is still listed.
  // In the public tree (npm run release, stage 3) the export check itself is not there.
  if (!result.publication.checked) assert.match(result.publication.reasons.join(" "), /private patterns|export check is not here/);
  assert.deepEqual(result.publication.files, []);
  // Every file this system builds: on a Mac both architectures. Their programs run where this Mac runs them: its
  // own, and Intel's under Rosetta on Apple Silicon; a file that was read but not run says so.
  for (const target of targetsBuiltOn(host)) {
    for (const name of RELEASE_FILES[target]) {
      assert.ok(result.files[name], `${name} was checked`);
      assert.equal(result.files[name].wire, "000011001");
      if (!runsHere(target, host)) assert.match(result.files[name].skipped, /its programs were not run/, name);
    }
  }
  for (const name of targetsBuiltOn(host).filter((target) => runsHere(target, host)).flatMap((target) => RELEASE_FILES[target])) {
    assert.equal(result.files[name].run?.cli?.kind, "release", `${name}: the command line inside says it is a release`);
    assert.equal(result.files[name].run?.server?.ok, true, `${name}: the server inside answered`);
    assert.equal(result.files[name].resources?.publication?.files.length, 0, `${name}: nothing in it is closed for publication`);
  }
});

// Review of EMU-255: on a real built app, a changed license summary is refused (the unit test checks every way it can
// differ; this one, that the check of the app's resources looks at it).
test("a built app whose THIRD_PARTY_NOTICES.md is changed fails the check", { skip: (!RELEASE || process.platform !== "darwin") && "BUSY_EMULATOR_TEST_RELEASE=<the release folder>, on macOS" }, async () => {
  const to = path.join(folder, "notices");
  mkdirSync(to, { recursive: true });
  execFileSync("/usr/bin/ditto", ["-x", "-k", path.join(RELEASE, RELEASE_FILES[host][1]), to]);
  const resources = path.join(to, "BUSY Bar Emulator.app", "Contents", "Resources");
  assert.deepEqual((await resourcesProblems(resources, "darwin")).problems, []);
  appendFileSync(path.join(resources, "THIRD_PARTY_NOTICES.md"), "\nedited\n");
  assert.ok((await resourcesProblems(resources, "darwin")).problems.includes("resources/THIRD_PARTY_NOTICES.md differs from the license summary of the source"));
});

test("the test variant packed under a release's name fails the check", { skip: !BUILT && "BUSY_EMULATOR_TEST_BUILT=<the test variant tools/dist.mjs built>" }, async () => {
  const release = path.join(folder, "release");
  mkdirSync(release, { recursive: true });
  let name;
  if (process.platform === "darwin") {
    // Under the name of the architecture the test variant was built for: the check also compares that.
    name = RELEASE_FILES[`darwin-${machoArch(path.join(BUILT, "Contents", "MacOS", "BUSY Bar Emulator"))}`][1];
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", BUILT, path.join(release, name)]);
  } else {
    const { buildSetup } = await import("../../tools/packaging/windows.mjs");
    name = RELEASE_FILES["win32-x64"][0];
    const work = path.join(folder, "work");
    mkdirSync(work, { recursive: true });
    buildSetup({ appFolder: BUILT, work, out: path.join(release, name), version: "0.0.0" });
  }
  assert.deepEqual(readdirSync(release), [name]);
  const result = await checkRelease({ folder: release, partial: true });
  const found = result.problems.join("\n");
  assert.match(found, /app\.asar holds the test variant: test-variant\/hook\.mjs/);
  assert.match(found, /the marker in app\.asar says "test"/);
  assert.match(found, /resources\/build\.json says "test"/);
  if (process.platform === "darwin") assert.match(found, /Info\.plist has LSUIElement/);
});
