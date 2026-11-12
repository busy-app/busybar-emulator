#!/usr/bin/env node
// A stand-in for GitHub CLI, for tests only: the few commands of gh the app uses, spoken to the stand-in for GitHub
// (github-stub.mjs) instead of github.com. A release always runs the real gh bundled with it (config.mjs reads
// BUSY_EMULATOR_GH, which names this file, only in a development run and the test variant).
//
//   gh --version
//   gh auth login --hostname github.com --git-protocol https --web [--skip-ssh-key]
//                               the device flow against the stand-in, the code printed on stderr as the bundled gh
//                               prints it (BUSY_EMULATOR_FAKE_GH_CODE_TEXT: "copied", the default, "copyFailed" or
//                               "notCopied", the fixture's sign-in starts); the account is added to the configuration
//                               and becomes the active one (gh 2.40 and later)
//   gh auth token --hostname github.com --user <login>
//                               that account's token, on stdout
//   gh auth switch --hostname github.com --user <login>
//   gh auth logout --hostname github.com [--user <login>]
//                               the account goes; when it was the active one, the first other becomes it
//   gh config get --host github.com user
//   gh api <path> --hostname github.com --method <M> --include [-H <header>]... [--input -]
//                               with GH_TOKEN's token when the environment has one (as gh does), else the active one
// and refuses gh auth status, which the app must never run (it asks GitHub about every account).
//
// Like gh 2.103 it keeps its accounts in GH_CONFIG_DIR/hosts.yml without their tokens, and the tokens in a "system
// store" — here a JSON file, BUSY_EMULATOR_FAKE_GH_KEYRING (default GH_CONFIG_DIR/../fake-keyring.json) — under
// "gh:github.com" with the login and with an empty account for the active one; a gh with no account in its
// configuration uses the empty one, as the real one does. BUSY_EMULATOR_FAKE_GH_INSECURE=1 plays a store that
// refuses: the token goes into hosts.yml in plain text. BUSY_EMULATOR_FAKE_GH_LOG names a file that gets a line for
// each run: its arguments and what of its environment the tests look at (the names of token variables, never values).
//
// Everything it prints that the app reads is what the bundled gh prints, from test/fixtures/gh-texts.json: recorded
// from that gh (tools/gh-texts.mjs record), checked against it by `npm run live:gh`, and tied to the pinned version by
// test/unit/gh-texts.test.mjs. Only GitHub's own refusals of a sign-in (denied, expired) are GitHub's words, not gh's.
//
// fakeGh() runs it in the test's own process (the API's unit tests); the file run as a program is the same.
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVICE = "gh:github.com";

/** What the bundled gh says (tools/gh-texts.mjs). */
export const GH_TEXTS = JSON.parse(readFileSync(new URL("./gh-texts.json", import.meta.url), "utf8"));
/** gh's marks, as recorded: "✓" before what was done, "!" before a note. */
const DONE = GH_TEXTS.offline.switched.stderr.split(" ")[0];
const NOTE = GH_TEXTS.live.copied.stderr.trim().split(" ")[0];
/** One of gh's format strings with its values: %s and %w in order. */
export function ghSays(id, ...values) {
  let at = 0;
  return GH_TEXTS.formats[id].replace(/%[sw]/g, () => String(values[at++]));
}

function storeFile(env) {
  return env.BUSY_EMULATOR_FAKE_GH_KEYRING || path.join(path.dirname(env.GH_CONFIG_DIR), "fake-keyring.json");
}
function readStore(env) {
  try {
    return JSON.parse(readFileSync(storeFile(env), "utf8"));
  } catch {
    return {};
  }
}
function writeStore(env, store) {
  mkdirSync(path.dirname(storeFile(env)), { recursive: true });
  writeFileSync(storeFile(env), JSON.stringify(store));
}

