#!/usr/bin/env node
// The license summary of the app (EMU-255; ADR-0003 §4): THIRD_PARTY_NOTICES.md in the app's resources folder. The
// packaging writes it into every build and the release check compares it with what this produces, so it is never
// written by hand and never older than the build: it is made from the files the build ships with — the engine's
// firmware.json and build-info.json, libraries.json and texts/ (refresh.mjs, from the firmware checkout), the app's
// package.json and the pinned Node. If they disagree (a library added to build.mjs, a firmware added without a
// refresh) it throws, and the build stops.
//
//   node tools/notices/notices.mjs [darwin|win32] [<commit>]     prints it
//
// The firmware's own parts are the firmware's, by its REUSE.toml; the owner's decision of 11 Nov 2026 (ADR-0003)
// says how the emulator distributes them: our code and the firmware's local web under GPL-2.0-or-later, mongoose
// under GPLv2, the firmware's assets with the attribution "© Flipper FZCO, CC BY-SA 4.0".
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ENGINE_DIR, firmwarePathsOfBuild } from "./build-paths.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..", "..");

export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";
/** The public repository of the emulator (ADR-0002; names accepted on 10 Nov 2026). */
export const EMULATOR_REPOSITORY = "https://github.com/busy-app/busybar-emulator";
export const COPYRIGHT = "Copyright (C) 2026 Flipper FZCO";
export const ASSETS_ATTRIBUTION = "\u00a9 Flipper FZCO, CC BY-SA 4.0";
/** The BUSY Apps Catalog, whose checks the command line runs, and the copyright line of its MIT license. */
export const CATALOG_REPOSITORY = "https://github.com/busy-app/busy-apps-catalog";
export const CATALOG_COPYRIGHT = "Copyright (c) 2026 Flipper Devices";

const LICENSE_NAMES = Object.freeze({
  "GPL-2.0-or-later": "GNU General Public License v2.0 or later",
  "GPL-2.0-only": "GNU General Public License v2.0 only",
  "Apache-2.0": "Apache License 2.0",
  MIT: "MIT License",
  Zlib: "zlib License",
  "BSD-2-Clause": 'BSD 2-Clause "Simplified" License',
  "MIT OR Unlicense": "MIT License or the Unlicense (public domain), at your choice",
  "MIT OR NCSA": "MIT License or the University of Illinois/NCSA Open Source License",
  "CC-BY-SA-4.0": "Creative Commons Attribution-ShareAlike 4.0 International",
  "OFL-1.1": "SIL Open Font License 1.1",
  ISC: "ISC License",
  // Not an open-source license: the license of the Tride players, whose text is printed below like the others.
  "LicenseRef-Tride-Players-1.2": "Tride Players Licence 1.2",
  // No license at all: a work of the emulator's own copyright holder, shipped by it.
  "LicenseRef-Flipper-FZCO": "All rights reserved; shipped in the emulator by its copyright holder",
});

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const short = (commit) => commit.slice(0, 8);
const copyright = (lines) => lines.map((c) => `\u00a9 ${c}`).join("; ");
/** The notes refresh.mjs records on licenses it does not take from REUSE.toml as written (REUSE_FIXES), once each. */
const notesOf = (entries) => [...new Set(entries.map((e) => e.note).filter(Boolean))].map((n) => `\n\nNote: ${n}`).join("");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** Where Electron's and Node's license files lie in an installed app. */
function placesOf(platform) {
  if (platform === "darwin") {
    const r = "BUSY Bar Emulator.app/Contents/Resources";
    return { notices: `${r}/${NOTICES_FILE}`, electron: `${r}/LICENSE`, chromium: `${r}/LICENSES.chromium.html`, node: `${r}/node/LICENSE`, gh: `${r}/gh/LICENSE` };
  }
  if (platform === "win32") return { notices: `resources\\${NOTICES_FILE}`, electron: "LICENSE", chromium: "LICENSES.chromium.html", node: "resources\\node\\LICENSE", gh: "resources\\gh\\LICENSE" };
  // The source repository (the export, EMU-164): it holds none of them; each built app does, in both places.
  if (platform === "source") {
    const [mac, win] = [placesOf("darwin"), placesOf("win32")];
    return { source: true, ...Object.fromEntries(Object.keys(mac).map((k) => [k, [mac[k], win[k]]])) };
  }
  throw new Error(`No app is built for ${platform}`);
}

/** A place of an installed app, as code; in the source repository's summary, the place on macOS and on Windows. */
const place = (p) => (Array.isArray(p) ? `\`${p[0]}\` on macOS, \`${p[1]}\` on Windows, in a built app` : `\`${p}\``);

