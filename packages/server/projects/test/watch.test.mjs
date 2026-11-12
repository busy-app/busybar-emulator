// Watching a project's files for the development loop (watch.mjs): with the system's own notifications, in a
// temporary folder.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { changedBetween, ignored, look, oneAtATime, watchProject } from "../watch.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

/** A project folder with a source file, watched; `calls` gets every onChange. Gone when the test is over. */
function watched(t, options = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "busy-watch-test-")));
  mkdirSync(join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "src", "main.ts"), "draw(1);\n");
  writeFileSync(join(dir, "src", "appmeta", "manifest.json"), "{}");
  const calls = [];
  const errors = [];
  const watcher = watchProject(dir, { onChange: (files) => calls.push(files), onError: (e) => errors.push(e), ...options });
  t.after(() => {
    watcher.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { dir, calls, errors, watcher };
}

test("ignored(): the build's and the tools' folders, dot names and backups; not the sources", () => {
  for (const name of ["dist", "dist/app.tgz", "Dist\\app.tgz", "screenshots/front-1.png", "node_modules/x/index.js", "shared/node_modules/x.js", ".busy/state.json", ".git/HEAD", ".DS_Store", "src/._main.ts", "src/.main.ts.swp", "src/main.ts~", ".gitignore"]) {
    assert.equal(ignored(name), true, name);
  }
  for (const name of ["", "src/main.ts", "src\\appmeta\\manifest.json", "package.json", "assets/icon.png", "src/dist/x.ts", "src/screenshots.ts", "distance.ts"]) {
    assert.equal(ignored(name), false, name);
  }
});

test("a save is told once, after the quiet; a hundred saves in a row are one call", async (t) => {
  const { dir, calls } = watched(t);
  await pause(300); // what the system tells of the folder's own making is nothing: no file differs
  assert.deepEqual(calls, []);
  writeFileSync(join(dir, "src", "main.ts"), "draw(2);\n");
  await until("the save", () => calls.length);
  assert.deepEqual(calls, [["src/main.ts"]]);
  for (let i = 0; i < 100; i++) writeFileSync(join(dir, "src", "main.ts"), `draw(${i + 3});\n`);
  await until("the burst", () => calls.length > 1);
  await pause(600);
  assert.deepEqual(calls.slice(1), [["src/main.ts"]], "one call for the burst");
});

test("the quiet is counted from the last save: saves 50 ms apart are one call, after them", async (t) => {
  const { dir, calls } = watched(t, { debounceMs: 600 });
  await pause(300);
  for (let i = 0; i < 8; i++) {
    writeFileSync(join(dir, "src", "main.ts"), `draw(${i + 10});\n`);
    assert.deepEqual(calls, [], "nothing while the saves go on");
    await pause(50);
  }
  await until("the call", () => calls.length);
  await pause(500);
  assert.deepEqual(calls, [["src/main.ts"]]);
});

test("dist/, node_modules/, .busy/, screenshots/ and dot files start nothing; a new and a removed source do", async (t) => {
  const { dir, calls } = watched(t);
  await pause(300);
  for (const folder of ["dist", "node_modules/pkg", ".busy", "screenshots", ".git"]) mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, "dist", "app.tgz"), "package");
  writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "x");
  writeFileSync(join(dir, ".busy", "state.json"), "{}");
  writeFileSync(join(dir, "screenshots", "front-1.png"), "png");
  writeFileSync(join(dir, ".git", "HEAD"), "ref");
  writeFileSync(join(dir, ".DS_Store"), "x");
  writeFileSync(join(dir, "src", "._main.ts"), "x");
  writeFileSync(join(dir, "src", "main.ts~"), "x");
  await pause(800);
  assert.deepEqual(calls, [], "nothing of these is watched");
  // The watch is alive: a new source file is told, and so is its removal.
  mkdirSync(join(dir, "src", "lib"));
  writeFileSync(join(dir, "src", "lib", "util.ts"), "export {};\n");
  await until("the new file", () => calls.length === 1);
  assert.deepEqual(calls[0], ["src/lib/util.ts"]);
  rmSync(join(dir, "src", "lib", "util.ts"));
  await until("the removal", () => calls.length === 2);
  assert.deepEqual(calls[1], ["src/lib/util.ts"]);
});

