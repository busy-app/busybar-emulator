// Publishing, stage 1 (EMU-263): the catalog texts' rules (the same as the checks'), what git would publish of a
// folder, what looks like a secret, and the command line's `catalog-texts` and `publish` on a project the tests write
// by hand (../../readiness/test/project-fixture.mjs): no network, no git, no build, no emulator.
//
//   node --test emulator/packages/server/publish/test/publish.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../../cli/busy-emulator.mjs";
import { resolveContext } from "../../cli/context.mjs";
import { system } from "../../cli/system.mjs";
import { checkProject } from "../../readiness/check.mjs";
import { DETAILS, ID, makeProject } from "../../readiness/test/project-fixture.mjs";
import { textProblems } from "../../readiness/texts.mjs";
import { LICENSES, licenseText } from "../files.mjs";
import { scanProject, scanText } from "../secrets.mjs";
import { ignoredBy, parseIgnore, projectTree } from "../tree.mjs";
import { recognizeLicense } from "../../readiness/rules.mjs";
import { buildable, BUILDS } from "./stale-support.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "..", "cli", "busy-emulator.mjs");

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-publish-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function cli(home, argv, sys = system) {
  const ctx = resolveContext({ env: { BUSY_EMULATOR_DATA: path.join(home, "data") }, platform: process.platform, homeDir: home, scriptPath: CLI, execPath: process.execPath, nodeVersion: process.versions.node });
  const out = [];
  const err = [];
  const code = await main([...argv, "--json"], { ctx, sys, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, json: JSON.parse(out.join("\n")), err: err.join("\n") };
}

/** A finished project but for what stage 1 makes: no git, no license, no catalog texts, no README. */
function bareProject(t) {
  const home = tempDir(t);
  const dir = path.join(home, "desk clock");
  mkdirSync(dir);
  makeProject(dir, { git: false, files: (files) => Object.assign(files, { LICENSE: null, "catalog.json": null }) });
  return { home, dir };
}

// ---------------------------------------------------------------- the texts

test("the texts' rules say what the catalog's checks say", async (t) => {
  const good = { category: "clocks", short_description: "A clock for the desk, in big digits.", description: "A clock for the desk.\n\n**Start** shows the date, and the wheel turns the brightness.", changelog: "The first version." };
  assert.deepEqual(textProblems(good), { ok: true, problems: { category: null, short_description: null, description: null, changelog: null }, warnings: {} });
  const cases = [
    [{ category: "kitchen" }, "category", /Not one of the catalog's categories/, "category_public"],
    [{ short_description: "Too short" }, "short_description", /9 characters: the short description needs at least 10/, "manifest_schema"],
    [{ short_description: "Two\nlines here" }, "short_description", /One line/, "manifest_schema"],
    [{ description: "Short." }, "description", /6 characters: the description needs at least 50/, "text_resolve"],
    [{ changelog: "x".repeat(4001) }, "changelog", /4001 characters: the catalog takes at most 4000/, "changelog_text"],
    [{ description: `${good.description}\n\n<img src=x>` }, "description", /Markdown refuses/, "markdown"],
    [{ changelog: "@CHANGELOG.md is the file" }, "changelog", /may not start with @/, "changelog_text"],
  ];
  for (const [change, field, said, check] of cases) {
    const texts = { ...good, ...change };
    const answer = textProblems(texts);
    assert.match(answer.problems[field] ?? "", said, field);
    // The catalog's check of the same texts fails too: the form and the checks agree.
    const { dir } = bareProject(t);
    writeFileSync(path.join(dir, "catalog.json"), JSON.stringify(texts));
    const result = await checkProject({ dir });
    assert.equal(result.checks.find((one) => one.id === check).status, "fail", `${check} for ${JSON.stringify(change).slice(0, 60)}`);
  }
  assert.deepEqual(textProblems({ ...good, category: "meetings" }).warnings, { category: "Another name of productivity: write productivity." });
});

// ---------------------------------------------------------------- the files

test("what git would publish: the rules of .gitignore files, as git reads them", (t) => {
  const rules = parseIgnore("node_modules\n/dist\n*.log\n!keep.log\nbuild/\ndocs/**/secret.txt\n\\#hash\n");
  const cases = [
    ["node_modules", true, true],
    ["sub/node_modules", true, true],
    ["dist", true, true],
    ["sub/dist", true, false],
    ["a.log", false, true],
    ["keep.log", false, false],
    ["build", true, true],
    ["build", false, false],
    ["docs/secret.txt", false, true],
    ["docs/a/b/secret.txt", false, true],
    ["#hash", false, true],
  ];
  for (const [rel, folder, ignored] of cases) assert.equal(ignoredBy(rules, rel, folder), ignored, rel);
  const { dir } = bareProject(t);
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\ndist\nsrc/lib/\n");
  mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "");
  const tree = projectTree(dir);
  assert.ok(tree.published.includes("src/main.ts") && !tree.published.some((one) => one.startsWith("src/lib/") || one.startsWith("dist/") || one.startsWith("node_modules/")));
  assert.deepEqual(tree.left.map((one) => one.path).sort(), ["dist", "node_modules", "src/lib"]);
});

test("what looks like a secret is named by its kind and line, never by its value", (t) => {
  // Made here, so that this file holds no token and no home path itself.
  const token = ["ghp", "_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("");
  const home = ["", "Users", "janedoe", "projects", "x"].join("/");
  const found = scanText(`const a = 1;\nexport const KEY = "${token}";\nconst path = "${home}";\nconst none = "/Users/<you>/x";\n`, "src/x.ts");
  assert.deepEqual(
    found.map((one) => [one.line, one.kind]),
    [
      [2, "a GitHub token"],
      [3, "a path of a person's home folder, which names them"],
    ],
  );
  assert.deepEqual(scanText('const apiKey = "your-api-key-here";\nconst token = process.env.TOKEN;\n', "src/y.ts"), [], "placeholders and code are not secrets");
  const { dir } = bareProject(t);
  writeFileSync(path.join(dir, ".env"), "SERVICE_TOKEN=abcdefgh12345678\n");
  writeFileSync(path.join(dir, ".env.example"), "SERVICE_TOKEN=changeme\n");
  writeFileSync(path.join(dir, "id_ed25519"), "x\n");
  writeFileSync(path.join(dir, ".gitignore"), "node_modules\ndist\nid_ed25519\n");
  const findings = scanProject(dir, projectTree(dir));
  assert.deepEqual(
    findings.map((one) => [one.path, one.published]),
    [
      [".env", true],
      ["id_ed25519", false],
    ],
  );
  assert.equal(JSON.stringify(findings).includes("abcdefgh"), false);
});

test("the license texts are the standard ones, which the catalog's check recognizes, with the name and the year", () => {
  for (const { id } of LICENSES) {
    const text = licenseText(id, "Jane Doe", 2026);
    assert.match(text, /Copyright \(c\) 2026 Jane Doe/);
    // The catalog's check flags the word "noncommercially" of the GPL 3.0 text itself: a moderator reads it then.
    assert.equal(recognizeLicense(text), id === "GPL-3.0" ? null : id, id);
  }
});

// ---------------------------------------------------------------- the command line

test("catalog-texts: get says what is missing; set writes the texts given and keeps every other field", async (t) => {
  const { home, dir } = bareProject(t);
  const got = await cli(home, ["catalog-texts", "get", dir]);
  assert.deepEqual([got.code, got.json.ok, got.json.taken, got.json.exists, got.json.problems.category], [0, true, false, false, "Not written yet."]);
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ screenshots: ["screenshots/front-2.png"], category: "" }));
  const set = await cli(home, ["catalog-texts", "set", dir, `--category=${DETAILS.category}`, `--short-description=${DETAILS.short_description}`, `--description=${DETAILS.description}`, `--changelog=${DETAILS.changelog}`]);
  assert.deepEqual([set.code, set.json.taken], [0, true]);
  const written = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8"));
  assert.deepEqual(written.screenshots, ["screenshots/front-2.png"]);
  assert.equal(written.description, DETAILS.description);
  assert.equal((await cli(home, ["catalog-texts", "set", dir])).json.code, "usage");
  assert.equal((await cli(home, ["catalog-texts", "get", dir, "--category=clocks"])).json.code, "usage");
});

