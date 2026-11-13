// The window's actions (actions.mjs) on plain Node, with a stand-in for the command line: what is run for each
// action and what is never run, the folder the page names, one job for a project, the list that looks after itself,
// and the end of every job with the app. The same rules in the running app: test/app/actions.test.mjs.
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { createActions, createRequest, GENERIC_AUTHORS, genericAuthor, NAME_CHECK_KEEP_MS, NAME_CHECKS_A_MINUTE, NAME_CHECKS_AN_HOUR, gitAuthor, iconPicture, MAX_COPY, maybeLaunched, namespaceOf, newAppAuthor, NO_GESTURE_NEEDED, showPath, shownCliPath, WINDOW_ACTIONS } from "../../src/actions.mjs";
import { createSettings } from "../../src/update-check.mjs";
import { cliEnvironment } from "../../src/cli-process.mjs";
import { removeFolder, sleep, temporaryFolder } from "../helpers.mjs";

const root = realpathSync(temporaryFolder());
after(() => removeFolder(root));
const DATA = path.join(root, "data");
const CLOCK = path.join(root, "clock");
const AWAY = path.join(root, "on the unplugged disk");
for (const dir of [DATA, CLOCK, path.join(CLOCK, "submission"), path.join(root, "not a project")]) mkdirSync(dir, { recursive: true });

const entry = (folder, more = {}) => ({ id: "app.you.clock", name: "Clock", folder, exists: true, unavailable: false, trusted: true, built: true, installed: true, running: false, ...more });

/**
 * A stand-in for the command line: `answers(words)` gives the one line of JSON for a call (or a function of the run,
 * for a call that goes on); every call is kept.
 */
function setup({ projects = [entry(CLOCK)], answers = () => ({ ok: true }), choose = {}, folderThere, platform = "darwin", newProjects = null, github = null, now = undefined, author = () => "Jane Doe" } = {}) {
  const calls = [];
  const runs = [];
  const sent = [];
  const shown = [];
  const copied = [];
  const opened = [];
  const state = { projects, removed: [] };
  const startCli = (args, onLine = () => {}) => {
    calls.push(args.join(" "));
    let end;
    const exited = new Promise((resolve) => (end = resolve));
    const run = { pid: 1000 + runs.length, args, exited, interrupted: false, killed: false, onLine, end: (code = 0, lines = []) => end({ code, signal: null, error: null, lines }), interrupt: () => ((run.interrupted = true), run.end(0)), killNow: () => ((run.killed = true), end({ code: null, signal: "SIGKILL", error: null, lines: [] })) };
    runs.push(run);
    const words = args.filter((word) => word !== "--json" && word !== "--progress");
    if (words[0] === "projects" && words[1] === "--prune") {
      const removed = state.removed.splice(0);
      run.end(0, [JSON.stringify({ ok: true, removed, bar: state.bar ?? "ready", projects: state.projects })]);
    } else {
      const answer = answers(words, run);
      if (answer !== undefined) run.end(answer.ok ? 0 : 1, [JSON.stringify(answer)]);
    }
    return run;
  };
  const actions = createActions({
    startCli,
    dialogs: { chooseNew: async () => choose.create ?? null, chooseExisting: async () => choose.open ?? null, chooseAny: async (pick) => (picks.push(pick), choose.any ?? null), chooseParent: async (from) => (opensAt.push(from), choose.parent ?? null), chooseScreenshots: async (display) => (shotsFor.push(display), choose.screenshots ?? null), chooseLicense: async () => choose.license ?? null },
    show: (folder) => shown.push(folder),
    copy: (text) => copied.push(text),
    open: (file) => opened.push(file),
    send: (job) => sent.push(job),
    dataDir: DATA,
    logFile: "/data/logs/shell.log",
    log: () => {},
    ...(folderThere ? { folderThere } : {}),
    platform,
    newProjects,
    home: root,
    author,
    ...(github ? { github } : {}),
    ...(now ? { now } : {}),
  });
  const call = async (name, arg) => {
    const answer = await actions.call(name, arg);
    return answer.ok ? answer.value : { rejected: answer.error };
  };
  /** The calls that are not the list's own reading. */
  const work = () => calls.filter((line) => !line.startsWith("projects --prune"));
  return { actions, call, calls, work, runs, sent, shown, copied, opened, state };
}

/** Where Create app's Location dialog was asked to open, every time. */
const opensAt = [];
/** What Open existing's dialog was asked to take, every time. */
const picks = [];
/** Which display the screenshots' dialog was asked for, every time (null: either). */
const shotsFor = [];

const PROJECT_ACTIONS = ["projects.refresh", "projects.build", "projects.run", "projects.stop", "projects.dev.start", "projects.check", "projects.submit"];

test("each action runs the command line's own command on the project's folder, with --json, and never --trust", async () => {
  const { call, work, runs } = setup({
    answers: (words, run) => (words[0] === "dev" && !words.includes("--once") ? void setTimeout(() => run.end(0), 0) : { ok: true, id: "app.you.clock", running: true, checks: [], built: true, submission: { folder: path.join(CLOCK, "submission") } }),
  });
  for (const name of PROJECT_ACTIONS) {
    assert.equal((await call(name, CLOCK)).ok, true, name);
    // The loop of this stand-in ends by itself at once; the project is free for the next action then.
    await sleep(5);
  }
  assert.deepEqual(work(), [
    `dev ${CLOCK} --once --json --progress`,
    `build ${CLOCK} --json --progress`,
    `run ${CLOCK} --json --progress`,
    `stop ${CLOCK} --json --progress`,
    `dev ${CLOCK}`,
    `check ${CLOCK} --full --json --progress`,
    `submit ${CLOCK} --json --progress`,
  ]);
  for (const run of runs) assert.equal(run.args.some((word) => /^--trust/.test(word)), false, run.args.join(" "));
  assert.deepEqual(await call("projects.examples"), { rejected: { code: "failed", message: "The example apps could not be read.", hint: null } });
});

test("a folder the page names is looked up in the list and nothing else: unknown, gone, unavailable and untrusted ones are refused before anything runs", async () => {
  const cases = [
    [[entry(CLOCK)], path.join(root, "not a project"), "unknown_project"],
    [[entry(CLOCK)], `${CLOCK}/`, "unknown_project"],
    [[entry(CLOCK)], `${CLOCK}${path.sep}..${path.sep}clock`, "unknown_project"],
    [[entry(CLOCK)], "--trust", "unknown_project"],
    [[entry(CLOCK)], "", "unknown_project"],
    [[entry(CLOCK)], null, "unknown_project"],
    [[entry(CLOCK)], { folder: CLOCK }, "unknown_project"],
    [[entry(CLOCK)], [CLOCK], "unknown_project"],
    [[entry(CLOCK)], "x".repeat(5000), "unknown_project"],
    [[entry(CLOCK, { exists: false })], CLOCK, "folder_missing"],
    [[entry(AWAY, { exists: false, unavailable: true })], AWAY, "folder_unavailable"],
    [[entry(CLOCK, { trusted: false })], CLOCK, "untrusted_project"],
  ];
  for (const [projects, folder, code] of cases) {
    const { call, work, sent } = setup({ projects });
    for (const name of PROJECT_ACTIONS) {
      const answer = await call(name, folder);
      assert.deepEqual([answer.ok, answer.code], [false, code], `${name} ${String(folder).slice(0, 40)}`);
      assert.equal(typeof answer.message, "string");
    }
    assert.deepEqual(work(), [], code);
    assert.deepEqual(sent, [], code);
  }
  // check keeps its shape when it is refused.
  assert.deepEqual((await setup().call("projects.check", "/nowhere")).checks, []);
});

test("one job for a project at a time: a second one is refused, another project is free, and the project is free again when the job ends", async () => {
  const OTHER = path.join(root, "not a project");
  let building;
  const { call, work, sent, actions } = setup({
    projects: [entry(CLOCK), entry(OTHER, { id: "app.you.other" })],
    answers: (words, run) => (words[0] === "build" && words[1] === CLOCK ? void (building = run) : { ok: true, id: "app.you.other" }),
  });
  const first = call("projects.build", CLOCK);
  await sleep(5);
  assert.deepEqual(actions.jobs(), { [CLOCK]: "build" });
  assert.equal((await call("projects.list")).find((project) => project.folder === CLOCK).job, "build");
  for (const name of PROJECT_ACTIONS) assert.deepEqual([(await call(name, CLOCK)).code], ["busy"], name);
  assert.equal((await call("projects.build", OTHER)).ok, true);
  // The job's lines of progress reach the window; the answer's line does not.
  building.onLine("busy-cli build", "err");
  building.onLine('{"not":"for the window"}', "out");
  building.end(0, [JSON.stringify({ ok: true, id: "app.you.clock" })]);
  assert.deepEqual(await first, { ok: true, message: "Built app.you.clock." });
  assert.deepEqual(sent.filter((job) => job.folder === CLOCK).map(({ id: _id, ...job }) => job), [
    { kind: "build", folder: CLOCK, state: "running" },
    { kind: "build", folder: CLOCK, state: "running", line: "busy-cli build" },
    { kind: "build", folder: CLOCK, state: "done" },
  ]);
  assert.deepEqual(actions.jobs(), {});
  assert.equal((await call("projects.stop", CLOCK)).ok, true);
  assert.deepEqual(work().filter((line) => line.includes(CLOCK)), [`build ${CLOCK} --json --progress`, `stop ${CLOCK} --json --progress`]);
});

test("a failure of the command line comes back in its words; one that printed no answer is told as such", async () => {
  const { call, sent } = setup({ answers: (words) => (words[0] === "build" ? { ok: false, code: "tool_failed", message: "busy-cli build failed with exit code 1:\nsrc/main.ts:3:6: ERROR: Unexpected \";\"", hint: "Fix what busy-cli says." } : { ok: false, code: "check_failed", message: "2 checks fail.", hint: "Change them.", built: true, checks: [{ id: "A1", title: "License", status: "fail", blocking: true, found: "no LICENSE", change: "add one", catalog: { problem: "A license is required." }, applies: true }, { id: "A2", title: "Stars", status: "fail", blocking: false, found: null, change: null, applies: true }, { id: "B1", title: "Review", status: "unchecked", why: "people do it", change: null, applies: true }, { id: "C1", title: "Removal", status: "unchecked", why: "n/a", applies: false }, { id: "D1", title: "Icon", status: "pass", found: null, applies: true }] }) });
  assert.deepEqual(await call("projects.build", CLOCK), { ok: false, code: "tool_failed", message: "busy-cli build failed with exit code 1:\nsrc/main.ts:3:6: ERROR: Unexpected \";\"", hint: "Fix what busy-cli says." });
  assert.deepEqual(sent.at(-1).state, "failed");
  assert.match(sent.at(-1).line, /busy-cli build failed/);
  const check = await call("projects.check", CLOCK);
  assert.deepEqual([check.ok, check.code, check.built], [false, "check_failed", true]);
  assert.deepEqual(check.checks, [
    { id: "A1", title: "License", answer: "fails", message: "A license is required.\nHere: no LICENSE\nChange: add one", blocking: true },
    { id: "A2", title: "Stars", answer: "fails", message: "", blocking: false },
    { id: "B1", title: "Review", answer: "unchecked", message: "people do it", blocking: true },
    { id: "D1", title: "Icon", answer: "passes", message: "", blocking: true },
  ]);

  const silent = setup({ answers: (_words, run) => void run.end(7, ["not json", ""]) });
  const answer = await silent.call("projects.run", CLOCK);
  assert.deepEqual([answer.ok, answer.code], [false, "no_answer"]);
  assert.match(answer.message, /exit code 7/);
  assert.match(answer.hint, /shell\.log/);
});

