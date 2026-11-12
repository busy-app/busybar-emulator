// busy-emulator record [--seconds <n>] [--fps <n>] [--out <path>] [--layout window|post|front|both] [--scale <n>] [--gif]:
// a short clip of the app running on the emulated BUSY Bar, ready to post (ADR-0006, ADR-0007). `record --stop` ends the
// clip of the BUSY Bar being recorded now (another record, or the window's Record button): it is saved as far as it got.
//
// By default (layout window) the clip is the emulator's main window exactly as the person sees it, as a screen
// recording of that window would be: the BUSY Bar, its controls, the back display, the panels, all as they change during
// the take, clicks of the person and presses of an agent included as the window's own states. The app records it
// from the window's own frames (packages/app/src/capture-window.mjs), at the window's size in device pixels, in real
// time, made smaller to fit 1920×1080; the window is shown and brought to the front first. The pointer is not in the
// clip. The other layouts are
// composed from the BUSY Bar's displays and need no window on the screen:
//
// The running emulator records it (POST /_emu/record on its management address, ../../capture/record.mjs): frame i
// is what the BUSY Bar shows i / fps seconds into the take, stepped on the BUSY Bar's own clock and paced in real time. What
// the firmware moves by its clock (an .anim, scrolling text, a countdown) is exact; what the app's own JS draws is
// taken when the frame is due, and frames taken late are counted in the answer. The app's window encodes the MP4
// (H.264, in a hidden page, packages/app/src/capture-window.mjs); a GIF of the front display (--gif, or --out
// <name>.gif) the server encodes itself. The clip has no sound: its audio track (AAC, 48 kHz, stereo) holds silence,
// as the networks' upload specifications name one.
//
// Layouts: post, 1080×1920, the BUSY Bar with its front display as LED dots, the back display below and the app's name;
// front, the front display alone, 72 × scale by 16 × scale; both, 1920×1080, the BUSY Bar and the back
// display. Where the file goes: --out names the file (replaced if it is there) or a folder; without it, media/ in the
// current folder, as clip-<n>.mp4 (or .gif), n the next number not taken there. It does not start the emulator: when
// that is not running and ready, the answer is not_running.
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

// The limits of a clip are the server's (../../capture/clip-limits.mjs), loaded when the command runs: a copy of the
// command line without capture/ still loads every other command.
const limits = () => import("../../capture/clip-limits.mjs");

const USAGE = "record [--seconds <n>] [--fps <n>] [--out <path>] [--layout window|post|front|both] [--scale <n>] [--gif] | record --stop";
const FOLDER = "media";
/** How long the command waits for the clip beyond its length: the encoding of a long clip on a slow machine. */
const EXTRA_WAIT_MS = 180_000;

function whole(value, name, [min, max], usage) {
  if (value === undefined) return undefined;
  if (!/^\d{1,4}$/.test(value) || Number(value) < min || Number(value) > max) throw usage(`${name} takes a whole number from ${min} to ${max}, not ${JSON.stringify(value)}.`);
  return Number(value);
}

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Where the clip goes: a file to replace, or a folder to number it in. */
function target(cwd, out, usage) {
  if (out === undefined) return { folder: path.join(cwd, FOLDER) };
  if (out === "") throw usage("--out needs a path: a .mp4 or .gif file, or a folder.");
  const absolute = path.resolve(cwd, out);
  const endsInSeparator = path.sep === "\\" ? /[\\/]$/.test(out) : out.endsWith("/");
  if (endsInSeparator || isDirectory(absolute)) return { folder: absolute };
  if (!/\.(mp4|gif)$/i.test(absolute)) throw usage(`--out names ${absolute}, which is neither a folder nor a .mp4 or .gif file; for a new folder end the path with /.`);
  return { file: absolute };
}

function writeFailed(file, e) {
  const code = e?.code ?? String(e);
  return new CliError("write_failed", `Could not write ${file} (${code}).`, "Choose another place with --out.", { file });
}

/** Moves the clip from the emulator's data folder to `file` (another volume: a copy, then the original goes). */
function moveTo(from, file) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      renameSync(from, file);
    } catch (e) {
      if (e?.code !== "EXDEV") throw e;
      copyFileSync(from, file);
      rmSync(from, { force: true });
    }
  } catch (e) {
    throw writeFailed(file, e);
  }
}

/**
 * The next free clip-<n>.<ext> in the folder, taken: the name is made there as an empty file with O_EXCL, so that two
 * takes at once never get the same name and one never writes over the other's clip (audit H12). The clip is moved
 * over it.
 */
export function claimName(folder, ext) {
  let entries = [];
  try {
    entries = readdirSync(folder);
  } catch {
    // A new folder, or one that cannot be listed: from 1.
  }
  const taken = /^clip-(\d+)\.(mp4|gif)$/i;
  let n = Math.max(0, ...entries.map((entry) => Number(taken.exec(entry)?.[1] ?? 0))) + 1;
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw writeFailed(folder, e);
  }
  for (;; n++) {
    const file = path.join(folder, `clip-${n}.${ext}`);
    try {
      closeSync(openSync(file, "wx"));
      return file;
    } catch (e) {
      if (e?.code !== "EEXIST") throw writeFailed(file, e);
    }
  }
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

