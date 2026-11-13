// busy-emulator publish <step> [<folder>] [options]: publishing an app. Stage 1, everything on this computer
// (../../publish/): what the public repository and the catalog's pull request need, made ready in the project; nothing
// is sent. Stage 2 (below): signing in to GitHub, the repository, the push, the pull request, done by the app.
//
//   publish status [<folder>]       where each step stands, and what the device window's flow shows
//   publish check [<folder>]        Pre-flight check: the app built and its types checked (a trusted project), then the
//                                   catalog's checks, grouped for stage 1 (what fails, warnings, stage 2's, unchecked);
//                                   noted with the fingerprint of the files it saw (../../publish/fingerprint.mjs)
//   publish license [<folder>] --license MIT|Apache-2.0|GPL-3.0|other [--author <name>] [--year <n>]
//                                   writes LICENSE with the name and the year; "other": you add your own. Never chosen
//                                   for you, and a license file that is there is kept.
//   publish license [<folder>] --license other --from <file> [--replace]
//                                   copies your own license's text in as LICENSE, from a file inside the project
//                                   (the window's Upload takes one from anywhere: the person chooses it); a license
//                                   file that is there is kept unless --replace (it goes to .busy/removed)
//   publish files [<folder>] [--write] [--keep-out <path>] [--keep-in <path>] [--readme replace]
//                                   what the repository will hold, and what looks like a secret in it; --write adds the
//                                   missing lines to .gitignore and makes README.md from catalog.json (a README of
//                                   your own is kept unless --readme replace)
//   publish screenshots [<folder>] [--take front|back] [--upload <files>] [--display front|back] [--order <json>]
//                       [--remove <path>]
//                                   --upload: PNGs made before (a JSON list, or paths joined as in PATH), each 72×16 or
//                                   160×80 or an exact enlargement of one; copied in as front-<n>.png or back-<n>.png;
//                                   --display takes only that display's
//   publish readme [get|set|preview] [<folder>] [--mode fields|markdown] [--title <text>] [--intro <text>]
//                                   [--controls <json>] [--usage <text>] [--markdown <text>]
//                                   the public repository's README: made from the catalog texts, the screenshots, the
//                                   settings and the license, with How to use written by you (or your own Markdown);
//                                   set writes README.md, preview only shows it; the template's text is never kept.
//                                   --controls: How to use's rows, one per control of the BUSY Bar (Start, Wheel turn,
//                                   Wheel press, Back) with a sentence (../../publish/how-to-use.mjs); with it --usage is
//                                   the sentence after the rows
//   publish package [<folder>]      the catalog's checks, then submission/ (the manifest; its repository and commit
//                                   are filled in stage 2); the project must be built
//   publish prepare [<folder>] --license <id> [--author <name>]
//                                   license, files, build and package in one go, for an agent or a terminal
//
// Stage 2 is done by the emulator's app through GitHub CLI inside it, which holds the person's GitHub token
// (packages/app/src/github/): the command line asks the app through the server (POST /_emu/github) and prints what
// it says. The app must be running.
//   publish signin --use-existing [--user <login>]
//                                   one of the accounts GitHub CLI on this computer has (its active one unless
//                                   --user names another), as it is; the person agrees in the app's dialog
//   publish signin [--new-account]  a code to enter on github.com/login/device; waits until the person has; the
//                                   account is added to GitHub CLI on this computer, which goes on using its own.
//                                   --no-wait: the code at once, the app goes on waiting; publish signin again waits
//   publish signout                 forgets the sign-in in the app; GitHub CLI's accounts are left as they are
//   publish push [<folder>] [--name <repository>]
//                                   the project's files in the person's public repository, one commit, read back;
//                                   the person confirms in the app's dialog first
//   publish pr [<folder>] --ai none|partly|full [--catalog <owner/name or address>]
//                                   the pull request to the catalog; the person confirms in the app's dialog and ticks
//                                   there the catalog's author checklist, and the optional items they choose (the
//                                   contest's); the answer's `optional` says which optional items the request ticks
// And what the app did is noted here, so that the record and the manifest are written by the same code as stage 1's.
// These only write the project's own files; what the app may replace or send is decided by its own record
// (packages/app/src/github/publish-record.mjs), so a project that arrives with such a note, or a note written by hand,
// changes nothing there:
//   publish pushed [<folder>] --owner <login> --repo <name> --commit <sha>
//                                   the project is in github.com/<login>/<name> at <sha>: noted, and the manifest of
//                                   submission/ names them
//   publish requested [<folder>] --pr <url> --catalog <owner/name>
//                                   the pull request to the catalog is open: noted
//   publish verify [<folder>]       whether the check and the package still hold for the project as it is, with the
//                                   hash of every file the check saw: the app asks it right before it uploads or sends
//
// stale-check: Pre-flight check and Build and package record a fingerprint of the files that get published or
// built; publish status says whether each still holds (`stale`, `changed`), and push and pr (here, in the app and
// through MCP) refuse when a file changed since: GitHub gets only what was checked and packaged.
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { insideRoots } from "../../path-boundary.mjs";
import { CliError } from "../output.mjs";
import { commandFor, projectAt } from "../project.mjs";
import { compileProject } from "../preflight.mjs";
import { SANDBOX_CODES } from "../system.mjs";
import { runCheck } from "./check.mjs";
import { textsAnswer } from "./catalog-texts.mjs";

const STEPS = ["status", "check", "license", "files", "screenshots", "readme", "package", "prepare", "signin", "signout", "push", "pr", "pushed", "requested", "verify"];
/**
 * What the app runs after it has published (it alone decides what it may replace or send: its own record, not the
 * project's .busy/publish.json): not listed for people.
 */
const APP_ONLY = new Set(["pushed", "requested", "verify"]);
/** The steps of stage 2 the emulator's app does, which hold no project or not one of the folder given. */
const NO_PROJECT = new Set(["signin", "signout"]);
const AI = ["none", "partly", "full"];
const USAGE = "publish status|check|license|files|screenshots|readme|package|prepare|signin|signout|push|pr [<folder>] [--name <repository>] [--catalog <owner/name>] [--ai none|partly|full] [--use-existing|--new-account] [--user <login>] [--no-wait] [--license <id>] [--author <name>] [--year <n>] [--from <file>] [--replace] [--write] [--keep-out <path>] [--keep-in <path>] [--readme replace] [--take front|back] [--upload <files>] [--display front|back] [--order <json>] [--remove <path>] [--mode fields|markdown] [--title <text>] [--intro <text>] [--controls <json>] [--usage <text>] [--markdown <text>]";
const usage = (message) => new CliError("usage", message, `Usage: busy-emulator ${USAGE}`);
/**
 * How to use's rows from --controls: a JSON list of { control, text } or an object { "<control>": "<text>" }, the
 * controls by the catalog's names or the other names how-to-use.mjs knows, in the catalog's order; checked as the
 * README step checks them (how-to-use.mjs problem()).
 */
function controlRows(value, howToUse) {
  const names = howToUse.CONTROLS.join(", ");
  let given;
  try {
    given = JSON.parse(value);
  } catch {
    throw usage(`--controls takes JSON: [{"control": "Start", "text": "Starts the timer"}, …] or {"Start": "Starts the timer", …}; the controls are ${names}.`);
  }
  const pairs = Array.isArray(given) ? given.map((one) => [one?.control, one?.text]) : given && typeof given === "object" ? Object.entries(given) : null;
  if (!pairs || !pairs.length) throw usage(`--controls needs at least one control: ${names}.`);
  const rows = [];
  for (const [name, text] of pairs) {
    const control = howToUse.controlOf(String(name ?? "").replace(/[_-]+/g, " "));
    if (!control) throw usage(`${JSON.stringify(name)} is not one of the BUSY Bar's controls: ${names}.`);
    if (rows.some((one) => one.control === control)) throw usage(`--controls: ${control} is given more than once.`);
    if (typeof text !== "string" || /[\r\n]/.test(text)) throw usage(`--controls: ${control} takes one line of text, what it does in the app.`);
    rows.push({ control, text: text.trim() });
  }
  rows.sort((a, b) => howToUse.CONTROLS.indexOf(a.control) - howToUse.CONTROLS.indexOf(b.control));
  const problem = howToUse.problem(rows);
  if (problem) throw usage(`${problem}.`);
  return rows;
}

