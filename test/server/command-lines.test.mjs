// Every command line of the emulator checks its words (EMU-233): an option it does not know is a wrong call — one
// line on stderr, exit code 2, nothing done — and --help prints its help and does nothing else. Twice a server was
// started on 8640 with the user's own data folder by `index.mjs --help`, which it did not know.
//
// Each command is run with a port of the test's own and a data folder in a temporary home: a command line that
// started after all would land there, not on an emulator somebody uses.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { after, test } from "node:test";

import { finish, knownPort, node, serverDir, tempDir } from "./helpers.mjs";

after(finish);

const emulatorDir = join(serverDir, "..", "..");
const at = (path) => join(emulatorDir, ...path.split("/"));

// The command lines that check their words with packages/server/arguments.mjs (or, in the engine, by the same rules).
const CHECKED = [
  "packages/server/index.mjs",
  "packages/server/capture/png-bench.mjs",
  "packages/engine/build.mjs",
  "test/api.mjs",
  "test/convert-data-folder.mjs",
  "test/fetch.mjs",
  "test/golden.mjs",
  "test/mirror-apps.mjs",
  "test/pace.mjs",
  "test/power.mjs",
  "test/settings.mjs",
  "test/smoke.mjs",
  "test/smoke/expected.mjs",
  "test/speed.mjs",
  "test/ticks.mjs",
  "test/timed.mjs",
  "test/archives/make.mjs",
  "test/state/make.mjs",
  "test/gate.mjs",
  "tools/gate/win.mjs",
  "tools/export/export.mjs",
  "tools/release/release.mjs",
];
// Files that read process.argv and are not checked here, each with the reason.
const OTHERS = {
  "packages/server/cli/busy-emulator.mjs": "busy-emulator has a parser of its own that refuses unknown options (cli/test/commands.test.mjs)",
  "tools/catalog-registry/catalog-registry.mjs": "refuses unknown options itself; exit code 2 means a change of the registry there (its own tests)",
  "tools/export-check/export-check.mjs": "refuses unknown options itself, exit code 2 (its own tests)",
  "tools/export-check/rules.mjs": "only compares process.argv[1] with its own file",
  "tools/gate/desktop-task.mjs": "the gate's own wrapper for the app suite on Windows (gate:win --with-app): every word after it is the run's, passed on to node as given",
  "tools/canary/template-canary.mjs": "npm run canary:template, by hand before a release (not in the gate: it needs the network): takes --port <n> and --keep, refuses anything else with exit code 2 before it runs anything",
  "tools/agent-reference/agent-reference.mjs": "takes --check alone and refuses anything else, exit code 2, before it reads or writes anything",
  "tools/busy-icons/build.mjs": "refuses an unknown option or one without its value itself, exit code 2, before it reads or writes anything",
  "packages/server/test/stuck-device.test-support.mjs": "a child process of a test, started with its arguments by the test",
  "packages/engine/test/screen-driver.mjs": "a child process of a test, started with its arguments by the test",
  "packages/engine/test/imported-names.mjs": "a child process of the tests that read imports (EMU-010), given the files to read",
  "packages/engine/test/programs.test.mjs": "writes scripts that print their arguments",
  "test/server/data-folder.child.mjs": "a child process of a test, started with its arguments by the test",
  "test/server/flags.child.mjs": "a child process of a test, started with its arguments by the test",
  "test/server/lifecycle.child.mjs": "a child process of a test, started with its arguments by the test",
  "test/server/imports.test.mjs": "a test of who reads process.argv",
  "test/server/command-lines.test.mjs": "this test",
  "packages/stage/scene-build/record.mjs": "a maintainer's tool of the 3D view's scene; refuses an unknown option or one without its file itself, exit code 2, before it reads or writes anything",
  "packages/server/test/welcome.test.mjs": "a test of the first run's text for agents; the argv it names is in a stand-in script it writes for the command line, which records the words it got",
  "docs/backlog/board.mjs": "the backlog's board, not part of the emulator (only --check; left to the documents)",
};
// Folders that hold no command line of the emulator, by their path in emulator/: the app's package (its tools and
// their tests are its own), the built engine, test logs, early prototypes. Installed dependencies and hidden folders
// (data folders, .git) anywhere.
const NOT_SEARCHED = new Set(["packages/app", "packages/engine/build", "logs", "spike", "stage-prototype"]);
// The public repository has no tools/ and no docs/ (its export leaves them out, tools/export): what this test names
// there is expected only where that folder is. Where it is, every name must be there.
const inThisTree = (name) => !/^(tools|docs)\//.test(name) || existsSync(at(name.split("/")[0]));
const checked = CHECKED.filter(inThisTree);
const others = Object.keys(OTHERS).filter(inThisTree);
// What reads the words of a command line: process.argv, process["argv"], or argv taken from node:process.
const READS_ARGV = /\bprocess\s*(\.\s*argv\b|\[\s*["'`]argv["'`]\s*\])|\bargv\b[^;]*\bfrom\s*["'](node:)?process["']/;

function scripts(dir = emulatorDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    const path = relative(emulatorDir, full).split(sep).join("/");
    if (entry.isDirectory()) return NOT_SEARCHED.has(path) || entry.name === "node_modules" || entry.name.startsWith(".") ? [] : scripts(full);
    return entry.name.endsWith(".mjs") && !entry.name.startsWith("._") ? [path] : [];
  });
}

test("what reads a command line is found however it is written", () => {
  for (const text of ["process.argv.slice(2)", "process . argv", 'process["argv"]', "process['argv']", 'import { argv } from "node:process";', "import { argv, env } from 'process';"]) {
    assert.match(text, READS_ARGV, text);
  }
  for (const text of ["const argv = words;", "process.argvs", 'import { env } from "node:process";']) assert.doesNotMatch(text, READS_ARGV, text);
});

test("every script that reads its command line is checked here or named with its reason", () => {
  const reading = scripts().filter((name) => READS_ARGV.test(readFileSync(at(name), "utf8")));
  assert.deepEqual(reading.sort(), [...checked, ...others].sort());
});

/** A home of the test's own: a command line that took the user's data folder would take one in here. */
function home(t) {
  const dir = tempDir(t);
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, LOCALAPPDATA: join(dir, "AppData", "Local") };
  delete env.BUSY_EMULATOR_DATA;
  delete env.EMU_FIRMWARE;
  return { dir, env };
}

