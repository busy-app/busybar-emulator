#!/usr/bin/env node
// What the bundled GitHub CLI says, the words the app reads (src/github/gh.mjs, publish-flow.mjs), recorded from the
// pinned gh itself into test/fixtures/gh-texts.json, so that the tests' stand-in (test/fixtures/fake-gh.mjs) prints
// exactly that and a bump of the pinned gh fails a test until they are recorded again (test/unit/gh-texts.test.mjs).
//
//   node tools/gh-texts.mjs record [--gh <path>]   macOS only. Writes the fixture: the format strings the app reads,
//                                                 found in the binary; what gh prints offline (config get, auth token,
//                                                 auth switch, auth logout, api without a sign-in), run in a throwaway
//                                                 configuration; and one live start of the sign-in (gh auth login --web)
//                                                 against github.com up to the code, which is never entered
//   node tools/gh-texts.mjs check  [--gh <path>]   the same, compared with the fixture; exit code 1 when gh says
//                                                 anything else. `npm run live:gh` (never in a gate: it asks github.com
//                                                 for sign-in codes, three on macOS, one on Windows, which also leaves
//                                                 out the offline runs that reach the system's store)
//
// --gh: the gh to ask; by default the pinned one, staged from the build's cache (tools/bundled-gh.mjs) into a temporary
// folder. Every run has a configuration folder, a home and gh's state, data and cache folders of its own in a temporary
// folder, removed after; no token from the environment. On macOS each gh runs under sandbox-exec with the keychain out
// of reach: gh asks the system's store under the host's name whatever its configuration folder says, and must find
// nothing there (and switch and logout delete the store's item for the host); elsewhere the runs that reach the store
// are left out, and so is any `check` of them. Nothing reaches the clipboard: the sign-in that copies the code is given a pbcopy of its own that
// keeps nothing; Windows copies through the system itself, so there only the variant without copying is started.
// The sign-in is ended as soon as its code is shown: no account is ever signed in.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loginReader } from "../src/github/gh.mjs";
import { defaultCacheDir, fetchArchive, readPin, stageGh } from "./bundled-gh.mjs";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const FIXTURE = path.join(APP_DIR, "test", "fixtures", "gh-texts.json");

/** The format strings of gh's source that print what the app reads (gh 2.103.3's file and line in the comment). */
export const FORMATS = Object.freeze({
  codeCopied: "%s One-time code (%s) copied to clipboard\n", // internal/authflow/flow.go
  copyFailed: "%s Failed to copy one-time code to clipboard\n", // internal/authflow/flow.go
  firstCopy: "%s First copy your one-time code: %s\n", // internal/authflow/flow.go
  openUrl: "%s to continue in your web browser: %s\n", // internal/authflow/flow.go, with "Open this URL"
  openUrlWords: "Open this URL",
  webFailed: "failed to authenticate via web browser: %w", // pkg/cmd/auth/shared/login_flow.go
  authComplete: "%s Authentication complete.", // pkg/cmd/auth/shared/login_flow.go
  loggedInAs: "%s Logged in as %s\n", // pkg/cmd/auth/shared/login_flow.go
  plainText: "%s Authentication credentials saved in plain text\n", // pkg/cmd/auth/shared/login_flow.go
  noToken: "no oauth token found for %s", // pkg/cmd/auth/token/token.go, + " account %s"
  switched: "%s Switched active account for %s to %s\n", // pkg/cmd/auth/switch/switch.go, logout.go
  loggedOut: "%s Logged out of %s account %s\n", // pkg/cmd/auth/logout/logout.go
  notLoggedIn: "not logged in to %s account %s", // pkg/cmd/auth/switch/switch.go, logout.go
  noMatch: "no accounts matched that criteria", // pkg/cmd/auth/switch/switch.go, logout.go
  noKey: 'could not find key "%s"', // pkg/cmd/config/get/get.go
});