/** The running emulator's management address, or why it cannot be reached. */
async function controlOf(ctx, sys, self, unavailable) {
  const status = await emulatorStatus(ctx, sys);
  if (!ready(status)) {
    const hint = `Run ${self} start, run your app, then record.`;
    if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar to record.", hint);
    throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint, { state: status.state ?? null });
  }
  const control = sys.readControl(ctx.dataDir);
  if (control.blocked) throw new CliError("blocked_file", `This process may not read the emulator's data folder ${ctx.dataDir} (${control.blocked}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
  if (control.missing) throw unavailable(`its management address cannot be read (${control.missing})`);
  if (control.barPort !== status.port) throw unavailable(`the data folder's server is on port ${control.barPort}, the emulated BUSY Bar on ${status.port}`);
  return control;
}

/** record --stop: the take of the bar being recorded ends now; the record that asked for it saves the clip. */
async function stop(ctx, sys, self, options, usage) {
  const others = Object.keys(options).filter((key) => key !== "stop" && options[key] !== undefined);
  if (others.length) throw usage(`--stop takes no other option (${others.map((key) => `--${key}`).join(", ")}).`);
  const unavailable = (why) => new CliError("record_failed", `The emulator could not stop the clip: ${why.replace(/\.$/, "")}.`, `Run ${self} status, then try again.`);
  const control = await controlOf(ctx, sys, self, unavailable);
  const answer = await sys.stopClip(control.port, control.key);
  if (answer.blocked) throw blockedNetwork(control.port, answer.blocked);
  if (answer.failed) throw unavailable(`127.0.0.1:${control.port} did not answer (${answer.failed})`);
  let body = null;
  try {
    body = JSON.parse(answer.body);
  } catch {
    // Not the emulator's answer.
  }
  if (answer.status === 404) throw new CliError("no_app", "This emulator cannot stop a clip: it is older than record --stop.", `Quit it, then ${self} start.`);
  if (answer.status !== 200 || typeof body?.stopped !== "boolean") throw unavailable(`it answered HTTP ${answer.status}`);
  if (!body.stopped) throw new CliError("not_recording", "No clip of the BUSY Bar is being recorded.", "A clip of the window (--layout window) runs to its --seconds.");
  return { data: { stopped: true }, text: "Stopped the clip being recorded: the record that started it saves it." };
}