function hostsFile(env) {
  return path.join(env.GH_CONFIG_DIR, "hosts.yml");
}
/** hosts.yml's github.com as gh writes it: { users: { login: { oauth_token? } }, user, oauth_token? }, or null. */
function readHosts(env) {
  let text;
  try {
    text = readFileSync(hostsFile(env), "utf8");
  } catch {
    return null;
  }
  if (!/^github\.com:/m.test(text)) return null;
  const host = { users: {}, user: null, oauth_token: null };
  let last = null;
  let inUsers = false;
  for (const line of text.split("\n")) {
    let m;
    if ((m = /^ {4}(\w+):\s*(\S*)$/.exec(line))) {
      inUsers = m[1] === "users";
      if (m[1] === "user") host.user = m[2];
      if (m[1] === "oauth_token") host.oauth_token = m[2];
    } else if (inUsers && (m = /^ {8}([A-Za-z0-9-]+):$/.exec(line))) {
      last = m[1];
      host.users[last] = {};
    } else if (inUsers && last && (m = /^ {12}oauth_token: (\S+)$/.exec(line))) host.users[last].oauth_token = m[1];
  }
  return host;
}

function writeHosts(env, host) {
  mkdirSync(env.GH_CONFIG_DIR, { recursive: true });
  if (!host || !Object.keys(host.users).length) return writeFileSync(hostsFile(env), "{}\n");
  const users = Object.entries(host.users).map(([name, one]) => `        ${name}:${one.oauth_token ? `\n            oauth_token: ${one.oauth_token}` : ""}`).join("\n");
  writeFileSync(hostsFile(env), `github.com:\n    users:\n${users}\n    git_protocol: https\n${host.oauth_token ? `    oauth_token: ${host.oauth_token}\n` : ""}    user: ${host.user}\n`);
}

/**
 * The token gh would send, in gh 2.103.3's order (internal/config/config.go ActiveToken): the host's own in plain text,
 * the active account's (in the store, or in plain text under `users`), else the store's item for the host alone.
 */
function activeToken(env) {
  const hosts = readHosts(env);
  const store = readStore(env);
  const user = hosts?.user;
  if (hosts?.oauth_token) return { token: hosts.oauth_token, source: "oauth_token" };
  if (user && store[`${SERVICE}|${user}`]) return { token: store[`${SERVICE}|${user}`], source: "keyring" };
  if (user && hosts.users[user]?.oauth_token) return { token: hosts.users[user].oauth_token, source: "oauth_token" };
  if (store[`${SERVICE}|`]) return { token: store[`${SERVICE}|`], source: "keyring" };
  return null;
}

/** Makes `user` the active account: its token goes into the store's active item (or the host's plain-text one). */
function activate(env, host, user) {
  const store = readStore(env);
  delete store[`${SERVICE}|`];
  host.oauth_token = null;
  if (store[`${SERVICE}|${user}`]) store[`${SERVICE}|`] = store[`${SERVICE}|${user}`];
  else if (host.users[user]?.oauth_token) host.oauth_token = host.users[user].oauth_token;
  writeStore(env, store);
  host.user = user;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function form(url, fields) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(fields).toString() });
  return res.json();
}

/**
 * Runs one command. `out` and `err` take text (out also bytes); `stdin` is what the command reads.
 * @returns {Promise<number>} the exit code
 */
