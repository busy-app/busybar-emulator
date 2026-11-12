// The data folder (packages/server/data-folder.mjs): its layout and format number, a folder that cannot be used left
// exactly as it is, the lock that keeps a second server out, and what the server makes there for the user alone.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { spawnProgram } from "../../packages/engine/programs.mjs";
import { FORMAT, MIGRATIONS, openDataFolder, privateFile, processInfo } from "../../packages/server/data-folder.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { activeResourcesAtRest, activeResourcesSettled, finish, get, installApp, node, port, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const windows = process.platform === "win32";
const posixRights = !windows;
const CHILD = fileURLToPath(new URL("./data-folder.child.mjs", import.meta.url));
const entry = serverModule("index.mjs");
const modeOf = (file) => statSync(file).mode & 0o777;
const open = (root, options = {}) => openDataFolder(root, { firmware: "1.3.1", record: { port: 1 }, ...options });

/** Every entry under `dir`, with what a write would change: kind, size, time of change, rights, a link's target. */
function snapshot(dir) {
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

// Folders to try the tests on: a temporary one, and EMU_TEST_SIDECAR_DIR (a folder on exFAT, FAT or a network share,
// where macOS writes "._" files beside every file) when it is named.
const volumes = [["the system's temporary folder", (t) => tempDir(t)]];
if (process.env.EMU_TEST_SIDECAR_DIR) {
  volumes.push([
    `${process.env.EMU_TEST_SIDECAR_DIR} (EMU_TEST_SIDECAR_DIR)`,
    (t) => {
      const dir = join(process.env.EMU_TEST_SIDECAR_DIR, `emu-data-folder-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(dir);
      t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
      return dir;
    },
  ]);
}
// "._" files that macOS writes on such a volume are its, not the emulator's.
const names = (dir) => readdirSync(dir).filter((name) => !name.startsWith("._")).sort();

/** A child process that opens `root` (data-folder.child.mjs); `result` is its line of JSON. */
function child(t, root, mode = "hold", env = {}, exe = null) {
  const options = { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } };
  const proc = exe ? spawnTracked(t, exe, [CHILD, root, mode], options) : node(t, [CHILD, root, mode], options);
  let text = "";
  proc.stdout.on("data", (chunk) => (text += chunk));
  proc.result = until(`the child's answer (${text})`, () => (text.includes("\n") ? JSON.parse(text.split("\n")[0]) : null), 30000);
  return proc;
}

test("ps reads a process's start in UTC: this process's start, whatever the zone of the system and of the caller", { skip: windows && "no ps on Windows" }, async () => {
  // (On a computer whose system zone is UTC+0 at the time, Atlantic/Reykjavik all year, ps without TZ=UTC0 would give the
  // same answer, and this test cannot tell; anywhere else it can.)
  const described = await processInfo(process.pid);
  const start = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(described.start - start) < 2000, `ps: ${new Date(described.start).toISOString()}, this process: ${new Date(start).toISOString()}`);
});

/** Like node() of the helpers, for another executable (a link to node, by its full path): ended when the test is over. */
function spawnTracked(t, exe, args, options) {
  const proc = spawnProgram(exe, args, options);
  proc.exit = once(proc, "exit").then(([code, signal]) => code ?? signal);
  t.after(async () => {
    proc.kill("SIGKILL");
    await proc.exit;
  });
  return proc;
}

/** A process that runs and does nothing: its number is taken, and it is not an emulator. */
async function bystander(t) {
  const proc = node(t, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(proc, "spawn");
  return proc;
}

/** A lock as a server writes it, for a process that is not this one. */
function lockFor(root, owner) {
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(join(root, "format"), `${FORMAT}\n`);
  const record = { pid: owner.pid, started: owner.started ?? Date.now(), exe: process.execPath, since: new Date().toISOString(), port: 8899, nonce: randomBytes(12).toString("hex") };
  writeFileSync(join(root, "run", "server.lock"), JSON.stringify(record));
  return record;
}

const deadPid = async (t) => {
  const proc = node(t, ["-e", ""], { stdio: "ignore" });
  await proc.exited();
  return proc.pid;
};

for (const [where, folder] of volumes) {
  test(`a new data folder, on ${where}: the format number, the lock, a BUSY Bar for the firmware`, async (t) => {
    const root = join(folder(t), "data");
    const opened = await open(root);
    assert.equal(opened.created, true);
    assert.equal(opened.format, FORMAT);
    assert.equal(opened.barDir, join(root, "bar", "1.3.1"));
    assert.equal(readFileSync(join(root, "format"), "utf8"), `${FORMAT}\n`);
    assert.deepEqual(names(root), ["bar", "format", "run"]);
    assert.deepEqual(names(join(root, "run")), ["server.lock"]);
    assert.ok(statSync(join(opened.barDir, "ext", "user_assets")).isDirectory());
    const lock = JSON.parse(readFileSync(opened.lockFile, "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.port, 1);
    assert.equal(lock.exe, process.execPath);
    assert.ok(Math.abs(lock.started - (Date.now() - process.uptime() * 1000)) < 1000, "the start of this process");
    if (where.includes("EMU_TEST_SIDECAR_DIR") && process.platform === "darwin") {
      // exFAT and FAT on macOS show every file as 0700 and keep no owners: the server says so.
      assert.equal(opened.rightsKept, false);
      assert.deepEqual(opened.notices, [`The file system of ${root} does not keep file rights: other users of this computer may read the emulator's files there. Keep the data folder on the system disk.`]);
    } else {
      assert.equal(opened.rightsKept, true);
      assert.deepEqual(opened.notices, []);
    }
    opened.release();
    assert.ok(!existsSync(opened.lockFile), "the lock is let go of");
    opened.release();
    // Opened again: the same folder, not a new one, and the record is not written again.
    const before = statSync(join(root, "format")).mtimeMs;
    const again = await open(root, { firmware: "dev" });
    assert.equal(again.created, false);
    assert.equal(statSync(join(root, "format")).mtimeMs, before);
    assert.deepEqual(names(join(root, "bar")), ["1.3.1", "dev"]);
    again.release();
  });

  test(`one server at a time, on ${where}: a second process is refused while the first runs, and gets the folder once the first is killed`, async (t) => {
    const root = join(folder(t), "data");
    const holder = child(t, root);
    const held = await holder.result;
    assert.equal(held.ok, true);
    assert.deepEqual(held.notices.filter((line) => line.includes("lock")), []);
    await assert.rejects(open(root), (e) => {
      assert.equal(e.code, "EMU_DATA_IN_USE");
      assert.match(e.message, new RegExp(`^The data folder .+ is in use by another emulator \\(process ${holder.pid}, port 1, since .+\\)\\. Stop that one, or name another data folder\\.$`));
      return true;
    });
    holder.kill("SIGKILL");
    await holder.exit;
    assert.ok(existsSync(join(root, "run", "server.lock")), "a killed server leaves its lock");
    const opened = await open(root);
    // (On a volume without rights the line about them comes too.)
    const cleared = opened.notices.filter((line) => line.includes("lock"));
    assert.equal(cleared.length, 1);
    assert.match(cleared[0], new RegExp(`^The data folder's lock was left by an emulator that is no longer running \\(process ${holder.pid}, port 1, since [^)]+\\); it is cleared\\.$`));
    assert.equal(JSON.parse(readFileSync(opened.lockFile, "utf8")).pid, process.pid);
    opened.release();
  });
}

test("a folder of a newer format is left exactly as it is, and the error says why", async (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "format"), "2\nwhat format 2 adds\n");
  mkdirSync(join(root, "bar", "1.3.1", "ext"), { recursive: true });
  writeFileSync(join(root, "bar", "1.3.1", "ext", "kept.txt"), "kept");
  const before = snapshot(root);
  await assert.rejects(open(root), {
    code: "EMU_DATA_FORMAT",
    message: `The data folder ${root} is of format 2: a newer emulator made it, and this one knows format ${FORMAT} at most. It is left as it is. Use the newer emulator with it, or name another data folder.`,
  });
  assert.deepEqual(snapshot(root), before);
  // The server refuses it before anything of the bar starts, and leaves nothing running.
  const resources = await activeResourcesAtRest();
  await assert.rejects(startServer({ port: port(0), dataDir: root }), { code: "EMU_DATA_FORMAT" });
  assert.deepEqual(await activeResourcesSettled(resources), resources);
  assert.deepEqual(snapshot(root), before);
});

test("a format record that names no format, is a link or is a folder: refused, and nothing is touched", async (t) => {
  const cases = [
    ["not a number", (root) => writeFileSync(join(root, "format"), "one\n"), /does not name a format \("one"\)/],
    ["zero", (root) => writeFileSync(join(root, "format"), "0\n"), /does not name a format \("0"\)/],
    ["empty", (root) => writeFileSync(join(root, "format"), ""), /does not name a format \(""\)/],
    ["a folder", (root) => mkdirSync(join(root, "format")), /cannot be read \(EISDIR\)/],
  ];
  if (!windows) cases.push(["a link", (root) => (writeFileSync(join(root, "elsewhere"), "1\n"), symlinkSync(join(root, "elsewhere"), join(root, "format"))), /format record .+ is a link/]);
  for (const [what, make, message] of cases) {
    const root = join(tempDir(t), "data");
    mkdirSync(root);
    make(root);
    const before = snapshot(root);
    await assert.rejects(open(root), (e) => (assert.equal(e.code, "EMU_DATA_FORMAT", what), assert.match(e.message, message, what), assert.match(e.message, /It is left as it is\./), true));
    assert.deepEqual(snapshot(root), before, what);
  }
});

test("a record with more after the number is read by its first line, and kept as it is", async (t) => {
  const root = tempDir(t);
  writeFileSync(join(root, "format"), `${FORMAT}\r\nmore for a later version\n`);
  const opened = await open(root);
  assert.equal(opened.created, false);
  assert.equal(readFileSync(join(root, "format"), "utf8"), `${FORMAT}\r\nmore for a later version\n`);
  opened.release();
});

/** A folder of format `n` as an earlier emulator leaves it: an app and its settings on the bar, a project, the app's own files. */
function earlierFolder(root, n) {
  writeFileSync(join(root, "format"), `${n}\n`);
  const app = join(root, "bar", "1.3.1", "ext", "user_assets", "app.kept");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "main.js"), "kept");
  mkdirSync(join(root, "bar", "1.3.1", "ext", "apps_data", "app.kept"), { recursive: true });
  writeFileSync(join(root, "bar", "1.3.1", "ext", "apps_data", "app.kept", "settings.json"), `{"city":"Dubai"}`);
  mkdirSync(join(root, "projects"));
  writeFileSync(join(root, "projects", "registry.json"), `{"version":1,"projects":[]}`);
  writeFileSync(join(root, "app-settings.json"), `{"welcomed":true}`);
  writeFileSync(join(root, "install.json"), `{"cli":"/the/launcher"}`);
}

test("every format below this one has a step to the next: a release that raises FORMAT without one would set every folder aside", () => {
  for (let n = 1; n < FORMAT; n++) {
    assert.equal(typeof MIGRATIONS[n]?.run, "function", `no step from format ${n} to ${n + 1} in MIGRATIONS`);
    assert.equal(typeof MIGRATIONS[n].what, "string", `the step from format ${n} says nothing to the person`);
  }
  assert.deepEqual(Object.keys(MIGRATIONS).map(Number).filter((n) => !(n >= 1 && n < FORMAT)), [], "a step for a format this emulator does not move");
});

test("a folder of an older format is moved one step at a time, under the lock; what it held stays where it was", async (t) => {
  const root = tempDir(t);
  earlierFolder(root, 1);
  const seen = [];
  const migrations = {
    1: {
      what: "the first step",
      async run({ root: at, firmware }) {
        seen.push([1, readFileSync(join(at, "format"), "utf8"), firmware]);
        // Nobody else gets the folder while it is being moved.
        await assert.rejects(open(at, { format: 3, migrations }), { code: "EMU_DATA_IN_USE" });
        writeFileSync(join(at, "bar", "1.3.1", "moved-once"), "");
      },
    },
    2: { what: "the second step", run: ({ root: at }) => seen.push([2, readFileSync(join(at, "format"), "utf8")]) },
  };
  const opened = await open(root, { format: 3, migrations });
  assert.deepEqual(seen, [[1, "1\n", "1.3.1"], [2, "2\n"]], "each step finds the record of the format it moves");
  assert.deepEqual(opened.migrated, { from: 1, to: 3, setAside: null });
  assert.equal(opened.created, false);
  assert.equal(opened.format, 3);
  assert.equal(readFileSync(join(root, "format"), "utf8"), "3\n");
  assert.ok(opened.notices.includes("The data folder, made by an earlier emulator, is moved from format 1 to 3: the first step; the second step."), opened.notices.join("\n"));
  assert.equal(readFileSync(join(root, "bar", "1.3.1", "ext", "user_assets", "app.kept", "main.js"), "utf8"), "kept");
  assert.equal(readFileSync(join(root, "bar", "1.3.1", "ext", "apps_data", "app.kept", "settings.json"), "utf8"), `{"city":"Dubai"}`);
  assert.ok(existsSync(join(root, "projects", "registry.json")));
  assert.ok(existsSync(join(root, "bar", "1.3.1", "moved-once")));
  opened.release();
  // Opened again: nothing more to move.
  const again = await open(root, { format: 3, migrations: {} });
  assert.equal(again.migrated, null);
  again.release();
});

test("a folder that cannot be moved (no step, or a step fails) is set aside, not deleted, and the notice says where and why; the app's own files stay", async (t) => {
  for (const [what, migrations, why] of [
    ["no step", {}, /this emulator has no way to move format 1/],
    ["a step that fails", { 1: { what: "x", run: () => { throw new Error("the disk said no"); } } }, /moving format 1 to 2 failed: the disk said no/],
  ]) {
    const root = join(tempDir(t), "data");
    mkdirSync(root);
    earlierFolder(root, 1);
    const opened = await open(root, { format: 2, migrations });
    const aside = opened.migrated?.setAside;
    assert.ok(aside && aside.startsWith(join(root, "set-aside", "format-1-")), what);
    assert.equal(readFileSync(join(aside, "bar", "1.3.1", "ext", "user_assets", "app.kept", "main.js"), "utf8"), "kept", what);
    assert.ok(existsSync(join(aside, "projects", "registry.json")), what);
    assert.equal(readFileSync(join(aside, "format"), "utf8"), "1\n", what);
    // The folder starts anew: of this format, an empty bar, no projects; the app's settings, the pointer and the lock stay.
    assert.equal(readFileSync(join(root, "format"), "utf8"), "2\n", what);
    assert.deepEqual(names(join(root, "bar", "1.3.1", "ext", "user_assets")), [], what);
    assert.equal(existsSync(join(root, "projects")), false, what);
    assert.equal(readFileSync(join(root, "app-settings.json"), "utf8"), `{"welcomed":true}`, what);
    assert.ok(existsSync(join(root, "install.json")), what);
    assert.ok(existsSync(opened.lockFile), what);
    const line = opened.notices.find((notice) => notice.includes("could not be moved"));
    assert.match(line ?? "", why, what);
    assert.ok(line.includes(aside) && line.endsWith("the emulator starts with an empty BUSY Bar and no projects."), line);
    opened.release();
  }
});

test("the layout from before the format number (the BUSY Bar's ext at the top) is refused and left as it is", async (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, "ext", "user_assets", "app.old"), { recursive: true });
  writeFileSync(join(root, "ext", "user_assets", "app.old", "main.js"), "old");
  const before = snapshot(root);
  await assert.rejects(open(root, { firmware: "dev" }), {
    code: "EMU_DATA_FORMAT",
    message:
      `The data folder ${root} has the layout of an earlier emulator, without a format record: the BUSY Bar's storage, ext, is at its top. ` +
      `This emulator does not move it, and leaves it as it is. Move ${join(root, "ext")} to ${join(root, "bar", "dev", "ext")}, or name another folder.`,
  });
  assert.deepEqual(snapshot(root), before);
});

test("in one process: a second opening is refused while the first holds the folder", async (t) => {
  const root = tempDir(t);
  const first = await open(root);
  await assert.rejects(open(root), { code: "EMU_DATA_IN_USE", message: new RegExp(`in use by another emulator \\(process ${process.pid}, port 1, `) });
  first.release();
  const second = await open(root);
  assert.deepEqual(second.notices, []);
  second.release();
});

test("several openings at the same moment, in one process and in several: exactly one gets the folder", async (t) => {
  const root = join(tempDir(t), "data");
  const outcomes = await Promise.allSettled(Array.from({ length: 4 }, () => open(root)));
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.ok(outcomes.filter((o) => o.status === "rejected").every((o) => o.reason.code === "EMU_DATA_IN_USE"));
  outcomes.find((o) => o.status === "fulfilled").value.release();

  const fresh = join(tempDir(t), "data");
  const children = Array.from({ length: 6 }, () => child(t, fresh));
  const results = await Promise.all(children.map((c) => c.result));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === "EMU_DATA_IN_USE"), JSON.stringify(results));
});

