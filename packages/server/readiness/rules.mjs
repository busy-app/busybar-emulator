// The BUSY Apps Catalog's checks as the emulator knows them: every check's id, the stage the catalog runs it in, a
// title in the emulator's words, and whether a failure blocks the pull request or is a warning; the limits the checks
// compare with; the rules for an id and a name; the license texts the catalog recognizes. The code that decides each
// check from a project folder is check.mjs. The catalog's own titles and texts are in catalog-registry.json
// (registry.mjs) and are shown beside these where that file is there.
//
// The ids, the limits, the patterns of an id, a name and a version, the categories and the table of license texts are
// taken from the tools of the catalog repository `busy-app/busy-apps-catalog` at the commit RULES_COMMIT
// (tools/check_registry.py, lib_app_id.py, check_package.py, lib_tar.py, lib_license.py, schema/), which are
// distributed under the MIT License:
//
//      Copyright (c) 2026 Flipper Devices
//
//      Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//      documentation files (the "Software"), to deal in the Software without restriction, including without
//      limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
//      Software, and to permit persons to whom the Software is furnished to do so, subject to the following
//      conditions:
//
//      The above copyright notice and this permission notice shall be included in all copies or substantial
//      portions of the Software.
//
//      THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
//      TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
//      THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
//      CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//      DEALINGS IN THE SOFTWARE.
//
// A test compares the list of checks with the registry snapshot: a check the catalog adds or drops fails it.

export const RULES_COMMIT = "cd70f339688523a0d0be6869ed8835f17ad941d4";
export const RULES_DATE = "2026-11-12";

/** The catalog's repository, as its own pull request template names it; `submit --catalog` names another. */
export const CATALOG_REPOSITORY = "busy-app/busy-apps-catalog";

export const MIB = 1024 * 1024;

export const LIMITS = Object.freeze({
  idLength: 63,
  // What busy-cli builds and the bar installs: its own rule for an id, ^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,31}$.
  buildIdLength: 32,
  nameLength: 32,
  manifestBytes: 512,
  javascriptBytes: 256_000,
  packageBytes: 100 * MIB,
  unpackedBytes: 100 * MIB,
  sourceBytes: 100 * MIB,
  entries: 10_000,
  heapKib: [1, 512],
  screenshots: [1, 10],
  backScreenshots: [0, 10],
  licenseBytes: 200 * 1024,
  shortDescription: [10, 120],
  description: [50, 4000],
  changelog: [10, 4000],
});

/** The catalog's categories: id, name, what goes there. An alias is taken for its category, with a warning. */
export const CATEGORIES = Object.freeze([
  { id: "productivity", name: "Productivity", about: "focus, Pomodoro, timers, Do Not Disturb, tasks, habits, deadlines, meeting and call status", aliases: ["meetings"] },
  { id: "clocks", name: "Clock & Time", about: "clocks, world time, countdowns, dates", aliases: [] },
  { id: "info-feeds", name: "Info & Feeds", about: "weather, crypto, stocks, exchange rates, news, transport, sports, quotes", aliases: [] },
  { id: "social", name: "Social", about: "followers, unread messages, streams, birthdays", aliases: [] },
  { id: "dev-monitoring", name: "Dev & Monitoring", about: "builds, pull requests, uptime, load, KPIs, sales", aliases: [] },
  { id: "music", name: "Music", about: "now playing, equalizers, radio, volume, players", aliases: [] },
  { id: "art", name: "Art", about: "animations, pixel art, generative art, decorative displays", aliases: [] },
  { id: "games", name: "Games", about: "games on the buttons and the wheel, pixel pets, mini-games", aliases: [] },
  { id: "smart-home", name: "Smart Home", about: "Home Assistant, sensors, lights, climate, energy", aliases: [] },
  { id: "utilities", name: "Utilities", about: "apps that fit no other category", aliases: [] },
]);

/** The first part of an id the catalog recommends: a top-level domain label, or a two-letter country code. */
export const DOMAIN_LABELS = Object.freeze(["app", "com", "io", "org", "net", "dev"]);

/** The fields appmeta/manifest.json must have. */
export const MANIFEST_KEYS = Object.freeze(["format_version", "id", "name", "version", "api_version"]);

