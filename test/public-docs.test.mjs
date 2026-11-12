// The documentation's own test (EMU-165): what public-docs/ tells people and agents to type must work.
//
// - Every fenced block names its language. Shell blocks are parsed: sh with zsh (or bash, or sh) on macOS and Linux;
//   PowerShell with PowerShell's own parser on Windows. Where that shell is not on the machine, a check of quotes and
//   brackets stands in, and the test says which ran.
// - Every call of the emulator's command line, in a block or in `code` in the text, names a command it has, with
//   options it takes and no more arguments than it takes. Commands that are documented before they are merged are
//   listed in AWAITED_COMMANDS and reported, not checked.
// - The calls that need no app and no network (help, version, status, screenshot, logs, press) are run: with the command line of
//   this tree, against an emulator this test starts with a data folder of its own, and a stand-in of the app's state
//   mirror (logs too, but for --follow). Every other command line is listed as not run, with the reason: those need a release (start, quit), the
//   npm registry or a built project, or are not the emulator's (curl, cd, lsof).
// - Release addresses name files a release has; links between the pages lead to a page and a heading that are there.
// - No Cyrillic in public-docs/.
//
// The texts for the agents' instructions outside this repository (docs/requests/agents-md-no-device.md, not exported)
// are checked the same way, but for links. Ports: one free port (EMU_TEST_PORTS may name it).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { ALL_RELEASE_FILES } from "../packages/app/tools/packaging/names.mjs";
import { execProgram } from "../packages/engine/programs.mjs";
import { loadCommands, parseArguments } from "../packages/server/cli/busy-emulator.mjs";
import { startServer } from "../packages/server/server.mjs";
import { finish, node, port, tempDir } from "./server/helpers.mjs";

after(finish);

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, ".."); // emulator/
const DOCS = join(root, "public-docs");
const CLI = join(root, "packages", "server", "cli", "busy-emulator.mjs");
const EXTRA = [join(root, "docs", "requests", "agents-md-no-device.md")];
const windows = process.platform === "win32";

// Documented before the work that adds them is merged: reported as not checked until they are there.
const AWAITED_COMMANDS = {};
const AWAITED_FILES = {
  "install.md": "EMU-211, pull request 35",
  "install/install-macos.sh": "EMU-211, pull request 35",
  "install/install-windows.ps1": "EMU-211, pull request 35",
};
// The commands this test runs, and why each other one is not run.
const RUN = new Set(["help", "version", "status", "screenshot", "logs", "press"]);
// A call that never ends by itself is not run.
const ENDLESS = (args) => args.includes("--follow");
const NOT_RUN = {
  start: "starts the app, which this tree does not have: needs a release",
  quit: "ends the app's process: needs a release",
  create: "downloads the template from the npm registry; runs on the app's own Node",
  build: "needs the project's dependencies from the npm registry",
  install: "needs a built project",
  run: "needs a project installed on the bar",
  stop: "needs a project installed on the bar",
  dev: "needs the project's dependencies from the npm registry; test/server/dev.test.mjs runs it",
  check: "needs a project; run on one in packages/server/readiness/test/check.test.mjs",
  submit: "needs a built project; run on one in packages/server/readiness/test/check.test.mjs",
  settings: "needs an app with settings on the bar; test/server/agent-hands.test.mjs and created-project.test.mjs run it",
  typecheck: "needs the project's dependencies from the npm registry; test/server/created-project.test.mjs runs it",
  trust: "asks the person through the app; packages/app/test/app/trust.test.mjs runs it",
  mcp: "serves MCP on stdin until the client closes it; test/server/mcp.test.mjs runs it",
  record: "needs the app, whose hidden page encodes the video; packages/app/test/app/record.test.mjs runs it",
};

const SHELLS = { sh: "sh", "shell": "sh", zsh: "sh", bash: "sh", powershell: "powershell", ps1: "powershell", pwsh: "powershell", bat: "cmd", cmd: "cmd", batch: "cmd" };
const OTHER = new Set(["text", "json", "markdown", "md", "js", "mjs", "ts", "yaml", "yml", "diff", "csharp"]);

