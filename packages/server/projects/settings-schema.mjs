// An app's settings file (appmeta/settings.json), checked as the firmware checks it when it loads the app's settings
// (lib/js_app/js_app_settings.c, js_app_settings_parse; firmware 1.3.1): the same order, the first problem found, in
// the firmware's words with the field's path in front ("Field 'a.b': key 'options' is missing"). A bar that meets
// such a file shows "Settings file is invalid." and says no more; this says which field.
//
// By the firmware's code, not checked on a device; the emulated bar runs that code, and a test holds this module to
// what it logs. Stricter than the firmware in one place, where its documented schema is (documentation/JavaScript
// Applications.dox.md, Appendix 2): a number that must be whole (version, an integer's default, min, max and step, a
// string's lengths) may not have a fraction, which the firmware cuts off; `strict: false` cuts it off as well, for
// the emulated bar's own answers. Not checked: two fields with one id on the same level, which JSON.parse folds into
// one and the firmware refuses.

export const FORMAT_VERSION = 1;
export const MAX_DEPTH = 4;
/**
 * How deep the file's JSON may nest. A schema with groups four deep and an enum's options in the innermost nests 13
 * levels; a file past this is no schema, and is refused by its text alone, before it is parsed or walked: a file of
 * thousands of nested groups must not overflow the stack of whoever reads it (the firmware's cJSON stops at 1000).
 */
export const MAX_JSON_DEPTH = 32;
export const STRING_ABSOLUTE_MAX_LENGTH = 255;
export const STRING_DEFAULT_MAX_LENGTH = 64;
export const ENUM_MAX_OPTIONS = 32;
export const GEO_NAME_MAX_LENGTH = 128;
export const TYPES = Object.freeze(["boolean", "integer", "string", "enum", "color", "time", "geolocation", "group"]);
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/** The smallest file the firmware takes, for the hints: one switch. */
export const MINIMAL_EXAMPLE = Object.freeze({
  format_version: 1,
  version: 1,
  fields: { hour24: { type: "boolean", label: "24-hour clock", default: true } },
});

/** One field of each kind the bar's own screens can edit, as an example to copy from. */
export const EXAMPLE = Object.freeze({
  format_version: 1,
  version: 1,
  fields: {
    hour24: { type: "boolean", label: "24-hour clock", default: true },
    minutes: { type: "integer", label: "Minutes", default: 25, min: 1, max: 120, step: 1 },
    title: { type: "string", label: "Title", default: "FOCUS", max_length: 12 },
    theme: { type: "enum", label: "Theme", default: "amber", options: [{ value: "amber", label: "Amber" }, { value: "blue", label: "Blue" }] },
  },
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** How deep the brackets of a JSON text nest, counted on the text itself (strings skipped), up to `limit` + 1. */
export function jsonDepth(text, limit = Infinity) {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // a backslash: the next character is escaped
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x7b || c === 0x5b) {
      if (++depth > deepest) deepest = depth;
      if (deepest > limit) return deepest;
    } else if (c === 0x7d || c === 0x5d) depth--;
  }
  return deepest;
}
/** cJSON's name of a value's type, as the firmware's messages give it. */
function typeName(value) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return "object";
}
const IS = { boolean: (v) => typeof v === "boolean", number: (v) => typeof v === "number", string: (v) => typeof v === "string", array: Array.isArray, object: isObject };
const bytes = (text) => new TextEncoder().encode(text).length;

class Problem extends Error {
  constructor(field, problem, advice = null) {
    super(problem);
    this.field = field;
    this.problem = problem;
    this.advice = advice;
  }
}

/** A key of a field (or of its default, or of an option): present when not optional, and of the type. */
function get(path, json, key, type, optional = false) {
  const value = isObject(json) && Object.hasOwn(json, key) ? json[key] : undefined;
  if (value === undefined) {
    if (optional) return undefined;
    throw new Problem(path, `key '${key}' is missing`);
  }
  if (!IS[type](value)) throw new Problem(path, `key '${key}' has type ${typeName(value)} (${type} was expected)`);
  return value;
}

/** Whether a fraction where a whole number belongs is a problem (the documented schema) or cut off (the firmware). */
let strictNumbers = true;

function whole(path, json, key, optional) {
  const value = get(path, json, key, "number", optional);
  if (value === undefined || Number.isInteger(value)) return value;
  if (strictNumbers) throw new Problem(path, `key '${key}' must be a whole number`);
  return Math.trunc(value);
}

