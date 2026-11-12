// The check of an app's settings file (settings-schema.mjs): what the firmware's parser refuses is refused here, with
// the field at fault and the firmware's words. That the words are the firmware's own is held by
// emulator/test/server/agent-hands.test.mjs, which launches apps with the same broken files on the emulated bar.
import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSettingsSchema, EXAMPLE, jsonDepth, MAX_JSON_DEPTH, MINIMAL_EXAMPLE, problemText } from "../settings-schema.mjs";
import { BROKEN } from "./settings-cases.mjs";

const file = (fields, more = {}) => JSON.stringify({ format_version: 1, version: 1, fields, ...more });
const check = (fields, more) => checkSettingsSchema(file(fields, more));
const field = (definition) => check({ a: { label: "A", ...definition } });
/** A geolocation's default with coordinates (made here, so that no line of this file reads as somebody's place). */
const fixedPlace = (north, east) => ({ mode: "fixed", name: "Home", lat: north, lon: east });

test("the examples of the hints and of the project's AGENTS.md are files the firmware takes", () => {
  assert.equal(checkSettingsSchema(JSON.stringify(MINIMAL_EXAMPLE)).ok, true);
  assert.equal(checkSettingsSchema(JSON.stringify(EXAMPLE)).ok, true);
});

test("a file with every type, and groups four deep, is valid", () => {
  const deep = (levels) => (levels ? { type: "group", label: "G", fields: { inner: deep(levels - 1) } } : { type: "boolean", label: "B", default: false });
  const answer = check({
    on: { type: "boolean", label: "On", description: "Whether", default: true },
    count: { type: "integer", label: "Count", default: 5, min: 0, max: 10, step: 5 },
    name: { type: "string", label: "Name", default: "x", min_length: 1, max_length: 255, sensitive: true },
    mode: { type: "enum", label: "Mode", default: "b", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    tint: { type: "color", label: "Tint", default: "#00ff00AA" },
    at: { type: "time", label: "At", default: "23:59:59" },
    place: { type: "geolocation", label: "Place", default: fixedPlace(51.5, -0.1) },
    auto: { type: "geolocation", label: "Auto", default: { mode: "auto", name: "Here" } },
    nested: deep(4),
  });
  assert.deepEqual(answer.ok, true, JSON.stringify(answer));
  // A fifth level of groups is one too many.
  const tooDeep = check({ nested: deep(5) });
  assert.equal(tooDeep.problem, "maximum group nesting depth (4) reached");
  assert.equal(tooDeep.field, "nested.inner.inner.inner.inner");
});

test("what an agent guessed in the field test: no format_version, fields as a list, the type select", () => {
  const guessed = checkSettingsSchema(JSON.stringify({ fields: [{ id: "format", type: "select", options: ["12", "24"], default: "24" }] }));
  assert.deepEqual([guessed.ok, guessed.field, guessed.problem], [false, null, "Root key 'format_version' is missing or is not a number"]);
  const list = checkSettingsSchema(JSON.stringify({ format_version: 1, version: 1, fields: [{ id: "format" }] }));
  assert.equal(list.problem, "Root key 'fields' is missing or is not an object");
  assert.match(list.advice, /a map keyed by each field's id.*not a list/);
  const select = field({ type: "select", default: "24" });
  assert.equal(problemText(select), "field 'a': unknown type 'select'");
  assert.match(select.advice, /boolean, integer, string, enum, color, time, geolocation, group; for this one use "enum"/);
});

test("the file's own keys", () => {
  assert.match(checkSettingsSchema("{ not json").problem, /^Malformed JSON/);
  assert.equal(checkSettingsSchema("[]").problem, "Malformed JSON or root item is not an object");
  assert.equal(checkSettingsSchema(file({ a: {} }, { format_version: 2 })).problem, "Unsupported format version: expected 1, got 2");
  assert.equal(checkSettingsSchema(JSON.stringify({ format_version: 1, fields: {} })).problem, "Root key 'version' is missing or is not a number");
  assert.equal(checkSettingsSchema(file({ a: {} }, { version: 0 })).problem, "Root key 'version' must be a positive number");
  assert.equal(check({}).problem, "Root key 'fields' must not be empty");
});

for (const [fields, at, problem] of BROKEN) {
  test(`refused: ${at}: ${problem}`, () => {
    const answer = check(fields);
    assert.deepEqual([answer.ok, answer.field, answer.problem], [false, at, problem], JSON.stringify(answer));
  });
}

test("a fraction where a whole number belongs: a problem by the documented schema, cut off as the firmware does with strict: false", () => {
  const text = file({ a: { type: "integer", label: "A", default: 1.5 } });
  assert.equal(checkSettingsSchema(text).problem, "key 'default' must be a whole number");
  assert.equal(checkSettingsSchema(text, { strict: false }).ok, true);
  // The mode does not stick to the next call.
  assert.equal(checkSettingsSchema(text).ok, false);
});

test("a string's length is counted in bytes, as the firmware's strlen does", () => {
  assert.equal(field({ type: "string", default: "éééé", max_length: 4 }).problem, "default length is out of bounds");
  assert.equal(field({ type: "string", default: "éé", max_length: 4 }).ok, true);
});

test("a file nested deeper than a schema can be is refused by its text, not by a stack overflow", () => {
  // The security review of pull request 59: twenty thousand nested groups.
  const depth = 20_000;
  const deep = `{"format_version":1,"version":1,"fields":{"a":${'{"type":"group","label":"g","fields":{"a":'.repeat(depth)}{"type":"boolean","label":"x","default":true}${"}}".repeat(depth)}}}`;
  for (const strict of [true, false]) {
    const answer = checkSettingsSchema(deep, { strict });
    assert.deepEqual([answer.ok, answer.field, answer.problem], [false, null, `Malformed JSON: nested deeper than ${MAX_JSON_DEPTH} levels`]);
  }
  // Arrays count too, and brackets inside strings do not.
  assert.equal(checkSettingsSchema(`{"format_version":1,"version":1,"fields":{"a":{"type":"boolean","label":"x","default":${"[".repeat(5000)}${"]".repeat(5000)}}}}`).problem, `Malformed JSON: nested deeper than ${MAX_JSON_DEPTH} levels`);
  assert.equal(jsonDepth('{"a":"{{{{[[[[\\"{{{{","b":[{"c":[]}]}'), 4);
  assert.equal(checkSettingsSchema(JSON.stringify({ format_version: 1, version: 1, fields: { title: { type: "string", label: "{".repeat(100), default: "[[[[\\\"{{" } } })).ok, true);
  // What a real schema needs is far below the limit: groups four deep with an enum's options innermost.
  const deepest = (levels) => (levels ? { type: "group", label: "G", fields: { inner: deepest(levels - 1) } } : { type: "enum", label: "E", default: "a", options: [{ value: "a", label: "A" }] });
  const text = JSON.stringify({ format_version: 1, version: 1, fields: { g: deepest(4) } });
  assert.ok(jsonDepth(text) <= 13, String(jsonDepth(text)));
  assert.equal(checkSettingsSchema(text).ok, true);
});
