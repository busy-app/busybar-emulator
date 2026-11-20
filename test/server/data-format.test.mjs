// The data folder's format across releases (ADR-0013, its section on the data folder; EMU-341): every folder a released emulator
// wrote opens in this one with its apps, their data and settings, its projects and the app's own files where this
// emulator reads them; opening it again changes nothing; a start killed in the middle of the move leaves a folder the
// next start finishes; a folder of a newer format is refused and left exactly as it is, by the server, the app's shell
// and the command line alike.
//
// The folders are the ones the releases wrote, recorded from each release's own server (data-folders/record.mjs):
// beta.1, beta.2, beta.3 and beta.5 wrote format 1 (beta.4 is beta.3's code), beta.6 format 2. A release that raises
// FORMAT records the folder of the release before it, if none of that format is here yet, and its own.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DATA_FORMAT, dataFolderProblem, failedMove, refusalWords } from "../../packages/app/src/data-format.mjs";
import { FORMAT, formatProblem, MIGRATIONS, openDataFolder } from "../../packages/server/data-folder.mjs";
import { FIXTURES, layOut, releasedFolders } from "./data-folders/fixtures.mjs";
import { finish, node, tempDir } from "./helpers.mjs";

after(finish);

const here = fileURLToPath(new URL(".", import.meta.url));
const CHILD = join(here, "data-format.child.mjs");
const fixtures = releasedFolders();
const byFormat = (n) => fixtures.filter((f) => f.format === n);
const open = (root, options = {}) => openDataFolder(root, { record: { port: 1 }, ...options });
const windows = process.platform === "win32";

/** Every file under `root` by its path with "/", and its SHA-256; folders end with "/". */
function files(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith("._")) continue;
      const at = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      if (lstatSync(at).isDirectory()) {
        out.set(`${key}/`, null);
        walk(at, key);
      } else out.set(key, createHash("sha256").update(readFileSync(at)).digest("hex"));
    }
  };
  walk(root, "");
  return out;
}

/** Every entry under `dir` with what a write would change: kind, size, time of change, rights, a link's target. */
function untouched(dir) {
  const out = [];
  const walk = (at, rel) => {
    const stat = lstatSync(at);
    const kind = stat.isSymbolicLink() ? `link:${readlinkSync(at)}` : stat.isDirectory() ? "dir" : "file";
    out.push(`${rel} ${kind} ${stat.isDirectory() ? "" : stat.size} ${stat.mtimeMs} ${stat.mode}`);
    if (stat.isDirectory() && !stat.isSymbolicLink()) for (const name of readdirSync(at).sort()) walk(join(at, name), `${rel}/${name}`);
  };
  walk(dir, ".");
  return out;
}

/**
 * Where each step between formats puts what the folder held at `name` (a path with "/"): its new path, or { aside } —
 * a pattern for its path under set-aside/ (any folder of that name: a start that was killed made one, the next its
 * own). A release that adds a step adds its line here; the test below fails for a step without one.
 *
 *   1 to 2  the BUSY Bar of 1.3.1 (the firmware every release of format 1 ran by default) becomes the one BUSY Bar,
 *           bar/ext; the other firmwares' BUSY Bars are set aside, whole, in set-aside/format-1-bars-<time>/
 */
