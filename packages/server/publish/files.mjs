// The files of stage 1 of publishing (busy-emulator publish), written into the app's project: LICENSE, the README of
// the public repository, the lines of .gitignore that keep what is not the source out of it, the order of the
// screenshots in catalog.json, and the flow's own record, .busy/publish.json. Nothing is sent anywhere, and nothing
// the person wrote is written over: a README or a .gitignore of their own stays, and a screenshot taken out of the
// list goes to .busy/removed/, not away.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { insideFolder } from "../path-boundary.mjs";
import { DETAILS_FILE, SCREENSHOTS_FOLDER, sourceManifest } from "../readiness/facts.mjs";
import { LICENSE_FILE, recognizeLicense } from "../readiness/rules.mjs";
import { textsOf } from "../readiness/texts.mjs";
import { README_MARK, readmeConfig, readmeMarkdown, templateLeft } from "./readme.mjs";
import { ignoredBy, parseIgnore, projectTree } from "./tree.mjs";

export { README_MARK };

const here = path.dirname(fileURLToPath(import.meta.url));

/** The flow's own folder in the project: ignored by git, never published. */
export const OWN_FOLDER = ".busy";
export const PROGRESS_FILE = `${OWN_FOLDER}/publish.json`;

/**
 * The licenses the flow writes; "other": the person adds their own. `points` are what the license means, in a few plain
 * words each, for the cards of the window's License step.
 */
export const LICENSES = Object.freeze([
  {
    id: "MIT",
    name: "MIT",
    about: "Short and permissive: anyone may use the code, keeping your name in it.",
    points: ["Anyone can use, change and sell it", "They keep your name and this license in it", "No warranty: you are not liable"],
    recommended: true,
  },
  {
    id: "Apache-2.0",
    name: "Apache 2.0",
    about: "Permissive like MIT, with an explicit grant of patents.",
    points: ["Anyone can use, change and sell it", "They keep your name and say what they changed", "Patents of yours in it are licensed too", "No warranty: you are not liable"],
  },
  {
    id: "GPL-3.0",
    name: "GPL 3.0",
    about: "Copyleft: whoever shares a changed version shares its source too.",
    points: ["Anyone can use and change it", "Whoever shares a changed version shares its source, under GPL", "No warranty: you are not liable"],
    note: "The catalog's own check may not recognize it: a moderator reads it then.",
  },
]);

// ---------------------------------------------------------------- the record

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The flow's record of the project: what was chosen and done, and when. */
export function readProgress(dir) {
  const read = readJson(path.join(dir, ...PROGRESS_FILE.split("/")));
  return read && typeof read === "object" && !Array.isArray(read) ? read : {};
}

/**
 * Where the flow may write `rel` of the project: its real path, inside the project, links followed; else it throws
 * (code outside_project). Publishing needs no trust, so a project can hold a link where the flow writes (.busy, its
 * removed/, catalog.json, screenshots/, README.md, LICENSE, .gitignore) that leads elsewhere, as into
 * ~/Library/LaunchAgents: nothing is written or moved through one (security review of pull request 120).
 */
export function writable(dir, rel) {
  const real = insideFolder(dir, rel, { missing: true });
  if (real === null) throw Object.assign(new Error(`${rel} of the project leads out of its folder (a link), so the emulator writes nothing there`), { code: "outside_project", file: rel });
  return real;
}

/** Makes .busy/ with a .gitignore of its own that keeps all of it out of git. */
export function ownFolder(dir) {
  const folder = writable(dir, OWN_FOLDER);
  mkdirSync(folder, { recursive: true });
  const ignore = writable(dir, `${OWN_FOLDER}/.gitignore`);
  if (!existsSync(ignore)) writeFileSync(ignore, "# BUSY Bar Emulator's own files for this project: not part of it.\n*\n");
  return folder;
}

