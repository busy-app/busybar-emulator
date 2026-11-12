// Create app without the network, in the real shell with the real server and command line (create-offline): the
// command line's npm is pointed at a registry of the test's own on 127.0.0.1 whose network is cut per package
// (test/fixtures/fake-registry.mjs); nothing reaches the real network.
//
// - the person creates "Focus Timer" while the registry refuses the project's dependencies: the pop-up closes, the
//   app is listed and chosen, its row says "Dependencies not installed: no network" with Retry, the section says so,
//   and the console says what happened;
// - Retry with the network still down says the same; with the network back it installs them and goes on with a
//   Refresh, as the app Create app makes is meant to run;
// - a second project created offline is installed again by the window itself when the system says it is online, and
//   refreshed the same way;
// - the pop-up says when an app of the name is there already, and rows of the same name say their folders.
//
// CREATE_OFFLINE_SHOTS=<folder> saves pictures of the window at 1200×800 there.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { fakeRegistry } from "../fixtures/fake-registry.mjs";
import { HAS_REAL_SERVER, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.CREATE_OFFLINE_SHOTS || null;

let app;
let registry;
const modes = new Map(); // package → "pass" | "refuse" | "hang"
before(async () => {
  if (!skip) registry = await fakeRegistry({ mode: (name) => modes.get(name) ?? "pass" });
});
after(async () => {
  await app?.close();
  await registry?.close();
});

const q = (text) => JSON.stringify(text);
async function clickOn(find, what) {
  const at = await app.page(`(() => {
    const one = ${find};
    if (!one) return null;
    one.scrollIntoView({ block: "center" });
    const box = one.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  assert.ok(at, what);
  await app.run((shell, _electron, { x, y }) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }, at);
}
const type = (part, value) => app.page(`(() => { const el = document.querySelector(${q(`.create-app [data-part='${part}']`)}); el.value = ${q(value)}; el.dispatchEvent(new Event("input")); return true; })()`);
const createState = () => app.page(`(() => { const b = document.querySelector(".create-app [data-part=create]"); return b ? { disabled: b.ariaDisabled, why: b.title } : null; })()`);
/** The side column back on All apps (layout V2: a created app is opened in it). */
const allApps = () => app.page(`(document.querySelector("#side").dataset.mode === "app" && document.querySelector("#all-apps").click(), true)`);
const openCreate = async () => {
  await allApps();
  await clickOn(`[document.querySelector("#create-app"), document.querySelector("#apps .empty button")].find((b) => b && b.offsetParent !== null)`, "a Create app button");
};
const isOpen = () => app.page(`!(document.querySelector(".create-app-scrim")?.hidden ?? true)`);
/** The rows of the Apps list: name, the line under it, the words of its buttons. */
const rows = () => app.page(`[...document.querySelectorAll("#apps li.app")].map((li) => ({ name: li.querySelector(".app-name").textContent, note: li.querySelector(".app-note").textContent, buttons: [...li.querySelectorAll(".row-actions button")].filter((b) => !b.classList.contains("row-more")).map((b) => b.textContent.trim() || b.title) }))`);
const retryOn = async (index) => (await allApps(), clickOn(`[...document.querySelectorAll("#apps li.app")][${index}].querySelector(".row-retry")`, "the row's Retry"));

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // A hidden window paints again when its size changes: one pixel less first, so that the picture is of the page now.
  await app.run((shell) => shell.windows.current.win.setContentSize(1200, 799));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await app.run((shell) => shell.windows.current.win.setContentSize(1200, 800));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(path.join(SHOTS, `${name}-1200x800.png`), Buffer.from(png, "base64"));
}

/** Create app on the official template, under `name`, as the person does it. */
async function createApp(name) {
  await openCreate();
  await until(isOpen, "the pop-up");
  await until(() => app.page(`document.querySelectorAll(".create-app-card").length >= 1`), "the official template's card");
  await clickOn(`[...document.querySelectorAll(".create-app-card")][0]`, "the official template");
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part=name]"))`), "the name field");
  await type("name", name);
  await until(async () => (await createState())?.disabled === "false", "Create to be there to press", 20_000);
}

