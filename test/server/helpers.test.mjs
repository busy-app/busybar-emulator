// What the server's tests share (helpers.mjs) puts away what a test made in the right order: the processes a test
// started end before the test's folders are removed. A server under test writes into its data folder until it is
// ended, and a folder removed under it came back half removed (ENOTEMPTY; EMU-294, the gate of 13.11).
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { finish, node, tempDir, until } from "./helpers.mjs";

after(finish);

// Writes files into a folder of WRITE_TO as fast as it can, until it is ended.
const WRITER = "const fs = require('node:fs'); const dir = require('node:path').join(process.env.WRITE_TO, 'w'); for (let i = 0; ; i++) { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/' + (i % 500), 'x'); } catch {} }";

test("a test's folder is removed after the processes the test started in it have ended", async (t) => {
  let dir = null;
  let writer = null;
  // The folder first, then the process that writes there, as a test makes a server's data folder and then starts it.
  await t.test("a process that writes into its folder until the end", async (inner) => {
    dir = tempDir(inner);
    writer = node(inner, ["-e", WRITER], { env: { ...process.env, WRITE_TO: dir } });
    await until("the first file", () => existsSync(join(dir, "w")) && readdirSync(join(dir, "w")).length > 0);
  });
  assert.equal(writer.exitCode ?? writer.signalCode, "SIGKILL", "the writer ended with its test");
  assert.equal(existsSync(dir), false, "the folder is removed");
});