test("several processes that find one stale lock at the same moment: one clears it and gets the folder", async (t) => {
  const root = tempDir(t);
  const pid = await deadPid(t);
  lockFor(root, { pid });
  const children = Array.from({ length: 6 }, () => child(t, root));
  const results = await Promise.all(children.map((c) => c.result));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  // The one that cleared the lock says so; another may have taken the folder in the moment between (seen on
  // Windows), and the one that cleared it is then refused like the rest.
  const winner = results.find((r) => r.ok);
  assert.ok(winner.notices.length <= 1, JSON.stringify(winner));
  for (const notice of winner.notices) assert.match(notice, new RegExp(`left by an emulator that is no longer running \\(process ${pid}, port 8899, `));
  assert.ok(existsSync(join(root, "run", "server.lock")));
  assert.ok(!existsSync(join(root, "run", "server.lock.clearing")), "the clearing mark is gone");
});

test("a stale lock that another server cleared and took meanwhile is not removed: that server keeps the folder", async (t) => {
  const root = tempDir(t);
  const other = await bystander(t);
  lockFor(root, { pid: other.pid, started: Date.now() - 3_600_000 });
  let winner = null;
  // While this opening asks the system about the lock's process, another server clears the lock and takes the folder.
  const late = open(root, {
    processInfo: async (pid) => {
      // This process, describing itself before it takes the lock: nothing to say (the lock is written without).
      if (pid === process.pid) return null;
      winner ??= await open(root);
      // The process started now, not when the lock says: the lock is stale.
      return { start: Date.now(), exe: "node" };
    },
  });
  await assert.rejects(late, { code: "EMU_DATA_IN_USE", message: new RegExp(`in use by another emulator \\(process ${process.pid}, `) });
  assert.ok(winner, "the other server opened the folder");
  assert.ok(existsSync(winner.lockFile), "its lock is still there");
  const opened = await open(root).catch((e) => e);
  assert.equal(opened.code, "EMU_DATA_IN_USE", "and still holds");
  winner.release();
});

