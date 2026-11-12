// The check of setup.exe (EMU-203). On any system: the payload is whole, the installer asks for no elevation, and the
// app inside it is checked as the macOS one is (fuses, archive, resources, and the integrity and the name recorded in
// the executable). On Windows also: the setup installs silently into a temporary folder, without a shortcut, and the
// programs of the installed app that have no window run (the bundled Node, the command line, the server).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runProblems, resourcesProblems } from "./check.mjs";
import { fuseProblems, fuseTable, readFuseWire } from "./fuses.mjs";
import { executableIconProblems, executableIconSizes } from "./icon.mjs";
import { WINDOWS_EXE } from "./names.mjs";
import { filesUnder } from "./resources.mjs";
import { APP_NAME, COMPANY, INSTALL_MARKER, payloadOf, readExecutable, SETUP_DESCRIPTION, UNINSTALLER, windowsVersion } from "./windows.mjs";
import { openZip } from "./zip.mjs";

/** What is wrong with an unpacked Windows app folder, without running anything. */
export async function windowsAppProblems(folder) {
  const problems = [];
  const top = readdirSync(folder);
  if (!top.includes(WINDOWS_EXE)) problems.push(`the app folder has no ${WINDOWS_EXE}`);
  for (const name of ["electron.exe", path.join("resources", "default_app.asar")]) if (existsSync(path.join(folder, name))) problems.push(`the app folder has ${name}`);
  // Electron's and Chromium's licenses, which the license summary points to, lie beside the executable.
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) if (!existsSync(path.join(folder, name))) problems.push(`the app folder has no ${name} (Electron's and Chromium's licenses)`);
  const exe = path.join(folder, WINDOWS_EXE);
  if (!existsSync(exe)) return { problems };
  const fuses = readFuseWire(exe);
  problems.push(...fuseProblems(fuses));
  const info = await readExecutable(exe);
  for (const [key, value] of Object.entries({ ProductName: APP_NAME, FileDescription: APP_NAME, CompanyName: COMPANY, OriginalFilename: WINDOWS_EXE })) {
    if (info.strings[key] !== value) problems.push(`the executable's ${key} is ${JSON.stringify(info.strings[key])}, expected ${JSON.stringify(value)}`);
  }
  for (const key of ["LegalCopyright", "SquirrelAwareVersion"]) if (info.strings[key] !== undefined) problems.push(`the executable keeps Electron's ${key}: ${JSON.stringify(info.strings[key])}`);
  if (info.signed) problems.push("the executable carries a signature that no longer matches it");
  problems.push(...executableIconProblems(info.icon, "the executable"));
  // The command line's entry has the app's icon too.
  const launcher = path.join(folder, "resources", "bin", "busy-emulator.exe");
  if (existsSync(launcher)) problems.push(...executableIconProblems(await iconSizesOf(readFileSync(launcher)), "resources/bin/busy-emulator.exe"));
  const resources = await resourcesProblems(path.join(folder, "resources"), "win32");
  problems.push(...resources.problems);
  const recorded = info.integrity ?? [];
  if (recorded.length !== 1 || recorded[0].file !== "resources\\app.asar" || recorded[0].alg !== "sha256" || recorded[0].value !== resources.asarHash) {
    problems.push(`the integrity the executable records (${JSON.stringify(recorded)}) is not the hash of resources\\app.asar's header`);
  }
  return { problems, fuses: fuseTable(fuses.wire), wire: fuses.wire, resources, executable: info.strings };
}

/** The pixels of the icon Windows shows for a program, from its bytes. */
export async function iconSizesOf(bytes) {
  const ResEdit = await import("resedit");
  return executableIconSizes(ResEdit, ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(bytes, { ignoreCert: true })));
}

/**
 * What is wrong with setup.exe's version information (the release dry run, 12.11: empty, 0.0.0.0): the product, the
 * company and the description named, and the version the app inside has (`version`, the executable's ProductVersion;
 * null: not compared). `info`: resedit's VersionInfo, or none.
 */
export function setupVersionProblems(info, version = null) {
  if (!info) return { problems: ["the installer has no version information"], strings: {} };
  const strings = Object.assign({}, ...info.getAvailableLanguages().map((language) => info.getStringValues(language)));
  const problems = [];
  for (const [key, value] of Object.entries({ ProductName: APP_NAME, CompanyName: COMPANY, FileDescription: SETUP_DESCRIPTION })) {
    if (strings[key] !== value) problems.push(`the installer's ${key} is ${JSON.stringify(strings[key] ?? null)}, expected ${JSON.stringify(value)}`);
  }
  if (!strings.Comments?.trim()) problems.push("the installer's version information has no description (Comments)");
  if (version !== null) {
    if (strings.ProductVersion !== version) problems.push(`the installer's ProductVersion is ${JSON.stringify(strings.ProductVersion ?? null)}, the app's ${JSON.stringify(version)}`);
    let numbers = null;
    try {
      numbers = windowsVersion(version);
    } catch {
      problems.push(`the app's version ${JSON.stringify(version)} is not one Windows can record`);
    }
    const f = info.fixedInfo;
    const fixed = [f.fileVersionMS >>> 16, f.fileVersionMS & 0xffff, f.fileVersionLS >>> 16, f.fileVersionLS & 0xffff];
    if (numbers && fixed.join(".") !== numbers.join(".")) problems.push(`the installer's file version is ${fixed.join(".")}, expected ${numbers.join(".")}`);
  } else if (!strings.ProductVersion || strings.ProductVersion === "0.0.0.0") problems.push(`the installer's ProductVersion is ${JSON.stringify(strings.ProductVersion ?? null)}`);
  return { problems, strings };
}

