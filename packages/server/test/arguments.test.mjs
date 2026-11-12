// The check of a command line's words (arguments.mjs): what a command takes passes, anything else is a wrong call
// with a short reason. The command lines themselves are run in test/server/command-lines.test.mjs.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkArguments, headerComment, UsageError } from "../arguments.mjs";

const SPEC = { values: ["--port", "--data"], flags: ["--fast"], optional: ["--bar"] };
const problem = (words, spec = SPEC) => {
  try {
    checkArguments(words, spec);
    return null;
  } catch (error) {
    assert.ok(error instanceof UsageError, String(error));
    return error.message;
  }
};

test("what the command takes passes, in any order and more than once", () => {
  assert.deepEqual(checkArguments([], SPEC), { help: false, version: false });
  assert.deepEqual(checkArguments(["--fast", "--port", "8661", "--data", "a b", "--port", "0"], SPEC), { help: false, version: false });
  // A value may look like anything but an option: a negative number, a single-dash word.
  assert.equal(problem(["--port", "-1"]), null);
});

test("an option the command does not know is a wrong call, with two dashes or one", () => {
  assert.equal(problem(["--help-me"]), "unknown option --help-me");
  assert.equal(problem(["--port", "8661", "--verbose"]), "unknown option --verbose");
  assert.equal(problem(["-x"]), "unknown option -x");
  assert.equal(problem(["-"]), "unknown option -");
  assert.equal(problem(["--"]), "unknown option --");
  // --version only where the command has one.
  assert.equal(problem(["--version"]), "unknown option --version");
  assert.deepEqual(checkArguments(["--version"], { ...SPEC, version: true }), { help: false, version: true });
});

test("an option that needs a value and has none is a wrong call; another option is not its value", () => {
  assert.equal(problem(["--port"]), "--port needs a value");
  assert.equal(problem(["--port", "--fast"]), "--port needs a value");
  assert.equal(problem(["--data", "--port", "8661"]), "--data needs a value");
});

test("--name=value is refused with how to write it", () => {
  assert.equal(problem(["--port=8661"]), "--port=8661: put the value after a space, --port 8661");
  assert.equal(problem(["--bar=10.0.4.20"]), "--bar=10.0.4.20: put the value after a space, --bar 10.0.4.20");
  assert.equal(problem(["--fast=1"]), "unknown option --fast=1");
});

test("an optional value is the next word unless that is an option", () => {
  assert.equal(problem(["--bar"]), null);
  assert.equal(problem(["--bar", "10.0.4.20", "--fast"]), null);
  assert.equal(problem(["--bar", "--fast"]), null);
  // The address was taken by --bar; a second word is not.
  assert.equal(problem(["--bar", "10.0.4.20", "extra"]), "unexpected argument extra");
});

test("words that are not options: none unless the command takes them", () => {
  assert.equal(problem(["scroll"]), "unexpected argument scroll");
  assert.equal(problem(["a", "b"], { positionals: true }), null);
  assert.equal(problem(["runtime", "screen"], { positionals: ["runtime", "screen"] }), null);
  assert.equal(problem(["runtim"], { positionals: ["runtime", "screen"] }), "unknown argument runtim (it takes runtime, screen)");
});

test("--help and -h are always known, and only say that the help is asked for", () => {
  assert.deepEqual(checkArguments(["--help"], {}), { help: true, version: false });
  assert.deepEqual(checkArguments(["--port", "8661", "-h"], SPEC), { help: true, version: false });
  // A wrong word next to --help is still a wrong call: nothing in the call is passed over.
  assert.equal(problem(["--help", "--nope"]), "unknown option --nope");
});

test("the help of a script without one of its own is its header comment", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "emu-arguments-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "tool.mjs");
  writeFileSync(file, "#!/usr/bin/env node\n// The tool.\n//\n//   node tool.mjs [--fast]\nimport x from 'y';\n// not this\n");
  assert.equal(headerComment(file), "The tool.\n\n  node tool.mjs [--fast]");
});
