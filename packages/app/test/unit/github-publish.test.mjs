// Publish stage 2's flow (src/github/publish-flow.mjs) through the stand-in for GitHub CLI (test/fixtures/fake-gh.mjs,
// run as a program the way the app runs gh) against the stand-in for GitHub on 127.0.0.1: sign in by code, the
// person's public repository with the project's files in one commit, read back, and the pull request to the catalog,
// from a fork when the person may not push to the catalog and from a branch in it when they may.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { ghEnvironment, ghFolders, ghRunner } from "../../src/github/gh.mjs";
import { fakeSignedIn, runFakeGh } from "../fixtures/fake-gh.mjs";
import { BUNDLED_TEMPLATE, BUSY_CATALOGS, changedSinceCheck, compareVersions, isOptionalBox, createGithubPublish, MAX_BOX_LENGTH, MAX_BOXES, requestQuestions, fillTemplate, parseCatalog, parseChecklist, parseRepository, readCatalogManifest, withChangelog } from "../../src/github/publish-flow.mjs";
import { createPublishRecord } from "../../src/github/publish-record.mjs";
import { FAKE_GH } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { PORTS } from "../helpers.mjs";

let stub;
let root;
let record;
before(async () => {
  stub = await startGithubStub({ port: PORTS.unit });
  root = mkdtempSync(path.join(os.tmpdir(), "busy-publish-2-"));
  // The app's own record of what it published, in its data folder: one for the file, as one app's.
  record = createPublishRecord(path.join(root, "app-data"));
});
after(async () => {
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

const ID = "io.github.octo.clock";
const MANIFEST_HEAD = "sourcecode:\n  type: git\n  location:\n";
// What the environment of the app may hold; gh must never get it.
const LEAKED = "dummy-env-token-never-sent-0123456789";

/** A project folder with its files, and what `publish status` and `publish files` would say of it. */
function project(name) {
  const dir = path.join(root, name);
  const files = { "catalog.json": "{}\n", LICENSE: "MIT\n", "package.json": "{}\n", "src/main.ts": "draw();\n", "screenshots/front-1.png": "png", ".github/workflows/ci.yml": "on: push\n" };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  const status = { folder: dir, id: ID, name: "Clock", version: "1.0.0", license: { ready: true }, texts: { texts: { short_description: "A clock for the bar" } }, github: { repo: null, request: null }, catalog: "busy-app/busy-apps-catalog" };
  const plan = { published: Object.keys(files).map((rel) => ({ path: rel })), findings: [] };
  return { dir, status, plan };
}

/**
 * The flow with its own data folder, running the stand-in for gh as the app runs gh (ghEnvironment, ghRunner), with
 * a folder that stands for the person's own GitHub CLI configuration (`personGh`: { login, token, accounts } signs it
 * in first, as fake-gh's fakeSignedIn). `runs()`: what each run of gh was given (fake-gh.mjs BUSY_EMULATOR_FAKE_GH_LOG);
 * `store()`: the stand-in's "system store"; `hosts()`: the person's hosts.yml.
 */
/** BUSY's catalogs and the stand-ins for one the tests send to, which need no second confirmation here (L3). */
const standInCatalogs = () => [...BUSY_CATALOGS, ...["catalog-owner/busy-apps-catalog-demo", "other-owner/apps-catalog", "empty-owner/empty-catalog", "busy-app/not-open-yet", "located-owner/located-catalog", "versions-owner/versions-catalog", "update-owner/update-catalog", "hijack-owner/hijack-catalog"], `${stub.login}/own-catalog`];

function flowFor({ env = {}, dataDir = mkdtempSync(path.join(root, "data-")), personGh = null, catalogs = standInCatalogs(), downloads = { origins: [{ protocol: "http:", host: new URL(stub.base).host }] } } = {}) {
  const opened = [];
  const runLog = path.join(dataDir, "gh-runs.jsonl");
  const folders = ghFolders(dataDir);
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const person = path.join(dataDir, "person");
  const configDir = path.join(person, "gh");
  if (personGh) fakeSignedIn(person, { standIn: stub.base, ...personGh });
  const ghEnv = ghEnvironment({ ...process.env, GH_TOKEN: LEAKED, GITHUB_TOKEN: LEAKED, BUSY_EMULATOR_FAKE_GH_STAND_IN: stub.base, BUSY_EMULATOR_FAKE_GH_LOG: runLog, BUSY_EMULATOR_FAKE_GH_POLL_MS: "5", ...env }, dataDir, configDir);
  const gh = { run: ghRunner({ command: process.execPath, prefix: [FAKE_GH], env: ghEnv, cwd: folders.root }) };
  const flow = createGithubPublish({ gh, dataDir, configDir, record, openExternal: (address) => opened.push(address), sleep: async () => {}, writeGapMs: 0, catalogs, downloads });
  const runs = () => (existsSync(runLog) ? readFileSync(runLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const store = () => (existsSync(path.join(person, "fake-keyring.json")) ? JSON.parse(readFileSync(path.join(person, "fake-keyring.json"), "utf8")) : {});
  const hosts = () => (existsSync(path.join(configDir, "hosts.yml")) ? readFileSync(path.join(configDir, "hosts.yml"), "utf8") : "");
  /** The person's own gh, run in the terminal: the same configuration and store. */
  const personRuns = (args) => runFakeGh(args, { env: { GH_CONFIG_DIR: configDir, GH_HOST: "github.com", BUSY_EMULATOR_FAKE_GH_STAND_IN: stub.base } });
  return { flow, opened, runs, store, hosts, dataDir, folders, configDir, personRuns };
}

const CODE = { body: { device_code: "device-code-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } };
const OWN = "octo-own";

/** Signs in by a code (gh auth login), as `token`'s account (the stand-in's person by default). */
async function signedIn(options = {}, token = stub.token) {
  const made = flowFor(options);
  stub.device.answers.push(CODE, { body: { error: "authorization_pending" } }, { body: { access_token: token, token_type: "bearer", scope: "repo,read:org,gist" } });
  const shown = await made.flow.signIn();
  assert.deepEqual([shown.userCode, shown.verificationUri], ["ABCD-1234", "https://github.com/login/device"]);
  assert.equal((await made.flow.status()).signing.userCode, "ABCD-1234");
  made.flow.openCodePage();
  made.done = await made.flow.waitSignIn();
  return made;
}

/** What `publish pushed` notes: the repository in the record and in the manifest. */
function noted(p, pushed) {
  p.status.github.repo = { owner: pushed.owner, name: pushed.name, page: pushed.page, commit: pushed.commit };
  return `${MANIFEST_HEAD}    origin: https://github.com/${pushed.owner}/${pushed.name}.git\n    commit_sha: ${pushed.commit}\ncategory: clocks\n`;
}

const TEMPLATE = "# Author checklist\n\n- [ ] I'm the author of the app or have write access to its repository\n- [ ] The app builds with `busy-cli build`, and the lock file is committed\n\n# AI usage\n\n- No AI was used.\n- Partly AI-assisted: which parts, and what they do.\n- Fully AI-generated: what the generated code does.\n";
/** Every box of the templates the tests' catalogs have, or of the bundled one: what a person who ticked all sends. */
const ALL_TICKED = [...new Set([...parseChecklist(BUNDLED_TEMPLATE).boxes, ...parseChecklist(TEMPLATE).boxes])];

test("the happy path: sign in by code, a new public repository with the project's files in one commit read back, then a pull request from a fork of the catalog", async () => {
  const { flow, opened, runs, store, hosts, configDir, done } = await signedIn();
  assert.deepEqual(done, { login: stub.login, origin: "app", previous: null, renewed: false, kept: null }, "GitHub CLI had no account: the app signed it in");
  assert.deepEqual(opened, ["https://github.com/login/device"]);
  // gh signed in GitHub CLI on this computer, the token in the system's store (here the stand-in's), not in a file.
  assert.equal(store()["gh:github.com|octo-person"], stub.token);
  assert.match(hosts(), /^ {4}user: octo-person$/m);
  assert.doesNotMatch(hosts(), /oauth_token/);
  const status = await flow.status();
  assert.deepEqual([status.signedIn, status.login, status.configured], [true, stub.login, true]);
  assert.equal(JSON.stringify(status).includes(stub.token), false, "the page's answer never holds the token");

  const p = project("clock");
  const lines = [];
  const uploads = [];
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, progress: (line) => lines.push(line), upload: (fact) => uploads.push(fact) });
  assert.equal(pushed.owner, stub.login);
  assert.equal(pushed.name, "clock");
  assert.equal(pushed.created, true);
  assert.match(pushed.commit, /^[0-9a-f]{40}$/);
  assert.equal(pushed.page, `https://github.com/${stub.login}/clock`);
  assert.deepEqual(Object.keys(stub.filesOf(`${stub.login}/clock`, "main")).sort(), ["LICENSE", "catalog.json", "package.json", "screenshots/front-1.png", "src/main.ts"], "the files, without .github/workflows/ and the first commit's README");
  assert.equal(stub.headOf(`${stub.login}/clock`, "main"), pushed.commit);
  assert.deepEqual(lines, [`Creating the repository github.com/${stub.login}/clock`, "Uploading 5 files", "Checking what GitHub holds"]);
  // The upload's progress: what GitHub holds read first, then each file going up (done of total, bytes of the total),
  // then the commit and the check.
  assert.deepEqual([...new Set(uploads.map((one) => one.phase))], ["compare", "upload", "commit", "check"]);
  const going = uploads.filter((one) => one.phase === "upload");
  const last = going.at(-1);
  assert.deepEqual([last.done, last.bytes, last.total + last.known, last.file], [last.total, last.totalBytes, 5, "screenshots/front-1.png"], JSON.stringify(last));
  assert.ok(last.total >= 4 && last.totalBytes > 0);
  assert.deepEqual(going.filter((one) => one.done === 0 && one.file).map((one) => one.file), ["catalog.json"], "the file going up is named before it is done");
  assert.ok(going.every((one, i) => i === 0 || one.done >= going[i - 1].done), "done only grows");

  // Published again, nothing changed: the same commit, nothing uploaded.
  const manifest = noted(p, pushed);
  const again = await flow.push({ folder: p.dir, status: p.status, files: p.plan });
  assert.deepEqual([again.commit, again.unchanged, again.created], [pushed.commit, true, false]);

  stub.makeRepo("catalog-owner", "busy-apps-catalog-demo");
  stub.commitFiles("catalog-owner/busy-apps-catalog-demo", "main", { "README.md": "# Catalog\n", "applications/.gitkeep": "", ".github/PULL_REQUEST_TEMPLATE.md": TEMPLATE });
  // The checklist is the catalog's own template, read from it now (gh api, a read).
  const list = await flow.checklist({ catalog: "https://github.com/catalog-owner/busy-apps-catalog-demo" });
  assert.deepEqual([list.source, list.file, list.catalog], ["catalog", ".github/PULL_REQUEST_TEMPLATE.md", "catalog-owner/busy-apps-catalog-demo"]);
  assert.deepEqual(list.boxes, ["I'm the author of the app or have write access to its repository", "The app builds with `busy-cli build`, and the lock file is committed"]);
  assert.deepEqual(list.ai.map((one) => one.id), ["none", "partly", "full"]);
  // Nothing is sent before every box is ticked and the AI usage chosen.
  const sentBefore = stub.requests.filter((r) => r.method !== "GET").length;
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "catalog-owner/busy-apps-catalog-demo", ticked: [], ai: "none", manifest }), { code: "not_ticked" });
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "catalog-owner/busy-apps-catalog-demo", ticked: [list.boxes[0]], ai: "none", manifest }), { code: "not_ticked", message: /one is not ticked/ });
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "catalog-owner/busy-apps-catalog-demo", author: true, ai: "none", manifest }), { code: "not_ticked" }, "the old authorship flag alone is no tick");
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "catalog-owner/busy-apps-catalog-demo", ticked: list.boxes, ai: null, manifest }), { code: "no_ai_choice" });
  assert.equal(stub.requests.filter((r) => r.method !== "GET").length, sentBefore, "nothing was written");
  const from = stub.requests.length;
  const made = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "https://github.com/catalog-owner/busy-apps-catalog-demo", ticked: list.boxes, ai: "partly", manifest, testing: "Built and run on BUSY Bar Emulator." });
  assert.equal(made.created, true);
  assert.equal(made.direct, false);
  assert.equal(made.branch, `${stub.login}/${ID}_1.0.0`);
  assert.ok(stub.requests.slice(from).some((r) => r.method === "POST" && r.path === "/api/repos/catalog-owner/busy-apps-catalog-demo/forks"), "forked");
  const pull = stub.pulls.at(-1);
  assert.equal(pull.head, `${stub.login}:${stub.login}/${ID}_1.0.0`);
  assert.equal(pull.maintainerCanModify, true);
  assert.equal(pull.title, "Add Clock 1.0.0");
  assert.match(pull.body, /^- \[x\] I'm the author of the app or have write access to its repository$/m);
  assert.match(pull.body, /^- \[x\] The app builds with `busy-cli build`, and the lock file is committed$/m, "every box the person ticked");
  assert.match(pull.body, /^- Partly AI-assisted/m);
  assert.doesNotMatch(pull.body, /No AI was used|Fully AI-generated/);
  assert.match(pull.body, /# Device testing\n\nBuilt and run on BUSY Bar Emulator\./);
  assert.deepEqual(stub.filesOf(`${stub.login}/busy-apps-catalog-demo`, `${stub.login}/${ID}_1.0.0`)[`applications/${ID}/manifest.yml`], manifest);

  // Sent again with the request open: no second pull request.
  const twice = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "catalog-owner/busy-apps-catalog-demo", ticked: list.boxes, ai: "partly", manifest });
  assert.deepEqual([twice.created, twice.url], [false, made.url]);

  // No token anywhere but the Authorization header gh sent; none from the environment, in every run of gh.
  for (const r of stub.requests) assert.equal(r.path.includes(stub.token), false);
  for (const run of runs()) {
    // GH_TOKEN only for a call of gh api, with the chosen account's token (the stand-in refuses any other, the
    // environment's included); never GITHUB_TOKEN, never for another command.
    assert.deepEqual(run.tokens, run.args[0] === "api" ? ["GH_TOKEN"] : [], `GH_TOKEN and GITHUB_TOKEN are not passed to gh ${run.args.slice(0, 2).join(" ")}`);
    assert.equal(run.configDir, configDir, "the person's GitHub CLI configuration");
    assert.equal(run.host, "github.com");
    assert.equal(run.prompt, "1");
    assert.equal(run.args.includes("--insecure-storage"), false);
  }
  assert.deepEqual(runs().find((run) => run.args[0] === "auth").args, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"]);
  assert.ok(runs().filter((run) => run.args[0] === "api").every((run) => run.args.includes("--hostname") && run.args[run.args.indexOf("--hostname") + 1] === "github.com"));
  assert.equal(runs().some((run) => run.args[0] === "auth" && run.args[1] === "status"), false, "gh auth status is never run");
  // Signed out here without the tick: GitHub CLI keeps the account the app signed in.
  const out = await flow.signOut({ open: true });
  assert.deepEqual([out.cliSignedOut, out.switchedBack, out.cliAccount], [false, false, stub.login]);
  assert.equal((await flow.status()).signedIn, false);
  assert.equal(runs().some((run) => run.args[1] === "logout"), false);
  assert.equal(store()["gh:github.com|octo-person"], stub.token);
  assert.equal(opened.at(-1), "https://github.com/settings/applications");
});

