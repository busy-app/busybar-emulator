// Release, test variant or development: the marker inside the app's archive decides, not the executable's name.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildKindOf, inSourceTree, readBuildMarker } from "../../src/build-kind.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

test("the marker's kind is the build's kind", () => {
  assert.equal(buildKindOf({ marker: { kind: "release" }, sourceTree: false }), "release");
  assert.equal(buildKindOf({ marker: { kind: "test" }, sourceTree: false }), "test");
  assert.equal(buildKindOf({ marker: { kind: "release" }, sourceTree: true }), "release");
});

test("without a marker only the source tree is development; any other app is a release (review H2, S3)", () => {
  assert.equal(buildKindOf({ marker: null, sourceTree: true }), "development");
  assert.equal(buildKindOf({ marker: null, sourceTree: false }), "release");
});

test("a marker that cannot be used makes a release, wherever the app is", () => {
  assert.equal(buildKindOf({ marker: { invalid: "x" }, sourceTree: true }), "release");
});

test("the source tree is told by the tree: packages/app beside packages/server; an app's folders are not it", () => {
  const appDir = path.resolve(import.meta.dirname, "..", "..");
  assert.equal(inSourceTree(appDir), true);
  assert.equal(inSourceTree("/x/BUSY Bar Emulator.app/Contents/Resources/app", () => true), false, "resources/app");
  assert.equal(inSourceTree("/x/emulator/packages/app.asar", () => true), false, "an archive");
  assert.equal(inSourceTree("/x/emulator/packages/app", () => false), false, "no server beside it");
});

test("the marker is read from the app's folder; a broken one is not trusted", async () => {
  const folder = temporaryFolder();
  try {
    assert.equal(readBuildMarker(folder), null);
    writeFileSync(path.join(folder, "build.json"), JSON.stringify({ kind: "test", version: "1.2.3", node: "24.22.2" }));
    assert.deepEqual(readBuildMarker(folder), { kind: "test", version: "1.2.3", node: "24.22.2" });
    writeFileSync(path.join(folder, "build.json"), JSON.stringify({ kind: "development" }));
    assert.ok(readBuildMarker(folder).invalid, "a marker cannot claim development");
    writeFileSync(path.join(folder, "build.json"), "{ not json");
    assert.ok(readBuildMarker(folder).invalid);
    const dir = path.join(folder, "as-folder");
    mkdirSync(path.join(dir, "build.json"), { recursive: true });
    assert.ok(readBuildMarker(dir).invalid, "a folder named like the marker");
  } finally {
    await removeFolder(folder);
  }
});

test("the source folder carries no marker: a run from it is development", () => {
  const appDir = path.resolve(import.meta.dirname, "..", "..");
  assert.equal(readBuildMarker(appDir), null);
  assert.equal(buildKindOf({ marker: readBuildMarker(appDir), sourceTree: inSourceTree(appDir) }), "development");
});
