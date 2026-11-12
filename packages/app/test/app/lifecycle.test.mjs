// The server's life inside the app: the window waits for it, it is started again when it dies, and nothing of it is
// left when the app quits or is killed.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { alive, CHROMIUM_GONE_WITHIN_MS, listening, occupy, PORTS, sleep, survivors, temporaryFolder, until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

let app;
afterEach(async () => {
  await app?.close();
  app = null;
});

const windowCount = () => app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length);
const starts = () => app.run((shell) => shell.keeper.starts);

// The stand-in server answers when the test lets it (a file it waits for), not after a time: what a test looks at
// before the answer is there for as long as it looks, however slow the machine. A test that is not about the page a
// slow start shows moves that page out of its way (BUSY_EMULATOR_TEST_SLOW_START_MS); the one that is about it
// lets the 2 s run as in a release.
function gatedStart() {
  const gate = path.join(temporaryFolder(), "answer-now");
  return { env: { FAKE_SERVER_WAIT_FOR: gate }, open: () => writeFileSync(gate, ""), close: () => rmSync(gate, { force: true }) };
}
const NO_SLOW_PAGE = { BUSY_EMULATOR_TEST_SLOW_START_MS: "600000" };

test("the window is shown only after the server is ready", async () => {
  const gate = gatedStart();
  app = await launch({ env: { ...gate.env, ...NO_SLOW_PAGE } });
  // The server has not answered yet: there is no window at all.
  for (let i = 0; i < 5; i++) {
    const { state, windows } = await app.run((shell, electron) => ({ state: shell.keeper.state.name, windows: electron.BrowserWindow.getAllWindows().length }));
    assert.ok(state === "starting" || state === "idle", state);
    assert.equal(windows, 0, "a window exists while the server is starting");
    await sleep(200);
  }
  assert.equal((await app.state()).name, "starting");
  gate.open();
  await app.waitWindow("device");
  assert.equal((await app.state()).name, "ready");
});

const shownMessage = () =>
  until(
    () =>
      app.page(`document.body.dataset.kind && ({
        kind: document.body.dataset.kind,
        title: document.getElementById("title").textContent,
        buttons: [...document.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent),
      })`),
    "the message",
  );

test("a start without an answer for a while shows that it is starting, and then the device window; so does a start after a death", async () => {
  const gate = gatedStart();
  app = await launch({ env: gate.env });
  await app.waitWindow("message", 30_000);
  assert.equal((await app.state()).name, "starting");
  assert.deepEqual(await shownMessage(), { kind: "starting", title: "Starting the emulator", buttons: ["Quit"] });
  gate.open();
  await app.waitWindow("device", 30_000);
  assert.equal(await windowCount(), 1);

  // The server dies once it was ready: the dead device page gives way to the starting page, then comes back.
  const pid = (await app.run((shell) => shell.keeper.pids())).server;
  gate.close();
  process.kill(pid, "SIGKILL");
  await app.waitWindow("message", 30_000);
  assert.equal((await shownMessage()).kind, "starting");
  gate.open();
  await app.waitWindow("device", 30_000);
  assert.equal(await starts(), 2);
  assert.equal(await windowCount(), 1);
  assert.equal((app.log().match(/\[shell\] server: starting \(no answer yet after 2 s\)/g) ?? []).length, 2, app.log());
});

test("launched again while the server is starting, the app shows that it is starting at once", async () => {
  // The page a slow start shows is out of the way: the one that comes can only be the second launch's.
  const gate = gatedStart();
  app = await launch({ env: { ...gate.env, ...NO_SLOW_PAGE } });
  await app.waitState("starting");
  // As the system tells the first copy of a second launch (single-instance.test.mjs makes a real one).
  await app.run((_shell, electron) => void electron.app.emit("second-instance", {}, [], "", null));
  await app.waitWindow("message", 30_000);
  assert.equal((await app.state()).name, "starting");
  assert.equal((await app.state()).slow, undefined, "the starting page came from the wait, not from the second launch");
  assert.match(app.log(), /\[shell\] launched again: the window comes to the front \(server: starting\)/);
  gate.open();
  await app.waitWindow("device", 30_000);
});

test("the server is killed: it is started again and the window works, with nobody touching it", { skip: !HAS_REAL_SERVER && "the server is not beside this package" }, async () => {
  app = await launch({ server: "real" });
  await app.waitWindow("device");
  const first = (await app.run((shell) => shell.keeper.pids())).server;
  assert.equal(await app.page("fetch('/api/status').then((r) => r.ok)"), true);

  process.kill(first, "SIGKILL");
  await until(async () => {
    const pids = await app.run((shell) => (shell.keeper.state.name === "ready" ? shell.keeper.pids() : null));
    return pids?.server && pids.server !== first;
  }, "the second server", 30_000);
  await app.waitWindow("device");
  assert.equal(await starts(), 2);
  assert.equal(await windowCount(), 1);
  assert.equal(await app.page("location.pathname"), "/emulator");
  assert.equal(await app.page("fetch('/api/status').then((r) => r.json()).then((s) => s.device.serial_number)"), "EMULATOR");
  assert.equal(alive(first), false);
  // The second server took the data folder the killed one held: one data folder, laid out as architecture.md section
  // 4 says (EMU-005), its lock now the second server's.
  for (const entry of ["format", path.join("bar", "1.3.1", "ext", "user_assets")]) assert.ok(existsSync(path.join(app.folder, entry)), entry);
  assert.ok(!existsSync(path.join(app.folder, "bar", "bar")), "not a data folder inside bar/");
  const second = (await app.run((shell) => shell.keeper.pids())).server;
  assert.equal(JSON.parse(readFileSync(path.join(app.folder, "run", "server.lock"), "utf8")).pid, second);
});

