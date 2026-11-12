// GitHub CLI (gh) inside the app (Publish stage 2): the one program that signs the person in to GitHub, keeps the token
// and makes every call to GitHub. The app never holds a GitHub token: it starts gh, gives it what to send on its
// standard input and reads its answer.
//
// The gh is the one bundled with the app (tools/bundled-gh.mjs: one pinned release of github.com/cli/cli, checked by
// the release's checksums; signed and notarised by GitHub on macOS). A development run and the test variant may name
// another (config.mjs: BUSY_EMULATOR_GH, the tests' stand-in, test/fixtures/fake-gh.mjs); a release never does.
//
// gh's accounts are the person's own (decision of 11 Nov 2026, after the first version kept them apart): gh keeps its
// tokens in the system's store under names of the host alone ("gh:github.com", with the login, and an empty account
// for the active one) whatever GH_CONFIG_DIR says (gh 2.103.3's internal/config/config.go, zalando/go-keyring 0.2.8,
// and seen on a Mac), so a configuration of the app's own could not keep them apart anyway: it only made the two
// disagree. So gh runs with the person's own configuration folder (personGhConfigDir: ~/.config/gh, or
// %APPDATA%\GitHub CLI): a GitHub CLI signed in on this computer is offered as it is (publish-flow.mjs, "Use
// <login>"), a sign-in here adds an account to it and makes it the active one (gh 2.40 and later keep several), and
// nothing here ever signs out an account the person had before. gh's state, data and cache folders are the app's
// (<data>/github/gh-*); no prompt, no update notice, no spinner, no telemetry, github.com only, and no token from the
// environment (GH_TOKEN, GITHUB_TOKEN and every other GH_ and GITHUB_ variable are dropped). Never --insecure-storage:
// gh keeps the token in the system's store (the login keychain on macOS, Credential Manager on Windows). On macOS gh
// reaches the login keychain through /usr/bin/security, which made the items and is the one program they trust: no
// dialog, for any gh.
//
// gh keeps several accounts for github.com (2.40 and later): the person chooses one in the window, and the app's
// calls go as that account without changing the one GitHub CLI uses (gh auth switch would change it for the person's
// other programs too). For each call the app asks gh for that account's token (`gh auth token --user <login>`) and
// gives it to the gh api it starts, in GH_TOKEN of that one process's environment: the token passes through the app's
// main process, is never written, logged or sent to the page, and is kept in memory for a few minutes at most
// (publish-flow.mjs). The app never runs gh auth status (it asks GitHub about every account). Which accounts GitHub CLI
// has, and which one it uses, is read from gh's configuration (hosts.yml, `gh config get -h github.com user`): no
// secret, no network.
import { startShellProgram } from "../processes.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

