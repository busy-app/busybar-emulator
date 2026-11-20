// The update chain (EMU-341; ADR-0017, point 4): the built-in update taken by a person's copy release after release,
// three at least, and everything they keep in the emulator still there after each step. The first version installed
// as a person installs it and used: the first question answered, a project created from an example, built, run and
// its settings changed, a second folder trusted, an app installed straight on the BUSY Bar with its settings and a file
// of its data, the windows' storage written, and on a version with two firmwares the other one chosen. Then for each
// next version: it is published on a stand-in for GitHub's releases on this machine (update-chain/stand-in.mjs), the
// running copy is asked (busy-emulator update --check) and updates itself, by the window's two clicks (Update to
// <version>, Restart to update) on the first step and on odd ones, by busy-emulator update (the agent's way) on the
// others; the person's yes in the Restart dialog stands in (BUSY_EMULATOR_TEST_UPDATE_ANSWER: the windows are hidden).
// After each step: the new version runs at the same place, its data folder is of its format, and nothing a person
// keeps is lost (update-chain/data-checks.mjs, and the command line's own view: projects, settings); at the end the
// project builds and runs.
//
// The versions are the test variants update-chain/build.mjs makes (by default 0.1.0-beta.5, beta.6 and this tree's
// HEAD); they read BUSY_EMULATOR_DATA and BUSY_EMULATOR_USER_HOME, so nothing of the person's own (the data folder,
// ~/.busy-emulator, Applications, the GitHub CLI's settings) is touched. Hidden windows; ports 18880 (the BUSY Bar) and
// 18885 (the stand-in). On Windows run it in the desktop session (tools/gate/desktop-task.mjs). Not part of any suite.
//
//   node test/update-chain/build.mjs <work folder>        (once per system: builds the versions, writes chain.json)
//   node test/update-chain.mjs <work folder>               (the chain; writes update-chain-<system>-result.json there)
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { launch } from "./app/harness.mjs";
import { lostInUpdate, readState } from "./update-chain/data-checks.mjs";
import { startReleaseStandIn } from "./update-chain/stand-in.mjs";
import { until } from "./helpers.mjs";

const [work] = process.argv.slice(2);
if (!work || !existsSync(path.join(work, "chain.json"))) {
  console.error("node test/update-chain.mjs <work folder with chain.json from test/update-chain/build.mjs>");
  process.exit(2);
}
const chain = JSON.parse(readFileSync(path.join(work, "chain.json"), "utf8"));
const win = process.platform === "win32";
assert.equal(chain.platform, process.platform, "chain.json was built on another system");
assert.ok(chain.steps.length >= 2, "a chain is two versions at least");
const T = path.join(path.resolve(work), `run-${Date.now()}`);
const apps = path.join(T, "Applications");
const home = path.join(T, "home");
const data = path.join(T, "data");
const projects = path.join(T, "projects");
const gh = path.join(T, "gh");
for (const d of [apps, home, data, projects, gh]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(gh, "hosts.yml"), "github.com:\n    user: someone\n    oauth_token: not-a-token\n");
const PORT = 18880;
const BAR = `http://127.0.0.1:${PORT}`;
const APP = win ? path.join(apps, "BUSY Bar Emulator") : path.join(apps, "BUSY Bar Emulator.app");
const EXE = win ? path.join(APP, "BUSY Bar Emulator.exe") : path.join(APP, "Contents", "MacOS", "BUSY Bar Emulator");
// BUSY_EMULATOR_USER_HOME stands for the home on macOS and for %LOCALAPPDATA% on Windows.
const launcher = win ? path.join(home, "busy-emulator", "bin", "busy-emulator.exe") : path.join(home, ".busy-emulator", "bin", "busy-emulator");
const results = [];
const ok = (what, value = true) => (results.push([what, value]), console.log(`ok: ${what}${value === true ? "" : ` (${JSON.stringify(value)})`}`));
const t0 = Date.now();
const seconds = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;

const standIn = await startReleaseStandIn({ port: 18885, keyFile: path.join(T, "update-public.pem") });
const env = {
  ...standIn.env(),
  BUSY_EMULATOR_USER_HOME: home,
  BUSY_EMULATOR_TEST_GREETED: "",
  BUSY_EMULATOR_TEST_UPDATE_ANSWER: "yes",
  BUSY_EMULATOR_GH_CONFIG_DIR: gh,
  BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust",
};
const cliEnv = { ...process.env, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(PORT), BUSY_EMULATOR_USER_HOME: home };
const parse = (out) => {
  const parsed = JSON.parse(out);
  return { ...parsed, data: parsed.data ?? parsed };
};
const cli = (...args) => parse(execFileSync(launcher, [...args, "--json"], { env: cliEnv, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] }));
/** The same, without blocking this process: for a command the stand-in must answer while it runs. */
const cliAsync = (...args) =>
  new Promise((resolve, reject) => execFile(launcher, [...args, "--json"], { env: cliEnv, encoding: "utf8", timeout: 2_000_000 }, (e, out) => (e ? reject(Object.assign(e, { said: out })) : resolve(parse(out)))));
