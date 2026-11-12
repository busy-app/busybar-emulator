// The built-in update (EMU-221) in the app, against a stand-in for GitHub on this machine: the latest release, its
// signed manifest and this system's file. The window's Update to <version> downloads and checks it and turns into
// Restart to update; the person's answer stands in (BUSY_EMULATOR_TEST_UPDATE_ANSWER); a tampered file, an unsigned
// manifest and a hidden run without an answer leave the app as it is, with the Download line. A run from the source
// folder replaces no app of its own: the test names a small bundle in a temporary folder as the one to replace.
// The whole path, quit, swap and the new version's start, is the rehearsal's (test/update-rehearsal.mjs).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { manifestBytes, signManifest } from "../../src/update-manifest.mjs";
import { APP_DIR, NODE, PORTS, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

const VERSION = "9.9.9";
const mac = process.platform === "darwin";
const ASSET = mac ? (process.arch === "arm64" ? "busybar-emulator-mac-arm64.zip" : "busybar-emulator-mac-x64.zip") : "busybar-emulator-win-x64-setup.exe";
const skip = { skip: (!HAS_REAL_SERVER && "the server is not beside this package") || (!["darwin", "win32"].includes(process.platform) && "no update on this system") };

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let work;
let keyFile;
let target;
let asset;
let served = {};
let asked = [];
let github;
let app = null;

/** A bundle that passes for a development run of the app (the kind the running app is): see updater.mjs bundleProblem. */
function fakeBundle(dir, version) {
  const bundle = path.join(dir, "BUSY Bar Emulator.app");
  mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });
  writeFileSync(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.busy.emulator.test-variant</string><key>CFBundleExecutable</key><string>BUSY Bar Emulator</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
  writeFileSync(path.join(bundle, "Contents", "Resources", "build.json"), JSON.stringify({ kind: "development", version }));
  writeFileSync(path.join(bundle, "Contents", "MacOS", "BUSY Bar Emulator"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bundle, "Contents", "MacOS", "BUSY Bar Emulator"), 0o755);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", bundle], { stdio: "ignore" });
  return bundle;
}

function serve({ sign = true, digest = null } = {}) {
  const bytes = manifestBytes({ version: VERSION, assets: [{ name: ASSET, size: asset.length, sha256: digest ?? sha(asset) }] });
  served = {
    "/repos/busy-app/busybar-emulator/releases/latest": Buffer.from(JSON.stringify({ tag_name: `v${VERSION}` })),
    [`/download/v${VERSION}/update.json`]: bytes,
    [`/download/v${VERSION}/${ASSET}`]: asset,
    ...(sign ? { [`/download/v${VERSION}/update.json.sig`]: Buffer.from(signManifest(bytes, privateKey)) } : {}),
  };
}

before(async () => {
  if (skip.skip) return;
  work = temporaryFolder();
  keyFile = path.join(work, "update-public.pem");
  writeFileSync(keyFile, publicKey.export({ type: "spki", format: "pem" }));
  if (mac) {
    target = fakeBundle(path.join(work, "Applications"), "0.0.1");
    const newer = fakeBundle(path.join(work, "new"), VERSION);
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", newer, path.join(work, ASSET)]);
    asset = readFileSync(path.join(work, ASSET));
  } else {
    target = path.join(work, "Programs", "BUSY Bar Emulator");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "busybar-emulator-install.json"), '{"app":"app.busy.emulator","by":"setup"}\r\n');
    asset = Buffer.alloc(200_000, 1);
  }
  github = createServer((req, res) => {
    asked.push(req.url);
    const body = served[req.url];
    res.writeHead(body ? 200 : 404, { "content-length": String(body?.length ?? 0) });
    res.end(body ?? "");
  });
  await new Promise((resolve) => github.listen(PORTS.witness, "127.0.0.1", resolve));
});
after(async () => {
  if (skip.skip) return;
  github.closeAllConnections();
  await new Promise((resolve) => github.close(resolve));
  await removeFolder(work);
});
afterEach(async () => {
  await app?.close();
  app = null;
  asked = [];
});

