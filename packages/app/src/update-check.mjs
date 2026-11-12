// The notice of a new version (EMU-205; ADR-0014, point 6).
//
// At its start, at most once a day and again at the first start of a newly installed version, the app asks GitHub
// which release of the emulator is the latest. When that release is newer than the app, the window shows one quiet
// line with a link to the release page, which opens in the user's browser. Nothing is downloaded and nothing is installed.
//
// It is the one request the app makes by itself. It goes from the main process, not through a window's session
// (those reach the server's address only), and carries nothing but itself: the address below, a fixed User-Agent
// without a version, and what the Accept header asks for. No identifier, nothing about the machine, no cookie. A
// failed check says nothing to the person: no network, an answer that is not a release, a slow answer all end as
// "nothing new". Besides the version, the answer's release notes give the update's pop-up two or three short lines
// (releaseSummary): plain text, no links and no markup, shown as text. The check is off when BUSY_EMULATOR_NO_UPDATE_CHECK=1, when the person switched it off in the menu
// (kept in app-settings.json in the data folder), in the test variant and in a run from the source folder.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The public repository whose releases the app is (ADR-0002). */
export const RELEASES = Object.freeze({ owner: "busy-app", repo: "busybar-emulator" });
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASES.owner}/${RELEASES.repo}/releases/latest`;
/** All the request says besides its address. GitHub's API refuses a request without a User-Agent. */
export const REQUEST_HEADERS = Object.freeze({ "User-Agent": "busybar-emulator", Accept: "application/vnd.github+json" });
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 10_000;
/** After a check that got no answer (offline at the start, a slow network) the next one is made this soon, not in a day. */
export const RETRY_AFTER_FAILURE_MS = 15 * 60 * 1000;
const MAX_ANSWER_BYTES = 1024 * 1024;
/**
 * busy-emulator update --check asks now, past the daily rule, but at most this often: an agent that calls it in a loop
 * must not spend the hourly quota GitHub gives the person's address (60 unauthenticated requests). Within the minute
 * the answer of the last forced check stands.
 */
export const FORCED_CHECK_EVERY_MS = 60_000;

/**
 * A version by the rules of Semantic Versioning 2.0.0, "1.2.3" or "1.2.3-beta.1", with or without a leading "v":
 * { core: [major, minor, patch], pre: ["beta", "1"] } (pre is empty for a version without a pre-release part); null
 * for anything else. Build metadata ("+...") is not taken: the release page is made from the version, and a tag with
 * metadata would not be found by it.
 */
export function parseVersion(text) {
  const value = String(text ?? "").trim();
  if (value.length > 64) return null;
  const m = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".") : [];
  // A numeric identifier has no leading zero.
  if (pre.some((id) => /^0\d+$/.test(id))) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** "1.2.3-beta.1" of what parseVersion gives, without the "v"; null when `text` is not a version. */
export function versionText(text) {
  const v = parseVersion(text);
  return v ? `${v.core.join(".")}${v.pre.length ? `-${v.pre.join(".")}` : ""}` : null;
}

const numeric = (id) => /^\d+$/.test(id);

/** Two pre-release identifiers: numbers by value and below anything with a letter; the rest in ASCII order. */
function compareIdentifiers(a, b) {
  if (numeric(a) && numeric(b)) return a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;
  if (numeric(a) !== numeric(b)) return numeric(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The precedence of two versions (Semantic Versioning 2.0.0, section 11): below zero when `a` comes before `b`, above
 * when after, zero when they are the same; null when either is not a version. The three numbers decide first; then a
 * version with a pre-release part comes before the same numbers without one (0.1.0-beta.2 < 0.1.0); then the
 * identifiers one by one, and of two that start alike the shorter comes first (beta < beta.1 < beta.2 < beta.10).
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdentifiers(x.pre[i], y.pre[i]);
    if (order) return order;
  }
  return x.pre.length - y.pre.length;
}

/**
 * True when `candidate` is a version above `current`; false when either is not a version. Betas are releases like
 * the others ("0.1.0-beta.2" is offered to "0.1.0-beta.1", and "0.1.0" to both); a release is never offered a
 * pre-release of its own or of an older version.
 */
export function isNewer(candidate, current) {
  const order = compareVersions(candidate, current);
  return order !== null && order > 0;
}

/** The page of a release, made from the version alone: nothing of GitHub's answer but the version is used. */
export function releasePage(version) {
  const v = versionText(version);
  if (!v) throw new Error(`Not a version: ${version}`);
  return `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases/tag/v${v}`;
}

/**
 * The version in the API's answer for the latest release ("tag_name": "v0.2.0"), "0.2.0"; null when it has none.
 * GitHub's "latest" leaves out the releases marked "pre-release" there; the betas are published as ordinary releases,
 * and only their tag says "-beta.N".
 */
export function versionInAnswer(body) {
  try {
    return versionText(JSON.parse(body)?.tag_name);
  } catch {
    return null;
  }
}

/** The most the update's pop-up says of a release: lines, and characters in all. */
export const SUMMARY_LINES = 3;
export const SUMMARY_CHARS = 240;

/** Markdown's inline marks out of one line: links and images to their words, code, emphasis and tags to plain text. */
function plainLine(line) {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/[\u0000-\u001f\u007f\u00b7\u2022]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `text` cut to `max` characters at a word, with an ellipsis when it was cut. */
function cutAt(text, max) {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const word = head.lastIndexOf(" ");
  return `${(word > max / 2 ? head.slice(0, word) : head).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * Two or three short lines of a release's notes (the body of GitHub's answer, the changelog's section first), for
 * the update's pop-up: { kind: "list", lines } for the first items of the first list, { kind: "text", lines: [one] }
 * for the first sentences of the first paragraph; null when there is nothing to say. Headings are skipped, and the
 * notes stop at the release's own "## Files". Plain text only: what is shown is never read as markup.
 */
export function releaseSummary(body) {
  if (typeof body !== "string" || !body.trim()) return null;
  const items = [];
  let paragraph = [];
  for (const raw of body.slice(0, 64 * 1024).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#{1,6}\s/.test(line)) {
      if (/^#{1,6}\s+files\b/i.test(line) || paragraph.length || items.length) break;
      continue;
    }
    const item = /^(?:[-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      if (paragraph.length) break;
      const text = plainLine(item[1]);
      if (text) items.push(text);
      if (items.length >= SUMMARY_LINES) break;
      continue;
    }
    if (!line) {
      if (paragraph.length || items.length) break;
      continue;
    }
    // A line that goes on a list's item belongs to it.
    if (items.length) {
      items[items.length - 1] = plainLine(`${items[items.length - 1]} ${line}`);
      continue;
    }
    paragraph.push(line);
  }
  if (items.length) {
    const each = Math.floor(SUMMARY_CHARS / items.length);
    return { kind: "list", lines: items.map((text) => cutAt(text, Math.max(60, each))) };
  }
  const text = plainLine(paragraph.join(" "));
  if (!text) return null;
  // Whole sentences while they fit; the first one cut if it alone does not.
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);
  let said = "";
  for (const sentence of sentences) {
    if (said && `${said} ${sentence}`.length > SUMMARY_CHARS) break;
    said = said ? `${said} ${sentence}` : sentence;
  }
  return { kind: "text", lines: [cutAt(said, SUMMARY_CHARS)] };
}

/** The summary in GitHub's answer for the latest release, or null. */
export function summaryInAnswer(body) {
  try {
    return releaseSummary(JSON.parse(body)?.body);
  } catch {
    return null;
  }
}

/**
 * Asks for the latest release. Resolves with the answer's body, rejects on anything else (no network, not 200, too
 * long, too slow). No redirect is followed.
 * @param {string} address
 * @param {{ request: Function }} transport  node:https (or node:http, for a test's stand-in on this machine)
 */
export function askLatest(address, transport, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = transport.request(address, { method: "GET", headers: REQUEST_HEADERS, timeout: timeoutMs, agent: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`status ${res.statusCode}`));
      }
      const parts = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) req.destroy(new Error("the answer is too long"));
        else parts.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      res.on("error", reject);
    });
    const late = setTimeout(() => req.destroy(new Error("no answer in time")), timeoutMs);
    late.unref?.();
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", reject);
    req.on("close", () => clearTimeout(late));
    req.end();
  });
}