test("Refresh is one round of dev --once: its events become lines, a failed build is the answer and the BUSY Bar is left alone", async () => {
  let round;
  const { call, sent, work } = setup({ answers: (_words, run) => void (round = run) });
  const refreshing = call("projects.refresh", CLOCK);
  await sleep(5);
  for (const event of [{ event: "build_started", changed: [] }, { event: "installed" }, { event: "running" }, { event: "app_log", level: "log", text: "hello" }]) round.onLine(JSON.stringify(event), "out");
  round.onLine("Installing the project's dependencies…", "err");
  round.end(0, [JSON.stringify({ ok: true, id: "app.you.clock", running: true })]);
  assert.deepEqual(await refreshing, { ok: true, message: "app.you.clock is running." });
  assert.deepEqual(sent.map((job) => job.line).filter(Boolean), ["Building", "Installed", "Started", "Installing the project's dependencies…"]);
  assert.deepEqual(work(), [`dev ${CLOCK} --once --json --progress`]);

  const broken = setup({ answers: (_words, run) => (run.onLine(JSON.stringify({ event: "build_failed", tool: "busy-cli build", output: "main.ts: ERROR" }), "out"), { ok: false, code: "tool_failed", message: "busy-cli build failed with exit code 1:\nmain.ts: ERROR", hint: "Fix it." }) });
  assert.deepEqual(await broken.call("projects.refresh", CLOCK), { ok: false, code: "tool_failed", message: "busy-cli build failed with exit code 1:\nmain.ts: ERROR", hint: "Fix it." });
  // The failure reaches the window's log once: the build's event says it with the output; the end says no more.
  assert.deepEqual(broken.sent.map((job) => [job.state, job.line ?? null]), [["running", null], ["running", "busy-cli build failed\nmain.ts: ERROR"], ["failed", null]]);
  assert.deepEqual(broken.work(), [`dev ${CLOCK} --once --json --progress`], "nothing else was run: no stop, no install");
});

test("create: the folder is the person's choice in the dialog, the example a plain name; nothing runs when they chose none", async () => {
  const none = setup();
  assert.equal(await none.call("projects.create", { example: "focus-timer", folder: CLOCK }), null);
  assert.equal(await none.call("projects.open", CLOCK), null);
  assert.deepEqual(none.work(), []);
  for (const example of ["--trust", "../x", "a b", "", 7, {}, "x".repeat(80)]) {
    assert.equal((await none.call("projects.create", { example })).rejected.code, "usage", String(example));
  }
  assert.deepEqual(none.calls, []);

  const NEW = path.join(root, "not a project");
  const made = setup({ choose: { create: NEW }, projects: [entry(NEW, { id: "app.you.new" })], answers: () => ({ ok: true, folder: NEW, id: "app.you.new" }) });
  assert.equal((await made.call("projects.create", { example: "focus-timer", folder: "/etc" })).folder, NEW);
  assert.equal((await made.call("projects.create")).folder, NEW);
  assert.deepEqual(made.work(), [`create ${NEW} --example=focus-timer --author=Jane Doe --json --progress`, `create ${NEW} --author=Jane Doe --json --progress`]);

  const failed = setup({ choose: { create: NEW }, answers: () => ({ ok: false, code: "folder_not_empty", message: "It is not empty.", hint: "Choose an empty folder." }) });
  assert.deepEqual(await failed.call("projects.create", {}), { rejected: { code: "folder_not_empty", message: "It is not empty.", hint: "Choose an empty folder." } });
  assert.equal(failed.sent.at(-1).state, "failed");
});

test("open: the folder is the person's choice; the command line asks for trust and only then the project is added; a no is no project", async () => {
  const opened = setup({ choose: { open: CLOCK }, answers: (words) => (words[0] === "trust" ? { ok: true, trusted: "now" } : { ok: true, added: CLOCK }) });
  assert.equal((await opened.call("projects.open", "/etc")).folder, CLOCK);
  assert.deepEqual(opened.work(), [`trust ${CLOCK} --wait 600 --json`, `projects --add ${CLOCK} --json`]);
  assert.deepEqual(opened.sent.map((job) => [job.kind, job.state]), [["open", "running"], ["open", "done"]]);

  // While the person's choice is being opened, the app knows that it is theirs (the trust dialog says so); not
  // before, not after, and not for another folder.
  const seen = [];
  const asking = setup({ choose: { open: CLOCK }, answers: (words) => (seen.push([asking.actions.isOpening(CLOCK), asking.actions.isOpening(DATA)]), words[0] === "trust" ? { ok: true } : { ok: true, added: CLOCK }) });
  assert.equal(asking.actions.isOpening(CLOCK), false);
  await asking.call("projects.open");
  assert.deepEqual([seen, asking.actions.isOpening(CLOCK)], [[[true, false], [true, false]], false]);
  // A project that left without an app of its own on the bar is told as that.
  const quiet = setup({ projects: [] });
  quiet.state.removed = [{ id: "app.you.clock", folder: CLOCK, uninstalled: false }];
  await quiet.call("projects.list");
  assert.deepEqual(quiet.sent.map((job) => [job.kind, job.line]), [["removed", "The project left the list: its folder is gone."]]);
  assert.deepEqual(NO_GESTURE_NEEDED, ["projects.list", "projects.examples", "projects.place", "projects.dependencies.auto", "welcome.get", "publish.status", "publish.check", "github.status", "github.signin.wait", "github.signin.cancel", "github.name", "github.cancel", "github.checklist", "github.entry", "github.lookup"]);

  const refused = setup({ choose: { open: CLOCK }, answers: () => ({ ok: false, code: "trust_refused", message: "The person chose Don't Trust." }) });
  assert.equal(await refused.call("projects.open"), null);
  assert.deepEqual(refused.work(), [`trust ${CLOCK} --wait 600 --json`], "nothing was added");
  assert.deepEqual(refused.actions.jobs(), {});

  const stranger = setup({ choose: { open: CLOCK }, answers: () => ({ ok: false, code: "not_a_project", message: "It is not an app project.", hint: "Choose another." }) });
  assert.deepEqual(await stranger.call("projects.open"), { rejected: { code: "not_a_project", message: "It is not an app project.", hint: "Choose another." } });
  assert.deepEqual(stranger.work(), [`trust ${CLOCK} --wait 600 --json`]);
  assert.deepEqual(stranger.actions.jobs(), {});
});

