// The built-in update (EMU-221): from the notice of a newer version (update-check.mjs) to that version running, in
// three steps the person takes in the window, never by itself.
//
//   Update to <version>   the release's signed manifest (update-manifest.mjs) is read and checked, then this system's
//                         file of the release is downloaded into <data>/tmp/update-<version>/, with progress, resumed
//                         after a break, and checked against the manifest's size and SHA-256. On macOS the zip is
//                         unpacked beside the app (ditto) after its entries are read, and the new bundle is checked:
//                         the same bundle id and kind of build, the version, its code signature.
//   Restart to update     the person confirms in a dialog. A small helper (update-helper.mjs), started apart from the
//                         app, waits until the app has quit, then puts the new version in place and starts it: on
//                         macOS it swaps the bundles (the old one is kept until the new one has started once, and put
//                         back if it does not start); on Windows it runs the release's setup.exe silently over the
//                         install (the setup refuses while a file of the folder is in use: the helper waits and tries
//                         again) and starts the app.
//   (the new version)     at its first start it tells the helper it is up, and the files of the update go.
//
// Where the app cannot replace itself (macOS runs it from the disk image or from a temporary copy, its folder is not
// writable, Windows has it outside the setup's folder, a run from the source folder) the window keeps the Download
// line of EMU-205 and says why. Errors are said in plain words with the next step; Download is always the way out.
//
// The network: the release's files at github.com/busy-app/busybar-emulator/releases/download/v<version>/, over
// HTTPS only, following GitHub's redirects only to its own hosts (UPDATE_HOSTS). Nothing else is asked, and nothing
// is sent but the address. A test names a stand-in on this machine instead; a release reads no such override.
import { createHash, randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, copyFileSync, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { checkAppLocation } from "./location-check.mjs";
import { insideFolder, within } from "./path-boundary.mjs";
import { ASSET_MAX_BYTES, MANIFEST_FILE, MANIFEST_MAX_BYTES, SIGNATURE_FILE, UPDATE_PUBLIC_KEY, UpdateError, updateAssetFor, verifyManifest } from "./update-manifest.mjs";
import { versionText } from "./update-check.mjs";

/** Where a release's files are, by tag: .../download/v<version>/<file>. */
export const RELEASE_DOWNLOADS = "https://github.com/busy-app/busybar-emulator/releases/download";
/** The hosts a download may be sent to by GitHub's redirects (release files are served from these). HTTPS only. */
export const UPDATE_HOSTS = Object.freeze(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"]);
export const REQUEST_HEADERS = Object.freeze({ "User-Agent": "busybar-emulator" });
const MAX_REDIRECTS = 5;
const IDLE_MS = 30_000;
const ATTEMPTS = 4;
const STAGING_PREFIX = ".busy-emulator-update-";
export const MAC_APP = "BUSY Bar Emulator.app";
const MAC_EXE = path.posix.join("Contents", "MacOS", "BUSY Bar Emulator");
/** The marker setup.exe writes into the folder it installs; it replaces no folder without one. */
const WINDOWS_MARKER = "busybar-emulator-install.json";

/**
 * The origins a download may go to: { protocol, host }[]. A release: https and UPDATE_HOSTS. A test: the one origin
 * of its stand-in (http://127.0.0.1:<port>), never more.
 */
export function originsFor(base) {
  const url = new URL(base);
  if (url.protocol === "https:" && url.host === "github.com") return UPDATE_HOSTS.map((host) => ({ protocol: "https:", host }));
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") return [{ protocol: "http:", host: url.host }];
  throw new Error(`Not a place updates come from: ${base}`);
}

/** Whether an address may be asked: its scheme and host are one of `origins`, and it carries no user or password. */
export function allowedAddress(address, origins) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return origins.some((o) => o.protocol === url.protocol && o.host === url.host);
}

/**
 * One GET, following redirects only to allowed addresses. Resolves with the response (status 200 or 206) and the
 * address it came from; rejects with an UpdateError for anything else.
 */
export function get(address, { origins, transports, headers = {}, idleMs = IDLE_MS, signal }) {
  return new Promise((resolve, reject) => {
    const hop = (url, left) => {
      if (!allowedAddress(url, origins)) return reject(new UpdateError("bad_host", `The download was sent to ${safeHost(url)}, which is not GitHub's`));
      const transport = new URL(url).protocol === "https:" ? transports.https : transports.http;
      const req = transport.request(url, { method: "GET", headers: { ...REQUEST_HEADERS, ...headers }, agent: false, timeout: idleMs, signal }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (left <= 0) return reject(new UpdateError("network", "GitHub sent the download round too many redirects"));
          const next = res.headers.location ? new URL(res.headers.location, url).href : null;
          if (!next) return reject(new UpdateError("network", "GitHub answered with a redirect to nowhere"));
          return hop(next, left - 1);
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(new UpdateError(res.statusCode === 404 ? "not_found" : res.statusCode === 416 ? "range" : "network", `GitHub answered ${res.statusCode}`));
        }
        resolve({ res, url, req });
      });
      req.on("timeout", () => req.destroy(new UpdateError("network", "GitHub stopped answering")));
      req.on("error", (e) => reject(e instanceof UpdateError ? e : new UpdateError(signal?.aborted ? "stopped" : "network", `No connection to GitHub (${e?.code ?? e?.message ?? e})`)));
      req.end();
    };
    hop(address, MAX_REDIRECTS);
  });
}

