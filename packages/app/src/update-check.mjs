// The notice of a new version (EMU-205; ADR-0014, point 6).
//
// At every start, and then once a day while it runs, the app asks GitHub which release of the emulator is the latest
// (one request per launch: a hotfix published an hour after the last check is seen at the next start, not a day later). When that release is newer than the app, the window shows one quiet
// line with a link to the release page, which opens in the user's browser. Nothing is downloaded and nothing is installed.
//
// It is the one request the app makes by itself. It goes from the main process, not through a window's session
// (those reach the server's address only), and carries nothing but itself: the address below, a fixed User-Agent
// without a version, and what the Accept header asks for. No identifier, nothing about the machine, no cookie. A
// failed check says nothing to the person: no network, an answer that is not a release, a slow answer all end as
// "nothing new". Besides the version, the answer gives the update's pop-up the release's notes, whole up to their
// "## Files" (parseReleaseNotes): plain text, links as their words, no markup, shown as text. The check is off when
// BUSY_EMULATOR_NO_UPDATE_CHECK=1, when the person switched it off in the menu (kept in app-settings.json in the data
// folder), in the test variant and in a run from the source folder.
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
 * The check at the start asks whatever the daily rule says, but not again within this of the last answer: an app
 * started over and over (by an agent, by a crash loop) is one request a minute, not one per launch.
 */
export const START_CHECK_EVERY_MS = 60_000;

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

/**
 * The most of a release's notes the app keeps and the pop-up shows: characters of text in all, and entries (headings,
 * paragraphs, list items). Notes are a screen or two (CHANGELOG.md: one bullet a feature); these bounds are only for
 * a body that is huge or hostile. Past either, whole entries are left out, never a part of one, and the pop-up says
 * that the rest is on the release page.
 */
export const NOTES_CHARS = 8000;
export const NOTES_ENTRIES = 200;
/** Lists nest this deep at most: an item deeper still is an item of the deepest list. */
export const NOTES_DEPTH = 3;
/** Of the body, only this much is read; a longer one is read up to its last whole line in it. */
const NOTES_READ = 64 * 1024;
/**
 * The longest line read, in characters with its tabs as four spaces. The release's lines are a sentence or two; a
 * longer one is hostile, and the reading stops there (a line left out whole, as the bounds above leave out entries),
 * so that the work on a line, some of it more than linear in its length, stays small in the app's main process.
 */
export const NOTES_LINE = 2000;

/**
 * Markdown's inline marks out of one line: links and images to their words, emphasis to plain text, tags out, code
 * spans without their backticks. In a code span a tag is a word (`<time>` stays); links and emphasis are taken out of
 * it as anywhere else, which the release's notes never need otherwise.
 */