function unsigned(path, json, key) {
  const value = whole(path, json, key, true);
  if (value !== undefined && value < 0) throw new Problem(path, `key '${key}' must be a non-negative integer`);
  return value;
}

const PARSE = {
  boolean(path, json) {
    get(path, json, "default", "boolean");
  },
  integer(path, json) {
    const value = whole(path, json, "default");
    const min = whole(path, json, "min", true) ?? INT_MIN;
    const max = whole(path, json, "max", true) ?? INT_MAX;
    const step = unsigned(path, json, "step") ?? 1;
    for (const [key, number] of [["default", value], ["min", min], ["max", max]]) {
      if (number < INT_MIN || number > INT_MAX) throw new Problem(path, `key '${key}' must be between ${INT_MIN} and ${INT_MAX}`);
    }
    if (min > max) throw new Problem(path, "'min' is greater than 'max'");
    if (step === 0) throw new Problem(path, "key 'step' must be a non-zero integer");
    if ((max - min) % step !== 0) throw new Problem(path, "'max' - 'min' must be evenly divisible by 'step'");
    if (value < min || value > max) throw new Problem(path, "default is out of bounds");
  },
  string(path, json) {
    const value = get(path, json, "default", "string");
    get(path, json, "sensitive", "boolean", true);
    const min = unsigned(path, json, "min_length") ?? 0;
    const max = unsigned(path, json, "max_length") ?? STRING_DEFAULT_MAX_LENGTH;
    if (min > max) throw new Problem(path, "'min_length' is greater than 'max_length'");
    if (max > STRING_ABSOLUTE_MAX_LENGTH) throw new Problem(path, `'max_length' is greater than ${STRING_ABSOLUTE_MAX_LENGTH}`);
    if (bytes(value) < min || bytes(value) > max) throw new Problem(path, "default length is out of bounds", `The default has ${bytes(value)} bytes; the field takes ${min} to ${max} ("max_length" is ${STRING_DEFAULT_MAX_LENGTH} unless given, ${STRING_ABSOLUTE_MAX_LENGTH} at most).`);
  },
  enum(path, json) {
    const value = get(path, json, "default", "string");
    const options = get(path, json, "options", "array");
    if (options.length === 0 || options.length > ENUM_MAX_OPTIONS) throw new Problem(path, `key 'options' must contain between 1 and ${ENUM_MAX_OPTIONS} items`);
    const seen = [];
    for (const option of options) {
      const optionValue = get(path, option, "value", "string");
      get(path, option, "label", "string");
      if (seen.includes(optionValue)) throw new Problem(path, `duplicate enum option value '${optionValue}'`);
      seen.push(optionValue);
    }
    if (!seen.includes(value)) throw new Problem(path, `default '${value}' is not among the options`, `"default" is the "value" of one of the options: ${seen.map((one) => JSON.stringify(one)).join(", ")}.`);
  },
  color(path, json) {
    const value = get(path, json, "default", "string");
    if (!/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(value)) throw new Problem(path, "default must be a '#RRGGBB' or '#RRGGBBAA' color");
  },
  time(path, json) {
    const value = get(path, json, "default", "string");
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(value)) throw new Problem(path, "default must be a 'HH:MM' or 'HH:MM:SS' time");
  },
  geolocation(path, json) {
    const value = get(path, json, "default", "object");
    const mode = get(path, value, "mode", "string");
    if (mode !== "auto" && mode !== "fixed") throw new Problem(path, `key 'mode' must be 'auto' or 'fixed', got '${mode}'`);
    const name = get(path, value, "name", "string");
    if (bytes(name) === 0 || bytes(name) > GEO_NAME_MAX_LENGTH) throw new Problem(path, `key 'name' must be between 1 and ${GEO_NAME_MAX_LENGTH} characters`);
    const lat = get(path, value, "lat", "number", true);
    const lon = get(path, value, "lon", "number", true);
    const valid = mode === "auto" ? lat === undefined && lon === undefined : lat !== undefined && lon !== undefined && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    if (!valid) throw new Problem(path, "invalid default value", mode === "auto" ? 'With "mode": "auto" the default has no "lat" and no "lon".' : 'With "mode": "fixed" the default has "lat" (-90 to 90) and "lon" (-180 to 180).');
  },
  group(path, json, depth) {
    const fields = get(path, json, "fields", "object");
    if (Object.keys(fields).length === 0) throw new Problem(path, "group has no fields");
    if (depth >= MAX_DEPTH) throw new Problem(path, `maximum group nesting depth (${MAX_DEPTH}) reached`);
    nodes(fields, path, depth + 1);
  },
};

