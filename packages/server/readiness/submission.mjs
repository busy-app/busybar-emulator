// What a pull request to the BUSY Apps Catalog needs, written into submission/ of the project: the catalog's
// manifest.yml for the app, at the path it has in the catalog; the text for the pull request's description, with the
// fields of the catalog's own template; and SUBMIT.md, the steps to open the pull request. Nothing is sent anywhere,
// no box is ticked for the author, and nothing the author did not write is put into the manifest: the texts and the
// category come from catalog.json, the source from the project's git repository, the screenshots from the project.
//
// The catalog reads the screenshots from the app's own repository at the commit, by the paths the manifest names, and
// its pull request may change one file only, so the folder holds no copies of them.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { DETAILS_FILE, SUBMISSION_FOLDER } from "./facts.mjs";
import { CATEGORIES, LIMITS } from "./rules.mjs";
import { readProgress, writable } from "../publish/files.mjs";

const MARK = "# Written by busy-emulator submit and made again at every run; not for the app's repository.";

/** catalog.json as `submit` first makes it: the four texts for the author to write. */
export function detailsTemplate() {
  return `${JSON.stringify({ category: "", short_description: "", description: "", changelog: "" }, null, 2)}\n`;
}

/** What each field of catalog.json takes, for the text that asks the author to fill it. */
export function detailsHelp() {
  return [
    `category: one of ${CATEGORIES.map((c) => c.id).join(", ")}`,
    `short_description: one line of plain text for the app's card, ${LIMITS.shortDescription.join(" to ")} characters`,
    `description: the app's page, ${LIMITS.description.join(" to ")} characters; level 1–2 headings, bold, italic, lists and links are taken ("\\n" is a new line)`,
    `changelog: what is new in this version, ${LIMITS.changelog.join(" to ")} characters`,
    `screenshots, back_screenshots (optional): lists of PNG files of the project, the cover first; without them screenshots/front-<n>.png and back-<n>.png are taken`,
  ];
}

/** Whether the project's source is a commit of a repository on GitHub: then the manifest names it. */
export const onGitHub = (git) => Boolean(git?.remote?.github && git.head);

/**
 * The repository on GitHub stage 2 of publishing pushed the project to, from the flow's record (.busy/publish.json):
 * { origin, commit }, or null when it has not.
 */
export function pushedRepository(dir) {
  const push = dir ? readProgress(dir).steps?.push : null;
  const origin = typeof push?.origin === "string" && /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\.git$/.test(push.origin) ? push.origin : null;
  const commit = typeof push?.commit === "string" && /^[0-9a-f]{40}$/.test(push.commit) ? push.commit : null;
  return origin && commit ? { origin, commit } : null;
}

/** The line of a manifest that waits for its repository: stage 2 of publishing fills it in. */
export const PENDING = "# Filled in Stage 2: the public repository on GitHub and the commit pushed there.";

// ---------------------------------------------------------------- YAML