export const GH_HOST = "github.com";
/** GitHub's REST API version the app is written for. */
export const API_VERSION = "2022-11-28";
/** One call of gh api: well over GitHub's own time for a request, a blob of 50 MB included. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** The sign-in: GitHub's code lives 15 minutes. */
export const SIGN_IN_TIMEOUT_MS = 16 * 60_000;
/** How long gh may take to show the code. */
export const CODE_TIMEOUT_MS = 30_000;
/** Where the person revokes access: GitHub's list of authorised OAuth apps, where gh is "GitHub CLI". */
export const REVOKE_PAGE = "https://github.com/settings/applications";
/** Where the person enters the code: what gh names must be on github.com, or it is not shown. */
export const DEVICE_PAGE = /^https:\/\/github\.com\/login\/device(?:[/?#]|$)/;
const USER_CODE = /^[A-Z0-9]{4,8}-?[A-Z0-9]{4,8}$/;
/** What gh may answer on its standard output: the largest file is 50 MB, a tree's answer a few MB. */
const MAX_STDOUT = 160 * 1024 * 1024;
const MAX_STDERR = 256 * 1024;
/** gh's exit code when it has no token for the host (internal/ghcmd/cmd.go, exitAuth). */
export const EXIT_AUTH = 4;

/** gh's own folders in the app's data folder: its state, data and cache (its configuration is the person's). */
export function ghFolders(dataDir) {
  const root = path.join(dataDir, "github");
  return { root, state: path.join(root, "gh-state"), share: path.join(root, "gh-data"), cache: path.join(root, "gh-cache") };
}

/** Where gh keeps its configuration when nothing in the environment says otherwise (gh's own default). */
export function personGhConfigDir({ platform, home, appDataDir }) {
  return platform === "win32" ? path.win32.join(appDataDir, "GitHub CLI") : path.posix.join(home, ".config", "gh");
}

/** A GitHub login as gh's configuration may hold it: what the app passes to gh as --user. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * The environment gh runs with: the caller's, without anything that would make gh use another token, another host,
 * another configuration than `configDir` or a prompt.
 */
export function ghEnvironment(env, dataDir, configDir) {
  if (typeof configDir !== "string" || !configDir) throw new TypeError("no configuration folder for gh");
  const folders = ghFolders(dataDir);
  const out = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    // GH_TOKEN, GH_ENTERPRISE_TOKEN, GH_HOST, GH_CONFIG_DIR, GH_DEBUG (it prints requests), GH_REPO, GH_PATH ...;
    // GITHUB_TOKEN, GITHUB_ENTERPRISE_TOKEN, GITHUB_API_URL, GITHUB_SERVER_URL ...; the XDG folders, set below.
    if (upper.startsWith("GH_") || upper.startsWith("GITHUB_") || upper.startsWith("XDG_")) continue;
    if (["DEBUG", "PAGER", "NO_COLOR", "CLICOLOR", "CLICOLOR_FORCE", "DO_NOT_TRACK", "BROWSER"].includes(upper)) continue;
    out[name] = value;
  }
  return Object.assign(out, {
    GH_CONFIG_DIR: configDir,
    XDG_STATE_HOME: folders.state,
    XDG_DATA_HOME: folders.share,
    XDG_CACHE_HOME: folders.cache,
    GH_HOST,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    GH_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    GH_PAGER: "",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
}

/**
 * Runs gh: { code, stdout (Buffer), stderr, timedOut, aborted }. Never through a shell; the arguments are the app's
 * own. `onStderr` hears gh's error output as it comes (the sign-in's code).
 * @param {{ command: string, prefix?: string[], env: object, cwd: string, spawnImpl?: Function }} o
 */
export function ghRunner({ command, prefix = [], env, cwd, spawnImpl = startShellProgram }) {
  return function run(args, { input = null, timeoutMs = REQUEST_TIMEOUT_MS, signal = null, onStderr = null, token = null } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        // A call as one of GitHub CLI's accounts: its token in this one process's environment (never in its arguments).
        const own = typeof token === "string" && token ? { ...env, GH_TOKEN: token } : env;
        child = spawnImpl(command, [...prefix, ...args], { env: own, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
      } catch (e) {
        resolve({ code: null, stdout: Buffer.alloc(0), stderr: `gh could not be started: ${e.code ?? e.message}`, timedOut: false, aborted: false });
        return;
      }
      const out = [];
      let outBytes = 0;
      let err = "";
      let timedOut = false;
      let aborted = false;
      let settled = false;
      const stop = () => {
        try {
          child.kill();
        } catch {
          // Gone already.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = () => {
        aborted = true;
        stop();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk) => {
        outBytes += chunk.length;
        if (outBytes > MAX_STDOUT) return stop();
        out.push(chunk);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => {
        if (err.length < MAX_STDERR) err += text;
        onStderr?.(text);
      });
      const finish = (code, startError = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ code, stdout: Buffer.concat(out), stderr: startError ? `gh could not be started: ${startError}` : err, timedOut, aborted, tooLarge: outBytes > MAX_STDOUT });
      };
      child.on("error", (e) => finish(null, e.code ?? e.message));
      child.on("close", (code) => finish(code));
      child.stdin.on("error", () => {});
      if (input !== null && input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  };
}

/** gh api --include's output: the status line, the headers, an empty line, the body. Null when it is not that. */
export function parseApiOutput(stdout) {
  const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ""));
  if (bytes.subarray(0, 5).toString("latin1") !== "HTTP/") return null;
  let end = bytes.indexOf("\r\n\r\n");
  let gap = 4;
  if (end < 0) {
    end = bytes.indexOf("\n\n");
    gap = 2;
  }
  const head = (end < 0 ? bytes : bytes.subarray(0, end)).toString("latin1").split(/\r?\n/);
  const m = /^HTTP\/[0-9.]+ (\d{3})(?: .*)?$/.exec(head[0]);
  if (!m) return null;
  const headers = new Headers();
  for (const line of head.slice(1)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    try {
      headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
    } catch {
      // A header Node would not take: not one the app reads.
    }
  }
  return { status: Number(m[1]), headers, text: end < 0 ? "" : bytes.subarray(end + gap).toString("utf8") };
}

/** gh's error output, as one line the log may hold: no long run of token-like characters, at most 300 of them. */
export function cleanLine(text) {
  const line = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((one) => one.trim()).filter(Boolean).at(-1) ?? "";
  return line.replace(/[A-Za-z0-9_]{36,}/g, "…").slice(0, 300);
}

/** What gh's failure to reach GitHub looks like on its error output. */
const NETWORK = /dial tcp|no such host|connection refused|network is unreachable|i\/o timeout|tls handshake|connection reset|EOF$|could not resolve|timeout awaiting/i;

/** The API path a request names: one of api.github.com's, from the app's own code, never an address or a flag. */
export function checkApiPath(apiPath) {
  if (typeof apiPath !== "string" || !/^\/[A-Za-z0-9/_.~%?&=,+-]*$/.test(apiPath) || apiPath.startsWith("//")) throw new TypeError(`not an API path: ${JSON.stringify(String(apiPath).slice(0, 200))}`);
  return apiPath;
}

/**
 * The transport github-api.mjs sends its requests by: gh api, JSON on its standard input. Resolves with
 * { status, headers, text } for every answer GitHub gave (an error's too), or with { failure: "network" | "auth" |
 * "timeout" | "canceled" | "no_account", detail } when there was none. `token()`: the token of the account the call
 * goes as (accountToken), or null for GitHub CLI's own; `signal` of a call ends its gh.
 */
export function ghTransport(run, { timeoutMs = REQUEST_TIMEOUT_MS, token = null } = {}) {
  return {
    async request(method, apiPath, body, { signal = null } = {}) {
      if (!/^(GET|POST|PATCH|PUT|DELETE)$/.test(method)) throw new TypeError(`not a method: ${method}`);
      checkApiPath(apiPath);
      if (signal?.aborted) return { failure: "canceled", detail: "stopped" };
      let own = null;
      if (token) {
        own = await token();
        if (own?.failure) return own;
      }
      const args = ["api", apiPath, "--hostname", GH_HOST, "--method", method, "--include", "-H", "Accept: application/vnd.github+json", "-H", `X-GitHub-Api-Version: ${API_VERSION}`];
      if (body !== undefined) args.push("--input", "-");
      const done = await run(args, { input: body === undefined ? null : JSON.stringify(body), timeoutMs, signal, token: own });
      if (done.aborted) return { failure: "canceled", detail: "stopped" };
      if (done.timedOut) return { failure: "timeout", detail: "gh did not answer in time" };
      const answer = parseApiOutput(done.stdout);
      if (answer) return answer;
      if (done.code === EXIT_AUTH) return { failure: "auth", detail: cleanLine(done.stderr) };
      return { failure: "network", detail: cleanLine(done.stderr) || `gh ended with ${done.code}` };
    },
  };
}

/**
 * The token of one of GitHub CLI's accounts, for the calls that go as it: `gh auth token --hostname github.com --user
 * <login>`. Resolves with the token, or with { failure: "no_account" } when GitHub CLI has no sign-in for it (signed out
 * in a terminal) and { failure: "network" } when gh could not be run.
 *
 * `active`: the account is GitHub CLI's active one (hosts.yml `user`). When --user finds no token for it, its token is
 * GitHub CLI's active token, and `gh auth token --hostname github.com` is asked for that: so it is in a configuration
 * of gh 2.39 and older (ghSettings, "single"), which gh 2.103 reads but no longer converts: the account has no entry
 * under `users`, and its token lies beside it in hosts.yml or in the system's store under the host alone
 * (docs/spikes/gh-compat-2026-11-12.md). Whoever the token is for, the flow asks GitHub and compares the login.
 */
export async function accountToken(run, login, { active = false } = {}) {
  if (!LOGIN.test(login ?? "")) return { failure: "no_account", detail: "no account" };
  const read = async (args) => {
    const out = await run(args, { timeoutMs: 30_000 });
    const token = out.code === 0 ? out.stdout.toString("utf8").trim() : "";
    return { out, token: token && !/\s/.test(token) ? token : null };
  };
  let { out, token } = await read(["auth", "token", "--hostname", GH_HOST, "--user", login]);
  if (!token && active && out.code !== null && !out.timedOut) ({ out, token } = await read(["auth", "token", "--hostname", GH_HOST]));
  if (token) return token;
  if (out.code === null || out.timedOut) return { failure: "network", detail: cleanLine(out.stderr) || "gh did not answer" };
  return { failure: "no_account", detail: cleanLine(out.stderr) || `gh ended with ${out.code}` };
}

/** The version of GitHub CLI's configuration the bundled gh knows (config.yml `version`, written since gh 2.40). */
export const GH_SETTINGS_VERSION = 1;

/**
 * What GitHub CLI's configuration folder holds for github.com, from its files alone (no gh run, no secret kept):
 * { version, layout, user, newer }.
 *   version  config.yml's `version` as a number, or null when it has none (gh 2.39 and older)
 *   layout   "none": no account; "multi": accounts under `users` (gh 2.40 and later); "single": one account in `user`
 *            and nothing under `users` (written by gh 2.39 or older and never converted since: gh 2.40 to 2.102
 *            convert it whenever they run, 2.103 no longer does)
 *   user     the account hosts.yml names as the active one
 *   newer    the version is higher than GH_SETTINGS_VERSION: written by a newer GitHub CLI than the bundled one
 */
export function ghSettings(configDir, read = (file) => readFileSync(file, "utf8")) {
  const text = (name) => {
    try {
      return configDir ? read(path.join(configDir, name)) : "";
    } catch {
      return "";
    }
  };
  // gh writes `version: "1"`, or `{version: "1"}` into a config.yml that was empty ({}), as gh 2.40 does.
  const said = /(?:^|[{,][ \t]*)version:[ \t]*["']?([0-9]+)["']?/m.exec(text("config.yml"));
  const version = said ? Number(said[1]) : null;
  const unquote = (value) => value.replace(/^(["'])(.*)\1$/, "$2");
  let inHost = false;
  let inUsers = false;
  let users = 0;
  let user = null;
  for (const line of text("hosts.yml").split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inHost = /^(["']?)github\.com\1:\s*$/.test(line);
      inUsers = false;
      continue;
    }
    if (!inHost) continue;
    const key = /^ {4}([^\s:]+):[ \t]*(\S*)/.exec(line);
    if (key) {
      inUsers = key[1] === "users";
      if (key[1] === "user" && LOGIN.test(unquote(key[2]))) user = unquote(key[2]);
      continue;
    }
    if (inUsers && /^ {8}[^\s:][^:]*:/.test(line)) users += 1;
  }
  return { version, layout: users > 0 ? "multi" : user ? "single" : "none", user, newer: version !== null && version > GH_SETTINGS_VERSION };
}

/**
 * Follows gh auth login's error output for the code and the address: { userCode, verificationUri, copied } once both
 * are there. gh prints the code, then the address. Before 2.70 or so: "! First copy your one-time code: XXXX-XXXX";
 * gh 2.103.3 (the one bundled): "! One-time code (XXXX-XXXX) copied to clipboard" — it puts the code on the clipboard
 * itself, and when it cannot (no pbcopy, xclip or clip.exe) says "! Failed to copy one-time code to clipboard", then the
 * older line. Then "Open this URL to continue in your web browser: https://github.com/login/device". Read in each
 * case, as gh's words change from one release to the next.
 */
export function loginReader() {
  let text = "";
  return {
    take(chunk) {
      text += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
      if (text.length > 64 * 1024) text = text.slice(-16 * 1024);
      // The first mention that holds a code: "Failed to copy one-time code to clipboard" (no pbcopy, xclip or clip.exe
      // to be found) comes before "First copy your one-time code: XXXX-XXXX".
      const code = [...text.matchAll(/one-time code(?:\s*\(([A-Z0-9]{4,8}-?[A-Z0-9]{4,8})\))?:?[ \t]*([A-Z0-9]{4,8}-[A-Z0-9]{4,8}|[A-Z0-9]{8}(?![A-Za-z0-9]))?/gi)].find((one) => one[1] || one[2]) ?? null;
      const userCode = code?.[1] ?? code?.[2] ?? null;
      // The address once its line has ended: a chunk may end inside it.
      const url = /(https?:\/\/\S+)\s/.exec(text.slice(code ? code.index : text.length))?.[1] ?? null;
      if (!userCode || !url) return null;
      return { userCode: userCode.toUpperCase(), verificationUri: url.replace(/[.,;]+$/, ""), copied: /\) copied to (?:the )?clipboard/i.test(text) };
    },
  };
}

/** True when the code and the address are ones the window may show: a code of GitHub's form, github.com's page. */
export function codeIsShown({ userCode, verificationUri }) {
  return USER_CODE.test(userCode ?? "") && DEVICE_PAGE.test(verificationUri ?? "");
}

/** Why gh auth login ended without a sign-in, by its error output: a code the flow knows. */
export function loginFailure(stderr) {
  const said = String(stderr ?? "");
  if (/denied/i.test(said)) return "denied";
  if (/timed out|expired/i.test(said)) return "expired";
  if (NETWORK.test(said)) return "network";
  return "failed";
}
