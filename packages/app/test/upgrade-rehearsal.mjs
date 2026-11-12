// The upgrade rehearsal before a hotfix (docs/release.md, "Hotfix during the hackathon"): the previous version installed
// as a person installs it, used (the first question answered, a project created, its app built, run and its settings
// changed, a second folder trusted, the windows' storage written), then the new version put over it the way a person
// does (macOS: the app dragged from its dmg onto the old one, Replace; Windows: the setup run into the same folder,
// first while the old one runs, which it must refuse), and everything checked again. Both are test variants built by
// tools/dist.mjs (--kind test; on macOS in a dmg made by packaging/macos.mjs dmgApp, on Windows in a setup.exe made by
// packaging/windows.mjs buildSetup): they read BUSY_EMULATOR_DATA and BUSY_EMULATOR_USER_HOME, so nothing of the
// person's own (the data folder, ~/.busy-emulator, Applications) is touched. Hidden windows, ports 18700 and 18705.
// The new version is expected to be 0.1.0-beta.2 with a step from format 1 to 2 that writes notes/format-2.txt (the
// fake of 12.11); change those checks for a real pair. On Windows run it in the desktop session
// (tools/gate/desktop-task.mjs). Not part of any suite.
//
//   node test/upgrade-rehearsal.mjs <emulator folder> <old .dmg | setup.exe> <new .dmg | setup.exe> <work folder>
// (the harness is this tree's own, imported beside this file; the first argument is kept for the old call)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import path from "node:path";

import { launch } from "./app/harness.mjs";
import { until } from "./helpers.mjs";

const [, dmg1, dmg2, work] = process.argv.slice(2);

const T = path.join(work, `run-${Date.now()}`);
const apps = path.join(T, "Applications");
const home = path.join(T, "home");
const data = path.join(T, "data");
const projects = path.join(T, "projects");
const gh = path.join(T, "gh");
for (const d of [apps, home, data, projects, gh]) mkdirSync(d, { recursive: true });
writeFileSync(path.join(gh, "hosts.yml"), "github.com:\n    user: someone\n    oauth_token: not-a-token\n");
const PORT = 18700;
const win = process.platform === "win32";
const APP = win ? path.join(apps, "BUSY Bar Emulator") : path.join(apps, "BUSY Bar Emulator.app");
const EXE = win ? path.join(APP, "BUSY Bar Emulator.exe") : path.join(APP, "Contents", "MacOS", "BUSY Bar Emulator");
// BUSY_EMULATOR_USER_HOME stands for the home on macOS and for %LOCALAPPDATA% on Windows.
const launcher = win ? path.join(home, "busy-emulator", "bin", "busy-emulator.exe") : path.join(home, ".busy-emulator", "bin", "busy-emulator");
const results = [];
const ok = (what, value = true) => (results.push([what, value]), console.log(`ok: ${what}${value === true ? "" : ` (${JSON.stringify(value)})`}`));

// The stand-in for GitHub's latest release.
let latest = "v0.1.0-beta.2";
let asked = 0;
const standIn = http.createServer((req, res) => {
  asked += 1;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ tag_name: latest }));
});
await new Promise((r) => standIn.listen(18705, "127.0.0.1", r));
const UPDATE_URL = "http://127.0.0.1:18705/repos/busy-app/busybar-emulator/releases/latest";

/** The setup, silent, into the same folder: what a person's setup does, without the shortcut and the Apps entry. */
function setup(exe) {
  try {
    execFileSync(exe, ["/S", "/NoShortcut", `/LOG=${path.join(T, "setup.log")}`, `/D=${APP}`], { stdio: "ignore", timeout: 300_000 });
    return 0;
  } catch (e) {
    return e.status;
  }
}

