// Windows: `busy-emulator start` started inside a job object that kills its members when it closes — as an agent's
// sandbox may run its commands (EMU-157) — leaves an emulator that outlives the job. The emulator is a stand-in
// without a window (test/fixtures/windows/fake-app.*) in a laid-out app; it listens on 127.0.0.1 only.
//
// Explorer starts programs in the desktop session of the user, so the test needs one: it runs only with
// BUSY_EMULATOR_TEST_DESKTOP=1, set by a run in the logged-in session (a scheduled task with /it), never over SSH.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { compileCSharp } from "../../tools/windows-launcher.mjs";
import { layOutApp } from "../fixtures/layout.mjs";
import { alive, APP_DIR, listening, PORTS, removeFolder, survivors, temporaryFolder, until } from "../helpers.mjs";

const skip = (process.platform !== "win32" || process.env.BUSY_EMULATOR_TEST_DESKTOP !== "1") && "Windows, in a desktop session (BUSY_EMULATOR_TEST_DESKTOP=1)";
const FIXTURES = path.join(APP_DIR, "test", "fixtures", "windows");

let folder;
let app;
let jobrun;
let data;

before(async () => {
  if (skip) return;
  folder = temporaryFolder();
  app = await layOutApp(folder);
  const appFolder = path.dirname(app.resources);
  compileCSharp(path.join(FIXTURES, "fake-app.cs"), path.join(appFolder, "BUSY Bar Emulator.exe"), { target: "winexe" });
  copyFileSync(path.join(FIXTURES, "fake-app.mjs"), path.join(appFolder, "fake-app.mjs"));
  data = path.join(folder, "data");
  writeFileSync(path.join(appFolder, "fake-app.json"), JSON.stringify({ dataDir: data, port: PORTS.cli }));
  jobrun = compileCSharp(path.join(FIXTURES, "jobrun.cs"), path.join(folder, "jobrun.exe"));
});

after(async () => {
  if (skip) return;
  for (const file of ["fake-app.pid"]) {
    try {
      const pid = Number(readFileSync(path.join(path.dirname(app.resources), file), "utf8"));
      if (alive(pid)) process.kill(pid);
    } catch {
      // Never started.
    }
  }
  await removeFolder(folder);
});

function run(program, args, env = {}) {
  const child = spawn(program, args, { env: { ...process.env, BUSY_EMULATOR_DATA: data, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

test("start from inside a job that kills its members: the emulator outlives the job, and quit ends it", { skip }, async () => {
  const started = await run(jobrun, [app.launcher, "start", "--json"]);
  assert.equal(started.code, 0, `${started.stdout} ${started.stderr}`);
  const answer = JSON.parse(started.stdout.trim());
  assert.equal(answer.already_running, false);
  // The job has closed with jobrun; the command line in it is gone, the emulator is not.
  const fakePid = Number(readFileSync(path.join(path.dirname(app.resources), "fake-app.pid"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.ok(alive(answer.pid), "the emulator died with the job");
  assert.ok(alive(fakePid));
  assert.equal(await listening(PORTS.cli), true);
  const status = JSON.parse((await run(app.launcher, ["status", "--json"])).stdout.trim());
  assert.equal(status.running, true);

  const quit = await run(app.launcher, ["quit", "--json"]);
  assert.equal(JSON.parse(quit.stdout.trim()).was_running, true);
  assert.deepEqual(await survivors([answer.pid, fakePid]), []);
  await until(async () => !(await listening(PORTS.cli)), "the port to be free");
});

test("without Explorer — a process started from Node — the same command would die with the job", { skip }, async () => {
  // What start must not do, shown: the test's own way of launching is a detached child of the command line.
  const appFolder = path.dirname(app.resources);
  const launch = JSON.stringify([path.join(appFolder, "BUSY Bar Emulator.exe")]);
  const started = await run(jobrun, [app.launcher, "start", "--json"], { BUSY_EMULATOR_TEST_LAUNCH: launch });
  assert.equal(started.code, 0, `${started.stdout} ${started.stderr}`);
  const answer = JSON.parse(started.stdout.trim());
  assert.deepEqual(await survivors([answer.pid], 10_000), [], "a child of the command line outlived the job");
  await until(async () => !(await listening(PORTS.cli)), "the port to be free");
});
