// What `create` puts right in a project fresh from the official template (@busy-app/create-app 0.5.x), because an
// agent trips without it (the field test with a real agent, 11.11):
//
// - shared/settings.ts. The template's helper reads a global `Settings` the released firmware does not have, so its
//   loadValues() is always null and every settings page made with it is dead (docs/requests/busy-tools-issues.md,
//   issue 6; not filed on GitHub yet). The helper is
//   replaced by one with the same exported names that reads the bar's API, GET /api/apps/settings?app_id=<the app>:
//   the bar answers with every field, the saved value or the default of settings.json. Only the template's own
//   broken helper is replaced: a file that does not read that global (a later template that fixed it) is left alone.
// - AGENTS.md. The template's file tells an agent to run `npm run build|typecheck` and its README speaks of a bar on
//   USB; neither says how settings.json looks. A section of the emulator's own goes in, clearly delimited, before
//   the template's first heading (an agent reads the file from the top at every task), and the template's lines that
//   name `npm run …` and the dead helper are rewritten. The section names no path of this computer: the file goes
//   into the author's public repository (ADR-0002 section 7).
//
// Nothing here is done again for a project that exists: a later version of the emulator does not rewrite old projects.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MINIMAL_EXAMPLE } from "./settings-schema.mjs";

/** The engine beside the server: firmware.json and each firmware's build (packages/engine). */
const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "engine");

/** What tells the template's broken helper: it looks for the runtime's global. */
const BROKEN_HELPER = /globalThis as \{ Settings\?: SettingsApi \}/;

export const SETTINGS_HELPER = `// The app's settings, read from the BUSY Bar's HTTP API: GET /api/apps/settings?app_id=<this app>.
//
// Written by BUSY Bar Emulator's \`create\` in place of the template's helper, which read a global (\`Settings\`) that
// the released firmware does not have: its loadValues() always gave null.
//
// The BUSY Bar answers with every field of src/appmeta/settings.json: the value a person saved, or the field's "default"
// from that file while nothing is saved. An app reads its settings and cannot write them: a person sets them on the
// BUSY Bar (APPS, the app's card, Setup) or in the BUSY Bar's web page, and the app sees them the next time it asks. Ask at
// the start of the app.
import manifest from "../src/appmeta/manifest.json";
import { device } from "./device";

/** The values: field id -> value; a group is a nested map. */
export type SettingsValues = Record<string, unknown>;

/**
 * Reads the app's settings. Null when the app has no src/appmeta/settings.json or the BUSY Bar did not answer: use the
 * defaults in code then.
 */
export async function loadValues(): Promise<SettingsValues | null> {
  try {
    const answer: unknown = await device.AppsSettingsGet({ app_id: manifest.id });
    const values = (answer as { values?: unknown } | null)?.values;
    return values !== null && typeof values === "object" ? (values as SettingsValues) : null;
  } catch {
    return null;
  }
}

/** An app cannot write its settings (the BUSY Bar lets an app only read them): this saves nothing and says so. */
export async function saveValues(_values: SettingsValues): Promise<void> {
  console.error(\`\${manifest.id}: saveValues() saved nothing: an app can read its settings, not write them.\`);
}
`;

/**
 * Replaces the template's settings helper in the project `dir`.
 * @returns {"replaced" | "not-needed" | "missing"} "not-needed": the file is not the template's broken helper.
 */
export function fixSettingsHelper(dir) {
  const file = path.join(dir, "shared", "settings.ts");
  if (!existsSync(file)) return "missing";
  if (!BROKEN_HELPER.test(readFileSync(file, "utf8"))) return "not-needed";
  writeFileSync(file, SETTINGS_HELPER);
  return "replaced";
}

export const SECTION_BEGIN = "<!-- busy-emulator:begin -->";
export const SECTION_END = "<!-- busy-emulator:end -->";