/** What `help publish` shows below the usage: every step, in the order of the window's Publish dialog. */
const DETAILS = [
  "Stage 1, on this computer (nothing is sent):",
  "  publish status [<folder>]          where every step stands (texts, screenshots, readme, license, files, package, GitHub, catalog)",
  "  catalog-texts set …                the Application Info step: name, category, short description, description, changelog (a command of its own)",
  "  icon --text AB | --from <png>      the app's icons (a command of its own)",
  "  publish screenshots [<folder>] --take front|back      a screenshot of what a display shows now",
  "  publish screenshots [<folder>] --upload <files> [--display front|back]   PNGs made before: 72×16 front, 160×80 back, or exact enlargements; a JSON list or paths joined as in PATH",
  "  publish screenshots [<folder>] --order <json> | --remove <path>   the order (the first front one is the cover), or one less",
  "  publish readme get|preview|set [<folder>] [--controls <json>] [--usage <text>] [--title <text>] [--intro <text>]",
  "                                     the public repository's README. --controls: How to use's rows, one per control of the BUSY Bar with a sentence:",
  `                                     '{"Start": "Starts or pauses", "Wheel turn": "Sets the minutes", "Wheel press": "Resets", "Back": "Exits"}'`,
  "                                     (controls: Start, Wheel turn, Wheel press, Back); --usage is the sentence after them. --mode markdown --markdown <text>: your own README",
  "  publish license [<folder>] --license MIT|Apache-2.0|GPL-3.0 [--author <name>] [--year <n>]   the person's choice, never made for them",
  "  publish license [<folder>] --license other --from <file> [--replace]   the person's own license file, copied in as LICENSE",
  "  publish files [<folder>] [--write] [--keep-out <path>] [--keep-in <path>]   what the public repository will hold; --write adds .gitignore lines",
  "  publish check [<folder>]           builds the app and checks its types, then the catalog's checks, grouped (fails, stage 2's, unchecked)",
  "  publish package [<folder>]         the checks, then submission/ (the manifest); needs a build",
  "  publish prepare [<folder>] --license <id> [--from <file>]   license, files, build and package in one go",
  "Stage 2, done by the emulator's app (it must run; the person confirms each step in its window):",
  "  publish signin                     choose_account: GitHub CLI has accounts; ask the person which one:",
  "  publish signin --use-existing [--user <login>]          one of GitHub CLI's accounts (the person agrees in the app's dialog)",
  "  publish signin --new-account [--no-wait]                a code for github.com/login/device; --no-wait answers with it at once, publish signin again waits",
  "  publish push [<folder>] [--name <repository>]           the project's files to the person's public repository (the person confirms); refused when a file changed since publish check or publish package",
  "  publish pr [<folder>] --ai none|partly|full [--catalog <owner/name>]   the pull request to busy-app/busy-apps-catalog; the person confirms and ticks the author checklist in the app, and the optional items (the contest's) they choose; the answer's optional says which are ticked (--catalog is for development and tests; a catalog that is not BUSY's needs a second confirmation)",
  "  publish signout                    forgets the sign-in in the emulator; GitHub CLI's accounts stay",
  "Only the person: choose the license, the AI usage and the GitHub account, sign in, confirm push and pull request, tick the author checklist and its optional items. Ask them; never pick for them.",
];

const lib = () => import("../../publish/files.mjs");

/** The app's name and version, from its manifest (src/appmeta/manifest.json), as the bar and the catalog show it. */
async function appOf(dir) {
  const { gatherFacts } = await import("../../readiness/facts.mjs");
  const json = gatherFacts(dir).manifest.json;
  return { name: typeof json?.name === "string" ? json.name : null, version: typeof json?.version === "string" ? json.version : null };
}

