// The window's Screenshot and Record buttons (the canvas's tools): what they do, in the main process.
//
// Screenshot: the frames the displays the person ticked show now (the front, the back or both), as PNGs at the
// displays' own sizes, the files the catalog and Publish take. The running app's project gets them in its
// screenshots/ as front-<n>.png and back-<n>.png, the next number not taken, each with an enlarged copy <name>@8x.png
// beside it: what Publish's "Take from the bar" makes. They are made by the command line's `screenshot`, as an
// author's terminal or an agent makes them. An app with no project (a package installed on the bar, the bar's own
// screens) has no folder to put them in: the system's Save dialog asks where the first picture goes, and the back
// display's goes beside the front's.
//
// Record: from the first press of the button to the second, RECORD_MAX_SECONDS at most (then it stops by itself), in
// one of three layouts (RECORD_LAYOUTS), as `busy-emulator record` records them: "window", the app's main window as
// the person sees it (capture-window.mjs); "post", 1080×1920 for a post, the bar and its back display; "front", the
// front display alone. The window is recorded here; the other two are a take of the bar the server records (`record
// --layout <layout>`, run as the command line, ended by `record --stop`). Either is an H.264 MP4 with a silent audio
// track, written into the data folder's captures/ first; the system's Save dialog then asks where it goes (the
// project's media/, where `record` puts its clips, or the person's Movies or Videos), and Cancel deletes it.
//
// The rules are those of the window's other actions (actions.mjs, bridge.mjs): only the main window's page asks, and
// only just after a click (the state alone needs none); a folder the page names is only looked up among the
// emulator's trusted projects; the files go only into that project's screenshots/ or media/, or where the person
// chose in the dialog; a file is shown in Finder or Explorer only when it was saved here. A hidden run and a run
// under a test show no dialog: what it would have asked is kept in `planned`, and the tests' stand-in answers it.
//
// Pure but for what it is given, so that the rules can be tested on plain Node.
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync } from "node:fs";
import path from "node:path";

import { ActionFailure, answerOf } from "./actions.mjs";
import { windowText } from "./window-texts.mjs";

/** The actions the page may ask for, by the names the bridge knows. */
export const CAPTURE_ACTIONS = Object.freeze(["capture.screenshot", "capture.record.start", "capture.record.stop", "capture.record.state", "capture.reveal"]);
/** The one that only reads: the page may ask for it at any time. */
export const CAPTURE_NO_GESTURE = Object.freeze(["capture.record.state"]);
/** The longest take of the Record button; then it stops by itself. */
export const RECORD_MAX_SECONDS = 120;
export const RECORD_FPS = 30;
/** What the Record button records: the window, a vertical clip for a post, the front display. */
export const RECORD_LAYOUTS = Object.freeze(["window", "post", "front"]);
/** The enlarged copy beside each screenshot, as Publish makes it. */
export const SCREENSHOT_SCALE = 8;
/** The bar's two displays, as a screenshot names them. */
export const DISPLAYS = Object.freeze(["front", "back"]);

const MAX_PATH = 4096;
/** How long the server has to refuse a take of the bar (it is off, --fast, another clip) before it counts as begun. */
const BAR_REFUSES_WITHIN_MS = 300;
const MAX_NAME = 60;

export const SAVE_DIALOGS = Object.freeze({
  recording: Object.freeze({ title: "Save Recording", button: "Save", filter: { name: "MP4 video", extensions: ["mp4"] } }),
  screenshot: Object.freeze({ title: "Save Screenshot", button: "Save", filter: { name: "PNG image", extensions: ["png"] } }),
});

const refusal = (code, message, hint = null) => ({ ok: false, code, message, ...(hint ? { hint } : {}) });

/** A name for a file: what the app is called, without what a file name cannot hold on macOS or Windows. */
export function fileName(name, fallback = "BUSY Bar") {
  const clean = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME)
    .replace(/[. ]+$/, "");
  return clean || fallback;
}

/** The local time as a file name takes it: 2026-11-11 15.42.07 (no colons: Windows has none in names). */
export function stampOf(time) {
  const d = new Date(time);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
}

