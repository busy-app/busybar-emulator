// For the tests of publishing (stale-check): Pre-flight check builds the app and checks its types with the project's
// own tools, so a project the tests write by hand is made one that can be built: trusted, as create leaves it, with a
// busy-cli in node_modules; and the tools are stand-ins (system.mjs runTool) that answer as busy-cli and tsc do.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { system } from "../../cli/system.mjs";
import { trustProject } from "../../projects/trust.mjs";

/** The project at `dir` made buildable for a test whose data folder is <home>/data. */
export function buildable(home, dir) {
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(path.join(cli, "dist"), { recursive: true });
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(path.join(cli, "dist", "index.js"), "");
  trustProject(path.join(home, "data"), dir, "created", { platform: process.platform });
}

/** What busy-cli 0.6 (vite's transform) prints for `mport { device } from "@shared/device";`, line 1 of src/main.ts. */
export const BROKEN_BUILD = [
  "│",
  "◇  Building app.example.desk-clock v0.1.0",
  "✗ Build failed in 11ms",
  "│",
  "■  The build failed:",
  "│  [builtin:vite-transform] Expected a semicolon or an implicit semicolon after a statement, but found none",
  "│     ╭─[ src/main.ts:1:6 ]",
  "│     │",
  '│   1 │ mport { device } from "@shared/device";',
  "│     │      │",
  "│     │      ╰─",
  "│     │ Help: Try inserting a semicolon here",
  "│  ───╯",
  "│",
].join("\n");

/**
 * A system whose tools answer as `tools` says: (request) => { code, output } for busy-cli build (args[1] "build") and
 * npm run typecheck; every call is kept in `calls`.
 */
export function toolsAnswering(answer = () => ({ code: 0, output: "" })) {
  const calls = [];
  return {
    ...system,
    calls,
    runTool: async (_setup, request) => {
      calls.push(request);
      const said = answer(request) ?? { code: 0, output: "" };
      return { code: said.code ?? 0, signal: null, output: said.output ?? "" };
    },
  };
}

/** Tools that build and type-check without a word. */
export const BUILDS = toolsAnswering();

/**
 * Notes the project at `dir` as checked and packaged as it is now (the records publish check and publish package
 * write, with their fingerprints): for tests of stage 2, whose projects are not built.
 */
export async function markChecked(dir) {
  const { noteStep } = await import("../files.mjs");
  const { fingerprint } = await import("../fingerprint.mjs");
  noteStep(dir, "check", { passed: true, fails: 0, built: true, compiled: true, typed: null, fingerprint: fingerprint(dir) });
  mkdirSync(path.join(dir, "submission"), { recursive: true });
  noteStep(dir, "package", { bytes: 1, filled: false, folder: path.join(dir, "submission"), fingerprint: fingerprint(dir, { scope: "package" }) });
}