const running = (version) => {
  try {
    return cli("version").data.version === version && cli("status").data.running === true;
  } catch {
    return false;
  }
};

function request(method, url, body = null) {
  return new Promise((done, fail) => {
    const req = http.request(url, { method, agent: false, headers: { Connection: "close", ...(body ? { "Content-Length": body.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", fail);
    req.end(body ?? undefined);
  });
}
/** A .tgz as busy-cli packs an app (test/package.mjs, here without the server's tree). */
function targz(files) {
  const blocks = [];
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(type === "5" ? "0000755\0" : "0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const dirs = new Set();
  for (const name of Object.keys(files)) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  for (const dir of [...dirs].sort()) blocks.push(header(dir, 0, "5"));
  for (const [name, text] of Object.entries(files)) {
    const bytes = Buffer.from(text);
    blocks.push(header(name, bytes.length, "0"), bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
/** An app put on the BUSY Bar through its API, as a catalog app is: no project behind it. */
async function installOnTheBar(id) {
  const files = {
    [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.14.0" }),
    [`${id}/appmeta/settings.json`]: JSON.stringify({ format_version: 1, version: 1, fields: { minutes: { type: "integer", label: "Minutes", default: 25, min: 1, max: 180 } } }),
    [`${id}/scripts/main.js`]: "setInterval(function () {}, 1000);\n",
  };
  const staged = await request("POST", `${BAR}/api/apps/stage`, targz(files));
  assert.equal(staged.status, 200, staged.text);
  const installed = await request("POST", `${BAR}/api/apps/install?install_key=${JSON.parse(staged.text).install_key}`);
  assert.equal(installed.status, 200, installed.text);
  assert.equal((await request("PUT", `${BAR}/api/apps/settings?app_id=${id}`, Buffer.from('{"version":1,"values":{"minutes":45}}'))).status, 200);
  assert.equal((await request("POST", `${BAR}/api/storage/write?path=/ext/apps_data/js_apps/${id}/progress.json`, Buffer.from('{"sessions":7}\n'))).status, 200);
}

const hashOf = (dir) => createHash("sha256").update(readdirSync(dir).sort().map((n) => n + readFileSync(path.join(dir, n), "utf8")).join("|")).digest("hex");
const greetingShown = (app) => app.page(`(() => { const box = document.querySelector("#welcome"); return Boolean(box && !box.hidden); })()`);
const shown = (app, selector) => app.page(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && !el.hidden && el.closest("[hidden]") === null); })()`);
const text = (app, selector) => app.page(`document.querySelector(${JSON.stringify(selector)}).textContent.replace(/\\s+/g, " ").trim()`);
async function ready(app) {
  await app.waitWindow("device", 120_000);
  await until(() => app.page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected", 120_000);
}
const project = path.join(projects, "focus");
const copy = path.join(projects, "focus-copy");
const ON_BAR = "app.chain.probe";
/** What the command line says of the person's things: the projects and the project's settings. */
const cliView = () => ({ projects: cli("projects").data.projects.map((p) => ({ id: p.id, path: p.path })), settings: cli("settings", "get", project).data.settings });
const ghBefore = hashOf(gh);

/** The window's way: Update to <version>, then Restart to update. Resolves once the old version has quit. */
async function updateInTheWindow(app, next, oldPid) {
  await until(() => shown(app, "#update-go"), "the Update button", 60_000);
  await until(async () => (await text(app, "#update-go")) === `Update to ${next}`, `Update to ${next}`, 60_000);
  await app.click("#update-go");
  await until(async () => {
    const s = await app.run((shell) => shell.updater.state);
    return s.state === "ready" || s.state === "failed";
  }, "the download and its checks", 600_000, 100);
  const state = await app.run((shell) => shell.updater.state);
  assert.equal(state.state, "ready", JSON.stringify(state));
  await until(async () => (await text(app, "#update-go")) === "Restart to update", "Restart to update");
  await app.click("#update-go");
  await until(() => {
    try {
      return cli("status").data.pid !== oldPid;
    } catch {
      return true;
    }
  }, "the old version quit", 120_000, 500);
}

let app;
let exitCode = 0;
const steps = [];
try {
  // ------------------------------------------------------------------ the first version, installed and used
  const first = chain.steps[0];
  if (win) execFileSync(first.file, ["/S", "/NoShortcut", `/LOG=${path.join(T, "setup-1.log")}`, `/D=${APP}`], { stdio: "ignore", timeout: 300_000 });
  else execFileSync("/usr/bin/ditto", [first.app, APP]);
  app = await launch({ executable: EXE, server: "bundled", port: PORT, dataDir: data, env });
  await ready(app);
  assert.equal(cli("version").data.version, first.version);
  ok(`${first.version} runs from the install folder; its command line answers at the fixed path`, APP);
  await until(() => greetingShown(app), "the greeting", 30_000);
  await app.click('[data-choice="agent"]');
  await until(() => readState(data).welcomed, "the greeting answered");
  if (await greetingShown(app)) await app.click("#welcome .welcome-close");
  await until(async () => !(await greetingShown(app)), "the greeting closed");
  await app.page(`localStorage.setItem("update-chain-probe", "kept")`);
  cli("create", project, "--example", "focus-timer");
  cli("build", project);
  ok("project created, built, installed and started", cli("run", project).data.running);
  cli("settings", "set", project, "minutes=40", "tree=sakura");
  cpSync(project, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  cli("trust", copy, "--wait", "30");
  await installOnTheBar(ON_BAR);
  ok("an app installed on the BUSY Bar, its settings and data written", ON_BAR);
  if (first.format >= 2) {
    cli("firmware", "use", "previous");
    ok("the other firmware chosen", readState(data).chosenFirmware);
  }
  let before = { files: readState(data), cli: cliView() };
  console.log("before:", JSON.stringify(before));

  // ------------------------------------------------------------------ each next version
  for (let i = 1; i < chain.steps.length; i++) {
    const next = chain.steps[i];
    const from = chain.steps[i - 1].version;
    const how = i % 2 === 1 ? "window" : "command line";
    const began = Date.now();
    standIn.publish({ version: next.version, asset: next.file, name: chain.asset });
    const check = await cliAsync("update", "--check");
    assert.equal(check.data.available, next.version, JSON.stringify(check.data));
    assert.equal(check.data.can_update, true, JSON.stringify(check.data));
    ok(`${from}: update --check finds ${next.version} and can update itself`);
    const oldPid = cli("status").data.pid;
    if (how === "window") await updateInTheWindow(app, next.version, oldPid);
    else {
      const answer = await cliAsync("update");
      assert.equal(answer.data.version, next.version, JSON.stringify(answer.data));
    }
    await until(() => running(next.version), `${next.version} running`, 240_000, 1000);
    // The harness's test entry is still open; the new version connected to it, as the old one did.
    await until(() => app.run((_shell, electron) => electron.app.getVersion()).then((v) => v === next.version).catch(() => false), `the test entry reaches ${next.version}`, 60_000, 500);
    await ready(app);
    ok(`${from} -> ${next.version} (${how}): the new version runs at the same place, started by the helper`, seconds());

    const after = { files: readState(data), cli: cliView() };
    console.log("after:", JSON.stringify(after));
    assert.equal(after.files.format, next.format, `the data folder is of ${next.version}'s format`);
    const lost = lostInUpdate(before.files, after.files, { version: next.version });
    assert.deepEqual(lost, [], `${from} -> ${next.version} lost what it must keep`);
    assert.deepEqual(after.cli, before.cli, "the command line's projects and settings");
    assert.ok(after.files.apps[ON_BAR] && Object.keys(after.files.apps).length >= Object.keys(before.files.apps).length);
    assert.equal(await greetingShown(app), false);
    assert.equal(await app.page(`localStorage.getItem("update-chain-probe")`), "kept");
    ok("apps with their files, settings and data; projects, trust, the first answer, the windows' storage, install.json at the same paths", Object.keys(after.files.apps));
    const helper = path.join(data, "tmp", `update-${next.version}`, "helper.log");
    const helperLog = existsSync(helper) ? readFileSync(helper, "utf8") : "";
    if (!win) {
      await until(() => !readdirSync(apps).some((n) => n.startsWith(".busy-emulator-update-")), "the old bundle and the staging folder gone", 60_000);
      execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", APP]);
      ok("macOS: only the app is in Applications, and it passes codesign --verify", readdirSync(apps));
    } else {
      assert.match(helperLog, /setup \(try \d+\): exit code 0/);
      ok("Windows: the setup ran silently over the install", helperLog.match(/setup \(try \d+\): exit code \d+/g));
    }
    assert.deepEqual(standIn.askedFor(next.version).sort(), [chain.asset, "update.json", "update.json.sig"].sort());
    steps.push({ from, to: next.version, how, seconds: Math.round((Date.now() - began) / 1000) });
    before = after;
  }

  assert.equal((await app.run((shell) => shell.updater.state)).state, "none");
  ok("the last version offers no update for itself");
  cli("build", project);
  ok("the project builds and runs on the last version", cli("run", project).data.running);
  assert.equal(hashOf(gh), ghBefore);
  ok("the GitHub CLI's settings untouched");
  cli("quit");
  await until(() => {
    try {
      return cli("status").data.running === false;
    } catch {
      return false;
    }
  }, "the last version quit", 60_000, 1000);
  console.log(`\nALL OK in ${seconds()}: ${chain.steps.map((s) => s.version).join(" -> ")}`);
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
  await standIn.close();
  writeFileSync(path.join(work, `update-chain-${win ? "win" : "mac"}-result.json`), `${JSON.stringify({ T, versions: chain.steps.map((s) => s.version), steps, results, asked: standIn.asked, ok: exitCode === 0 }, null, 2)}\n`);
  process.exit(exitCode);
}