function writeError(e, file) {
  if (e instanceof CliError) return e;
  if (e?.code === "outside_project") return new CliError("outside_project", `${e.message}.`, "Put a folder or file of the project's own in place of the link, then run the command again.", { file: e.file ?? file });
  if (SANDBOX_CODES.has(e?.code)) return new CliError("blocked_file", `This process may not write ${file} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.", { file });
  return new CliError("write_failed", `Could not write ${file}: ${e?.code ?? e?.message ?? e}.`, "Check that the project's folder can be written to.", { file });
}

/** A path inside the project as the window and the lists name it: relative, forward slashes, no "..". */
function relativePath(value, what) {
  if (typeof value !== "string" || !value || value.length > 500 || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.split("/").some((part) => part === ".." || part === "." || part === "")) throw usage(`${what} takes a path inside the project, such as screenshots/front-1.png, not ${JSON.stringify(String(value).slice(0, 80))}.`);
  return value;
}

/** The screenshots of the project, each with its picture and what the catalog says of it. */
async function screenshotsAnswer(dir, { pictures = true } = {}) {
  const { screenshotList, screenshotData, projectFile, MAX_CHECKED_SCREENSHOT } = await lib();
  const { loadPngChecker } = await import("../../readiness/check.mjs");
  const png = await loadPngChecker();
  const { front, back, listed } = screenshotList(dir);
  // catalog.json may name any path: each is read only inside the project, a file, and not too large (projectFile).
  const shown = (display) => (one) => {
    const read = projectFile(dir, one.path, MAX_CHECKED_SCREENSHOT);
    if (!read.bytes) return { ...one, data: null, problem: read.problem };
    let problem = null;
    try {
      const verdict = png ? png.check(read.bytes, display) : null;
      if (verdict?.verdict === "fail") problem = verdict.message;
    } catch {
      problem = "The file is not a picture the catalog takes.";
    }
    // A model over MCP reads the files' paths, not the pictures in the answer (the screenshot tool shows them).
    return { ...one, ...(pictures ? { data: screenshotData(dir, one.path) } : {}), problem };
  };
  const all = { front: front.map(shown("front")), back: back.map(shown("back")) };
  const problems = [];
  if (!all.front.length) problems.push("No front screenshot yet: the catalog needs 1 to 10, the first is the cover.");
  if (all.front.length > 10) problems.push(`${all.front.length} front screenshots: the catalog takes at most 10.`);
  if (all.back.length > 10) problems.push(`${all.back.length} back screenshots: the catalog takes at most 10.`);
  for (const one of [...all.front, ...all.back]) if (one.problem) problems.push(`${one.path}: ${one.problem}`);
  return { ...all, listed, problems, ready: problems.length === 0 };
}

async function licenseAnswer(dir, home) {
  const { LICENSES, authorGuess, licenseFiles, readProgress } = await lib();
  const files = licenseFiles(dir);
  const choice = readProgress(dir).steps?.license?.choice ?? null;
  return { files, choice, choices: LICENSES, author: authorGuess(dir, home), year: new Date().getFullYear(), ready: files.length > 0 };
}

/**
 * The files that look like a secret or personal data and would be published, but for those the person kept in on
 * purpose (--keep-in, noted in the flow's record): they start kept out, and the next --write puts them in .gitignore.
 */
async function flaggedOut(dir) {
  const { filesPlan, readProgress } = await lib();
  const { scanProject } = await import("../../publish/secrets.mjs");
  const keptIn = new Set(readProgress(dir).steps?.files?.kept_in ?? []);
  return [...new Set(scanProject(dir, filesPlan(dir)).filter((one) => one.published && !keptIn.has(one.path)).map((one) => one.path))];
}

async function filesAnswer(dir, more = []) {
  const { filesPlan, readmeState, reasonOf } = await lib();
  const { scanProject } = await import("../../publish/secrets.mjs");
  // What is found is read from the files as git would publish them now; a flagged file is then shown kept out.
  const found = scanProject(dir, filesPlan(dir, more));
  const flagged = new Set(await flaggedOut(dir));
  const plan = filesPlan(dir, [...more, ...flagged]);
  // Published on purpose: the person's own click, so it does not hold the step back.
  const keptIn = new Set((await lib()).readProgress(dir).steps?.files?.kept_in ?? []);
  const findings = found.map((one) => (flagged.has(one.path) ? { ...one, published: false, by_default: true } : one.published && keptIn.has(one.path) ? { ...one, kept_in: true } : one));
  const readme = readmeState(dir);
  return {
    published: plan.published.map((rel) => ({ path: rel, why: reasonOf(rel) })),
    left: plan.left,
    cut: plan.cut,
    ignore_missing: plan.lines,
    readme,
    findings,
    ready: plan.lines.length === 0 && (readme === "ours" || readme === "yours") && !findings.some((one) => one.published && !one.kept_in),
  };
}

/**
 * The README step: what it is made from, the configuration (saved, or the default; a README of the person's own opens
 * as its Markdown), the Markdown it makes, what holds it back, and the README.md there now.
 */
async function readmeAnswer(dir, project, given = null) {
  const { readmeFacts, readmeFile, readmeState, readProgress } = await lib();
  const { readmeConfig, readmeMarkdown, readmeProblem, templateLeft } = await import("../../publish/readme.mjs");
  const howToUse = await import("../../publish/how-to-use.mjs");
  const { texts } = await textsAnswer(dir);
  const facts = readmeFacts(dir, { name: (await appOf(dir)).name ?? project.id, id: project.id, texts });
  const progress = readProgress(dir);
  const state = readmeState(dir, progress);
  const file = readmeFile(dir);
  const saved = progress.steps?.readme?.config ?? null;
  const start = saved ?? (state === "yours" ? { mode: "markdown", markdown: file } : null);
  const config = readmeConfig(given ? { ...readmeConfig(start, facts), ...given } : start, facts);
  const left = templateLeft(file ?? "");
  // How to use: the README.md there must have its section, at least one control and its sentence (how-to-use.mjs).
  const usage = howToUse.problem(howToUse.read(file ?? ""));
  // The rows as the README made from this configuration holds them (publish readme --controls writes them).
  const markdown = readmeMarkdown(config, facts);
  const controls = howToUse.read(markdown).filter((row) => row.control);
  return { state, saved: saved !== null, config, controls, control_names: howToUse.CONTROLS, facts, markdown, problem: readmeProblem(config, facts), how_to_use: usage, left, ready: (state === "ours" || state === "yours") && left.length === 0 && usage === null };
}

/** The app's two icons as they are in the project, as data: addresses (null for one that is not there or too large). */
async function iconsAnswer(dir) {
  const { readFileSync } = await import("node:fs");
  const folder = [path.join(dir, "src", "appmeta"), path.join(dir, "appmeta")].find((one) => existsSync(path.join(one, "manifest.json")));
  const one = (name) => {
    try {
      const bytes = readFileSync(path.join(folder, name));
      return bytes.length <= 64 * 1024 && bytes.subarray(1, 4).toString("latin1") === "PNG" ? `data:image/png;base64,${bytes.toString("base64")}` : null;
    } catch {
      return null;
    }
  };
  return folder ? { front: one("icon_front_8x8.png"), back: one("icon_back_11x11.png") } : { front: null, back: null };
}

async function packageAnswer(dir, id, fresh) {
  const { readProgress } = await lib();
  const file = id ? path.join(dir, "dist", `${id}.tgz`) : null;
  const built = file && existsSync(file) ? { file, bytes: statSync(file).size } : null;
  const done = readProgress(dir).steps?.package ?? null;
  const folder = path.join(dir, "submission");
  const submission = done && existsSync(folder) ? folder : null;
  // stale-check: a file of the project or of submission/ changed since the package was made.
  const state = submission && fresh.package ? fresh.package : null;
  return { built, submission, at: done?.at ?? null, filled: done?.filled ?? false, stale: state?.stale ?? false, changed: state?.changed ?? [], more: state?.more ?? 0 };
}

// ---------------------------------------------------------------- stale-check: what the check and the package saw

/**
 * Whether Pre-flight check and Build and package still hold for the project as it is now (../../publish/
 * fingerprint.mjs): { check, package } each { stale, changed, more, unknown } or null when the step was not done.
 */
async function freshness(dir) {
  const { readProgress } = await lib();
  const { compare, fingerprint } = await import("../../publish/fingerprint.mjs");
  const done = readProgress(dir).steps ?? {};
  return {
    check: done.check ? compare(done.check.fingerprint, fingerprint(dir)) : null,
    package: done.package ? compare(done.package.fingerprint, fingerprint(dir, { scope: "package" })) : null,
  };
}

/**
 * After the flow's own write of `rels` (stale-check): the check's and the package's records follow it, each only when
 * it held before the write, so that nothing else that changed meanwhile is taken for checked.
 */
async function renewAfter(sys, dir, rels) {
  const { noteStep, readProgress } = await lib();
  const { fingerprint, renewed } = await import("../../publish/fingerprint.mjs");
  const done = readProgress(dir).steps ?? {};
  for (const [step, scope] of [["check", "check"], ["package", "package"]]) {
    const record = done[step];
    if (!record?.fingerprint) continue;
    const now = renewed(record.fingerprint, fingerprint(dir, { scope }), rels);
    if (!now || now.hash === record.fingerprint.hash) continue;
    const { at: _at, ...rest } = record;
    noteStep(dir, step, { ...rest, fingerprint: now }, sys.now());
  }
}

/** The check's record as an answer shows it: without the fingerprint's list of files, with whether it still holds. */
function checkShown(record, state) {
  if (!record) return null;
  const { fingerprint: _fingerprint, ...rest } = record;
  return { ...rest, stale: state?.stale ?? true, changed: state?.changed ?? [], more: state?.more ?? 0, ...(state?.unknown ? { unknown: true } : {}) };
}

/**
 * What a push or a request needs of stage 1 (stale-check): Pre-flight check passed, with the build and the types, and
 * the package made, both on the project as it is now. Throws what is not so; answers { files }: the hash of every
 * file the check saw, which the app compares with the bytes it uploads.
 */
async function requireChecked(ctx, project) {
  const { readProgress } = await lib();
  const { changedWords } = await import("../../publish/fingerprint.mjs");
  const dir = project.dir;
  const done = readProgress(dir).steps ?? {};
  const fresh = await freshness(dir);
  const again = `Run ${commandFor(ctx, project, "publish check")} and ${commandFor(ctx, project, "publish package")} again (in the window: Pre-flight check, then Build and package), then publish.`;
  if (!done.check || done.check.passed !== true || done.check.compiled !== true) {
    throw new CliError("not_checked", "The project has not passed Pre-flight check, with its build and its types, so nothing is sent.", again);
  }
  if (fresh.check.stale) throw new CliError("changed_since_check", `The project changed since Pre-flight check (${changedWords(fresh.check)}), so nothing is sent: GitHub gets only what was checked.`, again, { changed: fresh.check.changed });
  if (!done.package || !existsSync(path.join(dir, "submission"))) throw new CliError("not_packaged", "The project is not packaged yet, so nothing is sent.", `Run ${commandFor(ctx, project, "publish package")} (in the window: Build and package), then publish.`);
  if (fresh.package.stale) throw new CliError("changed_since_package", `The project changed since it was packaged (${changedWords(fresh.package)}), so nothing is sent.`, again, { changed: fresh.package.changed });
  return { checked: true, files: done.check.fingerprint.files ?? null, at: done.check.at };
}

async function byHand(dir, catalog) {
  const { gatherFacts } = await import("../../readiness/facts.mjs");
  const { byHandSteps } = await import("../../readiness/submission.mjs");
  return byHandSteps({ facts: gatherFacts(dir), catalog });
}

/** Where every step stands. */
async function status(ctx, project) {
  const { readProgress } = await lib();
  const { CATALOG_REPOSITORY } = await import("../../readiness/rules.mjs");
  const dir = project.dir;
  const progress = readProgress(dir);
  const texts = await textsAnswer(dir);
  const screenshots = await screenshotsAnswer(dir, { pictures: !ctx.mcp });
  const license = await licenseAnswer(dir, ctx.homeDir);
  const files = await filesAnswer(dir);
  const readme = await readmeAnswer(dir, project);
  const fresh = await freshness(dir);
  const pkg = await packageAnswer(dir, project.id, fresh);
  // stale-check: the check holds only for the project it saw.
  const check = checkShown(progress.steps?.check ?? null, fresh.check);
  const app = await appOf(dir);
  return {
    folder: dir,
    id: project.id,
    name: app.name ?? project.id,
    version: app.version,
    icon: await iconsAnswer(dir),
    steps: {
      check: check?.passed && !check.stale ? "done" : "todo",
      texts: texts.taken ? "done" : "todo",
      screenshots: screenshots.ready ? "done" : "todo",
      readme: readme.ready ? "done" : "todo",
      license: license.ready ? "done" : "todo",
      files: files.ready ? "done" : "todo",
      package: pkg.submission && !pkg.stale ? "done" : "todo",
    },
    check,
    texts,
    screenshots,
    readme,
    license,
    files,
    package: pkg,
    catalog: CATALOG_REPOSITORY,
    github: { repo: progress.steps?.push ?? null, request: progress.steps?.request ?? null },
    by_hand: await byHand(dir, CATALOG_REPOSITORY),
  };
}

/** Seconds a sign-in waits for the person's code: GitHub's codes live 15 minutes. */
const SIGNIN_WAIT_MS = 16 * 60_000;
const APP_WAIT_MS = 11 * 60_000;

/** Asks the emulator's app to do a step of stage 2: its answer, or a CliError for why it could not be asked. */
async function askApp(ctx, sys, query, waitMs = APP_WAIT_MS) {
  const { blockedNetwork, commandLine, emulatorStatus, ready } = await import("../lifecycle.mjs");
  const self = commandLine(ctx);
  const status = await emulatorStatus(ctx, sys);
  if (!ready(status)) throw new CliError("not_running", "The emulator is not running: its app is what publishes to GitHub.", `Start it with ${self} start, then run this again.`);
  const control = sys.readControl(ctx.dataDir);
  if (control.blocked) throw new CliError("blocked_file", `This process may not read the emulator's data folder ${ctx.dataDir} (${control.blocked}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
  const unavailable = (why) => new CliError("github_unavailable", `The emulator's app could not be asked to publish: ${why}.`, `Start the BUSY Bar Emulator app (${self} start), then run this again.`);
  if (control.missing) throw unavailable(`its management address cannot be read (${control.missing})`);
  const answer = await sys.askGithub(control.port, control.key, query, waitMs);
  if (answer.blocked) throw blockedNetwork(control.port, answer.blocked);
  if (answer.failed) throw unavailable(`127.0.0.1:${control.port} did not answer (${answer.failed})`);
  let body = null;
  try {
    body = JSON.parse(answer.body);
  } catch {
    // below
  }
  if (answer.status !== 200 || !body) throw unavailable(typeof body?.error === "string" ? body.error.replace(/\.$/, "") : `it answered HTTP ${answer.status}`);
  if (body.ok === false) throw new CliError(body.code ?? "failed", body.message ?? "It failed.", body.hint ?? null);
  return body;
}

/** How often a push or a request asks the app how far it is. */
const PROGRESS_POLL_MS = 1000;

/** One line for an upload's numbers (github-api.mjs pushFiles onProgress, as the app passes them on). */
export function uploadLine(upload) {
  if (!upload) return null;
  const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
  if (upload.phase === "compare") return "Comparing the files with GitHub";
  if (upload.phase === "commit") return "Making the commit";
  if (upload.phase === "check") return "Reading the files back from GitHub";
  const known = upload.known ? `, ${upload.known} GitHub has already` : "";
  return `Uploading ${upload.done} of ${upload.total} files (${mb(upload.bytes)} of ${mb(upload.totalBytes)})${known}${upload.file ? `: ${upload.file}` : ""}`;
}

/**
 * Waits for `asked` (a push or a request the app does) and meanwhile says, as progress lines, what the app's job says
 * (its lines and the upload's numbers, through status with the folder). The answer is `asked`'s.
 */
async function withProgress(ctx, sys, dir, progress, asked) {
  let done = false;
  const ended = asked.finally(() => (done = true));
  let last = null;
  const said = new Set();
  const look = async () => {
    while (!done) {
      await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
      if (done) break;
      let now;
      try {
        now = (await askApp(ctx, sys, { op: "status", folder: dir }, 10_000)).progress;
      } catch {
        continue;
      }
      if (!now || now.state !== "running") continue;
      const line = uploadLine(now.upload) ?? now.line;
      if (now.line && !said.has(now.line)) {
        said.add(now.line);
        if (now.line !== line) progress(now.line);
      }
      if (line && line !== last) progress((last = line));
    }
  };
  look().catch(() => {});
  return ended;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Stage 2 pushed the project: the record notes the repository, and submission/'s manifest names it. */
async function pushed(ctx, sys, project, options) {
  const { noteStep, writable } = await lib();
  if (!LOGIN.test(options.owner ?? "") || !REPO_NAME.test(options.repo ?? "") || /^\.+$/.test(options.repo) || !/^[0-9a-f]{40}$/.test(options.commit ?? "")) throw usage("publish pushed takes --owner <login> --repo <name> --commit <40 hexadecimal digits>.");
  const origin = `https://github.com/${options.owner}/${options.repo}.git`;
  const page = `https://github.com/${options.owner}/${options.repo}`;
  const { readFileSync, writeFileSync } = await import("node:fs");
  const manifestFile = project.id ? writable(project.dir, `submission/applications/${project.id}/manifest.yml`) : null;
  let manifest = null;
  try {
    noteStep(project.dir, "push", { owner: options.owner, name: options.repo, origin, page, commit: options.commit }, sys.now());
    if (manifestFile && existsSync(manifestFile)) {
      const { PENDING } = await import("../../readiness/submission.mjs");
      const text = readFileSync(manifestFile, "utf8");
      // The lines stage 1 left for the repository: the mark, origin and commit_sha under location.
      const lines = text.split("\n");
      const at = lines.findIndex((line) => line.trim() === PENDING.trim());
      const filled = [];
      for (const line of lines) {
        if (line.trim() === PENDING.trim()) continue;
        if (at >= 0 && /^ {4}origin: /.test(line)) filled.push(`    origin: ${origin}`);
        else if (at >= 0 && /^ {4}commit_sha: /.test(line)) filled.push(`    commit_sha: ${options.commit}`);
        else if (at < 0 && /^ {4}origin: /.test(line)) filled.push(`    origin: ${origin}`);
        else if (at < 0 && /^ {4}commit_sha: /.test(line)) filled.push(`    commit_sha: ${options.commit}`);
        else filled.push(line);
      }
      manifest = filled.join("\n");
      writeFileSync(manifestFile, manifest);
      // The flow's own change of submission/ (stale-check): the package still holds after it when it held before.
      await renewAfter(sys, project.dir, [`submission/applications/${project.id}/manifest.yml`]);
    }
  } catch (e) {
    throw writeError(e, project.dir);
  }
  return { owner: options.owner, repo: options.repo, origin, page, commit: options.commit, manifest, manifest_file: manifest === null ? null : manifestFile };
}

/** Stage 2 opened the pull request to the catalog: noted. */
async function requested(ctx, sys, project, options) {
  const { noteStep } = await lib();
  if (!/^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/.test(options.pr ?? "") || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(options.catalog ?? "")) throw usage("publish requested takes --pr <https://github.com/…/pull/N> --catalog <owner/name>.");
  try {
    noteStep(project.dir, "request", { url: options.pr, catalog: options.catalog }, sys.now());
  } catch (e) {
    throw writeError(e, project.dir);
  }
  return { url: options.pr, catalog: options.catalog };
}

/**
 * Pre-flight check: the app built and its types checked (../preflight.mjs), then the catalog's checks, grouped for
 * stage 1 (../../publish/stage.mjs), and noted in the record with the fingerprint of the files it saw (stale-check).
 * The build's and the types' failures come first among the fails. `skipBuild`: the build ran just before.
 */
async function preflight(ctx, sys, project, { commands, progress, skipBuild = false } = {}) {
  const { fingerprint, settled } = await import("../../publish/fingerprint.mjs");
  const before = fingerprint(project.dir);
  const compiled = await compileProject(ctx, sys, project, { commands, progress, skipBuild });
  const { result } = await runCheck(ctx, sys, project.dir);
  const { stageOne } = await import("../../publish/stage.mjs");
  const grouped = stageOne(result);
  grouped.fails = [...compiled.fails, ...grouped.fails];
  grouped.ok = grouped.fails.length === 0;
  // What the check saw: the files as they were after it, unless they changed while it ran (then it is stale at once).
  const seen = settled(before, fingerprint(project.dir));
  try {
    (await lib()).noteStep(project.dir, "check", { passed: grouped.ok && grouped.built, fails: grouped.fails.length, built: grouped.built, compiled: compiled.built, typed: compiled.typed, fingerprint: seen }, sys.now());
  } catch {
    // The record is the flow's convenience.
  }
  return { result, grouped, compiled };
}

async function check(ctx, sys, project, options = {}) {
  const { grouped, compiled } = await preflight(ctx, sys, project, options);
  // `passed`, not `ok`: the answer's own ok says that the command worked.
  const { ok, ...rest } = grouped;
  return { passed: ok, ...rest, compiled: compiled.built, typed: compiled.typed };
}

/**
 * The file a license of the person's own is copied from (--from): one inside the project's folder, or one the
 * emulator's app put down for it in the data folder's tmp/ (the file the person chose in its Upload dialog), by its
 * real path (path-boundary.mjs). Never another file of this computer: it goes into the public repository as LICENSE,
 * and the push's confirmation does not show its text, so a caller that may run only this command line (an agent with
 * a rule for busy-emulator) could otherwise publish any text file of the person's.
 */
function licenseSource(ctx, sys, project, given) {
  const full = path.resolve(sys.cwd(), given);
  const real = insideRoots(full, [project.dir, path.join(ctx.dataDir, "tmp")], { rootItself: false, platform: ctx.platform });
  if (real === null) throw new CliError("outside_project", `${full} is not inside the project's folder: a license file is published as the project's LICENSE, so it is taken only from the project.`, `Copy the license file into ${project.dir} first, then run this again with --from <its path>; or choose it in the emulator's window (License, Upload).`, { file: full });
  return real;
}

async function license(ctx, sys, project, options) {
  const { LICENSES, holderProblem, noteStep, writeLicense } = await lib();
  const choice = options.license;
  if (typeof choice !== "string") throw usage(`publish license needs --license: ${[...LICENSES.map((one) => one.id), "other"].join(", ")}. It is never chosen for you.`);
  if (choice !== "other" && !LICENSES.some((one) => one.id === choice)) throw usage(`--license takes ${[...LICENSES.map((one) => one.id), "other"].join(", ")}, not ${JSON.stringify(choice)}.`);
  const dir = project.dir;
  if (options.from !== undefined || options.replace !== undefined) {
    if (choice !== "other") throw usage("--from and --replace go with --license other: your own license's file.");
    if (typeof options.from !== "string" || !options.from) throw usage("--from takes the file of your license's text.");
    const { copyLicense } = await lib();
    const source = licenseSource(ctx, sys, project, options.from);
    let copied;
    try {
      copied = copyLicense(dir, source, { replace: options.replace === true });
    } catch (e) {
      throw e?.code === "license_exists" ? new CliError("license_exists", `The project has ${e.file} already; it is kept.`, "Run it again with --replace to put the new text in its place.", { file: e.file }) : e?.code === "not_license" ? new CliError("not_license", e.message, "Choose the text file of your license: LICENSE, LICENSE.md or COPYING.") : writeError(e, path.join(dir, "LICENSE"));
    }
    noteStep(dir, "license", { choice, file: "LICENSE", from: path.basename(options.from) }, sys.now());
    return { choice, written: true, copied: copied.from, replaced: copied.replaced, ...(await licenseAnswer(dir, ctx.homeDir)) };
  }
  if (choice === "other") {
    noteStep(dir, "license", { choice }, sys.now());
    return { choice, written: false, ...(await licenseAnswer(dir, ctx.homeDir)) };
  }
  const author = options.author ?? (await lib()).authorGuess(dir, ctx.homeDir);
  const problem = holderProblem(author);
  if (problem) throw new CliError("no_author", problem, "Give it with --author \"Your Name\".");
  const year = options.year === undefined ? new Date(sys.now()).getFullYear() : Number(options.year);
  if (!Number.isInteger(year) || year < 1970 || year > 9999) throw usage(`--year takes a year, not ${JSON.stringify(options.year)}.`);
  let written;
  try {
    written = writeLicense(dir, { id: choice, author, year });
  } catch (e) {
    throw writeError(e, path.join(dir, "LICENSE"));
  }
  noteStep(dir, "license", { choice, author, year, file: written.file }, sys.now());
  // The name and year written, not the guess the step starts from (the field test read the guess as the holder).
  return { choice, written: written.written, kept: written.written ? null : written.file, ...(await licenseAnswer(dir, ctx.homeDir)), author: written.written ? author : null, year: written.written ? year : null };
}

async function files(ctx, sys, project, options) {
  const { noteStep, readProgress, readmeFacts, readmeSaved, readmeState, writable, writeIgnore, writeReadme } = await lib();
  const { readFileSync, writeFileSync } = await import("node:fs");
  const dir = project.dir;
  if (options.readme !== undefined && options.readme !== "replace") throw usage("--readme takes replace.");
  const out = options.keepOut === undefined ? [] : [relativePath(options.keepOut, "--keep-out")];
  const keepIn = options.keepIn === undefined ? null : relativePath(options.keepIn, "--keep-in");
  if (!options.write && (out.length || keepIn || options.readme)) throw usage("--keep-out, --keep-in and --readme change files: give --write with them.");
  if (!options.write) return filesAnswer(dir);
  const written = [];
  try {
    // A file kept in on purpose stays in: the flow does not keep it out by default again (flaggedOut).
    const before = readProgress(dir).steps?.files ?? {};
    const keptIn = new Set(before.kept_in ?? []);
    if (keepIn) keptIn.add(keepIn);
    for (const rel of out) keptIn.delete(rel);
    noteStep(dir, "files", { ...before, kept_in: [...keptIn] }, sys.now());
    out.push(...(await flaggedOut(dir)));
    // The lines this flow added to .gitignore, as the progress notes them. A progress from before the note: every
    // line under the emulator's heading, as it was taken until then.
    const ignoreFile = writable(dir, ".gitignore");
    const ignoreText = existsSync(ignoreFile) ? readFileSync(ignoreFile, "utf8") : "";
    const head = ignoreText.indexOf("# Kept out of the public repository by BUSY Bar Emulator");
    const under = head >= 0 ? ignoreText.slice(head).split("\n") : [];
    const ours = new Set(Array.isArray(before.ignore_added) ? before.ignore_added : under.slice(1).filter((one) => one && !one.startsWith("#")));
    if (keepIn) {
      // Only a line this flow added is taken back, and only once: the same line of the person's own after the
      // emulator's heading is theirs, and stays (audit H13).
      const line = `/${keepIn.replace(/([*?[\]!#\\])/g, "\\$1")}`;
      const at = under.indexOf(line);
      if (at > 0 && ours.has(line)) {
        under.splice(at, 1);
        writeFileSync(ignoreFile, ignoreText.slice(0, head) + under.join("\n"));
        ours.delete(line);
        written.push(".gitignore");
      }
    }
    const added = writeIgnore(dir, out);
    if (added.length) written.push(".gitignore");
    const ignoreAdded = [...new Set([...ours, ...added])];
    const progress = readProgress(dir);
    const state = readmeState(dir, progress);
    // The README step's README, made again with the project as it is now (the texts or screenshots may have changed).
    if (state === "none" || state === "template" || state === "ours" || options.readme === "replace") {
      const { texts } = await textsAnswer(dir);
      const facts = readmeFacts(dir, { name: (await appOf(dir)).name ?? project.id, id: project.id, texts });
      const before = readFileSync(path.join(dir, "README.md"), { encoding: "utf8", flag: "a+" });
      const made = writeReadme(dir, readmeSaved(dir, facts, progress), facts, sys.now());
      if (made.text !== before) written.push("README.md");
    }
    noteStep(dir, "files", { kept_in: [...keptIn], ignore_added: ignoreAdded }, sys.now());
  } catch (e) {
    throw writeError(e, dir);
  }
  return { written: [...new Set(written)], ...(await filesAnswer(dir)) };
}

async function screenshots(ctx, sys, project, options, commands) {
  const { removeScreenshot, screenshotList, writable, writeScreenshotOrder, noteStep } = await lib();
  const dir = project.dir;
  const given = ["take", "upload", "order", "remove"].filter((key) => options[key] !== undefined);
  if (given.length > 1) throw usage("publish screenshots takes one of --take, --upload, --order and --remove at a time.");
  let taken = null;
  let uploaded = null;
  try {
    if (options.display !== undefined && (options.upload === undefined || !["front", "back"].includes(options.display))) throw usage("--display goes with --upload and takes front or back.");
    if (options.upload !== undefined) uploaded = await upload(dir, options.upload, options.display ?? null);
    if (options.take !== undefined) {
      if (options.take !== "front" && options.take !== "back") throw usage("--take takes front or back.");
      const shot = commands?.find((command) => command.name === "screenshot");
      if (!shot) throw new CliError("internal", "This copy of the command line has no screenshot command.", "Report this: the app is incomplete.");
      const before = screenshotList(dir);
      const made = await shot.run(ctx, sys, { args: [], options: { out: `${writable(dir, "screenshots")}${path.sep}`, scale: "8", ...(options.take === "back" ? { back: true } : {}) } });
      taken = path.relative(dir, made.data.file).split(path.sep).join("/");
      // A list that is written down takes the new one at its end; without one, its number puts it there.
      if (before.listed) writeScreenshotOrder(dir, { front: [...before.front.map((one) => one.path), ...(options.take === "front" ? [taken] : [])], back: [...before.back.map((one) => one.path), ...(options.take === "back" ? [taken] : [])] });
    } else if (options.order !== undefined) {
      let order;
      try {
        order = JSON.parse(options.order);
      } catch {
        throw usage('--order takes JSON: {"front": ["screenshots/front-2.png", …], "back": […]}, or one list of them.');
      }
      const now = screenshotList(dir);
      const have = new Set([...now.front, ...now.back].map((one) => one.path));
      // A flat list (the field test's first try): each path goes to its own display, in the order given.
      if (Array.isArray(order)) {
        const backs = new Set(now.back.map((one) => one.path));
        const given = order.map((one) => relativePath(one, "--order"));
        order = { front: given.filter((one) => !backs.has(one)), back: given.some((one) => backs.has(one)) ? given.filter((one) => backs.has(one)) : undefined };
      }
      const front = Array.isArray(order?.front) ? order.front.map((one) => relativePath(one, "--order")) : null;
      const back = Array.isArray(order?.back) ? order.back.map((one) => relativePath(one, "--order")) : now.back.map((one) => one.path);
      if (!front || front.some((one) => !have.has(one)) || back.some((one) => !have.has(one))) throw usage("--order names the project's screenshots as they are listed, front and back.");
      writeScreenshotOrder(dir, { front, back });
    } else if (options.remove !== undefined) {
      if (!removeScreenshot(dir, relativePath(options.remove, "--remove"))) {
        const there = existsSync(path.join(dir, ...options.remove.split("/")));
        throw new CliError("not_found", there ? `${options.remove} is not among the catalog's screenshots (the list in catalog.json), so there is nothing to remove: it stays in screenshots/ and is not sent.` : `${options.remove} is not one of the project's screenshots.`, "Name one as publish screenshots lists it.");
      }
    }
    if (given.length) noteStep(dir, "screenshots", { last: given[0] }, sys.now());
  } catch (e) {
    throw e instanceof CliError ? e : writeError(e, dir);
  }
  return { taken, ...(uploaded ? { uploaded: uploaded.added, refused: uploaded.refused } : {}), ...(await screenshotsAnswer(dir, { pictures: !ctx.mcp })) };
}

/** The files --upload names: a JSON list of paths, or paths joined as PATH joins them. */
function uploadList(value) {
  let files;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      files = JSON.parse(value);
    } catch {
      throw usage('--upload takes a JSON list of files, ["/path/front.png", …], or paths joined by the system\'s path separator.');
    }
  } else files = typeof value === "string" ? value.split(path.delimiter) : [];
  files = files.filter((one) => typeof one === "string" && one !== "");
  if (!files.length || files.length > 20) throw usage("--upload takes 1 to 20 PNG files.");
  return files.map((one) => path.resolve(one));
}

