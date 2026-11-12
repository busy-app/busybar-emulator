// The pictures of public-docs/from-zero-to-catalog.md (EMU-171), taken from the real shell with the real server: the
// first-run question and the text for agents, Create app on its Templates and Empty app tabs, a Focus Timer made from
// the example and running, the Screenshot control, every step of Publish and Send to catalog against the stand-ins for
// GitHub CLI and GitHub (never github.com). The window is 1200×800; the project is in the test's own home, shown as
// ~/BUSY Bar projects/focus-timer; the GitHub accounts are the stand-in's (octo-person, octo-own).
//
// Runs only with GUIDE_SHOTS=<folder>, where the pictures go as guide-<name>.png: it is a camera, not a check. It needs
// the npm registry, like publish.test.mjs. The pictures the window cannot take (the system's dialogs: macOS's Open
// Anyway, Windows SmartScreen, the trust and publish questions, which are the system's message boxes) are not here.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { BUNDLED_TEMPLATE } from "../../src/github/publish-flow.mjs";
import { FAKE_GH, fakeSignedIn } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { HAS_REAL_SERVER, PORTS, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const SHOTS = process.env.GUIDE_SHOTS || null;
const skip = (!SHOTS && "GUIDE_SHOTS=<folder> takes the guide's pictures") || (!HAS_REAL_SERVER && "the server is not beside this package");
const SIZE = [1200, 800];

let app;
let github;
let home;
after(async () => {
  await app?.close();
  await github?.close();
  if (home) await removeFolder(home);
});

const q = (text) => JSON.stringify(text);
/** A click of the mouse at a point of the page, sent as the system sends the person's. */
const clickAt = (at) =>
  app.run((shell, _electron, { x, y }) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }, at);
