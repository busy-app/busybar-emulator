// The rehearsal of the built-in update (EMU-221), the proof that a person's beta.1 becomes beta.2 by two clicks: the
// old version installed as a person installs it and used (the first question answered, a project created, built, run
// and its settings changed, a second folder trusted, the windows' storage written), then Update to 0.1.0-beta.2 and
// Restart to update clicked in its window, with a stand-in for GitHub's release on this machine: its latest release,
// its update.json signed with a key of the rehearsal's own and this system's file. The person's yes in the Restart
// dialog stands in (BUSY_EMULATOR_TEST_UPDATE_ANSWER: the windows are hidden). Then: the old app quits, the helper puts
// the new version in place and starts it, the new version runs at the same place, moves the data folder to its
// format 2 and has everything the old one had; the update's files are gone.
//
// Both versions are test variants built by tools/dist.mjs (--kind test): they read BUSY_EMULATOR_DATA and
// BUSY_EMULATOR_USER_HOME, so nothing of the person's own (the data folder, ~/.busy-emulator, Applications) is touched.
// beta.1 must hold the updater; beta.2 is expected to be the fake of 12.11 (version 0.1.0-beta.2 and a step from
// format 1 to 2 that writes notes/format-2.txt). Hidden windows; ports 18870 (the bar) and 18875 (the stand-in).
// On Windows run it in the desktop session (tools/gate/desktop-task.mjs). Not part of any suite.
//
//   node test/update-rehearsal.mjs <beta.1: .app or setup.exe> <beta.2: its zip or setup.exe> <work folder>
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { manifestBytes, signManifest } from "../src/update-manifest.mjs";
import { launch } from "./app/harness.mjs";
import { until } from "./helpers.mjs";

const [old, newer, work] = process.argv.slice(2);
if (!old || !newer || !work) {
  console.error("node test/update-rehearsal.mjs <beta.1: .app or setup.exe> <beta.2: its zip or setup.exe> <work folder>");
  process.exit(2);
}
const win = process.platform === "win32";
const T = path.join(path.resolve(work), `run-${Date.now()}`);
const apps = path.join(T, "Applications");
const home = path.join(T, "home");
const data = path.join(T, "data");
const projects = path.join(T, "projects");
const gh = path.join(T, "gh");
for (const d of [apps, home, data, projects, gh]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(gh, "hosts.yml"), "github.com:\n    user: someone\n    oauth_token: not-a-token\n");
const PORT = 18870;
const STAND_IN = 18875;
const APP = win ? path.join(apps, "BUSY Bar Emulator") : path.join(apps, "BUSY Bar Emulator.app");
const EXE = win ? path.join(APP, "BUSY Bar Emulator.exe") : path.join(APP, "Contents", "MacOS", "BUSY Bar Emulator");
const launcher = win ? path.join(home, "busy-emulator", "bin", "busy-emulator.exe") : path.join(home, ".busy-emulator", "bin", "busy-emulator");
const ASSET = win ? "busybar-emulator-win-x64-setup.exe" : process.arch === "arm64" ? "busybar-emulator-mac-arm64.zip" : "busybar-emulator-mac-x64.zip";
const results = [];
const ok = (what, value = true) => (results.push([what, value]), console.log(`ok: ${what}${value === true ? "" : ` (${JSON.stringify(value)})`}`));
const t0 = Date.now();
const seconds = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

// ---------------------------------------------------------------- the stand-in for GitHub's release
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyFile = path.join(T, "update-public.pem");
writeFileSync(keyFile, publicKey.export({ type: "spki", format: "pem" }));
const assetBytes = readFileSync(newer);
const manifest = manifestBytes({ version: "0.1.0-beta.2", assets: [{ name: ASSET, size: assetBytes.length, sha256: createHash("sha256").update(assetBytes).digest("hex") }] });
const served = {
  "/repos/busy-app/busybar-emulator/releases/latest": Buffer.from(JSON.stringify({ tag_name: "v0.1.0-beta.2" })),
  "/download/v0.1.0-beta.2/update.json": manifest,
  "/download/v0.1.0-beta.2/update.json.sig": Buffer.from(signManifest(manifest, privateKey)),
  [`/download/v0.1.0-beta.2/${ASSET}`]: assetBytes,
};
const asked = [];
const standIn = http.createServer((req, res) => {
  asked.push(req.url);
  const body = served[req.url];
  res.writeHead(body ? 200 : 404, { "content-length": String(body?.length ?? 0) });
  res.end(body ?? "");
});
await new Promise((r) => standIn.listen(STAND_IN, "127.0.0.1", r));

/** The setup, silent, into the folder: what a person's setup does, without the shortcut and the Apps entry. */
function setup(exe) {
  try {
    execFileSync(exe, ["/S", "/NoShortcut", `/LOG=${path.join(T, "setup.log")}`, `/D=${APP}`], { stdio: "ignore", timeout: 300_000 });
    return 0;
  } catch (e) {
    return e.status;
  }
}

