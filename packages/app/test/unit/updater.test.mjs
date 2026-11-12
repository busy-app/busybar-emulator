// The built-in update (EMU-221, src/updater.mjs) against a stand-in for GitHub's releases on this machine: the
// download with its checks (signature, size, SHA-256, redirects), the zip's checks, where the app may replace itself,
// and the steps of the update with the person's answer standing in.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { manifestBytes, signManifest } from "../../src/update-manifest.mjs";
import { allowedAddress, createUpdater, downloadFile, folderInUseWords, installPlace, linkOutside, originsFor, othersInFolder, parseProcessList, UPDATE_HOSTS, whatRuns, zipEntries, zipProblem } from "../../src/updater.mjs";

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "update-helper.mjs");
const T = realpathSync(mkdtempSync(path.join(os.tmpdir(), "updater-test-")));
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUBLIC = publicKey.export({ type: "spki", format: "pem" });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SETUP = "busybar-emulator-win-x64-setup.exe";
const payload = Buffer.alloc(300_000, 7);
for (let i = 0; i < payload.length; i += 997) payload[i] = i & 0xff;

// What the stand-in serves, by path; each test sets what it needs.
let files = {};
let behavior = {};
let asked = [];
let server;
let other;
let base;
before(async () => {
  const handler = (req, res) => {
    asked.push({ url: req.url, range: req.headers.range ?? null });
    if (behavior.redirect && req.url.endsWith(behavior.redirect.from)) {
      res.writeHead(302, { location: behavior.redirect.to });
      return res.end();
    }
    const body = files[req.url];
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    let start = range ? Number(range[1]) : 0;
    const head = range && behavior.ranges !== false ? 206 : 200;
    if (head === 200) start = 0;
    const part = body.subarray(start);
    res.writeHead(head, { "content-length": String(part.length), ...(head === 206 ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
    if (behavior.breakAfter && !behavior.broke) {
      behavior.broke = true;
      res.write(part.subarray(0, behavior.breakAfter));
      return setTimeout(() => res.destroy(), 20);
    }
    res.end(part);
  };
  server = http.createServer(handler);
  other = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/releases/download`;
});
after(() => {
  server.close();
  other.close();
  rmSync(T, { recursive: true, force: true });
});

function release(version, { asset = payload, sign = true, name = SETUP, size, digest } = {}) {
  const bytes = manifestBytes({ version, assets: [{ name, size: size ?? asset.length, sha256: digest ?? sha(asset) }] });
  files = { [`/releases/download/v${version}/update.json`]: bytes, [`/releases/download/v${version}/${name}`]: asset };
  if (sign) files[`/releases/download/v${version}/update.json.sig`] = Buffer.from(signManifest(bytes, privateKey));
  behavior = {};
  asked = [];
}

const transports = { http, https };
const o = () => ({ origins: originsFor(base), transports, sleep: async () => {} });

test("only GitHub's hosts over HTTPS, or a test's one stand-in on this machine, are asked", () => {
  const github = originsFor("https://github.com/busy-app/busybar-emulator/releases/download");
  assert.deepEqual(github.map((one) => one.host), UPDATE_HOSTS);
  assert.ok(allowedAddress("https://github.com/busy-app/busybar-emulator/releases/download/v1.0.0/update.json", github));
  assert.ok(allowedAddress("https://objects.githubusercontent.com/x", github));
  assert.ok(allowedAddress("https://release-assets.githubusercontent.com/x", github));
  for (const address of ["http://github.com/x", "https://github.com.evil.test/x", "https://evil.test/x", "https://user:pw" + "@github.com/x", "https://github.com:8443/x", "file:///etc/passwd", "not an address"]) assert.ok(!allowedAddress(address, github), address);
  const local = originsFor("http://127.0.0.1:18870/releases/download");
  assert.ok(allowedAddress("http://127.0.0.1:18870/a", local));
  assert.ok(!allowedAddress("http://127.0.0.1:18871/a", local));
  assert.ok(!allowedAddress("http://localhost:18870/a", local));
  assert.throws(() => originsFor("https://example.com/releases"), /Not a place/);
  assert.throws(() => originsFor("http://203.0.113.5/releases"), /Not a place/);
});

test("a download is checked: its SHA-256, its length, and a redirect to a host that is not allowed", async () => {
  release("0.1.0-beta.2");
  const url = `${base}/v0.1.0-beta.2/${SETUP}`;
  const file = path.join(T, "good.exe");
  await downloadFile(url, file, { ...o(), size: payload.length, sha256: sha(payload) });
  assert.ok(readFileSync(file).equals(payload));

  const tampered = path.join(T, "tampered.exe");
  await assert.rejects(downloadFile(url, tampered, { ...o(), size: payload.length, sha256: "0".repeat(64) }), (e) => e.code === "bad_file");
  assert.ok(!existsSync(tampered) && !existsSync(`${tampered}.part`), "a file that does not match is deleted");

  await assert.rejects(downloadFile(url, path.join(T, "short.exe"), { ...o(), size: payload.length - 10, sha256: sha(payload) }), (e) => e.code === "too_large", "more than the manifest says is refused");
  await assert.rejects(downloadFile(url, path.join(T, "huge.exe"), { ...o(), size: 2 * 1024 ** 3, sha256: sha(payload) }), (e) => e.code === "too_large", "the cap");

  behavior.redirect = { from: SETUP, to: `http://127.0.0.1:${other.address().port}/releases/download/v0.1.0-beta.2/${SETUP}` };
  await assert.rejects(downloadFile(url, path.join(T, "elsewhere.exe"), { ...o(), size: payload.length, sha256: sha(payload) }), (e) => e.code === "bad_host");
  behavior.redirect = { from: SETUP, to: `/releases/download/v0.1.0-beta.2/${SETUP}?again` };
  files[`/releases/download/v0.1.0-beta.2/${SETUP}?again`] = payload;
  await downloadFile(url, path.join(T, "redirected.exe"), { ...o(), size: payload.length, sha256: sha(payload) });
});

test("a download that breaks off is resumed from where it stopped", async () => {
  release("0.1.0-beta.2");
  behavior.breakAfter = 100_000;
  const file = path.join(T, "resumed.exe");
  await downloadFile(`${base}/v0.1.0-beta.2/${SETUP}`, file, { ...o(), size: payload.length, sha256: sha(payload) });
  assert.ok(readFileSync(file).equals(payload));
  assert.ok(asked.some((one) => one.range && /^bytes=\d+-$/.test(one.range) && Number(one.range.slice(6, -1)) > 0), `a Range request: ${JSON.stringify(asked)}`);
  // A server that ignores Range starts the file over, and the result is the same.
  release("0.1.0-beta.2");
  behavior = { breakAfter: 100_000, ranges: false };
  const again = path.join(T, "restarted.exe");
  await downloadFile(`${base}/v0.1.0-beta.2/${SETUP}`, again, { ...o(), size: payload.length, sha256: sha(payload) });
  assert.ok(readFileSync(again).equals(payload));
});

test("the zip of the app: everything inside the bundle, no way out, nothing beneath a link", () => {
  const top = "BUSY Bar Emulator.app";
  assert.equal(zipProblem([{ name: `${top}/`, isDir: true }, { name: `${top}/Contents/Info.plist` }, { name: `${top}/Contents/Frameworks/X.framework/Versions/Current`, isLink: true }]), null);
  assert.match(zipProblem([{ name: `${top}/../../evil` }]), /leads elsewhere/);
  assert.match(zipProblem([{ name: "/etc/evil" }]), /not plain/);
  assert.match(zipProblem([{ name: `${top}\\..\\evil` }]), /not plain/);
  assert.match(zipProblem([{ name: "Other.app/Contents/x" }]), /besides/);
  assert.match(zipProblem([{ name: `${top}/link`, isLink: true }, { name: `${top}/link/file` }]), /beneath a link/);
  assert.match(zipProblem([]), /empty/);
  // A link that leads out of the unpacked bundle is found.
  const root = path.join(T, "links", top);
  mkdirSync(path.join(root, "Contents", "A"), { recursive: true });
  symlinkSync("A", path.join(root, "Contents", "Current"));
  assert.equal(linkOutside(root), null);
  symlinkSync("../../..", path.join(root, "Contents", "Out"));
  assert.equal(linkOutside(root), path.join("Contents", "Out"));
});

test("where the app cannot replace itself, it says why", () => {
  const ok = () => true;
  const here = { ok: true };
  const mac = (bundlePath, o2 = {}) => installPlace({ platform: "darwin", arch: "arm64", exe: `${bundlePath}/Contents/MacOS/BUSY Bar Emulator`, homeDir: "/Users/you", writable: ok, location: () => here, ...o2 });
  assert.equal(mac("/Applications/BUSY Bar Emulator.app").ok, true);
  assert.match(mac("/x", { exe: "/usr/local/bin/electron" }).why, /not a macOS app bundle/);
  assert.match(mac("/Applications/x/BUSY Bar Emulator.app", { location: () => ({ ok: false, reason: "read-only-volume" }) }).why, /disk image/);
  assert.match(mac("/Applications/AppTranslocation/y/d/BUSY Bar Emulator.app", { location: () => ({ ok: false, reason: "translocated" }) }).why, /temporary place/);
  assert.match(mac("/Applications/BUSY Bar Emulator.app", { writable: () => false }).why, /cannot write/);
  assert.match(installPlace({ platform: "linux", arch: "x64", exe: "/opt/x" }).why, /no update for linux/);
  assert.match(installPlace({ platform: "win32", arch: "arm64", exe: "C:\\x\\a.exe" }).why, /no update/);
  if (process.platform === "win32") return;
  // Windows: only a folder the setup made (its marker), and the default folder keeps its shortcut.
  const folder = path.join(T, "win-install");
  mkdirSync(folder, { recursive: true });
  assert.match(installPlace({ platform: "win32", arch: "x64", exe: path.join(folder, "BUSY Bar Emulator.exe"), target: folder, writable: ok }).why, /not installed by the emulator's setup/);
});

/** An updater on "Windows" (no unpacking) with every effect written down. */
function updaterFor({ answer = "yes", busy = null, settings = {}, current = "0.1.0-beta.1", place, processes = async () => null } = {}) {
  const dataDir = mkdtempSync(path.join(T, "data-"));
  const started = [];
  const states = [];
  const asks = [];
  let quits = 0;
  const node = path.join(T, "fake-node.exe");
  writeFileSync(node, "not really node");
  let kept = { ...settings };
  const updater = createUpdater({
    current,
    kind: "release",
    platform: "win32",
    arch: "x64",
    allowed: true,
    base,
    publicKey: PUBLIC,
    dataDir,
    place: place ?? { ok: true, target: "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator", exe: "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\BUSY Bar Emulator.exe", noShortcut: false },
    nodePath: node,
    helperFile: HELPER,
    transports,
    run: () => {
      throw new Error("nothing is run on Windows before the restart");
    },
    start: (file, args, options) => {
      started.push({ file, args, options });
      return { pid: 4242, unref() {} };
    },
    allowNode: () => {},
    busy: () => busy,
    confirm: async (question) => {
      asks.push(question);
      return answer;
    },
    settings: { read: () => kept, update: (change) => void (kept = { ...kept, ...change }) },
    quit: () => (quits += 1),
    log: () => {},
    onState: (state) => states.push(state),
    env: { KEPT: "1" },
    pid: 777,
    listProcesses: processes,
  });
  return { updater, dataDir, started, states, asks, quits: () => quits, settings: () => kept };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("Update downloads and checks the release, then Restart asks the person and hands over to the helper", async () => {
  release("0.1.0-beta.2");
  const u = updaterFor();
  u.updater.offer({ version: "0.1.0-beta.2", page: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.0-beta.2" });
  assert.equal(u.updater.state.state, "available");
  assert.equal(u.updater.state.canInstall, true);
  const ready = await u.updater.download();
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.ok(u.states.some((s) => s.state === "downloading" && s.total === payload.length), "progress");
  const folder = path.join(u.dataDir, "tmp", "update-0.1.0-beta.2");
  assert.ok(readFileSync(path.join(folder, SETUP)).equals(payload));

  const restarted = await u.updater.restart({ by: "window" });
  assert.deepEqual(restarted, { ok: true, version: "0.1.0-beta.2", restarting: true });
  assert.equal(u.asks.length, 1);
  assert.match(u.asks[0].message, /Restart BUSY Bar Emulator to update to 0\.1\.0-beta\.2/);
  assert.equal(u.started.length, 1);
  const { file, args, options } = u.started[0];
  assert.equal(file, path.join(folder, "node.exe"), "the helper runs on a copy of Node outside the app's folder");
  assert.equal(args[0], path.join(folder, "update-helper.mjs"));
  assert.ok(readFileSync(args[0], "utf8").includes("planProblem"), "the helper is copied out");
  const plan = JSON.parse(readFileSync(args[1], "utf8"));
  assert.equal(args[2], plan.token);
  assert.equal(plan.pid, 777);
  assert.equal(plan.setup, path.join(folder, SETUP));
  assert.equal(plan.setupSha256, sha(payload), "the helper checks the setup again against the manifest's SHA-256");
  assert.equal(plan.noShortcut, false);
  assert.equal(options.detached, true);
  assert.deepEqual(options.env, { KEPT: "1" });
  assert.equal(u.settings().updatePending.to, "0.1.0-beta.2");
  await wait(400);
  assert.equal(u.quits(), 1, "the app quits for the helper");
});

test("Restart is not done without the person's yes, without a window, or while the app is busy", async () => {
  release("0.1.0-beta.2");
  for (const [answer, code] of [["no", "refused"], ["unavailable", "window_hidden"]]) {
    const u = updaterFor({ answer });
    u.updater.offer({ version: "0.1.0-beta.2", page: "p" });
    await u.updater.download();
    const said = await u.updater.restart();
    assert.equal(said.code, code);
    assert.equal(u.started.length, 0);
    await wait(350);
    assert.equal(u.quits(), 0);
    assert.equal(u.updater.state.state, "ready", "the update stays ready for another try");
  }
  const busy = updaterFor({ busy: "a build is running in the window" });
  busy.updater.offer({ version: "0.1.0-beta.2", page: "p" });
  await busy.updater.download();
  const said = await busy.updater.restart();
  assert.equal(said.code, "busy");
  assert.match(said.message, /a build is running/);
  assert.equal(busy.asks.length, 0, "the person is not asked while the app is busy");
});

test("an unsigned release, a tampered file, a downgrade and a manifest of another version are refused; the app stays as it is", async () => {
  const cases = [
    ["no signature", () => release("0.1.0-beta.2", { sign: false }), "no_signature"],
    ["a tampered file", () => release("0.1.0-beta.2", { digest: "f".repeat(64) }), "bad_file"],
    ["a manifest of an older version", () => {
      release("0.1.0-beta.1");
      files["/releases/download/v0.1.0-beta.2/update.json"] = files["/releases/download/v0.1.0-beta.1/update.json"];
      files["/releases/download/v0.1.0-beta.2/update.json.sig"] = files["/releases/download/v0.1.0-beta.1/update.json.sig"];
    }, "other_version"],
    ["no file for this system", () => release("0.1.0-beta.2", { name: "busybar-emulator-mac-arm64.zip" }), "not_found"],
  ];
  for (const [what, set, code] of cases) {
    set();
    const u = updaterFor();
    u.updater.offer({ version: "0.1.0-beta.2", page: "p" });
    const after = await u.updater.download();
    assert.equal(after.state, "failed", what);
    assert.equal(after.code, code, what);
    assert.ok(after.message && after.hint, `${what}: said in words, with a next step`);
    assert.equal((await u.updater.restart()).code, "not_ready", what);
    assert.equal(u.started.length, 0, what);
  }
  // A manifest that says it is this very version (a downgrade or a replay) is refused before anything is downloaded.
  release("0.1.0-beta.1");
  const same = updaterFor();
  same.updater.offer({ version: "0.1.0-beta.1", page: "p" });
  assert.equal((await same.updater.download()).code, "not_newer");
  assert.ok(!asked.some((one) => one.url.endsWith(SETUP)), "no file was downloaded");
});

test("where the app cannot replace itself, Update is not offered and the reason is given", async () => {
  const u = updaterFor({ place: { ok: false, why: "This copy runs from the disk image." } });
  u.updater.offer({ version: "0.1.0-beta.2", page: "p" });
  assert.equal(u.updater.state.canInstall, false);
  assert.match(u.updater.state.why, /disk image/);
  assert.equal((await u.updater.download()).state, "available");
});

test("at the next start: the new version tells the helper it is up; the old one says why the update did not happen", () => {
  const up = updaterFor({ current: "0.1.0-beta.2" });
  const folder = path.join(up.dataDir, "tmp", "update-0.1.0-beta.2");
  mkdirSync(folder, { recursive: true });
  up.settings().updatePending = undefined;
  const ok = updaterFor({ current: "0.1.0-beta.2", settings: { updatePending: { from: "0.1.0-beta.1", to: "0.1.0-beta.2", token: "t".repeat(32) } } });
  const okFolder = path.join(ok.dataDir, "tmp", "update-0.1.0-beta.2");
  mkdirSync(okFolder, { recursive: true });
  ok.updater.afterStart();
  assert.equal(readFileSync(path.join(okFolder, "started"), "utf8").trim(), "t".repeat(32));
  assert.equal(ok.settings().updatePending, null);
  assert.equal(ok.settings().updatedFrom, "0.1.0-beta.1");

  const back = updaterFor({ current: "0.1.0-beta.1", settings: { updatePending: { from: "0.1.0-beta.1", to: "0.1.0-beta.2", token: "t".repeat(32) } } });
  const backFolder = path.join(back.dataDir, "tmp", "update-0.1.0-beta.2");
  mkdirSync(backFolder, { recursive: true });
  writeFileSync(path.join(backFolder, "result.json"), JSON.stringify({ ok: false, code: "in_use", message: "a program still runs from the emulator's folder", hint: "Close it." }));
  back.updater.afterStart();
  assert.equal(back.updater.state.state, "failed");
  assert.match(back.updater.state.message, /did not finish: a program still runs/);
  assert.equal(back.updater.state.hint, "Close it.");
  assert.ok(!existsSync(backFolder), "the update's files go");
});

// ---------------------------------------------------------------- macOS: the bundle unpacked, checked and swapped

// The macOS steps unpack and check a real bundle: on macOS alone, a named reason elsewhere (the gate counts a skip without one).
const mac = process.platform === "darwin" ? test : (name, ...rest) => test(name, { skip: "macOS only: the update's bundle is unpacked and checked" }, rest.at(-1));

/** A small bundle that passes for the app: its Info.plist, build.json, an executable (a script) and an ad hoc signature. */
function fakeBundle(dir, { version, id = "app.busy.emulator.test-variant", kind = "test", script }) {
  const app = path.join(dir, "BUSY Bar Emulator.app");
  mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
  writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>BUSY Bar Emulator</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
  writeFileSync(path.join(app, "Contents", "Resources", "build.json"), JSON.stringify({ kind, version }));
  writeFileSync(path.join(app, "Contents", "MacOS", "BUSY Bar Emulator"), script ?? "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(app, "Contents", "MacOS", "BUSY Bar Emulator"), 0o755);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app], { stdio: "ignore" });
  return app;
}

function zipOf(app, out) {
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", app, out]);
  return readFileSync(out);
}

function macUpdater(target, { dataDir }) {
  const states = [];
  return {
    states,
    updater: createUpdater({
      current: "0.1.0-beta.1",
      kind: "test",
      platform: "darwin",
      arch: process.arch,
      allowed: true,
      base,
      publicKey: PUBLIC,
      dataDir,
      place: installPlace({ platform: "darwin", arch: process.arch, exe: "", target, homeDir: os.homedir() }),
      nodePath: process.execPath,
      helperFile: HELPER,
      transports,
      run: (file, args, options) => execFileSync(file, args, options),
      start: () => ({ pid: 1, unref() {} }),
      busy: () => null,
      confirm: async () => "yes",
      settings: { read: () => ({}), update: () => {} },
      quit: () => {},
      log: () => {},
      onState: (s) => states.push(s),
      env: {},
      pid: process.pid,
    }),
  };
}

mac("macOS: the zip is unpacked beside the app and the new bundle is checked; one of another kind is refused", async () => {
  const installed = mkdtempSync(path.join(T, "apps-"));
  const target = fakeBundle(installed, { version: "0.1.0-beta.1" });
  const zip = path.join(T, "new.zip");
  const asset = process.arch === "arm64" ? "busybar-emulator-mac-arm64.zip" : "busybar-emulator-mac-x64.zip";
  const newer = fakeBundle(mkdtempSync(path.join(T, "b2-")), { version: "0.1.0-beta.2" });
  release("0.1.0-beta.2", { asset: zipOf(newer, zip), name: asset });
  const u = macUpdater(target, { dataDir: mkdtempSync(path.join(T, "data-")) });
  u.updater.offer({ version: "0.1.0-beta.2", page: "p" });
  const ready = await u.updater.download();
  assert.equal(ready.state, "ready", JSON.stringify(ready));
  assert.equal(ready.bundle, path.join(path.dirname(target), ".busy-emulator-update-0.1.0-beta.2", "BUSY Bar Emulator.app"));
  assert.ok(existsSync(path.join(ready.bundle, "Contents", "Resources", "build.json")));

  // A release build offered to a test variant, and a bundle whose files changed after it was signed.
  for (const [what, make] of [
    ["a release of the same version", (dir) => fakeBundle(dir, { version: "0.1.0-beta.2", id: "app.busy.emulator", kind: "release" })],
    ["a bundle changed after signing", (dir) => {
      const app = fakeBundle(dir, { version: "0.1.0-beta.2" });
      writeFileSync(path.join(app, "Contents", "MacOS", "BUSY Bar Emulator"), "#!/bin/sh\necho changed\n");
      return app;
    }],
  ]) {
    const bad = make(mkdtempSync(path.join(T, "bad-")));
    release("0.1.0-beta.2", { asset: zipOf(bad, path.join(T, `bad-${Date.now()}.zip`)), name: asset });
    const v = macUpdater(target, { dataDir: mkdtempSync(path.join(T, "data-")) });
    v.updater.offer({ version: "0.1.0-beta.2", page: "p" });
    const after = await v.updater.download();
    assert.equal(after.state, "failed", what);
    assert.equal(after.code, "bad_bundle", what);
    assert.ok(!existsSync(path.join(path.dirname(target), ".busy-emulator-update-0.1.0-beta.2")), `${what}: nothing is left beside the app`);
  }
  assert.ok(existsSync(path.join(target, "Contents", "Info.plist")), "the installed app is untouched");
});

// ---------------------------------------------------------------- Windows: what else runs from the install folder

// An install folder (/D) named in another script and with a space (the check on the Windows machine had one in Cyrillic).
const INSTALL = "C:\\Users\\you\\AppData\\Local\\Programs\\Δοκιμή φάκελος\\BUSY Bar Emulator";
const inst = (rel) => `${INSTALL}\\${rel}`;
const NODE = inst("resources\\node\\node.exe");
const CLI = inst("resources\\emulator\\packages\\server\\cli\\busy-emulator.mjs");
const proc = (pid, ppid, exe, command = "") => ({ pid, ppid, exe, command });

test("Windows: the processes from the install folder that do not quit with the app are found and named", () => {
  const text = JSON.stringify([
    { ProcessId: 777, ParentProcessId: 10, ExecutablePath: inst("BUSY Bar Emulator.exe"), CommandLine: `"${inst("BUSY Bar Emulator.exe")}"` },
    { ProcessId: 778, ParentProcessId: 777, ExecutablePath: inst("BUSY Bar Emulator.exe"), CommandLine: "--type=renderer" },
    { ProcessId: 779, ParentProcessId: 777, ExecutablePath: NODE, CommandLine: "supervisor.mjs" },
    { ProcessId: 780, ParentProcessId: 779, ExecutablePath: NODE, CommandLine: "server.mjs" },
    { ProcessId: 800, ParentProcessId: 777, ExecutablePath: "C:\\Windows\\System32\\cmd.exe", CommandLine: "cmd.exe /k" },
    { ProcessId: 801, ParentProcessId: 800, ExecutablePath: NODE, CommandLine: `"${NODE}" "${CLI}" dev C:\\proj` },
    { ProcessId: 900, ParentProcessId: 899, ExecutablePath: "C:\\Users\\you\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe", CommandLine: "busy-emulator.exe mcp" },
    { ProcessId: 901, ParentProcessId: 900, ExecutablePath: NODE, CommandLine: `"${NODE}" "${CLI}" mcp` },
    { ProcessId: 4, ParentProcessId: 0, ExecutablePath: null, CommandLine: null },
    { ProcessId: 950, ParentProcessId: 1, ExecutablePath: "C:\\Users\\you\\AppData\\Local\\Programs\\Δοκιμή φάκελος\\BUSY Bar Emulator 2\\x.exe", CommandLine: "" },
  ]);
  const list = parseProcessList(`\uFEFF${text}\r\n`);
  assert.equal(list.length, 10);
  const others = othersInFolder(list, INSTALL, { appPid: 777 });
  // The app, its windows' helpers and its server quit with it; a command in a terminal it opened does not, and an
  // agent's MCP server does not. A folder whose name only starts the same is another folder.
  assert.deepEqual(others, [
    { pid: 801, what: "a busy-emulator dev command" },
    { pid: 901, what: "an agent's busy-emulator mcp" },
  ]);
  assert.deepEqual(othersInFolder(list, `${INSTALL.toUpperCase()}\\`, { appPid: 777 }).map((o) => o.pid), [801, 901], "letter case and a final backslash aside");
  // The command that asked ends with the answer; so does its launcher when that lies in the folder.
  const asked = [...list, proc(1001, 1000, inst("resources\\bin\\busy-emulator.exe"), "busy-emulator.exe update"), proc(1002, 1001, NODE, `"${NODE}" "${CLI}" update`)];
  assert.deepEqual(othersInFolder(asked, INSTALL, { appPid: 777, requester: 1002 }).map((o) => o.pid), [801, 901]);
  assert.deepEqual(othersInFolder(asked, INSTALL, { appPid: 777 }).map((o) => o.pid), [801, 901, 1001, 1002]);
  assert.deepEqual(parseProcessList(JSON.stringify({ ProcessId: 5, ParentProcessId: 1, ExecutablePath: NODE, CommandLine: "" })), [proc(5, 1, NODE, "")], "one process: PowerShell gives an object, not a list");

  assert.equal(whatRuns(proc(1, 0, inst("BUSY Bar Emulator.exe"), "")), "another BUSY Bar Emulator");
  assert.equal(whatRuns(proc(1, 0, inst("resources\\gh\\bin\\gh.exe"), "gh auth status")), "gh.exe");
  assert.deepEqual(folderInUseWords([{ pid: 901, what: "an agent's busy-emulator mcp" }]), {
    message: "An agent's busy-emulator mcp is running from the emulator's folder: end the agent session, then update.",
    hint: "The setup cannot replace the emulator's folder while it runs, so the emulator did not quit. Nothing was changed.",
  });
  assert.match(folderInUseWords(others).message, /^A busy-emulator dev command and an agent's busy-emulator mcp are running from the emulator's folder: end the agent session, then update\.$/);
  assert.match(folderInUseWords([{ pid: 801, what: "a busy-emulator dev command" }]).message, /let it finish or close it, then update/);
});

test("Windows: Restart with an agent's MCP server running from the folder is refused at once: nobody is asked, nothing quits", async () => {
  release("0.1.0-beta.2");
  const target = "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator";
  let mcp = true;
  const lists = [];
  const u = updaterFor({
    processes: async () => {
      lists.push(Date.now());
      return [proc(777, 1, `${target}\\BUSY Bar Emulator.exe`), ...(mcp ? [proc(901, 900, `${target}\\resources\\node\\node.exe`, "node busy-emulator.mjs mcp")] : [])];
    },
  });
  u.updater.offer({ version: "0.1.0-beta.2", page: "p" });
  await u.updater.download();
  const said = await u.updater.restart({ by: "window" });
  assert.equal(said.code, "in_use");
  assert.equal(said.message, "An agent's busy-emulator mcp is running from the emulator's folder: end the agent session, then update.");
  assert.equal(u.asks.length, 0, "the person is not asked for an update that cannot happen");
  assert.equal(u.started.length, 0);
  await wait(350);
  assert.equal(u.quits(), 0);
  assert.equal(u.updater.state.state, "ready", "the update stays ready");
  assert.equal(await u.updater.folderInUse().then((r) => r?.code), "in_use");

  // The agent session ended: the same Restart goes through, and the folder is looked at again after the person's yes.
  mcp = false;
  lists.length = 0;
  const done = await u.updater.restart({ by: "window" });
  assert.equal(done.ok, true, JSON.stringify(done));
  assert.equal(lists.length, 2, "once before the question and once after the yes");
  assert.equal(u.started.length, 1);

  // A list that cannot be read does not stop the update: the setup's own refusal and the helper's way back hold.
  const blind = updaterFor({ processes: async () => null });
  blind.updater.offer({ version: "0.1.0-beta.2", page: "p" });
  await blind.updater.download();
  assert.equal((await blind.updater.restart()).ok, true);
});