test("a lock whose process number now belongs to another program is cleared", async (t) => {
  const root = tempDir(t);
  // A running process that is not an emulator: on macOS and Linux it started at another time than the lock says; on
  // Windows it holds no pipe for the lock.
  const other = await bystander(t);
  lockFor(root, { pid: other.pid, started: Date.now() - 3_600_000 });
  const opened = await open(root);
  assert.match(opened.notices[0], new RegExp(`left by an emulator that is no longer running \\(process ${other.pid}, `));
  opened.release();
});

test("a running process that the system will not describe is taken to be the owner, and the error names the lock to delete", async (t) => {
  const root = tempDir(t);
  const other = await bystander(t);
  lockFor(root, { pid: other.pid });
  const lockFile = join(root, "run", "server.lock");
  const before = readFileSync(lockFile, "utf8");
  await assert.rejects(open(root, { processInfo: async () => null }), {
    code: "EMU_DATA_IN_USE",
    message: `The data folder ${root} is in use by process ${other.pid}, which may be another emulator: the system would not say what it is. Stop it; if no emulator uses this folder, delete ${lockFile}.`,
  });
  assert.equal(readFileSync(lockFile, "utf8"), before);
  // The same process described as having started when the lock says, from an executable of the same name: the owner.
  const started = JSON.parse(before).started;
  await assert.rejects(open(root, { processInfo: async () => ({ start: started - 400, exe: windows ? "C:\\Program Files\\nodejs\\node.exe" : "node" }) }), { code: "EMU_DATA_IN_USE", message: /in use by another emulator/ });
  // From an executable of another name (started through a link, or process.title set): not proof that it is gone.
  await assert.rejects(open(root, { processInfo: async () => ({ start: started, exe: "/usr/bin/python3" }) }), { code: "EMU_DATA_IN_USE", message: /which may be another emulator/ });
  assert.equal(readFileSync(lockFile, "utf8"), before);
});