/** What an agent that guessed the format most often wrote instead of a type the firmware has. */
const TYPE_GUESSES = { select: "enum", dropdown: "enum", choice: "enum", options: "enum", list: "enum", bool: "boolean", toggle: "boolean", switch: "boolean", checkbox: "boolean", number: "integer", int: "integer", float: "integer", text: "string", str: "string", colour: "color", location: "geolocation", geo: "geolocation", section: "group" };

function nodes(fields, parent, depth) {
  for (const [id, json] of Object.entries(fields)) {
    const path = parent ? `${parent}.${id}` : id;
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Problem(path, "invalid id format", "A field's id starts with a lower-case letter and has only lower-case letters, digits and _.");
    get(path, json, "label", "string");
    get(path, json, "description", "string", true);
    const type = get(path, json, "type", "string");
    if (!TYPES.includes(type)) {
      const guess = TYPE_GUESSES[type.toLowerCase()];
      throw new Problem(path, `unknown type '${type}'`, `The types are ${TYPES.join(", ")}${guess ? `; for this one use "${guess}"` : ""}.`);
    }
    PARSE[type](path, json, depth);
  }
}

/**
 * Checks the text of a settings file.
 * @param {string} text
 * @param {{ strict?: boolean }} [o] `strict: false` takes a fraction where a whole number belongs, as the firmware does
 * @returns {{ ok: true, schema: object } | { ok: false, field: string | null, problem: string, advice: string | null }}
 *   `field` is the path of the field at fault ("group.field"), null for a problem of the file's own keys; `problem`
 *   the firmware's words for it; `advice` what to change, where the words alone do not say.
 */
export function checkSettingsSchema(text, { strict = true } = {}) {
  strictNumbers = strict;
  if (jsonDepth(text, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) {
    return { ok: false, field: null, problem: `Malformed JSON: nested deeper than ${MAX_JSON_DEPTH} levels`, advice: `Groups nest at most ${MAX_DEPTH} deep; no settings file needs more than ${MAX_JSON_DEPTH} levels of brackets.` };
  }
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, field: null, problem: `Malformed JSON: ${e.message}`, advice: null };
  }
  const failed = (problem, advice = null) => ({ ok: false, field: null, problem, advice });
  if (!isObject(root)) return failed("Malformed JSON or root item is not an object", "The file is one JSON object with \"format_version\", \"version\" and \"fields\".");
  if (typeof root.format_version !== "number") return failed("Root key 'format_version' is missing or is not a number", `Add "format_version": ${FORMAT_VERSION}.`);
  if (Math.trunc(root.format_version) !== FORMAT_VERSION) return failed(`Unsupported format version: expected ${FORMAT_VERSION}, got ${Math.trunc(root.format_version)}`);
  if (typeof root.version !== "number") return failed("Root key 'version' is missing or is not a number", 'Add "version": 1 (the version of your settings; raise it to drop the values kept on the BUSY Bar).');
  if ((strict && !Number.isInteger(root.version)) || Math.trunc(root.version) <= 0) return failed("Root key 'version' must be a positive number", "A whole number from 1 up.");
  if (!isObject(root.fields)) {
    return failed("Root key 'fields' is missing or is not an object", Array.isArray(root.fields) ? '"fields" is a map keyed by each field\'s id, { "my_field": { "type": …, "label": …, "default": … } }, not a list.' : '"fields" is a map keyed by each field\'s id.');
  }
  if (Object.keys(root.fields).length === 0) return failed("Root key 'fields' must not be empty", "Describe at least one field, or remove the file: an app without settings has none.");
  try {
    nodes(root.fields, null, 0);
  } catch (e) {
    if (!(e instanceof Problem)) throw e;
    return { ok: false, field: e.field, problem: e.problem, advice: e.advice };
  }
  return { ok: true, schema: root };
}

/** One line for a person or a log: "field 'a.b': key 'options' is missing", or the file's own problem. */
export function problemText(check) {
  return check.field === null ? check.problem : `field '${check.field}': ${check.problem}`;
}
