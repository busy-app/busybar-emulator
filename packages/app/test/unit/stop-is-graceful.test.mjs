// Stopping is a request, not a kill: the shell closes the supervisor's standard input, the supervisor calls the
// server's stop(), and the process is gone in milliseconds. The forced end after 5 s (server-process.mjs) or 4 s
// (supervisor.mjs) is only the fallback — and a stop that needs the fallback is a failure this test can see, where a
// generous limit elsewhere would hide it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { startServerProcess } from "../../src/server-process.mjs";
import { FAKE_SERVER, listening, NODE, PORTS, removeFolder, SUPERVISOR, survivors, temporaryFolder, until } from "../helpers.mjs";

const PORT = PORTS.unit;
let folder;
let started;
beforeEach(() => {
  folder = temporaryFolder();
  started = [];
});
afterEach(async () => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
  assert.deepEqual(await survivors(started), []);
  assert.equal(await listening(PORT), false);
  await removeFolder(folder);
});

test("stop is the gentle way: the server's own stop() ends it, well before any forced end", async () => {
  const report = path.join(folder, "report.json");
  const run = startServerProcess({
    nodePath: NODE,
    supervisorPath: SUPERVISOR,
    serverEntry: FAKE_SERVER,
    serverOptions: { port: PORT, dataDir: folder },
    env: { ...process.env, FAKE_SERVER_REPORT: report, FAKE_SERVER_CHILD: "1" },
    onLine: () => {},
  });
  started.push(run.pid);
  const { child } = await until(() => existsSync(report) && JSON.parse(readFileSync(report, "utf8")), "the fake server's report");
  started.push(child);

  const t0 = Date.now();
  await run.stop();
  const end = await run.exited;
  const took = Date.now() - t0;
  assert.ok(took < 1500, `stop took ${took} ms: the gentle path did not work, the forced end did`);
  assert.deepEqual({ code: end.code, stopped: end.stopped, said: end.said }, { code: 0, stopped: true, said: true }, "the supervisor did not say the server stopped");
  assert.ok(existsSync(`${report}.stopped`), "the server's stop() did not run");
  assert.deepEqual(await survivors([run.pid, child], 3000), []);
});
