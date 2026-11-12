#!/usr/bin/env node
// The live test of Publish stage 2 against the real GitHub: the same flow as the window's (src/github/publish-flow.mjs),
// through a real GitHub CLI, on a throwaway repository and a test catalog of the owner's. It is NOT part of any gate
// and is run only by the owner, by hand, when he says so: it signs in to a real account and creates things there.
//
//   node tools/publish-live-test.mjs --go --catalog <owner/name of a test catalog> --gh <path to gh>
//
// gh runs as the app runs it (src/github/gh.mjs): with folders of its own in a temporary data folder, which is removed
// at the end. Its token goes to the system's store, under gh:github.com, which a gh of the person's on this computer
// shares: run it where no gh of yours is signed in, or sign yours in again afterwards.
//
// What it does, each step printed:
//   1. Signs in through gh: prints a code; enter it on https://github.com/login/device and authorize GitHub CLI.
//   2. Makes a tiny project in a temporary folder (catalog.json, LICENSE, src/main.ts, a screenshot, and a
//      .github/workflows/ci.yml that must NOT be published) and publishes it to a new public repository of the
//      signed-in account, busy-emulator-live-test-<time>; checks the files GitHub holds against those sent.
//   3. Publishes again with nothing changed (the same commit), then with a file changed (a new commit, read back).
//   4. Opens a pull request to the test catalog with applications/<id>/manifest.yml naming that commit, the
//      authorship ticked (this script stands for the person's tick) and "No AI was used"; then sends again (the open
//      request gets the new commit, no second request).
//   5. Signs out (gh auth logout) and prints what to clean up by hand: the repository, the pull request and the fork.
//      gh's scopes could delete repositories; this script never does.
//
// It refuses to run without --go, and refuses the real catalog busy-app/busy-apps-catalog. This process never holds
// the token: gh does.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ghEnvironment, ghFolders, ghRunner } from "../src/github/gh.mjs";
import { createGithubPublish, parseCatalog } from "../src/github/publish-flow.mjs";
import { createPublishRecord } from "../src/github/publish-record.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};
const catalog = parseCatalog(option("--catalog"));
const ghPath = option("--gh");
if (!args.includes("--go") || !catalog || !ghPath) {
  console.error("usage: publish-live-test.mjs --go --catalog <owner/name of a test catalog> --gh <path to gh>\nIt signs in to a real GitHub account and creates a public repository and a pull request there: run it only when you mean to.");
  process.exit(2);
}
if (`${catalog.owner}/${catalog.name}`.toLowerCase() === "busy-app/busy-apps-catalog") {
  console.error("Not the real catalog: name a test catalog of yours.");
  process.exit(2);
}
const say = (line) => console.log(line);
const ID = `io.github.live.test_${Date.now().toString(36)}`;
const root = mkdtempSync(path.join(os.tmpdir(), "busy-live-"));
const dataDir = path.join(root, "data");
for (const folder of Object.values(ghFolders(dataDir))) mkdirSync(folder, { recursive: true });
const gh = { run: ghRunner({ command: path.resolve(ghPath), env: ghEnvironment(process.env, dataDir), cwd: ghFolders(dataDir).root }) };
const flow = createGithubPublish({ gh, dataDir, record: createPublishRecord(dataDir), openExternal: (address) => say(`Open ${address}`), log: (line) => say(line.replace(/[\x21-\x7e]{30,}/g, "…")) });
const dir = path.join(root, "app");
const files = {
  "catalog.json": `${JSON.stringify({ category: "utilities", short_description: "A live test of BUSY Bar Emulator's publishing" }, null, 2)}\n`,
  LICENSE: "MIT License\n\nCopyright (c) 2026 Live Test\n",
  "README.md": "# Live test\n\nMade by tools/publish-live-test.mjs of BUSY Bar Emulator. Safe to delete.\n",
  "src/main.ts": "export {};\n",
  "screenshots/front-1.png": Buffer.from("89504e470d0a1a0a", "hex"),
  ".github/workflows/ci.yml": "on: push\n",
};
for (const [rel, bytes] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), bytes);
}
const status = { folder: dir, id: ID, name: "Live test", version: "0.0.1", license: { ready: true }, texts: { texts: { short_description: "A live test of BUSY Bar Emulator's publishing" } }, github: { repo: null, request: null }, catalog: `${catalog.owner}/${catalog.name}` };
const plan = { published: Object.keys(files).map((rel) => ({ path: rel })), findings: [] };
const check = (what, ok) => {
  say(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

try {
  say("1. Signing in");
  const code = await flow.signIn();
  say(`Open ${code.verificationUri} and enter ${code.userCode}`);
  const { login } = await flow.waitSignIn();
  say(`Signed in as ${login}`);

  say("2. Publishing to a new public repository");
  const name = `busy-emulator-live-test-${Date.now().toString(36)}`;
  const first = await flow.push({ folder: dir, status, files: plan, name, progress: say });
  check(`created ${first.page} at ${first.commit}`, first.created && /^[0-9a-f]{40}$/.test(first.commit));
  check("5 files, the workflow left out", first.files === 5);
  status.github.repo = { owner: first.owner, name: first.name, page: first.page, commit: first.commit };

  say("3. Publishing again");
  const same = await flow.push({ folder: dir, status, files: plan });
  check("nothing changed: the same commit", same.unchanged && same.commit === first.commit);
  writeFileSync(path.join(dir, "src", "main.ts"), "export const changed = true;\n");
  const second = await flow.push({ folder: dir, status, files: plan });
  check(`a file changed: a new commit ${second.commit}`, second.commit !== first.commit && !second.created);
  status.github.repo.commit = second.commit;

  say(`4. The pull request to ${catalog.owner}/${catalog.name}`);
  const manifest = `sourcecode:\n  type: git\n  location:\n    origin: https://github.com/${second.owner}/${second.name}.git\n    commit_sha: ${second.commit}\ncategory: utilities\nshort_description: A live test of BUSY Bar Emulator's publishing\n`;
  const made = await flow.request({ status, files: plan, folder: dir, catalog: `${catalog.owner}/${catalog.name}`, author: true, ai: "none", manifest, progress: say });
  check(`opened ${made.url} (${made.direct ? "a branch in the catalog" : "from a fork"})`, made.created);
  const again = await flow.request({ status, files: plan, folder: dir, catalog: `${catalog.owner}/${catalog.name}`, author: true, ai: "none", manifest });
  check("sent again: the same pull request", !again.created && again.url === made.url);

  say("5. Signing out");
  await flow.signOut({ open: false });
  check("signed out", (await flow.status()).signedIn === false);
  say(`Clean up by hand: close ${made.url}; delete ${first.page} (Settings, Danger Zone)${made.direct ? "" : `; delete your fork of ${catalog.owner}/${catalog.name} if you made it for this`}; revoke GitHub CLI at https://github.com/settings/applications if you want (that signs out every GitHub CLI of yours).`);
} catch (e) {
  console.error(`FAIL ${e.code ?? "error"}: ${e.message}${e.hint ? ` ${e.hint}` : ""}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
