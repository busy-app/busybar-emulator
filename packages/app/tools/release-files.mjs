#!/usr/bin/env node
// The files of this package that go into a release: package.json and what its "files" names, nothing else. The
// packaging (EMU-203) takes its list from here, and the tests check the list — the test variant's folder, the tests
// and the tools are not in it.
//   node tools/release-files.mjs        prints the list
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function walk(folder, base) {
  const out = [];
  for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    // Files the system leaves behind (macOS on exFAT and FAT disks) are never part of a release.
    if (entry.name.startsWith("._") || entry.name === ".DS_Store") continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
    else throw new Error(`Not a regular file in the release: ${full}`);
  }
  return out;
}

/** Paths relative to the package, with forward slashes, sorted. */
export function releaseFiles(appDir = APP_DIR) {
  const manifest = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));
  const out = ["package.json"];
  for (const name of manifest.files) out.push(...walk(path.join(appDir, name), appDir));
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(releaseFiles().join("\n"));