test("the third death within a minute: no more restarts, and the app's own page says where the log is", async () => {
  app = await launch();
  await app.waitWindow("device");
  for (let death = 1; death <= 3; death++) {
    const pid = await until(() => app.run((shell) => (shell.keeper.state.name === "ready" ? shell.keeper.pids()?.server : null)), `server ${death}`);
    process.kill(pid, "SIGKILL");
    await until(async () => (await app.run((shell) => shell.keeper.pids()?.server ?? null)) !== pid, `the end of server ${death}`);
  }
  await app.waitWindow("message");
  assert.equal((await app.state()).name, "gave-up");
  assert.equal(await starts(), 3);
  const shown = await until(() => app.page(`document.body.dataset.kind && ({ origin: location.origin, title: document.getElementById("title").textContent, text: document.getElementById("text").textContent })`), "the message");
  assert.equal(shown.origin, "app://shell");
  assert.equal(shown.title, "The emulator keeps stopping");
  assert.ok(shown.text.includes(`The log is at ${app.logFile}`), shown.text);
  await sleep(700);
  assert.equal(await starts(), 3, "the server was started a fourth time");
  assert.equal(await listening(app.port), false);
  assert.equal(await windowCount(), 1);
});

test("the port is in use: a message, not a round of restarts; Try again works once the port is free", async () => {
  const other = await occupy(PORTS.app);
  try {
    app = await launch();
    await app.waitWindow("message");
    assert.equal((await app.state()).name, "port-busy");
    const shown = await until(() => app.page(`document.body.dataset.kind && ({ origin: location.origin, title: document.getElementById("title").textContent, text: document.getElementById("text").textContent })`), "the message");
    assert.deepEqual([shown.origin, shown.title], ["app://shell", `Port ${PORTS.app} is in use`]);
    assert.ok(shown.text.includes(`127.0.0.1:${PORTS.app}`), shown.text);
    await sleep(700);
    assert.equal(await starts(), 0, "the server was started although the port was taken");
    assert.equal((await app.state()).name, "port-busy");
  } finally {
    await other.close();
  }
  await app.page(`document.getElementById("retry").click()`);
  await app.waitWindow("device");
  assert.equal(await starts(), 1);
});

test("quit stops the server and everything it started: no process is left", async () => {
  app = await launch({ env: { FAKE_SERVER_CHILD: "1" } });
  await app.waitWindow("device");
  const { pid, child } = await app.fakeReport();
  const { supervisor, server } = await app.run((shell) => shell.keeper.pids());
  assert.equal(server, pid);
  const all = await app.pids();
  assert.ok(all.length >= 6, `expected the app's own processes, the supervisor, the server and its child: ${all}`);
  for (const one of [app.pid, supervisor, pid, child]) assert.ok(alive(one));

  const end = await app.quit();
  assert.equal(end.code, 0);
  assert.deepEqual(await survivors([supervisor, pid, child]), [], "the supervisor, the server or its child outlived the quit");
  assert.deepEqual(await survivors(all, CHROMIUM_GONE_WITHIN_MS), []);
  assert.equal(await listening(app.port), false);
  assert.match(app.log(), /\[shell\] quitting\n.*\[shell\] server: stopped/s);
});

test("quit with the real server leaves nothing either", { skip: !HAS_REAL_SERVER && "the server is not beside this package" }, async () => {
  app = await launch({ server: "real" });
  await app.waitWindow("device");
  const all = await app.pids();
  const end = await app.quit();
  assert.equal(end.code, 0);
  assert.deepEqual(await survivors(all, CHROMIUM_GONE_WITHIN_MS), []);
  assert.equal(await listening(app.port), false);
});

test("closing the window on Windows, or a terminate signal elsewhere, is a full quit too", async () => {
  app = await launch({ env: { FAKE_SERVER_CHILD: "1" } });
  await app.waitWindow("device");
  await app.fakeReport();
  const all = await app.pids();
  if (process.platform === "win32") await app.run((shell) => void setImmediate(() => shell.windows.current.win.close()));
  else process.kill(app.pid, "SIGTERM");
  const end = await app.exited;
  assert.equal(end.code, 0);
  assert.deepEqual(await survivors(all, CHROMIUM_GONE_WITHIN_MS), []);
  assert.equal(await listening(app.port), false);
});

test("the shell is killed: the server and everything it started end by themselves", async () => {
  app = await launch({ env: { FAKE_SERVER_CHILD: "1" } });
  await app.waitWindow("device");
  const { pid, child } = await app.fakeReport();
  const { supervisor } = await app.run((shell) => shell.keeper.pids());
  const all = await app.pids();

  process.kill(app.pid, "SIGKILL");
  await app.exited;
  assert.deepEqual(await survivors([supervisor, pid, child]), [], "the supervisor, the server or its child outlived the shell");
  assert.deepEqual(await survivors(all, CHROMIUM_GONE_WITHIN_MS), [], "a process of the app outlived the shell");
  assert.equal(await listening(app.port), false);
});
