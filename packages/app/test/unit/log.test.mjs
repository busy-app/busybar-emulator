import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { createLog, createRefusalLog, LINE_LIMIT, LOG_LIMIT_BYTES, REFUSALS_PER_MINUTE, shortAddress } from "../../src/log.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const folder = temporaryFolder();
after(() => removeFolder(folder));

test("lines are appended with the time, and the folder is made", () => {
  const file = path.join(folder, "a", "logs", "shell.log");
  const log = createLog(file);
  log("one");
  log("two");
  const lines = readFileSync(file, "utf8").split("\n");
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z one$/);
  assert.match(lines[1], / two$/);
});

test("a log past the limit is put aside at the next start, one old file is kept", () => {
  const file = path.join(folder, "b", "shell.log");
  createLog(file)("first run");
  writeFileSync(file, "x".repeat(LOG_LIMIT_BYTES + 1));
  createLog(file)("second run");
  assert.equal(readFileSync(`${file}.1`, "utf8").length, LOG_LIMIT_BYTES + 1);
  assert.match(readFileSync(file, "utf8"), / second run\n$/);
  assert.ok(readFileSync(file, "utf8").length < 200);
});

test("a log that cannot be written does not throw", () => {
  const blocked = path.join(folder, "c");
  writeFileSync(blocked, "a file where the folder should be");
  const log = createLog(path.join(blocked, "logs", "shell.log"));
  assert.doesNotThrow(() => log("nowhere"));
  assert.equal(existsSync(path.join(blocked, "logs")), false);
});

test("the limit holds while the app runs: past it the file is put aside and begun anew", () => {
  const file = path.join(folder, "d", "shell.log");
  const log = createLog(file, { limit: 1000 });
  for (let i = 0; i < 500; i++) log(`line ${i} ${"x".repeat(40)}`);
  assert.ok(readFileSync(file, "utf8").length <= 1000, "the file is past its limit");
  assert.ok(readFileSync(`${file}.1`, "utf8").length <= 1000, "the old file is past the limit");
  assert.match(readFileSync(file, "utf8"), /line 499 x+\n$/);
  // The default limit is the one the start checks.
  const big = path.join(folder, "e", "shell.log");
  const second = createLog(big);
  for (let i = 0; i < 3000; i++) second("y".repeat(1000));
  assert.ok(readFileSync(big, "utf8").length <= LOG_LIMIT_BYTES);
});

test("a line longer than the limit is cut and says by how much", () => {
  const file = path.join(folder, "f", "shell.log");
  createLog(file)("z".repeat(LINE_LIMIT + 123));
  const line = readFileSync(file, "utf8");
  assert.match(line, /z… \(123 more characters\)\n$/);
  assert.ok(line.length < LINE_LIMIT + 100);
});

test("an address in the log: scheme, host and the start of the path; no query, no user, no content", () => {
  assert.equal(shortAddress("http://127.0.0.1:8640/emulator"), "http://127.0.0.1:8640/emulator");
  assert.equal(shortAddress("https://user:secret@example.com/a/b?token=abc#x"), "https://example.com/a/b (and a query)");
  assert.equal(shortAddress(`https://example.com/${"p".repeat(500)}`), `https://example.com/${"p".repeat(199)}…`);
  assert.equal(shortAddress(`data:text/html,${"q".repeat(100)}`), "data: (115 characters)");
  assert.equal(shortAddress("javascript:alert(1)"), "javascript: (19 characters)");
  assert.equal(shortAddress("::"), "(not an address, 2 characters)");
});

test("refusals: so many a minute of each kind, then counted, and the count is written when the next minute begins", () => {
  const lines = [];
  let now = 0;
  const refused = createRefusalLog((line) => lines.push(line), { now: () => now });
  for (let i = 0; i < 100; i++) refused("window", `window ${i}`);
  for (let i = 0; i < 3; i++) refused("permission", `permission ${i}`);
  assert.equal(lines.length, REFUSALS_PER_MINUTE + 3);
  assert.equal(lines[REFUSALS_PER_MINUTE - 1], `window ${REFUSALS_PER_MINUTE - 1}`);
  now = 60_000;
  refused("window", "window again");
  assert.deepEqual(lines.slice(-2), [`[shell] ${100 - REFUSALS_PER_MINUTE} more refusals of the kind "window" were not written down`, "window again"]);
});

test("making the log touches nothing: a second launch that writes no line does not put aside the first one's file", () => {
  const file = path.join(folder, "second-launch", "logs", "shell.log");
  createLog(file)("first launch");
  writeFileSync(file, "x".repeat(LOG_LIMIT_BYTES + 1));
  createLog(file);
  assert.equal(existsSync(`${file}.1`), false);
  assert.equal(readFileSync(file, "utf8").length, LOG_LIMIT_BYTES + 1);
  createLog(path.join(folder, "never-written", "logs", "shell.log"));
  assert.equal(existsSync(path.join(folder, "never-written")), false, "the folder of a log nobody wrote to was made");
});

test("a log past the limit that cannot be put aside (Windows: another program has it open) is begun anew, not lost", () => {
  const file = path.join(folder, "locked", "shell.log");
  createLog(file)("first run");
  writeFileSync(file, "x".repeat(LOG_LIMIT_BYTES + 1));
  // A folder where the old log would go makes the rename fail on every system, as a lock does on Windows.
  mkdirSync(`${file}.1`);
  createLog(file)("second run");
  const text = readFileSync(file, "utf8");
  assert.match(text, / second run\n$/, "the run has its log");
  assert.ok(text.length < 200, "the oversized file was begun anew");
});