/**
 * How each shell an agent on Windows may run calls the command line at its fixed path (ADR-0002 §7a), from the
 * variable that shell reads: PowerShell (Codex, Cursor, Claude Code's PowerShell tool), Git Bash (Claude Code's Bash
 * tool), cmd. The same forms as the first run's text for agents without a path (legacy-window/welcome.js).
 */
export const WINDOWS_CALLS = Object.freeze({
  powershell: '& "$env:LOCALAPPDATA\\busy-emulator\\bin\\busy-emulator.exe"',
  bash: '"$LOCALAPPDATA/busy-emulator/bin/busy-emulator.exe"',
  cmd: '"%LOCALAPPDATA%\\busy-emulator\\bin\\busy-emulator.exe"',
});

/**
 * The pair of firmwares the section's list of differences was written for (epic E12, EMU-323): what the latest has and
 * the previous lacks. A test holds it to firmware.json, so a new firmware makes someone write the list again.
 */
export const FIRMWARE_LIST_WRITTEN_FOR = Object.freeze({ latest: "1.4.1", previous: "1.3.1" });

/**
 * The latest and the previous firmware of this copy of the emulator, each { version, api }, from the engine's
 * firmware.json and its builds' build-info.json, as firmwareChoices() and loadFirmware() in ../firmware.mjs name them
 * (a test holds the two to each other). Read here, not imported: a copy of the command line without the engine still
 * runs `create`. Null when there is no previous firmware or the engine cannot be read; the section then leaves its
 * firmware part out.
 */
export function sectionFirmwares(engine = ENGINE) {
  try {
    const config = JSON.parse(readFileSync(path.join(engine, "firmware.json"), "utf8"));
    const released = (name) => /^\d+(\.\d+)*$/.test(name);
    const newer = (a, b) => {
      const [x, y] = [a, b].map((name) => name.split(".").map(Number));
      for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      return 0;
    };
    const latest = config.default;
    if (!released(latest) || !config.versions?.[latest]) return null;
    const previous = Object.keys(config.versions).filter((name) => released(name) && newer(name, latest) < 0).sort(newer).at(-1);
    if (!previous) return null;
    const one = (version) => {
      const api = JSON.parse(readFileSync(path.join(engine, "build", version, "build-info.json"), "utf8")).api;
      if (typeof api !== "string" || !api) throw new Error(`no API for firmware ${version}`);
      return { version, api };
    };
    return { latest: one(latest), previous: one(previous) };
  } catch {
    return null;
  }
}

/** The section's part on the two firmwares: what needs the latest's API, and what differs in behavior. Empty without both. */
function firmwareLines(firmwares) {
  if (!firmwares) return [];
  const { latest, previous } = firmwares;
  return [
    "### Firmware",
    "",
    `BUSY Bars run firmware ${latest.version} (API ${latest.api}) or ${previous.version} (API ${previous.api}). The emulator runs ${latest.version} unless someone switched it; \`busy-emulator firmware\` says which.`,
    "",
    `Keep \`api_version\` in \`src/appmeta/manifest.json\` at ${previous.api}, so the app installs on ${previous.version}. Raise it to ${latest.api} only if the app uses one of these:`,
    "",
    "- `/api/storage`, with paths under `/ext/data`, the app's own folder.",
    "- `console.warn`.",
    "",
    `Other differences are in behavior, and \`api_version\` does not guard against them. On ${previous.version}:`,
    "",
    "- `fetch` refuses a URL with a space or a non-ASCII letter (`\"Invalid URL\"`). Encode such parts with `encodeURIComponent`.",
    `- \`fetch\` sends \`#...\` to the server and silently drops \`user:pw@\`. ${latest.version} does not send \`#...\` and refuses \`user:pw@\`.`,
    `- A network or body error rejects with a string; ${latest.version} rejects with a \`TypeError\`. \`String(e?.message ?? e)\` reads both.`,
    "- A response header with an empty value restarts the BUSY Bar (https://github.com/busy-app/busybar-emulator/issues/1).",
    "- A short Back clears the app's screen.",
    "",
    `Check the app on ${previous.version} too: \`busy-emulator firmware use previous\`, \`busy-emulator dev --once\`, a few seconds later \`busy-emulator logs --since-run\`, then \`busy-emulator firmware use latest\`. Tell the person that you switched.`,
    "",
  ];
}