/** A configuration with two accounts, their (made-up) tokens in plain text: what the offline commands run on. */
const TWO_ACCOUNTS = {
  "hosts.yml": "github.com:\n    users:\n        fake-alice:\n            oauth_token: gho_dummy_alice\n        fake-bob:\n            oauth_token: gho_dummy_bob\n    git_protocol: https\n    oauth_token: gho_dummy_bob\n    user: fake-bob\n",
  "config.yml": 'version: "1"\n',
};

/**
 * What is run offline: [id, arguments, the configuration's files, whether it reaches the system's store]. gh api
 * without a token reads the store's item for the host alone (the person's active token, whatever the configuration
 * folder), and switch and logout delete that item: those run only where the store is out of reach (macOS, sandboxed).
 */
const OFFLINE = [
  ["version", ["--version"], {}],
  ["configNoUser", ["config", "get", "--host", "github.com", "user"], {}],
  ["tokenNoAccount", ["auth", "token", "--hostname", "github.com", "--user", "fake-carol"], TWO_ACCOUNTS],
  ["apiNoSignIn", ["api", "/user", "--hostname", "github.com", "--method", "GET", "--include"], {}, "store"],
  ["switched", ["auth", "switch", "--hostname", "github.com", "--user", "fake-alice"], TWO_ACCOUNTS, "store"],
  ["switchUnknown", ["auth", "switch", "--hostname", "github.com", "--user", "fake-carol"], TWO_ACCOUNTS],
  ["loggedOutActive", ["auth", "logout", "--hostname", "github.com", "--user", "fake-bob"], TWO_ACCOUNTS, "store"],
  ["logoutUnknown", ["auth", "logout", "--hostname", "github.com", "--user", "fake-carol"], TWO_ACCOUNTS],
];

/** The sign-in as the app starts it (publish-flow.mjs), in each way gh may show the code. */
export const LOGIN_ARGS = Object.freeze(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"]);
const VARIANTS = [
  // gh's default: it copies the code (here into a pbcopy that keeps nothing).
  { id: "copied", clipboard: "keeps-nothing", darwinOnly: true },
  // No program to copy with.
  { id: "copyFailed", clipboard: "none", darwinOnly: true },
  // The person's GitHub CLI says `clipboard: disabled`.
  { id: "notCopied", clipboard: "disabled" },
];

const NO_KEYCHAIN = `(version 1)
(allow default)
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.secd"))
(deny file-read* file-write* (subpath "${path.join(os.homedir(), "Library", "Keychains")}") (subpath "/Library/Keychains"))
`;

/** A throwaway place for one gh run: { root, env, command, prefix }. */
function place(gh, { files = {}, pathDirs = [] } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gh-texts-")));
  for (const name of ["home", "config", "state", "data", "cache"]) mkdirSync(path.join(root, name));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(root, "config", name), text);
  const win = process.platform === "win32";
  const env = {
    PATH: [...pathDirs, win ? path.join(process.env.SystemRoot || "C:\\Windows", "System32") : "/usr/bin:/bin"].join(path.delimiter),
    HOME: path.join(root, "home"),
    GH_CONFIG_DIR: path.join(root, "config"),
    XDG_CONFIG_HOME: path.join(root, "home"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    GH_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GH_PAGER: "",
  };
  if (win) for (const name of ["SystemRoot", "windir", "TEMP", "TMP"]) if (process.env[name]) env[name] = process.env[name];
  if (win) Object.assign(env, { USERPROFILE: path.join(root, "home"), APPDATA: path.join(root, "home"), LOCALAPPDATA: path.join(root, "home") });
  if (process.platform !== "darwin") return { root, env, command: gh, prefix: [] };
  const profile = path.join(root, "no-keychain.sb");
  writeFileSync(profile, NO_KEYCHAIN);
  return { root, env, command: "/usr/bin/sandbox-exec", prefix: ["-f", profile, gh] };
}

/** The fixture's form of what gh printed: the run's folders, codes and Windows line ends as placeholders. */
export function normalise(text, root) {
  let out = String(text).replace(/\r\n/g, "\n");
  if (root) out = out.split(root).join("{root}");
  return out.replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "{code}");
}

