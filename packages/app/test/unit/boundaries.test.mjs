// The parts keep to themselves (architecture.md): the server knows nothing of Electron, and the shell imports
// nothing from the other parts — it starts the server as a program, by path.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { APP_DIR } from "../helpers.mjs";

const PACKAGES = path.dirname(APP_DIR);
const CODE = /\.(mjs|cjs|js)$/;

function filesOf(folder) {
  const out = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) out.push(...filesOf(full));
    else if (CODE.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every module a file names: import ... from, export ... from, import(), require(), and the require that
 * createRequire makes, called at once: createRequire(import.meta.url)("name").
 */
export function importsOf(source) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^"'`;]*?\sfrom\s*)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g,
    /\brequire\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g,
    /\bcreateRequire\s*\(\s*import\.meta\.url\s*\)\s*\(\s*["'`]([^"'`$]+)["'`]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

/**
 * The ways of loading a module that the scan above cannot follow, as the text that does it: import() or require()
 * of anything but a plain string, and a createRequire that is not called at once with one (a require kept for
 * later can load anything). Importing createRequire itself is not one of them.
 */
export function unfollowableLoadsOf(source) {
  const found = [];
  for (const match of source.matchAll(/\b(import|require)\s*\(\s*(?!["'][^"']*["']\s*\)|`[^`$]*`\s*\))([^)]{0,60})/g)) {
    // import.meta and the like are not a call.
    found.push(`${match[1]}(${match[2].trim()}`);
  }
  const uses = [...source.matchAll(/\bcreateRequire\b/g)].length;
  const imported = [...source.matchAll(/\bimport\s*\{[^}]*\bcreateRequire\b[^}]*\}\s*from\s*["']node:module["']/g)].length;
  const calledAtOnce = [...source.matchAll(/\bcreateRequire\s*\(\s*import\.meta\.url\s*\)\s*\(\s*["'`][^"'`$]+["'`]\s*\)/g)].length;
  for (let i = 0; i < uses - imported - calledAtOnce; i++) found.push("createRequire kept for later");
  return found;
}

test("what the scan cannot follow is named: import() and require() of a value, a createRequire kept for later", () => {
  const source = `
    import { createRequire } from "node:module";
    const fine = createRequire(import.meta.url)("electron");
    const a = await import(where + "build.mjs");
    const b = await import(\`../\${name}.mjs\`);
    const c = require(name);
    const req = createRequire(import.meta.url);
    const d = await import("literal");
    const e = import.meta.url;
    const f = require("node:fs");
  `;
  assert.deepEqual(unfollowableLoadsOf(source), ['import(where + "build.mjs"', "import(`../${name}.mjs`", "require(name", "createRequire kept for later"]);
  assert.deepEqual(importsOf(source).sort(), ["electron", "literal", "node:fs", "node:module"]);
});

test("a module named through createRequire is checked like any other", () => {
  assert.deepEqual(importsOf(`createRequire(import.meta.url)("../../engine/build.mjs")`), ["../../engine/build.mjs"]);
});

test("the scan sees every way of naming a module", () => {
  const source = `
    import a from "one";
    import { b,
      c } from 'two';
    import "three";
    export * from "four";
    const d = await import("five");
    const e = require('six');
    import * as f from "seven";
  `;
  assert.deepEqual(importsOf(source).sort(), ["five", "four", "one", "seven", "six", "three", "two"]);
});

test("packages/server imports nothing from Electron", () => {
  const files = filesOf(path.join(PACKAGES, "server"));
  assert.ok(files.length > 10, "the server's files were not found");
  for (const file of files) {
    for (const name of importsOf(readFileSync(file, "utf8"))) {
      assert.ok(name !== "electron" && !name.startsWith("electron/") && !name.startsWith("@electron/"), `${file} imports ${name}`);
    }
  }
});

// The packaging (tools/, and the tests of what it builds) may use the development dependencies it is built with and
// the engine's one helper for starting programs (EMU-237); nothing of that reaches the app (the release's files are
// src/ and package.json, tools/release-files.mjs).
const BUILD_ONLY = new Set(["@electron/asar", "@electron/fuses", "resedit"]);
const PROGRAMS = path.join(PACKAGES, "engine", "programs.mjs");
// The tests of what the app starts and writes read imports with the engine's parser (EMU-010).
const IMPORTED_NAMES = path.join(PACKAGES, "engine", "test", "imported-names.mjs");

// The loads the scan cannot follow, each with its reason. The supervisor imports the server by the path the shell
// gives it: that is how the shell starts the server, the one place the app reaches another part at run time (ADR-0016).
// The packaging check runs the export check of the repository, which it finds beside it. The test of the console's
// terminal gives the running app's shell a terminal with a stand-in launcher, loading terminal.mjs in its main process.
const UNFOLLOWABLE_ALLOWED = new Map([
  ["test/app/terminal.test.mjs", ["import(module"]],
  ["src/supervisor.mjs", ["import(pathToFileURL(serverModule"]],
  ["tools/packaging/check.mjs", ["import(pathToFileURL(path.join(tool, \"check.mjs\""]],
]);

test("packages/app loads no module in a way the scan cannot follow, but for the named exceptions", () => {
  const files = filesOf(APP_DIR).filter((file) => file !== fileURLToPath(import.meta.url));
  for (const file of files) {
    const name = path.relative(APP_DIR, file).split(path.sep).join("/");
    assert.deepEqual(unfollowableLoadsOf(readFileSync(file, "utf8")), UNFOLLOWABLE_ALLOWED.get(name) ?? [], name);
  }
});

test("packages/app imports only Electron, Node's own modules and its own files", () => {
  // This file holds made-up imports as test data.
  const files = filesOf(APP_DIR).filter((file) => file !== fileURLToPath(import.meta.url));
  assert.ok(files.some((file) => file.endsWith("main.mjs")));
  const buildSide = (file) => [path.join(APP_DIR, "tools"), path.join(APP_DIR, "test")].some((folder) => file.startsWith(folder + path.sep));
  for (const file of files) {
    for (const name of importsOf(readFileSync(file, "utf8"))) {
      if (name === "electron" || name.startsWith("node:")) continue;
      if (buildSide(file) && BUILD_ONLY.has(name)) continue;
      assert.ok(name.startsWith("."), `${file} imports the package ${name}`);
      const target = path.resolve(path.dirname(file), name);
      if (buildSide(file) && (target === PROGRAMS || target === IMPORTED_NAMES)) continue;
      assert.ok(target.startsWith(APP_DIR + path.sep), `${file} imports ${name}, which is outside packages/app`);
    }
  }
});

test("the development dependencies of the packaging are pinned exactly and are the only ones besides Electron", () => {
  const manifest = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined, "the app has no dependencies at run time");
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(), [...BUILD_ONLY, "electron"].sort());
  for (const [name, version] of Object.entries(manifest.devDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is not pinned exactly`);
});

test("the files of the release import nothing from the test variant except through the one guarded line", () => {
  const mentions = [];
  for (const file of filesOf(path.join(APP_DIR, "src"))) {
    for (const name of importsOf(readFileSync(file, "utf8"))) {
      if (name.includes("test-variant") || name.includes("/test/")) mentions.push(`${path.basename(file)}: ${name}`);
    }
  }
  assert.deepEqual(mentions, ["main.mjs: ../test-variant/hook.mjs"]);
});

// ADR-0016: release or development is decided by the marker inside the app's archive, never by the name of the
// executable (app.isPackaged looks at nothing else), and the environment is read in one place, whose overrides
// config.mjs gives only to the test variant and a development run (EMU-201 security review, S4).
test("the shell never asks app.isPackaged, and only main.mjs reads the environment", () => {
  const code = (file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const isPackaged = [];
  const environment = [];
  for (const file of filesOf(path.join(APP_DIR, "src"))) {
    const source = code(file);
    if (/\bisPackaged\b/.test(source)) isPackaged.push(path.basename(file));
    if (/\bprocess\s*\.\s*env\b/.test(source)) environment.push(path.basename(file));
  }
  assert.deepEqual(isPackaged, []);
  assert.deepEqual(environment, ["main.mjs"]);
});