/**
 * Brings screenshots made before into the project: each checked and made small again when it is an enlargement, then
 * written as screenshots/front-<n>.png or back-<n>.png (with its @8x copy), after those there.
 */
async function upload(dir, value, only = null) {
  const files = uploadList(value);
  const { readScreenshotFile } = await import("../../publish/upload.mjs");
  const { screenshotList, writable, writeScreenshotOrder } = await lib();
  const { mkdirSync, readdirSync, writeFileSync } = await import("node:fs");
  const folder = writable(dir, "screenshots");
  const before = screenshotList(dir);
  const order = { front: before.front.map((one) => one.path), back: before.back.map((one) => one.path) };
  const added = [];
  const refused = [];
  for (const file of files) {
    const read = readScreenshotFile(file);
    if (read.problem) {
      refused.push(read.problem);
      continue;
    }
    // The button of one display takes only that display's: the other one's is said, not filed under the wrong one.
    if (only && read.display !== only) {
      refused.push(`${path.basename(file)} is a ${read.display} screenshot (${read.display === "front" ? "72×16" : "160×80"}); upload it with the ${read.display}'s button.`);
      continue;
    }
    mkdirSync(folder, { recursive: true });
    let names = [];
    try {
      names = readdirSync(folder);
    } catch {
      // made just above
    }
    const numbers = names.map((name) => Number(new RegExp(`^${read.display}-(\\d+)(?:@\\d+x)?\\.png$`, "i").exec(name)?.[1] ?? 0));
    const n = Math.max(0, ...numbers) + 1;
    const rel = `screenshots/${read.display}-${n}.png`;
    writeFileSync(writable(dir, `screenshots/${read.display}-${n}.png`), read.small, { flag: "wx" });
    writeFileSync(writable(dir, `screenshots/${read.display}-${n}@8x.png`), read.large, { flag: "wx" });
    order[read.display].push(rel);
    added.push({ path: rel, display: read.display, from: path.basename(file), scale: read.scale });
  }
  if (before.listed && added.length) writeScreenshotOrder(dir, order);
  const kind = only === "front" ? "A front screenshot is a PNG of 72×16, or an exact enlargement of one." : only === "back" ? "A back screenshot is a PNG of 160×80, or an exact enlargement of one." : "A front screenshot is a PNG of 72×16, a back one of 160×80, or an exact enlargement of either.";
  if (!added.length) throw new CliError("not_screenshots", refused.join(" ") || "No file was taken.", kind, { refused });
  return { added, refused };
}