/** True when a program run in place() cannot reach the keychain: the sandbox works. */
function keychainOutOfReach(gh) {
  const at = place(gh);
  try {
    return spawnSync("/usr/bin/sandbox-exec", ["-f", at.prefix[1], "/usr/bin/security", "list-keychains"], { encoding: "utf8" }).status !== 0;
  } finally {
    rmSync(at.root, { recursive: true, force: true });
  }
}

function offline(gh) {
  const out = {};
  const sandboxed = process.platform === "darwin";
  if (sandboxed && !keychainOutOfReach(gh)) throw new Error("sandbox-exec did not keep the keychain out of reach: nothing was run");
  for (const [id, args, files, store] of OFFLINE) {
    if (store && !sandboxed) continue;
    const at = place(gh, { files });
    try {
      const done = spawnSync(at.command, [...at.prefix, ...args], { env: at.env, cwd: at.root, encoding: "utf8", timeout: 30_000, windowsHide: true });
      out[id] = { args, code: done.status, stdout: normalise(done.stdout, at.root), stderr: normalise(done.stderr, at.root) };
    } finally {
      rmSync(at.root, { recursive: true, force: true });
    }
  }
  return out;
}

/** One live start of the sign-in, ended once the code is shown: gh's error output up to there, and what the app read. */
function live(gh, variant) {
  const bin = mkdtempSync(path.join(os.tmpdir(), "gh-texts-bin-"));
  const pathDirs = [];
  if (variant.clipboard === "keeps-nothing") {
    writeFileSync(path.join(bin, "pbcopy"), "#!/bin/sh\ncat > /dev/null\n");
    chmodSync(path.join(bin, "pbcopy"), 0o755);
    pathDirs.push(bin);
  }
  // Without a pbcopy: no folder on PATH holds one (macOS keeps it in /usr/bin, which is left out).
  const at = place(gh, { files: variant.clipboard === "disabled" ? { "config.yml": 'version: "1"\nclipboard: disabled\n' } : {}, pathDirs });
  if (variant.clipboard === "none") at.env.PATH = bin;
  return new Promise((resolve) => {
    const child = spawn(at.command, [...at.prefix, ...LOGIN_ARGS], { env: at.env, cwd: at.root, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const reader = loginReader();
    let stderr = "";
    let shown = null;
    let why = null;
    const timer = setTimeout(() => end("no code in 30 s"), 30_000);
    const end = (reason) => {
      why ??= reason;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Gone already.
      }
    };
    child.once("close", (code) => {
      clearTimeout(timer);
      rmSync(at.root, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
      resolve({ stderr: normalise(stderr, at.root), shown: shown && { ...shown, userCode: "{code}" }, why: why ?? `gh ended with ${code}` });
    });
    child.stdout.resume();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      shown ??= reader.take(chunk);
      if (shown) end("code shown");
    });
    child.stdin.end();
  });
}

/** The pinned gh for this system, staged into a temporary folder from the build's cache. */
async function pinnedGh() {
  const pin = readPin();
  const target = `${process.platform}-${process.arch}`;
  const resourcesDir = mkdtempSync(path.join(os.tmpdir(), "gh-texts-gh-"));
  const archive = await fetchArchive({ pin, target, cacheDir: defaultCacheDir(), log: (line) => console.error(line) });
  const staged = stageGh({ pin, target, archive, resourcesDir });
  return { gh: staged.gh, version: pin.version, cleanup: () => rmSync(resourcesDir, { recursive: true, force: true }) };
}

/** Which of FORMATS the binary holds, byte for byte. */
export function formatsIn(binary) {
  const bytes = readFileSync(binary);
  return Object.fromEntries(Object.entries(FORMATS).map(([id, format]) => [id, bytes.includes(Buffer.from(format, "utf8"))]));
}

