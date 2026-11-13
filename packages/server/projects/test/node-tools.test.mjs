// The project's tools on the bundled Node (EMU-206), without the network: which Node and npm run, what their
// environment holds, where npm keeps its cache, whose .npmrc it reads, and the Windows fix of busy-cli. The Node here
// is the one the test runs on (a development run's); the bundled one is run by the tests in emulator/test/projects/.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { alive, gone, hangingTool, personEnvironment, pidsIn, poisonedFolder } from "./test-support.mjs";
import {
  busyCliScript,
  CACHE_FOLDER,
  fixFontMaps,
  FONT_MAPS_BROKEN,
  FONT_MAPS_FIXED,
  installArguments,
  killTree,
  networkFailure,
  nodeToolsAt,
  npmVersion,
  plainText,
  readProject,
  runNodeTool,
  SHIM_FOLDER,
  shimFiles,
  tail,
  toolEnvironment,
  usesPnpm,
  writeShims,
} from "../node-tools.mjs";

const windows = process.platform === "win32";
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// A free port each, as the server's tests take by default; where EMU_TEST_PORTS limits the choice, the two before the
// last two (which the command line's tests take).
const LAST = process.env.EMU_TEST_PORTS ? Number(process.env.EMU_TEST_PORTS.split("-").pop()) : null;
const REGISTRY_PORT = LAST ? LAST - 2 : 0;
const PROXY_PORT = LAST ? LAST - 3 : 0;
const listen = (server, port) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
let registryPort;

const folders = [];
function temporary() {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-tools-")));
  folders.push(folder);
  return folder;
}
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const DEV_TOOLS = nodeToolsAt({ platform: process.platform, resourcesDir: null, execPath: process.execPath });

// ------------------------------------------------------------------------------------------------- where the tools are

test("a release and the test variant run the Node inside the app and its npm, by full path", () => {
  assert.deepEqual(nodeToolsAt({ platform: "darwin", resourcesDir: "/A/BUSY Bar Emulator.app/Contents/Resources", execPath: "/x/node" }), {
    node: "/A/BUSY Bar Emulator.app/Contents/Resources/node/bin/node",
    npmCli: "/A/BUSY Bar Emulator.app/Contents/Resources/node/lib/node_modules/npm/bin/npm-cli.js",
    npxCli: "/A/BUSY Bar Emulator.app/Contents/Resources/node/lib/node_modules/npm/bin/npx-cli.js",
    nodeDir: "/A/BUSY Bar Emulator.app/Contents/Resources/node/bin",
    bundled: true,
  });
  assert.deepEqual(nodeToolsAt({ platform: "win32", resourcesDir: "C:\\P\\BUSY Bar Emulator\\resources", execPath: "C:\\x\\node.exe" }), {
    node: "C:\\P\\BUSY Bar Emulator\\resources\\node\\node.exe",
    npmCli: "C:\\P\\BUSY Bar Emulator\\resources\\node\\node_modules\\npm\\bin\\npm-cli.js",
    npxCli: "C:\\P\\BUSY Bar Emulator\\resources\\node\\node_modules\\npm\\bin\\npx-cli.js",
    nodeDir: "C:\\P\\BUSY Bar Emulator\\resources\\node",
    bundled: true,
  });
});

test("a development run uses the Node it runs on and the npm installed with it", () => {
  assert.equal(DEV_TOOLS.node, process.execPath);
  assert.equal(DEV_TOOLS.bundled, false);
  assert.ok(existsSync(DEV_TOOLS.npmCli), DEV_TOOLS.npmCli);
  assert.ok(existsSync(DEV_TOOLS.npxCli), DEV_TOOLS.npxCli);
  assert.match(npmVersion(DEV_TOOLS), /^\d+\.\d+\.\d+/);
});

// ------------------------------------------------------------------------------------------------------ environment

