// The question only the person may answer (person-question.mjs): whether they trust a project folder. What the dialog
// says and which button is the default; that a release never takes the tests' stand-in for the click; that a hidden
// run asks nobody; and the question's way from the server to the shell and back over the supervisor's channel.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { resolveConfig } from "../../src/config.mjs";
import { createPersonQuestions, LOCAL_PORT_DIALOG, TOO_SOON_LIMIT, TRUST_DIALOG, TRUST_NOT_BEFORE_MS } from "../../src/person-question.mjs";
import { startServerProcess } from "../../src/server-process.mjs";
import { FAKE_SERVER, listening, NODE, PORTS, removeFolder, SUPERVISOR, survivors, temporaryFolder, until } from "../helpers.mjs";

const FOLDER = "/Users/you/code/stranger's app";
const QUESTION = { kind: "trust-folder", path: FOLDER };
const base = { platform: "darwin", appDir: "/Applications/BUSY Bar Emulator.app/Contents/Resources/app.asar", appDataDir: "/Users/you/Library/Application Support", homeDir: "/Users/you" };
const STAND_IN = { BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust", BUSY_EMULATOR_HIDDEN: "1" };

const WINDOW = { the: "main window" };

/**
 * The questions with a dialog that records what it was shown and answers `response` (a button's index, or a function
 * of the options), a clock the dialog moves on by `takes` ms, and a window to hang on (`win`: null for none).
 */
function questions(config, response = TRUST_DIALOG.refuse, { win = WINDOW, takes = 5000 } = {}) {
  const shown = [];
  const parents = [];
  const log = [];
  let clock = 1_000_000;
  let asked = 0;
  const ask = createPersonQuestions({
    windowFor: async () => (asked++, win),
    showMessageBox: async (parent, options) => {
      parents.push(parent);
      shown.push(options);
      const answer = typeof response === "function" ? await response(options, shown.length) : { response };
      clock += typeof takes === "function" ? takes(shown.length) : takes;
      return answer;
    },
    config,
    appName: "BUSY Bar Emulator",
    log: (line) => log.push(line),
    now: () => clock,
  });
  return { ask, shown, parents, log, windowAsked: () => asked };
}
const visible = { hidden: false, testTrustAnswer: null };

test("the dialog names the folder and what trusting it means; Don't Trust is the default and what closing it means", async () => {
  const { ask, shown, parents, windowAsked } = questions(visible, TRUST_DIALOG.trust);
  assert.deepEqual(await ask(QUESTION), { answer: "trust" });
  assert.equal(shown.length, 1);
  const [dialog] = shown;
  assert.equal(dialog.message, "Trust this project folder?");
  assert.ok(dialog.detail.startsWith(`${FOLDER}\n`), "the folder's path, as it was given, on a line of its own");
  assert.match(dialog.detail, /Building it runs code from the folder on this computer/);
  assert.deepEqual(dialog.buttons, ["Don't Trust", "Trust"]);
  assert.equal(dialog.buttons[dialog.defaultId], "Don't Trust");
  assert.equal(dialog.buttons[dialog.cancelId], "Don't Trust");
  assert.equal(dialog.type, "question");
  assert.equal(windowAsked(), 1, "the main window was brought up for the question");
  assert.deepEqual(parents, [WINDOW], "the dialog hangs on the main window");
});

test("a port of this computer for apps on the BUSY Bar (allow-local) is the person's too: Don't Allow is the default, a quick Allow is not taken", async () => {
  const PORT = { kind: "local-port", port: 5432 };
  const { ask, shown, parents } = questions(visible, LOCAL_PORT_DIALOG.allow);
  assert.deepEqual(await ask(PORT), { answer: "allow" });
  const [dialog] = shown;
  assert.equal(dialog.message, "Let apps on the BUSY Bar reach port 5432 of this computer?");
  assert.match(dialog.detail, /busy-emulator allow-local 5432/);
  assert.match(dialog.detail, /until the emulator quits/);
  assert.deepEqual(dialog.buttons, ["Don't Allow", "Allow"]);
  assert.equal(dialog.buttons[dialog.defaultId], "Don't Allow");
  assert.equal(dialog.buttons[dialog.cancelId], "Don't Allow");
  assert.deepEqual(parents, [WINDOW]);
  for (const response of [LOCAL_PORT_DIALOG.refuse, -1, undefined]) assert.deepEqual(await questions(visible, response).ask(PORT), { answer: "refuse" }, String(response));
  const quick = questions(visible, LOCAL_PORT_DIALOG.allow, { takes: 20 });
  assert.equal((await quick.ask(PORT)).answer, "unavailable");
  assert.equal(quick.shown.length, TOO_SOON_LIMIT);
  // The stand-in of the test variant answers it as it answers trust; a port that is not one is no question.
  assert.deepEqual(await questions({ hidden: true, testTrustAnswer: "trust" }).ask(PORT), { answer: "allow" });
  assert.deepEqual(await questions({ hidden: true, testTrustAnswer: "refuse" }).ask(PORT), { answer: "refuse" });
  for (const port of [0, 70000, "5432", 1.5]) assert.equal((await questions(visible, LOCAL_PORT_DIALOG.allow).ask({ kind: "local-port", port })).answer, "unavailable", String(port));
});

test("without a window to hang it on the question is not asked: a dialog of its own could not be taken away", async () => {
  // macOS: `signal` does nothing for a message box without a parent, so after the time is over the dialog would
  // stay, a late Trust would land on a request that is gone, and later questions would wait behind it.
  const { ask, shown, log } = questions(visible, TRUST_DIALOG.trust, { win: null });
  assert.deepEqual(await ask(QUESTION), { answer: "unavailable", reason: "the emulator has no window on the screen to show the question in" });
  assert.equal(shown.length, 0);
  assert.match(log.at(-1), /not asked, the app has no window to show it in$/);
  // The next question is not stuck behind it.
  assert.deepEqual(await questions(visible, TRUST_DIALOG.trust).ask(QUESTION), { answer: "trust" });
});

test("only the Trust button trusts: Don't Trust, a closed dialog and anything else refuse", async () => {
  for (const response of [TRUST_DIALOG.refuse, -1, 2, undefined, "1"]) {
    assert.deepEqual(await questions(visible, response).ask(QUESTION), { answer: "refuse" }, String(response));
  }
  // A dialog that fails asked nobody.
  const failing = questions(visible, () => Promise.reject(new Error("no display")));
  assert.deepEqual(await failing.ask(QUESTION), { answer: "unavailable", reason: "the dialog could not be shown" });
});

test("a Trust within a second of the dialog's appearing is not taken: the question is shown again, three times at most", async () => {
  // The dialog took the focus from what the person was doing; their click or key landed on it.
  const once = questions(visible, TRUST_DIALOG.trust, { takes: (show) => (show === 1 ? 300 : 4000) });
  assert.deepEqual(await once.ask(QUESTION), { answer: "trust" }, "the second, considered Trust is taken");
  assert.equal(once.shown.length, 2);
  assert.ok(once.log.some((line) => / a Trust 300 ms after the dialog appeared is not taken$/.test(line)), once.log.join("\n"));
  // Just under and just at the second.
  const under = questions(visible, TRUST_DIALOG.trust, { takes: (show) => (show === 1 ? TRUST_NOT_BEFORE_MS - 1 : 4000) });
  await under.ask(QUESTION);
  assert.equal(under.shown.length, 2);
  const exact = questions(visible, TRUST_DIALOG.trust, { takes: TRUST_NOT_BEFORE_MS });
  assert.deepEqual(await exact.ask(QUESTION), { answer: "trust" });
  assert.equal(exact.shown.length, 1);
  // A program that clicks at once, every time: nothing is trusted.
  const always = questions(visible, TRUST_DIALOG.trust, { takes: 20 });
  assert.equal((await always.ask(QUESTION)).answer, "unavailable");
  assert.equal(always.shown.length, TOO_SOON_LIMIT);
  // A quick Don't Trust is taken at once: that way it is safe.
  const no = questions(visible, TRUST_DIALOG.refuse, { takes: 20 });
  assert.deepEqual(await no.ask(QUESTION), { answer: "refuse" });
  assert.equal(no.shown.length, 1);
  // A quick Trust, then a considered Don't Trust.
  const changed = questions(visible, (_options, show) => ({ response: show === 1 ? TRUST_DIALOG.trust : TRUST_DIALOG.refuse }), { takes: (show) => (show === 1 ? 100 : 3000) });
  assert.deepEqual(await changed.ask(QUESTION), { answer: "refuse" });
});

test("a release never reads the tests' stand-in for the click: only its dialog answers", async () => {
  const release = resolveConfig({ ...base, env: STAND_IN, kind: "release", testVariant: false });
  assert.equal(release.testTrustAnswer, null);
  assert.equal(release.hidden, false);
  const { ask, shown } = questions(release);
  assert.deepEqual(await ask(QUESTION), { answer: "refuse" }, "the dialog's own default, not the stand-in's trust");
  assert.equal(shown.length, 1, "the person was asked");
  // A release that somehow carries the test variant's folder reads it no more.
  assert.equal(resolveConfig({ ...base, env: STAND_IN, kind: "release", testVariant: true }).testTrustAnswer, null);
});

test("the test variant takes the stand-in, trust or refuse and nothing else, and shows no dialog for it", async () => {
  for (const [value, answer] of [["trust", "trust"], ["refuse", "refuse"]]) {
    const config = resolveConfig({ ...base, env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: value, BUSY_EMULATOR_HIDDEN: "1" }, kind: "test", testVariant: true });
    assert.equal(config.testTrustAnswer, value);
    const { ask, shown } = questions(config);
    assert.deepEqual(await ask(QUESTION), { answer });
    assert.equal(shown.length, 0);
  }
  for (const value of ["yes", "1", "TRUST", ""]) {
    assert.equal(resolveConfig({ ...base, env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: value }, kind: "test", testVariant: true }).testTrustAnswer, null, value);
  }
});

