import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { bundlePathOf, checkAppLocation, onReadOnlyVolume } from "../../src/location-check.mjs";
import { mountReadOnlyImage, removeFolder, temporaryFolder } from "../helpers.mjs";

const plain = { platform: "darwin", homeDir: "/Users/you", readOnly: () => false, realpath: (p) => p };
const folders = [];
after(async () => {
  for (const folder of folders) await removeFolder(folder);
});

test("the bundle is the outermost .app of the executable's path", () => {
  assert.equal(bundlePathOf("/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator"), "/Applications/BUSY Bar Emulator.app");
  assert.equal(
    bundlePathOf("/Applications/BUSY Bar Emulator.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"),
    "/Applications/BUSY Bar Emulator.app",
  );
  assert.equal(bundlePathOf("/opt/tool/bin/tool"), "/opt/tool/bin");
});

test("an app in Applications passes", () => {
  assert.deepEqual(checkAppLocation({ ...plain, bundlePath: "/Applications/BUSY Bar Emulator.app" }), { ok: true });
  assert.deepEqual(checkAppLocation({ ...plain, bundlePath: "/Users/you/Applications/BUSY Bar Emulator.app" }), { ok: true });
});

test("a translocated app is told to move", () => {
  const bundlePath = "/tmp-root/T/AppTranslocation/0A1B2C3D-0000-4000-8000-123456789ABC/d/BUSY Bar Emulator.app";
  assert.deepEqual(checkAppLocation({ ...plain, bundlePath }), { ok: false, reason: "translocated", path: bundlePath });
});

test("an app on a read-only volume is told to move", () => {
  const bundlePath = "/mounted-image/BUSY Bar Emulator.app";
  const result = checkAppLocation({ ...plain, bundlePath, readOnly: (p) => p === bundlePath });
  assert.deepEqual(result, { ok: false, reason: "read-only-volume", path: bundlePath });
  // The same place on a writable disk is an ordinary place.
  assert.deepEqual(checkAppLocation({ ...plain, bundlePath }), { ok: true });
});

test("an app in Downloads is told to move, a folder that only starts the same is not", () => {
  const inDownloads = "/Users/you/Downloads/unpacked/BUSY Bar Emulator.app";
  assert.deepEqual(checkAppLocation({ ...plain, bundlePath: inDownloads }), { ok: false, reason: "downloads", path: inDownloads });
  assert.deepEqual(checkAppLocation({ ...plain, bundlePath: "/Users/you/Downloads2/BUSY Bar Emulator.app" }), { ok: true });
});

test("other systems have no such check", () => {
  for (const platform of ["win32", "linux"]) {
    assert.deepEqual(checkAppLocation({ ...plain, platform, bundlePath: "/Users/you/Downloads/x" }), { ok: true });
  }
});

test("the real place counts: a link into Downloads does not hide it", { skip: process.platform === "win32" && "links need a privilege on Windows" }, () => {
  const root = temporaryFolder();
  folders.push(root);
  mkdirSync(path.join(root, "home", "Downloads", "Some.app"), { recursive: true });
  symlinkSync(path.join(root, "home", "Downloads", "Some.app"), path.join(root, "Linked.app"));
  const result = checkAppLocation({ platform: "darwin", bundlePath: path.join(root, "Linked.app"), homeDir: path.join(root, "home") });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "downloads");
});

test("a writable folder is not a read-only volume, and neither is a missing one", () => {
  const root = temporaryFolder();
  folders.push(root);
  assert.equal(onReadOnlyVolume(root), false);
  assert.equal(onReadOnlyVolume(path.join(root, "missing")), false);
});

test("macOS: a mounted read-only disk image is a read-only volume", { skip: process.platform !== "darwin" && "macOS only" }, (t) => {
  const root = temporaryFolder();
  folders.push(root);
  const image = mountReadOnlyImage(root, "Some.app");
  if (!image.app) return t.skip(image.why);
  try {
    assert.equal(onReadOnlyVolume(image.app), true);
    const result = checkAppLocation({ platform: "darwin", bundlePath: image.app, homeDir: path.join(root, "home") });
    assert.equal(result.reason, "read-only-volume");
  } finally {
    image.detach();
  }
});
