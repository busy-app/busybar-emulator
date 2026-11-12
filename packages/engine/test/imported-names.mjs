// What each module imports, by name, as the JavaScript engine reads it (not a search of the text): for the tests that
// keep the starting of programs and the writing of files to the modules allowed to do it (EMU-010).
//
// A module is compiled by V8 (node:vm SourceTextModule, which needs --experimental-vm-modules: this file runs in a
// child process of its own) and linked against empty stand-ins for what it imports. A stand-in that lacks a name the
// module imports fails the link with the name; it is added and the link tried again, until the link holds. Nothing is
// run. `import * as x` and `export * from` take every name: they come out as "*". A dynamic import() is not seen by
// the engine before it runs; the text scan of programs.test.mjs looks for those.
//
//   node --experimental-vm-modules imported-names.mjs <file>...   prints { file: { specifier: [names] } } as JSON
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const MISSING = /The requested module '(.+?)' does not provide an export named '(.+?)'/;
const NAMESPACE = /(?:^|[;\s])(?:import\s*\*\s*as\s+[\w$]+\s+from|export\s*\*(?:\s*as\s+[\w$]+)?\s*from)\s*(["'])(.+?)\1/g;

async function namesOf(file) {
  const source = readFileSync(file, "utf8");
  const wanted = new Map();
  for (let round = 0; round < 1000; round++) {
    const module = new vm.SourceTextModule(source, { identifier: file });
    const standIns = new Map();
    try {
      await module.link((specifier) => {
        if (!standIns.has(specifier)) {
          if (!wanted.has(specifier)) wanted.set(specifier, new Set());
          standIns.set(specifier, new vm.SyntheticModule([...wanted.get(specifier)], () => {}, { identifier: specifier }));
        }
        return standIns.get(specifier);
      });
    } catch (e) {
      const m = MISSING.exec(String(e?.message));
      if (!m) throw new Error(`${file}: ${e?.message ?? e}`);
      wanted.get(m[1]).add(m[2]);
      continue;
    }
    // The engine links a namespace import without asking for a name; the text says which specifiers those are.
    for (const m of source.matchAll(NAMESPACE)) if (wanted.has(m[2])) wanted.get(m[2]).add("*");
    return Object.fromEntries([...wanted].map(([specifier, names]) => [specifier, [...names].sort()]));
  }
  throw new Error(`${file}: too many names`);
}

/** { file: { specifier: [names] } } for `files`, read in a child process that has the engine's module parser. */
export function importedNames(files) {
  const r = spawnSync(process.execPath, ["--experimental-vm-modules", "--no-warnings", fileURLToPath(import.meta.url), ...files], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`imported-names.mjs failed: ${r.stderr || r.error}`);
  return JSON.parse(r.stdout);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = {};
  for (const file of process.argv.slice(2)) out[file] = await namesOf(file);
  process.stdout.write(JSON.stringify(out));
}
