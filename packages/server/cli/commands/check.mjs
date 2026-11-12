// busy-emulator check [<folder>] [--full]: what the BUSY Apps Catalog's checks would say about the project and its built
// package, before it is submitted (../../readiness/check.mjs). Every check of the catalog gets one of three answers:
// it passes, it fails (what the catalog says, what was found here, what to change), or it cannot be checked here (and
// why). It writes one file only, and only when it is not there: catalog.json, the empty form for the four texts the
// catalog asks of the author, so that the check that asks for them names the fields to fill in a file that is there
// (`submit` makes it too; both ways end the same). Otherwise it reads only: the emulator need not run, and nothing of
// the project is run (its scripts are parsed, not started), so the project need not be trusted. Exit code 0 when no
// check fails, 1 when one does (check_failed, with the same list).
//
// With --json the answer is short enough to be read whole: the counts, and only the checks that need something
// (failing, warnings, unchecked: id, title, message, fix; waiting: the ids that wait for those). --full gives every
// check as before. `notes` are the plain lines a result comes down to: the one step left that is the person's (the
// source in a public GitHub repository), a license nobody has chosen.
//
// The checks and the firmware's record are loaded when the command runs, not when the command line starts: the other
// commands need neither.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CliError } from "../output.mjs";
import { commandFor, projectAt } from "../project.mjs";
import { SANDBOX_CODES } from "../system.mjs";

/** The released firmware of this copy of the emulator, or null when its build is not there. */
async function releasedFirmware() {
  try {
    const { loadFirmware } = await import("../../firmware.mjs");
    const firmware = loadFirmware();
    return { name: firmware.name, api: firmware.apiVersion };
  } catch {
    return null;
  }
}

/** Why a file of the project could not be written, as a failure. */
export function blockedWrite(e, file) {
  if (SANDBOX_CODES.has(e?.code)) return new CliError("blocked_file", `This process may not write ${file} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.", { file });
  return new CliError("write_failed", `Could not write ${file}: ${e?.code ?? e?.message ?? e}.`, "Check that the project's folder can be written to.", { file });
}

/**
 * Runs the catalog's checks on the project `folder` names (the caller's folder when not given). `readiness` is the
 * module of the checks, for what the caller makes of the result (reportText, resultData).
 *
 * A project without catalog.json gets the empty form first (`made` names it): the author's texts are the first thing
 * a new project lacks, and the check that asks for them then names the fields to fill. `form: "must"` (submit) fails
 * when the file cannot be written; `form: "try"` (check) goes on without it and the check says the file is missing.
 */
export async function runCheck(ctx, sys, folder, { form = "try" } = {}) {
  const project = projectAt(ctx, sys, folder);
  const readiness = await import("../../readiness/check.mjs");
  const { DETAILS_FILE } = await import("../../readiness/facts.mjs");
  const { detailsTemplate } = await import("../../readiness/submission.mjs");
  let made = null;
  const details = path.join(project.dir, DETAILS_FILE);
  if (!existsSync(details)) {
    try {
      // wx: never over a file of the author's, nor through a link put there in the meantime.
      writeFileSync(details, detailsTemplate(), { flag: "wx" });
      made = details;
    } catch (e) {
      if (form === "must" && e?.code !== "EEXIST") throw blockedWrite(e, details);
    }
  }
  const node = ctx.nodeTools?.node && existsSync(ctx.nodeTools.node) ? ctx.nodeTools.node : null;
  const result = await readiness.checkProject({ dir: project.dir, firmware: await releasedFirmware(), node, env: ctx.env ?? {}, registry: readiness.loadRegistry(), png: await readiness.loadPngChecker() });
  return { project, result, readiness, made };
}

/** "Made <file> for the catalog's texts. Write in it: …", for a person, when the form was made just now. */
export async function formText(made) {
  if (!made) return "";
  const { detailsHelp } = await import("../../readiness/submission.mjs");
  return `Made ${made} for the catalog's texts. Write in it:\n${detailsHelp().map((line) => `  ${line}`).join("\n")}\n\n`;
}

/** The ids of the checks that fail, for a one-line message. */
export const failing = (result) => result.checks.filter((check) => check.status === "fail" && check.blocking).map((check) => check.id);

/** The answer's data: the short form an agent reads whole, or with --full every check. */
export const dataOf = (readiness, result, full) => (full ? { ...readiness.resultData(result), notes: readiness.resultNotes(result), full: true } : readiness.compactData(result));

/** The plain lines a result comes down to (readiness resultNotes), as a block of the text; "" when there are none. */
export const notesText = (readiness, result) => readiness.resultNotes(result).map((note) => `${note}\n`).join("");

export default {
  name: "check",
  summary: "Check the project and its built package against the catalog's rules: each check passes, fails or cannot be checked here (--json names only what needs something; --full every check)",
  usage: "check [<folder>] [--full]",
  maxArguments: 1,
  options: { "--full": { key: "full" } },
  async run(ctx, sys, { args, options, json }) {
    const { project, result, readiness, made } = await runCheck(ctx, sys, args[0]);
    const data = { ...dataOf(readiness, result, options.full === true), made_details: made };
    const report = readiness.reportText(result);
    const form = await formText(made);
    if (result.result === "fail") {
      const ids = failing(result);
      const notes = readiness.resultNotes(result);
      // In JSON the notes have a field of their own; the one that says all is done but the person's step leads.
      const short = `${ids.length} of the catalog's checks ${ids.length === 1 ? "fails" : "fail"} for ${result.id ?? project.dir}: ${ids.join(", ")}.`;
      throw new CliError("check_failed", json ? [`${made ? `Made ${made} for the catalog's texts. ` : ""}${short}`, ...notes.filter((note) => note.startsWith("Everything else passes"))].join(" ") : `${form}${short}\n${notesText(readiness, result)}\n${report}`, `Change what the failing checks name, then run ${commandFor(ctx, project, "check")} again.`, data);
    }
    const next = result.built ? `Next: ${commandFor(ctx, project, "submit")} writes what the catalog's pull request needs.` : `Next: ${commandFor(ctx, project, "build")}, then ${commandFor(ctx, project, "check")} again.`;
    return { data, text: `${report}\n${next}` };
  },
};
