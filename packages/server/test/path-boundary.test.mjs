// Tests of path-boundary.mjs (ADR-0012 §6, EMU-010): a path is inside the folders it may touch only by its real path;
// "..", a symbolic link and a junction that lead out are refused, on the disk of this machine. The rules of Windows
// names run everywhere on a made-up file system; links and junctions on the disk run where the system makes them.
//
//   node --test packages/server/test/path-boundary.test.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { targz } from "../../../test/package.mjs";
import { Device } from "../device.mjs";
import { loadFirmware } from "../firmware.mjs";
import { insideFolder, insideRoots, resolvedPath, trashableFolder, within } from "../path-boundary.mjs";
import { unpackPackage } from "../tar.mjs";

const WINDOWS = process.platform === "win32";
const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

/** A folder with root/ (the allowed one), outside/ beside it, and links from root/ to outside/ where they can be made. */
function layout() {
  const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "emu-boundary-")));
  folders.push(top);
  const root = path.join(top, "root");
  const outside = path.join(top, "outside");
  mkdirSync(path.join(root, "inner"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(root, "inner", "file.txt"), "in");
  writeFileSync(path.join(outside, "secret.txt"), "out");
  const made = {};
  // A junction needs no privilege on Windows; a symbolic link needs one there (developer mode), none elsewhere.
  for (const [name, type] of [["link", WINDOWS ? "dir" : undefined], ["junction", WINDOWS ? "junction" : null]]) {
    if (type === null) continue;
    try {
      symlinkSync(outside, path.join(root, name), type);
      made[name] = path.join(root, name);
    } catch (e) {
      if (!["EPERM", "EACCES"].includes(e.code)) throw e;
    }
  }
  try {
    symlinkSync(path.join(top, "nowhere"), path.join(root, "dangling"), WINDOWS ? "file" : undefined);
    made.dangling = path.join(root, "dangling");
  } catch (e) {
    if (!["EPERM", "EACCES"].includes(e.code)) throw e;
  }
  return { top, root, outside, made };
}

