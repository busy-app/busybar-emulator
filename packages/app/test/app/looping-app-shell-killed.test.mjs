// EMU-239 review, M1, and the codebase audit of 2026-11-11 (an app that loops for ever). Run from emulator/packages/app:
//   BUSY_APP_TEST_PORTS=8881-8889 node --test --test-force-exit test/app/looping-app-shell-killed.test.mjs
//
// An app on the bar that never returns (for (;;) {}) shares the server's only thread. The emulator's watchdog stops it
// after SLICE_LIMIT_MS (packages/server/runtime.mjs), as a long Back stops it on a bar, so a request made while it loops
// is answered once it has been stopped. The shell is then killed outright: the server, which is the supervisor
// (emu-239), learns that the shell is gone and ends, and does not stay on the bar's port. Before the watchdog the
// loop held the thread for ever, the request had no answer, and only the shell's death was checked here.
import assert from "node:assert/strict";
import { test } from "node:test";

import { alive, listening, PORTS, sleep, targz } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

// packages/server/runtime.mjs SLICE_LIMIT_MS; the server's module is not this package's to import.
const SLICE_LIMIT_MS = 2000;

test("an app on the bar loops for ever: the watchdog stops it and the server answers; the shell is killed: the server does not stay", { skip: (!HAS_REAL_SERVER && "the server is not beside this package") || (process.platform === "win32" && "macOS and Linux") }, async () => {
  const app = await launch({ server: "real" });
  let supervisor = 0;
  try {
    await app.waitState("ready");
    supervisor = (await app.run((shell) => shell.keeper.pids())).supervisor;
    const id = "app.probe.loop";
    const api = `http://127.0.0.1:${PORTS.app}/api/`;
    const manifest = JSON.stringify({ format_version: 1, id, name: "Loop", version: "0.1.0", api_version: "27.14.0", description: "Never returns", debug: false });
    const body = targz({ [`${id}/appmeta/manifest.json`]: manifest, [`${id}/scripts/main.js`]: "setTimeout(function () { for (;;) {} }, 500);\n" });
    const { install_key: key } = await (await fetch(`${api}apps/stage`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body })).json();
    assert.equal((await fetch(`${api}apps/install?install_key=${key}`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${api}apps/launch?app_id=${id}`, { method: "POST" })).status, 200);
    // The loop begins half a second after the launch; the watchdog stops it SLICE_LIMIT_MS later.
    await sleep(1000);
    const asked = performance.now();
    assert.equal((await fetch(`${api}version`, { signal: AbortSignal.timeout(SLICE_LIMIT_MS + 3000) })).status, 200, "answered once the app is stopped");
    assert.ok(performance.now() - asked > 300, "the request waited for the loop: the test did not see the hang");

    process.kill(app.pid, "SIGKILL");
    await app.exited;
    await sleep(10_000);
    assert.equal(alive(supervisor), false, "the server's process is still there 10 s after the shell was killed");
    assert.equal(await listening(PORTS.app), false, "the bar's port is still taken");
  } finally {
    if (supervisor && alive(supervisor)) process.kill(supervisor, "SIGKILL");
    await app.close().catch(() => {});
  }
});
