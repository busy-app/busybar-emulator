// Delete in the Apps list (apps.delete, actions.mjs) on plain Node, with a stand-in for the command line and for the
// system's Trash: the app is removed by `busy-emulator uninstall <id>`; with its files, only the folder of a project
// of the emulator's list goes to the Trash, by its real path, and never a link to another place, a folder not in the
// list, the data folder, the home folder or the root of a disk. The same in the running app: test/app/apps-delete.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { createActions, trashableFolder, windowsRecycleRefusal } from "../../src/actions.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const root = realpathSync(temporaryFolder());
after(() => removeFolder(root));
const HOME = path.join(root, "home");
const DATA = path.join(HOME, "Library", "Application Support", "BUSY Bar Emulator");
const CLOCK = path.join(HOME, "projects", "Ρολόι");
const ELSEWHERE = path.join(root, "somebody else's");
const LINK = path.join(HOME, "projects", "a link");
for (const dir of [DATA, CLOCK, path.join(ELSEWHERE, "inner")]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(CLOCK, "package.json"), "{}");
writeFileSync(path.join(HOME, "projects", "a file"), "");
const linked = (() => {
  try {
    symlinkSync(ELSEWHERE, LINK, "junction");
    return true;
  } catch {
    return false;
  }
})();

const BIN = process.platform === "win32" ? "Recycle Bin" : "Trash";
const entry = (folder, more = {}) => ({ id: "app.you.clock", name: "Clock", folder, exists: true, unavailable: false, trusted: true, built: true, installed: true, running: false, ...more });

function setup({ projects = [entry(CLOCK)], uninstall = { ok: true, id: "app.you.clock", removed_from_bar: true, was_running: false, forgotten: [CLOCK], kept: [CLOCK], trashed: null }, trash = async () => {}, trashRefusal = () => null, platform = process.platform } = {}) {
  const calls = [];
  const trashed = [];
  const state = { projects };
  const startCli = (args) => {
    calls.push(args.filter((word) => word !== "--json").join(" "));
    const words = args.filter((word) => word !== "--json");
    let answer;
    if (words[0] === "projects") answer = { ok: true, removed: [], bar: "ready", projects: state.projects };
    else if (words[0] === "uninstall") {
      answer = typeof uninstall === "function" ? uninstall(words) : uninstall;
      if (answer.ok) state.projects = state.projects.filter((one) => one.id !== words[1]);
    } else answer = { ok: true };
    return { pid: 1, exited: Promise.resolve({ code: answer.ok ? 0 : 1, signal: null, error: null, lines: [JSON.stringify(answer)] }), interrupt: () => {}, killNow: () => {} };
  };
  const actions = createActions({
    startCli,
    dialogs: { chooseNew: async () => null, chooseExisting: async () => null },
    show: () => {},
    copy: () => {},
    trash: async (folder) => {
      trashed.push(folder);
      await trash(folder);
    },
    trashRefusal,
    home: HOME,
    send: () => {},
    dataDir: DATA,
    logFile: "/data/logs/shell.log",
    log: () => {},
    platform,
  });
  const call = async (arg) => {
    const answer = await actions.call("apps.delete", arg);
    return answer.ok ? answer.value : { rejected: answer.error };
  };
  return { call, calls, trashed, state, work: () => calls.filter((line) => !line.startsWith("projects")) };
}

test("Remove from the emulator: busy-emulator uninstall <id>, and nothing goes to the Trash; the folder is said to stay", async () => {
  const { call, work, trashed } = setup();
  const answer = await call({ id: "app.you.clock", withFiles: false });
  assert.deepEqual(answer, { ok: true, id: "app.you.clock", trashed: null, kept: [CLOCK], message: `Removed app.you.clock from the emulator. Its files stay in ${CLOCK}.` });
  assert.deepEqual(work(), ["uninstall app.you.clock"]);
  assert.deepEqual(trashed, []);
});

test("Remove and delete its files: the project's folder, by its real path, goes to the Trash after the app is removed", async () => {
  const { call, work, trashed } = setup();
  const answer = await call({ id: "app.you.clock", withFiles: true });
  assert.deepEqual(answer, { ok: true, id: "app.you.clock", trashed: CLOCK, kept: [], message: `Removed app.you.clock from the emulator. Its folder is in the ${BIN}.` });
  assert.deepEqual(work(), ["uninstall app.you.clock"]);
  assert.deepEqual(trashed, [CLOCK]);
});

test("an app from a package has no folder to delete: only its removal from the emulator", async () => {
  const { call, work, trashed } = setup({ projects: [], uninstall: { ok: true, id: "app.jane.status-board", removed_from_bar: true, forgotten: [], kept: [], trashed: null } });
  assert.equal((await call({ id: "app.jane.status-board", withFiles: true })).code, "no_project_folder");
  assert.deepEqual([work(), trashed], [[], []], "refused before anything changed");
  assert.deepEqual(await call({ id: "app.jane.status-board" }), { ok: true, id: "app.jane.status-board", trashed: null, kept: [], message: "Removed app.jane.status-board from the emulator." });
});

