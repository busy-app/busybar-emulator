// The project's tools on the Node inside the app (EMU-206): the official generator, npm and the project's own busy-cli
// run here, and only here, on the bundled Node by its full path. Nobody needs a Node or an npm of their own, and the
// ones a person has are never used: npm is started as `<node> <npm-cli.js>`, never by name, and the programs a project's
// scripts start by name (`node`, `npm`, `npx`) are found first in folders this module puts in front of PATH.
//
// Why no shell, on Windows too: npm is a JavaScript program. Run as `node.exe npm-cli.js`, it needs neither npm.cmd nor
// cmd.exe, so none of its arguments goes through cmd.exe's quoting (ADR-0012 §6 expected a shell for npm on Windows;
// with npm-cli.js there is none). The scripts of a project that npm runs (`npm run …`) do go through the system's
// shell, as with any npm; that is npm's and the project's business, and why only a trusted project is built.
//
// What a child gets (toolEnvironment):
// - the caller's environment without what changes how Node starts (node-environment.mjs), and without the variables an
//   npm, pnpm or yarn that ran the caller leaves behind (npm_config_user_agent would make the generator pick pnpm,
//   npm_config_prefix and the lifecycle variables would point npm elsewhere). The network settings a person may keep
//   in the environment (registry, proxy, CA file) stay; ~/.npmrc is read by npm as always. Two exceptions (audit,
//   11.11), since the environment may be a project's rather than the person's:
//   - npm_config_userconfig and npm_config_globalconfig never stay: they name the file whose `git=` or `script-shell=`
//     npm runs, which the rest of this list keeps out. npm finds the person's ~/.npmrc itself.
//   - Under a package manager's script (npm run, npx, pnpm, yarn: npm_lifecycle_event, npm_execpath, npm_command or
//     npm_package_json is set) no npm_config_* stays: the package manager put there every setting it read, those of
//     the project's own .npmrc too. The person's settings still apply: ~/.npmrc is read, and HTTPS_PROXY, HTTP_PROXY,
//     NO_PROXY and NODE_EXTRA_CA_CERTS are not npm_config_* and stay.
// - npm's cache in the data folder (npm_config_cache), so that nothing is written outside the data folder and the
//   project; no update check, no funding or audit messages.
// - PATH: the folder with this module's `npm` and `npx` (data folder, tools/bin), the bundled Node's own folder, on
//   Windows the system's System32 (so that busy-cli's `tar` is the system's bsdtar, not GNU tar of Git Bash, which
//   takes "C:" for a host), on macOS /usr/bin (the system's tar before one of Homebrew), then the caller's PATH.
// - Node's compile cache, which npm turns on, in the data folder too (NODE_COMPILE_CACHE; otherwise it goes to the
//   system's temporary folder).
// - macOS: COPYFILE_DISABLE=1, so that the system's tar packs no AppleDouble (._*) files into the app's package.
//
// The `npm` and `npx` in tools/bin are scripts that start the bundled Node on npm-cli.js and npx-cli.js. The paths come
// from the environment (BUSY_EMULATOR_NODE, BUSY_EMULATOR_NPM_CLI, BUSY_EMULATOR_NPX_CLI), not from the file: a batch
// file is read in the console's code page, and a path with letters outside it would not survive being written there.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { startProgram } from "../../engine/programs.mjs";
import { nodeEnvironment } from "../cli/node-environment.mjs";
import { insideRoots } from "../path-boundary.mjs";

/** The folders under the data folder this module writes into. */
export const CACHE_FOLDER = "npm-cache";
export const COMPILE_CACHE_FOLDER = "node-compile-cache";
export const SHIM_FOLDER = Object.freeze(["tools", "bin"]);

/** How much of a tool's output is kept for the caller: the end of it, where the error is. */
export const OUTPUT_LIMIT = 256 * 1024;