// ---------------------------------------------------------------- reading the pages

function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}
const allFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));

/**
 * The fenced blocks of a page and its other lines. A block in Markdown (```markdown, as the texts for other files are
 * written) is read for blocks of its own. { blocks: [{ lang, body, line }], prose: [{ text, line }] }; lines count
 * from 1.
 */
function parseMarkdown(text, firstLine = 1) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const prose = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]);
    if (!open) {
      prose.push({ text: lines[i], line: firstLine + i });
      continue;
    }
    const [, fence, lang] = open;
    const indent = lines[i].length - lines[i].trimStart().length;
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      if (close.test(lines[j])) break;
      body.push(lines[j].slice(Math.min(indent, lines[j].length - lines[j].trimStart().length)));
    }
    assert.ok(j < lines.length, `line ${firstLine + i}: a block that is never closed`);
    const block = { lang: lang.toLowerCase(), body: body.join("\n"), line: firstLine + i + 1 };
    if (block.lang === "markdown" || block.lang === "md") {
      const inner = parseMarkdown(block.body, block.line);
      blocks.push(...inner.blocks);
      prose.push(...inner.prose);
    } else blocks.push(block);
    i = j;
  }
  return { blocks, prose };
}

const pages = [...markdownFiles(DOCS), ...EXTRA.filter(existsSync)].map((file) => ({ file, name: relative(root, file).split(sep).join("/"), public: file.startsWith(DOCS + sep), ...parseMarkdown(readFileSync(file, "utf8")) }));

// ---------------------------------------------------------------- command lines