test("the environment: no Node options, nothing of a package manager that ran the caller, the network settings kept", () => {
  const env = toolEnvironment(
    {
      PATH: "/usr/bin:/bin",
      HOME: "/h",
      NODE_OPTIONS: "--require /evil.js",
      NODE_PATH: "/x",
      npm_config_user_agent: "pnpm/9 node/v24",
      npm_config_prefix: "/elsewhere",
      npm_config_cache: "/Users/you/.npm",
      npm_config_userconfig: "/elsewhere/.npmrc",
      npm_config_globalconfig: "/elsewhere/npmrc",
      npm_config_cafile: "/corp/ca.pem",
      NODE_EXTRA_CA_CERTS: "/corp/extra.pem",
      BUSY_EMULATOR_DATA: "/someone/else",
      BUSY_EMULATOR_CLI_PATH: "/x/busy-emulator",
      npm_lifecycle_event: "build",
      npm_package_name: "x",
      npm_execpath: "/x/npm-cli.js",
      INIT_CWD: "/x",
      npm_config_registry: "https://registry.example/",
      "npm_config_@busy:registry": "https://scoped.example/",
      npm_config_https_proxy: "http://proxy.example:3128",
      HTTPS_PROXY: "http://proxy.example:3128",
    },
    { platform: "darwin", tools: { node: "/R/node/bin/node", npmCli: "/R/npm-cli.js", npxCli: "/R/npx-cli.js", nodeDir: "/R/node/bin" }, dataDir: "/D" },
  );
  assert.deepEqual(env, {
    HOME: "/h",
    // Under a package manager's script (npm_lifecycle_event, npm_execpath) no npm_config_* stays: they may come from
    // the project's own .npmrc. The person's proxy and certificates in the environment stay; the caller's
    // BUSY_EMULATOR_* go.
    HTTPS_PROXY: "http://proxy.example:3128",
    NODE_EXTRA_CA_CERTS: "/corp/extra.pem",
    // macOS: /usr/bin (the system's tar) before the caller's PATH.
    PATH: "/D/tools/bin:/R/node/bin:/usr/bin:/usr/bin:/bin",
    npm_config_cache: "/D/npm-cache",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NODE_COMPILE_CACHE: "/D/node-compile-cache",
    BUSY_EMULATOR_NODE: "/R/node/bin/node",
    BUSY_EMULATOR_NPM_CLI: "/R/npm-cli.js",
    BUSY_EMULATOR_NPX_CLI: "/R/npx-cli.js",
    // npm waits a minute for an answer and retries twice, 2 to 10 s apart (create-offline), unless the caller said.
    npm_config_fetch_timeout: "60000",
    npm_config_fetch_retries: "2",
    npm_config_fetch_retry_mintimeout: "2000",
    npm_config_fetch_retry_maxtimeout: "10000",
    COPYFILE_DISABLE: "1",
  });
});

test("the person's own shell: the network settings in the environment stay, the npmrc it names does not", () => {
  const tools = { node: "/R/node/bin/node", npmCli: "/R/npm-cli.js", npxCli: "/R/npx-cli.js", nodeDir: "/R/node/bin" };
  const env = toolEnvironment(
    {
      PATH: "/usr/bin",
      npm_config_userconfig: "/project/evil-npmrc",
      NPM_CONFIG_GLOBALCONFIG: "/project/evil-global",
      npm_config_git: "/project/run-me.sh",
      npm_config_script_shell: "/project/run-me.sh",
      npm_config_cafile: "/corp/ca.pem",
      npm_config_registry: "https://registry.example/",
      "npm_config_@busy:registry": "https://scoped.example/",
      npm_config_https_proxy: "http://proxy.example:3128",
      npm_config_noproxy: "corp.example",
    },
    { platform: "darwin", tools, dataDir: "/D" },
  );
  assert.deepEqual(Object.keys(env).filter((name) => name.toLowerCase().startsWith("npm_config_")).sort(), ["npm_config_@busy:registry", "npm_config_audit", "npm_config_cache", "npm_config_cafile", "npm_config_fetch_retries", "npm_config_fetch_retry_maxtimeout", "npm_config_fetch_retry_mintimeout", "npm_config_fetch_timeout", "npm_config_fund", "npm_config_https_proxy", "npm_config_noproxy", "npm_config_registry", "npm_config_update_notifier"]);
  // npx and pnpm say so with npm_command or npm_package_json alone.
  for (const marker of ["npm_command", "npm_package_json", "NPM_EXECPATH"]) {
    const under = toolEnvironment({ PATH: "/usr/bin", [marker]: "x", npm_config_registry: "https://evil.example/", npm_config_https_proxy: "http://p:1" }, { platform: "darwin", tools, dataDir: "/D" });
    assert.equal(under.npm_config_registry, undefined, marker);
    assert.equal(under.npm_config_https_proxy, undefined, marker);
  }
});

test("Windows: one PATH, with the system's System32 after the Node's folder, and letter case of names ignored", () => {
  const env = toolEnvironment(
    { Path: "C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32", PATH: "C:\\other", node_options: "--require x", NPM_CONFIG_USER_AGENT: "yarn", SystemRoot: "C:\\Windows" },
    { platform: "win32", tools: { node: "C:\\R\\node\\node.exe", npmCli: "C:\\R\\n.js", npxCli: "C:\\R\\x.js", nodeDir: "C:\\R\\node" }, dataDir: "C:\\D", windowsDir: "D:\\Windows" },
  );
  assert.equal(Object.keys(env).filter((key) => key.toUpperCase() === "PATH").length, 1);
  // Of two spellings Node passes the first in sorted order to a child: "PATH" (what the caller's child would get).
  assert.equal(env.PATH, "C:\\D\\tools\\bin;C:\\R\\node;D:\\Windows\\System32;C:\\other");
  assert.equal(env.node_options, undefined);
  assert.equal(env.NPM_CONFIG_USER_AGENT, undefined);
  assert.equal(env.NoDefaultCurrentDirectoryInExePath, "1");
  assert.equal(env.COPYFILE_DISABLE, undefined);
  assert.equal(env.npm_config_cache, "C:\\D\\npm-cache");
  // A Windows folder that is not a full path is not taken.
  const relative = toolEnvironment({ PATH: "C:\\x" }, { platform: "win32", tools: { node: "n", npmCli: "n", npxCli: "x", nodeDir: "C:\\R" }, dataDir: "C:\\D", windowsDir: "Win" });
  assert.equal(relative.PATH, "C:\\D\\tools\\bin;C:\\R;C:\\Windows\\System32;C:\\x");
});