/**
 * The variables of npm and its kin a child does not get. npm_config_* goes but for the settings a person may keep in
 * the environment on purpose; KEPT_SETTINGS names those (npm's names, with "-" as "_"): the network, the certificates
 * of a company's network, how long npm waits on it.
 */
const KEPT_SETTINGS = new Set(["registry", "proxy", "https_proxy", "http_proxy", "noproxy", "no_proxy", "cafile", "ca", "cert", "key", "strict_ssl", "local_address", "fetch_timeout", "fetch_retries", "fetch_retry_mintimeout", "fetch_retry_maxtimeout"]);

/**
 * How long npm waits on the registry (create-offline). npm's own defaults wait five minutes for an answer and retry
 * with up to a minute between tries: a registry that is not there (no network, a refused connection) took 70 s for
 * one package and 4.5 min for a project's dependencies before npm said so, and a Wi-Fi out of range (the connection
 * stays open, nothing comes) longer. Here: a minute for an answer, two retries 2 to 10 s apart. One a person set in
 * the environment (npm_config_fetch_timeout, …) is kept as it is; the same in an .npmrc gives way to these, as npm
 * takes the environment over its files.
 */
export const NPM_NETWORK_SETTINGS = Object.freeze({ fetch_timeout: "60000", fetch_retries: "2", fetch_retry_mintimeout: "2000", fetch_retry_maxtimeout: "10000" });
/** What a package manager sets for a script it runs (npm, npx, pnpm and yarn alike). */
const UNDER_A_PACKAGE_MANAGER = /^(?:npm_lifecycle_event|npm_lifecycle_script|npm_execpath|npm_command|npm_package_json)$/i;
/** Whether the caller runs under a package manager's script: then its npm_config_* may be a project's. */
export function underAPackageManager(env) {
  return Object.keys(env).some((name) => UNDER_A_PACKAGE_MANAGER.test(name) && env[name] !== undefined);
}
function inheritedFromAPackageManager(name, underOne = false) {
  const lower = name.toLowerCase();
  if (lower.startsWith("npm_config_")) {
    if (underOne) return true;
    const setting = lower.slice("npm_config_".length);
    // A scoped registry (npm_config_@scope:registry) is a network setting too.
    return !(KEPT_SETTINGS.has(setting) || /^@[^:]+:registry$/.test(setting));
  }
  // The caller's own BUSY_EMULATOR_* are the command line's, not the project's (this module sets its own below).
  return lower.startsWith("npm_") || lower === "init_cwd" || lower.startsWith("pnpm_") || lower === "berry_bin_folder" || lower.startsWith("busy_emulator_");
}

/**
 * Where the Node and npm to run are. A release and the test variant: the Node inside the app, at <resources>/node.
 * A development run (the source tree, no app): the Node this command runs on and the npm installed beside it.
 * @param {object} o
 * @param {string} o.platform
 * @param {string|null} o.resourcesDir  the app's resources folder, or null for a development run
 * @param {string} o.execPath           process.execPath: the Node this runs on
 * @returns {{ node: string, npmCli: string, npxCli: string, nodeDir: string, bundled: boolean }}
 */
export function nodeToolsAt({ platform, resourcesDir, execPath }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (resourcesDir) {
    const root = p.join(resourcesDir, "node");
    const node = platform === "win32" ? p.join(root, "node.exe") : p.join(root, "bin", "node");
    const npm = platform === "win32" ? p.join(root, "node_modules", "npm") : p.join(root, "lib", "node_modules", "npm");
    return { node, npmCli: p.join(npm, "bin", "npm-cli.js"), npxCli: p.join(npm, "bin", "npx-cli.js"), nodeDir: p.dirname(node), bundled: true };
  }
  const nodeDir = p.dirname(execPath);
  const npm = platform === "win32" ? p.join(nodeDir, "node_modules", "npm") : p.join(nodeDir, "..", "lib", "node_modules", "npm");
  return { node: execPath, npmCli: p.join(p.normalize(npm), "bin", "npm-cli.js"), npxCli: p.join(p.normalize(npm), "bin", "npx-cli.js"), nodeDir, bundled: false };
}