test("a hidden run asks nobody and trusts nothing; an unknown question is not asked", async () => {
  const hidden = questions({ hidden: true, testTrustAnswer: null }, TRUST_DIALOG.trust);
  assert.deepEqual(await hidden.ask(QUESTION), { answer: "unavailable", reason: "the emulator runs hidden and shows no dialog" });
  assert.equal(hidden.shown.length, 0);
  assert.equal(hidden.windowAsked(), 0, "no window is brought up either");
  const { ask, shown } = questions(visible, TRUST_DIALOG.trust);
  for (const question of [null, {}, { kind: "delete-everything", path: FOLDER }, { kind: "trust-folder" }, { kind: "trust-folder", path: "" }, { kind: "trust-folder", path: 7 }]) {
    assert.equal((await ask(question)).answer, "unavailable", JSON.stringify(question));
  }
  assert.equal(shown.length, 0);
});

test("one question at a time; a question taken away was not answered, whatever the closing dialog returned", async () => {
  let release;
  const { ask, shown } = questions(visible, () => new Promise((resolve) => (release = resolve)));
  const first = ask(QUESTION);
  await until(() => shown.length === 1, "the dialog");
  assert.deepEqual(await ask({ kind: "trust-folder", path: "/other" }), { answer: "unavailable", reason: "another question is open" });
  release({ response: TRUST_DIALOG.trust });
  assert.deepEqual(await first, { answer: "trust" });

  // Taken away: Electron closes the dialog and resolves with the cancel button; a "Trust" that races it is not taken either.
  const abort = new AbortController();
  const away = questions(visible, (options) => new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ response: TRUST_DIALOG.trust }))));
  const asked = away.ask(QUESTION, abort.signal);
  await until(() => away.shown.length === 1, "the dialog");
  assert.equal(away.shown[0].signal, abort.signal, "the dialog gets the signal that closes it");
  abort.abort();
  assert.deepEqual(await asked, { answer: "unavailable", reason: "the question was taken away" });
  const before = new AbortController();
  before.abort();
  assert.equal((await questions(visible, TRUST_DIALOG.trust).ask(QUESTION, before.signal)).answer, "unavailable");
});

