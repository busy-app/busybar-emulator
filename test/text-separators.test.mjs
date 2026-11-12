// No centered dot as a separator anywhere a person reads (docs/quality.md, the section on texts): the window, the
// command line's messages and help, the server's messages, the app's menus, dialogs and pages, the documentation, the
// examples, the texts for agents. Between the parts of a line there is space, a comma, or in a real list a semicolon.
//
// The test reads every text file of what is the product and its documents and fails with file:line:column for each
// of the four marks. Files that are someone else's are left out: the firmware's builds and its local web, fonts and
// other binary files, installed dependencies, license texts, icon sets.
//
//   node --test emulator/test/text-separators.test.mjs
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, ".."); // emulator/

// The marks, by number, so that this file has none of them: the middle dot, the bullet, the bullet operator, the
// hyphenation point.
const MARKS = { 0xb7: "MIDDLE DOT", 0x2022: "BULLET", 0x2219: "BULLET OPERATOR", 0x2027: "HYPHENATION POINT" };
const ANY_MARK = new RegExp(`[${Object.keys(MARKS).map((code) => String.fromCodePoint(Number(code))).join("")}]`, "gu");

// What a person reads: folders are read whole, files as they are. One that is not in this tree is skipped: the
// public repository has no tools/ and no docs/, and its README.md is README.public.md here. Every README*.md at the
// top is read as well (below).
const READ = [
  "packages", // the server and its messages, the command line, the device window, the app's menus, dialogs and pages
  "public-docs",
  "examples",
  "test",
  "tools",
  "README.md",
  "README.public.md",
  "CHANGELOG.md",
  "ARCHITECTURE.md",
  "docs", // the product's documents: ADRs, the backlog, the reports, the requests, the texts for agents
];

// Someone else's files, and files that are not text. Paths relative to emulator/, with forward slashes.
const LEFT_OUT = [
  [/(^|\/)node_modules\//, "installed dependencies"],
  [/^packages\/engine\/build\//, "the firmware's builds, its local web and its assets"],
  [/^packages\/app\/tools\/notices\/(texts|app-texts)\//, "license texts, kept as their authors wrote them"],
  [/^packages\/app\/src\/icons\//, "an icon set"],
  [/^packages\/stage\/frame\/player\//, "the Tride player's files, kept unmodified as its license asks"],
  [/(^|\/)(LICENSE|THIRD_PARTY_NOTICES\.md)$/, "license texts"],
  [/(^|\/)\._[^/]*$|(^|\/)\.DS_Store$/, "the system's own files"],
  [/(^|\/)(\.data[^/]*|logs|dist|out)\//, "what a run leaves: data folders, logs, builds"],
];
const BINARY = new Set("wasm image anim font snd png jpg jpeg gif webp ico icns bmp pdf gz tgz zip tar bz2 xz zst 7z bin mp3 mp4 mov wav otf ttf woff woff2 glb fbx trd exe dll node".split(" "));
const isBinary = (rel) => BINARY.has(rel.slice(rel.lastIndexOf(".") + 1).toLowerCase());

/** Every place of a mark in a text: [{ line, column, mark }], lines and columns from 1. */
export function marksIn(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(ANY_MARK)) found.push({ line: i + 1, column: m.index + 1, mark: MARKS[m[0].codePointAt(0)], text: line.trim().slice(0, 120) });
  });
  return found;
}

function* filesUnder(path) {
  const rel = relative(root, path).split(sep).join("/");
  if (LEFT_OUT.some(([pattern]) => pattern.test(statSync(path).isDirectory() ? `${rel}/` : rel))) return;
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path).sort()) yield* filesUnder(join(path, name));
  } else if (!isBinary(rel)) yield { path, rel };
}

test("the check finds each of the four marks, with its line and column, and nothing in a clean text", () => {
  const dot = String.fromCodePoint(0xb7);
  const bullet = String.fromCodePoint(0x2022);
  assert.deepEqual(marksIn("Heap 5.6 of 128 KiB, peak 5.7\nFirmware 1.3.1   API 27.14.0\n1.5 x 2; a.b; 3 * 4 - 5"), []);
  assert.deepEqual(
    marksIn(`one\nHeap 5.6 ${dot} peak 5.7\n${bullet} item`).map(({ line, column, mark }) => [line, column, mark]),
    [[2, 10, "MIDDLE DOT"], [3, 1, "BULLET"]],
  );
  for (const code of Object.keys(MARKS)) assert.equal(marksIn(`a ${String.fromCodePoint(Number(code))} b`).length, 1, MARKS[code]);
});