/**
 * Words that keep each command away from everything that is not the test's own, should it ever take the call after
 * all: a port and a data folder of the test's, an address where nothing answers in place of the emulator's 8640 and
 * the bar's 10.0.4.20, a build that has nothing to build from.
 */
async function safeArguments(script, dir) {
  const port = String(await knownPort());
  const nobody = `127.0.0.1:${port}`;
  const own = join(dir, "data");
  return (
    {
      "packages/server/index.mjs": ["--port", port, "--data", own],
      "test/ticks.mjs": ["--port", port, "--data", own],
      "packages/server/capture/png-bench.mjs": ["--runs", "1"],
      "packages/engine/build.mjs": ["--work", own, "--firmware-repo", own, "--emsdk", own],
      "test/api.mjs": ["--addr", nobody],
      "test/power.mjs": ["--addr", nobody],
      "test/golden.mjs": ["--emu", nobody],
      "test/timed.mjs": ["--emu", nobody],
      "test/settings.mjs": ["--emu", nobody],
      "test/speed.mjs": ["--emu", nobody],
      "test/pace.mjs": ["--emu", nobody, "--timeline", join(dir, "timeline.json")],
      "test/mirror-apps.mjs": ["--bar", nobody, "--data", own],
      "test/convert-data-folder.mjs": [own],
      "test/state/make.mjs": [join(own, "compare"), join(own, "night")],
      // Were the call taken: one quick suite; a ref that does not exist, which ends gate:win before it reaches Windows.
      "test/gate.mjs": ["--only", "board"],
      "tools/gate/win.mjs": ["--ref", "refs/heads/no-such-branch-of-this-test"],
      // Were the call taken: a name that is no repository, which the release refuses before it builds anything.
      "tools/release/release.mjs": ["--publish", "no such repository of this test"],
    }[script] ?? []
  );
}