/** The lines of a block as one command each: a line ending in \ (sh) or ` (PowerShell) goes on on the next. */
function commandLines(block) {
  const out = [];
  let pending = null;
  block.body.split("\n").forEach((text, i) => {
    const line = block.line + i;
    const joined = pending ? { text: `${pending.text} ${text.trim()}`, line: pending.line } : { text, line };
    const more = SHELLS[block.lang] === "powershell" ? /`$/ : /\\$/;
    if (more.test(text) && SHELLS[block.lang] !== "cmd") pending = { text: joined.text.replace(more, ""), line: joined.line };
    else {
      pending = null;
      if (joined.text.trim()) out.push(joined);
    }
  });
  return out;
}

/** Splits a command line at ;, &&, || and | outside quotes. */
function segments(text) {
  const parts = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      current += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      current += c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) break;
    else if (c === ";" || (c === "|" && text[i + 1] !== "|") || ((c === "&" || c === "|") && text[i + 1] === c)) {
      parts.push(current);
      current = "";
      if (c !== ";" && text[i + 1] === c) i++;
    } else current += c;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Words of a shell line, quotes taken off. */
function words(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// The ways the pages call the command line: by name, by its fixed path on each system, by a variable, or by the
// placeholder <cli>.
const CLI_CALL = new RegExp(
  "^(?:" +
    [
      String.raw`busy-emulator`,
      String.raw`~/\.busy-emulator/bin/busy-emulator`,
      String.raw`&\s*\$cli`,
      String.raw`"\$cli"`,
      String.raw`&\s*['"]<cli>['"]`,
      String.raw`"<cli>"`,
      String.raw`<cli>`,
      String.raw`&\s*"\$env:LOCALAPPDATA\\busy-emulator\\bin\\busy-emulator\.exe"`,
      String.raw`"%LOCALAPPDATA%\\busy-emulator\\bin\\busy-emulator\.exe"`,
      String.raw`"\$LOCALAPPDATA/busy-emulator/bin/busy-emulator\.exe"`,
    ].join("|") +
    String.raw`)(?=\s|$)`,
);
/** The arguments of a call of the command line, or null for anything else. */
function cliArguments(segment) {
  const m = CLI_CALL.exec(segment);
  return m ? words(segment.slice(m[0].length)) : null;
}

/** Every call of the command line in the pages: { page, line, args, inBlock, source }. Other command lines too. */
function calls() {
  const found = [];
  const other = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      if (!SHELLS[block.lang] && block.lang !== "text") continue;
      const lines = commandLines(block);
      // A script (more than a few lines) is reported as one: its lines are not commands to type.
      const script = lines.length > SCRIPT_LINES;
      if (script) other.push({ page: page.name, line: block.line, source: `a ${block.lang} script of ${lines.length} lines` });
      for (const { text, line } of lines) {
        for (const segment of segments(text)) {
          const args = cliArguments(segment);
          if (args) found.push({ page: page.name, line, args, inBlock: true, source: segment });
          else if (SHELLS[block.lang] && !script) other.push({ page: page.name, line, source: segment });
        }
      }
    }
    for (const { text, line } of page.prose) {
      for (const m of text.matchAll(/(`+)([^`]+?)\1(?!`)/g)) {
        const args = cliArguments(m[2].trim());
        if (args) found.push({ page: page.name, line, args, inBlock: false, source: m[2].trim() });
      }
    }
  }
  return { found, other };
}

const SCRIPT_LINES = 12;
const placeholder = (word) => /<[^>]+>/.test(word);

// ---------------------------------------------------------------- syntax

/** The quotes and brackets of a script: a stand-in for a shell's parser where the shell is not on this machine. */
function balance(text, lang) {
  const problems = [];
  const lines = text.split("\n");
  const stack = [];
  const pairs = { ")": "(", "}": "{", "]": "[" };
  let quote = null;
  let quoteLine = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (lang === "cmd") {
      if ((line.match(/"/g) ?? []).length % 2) problems.push(`line ${n + 1}: a " is not closed`);
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (quote === '"' && c === (lang === "powershell" ? "`" : "\\")) i++;
        else if (quote === "'" && lang === "powershell" && c === "'" && line[i + 1] === "'") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
      if (lang === "sh" && c === "\\") i++;
      else if (lang === "powershell" && c === "`") i++;
      else if (c === "'" || c === '"') {
        quote = c;
        quoteLine = n + 1;
      } else if ("({[".includes(c)) stack.push({ c, line: n + 1 });
      else if (")}]".includes(c)) {
        if (lang === "sh" && c === ")" && !stack.some((s) => s.c === "(")) continue; // a case pattern: x)
        const top = stack.pop();
        if (!top || top.c !== pairs[c]) problems.push(`line ${n + 1}: ${c} closes nothing that is open`);
      }
    }
  }
  if (quote) problems.push(`line ${quoteLine}: a ${quote} is not closed`);
  for (const s of stack) problems.push(`line ${s.line}: ${s.c} is not closed`);
  return problems;
}

const POSIX_SHELLS = ["/bin/zsh", "/bin/bash", "/bin/sh"];
const powershellExe = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;

/**
 * Parses a block with its shell, where this machine has it, and always checks its quotes and brackets too (zsh -n
 * takes an unclosed "(" in some places): { checker, problems }.
 */
function parse(block, folder) {
  const lang = SHELLS[block.lang];
  const file = join(folder, `block-${block.line}.${lang === "powershell" ? "ps1" : lang}`);
  writeFileSync(file, block.body);
  const problems = balance(block.body, lang);
  let checker = "a check of quotes and brackets";
  if (lang === "sh" && !windows) {
    const posix = (block.lang === "bash" ? ["/bin/bash", ...POSIX_SHELLS] : POSIX_SHELLS).find(existsSync);
    if (posix) {
      checker = `${posix} -n and ${checker}`;
      try {
        execProgram(posix, ["-n", file], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
      } catch (e) {
        problems.push(String(e.stderr || e.message).trim());
      }
    }
  }
  if (lang === "powershell" && powershellExe && existsSync(powershellExe)) {
    checker = `the PowerShell parser and ${checker}`;
    const script = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}', [ref]$null, [ref]$e); foreach ($x in $e) { 'line ' + $x.Extent.StartLineNumber + ': ' + $x.Message }`;
    const out = execProgram(powershellExe, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
    problems.push(...out.split(/\r?\n/).filter(Boolean));
  }
  return { checker, problems };
}

// ---------------------------------------------------------------- the tests

// U+0400 to U+04FF, built from numbers so that this file holds no such range itself (the export check looks for it).
const CYRILLIC = new RegExp(`[${String.fromCodePoint(0x400)}-${String.fromCodePoint(0x4ff)}]`);

test("the pages are there, and public-docs has no Cyrillic and no TODO", () => {
  assert.ok(pages.some((p) => p.name === "public-docs/README.md"), "public-docs/README.md is missing");
  for (const file of allFiles(DOCS)) {
    // A picture (images/emulator-logo.png) has no letters to read: its bytes are not text.
    if (/\.png$/.test(file)) continue;
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        assert.ok(!CYRILLIC.test(line), `${relative(root, file)}:${i + 1} has Cyrillic letters; public-docs is in English`);
        // A note left for before the release would go out with it (EMU-297): the public repository gets every line.
        assert.ok(!/\bTODO\b/.test(line), `${relative(root, file)}:${i + 1} has a TODO; public-docs is published as it is`);
      });
  }
});

test("every block names its language, and every shell block parses", (t) => {
  const folder = tempDir(t);
  const checkers = new Map();
  for (const page of pages) {
    for (const block of page.blocks) {
      assert.ok(block.lang, `${page.name}:${block.line - 1}: a block without its language (\`\`\`sh, \`\`\`powershell, \`\`\`text, ...)`);
      if (!SHELLS[block.lang]) {
        assert.ok(OTHER.has(block.lang), `${page.name}:${block.line - 1}: the language ${block.lang} is not one this test knows; add it to SHELLS or OTHER`);
        continue;
      }
      const { checker, problems } = parse(block, folder);
      checkers.set(checker, (checkers.get(checker) ?? 0) + 1);
      assert.deepEqual(problems, [], `${page.name}:${block.line - 1}: the ${block.lang} block does not parse (${checker})`);
    }
  }
  for (const [checker, n] of checkers) t.diagnostic(`${n} block(s) checked by ${checker}`);
});

test("every call of busy-emulator names a command it has, with its options", async (t) => {
  const commands = await loadCommands();
  const find = (name) => commands.find((c) => c.name === name);
  const awaited = new Map();
  const { found } = calls();
  assert.ok(found.length > 10, `only ${found.length} calls of busy-emulator found: is the pattern still right?`);
  for (const call of found) {
    const where = `${call.page}:${call.line}: ${call.source}`;
    const { name, args, unknownOptions, optionProblems } = parseArguments(call.args, (wanted) => find(wanted)?.options ?? null);
    if (name === null || placeholder(name)) continue;
    const command = find(name);
    if (!command) {
      assert.ok(Object.hasOwn(AWAITED_COMMANDS, name), `${where}: the command line has no command ${name}`);
      awaited.set(name, AWAITED_COMMANDS[name]);
      continue;
    }
    assert.deepEqual(unknownOptions, [], `${where}: ${name} has no such option`);
    assert.deepEqual(optionProblems, [], `${where}: ${name} is called wrongly`);
    assert.ok(args.length <= (command.maxArguments ?? 0), `${where}: ${name} takes at most ${command.maxArguments ?? 0} argument(s)`);
  }
  for (const [name, why] of awaited) t.diagnostic(`not checked: ${name} is not in this command line yet (${why})`);
  for (const name of Object.keys(AWAITED_COMMANDS)) if (find(name)) t.diagnostic(`${name} is in the command line now: take it out of AWAITED_COMMANDS`);
});

// The error codes the command line and the app's stage 2 raise, found where they are raised, as
// tools/agent-reference/agent-reference.mjs finds them for docs/agents/reference.md. Read here from the sources, not
// through that tool: the public repository carries this test and the sources, but not tools/.
function raisedCodes() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "test") walk(full);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(full);
    }
  };
  walk(join(root, "packages", "server", "cli"));
  files.push(join(root, "packages", "app", "src", "main.mjs"));
  const github = join(root, "packages", "app", "src", "github");
  for (const name of readdirSync(github)) if (name.endsWith(".mjs")) files.push(join(github, name));
  const codes = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\b(?:CliError|failed|PublishError)\(\s*"([a-z_]+)"/g)) codes.add(m[1]);
    for (const m of text.matchAll(/\bhuman\(\{\s*code:\s*"([a-z_]+)"/g)) codes.add(m[1]);
  }
  return codes;
}