test("no centered dot between the parts of a line, anywhere a person reads", () => {
  const found = [];
  let read = 0;
  const seen = new Set();
  const readmes = readdirSync(root).filter((name) => /^README.*\.md$/i.test(name) && !READ.includes(name));
  for (const name of [...READ, ...readmes]) {
    const path = join(root, ...name.split("/"));
    if (!existsSync(path)) continue;
    for (const file of filesUnder(path)) {
      const bytes = readFileSync(file.path);
      // A file that is not text in UTF-8 has no words to read.
      const text = bytes.toString("utf8");
      if (text.includes("�") && !Buffer.from(text, "utf8").equals(bytes)) continue;
      read++;
      seen.add(file.rel);
      for (const { line, column, mark, text: shown } of marksIn(text)) found.push(`${file.rel}:${line}:${column} ${mark}: ${shown}`);
    }
  }
  // The window, the command line and the documents are there: a wrong folder name would pass by reading nothing.
  assert.ok(read > 300, `text files read: ${read}`);
  for (const must of ["packages/server/legacy-window/index.html", "packages/server/cli/busy-emulator.mjs", "packages/app/src/menu.mjs", "public-docs/README.md", "README.md"]) {
    assert.ok(existsSync(join(root, ...must.split("/"))), `${must} is where the check reads`);
  }
  // The documents, where this tree has them (the public repository has no docs/).
  if (existsSync(join(root, "docs"))) for (const must of ["docs/quality.md", "docs/backlog/README.md", "docs/adr/README.md"]) assert.ok(seen.has(must), `${must} is read`);
  assert.deepEqual(found, [], `${found.length} place(s) with a centered dot as a separator; use space, a comma or a semicolon:\n${found.join("\n")}`);
});

// ---------------------------------------------------------------- American spelling (EMU-298)
//
// The product's English is American (docs/quality.md, the section on texts): license, color, gray, canceled. The words
// below are refused as whole words, in any letter case, and inside a name as its part (iconColour, LICENCE_NAMES);
// "workbench" is not the window's name. The internal documents (docs/, in Russian, quoting old texts) are not read,
// the texts for agents (docs/agents) are. What is someone else's stays as it is: the files left out below, and the
// phrases that quote a name or a string of another program.

// Spelled with a joiner so that this file is not a finding of its own.
const BRITISH = ["licen" + "ce", "licen" + "ces", "licen" + "ced", "colo" + "ur", "colo" + "urs", "colo" + "ured", "gr" + "ey", "gr" + "eys", "gr" + "eyed", "cancel" + "led", "cancel" + "ling", "work" + "bench", "behavio" + "ur", "behavio" + "urs", "recogni" + "se", "recogni" + "sed", "recogni" + "ses", "recogni" + "sing", "unrecogni" + "sed"];
const WORD = new RegExp(`(?<![a-z])(${BRITISH.join("|")})(?![a-z])`, "gi");
// The same words as the second part of a camelCase name: iconColour, recogniseLicense's sibling noteColour.
const PART = new RegExp(`(?<=[a-z0-9])(${BRITISH.map((w) => w[0].toUpperCase() + w.slice(1)).join("|")})(?![a-z])`, "g");
// The product's name in the documents: BUSY Bar Emulator, with a capital E. The server's first line of output, which
// tools parse, says "BUSY Bar emulator:" and is quoted as it is.
const NAME = /BUSY Bar emulator(?!:)/g;