/**
 * The installer's own manifest must ask for no elevation: a program named "setup" would otherwise ask for it. Its
 * icon is the app's: the same program is the uninstaller in the installed folder. Its version information names the
 * app, the company and the version (setupVersionProblems; `version`: the app's, when known).
 */
export async function stubProblems(setup, stubBytes, { version = null } = {}) {
  const ResEdit = await import("resedit");
  const stub = readFileSync(setup).subarray(0, stubBytes);
  const executable = ResEdit.NtExecutable.from(stub);
  const resources = ResEdit.NtExecutableResource.from(executable);
  const manifest = resources.entries.find((e) => e.type === 24);
  const text = manifest ? Buffer.from(manifest.bin).toString("utf8") : "";
  const problems = [];
  if (!/requestedExecutionLevel\s+level="asInvoker"/.test(text)) problems.push("the installer has no manifest that asks to run as invoked (Windows would ask for administrator rights)");
  problems.push(...executableIconProblems(executableIconSizes(ResEdit, resources), "the installer"));
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  const versioned = setupVersionProblems(info, version);
  problems.push(...versioned.problems);
  return { problems, manifest: text, version: versioned.strings };
}

export async function checkSetup(file, { scratch, runHere, log = () => {} }) {
  const problems = [];
  const payload = payloadOf(file);
  if (!payload.intact) return { problems: ["the payload does not match the SHA-256 in the setup's trailer"] };
  const zip = openZip(file, { offset: payload.offset, length: payload.length });
  const unpacked = path.join(scratch, "payload");
  try {
    log(`unpacking the payload of ${path.basename(file)} (${zip.entries.length} files)`);
    for (const entry of zip.entries) {
      // The names a zip of ours may have (zip.mjs): nothing may land outside the folder the check unpacks into.
      if (!entry.name || entry.name.startsWith("/") || entry.name.includes("\\") || entry.name.split("/").some((part) => part === "" || part === "." || part === "..")) {
        return { problems: [`the payload has an entry named ${JSON.stringify(entry.name)}, which would land outside the app's folder`] };
      }
      const out = path.join(unpacked, ...entry.name.split("/"));
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, zip.read(entry.name));
    }
  } finally {
    zip.close();
  }
  const app = await windowsAppProblems(unpacked);
  // The installer after the app inside: its version must be the app's.
  const stub = await stubProblems(file, payload.offset, { version: app.executable?.ProductVersion ?? null });
  problems.push(...stub.problems, ...app.problems);
  const result = { payload: { stubBytes: payload.offset, zipBytes: payload.length, files: filesUnder(unpacked).length }, ...app, installer: stub.version, problems: undefined };
  if (runHere) {
    const folder = path.join(scratch, "installed", "BUSY Bar Emulator");
    const logFile = path.join(scratch, "setup.log");
    log("installing silently into a temporary folder, without a shortcut");
    let code = 0;
    const started = Date.now();
    try {
      execFileSync(file, ["/S", "/NoShortcut", `/LOG=${logFile}`, `/D=${folder}`], { stdio: "ignore", windowsHide: true });
    } catch (e) {
      code = e.status ?? 1;
    }
    result.install = { code, ms: Date.now() - started, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : null };
    if (code !== 0) problems.push(`setup /S ended with ${code}: ${result.install.log}`);
    else {
      // The setup's own marker and the uninstaller (the setup without the app) are the files of the install that are
      // not in the payload.
      const installed = filesUnder(folder).filter((f) => f !== INSTALL_MARKER && f !== UNINSTALLER);
      if (!existsSync(path.join(folder, INSTALL_MARKER))) problems.push(`the install has no ${INSTALL_MARKER}: a later setup would refuse to replace it`);
      if (!existsSync(path.join(folder, UNINSTALLER))) problems.push(`the install has no ${UNINSTALLER}: the app could not be removed`);
      else if (!readFileSync(path.join(folder, UNINSTALLER)).equals(readFileSync(file).subarray(0, payload.offset))) problems.push(`the installed ${UNINSTALLER} is not the setup's own program without the app`);
      const fromZip = filesUnder(unpacked);
      if (JSON.stringify(installed) !== JSON.stringify(fromZip)) problems.push("the installed folder does not hold what the payload does");
      else for (const f of installed) if (statSync(path.join(folder, ...f.split("/"))).size !== statSync(path.join(unpacked, ...f.split("/"))).size) problems.push(`installed ${f} differs from the payload`);
      const work = path.join(scratch, "run");
      mkdirSync(work, { recursive: true });
      const ran = await runProblems({ resources: path.join(folder, "resources"), platform: "win32", workDir: work, log });
      problems.push(...ran.problems);
      result.run = ran.results;
    }
  }
  return { ...result, problems };
}
