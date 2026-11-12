// The font trap, told at build (font-check.mjs): busy-cli bundles a font's metrics only for a font named as a string
// literal under src/, and busy-lib's layout fails at run time without them. The warning comes for a font from a
// variable, for the short form `{ font }`, and for a literal named only in shared/; it says nothing for the template's
// own way, for raw elements without the layout, and once the app registers a map by hand.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fontWarnings, fontWarningText } from "../font-check.mjs";

function project(t, files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "busy-font-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), code);
  }
  return dir;
}

const LAYOUT = 'import { render, row } from "@busy-app/busy-lib";\n';

test("no warning: a literal font under src/, raw elements without the layout, a map registered by hand, a type annotation", (t) => {
  assert.deepEqual(fontWarnings(project(t, { "src/main.ts": `${LAYOUT}render(row([{ type: "text", text: "Hi", font: "bold" }]));` })), []);
  assert.deepEqual(fontWarnings(project(t, { "src/main.ts": 'const f = pick();\nDisplayDraw({ elements: [{ type: "text", text: "Hi", font: f, x: 0, y: 0 }] });' })), []);
  const registered = `${LAYOUT}import { registerFontMaps } from "@busy-app/busy-lib";\nimport { large } from "@busy-app/busy-lib/fonts";\nregisterFontMaps(large);\nconst f = "large";\nrender(row([{ type: "text", text: "Hi", font: f }]));`;
  assert.deepEqual(fontWarnings(project(t, { "src/main.ts": registered })), []);
  assert.deepEqual(fontWarnings(project(t, { "src/main.ts": `${LAYOUT}type T = { font: DeviceFont };\n// font: chosen\nrender(row([{ type: "text", text: "Hi", font: "small" }]));` })), []);
  assert.equal(fontWarningText([]), null);
});

test("a warning: a font from a variable, the short form, a literal only in shared/; the text says how to put it right", (t) => {
  const dir = project(t, {
    "src/main.ts": `${LAYOUT}const chosen = big ? "large" : "small";\nrender(row([{ type: "text", text: "Hi", font: chosen }]));\nconst font = chosen;\nrender(row([{ type: "text", text: "Hi", font }]));`,
    "shared/look.ts": 'export const title = { type: "text", text: "T", font: "extra_large" };',
  });
  const found = fontWarnings(dir);
  assert.deepEqual(
    found.map(({ file, line, kind, font }) => [file, line, kind, font]),
    [
      ["shared/look.ts", 1, "outside-src", "extra_large"],
      ["src/main.ts", 3, "computed", null],
      ["src/main.ts", 5, "computed", null],
    ],
  );
  const text = fontWarningText(found);
  assert.match(text, /has no metrics loaded/);
  assert.match(text, /import \{ registerFontMaps \} from "@busy-app\/busy-lib";\n {2}import \{ extra_large \} from "@busy-app\/busy-lib\/fonts";\n {2}registerFontMaps\(extra_large\);/);
  assert.match(text, /only for the fonts you use/);
  assert.match(text, /\(the build looks for font names in src\/ only\)/);
});
