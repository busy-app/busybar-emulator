// The parts of the update chain (EMU-341, test/update-chain.mjs) that run without Electron: the stand-in for GitHub's
// releases answers what the app's own update code asks and accepts; the plan of the versions to build. The checks of
// the data folder run on the folders the releases wrote, beside them: test/server/update-chain-data.test.mjs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { askLatest, versionInAnswer } from "../../src/update-check.mjs";
import { updateAssetFor, verifyManifest } from "../../src/update-manifest.mjs";
import { downloadFile, fetchSmall, originsFor } from "../../src/updater.mjs";
import { DEFAULT_CHAIN, parseSpec, planChain, unlendNodeModules } from "../update-chain/build.mjs";
import { DOWNLOAD_PATH, LATEST_PATH, startReleaseStandIn } from "../update-chain/stand-in.mjs";

function folder(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emu-update-chain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the stand-in: the app's own update code finds the latest version, takes its signed manifest with the chain's key and downloads its file", async (t) => {
  const dir = folder(t);
  const keyFile = path.join(dir, "update-public.pem");
  const standIn = await startReleaseStandIn({ port: 0, keyFile });
  t.after(() => standIn.close());
  assert.equal(new URL(standIn.url).hostname, "127.0.0.1");
  const env = standIn.env();
  assert.deepEqual(env, { BUSY_EMULATOR_UPDATE_URL: `${standIn.url}${LATEST_PATH}`, BUSY_EMULATOR_UPDATE_RELEASES: `${standIn.url}${DOWNLOAD_PATH}`, BUSY_EMULATOR_TEST_UPDATE_KEY: keyFile });
  const name = updateAssetFor("darwin", "arm64");
  const asset = path.join(dir, "asset.zip");
  const publicKey = readFileSync(keyFile, "utf8");
  const origins = originsFor(env.BUSY_EMULATOR_UPDATE_RELEASES);
  const transports = { http };

  // Nothing published: no latest release.
  await assert.rejects(askLatest(env.BUSY_EMULATOR_UPDATE_URL, http), /status 404/);

  for (const [version, current, bytes] of [["0.1.0-beta.6", "0.1.0-beta.5", "the zip of beta.6"], ["0.1.0-beta.6.chain", "0.1.0-beta.6", "the zip of the next one"]]) {
    writeFileSync(asset, bytes);
    const published = standIn.publish({ version, asset, name });
    assert.equal(versionInAnswer(await askLatest(env.BUSY_EMULATOR_UPDATE_URL, http)), version, "the latest release is the one published last");
    const base = `${env.BUSY_EMULATOR_UPDATE_RELEASES}/v${version}`;
    const manifest = verifyManifest(await fetchSmall(`${base}/update.json`, { origins, transports }), (await fetchSmall(`${base}/update.json.sig`, { origins, transports })).toString(), { publicKey, expected: version, current });
    assert.deepEqual(manifest.assets, [{ name, size: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") }]);
    assert.deepEqual(published.manifest, manifest);
    const file = path.join(dir, `${version}.zip`);
    await downloadFile(`${base}/${name}`, file, { size: manifest.assets[0].size, sha256: manifest.assets[0].sha256, origins, transports });
    assert.equal(readFileSync(file, "utf8"), bytes);
    assert.deepEqual(standIn.askedFor(version).sort(), [name, "update.json", "update.json.sig"].sort());
  }
  // The earlier release's files are still there, as on GitHub; what was never published is not.
  assert.equal((await fetchSmall(`${env.BUSY_EMULATOR_UPDATE_RELEASES}/v0.1.0-beta.6/update.json`, { origins, transports })).length > 0, true);
  await assert.rejects(fetchSmall(`${env.BUSY_EMULATOR_UPDATE_RELEASES}/v9.9.9/update.json`, { origins, transports }), (e) => e.code === "not_found");
  // A manifest signed with the chain's key is not one a release accepts: its key is the release's (UPDATE_PUBLIC_KEY).
  const base = `${env.BUSY_EMULATOR_UPDATE_RELEASES}/v0.1.0-beta.6.chain`;
  const bytes = await fetchSmall(`${base}/update.json`, { origins, transports });
  const signature = (await fetchSmall(`${base}/update.json.sig`, { origins, transports })).toString();
  assert.throws(() => verifyManifest(bytes, signature, { current: "0.1.0-beta.6" }), (e) => e.code === "bad_signature");
});

test("the plan of the chain: the default is beta.5, beta.6 and HEAD above beta.6; versions must rise; a spec names a commit and maybe a version", () => {
  const commits = { aa1b8a02: "a".repeat(40), "826b3156": "b".repeat(40), HEAD: "c".repeat(40), x: "d".repeat(40) };
  const files = {
    ["a".repeat(40)]: { version: "0.1.0-beta.5", format: 1 },
    ["b".repeat(40)]: { version: "0.1.0-beta.6", format: 2 },
    ["c".repeat(40)]: { version: "0.1.0-beta.6", format: 2 },
    ["d".repeat(40)]: { version: "0.1.0", format: 3 },
  };
  const git = (args) => {
    if (args[0] === "rev-parse") return `${commits[args[2].replace("^{commit}", "")]}\n`;
    const [commit, file] = args[1].split(":");
    const f = files[commit];
    if (file.endsWith("package.json")) return JSON.stringify({ version: f.version, devDependencies: { electron: "45.2.3" } });
    return `export const FORMAT = ${f.format};\n`;
  };
  assert.deepEqual(DEFAULT_CHAIN, ["aa1b8a02", "826b3156", "HEAD"]);
  assert.deepEqual(planChain([], { git }).map((s) => [s.version, s.format]), [["0.1.0-beta.5", 1], ["0.1.0-beta.6", 2], ["0.1.0-beta.6.chain", 2]]);
  assert.deepEqual(planChain(["826b3156", "x"], { git }).map((s) => s.version), ["0.1.0-beta.6", "0.1.0"]);
  assert.deepEqual(planChain(["HEAD=0.1.0-chain.1", "HEAD=0.1.0-chain.2", "HEAD=0.1.0-chain.3"], { git }).map((s) => s.version), ["0.1.0-chain.1", "0.1.0-chain.2", "0.1.0-chain.3"]);
  assert.throws(() => planChain(["826b3156", "aa1b8a02"], { git }), /0\.1\.0-beta\.5 \(aa1b8a02\) is not newer than 0\.1\.0-beta\.6/);
  assert.throws(() => planChain(["HEAD", "826b3156"], { git }), /not newer/);
  assert.throws(() => planChain(["HEAD"], { git }), /two versions at least/);
  assert.deepEqual(parseSpec("826b3156=0.1.0-beta.7"), { commit: "826b3156", version: "0.1.0-beta.7" });
  assert.throws(() => parseSpec("826b3156=beta.7"), /Not a version/);
  assert.throws(() => parseSpec("a b"), /Not a commit/);
});

test("the worktree's lent node_modules is unlinked before the worktree goes, and what it points to stays", (t) => {
  const dir = folder(t);
  const ours = path.join(dir, "ours", "node_modules");
  mkdirSync(path.join(ours, "electron"), { recursive: true });
  writeFileSync(path.join(ours, "electron", "package.json"), "{}");
  const appDir = path.join(dir, "worktree", "emulator", "packages", "app");
  mkdirSync(appDir, { recursive: true });
  symlinkSync(ours, path.join(appDir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(unlendNodeModules(appDir), "unlinked");
  assert.ok(!existsSync(path.join(appDir, "node_modules")));
  assert.ok(existsSync(path.join(ours, "electron", "package.json")), "the tree's own node_modules is untouched");
  rmSync(path.join(dir, "worktree"), { recursive: true, force: true });
  assert.ok(existsSync(path.join(ours, "electron", "package.json")));
  // A copy (macOS) goes with the worktree; nothing is there: nothing to do. A junction that unlink refuses goes by rmdir.
  mkdirSync(path.join(appDir, "node_modules"), { recursive: true });
  assert.equal(unlendNodeModules(appDir), "copy");
  assert.equal(unlendNodeModules(path.join(dir, "nowhere")), "none");
  const calls = [];
  assert.equal(unlendNodeModules(appDir, { lstat: () => ({ isSymbolicLink: () => true }), unlink: () => { calls.push("unlink"); throw Object.assign(new Error("EPERM"), { code: "EPERM" }); }, rmdir: () => calls.push("rmdir") }), "unlinked");
  assert.deepEqual(calls, ["unlink", "rmdir"]);
});
