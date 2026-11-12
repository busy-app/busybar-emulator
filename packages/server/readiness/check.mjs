// What the BUSY Apps Catalog's checks would say about a project, before it is submitted: every check of the catalog
// (rules.mjs) answered from the project's folder and its built package with one of three answers — it passes, it fails
// (what was found here and what to change), or it cannot be checked here (and why). Nothing is written, nothing of the
// project is run: its scripts are only parsed (import-probe.mjs).
//
// A defect is reported once, under the check that names it most closely. Where the catalog's bot would name a broader
// check first (a wrong text length is a "manifest fields" failure there), the finding says so.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CATALOG_MANIFEST, CATALOG_MANIFEST_BYTES, DETAILS_FIELDS, DETAILS_FILE, gatherFacts, safeRelative } from "./facts.mjs";
import { probeImports } from "./import-probe.mjs";
import { markdownProblem } from "./markdown.mjs";
import { entryAt, fitsPlainTar, partsOf } from "./package-file.mjs";
import { CATEGORIES, CHECKS, compareVersions, ID_RULE, idProblem, idRecommended, KNOWN_LICENSES, LIMITS, MANIFEST_KEYS, MIB, nameProblem, recognizeLicense, RULES_COMMIT, RULES_DATE, versionNumbers } from "./rules.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_FILE = path.join(here, "catalog-registry.json");
export const PNG_CHECKER_FILE = path.join(here, "..", "capture", "catalog-png.mjs");

// ---------------------------------------------------------------- answers

const pass = (found = null) => ({ status: "pass", found, change: null, why: null });
const fail = (found, change) => ({ status: "fail", found, change, why: null });
/** `why`: why it has no answer here; `change`: what to do to get one, or to check it by hand. */
const unchecked = (why, change = null) => ({ status: "unchecked", found: null, change, why, waits: false });
/** Unchecked because something else must be put right first: a failing check, the build, the author's texts. */
const waiting = (why, change = null) => ({ ...unchecked(why, change), waits: true });

const NOT_BUILT = (f) => waiting("the project is not built: there is no dist/" + (f.id ?? "<id>") + ".tgz", "Run busy-emulator build first.");
const length = (text) => [...text].length;
const mib = (bytes) => `${(bytes / MIB).toFixed(1)} MiB`;
/** "a", "a and b", "a, b and c". */
const words = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join(""));
const list = (items, most = 5) => (items.length > most ? `${items.slice(0, most).join(", ")} and ${items.length - most} more` : items.join(", "));

/** The package's entries, or the answer that stands in for every check that needs them. */
function entriesOr(f) {
  if (!f.pkg) return { answer: NOT_BUILT(f) };
  if (f.pkg.tooLarge) return { answer: waiting("the package is too large to read here (see unpacked_size)") };
  if (f.pkg.unreadable) return { answer: waiting("the package cannot be read (see archive_invalid)") };
  return { entries: f.pkg.entries };
}