/**
 * The emulator's section of a project's AGENTS.md. `typecheck`: the project has a typecheck script. `firmwares`: the
 * latest and the previous firmware, { version, api } each (sectionFirmwares, read from this emulator's engine).
 */
export function agentsSection({ typecheck = true, firmwares = sectionFirmwares() } = {}) {
  return [
    SECTION_BEGIN,
    "## No BUSY Bar needed: this project runs on BUSY Bar Emulator",
    "",
    "BUSY Bar Emulator created this project. It runs the BUSY Bar's firmware on this computer and has its own Node, npm and busy-cli, so use its command line for everything: do not run `npm`, `npx`, `node` or `tsc` yourself, and do not look for a BUSY Bar on USB. Where the rest of this file or `README.md` says `npm run ...`, use the command below.",
    "",
    "`busy-emulator` below is the command line's full path: `~/.busy-emulator/bin/busy-emulator` on macOS. On Windows it is `%LOCALAPPDATA%\\busy-emulator\\bin\\busy-emulator.exe`, called " +
      `in PowerShell as \`${WINDOWS_CALLS.powershell}\`, in Git Bash as \`${WINDOWS_CALLS.bash}\`, in cmd as \`${WINDOWS_CALLS.cmd}\`. ` +
      "A person's own busy-cli works against the emulator too (`--addr` with the address `busy-emulator status` prints). Run each command on its own, not joined with others. Every command takes `--json`; a failure has a `code`, a `message` and a `hint` that names the next command. None of this needs a question to the person: build, run, look at the screen, fix.",
    "",
    "| To | Run in this folder |",
    "| --- | --- |",
    "| Build, install and start the app after an edit | `busy-emulator dev --once` (exit code 0: the app runs) |",
    "| Only build; only install and start | `busy-emulator build`; `busy-emulator run` |",
    ...(typecheck ? ["| Check the types | `busy-emulator typecheck` |"] : []),
    "| Read the app's console: `console.log`, errors, why it ended | `busy-emulator logs` (this app's lines; `busy-emulator logs --since-run`: its latest launch only) |",
    "| See the screen | `busy-emulator screenshot --scale 8`, then read `screenshots/front-<n>@8x.png`; the back display: `busy-emulator screenshot --back --scale 4` |",
    "| Make a short video of the app for a post | `busy-emulator record` (5 s of the emulator's window, `media/clip-<n>.mp4`; `--layout post` the BUSY Bar alone, 1080x1920; `--gif` a GIF of the front display) |",
    "| Press a button or turn the wheel | `busy-emulator press ok` (also `start`, `back`, `up`, `down`; `--times 3`; `--hold 800` for a long press) |",
    "| Let time pass: a timer, a countdown, the hour | `busy-emulator time advance 25m` (the app's timers due in between fire now); `busy-emulator time set 14:59:50`; `busy-emulator time reset` |",
    "| Read or change the app's settings | `busy-emulator settings get`; `busy-emulator settings set hour24=false --restart` |",
    "| Stop the app | `busy-emulator stop` |",
    "| Restart BUSY Bar when the app froze it (no key helps) | `busy-emulator restart-bar` (like holding Back and Start; apps and settings stay) |",
    "| Make the app's icons | `busy-emulator icon --text AB` (one or two letters) or `busy-emulator icon --from picture.png` |",
    "| Get it ready for the app catalog (nothing is sent) | `busy-emulator catalog-texts set --category productivity --short-description \"...\" --description \"...\"` (`catalog-texts` lists the categories); `busy-emulator publish screenshots --take front` (and `--take back`); `busy-emulator publish readme set --intro \"...\" --controls '{\"Start\":\"...\",\"Wheel turn\":\"...\",\"Wheel press\":\"...\",\"Back\":\"...\"}'` (How to use, optional; or `--keep`, README.md as it is); `busy-emulator publish prepare --license MIT`, the person's license (LICENSE, .gitignore, build, the catalog's checks, submission/); `busy-emulator check` alone runs the checks; `busy-emulator publish status` says what is left |",
    "| Send it to the catalog | `busy-emulator publish signin` (`choose_account`: ask the person which account, then `busy-emulator publish signin --use-existing --user their-login`); `busy-emulator publish push`; `busy-emulator publish pr --ai none\\|partly\\|full` (the person's answer; with `partly` or `full` also `--ai-note \"...\"`, what AI made and what it does, written with the person). The person confirms each in the emulator's window |",
    "",
    "`catalog.json` (made by `busy-emulator check` or `catalog-texts`) holds the catalog's texts and screenshots of the app: `busy-emulator submit` writes the catalog's manifest from it, the catalog itself does not read it; commit it, so the next version starts from the same texts. The description may name a Markdown file of the app's folder instead, such as `@CATALOG.md`: the catalog takes only level 1–2 headings, bold, italic, lists and http(s) links there, so the README `publish readme` writes (a comment, a picture, code) will not do; a README written for the catalog will.",
    "Only the person may trust a folder, sign in and choose the GitHub account, choose the license and the AI usage, confirm the push and the pull request, and tick the catalog's author checklist: ask them, never choose, confirm or tick for them (`refused`: they chose Cancel; do not ask again). Every step's options: `busy-emulator help publish`.",
    "",
    "### The BUSY Bar's API in short",
    "",
    "- Draw: `await device.DisplayDraw({ application_name: manifest.id, priority: 50, elements })` (`device` from `@shared/device`). The front display is 72x16 in color; `display: \"back\"` puts an element on the back one, 160x80 in gray, whose right 12 px are the firmware's status bar. Every element has an `id` (drawing an `id` again replaces it; its `type` cannot change), `x`, `y`, `align` (`top_left`, `center`, `bottom_right` and the like) and `z_index` (0 or more; higher is on top). Colors are `#RRGGBBAA`. `device.DisplayClear({ application_name: manifest.id })` takes them all away.",
    "- Elements: `{ id, type: \"text\", text, font, color, x, y, align }` (ASCII; other letters may come out as a box); `{ id, type: \"rectangle\", x, y, width, height, fill: \"solid\", fill_colors: [\"#FF0000FF\"], border_width: 0 }`; `{ id, type: \"countdown\", timestamp: String(unixSeconds), direction: \"time_left\", show_hours: \"when_non_zero\" }`, which counts by itself.",
    "- Fonts, by these exact names, with their line height in px: `tiny` 6, `small` 9, `normal` 11, `condensed` 11, `bold` 11, `large` 13, `extra_large` 14 (capitals and digits only), `global` 11, `superscript` 11.",
    "- Layout (`render()`, `measure()`, `row`, `column`, `stack` from `@busy-app/busy-lib`) needs each font's metrics, and the build bundles them only for a font written as a string literal, `font: \"bold\"`, in a file under `src/`. A font from a variable, the short form `{ font }`, or a name only in `shared/` builds and then fails as the app runs: `font \"large\" has no metrics loaded`. For such a font add, once at the top of `src/main.ts`, only for the fonts it lays out (each takes about 9 KiB of the app's 128 KiB heap, `global` about 60 KiB; registering every font runs out of memory): `import { registerFontMaps } from \"@busy-app/busy-lib\"; import { large } from \"@busy-app/busy-lib/fonts\"; registerFontMaps(large);`. Elements placed by `x`, `y` and `align` without `render()` need no metrics. `busy-emulator build` warns about the cases it sees.",
    "- Input: `listen(\"input\", (event) => ...)` returns the function that detaches it. `ok`, `start`, `back`: `press`, `short`, `release`; held: `press`, `long`, `repeat` again and again, `release`. The wheel: `{ key: \"encoder\", action: \"clockwise\", delta: 1 }`, or `\"counterclockwise\"` and `-1`. A short Back should end the app, as the template's does.",
    "- Timers and time: `setTimeout`, `setInterval`, `Date.now()` (the BUSY Bar's clock); `busy-emulator time advance` moves all three, not the network.",
    "- Storage: `localStorage.getItem(key)` and `setItem(key, text)` keep strings across launches; a missing key gives `null`. The first run logs `[JsLocalStorage] Failed to open file`: harmless.",
    "- Catch every promise and `console.error` what it rejects with: a rejection nobody catches shows only as the emulator's `emulator:` note in `busy-emulator logs`.",
    "- A `device.*` call the BUSY Bar refuses rejects with `TypeError: Expected a function` (busy-lib calls `Response.clone()`, which the BUSY Bar lacks); the real reason is in `busy-emulator logs`.",
    "",
    "### Network and memory",
    "",
    "- `fetch`: `res.ok`, `res.status`, `res.json()`, `res.text()`, `res.body.getReader()`; a 404 resolves. A failure gives `\"socket error\"`, `\"Inactivity timeout\"` and the like; its type depends on the firmware (below). No `TextDecoder` or `TextEncoder`.",
    "- Redirects are not followed: a 301 or 302 reaches the app as it is. Use the final `https://` address; `busy-emulator logs` names it.",
    "- HTTPS takes about 1.5 s on a BUSY Bar, HTTP 0.1 s. Refresh no more often than the data changes.",
    "- 5 s without data, counted from the start, end a request with `\"Inactivity timeout\"`: a server slower than that fails. In a stream, `reader.read()` then gives `{ done: true, value: \"Inactivity timeout\" }`.",
    "- The heap is 128 KiB (`heap_size_kib` in the manifest, up to 512). `res.json()` fits about 70 KiB of JSON, `res.text()` about 120 KiB; more crashes the app. Ask small endpoints for only the fields you show (`?fields=`, open-meteo's `current=`); read a big body with `res.body.getReader()`, keeping only what you need, or cut text with `indexOf`.",
    "- This computer (`127.0.0.1`) is refused unless allowed: `busy-emulator allow-local 8080`.",
    "",
    "`not_running`: run `busy-emulator start` first. `untrusted_project` (a folder the emulator did not create): run `busy-emulator trust <folder>`, which asks the person in a dialog. Another project is made with `busy-emulator create <new-folder-name>`: a folder that does not exist yet, not `.` in a folder with files.",
    "",
    ...firmwareLines(firmwares),
    "### Settings",
    "",
    "`src/appmeta/settings.json` describes the app's settings; the BUSY Bar draws their screen and their web page itself. `busy-emulator build` checks the file and names the field at fault. The smallest valid file:",
    "",
    "```json",
    JSON.stringify(MINIMAL_EXAMPLE),
    "```",
    "",
    "`fields` is a map keyed by each field's id (lower-case letters, digits, `_`), not a list. Every field has `type`, `label` and `default`. The types: `boolean`; `integer` (optional `min`, `max`, `step`); `string` (optional `max_length`, 64 unless given); `enum` (`\"options\": [{ \"value\": \"a\", \"label\": \"A\" }]`, `default` is one of the values); `color` (`\"#RRGGBB\"`); `time` (`\"HH:MM\"`); `geolocation`; `group` (its own `fields`). Raise `version` to drop the values kept on the BUSY Bar.",
    "",
    "Read the values with `loadValues()` from `@shared/settings` (this project's copy asks the BUSY Bar's API, `GET /api/apps/settings`):",
    "",
    "```ts",
    'import { loadValues } from "@shared/settings";',
    "",
    "const values = (await loadValues()) ?? {};",
    "const hour24 = values.hour24 !== false;",
    "```",
    "",
    "The BUSY Bar answers with every field: the saved value, or the file's `default`. Read the settings when the app starts; after `busy-emulator settings set` start the app again (`--restart` does). An app cannot write its settings.",
    SECTION_END,
  ].join("\n");
}

