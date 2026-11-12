// How to use: the app's own controls, each a control of the bar and one short sentence, kept in the README as a
// section the catalog can read (the convention proposed to the catalog's team, 12.11):
//
//   ## How to use
//
//   - **Start**: Starts or pauses the timer
//   - **Wheel turn**: Sets the length
//
// The catalog's app page shows the same rows as cards, each with the control's chip (Figma KY2U9HxQyYWCmId6VvIVxw,
// node 1294:151024). The publishing flow's README step edits the rows (publish.js) and the window's Overview shows them;
// both load this file (served as /emulator/publish/how-to-use.mjs). It touches no file; the section is checked by the
// mirror of the catalog's Markdown rules (readiness/markdown.mjs).
//
//   read(readme)        → [{ control, text }]   the rows of the README's ## How to use section, [] when there is none
//   write(readme, rows) → readme                the section written in place (or added before the next section)
//   rowsOf(list)        → [{ control, text }]   the rows of the section's list alone
//   listOf(rows)        → list                  the section's list, as the README holds it
//   problem(rows)       → null | words          what keeps the rows from being published
import { markdownProblem } from "../readiness/markdown.mjs";

/** The bar's controls, by the names the catalog's chips show (docs.busy.app/bar/basics/controls). */
export const CONTROLS = Object.freeze(["Start", "Wheel turn", "Wheel press", "Back"]);
/** The section's heading. */
export const HEADING = "## How to use";
/** A row's sentence is short: it fits a card of the catalog's page. */
export const MAX_TEXT = 100;
export const MAX_ROWS = 8;

/** Other names a person or an older README gives a control. */
const ALIASES = Object.freeze({
  start: "Start",
  "start button": "Start",
  pause: "Start",
  "wheel turn": "Wheel turn",
  "wheel rotate": "Wheel turn",
  "wheel - rotate": "Wheel turn",
  "turn the wheel": "Wheel turn",
  "the wheel": "Wheel turn",
  wheel: "Wheel turn",
  "scroll wheel": "Wheel turn",
  "wheel press": "Wheel press",
  "wheel - press": "Wheel press",
  "press the wheel": "Wheel press",
  ok: "Wheel press",
  back: "Back",
  "back button": "Back",
});

/** The control a name stands for, or null. */
export function controlOf(name) {
  if (typeof name !== "string") return null;
  return ALIASES[name.trim().toLowerCase().replace(/\s+/g, " ")] ?? null;
}

const lines = (text) => (typeof text === "string" ? text.replace(/\r\n?/g, "\n").split("\n") : []);
const ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const NAMED = /^(?:\*\*([^*]+)\*\*|__([^_]+)__)\s*(?::|—|–|-)?\s*(.*)$/;
const PLAIN = /^([A-Za-z][A-Za-z -]{0,20}?)\s*(?::|—|–)\s*(.*)$/;
const LEAD = /^(turn the wheel|press the wheel|the wheel|wheel turn|wheel press|start|back|ok)\b[\s,]+(.*)$/i;

/** The rows of the section's list: an item a row; one without a known control keeps its text with control null. */
export function rowsOf(list) {
  const rows = [];
  for (const line of lines(list)) {
    const item = ITEM.exec(line);
    if (!item) {
      // A line that goes on the item before it.
      if (rows.length && line.trim() && /^\s/.test(line)) rows.at(-1).text = `${rows.at(-1).text} ${line.trim()}`.trim();
      continue;
    }
    const body = item[1].trim();
    const named = NAMED.exec(body);
    if (named) {
      const control = controlOf(named[1] ?? named[2]);
      rows.push(control ? { control, text: named[3].trim() } : { control: null, text: body });
      continue;
    }
    const plain = PLAIN.exec(body);
    const control = plain ? controlOf(plain[1]) : null;
    if (control) {
      rows.push({ control, text: plain[2].trim() });
      continue;
    }
    // A sentence that starts with its control, as older READMEs write them: "Start begins a session".
    const lead = LEAD.exec(body);
    const led = lead ? controlOf(lead[1]) : null;
    rows.push(led && lead[2].trim() ? { control: led, text: lead[2].trim().replace(/^./, (c) => c.toUpperCase()) } : { control: null, text: body });
  }
  return rows;
}

/** One line of the list; a row without its control yet keeps its words. */
function lineOf(row) {
  const text = String(row.text ?? "").replace(/\s*\n\s*/g, " ").trim();
  return row.control ? `- **${row.control}**: ${text}` : `- ${text}`;
}

/** The section's list, as the README holds it. */
export function listOf(rows) {
  return (Array.isArray(rows) ? rows : []).map(lineOf).join("\n");
}

/** Where the section is in the README's lines: { start, end } (end: the line after it), or null. */
function sectionAt(all) {
  const start = all.findIndex((line) => /^##\s+how to use\s*$/i.test(line.trim()));
  if (start < 0) return null;
  let end = start + 1;
  while (end < all.length && !/^#{1,2}\s/.test(all[end])) end++;
  return { start, end };
}

/** The rows of the README's ## How to use section; [] when there is none. */
export function read(readme) {
  const all = lines(readme);
  const at = sectionAt(all);
  return at ? rowsOf(all.slice(at.start + 1, at.end).join("\n")) : [];
}

/**
 * The README with its How to use section made of `rows`: in place of the one there, or else before the first section
 * after the opening (## …), or at the end. No rows take the section out.
 */
export function write(readme, rows) {
  const all = lines(readme);
  const list = Array.isArray(rows) && rows.length ? ["", HEADING, "", listOf(rows), ""] : [];
  const at = sectionAt(all);
  let out;
  if (at) {
    const before = all.slice(0, at.start);
    while (before.length && before.at(-1).trim() === "") before.pop();
    out = [...before, ...list, ...(list.length ? [] : [""]), ...all.slice(at.end)];
  } else {
    if (!list.length) return typeof readme === "string" ? readme : "";
    const next = all.findIndex((line, i) => i > 0 && /^##\s/.test(line));
    if (next < 0) {
      const body = [...all];
      while (body.length && body.at(-1).trim() === "") body.pop();
      out = [...body, ...list];
    } else {
      const before = all.slice(0, next);
      while (before.length && before.at(-1).trim() === "") before.pop();
      out = [...before, ...list, ...all.slice(next)];
    }
  }
  // Never more than one empty line in a row, as the section went in or out.
  const tidy = [];
  for (const line of out) if (!(line.trim() === "" && tidy.length && tidy.at(-1).trim() === "")) tidy.push(line);
  return tidy.join("\n");
}

/** What keeps the rows from being published, in a few words; null when nothing does. At least one row is needed. */
export function problem(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return "Add a control to How to use";
  if (list.length > MAX_ROWS) return `How to use: at most ${MAX_ROWS} controls`;
  for (const [i, row] of list.entries()) {
    if (!CONTROLS.includes(row.control)) return `How to use, row ${i + 1}: choose the control`;
    const text = String(row.text ?? "").trim();
    if (!text) return `How to use: write what ${row.control} does`;
    if ([...text].length > MAX_TEXT) return `How to use, ${row.control}: at most ${MAX_TEXT} characters`;
  }
  const found = markdownProblem(listOf(list)).problem;
  if (found) return `How to use: ${found.replace(/^line (\d+): /, (_, n) => `row ${n}, `)}`;
  return null;
}
