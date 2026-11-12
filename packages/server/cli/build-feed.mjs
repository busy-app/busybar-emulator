// What the desktop app's window prints under its console's Build filter (a project built, installed, started,
// checked from the window's buttons), as `busy-emulator logs --kind build` reads it. Those lines are not the bar's:
// the app runs the command line for them, and its main process writes each line to a file in the data folder, the
// same lines the window shows (packages/app/src/build-feed.mjs writes it; a test checks that both name one file).
// One JSON object a line, { kind: "build", text, time, at }, oldest first; the app empties it when it starts and
// shortens it from the front when it grows long, so a reader that finds it shorter starts again from its top.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

/** The file under the data folder. */
export const BUILD_FEED_PARTS = Object.freeze(["run", "build-lines.jsonl"]);

export function buildFeedFile(ctx) {
  return (ctx.platform === "win32" ? path.win32 : path.posix).join(ctx.dataDir, ...BUILD_FEED_PARTS);
}

/** A line as the file holds it, or null for anything else. */
function parsed(text) {
  try {
    const line = JSON.parse(text);
    return line && typeof line.text === "string" && Number.isFinite(line.time) ? { kind: "build", text: line.text, time: line.time, at: Number.isFinite(line.at) ? line.at : line.time } : null;
  } catch {
    return null;
  }
}

/**
 * The lines from byte `from` on. A file that is not there has none; one shorter than `from` was shortened, and is
 * read from its top (`restarted`). A line not yet ended is left for the next reading.
 * @returns {{ lines: object[], next: number, restarted: boolean }}
 */
export function readBuildFeed(file, from = 0) {
  let fd;
  try {
    fd = openSync(file, "r");
  } catch {
    return { lines: [], next: 0, restarted: from > 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const restarted = size < from;
    const start = restarted ? 0 : from;
    if (size <= start) return { lines: [], next: start, restarted };
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    const end = text.lastIndexOf("\n");
    if (end < 0) return { lines: [], next: start, restarted };
    const lines = text.slice(0, end).split("\n").map(parsed).filter(Boolean);
    return { lines, next: start + Buffer.byteLength(text.slice(0, end + 1)), restarted };
  } finally {
    closeSync(fd);
  }
}
