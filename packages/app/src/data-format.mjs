// The data folder's format, as far as the app's shell needs it (ADR-0013, its section on the data folder; EMU-341). The
// server keeps the format: packages/server/data-folder.mjs reads the record, moves an older folder forward and refuses
// a folder it cannot use. The shell must not write into such a folder either, and it writes first: the log, the
// windows' storage and install.json (which would then name this copy to the command line) come before the server. So
// the shell makes the server's check itself before anything else, and refuses the same folders: one a newer emulator
// moved to a newer format, one whose format record is a link, not a file, unreadable or names no format, and the
// layout from before the record. It says why and quits, having written nothing.
//
// The shell imports nothing from other packages: DATA_FORMAT is the server's FORMAT and dataFolderProblem its
// formatProblem (test/server/data-format.test.mjs holds the two to the same answers).
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const DATA_FORMAT = 2;

/** The exit code of the app that refused a data folder it cannot use. */
export const EXIT_NEWER_DATA_FORMAT = 4;

/** Where a person gets the newest version (the release page GitHub keeps for the latest one). */
export const LATEST_RELEASE_PAGE = "https://github.com/busy-app/busybar-emulator/releases/latest";
/** Where a person reports a bug (report-actions.mjs NEW_ISSUE, the same page). */
export const NEW_ISSUE_PAGE = "https://github.com/busy-app/busybar-emulator/issues/new";

/**
 * Why the shell must not use the data folder `dataDir`, null when it may (a folder of `known` or older, a new one, no
 * folder yet): { kind: "newer", format, known }, { kind: "record", file, why }, { kind: "layout", ext }. Only reads.
 */
export function dataFolderProblem(dataDir, { known = DATA_FORMAT } = {}) {
  // A setting aside a newer emulator began and was stopped in (data-folder.mjs, set-aside/moving.json): the record may
  // be set aside already, and the folder look new.
  const pending = settingAsideTo(dataDir);
  if (pending !== null && pending > known) return { kind: "newer", format: pending, known };
  const file = path.join(dataDir, "format");
  let stat;
  try {
    stat = lstatSync(file);
  } catch (e) {
    if (e?.code !== "ENOENT") return { kind: "record", file, why: `it cannot be read (${e?.code ?? e?.message ?? e})` };
    const ext = path.join(dataDir, "ext");
    try {
      if (lstatSync(ext).isDirectory()) return { kind: "layout", ext };
    } catch {
      // No such folder: a new data folder, or none yet.
    }
    return null;
  }
  if (stat.isSymbolicLink()) return { kind: "record", file, why: "it is a link" };
  if (!stat.isFile()) return { kind: "record", file, why: "it is not a file" };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { kind: "record", file, why: `it cannot be read (${e?.code ?? e?.message ?? e})` };
  }
  const first = text.split(/\r?\n/, 1)[0].trim();
  if (!/^\d{1,9}$/.test(first) || Number(first) < 1) return { kind: "record", file, why: "it does not name a format" };
  const format = Number(first);
  return format > known ? { kind: "newer", format, known } : null;
}

/** The format a setting aside under way is going to (set-aside/moving.json, a file of its own), or null. */
function settingAsideTo(dataDir) {
  const file = path.join(dataDir, "set-aside", "moving.json");
  try {
    if (!lstatSync(file).isFile()) return null;
    const to = JSON.parse(readFileSync(file, "utf8"))?.to;
    return Number.isInteger(to) ? to : null;
  } catch {
    return null;
  }
}

/**
 * An update that moved the folder on and then did not start (update-helper.mjs, "ended_after_move"), from its result in
 * <data>/tmp/update-<version>/: { version, from, format }, or null. Only reads.
 */
export function failedMove(dataDir) {
  const tmp = path.join(dataDir, "tmp");
  if (!existsSync(tmp)) return null;
  try {
    for (const name of readdirSync(tmp)) {
      if (!name.startsWith("update-")) continue;
      const file = path.join(tmp, name, "result.json");
      if (!existsSync(file)) continue;
      const result = JSON.parse(readFileSync(file, "utf8"));
      if (result?.code === "ended_after_move" && typeof result.version === "string") return { version: result.version, from: typeof result.from === "string" ? result.from : null, format: result.format ?? null };
    }
  } catch {
    // Unreadable: said in the plain words below.
  }
  return null;
}

/** What the shell says, in a dialog and on its error output, when it refuses the folder: { title, message }. */
export function refusalWords({ dataDir, problem, version, moved = null }) {
  if (problem.kind === "newer" && moved) {
    return {
      title: `BUSY Bar Emulator ${moved.version} did not start after the update`,
      message:
        `The update to ${moved.version} moved the data folder ${dataDir} to its format ${problem.format} and then ${moved.version} ended before it was up. This version, ${version}, knows format ${problem.known} at most and cannot open the folder; nothing in it was changed. ` +
        `Open BUSY Bar Emulator ${moved.version} again (install it from ${LATEST_RELEASE_PAGE} if it is not in Applications). If it ends again, report a bug with its log, logs/shell.log in the data folder: ${NEW_ISSUE_PAGE}`,
    };
  }
  if (problem.kind === "newer") {
    return {
      title: "A newer BUSY Bar Emulator uses this data folder",
      message:
        `The data folder ${dataDir} is of format ${problem.format}: a newer version of BUSY Bar Emulator moved it there, and this one, ${version}, knows format ${problem.known} at most. ` +
        `Nothing in it was changed, and this version does not start on it. Install the newest version: ${LATEST_RELEASE_PAGE}`,
    };
  }
  const what = problem.kind === "layout" ? `has the layout of an earlier emulator, with the BUSY Bar's storage at its top (${problem.ext})` : `has a format record ${problem.file} that this version cannot use: ${problem.why}`;
  return {
    title: "BUSY Bar Emulator cannot use its data folder",
    message: `The data folder ${dataDir} ${what}. Nothing in it was changed, and this version does not start on it. Put the record right, or move the folder away to start anew.`,
  };
}