test("an account the app signed in is signed out of GitHub CLI only when the person ticks it", async () => {
  const { flow, runs, store, hosts } = await signedIn();
  const out = await flow.signOut({ signOutCli: true });
  assert.equal(out.cliSignedOut, true);
  assert.deepEqual(runs().at(-2).args, ["auth", "logout", "--hostname", "github.com", "--user", stub.login]);
  assert.deepEqual(store(), {});
  assert.doesNotMatch(hosts(), /octo-person/);
});

test("a catalog the person may push to (one of their own): a branch in it, no fork", async () => {
  const { flow } = await signedIn();
  const p = project("clock-own");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-own" });
  const manifest = noted(p, pushed);
  stub.makeRepo(stub.login, "own-catalog");
  const from = stub.requests.length;
  const made = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: `${stub.login}/own-catalog`, ticked: ALL_TICKED, ai: "none", manifest });
  assert.equal(made.direct, true);
  assert.equal(stub.requests.slice(from).some((r) => r.path.endsWith("/forks")), false);
  assert.equal(stub.pulls.at(-1).head, `${stub.login}:${stub.login}/${ID}_1.0.0`);
  assert.ok(stub.headOf(`${stub.login}/own-catalog`, `${stub.login}/${ID}_1.0.0`));
});

test("a new version while the request for the earlier one is open: its commit goes into that request, which takes the new title and text; another person's request and one of another app are not it", async () => {
  const { flow } = await signedIn();
  const p = project("clock-versions");
  const catalog = "versions-owner/versions-catalog";
  stub.makeRepo("versions-owner", "versions-catalog");
  stub.commitFiles(catalog, "main", { "README.md": "# Catalog\n", ".github/PULL_REQUEST_TEMPLATE.md": TEMPLATE });
  // Someone else's open request for the same app id, and one of the person's for another app.
  stub.makeRepo("someone-else", "versions-catalog").forkOf = catalog;
  stub.repoOf("someone-else/versions-catalog").refs.set("main", stub.headOf(catalog, "main"));
  stub.commitFiles("someone-else/versions-catalog", "theirs", { [`applications/${ID}/manifest.yml`]: "theirs\n" });
  stub.pulls.push({ number: 900, author: "someone-else", base: catalog, head: "someone-else:theirs", headRepo: stub.repoOf("someone-else/versions-catalog"), headRef: "theirs", baseBranch: "main", title: "Theirs", body: "", state: "open", url: `https://github.com/${catalog}/pull/900` });

  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-versions" });
  let manifest = noted(p, pushed);
  const first = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest });
  assert.equal(first.created, true);
  assert.equal(first.branch, `${stub.login}/${ID}_1.0.0`);
  // The person's request for another app, open at the same time.
  const other = project("other-app");
  other.status.id = "io.github.octo.other";
  const otherPushed = await flow.push({ folder: other.dir, status: other.status, files: other.plan, name: "other-app" });
  const otherMade = await flow.request({ status: other.status, files: other.plan, folder: other.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest: noted(other, otherPushed) });
  assert.equal(otherMade.created, true);
  const count = stub.pulls.length;

  // Version 1.1.0: a change, published again, and sent.
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(110);\n");
  p.status.version = "1.1.0";
  const again = await flow.push({ folder: p.dir, status: p.status, files: p.plan });
  manifest = noted(p, again);
  const second = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "partly", manifest });
  assert.deepEqual([second.created, second.number, second.url, second.branch], [false, first.number, first.url, `${stub.login}/${ID}_1.0.0`], "into the open request, on its branch");
  assert.equal(stub.pulls.length, count, "no second request");
  const pull = stub.pulls.find((one) => one.number === first.number);
  assert.equal(pull.title, "Add Clock 1.1.0");
  assert.match(pull.body, /^- Partly AI-assisted/m);
  assert.match(stub.filesOf(`${stub.login}/versions-catalog`, `${stub.login}/${ID}_1.0.0`)[`applications/${ID}/manifest.yml`], new RegExp(`commit_sha: ${again.commit}`));
  assert.equal(stub.pulls.find((one) => one.number === 900).title, "Theirs", "someone else's request is left alone");
  assert.equal(stub.pulls.find((one) => one.number === otherMade.number).title, "Add Clock 1.0.0", "the request of another app is left alone");

  // Once it is closed, the next version opens a new request on a branch of its own.
  pull.state = "closed";
  p.status.version = "1.2.0";
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(120);\n");
  manifest = noted(p, await flow.push({ folder: p.dir, status: p.status, files: p.plan }));
  const third = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest });
  assert.deepEqual([third.created, third.branch], [true, `${stub.login}/${ID}_1.2.0`]);
});

test("the person has a repository named like the catalog that is not its fork: GitHub names the fork -1, and that name is used", async () => {
  const { flow } = await signedIn();
  const p = project("clock-fork-name");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-fork-name" });
  const manifest = noted(p, pushed);
  stub.makeRepo("other-owner", "apps-catalog");
  stub.commitFiles("other-owner/apps-catalog", "main", { "README.md": "# Catalog\n" });
  stub.makeRepo(stub.login, "apps-catalog");
  const made = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "other-owner/apps-catalog", ticked: ALL_TICKED, ai: "full", manifest });
  assert.equal(made.direct, false);
  const branch = `${stub.login}/${ID}_1.0.0`;
  assert.ok(stub.headOf(`${stub.login}/apps-catalog-1`, branch), "the branch is in the fork GitHub named");
  assert.equal(stub.headOf(`${stub.login}/apps-catalog`, branch), null, "and not in the person's own repository of that name");
  assert.equal(stub.pulls.at(-1).head, `${stub.login}:${branch}`);
});

test("a catalog that cannot be seen, an empty one, a name that is taken: each a sentence and what to do", async () => {
  const { flow } = await signedIn();
  const p = project("clock-errors");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-errors" });
  const manifest = noted(p, pushed);
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "busy-app/not-open-yet", ticked: ALL_TICKED, ai: "none", manifest }), { code: "catalog_closed", message: "The catalog repository cannot be seen (it is private, or not there), so a request can't be sent.", hint: "Check its address and try again, or send it by hand (SUBMIT.md)." });
  stub.makeRepo("empty-owner", "empty-catalog", { autoInit: false });
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "empty-owner/empty-catalog", ticked: ALL_TICKED, ai: "none", manifest }), { code: "catalog_empty" });
  // Another project names the same repository: it is the person's, so it is offered to publish into, after they confirm.
  const other = project("clock-other");
  await assert.rejects(flow.push({ folder: other.dir, status: other.status, files: other.plan, name: "clock-errors" }), { code: "confirm_existing", hint: "Confirm Publish into it in the window first." });
  // Archived, or with no commit: refused, each with why.
  stub.makeRepo(stub.login, "clock-archived").archived = true;
  await assert.rejects(flow.push({ folder: other.dir, status: other.status, files: other.plan, name: "clock-archived" }), { code: "archived" });
  stub.makeRepo(stub.login, "clock-empty", { autoInit: false });
  await assert.rejects(flow.push({ folder: other.dir, status: other.status, files: other.plan, name: "clock-empty" }), { code: "empty_repo" });
  // A file changed after the push: the request is refused until it is published again.
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(2);\n");
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: `${stub.login}/own-catalog`, ticked: ALL_TICKED, ai: "none", manifest }), { code: "changed_since_upload" });
});