/**
 * What the summary is made of, checked against itself: throws when libraries.json is older than the engine's
 * firmware list, its build records or build.mjs.
 */
export function noticeSources({ appDir = APP_DIR, engineDir = ENGINE_DIR, buildSource } = {}) {
  const libraries = json(path.join(HERE, "libraries.json"));
  const firmware = json(path.join(engineDir, "firmware.json"));
  const stale = [];
  const paths = firmwarePathsOfBuild(buildSource);
  const infos = {};
  for (const [v, { commit }] of Object.entries(firmware.versions)) {
    const record = libraries.firmware[v];
    const info = (infos[v] = json(path.join(engineDir, "build", v, "build-info.json")));
    if (!record) {
      stale.push(`firmware ${v} is not in libraries.json`);
      continue;
    }
    if (record.commit !== commit || info.commit !== commit) stale.push(`firmware ${v}: firmware.json says ${short(commit)}, build-info.json ${short(info.commit)}, libraries.json ${short(record.commit)}`);
    if (record.libraries.jerryscript?.commit !== info.jerryscript) stale.push(`firmware ${v}: the modules were built with JerryScript ${short(info.jerryscript)}, libraries.json names ${short(record.libraries.jerryscript?.commit ?? "none")}`);
    if (record.libraries.lvgl?.commit !== info.lvgl) stale.push(`firmware ${v}: the modules were built with LVGL ${short(info.lvgl)}, libraries.json names ${short(record.libraries.lvgl?.commit ?? "none")}`);
    if (record.web.tree !== info.web.tree) stale.push(`firmware ${v}: the local web is git tree ${short(info.web.tree)}, libraries.json says ${short(record.web.tree)}`);
    const recorded = Object.keys(record.compiled).sort();
    const missing = paths.filter((p) => !recorded.includes(p));
    const gone = recorded.filter((p) => !paths.includes(p));
    if (missing.length || gone.length) stale.push(`firmware ${v}: build.mjs takes from the firmware ${missing.length ? `${missing.join(", ")}, which libraries.json does not name` : ""}${missing.length && gone.length ? "; " : ""}${gone.length ? `no longer ${gone.join(", ")}` : ""}`);
    for (const id of new Set(Object.values(record.compiled))) if (!id.startsWith("firmware") && !libraries.libraries.some((l) => l.id === id)) stale.push(`firmware ${v}: ${id} is not a library of libraries.json`);
  }
  for (const v of Object.keys(libraries.firmware)) if (!firmware.versions[v]) stale.push(`libraries.json names firmware ${v}, which firmware.json does not have`);
  if (libraries.emscripten.version !== firmware.emscripten) stale.push(`libraries.json has the texts of Emscripten ${libraries.emscripten.version}, the modules are built with ${firmware.emscripten}`);
  const assets = json(path.join(engineDir, "apps-assets.json"));
  const counted = libraries.assets.reduce((n, g) => n + g.files, 0);
  if (counted !== Object.keys(assets.files).length) stale.push(`apps-assets.json lists ${Object.keys(assets.files).length} files, libraries.json counts ${counted}`);
  if (stale.length) throw new Error(`The license summary is older than what the build ships; run node tools/notices/refresh.mjs with the firmware checkout:\n  ${stale.join("\n  ")}`);
  const texts = {};
  for (const name of libraries.texts) texts[name] = readFileSync(path.join(HERE, "texts", name), "utf8");
  const app = json(path.join(appDir, "package.json"));
  const node = json(path.join(appDir, "bundled-node.json")).version;
  const gh = json(path.join(appDir, "bundled-gh.json")).version;
  // What the app itself carries besides the firmware's parts (app-libraries.json, by hand): each with its file in the
  // app and its license text.
  const own = json(path.join(HERE, "app-libraries.json")).libraries;
  for (const lib of own) {
    if (!LICENSE_NAMES[lib.license]) throw new Error(`app-libraries.json: ${lib.id} has a license the summary has no name for: ${lib.license}`);
    const file = path.join(appDir, "..", "..", ...lib.file.split("/"));
    if (!/^packages\/(app|stage|engine)\//.test(lib.file) || !existsSync(file)) throw new Error(`app-libraries.json: ${lib.id} names ${lib.file}, which the app does not have`);
    // A part without a license text of its own (a work of the emulator's own copyright holder) has none to print.
    if (lib.text) texts[`app/${lib.text}`] = readFileSync(path.join(HERE, "app-texts", lib.text), "utf8");
  }
  return { libraries, firmware, infos, texts, app, node, gh, electron: app.devDependencies.electron, own };
}

/** A license text, under its heading. The MIT text of REUSE.toml is a template: its copyright line is filled in. */
function textSection(title, body) {
  return `### ${title}\n\n\`\`\`\n${body.trimEnd()}\n\`\`\``;
}

/**
 * THIRD_PARTY_NOTICES.md for an app of one system, built from one commit.
 * @param {{ platform: "darwin" | "win32", commit?: string }} o
 */
export function noticesText({ platform, commit, sources = noticeSources() }) {
  const { libraries, firmware, infos, texts, app, node, gh, electron, own: ownLibraries = [] } = sources;
  const places = placesOf(platform);
  const byId = Object.fromEntries(libraries.libraries.map((l) => [l.id, l]));
  const fwUrl = (c, p = "") => `${libraries.firmwareRepository}/tree/${c}${p ? `/${p}` : ""}`;
  const out = [];
  out.push(`# ${app.productName}: licenses and sources`);
  out.push(`${app.productName} ${app.version}${commit ? `, built from commit ${commit} of the emulator's internal repository` : ""}.\n${COPYRIGHT}.`);
  out.push(`This file lists what the app is made of, under which license each part is, and where the source of each part is. It is generated by the build (\`packages/app/tools/notices/notices.mjs\`); ${places.source ? `this copy is the one at the root of the source repository, written by the export; every built app carries its own (\`${places.notices[0]}\` on macOS, \`${places.notices[1]}\` on Windows)` : `in an installed app it is ${place(places.notices)}`}.`);

  out.push("## The emulator");
  out.push(
    `The emulator's own code — the server, the stubs, patches and build scripts of its WebAssembly modules, the desktop shell and the device window — is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 2 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License, whose text is at the end of this file, for more details.`,
  );
  out.push(`SPDX-License-Identifier: GPL-2.0-or-later. ${COPYRIGHT}.`);

  out.push("## Getting the sources");
  out.push(
    [
      // The public repository is exported from the internal one without its history (ADR-0015): the build's commit is
      // never there, the release tag of this version is (review of EMU-255, M1).
      `- **The emulator:** ${EMULATOR_REPOSITORY}/tree/v${app.version}, the release tag of this version in the public repository.${commit ? ` The app was built from commit \`${commit}\` of the internal repository the public one is exported from; the app's \`build.json\` records it.` : ""} The sources of the WebAssembly modules are there: the stubs (\`packages/engine/native\`), the changes made to the firmware's code (\`packages/engine/patches.mjs\`) and the build script (\`packages/engine/build.mjs\`), which builds the modules from the firmware commits below.`,
      `- **The firmware:** ${libraries.firmwareRepository}, with its submodules at the commits listed below.`,
      "- The source code of the release is offered from the same place as the release itself.",
    ].join("\n"),
  );

  out.push("## The firmware inside the emulator");
  out.push(
    `The emulator runs code of the BUSY Bar firmware, compiled to WebAssembly (\`runtime.wasm\`: the JavaScript runtime; \`screen.wasm\`: the displays, the GUI and the system programs), with Emscripten ${firmware.emscripten}. The firmware's own code is ${LICENSE_NAMES[libraries.firmware[firmware.default].firmware.license]} (${copyright(libraries.firmware[firmware.default].firmware.copyright)}), by the firmware's REUSE.toml.`,
  );
  for (const [v, { summary }] of Object.entries(firmware.versions)) {
    const record = libraries.firmware[v];
    const info = infos[v];
    out.push(`### Firmware ${v}${v === firmware.default ? " (the default)" : ""}`);
    out.push(`${summary}\n\nCommit [\`${record.commit}\`](${fwUrl(record.commit)}), API ${info.api}. Its build in the app: \`packages/engine/build/${v}\`.`);
    const rows = Object.entries(record.libraries).map(([id, l]) => {
      const lib = byId[id];
      const license = lib.license ?? l.license;
      const where = l.in === "the firmware's own tree" ? `firmware \`${short(l.commit)}\`` : `\`${l.in}\` at \`${short(l.commit)}\``;
      return [`[${lib.name}](${lib.upstream ?? fwUrl(record.commit, l.source ?? lib.paths[0])})`, l.version ?? "—", where, lib.modules.map((m) => `${m}.wasm`).join(", "), license + (l.copyright ? ` (${copyright(l.copyright)})` : "")];
    });
    out.push(`Libraries and parts compiled into the modules, by the paths \`build.mjs\` takes from the firmware:\n\n${table(["Library", "Version", "Source", "In", "License"], rows)}`);
    for (const lib of libraries.libraries) if (lib.note && record.libraries[lib.id]) out.push(`${lib.name}: ${lib.note}`);
    const w = record.web;
    const fonts = w.fonts.map((f) => [`\`${f.file}\``, `\`${f.source}\``, `${f.license} (${copyright(f.copyright)})`]);
    out.push(
      `**Local web.** \`packages/engine/build/${v}/web\` is the firmware's built local web, \`${w.from}\` of this commit (git tree \`${short(w.tree)}\`, ${w.files} files), unchanged; ${LICENSE_NAMES[w.license]} (${copyright(w.copyright)}). Its source is [\`${w.source}\`](${fwUrl(record.commit, w.source)}) at this commit. It is built with the JavaScript libraries \`${w.source}/package.json\` names at this commit, in the versions \`${w.source}/pnpm-lock.yaml\` resolves them to; the code of those it depends on at run time, and of what they depend on, is bundled into its files (the full list of packages is in the lockfile). Each library's license, as its own \`package.json\` declares it; its license text comes with the package:\n\n${table(["Library", "Version", "In package.json", "License"], w.dependencies.map((d) => [`[${d.name}](${d.upstream})`, d.version, d.kind, d.license]))}\n\nIts fonts, licensed as the files they are copies of:\n\n${table(["File", "Copy of", "License"], fonts)}${notesOf(w.fonts)}`,
    );
  }

  out.push("## The firmware's assets");
  const groups = libraries.assets.map((g) => [String(g.files), g.sources.map((s) => `\`${s}\``).join(", "), `${g.license} (${copyright(g.copyright)})`]);
  out.push(
    `\`packages/engine/build/apps-assets\` holds the images, animations, sounds and fonts the firmware's GUI and system programs read, made from these files of the firmware at commit \`${short(libraries.firmware[firmware.default].commit)}\` (\`packages/engine/apps-assets.json\` names the source of each), licensed as the firmware's REUSE.toml says:\n\n${table(["Files", "Made from", "License"], groups)}${notesOf(libraries.assets)}`,
  );
  out.push(`The firmware's graphics, animations and sounds under CC BY-SA 4.0: ${ASSETS_ATTRIBUTION}. https://creativecommons.org/licenses/by-sa/4.0/`);
  const internal = libraries.firmware[firmware.default].libraries["internal-images"];
  out.push(`The images compiled into \`screen.wasm\` are made from \`${internal.source}\` of the firmware: ${internal.license} (${copyright(internal.copyright)}).`);
  if (libraries.copies.length) out.push(`Files of the emulator that are copies of the firmware's:\n\n${table(["File", "Copy of", "License"], libraries.copies.map((c) => [`\`${c.file}\``, `\`${c.source}\``, `${c.license} (${copyright(c.copyright)})`]))}`);

  out.push("## The BUSY Apps Catalog's checks");
  out.push(
    `The command line's \`check\`, \`submit\` and \`screenshot\` run the checks of the BUSY Apps Catalog. Three files come from the catalog's repository (${CATALOG_REPOSITORY}), whose tools are under the MIT License (${CATALOG_COPYRIGHT}): \`packages/server/capture/catalog-png.mjs\` is a port of its \`tools/check_png.py\`; \`packages/server/readiness/rules.mjs\` holds the ids, limits and patterns of its checks and its table of license texts; \`packages/server/readiness/catalog-registry.json\` is a copy of its check registry, the titles and texts of its checks, published with the permission of Flipper FZCO. The two code files carry the MIT notice in full; the text of the MIT License is below.`,
  );

  out.push("## The BUSY icons and the emulator's icon");
  out.push(
    "The icons of the device window (`packages/server/legacy-window/icons/busy/*.svg`, their list `icons/busy/index.json`, and all of them in one file, `icons/busy-sprite.svg`) are the interface icons of BUSY's identity: Copyright Flipper FZCO, BUSY identity icons, published with its permission. The marks of other companies that BUSY's set shows next to them are not among these files.",
  );
  out.push(
    "The pictures of the BUSY Bar's controls (`packages/server/legacy-window/icons/controls/*.svg`: Start, the wheel turned and pressed, Back) are BUSY's, from the Control badge of the catalog's app page: Copyright Flipper FZCO, BUSY identity, published with its permission.",
  );
  out.push(
    "The emulator's icon (`packages/app/icon/emulator-icon.svg`, BUSY's drawing of the BUSY logo on a blueprint grid) and the files made from it (the app's icon `packages/app/icon/emulator.icns` and `emulator.ico`, `packages/app/src/assets/app-icon.png`, `packages/app/src/pages/shell/icon.png`, `packages/server/legacy-window/icons/emulator-logo.svg` and `emulator-logo-32.png`, `emulator-logo-64.png`, `public-docs/images/emulator-logo.png`): Copyright Flipper FZCO, BUSY identity, published with its permission. The word BUSY and the BUSY logo are trademarks of Flipper FZCO.",
  );

  if (ownLibraries.length) {
    out.push("## Other parts of the app");
    for (const lib of ownLibraries) {
      out.push(`**[${lib.name}](${lib.upstream}).** \`${lib.file}\`: ${lib.what}. Taken from ${lib.from}. ${LICENSE_NAMES[lib.license]} (${copyright(lib.copyright)}).${lib.note ? ` ${lib.note}` : ""}`);
    }
  }

  out.push("## Electron, Chromium, Node.js and GitHub CLI");
  out.push(
    [
      `- **Electron ${electron}** (MIT License): the app's shell. Its license: ${place(places.electron)}.`,
      `- **Chromium** inside Electron, with the licenses of the libraries it carries: ${place(places.chromium)}.`,
      `- **Node.js ${node}** (MIT License, with the licenses of the libraries it bundles, npm among them): runs the emulator's server. Its license: ${place(places.node)}.`,
      ...(gh ? [`- **GitHub CLI ${gh}** (MIT License): publishes apps to GitHub (Other parts of the app, above). Its license: ${place(places.gh)}, and below.`] : []),
      `- **Emscripten ${libraries.emscripten.version}** (${LICENSE_NAMES[libraries.emscripten.license]}): its runtime code and C library are part of the WebAssembly modules. Its licenses, with those of ${libraries.emscripten.parts.slice(1).join(" and ")}, are below.`,
    ].join("\n"),
  );

  out.push("## License texts");
  const sections = [];
  const want = new Map();
  const add = (name, title) => {
    if (!want.has(name)) want.set(name, title);
  };
  const own = libraries.firmware[firmware.default].libraries;
  const gpl = libraries.libraries.filter((l) => /^GPL-2\.0/.test(l.license ?? own[l.id]?.license ?? "")).map((l) => l.name);
  add("GPL-2.0-or-later.txt", `GNU General Public License, version 2 (the emulator, the firmware's own code and its local web, ${gpl.join(", ")})`);
  for (const lib of libraries.libraries) if (lib.text) add(lib.text, `${lib.name} (${lib.license})`);
  for (const spdx of ["MIT", "CC-BY-SA-4.0", "OFL-1.1"]) {
    const users = [];
    for (const lib of libraries.libraries) if (!lib.text && Object.values(libraries.firmware).some((r) => r.libraries[lib.id]?.license === spdx)) users.push(lib.name);
    if (spdx !== "MIT") users.push("the firmware's assets and fonts listed above");
    else users.push("the BUSY Apps Catalog's checks");
    if (`${spdx}.txt` in texts) add(`${spdx}.txt`, `${LICENSE_NAMES[spdx]} (${users.join(", ")})`);
  }
  add("emscripten.txt", `Emscripten (${libraries.emscripten.license})`);
  // A license that is no SPDX one is named by its name, not by its "LicenseRef-" key.
  for (const lib of ownLibraries) if (lib.text) add(`app/${lib.text}`, `${lib.name} (${lib.license.startsWith("LicenseRef-") ? LICENSE_NAMES[lib.license] : lib.license})`);
  for (const [name, title] of want) {
    let body = texts[name];
    if (body === undefined) throw new Error(`texts/${name} is missing`);
    // REUSE's MIT text is the template; the parts under it are the firmware's own.
    if (name === "MIT.txt") {
      const holders = [...new Set(libraries.libraries.filter((l) => !l.text && own[l.id]?.license === "MIT").flatMap((l) => own[l.id].copyright))];
      body = body.replace("Copyright (c) <year> <copyright holders>", [...holders.map((h) => `Copyright (c) ${h}`), CATALOG_COPYRIGHT].join("\n"));
    }
    sections.push(textSection(title, body));
  }
  out.push(sections.join("\n\n"));
  return `${out.join("\n\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [platform = process.platform, commit] = process.argv.slice(2);
  process.stdout.write(noticesText({ platform, commit }));
}