// ------------------------------------------------- from the server to the shell and back, over the supervisor's channel

const PORT = PORTS.unit;
let folder;
let run;
beforeEach(() => {
  folder = temporaryFolder();
  run = null;
});
afterEach(async () => {
  await run?.stop();
  if (run) assert.deepEqual(await survivors([run.pid]), [], "processes left behind");
  assert.equal(await listening(PORT), false, "the port is still taken");
  await removeFolder(folder);
});

function start(onAsk) {
  return new Promise((resolve) => {
    run = startServerProcess({ nodePath: NODE, supervisorPath: SUPERVISOR, serverEntry: FAKE_SERVER, serverOptions: { port: PORT, dataDir: folder }, env: process.env, onLine: () => {}, onReady: resolve, ...(onAsk ? { onAsk } : {}) });
  });
}
const askThroughServer = async (query) => (await fetch(`http://127.0.0.1:${PORT}/ask?${query}`)).json();

test("the server's question reaches the shell with the folder, and the shell's answer goes back to the server", async () => {
  const seen = [];
  await start(async (question) => (seen.push(question), { answer: question.path.endsWith("mine") ? "trust" : "refuse" }));
  assert.deepEqual(await askThroughServer(`path=${encodeURIComponent("/code/mine")}`), { answer: "trust" });
  assert.deepEqual(await askThroughServer(`path=${encodeURIComponent("/code/theirs")}`), { answer: "refuse" });
  assert.deepEqual(seen, [{ kind: "trust-folder", path: "/code/mine" }, { kind: "trust-folder", path: "/code/theirs" }]);
});

