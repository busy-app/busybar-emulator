// The first run's text for agents (legacy-window/welcome.js, EMU-207): right for the system the app runs on, each of
// its commands one the command line has, with options it takes, and each runnable as written: in the shell of macOS
// (and of Linux) with the path where it is, quotes and all, and on Windows in PowerShell, Git Bash and cmd: in one
// form for all three when the path allows it, else in each shell's own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { execProgram } from "../../engine/programs.mjs";
import { compileCSharp, LAUNCHER_SOURCE } from "../../app/tools/windows-launcher.mjs";
import { loadCommands, parseArguments } from "../cli/busy-emulator.mjs";
import { agentsSection, WINDOWS_CALLS } from "../projects/template-fixes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "legacy-window", "welcome.js"), "utf8");

/** welcome.js on its own, without a page: its text for agents. */
function welcome() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "welcome.js" });
  return sandbox.emulatorWelcome;
}
const { agentText, appPrompt, permissionLine, cliCall, windowsCalls, MCP_GUIDE } = welcome();

const folders = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));
const temporary = () => {
  const folder = mkdtempSync(join(tmpdir(), "welcome-"));
  folders.push(folder);
  return folder;
};

/** The commands of a text, as written: its numbered steps, and the one that lists the rest. [{ line, words }] */
function commandsOf(text, call) {
  const steps = text
    .split("\n")
    .filter((line) => line.startsWith(`${line.slice(0, 3)}${call} `) && /^\d\. /.test(line))
    .map((line) => ({ line, words: line.slice(3 + call.length + 1).split(" ") }));
  const help = text.split("\n").find((line) => line.includes(`${call} help lists`));
  return [...steps, ...(help ? [{ line: help, words: ["help"] }] : [])];
}

test("on macOS the text names the command line by its fixed path and runs the first steps with it", () => {
  const text = agentText({ platform: "darwin", cli: null });
  const call = "~/.busy-emulator/bin/busy-emulator";
  assert.match(text, /^Make an app for BUSY Bar with me\./);
  assert.ok(text.includes(`Use its command line, by its full path: ${call}\n`), text);
  for (const line of [`1. ${call} create my-app`, `2. ${call} dev --once`, `3. ${call} screenshot --scale 8`, `4. ${call} logs`]) assert.ok(text.split("\n").includes(line), line);
  assert.ok(text.includes(`${call} help lists the other commands`));
  assert.match(text, /read its AGENTS\.md first/);
  assert.doesNotMatch(text, /PowerShell|LOCALAPPDATA|\\/);
  // The same with the path the desktop app gives.
  assert.equal(agentText({ platform: "darwin", cli: "~/.busy-emulator/bin/busy-emulator" }), text);
});

/** windowsCalls' answer as an object of this realm, for deepEqual. */
const plainCalls = (cli) => ({ ...windowsCalls(cli) });
const WIN_HOME = "C:\\Users\\user\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe";
const stepsOf = (call) => [`1. ${call} create my-app`, `2. ${call} dev --once`, `3. ${call} screenshot --scale 8`, `4. ${call} logs`];

test("on Windows the launcher's usual path is one form for PowerShell, Git Bash and cmd: forward slashes, no quotes", () => {
  for (const [cli, call] of [
    [WIN_HOME, "C:/Users/user/AppData/Local/busy-emulator/bin/busy-emulator.exe"],
    ["C:\\Users\\Тест\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe", "C:/Users/Тест/AppData/Local/busy-emulator/bin/busy-emulator.exe"],
    ["C:\\Users\\your-name\\AppData\\Local\\busy-emulator.2\\bin\\busy-emulator.exe", "C:/Users/your-name/AppData/Local/busy-emulator.2/bin/busy-emulator.exe"],
  ]) {
    const text = agentText({ platform: "win32", cli });
    assert.equal(cliCall({ platform: "win32", cli }), call);
    assert.deepEqual(plainCalls(cli), { any: call, powershell: call, bash: call, cmd: call });
    assert.ok(text.includes(`Use its command line, by its full path: ${call}\nWrite it as it is, with forward slashes and no quotes: so it runs in PowerShell, Git Bash and cmd alike.\n`), text);
    for (const line of stepsOf(call)) assert.ok(text.split("\n").includes(line), line);
    assert.doesNotMatch(text, /~\/|\\|& |in PowerShell,? by/);
    assert.equal(
      permissionLine({ platform: "win32", cli }),
      `So that your agent does not ask before each step, allow the command ${call} in its permissions (in Claude Code: PowerShell(${call} *) and Bash(${call} *)). That lets it build and run the project's code on this computer.`,
    );
  }
});

