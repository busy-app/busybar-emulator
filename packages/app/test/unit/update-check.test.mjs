// The notice of a new version (EMU-205; ADR-0014, point 6): what is asked, what is sent, when, and what is shown.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { PORTS } from "../helpers.mjs";
import { askLatest, CHECK_EVERY_MS, compareVersions, createSettings, createUpdateCheck, FORCED_CHECK_EVERY_MS, isNewer, LATEST_RELEASE_URL, parseVersion, RELEASES, releasePage, RETRY_AFTER_FAILURE_MS, REQUEST_HEADERS, versionInAnswer, versionText } from "../../src/update-check.mjs";

const folder = mkdtempSync(path.join(os.tmpdir(), "busy-app-update-"));
after(() => rmSync(folder, { recursive: true, force: true }));
let files = 0;
const settingsFile = () => path.join(folder, `settings-${++files}`, "app-settings.json");

test("the address is the latest release of the public repository, and the request says nothing else", () => {
  assert.deepEqual(RELEASES, { owner: "busy-app", repo: "busybar-emulator" });
  assert.equal(LATEST_RELEASE_URL, "https://api.github.com/repos/busy-app/busybar-emulator/releases/latest");
  // A fixed User-Agent, which GitHub's API requires, without the app's version; no cookie, no identifier.
  assert.deepEqual(REQUEST_HEADERS, { "User-Agent": "busybar-emulator", Accept: "application/vnd.github+json" });
});

test("versions: three numbers and an optional pre-release part, with or without v; anything else is not a version", () => {
  assert.deepEqual(parseVersion("v0.2.10"), { core: [0, 2, 10], pre: [] });
  assert.deepEqual(parseVersion("1.0.0"), { core: [1, 0, 0], pre: [] });
  assert.deepEqual(parseVersion("v0.1.0-beta.1"), { core: [0, 1, 0], pre: ["beta", "1"] });
  assert.deepEqual(parseVersion("1.2.3-rc-1.x.0"), { core: [1, 2, 3], pre: ["rc-1", "x", "0"] });
  assert.equal(versionText("v0.1.0-beta.1"), "0.1.0-beta.1");
  assert.equal(versionText("v0.2.10"), "0.2.10");
  const garbage = ["", "v1", "1.2", "1.2.3.4", "latest", "nightly", "v1.2.x", "01.2.3", "1.2.3-", "1.2.3-beta..1", "1.2.3-beta.01", "1.2.3-beta_1", "1.2.3+build.5", "1.2.3-beta.1+build", "1.2.3 beta", `1.2.3-${"a".repeat(80)}`, "1234567.0.0", null, undefined, "0.2.0\" onclick=\"x", "0.2.0-x\" onclick=\"x", "0.2.0-beta/../../evil"];
  for (const text of garbage) {
    assert.equal(parseVersion(text), null, String(text));
    assert.equal(versionText(text), null, String(text));
    // A tag that is not a version is never offered, and nothing is offered to a version that is not one.
    assert.equal(isNewer(text, "0.0.1"), false, String(text));
    assert.equal(isNewer("9.9.9", text), false, String(text));
    assert.equal(compareVersions(text, "0.0.1"), null, String(text));
  }
  assert.equal(isNewer("0.2.0", "0.1.9"), true);
  assert.equal(isNewer("v0.10.0", "0.9.0"), true);
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.2.0"), false);
  assert.equal(isNewer("0.2.0", "not a version"), false);
  // The app itself may be a pre-release (the first release is 0.1.0-beta.1): the release of the same numbers and
  // anything above is newer than it, anything below is not.
  assert.equal(isNewer("0.1.0", "0.1.0-beta.1"), true);
  assert.equal(isNewer("v0.1.1", "0.1.0-beta.1"), true);
  assert.equal(isNewer("0.2.0", "0.1.0-rc.2"), true);
  assert.equal(isNewer("0.0.9", "0.1.0-beta.1"), false);
  for (const text of ["0.1.0-", "0.1.0-beta 1", "0.1.0+build", "0.1-beta.1"]) assert.equal(isNewer("9.9.9", text), false, text);
});

