// The notice of a new version (EMU-205; ADR-0014, point 6), in the app: one request, with nothing in it but itself;
// one quiet line in the device window with a link for the user's browser; off in the test variant unless a test names
// a stand-in on this machine, off with BUSY_EMULATOR_NO_UPDATE_CHECK=1, off by the menu's switch; silent when it fails.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { PORTS, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

const realOnly = { skip: !HAS_REAL_SERVER && "the server is not beside this package" };
const STAND_IN = `http://127.0.0.1:${PORTS.witness}/repos/busy-app/busybar-emulator/releases/latest`;
// The app's own version, whatever it is at this commit (a pre-release too: 0.1.0-beta.1).
const OWN_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const PAGE_OF = (version) => `https://github.com/busy-app/busybar-emulator/releases/tag/v${version}`;

let github; // the stand-in for api.github.com
let requests = [];
let answer = { status: 200, body: JSON.stringify({ tag_name: "v9.9.9", html_url: "https://evil.example/" }) };
let app = null;
let folder = null;

before(async () => {
  github = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(answer.status, { "Content-Type": "application/json" });
    res.end(answer.body);
  });
  await new Promise((resolve) => github.listen(PORTS.witness, "127.0.0.1", resolve));
});
after(async () => {
  github.closeAllConnections();
  await new Promise((resolve) => github.close(resolve));
});
afterEach(async () => {
  await app?.close();
  app = null;
  if (folder) await removeFolder(folder);
  folder = null;
  requests = [];
  answer = { status: 200, body: JSON.stringify({ tag_name: "v9.9.9", html_url: "https://evil.example/" }) };
});

const start = async (env = {}, options = {}) => {
  app = await launch({ server: HAS_REAL_SERVER ? "real" : "fake", env: { BUSY_EMULATOR_UPDATE_URL: STAND_IN, ...env }, ...options });
  await app.waitWindow("device");
  return app;
};
const deviceUrl = () => app.run((shell) => shell.windows.current.win.webContents.getURL());
const notice = () => app.run((shell) => shell.updates.notice);
const settings = () => JSON.parse(readFileSync(path.join(app.folder, "app-settings.json"), "utf8"));

test("at its start the app asks once for the latest release, and the request carries nothing but itself", async () => {
  await start();
  await until(() => requests.length > 0, "the request of the update check");
  await until(notice, "the notice");
  await sleep(500);
  assert.equal(requests.length, 1);
  const [{ method, url, headers }] = requests;
  assert.equal(method, "GET");
  assert.equal(url, "/repos/busy-app/busybar-emulator/releases/latest");
  // No cookie, no identifier, nothing of the machine, not even the app's version.
  assert.deepEqual(headers, { "user-agent": "busybar-emulator", accept: "application/vnd.github+json", host: `127.0.0.1:${PORTS.witness}`, connection: "close" });
  assert.equal(await app.run((shell) => shell.updates.requests), 1);
  assert.ok(app.log().includes(`update check: the latest release is 9.9.9, this is ${OWN_VERSION}\n`), app.log());
});

test("a newer release: the device window gets the notice without loading again, and its link goes to the user's browser", realOnly, async () => {
  // The first run's greeting answered: the test clicks the notice's link behind it.
  await start({}, { welcomed: true });
  await app.page("window.emu205Mark = 1");
  await until(async () => (await deviceUrl()).includes("#update="), "the notice in the device window's address");
  assert.equal(await deviceUrl(), `http://127.0.0.1:${app.port}/emulator#update=9.9.9&page=${encodeURIComponent(PAGE_OF("9.9.9"))}`);
  await until(() => app.page(`!document.querySelector("#update-note").hidden`), "the line of the notice");
  assert.equal(await app.page("window.emu205Mark"), 1, "the page was loaded again");
  assert.equal(await app.page(`document.querySelector("#update-note").textContent.replace(/\\s+/g, " ").trim()`), "Version 9.9.9", "the pill: the download picture and the version; its tooltip says the rest");
  // The page's address is made from the version; what GitHub's answer says about addresses is not used.
  assert.equal(await app.page(`document.querySelector("#update-link").href`), PAGE_OF("9.9.9"));
  assert.deepEqual(await notice(), { version: "9.9.9", page: PAGE_OF("9.9.9") });
  // A notice that changes while the window is open changes the line, and the page stays as it is.
  await app.run((shell, _electron, next) => shell.windows.setNotice(next), { version: "9.9.10", page: PAGE_OF("9.9.10") });
  await until(() => app.page(`document.querySelector("#update-version").textContent === "9.9.10"`), "the line of the changed notice");
  assert.equal(await app.page("window.emu205Mark"), 1, "the page was loaded again");
  await app.run((shell, _electron, next) => shell.windows.setNotice(next), { version: "9.9.9", page: PAGE_OF("9.9.9") });
  await until(() => app.page(`document.querySelector("#update-version").textContent === "9.9.9"`), "the line of the notice");
  // The page clicking its own link opens nothing: the browser opens for the person's click only.
  await app.page(`document.querySelector("#update-link").click()`);
  await until(() => /not opened in the browser, no click or key in the window just before: https:\/\/github\.com/.test(app.log()), "the refusal of a click the page made itself");
  assert.deepEqual(await app.run((shell) => shell.opener.opened), []);
  // The person's click on the link, as the system sends it.
  await app.click("#update-link");
  await until(() => app.run((shell, _electron, page) => shell.opener.opened.includes(page), PAGE_OF("9.9.9")), "the release page given to the browser");
  assert.deepEqual(await app.run((shell) => shell.opener.opened), [PAGE_OF("9.9.9")]);
  // No window of the app shows the release page, and nothing is downloaded.
  assert.equal(await app.run((_shell, electron) => electron.BrowserWindow.getAllWindows().length), 1);
  assert.doesNotMatch(await deviceUrl(), /github\.com\/busy-app\/busybar-emulator\/releases\/tag\/v9\.9\.9$/);
  assert.equal(requests.length, 1);
});