/** The value of a variable by name, ignoring case on Windows, and the names it goes by. */
function lookup(env, name, platform) {
  const keys = Object.keys(env).filter((key) => (platform === "win32" ? key.toUpperCase() === name.toUpperCase() : key === name));
  return { keys, value: keys.length ? env[keys.sort()[0]] : undefined };
}

/**
 * The environment of a tool started for a project (see the top of the file).
 * @param {Record<string, string|undefined>} env  the caller's environment
 * @param {object} o
 * @param {string} o.platform
 * @param {{ node: string, npmCli: string, npxCli: string, nodeDir: string }} o.tools
 * @param {string} o.dataDir
 * @param {string|null} [o.windowsDir]  the system's Windows folder (Windows only)
 */
export function toolEnvironment(env, { platform, tools, dataDir, windowsDir = null }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const underOne = underAPackageManager(env);
  const out = Object.fromEntries(Object.entries(nodeEnvironment(env, platform)).filter(([name, value]) => value !== undefined && !inheritedFromAPackageManager(name, underOne)));
  // The certificates of a company's network, which npm needs to reach its registry there. nodeEnvironment() takes the
  // variable away from what starts the bundled Node; a child given it trusts no more than the person told their own
  // Node to trust. (A release's launchers remove it before the command line starts, so there it does not reach here.)
  const extraCerts = lookup(env, "NODE_EXTRA_CA_CERTS", platform).value;
  if (extraCerts) out.NODE_EXTRA_CA_CERTS = extraCerts;
  const { keys, value: callerPath } = lookup(out, "PATH", platform);
  for (const key of keys) delete out[key];
  const front = [p.join(dataDir, ...SHIM_FOLDER), tools.nodeDir];
  // macOS: the system's tar (bsdtar) for busy-cli's package, before a GNU tar of Homebrew the caller may have first.
  if (platform === "darwin") front.push("/usr/bin");
  if (platform === "win32") front.push(p.join(windowsDir && p.isAbsolute(windowsDir) ? windowsDir : "C:\\Windows", "System32"));
  out.PATH = [...front, ...(callerPath ? [callerPath] : [])].join(platform === "win32" ? ";" : ":");
  Object.assign(out, {
    npm_config_cache: p.join(dataDir, CACHE_FOLDER),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NODE_COMPILE_CACHE: p.join(dataDir, COMPILE_CACHE_FOLDER),
    BUSY_EMULATOR_NODE: tools.node,
    BUSY_EMULATOR_NPM_CLI: tools.npmCli,
    BUSY_EMULATOR_NPX_CLI: tools.npxCli,
  });
  for (const [setting, value] of Object.entries(NPM_NETWORK_SETTINGS)) {
    if (lookup(out, `npm_config_${setting}`, platform).value === undefined) out[`npm_config_${setting}`] = value;
  }
  if (platform === "win32") out.NoDefaultCurrentDirectoryInExePath = "1";
  if (platform === "darwin") out.COPYFILE_DISABLE = "1";
  return out;
}

/** The scripts in tools/bin, by file name. Their paths come from the environment (see the top of the file). */
export function shimFiles(platform) {
  const sh = (cli) => `#!/bin/sh\n# BUSY Bar Emulator: npm on the Node inside the app, for the scripts of a project it builds.\nexec "$BUSY_EMULATOR_NODE" "$${cli}" "$@"\n`;
  const files = { npm: sh("BUSY_EMULATOR_NPM_CLI"), npx: sh("BUSY_EMULATOR_NPX_CLI") };
  if (platform === "win32") {
    // cmd.exe runs npm.cmd for a script that says `npm`; the sh scripts beside it are for a script-shell of sh.
    const cmd = (cli) => `@"%BUSY_EMULATOR_NODE%" "%${cli}%" %*\r\n`;
    files["npm.cmd"] = cmd("BUSY_EMULATOR_NPM_CLI");
    files["npx.cmd"] = cmd("BUSY_EMULATOR_NPX_CLI");
  }
  return files;
}

