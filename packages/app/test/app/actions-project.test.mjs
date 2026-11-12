// The window's actions on a real app project, the whole way (EMU-260, EMU-261, EMU-262): the person chooses a folder
// in the system's dialog (here: the tests' stand-in) and the project is created right there; the list shows it with
// its folder; Refresh builds, installs and starts what is in the folder now; a broken edit fails with the build's
// error and leaves the version on the bar running; the catalog's checks answer; and when the folder is deleted, the
// project leaves the list and its app the bar. With the real server and the real tools: it needs the npm registry
// (the template's generator and the project's dependencies), like emulator/test/examples.test.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { HAS_REAL_SERVER, removeFolder, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";

let app;
let work;
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

/** One of the window's actions, asked for as the person does: a key in the window, then the page's call. */
const act = async (code) => {
  await app.press();
  return app.page(`(${code}).then((value) => ({ value }), (e) => ({ error: { code: e.code, message: e.message, hint: e.hint } }))`);
};
const q = (text) => JSON.stringify(text);
const chooses = (folder) => app.run((shell, _electron, answer) => shell.folderDialogs.standIn(answer), folder);
const bar = (pathname) => app.page(`fetch(${q(pathname)}).then((r) => r.text())`);
const front = () => bar("/api/screen?display=0");
const onTheBar = async () => JSON.parse(await bar("/api/apps/list")).apps.map((one) => one.id);
const running = async () => JSON.parse(await bar("/_emu/state")).running?.id ?? null;

/** The app's script: it writes one word on the front display and stays. */
const bring = (what, from) => `import ${what} from ${JSON.stringify(from)};`;
const script = (word) => `${bring("{ device }", "@shared/device")}
${bring("manifest", "./appmeta/manifest.json")}

const WORD = ${JSON.stringify(word)};
// A listener keeps the app running.
listen("input", () => {});
void device.DisplayDraw({ application_name: manifest.id, priority: 50, elements: [{ id: "word", type: "text", text: WORD, font: "bold", color: "#FFFFFFFF", x: 36, y: 0, align: "top_mid" }] } as never);
`;