export async function fakeGh(argv, { env, stdin = "", out, err }) {
  const args = [...argv];
  if (env.BUSY_EMULATOR_FAKE_GH_LOG) {
    const seen = { args, configDir: env.GH_CONFIG_DIR ?? null, host: env.GH_HOST ?? null, prompt: env.GH_PROMPT_DISABLED ?? null, tokens: Object.keys(env).filter((name) => /^(GH|GITHUB)_(ENTERPRISE_)?TOKEN$/i.test(name)) };
    appendFileSync(env.BUSY_EMULATOR_FAKE_GH_LOG, `${JSON.stringify(seen)}\n`);
  }
  const standIn = env.BUSY_EMULATOR_FAKE_GH_STAND_IN;
  const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (args[0] === "--version") {
    out("gh version 0.0.0-stand-in (test)\nhttps://github.com/cli/cli/releases/tag/v0.0.0\n");
    return 0;
  }
  if (!env.GH_CONFIG_DIR || !standIn) {
    err("fake gh: GH_CONFIG_DIR and BUSY_EMULATOR_FAKE_GH_STAND_IN are needed\n");
    return 2;
  }
  if (option("--hostname") !== "github.com" && !(args[0] === "config" && option("--host") === "github.com")) {
    err("fake gh: only --hostname github.com\n");
    return 2;
  }

  if (args[0] === "auth" && args[1] === "login") {
    if (args.includes("--insecure-storage") || args.includes("--with-token") || !args.includes("--web") || option("--git-protocol") !== "https") {
      err("fake gh: not the sign-in the app uses\n");
      return 2;
    }
    const code = await form(`${standIn}/login/device/code`, { client_id: "fake-gh-client", scope: "repo read:org gist" });
    if (!code?.user_code) {
      err(`${ghSays("webFailed", code?.error_description ?? code?.error ?? "no code")}\n`);
      return 1;
    }
    const shown = GH_TEXTS.live[env.BUSY_EMULATOR_FAKE_GH_CODE_TEXT || "copied"];
    if (!shown) {
      err(`fake gh: no sign-in start ${env.BUSY_EMULATOR_FAKE_GH_CODE_TEXT} in gh-texts.json\n`);
      return 2;
    }
    err(shown.stderr.replaceAll("{code}", code.user_code).replaceAll(shown.shown.verificationUri, code.verification_uri));
    let token = null;
    for (;;) {
      await sleep(Number(env.BUSY_EMULATOR_FAKE_GH_POLL_MS) || 20);
      const answer = await form(`${standIn}/login/oauth/access_token`, { client_id: "fake-gh-client", device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      if (answer?.access_token) {
        token = answer.access_token;
        break;
      }
      if (answer?.error === "authorization_pending" || answer?.error === "slow_down") continue;
      // GitHub's refusal as gh's OAuth library words it (github.com/cli/oauth api.Error): "<description> (<error>)".
      const said = answer?.error_description ? `${answer.error_description} (${answer.error})` : (answer?.error ?? "unknown");
      err(`${ghSays("webFailed", said)}\n`);
      return 1;
    }
    const me = await (await fetch(`${standIn}/api/user`, { headers: { authorization: `token ${token}` } })).json();
    const insecure = env.BUSY_EMULATOR_FAKE_GH_INSECURE === "1";
    const host = readHosts(env) ?? { users: {}, user: null, oauth_token: null };
    host.users[me.login] = insecure ? { oauth_token: token } : {};
    if (!insecure) {
      const store = readStore(env);
      store[`${SERVICE}|${me.login}`] = token;
      writeStore(env, store);
    }
    activate(env, host, me.login);
    writeHosts(env, host);
    if (insecure) err(ghSays("plainText", NOTE));
    err(`${ghSays("authComplete", DONE)}\n${ghSays("loggedInAs", DONE, me.login)}`);
    return 0;
  }

  if (args[0] === "auth" && args[1] === "switch") {
    const host = readHosts(env);
    const user = option("--user");
    if (!host || !host.users[user]) {
      err(`${ghSays("notLoggedIn", "github.com", user)}\n`);
      return 1;
    }
    activate(env, host, user);
    writeHosts(env, host);
    err(ghSays("switched", DONE, "github.com", user));
    return 0;
  }

  if (args[0] === "config" && args[1] === "get") {
    if (args.at(-1) !== "user" || option("--host") !== "github.com") {
      err("fake gh: only config get --host github.com user\n");
      return 2;
    }
    const host = readHosts(env);
    if (!host?.user) {
      err(`${ghSays("noKey", "user")}\n`);
      return 1;
    }
    out(`${host.user}\n`);
    return 0;
  }

  if (args[0] === "auth" && args[1] === "token") {
    const user = option("--user");
    const host = readHosts(env);
    const store = readStore(env);
    const token = user ? (store[`${SERVICE}|${user}`] ?? host?.users[user]?.oauth_token ?? null) : activeToken(env)?.token;
    if (!token) {
      err(`${ghSays("noToken", "github.com")}${user ? ` account ${user}` : ""}\n`);
      return 1;
    }
    out(`${token}\n`);
    return 0;
  }

  if (args[0] === "auth" && args[1] === "status") {
    err("fake gh: the app never runs gh auth status: it asks GitHub about every account\n");
    return 2;
  }

  if (args[0] === "auth" && args[1] === "logout") {
    const host = readHosts(env);
    const user = option("--user") ?? host?.user;
    if (!host || !host.users[user]) {
      err(host && option("--user") ? `${ghSays("notLoggedIn", "github.com", user)}\n` : `${ghSays("noMatch")}\n`);
      return 1;
    }
    const store = readStore(env);
    delete store[`${SERVICE}|${user}`];
    delete host.users[user];
    writeStore(env, store);
    err(ghSays("loggedOut", DONE, "github.com", user));
    const others = Object.keys(host.users);
    if (host.user === user) {
      if (others.length) {
        activate(env, host, others[0]);
        err(ghSays("switched", DONE, "github.com", others[0]));
      } else {
        const left = readStore(env);
        delete left[`${SERVICE}|`];
        writeStore(env, left);
      }
    }
    writeHosts(env, others.length ? host : null);
    return 0;
  }

  if (args[0] === "api") {
    const apiPath = args[1];
    const method = option("--method") ?? "GET";
    if (!args.includes("--include") || !apiPath?.startsWith("/")) {
      err("fake gh: the app always asks with --include and a path\n");
      return 2;
    }
    const active = env.GH_TOKEN ? { token: env.GH_TOKEN, source: "GH_TOKEN" } : activeToken(env);
    if (!active) {
      err(GH_TEXTS.offline.apiNoSignIn.stderr);
      return GH_TEXTS.offline.apiNoSignIn.code;
    }
    const headers = { authorization: `token ${active.token}`, "user-agent": "GitHub CLI 0.0.0-stand-in" };
    args.forEach((one, i) => {
      if (one === "-H") {
        const [name, ...rest] = args[i + 1].split(":");
        headers[name.trim().toLowerCase()] = rest.join(":").trim();
      }
    });
    const body = args.includes("--input") ? stdin : undefined;
    if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    let res;
    try {
      res = await fetch(`${standIn}/api${apiPath}`, { method, headers, body });
    } catch (e) {
      err(`error connecting to ${new URL(standIn).host}: ${e.cause?.code ?? e.message}\n`);
      return 1;
    }
    const text = Buffer.from(await res.arrayBuffer());
    const lines = [...res.headers].map(([name, value]) => `${name.replace(/(^|-)([a-z])/g, (_, dash, letter) => dash + letter.toUpperCase())}: ${value}`).sort();
    out(`HTTP/1.1 ${res.status} ${res.statusText}\r\n${lines.map((line) => `${line}\r\n`).join("")}\r\n`);
    if (res.status !== 204) out(text);
    if (res.status > 299) {
      let message = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text.toString("utf8"));
        if (parsed?.message) message = `${parsed.message} (HTTP ${res.status})`;
      } catch {
        // As it is.
      }
      err(`gh: ${message}\n`);
      return 1;
    }
    return 0;
  }

  err(`fake gh: unknown command ${args.slice(0, 2).join(" ")}\n`);
  return 2;
}

