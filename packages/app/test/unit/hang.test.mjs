// A test that hangs is a red result, not a run that never ends, and nothing of it is left: no process, no folder, no
// port. The time limit and the forced end are in the scripts of package.json; the cleaning up is in helpers.mjs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { loadHelpersAgain, runHanging, testFlags } from "../hanging.mjs";
import { listening, PORTS, removeFolder, survivors } from "../helpers.mjs";

test("every script has a time limit and ends its process when the limit is reached", () => {
  for (const script of ["test", "test:unit", "test:app"]) {
    const flags = testFlags(script);
    assert.ok(flags.some((flag) => /^--test-timeout=\d+$/.test(flag)), `${script}: no --test-timeout`);
    assert.ok(flags.includes("--test-force-exit"), `${script}: no --test-force-exit`);
  }
});

test("a test file that hangs is cut off and red, and leaves no process, folder or port", async () => {
  const port = PORTS.other;
  const run = await runHanging({ HANG_PORT: String(port) }, 20_000);
  assert.ok(run.report, `the hanging file did not get as far as hanging: ${run.out.slice(-800)}`);
  assert.notEqual(run.code, 0, "a hang must be a red result");
  assert.equal(run.signal, null, "the run had to be killed: it would have hung");
  assert.match(run.out, /timed out after 20000ms/);
  assert.deepEqual(await survivors(run.report.pids), [], "processes left by the cut-off file");
  assert.equal(await listening(port), false, "the port is still taken");
  if (existsSync(run.report.folder)) {
    assert.equal(process.platform, "win32", "the folder of the cut-off file is left");
    await loadHelpersAgain();
  }
  assert.equal(existsSync(run.report.folder), false, "the folder of the cut-off file is left");
  await removeFolder(run.folder);
});
