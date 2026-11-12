// The folder dialogs of the window's actions: the system's dialog for a folder, never a file; nothing on the screen
// in a hidden run; and the tests' stand-in for the person's choice, which works only with the test entry.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createFolderDialogs, FOLDER_DIALOGS } from "../../src/folder-dialogs.mjs";

function setup(config = {}, answer = { canceled: false, filePaths: ["/Users/you/work/my app"] }, platform = "darwin") {
  const shown = [];
  const lines = [];
  let forward = 0;
  const dialogs = createFolderDialogs({
    showOpenDialog: async (options) => (shown.push(options), typeof answer === "function" ? answer() : answer),
    config: { hidden: false, testHook: null, ...config },
    startFolder: "/Users/you/Documents",
    log: (line) => lines.push(line),
    comeForward: () => (forward += 1),
    platform,
  });
  return { dialogs, shown, lines, forward: () => forward };
}

test("a new app: a dialog for a folder, where one can be made; it opens in the person's documents, then where they last chose", async () => {
  const { dialogs, shown, forward } = setup();
  assert.equal(await dialogs.chooseNew(), "/Users/you/work/my app");
  assert.deepEqual(shown[0], { title: "New App", message: FOLDER_DIALOGS.create.message, buttonLabel: "Create Here", defaultPath: "/Users/you/Documents", properties: ["openDirectory", "createDirectory", "promptToCreate", "dontAddToRecent"] });
  assert.equal(await dialogs.chooseExisting(), "/Users/you/work/my app");
  assert.deepEqual(shown[1], { title: "Open App Folder", message: FOLDER_DIALOGS.open.message, buttonLabel: "Open", defaultPath: "/Users/you/work", properties: ["openDirectory", "dontAddToRecent"] });
  for (const options of shown) assert.equal(options.properties.includes("openFile"), false);
  assert.equal(forward(), 2);
});

test("Open existing: macOS takes a folder or a file in one dialog; Windows and Linux one or the other, as the page's button asks", async () => {
  const mac = setup({}, { canceled: false, filePaths: ["/Users/you/work/clock/src/scripts/main.js"] });
  assert.equal(await mac.dialogs.chooseAny(), "/Users/you/work/clock/src/scripts/main.js");
  assert.deepEqual(mac.shown[0], { title: "Open Existing App", message: "Choose the app's folder, or any file in it.", buttonLabel: "Choose", defaultPath: "/Users/you/Documents", properties: ["openFile", "openDirectory", "dontAddToRecent"] });
  await mac.dialogs.chooseAny("folder");
  await mac.dialogs.chooseAny("file");
  await mac.dialogs.chooseAny("--other");
  assert.deepEqual(mac.shown.slice(1).map((options) => options.properties), [["openDirectory", "dontAddToRecent"], ["openFile", "dontAddToRecent"], ["openFile", "openDirectory", "dontAddToRecent"]]);
  assert.equal(mac.shown[1].defaultPath, "/Users/you/work/clock/src/scripts", "then where the person chose last");
  for (const platform of ["win32", "linux"]) {
    const other = setup({}, undefined, platform);
    for (const pick of ["any", "folder", "file"]) await other.dialogs.chooseAny(pick);
    // Electron shows a folder dialog there when both are asked for: "any" is asked as a folder.
    assert.deepEqual(other.shown.map((options) => options.properties), [["openDirectory", "dontAddToRecent"], ["openDirectory", "dontAddToRecent"], ["openFile", "dontAddToRecent"]], platform);
  }
});

test("a dialog closed, one that gives nothing usable and one that fails: no folder", async () => {
  for (const answer of [{ canceled: true, filePaths: ["/x"] }, { canceled: false, filePaths: [] }, { canceled: false, filePaths: ["relative/path"] }, { canceled: false, filePaths: [7] }, null, () => Promise.reject(new Error("no display"))]) {
    const { dialogs } = setup({}, answer);
    assert.equal(await dialogs.chooseNew(), null);
    assert.equal(await dialogs.chooseExisting(), null);
  }
});

test("a hidden run shows no dialog and one dialog is open at a time", async () => {
  const hidden = setup({ hidden: true });
  assert.equal(await hidden.dialogs.chooseNew(), null);
  assert.equal(await hidden.dialogs.chooseExisting(), null);
  assert.deepEqual(hidden.shown, []);

  let close;
  const slow = setup({}, () => new Promise((resolve) => (close = resolve)));
  const first = slow.dialogs.chooseExisting();
  await Promise.resolve();
  assert.equal(await slow.dialogs.chooseNew(), null, "a second dialog while one is open");
  close({ canceled: false, filePaths: ["/Users/you/a"] });
  assert.equal(await first, "/Users/you/a");
  assert.equal(slow.shown.length, 1);
});

test("the tests' stand-in answers only with the test entry; without it (a release) it is not even kept", async () => {
  const test = setup({ hidden: true, testHook: "/tmp/hook.sock" });
  test.dialogs.standIn("/Users/you/chosen by the test");
  test.dialogs.standIn(null);
  assert.equal(await test.dialogs.chooseNew(), "/Users/you/chosen by the test");
  assert.equal(await test.dialogs.chooseExisting(), null);
  assert.equal(await test.dialogs.chooseExisting(), null, "the stand-ins are used up: a hidden run again");
  assert.deepEqual(test.shown, []);
  assert.match(test.lines[0], /answered by the test's stand-in/);

  const release = setup({ hidden: false, testHook: null });
  release.dialogs.standIn("/etc");
  assert.equal(await release.dialogs.chooseExisting(), "/Users/you/work/my app", "the person's own choice");
  assert.equal(release.shown.length, 1);
});

test("Create app's Location: a dialog for a folder, where a new one can be made, opening where the form's place is", async () => {
  const { dialogs, shown } = setup({}, { canceled: false, filePaths: ["/Users/you/apps"] });
  assert.equal(await dialogs.chooseParent("/Users/you/BUSY Bar projects"), "/Users/you/apps");
  assert.deepEqual(shown[0], { title: "Location", message: FOLDER_DIALOGS.parent.message, buttonLabel: "Choose", defaultPath: "/Users/you/BUSY Bar projects", properties: ["openDirectory", "createDirectory", "promptToCreate", "dontAddToRecent"] });
  // The next dialog opens in the folder chosen, not beside it.
  await dialogs.chooseNew();
  assert.equal(shown[1].defaultPath, "/Users/you/apps");
});