test("a lock keeps what ps said of its owner; ps is compared with ps: another start is another process, another command is not proof", { skip: windows && "on Windows the owner's pipe is the proof" }, async (t) => {
  const root = tempDir(t);
  const holder = child(t, root);
  assert.equal((await holder.result).ok, true);
  const lockFile = join(root, "run", "server.lock");
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  assert.deepEqual(lock.ps, await processInfo(holder.pid), "the holder's own ps record, at the second ps gives");
  // The same start under another command: busy.
  await assert.rejects(open(root, { processInfo: async () => ({ ...lock.ps, exe: "busy-emulator-server" }) }), { code: "EMU_DATA_IN_USE", message: /which may be another emulator/ });
  // Another start: the number belongs to another process now.
  const opened = await open(root, { processInfo: async (pid) => (pid === process.pid ? null : { ...lock.ps, start: lock.ps.start + 1000 }) });
  assert.match(opened.notices[0], new RegExp(`no longer running \\(process ${holder.pid}, `));
  opened.release();
  holder.kill("SIGKILL");
});

test("an owner in another time zone, or started through a link of another name, keeps the folder", async (t) => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const other = zone === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";
  // The holder in another zone than this process, and the other way round.
  for (const [holderZone, contenderZone] of [[other, undefined], [undefined, other]]) {
    const root = tempDir(t);
    const holder = child(t, root, "hold", holderZone ? { TZ: holderZone } : {});
    assert.equal((await holder.result).ok, true);
    const contender = child(t, root, "hold", contenderZone ? { TZ: contenderZone } : {});
    const refused = await contender.result;
    assert.equal(refused.code, "EMU_DATA_IN_USE", `holder in ${holderZone ?? zone}, contender in ${contenderZone ?? zone}: ${refused.message}`);
  }
  if (windows) return t.skip("a link to node needs a privilege on Windows: the half with a link ran only on macOS and Linux");
  const bin = tempDir(t);
  symlinkSync(process.execPath, join(bin, "node22"));
  const root = tempDir(t);
  const holder = child(t, root, "hold", {}, join(bin, "node22"));
  assert.equal((await holder.result).ok, true);
  await assert.rejects(open(root), { code: "EMU_DATA_IN_USE", message: new RegExp(`in use by another emulator \\(process ${holder.pid}, `) });
});