const APP_ID = /^(?=.{3,63}$)[a-z0-9_-]+(?:\.[a-z0-9_-]+){2,}$/;
const NAME_CHARACTERS = /^[A-Za-z0-9 !?&'()+,\-./:#$%@_]+$/;
export const NUMERIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const ID_RULE = "up to 32 characters (the catalog's own rule allows 63, but busy-cli and the BUSY Bar take 32): lower-case Latin letters, digits, _, - and dots; at least two dots, none at the start, at the end or in a row (com.example.weather, io.github.<your-github-user>.<app>)";

/** Null for an id the catalog takes, otherwise what is wrong with it. */
export function idProblem(id) {
  if (typeof id !== "string" || !id) return "there is no id";
  if (APP_ID.test(id)) return null;
  const lower = id.toLowerCase();
  if (lower !== id && APP_ID.test(lower)) return `it has upper-case letters; ${lower} would do`;
  const bad = [...new Set([...lower].filter((c) => !/[a-z0-9_.-]/.test(c)))];
  if (bad.length) return `it has ${bad.map((c) => JSON.stringify(c)).join(", ")}, which an id may not have`;
  if (id.length > LIMITS.idLength) return `it is ${id.length} characters long, the limit is ${LIMITS.idLength}`;
  if (id.split(".").includes("")) return "it has an empty part between dots";
  return `it has ${id.split(".").length - 1} dot(s), an id needs at least two`;
}

/**
 * Names many computers share as their account's name (the release dry run, 12.11: a Windows account "User" made
 * app.user.my_app): an id made from one would be other people's id too in the catalog. Never taken as an author that
 * nobody chose. Written as an id's part (lower-case, a run of spaces as "_"), in Latin letters.
 */
export const GENERIC_AUTHORS = Object.freeze(["user", "users", "admin", "administrator", "owner", "pc", "guest", "root", "default", "defaultuser", "defaultuser0", "me", "you", "test", "dev", "developer", "computer", "home", "mac", "macbook", "windows", "ubuntu", "pi", "demo", "student", "example", "your_name", "busy_bar_developer", "benutzer", "usuario", "utilisateur", "polzovatel"]);

/**
 * Whether `name` is one of GENERIC_AUTHORS, letter case, spaces and dots aside. A name in other letters is put into
 * Latin ones by the caller first (app-identity.mjs, idPart); one with no Latin letter left is not taken here as one.
 */
export function genericAuthor(name) {
  const part = String(name ?? "").toLowerCase().trim().replace(/[\s.]+/g, "_").replace(/[^a-z0-9_-]+/g, "").replace(/_{2,}/g, "_").replace(/^[_-]+|[_-]+$/g, "");
  return GENERIC_AUTHORS.includes(part);
}

/** Whether a valid id starts the way the catalog recommends. */
export function idRecommended(id) {
  const first = id.split(".", 1)[0];
  return DOMAIN_LABELS.includes(first) || /^[a-z]{2}$/.test(first);
}

/** Null for a name the catalog takes, otherwise what is wrong with it. */
export function nameProblem(name) {
  if (typeof name !== "string" || !name) return "it is not a text, or is empty";
  const length = [...name].length;
  if (length > LIMITS.nameLength) return `it is ${length} characters long, the limit is ${LIMITS.nameLength}`;
  if (name !== name.trim() || name.includes("  ")) return "it has a space at the start, at the end, or two in a row";
  if (!NAME_CHARACTERS.test(name)) {
    const bad = [...new Set([...name].filter((c) => !NAME_CHARACTERS.test(c)))];
    return `it has ${bad.map((c) => JSON.stringify(c)).join(", ")}: only Latin letters, digits, single spaces and ! ? & ' ( ) + , - . / : # $ % @ _ are taken`;
  }
  return null;
}

/** [major, minor, patch] of a numeric version, or null. */
export function versionNumbers(value) {
  return typeof value === "string" && NUMERIC_VERSION.test(value) ? value.split(".").map(Number) : null;
}

/** <0, 0, >0 as a is below, equal to or above b; both [major, minor, patch]. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Why a check has no answer here whatever the project holds. `applies: false` marks the ones that say nothing about
// an app that is being submitted: they report the catalog's own run, or belong to a request to remove an app.
const OWN_RUN = "it reports a fault of the catalog's own run, not anything about the app";
const REMOVAL = "it is only run for a pull request that removes an app from the catalog";

/**
 * Every check of the catalog, in the catalog's order. `blocking: false` is a warning: the catalog shows it and still
 * takes the app. `outside` says why the check can never be decided from a project folder.
 */
export const CHECKS = Object.freeze(
  [
    ["manifest_path", "manifest", "Where the catalog manifest goes", true],
    ["id_style", "manifest", "The id starts like a domain", false],
    ["pr_scope", "manifest", "The pull request changes one file", true, { why: "it is about the pull request: that one may change nothing but applications/<id>/manifest.yml", applies: true }],
    ["app_id_format", "manifest", "The app's id", true],
    ["removal_not_owner", "manifest", "Who removes an app", true, { why: REMOVAL, applies: false }],
    ["removal_not_published", "manifest", "The app to remove is in the catalog", false, { why: REMOVAL, applies: false }],
    ["manifest_readable", "manifest", "The catalog manifest is readable YAML", true],
    ["manifest_schema", "manifest", "The fields of the catalog manifest", true],
    ["manifest_references", "manifest", "Paths in the catalog manifest", true],
    ["changelog_text", "manifest", "The changelog", true],
    ["official_namespace", "manifest", "The app.busy. ids are BUSY's own", false],
    ["category_public", "manifest", "The category", true],
    ["category_alias", "manifest", "The category's main name", false],
    ["category_offline", "manifest", "The catalog's category list", false, { why: OWN_RUN, applies: false }],
    ["source_origin", "build", "The source is a GitHub repository at a full commit", true],
    ["source_commit", "build", "The commit is in the repository on GitHub", true],
    ["source_subdir", "build", "The app's folder in the repository", true],
    ["app_id_match", "build", "The manifest's folder is named after the id", true],
    ["license", "build", "An open source license file", true],
    ["license_unrecognised", "build", "The license text is a known one", false],
    ["referenced_file", "build", "The files the manifest names are there", true],
    ["text_resolve", "build", "The lengths of the description and the changelog", true],
    ["markdown", "build", "The Markdown of the description and the changelog", true],
    ["screenshots_count", "build", "The number of screenshots", true],
    ["back_screenshots_count", "build", "The number of back screenshots", true],
    ["screenshot_png", "build", "The screenshots are 72×16 PNG files", true],
    ["source_archive_size", "build", "The size of the source", true],
    ["back_screenshot_png", "build", "The back screenshots are 160×80 PNG files", true],
    ["build_lockfile", "build", "One lock file that pins busy-cli", true],
    ["build", "build", "The catalog's own build of the app", true],
    ["script_main", "build", "scripts/main.js in the build", true],
    ["script_imports", "build", "The scripts parse and import only each other", true],
    ["screenshot_final", "build", "The screenshots can be re-saved by the catalog", true],
    ["back_screenshot_final", "build", "The back screenshots can be re-saved by the catalog", true],
    ["icon_png", "build", "The icons are 8×8 and 11×11 PNG files", true],
    ["icon_missing", "build", "The app has a front icon", false],
    ["package_missing", "package", "The build gave a package", true],
    ["invalid_id", "package", "The id of the package", true],
    ["package_size", "package", "The size of the package", true],
    ["unpacked_size", "package", "The size of the package unpacked", true],
    ["archive_entries", "package", "The number of files in the package", true],
    ["archive_invalid", "package", "The package is a readable .tgz", true],
    ["tar_format", "package", "The package's paths fit a plain tar", true],
    ["package_path", "package", "Everything in the package is under the id's folder", true],
    ["duplicate_path", "package", "No path twice in the package", true],
    ["archive_entry", "package", "Only files and folders in the package", true],
    ["javascript_size", "package", "The size of each JavaScript file", true],
    ["main_missing", "package", "scripts/main.js in the package", true],
    ["manifest_missing", "package", "appmeta/manifest.json in the package", true],
    ["manifest_size", "package", "The size of appmeta/manifest.json", true],
    ["manifest_json", "package", "appmeta/manifest.json is a JSON object", true],
    ["manifest_field", "package", "The fields appmeta/manifest.json must have", true],
    ["manifest_format_version", "package", "format_version", true],
    ["manifest_id", "package", "The package was built with this id", true],
    ["manifest_name", "package", "The app's name", true],
    ["manifest_version", "package", "version and api_version", true],
    ["manifest_heap", "package", "heap_size_kib", true],
    ["manifest_debug", "package", "Debug mode is off", true],
    ["version_not_newer", "catalog", "The version is above the published one", true],
    ["source_repository_changed", "catalog", "The update comes from the published app's repository", true],
    ["firmware_too_old", "catalog", "api_version is not above the released firmware's", true],
    ["catalog_unavailable", "catalog", "The catalog's lookup", false, { why: OWN_RUN, applies: false }],
    ["version_unavailable", "catalog", "The catalog's lookup of the published version", false, { why: OWN_RUN, applies: false }],
    ["firmware_unavailable", "catalog", "The catalog's lookup of the firmware API", false, { why: OWN_RUN, applies: false }],
    ["author_attestation", "review", "The author's confirmation", true, { why: "it is a box of the pull request's description: \"I'm the author of the app or have write access to its repository\", ticked before the pull request is opened", applies: true }],
    ["internal_error", "review", "The catalog's checks ran to the end", true, { why: OWN_RUN, applies: false }],
  ].map(([id, stage, title, blocking, outside = null]) => Object.freeze({ id, stage, title, blocking, outside })),
);

export const STAGES = Object.freeze(["manifest", "build", "package", "catalog", "review"]);

// ---------------------------------------------------------------- license texts

/** A file the catalog takes for the license: LICENSE, LICENCE or COPYING, with any extension, in any letter case. */
export const LICENSE_FILE = /^(licen[cs]e|copying)(\..+)?$/i;

const RESTRICTED = ["commons clause", "non-commercial", "noncommercial", "not for commercial", "no commercial", "for non commercial"];
// [SPDX id, phrases that must all be in the text]; the first match wins, the more specific licenses first.
const LICENSE_TEXTS = [
  ["AGPL-3.0", ["gnu affero general public license", "version 3, 19 november 2007"]],
  ["LGPL-3.0", ["gnu lesser general public license", "version 3, 29 june 2007"]],
  ["LGPL-2.1", ["gnu lesser general public license", "version 2.1, february 1999"]],
  ["GPL-3.0", ["gnu general public license", "version 3, 29 june 2007"]],
  ["GPL-2.0", ["gnu general public license", "version 2, june 1991"]],
  ["Apache-2.0", ["apache license", "version 2.0, january 2004"]],
  ["MPL-2.0", ["mozilla public license version 2.0"]],
  ["Unlicense", ["this is free and unencumbered software released into the public domain"]],
  ["MIT", ["permission is hereby granted, free of charge, to any person obtaining a copy", "to deal in the software without restriction", 'the software is provided "as is"']],
  ["BSD-3-Clause", ["redistribution and use in source and binary forms, with or without modification, are permitted provided", "redistributions in binary form must reproduce", "neither the name of"]],
  ["BSD-2-Clause", ["redistribution and use in source and binary forms, with or without modification, are permitted provided", "redistributions in binary form must reproduce", "this software is provided by the copyright holders and contributors"]],
  ["ISC", ["permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies"]],
  ["0BSD", ["permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted."]],
  ["Zlib", ["the origin of this software must not be misrepresented", "altered source versions must be plainly marked as such"]],
];
export const KNOWN_LICENSES = Object.freeze(LICENSE_TEXTS.map(([id]) => id));

/** The SPDX id of a license text the catalog recognizes, or null. */
export function recognizeLicense(text) {
  const plain = text.toLowerCase().replaceAll("\u2019", "'").replaceAll("\u201c", '"').replaceAll("\u201d", '"').split(/\s+/).filter(Boolean).join(" ");
  if (RESTRICTED.some((flag) => plain.includes(flag))) return null;
  for (const [id, phrases] of LICENSE_TEXTS) if (phrases.every((phrase) => plain.includes(phrase))) return id;
  return null;
}
