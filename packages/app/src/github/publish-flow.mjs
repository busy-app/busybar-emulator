// Publish stage 2 in the app: sign in to GitHub, the person's public repository with the project's files in one
// commit, and the pull request to the apps catalog. Done here, in the main process, through GitHub CLI (gh.mjs): gh
// signs the person in, keeps the token in the system's store and makes every call; this process never holds a token.
// The page gets the person's login and nothing else.
//
// What is in the project is read and written by the command line, as in stage 1: `publish status` and `publish files`
// say what the repository holds, `publish pushed` and `publish requested` note what was done in .busy/publish.json
// and fill the manifest of submission/. This module reads the bytes of the files it pushes itself, each one inside
// the project's folder.
//
// The files pushed leave out .github/workflows/: writing them takes the scope `workflow`, which the sign-in does not
// ask for, and the catalog builds the app itself, so the template's checks are not needed in the person's repository.
//
// GitHub CLI's accounts are the person's own (gh.mjs). The window lists every account GitHub CLI on this computer has
// for github.com (gh 2.40 and later keep several) and the person chooses one; "Sign in with another account" adds one
// to GitHub CLI (gh auth login makes it GitHub CLI's active account; the app switches GitHub CLI back to the account it
// used before, so that the person's other programs go on as they were). Every call of the app's goes as the chosen
// account, with its own token for that one call (gh.mjs accountToken), whichever account GitHub CLI uses meanwhile.
// The app's note of its sign-in (github/signed-in.json in the data folder: the login, whether it was GitHub CLI's
// before or the app signed it in, and, from older versions, the account GitHub CLI had before) says whether gh may be
// asked anything, and what signing out may do: an account that was there before is only forgotten here, never signed
// out of GitHub CLI; one the app signed in is signed out of GitHub CLI only when the person ticks it. And the login
// GitHub answers for must be the one noted, or the app asks again rather than publish as someone else.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { accountToken, cleanLine, codeIsShown, CODE_TIMEOUT_MS, ghFolders, ghSettings, ghTransport, GH_HOST, LOGIN, loginFailure, loginReader, REVOKE_PAGE, SIGN_IN_TIMEOUT_MS } from "./gh.mjs";
import { blobSha, checkRepoPath, createGithubApi, noreplyAddress } from "./github-api.mjs";
import { EMAIL, localHas, localHead, localRemote, localUser } from "./local-git.mjs";
import { get as getAllowed, UPDATE_HOSTS } from "../updater.mjs";

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** What one push takes: GitHub's limit for a file, and the API module's for a push (github-api.mjs MAX_FILES). */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PUSH_FILES = 400;
const MAX_PUSH_BYTES = 200 * 1024 * 1024;
const LEFT_OUT = /^\.github\/workflows\//;
/** A release's app package: at most what the BUSY Bar takes (100 MiB, MAX_UPLOAD_FILE_SIZE). */
export const MAX_RELEASE_PACKAGE = 100 * 1024 * 1024;
/** Where a release's files may come from: github.com and the hosts its downloads are sent to, over HTTPS (updater.mjs). */
const RELEASE_ORIGINS = Object.freeze(UPDATE_HOSTS.map((host) => Object.freeze({ protocol: "https:", host })));
/** A release file's name as it is kept for the install: plain, ending in .tgz. */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}\.tgz$/i;
export const AI_CHOICES = Object.freeze(["none", "partly", "full"]);
/**
 * The catalog's template asks "Partly" and "Fully" to say what AI made and what it does (EMU-359): the person's
 * explanation, required for those two, at most MAX_AI_NOTE characters, goes into the request after the option's colon.
 */
export const AI_NOTE_CHOICES = Object.freeze(["partly", "full"]);
export const MAX_AI_NOTE = 1000;
export const aiNeedsNote = (ai) => AI_NOTE_CHOICES.includes(ai);
/**
 * BUSY's catalogs: the one the requests go to (the default, public since 12 Nov 2026), and its dev copy. A request to any other (a project's
 * catalog.json, or --catalog, may name one) is sent only when the person confirmed that catalog's name (security
 * review L3).
 */
export const BUSY_CATALOGS = Object.freeze(["busy-app/busy-apps-catalog", "busy-app/busy-apps-catalog-dev"]);
/** True for one of BUSY_CATALOGS ({ owner, name } as parseCatalog gives it). */
export const isBusyCatalog = (catalog) => Boolean(catalog) && BUSY_CATALOGS.includes(`${catalog.owner}/${catalog.name}`.toLowerCase());
/**
 * The most a catalog's checklist may hold: its boxes, and the length of one. The person reads every box before they
 * tick, in the window and in the app's dialog; a template past these is not shown and nothing is sent (L9).
 */
export const MAX_BOXES = 50;
export const MAX_BOX_LENGTH = 500;
/**
 * The catalog's pull request template, for when the catalog's own cannot be read: a copy of
 * busy-app/busy-apps-catalog's .github/PULL_REQUEST_TEMPLATE.md as of 12 Nov 2026, with the contest item of its
 * commit c792ed6b. Its checklist is the catalog's condition for authors (the lawyers'): the window shows every item as
 * it is written and sends nothing until all are ticked but the "(optional)" ones.
 */
