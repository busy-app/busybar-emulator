// A test of the app that hangs is cut off and red, and the app it started goes with it: no Electron process, no
// supervisor, nothing the server started, no folder and no listener left (test/unit/hang.test.mjs has the same for a
// server without the app).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { CHROMIUM_GONE_WITHIN_MS, describeProcess, listening, PORTS, removeFolder, survivors } from "../helpers.mjs";
import { loadHelpersAgain, runHanging } from "../hanging.mjs";

test("a test of the app that hangs is cut off, and the app, its server and its folder go with it", async () => {
  const run = await runHanging({ HANG_WITH: "app", HANG_PORT: String(PORTS.app) }, 45_000);
  assert.ok(run.report, `the hanging file did not get as far as hanging: ${run.out.slice(-800)}`);
  assert.notEqual(run.code, 0);
  assert.equal(run.signal, null, "the run had to be killed: it would have hung");
  assert.ok(run.report.pids.length >= 4, `the app's processes: ${run.report.pids}`);
  const left = await survivors(run.report.pids, CHROMIUM_GONE_WITHIN_MS);
  assert.deepEqual(left, [], `processes left by the cut-off test: ${left.map(describeProcess).join(", ")}`);
  assert.equal(await listening(PORTS.app), false);
  if (existsSync(run.report.folder) && process.platform === "win32") await loadHelpersAgain();
  assert.equal(existsSync(run.report.folder), false, "the folder of the cut-off test is left");
  await removeFolder(run.folder);
});