test("a repository of the person's the app did not publish to is offered, never written without the person's confirmation of its head; a commit on top keeps its other files unless they agree (catalog-update)", async () => {
  const { flow } = await signedIn();
  stub.makeRepo(stub.login, "dotfiles");
  stub.commitFiles(`${stub.login}/dotfiles`, "main", { ".zshrc": "mine\n", ".github/workflows/x.yml": "on: push\n" });
  const before = stub.headOf(`${stub.login}/dotfiles`, "main");
  const p = project("forged");
  p.status.files = p.plan;
  const planned = await flow.plan({ folder: p.dir, status: p.status, name: null });
  assert.equal(planned.name, "clock", "the project's file does not name the repository");
  const there = await flow.plan({ folder: p.dir, status: p.status, name: "dotfiles" });
  assert.deepEqual([there.mode, there.head, there.branch, there.suggestion], ["existing", before, "main", null], "no free name looked for while the name is checked (F4)");
  assert.deepEqual(there.extra.sort(), [".zshrc", "README.md"], "the files it has and the project has not, but for .github/workflows/");
  // Without the person's confirmation, or with a head they were not shown: nothing is written.
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "dotfiles" }), { code: "confirm_existing" });
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "dotfiles", into: { head: "f".repeat(40) } }), { code: "changed_since_look" });
  assert.equal(stub.headOf(`${stub.login}/dotfiles`, "main"), before, "untouched");
  // Confirmed: a new commit on top, nothing deleted.
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "dotfiles", into: { head: before } });
  assert.deepEqual([pushed.mode, pushed.removed], ["existing", 0]);
  const files = stub.filesOf(`${stub.login}/dotfiles`, "main");
  assert.deepEqual([files[".zshrc"], files["src/main.ts"], files[".github/workflows/x.yml"]], ["mine\n", "draw();\n", "on: push\n"]);
  assert.equal(stub.repoOf(`${stub.login}/dotfiles`) && (await flow.plan({ folder: p.dir, status: p.status, name: null })).mode, "replace", "now the app's, adopted");
  assert.equal(record.get(p.dir).repo.adopted, true);
  // Published again: its own files still stay; only with the person's tick do they go.
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(3);\n");
  const again = await flow.plan({ folder: p.dir, status: p.status, name: null });
  assert.deepEqual([again.mode, again.adopted, again.extra.sort()], ["replace", true, [".zshrc", "README.md"]]);
  await flow.push({ folder: p.dir, status: p.status, files: p.plan });
  assert.equal(stub.filesOf(`${stub.login}/dotfiles`, "main")[".zshrc"], "mine\n");
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(4);\n");
  const third = await flow.push({ folder: p.dir, status: p.status, files: p.plan, into: { head: stub.headOf(`${stub.login}/dotfiles`, "main"), deleteOthers: true } });
  assert.equal(third.removed, 2);
  const left = stub.filesOf(`${stub.login}/dotfiles`, "main");
  assert.equal(left[".zshrc"], undefined);
  assert.equal(left[".github/workflows/x.yml"], "on: push\n", ".github/workflows/ is never touched");
  // The app's own record naming a repository with a commit that is not in it: not the app's, so it asks again.
  const q = project("forged-2");
  stub.makeRepo(stub.login, "dotfiles-2");
  record.pushed(q.dir, { owner: stub.login, name: "dotfiles-2", commit: "f".repeat(40) });
  assert.equal((await flow.plan({ folder: q.dir, status: q.status, name: "dotfiles-2" })).mode, "existing");
  await assert.rejects(flow.push({ folder: q.dir, status: q.status, files: q.plan, name: "dotfiles-2" }), { code: "confirm_existing" });
});

test("a repository with commits the project doesn't have is never published into: the app's own, an imported one, or the project's own git (catalog-update)", async () => {
  const { flow } = await signedIn();
  // The app's own repository, changed on GitHub since.
  const p = project("ahead-own");
  await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "ahead-own" });
  stub.commitFiles(`${stub.login}/ahead-own`, "main", { "NOTES.md": "from the web\n" });
  const head = stub.headOf(`${stub.login}/ahead-own`, "main");
  const planned = await flow.plan({ folder: p.dir, status: p.status, name: null });
  assert.deepEqual([planned.mode, planned.ahead], ["diverged", 1]);
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan }), { code: "remote_ahead", message: /has a commit this project doesn't have/ });
  assert.equal(stub.headOf(`${stub.login}/ahead-own`, "main"), head, "nothing sent");
  // A project imported at a commit, the repository moved on since.
  const q = project("ahead-imported");
  stub.makeRepo(stub.login, "ahead-imported");
  const at = stub.commitFiles(`${stub.login}/ahead-imported`, "main", { "src/main.ts": "draw();\n" });
  record.imported(q.dir, { owner: stub.login, name: "ahead-imported", commit: at });
  assert.equal((await flow.plan({ folder: q.dir, status: q.status, name: null })).mode, "existing", "named after the repository it came from; at its head, so it may go in");
  stub.commitFiles(`${stub.login}/ahead-imported`, "main", { "x.md": "x\n" });
  assert.equal((await flow.plan({ folder: q.dir, status: q.status, name: null })).mode, "diverged");
  // The project's own git at a commit GitHub does not know, which does not hold GitHub's head.
  const g = project("ahead-git");
  stub.makeRepo(stub.login, "ahead-git");
  mkdirSync(path.join(g.dir, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(path.join(g.dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(g.dir, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  assert.deepEqual((await flow.plan({ folder: g.dir, status: g.status, name: "ahead-git" })).mode, "diverged");
  // ... and once it holds it (a loose object), it is not.
  const remote = stub.headOf(`${stub.login}/ahead-git`, "main");
  mkdirSync(path.join(g.dir, ".git", "objects", remote.slice(0, 2)), { recursive: true });
  writeFileSync(path.join(g.dir, ".git", "objects", remote.slice(0, 2), remote.slice(2)), "");
  assert.equal((await flow.plan({ folder: g.dir, status: g.status, name: "ahead-git" })).mode, "existing");
});

test("an app the catalog has already: an update, only with a higher version and a new What's new, titled Update, with the new commit (catalog-update)", async () => {
  const { flow } = await signedIn();
  const p = project("clock-update");
  const meta = (version) => `{ "id": "${ID}", "name": "Clock", "version": "${version}" }\n`;
  mkdirSync(path.join(p.dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(p.dir, "src", "appmeta", "manifest.json"), meta("1.0.0"));
  p.plan.published.push({ path: "src/appmeta/manifest.json" });
  const first = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-update" });
  // The catalog has version 1.0.0, from that repository at that commit (merged before; here put in by hand).
  const catalog = "update-owner/update-catalog";
  stub.makeRepo("update-owner", "update-catalog");
  stub.commitFiles(catalog, "main", { "README.md": "# Catalog\n", [`applications/${ID}/manifest.yml`]: `${MANIFEST_HEAD}    origin: https://github.com/${stub.login}/clock-update.git\n    commit_sha: ${first.commit}\ncategory: clocks\nchangelog: |-\n  The first version.\n  Big digits.\nscreenshots:\n- screenshots/front-1.png\n` });
  const found = await flow.entry({ status: p.status, catalog });
  assert.deepEqual([found.exists, found.published.version, found.published.changelog, found.higher, found.yours], [true, "1.0.0", "The first version.\nBig digits.", false, true]);
  // From the repository this project was published to: nothing to warn of.
  assert.equal((await flow.entry({ status: p.status, catalog, folder: p.dir })).elsewhere, null);
  let manifest = `${noted(p, first)}changelog: The first version.\n`;
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest }), { code: "version_not_higher", message: /has version 1\.0\.0 of Clock, and this package is 1\.0\.0/, hint: /Raise version in src\/appmeta\/manifest\.json above 1\.0\.0/ });
  // 1.1.0, published to GitHub; What's new still the published one's: refused.
  writeFileSync(path.join(p.dir, "src", "appmeta", "manifest.json"), meta("1.1.0"));
  p.status.version = "1.1.0";
  const second = await flow.push({ folder: p.dir, status: p.status, files: p.plan });
  manifest = `${noted(p, second)}changelog: |-\n  The first version.\n  Big digits.\n`;
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest }), { code: "no_changelog", message: /same as the published version's/ });
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest, changelog: "short" }), { code: "bad_changelog" });
  // catalog.json changed after the push (What's new written there) is no change of the build.
  writeFileSync(path.join(p.dir, "catalog.json"), '{ "changelog": "Alarms, and a dimmer at night." }\n');
  const made = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest, changelog: "Alarms, and a dimmer at night." });
  assert.deepEqual([made.update, made.title], [true, "Update Clock to 1.1.0"]);
  const pull = stub.pulls.at(-1);
  assert.equal(pull.title, "Update Clock to 1.1.0");
  const sent = stub.filesOf(`${stub.login}/update-catalog`, made.branch)[`applications/${ID}/manifest.yml`];
  assert.match(sent, new RegExp(`commit_sha: ${second.commit}`));
  assert.deepEqual(readCatalogManifest(sent).changelog, "Alarms, and a dimmer at night.");
  // The same id from another repository of the same account (the release dry run, 12.11): said before sending, with
  // that repository's name; for the window only, it is not refused (the app may have moved).
  stub.commitFiles(catalog, "main", { [`applications/${ID}/manifest.yml`]: `${MANIFEST_HEAD}    origin: https://github.com/${stub.login}/old-clock.git\n    commit_sha: ${"c".repeat(40)}\nchangelog: x\n` });
  const moved = await flow.entry({ status: p.status, catalog, folder: p.dir });
  assert.deepEqual([moved.yours, moved.elsewhere], [true, `${stub.login}/old-clock`]);
  assert.equal((await flow.entry({ status: p.status, catalog })).elsewhere, null, "no folder, no repository to compare");
  // Someone else's app of that id: no update from this account.
  stub.commitFiles(catalog, "main", { [`applications/${ID}/manifest.yml`]: `${MANIFEST_HEAD}    origin: https://github.com/someone-else/clock.git\n    commit_sha: ${"b".repeat(40)}\nchangelog: x\n` });
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest, changelog: "Alarms, and a dimmer at night." }), { code: "not_your_app" });
  const theirs = await flow.entry({ status: p.status, catalog, folder: p.dir });
  assert.deepEqual([theirs.yours, theirs.elsewhere], [false, null]);
});