/** Runs `node <script> <args>` from emulator/ and resolves with { code, stdout, stderr }. */
async function run(t, script, args, env) {
  const child = node(t, [at(script), ...args], { cwd: emulatorDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  const code = await child.exited(30000);
  return { code, stdout, stderr };
}

for (const script of checked) {
  const name = script.split("/").pop();
  test(`${script}: an unknown option is a wrong call, and --help prints the help`, async (t) => {
    const { dir, env } = home(t);
    const safe = await safeArguments(script, dir);
    const wrong = await run(t, script, [...safe, "--no-such-option"], env);
    assert.equal(wrong.code, 2, wrong.stderr);
    assert.equal(wrong.stdout, "");
    const self = `node ${script.split("/").join(sep)}`;
    assert.equal(wrong.stderr, `${name}: unknown option --no-such-option. ${self} --help lists what it takes.\n`);

    const help = await run(t, script, [...safe, "--help"], env);
    assert.equal(help.code, 0, help.stderr);
    assert.equal(help.stderr, "");
    assert.ok(help.stdout.trim().split("\n").length >= 2, help.stdout);
    // Nothing was started: no data folder, nothing in the home.
    assert.deepEqual(readdirSync(dir), [], "the command made nothing in the home");
  });
}

test("index.mjs --help names every option with its default, the user's data folder and the exit codes", async (t) => {
  const { dir, env } = home(t);
  const { stdout, code } = await run(t, "packages/server/index.mjs", ["--port", String(await knownPort()), "--help"], env);
  assert.equal(code, 0);
  for (const option of ["--port <port>", "--control-port <port>", "--allow-origin <origin>", "--window-origin <origin>", "--allow-local <port>", "--data <folder>", "--firmware <name>", "--fast", "--verbose", "--version", "-h, --help"]) {
    assert.ok(stdout.includes(`  ${option}`), `${option} is in the help`);
  }
  assert.match(stdout, /default 8640/);
  const firmwares = JSON.parse(readFileSync(at("packages/engine/firmware.json"), "utf8"));
  assert.ok(stdout.includes(`${Object.keys(firmwares.versions).join(", ")} (default ${firmwares.default}`), "the firmwares and the default");
  // The folder it would use here, in the test's home, and where it is on each system.
  const folder = process.platform === "win32" ? join(dir, "AppData", "Local", "BUSY Bar Emulator") : join(dir, "Library", "Application Support", "BUSY Bar Emulator");
  assert.ok(stdout.includes(`here ${folder})`), `the data folder ${folder} is named`);
  assert.match(stdout, /~\/Library\/Application Support\/BUSY Bar Emulator on macOS/);
  assert.match(stdout, /%LOCALAPPDATA%\\BUSY Bar Emulator on Windows/);
  assert.match(stdout, /Exit codes: 0 after --help or --version; 1 the server could not start[^]*; 2 a wrong call[^]*130, 143, 129/);
  assert.deepEqual(readdirSync(dir), []);
});

test("index.mjs --version prints one line and starts nothing", async (t) => {
  const { dir, env } = home(t);
  const { stdout, stderr, code } = await run(t, "packages/server/index.mjs", ["--port", String(await knownPort()), "--version"], env);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^BUSY Bar emulator server \S+ \(development\), Node \d+\.\d+\.\d+\n$/);
  assert.deepEqual(readdirSync(dir), []);
});

test("index.mjs: an option without its value, or with it after '=', is a wrong call too", async (t) => {
  const { dir, env } = home(t);
  const port = String(await knownPort());
  const data = join(dir, "data");
  for (const [args, problem] of [
    [["--port", port, "--data"], "--data needs a value"],
    [["--port", port, "--data", "--fast"], "--data needs a value"],
    [[`--port=${port}`, "--data", data], `--port=${port}: put the value after a space, --port ${port}`],
    [["--port", port, "--data", data, "extra"], "unexpected argument extra"],
    // The options of the entry's protection (EMU-009).
    [["--port", port, "--data", data, "--control-port"], "--control-port needs a value"],
    [["--port", port, "--data", data, "--allow-origin", "--fast"], "--allow-origin needs a value"],
    [["--port", port, "--data", data, "--allow-origin", "http://localhost:3000", "--allow-origin"], "--allow-origin needs a value"],
    [["--port", port, "--data", data, "--window-origin"], "--window-origin needs a value"],
    [["--port", port, "--data", data, "--allow-origin=http://localhost:3000"], "--allow-origin=http://localhost:3000: put the value after a space, --allow-origin http://localhost:3000"],
  ]) {
    const result = await run(t, "packages/server/index.mjs", args, env);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^index\\.mjs: ${problem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\. node .* --help lists what it takes\\.\\n$`));
  }
  assert.deepEqual(readdirSync(dir), []);
});

// A suite that talks to an emulator which is not there says so in one line, not with a trace (`npm test` without an
// emulator running). api.mjs and power.mjs have said so themselves before.
// pace.mjs reads its timeline before it talks to the emulator, unless it is to make one (--make).
const NEEDS_EMULATOR = ["test/golden.mjs", "test/timed.mjs", "test/settings.mjs", "test/speed.mjs", "test/pace.mjs"];
for (const script of NEEDS_EMULATOR) {
  const name = script.split("/").pop();
  test(`${script}: no emulator at the address is one line that says what the test needs`, async (t) => {
    const { dir, env } = home(t);
    const port = await knownPort();
    const option = "--emu";
    const extra = script === "test/pace.mjs" ? ["--make", "--timeline", join(dir, "timeline.json")] : [];
    const result = await run(t, script, [...extra, option, `127.0.0.1:${port}`], env);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(
      result.stderr,
      `${name}: nothing answers at 127.0.0.1:${port}, and the test needs an emulator there. Start one (node ${join("packages", "server", "index.mjs")} --port <port> --data <folder>) or name a running one with ${option} <host:port>.\n`,
    );
  });
}

for (const [script, option] of [["test/api.mjs", "--addr"], ["test/power.mjs", "--addr"]]) {
  test(`${script}: no emulator at the address is one line`, async (t) => {
    const { env } = home(t);
    const port = await knownPort();
    const result = await run(t, script, [option, `127.0.0.1:${port}`], env);
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`^No emulator at 127\\.0\\.0\\.1:${port}[^\\n]*\\n$`));
  });
}

// Words that are not options, where a command takes none: a scene's name without --only is not passed over.
test("a word that is not an option, where the suite takes none, is a wrong call", async (t) => {
  const { dir, env } = home(t);
  const result = await run(t, "test/golden.mjs", [...(await safeArguments("test/golden.mjs", dir)), "scroll"], env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^golden\.mjs: unexpected argument scroll\. /);
});

// The engine's build checks by the same rules without importing the server's code.
test("build.mjs takes runtime and screen, and nothing else that is not an option", async (t) => {
  const { dir, env } = home(t);
  const result = await run(t, "packages/engine/build.mjs", [...(await safeArguments("packages/engine/build.mjs", dir)), "runtim"], env);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^build\.mjs: unknown argument runtim \(it takes runtime, screen\)\. /);
});
