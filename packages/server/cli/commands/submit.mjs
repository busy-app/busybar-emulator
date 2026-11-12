// busy-emulator submit [<folder>] [--catalog <owner/repo>] [--full]: everything a pull request to the BUSY Apps Catalog needs,
// written into submission/ of the project (../../readiness/submission.mjs): the catalog's manifest.yml for the app,
// the text of the pull request's description and SUBMIT.md, the steps to open it. It runs `check` first and writes
// only when no check fails and the project is built. The texts the catalog asks of the author (category, short
// description, description, changelog) are the author's: they are read from catalog.json in the project, which this
// command (as `check`) makes, empty, when it is not there, and are never made up. So is the license: a project without
// one is told so, with the licenses the catalog recognizes, and no file is written; which one is the author's
// decision. Nothing is sent, pushed or opened. With --json the checks come in the short form of `check` (--full: every
// check).
import path from "node:path";

import { CliError } from "../output.mjs";
import { commandFor } from "../project.mjs";
import { blockedWrite as blocked, dataOf, failing, formText, notesText, runCheck } from "./check.mjs";

const USAGE = "submit [<folder>] [--catalog <owner/repo>] [--full]";

export default {
  name: "submit",
  summary: "Check the project, then write submission/: the catalog's manifest.yml, the pull request's text and the steps to open it (nothing is sent)",
  usage: USAGE,
  maxArguments: 1,
  options: { "--catalog": { key: "catalog", value: "<owner/repo>" }, "--full": { key: "full" } },
  async run(ctx, sys, { args, options, json }) {
    // Loaded when the command runs: the other commands need none of it.
    const { SUBMISSION_FOLDER } = await import("../../readiness/facts.mjs");
    const { CATALOG_REPOSITORY } = await import("../../readiness/rules.mjs");
    const { foreignFolder, writeSubmission } = await import("../../readiness/submission.mjs");
    const catalog = options.catalog ?? CATALOG_REPOSITORY;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(catalog)) throw new CliError("usage", `--catalog takes a GitHub repository as <owner>/<repo>, not ${JSON.stringify(catalog)}.`, `Usage: busy-emulator ${USAGE}`, { argument: catalog });

    // The form for the author's texts is made by the checks, once, empty: the first thing a new project lacks.
    const { project, result, readiness, made } = await runCheck(ctx, sys, args[0], { form: "must" });
    const { reportText } = readiness;
    const data = { ...dataOf(readiness, result, options.full === true), made_details: made };
    const form = await formText(made);
    if (result.result === "fail") {
      const ids = failing(result);
      const short = `Nothing was written to ${SUBMISSION_FOLDER}/: ${ids.length} of the catalog's checks ${ids.length === 1 ? "fails" : "fail"} for ${result.id ?? project.dir} (${ids.join(", ")}).`;
      const notes = readiness.resultNotes(result);
      throw new CliError("check_failed", json ? [`${made ? `Made ${made} for the catalog's texts. ` : ""}${short}`, ...notes.filter((note) => note.startsWith("Everything else passes"))].join(" ") : `${form}${short}\n${notesText(readiness, result)}\n${reportText(result)}`, `Change what the failing checks name, then run ${commandFor(ctx, project, "submit")} again.`, data);
    }
    if (!result.built) {
      throw new CliError("not_built", `Nothing was written to ${SUBMISSION_FOLDER}/: the project is not built, so the checks of its package did not run.`, `Run ${commandFor(ctx, project, "build")}, then ${commandFor(ctx, project, "submit")} again.`, data);
    }
    const folder = path.join(project.dir, SUBMISSION_FOLDER);
    if (foreignFolder(folder)) {
      throw new CliError("submission_exists", `${folder} is there and was not made by this command; it is left as it is.`, `Move or rename that folder, then run ${commandFor(ctx, project, "submit")} again.`, { ...data, file: folder });
    }
    let written;
    try {
      written = writeSubmission({ facts: result.facts, result, firmware: result.firmware, emulatorVersion: ctx.version ?? null, catalog, date: new Date(sys.now()).toISOString().slice(0, 10) });
    } catch (e) {
      throw blocked(e, folder);
    }
    const open = result.checks.filter((check) => check.status === "unchecked" && check.applies);
    const warnings = result.checks.filter((check) => check.status === "fail" && !check.blocking);
    const git = result.facts.git;
    const text = [
      `Wrote ${written.folder}:`,
      ...written.files.map((file) => `  ${file}`),
      "",
      `${result.counts.pass} of ${result.counts.total} of the catalog's checks pass and none fails${warnings.length ? `; ${warnings.length} warning(s): ${warnings.map((check) => check.id).join(", ")}` : ""}.`,
      `Not checked here (${open.length}): ${open.map((check) => check.id).join(", ")}. SUBMIT.md says what to do about each.`,
      `The manifest names ${git.remote.github.page} at commit ${git.head.slice(0, 12)}: ${git.seenOnRemote ? `that is ${git.seenOnRemote} as this copy last saw it` : "push it"}, and commit everything first (the screenshots, the license and the lock file are read from that commit).`,
      ...(result.package.older_than_source ? ["Files in src/ are newer than the built package: build and check again before you submit."] : []),
      `Nothing was sent. Next: follow ${path.join(written.folder, "SUBMIT.md")}.`,
    ].join("\n");
    return {
      data: { ...data, submission: { folder: written.folder, files: written.files, catalog, origin: git.remote.github.https, commit: git.head, pushed: git.seenOnRemote, to_check_by_hand: open.map((check) => ({ id: check.id, why: check.why, then: check.change })) } },
      text,
    };
  },
};
