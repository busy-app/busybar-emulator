// The Markdown rule of the catalog checks, apart from the others so that the device window loads it too: it imports
// nothing and touches no file.
//
// The catalog reads a description and a changelog with Python-Markdown and refuses what it recognizes outside level
// 1–2 headings, bold, italic, lists and http(s) links (its tools/check_markdown.py). What follows goes the same way
// over the text: blocks between empty lines, the block rules in that parser's order, then the rules of a line's
// inside. The patterns are that parser's own (its inlinepatterns and blockprocessors), written for JavaScript.

const MD_ESCAPED = /\\[\\`*_{}[\]()>#+\-.!]/g;
// A backtick that no backslash stands before, or one after a run of doubled backslashes.
const MD_BACKTICK = /(?<!\\)(?:\\\\)+(?=`)|(?<!\\)`/;
const MD_AUTOLINK = /<((?:[Ff]|[Hh][Tt])[Tt][Pp][Ss]?:\/\/[^<>]*)>/g;
const MD_AUTOMAIL = /<[^<> !]+@[^@<> ]+>/;
const MD_HTML = /<(?:\/?[a-zA-Z][^\s"'<>@]*(?:\s+[^\s"'=<>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+))?)*\s*\/?|!--(?:(?!<!--|-->)[^])*--|[?](?:(?!<[?]|[?]>)[^])*[?]|!\[CDATA\[(?:(?!<!\[CDATA\[|\]\]>)[^])*\]\])>/;
const MD_ENTITY = /&(?:#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z0-9]+);/;
const MD_RULE = /^ {0,3}(?:(?:-+ {0,2}){3,}|(?:_+ {0,2}){3,}|(?:\*+ {0,2}){3,}) *$/;
const MD_REFERENCE = /^ {0,3}\[[^[\]]*\]: *(?:\n *)?[^\s]+ *(?:\n *)?(?:(["'])(?:.*)\1 *|\((?:.*)\) *)?$/m;
const MD_LIST_ITEM = /^ {0,3}(?:[*+-]|\d+\.) +/;
const MD_INDENT = 4;

/** A line with its tabs put out to the next multiple of four, as the catalog's parser reads it. */
function withoutTabs(line) {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const c of line) out += c === "\t" ? " ".repeat(MD_INDENT - (out.length % MD_INDENT)) : c;
  return out;
}

/** Whether an address is one the catalog links to: http or https with a host. */
function webAddress(address) {
  const m = /^(https?):(\/\/([^/?#]*))?/i.exec(address.trim());
  return Boolean(m && m[3]);
}

/** What the catalog refuses inside the lines of one block, with the line it is on (from 0), or null. */
function insideProblem(lines) {
  const text = lines.join("\n");
  const lineAt = (index) => text.slice(0, Math.max(0, index)).split("\n").length - 1;
  const first = (pattern, from = text) => {
    const m = pattern.exec(from);
    return m ? m.index : -1;
  };
  let at = first(MD_BACKTICK);
  if (at >= 0) return { line: lineAt(at), what: "code (a backtick)" };
  // A character after a backslash is that character and starts nothing.
  let rest = text.replace(MD_ESCAPED, "\u0002\u0002");
  // Links: the address must be http(s); what stands in the brackets of the address is not read further.
  const links = /(!?)\[([^\]]*)\]\(\s*(<[^<>\n]*>|[^)\s]*)/g;
  for (let m = links.exec(rest); m; m = links.exec(rest)) {
    if (m[1]) continue;
    const address = m[3].startsWith("<") ? m[3].slice(1, -1) : m[3];
    if (!webAddress(address)) return { line: lineAt(m.index), what: `a link that is not http:// or https:// (${address.slice(0, 40) || "empty"})` };
    const from = m.index + m[0].length - m[3].length;
    rest = rest.slice(0, from) + "\u0002".repeat(m[3].length) + rest.slice(from + m[3].length);
  }
  at = rest.indexOf("![");
  if (at >= 0) return { line: lineAt(at), what: "an image" };
  // An address in angle brackets is a link when it is http(s); ftp is refused there.
  for (const m of [...rest.matchAll(MD_AUTOLINK)]) {
    if (!webAddress(m[1])) return { line: lineAt(m.index), what: `HTML or an address in angle brackets that is not http(s) (${m[0].slice(0, 30)})` };
    rest = rest.slice(0, m.index) + "\u0002".repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  const mail = MD_AUTOMAIL.exec(rest);
  const html = MD_HTML.exec(rest);
  const tag = [mail, html].filter(Boolean).sort((a, b) => a.index - b.index)[0];
  if (tag) return { line: lineAt(tag.index), what: `HTML or an address in angle brackets that is not http(s) (${tag[0].slice(0, 30)})` };
  at = first(MD_ENTITY, rest);
  if (at >= 0) return { line: lineAt(at), what: "an HTML entity (&…;)" };
  return null;
}

const MD_TAB = " ".repeat(MD_INDENT);
const indentOf = (line) => line.length - line.trimStart().length;
/** A block without `levels` indents: each line that has them loses them, the others stay (the parser's own way). */
const detabbed = (lines, levels) => lines.map((line) => (line.startsWith(MD_TAB.repeat(levels)) ? line.slice(MD_INDENT * levels) : line));
const CODE = (number) => `line ${number + 1}: a code block (a line that starts with four spaces or a tab)`;

