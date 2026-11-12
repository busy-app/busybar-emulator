// The window's actions on app projects (EMU-260, EMU-261), in the running app with the real server: who may ask, what
// a folder named by the page is good for, where trust comes from, one job for a project, and the end of the
// development loop with the window and with the app. The system's dialogs are answered by the tests' stand-ins
// (folder-dialogs.mjs, person-question.mjs): a hidden run shows none. The projects here have a stand-in for busy-cli,
// so nothing goes to the network; the real tools are in actions-project.test.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { alive, HAS_REAL_SERVER, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";

/** A stand-in for the project's busy-cli: build writes the package's file, the rest does nothing; all end with 0. */
const BUSY_CLI = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const words = process.argv.slice(2);
if (words[0] === "build") {
  const id = JSON.parse(readFileSync("src/appmeta/manifest.json", "utf8")).id;
  mkdirSync("dist", { recursive: true });
  writeFileSync("dist/" + id + ".tgz", "");
}
console.log("busy-cli stand-in: " + words.join(" "));
`;

let work;
let n = 0;
/** A project folder the emulator did not create, with the stand-in for busy-cli installed. */
function strangerProject(id = `app.stranger.n${n}`) {
  const dir = path.join(work, `made elsewhere ${n++}`);
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  mkdirSync(cli, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id, name: "Stranger" }));
  writeFileSync(path.join(dir, "src", "main.js"), "// the app\n");
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", type: "module", bin: { "busy-cli": "cli.mjs" } }));
  writeFileSync(path.join(cli, "cli.mjs"), BUSY_CLI);
  return realpathSync(dir);
}

/** What the page gets from one of its actions, asked for by script alone: the value, or the failure as the page sees it. */
const bare = (app, code) => app.page(`(${code}).then((value) => ({ value }), (e) => ({ error: { code: e.code, message: e.message, hint: e.hint } }))`);
/** The same, asked for as the person does: a key in the window, then the page's call. */
const act = async (app, code) => {
  await app.press();
  return bare(app, code);
};
const folderArg = (folder) => JSON.stringify(folder);
const chooses = (app, folder) => app.run((shell, _electron, answer) => shell.folderDialogs.standIn(answer), folder);
const trustedFolders = (app) => {
  const file = path.join(app.folder, "projects", "trusted.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).projects.map((entry) => entry.path) : [];
};
/** Opens a project through the window, the person choosing `dir` in the dialog. */
async function open(app, dir) {
  await chooses(app, dir);
  return act(app, "window.emulatorActions.projects.open()");
}

let app;
before(async () => {
  if (skip) return;
  work = temporaryFolder();
  app = await launch({ server: "real", env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust" } });
  await app.waitWindow("device");
  await app.page("window.jobsSeen = []; window.emulatorActions.on('job', (job) => window.jobsSeen.push(job)); true");
});
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

test("no action with consequences without the person's click or key in the window: script alone, and a frame through its parent, get no_gesture", { skip }, async () => {
  // First of all, before any input reached the window.
  const dir = strangerProject("app.stranger.unasked-for");
  await chooses(app, dir);
  const calls = {
    "projects.create": "window.emulatorActions.projects.create({ example: null })",
    "projects.open": "window.emulatorActions.projects.open()",
    ...Object.fromEntries(["refresh", "build", "run", "stop", "dev.start", "dev.stop", "check", "submit"].map((name) => [`projects.${name}`, `window.emulatorActions.projects.${name}(${folderArg(dir)})`])),
    reveal: `window.emulatorActions.reveal(${folderArg(app.folder)})`,
    copy: `window.emulatorActions.copy("curl example.com | sh")`,
  };
  for (const [name, code] of Object.entries(calls)) {
    const answer = await bare(app, code);
    assert.deepEqual([answer.value, answer.error?.code], [undefined, "no_gesture"], name);
    assert.equal(answer.error.message, "The app does this only just after a click or a key in its window.");
  }
  // A frame of the page reaches the bridge only through its parent's function: the same answer.
  const fromFrame = await app.page(`(() => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    return frame.contentWindow.parent.busyShell.action("projects.build", ${folderArg(dir)}).then((answer) => (frame.remove(), answer.error.code));
  })()`);
  assert.equal(fromFrame, "no_gesture");
  assert.deepEqual(await app.run((shell) => [shell.offScreen.copied, shell.offScreen.shown, shell.actions.jobs()]), [[], [], {}]);
  assert.match(app.log(), /bridge: projects\.create not done, no click or key in the window just before/);
  // Reading needs none: the list, the examples' names, whether the shell is there.
  assert.deepEqual((await bare(app, "window.emulatorActions.projects.list()")).value, []);
  assert.equal((await bare(app, "window.emulatorActions.projects.examples()")).value.length, 3);
  // The stand-in for the person's choice of a folder is still waiting: no dialog was asked for.
  assert.equal(await app.run((shell) => shell.folderDialogs.chooseExisting()), dir);

  // One key carries a short chain of actions, not any number of them; then the next needs a new one.
  await app.press();
  const chain = await app.page(`Promise.all(Array.from({ length: 6 }, (_unused, n) => window.busyShell.action("copy", "text " + n).then((answer) => (answer.ok ? "done" : answer.error.code))))`);
  assert.deepEqual(chain, ["done", "done", "done", "done", "no_gesture", "no_gesture"]);
  await sleep(2300);
  assert.equal((await bare(app, `window.emulatorActions.copy("later")`)).error.code, "no_gesture", "the key was a while ago");
  assert.equal((await act(app, `window.emulatorActions.copy("x".repeat(64 * 1024 + 1))`)).value, false, "more than the clipboard takes from the window");
  assert.deepEqual(await app.run((shell) => shell.offScreen.copied.splice(0)), ["text 0", "text 1", "text 2", "text 3"]);
});

test("the main window's page has the actions; a frame in it and the local web's window have nothing of the shell", { skip }, async () => {
  assert.deepEqual(await app.page("window.emulatorActions.available()"), { shell: true });
  assert.deepEqual(await app.page("Object.keys(window.busyShell).sort()"), ["action", "onJob", "onMenu"]);
  assert.deepEqual((await act(app, "window.emulatorActions.projects.list()")).value, []);
  // The message page's own three actions are not this page's, and names the bridge does not know are refused.
  for (const name of ["app.quit", "server.retry", "message.get", "projects.trust", "constructor"]) {
    assert.equal(await app.page(`window.busyShell.action(${JSON.stringify(name)}).then(() => "allowed", () => "refused")`), "refused", name);
  }
  assert.match(app.log(), /bridge: refused "app\.quit" from http:\/\/127\.0\.0\.1:\d+: not a page that may call it/);

  // A frame the page makes: no preload runs there, and the bridge takes calls from the top frame only (bridge.test.mjs).
  const inFrame = await app.page(`(() => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const seen = [typeof frame.contentWindow.busyShell, typeof frame.contentWindow.emulatorActions];
    frame.remove();
    return seen;
  })()`);
  assert.deepEqual(inFrame, ["undefined", "undefined"]);

  // The local web's window: the same origin, another kind of window, no bridge.
  await app.run((shell) => void shell.showAppSettings());
  await until(() => app.run((shell) => Boolean(shell.windows.localWeb?.presented && !shell.windows.localWeb.win.webContents.isLoading())), "the local web's window");
  const web = (code) => app.run((shell, _electron, source) => shell.windows.localWeb.win.webContents.executeJavaScript(source, true), code);
  assert.deepEqual(await web("[typeof window.busyShell, typeof window.emulatorActions]"), ["undefined", "undefined"]);
  await app.run((shell) => shell.windows.closeLocalWeb());
});

test("a folder the page names is only looked up among the emulator's projects: any other is refused and nothing runs", { skip }, async () => {
  const dir = strangerProject();
  for (const action of ["refresh", "build", "run", "stop", "dev.start", "check", "submit"]) {
    for (const folder of [dir, "/", path.join(dir, ".."), "", "--trust"]) {
      const answer = (await act(app, `window.emulatorActions.projects.${action}(${folderArg(folder)})`)).value;
      assert.deepEqual([answer.ok, answer.code], [false, "unknown_project"], `${action} ${folder}`);
    }
  }
  assert.equal(existsSync(path.join(dir, "dist")), false);
  assert.deepEqual(trustedFolders(app), []);
  assert.deepEqual(await app.run((shell) => shell.actions.jobs()), {});
  // The page cannot choose a folder either: without the person's choice in the dialog, open and create do nothing.
  assert.deepEqual(await act(app, "window.emulatorActions.projects.open()"), { value: null });
  assert.deepEqual(await act(app, `window.emulatorActions.projects.create({ example: null, folder: ${folderArg(dir)} })`), { value: null });
  assert.equal((await act(app, `window.emulatorActions.projects.create({ example: "../../etc" })`)).error.code, "usage");
});

test("Open App Folder: a project made elsewhere goes through the trust dialog once, is listed with its folder, and then builds, runs and stops", { skip }, async () => {
  const dir = strangerProject("app.stranger.opened");
  const opened = await open(app, dir);
  assert.deepEqual(opened.value, { id: "app.stranger.opened", name: "Stranger", folder: dir, exists: true, unavailable: false, trusted: true, built: false, installed: false, running: false, dependencies: { state: "installed", reason: null, message: null, retry: false }, shownFolder: dir, stale: false, job: null });
  assert.deepEqual(trustedFolders(app), [dir]);
  assert.equal(app.log().split("answered by the test's stand-in (trust)").length - 1, 1, "the person was asked once");
  // Again: trusted already, nobody is asked.
  assert.equal((await open(app, dir)).value.folder, dir);
  assert.equal(app.log().split("answered by the test's stand-in (trust)").length - 1, 1);

  const built = (await act(app, `window.emulatorActions.projects.build(${folderArg(dir)})`)).value;
  assert.deepEqual(built, { ok: true, message: "Built app.stranger.opened." });
  assert.ok(existsSync(path.join(dir, "dist", "app.stranger.opened.tgz")));
  const listed = (await act(app, "window.emulatorActions.projects.list()")).value.find((project) => project.folder === dir);
  assert.equal(listed.built, true);
  assert.equal((await act(app, `window.emulatorActions.projects.stop(${folderArg(dir)})`)).value.ok, true);

  // The page heard of each job: it ran, then it was done.
  const jobs = await app.page("window.jobsSeen");
  const states = (kind) => jobs.filter((job) => job.kind === kind && job.folder === dir).map((job) => job.state);
  assert.deepEqual([states("open").at(0), states("open").at(-1)], ["running", "done"]);
  assert.deepEqual([states("build").at(0), states("build").at(-1)], ["running", "done"]);
  assert.ok(jobs.some((job) => job.kind === "build" && job.line === "busy-cli build"), "the build's progress came as lines");
  // No action ever passes --trust: trust is the dialog's.
  assert.doesNotMatch(readFileSync(new URL("../../src/actions.mjs", import.meta.url), "utf8").replace(/\/\/.*$/gm, ""), /"--trust"/);
});

test("a project of the list that is no longer trusted (another folder at its path) is refused, and so is one whose folder is not a project any more", { skip }, async () => {
  const dir = strangerProject("app.stranger.replaced");
  assert.equal((await open(app, dir)).value.trusted, true);
  // Another folder is put at the path: the list still names the path, the trusted list does not trust this folder.
  const content = { package: readFileSync(path.join(dir, "package.json")), manifest: readFileSync(path.join(dir, "src", "appmeta", "manifest.json")) };
  rmSync(dir, { recursive: true });
  // The folder is gone and its disk is there: the project leaves the list.
  assert.equal((await act(app, "window.emulatorActions.projects.list()")).value.some((project) => project.folder === dir), false);
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), content.package);
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), content.manifest);
  const answer = (await act(app, `window.emulatorActions.projects.build(${folderArg(dir)})`)).value;
  assert.deepEqual([answer.ok, answer.code], [false, "unknown_project"]);

  // In the list and not trusted: the list is the server's file, written here as another program of the person's could.
  const file = path.join(app.folder, "projects", "registry.json");
  const list = JSON.parse(readFileSync(file, "utf8"));
  list.projects.unshift({ path: dir, volume: path.parse(dir).root, id: "app.stranger.replaced", name: "Stranger", at: new Date().toISOString() });
  writeFileSync(file, JSON.stringify(list));
  const listed = (await act(app, "window.emulatorActions.projects.list()")).value.find((project) => project.folder === dir);
  assert.deepEqual([listed.exists, listed.trusted], [true, false]);
  for (const action of ["refresh", "build", "run", "dev.start", "check", "submit"]) {
    const refused = (await act(app, `window.emulatorActions.projects.${action}(${folderArg(dir)})`)).value;
    assert.deepEqual([refused.ok, refused.code], [false, "untrusted_project"], action);
    assert.match(refused.hint, /Open App Folder/);
  }
  assert.equal(existsSync(path.join(dir, "dist")), false);
});

test("one job for a project at a time; the development loop reports its lines and ends when it is stopped", { skip }, async () => {
  const dir = strangerProject("app.stranger.loop");
  await open(app, dir);
  assert.deepEqual((await act(app, `window.emulatorActions.projects.dev.start(${folderArg(dir)})`)).value, { ok: true });
  const [pid] = await until(async () => {
    const pids = await app.run((shell) => shell.actions.pids());
    return pids.length === 1 && pids;
  }, "the development loop's process");
  await until(async () => (await app.page("window.jobsSeen")).some((job) => job.kind === "dev" && job.folder === dir && /ready/.test(job.line ?? "")), "the loop's first round");
  assert.equal((await act(app, "window.emulatorActions.projects.list()")).value.find((project) => project.folder === dir).job, "dev");

  for (const action of ["refresh", "build", "run", "stop", "dev.start", "check", "submit"]) {
    const answer = (await act(app, `window.emulatorActions.projects.${action}(${folderArg(dir)})`)).value;
    assert.deepEqual([answer.ok, answer.code], [false, "busy"], action);
  }
  assert.equal(alive(pid), true);
  // Another project is free meanwhile.
  const other = strangerProject("app.stranger.other");
  await open(app, other);
  assert.equal((await act(app, `window.emulatorActions.projects.build(${folderArg(other)})`)).value.ok, true);

  assert.deepEqual((await act(app, `window.emulatorActions.projects.dev.stop(${folderArg(dir)})`)).value, { ok: true });
  await until(() => !alive(pid), "the end of the development loop's process");
  assert.equal((await act(app, `window.emulatorActions.projects.dev.stop(${folderArg(dir)})`)).value.code, "not_running");
  const last = (await app.page("window.jobsSeen")).filter((job) => job.kind === "dev" && job.folder === dir).at(-1);
  assert.equal(last.state, "done");
  assert.equal((await act(app, `window.emulatorActions.projects.build(${folderArg(dir)})`)).value.ok, true, "the project is free again");
});

test("showing a folder: a project of the list, what is inside one, the data folder; nothing else. Copying keeps to text", { skip }, async () => {
  const dir = strangerProject("app.stranger.shown");
  await open(app, dir);
  const stranger = strangerProject("app.stranger.never-opened");
  const reveal = (target) => act(app, `window.emulatorActions.reveal(${folderArg(target)})`).then((answer) => answer.value);
  assert.equal(await reveal(dir), true);
  assert.equal(await reveal(path.join(dir, "src", "appmeta")), true);
  assert.equal(await reveal(path.join(app.folder, "logs")), true);
  for (const target of [stranger, work, "/", path.dirname(dir), path.join(dir, "..", path.basename(stranger)), path.join(dir, "no such folder"), "relative", "", `${dir} `]) {
    assert.equal(await reveal(target), false, target);
  }
  assert.deepEqual(await app.run((shell) => shell.offScreen.shown), [dir, path.join(dir, "src", "appmeta"), realpathSync(path.join(app.folder, "logs"))]);
  assert.match(app.log(), /actions: refused to show /);

  assert.equal((await act(app, `window.emulatorActions.copy(${folderArg(dir)})`)).value, true);
  assert.equal((await act(app, "window.emulatorActions.copy({ text: 1 })")).value, false);
  assert.deepEqual(await app.run((shell) => shell.offScreen.copied), [dir]);
});

test("the bar card's address and API version open the emulated bar's pages in the browser, on a click only", { skip }, async () => {
  const origin = await app.page("location.origin");
  assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await app.page(`document.querySelector("#bar-address").textContent`), origin);
  const before = (await app.run((shell) => shell.offScreen.browsed)).length;
  await app.click("#bar-address");
  await app.click("#api");
  await until(async () => (await app.run((shell) => shell.offScreen.browsed)).length === before + 2, "both pages asked of the browser");
  assert.deepEqual((await app.run((shell) => shell.offScreen.browsed)).slice(before), [`${origin}/`, `${origin}/docs/`]);
  // The window stays as it was: no local web window, no navigation.
  assert.equal(await app.page("location.pathname"), "/emulator");
  // Without a click the page cannot open the browser (the clicks above are a moment old: past the gesture's time), and
  // with one it opens nothing but the bar's own pages.
  await sleep(2500);
  assert.equal((await bare(app, `window.emulatorActions.browse(${JSON.stringify(`${origin}/docs/`)})`)).error?.code, "no_gesture");
  assert.equal((await act(app, `window.emulatorActions.browse(${JSON.stringify(`${origin}/emulator`)})`)).value, false);
  assert.equal((await act(app, `window.emulatorActions.browse("https://example.com/")`)).value, false);
  assert.equal((await app.run((shell) => shell.offScreen.browsed)).length, before + 2);
});

test("the menu has New App and Open App Folder, and they are the window's actions", { skip }, async () => {
  const items = await app.run((_shell, electron) => ["new-app", "open-app"].map((id) => electron.Menu.getApplicationMenu().getMenuItemById(id)?.label ?? null));
  assert.deepEqual(items, ["New App…", "Open App Folder…"]);
  const dir = strangerProject("app.stranger.menu");
  await chooses(app, dir);
  const answer = await app.run((shell) => shell.fromMenu("projects.open"));
  assert.equal(answer.value.folder, dir);
  assert.ok((await app.page("window.jobsSeen")).some((job) => job.kind === "open" && job.folder === dir && job.state === "done"), "the window heard of it");
  // The person closes the dialog: nothing happens.
  assert.deepEqual(await app.run((shell) => shell.fromMenu("projects.create")), { ok: true, value: null });
});

test("the development loop ends when the window closes", { skip }, async () => {
  const dir = strangerProject("app.stranger.window");
  await open(app, dir);
  await act(app, `window.emulatorActions.projects.dev.start(${folderArg(dir)})`);
  const [pid] = await until(async () => {
    const pids = await app.run((shell) => shell.actions.pids());
    return pids.length === 1 && pids;
  }, "the development loop's process");
  // The device window goes (here: the message window takes its place, as when the server stops).
  await app.run((shell) => shell.windows.showMessage());
  await until(() => !alive(pid), "the end of the development loop's process");
  // The job is let go of when the process's output closes too, at most half a second after its end (cli-process.mjs);
  // on Windows that comes later than the end this test sees.
  await until(async () => Object.keys(await app.run((shell) => shell.actions.jobs())).length === 0, "the job to be let go of", 5000);
  await app.run((shell) => shell.windows.showDevice());
  await app.waitWindow("device");
});

test("the development loop ends when the app quits", { skip }, async () => {
  const dir = strangerProject("app.stranger.quit");
  await open(app, dir);
  await act(app, `window.emulatorActions.projects.dev.start(${folderArg(dir)})`);
  const [pid] = await until(async () => {
    const pids = await app.run((shell) => shell.actions.pids());
    return pids.length === 1 && pids;
  }, "the development loop's process");
  await app.quit();
  await until(() => !alive(pid), "the end of the development loop's process");
});

test("the person's no in the trust dialog: the folder is not opened, not listed and not trusted", { skip }, async () => {
  const second = await launch({ server: "real", env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "refuse" } });
  try {
    await second.waitWindow("device");
    const dir = strangerProject("app.stranger.refused");
    assert.deepEqual(await open(second, dir), { value: null });
    assert.deepEqual((await act(second, "window.emulatorActions.projects.list()")).value, []);
    assert.deepEqual(trustedFolders(second), []);
    assert.equal((await act(second, `window.emulatorActions.projects.build(${folderArg(dir)})`)).value.code, "unknown_project");
  } finally {
    await second.close();
  }
});

test("a hidden run without the stand-ins shows no dialog: nobody chose a folder, and a folder nobody could be asked about stays untrusted", { skip }, async () => {
  const third = await launch({ server: "real" });
  try {
    await third.waitWindow("device");
    assert.deepEqual(await act(third, "window.emulatorActions.projects.open()"), { value: null });
    const dir = strangerProject("app.stranger.unasked");
    const answer = await open(third, dir);
    assert.equal(answer.error.code, "trust_unavailable");
    assert.deepEqual(trustedFolders(third), []);
    assert.deepEqual((await act(third, "window.emulatorActions.projects.list()")).value, []);
  } finally {
    await third.close();
  }
});

test("at its start the app lets a project go whose folder was deleted meanwhile; one whose disk is not there stays, unavailable", { skip }, async () => {
  const data = temporaryFolder();
  try {
    // A first run makes the data folder; then, while the app is not running, the list gets two projects whose
    // folders are gone: one from a disk that is there, one from a disk that is not.
    const first = await launch({ server: "real", dataDir: data });
    await first.waitWindow("device");
    await first.close();
    const deleted = path.join(work, "deleted while the app was closed");
    const away = path.join(work, "no disk is mounted here", "project");
    const file = path.join(data, "projects", "registry.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(file, JSON.stringify({ version: 1, projects: [{ path: deleted, volume: path.parse(deleted).root, id: "app.you.deleted", name: "Deleted", at }, { path: away, volume: path.dirname(away), id: "app.you.away", name: "Away", at }] }));

    const second = await launch({ server: "real", dataDir: data });
    try {
      await second.waitWindow("device");
      // Nobody asks for the list: the app reads it by itself once its server is ready.
      await until(() => JSON.parse(readFileSync(file, "utf8")).projects.length === 1, "the deleted project to leave the list");
      await until(() => /actions: the project .*deleted while the app was closed is gone/.test(second.log()), "the app's note of it in its log");
      const listed = (await act(second, "window.emulatorActions.projects.list()")).value;
      assert.deepEqual(listed.map((project) => [project.id, project.folder, project.exists, project.unavailable]), [["app.you.away", away, false, true]]);
      const refused = (await act(second, `window.emulatorActions.projects.refresh(${folderArg(away)})`)).value;
      assert.deepEqual([refused.ok, refused.code], [false, "folder_unavailable"]);
    } finally {
      await second.close();
    }
  } finally {
    await removeFolder(data);
  }
});

test("a project that was only opened is not the app on the bar: deleting its folder leaves an app of the same id from an archive alone", { skip }, async () => {
  // The security pass on pull request 64: an app installed from an archive, a folder with the same id opened and
  // trusted, the folder deleted.
  const fourth = await launch({ server: "real", env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust" } });
  try {
    await fourth.waitWindow("device");
    const bytes = readFileSync(new URL("../../../../test/archives/macos-clean.tgz", import.meta.url)).toString("base64");
    const [id] = await fourth.page(`(async () => {
      const body = Uint8Array.from(atob(${JSON.stringify(bytes)}), (c) => c.charCodeAt(0));
      const staged = await (await fetch("/api/apps/stage", { method: "POST", body })).json();
      await fetch("/api/apps/install?install_key=" + encodeURIComponent(staged.install_key), { method: "POST" });
      return (await (await fetch("/api/apps/list")).json()).apps.map((one) => one.id);
    })()`);
    assert.equal(typeof id, "string", "the archive's app is on the bar");
    const onTheBar = () => fourth.page(`fetch("/api/apps/list").then((r) => r.json()).then((list) => list.apps.map((one) => one.id))`);

    const clone = strangerProject(id);
    const opened = (await open(fourth, clone)).value;
    assert.deepEqual([opened.folder, opened.id, opened.installed], [clone, id, true]);
    assert.equal((await act(fourth, `window.emulatorActions.projects.build(${folderArg(clone)})`)).value.ok, true);
    rmSync(clone, { recursive: true, force: true });
    // The project leaves the list by itself, as any whose folder is gone; the app it never installed stays.
    await until(async () => (await bare(fourth, "window.emulatorActions.projects.list()")).value.length === 0, "the project to leave the list", 20_000, 300);
    assert.deepEqual(await onTheBar(), [id]);
    assert.match(fourth.log(), /actions: the project .* is gone\n/);
    assert.doesNotMatch(fourth.log(), /was removed from the BUSY Bar/);
  } finally {
    await fourth.close();
  }
});
