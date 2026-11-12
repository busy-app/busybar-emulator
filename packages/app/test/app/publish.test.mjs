// Publishing, the whole way in the real shell (EMU-263, publish-ux): a new project from the official template, then the
// window's Publish dialog step by step in its order, by the person's clicks, each step closed by Next, which writes
// what it holds: Application Info (an icon that fails a requirement, converted, the name, the category from its list, the catalog texts; Next
// goes on at once), screenshots taken from the bar and uploaded from files by each display's button, the README with
// How to use as rows of a control and a sentence (never the template's), a license (never chosen for the person; one's
// own file uploaded, asked before it replaces one), the repository's files (.gitignore), the pre-flight check with
// nothing left to fix, the build and submission/, with what will be sent said and the copy buttons' Copied. A
// planted .env and a token in a source file are warned of before anything is published. Then stage 2 against a stand-in for GitHub. With the real server and the
// real tools: it needs the npm registry, like actions-project.test.mjs.
//
// PUBLISH_SHOTS=<folder> also saves a picture of every step at 1200×800 and 900×650.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { BUNDLED_TEMPLATE } from "../../src/github/publish-flow.mjs";
import { FAKE_GH, fakeSignedIn } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { encodePng } from "../fixtures/png.mjs";
import { HAS_REAL_SERVER, PORTS, removeFolder, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.PUBLISH_SHOTS || null;

let app;
let work;
let github;
after(async () => {
  await app?.close();
  await github?.close();
  if (work) await removeFolder(work);
});

const q = (text) => JSON.stringify(text);
const act = async (code) => {
  await app.press();
  return app.page(`(${code}).then((value) => ({ value }), (e) => ({ error: { code: e.code, message: e.message } }))`);
};
const chooses = (folder) => app.run((shell, _electron, answer) => shell.folderDialogs.standIn(answer), folder);
const pane = () => app.page(`document.querySelector(".publish-pane")?.innerText ?? ""`);
const said = () => app.page(`document.querySelector(".publish-said")?.textContent ?? ""`);
const idle = () => until(async () => !(await app.page(`document.querySelector(".publish-said")?.classList.contains("working") ?? true`)), "the dialog to finish its work", 300_000, 200);
/** A click of the mouse at a point of the page, sent as the system sends the person's (what the shell takes for a
 * gesture), and dispatched by the page before the test reads it (harness.mjs, clickAt). */
const clickAt = (at) => app.clickAt(at);
/** The middle of an element the page's code finds (`find` is an expression of the page), brought into view first. */
const where = (find) =>
  app.page(`(() => {
    const one = ${find};
    if (!one) return null;
    one.scrollIntoView({ block: "center" });
    const box = one.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
/** Clicks the button of the dialog whose text, name or tooltip is `label` (the first, or the n-th). */
async function press(label, n = 0) {
  const at = await where(`[...document.querySelectorAll(".publish button")].filter((b) => b.textContent.trim() === ${q(label)} || b.ariaLabel === ${q(label)} || b.title === ${q(label)})[${n}]`);
  assert.ok(at, `a button "${label}" in the dialog`);
  await clickAt(at);
}
/** Opens a step of the dialog by its rail's entry. */
async function step(title) {
  const at = await where(`[...document.querySelectorAll(".publish-step")].find((b) => b.textContent.includes(${q(title)}))`);
  assert.ok(at, `the step ${title}`);
  await clickAt(at);
  await idle();
}
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1200, 800],
    [900, 650],
  ]) {
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    // A hidden window paints only when asked: the picture is of the page as it is now, not of its last paint.
    await app.run((shell) => shell.windows.current.win.webContents.invalidate());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `${name}-${w}x${h}.png`), Buffer.from(png, "base64"));
  }
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
}
/** Types into the field of the dialog with the label `label`, as the person does: the value, then the input event. */
const fill = (label, value) => app.page(`(() => { const box = [...document.querySelectorAll(".publish-field")].find((one) => one.querySelector(".label b")?.textContent === ${q(label)}); const el = box.querySelector("input, textarea, select"); el.value = ${q(value)}; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); return true; })()`);
/** Whether the footer's Next is off ("true") or on ("false"). */
const nextOff = () => app.page(`[...document.querySelectorAll(".publish-foot button")].find((b) => b.textContent === "Next")?.ariaDisabled ?? null`);

test("publish, stage 1: from a new project to Ready to publish, every check passing, secrets warned of", { skip, timeout: 900_000 }, async () => {
  work = temporaryFolder();
  // Stage 2 talks through the stand-in for GitHub CLI to a stand-in for GitHub on 127.0.0.1, never to github.com. The
  // shell's environment holds a token that must never reach gh.
  github = await startGithubStub({ port: PORTS.unit });
  // BUSY_EMULATOR_TEST_BUILT=<the test variant's .app or folder>: the same steps in the built app, its own Node and server.
  const built = process.env.BUSY_EMULATOR_TEST_BUILT;
  const runs = built ? { executable: process.platform === "darwin" ? path.join(built, "Contents", "MacOS", "BUSY Bar Emulator") : path.join(built, "BUSY Bar Emulator.exe"), server: "bundled" } : { server: "real" };
  app = await launch({ ...runs, network: "open", env: { BUSY_EMULATOR_GH: FAKE_GH, BUSY_EMULATOR_FAKE_GH_STAND_IN: github.base, BUSY_EMULATOR_FAKE_GH_POLL_MS: "1000", GH_TOKEN: "dummy-env-token-never-sent-0123456789" } });
  await app.waitWindow("device");
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);

  // A new project from the official template, then on the bar.
  const chosen = path.join(work, "focus app");
  mkdirSync(chosen, { recursive: true });
  await chooses(chosen);
  const created = await act(`window.emulatorActions.projects.create({})`);
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const dir = realpathSync(chosen);
  const { id } = created.value;
  assert.equal((await act(`window.emulatorActions.projects.refresh(${q(dir)})`)).value.ok, true);
  await until(() => app.page(`document.querySelector("#publish")?.ariaDisabled === "false"`), "Publish to be there to press");

  // The person plants what must not be published: a .env, and a token in a source file.
  writeFileSync(path.join(dir, ".env"), `WEATHER_API_KEY=${"k".repeat(4)}${"9f3a".repeat(6)}\n`);
  const token = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
  writeFileSync(path.join(dir, "src", "secret.ts"), `export const TOKEN = "${token}";\n`);
  // The template keeps .env out by its .gitignore; for the warning about a published one, it is taken out of it.
  const ignore = readFileSync(path.join(dir, ".gitignore"), "utf8");
  writeFileSync(path.join(dir, ".gitignore"), ignore.replace(/^\.env\n\.env\.\*\n/m, ""));

  await shot("0-window");
  if (SHOTS && (await app.page(`document.querySelector("#view-3d")?.ariaDisabled !== "true"`))) {
    await app.click("#view-3d");
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await shot("0-window-3d");
    await app.click("#view-2d");
  }
  // ---- Publish: the dialog opens on the first step, Application Info; nothing of a later step is shown.
  await app.click("#publish");
  await until(() => app.page(`!document.querySelector(".publish-scrim")?.hidden`), "the dialog");
  await idle();
  assert.equal(await app.page(`document.querySelector(".publish-step.on")?.textContent`), "1Application Info");
  assert.equal(await app.page(`[...document.querySelectorAll(".publish-step.later")].length`), 8, "the steps after it wait");
  let text = await pane();
  assert.doesNotMatch(text, /to fix|LICENSE|screenshot/i, "no problem of a later step");
  assert.equal(await nextOff(), "true");
  await shot("1-texts-empty");

  // ---- Application Info: the icons first, the icon block: Front and Back, each its picture large and pixel-crisp, its
  // requirements and its own Upload. A new project has the default icon, which create gave it.
  const iconFile = path.join(dir, "src", "appmeta", "icon_front_8x8.png");
  const iconBefore = readFileSync(iconFile);
  assert.equal(await app.page(`(() => { const box = document.querySelector(".publish-icon"); return Boolean(box) && box.parentElement.firstElementChild === box; })()`), true, "the icons before the name");
  assert.equal(await app.page(`(() => { const img = document.querySelector(".publish-icon .icon-front .tile img"); return img?.src.startsWith("data:image/png;base64,") && getComputedStyle(img).imageRendering === "pixelated"; })()`), true, "the project's icon, pixel-crisp");
  assert.deepEqual(await app.page(`[...document.querySelectorAll(".publish-icon .icon-side")].map((one) => [one.dataset.side, one.querySelectorAll(".icon-needs li").length, [...one.querySelectorAll("button")].filter((b) => b.dataset.part === "upload-" + one.dataset.side).length])`), [["front", 4, 1], ["back", 4, 1]], "two columns, each its requirements and its Upload");
  assert.equal(await app.page(`(() => { const [a, b] = [...document.querySelectorAll(".publish-icon .icon-side .actions .btn")].map((one) => getComputedStyle(one)); return a.height === b.height && a.backgroundColor === b.backgroundColor && a.boxShadow === b.boxShadow && a.borderRadius === b.borderRadius; })()`), true, "the two Uploads look the same");
  await until(async () => (await app.page(`document.querySelectorAll(".publish-icon .icon-front .icon-needs li.ok").length`)) === 4, "the project's icon checked: it meets every requirement");
  // The system's file dialog is the person's; here a stand-in answers it: first a PNG of 16×16, which fails its size.
  const big = encodePng({ width: 16, height: 16, channels: 4, data: new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : i % 4 === 0 ? 255 : 90)) });
  const answer = (name, bytes) => app.page(`(window.emulatorIconBlock.chooseFile = async () => ({ name: ${q(name)}, url: ${q(`data:image/png;base64,${bytes.toString("base64")}`)}, bytes: Uint8Array.from(atob(${q(bytes.toString("base64"))}), (c) => c.charCodeAt(0)) }), true)`);
  await answer("logo.png", big);
  await clickAt(await where(`document.querySelector('.publish-icon [data-part="upload-front"]')`));
  await until(() => app.page(`document.querySelector('.publish-icon .icon-front li.bad[data-need="size"]')?.innerText ?? ""`), "the size turned into an error");
  assert.match(await app.page(`document.querySelector('.publish-icon .icon-front li.bad').innerText`), /8×8 pixels\s+It is 16×16 pixels\. Scale it to 8×8, or draw it at 8×8\./);
  assert.equal(await app.page(`document.querySelectorAll(".publish-icon .icon-front li.bad").length`), 1, "only the requirement it breaks");
  assert.equal(await app.page(`Boolean(document.querySelector(".publish-icon .icon-save"))`), false, "nothing to save: a failing icon is never taken");
  await shot("1-texts-icon-failing");
  // The conversion the icon command does: Scale to 8×8, shown before it is saved.
  await clickAt(await where(`document.querySelector('.publish-icon [data-part="fix-front"]')`));
  await until(() => app.page(`Boolean(document.querySelector(".publish-icon .icon-front .tile.new img"))`), "the converted icon shown in place");
  assert.equal(await app.page(`document.querySelectorAll(".publish-icon .icon-front li.ok").length`), 4);
  assert.equal(await app.page(`document.querySelector(".publish-icon .icon-back .caption")?.textContent`), "Made from the front");
  await shot("1-texts-icon");
  // The descriptor stands under the label, above the field; the category's about is in its list, not under it.
  assert.deepEqual(await app.page(`[...document.querySelectorAll(".publish-form > .publish-pair .publish-field, .publish-form > .publish-field")].map((f) => [...f.children].map((c) => c.className.split(" ")[0] || c.tagName.toLowerCase()).join(" "))`), ["label about input hint", "label about input hint", "label about input hint", "label about input hint", "label about input hint"]);
  await fill("Name", "Focus Timer");
  await press("Choose a category");
  assert.equal(await app.page(`document.querySelectorAll(".publish-options .option").length`), 10);
  assert.match(await app.page(`document.querySelector('.publish-options [data-category="productivity"]').innerText`), /Productivity\s+Focus, Pomodoro, timers/, "the description while choosing");
  assert.ok(await app.page(`Boolean(document.querySelector('.publish-options [data-category="games"] use[href$="#bi-gamepad"]'))`), "each with its BUSY icon");
  await shot("1-texts-category");
  await clickAt(await where(`document.querySelector('.publish-options [data-category="productivity"]')`));
  await until(() => app.page(`!document.querySelector(".publish-options")`), "the list closed");
  assert.equal(await app.page(`document.querySelector(".publish-select").innerText.trim()`), "Productivity");
  assert.doesNotMatch(await pane(), /Pomodoro/, "no description under the field once chosen");
  await fill("Short description", "Short");
  assert.match(await pane(), /5 characters: the short description needs at least 10/);
  assert.equal(await said(), "Short description: at least 10 characters", "the reason Next is off, in the footer");
  await fill("Short description", "A focus timer that turns the BUSY Bar red while you work.");
  await fill("Description", "Start a focus session with **Start**. The BUSY Bar shows how long is left.\n\n- Back ends it\n- The wheel sets the length");
  await fill("What's new", "The first version: focus sessions.");
  assert.equal(await nextOff(), "false");
  await shot("1-texts");
  // Next goes on at once: the texts were checked here; the writing runs behind the next step. So the next step is on
  // as soon as the click has been dispatched, in the click itself, not after the writing (a time in ms measured that
  // as well as how busy the machine was).
  await press("Next");
  assert.equal(await app.page(`document.querySelector(".publish-step.on")?.textContent.includes("Screenshots")`), true, "the next step, in the click itself");
  await until(() => app.page(`document.querySelector(".publish-step.done")?.textContent === "Application Info"`), "the step ticked when written");
  await idle();
  assert.ok(!readFileSync(iconFile).equals(iconBefore), "the icon written on Next");
  assert.equal(readFileSync(iconFile).readUInt32BE(16), 8, "8×8");
  assert.ok(existsSync(path.join(dir, "src", "appmeta", "icon_back_11x11.png")), "the back made from it");
  const details = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8"));
  assert.deepEqual([details.category, details.changelog], ["productivity", "The first version: focus sessions."]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8")).name, "Focus Timer");
  assert.equal(await app.page(`document.querySelector(".publish-step.done")?.textContent`), "Application Info", "the step is ticked");

  // ---- Screenshots: taken from the bar, and uploaded from files made before; the first is the cover.
  assert.equal(await said(), "Add a front screenshot");
  await press("Take from the BUSY Bar", 0);
  await idle();
  assert.ok(existsSync(path.join(dir, "screenshots", "front-1.png")), `the first screenshot: ${await said()}`);
  await press("Take from the BUSY Bar", 1);
  await idle();
  // Upload…: the system's dialog (the test's stand-in answers it) with an @8x copy made before, and a photo.
  const before = path.join(work, "made before");
  mkdirSync(before, { recursive: true });
  writeFileSync(path.join(before, "front@8x.png"), readFileSync(path.join(dir, "screenshots", "front-1@8x.png")));
  writeFileSync(path.join(before, "photo.png"), readFileSync(path.join(dir, "screenshots", "back-1.png")).subarray(0, 40));
  await chooses([path.join(before, "front@8x.png"), path.join(before, "photo.png")]);
  // Each display its own Upload…: the front's.
  assert.equal(await app.page(`[...document.querySelectorAll(".publish button")].filter((b) => b.textContent.trim() === "Upload…").map((b) => b.dataset.part).join(" ")`), "upload-front upload-back");
  await press("Upload…", 0);
  await idle();
  assert.match(await said(), /^Added 1\. photo\.png/, "what was not taken is said where results are said");
  assert.deepEqual(readFileSync(path.join(dir, "screenshots", "front-2.png")), readFileSync(path.join(dir, "screenshots", "front-1.png")), "the @8x copy made small again, exactly");
  text = await pane();
  assert.match(text, /Cover/);
  assert.deepEqual(readdirSync(path.join(dir, "screenshots")).sort(), ["back-1.png", "back-1@8x.png", "front-1.png", "front-1@8x.png", "front-2.png", "front-2@8x.png"], await said());
  // The second becomes the cover; the order is written into catalog.json.
  await press("Make it the cover");
  await idle();
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")).screenshots, ["screenshots/front-2.png", "screenshots/front-1.png"]);
  await shot("2-screenshots");
  await press("Next");
  await idle();

  // ---- README: made from the texts and the screenshots; How to use is the author's, as rows of a control and a sentence.
  assert.equal(await said(), "Add a control to How to use");
  assert.match(await app.page(`document.querySelector(".publish-preview")?.innerText ?? ""`), /Focus Timer[\s\S]*Start a focus session/);
  assert.equal(await app.page(`document.querySelectorAll(".publish-preview img.shot").length`), 3, "the screenshots in the preview");
  const row = (n, text) => app.page(`(() => { const el = document.querySelector('.publish-howto input[data-row="${n}"]'); el.value = ${q(text)}; el.dispatchEvent(new Event("input")); return true; })()`);
  await press("Add a row for Start");
  await row(0, "Begins a session");
  await press("Add a row for Wheel turn");
  await row(1, "Sets the length");
  await press("Add a row for Back");
  assert.equal(await said(), "How to use: write what Back does");
  await row(2, "Ends it");
  assert.equal(await nextOff(), "false");
  // Moved: the row with the wheel goes first.
  await press("Up", 1);
  assert.match(await app.page(`document.querySelector(".publish-preview")?.innerText ?? ""`), /How to use[\s\S]*Wheel turn\s*Sets the length[\s\S]*Start\s*Begins a session/, "the preview follows, each row with its chip");
  assert.equal(await app.page(`document.querySelectorAll(".publish-preview li.howto .control-chip img").length`), 3);
  await shot("3-readme-rows");
  await shot("3-readme");
  await press("Markdown");
  // In Markdown the rows are read from the text and written back into it.
  assert.match(await app.page(`document.querySelector(".publish textarea.code").value`), /## How to use\n\n- \*\*Wheel turn\*\*: Sets the length\n- \*\*Start\*\*: Begins a session\n- \*\*Back\*\*: Ends it\n/);
  await shot("3-readme-markdown");
  await press("Fields");
  await press("Next");
  await idle();
  const readme = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /^<!-- Made by BUSY Bar Emulator/);
  assert.match(readme, /# Focus Timer\n/);
  assert.match(readme, /## How to use\n\n- \*\*Wheel turn\*\*: Sets the length\n- \*\*Start\*\*: Begins a session\n- \*\*Back\*\*: Ends it\n/);
  assert.match(readme, /screenshots\/front-2@8x\.png/);
  assert.doesNotMatch(readme, /generated from the BUSY JS app template|listen\("input"/, "nothing of the template's README");

  // ---- License: nothing is chosen for the person; the choice and the name are written on Next.
  assert.equal(await app.page(`[...document.querySelectorAll(".publish-licenses input")].some((one) => one.checked)`), false, "no license is chosen for the person");
  assert.equal(await said(), "Choose a license");
  await app.page(`(() => { document.querySelector('.publish-licenses input[value="MIT"]').click(); return true; })()`);
  await fill("Copyright holder", "Test Author");
  await press("Show the full text");
  await until(async () => /Permission is hereby granted/.test(await pane()), "the full text");
  await shot("4-license");
  // Another license: the person's own file, from the system's dialog, copied in as LICENSE and checked.
  await app.page(`(() => { document.querySelector('.license-other input').click(); return true; })()`);
  assert.equal(await said(), "Upload your license file");
  const own = path.join(work, "made before", "LICENSE.txt");
  writeFileSync(own, readFileSync(fileURLToPath(new URL("../../../server/publish/licenses/MIT.txt", import.meta.url)), "utf8").replace("<year>", "2026").replace("<copyright holders>", "Test Author"));
  await chooses(own);
  await press("Upload license file…");
  await idle();
  assert.equal(await said(), "Copied LICENSE.txt in as LICENSE");
  assert.match(await pane(), /LICENSE: MIT/, "the license check ran again");
  // Once more: asked before LICENSE is replaced; kept.
  await chooses(own);
  await press("Upload license file…");
  await idle();
  assert.match(await pane(), /Replace LICENSE with LICENSE\.txt\?/);
  await shot("4-license-ask");
  await press("Keep LICENSE");
  assert.doesNotMatch(await pane(), /Replace LICENSE/);
  await press("Next");
  await idle();
  assert.match(readFileSync(path.join(dir, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 Test Author\n/);

  // ---- Repository files: the secrets are warned of before anything is published; Next writes .gitignore.
  // The step reads the project's files first ("Reading the project's files"), which takes a while on Windows.
  await until(async () => /Looks like a secret/.test(await pane()), "the files read and the secrets warned of", 30_000);
  text = await pane();
  assert.match(text, /Looks like a secret/);
  assert.match(text, /\.env/);
  assert.match(text, /src\/secret\.ts/);
  assert.match(text, /a GitHub token/);
  assert.match(text, /Kept out\./);
  assert.doesNotMatch(text, new RegExp(token), "the value itself is never shown");
  assert.equal(await app.page(`[...document.querySelectorAll(".publish button")].filter((b) => b.textContent === "Publish it anyway").length`), 2);
  await shot("5-files");
  await press("Next");
  await idle();
  const gitignore = readFileSync(path.join(dir, ".gitignore"), "utf8");
  for (const line of [".busy/", "submission/", "/.env", "/src/secret.ts"]) assert.ok(gitignore.split("\n").includes(line), `${line} in .gitignore`);
  assert.ok(existsSync(path.join(dir, ".busy", ".gitignore")), ".busy/ keeps itself out of git");

  // ---- Pre-flight check: every step made its part, so nothing is left to fix. It builds the app and checks its types
  // first (stale-check), with the project's own tools.
  await until(async () => /All clear|to fix/.test(await pane()), "the check", 180_000);
  text = await pane();
  assert.match(text, /All clear/, text);
  const checked = (await act(`window.emulatorActions.publish.status(${q(dir)})`)).value;
  assert.deepEqual([checked.steps.check, checked.check.stale], ["done", false], JSON.stringify(checked.check));
  await shot("6-check");
  await press("Next");
  await idle();

  // ---- Build and package.
  await press("Build and package");
  await idle();
  text = await pane();
  assert.match(text, /Ready to publish/, await said());
  const manifest = readFileSync(path.join(dir, "submission", "applications", id, "manifest.yml"), "utf8");
  assert.match(manifest, /# Filled in Stage 2/);
  assert.match(manifest, /screenshots:\n {2}- screenshots\/front-2\.png\n {2}- screenshots\/front-1\.png\n/);
  assert.equal(await app.page(`document.querySelectorAll(".publish-step.done").length`), 7);
  // What will be sent, said plainly; Show in Finder shows the catalog's entry.
  const sources = JSON.parse(JSON.stringify((await act(`window.emulatorActions.publish.status(${q(dir)})`)).value.files.published)).filter((one) => !one.path.startsWith(".github/workflows/")).length;
  assert.match(text, new RegExp(`GitHub gets the app's ${sources} source files, in a public repository on your account\\. The catalog gets one file: its entry, applications/${id.replace(/\./g, "\\.")}/manifest\\.yml\\.`));
  assert.match(text, /Built and checked: .*\.tgz, .* in dist\/\. It stays on this computer/);
  await press(`Shows submission/applications/${id}/manifest.yml`);
  await until(() => app.run((shell) => shell.offScreen.shown.length > 0), "Finder asked");
  assert.equal(await app.run((shell) => shell.offScreen.shown.at(-1)), path.join(dir, "submission", "applications", id, "manifest.yml"));
  await press("Rather by hand? Show the steps");
  // Waited for, not read at once: on a loaded machine the steps came a moment after the click (the release's gate, 12.11).
  await until(async () => /git push -u origin/.test(await pane()), "the steps by hand");
  // Copy: a tick and Copied for about two seconds.
  await press("Copy the commands");
  await until(() => app.page(`[...document.querySelectorAll(".publish-by-hand > .btn")].some((b) => b.textContent === "Copied to clipboard" && b.querySelector("use[href$='#bi-checkmark']"))`), "Copied to clipboard");
  await press("Copy", 0);
  await until(() => app.page(`document.querySelector(".publish-hand .icon-btn.copied")?.textContent === "Copied"`), "Copied on the command's button");
  await shot("7-package");
  await until(() => app.page(`[...document.querySelectorAll(".publish-by-hand > .btn")].some((b) => b.textContent === "Copy the commands")`), "the button as it was", 4_000);
  const check = (await act(`window.emulatorActions.publish.check(${q(dir)})`)).value;
  assert.deepEqual([check.passed, check.built, check.fails.length], [true, true, 0]);
  assert.deepEqual(check.stage2.map((one) => one.id).sort(), ["source_commit", "source_origin"]);
  assert.deepEqual([check.compiled, check.typed], [true, true], "the check built the app and checked its types");

  // ---- stale-check, the owner's case: checked and packaged, then src/main.ts broken in an editor (the `i` of its first
  // import deleted). Opening a later step finds the file changed: back on Pre-flight check, which says so and runs
  // again, and fails with the build's and the compiler's errors, file and line; Publish to GitHub sends nothing.
  const mainFile = path.join(dir, "src", "main.ts");
  const mainText = readFileSync(mainFile, "utf8");
  writeFileSync(mainFile, mainText.replace(/^import/m, "mport"));
  const stale = (await act(`window.emulatorActions.publish.status(${q(dir)})`)).value;
  assert.deepEqual([stale.steps.check, stale.check.stale, stale.check.changed, stale.steps.package, stale.package.stale], ["todo", true, ["src/main.ts"], "todo", true]);
  await step("Publish to GitHub");
  await until(async () => /Changed since the check/.test(await pane()), "the check said to be stale");
  assert.equal(await app.page(`document.querySelector(".publish-step.on")?.textContent`), "6Pre-flight check", "back on the check");
  await until(async () => /to fix/.test(await pane()), "the check run again", 180_000);
  await idle();
  text = await pane();
  assert.match(text, /Changed since the check\s*src\/main\.ts\. Checked again\./, text);
  assert.match(text, /The app builds\s*src\/main\.ts:1:\d+: \S/, text);
  assert.match(text, /The types check\s*src\/main\.ts:1:1: Unknown keyword or identifier\. Did you mean 'import'\?/, text);
  assert.ok(await where(`[...document.querySelectorAll(".publish button")].find((b) => b.textContent.trim() === "Open main.ts")`), "the file it names, to open");
  assert.equal(await nextOff(), "true", "the step stays blocked");
  assert.equal(await app.page(`document.querySelectorAll(".publish-step.done").length`), 5, "neither the check nor the package is done");
  await shot("6b-check-changed");
  // Publish to GitHub asked of the shell all the same, as the command line would: nothing is sent.
  const blocked = await act(`window.emulatorActions.github.push({ folder: ${q(dir)}, name: null })`);
  assert.equal(blocked.value?.code ?? blocked.error?.code, "not_checked", JSON.stringify(blocked));
  // Put right: the check passes again, and the package, of the very same files, holds again.
  writeFileSync(mainFile, mainText);
  await press("Run again");
  await until(async () => /All clear/.test(await pane()), "the check passing again", 180_000);
  await idle();
  assert.doesNotMatch(await pane(), /Changed since the check/, "Run again by hand: the news is old");
  await press("Next");
  await idle();
  assert.match(await pane(), /Ready to publish/);

  // The flow survives closing the window's dialog: it opens again on the first step not done, Publish to GitHub.
  await app.page(`window.emulatorPublish.close(); true`);
  await app.click("#publish");
  await idle();
  assert.equal(await app.page(`document.querySelector(".publish-step.on")?.textContent`), "8Publish to GitHub");

  // ---- Publish to GitHub, the account view: no account in GitHub CLI yet, so a sign-in by a code.
  await until(async () => /Sign in to GitHub/.test(await pane()), "the sign-in");
  assert.match(await pane(), /^Choose a GitHub account/, "the view says what it is for");
  assert.equal(await nextOff(), null, "no Next beside the step's own button");
  assert.match(await pane(), /signs in through GitHub CLI, made by GitHub\. GitHub CLI asks for access to your repositories \(public and private\)/, "what gh asks for is said, not hidden");
  assert.match(await pane(), /This also signs in GitHub CLI on this computer\./);
  assert.match(await pane(), /This sign-in belongs to GitHub CLI on this computer: other programs, including AI agents, can use it too\. The emulator's confirmations cover only its own commands\./, "said before the sign-in (F3)");
  await shot("8-signin");
  github.device.answers.push({ body: { device_code: "device-code-1", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } });
  // GitHub says "not yet" a few times (gh asks about once a second here), so that the code is there to be seen.
  for (let i = 0; i < 4; i++) github.device.answers.push({ body: { error: "authorization_pending" } });
  github.device.answers.push({ body: { access_token: github.token, token_type: "bearer", scope: "repo,read:org,gist" } });
  await press("Sign in to GitHub");
  // gh 2.103.3's words for the code ("One-time code (…) copied to clipboard"), as the stand-in prints them.
  await until(async () => /WDJB-MJHT/.test(await pane()), "the code");
  assert.match(await pane(), /^Sign in to GitHub/);
  assert.match(await pane(), /GitHub CLI has put the code on the clipboard\./);
  await shot("9-code");
  await press("Open github.com/login/device");
  await until(() => app.run((shell) => shell.offScreen.browsed.length > 0), "GitHub's page for the code");
  assert.deepEqual(await app.run((shell) => shell.offScreen.browsed), ["https://github.com/login/device"]);
  await until(async () => new RegExp(`Publishing as ${github.login}`).test(await pane()), "the sign-in to end", 30_000);
  const page = await app.page(`document.documentElement.outerHTML`);
  assert.equal(page.includes(github.token), false, "the token never reaches the page");
  // gh keeps it in the system's store (the stand-in's here), not in its configuration file or the app's.
  const store = () => JSON.parse(readFileSync(path.join(app.folder, "person", "fake-keyring.json"), "utf8"));
  assert.equal(store()[`gh:github.com|${github.login}`], github.token);
  assert.doesNotMatch(readFileSync(path.join(app.folder, "person", "gh", "hosts.yml"), "utf8"), /oauth_token/);
  // ---- The publish view: who it publishes as, the name, and what Publish to GitHub does, said beside it.
  assert.match(await pane(), /^Publish to GitHub/);
  assert.match(await pane(), /Creates the public repository github\.com\/octo-person\/\S+ and uploads \d+ files.* in one commit\. Anyone can see it\./);
  assert.equal(await nextOff(), null);
  await shot("10-signed-in");
  // GitHub is slow to take the files: the upload shows how far it is, then that it is still waiting, and Cancel.
  let blobs = 0;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  github.hooks.hold = (req) => (req.method === "POST" && req.url.endsWith("/git/blobs") && ++blobs >= 3 ? held : null);
  await press("Publish to GitHub");
  await until(async () => /Uploading 2 of \d+ files/.test(await pane()), "the upload's progress", 60_000);
  assert.ok(await where(`[...document.querySelectorAll(".publish-upload button")].find((b) => b.textContent.trim() === "Cancel")`), "Cancel is there");
  assert.equal(await app.page(`document.querySelector(".publish-bar span")?.style.width !== "0%"`), true);
  await shot("11a-uploading");
  await until(async () => /Still waiting for GitHub: no answer for 2\d s\./.test(await pane()), "the wait to be told", 40_000);
  await shot("11b-still-waiting");
  github.hooks.hold = null;
  release();
  await idle();
  text = await pane();
  assert.match(text, /Published/, await said());
  const repoName = id.split(".").at(-1);
  const head = github.headOf(`${github.login}/${repoName}`, "main");
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.match(text, new RegExp(head));
  const onGithub = github.filesOf(`${github.login}/${repoName}`, "main");
  assert.ok(onGithub["LICENSE"] && onGithub["catalog.json"] && onGithub["screenshots/front-2.png"] !== undefined, Object.keys(onGithub).join(", "));
  assert.equal(onGithub[".env"], undefined, "what was kept out stays out");
  assert.equal(Object.keys(onGithub).some((one) => one.startsWith(".github/workflows/")), false, "no workflows: they would need the scope workflow");
  const filled = readFileSync(path.join(dir, "submission", "applications", id, "manifest.yml"), "utf8");
  assert.match(filled, new RegExp(`origin: https://github.com/${github.login}/${repoName}.git\n    commit_sha: ${head}`));
  assert.doesNotMatch(filled, /Filled in Stage 2/);
  await shot("11-published");

  // ---- Send to catalog: the catalog's own checklist, every box; a fork of the catalog, the manifest on a branch, the
  // pull request with the boxes ticked.
  // The default catalog is public: the stand-in for GitHub holds it with its own template.
  github.makeRepo("busy-app", "busy-apps-catalog");
  github.commitFiles("busy-app/busy-apps-catalog", "main", { "README.md": "# Catalog\n", "applications/.gitkeep": "", ".github/PULL_REQUEST_TEMPLATE.md": BUNDLED_TEMPLATE.replace("# AI usage", "- [ ] (optional) My app takes part in a contest, and I accept its [rules](https://example.com/rules)\n\n# AI usage") });
  await press("Send to catalog");
  await until(async () => /AI usage/.test(await pane()), "the step Send to catalog");
  await idle();
  // No field to name another catalog: the step names the default one, as text with a link.
  assert.equal(await app.page(`document.getElementById("publish-catalog")`), null, "no catalog field");
  assert.match(await pane(), /Goes to busy-app\/busy-apps-catalog, the BUSY Apps Catalog\./);
  assert.equal(await app.page(`[...document.querySelectorAll(".publish a")].find((a) => a.textContent === "busy-app/busy-apps-catalog")?.href`), "https://github.com/busy-app/busy-apps-catalog");
  await until(async () => /As the catalog's pull request template has it: busy-app\/busy-apps-catalog, \.github\/PULL_REQUEST_TEMPLATE\.md/.test(await pane()), "the catalog's own checklist");
  const boxes = await app.page(`[...document.querySelectorAll('.publish-checklist input[type="checkbox"]')].map((one) => one.dataset.box)`);
  assert.equal(boxes.length, 7, boxes.join("\n"));
  // The optional item: shown without its prefix, with a quiet tag; not needed to send.
  assert.equal(await app.page(`[...document.querySelectorAll('.publish-checklist label')].at(-1).textContent`), "My app takes part in a contest, and I accept its rulesOptional");
  assert.ok(boxes.includes("I've tested the app on a BUSY Bar with the latest release firmware") && boxes.includes("The screenshots are taken from the bar"), "every box, as the template says");
  assert.equal(await app.page(`document.querySelector('.publish-checklist a')?.href`), "https://github.com/busy-app/busy-apps-catalog/blob/main/TERMS.md", "its link opens");
  const sendOff = () => app.page(`[...document.querySelectorAll(".publish button")].find((b) => b.textContent === "Send to catalog")?.ariaDisabled`);
  assert.equal(await sendOff(), "true", "nothing is sent before every box is ticked and the AI usage chosen");
  for (let i = 0; i < 5; i++) await app.page(`(() => { document.querySelectorAll('.publish-checklist input[type="checkbox"]')[${i}].click(); return true; })()`);
  await app.page(`(() => { document.querySelector('.publish-choices input[value="none"]').click(); return true; })()`);
  assert.equal(await sendOff(), "true", "one box left");
  await until(async () => /Tick every item of the checklist: 5 of 6 ticked/.test(await pane()), "what is left to tick, once the catalog was read");
  await app.page(`(() => { document.querySelectorAll('.publish-checklist input[type="checkbox"]')[5].click(); return true; })()`);
  assert.equal(await sendOff(), "false");
  await shot("12-catalog");
  await press("Send to catalog");
  await idle();
  text = await pane();
  assert.match(text, /Opened/, await said());
  const pull = github.pulls.at(-1);
  const branch = pull.head.split(":")[1];
  assert.match(pull.head, new RegExp(`^${github.login}:${github.login}/${id.replace(/\./g, "\\.")}_\\d+\\.\\d+\\.\\d+$`));
  assert.equal((pull.body.match(/^- \[x\] /gm) ?? []).length, 6, pull.body);
  assert.match(pull.body, /^- \[ \] \(optional\) My app takes part/m, "the optional box stays as the person left it");
  assert.match(pull.body, /^- \[x\] I'm the author of the app/m);
  assert.match(pull.body, /^- No AI was used\.$/m);
  assert.doesNotMatch(pull.body, /Partly AI-assisted|Keep ONE option/);
  assert.match(github.filesOf(`${github.login}/busy-apps-catalog`, branch)[`applications/${id}/manifest.yml`], new RegExp(`commit_sha: ${head}`));
  assert.match(text, new RegExp(pull.url.replace(/^https:\/\//, "")));
  await shot("13-sent");

  // ---- An update (catalog-update): the catalog has the app now, at 0.0.1 from a repository of the person's. Send to
  // catalog says so, asks What's new for this version (not the published one's), and sends "Update … to …".
  github.makeRepo(github.login, "old-copy");
  const old = github.commitFiles(`${github.login}/old-copy`, "main", { "src/appmeta/manifest.json": JSON.stringify({ id, name: "Focus", version: "0.0.1" }) });
  github.commitFiles("busy-app/busy-apps-catalog", "main", { [`applications/${id}/manifest.yml`]: `sourcecode:\n  type: git\n  location:\n    origin: https://github.com/${github.login}/old-copy.git\n    commit_sha: ${old}\ncategory: productivity\nchangelog: The first version: focus sessions.\n` });
  await step("Publish to GitHub");
  await step("Send to catalog");
  await until(async () => /In the catalog\s*\S.* 0\.0\.1/.test(await pane()), "the update's facts", 30_000).catch(async (e) => {
    throw new Error(`${e.message}. The step says: ${await pane()}`);
  });
  // The catalog's app comes from another repository of the person's (old-copy): a warning before sending, no refusal.
  assert.match(await pane(), new RegExp(`The catalog has ${id.replace(/\./g, "\\.")} from ${github.login}/old-copy, another repository of yours\\. Sending replaces that app with this project\\.`));
  const version = JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8")).version;
  assert.match(await pane(), new RegExp(`What's new in ${version.replace(/\./g, "\\.")}`));
  const updateOff = () => app.page(`[...document.querySelectorAll(".publish button")].find((b) => b.textContent === "Send update")?.ariaDisabled`);
  assert.equal(await updateOff(), "true", "What's new is the published one's: empty, to be written");
  await fill(`What's new in ${version}`, "The first version: focus sessions.");
  await until(async () => /The same as the published version's/.test(await pane()), "the published text refused");
  await fill(`What's new in ${version}`, "A pause button, and a longer break after four sessions.");
  await until(async () => (await updateOff()) === "false", "Send update to be there to press");
  await shot("18-update");
  await press("Send update");
  await idle();
  const updated = github.pulls.find((one) => one.number === pull.number);
  assert.equal(updated.title, `Update ${await app.page(`document.querySelector("#publish-title").textContent.replace(/^Publish /, "")`)} to ${version}`);
  assert.match(github.filesOf(`${github.login}/busy-apps-catalog`, branch)[`applications/${id}/manifest.yml`], /changelog: "A pause button, and a longer break after four sessions\."/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")).changelog, "A pause button, and a longer break after four sessions.", "written into catalog.json too");

  // ---- Publish into a repository the person has already (catalog-update): offered, with what changes said first.
  github.makeRepo(github.login, "my-old-app");
  github.commitFiles(`${github.login}/my-old-app`, "main", { "NOTES.md": "mine\n" });
  await step("Publish to GitHub");
  await until(async () => /Publishing as/.test(await pane()), "the publish view");
  await fill("Repository", "my-old-app");
  await until(async () => /You have github\.com\/octo-person\/my-old-app already, not published from here\./.test(await pane()), "the repository offered");
  await press("Publish into my-old-app");
  await until(async () => /Publish into github\.com\/octo-person\/my-old-app\?/.test(await pane()), "the confirmation");
  assert.match(await pane(), /Also delete the file the project doesn't have\s+NOTES\.md\. Unless you tick this, it stays\./, "its README.md is the project's too");
  assert.match(await pane(), /with the project's \d+ files/);
  assert.match(await pane(), /Nothing is force-pushed\./);
  await shot("19-publish-into");
  await press("Cancel");
  assert.equal(github.filesOf(`${github.login}/my-old-app`, "main")["NOTES.md"], "mine\n", "nothing sent before the confirmation");
  await fill("Repository", repoName);
  await until(async () => /Publish again/.test(await pane()), "back to the app's own repository");

  for (const r of github.requests) assert.equal(r.path.includes(github.token), false, "the token is never in an address");
  assert.equal(github.requests.some((r) => JSON.stringify(r.headers).includes("dummy-env-token")), false, "the environment's GH_TOKEN never reached gh");

  // ---- Change account, then sign out: the app signed this account in to GitHub CLI; signed out of it too only with
  // the tick. The view says it is about the account, and leads back to Publish.
  await step("Publish to GitHub");
  await until(async () => /Publishing as/.test(await pane()), "the publish view");
  await press("Change account");
  await until(async () => /^Choose a GitHub account/.test(await pane()), "the account view");
  assert.ok(await where(`[...document.querySelectorAll(".publish button")].find((b) => b.textContent.trim() === "Back to Publish")`), "Back to Publish");
  assert.match(await pane(), /Signed in as/);
  assert.match(await pane(), /Also sign out GitHub CLI on this computer/);
  // GitHub CLI had no account before the emulator signed it in: the tick starts ticked (security review F3).
  assert.equal(await app.page(`document.querySelector('input[data-tick="signOutCli"]').checked`), true, "ticked by default");
  await shot("14-sign-out");
  await press("Back to Publish");
  await until(async () => /Publishing as/.test(await pane()), "back on the publish view");
  await press("Change account");
  await until(async () => /^Choose a GitHub account/.test(await pane()), "the account view again");
  await press("Sign out");
  await idle();
  assert.match(await said(), /GitHub CLI on this computer was signed out of it too\..*revoke GitHub CLI on github\.com\/settings\/applications/);
  assert.deepEqual(store(), {}, "gh forgot the token");
  await until(async () => /Sign in to GitHub/.test(await pane()), "the sign-in again");

  // ---- GitHub CLI on this computer signed in to two accounts (the person's own): both listed, either can be chosen.
  fakeSignedIn(path.join(app.folder, "person"), { login: github.login, token: github.token, standIn: github.base, accounts: { [github.login]: github.token, "octo-own": github.others["octo-own"] } });
  // Away and back: the step reads GitHub CLI again.
  await step("Build and package");
  await step("Publish to GitHub");
  await until(async () => /GitHub CLI on this computer is signed in to 2 accounts\. Choose the one to publish with\./.test(await pane()), "GitHub CLI's accounts offered");
  assert.match(await pane(), /octo-own/);
  assert.match(await pane(), /other programs, including AI agents, can use it too/);
  assert.match(await pane(), new RegExp(`Publishes as ${github.login}: the app's repository goes to github\.com/${github.login}\. Nothing is uploaded yet`), "what Use does, said beside it");
  await shot("15-use-existing");
  await press(`Use ${github.login}`);
  await idle();
  assert.match(await said(), new RegExp(`Signed in as ${github.login}, GitHub CLI's account on this computer\.`));
  assert.match(await pane(), /GitHub CLI's account on this computer/);
  await shot("16-existing-signed-in");
  await press("Change account");
  await until(async () => /^Choose a GitHub account/.test(await pane()), "the account view");
  assert.doesNotMatch(await pane(), /Also sign out GitHub CLI/, "an account GitHub CLI had is never signed out from here");
  await app.page(`(() => { document.querySelector('input[name="publish-account"][value="new"]').click(); return true; })()`);
  assert.ok(await where(`[...document.querySelectorAll(".publish button")].find((b) => b.textContent.trim() === "Sign in with another account")`));
  assert.match(await pane(), new RegExp(`added to GitHub CLI, which goes on using ${github.login}, and publishing uses it`));
  await shot("17-another-account");
  // Nothing of the emulator's was left in the project beyond what it said: .busy and submission are kept out of git.
  assert.ok(JSON.parse(readFileSync(path.join(dir, ".busy", "publish.json"), "utf8")).steps.package);
});