/** Notes a step of the flow as done, with what it gives (merged into the record). */
export function noteStep(dir, step, data, now = Date.now()) {
  ownFolder(dir);
  const progress = readProgress(dir);
  progress.format = 1;
  progress.steps = { ...(progress.steps ?? {}), [step]: { ...(data ?? {}), at: new Date(now).toISOString() } };
  writeFileSync(writable(dir, PROGRESS_FILE), `${JSON.stringify(progress, null, 2)}\n`);
  return progress;
}

// ---------------------------------------------------------------- the license

/** The license files of the project's folder, with the license each is. */
export function licenseFiles(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => LICENSE_FILE.test(name));
  } catch {
    // no folder
  }
  return names.sort().map((name) => {
    let text = null;
    try {
      text = readFileSync(path.join(dir, name), "utf8");
    } catch {
      // not a file
    }
    return { name, spdx: text === null ? null : recognizeLicense(text) };
  });
}

/** The name to put in a license when the person has not typed one: git's user.name, else the app's author. */
export function authorGuess(dir, home = os.homedir()) {
  const config = (() => {
    try {
      return readFileSync(path.join(home, ".gitconfig"), "utf8");
    } catch {
      return "";
    }
  })();
  const fromGit = /^\s*\[user\][^[]*?^\s*name\s*=\s*(.+?)\s*$/im.exec(config)?.[1]?.replace(/^"(.*)"$/, "$1");
  if (fromGit) return fromGit;
  const pkg = readJson(path.join(dir, "package.json"));
  const author = typeof pkg?.author === "string" ? pkg.author.replace(/\s*[<(].*$/, "") : pkg?.author?.name;
  return typeof author === "string" && author.trim() ? author.trim() : "";
}

/** A name or year as a license may hold it: one line, not empty, not too long. */
export function holderProblem(author) {
  if (typeof author !== "string" || !author.trim()) return "Write the name that holds the copyright: yours, or your organisation's.";
  if (/[\r\n\u0000-\u001f]/.test(author)) return "The name is one line.";
  if ([...author].length > 100) return "The name is at most 100 characters.";
  return null;
}

/** The text of a license with the person's name and the year. */
export function licenseText(id, author, year) {
  const known = LICENSES.find((one) => one.id === id);
  if (!known) throw new Error(`no license ${id}`);
  const text = readFileSync(path.join(here, "licenses", `${id}.txt`), "utf8");
  if (id === "MIT") return text.replace("Copyright (c) <year> <copyright holders>", `Copyright (c) ${year} ${author.trim()}`);
  return `Copyright (c) ${year} ${author.trim()}\n\n${text}`;
}

/** Writes LICENSE; refuses when the project has a license file already (it is the person's). */
export function writeLicense(dir, { id, author, year }) {
  const there = licenseFiles(dir);
  if (there.length) return { written: false, file: there[0].name, spdx: there[0].spdx };
  writeFileSync(writable(dir, "LICENSE"), licenseText(id, author, year), { flag: "wx" });
  return { written: true, file: "LICENSE", spdx: recognizeLicense(readFileSync(path.join(dir, "LICENSE"), "utf8")) };
}

/** The largest license text taken: the longest common licenses are some 35 KiB. */
const MAX_LICENSE_BYTES = 256 * 1024;

/**
 * The person's own license: the text of `from` copied in as LICENSE. A license file that is there is kept unless
 * `replace`; then it goes to .busy/removed/. Throws { code: "license_exists", file } or { code: "not_license" }.
 */
export function copyLicense(dir, from, { replace = false } = {}) {
  const refuse = (message) => Object.assign(new Error(message), { code: "not_license" });
  let bytes;
  try {
    const info = statSync(from);
    if (!info.isFile()) throw refuse(`${path.basename(from)} is not a file.`);
    if (info.size > MAX_LICENSE_BYTES) throw refuse(`${path.basename(from)} is larger than a license's text.`);
    bytes = readFileSync(from);
  } catch (e) {
    if (e?.code === "not_license") throw e;
    throw refuse(`${path.basename(from)} could not be read (${e?.code ?? e?.message ?? e}).`);
  }
  const text = bytes.toString("utf8");
  if (!text.trim() || bytes.includes(0) || text.includes("�")) throw refuse(`${path.basename(from)} is not a text file.`);
  const there = licenseFiles(dir);
  if (there.length && !replace) throw Object.assign(new Error("A license file is there."), { code: "license_exists", file: there[0].name });
  const replaced = [];
  if (there.length) {
    const away = path.join(ownFolder(dir), "removed");
    mkdirSync(away, { recursive: true });
    const stamp = Date.now();
    for (const one of there) {
      renameSync(path.join(dir, one.name), path.join(away, `${stamp}-${one.name}`));
      replaced.push(one.name);
    }
  }
  writeFileSync(path.join(dir, "LICENSE"), text.endsWith("\n") ? text : `${text}\n`);
  return { from: path.basename(from), replaced };
}

// ---------------------------------------------------------------- the screenshots

const SCALED = /@\d+x\.png$/i;

function listed(details, field) {
  return details && Array.isArray(details[field]) && details[field].every((item) => typeof item === "string") ? details[field] : null;
}

/** The largest screenshot the window is shown, as a data: address: a frame of the back display at 8x is far smaller. */
export const MAX_SHOWN_SCREENSHOT = 64 * 1024;
/** The largest screenshot read to check it: the catalog's own limit for a picture is far smaller. */
export const MAX_CHECKED_SCREENSHOT = 1024 * 1024;

/**
 * The bytes of a file of the project that catalog.json names, or why not: the project may be someone else's, and its
 * catalog.json names any path it likes. The path must be inside the project by its real path (path-boundary.mjs: no
 * "..", no absolute path, no link that leads out), a file, and at most `max` bytes; it is read only then.
 * @returns {{ bytes: Buffer } | { problem: string }}
 */
export function projectFile(dir, rel, max) {
  const file = insideFolder(dir, rel);
  if (file === null) return { problem: insideFolder(dir, rel, { missing: true }) === null ? "The path leaves the project's folder." : "The file is not there." };
  let size;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { problem: "It is not a file." };
    size = stat.size;
  } catch {
    return { problem: "The file is not there." };
  }
  if (size > max) return { problem: `The file is larger than ${Math.round(max / 1024)} KiB.` };
  try {
    const bytes = readFileSync(file);
    return bytes.length > max ? { problem: `The file is larger than ${Math.round(max / 1024)} KiB.` } : { bytes };
  } catch {
    return { problem: "The file cannot be read." };
  }
}

/** The screenshots in the order the catalog takes them: catalog.json's list, or screenshots/<display>-<n>.png. */
export function screenshotList(dir) {
  const details = readJson(path.join(dir, DETAILS_FILE));
  let names = [];
  try {
    names = readdirSync(path.join(dir, SCREENSHOTS_FOLDER));
  } catch {
    // no folder yet
  }
  const convention = (display) =>
    names
      .map((name) => ({ name, n: Number(new RegExp(`^${display}-(\\d+)\\.png$`).exec(name)?.[1] ?? NaN) }))
      .filter((entry) => Number.isInteger(entry.n))
      .sort((a, b) => a.n - b.n)
      .map((entry) => `${SCREENSHOTS_FOLDER}/${entry.name}`);
  const of = (field, display) => {
    const files = listed(details, field) ?? convention(display);
    return files.map((file) => {
      const scaled = names.find((name) => name.toLowerCase() === path.posix.basename(file).replace(/\.png$/i, "@8x.png").toLowerCase());
      return { path: file, scaled: scaled ? `${SCREENSHOTS_FOLDER}/${scaled}` : null };
    });
  };
  return { front: of("screenshots", "front"), back: of("back_screenshots", "back"), listed: Boolean(listed(details, "screenshots") || listed(details, "back_screenshots")) };
}

/** The bytes of a screenshot of the project as a data: address, for the window to show; null when it cannot. */
export function screenshotData(dir, rel) {
  const read = projectFile(dir, rel, MAX_SHOWN_SCREENSHOT);
  return read.bytes ? `data:image/png;base64,${read.bytes.toString("base64")}` : null;
}

/** Writes the order of both lists into catalog.json, keeping its other fields. */
export function writeScreenshotOrder(dir, { front, back }) {
  const file = writable(dir, DETAILS_FILE);
  const details = readJson(file) ?? { ...textsOf({}) };
  details.screenshots = front;
  details.back_screenshots = back;
  writeFileSync(file, `${JSON.stringify(details, null, 2)}\n`);
}

/** Takes a screenshot (and its enlarged copies) out of the list, into .busy/removed/. */
export function removeScreenshot(dir, rel) {
  const { front, back } = screenshotList(dir);
  const all = [...front, ...back];
  const entry = all.find((one) => one.path === rel);
  if (!entry) return false;
  ownFolder(dir);
  const away = writable(dir, `${OWN_FOLDER}/removed`);
  mkdirSync(away, { recursive: true });
  const stamp = Date.now();
  for (const one of [entry.path, entry.scaled].filter(Boolean)) {
    // Only a file inside the project moves: catalog.json may name any path.
    const from = insideFolder(dir, one);
    if (from !== null && statSync(from).isFile()) renameSync(from, writable(dir, `${OWN_FOLDER}/removed/${stamp}-${path.posix.basename(one)}`));
  }
  writeScreenshotOrder(dir, { front: front.filter((one) => one.path !== rel).map((one) => one.path), back: back.filter((one) => one.path !== rel).map((one) => one.path) });
  return true;
}

// ---------------------------------------------------------------- README and .gitignore

const TEMPLATE_README = /generated from the BUSY JS app template/;

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** The text of the project's README.md; null when there is none. */
export function readmeFile(dir) {
  try {
    return readFileSync(path.join(dir, "README.md"), "utf8");
  } catch {
    return null;
  }
}

/**
 * Whose the README is: none, the template's, the flow's (unchanged since the README step or Repository files wrote
 * it), or the person's.
 */
export function readmeState(dir, progress = readProgress(dir)) {
  const text = readmeFile(dir);
  if (text === null) return "none";
  const now = hash(text);
  if (progress.steps?.readme?.hash === now || (text.startsWith(README_MARK) && progress.steps?.files?.readme === now)) return "ours";
  if (TEMPLATE_README.test(text)) return "template";
  return "yours";
}

/** The settings of settings.json beside the app's manifest, for the README: [{ label, about, default }]. */
export function settingsList(dir) {
  const manifest = sourceManifest(dir);
  if (!manifest.folder) return [];
  const read = readJson(path.join(manifest.folder, "settings.json"));
  const fields = read && typeof read.fields === "object" && read.fields && !Array.isArray(read.fields) ? read.fields : null;
  if (!fields) return [];
  return Object.values(fields)
    .filter((one) => one && typeof one === "object" && typeof one.label === "string" && one.label.trim())
    .map((one) => {
      let shown = one.default;
      if (one.type === "enum" && Array.isArray(one.options)) shown = one.options.find((option) => option?.value === one.default)?.label ?? one.default;
      if (one.type === "boolean" || typeof shown === "boolean") shown = shown ? "on" : "off";
      return { label: one.label.trim(), about: typeof one.description === "string" ? one.description : "", default: shown === undefined || shown === null || typeof shown === "object" ? null : String(shown) };
    });
}

/**
 * What the README is made from: the app's name and id, the catalog texts, the screenshots, the settings and the
 * license. `texts` are catalog.json's; `name` the manifest's.
 */
export function readmeFacts(dir, { name, id, texts }) {
  return { name, id, texts, screenshots: screenshotList(dir), settings: settingsList(dir), license: licenseFiles(dir).find((one) => one.spdx)?.spdx ?? null };
}

/** The README step's configuration as kept in the record (or the default one), with what it is made from. */
export function readmeSaved(dir, facts, progress = readProgress(dir)) {
  return readmeConfig(progress.steps?.readme?.config ?? null, facts);
}

/** The README of the public repository: the README step's configuration, made with the project as it is now. */
export function readmeText(dir, facts, progress = readProgress(dir)) {
  return readmeMarkdown(readmeSaved(dir, facts, progress), facts);
}

/** Writes README.md from a configuration and notes it, so that it counts as the flow's until the person edits it. */
export function writeReadme(dir, config, facts, now = Date.now()) {
  const kept = readmeConfig(config, facts);
  const text = readmeMarkdown(kept, facts);
  writeFileSync(writable(dir, "README.md"), text);
  noteStep(dir, "readme", { config: kept, hash: hash(text) }, now);
  return { text, config: kept, left: templateLeft(text) };
}

/** What the public repository should not hold, each with a path that stands for it and why. */
export const KEEP_OUT = Object.freeze([
  { line: "node_modules/", sample: "node_modules", folder: true, why: "installed dependencies: npm ci brings them back" },
  { line: "dist/", sample: "dist", folder: true, why: "the built package: the catalog builds it itself" },
  { line: ".busy/", sample: ".busy", folder: true, why: "the emulator's own files for this project" },
  { line: "submission/", sample: "submission", folder: true, why: "the files for the catalog's pull request, not for the app's repository" },
  { line: ".DS_Store", sample: ".DS_Store", folder: false, why: "a file of macOS" },
  { line: "._*", sample: "._main.ts", folder: false, why: "files macOS makes on some disks" },
  { line: "Thumbs.db", sample: "Thumbs.db", folder: false, why: "a file of Windows" },
  { line: "desktop.ini", sample: "desktop.ini", folder: false, why: "a file of Windows" },
]);
const IGNORE_HEAD = "# Kept out of the public repository by BUSY Bar Emulator";

/** The lines .gitignore lacks of KEEP_OUT, and the person's own `more` paths that it does not keep out yet. */
export function missingIgnore(dir, more = []) {
  let text = "";
  try {
    text = readFileSync(path.join(dir, ".gitignore"), "utf8");
  } catch {
    // none yet
  }
  const rules = parseIgnore(text);
  const lines = KEEP_OUT.filter((one) => !ignoredBy(rules, one.sample, one.folder)).map((one) => one.line);
  for (const rel of more) if (!ignoredBy(rules, rel, false) && !ignoredBy(rules, rel, true)) lines.push(`/${rel.replace(/([*?[\]!#\\])/g, "\\$1")}`);
  return { text, lines };
}

/** Adds the missing lines to .gitignore, under a heading of their own, keeping every line that is there. */
export function writeIgnore(dir, more = []) {
  const { text, lines } = missingIgnore(dir, more);
  if (!lines.length) return [];
  const ours = text.includes(IGNORE_HEAD);
  const base = text && !text.endsWith("\n") ? `${text}\n` : text;
  writeFileSync(writable(dir, ".gitignore"), `${base}${base && !ours ? "\n" : ""}${[...(ours ? [] : [IGNORE_HEAD]), ...lines].join("\n")}\n`);
  return lines;
}

/** Why a file of the project goes into its repository, in a few words, for the list the window shows. */
export function reasonOf(rel) {
  if (rel === "README.md") return "the repository's front page";
  if (LICENSE_FILE.test(rel)) return "the license: the catalog takes only open source";
  if (rel === ".gitignore") return "what git keeps out";
  if (rel === DETAILS_FILE) return "the catalog texts";
  if (rel === "package.json" || rel === "package-lock.json" || rel === "pnpm-lock.yaml") return "what the catalog builds with";
  if (rel.startsWith(`${SCREENSHOTS_FOLDER}/`)) return SCALED.test(rel) ? "an enlarged screenshot, for the README" : "a screenshot: the catalog reads it from the repository";
  if (rel.startsWith("src/")) return "the app's source";
  if (rel.startsWith(".github/")) return "GitHub's own: the template's checks";
  return "part of the project";
}

/** What the repository would hold, with the lines .gitignore is about to get: the plan the window shows. */
export function filesPlan(dir, more = []) {
  const { text, lines } = missingIgnore(dir, more);
  return { lines, ...projectTree(dir, { replaceIgnore: [text, ...lines].join("\n") }) };
}