// A text as a YAML double-quoted scalar: JSON's escapes are YAML's, and what YAML would not take as it is (C1 control
// characters, the Unicode line breaks, DEL, the byte order mark) is escaped too.
function quoted(text) {
  return JSON.stringify(text).replace(/[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Words YAML gives a meaning of their own, in any letter case.
const YAML_WORD = /^(?:y|n|yes|no|on|off|true|false|null|nan|inf)$/i;

/**
 * A text of one line as the catalog's own manifests write it: as it stands, where every YAML reader gives it back as
 * the same text; quoted otherwise. As it stands: it starts with a Latin letter, holds Latin letters, digits, spaces
 * and . , ' ( ) / + - _ ! ?, ends with a letter, a digit or . ) ! ?, and is no word YAML reads as a value.
 */
function scalar(text) {
  return /^[A-Za-z](?:[A-Za-z0-9 .,'()/+_!?-]*[A-Za-z0-9.)!?])?$/.test(text) && !YAML_WORD.test(text) ? text : quoted(text);
}

/** A commit's 40 hexadecimal digits as they stand, unless a YAML reader could take them for a number. */
function commitScalar(sha) {
  return /^[0-9a-f]{40}$/.test(sha) && /[a-f]/.test(sha) && !/^0b[01]+$/.test(sha) && !/^[0-9]+e[0-9]+$/.test(sha) ? sha : quoted(sha);
}

/** A text of several lines as a literal block (|-), where that gives the text back exactly; otherwise quoted. */
function block(text) {
  const lines = text.split("\n");
  const plain =
    lines.length > 1 &&
    !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/.test(text) &&
    !/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")) &&
    !/^[ \t]/.test(lines[0]) &&
    lines[0] !== "" &&
    lines.at(-1) !== "" &&
    lines.every((line) => line === "" || (!/[ \t]$/.test(line) && line.trim() !== "" && !line.startsWith("\t")));
  if (!plain) return ` ${scalar(text)}`;
  return ` |-\n${lines.map((line) => (line === "" ? "" : `  ${line}`)).join("\n")}`;
}

/**
 * The catalog manifest of the app. `facts` are the project's (facts.mjs), from a check in which nothing failed: the
 * source is a GitHub repository at a commit, the four texts are written, there is a screenshot.
 */
export function manifestYaml(facts) {
  const { git, details } = facts;
  const category = CATEGORIES.find((c) => c.id === details.json.category || c.aliases.includes(details.json.category));
  const lines = ["sourcecode:", "  type: git", "  location:"];
  const pushed = pushedRepository(facts.dir);
  if (onGitHub(git)) {
    lines.push(`    origin: ${git.remote.github.https}`, `    commit_sha: ${commitScalar(git.head)}`);
    if (git.subdir) lines.push(`    subdir: ${scalar(git.subdir)}`);
  } else if (pushed) {
    // Stage 2 of publishing pushed the project to its repository on GitHub, without git: the record names it.
    lines.push(`    origin: ${pushed.origin}`, `    commit_sha: ${commitScalar(pushed.commit)}`);
  } else {
    // Stage 1 of publishing (busy-emulator publish): the repository on GitHub is not there yet.
    lines.push(`    ${PENDING}`, '    origin: "https://github.com/<your-github-user>/<repository>.git"', '    commit_sha: "<the commit, after git push>"');
  }
  lines.push(`category: ${category.id}`);
  lines.push(`short_description: ${scalar(details.json.short_description)}`);
  lines.push(`description:${block(details.json.description)}`);
  lines.push(`changelog:${block(details.json.changelog)}`);
  lines.push("screenshots:", ...facts.screenshots.front.files.map((file) => `  - ${scalar(file.path)}`));
  if (facts.screenshots.back.files.length) lines.push("back_screenshots:", ...facts.screenshots.back.files.map((file) => `  - ${scalar(file.path)}`));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- the texts

function tested(o) {
  const firmware = o.firmware ? `the released firmware ${o.firmware.name} (HTTP API ${o.firmware.api})` : "its released firmware";
  return `Built and run on BUSY Bar Emulator${o.emulatorVersion ? ` ${o.emulatorVersion}` : ""} with ${firmware}. Not run on a physical BUSY Bar. The screenshots are frames of the emulated BUSY Bar's displays, pixel for pixel what the firmware draws.`;
}

/** The pull request's description: the fields of the catalog's template, no box ticked, and what was tested where. */
export function prDescription(o) {
  const terms = `https://github.com/${o.catalog}/blob/main/TERMS.md`;
  return `# Author checklist

- [ ] I've read the [terms for authors](${terms}) and my app follows them
- [ ] I'm the author of the app or have write access to its repository
- [ ] The app builds with \`busy-cli build\`, and the lock file is committed
- [ ] The manifest follows the catalog manifest format
- [ ] I've tested the app on a BUSY Bar with the latest release firmware
- [ ] The screenshots are taken from the bar

# Device testing

${tested(o)}

Checked before submitting with \`busy-emulator check\` (the catalog's rules of ${o.result.rules.date}): ${o.result.counts.pass} of ${o.result.counts.total} checks pass, none fails${o.result.counts.warning ? `, ${o.result.counts.warning} warning(s)` : ""}; ${o.result.counts.unchecked} could not be checked outside the catalog.

# AI usage

Keep ONE option and delete the others.

- No AI was used.
- Partly AI-assisted: which parts, and what they do.
- Fully AI-generated: what the generated code does.
`;
}

const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``;

/** SUBMIT.md: what is in the folder, what to make sure of, and the steps to the pull request. */
export function submitSteps(o) {
  const { facts, result } = o;
  const id = facts.id;
  const name = facts.manifest.json?.name ?? id;
  const sha = facts.git.head;
  const page = facts.git.remote.github.page;
  const catalogName = o.catalog.split("/")[1];
  const branch = `add-${id}`;
  const manifest = path.join(o.folder, "applications", id, "manifest.yml");
  const open = result.checks.filter((c) => c.status === "unchecked" && c.applies);
  const warnings = result.checks.filter((c) => c.status === "fail" && !c.blocking);
  const sh = [`git clone https://github.com/<your-github-user>/${catalogName}.git`, `cd ${catalogName}`, `git checkout -b ${branch}`, `mkdir -p applications/${id}`, `cp '${manifest.replace(/'/g, `'\\''`)}' applications/${id}/manifest.yml`, `git add applications/${id}/manifest.yml`, `git commit -m "Add ${name.replace(/["\\$`]/g, "")} (${id})"`, `git push -u origin ${branch}`].join("\n");
  const ps = [`git clone https://github.com/<your-github-user>/${catalogName}.git`, `cd ${catalogName}`, `git checkout -b ${branch}`, `New-Item -ItemType Directory -Force applications/${id} | Out-Null`, `Copy-Item -LiteralPath '${manifest.replace(/'/g, "''")}' -Destination applications/${id}/manifest.yml`, `git add applications/${id}/manifest.yml`, `git commit -m "Add ${name.replace(/["\\$`]/g, "")} (${id})"`, `git push -u origin ${branch}`].join("\n");
  return `# Submitting ${name} (${id}) to the BUSY Apps Catalog

Prepared by \`busy-emulator submit\`${o.emulatorVersion ? ` of BUSY Bar Emulator ${o.emulatorVersion}` : ""} on ${o.date}. Nothing was sent anywhere and no box was
ticked: you open the pull request yourself.

## What is in this folder

- \`applications/${id}/manifest.yml\`: the one file your pull request adds to the catalog, at the path it has there.
  It names your repository ${page} at commit \`${sha}\`${facts.git.subdir ? `, folder \`${facts.git.subdir}\`` : ""}, your texts from \`${DETAILS_FILE}\`
  and ${facts.screenshots.front.files.length} screenshot(s)${facts.screenshots.back.files.length ? ` and ${facts.screenshots.back.files.length} back screenshot(s)` : ""}.
- \`PR-DESCRIPTION.md\`: the text for the pull request's description, with the fields of the catalog's template.
- \`SUBMIT.md\`: this file.

The screenshots are not copied here: the catalog reads them from your repository at that commit
(${[...facts.screenshots.front.files, ...facts.screenshots.back.files].map((file) => `\`${file.path}\``).join(", ")}). This folder ignores itself in git.

## Before you open the pull request

1. **Everything is committed and pushed.** \`git status\` in the project says there is nothing to commit, and
   \`git push\` has sent commit \`${sha.slice(0, 12)}\`. The catalog builds exactly that commit: the screenshots, the LICENSE
   and the lock file must be in it. If you commit again, run \`busy-emulator submit\` again: the manifest names the commit.
2. **The repository is public.** ${page}/commit/${sha} opens in a browser where you are not signed in.
3. **What the emulator could not check** (${open.length}):
${open.map((c) => `   - \`${c.id}\`, ${c.title}: ${c.why}.${c.change ? ` ${c.change}` : ""}`).join("\n")}
${warnings.length ? `4. **Warnings** the catalog shows and still takes the app with:\n${warnings.map((c) => `   - \`${c.id}\`, ${c.title}: ${c.found}. ${c.change ?? ""}`).join("\n")}\n` : ""}
## Open the pull request

1. Fork https://github.com/${o.catalog} on GitHub (the Fork button), or with GitHub's command line:
   \`gh repo fork ${o.catalog} --clone=false\`.
2. Put the manifest into a branch of your fork. Change nothing else there: a pull request that touches any other
   file fails the catalog's first check.

   macOS and Linux:

${fence("sh", sh).split("\n").map((line) => `   ${line}`).join("\n")}

   Windows (PowerShell):

${fence("powershell", ps).split("\n").map((line) => `   ${line}`).join("\n")}

3. On GitHub open a pull request from that branch into \`main\` of ${o.catalog}. Replace the description with the
   text of \`PR-DESCRIPTION.md\` and tick the boxes that are true for you. **Tick "I'm the author of the app or have
   write access to its repository" before you open the pull request**: the checks do not run again when the
   description is edited later (then push a new commit, or close and reopen the pull request). Keep one line under
   "AI usage" and delete the others.
4. The catalog's checks run on the pull request and say what they find; then a moderator reviews the app.

## What was tested

${tested(o)} If you did test it on a BUSY Bar, say so in the description and tick those two boxes.

\`busy-emulator check\`, with the catalog's rules of ${result.rules.date}: ${result.counts.pass} of ${result.counts.total} checks pass, none fails${result.counts.warning ? `, ${result.counts.warning} warning(s)` : ""}, ${result.counts.unchecked}
could not be checked here (listed above), and ${result.counts.not_applicable} say nothing about an app being submitted.
`;
}

