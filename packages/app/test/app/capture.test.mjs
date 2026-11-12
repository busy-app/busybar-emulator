// The canvas's Screenshot module and the recording of the window in the running app with the real server
// (capture-actions.mjs): the module clicked and its keys pressed as the person does, with the real command line; the
// recording asked for as the page asks, with the window's real recording, and the Record button clicked through its
// menu for a clip for a post, which the server records from the bar. A hidden run shows no Save dialog: what it would have asked is in shell.saveDialog.planned, and the tests' stand-in answers it. The project's
// folder and the chosen files have letters of other scripts in their names.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { readMp4 } from "../../src/capture-mp4.mjs";
import { HAS_REAL_SERVER, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skip = !HAS_REAL_SERVER && "the server is not beside this package";
/** Letters of another script, by their codes (the repository's texts are checked to have none). */
const cyr = (...codes) => String.fromCharCode(...codes);

let app;
let work;
let project;
before(async () => {
  if (skip) return;
  work = realpathSync(temporaryFolder());
  app = await launch({ server: "real", env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust" } });
  await app.waitWindow("device");
  // A project of the list: one made elsewhere, opened through Open App Folder and trusted.
  project = path.join(work, `${cyr(0x041c, 0x043e, 0x0439)} ${cyr(0x043f, 0x0440, 0x043e, 0x0435, 0x043a, 0x0442)} Ωmega`);
  mkdirSync(path.join(project, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(project, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.capture.omega", name: "Omega" }));
  writeFileSync(path.join(project, "src", "main.js"), "// the app\n");
  await app.run((shell, _electron, answer) => shell.folderDialogs.standIn(answer), project);
  // The window takes the person's keys once its page is up.
  const opened = await until(async () => {
    await app.press();
    return app.page("window.emulatorActions.projects.open().then((p) => p && p.folder, (e) => (e.code === 'no_gesture' ? null : e.message))");
  }, "the project opened");
  assert.equal(opened, project);
});
after(async () => {
  await app?.close();
  if (work) await removeFolder(work);
});

const bare = (code) => app.page(`(${code}).then((value) => ({ value }), (e) => ({ error: { code: e.code, message: e.message } }))`);
const act = async (code) => {
  await app.press();
  return bare(code);
};
const q = (value) => JSON.stringify(value);
const said = () => app.page(`document.querySelector("#capture-toast").hidden ? null : document.querySelector("#capture-said").textContent`);
/** A click as the person makes it: the pointer comes to the button, then presses (a press with no move before it, at
    another place than the last one, is not always delivered to a hidden window). */
async function click(selector) {
  const at = await app.page(`(() => { const box = document.querySelector(${q(selector)}).getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }; })()`);
  await app.run((shell, _electron, { x, y }) => shell.windows.current.win.webContents.sendInputEvent({ type: "mouseMove", x, y }), at);
  await sleep(150);
  await app.click(selector);
}
const chooses = (file) => app.run((shell, _electron, answer) => shell.saveDialog.standIn(answer), file);
const planned = () => app.run((shell) => shell.saveDialog.planned);
const pngSize = (file) => {
  const bytes = readFileSync(file);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test("the Screenshot module is in the top bar, before the view's switch; Record beside the camera; nothing without a click but the recording's state", { skip }, async () => {
  const tools = await app.page(`(() => {
    const module = document.querySelector("#shot-float");
    const box = (el) => el.getBoundingClientRect().toJSON();
    return {
      top: module.closest("header")?.id ?? null,
      module: box(module),
      header: box(document.querySelector("#topbar")),
      view: box(document.querySelector("#canvas-tools-top")),
      ticks: [document.querySelector("#shot-front").checked, document.querySelector("#shot-back").checked],
      icon: document.querySelector("#shot-take use").getAttribute("href"),
      record: !document.querySelector("#capture-tools").hidden && document.querySelector("#capture-record").parentElement.parentElement === module,
      camera: box(document.querySelector("#shot-take")),
      recordBox: box(document.querySelector("#capture-record")),
    };
  })()`);
  assert.equal(tools.top, "topbar");
  assert.deepEqual(tools.ticks, [true, true]);
  assert.equal(tools.icon, "/emulator/icons/busy-sprite.svg#bi-camera");
  assert.equal(tools.record, true, "the Record button is shown, in the Screenshot module");
  assert.ok(tools.recordBox.left >= tools.camera.right && Math.abs(tools.recordBox.top - tools.camera.top) < 1, "Record right after the camera, on its line");
  assert.ok(tools.module.top >= tools.header.top && tools.module.bottom <= tools.header.bottom, "in the top bar");
  assert.ok(tools.module.right <= tools.view.left, "left of the view's switch");
  await sleep(2300); // the key that opened the project is long past
  for (const code of [`window.emulatorActions.capture.screenshot({ folder: ${q(project)} })`, "window.emulatorActions.capture.record.start({})", "window.emulatorActions.capture.record.stop()", `window.emulatorActions.capture.reveal(${q(project)})`]) {
    assert.equal((await bare(code)).error?.code, "no_gesture", code);
  }
  assert.deepEqual((await bare("window.emulatorActions.capture.record.state()")).value, { recording: false, saving: false, layout: null, startedAt: null, maxSeconds: 120 });
  assert.equal(existsSync(path.join(project, "screenshots")), false);
});

test("Screenshot of a project: front-<n>.png at 72×16 and back-<n>.png at 160×80 in its screenshots/, the next number each time", { skip }, async () => {
  const first = (await act(`window.emulatorActions.capture.screenshot({ folder: ${q(project)}, name: "Omega" })`)).value;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.message, "Saved screenshots/front-1.png and back-1.png");
  const second = (await act(`window.emulatorActions.capture.screenshot({ folder: ${q(project)}, name: "Omega" })`)).value;
  assert.equal(second.message, "Saved screenshots/front-2.png and back-2.png");
  const shots = path.join(project, "screenshots");
  assert.deepEqual(readdirSync(shots).sort(), ["back-1.png", "back-1@8x.png", "back-2.png", "back-2@8x.png", "front-1.png", "front-1@8x.png", "front-2.png", "front-2@8x.png"]);
  assert.deepEqual(pngSize(path.join(shots, "front-2.png")), [72, 16]);
  assert.deepEqual(pngSize(path.join(shots, "back-2.png")), [160, 80]);
  assert.deepEqual(pngSize(path.join(shots, "front-2@8x.png")), [576, 128]);
  // Show in Finder: the file saved, nothing else.
  assert.equal((await act(`window.emulatorActions.capture.reveal(${q(second.saved[0].file)})`)).value, true);
  assert.equal((await act(`window.emulatorActions.capture.reveal(${q(path.join(project, "package.json"))})`)).value, false);
  assert.deepEqual(await app.run((shell) => shell.offScreen.shown.splice(0)), [path.join(shots, "front-2.png")]);
  // A folder that is no project of the list: refused, nothing written.
  const refused = (await act(`window.emulatorActions.capture.screenshot({ folder: ${q(work)} })`)).value;
  assert.deepEqual([refused.ok, refused.code], [false, "unknown_project"]);
});

test("Screenshot of the ticked displays of a project: the back alone is back-<n>.png, nothing of the front", { skip }, async () => {
  const shots = path.join(project, "screenshots");
  const before = existsSync(shots) ? readdirSync(shots) : [];
  const n = before.filter((f) => /^back-\d+\.png$/.test(f)).length + 1;
  const back = (await act(`window.emulatorActions.capture.screenshot({ folder: ${q(project)}, name: "Omega", displays: ["back"] })`)).value;
  assert.equal(back.message, `Saved screenshots/back-${n}.png`);
  assert.deepEqual(back.saved.map((one) => [one.display, one.width, one.height]), [["back", 160, 80]]);
  assert.deepEqual(pngSize(path.join(shots, `back-${n}.png`)), [160, 80]);
  assert.deepEqual(readdirSync(shots).filter((f) => !before.includes(f)).sort(), [`back-${n}.png`, `back-${n}@8x.png`], "nothing of the front");
});

test("the Screenshot button with no app of a project running: the Save dialog, not shown here, answered by the stand-in; both displays side by side; the toast names them", { skip }, async () => {
  const chosen = path.join(work, `${cyr(0x0421, 0x043d, 0x0438, 0x043c, 0x043a, 0x0438)} ${cyr(0x044d, 0x043a, 0x0440, 0x0430, 0x043d, 0x0430)}`, `${cyr(0x0431, 0x0430, 0x0440)}`);
  mkdirSync(path.dirname(chosen));
  await chooses(chosen);
  await click("#shot-take");
  const bar = cyr(0x0431, 0x0430, 0x0440);
  await until(async () => (await said()) === `Saved ${bar}.png and ${bar} back.png`, "the toast");
  assert.deepEqual(pngSize(`${chosen}.png`), [72, 16]);
  assert.deepEqual(pngSize(`${chosen} back.png`), [160, 80]);
  assert.ok(existsSync(`${chosen}@8x.png`));
  const asked = (await planned()).at(-1);
  assert.equal(asked.kind, "screenshot");
  assert.match(path.basename(asked.defaultPath), /^BUSY Bar \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d front\.png$/);
  assert.equal(await app.page(`document.querySelector("#capture-reveal").hidden`), false);
  assert.deepEqual(await app.page(`[document.querySelector("#shot-thumbs").hidden, document.querySelector("#shot-thumb-front").hidden, document.querySelector("#shot-thumb-back").hidden]`), [false, false, false]);
});

test("Front unticked by a click, then the keys (Cmd or Ctrl+Shift+S): the back display alone; the last tick stays; the window remembers", { skip }, async () => {
  await app.page(`document.querySelector("#capture-toast").hidden = true`);
  await click("#shot-front-tick");
  await until(() => app.page(`!document.querySelector("#shot-front").checked`), "Front unticked");
  await click("#shot-back-tick");
  await sleep(300);
  assert.deepEqual(await app.page(`[document.querySelector("#shot-front").checked, document.querySelector("#shot-back").checked]`), [false, true], "the last one stays ticked");
  assert.equal(await app.page(`localStorage.getItem("busy-emulator.screenshot-displays")`), '["back"]');
  const chosen = path.join(work, `keys ${cyr(0x0431, 0x0430, 0x0440)}`);
  await chooses(chosen);
  await app.run((shell, _electron, mac) => {
    const contents = shell.windows.current.win.webContents;
    const modifiers = ["shift", mac ? "meta" : "control"];
    contents.sendInputEvent({ type: "keyDown", keyCode: "S", modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode: "S", modifiers });
  }, process.platform === "darwin");
  await until(async () => (await said()) === `Saved keys ${cyr(0x0431, 0x0430, 0x0440)}.png`, "the toast");
  assert.deepEqual(pngSize(`${chosen}.png`), [160, 80]);
  assert.equal(existsSync(`${chosen} back.png`), false);
  assert.match(path.basename((await planned()).at(-1).defaultPath), / back\.png$/);
  assert.match(await app.page(`document.querySelector("#shot-take").title`), /\((\u2318\u21e7S|Ctrl\+Shift\+S)\)$/);
  // A reload of the window: still the back alone. Then both again, for what follows.
  await app.page("location.reload()").catch(() => {});
  await until(() => app.page(`document.readyState === "complete" && !!document.querySelector("#shot-front")`).catch(() => false), "the window again");
  assert.deepEqual(await app.page(`[document.querySelector("#shot-front").checked, document.querySelector("#shot-back").checked]`), [false, true]);
  await click("#shot-front-tick");
  await until(() => app.page(`document.querySelector("#shot-front").checked`), "Front ticked");
});

// The recording of the window, asked for as the button's menu asks.
test("the recording: the first ask starts, the second stops and the video goes where the person chose", { skip, timeout: 120_000 }, async (t) => {
  const record = async (what) => (await act(`window.emulatorActions.capture.record.${what}({})`)).value;
  const first = await record("start");
  if (first?.ok !== true) {
    if (/cannot encode/.test(String(first?.message))) return t.skip(String(first.message));
    assert.fail(`the recording did not start: ${JSON.stringify(first)}`);
  }
  assert.equal((await bare("window.emulatorActions.capture.record.state()")).value?.recording, true);
  await sleep(1600);
  const chosen = path.join(work, `${cyr(0x0412, 0x0438, 0x0434, 0x0435, 0x043e)} ${cyr(0x0440, 0x043e, 0x043b, 0x0438, 0x043a, 0x0438)}`, `${cyr(0x0437, 0x0430, 0x043f, 0x0438, 0x0441, 0x044c)} ${cyr(0x0431, 0x0430, 0x0440, 0x0430)}`);
  mkdirSync(path.dirname(chosen));
  await chooses(chosen);
  const done = await record("stop");
  assert.equal(done.name, `${cyr(0x0437, 0x0430, 0x043f, 0x0438, 0x0441, 0x044c)} ${cyr(0x0431, 0x0430, 0x0440, 0x0430)}.mp4`);
  const mp4 = readMp4(readFileSync(`${chosen}.mp4`));
  assert.equal(mp4.codec, "avc1");
  assert.ok(mp4.frames >= 30 && mp4.frames <= 120, `${mp4.frames} frames`);
  assert.ok(mp4.width <= 1920 && mp4.height <= 1080, `${mp4.width}×${mp4.height}: fits 1920×1080`);
  assert.deepEqual([mp4.audio?.codec, mp4.audio?.sampleRate, mp4.audio?.channels], ["mp4a", 48000, 2], "a silent audio track");
  assert.deepEqual(readdirSync(path.join(app.folder, "captures")), [], "the take in the data folder is gone");
  const asked = (await planned()).at(-1);
  assert.equal(asked.kind, "recording");
  assert.match(path.basename(asked.defaultPath), /^BUSY Bar \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.mp4$/);

  // Again, and Cancel: nothing is kept.
  assert.equal((await record("start")).ok, true);
  await sleep(500);
  const canceled = await record("stop");
  assert.deepEqual([canceled.ok, canceled.file], [true, null]);
  assert.deepEqual(readdirSync(path.join(app.folder, "captures")), []);
  assert.equal((await planned()).filter((one) => one.kind === "recording").length, 2);
});

test("the Record button, clicked: its menu, Post; the bar is recorded until the second click; the video is 1080×1920 with silence; Show in Finder", { skip, timeout: 180_000 }, async (t) => {
  // The toast of the test before (its Cancel) is put away first: what it says next is this recording's.
  await app.page(`document.querySelector("#capture-toast").hidden = true`);
  await click("#capture-record");
  await until(() => app.page(`Boolean(document.querySelector("#record-menu"))`), "the menu");
  assert.deepEqual(await app.page(`[...document.querySelectorAll("#record-menu .menu-item")].map((item) => item.dataset.layout)`), ["window", "post", "front"]);
  await click(`#record-menu .menu-item[data-layout="post"]`);
  const pressed = await until(async () => {
    const state = await app.page(`[document.querySelector("#capture-record").ariaPressed, document.querySelector("#capture-toast").hidden || !document.querySelector("#capture-toast").classList.contains("failed") ? null : document.querySelector("#capture-said").textContent]`);
    return state[0] === "true" || state[1] ? state : null;
  }, "the recording started or was refused");
  if (pressed[0] !== "true") {
    if (/cannot encode/.test(String(pressed[1]))) return t.skip(pressed[1]);
    assert.fail(`the recording did not start: ${pressed[1]}`);
  }
  assert.equal((await bare("window.emulatorActions.capture.record.state()")).value?.layout, "post");
  assert.equal(await app.page(`document.querySelector("#record-menu")`), null, "the menu is gone");
  await sleep(3600); // past the 3 s Instagram takes at least: the toast says nothing of it
  const chosen = path.join(work, `${cyr(0x043f, 0x043e, 0x0441, 0x0442)} one.mp4`);
  await chooses(chosen);
  await click("#capture-record");
  const text = await until(async () => {
    const one = await said();
    return one && /^Saved /.test(one) ? one : null;
  }, "the toast of the saved video", 60_000);
  assert.equal(text, `Saved ${path.basename(chosen)}`);
  const mp4 = readMp4(readFileSync(chosen));
  assert.deepEqual([mp4.width, mp4.height, mp4.fps], [1080, 1920, 30]);
  assert.ok(mp4.frames >= 30 && mp4.frames < 30 * 20, `${mp4.frames} frames`);
  assert.deepEqual(mp4.order, ["ftyp", "moov", "mdat"]);
  assert.deepEqual([mp4.audio?.codec, mp4.audio?.sampleRate, mp4.audio?.channels], ["mp4a", 48000, 2]);
  assert.ok(mp4.dataInPlace);
  assert.match(path.basename((await planned()).at(-1).defaultPath), / post\.mp4$/);
  assert.deepEqual(readdirSync(path.join(app.folder, "captures")).filter((name) => name.endsWith(".mp4")), [], "the take in the data folder is gone");
  await click("#capture-reveal");
  await until(() => app.run((shell) => shell.offScreen.shown.length > 0), "shown in Finder");
  assert.deepEqual(await app.run((shell) => shell.offScreen.shown.splice(0)), [chosen]);
});