test("a lock left half-written long ago is cleared; one that is being written is waited for", async (t) => {
  const root = tempDir(t);
  lockFor(root, { pid: process.pid });
  const lockFile = join(root, "run", "server.lock");
  writeFileSync(lockFile, '{"pid": 12');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lockFile, old, old);
  const opened = await open(root);
  assert.deepEqual(opened.notices, ["The data folder's lock was left half-written by an emulator that is no longer running; it is cleared."]);
  opened.release();

  writeFileSync(lockFile, "");
  setTimeout(() => rmSync(lockFile), 400);
  const since = Date.now();
  const waited = await open(root);
  assert.ok(Date.now() - since >= 350, "it waited until the other let go");
  assert.deepEqual(waited.notices, []);
  waited.release();
});

test("a clearing mark or a half-written lock dated ahead of the clock (the clock was set back) does not keep the folder busy", async (t) => {
  const ahead = new Date(Date.now() + 3_600_000);
  // A stale lock and a clearing mark an hour ahead.
  const root = tempDir(t);
  lockFor(root, { pid: await deadPid(t) });
  const mark = join(root, "run", "server.lock.clearing");
  writeFileSync(mark, "1");
  utimesSync(mark, ahead, ahead);
  let since = Date.now();
  const opened = await open(root);
  assert.ok(Date.now() - since < 3000, `taken in ${Date.now() - since} ms`);
  assert.equal(opened.notices.length, 1);
  opened.release();
  // A half-written lock an hour ahead.
  const lockFile = join(root, "run", "server.lock");
  writeFileSync(lockFile, '{"pid": 1');
  utimesSync(lockFile, ahead, ahead);
  since = Date.now();
  const again = await open(root);
  assert.ok(Date.now() - since < 3000, `taken in ${Date.now() - since} ms`);
  assert.deepEqual(again.notices, ["The data folder's lock was left half-written by an emulator that is no longer running; it is cleared."]);
  again.release();
});

