// The update's helper (EMU-221, src/update-helper.mjs): the plans it refuses, and on macOS the swap itself run for
// real on two small bundles whose executables are scripts: the new one comes up and the old one goes; a new one that
// ends at once is taken out and the old one put back and started.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { planProblem, stillTheUpdate } from "../../src/update-helper.mjs";

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "update-helper.mjs");
const T = realpathSync(mkdtempSync(path.join(os.tmpdir(), "update-helper-test-")));
after(() => rmSync(T, { recursive: true, force: true }));

function macPlan(root, version = "0.1.0-beta.2") {
  const apps = path.posix.join(root, "Applications");
  const folder = path.posix.join(root, "data", "tmp", `update-${version}`);
  const target = path.posix.join(apps, "BUSY Bar Emulator.app");
  const staging = path.posix.join(apps, `.busy-emulator-update-${version}`);
  return {
    token: randomBytes(16).toString("hex"),
    pid: 1,
    platform: "darwin",
    version,
    from: "0.1.0-beta.1",
    target,
    exe: path.posix.join(target, "Contents", "MacOS", "BUSY Bar Emulator"),
    staging,
    bundle: path.posix.join(staging, "BUSY Bar Emulator.app"),
    previous: path.posix.join(staging, "previous", "BUSY Bar Emulator.app"),
    started: path.posix.join(folder, "started"),
    result: path.posix.join(folder, "result.json"),
    log: path.posix.join(folder, "helper.log"),
    folder,
  };
}

