// The npm scripts that run tests by a pattern (npm run test:unit, test:server; packages/app's test, test:unit,
// test:app): node --test runs nothing for a pattern that matches no file and still ends with exit code 0, so every
// pattern must match a test file, and test:unit must take every test file of the parts (packages/ but the shell's,
// and the maintainers' tools/, where the tree has them) — what the gate's unit and tools suites run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const emulator = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Test files under a folder, relative to `base`, with forward slashes. */
function testFiles(folder, base = folder) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(folder, e.name);
    if (e.isDirectory()) out.push(...testFiles(p, base));
    else if (/\.test\.(mjs|cjs|js)$/.test(e.name)) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out;
}

/** node --test's patterns: * within a name, ** across folders (also none). */
const glob = (g) => new RegExp(`^${g.split("**/").map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join("(?:.*/)?")}$`);
/** The patterns a script gives node --test: its words after --test that are not options. */
const patterns = (script) => [...script.matchAll(/(?:^|\s)"?([^\s"-][^\s"]*)"?/g)].map((m) => m[1]).filter((w) => w.includes("/") || w.includes("*"));

function check(packageDir) {
  const scripts = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")).scripts ?? {};
  const files = testFiles(packageDir);
  const found = {};
  for (const [name, script] of Object.entries(scripts)) {
    if (!/\bnode --test\b/.test(script)) continue;
    found[name] = patterns(script.slice(script.indexOf("--test")));
    for (const p of found[name]) assert.ok(files.some((f) => glob(p).test(f)), `npm run ${name} in ${path.relative(emulator, packageDir) || "emulator/"}: "${p}" matches no test file`);
  }
  return { found, files };
}

test("every pattern of emulator/'s test scripts matches a test file, and test:unit takes every test file of the parts", () => {
  const { found, files } = check(emulator);
  assert.ok(found["test:unit"]?.length, "test:unit runs node --test with patterns");
  const parts = files.filter((f) => (f.startsWith("packages/") && !f.startsWith("packages/app/")) || f.startsWith("tools/"));
  const missed = parts.filter((f) => !found["test:unit"].some((p) => glob(p).test(f)));
  assert.deepEqual(missed, [], "test files of the parts that npm run test:unit does not run");
});

test("every pattern of packages/app's test scripts matches a test file", () => {
  const { found } = check(path.join(emulator, "packages", "app"));
  assert.ok(Object.keys(found).length >= 3, JSON.stringify(found));
});