const env = {
  BUSY_EMULATOR_USER_HOME: home,
  BUSY_EMULATOR_TEST_GREETED: "",
  BUSY_EMULATOR_UPDATE_URL: `http://127.0.0.1:${STAND_IN}/repos/busy-app/busybar-emulator/releases/latest`,
  BUSY_EMULATOR_UPDATE_RELEASES: `http://127.0.0.1:${STAND_IN}/download`,
  BUSY_EMULATOR_TEST_UPDATE_KEY: keyFile,
  BUSY_EMULATOR_TEST_UPDATE_ANSWER: "yes",
  BUSY_EMULATOR_GH_CONFIG_DIR: gh,
  BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust",
};
const cliEnv = { ...process.env, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(PORT), BUSY_EMULATOR_USER_HOME: home };
function cli(...args) {
  const out = execFileSync(launcher, [...args, "--json"], { env: cliEnv, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out);
  return { ...parsed, data: parsed.data ?? parsed };
}
/** The same, without blocking this process: for a command the stand-in above must answer while it runs. */
function cliAsync(...args) {
  return new Promise((resolve, reject) =>
    execFile(launcher, [...args, "--json"], { env: cliEnv, encoding: "utf8", timeout: 600_000 }, (e, out) => {
      if (e) return reject(Object.assign(e, { said: out }));
      const parsed = JSON.parse(out);
      resolve({ ...parsed, data: parsed.data ?? parsed });
    }),
  );
}
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const hashOf = (dir) => createHash("sha256").update(readdirSync(dir).sort().map((n) => n + readFileSync(path.join(dir, n), "utf8")).join("|")).digest("hex");
const greetingShown = (app) => app.page(`(() => { const box = document.querySelector("#welcome"); return Boolean(box && !box.hidden); })()`);
const shown = (app, selector) => app.page(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && !el.hidden && el.closest("[hidden]") === null); })()`);
const text = (app, selector) => app.page(`document.querySelector(${JSON.stringify(selector)}).textContent.replace(/\\s+/g, " ").trim()`);
async function ready(app) {
  await app.waitWindow("device", 120_000);
  await until(() => app.page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected", 120_000);
}
const update = (app) => app.run((shell) => shell.updater.state);
function snapshot() {
  return {
    projects: cli("projects").data.projects.map((p) => ({ id: p.id, path: p.path })),
    settings: cli("settings", "get", path.join(projects, "focus")).data.settings,
    trust: readJson(path.join(data, "projects", "trusted.json")).projects.map((p) => [p.path, p.how]),
    install: readJson(path.join(data, "install.json")),
    apps: readdirSync(path.join(data, "bar", "1.3.1", "ext", "user_assets")).sort(),
  };
}

const project = path.join(projects, "focus");
const copy = path.join(projects, "focus-copy");
const ghBefore = hashOf(gh);
let app;
let exitCode = 0;
try {
  // ------------------------------------------------------------------ beta.1, installed and used
  if (win) assert.equal(setup(old), 0, "the setup of beta.1");
  else execFileSync("/usr/bin/ditto", [old, APP]);
  app = await launch({ executable: EXE, server: "bundled", port: PORT, dataDir: data, env });
  await ready(app);
  assert.match(JSON.stringify(cli("version")), /0\.1\.0-beta\.1/);
  ok("beta.1 runs from the install folder; its command line answers at the fixed path", APP);
  await until(() => greetingShown(app), "the greeting", 30_000);
  await app.click('[data-choice="agent"]');
  await until(() => existsSync(path.join(data, "app-settings.json")) && readJson(path.join(data, "app-settings.json")).welcomed === true, "the greeting answered");
  // The agent's way shows the text for an agent; the person closes the greeting after reading it.
  if (await greetingShown(app)) await app.click("#welcome .welcome-close");
  await until(async () => !(await greetingShown(app)), "the greeting closed");
  await app.page(`localStorage.setItem("update-rehearsal-probe", "kept")`);
  cli("create", project, "--example", "focus-timer");
  cli("build", project);
  ok("project created, built, installed and started on beta.1", cli("run", project).data.running);
  cli("settings", "set", project, "minutes=40", "tree=sakura");
  cpSync(project, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  cli("trust", copy, "--wait", "30");
  const before = snapshot();
  console.log("before:", JSON.stringify(before));

  // ------------------------------------------------------------------ Update to 0.1.0-beta.2
  await until(() => shown(app, "#update-go"), "the Update button", 60_000);
  assert.equal(await text(app, "#update-go"), "Update to 0.1.0-beta.2");
  ok("the window offers Update to 0.1.0-beta.2", seconds());
  const check = await cliAsync("update", "--check");
  assert.equal(check.data.available, "0.1.0-beta.2");
  assert.equal(check.data.can_update, true);
  ok("busy-emulator update --check: beta.2 is out and this copy can update itself");
  const where = await app.page(`(() => { const r = document.querySelector("#update-go").getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], view: [innerWidth, innerHeight], under: at ? at.id || at.className || at.tagName : null, onButton: Boolean(at && at.closest("#update-go")) }; })()`);
  console.log("the Update button:", JSON.stringify(where));
  assert.ok(where.onButton, "the Update button is not covered");
  await app.click("#update-go");
  let sawProgress = false;
  await until(async () => {
    const s = await update(app);
    if (s.state === "downloading" && (await shown(app, "#update-progress"))) sawProgress = true;
    return s.state === "ready" || s.state === "failed";
  }, "the download and its checks", 600_000, 100);
  const readyState = await update(app);
  assert.equal(readyState.state, "ready", JSON.stringify(readyState));
  ok(`downloaded, signature and SHA-256 checked${win ? "" : ", unpacked beside the app and its bundle checked"}`, { progressShown: sawProgress, at: seconds() });
  await until(async () => (await text(app, "#update-go")) === "Restart to update", "Restart to update");
  ok("the window offers Restart to update");

  // ------------------------------------------------------------------ Restart to update
  const oldPid = app.pid;
  await app.click("#update-go");
  await until(() => /question \(update to 0\.1\.0-beta\.2\): answered by the test's stand-in \(yes\)/.test(app.log()), "the person's yes");
  const gone = await Promise.race([app.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 90_000))]);
  assert.ok(gone, "beta.1 quit");
  ok("the person said yes; beta.1 quit", { pid: oldPid, at: seconds() });

  // ------------------------------------------------------------------ beta.2, started by the helper
  await until(() => {
    try {
      return /0\.1\.0-beta\.2/.test(JSON.stringify(cli("version"))) && cli("status").data.running === true;
    } catch {
      return false;
    }
  }, "beta.2 running", 240_000, 1000);
  ok("beta.2 runs at the same place, started by the helper", seconds());
  // The harness's test entry is still open; the new version connected to it, as the old one did.
  await until(() => app.run((_shell, electron) => electron.app.getVersion()).then((v) => v === "0.1.0-beta.2").catch(() => false), "the test entry reaches beta.2", 60_000, 500);
  await ready(app);
  assert.equal(readFileSync(path.join(data, "format"), "utf8"), "2\n");
  assert.equal(readFileSync(path.join(data, "notes", "format-2.txt"), "utf8"), "moved\n");
  ok("data folder moved from format 1 to 2 by beta.2's step");
  const after = snapshot();
  console.log("after:", JSON.stringify(after));
  assert.deepEqual(after.projects, before.projects);
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.trust, before.trust);
  assert.deepEqual(after.apps, before.apps);
  assert.equal(after.install.version, "0.1.0-beta.2");
  assert.equal(after.install.cli, before.install.cli);
  assert.equal(after.install.app, before.install.app);
  ok("projects, app settings, trust, apps on the bar kept; install.json names beta.2 at the same paths", after.apps);
  assert.equal(await greetingShown(app), false);
  assert.equal(await app.page(`localStorage.getItem("update-rehearsal-probe")`), "kept");
  ok("greeting not asked again; window storage kept");
  const folder = path.join(data, "tmp", "update-0.1.0-beta.2");
  const helperLog = existsSync(path.join(folder, "helper.log")) ? readFileSync(path.join(folder, "helper.log"), "utf8") : "";
  console.log("helper log:\n" + helperLog);
  if (!win) {
    await until(() => !readdirSync(apps).some((n) => n.startsWith(".busy-emulator-update-")), "the old bundle and the staging folder gone", 60_000);
    ok("macOS: the old bundle is gone once beta.2 started; only the app is in Applications", readdirSync(apps));
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", APP]);
    ok("the bundle in place passes codesign --verify");
  } else {
    assert.match(helperLog, /setup \(try \d+\): exit code 0/);
    ok("Windows: the setup ran silently over the install", helperLog.match(/setup \(try \d+\): exit code \d+/g));
  }
  assert.match(helperLog, /has started|result: \{"ok":true/);
  assert.equal((await update(app)).state, "none");
  ok("beta.2 offers no update for itself");
  cli("build", project);
  ok("the project builds and runs on beta.2", cli("run", project).data.running);
  assert.equal(hashOf(gh), ghBefore);
  ok("gh configuration untouched");
  cli("quit");
  await until(() => {
    try {
      return cli("status").data.running === false;
    } catch {
      return false;
    }
  }, "beta.2 quit", 60_000, 1000);
  console.log(`\nALL OK in ${seconds()}`);
} catch (e) {
  console.error("FAILED:", e);
  if (app) console.error("log tail:", app.log().slice(-4000));
  exitCode = 1;
} finally {
  try {
    cli("quit");
  } catch {
    // not running
  }
  await app?.close().catch((e) => console.error("close:", e.message));
  standIn.close();
  writeFileSync(path.join(work, `update-rehearsal-${win ? "win" : "mac"}-result.json`), JSON.stringify({ T, results, asked }, null, 2));
  process.exit(exitCode);
}
