// The Windows build: Electron's own folder from the installed electron package (fetched and checked against its
// checksums when it was installed), with the executable renamed to "BUSY Bar Emulator.exe", the app's archive, the
// resources, the integrity of the archive and the app's name in the executable's resources (resedit), and the
// release's fuses. Then setup.exe: the installer of installer/windows/setup.cs, compiled by the C# compiler that is part
// of Windows, with the app folder as a zip appended to it. Runs on Windows only (the command line's .exe and the
// installer are compiled there).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";

import { cSharpCompiler } from "../windows-launcher.mjs";
import { writeAppArchive } from "./app-archive.mjs";
import { APP_DIR, archiveEntries } from "./composition.mjs";
import { setReleaseFuses } from "./fuses.mjs";
import { executableIconSizes, ICO_SOURCE, setExecutableIcon } from "./icon.mjs";
import { RELEASE_FILES, WINDOWS_EXE } from "./names.mjs";
import { filesUnder, markerBytes, stageAppResources } from "./resources.mjs";
import { writeZip } from "./zip.mjs";

export const APP_NAME = "BUSY Bar Emulator";
/** Who publishes the app: the company in the version information of the executable and of setup.exe. */
export const COMPANY = "Flipper FZCO";
/** setup.exe's description in its version information (Windows shows it in the file's properties and in a UAC prompt). */
export const SETUP_DESCRIPTION = "BUSY Bar Emulator Setup";
export const INSTALLER_SOURCE = path.join(APP_DIR, "installer", "windows", "setup.cs");
/** The uninstaller's half of the same program (EMU-218): the setup writes itself, without the app, into the folder. */
export const UNINSTALLER_SOURCE = path.join(APP_DIR, "installer", "windows", "uninstall.cs");
/** The uninstaller's name in an installed folder (uninstall.cs, FileName). */
export const UNINSTALLER = "uninstall.exe";
export const INSTALLER_MANIFEST = path.join(APP_DIR, "installer", "windows", "setup.manifest");
/** The end of setup.exe: the payload's SHA-256 (32 bytes), its length (8 bytes, little-endian), this marker (8). */
export const PAYLOAD_MAGIC = "BUSYSFX1";
/** The file setup.exe writes into every folder it installs (setup.cs, MarkerName): what it replaces only. */
export const INSTALL_MARKER = "busybar-emulator-install.json";
export const TRAILER_BYTES = 48;

/** "0.1.0" as the four numbers a Windows version resource holds. */
export function windowsVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Not a version Windows can record: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3]), 0];
}

/**
 * The executable's resources: the version information names the app instead of Electron, its icon is the app's
 * (icon/emulator.ico), and the integrity of app.asar is recorded where Electron looks for it (a resource of type
 * INTEGRITY named ELECTRONASAR). Electron's
 * signature does not survive the change, so it is dropped: the release is unsigned (ADR-0002, section 4).
 */
