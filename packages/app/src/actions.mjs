// What the app's main window may do to app projects (EMU-260, EMU-261, EMU-262): create one, open one, refresh,
// build, run, stop, the development loop, the catalog's checks, the submission folder; and show a folder, copy a
// text. The contract with the page is window.emulatorActions (packages/server/legacy-window/README.md).
//
// Every action is done here, in the main process, by running the command line busy-emulator (cli-process.mjs): the
// same code an author's terminal and an agent run. The rules (ADR-0012, ADR-0016):
//   - only the page of the app's main window asks (bridge.mjs decides who called);
//   - a folder is chosen in a dialog of the system's, shown from here; the page names none;
//   - an action runs on a project of the emulator's list that is trusted, and the folder the page names is only
//     looked up in that list, never taken as a path to work on;
//   - trust is the person's click in the trust dialog (person-question.mjs), which `busy-emulator trust` asks for;
//     nothing here writes the trusted list and no action passes --trust;
//   - one job for a project at a time; the development loop ends when the window closes or the app quits;
//   - a folder is shown only when it is a project of the list, inside one, or inside the data folder;
//   - everything but reading (the list, the examples, the greeting's facts, where publishing stands and what its
//     checks and the repository's files would be) needs the person's click or key in the window within two seconds,
//     at most four actions per click or key, whatever still runs (bridge.mjs, gestures.mjs): script alone builds
//     nothing, runs nothing and puts nothing on the clipboard, and an action that runs long opens no other. Work that
//     follows a long step is done here, in the one action the click allowed (create writes the texts and the icons;
//     Delete stops and removes; publish.package with build builds first).
//
// Install a package (Create app; Import from GitHub of a repository whose latest release has the app's .tgz): someone
// else's app package, never a project. The command line looks at it first (`install <file.tgz> --check`: the app it
// holds, or why the BUSY Bar would not take it), in a copy in the data folder's own tmp/, so that the bytes it looked at
// are the bytes installed. Then the person is asked in a dialog of the app's (`confirm`, person-question.mjs) that
// names the file, the app's name, id and version, and where it came from; the safe button is the default. On their
// yes the copy goes up to the emulated BUSY Bar through the bar's own API, as `busy-emulator install <file.tgz>`,
// busy-cli and Local Web's Add app send a package (POST /api/apps/stage, then /api/apps/install), and the app is
// started (POST /api/apps/launch). The copy is removed after. The Apps list shows the app as installed from a package.
//
// Two more are about the window itself, not a project: the first run's greeting (EMU-207). `welcome.get` says whether
// it is still to be shown, the system, and the command line's path for the text for agents; `welcome.seen` writes
// down, in the app's settings in its data folder (never in a project), that the person has answered it.
//
// The app in the emulator is its project folder: a project whose folder was deleted or moved away leaves the list and
// its app leaves the bar (`busy-emulator projects --prune`, at every list, when the server is ready, and when a look
// at the folders every few seconds finds one gone). A folder whose disk is gone is unavailable, not deleted.
//
// What the command line says comes to the page in the window's words (window-texts.mjs): its hints name the window's
// buttons, not commands to type, and never the path of the Node or the command line inside the app.
//
// Pure but for what it is given, so that the rules can be tested on plain Node.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_BOX_LENGTH, MAX_BOXES } from "./github/publish-flow.mjs";
import { insideFolder, insideRoots, trashableFolder } from "./path-boundary.mjs";
import { findProjectRoot } from "./project-root.mjs";
import { windowText } from "./window-texts.mjs";

/** The channel the jobs' progress goes to the page on. */
export const JOB_CHANNEL = "busy-shell-job";
/** The channel the app menu's items for the page go on: "create" (New App… opens Create app's pop-up). */
export const MENU_CHANNEL = "busy-shell-menu";

/** The actions the page may ask for, by the names the bridge knows. */
export const WINDOW_ACTIONS = Object.freeze([
  "projects.list",
  "projects.examples",
  "projects.place",
  "projects.place.choose",
  "projects.create",
  "projects.open",
  "projects.find",
  "projects.import",
  "projects.refresh",
  "projects.dependencies",
  "projects.dependencies.auto",
  "projects.build",
  "projects.run",
  "projects.stop",
  "projects.dev.start",
  "projects.dev.stop",
  "projects.check",
  "projects.submit",
  "projects.package.install",
  "apps.delete",
  "publish.status",
  "publish.check",
  "publish.texts",
  "publish.icon",
  "publish.screenshots",
  "publish.readme",
  "publish.license",
  "publish.files",
  "publish.package",
  "github.status",
  "github.signin",
  "github.use",
  "github.signin.wait",
  "github.signin.cancel",
  "github.code.open",
  "github.signout",
  "github.name",
  "github.push",
  "github.cancel",
  "github.checklist",
  "github.request",
  "github.entry",
  "github.lookup",
  "github.import",
  "github.release.install",
  "reveal",
  "open",
  "copy",
  "browse",
  "welcome.get",
  "welcome.seen",
]);

/** github.entry and github.lookup: how many new questions to GitHub a minute (catalog-update). */
const LOOKS_A_MINUTE = 20;
/** github.name: how long an answer is kept, and how many new checks a minute (audit H11). */
export const NAME_CHECK_KEEP_MS = 10_000;
export const NAME_CHECKS_A_MINUTE = 20;
/** And at most this many an hour: GitHub's hourly quota is the person's, for every program that uses GitHub CLI (F4). */
export const NAME_CHECKS_AN_HOUR = 100;

/**
 * The ones that only read: the page may ask for them at any time. Every other one needs the person's click or key.
 * publish.check reads too: the catalog's checks, with the step noted in the project's .busy/ and the empty form of
 * catalog.json put down when there is none, as `check` of an agent does (the flow runs it when it opens, after it has
 * read where the project stands, and that may take more than the click's two seconds).
 */
export const NO_GESTURE_NEEDED = Object.freeze(["projects.list", "projects.examples", "projects.place", "projects.dependencies.auto", "welcome.get", "publish.status", "publish.check", "github.status", "github.signin.wait", "github.signin.cancel", "github.name", "github.cancel", "github.checklist", "github.entry", "github.lookup"]);

/** publish.files without write and the paths to keep out or in only reads the plan of the repository's files. */
const filesChange = (arg) => arg === null || typeof arg !== "object" || arg.write === true || ["keepOut", "keepIn", "readme"].some((key) => arg[key] !== undefined && arg[key] !== null);

/** Whether an action needs the person's click or key: true, false, or by its argument (bridge.mjs). */
export function gestureFor(name) {
  if (NO_GESTURE_NEEDED.includes(name)) return false;
  if (name === "publish.files") return filesChange;
  return true;
}

/** The setting that says the person has answered the first run's greeting. */
export const WELCOMED = "welcomed";
/** The setting that keeps the way the person chose in it, so that "Getting started" opens on that way next time. */
export const WELCOME_WAY = "welcomeWay";
/** The ways the greeting offers: by hand, or with an AI agent. */
export const WELCOME_WAYS = Object.freeze(["code", "agent"]);

/**
 * The command line's path as the text for agents shows it: what the pointer file names (install.json, ADR-0002 §7),
 * else the launcher the app wrote; null when there is none (a run from the source folder). On macOS a path in the
 * home folder is written from `~`, as the agents' instructions write it, so that the text has no user name in it.
 */
export function shownCliPath({ pointer = null, launcher = null, home = null, platform = process.platform } = {}) {
  let cli = null;
  try {
    const named = pointer ? JSON.parse(readFileSync(pointer, "utf8")).cli : null;
    if (typeof named === "string" && path.isAbsolute(named)) cli = named;
  } catch {
    // No pointer yet, or one that cannot be read: the launcher's own path.
  }
  cli ??= typeof launcher === "string" && launcher ? launcher : null;
  if (cli && platform !== "win32" && home && cli.startsWith(`${home.replace(/\/+$/, "")}/`)) cli = `~${cli.slice(home.replace(/\/+$/, "").length)}`;
  return cli;
}

/**
 * Whether the system may take a folder for something to start rather than to look into: a name with an extension
 * (X.app, X.bundle, X.{CLSID} on Windows) or a Contents folder inside (a bundle on macOS even without the extension).
 * Opening such a folder starts it (Electron's openPath is the system's double click), so it is selected instead.
 */
export function maybeLaunched(folder, { holdsContents = (item) => existsSync(path.join(item, "Contents")) } = {}) {
  if (/.\.[^.\\/]+$/.test(path.basename(folder))) return true;
  try {
    return holdsContents(folder);
  } catch {
    return true;
  }
}

/**
 * How Show in Finder/Explorer shows a path: a folder (a project's, the data folder's) is opened, so that its files are
 * in view; anything else is selected in the folder it is in, and so is a folder the system could start when opened
 * (maybeLaunched: a project folder named X.app with Contents/MacOS in it would run; showItemInFolder never starts
 * anything). A folder the system does not open is selected instead. `isDirectory` and `holdsContents` are the looks
 * at the disk, given so that the rule is tested on plain Node.
 */
export function showPath(target, { openPath, showItemInFolder, log = () => {}, isDirectory = (item) => statSync(item).isDirectory(), holdsContents }) {
  let folder = false;
  try {
    folder = isDirectory(target);
  } catch {
    // Gone since it was checked: the system says so in its own window.
  }
  if (!folder || maybeLaunched(target, holdsContents ? { holdsContents } : {})) return void showItemInFolder(target);
  const instead = (failed) => {
    log(`[shell] actions: the system did not open the folder (${String(failed).slice(0, 200)}); selecting it instead`);
    showItemInFolder(target);
  };
  return Promise.resolve()
    .then(() => openPath(target))
    .then((failed) => failed && instead(failed), instead);
}

// ---- Delete in the Apps list (apps.delete)

