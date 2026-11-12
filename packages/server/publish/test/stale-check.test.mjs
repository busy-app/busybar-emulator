// stale-check: Pre-flight check builds the app and checks its types, and it and Build and package record a
// fingerprint of the files that get published or built; a later step that finds a file changed says so, and push and
// pr refuse. The owner's case: the check passed, then the first `import` of src/main.ts lost its `i`, and the window
// still let him go on. On projects the tests write by hand, with stand-ins for busy-cli and tsc; no network.
//
//   node --test emulator/packages/server/publish/test/stale-check.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../../cli/busy-emulator.mjs";
import { resolveContext } from "../../cli/context.mjs";
import { buildError } from "../../cli/preflight.mjs";
import { isDone, staleStep } from "../../legacy-window/publish-steps.mjs";
import { makeProject } from "../../readiness/test/project-fixture.mjs";
import { changedWords, compare, differences, fingerprint, renewed, settled } from "../fingerprint.mjs";
import { BROKEN_BUILD, buildable, BUILDS, toolsAnswering } from "./stale-support.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "..", "cli", "busy-emulator.mjs");
const SHA = "a".repeat(40);

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-stale-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function cli(home, argv, sys = BUILDS) {
  const ctx = resolveContext({ env: { BUSY_EMULATOR_DATA: path.join(home, "data") }, platform: process.platform, homeDir: home, scriptPath: CLI, execPath: process.execPath, nodeVersion: process.versions.node });
  const out = [];
  const code = await main([...argv, "--json"], { ctx, sys, out: (line) => out.push(line), err: () => {} });
  return { code, json: JSON.parse(out.join("\n")) };
}

/** A finished project (nothing of the catalog's checks fails for it), trusted and buildable. */
function readyProject(t, { scripts = null } = {}) {
  const home = tempDir(t);
  const dir = path.join(home, "desk clock");
  mkdirSync(dir);
  makeProject(dir, { git: false });
  if (scripts) {
    const file = path.join(dir, "package.json");
    const json = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...json, scripts: { ...json.scripts, ...scripts } }, null, 2));
  }
  buildable(home, dir);
  return { home, dir };
}

const breakMain = (dir) => {
  const file = path.join(dir, "src", "main.ts");
  const before = readFileSync(file, "utf8");
  writeFileSync(file, before.replace(/^import/, "mport"));
  return () => writeFileSync(file, before);
};
const brokenBuild = toolsAnswering((request) => (request.args?.[1] === "build" ? { code: 1, output: BROKEN_BUILD } : null));

// ---------------------------------------------------------------- the fingerprint

test("the fingerprint: the files that get published or built, by their bytes; not .busy, dist, node_modules or the system's", (t) => {
  const { dir } = readyProject(t);
  const first = fingerprint(dir);
  assert.ok(first.files["src/main.ts"] && first.files["package.json"] && first.files["catalog.json"] && first.files["LICENSE"] && first.files["screenshots/front-1.png"]);
  assert.equal(Object.keys(first.files).some((rel) => /^(?:\.busy|dist|node_modules|submission)\//.test(rel)), false);
  assert.deepEqual(fingerprint(dir), first, "the same project, the same fingerprint");

  // What the flow, the build and the system write beside the files changes nothing.
  for (const rel of [".busy/publish.json", "dist/other.tgz", "node_modules/x/index.js", ".DS_Store", "src/.DS_Store", "src/._main.ts"]) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), "x");
  }
  assert.equal(fingerprint(dir).hash, first.hash);

  // One letter of src/main.ts: stale, and the file named; the same bytes again: as it was.
  const restore = breakMain(dir);
  const broken = fingerprint(dir);
  assert.deepEqual(compare(first, broken), { stale: true, changed: ["src/main.ts"], more: 0 });
  restore();
  assert.deepEqual(compare(first, fingerprint(dir)), { stale: false, changed: [], more: 0 });

  // A file added or removed is a change too.
  writeFileSync(path.join(dir, "src", "extra.ts"), "export {};\n");
  rmSync(path.join(dir, "README.md"), { force: true });
  rmSync(path.join(dir, "LICENSE"));
  assert.deepEqual(differences(first, fingerprint(dir)), ["LICENSE", "src/extra.ts"]);

  // submission/ belongs to the package's fingerprint, not the check's.
  const pkg = fingerprint(dir, { scope: "package" });
  mkdirSync(path.join(dir, "submission"), { recursive: true });
  writeFileSync(path.join(dir, "submission", "SUBMIT.md"), "steps\n");
  assert.equal(fingerprint(dir, { scope: "package" }).files["submission/SUBMIT.md"] !== undefined, true);
  assert.equal(compare(pkg, fingerprint(dir, { scope: "package" })).stale, true);
  assert.equal(fingerprint(dir).files["submission/SUBMIT.md"], undefined);
});

