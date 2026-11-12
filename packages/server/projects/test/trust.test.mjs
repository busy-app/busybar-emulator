// Trust is bound to the folder, not to its path (EMU-206 security review, M1): a folder deleted or renamed away, and
// another one at its path, is not trusted.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { folderIdentity, isTrusted, readTrusted, trustFile, trustProject } from "../trust.mjs";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-trust-")));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const place = () => {
  const dir = path.join(root, `case-${n++}`);
  mkdirSync(path.join(dir, "data"), { recursive: true });
  return { data: path.join(dir, "data"), project: path.join(dir, "my-app") };
};

test("a trusted folder is trusted; the list holds its path and its number on the file system", () => {
  const { data, project } = place();
  mkdirSync(project);
  assert.equal(isTrusted(data, project), false);
  assert.equal(trustProject(data, project, "created"), true);
  assert.equal(isTrusted(data, project), true);
  assert.equal(trustProject(data, project, "created"), false, "once");
  const [entry] = readTrusted(data);
  assert.deepEqual({ path: entry.path, dev: entry.dev, ino: entry.ino }, folderIdentity(project));
  assert.equal(JSON.parse(readFileSync(trustFile(data), "utf8")).version, 2);
});

for (const how of ["deleted", "renamed"]) {
  test(`a folder ${how} after it was trusted: another folder at its path is not trusted, until trusted itself`, () => {
    const { data, project } = place();
    mkdirSync(project);
    trustProject(data, project, "created");
    if (how === "deleted") rmSync(project, { recursive: true });
    else renameSync(project, `${project}-old`);
    mkdirSync(project);
    writeFileSync(path.join(project, "package.json"), "{}");
    assert.equal(isTrusted(data, project), false);
    if (how === "renamed") assert.equal(isTrusted(data, `${project}-old`), false, "the renamed one is not trusted at its new path either");
    // Trusting the new folder replaces the entry of the old one at that path.
    trustProject(data, project, "trusted");
    assert.equal(isTrusted(data, project), true);
    assert.equal(readTrusted(data).length, 1);
  });
}

test("an entry without the folder's number (a list of version 1) trusts nothing", () => {
  const { data, project } = place();
  mkdirSync(project);
  mkdirSync(path.dirname(trustFile(data)), { recursive: true });
  writeFileSync(trustFile(data), JSON.stringify({ version: 1, projects: [{ path: realpathSync(project), how: "created" }] }));
  assert.equal(isTrusted(data, project), false);
});
