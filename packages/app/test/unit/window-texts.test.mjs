// The command line's words in the window's (window-texts.mjs): commands become the window's buttons, a command
// without one is marked as a terminal's, and no path of the app's Node or command line is left.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS, windowText } from "../../src/window-texts.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "..", "..", "..", "server");
const w = (text, platform = "darwin") => windowText(text, { platform });

test("every command of the command line is known to the window's words", () => {
  const commands = readdirSync(path.join(SERVER, "cli", "commands")).filter((name) => name.endsWith(".mjs")).map((name) => name.slice(0, -4));
  assert.deepEqual(commands.filter((name) => !COMMANDS.includes(name)), []);
});

test("a hint names the button to press; a command without one is marked as a terminal's", () => {
  const cases = [
    ["Fix what busy-cli says, then run busy-emulator dev /Users/you/clock --once again.", "Fix what busy-cli says, then press Refresh again."],
    ["Fix what busy-cli says, then run busy-emulator dev '/Users/you/my clock' --once again.", "Fix what busy-cli says, then press Refresh again."],
    ["Run busy-emulator build '/a b', then busy-emulator submit '/a b' again.", "Press Build, then press Publish again."],
    ["Next: busy-emulator build, then busy-emulator check again.", "Next: press Build, then press Publish again."],
    ["The entry point is src/main.ts or src/main.js; build again: busy-emulator build.", "The entry point is src/main.ts or src/main.js; build again: press Build."],
    ["busy-emulator submit writes applications/x/manifest.yml", "Publish writes applications/x/manifest.yml"],
    ["the screenshots are filled in by busy-emulator submit", "the screenshots are filled in by Publish"],
    ["Take one: busy-emulator screenshot --back makes one.", "Take one: busy-emulator screenshot --back (a terminal command) makes one."],
    ["Start it with busy-emulator start, then run busy-emulator dev . again.", "Start it with busy-emulator start (a terminal command), then press Watch the folder again."],
    ["Run the same busy-emulator command again outside the sandbox.", "Run the same busy-emulator command again outside the sandbox."],
    // Windows: PowerShell's form, a quoted folder.
    [`Fix it, then run & 'busy-emulator' dev "C:\\Users\\you\\clock" --once again.`, "Fix it, then press Refresh again."],
  ];
  for (const [said, shown] of cases) assert.equal(w(said), shown, said);
  assert.equal(w("Fill in changelog in catalog.json in the project's folder."), "Fill in changelog in catalog.json in the project's folder (Show in Finder opens it).");
  assert.equal(w("Fill in changelog in catalog.json in the project's folder.", "win32"), "Fill in changelog in catalog.json in the project's folder (Show in Explorer opens it).");
  for (const nothing of [null, undefined, ""]) assert.equal(w(nothing), nothing);
});

test("the path of the app's Node, of its command line or of a launcher never comes through", () => {
  const forms = [
    "'/Applications/BUSY Bar Emulator.app/Contents/Resources/node' '/Applications/BUSY Bar Emulator.app/Contents/Resources/emulator/packages/server/cli/busy-emulator.mjs'",
    "/Users/you/.nvm/versions/node/v24.0.0/bin/node /Users/you/src/emulator/packages/server/cli/busy-emulator.mjs",
    "/Users/you/.busy-emulator/bin/busy-emulator",
    "& 'C:\\Users\\you\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe'",
    // Windows: the launcher's form for PowerShell, Git Bash and cmd alike (forward slashes, no quotes).
    "C:/Users/you/AppData/Local/busy-emulator/bin/busy-emulator.exe",
    "C:/Users/Тест/AppData/Local/busy-emulator/bin/busy-emulator.exe",
    "& 'C:\\Program Files\\BUSY Bar Emulator\\resources\\node\\node.exe' 'C:\\Program Files\\BUSY Bar Emulator\\resources\\emulator\\packages\\server\\cli\\busy-emulator.mjs'",
  ];
  for (const form of forms) {
    assert.equal(w(`Fix it, then run ${form} check /Users/you/clock again.`), "Fix it, then press Publish again.", form);
    assert.equal(w(`Then run ${form} logs.`), "Then run busy-emulator logs (a terminal command).", form);
  }
});

test("each command the catalog's checks name is a button or a terminal command in the window", () => {
  const source = readFileSync(path.join(SERVER, "readiness", "check.mjs"), "utf8");
  const lines = source.split("\n").filter((line) => /busy-emulator [a-z]/.test(line));
  assert.ok(lines.length >= 10, "the checks name commands");
  const named = new RegExp(`busy-emulator (?:${COMMANDS.join("|")})(?![\\w-])`);
  for (const line of lines) {
    const shown = w(line).replace(/busy-emulator [^()]*?\(a terminal command\)/g, "");
    assert.doesNotMatch(shown, named, line.trim());
  }
});