/**
 * The steps from a project on this computer to a pull request to the catalog, by hand: commit, a public repository
 * on GitHub, push, the manifest again (now with the commit), the catalog's fork and the pull request. Stage 2 of
 * publishing will do them; until then a person does them. [{ text, commands }]: a step, and the lines to type for it.
 */
export function byHandSteps({ facts, catalog }) {
  const id = facts.id;
  const name = facts.manifest.json?.name ?? id;
  const version = facts.manifest.json?.version ?? "";
  const repository = (id ?? "app").split(".").at(-1);
  const steps = [];
  const sh = (text) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`);
  steps.push({ text: "Open a terminal in the project's folder.", commands: [`cd ${sh(facts.dir)}`] });
  steps.push({ text: "Commit everything that is to be published.", commands: [...(facts.git ? [] : ["git init -b main"]), "git add -A", `git commit -m ${sh(`${name}${version ? ` ${version}` : ""}`)}`] });
  steps.push({ text: `On github.com, create a new public repository, ${repository} for example, with no README, license or .gitignore: the project has them.`, commands: [] });
  steps.push({ text: "Connect the project to it and push.", commands: [`git remote add origin https://github.com/<your-github-user>/${repository}.git`, `git push -u origin ${facts.git?.branch ?? "main"}`] });
  steps.push({ text: "Build and package again in the emulator: the manifest then names the repository and the commit.", commands: [] });
  steps.push({ text: `Fork https://github.com/${catalog} and add submission/applications/${id}/manifest.yml there as applications/${id}/manifest.yml, changing nothing else.`, commands: [] });
  steps.push({ text: "Open a pull request into its main branch with the text of submission/PR-DESCRIPTION.md, and tick the boxes that are true.", commands: [] });
  return steps;
}