/** Writes tools/bin where it is not as it should be. A folder of the data folder: made for the owner only. */
export function writeShims(dataDir, platform) {
  const dir = path.join(dataDir, ...SHIM_FOLDER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(shimFiles(platform))) {
    const file = path.join(dir, name);
    let current = null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      // not there yet
    }
    if (current !== text) {
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, text, { mode: 0o700 });
      renameSync(temporary, file);
    }
    if (platform !== "win32") chmodSync(file, 0o700);
  }
  return dir;
}

/** The text of a tool's output as a person reads it: without color codes and carriage-return redraws. */
export function plainText(text) {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").split("\r").pop())
    .join("\n");
}

/**
 * The end of a tool's output, for a message: the last `lines` lines that say something, at most `chars` characters.
 */
export function tail(text, { lines = 30, chars = 4000 } = {}) {
  const kept = plainText(text).split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  let out = kept.slice(-lines).join("\n");
  if (out.length > chars) out = `…${out.slice(-chars)}`;
  return out;
}

/** The signals a tool is given when this process gets them, so that it does not outlive an interrupted command. */
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];
/** How long a tool told to stop has before it and what it started are killed outright (POSIX). */
export const STOP_GRACE_MS = 2000;
/** How long a stopped tool's output pipes may stay open after the kill before the run is answered all the same. */
const CLOSE_WAIT_MS = 5000;

/**
 * Stops a tool and every program it started: npm's scripts, busy-cli's bundler, a test's grandchild. On macOS and
 * Linux the tool runs as the leader of its own process group (runNodeTool starts it detached), and the signal goes to
 * the group; SIGKILL follows after STOP_GRACE_MS for whatever is still there. On Windows a signal reaches only the one
 * process, so the tree under our own child is ended by the system's taskkill, by its process id (/T /F /PID), never by
 * a program's name.
 * @param {object} child   the tool's process (startProgram)
 * @param {object} o
 * @param {string} o.platform
 * @param {string|null} [o.windowsDir]
 * @param {string} [o.signal]
 * @param {(file: string, args: string[], options: object) => object} [o.run]
 *   for the tests: what starts taskkill (by default startProgram: taskkill is in the program list)
 */
