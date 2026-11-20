// The top bar's account menu: signed in, its Switch account… and Add account… open Publish for the open app on
// Choose a GitHub account, with another account to choose, or with "Another account" chosen to sign in with it. With
// the real server, the stand-in for GitHub CLI and the stand-in for GitHub (never github.com, never the person's
// ~/.config/gh: gh's configuration is a folder of the test's); the project has a stand-in for busy-cli.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "./node-test.mjs";

import { FAKE_GH, fakeSignedIn } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { HAS_REAL_SERVER, PORTS, removeFolder, targz, temporaryFolder, until } from "../helpers.mjs";
import { DEVICE_MIN_SIZE as DEVICE_MIN } from "../../src/windows.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
const EMULATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const ID = "app.example.meeting_cost";

const BUSY_CLI = `
console.log("busy-cli stand-in: " + process.argv.slice(2).join(" "));
`;

let app;
let github;
let work;
let data;
let dir;
const q = (text) => JSON.stringify(text);
const page = (code) => app.page(code);

function filesOf(folder, prefix = "") {
  const out = {};
  for (const name of readdirSync(folder)) {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) Object.assign(out, filesOf(full, `${prefix}${name}/`));
    else out[`${prefix}${name}`] = readFileSync(full);
  }
  return out;
}

