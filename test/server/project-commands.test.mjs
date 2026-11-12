// busy-emulator create, build, install, run and stop (EMU-217), the command line itself, as an author without a Node
// of their own runs it: the app laid out as the packaging lays it out, its command line called through its launcher
// from the system's shells (zsh on macOS; cmd, PowerShell and Git Bash on Windows), with a node, npm and npx on PATH
// that fail if anything runs them, and a home of the test's. The emulator is a server this test starts, with a
// stand-in of the app's mirror naming this process (as test/server/screenshot.test.mjs does).
//
// The first test needs the npm registry (the template and its dependencies). The others run a project whose busy-cli
// is a stand-in that prints how it was called, without the network.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { layOutApp } from "../../packages/app/test/fixtures/layout.mjs";
import { spawnProgram } from "../../packages/engine/programs.mjs";
import { isGenericAuthor } from "../../packages/server/projects/author.mjs";
import { personEnvironment, poisonedFolder } from "../../packages/server/projects/test/test-support.mjs";
import { isTrusted, trustFile, trustProject } from "../../packages/server/projects/trust.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, port, tempDir, until } from "./helpers.mjs";

after(finish);

const windows = process.platform === "win32";
const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const CMD = join(SYSTEM_ROOT, "System32", "cmd.exe");
const POWERSHELL = join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const GIT_BASH = join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe");
const ID = "app.emu.cmd_e2e";

let folder;
let app;
let emulator;
let data;
let home;
let poison;
const logLines = [];

before(async () => {
  folder = realpathSync(tempDir({ after: () => {} }));
  app = await layOutApp(join(folder, "app"));
  emulator = await startServer({ port: port(0), dataDir: join(folder, "bar"), barSpeed: false, log: (line) => logLines.push(line) });
  // The command line's data folder, with the mirror the app would write, naming this process as the app.
  data = join(folder, "data");
  mkdirSync(join(data, "run"), { recursive: true });
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
  home = join(folder, "home");
  mkdirSync(home);
  poison = poisonedFolder(folder);
});
after(async () => {
  await emulator?.stop();
});

/** The environment of the author's shell: no Node of theirs, the test's home, this test's data folder and bar. */
function shellEnvironment(extra = {}) {
  return { ...personEnvironment(home, poison), BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(emulator.port), CLI: app.launcher, ...extra };
}

/**
 * The person trusted the folder: what their click in the emulator's dialog leaves in the list of trusted folders
 * (the server writes it; test/server/agent-hands.test.mjs and packages/app/test/app/trust.test.mjs go the whole
 * way through `busy-emulator trust`). Nothing on the command line trusts a folder, so these tests cannot either.
 */
function personTrusts(project, dataDir = data) {
  trustProject(dataDir, project, "trusted");
  return project;
}

/**
 * Runs the launcher with `words` from a shell, in `cwd`, as a person types it there. `shell`: "zsh" (macOS), "cmd",
 * "powershell", "bash" (Git Bash; Windows). Not spawnSync: the bar answers from this process, which must keep
 * running meanwhile. Resolves { code, stdout, stderr, json }.
 */
