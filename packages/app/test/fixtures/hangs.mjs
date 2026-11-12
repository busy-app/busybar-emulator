// A test file that hangs, for test/unit/hang.test.mjs and test/app/hang.test.mjs: it starts what the shell's tests
// start — a helper process, a server through the supervisor, or the app itself (HANG_WITH=app) — writes what it
// started to HANG_REPORT and then waits forever, as a test whose app went away under it does.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { startServerProcess } from "../../src/server-process.mjs";
import { endOnExit, FAKE_SERVER, NODE, SUPERVISOR, temporaryFolder, until } from "../helpers.mjs";

test("hangs", async () => {
  const port = Number(process.env.HANG_PORT);
  const report = {};
  if (process.env.HANG_WITH === "app") {
    const { launch } = await import("../app/harness.mjs");
    const app = await launch({ port, env: { FAKE_SERVER_CHILD: "stubborn" } });
    await app.waitWindow("device");
    Object.assign(report, { folder: app.folder, pids: await app.pids() });
  } else {
    const folder = temporaryFolder();
    const helper = endOnExit(spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true }));
    const fakeReport = path.join(folder, "report.json");
    let ready = false;
    const run = startServerProcess({
      nodePath: NODE,
      supervisorPath: SUPERVISOR,
      serverEntry: FAKE_SERVER,
      serverOptions: { port, dataDir: folder },
      env: { ...process.env, FAKE_SERVER_CHILD: "stubborn", FAKE_SERVER_REPORT: fakeReport },
      onLine: () => {},
      onReady: () => (ready = true),
    });
    await until(() => ready && existsSync(fakeReport), "the server");
    Object.assign(report, { folder, pids: [helper.pid, run.pid, JSON.parse(readFileSync(fakeReport, "utf8")).child] });
  }
  writeFileSync(process.env.HANG_REPORT, JSON.stringify(report));
  await new Promise(() => {});
});