/** `file` with the extension `ext` (".mp4"): kept when it has it in any case, added when not. */
function withExtension(file, ext) {
  return file.toLowerCase().endsWith(ext) ? file : `${file}${ext}`;
}

function real(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return null;
  }
}

const inside = (file, folder) => file === folder || file.startsWith(folder + path.sep);

/** Moves a file, across disks too. */
function move(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e?.code !== "EXDEV") throw e;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}

/**
 * The Save dialog of the system's, for a recording or a screenshot. A hidden run and a run under a test show none:
 * the dialog is kept in `planned` as it would have been asked, and answered by the tests' stand-in, or "none".
 * @param {object} o
 * @param {(options: object) => Promise<{ canceled: boolean, filePath?: string }>} o.showSaveDialog  Electron's, in
 *   front of the app's window when it has one
 * @param {object} o.config  resolveConfig(): `hidden`, `testHook`
 * @param {(line: string) => void} o.log
 * @param {() => void} [o.comeForward]
 */
export function createSaveDialog({ showSaveDialog, config, log, comeForward = () => {} }) {
  const standIns = [];
  const planned = [];
  let open = false;
  // `own`: the dialog's words for a kind that is not one of SAVE_DIALOGS (Report a Bug's archive, report-actions.mjs).
  async function save(kind, defaultPath, own = null) {
    const texts = own ?? SAVE_DIALOGS[kind];
    if (config.hidden || config.testHook) {
      planned.push({ kind, title: texts.title, defaultPath });
      const answer = config.testHook && standIns.length ? standIns.shift() : null;
      log(`[shell] save dialog (${texts.title}): not shown in a ${config.hidden ? "hidden run" : "test"}; ${answer ? "answered by the test's stand-in" : "nothing chosen"}`);
      return answer;
    }
    if (open) return null;
    open = true;
    try {
      comeForward();
      const result = await showSaveDialog({
        title: texts.title,
        buttonLabel: texts.button,
        defaultPath,
        filters: [texts.filter],
        properties: ["createDirectory", "showOverwriteConfirmation", "dontAddToRecent"],
      });
      const file = result?.canceled ? null : (result?.filePath ?? null);
      return typeof file === "string" && file && path.isAbsolute(file) ? file : null;
    } catch (e) {
      log(`[shell] save dialog (${texts.title}) failed: ${e?.message ?? e}`);
      return null;
    } finally {
      open = false;
    }
  }
  return {
    save,
    /** The dialogs a hidden or test run did not show, in order: { kind, title, defaultPath }. */
    planned,
    /** For the tests: what the next dialog answers (a path, or null for Cancel). Does nothing without the test entry. */
    standIn(answer) {
      if (config.testHook) standIns.push(answer);
    },
  };
}

/** The displays a screenshot takes, in the order front, back: both when the page names none; null for a wrong list. */
export function displaysOf(given) {
  if (given === undefined || given === null) return [...DISPLAYS];
  if (!Array.isArray(given) || given.length === 0 || given.length > DISPLAYS.length) return null;
  if (!given.every((one) => DISPLAYS.includes(one)) || new Set(given).size !== given.length) return null;
  return DISPLAYS.filter((one) => given.includes(one));
}

/**
 * Where the back display's picture goes beside the front's the person chose: its name with "front" at the end made
 * "back" (Weather front.png, Weather back.png), or " back" added; a file that is there already is not replaced: the
 * next free " 2", " 3".
 */
export function besideFree(front, exists = existsSync) {
  const folder = path.dirname(front);
  const stem = path.basename(front).replace(/\.png$/i, "");
  const swapped = /(^|[ _-])front$/i.test(stem) ? stem.replace(/front$/i, (word) => (word === "FRONT" ? "BACK" : word[0] === "F" ? "Back" : "back")) : `${stem} back`;
  for (let n = 1; n < 1000; n++) {
    const file = path.join(folder, `${swapped}${n === 1 ? "" : ` ${n}`}.png`);
    if (!exists(file) && !exists(file.replace(/\.png$/i, `@${SCREENSHOT_SCALE}x.png`))) return file;
  }
  return path.join(folder, `${swapped} ${randomBytes(3).toString("hex")}.png`);
}

