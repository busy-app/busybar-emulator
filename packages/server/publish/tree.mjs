// What of a project folder goes into its public repository: every file that git would take with `git add -A` (the
// rules of the .gitignore files in the folder and below it, and of .git/info/exclude), and every file git keeps
// already. Read from the files alone: no git is started. The rules are git's own (gitignore(5)): a pattern without a
// slash matches a name at any depth, one with a slash is anchored to its .gitignore's folder, a trailing slash
// matches only folders, "!" takes a path back unless a folder above it is left out, and the last rule that matches wins.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { readGit } from "../readiness/git-folder.mjs";

/** How many files are listed at most; a folder with more is said to be cut. */
export const MAX_FILES = 5000;

/** A pattern of a gitignore file as a regular expression of the path relative to that file's folder. */
function patternRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = glob[i + 2] === "/" || i + 2 === glob.length;
        if (before && after) {
          // "**/" any folders, "/**" everything inside
          if (glob[i + 2] === "/") {
            re += "(?:.*/)?";
            i += 2;
          } else {
            re += ".*";
            i += 1;
          }
          continue;
        }
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) re += "\\[";
      else {
        let set = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = `^${set.slice(1)}`;
        re += `[${set}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** The rules of a gitignore text whose folder is `base` (relative to the project, "" for the project itself). */
export function parseIgnore(text, base = "") {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    // Trailing spaces go, unless escaped.
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    rules.push({ base, negate, dirOnly, anchored, re: patternRegExp(line), text: line });
  }
  return rules;
}

/** Whether a path (relative to the project, "/"-separated) is left out by the rules, the last match winning. */
export function ignoredBy(rules, rel, isDir) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    let inside = rel;
    if (rule.base) {
      if (!rel.startsWith(`${rule.base}/`)) continue;
      inside = rel.slice(rule.base.length + 1);
    }
    const subject = rule.anchored ? inside : inside.slice(inside.lastIndexOf("/") + 1);
    if (rule.re.test(subject)) ignored = !rule.negate;
  }
  return ignored;
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * The project's files: what is published and what is not, each with the rule's reason.
 * `extraIgnore`: lines of a .gitignore that is about to be written (the plan), read as if the project's own had them.
 * @returns {{ published: string[], left: { path: string, folder: boolean, why: string }[], cut: boolean, rules: object[] }}
 */
export function projectTree(dir, { extraIgnore = [], replaceIgnore = null } = {}) {
  const git = readGit(dir);
  const exclude = git ? (readText(path.join(git.top, ".git", "info", "exclude")) ?? "") : "";
  const own = replaceIgnore ?? readText(path.join(dir, ".gitignore")) ?? "";
  const rules = [...parseIgnore(exclude), ...parseIgnore(own), ...parseIgnore(extraIgnore.join("\n"))];
  const kept = (rel) => Boolean(git?.index?.has(git.subdir ? `${git.subdir}/${rel}` : rel));
  const published = [];
  const left = [];
  let cut = false;
  const walk = (folder, relFolder, folderRules) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return;
    }
    // A .gitignore of a folder below adds its own rules for that folder.
    let here = folderRules;
    if (relFolder) {
      const nested = readText(path.join(folder, ".gitignore"));
      if (nested) here = [...folderRules, ...parseIgnore(nested, relFolder)];
    }
    for (const entry of entries) {
      if (published.length + left.length >= MAX_FILES) {
        cut = true;
        return;
      }
      const rel = relFolder ? `${relFolder}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (isDir && entry.name === ".git") continue;
      if (!isDir && !entry.isFile() && !entry.isSymbolicLink()) continue;
      if (ignoredBy(here, rel, isDir) && !kept(rel)) {
        left.push({ path: rel, folder: isDir, why: "in .gitignore" });
        continue;
      }
      if (isDir) walk(path.join(folder, entry.name), rel, here);
      else published.push(rel);
    }
  };
  walk(dir, "", rules);
  return { published, left, cut };
}
