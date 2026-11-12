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
 * What is wrong with each text: { category, short_description, description, changelog }, each null when the catalog
 * takes it, otherwise one sentence. `warnings` holds what the catalog takes and still mentions (a category's other
 * name). Texts that are not strings count as not written.
 */
export function textProblems(texts) {
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
  const lengthProblem = (key, [min, max], what) => {
    const n = length(t[key]);
    return n < min ? `${n} characters: ${what} needs at least ${min}.` : n > max ? `${n} characters: the catalog takes at most ${max}.` : null;
  };
  if (written("short_description")) {
    if (/[\r\n]/.test(t.short_description)) problems.short_description = "One line, without line breaks.";
    else if (t.short_description.startsWith("@")) problems.short_description = "It may not start with @: the catalog reads that as a file.";
    else problems.short_description = lengthProblem("short_description", LIMITS.shortDescription, "the short description");
  }
  for (const [key, limits, what] of [
    ["description", LIMITS.description, "the description"],
    ["changelog", LIMITS.changelog, "the changelog"],
  ]) {
    if (!written(key)) continue;
    if (t[key].startsWith("@")) {
      problems[key] = "It may not start with @: the catalog reads that as a file.";
      continue;
    }
    problems[key] = lengthProblem(key, limits, what);
    if (!problems[key]) {
      const found = markdownProblem(t[key]).problem;
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