test("Open existing: the person's choice, a file deep in a project, finds the project; only a folder it found is opened, through the trust dialog, then started", async () => {
  const project = path.join(root, "found", "clock");
  mkdirSync(path.join(project, "src", "scripts"), { recursive: true });
  mkdirSync(path.join(project, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ devDependencies: { "@busy-app/cli": "0.6.0" } }));
  writeFileSync(path.join(project, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.you.found", name: "Found" }));
  writeFileSync(path.join(project, "src", "scripts", "main.js"), "");
  const file = path.join(project, "src", "scripts", "main.js");
  // The real folders of this system: its own path rules, and its way of showing a path (from ~ but on Windows).
  const platform = process.platform;
  const shown = (full) => (platform === "win32" ? full : `~${full.slice(root.length)}`);
  const listed = { ...entry(project, { id: "app.you.found", name: "Found" }) };
  const it = setup({ platform, projects: [], choose: { any: file }, answers: (words) => (words[0] === "trust" ? { ok: true } : words[0] === "projects" ? (it.state.projects.push(listed), { ok: true, added: project }) : words[0] === "dev" ? { ok: true, id: "app.you.found", running: true } : { ok: true }) });
  picks.length = 0;
  // Nothing found yet: nothing may be opened, whatever the page names.
  for (const folder of [project, "/etc", null]) assert.equal((await it.call("projects.import", folder)).rejected.code, "usage", String(folder));
  const answer = await it.call("projects.find", { pick: "file" });
  assert.deepEqual(picks, ["file"]);
  assert.deepEqual(answer, { found: true, folder: project, shownFolder: shown(project), id: "app.you.found", name: "Found", listed: false, trusted: false, chosen: file, shownChosen: shown(file) });
  assert.deepEqual(it.work(), [], "finding runs nothing");
  const opened = await it.call("projects.import", project);
  assert.deepEqual(it.work(), [`trust ${project} --wait 600 --json`, `projects --add ${project} --json`, `dev ${project} --once --json --progress`]);
  assert.deepEqual([opened.folder, opened.id, opened.refreshed], [project, "app.you.found", { ok: true, message: "app.you.found is running." }]);
  assert.deepEqual(it.sent.map((job) => [job.kind, job.state]), [["open", "running"], ["open", "done"], ["refresh", "running"], ["refresh", "done"]]);
  // A pick the page makes up is the default one.
  await it.call("projects.find", { pick: "--anything" });
  assert.equal(picks.at(-1), "any");

  // Don't Trust: nothing added, nothing started.
  const no = setup({ platform, projects: [], choose: { any: project }, answers: (words) => (words[0] === "trust" ? { ok: false, code: "trust_refused", message: "The person chose Don't Trust." } : { ok: true }) });
  assert.equal((await no.call("projects.find")).found, true);
  assert.equal(await no.call("projects.import", project), null);
  assert.deepEqual(no.work(), [`trust ${project} --wait 600 --json`]);

  // A folder of no project: said, and nothing may be opened.
  const pictures = path.join(root, "found", "pictures");
  mkdirSync(pictures, { recursive: true });
  const none = setup({ platform, choose: { any: pictures } });
  assert.deepEqual(await none.call("projects.find"), { found: false, message: "No BUSY app found in this folder or above it.", chosen: pictures, shownChosen: shown(pictures) });
  assert.equal((await none.call("projects.import", pictures)).rejected.code, "usage");
  assert.deepEqual(none.work(), []);
  // The dialog closed: null.
  assert.equal(await setup().call("projects.find"), null);
});

test("the development loop goes on until it is stopped; the window's end stops the loops, the app's end every job", async () => {
  const OTHER = path.join(root, "not a project");
  const { call, runs, sent, actions } = setup({ projects: [entry(CLOCK), entry(OTHER)], answers: (words) => (words[0] === "dev" || words[0] === "build" ? undefined : { ok: true }) });
  assert.deepEqual(await call("projects.dev.start", CLOCK), { ok: true });
  const loop = runs.find((run) => run.args[0] === "dev");
  loop.onLine("12:00:00  ready    the app was started on the BUSY Bar", "out");
  loop.onLine("", "out");
  assert.deepEqual(sent.map((job) => [job.kind, job.state, job.line ?? null]), [["dev", "running", null], ["dev", "running", "12:00:00  ready    the app was started on the BUSY Bar"]]);
  assert.equal((await call("projects.dev.stop", OTHER)).code, "not_running");
  assert.equal((await call("projects.dev.stop", null)).code, "not_running");
  assert.deepEqual(await call("projects.dev.stop", CLOCK), { ok: true });
  assert.equal(loop.interrupted, true);
  await sleep(0);
  assert.deepEqual([actions.jobs(), sent.at(-1).state], [{}, "done"]);

  // The window closes: the loop ends, a build goes on.
  await call("projects.dev.start", CLOCK);
  const building = call("projects.build", OTHER);
  await sleep(5);
  const [second, build] = [runs.filter((run) => run.args[0] === "dev").at(-1), runs.find((run) => run.args[0] === "build")];
  actions.stopLoops();
  await sleep(0);
  assert.deepEqual([second.interrupted, build.interrupted, build.killed, actions.jobs()], [true, false, false, { [OTHER]: "build" }]);
  // The app quits: every run of the command line ends now.
  await call("projects.dev.start", CLOCK);
  const third = runs.filter((run) => run.args[0] === "dev").at(-1);
  assert.deepEqual(actions.pids().sort(), [build.pid, third.pid].sort());
  actions.endAll();
  assert.deepEqual([third.killed, build.killed], [true, true]);
  assert.equal((await building).ok, false);
  await sleep(0);
  assert.deepEqual([actions.jobs(), actions.pids()], [{}, []]);
});

test("the list looks after itself: a project that left is told once, a disk that went or came back is told, and a look that finds nothing new runs nothing", async () => {
  const there = new Set([CLOCK, AWAY]);
  const { actions, call, calls, sent, state } = setup({ projects: [entry(CLOCK), entry(AWAY, { id: "app.you.away" })], folderThere: (folder) => there.has(folder) });
  assert.equal((await call("projects.list")).length, 2);
  assert.equal(actions.look(), null, "every folder is as it was");
  assert.equal(calls.length, 1);

  // The disk is unplugged: the folder is gone, the list says unavailable.
  there.delete(AWAY);
  state.projects = [entry(CLOCK), entry(AWAY, { id: "app.you.away", exists: false, unavailable: true })];
  await actions.look();
  assert.deepEqual(sent.map(({ id: _id, ...job }) => job), [{ kind: "changed", folder: AWAY, state: "done", line: "The folder is unavailable: its disk is not there." }]);
  assert.equal(actions.look(), null, "it is known to be away: nothing to read again");
  assert.equal((await call("projects.refresh", AWAY)).code, "folder_unavailable");

  // It is back.
  there.add(AWAY);
  state.projects = [entry(CLOCK), entry(AWAY, { id: "app.you.away" })];
  await actions.look();
  assert.deepEqual([sent.at(-1).kind, sent.at(-1).line], ["changed", "The folder is back."]);

  // A folder is deleted: the command line lets the project go, and the window hears of it once.
  there.delete(CLOCK);
  state.projects = [entry(AWAY, { id: "app.you.away" })];
  state.removed = [{ id: "app.you.clock", folder: CLOCK, uninstalled: true }];
  await actions.look();
  assert.deepEqual([sent.at(-1).kind, sent.at(-1).folder, sent.at(-1).line], ["removed", CLOCK, "app.you.clock left the BUSY Bar: its project folder is gone."]);
  assert.equal(sent.filter((job) => job.kind === "removed").length, 1);
  assert.equal(actions.look(), null);
  assert.deepEqual((await call("projects.list")).map((project) => project.folder), [AWAY]);
  assert.ok(calls.every((line) => line === "projects --prune --json" || line.startsWith("dev ")), "the list is read with --prune, by the command line alone");
});

test("a deleted project the BUSY Bar could not be asked about is owed: the look reads the list again until the BUSY Bar answers", async () => {
  const gone = entry(CLOCK, { exists: false, installed: false });
  const { actions, call, calls, sent, state } = setup({ projects: [gone], folderThere: () => false });
  state.bar = "not_running";
  assert.deepEqual((await call("projects.list")).map((project) => [project.folder, project.exists, project.unavailable]), [[CLOCK, false, false]]);
  // Nothing about the folder changed, and still the list is read again: the project waits for the bar.
  await actions.look();
  await actions.look();
  assert.equal(calls.length, 3);
  // The bar answers: the command line lets the project go, and there is nothing owed any more.
  state.bar = "ready";
  state.projects = [];
  state.removed = [{ id: "app.you.clock", folder: CLOCK, uninstalled: true }];
  await actions.look();
  assert.deepEqual(sent.map((job) => [job.kind, job.folder]), [["removed", CLOCK]]);
  assert.equal(actions.look(), null);
  // An unavailable project is owed nothing: it waits for its disk, not for the bar.
  const away = setup({ projects: [entry(AWAY, { exists: false, unavailable: true })], folderThere: () => false });
  away.state.bar = "not_running";
  await away.call("projects.list");
  assert.equal(away.actions.look(), null);
});

test("showing a folder: a project of the list, what is inside one, the data folder; copying: a text", async () => {
  const { call, shown, copied } = setup();
  assert.equal(await call("reveal", CLOCK), true);
  assert.equal(await call("reveal", path.join(CLOCK, "submission")), true);
  assert.equal(await call("reveal", DATA), true);
  for (const target of [root, path.join(root, "not a project"), path.join(CLOCK, "..", "not a project"), path.join(CLOCK, "no such folder"), `${CLOCK}x`, "clock", "", null, { path: CLOCK }, path.parse(root).root]) {
    assert.equal(await call("reveal", target), false, String(target));
  }
  assert.deepEqual(shown, [CLOCK, path.join(CLOCK, "submission"), DATA]);
  assert.equal(await call("copy", CLOCK), true);
  for (const text of [null, 7, { text: "x" }, "x".repeat(MAX_COPY + 1)]) assert.equal(await call("copy", text), false);
  assert.equal(MAX_COPY, 64 * 1024);
  assert.equal(await call("copy", "x".repeat(MAX_COPY)), true);
  assert.deepEqual(copied.map((text) => text.length), [CLOCK.length, MAX_COPY]);
});

test("browse opens only pages of the emulated BUSY Bar's own address in the browser: never the window's, the old paths or another address", async () => {
  const browsed = [];
  const actions = createActions({ startCli: () => assert.fail("browse runs no command"), dialogs: {}, show: () => {}, copy: () => {}, browse: (address) => browsed.push(address), barOrigin: "http://127.0.0.1:8640", send: () => {}, dataDir: DATA, logFile: "/data/logs/shell.log", log: () => {} });
  const browse = async (address) => (await actions.call("browse", address)).value;
  assert.equal(await browse("http://127.0.0.1:8640/"), true);
  assert.equal(await browse("http://127.0.0.1:8640/docs/"), true);
  for (const address of ["http://127.0.0.1:8640/emulator", "http://127.0.0.1:8640/emulator/window.js", "http://127.0.0.1:8640/_emu/power?action=off", "http://127.0.0.1:8641/", "http://localhost:8640/", "https://example.com/", "http://user:pass@127.0.0.1:8640/", "file:///etc/passwd", "javascript:alert(1)", "", null, 7]) {
    assert.equal(await browse(address), false, String(address));
  }
  assert.deepEqual(browsed, ["http://127.0.0.1:8640/", "http://127.0.0.1:8640/docs/"]);
  const without = createActions({ startCli: () => {}, dialogs: {}, show: () => {}, copy: () => {}, browse: () => assert.fail("no address of a BUSY Bar: nothing opens"), send: () => {}, dataDir: DATA, logFile: "/data/logs/shell.log", log: () => {} });
  assert.equal((await without.call("browse", "http://127.0.0.1:8640/")).value, false);
});

test("a name that is no action is told so, and an action that throws tells the page nothing of why", async () => {
  const { actions } = setup();
  for (const name of ["projects.trust", "constructor", "__proto__", "toString"]) assert.equal((await actions.call(name)).error.code, "unknown_action", name);
  const broken = createActions({ startCli: () => { throw new Error("spawn EACCES /secret/path"); }, dialogs: {}, show: () => {}, copy: () => { throw new Error("the clipboard of /secret/path"); }, send: () => {}, dataDir: DATA, logFile: "/data/logs/shell.log", log: () => {} });
  assert.deepEqual(await broken.call("copy", "x"), { ok: false, error: { code: "internal", message: "The emulator's app could not do it.", hint: "The log is at /data/logs/shell.log." } });
  assert.deepEqual((await broken.call("projects.list")).error.code, "internal");
  for (const name of WINDOW_ACTIONS) assert.equal(typeof (await broken.call(name, CLOCK)).ok, "boolean", name);
});

test("a list asked for while one is being read gets the next read: the one under way may have read it before the change the page has just seen", async () => {
  const reads = []; // the runs of projects --prune, each ended by hand with the list it read
  const startCli = (args) => {
    let end;
    const exited = new Promise((resolve) => (end = resolve));
    reads.push((projects) => end({ code: 0, signal: null, error: null, lines: [JSON.stringify({ ok: true, removed: [], bar: "ready", projects })] }));
    return { pid: 2000 + reads.length, args, exited, interrupt: () => {}, killNow: () => {} };
  };
  const actions = createActions({ startCli, dialogs: {}, show: () => {}, copy: () => {}, send: () => {}, dataDir: DATA, logFile: "/data/logs/shell.log", log: () => {} });
  const ids = async (answer) => (await answer).value.map((project) => project.id);
  const first = actions.call("projects.list");
  await sleep(10);
  assert.equal(reads.length, 1);
  // The command line notes a project and installs its app; the window asks twice for the list meanwhile.
  const second = actions.call("projects.list");
  const third = actions.call("projects.list");
  await sleep(10);
  assert.equal(reads.length, 1, "one read at a time");
  reads[0]([]); // read before the project was noted
  assert.deepEqual(await ids(first), []);
  await sleep(10);
  assert.equal(reads.length, 2, "the calls that came meanwhile share one read after it");
  reads[1]([entry(CLOCK)]);
  assert.deepEqual([await ids(second), await ids(third)], [["app.you.clock"], ["app.you.clock"]]);
  // With none under way, a call reads at once.
  const fourth = actions.call("projects.list");
  await sleep(10);
  assert.equal(reads.length, 3);
  reads[2]([entry(CLOCK)]);
  assert.deepEqual(await ids(fourth), ["app.you.clock"]);
});

test("the command line's environment: the shell's, cleaned; a development run is told the shell's data folder and port, a release nothing", () => {
  const env = { PATH: "/bin", HOME: "/home/you", NODE_OPTIONS: "--require /evil.js", ELECTRON_RUN_AS_NODE: "1", BUSY_EMULATOR_TEST_HOOK: "/sock", BUSY_EMULATOR_DATA: "/elsewhere" };
  // It calls itself by name in its hints, never by the path of the Node and the script or of a launcher.
  // And it prints its text as it is, for the window, not in the console's ASCII (EMU-314).
  const named = { BUSY_EMULATOR_CLI_PATH: "busy-emulator", BUSY_EMULATOR_OUTPUT: "unicode" };
  assert.deepEqual(cliEnvironment(env, { development: false, dataDir: "/data", port: 8640 }), { PATH: "/bin", HOME: "/home/you", ...named });
  assert.deepEqual(cliEnvironment(env, { development: true, dataDir: "/data", port: 9100 }), { PATH: "/bin", HOME: "/home/you", BUSY_EMULATOR_DATA: "/data", BUSY_EMULATOR_PORT: "9100", ...named });
  // A test's home for the command line alone: in development only, and only an absolute one.
  const tested = { ...env, BUSY_EMULATOR_TEST_CLI_HOME: path.resolve("/test-home") };
  assert.deepEqual(cliEnvironment(tested, { development: true, dataDir: "/data", port: 9100 }), { PATH: "/bin", HOME: path.resolve("/test-home"), USERPROFILE: path.resolve("/test-home"), BUSY_EMULATOR_DATA: "/data", BUSY_EMULATOR_PORT: "9100", ...named });
  assert.deepEqual(cliEnvironment(tested, { development: false, dataDir: "/data", port: 8640 }), { PATH: "/bin", HOME: "/home/you", ...named });
  assert.equal(cliEnvironment({ ...env, BUSY_EMULATOR_TEST_CLI_HOME: "relative" }, { development: true, dataDir: "/data", port: 9100 }).HOME, "/home/you");
  assert.deepEqual(cliEnvironment(env, { development: false, dataDir: "/data", port: 8640, installFiles: { launcher: "/home/you/.busy-emulator/bin/busy-emulator" } }), { PATH: "/bin", HOME: "/home/you", ...named });
});

// What the command line says, as the window says it (window-texts.mjs): the answers below are the command line's
// own, as it prints them for the shell's runs (BUSY_EMULATOR_CLI_PATH=busy-emulator) and, before that, by the path of
// the Node and the script inside the app.
const NODE = "/Applications/BUSY Bar Emulator.app/Contents/Resources/node";
const SCRIPT = "/Applications/BUSY Bar Emulator.app/Contents/Resources/emulator/packages/server/cli/busy-emulator.mjs";
const BY_PATH = `'${NODE}' '${SCRIPT}'`;
const ABSOLUTE = /\/(?:Applications|Users)\/[^ ]*(?:node|busy-emulator(?:\.mjs)?)\b/;

test("Refresh, Publish and the checks tell the window what to press, not what to type, and never the path of the app's Node or command line", async () => {
  const quoted = `'${CLOCK}'`;
  const answers = {
    dev: { ok: false, code: "tool_failed", message: "busy-cli build failed with exit code 1:\nmain.ts: ERROR", hint: `Fix what busy-cli says, then run ${BY_PATH} dev ${quoted} --once again.` },
    check: {
      ok: false,
      code: "check_failed",
      message: "Made catalog.json for the catalog's texts. 2 of the catalog's checks fail for app.you.clock: manifest_schema, screenshots_count.",
      hint: `Change what the failing checks name, then run busy-emulator check ${quoted} again.`,
      built: false,
      checks: [
        { id: "manifest_schema", title: "Catalog texts", status: "fail", blocking: true, applies: true, found: "category: not written yet; changelog: not written yet", change: "Fill in category and changelog in catalog.json in the project's folder. category is one of: clocks, games." },
        { id: "screenshots_count", title: "Screenshots", status: "fail", blocking: true, applies: true, found: "there are no screenshots", change: "Run the app on the emulated BUSY Bar and take one: busy-emulator screenshot. The first one is the app's cover in the catalog." },
        { id: "archive_entry", title: "Entry point", status: "unchecked", applies: true, why: "the project is not built", change: "Run busy-emulator build first." },
        { id: "manifest_path", title: "Manifest path", status: "pass", applies: true, found: "busy-emulator submit writes applications/app.you.clock/manifest.yml" },
      ],
    },
    submit: { ok: false, code: "not_built", message: "Nothing was written to submission/: the project is not built.", hint: `Run busy-emulator build ${quoted}, then busy-emulator submit ${quoted} again.` },
  };
  const { call, sent } = setup({ answers: (words) => answers[words[0]] });
  const refresh = await call("projects.refresh", CLOCK);
  assert.equal(refresh.hint, "Fix what busy-cli says, then press Refresh again.");
  const check = await call("projects.check", CLOCK);
  assert.equal(check.hint, "Change what the failing checks name, then press Publish again.");
  assert.deepEqual(
    check.checks.map((one) => one.message),
    [
      "Here: category: not written yet; changelog: not written yet\nChange: Fill in category and changelog in catalog.json in the project's folder (Show in Finder opens it). category is one of: clocks, games.",
      "Here: there are no screenshots\nChange: Run the app on the emulated BUSY Bar and take one: busy-emulator screenshot (a terminal command). The first one is the app's cover in the catalog.",
      "the project is not built\nPress Build first.",
      "Publish writes applications/app.you.clock/manifest.yml",
    ],
  );
  const submit = await call("projects.submit", CLOCK);
  assert.equal(submit.hint, "Press Build, then press Publish again.");
  // On Windows the file manager is Explorer.
  const windows = setup({ answers: (words) => answers[words[0]], platform: "win32" });
  assert.match((await windows.call("projects.check", CLOCK)).checks[0].message, /\(Show in Explorer opens it\)/);
  // Nothing the page is sent names the app's Node or command line by its path.
  for (const text of [refresh.message, refresh.hint, check.message, check.hint, ...check.checks.map((one) => one.message), submit.message, submit.hint, ...sent.map((job) => job.line)]) {
    if (text) assert.doesNotMatch(text, ABSOLUTE, text);
  }
});

test("the development loop's lines and a refused action's hint come in the window's words too", async () => {
  let loop;
  const { call, sent } = setup({ answers: (words, run) => (words[0] === "dev" ? void (loop = run) : { ok: false, code: "not_running", message: "The emulator is not running, so there is no BUSY Bar to run the app on.", hint: `Start it with ${BY_PATH} start, then run ${BY_PATH} run '${CLOCK}' again.` }) });
  assert.equal((await call("projects.dev.start", CLOCK)).ok, true);
  loop.onLine(`12:00:00  failed   busy-cli app install failed with exit code 1:`, "out");
  loop.onLine(`Fix what busy-cli says, then run ${BY_PATH} dev '${CLOCK}' again.`, "out");
  loop.end(0);
  await sleep(5);
  assert.deepEqual(sent.map((job) => job.line).filter(Boolean), ["12:00:00  failed   busy-cli app install failed with exit code 1:", "Fix what busy-cli says, then press Watch the folder again."]);
  const run = await call("projects.run", CLOCK);
  assert.equal(run.hint, "Start it with busy-emulator start (a terminal command), then press Run again.");
});

test("check's short answer (failing, warnings, unchecked) is shown as the whole list is", async () => {
  const { call } = setup({
    answers: () => ({
      ok: false,
      code: "check_failed",
      message: "1 of the catalog's checks fails for app.you.clock: license.",
      hint: "Change what the failing checks name, then run busy-emulator check again.",
      built: true,
      failing: [{ id: "license", title: "Open source license", message: "there is no LICENSE", fix: "Add a LICENSE file." }],
      warnings: [{ id: "icon_missing", title: "Icon", message: "the app has no front icon", fix: "Run busy-emulator icon --text AB: it makes the icons." }],
      unchecked: [{ id: "build", title: "Build", message: "the catalog builds it", fix: null }],
      waiting: [],
      full: false,
    }),
  });
  const check = await call("projects.check", CLOCK);
  assert.deepEqual(check.checks, [
    { id: "license", title: "Open source license", answer: "fails", message: "Here: there is no LICENSE\nChange: Add a LICENSE file.", blocking: true },
    { id: "icon_missing", title: "Icon", answer: "fails", message: "Here: the app has no front icon\nChange: Run busy-emulator icon --text AB (a terminal command): it makes the icons.", blocking: false },
    { id: "build", title: "Build", answer: "unchecked", message: "the catalog builds it", blocking: true },
  ]);
  assert.equal(check.hint, "Change what the failing checks name, then press Publish again.");
});

test("the first run's greeting: shown until the person answers it, which is written in the app's settings in its data folder, and with the command line's path", async () => {
  const settingsFile = path.join(DATA, "app-settings.json");
  const settings = createSettings(settingsFile);
  settings.update({ updateCheck: true });
  const { call, calls } = setup();
  const welcomed = createActions({ startCli: () => assert.fail("the greeting runs no command"), dialogs: {}, show: () => {}, copy: () => {}, send: () => {}, dataDir: DATA, logFile: "/data/logs/shell.log", log: () => {}, welcome: { settings, platform: "darwin", cli: () => "~/.busy-emulator/bin/busy-emulator" } });
  assert.deepEqual(await welcomed.call("welcome.get"), { ok: true, value: { show: true, way: null, platform: "darwin", cli: "~/.busy-emulator/bin/busy-emulator" } });
  assert.deepEqual(await welcomed.call("welcome.seen"), { ok: true, value: true });
  assert.deepEqual((await welcomed.call("welcome.get")).value.show, false);
  // Beside the app's other settings, which stay; nothing in a project's folder.
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { updateCheck: true, welcomed: true });
  // The way chosen is kept, for "Getting started" next time; closing without a choice keeps the last one, and nothing
  // but the two ways is written.
  assert.deepEqual(await welcomed.call("welcome.seen", { way: "agent" }), { ok: true, value: true });
  assert.equal((await welcomed.call("welcome.get")).value.way, "agent");
  await welcomed.call("welcome.seen");
  await welcomed.call("welcome.seen", { way: "vim", other: 1 });
  await welcomed.call("welcome.seen", "code");
  assert.equal((await welcomed.call("welcome.get")).value.way, "agent");
  await welcomed.call("welcome.seen", { way: "code" });
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { updateCheck: true, welcomed: true, welcomeWay: "code" });
  // A way the file names that is not one of the two is not passed on.
  settings.update({ welcomeWay: "<b>x</b>" });
  assert.equal((await welcomed.call("welcome.get")).value.way, null);
  assert.equal(existsSync(path.join(CLOCK, "app-settings.json")), false);
  // An app given no greeting says so, as any action that cannot be done.
  assert.equal((await call("welcome.get")).rejected.code, "unavailable");
  assert.deepEqual(calls.filter((line) => !line.startsWith("projects --prune")), []);
});

