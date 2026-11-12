// Create app's Open existing in the real shell (create-app.js, the window's actions, project-root.mjs): the person
// chooses a file deep in a project the emulator did not create, the pop-up shows the project found around it, Open
// asks the trust dialog (the tests' stand-in answers it) and the project is listed, trusted and chosen; a folder of
// no project is said plainly. With the real server; no network needed.
//
// Then Import from GitHub against a stand-in for GitHub on 127.0.0.1 (never github.com): an address of another host
// refused, a repository found, downloaded through the stand-in for GitHub CLI and opened through the trust dialog.
//
// CREATE_APP_SHOTS=<folder> also saves a picture of every tab at 1200×800 and 900×650.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { FAKE_GH, fakeSignedIn } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { HAS_REAL_SERVER, PORTS, removeFolder, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.CREATE_APP_SHOTS || null;

let app;
let work;
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

const q = (text) => JSON.stringify(text);
const chooses = (answer) => app.run((shell, _electron, chosen) => shell.folderDialogs.standIn(chosen), answer);
/** A click of the mouse at the middle of an element the page's code finds, brought into view first: the person's. */
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
const part = (name) => clickOn(`document.querySelector(${q(`.create-app [data-part='${name}']`)})`, `the ${name} button`);
const way = (id) => clickOn(`document.querySelector(${q(`.create-app-way[data-way='${id}']`)})`, `the way ${id}`);
const isOpen = () => app.page(`!(document.querySelector(".create-app-scrim")?.hidden ?? true)`);
const result = () => app.page(`(() => { const r = document.querySelector(".create-app-result"); return r ? { kind: r.classList.contains("found") ? "found" : "none", text: r.innerText } : null; })()`);
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1200, 800],
    [900, 650],
  ]) {
    // A hidden window paints again when its size changes: one pixel less first.
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1] - 1), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `${name}-${w}x${h}.png`), Buffer.from(png, "base64"));
  }
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
}

