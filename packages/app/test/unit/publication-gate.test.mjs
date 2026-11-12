// The "may it be published" part of `npm run dist:check` (tools/packaging/check.mjs) refuses every file of the app
// that the export check reports, by its forbidden files and by every content rule (serial numbers, MAC and private
// addresses, places, private patterns, Cyrillic), with no exception applied. Found by the review of EMU-203 (H1):
// a gate that took only the forbidden list let through as publishable a file that only a content rule finds (then a
// bar's serial number in a file of the server).
//
// Since EMU-255 nothing the app holds is refused (the firmware's local web is public, its Cyrillic allowed by exact
// value and file), so the gate is also shown refusing what is planted into a copy of the app: a forbidden file, a
// bar's serial number in a file of the server, Cyrillic of another value in a bundle of the local web whose own
// Cyrillic is allowed, and Cyrillic in the license summary.
//
// Needs the monorepo (the export check) and, to see everything, its private patterns file. The files are copied to
// a temporary folder (TMPDIR) and removed after. No value is printed: only rule and file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { publicationFindings, useExportCheck } from "../../tools/packaging/check.mjs";
import { archiveEntries, EMULATOR_DIR, emulatorFiles } from "../../tools/packaging/composition.mjs";
import { markerBytes } from "../../tools/packaging/resources.mjs";
import { NOTICES_FILE, noticesText } from "../../tools/notices/notices.mjs";

const EXPORT_CHECK = path.join(EMULATOR_DIR, "tools", "export-check", "export-check.mjs");
const skip = !existsSync(EXPORT_CHECK) && "the export check lives in the monorepo";

/** What the build puts into the app, laid out as the gate reads it: resources/emulator, app.asar, the summary. */
function appTree() {
  const tree = mkdtempSync(path.join(os.tmpdir(), "emu203-h1-"));
  for (const f of emulatorFiles()) {
    mkdirSync(path.dirname(path.join(tree, f)), { recursive: true });
    copyFileSync(path.join(EMULATOR_DIR, f), path.join(tree, f));
  }
  for (const e of archiveEntries({ kind: "release", marker: markerBytes("release") }).filter((x) => x.file)) {
    const to = path.join(tree, "packages", "app", e.name);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(e.file, to);
  }
  writeFileSync(path.join(tree, NOTICES_FILE), noticesText({ platform: process.platform === "win32" ? "win32" : "darwin", commit: "0".repeat(40) }));
  return tree;
}

/** What the export check itself reports in a tree, with no exception: "rule: file" lines. */
function reported(tree) {
  let out;
  try {
    out = execFileSync(process.execPath, [EXPORT_CHECK, "--tree", tree, "--no-exceptions", "--json"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    out = e.stdout; // exit code 1: there are findings
  }
  return [...new Set(JSON.parse(out).uncovered.map((f) => `${f.rule}: ${f.loc.split("!")[0]}`))];
}

const fileOf = (line) => line.slice(line.indexOf(": ") + 2);

test("H1: every file of the app that the export check reports is closed for publication by the release check", { skip }, async () => {
  const tree = appTree();
  try {
    const gate = await publicationFindings(tree);
    const closed = new Set(gate.files.map((f) => f.file));
    const missed = reported(tree).filter((line) => !closed.has(fileOf(line)));
    assert.deepEqual(missed, [], "files the export check reports, which the release check lets through as publishable");
    // With the private patterns, what the app holds may be published (EMU-255): dist:check can end with 0.
    if (gate.checked) assert.deepEqual(gate.files, [], "the app holds what the export check refuses to publish");
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("the gate refuses a forbidden file, a serial number, and Cyrillic the export check does not allow", { skip }, async () => {
  const tree = appTree();
  try {
    const at = (...parts) => path.join(tree, ...parts);
    const web = ["packages", "engine", "build", "1.3.1", "web"];
    const planted = {
      // Files the export check never publishes, wherever they lie.
      "packages/engine/build/1.3.1/web/.DS_Store": "forbidden-file",
      "packages/server/.env": "forbidden-file",
      // A bar's serial number (made up, and written in two halves so that this file holds none).
      "packages/server/bar-speed.json": "serial",
      // The bundle whose own Cyrillic is allowed value by value: another value in it is still found.
      "packages/engine/build/1.3.1/web/_nuxt/index-7c2bd482.js": "cyrillic",
      // The license summary is checked as well.
      [NOTICES_FILE]: "cyrillic",
    };
    writeFileSync(at(...web, ".DS_Store"), "x");
    writeFileSync(at("packages", "server", ".env"), "A=1\n");
    appendFileSync(at("packages", "server", "bar-speed.json"), `\n{"serial": "${"1a2b3c4d5e6f"}${"7a8b9c0d1e2f"}"}\n`);
    // Cyrillic letters, made from their codes so that this file holds none.
    const cyrillic = String.fromCharCode(0x43f, 0x440, 0x438, 0x432, 0x435, 0x442);
    appendFileSync(at(...web, "_nuxt", "index-7c2bd482.js"), `\n// ${cyrillic}\n`);
    appendFileSync(at(NOTICES_FILE), `\n${cyrillic}\n`);
    const gate = await publicationFindings(tree);
    const closed = new Map(gate.files.map((f) => [f.file, f.why]));
    for (const [file, rule] of Object.entries(planted)) {
      assert.ok(closed.has(file), `the gate lets ${file} through with a planted ${rule} finding`);
      assert.match(closed.get(file), rule === "forbidden-file" ? /never publishes/ : new RegExp(`"${rule}"`), file);
    }
    if (gate.checked) assert.deepEqual([...closed.keys()].sort(), Object.keys(planted).sort(), "the gate closes only the files with what was planted");
    // The gate and the export check agree on the planted tree too.
    assert.deepEqual(reported(tree).filter((line) => !closed.has(fileOf(line))), []);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

// A release is checked in the exported tree, which does not hold the export check: the check is then told where the
// internal repository's is (dist.mjs check --export-check), and gives the same answer as in the internal repository.
test("in a tree without the export check the gate says \"not checked\", and checks with the export check it is pointed to", { skip }, async () => {
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "emu166-tree-")); // stands for the exported tree's emulator folder
  const tree = appTree();
  try {
    const here = await publicationFindings(tree);
    const without = await publicationFindings(tree, elsewhere);
    assert.equal(without.checked, false);
    assert.match(without.reason, /the export check is not here/);
    useExportCheck(path.dirname(EXPORT_CHECK));
    assert.deepEqual(await publicationFindings(tree, elsewhere), here);
    writeFileSync(path.join(tree, "packages", "server", ".env"), "A=1\n");
    assert.deepEqual((await publicationFindings(tree, elsewhere)).files.map((f) => f.file), ["packages/server/.env"]);
  } finally {
    useExportCheck(null);
    rmSync(tree, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