// The rule which folder Delete may move to the Trash is the one the command line keeps (path-boundary.mjs, a copy of
// packages/server/path-boundary.mjs that a test keeps the same; `busy-emulator uninstall --delete-files`).
export { trashableFolder };

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Whether Windows can move `folder` to the Recycle Bin: null when it can, else why not. Where there is none (a USB
 * stick, a network share, a session without a person's desktop) the system's call deletes for good instead (checked
 * on Windows 10 for the session), so the window refuses there. The command line's uninstall --delete-files does the
 * same check (packages/server/cli/system.mjs). `env` is the app's environment; `run(program, args, options)` is
 * execFileSync, given for the tests.
 */
export function windowsRecycleRefusal(folder, { env, run }) {
  const windowsDir = env.SystemRoot ?? "C:\\Windows";
  if (/^[\\/]{2}/.test(folder)) return "The folder is on a network share, which has no Recycle Bin, so it was not moved. Move it yourself.";
  const check = [
    "$folder = $env:BUSY_EMULATOR_TRASH",
    "if ((Get-Process -Id $PID).SessionId -eq 0) { 'session' } elseif (([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($folder))).DriveType -ne 'Fixed') { 'drive' } else { 'ok' }",
  ].join("; ");
  let said;
  try {
    said = String(run(path.win32.join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", check], { env: { ...env, BUSY_EMULATOR_TRASH: folder }, windowsHide: true, timeout: 20_000, encoding: "utf8" })).trim();
  } catch (e) {
    return `Windows did not say whether the folder can go to the Recycle Bin (${String(e?.message ?? e).slice(0, 200)}), so it was not moved.`;
  }
  if (said === "ok") return null;
  if (said === "session") return "This session has no Recycle Bin, so the folder was not moved. Move it yourself.";
  return "The folder is not on a fixed disk of this computer, which has no Recycle Bin, so it was not moved. Move it yourself.";
}

const EXAMPLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PATH = 4096;
/** The largest license file License's Upload takes: the command line's own limit (files.mjs copyLicense). */
const LICENSE_UPLOAD_MAX = 256 * 1024;
/** A package the person chooses: at most what the BUSY Bar takes (100 MiB, MAX_UPLOAD_FILE_SIZE). */
const PACKAGE_MAX = 100 * 1024 * 1024;
/** A path, an id, a command: what the window copies is short. */
export const MAX_COPY = 64 * 1024;
const INTERRUPT_WAIT_MS = 5000;
export const LOOK_EVERY_MS = 5000;

/** A failure the page is told: what happened and what to do. */
export class ActionFailure extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** The folder the person chose, by its real path when it is there: the path the list and the jobs name it by. */
function realOf(folder) {
  if (typeof folder !== "string" || !folder) return null;
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
}

const refusal = (code, message, hint = null) => ({ ok: false, code, message, ...(hint ? { hint } : {}) });

/** The command line's one line of JSON: the last line it printed that is one. */
export function answerOf(ended, logFile) {
  for (let i = ended.lines.length - 1; i >= 0; i--) {
    const line = ended.lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const answer = JSON.parse(line);
      if (typeof answer?.ok === "boolean") return answer;
    } catch {
      // Not the answer; an earlier line may be.
    }
  }
  const how = ended.error ?? (ended.signal ? `stopped by ${ended.signal}` : `exit code ${ended.code}`);
  return refusal("no_answer", `The emulator's command line gave no answer (${how}).`, `The log is at ${logFile}.`);
}

const TEXT_OPTIONS = [["category", "--category"], ["short_description", "--short-description"], ["description", "--description"], ["changelog", "--changelog"]];
const MAX_TEXT = 8000;
const LICENSE_CHOICES = ["MIT", "Apache-2.0", "GPL-3.0", "other"];
/** What the window may open in the system's app: text files, which no app runs. */
const OPENED = /\.(?:json|md|txt)$/i;
/** A path inside a project as the publishing flow names it: relative, forward slashes, nothing that leaves it. */
const insidePath = (value) => typeof value === "string" && value.length > 0 && value.length <= 500 && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && !value.split("/").some((part) => part === "" || part === "." || part === "..");

// ---- Create app's form (the window's create-app.js): where the new project goes, its name, id, texts and icons

/** The folder a new project is made in, by default: in the person's home, beside their own folders. */
export const NEW_PROJECTS_FOLDER = "BUSY Bar projects";
/** A project's own folder as the form names it: one plain name, no path, nothing a system reads as special. */
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,62}[A-Za-z0-9_-]$|^[A-Za-z0-9]$/;
/** What busy-cli builds and the bar installs: lower-case for the catalog, at most 32 characters. */
const NEW_APP_ID = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
/** A name or a short description the template's generator writes as it is: no quote, backslash or control character. */
const UNSAFE_TEXT = /["\\\u0000-\u001f\u007f]/;
const MAX_NAME = 64;
const ICON_COLOR = /^#[0-9A-Fa-f]{6}$/;
const ICON_TEXT = /^[A-Za-z0-9]{1,2}$/;
/** An icon is a few hundred bytes; a picture that is not 8×8 or 11×11 is refused before it is written anywhere. */
const MAX_ICON_BYTES = 64 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PNG of a data: address or plain base64 that is `size`×`size`, as bytes; null when it is not one. */
export function iconPicture(text, size) {
  if (typeof text !== "string" || text.length > MAX_ICON_BYTES * 2) return null;
  const base64 = text.replace(/^data:image\/png;base64,/, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 33 || bytes.length > MAX_ICON_BYTES || !bytes.subarray(0, 8).equals(PNG_MAGIC) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return bytes.readUInt32BE(16) === size && bytes.readUInt32BE(20) === size ? bytes : null;
}

/**
 * The form's answers, checked before anything runs: { name, id, folder, texts, icon } as the command line takes them,
 * or { problem } that says what is wrong. Whatever the page leaves out is the command line's default.
 */
export function createRequest(options) {
  const o = options && typeof options === "object" ? options : {};
  const out = { name: null, id: null, description: null, texts: null, icon: null, author: null };
  if (o.author !== undefined && o.author !== null) {
    if (typeof o.author !== "string" || !o.author.trim() || o.author.length > MAX_NAME || UNSAFE_TEXT.test(o.author)) return { problem: "The author is a line of text without quotes or backslashes." };
    if (genericAuthor(o.author)) return { problem: `"${o.author.trim()}" is a name many computers share: write your GitHub login or your own name.` };
    out.author = o.author.trim();
  }
  if (o.name !== undefined && o.name !== null) {
    if (typeof o.name !== "string" || !o.name.trim() || o.name.length > MAX_NAME || UNSAFE_TEXT.test(o.name)) return { problem: "The name is a line of text without quotes or backslashes." };
    out.name = o.name;
  }
  if (o.id !== undefined && o.id !== null) {
    if (typeof o.id !== "string" || !NEW_APP_ID.test(o.id)) return { problem: "The id is up to 32 lower-case Latin letters, digits, _, - and dots." };
    out.id = o.id;
  }
  if (o.texts !== undefined && o.texts !== null) {
    if (typeof o.texts !== "object") return { problem: "The catalog texts are missing." };
    const texts = {};
    for (const [field, option] of TEXT_OPTIONS.slice(0, 2)) {
      const value = o.texts[field];
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string" || value.length > MAX_TEXT) return { problem: `${field} is a text of up to ${MAX_TEXT} characters.` };
      texts[option] = value;
    }
    if (Object.keys(texts).length) out.texts = texts;
    // The short description is the manifest's too, where the generator can write it as it is.
    const short = o.texts.short_description;
    if (typeof short === "string" && short.trim() && short.length <= 200 && !UNSAFE_TEXT.test(short)) out.description = short;
  }
  if (o.icon !== undefined && o.icon !== null) {
    const icon = o.icon;
    if (typeof icon !== "object") return { problem: "The icon is letters or a picture." };
    if (icon.text !== undefined) {
      if (!ICON_TEXT.test(String(icon.text)) || (icon.color !== undefined && !ICON_COLOR.test(String(icon.color)))) return { problem: "Letter icons are one or two letters or digits, in a color #RRGGBB." };
      out.icon = { text: String(icon.text).toUpperCase(), color: icon.color ?? null };
    } else {
      // A back icon alone keeps the front the command line's create gave the project (the default one).
      const noFront = (icon.front === undefined || icon.front === null) && icon.back !== undefined && icon.back !== null;
      const front = noFront ? null : iconPicture(icon.front, 8);
      if (!front && !noFront) return { problem: "The front icon is a PNG of 8×8 pixels." };
      const back = icon.back === undefined || icon.back === null ? null : iconPicture(icon.back, 11);
      if (icon.back !== undefined && icon.back !== null && !back) return { problem: "The back icon is a PNG of 11×11 pixels." };
      out.icon = { front, back };
    }
  }
  return out;
}

/** A folder that can be made into the new project: not there, or an empty folder (the system's own files aside). */
function freeFolder(target) {
  try {
    if (!statSync(target).isDirectory()) return false;
    return readdirSync(target).every((name) => name === ".DS_Store" || name === ".git");
  } catch (e) {
    return e?.code === "ENOENT";
  }
}

/** `folder`, or folder-2, folder-3… in `parent`: the first one free. */
function freeName(parent, folder) {
  if (freeFolder(path.join(parent, folder))) return folder;
  for (let n = 2; n < 100; n++) if (freeFolder(path.join(parent, `${folder}-${n}`))) return `${folder}-${n}`;
  return null;
}

/** An id's part from an author's name, the generator's way for plain Latin: lower-case, spaces as _, the rest out. */
export function namespaceOf(author) {
  const part = String(author ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[\s.]+/g, "_")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return part || "example";
}

/**
 * Names many computers share as their account's name: an id made from one would be other people's too in the
 * catalog. The same list as GENERIC_AUTHORS of packages/server/readiness/rules.mjs (a test keeps them the same).
 */
export const GENERIC_AUTHORS = Object.freeze(["user", "users", "admin", "administrator", "owner", "pc", "guest", "root", "default", "defaultuser", "defaultuser0", "me", "you", "test", "dev", "developer", "computer", "home", "mac", "macbook", "windows", "ubuntu", "pi", "demo", "student", "example", "your_name", "busy_bar_developer", "benutzer", "usuario", "utilisateur", "polzovatel"]);

/** Whether `name` is one of GENERIC_AUTHORS, as an id's part (namespaceOf). */
export const genericAuthor = (name) => GENERIC_AUTHORS.includes(namespaceOf(name));

/** A GitHub login (github/gh.mjs, LOGIN). */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The author of a new app, and so its id's namespace (app.<author>.<app>), as the command line's create takes it
 * (packages/server/projects/author.mjs): { name, from: "github" | "git" | "account" }, or null when there is none but
 * a name many computers share (the release dry run, 12.11: a Windows account "User" gave everyone app.user.my_app);
 * Create app then asks for it. `login`: the GitHub login signed in (the app's, else GitHub CLI's active one).
 */
export function newAppAuthor(home, { login = null, configHome = null, userName = () => os.userInfo().username } = {}) {
  if (typeof login === "string" && GITHUB_LOGIN.test(login)) return { name: login, from: "github" };
  const git = gitAuthor(home, { configHome, userName: () => null });
  if (git) return genericAuthor(git) || UNSAFE_TEXT.test(git) ? null : { name: git, from: "git" };
  let account = null;
  try {
    account = (userName() ?? "").trim() || null;
  } catch {
    account = null;
  }
  return account && !genericAuthor(account) && !UNSAFE_TEXT.test(account) ? { name: account, from: "account" } : null;
}

/**
 * The author the template's generator will write for a new project: git's user.name, read from the person's own git
 * settings file (no git is started: on a Mac without the developer tools that asks to install them), else the
 * account's name. Null when neither is there. `configHome`: XDG_CONFIG_HOME, which main.mjs reads.
 */
export function gitAuthor(home, { configHome = null, userName = () => os.userInfo().username } = {}) {
  for (const file of [path.join(home, ".gitconfig"), path.join(configHome || path.join(home, ".config"), "git", "config")]) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let inUser = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[")) inUser = /^\[\s*user\s*\]$/i.test(line);
      else if (inUser) {
        const found = /^name\s*=\s*(.*)$/i.exec(line);
        const name = found?.[1].replace(/^"(.*)"$/, "$1").trim();
        if (name) return name;
      }
    }
  }
  try {
    return userName() || null;
  } catch {
    return null;
  }
}

/** An event line of `dev --once --json`, or null. */
function eventOf(line) {
  try {
    const event = JSON.parse(line);
    return typeof event?.event === "string" ? event : null;
  } catch {
    return null;
  }
}

/** The steps of a round that fail: the answer that ends the round says the same, with the tool's output. */
const FAILURE_EVENTS = new Set(["build_failed", "install_failed", "run_failed"]);

/** What a round of `dev --once --json` says while it works, for the window's log. */
function refreshLine(line) {
  const event = eventOf(line);
  switch (event?.event) {
    case "build_started":
      return "Building";
    case "installed":
      return "Installed";
    case "running":
      return "Started";
    case "build_failed":
    case "install_failed":
    case "run_failed":
      return [`${event.tool ?? "The build"} failed`, event.output || event.message || ""].filter(Boolean).join("\n");
    default:
      return null;
  }
}

/** One of the catalog's checks as the window shows it, in the window's words. */
function shownCheck(check, words) {
  const fails = check.status === "fail";
  const parts = fails ? [check.catalog?.problem, check.found && `Here: ${check.found}`, check.change && `Change: ${check.change}`] : check.status === "unchecked" ? [check.why, check.change] : [check.found];
  return {
    id: check.id,
    title: check.title,
    answer: fails ? "fails" : check.status === "unchecked" ? "unchecked" : "passes",
    message: words(parts.filter(Boolean).join("\n")),
    // A failing check that is a warning: the catalog takes the app with it.
    blocking: check.blocking !== false,
  };
}

/**
 * The checks of an answer of `check`: the whole list (`checks`), or the short form that names only the checks that
 * need something (`failing`, `warnings`, `unchecked`, each { id, title, message, fix }), as the window shows them.
 */
function checksOf(answer, words) {
  if (Array.isArray(answer.checks)) return answer.checks.filter((check) => check.applies !== false).map((check) => shownCheck(check, words));
  if (!Array.isArray(answer.failing)) return null;
  const short = (answerOf, blocking) => (check) => ({ id: check.id, title: check.title, answer: answerOf, message: words([check.message && (answerOf === "fails" ? `Here: ${check.message}` : check.message), check.fix && (answerOf === "fails" ? `Change: ${check.fix}` : check.fix)].filter(Boolean).join("\n")), blocking });
  return [...answer.failing.map(short("fails", true)), ...(answer.warnings ?? []).map(short("fails", false)), ...(answer.unchecked ?? []).map(short("unchecked", true))];
}

// ---- a project's dependencies (create-offline)

/** Why the dependencies are not installed, in the window's words: the row says "Dependencies not installed: …". */
const DEPENDENCY_WORDS = { network_failed: "no network", network_stalled: "no answer from the npm registry", blocked_network: "the network is blocked", interrupted: "the install was stopped" };

/**
 * How a project's dependencies stand, for the page: { state, reason, message, retry }. `retry`: whether it is the
 * network's failure (or a cut-off install), which the window tries again by itself when the network may be back.
 */
export function dependenciesOf(listed) {
  const state = typeof listed?.state === "string" ? listed.state : "installed";
  if (state !== "failed" && state !== "interrupted") return { state, reason: null, message: null, retry: false };
  const code = state === "interrupted" ? "interrupted" : listed.code;
  return { state, reason: DEPENDENCY_WORDS[code] ?? "npm failed", message: typeof listed.message === "string" && listed.message ? listed.message : null, retry: code in DEPENDENCY_WORDS && code !== "blocked_network" };
}

/** The failures of a project's dependencies (npm and the network): Retry is for them. */
const DEPENDENCY_FAILURES = new Set(["network_failed", "network_stalled", "blocked_network"]);

/** How a Refresh round's lines are shown, and which line already told its failure. */
const REFRESH_JOB = Object.freeze({ lineOf: (line, stream) => (stream === "err" ? line : refreshLine(line)), saysFailure: (line) => FAILURE_EVENTS.has(eventOf(line)?.event) });

/** How often the window's automatic Retry may run for one project: the network is looked at no more often. */
export const AUTO_RETRY_MS = 20_000;

/**
 * @param {object} o
 * @param {(args: string[], onLine?: (line: string, stream: "out" | "err") => void) => { pid: number, exited: Promise<object>, interrupt: () => void, killNow: () => void }} o.startCli
 * @param {{ chooseExisting: () => Promise<string|null>, chooseNew: () => Promise<string|null>, chooseAny?: (pick: string) => Promise<string|null> }} o.dialogs
 *   the system's folder dialogs
 * @param {(folder: string) => void} o.show          shows a folder in Finder or Explorer
 * @param {(text: string) => void} o.copy            puts a text on the clipboard
 * @param {(file: string) => void} [o.open]          opens a file of a project in the system's app for it
 * @param {(folder: string) => Promise<void>} [o.trash]  moves a folder to the Trash or the Recycle Bin (shell.trashItem)
 * @param {(folder: string) => string|null} [o.trashRefusal]  why the system would not keep the folder in its Trash
 *   (windowsRecycleRefusal), or null
 * @param {string} [o.home]                          the user's home folder, which Delete never moves
 * @param {(job: object) => void} o.send             a job's progress, to the main window's page
 * @param {string} o.dataDir
 * @param {string} o.logFile
 * @param {(line: string) => void} o.log
 * @param {(folder: string) => boolean} [o.folderThere]  the look at a folder, every few seconds
 * @param {string} [o.platform]  the system's, for the window's words (Finder or Explorer)
 * @param {object} [o.welcome]  the first run's greeting: `settings` (createSettings of the app's settings file),
 *   `platform`, and `cli()`: the command line's path as the text for agents shows it, or null
 * @param {string} [o.newProjects]  where Create app puts a new project's folder unless the person chooses another
 *   place: ~/BUSY Bar projects (a test's own folder under a test)
 * @param {string} [o.home]  the person's home, which the form shows as ~ on macOS
 * @param {() => ({ name: string, from: string }|string|null)} [o.author]  the author a new app gets (newAppAuthor): the id the form suggests
 *   starts with it
 * @param {(question: object) => Promise<"yes" | "no" | "unavailable">} [o.confirm]  a yes-or-no question to the person
 *   in a dialog of the app's (person-question.mjs confirm): whether to install a package
 * @param {{ send: (method: string, pathname: string, body?: Buffer | null) => Promise<{ status?: number, body?: string, failed?: string }> }} [o.bar]
 *   the emulated BUSY Bar's own API on 127.0.0.1, for a package's upload
 */
export function createActions({ startCli: startCliProcess, dialogs, show, copy, open = () => {}, browse = () => {}, barOrigin = null, trash = null, trashRefusal = () => null, send, dataDir, logFile, log, folderThere = existsSync, platform = process.platform, welcome = null, github = null, newProjects = null, home = null, author = () => null, now = Date.now, confirm = null, bar = null }) {
  // github.name asks GitHub (gh api, up to ten requests) and needs no gesture, as the name is checked while the person
  // types: a page that calls it in a loop must not spend the person's GitHub quota (audit H11). The same question
  // while one is under way gets its answer; an answer is kept NAME_CHECK_KEEP_MS; at most NAME_CHECKS_A_MINUTE new
  // ones a minute.
  const nameChecks = { running: new Map(), kept: new Map(), times: [] };
  /** A text of the command line's in the window's words. */
  const words = (text) => windowText(text, { platform });
  /** A failure the command line answered, for the page. */
  const failed = (answer) => refusal(answer.code ?? "failed", words(answer.message ?? "It failed."), words(answer.hint ?? null));
  /** The same, thrown. */
  const failure = (answer, otherwise) => new ActionFailure(answer.code ?? "failed", words(answer.message ?? otherwise), words(answer.hint ?? null));
  /** The command line's whole answer for the page, without its own name: its data on success, its data and why not. */
  const answered = (answer) => {
    const { command: _command, ...rest } = answer;
    return answer.ok ? rest : { ...rest, ...failed(answer) };
  };
  const jobs = new Map(); // folder → { id, kind, run }
  /** The author a new app gets now (newAppAuthor), as { name, from }; a plain name (a test's) is git's. */
  const authorOf = () => {
    let said = null;
    try {
      said = author();
    } catch {
      return null;
    }
    if (typeof said === "string") return said.trim() ? { name: said.trim(), from: "git" } : null;
    return said && typeof said.name === "string" && said.name.trim() ? { name: said.name.trim(), from: String(said.from ?? "git") } : null;
  };
  const children = new Set(); // every run of the command line that has not ended
  const startCli = (args, onLine) => {
    const run = startCliProcess(args, onLine);
    children.add(run);
    run.exited.then(() => children.delete(run));
    return run;
  };
  let nextJob = 1;
  const opening = new Set(); // the folders the person chose in Open App Folder and that are being opened now
  const found = new Set(); // the projects Open existing found from the person's own choice: the ones it may open
  const places = new Set(newProjects ? [newProjects] : []); // where Create app may make a project's folder: the default, and what the person chose in Location
  const licenseChosen = new Map(); // folder → the license file the person chose, kept while they are asked whether it replaces the one there
  let nextIcons = 1;
  let known = []; // the list as it was last read
  let owed = false; // a deleted project is still in the list: the bar would not say what it holds when it was read
  let sweeping = null;
  let sweepNext = null; // the read after the one under way, for the calls that came meanwhile
  let timer = null;
  const autoTried = new Map(); // folder → when the window's automatic Retry last tried its dependencies
  let autoRunning = null;
  const meantToRun = new Set(); // the folders whose app was meant to run when their dependencies failed: a Refresh, Create app's pop-up

  /** A Refresh's answer for the page. */
  const refreshAnswer = (answer) => (answer.ok ? { ok: true, message: answer.running === false ? `${named(answer)} was started and ran to its end.` : `${named(answer)} is running.` } : failed(answer));

  /**
   * After a Retry brought the dependencies (the person's or the window's own): the Refresh that had stopped at them,
   * for a project whose app was meant to run; null for any other project.
   */
  async function afterDependencies(folder) {
    if (!meantToRun.delete(folder) || jobs.has(folder)) return null;
    log(`[shell] actions: ${folder} has its dependencies now; refreshing it, as was asked before they failed`);
    const answer = await job("refresh", folder, ["dev", folder, "--once"], REFRESH_JOB);
    if (!answer.ok && DEPENDENCY_FAILURES.has(answer.code)) meantToRun.add(folder);
    return refreshAnswer(answer);
  }

  const emit = (job, state, line, upload = null) => {
    try {
      send({ id: job.id, kind: job.kind, folder: job.folder, state, ...(line ? { line: words(line) } : {}), ...(upload ? { upload } : {}) });
    } catch (e) {
      log(`[shell] actions: a job's progress did not reach the window: ${e?.message ?? e}`);
    }
  };
  /** Something that is no job of a project but changes the list: a project left, a disk came or went. */
  const note = (kind, folder, line) => emit({ id: nextJob++, kind, folder }, "done", line);

  /** Runs the command line to its end and gives its answer. */
  async function ask(args, onLine) {
    const run = startCli([...args, "--json"], onLine);
    return answerOf(await run.exited, logFile);
  }

  /**
   * The list, read anew; projects whose folder was deleted leave it, and their apps the bar. One at a time: a call that
   * comes while a read is under way gets that read. With `fresh` (the window's list) it gets the next read instead,
   * which begins when that one ends: the read under way may have read the list before the change the window has just
   * seen (the command line noted a project, then installed its app). All such calls meanwhile share that next read.
   */
  function sweep({ fresh = false } = {}) {
    if (sweeping && !fresh) return sweeping;
    if (sweeping) {
      sweepNext ??= sweeping.catch(() => {}).then(() => {
        sweepNext = null;
        return sweep();
      });
      return sweepNext;
    }
    sweeping = (async () => {
      try {
        const answer = await ask(["projects", "--prune"]);
        if (!answer.ok || !Array.isArray(answer.projects)) throw failure(answer, "The emulator's projects could not be read.");
        for (const gone of answer.removed ?? []) {
          log(`[shell] actions: the project ${gone.folder} is gone${gone.uninstalled ? `; ${gone.id} was removed from the BUSY Bar` : ""}`);
          note("removed", gone.folder, gone.uninstalled ? `${gone.id} left the BUSY Bar: its project folder is gone.` : "The project left the list: its folder is gone.");
        }
        const before = new Map(known.map((project) => [project.folder, project]));
        known = answer.projects.map((project) => ({
          id: project.id ?? null,
          name: project.name ?? null,
          folder: project.folder,
          exists: project.exists === true,
          unavailable: project.unavailable === true,
          trusted: project.trusted === true,
          built: project.built === true,
          installed: project.installed === true,
          running: project.running === true,
          // Its files changed after it last put its app on the bar (the window's "Files changed" notice).
          stale: project.stale === true,
          dependencies: dependenciesOf(project.dependencies),
          shownFolder: shownPath(project.folder),
        }));
        owed = answer.bar !== "ready" && known.some((project) => !project.exists && !project.unavailable);
        for (const project of known) {
          const was = before.get(project.folder);
          if (was && was.unavailable !== project.unavailable) note("changed", project.folder, project.unavailable ? "The folder is unavailable: its disk is not there." : "The folder is back.");
        }
        return known;
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  }

  const withJobs = (projects) => projects.map((project) => ({ ...project, job: jobs.get(project.folder)?.kind ?? null }));

  /**
   * The cheap look: when a folder of the list came or went, the list is read anew; and so it is while a deleted
   * project waits for the bar to answer.
   */
  function look() {
    if (sweeping || !(owed || known.some((project) => folderThere(project.folder) !== project.exists))) return null;
    return sweep().catch((e) => log(`[shell] actions: the projects could not be read: ${e?.message ?? e}`));
  }

  /** The project the page names, when it may be worked on; otherwise what to tell the page. */
  async function projectFor(folder) {
    if (typeof folder !== "string" || !folder || folder.length > MAX_PATH) return { refused: refusal("unknown_project", "This is not a project of the emulator.") };
    const project = (await sweep()).find((one) => one.folder === folder);
    if (!project) return { refused: refusal("unknown_project", "This folder is not among the emulator's projects.", "Open it with Open App Folder.") };
    if (project.unavailable) return { refused: refusal("folder_unavailable", `The project's folder is unavailable: its disk is not there (${folder}).`, "Connect the disk; the project works again then.") };
    if (!project.exists) return { refused: refusal("folder_missing", `The project's folder is gone (${folder}).`, "Open the project where it lies now with Open App Folder.") };
    if (!project.trusted) return { refused: refusal("untrusted_project", `The project's folder is not trusted (${folder}).`, "Open it with Open App Folder: the emulator asks whether you trust it.") };
    return { project };
  }

  const busy = (folder) => refusal("busy", `The project is busy: ${jobs.get(folder).kind} is running.`, "Wait until it ends, or stop it.");

  /** A path as the form shows it: from ~ on macOS when it is in the home folder. */
  const shownPath = (full) => {
    const base = typeof home === "string" && home ? home.replace(/[\\/]+$/, "") : null;
    return platform !== "win32" && base && (full === base || full.startsWith(`${base}/`)) ? `~${full.slice(base.length)}` : full;
  };

  /**
   * The license file the person chose in License's Upload dialog, copied into a folder of the data folder's own for the
   * command line (which takes no file from elsewhere): { file, folder } or { refused }. Read once, at most
   * LICENSE_UPLOAD_MAX bytes; the command line checks that it is a license's text.
   */
  function stageLicense(chosen) {
    let bytes;
    try {
      if (!statSync(chosen).isFile() || statSync(chosen).size > LICENSE_UPLOAD_MAX) return { refused: refusal("not_license", `${path.basename(chosen)} is not a license's text file.`, "Choose the text file of your license: LICENSE, LICENSE.md or COPYING.") };
      bytes = readFileSync(chosen);
    } catch (e) {
      return { refused: refusal("not_license", `${path.basename(chosen)} could not be read (${e?.code ?? e?.message ?? e}).`, "Choose the text file of your license: LICENSE, LICENSE.md or COPYING.") };
    }
    const folder = path.join(dataDir, "tmp", `license-${process.pid}-${nextIcons++}`);
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, path.basename(chosen));
      writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      return { file, folder };
    } catch (e) {
      rmSync(folder, { recursive: true, force: true });
      return { refused: refusal("write_failed", `The license file could not be put down for the command line (${e?.code ?? e?.message ?? e}).`) };
    }
  }

  /** The words of the trust dialog of a package: the file, the app, where it came from, what installing it means. */
  const packageQuestion = (facts, { shown, source }) => ({
    about: `package ${facts.id}`,
    message: "Install this app package?",
    detail: [
      shown,
      "",
      `App: ${facts.name} (${facts.id}), version ${facts.version}`,
      `From: ${source}`,
      ...(facts.notes?.length ? ["", ...facts.notes] : []),
      "",
      "This package is someone else's code. Installing it puts the app on the emulated BUSY Bar and starts it there. It runs on the emulated BUSY Bar only, which keeps it away from this computer's files and local services; what it shows and which internet services it talks to are up to its author.",
      "",
      "Install it only if you know where it came from.",
    ].join("\n"),
    buttons: ["Cancel", "Install"],
    yes: 1,
  });

  /** The bar's answer as JSON, or null. */
  const barJson = (answer) => {
    try {
      return JSON.parse(answer?.body ?? "");
    } catch {
      return null;
    }
  };
  const barSaid = (answer) => barJson(answer)?.error ?? answer?.failed ?? `HTTP ${answer?.status}`;

  /**
   * A package's bytes, installed after the look and the person's yes (see the top of this file). `shown`: the first
   * line of the dialog (the file, or the release's file); `source`: where it came from. Resolves with { ok: true, id,
   * name, version, running, message }, { ok: false, code: "declined" } after Cancel, or a refusal.
   */
  async function installPackageBytes(bytes, { shown, source }) {
    if (!bar || !confirm) return refusal("unavailable", "Installing a package is not available here.");
    const scratch = insideFolder(dataDir, `tmp/package-${process.pid}-${nextIcons++}`, { missing: true, platform });
    if (!scratch) return refusal("write_failed", "The package could not be put down for the command line: the data folder's tmp folder leads out of it.");
    try {
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      const copied = path.join(scratch, "package.tgz");
      writeFileSync(copied, bytes, { flag: "wx", mode: 0o600 });
      const looked = await ask(["install", copied, "--check"]);
      if (!looked.ok) return failed(looked);
      const facts = { id: looked.id, name: looked.name ?? looked.id, version: looked.version, api_version: looked.api_version, notes: Array.isArray(looked.notes) ? looked.notes.map(String).slice(0, 5) : [] };
      const said = await confirm(packageQuestion(facts, { shown, source }));
      if (said !== "yes") {
        log(`[shell] actions: ${facts.id} ${facts.version} not installed: ${said === "no" ? "the person chose Cancel" : "the person could not be asked"}`);
        return said === "no" ? { ok: false, code: "declined", message: "Nothing was installed." } : refusal("unavailable", "BUSY Bar Emulator could not ask you whether to install the package, so nothing was installed.", "Bring its window to the front, then try again.");
      }
      // The bytes the command line checked and the person was asked about are the bytes sent: the copy is read again,
      // and one that changed meanwhile (another program of this account) is not installed.
      const sent = readFileSync(copied);
      if (!sent.equals(bytes)) return refusal("install_failed", "The package changed after it was checked, so it was not installed.", "Choose it again.");
      const staged = await bar.send("POST", "/api/apps/stage", sent);
      const stage = barJson(staged);
      if (staged?.status !== 200 || (typeof stage?.install_key !== "string" && typeof stage?.install_key !== "number")) {
        if (stage?.error_code === "api_mismatch") return refusal("api_mismatch", `${facts.name} needs API ${facts.api_version}, newer than the emulated BUSY Bar's.`, "Update BUSY Bar Emulator, or ask the app's author for a version for this firmware.");
        return refusal("install_failed", staged?.failed ? `The emulated BUSY Bar is not answering (${staged.failed}).` : `The emulated BUSY Bar did not take the package: ${barSaid(staged)}.`);
      }
      if (stage.staged?.id && stage.staged.id !== facts.id) return refusal("install_failed", `The emulated BUSY Bar found ${stage.staged.id} in the package, not ${facts.id}, so it was not installed.`);
      const installed = await bar.send("POST", `/api/apps/install?install_key=${encodeURIComponent(String(stage.install_key))}`, null);
      if (installed?.status !== 200) return refusal("install_failed", `The emulated BUSY Bar did not install ${facts.name}: ${barSaid(installed)}.`);
      log(`[shell] actions: installed ${facts.id} ${facts.version} from a package (${source})`);
      const launched = await bar.send("POST", `/api/apps/launch?app_id=${encodeURIComponent(facts.id)}`, null);
      const running = launched?.status === 200;
      return {
        ok: true,
        id: facts.id,
        name: facts.name,
        version: facts.version,
        running,
        message: running ? `${facts.name} ${facts.version} is installed and running on the emulated BUSY Bar.` : `${facts.name} ${facts.version} is installed on the emulated BUSY Bar, but it did not start: ${barSaid(launched)}.`,
      };
    } catch (e) {
      return refusal("install_failed", `The package could not be installed (${e?.code ?? e?.message ?? e}).`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * The new project's icons by the command line's icon: from letters, or from the PNGs the form drew, put for it in
   * a folder of the data folder's own and taken away after.
   */
  async function writeIcons(folder, icon, kind = "create") {
    if (icon.text) return job(kind, folder, ["icon", folder, "--text", icon.text, ...(icon.color ? ["--color", icon.color] : []), "--force"]);
    const scratch = path.join(dataDir, "tmp", `new-icons-${process.pid}-${nextIcons++}`);
    try {
      mkdirSync(scratch, { recursive: true, mode: 0o700 });
      // Without a front: the project's own, which create made (the default icon), stays as it is.
      const front = icon.front ? path.join(scratch, "front.png") : path.join(folder, "src", "appmeta", "icon_front_8x8.png");
      if (icon.front) writeFileSync(front, icon.front);
      if (icon.back) writeFileSync(path.join(scratch, "back.png"), icon.back);
      return await job(kind, folder, ["icon", folder, "--from", front, ...(icon.back ? ["--back", path.join(scratch, "back.png")] : []), "--force"]);
    } catch (e) {
      return refusal("write_failed", `The icons could not be put down for the command line (${e?.code ?? e?.message ?? e}).`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /**
   * One job of a project: the command line, its lines as progress, its answer. `folder` must be free. `saysFailure`:
   * whether a line already told the failure the answer ends with (with the tool's output), so that the window's log
   * shows it once.
   */
  async function job(kind, folder, args, { lineOf = (line, stream) => (stream === "err" ? line : null), saysFailure = () => false, endsWell = (answer) => answer.ok } = {}) {
    const mine = { id: nextJob++, kind, folder, run: null };
    jobs.set(folder, mine);
    emit(mine, "running");
    let answer;
    let told = false;
    try {
      mine.run = startCli([...args, "--json", "--progress"], (line, stream) => {
        const shown = lineOf(line, stream);
        if (!shown) return;
        if (stream === "out" && saysFailure(line)) told = true;
        emit(mine, "running", shown);
      });
      answer = answerOf(await mine.run.exited, logFile);
    } catch (e) {
      answer = refusal("no_answer", `The emulator's command line did not start (${e?.message ?? e}).`, `The log is at ${logFile}.`);
    } finally {
      jobs.delete(folder);
    }
    // A job that ended well though its answer is a failure (create without its dependencies) still says why.
    emit(mine, endsWell(answer) ? "done" : "failed", answer.ok || told ? null : answer.message);
    return answer;
  }

  /** A job on a project of the list: refused when the project may not be worked on or is busy. */
  async function projectJob(kind, folder, args, options) {
    const { refused } = await projectFor(folder);
    if (refused) return { refused };
    if (jobs.has(folder)) return { refused: busy(folder) };
    return { answer: await job(kind, folder, args(folder), options) };
  }

  const named = (answer) => answer.id ?? "The app";

  /** Stage 2's flow, or why there is none. */
  async function gh() {
    if (!github) throw new ActionFailure("unavailable", "Publishing to GitHub is not available here.");
    return github;
  }

  /** A call of stage 2's flow: its failure (a PublishError) as the page's refusal, with what to do. */
  const isPublishError = (e) => typeof e?.code === "string" && typeof e?.message === "string" && "hint" in e;
  async function said(call) {
    await gh();
    try {
      return await call();
    } catch (e) {
      if (isPublishError(e)) return refusal(e.code, e.message, e.hint);
      throw e;
    }
  }

  /** What of an upload's progress (github-api.mjs pushFiles onProgress) goes to the window. */
  const uploadFact = (fact) => {
    const count = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
    return { phase: ["compare", "upload", "commit", "check", "download"].includes(fact?.phase) ? fact.phase : "upload", done: count(fact?.done), total: count(fact?.total), bytes: count(fact?.bytes), totalBytes: count(fact?.totalBytes), known: count(fact?.known), file: typeof fact?.file === "string" ? fact.file.slice(0, 300) : null };
  };
  /** github.checklist's answers, kept a little: the step asks each time it is drawn anew. */
  const checklists = new Map();
  /**
   * github.entry's and github.lookup's answers (catalog-update), read anew each time and kept half a minute; at most LOOKS_A_MINUTE new ones a
   * minute: they need no click, and a page that asks in a loop must not spend the person's GitHub quota.
   */
  const looks = { kept: new Map(), times: [] };
  async function looked(key, call, keepMs = 30_000) {
    const kept = looks.kept.get(key);
    if (kept && now() - kept.at < keepMs) return kept.answer;
    looks.times = looks.times.filter((at) => at > now() - 60_000);
    if (looks.times.length >= LOOKS_A_MINUTE) return refusal("too_often", "GitHub was asked too often in the last minute.", "Wait a moment, then try again.");
    looks.times.push(now());
    const answer = await said(call);
    if (answer?.ok !== false) looks.kept.set(key, { at: now(), answer });
    if (looks.kept.size > 32) looks.kept.delete(looks.kept.keys().next().value);
    return answer;
  }

  /** A stage 2 step on a project of the list, as a job: its progress lines go to the window; failures in its words. */
  async function githubJob(folder, work) {
    const { refused } = await projectFor(folder);
    if (refused) return refused;
    if (jobs.has(folder)) return busy(folder);
    const mine = { id: nextJob++, kind: "publish", folder, run: null };
    jobs.set(folder, mine);
    emit(mine, "running");
    try {
      // Lines of text, and the upload's progress: numbers and the path of the file going up, nothing else.
      const upload = (fact) => emit(mine, "running", null, uploadFact(fact));
      const answer = await work((line) => emit(mine, "running", line), upload);
      emit(mine, answer.ok ? "done" : "failed", answer.ok ? null : answer.message);
      return answer;
    } catch (e) {
      if (isPublishError(e)) {
        emit(mine, "failed", e.message);
        return refusal(e.code, e.message, e.hint);
      }
      throw e;
    } finally {
      jobs.delete(folder);
    }
  }

  /**
   * A folder the person chose themselves (Open App Folder, Open existing), opened: the trust dialog when the emulator
   * does not trust it yet (their click is the answer), then the list. The project, or null after Don't Trust.
   */
  async function openChosen(folder) {
    if (jobs.has(folder)) throw new ActionFailure("busy", "This project is busy.");
    const mine = { id: nextJob++, kind: "open", folder };
    jobs.set(folder, mine);
    opening.add(folder);
    emit(mine, "running");
    try {
      // Asks the person only when the folder is not trusted yet; their click is the answer.
      const trust = await ask(["trust", folder, "--wait", "600"]);
      if (!trust.ok && trust.code === "trust_refused") {
        emit(mine, "done", "The folder was not trusted, so it was not opened.");
        return null;
      }
      // The emulator does not ask about a folder again for a while after a no (so that no program can nag).
      if (!trust.ok && trust.code === "trust_refused_recently") throw new ActionFailure(trust.code, "You chose Don't Trust for this folder a moment ago.", "Open it again in half a minute to be asked once more.");
      const added = trust.ok ? await ask(["projects", "--add", folder]) : trust;
      if (!added.ok) throw failure(added, "The folder was not opened.");
      jobs.delete(folder);
      emit(mine, "done");
      return withJobs(await sweep({ fresh: true })).find((project) => project.folder === added.added) ?? null;
    } catch (e) {
      emit(mine, "failed", e?.message ?? String(e));
      throw e;
    } finally {
      jobs.delete(folder);
      opening.delete(folder);
    }
  }

  const methods = {
    "projects.list": async () => withJobs(await sweep({ fresh: true })),

    async "projects.examples"() {
      const answer = await ask(["create", "--examples", "--pictures"]);
      if (!answer.ok || !Array.isArray(answer.examples)) throw failure(answer, "The example apps could not be read.");
      const picture = (value) => (typeof value === "string" && value.startsWith("data:image/png;base64,") ? value : null);
      return answer.examples.map((example) => ({ name: example.name, summary: example.description || example.title || "", title: example.title ?? example.name, icon: picture(example.icon), front: picture(example.front) }));
    },

    /**
     * Where Create app would put a new project now: { parent, shown, folder, path, namespace }. `parent` is the default
     * place or one the person chose in Location, never another; `folder` the name asked for, or the next free one.
     * Reads only: a look at the place's folders.
     */
    async "projects.place"(arg) {
      const parent = arg?.parent ?? newProjects;
      if (typeof parent !== "string" || !places.has(parent)) throw new ActionFailure("usage", "Choose the location with Change.");
      const asked = arg?.folder ?? "my-app";
      if (typeof asked !== "string" || !FOLDER_NAME.test(asked)) throw new ActionFailure("usage", "A folder name is Latin letters, digits, spaces, dots, _ and -.");
      const folder = freeName(parent, asked);
      if (!folder) throw new ActionFailure("folder_taken", `${asked} and the next 98 names are taken in ${parent}.`, "Choose another location, or another name.");
      // The author: null when none is known but a name many computers share; the form then asks for it.
      const known = authorOf();
      return { parent, shown: shownPath(parent), folder, path: path.join(parent, folder), shownPath: shownPath(path.join(parent, folder)), namespace: namespaceOf(known?.name), author: known };
    },

    /** Location's Change: the folder the new project's folder goes in, chosen or made in the system's dialog. */
    async "projects.place.choose"(arg) {
      // It opens at the form's place, or at the folder that place goes in when it is not made yet (the default one
      // before the first app: the home folder); never at a folder the page names that is no place.
      const known = typeof arg?.from === "string" && places.has(arg.from) ? arg.from : null;
      const from = known && folderThere(known) ? known : known && folderThere(path.dirname(known)) ? path.dirname(known) : null;
      const parent = realOf(await dialogs.chooseParent(from));
      if (!parent) return null;
      places.add(parent);
      return { parent, shown: shownPath(parent) };
    },

    /**
     * A new project. Without `place`: in a folder the person chooses or makes in the system's dialog; null when they
     * chose none. With `place` ({ parent, folder }, Create app's form): in `folder` of a place `projects.place` takes,
     * with the form's `name`, `id`, catalog `texts` and `icon` (letters, or the PNGs it drew), written by the command
     * line's create, catalog-texts and icon. A step after create that fails leaves the project as it is and is said
     * in `unfinished`. The form's project is then refreshed once (built, installed, started): `refreshed` is that
     * Refresh's answer ({ ok, message, … }). The folder dialog's project is only made, as the command line's create.
     */
    async "projects.create"(options) {
      const example = options?.example ?? null;
      if (example !== null && (typeof example !== "string" || !EXAMPLE_NAME.test(example))) throw new ActionFailure("usage", "There is no such example app.");
      const request = createRequest(options);
      if (request.problem) throw new ActionFailure("usage", request.problem);
      let folder;
      if (options?.place !== undefined && options?.place !== null) {
        const { parent, folder: asked } = options.place;
        if (typeof parent !== "string" || !places.has(parent)) throw new ActionFailure("usage", "Choose the location with Change.");
        if (typeof asked !== "string" || !FOLDER_NAME.test(asked)) throw new ActionFailure("usage", "A folder name is Latin letters, digits, spaces, dots, _ and -.");
        try {
          if (parent === newProjects) mkdirSync(parent, { recursive: true });
        } catch (e) {
          throw new ActionFailure("write_failed", `${parent} could not be made (${e?.code ?? e?.message ?? e}).`, "Choose another location with Change.");
        }
        if (!folderThere(parent)) throw new ActionFailure("folder_missing", `${parent} is not there any more.`, "Choose another location with Change.");
        const name = freeName(parent, asked);
        if (!name) throw new ActionFailure("folder_taken", `${asked} and the next 98 names are taken in ${parent}.`, "Choose another location, or another name.");
        folder = path.join(realOf(parent), name);
      } else {
        folder = realOf(await dialogs.chooseNew());
        if (!folder) return null;
      }
      if (jobs.has(folder)) throw new ActionFailure("busy", "A project is being created in this folder already.");
      // Each value as --flag=<value>: a name that starts with "-" stays a name, not an option (audit, 11.11).
      // The author the form shows, or the one it asked for: the command line's own choice when neither (it may refuse).
      const by = request.author ?? authorOf()?.name ?? null;
      const named = [...(by ? [`--author=${by}`] : []), ...(request.name ? [`--name=${request.name}`] : []), ...(request.id ? [`--id=${request.id}`] : []), ...(request.description ? [`--description=${request.description}`] : [])];
      // Without the network the project is created all the same, without its dependencies (create-offline): it is
      // listed, its row says why and offers Retry; the rest of the form's steps are done as always.
      const createdAnyway = (answer) => !answer.ok && answer.created === true && typeof answer.folder === "string";
      const answer = await job("create", folder, ["create", folder, ...(example ? [`--example=${example}`] : []), ...named], { endsWell: (one) => one.ok || createdAnyway(one) });
      if (!answer.ok && !createdAnyway(answer)) throw failure(answer, "The project was not created.");
      if (!answer.ok) log(`[shell] actions: ${folder} was created without its dependencies (${answer.code}): ${answer.message}`);
      const made = answer.folder ?? folder;
      // Create app's pop-up makes an app to run: the Retry that brings its dependencies goes on to put it on the bar
      // (afterDependencies). The command line's create, and the folder dialog's, make a project only.
      if (!answer.ok && options?.place) meantToRun.add(made);
      const unfinished = [];
      if (request.texts) {
        const texts = await job("create", made, ["catalog-texts", "set", made, ...Object.entries(request.texts).map(([option, value]) => `${option}=${value}`)]);
        if (!texts.ok) unfinished.push(`The catalog texts were not written: ${words(texts.message ?? "it failed")}`);
      }
      if (request.icon) {
        const icons = await writeIcons(made, request.icon);
        if (!icons.ok) unfinished.push(`The icons were not made: ${words(icons.message ?? "it failed")}`);
      }
      // Create app's pop-up ends with the app running on the bar, as a newcomer expects: one Refresh (build, install,
      // start) once the project has its dependencies. Without them, the Retry above takes over.
      let refreshed = null;
      if (answer.ok && options?.place && !jobs.has(made)) {
        const round = await job("refresh", made, ["dev", made, "--once"], REFRESH_JOB);
        refreshed = refreshAnswer(round);
      }
      const project = withJobs(await sweep({ fresh: true })).find((one) => one.folder === made) ?? null;
      return project ? { ...project, ...(unfinished.length ? { unfinished } : {}), ...(refreshed ? { refreshed } : {}) } : project;
    },

    /** A project the person chooses in the system's dialog; one the emulator does not know goes through the trust dialog. */
    async "projects.open"() {
      const folder = realOf(await dialogs.chooseExisting());
      if (!folder) return null;
      return openChosen(folder);
    },

    /**
     * Create app's Open existing: the system's dialog for the app's folder or any file in it (`pick`: "any", "folder"
     * or "file", see folder-dialogs.mjs), then the project around it (project-root.mjs). Opens nothing: says what it
     * found, { found: true, folder, shownFolder, id, name, listed, trusted, chosen, shownChosen }, or why there is
     * none, { found: false, message, chosen, shownChosen }; null when the person chose nothing. A folder found here is
     * one `projects.import` may open.
     */
    async "projects.find"(arg) {
      const pick = ["any", "folder", "file"].includes(arg?.pick) ? arg.pick : "any";
      const chosen = await (dialogs.chooseAny ?? (() => null))(pick);
      if (typeof chosen !== "string" || !path.isAbsolute(chosen)) return null;
      const answer = findProjectRoot(chosen, { home, platform });
      const said = { chosen, shownChosen: shownPath(chosen) };
      if (!answer.found) return { found: false, message: answer.message, ...said };
      found.add(answer.folder);
      const listed = (await sweep({ fresh: true })).find((one) => one.folder === answer.folder) ?? null;
      return { found: true, folder: answer.folder, shownFolder: shownPath(answer.folder), id: answer.id ?? listed?.id ?? null, name: answer.name ?? listed?.name ?? null, listed: Boolean(listed), trusted: listed?.trusted === true, ...said };
    },

    /**
     * Open existing's Open: the project `projects.find` found, never another folder the page names. One the emulator
     * does not trust yet goes through the trust dialog, as Open App Folder; then it is built, installed and started
     * once, as Refresh does (`refreshed`). Null when the person chose Don't Trust.
     */
    async "projects.import"(folder) {
      if (typeof folder !== "string" || !found.has(folder)) throw new ActionFailure("usage", "Choose the app's folder with Choose first.");
      const project = await openChosen(folder);
      if (!project) return null;
      let refreshed = null;
      if (project.trusted && project.exists && !jobs.has(project.folder)) {
        const round = await job("refresh", project.folder, ["dev", project.folder, "--once"], REFRESH_JOB);
        if (!round.ok && DEPENDENCY_FAILURES.has(round.code)) meantToRun.add(project.folder);
        refreshed = refreshAnswer(round);
      }
      const now = withJobs(await sweep({ fresh: true })).find((one) => one.folder === project.folder) ?? project;
      return { ...now, ...(refreshed ? { refreshed } : {}) };
    },

    /** Build, install and start again: what the person presses after they changed the project's files. */
    async "projects.refresh"(folder) {
      const { refused, answer } = await projectJob("refresh", folder, (dir) => ["dev", dir, "--once"], REFRESH_JOB);
      if (refused) return refused;
      // A Refresh whose dependencies did not come was meant to put the app on the bar: a Retry that brings them goes
      // on to do it (afterDependencies). One that got past them is no longer owed.
      if (!answer.ok && DEPENDENCY_FAILURES.has(answer.code)) meantToRun.add(folder);
      else meantToRun.delete(folder);
      return refreshAnswer(answer);
    },

    /**
     * Retry: the project's dependencies, installed when they are needed (`build --dependencies-only`). When they came
     * for a project whose app was meant to run (a Refresh had stopped at them, or Create app's pop-up made it), it is
     * built, installed and started once, as Refresh does.
     */
    async "projects.dependencies"(folder) {
      const { refused, answer } = await projectJob("dependencies", folder, (dir) => ["build", dir, "--dependencies-only"]);
      if (refused) return refused;
      if (!answer.ok) return failed(answer);
      const installed = answer.dependencies === "cache" ? "Dependencies installed from npm's cache" : "Dependencies installed";
      const then = await afterDependencies(folder);
      // followed: the page says what came of it as a Refresh's (a build's error is not the dependencies').
      return then ? { ...(then.ok ? { ...then, message: `${installed}. ${then.message}` } : then), followed: "refresh" } : { ok: true, message: installed };
    },

    /**
     * The window's own Retry when the network may be back (it came online, the window got the focus, a while passed):
     * the projects whose dependencies failed for the network, or whose install was cut off, are installed again, one
     * at a time and each no more often than AUTO_RETRY_MS. Without a click: the page names no folder, and nothing else
     * is done. → { started: the folders tried }
     */
    async "projects.dependencies.auto"() {
      const now = Date.now();
      const due = (await sweep()).filter((one) => one.exists && one.trusted && !one.unavailable && one.dependencies.retry && !jobs.has(one.folder) && now - (autoTried.get(one.folder) ?? 0) >= AUTO_RETRY_MS);
      if (!due.length || autoRunning) return { started: [] };
      for (const one of due) autoTried.set(one.folder, now);
      autoRunning = (async () => {
        try {
          for (const one of due) {
            if (jobs.has(one.folder)) continue;
            log(`[shell] actions: trying the dependencies of ${one.folder} again`);
            const answer = await job("dependencies", one.folder, ["build", one.folder, "--dependencies-only"]);
            if (answer.ok) await afterDependencies(one.folder);
          }
        } finally {
          autoRunning = null;
        }
      })();
      return { started: due.map((one) => one.folder) };
    },

    async "projects.build"(folder) {
      const { refused, answer } = await projectJob("build", folder, (dir) => ["build", dir]);
      if (refused) return refused;
      return answer.ok ? { ok: true, message: `Built ${answer.id ?? "the app"}.` } : failed(answer);
    },

    async "projects.run"(folder) {
      const { refused, answer } = await projectJob("run", folder, (dir) => ["run", dir]);
      if (refused) return refused;
      if (!answer.ok) return failed(answer);
      return { ok: true, message: answer.running === false ? `${named(answer)} was started and ran to its end.` : `${named(answer)} is running.` };
    },

    async "projects.stop"(folder) {
      const { refused, answer } = await projectJob("stop", folder, (dir) => ["stop", dir]);
      if (refused) return refused;
      return answer.ok ? { ok: true, message: "Stopped." } : failed(answer);
    },

    /** The development loop: it goes on until it is stopped, the window closes or the app quits. */
    async "projects.dev.start"(folder) {
      const { refused } = await projectFor(folder);
      if (refused) return refused;
      if (jobs.has(folder)) return busy(folder);
      const mine = { id: nextJob++, kind: "dev", folder, run: null };
      jobs.set(folder, mine);
      emit(mine, "running");
      try {
        // Without --json: its lines are written for a person, and the window shows them as they are.
        mine.run = startCli(["dev", folder], (line) => line && emit(mine, "running", line));
      } catch (e) {
        jobs.delete(folder);
        emit(mine, "failed", `The development loop did not start (${e?.message ?? e}).`);
        return refusal("no_answer", `The development loop did not start (${e?.message ?? e}).`, `The log is at ${logFile}.`);
      }
      mine.run.exited.then((ended) => {
        jobs.delete(folder);
        emit(mine, ended.code === 0 || mine.stopped ? "done" : "failed");
      });
      return { ok: true };
    },

    async "projects.dev.stop"(folder) {
      const mine = typeof folder === "string" ? jobs.get(folder) : null;
      if (!mine || mine.kind !== "dev") return refusal("not_running", "The development loop is not running for this project.");
      await stopLoop(mine);
      return { ok: true };
    },

    async "projects.check"(folder) {
      const { refused, answer } = await projectJob("check", folder, (dir) => ["check", dir, "--full"]);  // every check: the window lists them all
      if (refused) return { ...refused, checks: [] };
      const checks = checksOf(answer, words);
      if (!checks) return { ...failed(answer), checks: [] };
      return { ok: answer.ok, checks, built: answer.built === true, ...(answer.ok ? {} : { code: answer.code, message: words(answer.message), ...(answer.hint ? { hint: words(answer.hint) } : {}) }) };
    },

    /** Writes submission/ into the project; nothing is sent anywhere. */
    async "projects.submit"(folder) {
      const { refused, answer } = await projectJob("submit", folder, (dir) => ["submit", dir]);
      if (refused) return refused;
      if (!answer.ok || typeof answer.submission?.folder !== "string") return failed(answer);
      return { ok: true, folder: answer.submission.folder, message: `Wrote ${answer.submission.folder}. Nothing was sent. The steps are in SUBMIT.md there.` };
    },

    /**
     * Create app's Install a package: an app package (.tgz) the person chooses in the system's dialog, looked at,
     * asked about and installed (installPackageBytes). Null when they chose no file.
     */
    async "projects.package.install"() {
      const chosen = await (dialogs.choosePackage ?? (() => null))();
      if (typeof chosen !== "string" || !path.isAbsolute(chosen)) return null;
      const file = realOf(chosen) ?? chosen;
      let bytes;
      try {
        const stat = statSync(file);
        if (!stat.isFile()) return refusal("not_found", `${path.basename(file)} is not a file.`, "Choose an app package (.tgz), as busy-cli build makes it.");
        if (stat.size > PACKAGE_MAX) return refusal("package_too_large", `${path.basename(file)} is larger than the BUSY Bar takes (100 MiB).`, "Build a smaller package.");
        bytes = readFileSync(file);
      } catch (e) {
        return refusal("not_found", `${path.basename(file)} could not be read (${e?.code ?? e?.message ?? e}).`, "Choose an app package (.tgz), as busy-cli build makes it.");
      }
      const answer = await installPackageBytes(bytes, { shown: shownPath(file), source: "a file on this computer" });
      return { ...answer, file: shownPath(file) };
    },

    /**
     * Delete in the Apps list: { id, withFiles }. The app is stopped, taken off the emulated bar, and its projects
     * leave the list (`busy-emulator uninstall <id>`); its folder stays where it is. With withFiles the project's
     * folder goes to the Trash (the Recycle Bin) as well, by the system's own call, never deleted for good: only when
     * the app has one project folder in the list and it passes trashableFolder, checked before anything changes and
     * once more just before the move.
     */
    async "apps.delete"(arg) {
      const id = arg?.id;
      if (typeof id !== "string" || !APP_ID.test(id)) return refusal("usage", "There is no such app.");
      if (arg.withFiles !== undefined && typeof arg.withFiles !== "boolean") return refusal("usage", "Say whether its files go too.");
      const bin = platform === "win32" ? "Recycle Bin" : "Trash";
      const all = await sweep();
      const mine = all.filter((project) => project.id === id);
      let folder = null;
      if (arg.withFiles === true) {
        if (!trash) return refusal("unavailable", `Moving files to the ${bin} is not available here.`);
        const there = mine.filter((project) => project.exists);
        if (!there.length) return refusal("no_project_folder", `${id} has no project folder: it was installed from a package, so there are no files to delete.`);
        if (there.length > 1) return refusal("several_folders", `${id} has ${there.length} project folders, so none of them is deleted.`, `Delete the one you mean in ${platform === "win32" ? "Explorer" : "Finder"}.`);
        const verdict = trashableFolder(there[0].folder, { registered: all.map((project) => project.folder), dataDir, home, platform });
        if (verdict.refused) {
          log(`[shell] actions: refused to delete ${JSON.stringify(there[0].folder.slice(0, 200))}: ${verdict.refused.message}`);
          return refusal(verdict.refused.code, verdict.refused.message);
        }
        const why = trashRefusal(verdict.folder);
        if (why) return refusal("no_recycle_bin", why);
        folder = verdict.folder;
      }
      // Work under way on its projects: the development loop is stopped; anything else is waited for.
      for (const project of mine) {
        const job = jobs.get(project.folder);
        if (job?.kind === "dev" && job.run) await stopLoop(job);
        else if (job) return busy(project.folder);
      }
      const answer = await ask(["uninstall", id]);
      if (!answer.ok) {
        await sweep().catch(() => {});
        return failed(answer);
      }
      let trashed = null;
      if (folder) {
        const again = trashableFolder(folder, { registered: [folder], dataDir, home, platform });
        try {
          if (again.refused) throw new Error(again.refused.message);
          await trash(again.folder);
          trashed = again.folder;
        } catch (e) {
          await sweep().catch(() => {});
          log(`[shell] actions: ${id} was removed, its folder ${folder} not moved to the ${bin}: ${e?.message ?? e}`);
          return refusal("trash_failed", `${id} was removed from the emulator, but its folder could not be moved to the ${bin}: ${String(e?.message ?? e).slice(0, 300)}`, `The folder is as it was, in ${folder}.`);
        }
      }
      await sweep().catch(() => {});
      const kept = mine.filter((project) => project.exists && project.folder !== trashed).map((project) => project.folder);
      const what = answer.removed_from_bar ? `Removed ${id} from the emulator.` : `The emulator forgot ${id}.`;
      return { ok: true, id, trashed, kept, message: [what, trashed ? `Its folder is in the ${bin}.` : kept.length ? `Its files stay in ${kept.join(", ")}.` : null].filter(Boolean).join(" ") };
    },

    // ---- publishing, stage 1 (busy-emulator publish): everything in the project, nothing sent

    /** Where each step of publishing stands for the project. Reads only, so it needs no click. */
    async "publish.status"(folder) {
      const { refused } = await projectFor(folder);
      if (refused) return refused;
      return answered(await ask(["publish", "status", folder]));
    },

    async "publish.check"(folder) {
      const { refused, answer } = await projectJob("publish", folder, (dir) => ["publish", "check", dir]);
      return refused ?? answered(answer);
    },

    /**
     * The app's name (into its manifest) and the catalog's four texts (into catalog.json): { folder, name?, texts:
     * { category, short_description, … } }.
     */
    async "publish.texts"(arg) {
      const texts = arg?.texts;
      if (!texts || typeof texts !== "object") return refusal("usage", "The texts are missing.");
      const options = [];
      if (arg.name !== undefined && arg.name !== null) {
        if (typeof arg.name !== "string" || arg.name.length > MAX_NAME) return refusal("usage", `The name is a text of up to ${MAX_NAME} characters.`);
        options.push(`--name=${arg.name}`);
      }
      for (const [field, option] of TEXT_OPTIONS) {
        if (texts[field] === undefined) continue;
        if (typeof texts[field] !== "string" || texts[field].length > MAX_TEXT) return refusal("usage", `${field} is a text of up to ${MAX_TEXT} characters.`);
        options.push(`${option}=${texts[field]}`);
      }
      if (!options.length) return refusal("usage", "The texts are missing.");
      const { refused, answer } = await projectJob("publish", arg.folder, (dir) => ["catalog-texts", "set", dir, ...options]);
      return refused ?? answered(answer);
    },

    /**
     * Application Info's Upload icon: { folder, front, back? }, PNGs of 8×8 and 11×11 the page checked (Create app's
     * checks), checked again here, written by the command line's icon --from as Create app's are.
     */
    async "publish.icon"(arg) {
      const front = iconPicture(arg?.front, 8);
      if (!front) return refusal("usage", "The front icon is a PNG of 8×8 pixels.");
      const back = arg?.back === undefined || arg?.back === null ? null : iconPicture(arg.back, 11);
      if (arg?.back !== undefined && arg?.back !== null && !back) return refusal("usage", "The back icon is a PNG of 11×11 pixels.");
      const { refused } = await projectFor(arg.folder);
      if (refused) return refused;
      if (jobs.has(arg.folder)) return busy(arg.folder);
      return answered(await writeIcons(arg.folder, { front, back }, "publish"));
    },

    /**
     * { folder, take: "front"|"back" } or { folder, upload: true } or { folder, order: { front, back } } or { folder,
     * remove: path }. Upload: the PNGs the person chooses in the system's dialog, shown from here; the page names no
     * file. Null when they chose none.
     */
    async "publish.screenshots"(arg) {
      const options = [];
      if (arg?.upload === true || arg?.upload === "front" || arg?.upload === "back") {
        const { refused } = await projectFor(arg.folder);
        if (refused) return refused;
        const display = arg.upload === true ? null : arg.upload;
        const files = dialogs.chooseScreenshots ? await dialogs.chooseScreenshots(display) : null;
        if (!Array.isArray(files) || !files.length) return null;
        if (files.length > 20 || !files.every((file) => typeof file === "string" && path.isAbsolute(file) && file.length <= MAX_PATH)) return refusal("usage", "Choose up to 20 PNG files.");
        options.push(`--upload=${JSON.stringify(files)}`, ...(display ? [`--display=${display}`] : []));
      } else if (arg?.take !== undefined) {
        if (arg.take !== "front" && arg.take !== "back") return refusal("usage", "A screenshot is of the front or the back display.");
        options.push(`--take=${arg.take}`);
      } else if (arg?.order !== undefined) {
        const lists = [arg.order?.front, arg.order?.back];
        if (!lists.every((list) => Array.isArray(list) && list.length <= 20 && list.every(insidePath))) return refusal("usage", "The order names the project's screenshots.");
        options.push(`--order=${JSON.stringify({ front: arg.order.front, back: arg.order.back })}`);
      } else if (arg?.remove !== undefined) {
        if (!insidePath(arg.remove)) return refusal("usage", "That is not a screenshot of the project.");
        options.push(`--remove=${arg.remove}`);
      }
      const { refused, answer } = await projectJob("publish", arg?.folder, (dir) => ["publish", "screenshots", dir, ...options]);
      return refused ?? answered(answer);
    },

    /**
     * The README of the public repository (busy-emulator publish readme set): { folder, readme: { mode, title, intro,
     * usage, markdown } } writes README.md from it.
     */
    async "publish.readme"(arg) {
      const r = arg?.readme;
      if (!r || typeof r !== "object") return refusal("usage", "The README is missing.");
      const options = [];
      if (r.mode !== undefined) {
        if (r.mode !== "fields" && r.mode !== "markdown") return refusal("usage", "The README is made from the fields or is Markdown.");
        options.push(`--mode=${r.mode}`);
      }
      for (const [key, option, most] of [["title", "--title", 200], ["intro", "--intro", MAX_TEXT], ["usage", "--usage", MAX_TEXT], ["markdown", "--markdown", 4 * MAX_TEXT]]) {
        if (r[key] === undefined) continue;
        if (typeof r[key] !== "string" || r[key].length > most) return refusal("usage", `${key} is a text of up to ${most} characters.`);
        options.push(`${option}=${r[key]}`);
      }
      const { refused, answer } = await projectJob("publish", arg.folder, (dir) => ["publish", "readme", "set", dir, ...options]);
      return refused ?? answered(answer);
    },

    /**
     * { folder, license: "MIT"|"Apache-2.0"|"GPL-3.0"|"other", author }: never chosen for the person. { folder,
     * license: "other", upload: true }: the license file the person chooses in the system's dialog, copied in as
     * LICENSE; when the project has one, the answer is { ok: false, code: "license_exists", file } and the choice is
     * kept for { folder, license: "other", replace: true }, the person's yes.
     */
    async "publish.license"(arg) {
      if (!LICENSE_CHOICES.includes(arg?.license)) return refusal("usage", "Choose a license.");
      if (arg.upload === true || arg.replace === true) {
        if (arg.license !== "other") return refusal("usage", "Your own license's file goes with Another license.");
        const { refused } = await projectFor(arg.folder);
        if (refused) return refused;
        let file;
        if (arg.replace === true) {
          file = licenseChosen.get(arg.folder);
          if (!file) return refusal("usage", "Choose the license file again.");
        } else {
          file = dialogs.chooseLicense ? await dialogs.chooseLicense() : null;
          if (typeof file !== "string" || !path.isAbsolute(file) || file.length > MAX_PATH) return null;
        }
        // The command line takes a license file only from the project or from the data folder's tmp/ (publish.mjs
        // licenseSource): the file the person chose here is copied there for it, under its own name, and taken away after.
        const staged = stageLicense(file);
        if (staged.refused) return staged.refused;
        let busyNow;
        let answer;
        try {
          ({ refused: busyNow, answer } = await projectJob("publish", arg.folder, (dir) => ["publish", "license", dir, "--license=other", `--from=${staged.file}`, ...(arg.replace === true ? ["--replace"] : [])]));
        } finally {
          rmSync(staged.folder, { recursive: true, force: true });
        }
        if (busyNow) return busyNow;
        if (!answer.ok && answer.code === "license_exists") licenseChosen.set(arg.folder, file);
        else licenseChosen.delete(arg.folder);
        return { ...answered(answer), ...(answer.ok ? {} : { file: answer.file ?? null, chosen: path.basename(file) }) };
      }
      if (arg.author !== undefined && (typeof arg.author !== "string" || arg.author.length > 200)) return refusal("usage", "The name is too long.");
      const options = [`--license=${arg.license}`, ...(arg.author !== undefined ? [`--author=${arg.author}`] : [])];
      const { refused, answer } = await projectJob("publish", arg.folder, (dir) => ["publish", "license", dir, ...options]);
      return refused ?? answered(answer);
    },

    /** { folder, write?, keepOut?, keepIn?, readme?: "replace" }: the plan of the repository's files, or written. */
    async "publish.files"(arg) {
      const options = [];
      if (arg?.write === true) options.push("--write");
      for (const [key, option] of [["keepOut", "--keep-out"], ["keepIn", "--keep-in"]]) {
        if (arg?.[key] === undefined) continue;
        if (!insidePath(arg[key])) return refusal("usage", "That is not a file of the project.");
        options.push(`${option}=${arg[key]}`);
      }
      if (arg?.readme !== undefined) {
        if (arg.readme !== "replace") return refusal("usage", "The README is replaced or kept.");
        options.push("--readme=replace");
      }
      const { refused, answer } = await projectJob("publish", arg?.folder, (dir) => ["publish", "files", dir, ...options]);
      // A flagged file published on purpose is the person's click here, noted in the app's own record: only that lets
      // Publish to GitHub take it (a project's own .busy/publish.json may have come with it).
      if (!refused && answer.ok && github?.record) {
        if (arg.keepIn !== undefined) github.record.keepIn(arg.folder, arg.keepIn, true);
        if (arg.keepOut !== undefined) github.record.keepIn(arg.folder, arg.keepOut, false);
      }
      return refused ?? answered(answer);
    },

    /**
     * The checks, then submission/ (the project must be built): nothing is sent. `folder`, or { folder, build: true }:
     * Build and package, the build first and then the package, in this one action of the person's click (a build
     * takes longer than the click's two seconds, gestures.mjs). A failed build is answered with `step: "build"`.
     */
    async "publish.package"(arg) {
      const folder = typeof arg === "string" ? arg : arg?.folder;
      if (arg !== null && typeof arg === "object" && arg.build !== undefined && typeof arg.build !== "boolean") return refusal("usage", "Say whether it builds first.");
      if (arg?.build === true) {
        const built = await methods["projects.build"](folder);
        if (!built?.ok) return { ...built, step: "build" };
      }
      const { refused, answer } = await projectJob("publish", folder, (dir) => ["publish", "package", dir]);
      return refused ?? answered(answer);
    },

    // ---- publishing, stage 2 (github/publish-flow.mjs): the shell talks to GitHub through GitHub CLI, which holds the
    // token; the page gets the login and the results, never a token. What is in the project is read and noted by the command line.

    async "github.status"() {
      return said(() => github.status());
    },
    /** Sign in with another account (or the first): gh auth login, which adds the account to GitHub CLI. */
    async "github.signin"() {
      return said(() => github.signIn());
    },
    /** Use <login>: one of GitHub CLI's accounts on this computer ({ login }; its active one without), as it is. */
    async "github.use"(arg) {
      if (arg?.login !== undefined && arg.login !== null && (typeof arg.login !== "string" || arg.login.length > 39)) return refusal("usage", "Name one of GitHub CLI's accounts.");
      return said(() => github.useExisting({ login: arg?.login ?? null }));
    },
    async "github.signin.wait"() {
      return said(() => github.waitSignIn());
    },
    async "github.signin.cancel"() {
      return said(() => github.cancelSignIn());
    },
    async "github.code.open"() {
      return said(() => github.openCodePage());
    },
    /** { signOutCli, switchBack }: the person's ticks; signOutCli only for an account the app signed in to GitHub CLI. */
    async "github.signout"(arg) {
      return said(() => github.signOut({ signOutCli: arg?.signOutCli === true, switchBack: arg?.switchBack === true }));
    },

    /**
     * { folder, name? }: where Publish to GitHub would go and what it would do there (publish-flow.mjs plan(): a new
     * repository, the files of the one this app published the project to, or a name that is taken).
     */
    async "github.name"(arg) {
      if (arg?.name !== undefined && arg.name !== null && (typeof arg.name !== "string" || arg.name.length > 100)) return refusal("usage", "Name the repository.");
      const key = `${arg?.folder}\n${arg?.name || ""}`;
      const kept = nameChecks.kept.get(key);
      if (kept && now() - kept.at < NAME_CHECK_KEEP_MS) return kept.answer;
      if (nameChecks.running.has(key)) return nameChecks.running.get(key);
      while (nameChecks.times.length && nameChecks.times[0] <= now() - 3_600_000) nameChecks.times.shift();
      if (nameChecks.times.length >= NAME_CHECKS_AN_HOUR) return refusal("too_often", "The repository's name was checked too often in the last hour.", "Publish to GitHub checks it again when you publish.");
      if (nameChecks.times.filter((at) => at > now() - 60_000).length >= NAME_CHECKS_A_MINUTE) return refusal("too_often", "The repository's name was checked too often in the last minute.", "Wait a moment, then try again.");
      nameChecks.times.push(now());
      const check = (async () => {
        const { refused } = await projectFor(arg.folder);
        if (refused) return refused;
        const facts = await ask(["publish", "status", arg.folder]);
        if (!facts.ok) return failed(facts);
        return said(() => github.plan({ folder: arg.folder, status: facts, name: arg.name || null }));
      })();
      nameChecks.running.set(key, check);
      try {
        const answer = await check;
        nameChecks.kept.set(key, { at: now(), answer });
        if (nameChecks.kept.size > 64) nameChecks.kept.delete(nameChecks.kept.keys().next().value);
        return answer;
      } finally {
        nameChecks.running.delete(key);
      }
    },

    /** { folder, name? }: the project's files in the person's public repository, one commit, read back. */
    async "github.push"(arg) {
      if (arg?.name !== undefined && arg.name !== null && (typeof arg.name !== "string" || arg.name.length > 100)) return refusal("usage", "Name the repository.");
      // Into the person's own repository (catalog-update): the head they were shown, and whether they agreed to delete
      // the files it has and the project has not.
      const into = arg?.into ?? null;
      if (into !== null && (typeof into !== "object" || !/^[0-9a-f]{40}$/.test(into.head ?? "") || (into.deleteOthers !== undefined && typeof into.deleteOthers !== "boolean"))) return refusal("usage", "Confirm the repository to publish into.");
      // What the name checks said is not true any more once the files are up (a new repository is the app's now).
      nameChecks.kept.clear();
      return githubJob(arg?.folder, async (progress, upload) => {
        // stale-check: only what Pre-flight check and Build and package saw goes up; nothing when a file changed since.
        const checked = await ask(["publish", "verify", arg.folder]);
        if (!checked.ok) return failed(checked);
        const facts = await ask(["publish", "status", arg.folder]);
        if (!facts.ok) return failed(facts);
        const plan = await ask(["publish", "files", arg.folder]);
        if (!plan.ok) return failed(plan);
        // Asked again once the files are read, and their bytes compared with the check's (publish-flow.mjs).
        const verify = async () => {
          const again = await ask(["publish", "verify", arg.folder]);
          if (!again.ok) throw new ActionFailure(again.code ?? "changed_since_check", words(again.message ?? "The project changed since Pre-flight check."), again.hint ? words(again.hint) : null);
          return again;
        };
        const pushed = await (await gh()).push({ folder: arg.folder, status: facts, files: plan, name: arg.name || null, into: into ? { head: into.head, deleteOthers: into.deleteOthers === true } : null, progress, upload, verify });
        nameChecks.kept.clear();
        const noted = await ask(["publish", "pushed", arg.folder, `--owner=${pushed.owner}`, `--repo=${pushed.name}`, `--commit=${pushed.commit}`]);
        if (!noted.ok) return failed(noted);
        return { ok: true, ...pushed };
      });
    },

    /** Cancel of Publish to GitHub: the upload under way stops before the branch is moved. */
    async "github.cancel"() {
      return said(() => ({ ok: true, stopped: github.cancel() }));
    },

    /**
     * { catalog }: the checklist the request needs ticked, the catalog's pull request template read now (or the copy
     * bundled with the app). Read only; answers kept half a minute.
     */
    async "github.checklist"(arg) {
      if (typeof arg?.catalog !== "string" || arg.catalog.length > 200) return refusal("usage", "Name the catalog's repository.");
      const key = arg.catalog.trim().toLowerCase();
      const kept = checklists.get(key);
      if (kept && now() - kept.at < 30_000) return kept.answer;
      const answer = await said(() => github.checklist({ catalog: arg.catalog }));
      if (answer?.ok !== false) checklists.set(key, { at: now(), answer });
      if (checklists.size > 16) checklists.delete(checklists.keys().next().value);
      return answer;
    },

    /**
     * { folder, catalog, ticked, ai, otherCatalog? }: the pull request to the catalog, from the person's fork or
     * branch. `otherCatalog`: the name of a catalog that is not BUSY's, as the person confirmed it (publish-flow.mjs).
     */
    async "github.request"(arg) {
      if (arg?.catalog !== undefined && (typeof arg.catalog !== "string" || arg.catalog.length > 200)) return refusal("usage", "Name the catalog's repository.");
      if (arg?.otherCatalog !== undefined && arg.otherCatalog !== null && (typeof arg.otherCatalog !== "string" || arg.otherCatalog.length > 200)) return refusal("usage", "Name the catalog's repository.");
      if (!Array.isArray(arg?.ticked) || arg.ticked.some((one) => typeof one !== "string")) return refusal("not_ticked", "Tick every item of the catalog's checklist first.");
      // A checklist past these is never shown (publish-flow.mjs checklistProblem): more is not a person's ticks.
      if (arg.ticked.length > MAX_BOXES || arg.ticked.some((one) => one.length > MAX_BOX_LENGTH)) return refusal("checklist_too_long", `The emulator sends a checklist of up to ${MAX_BOXES} items of up to ${MAX_BOX_LENGTH} characters each.`, "Send the app by hand (SUBMIT.md).");
      if (arg?.changelog !== undefined && arg.changelog !== null && (typeof arg.changelog !== "string" || arg.changelog.length > 4000)) return refusal("bad_changelog", "What's new takes at most 4000 characters.");
      return githubJob(arg?.folder, async (progress) => {
        // stale-check: the request names what was checked and packaged, or none is sent. Asked before What's new is
        // written, which changes catalog.json; the request compares the files with GitHub's after it.
        const checked = await ask(["publish", "verify", arg.folder]);
        if (!checked.ok) return failed(checked);
        // An update's What's new (catalog-update): written into catalog.json first, by the catalog's own rules, then
        // into the request's manifest.
        if (typeof arg.changelog === "string") {
          const texts = await ask(["catalog-texts", "set", arg.folder, `--changelog=${arg.changelog.trim()}`]);
          if (!texts.ok) return failed(texts);
          if (texts.problems?.changelog) return refusal("bad_changelog", `What's new: ${words(texts.problems.changelog)}`);
          // The flow's own write: the check and the package follow it, when nothing else changed (stale-check).
          const renewed = await ask(["publish", "verify", arg.folder, "--renew=catalog.json"]);
          if (!renewed.ok) return failed(renewed);
        }
        const facts = await ask(["publish", "status", arg.folder]);
        if (!facts.ok) return failed(facts);
        const plan = await ask(["publish", "files", arg.folder]);
        if (!plan.ok) return failed(plan);
        const submission = path.join(arg.folder, "submission");
        const read = (file) => {
          try {
            return readFileSync(file, "utf8");
          } catch {
            return null;
          }
        };
        const manifest = facts.id ? read(path.join(submission, "applications", facts.id, "manifest.yml")) : null;
        const testing = /^# Device testing\n([\s\S]*?)(?=^# |$(?![\s\S]))/m.exec(read(path.join(submission, "PR-DESCRIPTION.md")) ?? "")?.[1]?.trim() || null;
        const made = await (await gh()).request({ status: facts, files: plan, folder: arg.folder, catalog: arg.catalog, ticked: arg.ticked, ai: arg.ai, otherCatalog: arg.otherCatalog ?? null, manifest, changelog: typeof arg.changelog === "string" ? arg.changelog.trim() : null, testing, progress });
        looks.kept.clear();
        const noted = await ask(["publish", "requested", arg.folder, `--pr=${made.url}`, `--catalog=${made.catalog}`]);
        if (!noted.ok) return failed(noted);
        return { ok: true, ...made };
      });
    },

    /**
     * { folder, catalog? } (catalog-update): what the catalog has of the app now, for Send to catalog: whether it is
     * an update, the published version and What's new, whether this package's version is higher. Reads only.
     */
    async "github.entry"(arg) {
      if (arg?.catalog !== undefined && arg.catalog !== null && (typeof arg.catalog !== "string" || arg.catalog.length > 200)) return refusal("usage", "Name the catalog's repository.");
      const { refused } = await projectFor(arg?.folder);
      if (refused) return refused;
      const facts = await ask(["publish", "status", arg.folder]);
      if (!facts.ok) return failed(facts);
      return looked(`entry\n${arg.folder}\n${String(arg.catalog ?? facts.catalog).trim().toLowerCase()}\n${facts.version}`, () => github.entry({ status: facts, catalog: arg.catalog ?? null, folder: arg.folder }), 0);
    },

    /** { repo } (catalog-update): the repository Import from GitHub would get, and whether it is a BUSY Bar app. Reads only. */
    async "github.lookup"(arg) {
      if (typeof arg?.repo !== "string" || arg.repo.length > 300) return refusal("not_github", "Paste the repository's address, or write owner/name.");
      return looked(`lookup\n${arg.repo.trim().toLowerCase()}`, () => github.lookup({ repo: arg.repo }));
    },

    /**
     * { repo, place: { parent, folder } } (catalog-update): Create app's Import from GitHub. The repository's files are
     * downloaded through GitHub CLI into a new folder of a place `projects.place` takes (the next free name like
     * `folder`), then opened as Open existing opens a project: the trust dialog, the list, one Refresh. Answers as
     * `projects.import`, with `imported`: { owner, name, page, commit, folder, files, skipped }.
     */
    async "github.import"(arg) {
      if (typeof arg?.repo !== "string" || arg.repo.length > 300) return refusal("not_github", "Paste the repository's address, or write owner/name.");
      const { parent, folder: asked } = arg?.place ?? {};
      if (typeof parent !== "string" || !places.has(parent)) throw new ActionFailure("usage", "Choose the location with Change.");
      if (typeof asked !== "string" || !FOLDER_NAME.test(asked)) throw new ActionFailure("usage", "A folder name is Latin letters, digits, spaces, dots, _ and -.");
      try {
        if (parent === newProjects) mkdirSync(parent, { recursive: true });
      } catch (e) {
        throw new ActionFailure("write_failed", `${parent} could not be made (${e?.code ?? e?.message ?? e}).`, "Choose another location with Change.");
      }
      if (!folderThere(parent)) throw new ActionFailure("folder_missing", `${parent} is not there any more.`, "Choose another location with Change.");
      // A folder that is not there at all: the download makes it whole, or not at all.
      const name = [asked, ...Array.from({ length: 98 }, (_, i) => `${asked}-${i + 2}`)].find((one) => !existsSync(path.join(parent, one)));
      if (!name) throw new ActionFailure("folder_taken", `${asked} and the next 98 names are taken in ${parent}.`, "Choose another location, or another name.");
      const folder = path.join(realOf(parent), name);
      if (jobs.has(folder)) return busy(folder);
      const mine = { id: nextJob++, kind: "import", folder, run: null };
      jobs.set(folder, mine);
      emit(mine, "running");
      let got;
      try {
        got = await (await gh()).download({ repo: arg.repo, folder, progress: (line) => emit(mine, "running", line), upload: (fact) => emit(mine, "running", null, uploadFact(fact)) });
        emit(mine, "done");
      } catch (e) {
        emit(mine, "failed", e?.message ?? String(e));
        if (isPublishError(e)) return refusal(e.code, e.message, e.hint);
        throw e;
      } finally {
        jobs.delete(folder);
      }
      const real = realOf(got.folder);
      github.record?.imported(real, { owner: got.owner, name: got.name, commit: got.commit });
      const imported = { owner: got.owner, name: got.name, page: got.page, commit: got.commit, folder: real, shownFolder: shownPath(real), files: got.files, skipped: got.skipped };
      const root = findProjectRoot(real, { home, platform });
      if (!root.found || root.folder !== real) return { ...refusal("not_an_app", `github.com/${got.owner}/${got.name} was downloaded into ${shownPath(real)}, but it is no BUSY Bar app project: ${(root.message ?? "its app is not at the top of the repository").replace(/\.+$/, "")}.`, "Open the folder, or open the app inside it with Open existing."), imported };
      found.add(real);
      const opened = await methods["projects.import"](real);
      return opened ? { ...opened, imported } : null;
    },

    /**
     * { repo }: Import from GitHub of a repository that is no app project, whose latest release has the app's .tgz
     * (github.lookup's `release`): the file downloaded read only into the data folder's own tmp/ (publish-flow.mjs
     * downloadRelease), then looked at, asked about and installed as Install a package does. The folder goes after.
     */
    async "github.release.install"(arg) {
      if (typeof arg?.repo !== "string" || arg.repo.length > 300) return refusal("not_github", "Paste the repository's address, or write owner/name.");
      const flow = await gh();
      const into = insideFolder(dataDir, `tmp/release-${process.pid}-${nextIcons++}`, { missing: true, platform });
      if (!into) return refusal("write_failed", "The data folder's tmp folder leads out of it.");
      try {
        mkdirSync(into, { recursive: true, mode: 0o700 });
        let got;
        try {
          got = await flow.downloadRelease({ repo: arg.repo, into });
        } catch (e) {
          if (isPublishError(e)) return refusal(e.code, e.message, e.hint);
          throw e;
        }
        const answer = await installPackageBytes(readFileSync(got.file), { shown: `${got.asset}, from the release ${got.tag ?? "without a tag"} of github.com/${got.owner}/${got.name}`, source: got.page });
        return { ...answer, release: { owner: got.owner, name: got.name, tag: got.tag, asset: got.asset, page: got.page } };
      } finally {
        rmSync(into, { recursive: true, force: true });
      }
    },

    /** Opens a text file of a project in the system's app for it: a .json, .md or .txt inside a project of the list. */
    async open(target) {
      if (typeof target !== "string" || target.length > MAX_PATH || !path.isAbsolute(target) || !OPENED.test(target)) return false;
      let roots;
      try {
        roots = (await sweep()).filter((project) => project.exists && project.trusted).map((project) => project.folder);
      } catch {
        return false;
      }
      const real = insideRoots(target, roots, { rootItself: false });
      if (!real || !OPENED.test(real) || real.split(path.sep).includes("node_modules")) {
        log(`[shell] actions: refused to open ${JSON.stringify(target.slice(0, 200))}: not a text file of a project of the emulator`);
        return false;
      }
      open(real);
      return true;
    },

    /** Shows a folder in Finder or Explorer: a project of the list, something inside one, or inside the data folder. */
    async reveal(target) {
      if (typeof target !== "string" || target.length > MAX_PATH || !path.isAbsolute(target)) return false;
      let roots;
      try {
        roots = [dataDir, ...(await sweep()).filter((project) => project.exists).map((project) => project.folder)];
      } catch {
        return false;
      }
      const real = insideRoots(target, roots);
      if (!real) {
        log(`[shell] actions: refused to show ${JSON.stringify(target.slice(0, 200))}: not a project of the emulator and not in its data folder`);
        return false;
      }
      show(real);
      return true;
    },

    /**
     * Opens a page of the emulated bar in the system's browser: the bar's own address (its local web) and its API
     * documentation (/docs/, /openapi.yaml), the links of the device window's bar card. Only http addresses of the
     * server's bar address; never the device window's own pages or the old /_emu paths.
     */
    async browse(address) {
      let url;
      try {
        url = new URL(String(address));
      } catch {
        return false;
      }
      const own = barOrigin !== null && url.origin === barOrigin && !url.username && !url.password;
      if (!own || url.pathname === "/emulator" || url.pathname.startsWith("/emulator/") || url.pathname === "/_emu" || url.pathname.startsWith("/_emu/")) {
        log(`[shell] actions: refused to open ${JSON.stringify(String(address).slice(0, 200))} in the browser: not a page of the emulated BUSY Bar`);
        return false;
      }
      browse(url.href);
      return true;
    },

    async copy(text) {
      if (typeof text !== "string" || text.length > MAX_COPY) return false;
      copy(text);
      return true;
    },

    /** Whether the first run's greeting is still to be shown, and what its text for agents needs. */
    async "welcome.get"() {
      if (!welcome) throw new ActionFailure("unavailable", "The greeting is not available here.");
      const settings = welcome.settings.read();
      const way = WELCOME_WAYS.includes(settings[WELCOME_WAY]) ? settings[WELCOME_WAY] : null;
      return { show: settings[WELCOMED] !== true, way, platform: welcome.platform, cli: welcome.cli() };
    },

    /**
     * The person answered the greeting (or closed it): it is not shown by itself again. `{ way }`, when they chose one
     * ("code" or "agent"), is kept too; anything else in the argument is not looked at.
     */
    async "welcome.seen"(answer) {
      if (!welcome) throw new ActionFailure("unavailable", "The greeting is not available here.");
      const way = answer !== null && typeof answer === "object" && WELCOME_WAYS.includes(answer.way) ? answer.way : null;
      return welcome.settings.update({ [WELCOMED]: true, ...(way ? { [WELCOME_WAY]: way } : {}) });
    },
  };

  async function stopLoop(mine) {
    mine.stopped = true;
    mine.run.interrupt();
    const force = setTimeout(() => mine.run.killNow(), INTERRUPT_WAIT_MS);
    await mine.run.exited;
    clearTimeout(force);
  }

  return {
    /**
     * One call of the page's: `{ ok: true, value }`, or `{ ok: false, error: { code, message, hint } }` for what the
     * page is to be told as a failure.
     */
    async call(name, arg) {
      if (!Object.hasOwn(methods, name)) return { ok: false, error: { code: "unknown_action", message: "The app has no such action.", hint: null } };
      try {
        return { ok: true, value: await methods[name](arg) };
      } catch (e) {
        if (e instanceof ActionFailure) return { ok: false, error: { code: e.code, message: e.message, hint: e.hint } };
        log(`[shell] actions: ${name} failed: ${e?.stack ?? e}`);
        return { ok: false, error: { code: "internal", message: "The emulator's app could not do it.", hint: `The log is at ${logFile}.` } };
      }
    },
    /** The project of the list `folder` names, when it may be worked on: { project } or { refused } (capture-actions.mjs). */
    projectFor,
    /** True while the person's own choice of this folder in Open App Folder is being opened: the trust dialog says so. */
    isOpening: (folder) => typeof folder === "string" && opening.has(folder),
    /** The jobs that run now: folder → kind. */
    jobs: () => Object.fromEntries([...jobs].map(([folder, mine]) => [folder, mine.kind])),
    /** The processes of the jobs that run now. */
    pids: () => [...children].map((run) => run.pid).filter(Boolean),
    /** Reads the list anew and lets the deleted projects go; then looks at the folders every few seconds. */
    watch(everyMs = LOOK_EVERY_MS) {
      void sweep().catch((e) => log(`[shell] actions: the projects could not be read: ${e?.message ?? e}`));
      // Once more a moment later: a bar that has only just started may not say yet what it holds.
      setTimeout(() => void look(), Math.min(1000, everyMs)).unref?.();
      timer ??= setInterval(look, everyMs);
      timer.unref?.();
    },
    look,
    /** The window closed: the development loops end. */
    stopLoops() {
      for (const mine of jobs.values()) if (mine.kind === "dev" && mine.run) void stopLoop(mine);
    },
    /** The app goes down and cannot wait: every job ends now. */
    endAll() {
      clearInterval(timer);
      timer = null;
      for (const mine of jobs.values()) mine.stopped = true;
      for (const run of children) run.killNow();
    },
  };
}
