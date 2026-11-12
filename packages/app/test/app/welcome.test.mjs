// The first run's greeting (EMU-207) in the running app with the real server: shown on the first run, answered with a
// click and written down in the app's data folder, not shown on the next run, opened again from "Getting started";
// the text for agents copied as the person's click gives it, for the system the app runs on; "I'll write the code"
// goes on to the window's Create app. The text's commands themselves: packages/server/test/welcome.test.mjs.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { HAS_REAL_SERVER, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";

let data;
before(() => {
  if (!skip) data = temporaryFolder();
});
after(async () => {
  if (data) await removeFolder(data);
});

const shown = (app) => app.page(`(() => { const box = document.querySelector("#welcome"); return box && !box.hidden ? [...box.querySelectorAll(".welcome-step")].find((step) => !step.hidden)?.dataset.step : null; })()`);
const settingsOf = (folder) => {
  const file = path.join(folder, "app-settings.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};
async function ready(app) {
  await app.waitWindow("device");
  await until(() => app.page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected");
}
/** A key of the keyboard in the window, sent the way the system sends the person's input. */
const key = (app, keyCode) =>
  app.run((shell, _electron, code) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode: code });
    contents.sendInputEvent({ type: "keyUp", keyCode: code });
  }, keyCode);

test("the first run asks how the app will be made; the answer is written in the app's data folder; the text for agents is the one for this system", { skip }, async () => {
  const app = await launch({ server: "real", dataDir: data, env: { BUSY_EMULATOR_TEST_GREETED: "" } });
  try {
    await ready(app);
    await until(async () => (await shown(app)) === "ask", "the greeting");
    assert.equal(await app.page(`document.querySelector("#welcome-title").textContent`), "How will you make your app?");
    assert.deepEqual(await app.page(`[...document.querySelectorAll("#welcome .choice b")].map((b) => b.textContent)`), ["I'll write the code", "My AI agent will"]);
    // The window waits behind it.
    assert.deepEqual(await app.page(`[document.querySelector("aside.side").inert, document.querySelector("main#stage").inert]`), [true, true]);
    // Script alone writes nothing down.
    assert.equal(await app.page(`window.emulatorActions.welcome.seen().then(() => "written", (e) => e.code)`), "no_gesture");
    assert.equal(settingsOf(data).welcomed, undefined);

    await app.click('[data-choice="agent"]');
    await until(async () => (await shown(app)) === "agent", "the text for agents");
    await until(() => settingsOf(data).welcomed === true, "the answer written down");
    assert.equal(settingsOf(data).welcomeWay, "agent", "the way chosen, for the next Getting started");
    await app.click("#welcome-copy");
    await until(() => app.page(`document.querySelector(".welcome-said").textContent === "Copied"`), "Copied");
    const [copied] = await app.run((shell) => shell.offScreen.copied);
    // The page's own text, for the system the app runs on: in this run there is no pointer file, so the fixed path.
    assert.equal(copied, await app.page(`document.querySelector(".welcome-prompt").textContent`));
    const call = process.platform === "win32" ? `& "$env:LOCALAPPDATA\\busy-emulator\\bin\\busy-emulator.exe"` : "~/.busy-emulator/bin/busy-emulator";
    for (const line of [`1. ${call} create my-app`, `2. ${call} dev --once`, `3. ${call} screenshot --scale 8`, `4. ${call} logs`]) assert.ok(copied.split("\n").includes(line), `${line}\n---\n${copied}`);
    assert.match(await app.page(`document.querySelector("#welcome .welcome-note a").href`), /^https:\/\/github\.com\/busy-app\/busybar-emulator\/blob\/main\/public-docs\/mcp\.md$/);

    // Escape closes it.
    await key(app, "Escape");
    await until(async () => (await shown(app)) === null, "the greeting closed");
    assert.deepEqual(await app.page(`[document.querySelector("aside.side").inert, document.querySelector("main#stage").inert]`), [false, false]);
  } finally {
    await app.close();
  }
});

test("the next run does not ask again; Getting started opens the greeting on the way chosen, Back on the question, and I'll write the code goes on to Create app", { skip }, async () => {
  const app = await launch({ server: "real", dataDir: data, env: { BUSY_EMULATOR_TEST_GREETED: "" } });
  try {
    await ready(app);
    await sleep(1500);
    assert.equal(await shown(app), null, "not asked again");
    assert.equal(await app.page(`document.querySelector("#welcome-open").textContent`), "Getting started");
    await app.click("#welcome-open");
    await until(async () => (await shown(app)) === "agent", "the greeting again, on the way chosen last time");
    await app.click('#welcome [data-step="agent"] .welcome-foot .btn');
    await until(async () => (await shown(app)) === "ask", "the question");
    await app.click('[data-choice="code"]');
    await until(async () => (await shown(app)) === null, "the greeting gave way");
    // The window's Create app: its pop-up, the official template and the three examples first.
    const popUp = () => app.page(`!(document.querySelector(".create-app-scrim")?.hidden ?? true)`);
    await until(popUp, "Create app's pop-up");
    await until(() => app.page(`document.querySelectorAll(".create-app-card").length === 4`), "the template and the examples");
    assert.equal(settingsOf(data).welcomed, true);
    await until(() => settingsOf(data).welcomeWay === "code", "the other way written down");
    // Now Getting started opens on writing the code: where it is, what the bar can do, Refresh; and Create app. (The
    // pop-up first closed with its cross, so that the link is in view.)
    await app.click(".create-app-head .icon-btn");
    await until(async () => !(await popUp()), "the pop-up closed");
    await app.click("#welcome-open");
    await until(async () => (await shown(app)) === "code", "the greeting on writing the code");
    assert.equal(await app.page(`document.querySelectorAll('#welcome [data-step="code"] ol li').length`), 3);
    await app.click("#welcome-create-app");
    await until(async () => (await shown(app)) === null, "the greeting gave way again");
    await until(popUp, "the pop-up again");
  } finally {
    await app.close();
  }
});
