// bar-speed.json names the bar its probe was recorded on by model and firmware, never by serial number: the file is
// in every release and in the public repository (EMU-250).
//
//   node --test "packages/server/test/*.test.mjs"      (from emulator/)

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bar, probeSource } from "../bar-speed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, "..", "bar-speed.json");

// Serial numbers are found by the export check's own `serial` rule (tools/export-check/rules.mjs), so this test sees
// exactly what the check sees, all-digit serials included. The public repository has no tools/: there the rule's
// core stands in for it — 24 hex digits between non-hex characters, at least 5 different, letters of one case.
const rules = join(here, "..", "..", "..", "tools", "export-check", "rules.mjs");
const serialRule = existsSync(rules) ? (await import(pathToFileURL(rules).href)).RULES.find((r) => r.id === "serial") : null;
const SERIAL = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{24}(?![0-9A-Fa-f])/g;
const fallback = (line) => (line.match(SERIAL) ?? []).filter((v) => new Set(v.toLowerCase()).size >= 5 && !(/[a-f]/.test(v) && /[A-F]/.test(v)));
/** How many serial numbers the text holds, line by line as the export check reads it. No value is returned. */
const serials = (text) => text.split("\n").reduce((n, line) => n + (serialRule ? [...serialRule.find(line, {})].length : fallback(line).length), 0);

// A made-up serial number of the shape real ones have (24 decimal digits), built here so that no literal of that
// shape stands in this file.
const madeUp = "1029384756".repeat(3).slice(0, 24);

test("the serial finder finds an all-digit serial number, in JSON and in text", () => {
  assert.equal(serials(JSON.stringify({ note: `recorded on ${madeUp}` })), 1);
  assert.equal(serials(`{ "serial": "${madeUp}" }\n{ "again": "${madeUp}" }`), 2);
});

test("bar-speed.json names its bar as probeSource does and holds no serial number", () => {
  assert.deepEqual(Object.keys(bar.source).sort(), ["bar", "firmware", "recorded"]);
  const version = bar.source.bar.match(/^BUSY Bar, firmware (\S+)$/)?.[1];
  assert.ok(version, "source.bar is the model and the firmware version");
  assert.equal(bar.source.bar, probeSource({ version, commit_hash: bar.source.firmware }).bar);
  assert.equal(serials(readFileSync(file, "utf8")), 0, "bar-speed.json holds a serial number");
});

test("probeSource takes the model and firmware from the bar's firmware answer, and nothing else", () => {
  const recorded = new Date("2026-11-09T22:49:35.198Z");
  const answer = { version: "1.3.1", target: 22, branch: "release", build_date: "2026-10-26", commit_hash: "8edd2da4", serial_number: madeUp };
  const source = probeSource(answer, recorded);
  assert.deepEqual(source, { bar: "BUSY Bar, firmware 1.3.1", firmware: "8edd2da4", recorded: "2026-11-09T22:49:35.198Z" });
  assert.equal(serials(JSON.stringify(source)), 0);
});
