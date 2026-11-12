// GitHub CLI inside the app (tools/bundled-gh.mjs): one pinned release of github.com/cli/cli, its archives checked
// against the sums of the release's checksums file, staged into the resources folder unchanged and run once. The real
// archive for this system comes from the build's cache (downloaded once from the pinned release if it is not there).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { archiveName, checkEnvironment, defaultCacheDir, fetchArchive, GITHUB_TEAM, layoutOf, membersOf, pinFrom, readPin, stageGh, TARGETS, versionLine } from "../../tools/bundled-gh.mjs";
import { ghLayoutProblems, ghProblems, signatureOf } from "../../tools/packaging/check.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const folders = [];
after(async () => {
  for (const folder of folders) await removeFolder(folder);
});
const folder = () => {
  const made = temporaryFolder();
  folders.push(made);
  return made;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the archives' names, as the release publishes them, and where gh and its license lie in them and in the app", () => {
  assert.deepEqual(TARGETS.map((t) => archiveName("2.103.3", t)), ["gh_2.103.3_macOS_arm64.zip", "gh_2.103.3_macOS_amd64.zip", "gh_2.103.3_windows_amd64.zip"]);
  assert.deepEqual(membersOf("2.103.3", "darwin-arm64"), { gh: "gh_2.103.3_macOS_arm64/bin/gh", license: "gh_2.103.3_macOS_arm64/LICENSE" });
  assert.deepEqual(membersOf("2.103.3", "win32-x64"), { gh: "bin/gh.exe", license: "LICENSE" });
  assert.deepEqual(layoutOf("darwin-x64"), { gh: "bin/gh", license: "LICENSE" });
  assert.deepEqual(layoutOf("win32-x64"), { gh: "bin/gh.exe", license: "LICENSE" });
  assert.throws(() => archiveName("2.103.3", "linux-arm64"), /No gh for linux-arm64/);
});

test("a pin takes the sums of the three archives from the release's checksums file, and refuses a list that lacks one", () => {
  const sums = TARGETS.map((t, i) => `${String(i).repeat(64)}  ${archiveName("2.103.3", t)}`).join("\n");
  const pin = pinFrom("2.103.3", `${"f".repeat(64)}  gh_2.103.3_linux_amd64.tar.gz\n${sums}\n`);
  assert.equal(pin.source, "https://github.com/cli/cli/releases/download/v2.103.3/");
  assert.equal(pin.checksums, "gh_2.103.3_checksums.txt");
  assert.equal(pin.archives["win32-x64"].sha256, "2".repeat(64));
  assert.throws(() => pinFrom("2.103.3", sums.split("\n").slice(1).join("\n")), /names no gh_2\.103\.3_macOS_arm64\.zip/);
  assert.throws(() => pinFrom("latest", sums), /Not a gh version/);
});

test("the pinned version in the repository: gh 2.103.3 from github.com/cli/cli's release, with the sums of its checksums file", () => {
  const pin = readPin();
  assert.equal(pin.version, "2.103.3");
  assert.deepEqual(Object.fromEntries(Object.entries(pin.archives).map(([t, a]) => [t, a.sha256])), {
    "darwin-arm64": "d700207eae9ae98fe2b89535c2c087c07823d4628c56364695a5a07ef311c062",
    "darwin-x64": "a2f86418f4350ae6e9ec60d5000bdf7665728436946a97fc27fe50e6ae752682",
    "win32-x64": "98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0",
  });
  const dir = folder();
  for (const broken of [{ ...pin, source: "https://example.com/gh/" }, { ...pin, checksums: "sums.txt" }, { ...pin, archives: { ...pin.archives, "win32-x64": { file: "gh.zip", sha256: "0".repeat(64) } } }, { ...pin, archives: { ...pin.archives, "darwin-x64": { ...pin.archives["darwin-x64"], sha256: "XYZ" } } }]) {
    writeFileSync(path.join(dir, "pin.json"), JSON.stringify(broken));
    assert.throws(() => readPin(path.join(dir, "pin.json")));
  }
});