const STEP_PLACES = {
  1: (name) => {
    const bar = name.match(/^bar\/([^/]+)\/(.*)$/);
    if (!bar || bar[1] === "chosen-firmware.json") return name;
    if (bar[1] === "1.3.1") return `bar/${bar[2]}`;
    return { aside: `format-1-bars-[^/]+/${escape(`${bar[1]}/${bar[2]}`)}` };
  },
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where this emulator keeps what a folder of `from` held at `name`: the steps from `from` to FORMAT, one after another. */
function placeOf(from, name) {
  let place = name;
  for (let n = from; n < FORMAT && typeof place === "string"; n++) place = STEP_PLACES[n](place);
  return place;
}

/**
 * The folder at `root`, opened by this emulator, holds what the release wrote, each file with its bytes, at its place
 * (placeOf, or `place` when the test says otherwise); nothing of it is missing or kept twice, and nothing else is there
 * but what this emulator adds: the format record, its lock's folder, the BUSY Bar's own folders, set-aside folders.
 */
function holdsWhatWasWritten(fixture, root, projects, place = (name) => placeOf(fixture.format, name)) {
  const fresh = join(projects, "..", `as-recorded-${Math.random().toString(36).slice(2)}`);
  layOut(fixture, fresh, projects);
  const wrote = files(fresh);
  const now = files(root);
  const seen = new Set();
  for (const [name, sum] of wrote) {
    if (name === "format") continue;
    const at = place(name);
    const found = typeof at === "string" ? (now.has(at) ? [at] : []) : [...now.keys()].filter((key) => new RegExp(`^set-aside/${at.aside}$`).test(key));
    if (sum === null && typeof at === "object") {
      // A folder that was set aside may have been begun in one start's set-aside folder and finished in another's.
      assert.ok(found.length >= 1, `${fixture.release}: the folder ${name} is not in a set-aside folder`);
    } else {
      assert.equal(found.length, 1, `${fixture.release}: ${name} is at ${JSON.stringify(found)}, not once at ${JSON.stringify(at)}`);
      if (sum !== null) assert.equal(now.get(found[0]), sum, `${fixture.release}: ${name} changed on its way to ${found[0]}`);
    }
    for (const key of found) seen.add(key);
  }
  assert.equal(readFileSync(join(root, "format"), "utf8"), `${FORMAT}\n`);
  const added = [...now.keys()].filter((key) => !seen.has(key) && !wrote.has(key));
  // A folder set aside whole keeps its old format record beside what it held.
  const allowed = (key) => key === "format" || key === "run/" || /^bar\/(ext\/(user_assets\/)?)?$/.test(key) || /^set-aside\/(.*\/)?$/.test(key) || (/^set-aside\/format-\d+-[^/]+\/format$/.test(key) && readFileSync(join(root, ...key.split("/")), "utf8") === fixture.files.format.text);
  assert.deepEqual(added.filter((key) => !allowed(key)), [], `${fixture.release}: what the folder holds besides what the release wrote`);
}

/**
 * The apps the person used, with their settings and data, where this emulator's BUSY Bar reads them: of format 1 those
 * of its BUSY Bar of 1.3.1; from format 2, on, the one BUSY Bar holds them all.
 */
function appsInPlace(fixture, root) {
  const ext = join(root, "bar", "ext");
  const kept = fixture.format === 1 ? fixture.apps["1.3.1"] : Object.values(fixture.apps).flat();
  const apps = readdirSync(join(ext, "user_assets")).sort();
  for (const id of kept) assert.ok(apps.includes(id), `${fixture.release}: ${id} on the BUSY Bar (${apps})`);
  assert.deepEqual(JSON.parse(readFileSync(join(ext, "apps_data", "jsrunner", "app.chain.probe.settings.json"), "utf8")).values, { minutes: 40, tree: "sakura", sound: false });
  assert.equal(readFileSync(join(ext, "apps_data", "js_apps", "app.chain.probe", "progress.json"), "utf8"), '{"sessions":7}\n');
  return apps;
}

/** How many renames a start makes on a fresh copy of `fixture` (data-format.child.mjs with 0), with `env`. */
async function renamesOf(t, fixture, dir, env = {}) {
  const count = join(dir, "count");
  layOut(fixture, join(count, "data"), join(count, "projects"));
  const counted = node(t, [CHILD, join(count, "data"), "0"], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } });
  let out = "";
  counted.stdout.on("data", (chunk) => (out += chunk));
  assert.equal(await counted.exited(30_000), 0);
  return JSON.parse(out).renames;
}

/** A fresh copy of `fixture` whose start was killed before its rename `at`: { root, projects }. */
async function killedAt(t, fixture, dir, at, env = {}) {
  const run = join(dir, `crash-${at}`);
  const root = join(run, "data");
  const projects = join(run, "projects");
  layOut(fixture, root, projects);
  const killed = node(t, [CHILD, root, String(at)], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, ...env } });
  assert.notEqual(await killed.exited(30_000), 0, `the start killed at rename ${at} ended by itself`);
  return { root, projects };
}

test("the releases' folders: one of every format up to this one's, each recorded from a release, oldest first", () => {
  for (let n = 1; n <= FORMAT; n++) assert.ok(byFormat(n).length, `no folder of format ${n} in ${FIXTURES}: record one with data-folders/record.mjs`);
  for (const f of fixtures) {
    assert.match(f.commit, /^[0-9a-f]{7,40}$/, f.release);
    assert.equal(f.by, "test/server/data-folders/record.mjs");
    assert.equal(f.files.format?.text, `${f.format}\n`, `${f.release}: the format record says the format`);
    assert.equal(`${f.release}.json`, readdirSync(FIXTURES).find((name) => name === `${f.release}.json`), "the file is named after its release");
  }
  // A later release never wrote an older format.
  for (let i = 1; i < fixtures.length; i++) assert.ok(fixtures[i].format >= fixtures[i - 1].format, `${fixtures[i].release} wrote format ${fixtures[i].format} after ${fixtures[i - 1].release}'s ${fixtures[i - 1].format}`);
});

