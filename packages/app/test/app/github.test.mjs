// Publish stage 2 in the app: gh's state, data and cache in the data folder, its configuration the person's (here a
// folder of the test's), and nothing asked of GitHub until the person chooses an account (test/app/publish.test.mjs
// goes the whole way against a stand-in).
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { FAKE_GH } from "../fixtures/fake-gh.mjs";
import { launch } from "./harness.mjs";

let app = null;
const runs = path.join(os.tmpdir(), `busy-gh-runs-${process.pid}.jsonl`);

afterEach(async () => {
  await app?.close();
  app = null;
  rmSync(runs, { force: true });
});

test("gh's own folders in the data folder, not signed in, and gh only asked which account it has before a sign-in", async () => {
  app = await launch({ env: { BUSY_EMULATOR_GH: FAKE_GH, BUSY_EMULATOR_FAKE_GH_STAND_IN: "http://127.0.0.1:9", BUSY_EMULATOR_FAKE_GH_LOG: runs } });
  const status = await app.run((shell) => shell.github.status());
  assert.deepEqual([status.configured, status.signedIn, status.login, status.existing, status.kept], [true, false, null, null, "keyring"]);
  for (const folder of ["gh-state", "gh-data", "gh-cache"]) assert.equal(existsSync(path.join(app.folder, "github", folder)), true, folder);
  const asked = readFileSync(runs, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(asked.map((one) => one.args.join(" ")), ["config get --host github.com user"]);
  assert.equal(asked[0].configDir, path.join(app.folder, "person", "gh"), "the test's stand-in for the person's GitHub CLI configuration");
  assert.equal(existsSync(path.join(app.folder, "github", "token")), false, "the app keeps no token of its own");
  assert.doesNotMatch(app.log(), /\[github\]/);
});

test("a build without gh says publishing needs it", async () => {
  app = await launch({ env: { BUSY_EMULATOR_GH: "none" } });
  assert.equal((await app.run((shell) => shell.github.status())).configured, false);
});
