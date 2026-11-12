// busy-emulator screenshot [--back] [--out <path>] [--scale <n>]: the frame a display of the running bar shows now, as
// a PNG at the display's own size, which the BUSY Apps Catalog takes as a screenshot (ADR-0006, EMU-019).
//
// The frame comes from the BUSY Bar's own API, GET /api/screen, and is encoded here, in the command line's process: the
// server does no more than answer that request, so a screenshot costs the BUSY Bar's tick nothing beyond it. The file holds
// the image and nothing else (capture/png.mjs: IHDR, IDAT, IEND; no time, name or software). It is checked by the
// catalog's rules (capture/catalog-png.mjs); a copy that lacks that file says that it did not check.
//
// Where the file goes: --out names the file (replaced if it is there) or a folder; without --out, screenshots/ in the
// current folder. In a folder the name is front-<n>.png or back-<n>.png, n the next number not taken there, and an
// existing file is never replaced; a file --out replaces is said to be replaced. --scale <n> also writes the frame
// enlarged n times beside it, as <name>@<n>x.png. It does not start the emulator: when that is not running and ready,
// the answer is not_running.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

export const MAX_SCALE = 32; // capture/png.mjs MAX_SCALE; a test checks they agree
const FOLDER = "screenshots";
const TRIES = 1000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const USAGE = "screenshot [--back] [--out <path>] [--scale <n>]";

function isDirectory(file) {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the command writes: a file to replace, or a folder to number the file in. A relative --out is taken from the
 * caller's folder. Paths are this system's: the files are written here.
 */
function target(sys, out, usage) {
  const cwd = sys.cwd();
  if (out === undefined) return { folder: path.join(cwd, FOLDER) };
  if (out === "") throw usage("--out needs a path: a .png file or a folder.");
  const windows = path.sep === "\\";
  // A " cannot be in a Windows path. It is there when PowerShell 5.1 passed `--out "C:\my dir\" --json`: the \ before
  // the closing quote keeps the quote in the value and the words after it go into the same argument. The folder
  // should end in / instead. If --json was among the swallowed words, the answer is JSON, as the caller asked.
  if (windows && out.includes('"')) {
    const swallowed = out.slice(out.indexOf('"') + 1).trim().split(/\s+/).filter(Boolean);
    const error = usage(
      `--out ${JSON.stringify(out)} holds a ", which a Windows path cannot have: the shell kept the quote after a \\ at the end of the path` +
        `${swallowed.length ? ` and took ${swallowed.join(" ")} into it` : ""}. End a folder with / instead, as in --out "C:\\my dir/".`,
    );
    error.extra.swallowed = swallowed;
    if (swallowed.includes("--json")) error.answerAsJson = true;
    throw error;
  }
  const absolute = path.resolve(cwd, out);
  const endsInSeparator = windows ? /[\\/]$/.test(out) : out.endsWith("/");
  if (endsInSeparator || isDirectory(absolute)) return { folder: absolute };
  if (!/\.png$/i.test(absolute)) throw usage(`--out names ${absolute}, which is neither a folder nor a .png file; for a new folder end the path with /.`);
  return { file: absolute };
}

function scaleOf(value, usage) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || Number(value) < 2 || Number(value) > MAX_SCALE) {
    throw usage(`--scale takes a whole number from 2 to ${MAX_SCALE}, not ${JSON.stringify(value)}.`);
  }
  return Number(value);
}

/** The encoder, loaded only by this command: a copy of the command line without it still runs every other one. */
async function encoder() {
  try {
    return await import("../../capture/png.mjs");
  } catch (e) {
    if (e?.code !== "ERR_MODULE_NOT_FOUND") throw e;
    throw new CliError("internal", "This copy of the emulator has no PNG encoder (packages/server/capture/png.mjs).", "Report this: the app is incomplete.");
  }
}

