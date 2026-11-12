// A build on a nearly full disk (the release dry run, 11.11): hdiutil wrote a truncated disk image and ended with 0,
// and so did the build. The disk image is verified once made, and a macOS build starts only with the room it needs.
// No disk image is made here: hdiutil is a stand-in.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { build } from "../../tools/dist.mjs";
import { freeGigabytes, MIN_FREE_GB, MIN_FREE_GB_TEST, requireFreeSpace } from "../../tools/packaging/disk.mjs";
import { dmgApp } from "../../tools/packaging/macos.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

let folder;
before(() => {
  folder = temporaryFolder();
});
after(async () => {
  await removeFolder(folder);
});

/** A disk with `gb` gigabytes free, as statfs says it. */
const diskWith = (gb) => () => ({ bavail: Math.round((gb * 1e9) / 4096), bsize: 4096 });

test("free space: of the nearest folder that exists; less than the minimum is refused with both numbers", () => {
  assert.ok(freeGigabytes(path.join(folder, "not", "there", "yet")) > 0);
  assert.equal(Math.round(freeGigabytes(folder, { statfs: diskWith(3.5) }) * 10) / 10, 3.5);
  assert.throws(
    () => requireFreeSpace(folder, { minimum: MIN_FREE_GB, what: "a release build", statfs: diskWith(3.5) }),
    (e) => /^Only 3\.5 GB free on the disk of .*; a release build needs about 6 GB while it builds\. Free some space, then build again: on a full disk hdiutil writes a broken disk image\.$/.test(e.message),
  );
  assert.equal(Math.round(requireFreeSpace(folder, { minimum: MIN_FREE_GB, what: "a release build", statfs: diskWith(7) })), 7);
  assert.ok(MIN_FREE_GB_TEST < MIN_FREE_GB);
});

const RELEASE = new URL("../../../../tools/release/release.mjs", import.meta.url);
test("npm run release asks for the same room as the build", { skip: !existsSync(RELEASE) && "the release command lives in the monorepo: tools/ is not in the public tree" }, () => {
  const release = readFileSync(RELEASE, "utf8");
  // Its import of the helper, looked for by the module's name and the two names it takes.
  assert.ok(release.includes(["packaging", "disk.mjs"].join("/")) && /\{ freeGigabytes, MIN_FREE_GB \}/.test(release));
  assert.doesNotMatch(release, /const MIN_FREE_GB = /);
});

/** hdiutil and ditto as stand-ins: what they were asked, and a verify that answers as told. */
function programs({ verify = null } = {}) {
  const calls = [];
  const exec = (program, args) => {
    calls.push([path.basename(program), args[0]]);
    if (program.endsWith("hdiutil") && args[0] === "create") writeFileSync(args.at(-1), "a disk image");
    if (program.endsWith("hdiutil") && args[0] === "verify" && verify) throw Object.assign(new Error("Command failed"), { stderr: verify });
    return "";
  };
  return { calls, exec };
}

// A Mac's build: on Windows its link to /Applications needs a right a standard user's terminal does not have.
test("the disk image is verified once made; a broken one is removed and fails the build, with the free space", { skip: process.platform === "win32" && "a Mac's build" }, () => {
  const work = path.join(folder, "work");
  const app = path.join(folder, "BUSY Bar Emulator.app");
  const good = programs();
  const out = path.join(folder, "good.dmg");
  assert.equal(dmgApp(app, out, { work, exec: good.exec }), out);
  assert.deepEqual(good.calls, [["ditto", "--norsrc"], ["hdiutil", "create"], ["hdiutil", "verify"]]);
  assert.ok(existsSync(out));
  assert.equal(existsSync(path.join(work, "dmg")), false, "the image's folder is gone");

  const broken = programs({ verify: "hdiutil: verify: checksum of \"Apple_HFS\" failed\nhdiutil: verify failed - image data corrupted\n" });
  const bad = path.join(folder, "bad.dmg");
  assert.throws(
    () => dmgApp(app, bad, { work, exec: broken.exec, statfs: diskWith(0.4) }),
    (e) => {
      assert.match(e.message, /^The disk image bad\.dmg is broken: hdiutil verify says "hdiutil: verify failed - image data corrupted"\. 0\.4 GB is free on its disk now; hdiutil writes a broken image when the disk runs out of space while it writes\. Free some space \(a release needs about 6 GB\), then build again\.$/);
      return true;
    },
  );
  assert.equal(existsSync(bad), false, "the broken image is not left for a release");
});

test("a macOS build on a disk without room is refused before anything is built", { skip: process.platform !== "darwin" && "a Mac's build" }, async () => {
  const out = path.join(folder, "out-full-disk");
  await assert.rejects(build({ kind: "release", out, statfs: diskWith(1.2) }), /^Error: Only 1\.2 GB free on the disk of .*out-full-disk; a release build needs about 6 GB/);
  await assert.rejects(build({ kind: "test", out, allowUncommitted: true, statfs: diskWith(1.2) }), /a build of the test variant needs about 2 GB/);
  assert.equal(existsSync(out), false);
});
