// window.emulatorActions (actions.js), run as the page runs it: in a plain browser it says that the app is not there
// and every action rejects; in the app's main window every action goes to the bridge under its name, with one
// argument at most, and the bridge's answers come back as values and failures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../legacy-window/actions.js", import.meta.url), "utf8");

function page(busyShell) {
  const window = busyShell === undefined ? {} : { busyShell };
  vm.runInNewContext(source, { window, console: { error: () => {} } });
  return window.emulatorActions;
}

/** Every action of the contract, as the page calls it. */
const CALLS = {
  "projects.list": (a) => a.projects.list(),
  "projects.examples": (a) => a.projects.examples(),
  "projects.create": (a) => a.projects.create({ example: "focus-timer" }),
  "projects.open": (a) => a.projects.open(),
  "projects.refresh": (a) => a.projects.refresh("/p"),
  "projects.build": (a) => a.projects.build("/p"),
  "projects.run": (a) => a.projects.run("/p"),
  "projects.stop": (a) => a.projects.stop("/p"),
  "projects.dev.start": (a) => a.projects.dev.start("/p"),
  "projects.dev.stop": (a) => a.projects.dev.stop("/p"),
  "projects.check": (a) => a.projects.check("/p"),
  "projects.submit": (a) => a.projects.submit("/p"),
  "apps.delete": (a) => a.apps.delete({ id: "app.you.clock", withFiles: true }),
  reveal: (a) => a.reveal("/p"),
  copy: (a) => a.copy("text"),
};

test("in a plain browser: available() says there is no shell, and every action rejects with a message that says why", async () => {
  for (const shell of [undefined, null, {}, { action: "not a function" }]) {
    const actions = page(shell);
    assert.deepEqual({ ...actions.available() }, { shell: false });
    for (const [name, call] of Object.entries(CALLS)) {
      await assert.rejects(call(actions), (e) => e.code === "no_shell" && e.message === "This works in the BUSY Bar Emulator app, not in a browser.", name);
    }
    // Listening is harmless there: nothing ever comes.
    assert.equal(typeof actions.on("job", () => {}), "function");
  }
});

test("in the app's main window: every action of the contract goes to the bridge under its own name", async () => {
  const asked = [];
  // What the page passes is of the page's world: copied here, as it is copied on its way to the main process.
  const actions = page({ action: async (name, arg) => (asked.push([name, arg === undefined ? undefined : JSON.parse(JSON.stringify(arg))]), { ok: true, value: name }), onJob: () => {} });
  assert.deepEqual({ ...actions.available() }, { shell: true });
  for (const [name, call] of Object.entries(CALLS)) assert.equal(await call(actions), name);
  assert.deepEqual(asked.map(([name]) => name), Object.keys(CALLS));
  assert.deepEqual(asked.map(([, arg]) => arg).filter((arg) => arg !== undefined), [{ example: "focus-timer" }, "/p", "/p", "/p", "/p", "/p", "/p", "/p", "/p", { id: "app.you.clock", withFiles: true }, "/p", "text"]);
  // create passes the example's name and nothing else the page gave: no folder.
  asked.length = 0;
  await actions.projects.create({ example: null, folder: "/etc", trust: true });
  await actions.projects.create();
  assert.deepEqual(asked, [["projects.create", { example: null }], ["projects.create", { example: null }]]);
});

test("the bridge's answers: a value resolves, a failure rejects with its code and hint, a refusal of the bridge rejects too", async () => {
  const answers = {
    "projects.list": { ok: true, value: [{ id: "app.you.clock" }] },
    "projects.build": { ok: true, value: { ok: false, code: "busy", message: "The project is busy." } },
    "projects.open": { ok: false, error: { code: "not_a_project", message: "It is not an app project.", hint: "Choose another." } },
    "projects.examples": { ok: false },
  };
  const actions = page({
    action: async (name) => {
      if (name === "copy") throw new Error("Error invoking remote method 'busy-shell': Error: This page may not ask the app for that.");
      return answers[name];
    },
    onJob: () => {},
  });
  assert.deepEqual(await actions.projects.list(), [{ id: "app.you.clock" }]);
  assert.deepEqual(await actions.projects.build("/p"), { ok: false, code: "busy", message: "The project is busy." });
  await assert.rejects(actions.projects.open(), (e) => e.message === "It is not an app project." && e.code === "not_a_project" && e.hint === "Choose another.");
  await assert.rejects(actions.projects.examples(), (e) => e.message === "The emulator's app could not do it." && e.code === "failed");
  await assert.rejects(actions.copy("x"), (e) => e.message === "The emulator's app did not take the request." && e.code === "refused");
});

test('on("job"): every listener hears every job, one that throws does not stop the others, and a listener can be taken away', () => {
  let deliver;
  const actions = page({ action: async () => ({ ok: true }), onJob: (listener) => (deliver = listener) });
  const heard = [];
  const off = actions.on("job", (job) => heard.push(["first", job.id]));
  actions.on("job", () => {
    throw new Error("a listener that fails");
  });
  actions.on("job", (job) => heard.push(["third", job.id]));
  deliver({ id: 1, kind: "build", folder: "/p", state: "running" });
  off();
  deliver({ id: 2, kind: "build", folder: "/p", state: "done" });
  assert.deepEqual(heard, [["first", 1], ["third", 1], ["third", 2]]);
  assert.throws(() => actions.on("other", () => {}), { name: "TypeError" });
  assert.throws(() => actions.on("job", "not a function"), { name: "TypeError" });
});
