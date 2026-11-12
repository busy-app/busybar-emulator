// How to use (how-to-use.mjs): the README's ## How to use section read into rows of a control and a sentence, written
// back in place, and checked by the mirror of the catalog's Markdown rules. No files: node --test this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CONTROLS, HEADING, listOf, MAX_ROWS, problem, read, rowsOf, write } from "../how-to-use.mjs";
import { markdownProblem } from "../../readiness/markdown.mjs";

const README = "<!-- mark -->\n\n# Desk Clock\n\nA clock for the desk.\n\n## Settings\n\n- **Digits**: Big\n\n## Build and install\n\nnpm ci\n";

test("the controls are the catalog's chips, and a row is the convention's list line", () => {
  assert.deepEqual(CONTROLS, ["Start", "Wheel turn", "Wheel press", "Back"]);
  assert.equal(HEADING, "## How to use");
  assert.equal(listOf([{ control: "Start", text: "Starts the timer" }, { control: "Wheel turn", text: " Sets\nthe length " }]), "- **Start**: Starts the timer\n- **Wheel turn**: Sets the length");
  assert.equal(listOf([{ control: null, text: "Kept as it was" }]), "- Kept as it was");
});

test("rows are read from the list: the convention, other names of a control, a sentence that starts with it", () => {
  assert.deepEqual(rowsOf("- **Start**: Starts\n- **OK** — Skips\n* Back: Quits\n- __Wheel - rotate__: Sets\n  the length\n- Turn the wheel to choose\n- Something else"), [
    { control: "Start", text: "Starts" },
    { control: "Wheel press", text: "Skips" },
    { control: "Back", text: "Quits" },
    { control: "Wheel turn", text: "Sets the length" },
    { control: "Wheel turn", text: "To choose" },
    { control: null, text: "Something else" },
  ]);
  assert.deepEqual(rowsOf("No list at all."), []);
});

test("write puts the section in place, before the next section when there is none, and takes it out with no rows", () => {
  const rows = [{ control: "Start", text: "Shows the date" }, { control: "Back", text: "Quits" }];
  const written = write(README, rows);
  assert.equal(written, "<!-- mark -->\n\n# Desk Clock\n\nA clock for the desk.\n\n## How to use\n\n- **Start**: Shows the date\n- **Back**: Quits\n\n## Settings\n\n- **Digits**: Big\n\n## Build and install\n\nnpm ci\n");
  assert.deepEqual(read(written), rows, "read gives back what write put");
  assert.deepEqual(read(README), [], "the Settings list is not How to use");
  const again = write(written, [{ control: "Wheel press", text: "Pauses" }]);
  assert.match(again, /## How to use\n\n- \*\*Wheel press\*\*: Pauses\n\n## Settings/);
  assert.equal(again.match(/## How to use/g).length, 1, "replaced, not added");
  assert.doesNotMatch(write(written, []), /How to use/);
  assert.equal(write("# Only a title\n", rows), "# Only a title\n\n## How to use\n\n- **Start**: Shows the date\n- **Back**: Quits\n");
  assert.equal(write(README, []), README, "nothing to write, nothing changed");
});

test("problem: at least one row, each with its control and a short sentence, in Markdown the catalog takes", () => {
  assert.equal(problem([]), "Add a control to How to use");
  assert.equal(problem([{ control: null, text: "x" }]), "How to use, row 1: choose the control");
  assert.equal(problem([{ control: "Back", text: " " }]), "How to use: write what Back does");
  assert.equal(problem([{ control: "Start", text: "x".repeat(101) }]), "How to use, Start: at most 100 characters");
  assert.equal(problem(Array.from({ length: MAX_ROWS + 1 }, () => ({ control: "Start", text: "Go" }))), `How to use: at most ${MAX_ROWS} controls`);
  assert.equal(problem([{ control: "Start", text: "Runs `npm start`" }]), "How to use: row 1, code (a backtick)");
  const fine = [{ control: "Start", text: "Starts **the** timer, see [the docs](https://busy.app)" }];
  assert.equal(problem(fine), null);
  assert.equal(markdownProblem(`${HEADING}\n\n${listOf(fine)}\n`).problem, null, "the section passes the catalog's rules");
});