/**
 * A configuration folder as gh leaves it after a sign-in as `login` with `token` (in the stand-in's store): for tests
 * that start signed in. Returns the environment fakeGh() needs.
 */
export function fakeSignedIn(root, { login, token, standIn, accounts = { [login]: token } }) {
  const env = { GH_CONFIG_DIR: path.join(root, "gh"), GH_HOST: "github.com", BUSY_EMULATOR_FAKE_GH_STAND_IN: standIn };
  const host = { users: Object.fromEntries(Object.keys(accounts).map((one) => [one, {}])), user: login, oauth_token: null };
  writeStore(env, Object.fromEntries([...Object.entries(accounts).map(([one, t]) => [`${SERVICE}|${one}`, t]), [`${SERVICE}|`, accounts[login]]]));
  writeHosts(env, host);
  return env;
}

/** In this process: { code, stdout (Buffer), stderr }, as ghRunner resolves for the real one. */
export async function runFakeGh(argv, { env, input = null } = {}) {
  const outParts = [];
  let stderr = "";
  const code = await fakeGh(argv, { env, stdin: input ?? "", out: (chunk) => outParts.push(Buffer.from(chunk)), err: (text) => (stderr += text) });
  return { code, stdout: Buffer.concat(outParts), stderr, timedOut: false, aborted: false };
}

export const FAKE_GH = fileURLToPath(import.meta.url);

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(FAKE_GH)) {
  const chunks = [];
  const readStdin = process.argv.includes("--input")
    ? new Promise((resolve) => {
        process.stdin.on("data", (chunk) => chunks.push(chunk));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
    : Promise.resolve("");
  const stdin = await readStdin;
  const code = await fakeGh(process.argv.slice(2), { env: process.env, stdin, out: (chunk) => process.stdout.write(chunk), err: (text) => process.stderr.write(text) });
  // Everything written is out before the exit.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exitCode = code;
}
