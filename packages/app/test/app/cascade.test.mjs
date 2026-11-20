// A window test that hangs fails alone, and its file ends in minutes (EMU-330): on 17.11 on Windows one test of the
// development loop that waited for a line which never came left the loop's process running, six tests after it failed
// on what it left, and the file held the app suite until the suite's 40 minutes were up. Here a file whose first test
// hangs (fixtures/cascade.mjs) leaves a process of the app's and a handle of its own: the test fails at its own limit,
// the harness ends the app's whole tree of processes, the next test starts the app on the same port and passes, and
// the file's process ends although a handle is still open (--test-force-exit).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { test } from "./node-test.mjs";
import { runHanging } from "../hanging.mjs";
import { alive, PORTS, removeFolder, temporaryFolder } from "../helpers.mjs";

const TEST_MS = 30_000;

test("a window test that hangs fails alone: the app's processes are ended, the next test runs, the file ends", async () => {
  const mine = temporaryFolder();
  const report = path.join(mine, "cascade.json");
  const run = await runHanging({ CASCADE_PORT: String(PORTS.app), CASCADE_TEST_MS: String(TEST_MS), CASCADE_REPORT: report }, 4 * 60_000, "cascade.mjs", "test:app");
  try {
    assert.ok(existsSync(report), `the first test did not get as far as hanging: ${run.out.slice(-1500)}`);
    assert.equal(run.signal, null, "the run had to be killed: the file did not end");
    assert.ok(run.ms < 3 * 60_000, `the file took ${run.ms} ms`);
    assert.match(run.out, /^not ok 1 - hangs, and leaves a process/m);
    assert.match(run.out, /test timed out after 30000ms/);
    // The failure names the test's own place, not node-test.mjs, which made the call.
    const line = readFileSync(new URL("../fixtures/cascade.mjs", import.meta.url), "utf8").split("\n").findIndex((one) => one.startsWith('test("hangs')) + 1;
    assert.match(run.out, new RegExp(`location: '.*cascade\\.mjs:${line}:1'`));
    assert.match(run.out, /harness: ended 1 processes the app left: \d+ \(.*setInterval/, "the stray process was found as the app's");
    assert.match(run.out, /^ok 2 - the next test starts the app again on the same port/m);
    // Node 22 counts a test cut off at its limit on a line of its own, Node 24 among the failed ones.
    const count = (word) => Number(new RegExp(`^# ${word} (\\d+)$`, "m").exec(run.out)?.[1] ?? NaN);
    assert.deepEqual([count("pass"), count("fail") + count("cancelled")], [1, 1]);
    const { stray } = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(alive(stray), false, `the process the app left (${stray}) still runs`);
  } finally {
    await removeFolder(mine);
    await removeFolder(run.folder);
  }
});
