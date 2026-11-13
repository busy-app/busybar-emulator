// The top bar's account menu: signed in, its Switch account… and Add account… open Publish for the open app on
// Choose a GitHub account, with another account to choose, or with "Another account" chosen to sign in with it. With
// the real server, the stand-in for GitHub CLI and the stand-in for GitHub (never github.com, never the person's
// ~/.config/gh: gh's configuration is a folder of the test's); the project has a stand-in for busy-cli.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { FAKE_GH, fakeSignedIn } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { HAS_REAL_SERVER, PORTS, removeFolder, targz, temporaryFolder, until } from "../helpers.mjs";
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
const pane = () => page(`document.querySelector(".publish .publish-pane, .publish")?.innerText.trim() ?? ""`);
const closePublish = async () => {
  await page(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), true)`);
  await until(() => page(`!document.querySelector(".publish-scrim") || document.querySelector(".publish-scrim").hidden`), "Publish closed");
};

test("signed in, the account button shows the login with GitHub's mark; its menu has Switch account… and Add account…", { skip }, async () => {
  await until(() => page(`!document.querySelector("#account").hidden && document.querySelector("#account-name").textContent === ${q(github.login)}`), "the account button");
  assert.equal(await page(`document.querySelector("#account-avatar").dataset.mark`), "github");
  // The account button came after the page: the view tools over the BUSY Bar made room for it, Publish stays in.
  for (const [w, h] of [[1200, 800], [1440, 900], [900, 650]]) {
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await until(() => page(`(() => { const top = document.querySelector(".topbar"); const p = document.querySelector("#publish").getBoundingClientRect(); return p.right <= innerWidth && top.scrollWidth <= top.clientWidth + 1; })()`), `Publish inside the window at ${w}×${h}`, 5000, 200);
  }
  await page(`document.querySelector("#account").click(), true`);
  await until(async () => (await items()).length > 0, "the account menu");
  assert.deepEqual(await items(), ["Open on GitHub", "Switch account…", "Add account…", "Sign out"]);
  await page(`(document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })), document.querySelector(".row-menu")?.remove(), true)`);
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