test("create where the person chose, list, refresh after an edit, a broken edit, the checks, and the folder deleted", { skip, timeout: 900_000 }, async () => {
  work = temporaryFolder();
  app = await launch({ server: "real", network: "open" });
  await app.waitWindow("device");
  await app.page("window.jobsSeen = []; window.emulatorActions.on('job', (job) => window.jobsSeen.push(job)); true");

  const examples = (await act("window.emulatorActions.projects.examples()")).value;
  assert.deepEqual(examples.map((example) => example.name), ["focus-timer", "meeting-cost", "status-board"]);
  for (const example of examples) assert.ok(example.summary.length > 20 && example.title.length > 0, example.name);

  // ---- Create App: the person makes a folder in the dialog, somewhere of their own; the project is created in it.
  const chosen = path.join(work, "my repositories", "focus app");
  mkdirSync(chosen, { recursive: true });
  await chooses(chosen);
  const created = await act(`window.emulatorActions.projects.create({ example: "focus-timer" })`);
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const dir = realpathSync(chosen);
  const project = created.value;
  assert.deepEqual({ ...project, id: typeof project.id, name: typeof project.name }, { id: "string", name: "string", folder: dir, exists: true, unavailable: false, trusted: true, built: false, installed: false, running: false, dependencies: { state: "installed", reason: null, message: null, retry: false }, shownFolder: dir, stale: false, job: null });
  const id = project.id;
  assert.deepEqual((await act("window.emulatorActions.projects.list()")).value.map((one) => [one.id, one.folder]), [[id, dir]], "the list shows the app with its project's folder");
  // The folder is the project and nothing else: what create writes, and nothing of the emulator's own beside it.
  const top = readdirSync(dir).sort();
  for (const name of ["package.json", "src", "shared", "README.md", ".gitignore", "node_modules"]) assert.ok(top.includes(name), `${name} in ${top}`);
  assert.deepEqual(top.filter((name) => /^\.busy|emulator|registry|trusted/i.test(name)), []);
  assert.match(readFileSync(path.join(dir, ".gitignore"), "utf8"), /node_modules/);
  const jobs = async (kind) => (await app.page("window.jobsSeen")).filter((job) => job.kind === kind && job.folder === dir);
  assert.deepEqual([(await jobs("create")).at(0).state, (await jobs("create")).at(-1).state], ["running", "done"]);
  assert.ok((await jobs("create")).some((job) => /Installing the dependencies/.test(job.line ?? "")), "create's progress came as lines");

  // ---- Refresh: what is in the folder now is built, installed and started.
  const blank = await front();
  writeFileSync(path.join(dir, "src", "main.ts"), script("AAA"));
  const first = (await act(`window.emulatorActions.projects.refresh(${q(dir)})`)).value;
  assert.deepEqual(first, { ok: true, message: `${id} is running.` });
  assert.deepEqual([await onTheBar(), await running()], [[id], id]);
  const frameA = await until(async () => {
    const now = await front();
    return now !== blank && now;
  }, "the app's first frame");
  const listed = (await act("window.emulatorActions.projects.list()")).value[0];
  assert.deepEqual([listed.built, listed.installed, listed.running], [true, true, true]);
  assert.deepEqual((await jobs("refresh")).map((job) => job.line).filter(Boolean).slice(0, 3), ["Building", "Installed", "Started"]);

  // The person edits a file and presses Refresh: the bar shows the new state.
  writeFileSync(path.join(dir, "src", "main.ts"), script("ZZZ"));
  assert.equal((await act(`window.emulatorActions.projects.refresh(${q(dir)})`)).value.ok, true);
  const frameZ = await until(async () => {
    const now = await front();
    return now !== frameA && now !== blank && now;
  }, "the frame of the edited app");
  assert.equal(await running(), id);

  // ---- A broken edit: Refresh fails with the build's error, and the version on the bar goes on running.
  writeFileSync(path.join(dir, "src", "main.ts"), `${script("BROKEN")}\nconst = ;\n`);
  const broken = (await act(`window.emulatorActions.projects.refresh(${q(dir)})`)).value;
  assert.deepEqual([broken.ok, broken.code], [false, "tool_failed"]);
  assert.match(broken.message, /busy-cli build failed/);
  assert.match(broken.message, /main\.ts/);
  assert.deepEqual((await jobs("refresh")).at(-1).state, "failed");
  assert.deepEqual([await running(), await front()], [id, frameZ], "the previous version still runs and still shows its frame");

  // ---- Prepare PR: the checks answer, each with one of the three answers; a project that is no git repository
  // with a remote fails some, and nothing is written.
  // The edit is put right and Refresh works again.
  writeFileSync(path.join(dir, "src", "main.ts"), script("ZZZ"));
  assert.equal((await act(`window.emulatorActions.projects.refresh(${q(dir)})`)).value.ok, true);
  const check = (await act(`window.emulatorActions.projects.check(${q(dir)})`)).value;
  assert.equal(check.built, true);
  assert.ok(check.checks.length > 20);
  for (const one of check.checks) {
    assert.ok(["passes", "fails", "unchecked"].includes(one.answer), one.id);
    assert.equal(typeof one.title, "string");
    assert.equal(typeof one.message, "string");
    if (one.answer !== "passes") assert.ok(one.message.length > 0, `${one.id} says what to do`);
  }
  assert.equal(check.ok, !check.checks.some((one) => one.answer === "fails" && one.blocking));
  const submit = (await act(`window.emulatorActions.projects.submit(${q(dir)})`)).value;
  if (check.ok) assert.equal(submit.folder, path.join(dir, "submission"));
  else {
    assert.deepEqual([submit.ok, submit.code], [false, "check_failed"]);
    assert.equal(existsSync(path.join(dir, "submission")), false, "nothing is written while a check fails");
  }

  // ---- The app in the emulator is its project folder: the folder is deleted, and the app goes.
  rmSync(dir, { recursive: true, force: true });
  // Nobody presses anything: the look at the folders every few seconds finds it.
  await until(async () => !(await onTheBar()).includes(id), "the app to leave the bar by itself", 30_000, 500);
  assert.equal(await running(), null);
  assert.deepEqual((await act("window.emulatorActions.projects.list()")).value, []);
  const removed = (await app.page("window.jobsSeen")).filter((job) => job.kind === "removed");
  assert.deepEqual(removed.map((job) => [job.folder, job.state]), [[dir, "done"]], "the window was told once");
  assert.match(app.log(), new RegExp(`the project .* is gone; ${id.replace(/\./g, "\\.")} was removed from the BUSY Bar`));
  assert.equal(existsSync(path.join(work, "my repositories")), true, "nothing else on the disk was touched");
});