test("every step between formats has a step in MIGRATIONS and a line in this test's STEP_PLACES", () => {
  for (let n = 1; n < FORMAT; n++) {
    assert.equal(typeof MIGRATIONS[n]?.run, "function", `no step from format ${n} in data-folder.mjs`);
    assert.equal(typeof STEP_PLACES[n], "function", `no line for the step from format ${n} in STEP_PLACES: say where it puts what the folder held`);
  }
});

for (const fixture of fixtures) {
  test(`${fixture.release} (format ${fixture.format}): opens with its apps, their data and settings, projects and the app's files in place; a second start changes nothing`, async (t) => {
    const dir = tempDir(t);
    const root = join(dir, "data");
    const projects = join(dir, "projects");
    layOut(fixture, root, projects);
    const first = await open(root);
    first.release();
    assert.equal(first.format, FORMAT);
    if (fixture.format < FORMAT) {
      assert.deepEqual([first.migrated.from, first.migrated.to, first.migrated.setAside], [fixture.format, FORMAT, null]);
      assert.ok(first.notices.some((line) => line.includes(`moved from format ${fixture.format} to ${FORMAT}`)), first.notices.join("\n"));
    } else assert.equal(first.migrated, null);
    holdsWhatWasWritten(fixture, root, projects);
    appsInPlace(fixture, root);
    if (fixture.format === 1) assert.ok(first.notices.some((line) => /the BUSY Bar of firmware dev is set aside/.test(line)), first.notices.join("\n"));

    // Idempotent: the moved folder is of this format, and a start again changes nothing.
    const before = untouched(root).filter((line) => !line.startsWith("./run"));
    const second = await open(root);
    second.release();
    assert.equal(second.migrated, null);
    assert.deepEqual(second.notices, []);
    assert.deepEqual(untouched(root).filter((line) => !line.startsWith("./run")), before);
  });
}

// From the last release of every format below this one (the folder an update from that format meets): a start killed
// before each rename it makes, then the next start, ends as one that was never killed.
for (let from = 1; from < FORMAT; from++) {
  const fixture = byFormat(from).at(-1);
  test(`${fixture.release} (format ${from}): a start killed before any rename of the move, at every one, leaves a folder the next start finishes`, async (t) => {
    const dir = tempDir(t);
    const renames = await renamesOf(t, fixture, dir);
    assert.ok(renames >= FORMAT - from, `the move of ${fixture.release} made ${renames} renames`);
    for (let at = 1; at <= renames; at++) {
      const { root, projects } = await killedAt(t, fixture, dir, at);
      const next = await open(root);
      next.release();
      assert.equal(next.format, FORMAT, `killed at rename ${at}`);
      assert.equal(next.migrated?.setAside ?? null, null, `killed at rename ${at}: the next start set the folder aside`);
      holdsWhatWasWritten(fixture, root, projects);
      appsInPlace(fixture, root);
      assert.deepEqual(readdirSync(root).filter((name) => /\.tmp$/.test(name)), [], `killed at rename ${at}: a half-written format record is left`);
    }
  });
}