test("the device page shows only a version written as one, and its link is its own: a page named in the address is ignored", realOnly, async () => {
  await start({ BUSY_EMULATOR_UPDATE_URL: "" });
  const shownFor = async (fragment) => {
    await app.page(`location.hash = ${JSON.stringify(fragment)}`);
    await sleep(100);
    return app.page(`document.querySelector("#update-note").hidden ? null : [document.querySelector("#update-version").textContent, document.querySelector("#update-link").href]`);
  };
  assert.deepEqual(await shownFor(`update=1.2.3&page=${encodeURIComponent(PAGE_OF("1.2.3"))}`), ["1.2.3", PAGE_OF("1.2.3")]);
  // Anyone can write the fragment (a link on a web page opens this page with one): whatever page it names, the link
  // goes to the version's page among the emulator's own releases.
  for (const fragment of [
    "update=1.2.3",
    `update=1.2.3&page=${encodeURIComponent("https://github.com/attacker/busybar-emulator/releases/download/v1.2.3/BUSY-Bar-Emulator.dmg")}`,
    `update=1.2.3&page=${encodeURIComponent("https://evil.example/releases")}`,
    `update=1.2.3&page=${encodeURIComponent("https://github.com.evil.example/x")}`,
    `update=1.2.3&page=${encodeURIComponent("http://github.com/busy-app/busybar-emulator")}`,
    `update=1.2.3&page=${encodeURIComponent("javascript:alert(1)")}`,
  ]) {
    assert.deepEqual(await shownFor(fragment), ["1.2.3", PAGE_OF("1.2.3")], fragment);
  }
  // A pre-release is a version too: the app may be one, and so may the release it is told of.
  assert.deepEqual(await shownFor("update=0.1.0-beta.2"), ["0.1.0-beta.2", PAGE_OF("0.1.0-beta.2")]);
  for (const fragment of [
    "",
    `page=${encodeURIComponent(PAGE_OF("1.2.3"))}`,
    `update=<b>1.2.3</b>&page=${encodeURIComponent(PAGE_OF("1.2.3"))}`,
    "update=latest",
    "update=1.2",
    `update=${encodeURIComponent("1.2.3/../../../../attacker/x")}`,
    `update=${encodeURIComponent("1.2.3-rc/../x")}`,
    `update=${encodeURIComponent("1.2.3?x=1")}`,
  ]) {
    assert.equal(await shownFor(fragment), null, fragment);
  }
});

