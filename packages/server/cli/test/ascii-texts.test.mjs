// What the command line prints is ASCII (EMU-314). Windows PowerShell 5.1 reads a program's output in the console's
// code page (cp866 on a Russian Windows), not as UTF-8: an agent that captured `busy-emulator screenshot` read the
// times sign of "72x16", UTF-8 C3 97, as two characters of cp866, and every ellipsis and arrow as three. The marks
// become ASCII at the one place where the command line writes (../console.mjs); the texts themselves, the server's
// and the window's, keep their typography.
//
// The test runs the real command line, as a separate process, on help, the help of every command, failures and
// --json, and reads the bytes it wrote; and it reads the command line's modules for a write to the console that
// would go around that one place.
//
//   node --test emulator/packages/server/cli/test/ascii-texts.test.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadCommands } from "../busy-emulator.mjs";
import { consoleText } from "../console.mjs";
import { asciiText } from "../output.mjs";
import { reportBrokenFilesTo, updateJsonFile } from "../../json-store.mjs";

const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(cliDir, "busy-emulator.mjs");

const temp = mkdtempSync(path.join(os.tmpdir(), "busy-ascii-"));
after(() => rmSync(temp, { recursive: true, force: true }));
const data = path.join(temp, "data");
const empty = path.join(temp, "empty");
mkdirSync(empty);
// A folder of the person's in Greek and Japanese: their letters, which pass as they are.
const theirs = "\u0393\u03b5\u03b9\u03ac \u30d5\u30a9\u30eb\u30c0";
mkdirSync(path.join(temp, theirs));

/** The command line as a process of its own, in `cwd`: its exit code and the bytes of stdout and stderr. */
function cli(args, { cwd = empty, env = {} } = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BUSY_EMULATOR_")));
  // A port nothing listens on: the commands that need the emulator fail at once, with their answer.
  const full = { ...clean, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: "9", ...env };
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: full, encoding: "buffer", timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr, all: Buffer.concat([stdout, stderr]) });
    });
  });
}

/** The places of characters outside ASCII in a run's output, each with the text around it, for the message. */
function notAscii(bytes) {
  const text = bytes.toString("utf8");
  return [...text.matchAll(/[^\x00-\x7f]+/g)].map((m) => JSON.stringify(text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10)));
}

test("asciiText: busy-cli's marks, the times sign, arrows, ellipses, dashes and quotes in ASCII; letters as they are", () => {
  const busyCli = "\u25c7  Building app.jane.timer v0.1.0\n\u2502\n\u25c6  Done \u2192 dist\\app.jane.timer.tgz\n";
  assert.equal(asciiText(busyCli), "o  Building app.jane.timer v0.1.0\n|\n*  Done -> dist\\app.jane.timer.tgz\n");
  assert.equal(asciiText("Fetching\u2026 72\u00d716 \u2014 ok \u2713 \u2717 \u201cquoted\u201d \u2018it\u2019s\u2019 1\u20132"), "Fetching... 72x16 - ok v x \"quoted\" 'it's' 1-2");
  assert.equal(asciiText("\u2502     \u256d\u2500[ src/main.ts:1:6 ]"), "|     +-[ src/main.ts:1:6 ]");
  assert.equal(asciiText(`C:\\Users\\${theirs}\\main.ts`), `C:\\Users\\${theirs}\\main.ts`);
  // The app's runs keep the text as it is: the window shows it as UTF-8.
  assert.equal(consoleText(true)("8\u00d78 \u2026"), "8\u00d78 \u2026");
  assert.equal(consoleText(false)("8\u00d78 \u2026"), "8x8 ...");
});

test("help and the help of every command are ASCII, though the texts hold the times sign and ellipses", async () => {
  const commands = await loadCommands();
  assert.ok(commands.length > 20, `commands: ${commands.length}`);
  const runs = [["help"], ["--help"], ...commands.map((c) => ["help", c.name])];
  const found = [];
  for (const args of runs) {
    const r = await cli(args);
    assert.ok(r.stdout.length > 0, `${args.join(" ")} printed nothing`);
    for (const at of notAscii(r.all)) found.push(`${args.join(" ")}: ${at}`);
  }
  assert.deepEqual(found, []);
  // That the texts do have them: else this test would pass by not seeing any.
  const icon = await cli(["help", "icon"]);
  assert.match(icon.stdout.toString(), /8x8 front, 11x11 back/);
  const unicode = await cli(["help", "icon"], { env: { BUSY_EMULATOR_OUTPUT: "unicode" } });
  assert.match(unicode.stdout.toString("utf8"), /8\u00d78 front, 11\u00d711 back/);
});

test("failures for a person and with --json are ASCII; the person's letters come through, exactly in --json", async () => {
  const runs = [
    { args: ["no-such-command"] },
    { args: ["build"] },
    { args: ["screenshot"] },
    { args: ["press", "ok"] },
    { args: ["settings", "set", "a=1"] },
    { args: ["icon", "--text", "ABC"] },
    { args: ["record", "--seconds", "30", "--fps", "50", "--gif", "--scale", "26", "--layout", "front"] },
    { args: ["build", "--json"] },
    { args: ["icon", "--text", "ABC", "--json"] },
    { args: ["build", theirs, "--json"], cwd: temp },
  ];
  const found = [];
  for (const { args, cwd } of runs) {
    const r = await cli(args, { cwd });
    assert.notEqual(r.code, 0, `${args.join(" ")} failed, as it should: ${r.all}`);
    assert.ok(r.all.length > 0, `${args.join(" ")} said nothing`);
    for (const at of notAscii(r.all)) found.push(`${args.join(" ")}: ${at}`);
  }
  assert.deepEqual(found, []);
  // In --json the folder's name is \uXXXX, which JSON reads back exactly.
  const json = await cli(["build", theirs, "--json"], { cwd: temp });
  assert.ok(JSON.parse(json.stdout.toString()).folder.endsWith(theirs), json.stdout.toString());
  // For a person: the name's letters as they are, everything around them ASCII.
  const text = await cli(["build", theirs], { cwd: temp });
  const said = text.stderr.toString("utf8");
  assert.ok(said.includes(theirs), said);
  assert.deepEqual(notAscii(Buffer.from(said.replaceAll(theirs, ""))), []);
});

