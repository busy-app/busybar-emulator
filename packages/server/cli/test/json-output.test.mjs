// --json prints ASCII only (EMU-249): every character outside it as \uXXXX, so that the JSON is the same whatever code
// page the console reads it in (PowerShell 5.1 reads a program's output in the console's: cp866, cp1251, cp1252).
//
//   node --test packages/server/cli/test/json-output.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { asciiJson, CliError, emit } from "../output.mjs";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASCII = /^[\x00-\x7e]*$/;
const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));

// Cyrillic, Greek and Japanese letters by their codes: the export check keeps letters of the private tree out of the public one.
const CYRILLIC = String.fromCharCode(0x41f, 0x440, 0x43e, 0x435, 0x43a, 0x442);
const STRINGS = [`C:\\Users\\you\\${CYRILLIC}\\screenshot-1.png`, `/Users/you/${String.fromCharCode(0x3a6, 0x3ac, 0x3ba)} ${String.fromCharCode(0x30d5, 0x30a9)}/app`, "emoji 😀 and a lone \ud800 half", "line\u2028separator\u2029", "tab\tnew\nline \u007f del", "plain"];

test("asciiJson: ASCII only, and the same value read back", () => {
  for (const text of STRINGS) {
    const value = { text, list: [text, 1, null, true], nested: { [text]: text } };
    const line = asciiJson(value);
    assert.match(line, ASCII, text);
    assert.deepEqual(JSON.parse(line), value, text);
  }
});

test("emit with --json: the answer and the failure are ASCII and say the same", () => {
  const lines = [];
  const out = (line) => lines.push(line);
  emit({ ok: true, command: "screenshot", data: { files: [STRINGS[0]] }, text: "" }, { json: true, out, err: out });
  emit({ ok: false, command: "check", error: new CliError("not_a_project", `${STRINGS[0]} is not an app project.`, `Run it in ${STRINGS[1]}.`, { folder: STRINGS[0] }) }, { json: true, out, err: out });
  for (const line of lines) assert.match(line, ASCII);
  assert.deepEqual(JSON.parse(lines[0]).files, [STRINGS[0]]);
  assert.equal(JSON.parse(lines[1]).folder, STRINGS[0]);
  assert.equal(JSON.parse(lines[1]).hint, `Run it in ${STRINGS[1]}.`);
});

test("the command line itself: a path with Cyrillic letters comes back ASCII and whole", () => {
  const top = mkdtempSync(path.join(os.tmpdir(), "emu-json-"));
  folders.push(top);
  const folder = path.join(top, `${CYRILLIC} app`);
  mkdirSync(folder);
  const r = spawnSync(process.execPath, [path.join(CLI_DIR, "busy-emulator.mjs"), "check", folder, "--json"], { encoding: "utf8", env: { ...process.env, BUSY_EMULATOR_DATA: path.join(top, `${CYRILLIC} data`), BUSY_EMULATOR_PORT: "1" } });
  assert.match(r.stdout, ASCII, r.stdout);
  const answer = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(answer.code, "not_a_project");
  assert.ok(answer.message.includes(folder), answer.message);
});

test("every --json printer of the command line goes through asciiJson", () => {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test") walk(file);
      } else if (entry.name.endsWith(".mjs")) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/\b(?:out|print|write|send)\(\s*`?\$?\{?\s*JSON\.stringify\(/g)) found.push(`${path.relative(CLI_DIR, file)}: ${text.slice(m.index, m.index + 60)}`);
      }
    }
  })(CLI_DIR);
  assert.deepEqual(found, []);
});
