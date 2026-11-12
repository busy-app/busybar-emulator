// SHA256SUMS beside the files of a release, in the format of sha256sum and shasum -a 256: "<hex>  <name>", one line per
// file, sorted by name. `shasum -a 256 -c SHA256SUMS` on macOS and the PowerShell check of EMU-211 read it.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ALL_RELEASE_FILES, SUMS_FILE } from "./names.mjs";

export async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function parseSums(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`Not a line of ${SUMS_FILE}: ${JSON.stringify(line)}`);
    if (out.has(match[2])) throw new Error(`${SUMS_FILE} names ${match[2]} twice`);
    out.set(match[2], match[1]);
  }
  return out;
}

/** What is wrong with the names in a release folder: every file of ALL_RELEASE_FILES, nothing else. */
export function nameProblems(names, expected = ALL_RELEASE_FILES) {
  const problems = [];
  for (const name of expected) if (!names.includes(name)) problems.push(`missing: ${name}`);
  for (const name of names) if (!expected.includes(name)) problems.push(`not a file of the release: ${name}`);
  return problems;
}

/** Writes SHA256SUMS for the files of the release; refuses unless every one is there and nothing else is. */
export async function writeSums(folder) {
  const problems = nameProblems(readdirSync(folder).filter((name) => name !== SUMS_FILE).concat(SUMS_FILE));
  if (problems.length) throw new Error(`${folder} is not a whole release: ${problems.join("; ")}`);
  const lines = [];
  for (const name of ALL_RELEASE_FILES.filter((n) => n !== SUMS_FILE)) lines.push(`${await sha256Of(path.join(folder, name))}  ${name}`);
  writeFileSync(path.join(folder, SUMS_FILE), `${lines.join("\n")}\n`);
  return lines;
}

/** Checks a release folder: names, and every sum in SHA256SUMS against its file. Returns problems, one line each. */
export async function checkSums(folder) {
  const problems = nameProblems(readdirSync(folder));
  const sumsFile = path.join(folder, SUMS_FILE);
  if (!existsSync(sumsFile)) return problems;
  let sums;
  try {
    sums = parseSums(readFileSync(sumsFile, "utf8"));
  } catch (e) {
    return [...problems, e.message];
  }
  for (const name of ALL_RELEASE_FILES.filter((n) => n !== SUMS_FILE)) {
    if (!sums.has(name)) problems.push(`${SUMS_FILE} has no line for ${name}`);
    else if (existsSync(path.join(folder, name)) && (await sha256Of(path.join(folder, name))) !== sums.get(name)) problems.push(`${name} does not match its line in ${SUMS_FILE}`);
  }
  for (const name of sums.keys()) if (!ALL_RELEASE_FILES.includes(name)) problems.push(`${SUMS_FILE} names ${name}, which is not a file of the release`);
  return problems;
}

export function sizesOf(folder, names) {
  return Object.fromEntries(names.filter((n) => existsSync(path.join(folder, n))).map((n) => [n, statSync(path.join(folder, n)).size]));
}
