// Copies the apps installed on a bar into an emulator data folder, so that the apps menu lists the same apps on both
// (golden frames of the system screens need that). Reads the bar only.
//
//   node emulator/test/mirror-apps.mjs [--bar 10.0.4.20] [--data emulator/.data-golden] [--firmware 1.3.1]
//
// The apps go to the bar of every firmware the emulator has (bar/<firmware>/ext in the data folder, EMU-005), or of the
// one --firmware names, so that the same folder serves `--firmware dev` too.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../packages/server/arguments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
await commandLine(process.argv, { values: ["--bar", "--data", "--firmware"] });
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const bar = option("--bar", "10.0.4.20");
const data = resolve(option("--data", join(here, "../.data-golden")));
const firmwares = option("--firmware") ? [option("--firmware")] : Object.keys(JSON.parse(readFileSync(join(here, "../packages/engine/firmware.json"), "utf8")).versions);
const bars = firmwares.map((firmware) => join(data, "bar", firmware));

async function list(path) {
  const r = await fetch(`http://${bar}/api/storage/list?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`list ${path}: ${r.status}`);
  return (await r.json()).list ?? [];
}

async function copy(path) {
  for (const entry of await list(path)) {
    const child = `${path}/${entry.name}`;
    if (entry.type === "dir") {
      await copy(child);
      continue;
    }
    const r = await fetch(`http://${bar}/api/storage/read?path=${encodeURIComponent(child)}`);
    if (!r.ok) throw new Error(`read ${child}: ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    for (const bar of bars) {
      const target = join(bar, "ext", child.slice("/ext/".length));
      // For the user alone, as the emulator makes its own folders (packages/server/data-folder.mjs).
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes);
    }
  }
}

for (const bar of bars) rmSync(join(bar, "ext"), { recursive: true, force: true });
const apps = await list("/ext/user_assets");
console.log(`mirroring ${apps.length} apps from ${bar} into ${bars.join(", ")}`);
for (const app of apps) {
  await copy(`/ext/user_assets/${app.name}`);
  console.log(`  ${app.name}`);
}