/** Clicks the element the page's code finds (`find` is an expression of the page), brought into view first. */
async function clickOn(find, what) {
  const at = await app.page(`(() => {
    const one = ${find};
    if (!one) return null;
    one.scrollIntoView({ block: "center" });
    const box = one.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
  assert.ok(at, what);
  await clickAt(at);
}
const key = (keyCode) =>
  app.run((shell, _electron, code) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode: code });
    contents.sendInputEvent({ type: "keyUp", keyCode: code });
  }, keyCode);

// Create app.
const way = (id) => clickOn(`document.querySelector(${q(`.create-app-way[data-way='${id}']`)})`, `the way ${id}`);
const type = (part, value) => app.page(`(() => { const el = document.querySelector(${q(`.create-app [data-part='${part}']`)}); el.value = ${q(value)}; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); return true; })()`);
const createState = () => app.page(`(() => { const b = document.querySelector(".create-app [data-part=create]"); return b ? { disabled: b.ariaDisabled, why: b.title } : null; })()`);
const createOpen = () => app.page(`!(document.querySelector(".create-app-scrim")?.hidden ?? true)`);

// Publish.
const pane = () => app.page(`document.querySelector(".publish-pane")?.innerText ?? ""`);
const said = () => app.page(`document.querySelector(".publish-said")?.textContent ?? ""`);
const idle = () => until(async () => !(await app.page(`document.querySelector(".publish-said")?.classList.contains("working") ?? true`)), "the dialog to finish its work", 300_000, 200);
async function press(label, n = 0) {
  await clickOn(`[...document.querySelectorAll(".publish button")].filter((b) => b.textContent.trim() === ${q(label)} || b.ariaLabel === ${q(label)} || b.title === ${q(label)})[${n}]`, `a button "${label}" in the dialog`);
}
const fill = (label, value) => app.page(`(() => { const box = [...document.querySelectorAll(".publish-field")].find((one) => one.querySelector(".label b")?.textContent === ${q(label)}); const el = box.querySelector("input, textarea, select"); el.value = ${q(value)}; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); return true; })()`);
const tick = (selector, n = 0) => app.page(`(() => { const one = document.querySelectorAll(${q(selector)})[${n}]; if (!one.checked) one.click(); return true; })()`);
/** Takes the window as it is now: the page painted at its size first (a hidden window paints when its size changes). */
async function shot(name, prepare = null) {
  mkdirSync(SHOTS, { recursive: true });
  // The page scrolled back where a person sees it (clickOn brings things into view), and the caret out of the way.
  await app.page(`(document.activeElement?.blur?.(), true)`);
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h - 1), SIZE);
  await sleep(200);
  await app.run((shell, _electron, [w, h]) => shell.windows.current.win.setContentSize(w, h), SIZE);
  await sleep(700);
  // What must be in view is brought there after the new size is laid out: a change of size scrolls the dialog back.
  if (prepare) {
    await app.page(prepare);
    await sleep(300);
  }
  await app.page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
  writeFileSync(path.join(SHOTS, `guide-${name}.png`), Buffer.from(png, "base64"));
}

test("the guide's pictures", { skip, timeout: 1_800_000 }, async () => {
  github = await startGithubStub({ port: PORTS.unit });
  // The catalog, as GitHub has it: its pull request template is the checklist Send to catalog shows.
  github.makeRepo("busy-app", "busy-apps-catalog");
  github.commitFiles("busy-app/busy-apps-catalog", "main", { "README.md": "# BUSY Apps Catalog\n", "applications/.gitkeep": "", ".github/PULL_REQUEST_TEMPLATE.md": BUNDLED_TEMPLATE });
  // A home of a person named "you": the new app's id and author come from git's user.name, never the machine's own.
  home = temporaryFolder();
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = you\n");
  app = await launch({
    server: "real",
    network: "open",
    env: { HOME: home, BUSY_EMULATOR_TEST_GREETED: "", BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust", BUSY_EMULATOR_GH: FAKE_GH, BUSY_EMULATOR_FAKE_GH_STAND_IN: github.base, BUSY_EMULATOR_FAKE_GH_POLL_MS: "1000" },
  });
  await app.waitWindow("device");
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), SIZE);
  await until(() => app.page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected");

  // ---- The first-run question, and the text for agents.
  const step = () => app.page(`(() => { const box = document.querySelector("#welcome"); return box && !box.hidden ? [...box.querySelectorAll(".welcome-step")].find((one) => !one.hidden)?.dataset.step : null; })()`);
  await until(async () => (await step()) === "ask", "the greeting");
  await sleep(500);
  await shot("welcome");
  await app.click('[data-choice="agent"]');
  await until(async () => (await step()) === "agent", "the text for agents");
  await shot("agent-text");
  await key("Escape");
  await until(async () => (await step()) === null, "the greeting closed");

  // ---- Create app: Templates, with Focus Timer chosen; Empty app, filled in with a letter icon.
  await until(() => app.page(`document.querySelector("#create-app")?.ariaDisabled === "false"`), "Create app to be there to press");
  await clickOn(`[document.querySelector("#create-app"), document.querySelector("#apps .empty button")].find((b) => b && b.offsetParent !== null)`, "a Create app button");
  await until(createOpen, "the pop-up");
  await until(() => app.page(`[...document.querySelectorAll(".create-app-card .screen img")].filter((img) => img.complete && img.naturalWidth === 72).length === 3`), "the cards with their pictures");
  await clickOn(`[...document.querySelectorAll(".create-app-card")][1]`, "the Focus Timer card");
  await until(async () => (await createState()).disabled === "false", "Create for the template");
  await shot("create-app-templates");
  await way("empty");
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part=name]"))`), "the empty app's form");
  await type("name", "Focus Timer");
  await type("short", "A focus session you can see on the bar");
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part=category] option[value=productivity]"))`), "the catalog's categories");
  await type("category", "productivity");
  await until(async () => (await createState()).disabled === "false", "Create for the empty app");
  await shot("create-app-empty");
  // The app itself is made from the example.
  await way("templates");
  await clickOn(`[...document.querySelectorAll(".create-app-card")][1]`, "the Focus Timer card");
  await until(async () => (await createState()).disabled === "false", "Create for the template");
  await clickOn(`document.querySelector(".create-app [data-part=create]")`, "Create");
  await until(async () => !(await createOpen()), "the app created and the pop-up gone", 900_000, 500);
  await until(() => app.page(`document.querySelector("#app-title")?.textContent === "Focus Timer"`), "Focus Timer chosen");
  const dir = realpathSync(path.join(app.folder, "test-home", "BUSY Bar projects", "focus-timer"));

  // ---- The window with Focus Timer running, a session begun.
  await sleep(2000);
  await clickOn(`document.querySelector(".dock [data-key=start]")`, "Start");
  await sleep(9000);
  await shot("window-app-running");

  // ---- Screenshot over the bar, Front and Back ticked, just taken.
  assert.deepEqual(await app.page(`[document.querySelector("#shot-front").checked, document.querySelector("#shot-back").checked]`), [true, true]);
  await clickOn(`document.querySelector("#shot-take")`, "Screenshot");
  await until(() => app.page(`!document.querySelector("#capture-toast").hidden`), "the screenshot said");
  await sleep(400);
  await shot("screenshot");

  // ---- Publish, stage 1. The person has a .env with a key in the project, which must not be published.
  writeFileSync(path.join(dir, ".env"), `WEATHER_API_KEY=${"k".repeat(4)}${"9f3a".repeat(6)}\n`);
  await until(() => app.page(`document.querySelector("#publish")?.ariaDisabled === "false"`), "Publish to be there to press");
  await app.click("#publish");
  await until(() => app.page(`!document.querySelector(".publish-scrim")?.hidden`), "the dialog");
  await idle();
  await fill("Name", "Focus Timer");
  await press("Choose a category");
  await clickOn(`document.querySelector('.publish-options [data-category="productivity"]')`, "Productivity");
  await until(() => app.page(`!document.querySelector(".publish-options")`), "the list closed");
  await fill("Short description", "A tree grows on the bar while you focus.");
  await fill("Description", "Start a focus session with **Start**. A sprout grows into a tree while you work; finish and it joins the forest of the day.\n\n- The wheel sets the length\n- Back gives up");
  await fill("What's new", "The first version: focus sessions, breaks and a forest.");
  await shot("publish-app-info");
  await press("Next");
  await until(() => app.page(`document.querySelector(".publish-step.on")?.textContent.includes("Screenshots")`), "Screenshots");
  await idle();
  // The screenshot taken over the bar is there; one more of the back, taken here.
  if (!/back-1/.test(await pane())) {
    await press("Take from the BUSY Bar", 1);
    await idle();
  }
  await shot("publish-screenshots");
  await press("Next");
  await idle();

  // README: two rows of How to use, and the preview.
  const row = async (n, text) => {
    await until(() => app.page(`Boolean(document.querySelector('.publish-howto input[data-row="${n}"]'))`), `the row ${n}`);
    return rowNow(n, text);
  };
  const rowNow = (n, text) => app.page(`(() => { const el = document.querySelector('.publish-howto input[data-row="${n}"]'); el.value = ${q(text)}; el.dispatchEvent(new Event("input")); return true; })()`);
  await until(async () => /Add a row for Start/.test(await app.page(`[...document.querySelectorAll(".publish button")].map((b) => b.ariaLabel || b.title || b.textContent).join("\\n")`)), "the README's How to use");
  await press("Add a row for Start");
  await row(0, "Begins a session; pauses it and goes on");
  await press("Add a row for Wheel turn");
  await row(1, "Sets the length, in steps of five minutes");
  await until(async () => /How to use[\s\S]*Wheel turn/.test(await app.page(`document.querySelector(".publish-preview")?.innerText ?? ""`)), "the preview");
  await shot("publish-readme");
  await press("Next");
  await idle();

  // License: MIT, the holder written.
  await app.page(`(() => { document.querySelector('.publish-licenses input[value="MIT"]').click(); return true; })()`);
  await fill("Copyright holder", "The Focus Timer authors");
  await shot("publish-license");
  await press("Next");
  await idle();

  // Repository files: the .env marked as looking like a secret, kept out.
  await until(async () => /Looks like a secret/.test(await pane()), "the secret marked");
  await clickOn(`[...document.querySelectorAll(".publish button, .publish a")].find((b) => b.textContent.trim() === "Show the files")`, "Show the files");
  await sleep(500);
  await app.page(`(document.querySelector(".publish-pane").scrollTop = 0, true)`);
  await shot("publish-files");
  await press("Next");
  await idle();

  await until(async () => /All clear|to fix/.test(await pane()), "the check");
  assert.match(await pane(), /All clear/);
  await shot("publish-check");
  await press("Next");
  await idle();

  await press("Build and package");
  await idle();
  assert.match(await pane(), /Ready to publish/, await said());
  await shot("publish-package");

  // ---- Publish to GitHub: GitHub CLI on this computer has one account (octo-own); the person signs in with another.
  fakeSignedIn(path.join(app.folder, "person"), { login: "octo-own", token: github.others["octo-own"], standIn: github.base });
  await clickOn(`[...document.querySelectorAll(".publish-step")].find((b) => b.textContent.includes("Publish to GitHub"))`, "the step Publish to GitHub");
  await idle();
  await until(async () => /^Choose a GitHub account/.test(await pane()) && /octo-own/.test(await pane()), "the account view with GitHub CLI's account", 30_000);
  await shot("publish-account");
  await app.page(`(() => { document.querySelector('input[name="publish-account"][value="new"]').click(); return true; })()`);
  github.device.answers.push({ body: { device_code: "device-code-1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } });
  for (let i = 0; i < 6; i++) github.device.answers.push({ body: { error: "authorization_pending" } });
  github.device.answers.push({ body: { access_token: github.token, token_type: "bearer", scope: "repo,read:org,gist" } });
  await press("Sign in with another account");
  await until(async () => /WDJB-MJHT/.test(await pane()), "the code");
  await shot("publish-code");
  await until(async () => new RegExp(`Publishing as ${github.login}`).test(await pane()), "the sign-in to end", 60_000);
  await press("Publish to GitHub");
  await idle();
  await until(async () => /Published/.test(await pane()), "published", 120_000);
  await shot("publish-github-done");

  // ---- Send to catalog: the catalog's checklist, every item ticked, an AI usage chosen; not sent.
  await press("Send to catalog");
  await until(async () => /AI usage/.test(await pane()), "the step Send to catalog");
  await idle();
  await until(async () => /busy-app\/busy-apps-catalog, \.github\/PULL_REQUEST_TEMPLATE\.md/.test(await pane()), "the catalog's own checklist", 30_000);
  const boxes = await app.page(`document.querySelectorAll('.publish-checklist input[type="checkbox"]').length`);
  for (let i = 0; i < boxes; i++) await tick('.publish-checklist input[type="checkbox"]', i);
  await app.page(`(() => { document.querySelector('.publish-choices input[value="partly"]').click(); return true; })()`);
  await until(() => app.page(`[...document.querySelectorAll(".publish button")].find((b) => b.textContent === "Send to catalog")?.ariaDisabled === "false"`), "Send to be there to press");
  // The end of the step in view: the last items of the checklist, the AI usage and Send to catalog.
  await shot("send-to-catalog", `(() => { [...document.querySelectorAll(".publish button")].find((b) => b.textContent === "Send to catalog").scrollIntoView({ block: "end" }); return true; })()`);
});
