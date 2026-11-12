// The canvas's Screenshot and Record buttons (capture-actions.mjs) on plain Node, with stand-ins for the command line,
// the window's recording and the Save dialog: what is run, where files may go, the toggle of a recording, its limit,
// Cancel, and the dialog a hidden or test run does not show. The same in the running app: test/app/capture.test.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { besideFree, CAPTURE_ACTIONS, CAPTURE_NO_GESTURE, createCaptureActions, createSaveDialog, displaysOf, fileName, RECORD_FPS, RECORD_LAYOUTS, stampOf } from "../../src/capture-actions.mjs";
import { ACTIONS } from "../../src/bridge.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const root = realpathSync(temporaryFolder());
after(() => removeFolder(root));
/** Letters of another script, by their codes (the repository's texts are checked to have none). */
const cyr = (...codes) => String.fromCharCode(...codes);
let n = 0;

/** A fresh world: a data folder, a project of the list (its name has letters of other scripts), the person's folders. */
function setup({ answers, record, choose = [], maxSeconds } = {}) {
  const here = path.join(root, `run ${n++}`);
  const data = path.join(here, "data");
  const project = path.join(here, `${cyr(0x041f, 0x0440, 0x043e, 0x0435, 0x043a, 0x0442)} Ωmega`);
  const pictures = path.join(here, "Pictures");
  const videos = path.join(here, "Movies");
  for (const dir of [data, project, pictures, videos]) mkdirSync(dir, { recursive: true });
  const calls = [];
  const sent = [];
  const shown = [];
  const asked = [];
  const numbers = { front: 0, back: 0 };
  /** The command line's screenshot, as it answers: the next number in the folder it is given. */
  const shoot = (words) => {
    // publish screenshots <folder> --take=front|back: Publish's own take, which answers the path it took.
    if (words[0] === "publish") {
      const display = words[3] === "--take=back" ? "back" : "front";
      const shots = path.join(words[2], "screenshots");
      mkdirSync(shots, { recursive: true });
      const name = `${display}-${++numbers[display]}`;
      writeFileSync(path.join(shots, `${name}.png`), "png");
      writeFileSync(path.join(shots, `${name}@8x.png`), "png");
      return { ok: true, command: "publish", taken: `screenshots/${name}.png` };
    }
    const back = words.includes("--back");
    const out = words[words.indexOf("--out") + 1];
    if (/[\\/]$/.test(out)) {
      mkdirSync(out, { recursive: true });
      const name = `${back ? "back" : "front"}-${++numbers[back ? "back" : "front"]}`;
      const file = path.join(out, `${name}.png`);
      const scaled = path.join(out, `${name}@8x.png`);
      writeFileSync(file, "png");
      writeFileSync(scaled, "png");
      return { ok: true, command: "screenshot", display: back ? "back" : "front", width: back ? 160 : 72, height: back ? 80 : 16, file, scaled: { file: scaled, scale: 8 } };
    }
    writeFileSync(out, "png");
    const scaled = out.replace(/\.png$/i, "@8x.png");
    writeFileSync(scaled, "png");
    return { ok: true, command: "screenshot", display: back ? "back" : "front", width: back ? 160 : 72, height: back ? 80 : 16, file: out, scaled: { file: scaled, scale: 8 } };
  };
  const bar = { takes: [], refuse: null, interrupted: 0 };
  /** The command line's record of the bar: says it records, then waits for record --stop or its longest. */
  const recordBar = (words, onLine) => {
    const out = words[words.indexOf("--out") + 1];
    const layout = words[words.indexOf("--layout") + 1];
    const seconds = Number(words[words.indexOf("--seconds") + 1]);
    const take = { words, out, layout };
    bar.takes.push(take);
    const exited = new Promise((resolve) => {
      const end = (answer) => resolve({ code: answer.ok ? 0 : 1, signal: null, error: null, lines: [JSON.stringify(answer)] });
      setTimeout(() => onLine?.(`Recording ${seconds} s of the bar…`, "err"), 1);
      if (bar.refuse) return setTimeout(() => end(bar.refuse), 5);
      const size = layout === "post" ? [1080, 1920] : [1080, 240];
      const encoded = (frames) => (writeFileSync(out, "mp4"), end({ ok: true, command: "record", file: out, layout, width: size[0], height: size[1], fps: 30, frames, decoded_frames: frames }));
      take.stop = () => encoded(60);
      take.toLimit = () => encoded(seconds * 30);
      take.fail = (answer) => end(answer);
    });
    return { exited, interrupt: () => bar.interrupted++ };
  };
  const startCli = (args, { onLine } = {}) => {
    calls.push(args.join(" "));
    const words = args.filter((word) => word !== "--json" && word !== "--progress");
    if (words[0] === "record" && words[1] === "--stop") {
      const take = bar.takes.at(-1);
      setTimeout(() => take?.stop?.(), 1);
      return { exited: Promise.resolve({ code: 0, signal: null, error: null, lines: [JSON.stringify({ ok: true, command: "record", stopped: true })] }) };
    }
    if (words[0] === "record") return recordBar(words, onLine);
    const answer = (answers ?? shoot)(words);
    return { exited: Promise.resolve({ code: answer.ok ? 0 : 1, signal: null, error: null, lines: [JSON.stringify(answer)] }) };
  };
  const projects = new Map([[project, { id: "app.you.omega", name: "Omega Ωμέγα", folder: project, trusted: true }]]);
  const projectFor = async (folder) => (projects.has(folder) ? { project: projects.get(folder) } : { refused: { ok: false, code: "unknown_project", message: "This folder is not among the emulator's projects." } });
  const takes = [];
  /** The window's recording: writes the file when it ends (stopped, or at its longest), as capture-window.mjs does. */
  const recordWindow =
    record ??
    ((question, signal, until) => {
      const take = { question, signal, until };
      takes.push(take);
      setTimeout(() => until.onStarted(), 1);
      return new Promise((resolve) => {
        const end = () => {
          writeFileSync(question.out, "mp4");
          resolve({ answer: "encoded", decoded: take.limit ? question.frames : 45, width: 1200, height: 800 });
        };
        until.stop.addEventListener("abort", end, { once: true });
        take.toLimit = () => ((take.limit = true), end());
        signal.addEventListener("abort", () => resolve({ answer: "unavailable", reason: "the request was canceled" }), { once: true });
      });
    });
  const answersOfDialog = [...choose];
  const dialog = { save: async (kind, defaultPath) => (asked.push({ kind, defaultPath }), answersOfDialog.length ? answersOfDialog.shift() : null) };
  const capture = createCaptureActions({ startCli, projectFor, recordWindow, dialog, show: (file) => shown.push(file), send: (event) => sent.push(event), folders: { pictures, videos }, dataDir: data, logFile: "/data/logs/shell.log", log: () => {}, now: () => new Date(2026, 10, 11, 15, 42, 7).getTime(), ...(maxSeconds ? { maxSeconds } : {}) });
  const call = async (name, arg) => {
    const answer = await capture.call(name, arg);
    return answer.ok ? answer.value : { rejected: answer.error };
  };
  return { capture, call, calls, sent, shown, asked, takes, bar, data, project, pictures, videos };
}

