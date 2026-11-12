// What looks like a secret or personal data among a project's files, before they go into a public repository: files
// that hold secrets by their name (.env, private keys), keys and tokens in the known formats of the services, a long
// value given to a key named like a secret, and paths of a person's home folder. The patterns are a part of the
// export check's (tools/export-check/rules.mjs), which guards this emulator's own public repository. Values are never
// returned: a finding says the file, the line and what kind of thing it is.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;

const TOKENS = [
  ["a GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["an OpenAI or Anthropic key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["a Stripe key", /\b[rs]k_live_[A-Za-z0-9]{16,}\b/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{36}\b|_authToken\s*=\s*[^\s"']{8,}/],
  ["an AWS key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Slack token or webhook", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b|hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/],
  ["a Discord webhook", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/],
  ["a Telegram bot token", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/],
  ["a Google key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["a private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["a JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["an authorization header", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/],
];
// key = "long random value" in any language.
const ASSIGNED = /\b(?:api[_-]?key|apikey|secret|token|private[_-]?key|access[_-]?key|client[_-]?secret|password|passwd)["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;
// The same without quotes, alone on a line, in configuration files (.env, YAML, ini).
const ASSIGNED_BARE = /^\s*(?:export\s+)?[\w.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key)[\w.-]*\s*[:=]\s*([^\s"'#]{8,})\s*$/i;
const CONFIG_FILE = /(?:^|\/)\.?(?:env(?:\.[\w.-]+)?|[\w.-]+\.(?:env|ya?ml|ini|cfg|conf|properties|toml|txt|npmrc|netrc))$/i;
const PLACEHOLDER = /^(?:x+|\*+|0+|<.*>|\$\{?[\w.]+\}?|%\w+%|\{\{.*\}\}|password|secret|null|none|true|false)$|placeholder|example|changeme|dummy|^your[-_]/i;
// A home folder: /Users/<name>, /home/<name>, C:\Users\<name>.
const HOME = /(?:\/Users\/|\/home\/|(?<![A-Za-z])[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))([^/\\\s"'`<>:*?|,;()[\]{}]+)/i;
const HOME_PLACEHOLDER = /^(?:<[^>]*>|\$\w+|%\w+%|you|your-?name|username|user|name|me|runner|shared|public|default|\.\.\.)$/i;

/** A file that holds secrets by its name. */
const SECRET_NAME = [
  [/(?:^|\/)\.env(?:\.[^/]*)?$/i, "an environment file (.env): it usually holds keys and passwords"],
  [/(?:^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$|\.(?:pem|key|p12|pfx)$/i, "a key file"],
  [/(?:^|\/)\.(?:npmrc|netrc)$/i, "a file that may hold a token"],
];
// Files the template ships that name an environment file only as an example.
const EXAMPLE_NAME = /(?:^|\/)\.env\.(?:example|sample|template)$/i;

function readSmall(file) {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    const bytes = readFileSync(file);
    // A file with a zero byte early is not text.
    if (bytes.subarray(0, 8000).includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

/** What is found in one text: [{ line, kind }]. */
export function scanText(text, rel) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.length > 4000) line = line.slice(0, 4000);
    for (const [kind, re] of TOKENS) if (re.test(line)) found.push({ line: i + 1, kind });
    const assigned = ASSIGNED.exec(line);
    if (assigned && !PLACEHOLDER.test(assigned[1]) && !/[()[\]{}`$]/.test(assigned[1])) found.push({ line: i + 1, kind: "a value given to a key named like a secret" });
    else if (CONFIG_FILE.test(rel)) {
      const bare = ASSIGNED_BARE.exec(line);
      if (bare && !PLACEHOLDER.test(bare[1])) found.push({ line: i + 1, kind: "a value given to a key named like a secret" });
    }
    const home = HOME.exec(line);
    if (home && !HOME_PLACEHOLDER.test(home[1])) found.push({ line: i + 1, kind: "a path of a person's home folder, which names them" });
  });
  // One finding of a kind per line.
  return found.filter((one, i) => found.findIndex((other) => other.line === one.line && other.kind === one.kind) === i);
}

/**
 * The findings among a project's files. `published` and `left` are projectTree()'s lists: a file that is published
 * is read; one left out is named only when its name says it holds secrets (it is kept out, and that is said too).
 * @returns {{ path: string, published: boolean, kind: string, lines: number[] }[]}
 */
export function scanProject(dir, { published, left }) {
  const findings = [];
  const add = (rel, isPublished, kind, lines = []) => findings.push({ path: rel, published: isPublished, kind, lines });
  for (const rel of published) {
    const byName = !EXAMPLE_NAME.test(rel) && SECRET_NAME.find(([re]) => re.test(rel));
    const text = readSmall(path.join(dir, ...rel.split("/")));
    const inside = text === null ? [] : scanText(text, rel);
    if (byName) add(rel, true, byName[1], inside.map((one) => one.line));
    const kinds = new Map();
    for (const one of byName ? [] : inside) kinds.set(one.kind, [...(kinds.get(one.kind) ?? []), one.line]);
    for (const [kind, lines] of kinds) add(rel, true, kind, lines.slice(0, 5));
  }
  for (const entry of left) {
    if (entry.folder) continue;
    const byName = !EXAMPLE_NAME.test(entry.path) && SECRET_NAME.find(([re]) => re.test(entry.path));
    if (byName) add(entry.path, false, byName[1]);
  }
  return findings;
}
