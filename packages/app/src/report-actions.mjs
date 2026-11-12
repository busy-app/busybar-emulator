// Report a Bug (EMU-277): a new issue of the emulator's public repository, filled in, opened in the person's browser;
// and Save diagnostics, a .zip of the logs and the state, where the person says. Nothing goes to any service from here:
// the browser shows GitHub's own form with the text in it, and the person sends it there, or does not.
//
// What the form and the archive hold is scrubbed first (scrub.mjs): the home folder and the user name, the computer's
// name, tokens, Wi-Fi names, serials, MACs, e-mail addresses, the GitHub login and the folders of project paths outside
// the home folder (EMU-292). The logins are the ones the app's sign-in note holds and the ones the log names as signed
// in; the project folders are the ones the emulator's lists hold (projects/registry.json, projects/trusted.json). The dialog shows the form's text as `report.preview`
// gives it, and `report.open` opens exactly that text: the same function makes both.
//
// The address must fit: GitHub answers a new issue's address of more than about 8 KB with an error, and on Windows the
// system's call that opens an address in the browser takes about 2 KB (INTERNET_MAX_URL_LENGTH). So the log's lines are
// taken from the newest back while they fit; the form then says how many it has and that the whole log is in the
// diagnostics archive, to attach. The bar's screenshot cannot go in an address at all: it is put on the clipboard, to
// paste into the form, and into the archive.
//
// The rules are those of the window's other actions (actions.mjs, bridge.mjs): only the main window's page asks;
// the preview only reads; opening the browser, the clipboard, the Save dialog and Show in Finder need the person's
// click. The archive is written where the system's Save dialog says; the files it takes are the data folder's own,
// by their real paths (path-boundary.mjs). A hidden run and a run under a test open no browser and leave the
// clipboard alone (main.mjs keeps what they would have done for the tests).
//
// Pure but for what it is given, so that the rules can be tested on plain Node.
import { readFileSync, renameSync, rmSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";

import { ActionFailure } from "./actions.mjs";
import { stampOf } from "./capture-actions.mjs";
import { insideRoots, resolvedPath } from "./path-boundary.mjs";
import { createScrubber, loginsIn } from "./scrub.mjs";
import { makeZip } from "./zip.mjs";

/** The actions the page may ask for, by the names the bridge knows. */
export const REPORT_ACTIONS = Object.freeze(["report.preview", "report.open", "report.save", "report.reveal"]);
/** The one that only reads: the page may ask for it at any time. */
export const REPORT_NO_GESTURE = Object.freeze(["report.preview"]);

/** Where the issue goes: the emulator's public repository. */
export const REPOSITORY = "busy-app/busybar-emulator";
export const NEW_ISSUE = `https://github.com/${REPOSITORY}/issues/new`;
/** The longest address opened: Windows' limit for the browser's address, and GitHub's own (with room to spare). */
export const URL_LIMITS = Object.freeze({ win32: 2000, other: 8000 });
/** The longest address on this system. */
export const urlLimitFor = (platform) => (platform === "win32" ? URL_LIMITS.win32 : URL_LIMITS.other);
/** The log's newest lines the form may have, each cut to LOG_LINE_CHARS; the archive has the whole log. */
export const FORM_LOG_LINES = 40;
export const LOG_LINE_CHARS = 240;
/** What the person may write. */
export const LIMITS = Object.freeze({ title: 200, what: 4000, expected: 4000 });
/** A screenshot from the page: a PNG as a data: address, at most this long. */
const MAX_IMAGE = 4 * 1024 * 1024;
/** The most of one file the archive takes: its end. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export const SAVE_TEXTS = Object.freeze({ title: "Save Diagnostics", button: "Save", filter: Object.freeze({ name: "ZIP archive", extensions: ["zip"] }) });

/** What the archive takes from the data folder, by its path there, when it is there. */
export const ARCHIVED = Object.freeze(["logs/shell.log", "logs/shell.log.1", "run/emulator.json", "run/build-lines.jsonl", "app-settings.json"]);
/** Where the data folder names what the scrubber takes out besides the person's own: the sign-in's note, the project lists. */
const SIGN_IN_NOTE = "github/signed-in.json";
const PROJECT_LISTS = Object.freeze(["projects/registry.json", "projects/trusted.json"]);

const SYSTEM_NAMES = { darwin: "macOS", win32: "Windows", linux: "Linux" };

/** The fields as the page gives them: strings cut to their limits, the ticks as booleans. */
export function fieldsOf(arg) {
  const o = arg !== null && typeof arg === "object" ? arg : {};
  const text = (value, limit) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").slice(0, limit) : "");
  return {
    title: text(o.title, LIMITS.title).replace(/\s+/g, " ").trim(),
    what: text(o.what, LIMITS.what).trim(),
    expected: text(o.expected, LIMITS.expected).trim(),
    log: o.log !== false,
    screenshot: o.screenshot === true,
  };
}

/** The PNG a data: address of the page's holds, or null. */
export function pngOf(image) {
  if (typeof image !== "string" || image.length > MAX_IMAGE) return null;
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!match) return null;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? bytes : null;
}