export const BUNDLED_TEMPLATE = `# Author checklist

- [ ] I've read the [terms for authors](https://github.com/busy-app/busy-apps-catalog/blob/main/TERMS.md) and my app follows them
- [ ] I'm the author of the app or have write access to its repository
- [ ] The app builds with \`busy-cli build\`, and the lock file is committed
- [ ] The manifest follows the catalog manifest format
- [ ] I've tested the app on a BUSY Bar with the latest release firmware
- [ ] The screenshots are taken from the bar
- [ ] (optional) My app takes part in the BUSY JS Apps Contest, and I accept the [contest rules](https://go.busy.app/terms-of-js-apps-contest)

# AI usage

Keep ONE option and delete the others.

- No AI was used.
- Partly AI-assisted: which parts, and what they do.
- Fully AI-generated: what the generated code does.
`;
/** Where a repository keeps its pull request template, in the order GitHub looks. */
const TEMPLATE_FILES = [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md", "PULL_REQUEST_TEMPLATE.md", "docs/PULL_REQUEST_TEMPLATE.md"];
const AI_LINES = [/^[-*]\s+No AI was used/i, /^[-*]\s+Partly AI-assisted/i, /^[-*]\s+Fully AI-generated/i];
// The catalog writes it "Keep **one** option and delete the others." (12 Nov 2026), its first copy "Keep ONE option…".
const KEEP_ONE = /^Keep (?:\*\*|__)?one(?:\*\*|__)? option and delete the others\.?$/i;
const BOX = /^(\s*[-*]\s+)\[([ xX])\](\s+)(.*)$/;
/** An item that starts with "(optional)" may stay unticked: it is shown without the prefix, with an "Optional" tag. */
const OPTIONAL_PREFIX = /^\(optional\)\s*/i;
export const isOptionalBox = (text) => OPTIONAL_PREFIX.test(String(text));
export const boxLabel = (text) => String(text).replace(OPTIONAL_PREFIX, "") || String(text);
/** How long the token of an account is kept in memory, between the calls of one push or request. */
const TOKEN_KEEP_MS = 5 * 60_000;
const SUBMIT_HINT = "Send it by hand: the steps are in SUBMIT.md in the project's submission folder.";
/**
 * The sentence of the app's questions that names who a commit is signed by (EMU-366): `signer` as the flow gives it
 * ({ name, email, kind, private?, fallback? }), or kind "asked" for an address the command line names, checked only
 * after the person's yes.
 */
export function signerSentence(signer, { what = "The commit" } = {}) {
  const who = `${signer.name} <${signer.email}>`;
  if (signer.kind === "asked") return `${what} is to be signed ${who}, the address the program asks for: the emulator checks that it is one of your account's before anything is sent, and keeps it for the account's next commits once a commit is made with it. Anyone can see it on the commit.`;
  const why = signer.fallback === "gone" ? " The address chosen before is no longer one of your account's." : signer.fallback === "unconfirmed" ? " The address chosen before cannot be confirmed as your account's now." : "";
  if (signer.kind === "noreply") return `${what} is signed ${who}, GitHub's private address of your account: it shows no e-mail.${why}`;
  if (signer.kind === "git") return `${what} is signed ${who}, the name and address git config gives, which GitHub has not verified for your account: anyone can see them on the commit.`;
  return `${what} is signed ${who}, an address of your account: anyone can see it on the commit.${signer.private ? " GitHub keeps it private for your account, and may refuse the commit (Block command line pushes that expose my email): then the emulator says so." : ""}`;
}

/** How the person lets GitHub CLI's sign-in read the account's e-mail addresses (EMU-366): the scope user:email. */
export const GRANT_EMAILS = "gh auth refresh --hostname github.com --scopes user:email";

/**
 * stale-check: the first file of `files` (read for a push: [{ path, bytes }]) whose bytes are not the ones Pre-flight
 * check saw, by `checked`, the check's record of every file ({ path: "<size>:<sha256>" }, publish verify); null when
 * all are. A file the check did not see is changed too. Without a record (a project of more files than it lists)
 * there is nothing to compare here, and the fingerprint's own comparison stands.
 */
export function changedSinceCheck(files, checked) {
  if (!checked || typeof checked !== "object") return null;
  for (const one of files) {
    const seen = `${one.bytes.length}:${createHash("sha256").update(one.bytes).digest("hex")}`;
    if (checked[one.path] !== seen) return one.path;
  }
  return null;
}

/** A failure the window shows: what happened, and what to do. */
export class PublishError extends Error {
  constructor(code, message, hint = null) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** Why the checklist (parseChecklist) of `catalog`, "owner/name", is not shown, as a PublishError; or null (L9). */
export function checklistProblem(list, catalog) {
  const hint = `Check that ${catalog} is the catalog you mean, or send the app by hand (SUBMIT.md).`;
  if (list.boxes.length > MAX_BOXES) return new PublishError("checklist_too_long", `The checklist of ${catalog} has ${list.boxes.length} items, more than the ${MAX_BOXES} the emulator shows, so nothing is sent there.`, hint);
  const longest = list.boxes.reduce((most, one) => Math.max(most, one.length), 0);
  if (longest > MAX_BOX_LENGTH) return new PublishError("checklist_too_long", `An item of the checklist of ${catalog} is ${longest} characters long, more than the ${MAX_BOX_LENGTH} the emulator shows, so nothing is sent there.`, hint);
  return null;
}

/** The catalog as the person writes it: owner/name, or its address on github.com. Null when it is neither. */
export function parseCatalog(text) {
  const plain = String(text ?? "").trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const m = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(plain);
  if (!m || /^\.+$/.test(m[2])) return null;
  return { owner: m[1], name: m[2] };
}

// ---------------------------------------------------------------- catalog-update: repositories, versions, manifests

/**
 * A repository on github.com as the person writes it: owner/name, its address (https://github.com/owner/name, with
 * .git or a page of it after), or its SSH address on github.com. { owner, name }, or { problem } for anything else,
 * another host's address above all: only GitHub's repositories are imported.
 */
export function parseRepository(text) {
  const plain = String(text ?? "").trim();
  if (!plain) return { problem: "Paste the repository's address, or write owner/name." };
  if (plain.length > 300) return { problem: "That is not a repository's address." };
  let m = /^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(plain);
  if (!m) {
    const url = /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i.test(plain) ? plain : /^[^/\s]+\.[a-z]{2,}\//i.test(plain) ? `https://${plain}` : null;
    if (url) {
      let parsed;
      try {
        parsed = new URL(/^www\./i.test(url) ? `https://${url}` : url);
      } catch {
        return { problem: "That is not a repository's address." };
      }
      if (!["http:", "https:"].includes(parsed.protocol) || !/^(?:www\.)?github\.com$/i.test(parsed.hostname)) return { problem: "Only repositories on github.com can be imported." };
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return { problem: "The address names no repository: github.com/owner/name." };
      m = [null, parts[0], parts[1].replace(/\.git$/i, "")];
    } else m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(plain);
  }
  if (!m || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(m[1]) || !/^[A-Za-z0-9._-]{1,100}$/.test(m[2]) || /^\.+$/.test(m[2])) return { problem: "Write it as owner/name, or paste its address on github.com." };
  return { owner: m[1], name: m[2] };
}

/** -1, 0 or 1 for two versions MAJOR.MINOR.PATCH (the catalog takes no other); null when one is not such. */
export function compareVersions(a, b) {
  const parse = (v) => (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(v ?? "")) ?? null)?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/** A YAML scalar's text as the catalog's manifests write one: plain, "double" or 'single' quoted. */
function yamlScalar(raw) {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.startsWith("'")) return text.slice(1, text.lastIndexOf("'")).replace(/''/g, "'");
  return text.replace(/\s+#.*$/, "");
}

/**
 * What the catalog's manifest of an app says that an update needs: { origin, commit, subdir, changelog }. A reader
 * of the shape the catalog's manifests have (the keys of the catalog's format, scalars and literal or folded blocks),
 * not of all YAML: what it cannot read is null.
 */
export function readCatalogManifest(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = { origin: null, commit: null, subdir: null, changelog: null };
  const valueAt = (i, indent, rest) => {
    const head = rest.trim();
    const block = /^([|>])([+-]?)\s*(?:#.*)?$/.exec(head);
    const more = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === "" || lines[j].search(/\S/) > indent)) more.push(lines[j++]);
    while (more.length && more.at(-1).trim() === "") more.pop();
    if (block) {
      const cut = Math.min(...more.filter((one) => one.trim()).map((one) => one.search(/\S/)));
      const body = more.map((one) => one.slice(Number.isFinite(cut) ? cut : 0));
      return block[1] === "|" ? body.join("\n") : body.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ");
    }
    // A plain or quoted scalar may go on over the lines under it: they are one line, joined by spaces.
    return yamlScalar([head, ...more.map((one) => one.trim()).filter(Boolean)].join(" "));
  };
  lines.forEach((line, i) => {
    const m = /^( *)([A-Za-z_]+):(.*)$/.exec(line);
    if (!m) return;
    const indent = m[1].length;
    const key = m[2];
    if (indent === 0 && key === "changelog") out.changelog = valueAt(i, 0, m[3]);
    if (indent > 0 && key === "origin") out.origin = yamlScalar(m[3]);
    if (indent > 0 && key === "commit_sha") out.commit = yamlScalar(m[3]);
    if (indent > 0 && key === "subdir") out.subdir = yamlScalar(m[3]);
  });
  if (out.commit !== null && !/^[0-9a-f]{40}$/.test(out.commit)) out.commit = null;
  return out;
}

/** A text as a YAML double-quoted scalar (JSON's escapes are YAML's), as submission.mjs writes one it cannot leave plain. */
function yamlQuoted(text) {
  return JSON.stringify(text).replace(/[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** The manifest with its top-level changelog (one line, or a block under it) replaced by `changelog`. */
export function withChangelog(manifest, changelog) {
  const lines = manifest.replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((line) => /^changelog:/.test(line));
  const line = `changelog: ${yamlQuoted(changelog)}`;
  if (at < 0) {
    const before = lines.findIndex((one) => /^(screenshots|back_screenshots):/.test(one));
    lines.splice(before < 0 ? lines.length - (lines.at(-1) === "" ? 1 : 0) : before, 0, line);
    return lines.join("\n");
  }
  let end = at + 1;
  while (end < lines.length && (lines[end] === "" ? end + 1 < lines.length && /^\s/.test(lines[end + 1]) : /^\s/.test(lines[end]))) end++;
  lines.splice(at, end - at, line);
  return lines.join("\n");
}

/** What the catalog takes as a changelog (its rules, readiness/rules.mjs): null when it does, else what is wrong. */
export function changelogProblem(text) {
  const plain = String(text ?? "").trim();
  if (!plain) return "Write what's new in this version.";
  if ([...plain].length < 10) return "What's new takes at least 10 characters.";
  if ([...plain].length > 4000) return "What's new takes at most 4000 characters.";
  if (plain.startsWith("@")) return "What's new may not start with @: the catalog takes no file there.";
  return null;
}

/** A path of a repository that a folder on this computer can hold as it is; null when it can, else why not. */
function pathProblem(rel, platform = process.platform) {
  try {
    checkRepoPath(rel);
  } catch {
    return "not a plain relative path";
  }
  const parts = rel.split("/");
  if (parts.some((part) => part.toLowerCase() === ".git")) return "inside a .git folder";
  if (platform === "win32" && parts.some((part) => /[<>:"|?*\u0000-\u001f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(part) || /[. ]$/.test(part))) return "a name Windows does not take";
  return null;
}

/**
 * A pull request template read for the window: its parts in order ({ kind: "heading", level, text }, { kind: "box",
 * text } for a "- [ ]" item, { kind: "ai", options: [{ id, text, prompt }] } for the AI usage lines (`prompt`: what
 * "Partly" and "Fully" ask the person to explain, aiPrompt), { kind: "instruction",
 * text } for "Keep ONE option…", { kind: "item" | "text", text }), `boxes`: the text of every box, as written, `required`: the boxes that are not optional (a text starting with
 * "(optional)" is, and may stay unticked; its block has `optional` and `label`, the text without the prefix), and
 * `ai`: the AI usage options found. HTML comments are not shown.
 */
export function parseChecklist(markdown) {
  const text = String(markdown ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [];
  const boxes = [];
  let aiBlock = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      blocks.push({ kind: "heading", level: m[1].length, text: m[2].trim() });
      aiBlock = null;
    } else if ((m = BOX.exec(line))) {
      const said = m[4].trim();
      if (!boxes.includes(said)) boxes.push(said);
      blocks.push(isOptionalBox(said) ? { kind: "box", text: said, optional: true, label: boxLabel(said) } : { kind: "box", text: said, optional: false, label: said });
      aiBlock = null;
    } else if (AI_LINES.some((re) => re.test(line))) {
      if (!aiBlock) blocks.push((aiBlock = { kind: "ai", options: [] }));
      const id = AI_CHOICES[AI_LINES.findIndex((re) => re.test(line))];
      const said = line.replace(/^[-*]\s+/, "");
      aiBlock.options.push({ id, text: said, prompt: aiNeedsNote(id) ? aiPrompt(said) : null });
    } else if (KEEP_ONE.test(line)) {
      blocks.push({ kind: "instruction", text: line });
    } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
      blocks.push({ kind: "item", text: m[1].trim() });
      aiBlock = null;
    } else {
      blocks.push({ kind: "text", text: line });
      aiBlock = null;
    }
  }
  return { blocks, boxes, required: boxes.filter((one) => !isOptionalBox(one)), ai: blocks.find((one) => one.kind === "ai")?.options ?? [] };
}

/**
 * The person's questions before a request asked by the command line (busy-emulator publish pr), as main.mjs puts them
 * to the person (person-question.mjs confirm): the first names the catalog, the repository, the commit, the AI usage
 * and every box of the checklist (`list`, checklist()), with one tick for all of them. A catalog that is not BUSY's is
 * said in the first question's own words and at the head of its text, and a second question asks about it by its
 * name (security review L3). `catalog`: { owner, name }; `target`: the repository and commit the request names.
 * The optional items are asked between the two, one question each (optionalQuestions). `signer`: who the manifest's
 * commit is signed by (EMU-366), named in the first.
 */
export function requestQuestions({ folder, catalog, target, ai, aiNote = null, list, signer = null }) {
  const named = `${catalog.owner}/${catalog.name}`;
  const other = !isBusyCatalog(catalog);
  const warning = other ? `${named} is not BUSY's catalog (${BUSY_CATALOGS[0]}). The project's catalog.json or the command names it; whoever keeps ${named} gets the request, from your GitHub account.\n\n` : "";
  const note = aiNeedsNote(ai) ? aiNoteLine(aiNote) : "";
  const usage = `${{ none: "no AI was used", partly: "partly AI-assisted", full: "fully AI-generated" }[ai] ?? "not said"}${note ? `. The explanation the request gives: "${note}"` : ""}`;
  const optional = list.boxes.some(isOptionalBox);
  const boxes = list.boxes.map((one) => `[ ] ${isOptionalBox(one) ? "Optional, you choose next: " : ""}${plainBox(one)}`).join("\n");
  const first = {
    about: `publish pr ${folder}`,
    message: other ? `Send this app to ${named}, which is not BUSY's catalog?` : "Send this app to the catalog?",
    detail: `${warning}${folder}\n\nA program on this computer (busy-emulator publish pr, most likely your coding agent) asks to open a pull request to the catalog ${named} from your GitHub account, naming github.com/${target.owner}/${target.name} at ${target.commit.slice(0, 12)}. AI usage: ${usage}.${signer ? `\n\n${signerSentence(signer, { what: "The commit of the app's manifest" })}` : ""}\n\nThe catalog's author checklist${list.source === "bundled" ? " (the copy that comes with the emulator: the catalog's own could not be read)" : ""}:\n${boxes}`,
    // With optional items, the person ticks them in the questions that follow (optionalQuestions): this one goes on.
    buttons: ["Cancel", optional ? "Continue" : "Send"],
    yes: 1,
    checkboxLabel: optional ? "Every item of the checklist above is true, except the optional ones" : "Every item of the checklist above is true",
  };
  if (!other) return [first];
  const second = {
    about: `publish pr ${folder} to ${named}`,
    message: `Send the request to ${named}?`,
    detail: `${named} is not BUSY's catalog. Apps for BUSY Bar go to ${BUSY_CATALOGS[0]}. Send it to ${named} only if you know who keeps it and want your app there.`,
    buttons: ["Cancel", `Send to ${named}`],
    yes: 1,
  };
  return [first, second];
}

/** A box's text as a dialog of the system's shows it: no prefix, a link as its text and address, no backticks. */
const plainBox = (text) => boxLabel(text).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/`/g, "");

/**
 * The questions of publish pr after the first (requestQuestions), one for each optional item of the checklist
 * (EMU-313): the item, and a checkbox for it, unticked. A dialog of the system's holds one checkbox, so each item has
 * its own question. Only the person's tick in that dialog ticks the item; no option of the command line does. Cancel
 * sends nothing, as in the first. `more`: another question follows the last (a catalog that is not BUSY's, asked by
 * its name), so its button is Continue, not Send. Each question carries `box`, the item's text as written: the request
 * ticks it when the dialog's checkbox is ticked.
 */
export function optionalQuestions({ folder, list, more = false }) {
  const optional = list.boxes.filter(isOptionalBox);
  return optional.map((box, at) => {
    const sends = at === optional.length - 1 && !more;
    return {
      about: `publish pr ${folder}: optional item ${at + 1} of ${optional.length}`,
      message: optional.length > 1 ? `Tick optional item ${at + 1} of ${optional.length} of the checklist?` : "Tick the checklist's optional item?",
      detail: `${plainBox(box)}\n\nThe catalog's author checklist marks this item optional. Tick it only if it is true for you; the pull request then shows it ticked. ${sends ? "Send sends the request" : "Continue goes on"}, ticked or not; Cancel sends nothing.`,
      buttons: ["Cancel", sends ? "Send" : "Continue"],
      yes: 1,
      checkboxLabel: "Tick this item",
      box,
    };
  });
}

/**
 * publish pr's questions put to the person, in their order (EMU-313): the first (requestQuestions), whose one tick
 * covers the required items; then one for each optional item (optionalQuestions); then, for a catalog that is not
 * BUSY's, the one that names it. `confirm`: person-question.mjs's confirm. Resolves with { answer: "yes", ticked }
 * (requestTicks: the boxes to tick) or { answer: "no" | "unavailable" | "not_ticked", reason?, other } where `other`
 * says the question about the other catalog was the one refused; nothing is sent then.
 */
export async function askRequest({ confirm, folder, catalog, target, ai, aiNote = null, list, signer = null }, signal) {
  const [first, other] = requestQuestions({ folder, catalog, target, ai, aiNote, list, signer });
  const asked = await confirm(first, signal);
  if (asked.answer !== "yes") return { answer: asked.answer, reason: asked.reason, other: false };
  if (!asked.checked) return { answer: "not_ticked", other: false };
  const chosen = [];
  for (const one of optionalQuestions({ folder, list, more: Boolean(other) })) {
    const { box, ...question } = one;
    const said = await confirm(question, signal);
    if (said.answer !== "yes") return { answer: said.answer, reason: said.reason, other: false };
    if (said.checked) chosen.push(box);
  }
  if (other) {
    const again = await confirm(other, signal);
    if (again.answer !== "yes") return { answer: again.answer, reason: again.reason, other: true };
  }
  return { answer: "yes", ticked: requestTicks(list, chosen), other: Boolean(other) };
}

/**
 * The boxes a request from publish pr ticks: every required item, which the first question's one tick covers, and the
 * optional ones the person ticked in their own questions (`chosen`, their texts); nothing else.
 */
export function requestTicks(list, chosen = []) {
  const picked = new Set(chosen);
  return [...list.required, ...list.boxes.filter((one) => isOptionalBox(one) && picked.has(one))];
}

/**
 * The person's explanation of the AI usage as one line of text: control and direction characters, line breaks and
 * HTML comment marks become spaces, runs of space one (EMU-359). This is what the dialog shows and the length counts.
 */
export function aiNoteLine(text) {
  return maskTokens(
    String(text ?? "")
      .replace(/<!--|-->/g, " ")
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

/**
 * A text with what looks like a token masked, as gh.mjs cleanLine masks gh's output: GitHub's tokens by their prefix
 * (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_) and any run of 36 letters, digits and underscores, each as "…". The
 * explanation is kept in the project and goes into a public pull request: a token pasted into it goes nowhere.
 */
export function maskTokens(text) {
  return String(text ?? "")
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/g, "…")
    .replace(/[A-Za-z0-9_]{36,}/g, "…");
}

/**
 * The explanation as the request's text has it (EMU-359): one line (aiNoteLine) of plain text. Markdown's own marks
 * (\ ` * _ [ ] ( ) ! | ~) escaped with a backslash: no emphasis, code, link or picture (a picture would load from
 * anywhere through GitHub's proxy); &, < and > as entities: no HTML, no comment that hides the rest of the template.
 * What GitHub links in plain text broken by a zero-width space (as Renovate writes it): every @ not after a letter or
 * digit (no one is notified, an address stays; @@x too), every # and GH- before a number (no reference to an issue
 * or a pull request, here or elsewhere), and the start of an address (http://, www.). It follows the option's colon, so nothing it starts with
 * begins a line.
 */
export function plainAiNote(text) {
  const zw = "&#8203;";
  return aiNoteLine(text)
    .replace(/[\\`*_[\]()!|~]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/#/g, `#${zw}`)
    .replace(/(?<![A-Za-z0-9])@/g, `@${zw}`)
    .replace(/\bGH-(?=\d)/gi, (m) => `${m.slice(0, 3)}${zw}`)
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*):\/\//g, `$1${zw}://`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${zw}.`);
}

/** Why the explanation does not go with the AI choice `ai`, as a PublishError; or null. */
export function aiNoteProblem(ai, note) {
  if (!aiNeedsNote(ai)) return null;
  const line = aiNoteLine(note);
  if (!line) return new PublishError("no_ai_note", `Explain the AI usage: the catalog asks ${ai === "full" ? "what the generated code does" : "which parts AI made, and what they do"}.`, null);
  if (line.length > MAX_AI_NOTE) return new PublishError("ai_note_too_long", `The explanation of the AI usage is ${line.length} characters long; the emulator sends up to ${MAX_AI_NOTE}.`, null);
  return null;
}

/**
 * What an AI option of the template asks the person to write: its words after the colon, from a capital, without the
 * full stop ("Describe what the generated code does"); null for an option that asks nothing.
 */
export function aiPrompt(text) {
  const m = /:\s*(.+?)\.?\s*$/.exec(String(text ?? ""));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)}` : null;
}

/** The kept AI line of the template with the person's explanation in place of what the option asks (EMU-359). */
function withAiNote(line, note) {
  const said = plainAiNote(note);
  if (!said) return line;
  const m = /^(\s*[-*]\s+[^:]*?):/.exec(line);
  return m ? `${m[1]}: ${said}` : `${line.replace(/[.\s]+$/, "")}: ${said}`;
}

/**
 * The pull request's description: the catalog's template with the boxes the person ticked (`ticked`, their texts)
 * ticked, its instruction to keep one AI option done, and the one AI line kept, with the person's explanation
 * (`aiNote`) after its colon for "Partly" and "Fully".
 */
export function fillTemplate(template, { ai, aiNote = null, ticked = [], testing = null }) {
  const note = aiNeedsNote(ai) ? aiNote : null;
  const keep = AI_LINES[AI_CHOICES.indexOf(ai)];
  const tick = new Set(ticked);
  const lines = [];
  let hadAi = false;
  for (const line of template.replace(/\r\n/g, "\n").split("\n")) {
    const box = BOX.exec(line);
    if (box && tick.has(box[4].trim())) {
      lines.push(`${box[1]}[x]${box[3]}${box[4]}`);
      continue;
    }
    if (KEEP_ONE.test(line.trim())) continue;
    if (AI_LINES.some((re) => re.test(line.trim()))) {
      hadAi = true;
      if (!keep?.test(line.trim())) continue;
      lines.push(withAiNote(line, note));
      continue;
    }
    lines.push(line);
  }
  let body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  if (!hadAi && keep) body += `\n\n# AI usage\n\n${withAiNote(BUNDLED_TEMPLATE.split("\n").find((line) => keep.test(line)), note)}`;
  if (testing) body += `\n\n# Device testing\n\n${testing.trim()}`;
  return `${body}\n`;
}

/**
 * @param {object} o
 * @param {{ run: Function } | null} o.gh   gh.mjs ghRunner for the app's gh; null in a build without one
 * @param {string} o.dataDir                the app's data folder: gh's own folders and the note of the sign-in
 * @param {string} [o.configDir]            GitHub CLI's configuration folder (the person's): the names of its accounts
 * @param {object} [o.record]               publish-record.mjs: what this app published, in its own data folder
 * @param {(url: string) => void} o.openExternal   opens an address of github.com in the person's browser
 * @param {(line: string) => void} [o.log]
 * @param {(ms: number) => Promise<void>} [o.sleep]   the API's waits (tests make them short)
 * @param {string[]} [o.catalogs]           the catalogs a request goes to without naming them again: BUSY_CATALOGS
 * @param {{ origins: { protocol: string, host: string }[], transports?: object }} [o.downloads]  where a release's app
 *   package may be downloaded from (RELEASE_ORIGINS: github.com's, over HTTPS); a test names its stand-in on 127.0.0.1
 * @param {{ home: string | null, xdg: string | null }} [o.git]  where the person's own git settings are (~/.gitconfig,
 *   $XDG_CONFIG_HOME/git/config): the name and address `git config` gives, offered for commits (EMU-366); main.mjs
 *   names them (config.mjs), without them only the project's own .git/config is read
 * @param {() => number} [o.clock]          how long what GitHub said of the account is kept (a test's own clock)
 */
export function createGithubPublish({ gh, dataDir, configDir = null, record = null, openExternal, log = () => {}, sleep, writeGapMs, forkWait, catalogs = BUSY_CATALOGS, downloads = null, git = { home: null, xdg: null }, clock = Date.now }) {
  const releaseOrigins = downloads?.origins ?? RELEASE_ORIGINS;
  const releaseTransports = downloads?.transports ?? { http, https };
  /** One of the catalogs a request goes to without a second confirmation: BUSY_CATALOGS (tests name their stand-ins). */
  const knownCatalog = (catalog) => Boolean(catalog) && catalogs.some((one) => one.toLowerCase() === `${catalog.owner}/${catalog.name}`.toLowerCase());
  const folders = ghFolders(dataDir);
  const noteFile = path.join(folders.root, "signed-in.json");
  /** The address each account signs its commits with, as the person chose it (EMU-366): the app's, never a project's. */
  const signerFile = path.join(folders.root, "commit-email.json");
  let login = null;
  let signing = null; // { shown, abort, done }
  let starting = null; // the sign-in that is starting: its code to come
  let startingAbort = null;
  let lastFailure = null;
  let pushing = null; // the push or request under way: its AbortController, for Cancel
  /** login → { token, at }: the token of a chosen account, for the calls of a few minutes; in memory only. */
  const tokens = new Map();
  const templates = new Map(); // "owner/name" → the template the person was shown
  const apiOptions = { ...(sleep ? { sleep } : {}), ...(writeGapMs !== undefined ? { writeGapMs } : {}) };

  /** The token of `who`, from GitHub CLI (gh auth token --user), kept a few minutes; or { failure }. */
  async function tokenOf(who) {
    if (!who) return { failure: "no_account", detail: "no account chosen" };
    const kept = tokens.get(who.toLowerCase());
    if (kept && Date.now() - kept.at < TOKEN_KEEP_MS) return kept.token;
    // GitHub CLI's active account may have its token only as the active one (a configuration of gh 2.39 and older).
    const active = ghSettings(configDir).user;
    const got = await accountToken(gh.run, who, { active: Boolean(active) && active.toLowerCase() === who.toLowerCase() });
    if (typeof got === "string") tokens.set(who.toLowerCase(), { token: got, at: Date.now() });
    return got;
  }
  /** GitHub's API as `who`: every call with that account's token. */
  const apiAs = (who) => createGithubApi({ transport: ghTransport(gh.run, { token: () => tokenOf(who) }), ...apiOptions });
  /**
   * The API of each chosen account, made once: its pace of writes is GitHub's limit for that person. The calls go as
   * the account chosen here (noted), never "whichever GitHub CLI uses now"; a push or a request takes the API of the
   * account signed in at its start and keeps it to its end, whatever is chosen meanwhile (security review L4).
   */
  const apis = new Map();
  const apiOf = (who) => {
    const key = who.toLowerCase();
    if (!apis.has(key)) apis.set(key, apiAs(who));
    return apis.get(key);
  };
  const configured = Boolean(gh);

  /** A failure of GitHub's or of gh's in the window's words. */
  function human(e, about = {}) {
    if (e instanceof PublishError) return e;
    const when = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    switch (e?.code) {
      case "not_configured":
        return new PublishError("not_configured", "GitHub CLI is not in this build, so it cannot sign in to GitHub.", SUBMIT_HINT);
      case "expired":
        return new PublishError("expired", "The code has expired.", "Get a new code and enter it on GitHub.");
      case "denied":
        return new PublishError("denied", "The sign-in was canceled on GitHub.", "Sign in again when you want to publish.");
      case "canceled":
        return new PublishError("canceled", "The sign-in was stopped.", null);
      case "no_account":
        return new PublishError("account_gone", `GitHub CLI on this computer has no sign-in for ${about.login ?? "that account"} any more.`, "Choose an account again.");
      case "keyring_refused":
        return new PublishError("keyring_refused", "The system's password store did not take the sign-in, so it was not kept.", process.platform === "darwin" ? "Unlock the login keychain in Keychain Access, then sign in again." : "Check that Credential Manager works for your account, then sign in again.");
      case "changed_outside":
        return new PublishError("changed_outside", "GitHub CLI on this computer was switched to another account outside the emulator.", "Sign in again: choose the account to publish with.");
      case "gh_settings_newer":
        return new PublishError("gh_settings_newer", "GitHub CLI on this computer keeps its settings in a newer format than the emulator's copy of it knows, so the emulator does not sign in to it.", "Sign in with your GitHub CLI in a terminal (gh auth login), then choose that account here; or update the emulator.");
      case "gh_settings_single":
        return new PublishError("gh_settings_single", `GitHub CLI on this computer keeps its settings in the format of an old version, which holds one account${about.login ? `, ${about.login}` : ""}: signing in another one here would sign ${about.login ?? "it"} out of GitHub CLI.`, `Use ${about.login ?? "that account"} here. To add another account, update GitHub CLI and sign in again as ${about.login ?? "it"} in a terminal (gh auth login), then come back.`);
      case "no_existing":
        return new PublishError("no_existing", "GitHub CLI on this computer is not signed in to GitHub.", "Sign in to GitHub.");
      case "unauthorized":
        return new PublishError("unauthorized", "GitHub no longer accepts your sign-in.", "Sign in again.");
      case "rate_limited":
        return new PublishError("rate_limited", "GitHub's limit of requests is reached for now.", e.retryAt ? `Try again after ${when(e.retryAt)}.` : "Try again in a few minutes.");
      case "name_taken":
        return new PublishError("name_taken", `You have a repository named ${about.name ?? "so"} already.`, about.free ? `Choose another name: ${about.free} is free.` : "Choose another name.");
      case "catalog_closed":
        return new PublishError("catalog_closed", "The catalog repository cannot be seen (it is private, or not there), so a request can't be sent.", "Check its address and try again, or send it by hand (SUBMIT.md).");
      case "catalog_empty":
        return new PublishError("catalog_empty", "The catalog repository has no files yet, so there is nothing to add the app to.", "Try again when it has, or send it by hand (SUBMIT.md).");
      case "fork_not_allowed":
        return new PublishError("fork_not_allowed", "The catalog repository can't be forked, so a request can't be sent from your account.", "Send it by hand (SUBMIT.md).");
      case "fork_pending":
        return new PublishError("fork_pending", "GitHub is still making your copy of the catalog.", "Try again in a minute.");
      case "not_landed":
        return new PublishError("not_landed", "GitHub does not hold the files that were sent.", "Publish again.");
      case "too_many_files":
        return new PublishError("too_many_files", "The project has more files than one upload takes.", "Keep large or generated folders out in Repository files.");
      case "bad_path":
        return new PublishError("bad_path", `GitHub cannot take a file: ${String(e.message).slice(0, 200)}.`, "Rename it, or keep it out in Repository files.");
      case "unprocessable": {
        const said = (e.details?.errors ?? []).map((one) => one?.message ?? one?.code).filter(Boolean)[0];
        return new PublishError("unprocessable", `GitHub did not take it${said ? `: ${String(said).slice(0, 200)}` : ""}.`, "Try again in a moment; if it says the same, send it by hand (SUBMIT.md).");
      }
      case "network":
        return new PublishError("network", "GitHub could not be reached.", "Check the internet connection, then try again.");
      case "timeout":
        return Object.assign(new PublishError("timeout", "GitHub did not answer in time.", e.details?.write ? "It may have been done all the same: check again before anything else." : "Try again in a moment."), { write: e.details?.write === true });
      case "gh_failed":
        return new PublishError("gh_failed", "GitHub CLI, which the emulator talks to GitHub through, did not run.", "Quit the emulator and open it again; if it says the same, install it again.");
      case "token_unreadable":
        return new PublishError("token_unreadable", "GitHub CLI could not give the emulator your sign-in.", "Sign in again.");
      case "forbidden":
        return new PublishError("forbidden", "GitHub refused it.", "Sign out, sign in again, then try once more.");
      case "email_private":
        // Never the address itself: the answer goes to the window and to the command line's caller (EMU-366). The
        // address is no longer the account's choice (afterCommit): the next commit gets the private address.
        return new PublishError("email_private", "GitHub refused the commit: your account keeps the e-mail address it is signed with private, and blocks commits that would show it. The emulator does not sign with that address again unless you choose it.", "Sign the commits with GitHub's private address (Sign commits with, in Publish to GitHub; or publish push --email noreply), then publish again.");
      case "email_refused":
        // GitHub's words about a private address for a commit signed with the private address itself: not the address.
        return new PublishError("email_refused", "GitHub refused the commit with words about a private e-mail address, though it is signed with GitHub's private address of your account.", "Try again in a moment; if GitHub says the same, send it by hand (SUBMIT.md).");
      default:
        log(`[github] ${e?.code ?? "error"}: ${String(e?.message ?? e).slice(0, 300)}`);
        return new PublishError(e?.code ?? "failed", "GitHub answered something unexpected.", "Try again in a moment.");
    }
  }

  // ---------------------------------------------------------------- the app's note of its sign-in

  /**
   * The note, stale or not: { login, origin: "existing" | "app", previous, stale }, or null. A note that is not one
   * (edited by hand) is none. A stale note (GitHub refused the sign-in, or another account answered) is no sign-in,
   * but keeps what signing out needs to know: whether GitHub CLI had the account, and which one it had before (F5).
   */
  function noteOf() {
    try {
      const note = JSON.parse(readFileSync(noteFile, "utf8"));
      if (!LOGIN.test(note?.login ?? "") || !["existing", "app"].includes(note.origin)) return null;
      return { login: note.login, origin: note.origin, previous: LOGIN.test(note.previous ?? "") ? note.previous : null, stale: note.stale === true };
    } catch {
      return null;
    }
  }

  /** The note of a sign-in that holds: not stale. */
  function noted() {
    const note = noteOf();
    return note && !note.stale ? note : null;
  }

  function note({ login: who, origin, previous = null, stale = false }) {
    mkdirSync(folders.root, { recursive: true });
    const part = `${noteFile}.${process.pid}.part`;
    writeFileSync(part, `${JSON.stringify({ login: who, origin, previous, host: GH_HOST, at: new Date().toISOString(), ...(stale ? { stale: true } : {}) })}\n`, { mode: 0o600 });
    renameSync(part, noteFile);
  }

  /** The sign-in no longer holds: the note is kept, marked stale. */
  function markStale() {
    login = null;
    tokens.clear();
    const mine = noteOf();
    if (mine) note({ ...mine, stale: true });
  }

  /**
   * What a new sign-in as `who` notes: as worked out now, unless a stale note of the same account knows better (the
   * app had signed that account in to GitHub CLI before: it stays the app's, with the account GitHub CLI had then, or
   * the one it has now when the note had none).
   */
  function renewed(who, now) {
    const old = noteOf();
    return old?.stale && old.login.toLowerCase() === who.toLowerCase() ? { login: who, origin: old.origin, previous: old.previous ?? now.previous ?? null } : { login: who, ...now };
  }

  /** Forgets the sign-in here: the app's note only. GitHub CLI and its accounts are left as they are. */
  function forget() {
    login = null;
    tokens.clear();
    rmSync(noteFile, { force: true });
  }

  /**
   * The GitHub login a new app's id is made from (Create app: app.<login>.<app>), from files alone (no gh, no network):
   * the account signed in here, else the one GitHub CLI uses; null when neither.
   */
  function knownLogin() {
    return noted()?.login ?? ghSettings(configDir).user ?? null;
  }

  /**
   * The account GitHub CLI on this computer is signed in as, from its configuration (no secret, no network), or null.
   */
  async function cliAccount() {
    if (!gh) return null;
    const out = await gh.run(["config", "get", "--host", GH_HOST, "user"], { timeoutMs: 15_000 });
    const who = out.code === 0 ? out.stdout.toString("utf8").trim() : "";
    return LOGIN.test(who) ? who : null;
  }

  /**
   * The names of GitHub CLI's accounts for github.com, from its hosts.yml: the keys under github.com's `users`, and
   * nothing else of the file is kept (with plain-text storage it holds tokens). An empty list when there is none.
   */
  function cliAccountNames() {
    if (!configDir) return [];
    let text;
    try {
      text = readFileSync(path.join(configDir, "hosts.yml"), "utf8");
    } catch {
      return [];
    }
    const names = [];
    let inHost = false;
    let inUsers = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\S/.test(line)) {
        inHost = /^(["']?)github\.com\1:\s*$/.test(line);
        inUsers = false;
        continue;
      }
      if (!inHost) continue;
      const key = /^ {4}(\S[^:]*):/.exec(line);
      if (key) {
        inUsers = key[1] === "users";
        continue;
      }
      const user = /^ {8}(["']?)([A-Za-z0-9-]+)\1:/.exec(line);
      if (inUsers && user && LOGIN.test(user[2])) names.push(user[2]);
    }
    text = null;
    return names;
  }

  /**
   * The signed-in person's GitHub API and login. `fresh`: GitHub is asked who it is now even when it said so before —
   * for every push and request, as GitHub CLI can be switched to another account outside the app at any time (F2).
   */
  async function signedIn({ fresh = false } = {}) {
    if (!configured) throw human({ code: "not_configured" });
    const mine = noted();
    if (!mine) throw new PublishError("not_signed_in", "Sign in to GitHub first.", null);
    if (!login || fresh) {
      let who;
      try {
        who = (await apiOf(mine.login).user()).login;
      } catch (e) {
        if (e.code === "unauthorized" || e.code === "no_account") markStale();
        throw human(e, { login: mine.login });
      }
      if (who.toLowerCase() !== mine.login.toLowerCase()) {
        log("[github] GitHub CLI answers for another account than the one noted: the sign-in here is stale");
        markStale();
        throw human({ code: "changed_outside" });
      }
      login = who;
    }
    return { github: apiOf(login), login };
  }

  // ---------------------------------------------------------------- the address commits are signed with (EMU-366)
  //
  // Every commit the app makes (the person's repository, the manifest in their fork of the catalog) names its author
  // and committer: by default GitHub's private address of the account, <id>+<login>@users.noreply.github.com, which
  // shows no e-mail and is the account's on GitHub; or an address the person chose, one GitHub has verified for the
  // account (GET /user/emails, which takes the scope user:email that GitHub CLI's sign-in does not ask for), or the
  // one `git config user.email` gives, which GitHub may not know. The name is the account's on GitHub, else its login;
  // git config's name only with git config's address, which the person picked with it. The choice is the account's,
  // by its number (a login can be renamed and taken again), kept in the app's data folder (github/commit-email.json),
  // never in a project, which may be published; signing out forgets it. A recorded address the account no longer has
  // is dropped, and one that cannot be confirmed now is not used: the commit gets the private address, and the answer
  // says why (`fallback`). An address publish push --email names is recorded only once a commit was made with it, and
  // one GitHub refused (GH007) is never the default. No address is logged.

  /** "id:<number>" → { login, email: "noreply" } or { login, email, kind: "verified" | "git", name? }; {} when none. */
  function signerChoices() {
    try {
      const all = JSON.parse(readFileSync(signerFile, "utf8"));
      return all && typeof all === "object" && !Array.isArray(all) ? all : {};
    } catch {
      return {};
    }
  }
  function writeChoices(all) {
    mkdirSync(folders.root, { recursive: true });
    const part = `${signerFile}.${process.pid}.part`;
    writeFileSync(part, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(part, signerFile);
  }
  const choiceKey = (profile) => `id:${profile.id}`;
  /** Records `signer` ({ email, kind, name }) as the account's choice; the private address is recorded as "noreply". */
  function noteSigner(profile, signer) {
    const choice = signer.kind === "noreply" ? { login: profile.login, email: "noreply" } : { login: profile.login, email: signer.email, kind: signer.kind, ...(signer.kind === "git" ? { name: signer.name } : {}) };
    writeChoices({ ...signerChoices(), [choiceKey(profile)]: choice });
  }
  /** Forgets the account's choice: by its number, and every record of its login (signing out). */
  function forgetSigner({ profile = null, login: who = null }) {
    const all = signerChoices();
    const keep = Object.fromEntries(Object.entries(all).filter(([key, one]) => !(profile && key === choiceKey(profile)) && !(who && String(one?.login ?? "").toLowerCase() === who.toLowerCase())));
    if (Object.keys(keep).length !== Object.keys(all).length) writeChoices(keep);
  }

  /**
   * What GitHub says of the account, kept a minute: { profile, emails | null (no scope) }. `fresh` (Check again, after
   * the person let GitHub CLI read the addresses) asks again, but not twice in five seconds: the window may ask freely.
   */
  const accountFacts = new Map();
  async function factsOf(github, who, { fresh = false } = {}) {
    const key = who.toLowerCase();
    const kept = accountFacts.get(key);
    if (kept && clock() - kept.at < (fresh ? 5_000 : 60_000)) return kept;
    const profile = await github.user();
    if (!profile.id) throw new PublishError("bad_answer", "GitHub did not say the account's number, which its private address is made of.", "Try again in a moment.");
    let emails = null;
    try {
      emails = await github.emails();
    } catch (e) {
      if (e.code !== "no_scope") throw e;
    }
    const facts = { at: clock(), profile, emails };
    accountFacts.set(key, facts);
    return facts;
  }

  /**
   * The addresses the account may sign with, the private one first: [{ email, kind: "noreply" | "verified" | "git",
   * primary?, private?, name? }]. `private`: GitHub keeps it private for the account (it may refuse a commit with it);
   * `name`: git config's name, which goes with git config's address.
   */
  function offered({ profile, emails }, folder) {
    const out = [{ email: noreplyAddress(profile), kind: "noreply" }];
    const seen = new Set([out[0].email.toLowerCase()]);
    const add = (one) => {
      if (!EMAIL.test(one.email) || seen.has(one.email.toLowerCase())) return;
      seen.add(one.email.toLowerCase());
      out.push(one);
    };
    // Without the scope, the profile's public address is still one GitHub verified.
    for (const one of emails ?? (profile.email ? [{ email: profile.email, primary: false }] : [])) add({ email: one.email, kind: "verified", ...(one.primary ? { primary: true } : {}), ...(one.visibility === "private" ? { private: true } : {}) });
    const local = localUser(folder, git ?? {});
    if (local.email) add({ email: local.email, kind: "git", ...(local.name ? { name: local.name } : {}) });
    return out;
  }

  /** The signer of one offered address: the account's name (or login); git config's own name with git config's address. */
  const signerAs = (profile, one) => ({ name: one.kind === "git" && one.name ? one.name : (profile.name ?? profile.login), email: one.email, kind: one.kind, ...(one.private ? { private: true } : {}) });

  /**
   * The name and address the account's commits get: { name, email, kind, private?, fallback? }. `wanted`: "noreply" or
   * an address, for this time (publish push --email); else the recorded choice. A recorded address the account no
   * longer lists is dropped (`fallback: "gone"`); one that cannot be confirmed now (the addresses cannot be read, or
   * git config gives another) is not used (`fallback: "unconfirmed"`): the private address, either way.
   */
  function signerOf(facts, folder, wanted = null) {
    const { profile } = facts;
    const all = offered(facts, folder);
    if (wanted !== null) {
      const one = wanted === "noreply" ? all[0] : all.find((o) => o.email.toLowerCase() === String(wanted).toLowerCase());
      if (!one) {
        const hint = facts.emails === null ? "GitHub CLI's sign-in may not read the account's e-mail addresses: the person grants it in a terminal (gh auth refresh -h github.com -s user:email), or chooses in Publish to GitHub. Without it: --email noreply, or the address git config user.email gives." : "Use --email noreply (GitHub's private address of the account), or ask the person to choose under Sign commits with in Publish to GitHub.";
        throw new PublishError("email_not_offered", "The commit was not made: that address is not one the account can sign commits with (neither one GitHub has verified for the account nor the one git config user.email gives).", hint);
      }
      return signerAs(profile, one);
    }
    const recorded = signerChoices()[choiceKey(profile)];
    if (recorded && recorded.email !== "noreply" && typeof recorded.email === "string") {
      const one = all.find((o) => o.kind === recorded.kind && o.email.toLowerCase() === recorded.email.toLowerCase());
      if (one) return signerAs(profile, recorded.kind === "git" && recorded.name ? { ...one, name: recorded.name } : one);
      const gone = recorded.kind === "verified" && facts.emails !== null;
      if (gone) forgetSigner({ profile });
      return { ...signerAs(profile, all[0]), fallback: gone ? "gone" : "unconfirmed" };
    }
    return signerAs(profile, all[0]);
  }

  /**
   * For the window's Sign commits with: { login, signer, offered, scope, grant }. `scope`: whether the sign-in may read
   * the account's e-mail addresses; `grant`: the command that lets it. The person's own window alone gets the list.
   */
  async function signers({ folder = null, fresh = false } = {}) {
    const { github, login: me } = await signedIn();
    let facts;
    try {
      facts = await factsOf(github, me, { fresh });
    } catch (e) {
      throw human(e, { login: me });
    }
    return { login: me, signer: signerOf(facts, folder), offered: offered(facts, folder), scope: facts.emails !== null, grant: GRANT_EMAILS };
  }

  /** Sign commits with, the person's choice in the window: "noreply" or one of the offered addresses, for the account. */
  async function chooseSigner({ email, folder = null }) {
    if (typeof email !== "string" || (email !== "noreply" && !EMAIL.test(email))) throw new PublishError("usage", "Choose noreply or one of the addresses offered.", null);
    const { github, login: me } = await signedIn();
    let facts;
    try {
      facts = await factsOf(github, me);
    } catch (e) {
      throw human(e, { login: me });
    }
    const chosen = signerOf(facts, folder, email);
    noteSigner(facts.profile, chosen);
    log(`[github] commits of ${me} are signed with ${chosen.kind === "noreply" ? "GitHub's private address" : chosen.kind === "git" ? "git config's address" : "a verified address"} now`);
    return { login: me, signer: chosen };
  }

  /** The signer of a push or a request as `session`, and its facts: { signer, profile }. Nothing is recorded here. */
  async function signerFor(session, folder, wanted = null) {
    let facts;
    try {
      facts = await factsOf(session.github, session.login);
    } catch (e) {
      throw human(e, { login: session.login });
    }
    return { signer: signerOf(facts, folder, wanted), profile: facts.profile };
  }

  /**
   * After a commit as `signed` ({ signer, profile }, signerFor): an address publish push --email named becomes the
   * account's choice now that a commit was made with it. Refused by GitHub (GH007): that address is no longer the
   * account's choice, whoever chose it, and the refusal says whether the private address was the one refused.
   */
  function afterCommit(signed, { wanted = null, error = null } = {}) {
    if (error?.code === "email_private") {
      if (signed.signer.kind === "noreply") return Object.assign(error, { code: "email_refused" });
      const recorded = signerChoices()[choiceKey(signed.profile)];
      if (String(recorded?.email ?? "").toLowerCase() === signed.signer.email.toLowerCase()) forgetSigner({ profile: signed.profile });
      return error;
    }
    if (!error && wanted !== null) noteSigner(signed.profile, signed.signer);
    return error;
  }

  /**
   * Who a push from `folder` would sign as now, nothing recorded: { login, signer }, for the question the app asks
   * before a push or a request of the command line's. The address the command line names (--email) is not checked
   * here: only after the person's yes, so that a program cannot learn from the answer which addresses are the account's.
   */
  async function signerNow({ folder = null } = {}) {
    const session = await signedIn();
    const { signer, profile } = await signerFor(session, folder);
    return { login: session.login, signer, noreply: signerAs(profile, { email: noreplyAddress(profile), kind: "noreply" }) };
  }

  // ---------------------------------------------------------------- signing in

  /**
   * What the window shows: signed in (with how: GitHub CLI's account from before, or one the app signed in, and the
   * account GitHub CLI had before), or GitHub CLI's account to offer, or nothing to offer.
   */
  /**
   * GitHub CLI's accounts for github.com: [{ login, active }], from its configuration (no secret, no network); the
   * active one is the one GitHub CLI uses.
   */
  async function accounts() {
    if (!gh) return [];
    const active = await cliAccount().catch(() => null);
    const names = cliAccountNames();
    if (active && !names.some((one) => one.toLowerCase() === active.toLowerCase())) names.unshift(active);
    return names.map((one) => ({ login: one, active: Boolean(active) && one.toLowerCase() === active.toLowerCase() }));
  }

  async function status() {
    let who = login;
    if (!who && !signing && configured && noted()) {
      try {
        who = (await signedIn()).login;
      } catch (e) {
        who = null;
        if (e?.code === "changed_outside") lastFailure = { code: e.code, message: e.message, hint: e.hint };
      }
    }
    const mine = who ? noted() : null;
    const all = signing ? [] : await accounts();
    return {
      configured,
      signedIn: Boolean(who),
      login: who,
      origin: mine?.origin ?? null,
      previous: mine?.previous ?? null,
      existing: !who && !signing && configured ? (all.find((one) => one.active)?.login ?? null) : null,
      accounts: all,
      kept: "keyring",
      signing: signing ? { ...signing.shown } : null,
      failure: lastFailure,
      revokePage: REVOKE_PAGE,
    };
  }

  /**
   * "Use <login>": one of the accounts GitHub CLI on this computer has (`chosen`; its active one when none is named),
   * as it is. Nothing is signed in and GitHub CLI's active account is not changed; GitHub is asked who it is (gh api
   * user, with that account's token) once the person chose it, and it must be that account.
   */
  async function useExisting({ expected = null, login: chosen = null } = {}) {
    if (!configured) throw human({ code: "not_configured" });
    if (signing) throw new PublishError("signing_in", "A sign-in is under way.", "Finish it or cancel it first.");
    if (chosen !== null && !LOGIN.test(String(chosen))) throw new PublishError("usage", "Name one of GitHub CLI's accounts.", null);
    lastFailure = null;
    const all = await accounts();
    const named = chosen ?? all.find((one) => one.active)?.login ?? null;
    if (!named) throw human({ code: "no_existing" });
    const listed = all.find((one) => one.login.toLowerCase() === named.toLowerCase());
    if (!listed) throw new PublishError("no_existing", `GitHub CLI on this computer has no account ${named}.`, "Choose one of the accounts listed, or sign in with another account.");
    // The account the person agreed to in the app's dialog (publish signin --use-existing), and no other.
    if (expected && expected.toLowerCase() !== named.toLowerCase()) throw human({ code: "changed_outside" });
    let who;
    try {
      who = (await apiAs(listed.login).user()).login;
    } catch (e) {
      throw human(e, { login: listed.login });
    }
    if (who.toLowerCase() !== named.toLowerCase()) throw human({ code: "changed_outside" });
    note(renewed(who, { origin: "existing" }));
    login = who;
    log(`[github] using GitHub CLI's account ${who}`);
    return { login: who, origin: "existing" };
  }

  /**
   * Starts gh auth login --web and waits for its code, which it resolves with; the rest of the sign-in goes on in the
   * background. It adds the account to GitHub CLI and makes it the active one; the account GitHub CLI had before stays.
   */
  async function signIn() {
    if (!configured) throw human({ code: "not_configured" });
    if (signing) return { ...signing.shown };
    // One sign-in at a time: a second call while the first is starting gets the same code (audit H4).
    if (starting) return starting.then((shown) => ({ ...shown }));
    const abort = new AbortController();
    startingAbort = abort;
    starting = startSignIn(abort).finally(() => {
      starting = null;
      if (startingAbort === abort) startingAbort = null;
    });
    return starting.then((shown) => ({ ...shown }));
  }

  async function startSignIn(abort) {
    lastFailure = null;
    if (noted()) {
      const who = await signedIn();
      return { signedIn: true, login: who.login };
    }
    const before = await cliAccount().catch(() => null);
    // A configuration the bundled gh would write into without knowing it (a newer GitHub CLI's), or one that holds a
    // single account, which a sign-in replaces (gh 2.39 and older): nothing is started (docs/spikes/gh-compat-2026-11-12.md).
    const settings = ghSettings(configDir);
    if (settings.newer) throw human({ code: "gh_settings_newer" });
    if (settings.layout === "single") throw human({ code: "gh_settings_single" }, { login: settings.user ?? before });
    // Every account GitHub CLI has before the sign-in, not only its active one: an account the person had is never
    // the app's to sign out (security review F1).
    const had = cliAccountNames().map((one) => one.toLowerCase());
    if (abort.signal.aborted) throw human({ code: "canceled" });
    const reader = loginReader();
    let showCode;
    const codeShown = new Promise((resolve) => (showCode = resolve));
    const exited = gh.run(["auth", "login", "--hostname", GH_HOST, "--git-protocol", "https", "--web", "--skip-ssh-key"], {
      signal: abort.signal,
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      onStderr: (chunk) => {
        const got = reader.take(chunk);
        if (got) showCode(got);
      },
    });
    let late = false;
    const timer = setTimeout(() => ((late = true), abort.abort()), CODE_TIMEOUT_MS);
    const first = await Promise.race([codeShown, exited.then((out) => ({ exited: out }))]);
    clearTimeout(timer);
    if (first.exited) {
      const out = first.exited;
      throw human({ code: out.aborted ? (late ? "network" : "canceled") : loginFailure(out.stderr), message: cleanLine(out.stderr) });
    }
    if (!codeIsShown(first)) {
      abort.abort();
      await exited;
      throw new PublishError("bad_answer", "GitHub CLI showed a code or a page that is not GitHub's.", "Try again in a moment.");
    }
    const shown = { userCode: first.userCode, verificationUri: first.verificationUri, copied: first.copied === true, expiresAt: Date.now() + 15 * 60_000 };
    const mine = { shown, abort, done: null };
    mine.done = (async () => {
      try {
        const out = await exited;
        if (out.aborted) throw { code: "canceled" };
        if (out.timedOut) throw { code: "expired" };
        if (out.code !== 0) throw { code: loginFailure(out.stderr), message: cleanLine(out.stderr) };
        const said = /Logged in as ([A-Za-z0-9-]+)/.exec(out.stderr)?.[1] ?? null;
        // gh made the new account its active one: GitHub CLI goes back to the account it used before, for the
        // person's other programs. The app's calls go as the new one all the same, with its own token.
        const now = await cliAccount().catch(() => null);
        const added = said ?? now;
        let kept = null;
        if (before && now && now.toLowerCase() !== before.toLowerCase()) {
          const back = await gh.run(["auth", "switch", "--hostname", GH_HOST, "--user", before], { timeoutMs: 60_000 });
          if (back.code === 0) kept = before;
          else log(`[github] gh auth switch back: ${cleanLine(back.stderr) || back.code}`);
        }
        let who = null;
        try {
          who = (await apiAs(added).user()).login;
        } catch (e) {
          if (!/saved in plain text/i.test(out.stderr)) throw e;
        }
        // The system's store refused, and gh kept the token in its configuration file: that account is signed out of
        // GitHub CLI again (the app signed it in), and the app does not use it.
        if (/saved in plain text/i.test(out.stderr)) {
          const plain = who ?? said;
          if (LOGIN.test(plain ?? "") && plain.toLowerCase() !== (before ?? "").toLowerCase()) {
            const gone = await gh.run(["auth", "logout", "--hostname", GH_HOST, "--user", plain], { timeoutMs: 60_000 });
            if (gone.code !== 0) log(`[github] gh auth logout: ${cleanLine(gone.stderr) || gone.code}`);
          }
          throw { code: "keyring_refused" };
        }
        // An account GitHub CLI had (its active one or another): its sign-in was renewed, and it stays GitHub CLI's
        // (never signed out here).
        const same = had.includes(who.toLowerCase()) || Boolean(before && before.toLowerCase() === who.toLowerCase());
        // GitHub CLI went back to the account it used before (`kept`). Only when that failed does it use `who` now:
        // then the account it used before is noted, so that signing out here can switch it back.
        const previous = !kept && before && before.toLowerCase() !== who.toLowerCase() ? before : null;
        const noting = renewed(who, { origin: same ? "existing" : "app", previous });
        if (kept) noting.previous = null;
        note(noting);
        login = who;
        tokens.delete(who.toLowerCase());
        log(`[github] signed in as ${who} through GitHub CLI${same ? " (its account, renewed)" : ""}${kept ? `; GitHub CLI uses ${kept} again` : ""}`);
        return { login: who, origin: noting.origin, previous: noting.previous, renewed: Boolean(same) && noting.origin === "existing", kept };
      } catch (e) {
        const failure = human(e);
        lastFailure = { code: failure.code, message: failure.message, hint: failure.hint };
        throw failure;
      } finally {
        if (signing === mine) signing = null;
      }
    })();
    mine.done.catch(() => {});
    signing = mine;
    return { ...shown };
  }

  /** Waits for the sign-in under way: { login, origin, previous, renewed }. */
  async function waitSignIn() {
    if (!signing) {
      if (login) return { login, origin: noted()?.origin ?? null };
      if (lastFailure) throw new PublishError(lastFailure.code, lastFailure.message, lastFailure.hint);
      throw new PublishError("not_signing_in", "No sign-in is under way.", "Sign in to GitHub.");
    }
    return signing.done;
  }

  /** Stops the sign-in under way: gh is ended. */
  function cancelSignIn() {
    signing?.abort.abort();
    startingAbort?.abort();
    return true;
  }

  /** Opens github.com/login/device for the code under way. */
  function openCodePage() {
    if (!signing) throw new PublishError("not_signing_in", "No sign-in is under way.", "Sign in to GitHub.");
    openExternal(signing.shown.verificationUri);
    return true;
  }

  /**
   * Signs out here. An account GitHub CLI had before is only forgotten. One the app signed in stays GitHub CLI's
   * unless `signOutCli` (gh auth logout --user <login>, the person's tick; GitHub CLI then goes back to another account
   * of its own, if it has one), and `switchBack` makes GitHub CLI's active account the one it had before
   * (gh auth switch), for any sign-in here that changed it, GitHub CLI's own accounts included. GitHub keeps the access
   * until the person revokes GitHub CLI on its page of authorised apps.
   */
  async function signOut({ signOutCli = false, switchBack = false, open = false } = {}) {
    cancelSignIn();
    await signing?.done.catch(() => {});
    const mine = noteOf();
    // The address the account's commits were signed with goes with the sign-in (EMU-366).
    if (mine) {
      forgetSigner({ profile: accountFacts.get(mine.login.toLowerCase())?.profile ?? null, login: mine.login });
      accountFacts.delete(mine.login.toLowerCase());
    }
    let cliSignedOut = false;
    let switchedBack = false;
    // A newer GitHub CLI's configuration is not written to (docs/spikes/gh-compat-2026-11-12.md): only forgotten here.
    const newer = gh && mine && (signOutCli === true || switchBack === true) && ghSettings(configDir).newer;
    if (newer) log("[github] GitHub CLI's settings are of a newer version: signing out leaves them as they are");
    if (gh && mine && !newer) {
      if (signOutCli === true && mine.origin === "app") {
        const out = await gh.run(["auth", "logout", "--hostname", GH_HOST, "--user", mine.login], { timeoutMs: 60_000 });
        cliSignedOut = out.code === 0;
        if (!cliSignedOut) log(`[github] gh auth logout: ${cleanLine(out.stderr) || out.code}`);
      } else if (switchBack === true && mine.previous) {
        const out = await gh.run(["auth", "switch", "--hostname", GH_HOST, "--user", mine.previous], { timeoutMs: 60_000 });
        switchedBack = out.code === 0;
        if (!switchedBack) log(`[github] gh auth switch: ${cleanLine(out.stderr) || out.code}`);
      }
    }
    forget();
    lastFailure = null;
    if (open) openExternal(REVOKE_PAGE);
    return { signedIn: false, revokePage: REVOKE_PAGE, cliSignedOut, switchedBack, cliAccount: await cliAccount().catch(() => null) };
  }

  // ---------------------------------------------------------------- the repository

  /**
   * The files the repository gets, read from the project: [{ path, bytes, executable }], with `skipped`: what is not a
   * plain file (a symbolic link, a folder's link), left out and named (audit H10). Their number and sizes are looked
   * at first, so that nothing is loaded for a push GitHub would refuse.
   */
  function readFiles(folder, list) {
    const root = realpathSync.native(folder);
    const found = [];
    const skipped = [];
    let total = 0;
    for (const rel of list) {
      if (LEFT_OUT.test(rel)) continue;
      if (rel.includes("\\")) throw new PublishError("bad_path", `${rel}: GitHub takes no backslash in a file's name.`, "Rename it, or keep it out in Repository files.");
      const file = path.join(root, ...rel.split("/"));
      const stat = lstatSync(file);
      if (!stat.isFile()) {
        skipped.push(rel);
        continue;
      }
      const real = realpathSync.native(file);
      if (!real.startsWith(root + path.sep)) throw new PublishError("outside", `${rel} is not inside the project's folder.`, "Keep it out in Repository files.");
      if (stat.size > MAX_FILE_BYTES) throw new PublishError("too_large", `${rel} is ${Math.round(stat.size / 1048576)} MB: GitHub takes files up to 50 MB.`, "Keep it out in Repository files.");
      total += stat.size;
      found.push({ rel, real, stat });
    }
    if (found.length > MAX_PUSH_FILES) throw new PublishError("too_many_files", `The project has ${found.length} files to publish: one upload takes at most ${MAX_PUSH_FILES}.`, "Keep large or generated folders out in Repository files.");
    if (total > MAX_PUSH_BYTES) throw new PublishError("too_large", `The files to publish come to ${Math.round(total / 1048576)} MB: one upload takes at most ${MAX_PUSH_BYTES / 1048576} MB.`, "Keep large files out in Repository files.");
    const files = found.map(({ rel, real, stat }) => ({ path: rel, bytes: readFileSync(real), executable: process.platform !== "win32" && (stat.mode & 0o111) !== 0 }));
    files.skipped = skipped;
    return files;
  }

  /** The first free name like `name` among the person's repositories. */
  async function freeName(github, owner, name) {
    for (let i = 2; i < 10; i++) {
      const candidate = `${name}-${i}`;
      if (!(await github.repo(owner, candidate))) return candidate;
    }
    return null;
  }

  /** The repository this app published the project to for the signed-in person, from the app's own record. */
  function ours(folder, owner) {
    const repo = record?.get(folder).repo ?? null;
    return repo && repo.owner.toLowerCase() === owner.toLowerCase() ? repo : null;
  }

  /**
   * The commit the project is known to stand on in github.com/<owner>/<name> (catalog-update): the one Create app
   * downloaded it at (the app's record), else the one its own .busy/publish.json names, else its own git's HEAD.
   * { commit, from: "imported" | "project" | "git" }, or null when nothing says.
   */
  function baseOf(folder, facts, owner, name) {
    const same = (r) => r && String(r.owner).toLowerCase() === owner.toLowerCase() && String(r.name).toLowerCase() === name.toLowerCase() && /^[0-9a-f]{40}$/.test(r.commit ?? "");
    const imported = record?.get(folder).imported ?? null;
    if (same(imported)) return { commit: imported.commit, from: "imported" };
    if (same(facts?.github?.repo)) return { commit: facts.github.repo.commit, from: "project" };
    const head = localHead(folder);
    return head ? { commit: head, from: "git" } : null;
  }

  /**
   * Whether github.com/<owner>/<name> at `head` has commits the project does not (catalog-update): null when it has
   * none (or nothing says), else { ahead } (how many, when GitHub could count them).
   */
  async function aheadOf(github, folder, at, base, head) {
    if (!base || !head || base.commit === head) return null;
    const c = await github.compare(at.owner, at.name, base.commit, head);
    if (c) return c.status === "ahead" || c.status === "diverged" ? { ahead: c.ahead } : null;
    // GitHub does not know the base: commits of the project's own git not pushed yet. GitHub's head must be in it.
    if (base.from === "git") return localHas(folder, head) ? null : { ahead: null };
    return null;
  }

  /** The files of the branch at `head` that the project does not have, but for .github/workflows/ (never touched). */
  async function extraFiles(github, at, head, facts) {
    if (!head || !Array.isArray(facts?.files?.published)) return [];
    const mine = new Set(facts.files.published.map((one) => one.path));
    const commit = await github.commit(at.owner, at.name, head);
    return (await github.files(at.owner, at.name, commit.tree.sha)).map((one) => one.path).filter((one) => !mine.has(one) && !LEFT_OUT.test(one));
  }

  /**
   * The repository's name Publish to GitHub offers for the project, and where it came from (`named`): the repository
   * this app published it to ("published"), else the one Create app imported it from ("imported"), else the one its
   * own git remote names on the signed-in account ("remote", EMU-358), else the last part of the app's id ("id").
   * `remote`: the project's git remote as the window says it, { remote, repo, host, unreadable, why } (`remote` its name, null when
   * not a plain one; `why` why it did not name the repository, "another_account" or "not_github", when the name is the
   * id's); null without a remote.
   */
  function defaultName(folder, facts, owner) {
    const mine = (who) => String(who).toLowerCase() === owner.toLowerCase();
    const said = localRemote(folder);
    // The remote's name is the project's text: said in the window only when it is a plain one.
    const remote = said && { remote: /^[A-Za-z0-9._-]{1,40}$/.test(said.remote) ? said.remote : null, repo: said.github ? `${said.github.owner}/${said.github.name}` : null, host: said.host, unreadable: said.unreadable === true, why: null };
    const remembered = ours(folder, owner);
    if (remembered) return { name: remembered.name, named: "published", remote };
    const imported = record?.get(folder).imported ?? null;
    if (imported && mine(imported.owner)) return { name: imported.name, named: "imported", remote };
    if (said?.github && mine(said.github.owner)) return { name: said.github.name, named: "remote", remote };
    if (remote) remote.why = said.github ? "another_account" : "not_github";
    return { name: String(facts?.id ?? "app").split(".").at(-1), named: "id", remote };
  }

  /**
   * Where a push of the project goes, and what it does there: { owner, name, page, mode, suggestion, named, remote,
   * … } (`named`, `remote`: defaultName(); `named` is "typed" for a name the person chose). `mode`:
   *   "new"       a new public repository of that name
   *   "replace"   the repository this app published the project to before (its own record says so, and the commit
   *               it noted is in that repository): its files become the project's; for one the person had before
   *               (`adopted`), files it has and the project has not (`extra`) stay unless the person agrees
   *   "existing"  the person's own repository of that name, not published to from here (catalog-update): the files
   *               go in as a new commit on its default branch (`branch`, at `head`) once the person confirms it; the
   *               files it has and the project has not (`extra`) stay unless they agree to delete them
   *   "diverged"  that repository has commits the project does not (`ahead`), made on GitHub or on another computer:
   *               nothing is sent
   *   "taken"     a repository of that name that cannot take the files (`reason`: "archived", "empty", "not_yours")
   */
  async function plan({ folder, status: facts, name: chosen = null, suggest = false }, session = null) {
    // A push names the account it started as (`session`): the plan is made as that one, not as one chosen since (L4).
    const { github, login: owner } = session ?? (await signedIn());
    const remembered = ours(folder, owner);
    const { name: given, named: from, remote } = defaultName(folder, facts, owner);
    const name = chosen ?? given;
    if (!REPO_NAME.test(name) || /^\.+$/.test(name)) throw new PublishError("bad_name", "A repository's name takes letters, digits, '.', '-' and '_'.", "Choose another name.");
    // Where the name came from, for the words beside the field: a name typed that is the default's is the default's.
    const named = chosen === null || chosen.toLowerCase() === given.toLowerCase() ? from : "typed";
    const page = `https://github.com/${owner}/${name}`;
    try {
      const there = await github.repo(owner, name);
      if (!there) return { owner, name, page, mode: "new", suggestion: null, named, remote };
      const real = there.name ?? name;
      const at = { owner, name: real, page: `https://github.com/${owner}/${real}`, branch: there.default_branch, named, remote };
      const taken = async (reason) => ({ ...at, mode: "taken", reason, suggestion: suggest ? await freeName(github, owner, name) : null });
      // GitHub answers for a repository moved to another account under that account's name: not the person's.
      if (String(there.owner?.login ?? owner).toLowerCase() !== owner.toLowerCase()) return taken("not_yours");
      const head = await github.branchHead(owner, real, there.default_branch).catch((e) => (e.code === "conflict" ? null : Promise.reject(e)));
      if (remembered && remembered.name.toLowerCase() === name.toLowerCase()) {
        const known = await github.commit(owner, real, remembered.commit).then(() => true, (e) => (["not_found", "unprocessable", "conflict"].includes(e.code) ? false : Promise.reject(e)));
        if (known) {
          const ahead = await aheadOf(github, folder, at, { commit: remembered.commit, from: "published" }, head);
          if (ahead) return { ...at, mode: "diverged", head, ahead: ahead.ahead, suggestion: null };
          const extra = remembered.adopted ? await extraFiles(github, at, head, facts) : [];
          return { ...at, mode: "replace", suggestion: null, commit: remembered.commit, head, adopted: remembered.adopted === true, extra };
        }
      }
      if (there.archived === true) return taken("archived");
      if (there.permissions && there.permissions.push === false) return taken("not_yours");
      if (!head) return taken("empty");
      const base = baseOf(folder, facts, owner, real);
      const ahead = await aheadOf(github, folder, at, base, head);
      if (ahead) return { ...at, mode: "diverged", head, ahead: ahead.ahead, base: base.from, suggestion: null };
      // A free name costs up to eight requests: looked for only when a push is refused, not while the name is typed (F4).
      return { ...at, mode: "existing", head, base: base?.from ?? null, extra: await extraFiles(github, at, head, facts), suggestion: suggest ? await freeName(github, owner, name) : null };
    } catch (e) {
      if (e instanceof PublishError) throw e;
      if (e.code === "unauthorized") markStale();
      throw human(e, { name });
    }
  }

  /** The flagged files that would be published without the person's click on Publish it anyway in this app. */
  function unconfirmed(folder, files) {
    const kept = new Set(record?.get(folder).keptIn ?? []);
    return [...new Set((files.findings ?? []).filter((one) => one.published && !kept.has(one.path)).map((one) => one.path))];
  }

  /**
   * The project in the person's public repository, one commit, read back. `facts`: what `publish status` and
   * `publish files` said of the project; `name`: the repository's name the person chose (else the one this app
   * published to, else the last part of the app's id). Resolves with { owner, name, page, commit, files, uploaded,
   * created, unchanged, mode }. `upload` hears the upload's progress (github-api.mjs pushFiles onProgress); Cancel
   * (cancel()) stops it before the branch is moved.
   */
  async function push({ folder, status: facts, files: list, name: chosen = null, into = null, email = null, progress = () => {}, upload = () => {}, verify = null }) {
    if (pushing) throw new PublishError("busy", "An upload is under way.", "Wait for it, or cancel it.");
    const stop = new AbortController();
    pushing = stop;
    try {
      return await pushing_(stop.signal, { folder, facts, list, chosen, into, email, progress, upload, verify });
    } finally {
      if (pushing === stop) pushing = null;
    }
  }

  /** Stops the push under way, if there is one: true when there was. */
  function cancel() {
    if (!pushing) return false;
    pushing.abort();
    return true;
  }

  /** Why a push into a repository of `plan()` is refused before anything is sent (catalog-update), or null. */
  function refusedInto(where, into) {
    if (where.mode === "taken") {
      if (where.reason === "archived") return new PublishError("archived", `github.com/${where.owner}/${where.name} is archived, so it takes no new commits.`, "Unarchive it on GitHub, or choose another name.");
      if (where.reason === "empty") return new PublishError("empty_repo", `github.com/${where.owner}/${where.name} has no commit yet, so there is nothing to add to.`, "Add a README on GitHub first, or choose another name.");
      return human({ code: "name_taken" }, { name: where.name, free: where.suggestion });
    }
    if (where.mode === "diverged") {
      const many = where.ahead === 1 ? "a commit" : where.ahead ? `${where.ahead} commits` : "commits";
      // A git clone of that very repository (its remote named it) gets them with git; another copy by importing it again
      // (EMU-358): a clone of another repository would pull from that one.
      const first = where.base === "git" && where.named === "remote" ? "Get them first: git pull in the project's folder, then publish again." : "Get them first: import the repository again (Create app, Import from GitHub), carry your changes over and publish from there.";
      return new PublishError("remote_ahead", `github.com/${where.owner}/${where.name} has ${many} this project doesn't have, made on GitHub or on another computer. Nothing was sent.`, first);
    }
    if (where.mode === "existing") {
      if (!into || typeof into.head !== "string") return new PublishError("confirm_existing", `You have github.com/${where.owner}/${where.name} already, and this project was not published to it from here.`, "Confirm Publish into it in the window first.");
      if (into.head !== where.head) return new PublishError("changed_since_look", `github.com/${where.owner}/${where.name} changed since you looked at it.`, "Look at it again, then confirm.");
    }
    return null;
  }

  async function pushing_(signal, { folder, facts, list, chosen, into, email, progress, upload, verify }) {
    // The account signed in now is the push's to its end: choosing another meanwhile does not change it (L4).
    const session = await signedIn({ fresh: true });
    const { github } = session;
    // Who the commit is signed by, before anything is sent (EMU-366); --email's address is checked here, after the yes.
    const signed = await signerFor(session, folder, email);
    const { signer } = signed;
    const flagged = unconfirmed(folder, list);
    if (flagged.length) throw new PublishError("secrets", `${flagged[0]} looks like a secret or personal data and would be published.`, "Keep it out in Repository files, or choose Publish it anyway there.");
    if (!facts.license?.ready) throw new PublishError("no_license", "The project has no license yet.", "Choose one in License.");
    const files = readFiles(folder, list.published.map((one) => one.path));
    if (!files.length) throw new PublishError("no_files", "There are no files to publish.", "Look at Repository files.");
    // stale-check: right after the files are read, before anything is sent: the project is still the one checked and
    // packaged (`verify`, publish verify: it throws when not), and the bytes read are the very ones the check saw.
    if (verify) {
      const checked = await verify();
      const changed = changedSinceCheck(files, checked?.files ?? null);
      if (changed) throw new PublishError("changed_since_check", `${changed} changed since Pre-flight check, so nothing was sent: GitHub gets only what was checked.`, "Run Pre-flight check and Build and package again, then publish.");
    }
    const skipped = files.skipped;
    if (skipped.length) progress(`Leaving out ${skipped.length === 1 ? "a link" : `${skipped.length} links`}, which GitHub would not get as files: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`);
    const where = await plan({ folder, status: { ...facts, files: list }, name: chosen, suggest: true }, session);
    const refused = refusedInto(where, into);
    if (refused) throw refused;
    // Into a repository the person had before (catalog-update): a commit on top, its other files kept unless the
    // person agreed to delete them (`into.deleteOthers`). One the app made mirrors the project.
    const adding = where.mode === "existing" || (where.mode === "replace" && where.adopted);
    const remove = adding && into?.deleteOthers === true ? (where.extra ?? []) : [];
    try {
      let branch = where.branch;
      let created = false;
      if (where.mode === "new") {
        progress(`Creating the repository github.com/${where.owner}/${where.name}`);
        let made;
        try {
          made = await github.createRepo({ name: where.name, description: String(facts.texts?.texts?.short_description ?? "").slice(0, 350) });
        } catch (e) {
          // GitHub failed (5xx, or no answer), and may have made it all the same: a repository of that name there now,
          // where there was none a moment ago (plan()), is the one this request made.
          // A timeout or a gh that ended with no answer may have left it made just the same (EMU-360 re-review).
          if (!["server", "network", "timeout", "gh_failed"].includes(e.code)) throw e;
          const there = await github.repo(where.owner, where.name).catch(() => null);
          if (!there) throw e;
          made = { owner: there.owner?.login ?? where.owner, name: there.name ?? where.name, defaultBranch: there.default_branch };
        }
        // The repository GitHub made is the signed-in person's, and nobody else's (F2).
        if (String(made.owner).toLowerCase() !== String(where.owner).toLowerCase()) throw new PublishError("changed_outside", `GitHub made the repository for ${made.owner}, not for ${where.owner}, the account signed in here.`, "Sign in again: choose the account to publish with.");
        // A new repository's first commit can take a moment to be readable.
        const first = await github.waitForFork({ owner: made.owner, name: made.name, defaultBranch: made.defaultBranch }, forkWait ?? {});
        // Noted at once, at its first commit: when the upload below fails, publishing again finds this repository as
        // the app's own (plan(): "replace") instead of a name that is taken.
        record?.pushed(folder, { owner: made.owner, name: made.name, commit: first });
        Object.assign(where, { owner: made.owner, name: made.name, page: `https://github.com/${made.owner}/${made.name}` });
        branch = made.defaultBranch;
        created = true;
      }
      progress(`Uploading ${files.length} files`);
      const pushed = await github.pushFiles({ owner: where.owner, name: where.name, branch, files, message: `${facts.name ?? facts.id}${facts.version ? ` ${facts.version}` : ""}`, mode: adding ? "add" : "replace", remove, author: { name: signer.name, email: signer.email }, onProgress: upload, signal });
      progress("Checking what GitHub holds");
      if (!pushed.unchanged) afterCommit(signed, { wanted: email });
      record?.pushed(folder, { owner: where.owner, name: where.name, commit: pushed.commit, ...(where.mode === "existing" ? { adopted: true } : {}) });
      return { owner: where.owner, name: where.name, page: where.page, commit: pushed.commit, files: files.length, uploaded: pushed.uploaded, removed: pushed.removed ?? 0, created, unchanged: Boolean(pushed.unchanged), mode: where.mode, skipped, signer };
    } catch (e) {
      if (e.code === "unauthorized" || e.code === "no_account") markStale();
      if (e.code === "canceled") throw new PublishError("upload_canceled", "The upload was stopped. The repository's files are as they were.", "Publish again when you want to.");
      throw human(afterCommit(signed, { error: e }), { name: where.name, login: where.owner });
    }
  }

  // ---------------------------------------------------------------- the catalog

  /** The manifest's sourcecode block made from the repository this app published to and checked, not from the file. */
  function locatedManifest(manifest, repo) {
    const lines = manifest.replace(/\r\n/g, "\n").split("\n");
    const at = lines.findIndex((line) => line === "  location:");
    if (lines[0] !== "sourcecode:" || at < 0) return null;
    // One sourcecode block, one location, one origin and one commit: a second of any (a hand-edited manifest) could
    // name another repository than the one checked here, and YAML would take the last.
    const count = (re) => lines.filter((line) => re.test(line)).length;
    if (count(/^\s*sourcecode:/) !== 1 || count(/^\s*location:/) !== 1 || count(/^\s*origin:/) > 1 || count(/^\s*commit_sha:/) > 1) return null;
    let end = at + 1;
    while (end < lines.length && /^ {4}/.test(lines[end])) end++;
    lines.splice(at + 1, end - at - 1, `    origin: https://github.com/${repo.owner}/${repo.name}.git`, `    commit_sha: ${repo.commit}`);
    return lines.join("\n");
  }

  /** The catalog's pull request template, from the catalog itself; null when it has none that can be read. */
  async function readTemplate(github, catalog) {
    for (const file of TEMPLATE_FILES) {
      const text = await github.textFile(catalog.owner, catalog.name, file).catch(() => null);
      if (typeof text === "string" && text.trim()) return { text, file };
    }
    return null;
  }

  /**
   * The checklist the request needs ticked: the target catalog's pull request template, read now (gh api, read only),
   * or the copy bundled with the app when it cannot be read (not signed in, the catalog closed, no template). Resolves
   * with { catalog, source: "catalog" | "bundled", file, page, blocks, boxes, ai } (parseChecklist). The template is
   * kept, so that the request is made from the one the person was shown.
   */
  async function checklist({ catalog: given }) {
    const catalog = parseCatalog(given);
    if (!catalog) throw new PublishError("bad_catalog", "The catalog is a GitHub repository: owner/name, or its address.", null);
    const key = `${catalog.owner}/${catalog.name}`.toLowerCase();
    let found = null;
    if (configured && noted()) {
      try {
        found = await readTemplate((await signedIn()).github, catalog);
      } catch (e) {
        log(`[github] the catalog's template could not be read: ${String(e?.message ?? e).slice(0, 200)}`);
      }
    }
    const text = found?.text ?? BUNDLED_TEMPLATE;
    const parsed = parseChecklist(text);
    const problem = checklistProblem(parsed, `${catalog.owner}/${catalog.name}`);
    if (problem) throw problem;
    templates.set(key, text);
    if (templates.size > 16) templates.delete(templates.keys().next().value);
    return {
      catalog: `${catalog.owner}/${catalog.name}`,
      // false: not one of BUSY's catalogs; the window and the app's dialog say so, and the request needs its name confirmed.
      busy: knownCatalog(catalog),
      source: found ? "catalog" : "bundled",
      file: found?.file ?? null,
      page: found ? `https://github.com/${catalog.owner}/${catalog.name}/blob/HEAD/${found.file}` : null,
      ...parsed,
    };
  }

  /**
   * What the catalog has of the app now (catalog-update), read from it (gh api, reads only): its
   * applications/<id>/manifest.yml, and the version of the app at the commit that manifest names (its
   * src/appmeta/manifest.json, or appmeta/manifest.json, in the repository the manifest names). { catalog, id,
   * exists, version (the project's), file, page, published: { version, changelog, origin, commit } | null, higher
   * (true, false, or null when a version cannot be read), yours (the manifest's repository is the signed-in person's;
   * null when it names none on github.com), elsewhere ("owner/name": the catalog's app comes from another repository
   * of the person's than the one this project was published to, so sending would make this project its source; else
   * null) }. `folder`: the project's, for the repository it was published to.
   */
  async function entryOf(github, me, catalog, facts, folder = null) {
    const id = facts.id;
    const file = `applications/${id}/manifest.yml`;
    const said = { catalog: `${catalog.owner}/${catalog.name}`, id, version: facts.version ?? null, file, page: `https://github.com/${catalog.owner}/${catalog.name}/blob/HEAD/${file}` };
    const text = await github.textFile(catalog.owner, catalog.name, file);
    if (typeof text !== "string") return { ...said, exists: false, published: null, higher: null, yours: null, elsewhere: null };
    const published = readCatalogManifest(text);
    const origin = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(published.origin ?? "");
    let version = null;
    if (origin && published.commit) {
      const under = published.subdir ? `${String(published.subdir).replace(/^\/+|\/+$/g, "")}/` : "";
      for (const rel of ["src/appmeta/manifest.json", "appmeta/manifest.json"]) {
        const json = await github.textFile(origin[1], origin[2], `${under}${rel}`, { ref: published.commit }).catch(() => null);
        if (typeof json !== "string") continue;
        try {
          const v = JSON.parse(json)?.version;
          if (typeof v === "string") version = v;
        } catch {
          // Not known.
        }
        break;
      }
    }
    const order = compareVersions(facts.version, version);
    const yours = origin ? origin[1].toLowerCase() === me.toLowerCase() : null;
    const repo = folder ? ours(folder, me) : null;
    return {
      ...said,
      exists: true,
      published: { version, changelog: published.changelog, origin: origin ? `https://github.com/${origin[1]}/${origin[2]}` : null, commit: published.commit },
      higher: order === null ? null : order > 0,
      yours,
      elsewhere: yours && repo && origin[2].toLowerCase() !== String(repo.name).toLowerCase() ? `${origin[1]}/${origin[2]}` : null,
    };
  }

  /** entryOf() for the window: { folder's status, catalog, folder }. */
  async function entry({ status: facts, catalog: given = null, folder = null }) {
    const catalog = parseCatalog(given ?? facts?.catalog);
    if (!catalog) throw new PublishError("bad_catalog", "The catalog is a GitHub repository: owner/name, or its address.", null);
    if (!/^[a-z0-9_.-]{1,63}$/.test(facts?.id ?? "")) throw new PublishError("no_version", "The app's manifest has no id the catalog takes.", "Fix src/appmeta/manifest.json, then build and package again.");
    const { github, login: me } = await signedIn();
    try {
      return await entryOf(github, me, catalog, facts, folder);
    } catch (e) {
      if (e instanceof PublishError) throw e;
      if (e.code === "unauthorized") markStale();
      throw human(e);
    }
  }

  /** Why the catalog does not take the request as an update, or null (catalog-update). */
  function updateRefusal(found, facts, changelog) {
    if (!found.exists) return null;
    const p = found.published;
    if (found.yours === false) return new PublishError("not_your_app", `The catalog has ${found.id} from ${p.origin.replace(/^https:\/\//, "")}, a repository of another account: an update comes from that repository's owner.`, "If yours is another app, give it another id in src/appmeta/manifest.json.");
    if (found.higher === false) return new PublishError("version_not_higher", `The catalog has version ${p.version} of ${facts.name ?? found.id}, and this package is ${facts.version}: an update needs a higher version.`, `Raise version in src/appmeta/manifest.json above ${p.version}, then build and package, and publish to GitHub again.`);
    const problem = changelogProblem(changelog);
    if (problem) return new PublishError("no_changelog", `${problem} The catalog needs it for an update.`, null);
    if (p.changelog !== null && String(changelog).trim() === String(p.changelog).trim()) return new PublishError("no_changelog", `What's new is the same as the published version's. Write what's new in ${facts.version}.`, null);
    return null;
  }

  /** The repository and commit the request will name, for the person to see before they send: or null. */
  function requestTarget(folder) {
    return record?.get(folder).repo ?? null;
  }

  /**
   * Where a pull request the project's record names stands now (EMU-360 review): { url, state: "open" | "closed" |
   * "merged", commit }, read from GitHub. Only one of `catalog` ("owner/name") at github.com; else a PublishError.
   */
  async function pullState({ url, catalog }) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d{1,9})$/.exec(String(url ?? ""));
    const named = parseCatalog(catalog ?? "");
    if (!m || !named || `${m[1]}/${m[2]}`.toLowerCase() !== `${named.owner}/${named.name}`.toLowerCase()) throw new PublishError("usage", "That is not a pull request of the catalog.", null);
    const { github } = await signedIn();
    try {
      const one = await github.pull(m[1], m[2], Number(m[3]));
      if (!one) return { url, state: "gone", commit: null };
      return { url: one.url ?? url, state: one.state, commit: one.commit };
    } catch (e) {
      throw human(e);
    }
  }

  /**
   * The pull request to the catalog. `facts`: `publish status`; `manifest`: submission/'s manifest.yml (its
   * sourcecode block is made here, from the repository this app published to); `testing`: the pull request text's
   * "Device testing" part from submission/; `ticked`: the texts of the checklist's boxes the person ticked — every box
   * of the template they were shown (checklist()) must be among them, or nothing is sent. `otherCatalog`: a catalog
   * that is not one of BUSY's goes only when the person confirmed it by its name, "owner/name" (L3).
   */
  async function request({ status: facts, files: list, folder, catalog: given, ticked, ai, aiNote = null, manifest, changelog = null, testing = null, otherCatalog = null, progress = () => {} }) {
    if (changelog !== null && typeof changelog !== "string") throw new PublishError("usage", "What's new is a text.", null);
    if (!Array.isArray(ticked) || ticked.some((one) => typeof one !== "string")) throw new PublishError("not_ticked", "Tick every item of the catalog's checklist first.", null);
    if (!AI_CHOICES.includes(ai)) throw new PublishError("no_ai_choice", "Say how AI was used in the app.", null);
    if (aiNote !== null && typeof aiNote !== "string") throw new PublishError("usage", "The explanation of the AI usage is a text.", null);
    const noteProblem = aiNoteProblem(ai, aiNote);
    if (noteProblem) throw noteProblem;
    const catalog = parseCatalog(given ?? facts.catalog);
    if (!catalog) throw new PublishError("bad_catalog", "The catalog is a GitHub repository: owner/name, or its address.", null);
    const named = `${catalog.owner}/${catalog.name}`;
    if (!knownCatalog(catalog) && String(otherCatalog ?? "").toLowerCase() !== named.toLowerCase()) throw new PublishError("other_catalog", `${named} is not BUSY's catalog (${BUSY_CATALOGS[0]}): the project or the command names it, and nothing is sent there unless you confirm it.`, `Send it to ${BUSY_CATALOGS[0]}, or confirm ${named} when the emulator asks.`);
    if (!/^[a-z0-9_.-]{1,63}$/.test(facts.id ?? "") || !/^[0-9A-Za-z.+-]{1,40}$/.test(facts.version ?? "")) throw new PublishError("no_version", "The app's manifest has no id or version the catalog takes.", "Fix src/appmeta/manifest.json, then build and package again.");
    // The account signed in now is the request's to its end: choosing another meanwhile does not change it (L4).
    const session = await signedIn({ fresh: true });
    const { github, login: me } = session;
    const repo = ours(folder, me);
    if (!repo) throw new PublishError("not_pushed", "The app is not on GitHub from this computer yet.", "Publish to GitHub first.");
    let text = typeof manifest === "string" ? locatedManifest(manifest, repo) : null;
    if (!text) throw new PublishError("not_packaged", "There is no catalog manifest for the app yet.", "Build and package first.");
    if (changelog !== null) {
      const problem = changelogProblem(changelog);
      if (problem) throw new PublishError("bad_changelog", problem, null);
      text = withChangelog(text, changelog.trim());
    }
    // The template the person was shown (checklist()), else the catalog's as it is now: each of its boxes ticked.
    const key = `${catalog.owner}/${catalog.name}`.toLowerCase();
    const template = templates.get(key) ?? (await readTemplate(github, catalog))?.text ?? BUNDLED_TEMPLATE;
    const shown = parseChecklist(template);
    const tooLong = checklistProblem(shown, named);
    if (tooLong) throw tooLong;
    const missing = shown.required.filter((one) => !ticked.includes(one));
    if (missing.length) throw new PublishError("not_ticked", `Tick every item of the catalog's checklist first: ${missing.length === 1 ? "one is" : `${missing.length} are`} not ticked.`, templates.has(key) ? null : "Open Send to catalog in the window to see the checklist.");
    // Who the manifest's commit is signed by (EMU-366): known once it is asked, for what a refusal does to the choice.
    let signed = null;
    try {
      // The commit on GitHub must still be what the project holds: the catalog builds exactly that commit.
      progress("Comparing the project with GitHub");
      // catalog.json is not part of the build: the catalog takes the texts from the manifest, and What's new of an
      // update is written into it after the files went up (catalog-update). Files the repository had before the app
      // published into it (adopted) are its own, not the project's.
      const files = readFiles(folder, list.published.map((one) => one.path)).filter((one) => one.path !== "catalog.json");
      const commit = await github.commit(repo.owner, repo.name, repo.commit);
      const there = new Map((await github.files(repo.owner, repo.name, commit.tree.sha)).map((one) => [one.path, one.sha]));
      there.delete("catalog.json");
      const changed = files.filter((one) => there.get(one.path) !== blobSha(one.bytes));
      if (changed.length || (!repo.adopted && there.size !== files.length)) throw new PublishError("changed_since_upload", "The project changed since it was published to GitHub.", "Publish to GitHub again, then send it.");
      // An app the catalog has already: an update, with a higher version and its own What's new (catalog-update).
      progress(`Reading what ${catalog.owner}/${catalog.name} has of the app`);
      const found = await entryOf(github, me, catalog, facts);
      const refused = updateRefusal(found, facts, changelog ?? readCatalogManifest(text).changelog);
      if (refused) throw refused;
      signed = await signerFor(session, folder);
      const { signer } = signed;
      progress(`Opening the request in ${catalog.owner}/${catalog.name}`);
      const appName = facts.name ?? facts.id;
      const title = found.exists ? `Update ${appName} to ${facts.version}` : `Add ${appName} ${facts.version}`;
      const made = await github.proposeToCatalog({
        catalog,
        login: me,
        branch: `${me}/${facts.id}_${facts.version}`,
        files: [{ path: `applications/${facts.id}/manifest.yml`, bytes: Buffer.from(text) }],
        message: title,
        title,
        body: fillTemplate(template, { ai, aiNote, ticked, testing }),
        author: { name: signer.name, email: signer.email },
      });
      // The optional items, and whether the request has them ticked: an agent can say so to the person (EMU-313).
      const optional = shown.boxes.filter(isOptionalBox).map((one) => ({ item: boxLabel(one), ticked: ticked.includes(one) }));
      return { url: made.url, number: made.number, created: made.created, unchanged: made.unchanged === true, direct: made.direct, branch: made.branch, catalog: `${catalog.owner}/${catalog.name}`, repo: `https://github.com/${repo.owner}/${repo.name}`, commit: repo.commit, update: found.exists, title, optional, signer };
    } catch (e) {
      if (e instanceof PublishError) throw e;
      if (e.code === "unauthorized") markStale();
      // What GitHub has made of the request so far (the fork, the branch; EMU-360): the window says it, and Try again
      // goes on from there.
      const said = human(signed ? afterCommit(signed, { error: e }) : e);
      if (e?.made && (e.made.fork || e.made.branch)) said.done = { fork: e.made.fork ?? null, branch: e.made.branch ?? null };
      // Where it failed, for the window's words: the fork, a push (to the fork, or the catalog's own branch), the pull request.
      if (typeof e?.at === "string") said.where = { at: e.at, direct: e.direct === true };
      throw said;
    }
  }

  // ---------------------------------------------------------------- catalog-update: Import from GitHub

  /** The repository the person names, read as the signed-in account: the repository, or a PublishError. */
  async function repositoryNamed(github, me, text) {
    const parsed = parseRepository(text);
    if (parsed.problem) throw new PublishError("not_github", parsed.problem, null);
    const there = await github.repo(parsed.owner, parsed.name);
    if (!there) throw new PublishError("repo_not_found", `github.com/${parsed.owner}/${parsed.name} can't be seen as ${me}: it isn't there, or it is private.`, "Check the address, or sign in with the account that has it.");
    return { owner: there.owner?.login ?? parsed.owner, name: there.name ?? parsed.name, branch: there.default_branch, private: there.private === true, description: typeof there.description === "string" ? there.description.slice(0, 300) : null };
  }

  /**
   * The app package of a repository's latest release: { release: { tag, version, page, asset: { name, size, url } } },
   * or { release: null, said } with what was found instead ("it has no releases", "its latest release v1.0 has no .tgz
   * file, only app.zip"). The first .tgz file of the release is its package; one larger than the BUSY Bar takes is said.
   */
  async function latestRelease(github, found) {
    const release = await github.request("GET", `/repos/${encodeURIComponent(found.owner)}/${encodeURIComponent(found.name)}/releases/latest`).catch((e) => (e.code === "not_found" ? null : Promise.reject(e)));
    if (!release || typeof release !== "object") return { release: null, said: "it has no releases" };
    const tag = typeof release.tag_name === "string" ? release.tag_name.slice(0, 100) : "";
    const named = tag ? `its latest release ${tag}` : "its latest release";
    const assets = (Array.isArray(release.assets) ? release.assets : []).filter((one) => typeof one?.name === "string" && typeof one.browser_download_url === "string");
    const tgz = assets.find((one) => /\.tgz$/i.test(one.name));
    if (!tgz) {
      const others = assets.slice(0, 5).map((one) => one.name.slice(0, 100));
      return { release: null, said: others.length ? `${named} has no .tgz file, only ${others.join(", ")}${assets.length > 5 ? " and more" : ""}` : `${named} has no files` };
    }
    const size = Number(tgz.size) || 0;
    if (size > MAX_RELEASE_PACKAGE) return { release: null, said: `${named} has ${tgz.name.slice(0, 100)}, larger than the BUSY Bar takes (100 MiB)` };
    const version = /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1] ?? (tag || null);
    const page = typeof release.html_url === "string" && /^https:\/\/github\.com\//.test(release.html_url) ? release.html_url : `https://github.com/${found.owner}/${found.name}/releases`;
    return { release: { tag: tag || null, version, page, asset: { name: tgz.name.slice(0, 100), size, url: tgz.browser_download_url } } };
  }

  /** What a repository with neither an app project nor a release package has, in a sentence. */
  const noProject = (found, said) => `github.com/${found.owner}/${found.name} has no app project (no src/appmeta/manifest.json), and ${said}.`;

  /**
   * What Import from GitHub would get (reads only): { owner, name, page, branch, private, description, app, release,
   * nothing } — `app`: the id, name and version its src/appmeta/manifest.json has, or null when it has none (no BUSY
   * Bar app project). Then `release` is its latest release's app package ({ tag, version, page, asset: { name, size }
   * }), or null; with neither, `nothing` says what was found.
   */
  async function lookup({ repo }) {
    const { github, login: me } = await signedIn();
    try {
      const found = await repositoryNamed(github, me, repo);
      let app = null;
      const json = await github.textFile(found.owner, found.name, "src/appmeta/manifest.json").catch((e) => (e.code === "not_found" ? null : Promise.reject(e)));
      if (typeof json === "string") {
        try {
          const m = JSON.parse(json);
          app = { id: typeof m?.id === "string" ? m.id.slice(0, 100) : null, name: typeof m?.name === "string" ? m.name.slice(0, 100) : null, version: typeof m?.version === "string" ? m.version.slice(0, 40) : null };
        } catch {
          app = { id: null, name: null, version: null };
        }
      }
      let release = null;
      let nothing = null;
      if (!app) {
        const latest = await latestRelease(github, found);
        if (latest.release) release = { ...latest.release, asset: { name: latest.release.asset.name, size: latest.release.asset.size } };
        else nothing = noProject(found, latest.said);
      }
      return { ...found, page: `https://github.com/${found.owner}/${found.name}`, app, release, nothing };
    } catch (e) {
      if (e instanceof PublishError) throw e;
      if (e.code === "unauthorized") markStale();
      throw human(e);
    }
  }

  /**
   * Import from GitHub: the files of the repository's default branch, as its last commit has them, in a new folder
   * `folder` (which must not be there), read through GitHub CLI as the signed-in account (no git needed). Links and
   * submodules are left out and named; every file is checked against its sha. The files go into a folder beside it
   * first and it is renamed into place at the end, so a failure or Cancel leaves nothing half made. Resolves with
   * { owner, name, page, branch, commit, folder, files, skipped: [{ path, why }] }. `upload` hears the progress
   * ({ phase: "download", done, total, bytes, totalBytes, file }).
   */
  async function download({ repo, folder, progress = () => {}, upload = () => {} }) {
    if (pushing) throw new PublishError("busy", "An upload or a download is under way.", "Wait for it, or cancel it.");
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new PublishError("usage", "Choose where the project goes.", null);
    if (existsSync(folder)) throw new PublishError("folder_taken", `${folder} is there already.`, "Choose another location.");
    const stop = new AbortController();
    pushing = stop;
    const part = path.join(path.dirname(folder), `.${path.basename(folder)}.importing-${process.pid}`);
    try {
      const { github, login: me } = await signedIn({ fresh: true });
      const found = await repositoryNamed(github, me, repo);
      const at = `${found.owner}/${found.name}`;
      progress(`Reading github.com/${at}`);
      const head = await github.branchHead(found.owner, found.name, found.branch).catch((e) => (e.code === "conflict" ? null : Promise.reject(e)));
      if (!head) throw new PublishError("empty_repo", `github.com/${at} has no files yet.`, "Choose another repository.");
      const commit = await github.commit(found.owner, found.name, head);
      const tree = await github.request("GET", `/repos/${encodeURIComponent(found.owner)}/${encodeURIComponent(found.name)}/git/trees/${commit.tree.sha}?recursive=1`);
      if (tree?.truncated) throw new PublishError("too_many_files", `github.com/${at} is too large to import here.`, "Clone it with git, then open it in Open existing.");
      const skipped = [];
      const files = [];
      const seen = new Map();
      for (const one of tree?.tree ?? []) {
        if (one.type === "tree") continue;
        if (one.type === "commit") {
          skipped.push({ path: one.path, why: "a submodule" });
          continue;
        }
        if (one.type !== "blob") continue;
        if (one.mode === "120000") {
          skipped.push({ path: one.path, why: "a link" });
          continue;
        }
        const problem = pathProblem(one.path);
        if (problem) throw new PublishError("bad_path", `github.com/${at} has a file this computer can't keep as it is: ${String(one.path).slice(0, 200)} (${problem}).`, "Clone it with git instead, then open it in Open existing.");
        // Two names that differ in case only are one file on macOS and Windows.
        const key = one.path.toLowerCase();
        if (seen.has(key) && process.platform !== "linux") throw new PublishError("bad_path", `github.com/${at} has ${seen.get(key)} and ${one.path}, one file on this computer.`, "Rename one of them on GitHub, then import again.");
        seen.set(key, one.path);
        files.push({ path: one.path, sha: one.sha, size: Number(one.size) || 0, executable: one.mode === "100755" });
      }
      if (!files.length) throw new PublishError("empty_repo", `github.com/${at} has no files to import.`, "Choose another repository.");
      if (files.length > 2000) throw new PublishError("too_many_files", `github.com/${at} has ${files.length} files: Import from GitHub takes at most 2000.`, "Clone it with git, then open it in Open existing.");
      const totalBytes = files.reduce((sum, one) => sum + one.size, 0);
      if (totalBytes > MAX_PUSH_BYTES) throw new PublishError("too_large", `github.com/${at} holds ${Math.round(totalBytes / 1048576)} MB: Import from GitHub takes at most ${MAX_PUSH_BYTES / 1048576} MB.`, "Clone it with git, then open it in Open existing.");
      mkdirSync(part, { recursive: true });
      progress(`Downloading ${files.length} files`);
      const fact = { phase: "download", done: 0, total: files.length, bytes: 0, totalBytes, file: null };
      upload({ ...fact });
      let next = 0;
      const worker = async () => {
        while (next < files.length) {
          if (stop.signal.aborted) throw new PublishError("download_canceled", "The import was stopped. Nothing was kept.", null);
          const one = files[next++];
          upload({ ...fact, file: one.path });
          const bytes = await github.blob(found.owner, found.name, one.sha, { signal: stop.signal });
          const target = path.join(part, ...one.path.split("/"));
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, bytes);
          if (one.executable && process.platform !== "win32") chmodSync(target, 0o755);
          fact.done += 1;
          fact.bytes += bytes.length;
          upload({ ...fact, file: one.path });
        }
      };
      // Four at a time; one that fails stops the others, and every one has ended before the folder is taken away.
      let first = null;
      await Promise.allSettled(Array.from({ length: Math.min(4, files.length) }, () => worker().catch((e) => {
        first ??= e;
        stop.abort();
      })));
      if (first) throw first;
      if (existsSync(folder)) throw new PublishError("folder_taken", `${folder} is there already.`, "Choose another location.");
      renameSync(part, folder);
      log(`[github] imported github.com/${at} at ${head} into ${folder}`);
      return { owner: found.owner, name: found.name, page: `https://github.com/${at}`, branch: found.branch, commit: head, folder, files: files.length, skipped };
    } catch (e) {
      rmSync(part, { recursive: true, force: true });
      if (e instanceof PublishError) throw e;
      if (e.code === "canceled") throw new PublishError("download_canceled", "The import was stopped. Nothing was kept.", null);
      if (e.code === "unauthorized") markStale();
      throw human(e);
    } finally {
      if (pushing === stop) pushing = null;
    }
  }

  /**
   * Import from GitHub for a repository that is no app project: the app package of its latest release, downloaded into
   * the folder `into` (the data folder's own; it must be there and is left to the caller), read only. The release is
   * read anew (the page names the repository, never a file's address); the file comes over HTTPS from github.com and the
   * hosts it sends downloads to, no other, with no token sent, at most MAX_RELEASE_PACKAGE bytes and exactly the size
   * GitHub said. Resolves with { file, asset, size, tag, version, owner, name, page }.
   */
  async function downloadRelease({ repo, into, progress = () => {} }) {
    if (pushing) throw new PublishError("busy", "An upload or a download is under way.", "Wait for it, or cancel it.");
    if (typeof into !== "string" || !path.isAbsolute(into) || !existsSync(into)) throw new PublishError("usage", "There is no folder for the download.", null);
    const stop = new AbortController();
    pushing = stop;
    try {
      const { github, login: me } = await signedIn({ fresh: true });
      const found = await repositoryNamed(github, me, repo);
      const at = `github.com/${found.owner}/${found.name}`;
      progress(`Reading the latest release of ${at}`);
      const latest = await latestRelease(github, found);
      if (!latest.release) throw new PublishError("no_package", `${noProject(found, latest.said)} There is nothing to install.`, "Choose another repository, or ask its author for a release with the app's .tgz.");
      const { asset, tag, version, page } = latest.release;
      progress(`Downloading ${asset.name}`);
      const bytes = await fetchPackage(asset.url, stop.signal);
      if (asset.size && bytes.length !== asset.size) throw new PublishError("download_failed", `${asset.name} came with ${bytes.length} bytes, and GitHub said ${asset.size}.`, "Try again.");
      const file = path.join(into, PACKAGE_NAME.test(asset.name) ? asset.name : "release.tgz");
      writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      log(`[github] downloaded ${asset.name} (${bytes.length} bytes) of the release ${tag ?? "(no tag)"} of ${at}`);
      return { file, asset: asset.name, size: bytes.length, tag, version, owner: found.owner, name: found.name, page };
    } catch (e) {
      if (e instanceof PublishError) throw e;
      if (e.code === "canceled") throw new PublishError("download_canceled", "The download was stopped. Nothing was kept.", null);
      if (e.code === "unauthorized") markStale();
      throw human(e);
    } finally {
      if (pushing === stop) pushing = null;
    }
  }

  /** A release file's bytes, over the allowed hosts only, at most MAX_RELEASE_PACKAGE. */
  async function fetchPackage(address, signal) {
    let answer;
    try {
      answer = await getAllowed(address, { origins: releaseOrigins, transports: releaseTransports, signal });
    } catch (e) {
      if (signal.aborted) throw new PublishError("download_canceled", "The download was stopped. Nothing was kept.", null);
      if (e?.code === "bad_host") throw new PublishError("download_failed", "GitHub sent the download to a host that is not its own, so it was not taken.", null);
      if (e?.code === "not_found") throw new PublishError("download_failed", "GitHub has no such file to download: the release may be private or gone.", "Download the package in the browser, then install it with Install a package.");
      throw new PublishError("download_failed", `The package could not be downloaded (${String(e?.message ?? e).slice(0, 200)}).`, "Check the network, then try again.");
    }
    return new Promise((resolve, reject) => {
      const parts = [];
      let size = 0;
      answer.res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RELEASE_PACKAGE) {
          answer.req.destroy();
          reject(new PublishError("too_large", "The package is larger than the BUSY Bar takes (100 MiB).", null));
        } else parts.push(chunk);
      });
      answer.res.on("end", () => resolve(Buffer.concat(parts)));
      answer.res.on("error", (e) => reject(signal.aborted ? new PublishError("download_canceled", "The download was stopped. Nothing was kept.", null) : new PublishError("download_failed", `The download broke off (${e?.code ?? e?.message ?? e}).`, "Try again.")));
    });
  }

  return { record, status, accounts, cliAccount, knownLogin, useExisting, signIn, waitSignIn, cancelSignIn, openCodePage, signOut, plan, push, cancel, checklist, request, requestTarget, pullState, parseCatalog, entry, lookup, download, downloadRelease, signers, chooseSigner, signerOf: signerNow };
}
