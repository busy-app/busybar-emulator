// Sign commits with (EMU-366): every commit the app makes on the stand-in for GitHub (test/fixtures/github-stub.mjs,
// through the stand-in for GitHub CLI) names its author and committer. GitHub's private address of the account by
// default; one GitHub has verified for it, or git config's, when the person chose it; the choice kept for the account
// in the app's data folder, never in the project; GitHub's GH007 refusal said in words that offer the private address.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { ghEnvironment, ghFolders, ghRunner } from "../../src/github/gh.mjs";
import { localUser, userOf } from "../../src/github/local-git.mjs";
import { BUSY_CATALOGS, createGithubPublish, GRANT_EMAILS, parseChecklist, requestQuestions, signerSentence } from "../../src/github/publish-flow.mjs";
import { createPublishRecord } from "../../src/github/publish-record.mjs";
import { FAKE_GH, fakeSignedIn } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";

let stub;
let root;
before(async () => {
  stub = await startGithubStub({ port: 0 });
  root = mkdtempSync(path.join(os.tmpdir(), "busy-commit-email-"));
});
after(async () => {
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});
const ACCOUNT = { id: 4242001, name: "Octo Person", email: null, emails: [{ email: "octo.person@example.com", primary: true, verified: true, visibility: "private" }, { email: "octo.old@example.org", primary: false, verified: false, visibility: null }, { email: "octo.work@example.net", primary: false, verified: true, visibility: null }], emailScope: true };
/** The stand-in's person (github-stub.mjs). */
const LOGIN = "octo-person";
const NOREPLY = `${ACCOUNT.id}+${LOGIN}@users.noreply.github.com`;
beforeEach(() => {
  Object.assign(stub.account, structuredClone(ACCOUNT));
  stub.hooks.fail = null;
});

const ID = "io.github.octo.clock";
const TICKED = ["I'm the author of the app or have write access to its repository"];
const TEMPLATE = `# Author checklist\n\n- [ ] ${TICKED[0]}\n\n# AI usage\n\n- No AI was used.\n- Partly AI-assisted: which parts, and what they do.\n- Fully AI-generated: what the generated code does.\n`;

/** A project folder, with a git config of its own when `git` is given, and what publish status and files would say. */
function project(name, { git = null } = {}) {
  const dir = path.join(root, name);
  const files = { "catalog.json": "{}\n", LICENSE: "MIT\n", "package.json": "{}\n", "src/main.ts": "draw();\n" };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  if (git) {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "config"), git);
  }
  const status = { folder: dir, id: ID, name: "Clock", version: "1.0.0", license: { ready: true }, texts: { texts: { short_description: "A clock for the bar" } }, github: { repo: null, request: null }, catalog: "busy-app/busy-apps-catalog" };
  return { dir, status, plan: { published: Object.keys(files).map((rel) => ({ path: rel })), findings: [] } };
}

/** The flow with its own data folder and the person's own git settings (`gitconfig`, ~/.gitconfig), signed in as the stand-in's person. */
async function signedIn({ gitconfig = null, dataDir = mkdtempSync(path.join(root, "data-")) } = {}) {
  const folders = ghFolders(dataDir);
  for (const folder of Object.values(folders)) mkdirSync(folder, { recursive: true });
  const person = path.join(dataDir, "person");
  fakeSignedIn(person, { login: stub.login, token: stub.token, standIn: stub.base });
  if (gitconfig) writeFileSync(path.join(person, ".gitconfig"), gitconfig);
  const env = ghEnvironment({ ...process.env, BUSY_EMULATOR_FAKE_GH_STAND_IN: stub.base, BUSY_EMULATOR_FAKE_GH_POLL_MS: "5" }, dataDir, path.join(person, "gh"));
  const lines = [];
  // The flow's clock: what GitHub said of the account is kept a minute, and asked again at most every five seconds.
  const clock = { now: Date.now() };
  const flow = createGithubPublish({ gh: { run: ghRunner({ command: process.execPath, prefix: [FAKE_GH], env, cwd: folders.root }) }, dataDir, configDir: path.join(person, "gh"), record: createPublishRecord(dataDir), openExternal: () => {}, log: (line) => lines.push(line), sleep: async () => {}, writeGapMs: 0, catalogs: [...BUSY_CATALOGS, "sign-owner/sign-catalog"], git: { home: person, xdg: null }, clock: () => clock.now });
  await flow.useExisting({ login: stub.login });
  return { flow, dataDir, lines, later: (ms) => (clock.now += ms) };
}