test("the bridge knows the tools: the main window's page alone, each needs a click but the recording's state", () => {
  for (const name of CAPTURE_ACTIONS) {
    assert.ok(ACTIONS[name], name);
    assert.deepEqual(ACTIONS[name].pages.map((page) => page.kind), ["device"], name);
    assert.equal(ACTIONS[name].takes, 1, name);
    assert.equal(ACTIONS[name].gesture, !CAPTURE_NO_GESTURE.includes(name), name);
  }
  assert.deepEqual(CAPTURE_NO_GESTURE, ["capture.record.state"]);
});

test("Screenshot of a project's app: both displays into its screenshots/, the next number each time, with the copies Publish makes", async () => {
  const { call, calls, project } = setup();
  const first = await call("capture.screenshot", { folder: project, name: "Omega" });
  const shots = path.join(project, "screenshots");
  // As Publish's own take: the order in catalog.json gets them too, when the project has one.
  assert.deepEqual(calls, [`publish screenshots ${project} --take=front --json`, `publish screenshots ${project} --take=back --json`]);
  assert.deepEqual(first.saved.map((one) => [one.display, one.relative]), [["front", "screenshots/front-1.png"], ["back", "screenshots/back-1.png"]]);
  assert.equal(first.message, "Saved screenshots/front-1.png and back-1.png");
  const second = await call("capture.screenshot", { folder: project, name: "Omega" });
  assert.equal(second.message, "Saved screenshots/front-2.png and back-2.png");
  assert.deepEqual(readdirSync(shots).sort(), ["back-1.png", "back-1@8x.png", "back-2.png", "back-2@8x.png", "front-1.png", "front-1@8x.png", "front-2.png", "front-2@8x.png"]);
});

