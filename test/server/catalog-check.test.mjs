// busy-emulator check and submit as a built app carries them: the app laid out as the packaging lays it out
// (packages/app/test/fixtures/layout.mjs, with the emulator's files by the packaging's own list, which reads the files
// committed), its command line run on the Node inside it, on a finished project
// (packages/server/readiness/test/project-fixture.mjs). The app must carry the catalog's rules: the copy of the
// registry, so that the checks come with the catalog's own words, and the PNG checker, so that screenshots and icons
// are checked. No emulator runs, and no port is used: the two commands read the project's folder.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { layOutApp } from "../../packages/app/test/fixtures/layout.mjs";
import { emulatorFiles, EMULATOR_DIR } from "../../packages/app/tools/packaging/composition.mjs";
import { spawnProgram } from "../../packages/engine/programs.mjs";
import { ID, makeProject } from "../../packages/server/readiness/test/project-fixture.mjs";
import { finish, tempDir } from "./helpers.mjs";

after(finish);

let folder;
let app;

before(async () => {
  folder = realpathSync(tempDir({ after: () => {} }));
  app = await layOutApp(join(folder, "app"));
  // The emulator's files as a built app has them: the list of the packaging (composition.mjs), copied as
  // packaging/resources.mjs copies it, in place of the command line's own few that the layout put there.
  const to = join(app.resources, "emulator");
  rmSync(to, { recursive: true, force: true });
  for (const file of emulatorFiles()) {
    const out = join(to, ...file.split("/"));
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(join(EMULATOR_DIR, ...file.split("/")), out);
  }
});

/** Runs the app's command line on the app's Node: { code, stdout, stderr, json }. */
async function cli(words, cwd) {
  const home = join(folder, "home");
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local"), BUSY_EMULATOR_DATA: join(folder, "data"), PATH: "", SystemRoot: process.env.SystemRoot ?? "" };
  const child = spawnProgram(app.node, [app.cli, ...words], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const run = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (text) => (run.stdout += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (run.stderr += text));
  run.code = await new Promise((resolve, reject) => child.on("error", reject).on("close", resolve));
  const last = run.stdout.trim().split(/\r?\n/).pop();
  return { ...run, json: words.includes("--json") && last ? JSON.parse(last) : null };
}

test("the app carries the catalog's rules: the registry copy and the PNG checker lie beside its command line", () => {
  const server = join(app.resources, "emulator", "packages", "server");
  for (const file of ["readiness/catalog-registry.json", "readiness/rules.mjs", "readiness/check.mjs", "readiness/submission.mjs", "capture/catalog-png.mjs", "cli/commands/check.mjs", "cli/commands/submit.mjs"]) {
    assert.ok(existsSync(join(server, ...file.split("/"))), `${file} is in the app`);
  }
  assert.equal(JSON.parse(readFileSync(join(server, "readiness", "catalog-registry.json"), "utf8")).checks.length, 66);
});

test("check in the app: the catalog's words, pictures checked, scripts parsed on the bundled Node; submit writes its folder", async () => {
  const project = makeProject(join(folder, "projects", "desk clock"));
  const check = await cli(["check", "--json", "--full"], project);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.equal(check.stderr, "");
  const by = Object.fromEntries(check.json.checks.map((c) => [c.id, c]));
  assert.equal(check.json.rules.catalog_texts, true, "the registry copy is read");
  assert.equal(by.license.title, "Open source license");
  assert.equal(check.json.counts.total, 66);
  assert.deepEqual(check.json.checks.filter((c) => c.status === "fail").map((c) => c.id), []);
  for (const id of ["screenshot_png", "screenshot_final", "back_screenshot_png", "back_screenshot_final", "icon_png"]) assert.equal(by[id].status, "pass", `${id}: ${by[id].why}`);
  assert.equal(by.script_imports.status, "pass", by.script_imports.why);
  assert.equal(by.firmware_too_old.status, "pass", by.firmware_too_old.why);
  assert.deepEqual(check.json.counts, { total: 66, fail: 0, warning: 0, unchecked: 5, not_applicable: 7, pass: 54 });

  const submit = await cli(["submit", project, "--json", "--full"], folder);
  assert.equal(submit.code, 0, submit.stdout + submit.stderr);
  assert.deepEqual(submit.json.submission.files, [`applications/${ID}/manifest.yml`, "PR-DESCRIPTION.md", "SUBMIT.md"]);
  for (const file of submit.json.submission.files) assert.ok(existsSync(join(project, "submission", ...file.split("/"))), file);

  // The help names both.
  const help = await cli(["help"], folder);
  assert.match(help.stdout, /\n {2}check \[<folder>\] +\S/);
  assert.match(help.stdout, /\n {2}submit \[<folder>\] \[--catalog <owner\/repo>\] \[--full\]\n/);
});
