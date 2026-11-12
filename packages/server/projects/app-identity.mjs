// The id and the name `create` gives a new app (the release dry run, 11.11). The template's generator
// (@busy-app/create-app 0.5.0, suggestId) makes the id from the folder's name and keeps a folder name only when every
// character of it is a Latin letter, a digit, "_" or "-": every other folder (one named in Cyrillic, Greek, or "Caf\u00e9") gives
// the same id, app.<author>.app, and the second such project overwrites the first on the bar (busy-tools issue 13).
// An author with such a letter gives app.example.<app> the same way.
//
// Here the id is made again from the same parts, the folder's name and the author, the generator's way
// (app.<author>.<folder>, lower-case, runs of spaces as "_"), with what it drops put into Latin letters instead:
// Cyrillic and Greek by a fixed table (ISO 9 and BGN alike: "Privet mir" in Cyrillic gives privet_mir), accented Latin
// letters without their marks ("Caf\u00e9" gives cafe); any other character (an emoji) is left out. The id keeps to the catalog's rule and to the
// 32 characters busy-cli and the bar take (readiness/rules.mjs). An id another project of the emulator or an app on the
// emulated bar has already gets _2, _3. The name is made from the id as the generator makes it ("privet_mir" →
// "Privet mir"), or a --name with letters the catalog does not take is put into Latin letters the same way.
//
// What the generator wrote is then rewritten, in the four files its template puts the id and the name in: the
// manifest, package.json (the description), README.md and AGENTS.md. A generator that gives the same id already
// (a later one with this fixed) leaves nothing to do.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { idProblem, LIMITS, nameProblem } from "../readiness/rules.mjs";
import { readProjects } from "./registry.mjs";

/** The longest id busy-cli builds and the bar installs. */
export const ID_MAX = LIMITS.buildIdLength;
/** The generator's namespace when the author gives none, and its first part. */
export const PLACEHOLDER = "example";
const PREFIX = "app";
/** An author's namespace that leaves the app's own part fewer characters than this gives way to the placeholder. */
const MIN_APP_PART = 8;