test("publish, stage 1, from the command line: license, files, screenshots, the checks grouped, and submission/ that waits for GitHub", async (t) => {
  const { home, dir } = bareProject(t);
  // Pre-flight check builds the app (stale-check): a trusted project, its busy-cli a stand-in that builds.
  buildable(home, dir);
  await cli(home, ["catalog-texts", "set", dir, `--category=${DETAILS.category}`, `--short-description=${DETAILS.short_description}`, `--description=${DETAILS.description}`, `--changelog=${DETAILS.changelog}`]);

  // The checks: the license fails; the repository on GitHub is stage 2's, not a failure.
  const checked = (await cli(home, ["publish", "check", dir], BUILDS)).json;
  assert.deepEqual([checked.passed, checked.fails.map((one) => [one.id, one.step])], [false, [["license", "license"]]]);
  assert.deepEqual(checked.stage2.map((one) => one.id), ["source_origin", "source_commit", "source_subdir"]);
  assert.equal((await cli(home, ["publish", "package", dir], BUILDS)).json.code, "check_failed", "nothing is packaged while a check fails");
  assert.equal(existsSync(path.join(dir, "submission")), false);

  // The license is never chosen for the person; one that is there is kept.
  assert.equal((await cli(home, ["publish", "license", dir])).json.code, "usage");
  assert.equal((await cli(home, ["publish", "license", dir, "--license=WTFPL"])).json.code, "usage");
  const licensed = (await cli(home, ["publish", "license", dir, "--license=Apache-2.0", "--author=Jane Doe", "--year=2026"])).json;
  assert.deepEqual([licensed.written, licensed.files], [true, [{ name: "LICENSE", spdx: "Apache-2.0" }]]);
  const again = (await cli(home, ["publish", "license", dir, "--license=MIT", "--author=Jane Doe"])).json;
  assert.deepEqual([again.written, again.kept], [false, "LICENSE"]);

  // The files: a README of the person's own is kept, until they ask for it to be replaced.
  writeFileSync(path.join(dir, "README.md"), "# My own words\n");
  writeFileSync(path.join(dir, ".env"), "SERVICE_TOKEN=abcdefgh12345678\n");
  // Made here, so that this file holds no token itself.
  writeFileSync(path.join(dir, "src", "secret.ts"), `export const KEY = "${["ghp", "_", "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"].join("")}";\n`);
  const plan = (await cli(home, ["publish", "files", dir])).json;
  // What looks like a secret starts kept out: not in what the repository will hold, and .gitignore is to get it.
  assert.deepEqual([plan.readme, plan.ignore_missing, plan.ready], ["yours", [".busy/", "submission/", ".DS_Store", "._*", "Thumbs.db", "desktop.ini", "/.env", "/src/secret.ts"], false]);
  assert.deepEqual(plan.findings.map((one) => [one.path, one.published, one.by_default]), [[".env", false, true], ["src/secret.ts", false, true]]);
  assert.deepEqual(plan.published.filter((one) => one.path === ".env" || one.path === "src/secret.ts"), []);
  // Published on purpose: kept in, and not kept out by default again at the next write.
  await cli(home, ["publish", "files", dir, "--write", "--keep-in=src/secret.ts"]);
  assert.ok(readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n").includes("/.env"), "the other one is kept out by the write");
  const kept = (await cli(home, ["publish", "files", dir, "--write"])).json;
  assert.equal(readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n").includes("/src/secret.ts"), false);
  assert.deepEqual(kept.findings.filter((one) => one.path === "src/secret.ts").map((one) => one.published), [true]);
  await cli(home, ["publish", "files", dir, "--write", "--keep-out=src/secret.ts"]);
  assert.ok(readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n").includes("/src/secret.ts"));
  assert.equal((await cli(home, ["publish", "files", dir, "--keep-out=.env"])).json.code, "usage", "a change needs --write");
  const files = (await cli(home, ["publish", "files", dir, "--write", "--keep-out=.env"])).json;
  assert.deepEqual([files.written, files.readme, files.findings.map((one) => [one.path, one.published]), files.ready], [[], "yours", [[".env", false]], true]);
  assert.equal(readFileSync(path.join(dir, "README.md"), "utf8"), "# My own words\n");
  const replaced = (await cli(home, ["publish", "files", dir, "--write", "--readme=replace"])).json;
  assert.deepEqual([replaced.written, replaced.readme], [["README.md"], "ours"]);
  const readme = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /^<!-- Made by BUSY Bar Emulator/);
  assert.match(readme, /# Desk Clock\n/);
  assert.match(readme, /<img src="screenshots\/front-1@8x\.png"/);
  assert.match(readme, /Apache-2\.0: see \[LICENSE\]\(LICENSE\)/);
  assert.match(readme, /Made for \[BUSY Bar\]\(https:\/\/busy\.app\)/);
  const ignore = readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.ok(ignore.startsWith("node_modules\ndist\n\n# Kept out of the public repository by BUSY Bar Emulator\n"), ignore);
  assert.ok(ignore.split("\n").includes("/.env"));
  // Taken back in: only a line the flow added.
  await cli(home, ["publish", "files", dir, "--write", "--keep-in=.env"]);
  assert.equal(readFileSync(path.join(dir, ".gitignore"), "utf8").split("\n").includes("/.env"), false);
  await cli(home, ["publish", "files", dir, "--write", "--keep-out=.env"]);
  assert.equal(readFileSync(path.join(dir, ".busy", ".gitignore"), "utf8").split("\n").includes("*"), true);

  // The screenshots: a new order goes into catalog.json; one taken out goes to .busy/removed/.
  const ordered = (await cli(home, ["publish", "screenshots", dir, '--order={"front":["screenshots/front-2.png","screenshots/front-1.png"],"back":["screenshots/back-1.png"]}'])).json;
  assert.deepEqual(ordered.front.map((one) => one.path), ["screenshots/front-2.png", "screenshots/front-1.png"]);
  assert.match(ordered.front[0].data, /^data:image\/png;base64,/);
  const removed = (await cli(home, ["publish", "screenshots", dir, "--remove=screenshots/front-1.png"])).json;
  assert.deepEqual(removed.front.map((one) => one.path), ["screenshots/front-2.png"]);
  assert.equal(existsSync(path.join(dir, "screenshots", "front-1.png")), false);
  assert.equal(existsSync(path.join(dir, "screenshots", "front-1@8x.png")), false, "with its enlarged copy");
  assert.equal((await cli(home, ["publish", "screenshots", dir, "--remove=../x.png"])).json.code, "usage");

  // README: How to use, a row a control; the step is done with at least one.
  assert.equal((await cli(home, ["publish", "status", dir])).json.steps.readme, "todo", "no How to use yet");
  assert.equal((await cli(home, ["publish", "readme", "set", dir, "--usage=- **Start**: Shows the date"])).json.ready, true);

  // The package: submission/, its manifest waiting for the repository on GitHub.
  const packaged = (await cli(home, ["publish", "package", dir], BUILDS)).json;
  assert.deepEqual([packaged.ok, packaged.filled, packaged.files], [true, false, [`applications/${ID}/manifest.yml`, "PR-DESCRIPTION.md", "SUBMIT.md"]]);
  const manifest = readFileSync(path.join(dir, "submission", "applications", ID, "manifest.yml"), "utf8");
  assert.match(manifest, /^sourcecode:\n {2}type: git\n {2}location:\n {4}# Filled in Stage 2: .*\n {4}origin: "https:\/\/github\.com\/<your-github-user>\/<repository>\.git"\n {4}commit_sha: "<the commit, after git push>"\ncategory: clocks\n/);
  assert.match(manifest, /\nscreenshots:\n {2}- screenshots\/front-2\.png\nback_screenshots:\n {2}- screenshots\/back-1\.png\n$/);
  const steps = readFileSync(path.join(dir, "submission", "SUBMIT.md"), "utf8");
  assert.match(steps, /git init -b main/);
  assert.match(steps, /git push -u origin main/);

  const status = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual(status.steps, { check: "done", texts: "done", screenshots: "done", readme: "done", license: "done", files: "done", package: "done" });
  assert.deepEqual([status.name, status.id], ["Desk Clock", ID]);
  assert.ok(status.by_hand.length >= 6);
});

test("publish status and screenshots read no file outside the project that catalog.json names: not by .., an absolute path or a link", async (t) => {
  // The auditor's case: catalog.json of someone else's project names a file beside it; the answer held its bytes.
  const { home, dir } = bareProject(t);
  writeFileSync(path.join(home, "secret.txt"), "TOP-SECRET-OUTSIDE\n");
  const outside = path.join(home, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "front.png"), "TOP-SECRET-OUTSIDE\n");
  let link = null;
  try {
    symlinkSync(outside, path.join(dir, "screenshots", "away"), process.platform === "win32" ? "junction" : undefined);
    link = "screenshots/away/front.png";
  } catch {
    // no links here: the rest still runs
  }
  mkdirSync(path.join(dir, "screenshots", "folder.png"));
  writeFileSync(path.join(dir, "screenshots", "huge.png"), Buffer.alloc(2 * 1024 * 1024));
  const listed = ["../secret.txt", path.join(home, "secret.txt"), "screenshots/../../secret.txt", "screenshots/folder.png", "screenshots/huge.png", ...(link ? [link] : []), "screenshots/front-1.png"];
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ ...DETAILS, screenshots: listed, back_screenshots: ["../secret.txt"] }));
  for (const argv of [["publish", "status", dir], ["publish", "screenshots", dir]]) {
    const { json } = await cli(home, argv);
    const shots = json.screenshots ?? json;
    assert.doesNotMatch(JSON.stringify(json), /VE9QLVNFQ1JFVC1PVVRTSURF|TOP-SECRET/, `${argv[1]}: nothing of a file outside is in the answer`);
    const of = (rel) => shots.front.find((one) => one.path === rel);
    for (const rel of ["../secret.txt", path.join(home, "secret.txt"), "screenshots/../../secret.txt", ...(link ? [link] : [])]) {
      assert.deepEqual([of(rel).data, of(rel).problem], [null, "The path leaves the project's folder."], rel);
    }
    assert.deepEqual([of("screenshots/folder.png").data, of("screenshots/folder.png").problem], [null, "It is not a file."]);
    assert.deepEqual([of("screenshots/huge.png").data, of("screenshots/huge.png").problem], [null, "The file is larger than 1024 KiB."]);
    assert.match(of("screenshots/front-1.png").data, /^data:image\/png;base64,/, "a screenshot of the project is shown");
    assert.equal(shots.back[0].problem, "The path leaves the project's folder.");
    assert.ok(shots.problems.some((one) => one.startsWith("../secret.txt: ")));
  }
  // Taking one out moves no file outside the project.
  await cli(home, ["publish", "screenshots", dir, "--remove=screenshots/folder.png"]);
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ ...DETAILS, screenshots: ["screenshots/front-1.png"], back_screenshots: ["../secret.txt"] }));
  assert.equal((await cli(home, ["publish", "screenshots", dir, "--remove=../secret.txt"])).json.code, "usage");
  assert.equal(readFileSync(path.join(home, "secret.txt"), "utf8"), "TOP-SECRET-OUTSIDE\n");
});