test("npm and npx for a project's scripts take the Node and npm from the environment, not from the file", () => {
  const posix = shimFiles("darwin");
  assert.deepEqual(Object.keys(posix).sort(), ["npm", "npx"]);
  assert.equal(posix.npm.split("\n")[0], "#!/bin/sh");
  assert.match(posix.npm, /^exec "\$BUSY_EMULATOR_NODE" "\$BUSY_EMULATOR_NPM_CLI" "\$@"$/m);
  assert.match(posix.npx, /^exec "\$BUSY_EMULATOR_NODE" "\$BUSY_EMULATOR_NPX_CLI" "\$@"$/m);
  const win = shimFiles("win32");
  assert.deepEqual(Object.keys(win).sort(), ["npm", "npm.cmd", "npx", "npx.cmd"]);
  assert.equal(win["npm.cmd"], '@"%BUSY_EMULATOR_NODE%" "%BUSY_EMULATOR_NPM_CLI%" %*\r\n');
  // Nothing but ASCII: cmd.exe reads a batch file in the console's code page.
  for (const text of Object.values(win)) assert.match(text, /^[\x00-\x7f]*$/);
  const data = temporary();
  const dir = writeShims(data, process.platform);
  assert.equal(dir, path.join(data, ...SHIM_FOLDER));
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(shimFiles(process.platform)).sort());
  writeShims(data, process.platform);
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(shimFiles(process.platform)).sort(), "written again, nothing left beside them");
});

// ------------------------------------------------------------------------------------------- running, with a project

test("a project's scripts that call node, npm and npx get the bundled Node and its npm, not the ones on PATH", async () => {
  const folder = temporary();
  const home = path.join(folder, "home");
  const data = path.join(folder, "data");
  const project = path.join(folder, "project with spaces");
  mkdirSync(home);
  mkdirSync(project);
  const poison = poisonedFolder(temporary());
  const script = `node -e "process.stdout.write('node='+process.execPath+'\\n')" && npm --version && npx --version`;
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", private: true, scripts: { check: script } }));
  const setup = { tools: DEV_TOOLS, dataDir: data, platform: process.platform, env: personEnvironment(home, poison), windowsDir: process.env.SystemRoot ?? null };
  const run = await runNodeTool(setup, { tool: "npm", args: ["run", "check"], cwd: project });
  assert.equal(run.code, 0, run.output);
  assert.ok(!existsSync(poison.mark), `a node, npm or npx from PATH ran: ${run.output}`);
  assert.equal(/^node=(.+)$/m.exec(plainText(run.output))?.[1], process.execPath);
  const versions = plainText(run.output).split("\n").filter((line) => /^\d+\.\d+\.\d+$/.test(line.trim()));
  assert.deepEqual(versions.map((line) => line.trim()), [npmVersion(DEV_TOOLS), npmVersion(DEV_TOOLS)]);
  // npm wrote its cache and log in the data folder, and nothing into the home.
  assert.deepEqual(readdirSync(home), []);
});

test("a character split between two pieces of a tool's output comes out whole, on stdout and on stderr alike", async () => {
  const folder = temporary();
  const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(path.join(folder, "home"), poisonedFolder(temporary())) };
  // A Cyrillic path as tsc prints it, given as bytes (UTF-8 of "C:\\Users\\<four Cyrillic letters>\\main.ts"), and
  // each stream's line cut after the first byte of the second letter: four writes, each its own piece of output.
  const line = Buffer.concat([Buffer.from("C:\\Users\\"), Buffer.from("d098d0b2d0b0d0bd", "hex"), Buffer.from("\\main.ts(1,1): error TS2304\n")]);
  const cut = "C:\\Users\\".length + 3;
  const script = `const line = Buffer.from(${JSON.stringify(line.toString("base64"))}, "base64"); const wait = () => new Promise((r) => setTimeout(r, 150));
    (async () => { process.stdout.write(line.subarray(0, ${cut})); await wait(); process.stderr.write(line.subarray(0, ${cut})); await wait();
      process.stdout.write(line.subarray(${cut})); await wait(); process.stderr.write(line.subarray(${cut})); })();`;
  const pieces = [];
  const run = await runNodeTool(setup, { tool: "node", args: ["-e", script], cwd: folder, onOutput: (text) => pieces.push(text) });
  assert.equal(run.code, 0, run.output);
  assert.ok(pieces.length >= 2, `pieces: ${JSON.stringify(pieces)}`);
  // Each stream's piece ends in the middle of a letter, which comes with that stream's next piece: the letters before
  // the cut, twice, then the rest from the cut letter on, twice. Decoded piece by piece, each cut was two U+FFFD.
  const before = line.subarray(0, cut - 1).toString("utf8");
  const after = line.subarray(cut - 1).toString("utf8");
  assert.ok(!run.output.includes("\uFFFD"), JSON.stringify(run.output));
  assert.equal(run.output, before + before + after + after);
});