/** The author and committer the request for a commit named, and what the commit holds. */
const signedBy = (sha) => {
  const one = stub.commitOf(sha);
  return { sent: one.sent, author: one.author, committer: one.committer };
};
const as = (name, email) => ({ sent: { author: { name, email }, committer: { name, email } }, author: { name, email }, committer: { name, email } });

/** Every file under a folder, as text: what the project would publish, its .busy/ included. */
function textsUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...textsUnder(full));
    else out.push(readFileSync(full, "utf8"));
  }
  return out;
}

test("by default every commit is signed with GitHub's private address of the account and its name: the person's repository's and the catalog fork's", async () => {
  const { flow } = await signedIn();
  const p = project("clock-default");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-default" });
  assert.deepEqual(signedBy(pushed.commit), as("Octo Person", NOREPLY), "the request names the author and the committer, GitHub does not choose");
  assert.deepEqual(pushed.signer, { name: "Octo Person", email: NOREPLY, kind: "noreply" });
  stub.makeRepo("sign-owner", "sign-catalog");
  stub.commitFiles("sign-owner/sign-catalog", "main", { "README.md": "# Catalog\n", ".github/PULL_REQUEST_TEMPLATE.md": TEMPLATE });
  p.status.github.repo = { owner: pushed.owner, name: pushed.name, page: pushed.page, commit: pushed.commit };
  const manifest = `sourcecode:\n  type: git\n  location:\n    origin: x\n    commit_sha: y\ncategory: clocks\n`;
  const made = await flow.request({ status: p.status, files: p.plan, folder: p.dir, catalog: "sign-owner/sign-catalog", ticked: TICKED, ai: "none", manifest });
  assert.deepEqual(signedBy(stub.headOf(`${stub.login}/sign-catalog`, made.branch)), as("Octo Person", NOREPLY), "the manifest's commit in the fork too");
  assert.deepEqual(made.signer, pushed.signer);
});

test("Sign commits with: the private address first, the verified ones (not the unverified), then git config's with its name; the choice is the account's, by its number, kept in the app's data folder, never in the project or the log", async () => {
  const { flow, dataDir, lines } = await signedIn({ gitconfig: "[user]\n\tname = Octo From Git\n\temail = octo.home@example.org\n" });
  const p = project("clock-chosen", { git: '[core]\n\tbare = false\n[user]\n\tname = Octo Of Project\n\temail = "octo.project@example.net" ; the project\'s own\n' });
  const choices = () => JSON.parse(readFileSync(path.join(dataDir, "github", "commit-email.json"), "utf8"));
  const offered = await flow.signers({ folder: p.dir });
  assert.deepEqual(offered.offered, [
    { email: NOREPLY, kind: "noreply" },
    { email: "octo.person@example.com", kind: "verified", primary: true, private: true },
    { email: "octo.work@example.net", kind: "verified" },
    { email: "octo.project@example.net", kind: "git", name: "Octo Of Project" },
  ]);
  // The account's name, never git config's unless its address is chosen with it.
  assert.deepEqual([offered.signer, offered.scope, offered.grant], [{ name: "Octo Person", email: NOREPLY, kind: "noreply" }, true, GRANT_EMAILS]);
  // An unverified address, or one that is none of these, is refused, and nothing is noted.
  for (const wrong of ["octo.old@example.org", "someone.else@example.com"]) await assert.rejects(flow.chooseSigner({ email: wrong, folder: p.dir }), { code: "email_not_offered" });
  await assert.rejects(flow.chooseSigner({ email: "not an address" }), { code: "usage" });

  assert.deepEqual((await flow.chooseSigner({ email: "octo.work@example.net", folder: p.dir })).signer, { name: "Octo Person", email: "octo.work@example.net", kind: "verified" });
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-chosen" });
  assert.deepEqual(signedBy(pushed.commit), as("Octo Person", "octo.work@example.net"));
  // Kept for the account by its number, in the app's own folder; another project of the same account signs with it too.
  assert.deepEqual(choices(), { [`id:${ACCOUNT.id}`]: { login: LOGIN, email: "octo.work@example.net", kind: "verified" } });
  const other = project("clock-other");
  assert.equal((await flow.signers({ folder: other.dir })).signer.email, "octo.work@example.net");
  // git config's address, which GitHub has not verified: taken with git config's name, said so.
  assert.deepEqual((await flow.chooseSigner({ email: "octo.project@example.net", folder: p.dir })).signer, { name: "Octo Of Project", email: "octo.project@example.net", kind: "git" });
  p.plan.published.push({ path: "src/more.ts" });
  writeFileSync(path.join(p.dir, "src", "more.ts"), "more();\n");
  const again = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-chosen" });
  assert.deepEqual(signedBy(again.commit), as("Octo Of Project", "octo.project@example.net"));
  // In a project whose git config gives another address, git config's chosen one cannot be confirmed: the private one.
  assert.deepEqual((await flow.signers({ folder: other.dir })).signer, { name: "Octo Person", email: NOREPLY, kind: "noreply", fallback: "unconfirmed" });
  // The address is never in the project's files nor in the log.
  for (const text of [...textsUnder(p.dir).filter((one) => !one.includes("[user]")), ...lines]) assert.equal(/octo\.work@|octo\.person@|octo\.project@/.test(text), false, text);
  // Back to the private address; signing out forgets the choice.
  assert.equal((await flow.chooseSigner({ email: "noreply" })).signer.email, NOREPLY);
  assert.deepEqual(choices(), { [`id:${ACCOUNT.id}`]: { login: LOGIN, email: "noreply" } });
  await flow.chooseSigner({ email: "octo.work@example.net" });
  await flow.signOut();
  assert.deepEqual(choices(), {}, "signed out: the account's choice is gone");
});

