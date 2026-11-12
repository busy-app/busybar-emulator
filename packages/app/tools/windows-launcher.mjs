#!/usr/bin/env node
// Builds busy-emulator.exe, the command line's entry on Windows (launcher/windows/busy-emulator.cs), with the C#
// compiler of .NET Framework 4 that every Windows 10 and 11 has. No other tool is needed, and nothing is downloaded;
// it runs on Windows only, so the Windows build is made on Windows.
//   node tools/windows-launcher.mjs <out.exe>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ICO_SOURCE } from "./packaging/icon.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const LAUNCHER_SOURCE = path.join(APP_DIR, "launcher", "windows", "busy-emulator.cs");

/** The compiler, by full path: a program of that name in the current folder must not run instead. */
export function cSharpCompiler(env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return path.win32.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
}

/** The compiler's arguments for one C# file; with an icon, the executable shows it in Explorer and on the taskbar. */
export function cSharpArguments(source, out, { target = "exe", icon = null } = {}) {
  return ["/nologo", "/optimize+", `/target:${target}`, ...(icon ? [`/win32icon:${icon}`] : []), `/out:${out}`, source];
}

/** Compiles a C# file into a console executable. */
export function compileCSharp(source, out, { env = process.env, platform = process.platform, target = "exe", icon = null } = {}) {
  if (platform !== "win32") throw new Error("The Windows launcher is built on Windows: its compiler is part of Windows.");
  const csc = cSharpCompiler(env);
  if (!existsSync(csc)) throw new Error(`The C# compiler of .NET Framework 4 is not at ${csc}`);
  mkdirSync(path.dirname(out), { recursive: true });
  try {
    execFileSync(csc, cSharpArguments(source, out, { target, icon }), { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (e) {
    throw new Error(`${csc} could not compile ${source}: ${String(e.stdout ?? "")}${String(e.stderr ?? e.message)}`.trim());
  }
  return out;
}

/** The command line's entry, with the app's icon. */
export function buildWindowsLauncher(out, options) {
  return compileCSharp(LAUNCHER_SOURCE, out, { icon: ICO_SOURCE, ...options });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [out] = process.argv.slice(2);
  if (!out) {
    console.error("usage: windows-launcher.mjs <out.exe>");
    process.exit(2);
  }
  try {
    console.log(buildWindowsLauncher(path.resolve(out)));
  } catch (e) {
    console.error(`windows-launcher: ${e.message}`);
    process.exit(1);
  }
}
