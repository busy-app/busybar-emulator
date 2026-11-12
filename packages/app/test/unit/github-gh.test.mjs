// Publish stage 2 through GitHub CLI (src/github/gh.mjs): the environment gh runs with (apart from the person's own gh,
// no token from outside), how it is run, how its answers are read, and how its sign-in's code is found. The stand-in
// for gh (test/fixtures/fake-gh.mjs) is run as a program where the running matters.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { accountToken, checkApiPath, cleanLine, codeIsShown, ghEnvironment, ghFolders, ghRunner, ghSettings, ghTransport, GH_SETTINGS_VERSION, LOGIN, loginFailure, loginReader, parseApiOutput, personGhConfigDir } from "../../src/github/gh.mjs";
import { FAKE_GH } from "../fixtures/fake-gh.mjs";

const root = mkdtempSync(path.join(os.tmpdir(), "busy-gh-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("gh's environment: the person's GitHub CLI configuration, its state, data and cache in the data folder, github.com, no prompt, no notices, no telemetry, and no token, host or other configuration from outside", () => {
  const data = path.join(root, "data");
  const env = ghEnvironment(
    {
      PATH: "/usr/bin",
      HOME: "/srv/someone",
      HTTPS_PROXY: "http://proxy:3128",
      GH_TOKEN: "leaked-1",
      gh_token: "leaked-2",
      GITHUB_TOKEN: "leaked-3",
      GH_ENTERPRISE_TOKEN: "leaked-4",
      GITHUB_ENTERPRISE_TOKEN: "leaked-5",
      GH_HOST: "evil.example",
      GH_CONFIG_DIR: "/srv/someone/.config/gh",
      GH_DEBUG: "api",
      GH_REPO: "someone/repo",
      GITHUB_API_URL: "https://evil.example/api",
      XDG_CONFIG_HOME: "/srv/someone/.config",
      XDG_STATE_HOME: "/srv/someone/.local/state",
      DEBUG: "1",
      PAGER: "less",
      BROWSER: "firefox",
      KEPT_UNDEFINED: undefined,
    },
    data,
    "/srv/person/gh-config",
  );
  for (const value of Object.values(env)) assert.equal(/leaked|evil|someone\/repo|\.config/.test(value), false, value);
  const folders = ghFolders(data);
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/srv/someone",
    HTTPS_PROXY: "http://proxy:3128",
    GH_CONFIG_DIR: "/srv/person/gh-config",
    XDG_STATE_HOME: folders.state,
    XDG_DATA_HOME: folders.share,
    XDG_CACHE_HOME: folders.cache,
    GH_HOST: "github.com",
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
  assert.equal(folders.state, path.join(data, "github", "gh-state"));
  assert.throws(() => ghEnvironment({}, data), TypeError, "no configuration folder, no gh");
  assert.equal(personGhConfigDir({ platform: "darwin", home: "/srv/person" }), "/srv/person/.config/gh");
  const roaming = path.win32.join("D:", "Profiles", "Roaming");
  assert.equal(personGhConfigDir({ platform: "win32", appDataDir: roaming }), path.win32.join(roaming, "GitHub CLI"));
  for (const good of ["octo", "octo-person", "a1"]) assert.match(good, LOGIN);
  for (const bad of ["", "-octo", "--user", "a b", "a/b", "x".repeat(40)]) assert.doesNotMatch(bad, LOGIN);
});

