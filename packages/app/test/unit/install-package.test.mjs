// Install a package (actions.mjs projects.package.install, github.release.install) on plain Node, with stand-ins for the
// command line, the person's dialog and the emulated BUSY Bar's API: the command line looks at a copy in the data
// folder's tmp/ first, the dialog names the file, the app and where it came from, nothing goes to the bar before the
// person's yes, the bytes sent are the bytes looked at, and the copy is gone after.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { createActions } from "../../src/actions.mjs";

/** A path as the dialog shows it: from ~ in the home folder, but whole on Windows (actions.mjs shownPath). */
const shownAs = (full, home) => (process.platform === "win32" ? full : full.replace(home, "~"));
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const root = realpathSync(temporaryFolder());
after(() => removeFolder(root));
let n = 0;

const FACTS = { ok: true, id: "app.you.clock", name: "Clock", version: "1.2.0", api_version: "0.1.0", notes: [], installed: false };

function setup({ looked = () => FACTS, said = ["yes"], bar = () => ({ status: 200, body: '{"result":"OK"}' }), file = null, github = null } = {}) {
  const dataDir = path.join(root, `data-${n++}`);
  mkdirSync(dataDir, { recursive: true });
  const calls = [];
  const asked = [];
  const sent = [];
  const seenBytes = [];
  const startCli = (args) => {
    const words = args.filter((word) => word !== "--json" && word !== "--progress");
    calls.push(words);
    let lines;
    if (words[0] === "install") {
      // The copy the command line is given lies in the data folder's tmp/, and holds the chosen bytes.
      seenBytes.push(readFileSync(words[1]));
      lines = [JSON.stringify(looked(words))];
    } else lines = [JSON.stringify({ ok: true, removed: [], bar: "ready", projects: [] })];
    const answer = JSON.parse(lines[0]);
    return { pid: 1, exited: Promise.resolve({ code: answer.ok ? 0 : 1, signal: null, error: null, lines }), interrupt() {}, killNow() {} };
  };
  const actions = createActions({
    startCli,
    dialogs: { choosePackage: async () => file },
    show() {},
    copy() {},
    send() {},
    dataDir,
    logFile: path.join(dataDir, "shell.log"),
    log() {},
    platform: process.platform,
    home: root,
    confirm: async (question) => (asked.push(question), said.shift() ?? "no"),
    bar: { send: async (method, pathname, body) => (sent.push([method, pathname, body]), bar(method, pathname, body)) },
    ...(github ? { github } : {}),
  });
  const call = async (name, arg) => {
    const answer = await actions.call(name, arg);
    return answer.ok ? answer.value : { rejected: answer.error };
  };
  const leftovers = () => (existsSync(path.join(dataDir, "tmp")) ? readdirSync(path.join(dataDir, "tmp")) : []);
  return { call, calls, asked, sent, seenBytes, leftovers, dataDir };
}

const stagedBar = (method, pathname) => (pathname === "/api/apps/stage" ? { status: 200, body: JSON.stringify({ result: "OK", install_key: 77, staged: { id: "app.you.clock", version: "1.2.0" } }) } : { status: 200, body: '{"result":"OK"}' });

test("a package the person chose: looked at, asked about with its file, app and source, then uploaded, installed and started; the copy is gone", async () => {
  const downloads = path.join(root, "Downloads");
  mkdirSync(downloads, { recursive: true });
  const file = path.join(downloads, "clock.tgz");
  const bytes = Buffer.from("a package's bytes");
  writeFileSync(file, bytes);
  const { call, calls, asked, sent, seenBytes, leftovers } = setup({ file, bar: stagedBar });
  const done = await call("projects.package.install");
  assert.deepEqual([done.ok, done.id, done.version, done.running, done.message, done.file], [true, "app.you.clock", "1.2.0", true, "Clock 1.2.0 is installed and running on the emulated BUSY Bar.", shownAs(path.join(root, "Downloads", "clock.tgz"), root)]);
  assert.deepEqual(calls[0].slice(0, 1).concat(calls[0].slice(2)), ["install", "--check"], "only a look, never an install by the command line");
  assert.deepEqual(seenBytes[0], bytes);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].message, "Install this app package?");
  assert.deepEqual(asked[0].buttons, ["Cancel", "Install"], "the safe button first");
  const detail = asked[0].detail;
  for (const part of [shownAs(path.join(root, "Downloads", "clock.tgz"), root), "App: Clock (app.you.clock), version 1.2.0", "From: a file on this computer", "someone else's code", "emulated BUSY Bar"]) assert.ok(detail.includes(part), part);
  assert.doesNotMatch(detail, /[\u00b7\u2022]/);
  assert.deepEqual(sent.map(([method, pathname]) => `${method} ${pathname}`), ["POST /api/apps/stage", "POST /api/apps/install?install_key=77", "POST /api/apps/launch?app_id=app.you.clock"]);
  assert.deepEqual(sent[0][2], bytes, "the bytes looked at");
  assert.deepEqual(leftovers(), [], "the copy removed");
});