test("on Windows a path that needs quotes: PowerShell's & '…' in the steps, and the Git Bash and cmd forms in the line under it", () => {
  const spaced = "C:\\Users\\All Users\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe";
  const ps = "& 'C:\\Users\\All Users\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe'";
  const other = '"C:/Users/All Users/AppData/Local/busy-emulator/bin/busy-emulator.exe"';
  const text = agentText({ platform: "win32", cli: spaced });
  assert.equal(cliCall({ platform: "win32", cli: spaced }), ps);
  assert.ok(text.includes(`Use its command line, by its full path: ${ps}\nThat is for PowerShell, as in the steps below; call it in Git Bash or cmd as ${other}.\n`), text);
  for (const line of stepsOf(ps)) assert.ok(text.split("\n").includes(line), line);
  assert.match(permissionLine({ platform: "win32", cli: spaced }), new RegExp(`allow the command ${spaced.replace(/\\/g, "\\\\")} in its permissions \\(in Claude Code: PowerShell\\(${ps.replace(/[\\()]/g, "\\$&")} \\*\\) and Bash\\(${other} \\*\\)\\)\\. `));
  // A quote is doubled for PowerShell; $ and ` are read in double quotes by Git Bash, so it gets single ones there;
  // % is read by cmd in any quotes, so cmd gets no form.
  assert.deepEqual(plainCalls("C:\\Users\\you\\O'Brien (x)\\b.exe"), { any: null, powershell: "& 'C:\\Users\\you\\O''Brien (x)\\b.exe'", bash: `"C:/Users/you/O'Brien (x)/b.exe"`, cmd: `"C:/Users/you/O'Brien (x)/b.exe"` });
  assert.deepEqual(plainCalls("C:\\Users\\you\\Jo's $x\\b.exe"), { any: null, powershell: "& 'C:\\Users\\you\\Jo''s $x\\b.exe'", bash: `'C:/Users/you/Jo'\\''s $x/b.exe'`, cmd: `"C:/Users/you/Jo's $x/b.exe"` });
  assert.deepEqual(plainCalls("C:\\Program Files\\100%\\b.exe"), { any: null, powershell: "& 'C:\\Program Files\\100%\\b.exe'", bash: `"C:/Program Files/100%/b.exe"`, cmd: null });
  assert.ok(agentText({ platform: "win32", cli: "C:\\Users\\you\\Jo's $x\\b.exe" }).includes(`call it in Git Bash as 'C:/Users/you/Jo'\\''s $x/b.exe', in cmd as "C:/Users/you/Jo's $x/b.exe".\n`));
  assert.ok(agentText({ platform: "win32", cli: "C:\\Program Files\\100%\\b.exe" }).includes(`call it in Git Bash as "C:/Program Files/100%/b.exe".\n`));
});

