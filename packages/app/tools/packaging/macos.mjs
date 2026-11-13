// The macOS build, for Apple Silicon or for Intel: Electron's own bundle of that architecture (electron.mjs: the
// installed electron package's for this Mac's own, the checked archive of the same release for the other), renamed,
// with the app's archive, the resources, the release's fuses and an ad-hoc signature (on Apple Silicon, code without
// any signature does not run; ADR-0002, section 4). Then the zip (ditto, as the agent's instructions unpack it) and
// the disk image (hdiutil). Only programs of macOS are used, and none of the built app is run: a Mac of either
// architecture builds both. A release built with an identity is then signed with Developer ID and notarized
// (signAndNotarizeApp, signAndNotarizeDmg; sign-mac.mjs), before and after its zip and disk image are made.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, lutimesSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { writeAppArchive } from "./app-archive.mjs";
import { freeGigabytes, MIN_FREE_GB } from "./disk.mjs";
import { archiveEntries } from "./composition.mjs";
import { machoArch } from "./electron.mjs";
import { setReleaseFuses } from "./fuses.mjs";
import { ELECTRON_ICON_FILE, ICNS_SOURCE, MAC_ICON_FILE } from "./icon.mjs";
import { APP_BUNDLE } from "./names.mjs";
import { markerBytes, stageAppResources } from "./resources.mjs";

export const APP_NAME = "BUSY Bar Emulator";
export const BUNDLE_ID = "app.busy.emulator";
/** The test variant is another app to the system, so that it is never taken for an installed release. */
export const TEST_BUNDLE_ID = "app.busy.emulator.test-variant";

const run = (program, args, options = {}) => execFileSync(program, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });

export function readPlist(file) {
  return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]));
}

export function writePlist(file, value) {
  const json = `${file}.json`;
  writeFileSync(json, JSON.stringify(value));
  try {
    run("/usr/bin/plutil", ["-convert", "xml1", "-o", file, json]);
  } finally {
    rmSync(json, { force: true });
  }
}

/**
 * The main Info.plist of the app: Electron's, with the app's name, identifier, version and icon, the integrity of its
 * archive, and without what the app does not use. The descriptions of access (camera, microphone, Bluetooth, audio
 * capture) go: without them the system refuses such a request instead of asking the user, should the shell's own
 * refusal ever break (EMU-201 security review, S13). So does the exception that lets the app load plain-HTTP pages
 * from anywhere.
 */
// The bundled Node 24 is built for macOS 13.5 (Electron itself for 13.0): on 13.0 to 13.4 the app would open and its
// server would never start. The system then refuses the app at the door, with its own message about the version.
export const MAC_MINIMUM_SYSTEM = "13.5";

export function appInfoPlist(stock, { version, headerHash, kind }) {
  const out = {};
  for (const [key, value] of Object.entries(stock)) {
    if (/UsageDescription$/.test(key) || key === "NSAppTransportSecurity") continue;
    out[key] = value;
  }
  Object.assign(out, {
    CFBundleName: APP_NAME,
    CFBundleDisplayName: APP_NAME,
    CFBundleExecutable: APP_NAME,
    CFBundleIconFile: MAC_ICON_FILE,
    CFBundleIdentifier: kind === "test" ? TEST_BUNDLE_ID : BUNDLE_ID,
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: MAC_MINIMUM_SYSTEM,
    ElectronAsarIntegrity: { "Resources/app.asar": { algorithm: "SHA256", hash: headerHash } },
  });
  // The test variant runs hidden in tests: without this line the system puts it in the Dock before any of its code
  // runs (test/app/harness.mjs does the same with its copy of Electron).
  if (kind === "test") out.LSUIElement = true;
  return out;
}

export function helperInfoPlist(stock, { name, kind }) {
  const out = { ...stock, CFBundleName: name, CFBundleDisplayName: name, CFBundleExecutable: name, CFBundleIdentifier: `${kind === "test" ? TEST_BUNDLE_ID : BUNDLE_ID}.helper` };
  for (const key of Object.keys(out)) if (/UsageDescription$/.test(key)) delete out[key];
  return out;
}