test("Screenshot: a folder that is no project is refused and nothing runs; a file the command line put elsewhere is not taken", async () => {
  const { call, calls, project } = setup();
  for (const folder of [path.join(project, ".."), "/", "", 42, "x".repeat(5000)]) {
    const answer = await call("capture.screenshot", { folder, name: "x" });
    assert.equal(answer.ok, false, String(folder).slice(0, 40));
    assert.equal(answer.code, "unknown_project");
  }
  assert.deepEqual(calls, []);

  const elsewhere = path.join(root, `elsewhere-${n}.png`);
  writeFileSync(elsewhere, "png");
  const odd = setup({ answers: () => ({ ok: true, taken: path.relative(root, elsewhere).split(path.sep).join("/") }) });
  const answer = await odd.call("capture.screenshot", { folder: odd.project, name: "x" });
  assert.deepEqual([answer.ok, answer.code], [false, "write_failed"]);
  assert.equal(await odd.call("capture.reveal", elsewhere), false, "a file not saved here is not shown");
});

test("Screenshot of an app without a project: the Save dialog in Pictures, named by the app and the time; Cancel saves nothing", async () => {
  const { call, calls, asked, pictures, shown } = setup({ choose: [null] });
  assert.deepEqual(await call("capture.screenshot", { folder: null, name: 'Clock: "big" / new', displays: ["front"] }), { ok: true, saved: [], message: null });
  assert.deepEqual(asked, [{ kind: "screenshot", defaultPath: path.join(pictures, "Clock big new 2026-11-11 15.42.07.png") }]);
  assert.deepEqual(calls, []);

  const other = setup({ choose: [path.join(root, `chosen ${n} ${cyr(0x0401, 0x043b, 0x043a, 0x0430)}`)] });
  const saved = await other.call("capture.screenshot", { folder: null, name: null, displays: ["front"] });
  assert.equal(other.asked[0].defaultPath, path.join(other.pictures, "BUSY Bar 2026-11-11 15.42.07.png"));
  const file = path.join(root, `chosen ${n - 1} ${cyr(0x0401, 0x043b, 0x043a, 0x0430)}.png`);
  assert.deepEqual(other.calls, [`screenshot --out ${file} --scale 8 --json`]);
  assert.deepEqual(saved.saved, [{ display: "front", file, width: 72, height: 16 }]);
  assert.equal(await other.call("capture.reveal", file), true);
  assert.deepEqual(other.shown, [file]);
  assert.deepEqual(shown, []);
});