test("a question the server takes away closes the shell's dialog; a shell that answers no questions says unavailable", async () => {
  let closed = 0;
  await start((_question, signal) => new Promise((resolve) => signal.addEventListener("abort", () => (closed++, resolve({ answer: "trust" })), { once: true })));
  const answer = await askThroughServer(`path=${encodeURIComponent("/code/x")}&cancel=200`);
  assert.equal(answer.answer, "unavailable", "the late Trust of a closed dialog is not taken");
  await until(() => closed === 1, "the shell's dialog to be closed");
  await run.stop();
  assert.deepEqual(await survivors([run.pid]), []);
  await start(null);
  assert.equal((await askThroughServer("path=%2Fcode%2Fx")).answer, "unavailable");
});

test("a folder the person opened themselves: the dialog says so, not that a program asks; only the main process can say it", async () => {
  const { ask, shown } = questions(visible, TRUST_DIALOG.trust);
  assert.deepEqual(await ask(QUESTION, undefined, { opened: true }), { answer: "trust" });
  assert.match(shown[0].detail, /^\/Users\/you\/code\/stranger's app\n\nYou opened this folder\. BUSY Bar Emulator did not create the app project in it, so it asks before it builds it\.\n\nBuilding it runs code from the folder on this computer/);
  assert.doesNotMatch(shown[0].detail, /program|agent/);
  // The same buttons and the same default: the person's own choice of a folder is not yet their trust in it.
  assert.deepEqual([shown[0].buttons, shown[0].defaultId, shown[0].cancelId], [["Don't Trust", "Trust"], TRUST_DIALOG.refuse, TRUST_DIALOG.refuse]);
  // A question that claims it itself (it comes from the server, which a program can ask) is told as a program's.
  await ask({ ...QUESTION, opened: true, by: { opened: true } });
  await ask(QUESTION, undefined, { opened: "yes" });
  await ask(QUESTION);
  for (const options of shown.slice(1)) assert.match(options.detail, /A program on this computer \(busy-emulator trust, most likely run by your coding agent\) asks/);
});

test("publishing's questions (ask.confirm) keep the trust question's rules: Cancel first and the default, a yes within a second not taken, nothing hidden or without a window, one at a time", async () => {
  const PUBLISH = { about: "publish push /p", message: "Publish?", detail: "/p", buttons: ["Cancel", "Publish"], yes: 1, checkboxLabel: "I'm the author" };
  const yes = (checked) => () => ({ response: 1, checkboxChecked: checked });
  const considered = questions(visible, yes(true), { takes: 3000 });
  assert.deepEqual(await considered.ask.confirm(PUBLISH), { answer: "yes", checked: true });
  assert.deepEqual([considered.shown[0].defaultId, considered.shown[0].cancelId, considered.shown[0].buttons, considered.shown[0].checkboxChecked], [0, 0, ["Cancel", "Publish"], false]);
  assert.equal(considered.parents[0], WINDOW, "on the main window");
  const quick = questions(visible, yes(false), { takes: (show) => (show === 1 ? 200 : 3000) });
  assert.deepEqual(await quick.ask.confirm(PUBLISH), { answer: "yes", checked: false });
  assert.equal(quick.shown.length, 2, "the quick yes was not taken: shown again");
  const always = questions(visible, yes(true), { takes: 20 });
  assert.equal((await always.ask.confirm(PUBLISH)).answer, "unavailable");
  assert.equal(always.shown.length, TOO_SOON_LIMIT);
  assert.deepEqual(await questions(visible, () => ({ response: 0 }), { takes: 20 }).ask.confirm(PUBLISH), { answer: "no" });
  assert.equal((await questions({ hidden: true, testTrustAnswer: "trust" }, yes(true)).ask.confirm(PUBLISH)).answer, "unavailable", "the trust stand-in never answers publishing");
  assert.equal((await questions(visible, yes(true), { win: null }).ask.confirm(PUBLISH)).answer, "unavailable");
  // One at a time, shared with the trust question.
  let release;
  const both = questions(visible, (options) => (options.message === TRUST_DIALOG.message ? new Promise((resolve) => (release = () => resolve({ response: TRUST_DIALOG.refuse }))) : { response: 1 }), { takes: 3000 });
  const trust = both.ask(QUESTION);
  await until(() => Boolean(release), "the trust dialog");
  assert.deepEqual(await both.ask.confirm(PUBLISH), { answer: "unavailable", reason: "another question is open" });
  release();
  await trust;
  assert.equal((await both.ask.confirm(PUBLISH)).answer, "yes");
});