/** What a person does with a dmg: open it, drag the app onto Applications (Replace: the old bundle goes, the new comes). */
function dragFrom(dmg) {
  if (win) {
    const code = setup(dmg);
    assert.equal(code, 0, `setup exit code ${code}: ${readFileSync(path.join(T, "setup.log"), "utf8").slice(-1500)}`);
    return;
  }
  const mnt = path.join(T, "mnt");
  mkdirSync(mnt, { recursive: true });
  execFileSync("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, dmg], { stdio: "ignore" });
  try {
    rmSync(APP, { recursive: true, force: true });
    execFileSync("/usr/bin/ditto", [path.join(mnt, "BUSY Bar Emulator.app"), APP]);
  } finally {
    execFileSync("/usr/bin/hdiutil", ["detach", mnt, "-force"], { stdio: "ignore" });
  }
}

const env = {
  BUSY_EMULATOR_USER_HOME: home,
  BUSY_EMULATOR_TEST_GREETED: "",
  BUSY_EMULATOR_UPDATE_URL: UPDATE_URL,
  BUSY_EMULATOR_GH_CONFIG_DIR: gh,
  BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust",
};
const start = () => launch({ executable: EXE, server: "bundled", port: PORT, dataDir: data, env });
const cliEnv = { ...process.env, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(PORT), BUSY_EMULATOR_USER_HOME: home };
function cli(...args) {
  const out = execFileSync(launcher, [...args, "--json"], { env: cliEnv, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"] });
  const parsed = JSON.parse(out);
  return { ...parsed, data: parsed.data ?? parsed };
}
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const hashOf = (dir) => createHash("sha256").update(readdirSync(dir).sort().map((n) => n + readFileSync(path.join(dir, n), "utf8")).join("|")).digest("hex");
const greetingShown = (app) => app.page(`(() => { const box = document.querySelector("#welcome"); return Boolean(box && !box.hidden); })()`);
async function ready(app) {
  await app.waitWindow("device", 90_000);
  await until(() => app.page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected", 90_000);
}
const notice = (app) => app.run((shell) => shell.updates?.notice ?? null);

const project = path.join(projects, "focus");
const copy = path.join(projects, "focus-copy");
const ghBefore = hashOf(gh);
let app;
try {
  // ------------------------------------------------------------------ beta.1
  dragFrom(dmg1);
  app = await start();
  await ready(app);
  const v1 = cli("version");
  assert.match(JSON.stringify(v1), /0\.1\.0-beta\.1/);
  ok("beta.1 runs; its command line answers at the fixed path", launcher);
  await until(() => greetingShown(app), "the greeting", 30_000);
  await app.click('[data-choice="agent"]');
  await until(() => existsSync(path.join(data, "app-settings.json")) && readJson(path.join(data, "app-settings.json")).welcomed === true, "the greeting answered");
  ok("first-run greeting answered on beta.1");
  await until(async () => (await notice(app))?.version === "0.1.0-beta.2", "beta.1 told about beta.2", 30_000);
  ok("beta.1 shows the notice of beta.2", await notice(app));
  await app.page(`localStorage.setItem("upgrade-path-probe", "kept")`);

  cli("create", project, "--example", "focus-timer");
  ok("project created on beta.1");
  cli("build", project);
  const ran = cli("run", project);
  ok("app built, installed and started", ran.data);
  cli("settings", "set", project, "minutes=40", "tree=sakura");
  const set = cli("settings", "get", project);
  ok("settings changed", set.data?.settings ?? set.data);
  cpSync(project, copy, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  const trusted = cli("trust", copy, "--wait", "30");
  ok("a second folder trusted (dialog answered)", trusted.data?.trusted ?? trusted.data);
  const before = {
    projects: cli("projects").data.projects.map((p) => ({ id: p.id, path: p.path })),
    settings: cli("settings", "get", project).data.settings ?? cli("settings", "get", project).data,
    trust: readJson(path.join(data, "projects", "trusted.json")).projects.map((p) => [p.path, p.how]),
    install: readJson(path.join(data, "install.json")),
    apps: readdirSync(path.join(data, "bar", "1.3.1", "ext", "user_assets")).sort(),
  };
  console.log("before:", JSON.stringify(before, null, 1));
  if (win) {
    const exeBefore = readFileSync(EXE).length + ":" + readFileSync(path.join(APP, "resources", "build.json"), "utf8");
    const code = setup(dmg2);
    assert.equal(code, 3, `setup over the running app: exit code ${code}`);
    assert.equal(readFileSync(EXE).length + ":" + readFileSync(path.join(APP, "resources", "build.json"), "utf8"), exeBefore);
    assert.match(cli("version").data ? JSON.stringify(cli("version")) : "", /0\.1\.0-beta\.1/);
    ok("setup over the running app refuses (exit 3) and leaves the app as it was", readFileSync(path.join(T, "setup.log"), "utf8").trim().split("\n").slice(-2).join(" | "));
  }
  await app.quit();
  await app.close();
  app = null;
  assert.equal(readFileSync(path.join(data, "format"), "utf8"), "1\n");

  // ------------------------------------------------------------------ beta.2 dragged over
  dragFrom(dmg2);
  ok(win ? "beta.2 setup run over beta.1" : "beta.2 dragged over beta.1");
  const askedBefore = asked;
  app = await start();
  await ready(app);
  assert.equal(readFileSync(path.join(data, "format"), "utf8"), "2\n");
  assert.equal(readFileSync(path.join(data, "notes", "format-2.txt"), "utf8"), "moved\n");
  assert.match(app.log(), /moved from format 1 to 2: a note of the move/);
  ok("data folder moved from format 1 to 2 by the step, said in the log");
  const v2 = cli("version");
  assert.match(JSON.stringify(v2), /0\.1\.0-beta\.2/);
  ok("the same launcher path now runs beta.2", launcher);
  const after = {
    projects: cli("projects").data.projects.map((p) => ({ id: p.id, path: p.path })),
    settings: cli("settings", "get", project).data.settings ?? cli("settings", "get", project).data,
    trust: readJson(path.join(data, "projects", "trusted.json")).projects.map((p) => [p.path, p.how]),
    install: readJson(path.join(data, "install.json")),
    apps: readdirSync(path.join(data, "bar", "1.3.1", "ext", "user_assets")).sort(),
  };
  console.log("after:", JSON.stringify(after, null, 1));
  assert.deepEqual(after.projects, before.projects);
  ok("project list kept");
  assert.deepEqual(after.settings, before.settings);
  ok("app settings kept");
  assert.deepEqual(after.trust, before.trust);
  ok("trust kept");
  assert.deepEqual(after.apps, before.apps);
  ok("apps on the bar kept", after.apps);
  assert.equal(after.install.version, "0.1.0-beta.2");
  assert.equal(after.install.cli, before.install.cli);
  assert.equal(after.install.app, before.install.app);
  ok("install.json: same cli and app path, version beta.2");
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(await greetingShown(app), false);
  ok("greeting not asked again");
  assert.equal(await app.page(`localStorage.getItem("upgrade-path-probe")`), "kept");
  ok("window storage kept");
  await until(() => asked > askedBefore, "beta.2 asks at its first start", 30_000);
  ok("beta.2 asked for the latest release at its first start, within the day", asked - askedBefore);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await notice(app), null);
  ok("beta.2 shows no notice for beta.2");
  cli("build", project);
  const ran2 = cli("run", project);
  ok("the project builds and runs on beta.2", ran2.data);
  await app.quit();
  await app.close();
  app = null;

  // Second start of beta.2 on the same day: no request; a hotfix is learned of the next day.
  latest = "v0.1.0-beta.3";
  const asked2 = asked;
  app = await start();
  await ready(app);
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(asked, asked2);
  ok("a second start of the same version within the day asks nothing");
  await app.quit();
  await app.close();
  app = null;
  assert.equal(hashOf(gh), ghBefore);
  ok("gh configuration untouched");
  console.log("\nALL OK");
} catch (e) {
  console.error("FAILED:", e);
  if (app) console.error("log tail:", app.log().slice(-3000));
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  standIn.close();
  writeFileSync(path.join(work, "rehearsal-mac-result.json"), JSON.stringify({ T, results }, null, 2));
}