async function packaged(ctx, sys, project, options = {}) {
  const { foreignFolder, onGitHub, writeSubmission, byHandSteps } = await import("../../readiness/submission.mjs");
  const { CATALOG_REPOSITORY } = await import("../../readiness/rules.mjs");
  const { stageOne } = await import("../../publish/stage.mjs");
  const { fingerprint } = await import("../../publish/fingerprint.mjs");
  const { noteStep, readProgress } = await lib();
  // stale-check: a check that passed, with the build and the types, on the project as it is now, holds; else the
  // whole of Pre-flight check runs here first (an agent's publish package or prepare), so that nothing is packaged
  // that does not build.
  const record = readProgress(project.dir).steps?.check ?? null;
  const holds = record?.passed === true && record.compiled === true && !(await freshness(project.dir)).check?.stale;
  let result;
  let grouped;
  if (holds) {
    ({ result } = await runCheck(ctx, sys, project.dir));
    grouped = stageOne(result);
  } else ({ result, grouped } = await preflight(ctx, sys, project, options));
  const { ok: _ok, ...groups } = grouped;
  if (!grouped.ok) {
    throw new CliError("check_failed", `${grouped.fails.length} of the catalog's checks ${grouped.fails.length === 1 ? "fails" : "fail"}: ${grouped.fails.map((one) => one.id).join(", ")}. Nothing was written.`, `Put them right, then run ${commandFor(ctx, project, "publish package")} again.`, groups);
  }
  if (!result.built) throw new CliError("not_built", "The project is not built, so the checks of its package did not run. Nothing was written.", `Run ${commandFor(ctx, project, "build")}, then ${commandFor(ctx, project, "publish package")} again.`, groups);
  const folder = path.join(project.dir, "submission");
  if (foreignFolder(folder)) throw new CliError("submission_exists", `${folder} is there and was not made by the emulator; it is left as it is.`, "Move or rename that folder, then package again.", { file: folder });
  let written;
  try {
    written = writeSubmission({ facts: result.facts, result, firmware: result.firmware, emulatorVersion: ctx.version ?? null, catalog: CATALOG_REPOSITORY, date: new Date(sys.now()).toISOString().slice(0, 10) });
  } catch (e) {
    throw writeError(e, folder);
  }
  const filled = onGitHub(result.facts.git);
  const bytes = result.package?.bytes ?? null;
  noteStep(project.dir, "package", { bytes, filled, folder: written.folder, fingerprint: fingerprint(project.dir, { scope: "package" }) }, sys.now());
  return { submission: written.folder, files: written.files, filled, package: result.package, checks: groups, by_hand: byHandSteps({ facts: result.facts, catalog: CATALOG_REPOSITORY }) };
}