async function gather(gh, { variants }) {
  const sessions = {};
  for (const variant of variants) sessions[variant.id] = await live(gh, variant);
  return { formats: formatsIn(gh), offline: offline(gh), live: sessions };
}

/** Where the fixture and what gh says now differ: one line each. */
export function differences(fixture, now) {
  const found = [];
  for (const [id, there] of Object.entries(now.formats)) if (!there) found.push(`the binary no longer holds the format ${id}: ${JSON.stringify(FORMATS[id])}`);
  for (const [id, run] of Object.entries(now.offline)) {
    const was = fixture.offline?.[id];
    if (!was) found.push(`offline ${id}: not in the fixture`);
    else for (const key of ["code", "stdout", "stderr"]) if (was[key] !== run[key]) found.push(`offline ${id}: ${key} was ${JSON.stringify(was[key])}, now ${JSON.stringify(run[key])}`);
  }
  for (const [id, session] of Object.entries(now.live)) {
    const was = fixture.live?.[id];
    if (!session.shown) found.push(`live ${id}: no code shown (${session.why}); gh said ${JSON.stringify(session.stderr.slice(0, 400))}`);
    else if (!was) found.push(`live ${id}: not in the fixture`);
    else if (was.stderr !== session.stderr) found.push(`live ${id}: gh said ${JSON.stringify(session.stderr)}, the fixture says ${JSON.stringify(was.stderr)}`);
  }
  return found;
}

async function main(argv) {
  const args = [...argv];
  const at = args.indexOf("--gh");
  const given = at >= 0 ? path.resolve(args.splice(at, 2)[1]) : null;
  const [command] = args;
  if (!["record", "check"].includes(command)) {
    console.error("usage: gh-texts.mjs record | check   [--gh <path>]");
    process.exit(2);
  }
  if (command === "record" && process.platform !== "darwin") throw new Error("record runs on macOS only, where the keychain can be kept out of reach");
  const pinned = given ? null : await pinnedGh();
  const gh = given ?? pinned.gh;
  try {
    const variants = VARIANTS.filter((one) => !one.darwinOnly || process.platform === "darwin");
    const now = await gather(gh, { variants });
    const version = /gh version (\S+)/.exec(now.offline.version.stdout)?.[1] ?? null;
    if (command === "record") {
      const missing = Object.entries(now.formats).filter(([, there]) => !there).map(([id]) => id);
      if (missing.length) throw new Error(`the binary does not hold ${missing.join(", ")}: look at gh's source and update FORMATS`);
      const fixture = { gh: version, recorded: new Date().toISOString().slice(0, 10), by: "node tools/gh-texts.mjs record", formats: FORMATS, offline: now.offline, live: Object.fromEntries(Object.entries(now.live).map(([id, one]) => [id, { stderr: one.stderr, shown: one.shown }])) };
      for (const [id, one] of Object.entries(fixture.live)) if (!one.shown) throw new Error(`live ${id}: gh showed no code: ${now.live[id].why}`);
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`${FIXTURE}: gh ${version}`);
      return;
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const found = version === fixture.gh ? differences(fixture, now) : [`the fixture is of gh ${fixture.gh}, this gh is ${version}: record it again (node tools/gh-texts.mjs record)`, ...differences(fixture, now)];
    for (const [id, session] of Object.entries(now.live)) console.log(`live ${id}: ${session.why}${session.shown ? `, the app reads ${JSON.stringify(session.shown)}` : ""}`);
    if (found.length) {
      console.error(`gh-texts: gh ${version} says what the fixture does not:\n${found.map((line) => `  ${line}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`gh-texts: gh ${version} says what the fixture says (${Object.keys(now.offline).length} offline runs, ${Object.keys(now.live).length} sign-in starts, ${Object.keys(now.formats).length} formats)`);
  } finally {
    pinned?.cleanup();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`gh-texts: ${e.message}`);
    process.exit(1);
  });
}