test("publish writes nothing through a link the project holds: .busy/removed, catalog.json and screenshots/ that lead out", async (t) => {
  // The review's case: .busy/removed is a link to a folder outside (as ~/Library/LaunchAgents), catalog.json lists a
  // file of the project; --remove moved it there.
  const link = (target, at) => {
    try {
      symlinkSync(target, at, process.platform === "win32" ? "junction" : undefined);
      return true;
    } catch {
      return false;
    }
  };
  const { home, dir } = bareProject(t);
  const agents = path.join(home, "LaunchAgents");
  mkdirSync(agents);
  mkdirSync(path.join(dir, ".busy"), { recursive: true });
  if (!link(agents, path.join(dir, ".busy", "removed"))) return t.skip("this system makes no links here");
  writeFileSync(path.join(dir, "evil.plist"), "<plist/>");
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ ...DETAILS, screenshots: ["screenshots/front-1.png", "evil.plist"] }));
  const removed = await cli(home, ["publish", "screenshots", dir, "--remove=evil.plist"]);
  assert.equal(removed.json.code, "outside_project", JSON.stringify(removed.json));
  assert.deepEqual(readdirSync(agents), [], "nothing moved out of the project");
  assert.ok(existsSync(path.join(dir, "evil.plist")));

  // catalog.json that is a link out is not written over.
  const other = bareProject(t);
  const theirs = path.join(other.home, "theirs.json");
  writeFileSync(theirs, "THEIRS");
  rmSync(path.join(other.dir, "catalog.json"), { force: true });
  assert.ok(link(theirs, path.join(other.dir, "catalog.json")) || process.platform === "win32");
  if (existsSync(path.join(other.dir, "catalog.json"))) {
    const ordered = await cli(other.home, ["publish", "screenshots", other.dir, '--order={"front":["screenshots/front-1.png"],"back":[]}']);
    assert.notEqual(ordered.code, 0);
    assert.equal(readFileSync(theirs, "utf8"), "THEIRS");
  }

  // screenshots/ that is a link out gets no PNG.
  const third = bareProject(t);
  const away = path.join(third.home, "away");
  mkdirSync(away);
  const picture = path.join(third.home, "front.png");
  writeFileSync(picture, readFileSync(path.join(third.dir, "screenshots", "front-1.png")));
  rmSync(path.join(third.dir, "screenshots"), { recursive: true, force: true });
  assert.ok(link(away, path.join(third.dir, "screenshots")));
  const uploaded = await cli(third.home, ["publish", "screenshots", third.dir, `--upload=${JSON.stringify([picture])}`]);
  assert.equal(uploaded.json.code, "outside_project", JSON.stringify(uploaded.json));
  assert.deepEqual(readdirSync(away), []);

  // The rule itself: inside by its real path, or refused.
  const { writable } = await import("../files.mjs");
  assert.equal(writable(dir, "README.md"), path.join(realpathSync(dir), "README.md"));
  assert.throws(() => writable(dir, ".busy/removed/x"), { code: "outside_project" });
  assert.throws(() => writable(dir, "../x"), { code: "outside_project" });
});