test("a save through a temporary file and a rename, as editors save, is the change of the file", async (t) => {
  const { dir, calls } = watched(t);
  await pause(300);
  writeFileSync(join(dir, "src", ".main.ts.tmp"), "draw('renamed');\n");
  renameSync(join(dir, "src", ".main.ts.tmp"), join(dir, "src", "main.ts"));
  await until("the save", () => calls.length);
  await pause(500);
  assert.deepEqual(calls, [["src/main.ts"]]);
});

test("a file written again with the same bytes, or only touched, starts nothing", async (t) => {
  const { dir, calls } = watched(t);
  await pause(300);
  writeFileSync(join(dir, "src", "main.ts"), "draw(1);\n");
  const later = new Date(Date.now() + 5000);
  utimesSync(join(dir, "package.json"), later, later);
  await pause(800);
  assert.deepEqual(calls, []);
  writeFileSync(join(dir, "src", "main.ts"), "draw(2);\n");
  await until("a real save", () => calls.length);
  assert.deepEqual(calls, [["src/main.ts"]]);
});

test("look() and changedBetween(): new, gone and changed files, by content", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "busy-watch-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "src", "a.ts"), "a");
  writeFileSync(join(dir, "src", "b.ts"), "b");
  writeFileSync(join(dir, "dist", "out.tgz"), "x");
  const first = look(dir);
  assert.deepEqual([...first.keys()].sort(), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(changedBetween(first, look(dir, first)), []);
  writeFileSync(join(dir, "src", "a.ts"), "A");
  rmSync(join(dir, "src", "b.ts"));
  writeFileSync(join(dir, "src", "c.ts"), "c");
  assert.deepEqual(changedBetween(first, look(dir, first)), ["src/a.ts", "src/b.ts", "src/c.ts"]);
});

test("a file that cannot be read at the moment is not told as changed until it can be read", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "needs a file the owner may not read" }, async (t) => {
  const { dir, calls } = watched(t);
  await pause(300);
  const file = join(dir, "src", "main.ts");
  writeFileSync(file, "draw('locked');\n");
  chmodSync(file, 0o000);
  try {
    await pause(800);
    assert.deepEqual(calls, [], "not told while it cannot be read");
    // look() names it: a first look has nothing of it yet, a later one keeps what it knew.
    const unread = [];
    assert.equal(look(dir, null, unread).has("src/main.ts"), false);
    assert.deepEqual(unread, ["src/main.ts"]);
  } finally {
    chmodSync(file, 0o644);
  }
  // No notification is needed: the watcher looks again by itself.
  await until("the change, once readable", () => calls.length);
  assert.deepEqual(calls, [["src/main.ts"]]);
});

test("oneAtATime: rounds never overlap; saves during a round make exactly one more round, with all their files", async () => {
  const rounds = [];
  let running = 0;
  let most = 0;
  let release;
  const loop = oneAtATime(async (files) => {
    running += 1;
    most = Math.max(most, running);
    rounds.push(files);
    await new Promise((resolve) => (release = resolve));
    running -= 1;
  });
  loop.push([]);
  await pause(10);
  loop.push(["src/a.ts"]);
  loop.push(["src/b.ts"]);
  loop.push(["src/a.ts"]);
  assert.equal(rounds.length, 1, "the second round waits for the first");
  release();
  await pause(10);
  assert.deepEqual(rounds, [[], ["src/a.ts", "src/b.ts"]]);
  release();
  await loop.idle();
  assert.equal(rounds.length, 2, "exactly one more round");
  assert.equal(most, 1);
  // A round that fails does not stop the next one.
  const after = [];
  const failing = oneAtATime(async (files) => {
    after.push(files);
    if (after.length === 1) throw new Error("the round failed");
  });
  failing.push(["x"]);
  failing.push(["y"]);
  await failing.idle();
  assert.deepEqual(after, [["x"], ["y"]]);
  // Closed: nothing starts any more.
  failing.close();
  failing.push(["z"]);
  await failing.idle();
  assert.equal(after.length, 2);
});
