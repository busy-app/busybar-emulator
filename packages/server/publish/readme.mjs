// The README of an app's public repository, as the publishing flow's README step makes it (busy-emulator publish
// readme, and the device window's README step): from the catalog texts, the screenshots, the app's settings and its
// license, plus what only the author can write, how to use the app. Two ways to write it: a few fields, from which the
// Markdown is made, or the Markdown itself. The template's own README (its controls, its sections for developers) is
// never published unchanged: templateLeft() finds what is left of it.
//
// It touches no file and imports nothing, so that the window loads this same file to show the preview as it is typed
// (served as /emulator/publish/readme.mjs).

/** The first line of a README this flow made from the fields: a comment GitHub does not show. */
export const README_MARK = "<!-- Made by BUSY Bar Emulator from catalog.json. Edit it freely: once you change it, it is yours and is not made again. -->";

/** Text for an HTML attribute of the README: the app's name and the screenshots' paths come from the project (audit, 11.11). */
export const htmlText = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The two ways to write the README. */
export const README_MODES = Object.freeze(["fields", "markdown"]);

/** The longest text a field takes: the catalog's description is at most 4000 characters. */
export const README_LIMITS = Object.freeze({ title: 64, intro: 1000, usage: 2000, markdown: 16000 });

/**
 * What is left of the template's own README: one entry a part, in the words the window shows. The opening line, the
 * section about the device keys (the template's controls, not the app's) and the sections written for developers of
 * the template.
 */
const TEMPLATE_PARTS = Object.freeze([
  { id: "intro", what: "the template's opening line", find: /generated from the BUSY JS app template/i },
  { id: "controls", what: "the template's text about the keys", find: /listen\("input", handler\)|^## Input\s*$/m },
  { id: "sections", what: "the template's sections for developers", find: /^## (?:Layout|Resources|Commands|Build output|Releasing|Manifest)\s*$/m },
]);

/** The parts of the template's README that are still in `text`: [{ id, what }], empty when none is. */
export function templateLeft(text) {
  if (typeof text !== "string" || !text) return [];
  return TEMPLATE_PARTS.filter((part) => part.find.test(text)).map(({ id, what }) => ({ id, what }));
}

/** The first paragraph of a Markdown text that is prose: not a heading, a list, a picture or code. */
export function firstParagraph(text) {
  if (typeof text !== "string") return "";
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const one = block.trim();
    if (!one || /^(#|[-*+] |\d+\. |```|<|!\[|>)/.test(one)) continue;
    return one.replace(/\s*\n\s*/g, " ");
  }
  return "";
}

const clean = (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n") : "");

/**
 * The fields a new README starts from: the app's name, the first paragraph of the catalog's description (else its
 * short description), and nothing for how to use it, which only the author can write.
 * @param {{ name: string, texts: { short_description?: string, description?: string } }} facts
 */
export function defaultReadme(facts) {
  const texts = facts?.texts ?? {};
  return { mode: "fields", title: String(facts?.name ?? ""), intro: firstParagraph(texts.description) || clean(texts.short_description).trim(), usage: "", markdown: "" };
}

/** A configuration as it is kept: the known keys, as strings; anything else falls back to the default's. */
export function readmeConfig(saved, facts) {
  const base = defaultReadme(facts);
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  return {
    mode: README_MODES.includes(s.mode) ? s.mode : base.mode,
    title: typeof s.title === "string" ? s.title : base.title,
    intro: typeof s.intro === "string" ? s.intro : base.intro,
    usage: typeof s.usage === "string" ? s.usage : base.usage,
    markdown: typeof s.markdown === "string" ? s.markdown : base.markdown,
  };
}

/** One setting of settings.json as a line of the README: its label, what it does, and its default. */
function settingLine(one) {
  const shown = one.default === undefined || one.default === null || one.default === "" ? null : String(one.default);
  const words = [one.about ? one.about.trim().replace(/\s*\n\s*/g, " ") : null, shown ? `Default: ${shown}.` : null].filter(Boolean).join(" ");
  return `- **${one.label}**${words ? `: ${words}` : ""}`;
}

/**
 * The Markdown of the README. In "markdown" mode it is the author's text as it is. In "fields" mode: the title, the
 * paragraph, the screenshots (front, then back), How to use, the settings, how to build it, and the license.
 * @param {object} config  readmeConfig()
 * @param {{ name: string, id: string, screenshots: { front: object[], back: object[] }, license: string|null,
 *   settings: { label: string, about?: string, default?: unknown }[] }} facts
 */
export function readmeMarkdown(config, facts) {
  const c = readmeConfig(config, facts);
  if (c.mode === "markdown") return clean(c.markdown);
  const name = c.title.trim() || String(facts?.name ?? "");
  const lines = [README_MARK, "", `# ${name}`, ""];
  if (c.intro.trim()) lines.push(clean(c.intro).trim(), "");
  const front = facts?.screenshots?.front ?? [];
  const back = facts?.screenshots?.back ?? [];
  if (front.length || back.length) {
    for (const one of front) lines.push(`<img src="${htmlText(one.scaled ?? one.path)}" width="576" alt="${htmlText(name)}, the front display">`);
    for (const one of back) lines.push(`<img src="${htmlText(one.scaled ?? one.path)}" width="480" alt="${htmlText(name)}, the back display">`);
    lines.push("");
  }
  if (c.usage.trim()) lines.push("## How to use", "", clean(c.usage).trim(), "");
  const settings = Array.isArray(facts?.settings) ? facts.settings.filter((one) => one && typeof one.label === "string" && one.label.trim()) : [];
  if (settings.length) lines.push("## Settings", "", "Change them in the BUSY Bar's local web interface.", "", ...settings.map(settingLine), "");
  lines.push("## Build and install", "", "```sh", "npm ci", `npm run build         # dist/${facts?.id ?? "app"}.tgz`, "npm run app:install   # on a BUSY Bar connected over USB", "```", "", "Or open the folder in BUSY Bar Emulator and press Refresh.", "");
  if (facts?.license) lines.push("## License", "", `${facts.license}: see [LICENSE](LICENSE).`, "");
  lines.push("Made for [BUSY Bar](https://busy.app).", "");
  return lines.join("\n");
}

/**
 * Why the README is not ready to be written, in a few words; null when it is. Fields: a title, a line about the app
 * and how to use it. Markdown: some text, and nothing left of the template's.
 */
export function readmeProblem(config, facts) {
  const c = readmeConfig(config, facts);
  if (c.mode === "markdown") {
    if (!c.markdown.trim()) return "Write the README";
    if ([...c.markdown].length > README_LIMITS.markdown) return `At most ${README_LIMITS.markdown} characters`;
    const left = templateLeft(c.markdown);
    if (left.length) return `Take out ${left[0].what}`;
    return null;
  }
  if (!c.title.trim()) return "Write a title";
  if (/[\r\n]/.test(c.title)) return "The title is one line";
  if (!c.intro.trim()) return "Write what the app does";
  if (!c.usage.trim()) return "Write how to use it";
  for (const key of ["title", "intro", "usage"]) if ([...c[key]].length > README_LIMITS[key]) return `${key === "intro" ? "The description" : key === "usage" ? "How to use" : "The title"}: at most ${README_LIMITS[key]} characters`;
  const left = templateLeft(`${c.intro}\n${c.usage}`);
  if (left.length) return `Take out ${left[0].what}`;
  return null;
}