test("compare, settled, renewed and the words: what a record without a fingerprint, an install and the flow's own write mean", () => {
  const a = { hash: "1", files: { "src/main.ts": "1:x", "package-lock.json": "1:y" } };
  assert.deepEqual(compare(null, a), { stale: true, changed: [], more: 0, unknown: true }, "an older emulator's record holds nothing");
  assert.deepEqual(compare({ passed: true }, a).unknown, true);
  // The check builds: npm may write the lock file meanwhile; the catalog.json form may be made. Anything else that
  // changed while it ran leaves the record at the files before, so it is stale at once.
  const lock = { hash: "2", files: { ...a.files, "package-lock.json": "2:z" } };
  assert.equal(settled(a, lock), lock);
  const form = { hash: "3", files: { ...a.files, "catalog.json": "1:{}" } };
  assert.equal(settled(a, form), form);
  const edited = { hash: "4", files: { ...a.files, "src/main.ts": "2:q" } };
  assert.equal(settled(a, edited), a);
  // The flow's own write: followed when nothing else changed.
  assert.equal(renewed(a, edited, ["src/main.ts"]), edited);
  assert.equal(renewed(a, edited, ["catalog.json"]), null);
  // The words.
  assert.equal(changedWords({ changed: ["src/main.ts"] }), "src/main.ts");
  assert.equal(changedWords({ changed: ["src/main.ts", "README.md"] }), "src/main.ts and README.md");
  assert.equal(changedWords({ changed: ["a", "b", "c", "d"], more: 2 }), "a, b, c and 3 more");
  assert.equal(changedWords({ changed: [], unknown: true }), "it was checked by an older version of the emulator");
  // The window's rules: a stale check is not done, nor its package; the step to go back to.
  const status = { check: { passed: true, fails: 0, stale: false }, package: { submission: "/x/submission", stale: false } };
  assert.deepEqual([isDone("check", status), isDone("package", status), staleStep(status)], [true, true, null]);
  const changed = { check: { ...status.check, stale: true }, package: { ...status.package, stale: true } };
  assert.deepEqual([isDone("check", changed), isDone("package", changed), staleStep(changed)], [false, false, "check"]);
  assert.equal(staleStep({ check: status.check, package: { ...status.package, stale: true } }), "package");
  assert.equal(isDone("check", { check: { passed: false, fails: 0, stale: false } }), false, "not built is not passed");
});

test("busy-cli's failure read for the check: the file, the line and the error's own words", () => {
  assert.deepEqual(buildError(BROKEN_BUILD), { file: "src/main.ts", line: 1, column: 6, message: "Expected a semicolon or an implicit semicolon after a statement, but found none" });
  assert.deepEqual(buildError("src/lib/tick.ts:4:2: ERROR: Unexpected end of file"), { file: "src/lib/tick.ts", line: 4, column: 2, message: "Unexpected end of file" });
  assert.deepEqual(buildError("something went wrong"), { message: "something went wrong" });
  // Windows: its folders, and an absolute path inside the project.
  assert.equal(buildError("│     ╭─[ src\\lib\\tick.ts:2:1 ]").file, "src/lib/tick.ts");
  const dir = path.join(os.tmpdir(), "desk clock");
  assert.equal(buildError(`${path.join(dir, "src", "main.ts")}:1:6: ERROR: Expected ";"`, dir).file, "src/main.ts");
});

// ---------------------------------------------------------------- the command line

test("publish check builds the app: the broken import fails with its file and line, where it passed on the old package", async (t) => {
  const { home, dir } = readyProject(t);
  const passed = (await cli(home, ["publish", "check", dir])).json;
  assert.deepEqual([passed.passed, passed.compiled, passed.fails], [true, true, []], JSON.stringify(passed.fails));
  assert.equal(BUILDS.calls.some((one) => one.args?.[1] === "build" && one.cwd === dir), true, "busy-cli build ran in the project");

  const restore = breakMain(dir);
  // As it was: the old dist/<id>.tgz is still there, the catalog's checks alone pass on it.
  const status = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([status.steps.check, status.check.stale, status.check.changed], ["todo", true, ["src/main.ts"]], "Changed since the check");
  const failed = (await cli(home, ["publish", "check", dir], brokenBuild)).json;
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.fails.map((one) => one.id), ["compile"]);
  assert.deepEqual([failed.fails[0].file, failed.fails[0].line, failed.fails[0].column], ["src/main.ts", 1, 6]);
  assert.match(failed.fails[0].found, /^src\/main\.ts:1:6: Expected a semicolon/);
  const after = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([after.steps.check, after.check.stale, after.check.passed], ["todo", false, false], "checked again: not stale, failed");
  assert.equal((await cli(home, ["publish", "package", dir], brokenBuild)).json.code, "check_failed", "nothing packaged that does not build");
  restore();
});