test("a tool that fails gives its code and its output; a tool that is missing is named", async () => {
  const folder = temporary();
  const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(path.join(folder, "home"), poisonedFolder(temporary())) };
  const run = await runNodeTool(setup, { tool: "node", args: ["-e", "console.error('it broke: ' + 'Γειά'); process.exit(3)"], cwd: folder });
  assert.equal(run.code, 3);
  assert.match(run.output, /it broke: Γειά/);
  await assert.rejects(runNodeTool({ ...setup, tools: { ...DEV_TOOLS, npmCli: path.join(folder, "no", "npm-cli.js") } }, { tool: "npm", args: ["--version"], cwd: folder }), (e) => e.code === "no_node_tools" && e.missing.length === 1);
});

// ------------------------------------------------------------------------------------------- stopping a tool (C5)

test("a tool told to stop is killed with what it started, its grandchild too; the run ends as stopped", async () => {
  const folder = temporary();
  const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(path.join(folder, "home"), poisonedFolder(temporary())), windowsDir: process.env.SystemRoot ?? null };
  const pids = path.join(folder, "pids.json");
  const controller = new AbortController();
  const said = [];
  const running = runNodeTool(setup, { tool: "node", args: [hangingTool(folder, pids)], cwd: folder, signal: controller.signal, onOutput: (text) => said.push(text) });
  const { child, grandchild } = await pidsIn(pids);
  assert.ok(alive(child) && alive(grandchild), "both run");
  // What it printed is kept when it is stopped: stopped once its line has come. The file of ids is written before the
  // line, and on a loaded machine the line was still in the pipe when the test stopped it (EMU-294).
  while (!said.join("").includes("hanging")) await new Promise((resolve) => setTimeout(resolve, 10));
  const at = Date.now();
  controller.abort("timeout");
  const run = await running;
  assert.equal(run.aborted, true);
  assert.equal(run.code === null || windows, true, `stopped, not ended: ${JSON.stringify(run)}`);
  assert.ok(run.signal, "ended by a signal");
  assert.match(run.output, /hanging/);
  assert.ok(Date.now() - at < 10_000, `answered in ${Date.now() - at} ms, not when the grandchild's pipes closed by themselves`);
  assert.ok(await gone(child), `the tool (${child}) is gone`);
  assert.ok(await gone(grandchild), `its grandchild (${grandchild}) is gone`);
  // Already stopped before it began: nothing starts.
  const before = path.join(folder, "never.json");
  const stopped = await runNodeTool(setup, { tool: "node", args: [hangingTool(folder, before)], cwd: folder, signal: AbortSignal.abort() });
  assert.deepEqual([stopped.aborted, stopped.output], [true, ""]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(!existsSync(before), "the tool never ran");
  // A tool that ends by itself is not touched by a signal that never aborts.
  const ended = await runNodeTool(setup, { tool: "node", args: ["-e", "process.exit(4)"], cwd: folder, signal: new AbortController().signal });
  assert.deepEqual([ended.code, ended.aborted], [4, undefined]);
});

test("the network watch stops a silent tool the same way: with what it started, its grandchild too", async () => {
  const folder = temporary();
  const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(path.join(folder, "home"), poisonedFolder(temporary())), windowsDir: process.env.SystemRoot ?? null };
  const pids = path.join(folder, "pids.json");
  const told = [];
  const running = runNodeTool(setup, { tool: "node", args: [hangingTool(folder, pids)], cwd: folder, watch: { quietMs: 1500, tellMs: 500, onQuiet: (ms) => told.push(ms) } });
  const { child, grandchild } = await pidsIn(pids);
  const run = await running;
  assert.equal(run.stopped, "quiet");
  assert.equal(run.aborted, undefined, "the watch stopped it, not a signal");
  assert.ok(told.length >= 1, "the silence was told before the stop");
  assert.ok(await gone(child), `the tool (${child}) is gone`);
  assert.ok(await gone(grandchild), `its grandchild (${grandchild}) is gone`);
  // A failure in its output stops it at once, with that failure.
  const failing = await runNodeTool(setup, { tool: "node", args: ["-e", "console.log('npm error network'); setInterval(() => {}, 1000)"], cwd: folder, watch: { failsOn: (text) => (/network/.test(text) ? { reason: "network" } : null) } });
  assert.deepEqual([failing.stopped, failing.because], ["network", { reason: "network" }]);
});

