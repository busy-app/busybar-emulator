// The pinned Node: the pin, the check of an archive against it, and what is unpacked from it (tools/bundled-node.mjs).
// No network: downloads are stand-ins, archives are made here with the system's tar.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { archiveName, DIST, fetchArchive, layoutOf, parseShasums, PIN_FILE, pinFrom, readPin, stageNode, systemTar, TARGETS, topFolder } from "../../tools/bundled-node.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SUMS = [
  `${"a".repeat(64)}  node-v24.1.2-darwin-arm64.tar.gz`,
  `${"b".repeat(64)}  node-v24.1.2-darwin-x64.tar.gz`,
  `${"c".repeat(64)}  node-v24.1.2-win-x64.zip`,
  `${"d".repeat(64)}  node-v24.1.2-linux-x64.tar.xz`,
].join("\n");

test("archive names are the ones nodejs.org publishes", () => {
  assert.equal(archiveName("24.22.2", "darwin-arm64"), "node-v24.22.2-darwin-arm64.tar.gz");
  assert.equal(archiveName("24.22.2", "win32-x64"), "node-v24.22.2-win-x64.zip");
  assert.equal(topFolder("24.22.2", "win32-x64"), "node-v24.22.2-win-x64");
  assert.equal(layoutOf("win32-x64").npmCli, "node_modules/npm/bin/npm-cli.js");
  assert.equal(layoutOf("darwin-arm64").node, "bin/node");
});

test("a pin takes the sums of the three archives from SHASUMS256.txt, and refuses a list that lacks one", () => {
  assert.deepEqual(pinFrom("24.1.2", SUMS), {
    version: "24.1.2",
    source: "https://nodejs.org/dist/v24.1.2/",
    archives: {
      "darwin-arm64": { file: "node-v24.1.2-darwin-arm64.tar.gz", sha256: "a".repeat(64) },
      "darwin-x64": { file: "node-v24.1.2-darwin-x64.tar.gz", sha256: "b".repeat(64) },
      "win32-x64": { file: "node-v24.1.2-win-x64.zip", sha256: "c".repeat(64) },
    },
  });
  assert.throws(() => pinFrom("24.1.2", SUMS.split("\n").slice(1).join("\n")), /names no node-v24\.1\.2-darwin-arm64\.tar\.gz/);
  assert.throws(() => pinFrom("v24", SUMS), /Not a Node version/);
  assert.equal(parseShasums("not a line\n  \n").size, 0);
});

test("the pinned version in the repository is Node 24, from nodejs.org, for every target", () => {
  const pin = readPin();
  assert.match(pin.version, /^24\./);
  assert.deepEqual(Object.keys(pin.archives).sort(), [...TARGETS].sort());
  assert.ok(pin.source.startsWith(DIST));
});

test("a pin file that does not say exactly what is needed is refused", async () => {
  const folder = temporaryFolder();
  try {
    const good = JSON.parse(readFileSync(PIN_FILE, "utf8"));
    const cases = [
      { ...good, source: "https://example.com/dist/" },
      { ...good, version: "24" },
      { ...good, archives: { ...good.archives, "win32-x64": { file: good.archives["win32-x64"].file, sha256: "x" } } },
      { ...good, archives: { ...good.archives, "darwin-arm64": { ...good.archives["darwin-arm64"], file: "node-v0.0.0-darwin-arm64.tar.gz" } } },
    ];
    for (const [i, bad] of cases.entries()) {
      const file = path.join(folder, `pin-${i}.json`);
      writeFileSync(file, JSON.stringify(bad));
      assert.throws(() => readPin(file), /bundled|source|version|archive/, `case ${i}`);
    }
  } finally {
    await removeFolder(folder);
  }
});

function pinFor(bytes, target = "darwin-arm64") {
  const version = "24.1.2";
  return { version, source: `${DIST}v${version}/`, archives: { [target]: { file: archiveName(version, target), sha256: sha(bytes) } } };
}

test("an archive is downloaded once into the cache, checked, and checked again every time it is used", async () => {
  const folder = temporaryFolder();
  try {
    const bytes = Buffer.from("the archive");
    const pin = pinFor(bytes);
    const asked = [];
    const download = async (url, file) => {
      asked.push(url);
      writeFileSync(file, bytes);
    };
    const file = await fetchArchive({ pin, target: "darwin-arm64", cacheDir: folder, download });
    assert.equal(file, path.join(folder, "node-v24.1.2-darwin-arm64.tar.gz"));
    assert.deepEqual(asked, ["https://nodejs.org/dist/v24.1.2/node-v24.1.2-darwin-arm64.tar.gz"]);
    await fetchArchive({ pin, target: "darwin-arm64", cacheDir: folder, download });
    assert.equal(asked.length, 1, "taken from the cache the second time");
    // A cached file that changed is refused and removed, not used.
    writeFileSync(file, "changed");
    await assert.rejects(fetchArchive({ pin, target: "darwin-arm64", cacheDir: folder, download: async () => assert.fail("no download for a file in the cache") }), /SHA-256 is .* the pin says/);
    assert.equal(existsSync(file), false);
  } finally {
    await removeFolder(folder);
  }
});