describe("insideRoots on this disk", () => {
  test("a file or folder inside is let through by its real path; the root itself only when asked", () => {
    const { root } = layout();
    assert.equal(insideRoots(path.join(root, "inner", "file.txt"), [root]), path.join(root, "inner", "file.txt"));
    assert.equal(insideRoots(root, [root]), root);
    assert.equal(insideRoots(root, [root], { rootItself: false }), null);
    assert.equal(insideRoots(path.join(root, "inner"), [root], { rootItself: false }), path.join(root, "inner"));
  });

  test('a path with ".." or "." is refused, even one that would end inside', () => {
    const { root, outside } = layout();
    assert.equal(insideRoots(`${root}${path.sep}inner${path.sep}..${path.sep}inner${path.sep}file.txt`, [root]), null);
    assert.equal(insideRoots(`${root}${path.sep}.${path.sep}inner`, [root]), null);
    assert.equal(insideRoots(`${root}${path.sep}..${path.sep}outside`, [root]), null);
    assert.equal(insideRoots(path.join(outside, "secret.txt"), [root]), null);
    assert.equal(insideRoots("inner/file.txt", [root]), null, "a relative path");
    assert.equal(insideRoots(`${root}${path.sep}inner\0`, [root]), null, "a NUL");
  });

  test("a link or a junction inside that leads out is refused, for what is there and for what would be made", (t) => {
    const { root, made } = layout();
    if (!made.link && !made.junction) return t.skip("this system makes no links here");
    for (const link of [made.link, made.junction].filter(Boolean)) {
      assert.equal(insideRoots(link, [root]), null, link);
      assert.equal(insideRoots(path.join(link, "secret.txt"), [root]), null);
      assert.equal(insideRoots(path.join(link, "new", "file.txt"), [root], { missing: true }), null, "a file to be made behind the link");
    }
  });

  test("a link that leads nowhere is refused, and so is what would be made behind it", (t) => {
    const { root, made } = layout();
    if (!made.dangling) return t.skip("this system makes no links here");
    assert.equal(insideRoots(made.dangling, [root], { missing: true }), null);
    assert.equal(insideRoots(path.join(made.dangling, "x"), [root], { missing: true }), null);
  });

  test("a path not there yet is answered for where it would be made", () => {
    const { root, outside } = layout();
    assert.equal(insideRoots(path.join(root, "new", "deeper", "file.png"), [root]), null, "must be there unless asked");
    assert.equal(insideRoots(path.join(root, "new", "deeper", "file.png"), [root], { missing: true }), path.join(root, "new", "deeper", "file.png"));
    assert.equal(insideRoots(path.join(outside, "new.png"), [root], { missing: true }), null);
    assert.equal(insideRoots(path.join(root, "x"), [path.join(root, "not-yet")], { missing: true }), null, "a root not there yet holds only what is under it");
    assert.equal(insideRoots(path.join(root, "not-yet", "x"), [path.join(root, "not-yet")], { missing: true }), path.join(root, "not-yet", "x"));
  });

  test("a root reached through a link is taken by its real path", (t) => {
    const { top, outside, made } = layout();
    const link = made.link ?? made.junction;
    if (!link) return t.skip("this system makes no links here");
    assert.equal(insideRoots(path.join(outside, "secret.txt"), [link]), path.join(outside, "secret.txt"));
    assert.equal(insideRoots(path.join(top, "root", "inner"), [link]), null);
  });

  test("insideFolder: a relative path a project's file names, by its real path; nothing that leaves the folder", (t) => {
    const { root, outside, made } = layout();
    assert.equal(insideFolder(root, "inner/file.txt"), path.join(root, "inner", "file.txt"));
    assert.equal(insideFolder(root, "inner/new.txt"), null, "not there");
    assert.equal(insideFolder(root, "inner/new.txt", { missing: true }), path.join(root, "inner", "new.txt"));
    const secret = path.join(outside, "secret.txt");
    for (const bad of ["../outside/secret.txt", "inner/../../outside/secret.txt", "./inner/file.txt", "inner//file.txt", "", "/etc/passwd", secret, "C:/x", "inner\\file.txt", "inner/file.txt\0"]) {
      assert.equal(insideFolder(root, bad), null, JSON.stringify(bad));
    }
    assert.equal(insideFolder(root, "inner/"), null, "an empty last part");
    const link = made.link ?? made.junction;
    if (!link) return t.skip("this system makes no links here");
    assert.equal(insideFolder(root, `${path.basename(link)}/secret.txt`), null, "a link inside that leads out");
  });

  test("on Windows, letter case does not matter and the long name is the one compared", { skip: !WINDOWS && "Windows only" }, () => {
    const { root } = layout();
    assert.equal(insideRoots(path.join(root.toUpperCase(), "INNER", "FILE.TXT"), [root]), path.join(root, "inner", "file.txt"));
    assert.equal(insideRoots(path.join(root, "inner", "file.txt"), [root.toLowerCase()]), path.join(root, "inner", "file.txt"));
  });
});

describe("the rules of names, on a made-up disk", () => {
  // C:\Users and C:\Users\user are there; nothing else is.
  const there = new Set(["C:\\", "C:\\Users", "C:\\Users\\user"]);
  const fake = { platform: "win32", exists: (p) => there.has(p), real: (p) => (there.has(p) ? p : null) };

  test("Windows: a name the system would read as another one is refused before it is made", () => {
    assert.equal(insideRoots("C:\\Users\\user\\new.txt", ["C:\\Users"], { ...fake, missing: true }), "C:\\Users\\user\\new.txt");
    for (const name of ["new.", "new ", "file.txt:stream", "a\\b.\\c"]) assert.equal(resolvedPath(`C:\\Users\\user\\${name}`, fake), null, name);
    assert.equal(insideRoots("C:/Users/user/new.txt", ["C:\\USERS"], { ...fake, missing: true }), "C:\\Users\\user\\new.txt", "forward slashes and letter case");
    assert.equal(insideRoots("C:\\Users\\username", ["C:\\Users\\user"], { ...fake, missing: true }), null, "a folder whose name starts the same");
    assert.equal(insideRoots("\\\\?\\UNC", ["C:\\Users"], { ...fake, missing: true }), null);
  });

  test("within is lexical, by whole names, letter case aside on Windows only", () => {
    assert.ok(within("/a/b/c", "/a/b", "darwin"));
    assert.ok(!within("/a/bc", "/a/b", "darwin"));
    assert.ok(!within("/A/b", "/a", "darwin"));
    assert.ok(within("C:\\A\\b", "c:\\a", "win32"));
    assert.ok(!within("D:\\a", "C:\\a", "win32"));
  });

  test('a child named "..foo" is inside; ".." and "../x" are not (security review of 103)', () => {
    assert.ok(within("/a/..foo", "/a", "darwin"));
    assert.ok(within("/a/..foo/b", "/a", "darwin"));
    assert.ok(within("C:\\a\\..foo", "C:\\a", "win32"));
    assert.ok(!within("/", "/a", "darwin"));
    assert.ok(!within("/b", "/a", "darwin"));
    assert.ok(!within("C:\\b", "C:\\a", "win32"));
  });
});