test("on Windows without a path from the app, each shell's form from its own variable: the same forms as the project's AGENTS.md", () => {
  const calls = windowsCalls(null);
  assert.deepEqual({ ...calls }, { any: null, ...WINDOWS_CALLS });
  const text = agentText({ platform: "win32", cli: null });
  assert.equal(cliCall({ platform: "win32", cli: null }), WINDOWS_CALLS.powershell);
  assert.ok(text.includes(`Use its command line, by its full path: ${WINDOWS_CALLS.powershell}\nThat is for PowerShell, as in the steps below; call it in Git Bash as ${WINDOWS_CALLS.bash}, in cmd as ${WINDOWS_CALLS.cmd}.\n`), text);
  for (const line of stepsOf(WINDOWS_CALLS.powershell)) assert.ok(text.split("\n").includes(line), line);
  const section = agentsSection();
  assert.ok(section.includes(`in PowerShell as \`${WINDOWS_CALLS.powershell}\`, in Git Bash as \`${WINDOWS_CALLS.bash}\`, in cmd as \`${WINDOWS_CALLS.cmd}\``), "AGENTS.md names the same forms");
  assert.ok(section.includes("`~/.busy-emulator/bin/busy-emulator` on macOS"), "and the same macOS path as the text");
  assert.match(permissionLine({ platform: "win32", cli: null }), /allow the command %LOCALAPPDATA%\\busy-emulator\\bin\\busy-emulator\.exe in its permissions \(in Claude Code: PowerShell\(& "\$env:LOCALAPPDATA\\busy-emulator\\bin\\busy-emulator\.exe" \*\) and Bash\("\$LOCALAPPDATA\/busy-emulator\/bin\/busy-emulator\.exe" \*\)\)\. /);
});

// app-column: Copy prompt for AI, on the opened app's page: the same command line, in the same forms, for an app that
// is there; its name, id and folder as they are.
test("the opened app's prompt names the app, its folder and the command line in the platform's form, and asks before publishing", () => {
  const app = { name: "Meeting Cost", id: "app.you.meeting_cost", folder: "/Users/you/Documents/BUSY/meeting-cost" };
  const mac = appPrompt({ platform: "darwin", cli: "~/.busy-emulator/bin/busy-emulator", ...app });
  const call = "~/.busy-emulator/bin/busy-emulator";
  assert.match(mac, /^Work with me on my BUSY Bar app "Meeting Cost" \(app\.you\.meeting_cost\)\./);
  const lines = mac.split("\n");
  for (const line of ["The project is in this folder: /Users/you/Documents/BUSY/meeting-cost", "Work there, and read its AGENTS.md first.", `Use the emulator's command line, by its full path: ${call}`, `1. ${call} dev --once`, `2. ${call} screenshot --scale 8`, `3. ${call} logs`]) assert.ok(lines.includes(line), line);
  assert.match(mac, /shows the new version after dev --once, or when I press Refresh/);
  assert.match(mac, /Ask me before you publish/);
  assert.doesNotMatch(mac, /PowerShell|LOCALAPPDATA|\u00b7|\u2022|\bthe bar\b/);
  // Without a path from the app: the fixed one.
  assert.ok(appPrompt({ platform: "darwin", cli: null, ...app }).includes(`by its full path: ${call}\n`));

  // Windows: the launcher's usual path is one form for every shell; without one, PowerShell's with the other shells' forms.
  const winApp = { ...app, folder: "C:\\Users\\you\\Documents\\BUSY\\meeting-cost" };
  const usual = appPrompt({ platform: "win32", cli: WIN_HOME, ...winApp });
  const forward = "C:/Users/user/AppData/Local/busy-emulator/bin/busy-emulator.exe";
  assert.ok(usual.includes(`The project is in this folder: ${winApp.folder}\n`));
  assert.ok(usual.includes(`by its full path: ${forward}\nWrite it as it is, with forward slashes and no quotes: so it runs in PowerShell, Git Bash and cmd alike.\n`), usual);
  assert.ok(usual.split("\n").includes(`1. ${forward} dev --once`));
  const fallback = appPrompt({ platform: "win32", cli: null, ...winApp });
  assert.ok(fallback.includes(`by its full path: ${WINDOWS_CALLS.powershell}\nThat is for PowerShell, as in the steps below; call it in Git Bash as ${WINDOWS_CALLS.bash}, in cmd as ${WINDOWS_CALLS.cmd}.\n`), fallback);
  assert.ok(fallback.split("\n").includes(`3. ${WINDOWS_CALLS.powershell} logs`));
});