function plainLine(line) {
  // Each pattern stops at the next mark of its own kind ([ inside a link's words, < inside a tag, a backtick inside
  // code), so that the work stays linear in the line's length whatever the line is made of.
  return line
    .replace(/!\[[^[\]]*\]\([^()]*\)/g, "")
    .replace(/\[([^[\]]*)\]\([^()]*\)/g, "$1")
    .replace(/\[([^[\]]*)\]\[[^[\]]*\]/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/(?<!`)(`+)([^`]+)\1(?!`)|<[^<>]*>/g, (_, ticks, code) => (ticks ? code : ""))
    .replace(/`+/g, "")
    .replace(/[\u0000-\u001f\u007f\u00b7\u2022]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A list's item: its bold opening words (the feature's name, CHANGELOG.md) apart from the rest, both plain text. */
function newItem(raw) {
  const strong = /^(\*\*|__)(.+?)\1(?=\s|$)(.*)$/.exec(raw);
  const lead = strong ? plainLine(strong[2]) : "";
  const text = plainLine(strong ? strong[3] : raw);
  return lead ? { lead, text } : { text };
}

const joined = (a, b) => (a && b ? `${a} ${b}` : a || b);

/**
 * `blocks` within the bounds: whole entries, in their order, until the characters or the entries run out; the lists
 * no deeper than NOTES_DEPTH. Anything that is not of the notes' shape is left out, so that what a settings file holds
 * is drawn only when it is what this module wrote. { blocks, more }: more is true when something was left out.
 */
function bounded(blocks, more = false) {
  const room = { chars: NOTES_CHARS, entries: NOTES_ENTRIES, more: false };
  const take = (text) => {
    if (room.more) return false;
    if (text.length > room.chars || room.entries < 1) {
      room.more = true;
      return false;
    }
    room.chars -= text.length;
    room.entries -= 1;
    return true;
  };
  // What this module wrote is plain text already; a settings file edited by hand gets the same rules for its characters.
  const str = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u00b7\u2022]+/g, " ").replace(/\s+/g, " ").trim() : "");
  const list = (value, depth) => {
    const items = [];
    for (const one of Array.isArray(value?.items) ? value.items : []) {
      if (!one || typeof one !== "object") continue;
      const lead = str(one.lead);
      const text = str(one.text);
      if (!lead && !text) continue;
      if (!take(joined(lead, text))) break;
      const item = lead ? { lead, text } : { text };
      const inner = depth < NOTES_DEPTH && one.list ? list(one.list, depth + 1) : null;
      if (inner) item.list = inner;
      items.push(item);
    }
    return items.length ? { ordered: value.ordered === true, items } : null;
  };
  const out = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (room.more) break;
    if (block?.type === "heading" || block?.type === "paragraph") {
      const text = str(block.text);
      if (text && take(text)) out.push({ type: block.type, text });
    } else if (block?.type === "list") {
      const made = list(block, 1);
      if (made) out.push({ type: "list", ...made });
    }
  }
  return { blocks: out, more: room.more || more };
}

/**
 * A release's notes (the body of GitHub's answer: the changelog's section, then "## Files"), whole, for the update's
 * pop-up: { blocks, more } up to the release's own "## Files" heading, or null when there is nothing to show. Blocks
 * are { type: "heading", text }, { type: "paragraph", text } (a lead-in such as "The window:" is one) and
 * { type: "list", ordered, items }; an item is { lead?, text, list? }, with lead its bold opening words and list its
 * nested items (CHANGELOG.md: one bullet a feature, nested bullets for the details). Plain text only: links become
 * their words, code marks and tags go, and nothing of it is ever read as markup. Within NOTES_CHARS, NOTES_ENTRIES,
 * NOTES_DEPTH and NOTES_LINE; nothing shown is cut. Not read as Markdown, and so shown as their text: fenced and
 * indented code blocks, setext headings (a line underlined with === or ---), tables and HTML comments over several
 * lines; the changelog uses none of them.
 */
export function parseReleaseNotes(body) {
  if (typeof body !== "string" || !body.trim()) return null;
  let text = body;
  let unread = null; // the first line that is not read, when the reading stops before the end
  if (text.length > NOTES_READ) {
    text = text.slice(0, text.lastIndexOf("\n", NOTES_READ) + 1);
    unread = body.slice(text.length).split(/\r?\n/, 1)[0];
  }
  const blocks = [];
  let paragraph = []; // the lines of the paragraph being read
  let stack = []; // the lists open: { list, indent, item, content } from the outermost to the deepest
  let gap = false; // a blank line inside a list: a line after it goes on only if it is indented under an item
  let chars = 0;
  let entries = 0;
  let ended = false; // the notes' end, "## Files", was reached
  const flush = () => {
    if (paragraph.length) {
      const said = paragraph.join(" ");
      if (said) blocks.push({ type: "paragraph", text: said });
      chars += said.length;
      entries += 1;
    }
    paragraph = [];
  };
  const endList = () => {
    stack = [];
    gap = false;
  };
  /** The item a line indented by `indent` goes on: the deepest whose text it is under; the deepest one if none. */
  const owner = (indent) => [...stack].reverse().find((open) => open.content <= indent) ?? null;

  for (const raw of text.split(/\r?\n/)) {
    const expanded = raw.length > NOTES_LINE ? null : raw.replace(/\t/g, "    ");
    if (chars > NOTES_CHARS || entries > NOTES_ENTRIES || expanded === null || expanded.length > NOTES_LINE) {
      unread = raw;
      break;
    }
    const indent = expanded.length - expanded.trimStart().length;
    const line = expanded.trim();
    if (!line) {
      if (stack.length) gap = true;
      else flush();
      continue;
    }
    const heading = indent < 4 ? /^#{1,6}(?: +(.*))?$/.exec(line) : null;
    if (heading) {
      flush();
      endList();
      // The closing #s of "## Fixed ##" go, by plain string work (a pattern for them is slow on long runs of spaces).
      let words = heading[1] ?? "";
      let end = words.length;
      while (end > 0 && words[end - 1] === "#") end -= 1;
      if (end === 0) words = "";
      else if (end < words.length && words[end - 1] === " ") words = words.slice(0, end);
      const said = plainLine(words);
      if (/^files$/i.test(said)) {
        ended = true;
        break;
      }
      if (said) blocks.push({ type: "heading", text: said });
      chars += said.length;
      entries += 1;
      continue;
    }
    // A thematic break (---, ***, ___) separates; it says nothing.
    if (/^([-*_])(?:\s*\1){2,}$/.test(line)) {
      flush();
      endList();
      continue;
    }
    const marker = /^([-*+]|\d{1,9}[.)])(\s+|$)(.*)$/.exec(line);
    if (marker) {
      flush();
      gap = false;
      const item = newItem(marker[3]);
      const content = indent + marker[1].length + Math.max(1, marker[2].length);
      const ordered = /\d/.test(marker[1]);
      // Another bullet or another kind of number at the outer level starts another list, as in Markdown.
      const kind = ordered ? marker[1].slice(-1) : marker[1];
      if (stack.length && indent <= stack[0].indent && stack[0].kind !== kind) endList();
      if (!stack.length) {
        const list = { type: "list", ordered, items: [] };
        blocks.push(list);
        stack.push({ list, indent, item: null, content, kind });
      } else if (indent > stack.at(-1).indent && stack.at(-1).item) {
        // Under the item above: one of its details, unless the lists are as deep as they go.
        const parent = stack.at(-1);
        if (stack.length < NOTES_DEPTH) {
          const list = parent.item.list ?? (parent.item.list = { ordered, items: [] });
          stack.push({ list, indent, item: null, content });
        }
      } else {
        while (stack.length > 1 && stack.at(-1).indent > indent) stack.pop();
      }
      const open = stack.at(-1);
      if (item.lead || item.text) {
        open.list.items.push(item);
        open.item = item;
        open.content = content;
        chars += joined(item.lead ?? "", item.text).length;
        entries += 1;
      }
      continue;
    }
    if (stack.length) {
      const target = gap ? owner(indent) : (owner(indent) ?? stack.at(-1));
      if (target?.item) {
        // A line that goes on an item (wrapped, or a paragraph indented under it after a blank line) is its text.
        const said = plainLine(line);
        target.item.text = joined(target.item.text, said);
        chars += said.length + 1;
        gap = false;
        continue;
      }
      endList();
    }
    const said = plainLine(line);
    if (said) paragraph.push(said);
  }
  const over = !ended && unread !== null;
  // What was being read when the reading stopped is left out whole, not shown cut, unless the line after it starts
  // something else (an item, a heading): then it was all there.
  if (over && !/^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)|^\s{0,3}#{1,6}(?:\s|$)/.test(unread)) {
    paragraph = [];
    const open = stack.at(-1);
    if (open?.item) open.list.items.pop();
  }
  flush();
  const notes = bounded(blocks, over);
  return notes.blocks.length || notes.more ? notes : null;
}

/** The notes in GitHub's answer for the latest release, or null. */
export function notesInAnswer(body) {
  try {
    return parseReleaseNotes(JSON.parse(body)?.body);
  } catch {
    return null;
  }
}

/**
 * The notes the app keeps for `version` (app-settings.json, updateNotes): { blocks, more } when they are of that
 * version and of the shape this version writes ({ version, blocks, more }), within the bounds again; null for anything
 * else. The shape of 0.1.0-beta.6 and before ({ version, kind, lines }: two or three lines cut with an ellipsis) is
 * not shown: the check at the start asks GitHub again and keeps the whole notes in its place.
 */
export function storedNotes(stored, version) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  if (!version || stored.version !== versionText(version) || !Array.isArray(stored.blocks)) return null;
  const notes = bounded(stored.blocks, stored.more === true);
  return notes.blocks.length || notes.more ? notes : null;
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
  /** The version found, with its notes when the app keeps them for that version (updateNotes, storedNotes). */
  function show(version, kept = settings.read().updateNotes) {
    const notes = version ? storedNotes(kept, version) : null;
    const next = version && isNewer(version, current) ? { version: versionText(version), page: releasePage(version), ...(notes ? { notes } : {}) } : null;
    if (next?.version === notice?.version && JSON.stringify(next?.notes ?? null) === JSON.stringify(notice?.notes ?? null)) return;
    notice = next;
    onNotice(notice);
  }

  /**
   * One check, if one is due. Never rejects; `force` (busy-emulator update --check) asks now, at most once in
   * FORCED_CHECK_EVERY_MS, and rejects when no answer came. `atStart` (start) asks past the daily rule and past the
   * retry after a failure, unless the last answer or failure is less than START_CHECK_EVERY_MS old.
   */
  async function check({ force = false, atStart = false } = {}) {
    if (!enabled() || asking) return;
    if (force && lastForced && lastForced.at <= now() && now() - lastForced.at < FORCED_CHECK_EVERY_MS) {
      if (lastForced.error) throw lastForced.error;
      force = false;
    }
    if (force) lastForced = { at: now(), error: null };
    const { updateChecked, updateFailed, updateLatest, updateCheckedBy, updateAsked } = settings.read();
    // What the last check found is shown without asking again.
    show(updateLatest);
    // A check made by another version (the person has just installed the new one) is not this version's: during the
    // hackathon a hotfix may follow the one just installed within the day, so the first start of a version asks again.
    const within = (at, ms) => Number.isFinite(at) && at <= now() && now() - at < ms;
    const fresh = updateCheckedBy === current && within(updateChecked, everyMs);
    if (atStart && !force) {
      // Every launch asks once; only a launch right after the last request takes its answer.
      // A request still unanswered when the app ended (a crash right after start) counts too: a loop of quick crashes
      // asks at most once a minute.
      if (within(updateChecked, START_CHECK_EVERY_MS) || within(updateFailed, START_CHECK_EVERY_MS) || within(updateAsked, START_CHECK_EVERY_MS)) return;
    } else {
      if (fresh && !force) return;
      if (!force && within(updateFailed, RETRY_AFTER_FAILURE_MS)) return;
    }
    asking = true;
    requests += 1;
    settings.update({ updateAsked: now() });
    try {
      const answer = await ask();
      const version = versionInAnswer(answer);
      const notes = version ? notesInAnswer(answer) : null;
      // An answer without a version (a repository with no release yet answers 404) is "nothing new", and is not
      // asked for again today either.
      settings.update({ updateChecked: now(), updateFailed: null, updateLatest: version, updateCheckedBy: current, ...(notes ? { updateNotes: { version, ...notes } } : {}) });
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
    /**
     * Asks now, whatever the last check was (one request per launch: the app calls this once, from its single
     * instance; windows and restarts of the server do not), and then once a day for as long as the app runs, or 15
     * minutes after a check that got no answer.
     */
    start() {
      if (!allowed || timer) return;
      void check({ atStart: true });
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
