// Install a package (.tgz) in the real shell, with the real server (create-app.js, the window's actions, the command
// line's install --check, the emulated BUSY Bar's API): the person chooses a package in Create app, the dialog that
// asks about it (the tests' stand-in answers) names the app, and the app is installed, started and listed as from a
// package; a broken archive is refused with its reason before anything is asked. Then Import from GitHub against a
// stand-in for GitHub on 127.0.0.1: a repository that is no app project but has a .tgz in its latest release offers
// to install it, and does; one with neither is refused with what was found.
//
// INSTALL_PACKAGE_SHOTS=<folder> saves pictures of the tabs at 1200×800 and 900×650.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { appPackage } from "../fixtures/app-package.mjs";
import { FAKE_GH, fakeSignedIn } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { HAS_REAL_SERVER, PORTS, removeFolder, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const SHOTS = process.env.INSTALL_PACKAGE_SHOTS || null;

let app;
let github;
let work;
after(async () => {
  await app?.close();
  await github?.close();
  if (work) await removeFolder(work);
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
const part = (name) => clickOn(`document.querySelector(${q(`.create-app [data-part='${name}']`)})`, `the ${name} button`);
// The click goes in as an input event and is handled later; while the pop-up still settles it can miss. So wait
// for the tab to be the chosen one, and click again if it is not.
async function way(id) {
  const chosen = () => app.page(`document.querySelector(".create-app-way.on")?.dataset.way === ${q(id)}`);
  for (let i = 0; i < 5 && !(await chosen()); i++) {
    await clickOn(`document.querySelector(${q(`.create-app-way[data-way='${id}']`)})`, `the way ${id}`);
    await until(chosen, `the way ${id} to be chosen`, 2_000, 50).catch(() => {});
  }
  assert.ok(await chosen(), `the way ${id} is chosen`);
}
const isOpen = () => app.page(`!(document.querySelector(".create-app-scrim")?.hidden ?? true)`);
const said = () => app.page(`document.querySelector(".create-app-said")?.textContent ?? ""`);
const pane = () => app.page(`document.querySelector(".create-app-pane")?.innerText ?? ""`);
const barApps = async () => (await (await fetch(`http://127.0.0.1:${app.port}/api/apps/list`)).json()).apps.map((one) => one.id);
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1200, 800],
    [900, 650],
  ]) {
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1] - 1), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `${name}-${w}x${h}.png`), Buffer.from(png, "base64"));
  }
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
}
async function openCreateApp() {
  await until(() => app.page(`document.querySelector("#create-app")?.ariaDisabled === "false"`), "Create app to be there to press", 120_000, 200);
  await clickOn(`[document.querySelector("#create-app"), document.querySelector("#apps .empty button")].find((b) => b && b.offsetParent !== null)`, "a Create app button");
  await until(isOpen, "the pop-up");
}

test("Install a package: chosen in the dialog, asked about by name, id and version, installed, started and listed as from a package; a broken archive refused with its reason", { skip, timeout: 600_000 }, async () => {
  work = realpathSync(temporaryFolder());
  github = await startGithubStub({ port: PORTS.unit });
  app = await launch({ server: "real", welcomed: true, env: { BUSY_EMULATOR_GH: FAKE_GH, BUSY_EMULATOR_FAKE_GH_STAND_IN: github.base, BUSY_EMULATOR_FAKE_GH_POLL_MS: "1000", BUSY_EMULATOR_GITHUB_DOWNLOADS: github.base } });
  await app.waitWindow("device");
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
  const downloads = path.join(work, "Downloads");
  mkdirSync(downloads, { recursive: true });
  const good = path.join(downloads, "clock-1.2.0.tgz");
  writeFileSync(good, appPackage());
  const broken = path.join(downloads, "broken.tgz");
  writeFileSync(broken, Buffer.from("this is no archive at all, only text"));

  await openCreateApp();
  await way("package");
  await until(async () => /reads its manifest and checks it the way the BUSY Bar does/.test(await pane()), "the package pane", 10_000, 50);
  await shot("1-package");
  // A broken archive: the command line's reason, and no question.
  await app.run((shell, _electron, file) => shell.folderDialogs.standIn(file), broken);
  await part("install-package");
  await until(async () => /The package cannot be read: the archive ends before its end, or is no archive\./.test(await said()), "the reason a broken archive is refused", 60_000, 200);
  assert.deepEqual(await app.run((shell) => shell.offScreen.asked.length), 0, "nothing asked");
  await shot("2-package-broken");

  // A good one: the question names it, the stand-in says yes, and it runs.
  await app.run((shell, _electron, file) => shell.folderDialogs.standIn(file), good);
  await app.run((shell) => shell.packageAnswer("yes"));
  await part("install-package");
  await until(async () => !(await isOpen()), "the pop-up gone after the install", 120_000, 300);
  const asked = await app.run((shell) => shell.offScreen.asked.at(-1));
  assert.equal(asked.message, "Install this app package?");
  for (const words of ["clock-1.2.0.tgz", "App: Clock (app.tester.clock), version 1.2.0", "From: a file on this computer", "someone else's code"]) assert.ok(asked.detail.includes(words), words);
  assert.ok((await barApps()).includes("app.tester.clock"), "on the emulated BUSY Bar");
  await until(() => app.page(`document.body.innerText.includes("from a package")`), "listed as from a package", 30_000, 300);
});

