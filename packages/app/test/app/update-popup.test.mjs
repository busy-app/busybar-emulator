// The update's pop-up in the app (update-popup.mjs, legacy-window/update-popup.js), against the stand-in for GitHub
// the updater's tests use: a newer version at the start shows it, with the release's notes whole (the real ones of
// 0.1.0-beta.6, nested items nested) and Release notes, which opens the release's page; long notes scroll in their own
// area and the card stays inside the window at its smallest; Later closes it and the top bar's notice stays; Update now starts the download, with its progress; a copy that cannot
// replace itself offers Download; the first run's greeting goes first; a version is offered once in a run; a start
// within a day of the last check still asks, and the pop-up follows; a long version's title is never cut.
// UPDATE_POPUP_SHOTS=<folder> also saves pictures at 1200×800 and 1140×650.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { after, afterEach, before, test } from "./node-test.mjs";

import { parseReleaseNotes } from "../../src/update-check.mjs";
import { manifestBytes, signManifest } from "../../src/update-manifest.mjs";
import { PORTS, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

const VERSION = "9.9.9";
// The app's own version at this commit (a pre-release too).
const OWN_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const LATEST = "/repos/busy-app/busybar-emulator/releases/latest";
const mac = process.platform === "darwin";
const ASSET = mac ? (process.arch === "arm64" ? "busybar-emulator-mac-arm64.zip" : "busybar-emulator-mac-x64.zip") : "busybar-emulator-win-x64-setup.exe";
const skip = { skip: (!HAS_REAL_SERVER && "the server is not beside this package") || (!["darwin", "win32"].includes(process.platform) && "no update on this system") };
const SHOTS = process.env.UPDATE_POPUP_SHOTS || null;
// The body of 0.1.0-beta.6's release as GitHub has it: the changelog's section, then "## Files".
const NOTES = readFileSync(new URL("../fixtures/release-notes-v0.1.0-beta.6.md", import.meta.url), "utf8");
const PAGE = `https://github.com/busy-app/busybar-emulator/releases/tag/v${VERSION}`;

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
let work;
let keyFile;
let target;
let readOnly; // a copy that cannot replace itself: its folder may not be written to
let asset;
let served = {};
let slow = false;
let asked = [];
let github;
let app = null;

/** A bundle that passes for a development run of the app (updater.test.mjs has the same). */
function fakeBundle(dir, version) {
  const bundle = path.join(dir, "BUSY Bar Emulator.app");
  mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(path.join(bundle, "Contents", "Resources"), { recursive: true });
  writeFileSync(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>app.busy.emulator.test-variant</string><key>CFBundleExecutable</key><string>BUSY Bar Emulator</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`);
  writeFileSync(path.join(bundle, "Contents", "Resources", "build.json"), JSON.stringify({ kind: "development", version }));
  writeFileSync(path.join(bundle, "Contents", "MacOS", "BUSY Bar Emulator"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bundle, "Contents", "MacOS", "BUSY Bar Emulator"), 0o755);
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", bundle], { stdio: "ignore" });
  return bundle;
}

before(async () => {
  if (skip.skip) return;
  work = temporaryFolder();
  keyFile = path.join(work, "update-public.pem");
  writeFileSync(keyFile, publicKey.export({ type: "spki", format: "pem" }));
  if (mac) {
    target = fakeBundle(path.join(work, "Applications"), "0.0.1");
    readOnly = fakeBundle(path.join(work, "Locked"), "0.0.1");
    chmodSync(path.join(work, "Locked"), 0o555);
    const newer = fakeBundle(path.join(work, "new"), VERSION);
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", newer, path.join(work, ASSET)]);
    asset = readFileSync(path.join(work, ASSET));
  } else {
    target = path.join(work, "Programs", "BUSY Bar Emulator");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "busybar-emulator-install.json"), '{"app":"app.busy.emulator","by":"setup"}\r\n');
    // Not installed by the setup: no marker, so the setup cannot update it in place.
    readOnly = path.join(work, "Elsewhere", "BUSY Bar Emulator");
    mkdirSync(readOnly, { recursive: true });
    asset = Buffer.alloc(200_000, 1);
  }
  const bytes = manifestBytes({ version: VERSION, assets: [{ name: ASSET, size: asset.length, sha256: sha(asset) }] });
  served = {
    "/repos/busy-app/busybar-emulator/releases/latest": Buffer.from(JSON.stringify({ tag_name: `v${VERSION}`, body: NOTES })),
    [`/download/v${VERSION}/update.json`]: bytes,
    [`/download/v${VERSION}/update.json.sig`]: Buffer.from(signManifest(bytes, privateKey)),
    [`/download/v${VERSION}/${ASSET}`]: asset,
  };
  github = createServer(async (req, res) => {
    asked.push(req.url);
    const body = served[req.url];
    res.writeHead(body ? 200 : 404, { "content-length": String(body?.length ?? 0) });
    if (!body || !slow || !req.url.endsWith(ASSET)) return res.end(body ?? "");
    // Slowly, so that the progress is seen: in ten parts over about three seconds.
    const part = Math.ceil(body.length / 10);
    for (let at = 0; at < body.length; at += part) {
      if (res.destroyed) return;
      res.write(body.subarray(at, at + part));
      await sleep(300);
    }
    res.end();
  });
  await new Promise((resolve) => github.listen(PORTS.witness, "127.0.0.1", resolve));
});
after(async () => {
  if (skip.skip) return;
  github.closeAllConnections();
  await new Promise((resolve) => github.close(resolve));
  if (mac) chmodSync(path.join(work, "Locked"), 0o755);
  await removeFolder(work);
});
afterEach(async () => {
  await app?.close();
  app = null;
  asked = [];
  slow = false;
});

const start = async ({ env = {}, welcomed = true, place = target, dataDir = null } = {}) => {
  app = await launch({
    server: "real",
    welcomed,
    dataDir,
    env: {
      BUSY_EMULATOR_UPDATE_URL: `http://127.0.0.1:${PORTS.witness}/repos/busy-app/busybar-emulator/releases/latest`,
      BUSY_EMULATOR_UPDATE_RELEASES: `http://127.0.0.1:${PORTS.witness}/download`,
      BUSY_EMULATOR_TEST_UPDATE_KEY: keyFile,
      BUSY_EMULATOR_TEST_UPDATE_TARGET: place,
      BUSY_EMULATOR_TEST_UPDATE_ANSWER: "no",
      BUSY_EMULATOR_TEST_UPDATE_POPUP: "1",
      ...env,
    },
  });
  await app.waitWindow("device");
  return app;
};
const state = () => app.run((shell) => shell.updater.state);
const shown = (selector) => app.page(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && !el.hidden && el.closest("[hidden]") === null && el.getClientRects().length > 0); })()`);
const text = (selector) => app.page(`document.querySelector(${JSON.stringify(selector)})?.textContent.replace(/\\s+/g, " ").trim() ?? null`);
const key = (keyCode) =>
  app.run((shell, _electron, code) => {
    const contents = shell.windows.current.win.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode: code });
    contents.sendInputEvent({ type: "keyUp", keyCode: code });
  }, keyCode);

async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [w, h] of [
    [1200, 800],
    [1140, 650],
  ]) {
    // A hidden window paints again when its size changes: one pixel less first.
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1] - 1), [w, h]);
    await sleep(200);
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await sleep(500);
    const png = await app.run(async (shell) => (await shell.windows.current.win.webContents.capturePage()).toPNG().toString("base64"));
    writeFileSync(path.join(SHOTS, `${name}-${w}x${h}.png`), Buffer.from(png, "base64"));
  }
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
}

test("a newer version at the start: the pop-up offers it with the notes; Later closes it, the notice stays, and it is not shown twice", skip, async () => {
  await start();
  await until(() => shown("#update-popup"), "the pop-up", 30_000);
  assert.equal(await text("#update-popup-title"), `BUSY Bar Emulator ${VERSION} is available`);
  assert.match(await text("#update-popup-about"), /^You are on \d+\.\d+\.\d+/);
  // The whole notes up to their Files, the features with their details nested under them, as text.
  const notes = parseReleaseNotes(NOTES);
  const drawn = await app.page(`(() => {
    const area = document.querySelector("#update-popup-notes");
    const items = (list) => [...list.children].map((li) => ({ lead: li.querySelector(":scope > strong")?.textContent ?? null, text: [...li.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim(), list: li.querySelector(":scope > ul") ? items(li.querySelector(":scope > ul")) : null }));
    return { lists: [...area.children].map((one) => one.tagName), items: items(area.querySelector(":scope > ul")), text: area.textContent, html: area.innerHTML };
  })()`);
  assert.deepEqual(drawn.lists, ["UL"]);
  const expected = (items) => items.map((one) => ({ lead: one.lead ?? null, text: one.text, list: one.list ? expected(one.list.items) : null }));
  assert.deepEqual(drawn.items, expected(notes.blocks[0].items));
  assert.equal(drawn.items.length, 5, "five features");
  assert.deepEqual(drawn.items.map((one) => one.list?.length ?? 0), [3, 3, 0, 2, 1], "their details nested under them");
  assert.ok(drawn.text.includes("set-aside/format-1-bars-<time>/."), "the last detail whole, its words as written");
  assert.ok(!drawn.text.includes("…") && !/Files|\.dmg/.test(drawn.text), "nothing cut, nothing of the Files section");
  assert.ok(!/<(?!\/?(ul|li|strong)>)/.test(drawn.html), `only lists and their words: ${drawn.html.slice(0, 200)}`);
  assert.deepEqual(await app.page(`[...document.querySelectorAll("#update-popup .update-popup-foot > *")].map((b) => b.textContent)`), ["Release notes", "Later", "Update now"]);
  assert.equal(await shown("#update-popup-why"), false);
  assert.equal(await app.page(`document.activeElement?.id`), "update-popup-go", "the focus on Update now");
  await shot("offer");
  // Release notes opens the release's page in the browser, and the pop-up stays for Update now.
  await app.click("#update-popup-page");
  await until(async () => (await app.run((shell) => shell.opener.opened)).includes(PAGE), "the release page opened in the browser");
  await sleep(300);
  assert.equal(await shown("#update-popup"), true, "the pop-up stays");
  await app.click("#update-popup-later");
  await until(async () => !(await shown("#update-popup")), "the pop-up closed");
  assert.equal(await shown("#update-go"), true, "the top bar's notice stays");
  assert.equal((await state()).state, "available", "nothing was downloaded");
  assert.ok(!asked.includes(`/download/v${VERSION}/${ASSET}`));

  // Once in a run: a reload of the window asks again, and the app says no.
  await app.run((shell) => shell.windows.current.win.webContents.reload());
  await app.waitWindow("device");
  await until(() => shown("#update-go"), "the notice after the reload");
  await sleep(2500);
  assert.equal(await shown("#update-popup"), false, "not shown twice in one start");
  assert.deepEqual(Object.keys(await app.run((shell) => shell.updatePopup.shown)), [VERSION]);
  assert.match(app.log(), /the pop-up offers 9\.9\.9/);
  assert.equal(app.log().match(/the pop-up offers/g).length, 1);
});

test("Update now starts the download: the progress shows in the pop-up, then Restart to update; Esc closes it", skip, async () => {
  slow = true;
  await start();
  await until(() => shown("#update-popup-go"), "Update now", 30_000);
  await app.click("#update-popup-go");
  await until(() => shown("#update-popup-progress"), "the download's progress");
  assert.match(await text("#update-popup-progress"), new RegExp(`^Downloading ${VERSION.replace(/\./g, "\\.")}`));
  assert.equal(await text("#update-popup-later"), "Hide");
  assert.equal(await shown("#update-progress"), true, "the top bar shows it too");
  await shot("downloading");
  await until(async () => (await state()).state === "ready", "the update downloaded and checked", 60_000);
  await until(() => shown("#update-popup-restart"), "Restart to update");
  assert.equal(await text("#update-popup-title"), `BUSY Bar Emulator ${VERSION} is ready`);
  await shot("ready");
  await key("Escape");
  await until(async () => !(await shown("#update-popup")), "Esc closed it");
  assert.equal(await text("#update-go-text"), "Restart to update", "the notice goes on");
});

test("a copy that cannot replace itself: the pop-up says why and offers Download, which opens the release page", skip, async () => {
  await start({ place: readOnly });
  await until(() => shown("#update-popup"), "the pop-up", 30_000);
  assert.equal(await shown("#update-popup-go"), false, "no Update now");
  assert.match(await text("#update-popup-why"), mac ? /cannot write to .*Download the new version from its release page instead\.$/ : /not installed by the emulator's setup/);
  assert.deepEqual(await app.page(`[...document.querySelectorAll("#update-popup .update-popup-foot > *")].map((b) => b.textContent)`), ["Release notes", "Later", "Download"]);
  assert.equal(await app.page(`document.querySelectorAll("#update-popup-notes > ul > li").length`), 5, "the notes here too");
  await shot("download");
  await app.click("#update-popup-page");
  await until(async () => (await app.run((shell) => shell.opener.opened)).filter((one) => one === PAGE).length === 1, "Release notes opened the release page");
  assert.equal(await shown("#update-popup"), true, "the pop-up stays");
  await app.click("#update-popup-download");
  await until(async () => (await app.run((shell) => shell.opener.opened)).filter((one) => one === PAGE).length === 2, "Download opened the release page");
  await until(async () => !(await shown("#update-popup")), "the pop-up closed");
  assert.ok(!asked.includes(`/download/v${VERSION}/${ASSET}`), "nothing was downloaded");
});

test("the first run's greeting goes first: the pop-up waits until it is closed", skip, async () => {
  await start({ welcomed: false, env: { BUSY_EMULATOR_TEST_GREETED: "" } });
  await until(() => shown("#welcome"), "the greeting", 30_000);
  await until(async () => (await state()).state === "available", "the update offered");
  await sleep(3000);
  assert.equal(await shown("#update-popup"), false, "not over the greeting");
  assert.deepEqual(await app.run((shell) => shell.updatePopup.shown), {}, "not even asked for");
  await key("Escape");
  await until(async () => !(await shown("#welcome")), "the greeting closed");
  await until(() => shown("#update-popup"), "the pop-up after the greeting", 10_000);
  await key("Escape");
  await until(async () => !(await shown("#update-popup")), "Esc is Later");
});

test("a start within a day of the last check asks again: the release out since then shows the pop-up on its own", skip, async () => {
  // The morning of 0.1.0-beta.2: the app checked an hour ago, when it was the newest; since then a release came out.
  const folder = temporaryFolder();
  try {
    writeFileSync(path.join(folder, "app-settings.json"), `${JSON.stringify({ welcomed: true, updateChecked: Date.now() - 60 * 60 * 1000, updateFailed: null, updateLatest: OWN_VERSION, updateCheckedBy: OWN_VERSION })}\n`);
    await start({ welcomed: false, dataDir: folder });
    await until(() => shown("#update-popup"), "the pop-up at the start", 30_000);
    assert.equal(await text("#update-popup-title"), `BUSY Bar Emulator ${VERSION} is available`);
    assert.equal(asked.filter((url) => url === LATEST).length, 1, "one request at the start");
    assert.equal(await app.run((shell) => shell.updates.requests), 1);
  } finally {
    await app?.close();
    app = null;
    await removeFolder(folder);
  }
});

test("a long version's title is never cut: it wraps, at 1140×650 and at 1200×800", skip, async () => {
  const long = "10.10.10-beta.10";
  const before = served[LATEST];
  served[LATEST] = Buffer.from(JSON.stringify({ tag_name: `v${long}`, body: NOTES }));
  try {
    await start({ place: readOnly });
    await until(() => shown("#update-popup"), "the pop-up", 30_000);
    assert.equal(await text("#update-popup-title"), `BUSY Bar Emulator ${long} is available`);
    for (const [w, h] of [
      [1140, 650],
      [1200, 800],
    ]) {
      await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
      await sleep(400);
      const box = await app.page(`(() => {
        const title = document.querySelector("#update-popup-title");
        const style = getComputedStyle(title);
        const range = document.createRange();
        range.selectNodeContents(title);
        const words = range.getBoundingClientRect();
        const room = title.getBoundingClientRect();
        const card = document.querySelector("#update-popup .update-popup").getBoundingClientRect();
        return { lines: Math.round(room.height / parseFloat(style.lineHeight)), cut: title.scrollWidth > title.clientWidth || title.scrollHeight > title.clientHeight || words.right > room.right + 0.5, ellipsis: style.textOverflow, size: style.fontSize, weight: style.fontWeight, inside: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight };
      })()`);
      assert.deepEqual({ ...box, lines: box.lines <= 2 }, { lines: true, cut: false, ellipsis: "clip", size: "18px", weight: "500", inside: true }, `${w}×${h}: ${JSON.stringify(box)}`);
    }
    await shot("long-version");
  } finally {
    served[LATEST] = before;
  }
});

test("long notes scroll in their own area; the card stays inside the window at its smallest, and only the notes scroll", skip, async () => {
  const before = served[LATEST];
  const long = ["- **A feature with a long name** and words that go on.", ...Array.from({ length: 60 }, (_, i) => `  - Detail ${i + 1}, with words enough to take most of a line in the pop-up's tile.`), "- **The last feature.**", "", "## Files", "", "- x"].join("\n");
  served[LATEST] = Buffer.from(JSON.stringify({ tag_name: `v${VERSION}`, body: long }));
  try {
    await start({ place: readOnly });
    await until(() => shown("#update-popup-notes"), "the pop-up with its notes", 30_000);
    for (const [w, h] of [
      [1140, 600],
      [1140, 650],
      [1200, 800],
    ]) {
      await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
      await sleep(400);
      const box = await app.page(`(() => {
        const card = document.querySelector("#update-popup .update-popup");
        const notes = document.querySelector("#update-popup-notes");
        const r = card.getBoundingClientRect();
        const foot = document.querySelector("#update-popup .update-popup-foot").getBoundingClientRect();
        notes.scrollTop = 0;
        notes.scrollTop = 200;
        const scrolled = notes.scrollTop;
        notes.scrollTop = notes.scrollHeight;
        const last = [...notes.querySelectorAll(":scope > ul > li")].at(-1).getBoundingClientRect();
        const n = notes.getBoundingClientRect();
        const shownLast = last.top >= n.top && last.bottom <= n.bottom + 0.5;
        notes.scrollTop = 0;
        return { inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, footInside: foot.bottom <= r.bottom, cardScrolls: card.scrollHeight > card.clientHeight + 1, notesScroll: notes.scrollHeight > notes.clientHeight, scrolled, shownLast, height: Math.round(n.height), window: [innerWidth, innerHeight] };
      })()`);
      assert.deepEqual({ inside: box.inside, footInside: box.footInside, cardScrolls: box.cardScrolls, notesScroll: box.notesScroll, scrolls: box.scrolled > 0, shownLast: box.shownLast, tall: box.height >= 44 && box.height <= 320 }, { inside: true, footInside: true, cardScrolls: false, notesScroll: true, scrolls: true, shownLast: true, tall: true }, `${w}×${h}: ${JSON.stringify(box)}`);
    }
    // The last detail and the last feature are there, whole: nothing was left out of a body this long.
    assert.equal(await app.page(`document.querySelectorAll("#update-popup-notes > ul > li:first-child > ul > li").length`), 60);
    assert.equal(await text("#update-popup-notes > ul > li:last-child"), "The last feature.");
    await shot("long-notes");
  } finally {
    served[LATEST] = before;
  }
});

test("one line of notes takes one line: the tile is as tall as its text, no empty space under it", skip, async () => {
  const before = served[LATEST];
  served[LATEST] = Buffer.from(JSON.stringify({ tag_name: `v${VERSION}`, body: "Fixes the Run button.\n\n## Files\n\n- x\n" }));
  try {
    await start({ place: readOnly });
    await until(() => shown("#update-popup-notes"), "the pop-up with its notes", 30_000);
    const box = await app.page(`(() => {
      const notes = document.querySelector("#update-popup-notes");
      const style = getComputedStyle(notes);
      const words = notes.querySelector("p").getBoundingClientRect();
      return { height: Math.round(notes.getBoundingClientRect().height), padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom), words: Math.round(words.height), scrolls: notes.scrollHeight > notes.clientHeight };
    })()`);
    assert.deepEqual(box, { height: 44, padding: 24, words: 20, scrolls: false }, JSON.stringify(box));
    assert.equal(await text("#update-popup-notes"), "Fixes the Run button.");
  } finally {
    served[LATEST] = before;
  }
});