test("Import from GitHub: the default branch's files in a new folder, each checked, links and submodules left out and named; a bad path leaves nothing (catalog-update)", async () => {
  const { flow } = await signedIn();
  stub.makeRepo(stub.login, "import-me");
  const head = stub.commitFiles(`${stub.login}/import-me`, "main", { "src/appmeta/manifest.json": `{ "id": "${ID}", "name": "Clock", "version": "2.0.0" }\n`, "run.sh": "#!/bin/sh\n", "link": "src/main.ts", "vendor/lib": "c".repeat(40), "src/main.ts": "draw();\n" }, { modes: { "run.sh": "100755", link: "120000", "vendor/lib": "160000" } });
  const seen = await flow.lookup({ repo: `https://github.com/${stub.login}/import-me/tree/main` });
  assert.deepEqual([seen.owner, seen.name, seen.branch, seen.app], [stub.login, "import-me", "main", { id: ID, name: "Clock", version: "2.0.0" }]);
  await assert.rejects(flow.lookup({ repo: "https://gitlab.com/a/b" }), { code: "not_github", message: "Only repositories on github.com can be imported." });
  await assert.rejects(flow.lookup({ repo: `${stub.login}/not-there` }), { code: "repo_not_found" });
  const into = path.join(root, "imported", "import-me");
  mkdirSync(path.dirname(into), { recursive: true });
  const facts = [];
  const got = await flow.download({ repo: `${stub.login}/import-me`, folder: into, upload: (one) => facts.push(one) });
  assert.deepEqual([got.commit, got.files, got.skipped], [head, 4, [{ path: "link", why: "a link" }, { path: "vendor/lib", why: "a submodule" }].sort((a, b) => (a.path < b.path ? -1 : 1))]);
  assert.equal(readFileSync(path.join(into, "src", "main.ts"), "utf8"), "draw();\n");
  assert.equal(readFileSync(path.join(into, "README.md"), "utf8"), "# import-me\n");
  if (process.platform !== "win32") assert.ok((await import("node:fs")).statSync(path.join(into, "run.sh")).mode & 0o100);
  assert.equal(existsSync(path.join(into, "link")), false);
  assert.deepEqual([facts.at(-1).phase, facts.at(-1).done, facts.at(-1).total], ["download", 4, 4]);
  await assert.rejects(flow.download({ repo: `${stub.login}/import-me`, folder: into }), { code: "folder_taken" });
  // A path no folder here can hold as it is: refused, and nothing is left behind.
  stub.makeRepo(stub.login, "import-bad");
  stub.commitFiles(`${stub.login}/import-bad`, "main", { "ok.txt": "x", "sub/.git/config": "x" });
  const bad = path.join(root, "imported", "import-bad");
  await assert.rejects(flow.download({ repo: `${stub.login}/import-bad`, folder: bad }), { code: "bad_path", message: /sub\/\.git\/config \(inside a \.git folder\)/ });
  assert.deepEqual((await import("node:fs")).readdirSync(path.dirname(bad)).sort(), ["import-me"]);
});

test("Import from GitHub of a repository that is no app project: its latest release's .tgz offered, downloaded read only over the allowed hosts; nothing else to offer is said", async () => {
  const { flow, dataDir } = await signedIn();
  // A repository with only a release package, as busybar-claude-code has.
  stub.makeRepo(stub.login, "bar-release");
  stub.commitFiles(`${stub.login}/bar-release`, "main", { "README.md": "# Claude Code on the bar\n" });
  const pack = Buffer.from("the package's bytes");
  stub.addRelease(`${stub.login}/bar-release`, "v1.4.0", { "notes.txt": "x", "app.you.claude.tgz": pack, "other.tgz": "y" });
  const seen = await flow.lookup({ repo: `${stub.login}/bar-release` });
  assert.equal(seen.app, null);
  assert.deepEqual(seen.release, { tag: "v1.4.0", version: "1.4.0", page: `https://github.com/${stub.login}/bar-release/releases/tag/v1.4.0`, asset: { name: "app.you.claude.tgz", size: pack.length } }, "the first .tgz, without its address");
  assert.equal(seen.nothing, null);
  const into = mkdtempSync(path.join(dataDir, "release-"));
  const before = stub.requests.length;
  const got = await flow.downloadRelease({ repo: `https://github.com/${stub.login}/bar-release`, into });
  assert.deepEqual([got.asset, got.size, got.tag, got.version, got.file], ["app.you.claude.tgz", pack.length, "v1.4.0", "1.4.0", path.join(into, "app.you.claude.tgz")]);
  assert.deepEqual(readFileSync(got.file), pack);
  const fetched = stub.requests.slice(before).filter((r) => !r.path.startsWith("/api"));
  assert.deepEqual(fetched.map((r) => r.path), [`/releases/${stub.login}/bar-release/v1.4.0/app.you.claude.tgz`, `/download/${stub.login}/bar-release/v1.4.0/app.you.claude.tgz`], "through GitHub's redirect");
  for (const r of fetched) assert.equal(r.headers.authorization, undefined, "no token goes with the download");
  // A size other than GitHub said: not kept.
  stub.addRelease(`${stub.login}/bar-release`, "v1.5.0", { "app.tgz": pack }, { sizes: { "app.tgz": pack.length + 1 } });
  await assert.rejects(flow.downloadRelease({ repo: `${stub.login}/bar-release`, into: mkdtempSync(path.join(dataDir, "release-")) }), { code: "download_failed" });
  // A download sent to a host that is not allowed: refused.
  const strict = flowFor({ dataDir, downloads: { origins: [{ protocol: "https:", host: "github.com" }] } });
  await assert.rejects(strict.flow.downloadRelease({ repo: `${stub.login}/bar-release`, into }), { code: "download_failed", message: /not its own/ });
  // Neither a project nor a package: what was found is said.
  stub.makeRepo(stub.login, "just-docs");
  assert.equal((await flow.lookup({ repo: `${stub.login}/just-docs` })).nothing, `github.com/${stub.login}/just-docs has no app project (no src/appmeta/manifest.json), and it has no releases.`);
  stub.addRelease(`${stub.login}/just-docs`, "v2.0.0", { "docs.zip": "z" });
  const docs = await flow.lookup({ repo: `${stub.login}/just-docs` });
  assert.deepEqual([docs.release, docs.nothing], [null, `github.com/${stub.login}/just-docs has no app project (no src/appmeta/manifest.json), and its latest release v2.0.0 has no .tgz file, only docs.zip.`]);
  await assert.rejects(flow.downloadRelease({ repo: `${stub.login}/just-docs`, into }), { code: "no_package", message: /only docs\.zip\. There is nothing to install\./ });
  // An app project is offered as one, never its release.
  stub.makeRepo(stub.login, "real-app");
  stub.commitFiles(`${stub.login}/real-app`, "main", { "src/appmeta/manifest.json": `{ "id": "${ID}", "name": "Clock", "version": "2.0.0" }\n` });
  stub.addRelease(`${stub.login}/real-app`, "v2.0.0", { "x.tgz": "x" });
  assert.deepEqual((await flow.lookup({ repo: `${stub.login}/real-app` })).release, null);
});

test("repository addresses, versions and the catalog's manifests as the update reads and writes them (catalog-update)", () => {
  for (const [text, want] of [
    ["octo/clock", { owner: "octo", name: "clock" }],
    ["https://github.com/octo/clock.git", { owner: "octo", name: "clock" }],
    ["github.com/octo/clock/tree/main/src", { owner: "octo", name: "clock" }],
    // The SSH address, its "@" written as an escape (the export check takes the plain one for an address of mail).
    ["git\u0040github.com:octo/clock.git", { owner: "octo", name: "clock" }],
    ["https://gitlab.com/octo/clock", { problem: "Only repositories on github.com can be imported." }],
    ["ssh://bitbucket.org/octo/clock", { problem: "Only repositories on github.com can be imported." }],
    ["https://github.com/octo", { problem: "The address names no repository: github.com/owner/name." }],
    ["", { problem: "Paste the repository's address, or write owner/name." }],
  ]) assert.deepEqual(parseRepository(text), want, text);
  assert.deepEqual([compareVersions("1.10.0", "1.9.3"), compareVersions("1.0.0", "1.0.0"), compareVersions("0.9.9", "1.0.0"), compareVersions("1.0", "1.0.0")], [1, 0, -1, null]);
  const yaml = `sourcecode:\n  type: git\n  location:\n    origin: "https://github.com/a/b.git"\n    commit_sha: ${"a".repeat(40)}\n    subdir: apps/clock\ncategory: clocks\nchangelog: >-\n  Folded\n  text.\nscreenshots:\n- x.png\n`;
  assert.deepEqual(readCatalogManifest(yaml), { origin: "https://github.com/a/b.git", commit: "a".repeat(40), subdir: "apps/clock", changelog: "Folded text." });
  assert.equal(readCatalogManifest("changelog: 'It''s new.'\n").changelog, "It's new.");
  const written = withChangelog("category: clocks\nchangelog: |-\n  Old.\n\n  Older.\nscreenshots:\n  - a.png\n", "New: \"quotes\"\nand lines.");
  assert.equal(written, 'category: clocks\nchangelog: "New: \\"quotes\\"\\nand lines."\nscreenshots:\n  - a.png\n');
  assert.equal(readCatalogManifest(written).changelog, 'New: "quotes"\nand lines.');
});

test("a flagged file goes up only when the person chose Publish it anyway in this app; the project's own note of it is not enough", async () => {
  const { flow } = await signedIn();
  const p = project("kept-in");
  writeFileSync(path.join(p.dir, ".env"), "KEY=x\n");
  p.plan.published.push({ path: ".env" });
  p.plan.findings = [{ path: ".env", kind: "a .env file", lines: [], published: true }];
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "kept-in" }), { code: "secrets", message: ".env looks like a secret or personal data and would be published." });
  record.keepIn(p.dir, ".env");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "kept-in" });
  assert.equal(stub.filesOf(`${stub.login}/kept-in`, "main")[".env"], "KEY=x\n");
  assert.equal(pushed.files, 6);
});