export async function patchExecutable(exe, { version, headerHash }) {
  const ResEdit = await import("resedit");
  const executable = ResEdit.NtExecutable.from(readFileSync(exe), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  if (!info) throw new Error(`${exe} has no version information`);
  const numbers = windowsVersion(version);
  // The numbers first: setting them also writes the strings, which the line below then sets to the app's own form.
  info.setFileVersion(...numbers);
  info.setProductVersion(...numbers);
  for (const language of info.getAvailableLanguages()) {
    // Electron's company and copyright are not the app's; SquirrelAwareVersion would tell a Squirrel installer the
    // app takes its install arguments, and the app has no Squirrel.
    for (const key of ["CompanyName", "LegalCopyright", "Comments", "SquirrelAwareVersion"]) info.removeStringValue(language, key, false);
    info.setStringValues(language, {
      CompanyName: COMPANY,
      FileDescription: APP_NAME,
      ProductName: APP_NAME,
      InternalName: APP_NAME,
      OriginalFilename: WINDOWS_EXE,
      FileVersion: version,
      ProductVersion: version,
    });
  }
  info.outputToResourceEntries(resources.entries);
  setExecutableIcon(ResEdit, resources);
  const integrity = JSON.stringify([{ file: "resources\\app.asar", alg: "sha256", value: headerHash }]);
  resources.entries = resources.entries.filter((e) => !(e.type === "INTEGRITY" && e.id === "ELECTRONASAR"));
  const lang = info.getAvailableLanguages()[0]?.lang ?? 1033;
  resources.entries.push({ type: "INTEGRITY", id: "ELECTRONASAR", lang, codepage: 1200, bin: new TextEncoder().encode(integrity).buffer });
  resources.outputResource(executable);
  writeFileSync(exe, Buffer.from(executable.generate()));
}

/** Reads back what patchExecutable wrote: the version strings, the recorded integrity and the icon's sizes. */
export async function readExecutable(exe) {
  const ResEdit = await import("resedit");
  const executable = ResEdit.NtExecutable.from(readFileSync(exe), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
  const strings = info ? info.getStringValues(info.getAvailableLanguages()[0]) : {};
  const entry = resources.entries.find((e) => e.type === "INTEGRITY" && e.id === "ELECTRONASAR");
  const integrity = entry ? JSON.parse(Buffer.from(entry.bin).toString("utf8")) : null;
  const manifestEntry = resources.entries.find((e) => e.type === 24);
  const manifest = manifestEntry ? Buffer.from(manifestEntry.bin).toString("utf8") : null;
  return { strings, integrity, manifest, icon: executableIconSizes(ResEdit, resources), signed: hasCertificate(readFileSync(exe)) };
}

/** True when the PE file has a certificate table (an Authenticode signature). */
export function hasCertificate(bytes) {
  const pe = bytes.readUInt32LE(0x3c);
  const magic = bytes.readUInt16LE(pe + 24);
  const directories = pe + 24 + (magic === 0x20b ? 112 : 96);
  const securityRva = bytes.readUInt32LE(directories + 4 * 8);
  const securitySize = bytes.readUInt32LE(directories + 4 * 8 + 4);
  return securityRva !== 0 && securitySize !== 0;
}

/**
 * Builds the app folder in <work>.
 * @returns {Promise<{ appFolder: string, exe: string, headerHash: string, archiveFiles: string[], emulatorFiles: string[], fuses: object }>}
 */
export async function buildWindowsApp({ electronDist, work, kind, version, cacheDir, commit, log = () => {} }) {
  if (process.platform !== "win32") throw new Error("The Windows build runs on Windows: the command line's entry and the installer are compiled there.");
  if (!existsSync(path.join(electronDist, "electron.exe"))) throw new Error(`No electron.exe in ${electronDist}: run node node_modules/electron/install.js on Windows first`);
  rmSync(work, { recursive: true, force: true });
  const appFolder = path.join(work, APP_NAME);
  mkdirSync(work, { recursive: true });
  log(`copying Electron into ${appFolder}`);
  cpSync(electronDist, appFolder, { recursive: true });
  // Electron's own default app runs whatever path it is given; the app has its own archive.
  rmSync(path.join(appFolder, "resources", "default_app.asar"), { force: true });
  const exe = path.join(appFolder, WINDOWS_EXE);
  renameSync(path.join(appFolder, "electron.exe"), exe);

  log("laying out the resources: Node, the command line, the server, the engine");
  const staged = await stageAppResources({ target: "win32-x64", resourcesDir: path.join(appFolder, "resources"), kind, cacheDir, commit, log });
  log("writing app.asar");
  const archive = await writeAppArchive(path.join(appFolder, "resources", "app.asar"), archiveEntries({ kind, marker: markerBytes(kind, commit) }));
  log("recording the app's name and the archive's integrity in the executable");
  await patchExecutable(exe, { version, headerHash: archive.headerHash });
  log("setting the fuses");
  const fuses = await setReleaseFuses(exe);
  return { appFolder, exe, headerHash: archive.headerHash, archiveFiles: archive.files, emulatorFiles: staged.emulatorFiles, fuses };
}

/**
 * The C# source of the version the installer reports, generated for each build. Its assembly attributes are what
 * the C# compiler writes into setup.exe's version information (without them its name and company are empty and its
 * version 0.0.0.0, the release dry run of 12.11): the product, the company, the description and the version, as the
 * app's executable has them (patchExecutable).
 */
export function installerInfoSource(version) {
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`Not a version for the installer: ${version}`);
  const numbers = windowsVersion(version).join(".");
  return [
    "// Generated by tools/packaging/windows.mjs for one build.",
    "using System.Reflection;",
    "",
    `[assembly: AssemblyTitle("${SETUP_DESCRIPTION}")]`,
    `[assembly: AssemblyDescription("Installs and removes ${APP_NAME}.")]`,
    `[assembly: AssemblyCompany("${COMPANY}")]`,
    `[assembly: AssemblyProduct("${APP_NAME}")]`,
    `[assembly: AssemblyVersion("${numbers}")]`,
    `[assembly: AssemblyFileVersion("${numbers}")]`,
    `[assembly: AssemblyInformationalVersion("${version}")]`,
    "",
    "internal static class SetupInfo",
    "{",
    `    internal const string Version = "${version}";`,
    `    internal const string Magic = "${PAYLOAD_MAGIC}";`,
    `    internal const int TrailerBytes = ${TRAILER_BYTES};`,
    "}",
    "",
  ].join("\r\n");
}

/** The compiler's arguments for the installer's stub: a window program for x64 with its manifest and the app's icon. */
export function installerArguments(out, info) {
  return [
    "/nologo",
    "/optimize+",
    "/target:winexe",
    "/platform:x64",
    `/win32manifest:${INSTALLER_MANIFEST}`,
    `/win32icon:${ICO_SOURCE}`,
    "/reference:System.IO.Compression.dll",
    "/reference:System.IO.Compression.FileSystem.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Drawing.dll",
    `/out:${out}`,
    INSTALLER_SOURCE,
    UNINSTALLER_SOURCE,
    info,
  ];
}

/**
 * Compiles the installer's stub: a window program (no console appears), with a manifest that asks for no elevation
 * and with the app's icon, which the uninstaller (the same program) then has too.
 */
export function compileInstaller(out, { version, work, env = process.env }) {
  const csc = cSharpCompiler(env);
  if (!existsSync(csc)) throw new Error(`The C# compiler of .NET Framework 4 is not at ${csc}`);
  const info = path.join(work, "setup-info.cs");
  writeFileSync(info, installerInfoSource(version));
  mkdirSync(path.dirname(out), { recursive: true });
  const args = installerArguments(out, info);
  try {
    execFileSync(csc, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    throw new Error(`${csc} could not compile the installer: ${String(e.stdout ?? "")}${String(e.stderr ?? e.message)}`.trim());
  }
  return out;
}

/** setup.exe = the stub, the zip of the app folder, the trailer. */
export function buildSetup({ appFolder, work, out, version, log = () => {} }) {
  const payload = path.join(work, "payload.zip");
  const files = filesUnder(appFolder);
  log(`zipping ${files.length} files of the app`);
  writeZip(payload, files.map((name) => ({ name, file: path.join(appFolder, ...name.split("/")) })));
  // Named as the release's file: the compiler writes the name into the version information (OriginalFilename).
  const stub = compileInstaller(path.join(work, "stub", RELEASE_FILES["win32-x64"][0]), { version, work });
  const payloadBytes = readFileSync(payload);
  const trailer = Buffer.alloc(TRAILER_BYTES);
  createHash("sha256").update(payloadBytes).digest().copy(trailer, 0);
  trailer.writeBigUInt64LE(BigInt(payloadBytes.length), 32);
  trailer.write(PAYLOAD_MAGIC, 40, "ascii");
  rmSync(out, { force: true });
  const fd = openSync(out, "w");
  try {
    writeSync(fd, readFileSync(stub));
    writeSync(fd, payloadBytes);
    writeSync(fd, trailer);
  } finally {
    closeSync(fd);
  }
  return { stubBytes: statSync(stub).size, payloadBytes: payloadBytes.length, entries: files.length };
}

/** Where the payload lies in a setup.exe: { offset, length, sha256 }, or an error when the trailer is not ours. */
export function payloadOf(setup) {
  const bytes = readFileSync(setup);
  if (bytes.length < TRAILER_BYTES) throw new Error(`${setup} is too short to be a setup`);
  const trailer = bytes.subarray(bytes.length - TRAILER_BYTES);
  if (trailer.subarray(40).toString("ascii") !== PAYLOAD_MAGIC) throw new Error(`${setup} has no payload of ours at its end`);
  const length = Number(trailer.readBigUInt64LE(32));
  const offset = bytes.length - TRAILER_BYTES - length;
  if (offset <= 0) throw new Error(`${setup}: the payload is longer than the file`);
  const sha256 = trailer.subarray(0, 32).toString("hex");
  const actual = createHash("sha256").update(bytes.subarray(offset, offset + length)).digest("hex");
  return { offset, length, sha256, intact: actual === sha256, stubBytes: offset };
}