/** Electron's helpers, renamed after the app the way Electron looks for them: "<executable name> Helper (...)". */
function renameHelpers(app, kind) {
  const frameworks = path.join(app, "Contents", "Frameworks");
  const renamed = [];
  for (const entry of readdirSync(frameworks)) {
    const match = /^Electron Helper( \(.+\))?\.app$/.exec(entry);
    if (!match) continue;
    const name = `${APP_NAME} Helper${match[1] ?? ""}`;
    const from = path.join(frameworks, entry);
    const to = path.join(frameworks, `${name}.app`);
    renameSync(from, to);
    const plistFile = path.join(to, "Contents", "Info.plist");
    const stock = readPlist(plistFile);
    const executable = stock.CFBundleExecutable ?? entry.replace(/\.app$/, "");
    renameSync(path.join(to, "Contents", "MacOS", executable), path.join(to, "Contents", "MacOS", name));
    writePlist(plistFile, helperInfoPlist(stock, { name, kind }));
    renamed.push(name);
  }
  if (renamed.length !== 4) throw new Error(`Electron's bundle has ${renamed.length} helpers, 4 were expected: ${renamed.join(", ")}`);
  return renamed;
}

/** Every entry under a folder gets one time, links included: the zip records times, and two builds should match. */
export function setTimes(folder, seconds) {
  const walk = (p) => {
    const stat = lstatSync(p);
    if (stat.isDirectory()) for (const entry of readdirSync(p)) walk(path.join(p, entry));
    lutimesSync(p, seconds, seconds);
  };
  walk(folder);
}

/**
 * Builds the .app for a target (darwin-arm64 or darwin-x64) in <work>, from that target's Electron.
 * @returns {Promise<{ app: string, headerHash: string, archiveFiles: string[], emulatorFiles: string[], fuses: object }>}
 */
