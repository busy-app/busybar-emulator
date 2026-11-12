// What an agent needs of stage 1 beyond the window's own tests (publish-flow.test.mjs): How to use's controls rows from
// the command line (publish readme --controls, on how-to-use.mjs), the categories named where none is chosen, the
// screenshots' order as one list, and help publish with every step. No network, no git, no build, no emulator.
//
//   node --test emulator/packages/server/publish/test/agent-path.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../../cli/busy-emulator.mjs";
import { resolveContext } from "../../cli/context.mjs";
import { system } from "../../cli/system.mjs";
import { makeProject } from "../../readiness/test/project-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "..", "cli", "busy-emulator.mjs");

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-agent-path-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function cli(home, argv, { json = true } = {}) {
  const ctx = resolveContext({ env: { BUSY_EMULATOR_DATA: path.join(home, "data") }, platform: process.platform, homeDir: home, scriptPath: CLI, execPath: process.execPath, nodeVersion: process.versions.node });
  const out = [];
  const code = await main(json ? [...argv, "--json"] : argv, { ctx, sys: { ...system, cwd: () => home }, out: (line) => out.push(line), err: () => {} });
  return { code, json: json ? JSON.parse(out.join("\n")) : null, text: out.join("\n") };
}

function project(t) {
  const home = tempDir(t);
  const dir = path.join(home, "pomodoro");
  mkdirSync(dir);
  makeProject(dir, { git: false, files: (files) => Object.assign(files, { LICENSE: null, "catalog.json": null }) });
  return { home, dir };
}

test("publish readme set --controls: How to use's rows in the README, the sentence after them kept; a wrong control is a wrong call", async (t) => {
  const { home, dir } = project(t);
  const set = await cli(home, ["publish", "readme", "set", dir, "--intro", "A Pomodoro timer for the desk.", "--controls", '{"Start": "Starts or pauses the timer", "Wheel turn": "Sets the minutes", "Wheel press": "Resets", "Back": "Exits"}', "--usage", "The bar glows red while you focus."]);
  assert.equal(set.code, 0, JSON.stringify(set.json));
  const readme = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /## How to use\n\n- \*\*Start\*\*: Starts or pauses the timer\n- \*\*Wheel turn\*\*: Sets the minutes\n- \*\*Wheel press\*\*: Resets\n- \*\*Back\*\*: Exits\n\nThe bar glows red while you focus\.\n/);
  assert.deepEqual(set.json.controls.map((one) => one.control), ["Start", "Wheel turn", "Wheel press", "Back"]);
  // New rows, the sentence as it was.
  const again = await cli(home, ["publish", "readme", "set", dir, "--controls", '[{"control": "Start", "text": "Starts"}]']);
  assert.equal(again.code, 0, JSON.stringify(again.json));
  assert.equal(again.json.config.usage, "- **Start**: Starts\n\nThe bar glows red while you focus.");
  const get = await cli(home, ["publish", "readme", "get", dir]);
  assert.deepEqual(get.json.controls, [{ control: "Start", text: "Starts" }]);
  const wrong = await cli(home, ["publish", "readme", "set", dir, "--controls", '{"Menu": "x"}']);
  assert.deepEqual([wrong.code, wrong.json.code], [2, "usage"]);
  assert.match(wrong.json.message, /not one of the BUSY Bar's controls: Start, Wheel turn, Wheel press, Back/);
  // Other names how-to-use.mjs knows, in any order; a sentence too long for the catalog's card is refused.
  const named = await cli(home, ["publish", "readme", "preview", dir, "--controls", '{"back": "Exits", "wheel_turn": "Sets the minutes", "OK": "Resets"}']);
  assert.deepEqual(named.json.controls.map((one) => one.control), ["Wheel turn", "Wheel press", "Back"]);
  for (const bad of ["not json", "{}", '{"Start": ""}', `{"Start": "${"x".repeat(101)}"}`, '[{"control": "Start", "text": "a"}, {"control": "start", "text": "b"}]']) assert.equal((await cli(home, ["publish", "readme", "set", dir, "--controls", bad])).json.code, "usage", bad);
  assert.equal((await cli(home, ["publish", "readme", "get", dir, "--controls", '{"Start": "x"}'])).json.code, "usage");
  // Without rows the README is still written, and the text says what is missing.
  const plain = await cli(home, ["publish", "readme", "set", dir, "--usage", "Press Start."], { json: false });
  assert.match(plain.text, /How to use names no control of the BUSY Bar: give the rows with --controls/);
});

test("catalog-texts without a category lists the categories with what goes in each; help publish shows every step", async (t) => {
  const { home, dir } = project(t);
  writeFileSync(path.join(dir, "catalog.json"), "{}\n");
  const texts = await cli(home, ["catalog-texts", dir], { json: false });
  assert.match(texts.text, /categories \(--category <id>\): productivity \(Productivity: focus, Pomodoro/);
  const help = await cli(home, ["help", "publish"], { json: false });
  for (const want of ["--controls", "--license other --from <file>", "--use-existing [--user <login>]", "--no-wait", "publish pr", "tick the author checklist"]) assert.ok(help.text.includes(want), want);
  const json = await cli(home, ["help", "publish"]);
  assert.ok(json.json.command_help.details.length > 10);
});

test("publish screenshots --order takes one list too, each path to its own display; --remove of one not listed says why", async (t) => {
  const { home, dir } = project(t);
  const flat = await cli(home, ["publish", "screenshots", dir, "--order", '["screenshots/front-2.png", "screenshots/back-1.png", "screenshots/front-1.png"]']);
  assert.equal(flat.code, 0, JSON.stringify(flat.json));
  assert.deepEqual([flat.json.front.map((one) => one.path), flat.json.back.map((one) => one.path)], [["screenshots/front-2.png", "screenshots/front-1.png"], ["screenshots/back-1.png"]]);
  writeFileSync(path.join(dir, "screenshots", "front-9.png"), "x");
  const removed = await cli(home, ["publish", "screenshots", dir, "--remove", "screenshots/front-9.png"]);
  assert.equal(removed.json.code, "not_found");
  assert.match(removed.json.message, /not among the catalog's screenshots \(the list in catalog\.json\)/);
});
