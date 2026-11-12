// busy-emulator trust, the whole way: the command line asks the server's management address, the server asks the
// shell over the supervisor's channel, the shell answers — here with the tests' stand-in for the click in its dialog,
// since a hidden run shows nothing — and the server remembers a yes (ADR-0012 section 4). The dialog's own rules are
// in test/unit/person-question.test.mjs; this holds the parts together in the running app, with the real server.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { APP_DIR, HAS_REAL_SERVER, NODE, removeFolder, temporaryFolder } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const CLI = path.join(APP_DIR, "..", "server", "cli", "busy-emulator.mjs");
const skip = !HAS_REAL_SERVER && "the server is not beside this package";

let app;
let work;
afterEach(async () => {
  await app?.close();
  app = null;
  if (work) await removeFolder(work);
  work = null;
});

/** A project folder the emulator did not create: what `npm create` on a Node of the person's own leaves. */
function strangerProject() {
  work = temporaryFolder();
  const dir = path.join(work, "made by npm create");
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.stranger.app" }));
  return realpathSync(dir);
}

/** The command line of this tree, as an agent runs it: no terminal, the app's data folder and port. */
function cli(args) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BUSY_EMULATOR_/i.test(name)));
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args, "--json"], { env: { ...clean, BUSY_EMULATOR_DATA: app.folder, BUSY_EMULATOR_PORT: String(app.port) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
    child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, json: JSON.parse(stdout.trim().split("\n").pop()), stderr });
      } catch {
        reject(new Error(`busy-emulator ${args.join(" ")} printed no JSON (exit code ${code}):\n${stdout}\n${stderr}`));
      }
    });
  });
}

const trustedFolders = () => {
  const file = path.join(app.folder, "projects", "trusted.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).projects.map((entry) => [entry.path, entry.how]) : [];
};

test("trust: the question goes from the command line through the server to the shell; its yes is remembered and lets the project's commands go on", { skip }, async () => {
  app = await launch({ server: "real", env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "trust" } });
  await app.waitWindow("device");
  const dir = strangerProject();

  // install, as every command that runs the project's code, asks for trust first; unlike build it starts no npm.
  const refused = await cli(["install", dir]);
  assert.equal(refused.json.code, "untrusted_project");
  assert.match(refused.json.hint, / trust /);
  assert.deepEqual(trustedFolders(), []);

  const asked = await cli(["trust", dir]);
  assert.equal(asked.code, 0, JSON.stringify(asked.json));
  assert.deepEqual([asked.json.trusted, asked.json.asked, asked.json.folder], ["now", true, dir]);
  assert.deepEqual(trustedFolders(), [[dir, "trusted"]]);
  assert.match(app.log(), new RegExp(`\\[shell\\] trust question about ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: answered by the test's stand-in \\(trust\\)`));
  // Trusted now: the command is past the question, and stops at what this bare folder lacks.
  assert.equal((await cli(["install", dir])).json.code, "no_dependencies");
  assert.equal((await cli(["trust", dir])).json.asked, false, "nobody is asked twice");
});

test("trust: the shell's no leaves the folder untrusted, and the person is not asked about it again at once", { skip }, async () => {
  app = await launch({ server: "real", env: { BUSY_EMULATOR_TEST_TRUST_ANSWER: "refuse" } });
  await app.waitWindow("device");
  const dir = strangerProject();
  const askedAt = Date.now(); // the refusal comes after this
  const asked = await cli(["trust", dir]);
  assert.deepEqual([asked.code, asked.json.code], [1, "trust_refused"]);
  // Again at once, as an agent in a loop would: the server keeps the question from the person for 30 s from the
  // refusal. What is left of them is counted from when the first call was made, not guessed: on a loaded machine
  // each run of the command line takes seconds.
  for (let n = 0; n < 3; n++) {
    const again = await cli(["trust", dir]);
    const atMost = Date.now() - askedAt; // ms from the refusal to this answer, at most
    assert.deepEqual([again.code, again.json.code], [1, "trust_refused_recently"]);
    assert.ok(again.json.retry_after_s >= Math.ceil((30_000 - atMost) / 1000) && again.json.retry_after_s <= 30, `${again.json.retry_after_s} s left ${atMost} ms after the call that was refused`);
  }
  assert.equal(app.log().split("answered by the test's stand-in (refuse)").length - 1, 1, "the shell was asked once");
  assert.deepEqual(trustedFolders(), []);
  assert.equal((await cli(["install", dir])).json.code, "untrusted_project");
  // --trust, with which a terminal once trusted a folder, trusts nothing.
  assert.equal((await cli(["install", dir, "--trust"])).json.code, "trust_needs_person");
  assert.deepEqual(trustedFolders(), []);
});

test("trust: a hidden run without the stand-in shows no dialog and trusts nothing; a page cannot ask and has nothing to answer with", { skip }, async () => {
  app = await launch({ server: "real" });
  await app.waitWindow("device");
  const dir = strangerProject();
  const asked = await cli(["trust", dir]);
  assert.deepEqual([asked.code, asked.json.code], [1, "trust_unavailable"]);
  assert.match(asked.json.message, /runs hidden and shows no dialog/);
  assert.deepEqual(trustedFolders(), []);

  // The device window's page: the management address is not reachable from it at all, and the bar's address has no
  // such path. The bridge has no action about trust: the page's actions on app projects can make the app ask the
  // person (Open App Folder, in a folder the person chose), never answer.
  const controlPort = (await app.state()).controlPort;
  assert.ok(Number.isInteger(controlPort), "the server named its management address");
  const target = encodeURIComponent(dir);
  const fromPage = await app.page(`Promise.all([
    fetch("http://127.0.0.1:${controlPort}/_emu/trust?folder=${target}", { method: "POST" }).then((r) => r.status, () => "unreachable"),
    fetch("/_emu/trust?folder=${target}", { method: "POST" }).then((r) => r.status, () => "unreachable"),
    Promise.all(["trust", "projects.trust", "trust.answer"].map((name) => window.busyShell.action(name, ${JSON.stringify(dir)}).then(() => "allowed", () => "refused"))),
  ])`);
  assert.deepEqual(fromPage, ["unreachable", 404, ["refused", "refused", "refused"]]);
  const { ACTIONS } = await import("../../src/bridge.mjs");
  assert.deepEqual(Object.keys(ACTIONS).filter((name) => /trust|ask|answer/i.test(name)), []);
  assert.deepEqual(trustedFolders(), []);
});