test("the request's manifest names the repository the app published and checked, whatever the file in submission/ says", async () => {
  const { flow } = await signedIn();
  const p = project("located");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "located" });
  stub.makeRepo("located-owner", "located-catalog");
  stub.commitFiles("located-owner/located-catalog", "main", { "README.md": "# Catalog\n" });
  const forged = `${MANIFEST_HEAD}    origin: https://github.com/someone/elsewhere.git\n    commit_sha: ${"e".repeat(40)}\n    subdir: x\ncategory: clocks\n`;
  const made = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "located-owner/located-catalog", ticked: ALL_TICKED, ai: "none", manifest: forged });
  const sent = stub.filesOf(`${stub.login}/located-catalog`, made.branch)[`applications/${ID}/manifest.yml`];
  assert.equal(sent, `${MANIFEST_HEAD}    origin: https://github.com/${stub.login}/located.git\n    commit_sha: ${pushed.commit}\ncategory: clocks\n`);
  assert.deepEqual([made.repo, made.commit], [`https://github.com/${stub.login}/located`, pushed.commit]);
  // A second origin, commit or sourcecode block (YAML would take the last) is refused, and nothing is sent.
  for (const twice of [`${forged}    origin: https://github.com/someone/else.git\n`, `${forged}    commit_sha: ${"f".repeat(40)}\n`, `${forged}sourcecode:\n  location:\n    origin: https://github.com/someone/else.git\n`]) {
    await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "located-owner/located-catalog", ticked: ALL_TICKED, ai: "none", manifest: twice }), { code: "not_packaged" });
  }
  // A project the app never published from here sends nothing.
  const other = project("never-pushed");
  await assert.rejects(flow.request({ status: other.status, files: other.plan, folder: other.dir, catalog: "located-owner/located-catalog", ticked: ALL_TICKED, ai: "none", manifest: forged }), { code: "not_pushed" });
});

test("too many files, a file too large, a backslash in a name: refused before anything is read or sent, each naming the cause", async () => {
  const { flow } = await signedIn();
  const many = project("many");
  for (let i = 0; i < 400; i++) {
    writeFileSync(path.join(many.dir, "src", `f${i}.ts`), "");
    many.plan.published.push({ path: `src/f${i}.ts` });
  }
  const from = stub.requests.length;
  await assert.rejects(flow.push({ folder: many.dir, status: many.status, files: many.plan, name: "many" }), { code: "too_many_files", message: "The project has 405 files to publish: one upload takes at most 400." });
  const big = project("big");
  truncateSync(path.join(big.dir, "src", "main.ts"), 51 * 1024 * 1024);
  await assert.rejects(flow.push({ folder: big.dir, status: big.status, files: big.plan, name: "big" }), { code: "too_large", message: "src/main.ts is 51 MB: GitHub takes files up to 50 MB." });
  const slash = project("slash");
  slash.plan.published.push({ path: "src\\odd.ts" });
  await assert.rejects(flow.push({ folder: slash.dir, status: slash.status, files: slash.plan, name: "slash" }), { code: "bad_path" });
  assert.equal(stub.requests.slice(from).filter((r) => r.method !== "GET").length, 0, "nothing was sent");
  assert.equal(readFileSync(path.join(big.dir, "src", "main.ts")).length, 51 * 1024 * 1024);
});

test("a request someone else opened from a branch of the person's public fork is not the person's: theirs is left alone and a new one is opened", async () => {
  const { flow } = await signedIn();
  const p = project("hijack");
  await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "hijack" });
  const catalog = "hijack-owner/hijack-catalog";
  stub.makeRepo("hijack-owner", "hijack-catalog");
  stub.commitFiles(catalog, "main", { "README.md": "# Catalog\n" });
  // The person's fork, with a branch that touches the app's manifest; an attacker opens a request from it.
  const fork = stub.makeRepo(stub.login, "hijack-catalog");
  fork.forkOf = catalog;
  fork.refs.set("main", stub.headOf(catalog, "main"));
  stub.commitFiles(`${stub.login}/hijack-catalog`, "old", { [`applications/${ID}/manifest.yml`]: "old\n" });
  stub.pulls.push({ number: 950, author: "attacker", base: catalog, head: `${stub.login}:old`, headRepo: fork, headRef: "old", baseBranch: "main", title: "Attacker's", body: "", state: "open", url: `https://github.com/${catalog}/pull/950` });
  const made = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog, ticked: ALL_TICKED, ai: "none", manifest: `${MANIFEST_HEAD}category: clocks\n` });
  assert.equal(made.created, true);
  assert.notEqual(made.number, 950);
  const theirs = stub.pulls.find((one) => one.number === 950);
  assert.equal(theirs.title, "Attacker's");
  assert.equal(stub.filesOf(`${stub.login}/hijack-catalog`, "old")[`applications/${ID}/manifest.yml`], "old\n");
});

test("a build without gh signs nobody in and says so", async () => {
  const flow = createGithubPublish({ gh: null, dataDir: mkdtempSync(path.join(root, "data-")), openExternal: () => {} });
  assert.equal((await flow.status()).configured, false);
  await assert.rejects(flow.signIn(), { code: "not_configured", message: "GitHub CLI is not in this build, so it cannot sign in to GitHub." });
});

test("GitHub CLI on this computer signed in already: offered as it is, read from its configuration, nothing asked of GitHub before the person chooses it", async () => {
  const { flow, runs } = flowFor({ personGh: { login: OWN, token: stub.others[OWN] } });
  const status = await flow.status();
  assert.deepEqual([status.signedIn, status.existing], [false, OWN]);
  assert.deepEqual(runs().map((run) => run.args.join(" ")), ["config get --host github.com user"], "no gh api, no gh auth status, no secret read");
  const p = project("not-signed-in");
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan }), { code: "not_signed_in" });
  await assert.rejects(flow.plan({ folder: p.dir, status: p.status }), { code: "not_signed_in" });
  assert.equal(runs().some((run) => run.args[0] === "api"), false, "gh api never runs before the person chose an account");
});

test("Use <login>: GitHub CLI's account as it is; publishing works with it; signing out here only forgets it, even with the tick", async () => {
  const { flow, runs, store, hosts } = flowFor({ personGh: { login: stub.login, token: stub.token } });
  const before = hosts();
  assert.deepEqual(await flow.useExisting(), { login: stub.login, origin: "existing" });
  assert.deepEqual(runs().map((run) => run.args.slice(0, 2).join(" ")), ["config get", "auth token", "api /user"]);
  const status = await flow.status();
  assert.deepEqual([status.signedIn, status.login, status.origin, status.existing], [true, stub.login, "existing", null]);
  const p = project("clock-existing");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-existing" });
  assert.match(pushed.commit, /^[0-9a-f]{40}$/);
  const out = await flow.signOut({ signOutCli: true, switchBack: true });
  assert.deepEqual([out.cliSignedOut, out.switchedBack], [false, false]);
  assert.equal(runs().some((run) => run.args[0] === "auth" && run.args[1] !== "token"), false, "no gh auth logout or switch for GitHub CLI's own account");
  assert.equal(hosts(), before);
  assert.equal(store()["gh:github.com|octo-person"], stub.token);
  // GitHub CLI without an account: nothing to use.
  await assert.rejects(flowFor().flow.useExisting(), { code: "no_existing" });
});

/** GitHub CLI's configuration as a gh of another version left it (test/fixtures/gh-settings/<which>), as `login`. */
function personSettings(configDir, which, login, token) {
  mkdirSync(configDir, { recursive: true });
  for (const name of ["hosts.yml", "config.yml"]) {
    const file = path.join(import.meta.dirname, "..", "fixtures", "gh-settings", which, name);
    if (existsSync(file)) writeFileSync(path.join(configDir, name), readFileSync(file, "utf8").replaceAll("fake-alice", login).replaceAll("gho_dummy_alice", token));
  }
}

test("GitHub CLI's settings from gh 2.39 or older, never converted (one account, which gh 2.103 no longer converts): Use <login> takes GitHub CLI's active token; another sign-in is refused before gh starts, as it would sign that account out", async () => {
  for (const kept of ["plain text", "system store"]) {
    const made = flowFor();
    personSettings(made.configDir, "single-2.39.2", stub.login, stub.token);
    if (kept === "system store") {
      // gh 2.39 kept the token in the system's store under the host alone, and nothing beside the account.
      writeFileSync(path.join(made.configDir, "hosts.yml"), readFileSync(path.join(made.configDir, "hosts.yml"), "utf8").replace(/^ {4}oauth_token: .*\n/m, ""));
      writeFileSync(path.join(path.dirname(made.configDir), "fake-keyring.json"), JSON.stringify({ "gh:github.com|": stub.token }));
    }
    const before = made.hosts();
    const status = await made.flow.status();
    assert.deepEqual(status.accounts, [{ login: stub.login, active: true }], kept);
    assert.deepEqual(await made.flow.useExisting(), { login: stub.login, origin: "existing" }, kept);
    assert.deepEqual(made.runs().map((run) => run.args.join(" ")).slice(-3), [`auth token --hostname github.com --user ${stub.login}`, "auth token --hostname github.com", "api /user --hostname github.com --method GET --include -H Accept: application/vnd.github+json -H X-GitHub-Api-Version: 2022-11-28"], kept);
    await made.flow.signOut();
    const runsBefore = made.runs().length;
    await assert.rejects(made.flow.signIn(), (e) => e.code === "gh_settings_single" && e.message.includes(`which holds one account, ${stub.login}`) && /^Use octo-person here\. To add another account, update GitHub CLI and sign in again as octo-person/.test(e.hint), kept);
    assert.equal(made.runs().slice(runsBefore).some((run) => run.args[1] === "login"), false, "gh auth login never started");
    assert.equal(made.hosts(), before, `${kept}: GitHub CLI's settings as they were`);
  }
});