export default {
  name: "record",
  summary: "Record a short video of the emulator's window as you see it, an MP4 to post (--layout for the BUSY Bar alone, --gif)",
  usage: USAGE,
  options: {
    "--seconds": { key: "seconds", value: "<n>" },
    "--fps": { key: "fps", value: "<n>" },
    "--out": { key: "out", value: "<path>" },
    "--layout": { key: "layout", value: "window|post|front|both" },
    "--scale": { key: "scale", value: "<n>" },
    "--gif": { key: "gif" },
    "--stop": { key: "stop" },
  },
  async run(ctx, sys, { options, progress }) {
    const self = commandLine(ctx);
    const usage = (message) => new CliError("usage", message, `Usage: ${self} ${USAGE}`);
    if (options.stop) return stop(ctx, sys, self, options, usage);
    const { GIF_DEFAULTS, gifTooLarge, LIMITS } = await limits();
    const seconds = whole(options.seconds, "--seconds", LIMITS.seconds, usage) ?? 5;
    const fps = whole(options.fps, "--fps", options.gif ? LIMITS.gifFps : LIMITS.fps, usage);
    const scale = whole(options.scale, "--scale", LIMITS.scale, usage);
    const where = target(sys.cwd(), options.out, usage);
    const gif = Boolean(options.gif) || /\.gif$/i.test(where.file ?? "");
    if (where.file && gif !== /\.gif$/i.test(where.file)) throw usage(`--gif writes a .gif file, not ${where.file}.`);
    const layout = options.layout ?? (gif ? "front" : "window");
    if (!["window", "post", "front", "both"].includes(layout)) throw usage(`--layout is window, post, front or both, not ${JSON.stringify(layout)}.`);
    if (gif && layout !== "front") throw usage("A GIF holds the front display only: leave out --layout, or use --layout front.");
    if (scale !== undefined && layout !== "front") throw usage("--scale sizes the front layout only; window is the window's own size, post 1080×1920 and both 1920×1080.");
    const tooLarge = gif ? gifTooLarge({ seconds, fps: fps ?? GIF_DEFAULTS.fps, scale: scale ?? GIF_DEFAULTS.scale }) : null;
    if (tooLarge) throw usage(`${tooLarge[0].toUpperCase()}${tooLarge.slice(1)}.`);

    const unavailable = (why, hint = `Run ${self} status, then try again.`) => new CliError("record_failed", `The emulator could not record a clip: ${why.replace(/\.$/, "")}.`, hint);
    const control = await controlOf(ctx, sys, self, unavailable);

    const query = new URLSearchParams({ seconds: String(seconds), layout, format: gif ? "gif" : "mp4" });
    if (fps !== undefined) query.set("fps", String(fps));
    if (scale !== undefined) query.set("scale", String(scale));
    progress(`Recording ${seconds} s of ${layout === "window" ? "the emulator's window" : `the BUSY Bar${gif ? " as a GIF" : ""}`}…`);
    const answer = await sys.recordClip(control.port, control.key, query.toString(), seconds * 1000 + EXTRA_WAIT_MS);
    if (answer.blocked) throw blockedNetwork(control.port, answer.blocked);
    if (answer.failed) throw unavailable(`127.0.0.1:${control.port} did not answer (${answer.failed})`);
    let body = null;
    try {
      body = JSON.parse(answer.body);
    } catch {
      // Not the emulator's answer; told below.
    }
    const said = typeof body?.error === "string" ? body.error : `it answered HTTP ${answer.status}`;
    if (answer.status === 409 && body?.code === "fast") throw new CliError("fast_mode", said, `Quit the emulator, start it without --fast (${self} start), then record.`);
    if (answer.status === 409 && body?.code === "window_hidden") throw new CliError("window_hidden", said, `Open the emulator's window (${self} start brings it to the front), then record again; --layout post records the BUSY Bar without the window.`);
    if (answer.status === 409 && body?.code === "window_loading") throw new CliError("window_loading", said, "Wait until the emulator's window shows the BUSY Bar, then record again; --layout post records the BUSY Bar without the window.");
    if (answer.status === 409 && body?.code === "no_frames") throw new CliError("no_frames", said, "Record again in a moment; if it keeps failing, quit the emulator and start it again. --layout post records the BUSY Bar without the window.");
    if (answer.status === 409) throw new CliError("record_busy", said, "Wait until the other clip is done, then try again.");
    if (answer.status === 503) throw new CliError("not_running", said, "Turn the BUSY Bar on in the emulator's window (any button), then record.");
    if (answer.status === 501 || answer.status === 404) throw new CliError("no_app", said === `it answered HTTP ${answer.status}` ? "This emulator cannot record clips: it is older than the record command, or runs without its app." : said, `Quit it, then ${self} start.`);
    if (answer.status === 400 && body?.code === "usage") throw usage(said);
    if (answer.status === 502) throw new CliError("encode_failed", said, gif ? "Screenshots still work: busy-emulator screenshot. Try a shorter GIF or a smaller --scale." : "Screenshots still work: busy-emulator screenshot. Try --gif for a GIF of the front display.", body?.missing ? { missing: body.missing } : {});
    if (answer.status !== 200 || typeof body?.file !== "string") throw unavailable(said);

    const ext = gif ? "gif" : "mp4";
    let file = where.file ?? null;
    let replaced = false;
    if (file) replaced = existsSync(file);
    else file = claimName(where.folder, ext);
    try {
      moveTo(body.file, file);
    } catch (e) {
      if (!where.file) rmSync(file, { force: true }); // the empty file that held the name
      throw e;
    }

    const data = { ...body, file };
    delete data.record_ms;
    data.replaced = replaced;
    const lines = [];
    lines.push(`${replaced ? "Replaced the file with" : "Saved"} a ${body.seconds} s clip, ${body.width}×${body.height} at ${body.fps} frames a second, ${body.frames} frames, ${megabytes(body.bytes)}: ${file}`);
    if (body.layout === "window") {
      lines.push(`The emulator's window as it was on the screen, recorded in real time${body.repeated_frames || body.late_frames ? `: ${body.repeated_frames + body.late_frames} of ${body.frames} frames repeat the one before or came late, the computer was busy` : ", every frame on time"}. The pointer is not in the clip.`);
      if (body.resized) lines.push("The window was resized during the take: the clip keeps its first size, later frames are scaled to it.");
    } else {
      lines.push(`Frames were stepped on the BUSY Bar's clock: what the firmware animates (.anim files, scrolling text, countdowns) is exact. What the app's own JS draws was taken in real time${body.late_frames ? `: ${body.late_frames} of ${body.frames} frames were taken late (up to ${body.max_late_ms} ms), so the app's own motion may stutter there` : ", and no frame was late"}.`);
    }
    if (!gif) lines.push(`Encoded with ${body.encoder} in ${(body.encode_ms / 1000).toFixed(1)} s; ${body.decoded_frames} of ${body.frames} frames decode back.`);
    if (body.stopped) lines.push("It was stopped early (record --stop, or the window's Record button).");
    lines.push("The clip has no sound: its audio track holds silence.");
    if (!body.app && body.layout !== "window") lines.push("No app was running: the clip shows what the BUSY Bar showed.");
    return { data, text: lines.join("\n") };
  },
};