test("gh is run as a program with the app's arguments: its output, its exit code, input on its standard input; a gh that does not answer in time is ended", async () => {
  const run = ghRunner({ command: process.execPath, prefix: [FAKE_GH], env: { ...process.env, GH_CONFIG_DIR: path.join(root, "gh") }, cwd: root });
  const version = await run(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout.toString(), /^gh version /);
  const hangs = path.join(root, "hangs.mjs");
  writeFileSync(hangs, "process.stdin.resume(); setTimeout(() => {}, 60_000);\n");
  const slow = ghRunner({ command: process.execPath, prefix: [hangs], env: process.env, cwd: root });
  const t = Date.now();
  const late = await slow(["api", "/user"], { timeoutMs: 300 });
  assert.equal(late.timedOut, true);
  assert.ok(Date.now() - t < 10_000);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 200);
  assert.equal((await slow(["auth", "login"], { signal: stop.signal })).aborted, true);
  const echo = path.join(root, "echo.mjs");
  writeFileSync(echo, "let s = ''; process.stdin.on('data', (c) => (s += c)).on('end', () => { process.stderr.write('err line\\n'); process.stdout.write(s.toUpperCase()); process.exitCode = 3; });\n");
  const heard = [];
  const echoed = await ghRunner({ command: process.execPath, prefix: [echo], env: process.env, cwd: root })(["x"], { input: '{"a":1}', onStderr: (text) => heard.push(text) });
  assert.deepEqual([echoed.code, echoed.stdout.toString(), echoed.stderr, heard.join("")], [3, '{"A":1}', "err line\n", "err line\n"]);
  const missing = await ghRunner({ command: path.join(root, "no-such-gh"), env: process.env, cwd: root })(["--version"]);
  assert.equal(missing.code, null);
  assert.match(missing.stderr, /could not be started/);
});

test("gh api --include's answer: the status, the headers, the body; with CRLF or LF; an answer without a body", () => {
  const got = parseApiOutput(Buffer.from('HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\nRetry-After: 2\r\nX-Ratelimit-Remaining: 0\r\n\r\n{"message":"x"}'));
  assert.equal(got.status, 403);
  assert.equal(got.headers.get("retry-after"), "2");
  assert.equal(got.headers.get("x-ratelimit-remaining"), "0");
  assert.equal(got.text, '{"message":"x"}');
  assert.deepEqual({ ...parseApiOutput("HTTP/1.1 200 OK\nA: b\n\n[1]"), headers: null }, { status: 200, headers: null, text: "[1]" });
  assert.equal(parseApiOutput("HTTP/1.1 204 No Content\r\nA: b\r\n\r\n").text, "");
  for (const bad of ["", "gh: Not Found (HTTP 404)", "HTTP/1.1 abc\r\n\r\n", "<html>"]) assert.equal(parseApiOutput(bad), null, bad);
});

test("the transport: an answer gh got from GitHub, gh without a sign-in (exit code 4), gh that cannot reach GitHub; only the app's own API paths", async () => {
  const answering = (result) => ghTransport(async () => result);
  assert.equal((await answering({ code: 1, stdout: Buffer.from("HTTP/2.0 404 Not Found\r\n\r\n{}"), stderr: "gh: Not Found (HTTP 404)" }).request("GET", "/repos/a/b")).status, 404);
  assert.deepEqual(await answering({ code: 4, stdout: Buffer.alloc(0), stderr: "please run: gh auth login" }).request("GET", "/user"), { failure: "auth", detail: "please run: gh auth login" });
  assert.equal((await answering({ code: 1, stdout: Buffer.alloc(0), stderr: "error connecting to api.github.com" }).request("GET", "/user")).failure, "network");
  for (const bad of ["user", "https://evil.example/x", "//evil.example/x", "/a b", "/a\nb", "/{owner}/x", "/:owner/x", "--hostname"]) {
    assert.throws(() => checkApiPath(bad), TypeError, bad);
    await assert.rejects(answering({}).request("GET", bad), TypeError);
  }
  assert.equal(checkApiPath("/repos/o/n/pulls?state=open&head=o%3Ab&per_page=10"), "/repos/o/n/pulls?state=open&head=o%3Ab&per_page=10");
  await assert.rejects(answering({}).request("GET --x", "/user"), TypeError);
});