test("GitHub CLI's settings from a newer GitHub CLI (config version 2): its accounts are offered and usable; the emulator does not write to them: no sign-in here, and signing out only forgets", async () => {
  const made = flowFor({ personGh: { login: stub.login, token: stub.token } });
  writeFileSync(path.join(made.configDir, "config.yml"), 'version: "2"\n');
  const before = made.hosts();
  assert.deepEqual((await made.flow.status()).accounts, [{ login: stub.login, active: true }]);
  await assert.rejects(made.flow.signIn(), (e) => e.code === "gh_settings_newer" && /newer format than the emulator's copy of it knows/.test(e.message) && /gh auth login/.test(e.hint));
  assert.deepEqual(await made.flow.useExisting(), { login: stub.login, origin: "existing" });
  const out = await made.flow.signOut({ signOutCli: true, switchBack: true });
  assert.deepEqual([out.signedIn, out.cliSignedOut, out.switchedBack], [false, false, false]);
  assert.equal(made.runs().some((run) => run.args[0] === "auth" && ["login", "switch", "logout"].includes(run.args[1])), false, "nothing that writes GitHub CLI's settings");
  assert.equal(made.hosts(), before);
});

test("Sign in with another account: added to GitHub CLI, which goes on using its own; publishing goes as the new one; the tick signs it out of GitHub CLI again", async () => {
  let made = await signedIn({ personGh: { login: OWN, token: stub.others[OWN] } });
  assert.deepEqual(made.done, { login: stub.login, origin: "app", previous: null, renewed: false, kept: OWN });
  assert.match(made.hosts(), new RegExp(`^ {8}${OWN}:$`, "m"), "GitHub CLI's own account is still there");
  assert.match(made.hosts(), new RegExp(`^ {8}${stub.login}:$`, "m"), "and the new one is added");
  assert.match(made.hosts(), new RegExp(`^ {4}user: ${OWN}$`, "m"), "GitHub CLI uses its own account, as before the sign-in");
  assert.equal(made.store()["gh:github.com|"], stub.others[OWN]);
  assert.deepEqual(made.runs().filter((run) => run.args[1] === "switch").map((run) => run.args.at(-1)), [OWN], "switched back once, right after gh made the new one active");
  const status = await made.flow.status();
  assert.deepEqual([status.login, status.origin, status.previous], [stub.login, "app", null]);
  assert.deepEqual(status.accounts, [{ login: OWN, active: true }, { login: stub.login, active: false }]);
  // The push goes as the account signed in here, with its own token, while GitHub CLI uses OWN.
  const p = project("clock-another");
  const pushed = await made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-another" });
  assert.equal(pushed.owner, stub.login);
  assert.ok(stub.filesOf(`${stub.login}/clock-another`, "main")["src/main.ts"]);
  const out = await made.flow.signOut({ switchBack: true });
  assert.deepEqual([out.switchedBack, out.cliSignedOut, out.cliAccount], [false, false, OWN], "nothing to switch back");
  assert.equal(made.store()["gh:github.com|octo-person"], stub.token, "the account the app signed in stays in GitHub CLI");

  made = await signedIn({ personGh: { login: OWN, token: stub.others[OWN] } });
  const gone = await made.flow.signOut({ signOutCli: true });
  assert.deepEqual([gone.cliSignedOut, gone.cliAccount], [true, OWN], "signed out of GitHub CLI, which goes on with its own account");
  assert.equal(made.store()["gh:github.com|"], stub.others[OWN]);
  assert.equal(made.store()["gh:github.com|octo-person"], undefined);
  assert.match(made.hosts(), new RegExp(`^ {4}user: ${OWN}$`, "m"));
});

test("Sign in with another account, and the person picks an account GitHub CLI had but did not use: it is GitHub CLI's, never signed out here, even with the tick (security review F1)", async () => {
  const made = await signedIn({ personGh: { login: OWN, token: stub.others[OWN], accounts: { [OWN]: stub.others[OWN], [stub.login]: stub.token } } });
  assert.deepEqual(made.done, { login: stub.login, origin: "existing", previous: null, renewed: true, kept: OWN }, "GitHub CLI goes on using OWN");
  assert.deepEqual([(await made.flow.status()).origin, (await made.flow.status()).previous], ["existing", null]);
  const out = await made.flow.signOut({ signOutCli: true, switchBack: true });
  assert.deepEqual([out.cliSignedOut, out.switchedBack, out.cliAccount], [false, false, OWN]);
  assert.equal(made.runs().some((run) => run.args[1] === "logout"), false);
  assert.match(made.hosts(), new RegExp(`^ {8}${stub.login}:$`, "m"), "the person's account is still in GitHub CLI");
  assert.match(made.hosts(), new RegExp(`^ {8}${OWN}:$`, "m"));
});

test("several accounts in GitHub CLI: each is listed, any can be chosen, and the calls go as it with its own token while GitHub CLI's active account stays as it is", async () => {
  const made = flowFor({ personGh: { login: OWN, token: stub.others[OWN], accounts: { [OWN]: stub.others[OWN], [stub.login]: stub.token } } });
  const before = made.hosts();
  const status = await made.flow.status();
  assert.deepEqual(status.accounts, [{ login: OWN, active: true }, { login: stub.login, active: false }]);
  assert.equal(status.existing, OWN);
  assert.deepEqual(made.runs().map((run) => run.args.join(" ")), ["config get --host github.com user"], "listed from GitHub CLI's configuration: no secret, no network");
  await assert.rejects(made.flow.useExisting({ login: "nobody-here" }), { code: "no_existing" });
  await assert.rejects(made.flow.useExisting({ login: "--user" }), { code: "usage" });
  assert.deepEqual(await made.flow.useExisting({ login: stub.login }), { login: stub.login, origin: "existing" });
  assert.deepEqual(made.runs().filter((run) => run.args[0] === "auth").map((run) => run.args.join(" ")), [`auth token --hostname github.com --user ${stub.login}`]);
  const p = project("clock-chosen");
  const pushed = await made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-chosen" });
  assert.equal(pushed.owner, stub.login);
  assert.equal(stub.repoOf(`${OWN}/clock-chosen`), null, "nothing for the active account");
  assert.equal(made.hosts(), before, "GitHub CLI's configuration is as it was: no switch");
  assert.equal(made.runs().some((run) => run.args[1] === "switch" || run.args[1] === "login" || run.args[1] === "logout"), false);
  // The token is asked once for the push's many calls, and kept in memory only.
  assert.ok(made.runs().filter((run) => run.args[1] === "token").length <= 2);
  assert.equal(readFileSync(path.join(made.dataDir, "github", "signed-in.json"), "utf8").includes(stub.token), false);
});

test("Sign in with another account, and the person picks GitHub CLI's own account on GitHub: its sign-in renewed, and it stays GitHub CLI's", async () => {
  const made = await signedIn({ personGh: { login: stub.login, token: stub.token } });
  assert.deepEqual(made.done, { login: stub.login, origin: "existing", previous: null, renewed: true, kept: null });
  await made.flow.signOut({ signOutCli: true });
  assert.equal(made.runs().some((run) => run.args[1] === "logout"), false);
  assert.equal(made.store()["gh:github.com|octo-person"], stub.token);
});

test("a system store that refuses: gh keeps the token in plain text, so the app signs that account out of GitHub CLI again and says so; GitHub CLI's own account stays", async () => {
  const made = flowFor({ env: { BUSY_EMULATOR_FAKE_GH_INSECURE: "1" }, personGh: { login: OWN, token: stub.others[OWN] } });
  stub.device.answers.push(CODE, { body: { access_token: stub.token, token_type: "bearer", scope: "repo" } });
  await made.flow.signIn();
  await assert.rejects(made.flow.waitSignIn(), { code: "keyring_refused" });
  assert.deepEqual(made.runs().at(-1).args, ["auth", "logout", "--hostname", "github.com", "--user", stub.login]);
  assert.doesNotMatch(made.hosts(), /oauth_token/, "no token is left in a file");
  assert.match(made.hosts(), new RegExp(`^ {4}user: ${OWN}$`, "m"));
  assert.equal((await made.flow.status()).signedIn, false);
});

test("the sign-in refused or expired on GitHub, and stopped here: each its own words, and gh ended", async () => {
  let made = flowFor();
  stub.device.answers.push(CODE, { body: { error: "access_denied", error_description: "The authorization request was denied." } });
  await made.flow.signIn();
  await assert.rejects(made.flow.waitSignIn(), { code: "denied", message: "The sign-in was canceled on GitHub." });
  made = flowFor();
  stub.device.answers.push(CODE, { body: { error: "expired_token" } });
  await made.flow.signIn();
  await assert.rejects(made.flow.waitSignIn(), { code: "expired" });
  made = flowFor();
  stub.device.answers.push(CODE, ...Array.from({ length: 2000 }, () => ({ body: { error: "authorization_pending" } })));
  await made.flow.signIn();
  made.flow.cancelSignIn();
  await assert.rejects(made.flow.waitSignIn(), { code: "canceled" });
  stub.device.answers.length = 0;
  assert.equal((await made.flow.status()).signing, null);
});

test("an account noted here that GitHub CLI no longer has: the app asks again rather than publish as another, and leaves GitHub CLI as it is", async () => {
  const { dataDir, store, hosts } = await signedIn();
  const note = path.join(dataDir, "github", "signed-in.json");
  writeFileSync(note, JSON.stringify({ login: "someone-else", origin: "app", host: "github.com" }));
  const before = hosts();
  const { flow } = flowFor({ dataDir });
  const p = project("other-account");
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "other-account" }), { code: "account_gone", message: "GitHub CLI on this computer has no sign-in for someone-else any more." });
  assert.equal(JSON.parse(readFileSync(note, "utf8")).stale, true, "kept, stale (F5)");
  assert.equal((await flow.status()).signedIn, false);
  assert.equal(store()["gh:github.com|octo-person"], stub.token);
  assert.equal(hosts(), before);
});

test("a first upload that fails leaves a repository the app knows as its own: publishing again goes into it, not into name-2 (audit C2)", async () => {
  const { flow } = await signedIn();
  const p = project("clock-c2");
  stub.hooks.fail = (req) => (req.method === "POST" && req.url.endsWith("/git/blobs") ? { status: 502, body: { message: "Server Error" } } : null);
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-c2" }), { code: "server" });
  stub.hooks.fail = null;
  assert.ok(stub.repoOf(`${stub.login}/clock-c2`), "GitHub has the new, empty repository");
  const planned = await flow.plan({ folder: p.dir, status: p.status, name: "clock-c2" });
  assert.deepEqual([planned.mode, planned.suggestion], ["replace", null]);
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-c2" });
  assert.deepEqual([pushed.name, pushed.mode], ["clock-c2", "replace"]);
  assert.equal(stub.repoOf(`${stub.login}/clock-c2-2`), null);
  assert.ok(stub.filesOf(`${stub.login}/clock-c2`, "main")["src/main.ts"]);

  // GitHub makes the repository but its answer is lost (a 502 after the work): the repository there now is taken as
  // the one this request made, and the upload goes on.
  const q = project("clock-c2-lost");
  stub.hooks.fail = (req) => {
    if (req.method !== "POST" || req.url !== "/api/user/repos") return null;
    stub.hooks.fail = null;
    stub.makeRepo(stub.login, "clock-c2-lost");
    return { status: 502, body: { message: "Server Error" } };
  };
  const lost = await flow.push({ folder: q.dir, status: q.status, files: q.plan, name: "clock-c2-lost" });
  assert.equal(lost.name, "clock-c2-lost");
  assert.ok(stub.filesOf(`${stub.login}/clock-c2-lost`, "main")["src/main.ts"]);
});

test("Cancel of an upload: it stops before the branch is moved, the repository's files are as they were, and publishing again works", async () => {
  const { flow } = await signedIn();
  const p = project("clock-cancel");
  const first = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-cancel" });
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(canceled);\n");
  assert.equal(flow.cancel(), false, "nothing to stop");
  // The person presses Cancel while the first file goes up.
  stub.hooks.fail = (req) => {
    if (req.method === "POST" && req.url.endsWith("/git/blobs")) {
      stub.hooks.fail = null;
      assert.equal(flow.cancel(), true);
    }
    return null;
  };
  const facts = [];
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-cancel", upload: (fact) => facts.push(fact) }), { code: "upload_canceled", message: "The upload was stopped. The repository's files are as they were." });
  stub.hooks.fail = null;
  assert.equal(stub.headOf(`${stub.login}/clock-cancel`, "main"), first.commit, "the branch was not moved");
  assert.equal(facts.some((one) => one.phase === "commit"), false);
  const again = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-cancel" });
  assert.notEqual(again.commit, first.commit);
  assert.equal(stub.filesOf(`${stub.login}/clock-cancel`, "main")["src/main.ts"], "draw(canceled);\n");
});