test("killTree on Windows: taskkill of the system's, by our child's process id with its tree, never a name", () => {
  const started = [];
  const child = { pid: 4321, kill: () => started.push("kill") };
  killTree(child, { platform: "win32", windowsDir: "D:\\Windows", run: (file, args, options) => (started.push([file, args, options.windowsHide]), { on: () => {} }) });
  assert.deepEqual(started, [["D:\\Windows\\System32\\taskkill.exe", ["/T", "/F", "/PID", "4321"], true]]);
  started.length = 0;
  killTree(child, { platform: "win32", windowsDir: "relative", run: (file, args) => (started.push([file, args]), { on: () => {} }) });
  assert.equal(started[0][0], "C:\\Windows\\System32\\taskkill.exe", "a Windows folder that is no absolute path is not taken");
  started.length = 0;
  killTree({ pid: undefined, kill: () => started.push("kill") }, { platform: "win32", run: () => started.push("taskkill") });
  assert.deepEqual(started, [], "no process id, nothing is killed");
});

// A registry of one package, whose install script would leave a file: npm with --ignore-scripts must not run it.
let registry;
let registryHits = [];
let tarball;

async function packStub() {
  const folder = temporary();
  const pkg = path.join(folder, "busy-stub");
  mkdirSync(pkg);
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "busy-stub", version: "1.0.0", scripts: { postinstall: "node -e \"require('fs').writeFileSync('postinstall-ran','')\"" } }));
  writeFileSync(path.join(pkg, "index.js"), "module.exports = 1;\n");
  const run = await runNodeTool({ tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: { PATH: process.env.PATH, HOME: folder, USERPROFILE: folder, SystemRoot: process.env.SystemRoot } }, { tool: "npm", args: ["pack", "--pack-destination", folder], cwd: pkg });
  assert.equal(run.code, 0, run.output);
  return readFileSync(path.join(folder, "busy-stub-1.0.0.tgz"));
}

before(async () => {
  tarball = await packStub();
  registry = http.createServer((req, res) => {
    registryHits.push(req.url);
    const base = `http://127.0.0.1:${registryPort}`;
    if (req.url === "/busy-stub") {
      const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
      const version = { name: "busy-stub", version: "1.0.0", hasInstallScript: true, scripts: { postinstall: "node -e 1" }, dist: { tarball: `${base}/busy-stub/-/busy-stub-1.0.0.tgz`, integrity, shasum: createHash("sha1").update(tarball).digest("hex") } };
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ name: "busy-stub", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": version } }));
    }
    if (req.url === "/busy-stub/-/busy-stub-1.0.0.tgz") return res.end(tarball);
    res.statusCode = 404;
    res.end("{}");
  });
  registryPort = await listen(registry, REGISTRY_PORT);
});
after(() => new Promise((resolve) => (registry ? registry.close(resolve) : resolve())));