test("a sign-in that may not read the account's addresses: the private address, the profile's public one and git config's are offered, with how to let it; a recorded address it cannot confirm is not used, and one the account dropped is forgotten", async () => {
  const { flow, later, dataDir } = await signedIn({ gitconfig: "[user]\n\temail = octo.home@example.org\n" });
  const p = project("clock-scope");
  await flow.chooseSigner({ email: "octo.person@example.com", folder: p.dir });
  stub.account.emailScope = false;
  stub.account.email = "octo.public@example.com";
  // Check again within five seconds is the answer of a moment ago; after them GitHub is asked again.
  assert.equal((await flow.signers({ folder: p.dir, fresh: true })).scope, true);
  later(5_000);
  const offered = await flow.signers({ folder: p.dir, fresh: true });
  assert.equal(offered.scope, false);
  assert.match(offered.grant, /^gh auth refresh --hostname github\.com --scopes user:email$/);
  assert.deepEqual(offered.offered, [{ email: NOREPLY, kind: "noreply" }, { email: "octo.public@example.com", kind: "verified" }, { email: "octo.home@example.org", kind: "git" }]);
  assert.deepEqual(offered.signer, { name: "Octo Person", email: NOREPLY, kind: "noreply", fallback: "unconfirmed" }, "not confirmed as the account's now: the private address");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-scope" });
  assert.equal(signedBy(pushed.commit).author.email, NOREPLY);
  // A push that names an address it cannot check: refused, with how to let GitHub CLI read them.
  const refused = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-scope", email: "octo.work@example.net" }).catch((e) => e);
  assert.equal(refused.code, "email_not_offered");
  assert.match(refused.hint, /gh auth refresh -h github\.com -s user:email/);
  // Readable again, and the address taken off the account: forgotten.
  stub.account.emailScope = true;
  stub.account.emails = stub.account.emails.filter((one) => one.email !== "octo.person@example.com");
  later(5_000);
  assert.deepEqual((await flow.signers({ folder: p.dir, fresh: true })).signer.fallback, "gone");
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "github", "commit-email.json"), "utf8")), {});
});