function safeHost(url) {
  try {
    return new URL(url).host || "an unknown place";
  } catch {
    return "an unknown place";
  }
}

/** A small file (the manifest, its signature), at most `max` bytes. */
export async function fetchSmall(address, { max = MANIFEST_MAX_BYTES, ...o }) {
  const { res, req } = await get(address, o);
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        req.destroy();
        reject(new UpdateError("too_large", "The update's manifest is too long"));
      } else parts.push(chunk);
    });
    res.on("end", () => resolve(Buffer.concat(parts)));
    res.on("error", (e) => reject(new UpdateError("network", `The download broke off (${e?.code ?? e?.message ?? e})`)));
  });
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Downloads `address` into `file` (`file`.part while it comes): exactly `size` bytes, never more, resumed from what a
 * broken attempt left (Range), tried ATTEMPTS times; then its SHA-256 must be `sha256`. A file that does not match is
 * deleted. `onProgress(received, size)`.
 */
export async function downloadFile(address, file, { size, sha256, onProgress = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = ATTEMPTS, ...o }) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > ASSET_MAX_BYTES) throw new UpdateError("too_large", "The update's file is larger than an update can be");
  const part = `${file}.part`;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(Math.min(10_000, 1000 * 2 ** (attempt - 1)));
    if (o.signal?.aborted) throw new UpdateError("stopped", "The download was stopped");
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > size) {
      rmSync(part, { force: true });
      have = 0;
    }
    try {
      if (have < size) await oneAttempt(address, part, { size, have, onProgress, ...o });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      if (e.code === "range") rmSync(part, { force: true });
      if (["bad_host", "too_large", "not_found", "stopped"].includes(e.code)) break;
    }
  }
  if (lastError) throw lastError;
  if (statSync(part).size !== size) {
    rmSync(part, { force: true });
    throw new UpdateError("bad_file", "The downloaded file is not as long as the release says");
  }
  if ((await sha256File(part)) !== sha256) {
    rmSync(part, { force: true });
    throw new UpdateError("bad_file", "The downloaded file is not the one the release signed (its SHA-256 differs)");
  }
  renameSync(part, file);
  return file;
}

async function oneAttempt(address, part, { size, have, onProgress, ...o }) {
  const { res, req } = await get(address, { ...o, headers: have > 0 ? { Range: `bytes=${have}-` } : {} });
  let offset = 0;
  if (res.statusCode === 206) {
    const start = Number(/^bytes (\d+)-/.exec(res.headers["content-range"] ?? "")?.[1]);
    if (start !== have) {
      res.resume();
      throw new UpdateError("range", "GitHub resumed the download at another place");
    }
    offset = have;
  }
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && offset + declared > size) {
    res.resume();
    throw new UpdateError("too_large", "GitHub's file is longer than the release says");
  }
  const out = createWriteStream(part, { flags: offset ? "a" : "w", mode: 0o600 });
  let received = offset;
  onProgress(received, size);
  await new Promise((resolve, reject) => {
    const fail = (e) => {
      req.destroy();
      out.destroy();
      reject(e);
    };
    res.on("data", (chunk) => {
      received += chunk.length;
      if (received > size) return fail(new UpdateError("too_large", "GitHub's file is longer than the release says"));
      if (!out.write(chunk)) {
        res.pause();
        out.once("drain", () => res.resume());
      }
      onProgress(received, size);
    });
    res.on("end", () => out.end(() => (received === size ? resolve() : reject(new UpdateError("network", "The download broke off")))));
    res.on("error", (e) => fail(new UpdateError("network", `The download broke off (${e?.code ?? e?.message ?? e})`)));
    out.on("error", (e) => fail(new UpdateError("disk", `The file could not be written (${e?.code ?? e?.message ?? e})`)));
  });
}

// ---------------------------------------------------------------- the zip of the macOS app, read before it is unpacked

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) throw new UpdateError("bad_file", "The zip ends too soon");
    done += n;
  }
  return buffer;
}