const fence = (lines) => {
  // A line with three backticks would end the block early: the fence is longer than any run in the lines.
  const longest = Math.max(2, ...lines.map((line) => Math.max(0, ...(line.match(/`+/g) ?? []).map((run) => run.length))));
  const mark = "`".repeat(longest + 1);
  return `${mark}text\n${lines.join("\n")}\n${mark}`;
};

/**
 * The issue's text: what the person wrote, the emulator, the system and the firmware, the log's newest lines that
 * fit, and where the screenshot is. Everything in it scrubbed.
 * @param {object} o
 * @param {ReturnType<typeof fieldsOf>} o.fields
 * @param {{ version: string, build: string|null, system: { name: string, version: string|null, arch: string|null } }} o.about
 * @param {{ firmware: string|null, apiVersion: string|null }} o.bar
 * @param {string[]} o.lines   the log's newest lines, oldest first, scrubbed
 * @param {number} o.limit     the longest address; Infinity for the archive's copy
 * @param {(text: string) => string} o.scrub
 * @returns {{ title: string, body: string, url: string, length: number, limit: number, fits: boolean, over: number,
 *   lines: { shown: number, of: number } }}
 */
export function composeIssue({ fields, about, bar, lines, limit, scrub }) {
  const title = scrub(fields.title);
  const system = [about.system.name, about.system.version].filter(Boolean).join(" ") + (about.system.arch ? `, ${about.system.arch}` : "");
  const head = [
    "### What I did",
    scrub(fields.what) || "_Not filled in._",
    "",
    "### What I expected",
    scrub(fields.expected) || "_Not filled in._",
    "",
    "### The emulator",
    `- Version: ${about.version}${about.build && about.build !== "release" ? ` (${about.build} build)` : ""}`,
    `- System: ${system}`,
    `- Firmware: ${bar.firmware ?? "not running"}${bar.apiVersion ? `, API ${bar.apiVersion}` : ""}`,
  ];
  const tail = fields.screenshot ? ["", "### Screenshot", "_Paste the screenshot of the BUSY Bar here: the emulator put it on the clipboard._"] : [];
  const body = (shown) => {
    const log = [];
    if (fields.log && lines.length) {
      const some = lines.slice(lines.length - shown);
      log.push("", "### Log");
      if (shown === lines.length) log.push(`The last ${shown} lines of the emulator's log:`, "", fence(some));
      else if (shown > 0) log.push(`The last ${shown} lines of the emulator's log; the rest did not fit in the form. The whole log is in the diagnostics archive (Save diagnostics in Report a Bug): attach it here.`, "", fence(some));
      else log.push("The log did not fit in the form. It is in the diagnostics archive (Save diagnostics in Report a Bug): attach it here.");
    }
    return [...head, ...log, ...tail].join("\n");
  };
  const urlOf = (text) => `${NEW_ISSUE}?${title ? `title=${encodeURIComponent(title)}&` : ""}body=${encodeURIComponent(text)}`;
  const all = fields.log ? lines.length : 0;
  let shown = all;
  if (urlOf(body(all)).length > limit) {
    // The most lines that fit, by halves: the address grows with every line.
    let low = 0;
    let high = all - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (urlOf(body(mid)).length <= limit) low = mid;
      else high = mid - 1;
    }
    shown = low;
  }
  const text = body(shown);
  const url = urlOf(text);
  return { title, body: text, url, length: url.length, limit, fits: url.length <= limit, over: Math.max(0, url.length - limit), lines: { shown, of: all } };
}

/** The last `bytes` of a file, or null when it cannot be read. */
function readEnd(file, bytes) {
  let fd = null;
  try {
    const size = statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fd = openSync(file, "r");
    readSync(fd, buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), cut: size > length };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {string} o.logFile
 * @param {() => { version: string, build: string|null, system: { name: string, version: string|null, arch: string|null }, electron?: string|null }} o.about
 * @param {(url: string) => void} o.openExternal  the browser, for a new issue's address of the repository only
 * @param {(png: Buffer) => void} o.copyImage     the clipboard
 * @param {{ save: (kind: string, defaultPath: string, texts?: object) => Promise<string|null> }} o.dialog
 * @param {(file: string) => void} o.show         Show in Finder or Explorer
 * @param {{ downloads: string }} o.folders       where the Save dialog starts
 * @param {{ home?: string|null, user?: string|null, host?: string|null }} [o.person]  what the scrubber takes out
 * @param {(line: string) => void} o.log
 * @param {string} [o.platform]
 * @param {number} [o.urlLimit]  the longest address opened: urlLimitFor(platform)
 * @param {() => number} [o.now]
 */
export function createReportActions({ dataDir, logFile, about, openExternal, copyImage, dialog, show, folders, person = {}, log, platform = process.platform, urlLimit = urlLimitFor(platform), now = Date.now }) {
  const limit = urlLimit;
  let saved = null; // the archive last written: the one Show in Finder may show

  /** A file of the data folder by its real path, never one a link leads out of it to. */
  const ownFile = (relative) => insideRoots(path.join(dataDir, ...relative.split("/")), [dataDir], { platform });

  /** A JSON file of the data folder, or null. */
  function ownJson(relative) {
    const own = ownFile(relative);
    const read = own ? readEnd(own, MAX_FILE_BYTES) : null;
    try {
      return read && !read.cut ? JSON.parse(read.text) : null;
    } catch {
      return null;
    }
  }

  /**
   * The scrubber as the data folder is now: the person's own, the GitHub logins the sign-in's note holds and the log
   * names (a line names a login once; every line of the log is scrubbed of it), and the project folders the lists hold.
   */
  function scrubberNow() {
    const note = ownJson(SIGN_IN_NOTE);
    const logins = [note?.login, note?.previous].filter((one) => typeof one === "string");
    const own = insideRoots(logFile, [dataDir], { platform });
    for (const file of own ? [own, `${own}.1`] : []) {
      const read = readEnd(file, MAX_FILE_BYTES);
      if (read) logins.push(...loginsIn(read.text));
    }
    const projects = [];
    for (const list of PROJECT_LISTS) for (const entry of ownJson(list)?.projects ?? []) if (typeof entry?.path === "string") projects.push(entry.path);
    return createScrubber({ ...person, logins, projects });
  }
  let scrub = scrubberNow();

  /** The bar as the server's lock says it runs: its firmware and API. */
  function barNow() {
    const lock = ownFile("run/server.lock");
    try {
      const record = lock ? JSON.parse(readFileSync(lock, "utf8")) : null;
      return { firmware: typeof record?.firmware === "string" ? record.firmware : null, apiVersion: typeof record?.apiVersion === "string" ? record.apiVersion : null };
    } catch {
      return { firmware: null, apiVersion: null };
    }
  }

  /** The log's newest lines, oldest first, scrubbed and cut: from the log, and the one put aside before it if need be. */
  function newestLines(count) {
    const lines = [];
    const own = insideRoots(logFile, [dataDir], { platform });
    for (const file of own ? [own, `${own}.1`] : []) {
      const read = readEnd(file, 256 * 1024);
      if (!read) continue;
      const these = read.text.split(/\r?\n/).filter((line) => line.trim());
      if (read.cut) these.shift(); // the first line read is a piece of one
      lines.unshift(...these.slice(-(count - lines.length)));
      if (lines.length >= count) break;
    }
    return lines.slice(-count).map((line) => {
      const clean = scrub(line);
      return clean.length > LOG_LINE_CHARS ? `${clean.slice(0, LOG_LINE_CHARS - 1)}…` : clean;
    });
  }

  const issue = (fields, upTo = limit, count = FORM_LOG_LINES, lines = null) => composeIssue({ fields, about: about(), bar: barNow(), lines: fields.log ? (lines ?? newestLines(count)) : [], limit: upTo, scrub });
  // The log's lines the last preview showed: the form opens with them, not with lines the log has had since, so that
  // the browser gets the text the person read.
  let previewed = null;

  const shownPath = (file) => {
    const home = typeof person.home === "string" ? person.home.replace(/[\\/]+$/, "") : null;
    return platform !== "win32" && home && file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
  };

  const methods = {
    /** The issue's text as it would be opened: { title, body, length, limit, fits, over, lines, repository }. */
    async "report.preview"(arg) {
      scrub = scrubberNow();
      previewed = newestLines(FORM_LOG_LINES);
      const made = issue(fieldsOf(arg), limit, FORM_LOG_LINES, previewed);
      return { title: made.title, body: made.body, length: made.length, limit: made.limit, fits: made.fits, over: made.over, lines: made.lines, repository: REPOSITORY };
    },

    /** The form in the browser; the screenshot, when ticked, on the clipboard. */
    async "report.open"(arg) {
      if (!previewed) scrub = scrubberNow();
      const fields = fieldsOf(arg);
      const made = issue(fields, limit, FORM_LOG_LINES, previewed);
      if (!made.fits) throw new ActionFailure("too_long", `The text is ${made.over} characters too long for GitHub's form.`, "Shorten what you wrote; the whole report goes in the diagnostics archive.");
      const png = fields.screenshot ? pngOf(arg?.image) : null;
      if (png) copyImage(png);
      if (!made.url.startsWith(`${NEW_ISSUE}?`)) throw new ActionFailure("internal", "The app could not make the form's address.");
      openExternal(made.url);
      log(`[shell] report: opened the new issue's form in the browser (${made.length} characters, ${made.lines.shown} of ${made.lines.of} log lines${png ? ", the screenshot on the clipboard" : ""})`);
      return { opened: true, url: made.url, screenshot: Boolean(png), lines: made.lines };
    },

    /** The archive, where the person says in the system's Save dialog: { saved: false } when they closed it. */
    async "report.save"(arg) {
      const fields = fieldsOf(arg);
      const png = fields.screenshot ? pngOf(arg?.image) : null;
      const name = `BUSY Bar Emulator diagnostics ${stampOf(now())}.zip`;
      const chosen = await dialog.save("diagnostics", path.join(folders.downloads, name), SAVE_TEXTS);
      if (!chosen) return { saved: false };
      scrub = scrubberNow();
      const file = resolvedPath(chosen.toLowerCase().endsWith(".zip") ? chosen : `${chosen}.zip`, { platform });
      if (!file) throw new ActionFailure("bad_place", "The archive cannot be saved there.", "Choose another folder.");
      const files = [];
      const report = issue(fields, Infinity, 200);
      files.push({ name: "report.md", data: `# ${report.title || "Bug report"}\n\n${report.body}\n` });
      const facts = about();
      files.push({ name: "about.json", data: `${JSON.stringify({ ...facts, bar: barNow(), saved: new Date(now()).toISOString(), scrubbed: "home folders, user and computer names, GitHub logins, folders outside the home folder, tokens, passwords and keys, Wi-Fi names, serials, MAC and e-mail addresses" }, null, 2)}\n` });
      for (const relative of ARCHIVED) {
        const own = ownFile(relative);
        const read = own ? readEnd(own, MAX_FILE_BYTES) : null;
        if (read) files.push({ name: relative, data: scrub(read.text) });
      }
      if (png) files.push({ name: "screenshot.png", data: png });
      const making = `${file}.making-${process.pid}`;
      try {
        writeFileSync(making, makeZip(files, new Date(now())));
        renameSync(making, file);
      } catch (e) {
        rmSync(making, { force: true });
        throw new ActionFailure("not_saved", `The archive was not saved: ${e?.code ?? e?.message ?? e}.`, "Choose another folder.");
      }
      saved = file;
      log(`[shell] report: saved the diagnostics archive (${files.length} files)`);
      return { saved: true, file, shown: shownPath(file), files: files.map((one) => one.name) };
    },

    /** Show in Finder or Explorer: the archive just saved, nothing else. */
    async "report.reveal"() {
      if (!saved) return false;
      try {
        statSync(saved);
      } catch {
        return false;
      }
      show(saved);
      return true;
    },
  };

  return {
    async call(name, arg) {
      if (!Object.hasOwn(methods, name)) return { ok: false, error: { code: "unknown_action", message: "The app has no such action.", hint: null } };
      try {
        return { ok: true, value: await methods[name](arg) };
      } catch (e) {
        if (e instanceof ActionFailure) return { ok: false, error: { code: e.code, message: e.message, hint: e.hint } };
        log(`[shell] report: ${name} failed: ${e?.stack ?? e}`);
        return { ok: false, error: { code: "internal", message: "The app could not do it.", hint: `The log is at ${logFile}.` } };
      }
    },
    scrub: (text) => scrub(text),
  };
}

/** The system as the report names it. */
export function systemOf({ platform = process.platform, version = null, arch = process.arch } = {}) {
  return { name: SYSTEM_NAMES[platform] ?? platform, version, arch };
}
