// The emulator's list of app projects (EMU-260): which app is which folder, whether the folder is there, and whether a
// folder that is gone was deleted or is only on a disk that is not there.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { forgetProject, listProjects, readProjects, registryFile, rememberProject, volumeOf, volumePresent } from "../registry.mjs";
import { trustProject } from "../trust.mjs";

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-registry-")));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function place(id = "app.you.clock", name = "Clock") {
  const dir = path.join(root, `case-${n++}`);
  const project = path.join(dir, "my app");
  mkdirSync(path.join(dir, "data"), { recursive: true });
  mkdirSync(path.join(project, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(project, "src", "appmeta", "manifest.json"), JSON.stringify({ id, name }));
  return { data: path.join(dir, "data"), project };
}

test("a project is listed by its real path with its app's id and name, once, the latest first", () => {
  const { data, project } = place();
  const other = path.join(path.dirname(project), "other");
  mkdirSync(other);
  assert.deepEqual(listProjects(data), []);
  rememberProject(data, project, { now: 1000 });
  rememberProject(data, other, { now: 2000 });
  rememberProject(data, path.join(project, ".", "src", ".."), { now: 3000 });
  const list = listProjects(data);
  assert.deepEqual(list.map((one) => [one.folder, one.id, one.name]), [[project, "app.you.clock", "Clock"], [other, null, "other"]]);
  assert.deepEqual(list.map((one) => [one.exists, one.unavailable, one.trusted, one.built]), [[true, false, false, false], [true, false, false, false]]);
  assert.equal(JSON.parse(readFileSync(registryFile(data), "utf8")).version, 1);
  assert.equal(readProjects(data).length, 2);
});

test("trusted and built are read from the folder as it is now, and so is the app's id when the author changed it", () => {
  const { data, project } = place();
  rememberProject(data, project);
  trustProject(data, project, "created");
  writeFileSync(path.join(project, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.you.renamed", name: "Renamed" }));
  mkdirSync(path.join(project, "dist"));
  writeFileSync(path.join(project, "dist", "app.you.renamed.tgz"), "");
  assert.deepEqual(listProjects(data).map((one) => [one.id, one.name, one.trusted, one.built]), [["app.you.renamed", "Renamed", true, true]]);
});

test("a folder that is gone: deleted when its disk is there, unavailable when the disk is gone; it keeps the app's id it had", () => {
  const { data, project } = place();
  rememberProject(data, project);
  renameSync(project, `${project} moved`);
  const asked = [];
  const look = (there) => listProjects(data, { present: (volume) => (asked.push(volume), there) }).map((one) => [one.id, one.exists, one.unavailable, one.trusted]);
  assert.deepEqual(look(true), [["app.you.clock", false, false, false]]);
  assert.deepEqual(look(false), [["app.you.clock", false, true, false]]);
  assert.deepEqual(asked, [volumeOf(root), volumeOf(root)], "the disk asked about is the one the folder was on");
  // The real look: the disk of the temporary folder is there, so the folder was deleted.
  assert.deepEqual(listProjects(data).map((one) => [one.exists, one.unavailable]), [[false, false]]);
  // Back at its place, it is there again; nobody asks about the disk of a folder that is there.
  renameSync(`${project} moved`, project);
  asked.length = 0;
  assert.deepEqual(look(false), [["app.you.clock", true, false, false]]);
  assert.deepEqual(asked, []);
});

test("the disk of a folder is the highest folder on the same disk, and it is there while it is the root of a disk", () => {
  const volume = volumeOf(root);
  assert.ok(root === volume || root.startsWith(volume.endsWith(path.sep) ? volume : volume + path.sep), `${volume} is above ${root}`);
  assert.equal(volumePresent(volume), true);
  assert.equal(volumePresent(path.parse(root).root), true);
  assert.equal(volumePresent(path.join(root, "no such disk")), false);
  if (process.platform !== "win32") {
    // A folder left where a disk was mounted is on its parent's disk: no disk is there.
    const stale = path.join(root, "stale mount point");
    mkdirSync(stale);
    assert.equal(volumePresent(stale), false);
  }
  // Windows: the root of the drive, or of the share.
  const drive = ["E:", "work", "my app"].join(path.win32.sep);
  const share = `${path.win32.sep.repeat(2)}${["server", "share", "my app"].join(path.win32.sep)}`;
  assert.equal(volumeOf(drive, "win32"), path.win32.parse(drive).root);
  assert.equal(volumeOf(drive, "win32"), `E:${path.win32.sep}`);
  assert.equal(volumeOf(share, "win32"), share.slice(0, share.lastIndexOf("my app")));
});

test("the walk up to the disk ends for a path the posix rules do not read as absolute (it spun forever on Windows)", () => {
  // A relative folder inside the working folder: posix dirname climbs to ".", whose dirname is "." again, all on the
  // same disk. A Windows path (a drive letter, backslashes) under platform "darwin", as the command line's tests give it,
  // does the same.
  const here = path.relative(process.cwd(), import.meta.dirname) || ".";
  assert.equal(typeof volumeOf(here, "darwin"), "string");
  assert.equal(typeof volumeOf(root, process.platform === "win32" ? "darwin" : process.platform), "string");
});

test("forgetting takes the entry out and touches nothing else; a broken list is an empty one", () => {
  const { data, project } = place();
  rememberProject(data, project);
  assert.equal(forgetProject(data, path.join(root, "never listed")), false);
  assert.equal(forgetProject(data, project), true);
  assert.deepEqual(listProjects(data), []);
  assert.ok(readFileSync(path.join(project, "src", "appmeta", "manifest.json"), "utf8").length > 0, "the folder is as it was");
  writeFileSync(registryFile(data), "{ not json");
  assert.deepEqual(listProjects(data), []);
  writeFileSync(registryFile(data), JSON.stringify({ version: 1, projects: [{ path: "relative/path" }, { id: "x" }, null] }));
  assert.deepEqual(listProjects(data), []);
});
