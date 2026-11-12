// The shell's log: its own events and everything the server prints, one file in the data folder.
//
// The file has a limit while the app runs, not only at its start: past the limit the file is put aside as <file>.1
// (one old file is kept) and a new one is begun, so the two together never hold much more than twice the limit,
// whatever writes to them — a page that is refused thousands of times, or an app on the bar that prints in a loop
// through the server. A line longer than LINE_LIMIT is cut. What the log keeps and for how long is EMU-214.
//
// The file is looked at — its folder made, a file past the limit put aside — at the first line written, not when the
// log is made: a second launch, which makes the log but writes nothing before it ends (the app runs once), must not
// put aside the file the first one is writing.
import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LOG_LIMIT_BYTES = 1024 * 1024;
export const LINE_LIMIT = 4000;

/**
 * @param {string} file
 * @param {object} [o]
 * @param {number} [o.limit]  bytes the file may hold before it is put aside
 */
export function createLog(file, { limit = LOG_LIMIT_BYTES } = {}) {
  let usable = true;
  let opened = false;
  let size = 0;
  function open() {
    opened = true;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      // The same as when the limit is passed while running: a file Windows will not rename (an antivirus or the
      // indexer has it open) is begun anew in its place, rather than leaving the whole run without a log.
      if (size > limit) setAside();
    } catch {
      usable = false;
    }
  }
  function setAside() {
    try {
      renameSync(file, `${file}.1`);
    } catch {
      // Windows refuses to rename a file another program has open; then the file is begun anew in its place.
      writeFileSync(file, "");
    }
    size = 0;
  }
  return (line) => {
    if (!opened) open();
    if (!usable) return;
    let text = String(line);
    if (text.length > LINE_LIMIT) text = `${text.slice(0, LINE_LIMIT)}… (${text.length - LINE_LIMIT} more characters)`;
    text = `${new Date().toISOString()} ${text}\n`;
    const bytes = Buffer.byteLength(text);
    try {
      if (size > 0 && size + bytes > limit) setAside();
      appendFileSync(file, text);
      size += bytes;
    } catch {
      // A log that cannot be written must not take the app down.
      usable = false;
    }
  };
}

/**
 * An address as the log shows it: the scheme, the host and at most `max` characters of the path. The query and the
 * fragment are left out (they may carry what a page wanted to send somewhere), and so are a user name and a password;
 * an address that carries its content (data:, blob:, javascript:) is shown by its scheme and length only.
 */
export function shortAddress(address, max = 200) {
  const text = String(address);
  let url;
  try {
    url = new URL(text);
  } catch {
    return `(not an address, ${text.length} characters)`;
  }
  if (!url.host) return `${url.protocol} (${text.length} characters)`;
  const where = url.pathname.length > max ? `${url.pathname.slice(0, max)}…` : url.pathname;
  return `${url.protocol}//${url.host}${where}${url.search || url.hash ? " (and a query)" : ""}`;
}

export const REFUSALS_PER_MINUTE = 20;

/**
 * What the shell refuses a page, written to the log at most `perMinute` times a minute for each kind of refusal; the
 * rest is counted, and the count is written when the next refusal of that kind comes after the minute. A page can ask
 * for anything any number of times; the log must not become its way to fill the disk or to push the useful lines out.
 * @param {(line: string) => void} log
 * @returns {(kind: string, line: string) => void}
 */
export function createRefusalLog(log, { perMinute = REFUSALS_PER_MINUTE, now = Date.now } = {}) {
  const kinds = new Map();
  return (kind, line) => {
    const time = now();
    let entry = kinds.get(kind);
    if (!entry || time - entry.since >= 60_000) {
      if (entry?.dropped) log(`[shell] ${entry.dropped} more refusals of the kind "${kind}" were not written down`);
      entry = { since: time, written: 0, dropped: 0 };
      kinds.set(kind, entry);
    }
    if (entry.written < perMinute) {
      entry.written += 1;
      log(line);
    } else {
      entry.dropped += 1;
    }
  };
}
