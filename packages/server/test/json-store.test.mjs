// The JSON files several processes write at once (json-store.mjs, audit C4): 20 processes that add an entry each to
// the list of projects and to the trusted folders all keep theirs; a broken file is set aside and reported, never
// written over; a stale lock (its owner gone, a PID of 0, nothing in it) does not hold the file for ever.
//
//   node --test emulator/packages/server/test/json-store.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCK_GRACE_MS, LOCK_STALE_MS, lockFile, lockIsStale, readJsonFile, updateJsonFile } from "../json-store.mjs";
import { readProjects, rememberProject } from "../projects/registry.mjs";
import { isTrusted, readTrusted, trustProject } from "../projects/trust.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const url = (file) => pathToFileURL(path.join(here, "..", file)).href;
const WRITERS = 20;

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-json-store-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** Runs `code` (an ES module) in a process of its own, `given` in its environment as JSON_STORE_TEST (JSON). */
function node(code, given) {
  return new Promise((resolve) => {
    const env = { ...process.env, JSON_STORE_TEST: JSON.stringify(given) };
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, err }));
  });
}

test(`${WRITERS} processes at once each add a project and a trusted folder: all ${WRITERS} are kept`, async (t) => {
  const root = tempDir(t);
  const data = path.join(root, "data");
  const folders = Array.from({ length: WRITERS }, (_, i) => path.join(root, `project-${i}`));
  folders.forEach((dir) => mkdirSync(dir));
  const code = `
    const { rememberProject } = await import(${JSON.stringify(url("projects/registry.mjs"))});
    const { trustProject } = await import(${JSON.stringify(url("projects/trust.mjs"))});
    // Start together: each waits for the same moment, so that the writes overlap.
    const { at, data, dir } = JSON.parse(process.env.JSON_STORE_TEST);
    while (Date.now() < at) await new Promise((r) => setTimeout(r, 1));
    rememberProject(data, dir);
    trustProject(data, dir, "created");
  `;
  const at = Date.now() + 1500;
  const results = await Promise.all(folders.map((dir) => node(code, { at, data, dir })));
  assert.deepEqual(results.filter((one) => one.code !== 0), [], "every writer finished");
  assert.equal(readProjects(data).length, WRITERS, "the list of projects holds every one");
  assert.equal(readTrusted(data).length, WRITERS, "the trusted folders hold every one");
  for (const dir of folders) assert.ok(isTrusted(data, dir), `${dir} is trusted`);
  assert.deepEqual(readdirSync(path.join(data, "projects")).sort(), ["registry.json", "trusted.json"], "no lock or temporary file is left");
});

test(`${WRITERS} processes at once each add a key to one JSON file: all ${WRITERS} are kept`, async (t) => {
  const file = path.join(tempDir(t), "store", "all.json");
  const code = `
    const { updateJsonFile } = await import(${JSON.stringify(url("json-store.mjs"))});
    const { file, key } = JSON.parse(process.env.JSON_STORE_TEST);
    for (let i = 0; i < 5; i++) updateJsonFile(file, (all) => ({ ...all, [key + "-" + i]: process.pid }), { fallback: () => ({}) });
  `;
  const results = await Promise.all(Array.from({ length: WRITERS }, (_, i) => node(code, { file, key: `w${i}` })));
  assert.deepEqual(results.filter((one) => one.code !== 0), []);
  assert.equal(Object.keys(JSON.parse(readFileSync(file, "utf8"))).length, WRITERS * 5);
});