test("publish check runs the template's typecheck: a type error fails with its file and line; an untrusted project is not passed", async (t) => {
  const { home, dir } = readyProject(t, { scripts: { typecheck: "tsc" } });
  const restore = breakMain(dir);
  const types = toolsAnswering((request) => (request.tool === "npm" && request.args?.includes("typecheck") ? { code: 2, output: "src/main.ts(1,1): error TS1435: Unknown keyword or identifier. Did you mean 'import'?\nsrc/main.ts(1,18): error TS1434: Unexpected keyword or identifier." } : null));
  const failed = (await cli(home, ["publish", "check", dir], types)).json;
  assert.deepEqual(failed.fails.map((one) => [one.id, one.file, one.line]), [["types", "src/main.ts", 1]]);
  assert.match(failed.fails[0].found, /^src\/main\.ts:1:1: Unknown keyword or identifier\. Did you mean 'import'\? \(TS1435\); src\/main\.ts:1:18/);
  restore();

  // Not trusted: building would run its code, so it is not built, and the check does not pass.
  const other = path.join(home, "stranger");
  mkdirSync(other);
  makeProject(other, { git: false });
  const refused = (await cli(home, ["publish", "check", other])).json;
  assert.deepEqual([refused.passed, refused.fails.map((one) => one.id)], [false, ["compile"]]);
  assert.match(refused.fails[0].found, /not trusted/);
});

test("publish push, pr and verify refuse a project changed since the check or the package; the flow's own writes keep them", async (t) => {
  const { home, dir } = readyProject(t);
  assert.equal((await cli(home, ["publish", "push", dir])).json.code, "not_checked", "nothing before the check");
  assert.equal((await cli(home, ["publish", "check", dir])).json.passed, true);
  assert.equal((await cli(home, ["publish", "push", dir])).json.code, "not_packaged");
  const packaged = await cli(home, ["publish", "package", dir]);
  assert.equal(packaged.json.ok, true, JSON.stringify(packaged.json));
  const status = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([status.steps.check, status.steps.package, status.package.stale], ["done", "done", false]);
  const verified = (await cli(home, ["publish", "verify", dir])).json;
  assert.deepEqual([verified.ok, verified.checked], [true, true]);
  assert.match(verified.files["src/main.ts"], /^\d+:[0-9a-f]{64}$/, "the bytes the check saw, for the app to compare");

  // The owner's edit: push (the app is not even asked), pr and verify refuse, and say which file.
  const restore = breakMain(dir);
  for (const argv of [["publish", "push", dir], ["publish", "pr", dir, "--ai=none"], ["publish", "verify", dir]]) {
    const refused = await cli(home, argv);
    assert.deepEqual([refused.code, refused.json.code], [1, "changed_since_check"], argv[1]);
    assert.match(refused.json.message, /^The project changed since Pre-flight check \(src\/main\.ts\), so nothing is sent/);
    assert.deepEqual(refused.json.changed, ["src/main.ts"]);
  }
  // The same bytes again: as checked.
  restore();
  assert.equal((await cli(home, ["publish", "verify", dir])).json.ok, true);

  // submission/ changed by hand: the package no longer holds.
  const manifest = path.join(dir, "submission", "applications", status.id, "manifest.yml");
  const text = readFileSync(manifest, "utf8");
  writeFileSync(manifest, `${text}# mine\n`);
  assert.equal((await cli(home, ["publish", "push", dir])).json.code, "changed_since_package");
  writeFileSync(manifest, text);

  // Stage 2's own write of the manifest (publish pushed) keeps the package as packaged.
  assert.equal((await cli(home, ["publish", "pushed", dir, "--owner=jane", "--repo=desk-clock", `--commit=${SHA}`])).json.ok, true);
  assert.match(readFileSync(manifest, "utf8"), new RegExp(`commit_sha: ${SHA}`));
  assert.deepEqual((await cli(home, ["publish", "status", dir])).json.steps.package, "done");

  // What's new of an update, written by the flow: followed with --renew catalog.json, and only that file.
  const details = path.join(dir, "catalog.json");
  writeFileSync(details, JSON.stringify({ ...JSON.parse(readFileSync(details, "utf8")), changelog: "A longer break after four sessions." }, null, 2));
  assert.equal((await cli(home, ["publish", "verify", dir])).json.code, "changed_since_check");
  assert.equal((await cli(home, ["publish", "verify", dir, "--renew=catalog.json"])).json.ok, true);
  assert.equal((await cli(home, ["publish", "verify", dir, "--renew=src/main.ts"])).json.code, "usage");
  writeFileSync(details, JSON.stringify({ ...JSON.parse(readFileSync(details, "utf8")), changelog: "Another version, with a pause button." }, null, 2));
  breakMain(dir);
  assert.equal((await cli(home, ["publish", "verify", dir, "--renew=catalog.json"])).json.code, "changed_since_check", "a change of another file is not followed");
});

test("a file changed while the check builds: the check's record is of the files before, so it is stale at once", async (t) => {
  const { home, dir } = readyProject(t);
  const during = toolsAnswering((request) => {
    if (request.args?.[1] === "build") writeFileSync(path.join(dir, "src", "main.ts"), "// typed while it built\n");
    return null;
  });
  assert.equal((await cli(home, ["publish", "check", dir], during)).json.ok, true);
  const status = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([status.check.stale, status.check.changed], [true, ["src/main.ts"]]);
});