test("Screenshot takes the ticked displays only: the front, the back, or both; a wrong list is refused and nothing runs", async () => {
  const { call, calls, project } = setup();
  const back = await call("capture.screenshot", { folder: project, name: "Omega", displays: ["back"] });
  assert.deepEqual(calls.splice(0), [`publish screenshots ${project} --take=back --json`]);
  assert.deepEqual(back.saved.map((one) => [one.display, one.relative, one.width, one.height]), [["back", "screenshots/back-1.png", 160, 80]]);
  assert.equal(back.message, "Saved screenshots/back-1.png");
  const front = await call("capture.screenshot", { folder: project, name: "Omega", displays: ["front"] });
  assert.deepEqual(calls.splice(0), [`publish screenshots ${project} --take=front --json`]);
  assert.deepEqual(front.saved.map((one) => [one.display, one.relative, one.width, one.height]), [["front", "screenshots/front-1.png", 72, 16]]);
  // Both, in any order, are the front then the back, with the next number of each.
  const both = await call("capture.screenshot", { folder: project, name: "Omega", displays: ["back", "front"] });
  assert.deepEqual(calls.splice(0), [`publish screenshots ${project} --take=front --json`, `publish screenshots ${project} --take=back --json`]);
  assert.equal(both.message, "Saved screenshots/front-2.png and back-2.png");
  assert.deepEqual(readdirSync(path.join(project, "screenshots")).filter((f) => !f.includes("@")).sort(), ["back-1.png", "back-2.png", "front-1.png", "front-2.png"]);
  for (const displays of [[], ["side"], ["front", "front"], ["front", "back", "front"], "front", 1, {}]) {
    const answer = await call("capture.screenshot", { folder: project, name: "Omega", displays });
    assert.deepEqual([answer.ok, answer.code], [false, "bad_displays"], JSON.stringify(displays));
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(displaysOf(undefined), ["front", "back"], "an older page names none: both, as before");
});

test("Screenshot without a project: the back alone is named so; both go side by side, the back's name made from the front's and never over a file", async () => {
  const one = setup({ choose: [path.join(root, `alone ${n}.png`)] });
  const back = await one.call("capture.screenshot", { folder: null, name: "Clock", displays: ["back"] });
  assert.equal(path.basename(one.asked[0].defaultPath), "Clock 2026-11-11 15.42.07 back.png");
  assert.deepEqual(one.calls, [`screenshot --back --out ${path.join(root, `alone ${n - 1}.png`)} --scale 8 --json`]);
  assert.deepEqual(back.saved.map((s) => [s.display, s.width, s.height]), [["back", 160, 80]]);

  const folder = path.join(root, `side ${n} ${cyr(0x0431, 0x0430, 0x0440)}`);
  mkdirSync(folder);
  const two = setup({ choose: [path.join(folder, "Clock 2026-11-11 15.42.07 front")] });
  const both = await two.call("capture.screenshot", { folder: null, name: "Clock" });
  assert.equal(path.basename(two.asked[0].defaultPath), "Clock 2026-11-11 15.42.07 front.png");
  const [f, b] = [path.join(folder, "Clock 2026-11-11 15.42.07 front.png"), path.join(folder, "Clock 2026-11-11 15.42.07 back.png")];
  assert.deepEqual(two.calls, [`screenshot --out ${f} --scale 8 --json`, `screenshot --back --out ${b} --scale 8 --json`]);
  assert.deepEqual(both.saved.map((s) => [s.display, s.file]), [["front", f], ["back", b]]);
  assert.equal(both.message, "Saved Clock 2026-11-11 15.42.07 front.png and Clock 2026-11-11 15.42.07 back.png");
  assert.equal(await two.call("capture.reveal", b), true);

  // A name of the person's own: " back" added; one taken already is not replaced.
  writeFileSync(path.join(folder, "mine back.png"), "png");
  const three = setup({ choose: [path.join(folder, "mine.png")] });
  const mine = await three.call("capture.screenshot", { folder: null, name: "Clock" });
  assert.equal(mine.message, "Saved mine.png and mine back 2.png");
  assert.equal(besideFree("/x/Shot FRONT.png", () => false), path.join("/x", "Shot BACK.png"));
  assert.equal(besideFree("/x/frontier.png", () => false), path.join("/x", "frontier back.png"));
});

test("Record: the first press starts, the second stops and asks where; the video goes to the project's media/ by default", async () => {
  const n0 = n;
  const { call, sent, asked, takes, project, data } = setup({ choose: [path.join(root, `run ${n0}`, `${cyr(0x041f, 0x0440, 0x043e, 0x0435, 0x043a, 0x0442)} Ωmega`, "media", "my take.mp4")] });
  const started = await call("capture.record.start", { folder: project, name: "Omega" });
  assert.deepEqual(started, { ok: true, layout: "window", startedAt: new Date(2026, 10, 11, 15, 42, 7).getTime(), maxSeconds: 120 });
  assert.deepEqual(takes[0].question, { out: takes[0].question.out, fps: RECORD_FPS, frames: 120 * RECORD_FPS });
  assert.equal(path.dirname(takes[0].question.out), path.join(data, "captures"));
  assert.equal((await call("capture.record.state")).recording, true);
  assert.equal((await call("capture.record.start", { folder: project })).code, "busy", "one recording at a time");
  assert.equal((await call("capture.record.start", { folder: project, layout: "post" })).code, "busy", "of any layout");
  assert.deepEqual(asked, [], "no dialog while it records");

  const done = await call("capture.record.stop");
  assert.deepEqual(asked, [{ kind: "recording", defaultPath: path.join(project, "media", "Omega 2026-11-11 15.42.07.mp4") }]);
  assert.deepEqual(done, { ok: true, file: path.join(project, "media", "my take.mp4"), name: "my take.mp4", seconds: 1.5, limit: false, layout: "window", width: 1200, height: 800 });
  assert.ok(existsSync(done.file));
  assert.deepEqual(sent.map((event) => event.state), ["recording", "saving", "saved"]);
  assert.equal(sent[1].reason, "stopped");
  assert.deepEqual(readdirSync(path.join(data, "captures")), [], "the take in the data folder is gone");
  assert.equal((await call("capture.record.state")).recording, false);
  assert.equal((await call("capture.record.stop")).code, "not_recording");
});

test("Record: saved where the person chose, with .mp4 added; Show in Finder shows it; Cancel deletes the take and the empty media/", async () => {
  const chosen = path.join(root, `videos ${n} ${cyr(0x0412, 0x0438, 0x0434, 0x0435, 0x043e)}`, "take one");
  const { call, project, data, shown } = setup({ choose: [chosen, null] });
  await call("capture.record.start", { folder: project, name: "Omega" });
  const saved = await call("capture.record.stop");
  assert.deepEqual(saved, { ok: true, file: `${chosen}.mp4`, name: "take one.mp4", seconds: 1.5, limit: false, layout: "window", width: 1200, height: 800 });
  assert.ok(existsSync(`${chosen}.mp4`));
  assert.equal(existsSync(path.join(project, "media")), false, "media/ made for the dialog and not used is taken away");
  assert.equal(await call("capture.reveal", `${chosen}.mp4`), true);
  assert.deepEqual(shown, [`${chosen}.mp4`]);

  await call("capture.record.start", { folder: project, name: "Omega" });
  const canceled = await call("capture.record.stop");
  assert.deepEqual(canceled, { ok: true, file: null, seconds: 1.5 });
  assert.deepEqual(readdirSync(path.join(data, "captures")), []);
  assert.equal(existsSync(path.join(project, "media")), false);
});

test("Record of an app without a project: the dialog opens in Movies or Videos", async () => {
  const { call, asked, videos } = setup();
  await call("capture.record.start", { folder: null, name: "Weather" });
  await call("capture.record.stop");
  assert.deepEqual(asked, [{ kind: "recording", defaultPath: path.join(videos, "Weather 2026-11-11 15.42.07.mp4") }]);
});

test("Record stops by itself at its longest: the page is told, and the Save dialog comes without a press", async () => {
  const chosen = path.join(root, `limit ${n}.mp4`);
  const { call, sent, takes, project } = setup({ choose: [chosen] });
  await call("capture.record.start", { folder: project, name: "Omega" });
  takes[0].toLimit();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sent.map((event) => event.state), ["recording", "saving", "saved"]);
  assert.equal(sent[1].reason, "limit");
  assert.deepEqual([sent[2].file, sent[2].limit, sent[2].seconds], [chosen, true, 120]);
  assert.equal((await call("capture.record.state")).recording, false);
});