/** SUBMIT.md before the repository is on GitHub: what is ready, and the steps by hand. */
export function draftSteps(o) {
  const { facts } = o;
  const id = facts.id;
  const name = facts.manifest.json?.name ?? id;
  const steps = byHandSteps(o);
  return `# Publishing ${name} (${id})

Prepared by \`busy-emulator publish\`${o.emulatorVersion ? ` of BUSY Bar Emulator ${o.emulatorVersion}` : ""} on ${o.date}. Nothing was sent anywhere.

## What is ready

- \`applications/${id}/manifest.yml\`: the file your pull request adds to the BUSY Apps Catalog. Its texts and
  screenshots are filled in; the repository and the commit wait for the repository on GitHub (marked "Filled in Stage 2").
- \`PR-DESCRIPTION.md\`: the text for the pull request's description.

## By hand, until the emulator does it for you

${steps.map((step, i) => [`${i + 1}. ${step.text}`, ...step.commands.map((line) => `   \`${line}\``)].join("\n")).join("\n")}
`;
}

// ---------------------------------------------------------------- writing

/** Whether `folder` is there and was not made by submit: then it is somebody's own, and is not written over. */
export function foreignFolder(folder) {
  if (!existsSync(folder)) return false;
  try {
    return !readFileSync(path.join(folder, ".gitignore"), "utf8").startsWith(MARK);
  } catch {
    return true;
  }
}

/**
 * Writes submission/ in the project. `o`: { facts, result, firmware, emulatorVersion, catalog, date }.
 * @returns {{ folder: string, files: string[] }}  the files written, relative to the folder, with forward slashes
 */
export function writeSubmission(o) {
  // Every path by its real path inside the project (writable): a submission/ that is a link out is neither emptied
  // nor written into.
  const folder = writable(o.facts.dir, SUBMISSION_FOLDER);
  const all = { ...o, folder };
  // submission/applications that is a link (a junction on Windows), even to a folder of the project: only the link
  // goes, never what it leads to.
  const applications = path.join(folder, "applications");
  let linked = false;
  try {
    linked = lstatSync(applications).isSymbolicLink();
  } catch {
    // not there
  }
  if (linked) unlinkSync(applications);
  else rmSync(writable(o.facts.dir, `${SUBMISSION_FOLDER}/applications`), { recursive: true, force: true });
  mkdirSync(writable(o.facts.dir, `${SUBMISSION_FOLDER}/applications/${o.facts.id}`), { recursive: true });
  const files = {
    ".gitignore": `${MARK}\n*\n`,
    [`applications/${o.facts.id}/manifest.yml`]: manifestYaml(o.facts),
    "PR-DESCRIPTION.md": prDescription(all),
    "SUBMIT.md": onGitHub(o.facts.git) ? submitSteps(all) : draftSteps(all),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(writable(o.facts.dir, `${SUBMISSION_FOLDER}/${name}`), text);
  return { folder, files: Object.keys(files).filter((name) => name !== ".gitignore") };
}