test("npm reads the person's own .npmrc (the registry), keeps its cache in the data folder, and runs no install script", async () => {
  registryHits = [];
  const folder = temporary();
  const home = path.join(folder, "home");
  const data = path.join(folder, "data");
  const project = path.join(folder, "project");
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(path.join(home, ".npmrc"), `registry=http://127.0.0.1:${registryPort}/\n`);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", private: true, dependencies: { "busy-stub": "1.0.0" } }));
  // A temporary folder of the test's: npm and Node leave nothing there either (Node's compile cache goes to the data folder).
  const tmp = path.join(folder, "tmp");
  mkdirSync(tmp);
  const env = { ...personEnvironment(home, poisonedFolder(temporary())), TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  const setup = { tools: DEV_TOOLS, dataDir: data, platform: process.platform, env, windowsDir: process.env.SystemRoot ?? null };
  assert.deepEqual(installArguments(project), ["install", "--ignore-scripts", "--no-workspaces", "--no-audit", "--no-fund"]);
  const run = await runNodeTool(setup, { tool: "npm", args: installArguments(project), cwd: project });
  assert.equal(run.code, 0, run.output);
  assert.ok(registryHits.includes("/busy-stub"), `the registry of .npmrc was asked: ${registryHits.join(", ")}`);
  assert.ok(existsSync(path.join(project, "node_modules", "busy-stub", "index.js")));
  assert.ok(!existsSync(path.join(project, "node_modules", "busy-stub", "postinstall-ran")), "the install script did not run");
  assert.ok(readdirSync(path.join(data, CACHE_FOLDER)).includes("_cacache"), "the cache is in the data folder");
  assert.deepEqual(readdirSync(home), [".npmrc"], "nothing written into the home: no ~/.npm, no log there");
  assert.deepEqual(readdirSync(tmp), [], "nothing left in the temporary folder");
  // With the lock file npm made, the next install is npm ci, still without scripts.
  assert.deepEqual(installArguments(project), ["ci", "--ignore-scripts", "--no-workspaces", "--no-audit", "--no-fund"]);
  const again = await runNodeTool(setup, { tool: "npm", args: installArguments(project), cwd: project });
  assert.equal(again.code, 0, again.output);
  assert.ok(!existsSync(path.join(project, "node_modules", "busy-stub", "postinstall-ran")));
});

test("create's generator comes from the person's ~/.npmrc registry, whatever NPM_CONFIG_REGISTRY in the environment says", async () => {
  const { generatorRegistry, PUBLIC_REGISTRY } = await import("../../cli/commands/create.mjs");
  registryHits = [];
  const folder = temporary();
  const home = path.join(folder, "home");
  const data = path.join(folder, "data");
  const generator = path.join(folder, "create-app");
  mkdirSync(home);
  mkdirSync(generator);
  assert.equal(generatorRegistry(home), PUBLIC_REGISTRY, "no ~/.npmrc: npm's own");
  writeFileSync(path.join(home, ".npmrc"), `registry=http://127.0.0.1:${registryPort}/\n`);
  assert.equal(generatorRegistry(home), `http://127.0.0.1:${registryPort}/`);
  writeFileSync(path.join(generator, "package.json"), JSON.stringify({ private: true, dependencies: { "busy-stub": "1.0.0" } }));
  // A project's `npm run` would have set this; a registry there would hand out another generator.
  const env = { ...personEnvironment(home, poisonedFolder(temporary())), NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/", "npm_config_@busy-app:registry": "http://127.0.0.1:9/", npm_config_fetch_retries: "0" };
  const registry = generatorRegistry(home);
  const run = await runNodeTool({ tools: DEV_TOOLS, dataDir: data, platform: process.platform, env, windowsDir: process.env.SystemRoot ?? null }, { tool: "npm", args: ["install", `--registry=${registry}`, `--@busy-app:registry=${registry}`, "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0"], cwd: generator });
  assert.equal(run.code, 0, run.output);
  assert.ok(registryHits.includes("/busy-stub"), registryHits.join(", "));
  for (const text of ["registry = ${NPM_REGISTRY}", 'registry="file:///x"']) {
    writeFileSync(path.join(home, ".npmrc"), `${text}\n`);
    assert.equal(generatorRegistry(home), PUBLIC_REGISTRY, text);
  }
});

test("a project that pnpm locks is installed without a package-lock.json: its one lock file stays the only one", async () => {
  const folder = temporary();
  const home = path.join(folder, "home");
  const project = path.join(folder, "project");
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(path.join(home, ".npmrc"), `registry=http://127.0.0.1:${registryPort}/\n`);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "p", private: true, packageManager: "pnpm@10.33.0", dependencies: { "busy-stub": "1.0.0" } }));
  const lock = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      busy-stub:\n        specifier: 1.0.0\n        version: 1.0.0\n";
  writeFileSync(path.join(project, "pnpm-lock.yaml"), lock);
  assert.equal(usesPnpm(project), true);
  assert.deepEqual(installArguments(project), ["install", "--ignore-scripts", "--no-workspaces", "--no-audit", "--no-fund", "--no-package-lock"]);
  const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(home, poisonedFolder(temporary())), windowsDir: process.env.SystemRoot ?? null };
  const run = await runNodeTool(setup, { tool: "npm", args: installArguments(project), cwd: project });
  assert.equal(run.code, 0, run.output);
  assert.ok(existsSync(path.join(project, "node_modules", "busy-stub", "index.js")), "the dependencies are installed");
  assert.ok(!existsSync(path.join(project, "package-lock.json")), "npm wrote no lock file of its own");
  assert.equal(readFileSync(path.join(project, "pnpm-lock.yaml"), "utf8"), lock, "pnpm's lock file is as it was");
  // A project with both lock files is npm's to install as before: the author chose to keep npm's.
  writeFileSync(path.join(project, "package-lock.json"), "{}");
  assert.equal(usesPnpm(project), false);
  assert.deepEqual(installArguments(project), ["ci", "--ignore-scripts", "--no-workspaces", "--no-audit", "--no-fund"]);
});