/** Phrases that are someone else's words, each with why; taken out of a line before it is checked. */
const QUOTED = [
  [/Tride Players Licen[c]e/gi, "the name of the Tride player's license"],
  [/LICENSE, LICEN[C]E or COPYING/g, "the file names the catalog takes for a license"],
  [/license_unrecogni[s]ed/g, "the id of the catalog's own check"],
  [/notifications\/cancel[l]ed/g, "a notification of the MCP specification"],
  [/# cancel[l]ed \(/g, "the summary line of node:test"],
  [/end: "cancel[l]ed"/g, "the state Electron gives a stopped download"],
  [/"cancel[l]ed"/g, "the text the firmware rejects a reader's closed promise with (js_readable_stream.c)"],
  [/requests\/licen[c]es\.md|repository-and-licen[c]es/g, "the names of internal documents"],
  [/colo[u]r: "color"/g, "the guess for a type an author spells the British way"],
];
const NOT_READ = [
  [/^docs\/(?!agents\/)/, "the internal documents, in Russian, quoting old texts"],
  [/^packages\/server\/readiness\/catalog-registry\.json$/, "the catalog's own check registry, copied as it is"],
  [/^packages\/stage\/frame\/scene\//, "the bar's scene, which only the Tride agent changes"],
  [/^test\/state\//, "states recorded on a bar"],
  [/^test\/text-separators\.test\.mjs$/, "this file"],
];

/** Every British spelling in a text: [{ line, column, word }]; `markdown` also checks the product's name. */
export function britishIn(text, { markdown = false } = {}) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    let checked = line;
    for (const [phrase] of QUOTED) checked = checked.replace(phrase, (m) => " ".repeat(m.length));
    for (const pattern of markdown ? [WORD, PART, NAME] : [WORD, PART]) {
      for (const m of checked.matchAll(pattern)) found.push({ line: i + 1, column: m.index + 1, word: m[0], text: line.trim().slice(0, 120) });
    }
  });
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

test("the spelling check finds British words, inside names too, and leaves quoted names and American words", () => {
  const british = ["licen" + "ce", "Colo" + "ur", "gr" + "ey", "cancel" + "led", "work" + "bench"];
  assert.deepEqual(britishIn("The license, the color, gray, canceled; a colorful grayscale picture; licensed."), []);
  assert.deepEqual(
    britishIn(`One ${british[0]}\n${british[1]} and ${british[2].toUpperCase()}\nicon${british[1]} WEB_${british[0].toUpperCase()}S ${british[3]} the ${british[4]}`).map(({ line, column, word }) => [line, column, word]),
    [[1, 5, british[0]], [2, 1, british[1]], [2, 12, "GREY"], [3, 5, british[1]], [3, 16, `${british[0].toUpperCase()}S`], [3, 25, british[3]], [3, 39, british[4]]],
  );
  // Someone else's words stay.
  assert.deepEqual(britishIn(`the Tride Players ${"Licen" + "ce"} 1.2; LICENSE, ${"LICEN" + "CE"} or COPYING; license_unrecogni${"sed"}; notifications/${british[3]}`), []);
  // The product's name, in a document.
  assert.equal(britishIn("BUSY Bar emulator runs", { markdown: true }).length, 1);
  assert.equal(britishIn("first line: BUSY Bar emulator: http://127.0.0.1", { markdown: true }).length, 0);
  assert.equal(britishIn("BUSY Bar emulator runs").length, 0);
});

test("American spelling in everything a person reads", () => {
  const found = [];
  let read = 0;
  const readmes = readdirSync(root).filter((name) => /^README.*\.md$/i.test(name) && !READ.includes(name));
  for (const name of [...READ, ...readmes]) {
    const path = join(root, ...name.split("/"));
    if (!existsSync(path)) continue;
    for (const file of filesUnder(path)) {
      if (NOT_READ.some(([pattern]) => pattern.test(file.rel))) continue;
      const bytes = readFileSync(file.path);
      const text = bytes.toString("utf8");
      if (text.includes("�") && !Buffer.from(text, "utf8").equals(bytes)) continue;
      read++;
      for (const { line, column, word, text: shown } of britishIn(text, { markdown: file.rel.endsWith(".md") })) found.push(`${file.rel}:${line}:${column} ${word}: ${shown}`);
    }
  }
  assert.ok(read > 300, `text files read: ${read}`);
  assert.deepEqual(found, [], `${found.length} British spelling(s); write license, color, gray, canceled, behavior, recognize, "the window" and BUSY Bar Emulator:\n${found.join("\n")}`);
});