test("a plan that is not the update's own is refused before anything is touched", () => {
  const plan = macPlan("/r");
  const planFile = path.posix.join(plan.folder, "plan.json");
  const ok = { token: plan.token, platform: "darwin", planFile };
  assert.equal(planProblem(plan, ok), null);
  assert.match(planProblem(plan, { ...ok, token: "x".repeat(32) }), /token/);
  assert.match(planProblem(plan, { ...ok, platform: "win32" }), /another system/);
  assert.match(planProblem(plan, { ...ok, planFile: "/elsewhere/plan.json" }), /not in its update's folder/);
  assert.match(planProblem({ ...plan, target: "/Users/you/Documents" }, ok), /not BUSY Bar Emulator\.app/);
  assert.match(planProblem({ ...plan, target: "/System/BUSY Bar Emulator.app" }, ok), /staging folder is not beside/);
  assert.match(planProblem({ ...plan, bundle: "/tmp/Evil.app" }, ok), /new bundle/);
  assert.match(planProblem({ ...plan, previous: "/tmp/x/BUSY Bar Emulator.app" }, ok), /old bundle/);
  assert.match(planProblem({ ...plan, exe: "/bin/sh" }, ok), /executable/);
  assert.match(planProblem({ ...plan, result: "/etc/result.json" }, ok), /result/);
  assert.match(planProblem({ ...plan, pid: -1 }, ok), /no process/);

  const folder = "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator\\tmp\\update-0.1.0-beta.2";
  const win = { token: plan.token, pid: 5, platform: "win32", version: "0.1.0-beta.2", target: "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator", exe: "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\BUSY Bar Emulator.exe", setup: `${folder}\\busybar-emulator-win-x64-setup.exe`, setupSha256: "b".repeat(64), setupLog: `${folder}\\setup.log`, started: `${folder}\\started`, result: `${folder}\\result.json`, log: `${folder}\\helper.log` };
  const winOk = { token: plan.token, platform: "win32", planFile: `${folder}\\plan.json` };
  assert.equal(planProblem(win, winOk), null);
  assert.match(planProblem({ ...win, setup: "C:\\Users\\you\\Downloads\\setup.exe" }, winOk), /setup is not the update's/);
  assert.match(planProblem({ ...win, exe: "C:\\Windows\\System32\\cmd.exe" }, winOk), /executable/);
  assert.match(planProblem({ ...win, setupSha256: undefined }, winOk), /SHA-256 is not given/);
  assert.match(planProblem({ ...win, setupSha256: "B".repeat(64) }, winOk), /SHA-256 is not given/);
});

// The macOS steps run a real bundle swap: on macOS alone, a named reason elsewhere (the gate counts a skip without one).
const mac = process.platform === "darwin" ? test : (name, ...rest) => test(name, { skip: "macOS only: the app's bundle is swapped" }, rest.at(-1));

/** A small bundle whose executable is a script, signed ad hoc as a release's is (the helper checks the signature again). */
function bundle(at, script) {
  mkdirSync(path.join(at, "Contents", "MacOS"), { recursive: true });
  const exe = path.join(at, "Contents", "MacOS", "BUSY Bar Emulator");
  writeFileSync(exe, script);
  chmodSync(exe, 0o755);
  writeFileSync(path.join(at, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>BUSY Bar Emulator</string><key>CFBundleIdentifier</key><string>app.busy.emulator.test-variant</string></dict></plist>\n`);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", at], { stdio: "ignore" });
}

/** Runs the helper on `plan` while a short-lived process stands for the app; resolves with the helper's exit code. */
async function runHelper(plan) {
  mkdirSync(plan.folder, { recursive: true });
  const planFile = path.join(plan.folder, "plan.json");
  const app = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
  const written = { ...plan, pid: app.pid };
  delete written.folder;
  writeFileSync(planFile, JSON.stringify(written), { mode: 0o600 });
  const helper = spawn(process.execPath, [HELPER, planFile, plan.token], { stdio: "ignore", env: { ...process.env, STARTED_FILE: plan.started, TOKEN: plan.token, MARKS: path.dirname(plan.folder) } });
  const code = await new Promise((resolve) => helper.on("exit", resolve));
  assert.ok(!existsSync(planFile), "the plan is used once");
  return code;
}

const until = async (check, what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

mac("macOS: the new bundle goes in, starts and says so; the old one goes", async () => {
  const plan = macPlan(path.join(T, "good"));
  bundle(plan.target, `#!/bin/sh\necho old > "$MARKS/ran-old"\n`);
  bundle(plan.bundle, `#!/bin/sh\necho new > "$MARKS/ran-new"\nprintf '%s\\n' "$TOKEN" > "$STARTED_FILE"\nsleep 1\n`);
  assert.equal(await runHelper(plan), 0);
  const result = JSON.parse(readFileSync(plan.result, "utf8"));
  assert.deepEqual(result, { ok: true, version: "0.1.0-beta.2" });
  assert.match(readFileSync(plan.exe, "utf8"), /ran-new/, "the new version is in the app's place");
  assert.ok(existsSync(path.join(path.dirname(plan.folder), "ran-new")));
  assert.ok(!existsSync(path.join(path.dirname(plan.folder), "ran-old")));
  assert.ok(!existsSync(plan.staging), "the old version and the staging folder are gone");
  assert.match(readFileSync(plan.log, "utf8"), /has started: the old version goes/);
});

mac("macOS: a new version that ends before it is up is taken out, and the old one is put back and started", async () => {
  const plan = macPlan(path.join(T, "back"));
  bundle(plan.target, `#!/bin/sh\necho old > "$MARKS/ran-old"\n`);
  bundle(plan.bundle, "#!/bin/sh\nexit 3\n");
  assert.equal(await runHelper(plan), 0);
  const result = JSON.parse(readFileSync(plan.result, "utf8"));
  assert.equal(result.ok, false);
  assert.equal(result.code, "did_not_start");
  assert.match(result.message, /did not start, so the emulator went back to 0\.1\.0-beta\.1/);
  assert.match(readFileSync(plan.exe, "utf8"), /ran-old/, "the old version is back in its place");
  await until(() => existsSync(path.join(path.dirname(plan.folder), "ran-old")), "the old version started again");
});

mac("a plan whose token is not the one given is refused, and nothing moves", async () => {
  const plan = macPlan(path.join(T, "token"));
  bundle(plan.target, "#!/bin/sh\nexit 0\n");
  bundle(plan.bundle, "#!/bin/sh\nexit 0\n");
  mkdirSync(plan.folder, { recursive: true });
  const planFile = path.join(plan.folder, "plan.json");
  writeFileSync(planFile, JSON.stringify({ ...plan, pid: process.pid }));
  const helper = spawn(process.execPath, [HELPER, planFile, "x".repeat(32)], { stdio: "ignore" });
  assert.equal(await new Promise((resolve) => helper.on("exit", resolve)), 2);
  assert.match(readFileSync(plan.result, "utf8"), /refused its plan: the token/);
  assert.ok(existsSync(plan.bundle) && existsSync(plan.target), "nothing moved");
});

mac("macOS: a new bundle changed after the app checked it is not put in; the old one stays and starts again", async () => {
  const plan = macPlan(path.join(T, "changed"));
  bundle(plan.target, `#!/bin/sh\necho old > "$MARKS/ran-old"\n`);
  bundle(plan.bundle, `#!/bin/sh\necho new > "$MARKS/ran-new"\n`);
  writeFileSync(path.join(plan.bundle, "Contents", "MacOS", "BUSY Bar Emulator"), "#!/bin/sh\necho changed\n");
  assert.equal(await runHelper(plan), 0);
  const result = JSON.parse(readFileSync(plan.result, "utf8"));
  assert.equal(result.code, "bad_bundle");
  assert.match(result.message, /changed after the emulator checked it/);
  assert.match(readFileSync(plan.exe, "utf8"), /ran-old/, "the old version is where it was");
  assert.ok(!existsSync(plan.staging), "the changed bundle is removed");
  await until(() => existsSync(path.join(path.dirname(plan.folder), "ran-old")), "the old version started again");
});

test("Windows: the setup is checked against the manifest's SHA-256 right before it runs", async () => {
  const file = path.join(T, "setup.exe");
  writeFileSync(file, "the setup");
  const sum = createHash("sha256").update("the setup").digest("hex");
  assert.equal(await stillTheUpdate({ platform: "win32", setup: file, setupSha256: sum }), true);
  writeFileSync(file, "another setup");
  assert.equal(await stillTheUpdate({ platform: "win32", setup: file, setupSha256: sum }), false);
  assert.equal(await stillTheUpdate({ platform: "win32", setup: path.join(T, "gone.exe"), setupSha256: sum }), false);
});
