// When a process started, as the command line and the data folder's lock read it (process-info.mjs, audit B5): the
// same in any time zone the caller has. Before, the command line read `ps` in the caller's zone, so with TZ=Asia/Dubai
// it was 4 hours off, and `status`, `start` and `quit` did not know the running emulator.
//
//   node --test emulator/packages/server/test/process-info.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { processInfo as cliProcessInfo } from "../cli/system.mjs";
import { processInfo as lockProcessInfo } from "../data-folder.mjs";
import { parsePs, processInfo, processInfoSync } from "../process-info.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = (file) => pathToFileURL(path.join(here, "..", file)).href;

test("one processInfo for the command line and the data folder", () => {
  assert.equal(cliProcessInfo, processInfoSync);
  assert.equal(lockProcessInfo, processInfo);
  assert.deepEqual(parsePs("Wed Nov 11 03:12:44 2026 /usr/local/bin/node"), { start: Date.UTC(2026, 10, 11, 3, 12, 44), exe: "/usr/local/bin/node" });
  assert.deepEqual(parsePs("Sun Nov  1 23:59:59 2026 /opt/Zoë/node"), { start: Date.UTC(2026, 10, 1, 23, 59, 59), exe: "/opt/Zoë/node" });
  assert.equal(parsePs(""), null);
});

for (const zone of ["Asia/Dubai", "America/New_York", "UTC", "Pacific/Chatham"]) {
  test(`with TZ=${zone} a process's start is when it started`, async () => {
    // Where the start must lie, both on the system's clock: after this process asked for the child (the system notes
    // a process's start when it is made), and before the child read it. The child's own idea of its start
    // (Date.now() - process.uptime()) is not that: Node counts from its own setup, which on a loaded machine comes
    // seconds after the system made the process (the gate, 12.11: 3 to 6 s, "0 min off"). A time zone read wrongly
    // is hours off (Chatham, 13 h 45 min), far outside.
    const code = `
      const { processInfo } = await import(${JSON.stringify(url("cli/system.mjs"))});
      const { processInfo: lock } = await import(${JSON.stringify(url("data-folder.mjs"))});
      const sync = processInfo(process.pid);
      const async = await lock(process.pid);
      console.log(JSON.stringify({ read: Date.now(), sync: sync?.start ?? null, async: async?.start ?? null }));
    `;
    const asked = Date.now();
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ: zone }, stdio: ["ignore", "pipe", "inherit"] });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(text));
    });
    const { read, sync, async } = JSON.parse(out);
    assert.ok(sync !== null && async !== null, out);
    // `ps` gives whole seconds, cut down: the start it says may be up to a second before the moment it was asked for.
    const from = Math.floor(asked / 1000) * 1000;
    const within = (start) => start >= from && start <= read;
    const off = (start) => `${Math.round((start < from ? start - from : start - read) / 1000)} s outside ${new Date(from).toISOString()} to ${new Date(read).toISOString()}`;
    assert.ok(within(sync), `the command line's: ${off(sync)}`);
    assert.ok(within(async), `the data folder's: ${off(async)}`);
  });
}