test("publish push --email: the address for this push, recorded only once a commit is made with it; the name is the account's, else its login, never git config's alone", async () => {
  stub.account.name = null;
  const { flow, dataDir } = await signedIn({ gitconfig: "[user]\n\tname = Octo From Git\n" });
  const choices = () => JSON.parse(readFileSync(path.join(dataDir, "github", "commit-email.json"), "utf8"));
  const p = project("clock-email");
  // Refused (not one of the account's): nothing recorded, nothing sent.
  await assert.rejects(flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-email", email: "nobody@example.com" }), { code: "email_not_offered" });
  assert.equal(stub.repoOf(`${LOGIN}/clock-email`), null);
  assert.throws(choices, { code: "ENOENT" }, "nothing recorded");
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-email", email: "octo.person@example.com" });
  assert.deepEqual(signedBy(pushed.commit), as(LOGIN, "octo.person@example.com"), "no profile name: the login, not git config's name");
  assert.equal((await flow.signers()).signer.email, "octo.person@example.com", "kept for the next commits");
  // The question before a push names the private address too, and checks no address the program names.
  assert.deepEqual((await flow.signerOf({})).noreply, { name: LOGIN, email: NOREPLY, kind: "noreply" });
});

test("GitHub refusing a commit that would show a private address (GH007): its own words, the address not in them, and no longer the choice; GH007's words for the private address itself never offer it again", async () => {
  const { flow, dataDir } = await signedIn();
  const p = project("clock-gh007");
  await flow.chooseSigner({ email: "octo.person@example.com" });
  const gh007 = { status: 422, body: { message: "GH007: Your push would publish a private email address.", documentation_url: "https://docs.github.com/articles/setting-your-email-in-git" } };
  stub.hooks.fail = (req, url) => (req.method === "POST" && url.pathname.endsWith("/git/commits") ? gh007 : null);
  const refused = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-gh007" }).catch((e) => e);
  assert.equal(refused.code, "email_private");
  assert.match(refused.hint, /private address/);
  assert.equal(`${refused.message} ${refused.hint}`.includes("octo.person@example.com"), false);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "github", "commit-email.json"), "utf8")), {}, "the refused address is not the default any more");
  // The private address refused with the same words: another code, which offers nothing to switch to.
  const again = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-gh007" }).catch((e) => e);
  assert.equal(again.code, "email_refused");
  stub.hooks.fail = null;
  const pushed = await flow.push({ folder: p.dir, status: p.status, files: p.plan, name: "clock-gh007" });
  assert.equal(signedBy(pushed.commit).author.email, NOREPLY);
});

test("the questions before a push and a request name who the commit is signed by: the private address, a chosen one (kept private: GitHub may refuse it), git config's, the address a program asks for", () => {
  const list = parseChecklist(TEMPLATE);
  const target = { owner: LOGIN, name: "clock", commit: "a".repeat(40) };
  const [first] = requestQuestions({ folder: "/p", catalog: { owner: "busy-app", name: "busy-apps-catalog" }, target, ai: "none", list, signer: { name: "Octo Person", email: NOREPLY, kind: "noreply" } });
  assert.match(first.detail, new RegExp(`The commit of the app's manifest is signed Octo Person <${NOREPLY.replace(/[.+]/g, "\\$&")}>, GitHub's private address of your account: it shows no e-mail\\.`));
  assert.match(signerSentence({ name: "O", email: "octo.person@example.com", kind: "verified", private: true }), /anyone can see it on the commit\. GitHub keeps it private for your account, and may refuse the commit/);
  assert.match(signerSentence({ name: "O", email: "o@example.com", kind: "git" }), /git config gives, which GitHub has not verified/);
  assert.match(signerSentence({ name: "O", email: "o@example.com", kind: "asked" }), /the address the program asks for: the emulator checks that it is one of your account's before anything is sent/);
  assert.match(signerSentence({ name: "O", email: NOREPLY, kind: "noreply", fallback: "gone" }), /The address chosen before is no longer one of your account's\./);
});

test("git config read as data: the [user] section's last values, quotes and comments, no other section's; the project's own before the person's", () => {
  assert.deepEqual(userOf('[user]\n  name = First\n  name = "Last Name" # comment\n  email = last.name@example.com\n[user "sub"]\n  email = not.this@example.com\n'), { name: "Last Name", email: "last.name@example.com" });
  assert.deepEqual(userOf("[user]\n  email = not an address\n  name = <bad>\n"), { name: null, email: null });
  const home = mkdtempSync(path.join(root, "home-"));
  writeFileSync(path.join(home, ".gitconfig"), "[user]\n  name = Home Name\n  email = home@example.com\n");
  const p = project("git-layers", { git: "[user]\n  email = project@example.com\n" });
  // The name of the file that gives the address, never another's: the project's address has no name here.
  assert.deepEqual(localUser(p.dir, { home }), { name: null, email: "project@example.com" });
  assert.deepEqual(localUser(project("git-none").dir, { home }), { name: "Home Name", email: "home@example.com" });
  assert.deepEqual(localUser(null, { home: mkdtempSync(path.join(root, "empty-")) }), { name: null, email: null });
});