before(async () => {
  if (skip) return;
  work = realpathSync(temporaryFolder());
  data = temporaryFolder();
  github = await startGithubStub({ port: PORTS.unit });
  // GitHub CLI (the stand-in) signed in to two accounts before the app starts.
  fakeSignedIn(path.join(data, "person"), { login: github.login, token: github.token, standIn: github.base, accounts: { [github.login]: github.token, "octo-own": github.others["octo-own"] } });
  // The Meeting Cost example as a project of the emulator, its app on the bar.
  dir = path.join(work, "meeting-cost");
  cpSync(path.join(EMULATOR, "examples", "meeting-cost"), dir, { recursive: true });
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(cli, { recursive: true });
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", type: "module", bin: { "busy-cli": "cli.mjs" } }));
  writeFileSync(path.join(cli, "cli.mjs"), BUSY_CLI);
  dir = realpathSync(dir);
  const old = Date.now() / 1000 - 120;
  for (const rel of Object.keys(filesOf(dir))) utimesSync(path.join(dir, rel), old, old);
  const stat = statSync(dir, { bigint: true });
  mkdirSync(path.join(data, "projects"), { recursive: true });
  writeFileSync(path.join(data, "projects", "trusted.json"), JSON.stringify({ version: 2, projects: [{ path: dir, dev: String(stat.dev), ino: String(stat.ino), how: "created", at: new Date().toISOString() }] }));
  writeFileSync(path.join(data, "projects", "registry.json"), JSON.stringify({ version: 1, projects: [{ path: dir, volume: path.parse(dir).root, id: ID, name: "Meeting Cost", at: new Date().toISOString(), installed: { id: ID, mark: "test", at: new Date().toISOString() } }] }));

  app = await launch({ server: "real", welcomed: true, dataDir: data, env: { BUSY_EMULATOR_GH: FAKE_GH, BUSY_EMULATOR_FAKE_GH_STAND_IN: github.base } });
  await app.waitWindow("device");
  await until(() => page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected");
  const files = {};
  for (const [rel, bytes] of Object.entries(filesOf(path.join(dir, "src")))) if (!rel.endsWith(".ts")) files[`${ID}/${rel}`] = bytes;
  files[`${ID}/scripts/main.js`] = "listen('input', () => {});";
  const bytes = targz(files).toString("base64");
  const installed = await page(`(async () => {
    const body = Uint8Array.from(atob(${q(bytes)}), (c) => c.charCodeAt(0));
    const stage = await fetch("/api/apps/stage", { method: "POST", body });
    const key = JSON.parse(await stage.text()).install_key;
    return (await fetch("/api/apps/install?install_key=" + key, { method: "POST" })).status;
  })()`);
  assert.equal(installed, 200);
  await page(`document.querySelector("#refresh-apps").click(), true`);
  await until(() => page(`Boolean(document.querySelector('#apps li.app[data-id="${ID}"]'))`), "the project listed");
  await page(`document.querySelector('#apps li.app[data-id="${ID}"]').click(), true`);
  await until(() => page(`Boolean(document.querySelector("#app-folder .ac-path"))`), "the app open");
  // The emulator signed in with GitHub CLI's account (Publish's "Use octo-person"), then the window reads it again.
  await app.press();
  const used = await page(`window.emulatorActions.github.useExisting(${q(github.login)}).then((answer) => answer?.ok !== false, (e) => String(e.code ?? e))`);
  assert.equal(used, true);
  await page(`(dispatchEvent(new Event("focus")), true)`);
});
after(async () => {
  await app?.close();
  await github?.close();
  if (work) await removeFolder(work);
  if (data) await removeFolder(data);
});

/** The account menu's items, opened; and a click on one of them by its words. */
const items = () => page(`[...document.querySelectorAll(".row-menu .menu-item")].map((item) => item.textContent.trim())`);
async function pick(words) {
  await page(`document.querySelector("#account").click(), true`);
  await until(async () => (await items()).includes(words), `the account menu with ${words}`);
  await app.click(`.row-menu .menu-item:nth-child(${(await page(`[...document.querySelector(".row-menu").children].findIndex((item) => item.textContent.trim() === ${q(words)})`)) + 1})`);
}
/** The page at 900 high, or a pixel less: a display's scale (Windows at 175 %) rounds the size in device pixels down. */
/**
 * Waits until a resize has come to the page: its height over `above` and the same for 300 ms. The number itself is the
 * window's own (Windows' display scaling and its title bar in the page make it differ from the size asked).
 */
async function settled(above = 0) {
  let last = -1;
  let since = Date.now();
  await until(async () => {
    const height = await page(`innerHeight`);
    if (height !== last) [last, since] = [height, Date.now()];
    return height > above && Date.now() - since >= 300;
  }, "the window's new size in the page");
}
/** Closes an open menu (the top bar's or a row's) as the window does it, by Escape in it. */
const closeMenu = async () => {
  await page(`(document.querySelector(".row-menu")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true)`);
  await until(() => page(`!document.querySelector(".row-menu")`), "the menu closed");
};
const pane = () => page(`document.querySelector(".publish .publish-pane, .publish")?.innerText.trim() ?? ""`);
const closePublish = async () => {
  await page(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), true)`);
  await until(() => page(`!document.querySelector(".publish-scrim") || document.querySelector(".publish-scrim").hidden`), "Publish closed");
};

/** What is wrong with the top bar now: every word shown and whole (Report a Bug, the two documentation links, the
    account's name), nothing over another, all of it inside the window. */
const TOP_PROBLEMS = `(() => {
  const problems = [];
  const shown = (el) => el && !el.closest("[hidden]") && getComputedStyle(el).display !== "none";
  for (const selector of ["#report-bug span", "#docs-emulator span", "#docs-js-apps span", "#account-name"]) {
    const el = document.querySelector(selector);
    if (!shown(el)) problems.push(selector + " is not shown");
    else if (el.scrollWidth > el.clientWidth + 1) problems.push(selector + " is cut");
  }
  const items = [".brand", "#report-bug", "#docs-emulator", "#docs-js-apps", "#shot-float", "#canvas-tools-top", "#update-note", "#account", "#publish"]
    .map((selector) => [selector, document.querySelector(selector)]).filter(([, el]) => shown(el)).map(([selector, el]) => [selector, el.getBoundingClientRect()]);
  for (const [name, r] of items) if (r.left < 0 || r.right > innerWidth) problems.push(name + " is outside the window: " + Math.round(r.left) + " to " + Math.round(r.right));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const [a, x] = items[i];
    const [b, y] = items[j];
    if (x.left < y.right - 0.5 && y.left < x.right - 0.5) problems.push(a + " overlaps " + b);
  }
  return problems;
})()`;

test("signed in, the account button shows the login with GitHub's mark; its menu has Switch account… and Add account…", { skip }, async (t) => {
  await until(() => page(`!document.querySelector("#account").hidden && document.querySelector("#account-name").textContent === ${q(github.login)}`), "the account button");
  assert.equal(await page(`document.querySelector("#account-avatar").dataset.mark`), "github");
  // The account button came after the page: the top bar still fits, nothing over another, Publish inside, down to the
  // smallest window; above 1300 with every word (Report a Bug, the documentation links, the account's name). Below, the
  // words give way (window.css, "smaller windows"): with every word the top bar needs more than 1140.
  for (const [w, h] of [[1440, 900], [1320, 800], [1300, 800], [1200, 800], [1140, 650]]) {
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await until(() => page(`(() => { const top = document.querySelector(".topbar"); const p = document.querySelector("#publish").getBoundingClientRect(); return p.right <= innerWidth && top.scrollWidth <= top.clientWidth + 1; })()`), `Publish inside the window at ${w}×${h}`, 5000, 200);
    const problems = await page(TOP_PROBLEMS);
    assert.deepEqual(w > 1300 ? problems : problems.filter((one) => !/ is not shown$/.test(one)), [], `the top bar at ${w}×${h}`);
  }
  // What the top bar needs with every word, at 1440: with this login, and with a name as long as the button shows (140).
  await app.run((shell) => shell.windows.current.win.setContentSize(1440, 900));
  const need = `new Promise((resolve) => requestAnimationFrame(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); resolve(Math.round(innerWidth - (r(".top-tools").left - r("#docs-js-apps").right + r(".top-end").left - r(".top-tools").right - 32))); }))`;
  const name = await page(`document.querySelector("#account-name").textContent`);
  const needs = [await page(need)];
  await page(`(document.querySelector("#account-name").textContent = "a-github-login-of-thirty-nine-characters", true)`);
  needs.push(await page(need));
  await page(`(document.querySelector("#account-name").textContent = ${q(name)}, true)`);
  t.diagnostic(`with every word the top bar needs ${needs[0]} px with ${name}, ${needs[1]} with a name at its 140`);
  await page(`document.querySelector("#account").click(), true`);
  await until(async () => (await items()).length > 0, "the account menu");
  assert.deepEqual(await items(), ["Open on GitHub", "Switch account…", "Add account…", "Sign out"]);
  await page(`(document.querySelector(".row-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true)`);
  await until(() => page(`!document.querySelector(".row-menu")`), "the account menu closed by Escape");
});