test("two sign-ins at once are one: one gh auth login, the same code to both; Cancel ends it, also while it is starting (audit H4)", async () => {
  const made = flowFor();
  stub.device.answers.push(CODE, ...Array.from({ length: 2000 }, () => ({ body: { error: "authorization_pending" } })));
  const [a, b] = await Promise.all([made.flow.signIn(), made.flow.signIn()]);
  assert.equal(a.userCode, b.userCode);
  assert.equal(made.runs().filter((run) => run.args[1] === "login").length, 1);
  made.flow.cancelSignIn();
  await assert.rejects(made.flow.waitSignIn(), { code: "canceled" });
  assert.equal((await made.flow.status()).signing, null);
  stub.device.answers.length = 0;
  // Canceled before gh showed a code: nothing goes on.
  const early = flowFor();
  stub.device.answers.push(CODE, ...Array.from({ length: 2000 }, () => ({ body: { error: "authorization_pending" } })));
  const starting = early.flow.signIn();
  early.flow.cancelSignIn();
  await assert.rejects(starting, { code: "canceled" });
  assert.equal((await early.flow.status()).signing, null);
  stub.device.answers.length = 0;
});

test("a symbolic link in the files is left out and named, in the progress and in the answer (audit H10)", { skip: process.platform === "win32" && "symbolic links" }, async () => {
  const { flow } = await signedIn();
  const p = project("clock-links");
  symlinkSync("main.ts", path.join(p.dir, "src", "alias.ts"));
  p.plan.published.push({ path: "src/alias.ts" });
  const lines = [];
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-links", progress: (line) => lines.push(line) });
  assert.deepEqual(pushed.skipped, ["src/alias.ts"]);
  assert.ok(lines.includes("Leaving out a link, which GitHub would not get as files: src/alias.ts"), lines.join("\n"));
  assert.equal(stub.filesOf(`${stub.login}/clock-links`, "main")["src/alias.ts"], undefined);
});