test("a path with spaces or quotes is one word of the shell; a project made for the agent is named instead of created", () => {
  assert.equal(cliCall({ platform: "darwin", cli: "/Users/you/My Apps/.busy-emulator/bin/busy-emulator" }), "'/Users/you/My Apps/.busy-emulator/bin/busy-emulator'");
  assert.equal(cliCall({ platform: "darwin", cli: "~/odd dir/it's/busy-emulator" }), `~/'odd dir/it'\\''s/busy-emulator'`);
  const text = agentText({ platform: "darwin", cli: null, folder: "/Users/you/Documents/my clock" });
  assert.ok(text.includes("1. The project is ready in this folder: /Users/you/Documents/my clock\n"));
  assert.doesNotMatch(text, / create /);
  assert.ok(text.includes("2. ~/.busy-emulator/bin/busy-emulator dev --once"));
});

test("the line about permissions names the command to allow and what allowing it lets the agent do; the MCP guide is the public one", () => {
  const mac = permissionLine({ platform: "darwin", cli: null });
  assert.match(mac, /allow the command ~\/\.busy-emulator\/bin\/busy-emulator in its permissions \(in Claude Code: Bash\(~\/\.busy-emulator\/bin\/busy-emulator \*\)\)/);
  assert.match(mac, /build and run the project's code on this computer/);
  assert.equal(MCP_GUIDE, "https://github.com/busy-app/busybar-emulator/blob/main/public-docs/mcp.md");
  assert.ok(readFileSync(join(here, "..", "..", "..", "public-docs", "mcp.md"), "utf8").length > 0, "the page the link goes to");
});

test("every command of the text is one of the command line's, with options it takes and no more arguments than it takes", async () => {
  const commands = await loadCommands();
  const find = (name) => commands.find((c) => c.name === name);
  for (const [platform, cli] of [["darwin", null], ["win32", null], ["win32", WIN_HOME]]) {
    const call = cliCall({ platform, cli });
    const found = commandsOf(agentText({ platform, cli }), call);
    assert.equal(found.length, 5, found.map((one) => one.line).join("\n"));
    for (const { line, words } of found) {
      const { name, args, unknownOptions, optionProblems } = parseArguments(words, (wanted) => find(wanted)?.options ?? null);
      const command = find(name);
      assert.ok(command, `${line}: no command ${name}`);
      assert.deepEqual([unknownOptions, optionProblems], [[], []], line);
      assert.ok(args.length <= (command.maxArguments ?? 0), line);
    }
  }
});

// The text as a person pastes it, each command in the shell the text is for, against a stand-in for the command line
// that writes down what it was given: the words arrive whole, the path with them.
const STAND_IN_POSIX = (log) => `#!/bin/sh\nfor a in "$@"; do printf '%s|' "$a"; done >> ${JSON.stringify(log)}\nprintf '\\n' >> ${JSON.stringify(log)}\n`;

test("in a POSIX shell each command of the macOS text runs the command line with its words", { skip: process.platform === "win32" && "a POSIX shell" }, () => {
  for (const where of ["home", "odd"]) {
    const root = temporary();
    const home = join(root, "home");
    const log = join(root, "log");
    // In the home folder, as the app writes it; or at a path with spaces and a quote, as the pointer file may name it.
    const launcher = where === "home" ? join(home, ".busy-emulator", "bin", "busy-emulator") : join(root, "Ann's Mac", "bin dir", "busy-emulator");
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, STAND_IN_POSIX(log));
    chmodSync(launcher, 0o755);
    const cli = where === "home" ? null : launcher;
    const call = cliCall({ platform: "darwin", cli });
    const found = commandsOf(agentText({ platform: "darwin", cli }), call);
    for (const { line } of found) {
      const command = /^\d\. /.test(line) ? line.slice(3) : `${call} help`;
      execFileSync("/bin/sh", ["-c", command], { cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home } });
    }
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["create|my-app|", "dev|--once|", "screenshot|--scale|8|", "logs|", "help|"], where);
  }
});