test("Record that does not start (the window gives no frames) says so and leaves nothing; the app's end deletes a take", async () => {
  const { call, data } = setup({ record: async () => ({ answer: "unavailable", code: "window_hidden", reason: "it is hidden or minimized and gave no frame in 10 s", hint: "Bring the emulator's window to the front, then record again." }) });
  assert.deepEqual(await call("capture.record.start", { folder: null }), { ok: false, code: "window_hidden", message: "The window cannot be recorded: it is hidden or minimized and gave no frame in 10 s.", hint: "Bring the emulator's window to the front, then record again." });
  // On the screen but with no frames, or still loading (EMU-299): the reason, not "hidden", and a next step.
  for (const [code, reason, hint] of [
    ["no_frames", "it is on the screen but gave no frame in 10 s; the computer's graphics may be busy", "Record again in a moment; if it keeps failing, quit the emulator and start it again."],
    ["window_loading", "its page was still loading after 45 s", "Wait until the window shows the bar, then record again."],
  ]) {
    const other = setup({ record: async () => ({ answer: "unavailable", code, reason, hint }) });
    assert.deepEqual(await other.call("capture.record.start", { folder: null }), { ok: false, code, message: `The window cannot be recorded: ${reason}.`, hint });
  }
  assert.equal((await call("capture.record.state")).recording, false);
  assert.deepEqual(readdirSync(path.join(data, "captures")), []);

  const other = setup();
  await other.call("capture.record.start", { folder: null });
  other.capture.endAll();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(other.asked, [], "no dialog on the way out");
  assert.deepEqual(readdirSync(path.join(other.data, "captures")), []);
  assert.equal(other.capture.recording(), false);
});