test("GitHub CLI switched to another account in the terminal: the next push still goes as the account chosen here, and nothing goes to the other one (security review F2)", async () => {
  const made = flowFor({ personGh: { login: stub.login, token: stub.token, accounts: { [stub.login]: stub.token, [OWN]: stub.others[OWN] } } });
  await made.flow.useExisting();
  const p = project("clock-f2");
  await made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-f2" });
  assert.equal((await made.personRuns(["auth", "switch", "--hostname", "github.com", "--user", OWN])).code, 0);
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(f2);\n");
  const again = await made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-f2" });
  assert.equal(again.owner, stub.login);
  assert.equal(stub.filesOf(`${stub.login}/clock-f2`, "main")["src/main.ts"], "draw(f2);\n");
  assert.equal(stub.repoOf(`${OWN}/clock-f2`), null);
  assert.equal((await made.flow.status()).login, stub.login);
  // Signed out of GitHub CLI in the terminal: no sign-in for it any more, and nothing is published as another.
  assert.equal((await made.personRuns(["auth", "logout", "--hostname", "github.com", "--user", stub.login])).code, 0);
  const gone = flowFor({ dataDir: made.dataDir });
  writeFileSync(path.join(p.dir, "src", "main.ts"), "draw(f2, gone);\n");
  await assert.rejects(gone.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-f2" }), { code: "account_gone" });
});

test("a stale note, signed in again after GitHub CLI moved to another account: GitHub CLI goes on with that one", async () => {
  const made = flowFor({ personGh: { login: stub.login, token: stub.token, accounts: { [stub.login]: stub.token, [OWN]: stub.others[OWN] } } });
  assert.deepEqual(await made.flow.useExisting(), { login: stub.login, origin: "existing" });
  stub.hooks.fail = (req) => (req.url === "/api/user" ? { status: 401, body: { message: "Bad credentials" } } : null);
  const p = project("clock-stale-previous");
  await assert.rejects(made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-stale-previous" }), { code: "unauthorized" });
  stub.hooks.fail = null;
  assert.equal((await made.flow.status()).signedIn, false);
  // The person moves GitHub CLI to OWN in a terminal, then signs in here again as the same account.
  assert.equal((await made.personRuns(["auth", "switch", "--hostname", "github.com", "--user", OWN])).code, 0);
  stub.device.answers.push(CODE, { body: { access_token: stub.token, token_type: "bearer", scope: "repo" } });
  await made.flow.signIn();
  assert.deepEqual(await made.flow.waitSignIn(), { login: stub.login, origin: "existing", previous: null, renewed: true, kept: OWN });
  assert.match(made.hosts(), new RegExp(`^ {4}user: ${OWN}$`, "m"));
});

test("GitHub refusing the sign-in (401) leaves the note stale, not gone: signing out still knows the account was the app's and which one GitHub CLI had (security review F5)", async () => {
  const made = await signedIn({ personGh: { login: OWN, token: stub.others[OWN] } });
  const noteFile = path.join(made.dataDir, "github", "signed-in.json");
  stub.hooks.fail = (req) => (req.url === "/api/user" ? { status: 401, body: { message: "Bad credentials" } } : null);
  const p = project("clock-f5");
  await assert.rejects(made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-f5" }), { code: "unauthorized" });
  stub.hooks.fail = null;
  const kept = JSON.parse(readFileSync(noteFile, "utf8"));
  assert.deepEqual([kept.login, kept.origin, kept.previous, kept.stale], [stub.login, "app", null, true]);
  assert.equal((await made.flow.status()).signedIn, false);
  // Signed in again as the same account: still the app's, with the account GitHub CLI had before.
  stub.device.answers.push(CODE, { body: { access_token: stub.token, token_type: "bearer", scope: "repo" } });
  await made.flow.signIn();
  assert.deepEqual(await made.flow.waitSignIn(), { login: stub.login, origin: "app", previous: null, renewed: false, kept: OWN });
  // And a stale note still signs the app's account out of GitHub CLI as the person ticks.
  stub.hooks.fail = (req) => (req.url === "/api/user" ? { status: 401, body: { message: "Bad credentials" } } : null);
  await assert.rejects(made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-f5" }), { code: "unauthorized" });
  stub.hooks.fail = null;
  const out = await made.flow.signOut({ signOutCli: true });
  assert.deepEqual([out.cliSignedOut, out.cliAccount], [true, OWN]);
  assert.equal(made.store()["gh:github.com|octo-person"], undefined);
  assert.equal(existsSync(noteFile), false);
});

test("the catalog as written, and the template filled", () => {
  assert.deepEqual(parseCatalog("some-owner/busy-apps-catalog-demo"), { owner: "some-owner", name: "busy-apps-catalog-demo" });
  assert.deepEqual(parseCatalog("https://github.com/some-owner/busy-apps-catalog-demo.git"), { owner: "some-owner", name: "busy-apps-catalog-demo" });
  assert.deepEqual(parseCatalog("github.com/busy-app/busy-apps-catalog/"), { owner: "busy-app", name: "busy-apps-catalog" });
  for (const bad of ["", "busy-app", "https://gitlab.com/a/b", "a/b/c", "a/.."]) assert.equal(parseCatalog(bad), null, bad);
  const body = fillTemplate(TEMPLATE, { ai: "none", ticked: ["I'm the author of the app or have write access to its repository"] });
  assert.match(body, /^- \[x\] I'm the author/m);
  assert.match(body, /^- \[ \] The app builds/m, "only what was ticked");
  assert.match(body, /^- No AI was used\.$/m);
  assert.doesNotMatch(body, /Partly|Fully/);
});

test("the catalog's checklist: every box of the template as it is written, the AI usage as one choice, the instruction done; the whole of it ticked into the request", () => {
  const list = parseChecklist(BUNDLED_TEMPLATE);
  assert.deepEqual(list.boxes, [
    "I've read the [terms for authors](https://github.com/busy-app/busy-apps-catalog/blob/main/TERMS.md) and my app follows them",
    "I'm the author of the app or have write access to its repository",
    "The app builds with `busy-cli build`, and the lock file is committed",
    "The manifest follows the catalog manifest format",
    "I've tested the app on a BUSY Bar with the latest release firmware",
    "The screenshots are taken from the bar",
  ]);
  assert.deepEqual(list.blocks.map((one) => one.kind), ["heading", "box", "box", "box", "box", "box", "box", "heading", "instruction", "ai"]);
  assert.deepEqual(list.ai, [
    { id: "none", text: "No AI was used." },
    { id: "partly", text: "Partly AI-assisted: which parts, and what they do." },
    { id: "full", text: "Fully AI-generated: what the generated code does." },
  ]);
  const body = fillTemplate(BUNDLED_TEMPLATE, { ai: "full", ticked: list.boxes, testing: "Tested in BUSY Bar Emulator." });
  assert.equal((body.match(/^- \[x\] /gm) ?? []).length, 6);
  assert.doesNotMatch(body, /- \[ \]|Keep ONE option|No AI was used|Partly AI-assisted/);
  assert.match(body, /^- Fully AI-generated: what the generated code does\.$/m);
  assert.match(body, /\(https:\/\/github\.com\/busy-app\/busy-apps-catalog\/blob\/main\/TERMS\.md\)/, "the links stay");
  assert.match(body, /# Device testing\n\nTested in BUSY Bar Emulator\.\n$/);
  // A template of another form: CRLF, "* [ ]" items, an HTML comment, no AI lines (then the choice is added).
  const other = parseChecklist("<!-- for authors -->\r\n## Checklist\r\n* [ ] One\r\n* [x] Two\r\nSome words.\r\n");
  assert.deepEqual([other.boxes, other.ai, other.blocks.map((one) => one.kind)], [["One", "Two"], [], ["heading", "box", "box", "text"]]);
  assert.equal(fillTemplate("## Checklist\n* [ ] One\n", { ai: "none", ticked: ["One"] }), "## Checklist\n* [x] One\n\n# AI usage\n\n- No AI was used.\n");
});

// ---------------------------------------------------------------- the catalog and the account of a request (EMU-291)

test("a catalog that is not BUSY's: the checklist says so, and a request goes there only when the person confirmed its name (security review L3)", async () => {
  const { flow } = await signedIn({ catalogs: BUSY_CATALOGS });
  const p = project("clock-other-catalog");
  const manifest = noted(p, await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-other-catalog" }));
  stub.makeRepo("attacker", "catalog");
  stub.commitFiles("attacker/catalog", "main", { "README.md": "# Catalog\n", ".github/PULL_REQUEST_TEMPLATE.md": TEMPLATE });
  const list = await flow.checklist({ catalog: "attacker/catalog" });
  assert.deepEqual([list.catalog, list.busy, list.source], ["attacker/catalog", false, "catalog"]);
  for (const busy of ["busy-app/busy-apps-catalog", "https://github.com/Busy-App/busy-apps-catalog-dev"]) assert.equal((await flow.checklist({ catalog: busy })).busy, true, busy);
  const writes = () => stub.requests.filter((r) => r.method !== "GET").length;
  const before = writes();
  const ask = (more) => flow.request({ status: p.status, files: p.plan, folder: p.dir, ticked: list.boxes, ai: "none", manifest, ...more });
  // The project's catalog.json names it, or the command does: refused, with what to do.
  await assert.rejects(ask({ status: { ...p.status, catalog: "attacker/catalog" } }), { code: "other_catalog", message: /^attacker\/catalog is not BUSY's catalog \(busy-app\/busy-apps-catalog\)/, hint: /confirm attacker\/catalog when the emulator asks/ });
  await assert.rejects(ask({ catalog: "https://github.com/attacker/catalog" }), { code: "other_catalog" });
  await assert.rejects(ask({ catalog: "attacker/catalog", otherCatalog: "attacker/other-catalog" }), { code: "other_catalog" }, "a confirmation of another name is none");
  assert.equal(writes(), before, "nothing was written: no fork, no branch, no request");
  // Confirmed by its name: sent there.
  const made = await ask({ catalog: "attacker/catalog", otherCatalog: "Attacker/Catalog" });
  assert.equal(made.catalog, "attacker/catalog");
  assert.ok(stub.requests.some((r) => r.method === "POST" && r.path === "/api/repos/attacker/catalog/forks"));
});

test("the questions of publish pr: BUSY's catalog is one question; another is named in it, said first, and asked about again by its name (security review L3)", () => {
  const target = { owner: "octo", name: "clock", commit: "c".repeat(40) };
  const list = { source: "catalog", boxes: ["I've read the [terms](https://github.com/busy-app/busy-apps-catalog/blob/main/TERMS.md)", "It builds with `busy-cli build`"] };
  const busy = requestQuestions({ folder: "/p/clock", catalog: { owner: "busy-app", name: "busy-apps-catalog" }, target, ai: "partly", list });
  assert.equal(busy.length, 1);
  assert.equal(busy[0].message, "Send this app to the catalog?");
  assert.match(busy[0].detail, /^\/p\/clock\n\nA program on this computer .* to the catalog busy-app\/busy-apps-catalog from your GitHub account, naming github\.com\/octo\/clock at cccccccccccc\. AI usage: partly AI-assisted\./);
  assert.match(busy[0].detail, /\n\[ \] I've read the terms \(https:\/\/github\.com\/busy-app\/busy-apps-catalog\/blob\/main\/TERMS\.md\)\n\[ \] It builds with busy-cli build$/);
  assert.equal(busy[0].checkboxLabel, "Every item of the checklist above is true");
  const other = requestQuestions({ folder: "/p/clock", catalog: { owner: "attacker", name: "catalog" }, target, ai: "none", list });
  assert.equal(other.length, 2);
  assert.equal(other[0].message, "Send this app to attacker/catalog, which is not BUSY's catalog?");
  assert.match(other[0].detail, /^attacker\/catalog is not BUSY's catalog \(busy-app\/busy-apps-catalog\)\. The project's catalog\.json or the command names it; whoever keeps attacker\/catalog gets the request, from your GitHub account\.\n\n\/p\/clock/);
  assert.deepEqual([other[1].message, other[1].buttons, other[1].yes], ["Send the request to attacker/catalog?", ["Cancel", "Send to attacker/catalog"], 1]);
  assert.match(other[1].detail, /^attacker\/catalog is not BUSY's catalog\. Apps for BUSY Bar go to busy-app\/busy-apps-catalog\./);
  assert.equal(requestQuestions({ folder: "/p", catalog: { owner: "busy-app", name: "busy-apps-catalog-dev" }, target, ai: "none", list }).length, 1, "the dev catalog is BUSY's");
});

test("a catalog's checklist of more than 50 items, or with an item past 500 characters, is not shown and nothing is sent, and the message says why (security review L9)", async () => {
  const { flow } = await signedIn();
  const p = project("clock-long-checklist");
  const manifest = noted(p, await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-long-checklist" }));
  assert.deepEqual([MAX_BOXES, MAX_BOX_LENGTH], [50, 500]);
  const many = `# Author checklist\n\n${Array.from({ length: 51 }, (_, i) => `- [ ] Item ${i + 1}`).join("\n")}\n`;
  const long = `# Author checklist\n\n- [ ] ${"I agree. ".repeat(60).trim()}\n`;
  const fine = `# Author checklist\n\n${Array.from({ length: 50 }, (_, i) => `- [ ] Item ${i + 1}`).join("\n")}\n`;
  for (const [owner, template] of [["many-boxes", many], ["long-box", long], ["fifty-boxes", fine]]) {
    stub.makeRepo(owner, "catalog");
    stub.commitFiles(`${owner}/catalog`, "main", { "README.md": "# Catalog\n", ".github/PULL_REQUEST_TEMPLATE.md": template });
  }
  const writes = () => stub.requests.filter((r) => r.method !== "GET").length;
  const before = writes();
  await assert.rejects(flow.checklist({ catalog: "many-boxes/catalog" }), { code: "checklist_too_long", message: "The checklist of many-boxes/catalog has 51 items, more than the 50 the emulator shows, so nothing is sent there.", hint: /send the app by hand \(SUBMIT\.md\)/ });
  await assert.rejects(flow.checklist({ catalog: "long-box/catalog" }), { code: "checklist_too_long", message: /^An item of the checklist of long-box\/catalog is 539 characters long, more than the 500 the emulator shows/ });
  const boxes = Array.from({ length: 51 }, (_, i) => `Item ${i + 1}`);
  await assert.rejects(flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "many-boxes/catalog", otherCatalog: "many-boxes/catalog", ticked: boxes, ai: "none", manifest }), { code: "checklist_too_long" }, "the request reads the template again and refuses it too");
  assert.equal(writes(), before, "nothing was written");
  assert.equal((await flow.checklist({ catalog: "fifty-boxes/catalog" })).boxes.length, 50, "50 are shown");
});

test("another account chosen while a push or a request is under way: the rest of it goes as the account it started with (security review L4)", async () => {
  const made = flowFor({ personGh: { login: stub.login, token: stub.token, accounts: { [stub.login]: stub.token, [OWN]: stub.others[OWN] } }, catalogs: [...standInCatalogs(), "l4-owner/catalog"] });
  await made.flow.useExisting({ login: stub.login });
  const p = project("clock-l4");
  /** Holds the first request that `matches` until the person chose OWN here (publish signin --use-existing --user). */
  const switchDuring = (matches) => {
    let switched = null;
    stub.hooks.hold = async (req, url) => {
      if (switched || !matches(req, url)) return;
      switched = made.flow.useExisting({ login: OWN });
      await switched;
    };
    return () => switched;
  };
  const writtenBy = (from) => stub.requests.slice(from).filter((r) => r.method !== "GET").map((r) => String(r.headers.authorization ?? "").replace(/^(token|Bearer) /, ""));
  try {
    let from = stub.requests.length;
    let took = switchDuring((req, url) => req.method === "POST" && url.pathname === "/api/user/repos");
    const pushed = await made.flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-l4" });
    assert.ok(took(), "the account was switched while the push went on");
    assert.equal((await made.flow.status()).login, OWN, "the switch took: the next push goes as OWN");
    assert.equal(pushed.owner, stub.login);
    assert.equal(stub.filesOf(`${stub.login}/clock-l4`, "main")["src/main.ts"], "draw();\n");
    assert.ok(writtenBy(from).length > 2 && writtenBy(from).every((token) => token === stub.token), "every write of the push went as the account it started with");
    // The request: started as stub.login, OWN chosen while the catalog is forked.
    await made.flow.useExisting({ login: stub.login });
    const manifest = noted(p, pushed);
    stub.makeRepo("l4-owner", "catalog");
    stub.commitFiles("l4-owner/catalog", "main", { "README.md": "# Catalog\n", ".github/PULL_REQUEST_TEMPLATE.md": TEMPLATE });
    from = stub.requests.length;
    took = switchDuring((req, url) => req.method === "POST" && url.pathname === "/api/repos/l4-owner/catalog/forks");
    const sent = await made.flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "l4-owner/catalog", ticked: ALL_TICKED, ai: "none", manifest });
    assert.ok(took(), "the account was switched while the request went on");
    assert.equal(sent.branch, `${stub.login}/${ID}_1.0.0`);
    assert.equal(stub.pulls.at(-1).head, `${stub.login}:${stub.login}/${ID}_1.0.0`);
    assert.ok(writtenBy(from).every((token) => token === stub.token), "every write of the request went as the account it started with");
  } finally {
    stub.hooks.hold = null;
  }
});

test("stale-check: the bytes a push reads are compared, file by file, with the ones Pre-flight check saw", async () => {
  const { createHash } = await import("node:crypto");
  const entry = (text) => `${Buffer.byteLength(text)}:${createHash("sha256").update(text).digest("hex")}`;
  const checked = { "src/main.ts": entry('import { a } from "./a";\n'), "README.md": entry("# Clock\n") };
  const read = (main) => [{ path: "src/main.ts", bytes: Buffer.from(main) }, { path: "README.md", bytes: Buffer.from("# Clock\n") }];
  assert.equal(changedSinceCheck(read('import { a } from "./a";\n'), checked), null, "as checked");
  assert.equal(changedSinceCheck(read('mport { a } from "./a";\n'), checked), "src/main.ts", "one letter less");
  assert.equal(changedSinceCheck([...read('import { a } from "./a";\n'), { path: "src/new.ts", bytes: Buffer.from("") }], checked), "src/new.ts", "a file the check did not see");
  assert.equal(changedSinceCheck(read("x"), null), null, "no list to compare: the fingerprint's own comparison stands");
});

test("an optional item of the checklist: shown without its prefix, not required, its state kept in the request, and said so in publish pr's question", () => {
  const template = BUNDLED_TEMPLATE.replace("# AI usage", "- [ ] (Optional) Takes part in a contest, and I accept its [rules](https://example.com/rules)\n\n# AI usage");
  const list = parseChecklist(template);
  assert.equal(list.boxes.length, 7);
  assert.equal(list.required.length, 6);
  assert.equal(list.required.some(isOptionalBox), false);
  const optional = list.blocks.filter((one) => one.kind === "box").at(-1);
  assert.deepEqual([optional.optional, optional.label], [true, "Takes part in a contest, and I accept its [rules](https://example.com/rules)"]);
  assert.equal(list.blocks.filter((one) => one.kind === "box" && one.optional).length, 1);
  // Unticked stays unticked; ticked stays ticked.
  const without = fillTemplate(template, { ai: "none", ticked: list.required });
  assert.match(without, /^- \[ \] \(Optional\) Takes part/m);
  assert.equal((without.match(/^- \[x\] /gm) ?? []).length, 6);
  const withIt = fillTemplate(template, { ai: "none", ticked: list.boxes });
  assert.match(withIt, /^- \[x\] \(Optional\) Takes part/m);
  const target = { owner: "octo", name: "clock", commit: "c".repeat(40) };
  const [first] = requestQuestions({ folder: "/p/clock", catalog: { owner: "busy-app", name: "busy-apps-catalog" }, target, ai: "none", list });
  assert.match(first.detail, /\n\[ \] Optional, left unticked: Takes part in a contest, and I accept its rules \(https:\/\/example\.com\/rules\)(\n|$)/);
  assert.match(first.checkboxLabel, /but the optional ones$/);
});
