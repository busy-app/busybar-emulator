// What the desktop app starts (ADR-0012 §6, ADR-0016, EMU-010): this list and nothing else, through startShellProgram
// and runShellProgram, which refuse any other. Arguments go as a list; no program is started through a shell. A test
// keeps every other module of src/ off node:child_process (packages/app/test/unit/processes.test.mjs).
//
// The server and the command line have their own list (packages/engine/programs.mjs, ALLOWED_PROGRAMS); the app does
// not load the server's files. Opening an address in the browser, showing a file in Finder or Explorer and moving a
// folder to the Trash are Electron's calls (shell.openExternal, shell.showItemInFolder, shell.trashItem), not programs.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

/**
 * Each entry: the programs, by full path on macOS; on Windows by the path inside the Windows folder, letter case
 * aside. Node is the one the app was configured with (configureShellPrograms: the Node inside the app, or the one a
 * development run names) or the one this process runs on, by its exact path.
 */
export const SHELL_PROGRAMS = Object.freeze([
  { id: "node", why: "the Node inside the app: the server under its supervisor, and the command line the window's actions run", node: true },
  { id: "terminal", why: "the window's console in a terminal: Terminal through the system's opener on macOS, cmd.exe on Windows", darwin: ["/usr/bin/open"], windows: ["System32\\cmd.exe"] },
  { id: "powershell", why: "Windows: whether a folder can go to the Recycle Bin before Delete moves it; before an update, what else runs from the app's folder (updater.mjs)", windows: ["System32\\WindowsPowerShell\\v1.0\\powershell.exe"] },
  { id: "gh", why: "GitHub CLI inside the app (tools/bundled-gh.mjs): Publish's sign-in, repository and pull request (github/gh.mjs)", gh: true },
  { id: "update", why: "the built-in update on macOS (updater.mjs): ditto unpacks the release's zip, plutil and codesign check the new bundle", darwin: ["/usr/bin/ditto", "/usr/bin/plutil", "/usr/bin/codesign"] },
  { id: "update-node", why: "Windows: the copy of the app's Node in <data>/tmp/update-<version>/ that runs the update's helper while the setup replaces the app's folder (updater.mjs)", updateNode: true },
]);

// Set once by main.mjs from the app's configuration (this module does not read the environment).
let configured = { node: null, gh: null, windowsDir: "C:\\Windows", updateNodes: [] };

/** The app's Node (config.nodePath), its GitHub CLI (config.github.gh) and the Windows folder, for the list above. */
export function configureShellPrograms({ node = null, gh = null, windowsDir = null } = {}) {
  configured = { node, gh, windowsDir: windowsDir || configured.windowsDir, updateNodes: configured.updateNodes };
}

/** The updater's copy of the app's Node (Windows), by its exact path: the one it has just copied, and only that. */
export function allowUpdateNode(file) {
  configured = { ...configured, updateNodes: [file] };
}

/** The entry of SHELL_PROGRAMS that `file` is, or null. Only an absolute path is one. */
export function shellProgram(file, platform = process.platform, { nodes = [configured.node, process.execPath], gh = configured.gh, windowsDir = configured.windowsDir, updateNodes = configured.updateNodes } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (typeof file !== "string" || !p.isAbsolute(file)) return null;
  const fold = (text) => (platform === "win32" ? p.normalize(text).toLowerCase() : text);
  for (const entry of SHELL_PROGRAMS) {
    if (entry.node && nodes.some((one) => one && fold(one) === fold(file))) return entry;
    if (entry.gh && gh && fold(gh) === fold(file)) return entry;
    if (entry.updateNode && updateNodes.some((one) => one && fold(one) === fold(file))) return entry;
    if ((entry[platform] ?? []).some((one) => file === one)) return entry;
    if (platform === "win32" && windowsDir && (entry.windows ?? []).some((one) => fold(file) === fold(p.join(windowsDir, one)))) return entry;
  }
  return null;
}

function checked(file, options) {
  if (options?.shell) throw new Error(`${file} would be started through a shell; the app passes arguments as a list`);
  if (!shellProgram(file)) throw Object.assign(new Error(`${file} is not among the programs the app starts (SHELL_PROGRAMS in processes.mjs)`), { code: "program_not_allowed" });
}

/** spawn for a program of SHELL_PROGRAMS. */
export function startShellProgram(file, args = [], options = {}) {
  checked(file, options);
  return spawn(file, args, options);
}

/** execFileSync for a program of SHELL_PROGRAMS. */
export function runShellProgram(file, args = [], options = {}) {
  checked(file, options);
  return execFileSync(file, args, options);
}
