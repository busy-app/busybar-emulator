// Hints about the firmware an app needs, from its own code (EMU-321, epic E12 decision 5): `api_version` in the
// manifest is the lowest API the app needs, and BUSY Bars run more than one firmware. Two things go wrong:
//
// - The code uses what only a newer firmware has (an app's /api/storage, console.warn), and api_version is lower: a
//   BUSY Bar on the older firmware takes the app, and the app fails there.
// - api_version is newer than anything the code was found to use: BUSY Bars on the older firmware refuse the app for
//   nothing.
//
// Which API brought each thing is not written here: it comes from the firmware builds of this emulator (each
// build-info.json says what apps may reach and which console levels there are), so a firmware added later moves it.
//
// Only the code that goes into the app's package is read, as text: src/ and the template's shared/, not tests, not
// build scripts, not node_modules. Comments are left out, and so are strings, but for a string that is a path or URL
// of the storage API itself ("http://localhost/api/storage/write"). That is a hint, not proof: a call built at run
// time is not seen, a dependency's code is not read (a console.warn inside a library is not seen), and the app may
// need a newer firmware for what text does not show (how fetch encodes a URL, for one). Nothing is written or run.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { compareVersions, versionNumbers } from "./rules.mjs";

/**
 * What is looked for: an id, how the text says it (`code`, in the code without comments and strings; `string`, a
 * string's whole content), and how the build of a firmware tells whether it has it.
 */
export const FEATURES = Object.freeze([
  {
    id: "app_storage",
    what: "/api/storage",
    // busy-lib's Storage methods in the code, or a string that is the storage API's path or URL.
    code: /\.Storage(?:Write|Read|ListGet|Remove|Mkdir|StatusGet|Rename)\s*\(/,
    string: /^(?:https?:\/\/[^\s/]+)?\/api\/storage(?:[/?]\S*)?$/,
    has: (info) => Object.hasOwn(info?.appAllowlist ?? {}, "storage"),
  },
  {
    id: "console_warn",
    what: "console.warn",
    code: /\bconsole\s*\.\s*warn\b/,
    string: null,
    has: (info) => Array.isArray(info?.consoleSeverities) && info.consoleSeverities.includes("warn"),
  },
]);

/** The folders of a project whose code goes into the app's package: the template's src/ and shared/. */
const PACKAGED = ["src", "shared"];
/** Folders in them that are not the app's code. */
const NOT_APP_FOLDER = /^(?:node_modules|test|tests|__tests__|__mocks__|spec|scripts|tools|dist)$/;
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const NOT_APP_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.config\.[cm]?[jt]s$/i;
const MOST_FILES = 2000;
const MOST_BYTES = 1024 * 1024;

/** The app's own source files: paths relative to the project, sorted. */
function sources(dir) {
  const found = [];
  const walk = (folder, relative) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= MOST_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const rel = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!NOT_APP_FOLDER.test(entry.name)) walk(path.join(folder, entry.name), rel);
      } else if (entry.isFile() && CODE.test(entry.name) && !NOT_APP_FILE.test(entry.name)) {
        found.push(rel);
      }
    }
  };
  for (const top of PACKAGED) walk(path.join(dir, top), top);
  return found;
}

/**
 * JavaScript or TypeScript split into what the search reads: `code`, the text with every comment and string blanked
 * (newlines kept, so a line number stays a line number), and `strings`, each string's content with its line. A
 * template's ${…} is code. A regular expression literal is not told from a division: a quote in one may hide what
 * follows on its line, which a hint can bear.
 */
export function splitCode(text) {
  let code = "";
  const strings = [];
  let line = 1;
  let i = 0;
  // The template literals we are inside, each with the depth of braces its ${…} has open (0: in its literal part).
  const templates = [];
  const blank = (c) => (c === "\n" ? "\n" : " ");
  const readString = (quote) => {
    let content = "";
    const at = line;
    code += " ";
    i++;
    while (i < text.length && text[i] !== quote && text[i] !== "\n") {
      if (text[i] === "\\" && i + 1 < text.length) {
        content += text[i + 1];
        code += blank(text[i]) + blank(text[i + 1]);
        if (text[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      content += text[i];
      code += " ";
      i++;
    }
    if (text[i] === quote) {
      code += " ";
      i++;
    }
    strings.push({ text: content, line: at });
  };
  // The literal part of a template, up to its end or to ${.
  const readTemplate = () => {
    let content = "";
    const at = line;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\" && i + 1 < text.length) {
        content += text[i + 1];
        code += blank(c) + blank(text[i + 1]);
        if (text[i + 1] === "\n") line++;
        i += 2;
        continue;
      }
      if (c === "`") {
        code += " ";
        i++;
        templates.pop();
        break;
      }
      if (c === "$" && text[i + 1] === "{") {
        code += "  ";
        i += 2;
        templates[templates.length - 1] = 1;
        break;
      }
      if (c === "\n") line++;
      content += c;
      code += blank(c);
      i++;
    }
    strings.push({ text: content, line: at });
  };
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (templates.length && templates.at(-1) === 0) {
      readTemplate();
      continue;
    }
    if (templates.length && c === "{") templates[templates.length - 1]++;
    if (templates.length && c === "}") {
      templates[templates.length - 1]--;
      if (templates.at(-1) === 0) {
        code += " ";
        i++;
        continue;
      }
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        code += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) {
        if (text[i] === "\n") line++;
        code += blank(text[i]);
      }
      continue;
    }
    if (c === '"' || c === "'") {
      readString(c);
      continue;
    }
    if (c === "`") {
      code += " ";
      i++;
      templates.push(0);
      continue;
    }
    if (c === "\n") line++;
    code += c;
    i++;
  }
  return { code, strings };
}