/**
 * @param {object} o
 * @param {(args: string[], o?: { onLine?: Function }) => { exited: Promise<object>, interrupt?: Function }} o.startCli
 *   one run of the command line; `onLine(line, stream)` gets what it prints while it runs
 * @param {(folder: string) => Promise<{ project?: object, refused?: object }>} o.projectFor  actions.mjs's
 * @param {(question: object, signal: AbortSignal, until: object) => Promise<object>} o.recordWindow  capture-window.mjs's
 * @param {{ save: (kind: string, defaultPath: string) => Promise<string|null> }} o.dialog  createSaveDialog()
 * @param {(file: string) => void} o.show   shows a file in Finder or Explorer
 * @param {(event: object) => void} o.send  what the recording does by itself, to the main window's page
 * @param {{ pictures: string, videos: string }} o.folders  the person's, for what has no project
 * @param {string} o.dataDir
 * @param {string} o.logFile
 * @param {(line: string) => void} o.log
 * @param {() => number} [o.now]
 * @param {string} [o.platform]
 * @param {number} [o.maxSeconds]
 */
export function createCaptureActions({ startCli, projectFor, recordWindow, dialog, show, send, folders, dataDir, logFile, log, now = Date.now, platform = process.platform, maxSeconds = RECORD_MAX_SECONDS }) {
  const words = (text) => windowText(text, { platform });
  const saved = new Set(); // the files saved here: the ones Show in Finder may show
  let shooting = false;
  let recording = null; // { layout, startedAt, folder, name, out, stop, cancel, finished, run }

  const emit = (event) => {
    try {
      send({ capture: true, kind: "recording", ...event });
    } catch (e) {
      log(`[shell] capture: the recording's news did not reach the window: ${e?.message ?? e}`);
    }
  };

  async function ask(args) {
    const run = startCli([...args, "--json"]);
    return answerOf(await run.exited, logFile);
  }

  /** The project the page names, when it may be written to; null for none. A folder that is not one is refused. */
  async function projectOf(target) {
    const folder = target?.folder ?? null;
    if (folder === null) return { project: null };
    if (typeof folder !== "string" || !folder || folder.length > MAX_PATH) return { refused: refusal("unknown_project", "This is not a project of the emulator.") };
    const { project, refused } = await projectFor(folder);
    return refused ? { refused } : { project };
  }

  /**
   * One display into the project's screenshots/, as Publish's "Take from the bar" takes it (`publish screenshots
   * --take`): the next number, its enlarged copy, and the end of the order in catalog.json when the project has one.
   * The file the command line made is checked to be there.
   */
  async function shotInto(folder, back) {
    const shots = path.join(folder, "screenshots");
    const answer = await ask(["publish", "screenshots", folder, `--take=${back ? "back" : "front"}`]);
    if (!answer.ok) return { failed: answer };
    const file = typeof answer.taken === "string" ? real(path.join(folder, ...answer.taken.split("/"))) : null;
    const root = real(shots);
    if (!file || !root || !inside(file, root)) {
      log(`[shell] capture: the screenshot is not where it was asked to go: ${JSON.stringify(String(answer.taken).slice(0, 300))}`);
      return { failed: { code: "write_failed", message: "The screenshot was not saved in the project's screenshots folder." } };
    }
    const scaled = real(file.replace(/\.png$/i, `@${SCREENSHOT_SCALE}x.png`));
    for (const one of [file, scaled]) if (one && inside(one, root)) saved.add(one);
    return { file, relative: path.relative(folder, file).split(path.sep).join("/"), display: back ? "back" : "front", width: back ? 160 : 72, height: back ? 80 : 16 };
  }

  const methods = {
    /**
     * { folder, name, displays }: the running app's project and name, or folder null for an app without one, and the
     * displays to take ("front", "back" or both; both when not named). Resolves to
     * { ok: true, saved: [{ display, file, relative?, width, height }], folder?, message } or { ok: true, saved: [] } when the person
     * closed the Save dialog; a failure is { ok: false, code, message, hint? }.
     */
    async "capture.screenshot"(target) {
      const displays = displaysOf(target?.displays);
      if (!displays) return refusal("bad_displays", "Choose the front display, the back display or both.");
      if (shooting) return refusal("busy", "A screenshot is being taken.");
      shooting = true;
      try {
        const { project, refused } = await projectOf(target);
        if (refused) return refused;
        if (project) {
          const folder = project.folder;
          // One after the other: each may write the order in catalog.json. A display that fails after one that was
          // saved is logged; the one saved stays.
          const shots = [];
          let failed = null;
          for (const display of displays) {
            const shot = await shotInto(folder, display === "back");
            if (shot.failed) {
              failed ??= shot.failed;
              log(`[shell] capture: the ${display} display's screenshot failed: ${shot.failed.message ?? shot.failed.code}`);
              if (!shots.length) break;
            } else shots.push(shot);
          }
          if (!shots.length) return refusal(failed?.code ?? "screen_failed", words(failed?.message ?? "The screenshot was not taken."), words(failed?.hint ?? null));
          const message = `Saved ${shots[0].relative}${shots.slice(1).map((one) => ` and ${path.posix.basename(one.relative)}`).join("")}`;
          return { ok: true, folder, saved: shots, message };
        }
        // No project: the Save dialog asks where the first display's picture goes; the other one goes beside it.
        const both = displays.length === 2;
        const suggested = `${fileName(target?.name)} ${stampOf(now())}${both || displays[0] === "back" ? ` ${displays[0]}` : ""}.png`;
        const chosen = await dialog.save("screenshot", path.join(folders.pictures, suggested));
        if (!chosen) return { ok: true, saved: [], message: null };
        const first = withExtension(chosen, ".png");
        const files = both ? [first, besideFree(first)] : [first];
        const shots = [];
        for (const [i, display] of displays.entries()) {
          const answer = await ask(["screenshot", ...(display === "back" ? ["--back"] : []), "--out", files[i], "--scale", String(SCREENSHOT_SCALE)]);
          if (!answer.ok) {
            if (!shots.length) return refusal(answer.code ?? "screen_failed", words(answer.message ?? "The screenshot was not taken."), words(answer.hint ?? null));
            log(`[shell] capture: the ${display} display's screenshot failed: ${answer.message ?? answer.code}`);
            break;
          }
          const made = real(files[i]) ?? files[i];
          saved.add(made);
          if (typeof answer.scaled?.file === "string") saved.add(real(answer.scaled.file) ?? answer.scaled.file);
          shots.push({ display, file: made, width: display === "back" ? 160 : 72, height: display === "back" ? 80 : 16 });
        }
        return { ok: true, saved: shots, message: `Saved ${shots.map((one) => path.basename(one.file)).join(" and ")}` };
      } finally {
        shooting = false;
      }
    },

    /**
     * { folder, name, layout }: as for a screenshot, and what to record (RECORD_LAYOUTS; the window when not named).
     * Resolves once the take has begun: the window's first frame is in it, or the server records the bar.
     */
    async "capture.record.start"(target) {
      const layout = target?.layout ?? "window";
      if (!RECORD_LAYOUTS.includes(layout)) return refusal("bad_layout", "Record the window, a clip for a post or the front display.");
      if (recording) return refusal("busy", "A recording is being made already.");
      const { project } = await projectOf(target);
      const captures = path.resolve(dataDir, "captures");
      mkdirSync(captures, { recursive: true });
      const out = path.join(captures, `${layout}-${now()}-${randomBytes(4).toString("hex")}.mp4`);
      const stop = new AbortController();
      const cancel = new AbortController();
      let began;
      const started = new Promise((resolve) => (began = resolve));
      const mine = { layout, startedAt: null, folder: project?.folder ?? null, name: fileName(target?.name ?? project?.name), out, stop, cancel, finished: null, discard: false, run: null };
      recording = mine;
      const done = (layout === "window" ? recordWindow({ out, fps: RECORD_FPS, frames: maxSeconds * RECORD_FPS }, cancel.signal, { stop: stop.signal, onStarted: () => began(true) }) : recordBar(mine, () => began(true))).catch((e) => ({ answer: "unavailable", reason: String(e?.message ?? e) }));
      const first = await Promise.race([started, done.then(() => false)]);
      if (!first) {
        recording = null;
        rmSync(out, { force: true });
        const result = await done;
        log(`[shell] capture: the recording did not start: ${result.reason ?? result.answer}`);
        // The window's own trouble (EMU-299): hidden or closed, still loading, or on the screen and giving no frames.
        if (["window_hidden", "window_loading", "no_frames"].includes(result.code)) {
          const why = typeof result.reason === "string" && result.reason ? `The window cannot be recorded: ${result.reason.replace(/\.$/, "")}.` : "The window must be on the screen to be recorded.";
          return refusal(result.code, words(why), words(result.hint ?? (result.code === "window_hidden" ? "Bring the window to the front, then record again." : "Record again in a moment.")));
        }
        if (result.missing) return refusal("encode_failed", `This computer cannot encode the video: ${result.missing} is missing.`);
        if (result.message) return refusal(result.code ?? "record_failed", words(result.message), words(result.hint ?? null));
        return refusal("record_failed", "The recording did not start.", `The log is at ${logFile}.`);
      }
      mine.startedAt = now();
      mine.finished = finish(mine, done);
      emit({ state: "recording", layout, startedAt: mine.startedAt, maxSeconds });
      return { ok: true, layout, startedAt: mine.startedAt, maxSeconds };
    },

    /** Stops the take and asks where it goes. Resolves to { ok: true, file } (null when the person chose Cancel). */
    async "capture.record.stop"() {
      const mine = recording;
      if (!mine?.finished) return refusal("not_recording", "The window is not being recorded.");
      stopTake(mine);
      return mine.finished;
    },

    async "capture.record.state"() {
      return recording ? { recording: true, saving: recording.saving === true, layout: recording.layout, startedAt: recording.startedAt, maxSeconds } : { recording: false, saving: false, layout: null, startedAt: null, maxSeconds };
    },

    /** Shows a file this window saved in Finder or Explorer; any other is false. */
    async "capture.reveal"(file) {
      if (typeof file !== "string" || file.length > MAX_PATH || !path.isAbsolute(file)) return false;
      const one = real(file);
      if (!one || !saved.has(one)) {
        log(`[shell] capture: refused to show ${JSON.stringify(file.slice(0, 200))}: not a file the window saved`);
        return false;
      }
      show(one);
      return true;
    },
  };

  /**
   * A take of the bar (layouts post and front): the command line's `record`, which asks the server for it and waits
   * until the clip is encoded into `mine.out`; it has begun once the command said so and the server has not refused
   * at once (the bar off, --fast, another clip). Resolves as recordWindow does: { answer: "encoded", decoded, width,
   * height }, or why not, with the command's own words.
   */
  async function recordBar(mine, onStarted) {
    let said = false;
    const run = startCli(["record", "--layout", mine.layout, "--seconds", String(maxSeconds), "--fps", String(RECORD_FPS), "--out", mine.out, "--json", "--progress"], {
      onLine: (line, stream) => {
        if (stream !== "err" || said || !/^Recording /.test(line)) return;
        said = true;
        // The server refuses at once or records: a moment for a refusal to come back.
        setTimeout(() => recording === mine && !mine.ended && onStarted(), BAR_REFUSES_WITHIN_MS);
      },
    });
    mine.run = run;
    const answer = answerOf(await run.exited, logFile);
    mine.ended = true;
    if (answer.ok) return { answer: "encoded", decoded: answer.decoded_frames ?? answer.frames, width: answer.width, height: answer.height };
    return { answer: "unavailable", reason: answer.message ?? answer.code, code: answer.code, message: answer.message, hint: answer.hint ?? null, ...(answer.missing ? { missing: answer.missing } : {}) };
  }

  /** Ends a take early: the window's at the frame it comes to; the bar's by `record --stop`. */
  function stopTake(mine) {
    if (mine.stop.signal.aborted) return;
    mine.stop.abort();
    if (mine.layout === "window" || mine.ended) return;
    ask(["record", "--stop"])
      .then((answer) => answer.ok || answer.code === "not_recording" || log(`[shell] capture: the take of the BUSY Bar did not stop: ${answer.message ?? answer.code}`))
      .catch((e) => log(`[shell] capture: the take of the BUSY Bar did not stop: ${e?.message ?? e}`));
  }

  /** The take has ended (stopped, at its longest, or failed): the person chooses where it goes. */
  async function finish(mine, done) {
    const result = await done;
    const limit = !mine.stop.signal.aborted && result.answer === "encoded";
    try {
      if (mine.discard) return { ok: true, file: null, discarded: true };
      if (result.answer !== "encoded") {
        log(`[shell] capture: the recording failed: ${result.reason ?? result.answer}`);
        const failed = result.message ? refusal(result.code ?? "record_failed", words(`The recording failed: ${result.message.replace(/^The /, "the ")}`), words(result.hint ?? `The log is at ${logFile}.`)) : refusal("record_failed", "The recording failed.", `The log is at ${logFile}.`);
        emit({ state: "failed", message: failed.message, hint: failed.hint ?? null });
        return failed;
      }
      const seconds = Math.round(((result.decoded ?? 0) / RECORD_FPS) * 10) / 10;
      mine.saving = true;
      emit({ state: "saving", reason: limit ? "limit" : "stopped", seconds, maxSeconds });
      let made = null;
      const media = mine.folder ? path.join(mine.folder, "media") : null;
      if (media && !existsSync(media)) {
        try {
          mkdirSync(media);
          made = media;
        } catch {
          // The dialog opens where it can.
        }
      }
      const where = media && existsSync(media) ? media : folders.videos;
      const chosen = await dialog.save("recording", path.join(where, `${mine.name} ${stampOf(mine.startedAt)}${mine.layout === "window" ? "" : ` ${mine.layout}`}.mp4`));
      if (!chosen) {
        if (made) removeIfEmpty(made);
        log("[shell] capture: the recording was not saved: nothing was chosen; the take is deleted");
        emit({ state: "discarded" });
        return { ok: true, file: null, seconds };
      }
      const file = withExtension(chosen, ".mp4");
      if (made && !inside(path.resolve(file), made)) removeIfEmpty(made);
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        move(mine.out, file);
      } catch (e) {
        log(`[shell] capture: the recording could not be saved at ${file}: ${e?.message ?? e}`);
        const failed = refusal("write_failed", `The recording could not be saved there: ${e?.code ?? e?.message ?? e}.`, "Record again and choose another folder.");
        emit({ state: "failed", message: failed.message });
        return failed;
      }
      const at = real(file) ?? file;
      saved.add(at);
      log(`[shell] capture: saved a recording of ${seconds} s, ${result.width}×${result.height}: ${at}`);
      const answer = { ok: true, file: at, name: path.basename(at), seconds, limit, layout: mine.layout, width: result.width ?? null, height: result.height ?? null };
      emit({ state: "saved", file: at, name: answer.name, seconds, limit, layout: mine.layout });
      return answer;
    } finally {
      rmSync(mine.out, { force: true });
      if (recording === mine) recording = null;
    }
  }

  function removeIfEmpty(folder) {
    try {
      if (readdirSync(folder).length === 0) rmdirSync(folder);
    } catch {
      // Something is in it, or it is gone: it stays as it is.
    }
  }

  return {
    async call(name, arg) {
      if (!Object.hasOwn(methods, name)) return { ok: false, error: { code: "unknown_action", message: "The app has no such action.", hint: null } };
      try {
        return { ok: true, value: await methods[name](arg) };
      } catch (e) {
        if (e instanceof ActionFailure) return { ok: false, error: { code: e.code, message: e.message, hint: e.hint } };
        log(`[shell] capture: ${name} failed: ${e?.stack ?? e}`);
        return { ok: false, error: { code: "internal", message: "The emulator's app could not do it.", hint: `The log is at ${logFile}.` } };
      }
    },
    /** Whether the window is being recorded now. */
    recording: () => recording !== null,
    /** The window closed: a take goes on to its Save dialog. */
    stopRecording() {
      if (recording) stopTake(recording);
    },
    /** The app goes down: a take is deleted, no dialog. */
    endAll() {
      if (!recording) return;
      recording.discard = true;
      recording.cancel.abort();
      recording.run?.interrupt?.();
      rmSync(recording.out, { force: true });
    },
  };
}
