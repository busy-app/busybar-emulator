// The project commands' answers, against a stand-in for the system: the trust flow (nothing on the command line
// trusts a folder: not --trust, not with a terminal either), the hints (which name the folder as given), and what a
// failure of the tools is told as. Brought in from the reviews of EMU-206/EMU-217 (R1, R2, M4, M5), their tails, and
// the security review of pull request 59. No network, no Node of the tools is started.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadCommands, main } from "../busy-emulator.mjs";
import { resolveContext } from "../context.mjs";
import { isTrusted, trustFile, trustProject } from "../../projects/trust.mjs";
import { noteDependencies, rememberProject } from "../../projects/registry.mjs";
import { ensureDependencies } from "../project.mjs";

const commands = await loadCommands();

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-project-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const ctx = {
    platform: "darwin",
    kind: "release",
    development: false,
    dataDir,
    runStateFile: path.join(dataDir, "run", "emulator.json"),
    calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"],
    testLaunch: null,
    nodeTools: { node: "/x/node", npmCli: "/x/npm-cli.js", npxCli: "/x/npx-cli.js", nodeDir: "/x" },
    env: {},
  };
  return { root, ctx };
}

async function call(argv, ctx, sys) {
  const out = [];
  const code = await main([...argv, "--json"], { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
  return { code, json: JSON.parse(out.at(-1)) };
}

/** A project of the official template made by hand: package.json naming @busy-app/cli, with or without busy-cli. */
function handMadeProject(dir, { installed = false } = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  if (installed) {
    const cli = path.join(dir, "node_modules", "@busy-app", "cli");
    mkdirSync(path.join(cli, "dist"), { recursive: true });
    writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
    writeFileSync(path.join(cli, "dist", "index.js"), "");
  }
  return realpathSync(dir);
}

const ran = () => {
  const calls = [];
  return { calls, runTool: async (_setup, request) => (calls.push(request), { code: 0, signal: null, output: "" }) };
};

// ---------------------------------------------------------------- trust: only the person gives it (M4)

test("--trust trusts nothing, with a terminal or without: trust_needs_person, nothing trusted, nothing run", async (t) => {
  const { root, ctx } = setup(t);
  const project = handMadeProject(path.join(root, "stranger"), { installed: true });
  const tools = ran();
  // atTerminal: what the command line once took for a person. A pseudo-terminal gives it to any program
  // (`script -q /dev/null busy-emulator build <folder> --trust`), so it is not asked any more.
  for (const terminal of [false, true]) {
    const sys = { cwd: () => root, atTerminal: () => terminal, ...tools };
    const refused = await call(["build", "stranger"], ctx, sys);
    assert.equal(refused.code, 1);
    assert.equal(refused.json.code, "untrusted_project");
    // The message says in one line why: nobody's create made it. The hint names the command that asks the person
    // (trust <folder>) and nothing that would trust the folder from the command line.
    assert.match(refused.json.message, /stranger is not trusted: it was not created by this emulator's create /);
    assert.match(refused.json.hint, /^Run \S+ trust stranger: the emulator asks the person, in a dialog on their screen, whether they trust the folder; then run \S+ build stranger again\. The emulator must be running for it: if it is not, run \S+ start first\.$/);
    assert.match(refused.json.ask, / trust stranger$/);
    for (const command of ["build", "install", "run", "stop", "dev", "typecheck"]) {
      const self = await call([command, "stranger", "--trust"], ctx, sys);
      assert.equal(self.code, 1, command);
      assert.equal(self.json.code, command === "typecheck" ? "no_typecheck" : "trust_needs_person", command);
      if (command === "typecheck") continue;
      assert.equal(self.json.folder, project);
      assert.match(self.json.message, /^--trust trusts nothing: a folder is trusted only by the person's click in the emulator's own dialog/);
      assert.match(self.json.hint, /^Run \S+ trust stranger: the emulator asks the person/);
      assert.doesNotMatch(self.json.hint + refused.json.hint, /--trust/, "no hint names --trust");
    }
  }
  assert.equal(isTrusted(ctx.dataDir, project), false);
  assert.deepEqual(tools.calls, [], "no tool ran");
});

test("a trusted project builds, with --trust or without: the option changes nothing", async (t) => {
  const { root, ctx } = setup(t);
  const project = handMadeProject(path.join(root, "theirs"), { installed: true });
  trustProject(ctx.dataDir, project, "trusted", { platform: ctx.platform });
  const tools = ran();
  const sys = { cwd: () => project, ...tools };
  for (const words of [["build"], ["build", "--trust"]]) {
    const built = await call(words, ctx, sys);
    assert.equal(built.code, 0, JSON.stringify(built.json));
    assert.equal(built.json.trusted, "before");
    assert.equal(tools.calls.at(-1).args.at(-1), "build");
  }
});

test("no command's usage or help names --trust, and the command line reads no terminal switch", async () => {
  for (const command of commands) assert.doesNotMatch(`${command.usage} ${command.summary}`, /--trust/, command.name);
  const env = { BUSY_EMULATOR_TEST_TERMINAL: "1" };
  for (const scriptPath of ["/A/BUSY Bar Emulator.app/Contents/Resources/emulator/packages/server/cli/busy-emulator.mjs", "/src/emulator/packages/server/cli/busy-emulator.mjs"]) {
    const context = resolveContext({ env, platform: "darwin", homeDir: "/h", scriptPath, execPath: "/n", nodeVersion: "24", read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); }, exists: () => true });
    assert.equal("testTerminal" in context, false);
  }
});

// ---------------------------------------------------------------- hints name the folder as given (R1)

test("R1: the hints of a command given a folder name that folder, so that they act on the same project", async (t) => {
  const { root, ctx } = setup(t);
  handMadeProject(path.join(root, "other project"));
  const here = handMadeProject(path.join(root, "here"));
  const sys = { cwd: () => here, ...ran() };
  const untrusted = await call(["build", "../other project"], ctx, sys);
  assert.equal(untrusted.json.code, "untrusted_project");
  assert.match(untrusted.json.hint, /^Run \S+ trust '\.\.\/other project': .* then run \S+ build '\.\.\/other project' again\./);
  // The person trusted it (their click in the emulator's dialog writes the list). install, run and stop: the
  // dependencies are missing; then the emulator is not running.
  trustProject(ctx.dataDir, path.join(root, "other project"), "trusted", { platform: ctx.platform });
  const missing = await call(["install", "../other project"], ctx, sys);
  assert.equal(missing.json.code, "no_dependencies");
  assert.match(missing.json.hint, / build '\.\.\/other project' first/);
  const failedInstall = await call(["build", "../other project"], ctx, { ...sys, runTool: async () => ({ code: 1, signal: null, output: "npm error code E404\nnpm error 404 Not Found\n" }) });
  assert.equal(failedInstall.json.code, "tool_failed");
  assert.match(failedInstall.json.hint, / build '\.\.\/other project' again\.$/);
});

test("R1: not_running names the folder too", async (t) => {
  const { root, ctx } = setup(t);
  const project = handMadeProject(path.join(root, "far away"), { installed: true });
  const sys = { cwd: () => root, ...ran(), readRunState: () => ({ missing: true }), probe: async () => ({ answering: false, code: "ECONNREFUSED" }) };
  trustProject(ctx.dataDir, project, "trusted", { platform: ctx.platform });
  const answer = await call(["run", "far away"], ctx, sys);
  assert.equal(answer.json.code, "not_running");
  assert.match(answer.json.hint, / start, then run .* run 'far away' again\.$/);
});

// ---------------------------------------------------------------- create (R2, M5)

/** The generator's install, the generator, then the project's install answered by `last`. */
function createSystem(root, target, last) {
  let n = 0;
  return {
    cwd: () => root,
    async runTool(_setup, request) {
      n += 1;
      if (n === 1) {
        const pkg = path.join(request.cwd, "node_modules", "@busy-app", "create-app");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.5.0", bin: { "create-app": "dist/index.js" } }));
        return { code: 0, signal: null, output: "" };
      }
      if (n === 2) {
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
        return { code: 0, signal: null, output: "" };
      }
      return last;
    },
  };
}

test("R2: create whose dependencies cannot be installed says where the project is and that build goes on", async (t) => {
  const outputs = {
    network_failed: "npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/rolldown failed, reason: read ETIMEDOUT\n",
    blocked_network: "npm error code EPERM\nnpm error errno EPERM\nnpm error FetchError: request to https://registry.npmjs.org/rolldown failed, reason: \n",
    tool_failed: "npm error code ERESOLVE\nnpm error ERESOLVE could not resolve\n",
  };
  for (const [code, output] of Object.entries(outputs)) {
    const { root, ctx } = setup(t);
    const target = path.join(root, "my app");
    const first = await call(["create", "my app", "--author", "X"], ctx, createSystem(root, target, { code: 1, signal: null, output }));
    assert.equal(first.json.code, code);
    assert.equal(first.json.folder, realpathSync(target));
    assert.match(first.json.hint, /^The project is created in .*my app, without its dependencies/);
    assert.match(first.json.hint, / build 'my app'[;:,]? /);
    // And build, which the hint names, may build it: the emulator made it.
    assert.equal(isTrusted(ctx.dataDir, target), true);
  }
});

test("M5: a double quote, a backslash or a control character in --author, --name or --description is refused before anything runs", async (t) => {
  const { root, ctx } = setup(t);
  for (const [flag, value] of [["--description", 'Shows the "focus" time'], ["--author", "a\\b"], ["--name", "two\nlines"], ["--description", "tab\there"]]) {
    const tools = ran();
    const words = ["create", "quoted", ...(flag === "--author" ? [] : ["--author", "X"]), flag, value];
    const answer = await call(words, ctx, { cwd: () => root, ...tools });
    assert.equal(answer.code, 2, JSON.stringify(answer.json));
    assert.equal(answer.json.code, "usage");
    assert.match(answer.json.message, new RegExp(`^${flag} may not hold a double quote`));
    assert.deepEqual(tools.calls, []);
    assert.ok(!existsSync(path.join(root, "quoted")));
  }
  assert.ok(!existsSync(trustFile(ctx.dataDir)));
});

// ---------------------------------------------------------------- what a tool's end is told as

test("a tool stopped by Ctrl+C is interrupted, not failed; npm's stack lines stay out of the output", async (t) => {
  const { root, ctx } = setup(t);
  trustProject(ctx.dataDir, handMadeProject(path.join(root, "p")), "trusted", { platform: ctx.platform });
  const sys = { cwd: () => root, runTool: async () => ({ code: null, signal: "SIGINT", output: "" }) };
  const stopped = await call(["build", "p"], ctx, sys);
  assert.equal(stopped.code, 1);
  assert.equal(stopped.json.code, "interrupted");
  assert.match(stopped.json.message, /was stopped \(SIGINT\)/);
  assert.doesNotMatch(stopped.json.hint, /Fix what/);
  const stack = "npm error code E500\nnpm error 500 Internal Server Error\nnpm error     at ClientRequest.<anonymous> (/x/minipass-fetch/lib/index.js:130:14)\nnpm error     at ClientRequest.emit (node:events:519:28)\n";
  const failed = await call(["build", "p"], ctx, { ...sys, runTool: async () => ({ code: 1, signal: null, output: stack }) });
  assert.equal(failed.json.code, "tool_failed");
  assert.equal(failed.json.output, "npm error code E500\nnpm error 500 Internal Server Error");
});

test("create says the project it made is trusted", async (t) => {
  const { root, ctx } = setup(t);
  const target = path.join(root, "made");
  const sys = createSystem(root, target, null);
  const last = sys.runTool;
  let n = 0;
  sys.runTool = async (s, request) => {
    n += 1;
    if (n < 3) return last(s, request);
    const cli = path.join(target, "node_modules", "@busy-app", "cli");
    mkdirSync(path.join(cli, "dist"), { recursive: true });
    writeFileSync(path.join(cli, "package.json"), JSON.stringify({ bin: { "busy-cli": "dist/index.js" } }));
    writeFileSync(path.join(cli, "dist", "index.js"), "");
    return { code: 0, signal: null, output: "" };
  };
  const made = await call(["create", "made", "--author", "X"], ctx, sys);
  assert.equal(made.code, 0, JSON.stringify(made.json));
  assert.equal(made.json.trusted, "created");
  assert.deepEqual(JSON.parse(readFileSync(trustFile(ctx.dataDir), "utf8")).projects.map((entry) => entry.how), ["created"]);
});

// ---------------------------------------------------------------- create without an author anywhere (the rehearsal)

/**
 * As createSystem, with a generator that behaves as create-app 0.5 does: without --author and without a git identity
 * it refuses before it writes anything; with --author it writes the author into package.json.
 */
function authorSystem(root, target, { userName, gitAuthor = null, login = null }) {
  const generatorRuns = [];
  let n = 0;
  return {
    generatorRuns,
    cwd: () => root,
    ...(userName === undefined ? {} : { userName: () => userName }),
    // The GitHub login signed in, and git's user.name as create reads it (projects/author.mjs).
    githubLogin: () => login,
    gitUserName: () => gitAuthor,
    async runTool(_setup, request) {
      n += 1;
      if (n === 1) {
        const pkg = path.join(request.cwd, "node_modules", "@busy-app", "create-app");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.5.0", bin: { "create-app": "dist/index.js" } }));
        return { code: 0, signal: null, output: "" };
      }
      if (request.tool === "node") {
        generatorRuns.push(request.args.slice(1));
        const author = request.args.find((word) => word.startsWith("--author="))?.slice("--author=".length) ?? gitAuthor;
        if (!author) return { code: 1, signal: null, output: "┌  Creating a BUSY Bar JS app 0.5.0\n■  Author: an author is required\n" };
        mkdirSync(path.join(target, "src", "appmeta"), { recursive: true });
        writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "x", author, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
        writeFileSync(path.join(target, "src", "appmeta", "manifest.json"), JSON.stringify({ id: `app.${author.toLowerCase().replace(/\s+/g, "_")}.made`, author }));
        return { code: 0, signal: null, output: "" };
      }
      const cli = path.join(target, "node_modules", "@busy-app", "cli");
      mkdirSync(path.join(cli, "dist"), { recursive: true });
      writeFileSync(path.join(cli, "package.json"), JSON.stringify({ bin: { "busy-cli": "dist/index.js" } }));
      writeFileSync(path.join(cli, "dist", "index.js"), "");
      return { code: 0, signal: null, output: "" };
    },
  };
}

test("create without --author where git has no user.name: the account's name is the author, and the answer says so and how to change it", async (t) => {
  const { root, ctx } = setup(t);
  const sys = authorSystem(root, path.join(root, "made"), { userName: "jane" });
  const made = await call(["create", "made"], ctx, sys);
  assert.equal(made.code, 0, JSON.stringify(made.json));
  // The generator ran twice: as it is (git may name the author), then with the account's name.
  assert.equal(sys.generatorRuns.length, 2);
  assert.ok(!sys.generatorRuns[0].some((word) => word.startsWith("--author")));
  assert.deepEqual(sys.generatorRuns[1].slice(-1), ["--author=jane"]);
  assert.equal(made.json.author.name, "jane");
  assert.equal(made.json.author.from, "account");
  assert.match(made.json.author.change, /"author" in package\.json and in src\/appmeta\/manifest\.json; the app's id \(app\.jane\.made\) was made from it too.*--author "Your Name"/);
  assert.equal(JSON.parse(readFileSync(path.join(root, "made", "package.json"), "utf8")).author, "jane");
  // For a person: one line of the text.
  const out = [];
  const again = authorSystem(root, path.join(root, "made2"), { userName: "jane" });
  await main(["create", "made2"], { ctx, sys: again, commands, out: (line) => out.push(line), err: () => {} });
  assert.match(out.join("\n"), /\nAuthor: jane \(the name of your account: no --author was given, GitHub is not signed in and git has no user\.name\)\. To change it: "author" in package\.json/);
});

test("create: an account's name many computers share, one package.json cannot take, or none: nothing is made, --author is asked for and why", async (t) => {
  for (const userName of ["User", "admin", "Administrator", "OWNER", "pc", 'DOMAIN\\jane', 'ja"ne', "", null, undefined]) {
    const { root, ctx } = setup(t);
    const sys = authorSystem(root, path.join(root, "made"), { userName });
    const made = await call(["create", "made"], ctx, sys);
    assert.equal(made.json.code, "author_required", String(userName));
    assert.notEqual(made.code, 0);
    assert.match(made.json.message, /No author for the app: GitHub is not signed in, git has no user\.name.*same id in the catalog\. Nothing was created\./);
    if (["User", "admin"].includes(userName)) assert.match(made.json.message, new RegExp(`the account's name is "${userName}"`));
    assert.match(made.json.hint, /--author "your-login".*gh auth login/);
    assert.equal(made.json.option, "--author");
    assert.ok(!existsSync(path.join(root, "made", "package.json")), "nothing was made");
    // The generator ran once, without an author, and refused before it wrote anything.
    assert.equal(sys.generatorRuns.length, 1);
  }
});

test("create: git's user.name that many computers share is refused before the generator runs", async (t) => {
  const { root, ctx } = setup(t);
  const sys = authorSystem(root, path.join(root, "made"), { userName: "jane", gitAuthor: "user" });
  const made = await call(["create", "made"], ctx, sys);
  assert.equal(made.json.code, "author_required");
  assert.match(made.json.message, /git's user\.name is "user"/);
  assert.equal(sys.generatorRuns.length, 0);
});

test("create: the GitHub login signed in is the author and the id's namespace, before git's user.name and the account's name", async (t) => {
  const { root, ctx } = setup(t);
  const sys = authorSystem(root, path.join(root, "made"), { userName: "User", gitAuthor: "Git Jane", login: "Jane-Dev" });
  const out = [];
  const code = await main(["create", "made"], { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
  assert.equal(code, 0, out.join("\n"));
  assert.equal(sys.generatorRuns.length, 1);
  assert.deepEqual(sys.generatorRuns[0].slice(-1), ["--author=Jane-Dev"]);
  assert.equal(JSON.parse(readFileSync(path.join(root, "made", "src", "appmeta", "manifest.json"), "utf8")).id, "app.jane-dev.made");
  assert.match(out.join("\n"), /\nAuthor: Jane-Dev, the GitHub login signed in on this computer; the app's id \(app\.jane-dev\.made\) was made from it\./);
  // --author still comes first.
  const { root: root2, ctx: ctx2 } = setup(t);
  const sys2 = authorSystem(root2, path.join(root2, "made"), { userName: "User", login: "Jane-Dev" });
  const json = await call(["create", "made", "--author", "Jane Doe"], ctx2, sys2);
  assert.deepEqual(json.json.author, { name: "Jane Doe", from: "option", change: null });
  assert.equal(sys2.generatorRuns[0].filter((word) => word.startsWith("--author")).length, 1);
  // In JSON: from "github", nothing to change.
  const { root: root3, ctx: ctx3 } = setup(t);
  const json3 = await call(["create", "made"], ctx3, authorSystem(root3, path.join(root3, "made"), { userName: "User", login: "Jane-Dev" }));
  assert.deepEqual(json3.json.author, { name: "Jane-Dev", from: "github", change: null });
});

test("create: --author and git's user.name are used as they are, the generator runs once, and nothing is said of the author", async (t) => {
  {
    const { root, ctx } = setup(t);
    const sys = authorSystem(root, path.join(root, "made"), { userName: "jane" });
    const made = await call(["create", "made", "--author", "Jane Doe"], ctx, sys);
    assert.equal(made.code, 0, JSON.stringify(made.json));
    assert.equal(sys.generatorRuns.length, 1);
    assert.deepEqual(made.json.author, { name: "Jane Doe", from: "option", change: null });
  }
  {
    const { root, ctx } = setup(t);
    const sys = authorSystem(root, path.join(root, "made"), { userName: "jane", gitAuthor: "Git Jane" });
    const out = [];
    const code = await main(["create", "made"], { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
    assert.equal(code, 0);
    assert.equal(sys.generatorRuns.length, 1);
    assert.doesNotMatch(out.join("\n"), /Author:/);
    const { root: root2, ctx: ctx2 } = setup(t);
    const json = await call(["create", "made"], ctx2, authorSystem(root2, path.join(root2, "made"), { userName: "jane", gitAuthor: "Git Jane" }));
    assert.deepEqual(json.json.author, { name: "Git Jane", from: "git", change: null });
  }
});

test("create: another failure of the generator is not retried and comes back in its words", async (t) => {
  const { root, ctx } = setup(t);
  const sys = authorSystem(root, path.join(root, "made"), { userName: "jane" });
  const inner = sys.runTool;
  sys.runTool = async (s, request) => (request.tool === "node" ? (sys.generatorRuns.push(request.args), { code: 1, signal: null, output: "■  --id: only Latin letters\n" }) : inner(s, request));
  const failed = await call(["create", "made", "--id", "app.jane.made"], ctx, sys);
  assert.equal(failed.json.code, "tool_failed");
  assert.equal(sys.generatorRuns.length, 1);
  assert.match(failed.json.message, /only Latin letters/);
});

// ---------------------------------------------------------------- create with a folder name outside Latin (the dry run)

/**
 * A generator that names the app as create-app 0.5.0 does (suggestId): a folder name with any character outside
 * [A-Za-z0-9_-] gives the app part "app"; it writes the id and the name into the manifest, package.json, README.md and
 * AGENTS.md. Then the project's install.
 */
function generatorSystem(root) {
  return {
    cwd: () => root,
    async runTool(_setup, request) {
      if (request.tool === "npm" && request.cwd.endsWith(path.join("tools", "create-app"))) {
        const pkg = path.join(request.cwd, "node_modules", "@busy-app", "create-app");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.5.0", bin: { "create-app": "dist/index.js" } }));
        return { code: 0, signal: null, output: "" };
      }
      if (request.tool === "node") {
        const target = request.args[1];
        const option = (flag) => request.args.find((word) => word.startsWith(`${flag}=`))?.slice(flag.length + 1);
        const author = option("--author");
        const slug = path.basename(target).trim().toLowerCase().replace(/\s+/g, "_");
        const id = option("--id") ?? `app.${author}.${/^[a-zA-Z0-9_-]+$/.test(slug) ? slug : "app"}`;
        const tail = id.split(".").pop().replace(/[-_]+/g, " ");
        const name = option("--name") ?? tail.charAt(0).toUpperCase() + tail.slice(1);
        mkdirSync(path.join(target, "src", "appmeta"), { recursive: true });
        writeFileSync(path.join(target, "src", "appmeta", "manifest.json"), `${JSON.stringify({ format_version: 1, id, name, version: "0.1.0", api_version: "27.12.0", description: name, author }, null, 2)}\n`);
        writeFileSync(path.join(target, "package.json"), `${JSON.stringify({ name: "app", description: name, author, devDependencies: { "@busy-app/cli": "^0.6.0" } }, null, 2)}\n`);
        writeFileSync(path.join(target, "README.md"), `# ${name}\n\n${name}\n\nbuilds dist/${id}.tgz\n`);
        writeFileSync(path.join(target, "AGENTS.md"), `# AGENTS.md\n\nworking on \`${name}\` (\`${id}\`).\n`);
        return { code: 0, signal: null, output: "" };
      }
      const cli = path.join(request.cwd, "node_modules", "@busy-app", "cli");
      mkdirSync(path.join(cli, "dist"), { recursive: true });
      writeFileSync(path.join(cli, "package.json"), JSON.stringify({ bin: { "busy-cli": "dist/index.js" } }));
      writeFileSync(path.join(cli, "dist", "index.js"), "");
      return { code: 0, signal: null, output: "" };
    },
  };
}

const manifestIn = (dir) => JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8"));

test("create: two folders named in Cyrillic get two ids in Latin letters, and the answer says which id and name", async (t) => {
  const { root, ctx } = setup(t);
  const sys = generatorSystem(root);
  const first = await call(["create", "Привет мир", "--author", "jane"], ctx, sys);
  assert.equal(first.code, 0, JSON.stringify(first.json));
  assert.deepEqual([first.json.id, first.json.name], ["app.jane.privet_mir", "Privet mir"]);
  assert.deepEqual(first.json.naming, { from: "Привет мир", latin: true, latin_from: ["Привет мир"], mark: false, taken: [], generator: { id: "app.jane.app", name: "App" }, rewritten: true });
  assert.deepEqual([manifestIn(path.join(root, "Привет мир")).id, manifestIn(path.join(root, "Привет мир")).name], ["app.jane.privet_mir", "Privet mir"]);
  // The second one the generator would have given the same app.jane.app.
  const out = [];
  const code = await main(["create", "Мой таймер", "--author", "jane"], { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /^Created app\.jane\.moy_taymer \("Moy taymer"\) in /);
  assert.match(text, /\nId app\.jane\.moy_taymer and name "Moy taymer": put into Latin letters from "Мой таймер", since the BUSY Bar and the catalog take Latin letters only\. To change them: "id" and "name" in src\/appmeta\/manifest\.json\.\n/);
  assert.equal(manifestIn(path.join(root, "Мой таймер")).id, "app.jane.moy_taymer");
  // Greek, mixed, accents.
  for (const [folder, id] of [["Γειά σου", "app.jane.geia_sou"], ["Pomodoro таймер", "app.jane.pomodoro_taymer"], ["Café", "app.jane.cafe"]]) {
    const made = await call(["create", folder, "--author", "jane"], ctx, sys);
    assert.equal(made.json.id, id, folder);
  }
  // A Latin name stays as the generator made it, with nothing said.
  const plain = await call(["create", "foo bar", "--author", "jane"], ctx, sys);
  assert.deepEqual([plain.json.id, plain.json.name, plain.json.naming.latin, plain.json.naming.rewritten], ["app.jane.foo_bar", "Foo bar", false, false]);
});

test("create: an id another project or an app on the BUSY Bar has gets _2, and the answer says what has it", async (t) => {
  const { root, ctx } = setup(t);
  const sys = generatorSystem(root);
  mkdirSync(path.join(ctx.dataDir, "bar", "1.3.1", "ext", "user_assets", "app.jane.privet_mir"), { recursive: true });
  const made = await call(["create", "Привет мир", "--author", "jane"], ctx, sys);
  assert.equal(made.json.id, "app.jane.privet_mir_2");
  assert.equal(made.json.name, "Privet mir 2");
  assert.deepEqual(made.json.naming.taken, [{ id: "app.jane.privet_mir", by: "bar" }]);
  // The same name in another folder: the first project has app.jane.privet_mir_2 now.
  mkdirSync(path.join(root, "elsewhere"));
  const again = await call(["create", path.join("elsewhere", "Привет мир"), "--author", "jane"], ctx, sys);
  assert.equal(again.json.id, "app.jane.privet_mir_3");
  assert.deepEqual(again.json.naming.taken, [{ id: "app.jane.privet_mir", by: "bar" }, { id: "app.jane.privet_mir_2", by: "project", folder: realpathSync(path.join(root, "Привет мир")) }]);
  const out = [];
  await main(["create", "foo", "--author", "jane"], { ctx, sys, commands, out: () => {}, err: () => {} });
  await main(["create", path.join("elsewhere", "foo"), "--author", "jane"], { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
  assert.match(out.join("\n"), new RegExp(`\\napp\\.jane\\.foo is taken by the project in ${realpathSync(path.join(root, "foo")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, so this app's id is app\\.jane\\.foo_2\\. To change them: "id" and "name"`));
});

test("create: an emoji-only or very long folder name, a --name in Cyrillic, a given --id kept as it is", async (t) => {
  const { root, ctx } = setup(t);
  const sys = generatorSystem(root);
  const party = await call(["create", "🎉", "--author", "jane"], ctx, sys);
  assert.match(party.json.id, /^app\.jane\.app_[0-9a-f]{4}$/);
  assert.equal(party.json.naming.mark, true);
  const out = [];
  await main(["create", "🚀🚀", "--author", "jane"], { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
  assert.match(out.join("\n"), /\n"🚀🚀" has no letter or digit for an app's id, so the id is app\.jane\.app_[0-9a-f]{4} and the name "App [0-9a-f]{4}"\./);
  const long = await call(["create", "Привет мир Привет мир Привет мир Привет мир", "--author", "jane"], ctx, sys);
  assert.equal(long.json.id, "app.jane.privet_mir_privet_mir_p");
  const named = await call(["create", "clock", "--author", "jane", "--name", "Часы"], ctx, sys);
  assert.deepEqual([named.json.id, named.json.name, named.json.naming.latin_from], ["app.jane.clock", "Chasy", ["Часы"]]);
  const given = await call(["create", "Мой таймер", "--author", "jane", "--id", "com.jane.alarm"], ctx, sys);
  assert.deepEqual([given.json.id, given.json.name, given.json.naming.latin], ["com.jane.alarm", "Alarm", false]);
});

// ---------------------------------------------------------------- a project moved or renamed after create

test("a project moved or renamed after create: the refusal names this cause, the old place and the one command of the person; trust is not carried along", async (t) => {
  const { root, ctx } = setup(t);
  const made = handMadeProject(path.join(root, "my-app"), { installed: true });
  trustProject(ctx.dataDir, made, "created", { platform: ctx.platform });
  const tools = ran();
  const agent = { cwd: () => root, ...tools };
  assert.equal((await call(["build", "my-app"], ctx, agent)).code, 0);
  renameSync(made, path.join(root, "renamed app"));
  const moved = realpathSync(path.join(root, "renamed app"));
  tools.calls.length = 0;

  const refused = await call(["build", "renamed app"], ctx, agent);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "untrusted_project");
  assert.equal(refused.json.reason, "moved");
  assert.equal(refused.json.trusted_as, made);
  assert.equal(refused.json.folder, moved);
  assert.ok(refused.json.message.startsWith(`${moved} is the project the emulator created as ${made}; it was moved or renamed since`), refused.json.message);
  assert.match(refused.json.hint, /^Run \S+ trust 'renamed app': the emulator asks the person, in a dialog on their screen, to trust the folder at its new place; /);
  assert.ok(refused.json.hint.endsWith(` start first. (Or move the folder back to ${made}.)`), refused.json.hint);
  assert.doesNotMatch(refused.json.hint, /--trust/);

  // --trust: it trusts nothing, with the same cause said.
  const self = await call(["build", "renamed app", "--trust"], ctx, agent);
  assert.equal(self.json.code, "trust_needs_person");
  assert.equal(self.json.reason, "moved");
  assert.ok(self.json.message.includes("it was moved or renamed since"), self.json.message);
  assert.match(self.json.hint, /^Run \S+ trust 'renamed app': /);
  assert.equal(isTrusted(ctx.dataDir, moved), false);
  assert.deepEqual(tools.calls, [], "nothing of the moved project ran");

  // A terminal changes nothing: the person's way is the emulator's dialog, here as everywhere.
  const atTerminal = { ...agent, atTerminal: () => true };
  assert.equal((await call(["build", "renamed app", "--trust"], ctx, atTerminal)).json.code, "trust_needs_person");
  assert.equal(isTrusted(ctx.dataDir, moved), false);

  // Moved back, the folder is the one the emulator knows: no person needed (the hint's other way).
  const { root: root2, ctx: ctx2 } = setup(t);
  const first = handMadeProject(path.join(root2, "app"), { installed: true });
  trustProject(ctx2.dataDir, first, "created", { platform: ctx2.platform });
  renameSync(first, path.join(root2, "elsewhere"));
  const agent2 = { cwd: () => root2, ...ran() };
  assert.equal((await call(["build", "elsewhere"], ctx2, agent2)).json.reason, "moved");
  renameSync(path.join(root2, "elsewhere"), first);
  assert.equal((await call(["build", "app"], ctx2, agent2)).code, 0);
});

test("a folder the emulator never knew is not called moved: a stranger's project at a trusted folder's old path, a copy", async (t) => {
  const { root, ctx } = setup(t);
  const made = handMadeProject(path.join(root, "my-app"), { installed: true });
  trustProject(ctx.dataDir, made, "created", { platform: ctx.platform });
  renameSync(made, path.join(root, "my-app-old"));
  handMadeProject(path.join(root, "my-app"), { installed: true });
  const refused = await call(["build", "my-app"], ctx, { cwd: () => root, ...ran() });
  assert.equal(refused.json.code, "untrusted_project");
  assert.equal(refused.json.reason, "unknown_folder");
  assert.equal(refused.json.trusted_as, undefined);
  assert.match(refused.json.message, /was not created by this emulator's create/);
  assert.match(refused.json.hint, /^Run \S+ trust my-app: the emulator asks the person/);
});

// ---------------------------------------------------------------- a build that fails on Windows' tar.exe

test("build and dev --once say the same about a project whose path Windows' tar.exe cannot take", async (t) => {
  const { root, ctx } = setup(t);
  // busy-cli's own words for it, which name neither tar.exe's limit nor the way out.
  const output = "Building...\nError: Command failed: tar -czf dist/app.x.tgz -C dist app.x\ntar.exe: could not chdir to 'dist'\n";
  const way = /Windows' own tar\.exe, which takes no path with letters outside the system's code page: move the project to a folder whose path has only Latin letters\./;
  const app = "/Applications/BUSY Bar Emulator.app";
  const state = { pid: 4242, exe: app, started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };
  let clock = 0;
  const sys = {
    cwd: () => root,
    runTool: async () => ({ code: 1, signal: null, output }),
    // dev needs a running emulator and the bar's console; build needs neither.
    readRunState: () => ({ state }),
    alive: () => true,
    probe: async () => ({ answering: true }),
    processInfo: () => ({ start: 999_500, exe: app }),
    samePath: () => true,
    followConsole: () => ({ opened: Promise.resolve({}), close() {} }),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  };
  const windows = { ...ctx, platform: "win32", appPath: app };
  for (const [folder, known] of [["Φάκελος", true], ["project", false]]) {
    trustProject(ctx.dataDir, handMadeProject(path.join(root, folder), { installed: true }), "trusted", { platform: ctx.platform });
    for (const command of [["build", folder], ["dev", folder, "--once"]]) {
      const failed = await call(command, windows, sys);
      assert.equal(failed.code, 1, command.join(" "));
      assert.equal(failed.json.code, "tool_failed", JSON.stringify(failed.json));
      if (known) assert.match(failed.json.hint, way, command.join(" "));
      else assert.match(failed.json.hint, /^Fix what busy-cli says, then run /, command.join(" "));
    }
  }
  // Not on macOS, where busy-cli packs with a tar that takes any path.
  const mac = await call(["dev", "Φάκελος", "--once"], { ...ctx, appPath: app }, sys);
  assert.match(mac.json.hint, /^Fix what busy-cli says/);
});

test("a build or install is refused while another process installs the same project's dependencies", async (t) => {
  const { root, ctx } = setup(t);
  const dir = path.join(root, "app");
  mkdirSync(path.join(dir, "node_modules", "@busy-app", "cli", "dist"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  // npm has already laid down busy-cli and is still writing the rest: without the refusal the build goes on over it
  writeFileSync(path.join(dir, "node_modules", "@busy-app", "cli", "package.json"), JSON.stringify({ name: "@busy-app/cli", bin: { "busy-cli": "dist/cli.js" } }));
  writeFileSync(path.join(dir, "node_modules", "@busy-app", "cli", "dist", "cli.js"), "");
  rememberProject(ctx.dataDir, dir);
  // another live process of ours: the test runner's parent
  noteDependencies(ctx.dataDir, dir, { state: "installing", pid: process.ppid, at: new Date().toISOString() });
  await assert.rejects(ensureDependencies(ctx, {}, { dir }, () => {}), (e) => e.code === "install_running" && e.extra.pid === process.ppid);
  // the same note of a process that is gone is an interrupted install: the next command installs again (it goes on to npm, which this stand-in does not run)
  noteDependencies(ctx.dataDir, dir, { state: "installing", pid: 2 ** 22 - 3, at: new Date().toISOString() });
  await assert.rejects(ensureDependencies(ctx, {}, { dir }, () => {}), (e) => e.code !== "install_running");
});