const KB = (bytes) => (bytes === null || bytes === undefined ? "?" : bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`);

export default {
  name: "publish",
  summary: "Publishing an app: stage 1 on this computer (check, catalog texts, screenshots, license, repository files, package), stage 2 through the emulator's app (sign in to GitHub, push, pull request to the catalog)",
  usage: USAGE,
  details: DETAILS,
  maxArguments: 3,
  options: {
    "--license": { key: "license", value: "<id>" },
    "--author": { key: "author", value: "<name>" },
    "--year": { key: "year", value: "<n>" },
    "--write": { key: "write" },
    "--keep-out": { key: "keepOut", value: "<path>" },
    "--keep-in": { key: "keepIn", value: "<path>" },
    "--readme": { key: "readme", value: "replace" },
    "--take": { key: "take", value: "front|back" },
    "--upload": { key: "upload", value: "<files>" },
    "--display": { key: "display", value: "front|back" },
    "--from": { key: "from", value: "<file>" },
    "--replace": { key: "replace" },
    "--mode": { key: "mode", value: "fields|markdown" },
    "--title": { key: "title", value: "<text>" },
    "--intro": { key: "intro", value: "<text>" },
    "--usage": { key: "usageText", value: "<text>" },
    "--markdown": { key: "markdown", value: "<text>" },
    "--order": { key: "order", value: "<json>" },
    "--remove": { key: "remove", value: "<path>" },
    "--owner": { key: "owner", value: "<login>" },
    "--repo": { key: "repo", value: "<name>" },
    "--commit": { key: "commit", value: "<sha>" },
    "--pr": { key: "pr", value: "<url>" },
    "--catalog": { key: "catalog", value: "<owner/name>" },
    "--name": { key: "name", value: "<repository>" },
    "--ai": { key: "ai", value: "none|partly|full" },
    "--use-existing": { key: "useExisting" },
    "--new-account": { key: "newAccount" },
    "--user": { key: "user", value: "<login>" },
    "--no-wait": { key: "noWait" },
    "--controls": { key: "controls", value: "<json>" },
    "--renew": { key: "renew", value: "catalog.json" },
  },
  async run(ctx, sys, { args, options, commands, progress }) {
    const step = args[0];
    if (!STEPS.includes(step)) throw usage(`publish takes a step: ${STEPS.filter((one) => !APP_ONLY.has(one)).join(", ")}${step ? `, not ${JSON.stringify(step)}` : ""}.`);
    if (NO_PROJECT.has(step)) {
      if (args[1] !== undefined) throw usage(`publish ${step} takes no folder.`);
      if (step === "signout") {
        const data = await askApp(ctx, sys, { op: "signout" });
        return { data, text: `Signed out in BUSY Bar Emulator; GitHub CLI's accounts on this computer are left as they are (the window offers to sign it out or switch it back). GitHub keeps the access until you revoke GitHub CLI on ${data.revokePage}; that signs out GitHub CLI everywhere you use it with this account.` };
      }
      if (options.useExisting && options.newAccount) throw usage("publish signin takes --use-existing or --new-account, not both.");
      if (options.user !== undefined && (options.newAccount || !LOGIN.test(options.user))) throw usage(options.newAccount ? "--user names an account GitHub CLI has already: give it with --use-existing, not --new-account." : `--user takes a GitHub login, not ${JSON.stringify(options.user)}.`);
      if (options.noWait && (options.useExisting || options.user !== undefined)) throw usage("--no-wait is for a new sign-in's code, not --use-existing.");
      const useExisting = options.useExisting || options.user !== undefined;
      const now = await askApp(ctx, sys, { op: "status" });
      if (!now.configured) throw new CliError("not_configured", "GitHub CLI is not in this build, so it cannot sign in to GitHub.", "Send the app by hand: the steps are in SUBMIT.md in the project's submission folder.");
      const accounts = Array.isArray(now.accounts) ? now.accounts.filter((one) => one && typeof one.login === "string").map((one) => ({ login: one.login, active: one.active === true })) : now.existing ? [{ login: now.existing, active: true }] : [];
      if (now.signedIn) {
        if (options.user !== undefined && options.user.toLowerCase() !== String(now.login).toLowerCase()) throw new CliError("signed_in_other", `BUSY Bar Emulator publishes as ${now.login}, not ${options.user}.`, `Ask the person; to publish as ${options.user}, run publish signout, then publish signin --user ${options.user}.`, { login: now.login, accounts });
        return { data: { login: now.login, signedIn: true, before: true, origin: now.origin, accounts }, text: `Signed in to GitHub as ${now.login} already.` };
      }
      const said = (done, code = null) => {
        const cli = done.kept ? `GitHub CLI on this computer goes on using ${done.kept}; the emulator publishes as ${done.login}.` : done.renewed && done.previous ? `GitHub CLI on this computer now uses its account ${done.login}, instead of ${done.previous}.` : done.renewed ? `GitHub CLI's own sign-in for ${done.login} on this computer was renewed.` : done.previous ? `GitHub CLI on this computer now uses ${done.login} too, instead of ${done.previous}.` : "This also signed in GitHub CLI on this computer.";
        return { data: { login: done.login, signedIn: true, before: false, origin: done.origin, previous: done.previous ?? null, kept: done.kept ?? null, ...(code ? { userCode: code.userCode, verificationUri: code.verificationUri } : {}) }, text: `Signed in to GitHub as ${done.login}. ${cli}` };
      };
      // A sign-in under way (one --no-wait started, or the window's): its code again, and the wait for it.
      if (now.signing && !useExisting) {
        if (now.signing.userCode && !options.noWait) progress(`Open ${now.signing.verificationUri} and enter the code ${now.signing.userCode}. Waiting for GitHub…`);
        if (options.noWait) return { data: { signedIn: false, waiting: true, userCode: now.signing.userCode ?? null, verificationUri: now.signing.verificationUri ?? null }, text: `A sign-in is under way: open ${now.signing.verificationUri} and enter the code ${now.signing.userCode}. Then run publish signin again to wait for it.` };
        return said(await askApp(ctx, sys, { op: "signin-wait" }, SIGNIN_WAIT_MS), now.signing);
      }
      if (useExisting) {
        if (options.user !== undefined && accounts.length && !accounts.some((one) => one.login.toLowerCase() === options.user.toLowerCase())) throw new CliError("no_existing", `GitHub CLI on this computer has no account ${options.user}.`, `Its accounts: ${accounts.map((one) => one.login).join(", ")}. Ask the person which one to publish with, or run publish signin --new-account.`, { accounts });
        const used = await askApp(ctx, sys, { op: "signin-existing", ...(options.user !== undefined ? { login: options.user } : {}) });
        return { data: { login: used.login, signedIn: true, before: false, origin: "existing", accounts }, text: `Signed in to GitHub as ${used.login}, ${options.user !== undefined ? "one of the accounts" : "the account"} GitHub CLI on this computer is signed in as.` };
      }
      if (accounts.length && !options.newAccount) {
        const names = accounts.map((one) => one.login);
        const active = accounts.find((one) => one.active)?.login ?? names[0];
        throw new CliError(
          "choose_account",
          names.length > 1 ? `GitHub CLI on this computer has ${names.length} accounts: ${names.join(", ")} (it uses ${active}).` : `GitHub CLI on this computer is signed in as ${active}.`,
          `Ask the person which account to publish with: publish signin --use-existing uses ${active}${names.length > 1 ? `; publish signin --user <login> uses another of them` : ""}; publish signin --new-account signs in another one.`,
          { existing: now.existing ?? active, accounts },
        );
      }
      const code = await askApp(ctx, sys, { op: "signin" });
      if (!options.noWait) progress(`Open ${code.verificationUri} and enter the code ${code.userCode} (it expires in 15 minutes). Waiting for GitHub…`);
      if (options.noWait) return { data: { signedIn: false, waiting: true, userCode: code.userCode, verificationUri: code.verificationUri }, text: `Open ${code.verificationUri} and enter the code ${code.userCode} (it expires in 15 minutes). Then run publish signin again: it waits until the person has.` };
      return said(await askApp(ctx, sys, { op: "signin-wait" }, SIGNIN_WAIT_MS), code);
    }
    // publish readme takes get, set or preview before the folder; no other step takes more than the folder.
    const readmeAction = step === "readme" && ["get", "set", "preview"].includes(args[1]) ? args[1] : step === "readme" ? "get" : null;
    const folderArg = readmeAction && args[1] === readmeAction ? args[2] : args[1];
    if (args.length > (readmeAction && args[1] === readmeAction ? 3 : 2)) throw usage(`publish ${step} takes one folder.`);
    const project = projectAt(ctx, sys, folderArg);
    const dir = project.dir;
    switch (step) {
      case "status": {
        const data = await status(ctx, project);
        const text = Object.entries(data.steps).map(([name, state]) => `${name}: ${state}`).join("\n");
        const repo = data.github.repo;
        const request = data.github.request;
        const second = [`github: ${repo ? `${repo.page} at ${repo.commit}` : "todo"}`, `catalog: ${request ? request.url : "todo"}`].join("\n");
        return { data, text: `Publishing ${data.name} (${data.id}), stage 1:\n${text}\nStage 2:\n${second}` };
      }
      case "check": {
        const data = await check(ctx, sys, project, { commands, progress });
        const lines = [data.passed ? (data.built ? "No check fails." : "No check fails so far; the checks of the package wait for a build.") : `${data.fails.length} ${data.fails.length === 1 ? "check fails" : "checks fail"}:`];
        for (const one of data.fails) lines.push(`  ${one.id}: ${one.title}${one.found ? `: ${one.found}` : ""}`);
        if (data.stage2.length) lines.push(`Stage 2 (the repository on GitHub): ${data.stage2.map((one) => one.id).join(", ")}.`);
        if (data.unchecked.length) lines.push(`Not checked here: ${data.unchecked.map((one) => one.id).join(", ")}.`);
        return { data, text: lines.join("\n") };
      }
      case "license": {
        const data = await license(ctx, sys, project, options);
        const text = data.copied ? `Copied ${data.copied} in as ${path.join(dir, "LICENSE")}${data.replaced.length ? `; ${data.replaced.join(", ")} went to .busy/removed` : ""}.` : data.choice === "other" ? "Add your own LICENSE file to the project's folder, or copy it in with --license other --from <file>." : data.written ? `Wrote ${path.join(dir, "LICENSE")} (${data.choice}).` : `Kept ${data.kept}: the project has a license file already.`;
        return { data, text };
      }
      case "files": {
        const data = await files(ctx, sys, project, options);
        const lines = [`${data.published.length} files go into the repository; left out: ${data.left.map((one) => one.path).join(", ") || "nothing"}.`];
        if (data.written) lines.unshift(data.written.length ? `Wrote ${data.written.join(", ")}.` : "Nothing to write.");
        if (data.ignore_missing.length) lines.push(`.gitignore lacks ${data.ignore_missing.join(", ")}: run with --write.`);
        for (const one of data.findings) lines.push(`${one.published ? "Published" : "Kept out"}: ${one.path}${one.lines.length ? ` (line ${one.lines.join(", ")})` : ""}: ${one.kind}.`);
        return { data, text: lines.join("\n") };
      }
      case "screenshots": {
        const data = await screenshots(ctx, sys, project, options, commands);
        const lines = [...(data.taken ? [`Took ${data.taken}.`] : []), ...(data.uploaded ?? []).map((one) => `Added ${one.path} from ${one.from}${one.scale > 1 ? `, made ${one.scale} times smaller` : ""}.`), ...(data.refused ?? []), `Front: ${data.front.map((one) => one.path).join(", ") || "none"}.`, `Back: ${data.back.map((one) => one.path).join(", ") || "none"}.`, ...data.problems];
        return { data, text: lines.join("\n") };
      }
      case "readme": {
        const given = {};
        for (const [option, key] of [["mode", "mode"], ["title", "title"], ["intro", "intro"], ["usageText", "usage"], ["markdown", "markdown"]]) if (typeof options[option] === "string") given[key] = options[option].replace(/\r\n?/g, "\n");
        if (given.mode !== undefined && !["fields", "markdown"].includes(given.mode)) throw usage("--mode takes fields or markdown.");
        if (readmeAction === "get" && (Object.keys(given).length || options.controls !== undefined)) throw usage("The README's fields are given to publish readme set or preview, not get.");
        if (options.controls !== undefined) {
          // The rows of How to use, then --usage (or the sentence the README step has now) after them.
          const howToUse = await import("../../publish/how-to-use.mjs");
          const rows = controlRows(options.controls, howToUse);
          // A sentence after the rows: --usage, or what the README step's How to use holds besides its list.
          const before = (await readmeAnswer(dir, project)).config.usage;
          const rest = given.usage !== undefined ? given.usage.trim() : before.split("\n").filter((line) => !/^\s*[-*+]\s/.test(line) && !/^\s+\S/.test(line)).join("\n").trim();
          given.usage = [howToUse.listOf(rows), rest].filter(Boolean).join("\n\n");
        }
        const data = await readmeAnswer(dir, project, Object.keys(given).length ? given : null);
        if (readmeAction !== "set") return { data, text: data.markdown };
        if (data.problem) throw new CliError("readme_incomplete", `The README is not written: ${data.problem.charAt(0).toLowerCase()}${data.problem.slice(1)}.`, "Give it with --usage, --intro, --title, or --markdown with --mode markdown.", { problem: data.problem });
        const { writeReadme } = await lib();
        try {
          writeReadme(dir, data.config, data.facts, sys.now());
        } catch (e) {
          throw writeError(e, path.join(dir, "README.md"));
        }
        const after = await readmeAnswer(dir, project);
        const lacking = after.config.mode === "fields" && !after.controls.length ? ` How to use names no control of the BUSY Bar: give the rows with --controls '{"Start": "…", "Wheel turn": "…", "Wheel press": "…", "Back": "…"}'.` : "";
        return { data: { written: "README.md", ...after }, text: `Wrote ${path.join(dir, "README.md")}.${lacking}` };
      }
      case "package": {
        const data = await packaged(ctx, sys, project, { commands, progress });
        return { data, text: [`Package: ${data.package?.file ?? "?"}, ${KB(data.package?.bytes)}.`, `Wrote ${data.submission}: ${data.files.join(", ")}.`, data.filled ? "The manifest names the repository and the commit." : "The manifest's repository and commit are filled in stage 2.", "Nothing was sent."].join("\n") };
      }
      case "prepare": {
        if (options.license === undefined && !(await lib()).licenseFiles(dir).length) throw usage("publish prepare needs --license (MIT, Apache-2.0, GPL-3.0, or other with --from <the person's own license file>) for a project without a license file: it is never chosen for you.");
        const steps = {};
        if (options.license !== undefined) steps.license = await license(ctx, sys, project, options);
        steps.files = await files(ctx, sys, project, { write: true });
        const build = commands?.find((command) => command.name === "build");
        progress("Building");
        steps.build = (await build.run(ctx, sys, { args: [dir], options: {}, progress })).data;
        steps.package = await packaged(ctx, sys, project, { commands, progress, skipBuild: true });
        const warned = steps.files.findings.filter((one) => one.published);
        return {
          data: steps,
          text: [`Prepared ${dir} for publishing:`, `  LICENSE: ${(await lib()).licenseFiles(dir).map((one) => one.name).join(", ")}`, `  ${steps.files.written.join(", ") || "README.md and .gitignore were already there"}`, `  package ${KB(steps.package.package?.bytes)}, ${steps.package.submission}`, ...warned.map((one) => `  Warning: ${one.path}: ${one.kind}.`), "Nothing was sent. Next, stage 2: publish signin, publish push, publish pr (or Publish in the emulator's window); SUBMIT.md in submission/ has the steps by hand."].join("\n"),
        };
      }
      case "push": {
        if (options.name !== undefined && !REPO_NAME.test(options.name)) throw usage("--name takes a repository's name: letters, digits, '.', '-' and '_'.");
        // stale-check: what was checked and packaged, or nothing; the app checks it again before it uploads.
        await requireChecked(ctx, project);
        progress("Asking the person in BUSY Bar Emulator to confirm, then publishing to GitHub…");
        const data = await withProgress(ctx, sys, dir, progress, askApp(ctx, sys, { op: "push", folder: dir, ...(options.name ? { name: options.name } : {}) }));
        const links = Array.isArray(data.skipped) && data.skipped.length ? ` Left out, as links: ${data.skipped.join(", ")}.` : "";
        return { data, text: `${data.unchanged ? "Nothing had changed: " : "Published: "}${data.page} at ${data.commit} (${data.files} files, read back from GitHub).${links}` };
      }
      case "pr": {
        if (!AI.includes(options.ai)) throw usage(`publish pr needs --ai: ${AI.join(", ")}, how AI was used in the app. It is never chosen for you.`);
        await requireChecked(ctx, project);
        progress("Asking the person in BUSY Bar Emulator to confirm and to tick the catalog's checklist, its optional items included, then opening the pull request…");
        const data = await withProgress(ctx, sys, dir, progress, askApp(ctx, sys, { op: "request", folder: dir, ai: options.ai, ...(options.catalog ? { catalog: options.catalog } : {}) }));
        // The optional items of the checklist (the contest's), as the person ticked them or not in the app (EMU-313).
        const optional = Array.isArray(data.optional) ? data.optional.map((one) => `${one.ticked ? "ticked" : "not ticked"}: ${String(one.item).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")}`) : [];
        return { data, text: `${data.created ? "Opened" : "Updated"} the pull request ${data.url} (${data.direct ? "a branch in the catalog" : "from your fork"}).${optional.length ? ` Optional items, as the person chose: ${optional.join("; ")}.` : ""}` };
      }
      case "pushed": {
        const data = await pushed(ctx, sys, project, options);
        return { data, text: `Noted: ${data.page} at ${data.commit}.${data.manifest_file ? ` ${data.manifest_file} names it.` : ""}` };
      }
      case "verify": {
        // For the app, right before it uploads or sends (stale-check): what requireChecked says, and the hashes.
        // --renew catalog.json: after an update's What's new was written there (github.request), the records follow
        // that one write, and only when the texts are ones the catalog takes; no other file is renewed this way.
        if (options.renew !== undefined) {
          if (options.renew !== "catalog.json") throw usage("--renew takes catalog.json.");
          if (!(await textsAnswer(dir)).taken) throw new CliError("texts_not_taken", "catalog.json holds texts the catalog does not take, so the check does not follow it.", "Put them right in Application Info, then run the check again.");
          await renewAfter(sys, dir, ["catalog.json"]);
        }
        const data = await requireChecked(ctx, project);
        return { data, text: "The project is as it was checked and packaged." };
      }
      case "requested": {
        const data = await requested(ctx, sys, project, options);
        return { data, text: `Noted: the pull request ${data.url}.` };
      }
    }
    throw usage("publish takes a step.");
  },
};
