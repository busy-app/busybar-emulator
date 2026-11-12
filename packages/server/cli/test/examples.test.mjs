// create --examples and create <folder> --example <name> (examples.mjs), against a stand-in for the system: the
// generator is a stand-in that writes what the official one writes, so no network and no Node of the tools. The real
// thing — every example created, built and run on the bar — is emulator/test/examples.test.mjs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadCommands, main } from "../busy-emulator.mjs";
import { applyExample, EXAMPLES_DIR, listExamples } from "../examples.mjs";
import { isTrusted } from "../../projects/trust.mjs";

const commands = await loadCommands();
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-examples-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const ctx = {
    platform: "darwin",
    kind: "release",
    development: false,
    dataDir,
    runStateFile: path.join(dataDir, "run", "emulator.json"),
    calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"],
    testLaunch: null,
    nodeTools: { node: "/x/node", npmCli: "/x/npm-cli.js", npxCli: "/x/npx-cli.js", nodeDir: "/x" },
    env: {},
  };
  return { root, ctx };
}

async function call(argv, ctx, sys, { json = true } = {}) {
  const out = [];
  const code = await main(json ? [...argv, "--json"] : argv, { ctx, sys, commands, out: (line) => out.push(line), err: () => {} });
  return json ? { code, json: JSON.parse(out.at(-1)) } : { code, text: out.join("\n") };
}

/** What the official generator leaves in a new project, as far as create --example reads and replaces it. */
function templateProject(target, { id = "app.jane.my-app", author = "Jane", name = "my-app", apiVersion = "27.12.0" } = {}) {
  mkdirSync(path.join(target, "src", "appmeta"), { recursive: true });
  mkdirSync(path.join(target, "shared"), { recursive: true });
  writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "my-app", author, description: name, devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(target, "src", "appmeta", "manifest.json"), JSON.stringify({ format_version: 1, id, name, version: "0.1.0", api_version: apiVersion, description: name, author }));
  writeFileSync(path.join(target, "src", "main.ts"), "// the template's Hello\n");
  writeFileSync(path.join(target, "src", "template-only.ts"), "// a file only the template has\n");
  writeFileSync(path.join(target, "shared", "settings.ts"), "// the template's settings\n");
  writeFileSync(path.join(target, "AGENTS.md"), "# AGENTS.md of the template\n");
}

/** The generator's install, the generator (a stand-in that writes the template), then the project's install. */
function createSystem(root, target, generated = {}) {
  const calls = [];
  return {
    calls,
    cwd: () => root,
    async runTool(_setup, request) {
      calls.push(request);
      if (calls.length === 1) {
        const pkg = path.join(request.cwd, "node_modules", "@busy-app", "create-app");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.5.0", bin: { "create-app": "dist/index.js" } }));
      } else if (calls.length === 2) {
        templateProject(target, generated);
      } else {
        const cli = path.join(target, "node_modules", "@busy-app", "cli");
        mkdirSync(path.join(cli, "dist"), { recursive: true });
        writeFileSync(path.join(cli, "package.json"), JSON.stringify({ bin: { "busy-cli": "dist/index.js" } }));
        writeFileSync(path.join(cli, "dist", "index.js"), "");
      }
      return { code: 0, signal: null, output: "" };
    },
  };
}

test("create --examples lists the examples from their manifests, a line each, and runs nothing", async (t) => {
  const { root, ctx } = setup(t);
  const sys = { cwd: () => root, runTool: async () => assert.fail("create --examples runs no tool") };
  const listed = await call(["create", "--examples"], ctx, sys);
  assert.equal(listed.code, 0, JSON.stringify(listed.json));
  assert.deepEqual(listed.json.examples.map((example) => example.name), listExamples().map((example) => example.name));
  assert.ok(listed.json.examples.length >= 3);
  for (const example of listed.json.examples) {
    const manifest = readJson(path.join(EXAMPLES_DIR, example.name, "src", "appmeta", "manifest.json"));
    assert.deepEqual(example, { name: example.name, title: manifest.name, description: manifest.description });
  }
  // --pictures (the window's Create app): each one's icon and a frame of its front display, as data: addresses.
  const pictured = await call(["create", "--examples", "--pictures"], ctx, sys);
  for (const example of pictured.json.examples) {
    for (const [key, file] of [["icon", ["src", "appmeta", "icon_front_8x8.png"]], ["front", ["docs", "front.png"]]]) {
      assert.equal(example[key], `data:image/png;base64,${readFileSync(path.join(EXAMPLES_DIR, example.name, ...file)).toString("base64")}`, `${example.name} ${key}`);
    }
  }
  const text = (await call(["create", "--examples"], ctx, sys, { json: false })).text.split("\n");
  assert.match(text[0], /create <folder> --example <name>/);
  assert.equal(text.length, 1 + listed.json.examples.length);
  for (const example of listed.json.examples) assert.ok(text.some((line) => line.startsWith(`  ${example.name} `) && line.includes(example.title)), example.name);
});