test("npm goes through the proxy of the person's .npmrc", async () => {
  const hits = [];
  const proxy = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  const proxyPort = await listen(proxy, PROXY_PORT);
  try {
    const folder = temporary();
    const home = path.join(folder, "home");
    mkdirSync(home);
    writeFileSync(path.join(home, ".npmrc"), `registry=http://registry.busy-emulator.invalid/\nproxy=http://127.0.0.1:${proxyPort}/\n`);
    const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(home, poisonedFolder(temporary())) };
    const run = await runNodeTool(setup, { tool: "npm", args: ["ping"], cwd: folder });
    assert.equal(run.code, 0, run.output);
    assert.ok(hits.some((hit) => hit.startsWith("GET http://registry.busy-emulator.invalid/-/ping")), hits.join(", "));
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test("an unreachable registry is told apart from a sandbox that refuses the connection", async () => {
  const folder = temporary();
  const home = path.join(folder, "home");
  mkdirSync(home);
  writeFileSync(path.join(home, ".npmrc"), "registry=http://registry.busy-emulator.invalid/\nfetch-retries=0\n");
  const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(home, poisonedFolder(temporary())) };
  const run = await runNodeTool(setup, { tool: "npm", args: ["view", "busy-stub", "version"], cwd: folder });
  assert.notEqual(run.code, 0);
  const failure = networkFailure(run.output);
  assert.equal(failure?.kind, "failed", run.output);
  assert.match(failure.reason, /ENOTFOUND|EAI_AGAIN/);
  // What npm says when a sandbox refuses the connection (macOS sandbox-exec, seen with npm 11).
  const sandboxed = "npm error code EPERM\nnpm error errno EPERM\nnpm error FetchError: request to https://registry.npmjs.org/@busy-app%2fcreate-app failed, reason: \nnpm error     at ClientRequest.<anonymous> (/x/minipass-fetch/lib/index.js:130:14)\n";
  assert.deepEqual(networkFailure(sandboxed), { kind: "blocked", url: "https://registry.npmjs.org/@busy-app%2fcreate-app", reason: "EPERM" });
  // A file npm may not write is no network failure.
  assert.equal(networkFailure("npm error code EPERM\nnpm error syscall mkdir\nnpm error path /x/npm-cache\nnpm error errno -1"), null);
  assert.equal(networkFailure("npm error code E404\nnpm error 404 Not Found - GET http://x/y"), null);
  assert.equal(networkFailure("npm error code ERESOLVE\nnpm error ERESOLVE could not resolve"), null);
});

// ------------------------------------------------------------------------------------------- the project's busy-cli

function fakeProject(folder, { cli = true, fontMaps = FONT_MAPS_BROKEN } = {}) {
  const project = path.join(folder, "app");
  mkdirSync(project);
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "a", private: true, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  if (cli) {
    const dist = path.join(project, "node_modules", "@busy-app", "cli", "dist");
    mkdirSync(path.join(dist, "lib"), { recursive: true });
    writeFileSync(path.join(project, "node_modules", "@busy-app", "cli", "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
    writeFileSync(path.join(dist, "index.js"), "");
    writeFileSync(path.join(dist, "lib", "fontMapsPlugin.js"), `const a = 1;\nconst line = ${fontMaps};\n`);
  }
  return project;
}

test("a project is a folder whose package.json names @busy-app/cli; its busy-cli is the one it installed", () => {
  const folder = temporary();
  assert.deepEqual(readProject(folder), { project: false, why: "it has no package.json" });
  writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: "x", dependencies: { left: "1" } }));
  assert.equal(readProject(folder).why, "its package.json does not name @busy-app/cli");
  const project = fakeProject(folder);
  assert.equal(readProject(project).project, true);
  assert.equal(busyCliScript(project), path.join(project, "node_modules", "@busy-app", "cli", "dist", "index.js"));
  assert.equal(busyCliScript(fakeProject(mkdtemp(folder), { cli: false })), null);
});

