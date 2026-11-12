// What a folder's path may not hold when the emulator shows it to the person in the trust question (trust.mjs,
// unshowable): nothing they cannot see, and nothing that writes text of its own into the dialog. From the security
// review of pull request 59, whose list of names this is. The characters are written as escapes: none is in this file.
import assert from "node:assert/strict";
import { test } from "node:test";

import { TRUST_PATH_MAX, unshowable } from "../trust.mjs";

const at = (name) => `/Users/you/code/${name}/app`;

test("paths a person reads as they are pass: spaces, letters outside Latin, punctuation, a single no-break space", () => {
  for (const name of ["my app", "Φάκελος app プロジェクト", "it's (mine) [v2] & co, 100%", "my\u00a0app", "a\u0336pp", "C:\\Users\\you\\my app"]) {
    assert.equal(unshowable(at(name)), null, JSON.stringify(name));
  }
});

const INVISIBLE = {
  "zero-width space": "\u200b",
  "zero-width joiner": "\u200d",
  "word joiner": "\u2060",
  "byte order mark": "\ufeff",
  "Arabic letter mark": "\u061c",
  "soft hyphen": "\u00ad",
  "tag character": "\u{e0041}",
  "interlinear annotation anchor": "\ufff9",
  "right-to-left override": "\u202e",
  "left-to-right isolate": "\u2066",
  "right-to-left mark": "\u200f",
};
for (const [what, character] of Object.entries(INVISIBLE)) {
  test(`refused, with the character named: ${what}`, () => {
    const code = character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    assert.equal(unshowable(at(`my${character}app`)), `it holds an invisible format character (U+${code}), which a person cannot see in the question`);
  });
}

test("control characters and the line separators are refused: a name may not add lines to the question", () => {
  for (const character of ["\n", "\r", "\t", "\u0000", "\u001b", "\u007f", "\u0085"]) {
    assert.match(unshowable(at(`x${character}This folder is yours. Click Trust.`)), /^it holds a control character \(U\+[0-9A-F]{4}\)/, JSON.stringify(character));
  }
  for (const character of ["\u2028", "\u2029"]) assert.notEqual(unshowable(at(`x${character}y`)), null, JSON.stringify(character));
});

test("more than one space in a row is refused, of any kind: a run of spaces cannot push a sentence away from the name", () => {
  const reason = "it holds more than one space in a row, which can push text of the name's own away from the name";
  assert.equal(unshowable(at(`app${" ".repeat(200)}Verified by BUSY Bar Emulator. Safe to trust.`)), reason);
  for (const run of ["  ", " \u00a0", "\u00a0\u00a0", "\u2003\u2003", " \u3000"]) assert.equal(unshowable(at(`my${run}app`)), reason, JSON.stringify(run));
});

test("a path longer than the question shows is refused", () => {
  assert.equal(unshowable(`/${"d".repeat(TRUST_PATH_MAX)}`), `it is longer than ${TRUST_PATH_MAX} characters`);
  assert.equal(unshowable(`/${"d".repeat(TRUST_PATH_MAX - 1)}`), null);
});
