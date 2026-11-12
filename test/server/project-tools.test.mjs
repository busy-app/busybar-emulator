// The whole path of an app author without a Node of their own (EMU-206), on the Node inside the app: the official
// generator, the dependencies, busy-cli build, and busy-cli app install, run and stop against an emulator — each step
// through runNodeTool alone, with a node, npm and npx on PATH that fail if anything runs them. The app is laid out as
// the packaging lays it out (packages/app/test/fixtures/layout.mjs: the pinned Node from its archive), the project
// lies in a folder with spaces and letters outside Latin, and the home is the test's own.
//
// Needs the npm registry (the template and its dependencies): this is the one test that goes to the network.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { layOutApp } from "../../packages/app/test/fixtures/layout.mjs";
import { busyCliScript, CACHE_FOLDER, fixFontMaps, installArguments, nodeToolsAt, runNodeTool } from "../../packages/server/projects/node-tools.mjs";
import { personEnvironment, poisonedFolder } from "../../packages/server/projects/test/test-support.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, port, tempDir, until } from "./helpers.mjs";

after(finish);

const GENERATOR = "@busy-app/create-app@^0.5.0";
const ID = "app.emu.tools_e2e";

let folder;
let emulator;
const logLines = [];
let setup;
let home;
let poison;

before(async () => {
  folder = realpathSync(tempDir({ after: () => {} }));
  const app = await layOutApp(join(folder, "app"));
  emulator = await startServer({ port: port(0), dataDir: join(folder, "bar"), barSpeed: false, log: (line) => logLines.push(line) });
  home = join(folder, "home");
  mkdirSync(home);
  poison = poisonedFolder(folder);
  setup = {
    tools: nodeToolsAt({ platform: process.platform, resourcesDir: app.resources, execPath: "/the/test/node/must/not/be/used" }),
    dataDir: join(folder, "data"),
    platform: process.platform,
    env: personEnvironment(home, poison),
    windowsDir: process.env.SystemRoot ?? null,
  };
});
after(async () => {
  await emulator?.stop();
});

async function step(name, request) {
  const run = await runNodeTool(setup, request);
  assert.equal(run.code, 0, `${name} failed:\n${run.output}`);
  assert.ok(!existsSync(poison.mark), `${name}: a node, npm or npx from PATH ran`);
  return run.output;
}

const front = async () => (await get(`${emulator.url}/api/screen?display=0`)).text;
const lit = (frame) => Buffer.from(frame, "base64").some((byte) => byte !== 0);
/** The rows of the front frame (72×16, 3 bytes a pixel) from `first` to `last`. */
const rows = (frame, first, last) => Buffer.from(frame, "base64").subarray(first * 72 * 3, (last + 1) * 72 * 3).toString("base64");

test("generator, dependencies, build, install, run and stop, all on the bundled Node; the bar shows the template's frame", async () => {
  const generator = join(setup.dataDir, "tools", "create-app");
  mkdirSync(generator, { recursive: true });
  writeFileSync(join(generator, "package.json"), JSON.stringify({ private: true, dependencies: { "@busy-app/create-app": GENERATOR.split("@").pop() } }));
  await step("installing the generator", { tool: "npm", args: ["install", "--ignore-scripts", "--no-package-lock", "--no-audit", "--no-fund"], cwd: generator });

  // Letters outside Latin on macOS. Not on Windows: busy-cli packs with the system's tar.exe, which takes no path
  // outside the system's code page (busy-tools-issues.md, issue 4); there spaces only.
  const project = join(folder, process.platform === "win32" ? "app folder with spaces" : "Φάκελος app プロジェクト");
  const bin = JSON.parse(readFileSync(join(generator, "node_modules", "@busy-app", "create-app", "package.json"), "utf8")).bin["create-app"];
  await step("the generator", { tool: "node", args: [join(generator, "node_modules", "@busy-app", "create-app", bin), project, "--no-install", "--author", "Emulator Test", "--id", ID], cwd: generator });
  assert.ok(existsSync(join(project, "src", "appmeta", "manifest.json")));

  await step("the dependencies", { tool: "npm", args: installArguments(project), cwd: project });
  assert.equal(fixFontMaps(project, process.platform), process.platform === "win32" ? "patched" : "not-needed");

  const cli = busyCliScript(project);
  assert.ok(cli, "the project's busy-cli is installed");
  await step("busy-cli build", { tool: "node", args: [cli, "build"], cwd: project });
  assert.ok(existsSync(join(project, "dist", `${ID}.tgz`)));
  // The project's own npm scripts run on the bundled Node too: `npm run build` calls busy-cli by its #!/usr/bin/env node.
  await step("npm run build", { tool: "npm", args: ["run", "build"], cwd: project });

  const before = await front();
  const addr = ["--addr", `127.0.0.1:${emulator.port}`];
  await step("busy-cli app install", { tool: "node", args: [cli, "app", "install", ...addr], cwd: project });
  assert.ok(logLines.some((line) => line.includes(`Installed ${ID}`)), logLines.join("\n"));
  await step("busy-cli app run", { tool: "node", args: [cli, "app", "run", ...addr], cwd: project });

  // The template draws "Hello" over a counter it raises every second: once the app's first frame has faded in, the next
  // tick changes the counter's rows and leaves the lit rows of the title as they are.
  await until("the app's first frame", async () => {
    const frame = await front();
    return frame !== before && lit(frame);
  }, 15000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const first = await front();
  let second;
  await until("the counter's next value", async () => (second = await front()) !== first, 15000);
  const changed = [];
  const unchangedLit = [];
  for (let row = 0; row < 16; row++) {
    if (rows(first, row, row) !== rows(second, row, row)) changed.push(row);
    else if (lit(rows(first, row, row))) unchangedLit.push(row);
  }
  // The bold title takes the upper rows, the small counter the lower ones (column, centred).
  assert.ok(changed.length > 0 && changed.every((row) => row >= 9), `rows that changed: ${changed}`);
  assert.ok(unchangedLit.filter((row) => row < 9).length >= 5, `lit rows of the title: ${unchangedLit}`);

  await step("busy-cli app stop", { tool: "node", args: [cli, "app", "stop", ...addr], cwd: project });
  // The app is gone: the screen changes, and then no longer ticks.
  await until("the app's frame gone", async () => (await front()) !== second, 15000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const menu = await front();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await front(), menu, "nothing ticks any more");

  // Nothing was written into the home: npm's cache is in the data folder.
  assert.deepEqual(readdirSync(home), []);
  assert.ok(readdirSync(join(setup.dataDir, CACHE_FOLDER)).includes("_cacache"));
});
