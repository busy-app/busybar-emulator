// Tests of programs.mjs: programs are found on PATH, never in the current folder, and batch files get their arguments
// as given. The lookup rules run everywhere on a made-up file system; what Windows itself does — a planted git.exe, a
// batch file through cmd.exe, the engine's build — runs on Windows only.
//
//   node --test packages/engine/test/programs.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { batchCommandLine, execProgram, findProgram, isProgramFile, ProgramNotFound, programCommand } from "../programs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, "..");
const EMULATOR = join(ENGINE, "../..");
const WINDOWS = process.platform === "win32";
const onWindows = { skip: !WINDOWS && "Windows only: elsewhere a program is looked up on PATH alone" };

/** A made-up file system for findProgram: these files exist, nothing else. */
const only = (...files) => (file) => files.includes(file);

describe("findProgram", () => {
  test("outside Windows the name is passed on as it is, and so are the caller's options", () => {
    assert.equal(findProgram("git", { platform: "darwin", env: { PATH: "." } }), "git");
    const options = { cwd: "/somewhere", env: { PATH: "/usr/bin" } };
    const c = programCommand("git", ["status"], options, { platform: "darwin" });
    assert.deepEqual(c, { file: "git", args: ["status"], options });
    assert.equal(c.options, options, "the options are not copied or changed");
  });

  test("on Windows only absolute folders of PATH are searched: '.', empty and relative entries are the current folder", () => {
    const env = { Path: `.;;relative\\bin;"."; ;C:relative` };
    assert.throws(
      () => findProgram("git", { platform: "win32", env, exists: () => true }),
      (e) => e instanceof ProgramNotFound && e.code === "ENOENT" && e.message === "git is not on PATH; install it or add its folder to PATH",
    );
  });

  test("on Windows folders come first, then the PATHEXT order; quotes are taken off; names of variables ignore case", () => {
    const env = { path: 'C:\\a;"C:\\p\\b c";C:\\d', pathext: ".JS;.EXE;.CMD" };
    const exists = only("C:\\a\\git.js", "C:\\p\\b c\\git.cmd", "C:\\d\\git.exe", "C:\\p\\b c\\git.exe");
    assert.equal(findProgram("git", { platform: "win32", env, exists }), "C:\\p\\b c\\git.exe", ".exe before .cmd in the same folder, .js is not startable");
    assert.equal(findProgram("git", { platform: "win32", env: { ...env, pathext: ".CMD;.EXE" }, exists }), "C:\\p\\b c\\git.cmd");
    assert.equal(findProgram("git", { platform: "win32", env: { PATH: "C:\\d" }, exists }), "C:\\d\\git.exe", "no PATHEXT: .COM;.EXE;.BAT;.CMD");
    assert.equal(findProgram("git", { platform: "win32", env: { PATH: "C:\\d", PATHEXT: "" }, exists }), "C:\\d\\git.exe", "an empty PATHEXT");
    assert.equal(findProgram("git", { platform: "win32", env: { PATH: "C:\\d", PATHEXT: ".JS;.VBS" }, exists }), "C:\\d\\git.exe", "nothing startable in PATHEXT");
    // { ...process.env, PATH } on Windows has "Path" and "PATH"; Node passes the child the first in sorted order
    assert.equal(findProgram("git", { platform: "win32", env: { Path: "C:\\d", PATH: "C:\\p\\b c" }, exists }), "C:\\p\\b c\\git.exe");
  });

  test("a file or a link to one is a program; a folder, a link to one and a dangling link are not", (t) => {
    const root = temp(t);
    writeFileSync(join(root, "tool.exe"), "");
    mkdirSync(join(root, "folder.exe"));
    try {
      symlinkSync(join(root, "tool.exe"), join(root, "link.exe"), "file");
      symlinkSync(join(root, "folder.exe"), join(root, "folder-link.exe"), "dir");
      symlinkSync(join(root, "gone.exe"), join(root, "dangling.exe"), "file");
    } catch (error) {
      return t.skip(`cannot make links here: ${error.code}`);
    }
    const said = Object.fromEntries(["tool.exe", "folder.exe", "link.exe", "folder-link.exe", "dangling.exe", "none.exe"].map((n) => [n, isProgramFile(join(root, n))]));
    assert.deepEqual(said, { "tool.exe": true, "folder.exe": false, "link.exe": true, "folder-link.exe": false, "dangling.exe": false, "none.exe": false });
  });

  test("on Windows a name with an extension is looked for as it is; a name with a folder is not looked up", () => {
    const exists = only("C:\\a\\emcc.exe", "C:\\d\\emcc.bat");
    assert.equal(findProgram("emcc.bat", { platform: "win32", env: { PATH: "C:\\a;C:\\d" }, exists }), "C:\\d\\emcc.bat");
    assert.equal(findProgram("emcc", { platform: "win32", env: { PATH: "C:\\a;C:\\d" }, exists }), "C:\\a\\emcc.exe");
    assert.equal(findProgram("C:\\t\\python.exe", { platform: "win32", env: { PATH: "" }, exists }), "C:\\t\\python.exe");
    assert.equal(findProgram(".\\python", { platform: "win32", env: { PATH: "" }, exists }), ".\\python");
  });
});