test("a clearing mark that is a folder: an error that names it, not a raw one", async (t) => {
  const root = tempDir(t);
  lockFor(root, { pid: await deadPid(t) });
  const mark = join(root, "run", "server.lock.clearing");
  mkdirSync(mark);
  const old = new Date(Date.now() - 60_000);
  utimesSync(mark, old, old);
  await assert.rejects(open(root), {
    code: "EMU_DATA_FOLDER",
    message: `The data folder ${root} cannot be used: ${mark} is not a file the emulator made (a link or a folder stands there); delete it. Name another folder, or put this one right.`,
  });
});

test("a process that ends with process.exit() lets go of the folder on its way out", async (t) => {
  const root = tempDir(t);
  const proc = child(t, root, "exit");
  assert.equal((await proc.result).ok, true);
  assert.equal(await proc.exited(), 0);
  assert.ok(!existsSync(join(root, "run", "server.lock")));
});

test("nothing is made through a link that stands where a folder or the lock should be", async (t) => {
  // On Windows a link to a folder is a junction, which needs no privilege; a link to a file is left out there.
  const linkFolder = (target, at) => symlinkSync(target, at, "junction");
  const cases = [
    ["run", (root, outside) => linkFolder(outside, join(root, "run")), /run is a link, and the emulator makes its folders itself rather than follow one/],
    ["bar", (root, outside) => linkFolder(outside, join(root, "bar")), /bar is a link/],
    ["bar/1.3.1", (root, outside) => (mkdirSync(join(root, "bar")), linkFolder(outside, join(root, "bar", "1.3.1"))), /1\.3\.1 is a link/],
    ["bar/1.3.1/ext", (root, outside) => (mkdirSync(join(root, "bar", "1.3.1"), { recursive: true }), linkFolder(outside, join(root, "bar", "1.3.1", "ext"))), /ext is a link/],
  ];
  if (!windows) {
    cases.push(["run/server.lock", (root, outside) => (mkdirSync(join(root, "run")), symlinkSync(join(outside, "victim"), join(root, "run", "server.lock"))), /server\.lock is not a file the emulator made/]);
  }
  for (const [what, make, message] of cases) {
    const base = tempDir(t);
    const root = join(base, "data");
    const outside = join(base, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "victim"), "untouched");
    make(root, outside);
    writeFileSync(join(root, "format"), `${FORMAT}\n`);
    const before = snapshot(outside);
    await assert.rejects(open(root), (e) => (assert.equal(e.code, "EMU_DATA_FOLDER", what), assert.match(e.message, message, what), true));
    assert.deepEqual(snapshot(outside), before, what);
    assert.ok(!existsSync(join(root, "run", "server.lock")) || lstatSync(join(root, "run", "server.lock")).isSymbolicLink(), `${what}: no lock is left`);
  }
});

