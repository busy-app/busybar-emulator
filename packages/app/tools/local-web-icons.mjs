#!/usr/bin/env node
// Writes src/icons/lucide.json: the Lucide icons the firmware's local web asks Iconify for, in Iconify's own format
// (EMU-209). The local web is built with the icon provider "iconify": the icons it names as "i-lucide-<name>" are
// fetched from api.iconify.design while the page runs. The app's windows have no network, so the app carries those
// icons and answers the page itself (src/icons.mjs).
//
//   node tools/local-web-icons.mjs <icons.json of @iconify-json/lucide>     writes the file
//   node tools/local-web-icons.mjs --names                                  prints the names the local webs ask for
//
// The names are found in every firmware build of the engine (packages/engine/build/<firmware>/web/_nuxt/*.js). A unit
// test (test/unit/icons.test.mjs) fails when a build names an icon the file does not have: run this again then, and
// update the version in tools/notices/app-libraries.json.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ICONS_FILE = path.resolve(HERE, "..", "src", "icons", "lucide.json");
const BUILDS = path.resolve(HERE, "..", "..", "engine", "build");

/** The Lucide icons the local webs of the engine's builds name, sorted; null where there are no builds (a packed app). */
export function namesInBuilds(builds = BUILDS) {
  if (!existsSync(builds)) return null;
  const names = new Set();
  for (const firmware of readdirSync(builds)) {
    const nuxt = path.join(builds, firmware, "web", "_nuxt");
    if (!existsSync(nuxt)) continue;
    for (const file of readdirSync(nuxt).filter((f) => f.endsWith(".js"))) {
      for (const match of readFileSync(path.join(nuxt, file), "latin1").matchAll(/\bi-lucide[-:]([a-z0-9]+(?:-[a-z0-9]+)*)/g)) names.add(match[1]);
    }
  }
  return [...names].sort();
}

/** The part of an Iconify icon set that holds these icons (an alias brings the icon it stands for). */
export function subsetOf(set, names) {
  const out = { prefix: set.prefix, lastModified: set.lastModified, icons: {}, width: set.width, height: set.height };
  const missing = [];
  const take = (name, depth = 0) => {
    if (Object.hasOwn(set.icons, name)) out.icons[name] = set.icons[name];
    else if (Object.hasOwn(set.aliases ?? {}, name) && depth < 5) {
      (out.aliases ??= {})[name] = set.aliases[name];
      take(set.aliases[name].parent, depth + 1);
    } else missing.push(name);
  };
  for (const name of names) take(name);
  if (missing.length) throw new Error(`The icon set has no ${missing.join(", ")}`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const names = namesInBuilds();
  if (!names) throw new Error(`No firmware builds in ${BUILDS}`);
  if (process.argv[2] === "--names" || !process.argv[2]) {
    console.log(names.join("\n"));
  } else {
    const set = JSON.parse(readFileSync(path.resolve(process.argv[2]), "utf8"));
    if (set.prefix !== "lucide") throw new Error(`Not the Lucide set: ${set.prefix}`);
    writeFileSync(ICONS_FILE, `${JSON.stringify(subsetOf(set, names), null, 1)}\n`);
    console.log(`${ICONS_FILE}: ${names.length} icons`);
  }
}
