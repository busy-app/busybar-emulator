// Publish stage 2: GitHub's REST API (src/github/github-api.mjs), through the transport of GitHub CLI (gh.mjs
// ghTransport, `gh api ... --include`), with the stand-in for gh (fake-gh.mjs) run in this process and speaking to a
// stand-in for GitHub on 127.0.0.1 that keeps repositories, git objects, forks and pull requests in memory. The clock
// and the waits are the test's.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ghTransport } from "../../src/github/gh.mjs";
import { blobSha, checkRepoPath, createGithubApi, MAX_FILES, sameIfRepeated, SERVER_RETRY_MS, WRITE_GAP_MS, WRITES_PER_HOUR } from "../../src/github/github-api.mjs";
import { fakeSignedIn, runFakeGh } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { PORTS } from "../helpers.mjs";

let stub;
let root;
before(async () => {
  stub = await startGithubStub({ port: PORTS.unit });
  root = mkdtempSync(path.join(os.tmpdir(), "busy-github-api-"));
});
after(async () => {
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

let repos = 0;
const repoName = () => `bar-app-${++repos}`;
const file = (path, text, executable) => ({ path, bytes: Buffer.from(text), executable });
let signIns = 0;

/** gh signed in with `token`, run in this process; `calls` holds the arguments and input of every run. */
function ghWith(token = stub.token) {
  const env = fakeSignedIn(path.join(root, `gh-${++signIns}`), { login: stub.login, token, standIn: stub.base });
  const calls = [];
  const run = (args, options = {}) => {
    calls.push({ args, input: options.input ?? null });
    return runFakeGh(args, { env, input: options.input });
  };
  return { transport: ghTransport(run), calls };
}

/** The API on the stand-in, with a clock that moves only when the API waits. */
function apiFor({ token = stub.token, writeGapMs = WRITE_GAP_MS, maxWaitMs } = {}) {
  let t = 2_000_000_000_000;
  const waits = [];
  const gh = ghWith(token);
  const api = createGithubApi({ transport: gh.transport, now: () => t, sleep: async (ms) => (waits.push(ms), (t += ms)), writeGapMs, ...(maxWaitMs ? { maxWaitMs } : {}) });
  return { api, waits, now: () => t, calls: gh.calls };
}

const writesOf = (from) => stub.requests.slice(from).filter((r) => r.method !== "GET");

test("every request is `gh api <path> --hostname github.com --method <M> --include` with GitHub's media type and API version; a body goes as JSON on gh's standard input; gh sends the token", async () => {
  const { api, calls } = apiFor({ writeGapMs: 0 });
  const from = stub.requests.length;
  assert.deepEqual(await api.user(), { login: stub.login });
  assert.deepEqual(calls[0], { args: ["api", "/user", "--hostname", "github.com", "--method", "GET", "--include", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28"], input: null });
  const [asked] = stub.requests.slice(from);
  assert.equal(asked.headers.authorization, `token ${stub.token}`, "the stand-in for gh sends the token as gh does");
  assert.equal(asked.headers["x-github-api-version"], "2022-11-28");
  assert.equal(asked.headers.accept, "application/vnd.github+json");
  const name = repoName();
  await api.createRepo({ name, description: "d" });
  assert.deepEqual(calls[1].args.slice(0, 2), ["api", "/user/repos"]);
  assert.deepEqual(calls[1].args.slice(-2), ["--input", "-"]);
  assert.deepEqual(JSON.parse(calls[1].input), { name, description: "d", private: false, auto_init: true });
  for (const call of calls) assert.equal(call.args.join(" ").includes(stub.token), false, "the token is never in gh's arguments");
});

test("blob ids are git's: the same as `git hash-object`", () => {
  assert.equal(blobSha(Buffer.from("hello\n")), "ce013625030ba8dba906f756967f9e9ca394464a");
  assert.equal(blobSha(Buffer.alloc(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("a new public repository with a first commit, then the project's files in one commit, read back", async () => {
  const { api } = apiFor();
  const name = repoName();
  const from = stub.requests.length;
  const made = await api.createRepo({ name, description: "An app for BUSY Bar" });
  assert.deepEqual(made, { owner: stub.login, name, defaultBranch: "main", url: `https://github.com/${stub.login}/${name}` });
  assert.deepEqual(stub.requests[from].body, { name, description: "An app for BUSY Bar", private: false, auto_init: true });
  const files = [file("README.md", "# My app\n"), file("src/main.js", "console.log(1)\n"), file("tools/run.sh", "#!/bin/sh\n", true), file("assets/icon.png", "\x89PNG...")];
  const pushed = await api.pushFiles({ owner: stub.login, name, branch: "main", files, message: "Publish from BUSY Bar Emulator" });
  assert.equal(pushed.uploaded, 4);
  assert.equal(stub.headOf(`${stub.login}/${name}`, "main"), pushed.commit);
  // "replace": the branch holds exactly the project's files; GitHub's first README is replaced.
  assert.deepEqual(stub.filesOf(`${stub.login}/${name}`, "main"), { "README.md": "# My app\n", "assets/icon.png": "\x89PNG...", "src/main.js": "console.log(1)\n", "tools/run.sh": "#!/bin/sh\n" });
  const tree = stub.requests.filter((r) => r.path.endsWith("/git/trees") && r.method === "POST").at(-1).body;
  assert.equal(tree.base_tree, undefined);
  assert.equal(tree.tree.find((e) => e.path === "tools/run.sh").mode, "100755");
  assert.equal(tree.tree.find((e) => e.path === "src/main.js").mode, "100644");
});

test("publishing again uploads only what changed, and nothing at all when nothing did", async () => {
  const { api } = apiFor();
  const name = repoName();
  await api.createRepo({ name });
  const files = [file("README.md", "# App\n"), file("src/main.js", "a\n"), file("src/b.js", "b\n")];
  await api.pushFiles({ owner: stub.login, name, branch: "main", files, message: "first" });
  let from = stub.requests.length;
  const again = await api.pushFiles({ owner: stub.login, name, branch: "main", files, message: "same" });
  assert.equal(again.unchanged, true);
  assert.deepEqual(writesOf(from), []);
  from = stub.requests.length;
  const changed = await api.pushFiles({ owner: stub.login, name, branch: "main", files: [files[0], file("src/main.js", "a2\n"), files[2]], message: "second" });
  assert.equal(changed.uploaded, 1);
  assert.deepEqual(writesOf(from).map((r) => r.path.replace(/^\/api\/repos\/[^/]+\/[^/]+/, "")), ["/git/blobs", "/git/trees", "/git/commits", "/git/refs/heads/main"]);
  assert.equal(stub.filesOf(`${stub.login}/${name}`, "main")["src/main.js"], "a2\n");
});

test("every write waits a second after the one before, as GitHub asks", async () => {
  const { api, waits } = apiFor();
  const name = repoName();
  await api.createRepo({ name });
  await api.pushFiles({ owner: stub.login, name, branch: "main", files: [file("a", "1"), file("b", "2"), file("c", "3")], message: "m" });
  // createRepo, three blobs, the tree, the commit, the move: six waits of a second between seven writes.
  assert.deepEqual(waits, Array(6).fill(WRITE_GAP_MS));
});

test("the hour's 500 writes: the 501st is refused before it is sent, with the time to try again", async () => {
  const { api } = apiFor({ writeGapMs: 0 });
  const name = repoName();
  await api.createRepo({ name });
  for (let i = 1; i < WRITES_PER_HOUR; i++) await api.createBlob(stub.login, name, Buffer.from(`blob ${i}`));
  const from = stub.requests.length;
  await assert.rejects(api.createBlob(stub.login, name, Buffer.from("one too many")), (e) => e.code === "rate_limited" && Number.isFinite(e.retryAt));
  assert.equal(stub.requests.length, from);
});

test("the paths a push takes, and how many files", async () => {
  for (const good of ["README.md", "src/a/b.js", ".gitignore", ".github/x.yml", "a b/c d.txt"]) assert.equal(checkRepoPath(good), good);
  for (const bad of ["", "/abs", "a//b", "a/../b", "..", "./a", "a/.", "a\\b", ".git/config", ".GIT/hooks/x", "x\0y"]) assert.throws(() => checkRepoPath(bad), (e) => e.code === "bad_path", bad);
  const { api } = apiFor();
  const name = repoName();
  await api.createRepo({ name });
  const from = stub.requests.length;
  await assert.rejects(api.pushFiles({ owner: stub.login, name, branch: "main", files: Array.from({ length: MAX_FILES + 1 }, (_, i) => file(`f${i}`, String(i))), message: "m" }), (e) => e.code === "too_many_files");
  await assert.rejects(api.pushFiles({ owner: stub.login, name, branch: "main", files: [file("a", "1"), file("a", "2")], message: "m" }), (e) => e.code === "bad_path");
  await assert.rejects(api.pushFiles({ owner: stub.login, name, branch: "main", files: [file("../escape", "1")], message: "m" }), (e) => e.code === "bad_path");
  assert.equal(stub.requests.length, from, "nothing is sent for a push that is refused");
});

test("a push GitHub says yes to but does not keep is not called done", async () => {
  const { api } = apiFor();
  const name = repoName();
  await api.createRepo({ name });
  stub.deaf.add(`${stub.login}/${name}:main`.toLowerCase());
  await assert.rejects(api.pushFiles({ owner: stub.login, name, branch: "main", files: [file("a", "1")], message: "m" }), (e) => e.code === "not_landed");
});

test("errors by what they mean: the name is taken, the token is gone, gh has no sign-in, nothing there, gh cannot reach GitHub", async () => {
  const { api } = apiFor();
  const name = repoName();
  await api.createRepo({ name });
  await assert.rejects(api.createRepo({ name }), (e) => e.code === "name_taken" && e.status === 422);
  assert.equal(await api.repo(stub.login, "no-such-repo"), null);
  assert.equal(await api.branchHead(stub.login, name, "no-such-branch"), null);
  await assert.rejects(api.pushFiles({ owner: stub.login, name, branch: "no-such-branch", files: [file("a", "1")], message: "m" }), (e) => e.code === "conflict");
  stub.next.push({ status: 403, body: { message: "Resource not accessible by integration" }, headers: { "x-accepted-oauth-scopes": "repo", "x-oauth-scopes": "public_repo" } });
  await assert.rejects(api.repo(stub.login, name), (e) => e.code === "forbidden" && e.details.accepted === "repo");
  // GitHub failing every time it is asked (the first try and three more).
  for (let i = 0; i < 4; i++) stub.next.push({ status: 502, body: { message: "Server Error" } });
  await assert.rejects(api.user(), (e) => e.code === "server");
  const wrong = "dummy-wrong-token-0123456789abcdef";
  const { api: revoked } = apiFor({ token: wrong });
  await assert.rejects(revoked.user(), (e) => e.code === "unauthorized" && e.status === 401 && !e.message.includes(wrong));
  // gh with no token at all ends with its exit code 4; one that cannot reach GitHub says so on its error output.
  const none = createGithubApi({ transport: ghTransport(async () => ({ code: 4, stdout: Buffer.alloc(0), stderr: "To get started with GitHub CLI, please run:  gh auth login\n" })) });
  await assert.rejects(none.user(), (e) => e.code === "unauthorized");
  const offline = createGithubApi({ transport: ghTransport(async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: "error connecting to api.github.com\n" })) });
  await assert.rejects(offline.user(), (e) => e.code === "network" && /error connecting/.test(e.message));
  const slow = createGithubApi({ transport: ghTransport(async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", timedOut: true })) });
  await assert.rejects(slow.user(), (e) => e.code === "network");
});

test("the primary limit: a short wait is waited out to the reset time, a long one is the caller's", async () => {
  let { api, waits, now } = apiFor();
  stub.next.push({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(now() / 1000) + 30) } });
  assert.deepEqual(await api.user(), { login: stub.login });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 30_000 && waits[0] <= 32_000, String(waits[0]));

  ({ api, waits, now } = apiFor());
  const reset = Math.floor(now() / 1000) + 3600;
  stub.next.push({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } });
  await assert.rejects(api.user(), (e) => e.code === "rate_limited" && e.retryAt >= reset * 1000);
  assert.deepEqual(waits, []);
});

test("the secondary limit: retry-after is kept to; without it, a minute and longer each time", async () => {
  let { api, waits } = apiFor({ maxWaitMs: 10 * 60_000 });
  stub.next.push({ status: 429, body: { message: "slow down" }, headers: { "retry-after": "2" } });
  await api.user();
  assert.deepEqual(waits, [2000]);

  ({ api, waits } = apiFor({ maxWaitMs: 10 * 60_000 }));
  const secondary = { status: 403, body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes before you try again." } };
  stub.next.push(secondary, secondary);
  await api.user();
  assert.deepEqual(waits, [60_000, 120_000]);

  ({ api, waits } = apiFor({ maxWaitMs: 10 * 60_000 }));
  stub.next.push(secondary, secondary, secondary, secondary);
  await assert.rejects(api.user(), (e) => e.code === "rate_limited");
  assert.equal(waits.length, 3);
  stub.next.length = 0;
});

test("the submission to the catalog: a fork, a branch from the catalog's own, the manifest on top, a pull request; again: the same pull request", async () => {
  const catalog = stub.makeRepo("busy-app", "busy-apps-catalog");
  const { api } = apiFor();
  // The catalog has files of its own that the submission must keep.
  const upstream = createGithubApi({ transport: ghWith().transport, writeGapMs: 0 });
  await upstream.pushFiles({ owner: "busy-app", name: "busy-apps-catalog", branch: "main", files: [file("README.md", "# Catalog\n"), file("applications/other.app/manifest.yml", "id: other\n")], message: "catalog" });
  const branch = `${stub.login}/app.example.bar_1.0.0`;
  const first = await api.proposeToCatalog({
    catalog: { owner: catalog.owner, name: catalog.name, branch: "main" },
    login: stub.login,
    branch,
    files: [file("applications/app.example.bar/manifest.yml", "id: app.example.bar\nversion: 1.0.0\n")],
    message: "Add app.example.bar 1.0.0",
    title: "Add app.example.bar 1.0.0",
    body: "From BUSY Bar Emulator",
  });
  assert.equal(first.created, true);
  assert.deepEqual(stub.filesOf(`${stub.login}/busy-apps-catalog`, branch), { "README.md": "# Catalog\n", "applications/other.app/manifest.yml": "id: other\n", "applications/app.example.bar/manifest.yml": "id: app.example.bar\nversion: 1.0.0\n" });
  const pull = stub.pulls.at(-1);
  assert.deepEqual({ head: pull.head, base: pull.baseBranch, maintainerCanModify: pull.maintainerCanModify, number: first.number }, { head: `${stub.login}:${branch}`, base: "main", maintainerCanModify: true, number: pull.number });

  const second = await api.proposeToCatalog({
    catalog: { owner: catalog.owner, name: catalog.name, branch: "main" },
    login: stub.login,
    branch,
    files: [file("applications/app.example.bar/manifest.yml", "id: app.example.bar\nversion: 1.0.1\n")],
    message: "Update app.example.bar to 1.0.1",
    title: "unused",
    body: "unused",
  });
  assert.equal(second.created, false);
  assert.equal(second.number, first.number);
  assert.notEqual(second.commit, first.commit);
  assert.equal(stub.pulls.length, 1);
  assert.equal(stub.filesOf(`${stub.login}/busy-apps-catalog`, branch)["applications/app.example.bar/manifest.yml"], "id: app.example.bar\nversion: 1.0.1\n");
});

test("a fork that is never ready is told, not waited for for ever", async () => {
  const { api } = apiFor();
  stub.makeRepo("busy-app", "slow-catalog");
  const fork = await api.fork("busy-app", "slow-catalog");
  stub.pending.set(`${fork.owner}/${fork.name}`.toLowerCase(), 1000);
  await assert.rejects(api.waitForFork(fork, { tries: 3, gapMs: 10 }), (e) => e.code === "fork_pending");
  stub.pending.clear();
});

test("GitHub's own failure (5xx) is asked again with longer waits, where asking again does nothing twice; a new repository or pull request is not", async () => {
  const { api, waits } = apiFor({ writeGapMs: 0 });
  const name = repoName();
  await api.createRepo({ name });
  let failures = 2;
  stub.hooks.fail = (req) => (req.method === "POST" && req.url.endsWith("/git/blobs") && failures-- > 0 ? { status: 502, body: { message: "Server Error" } } : null);
  await api.pushFiles({ owner: stub.login, name, branch: "main", files: [file("a", "1")], message: "m" });
  assert.deepEqual(waits, [SERVER_RETRY_MS, SERVER_RETRY_MS * 2]);
  stub.hooks.fail = (req) => (req.method === "POST" && req.url === "/api/user/repos" ? { status: 502, body: { message: "Server Error" } } : null);
  const from = stub.requests.length;
  await assert.rejects(api.createRepo({ name: repoName() }), (e) => e.code === "server");
  assert.equal(stub.requests.length - from, 1, "a new repository is not asked for twice");
  stub.hooks.fail = () => ({ status: 503, body: { message: "Unavailable" } });
  await assert.rejects(api.user(), (e) => e.code === "server");
  stub.hooks.fail = null;
  for (const [method, path, same] of [["GET", "/user", true], ["PATCH", "/repos/o/n/git/refs/heads/main", true], ["POST", "/repos/o/n/git/blobs", true], ["POST", "/repos/o/n/forks", true], ["POST", "/user/repos", false], ["POST", "/repos/o/n/pulls", false], ["POST", "/repos/o/n/git/refs", false]]) assert.equal(sameIfRepeated(method, path), same, `${method} ${path}`);
});