test("a hidden or test run shows no Save dialog: it keeps what it would have asked; the tests' stand-in answers", async () => {
  const shown = [];
  const hidden = createSaveDialog({ showSaveDialog: async (o) => (shown.push(o), { canceled: false, filePath: "/x.mp4" }), config: { hidden: true, testHook: null }, log: () => {} });
  hidden.standIn("/ignored.mp4");
  assert.equal(await hidden.save("recording", "/Movies/a.mp4"), null);
  assert.deepEqual(hidden.planned, [{ kind: "recording", title: "Save Recording", defaultPath: "/Movies/a.mp4" }]);
  const tested = createSaveDialog({ showSaveDialog: async (o) => (shown.push(o), { canceled: false, filePath: "/x.mp4" }), config: { hidden: true, testHook: "/sock" }, log: () => {} });
  tested.standIn("/chosen.png");
  assert.equal(await tested.save("screenshot", "/Pictures/a.png"), "/chosen.png");
  assert.equal(await tested.save("screenshot", "/Pictures/b.png"), null);
  assert.equal(tested.planned.length, 2);
  assert.deepEqual(shown, []);
  // On the screen: the system's dialog, MP4 or PNG, asking before it replaces a file.
  const real = createSaveDialog({ showSaveDialog: async (o) => (shown.push(o), { canceled: false, filePath: "/Movies/b.mp4" }), config: { hidden: false, testHook: null }, log: () => {} });
  assert.equal(await real.save("recording", "/Movies/a.mp4"), "/Movies/b.mp4");
  assert.deepEqual(shown[0].filters, [{ name: "MP4 video", extensions: ["mp4"] }]);
  assert.ok(shown[0].properties.includes("showOverwriteConfirmation"));
});

test("file names: what the app is called, without what macOS or Windows cannot hold; the time without colons", () => {
  assert.equal(fileName('a<b>c:d"e/f\\g|h?i*j'), "a b c d e f g h i j");
  assert.equal(fileName(`  ${cyr(0x0427, 0x0430, 0x0441, 0x044b)}  Ωμέγα. `), `${cyr(0x0427, 0x0430, 0x0441, 0x044b)} Ωμέγα`);
  assert.equal(fileName(""), "BUSY Bar");
  assert.equal(fileName("x".repeat(100)).length, 60);
  assert.equal(stampOf(new Date(2026, 0, 2, 3, 4, 5).getTime()), "2026-01-02 03.04.05");
});