test("Create app without the network: the row says why and has Retry; Retry and the window's own retry install the dependencies; names that are taken are said", { skip, timeout: 900_000 }, async () => {
  modes.set("@busy-app/cli", "refuse");
  // create takes the generator's registry from ~/.npmrc only, never from the environment (create.mjs,
  // generatorRegistry): the command line the app starts gets a home of its own that names the test's registry.
  const home = temporaryFolder();
  writeFileSync(path.join(home, ".npmrc"), `registry=${registry.url}\n`);
  app = await launch({ server: "real", welcomed: true, env: { npm_config_registry: registry.url, BUSY_EMULATOR_TEST_CLI_HOME: home } });
  await app.waitWindow("device");
  await app.run((shell) => shell.windows.current.win.setContentSize(1200, 800));
  await until(() => app.page(`document.querySelector("#create-app")?.ariaDisabled === "false"`), "Create app to be there to press");
  await app.page("window.jobsSeen = []; window.emulatorActions.on('job', (job) => window.jobsSeen.push(job)); true");

  // ---- Focus Timer, created while the registry refuses the dependencies
  await createApp("Focus Timer");
  await clickOn(`document.querySelector(".create-app [data-part=create]")`, "Create");
  await until(async () => !(await isOpen()), "the project created and the pop-up gone", 120_000, 250);
  const dir = path.join(app.folder, "test-home", "BUSY Bar projects", "focus-timer");
  assert.ok(existsSync(path.join(dir, "package.json")), "the project is there");
  await until(async () => (await rows()).some((row) => row.note === "Dependencies not installed: no network"), "the row to say why", 30_000);
  assert.deepEqual(await rows(), [{ name: "Focus Timer", note: "Dependencies not installed: no network", buttons: ["Retry"] }]);
  assert.equal(await app.page(`document.querySelector("#app-title").textContent`), "Focus Timer", "the new app is chosen");
  assert.equal(await app.page(`document.querySelector("#app-status .job.deps .job-line").textContent`), "Dependencies not installed: no network");
  // The console says what happened, as it went.
  const said = await app.page(`document.body.innerText`);
  assert.match(said, /Installing the dependencies \(npm install, without install scripts\)/);
  assert.match(said, /The npm registry cannot be reached: trying npm's cache/);
  await shot("1-failed");

  // ---- Retry with the network still down: the same, said again
  await retryOn(0);
  await until(() => app.page(`window.jobsSeen.some((job) => job.kind === "dependencies" && job.state === "failed")`), "Retry to fail again", 60_000);
  await until(async () => (await rows())[0].note === "Dependencies not installed: no network", "the row to say it again");

  // ---- the network is back: Retry installs them, then puts the app on the bar as Refresh does (Create app makes an
  // app to run); the stand-in busy-cli of the test's registry builds nothing, so only that the Refresh ran is looked at.
  modes.clear();
  const refreshed = (name) => app.page(`window.jobsSeen.some((job) => job.kind === "refresh" && job.state !== "running" && job.folder.endsWith(${q(`${path.sep}${name}`)}))`);
  await retryOn(0);
  await until(() => app.page(`window.jobsSeen.some((job) => job.kind === "dependencies" && job.state === "done")`), "the dependencies installed", 60_000);
  assert.ok(existsSync(path.join(dir, "node_modules", "@busy-app", "cli", "package.json")));
  await until(() => refreshed("focus-timer"), "the Refresh that follows", 120_000);
  assert.doesNotMatch((await rows())[0].note, /Dependencies not installed/);
  await shot("2-retried");

  // ---- the same name again: the pop-up says so; another is created all the same, offline, and rows say their folders
  // npm's cache now holds the dependencies, and would install them without the network: emptied, as on a new computer.
  rmSync(path.join(app.folder, "npm-cache", "_cacache"), { recursive: true, force: true });
  modes.set("@busy-app/cli", "refuse");
  await createApp("Focus Timer");
  assert.match(await app.page(`document.querySelector(".create-app-exists")?.innerText ?? ""`), /^You already have Focus Timer in \S.*BUSY Bar projects[\\/]focus-timer\.\s+Open it\s+or create another\.$/);
  await shot("3-same-name");
  await clickOn(`document.querySelector(".create-app [data-part=create]")`, "Create");
  await until(async () => !(await isOpen()), "the second project created", 120_000, 250);
  await until(async () => (await rows()).length === 2 && (await rows()).some((row) => /Dependencies not installed/.test(row.note)), "two rows", 30_000);
  const twins = (await rows()).map((row) => [row.name, row.note]).sort();
  assert.deepEqual(twins.map(([name, note]) => [name, note.split(", ")[0]]), [["Focus Timer", "focus-timer"], ["Focus Timer", "focus-timer-2"]], "each row says its folder");
  assert.equal(twins[1][1], "focus-timer-2, Dependencies not installed: no network");
  await shot("4-two-of-a-name");

  // ---- the system says the network is back: the window tries by itself
  modes.clear();
  await app.page(`window.dispatchEvent(new Event("online")), true`);
  await until(() => app.page(`window.jobsSeen.some((job) => job.kind === "dependencies" && job.state === "done" && job.folder.endsWith("focus-timer-2"))`), "the window's own retry to install them", 60_000);
  await until(() => refreshed("focus-timer-2"), "the Refresh that follows it", 120_000);
  assert.ok(existsSync(path.join(app.folder, "test-home", "BUSY Bar projects", "focus-timer-2", "node_modules", "@busy-app", "cli", "package.json")));
});