test("a call as one of GitHub CLI's accounts: its token from gh auth token --user, in GH_TOKEN of that one gh api's environment, never in its arguments; no sign-in for it is told", async () => {
  const runs = [];
  const run = async (args, options = {}) => {
    runs.push({ args, token: options.token ?? null });
    if (args[0] === "auth") return args.at(-1) === "octo-two" ? { code: 0, stdout: Buffer.from("gho_two\n"), stderr: "" } : { code: 1, stdout: Buffer.alloc(0), stderr: "no oauth token found for github.com account nobody" };
    return { code: 0, stdout: Buffer.from("HTTP/2.0 200 OK\r\n\r\n{}"), stderr: "" };
  };
  assert.equal(await accountToken(run, "octo-two"), "gho_two");
  assert.deepEqual(runs.at(-1).args, ["auth", "token", "--hostname", "github.com", "--user", "octo-two"]);
  assert.equal((await accountToken(run, "nobody")).failure, "no_account");
  assert.equal((await accountToken(run, "--hostname")).failure, "no_account", "not a login: gh is not run");
  assert.equal(runs.length, 2);
  const transport = ghTransport(run, { token: () => accountToken(run, "octo-two") });
  assert.equal((await transport.request("GET", "/user")).status, 200);
  assert.deepEqual([runs.at(-1).args[0], runs.at(-1).token], ["api", "gho_two"]);
  assert.equal(runs.at(-1).args.join(" ").includes("gho_two"), false);
  assert.deepEqual(await ghTransport(run, { token: () => accountToken(run, "nobody") }).request("GET", "/user"), { failure: "no_account", detail: "no oauth token found for github.com account nobody" });
  // The real runner puts it in that process's environment only.
  const seen = path.join(root, "token-env.json");
  const echo = path.join(root, "token-env.mjs");
  writeFileSync(echo, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ token: process.env.GH_TOKEN ?? null, args: process.argv.slice(2) }));`);
  const real = ghRunner({ command: process.execPath, prefix: [echo], env: { PATH: process.env.PATH ?? "" }, cwd: root });
  await real(["api", "/user"], { token: "gho_secret" });
  assert.deepEqual(JSON.parse((await import("node:fs")).readFileSync(seen, "utf8")), { token: "gho_secret", args: ["api", "/user"] });
  await real(["api", "/user"]);
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(seen, "utf8")).token, null, "a call without one has none");
  // Cancel: a stopped call is told as such.
  const stopped = new AbortController();
  stopped.abort();
  assert.equal((await ghTransport(run).request("GET", "/user", undefined, { signal: stopped.signal })).failure, "canceled");
});

test("GitHub CLI's active account in the settings of gh 2.39 and older: --user finds no token for it, so its token is GitHub CLI's active one; another account never gets that one", async () => {
  const runs = [];
  const run = async (args) => {
    runs.push(args.join(" "));
    if (args.includes("--user")) return { code: 1, stdout: Buffer.alloc(0), stderr: `no oauth token found for github.com account ${args.at(-1)}\n` };
    return { code: 0, stdout: Buffer.from("gho_active\n"), stderr: "" };
  };
  assert.equal(await accountToken(run, "octo-one", { active: true }), "gho_active");
  assert.deepEqual(runs, ["auth token --hostname github.com --user octo-one", "auth token --hostname github.com"]);
  assert.deepEqual(await accountToken(run, "octo-two"), { failure: "no_account", detail: "no oauth token found for github.com account octo-two" });
  assert.equal(runs.length, 3, "not GitHub CLI's active account: only --user is asked");
  const gone = async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "gh could not be started: ENOENT", timedOut: false });
  assert.equal((await accountToken(gone, "octo-one", { active: true })).failure, "network");
});

test("GitHub CLI's settings as each version leaves them (test/fixtures/gh-settings, written by those gh): the format, the active account, and whether the bundled gh may write to them", () => {
  const at = (which) => path.join(import.meta.dirname, "..", "fixtures", "gh-settings", which);
  assert.equal(GH_SETTINGS_VERSION, 1);
  assert.deepEqual(ghSettings(at("single-2.39.2")), { version: null, layout: "single", user: "fake-alice", newer: false });
  // gh 2.40 to 2.102 convert it when they run, into `{version: "1"}` when config.yml was empty.
  assert.deepEqual(ghSettings(at("converted-2.40.0")), { version: 1, layout: "multi", user: "fake-alice", newer: false });
  assert.deepEqual(ghSettings(at("multi-2.103.3")), { version: 1, layout: "multi", user: "fake-alice", newer: false });
  assert.deepEqual(ghSettings(at("newer-by-hand")), { version: 2, layout: "multi", user: "fake-alice", newer: true });
  assert.deepEqual(ghSettings(path.join(root, "no-such-folder")), { version: null, layout: "none", user: null, newer: false });
  assert.deepEqual(ghSettings(null), { version: null, layout: "none", user: null, newer: false });
  const files = (hosts, config = "") => (file) => (file.endsWith("hosts.yml") ? hosts : config);
  assert.equal(ghSettings("/x", files("{}\n", "{}\n")).layout, "none");
  assert.equal(ghSettings("/x", files("github.com:\n    user: octo\n", "# comment\nversion: '3'\n")).version, 3);
  assert.equal(ghSettings("/x", files("example.com:\n    users:\n        octo:\n    user: octo\n")).layout, "none", "another host's accounts are not github.com's");
});

test("the sign-in's code and page from gh auth login's error output, however it comes in pieces, in the words of older gh and of 2.103.3 (bundled); only GitHub's page is shown", () => {
  // gh 2.103.3 prints the second (seen on a Mac, 12 Nov 2026): reading only the first left the window at "Asking GitHub
  // for a code" until the wait for the code ran out, and said GitHub could not be reached.
  const older = "\n! First copy your one-time code: ABCD-1234\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  const bundled = "\n! One-time code (8449-42C6) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
  // And gh 2.103.3 that finds no program for the clipboard (seen with PATH=/bin).
  const noClipboard = '\n! Failed to copy one-time code to clipboard\n  exec: "pbcopy": executable file not found in $PATH\n! First copy your one-time code: 3807-FB5F\nOpen this URL to continue in your web browser: https://github.com/login/device\n';
  for (const [said, code, copied] of [
    [older, "ABCD-1234", false],
    [bundled, "8449-42C6", true],
    [noClipboard, "3807-FB5F", false],
  ]) {
    for (let cut = 1; cut < said.length; cut++) {
      const reader = loginReader();
      const first = reader.take(said.slice(0, cut));
      const got = reader.take(said.slice(cut));
      if (cut <= said.lastIndexOf("\n") - 1) assert.equal(first, null, `nothing before the address's line ends (${cut})`);
      assert.deepEqual(first ?? got, { userCode: code, verificationUri: "https://github.com/login/device", copied });
    }
  }
  assert.equal(codeIsShown({ userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" }), true);
  for (const bad of [{ userCode: "ABCD-1234", verificationUri: "https://github.com.evil.example/login/device" }, { userCode: "ABCD-1234", verificationUri: "http://github.com/login/device" }, { userCode: "<b>", verificationUri: "https://github.com/login/device" }]) assert.equal(codeIsShown(bad), false);
  assert.equal(loginFailure("failed to authenticate via web browser: The authorization request was denied."), "denied");
  assert.equal(loginFailure("failed to authenticate via web browser: authentication timed out"), "expired");
  assert.equal(loginFailure("Post \"https://github.com/login/device/code\": dial tcp: lookup github.com: no such host"), "network");
  assert.equal(loginFailure("something else"), "failed");
  const tokenLike = ["gho", "0123456789abcdefghij".repeat(2)].join("_");
  assert.equal(cleanLine(`first\n\x1b[31mgh: token ${tokenLike} is bad\x1b[m\n`), "gh: token … is bad");
});
