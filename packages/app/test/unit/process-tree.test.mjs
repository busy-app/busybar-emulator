// The window tests' process tree (helpers.mjs: treeOf, endTree), against a process table of the test's own: what
// close() of the harness ends must be the app's, never a process that got the number of one of the app's after it
// ended (EMU-330 review: on Windows numbers are given again soon, and taskkill /T walked the stranger's children).
import assert from "node:assert/strict";
import { test } from "node:test";

import { endTree, namedAfterExit, parseProcessRows, taskkillArgs, treeOf } from "../helpers.mjs";

const at = (s) => Date.parse(`2026-11-18T02:00:${String(s).padStart(2, "0")}Z`);
const spawned = at(10);

test("the tree is the processes below the root started since the spawn; a root or child older than the spawn is a stranger's", () => {
  const table = [
    { pid: 100, parent: 1, started: at(10), command: "electron" },
    { pid: 101, parent: 100, started: at(11), command: "electron --type=gpu-process" },
    { pid: 102, parent: 101, started: at(12), command: "node cli.mjs dev" },
    // Older than its "parent": the number 100 was another's when it started.
    { pid: 103, parent: 100, started: at(2), command: "an older process" },
  ];
  assert.deepEqual(treeOf(table, [100], { since: spawned }).map((p) => p.pid), [100, 101, 102]);

  // The app's main process has ended and a stranger has its number now, with children of its own: started before
  // the spawn (the stranger) or after it, they are not the app's when the stranger is not.
  const reused = [
    { pid: 100, parent: 1, started: at(5), command: "a stranger" },
    { pid: 200, parent: 100, started: at(30), command: "the stranger's child" },
  ];
  assert.deepEqual(treeOf(reused, [100], { since: spawned }), []);
  // ps gives whole seconds: a process of the spawn's own second is the app's.
  assert.deepEqual(treeOf([{ pid: 100, parent: 1, started: spawned - 900, command: "electron" }], [100], { since: spawned }).map((p) => p.pid), [100]);
  // Without `since` (the development loop's watch), as before.
  assert.deepEqual(treeOf(reused, [100]).map((p) => p.pid), [100, 200]);
});

test("endTree ends each process of the tree that is still the same process, by itself; taskkill without /T", async () => {
  const tree = [
    { pid: 100, started: at(10) },
    { pid: 101, started: at(11) },
    { pid: 102, started: at(12) },
  ];
  const now = [
    { pid: 100, parent: 1, started: at(10), command: "electron" },
    // 101 has ended and its number is another process's now.
    { pid: 101, parent: 7, started: at(40), command: "a stranger" },
  ];
  const killed = [];
  const ended = await endTree(tree, { list: async () => now, kill: async (pid) => (killed.push(pid), true) });
  assert.deepEqual([ended, killed], [[100], [100]]);
  assert.deepEqual(taskkillArgs(4242), ["/PID", "4242", "/F"]);
});

test("the system's rows are read on both systems", () => {
  const mac = parseProcessRows("  100     1 Wed Nov 18 02:00:10 2026     /Applications/Electron.app/Contents/MacOS/Electron .\n", "darwin");
  assert.deepEqual(mac.map((p) => [p.pid, p.parent, p.command]), [[100, 1, "/Applications/Electron.app/Contents/MacOS/Electron ."]]);
  const win = parseProcessRows("100\t4\t2026-11-18T02:00:10.0000000Z\t\"C:\\x\\electron.exe\" .\r\n", "win32");
  assert.deepEqual(win, [{ pid: 100, parent: 4, started: at(10), command: '"C:\\x\\electron.exe" .' }]);
});

test("once the app's main process has ended, its number is no longer one of the app's: a stranger may have it", () => {
  const after = namedAfterExit({ own: new Set([300, 301]), chromium: new Set([100, 101, 102]), main: 100 });
  assert.deepEqual(after, { own: [300, 301], chromium: [101, 102] });
});
