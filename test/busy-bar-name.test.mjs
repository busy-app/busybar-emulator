// The device is "BUSY Bar" in English text, never "the bar" alone (docs/quality.md, the section on texts): the
// documentation, the command line's help, the MCP server's tools, resources and instructions, and the section the
// emulator writes into a project's AGENTS.md.
//
// The test looks for an article or a word such as "its" or "emulated" right before "bar", outside `code` and link
// targets, so "progress bar", "status bar", "title bar", `bar_off` and `bar/<firmware>/ext` pass. Text that quotes
// someone else keeps their word: ALLOWED lists it.
//
//   node --test emulator/test/busy-bar-name.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadCommands } from "../packages/server/cli/busy-emulator.mjs";
import { INSTRUCTIONS } from "../packages/server/cli/mcp/server.mjs";
import { RESOURCES } from "../packages/server/cli/mcp/resources.mjs";
import { TOOLS } from "../packages/server/cli/mcp/tools.mjs";
import { agentsSection } from "../packages/server/projects/template-fixes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, ".."); // emulator/

const BARE = /\b(the|a|an|its|your|their|this|that|each|every|another|any|no|one|real|emulated|physical|connected)\s+bar('s|s)?\b(?![-/.]\w)/gi;
// Someone else's words, quoted as they are.
const ALLOWED = [
  "The screenshots are taken from the bar", // the catalog's author checklist
];

/** Every bare "the bar" of a text: [{ line, text }], lines from 1. */
export function bareBars(text) {
  const found = [];
  const lines = text.split("\n");
  // Joined, so that "the" at the end of a line and "bar" at the start of the next are found too.
  const plain = lines.map((line) => line.replace(/`[^`\n]*`|\]\([^)\n]*\)/g, (m) => " ".repeat(m.length))).join("\n");
  for (const m of plain.matchAll(BARE)) {
    const line = plain.slice(0, m.index).split("\n").length;
    const whole = lines.slice(line - 1, line + 1).join(" ");
    if (ALLOWED.some((one) => whole.includes(one))) continue;
    found.push({ line, text: m[0].replace(/\s+/g, " ") });
  }
  return found;
}

function* markdownUnder(path) {
  if (!existsSync(path)) return;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) if (name !== "node_modules") yield* markdownUnder(join(path, name));
  } else if (/\.(md|yml)$/.test(path)) yield path;
}

test("the check finds a bare bar, across a line break too, and passes BUSY Bar and the other bars", () => {
  assert.deepEqual(bareBars("Run it on the bar.\nThe emulated\nbar's clock."), [{ line: 1, text: "the bar" }, { line: 2, text: "emulated bar's" }]);
  assert.deepEqual(bareBars("On the BUSY Bar, the status bar, a progress bar, `the bar`, the title bar; `bar_off`, bar/1.3.1/ext."), []);
  assert.deepEqual(bareBars("- [ ] The screenshots are taken from the bar"), []);
});

test("the documents call the device BUSY Bar", () => {
  const places = [];
  const docs = ["public-docs", "README.public.md", "README.md", "CHANGELOG.md", ".github", "examples"].map((one) => join(root, one));
  for (const file of docs.flatMap((one) => [...markdownUnder(one)])) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel === "README.md" && existsSync(join(root, "README.public.md"))) continue; // the development repository's own
    for (const one of bareBars(readFileSync(file, "utf8"))) places.push(`${rel}:${one.line}: ${one.text}`);
  }
  assert.deepEqual(places, [], `Say "BUSY Bar" (docs/quality.md, texts):\n${places.join("\n")}`);
});

test("the command line's help, the MCP server's texts and the AGENTS.md section call the device BUSY Bar", async () => {
  const texts = [];
  for (const one of await loadCommands()) {
    texts.push([`command ${one.name}: summary`, one.summary ?? ""], [`command ${one.name}: details`, (one.details ?? []).join("\n")]);
  }
  for (const tool of TOOLS) {
    texts.push([`tool ${tool.name}`, [tool.title, tool.description, ...Object.values(tool.inputSchema.properties ?? {}).map((p) => p.description ?? "")].join("\n")]);
  }
  for (const one of RESOURCES) texts.push([`resource ${one.uri}`, [one.title, one.description, one.text()].join("\n")]);
  texts.push(["MCP instructions", INSTRUCTIONS], ["AGENTS.md section", agentsSection()]);
  const places = texts.flatMap(([where, text]) => bareBars(String(text)).map((one) => `${where}, line ${one.line}: ${one.text}`));
  assert.deepEqual(places, [], `Say "BUSY Bar" (docs/quality.md, texts):\n${places.join("\n")}`);
});