test("create --example with a name that is no example is a wrong call, told before anything runs", async (t) => {
  const { root, ctx } = setup(t);
  const sys = { cwd: () => root, runTool: async () => assert.fail("nothing runs for an example that is not there") };
  const answer = await call(["create", "mine", "--example", "no-such-example"], ctx, sys);
  assert.equal(answer.code, 2);
  assert.equal(answer.json.code, "usage");
  assert.match(answer.json.message, /^There is no example app "no-such-example": the examples are /);
  assert.match(answer.json.hint, /busy-emulator create --examples says what each one is\.$/);
  assert.ok(!existsSync(path.join(root, "mine")));
  // --example needs a name.
  const bare = await call(["create", "mine", "--example"], ctx, sys);
  assert.equal(bare.code, 2);
  assert.equal(bare.json.code, "usage");
});

test("create --example: the generator runs as always, then the example's app replaces the template's under the project's own id and author", async (t) => {
  const { root, ctx } = setup(t);
  const [example] = listExamples();
  const target = path.join(root, "mine");
  const sys = createSystem(root, target, { id: "app.jane.mine", author: "Jane" });
  const made = await call(["create", "mine", "--example", example.name, "--author", "Jane"], ctx, sys);
  assert.equal(made.code, 0, JSON.stringify(made.json));
  assert.equal(made.json.example, example.name);
  assert.equal(made.json.id, "app.jane.mine");
  assert.equal(made.json.trusted, "created");
  assert.equal(isTrusted(ctx.dataDir, target), true);
  // The generator got what it always gets: --example is not its option.
  assert.equal(sys.calls.length, 3);
  assert.deepEqual(sys.calls[1].args.slice(1), [target, "--no-install", "--author=Jane"]);

  const source = readJson(path.join(example.dir, "src", "appmeta", "manifest.json"));
  assert.deepEqual(readJson(path.join(target, "src", "appmeta", "manifest.json")), { ...source, id: "app.jane.mine", author: "Jane" });
  const pkg = readJson(path.join(target, "package.json"));
  assert.deepEqual([pkg.name, pkg.author, pkg.description], ["my-app", "Jane", source.description]);
  assert.deepEqual(pkg.dependencies, readJson(path.join(example.dir, "package.json")).dependencies);
  // The example's files are there, the template's app is gone, what only the template has stays.
  for (const file of ["src/main.ts", "src/appmeta/settings.json", "shared/settings.ts", "shared/screen.ts", "README.md"]) {
    assert.equal(readFileSync(path.join(target, file), "utf8"), readFileSync(path.join(example.dir, file), "utf8"), file);
  }
  assert.ok(!existsSync(path.join(target, "src", "template-only.ts")));
  // The template's AGENTS.md stays, with the emulator's section added to it as for every created project; the
  // example's own settings helper, which already reads the bar's API, is not replaced.
  const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# AGENTS.md of the template\n"), agents.slice(0, 80));
  assert.match(agents, /<!-- busy-emulator:begin -->[\s\S]*<!-- busy-emulator:end -->/);
  assert.deepEqual(made.json.template, { settings_helper: "not-needed", agents_md: "added" });
  // Nothing a build or an install left in the example's folder in a working tree came along.
  assert.ok(!existsSync(path.join(target, "dist")));
});

test("create --example keeps the example's name and description unless --name, --description or --api-version name others", async (t) => {
  const { root } = setup(t);
  const [example] = listExamples();
  const source = readJson(path.join(example.dir, "src", "appmeta", "manifest.json"));
  const target = path.join(root, "named");
  templateProject(target, { id: "app.x.named", author: "X", name: "My Timer", apiVersion: "27.9.0" });
  const result = applyExample(example, target, { name: "My Timer", description: "Mine", apiVersion: "27.9.0" });
  assert.deepEqual(result, { id: "app.x.named", name: "My Timer" });
  assert.deepEqual(readJson(path.join(target, "src", "appmeta", "manifest.json")), { ...source, id: "app.x.named", author: "X", name: "My Timer", description: "Mine", api_version: "27.9.0" });
  assert.equal(readJson(path.join(target, "package.json")).description, "Mine");
});

test("only folders that hold an app are examples", (t) => {
  const { root } = setup(t);
  mkdirSync(path.join(root, "examples", "tools"), { recursive: true });
  mkdirSync(path.join(root, "examples", "one", "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(root, "examples", "README.md"), "");
  writeFileSync(path.join(root, "examples", "one", "src", "appmeta", "manifest.json"), JSON.stringify({ name: "One", description: "The first." }));
  assert.deepEqual(listExamples(path.join(root, "examples")), [{ name: "one", title: "One", description: "The first.", dir: path.join(root, "examples", "one") }]);
  assert.deepEqual(listExamples(path.join(root, "nowhere")), []);
});