/** The app's own settings, one small file in the data folder; a file that cannot be read is an empty one. */
export function createSettings(file) {
  const read = () => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  };
  return {
    read,
    /** Merges `change` in; false when the file could not be written. */
    update(change) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const draft = `${file}.${process.pid}`;
        writeFileSync(draft, `${JSON.stringify({ ...read(), ...change }, null, 2)}\n`);
        renameSync(draft, file);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * @param {object} o
 * @param {string} o.current                 the app's version
 * @param {boolean} o.allowed                false: this build or this run never checks (config.updateCheck)
 * @param {{ read: Function, update: Function }} o.settings
 * @param {() => Promise<string>} o.ask      asks for the latest release, resolves with the answer's body
 * @param {(line: string) => void} o.log
 * @param {(notice: { version: string, page: string } | null) => void} o.onNotice
 */
export function createUpdateCheck({ current, allowed, settings, ask, log, onNotice, now = Date.now, everyMs = CHECK_EVERY_MS }) {
  let notice = null;
  let timer = null;
  let asking = false;
  let requests = 0;
  let lastForced = null; // { at, error }: the last check that `force` made ask

  const enabled = () => allowed && settings.read().updateCheck !== false;
  /** The version found, with its notes' summary when they are of that version (updateNotes: { version, kind, lines }). */
  function show(version, notes = settings.read().updateNotes) {
    const summary = notes && typeof notes === "object" && notes.version === versionText(version) && Array.isArray(notes.lines) ? { kind: notes.kind === "list" ? "list" : "text", lines: notes.lines.filter((l) => typeof l === "string").slice(0, SUMMARY_LINES) } : null;
    const next = version && isNewer(version, current) ? { version: versionText(version), page: releasePage(version), ...(summary?.lines.length ? { summary } : {}) } : null;
    if (next?.version === notice?.version && Boolean(next?.summary) === Boolean(notice?.summary)) return;
    notice = next;
    onNotice(notice);
  }

  /**
   * One check, if one is due. Never rejects; `force` (busy-emulator update --check) asks now, at most once in
   * FORCED_CHECK_EVERY_MS, and rejects when no answer came.
   */
  async function check({ force = false } = {}) {
    if (!enabled() || asking) return;
    if (force && lastForced && lastForced.at <= now() && now() - lastForced.at < FORCED_CHECK_EVERY_MS) {
      if (lastForced.error) throw lastForced.error;
      force = false;
    }
    if (force) lastForced = { at: now(), error: null };
    const { updateChecked, updateFailed, updateLatest, updateCheckedBy } = settings.read();
    // What the last check found is shown without asking again.
    show(updateLatest);
    // A check made by another version (the person has just installed the new one) is not this version's: during the
    // hackathon a hotfix may follow the one just installed within the day, so the first start of a version asks again.
    const fresh = updateCheckedBy === current && Number.isFinite(updateChecked) && updateChecked <= now() && now() - updateChecked < everyMs;
    if (fresh && !force) return;
    if (!force && Number.isFinite(updateFailed) && updateFailed <= now() && now() - updateFailed < RETRY_AFTER_FAILURE_MS) return;
    asking = true;
    requests += 1;
    try {
      const answer = await ask();
      const version = versionInAnswer(answer);
      const summary = version ? summaryInAnswer(answer) : null;
      // An answer without a version (a repository with no release yet answers 404) is "nothing new", and is not
      // asked for again today either.
      settings.update({ updateChecked: now(), updateFailed: null, updateLatest: version, updateCheckedBy: current, ...(summary ? { updateNotes: { version, ...summary } } : {}) });
      log(`[shell] update check: the latest release is ${version ?? "not known"}, this is ${current}`);
      if (enabled()) show(version);
    } catch (e) {
      // Not "checked": a hotfix must not wait a day because the network was down at the start.
      settings.update({ updateFailed: now() });
      log(`[shell] update check: no answer (${e?.message ?? e})`);
      if (force) {
        lastForced.error = e;
        throw e;
      }
    } finally {
      asking = false;
    }
  }

  return {
    get notice() {
      return notice;
    },
    /** How many requests this run has made. */
    get requests() {
      return requests;
    },
    get allowed() {
      return allowed;
    },
    enabled,
    check,
    /** Checks now and then once a day for as long as the app runs. */
    start() {
      if (!allowed || timer) return;
      void check();
      timer = setInterval(() => void check(), Math.min(everyMs, RETRY_AFTER_FAILURE_MS));
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    /** The person's switch in the menu. Off takes the notice away. */
    setEnabled(on) {
      settings.update({ updateCheck: Boolean(on) });
      if (!on) show(null);
      else void check();
    },
  };
}