const MD_NESTED_ITEM = /^ {4,7}(?:\d+\.|[*+-]) +/;

/**
 * Goes over `lines` (with their numbers in the whole text) as the catalog's parser does: { problem, depth }.
 * `problem` is the first thing it refuses, or null; `depth` how many lists are open at the end, which is how far an
 * indented block after it still belongs to a list's item. `mode`: "top" for the text itself, "item" inside a list's
 * item (one indent belongs to the item), "inner" for a block that already lost its indent (a further indent is code).
 * `first`: the text's own first line, which is a line of the first block even when it holds only spaces.
 */
function scanBlocks(lines, numbers, mode = "top", first = false) {
  // Blocks: the lines between empty ones; a heading line (#) ends the block before it and starts one after it.
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" && !(first && i === 0 && line !== "")) {
      open = null;
      continue;
    }
    if (/^#{1,6}/.test(line)) {
      blocks.push({ lines: [line], at: [numbers[i]], heading: true });
      open = null;
      continue;
    }
    if (!open) blocks.push((open = { lines: [], at: [], heading: false }));
    open.lines.push(line);
    open.at.push(numbers[i]);
  }
  const base = mode === "item" ? 1 : 0;
  // An indented block: without as many indents as the lists before it go deep, read as a block of the item there.
  const indented = (blockLines, at, deep) => {
    const levels = mode === "inner" ? 0 : Math.min(Math.floor(indentOf(blockLines[0]) / MD_INDENT), deep);
    const inner = detabbed(blockLines, levels);
    if (levels === 0 || inner[0].startsWith(MD_TAB)) return { problem: CODE(at[0]), depth: 0, levels };
    return { ...scanBlocks(inner, at, "inner"), levels };
  };
  let depth = 0;
  for (const block of blocks) {
    const at = (line) => `line ${block.at[line] + 1}`;
    const text = block.lines.join("\n");
    if (block.lines[0].startsWith(MD_TAB)) {
      const found = indented(block.lines, block.at, base + depth);
      if (found.problem) return found;
      depth = found.levels - base + found.depth;
      continue;
    }
    if (block.heading) {
      if (/^#{3,}/.test(block.lines[0])) return { problem: `${at(0)}: a heading below level 2`, depth: 0 };
      const inside = insideProblem([block.lines[0]]);
      if (inside) return { problem: `${at(0)}: ${inside.what}`, depth: 0 };
      depth = 0;
      continue;
    }
    if (block.lines.length > 1 && /^(?:=+|-+) *$/.test(block.lines[1])) return { problem: `${at(1)}: a heading made by underlining (=== or ---)`, depth: 0 };
    const rule = block.lines.findIndex((line) => MD_RULE.test(line));
    if (rule >= 0) return { problem: `${at(rule)}: a horizontal line`, depth: 0 };
    if (MD_LIST_ITEM.test(block.lines[0])) {
      // A list: each line that starts an item; an indented line that starts one is nested in the item before it,
      // with the lines after it; any other line goes on in the item before it.
      const items = [];
      for (let i = 0; i < block.lines.length; i++) {
        const line = block.lines[i];
        const marker = MD_LIST_ITEM.exec(line);
        const last = items.at(-1);
        if (marker) items.push({ nested: false, lines: [line.slice(marker[0].length)], at: [block.at[i]] });
        else if (MD_NESTED_ITEM.test(line) && !last.nested) items.push({ nested: true, lines: [line], at: [block.at[i]] });
        else (last.lines.push(line), last.at.push(block.at[i]));
      }
      let within = 0;
      for (const item of items) {
        if (item.nested) {
          const found = indented(item.lines, item.at, 1 + within);
          if (found.problem) return found;
          within = found.levels - 1 + found.depth;
        } else {
          const found = scanBlocks(item.lines, item.at, "item");
          if (found.problem) return found;
          within = found.depth;
        }
      }
      depth = 1 + within;
      continue;
    }
    const quote = block.lines.findIndex((line) => /^ {0,3}>/.test(line));
    if (quote >= 0) return { problem: `${at(quote)}: a quote (>)`, depth: 0 };
    const reference = MD_REFERENCE.exec(text);
    if (reference) return { problem: `${at(text.slice(0, reference.index).split("\n").length - 1)}: a link defined by reference ([name]: address)`, depth: 0 };
    const inside = insideProblem(block.lines);
    if (inside) return { problem: `${at(inside.line)}: ${inside.what}`, depth: 0 };
    depth = 0;
  }
  return { problem: null, depth };
}

/**
 * The catalog takes level 1–2 headings, bold, italic, lists and http(s) links in a description and a changelog.
 * { problem } names the first thing it refuses; { unsure } is kept for something it may read as one (nothing is now).
 */
export function markdownProblem(text) {
  if (text.trim() === "") return { problem: null, unsure: null };
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(withoutTabs);
  return { problem: scanBlocks(lines, lines.map((_, i) => i), "top", true).problem, unsure: null };
}