// A folder that cannot be moved is set aside whole; a start killed while it does so is finished by the next, into the
// same set-aside folder, and the person is told where the apps are.
const asideFrom = fixtures[0];
const NO_STEP = { EMU_TEST_NO_STEPS: "1" };
test(`${asideFrom.release}: a folder set aside (no step for its format) keeps everything there, names its apps; a start killed at every rename of it is finished by the next`, async (t) => {
  const dir = tempDir(t);
  const renames = await renamesOf(t, asideFrom, dir, NO_STEP);
  // Every non-kept entry and the format record, then the record of the move and its end.
  assert.ok(renames >= 3, `setting aside made ${renames} renames`);
  const kept = new Set(["app-settings.json", "install.json", "logs", "shell", "run", "set-aside"]);
  const asideAt = (name) => (kept.has(name.split("/")[0]) ? name : { aside: `format-${asideFrom.format}-[^/]+/${escape(name)}` });
  for (let at = 0; at <= renames; at++) {
    const { root, projects } = at === 0 ? (() => {
      const run = join(dir, "whole");
      layOut(asideFrom, join(run, "data"), join(run, "projects"));
      return { root: join(run, "data"), projects: join(run, "projects") };
    })() : await killedAt(t, asideFrom, dir, at, NO_STEP);
    const next = await open(root, { migrations: {} });
    next.release();
    assert.ok(next.migrated?.setAside, `killed at rename ${at}: the folder is set aside`);
    holdsWhatWasWritten(asideFrom, root, projects, asideAt);
    // Everything that was set aside is in one folder, the one the notice names, with the apps by name.
    const folders = readdirSync(join(root, "set-aside")).filter((name) => readdirSync(join(root, "set-aside", name)).length);
    assert.deepEqual(folders, [path.basename(next.migrated.setAside)], `killed at rename ${at}`);
    const line = next.notices.find((notice) => notice.includes("set aside, untouched"));
    assert.ok(line?.includes(next.migrated.setAside), line);
    assert.ok(line.includes(`Its apps are there too: app.chain.probe in ${join(next.migrated.setAside, "bar", "1.3.1", "ext", "user_assets")}`), line);
    assert.deepEqual(readdirSync(join(root, "bar", "ext", "user_assets")), []);
    assert.equal(lstatSync(join(root, "set-aside")).isDirectory(), true);
    assert.ok(!readdirSync(join(root, "set-aside")).includes("moving.json"), `killed at rename ${at}: the record of the move is left`);
  }
});

/** The folders that the server, the shell and the command line must agree on: name → a function that lays it out. */
const CASES = {
  "no folder": () => {},
  "an empty folder": (root) => mkdirSync(root),
  "of this format": (root) => (mkdirSync(root), writeFileSync(join(root, "format"), `${FORMAT}\n`)),
  "of an older format": (root) => (mkdirSync(root), writeFileSync(join(root, "format"), "1\n")),
  "of a newer format": (root) => (mkdirSync(root), writeFileSync(join(root, "format"), `${FORMAT + 1}\nwhat a later version keeps after the number\n`)),
  "a record that names no format": (root) => (mkdirSync(root), writeFileSync(join(root, "format"), "three\n")),
  "a record of format 0": (root) => (mkdirSync(root), writeFileSync(join(root, "format"), "0\n")),
  "a record that is a folder": (root) => mkdirSync(join(root, "format"), { recursive: true }),
  ...(windows ? {} : { "a record that is a link": (root) => (mkdirSync(root), writeFileSync(join(root, "real"), `${FORMAT}\n`), symlinkSync(join(root, "real"), join(root, "format"))) }),
  ...(windows || process.getuid?.() === 0 ? {} : { "a record nobody may read": (root) => (mkdirSync(root), writeFileSync(join(root, "format"), `${FORMAT}\n`), chmodSync(join(root, "format"), 0)) }),
  "the layout from before the record": (root) => mkdirSync(join(root, "ext", "user_assets"), { recursive: true }),
  // A setting aside stopped after the record went into set-aside/: no record at the top, the folder looks new.
  "a setting aside a newer version began": (root) => settingAside(root, FORMAT + 1),
  "a setting aside this version began": (root) => settingAside(root, FORMAT),
};
function settingAside(root, to) {
  mkdirSync(join(root, "set-aside", "format-1-2026-11-18T00-00-00-000Z"), { recursive: true });
  writeFileSync(join(root, "set-aside", "format-1-2026-11-18T00-00-00-000Z", "format"), "1\n");
  writeFileSync(join(root, "set-aside", "moving.json"), `${JSON.stringify({ from: 1, to, folder: "format-1-2026-11-18T00-00-00-000Z" })}\n`);
  mkdirSync(join(root, "bar", "1.3.1", "ext", "user_assets", "app.left"), { recursive: true });
}