const start = async (env = {}) => {
  app = await launch({
    server: "real",
    welcomed: true,
    env: {
      BUSY_EMULATOR_UPDATE_URL: `http://127.0.0.1:${PORTS.witness}/repos/busy-app/busybar-emulator/releases/latest`,
      BUSY_EMULATOR_UPDATE_RELEASES: `http://127.0.0.1:${PORTS.witness}/download`,
      BUSY_EMULATOR_TEST_UPDATE_KEY: keyFile,
      BUSY_EMULATOR_TEST_UPDATE_TARGET: target,
      BUSY_EMULATOR_TEST_UPDATE_ANSWER: "no",
      ...env,
    },
  });
  await app.waitWindow("device");
  return app;
};
const state = () => app.run((shell) => shell.updater.state);
const CLI = path.join(APP_DIR, "..", "server", "cli", "busy-emulator.mjs");
/** The command line of this tree, as an agent runs it, against the running app. */
function cli(args) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BUSY_EMULATOR_/i.test(name)));
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args, "--json"], { env: { ...clean, BUSY_EMULATOR_DATA: app.folder, BUSY_EMULATOR_PORT: String(app.port) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, json: JSON.parse(stdout.trim().split("\n").pop()) });
      } catch {
        reject(new Error(`busy-emulator ${args.join(" ")} printed no JSON (exit code ${code}): ${stdout}`));
      }
    });
  });
}
const shown = (selector) => app.page(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && !el.hidden && el.closest("[hidden]") === null); })()`);
const text = (selector) => app.page(`document.querySelector(${JSON.stringify(selector)}).textContent.replace(/\\s+/g, " ").trim()`);

test("Update to <version> downloads and checks the release; Restart to update asks the person, and a no changes nothing", skip, async () => {
  serve();
  await start();
  await until(() => shown("#update-go"), "the Update button");
  assert.equal(await text("#update-go"), `Update to ${VERSION}`);
  assert.equal(await shown("#update-link"), false, "the Download line gives way to the button");
  await app.click("#update-go");
  await until(async () => (await state()).state === "ready", "the update downloaded and checked", 60_000);
  assert.ok(asked.includes(`/download/v${VERSION}/update.json.sig`) && asked.includes(`/download/v${VERSION}/${ASSET}`), JSON.stringify(asked));
  await until(async () => (await text("#update-go")) === "Restart to update", "Restart to update");
  if (mac) assert.ok(existsSync(path.join(path.dirname(target), `.busy-emulator-update-${VERSION}`, "BUSY Bar Emulator.app", "Contents", "Info.plist")), "the new bundle waits beside the app");
  await app.click("#update-go");
  await until(() => /question \(update to 9\.9\.9\): answered by the test's stand-in \(no\)/.test(app.log()), "the person was asked");
  await sleep(800);
  assert.equal((await state()).state, "ready", "nothing happened without a yes");
  assert.ok(app.hooked() && (await app.run(() => true)), "the app still runs");
  assert.ok(existsSync(path.join(target, "Contents", "Info.plist")) || !mac, "the installed app is as it was");
  assert.match(app.log(), /manifest is signed by the release's key/);
});

test("a tampered file and an unsigned manifest are refused; the app stays as it is and offers Download", skip, async () => {
  for (const [what, options, code] of [["tampered", { digest: "e".repeat(64) }, "bad_file"], ["unsigned", { sign: false }, "no_signature"]]) {
    serve(options);
    await start();
    await until(() => shown("#update-go"), "the Update button");
    await app.click("#update-go");
    await until(async () => (await state()).state === "failed", `${what}: refused`, 60_000);
    const s = await state();
    assert.equal(s.code, code, what);
    assert.ok(s.message && s.hint, "said in words, with a next step");
    // The page draws the refusal a moment after the state says it (seen on Windows): waited for, not read at once.
    await until(() => shown("#update-link"), `${what}: the Download line is back`);
    assert.match(await app.page(`document.querySelector("#update-link").title`), /refused/);
    assert.equal(await app.page(`document.querySelector("#update-link").href`), `https://github.com/busy-app/busybar-emulator/releases/tag/v${VERSION}`);
    assert.ok(!existsSync(path.join(path.dirname(target), `.busy-emulator-update-${VERSION}`)), `${what}: nothing beside the app`);
    await app.close();
    app = null;
  }
});

test("busy-emulator update --check says what is out; update without the person's answer changes nothing", skip, async () => {
  serve();
  await start({ BUSY_EMULATOR_TEST_UPDATE_ANSWER: "" });
  await until(async () => (await state()).state === "available", "the update offered");
  const checked = await cli(["update", "--check"]);
  assert.equal(checked.code, 0, JSON.stringify(checked.json));
  assert.equal(checked.json.available, VERSION);
  assert.equal(checked.json.can_update, true);
  // A hidden run shows no dialog, so the person cannot say yes: nothing is downloaded, nothing is installed.
  const updated = await cli(["update"]);
  assert.notEqual(updated.code, 0);
  assert.equal(updated.json.error?.code ?? updated.json.code, "window_hidden", JSON.stringify(updated.json));
  assert.ok(!asked.includes(`/download/v${VERSION}/${ASSET}`), "nothing was downloaded");
  // The window's Restart path, by the shell's own action: the same.
  await app.run((shell) => shell.updater.download());
  assert.equal((await state()).state, "ready");
  assert.equal((await app.run((shell) => shell.updater.restart({ by: "window" }))).code, "window_hidden");
  await sleep(500);
  assert.ok(await app.run(() => true), "the app still runs");
});