/** Where the app's code uses each feature: { id: [{ file, line }] }. */
export function featureUses(dir) {
  const uses = Object.fromEntries(FEATURES.map((one) => [one.id, []]));
  for (const file of sources(dir)) {
    let text;
    try {
      const full = path.join(dir, file);
      if (statSync(full).size > MOST_BYTES) continue;
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const { code, strings } = splitCode(text);
    const lines = code.split("\n");
    for (const feature of FEATURES) {
      const at = new Set();
      lines.forEach((one, index) => feature.code.test(one) && at.add(index + 1));
      if (feature.string) for (const one of strings) if (feature.string.test(one.text.trim())) at.add(one.line);
      for (const line of [...at].sort((a, b) => a - b)) uses[feature.id].push({ file, line });
    }
  }
  return uses;
}

/** "a", "a and b", "a, b and c". */
const words = (items) => (items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join(""));
const places = (found) => `${found.slice(0, 3).map((one) => `${one.file}:${one.line}`).join(", ")}${found.length > 3 ? ` and ${found.length - 3} more` : ""}`;
const newer = (a, b) => compareVersions(versionNumbers(a), versionNumbers(b));
const byApi = (list) => [...list].sort((a, b) => newer(a.api, b.api));

/**
 * The hints for the project in `dir`: [{ id, message, fix, found }], empty when there is nothing to say (or nothing
 * to say it from: no api_version of three numbers, no firmware builds). `fix` follows "Change: " in the text.
 * @param {object} o
 * @param {string} o.dir         the project's folder
 * @param {string|null} o.api    the manifest's api_version
 * @param {string} o.manifest    where it is written, relative to the project
 * @param {{ version: string, api: string|null, alias?: string|null, available?: boolean, info?: object|null }[]} o.firmwares
 *   this emulator's firmwares with their build records (cli/firmware.mjs firmwaresHere)
 * @param {string} o.cli         how to call the command line, for the command a hint names
 * @param {object} [o.uses]      featureUses(dir), for the tests
 */
export function firmwareHints({ dir, api, manifest, firmwares, cli, uses = null }) {
  if (!versionNumbers(api)) return [];
  const built = byApi(firmwares.filter((one) => one.available !== false && one.info && versionNumbers(one.api)));
  if (!built.length) return [];
  const oldest = built[0];
  const found = uses ?? featureUses(dir);
  const hints = [];
  // The API each used feature needs: that of the oldest firmware whose build has it.
  const needs = [];
  for (const feature of FEATURES) {
    if (!found[feature.id]?.length) continue;
    const since = built.find((one) => feature.has(one.info));
    if (!since) continue;
    needs.push({ feature, since, found: found[feature.id] });
  }
  const tooLow = needs.filter((one) => newer(api, one.since.api) < 0);
  for (const { feature, since, found: at } of tooLow) {
    const without = words(built.filter((one) => newer(one.api, since.api) < 0).map((one) => one.version));
    hints.push({
      id: `needs_${feature.id}`,
      message: `${places(at)} ${at.length === 1 ? "uses" : "use"} ${feature.what}, which firmware ${without} lacks, but api_version is ${api}: the app installs on ${without} and fails there.`,
      fix: `set api_version to ${since.api} in ${manifest}, or do without ${feature.what}.`,
      found: at.map((one) => ({ ...one, uses: feature.what })),
    });
  }
  if (!tooLow.length) {
    // The API the code was found to need: the oldest firmware's, or that of the newest feature it uses.
    const needed = byApi([{ api: oldest.api }, ...needs.map((one) => ({ api: one.since.api }))]).at(-1).api;
    if (newer(api, needed) > 0) {
      // The firmwares the app is kept to, those that refuse it, and of those the ones a lower api_version wins back
      // (never none: the firmware whose API is `needed` is among them).
      const only = built.filter((one) => newer(one.api, needed) > 0 && newer(one.api, api) <= 0).map((one) => one.version);
      const refusing = built.filter((one) => newer(one.api, api) < 0).map((one) => one.version);
      const regained = built.filter((one) => newer(one.api, api) < 0 && newer(one.api, needed) >= 0);
      const later = FEATURES.filter((feature) => !needs.some((one) => one.feature === feature)).map((feature) => feature.what);
      const target = regained[0];
      const kept = only.length ? words(only) : `API ${api}`;
      hints.push({
        id: "api_version_higher_than_needed",
        message:
          `api_version is ${api}, but the code uses nothing ${only.length ? `only ${kept} ${only.length === 1 ? "has" : "have"}` : `that needs API ${api}`}${later.length ? ` (${later.join(", ")})` : ""}: BUSY Bars on ${words(refusing)} refuse the app. ` +
          `A difference the code's text does not show, such as how fetch encodes a URL, may still need ${kept}; a dependency's code is not read.`,
        fix: `if it runs on ${words(regained.map((one) => one.version))}, set api_version to ${needed} in ${manifest}, then try it there:\n  ${cli} firmware use ${target.alias ?? target.version}`,
        found: [],
      });
    }
  }
  return hints;
}