// Where the command line may touch its standard output and standard error itself, and why. Everything else writes
// through console.mjs, or through the out, err and print it is handed (main() in busy-emulator.mjs).
const WRITERS = [
  ["console.mjs", "the one place where the command line writes"],
  ["busy-emulator.mjs", "hands console.mjs's writers for process.stdout and process.stderr to main()"],
  ["mcp/tools.mjs", "the log of a tool's run: console.mjs's writer for process.stderr"],
  ["mcp/server.mjs", "the MCP protocol on stdout, written as asciiJson; a stray write to stdout is sent to stderr"],
];
const TOUCHES = /\bprocess\.(stdout|stderr)\b|\bconsole\.(log|error|warn|info|debug|trace)\s*\(/;

test("nothing in the command line writes to the console around console.mjs", () => {
  const found = [];
  const walk = (dir, rel = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "test" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else if (entry.name.endsWith(".mjs") && !WRITERS.some(([file]) => file === `${rel}${entry.name}`)) {
        readFileSync(path.join(dir, entry.name), "utf8")
          .split("\n")
          .forEach((line, i) => {
            // A comment that names console.log (the app's console) is not a write.
            const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
            if (TOUCHES.test(code)) found.push(`${rel}${entry.name}:${i + 1}: ${line.trim().slice(0, 100)}`);
          });
      }
    }
  };
  walk(cliDir);
  assert.deepEqual(found, [], `write through console.mjs (lineWriter, consoleText):\n${found.join("\n")}`);
  // busy-emulator.mjs hands main() console.mjs's writers, and nothing else.
  const entry = readFileSync(path.join(cliDir, "busy-emulator.mjs"), "utf8");
  assert.match(entry, /const err = lineWriter\(process\.stderr, ctx\.unicodeOutput\);/);
  assert.match(entry, /out: lineWriter\(process\.stdout, ctx\.unicodeOutput\), err \}/);
  assert.match(entry, /reportBrokenFilesTo\(err\);/);
});

// The modules outside cli/ that the command line imports, and that may touch the console, and why. A module of the
// server the command line does not import (the server's own start, index.mjs) writes as the server does.
const OUTSIDE = [
  ["json-store.mjs", "its default writer of a broken file's line; the command line replaces it with console.mjs's (reportBrokenFilesTo)"],
  ["projects/template-fixes.mjs", "console.error in the text of the settings helper it writes into a project, not a write of its own"],
  ["readiness/import-probe.mjs", "process.stdout in the text of the probe it runs as a child process, whose stdout it reads as JSON"],
];

/** Every module a module imports by a relative path, and theirs, outside the tests: paths relative to the server. */
function importedFrom(first) {
  const server = path.resolve(cliDir, "..");
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file) || !file.endsWith(".mjs") || file.split(path.sep).includes("test")) return;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const m of source.matchAll(/(?:\bfrom|\bimport\s*\()\s*["'](\.{1,2}\/[^"'$`]+)["']/g)) visit(path.resolve(path.dirname(file), m[1]));
  };
  for (const file of first) visit(file);
  return [...seen].map((file) => path.relative(server, file).split(path.sep).join("/"));
}

test("nothing the command line imports from outside cli/ writes to the console around it", () => {
  const cliModules = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "test" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name.endsWith(".mjs")) cliModules.push(path.join(dir, entry.name));
    }
  };
  walk(cliDir);
  const outside = importedFrom(cliModules).filter((rel) => !rel.startsWith("cli/") && !rel.startsWith("../"));
  // The modules that lead to json-store.mjs are among them: a wrong walk would pass by finding nothing.
  for (const must of ["json-store.mjs", "projects/trust.mjs", "projects/registry.mjs", "projects/node-tools.mjs", "capture/icon-rules.mjs"]) assert.ok(outside.includes(must), `${must} is imported (${outside.length} modules)`);
  const found = [];
  for (const rel of outside) {
    if (OUTSIDE.some(([file]) => file === rel)) continue;
    readFileSync(path.resolve(cliDir, "..", rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (TOUCHES.test(code)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
  }
  assert.deepEqual(found, [], `a module the command line imports writes to the console; give it a writer the command line names, as json-store.mjs does:\n${found.join("\n")}`);
});

test("a data file found broken is told through the writer the command line names", () => {
  const file = path.join(temp, "broken.json");
  writeFileSync(file, "{ not json");
  const said = [];
  const before = reportBrokenFilesTo((line) => said.push(line));
  try {
    updateJsonFile(file, () => ({ fresh: true }), { fallback: () => ({}) });
  } finally {
    reportBrokenFilesTo(before);
  }
  assert.equal(said.length, 1);
  assert.match(said[0], /^busy-emulator: .*broken\.json could not be read: .*It is kept as .*, and a new one is started\.$/);
});