async function cli(shell, words, cwd, env = shellEnvironment()) {
  const quoted = {
    zsh: (word) => `'${word.replace(/'/g, `'\\''`)}'`,
    bash: (word) => `'${word.replace(/'/g, `'\\''`)}'`,
    cmd: (word) => `"${word}"`,
    powershell: (word) => `'${word.replace(/'/g, "''")}'`,
  }[shell];
  const line = words.map(quoted).join(" ");
  let child;
  if (shell === "zsh") child = spawnProgram("/bin/zsh", ["-f", "-c", `"$CLI" ${line}`], { cwd, env });
  else if (shell === "bash") child = spawnProgram(GIT_BASH, ["-c", `"$CLI" ${line}`], { cwd, env: { ...env, CLI: app.launcher.replaceAll("\\", "/") } });
  else if (shell === "cmd") child = spawnProgram(CMD, ["/d", "/s", "/c", `""${app.launcher}" ${line}"`], { cwd, env, windowsVerbatimArguments: true });
  else child = spawnProgram(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", `& $env:CLI ${line}; exit $LASTEXITCODE`], { cwd, env });
  const run = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (text) => (run.stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (run.stderr += text));
  run.status = await new Promise((resolve, reject) => child.on("error", reject).on("close", resolve));
  const last = run.stdout.trim().split(/\r?\n/).pop();
  const json = words.includes("--json") && last ? JSON.parse(last) : null;
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

const shells = windows ? ["cmd", "powershell", ...(existsSync(GIT_BASH) ? ["bash"] : [])] : ["zsh"];
const shellFor = (n) => shells[n % shells.length];

const front = async () => (await get(`${emulator.url}/api/screen?display=0`)).text;
const lit = (frame) => Buffer.from(frame, "base64").some((byte) => byte !== 0);
const row = (frame, n) => Buffer.from(frame, "base64").subarray(n * 72 * 3, (n + 1) * 72 * 3).toString("base64");

test("create, build, install, run and stop from the shells, on the bundled Node: the BUSY Bar shows the template's frame", async () => {
  const workspace = join(folder, "workspace");
  mkdirSync(workspace);
  // Letters outside Latin on macOS; spaces only on Windows, whose tar.exe busy-cli packs with takes no other (issue 4).
  const name = windows ? "my first app" : "Φάκελος app プロジェクト";

  // No --author, and the home of the test has no git identity and no GitHub sign-in (the release rehearsal's finding:
  // an agent's shell, a new computer): the author is the account's name, said in the answer, not a failure; unless
  // that name is one many computers share ("User" on the Windows machine), or package.json cannot take it: then
  // nothing is made and --author is asked for (the release dry run, 12.11).
  const account = userInfo().username;
  const refused = /["\\\u0000-\u001f\u007f]/.test(account) || !account.trim() || isGenericAuthor(account);
  if (refused) {
    const asked = await cli(shellFor(0), ["create", name, "--id", ID, "--json"], workspace);
    assert.equal(asked.json?.code, "author_required", asked.stdout + asked.stderr);
    assert.ok(!existsSync(join(workspace, name, "package.json")), "nothing was made");
  }
  const created = await cli(shellFor(0), ["create", name, "--id", ID, "--json", ...(refused ? ["--author", "Emulator Test"] : [])], workspace);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.deepEqual([created.json.author.name, created.json.author.from], refused ? ["Emulator Test", "option"] : [account.trim(), "account"]);
  if (!refused) assert.match(created.json.author.change, /"author" in package\.json/);
  assert.equal(JSON.parse(readFileSync(join(workspace, name, "package.json"), "utf8")).author, created.json.author.name);
  assert.ok(!existsSync(poison.mark), "a node, npm or npx from PATH ran");
  const project = realpathSync(join(workspace, name));
  assert.equal(created.json.folder, project);
  assert.equal(created.json.id, ID);
  assert.equal(created.json.generator.name, "@busy-app/create-app");
  assert.match(created.json.generator.version, /^0\.5\./);
  assert.equal(created.json.fix, windows ? "patched" : "not-needed");
  assert.equal(created.json.next.length, 3);
  assert.ok(existsSync(join(project, "node_modules", "@busy-app", "cli")));
  assert.equal(created.stderr, "", "--json says nothing on stderr");
  // The emulator made it, so it is trusted.
  assert.deepEqual(JSON.parse(readFileSync(trustFile(data), "utf8")).projects.map((entry) => [entry.path, entry.how]), [[project, "created"]]);

  const built = await cli(shellFor(1), ["build", "--json"], project);
  assert.equal(built.code, 0, built.stdout + built.stderr);
  assert.equal(built.json.package, join(project, "dist", `${ID}.tgz`));
  assert.equal(built.json.dependencies, "present");
  assert.match(built.json.output, /Done → dist[\\/]app\.emu\.cmd_e2e\.tgz/);

  const before = await front();
  // From the workspace, the project named: the folder argument.
  const installed = await cli(shellFor(2), ["install", name, "--json"], workspace);
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  assert.equal(installed.json.address, `127.0.0.1:${emulator.port}`);
  assert.ok(logLines.some((line) => line.includes(`Installed ${ID}`)), logLines.join("\n"));

  const ran = await cli(shellFor(3), ["run"], project);
  assert.equal(ran.code, 0, ran.stdout + ran.stderr);
  // run watched the app for its first second: the template's app keeps running.
  assert.match(ran.stdout, new RegExp(`Started ${ID.replaceAll(".", "\\.")} on the emulated BUSY Bar at 127\\.0\\.0\\.1:${emulator.port}; it is running\\.`));
  assert.match(ran.stderr, /busy-cli app run --addr 127\.0\.0\.1:/, "a person sees what runs");

  // "Hello" over a counter that rises every second: the title rows stay, only counter rows (9 and below) change.
  await until("the app's frame", async () => {
    const frame = await front();
    return frame !== before && lit(frame);
  }, 15000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const first = await front();
  let second;
  await until("the counter's next value", async () => (second = await front()) !== first, 15000);
  const changed = Array.from({ length: 16 }, (_, n) => n).filter((n) => row(first, n) !== row(second, n));
  assert.ok(changed.length && changed.every((n) => n >= 9), `rows that changed: ${changed}`);
  assert.ok(Array.from({ length: 9 }, (_, n) => n).filter((n) => lit(row(first, n))).length >= 5, "the title is drawn");

  const stopped = await cli(shellFor(4), ["stop", "--json"], project);
  assert.equal(stopped.code, 0, stopped.stdout + stopped.stderr);
  await until("the app's frame gone", async () => (await front()) !== second, 15000);

  assert.ok(!existsSync(poison.mark), "a node, npm or npx from PATH ran");
  // Nothing of npm, Node or the tools in the home: npm's cache is in the data folder. On Windows the shells keep their
  // own files there (PowerShell's start-up data, the shell's caches), which are not this test's to judge.
  const written = readdirSync(home, { recursive: true }).map((name) => name.replaceAll("\\", "/"));
  if (windows) assert.deepEqual(written.filter((name) => /npm|node|busy|vite|rolldown|\.cache/i.test(name)), [], written.join(", "));
  else assert.deepEqual(written, [], "nothing written into the home");
});

// ------------------------------------------------------------------------------------- a stand-in busy-cli, offline

/** A project whose busy-cli prints how it was called and ends with STAND_IN_EXIT (0 unless set). */
function standInProject(parent, name = "stand-in") {
  const dir = join(parent, name);
  const cliDir = join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(join(cliDir, "dist"), { recursive: true });
  mkdirSync(join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "stand-in", private: true, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.emu.stand_in" }));
  writeFileSync(join(cliDir, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", type: "module", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(
    join(cliDir, "dist", "index.js"),
    [
      // Its words as busy-cli reads them (written so that the check of command lines does not take this file for one).
      `console.log(JSON.stringify({ args: ${["process", "argv"].join(".")}.slice(2), cwd: process.cwd(), node: process.execPath }));`,
      "if (process.env.STAND_IN_MARK) (await import('node:fs')).writeFileSync(process.env.STAND_IN_MARK, 'the project\\'s busy-cli ran');",
      "const code = Number(process.env.STAND_IN_EXIT || 0);",
      "if (code) console.error('■  Nothing to install: there is no dist/app.emu.stand_in.tgz.');",
      "process.exitCode = code;",
    ].join("\n"),
  );
  return realpathSync(dir);
}

test("a project the emulator did not create is built only after the person trusted it; --trust trusts nothing", async () => {
  const project = standInProject(join(folder, "elsewhere"));
  const refused = await cli(shells[0], ["build", "--json"], project);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "untrusted_project");
  assert.equal(refused.json.folder, project);
  assert.match(refused.json.hint, /^Run .*?busy-emulator(?:\.exe)?'? trust (?:\.|"\."): the emulator asks the person/);
  assert.doesNotMatch(refused.json.hint, /--trust/);
  const flag = await cli(shells[0], ["build", "--trust", "--json"], project);
  assert.equal(flag.code, 1, flag.stdout + flag.stderr);
  assert.equal(flag.json.code, "trust_needs_person");
  assert.equal(isTrusted(data, project), false);
  personTrusts(project);
  const again = await cli(shells[0], ["build", "--json"], project);
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.equal(again.json.trusted, "before");
  // What ran: the project's own busy-cli, on the bundled Node, in the project's folder.
  const called = JSON.parse(again.json.output.split("\n").find((line) => line.startsWith("{")));
  assert.deepEqual(called.args, ["build"]);
  assert.equal(realpathSync(called.cwd), project);
  assert.equal(realpathSync(called.node), realpathSync(app.node));
});

test("install, run and stop pass the emulator's address; busy-cli's failure comes back in its words, with its code", async () => {
  const project = personTrusts(standInProject(join(folder, "addressed")));
  // A built package, so that run has what to install: it installs first, then starts the app.
  mkdirSync(join(project, "dist"));
  writeFileSync(join(project, "dist", "app.emu.stand_in.tgz"), "");
  for (const [n, name] of ["install", "run", "stop"].entries()) {
    const done = await cli(shellFor(n), [name, project, "--json"], folder);
    assert.equal(done.code, 0, done.stdout + done.stderr);
    const called = done.json.output.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line).args);
    const address = ["--addr", `127.0.0.1:${emulator.port}`];
    assert.deepEqual(called, name === "run" ? [["app", "install", ...address], ["app", "run", ...address]] : [["app", name, ...address]]);
  }
  const failed = await cli(shells[0], ["install", "--json"], project, shellEnvironment({ STAND_IN_EXIT: "3" }));
  assert.equal(failed.code, 1);
  assert.equal(failed.json.code, "tool_failed");
  assert.equal(failed.json.tool, "busy-cli app install");
  assert.equal(failed.json.exit_code, 3);
  assert.match(failed.json.message, /failed with exit code 3:[\s\S]*Nothing to install/);
  assert.match(failed.json.hint, /build/);
});

test("no emulator: not_running with the hint to start it, and busy-cli is not run", async () => {
  const project = standInProject(join(folder, "nobody"));
  const other = join(folder, "data-without-emulator");
  mkdirSync(other);
  personTrusts(project, other);
  const env = shellEnvironment({ BUSY_EMULATOR_DATA: other, BUSY_EMULATOR_PORT: "1" });
  for (const name of ["install", "run", "stop"]) {
    const answer = await cli(shells[0], [name, project, "--json"], folder, env);
    assert.equal(answer.code, 1, answer.stdout);
    assert.equal(answer.json.code, "not_running");
    assert.match(answer.json.hint, / start/);
    assert.equal(answer.json.output, undefined, "busy-cli did not run");
  }
});

test("wrong calls and wrong folders: usage, not_a_project, folder_not_empty", async () => {
  const empty = join(folder, "not-a-project");
  mkdirSync(empty);
  writeFileSync(join(empty, "notes.txt"), "x");
  const usage = await cli(shells[0], ["create", "--json"], folder);
  assert.equal(usage.code, 2);
  assert.equal(usage.json.code, "usage");
  const notProject = await cli(shells[0], ["build", "--json"], empty);
  assert.equal(notProject.code, 1);
  assert.equal(notProject.json.code, "not_a_project");
  assert.match(notProject.json.message, /it has no package\.json/);
  const missing = await cli(shells[0], ["run", "no such folder", "--json"], folder);
  assert.equal(missing.json.code, "not_a_project");
  const taken = await cli(shells[0], ["create", "not-a-project", "--json"], folder);
  assert.equal(taken.code, 1);
  assert.equal(taken.json.code, "folder_not_empty");
  assert.deepEqual(readdirSync(empty), ["notes.txt"]);
});

// The sandbox of a desktop agent (macOS sandbox-exec, the mechanism under them): the command names it, rather than
// saying the emulator is not running or the registry is down (ADR-0010, EMU-157).
const SANDBOX = "/usr/bin/sandbox-exec";
const noSandbox = (process.platform !== "darwin" || !existsSync(SANDBOX)) && "macOS sandbox-exec";

async function sandboxed(profile, words, cwd, env = shellEnvironment()) {
  const child = spawnProgram(SANDBOX, ["-p", profile, app.launcher, ...words], { cwd, env });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, json: JSON.parse(stdout.trim().split("\n").pop() || "null") };
}

test("in a sandbox: install that may not reach the BUSY Bar, and create whose npm may not reach the registry, say blocked_network", { skip: noSandbox }, async () => {
  const project = personTrusts(standInProject(join(folder, "sandboxed")));
  const loopback = await sandboxed('(version 1)(allow default)(deny network-outbound (remote ip "localhost:*"))', ["install", "--json"], project);
  assert.equal(loopback.json.code, "blocked_network", JSON.stringify(loopback.json));
  assert.equal(loopback.code, 1);
  assert.match(loopback.json.hint, /outside the sandbox/);
  // A data folder of its own: with npm's cache of the first test npm would install from the cache, as it does offline.
  const empty = join(folder, "data-with-no-cache");
  mkdirSync(empty);
  const registry = await sandboxed('(version 1)(allow default)(deny network-outbound (remote ip "*:*"))', ["create", "sandboxed-app", "--author", "x", "--json"], folder, shellEnvironment({ BUSY_EMULATOR_DATA: empty }));
  assert.equal(registry.json?.code, "blocked_network", JSON.stringify(registry.json));
  assert.equal(registry.code, 1);
  assert.match(registry.json.message, /may not connect to https:\/\/registry\.npmjs\.org\//);
  assert.ok(!existsSync(join(folder, "sandboxed-app")), "nothing was created");
});

// ---------------------------------------------------------------- trust (EMU-206 security review, M1, M3, M4, M2)

/** A mark the stand-in busy-cli leaves when it runs, and the environment that names it. */
function marked(name, env = shellEnvironment) {
  const mark = join(folder, `${name}-ran`);
  return { mark, env: env({ STAND_IN_MARK: mark }) };
}

for (const how of ["deleted", "renamed"]) {
  test(`M1: a trusted folder ${how}, a stranger's project cloned to its path: build refuses it`, async () => {
    const parent = join(folder, `m1-${how}`);
    mkdirSync(parent);
    const first = personTrusts(standInProject(parent, "my-app"));
    const { mark, env } = marked(`m1-${how}`);
    const trusted = await cli(shells[0], ["build", "--json"], first, env);
    assert.equal(trusted.code, 0, trusted.stdout);
    rmSync(mark, { force: true });
    if (how === "deleted") rmSync(first, { recursive: true });
    else renameSync(first, `${first}-old`);
    const stranger = standInProject(parent, "my-app");
    const refused = await cli(shells[0], ["build", "--json"], stranger, env);
    assert.equal(refused.code, 1, refused.stdout);
    assert.equal(refused.json.code, "untrusted_project");
    assert.ok(!existsSync(mark), "the stranger's busy-cli ran");
  });
}

test("M3: install, run and stop refuse a project that is not trusted, and its busy-cli does not run", async () => {
  const project = standInProject(join(folder, "m3"));
  const { mark, env } = marked("m3");
  for (const name of ["install", "run", "stop"]) {
    const refused = await cli(shells[0], [name, "--json"], project, env);
    assert.equal(refused.code, 1, refused.stdout);
    assert.equal(refused.json.code, "untrusted_project");
    assert.ok(!existsSync(mark), `${name}: the project's busy-cli ran`);
  }
});

test("M4: --trust is refused (trust_needs_person), and the hint followed word for word trusts nothing without the person", async () => {
  const project = standInProject(join(folder, "m4"));
  const { mark, env } = marked("m4");
  const refused = await cli(shells[0], ["build", "--json"], project, env);
  assert.equal(refused.json.code, "untrusted_project");
  // The hint names the command that asks the person through the app. Followed here, where the emulator is a server
  // without the app, nobody can be asked, and nothing is trusted.
  assert.match(refused.json.hint, /^Run .*?busy-emulator(?:\.exe)?'? trust (?:\.|"\."): the emulator asks the person/);
  const asked = await cli(shells[0], ["trust", ".", "--json"], project, env);
  assert.equal(asked.code, 1, asked.stdout);
  assert.equal(asked.json.code, "trust_unavailable");
  // The option that once trusted a folder from a terminal: it trusts nothing, on any of the project commands.
  for (const name of ["build", "install", "run", "stop", "dev"]) {
    const self = await cli(shells[0], [name, "--trust", "--json"], project, env);
    assert.equal(self.code, 1, self.stdout);
    assert.equal(self.json.code, "trust_needs_person", name);
    assert.doesNotMatch(self.json.hint, /--trust/, name);
  }
  const again = await cli(shells[0], ["build", "--json"], project, env);
  assert.equal(again.json.code, "untrusted_project", "still not trusted");
  assert.ok(!existsSync(mark), "the project's busy-cli ran");
});

test("M2: create inside someone else's npm workspace runs nothing of the workspace", { skip: windows && "a sh program for git" }, async () => {
  const starter = join(folder, "starter");
  mkdirSync(join(starter, "apps"), { recursive: true });
  const mark = join(folder, "m2-ran");
  writeFileSync(join(starter, "tool.sh"), `#!/bin/sh\necho "ran as git: $*" >> '${mark}'\nexit 1\n`);
  chmodSync(join(starter, "tool.sh"), 0o755);
  writeFileSync(join(starter, "package.json"), JSON.stringify({ name: "starter", private: true, workspaces: ["apps/*"], devDependencies: { helper: "git+ssh://git@example.invalid/x/helper.git" } }));
  writeFileSync(join(starter, ".npmrc"), `git=${join(starter, "tool.sh")}\n`);
  const made = await cli(shells[0], ["create", "apps/my-app", "--author", "Tester", "--json"], starter);
  assert.equal(made.code, 0, made.stdout + made.stderr);
  assert.ok(!existsSync(mark), `the workspace's program ran: ${existsSync(mark) ? readFileSync(mark, "utf8") : ""}`);
  assert.ok(!existsSync(join(starter, "node_modules")), "nothing installed at the workspace's root");
  assert.ok(existsSync(join(starter, "apps", "my-app", "node_modules", "@busy-app", "cli")));
});