test("agents.md names only error codes the emulator raises", () => {
  // The same table docs/agents/reference.md is made from. A code with an underscore is always a code; the plain words
  // listed here are codes too (`refused` is also an ordinary word, so a word is not taken for one by its looks).
  const PLAIN_CODES = ["refused"];
  const real = raisedCodes();
  const page = pages.find((p) => p.name === "public-docs/agents.md");
  assert.ok(page, "public-docs/agents.md is missing");
  let seen = 0;
  for (const { text, line } of page.prose) {
    for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)) {
      if (!m[1].includes("_") && !PLAIN_CODES.includes(m[1])) continue;
      seen++;
      assert.ok(real.has(m[1]), `public-docs/agents.md:${line}: \`${m[1]}\` is not an error code of the command line any more; fix the page or the list (see docs/agents/reference.md, "Error codes")`);
    }
  }
  assert.ok(seen >= 5, `only ${seen} error codes found in agents.md: is the pattern still right?`);
});

test("release addresses name files a release has; the pages link to pages and headings that are there", (t) => {
  const release = /https:\/\/github\.com\/busy-app\/busybar-emulator\/releases\/latest\/download\/([^\s)>\]"'`;]+)/g;
  const raw = /https:\/\/raw\.githubusercontent\.com\/busy-app\/busybar-emulator\/main\/public-docs\/([^\s)>\]"'`;]+)/g;
  const awaited = new Set();
  for (const page of pages) {
    const text = readFileSync(join(root, page.name), "utf8");
    // The install scripts are not in the packaging list but are release files too (docs/release.md): they are public-docs/install/<file>.
    for (const m of text.matchAll(release)) assert.ok(ALL_RELEASE_FILES.includes(m[1]) || existsSync(join(DOCS, "install", m[1])), `${page.name}: ${m[0]} names no file of a release (${ALL_RELEASE_FILES.join(", ")})`);
    for (const m of text.matchAll(raw)) {
      if (existsSync(join(DOCS, m[1]))) continue;
      assert.ok(Object.hasOwn(AWAITED_FILES, m[1]), `${page.name}: ${m[0]}: there is no public-docs/${m[1]}`);
      awaited.add(m[1]);
    }
  }
  // Links between the pages of public-docs, outside code: to a file inside public-docs, and to a heading it has.
  const anchorsOf = new Map();
  const anchors = (file) => {
    if (!anchorsOf.has(file)) {
      const seen = new Map();
      const list = new Set();
      for (const { text } of parseMarkdown(readFileSync(file, "utf8")).prose) {
        const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(text);
        if (!m) continue;
        const base = m[1].toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        list.add(n ? `${base}-${n}` : base);
      }
      anchorsOf.set(file, list);
    }
    return anchorsOf.get(file);
  };
  for (const page of pages.filter((p) => p.public)) {
    for (const { text, line } of page.prose) {
      const outsideCode = text.replace(/(`+)[^`]*?\1/g, "");
      // A link or a picture, ](target), and a picture as HTML, <img src="target">: every one must be there.
      for (const m of outsideCode.matchAll(/\]\(([^)\s]+)\)|<img\b[^>]*?\ssrc="([^"]+)"/g)) {
        const target = m[1] ?? m[2];
        if (/^[a-z]+:/i.test(target)) continue;
        const [path, anchor] = target.split("#");
        const file = path ? resolve(dirname(join(root, page.name)), path) : join(root, page.name);
        const where = `${page.name}:${line}: (${target})`;
        assert.ok(file === DOCS || file.startsWith(DOCS + sep), `${where} leads out of public-docs, which the public repository would not have`);
        const inDocs = relative(DOCS, file).split(sep).join("/");
        if (!existsSync(file)) {
          assert.ok(Object.hasOwn(AWAITED_FILES, inDocs), `${where}: there is no ${inDocs}`);
          awaited.add(inDocs);
          continue;
        }
        if (anchor && statSync(file).isFile()) assert.ok(anchors(file).has(anchor), `${where}: ${inDocs} has no heading #${anchor} (it has ${[...anchors(file)].join(", ")})`);
      }
    }
  }
  for (const name of awaited) t.diagnostic(`not checked: public-docs/${name} is not in this tree yet (${AWAITED_FILES[name]})`);
});