test("the server, the shell and the command line refuse the same folders, and touch nothing of one they refuse", async (t) => {
  const dir = tempDir(t);
  const refused = [];
  for (const [what, make] of Object.entries(CASES)) {
    const root = join(dir, what.replace(/ /g, "-"), "data");
    mkdirSync(path.dirname(root), { recursive: true });
    make(root);
    const before = untouched(path.dirname(root));
    const server = formatProblem(root);
    const shell = dataFolderProblem(root);
    assert.equal(shell?.kind ?? null, server?.kind ?? null, `${what}: the shell says ${JSON.stringify(shell)}, the server ${JSON.stringify(server)}`);
    if (server?.kind === "newer") assert.deepEqual([shell.format, shell.known, server.format, server.known], [FORMAT + 1, FORMAT, FORMAT + 1, FORMAT], what);
    assert.deepEqual(untouched(path.dirname(root)), before, `${what}: the checks wrote something`);
    // Opening the folder: refused exactly when the checks say so, then still untouched.
    const copy = join(dir, `${what.replace(/ /g, "-")}-opened`);
    mkdirSync(copy);
    const opened = join(copy, "data");
    make(opened);
    if (server) {
      const kept = untouched(copy);
      await assert.rejects(open(opened), (e) => e.code === "EMU_DATA_FORMAT", what);
      assert.deepEqual(untouched(copy), kept, `${what}: the server touched the folder it refused`);
      refused.push(what);
    } else {
      const done = await open(opened);
      done.release();
      // The setting aside this version began is finished: the folder left is of this format, what was left there is set aside.
      if (/this version began/.test(what)) assert.ok(done.migrated?.setAside && !lstatExists(join(opened, "bar", "1.3.1")) && !lstatExists(join(opened, "set-aside", "moving.json")), what);
    }
  }
  assert.deepEqual(refused.sort(), Object.keys(CASES).filter((what) => /newer|names no|format 0|is a folder|is a link|nobody|before the record/.test(what)).sort());
});
const lstatExists = (at) => {
  try {
    lstatSync(at);
    return true;
  } catch {
    return false;
  }
};

test("the shell's words: a newer format points to the newest version; after an update that moved the folder and then ended, they say so; a broken record says what is wrong", (t) => {
  const dir = tempDir(t);
  const root = join(dir, "data");
  CASES["of a newer format"](root);
  const problem = dataFolderProblem(root);
  const plain = refusalWords({ dataDir: root, problem, version: "0.1.0", moved: failedMove(root) });
  assert.match(plain.message, new RegExp(`is of format ${FORMAT + 1}: a newer version of BUSY Bar Emulator moved it there, and this one, 0\\.1\\.0, knows format ${FORMAT} at most\\. Nothing in it was changed`));
  assert.match(plain.message, /Install the newest version: https:\/\/github\.com\/busy-app\/busybar-emulator\/releases\/latest/);
  // The update's helper left its result (update-helper.mjs, ended_after_move).
  mkdirSync(join(root, "tmp", "update-0.2.0"), { recursive: true });
  writeFileSync(join(root, "tmp", "update-0.2.0", "result.json"), JSON.stringify({ ok: false, code: "ended_after_move", version: "0.2.0", from: "0.1.0", format: FORMAT + 1 }));
  const moved = failedMove(root);
  assert.deepEqual(moved, { version: "0.2.0", from: "0.1.0", format: FORMAT + 1 });
  const after = refusalWords({ dataDir: root, problem, version: "0.1.0", moved });
  assert.match(after.title, /0\.2\.0 did not start after the update/);
  assert.match(after.message, new RegExp(`The update to 0\\.2\\.0 moved the data folder .* to its format ${FORMAT + 1} and then 0\\.2\\.0 ended before it was up\\. This version, 0\\.1\\.0, knows format ${FORMAT} at most and cannot open the folder; nothing in it was changed\\. Open BUSY Bar Emulator 0\\.2\\.0 again`));
  assert.match(after.message, /report a bug .*issues\/new/);
  assert.doesNotMatch(after.message, /Install the newest version/);
  const broken = join(dir, "broken");
  CASES["a record that names no format"](broken);
  assert.match(refusalWords({ dataDir: broken, problem: dataFolderProblem(broken), version: "0.1.0" }).message, /has a format record .*format that this version cannot use: it does not name a format\. Nothing in it was changed/);
});

test("the shell knows the format the server makes: DATA_FORMAT is FORMAT", () => {
  assert.equal(DATA_FORMAT, FORMAT, "packages/app/src/data-format.mjs DATA_FORMAT is a copy of packages/server/data-folder.mjs FORMAT");
});

test("a format record read before the lock is read again under it: a folder moved on meanwhile is refused", async (t) => {
  const root = join(tempDir(t), "data");
  mkdirSync(root);
  writeFileSync(join(root, "format"), `${FORMAT}\n`);
  // The record changes after the first look, as another emulator that moved the folder on would change it.
  const info = async (pid) => {
    writeFileSync(join(root, "format"), `${FORMAT + 1}\n`);
    return { start: 0, exe: "x", pid };
  };
  await assert.rejects(open(root, { processInfo: info }), (e) => e.code === "EMU_DATA_FORMAT" && /a newer emulator made it/.test(e.message));
  assert.equal(readFileSync(join(root, "format"), "utf8"), `${FORMAT + 1}\n`);
});