test("a download whose sum does not match is refused, and nothing of it is left", async () => {
  const folder = temporaryFolder();
  try {
    const pin = pinFor(Buffer.from("the real archive"));
    await assert.rejects(fetchArchive({ pin, target: "darwin-arm64", cacheDir: folder, download: async (_url, file) => writeFileSync(file, "a forged archive") }), /nothing was unpacked/);
    assert.deepEqual(readdirSync(folder), []);
    // A download that fails half way leaves no part file either.
    await assert.rejects(fetchArchive({ pin, target: "darwin-arm64", cacheDir: folder, download: async (_url, file) => (writeFileSync(file, "half"), Promise.reject(new Error("cut"))) }), /cut/);
    assert.deepEqual(readdirSync(folder), []);
    await assert.rejects(fetchArchive({ pin, target: "linux-arm64", cacheDir: folder }), /No pinned Node for linux-arm64/);
  } finally {
    await removeFolder(folder);
  }
});

/** A small archive shaped like Node's, made with the system's tar. */
function makeArchive(folder, { version = "24.1.2", target = "darwin-arm64", link = false, without = null } = {}) {
  const top = topFolder(version, target);
  const root = path.join(folder, "src", top);
  const layout = layoutOf(target);
  for (const name of [layout.node, layout.npmCli, layout.license, "include/node/node.h", "share/doc/node/x.md", "bin/corepack"]) {
    if (name === without || (target.startsWith("win32-") && name.startsWith("bin/"))) continue;
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), name === layout.node ? "#!/bin/sh\necho v24.1.2\n" : name, { mode: 0o755 });
  }
  if (link) symlinkSync("../npm-cli.js", path.join(root, layout.npmFolder, "bin", "npx-link"));
  const archive = path.join(folder, archiveName(version, target));
  execFileSync(systemTar(), [target.startsWith("win32-") ? "-a" : "-z", "-cf", archive, "-C", path.join(folder, "src"), top]);
  return archive;
}

test("staging unpacks Node, npm and the license only, and replaces what was there", { skip: process.platform === "win32" && "the archives are made with sh scripts" }, async () => {
  const folder = temporaryFolder();
  try {
    const archive = makeArchive(folder);
    const resources = path.join(folder, "Resources with space");
    mkdirSync(path.join(resources, "node", "old"), { recursive: true });
    const pin = { version: "24.1.2" };
    const staged = stageNode({ pin, target: "darwin-arm64", archive, resourcesDir: resources, host: "none" });
    assert.equal(staged.node, path.join(resources, "node", "bin", "node"));
    assert.deepEqual(readdirSync(path.join(resources, "node")).sort(), ["LICENSE", "bin", "lib"]);
    assert.deepEqual(readdirSync(path.join(resources, "node", "bin")), ["node"]);
    assert.deepEqual(readdirSync(resources), ["node"], "no work folder left behind");
  } finally {
    await removeFolder(folder);
  }
});

test("staging refuses Node's files with a symbolic link in them, and an archive without Node", { skip: process.platform === "win32" && "symbolic links" }, async () => {
  const folder = temporaryFolder();
  try {
    const resources = path.join(folder, "Resources");
    assert.throws(() => stageNode({ pin: { version: "24.1.2" }, target: "darwin-arm64", archive: makeArchive(path.join(folder, "a"), { link: true }), resourcesDir: resources, host: "none" }), /symbolic links/);
    assert.throws(() => stageNode({ pin: { version: "24.1.2" }, target: "darwin-arm64", archive: makeArchive(path.join(folder, "b"), { without: "LICENSE" }), resourcesDir: resources, host: "none" }), /could not unpack|has no/);
    assert.equal(existsSync(path.join(resources, "node")), false, "nothing staged");
  } finally {
    await removeFolder(folder);
  }
});

test("on its own system the staged Node is run once and must say the pinned version", { skip: process.platform === "win32" && "a sh stand-in" }, async () => {
  const folder = temporaryFolder();
  try {
    const archive = makeArchive(folder);
    const resources = path.join(folder, "Resources");
    assert.ok(stageNode({ pin: { version: "24.1.2" }, target: "darwin-arm64", archive, resourcesDir: resources, host: "darwin-arm64" }));
    assert.throws(() => stageNode({ pin: { version: "24.9.9" }, target: "darwin-arm64", archive: makeArchive(path.join(folder, "other"), { version: "24.9.9" }), resourcesDir: resources, host: "darwin-arm64" }), /says v24\.1\.2, the pin is v24\.9\.9/);
  } finally {
    await removeFolder(folder);
  }
});