// Lower-case letters to Latin; an upper-case letter is its lower-case one's, with the first letter upper-case. The
// letters are given by their code points: the exported tree holds no Cyrillic (tools/export-check, rule "cyrillic").
const TABLE = new Map();
/** The letters from `first` on, one Latin spelling each. */
const letters = (first, spellings) => spellings.forEach((latinSpelling, i) => latinSpelling !== null && TABLE.set(String.fromCodePoint(first + i), latinSpelling));
// Russian, U+0430 to U+044F: a to ya.
letters(0x430, ["a", "b", "v", "g", "d", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p", "r", "s", "t", "u", "f", "kh", "ts", "ch", "sh", "shch", "", "y", "", "e", "yu", "ya"]);
// U+0450 to U+045F: yo and the letters of Ukrainian, Belarusian, Serbian and Macedonian.
letters(0x450, ["e", "e", "dj", "gj", "ye", "dz", "i", "yi", "j", "lj", "nj", "c", "kj", "i", "u", "dz"]);
// Ukrainian ghe with upturn; Kazakh.
letters(0x491, ["g", null, "g"]);
for (const [code, latinSpelling] of [[0x49b, "q"], [0x4a3, "n"], [0x4af, "u"], [0x4b1, "u"], [0x4bb, "h"], [0x4d9, "a"], [0x4e9, "o"]]) TABLE.set(String.fromCodePoint(code), latinSpelling);
// Greek, U+03B1 to U+03C9: alpha to omega, final sigma among them (the accents go with the other marks, below).
letters(0x3b1, ["a", "v", "g", "d", "e", "z", "i", "th", "i", "k", "l", "m", "n", "x", "o", "p", "r", "s", "s", "t", "y", "f", "ch", "ps", "o"]);
// Latin letters that are not a letter and a mark.
for (const [letter, latinSpelling] of Object.entries({ "\u00df": "ss", "\u00e6": "ae", "\u0153": "oe", "\u00f8": "o", "\u0142": "l", "\u0111": "d", "\u00f0": "d", "\u00fe": "th", "\u0131": "i" })) TABLE.set(letter, latinSpelling);
/** Greek omicron and upsilon, one sound: "ou" (BGN). */
const GREEK_OU = /\u03bf\u03c5/g;

/** One character in Latin letters: itself when ASCII, from the table, or without its marks; "" when none of these. */
function latinChar(char) {
  if (char.charCodeAt(0) < 0x80) return char;
  const lower = char.toLowerCase();
  let out = TABLE.get(lower);
  if (out === undefined) {
    const base = lower.normalize("NFD").replace(/\p{M}+/gu, "");
    out = [...base].map((c) => (c.charCodeAt(0) < 0x80 ? c : (TABLE.get(c) ?? ""))).join("");
  }
  return lower !== char && out ? out[0].toUpperCase() + out.slice(1) : out;
}

/** A text in Latin letters, case kept: "Moy Taymer" from the Cyrillic, "Cafe" from "Caf\u00e9"; an emoji goes. */
export function latin(text) {
  const given = String(text ?? "");
  const digraphs = given.replace(GREEK_OU, "ou").replace(new RegExp(GREEK_OU.source, "gi"), (pair) => (pair[1] === pair[1].toLowerCase() ? "Ou" : "OU"));
  return [...digraphs].map(latinChar).join("");
}

/** Whether a text has a character outside ASCII. */
export const hasNonAscii = (text) => /[^\x00-\x7f]/.test(String(text ?? ""));

/**
 * One part of an id from a text: Latin letters, lower-case, every run of spaces and dots as "_", any other character
 * an id may not have left out, no "_" or "-" at the ends.
 */
export function idPart(text) {
  return latin(text)
    .toLowerCase()
    .trim()
    .replace(/[\s.]+/g, "_")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
}

/** The end of a part cut to `length`, without a "_" or "-" left at its end. */
const cut = (part, length) => part.slice(0, Math.max(1, length)).replace(/[_-]+$/, "") || part.slice(0, 1);

/** A short mark of a text, for a folder name that gives no part of an id at all (an emoji). */
const markOf = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 4);

/**
 * The id the folder `folderName` of the author `author` gives: app.<author>.<folder>. A folder name that is a whole
 * id the catalog takes is that id (the generator's own rule). A folder name with no letter or digit left gives
 * app_<4 hex digits of its hash>; an author with none gives the placeholder.
 */
export function suggestId(folderName, author) {
  const whole = String(folderName ?? "").trim().toLowerCase();
  if (whole.includes(".") && whole.length <= ID_MAX && !idProblem(whole)) return whole;
  const app = idPart(folderName) || `${PREFIX}_${markOf(folderName)}`;
  const namespace = idPart(author);
  let prefix = `${PREFIX}.${namespace || PLACEHOLDER}.`;
  if (ID_MAX - prefix.length < Math.min(app.length, MIN_APP_PART)) prefix = `${PREFIX}.${PLACEHOLDER}.`;
  return prefix + cut(app, ID_MAX - prefix.length);
}

/** The generator's name from an id: "app.jane.my_app" → "My app". */
export function nameFromId(id) {
  const words = String(id).split(".").pop().replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A name the catalog takes, from a text it may not: in Latin letters, without the characters it does not take, single
 * spaces, at most 32 characters. Null when nothing is left.
 */
export function latinName(text) {
  const name = latin(text)
    .replace(/[^A-Za-z0-9 !?&'()+,\-./:#$%@_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const short = [...name].slice(0, LIMITS.nameLength).join("").trim();
  return short && !nameProblem(short) ? short : null;
}

/** The folders of the apps on the emulated bar, of every firmware's bar in the data folder: their ids. */
function idsOnTheBar(dataDir) {
  const ids = new Set();
  let bars = [];
  try {
    bars = readdirSync(path.join(dataDir, "bar"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return ids;
  }
  for (const bar of bars) {
    try {
      for (const entry of readdirSync(path.join(dataDir, "bar", bar.name, "ext", "user_assets"), { withFileTypes: true })) if (entry.isDirectory()) ids.add(entry.name);
    } catch {
      // A bar without apps.
    }
  }
  return ids;
}

/**
 * The ids taken already, by another project in the emulator's list of projects or an app on the emulated bar:
 * id → { by: "project", folder } or { by: "bar" }. The project in `except` (the one being made) is not another.
 */
export function takenIds(dataDir, except = null) {
  const taken = new Map();
  for (const id of idsOnTheBar(dataDir)) taken.set(id, { by: "bar" });
  for (const project of readProjects(dataDir)) {
    if (project.id && project.path !== except) taken.set(project.id, { by: "project", folder: project.path });
  }
  return taken;
}

/** `id`, or id_2, id_3… (cut to fit 32 characters) when it is taken; with what took the ones passed over. */
export function freeId(id, taken) {
  if (!taken.has(id)) return { id, passed: [] };
  const passed = [{ id, ...taken.get(id) }];
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const dot = id.lastIndexOf(".");
    const candidate = `${id.slice(0, dot + 1)}${cut(id.slice(dot + 1), ID_MAX - dot - 1 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return { id: candidate, passed };
    passed.push({ id: candidate, ...taken.get(candidate) });
  }
  return { id, passed };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/** A text file's text with `from` put as `to` everywhere, written back when it changed. */
function replaceIn(file, pairs) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  let out = text;
  for (const [from, to] of pairs) if (from && from !== to) out = out.split(from).join(to);
  if (out !== text) writeFileSync(file, out);
}

/**
 * Gives the project the generator just made in `dir` the id and the name chosen here, in every file its template put
 * them in. `given`: the options of create (id, name, description); a given id is kept as it is. `taken`: takenIds().
 * Null when the project has no manifest where the template keeps it (nothing to rewrite).
 * `latinFrom`: the texts put into Latin letters; `mark`: the folder's name had no letter or digit for an id, which
 * then ends in a mark of it; `passed`: the ids passed over as taken.
 * @returns {{ id: string, name: string, folder: string, latin: boolean, latinFrom: string[], mark: boolean, passed: object[], generator: { id: string, name: string }, rewritten: boolean } | null}
 */
export function settleIdentity(dir, { folderName, given = {}, taken = new Map() }) {
  const manifestFile = path.join(dir, "src", "appmeta", "manifest.json");
  const manifest = readJson(manifestFile);
  if (!manifest || typeof manifest.id !== "string") return null;
  const made = { id: manifest.id, name: typeof manifest.name === "string" ? manifest.name : "" };

  let id = made.id;
  let passed = [];
  if (given.id === undefined) {
    ({ id, passed } = freeId(suggestId(folderName, manifest.author ?? ""), taken));
  }
  let name = made.name;
  if (given.name === undefined) name = nameFromId(id);
  else if (nameProblem(given.name)) name = latinName(given.name) ?? nameFromId(id);
  // What was put into Latin letters: the folder's name the id comes from, a --name the catalog would not take.
  const fromFolder = given.id === undefined && hasNonAscii(folderName);
  const latinFrom = [...(fromFolder ? [folderName] : []), ...(given.name !== undefined && name !== given.name ? [given.name] : [])];
  const mark = given.id === undefined && !idPart(folderName) && !String(folderName ?? "").includes(".");
  const result = { id, name, folder: folderName, latin: latinFrom.length > 0, latinFrom, mark, passed, generator: made, rewritten: false };
  if (id === made.id && name === made.name) return result;

  // The description is the name where none was given (the generator's default).
  const description = given.description === undefined && manifest.description === made.name ? name : manifest.description;
  writeJson(manifestFile, { ...manifest, id, name, ...(description === undefined ? {} : { description }) });
  const pkgFile = path.join(dir, "package.json");
  const pkg = readJson(pkgFile);
  if (pkg && given.description === undefined && pkg.description === made.name) writeJson(pkgFile, { ...pkg, description: name });
  // README.md: "# <name>", then the description; the id in its commands. AGENTS.md: "`<name>` (`<id>`)".
  const readme = path.join(dir, "README.md");
  if (existsSync(readme)) {
    const lines = readFileSync(readme, "utf8").split("\n");
    if (lines[0] === `# ${made.name}`) lines[0] = `# ${name}`;
    if (given.description === undefined && lines[2] === made.name) lines[2] = name;
    writeFileSync(readme, lines.join("\n"));
  }
  replaceIn(readme, [[made.id, id]]);
  replaceIn(path.join(dir, "AGENTS.md"), [[`\`${made.name}\` (\`${made.id}\`)`, `\`${name}\` (\`${id}\`)`], [made.id, id]]);
  result.rewritten = true;
  return result;
}