// EMU-327: the top bar with the account and the update's line, in each of its states, with a long version; at 1440 and
// at the smallest window. A failed update was "Version …" and "Try again: …" side by side, about 1675 px of top bar:
// now it is one short button, Update failed, whose menu says why and offers Try again and the download page.
test("signed in, with the update's line in every state and a long version: the top bar fits at 1440 and at the smallest window", { skip }, async (t) => {
  const VERSION = "10.10.10-beta.10";
  const tell = (state) => app.run((shell, _electron, state) => shell.windows.current.win.webContents.send("busy-shell-job", { update: true, current: "0.1.0", canInstall: true, version: state.version, ...state }), state);
  const STATES = {
    available: { state: "available", version: VERSION },
    downloading: { state: "downloading", version: VERSION, received: 99, total: 100 },
    downloaded: { state: "downloading", version: VERSION, received: 100, total: 100 },
    ready: { state: "ready", version: VERSION },
    failed: { state: "failed", version: VERSION, code: "failed", message: `The update to ${VERSION} did not finish: the download stopped.`, hint: "Try again, or download the new version from the release page." },
  };
  await until(() => page(`!document.querySelector("#account").hidden`), "the account button");
  try {
    for (const [w, h] of [[1440, 900], [DEVICE_MIN.minWidth, DEVICE_MIN.minHeight]]) {
      await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
      for (const [name, state] of Object.entries(STATES)) {
        await tell(state);
        await until(() => page(`!document.querySelector("#update-note").hidden`), `the update's line, ${name}`);
        await page("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
        const problems = await page(TOP_PROBLEMS);
        assert.deepEqual(w > 1300 ? problems : problems.filter((one) => !/ is not shown$/.test(one)), [], `the top bar, ${name}, at ${w}×${h}`);
        const fit = await page(`(() => { const top = document.querySelector(".topbar"); const note = document.querySelector("#update-note").getBoundingClientRect(); const p = document.querySelector("#publish").getBoundingClientRect(); return { runs: top.scrollWidth > top.clientWidth + 1, publish: p.right <= innerWidth, note: Math.round(note.width), words: document.querySelector("#update-note").innerText.trim() }; })()`);
        assert.equal(fit.runs, false, `the top bar runs out, ${name}, at ${w}×${h}`);
        assert.equal(fit.publish, true, `Publish inside, ${name}, at ${w}×${h}`);
        t.diagnostic(`${name} at ${w}×${h}: "${fit.words}", ${fit.note} px`);
      }
    }
    // Failed: one control, the warning's color, its words short; its menu says why and what to do. (Its color is read
    // without the change's transition: a hidden window does not run them to their end.)
    const failed = await page(`(() => { const go = document.querySelector("#update-go"); go.style.transition = "none"; return { link: document.querySelector("#update-link").hidden, words: go.innerText.trim(), popup: go.getAttribute("aria-haspopup"), color: getComputedStyle(go).color }; })()`);
    assert.deepEqual(failed, { link: true, words: "Update failed", popup: "menu", color: "rgb(253, 199, 0)" });
    await app.click("#update-go");
    await until(() => page(`Boolean(document.querySelector(".update-menu"))`), "the failed update's menu");
    const menu = await page(`(() => { const el = document.querySelector(".update-menu"); const r = el.getBoundingClientRect(); return { head: el.querySelector(".menu-head").innerText, items: [...el.querySelectorAll(".menu-item")].map((i) => i.textContent.trim()), page: el.querySelector("a.menu-item").href, inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }; })()`);
    assert.deepEqual(menu, { head: `${STATES.failed.message}\n${STATES.failed.hint}`, items: [`Try again: update to ${VERSION}`, "Open the download page"], page: `https://github.com/busy-app/busybar-emulator/releases/tag/v${VERSION}`, inside: true });
    await page(`(document.querySelector(".update-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), true)`);
    await until(() => page(`!document.querySelector(".update-menu")`), "the menu closed by Escape");
  } finally {
    await tell({ state: "none", version: null });
    await app.run((shell) => shell.windows.current.win.setContentSize(1440, 900));
  }
});

// The top bar's menus (the failed update's, the account's) from the keyboard, as the window's other menus: the keys in
// them are theirs, never the BUSY Bar's (Enter, the arrows, Escape would press OK, turn the wheel, press Back); Escape
// gives the focus back to the button; the button says whether its menu is open; a second press of the button, the
// window's resize and, for the update's, a new state close it. (From the review of PR 202.)
test("the top bar's menus from the keyboard: their keys are theirs, not the BUSY Bar's; Escape gives the focus back; a press of the button, a resize and a new state close them", { skip }, async () => {
  const VERSION = "10.10.10-beta.10";
  const tell = (state) => app.run((shell, _electron, state) => shell.windows.current.win.webContents.send("busy-shell-job", { update: true, current: "0.1.0", canInstall: true, ...state }), state);
  const failed = { state: "failed", version: VERSION, code: "failed", message: "The update failed.", hint: "Download the new version from the release page instead." };
  const key = (keyCode) =>
    app.run((shell, _electron, keyCode) => {
      const contents = shell.windows.current.win.webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode });
      contents.sendInputEvent({ type: "char", keyCode });
      contents.sendInputEvent({ type: "keyUp", keyCode });
    }, keyCode);
  const look = (button) => page(`(() => { const menu = document.querySelector(".row-menu"); const items = menu ? [...menu.querySelectorAll(".menu-item")] : []; return { open: Boolean(menu), focus: document.activeElement?.id || items.indexOf(document.activeElement), expanded: document.querySelector(${q(button)}).getAttribute("aria-expanded"), keys: window.__barKeys.slice() }; })()`);
  await app.run((shell) => shell.windows.current.win.setContentSize(1440, 900));
  await settled(); // a resize that comes late would close the menu the test opens
  await tell(failed);
  await until(() => page(`document.querySelector("#update-go-text")?.textContent === "Update failed"`), "Update failed");
  // The BUSY Bar's keys the page sends from now on.
  await page(`(() => { window.__barKeys = []; if (!window.__barKeysNoted) { window.__barKeysNoted = true; const real = window.fetch; window.fetch = (url, init) => { if (["/_emu/key", "/api/input"].some((p) => String(url).includes(p))) window.__barKeys.push(String(url)); return real(url, init); }; } return true; })()`);
  await app.run((shell) => shell.windows.current.win.webContents.focus());
  try {
    for (const button of ["#update-go", "#account"]) {
      await page(`(document.querySelector(${q(button)}).focus(), true)`);
      assert.equal((await look(button)).expanded, "false", `${button} closed`);
      await key("Return");
      await until(async () => (await look(button)).open, `${button}: the menu opened by Enter`);
      assert.deepEqual(await look(button), { open: true, focus: 0, expanded: "true", keys: [] }, `${button}: opened from the keyboard, its first item has the focus`);
      // Each key's effect is waited for: the input goes to the page on its own time.
      await key("Down");
      await until(async () => (await look(button)).focus === 1, `${button}: Down moves the focus`, 3000);
      assert.deepEqual(await look(button), { open: true, focus: 1, expanded: "true", keys: [] }, `${button}: Down`);
      await key("Home");
      await until(async () => (await look(button)).focus === 0, `${button}: Home`, 3000);
      await key("End");
      await until(async () => (await look(button)).focus > 0, `${button}: End`, 3000);
      await key("Escape");
      await until(async () => !(await look(button)).open, `${button}: Escape closes it`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(await look(button), { open: false, focus: button.slice(1), expanded: "false", keys: [] }, `${button}: no key of the BUSY Bar, the focus back on the button`);
      // With the pointer: a second press of the button closes it; so does the window's resize.
      await app.click(button);
      await until(async () => (await look(button)).open, `${button}: opened with the pointer`);
      await app.click(button);
      await until(async () => !(await look(button)).open, `${button}: closed by its button`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal((await look(button)).open, false, `${button}: the press that closed it did not open it again`);
      await app.click(button);
      await until(async () => (await look(button)).open, `${button}: open again`);
      await app.run((shell) => shell.windows.current.win.setContentSize(1440, 870));
      await until(async () => !(await look(button)).open, `${button}: closed by the resize`);
      const low = await page(`innerHeight`);
      await app.run((shell) => shell.windows.current.win.setContentSize(1440, 900));
      // The resize back has come to the page before the next press (it would close the menu that press opens).
      await settled(low);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    // A new state of the update while its menu is open: the menu goes (it said the old one).
    await app.click("#update-go");
    await until(async () => (await look("#update-go")).open, "the update's menu open");
    await tell({ ...failed, message: "The update failed again.", code: "network" });
    await until(async () => !(await look("#update-go")).open, "the update's menu closed by the new state");
    assert.deepEqual((await look("#update-go")).keys, []);
  } finally {
    await closeMenu();
    await tell({ state: "none", version: null });
  }
});

// From the review of PR 202: the press that closes a menu on its button was noted until a click came; let go elsewhere
// (no click), it ate the next click on the button. And the update's menu stayed open, saying a failure that was gone,
// when the update's line went away (the state none).
test("the top bar's menus: a press on the button let go elsewhere closes the menu, and the next click or Enter opens it; the update's menu goes with the update's line", { skip }, async () => {
  const tell = (state) => app.run((shell, _electron, state) => shell.windows.current.win.webContents.send("busy-shell-job", { update: true, current: "0.1.0", canInstall: true, ...state }), state);
  const open = () => page(`Boolean(document.querySelector(".row-menu"))`);
  // Pressed on the button, the pointer taken down to the console and let go there.
  const pressAway = async (button) => {
    const at = await page(`(() => { const r = document.querySelector(${q(button)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), awayY: innerHeight - 20 }; })()`);
    await app.run((shell, _electron, at) => shell.windows.current.win.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 }), at);
    await until(async () => !(await open()), `${button}: the press closed its menu`);
    await app.run((shell, _electron, at) => {
      const contents = shell.windows.current.win.webContents;
      contents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.awayY, button: "left" });
      contents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.awayY, button: "left", clickCount: 1 });
    }, at);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await open(), false, `${button}: let go elsewhere, nothing opened`);
  };
  await app.run((shell) => shell.windows.current.win.setContentSize(1440, 900));
  await settled();
  await tell({ state: "failed", version: "10.10.10-beta.10", code: "failed", message: "The update failed.", hint: "Download the new version from the release page instead." });
  await until(() => page(`document.querySelector("#update-go-text")?.textContent === "Update failed"`), "Update failed");
  try {
    for (const button of ["#update-go", "#account"]) {
      await app.click(button);
      await until(open, `${button}: its menu open`);
      await pressAway(button);
      await app.click(button);
      await until(open, `${button}: the next click opens the menu`, 3000);
      // The same, then Enter on the button: a click from the keyboard has no press of its own, and opens the menu.
      await pressAway(button);
      await page(`(document.querySelector(${q(button)}).focus(), true)`);
      await app.run((shell) => {
        const contents = shell.windows.current.win.webContents;
        for (const type of ["keyDown", "char", "keyUp"]) contents.sendInputEvent({ type, keyCode: "Return" });
      });
      await until(open, `${button}: Enter after a press let go elsewhere opens the menu`, 3000);
      await closeMenu();
    }
    // The update's line goes (the state none) while its menu is open: the menu goes with it.
    await app.click("#update-go");
    await until(open, "the update's menu open");
    await tell({ state: "none", version: null });
    await until(() => page(`document.querySelector("#update-note").hidden`), "the update's line gone");
    assert.deepEqual(await page(`({ menu: Boolean(document.querySelector(".update-menu")), expanded: document.querySelector("#update-go").getAttribute("aria-expanded") })`), { menu: false, expanded: "false" }, "the update's menu closed with its line");
  } finally {
    await closeMenu();
    await tell({ state: "none", version: null });
  }
});

test("Switch account… opens Publish on Choose a GitHub account, with the accounts to choose from", { skip, timeout: 120_000 }, async () => {
  await pick("Switch account…");
  await until(async () => /Choose a GitHub account/.test(await pane()), "Publish on Choose a GitHub account");
  const text = await pane();
  assert.match(text, new RegExp(`Publishing uses ${github.login} now`));
  assert.match(text, /octo-own/, "the other account of GitHub CLI is there to choose");
  await closePublish();
});

test("Add account… opens the same step with Another account chosen, to sign in with it", { skip, timeout: 120_000 }, async () => {
  await pick("Add account…");
  await until(async () => /Choose a GitHub account/.test(await pane()), "Publish on Choose a GitHub account");
  await until(() => page(`document.querySelector('input[name="publish-account"][value="new"]')?.checked === true`), "Another account chosen");
  assert.ok(await page(`[...document.querySelectorAll(".publish button")].some((b) => b.textContent.trim() === "Sign in with another account")`));
  await closePublish();
});