test("Record a post or the front display: the command line records the bar until record --stop; the Save dialog names the layout", async () => {
  assert.deepEqual(RECORD_LAYOUTS, ["window", "post", "front"]);
  const n0 = n;
  const chosen = path.join(root, `run ${n0}`, "post one.mp4");
  const { call, calls, sent, asked, bar, takes, project, data, shown } = setup({ choose: [chosen] });
  const started = await call("capture.record.start", { folder: project, name: "Omega", layout: "post" });
  assert.deepEqual(started, { ok: true, layout: "post", startedAt: new Date(2026, 10, 11, 15, 42, 7).getTime(), maxSeconds: 120 });
  assert.equal(takes.length, 0, "the window is not recorded");
  assert.deepEqual(bar.takes[0].words.slice(0, 7), ["record", "--layout", "post", "--seconds", "120", "--fps", String(RECORD_FPS)]);
  assert.equal(path.dirname(bar.takes[0].out), path.join(data, "captures"));
  assert.deepEqual(await call("capture.record.state"), { recording: true, saving: false, layout: "post", startedAt: started.startedAt, maxSeconds: 120 });
  assert.equal(sent[0].layout, "post");

  const done = await call("capture.record.stop");
  assert.ok(calls.includes("record --stop --json"), calls.join("\n"));
  assert.deepEqual(asked, [{ kind: "recording", defaultPath: path.join(project, "media", "Omega 2026-11-11 15.42.07 post.mp4") }]);
  assert.deepEqual(done, { ok: true, file: chosen, name: "post one.mp4", seconds: 2, limit: false, layout: "post", width: 1080, height: 1920 });
  assert.equal(await call("capture.reveal", chosen), true);
  assert.deepEqual(shown, [chosen]);
  assert.deepEqual(readdirSync(path.join(data, "captures")), []);

  // The front display, at its longest: it stops by itself and the dialog comes.
  const front = setup({ choose: [path.join(root, `front ${n}.mp4`)] });
  await front.call("capture.record.start", { folder: null, name: "Weather", layout: "front" });
  front.bar.takes[0].toLimit();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(front.sent.map((event) => [event.state, event.reason ?? null]), [["recording", null], ["saving", "limit"], ["saved", null]]);
  assert.equal(front.asked[0].defaultPath, path.join(front.videos, "Weather 2026-11-11 15.42.07 front.mp4"));
  assert.deepEqual([front.sent[2].limit, front.sent[2].seconds, front.sent[2].layout], [true, 120, "front"]);
});

test("Record of the bar: refused at once in the command's words; a failure later is told to the page with its hint; the app's end stops the command", async () => {
  const { call, bar, data } = setup();
  bar.refuse = { ok: false, command: "record", code: "not_running", message: "The emulator is running, but its bar is not ready (starting).", hint: "Run busy-emulator start, run your app, then record." };
  const refused = await call("capture.record.start", { folder: null, layout: "front" });
  assert.deepEqual([refused.ok, refused.code], [false, "not_running"]);
  assert.match(refused.message, /bar is not ready/);
  assert.equal((await call("capture.record.state")).recording, false);
  assert.deepEqual(readdirSync(path.join(data, "captures")), []);
  assert.equal((await call("capture.record.start", { folder: null, layout: "square" })).code, "bad_layout");

  const later = setup();
  await later.call("capture.record.start", { folder: null, layout: "post" });
  later.bar.takes[0].fail({ ok: false, command: "record", code: "encode_failed", message: "The app could not encode the clip: no H.264 encoder.", hint: "Screenshots still work: busy-emulator screenshot." });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = later.sent.at(-1);
  assert.equal(failed.state, "failed");
  assert.equal(failed.message, "The recording failed: the app could not encode the clip: no H.264 encoder.");
  assert.ok(failed.hint, "the hint comes with it");
  assert.equal((await later.call("capture.record.state")).recording, false);

  const ending = setup();
  await ending.call("capture.record.start", { folder: null, layout: "post" });
  ending.capture.endAll();
  assert.equal(ending.bar.interrupted, 1, "the command line's record is stopped");
  assert.deepEqual(ending.asked, []);
});