function mkdtemp(folder) {
  const dir = path.join(folder, `x${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir);
  return dir;
}

test("busy-cli's fonts path on Windows: fixed in that one file, once; elsewhere and in a fixed busy-cli left alone", () => {
  const folder = temporary();
  const project = fakeProject(folder);
  const file = path.join(project, "node_modules", "@busy-app", "cli", "dist", "lib", "fontMapsPlugin.js");
  const before = readFileSync(file, "utf8");
  assert.equal(fixFontMaps(project, "darwin"), "not-needed");
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(fixFontMaps(project, "win32"), "patched");
  assert.equal(readFileSync(file, "utf8"), before.replace(FONT_MAPS_BROKEN, FONT_MAPS_FIXED));
  assert.equal(fixFontMaps(project, "win32"), "already");
  assert.deepEqual(readdirSync(path.dirname(file)), ["fontMapsPlugin.js"], "no temporary file left");
  // The fixed line, run: a Windows path becomes one with forward slashes inside a JSON string.
  const resolve = (...parts) => parts.join("\\");
  const [i, f, maps] = [0, "bold", "C:\\Users\\you\\Ünal app\\node_modules\\@busy-app\\busy-lib\\dist\\Utils\\font\\maps"];
  assert.equal(new Function("i", "f", "maps", "resolve", `return ${FONT_MAPS_FIXED}`)(i, f, maps, resolve), 'import f0 from "C:/Users/you/Ünal app/node_modules/@busy-app/busy-lib/dist/Utils/font/maps/bold.json";');
  assert.equal(fixFontMaps(fakeProject(mkdtemp(folder), { fontMaps: "`something else`" }), "win32"), "not-found");
  assert.equal(fixFontMaps(fakeProject(mkdtemp(folder), { cli: false }), "win32"), "no-cli");
});

test("busy-cli's fonts file is not followed out of the project through a link", { skip: windows && "links need rights on Windows" }, () => {
  const folder = temporary();
  const elsewhere = fakeProject(mkdtemp(folder));
  const project = path.join(folder, "linked");
  mkdirSync(path.join(project, "node_modules", "@busy-app"), { recursive: true });
  writeFileSync(path.join(project, "package.json"), "{}");
  symlinkSync(path.join(elsewhere, "node_modules", "@busy-app", "cli"), path.join(project, "node_modules", "@busy-app", "cli"));
  const file = path.join(elsewhere, "node_modules", "@busy-app", "cli", "dist", "lib", "fontMapsPlugin.js");
  const before = readFileSync(file, "utf8");
  assert.equal(fixFontMaps(project, "win32"), "outside");
  assert.equal(readFileSync(file, "utf8"), before);
});

// ------------------------------------------------------------------------------------------------------ the output

test("output for a message: no color codes or redraws, the end of it, the empty lines gone", () => {
  assert.equal(plainText("\x1b[1mbold\x1b[0m and \x1b[36mcyan\x1b[39m\r\nnext\rredrawn"), "bold and cyan\nredrawn");
  const long = Array.from({ length: 50 }, (_, n) => `line ${n}`).join("\n\n");
  assert.equal(tail(long, { lines: 3 }), "line 47\nline 48\nline 49");
  assert.equal(tail("x".repeat(5000), { chars: 10 }), `…${"x".repeat(10)}`);
});

// ------------------------------------------------------------------------------------------------------- the rule

test("only node-tools.mjs starts npm, npx or Node for a project: no other module of the server names npm-cli.js or runs them by name", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "node_modules" && entry.name !== "legacy-window") walk(full);
      } else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs") && full !== path.join(SERVER, "projects", "node-tools.mjs")) {
        const source = readFileSync(full, "utf8");
        if (/np[mx]-cli\.js/.test(source)) offenders.push(`${path.relative(SERVER, full)} names npm-cli.js or npx-cli.js`);
        if (/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|spawnProgram|execProgram)\s*\(\s*["'`](?:npm|npx|node|corepack)(?:\.cmd|\.exe|\.ps1)?["'`]/.test(source)) offenders.push(`${path.relative(SERVER, full)} starts npm, npx or node by name`);
      }
    }
  };
  walk(SERVER);
  assert.deepEqual(offenders, []);
});

test("a project inside someone else's npm workspace is installed as its own root: the workspace's .npmrc runs nothing", { skip: windows && "a sh program for git" }, async () => {
  // The probe of the security review (M2), offline: the root names a git dependency and, in its .npmrc, the program
  // npm runs as git. Without --no-workspaces npm takes the root for the project's and runs that program.
  const folder = temporary();
  const mark = path.join(folder, "ran");
  writeFileSync(path.join(folder, "tool.sh"), `#!/bin/sh\necho "git $*" >> '${mark}'\nexit 1\n`);
  chmodSync(path.join(folder, "tool.sh"), 0o755);
  writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name: "root", private: true, workspaces: ["my-app"], dependencies: { helper: "git+ssh://git@example.invalid/x/helper.git" } }));
  writeFileSync(path.join(folder, ".npmrc"), `git=${path.join(folder, "tool.sh")}\nfetch-retries=0\n`);
  const app = path.join(folder, "my-app");
  mkdirSync(app);
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "my-app", private: true }));
  const home = path.join(folder, "home");
  mkdirSync(home);
  const setup = { tools: DEV_TOOLS, dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(home, poisonedFolder(temporary())) };
  const run = await runNodeTool(setup, { tool: "npm", args: installArguments(app), cwd: app });
  assert.equal(run.code, 0, run.output);
  assert.ok(!existsSync(mark), `the workspace's program ran: ${existsSync(mark) ? readFileSync(mark, "utf8") : ""}`);
  assert.ok(!existsSync(path.join(folder, "node_modules")), "nothing installed at the workspace's root");
});

test("Create app's Open existing takes as a project what the command line does (packages/app/src/project-root.mjs)", async () => {
  const { namesBusyCli } = await import("../../../app/src/project-root.mjs");
  const dir = mkdtempSync(path.join(os.tmpdir(), "project-rule-"));
  try {
    const cases = [{ devDependencies: { "@busy-app/cli": "1" } }, { dependencies: { "@busy-app/cli": "1" } }, { devDependencies: { "@busy-app/cli-other": "1" } }, { peerDependencies: { "@busy-app/cli": "1" } }, {}, { dependencies: null }];
    for (const manifest of cases) {
      writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
      assert.equal(namesBusyCli(manifest), readProject(dir).project, JSON.stringify(manifest));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