test("a file for the user alone: made anew, a link at its name replaced rather than written through", { skip: windows && "links to files need a privilege on Windows" }, async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "victim"), "untouched");
  symlinkSync(join(dir, "victim"), join(dir, "key"));
  assert.equal(privateFile(join(dir, "key"), "secret"), true);
  assert.equal(readFileSync(join(dir, "victim"), "utf8"), "untouched");
  assert.ok(lstatSync(join(dir, "key")).isFile());
  assert.equal(readFileSync(join(dir, "key"), "utf8"), "secret");
  assert.equal(modeOf(join(dir, "key")), 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ["key", "victim"], "no temporary file is left");
});

test("what the server makes in the data folder is for the user alone; a folder that was there keeps its rights", { skip: !posixRights && "Windows has no such rights: the folder above gives them" }, async (t) => {
  const root = join(tempDir(t), "data");
  const opened = await open(root);
  assert.equal(modeOf(root), 0o700);
  for (const folder of ["run", "bar", join("bar", "1.3.1"), join("bar", "1.3.1", "ext")]) assert.equal(modeOf(join(root, folder)), 0o700, folder);
  assert.equal(modeOf(join(root, "format")), 0o600);
  assert.equal(modeOf(opened.lockFile), 0o600);
  assert.equal(opened.rightsKept, true);
  opened.release();

  const theirs = join(tempDir(t), "theirs");
  mkdirSync(theirs);
  chmodSync(theirs, 0o755);
  (await open(theirs)).release();
  assert.equal(modeOf(theirs), 0o755);
});

test("a data folder reached through a link is used where it lies", async (t) => {
  const base = tempDir(t);
  mkdirSync(join(base, "real"));
  // A junction on Windows, which needs no privilege.
  symlinkSync(join(base, "real"), join(base, "link"), "junction");
  const opened = await open(join(base, "link"));
  assert.ok(existsSync(join(base, "real", "format")));
  assert.ok(existsSync(join(base, "real", "bar", "1.3.1", "ext", "user_assets")));
  await assert.rejects(open(join(base, "real")), { code: "EMU_DATA_IN_USE" });
  opened.release();
});

// ------------------------------------------------------------------------------------------------- the server

test("a second server on the same data folder, in the same process: refused, nothing of it left, the first goes on", async (t) => {
  const dataDir = tempDir(t);
  const first = await startServer({ port: port(0), dataDir });
  t.after(() => first.stop());
  assert.ok(existsSync(first.dataFolder.lockFile));
  const resources = await activeResourcesAtRest();
  await assert.rejects(startServer({ port: port(1), dataDir, firmware: "dev" }), { code: "EMU_DATA_IN_USE" });
  assert.deepEqual(await activeResourcesSettled(resources), resources);
  assert.equal((await get(`${first.url}/api/version`)).status, 200);
  assert.equal(JSON.parse(readFileSync(first.dataFolder.lockFile, "utf8")).port, first.port);
  await first.stop();
  assert.ok(!existsSync(first.dataFolder.lockFile), "stop() lets go of the folder");
  const lines = [];
  const second = await startServer({ port: port(1), dataDir, firmware: "dev", log: (line) => lines.push(line) });
  t.after(() => second.stop());
  assert.ok(!lines.some((line) => line.includes("lock")), "nothing was left to clear");
});