test("Cancel installs nothing; a package the command line refuses is never asked about; no file chosen is nothing", async () => {
  const file = path.join(root, "x.tgz");
  writeFileSync(file, "x");
  const declined = setup({ file, said: ["no"] });
  assert.deepEqual(await declined.call("projects.package.install"), { ok: false, code: "declined", message: "Nothing was installed.", file: shownAs(file, root) });
  assert.equal(declined.sent.length, 0);
  assert.deepEqual(declined.leftovers(), []);
  const broken = setup({ file, looked: () => ({ ok: false, code: "broken_package", message: "The package cannot be read: its gzip stream is damaged.", hint: "Build the package again with busy-cli build, or ask its author for one." }) });
  const refused = await broken.call("projects.package.install");
  assert.deepEqual([refused.ok, refused.code, refused.message], [false, "broken_package", "The package cannot be read: its gzip stream is damaged."]);
  assert.deepEqual([broken.asked.length, broken.sent.length], [0, 0]);
  assert.deepEqual(broken.leftovers(), []);
  assert.equal(await setup({ file: null }).call("projects.package.install"), null);
  // The bar's own refusal is said: an app for a newer API.
  const newer = setup({ file, bar: (method, pathname) => (pathname === "/api/apps/stage" ? { status: 400, body: JSON.stringify({ error: "API version mismatch", error_code: "api_mismatch" }) } : { status: 200, body: "{}" }) });
  const mismatch = await newer.call("projects.package.install");
  assert.deepEqual([mismatch.code, mismatch.message], ["api_mismatch", "Clock needs API 0.1.0, newer than the emulated BUSY Bar's."]);
  assert.deepEqual(newer.sent.map(([, pathname]) => pathname), ["/api/apps/stage"]);
  // Too big for the bar: refused before anything is read.
  const big = path.join(root, "big.tgz");
  writeFileSync(big, "");
  const { truncateSync } = await import("node:fs");
  truncateSync(big, 100 * 1024 * 1024 + 1);
  const tooBig = await setup({ file: big }).call("projects.package.install");
  assert.equal(tooBig.code, "package_too_large");
});

test("a release's package from GitHub: downloaded into the data folder's tmp/, then the same look, question and install; nothing found is said", async () => {
  let into = null;
  const github = {
    downloadRelease: async ({ repo, into: folder }) => {
      into = folder;
      assert.equal(repo, "octo/bar-release");
      const file = path.join(folder, "app.you.clock.tgz");
      writeFileSync(file, "release bytes");
      return { file, asset: "app.you.clock.tgz", size: 13, tag: "v1.2.0", version: "1.2.0", owner: "octo", name: "bar-release", page: "https://github.com/octo/bar-release/releases/tag/v1.2.0" };
    },
  };
  const { call, asked, sent, leftovers, dataDir } = setup({ github, bar: stagedBar });
  const done = await call("github.release.install", { repo: "octo/bar-release" });
  assert.equal(done.ok, true);
  assert.ok(into.startsWith(path.join(dataDir, "tmp")), into);
  assert.match(asked[0].detail, /^app\.you\.clock\.tgz, from the release v1\.2\.0 of github\.com\/octo\/bar-release\n/);
  assert.match(asked[0].detail, /From: https:\/\/github\.com\/octo\/bar-release\/releases\/tag\/v1\.2\.0/);
  assert.deepEqual(sent[0][2], Buffer.from("release bytes"));
  assert.deepEqual(leftovers(), []);
  const none = setup({ github: { downloadRelease: async () => Promise.reject(Object.assign(new Error("github.com/octo/docs has no app project (no src/appmeta/manifest.json), and it has no releases. There is nothing to install."), { code: "no_package", hint: "Choose another repository." })) } });
  const refused = await none.call("github.release.install", { repo: "octo/docs" });
  assert.deepEqual([refused.code, refused.message], ["no_package", "github.com/octo/docs has no app project (no src/appmeta/manifest.json), and it has no releases. There is nothing to install."]);
  assert.equal(none.asked.length, 0);
  assert.deepEqual(none.leftovers(), []);
});