test("every start asks once; a start within a minute of the last answer takes it and still shows what it found", async () => {
  folder = temporaryFolder();
  await start({}, { dataDir: folder });
  await until(notice, "the notice");
  assert.equal(requests.length, 1);
  assert.equal(settings().updateLatest, "9.9.9");
  await app.close();
  requests = [];
  // Started again at once: the answer of a moment ago stands.
  await start({}, { dataDir: folder });
  await until(notice, "the notice of the second start");
  await sleep(700);
  assert.equal(requests.length, 0, "a start within a minute of the last answer asked again");
  assert.equal(await app.run((shell) => shell.updates.requests), 0);
  if (HAS_REAL_SERVER) assert.match(await deviceUrl(), /#update=9\.9\.9&/);
  await app.close();
  requests = [];
  // Started an hour after a check that found nothing newer: it asks, though the day is not over, and finds the release.
  writeFileSync(path.join(folder, "app-settings.json"), `${JSON.stringify({ ...settings(), updateChecked: Date.now() - 60 * 60 * 1000, updateAsked: Date.now() - 60 * 60 * 1000, updateLatest: OWN_VERSION, updateCheckedBy: OWN_VERSION, updateNotes: undefined })}\n`);
  await start({}, { dataDir: folder });
  await until(notice, "the notice of the third start");
  await sleep(500);
  assert.equal(requests.length, 1);
  assert.equal(await app.run((shell) => shell.updates.requests), 1);
  // The checks while it runs keep the daily rule.
  await app.run((shell) => shell.updates.check());
  await sleep(300);
  assert.equal(requests.length, 1);
});

test("the same version or an older one: no notice, no change in the window", async () => {
  answer = { status: 200, body: JSON.stringify({ tag_name: "v0.0.0" }) };
  await start();
  await until(() => requests.length > 0, "the request of the update check");
  await until(() => /update check: the latest release/.test(app.log()), "the answer read");
  assert.equal(await notice(), null);
  assert.equal(await deviceUrl(), `http://127.0.0.1:${app.port}/emulator`);
});

test("a failed check is silent: the app starts as usual and shows no error", async () => {
  for (const failure of [{ status: 500, body: "{}" }, { status: 404, body: JSON.stringify({ message: "Not Found" }) }, { status: 200, body: "not a release" }]) {
    answer = failure;
    await start();
    await until(() => /update check: /.test(app.log()), "the outcome of the check in the log");
    assert.equal(await notice(), null, JSON.stringify(failure));
    assert.equal(await app.run((shell) => shell.windows.current.kind), "device");
    assert.equal(await deviceUrl(), `http://127.0.0.1:${app.port}/emulator`);
    assert.equal((await app.state()).name, "ready");
    assert.equal(requests.length, 1);
    await app.close();
    app = null;
    requests = [];
  }
  // Nothing listens at all.
  await start({ BUSY_EMULATOR_UPDATE_URL: `http://127.0.0.1:${PORTS.other}/latest` });
  await until(() => /update check: no answer/.test(app.log()), "the failure in the log");
  assert.equal(await notice(), null);
  assert.equal(await app.run((shell) => shell.windows.current.kind), "device");
});

test("the test variant makes no check of its own: without a stand-in it is off and asks nothing, GitHub least of all", async () => {
  await start({ BUSY_EMULATOR_UPDATE_URL: "" });
  await sleep(800);
  assert.deepEqual(await app.run((shell) => ({ allowed: shell.updates.allowed, enabled: shell.updates.enabled(), requests: shell.updates.requests, config: shell.config.updateCheck })), { allowed: false, enabled: false, requests: 0, config: { allowed: false, url: null } });
  assert.equal(requests.length, 0);
  assert.doesNotMatch(app.log(), /update check/);
  assert.equal(existsSync(path.join(app.folder, "app-settings.json")), false);
  // The menu's switch is there, off and gray.
  assert.deepEqual(await app.run((_shell, electron) => (({ checked, enabled }) => ({ checked, enabled }))(electron.Menu.getApplicationMenu().getMenuItemById("update-check"))), { checked: false, enabled: false });
});

test("an address that is not on this machine is not a stand-in: the test variant never asks it", async () => {
  await start({ BUSY_EMULATOR_UPDATE_URL: "https://api.github.com/repos/busy-app/busybar-emulator/releases/latest" });
  await sleep(500);
  assert.deepEqual(await app.run((shell) => ({ allowed: shell.updates.allowed, requests: shell.updates.requests })), { allowed: false, requests: 0 });
});

test("BUSY_EMULATOR_NO_UPDATE_CHECK=1 switches the check off: no request", async () => {
  await start({ BUSY_EMULATOR_NO_UPDATE_CHECK: "1" });
  await sleep(800);
  assert.equal(requests.length, 0);
  assert.deepEqual(await app.run((shell) => ({ allowed: shell.updates.allowed, requests: shell.updates.requests })), { allowed: false, requests: 0 });
  assert.equal(await notice(), null);
});

test("the menu's switch turns the check off: the notice goes, the choice is kept, and the next start asks nothing", async () => {
  folder = temporaryFolder();
  await start({}, { dataDir: folder });
  await until(notice, "the notice");
  const item = () => app.run((_shell, electron) => (({ checked, enabled, label }) => ({ checked, enabled, label }))(electron.Menu.getApplicationMenu().getMenuItemById("update-check")));
  assert.deepEqual(await item(), { checked: true, enabled: true, label: "Check for New Versions at Start" });
  // What a click on the item does: Electron flips the mark, then calls the item's handler.
  await app.run((_shell, electron) => electron.Menu.getApplicationMenu().getMenuItemById("update-check").click());
  await until(async () => (await notice()) === null, "the notice taken away");
  assert.equal((await item()).checked, false);
  assert.equal(settings().updateCheck, false);
  if (HAS_REAL_SERVER) {
    await until(() => app.page(`document.querySelector("#update-note").hidden`), "the line of the notice gone");
    assert.equal(await deviceUrl(), `http://127.0.0.1:${app.port}/emulator#`);
  }
  await app.close();
  requests = [];
  // The next start reads the switch from the file: no check, though nothing else would hold it back.
  await start({}, { dataDir: folder });
  await app.run((shell) => shell.updates.check());
  await sleep(500);
  assert.equal(requests.length, 0);
  assert.equal(await notice(), null);
  assert.equal((await item()).checked, false);
  // Switched on again, it asks.
  await app.run((_shell, electron) => electron.Menu.getApplicationMenu().getMenuItemById("update-check").click());
  await until(notice, "the notice after the switch is on again");
  assert.equal(settings().updateCheck, true);
});
