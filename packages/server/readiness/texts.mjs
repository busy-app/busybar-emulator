// The four texts the catalog asks of an app's author (catalog.json: category, short_description, description,
// changelog), checked field by field by the same rules as check.mjs checks them (manifest_schema, category_public,
// category_alias, manifest_references, text_resolve, changelog_text, markdown). The command line's `catalog-texts`
// and the device window's form use this one file: it imports only rules.mjs and markdown.mjs, which touch no file,
// so the window loads it as it is (/emulator/readiness/texts.mjs).
import { markdownProblem } from "./markdown.mjs";
import { CATEGORIES, LIMITS } from "./rules.mjs";

/** The author's four texts, in the order the form shows them. */
export const TEXT_FIELDS = Object.freeze(["category", "short_description", "description", "changelog"]);

/** What the form needs to know: the categories and the lengths. */
export function textRules() {
  return {
    categories: CATEGORIES.map((c) => ({ id: c.id, name: c.name, about: c.about })),
    limits: { short_description: LIMITS.shortDescription, description: LIMITS.description, changelog: LIMITS.changelog },
  };
}

const length = (text) => [...text].length;

/**
 * The file a description names as `@<path>`, the one reference the catalog takes: { path, safe } (`safe`: the path stays
 * inside the app's folder: relative, forward slashes, no ".."), or null when the description is a text written in place.
 */
export function descriptionReference(value) {
  if (typeof value !== "string" || !value.startsWith("@")) return null;
  const file = value.slice(1);
  const safe = Boolean(file) && !file.includes("\\") && !file.startsWith("/") && !/^[A-Za-z]:/.test(file) && !file.split("/").includes("..");
  return { path: file, safe };
}

/**
 * What is wrong with each text: { category, short_description, description, changelog }, each null when the catalog
 * takes it, otherwise one sentence. `warnings` holds what the catalog takes and still mentions (a category's other
 * name). Texts that are not strings count as not written. A description may name a file of the app's folder,
 * `@README.md`, as the catalog allows; `files.description` is that file's text (null when the catalog would not read
 * it, `files.unread` then says why: facts.mjs descriptionFile), and the
 * length and Markdown are checked on it, as the catalog checks them. Without it (the window reads no file) only the
 * path is checked.
 */
export function textProblems(texts, files = {}) {
  const t = texts && typeof texts === "object" ? texts : {};
  const problems = {};
  const warnings = {};
  const written = (key) => typeof t[key] === "string" && t[key].trim() !== "";
  for (const key of TEXT_FIELDS) problems[key] = written(key) ? null : "Not written yet.";

  if (written("category")) {
    const category = CATEGORIES.find((c) => c.id === t.category || c.aliases.includes(t.category));
    if (!category) problems.category = "Not one of the catalog's categories.";
    else if (category.id !== t.category) warnings.category = `Another name of ${category.id}: write ${category.id}.`;
  }
  const lengthProblem = (text, [min, max], what) => {
    const n = length(text);
    return n < min ? `${n} characters: ${what} needs at least ${min}.` : n > max ? `${n} characters: the catalog takes at most ${max}.` : null;
  };
  if (written("short_description")) {
    if (/[\r\n]/.test(t.short_description)) problems.short_description = "One line, without line breaks.";
    else if (t.short_description.startsWith("@")) problems.short_description = "It may not start with @: the catalog reads that as a file.";
    else problems.short_description = lengthProblem(t.short_description, LIMITS.shortDescription, "the short description");
  }
  for (const [key, limits, what] of [
    ["description", LIMITS.description, "the description"],
    ["changelog", LIMITS.changelog, "the changelog"],
  ]) {
    if (!written(key)) continue;
    let text = t[key];
    const reference = key === "description" ? descriptionReference(text) : null;
    if (reference) {
      if (!reference.safe) {
        problems[key] = `${reference.path || "(no path)"} is not a file of the app's folder: name it from that folder, with forward slashes and without "..".`;
        continue;
      }
      if (files.description === undefined) continue;
      if (typeof files.description !== "string") {
        problems[key] = `${reference.path} ${files.unread ?? "is not in the project"}: the catalog would not read it. Name a UTF-8 Markdown file of the app's folder, or write the description itself.`;
        continue;
      }
      // The catalog reads the file with universal newlines: \r\n and a lone \r count as one \n.
      text = files.description.replace(/\r\n?/g, "\n");
    } else if (text.startsWith("@")) {
      problems[key] = "It may not start with @: the catalog takes a file only for the description.";
      continue;
    }
    problems[key] = reference && !text.trim() ? `${reference.path} is empty.` : lengthProblem(text, limits, reference ? `the description in ${reference.path}` : what);
    if (!problems[key]) {
      const found = markdownProblem(text).problem;
      if (found) problems[key] = `The catalog's Markdown refuses ${found}. It takes level 1 and 2 headings, bold, italic, lists and https links.`;
    }
  }
  return { ok: TEXT_FIELDS.every((key) => problems[key] === null), problems, warnings };
}

/** The texts of a catalog.json's object, as strings ("" for one that is not written or not a string). */
export function textsOf(details) {
  const d = details && typeof details === "object" && !Array.isArray(details) ? details : {};
  return Object.fromEntries(TEXT_FIELDS.map((key) => [key, typeof d[key] === "string" ? d[key] : ""]));
}