test("Show in Finder/Explorer: a folder is opened, its files in view; a file is selected in its folder; a folder the system does not open is selected", async () => {
  const seen = [];
  const system = (opened = "") => ({ openPath: (target) => (seen.push(["open", target]), opened), showItemInFolder: (target) => seen.push(["select", target]), log: (line) => seen.push(["log", line]) });
  await showPath("/p/clock", { ...system(), isDirectory: () => true });
  await showPath("/p/clock/src/main.ts", { ...system(), isDirectory: () => false });
  await showPath("/p/gone", { ...system(), isDirectory: () => assert.fail("not there") || true });
  await showPath("/p/odd", { ...system(Promise.resolve("Failed to open path")), isDirectory: () => true });
  await showPath("/p/thrown", { ...system(), openPath: () => Promise.reject(new Error("no")), isDirectory: () => true });
  assert.deepEqual(seen.filter(([kind]) => kind !== "log"), [
    ["open", "/p/clock"],
    ["select", "/p/clock/src/main.ts"],
    ["select", "/p/gone"],
    ["open", "/p/odd"],
    ["select", "/p/odd"],
    ["select", "/p/thrown"],
  ]);
  // On the real disk: the data folder is a folder.
  const real = [];
  await showPath(DATA, { openPath: (target) => real.push(target) && "", showItemInFolder: () => assert.fail("a folder is opened") });
  assert.deepEqual(real, [DATA]);
});