/** The frame of the display, checked to be one: base64 of exactly the display's number of bytes. */
async function frameOf(ctx, sys, port, screen, name) {
  const answer = await sys.screen(port, screen.display);
  if (answer.blocked) throw blockedNetwork(port, answer.blocked);
  const failed = (why, hint = `Run ${commandLine(ctx)} status to see whether the emulator still runs, then try again.`) =>
    new CliError("screen_failed", `The BUSY Bar at 127.0.0.1:${port} gave no frame of its ${name} display: ${why.replace(/\.$/, "")}.`, hint);
  if (answer.failed) throw failed(answer.failed);
  if (answer.status !== 200) {
    // The emulator says why in {"error": "…"}: the bar is off, or the emulator is stopping.
    let said = null;
    try {
      said = JSON.parse(answer.body).error;
    } catch {
      // Not its JSON: the code alone.
    }
    throw failed(`it answered ${answer.status}${typeof said === "string" && said ? ` (${said})` : ""}`, answer.status === 503 ? "If the BUSY Bar is off, turn it on in the emulator's window, then try again." : undefined);
  }
  const text = answer.body.trim();
  if (!BASE64.test(text)) throw failed("its answer is not base64");
  const frame = Buffer.from(text, "base64");
  if (frame.length !== screen.frameBytes) throw failed(`the frame is ${frame.length} bytes, not ${screen.frameBytes}`);
  return frame;
}

function writeFailed(file, e) {
  const code = e?.code ?? String(e);
  const hint =
    code === "EPERM" || code === "EACCES" || code === "EROFS"
      ? "The folder may be read-only, or a sandbox may forbid writing there: choose another folder with --out, or run the command outside the sandbox."
      : "Choose another place with --out.";
  return new CliError("write_failed", `Could not write ${file} (${code}).`, hint, { file });
}

/**
 * The AppleDouble file macOS makes beside a new file on exFAT and FAT (`._<name>`), to hold the attributes it gives
 * every file a process writes (com.apple.provenance): a file of the machine's, not of the screenshot, which would go
 * into the author's repository and the catalog's pull request with it. It is removed if it came with this write;
 * one that was there before is left alone.
 */
function companionOf(file) {
  return path.join(path.dirname(file), `._${path.basename(file)}`);
}

function dropCompanion(companion, existed) {
  if (!existed && existsSync(companion)) rmSync(companion, { force: true });
}

/**
 * Writes over `file` in one step: a reader sees the old file or the new one, never half of it. True if there was a
 * file to replace.
 */
function replace(file, bytes) {
  const replaced = existsSync(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const companion = companionOf(file);
  const existed = existsSync(companion);
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, file);
  } catch (e) {
    rmSync(temporary, { force: true });
    rmSync(companionOf(temporary), { force: true });
    throw writeFailed(file, e);
  }
  dropCompanion(companion, existed);
  return replaced;
}

/** Makes `file` only if nothing has that name; false if something does. */
function create(file, bytes) {
  const companion = companionOf(file);
  const existed = existsSync(companion);
  try {
    writeFileSync(file, bytes, { flag: "wx" });
  } catch (e) {
    if (e?.code === "EEXIST") return false;
    rmSync(file, { force: true });
    throw writeFailed(file, e);
  }
  dropCompanion(companion, existed);
  return true;
}

const scaledName = (file, scale) => file.replace(/\.png$/i, `@${scale}x.png`);

/**
 * Writes the file and its enlarged copy. In a folder: the next number that neither front-<n>.png nor any
 * front-<n>@<k>x.png has, made with exclusive creation, so two screenshots at once never take the same name.
 */
function save(where, name, png, scaled, scale) {
  if (where.file) {
    mkdirOf(path.dirname(where.file));
    const replaced = replace(where.file, png);
    const scaledReplaced = scaled ? replace(scaledName(where.file, scale), scaled) : false;
    return { file: where.file, replaced, scaledReplaced };
  }
  mkdirOf(where.folder);
  const taken = new RegExp(`^${name}-(\\d+)(@\\d+x)?\\.png$`, "i");
  // A folder one may write in but not list (a drop box) starts from 1: the exclusive creation finds the free name.
  let entries = [];
  try {
    entries = readdirSync(where.folder);
  } catch (e) {
    if (e?.code !== "EACCES" && e?.code !== "EPERM") throw writeFailed(where.folder, e);
  }
  let n = Math.max(0, ...entries.map((entry) => Number(taken.exec(entry)?.[1] ?? 0))) + 1;
  for (let tries = 0; tries < TRIES; tries++, n++) {
    const file = path.join(where.folder, `${name}-${n}.png`);
    if (scaled && !create(scaledName(file, scale), scaled)) continue;
    if (create(file, png)) return { file, replaced: false, scaledReplaced: false };
    if (scaled) rmSync(scaledName(file, scale), { force: true });
  }
  throw new CliError("write_failed", `Could not find a free name for the screenshot in ${where.folder}.`, "Choose a file with --out.", { file: where.folder });
}