test("a broken list is set aside and reported, never written over", (t) => {
  const root = tempDir(t);
  const data = path.join(root, "data");
  const dir = path.join(root, "project");
  mkdirSync(dir);
  mkdirSync(path.join(data, "projects"), { recursive: true });
  const broken = '{ "version": 2, "projects": [ {"path": "/a", ';
  writeFileSync(path.join(data, "projects", "trusted.json"), broken);
  writeFileSync(path.join(data, "projects", "registry.json"), '{"version": 1, "projects": "not a list"}');
  // Reading changes nothing: a broken list trusts nothing, and stays as it is.
  assert.deepEqual(readTrusted(data), []);
  assert.equal(readFileSync(path.join(data, "projects", "trusted.json"), "utf8"), broken);

  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (text) => (said.push(String(text)), true);
  try {
    assert.equal(trustProject(data, dir, "created"), true);
    rememberProject(data, dir);
  } finally {
    process.stderr.write = write;
  }
  const names = readdirSync(path.join(data, "projects")).sort();
  const asideTrusted = names.find((name) => name.startsWith("trusted.json.corrupt-"));
  const asideRegistry = names.find((name) => name.startsWith("registry.json.corrupt-"));
  assert.ok(asideTrusted && asideRegistry, names.join(", "));
  assert.doesNotMatch(asideTrusted, /[:]/, "a name Windows takes");
  assert.equal(readFileSync(path.join(data, "projects", asideTrusted), "utf8"), broken, "the broken file is kept as it was");
  assert.equal(readTrusted(data).length, 1);
  assert.equal(readProjects(data).length, 1);
  assert.equal(said.length, 2, said.join(""));
  assert.match(said[0], /trusted\.json could not be read: it is not JSON .*It is kept as .*trusted\.json\.corrupt-/);
  assert.match(said[1], /registry\.json could not be read: it is JSON, but not of the shape/);
});

test("when a lock is stale", () => {
  const dead = () => false;
  const live = () => true;
  const record = (pid) => JSON.stringify({ pid, at: "2026-11-11T00:00:00.000Z" });
  // Its owner is gone, or is there.
  assert.equal(lockIsStale(record(4242), { ageMs: 10, isAlive: dead }), true);
  assert.equal(lockIsStale(record(4242), { ageMs: 10, isAlive: live }), false);
  // A PID of 0 or 1, nothing, or not JSON: not a whole record. Stale once it is not being written any more.
  for (const text of [record(0), record(1), record(-5), "", "{", "4242", JSON.stringify({ at: "x" })]) {
    assert.equal(lockIsStale(text, { ageMs: 10, isAlive: live }), false, `${JSON.stringify(text)} may be being written`);
    assert.equal(lockIsStale(text, { ageMs: LOCK_GRACE_MS, isAlive: live }), true, `${JSON.stringify(text)} is stale after the grace`);
  }
  // Too old, whoever has its PID now.
  assert.equal(lockIsStale(record(4242), { ageMs: LOCK_STALE_MS, isAlive: live }), true);
});

test("a stale lock is taken away; a live one is waited for, then given up on", (t) => {
  const file = path.join(tempDir(t), "x.json");
  const lock = `${file}.lock`;
  // PID 0 (process.kill(0, 0) succeeds: it signals our own group), left a while ago.
  writeFileSync(lock, JSON.stringify({ pid: 0 }));
  const past = (Date.now() - LOCK_GRACE_MS - 1000) / 1000;
  utimesSync(lock, past, past);
  updateJsonFile(file, () => ({ a: 1 }), { waitMs: 3000 });
  assert.deepEqual(readJsonFile(file).value, { a: 1 });
  // An empty lock, also old.
  writeFileSync(lock, "");
  utimesSync(lock, past, past);
  updateJsonFile(file, (all) => ({ ...all, b: 2 }), { waitMs: 3000 });
  assert.deepEqual(readJsonFile(file).value, { a: 1, b: 2 });
  // A lock this process holds (a live owner): the next change waits, and says so when it gives up.
  const unlock = lockFile(file);
  assert.throws(() => updateJsonFile(file, () => ({}), { waitMs: 300 }), { code: "ELOCKED" });
  unlock();
  assert.deepEqual(readJsonFile(file).value, { a: 1, b: 2 });
  assert.deepEqual(readdirSync(path.dirname(file)), ["x.json"]);
});