test("a stop asked during the start lets go of the folder", async (t) => {
  const dataDir = tempDir(t);
  for (let turns = 0; turns < 40; turns += 4) {
    const controller = new AbortController();
    const starting = startServer({ port: port(0), dataDir, signal: controller.signal });
    for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error("stop"));
    await starting.then((emulator) => emulator.stop(), () => {});
    assert.ok(!existsSync(join(dataDir, "run", "server.lock")), `after ${turns} turns`);
  }
});

/** The command line in a process of its own; `lines()` and `stderr()` are what it printed so far. */
function commandLine(t, args, options = {}) {
  const proc = node(t, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"], ...options });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  proc.stderr.on("data", (chunk) => (err += chunk));
  proc.lines = () => out.split("\n").filter(Boolean);
  proc.stderr_ = () => err;
  // Asked for only where the test expects the server to start: the wait would go on after a process that failed.
  let ready = null;
  Object.defineProperty(proc, "ready", { get: () => (ready ??= until("the command line's first line", () => (proc.lines()[0]?.startsWith("BUSY Bar emulator: ") ? proc.lines()[0] : null), 30000)) });
  return proc;
}
const portOf = (line) => Number(/127\.0\.0\.1:(\d+)/.exec(line)[1]);

test("the command line: a second one on the same folder says so in one line; a killed one's lock is cleared by the next, which says so after its first lines", async (t) => {
  const dataDir = tempDir(t);
  const first = commandLine(t, ["--port", String(port(0)), "--data", dataDir]);
  const base = `http://127.0.0.1:${portOf(await first.ready)}`;
  const second = commandLine(t, ["--port", String(port(1)), "--data", dataDir]);
  assert.equal(await second.exited(), 1);
  assert.deepEqual(second.lines(), []);
  assert.match(second.stderr_(), new RegExp(`^The data folder ${dataDir.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")} is in use by another emulator \\(process ${first.pid}, port ${portOf(await first.ready)}, since [^)]+\\)\\. Stop that one, or name another data folder\\.\\n$`));
  assert.equal((await get(`${base}/api/version`)).status, 200, "the first goes on");

  first.kill("SIGKILL");
  await first.exit;
  const third = commandLine(t, ["--port", String(port(1)), "--data", dataDir]);
  await third.ready;
  await until("the notice", () => third.lines().length > 5);
  assert.match(third.lines()[5], new RegExp(`^\\d\\d:\\d\\d:\\d\\d The data folder's lock was left by an emulator that is no longer running \\(process ${first.pid}, `));
});

test("the command line stops on Ctrl+C or SIGTERM: the BUSY Bar shuts down, the folder is let go of, the exit code of the signal", { skip: windows && "Windows has no signals to send to a process" }, async (t) => {
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const dataDir = tempDir(t);
    const cli = commandLine(t, ["--port", String(port(0)), "--data", dataDir]);
    const base = `http://127.0.0.1:${portOf(await cli.ready)}`;
    await installApp(base, "app.test.signal", "setInterval(function () {}, 1000);");
    assert.ok(existsSync(join(dataDir, "run", "server.lock")));
    cli.kill(signal);
    assert.equal(await cli.exited(), code, signal);
    assert.ok(!existsSync(join(dataDir, "run", "server.lock")), `${signal}: the lock is let go of`);
    assert.equal(cli.stderr_(), "");
  }
});

test("the command line on a folder of a newer format: one line that says why, exit code 1, the folder untouched", async (t) => {
  const dataDir = tempDir(t);
  writeFileSync(join(dataDir, "format"), "7\n");
  const before = snapshot(dataDir);
  const cli = commandLine(t, ["--port", String(port(0)), "--data", dataDir]);
  assert.equal(await cli.exited(), 1);
  assert.equal(cli.stderr_(), `The data folder ${dataDir} is of format 7: a newer emulator made it, and this one knows format ${FORMAT} at most. It is left as it is. Use the newer emulator with it, or name another data folder.\n`);
  assert.deepEqual(cli.lines(), []);
  assert.deepEqual(snapshot(dataDir), before);
});