test("the README the flow makes puts the app's name and the screenshots' paths into its HTML escaped", async (t) => {
  const { readmeMarkdown } = await import("../readme.mjs");
  const text = readmeMarkdown(null, {
    name: 'Clock" onerror="alert(1)<b>',
    id: ID,
    texts: {},
    screenshots: { front: [{ path: 'screenshots/a"><script>x</script>.png', scaled: null }], back: [] },
    settings: [],
    license: null,
  });
  const img = text.split("\n").find((line) => line.startsWith("<img "));
  assert.equal(img, '<img src="screenshots/a&quot;&gt;&lt;script&gt;x&lt;/script&gt;.png" width="576" alt="Clock&quot; onerror=&quot;alert(1)&lt;b&gt;, the front display">');
});

test("publish files --keep-in takes back only the line the flow added: the person's own lines after the heading stay (audit H13)", async (t) => {
  const { home, dir } = bareProject(t);
  writeFileSync(path.join(dir, ".env"), "SERVICE_TOKEN=abcdefgh12345678\n");
  writeFileSync(path.join(dir, "notes.txt"), "mine\n");
  assert.equal((await cli(home, ["publish", "files", dir, "--write"])).code, 0);
  const file = path.join(dir, ".gitignore");
  assert.ok(readFileSync(file, "utf8").split("\n").includes("/.env"), "kept out by the flow");
  // The person adds lines of their own at the end, under the emulator's heading: the same /.env, and one of theirs only.
  writeFileSync(file, `${readFileSync(file, "utf8")}\n# mine\n/.env\n/notes.txt\n`);
  await cli(home, ["publish", "files", dir, "--write", "--keep-in=.env"]);
  const after = readFileSync(file, "utf8").split("\n");
  assert.deepEqual(after.filter((one) => one === "/.env"), ["/.env"], "one /.env is taken back, the person's stays");
  assert.ok(after.indexOf("/.env") > after.indexOf("# mine"), "the one that stays is the person's");
  await cli(home, ["publish", "files", dir, "--write", "--keep-in=notes.txt"]);
  assert.ok(readFileSync(file, "utf8").split("\n").includes("/notes.txt"), "a line the flow never added is not taken out");
});

test("publish prepare: never chooses the license, and does the rest in one go", async (t) => {
  const { home, dir } = bareProject(t);
  const refused = (await cli(home, ["publish", "prepare", dir])).json;
  assert.deepEqual([refused.code, existsSync(path.join(dir, "LICENSE"))], ["usage", false]);
  assert.equal((await cli(home, ["publish", "nothing", dir])).json.code, "usage");
});