test("Show in Finder/Explorer never opens a folder the system would start: X.app, a bundle without the name, X.{CLSID}", async () => {
  // A project folder named like an app, with what makes it one on macOS: opened, Finder would run Contents/MacOS/X.
  const bundle = path.join(root, "shown", "X.app");
  mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(path.join(bundle, "Contents", "Info.plist"), "<plist><dict><key>CFBundleExecutable</key><string>X</string></dict></plist>");
  writeFileSync(path.join(bundle, "Contents", "MacOS", "X"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const unnamed = path.join(root, "shown", "plain name");
  mkdirSync(path.join(unnamed, "Contents"), { recursive: true });
  const clsid = path.join(root, "shown", "x.{645FF040-5081-101B-9F08-00AA002F954E}");
  mkdirSync(clsid, { recursive: true });
  const seen = [];
  const system = { openPath: (target) => (seen.push(["open", target]), ""), showItemInFolder: (target) => seen.push(["select", target]) };
  for (const folder of [bundle, unnamed, clsid, CLOCK]) await showPath(folder, system);
  assert.deepEqual(seen, [["select", bundle], ["select", unnamed], ["select", clsid], ["open", CLOCK]]);
  assert.deepEqual([maybeLaunched("/p/clock", { holdsContents: () => false }), maybeLaunched("/p/.hidden", { holdsContents: () => false }), maybeLaunched("/p/my.app", { holdsContents: () => false })], [false, false, true]);
});

test("the command line's path for the text for agents: the pointer file's, else the launcher's; from ~ on macOS", () => {
  // macOS paths as macOS writes them, on any system the test runs on; the pointer file itself is a real one.
  const home = "/Users/user/Ann Lee";
  const pointer = path.join(DATA, "install.json");
  const launcher = path.posix.join(home, ".busy-emulator", "bin", "busy-emulator");
  assert.equal(shownCliPath({ pointer, launcher, home, platform: "darwin" }), "~/.busy-emulator/bin/busy-emulator", "no pointer yet: the launcher");
  writeFileSync(pointer, JSON.stringify({ app: "/Applications/BUSY Bar Emulator.app", cli: path.posix.join(home, "elsewhere", "busy-emulator"), version: "0.1.0" }));
  assert.equal(shownCliPath({ pointer, launcher, home, platform: "darwin" }), "~/elsewhere/busy-emulator");
  assert.equal(shownCliPath({ pointer, launcher, home: "/Users/you", platform: "darwin" }), path.posix.join(home, "elsewhere", "busy-emulator"), "outside the home folder: the whole path");
  writeFileSync(pointer, JSON.stringify({ cli: "relative/busy-emulator" }));
  assert.equal(shownCliPath({ pointer, launcher, home, platform: "darwin" }), "~/.busy-emulator/bin/busy-emulator", "a pointer that names no whole path is not taken");
  const windows = "C:\\Users\\user\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe";
  assert.equal(shownCliPath({ launcher: windows, home: "C:\\Users\\user", platform: "win32" }), windows, "Windows: the whole path, as PowerShell takes it");
  assert.equal(shownCliPath({}), null, "a run from the source folder has none");
});

test("publishing: each step is the command line's publish or catalog-texts on a project of the list; the window's words are checked first", async () => {
  const shots = [path.join(root, "made", "front@8x.png"), path.join(root, "made", "back.png")];
  const { call, work } = setup({ answers: (words) => ({ ok: true, command: words[0], steps: {} }), choose: { screenshots: shots } });
  assert.deepEqual(await call("publish.status", CLOCK), { ok: true, steps: {} }, "the answer, without the command's name");
  await call("publish.check", CLOCK);
  await call("publish.texts", { folder: CLOCK, texts: { category: "productivity", description: "-starts with a dash\nand two lines" } });
  await call("publish.texts", { folder: CLOCK, name: "Desk Clock", texts: { changelog: "First." } });
  await call("publish.screenshots", { folder: CLOCK, take: "back" });
  await call("publish.screenshots", { folder: CLOCK, upload: true });
  await call("publish.readme", { folder: CLOCK, readme: { mode: "fields", title: "Desk Clock", usage: "- Start shows the date" } });
  await call("publish.screenshots", { folder: CLOCK, order: { front: ["screenshots/front-2.png", "screenshots/front-1.png"], back: [] } });
  await call("publish.screenshots", { folder: CLOCK, remove: "screenshots/front-1.png" });
  await call("publish.license", { folder: CLOCK, license: "MIT", author: "Jane Doe" });
  await call("publish.files", { folder: CLOCK });
  await call("publish.files", { folder: CLOCK, write: true, keepOut: ".env", readme: "replace" });
  await call("publish.package", CLOCK);
  // Build and package: one action of the click, the build first (it takes longer than the click's two seconds).
  await call("publish.package", { folder: CLOCK, build: true });
  assert.deepEqual(work(), [
    `publish status ${CLOCK} --json`,
    `publish check ${CLOCK} --json --progress`,
    `catalog-texts set ${CLOCK} --category=productivity --description=-starts with a dash\nand two lines --json --progress`,
    `catalog-texts set ${CLOCK} --name=Desk Clock --changelog=First. --json --progress`,
    `publish screenshots ${CLOCK} --take=back --json --progress`,
    `publish screenshots ${CLOCK} --upload=${JSON.stringify(shots)} --json --progress`,
    `publish readme set ${CLOCK} --mode=fields --title=Desk Clock --usage=- Start shows the date --json --progress`,
    `publish screenshots ${CLOCK} --order={"front":["screenshots/front-2.png","screenshots/front-1.png"],"back":[]} --json --progress`,
    `publish screenshots ${CLOCK} --remove=screenshots/front-1.png --json --progress`,
    `publish license ${CLOCK} --license=MIT --author=Jane Doe --json --progress`,
    `publish files ${CLOCK} --json --progress`,
    `publish files ${CLOCK} --write --keep-out=.env --readme=replace --json --progress`,
    `publish package ${CLOCK} --json --progress`,
    `build ${CLOCK} --json --progress`,
    `publish package ${CLOCK} --json --progress`,
  ]);
  // A build that fails is answered as the build's, and nothing is packaged.
  const broken = setup({ answers: (words) => (words[0] === "build" ? { ok: false, command: "build", code: "tool_failed", message: "it broke" } : { ok: true, command: words[0] }) });
  const answer = await broken.call("publish.package", { folder: CLOCK, build: true });
  assert.deepEqual([answer.ok, answer.step, answer.code], [false, "build", "tool_failed"]);
  assert.deepEqual(broken.work(), [`build ${CLOCK} --json --progress`]);
  assert.equal((await broken.call("publish.package", { folder: CLOCK, build: "yes" })).code, "usage");
  // What the window may not ask for is refused before anything runs.
  const before = work().length;
  for (const [name, arg] of [
    ["publish.texts", { folder: CLOCK, texts: { description: 7 } }],
    ["publish.texts", { folder: CLOCK, texts: { category: "x".repeat(9000) } }],
    ["publish.screenshots", { folder: CLOCK, take: "side" }],
    ["publish.screenshots", { folder: CLOCK, remove: "../outside.png" }],
    ["publish.screenshots", { folder: CLOCK, order: { front: ["/etc/passwd"], back: [] } }],
    ["publish.license", { folder: CLOCK, license: "WTFPL" }],
    ["publish.readme", { folder: CLOCK }],
    ["publish.readme", { folder: CLOCK, readme: { mode: "html" } }],
    ["publish.readme", { folder: CLOCK, readme: { usage: 7 } }],
    ["publish.texts", { folder: CLOCK, name: 7, texts: {} }],
    ["publish.license", { folder: CLOCK }],
    ["publish.files", { folder: CLOCK, write: true, keepOut: "C:\\x" }],
    ["publish.files", { folder: CLOCK, write: true, readme: "delete" }],
  ]) {
    assert.equal((await call(name, arg)).code, "usage", `${name} ${JSON.stringify(arg).slice(0, 80)}`);
  }
  assert.equal(work().length, before);
  assert.equal((await call("publish.package", path.join(root, "not a project"))).code, "unknown_project");
});

/** The head of a PNG of `size`×`size`: what the shell checks of an icon before it writes anything. */
const pngHead = (size) => {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  return `data:image/png;base64,${bytes.toString("base64")}`;
};

test("publishing, prepare's own: Upload icon, one display's screenshots, and the person's license file asked before it replaces one", async () => {
  const license = path.join(root, "made", "MY-LICENSE.txt");
  mkdirSync(path.dirname(license), { recursive: true });
  writeFileSync(license, "Copyright 2026 Jane Doe\n\nEveryone may use it.\n");
  // The command line takes the license file only from the project or the data folder's tmp/: the file the person chose
  // goes there for it, under its own name, with the same text, and is gone after.
  const staged = [];
  const from = (words) => words.find((one) => one.startsWith("--from="))?.slice("--from=".length) ?? null;
  const { call, work } = setup({
    answers: (words) => {
      if (words[0] !== "publish" || words[1] !== "license") return { ok: true, command: words[0] };
      const file = from(words);
      staged.push({ file, text: file && existsSync(file) ? readFileSync(file, "utf8") : null });
      return !words.includes("--replace") ? { ok: false, command: "publish", code: "license_exists", message: "The project has LICENSE already; it is kept.", file: "LICENSE" } : { ok: true, command: words[0] };
    },
    choose: { screenshots: [path.join(root, "made", "back.png")], license: license },
  });
  // The icon: the PNGs the page checked, checked again here, written by the command line's icon --from.
  assert.equal((await call("publish.icon", { folder: CLOCK, front: pngHead(8), back: pngHead(11) })).ok, true);
  const icon = work().at(-1);
  assert.match(icon, new RegExp(`^icon ${CLOCK.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} --from=?.*front\.png --back=?.*back\.png --force --json --progress$`));
  for (const bad of [{ front: pngHead(11) }, { front: pngHead(8), back: pngHead(8) }, { front: "data:image/png;base64,AAAA" }, {}]) assert.equal((await call("publish.icon", { folder: CLOCK, ...bad })).code, "usage", JSON.stringify(bad).slice(0, 60));
  // One display's Upload: its own dialog, and the command line takes only that display's.
  shotsFor.length = 0;
  await call("publish.screenshots", { folder: CLOCK, upload: "back" });
  assert.deepEqual(shotsFor, ["back"]);
  assert.equal(work().at(-1), `publish screenshots ${CLOCK} --upload=${JSON.stringify([path.join(root, "made", "back.png")])} --display=back --json --progress`);
  // The license file: copied in; one there is not replaced until the person says so, with the file they chose then.
  const asked = await call("publish.license", { folder: CLOCK, license: "other", upload: true });
  assert.deepEqual([asked.ok, asked.code, asked.file, asked.chosen], [false, "license_exists", "LICENSE", "MY-LICENSE.txt"]);
  assert.equal(work().at(-1), `publish license ${CLOCK} --license=other --from=${staged[0].file} --json --progress`);
  assert.equal((await call("publish.license", { folder: CLOCK, license: "other", replace: true })).ok, true);
  assert.equal(work().at(-1), `publish license ${CLOCK} --license=other --from=${staged[1].file} --replace --json --progress`);
  for (const one of staged) {
    assert.equal(path.dirname(path.dirname(one.file)), path.join(DATA, "tmp"), "in the data folder's tmp/");
    assert.equal(path.basename(one.file), "MY-LICENSE.txt");
    assert.equal(one.text, readFileSync(license, "utf8"));
    assert.equal(existsSync(one.file), false, "taken away after");
  }
  assert.equal((await call("publish.license", { folder: CLOCK, license: "other", replace: true })).code, "usage", "a yes answers one question only");
  assert.equal((await call("publish.license", { folder: CLOCK, license: "MIT", upload: true })).code, "usage", "a file of one's own goes with Another license");
});

test("open: a text file of a project in the system's app; nothing else", async () => {
  writeFileSync(path.join(CLOCK, "catalog.json"), "{}");
  writeFileSync(path.join(CLOCK, "main.js"), "");
  const { call, opened } = setup();
  assert.equal(await call("open", path.join(CLOCK, "catalog.json")), true);
  for (const target of [path.join(CLOCK, "main.js"), path.join(CLOCK, "nothing.json"), path.join(root, "outside.json"), path.join(CLOCK, "..", "x.md"), "catalog.json", null, 7]) {
    assert.equal(await call("open", target), false, String(target));
  }
  assert.deepEqual(opened, [path.join(CLOCK, "catalog.json")]);
});

// ---- Create app's form (create-app.js): the place, the name and id, the texts and the icon

/** A PNG of `size`×`size`, transparent, as a data: address: what the page's canvas gives. */
function png(width, height = width) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  return `data:image/png;base64,${Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`;
}

test("Create app's place: the default folder or one the person chose, the next free name, the author's part of the id", async () => {
  const PLACES = path.join(root, "person", "BUSY Bar projects");
  mkdirSync(path.join(PLACES, "focus-timer"), { recursive: true });
  writeFileSync(path.join(PLACES, "focus-timer", "main.ts"), "");
  mkdirSync(path.join(PLACES, "empty-one"), { recursive: true });
  const { call, calls } = setup({ newProjects: PLACES, choose: { parent: path.join(root, "clock") } });
  // The form shows a folder in the home folder (root here) from ~ on macOS, and in full on Windows.
  const shown = (full) => (process.platform === "win32" ? full : `~${full.slice(root.length)}`);
  await call("projects.place.choose", { from: PLACES });
  assert.deepEqual(await call("projects.place", { parent: null, folder: "focus-timer" }), { parent: PLACES, shown: shown(PLACES), folder: "focus-timer-2", path: path.join(PLACES, "focus-timer-2"), shownPath: shown(path.join(PLACES, "focus-timer-2")), namespace: "jane_doe", author: { name: "Jane Doe", from: "git" } });
  assert.equal((await call("projects.place", { folder: "empty-one" })).folder, "empty-one", "an empty folder is taken as it is");
  // A parent the person did not choose, a folder name that is a path: refused, nothing looked at.
  for (const asked of [{ parent: "/etc", folder: "x" }, { parent: PLACES, folder: "../x" }, { parent: PLACES, folder: "a/b" }, { parent: PLACES, folder: ".hidden" }, { parent: PLACES, folder: "x".repeat(80) }]) {
    assert.equal((await call("projects.place", asked)).rejected.code, "usage", JSON.stringify(asked));
  }
  // Change: the system's dialog; the folder chosen there is a place from then on.
  assert.deepEqual(await call("projects.place.choose", { from: "/etc" }), { parent: path.join(root, "clock"), shown: shown(path.join(root, "clock")) });
  assert.deepEqual(opensAt, [PLACES, null], "the default place is opened; a folder the page names that is no place is not");
  // The default place before the first app is not there yet: the dialog opens at the folder it goes in.
  const fresh = setup({ newProjects: path.join(root, "person", "not yet"), choose: { parent: null } });
  await fresh.call("projects.place.choose", { from: path.join(root, "person", "not yet") });
  assert.deepEqual(opensAt.at(-1), path.join(root, "person"));
  assert.equal((await call("projects.place", { parent: path.join(root, "clock"), folder: "fresh" })).path, path.join(root, "clock", "fresh"));
  assert.deepEqual(calls, [], "no command line for any of it");
  assert.equal(namespaceOf("José Müller"), "jose_muller");
  assert.equal(namespaceOf(null), "example");
});

test("Create app's form: the project is made where the place says, then its texts and icons by the command line", async () => {
  const PLACES = path.join(root, "person2", "BUSY Bar projects");
  const target = path.join(PLACES, "focus-timer");
  const { call, work, sent } = setup({ newProjects: PLACES, projects: [entry(target, { id: "app.jane_doe.focus_timer" })], answers: (words) => (words[0] === "create" ? { ok: true, folder: target, id: "app.jane_doe.focus_timer" } : { ok: true }) });
  const made = await call("projects.create", { example: null, place: { parent: PLACES, folder: "focus-timer" }, name: "Focus Timer", id: "app.jane_doe.focus_timer", texts: { short_description: "Shows the focus time left", category: "productivity" }, icon: { text: "ft", color: "#FF5A1F" } });
  assert.equal(made.folder, target);
  assert.equal(made.unfinished, undefined);
  assert.ok(existsSync(PLACES), "the default place is made when it is not there");
  assert.deepEqual(work(), [
    `create ${target} --author=Jane Doe --name=Focus Timer --id=app.jane_doe.focus_timer --description=Shows the focus time left --json --progress`,
    `catalog-texts set ${target} --category=productivity --short-description=Shows the focus time left --json --progress`,
    `icon ${target} --text FT --color #FF5A1F --force --json --progress`,
    // Create app ends with the app on the bar: one Refresh.
    `dev ${target} --once --json --progress`,
  ]);
  assert.deepEqual([...new Set(sent.map((job) => job.kind))], ["create", "refresh"]);
  assert.deepEqual(made.refreshed, { ok: true, message: "The app is running." });
});

test("create-offline: a project created without its dependencies is created; Retry and the window's own retry install them", async () => {
  const PLACES = path.join(root, "person-offline", "BUSY Bar projects");
  const target = path.join(PLACES, "focus-timer");
  mkdirSync(target, { recursive: true });
  const failedDeps = { state: "failed", code: "network_failed", message: "npm install could not reach https://registry.npmjs.org/@busy-app%2fcli: ENOTFOUND.", at: "2026-11-11T20:00:00.000Z" };
  const projects = [entry(target, { id: "app.jane_doe.focus_timer", installed: false, built: false, dependencies: failedDeps })];
  let network = false;
  const { call, work, sent } = setup({
    newProjects: PLACES,
    projects,
    answers: (words) => {
      if (words[0] === "create") return { ok: false, code: "network_failed", message: "npm install could not reach the registry.", hint: "Check the connection.", created: true, folder: target, id: "app.jane_doe.focus_timer" };
      if (words[0] === "build" && words.includes("--dependencies-only")) {
        if (!network) return { ok: false, code: "network_failed", message: "npm install could not reach the registry." };
        projects[0].dependencies = { state: "installed" };
        return { ok: true, dependencies: "installed" };
      }
      return { ok: true };
    },
  });
  const made = await call("projects.create", { example: "focus-timer", place: { parent: PLACES, folder: "focus-timer" }, name: "Focus Timer" });
  assert.equal(made.folder, target, "resolved with the project, not refused");
  assert.deepEqual(made.dependencies, { state: "failed", reason: "no network", message: failedDeps.message, retry: true });
  // From ~ on macOS, as the form shows a place (the stand-in's home is the test's folder); the full path on Windows.
  assert.equal(made.shownFolder, process.platform === "win32" ? target : `~${target.slice(root.length)}`);
  // The job ended well, with the reason as its line for the log.
  assert.deepEqual(sent.filter((job) => job.kind === "create").at(-1), { id: sent.filter((job) => job.kind === "create").at(-1).id, kind: "create", folder: target, state: "done", line: "npm install could not reach the registry." });

  // Retry while the network is down: the failure is said; nothing else ran.
  assert.equal((await call("projects.dependencies", target)).code, "network_failed");
  assert.deepEqual(work().at(-1), `build ${target} --dependencies-only --json --progress`);
  // The window's own retry: at most once in a while for a project.
  const tried = await call("projects.dependencies.auto");
  assert.deepEqual(tried.started, [target]);
  assert.deepEqual((await call("projects.dependencies.auto")).started, [], "not again so soon");
  network = true;
  // Made by the pop-up: the app was meant to run, so the Retry goes on with a Refresh (the window's own retry had
  // already tried while the network was down).
  assert.deepEqual(await call("projects.dependencies", target), { ok: true, message: "Dependencies installed. The app is running.", followed: "refresh" });
  assert.deepEqual((await call("projects.list"))[0].dependencies, { state: "installed", reason: null, message: null, retry: false });
  assert.equal(work().filter((line) => line.startsWith("build ")).length, 3, "Retry, the window's own, Retry");
});

test("create-offline: a project Create app's pop-up made without its dependencies is put on the BUSY Bar by the Retry that brings them, once; the folder dialog's is not", async () => {
  const PLACES = path.join(root, "person-offline-run", "BUSY Bar projects");
  const target = path.join(PLACES, "focus-timer");
  const other = path.join(root, "person-offline-run", "chosen");
  for (const dir of [target, other]) mkdirSync(dir, { recursive: true });
  const failedDeps = { state: "failed", code: "network_failed", message: "npm install could not reach the registry.", at: "2026-11-11T20:00:00.000Z" };
  const projects = [entry(target, { id: "app.jane_doe.focus_timer", installed: false, built: false, dependencies: failedDeps }), entry(other, { id: "app.you.other", installed: false, built: false, dependencies: failedDeps })];
  let network = false;
  const { call, work } = setup({
    newProjects: PLACES,
    choose: { create: other },
    projects,
    answers: (words) => {
      if (words[0] === "create") return { ok: false, code: "network_failed", message: "npm install could not reach the registry.", created: true, folder: words[1], id: "app.jane_doe.focus_timer" };
      if (words[0] === "dev") return { ok: true, id: words[1] === target ? "app.jane_doe.focus_timer" : "app.you.other", running: true };
      if (words[0] === "build" && words.includes("--dependencies-only")) {
        if (!network) return { ok: false, code: "network_failed", message: "npm install could not reach the registry." };
        for (const one of projects) if (one.folder === words[1]) one.dependencies = { state: "installed" };
        return { ok: true, dependencies: "installed" };
      }
      return { ok: true };
    },
  });
  const ran = () => work().filter((line) => line.startsWith("dev "));
  assert.equal((await call("projects.create", { example: "focus-timer", place: { parent: PLACES, folder: "focus-timer" }, name: "Focus Timer" })).folder, target);
  assert.equal((await call("projects.create", {})).folder, other, "the folder dialog's create");
  assert.equal((await call("projects.dependencies", target)).code, "network_failed");
  assert.deepEqual(ran(), [], "nothing runs while the dependencies are not there");
  network = true;
  assert.deepEqual(await call("projects.dependencies", target), { ok: true, message: "Dependencies installed. app.jane_doe.focus_timer is running.", followed: "refresh" });
  assert.deepEqual(ran(), [`dev ${target} --once --json --progress`]);
  assert.deepEqual(await call("projects.dependencies", other), { ok: true, message: "Dependencies installed" });
  assert.equal(ran().length, 1, "the folder dialog's project is only made, as the command line's create");
  // The window's own retry does the same for a pop-up's project.
  network = false;
  projects[0].dependencies = failedDeps;
  await call("projects.create", { example: "focus-timer", place: { parent: PLACES, folder: "focus-timer" }, name: "Focus Timer" });
  network = true;
  assert.ok((await call("projects.dependencies.auto")).started.includes(target));
  for (let i = 0; i < 50 && ran().length < 2; i++) await sleep(10);
  assert.equal(ran().length, 2);
});

test("create-offline: a Retry that brings the dependencies of a Refresh that stopped at them goes on to put the app on the BUSY Bar; a project only created by the command line is not started", async () => {
  const failedDeps = { state: "failed", code: "network_failed", message: "npm install could not reach the registry.", at: "2026-11-11T20:00:00.000Z" };
  const projects = [entry(CLOCK, { installed: false, built: false, dependencies: failedDeps })];
  let network = false;
  const { call, work } = setup({
    projects,
    answers: (words) => {
      if (words[0] === "dev") return network ? { ok: true, id: "app.you.clock", running: true } : { ok: false, code: "network_failed", message: "npm install could not reach the registry." };
      if (words[0] === "build" && words.includes("--dependencies-only")) {
        if (!network) return { ok: false, code: "network_failed", message: "npm install could not reach the registry." };
        projects[0].dependencies = { state: "installed" };
        return { ok: true, dependencies: "installed" };
      }
      return { ok: true };
    },
  });
  const ran = () => work().filter((line) => line.startsWith("dev "));

  // Not made by the pop-up, never refreshed (a project the command line created): Retry installs the dependencies only.
  network = true;
  assert.deepEqual(await call("projects.dependencies", CLOCK), { ok: true, message: "Dependencies installed" });
  assert.deepEqual(ran(), []);

  // The person pressed Refresh while the network was down: it stopped at the dependencies.
  network = false;
  projects[0].dependencies = failedDeps;
  assert.equal((await call("projects.refresh", CLOCK)).code, "network_failed");
  // A Retry while it is still down: nothing more.
  assert.equal((await call("projects.dependencies", CLOCK)).code, "network_failed");
  assert.equal(ran().length, 1);
  // The network is back: Retry installs them, then builds, installs and starts the app as Refresh does.
  network = true;
  assert.deepEqual(await call("projects.dependencies", CLOCK), { ok: true, message: "Dependencies installed. app.you.clock is running.", followed: "refresh" });
  assert.deepEqual(ran(), [`dev ${CLOCK} --once --json --progress`, `dev ${CLOCK} --once --json --progress`]);
  // Once: the next Retry does not start it again.
  await call("projects.dependencies", CLOCK);
  assert.equal(ran().length, 2);

  // The window's own retry does the same.
  network = false;
  projects[0].dependencies = failedDeps;
  await call("projects.refresh", CLOCK);
  network = true;
  assert.deepEqual((await call("projects.dependencies.auto")).started, [CLOCK]);
  for (let i = 0; i < 50 && ran().length < 4; i++) await sleep(10);
  assert.equal(ran().length, 4, "Refresh, then the one after the window's own retry");
});

test("Create app's name, id and description that start with \"-\" go to create as values, never as options", async () => {
  const PLACES = path.join(root, "person-dash", "BUSY Bar projects");
  const target = path.join(PLACES, "dash");
  const { call, work } = setup({ newProjects: PLACES, projects: [entry(target)], answers: (words) => (words[0] === "create" ? { ok: true, folder: target } : { ok: true }) });
  await call("projects.create", { place: { parent: PLACES, folder: "dash" }, name: "--help", texts: { short_description: "--json is not an option here" } });
  assert.equal(work()[0], `create ${target} --author=Jane Doe --name=--help --description=--json is not an option here --json --progress`);
});

test("Create app's own icons: PNGs of 8×8 and 11×11, put down in the data folder for icon --from --back and taken away after", async () => {
  const PLACES = path.join(root, "person3", "BUSY Bar projects");
  const target = path.join(PLACES, "my-app");
  const seen = [];
  const { call, work } = setup({
    newProjects: PLACES,
    projects: [entry(target)],
    answers: (words) => {
      if (words[0] === "icon") seen.push(words.filter((word) => word.endsWith(".png")).map((file) => [path.basename(file), existsSync(file), file.startsWith(path.join(DATA, "tmp"))]));
      return words[0] === "create" ? { ok: true, folder: target } : words[0] === "icon" ? { ok: false, code: "write_failed", message: "Could not write the icon." } : { ok: true };
    },
  });
  const made = await call("projects.create", { place: { parent: PLACES, folder: "my-app" }, name: "My app", icon: { front: png(8), back: png(11) } });
  assert.deepEqual(seen, [[["front.png", true, true], ["back.png", true, true]]]);
  assert.match(work().at(-2), /^icon .* --from .*front\.png --back .*back\.png --force --json --progress$/);
  assert.equal(work().at(-1), `dev ${target} --once --json --progress`, "then the Refresh that ends Create app");
  assert.deepEqual(readdirSync(path.join(DATA, "tmp")), [], "the pictures are gone after");
  // The project is there; what failed after create is said.
  assert.deepEqual(made.unfinished, ["The icons were not made: Could not write the icon."]);
});

test("Create app's form is checked before anything runs: a place, a name, an id, the texts and pictures of the right sizes", async () => {
  const PLACES = path.join(root, "person4", "BUSY Bar projects");
  const { call, calls } = setup({ newProjects: PLACES });
  const place = { parent: PLACES, folder: "x" };
  for (const asked of [
    { place: { parent: "/tmp", folder: "x" } },
    { place: { parent: PLACES, folder: "../../etc" } },
    { place, name: 'A "quoted" name' },
    { place, name: "x".repeat(65) },
    { place, id: "App.Bad" },
    { place, id: `app.${"x".repeat(40)}` },
    { place, texts: { short_description: 7 } },
    { place, icon: { text: "ABC" } },
    { place, icon: { text: "A", color: "red" } },
    { place, icon: { front: png(16) } },
    { place, icon: { front: png(8), back: png(8) } },
    { place, icon: { front: "data:image/png;base64,not a picture" } },
  ]) {
    assert.equal((await call("projects.create", asked)).rejected.code, "usage", JSON.stringify(asked).slice(0, 120));
  }
  assert.deepEqual(calls, []);
  assert.equal(existsSync(PLACES), false, "not even the default place is made");
  assert.ok(iconPicture(png(8), 8) && iconPicture(png(11), 11));
  assert.equal(iconPicture(png(8, 11), 8), null);
  // A short description with a quote goes to catalog.json, not to the generator.
  assert.equal(createRequest({ texts: { short_description: 'Says "hi" to you' } }).description, null);
});

test("the author for the id the form suggests: git's user.name from the person's git settings, else the account's name", () => {
  const home = path.join(root, "author-home");
  mkdirSync(home, { recursive: true });
  assert.equal(gitAuthor(home, { userName: () => "jane" }), "jane");
  writeFileSync(path.join(home, ".gitconfig"), '[core]\n\tname = not this\n[user]\n\temail = j@example.com\n\tname = "Jane Doe"\n');
  assert.equal(gitAuthor(home, { userName: () => "jane" }), "Jane Doe");
});

test("a new app's author: the GitHub login first, then git's user.name, then the account's name, never a name many computers share (the release dry run)", () => {
  const home = path.join(root, "author-home-2");
  mkdirSync(home, { recursive: true });
  assert.deepEqual(newAppAuthor(home, { login: "Jane-Dev", userName: () => "User" }), { name: "Jane-Dev", from: "github" });
  assert.deepEqual(newAppAuthor(home, { login: "not a login", userName: () => "jane" }), { name: "jane", from: "account" });
  for (const account of ["User", "admin", "Administrator", "OWNER", "pc", "", 'ja"ne']) assert.equal(newAppAuthor(home, { userName: () => account }), null, account);
  assert.equal(newAppAuthor(home, { userName: () => { throw new Error("no account"); } }), null);
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = user\n");
  assert.equal(newAppAuthor(home, { userName: () => "jane" }), null, "git's user.name is the generator's: a generic one is not passed over for the account's");
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = Jane Doe\n");
  assert.deepEqual(newAppAuthor(home, { userName: () => "User" }), { name: "Jane Doe", from: "git" });
  assert.deepEqual(newAppAuthor(home, { login: "jane-dev" }), { name: "jane-dev", from: "github" }, "the login before git's user.name");
  // The same list as the command line's: packages/server/projects/test/author.test.mjs compares the two.
  for (const name of ["User", "Your Name", "busy bar developer"]) assert.ok(genericAuthor(name), name);
  assert.ok(!genericAuthor("jane") && GENERIC_AUTHORS.includes("user"));
});

test("Create app without a known author: the place says so (author null), and the author the form asks for goes to create; a generic one is refused", async () => {
  const PLACES = path.join(root, "person-author", "BUSY Bar projects");
  const target = path.join(PLACES, "focus-timer");
  const { call, work } = setup({ newProjects: PLACES, author: () => null, projects: [entry(target)], answers: (words) => (words[0] === "create" ? { ok: true, folder: target } : { ok: true }) });
  const place = await call("projects.place", { folder: "focus-timer" });
  assert.deepEqual([place.author, place.namespace], [null, "example"]);
  assert.equal((await call("projects.create", { place: { parent: PLACES, folder: "focus-timer" }, name: "Focus Timer", author: "User" })).rejected.code, "usage");
  assert.equal(createRequest({ author: "Administrator" }).problem, '"Administrator" is a name many computers share: write your GitHub login or your own name.');
  assert.equal(createRequest({ author: 'Ja"ne' }).problem, "The author is a line of text without quotes or backslashes.");
  await call("projects.create", { place: { parent: PLACES, folder: "focus-timer" }, name: "Focus Timer", id: "app.jane-dev.focus_timer", author: " jane-dev " });
  assert.equal(work()[0], `create ${target} --author=jane-dev --name=Focus Timer --id=app.jane-dev.focus_timer --json --progress`);
  // The GitHub login the desktop app knows: the place's author, and create's.
  const known = setup({ newProjects: PLACES, author: () => ({ name: "Jane-Dev", from: "github" }) });
  assert.deepEqual((await known.call("projects.place", { folder: "x" })).author, { name: "Jane-Dev", from: "github" });
  assert.equal((await known.call("projects.place", { folder: "x" })).namespace, "jane-dev");
});

test("github.name, which needs no gesture, cannot spend the person's GitHub quota in a loop: one check at a time per name, answers kept, a limit a minute (audit H11)", async () => {
  let t = 1_000_000;
  const plans = [];
  let release = null;
  const github = { plan: async ({ name }) => (plans.push(name), release ? await new Promise((resolve) => (release = resolve)) : null, { mode: "new", name }) };
  const { call } = setup({ github, now: () => t, answers: (words) => (words[0] === "publish" ? { ok: true, id: "app.you.clock" } : { ok: true }) });
  // The same question while one is under way: one plan.
  release = true;
  const both = Promise.all([call("github.name", { folder: CLOCK, name: "clock" }), call("github.name", { folder: CLOCK, name: "clock" })]);
  await sleep(50);
  release({ mode: "new", name: "clock" });
  await both;
  release = null;
  assert.deepEqual(plans, ["clock"]);
  // Asked again at once: the kept answer; after the keep, asked anew.
  await call("github.name", { folder: CLOCK, name: "clock" });
  assert.deepEqual(plans, ["clock"]);
  t += NAME_CHECK_KEEP_MS;
  await call("github.name", { folder: CLOCK, name: "clock" });
  assert.equal(plans.length, 2);
  // A page asking name after name: at most NAME_CHECKS_A_MINUTE new checks a minute, then a refusal; a minute later, again.
  for (let i = 0; plans.length < NAME_CHECKS_A_MINUTE; i++) await call("github.name", { folder: CLOCK, name: `n${i}` });
  const refused = await call("github.name", { folder: CLOCK, name: "one-too-many" });
  assert.equal(refused.rejected?.code ?? refused.code, "too_often");
  assert.equal(plans.length, NAME_CHECKS_A_MINUTE);
  t += 60_001;
  await call("github.name", { folder: CLOCK, name: "one-too-many" });
  assert.equal(plans.at(-1), "one-too-many");
  // And an hourly cap: a page that keeps to the minute's limit still stops at NAME_CHECKS_AN_HOUR (F4).
  for (let i = 0; plans.length < NAME_CHECKS_AN_HOUR; i++) {
    if (i % NAME_CHECKS_A_MINUTE === 0) t += 60_001;
    await call("github.name", { folder: CLOCK, name: `h${i}` });
  }
  t += 60_001;
  const hourly = await call("github.name", { folder: CLOCK, name: "past-the-hour" });
  assert.match(hourly.rejected?.message ?? hourly.message, /last hour/);
  assert.equal(plans.length, NAME_CHECKS_AN_HOUR);
});

test("Publish to GitHub's upload: its progress goes to the window as numbers and a path, nothing else; Cancel and the catalog's checklist need no gesture and are kept to the app's words", async () => {
  let canceled = 0;
  const asked = [];
  const github = {
    push: async ({ progress, upload }) => {
      progress("Uploading 2 files");
      upload({ phase: "upload", done: 1, total: 2, bytes: 5.7, totalBytes: 10, file: "src/main.ts", known: 3, token: "gho_never" });
      upload({ phase: "evil", done: -4, total: "x", file: { not: "text" } });
      return { owner: "octo", name: "clock", page: "https://github.com/octo/clock", commit: "a".repeat(40) };
    },
    cancel: () => (canceled++, true),
    checklist: async ({ catalog }) => (asked.push(catalog), { catalog, source: "bundled", boxes: ["One"], blocks: [], ai: [] }),
  };
  const { call, sent } = setup({ github, answers: (words) => (words[0] === "publish" ? { ok: true, id: "app.you.clock", published: [] } : { ok: true }) });
  await call("github.push", { folder: CLOCK, name: "clock" });
  const ups = sent.filter((job) => job.upload).map((job) => job.upload);
  assert.deepEqual(ups, [
    { phase: "upload", done: 1, total: 2, bytes: 5, totalBytes: 10, known: 3, file: "src/main.ts" },
    { phase: "upload", done: 0, total: 0, bytes: 0, totalBytes: 0, known: 0, file: null },
  ]);
  assert.ok(sent.some((job) => job.line === "Uploading 2 files"));
  assert.equal(JSON.stringify(sent).includes("gho_never"), false);
  const stopped = await call("github.cancel");
  assert.equal(canceled, 1, JSON.stringify(stopped));
  // The checklist: read once, then kept half a minute.
  await call("github.checklist", { catalog: "busy-app/busy-apps-catalog" });
  await call("github.checklist", { catalog: "busy-app/busy-apps-catalog" });
  assert.deepEqual(asked, ["busy-app/busy-apps-catalog"]);
  const refused = await call("github.request", { folder: CLOCK, catalog: "busy-app/busy-apps-catalog", author: true, ai: "none" });
  assert.equal(refused.rejected?.code ?? refused.code, "not_ticked");
});

test("Import from GitHub: downloaded by the flow into a free folder of the place, noted as imported, then opened as Open existing opens a project; a repository with no app is downloaded and said (catalog-update)", async () => {
  const places = path.join(root, "import-places");
  mkdirSync(path.join(places, "clock"), { recursive: true });
  const notes = [];
  const github = {
    record: { imported: (folder, repo) => notes.push([folder, repo]) },
    download: async ({ repo, folder, progress, upload }) => {
      assert.equal(repo, "octo/clock");
      progress("Downloading 2 files");
      upload({ phase: "download", done: 1, total: 2, bytes: 3, totalBytes: 6, file: "src/main.ts" });
      mkdirSync(path.join(folder, "src", "appmeta"), { recursive: true });
      writeFileSync(path.join(folder, "package.json"), JSON.stringify({ devDependencies: { "@busy-app/cli": "0.6.0" } }));
      writeFileSync(path.join(folder, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.octo.clock", name: "Clock" }));
      return { owner: "octo", name: "clock", page: "https://github.com/octo/clock", commit: "c".repeat(40), folder, files: 2, skipped: [] };
    },
  };
  const target = path.join(places, "clock-2");
  // The real folders of this system: its own path rules.
  const it = setup({ platform: process.platform, newProjects: places, projects: [], github, answers: (words) => (words[0] === "trust" ? { ok: true } : words[0] === "projects" ? (it.state.projects.push(entry(target, { id: "app.octo.clock" })), { ok: true, added: target }) : words[0] === "dev" ? { ok: true, id: "app.octo.clock", running: true } : { ok: true }) });
  assert.equal((await it.call("github.import", { repo: "octo/clock", place: { parent: "/etc", folder: "clock" } })).rejected.code, "usage", "only a place the person chose");
  const opened = await it.call("github.import", { repo: "octo/clock", place: { parent: places, folder: "clock" } });
  assert.deepEqual([opened.folder, opened.imported.commit, opened.refreshed?.ok], [target, "c".repeat(40), true]);
  assert.deepEqual(notes, [[target, { owner: "octo", name: "clock", commit: "c".repeat(40) }]]);
  assert.deepEqual(it.work(), [`trust ${target} --wait 600 --json`, `projects --add ${target} --json`, `dev ${target} --once --json --progress`]);
  assert.deepEqual(it.sent.filter((job) => job.kind === "import").map((job) => [job.state, job.line ?? job.upload?.phase ?? null]), [["running", null], ["running", "Downloading 2 files"], ["running", "download"], ["done", null]]);
  // No app at the top of the repository: downloaded, said, not opened.
  const plain = { record: { imported: () => {} }, download: async ({ folder }) => (mkdirSync(folder, { recursive: true }), writeFileSync(path.join(folder, "README.md"), "# x\n"), { owner: "octo", name: "notes", page: "https://github.com/octo/notes", commit: "d".repeat(40), folder, files: 1, skipped: [] }) };
  const other = setup({ platform: process.platform, newProjects: places, projects: [], github: plain });
  const said = await other.call("github.import", { repo: "octo/notes", place: { parent: places, folder: "notes" } });
  assert.equal(said.code ?? said.rejected?.code, "not_an_app");
  // One full stop at the end, also when the reason has its own (a repository of a bar app made without busy-cli, 12.11).
  assert.match(said.message ?? said.rejected?.message, /it is no BUSY Bar app project: No BUSY app found in this folder or above it\.$/);
  assert.doesNotMatch(said.message ?? said.rejected?.message, /\.\./);
  assert.deepEqual(other.work(), [], "nothing opened");
});

test("github.request: a checklist past 50 items or 500 characters an item is refused with why; a confirmed catalog's name goes to the flow (security review L3, L9)", async () => {
  const given = [];
  const github = { request: async (o) => (given.push([o.catalog, o.otherCatalog, o.ticked.length]), { url: "https://github.com/attacker/catalog/pull/1", catalog: o.catalog }) };
  const it = setup({ github, answers: (words) => (words[0] === "publish" ? { ok: true, id: "app.you.clock", published: [] } : { ok: true }) });
  const many = await it.call("github.request", { folder: CLOCK, catalog: "attacker/catalog", ticked: Array.from({ length: 51 }, (_, i) => `Item ${i}`), ai: "none" });
  assert.deepEqual([many.code, many.message, many.hint], ["checklist_too_long", "The emulator sends a checklist of up to 50 items of up to 500 characters each.", "Send the app by hand (SUBMIT.md)."]);
  const long = await it.call("github.request", { folder: CLOCK, catalog: "attacker/catalog", ticked: ["x".repeat(501)], ai: "none" });
  assert.equal(long.code, "checklist_too_long");
  assert.equal((await it.call("github.request", { folder: CLOCK, catalog: "attacker/catalog", ticked: [], ai: "none", otherCatalog: 7 })).code, "usage");
  assert.deepEqual(given, [], "nothing reached the flow");
  await it.call("github.request", { folder: CLOCK, catalog: "attacker/catalog", ticked: ["x".repeat(500)], ai: "none", otherCatalog: "attacker/catalog" });
  await it.call("github.request", { folder: CLOCK, catalog: "busy-app/busy-apps-catalog", ticked: [], ai: "none" });
  assert.deepEqual(given, [["attacker/catalog", "attacker/catalog", 1], ["busy-app/busy-apps-catalog", null, 0]]);
});

test("github.request with What's new: written into catalog.json by the catalog's rules first, then given to the flow (catalog-update)", async () => {
  const given = [];
  const github = { request: async (o) => (given.push(o.changelog), { url: "https://github.com/busy-app/busy-apps-catalog/pull/1", catalog: "busy-app/busy-apps-catalog" }) };
  let problem = null;
  const it = setup({ github, answers: (words) => (words[0] === "catalog-texts" ? { ok: true, problems: { changelog: problem } } : words[0] === "publish" ? { ok: true, id: "app.you.clock", published: [] } : { ok: true }) });
  problem = "10 characters at least";
  const bad = await it.call("github.request", { folder: CLOCK, catalog: "busy-app/busy-apps-catalog", ticked: [], ai: "none", changelog: " short " });
  assert.equal(bad.code ?? bad.rejected?.code, "bad_changelog");
  assert.deepEqual(given, []);
  problem = null;
  await it.call("github.request", { folder: CLOCK, catalog: "busy-app/busy-apps-catalog", ticked: [], ai: "none", changelog: " Alarms, and a dimmer. " });
  assert.deepEqual(given, ["Alarms, and a dimmer."]);
  assert.ok(it.work().includes(`catalog-texts set ${CLOCK} --changelog=Alarms, and a dimmer. --json`));
});

test("stale-check: Publish to GitHub and Send to catalog ask publish verify first, and send nothing when the project changed since the check", async () => {
  const pushed = [];
  const github = {
    push: async (o) => (pushed.push(o), { owner: "octo", name: "clock", page: "https://github.com/octo/clock", commit: "a".repeat(40), files: 1 }),
    request: async () => ({ url: "https://github.com/busy-app/busy-apps-catalog/pull/1", catalog: "busy-app/busy-apps-catalog" }),
  };
  let verify = { ok: false, code: "changed_since_check", message: "The project changed since Pre-flight check (src/main.ts), so nothing is sent: GitHub gets only what was checked.", hint: "Run the check again." };
  const it = setup({ github, answers: (words) => (words[0] === "publish" && words[1] === "verify" ? verify : words[0] === "publish" ? { ok: true, id: "app.you.clock", published: [] } : { ok: true }) });
  const refused = await it.call("github.push", { folder: CLOCK, name: "clock" });
  assert.deepEqual([refused.code, refused.message], ["changed_since_check", verify.message]);
  assert.deepEqual(pushed, [], "the flow was not asked to push");
  const notSent = await it.call("github.request", { folder: CLOCK, catalog: "busy-app/busy-apps-catalog", ticked: [], ai: "none", changelog: "Alarms, and a dimmer." });
  assert.equal(notSent.code, "changed_since_check");
  assert.equal(it.work().some((one) => one.startsWith("catalog-texts set")), false, "What's new is not written either");
  // As checked: the flow gets a verify of its own, which asks again right before the upload.
  verify = { ok: true, checked: true, files: { "src/main.ts": "1:x" } };
  await it.call("github.push", { folder: CLOCK, name: "clock" });
  assert.equal(pushed.length, 1);
  assert.deepEqual((await pushed[0].verify()).files, { "src/main.ts": "1:x" });
  verify = { ok: false, code: "changed_since_check", message: "Changed.", hint: null };
  await assert.rejects(pushed[0].verify(), { code: "changed_since_check" });
  // What's new written by the flow: the check follows that one write.
  verify = { ok: true, checked: true, files: {} };
  await it.call("github.request", { folder: CLOCK, catalog: "busy-app/busy-apps-catalog", ticked: [], ai: "none", changelog: "Alarms, and a dimmer." });
  assert.ok(it.work().includes(`publish verify ${CLOCK} --renew=catalog.json --json`), it.work().join("\n"));
});