test("betas are offered like any release: by the precedence of Semantic Versioning", () => {
  // The next beta, and the tenth after the second: numbers compare as numbers, not as text.
  assert.equal(isNewer("v0.1.0-beta.2", "0.1.0-beta.1"), true);
  assert.equal(isNewer("v0.1.0-beta.10", "0.1.0-beta.2"), true);
  assert.equal(isNewer("v0.1.0-beta.2", "0.1.0-beta.10"), false);
  // The release itself is above every beta of it.
  assert.equal(isNewer("v0.1.0", "0.1.0-beta.1"), true);
  assert.equal(isNewer("v0.1.0", "0.1.0-beta.10"), true);
  // A release is not offered a beta of itself, nor the same version again.
  assert.equal(isNewer("v0.1.0-beta.3", "0.1.0"), false);
  assert.equal(isNewer("v0.1.0-beta.1", "0.1.0-beta.1"), false);
  assert.equal(isNewer("v0.1.0", "0.1.0"), false);
  // The numbers decide before the pre-release part does.
  assert.equal(isNewer("v0.2.0-beta.1", "0.1.0"), true);
  assert.equal(isNewer("v0.2.0-beta.1", "0.1.5-beta.7"), true);
  assert.equal(isNewer("v0.1.0-beta.9", "0.1.1"), false);
  // The order of the specification's own example, each one above all before it.
  const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(isNewer(order[i], order[j]), i > j, `${order[i]} over ${order[j]}`);
      assert.equal(Math.sign(compareVersions(order[i], order[j])), Math.sign(i - j), `${order[i]} against ${order[j]}`);
    }
  }
  // A number is below an identifier with a letter; numbers longer than a machine number still compare by value.
  assert.equal(isNewer("1.0.0-beta.x", "1.0.0-beta.99"), true);
  assert.equal(isNewer("1.0.0-beta.100000000000000000001", "1.0.0-beta.100000000000000000000"), true);
  assert.equal(isNewer("1.0.0-beta.9", "1.0.0-beta.100000000000000000000"), false);
});

test("the release page is made from the version alone; of GitHub's answer only the version is read", () => {
  assert.equal(releasePage("0.2.0"), "https://github.com/busy-app/busybar-emulator/releases/tag/v0.2.0");
  assert.equal(releasePage("v0.1.0-beta.2"), "https://github.com/busy-app/busybar-emulator/releases/tag/v0.1.0-beta.2");
  assert.throws(() => releasePage("0.2.0/../../evil"), /Not a version/);
  assert.throws(() => releasePage("0.2.0-beta/../../evil"), /Not a version/);
  assert.equal(versionInAnswer(JSON.stringify({ tag_name: "v0.1.0-beta.2" })), "0.1.0-beta.2");
  assert.equal(versionInAnswer(JSON.stringify({ tag_name: "v0.2.0", html_url: "https://evil.example/", body: "notes" })), "0.2.0");
  for (const body of ["", "not json", "null", "[]", JSON.stringify({ message: "Not Found" }), JSON.stringify({ tag_name: "nightly" }), JSON.stringify({ tag_name: 5 })]) assert.equal(versionInAnswer(body), null, body);
});

