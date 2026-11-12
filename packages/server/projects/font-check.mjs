// The font trap, told when the project is built instead of met when the app runs (the field test with a real agent,
// 11.11: three calls lost to it in one run).
//
// busy-lib's layout (render, measure; row, column, stack) measures text, so it needs the metrics of every font it
// lays out. busy-cli's build bundles a font's metrics only when it sees the font named as a string literal,
// `font: "bold"`, in a file under src/ (its font-maps plugin; checked on the emulator with create-app 0.5.0, busy-cli
// 0.6.0, busy-lib 0.21.1). Two ordinary ways of writing an app fall outside that, pass the type check, build without a
// word, and fail when the app runs with `font "large" has no metrics loaded — pass its map to registerFontMaps()`:
//
//   - the font comes from a variable: `font: chosen`, or the short form `{ type: "text", text, font }`. The build
//     warns about the first form only, and `dev` does not show the build's output at all;
//   - the font is named in shared/, which the build does not scan.
//
// What puts it right, each checked by running it: name the font as a literal in src/, or register its map by hand,
//
//   import { registerFontMaps } from "@busy-app/busy-lib";
//   import { large } from "@busy-app/busy-lib/fonts";
//   registerFontMaps(large);
//
// only for the fonts the app uses: every font the layout measures takes heap. Measured on the emulator (firmware
// 1.3.1), the heap peak of an app that draws one text, of the default 128 KiB: 60 KiB with elements placed by x, y and
// align (no layout); 75 KiB with the layout and one font; about 9 KiB more for each further font it lays out (four
// fonts: 101 KiB; eight: "out of memory" as the app starts); 127 KiB with the font "global" alone. Elements placed by
// x, y and align and sent to DisplayDraw as they are need no metrics at all.
//
// This is a reading of the source text, not of what the program does, so it warns and never fails a build. It says
// nothing when no file uses the layout, and nothing once the app registers a map by hand: its author has met the
// mechanism. The patterns are the build's own (fontMapsPlugin.js), so that "named as a literal" means here what it
// means there.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The fonts of the bar, as busy-lib's DeviceFont names them. */
export const FONTS = Object.freeze(["tiny", "small", "normal", "condensed", "bold", "large", "extra_large", "global", "superscript"]);

const SOURCE_FILE = /\.(ts|tsx|js|mjs|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist"]);
/** Every `font:` property, literal or not; and the value of a literal one (the build's patterns). */
const FONT_PROP = /\bfont\s*:\s*([^,;}\n)]+)/g;
const LITERAL = /^(["'])([a-z_]+)\1(\s+as\s+const)?$/;
/** The short form of a property, `{ …, font, … }` or `font,` on a line of its own. */
const SHORTHAND_INLINE = /\{[^{}()\n]*?[{,]\s*font\s*(?=[,}])/g;
const SHORTHAND_LINE = /^[ \t]*font[ \t]*,?[ \t]*$/gm;
const LIB_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]@busy-app\/busy-lib['"]/g;
const LAYOUT_NAMES = new Set(["row", "column", "stack", "render", "measure"]);

function importsLayout(code) {
  for (const match of code.matchAll(LIB_IMPORT)) {
    for (const spec of match[1].split(",")) if (LAYOUT_NAMES.has(spec.trim().replace(/^type\s+/, "").split(/\s/)[0])) return true;
  }
  return false;
}

function sources(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(file, out);
    else if (SOURCE_FILE.test(entry.name)) out.push(file);
  }
  return out;
}

const lineOf = (code, index) => code.slice(0, index).split("\n").length;
/** A match on a comment line or in a doc comment is not code (the build's own rule). */
const inComment = (code, index) => /(\/\/|\*)/.test(code.slice(code.lastIndexOf("\n", index) + 1, index));

/**
 * What in the project `dir` will leave a font without metrics when the app runs.
 * @returns {{ file: string, line: number, kind: "computed" | "outside-src", font: string|null, text: string }[]} `file`
 *   is relative to the project; `font` is the name where it is known; `text` is the piece of the source.
 */
export function fontWarnings(dir) {
  const inSrc = sources(path.join(dir, "src"));
  const beside = sources(path.join(dir, "shared"));
  const read = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  const files = [...inSrc.map((file) => ({ file, src: true })), ...beside.map((file) => ({ file, src: false }))].map((entry) => ({ ...entry, code: read(entry.file) }));
  if (!files.some(({ code }) => importsLayout(code))) return [];
  if (files.some(({ code }) => /\bregisterFontMaps\s*\(/.test(code))) return [];

  // The fonts the build bundles: named as a literal under src/.
  const bundled = new Set();
  for (const { code, src } of files) {
    if (!src) continue;
    for (const match of code.matchAll(FONT_PROP)) {
      const literal = LITERAL.exec(match[1].trim());
      if (literal && !inComment(code, match.index)) bundled.add(literal[2]);
    }
  }
  const found = [];
  for (const { file, code, src } of files) {
    const relative = path.relative(dir, file).split(path.sep).join("/");
    for (const match of code.matchAll(FONT_PROP)) {
      if (inComment(code, match.index)) continue;
      const value = match[1].trim();
      const literal = LITERAL.exec(value);
      if (literal) {
        if (!src && !bundled.has(literal[2])) found.push({ file: relative, line: lineOf(code, match.index), kind: "outside-src", font: literal[2], text: `font: ${value}` });
      } else if (!/^[A-Z]/.test(value) && !/^(string|unknown|any)\b/.test(value)) {
        // A capital letter or a type's name is a type annotation (`font: DeviceFont`), not a value.
        found.push({ file: relative, line: lineOf(code, match.index), kind: "computed", font: null, text: `font: ${value}` });
      }
    }
    for (const pattern of [SHORTHAND_INLINE, SHORTHAND_LINE]) {
      for (const match of code.matchAll(pattern)) {
        const at = match.index + match[0].lastIndexOf("font");
        if (inComment(code, at)) continue;
        found.push({ file: relative, line: lineOf(code, at), kind: "computed", font: null, text: "font (the short form of font: font)" });
      }
    }
  }
  const seen = new Set();
  return found
    .filter((warning) => !seen.has(`${warning.file}:${warning.line}`) && seen.add(`${warning.file}:${warning.line}`))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** The warnings in words, with what to do: null when there are none. */
export function fontWarningText(warnings) {
  if (!warnings.length) return null;
  const where = warnings.slice(0, 5).map((w) => `  ${w.file}:${w.line}  ${w.text}${w.kind === "outside-src" ? " (the build looks for font names in src/ only)" : ""}`);
  const named = [...new Set(warnings.map((w) => w.font).filter(Boolean))];
  const example = named[0] ?? "large";
  return [
    `Fonts the build cannot see (${warnings.length}): if this text is laid out with render() or measure(), the app will fail when it runs with 'font "…" has no metrics loaded':`,
    ...where,
    ...(warnings.length > where.length ? [`  and ${warnings.length - where.length} more`] : []),
    `The build bundles a font's metrics only for a font named as a string literal, font: "${example}", in a file under src/. Either write it that way there, or register the map once at the top of src/main.ts, only for the fonts you use (each font the layout measures takes about 9 KiB of the app's heap, "global" about 60 KiB: more than four fonts, or "global", do not fit the default 128 KiB):`,
    '  import { registerFontMaps } from "@busy-app/busy-lib";',
    `  import { ${example} } from "@busy-app/busy-lib/fonts";`,
    `  registerFontMaps(${example});`,
    "Elements placed by x, y and align and sent to DisplayDraw without render() need no metrics.",
  ].join("\n");
}