/** The app's manifest the catalog would see: the built one, else the project's own, with where it is from. */
function manifestOr(f) {
  if (f.built) return f.built.json !== undefined ? { json: f.built.json, from: "appmeta/manifest.json of the built package" } : { answer: waiting("appmeta/manifest.json of the built package is not JSON (see manifest_json)") };
  if (f.pkg && !f.pkg.unreadable && !f.pkg.tooLarge) return { answer: waiting("the built package has no appmeta/manifest.json (see manifest_missing)") };
  if (!f.manifest.exists) return { answer: waiting(`the project has no ${f.manifest.relative}`) };
  if (f.manifest.json === undefined) return { answer: waiting(`${f.manifest.relative} is not JSON (see manifest_json)`) };
  return { json: f.manifest.json, from: `${f.manifest.relative} (the project is not built)` };
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The author's catalog details, or the answer for a check that needs them. */
function detailsOr(f) {
  if (!f.details.exists) return { answer: waiting(`the catalog details are not written: there is no ${DETAILS_FILE}`, `Run busy-emulator check: it makes ${DETAILS_FILE} in the project's folder for you to fill.`) };
  if (!isObject(f.details.json)) return { answer: waiting(`${DETAILS_FILE} cannot be read (see manifest_readable)`) };
  return { details: f.details.json };
}

const filled = (value) => typeof value === "string" && value.trim() !== "";

/** A file that is in the folder and that git does not keep: the catalog, which reads the commit, will not see it. */
const notKept = (state) => state !== null && state !== undefined && !state.kept;
/** How to say it: "is not added to git", with the spelling git keeps where only the letter case differs. */
const notKeptText = (name, state) => (state.spelled ? `${name} is in git as ${state.spelled}: the letter case differs, and the catalog builds where that matters` : `${name} is not added to git, so it is not in the commit the catalog reads`);
/**
 * What to do about a project without a license. Which license is the author's decision: nothing of the emulator
 * writes one, and an agent is told not to pick one either (in the field test it wrote MIT in the author's name).
 */
export const NO_LICENSE = `The license is the author's choice: ask them which, do not pick one for them. The catalog recognizes ${KNOWN_LICENSES.join(", ")} (choosealicense.com has the texts). Then add the unchanged text as a LICENSE file and commit it.`;

const ADD_IT = (name) => `Run git add ${/^[A-Za-z0-9_./@-]+$/.test(name) ? name : JSON.stringify(name)}, commit and push.`;

// ---------------------------------------------------------------- Markdown

// The rule itself is markdown.mjs: the device window loads it as well.
export { markdownProblem };

// ---------------------------------------------------------------- pictures

/** One PNG by the catalog's rules: { ok, unsure, text }. `kind`: front, back, icon_front, icon_back. */
function picture(f, file, kind) {
  if (!file.bytes) return { ok: false, text: file.tooLarge ? `${file.path} is ${mib(file.tooLarge)}` : `${file.path} is not there` };
  const verdict = f.png.check(file.bytes, kind);
  if (verdict.verdict === "fail") return { ok: false, text: `${file.path}: ${verdict.message}` };
  if (verdict.verdict === "unverified") return { ok: true, unsure: `${file.path}: ${verdict.message}` };
  return { ok: true, unsure: null, note: verdict.note ? `${file.path}: ${verdict.note}` : null };
}

const NO_PNG = unchecked("this copy of the emulator has no PNG checker (capture/catalog-png.mjs)");
const SIZES = { front: "72×16", back: "160×80" };

/** A screenshot the catalog would not get to read: named outside the folder, or not there. Another check says so. */
const unreachable = (file) => !file.safe || file.inGit || file.outside || (!file.bytes && !file.tooLarge);

function picturesFirst(f, display) {
  const set = f.screenshots[display];
  if (!set.files.length) return display === "front" ? waiting("there are no screenshots (see screenshots_count)") : pass("no back screenshots: they are optional");
  // The catalog finds every file before it reads the first one as a picture.
  if (set.files.some((file) => !file.safe)) return waiting("a file is named outside the app's folder (see manifest_references)");
  if (set.files.some(unreachable)) return waiting("a file is not there (see referenced_file)");
  if (!f.png) return NO_PNG;
  const results = set.files.map((file) => picture(f, file, display));
  const bad = results.filter((r) => !r.ok);
  if (bad.length) return fail(list(bad.map((r) => r.text), 3), `Replace the file with a PNG of exactly ${SIZES[display]} pixels, 8 bits a channel: busy-emulator screenshot${display === "back" ? " --back" : ""} makes one from the BUSY Bar's display.`);
  const notes = results.map((r) => r.note).filter(Boolean);
  return pass(`${set.files.length} file(s) of ${SIZES[display]}: ${list(set.files.map((file) => file.path))}${notes.length ? `. ${notes.join(" ")}` : ""}`);
}

function picturesFinal(f, display) {
  const set = f.screenshots[display];
  if (!set.files.length) return display === "front" ? waiting("there are no screenshots (see screenshots_count)") : pass("no back screenshots: they are optional");
  if (set.files.some(unreachable)) return waiting(`a file is not there (see ${set.files.some((file) => !file.safe) ? "manifest_references" : "referenced_file"})`);
  if (!f.png) return NO_PNG;
  const results = set.files.map((file) => picture(f, file, display));
  if (results.some((r) => !r.ok)) return waiting(`a file is not a valid PNG yet (see ${display === "front" ? "screenshot_png" : "back_screenshot_png"})`);
  const unsure = results.map((r) => r.unsure).filter(Boolean);
  if (unsure.length) return unchecked(list(unsure, 2), "Save the file again as plain 8-bit RGB or grayscale without extra chunks, or take it with busy-emulator screenshot.");
  return pass("plain PNG files, which the catalog's build saves again as they are");
}

// ---------------------------------------------------------------- the checks

function idCheck(f) {
  if (!f.manifest.exists) return fail(`the project has no ${f.manifest.relative}, so the app has no id`, `Add ${f.manifest.relative} with "id".`);
  const problem = idProblem(f.id);
  return problem ? fail(`the id ${JSON.stringify(f.id ?? null)} in ${f.manifest.relative}: ${problem}`, `Set "id" in ${f.manifest.relative} to ${ID_RULE}.`) : pass(f.id);
}

const DECIDERS = {
  // ------------------------------------------------------------ the catalog manifest
  manifest_path: (f) => {
    const id = idCheck(f);
    return id.status === "pass" ? pass(`busy-emulator submit writes applications/${f.id}/manifest.yml`) : id;
  },
  id_style: (f) => {
    if (idProblem(f.id)) return waiting("the id is not valid yet (see app_id_format)");
    return idRecommended(f.id) ? pass(f.id) : fail(`${f.id} does not start with a domain-like part`, "Recommended: a reverse-domain id, com.example.weather, or io.github.<your-github-user>.<app> if you have no website. The catalog takes the app as it is.");
  },
  app_id_format: idCheck,
  manifest_readable: (f) => {
    if (!f.details.exists) return detailsOr(f).answer;
    if (!isObject(f.details.json)) return fail(`${DETAILS_FILE} is not a JSON object${f.details.error ? `: ${f.details.error}` : ""}`, `Fix ${DETAILS_FILE}: one JSON object with the fields ${DETAILS_FIELDS.slice(0, 4).join(", ")}.`);
    return pass(`busy-emulator submit writes the manifest's YAML from ${DETAILS_FILE}`);
  },
  manifest_schema: (f) => {
    if (!f.details.exists) return fail(`the catalog details (category, short_description, description, changelog) are not written: there is no ${DETAILS_FILE}`, `Run busy-emulator check: it makes ${DETAILS_FILE} in the project's folder for you to fill.`);
    const { details, answer } = detailsOr(f);
    if (answer) return answer;
    const problems = [];
    const unwritten = [];
    const unknown = Object.keys(details).filter((key) => !DETAILS_FIELDS.includes(key) && !/^[$_]/.test(key));
    if (unknown.length) problems.push(`${unknown.map((key) => JSON.stringify(key)).join(", ")}: not a field of the catalog manifest (its fields: ${DETAILS_FIELDS.join(", ")})`);
    for (const key of ["category", "short_description", "description", "changelog"]) {
      if (details[key] === undefined || details[key] === "") {
        problems.push(`${key}: not written yet`);
        unwritten.push(key);
      }
      else if (typeof details[key] !== "string") problems.push(`${key}: must be a text`);
      else if (!filled(details[key])) problems.push(`${key}: only spaces`);
    }
    if (filled(details.short_description)) {
      const n = length(details.short_description);
      if (/[\r\n]/.test(details.short_description)) problems.push("short_description: must be one line");
      else if (n < LIMITS.shortDescription[0] || n > LIMITS.shortDescription[1]) problems.push(`short_description: ${n} characters, the catalog takes ${LIMITS.shortDescription.join(" to ")}`);
    }
    for (const key of ["screenshots", "back_screenshots"]) if (details[key] !== undefined && (!Array.isArray(details[key]) || details[key].some((item) => typeof item !== "string" || !item))) problems.push(`${key}: must be a list of file paths`);
    if (problems.length) {
      // The fields to fill by name, and where: the file is in the project's folder (check and submit make it).
      const fill = unwritten.length ? `Fill in ${words(unwritten)} in ${DETAILS_FILE} in the project's folder` : `Change them in ${DETAILS_FILE} in the project's folder`;
      return fail(problems.join("; "), `${fill}. category is one of: ${CATEGORIES.map((c) => c.id).join(", ")}.`);
    }
    return pass(`${DETAILS_FILE} has the four texts; the source and the screenshots are filled in by busy-emulator submit`);
  },
  manifest_references: (f) => {
    const { details, answer } = detailsOr(f);
    if (answer) return answer;
    const problems = [];
    for (const key of ["short_description", "category"]) if (typeof details[key] === "string" && details[key].startsWith("@")) problems.push(`${key} starts with @, which the catalog reads as a file reference`);
    if (typeof details.description === "string" && details.description.startsWith("@") && !safeRelative(details.description.slice(1))) problems.push("description names a file outside the app's folder");
    for (const display of ["front", "back"]) for (const file of f.screenshots[display].files) if (!file.safe) problems.push(`${file.path} leaves the app's folder`);
    if (problems.length) return fail(problems.join("; "), "Use paths inside the project's folder, with forward slashes and without \"..\"; write the texts themselves, not file references.");
    return pass();
  },
  changelog_text: (f) => {
    const { details, answer } = detailsOr(f);
    if (answer) return answer;
    if (!filled(details.changelog)) return waiting("the changelog is not written yet (see manifest_schema)");
    if (details.changelog.startsWith("@")) return fail("the changelog starts with @, which the catalog reads as a file reference", `Write the changelog itself in ${DETAILS_FILE}.`);
    const n = length(details.changelog);
    if (n < LIMITS.changelog[0] || n > LIMITS.changelog[1]) return fail(`the changelog is ${n} characters, the catalog takes ${LIMITS.changelog.join(" to ")}`, `Change "changelog" in ${DETAILS_FILE}: what is new in this version.`);
    return pass(`${n} characters`);
  },
  official_namespace: (f) => {
    if (typeof f.id !== "string" || !f.id.startsWith("app.busy.")) return pass();
    const owner = f.git?.remote?.github?.owner ?? null;
    if (owner?.toLowerCase() === "busy-app") return pass();
    return fail(`the id ${f.id} starts with app.busy., which official BUSY apps use${owner ? `, and the repository is ${owner}'s` : ""}`, "Use an id of your own, for example io.github.<your-github-user>.<app>.");
  },
  category_public: (f) => {
    const { details, answer } = detailsOr(f);
    if (answer) return answer;
    if (!filled(details.category)) return waiting("the category is not chosen yet (see manifest_schema)");
    const category = CATEGORIES.find((c) => c.id === details.category || c.aliases.includes(details.category));
    if (!category) return fail(`${JSON.stringify(details.category)} is not a category of the catalog`, `Set "category" in ${DETAILS_FILE} to one of: ${CATEGORIES.map((c) => `${c.id} (${c.about})`).join("; ")}.`);
    return pass(`${category.id}: ${category.name}`);
  },
  category_alias: (f) => {
    const { details, answer } = detailsOr(f);
    if (answer) return answer;
    const category = CATEGORIES.find((c) => c.aliases.includes(details.category));
    return category ? fail(`${JSON.stringify(details.category)} is another name of ${category.id}`, `Write "category": "${category.id}" in ${DETAILS_FILE}.`) : pass();
  },

  // ------------------------------------------------------------ the source
  source_origin: (f) => {
    const publish = "make an empty public repository on github.com, then git remote add origin https://github.com/<you>/<repo>.git and git push -u origin HEAD";
    if (!f.git) return fail("the project is not in a git repository: the catalog builds the app from a public GitHub repository at a commit", `Publish the source: git init, git add -A, git commit -m "First version", ${publish}.`);
    if (!f.git.remote) return fail(f.git.remotes ? `the repository has ${f.git.remotes} remotes and none is named origin` : "the repository has no remote: the catalog builds the app from a public GitHub repository", f.git.remotes ? "Name the GitHub one origin (git remote rename <name> origin)." : `Commit everything (git add -A, git commit), ${publish}.`);
    if (!f.git.remote.github) return fail(`the remote ${f.git.remote.name} is at ${f.git.remote.host}, not a repository on github.com`, "The catalog takes only https://github.com/<owner>/<repo>: publish the source there and make that remote origin.");
    if (!f.git.head) return fail(f.git.unusualHead ? `the commit's hash is ${f.git.unusualHead} characters long; the catalog takes the 40 of SHA-1` : "the repository has no commit yet", "Commit the project (git add -A, git commit), then git push.");
    return pass(`${f.git.remote.github.https} at ${f.git.head}`);
  },
  source_commit: (f) => {
    if (!f.git?.head || !f.git.remote?.github) return waiting("there is no commit on a GitHub remote yet (see source_origin)");
    if (f.git.seenOnRemote) return pass(`${f.git.head.slice(0, 12)} is ${f.git.seenOnRemote}, as this copy last saw it`);
    return unchecked(`this copy has not seen commit ${f.git.head.slice(0, 12)} on ${f.git.remote.name}; it may not be pushed`, `Run git push, and look at ${f.git.remote.github.page}/commit/${f.git.head} in a browser without signing in: the repository must be public.`);
  },
  source_subdir: (f) => (f.git ? pass(f.git.subdir ? `the app is in ${f.git.subdir}/ of the repository` : "the app is the repository's top folder") : waiting("the project is not in a git repository (see source_origin)")),
  app_id_match: (f) => {
    if (idProblem(f.id)) return waiting("the id is not valid yet (see app_id_format)");
    // The catalog reads the id from one place of the repository, before it builds anything.
    if (!f.manifest.inSrc) return fail(`the app's manifest is ${f.manifest.relative}; the catalog reads the id from ${CATALOG_MANIFEST} of the app's folder and finds no file there`, `Move the app's sources into src/ (src/appmeta/, src/main.js and the rest), as the official template has them, and build again. busy-cli builds both layouts; the catalog takes this one.`);
    if (f.manifest.link) return fail(`${CATALOG_MANIFEST} is a symbolic link, which the catalog does not follow`, "Put the file itself there.");
    if (f.manifest.bytes.length > CATALOG_MANIFEST_BYTES) return fail(`${CATALOG_MANIFEST} is ${f.manifest.bytes.length} bytes; the catalog reads the id from a file of up to ${CATALOG_MANIFEST_BYTES}`, `Shorten ${CATALOG_MANIFEST}: the built one may have ${LIMITS.manifestBytes} bytes at most.`);
    if (notKept(f.manifestGit)) return fail(notKeptText(CATALOG_MANIFEST, f.manifestGit), ADD_IT(CATALOG_MANIFEST));
    return pass(`busy-emulator submit names the folder applications/${f.id}/ after the id`);
  },
  license: (f) => {
    const seen = f.licenses.filter((l) => !notKept(l.git));
    if (seen.length) return pass(list(seen.map((l) => `${l.name} in ${l.where}`)));
    if (f.licenses.length) return fail(list(f.licenses.map((l) => notKeptText(l.name, l.git)), 2), ADD_IT(f.licenses[0].name));
    return fail(`there is no LICENSE, LICENCE or COPYING file in the app's folder${f.git && f.git.top !== f.dir ? " or the repository's top folder" : ""}`, NO_LICENSE);
  },
  license_unrecognised: (f) => {
    const seen = f.licenses.filter((l) => !notKept(l.git));
    if (!seen.length) return waiting(f.licenses.length ? "the license file is not added to git (see license)" : "there is no license file (see license)");
    for (const license of seen) {
      const id = license.text === null ? null : recognizeLicense(license.text);
      if (id) return pass(`${license.name}: ${id}`);
    }
    return fail(`the text of ${list(seen.map((l) => l.name))} is not one the catalog recognizes (${KNOWN_LICENSES.join(", ")}); a moderator will read it`, "Use the unchanged text of a standard open source license, for example from choosealicense.com.");
  },
  referenced_file: (f) => {
    const files = [...f.screenshots.front.files, ...f.screenshots.back.files];
    if (!files.length) return waiting("there are no screenshots (see screenshots_count)");
    if (files.some((file) => !file.safe)) return waiting("a file is named outside the app's folder (see manifest_references)");
    const missing = files.filter((file) => !file.bytes && !file.tooLarge);
    if (missing.length) return fail(`${list(missing.map((file) => file.path))}: not in the project`, `Put the file there, or take it out of "screenshots" in ${DETAILS_FILE}.`);
    const hidden = files.filter((file) => file.inGit || file.outside);
    if (hidden.length) return fail(list(hidden.map((file) => (file.inGit ? `${file.path} is inside a .git folder` : `${file.path} is a link that leads out of the app's folder`)), 3), "Name a file of the app's folder itself.");
    const loose = files.filter((file) => notKept(file.git));
    if (loose.length) return fail(list(loose.map((file) => notKeptText(file.path, file.git)), 3), loose.some((file) => file.git.spelled) ? `Write the path in ${DETAILS_FILE} as git has it, or rename the file with git mv; then commit and push.` : `Run git add ${loose.map((file) => (/^[A-Za-z0-9_./@-]+$/.test(file.path) ? file.path : JSON.stringify(file.path))).join(" ")}, commit and push.`);
    return pass(`${files.length} file(s) are in the project${files.every((file) => file.git?.kept) ? " and in git" : ""}; the catalog reads them at the commit, so they must be committed`);
  },
  text_resolve: (f) => {
    const { details, answer } = detailsOr(f);
    if (answer) return answer;
    if (!filled(details.description)) return waiting("the description is not written yet (see manifest_schema)");
    if (details.description.startsWith("@")) return unchecked("the description names a file; this check reads only a text written in place", `Write the description itself in ${DETAILS_FILE}.`);
    const n = length(details.description);
    if (n < LIMITS.description[0] || n > LIMITS.description[1]) return fail(`the description is ${n} characters, the catalog takes ${LIMITS.description.join(" to ")} (its bot names this "manifest fields")`, `Change "description" in ${DETAILS_FILE}.`);
    return pass(`the description is ${n} characters`);
  },
  markdown: (f) => {
    const { details, answer } = detailsOr(f);
    if (answer) return answer;
    const texts = ["description", "changelog"].filter((key) => filled(details[key]) && !details[key].startsWith("@"));
    if (!texts.length) return waiting("the description and the changelog are not written yet (see manifest_schema)");
    const unsure = [];
    for (const key of texts) {
      const found = markdownProblem(details[key]);
      if (found.problem) return fail(`${key}, ${found.problem}`, "The catalog takes only level 1–2 headings, bold, italic, lists and http(s) links there: take the rest out.");
      if (found.unsure) unsure.push(`${key}, ${found.unsure}`);
    }
    if (unsure.length) return unchecked(unsure.join("; "), "Start the line at the margin, or indent it less.");
    return pass();
  },
  screenshots_count: (f) => {
    const set = f.screenshots.front;
    const n = set.files.length;
    if (n === 0) return fail(`there are no screenshots (looked for ${set.from})`, "Run the app on the emulated BUSY Bar and take one: busy-emulator screenshot. The first one is the app's cover in the catalog.");
    if (n > LIMITS.screenshots[1]) return fail(`${n} screenshots (${set.from}); the catalog takes ${LIMITS.screenshots.join(" to ")}`, `Name up to ${LIMITS.screenshots[1]} of them in "screenshots" of ${DETAILS_FILE}, the cover first.`);
    return pass(`${n} from ${set.from}; the cover is ${set.files[0].path}`);
  },
  back_screenshots_count: (f) => {
    const n = f.screenshots.back.files.length;
    if (n > LIMITS.backScreenshots[1]) return fail(`${n} back screenshots; the catalog takes at most ${LIMITS.backScreenshots[1]}`, `Name up to ${LIMITS.backScreenshots[1]} of them in "back_screenshots" of ${DETAILS_FILE}.`);
    return pass(n ? `${n} from ${f.screenshots.back.from}` : "none: they are optional");
  },
  screenshot_png: (f) => picturesFirst(f, "front"),
  back_screenshot_png: (f) => picturesFirst(f, "back"),
  screenshot_final: (f) => picturesFinal(f, "front"),
  back_screenshot_final: (f) => picturesFinal(f, "back"),
  source_archive_size: (f) => {
    if (!f.source.counted) return unchecked("the project has too many files to add up here", "Make sure the committed files are under 100 MiB together.");
    if (f.source.bytes > LIMITS.sourceBytes) return unchecked(`the project's files, without node_modules, dist and .git, are ${mib(f.source.bytes)}; whether all of that is committed is not known here`, `Keep the committed files of the app's folder under ${mib(LIMITS.sourceBytes)}.`);
    return pass(`${mib(f.source.bytes)} without node_modules, dist and .git; the limit is ${mib(LIMITS.sourceBytes)}`);
  },
  build_lockfile: (f) => {
    const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][A-Za-z0-9.-]+)?$/;
    if (!f.locks.npm && !f.locks.pnpm) return fail("the project has no package-lock.json and no pnpm-lock.yaml: the catalog builds with the versions a lock file pins", "Run busy-emulator build (it installs the dependencies and writes package-lock.json), then commit package-lock.json.");
    // The catalog sees the lock files of the commit: one that git does not keep is not there for it.
    const loose = { npm: f.locks.npm && notKept(f.locks.npmGit), pnpm: f.locks.pnpm && notKept(f.locks.pnpmGit) };
    const npm = f.locks.npm && !loose.npm;
    const pnpm = f.locks.pnpm && !loose.pnpm;
    if (npm && pnpm) return fail("the project has both package-lock.json and pnpm-lock.yaml", "Keep the one of the package manager you use and delete the other.");
    if (!npm && !pnpm) {
      const names = [loose.npm && "package-lock.json", loose.pnpm && "pnpm-lock.yaml"].filter(Boolean);
      if (names.length === 2) return fail("package-lock.json and pnpm-lock.yaml are both in the folder and neither is added to git: the catalog finds no lock file in the commit", "Keep the one of the package manager you use, delete the other, then git add it, commit and push.");
      return fail(`${notKeptText(names[0], names[0] === "package-lock.json" ? f.locks.npmGit : f.locks.pnpmGit)}: the catalog finds no lock file`, ADD_IT(names[0]));
    }
    const aside = loose.npm ? "package-lock.json" : loose.pnpm ? "pnpm-lock.yaml" : null;
    const unseen = aside ? `; ${aside} is in the folder too, but not in git, so the catalog does not see it (delete it, or keep it out of the commit)` : "";
    if (npm) {
      const version = f.locks.npmJson.json?.packages?.["node_modules/@busy-app/cli"]?.version;
      if (typeof version !== "string" || !VERSION.test(version)) return fail("package-lock.json does not pin @busy-app/cli", "Delete package-lock.json, run busy-emulator build, and commit the new one.");
      return pass(`package-lock.json pins @busy-app/cli ${version}; it must be committed${unseen}`);
    }
    const manager = f.packageJson.json?.packageManager;
    if (typeof manager !== "string" || !manager.startsWith("pnpm@") || !VERSION.test(manager.slice(5))) return fail("package.json does not pin the pnpm version", 'Add "packageManager": "pnpm@<version>" to package.json.');
    // The importer "." of pnpm-lock.yaml, read by its lines: the version under '@busy-app/cli'.
    const importer = /^importers:\n(?:.*\n)*? {2}\.:\n((?: {4}.*\n|\n)*)/m.exec(`${f.locks.pnpmText ?? ""}\n`)?.[1] ?? "";
    const versions = [...importer.matchAll(/^ {6}'?@busy-app\/cli'?:\n(?: {8}.*\n)*? {8}version: ['"]?([^\s'"(]+)/gm)].map((m) => m[1]);
    if (versions.length === 1 && VERSION.test(versions[0])) return pass(`pnpm-lock.yaml pins @busy-app/cli ${versions[0]}, package.json pins ${manager}; both must be committed${unseen}`);
    return unchecked("pnpm-lock.yaml is not read fully here: whether it pins one @busy-app/cli version is not known", "Look for @busy-app/cli under importers in pnpm-lock.yaml: it must have one version.");
  },
  build: (f) => {
    // The catalog's own rule lets an id be 63 characters long; busy-cli, which the catalog builds with, and the bar
    // take 32, so a longer id passes the catalog's id check and fails its build.
    if (typeof f.id === "string" && !idProblem(f.id) && f.id.length > LIMITS.buildIdLength) return fail(`the id ${f.id} is ${f.id.length} characters long: the catalog's rule for an id allows ${LIMITS.idLength}, but busy-cli builds an id of at most ${LIMITS.buildIdLength} (the BUSY Bar's own limit), so the catalog's build of the app fails`, `Shorten "id" in ${f.manifest.relative} to ${LIMITS.buildIdLength} characters or fewer.`);
    if (!f.pkg) return NOT_BUILT(f);
    return unchecked(`the catalog builds the app itself from the commit, in a container without network: ${f.locks.pnpm && !f.locks.npm ? "pnpm install --frozen-lockfile" : "npm ci"} without install scripts, then busy-cli build. Here busy-cli built it on this computer`, "If the project needs an install script, the network or a build script of its own (npm run build) to build, it will not build there: the catalog runs busy-cli build and nothing else.");
  },
  script_main: (f) => {
    const { entries, answer } = entriesOr(f);
    if (answer) return answer;
    const main = entryAt(f.pkg, f.id, "scripts/main.js");
    if (!main || main.kind !== "file") return fail("the built package has no scripts/main.js", "The entry point is src/main.ts or src/main.js; build again: busy-emulator build.");
    if (main.size > LIMITS.javascriptBytes) return waiting(`scripts/main.js is ${main.size} bytes, more than the BUSY Bar loads (see javascript_size)`);
    return pass(`${main.size} bytes of ${LIMITS.javascriptBytes}; ${entries.length} entries in the package`);
  },
  script_imports: (f) => {
    const { answer } = entriesOr(f);
    if (answer) return answer;
    if (f.imports === null || f.imports.failed) return unchecked(`the scripts could not be parsed here${f.imports?.failed ? `: ${f.imports.failed}` : ""}`);
    const names = Object.keys(f.imports.modules);
    if (!names.length) return waiting("the package has no scripts (see main_missing)");
    const prefix = `${f.id}/scripts/`;
    const problems = [];
    for (const name of names) {
      const module = f.imports.modules[name];
      if (module.error) problems.push(`${name.slice(prefix.length)} does not parse: ${module.error}`);
      else {
        for (const specifier of module.imports) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
          if (!/^\.\.?\//.test(specifier) || !target.startsWith(prefix) || !Object.hasOwn(f.imports.modules, target)) problems.push(`${name.slice(prefix.length)} imports ${JSON.stringify(specifier)}, which is not a script of the package`);
        }
      }
    }
    if (problems.length) return fail(list(problems, 3), "A script may import only other scripts of the package, by a relative path (./x.js). Fix the source and build again.");
    return pass(`${names.length} script(s) parse and import only each other`);
  },
  icon_png: (f) => {
    const present = Object.entries(f.icons).filter(([, icon]) => icon);
    if (!present.length) return pass("no icons: they are optional");
    if (!f.png) return NO_PNG;
    const results = present.map(([side, icon]) => ({ side, ...picture(f, icon, side === "front" ? "icon_front" : "icon_back") }));
    const bad = results.filter((r) => !r.ok);
    if (bad.length) return fail(list(bad.map((r) => r.text), 2), "The front icon is a PNG of exactly 8×8 pixels, the back icon 11×11, 8 bits a channel, at most 64 KiB.");
    const unsure = results.map((r) => r.unsure).filter(Boolean);
    if (unsure.length) return unchecked(list(unsure, 2), "Save the icon again as a plain 8-bit PNG without extra chunks.");
    return pass(list(present.map(([, icon]) => icon.path)));
  },
  icon_missing: (f) => (f.icons.front ? pass(f.icons.front.path) : fail("the app has no front icon; the catalog shows a default one", `Run busy-emulator icon --text AB (one or two letters) or busy-emulator icon --from picture.png: it makes ${f.manifest.folderRelative}/icon_front_8x8.png (8×8) and the back icon (11×11). The catalog takes the app as it is.`)),

  // ------------------------------------------------------------ the package
  package_missing: (f) => (f.pkg ? pass(`${path.basename(f.pkg.file)}${f.stale ? "; files in src/ are newer than it" : ""}`) : NOT_BUILT(f)),
  invalid_id: idCheck,
  package_size: (f) => {
    if (!f.pkg) return NOT_BUILT(f);
    if (f.pkg.kind === "folder") return unchecked("the build is a folder (--emit dir), not an archive", "Its size unpacked is checked (unpacked_size); an archive is never larger.");
    if (f.pkg.bytes > LIMITS.packageBytes) return fail(`the package is ${mib(f.pkg.bytes)}; the limit is ${mib(LIMITS.packageBytes)}`, "Take large files out of src/.");
    return pass(`${f.pkg.bytes} bytes; the limit is ${mib(LIMITS.packageBytes)}`);
  },
  unpacked_size: (f) => {
    if (!f.pkg) return NOT_BUILT(f);
    if (f.pkg.tooLarge) return fail(`the package unpacks to more than ${mib(LIMITS.unpackedBytes)}`, "Take large files out of src/.");
    if (f.pkg.unreadable) return entriesOr(f).answer;
    const total = f.pkg.entries.reduce((sum, entry) => sum + entry.size, 0);
    if (total > LIMITS.unpackedBytes) return fail(`the package's files are ${mib(total)} together; the limit is ${mib(LIMITS.unpackedBytes)}`, "Take large files out of src/.");
    return pass(`${total} bytes unpacked; the limit is ${mib(LIMITS.unpackedBytes)}`);
  },
  archive_entries: (f) => {
    const { entries, answer } = entriesOr(f);
    if (answer) return answer;
    return entries.length > LIMITS.entries ? fail(`the package has ${entries.length} files and folders; the limit is ${LIMITS.entries}`, "Take files out of src/.") : pass(`${entries.length} files and folders`);
  },
  archive_invalid: (f) => {
    if (!f.pkg) return NOT_BUILT(f);
    if (f.pkg.unreadable) return fail(`${path.basename(f.pkg.file)} cannot be read as a .tgz: ${f.pkg.unreadable}`, "Build again: busy-emulator build.");
    if (f.pkg.tooLarge) return entriesOr(f).answer;
    return pass(f.pkg.kind === "folder" ? "the build is a folder; the catalog packs it itself" : null);
  },
  tar_format: (f) => {
    const { entries, answer } = entriesOr(f);
    if (answer) return answer;
    const long = entries.filter((entry) => !fitsPlainTar(partsOf(entry.name).join("/"), entry.kind === "folder"));
    if (long.length) return fail(`${list(long.map((entry) => entry.name), 2)}: too long for a plain tar header (100 bytes of name after 155 of folders)`, "Shorten the file's name or its folders in src/.");
    return pass("the catalog packs the build itself as a plain tar; every path fits one");
  },
  package_path: (f) => {
    const { entries, answer } = entriesOr(f);
    if (answer) return answer;
    const outside = entries.filter((entry) => {
      const parts = partsOf(entry.name);
      return parts[0] !== f.id || parts.includes("..") || entry.name.includes("\\");
    });
    if (outside.length) return fail(`${list(outside.map((entry) => entry.name), 3)}: not under ${f.id}/`, "Build with the project's busy-cli: busy-emulator build.");
    return pass(f.pkg.appleDouble.length ? `left out of the count: ${f.pkg.appleDouble.length} "._" file(s) of macOS, which the catalog's own build does not make` : null);
  },
  duplicate_path: (f) => {
    const { entries, answer } = entriesOr(f);
    if (answer) return answer;
    const seen = new Set();
    const twice = entries.filter((entry) => seen.size === seen.add(partsOf(entry.name).join("/")).size);
    return twice.length ? fail(`${list(twice.map((entry) => entry.name), 3)}: in the package more than once`, "Build again: busy-emulator build.") : pass();
  },
  archive_entry: (f) => {
    const { entries, answer } = entriesOr(f);
    if (answer) return answer;
    const other = entries.filter((entry) => entry.kind === "other");
    return other.length ? fail(list(other.map((entry) => `${entry.name} is ${entry.label}`), 3), "A package holds only files and folders: replace the link with the file itself.") : pass();
  },
  javascript_size: (f) => {
    const { entries, answer } = entriesOr(f);
    if (answer) return answer;
    const large = entries.filter((entry) => entry.kind === "file" && entry.name.endsWith(".js") && entry.size > LIMITS.javascriptBytes);
    return large.length ? fail(list(large.map((entry) => `${entry.name} is ${entry.size} bytes`), 3) + `; the BUSY Bar loads at most ${LIMITS.javascriptBytes}`, "Split the script into modules, or take data out of the code.") : pass();
  },
  main_missing: (f) => {
    const { answer } = entriesOr(f);
    if (answer) return answer;
    return entryAt(f.pkg, f.id, "scripts/main.js")?.kind === "file" ? pass() : fail("the built package has no scripts/main.js", "The entry point is src/main.ts or src/main.js; build again: busy-emulator build.");
  },
  manifest_missing: (f) => {
    const { answer } = entriesOr(f);
    if (answer) return answer;
    return f.built ? pass() : fail("the built package has no appmeta/manifest.json", `Keep the manifest at ${f.manifest.relative} and build again.`);
  },
  manifest_size: (f) => {
    const bytes = f.built?.bytes ?? null;
    if (bytes === null) return f.pkg ? waiting("the built package has no appmeta/manifest.json (see manifest_missing)") : NOT_BUILT(f);
    if (bytes.length > LIMITS.manifestBytes) return fail(`appmeta/manifest.json is ${bytes.length} bytes; the limit is ${LIMITS.manifestBytes}`, `Shorten ${f.manifest.relative}: "description" and "author" there are not used by the catalog.`);
    return pass(`${bytes.length} bytes of ${LIMITS.manifestBytes}`);
  },
  manifest_json: (f) => {
    const source = f.built ?? (f.manifest.exists ? f.manifest : null);
    if (!source) return f.pkg ? waiting("the built package has no appmeta/manifest.json (see manifest_missing)") : waiting(`the project has no ${f.manifest.relative}`);
    return isObject(source.json) ? pass() : fail(`${f.built ? "appmeta/manifest.json of the built package" : f.manifest.relative} is not a JSON object${source.error ? `: ${source.error}` : ""}`, `Fix ${f.manifest.relative}.`);
  },
  manifest_field: (f) => {
    const { json, from, answer } = manifestOr(f);
    if (answer) return answer;
    if (!isObject(json)) return waiting("the manifest is not a JSON object (see manifest_json)");
    const missing = MANIFEST_KEYS.filter((key) => !Object.hasOwn(json, key));
    return missing.length ? fail(`${from} has no ${missing.join(", ")}`, `Add ${missing.length > 1 ? "them" : "it"} to ${f.manifest.relative}.`) : pass(from);
  },
  manifest_format_version: (f) => {
    const { json, answer } = manifestOr(f);
    if (answer) return answer;
    return isObject(json) && json.format_version === 1 ? pass() : fail(`format_version is ${JSON.stringify(json?.format_version ?? null)}`, `Set "format_version": 1 in ${f.manifest.relative}.`);
  },
  manifest_id: (f) => {
    if (!f.built) return f.pkg ? waiting("the built package has no readable appmeta/manifest.json (see manifest_missing)") : NOT_BUILT(f);
    const built = isObject(f.built.json) ? f.built.json.id : undefined;
    return built === f.id ? pass(f.id) : fail(`the package was built with the id ${JSON.stringify(built ?? null)}, and ${f.manifest.relative} now says ${JSON.stringify(f.id)}`, "Build again: busy-emulator build.");
  },
  manifest_name: (f) => {
    const { json, answer } = manifestOr(f);
    if (answer) return answer;
    if (!isObject(json) || !Object.hasOwn(json, "name")) return waiting("the manifest has no name (see manifest_field)");
    const problem = nameProblem(json.name);
    return problem ? fail(`the name ${JSON.stringify(json.name)}: ${problem}`, `Set "name" in ${f.manifest.relative} to 1–${LIMITS.nameLength} characters: Latin letters, digits, single spaces between words and ! ? & ' ( ) + , - . / : # $ % @ _`) : pass(json.name);
  },
  manifest_version: (f) => {
    const { json, answer } = manifestOr(f);
    if (answer) return answer;
    if (!isObject(json)) return waiting("the manifest is not a JSON object (see manifest_json)");
    const bad = ["version", "api_version"].filter((key) => Object.hasOwn(json, key) && !versionNumbers(json[key]));
    return bad.length ? fail(bad.map((key) => `${key} is ${JSON.stringify(json[key])}`).join(", "), `Write three numbers, MAJOR.MINOR.PATCH, without leading zeros or suffixes (1.2.0) in ${f.manifest.relative}.`) : pass(`version ${json.version}, api_version ${json.api_version}`);
  },
  manifest_heap: (f) => {
    const { json, answer } = manifestOr(f);
    if (answer) return answer;
    const heap = isObject(json) ? json.heap_size_kib : undefined;
    if (heap === undefined || heap === null) return pass("not set: the BUSY Bar's default");
    return Number.isInteger(heap) && heap >= LIMITS.heapKib[0] && heap <= LIMITS.heapKib[1] ? pass(`${heap} KiB`) : fail(`heap_size_kib is ${JSON.stringify(heap)}`, `Set it to a whole number from ${LIMITS.heapKib.join(" to ")} in ${f.manifest.relative}, or take it out.`);
  },
  manifest_debug: (f) => {
    const { json, answer } = manifestOr(f);
    if (answer) return answer;
    return isObject(json) && json.debug === true ? fail('the manifest says "debug": true: such an app shows only on a BUSY Bar in developer mode', `Take "debug" out of ${f.manifest.relative}, or set it to false, and build again.`) : pass();
  },

  // ------------------------------------------------------------ the catalog's data
  version_not_newer: () => unchecked("it compares the version with the one published in the catalog, which is not asked from here", "A first publication passes. For an update, raise \"version\" above the published one."),
  source_repository_changed: () => unchecked("it compares the repository with the one the published app came from, which is not asked from here", "A first publication passes. An update comes from the repository the app was published from; the window's Send to catalog says which one that is."),
  firmware_too_old: (f) => {
    const { json, answer } = manifestOr(f);
    if (answer) return answer;
    const wanted = isObject(json) ? versionNumbers(json.api_version) : null;
    if (!wanted) return waiting("api_version is not three numbers (see manifest_version)");
    const has = f.firmware ? versionNumbers(f.firmware.api) : null;
    if (!has) return unchecked("this copy of the emulator does not know its firmware's API version");
    if (compareVersions(wanted, has) > 0) return fail(`api_version is ${json.api_version}; the released firmware in this emulator, ${f.firmware.name}, has API ${f.firmware.api}`, `Set "api_version" in ${f.manifest.relative} no higher than ${f.firmware.api}: the lowest API the app needs.`);
    return pass(`api_version ${json.api_version}; firmware ${f.firmware.name} has API ${f.firmware.api}`);
  },
};

// ---------------------------------------------------------------- the run

/** The catalog's own titles and texts by check id, where this copy has them; null otherwise. */
export function loadRegistry(file = REGISTRY_FILE) {
  if (!existsSync(file)) return null;
  try {
    const registry = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(registry.checks) ? registry : null;
  } catch {
    return null;
  }
}

/** The PNG checker of this copy, or null: { check(bytes, kind) }. */
export async function loadPngChecker(file = PNG_CHECKER_FILE) {
  if (!existsSync(file)) return null;
  const { checkCatalogPng } = await import(pathToFileURL(file).href);
  return { check: checkCatalogPng };
}

async function scriptImports(facts, node, env) {
  const { pkg, id } = facts;
  if (!pkg || pkg.unreadable || pkg.tooLarge) return null;
  const prefix = `${id}/scripts/`;
  const modules = {};
  for (const entry of pkg.entries) {
    const name = partsOf(entry.name).join("/");
    if (entry.kind === "file" && name.startsWith(prefix) && name.endsWith(".js") && entry.size <= LIMITS.javascriptBytes) modules[name] = entry.read().toString("utf8");
  }
  if (!Object.keys(modules).length) return { modules: {} };
  if (!node) return { failed: "this copy has no Node to parse them with" };
  try {
    return { modules: await probeImports(node, modules, env) };
  } catch (e) {
    return { failed: e.message };
  }
}

/**
 * Runs every check of the catalog on the project in `dir`.
 * @param {object} o
 * @param {string} o.dir                     the project's folder, by its real path
 * @param {{ name: string, api: string }|null} [o.firmware]  the released firmware of this emulator
 * @param {string|null} [o.node]             the full path of a Node to parse the scripts with
 * @param {Record<string, string|undefined>} [o.env]
 * @param {object|null} [o.registry]         loadRegistry()
 * @param {object|null} [o.png]              loadPngChecker()
 */
export async function checkProject({ dir, firmware = null, node = null, env = {}, registry = loadRegistry(), png = null }) {
  const facts = gatherFacts(dir, { firmware });
  facts.png = png;
  facts.imports = await scriptImports(facts, node, env);
  const texts = new Map((registry?.checks ?? []).map((check) => [check.id, check]));
  const checks = CHECKS.map((check) => {
    const answer = check.outside ? unchecked(check.outside.why) : DECIDERS[check.id](facts);
    const catalog = texts.get(check.id);
    return {
      id: check.id,
      stage: check.stage,
      title: catalog?.title ?? check.title,
      blocking: check.blocking,
      applies: check.outside ? check.outside.applies : true,
      status: answer.status,
      found: answer.found,
      change: answer.change,
      why: answer.why,
      // An unchecked one that only waits for a failure above it, the build, or the author's texts.
      waits: answer.waits === true,
      catalog: catalog ? { problem: catalog.problem, fix: catalog.fix } : null,
    };
  });
  const count = (test) => checks.filter(test).length;
  const counts = {
    total: checks.length,
    fail: count((c) => c.status === "fail" && c.blocking),
    warning: count((c) => c.status === "fail" && !c.blocking),
    unchecked: count((c) => c.status === "unchecked" && c.applies),
    not_applicable: count((c) => c.status === "unchecked" && !c.applies),
    pass: count((c) => c.status === "pass"),
  };
  return {
    folder: dir,
    id: facts.id,
    result: counts.fail ? "fail" : "pass",
    built: Boolean(facts.pkg),
    package: facts.pkg ? { file: facts.pkg.file, kind: facts.pkg.kind, bytes: facts.pkg.bytes, older_than_source: facts.stale } : null,
    counts,
    rules: { commit: registry?.source?.commit ?? RULES_COMMIT, date: (registry?.source?.committed_at ?? RULES_DATE).slice(0, 10), catalog_texts: Boolean(registry) },
    firmware: firmware ? { name: firmware.name, api: firmware.api } : null,
    checks,
    facts,
  };
}

// ---------------------------------------------------------------- the report

const indent = (text, by = "      ") => text.split("\n").map((line) => by + line).join("\n");

/** The report for a person: what fails, the warnings, what cannot be checked here, how many pass. */
export function reportText(result) {
  const { checks, counts } = result;
  const lines = [`Catalog checks for ${result.id ?? "the app"} in ${result.folder}`, `(the catalog's rules of ${result.rules.date}${result.firmware ? `; firmware ${result.firmware.name}, API ${result.firmware.api}` : ""})`];
  if (!result.rules.catalog_texts) lines.push("This copy of the emulator has no copy of the catalog's own texts: the checks are named in the emulator's words.");
  if (!result.built) lines.push("", `The project is not built: the checks of the package wait for it. Run busy-emulator build, then check again.`);
  else if (result.package.older_than_source) lines.push("", "Files in src/ are newer than the built package: run busy-emulator build, then check again.");
  const entry = (c) => {
    const out = [`  ${c.id}: ${c.title}`];
    if (c.status === "fail") {
      if (c.catalog) out.push(indent(`The catalog: ${c.catalog.problem}`));
      if (c.found) out.push(indent(`Here: ${c.found}`));
      if (c.change) out.push(indent(`Change: ${c.change}`));
    } else {
      out.push(indent(`Why: ${c.why}`));
      if (c.change) out.push(indent(`Then: ${c.change}`));
    }
    return out.join("\n");
  };
  const fails = checks.filter((c) => c.status === "fail" && c.blocking);
  const warnings = checks.filter((c) => c.status === "fail" && !c.blocking);
  const open = checks.filter((c) => c.status === "unchecked" && c.applies);
  if (fails.length) lines.push("", `${fails.length} ${fails.length === 1 ? "check fails" : "checks fail"}:`, ...fails.map(entry));
  if (warnings.length) lines.push("", `${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"} (the catalog takes the app with ${warnings.length === 1 ? "it" : "them"}):`, ...warnings.map(entry));
  const waits = open.filter((c) => c.waits);
  const outside = open.filter((c) => !c.waits);
  if (outside.length) lines.push("", `${outside.length} cannot be checked here:`, ...outside.map(entry));
  if (waits.length) lines.push("", `${waits.length} more wait for ${result.built ? "what fails above" : fails.length ? "the build and what fails above" : "the build"}: ${waits.map((c) => c.id).join(", ")}.`);
  if (counts.not_applicable) lines.push("", `${counts.not_applicable} more say nothing about an app being submitted (they report faults of the catalog's own run, or belong to removing an app).`);
  lines.push("", `${counts.pass} of ${counts.total} checks pass${counts.fail ? "" : "; none fails"}.`);
  return lines.join("\n");
}

/** The result without what only this process can use, for --json --full: every check. */
export function resultData(result) {
  const { facts: _facts, ...data } = result;
  return data;
}

/**
 * The result for --json as an agent reads it: the counts, and only the checks that need something — those that fail,
 * the warnings, and those that cannot be checked here — each with what was found and what to do. The whole list of 66
 * was one line of 27 KB, which an agent's tool cut (the field test, 11.11).
 */
export function compactData(result) {
  const { facts: _facts, checks, ...head } = result;
  const entry = (c) => ({ id: c.id, title: c.title, message: c.status === "fail" ? c.found : c.why, fix: c.change });
  const open = checks.filter((c) => c.status === "unchecked" && c.applies);
  return {
    ...head,
    notes: resultNotes(result),
    failing: checks.filter((c) => c.status === "fail" && c.blocking).map(entry),
    warnings: checks.filter((c) => c.status === "fail" && !c.blocking).map(entry),
    unchecked: open.filter((c) => !c.waits).map(entry),
    waiting: open.filter((c) => c.waits).map((c) => c.id),
    full: false,
  };
}

/**
 * What a result comes down to in plain lines, when it does: the one step left that only the person can take (the
 * source in a public GitHub repository), and a license nobody has chosen.
 */
export function resultNotes(result) {
  const failing = result.checks.filter((c) => c.status === "fail" && c.blocking);
  const notes = [];
  const origin = failing.find((c) => c.id === "source_origin");
  if (origin && failing.length === 1) notes.push(`Everything else passes. The one step left is the person's: the catalog builds the app from a public GitHub repository, and ${origin.found.replace(/: the catalog builds.*$/, "")}. ${origin.change} Then run busy-emulator submit.`);
  if (failing.some((c) => c.id === "license") && !result.facts?.licenses?.length) notes.push("The project has no license, and nothing here writes one: which license is the author's decision. Ask them; the fix of the check license lists the ones the catalog recognizes.");
  return notes;
}