/** Makes the folder and those above it that are not there; drops the AppleDouble files that came with them. */
function mkdirOf(folder) {
  const made = [];
  for (let at = folder; !existsSync(at) && path.dirname(at) !== at; at = path.dirname(at)) made.push([companionOf(at), existsSync(companionOf(at))]);
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw writeFailed(folder, e);
  }
  for (const [companion, existed] of made) dropCompanion(companion, existed);
}

export default {
  name: "screenshot",
  summary: "Save what a display of the BUSY Bar shows now, as a PNG for the catalog",
  usage: USAGE,
  options: {
    "--back": { key: "back" },
    "--out": { key: "out", value: "<path>" },
    "--scale": { key: "scale", value: "<n>" },
  },
  async run(ctx, sys, { options }) {
    const name = options.back ? "back" : "front";
    // A wrong call is told before anything is started or written.
    const usage = (message) => new CliError("usage", message, `Usage: ${commandLine(ctx)} ${USAGE}`);
    const scale = scaleOf(options.scale, usage);
    const where = target(sys, options.out, usage);
    const { SCREENS, encodeScreenPng, encodeScaledScreenPng } = await encoder();
    const screen = SCREENS[name];

    // A screenshot does not start the emulator: the first screen after a start is never the one an author wants, and
    // an app with a window coming up is no side effect of taking a picture (EMU-019b review, S1).
    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Run ${commandLine(ctx)} start, open your app on the BUSY Bar, then take the screenshot.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar to take a screenshot of.", hint);
      throw new CliError(
        "not_running",
        `The emulator is running, but its BUSY Bar is not ready: ${status.answering === false ? "it does not answer" : status.state}${status.detail ? ` (${status.detail})` : ""}.`,
        hint,
        { state: status.state ?? null },
      );
    }
    const frame = await frameOf(ctx, sys, status.port, screen, name);
    const png = encodeScreenPng(name, frame);
    const scaled = scale ? encodeScaledScreenPng(name, frame, scale) : null;
    const catalog = await sys.loadCatalogCheck();
    const verdict = catalog ? catalog.check(png, name) : null;

    const { file, replaced, scaledReplaced } = save(where, name, png, scaled, scale);
    const data = {
      display: name,
      width: screen.width,
      height: screen.height,
      file,
      replaced,
      bytes: png.length,
      sha256: createHash("sha256").update(png).digest("hex"),
      scaled: scaled ? { file: scaledName(file, scale), replaced: scaledReplaced, scale, width: screen.width * scale, height: screen.height * scale, bytes: scaled.length } : null,
      catalog: verdict ? { verdict: verdict.verdict, id: verdict.id ?? catalog.rules[name].id, note: verdict.note ?? null, message: verdict.message ?? null } : null,
    };
    // The encoder's files always pass; anything else is a fault of the emulator, and the author must not submit it.
    if (verdict && verdict.verdict !== "pass") {
      throw new CliError("catalog_check", `Saved ${file}, but the catalog would not take it: ${verdict.message}`, "Report this: the emulator's own files should always pass.", data);
    }

    const lines = [];
    lines.push(`${replaced ? "Replaced the file with" : "Saved"} the ${name} display, ${screen.width}×${screen.height} px: ${file}`);
    if (scaled) {
      const what = `${scale} times, ${data.scaled.width}×${data.scaled.height} px, not for the catalog: ${data.scaled.file}`;
      lines.push(scaledReplaced ? `Replaced the file with the frame enlarged ${what}` : `Enlarged ${what}`);
    }
    if (!verdict) lines.push("This copy of the emulator does not have the catalog's rules: the file was not checked against them.");
    else lines.push(`The catalog takes it as a ${name} screenshot (its check ${data.catalog.id}).`);
    if (data.catalog?.note) lines.push(`Note: ${data.catalog.note}`);
    return { data, text: lines.join("\n") };
  },
};