/** The template's lines the emulator's commands replace, in the template's own part of the file. */
const TEMPLATE_LINES = [
  [
    "Read them with `loadValues()` from `@shared/settings` and fall back to the defaults in code when it returns `null`; persist with `saveValues()`.",
    "Read them with `loadValues()` from `@shared/settings` (the format and an example are in the emulator's section above); it returns `null` only when the app has no settings file or the BUSY Bar did not answer. An app cannot save its settings.",
  ],
];
const NPM_SCRIPTS = { build: "build", "app:install": "install", "app:run": "run", "app:stop": "stop" };

function rewriteTemplateLines(text, { typecheck }) {
  let out = text;
  for (const [from, to] of TEMPLATE_LINES) out = out.replace(from, to);
  for (const [script, command] of Object.entries({ ...NPM_SCRIPTS, ...(typecheck ? { typecheck: "typecheck" } : {}) })) {
    out = out.replaceAll(new RegExp(`\\bnpm run ${script}(?![\\w:-])`, "g"), `busy-emulator ${command}`);
  }
  return out;
}

/** Whether the project's package.json has a script for the TypeScript check. */
export function hasTypecheck(dir) {
  try {
    const script = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).scripts?.typecheck;
    return typeof script === "string" && script.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Puts the emulator's section into the project's AGENTS.md (making the file when the template brought none) and
 * rewrites the template's lines about `npm run …` and the settings helper. A file that has the section already is
 * left as it is.
 * @returns {"added" | "created" | "present"}
 */
export function writeAgentsSection(dir) {
  const file = path.join(dir, "AGENTS.md");
  const typecheck = hasTypecheck(dir);
  const section = agentsSection({ typecheck });
  if (!existsSync(file)) {
    writeFileSync(file, `# AGENTS.md\n\n${section}\n`);
    return "created";
  }
  const text = readFileSync(file, "utf8");
  if (text.includes(SECTION_BEGIN)) return "present";
  const rewritten = rewriteTemplateLines(text, { typecheck });
  // Before the template's first section, after its title and opening lines; at the end of a file without sections.
  const at = rewritten.search(/^## /m);
  const out = at < 0 ? `${rewritten.replace(/\n*$/, "\n\n")}${section}\n` : `${rewritten.slice(0, at)}${section}\n\n${rewritten.slice(at)}`;
  writeFileSync(file, out);
  return "added";
}

/** The sentence of the template's README about the helper, which the new helper makes untrue. */
const README_LINE = ["`loadValues()` returns `null` when nothing is stored yet — use the defaults.", "`loadValues()` asks the BUSY Bar, which answers with every field: the saved value, or the field's `default` from `settings.json`. It returns `null` only when the app has no settings file or the BUSY Bar did not answer."];

/** Everything `create` puts right in the new project. Never throws: a project that could not be fixed is still a project. */
export function fixTemplate(dir) {
  const done = { settings_helper: "failed", agents_md: "failed" };
  try {
    done.settings_helper = fixSettingsHelper(dir);
    if (done.settings_helper === "replaced") {
      const readme = path.join(dir, "README.md");
      if (existsSync(readme)) {
        const text = readFileSync(readme, "utf8");
        if (text.includes(README_LINE[0])) writeFileSync(readme, text.replace(README_LINE[0], README_LINE[1]));
      }
    }
  } catch {
    // Told in the answer as "failed".
  }
  try {
    done.agents_md = writeAgentsSection(dir);
  } catch {
    // Told in the answer as "failed".
  }
  return done;
}