export async function buildMacApp({ target, electronDist, work, kind, version, cacheDir, sourceTime, commit, log = () => {} }) {
  if (target !== "darwin-arm64" && target !== "darwin-x64") throw new Error(`Not a macOS target: ${target}`);
  const stockApp = path.join(electronDist, "Electron.app");
  if (!existsSync(stockApp)) throw new Error(`No Electron.app in ${electronDist}: run node node_modules/electron/install.js first`);
  const arch = target.split("-")[1];
  const stockArch = machoArch(path.join(stockApp, "Contents", "MacOS", "Electron"));
  if (stockArch !== arch) throw new Error(`The Electron in ${electronDist} is for ${stockArch ?? "no Mac"}, the build is for ${arch}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const app = path.join(work, APP_BUNDLE);
  log(`copying Electron into ${app}`);
  // ditto keeps the links and modes of the frameworks as they are.
  run("/usr/bin/ditto", ["--norsrc", "--noextattr", "--noacl", stockApp, app]);

  const contents = path.join(app, "Contents");
  const resources = path.join(contents, "Resources");
  // Electron's own default app runs whatever path it is given; the app has its own archive.
  rmSync(path.join(resources, "default_app.asar"), { force: true });
  renameSync(path.join(contents, "MacOS", "Electron"), path.join(contents, "MacOS", APP_NAME));
  const helpers = renameHelpers(app, kind);
  // Electron's and Chromium's licenses go with the app; in Electron's download they lie beside the bundle.
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) copyFileSync(path.join(electronDist, name), path.join(resources, name));
  // The app's own icon instead of Electron's (tools/app-icon.mjs makes it; Info.plist names it).
  rmSync(path.join(resources, ELECTRON_ICON_FILE), { force: true });
  copyFileSync(ICNS_SOURCE, path.join(resources, MAC_ICON_FILE));

  log("laying out the resources: Node, the command line, the server, the engine");
  const staged = await stageAppResources({ target, resourcesDir: resources, kind, cacheDir, commit, log });
  const nodeArch = machoArch(staged.node.node);
  if (nodeArch !== arch) throw new Error(`The bundled Node is for ${nodeArch ?? "no Mac"}, the build is for ${arch}`);

  log("writing app.asar");
  const archive = await writeAppArchive(path.join(resources, "app.asar"), archiveEntries({ kind, marker: markerBytes(kind, commit) }));

  const plistFile = path.join(contents, "Info.plist");
  writePlist(plistFile, appInfoPlist(readPlist(plistFile), { version, headerHash: archive.headerHash, kind }));

  log("setting the fuses");
  const fuses = await setReleaseFuses(app);

  // One time for every file before the signature, so the signature's own files are the only ones with a new time;
  // they get it after.
  setTimes(app, sourceTime);
  log("signing ad hoc");
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", app]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  setTimes(app, sourceTime);
  return { app, helpers, headerHash: archive.headerHash, archiveFiles: archive.files, emulatorFiles: staged.emulatorFiles, fuses };
}

/**
 * The release's own signature (EMU-204, sign-mac.mjs) over the ad hoc one: every program signed with the Developer ID
 * identity and the hardened runtime, the app zipped into <work> and notarized by Apple, its ticket stapled. The zip
 * and the disk image of the release are made after this, from the stapled app.
 * @returns {{ team: string, machO: number, signed: number, submission: string }}
 */
export async function signAndNotarizeApp(app, { identity, profile, work, sourceTime, log = () => {} }) {
  const { notarize, signMacApp, staple, teamOf } = await import("./sign-mac.mjs");
  const signed = signMacApp(app, { identity, log });
  const zip = path.join(work, `notarize-${path.basename(work)}.zip`);
  zipApp(app, zip);
  let submission;
  try {
    submission = notarize(zip, { profile, log });
  } finally {
    rmSync(zip, { force: true });
  }
  staple(app, { log });
  log(`the app is notarized and stapled (submission ${submission.id})`);
  // The ticket is a new file in the bundle: every file gets the commit's time again, as before the signature.
  setTimes(app, sourceTime);
  return { team: teamOf(identity), ...signed, submission: submission.id };
}

/** The disk image's own signature, notarization and ticket (after dmgApp, from the stapled app). */
export async function signAndNotarizeDmg(dmg, { identity, profile, log = () => {} }) {
  const { notarize, signDmg, staple } = await import("./sign-mac.mjs");
  signDmg(dmg, { identity });
  const submission = notarize(dmg, { profile, log });
  staple(dmg, { log });
  log(`${path.basename(dmg)} is signed, notarized and stapled (submission ${submission.id})`);
  return { submission: submission.id };
}

/** The zip of the bundle: the bundle as its one top folder, without resource forks, extended attributes or ACLs. */
export function zipApp(app, out) {
  rmSync(out, { force: true });
  run("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--noacl", "--keepParent", app, out]);
  return out;
}

/** What a program said when it failed: the last line of its error output, else its message. */
const said = (e) => String(e?.stderr || e?.message || e).trim().split(/\r?\n/).filter(Boolean).pop() ?? "";

/**
 * The disk image: the bundle and a link to /Applications, compressed with LZFSE (opens on macOS 10.11 and later).
 * Then `hdiutil verify` reads it back: on a nearly full disk hdiutil create wrote a truncated image and still ended
 * with 0 (the release dry run, 11.11). A broken image is removed, and the build fails with the free space it had.
 * `exec` and `statfs` are for tests.
 */
export function dmgApp(app, out, { work, format = "ULFO", exec = run, statfs = undefined }) {
  const folder = path.join(work, "dmg");
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  try {
    exec("/usr/bin/ditto", ["--norsrc", "--noextattr", "--noacl", app, path.join(folder, path.basename(app))]);
    symlinkSync("/Applications", path.join(folder, "Applications"));
    rmSync(out, { force: true });
    exec("/usr/bin/hdiutil", ["create", "-quiet", "-volname", APP_NAME, "-srcfolder", folder, "-fs", "HFS+", "-format", format, "-ov", out]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  try {
    // Not -quiet: without it hdiutil says why on stderr.
    exec("/usr/bin/hdiutil", ["verify", out]);
  } catch (e) {
    rmSync(out, { force: true });
    let free = "";
    try {
      free = ` ${freeGigabytes(path.dirname(out), statfs ? { statfs } : {}).toFixed(1)} GB is free on its disk now;`;
    } catch {
      // Without the number.
    }
    throw new Error(`The disk image ${path.basename(out)} is broken: hdiutil verify says "${said(e)}".${free} hdiutil writes a broken image when the disk runs out of space while it writes. Free some space (a release needs about ${MIN_FREE_GB} GB), then build again.`);
  }
  return out;
}