test("an archive is downloaded once into the cache and checked every time it is used; one whose sum does not match is removed and refused", async () => {
  const cache = folder();
  const bytes = Buffer.from("an archive");
  const pin = { version: "9.9.9", source: "https://github.com/cli/cli/releases/download/v9.9.9/", archives: { "darwin-arm64": { file: "gh_9.9.9_macOS_arm64.zip", sha256: sha256(bytes) } } };
  const asked = [];
  const download = async (url, file) => (asked.push(url), writeFileSync(file, bytes));
  const file = await fetchArchive({ pin, target: "darwin-arm64", cacheDir: cache, download });
  assert.deepEqual(asked, ["https://github.com/cli/cli/releases/download/v9.9.9/gh_9.9.9_macOS_arm64.zip"]);
  await fetchArchive({ pin, target: "darwin-arm64", cacheDir: cache, download });
  assert.equal(asked.length, 1);
  writeFileSync(file, "changed in the cache");
  await assert.rejects(fetchArchive({ pin, target: "darwin-arm64", cacheDir: cache, download: async () => assert.fail("no download for a file in the cache") }), /SHA-256 is .* the pin says/);
  assert.equal(existsSync(file), false);
  await assert.rejects(fetchArchive({ pin, target: "darwin-arm64", cacheDir: cache, download: async (_url, to) => writeFileSync(to, "a forged archive") }), /nothing was unpacked/);
  assert.deepEqual(readdirSync(cache), []);
});

test("gh is checked with an environment of its own: no token, host or configuration of the caller's", () => {
  const env = checkEnvironment("/tmp/gh-config", "darwin", { HOME: "/srv/x", GH_TOKEN: "t", GITHUB_TOKEN: "t", GH_HOST: "evil.example", GH_CONFIG_DIR: "/srv/x/.config/gh", PATH: "/opt/homebrew/bin" });
  assert.deepEqual(Object.keys(env).filter((k) => /TOKEN|GH_HOST/.test(k)), []);
  assert.equal(env.GH_CONFIG_DIR, "/tmp/gh-config");
  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.match("gh version 2.103.3 (2026-10-26)", versionLine("2.103.3"));
  assert.doesNotMatch("gh version 2.103.30 (2026-10-26)", versionLine("2.103.3"));
});

const HOST = `${process.platform}-${process.arch}`;
const HOST_BUILT = TARGETS.includes(HOST);

test("the real archive of this system: its sum is the pinned one, gh and its license are staged into a folder with spaces and letters outside Latin, unchanged, and gh says the pinned version", { skip: !HOST_BUILT && `no gh is pinned for ${HOST}` }, async () => {
  const pin = readPin();
  const archive = await fetchArchive({ pin, target: HOST, cacheDir: process.env.BUSY_EMULATOR_GH_CACHE || defaultCacheDir(), log: (line) => console.error(line) });
  assert.equal(sha256(readFileSync(archive)), pin.archives[HOST].sha256);
  const resources = path.join(folder(), "Φάκελος with 'quotes' フォルダ", "Resources");
  mkdirSync(resources, { recursive: true });
  const staged = stageGh({ pin, target: HOST, archive, resourcesDir: resources });
  assert.deepEqual(ghLayoutProblems(resources, process.platform), []);
  assert.match(readFileSync(staged.license, "utf8"), /^MIT License\r?\n\r?\nCopyright \(c\) 2019 GitHub Inc\./);
  assert.deepEqual(readdirSync(resources).sort(), ["gh"], "nothing else is left beside it");
  const work = folder();
  const checked = ghProblems({ resources, platform: process.platform, workDir: work });
  assert.deepEqual(checked.problems, []);
  assert.match(checked.results.gh, versionLine(pin.version));
  if (process.platform === "darwin") assert.equal(signatureOf(staged.gh).team, GITHUB_TEAM, "GitHub's own signature");
  writeFileSync(path.join(resources, "gh", "extra"), "");
  assert.match(ghLayoutProblems(resources, process.platform)[0], /resources\/gh holds/);
});
