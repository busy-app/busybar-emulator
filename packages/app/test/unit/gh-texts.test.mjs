// What the bundled GitHub CLI says, as recorded from it (test/fixtures/gh-texts.json, tools/gh-texts.mjs record): the
// fixture belongs to the pinned gh, the app reads every recorded text as it should, and the tests' stand-in for gh
// (test/fixtures/fake-gh.mjs) prints exactly those texts. A bump of the pinned gh fails here until its texts are
// recorded again; `npm run live:gh` compares the fixture with what the real gh says on github.com.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { accountToken, cleanLine, ghTransport, loginFailure, loginReader } from "../../src/github/gh.mjs";
import { readPin, versionLine } from "../../tools/bundled-gh.mjs";
import { FORMATS, LOGIN_ARGS, normalise } from "../../tools/gh-texts.mjs";
import { fakeSignedIn, ghSays, GH_TEXTS, runFakeGh } from "../fixtures/fake-gh.mjs";
import { startGithubStub } from "../fixtures/github-stub.mjs";
import { PORTS } from "../helpers.mjs";

let stub;
let root;
before(async () => {
  stub = await startGithubStub({ port: PORTS.unit });
  root = mkdtempSync(path.join(os.tmpdir(), "busy-gh-texts-"));
});
after(async () => {
  await stub.close();
  rmSync(root, { recursive: true, force: true });
});

const CODE = "WDJB-MJHT";

test("the fixture is the pinned gh's: recorded from it, with the format strings the app reads", () => {
  const pin = readPin().version;
  assert.equal(GH_TEXTS.gh, pin, `gh-texts.json is of gh ${GH_TEXTS.gh}, the pin is ${pin}: run node tools/gh-texts.mjs record (macOS), then npm run live:gh`);
  assert.match(GH_TEXTS.offline.version.stdout.split("\n")[0], versionLine(pin));
  assert.deepEqual(GH_TEXTS.formats, FORMATS, "the fixture holds the formats tools/gh-texts.mjs looks for");
  for (const variant of ["copied", "copyFailed", "notCopied"]) assert.ok(GH_TEXTS.live[variant]?.shown, `the sign-in start ${variant} is recorded`);
  assert.deepEqual(LOGIN_ARGS, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"]);
  assert.equal(normalise(`a ${CODE} b\r\n`, null), "a {code} b\n");
});

test("what gh printed offline is its format strings with their values: the stand-in's way of printing them is gh's", () => {
  const done = GH_TEXTS.offline.switched.stderr.split(" ")[0];
  assert.equal(done, "✓");
  assert.equal(GH_TEXTS.offline.configNoUser.stderr, `${ghSays("noKey", "user")}\n`);
  assert.equal(GH_TEXTS.offline.tokenNoAccount.stderr, `${ghSays("noToken", "github.com")} account fake-carol\n`);
  assert.equal(GH_TEXTS.offline.switched.stderr, ghSays("switched", done, "github.com", "fake-alice"));
  assert.equal(GH_TEXTS.offline.switchUnknown.stderr, `${ghSays("notLoggedIn", "github.com", "fake-carol")}\n`);
  assert.equal(GH_TEXTS.offline.logoutUnknown.stderr, `${ghSays("notLoggedIn", "github.com", "fake-carol")}\n`);
  assert.equal(GH_TEXTS.offline.loggedOutActive.stderr, ghSays("loggedOut", done, "github.com", "fake-bob") + ghSays("switched", done, "github.com", "fake-alice"));
  assert.equal(GH_TEXTS.offline.apiNoSignIn.code, 4, "gh's exit code without a sign-in (gh.mjs EXIT_AUTH)");
});

test("the app reads every recorded text: the code and page of each sign-in start however it comes in pieces, a missing token, gh without a sign-in, the end of a sign-in", async () => {
  for (const [variant, { stderr, shown }] of Object.entries(GH_TEXTS.live)) {
    const said = stderr.replaceAll("{code}", CODE);
    for (let cut = 0; cut <= said.length; cut++) {
      const reader = loginReader();
      const got = reader.take(said.slice(0, cut)) ?? reader.take(said.slice(cut));
      assert.deepEqual(got, { ...shown, userCode: CODE }, `${variant}, cut at ${cut}`);
    }
  }
  assert.deepEqual(GH_TEXTS.live.copied.shown.copied, true);
  const { code, stderr } = GH_TEXTS.offline.tokenNoAccount;
  const run = async () => ({ code, stdout: Buffer.alloc(0), stderr });
  assert.deepEqual(await accountToken(run, "fake-carol"), { failure: "no_account", detail: "no oauth token found for github.com account fake-carol" });
  const noSignIn = GH_TEXTS.offline.apiNoSignIn;
  assert.deepEqual(await ghTransport(async () => ({ code: noSignIn.code, stdout: Buffer.alloc(0), stderr: noSignIn.stderr })).request("GET", "/user"), { failure: "auth", detail: cleanLine(noSignIn.stderr) });
  // The end of a sign-in (publish-flow.mjs reads the login, and whether the token went into plain text).
  assert.equal(/Logged in as ([A-Za-z0-9-]+)/.exec(ghSays("loggedInAs", "✓", "octo-person"))?.[1], "octo-person");
  assert.match(ghSays("plainText", "!"), /saved in plain text/i);
  // GitHub's refusals, in gh's words around them (github.com/cli/oauth: "<description> (<error>)").
  assert.equal(loginFailure(ghSays("webFailed", "The authorization request was denied. (access_denied)")), "denied");
  assert.equal(loginFailure(ghSays("webFailed", "The device code has expired. (expired_token)")), "expired");
});

test("the stand-in for gh prints what gh prints: the same words and exit codes for each recorded run, and each sign-in start", async () => {
  const env = fakeSignedIn(path.join(root, "two"), { login: "fake-bob", token: "t-bob", standIn: stub.base, accounts: { "fake-alice": "t-alice", "fake-bob": "t-bob" } });
  const empty = { GH_CONFIG_DIR: path.join(root, "empty", "gh"), GH_HOST: "github.com", BUSY_EMULATOR_FAKE_GH_STAND_IN: stub.base };
  const order = ["configNoUser", "apiNoSignIn", "tokenNoAccount", "switchUnknown", "logoutUnknown", "switched", "loggedOutActive"];
  for (const id of order) {
    const recorded = GH_TEXTS.offline[id];
    // The recorded run started from two accounts with fake-bob active: so does the stand-in's, for each.
    if (id === "loggedOutActive") await runFakeGh(["auth", "switch", "--hostname", "github.com", "--user", "fake-bob"], { env });
    const got = await runFakeGh(recorded.args, { env: ["configNoUser", "apiNoSignIn"].includes(id) ? empty : env });
    assert.deepEqual([got.code, got.stderr], [recorded.code, recorded.stderr], id);
  }
  for (const [variant, { stderr }] of Object.entries(GH_TEXTS.live)) {
    stub.device.answers.push({ body: { device_code: "d", user_code: CODE, verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } }, { body: { error: "access_denied", error_description: "The authorization request was denied." } });
    const got = await runFakeGh(LOGIN_ARGS, { env: { ...empty, BUSY_EMULATOR_FAKE_GH_CODE_TEXT: variant, BUSY_EMULATOR_FAKE_GH_POLL_MS: "1" } });
    assert.equal(got.code, 1);
    assert.equal(got.stderr, `${stderr.replaceAll("{code}", CODE)}${ghSays("webFailed", "The authorization request was denied. (access_denied)")}\n`, variant);
    assert.equal(loginFailure(got.stderr), "denied");
  }
});
