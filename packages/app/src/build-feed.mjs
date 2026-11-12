// The lines of the window's jobs (a build, an install, a start, the checks: what its console shows under Build), kept
// in a file of the data folder for `busy-emulator logs --kind build`, which "Open in Terminal" runs (terminal.mjs).
// The lines are the bar's no more than they are the window's: the command line has no other way to them. The reader
// is packages/server/cli/build-feed.mjs; a test checks that both name the same file.
//
// One JSON object a line, { kind: "build", text, time, at } (Unix ms, the computer's clock), oldest first. The file is
// emptied when the app starts, as the window's console is when it opens; past MAX_LINES it is cut to the latest KEEP.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const BUILD_FEED_PARTS = Object.freeze(["run", "build-lines.jsonl"]);
export const MAX_LINES = 4000;
export const KEEP = 2000;
/** A line longer than this is cut: a tool that prints a whole file on one line fills no disk. */
const MAX_TEXT = 4000;

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {(line: string) => void} o.log
 * @param {() => number} [o.now]
 * @returns {{ file: string, take: (job: object) => void }} take: a job event as the window gets it (actions.mjs)
 */
export function createBuildFeed({ dataDir, log, now = Date.now }) {
  const file = path.join(dataDir, ...BUILD_FEED_PARTS);
  let count = 0;
  let broken = false;
  const failed = (what, e) => {
    if (!broken) log(`[shell] build feed: could not ${what} ${file}: ${e?.message ?? e}`);
    broken = true;
  };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "");
  } catch (e) {
    failed("empty", e);
  }
  function add(text) {
    const time = now();
    try {
      appendFileSync(file, `${JSON.stringify({ kind: "build", text: text.slice(0, MAX_TEXT), time, at: time })}\n`);
      count += 1;
      broken = false;
    } catch (e) {
      return failed("write", e);
    }
    if (count <= MAX_LINES) return;
    try {
      const kept = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-KEEP);
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, `${kept.join("\n")}\n`);
      renameSync(temporary, file);
      count = kept.length;
    } catch (e) {
      failed("shorten", e);
    }
  }
  return {
    file,
    /** The window shows a job's line under Build; the same line goes to the file. */
    take(job) {
      if (!job || typeof job.line !== "string" || !job.folder || job.kind === "removed" || job.kind === "changed") return;
      add(job.line);
    },
  };
}