/** The entries of a zip's central directory: { name, isLink, isDir }. No ZIP64 (the app's zip is far from 4 GB). */
export function zipEntries(file) {
  const fd = openSync(file, "r");
  try {
    const total = fstatSync(fd).size;
    const tailLength = Math.min(total, 22 + 0xffff);
    const tail = readAt(fd, total - tailLength, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new UpdateError("bad_file", "The update is not a zip");
    const count = tail.readUInt16LE(at + 10);
    const size = tail.readUInt32LE(at + 12);
    const start = tail.readUInt32LE(at + 16);
    if (count === 0xffff || size === 0xffffffff || start === 0xffffffff || start + size > total) throw new UpdateError("bad_file", "The update's zip is not one this app reads");
    const directory = readAt(fd, start, size);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) throw new UpdateError("bad_file", "The update's zip is broken");
      const madeBy = directory.readUInt16LE(p + 4) >> 8;
      const flags = directory.readUInt16LE(p + 8);
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      const external = directory.readUInt32LE(p + 38);
      const name = directory.subarray(p + 46, p + 46 + nameLength).toString(flags & 0x800 ? "utf8" : "latin1");
      const mode = madeBy === 3 ? external >>> 16 : 0;
      entries.push({ name, isLink: (mode & 0o170000) === 0o120000, isDir: name.endsWith("/") });
      p += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

/**
 * What is wrong with the entries of the app's zip, or null: every entry inside "BUSY Bar Emulator.app/", no absolute
 * path, no ".." or "." part, no backslash or NUL, and nothing beneath an entry that is a link (a link to "/" and then
 * a file "link/x" would write outside). Where each link leads is checked once it is unpacked (bundleProblems).
 */
export function zipProblem(entries, top = MAC_APP) {
  if (!entries.length) return "the zip is empty";
  const links = new Set();
  for (const { name, isLink } of entries) {
    if (!name || name.includes("\0") || name.includes("\\") || name.startsWith("/")) return `the zip holds a path that is not plain: ${JSON.stringify(name)}`;
    const parts = name.replace(/\/$/, "").split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) return `the zip holds a path that leads elsewhere: ${JSON.stringify(name)}`;
    if (parts[0] !== top) return `the zip holds something besides ${top}: ${JSON.stringify(name)}`;
    for (let i = 1; i < parts.length; i++) if (links.has(parts.slice(0, i).join("/"))) return `the zip writes beneath a link: ${JSON.stringify(name)}`;
    if (isLink) links.add(parts.join("/"));
  }
  return null;
}

/** Every link inside `root` must lead to a place inside it; the first one that does not, or null. */
export function linkOutside(root) {
  const stack = [root];
  while (stack.length) {
    const folder = stack.pop();
    for (const name of readdirSync(folder)) {
      const at = path.join(folder, name);
      const stat = lstatSync(at);
      if (stat.isSymbolicLink()) {
        const to = readlinkSync(at);
        if (path.isAbsolute(to) || !within(path.resolve(folder, to), root)) return path.relative(root, at);
      } else if (stat.isDirectory()) stack.push(at);
    }
  }
  return null;
}

// ---------------------------------------------------------------- where this app can replace itself

/**
 * Whether this copy of the app can put a new version in its own place, and if not why, in words for the person.
 * @returns {{ ok: true, target: string, exe: string, noShortcut?: boolean } | { ok: false, why: string }}
 */
export function installPlace({ platform, arch, exe, target = null, homeDir, defaultWindowsFolder = null, writable = isWritable, location = checkAppLocation }) {
  if (!updateAssetFor(platform, arch)) return { ok: false, why: `There is no update for ${platform} on ${arch}.` };
  if (platform === "darwin") {
    const named = target ?? bundleOf(exe);
    if (!named || !named.endsWith(".app")) return { ok: false, why: "This copy of the app is not a macOS app bundle (a run from the source folder)." };
    // By its real path: the staging folder beside it and the helper's plan are compared with it.
    const bundle = realOr(named);
    const where = location({ platform, bundlePath: bundle, homeDir });
    if (!where.ok) return { ok: false, why: where.reason === "translocated" ? "macOS runs this copy from a temporary place: move BUSY Bar Emulator to Applications, open it from there, then update." : where.reason === "read-only-volume" ? "This copy runs from the disk image: drag BUSY Bar Emulator to Applications, open it from there, then update." : "This copy runs from Downloads: move it to Applications first." };
    if (!writable(path.dirname(bundle)) || !writable(bundle)) return { ok: false, why: `The emulator cannot write to ${path.dirname(bundle)}, so it cannot replace itself there.` };
    return { ok: true, target: bundle, exe: path.join(bundle, MAC_EXE) };
  }
  if (platform === "win32") {
    const folder = target ?? path.win32.dirname(exe);
    if (!existsSync(path.win32.join(folder, WINDOWS_MARKER))) return { ok: false, why: "This copy was not installed by the emulator's setup, so the setup cannot update it in place." };
    if (!writable(folder)) return { ok: false, why: `The emulator cannot write to ${folder}.` };
    const noShortcut = !defaultWindowsFolder || folder.toLowerCase() !== defaultWindowsFolder.toLowerCase();
    return { ok: true, target: folder, exe: path.win32.join(folder, "BUSY Bar Emulator.exe"), noShortcut };
  }
  return { ok: false, why: `There is no update for ${platform}.` };
}

function bundleOf(exe) {
  const parts = String(exe ?? "").split("/");
  const at = parts.findIndex((part) => part.endsWith(".app"));
  return at > 0 ? parts.slice(0, at + 1).join("/") : null;
}

function realOr(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

function isWritable(folder) {
  try {
    accessSync(folder, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- Windows: what else runs from the install folder
//
// The setup cannot replace the install folder while a program runs from it: it ends with code 3. The app's own
// processes quit with it, but a command line or an agent's `busy-emulator mcp` runs the app's Node out of that folder
// for as long as it lives. So before the app quits for an update it looks for such processes, and if there are any it
// does not quit: it says which they are. It ends none of them.

/** PowerShell's list of the processes this user may see, as JSON (UTF-8: a folder may be named in any script). */
export const PROCESS_QUERY = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine) | ConvertTo-Json -Compress -Depth 2";

/** PROCESS_QUERY's answer: [{ pid, ppid, exe, command }]. */
export function parseProcessList(text) {
  const raw = JSON.parse(String(text ?? "").replace(/^﻿/, "").trim() || "[]");
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return list
    .map((p) => ({ pid: Number(p?.ProcessId), ppid: Number(p?.ParentProcessId), exe: typeof p?.ExecutablePath === "string" ? p.ExecutablePath : null, command: typeof p?.CommandLine === "string" ? p.CommandLine : "" }))
    .filter((p) => Number.isSafeInteger(p.pid) && p.pid > 0);
}

/** What a process from the install folder is, in words for the person. */
export function whatRuns({ exe, command }) {
  if (/busy-emulator(?:\.mjs|\.exe)?"?\s+mcp(?:\s|$)/i.test(command)) return "an agent's busy-emulator mcp";
  const word = /busy-emulator(?:\.mjs|\.exe)?"?\s+([a-z][a-z-]*)/i.exec(command)?.[1];
  if (word) return `a busy-emulator ${word.toLowerCase()} command`;
  if (/busy-emulator(?:\.mjs|\.exe)?"?\s*$/i.test(command)) return "a busy-emulator command";
  if (exe && /^BUSY Bar Emulator\.exe$/i.test(path.win32.basename(exe))) return "another BUSY Bar Emulator";
  return exe ? path.win32.basename(exe) : "a program";
}

/**
 * The processes that run from `folder` and will not end when the app quits: [{ pid, what }]. Not counted: the app
 * and what it started from the folder (its windows' helpers, its server), and `requester`, the command that asked for
 * the update, with its launcher if that lies in the folder too: it ends as soon as it has the answer.
 */
export function othersInFolder(list, folder, { appPid, requester = null }) {
  const prefix = `${path.win32.normalize(folder).replace(/\\+$/, "").toLowerCase()}\\`;
  const inside = (p) => typeof p?.exe === "string" && path.win32.normalize(p.exe).toLowerCase().startsWith(prefix);
  const byPid = new Map(list.map((p) => [p.pid, p]));
  // Only through programs of the folder: a terminal the app opened (cmd.exe) does not quit with it, nor what runs in it.
  const own = new Set([appPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of list) {
      if (!own.has(p.pid) && p.pid !== p.ppid && own.has(p.ppid) && inside(p)) {
        own.add(p.pid);
        grew = true;
      }
    }
  }
  for (let at = byPid.get(requester), hops = 0; at && inside(at) && !own.has(at.pid) && hops < 4; at = byPid.get(at.ppid), hops++) own.add(at.pid);
  return list.filter((p) => inside(p) && !own.has(p.pid)).map((p) => ({ pid: p.pid, what: whatRuns(p) }));
}

/** The refusal for `others` (othersInFolder): { message, hint }. */
export function folderInUseWords(others) {
  const names = [...new Set(others.map((o) => o.what))];
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const agent = names.some((n) => n.includes("mcp"));
  const one = others.length === 1;
  const message = `${list[0].toUpperCase()}${list.slice(1)} ${one ? "is" : "are"} running from the emulator's folder: ${agent ? "end the agent session" : `let ${one ? "it" : "them"} finish or close ${one ? "it" : "them"}`}, then update.`;
  return { message, hint: `The setup cannot replace the emulator's folder while ${one ? "it runs" : "they run"}, so the emulator did not quit. Nothing was changed.` };
}

/** Runs PROCESS_QUERY with PowerShell (`start`: startShellProgram); the list, or null when it could not be read. */
export function listWindowsProcesses({ start, windowsDir, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = start(path.win32.join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", PROCESS_QUERY], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const parts = [];
    const late = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk) => parts.push(chunk));
    child.on("error", () => (clearTimeout(late), resolve(null)));
    child.on("close", (code) => {
      clearTimeout(late);
      if (code !== 0) return resolve(null);
      try {
        resolve(parseProcessList(Buffer.concat(parts).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
  });
}

// ---------------------------------------------------------------- what the person reads

/** An error of the update in plain words: { message, hint }. Download is always offered beside it. */
export function wordsFor(e) {
  const code = e?.code ?? "failed";
  const said = {
    network: ["The update could not be downloaded: no connection to GitHub, or it broke off.", "Check the connection and press Update again; it goes on from where it stopped."],
    stopped: ["The download was stopped.", "Press Update to go on."],
    not_found: ["GitHub has no update files for this version yet.", "Try again in a few minutes, or download the new version by hand."],
    no_signature: ["The update was refused: it has no signature.", "Download the new version from the release page instead."],
    bad_signature: ["The update was refused: its signature does not match the release's key.", "Download the new version from the release page instead, and tell the emulator's team."],
    bad_manifest: ["The update was refused: its manifest is not one this version reads.", "Download the new version from the release page instead."],
    other_app: ["The update was refused: it is of another program.", "Download the new version from the release page instead."],
    other_version: ["The update was refused: it is of another version than the one offered.", "Download the new version from the release page instead."],
    not_newer: ["The update was refused: it is not newer than this version.", "Nothing to do; you have the newest version."],
    bad_file: ["The update was refused: the downloaded file is not the one the release signed.", "Press Update to download it again, or download it from the release page."],
    bad_host: ["The update was refused: GitHub sent the download to a place that is not GitHub's.", "Download the new version from the release page instead."],
    too_large: ["The update was refused: the file is larger than the release says.", "Download the new version from the release page instead."],
    bad_bundle: ["The update was refused: the new app is not a BUSY Bar Emulator of this kind, or its signature is broken.", "Download the new version from the release page instead."],
    disk: ["The update could not be written to the disk.", "Free some space (an update needs about 1 GB while it installs) and press Update again."],
    busy: ["Not now: the emulator is busy.", "Wait until it is done, then press Restart to update."],
  }[code] ?? ["The update failed.", "Download the new version from the release page instead."];
  return { message: said[0], hint: said[1] };
}

// ---------------------------------------------------------------- the updater

/**
 * @param {object} o
 * @param {string} o.current      the app's version
 * @param {"release"|"test"|"development"} o.kind
 * @param {string} o.platform
 * @param {string} o.arch
 * @param {boolean} o.allowed     whether this build updates itself at all (config.updater.allowed)
 * @param {string} o.base         where the release's files are, by tag (RELEASE_DOWNLOADS, or a test's stand-in)
 * @param {string} [o.publicKey]  the key the manifest's signature is checked with (UPDATE_PUBLIC_KEY; a test's own)
 * @param {string} o.dataDir
 * @param {{ ok: boolean, why?: string, target?: string, exe?: string, noShortcut?: boolean }} o.place   installPlace()
 * @param {string} o.nodePath     the Node the helper runs on
 * @param {string} o.helperFile   update-helper.mjs (read and copied out: it may lie inside app.asar)
 * @param {{ http: object, https: object }} o.transports
 * @param {(file: string, args: string[], options?: object) => any} o.run     runShellProgram
 * @param {(file: string, args: string[], options?: object) => any} o.start   startShellProgram
 * @param {(node: string) => void} o.allowNode  lets the copied Node be started (processes.mjs)
 * @param {() => string | null} o.busy          what the app is doing that a restart would break, or null
 * @param {(question: object) => Promise<"yes" | "no" | "unavailable">} o.confirm   the person's answer in a dialog
 * @param {{ read: Function, update: Function }} o.settings
 * @param {() => void} o.quit
 * @param {(line: string) => void} o.log
 * @param {(state: object) => void} o.onState
 * @param {object} o.env          the environment the helper (and so the new version) is started with
 * @param {number} o.pid          this process: the helper waits for it to end
 * @param {() => Promise<object[] | null>} [o.listProcesses]  Windows: the processes of this computer
 *   (listWindowsProcesses), to find what else runs from the install folder; null when they could not be listed
 */
export function createUpdater({ current, kind, platform, arch, allowed, base, publicKey = UPDATE_PUBLIC_KEY, dataDir, place, nodePath, helperFile, transports, run, start, allowNode = () => {}, busy = () => null, confirm, settings, quit, log, onState, env, pid, listProcesses = async () => null }) {
  const origins = allowed ? originsFor(base) : [];
  const asset = updateAssetFor(platform, arch);
  let state = { state: "none" };
  let job = null;
  let lastSent = 0;

  const canInstall = () => (!allowed ? { ok: false, why: "This build does not update itself." } : place.ok ? { ok: true } : { ok: false, why: place.why });
  function set(next) {
    state = next;
    onState(view());
  }
  /** What the window and the command line are told. */
  function view() {
    const can = canInstall();
    return { ...state, current, canInstall: can.ok, ...(can.ok ? {} : { why: can.why }) };
  }
  const folderOf = (version) => insideFolder(dataDir, `tmp/update-${version}`, { missing: true });

  /** The check found `notice` ({ version, page }) or nothing newer (null). */
  function offer(notice) {
    if (!notice) {
      if (state.state === "available") set({ state: "none" });
      return;
    }
    if (state.version === notice.version && state.state !== "none") return;
    if (job) return;
    set({ state: "available", version: notice.version, page: notice.page });
  }

  /** Update to <version>: the manifest, the file, its checks. Never rejects; the state says how it went. */
  function download() {
    if (job) return job;
    if (!["available", "failed"].includes(state.state) || !state.version) return Promise.resolve(view());
    const can = canInstall();
    if (!can.ok) return Promise.resolve(view());
    const { version, page } = state;
    job = (async () => {
      try {
        set({ state: "downloading", version, page, received: 0, total: null });
        const folder = folderOf(version);
        if (!folder) throw new UpdateError("disk", "The data folder's tmp folder is not usable");
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const tag = `${base}/v${version}`;
        const o = { origins, transports };
        const bytes = await fetchSmall(`${tag}/${MANIFEST_FILE}`, o);
        const signature = await fetchSmall(`${tag}/${SIGNATURE_FILE}`, o).catch((e) => {
          if (e.code === "not_found") return null;
          throw e;
        });
        const manifest = verifyManifest(bytes, signature, { publicKey, expected: version, current });
        const entry = manifest.assets.find((a) => a.name === asset);
        if (!entry) throw new UpdateError("not_found", `The release has no ${asset}`);
        log(`[shell] update: ${version}'s manifest is signed by the release's key; downloading ${asset} (${entry.size} bytes)`);
        const file = path.join(folder, asset);
        if (!(existsSync(file) && statSync(file).size === entry.size && (await sha256File(file)) === entry.sha256)) {
          rmSync(file, { force: true });
          await downloadFile(`${tag}/${asset}`, file, {
            ...o,
            size: entry.size,
            sha256: entry.sha256,
            onProgress: (received, total) => {
              if (Date.now() - lastSent < 200 && received < total) return;
              lastSent = Date.now();
              set({ state: "downloading", version, page, received, total });
            },
          });
        }
        log(`[shell] update: ${asset} downloaded, its SHA-256 is the manifest's`);
        set({ state: "preparing", version, page });
        const staged = platform === "darwin" ? stageMac(file, version) : { setup: file, setupSha256: entry.sha256 };
        set({ state: "ready", version, page, ...staged, folder });
        log(`[shell] update: ${version} is ready; it is installed when the person restarts`);
      } catch (e) {
        log(`[shell] update: ${version} failed: ${e?.code ?? "error"}: ${e?.message ?? e}`);
        set({ state: "failed", version, page, code: e?.code ?? "failed", ...wordsFor(e) });
      } finally {
        job = null;
      }
      return view();
    })();
    return job;
  }

  /** macOS: the zip's entries read, unpacked beside the app, the new bundle checked. */
  function stageMac(zip, version) {
    const problem = zipProblem(zipEntries(zip));
    if (problem) throw new UpdateError("bad_bundle", problem);
    const parent = path.dirname(place.target);
    const staging = insideFolder(parent, `${STAGING_PREFIX}${version}`, { missing: true });
    if (!staging) throw new UpdateError("disk", "The app's folder is not usable");
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    try {
      run("/usr/bin/ditto", ["-x", "-k", zip, staging], { stdio: "ignore" });
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      throw new UpdateError("disk", `The update could not be unpacked (${e?.status ?? e?.message ?? e})`);
    }
    const bundle = path.join(staging, MAC_APP);
    const wrong = bundleProblem(bundle, version) ?? (readdirSync(staging).join("/") !== MAC_APP ? "the zip unpacked into more than the app" : null);
    if (wrong) {
      rmSync(staging, { recursive: true, force: true });
      throw new UpdateError("bad_bundle", wrong);
    }
    // The zip is no longer needed: the bundle beside the app is what goes in.
    rmSync(zip, { force: true });
    return { staging, bundle };
  }

  /** What is wrong with the unpacked bundle, or null: id and kind as this app's, the version, links inside, signature. */
  function bundleProblem(bundle, version) {
    try {
      const mine = plist(path.join(place.target, "Contents", "Info.plist"));
      const theirs = plist(path.join(bundle, "Contents", "Info.plist"));
      if (theirs.CFBundleIdentifier !== mine.CFBundleIdentifier) return `its bundle id is ${theirs.CFBundleIdentifier}, not ${mine.CFBundleIdentifier}`;
      if (theirs.CFBundleShortVersionString !== version) return `it says it is ${theirs.CFBundleShortVersionString}, not ${version}`;
      const marker = JSON.parse(readFileSync(path.join(bundle, "Contents", "Resources", "build.json"), "utf8"));
      if (marker.kind !== kind || marker.version !== version) return `it is a ${marker.kind} build of ${marker.version}, not a ${kind} build of ${version}`;
      if (!existsSync(path.join(bundle, MAC_EXE))) return "it has no executable";
      const link = linkOutside(bundle);
      if (link) return `its link ${link} leads out of the app`;
      run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "ignore" });
      return null;
    } catch (e) {
      return `it could not be checked (${e?.status !== undefined ? `codesign: ${e.status}` : e?.message ?? e})`;
    }
  }

  function plist(file) {
    return JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  }

  /** The person's yes to the update of `version`, asked in the app's dialog: { ok: true } or a refusal. */
  async function ask(version, by, signal) {
    const answer = await confirm(
      {
        about: `update to ${version}`,
        message: by === "window" ? `Restart BUSY Bar Emulator to update to ${version}?` : `Update BUSY Bar Emulator to ${version}?`,
        detail: `${by === "window" ? "" : "A program on this computer (busy-emulator update, most likely your coding agent) asks to update the emulator. It downloads the new version from GitHub first.\n\n"}The emulator quits, ${platform === "win32" ? "its setup installs" : "macOS puts in"} version ${version}, and the emulator opens again in a few seconds. Your projects, the apps on the BUSY Bar and their settings stay.`,
        buttons: ["Cancel", by === "window" ? "Restart" : "Update and restart"],
        yes: 1,
      },
      signal,
    );
    if (answer === "unavailable") return { ok: false, code: "window_hidden", message: "The person could not be asked: the emulator shows no window.", hint: "Open the BUSY Bar Emulator window, then update from there." };
    if (answer !== "yes") return { ok: false, code: "refused", message: "The person chose Cancel: the emulator was not updated.", hint: "Do not ask again unless the person tells you to." };
    return { ok: true };
  }

  /**
   * Windows: what else runs from the install folder and would make the setup refuse (othersInFolder), as a refusal
   * { ok: false, code: "in_use", message, hint }; null when nothing does, elsewhere, or when the list could not be read
   * (the setup's own refusal and the helper's way back still hold then). `requester`: the process of the command that
   * asked for the update, which ends with the answer.
   */
  async function folderInUse({ requester = null } = {}) {
    if (platform !== "win32" || !place.ok) return null;
    let list = null;
    try {
      list = await listProcesses();
    } catch {
      list = null;
    }
    if (!Array.isArray(list)) {
      log("[shell] update: the processes of this computer could not be listed; the setup says if the folder is in use");
      return null;
    }
    const others = othersInFolder(list, place.target, { appPid: pid, requester: Number.isSafeInteger(requester) ? requester : null });
    if (!others.length) return null;
    log(`[shell] update: not now, ${others.length} other process${others.length === 1 ? "" : "es"} run${others.length === 1 ? "s" : ""} from ${place.target}: ${others.map((o) => `${o.pid} (${o.what})`).join(", ")}`);
    return { ok: false, code: "in_use", ...folderInUseWords(others) };
  }

  /** busy-emulator update: the person is asked before anything is downloaded. */
  async function confirmFirst({ by = "cli", signal } = {}) {
    if (!state.version || !["available", "failed", "ready"].includes(state.state)) return { ok: false, code: "no_update", message: "There is no newer version to update to.", hint: null };
    return ask(state.version, by, signal);
  }

  /**
   * Restart to update: the person confirms (`by`: who asks, the window or a program; `confirmed`: they did already,
   * in confirmFirst), then the helper is started and the app quits. Resolves with { ok, code?, message?, hint? }.
   */
  async function restart({ by = "window", signal, confirmed = false, requester = null } = {}) {
    if (state.state !== "ready") return { ok: false, code: "not_ready", message: "There is no update ready to install.", hint: null };
    const doing = busy();
    if (doing) return { ok: false, code: "busy", message: `Not now: ${doing}.`, hint: "Wait until it is done, then restart to update." };
    const { version } = state;
    // Before the person is asked, and again just before the app quits: they may take their time to answer.
    const inUse = await folderInUse({ requester });
    if (inUse) return inUse;
    if (!confirmed) {
      const said = await ask(version, by, signal);
      if (!said.ok) return said;
    }
    const again = busy();
    if (again) return { ok: false, code: "busy", message: `Not now: ${again}.`, hint: "Wait until it is done, then restart to update." };
    const stillInUse = await folderInUse({ requester });
    if (stillInUse) return stillInUse;
    if (state.state !== "ready" || state.version !== version) return { ok: false, code: "not_ready", message: "The update changed while the person was asked.", hint: "Try again." };
    try {
      launchHelper();
    } catch (e) {
      log(`[shell] update: the helper could not be started: ${e?.message ?? e}`);
      set({ state: "failed", version, page: state.page, code: "disk", ...wordsFor({ code: "disk" }) });
      return { ok: false, code: "failed", message: "The update could not be started.", hint: "Download the new version from the release page instead." };
    }
    set({ ...state, state: "restarting" });
    log(`[shell] update: restarting into ${version}`);
    setTimeout(quit, 300).unref?.();
    return { ok: true, version, restarting: true };
  }

  function launchHelper() {
    const { version, folder } = state;
    const token = randomBytes(16).toString("hex");
    const helper = path.join(folder, "update-helper.mjs");
    writeFileSync(helper, readFileSync(helperFile), { mode: 0o600 });
    let node = nodePath;
    if (platform === "win32") {
      // The setup replaces the folder the app's own Node lies in: the helper runs on a copy of it, out of that folder.
      node = path.join(folder, "node.exe");
      copyFileSync(nodePath, node);
      allowNode(node);
    }
    const plan = {
      token,
      pid,
      platform,
      version,
      from: current,
      target: place.target,
      exe: place.exe,
      ...(platform === "darwin" ? { staging: state.staging, bundle: state.bundle, previous: path.join(state.staging, "previous", MAC_APP) } : { setup: state.setup, setupSha256: state.setupSha256, noShortcut: place.noShortcut === true, setupLog: path.join(folder, "setup.log") }),
      started: path.join(folder, "started"),
      result: path.join(folder, "result.json"),
      log: path.join(folder, "helper.log"),
    };
    const planFile = path.join(folder, "plan.json");
    rmSync(plan.started, { force: true });
    rmSync(plan.result, { force: true });
    writeFileSync(planFile, JSON.stringify(plan, null, 2), { mode: 0o600 });
    settings.update({ updatePending: { from: current, to: version, folder, token, at: Date.now() } });
    const child = start(node, [helper, planFile, token], { detached: true, stdio: "ignore", windowsHide: true, env, cwd: folder });
    child.unref?.();
    log(`[shell] update: the helper runs (process ${child.pid ?? "?"}), it waits for this process (${pid}) to quit`);
  }

  /**
   * At the start, once the server is up: an update that brought this version says so to its helper and its files go;
   * one that did not (the helper put the old version back, or the setup refused) says why in the window.
   */
  function afterStart() {
    const pending = settings.read().updatePending;
    if (!pending || typeof pending !== "object") return cleanLeftovers(null);
    const folder = typeof pending.to === "string" && versionText(pending.to) === pending.to ? folderOf(pending.to) : null;
    if (!folder) {
      settings.update({ updatePending: null });
      return cleanLeftovers(null);
    }
    if (pending.to === current) {
      try {
        writeFileSync(path.join(folder, "started"), `${pending.token ?? ""}\n`, { mode: 0o600 });
      } catch {
        // The folder is gone: nothing waits for it.
      }
      settings.update({ updatePending: null, updatedFrom: pending.from });
      log(`[shell] update: ${current} started after the update from ${pending.from}`);
      // The helper sees the mark within a second and ends; then the update's files go.
      setTimeout(() => cleanLeftovers(null), 60_000).unref?.();
      return;
    }
    if (pending.from !== current) {
      settings.update({ updatePending: null });
      return cleanLeftovers(null);
    }
    let result = null;
    try {
      result = JSON.parse(readFileSync(path.join(folder, "result.json"), "utf8"));
    } catch {
      // No result: the helper never ran, or did not get far.
    }
    settings.update({ updatePending: null });
    const why = result?.message ?? "The update did not finish.";
    log(`[shell] update: the update to ${pending.to} did not happen: ${why}`);
    set({ state: "failed", version: pending.to, page: `https://github.com/busy-app/busybar-emulator/releases/tag/v${pending.to}`, code: result?.code ?? "failed", message: `The update to ${pending.to} did not finish: ${why}`, hint: result?.hint ?? "Press Update to try again, or download the new version from the release page." });
    cleanLeftovers(null);
  }

  /** The update folders in <data>/tmp that nothing waits for, and staging folders beside the app. */
  function cleanLeftovers(keep) {
    if (job || !["none", "available", "failed"].includes(state.state)) return;
    const tmp = insideFolder(dataDir, "tmp", { missing: true });
    if (tmp && existsSync(tmp)) {
      for (const name of readdirSync(tmp)) {
        if (!name.startsWith("update-") || name === keep) continue;
        rmSync(path.join(tmp, name), { recursive: true, force: true });
      }
    }
    if (platform === "darwin" && place.ok) {
      const parent = path.dirname(place.target);
      try {
        for (const name of readdirSync(parent)) if (name.startsWith(STAGING_PREFIX)) rmSync(path.join(parent, name), { recursive: true, force: true });
      } catch {
        // The folder cannot be read: nothing of ours is there.
      }
    }
  }

  return {
    offer,
    download,
    confirmFirst,
    folderInUse,
    restart,
    afterStart,
    get state() {
      return view();
    },
    get busy() {
      return Boolean(job);
    },
  };
}
