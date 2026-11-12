#!/usr/bin/env node
// Makes every file of the emulator's icon from the one master drawing, icon/emulator-icon.svg (tools/app-icon/art.mjs
// says how the picture is simplified for small sizes). Run on a Mac, after a change of the master or of art.mjs, and
// commit what it writes; the builds and the pages only read the files.
//
//   node tools/app-icon.mjs                  writes the files below
//   node tools/app-icon.mjs --sheet <png>    also a sheet of every size on white and on black, to look at
//
//   icon/emulator.icns                                          the macOS app's icon: 16 to 512 points, each also @2x
//   icon/emulator.ico                                           Windows: the app, the setup and uninstaller, the
//                                                               command line's entry (16 20 24 32 40 48 64 256)
//   src/assets/app-icon.png                                     the windows' icon outside macOS (256)
//   src/pages/shell/icon.png                                    the icon of the shell's own page (32)
//   ../server/legacy-window/icons/emulator-logo.svg             the mark for the device window, as a drawing
//   ../server/legacy-window/icons/emulator-logo-{32,64}.png     the same as pictures; 32 is also the page's icon
//   ../../public-docs/images/emulator-logo.png                  the logo of the documents (256)
//
// The pictures are drawn by the Electron this package has installed (node node_modules/electron/install.js), and
// the .icns is put together by macOS's iconutil.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ICO_SIZES, ICONSET, iconSvg, masterParts, writeIco } from "./app-icon/art.mjs";
import { ICNS_SOURCE as ICNS_FILE, ICO_SOURCE as ICO_FILE } from "./packaging/icon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.dirname(HERE);
const EMULATOR_DIR = path.resolve(APP_DIR, "..", "..");

export { ICNS_FILE, ICO_FILE };
/** Every file this tool writes, by what it is: { file, shape, size } for a picture. */
export const PICTURES = Object.freeze([
  { file: path.join(APP_DIR, "src", "assets", "app-icon.png"), shape: "tile", size: 256 },
  { file: path.join(APP_DIR, "src", "pages", "shell", "icon.png"), shape: "tile", size: 32 },
  { file: path.join(EMULATOR_DIR, "packages", "server", "legacy-window", "icons", "emulator-logo-32.png"), shape: "tile", size: 32 },
  { file: path.join(EMULATOR_DIR, "packages", "server", "legacy-window", "icons", "emulator-logo-64.png"), shape: "tile", size: 64 },
  { file: path.join(EMULATOR_DIR, "public-docs", "images", "emulator-logo.png"), shape: "tile", size: 256 },
]);
/** The mark as a drawing: the logo in its bar on the gradient, without the grid, so that it holds at any size. */
export const LOGO_SVG = path.join(EMULATOR_DIR, "packages", "server", "legacy-window", "icons", "emulator-logo.svg");
export const logoSvg = (parts = masterParts()) => iconSvg({ shape: "tile", size: 32, detail: "compact", parts });

function draw(job) {
  const electron = createRequire(import.meta.url)("electron"); // the path of the installed binary
  const work = mkdtempSync(path.join(os.tmpdir(), "busybar-app-icon-"));
  try {
    const jobFile = path.join(work, "job.json");
    const answerFile = path.join(work, "answer.json");
    writeFileSync(jobFile, JSON.stringify(job));
    execFileSync(electron, [path.join(HERE, "app-icon", "render.mjs"), jobFile, answerFile], { stdio: ["ignore", "inherit", "inherit"] });
    return JSON.parse(readFileSync(answerFile, "utf8"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main(argv) {
  let sheet = null;
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== "--sheet" || !argv[i + 1]) {
      console.error(`app-icon: ${argv[i]}: not an option, or no value. Options: --sheet <png>`);
      return 2;
    }
    sheet = path.resolve(argv[i + 1]);
  }
  if (process.platform !== "darwin") {
    console.error("app-icon: run it on a Mac: the .icns is put together by macOS's iconutil");
    return 2;
  }
  const parts = masterParts();
  const images = [];
  const want = (shape, size) => {
    let at = images.findIndex((image) => image.shape === shape && image.size === size);
    if (at < 0) at = images.push({ shape, size, svg: iconSvg({ shape, size, parts }) }) - 1;
    return at;
  };
  const iconset = ICONSET.map(({ name, size }) => ({ name, image: want("mac", size) }));
  const ico = ICO_SIZES.map((size) => want("tile", size));
  const pictures = PICTURES.map(({ file, shape, size }) => ({ file, image: want(shape, size) }));
  const macImages = [...new Set(iconset.map((entry) => entry.image))];
  const small = (list) => list.filter((image) => images[image].size <= 64).map((image) => ({ image, zoom: 8, label: `${images[image].size}, 8 times` }));
  const rows = [
    { label: "macOS, emulator.icns (pixels; 16 to 512 points, each also @2x)", cells: macImages.map((image) => ({ image, label: `${images[image].size}` })) },
    { label: "macOS, the small ones with each pixel 8 times larger", cells: small(macImages) },
    { label: "Windows, emulator.ico", cells: ico.map((image) => ({ image, label: `${images[image].size}` })) },
    { label: "Windows, the small ones with each pixel 8 times larger", cells: small(ico) },
    { label: "the window's mark, the pages' icon, the documents' logo", cells: pictures.map(({ file, image }) => ({ image, label: path.basename(file).replace(/\.png$/, "") })) },
  ];
  const answer = draw({ images: images.map(({ svg, size }) => ({ svg, size })), sheet: sheet ? { rows } : undefined });
  const png = (image) => Buffer.from(answer.images[image].png, "base64");

  const iconsetDir = mkdtempSync(path.join(os.tmpdir(), "busybar-app-icon-")) + ".iconset";
  mkdirSync(iconsetDir);
  try {
    for (const { name, image } of iconset) writeFileSync(path.join(iconsetDir, name), png(image));
    mkdirSync(path.dirname(ICNS_FILE), { recursive: true });
    execFileSync("/usr/bin/iconutil", ["--convert", "icns", "--output", ICNS_FILE, iconsetDir], { stdio: ["ignore", "inherit", "inherit"] });
  } finally {
    rmSync(iconsetDir, { recursive: true, force: true });
    rmSync(iconsetDir.replace(/\.iconset$/, ""), { recursive: true, force: true });
  }
  writeFileSync(ICO_FILE, writeIco(ico.map((image) => ({ size: images[image].size, rgba: Buffer.from(answer.images[image].rgba, "base64"), png: png(image) }))));
  for (const { file, image } of pictures) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, png(image));
  }
  mkdirSync(path.dirname(LOGO_SVG), { recursive: true });
  writeFileSync(LOGO_SVG, logoSvg(parts));
  if (sheet) writeFileSync(sheet, Buffer.from(answer.sheet, "base64"));
  for (const file of [ICNS_FILE, ICO_FILE, ...PICTURES.map((p) => p.file), LOGO_SVG, ...(sheet ? [sheet] : [])]) console.log(file);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2));