test("the folder the Trash gets is checked before anything changes: not in the list, a link to another place, the data folder, the home folder, the root", async () => {
  const cases = [
    ["a project whose folder is now a link to another place", [entry(LINK)], linked],
    ["the data folder listed as a project", [entry(DATA)], true],
    ["a folder above the data folder", [entry(path.join(HOME, "Library"))], true],
    ["the home folder", [entry(HOME)], true],
    ["the root of the disk", [entry(path.parse(root).root)], true],
    ["a file, not a folder", [entry(path.join(HOME, "projects", "a file"))], true],
  ];
  for (const [what, projects, runs] of cases) {
    if (!runs) continue;
    const { call, work, trashed } = setup({ projects });
    const answer = await call({ id: "app.you.clock", withFiles: true });
    assert.equal(answer.ok, false, what);
    assert.equal(answer.code, "not_deletable", what);
    assert.deepEqual([work(), trashed], [[], []], `${what}: nothing was removed, nothing was moved`);
  }
  // Two project folders of the same app: which one is meant is not guessed.
  const two = setup({ projects: [entry(CLOCK), entry(ELSEWHERE)] });
  assert.equal((await two.call({ id: "app.you.clock", withFiles: true })).code, "several_folders");
  assert.deepEqual(two.work(), []);
});

test("trashableFolder: the rule itself", { skip: !linked && "this system makes no links here" }, () => {
  const rule = (folder, registered = [folder]) => trashableFolder(folder, { registered, dataDir: DATA, home: HOME, platform: process.platform });
  assert.deepEqual(rule(CLOCK), { folder: CLOCK });
  assert.equal(rule(CLOCK, [ELSEWHERE]).refused.code, "not_deletable", "a folder not in the list");
  assert.match(rule(CLOCK, [ELSEWHERE]).refused.message, /not among the emulator's projects/);
  assert.match(rule(LINK).refused.message, /link to another place/);
  // A folder reached through a link: its real path is somewhere else.
  assert.match(rule(path.join(LINK, "inner")).refused.message, /link to another place/);
  assert.match(rule(DATA).refused.message, /data folder/);
  assert.match(rule(path.join(DATA, "bar")).refused.message, /data folder|not there/);
  assert.match(rule(HOME).refused.message, /home folder/);
  assert.match(rule(path.dirname(HOME)).refused.message, /home folder/);
  assert.match(rule("relative/path", ["relative/path"]).refused.message, /not a project folder/);
  assert.match(rule(path.join(CLOCK, "gone")).refused.message, /not there/);
});

test("the page's argument is checked: an id of the bar's form, withFiles a boolean", async () => {
  const { call, work } = setup();
  for (const arg of [null, "app.you.clock", {}, { id: "" }, { id: "../etc" }, { id: "a b" }, { id: "x".repeat(200) }, { id: "app.you.clock", withFiles: "yes" }]) {
    const answer = await call(arg);
    assert.equal(answer.ok, false, JSON.stringify(arg));
    assert.equal(answer.code, "usage", JSON.stringify(arg));
  }
  assert.deepEqual(work(), []);
});

test("what fails is said in plain words: the command line's refusal, and a Trash that would not take the folder", async () => {
  const refused = setup({ uninstall: { ok: false, code: "not_running", message: "The emulator is not running, so there is no bar to remove the app from.", hint: "Start it." } });
  assert.deepEqual(await refused.call({ id: "app.you.clock", withFiles: true }), { ok: false, code: "not_running", message: "The emulator is not running, so there is no bar to remove the app from.", hint: "Start it." });
  assert.deepEqual(refused.trashed, [], "the folder is not moved when the app was not removed");

  const stuck = setup({
    trash: async () => {
      throw new Error("The operation couldn't be completed.");
    },
  });
  const answer = await stuck.call({ id: "app.you.clock", withFiles: true });
  assert.equal(answer.code, "trash_failed");
  assert.match(answer.message, /app\.you\.clock was removed from the emulator, but its folder could not be moved to the (Trash|Recycle Bin): The operation couldn't be completed\./);
  assert.equal(answer.hint, `The folder is as it was, in ${CLOCK}.`);
});

test("where Windows has no Recycle Bin for the folder (a USB stick, a share, a service's session), nothing is removed and nothing moved", async () => {
  const { call, work, trashed } = setup({ trashRefusal: () => "The folder is not on a fixed disk of this computer, which has no Recycle Bin, so it was not moved. Move it yourself." });
  const answer = await call({ id: "app.you.clock", withFiles: true });
  assert.deepEqual([answer.ok, answer.code], [false, "no_recycle_bin"]);
  assert.deepEqual([work(), trashed], [[], []]);
  // Without its files it is removed all the same.
  assert.equal((await call({ id: "app.you.clock", withFiles: false })).ok, true);

  // The check itself: a share is refused without asking; otherwise PowerShell says ok, session or drive.
  const asked = [];
  const run = (said) => (program, args, options) => (asked.push([program, options.env.BUSY_EMULATOR_TRASH]), `${said}\r\n`);
  const env = { SystemRoot: "C:\\Windows" };
  assert.match(windowsRecycleRefusal("//nas/work/clock", { env, run: run("ok") }), /network share/);
  assert.deepEqual(asked, []);
  assert.equal(windowsRecycleRefusal("D:\\work\\Ρολόι", { env, run: run("ok") }), null);
  assert.deepEqual(asked, [["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "D:\\work\\Ρολόι"]]);
  assert.match(windowsRecycleRefusal("E:\\clock", { env, run: run("drive") }), /not on a fixed disk/);
  assert.match(windowsRecycleRefusal("C:\\clock", { env, run: run("session") }), /no Recycle Bin/);
  const broken = () => {
    throw new Error("powershell.exe not found");
  };
  assert.match(windowsRecycleRefusal("C:\\clock", { env, run: broken }), /did not say .* so it was not moved/);
});