test("Import from GitHub: a repository with no app project but a release .tgz offers to install it and does; one with neither is refused with what was found", { skip, timeout: 600_000 }, async () => {
  fakeSignedIn(path.join(app.folder, "person"), { login: github.login, token: github.token, standIn: github.base });
  github.makeRepo(github.login, "bar-release");
  github.addRelease(`${github.login}/bar-release`, "v2.1.0", { "notes.txt": "x", "app.tester.timer.tgz": appPackage({ id: "app.tester.timer", name: "Timer", version: "2.1.0" }) });
  github.makeRepo(github.login, "just-docs");
  github.addRelease(`${github.login}/just-docs`, "v1.0.0", { "docs.zip": "z" });

  await openCreateApp();
  await way("github");
  await until(async () => new RegExp(`Use ${github.login}`).test(await pane()), "GitHub CLI's account offered", 60_000, 200);
  await clickOn(`[...document.querySelectorAll(".create-app button")].find((b) => b.textContent.trim() === ${q(`Use ${github.login}`)})`, "Use <login>");
  await until(async () => new RegExp(`Reads as ${github.login}`).test(await pane()), "the account in use", 60_000, 200);
  const typeRepo = (value) => app.page(`(() => { const el = document.querySelector(".create-app [data-part=repo]"); el.value = ${q(value)}; el.dispatchEvent(new Event("input")); return true; })()`);

  await typeRepo(`${github.login}/just-docs`);
  await until(async () => /has no app project \(no src\/appmeta\/manifest\.json\), and its latest release v1\.0\.0 has no \.tgz file, only docs\.zip\./.test(await pane()), "what was found said", 60_000, 200);
  assert.equal(await app.page(`document.querySelector(".create-app [data-part=import]")?.ariaDisabled`), "true", "nothing to import");
  await shot("3-github-nothing");

  await typeRepo(`https://github.com/${github.login}/bar-release`);
  await until(async () => /Install the release package app\.tester\.timer\.tgz \(v2\.1\.0\)/.test(await pane()), "the release package offered", 60_000, 200);
  await until(() => app.page(`document.querySelector(".create-app [data-part=install-release]")?.ariaDisabled === "false"`), "Install to be there to press");
  await shot("4-github-release");
  await app.run((shell) => shell.packageAnswer("yes"));
  await part("install-release");
  await until(async () => !(await isOpen()), "the pop-up gone after the install", 120_000, 300);
  const asked = await app.run((shell) => shell.offScreen.asked.at(-1));
  assert.ok(asked.detail.startsWith(`app.tester.timer.tgz, from the release v2.1.0 of github.com/${github.login}/bar-release\n`), asked.detail);
  assert.ok(asked.detail.includes("App: Timer (app.tester.timer), version 2.1.0"));
  assert.ok((await barApps()).includes("app.tester.timer"), "on the emulated BUSY Bar");
  for (const r of github.requests) assert.equal(r.path.includes(github.token), false, "the token is never in an address");
});
