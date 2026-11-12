// A project as `busy-emulator create` makes it from the official template and an author finishes it for the catalog,
// written by hand for the tests: the template's files (package.json, src/appmeta/manifest.json, src/main.ts), a lock
// file, a license, screenshots as `busy-emulator screenshot` names them, catalog.json, a built package as busy-cli
// packs it, and a git repository's own files with a GitHub remote. No network, no git and no build are needed.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { targz } from "../../../../test/package.mjs";

export const ID = "io.github.jane-doe.desk_clock";
export const COMMIT = "0123456789abcdef0123456789abcdef01234567";

export const MIT = `MIT License

Copyright (c) 2026 Jane Doe

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** A PNG of `width`×`height`, 8-bit RGB, one color; `extra` are chunks [kind, bytes] put before the image data. */
export function pngOf(width, height, { color = [255, 80, 0], extra = [], depth = 8 } = {}) {
  const chunk = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = 2;
  const sample = depth / 8;
  const row = Buffer.alloc(1 + width * 3 * sample);
  for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) row[1 + (x * 3 + c) * sample] = color[c];
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), ...extra.map(([kind, data]) => chunk(kind, data)), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export const MANIFEST = Object.freeze({ format_version: 1, id: ID, name: "Desk Clock", version: "0.1.0", api_version: "27.12.0", description: "A clock for the desk", author: "Jane Doe" });

export const DETAILS = Object.freeze({
  category: "clocks",
  short_description: "A large clock with the date for the desk.",
  description: "# Desk Clock\n\nA **large** clock with the date.\n\n- Wheel: brightness\n- OK: 12 or 24 hours\n\nMore at [the project's page](https://github.com/jane-doe/desk-clock).",
  changelog: "The first public version.",
});

const MAIN = 'import { tick } from "./lib/tick.js";\ntick();\n';
const TICK = "export function tick() { return Date.now(); }\n";

/** The files of the built package, by their paths under the id's folder. */
export function builtFiles(manifest = MANIFEST, more = {}) {
  return { "appmeta/manifest.json": JSON.stringify(manifest, null, 2), "appmeta/icon_front_8x8.png": pngOf(8, 8), "scripts/main.js": MAIN, "scripts/lib/tick.js": TICK, ...more };
}

function write(dir, name, data) {
  const file = path.join(dir, ...name.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
}

/** Writes dist/<id>.tgz of the project from `files` (paths under the id's folder; a null takes one away). */
export function writePackage(dir, files = builtFiles(), id = ID) {
  const entries = Object.fromEntries(Object.entries(files).filter(([, data]) => data !== null).map(([name, data]) => [`${id}/${name}`, data]));
  write(dir, `dist/${id}.tgz`, targz(entries));
}

/** Writes the git repository's own files: a commit on main, origin on GitHub, origin/main at that commit. */
export function writeGit(dir, { remote = "https://github.com/jane-doe/desk-clock.git", commit = COMMIT, pushed = true } = {}) {
  write(dir, ".git/HEAD", "ref: refs/heads/main\n");
  write(dir, ".git/refs/heads/main", `${commit}\n`);
  write(dir, ".git/config", `[core]\n\trepositoryformatversion = 0\n${remote ? `[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""}`);
  if (pushed && remote) write(dir, ".git/refs/remotes/origin/main", `${commit}\n`);
}

/**
 * git's index as `git add` leaves it, with `paths` (from the repository's top) in it. `version` 2, 3 or 4; in
 * version 3 and 4 a path of `intent` is added only as an intention (git add -N).
 */
export function gitIndex(paths, { version = 2, intent = [] } = {}) {
  const names = [...paths].map((name) => Buffer.from(name, "utf8")).sort(Buffer.compare);
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(version, 4);
  header.writeUInt32BE(names.length, 8);
  const parts = [header];
  let previous = Buffer.alloc(0);
  for (const name of names) {
    const extended = version >= 3 && intent.includes(name.toString("utf8"));
    const fixed = Buffer.alloc(62 + (extended ? 2 : 0));
    fixed.writeUInt32BE(0o100644, 24);
    fixed.writeUInt16BE(Math.min(name.length, 0xfff) | (extended ? 0x4000 : 0), 60);
    if (extended) fixed.writeUInt16BE(0x2000, 62);
    if (version === 4) {
      let same = 0;
      while (same < previous.length && same < name.length && previous[same] === name[same]) same++;
      const cut = previous.length - same;
      if (cut > 127) throw new Error("the fixture writes only short cuts");
      parts.push(fixed, Buffer.from([cut]), name.subarray(same), Buffer.from([0]));
    } else {
      const length = fixed.length + name.length;
      parts.push(fixed, name, Buffer.alloc(8 - (length % 8)));
    }
    previous = name;
  }
  // An extension, as git writes its cache of trees there, then the checksum (which nothing here verifies).
  const extension = Buffer.alloc(8 + 3);
  extension.write("TREE", 0, "latin1");
  extension.writeUInt32BE(3, 4);
  parts.push(extension, Buffer.alloc(20));
  return Buffer.concat(parts);
}

/** Writes git's index for a project made by makeProject: every file of it, or `paths`. */
export function writeIndex(dir, paths, options) {
  write(dir, ".git/index", gitIndex(paths, options));
}

/** The files makeProject writes that an author commits: all of them but what .gitignore names. */
export const COMMITTED = Object.freeze(["package.json", "package-lock.json", "src/appmeta/manifest.json", "src/appmeta/icon_front_8x8.png", "src/main.ts", "src/lib/tick.ts", "LICENSE", "screenshots/front-1.png", "screenshots/front-2.png", "screenshots/front-1@8x.png", "screenshots/back-1.png", "catalog.json", ".gitignore"]);

/**
 * A finished project in `dir`: nothing of the catalog's checks fails for it. `change(files)` may alter the files
 * before they are written (set one to null to leave it out); `built` and `git` likewise, or false for none.
 */
export function makeProject(dir, { files: change = null, built = builtFiles(), git = {} } = {}) {
  const files = {
    "package.json": JSON.stringify({ name: "desk-clock", private: true, version: "0.1.0", description: "A clock for the desk", author: "Jane Doe", type: "module", scripts: { build: "busy-cli build" }, devDependencies: { "@busy-app/cli": "^0.6.0", typescript: "~6.0.3", vite: "8.1.4" }, dependencies: { "@busy-app/busy-lib": "^0.21.1" } }, null, 2),
    "package-lock.json": JSON.stringify({ name: "desk-clock", version: "0.1.0", lockfileVersion: 3, packages: { "": { name: "desk-clock" }, "node_modules/@busy-app/cli": { version: "0.6.0", dev: true } } }, null, 2),
    "src/appmeta/manifest.json": JSON.stringify(MANIFEST, null, 2),
    "src/appmeta/icon_front_8x8.png": pngOf(8, 8),
    "src/main.ts": 'import { tick } from "./lib/tick";\ntick();\n',
    "src/lib/tick.ts": TICK,
    LICENSE: MIT,
    "screenshots/front-1.png": pngOf(72, 16),
    "screenshots/front-2.png": pngOf(72, 16, { color: [0, 120, 255] }),
    "screenshots/front-1@8x.png": pngOf(576, 128),
    "screenshots/back-1.png": pngOf(160, 80, { color: [200, 200, 200] }),
    "catalog.json": JSON.stringify(DETAILS, null, 2),
    ".gitignore": "node_modules\ndist\n",
  };
  change?.(files);
  for (const [name, data] of Object.entries(files)) if (data !== null) write(dir, name, data);
  if (built) writePackage(dir, built);
  if (git) writeGit(dir, git);
  return dir;
}
