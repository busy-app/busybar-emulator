// The console's "Open in Terminal" / "Open in cmd" in the running app with the real server (terminal.mjs): who may ask,
// the click it needs, and what the page's button asks for. No terminal opens: the app runs hidden, and a hidden run
// keeps what it would have opened in shell.offScreen.terminals. A run from the source folder has no busy-emulator
// launcher, so its terminal is not available; for the click through the page the test gives the shell's terminal a
// stand-in launcher file.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { HAS_REAL_SERVER, removeFolder, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const TERMINAL_MODULE = new URL("../../src/terminal.mjs", import.meta.url).href;
const label = process.platform === "win32" ? "Open in cmd" : "Open in Terminal";

const bare = (app, code) => app.page(`(${code}).then((value) => ({ value }), (e) => ({ error: { code: e.code, message: e.message } }))`);

let app;
let work;
before(async () => {
  if (skip) return;
  work = temporaryFolder();
  app = await launch({ server: "real" });
  await app.waitWindow("device");
});
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

test("without a launcher the terminal is not available and says why; asked anyway, nothing opens: no_gesture without a click, no_cli with one", { skip }, async () => {
  const info = (await bare(app, "window.emulatorActions.terminalInfo()")).value;
  assert.deepEqual([info.available, info.label], [false, label]);
  assert.match(info.why, /busy-emulator command/);
  const asked = 'window.emulatorActions.openTerminal({ app: null, folder: null, kinds: ["console"], since: null })';
  assert.equal((await bare(app, asked)).error.code, "no_gesture");
  await app.press();
  assert.equal((await bare(app, asked)).error.code, "no_cli");
  // The button says it too.
  assert.deepEqual(await app.page('(() => { const b = document.querySelector("#open-terminal"); return [b.ariaDisabled, b.title]; })()'), ["true", `${label}: ${info.why}`]);
  assert.deepEqual(await app.run((shell) => shell.offScreen.terminals), []);
});

test("a click on the button asks for the console as the window shows it; the shell checks it against the emulator's own lists", { skip }, async () => {
  const cli = path.join(work, "busy-emulator");
  writeFileSync(cli, "");
  // The shell's terminal with a launcher there; the rest as the app has it: its list of projects, a hidden run's record.
  await app.run(
    async (shell, _electron, { module, cli }) => {
      const { createTerminal } = await import(module);
      shell.terminal = createTerminal({
        platform: process.platform,
        cli,
        projects: async () => (await shell.actions.call("projects.list")).value,
        barApps: async () => [],
        launch: (plan) => void shell.offScreen.terminals.push(plan),
        log: () => {},
      });
    },
    { module: TERMINAL_MODULE, cli },
  );
  // The page asks whether there is a terminal when it loads. The old document is marked first, so that the wait below
  // is answered by the reloaded one only: Clear pressed on the old document is lost with it. The wait also takes the
  // server's "hello" on the page's events (the link says Connected): that clears the console and its start, so a
  // Clear pressed before it is undone, and the button then asks for the console without a start (--lines instead of
  // --since; the button can be on before "hello" comes).
  await app.page("window.__terminalTestOld = true");
  await app.run((shell) => shell.windows.current.win.webContents.reload());
  const ready = 'window.__terminalTestOld ? "old" : !document.querySelector("#link")?.classList.contains("live") ? "not connected" : (document.querySelector("#open-terminal")?.ariaDisabled ?? "none")';
  await until(async () => (await app.page(ready).catch(() => "none")) === "false", 30_000);
  // The page's clock, not this process's: on Windows Chromium's clock may run some milliseconds ahead of Node's.
  const cleared = await app.page('(() => { window.__terminalTestCleared = true; document.querySelector("#clear").click(); return Date.now(); })()');
  await app.click("#open-terminal");
  assert.equal(await app.page("window.__terminalTestCleared === true"), true, "the page the button was clicked on is the one Clear was pressed on");
  await until(async () => (await app.run((shell) => shell.offScreen.terminals.length)) === 1, 10_000);
  const [plan] = await app.run((shell) => shell.offScreen.terminals);
  assert.equal(plan.cli, cli);
  assert.equal(plan.folder, null, "no project is chosen");
  // Lifecycle and Build are on when the window opens, System is off; what apps print is always shown.
  assert.deepEqual(plan.words.slice(0, 5), ["logs", "--follow", "--all", "--kind", "console,lifecycle,build"]);
  assert.equal(plan.words[5], "--since");
  assert.ok(Number(plan.words[6]) <= cleared && Number(plan.words[6]) > cleared - 60_000, plan.words[6]);
  // A folder or an app the emulator does not have is refused, a click or not.
  await app.press();
  assert.equal((await bare(app, `window.emulatorActions.openTerminal({ app: null, folder: ${JSON.stringify(work)}, kinds: ["console"], since: null })`)).error.code, "unknown_project");
  await app.press();
  assert.equal((await bare(app, 'window.emulatorActions.openTerminal({ app: "app.nobody.has", folder: null, kinds: ["console"], since: null })')).error.code, "unknown_app");
  assert.equal((await app.run((shell) => shell.offScreen.terminals)).length, 1);
});
