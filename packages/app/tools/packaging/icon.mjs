// The app's icon in a build: the two files tools/app-icon.mjs makes from the master drawing, and where they go.
// macOS: Contents/Resources/app.icns, named by Info.plist, instead of Electron's. Windows: the icon of the app's
// executable, of setup.exe (which is also the uninstaller) and of the command line's busy-emulator.exe.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ICO_SIZES, readIcns, readIco } from "../app-icon/art.mjs";

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const ICNS_SOURCE = path.join(APP_DIR, "icon", "emulator.icns");
export const ICO_SOURCE = path.join(APP_DIR, "icon", "emulator.ico");
/** The icon's name in the macOS bundle's Resources, and the one of Electron's own that it replaces. */
export const MAC_ICON_FILE = "app.icns";
export const ELECTRON_ICON_FILE = "electron.icns";

/** The pixels an .icns holds, by the names macOS gives its images; 16 and 32 are in a form of their own. */
const ICNS_PIXELS = Object.freeze({ ic04: 16, ic05: 32, ic11: 32, ic12: 64, ic07: 128, ic13: 256, ic08: 256, ic14: 512, ic09: 512, ic10: 1024 });

/** What is wrong with an .icns as the app's icon, one line each: every size from 16 to 512 points, each also @2x. */
export function icnsProblems(bytes) {
  let images;
  try {
    images = readIcns(bytes);
  } catch (e) {
    return [`the icon is ${e.message}`];
  }
  const problems = [];
  for (const [type, pixels] of Object.entries(ICNS_PIXELS)) {
    const image = images.find((entry) => entry.type === type);
    if (!image) problems.push(`the .icns has no ${type} (${pixels} pixels)`);
    else if (image.size !== undefined && image.size !== pixels) problems.push(`the .icns holds ${image.size} pixels as ${type}, which is ${pixels}`);
  }
  return problems;
}

/** What is wrong with an .ico as the app's icon: the eight sizes, each with 32 bits. */
export function icoProblems(bytes) {
  let images;
  try {
    images = readIco(bytes);
  } catch (e) {
    return [`the icon is ${e.message}`];
  }
  const problems = [];
  const sizes = images.map((image) => image.size);
  if (JSON.stringify(sizes) !== JSON.stringify(ICO_SIZES)) problems.push(`the .ico holds ${sizes.join(", ")} pixels, expected ${ICO_SIZES.join(", ")}`);
  for (const image of images) if (image.bits !== 32) problems.push(`the .ico's ${image.size} pixel image has ${image.bits} bits a pixel, not 32`);
  return problems;
}

/**
 * Puts the .ico into an executable's resources as its icon: in place of the first icon it has (the one Windows
 * shows for the file), or as icon 1 when it has none.
 * @param ResEdit    the resedit module
 * @param resources  NtExecutableResource of the executable
 */
export function setExecutableIcon(ResEdit, resources, ico = readFileSync(ICO_SOURCE)) {
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const first = groups[0];
  const icons = ResEdit.Data.IconFile.from(ico).icons.map((item) => item.data);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, first?.id ?? 1, first?.lang ?? 1033, icons);
}

/** The pixels of the first icon in an executable's resources (the one Windows shows), smallest first; [] without one. */
export function executableIconSizes(ResEdit, resources) {
  const [first] = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  // A group lists 256 as 0: the field is one byte.
  return first ? first.icons.map((icon) => icon.width || 256).sort((a, b) => a - b) : [];
}

/** What is wrong with the icon of an executable, by its sizes: it must be the app's. */
export function executableIconProblems(sizes, what) {
  return JSON.stringify(sizes) === JSON.stringify(ICO_SIZES) ? [] : [`${what} has ${sizes.length ? `an icon of ${sizes.join(", ")} pixels` : "no icon"}, expected the app's (${ICO_SIZES.join(", ")})`];
}