// The calls that run: against an emulator of this test's own, which the command line finds through a stand-in of the
// app's mirror in its data folder (as test/server/screenshot.test.mjs does), each in a new folder of its own.
let emulator;
let data;
const leftovers = [];
before(async () => {
  data = tempDir({ after: (fn) => leftovers.push(fn) });
  emulator = await startServer({ port: port(0), dataDir: join(data, "bar"), barSpeed: false, log: () => {} });
  mkdirSync(join(data, "run"));
  const started = Math.round(Date.now() - process.uptime() * 1000);
  writeFileSync(join(data, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started, port: emulator.port, url: emulator.url, state: "ready", detail: null, since: Date.now() }));
});
after(async () => {
  await emulator?.stop();
  for (const fn of leftovers) fn();
});

test("the calls that need no release run, and the rest are listed as not run", async (t) => {
  const { found, other } = calls();
  const ran = new Set();
  const notRun = [];
  for (const call of found.filter((c) => c.inBlock)) {
    const { name } = parseArguments(call.args);
    const where = `${call.page}:${call.line}: ${call.source}`;
    if (name === null || placeholder(name)) continue;
    if (!RUN.has(name) || call.args.some(placeholder) || ENDLESS(call.args)) {
      notRun.push(`${where} (${NOT_RUN[name] ?? (ENDLESS(call.args) ? "goes on until it is stopped" : "has a placeholder to fill in")})`);
      continue;
    }
    const key = JSON.stringify(call.args);
    if (ran.has(key)) continue;
    ran.add(key);
    const cwd = tempDir(t);
    const { BUSY_EMULATOR_DATA: _a, BUSY_EMULATOR_PORT: _b, ...clean } = process.env;
    const child = node(t, [CLI, ...call.args], { cwd, env: { ...clean, BUSY_EMULATOR_DATA: data }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (s) => (output += s));
    child.stderr.setEncoding("utf8").on("data", (s) => (output += s));
    const code = await child.exited(60000);
    assert.equal(code, 0, `${where}: exit code ${code}\n${output}`);
    if (name === "status") assert.ok(/is running|"running":true/.test(output) && !/not running/.test(output), `${where}: the emulator this test started is not seen\n${output}`);
    if (name === "screenshot") assert.ok(existsSync(join(cwd, "screenshots")), `${where}: no screenshots/ folder\n${output}`);
  }
  assert.ok(ran.size >= 2, `only ${ran.size} distinct calls ran`);
  t.diagnostic(`ran ${ran.size} distinct call(s) of the command line of this tree`);
  for (const line of notRun) t.diagnostic(`not run: ${line}`);
  for (const { page, line, source } of other) t.diagnostic(`not run, syntax only (not the emulator's command line): ${page}:${line}: ${source}`);
});