test("Open existing: a file deep in a stranger's project finds it; Open asks the trust dialog, then the project is listed and chosen; a folder of nothing is said", { skip, timeout: 600_000 }, async () => {
  work = realpathSync(temporaryFolder());
  const project = path.join(work, "cloned", "pomodoro");
  for (const dir of ["src/appmeta", "src/scripts", "src/assets"]) mkdirSync(path.join(project, dir), { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "pomodoro", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(project, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.stranger.pomodoro", name: "Pomodoro" }));
  writeFileSync(path.join(project, "src", "scripts", "main.js"), "// the app\n");
  const nested = path.join(project, "src", "assets", "tomato.png");
  writeFileSync(nested, "png");
  const pictures = path.join(work, "Pictures");
  mkdirSync(pictures, { recursive: true });

  app = await launch({ server: "real", welcomed: true, env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust" } });
  await app.waitWindow("device");
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
  await until(() => app.page(`document.querySelector("#create-app")?.ariaDisabled === "false"`), "Create app to be there to press");
  await clickOn(`[document.querySelector("#create-app"), document.querySelector("#apps .empty button")].find((b) => b && b.offsetParent !== null)`, "a Create app button");
  await until(isOpen, "the pop-up");

  // The dialog sits in the middle of the window, not over all of it; the tabs are one row at its top.
  const layout = await app.page(`(() => {
    const d = document.querySelector(".create-app").getBoundingClientRect();
    const tabs = [...document.querySelectorAll(".create-app-way")].map((t) => t.getBoundingClientRect());
    return { width: d.width, left: d.left, right: innerWidth - d.right, rows: new Set(tabs.map((t) => Math.round(t.top))).size, names: [...document.querySelectorAll(".create-app-way")].map((t) => t.textContent) };
  })()`);
  assert.ok(layout.width <= 840.5 && Math.abs(layout.left - layout.right) <= 1, JSON.stringify(layout)); // a fraction of a pixel over at a display scale of 125 % or 150 % (Windows)
  assert.deepEqual([layout.rows, layout.names], [1, ["Templates", "Empty app", "Open existing", "Import from GitHub", "Install a package"]]);
  await until(() => app.page(`document.querySelectorAll(".create-app-card").length >= 1`), "the template cards");
  await shot("1-templates");
  await clickOn(`[...document.querySelectorAll(".create-app-card")].at(-1)`, "a template card");
  await shot("2-template-chosen");
  await way("empty");
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part=upload-front]"))`), "the empty app's form");
  // The icon block's Uploads: a button each with the upload icon and its words, the Local Web's 36 px; 44 px inputs.
  assert.deepEqual(await app.page(`(() => { const b = document.querySelector(".create-app [data-part=upload-front]"); return [b.innerText.trim(), Boolean(b.querySelector("use[href$='#bi-upload']")), b.getBoundingClientRect().height, document.querySelector(".create-app [data-part=name]").getBoundingClientRect().height]; })()`).then(([words, icon, button, height]) => [words, icon, Math.round(button), Math.round(height)]), ["Upload", true, 36, 44]); // rounded: display scaling gives a fraction over
  await shot("3-empty");
  await clickOn(`[...document.querySelectorAll(".create-app button")].find((b) => b.textContent.trim() === "Advanced")`, "Advanced");
  await shot("4-empty-advanced");
  await way("github");
  await shot("5-github");

  // ---- Open existing
  await way("open");
  await until(() => app.page(`Boolean(document.querySelector(".create-app [data-part^=choose-]"))`), "Choose");
  assert.equal(await app.page(`document.querySelector(".create-app [data-part=open]").ariaDisabled`), "true");
  await shot("6-open");
  const chooseButton = await app.page(`document.querySelector(".create-app [data-part^=choose-]").dataset.part`);
  assert.equal(chooseButton, process.platform === "darwin" ? "choose-any" : "choose-folder");

  // A folder of no project: said plainly.
  await chooses(pictures);
  await part(chooseButton);
  await until(async () => (await result())?.kind === "none", "nothing found");
  assert.equal((await result()).text.trim(), "No BUSY app found in this folder or above it.");
  await shot("7-open-none");

  // A file deep in the project: the project around it.
  await chooses(nested);
  await part(chooseButton);
  await until(async () => (await result())?.kind === "found", "the project found");
  const found = (await result()).text;
  assert.match(found, /Pomodoro/);
  assert.match(found, /app\.stranger\.pomodoro/);
  assert.match(found, /Found in a folder above what you chose/);
  assert.match(await app.page(`document.querySelector(".create-app-pane").innerText`), /asks whether you trust this folder/);
  await shot("8-open-found");
  assert.deepEqual(await app.page(`window.emulatorActions.projects.list().then((list) => list.length)`), 0, "nothing opened yet");

  await part("open");
  await until(() => /trust question about .*pomodoro: answered by the test's stand-in \(trust\)/.test(app.log()), "the trust dialog asked about the project's folder", 60_000, 200);
  await until(async () => !(await isOpen()), "the pop-up gone", 300_000, 500);
  const listed = await app.page(`window.emulatorActions.projects.list().then((list) => list.map((p) => [p.folder, p.id, p.trusted]))`);
  assert.deepEqual(listed, [[project, "app.stranger.pomodoro", true]]);
  await until(() => app.page(`document.querySelector("#app-title")?.textContent === "Pomodoro"`), "the project chosen in Apps");
});

test("Import from GitHub: another host's address refused; a repository downloaded through GitHub CLI as the account chosen, then opened through the trust dialog (catalog-update)", { skip, timeout: 600_000 }, async () => {
  await app?.close();
  const github = await startGithubStub({ port: PORTS.unit });
  try {
    app = await launch({ server: "real", welcomed: true, env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust", BUSY_EMULATOR_GH: FAKE_GH, BUSY_EMULATOR_FAKE_GH_STAND_IN: github.base, BUSY_EMULATOR_FAKE_GH_POLL_MS: "1000" } });
    // GitHub CLI on this computer (the test's own configuration) has the person's account; the repository is theirs.
    fakeSignedIn(path.join(app.folder, "person"), { login: github.login, token: github.token, standIn: github.base });
    github.makeRepo(github.login, "pomodoro-timer");
    github.commitFiles(`${github.login}/pomodoro-timer`, "main", { "package.json": JSON.stringify({ name: "pomodoro", devDependencies: { "@busy-app/cli": "^0.6.0" } }), "src/appmeta/manifest.json": JSON.stringify({ id: "app.octo.pomodoro", name: "Pomodoro", version: "1.2.0" }), "src/scripts/main.js": "// the app\n" });
    await app.waitWindow("device");
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
    await until(() => app.page(`document.querySelector("#create-app")?.ariaDisabled === "false"`), "Create app to be there to press");
    await clickOn(`[document.querySelector("#create-app"), document.querySelector("#apps .empty button")].find((b) => b && b.offsetParent !== null)`, "a Create app button");
    await until(isOpen, "the pop-up");
    await way("github");
    const pane = () => app.page(`document.querySelector(".create-app-pane")?.innerText ?? ""`);
    const importOff = () => app.page(`document.querySelector(".create-app [data-part=import]")?.title ?? null`);
    await until(async () => new RegExp(`Use ${github.login}`).test(await pane()), "GitHub CLI's account offered");
    assert.equal(await importOff(), "Sign in to GitHub first");
    await clickOn(`[...document.querySelectorAll(".create-app button")].find((b) => b.textContent.trim() === ${q(`Use ${github.login}`)})`, "Use <login>");
    // Through GitHub CLI's stand-in, a program of its own for each question: on a machine busy with other gates it
    // took longer than the default 15 s (the release's gate, 12.11).
    await until(async () => new RegExp(`Reads as ${github.login}`).test(await pane()), "the account in use", 60_000);
    const typeRepo = (value) => app.page(`(() => { const el = document.querySelector(".create-app [data-part=repo]"); el.value = ${q(value)}; el.dispatchEvent(new Event("input")); return true; })()`);
    await typeRepo("https://gitlab.com/someone/pomodoro");
    await until(async () => /Only repositories on github\.com can be imported\./.test(await pane()), "another host refused");
    await shot("9-github-not-github");
    await typeRepo(`https://github.com/${github.login}/pomodoro-timer`);
    await until(async () => /Pomodoro 1\.2\.0, public, from its branch main\./.test(await pane()), "the repository found");
    await until(async () => (await importOff()) === "", "Import to be there to press");
    assert.match(await app.page(`document.querySelector(".create-app-place:not(.create-app-account) .path").textContent`), /pomodoro-timer$/);
    await shot("10-github-found");
    await clickOn(`document.querySelector(".create-app [data-part=import]")`, "Import");
    await until(() => /trust question about .*pomodoro-timer: answered by the test's stand-in \(trust\)/.test(app.log()), "the trust dialog asked about the new folder", 120_000, 200);
    await until(async () => !(await isOpen()), "the pop-up gone", 300_000, 500);
    const folder = path.join(realpathSync(path.join(app.folder, "test-home", "BUSY Bar projects")), "pomodoro-timer");
    assert.equal(readFileSync(path.join(folder, "src", "scripts", "main.js"), "utf8"), "// the app\n");
    assert.ok(existsSync(path.join(folder, "README.md")));
    const listed = await app.page(`window.emulatorActions.projects.list().then((list) => list.map((p) => [p.folder, p.id, p.trusted]))`);
    assert.deepEqual(listed, [[folder, "app.octo.pomodoro", true]]);
    const record = JSON.parse(readFileSync(path.join(app.folder, "github", "published.json"), "utf8"));
    assert.deepEqual(record[folder].imported, { owner: github.login, name: "pomodoro-timer", commit: github.headOf(`${github.login}/pomodoro-timer`, "main") });
    for (const r of github.requests) assert.equal(r.path.includes(github.token), false, "the token is never in an address");
  } finally {
    await github.close();
  }
});
