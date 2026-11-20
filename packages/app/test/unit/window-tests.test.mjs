// Every window test file takes its test and hooks from test/app/node-test.mjs, which gives each of them a time limit
// (EMU-330): a test of the window that hangs fails alone, and its file ends in minutes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_TESTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

test("every window test file takes test() and its hooks from node-test.mjs, none from node:test", () => {
  const files = readdirSync(APP_TESTS).filter((name) => name.endsWith(".test.mjs"));
  assert.ok(files.length > 30, `window test files: ${files.length}`);
  const wrong = files.filter((name) => {
    const text = readFileSync(path.join(APP_TESTS, name), "utf8");
    return /from\s+["']node:test["']/.test(text) || !/from\s+["']\.\/node-test\.mjs["']/.test(text);
  });
  assert.deepEqual(wrong, []);
});

test("a context's hooks and subtests get the window tests' limits; the test's place is its line and column; describe is refused", async () => {
  const { describe, HOOK_TIMEOUT_MS, limitedContext, TEST_TIMEOUT_MS } = await import("../app/node-test.mjs");
  const calls = [];
  const fake = { name: "fake", after: (fn, options) => calls.push(["after", options]), before: (fn, options) => calls.push(["before", options]), test: (name, options) => calls.push(["test", options]), diagnostic(text) { calls.push(["diagnostic", text, this === fake]); } };
  const t = limitedContext(fake);
  t.after(() => {});
  t.before(() => {}, { timeout: 5 });
  t.test("sub", () => {});
  t.diagnostic("said");
  assert.equal(t.name, "fake");
  assert.deepEqual(calls, [["after", { timeout: HOOK_TIMEOUT_MS }], ["before", { timeout: 5 }], ["test", { timeout: TEST_TIMEOUT_MS }], ["diagnostic", "said", true]]);
  assert.throws(() => describe("x", () => {}), /no describe or suite/);

  // A file whose test() is indented, and a test.skip: TAP names each by its own line and column.
  const dir = mkdtempSync(path.join(os.tmpdir(), "node-test-place-"));
  try {
    const file = path.join(dir, "place.test.mjs");
    const helper = pathToFileURL(path.join(APP_TESTS, "node-test.mjs")).href;
    // TAP gives the place of a test that fails: these two fail on purpose.
    writeFileSync(file, `import { test } from ${JSON.stringify(helper)};\nif (true) {\n   test("indented", (t) => { t.after(() => {}); throw new Error("here"); });\n}\ntest.todo("to do", () => { throw new Error("not yet"); });\ntest.skip("skipped", () => {});\n`);
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", file], { encoding: "utf8", env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")) });
    assert.match(run.stdout, /location: '.*place\.test\.mjs:3:4'/, run.stdout);
    assert.match(run.stdout, /location: '.*place\.test\.mjs:5:6'/, run.stdout);
    assert.match(run.stdout, /^ok 3 - skipped # SKIP/m, run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