describe("names that start with two dots", () => {
  test('a package whose top folder is "..foo" unpacks, and a file in such a folder is inside', () => {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "emu-boundary-dots-")));
    folders.push(top);
    const { topDirs } = unpackPackage(new Uint8Array(targz({ "..foo/a.txt": "x", "app/b.txt": "y" })), top);
    assert.deepEqual(topDirs, ["..foo", "app"]);
    assert.equal(insideRoots(path.join(top, "..foo", "a.txt"), [top]), path.join(top, "..foo", "a.txt"));
  });
});

describe("trashableFolder by the file system's number", () => {
  // The same folder by another path that is not a link: on macOS through the data volume's firmlink, on Windows
  // through the disk's administrative share. The paths are put together from parts (the export check reads text).
  const firmlink = ["", "System", "Volumes", "Data"].join("/");
  const share = (folder) => ["", "", "localhost", `${folder[0]}$`].join("\\") + folder.slice(2);
  const alias = (folder) => (process.platform === "darwin" ? `${firmlink}${folder}` : process.platform === "win32" ? share(folder) : null);
  const usable = (folder) => {
    const other = alias(folder);
    try {
      return other && realpathSync.native(other) === other ? other : null;
    } catch {
      return null;
    }
  };

  test("the home folder, one above it, the data folder, named another way, are refused", (t) => {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "emu-boundary-home-")));
    folders.push(top);
    const home = path.join(top, "home", "person");
    const data = path.join(top, "data");
    const project = path.join(top, "project");
    for (const one of [home, data, project]) mkdirSync(one, { recursive: true });
    if (!usable(home)) return t.skip("no second path to the same folder on this system");
    const rule = (folder) => trashableFolder(folder, { registered: [folder], dataDir: data, home, platform: process.platform });
    assert.match(rule(usable(home)).refused?.message ?? "", /home folder/);
    assert.match(rule(usable(path.dirname(home))).refused?.message ?? "", /home folder/);
    assert.match(rule(usable(data)).refused?.message ?? "", /data folder/);
    assert.match(rule(usable(top)).refused?.message ?? "", /home folder|data folder/);
    assert.deepEqual(rule(usable(project)), { folder: usable(project) }, "a project folder by the other path is still a project folder");
  });
});

describe("the bar's storage", () => {
  test("a path of /ext that leads out of the data folder through a link is not one: nothing is read or written there", async (t) => {
    const top = realpathSync.native(mkdtempSync(path.join(tmpdir(), "emu-boundary-bar-")));
    folders.push(top);
    const dataDir = path.join(top, "data");
    const outside = path.join(top, "outside");
    mkdirSync(path.join(dataDir, "ext"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "out");
    try {
      symlinkSync(outside, path.join(dataDir, "ext", "away"), WINDOWS ? "junction" : undefined);
    } catch (e) {
      if (["EPERM", "EACCES"].includes(e.code)) return t.skip("this system makes no links here");
      throw e;
    }
    const device = new Device({ dataDir, firmware: loadFirmware("1.3.1"), log: () => {} });
    assert.equal(device.local("/ext/away/secret.txt"), null);
    assert.equal(device.local("/ext/away/new.txt"), null);
    assert.equal(device.readFile("/ext/away/secret.txt"), null);
    assert.equal(device.local("/ext/inside/new.txt"), path.join(dataDir, "ext", "inside", "new.txt"));
    const written = await device.handle("POST", "http://127.0.0.1/api/storage/write?path=/ext/away/new.txt", {}, new TextEncoder().encode("x"));
    assert.notEqual(written.status, 200);
  });
});