export function killTree(child, { platform, windowsDir = null, signal = "SIGTERM", run = (file, args, options) => startProgram(file, args, options, { windowsDir }) } = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    const system32 = path.win32.join(windowsDir && path.win32.isAbsolute(windowsDir) ? windowsDir : "C:\\Windows", "System32");
    try {
      const killer = run(path.win32.join(system32, "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      killer.on?.("error", () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  const group = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // The group is gone already, or was never one (a child started without detached): the child itself.
      try {
        child.kill(sig);
      } catch {
        // gone
      }
    }
  };
  group(signal);
  if (signal !== "SIGKILL") setTimeout(() => group("SIGKILL"), STOP_GRACE_MS).unref();
}

/**
 * Runs one tool on the bundled Node and resolves when it ends. The one way this code starts Node, npm or npx.
 * @param {object} setup
 * @param {{ node: string, npmCli: string, npxCli: string, nodeDir: string }} setup.tools
 * @param {string} setup.dataDir
 * @param {string} setup.platform
 * @param {Record<string, string|undefined>} setup.env  the caller's environment
 * @param {string|null} [setup.windowsDir]
 * @param {object} request
 * @param {"node"|"npm"|"npx"} request.tool
 * @param {string[]} request.args       for "node", the script and its arguments
 * @param {string} request.cwd
 * @param {(chunk: string) => void} [request.onOutput]  each piece of output as it comes (stdout and stderr together)
 * @param {Record<string, string>} [request.extraEnv]
 * @param {object} [request.watch]  for a tool that waits on the network (npm): it is stopped when it has printed
 *   nothing for `quietMs`, or has run for `limitMs` (create-offline: a Wi-Fi out of range keeps npm's connection open
 *   and nothing comes, for longer than anybody waits), or when `failsOn(text)` finds a failure in a piece of its output
 *   (the network's: then it is stopped with that failure as `because`); `onQuiet(ms)` is told every `tellMs` of silence.
 *   Stopped with what it started (killTree), as for `signal`.
 * @param {AbortSignal} [request.signal]  when it aborts, the tool and everything it started are killed (killTree)
 *   and the run ends as stopped by a signal: `signal` is the one it got, or "SIGKILL" where the system says none
 * @returns {Promise<{ code: number|null, signal: string|null, output: string, stopped?: "quiet"|"limit"|"network", because?: object, aborted?: true }>}
 *   output: the end of what it printed; stopped: why the watch stopped it; aborted: `signal` stopped it
 */
export function runNodeTool(setup, { tool, args, cwd, onOutput = () => {}, extraEnv = {}, watch = null, signal = null }) {
  const { tools, dataDir, platform, env, windowsDir = null } = setup;
  const script = { node: null, npm: tools.npmCli, npx: tools.npxCli }[tool];
  if (script === undefined) return Promise.reject(new Error(`not a tool: ${tool}`));
  const missing = [tools.node, script].filter((file) => file && !existsSync(file));
  if (missing.length) return Promise.reject(Object.assign(new Error(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing`), { code: "no_node_tools", missing }));
  // Stopped before it began (a canceled call, a timeout): nothing is started.
  if (signal?.aborted) return Promise.resolve({ code: null, signal: "SIGTERM", output: "", aborted: true });
  writeShims(dataDir, platform);
  mkdirSync(path.join(dataDir, CACHE_FOLDER), { recursive: true, mode: 0o700 });
  const childEnv = { ...toolEnvironment(env, { platform, tools, dataDir, windowsDir }), ...extraEnv };
  return new Promise((resolve, reject) => {
    let child;
    try {
      // POSIX: its own process group, so that stopping it reaches what it starts (killTree). Windows: no new console.
      child = startProgram(tools.node, script ? [script, ...args] : args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: platform !== "win32" }, { bundledNode: tools.bundled ? tools.node : null });
    } catch (e) {
      reject(e);
      return;
    }
    let output = "";
    let stopped = null;
    let heard = Date.now();
    let told = 0;
    const take = (text) => {
      if (!text) return;
      output = (output + text).slice(-OUTPUT_LIMIT);
      heard = Date.now();
      told = 0;
      onOutput(text);
      const failure = !stopped && watch?.failsOn ? watch.failsOn(text) : null;
      if (failure) stop("network", failure);
    };
    // A decoder of its own for each stream: a character of several bytes split between two pieces of output (a
    // Cyrillic path in tsc's error lines) comes out whole, not as two U+FFFD; what is left at the end is flushed.
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk) => take(decoder.write(chunk)));
      stream.on("end", () => take(decoder.end()));
    }
    let aborted = false;
    let closing = null;
    const killAll = (sig) => killTree(child, { platform, windowsDir, signal: sig });
    const forward = (sig) => () => killAll(sig);
    const handlers = FORWARDED.map((sig) => [sig, forward(sig)]);
    for (const [sig, handler] of handlers) process.on(sig, handler);
    // A program that kept the pipes open past the kill (on Windows one taskkill could not reach) does not hold the
    // answer: it comes once the child itself has gone, or after a while.
    const closeAnyway = () => {
      if (closing) return;
      closing = setTimeout(() => finish(child.exitCode, child.signalCode), CLOSE_WAIT_MS + STOP_GRACE_MS);
      closing.unref?.();
    };
    // The watch: a look every second at how long the tool has been silent and has run. It stops the tool with what
    // the tool started (npm's scripts and their children), as an abort does.
    const started = Date.now();
    let because = null;
    const stop = (why, detail = null) => {
      stopped = why;
      because = detail;
      killAll("SIGTERM");
      closeAnyway();
    };
    const watcher = watch
      ? setInterval(() => {
          if (stopped) return;
          const now = Date.now();
          const quiet = now - heard;
          if (watch.limitMs && now - started >= watch.limitMs) return stop("limit");
          if (watch.quietMs && quiet >= watch.quietMs) return stop("quiet");
          if (watch.tellMs && watch.onQuiet && quiet >= (told + 1) * watch.tellMs) {
            told += 1;
            watch.onQuiet(told * watch.tellMs);
          }
        }, Math.min(1000, watch.quietMs || 1000, watch.tellMs || 1000))
      : null;
    const onAbort = () => {
      aborted = true;
      killAll("SIGTERM");
      closeAnyway();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    const done = () => {
      settled = true;
      clearTimeout(closing);
      if (watcher) clearInterval(watcher);
      for (const [name, handler] of handlers) process.off(name, handler);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (code, sig) => {
      if (settled) return;
      done();
      if (aborted || stopped) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
      const watched = stopped ? { stopped, ...(because ? { because } : {}) } : {};
      if (!aborted) return resolve({ code, signal: sig, output, ...watched });
      resolve({ code, signal: sig ?? "SIGKILL", output, ...watched, aborted: true });
    };
    child.on("error", (e) => {
      if (settled) return;
      done();
      reject(e);
    });
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** The version of npm the tools hold. */
export function npmVersion(tools) {
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(path.dirname(tools.npmCli)), "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * The arguments that install a project's dependencies: `npm ci` when it has npm's lock file, `npm install` otherwise
 * (without writing a lock file into a project that pnpm locks); both without install scripts (ADR-0012 §4), as the
 * catalog installs them.
 */
export function installArguments(projectDir) {
  const locked = existsSync(path.join(projectDir, "package-lock.json"));
  // --no-workspaces: npm takes the project for its own root. Otherwise a project inside someone else's npm workspace
  // (a cloned starter, a monorepo with "workspaces") is installed from that root, with that root's .npmrc, whose
  // `git=` names a program npm runs for a git dependency, install scripts or not (EMU-206 security review, M2).
  const args = [locked ? "ci" : "install", "--ignore-scripts", "--no-workspaces", "--no-audit", "--no-fund"];
  // A project of pnpm keeps its one lock file: npm writes no package-lock.json beside pnpm-lock.yaml. The catalog
  // refuses a project with both, and the author's package manager is the author's choice.
  if (!locked && usesPnpm(projectDir)) args.push("--no-package-lock");
  return args;
}

/** Whether the project is locked by pnpm: it has pnpm-lock.yaml and no package-lock.json. */
export function usesPnpm(projectDir) {
  return existsSync(path.join(projectDir, "pnpm-lock.yaml")) && !existsSync(path.join(projectDir, "package-lock.json"));
}

// ------------------------------------------------------------------------------------------- the project's busy-cli

/** The package of the official command line in a project. */
export const BUSY_CLI_PACKAGE = "@busy-app/cli";

/**
 * Whether a folder is an app project of the official tools: a package.json that names @busy-app/cli.
 * @returns {{ project: true, manifest: object } | { project: false, why: string }}
 */
export function readProject(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch (e) {
    return { project: false, why: e?.code === "ENOENT" ? "it has no package.json" : `its package.json cannot be read (${e?.code ?? e.message})` };
  }
  const named = [manifest?.dependencies, manifest?.devDependencies].some((deps) => deps && typeof deps === "object" && Object.hasOwn(deps, BUSY_CLI_PACKAGE));
  return named ? { project: true, manifest } : { project: false, why: `its package.json does not name ${BUSY_CLI_PACKAGE}` };
}

/**
 * The script of the project's own busy-cli, from its installed package, or null when the dependencies are not there.
 */
export function busyCliScript(projectDir) {
  const folder = path.join(projectDir, "node_modules", ...BUSY_CLI_PACKAGE.split("/"));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(folder, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.["busy-cli"];
  if (typeof bin !== "string") return null;
  const script = path.join(folder, bin);
  return existsSync(script) ? script : null;
}

/** The installed version of the project's busy-cli, or null. */
export function busyCliVersion(projectDir) {
  try {
    return JSON.parse(readFileSync(path.join(projectDir, "node_modules", ...BUSY_CLI_PACKAGE.split("/"), "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

// @busy-app/cli 0.6.0 breaks the build on Windows: its fonts plugin writes a Windows path into `import … from '<path>'`
// unescaped, and the backslashes become escape sequences (busy-tools-issues.md; the same fix as tools/patch-busy-cli.mjs
// of our own apps). The fix replaces that one expression in that one file of the project's installed busy-cli, and
// only on Windows, where the bug is; a busy-cli that no longer has the expression is left alone.
export const FONT_MAPS_FILE = ["dist", "lib", "fontMapsPlugin.js"];
export const FONT_MAPS_BROKEN = "`import f${i} from '${resolve(maps, `${f}.json`)}';`";
export const FONT_MAPS_FIXED = "`import f${i} from ${JSON.stringify(resolve(maps, `${f}.json`).replace(/\\\\/g, '/'))};`";

/**
 * Applies the fix on Windows. The file must lie inside the project (by its real path): a link out of node_modules is
 * not followed to change a file elsewhere.
 * @returns {"patched"|"already"|"not-found"|"no-cli"|"not-needed"|"outside"}
 */
export function fixFontMaps(projectDir, platform) {
  if (platform !== "win32") return "not-needed";
  const file = path.join(projectDir, "node_modules", ...BUSY_CLI_PACKAGE.split("/"), ...FONT_MAPS_FILE);
  if (!existsSync(file)) return "no-cli";
  const real = insideRoots(file, [projectDir], { rootItself: false });
  if (real === null) return "outside";
  const source = readFileSync(real, "utf8");
  if (source.includes(FONT_MAPS_FIXED)) return "already";
  const at = source.indexOf(FONT_MAPS_BROKEN);
  if (at < 0 || source.indexOf(FONT_MAPS_BROKEN, at + 1) >= 0) return "not-found";
  const temporary = `${real}.${process.pid}.tmp`;
  writeFileSync(temporary, source.replace(FONT_MAPS_BROKEN, FONT_MAPS_FIXED));
  renameSync(temporary, real);
  return "patched";
}

// --------------------------------------------------------------------------------------------- what npm's failure says

const SANDBOX = /\b(EPERM|EACCES)\b/;

/**
 * What a failed npm said about the network: null when it is not about the network. `blocked` when the system refused
 * the connection itself (a sandbox), `failed` when the registry could not be reached (offline, a wrong proxy or name).
 * @returns {{ kind: "blocked"|"failed", url: string|null, reason: string } | null}
 */
export function networkFailure(output) {
  const text = plainText(output);
  // npm 11: "npm error network request to <url> failed, reason: getaddrinfo ENOTFOUND <host>" when the name or the
  // host cannot be reached; "npm error FetchError: request to <url> failed, reason: " with code EPERM when a sandbox
  // refuses the connection (macOS sandbox-exec, seen 11.11). A file npm may not write says EPERM too, without a request.
  const request = /npm (?:error|ERR!) (?:network |FetchError: )?request to (\S+) failed, reason: ?(.*)/.exec(text);
  if (!request) return null;
  const code = /npm (?:error|ERR!) code (E[A-Z_]+)/.exec(text)?.[1] ?? null;
  const reason = request[2].trim() || code || "unknown";
  return { kind: SANDBOX.test(reason) || SANDBOX.test(code ?? "") ? "blocked" : "failed", url: request[1], reason };
}