function setup({ current = "0.1.0", allowed = true, answers = [], file = settingsFile(), time = { now: 1_000_000_000_000 } } = {}) {
  const notices = [];
  const lines = [];
  let asked = 0;
  const check = createUpdateCheck({
    current,
    allowed,
    settings: createSettings(file),
    ask: async () => {
      const answer = answers[asked++] ?? answers.at(-1);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    log: (line) => lines.push(line),
    onNotice: (notice) => notices.push(notice),
    now: () => time.now,
  });
  return { check, notices, lines, file, time, asked: () => asked, kept: () => JSON.parse(readFileSync(file, "utf8")) };
}
const release = (tag) => JSON.stringify({ tag_name: tag });

test("a newer release gives a notice with its version and its page; the answer is kept", async () => {
  const { check, notices, asked, kept, time } = setup({ answers: [release("v0.2.0")] });
  await check.check();
  assert.deepEqual(notices, [{ version: "0.2.0", page: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.2.0" }]);
  assert.deepEqual(check.notice, notices[0]);
  assert.equal(asked(), 1);
  assert.equal(check.requests, 1);
  assert.deepEqual(kept(), { updateChecked: time.now, updateFailed: null, updateLatest: "0.2.0", updateCheckedBy: "0.1.0" });
});

test("the same release or an older one gives no notice; a tag that is not a version is ignored", async () => {
  for (const tag of ["v0.1.0", "v0.0.9", "v0.1.0-beta.3", "nightly", "v0.2", "0.2.0+build", ""]) {
    const { check, notices } = setup({ answers: [release(tag)] });
    await check.check();
    assert.deepEqual(notices, [], tag);
    assert.equal(check.notice, null, tag);
  }
});

test("a beta is told about the next beta and about the release, with the page of that tag", async () => {
  for (const [current, tag, version] of [
    ["0.1.0-beta.1", "v0.1.0-beta.2", "0.1.0-beta.2"],
    ["0.1.0-beta.2", "v0.1.0-beta.10", "0.1.0-beta.10"],
    ["0.1.0-beta.1", "v0.1.0", "0.1.0"],
  ]) {
    const { check, notices, kept } = setup({ current, answers: [release(tag)] });
    await check.check();
    assert.deepEqual(notices, [{ version, page: `https://github.com/busy-app/busybar-emulator/releases/tag/v${version}` }], `${current} and ${tag}`);
    assert.equal(kept().updateLatest, version);
  }
  // The beta before, the same beta, a beta of the release one already has: nothing.
  for (const [current, tag] of [["0.1.0-beta.2", "v0.1.0-beta.1"], ["0.1.0-beta.2", "v0.1.0-beta.2"], ["0.1.0", "v0.1.0-beta.3"]]) {
    const { check, notices } = setup({ current, answers: [release(tag)] });
    await check.check();
    assert.deepEqual(notices, [], `${current} and ${tag}`);
  }
});

test("at most once a day: a start within a day of the last check asks nothing and shows what that check found", async () => {
  const first = setup({ answers: [release("v0.2.0")] });
  await first.check.check();
  const time = { now: first.time.now + CHECK_EVERY_MS - 1000 };
  const second = setup({ answers: [release("v0.3.0")], file: first.file, time });
  await second.check.check();
  assert.equal(second.asked(), 0);
  assert.deepEqual(second.notices, [{ version: "0.2.0", page: "https://github.com/busy-app/busybar-emulator/releases/tag/v0.2.0" }]);
  // A day on, it asks again, and the notice follows.
  time.now += 2000;
  await second.check.check();
  assert.equal(second.asked(), 1);
  assert.equal(second.check.notice.version, "0.3.0");
});

test("the app that was updated meanwhile shows no notice for the version it now is, and its first start asks again", async () => {
  const first = setup({ current: "0.1.0-beta.1", answers: [release("v0.1.0-beta.2")] });
  await first.check.check();
  // Installed within the day: what beta.1 was told is no news to beta.2, and beta.2 asks for itself at once.
  const second = setup({ current: "0.1.0-beta.2", answers: [release("v0.1.0-beta.2")], file: first.file, time: first.time });
  await second.check.check();
  assert.deepEqual(second.notices, []);
  assert.equal(second.asked(), 1);
  assert.equal(second.kept().updateCheckedBy, "0.1.0-beta.2");
  // Its next start that day asks nothing.
  await second.check.check();
  assert.equal(second.asked(), 1);
  // A hotfix that came out the same day is found on the first start of the version before it.
  const third = setup({ current: "0.1.0-beta.2", answers: [release("v0.1.0-beta.3")], file: settingsFile(), time: first.time });
  mkdirSync(path.dirname(third.file), { recursive: true });
  writeFileSync(third.file, `${JSON.stringify({ updateChecked: first.time.now, updateLatest: "0.1.0-beta.2" })}\n`);
  await third.check.check();
  assert.equal(third.asked(), 1, "a check written by beta.1, which did not say whose it was, is not beta.2's");
  assert.equal(third.check.notice?.version, "0.1.0-beta.3");
});

test("a failed check is silent: no notice, a line in the log, and no second try within 15 minutes", async () => {
  const { check, notices, lines, asked, time } = setup({ answers: [new Error("getaddrinfo ENOTFOUND api.github.com")] });
  await check.check();
  await check.check();
  assert.deepEqual(notices, []);
  assert.equal(asked(), 1);
  assert.deepEqual(lines, ["[shell] update check: no answer (getaddrinfo ENOTFOUND api.github.com)"]);
  time.now += RETRY_AFTER_FAILURE_MS + 1;
  await check.check();
  assert.equal(asked(), 2);
});

test("a hotfix is not hidden for a day by a network that was down at the start: the next try is in 15 minutes", async () => {
  const { check, notices, asked, time } = setup({ answers: [new Error("ENOTFOUND"), release("v0.2.0")] });
  await check.check();
  time.now += RETRY_AFTER_FAILURE_MS - 1000;
  await check.check();
  assert.equal(asked(), 1);
  time.now += 2000;
  await check.check();
  assert.equal(asked(), 2);
  assert.equal(notices.at(-1).version, "0.2.0");
  // An answer is a check: nothing more is asked that day.
  time.now += RETRY_AFTER_FAILURE_MS * 2;
  await check.check();
  assert.equal(asked(), 2);
});

test("a build or a run that never checks asks nothing, whatever the settings say", async () => {
  const { check, asked, notices } = setup({ allowed: false, answers: [release("v9.0.0")] });
  await check.check();
  check.start();
  check.setEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked(), 0);
  assert.deepEqual(notices, []);
  assert.equal(check.enabled(), false);
});

test("the person's switch: off asks nothing, takes the notice away and is kept; on asks again when a check is due", async () => {
  const { check, notices, asked, kept, file, time } = setup({ answers: [release("v0.2.0")] });
  await check.check();
  check.setEnabled(false);
  assert.equal(check.enabled(), false);
  assert.equal(notices.at(-1), null);
  assert.equal(kept().updateCheck, false);
  time.now += CHECK_EVERY_MS + 1;
  await check.check();
  assert.equal(asked(), 1);
  // The next start reads the switch from the file.
  const next = setup({ answers: [release("v0.2.0")], file, time });
  await next.check.check();
  assert.equal(next.asked(), 0);
  assert.deepEqual(next.notices, []);
  next.check.setEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(next.asked(), 1);
  assert.equal(next.check.notice.version, "0.2.0");
});

test("a settings file that is not one is an empty one, and is written anew", async () => {
  const file = settingsFile();
  const settings = createSettings(file);
  assert.deepEqual(settings.read(), {});
  assert.equal(settings.update({ a: 1 }), true);
  writeFileSync(file, "{ not json");
  assert.deepEqual(settings.read(), {});
  writeFileSync(file, "[1, 2]");
  assert.deepEqual(settings.read(), {});
  assert.equal(settings.update({ b: 2 }), true);
  assert.deepEqual(settings.read(), { b: 2 });
});

// ---------------------------------------------------------------- the request itself, at a stand-in on this machine

function standIn(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, raw: req.rawHeaders });
    handler(req, res);
  });
  return new Promise((resolve) => server.listen(PORTS.unit, "127.0.0.1", () => resolve({ seen, address: `http://127.0.0.1:${PORTS.unit}/repos/busy-app/busybar-emulator/releases/latest`, close: () => new Promise((done) => (server.closeAllConnections(), server.close(done))) })));
}

