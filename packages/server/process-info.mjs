// A process as the system describes it: when it started (ms since the epoch, to the second) and its executable. One
// place for the command line (cli/system.mjs: is the emulator that a run state names still the one running?) and for
// the data folder's lock (data-folder.mjs: is the server that holds it still there?); the two copies there had
// drifted apart (audit B5: the command line's read `ps` in the caller's time zone, so with TZ set to another zone than
// the system's, `status`, `start` and `quit` did not know the running emulator).
//
// macOS and Linux: `ps` runs with an environment of its own, nothing of the caller's: the C convention for time and the
// time zone UTC, so it prints the start as "Wed Nov 11 03:12:44 2026" in UTC whatever the zone or the locale of this
// process and of the system, and the string is read as UTC. Characters are UTF-8: in the C locale `ps` would escape
// every letter outside ASCII of the path (a home named in Cyrillic), and the path would not match.
// Windows: PowerShell's Get-Process, the start in UTC (ISO 8601), the output in UTF-8.
import path from "node:path";

import { runProgram, runProgramLater, startProgram } from "../engine/programs.mjs";

export const PS_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LC_CTYPE: "UTF-8", LC_TIME: "C", TZ: "UTC0" });
const PS_ARGS = (pid) => ["-o", "lstart=", "-o", "comm=", "-p", String(pid)];
const TIMEOUT_MS = 15_000;

const powershellOf = (windowsDir) => path.win32.join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
// Its output in UTF-8, read as UTF-8: a path with letters outside the console's code page must come back intact.
const powershellArgs = (pid) => ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('o') + '|' + $p.Path`];

/** What `ps` printed (with PS_ENV), as { start, exe }, or null. Exported for the tests. */
export function parsePs(stdout) {
  const match = /^(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.+)$/.exec(String(stdout ?? "").trim());
  const start = match ? Date.parse(`${match[1]} GMT`) : NaN;
  return Number.isFinite(start) ? { start, exe: match[2] } : null;
}

function parsePowershell(stdout) {
  const [time, exe] = String(stdout ?? "").trim().split("|");
  const start = Date.parse(time ?? "");
  return Number.isFinite(start) && exe ? { start, exe } : null;
}

const valid = (pid) => Number.isInteger(pid) && pid > 0;

/**
 * Null when the system will not say (no such process, a sandbox that hides processes, no `ps`).
 * @returns {{ start: number, exe: string } | null}
 */
export function processInfoSync(pid, platform = process.platform, windowsDir = "C:\\Windows") {
  if (!valid(pid)) return null;
  if (platform === "win32") {
    try {
      return parsePowershell(runProgram(powershellOf(windowsDir), powershellArgs(pid), { encoding: "utf8", windowsHide: true, timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }, { windowsDir }));
    } catch {
      return null; // no such process, or the system would not say
    }
  }
  try {
    return parsePs(runProgram("/bin/ps", PS_ARGS(pid), { encoding: "utf8", env: { ...PS_ENV }, timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null; // ps exits 1 for a process that is not there
  }
}

/** The same, without blocking (the server). @returns {Promise<{ start: number, exe: string } | null>} */
export function processInfo(pid, platform = process.platform, windowsDir = "C:\\Windows") {
  if (!valid(pid)) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (platform === "win32") {
      let child;
      try {
        child = startProgram(powershellOf(windowsDir), powershellArgs(pid), { windowsHide: true, timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }, { windowsDir });
      } catch {
        resolve(null);
        return;
      }
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 ? parsePowershell(stdout) : null));
      return;
    }
    runProgramLater("/bin/ps", PS_ARGS(pid), { encoding: "utf8", env: { ...PS_ENV }, timeout: TIMEOUT_MS }, (error, stdout) => resolve(error ? null : parsePs(stdout)));
  });
}