// On Windows: the text's commands in each shell an agent may run them in (Codex and Cursor: Windows PowerShell;
// Claude Code: its PowerShell tool, PowerShell 7 when there is one, and its Bash tool, Git Bash; and cmd), as the
// text writes them for that shell, against the real launcher (launcher/windows/busy-emulator.cs) at the fixed place
// in a home of the test's: the usual one, one with a space, one in Cyrillic, one with both. The launcher's .launch
// names this Node and a script that writes down the words it got.
const SHELLS = (() => {
  if (process.platform !== "win32") return [];
  const windows = process.env.SystemRoot || "C:\\Windows";
  const programs = process.env.ProgramFiles || "C:\\Program Files";
  const encoded = (command) => ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
  return [
    { name: "Windows PowerShell", form: "powershell", file: join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), args: encoded },
    { name: "PowerShell 7", form: "powershell", file: join(programs, "PowerShell", "7", "pwsh.exe"), args: encoded },
    { name: "Git Bash", form: "bash", file: join(programs, "Git", "bin", "bash.exe"), args: (command) => ["-c", command] },
    { name: "cmd", form: "cmd", file: join(windows, "System32", "cmd.exe"), args: (command) => ["/d", "/s", "/c", `"${command}"`], verbatim: true },
  ].filter((shell) => existsSync(shell.file));
})();

test("on Windows each command of the text runs the command line with its words in PowerShell, Git Bash and cmd", { skip: process.platform !== "win32" && "Windows shells", timeout: 300_000 }, () => {
  const root = temporary();
  const exe = compileCSharp(LAUNCHER_SOURCE, join(root, "busy-emulator.exe"));
  const script = join(root, "words.mjs");
  writeFileSync(script, `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.WELCOME_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  const log = join(root, "log");
  const ran = [];
  for (const user of ["User", "Ann Lee", "Тест", "Тест Имя"]) {
    const local = join(root, "Users", user, "AppData", "Local");
    const launcher = join(local, "busy-emulator", "bin", "busy-emulator.exe");
    mkdirSync(dirname(launcher), { recursive: true });
    copyFileSync(exe, launcher);
    writeFileSync(join(dirname(launcher), "busy-emulator.launch"), `${process.execPath}\r\n${script}\r\n`);
    // With the path the app gives, and without one (each shell's variable for the folder).
    for (const cli of [launcher, null]) {
      const text = agentText({ platform: "win32", cli });
      const call = cliCall({ platform: "win32", cli });
      const calls = windowsCalls(cli);
      for (const shell of SHELLS) {
        const own = calls[shell.form];
        if (!own) continue;
        if (own !== call) assert.ok(text.includes(own), `the text names the form for ${shell.name}: ${own}`);
        rmSync(log, { force: true });
        for (const { line } of commandsOf(text, call)) {
          const command = `${own} ${/^\d\. /.test(line) ? line.slice(3 + call.length + 1) : "help"}`;
          try {
            execProgram(shell.file, shell.args(command), { cwd: root, env: { ...process.env, LOCALAPPDATA: local, WELCOME_TEST_LOG: log }, windowsVerbatimArguments: shell.verbatim === true, encoding: "utf8", stdio: "pipe", windowsHide: true, timeout: 60_000 });
          } catch (e) {
            assert.fail(`${shell.name}: ${command}\n${e.stdout ?? ""}${e.stderr ?? e.message}`);
          }
        }
        const words = existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/).map((one) => JSON.parse(one)) : [];
        assert.deepEqual(words, [["create", "my-app"], ["dev", "--once"], ["screenshot", "--scale", "8"], ["logs"], ["help"]], `${shell.name}, ${user}, ${cli ? "the app's path" : "the variable"}`);
        ran.push(`${shell.name}/${user}/${cli ? "path" : "variable"}`);
      }
    }
  }
  assert.ok(ran.some((one) => one.startsWith("Windows PowerShell/")) && ran.some((one) => one.startsWith("cmd/")), ran.join(", "));
});