test("the request carries its address, the fixed User-Agent and Accept, and nothing else", async () => {
  const server = await standIn((_req, res) => res.end(release("v0.2.0")));
  try {
    assert.equal(versionInAnswer(await askLatest(server.address, http)), "0.2.0");
    assert.equal(server.seen.length, 1);
    const [{ method, url, headers, raw }] = server.seen;
    assert.equal(method, "GET");
    assert.equal(url, "/repos/busy-app/busybar-emulator/releases/latest");
    // Every header there is: the two the app sets, and Host and Connection, which HTTP itself adds.
    assert.deepEqual(Object.keys(headers).sort(), ["accept", "connection", "host", "user-agent"]);
    assert.equal(headers["user-agent"], "busybar-emulator");
    assert.equal(headers.accept, "application/vnd.github+json");
    assert.equal(raw.length, 8);
  } finally {
    await server.close();
  }
});

test("an answer that is not 200, a redirect, a slow answer and no server at all are all failures, not hangs", async () => {
  let server = await standIn((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Not Found" }));
  });
  await assert.rejects(askLatest(server.address, http), /status 404/);
  await server.close();
  server = await standIn((_req, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" });
    res.end();
  });
  await assert.rejects(askLatest(server.address, http), /status 302/);
  assert.equal(server.seen.length, 1);
  await server.close();
  server = await standIn(() => {});
  await assert.rejects(askLatest(server.address, http, { timeoutMs: 300 }), /no answer in time/);
  await server.close();
  await assert.rejects(askLatest(server.address, http, { timeoutMs: 2000 }));
});

test("busy-emulator update --check asks now, but at most once a minute: within it the last answer stands", async () => {
  const time = { now: 1_000_000_000_000 };
  const { check, asked } = setup({ time, answers: [release("v0.2.0"), new Error("offline"), release("v0.3.0")] });
  await check.check({ force: true });
  assert.equal(asked(), 1);
  time.now += 30_000;
  await check.check({ force: true });
  assert.equal(asked(), 1, "a second forced check within the minute asks nothing");
  assert.equal(check.notice.version, "0.2.0");
  time.now += FORCED_CHECK_EVERY_MS;
  await assert.rejects(check.check({ force: true }), /offline/);
  assert.equal(asked(), 2);
  time.now += 1000;
  await assert.rejects(check.check({ force: true }), /offline/, "within the minute a failed forced check is failed still, not 'nothing new'");
  assert.equal(asked(), 2);
  time.now += FORCED_CHECK_EVERY_MS;
  await check.check({ force: true });
  assert.equal(asked(), 3);
  assert.equal(check.notice.version, "0.3.0");
});
