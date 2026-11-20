// A window test file whose first test hangs, for test/app/cascade.test.mjs (EMU-330): as the development loop's test
// did on Windows, it leaves a process the app started and a handle of its own open, and never ends by itself. Its
// second test starts the app again on the same port. Writes what the first test made to CASCADE_REPORT.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import net from "node:net";

import { test } from "../app/node-test.mjs";
import { launch } from "../app/harness.mjs";
import { alive, NODE, PORTS } from "../helpers.mjs";

const port = Number(process.env.CASCADE_PORT || PORTS.app);
const limit = Number(process.env.CASCADE_TEST_MS);

test("hangs, and leaves a process of the app's and a server of its own", { timeout: limit }, async (t) => {
  const app = await launch({ port });
  t.after(() => app.close());
  await app.waitWindow("device");
  // A process the app's main process started and nobody ends: when the app quits it stays, as the development loop's
  // command line did when the app went before it. Detached: on Windows libuv puts every child it starts in a job object
  // that ends it with its parent (so a plain child goes with the app, and the harness finds nothing left); a detached
  // one breaks away from the job, as a process the app's children start outside it can.
  const stray = await app.run(async (_shell, _electron, node) => {
    const { spawn } = await import("node:child_process");
    const child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true, detached: true });
    child.unref();
    return child.pid;
  }, NODE);
  // A handle that keeps the test's process alive: the stand-in for GitHub that an after hook would have closed.
  net.createServer().listen(0, "127.0.0.1");
  writeFileSync(process.env.CASCADE_REPORT, JSON.stringify({ stray, folder: app.folder, pids: await app.pids() }));
  await new Promise(() => {});
});

test("the next test starts the app again on the same port", async () => {
  const app = await launch({ port });
  try {
    await app.waitWindow("device");
    assert.equal(alive(app.pid), true);
  } finally {
    await app.close();
  }
});