describe("programCommand on Windows", () => {
  const lookup = { platform: "win32", exists: only("C:\\g\\cmd\\git.exe", "C:\\p\\e m\\emcc.bat") };
  const env = { PATH: "C:\\g\\cmd;C:\\p\\e m", ComSpec: "C:\\Windows\\system32\\cmd.exe" };

  test("a program is started by its full path; its children do not look in the current folder either", () => {
    const options = { cwd: "C:\\work", env };
    const c = programCommand("git", ["status"], options, lookup);
    assert.equal(c.file, "C:\\g\\cmd\\git.exe");
    assert.deepEqual(c.args, ["status"]);
    assert.equal(c.options.cwd, "C:\\work");
    assert.equal(c.options.env.NoDefaultCurrentDirectoryInExePath, "1");
    assert.equal(c.options.env.PATH, env.PATH);
    assert.equal(env.NoDefaultCurrentDirectoryInExePath, undefined, "the caller's env is not changed");
    assert.equal(c.options.windowsVerbatimArguments, undefined);
  });

  test("a batch file goes through cmd.exe with one quoted line", () => {
    const c = programCommand("emcc", ["-o", "a b.o"], { env }, lookup);
    assert.equal(c.file, "C:\\Windows\\system32\\cmd.exe");
    assert.deepEqual(c.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
    assert.equal(c.args[4], batchCommandLine("C:\\p\\e m\\emcc.bat", ["-o", "a b.o"]));
    assert.equal(c.options.windowsVerbatimArguments, true);
    assert.equal(c.options.env.NoDefaultCurrentDirectoryInExePath, "1");
    assert.equal(programCommand("emcc", [], { env: { PATH: env.PATH, SystemRoot: "D:\\Windows" } }, lookup).file, "D:\\Windows\\System32\\cmd.exe", "no ComSpec");
  });

  test("the batch line: the file escaped once, each argument quoted and escaped twice", () => {
    assert.equal(
      batchCommandLine("C:\\p\\x y\\e.bat", ['a"b', "c&d", "e\\", "f\\\\"]),
      '"C:\\p\\x^ y\\e.bat ^^^"a\\^^^"b^^^" ^^^"c^^^&d^^^" ^^^"e\\\\^^^" ^^^"f\\\\\\\\^^^""',
    );
    // a % goes as %%cd:~,%: no %name% or %name:a=b% is left for cmd.exe to expand, in the file's path either
    assert.equal(batchCommandLine("C:\\p\\%OS%\\e.bat", ["%OS:W=w%", "^%"]), '"C:\\p\\%%cd:~,%OS%%cd:~,%\\e.bat ^^^"%%cd:~,%OS:W=w%%cd:~,%^^^" ^^^"^^^^%%cd:~,%^^^""');
  });

  test("what cmd.exe cannot carry is refused, not cut", () => {
    assert.throws(() => batchCommandLine("C:\\e.bat", ["a\nb"]), /cannot pass an argument with a line break or NUL to e\.bat/);
    assert.throws(() => batchCommandLine("C:\\e.bat", ["x".repeat(8200)]), /cmd\.exe takes 8191: use a response file/);
  });
});

/**
 * What a file does with child_process that the rule forbids: a program named other than by an absolute path or
 * process.execPath, exec and execSync (a shell), shell in the options, /usr/bin/env, child_process taken by require or
 * import(), a function of it imported under another name or used other than by calling it (promisify(execFile),
 * const run = spawn). Comments are dropped first. Each finding is "<line>: <what>".
 *
 * Not seen: a program started by another module that is handed a child_process function or a command (the check is
 * per file); child_process reached some other way (process.binding, a library such as execa, a worker); a call whose
 * first argument is a string literal with an absolute path built to name something else; the files the walk skips.
 */
function childProcessProblems(text) {
  const FUNCTIONS = ["execFileSync", "execFile", "spawnSync", "spawn", "execSync", "exec", "fork"];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const line = (index) => code.slice(0, index).split("\n").length;
  const found = [];
  const names = new Set();
  const spaces = new Set();
  const imports = [];
  for (const m of code.matchAll(/import\s+([^;]*?)\s+from\s+["'](?:node:)?child_process["']/g)) {
    imports.push([m.index, m.index + m[0].length]);
    const clause = m[1];
    for (const ns of clause.matchAll(/\*\s+as\s+([\w$]+)|^([\w$]+)\s*(?:,|$)/g)) spaces.add(ns[1] ?? ns[2]);
    for (const part of /\{([^}]*)\}/.exec(clause)?.[1].split(",") ?? []) {
      const [name, local] = part.trim().split(/\s+as\s+/);
      if (!name) continue;
      if (local && local !== name) found.push(`${line(m.index)}: ${name} imported as ${local}`);
      names.add(name);
    }
  }
  for (const m of code.matchAll(/\b(require|import)\s*\(\s*["'](?:node:)?child_process["']/g)) found.push(`${line(m.index)}: child_process by ${m[1]}()`);
  const inImport = (index) => imports.some(([from, to]) => index >= from && index < to);
  const callees = [...names].filter((n) => FUNCTIONS.includes(n));
  const patterns = [];
  if (callees.length) patterns.push(`(?<![\\w$.])(${callees.join("|")})(?![\\w$])`);
  if (spaces.size) patterns.push(`(?<![\\w$.])(?:${[...spaces].join("|")})\\.(${FUNCTIONS.join("|")})\\b`);
  for (const pattern of patterns) {
    for (const m of code.matchAll(new RegExp(pattern, "g"))) {
      if (inImport(m.index)) continue;
      const call = m[1];
      const rest = code.slice(m.index + m[0].length);
      const open = /^\s*\(\s*/.exec(rest);
      if (!open) {
        found.push(`${line(m.index)}: ${call} used other than by calling it`);
        continue;
      }
      if (call === "fork") continue; // runs a module with this Node
      const first = /^(?:"([^"]*)"|'([^']*)'|`([^`]*)`|([^,)]*))/.exec(rest.slice(open[0].length));
      const literal = first[1] ?? first[2] ?? first[3];
      const what = literal === undefined ? first[4].trim() : JSON.stringify(literal);
      if (call === "exec" || call === "execSync") found.push(`${line(m.index)}: ${call}(${what}) goes through a shell`);
      else if (literal === undefined ? what !== "process.execPath" : !/^(\/|[A-Za-z]:\\)/.test(literal) || /^\/usr\/bin\/env$/.test(literal)) found.push(`${line(m.index)}: ${call}(${what})`);
    }
  }
  if (names.size || spaces.size) {
    for (const m of code.matchAll(/\bshell\s*:|[{,]\s*shell\s*[,}]/g)) found.push(`${line(m.index)}: shell in the options`);
  }
  return found;
}

describe("no program is started by a bare name", () => {
  // Every start in emulator/ goes through programs.mjs, or names the program by an absolute path. Not looked at: the
  // desktop shell (packages/app, changed in its own branch), documents, prototypes, programs.mjs itself and this file,
  // which starts a bare "git" on purpose. What the scan of a file does not see is listed at childProcessProblems.
  const SKIP = new Set(["node_modules", "docs", "spike", "stage-prototype", "logs"]);
  const skipped = (rel) => ["packages/app", "packages/engine/build", "packages/engine/programs.mjs"].includes(rel) || rel.split("/").some((part) => SKIP.has(part) || part.startsWith(".data"));
  const sources = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const rel = relative(EMULATOR, file).replaceAll("\\", "/");
      if (entry.name.startsWith(".") || skipped(rel)) continue;
      if (entry.isDirectory()) walk(file);
      else if (/\.(mjs|cjs|js)$/.test(entry.name) && file !== fileURLToPath(import.meta.url)) sources.push(rel);
    }
  })(EMULATOR);

  test("child_process is called with absolute program paths only, and never through a shell", () => {
    // tools/ is not in the public repository (its export leaves it out); where it is, the walk must see it.
    const withTools = existsSync(join(EMULATOR, "tools"));
    assert.ok(sources.includes("packages/engine/build.mjs") && (!withTools || sources.includes("tools/export-check/check.mjs")), "the walk sees the tree");
    const found = sources.flatMap((rel) => childProcessProblems(readFileSync(join(EMULATOR, rel), "utf8")).map((f) => `${rel}:${f}`));
    assert.deepEqual(found, [], "start these through programs.mjs (execProgram, spawnProgram, findProgram)");
  });

  test("the scan sees the other ways of writing a start", () => {
    const forms = {
      "a template for a shell": 'import { execSync } from "node:child_process";\nexecSync(`git rev-parse ${v}`);',
      "a renamed import": 'import { spawn as run } from "node:child_process";\nrun("git", ["status"]);',
      "createRequire": 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nconst cp = require("child_process");\ncp.execFileSync("git");',
      "a dynamic import": 'const cp = await import("node:child_process");\ncp.spawn("git");',
      "a namespace import": 'import * as cp from "node:child_process";\ncp.spawnSync("git", ["status"]);',
      "a default import": 'import cp from "child_process";\ncp.spawnSync("git");',
      "a name in a variable": 'import { execFileSync } from "node:child_process";\nconst GIT = "git";\nexecFileSync(GIT, ["status"]);',
      "a call over several lines": 'import { execFileSync } from "node:child_process";\nexecFileSync(\n  "git",\n  ["status"],\n);',
      "/usr/bin/env": 'import { spawn } from "node:child_process";\nspawn("/usr/bin/env", ["git"]);',
      "shell: an expression": 'import { spawn } from "node:child_process";\nspawn("/bin/a", [], { shell: process.platform === "win32" });',
      "shell, short": 'import { spawn } from "node:child_process";\nconst shell = true;\nspawn("C:\\\\x\\\\a.exe", [], { shell });',
      "promisify": 'import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nawait run("git");',
      "an alias": 'import { spawn } from "node:child_process";\nconst run = spawn;\nrun("git");',
    };
    for (const [form, text] of Object.entries(forms)) assert.notDeepEqual(childProcessProblems(text), [], form);
    const fine = 'import { spawn, fork } from "node:child_process";\n// spawn("git") in a comment\nspawn(process.execPath, ["x"]);\nspawn(\n  "/usr/bin/tar",\n  [],\n);\nfork("./x.mjs");';
    assert.deepEqual(childProcessProblems(fine), []);
  });
});

// ---------------------------------------------------------------- what Windows does

/**
 * A folder of planted programs: copies of node.exe named `names`, which print PLANTED <name> and stop when they run —
 * NODE_OPTIONS loads planted.cjs into every Node, and it speaks only in a Node that is not called node.exe.
 */
function plant(root, names) {
  const dir = join(root, "planted");
  mkdirSync(dir, { recursive: true });
  for (const name of names) copyFileSync(process.execPath, join(dir, name));
  const hook = join(root, "planted.cjs");
  writeFileSync(hook, `const n = require("path").basename(process.execPath); if (!/^node\\.exe$/i.test(n)) { process.stdout.write("PLANTED " + n + "\\n"); process.exit(97); }\n`);
  return { dir, env: { ...process.env, NODE_OPTIONS: `--require "${hook.replaceAll("\\", "/")}"` } }; // NODE_OPTIONS reads \\ as an escape
}

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "emu-programs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
};

describe("on Windows", () => {
  test("a git.exe in the current folder is not started in place of git", onWindows, (t) => {
    const { dir, env } = plant(temp(t), ["git.exe"]);
    // The danger, as Windows has it: started by its bare name, the planted git runs.
    // ("git version", not "git --version": a Node answers --version before it loads anything)
    assert.match(spawnSync("git", ["version"], { cwd: dir, env, encoding: "utf8" }).stdout, /^PLANTED git\.exe/);
    assert.match(execProgram("git", ["version"], { cwd: dir, env, encoding: "utf8" }), /^git version /);
    // With no cwd the child starts in the current folder of the process: the case of the engine's build.
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "programs.mjs")).href)}); process.stdout.write(m.execProgram("git", ["version"], { encoding: "utf8" }));`], { cwd: dir, env, encoding: "utf8" });
    assert.match(child.stdout, /^git version /, child.stderr);
  });

  test("the store's app aliases count as programs, as they do for Windows", onWindows, (t) => {
    // stat refuses them (EACCES): whether one is there is told by the folder's listing
    const aliases = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WindowsApps");
    let names = [];
    try {
      names = readdirSync(aliases).map((n) => n.toLowerCase());
    } catch {}
    if (!names.includes("python.exe")) return t.skip(`no python alias in ${aliases}`);
    assert.equal(findProgram("python", { env: { PATH: aliases } }), join(aliases, "python.exe"));
  });

  test("a batch file gets its arguments as given: spaces, quotes, &, %, ^, ! and backslashes", onWindows, (t) => {
    const root = temp(t);
    const dir = join(root, "with space (x86) & co %OS% %%");
    mkdirSync(dir);
    writeFileSync(join(dir, "args.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(join(dir, "show-args.cmd"), `@"${process.execPath}" "%~dp0args.js" %*\r\n`);
    const args = ["a b", '"quoted"', 'a"b', "a & echo INJECTED", "x | more", "%PATH%", "%OS%", "%%", "100%", "%~dp0", "%1", "!OS!", "^", "(x)", "<>", "C:\\Program Files (x86)\\x", "dir\\", "a\\\\", 'a\\"b', "", '-DX="1 2"', "a=b", "x,y;z", "\t tab", "\u00e9t\u00e9 \u4e2d", "%OS:W=w%", "%PATH:\\=/%", "%OS:~0,3%", "%CMDCMDLINE:^=%", "%cd:~,%", "%CD%", "%", "a%", "%%OS%%", "^%OS^%", "%^%"];
    const env = { ...process.env, PATH: `${dir};${process.env.PATH}` };
    assert.deepEqual(JSON.parse(execProgram(join(dir, "show-args.cmd"), args, { encoding: "utf8" })), args);
    assert.deepEqual(JSON.parse(execProgram("show-args", args, { env, encoding: "utf8" })), args, "found on PATH through PATHEXT");
  });

  // EMU-237 review, H1: ^ does not stop cmd.exe from expanding %name:a=b% on its command line; with a crafted
  // argument it ran a command of its own. Each list goes alone, as the reviewer's injection.mjs sent it.
  test("a % in an argument is not expanded, and nothing in an argument runs as a command", onWindows, (t) => {
    const root = temp(t);
    writeFileSync(join(root, "args.js"), "process.stdout.write('ARGS ' + JSON.stringify(process.argv.slice(2)) + '\\n')");
    const batch = join(root, "show-args.cmd");
    writeFileSync(batch, `@"${process.execPath}" "%~dp0args.js" %*\r\n`);
    for (const args of [["%CMDCMDLINE:^=%^&echo.INJECTED"], ["%CMDCMDLINE:^=%", "^&echo.INJECTED&"], ["%OS:W=w%"], ["%PATH:\\=/%"], ["%COMSPEC:~0,1%&echo.INJECTED"]]) {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "programs.mjs")).href)}); process.stdout.write(m.execProgram(${JSON.stringify(batch)}, ${JSON.stringify(args)}, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));`], { encoding: "utf8" });
      assert.doesNotMatch(r.stdout, /^INJECTED/m, `${JSON.stringify(args)} ran a command`);
      assert.equal(r.stdout, `ARGS ${JSON.stringify(args)}\n`, `${JSON.stringify(args)}: ${r.stderr}`);
    }
  });

  test("a batch file does not take the programs it starts from the current folder", onWindows, (t) => {
    const root = temp(t);
    const { dir, env } = plant(root, ["marker.exe"]);
    const batch = join(root, "call-marker.cmd");
    writeFileSync(batch, "@marker\r\n");
    // The danger: cmd.exe looks in the current folder first.
    const bare = spawnSync(process.env.ComSpec, ["/d", "/c", batch], { cwd: dir, env, encoding: "utf8" });
    assert.match(bare.stdout, /^PLANTED marker\.exe/);
    const safe = spawnSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "programs.mjs")).href)}); try { m.execProgram(${JSON.stringify(batch)}, [], { stdio: "pipe" }); } catch (e) { process.stdout.write(String(e.stdout) + String(e.stderr)); }`], { cwd: dir, env, encoding: "utf8" });
    assert.doesNotMatch(safe.stdout, /PLANTED/);
    assert.match(safe.stdout, /'marker' is not recognized/);
  });

  // The engine's build, as far as it goes without emsdk and firmware: a stand-in emcc.bat on PATH answers --version, a
  // folder with one commit stands in for the firmware, and git, asked for a commit it does not have, stops the build
  // (the error names the git that ran; its own words depend on the language).
  // Started from a folder with a planted git.exe and python.exe, the build must use the real ones.
  test("the engine's build finds emcc.bat, git and Python on PATH, not in the current folder", onWindows, async (t) => {
    const root = temp(t);
    const { dir, env } = plant(root, ["git.exe", "python.exe", "tar.exe"]);
    const engine = join(root, "engine");
    for (const file of ["build.mjs", "checks.mjs", "patches.mjs", "programs.mjs", "firmware.json", "apps-assets.json"]) cpSync(join(ENGINE, file), join(engine, file));
    cpSync(join(ENGINE, "build", "apps-assets"), join(engine, "build", "apps-assets"), { recursive: true });
    const firmware = join(root, "firmware");
    mkdirSync(firmware);
    const git = (...a) => execProgram("git", ["-C", firmware, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...a], { stdio: "pipe" });
    git("init", "-q");
    writeFileSync(join(firmware, "README"), "stand-in\n");
    git("add", ".");
    git("commit", "-q", "-m", "stand-in");
    const version = JSON.parse(readFileSync(join(ENGINE, "firmware.json"), "utf8")).emscripten;
    const tools = join(root, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "emcc.bat"), `@echo emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${version} (stand-in)\r\n`);
    const first = Object.keys(JSON.parse(readFileSync(join(ENGINE, "firmware.json"), "utf8")).versions)[0];
    const realGit = findProgram("git");
    const PATH = [tools, dirname(realGit), join(process.env.SystemRoot, "System32")].join(";");
    const build = (emsdk, more = []) =>
      spawnSync(process.execPath, [join(engine, "build.mjs"), "--firmware", first, "--emsdk", emsdk, "--firmware-repo", firmware, "--work", join(root, "work")], {
        cwd: dir,
        env: { ...env, PATH: [...more, PATH].join(";"), EMSDK: "" },
        encoding: "utf8",
      });

    await t.test("emcc.bat on PATH", () => {
      const r = build(join(root, "no-emsdk"));
      const said = r.stdout + r.stderr;
      assert.doesNotMatch(said, /PLANTED/);
      assert.doesNotMatch(said, /Cannot run the Emscripten compiler/);
      assert.ok(said.includes(`Command failed: ${realGit} -C ${firmware} archive`), `the real git answered, by its full path:\n${said}`);
      assert.equal(r.status, 1);
    });

    await t.test("emsdk's emcc.py run by Python on PATH", (t) => {
      let python;
      try {
        python = findProgram("python");
        execProgram(python, ["-c", "pass"], { stdio: "ignore" });
      } catch {
        return t.skip("no working python on PATH");
      }
      const emsdk = join(root, "emsdk");
      mkdirSync(join(emsdk, "upstream", "emscripten"), { recursive: true });
      writeFileSync(join(emsdk, "upstream", "emscripten", "emcc.py"), `print("emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) ${version} (stand-in)")\n`);
      const r = build(emsdk, [dirname(python)]);
      const said = r.stdout + r.stderr;
      assert.doesNotMatch(said, /PLANTED/);
      assert.doesNotMatch(said, /Cannot run the Emscripten compiler/);
      assert.ok(said.includes(`Command failed: ${realGit} -C ${firmware} archive`), `the real git answered, by its full path:\n${said}`);
      assert.equal(r.status, 1);
    });
  });
});
