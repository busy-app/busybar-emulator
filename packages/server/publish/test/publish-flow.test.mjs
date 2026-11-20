// The publishing flow's order and what each step makes (publish-ux): the rules of the steps (which is done, which
// waits, why Next is off, what Next writes), the README step's README (made from the project, never the template's
// text), and screenshots brought in from files (checked, an enlargement made small exactly). The rules are the window's
// own file (legacy-window/publish-steps.mjs), loaded here as the window loads it; the rest through the command line on
// a project the tests write by hand. No network, no git, no build, no emulator.
//
//   node --test emulator/packages/server/publish/test/publish-flow.test.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decodePng, encodePng } from "../../capture/icon.mjs";
import { main } from "../../cli/busy-emulator.mjs";
import { resolveContext } from "../../cli/context.mjs";
import { system } from "../../cli/system.mjs";
import * as steps from "../../legacy-window/publish-steps.mjs";
import { makeProject, pngOf } from "../../readiness/test/project-fixture.mjs";
import { nameProblem } from "../../readiness/rules.mjs";
import { textProblems } from "../../readiness/texts.mjs";
import { readmeFileHints } from "../files.mjs";
import { defaultReadme, firstParagraph, README_MARK, readmeMarkdown, readmeProblem, templateLeft } from "../readme.mjs";
import { displayOf, frameOf, readScreenshotFile } from "../upload.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "..", "cli", "busy-emulator.mjs");
const RULES = { textProblems, nameProblem, readmeProblem };

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-publish-flow-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

async function cli(home, argv, { json = true } = {}) {
  const ctx = resolveContext({ env: { BUSY_EMULATOR_DATA: path.join(home, "data") }, platform: process.platform, homeDir: home, scriptPath: CLI, execPath: process.execPath, nodeVersion: process.versions.node });
  const out = [];
  const code = await main(json ? [...argv, "--json"] : argv, { ctx, sys: system, out: (line) => out.push(line), err: () => {} });
  return { code, json: json ? JSON.parse(out.join("\n")) : null, stdout: out.join("\n") };
}

/** A finished project but for what stage 1 makes, with the template's README and a settings file. */
function project(t) {
  const home = tempDir(t);
  const dir = path.join(home, "desk clock");
  mkdirSync(dir);
  makeProject(dir, { git: false, files: (files) => Object.assign(files, { LICENSE: null, "catalog.json": null }) });
  writeFileSync(path.join(dir, "README.md"), '# Desk Clock\n\nA JavaScript app for the BUSY Bar, generated from the BUSY JS app template.\n\n## Input\n\n`listen("input", handler)` delivers the device keys.\n');
  writeFileSync(path.join(dir, "src", "appmeta", "settings.json"), JSON.stringify({ format_version: 1, version: 1, fields: { size: { type: "enum", label: "Digits", description: "How big the digits are.", default: "big", options: [{ value: "big", label: "Big" }, { value: "small", label: "Small" }] }, seconds: { type: "boolean", label: "Seconds", default: true } } }));
  return { home, dir };
}

const TEXTS = { category: "clocks", short_description: "A clock for the desk, in big digits.", description: "A clock for the desk that shows the time in big digits.\n\n**Start** shows the date.", changelog: "The first version." };

// ---------------------------------------------------------------- the steps

test("the steps go in order: each done by what it made, later ones wait, nothing of a later step is shown early", () => {
  assert.deepEqual(steps.STEPS.map((one) => one.id), ["texts", "screenshots", "readme", "license", "files", "check", "package", "github", "catalog"]);
  const empty = { texts: { taken: false, texts: {}, name: "Desk Clock" }, screenshots: { ready: false, front: [], back: [] }, readme: { ready: false }, license: { ready: false, files: [] }, files: { ready: false }, check: null, package: { submission: null }, github: {} };
  assert.equal(steps.firstOpen(empty), "texts");
  const rail = steps.railStates(empty, "texts");
  assert.deepEqual(rail.map((one) => one.state), ["current", "later", "later", "later", "later", "later", "later", "later", "later"]);
  assert.deepEqual([rail[1].reachable, rail[1].waitsFor], [false, "Application Info"]);

  // The texts and screenshots done: the README is next, the license after it waits even with a LICENSE there.
  const some = { ...empty, texts: { taken: true, texts: TEXTS, name: "Desk Clock" }, screenshots: { ready: true, front: [{ path: "screenshots/front-1.png" }], back: [] }, license: { ready: true, files: [{ name: "LICENSE", spdx: "MIT" }] } };
  assert.equal(steps.firstOpen(some), "readme");
  const now = steps.railStates(some, "readme");
  assert.deepEqual(now.map((one) => one.state), ["done", "done", "current", "done", "later", "later", "later", "later", "later"]);
  assert.equal(now[3].reachable, true, "a step done is always there to look at");
  assert.equal(steps.stageOneDone(some), false);
  // The check is done when its last run found nothing to fix; the package by submission/.
  assert.equal(steps.isDone("check", { check: { fails: 0 } }), true);
  assert.equal(steps.isDone("check", { check: { fails: 2 } }), false);
  assert.equal(steps.isDone("texts", { texts: { taken: true, name_problem: "The name: it is empty." } }), false, "the name counts as one of the texts");
});

test("Next is off with a short reason while a step is not complete, and writes what the step holds when it goes on", () => {
  const status = { texts: { taken: false, name: "Desk Clock", texts: { category: "", short_description: "", description: "", changelog: "" } }, screenshots: { front: [], back: [] }, readme: { facts: { name: "Desk Clock", screenshots: { front: [], back: [] }, settings: [] }, config: { mode: "fields", title: "Desk Clock", intro: "A clock.", usage: "" } }, license: { files: [] }, files: { ready: false, findings: [] }, package: {}, github: {} };
  // Application Info: one reason at a time, in the form's order, in plain words.
  assert.equal(steps.nextBlock("texts", status, {}, RULES), "Write the short description");
  assert.equal(steps.nextBlock("texts", status, { texts: { ...TEXTS, short_description: "Short" } }, RULES), "Short description: at least 10 characters");
  assert.equal(steps.nextBlock("texts", status, { texts: { ...TEXTS, category: "" } }, RULES), "Choose a category");
  assert.equal(steps.nextBlock("texts", status, { texts: TEXTS, name: "  " }, RULES), "Write the app's name");
  assert.match(steps.nextBlock("texts", status, { texts: TEXTS, name: "Desk  Clock" }, RULES), /^Name: it has a space/);
  assert.equal(steps.nextBlock("texts", status, { texts: TEXTS }, RULES), null);
  // Next writes the texts only when they were changed here, and the name only when it is another.
  assert.equal(steps.saveOnNext("texts", status, { texts: TEXTS, textsDirty: false, name: "Desk Clock" }), null);
  assert.deepEqual(steps.saveOnNext("texts", status, { texts: TEXTS, textsDirty: true, name: "Desk Clock" }), { kind: "texts", name: null, texts: TEXTS });
  assert.deepEqual(steps.saveOnNext("texts", status, { texts: TEXTS, textsDirty: false, name: "Big Clock" }), { kind: "texts", name: "Big Clock", texts: TEXTS });

  assert.equal(steps.nextBlock("screenshots", status), "Add a front screenshot");
  assert.equal(steps.nextBlock("screenshots", { screenshots: { front: [{ path: "a" }, { path: "b", problem: "it is 70×16" }], back: [] } }), "Remove the screenshot marked red");

  // README: how to use it is optional (EMU-364), rows written are checked; Next writes README.md.
  assert.equal(steps.nextBlock("readme", status, {}, RULES), null, "no How to use holds nothing back");
  const readme = { ...status.readme.config, usage: "- The wheel sets the brightness" };
  assert.equal(steps.nextBlock("readme", status, { readme }, RULES), null);
  assert.deepEqual(steps.saveOnNext("readme", status, { readme, readmeDirty: true }), { kind: "readme", readme });
  assert.equal(steps.saveOnNext("readme", { ...status, readme: { ...status.readme, ready: true } }, { readme, readmeDirty: false }), null, "a README that is there and was not touched is kept");
  assert.equal(steps.nextBlock("readme", status, { readme: { mode: "markdown", markdown: "# X\n\n## Input\n\nlisten(\"input\", handler) delivers the keys." } }, RULES), "Take out the template's text about the keys");

  // License: nothing is chosen for the person; the choice and the name are written on Next, never forgotten.
  assert.equal(steps.nextBlock("license", status, { license: { choice: null, author: "Jane" } }), "Choose a license");
  assert.equal(steps.nextBlock("license", status, { license: { choice: "MIT", author: " " } }), "Write the copyright holder");
  assert.equal(steps.nextBlock("license", status, { license: { choice: "other", author: "" } }), "Upload your license file");
  assert.deepEqual(steps.saveOnNext("license", status, { license: { choice: "MIT", author: "Jane Doe" } }), { kind: "license", license: "MIT", author: "Jane Doe" });
  assert.equal(steps.saveOnNext("license", { ...status, license: { files: [{ name: "LICENSE" }] } }, { license: { choice: "MIT", author: "Jane" } }), null, "a license that is there is kept");
  assert.equal(steps.nextBlock("license", { ...status, license: { files: [{ name: "LICENSE" }] } }, {}), null);

  // Repository files: .gitignore's lines on Next; a secret published on purpose does not hold it back.
  assert.deepEqual(steps.saveOnNext("files", status, {}), { kind: "files" });
  assert.equal(steps.nextBlock("files", { files: { findings: [{ path: ".env", published: true }] } }), "Keep the secret files out first");
  assert.equal(steps.nextBlock("files", { files: { findings: [{ path: ".env", published: true, kept_in: true }] } }), null);

  // The pre-flight check: Next only with nothing to fix.
  assert.equal(steps.nextBlock("check", status, { check: null }), "Run the check");
  assert.equal(steps.nextBlock("check", status, { check: { fails: [{ id: "x" }, { id: "y" }] } }), "2 to fix first");
  assert.equal(steps.nextBlock("check", status, { check: { fails: [] } }), null);
  assert.equal(steps.nextBlock("package", status), "Build and package first");
  assert.deepEqual([steps.nextStep("check"), steps.previousStep("texts"), steps.nextStep("catalog")], ["package", null, null]);
});

// ---------------------------------------------------------------- the README

test("a description that names a file is no paragraph for the README: the short description is taken (EMU-333)", () => {
  const start = defaultReadme({ name: "Desk Clock", texts: { ...TEXTS, description: "@README.md" } });
  assert.equal(start.intro, TEXTS.short_description.trim());
  assert.doesNotMatch(JSON.stringify(start), /@README/);
});

test("the README is made from the project: title, paragraph, screenshots, How to use, settings, license; never the template's", () => {
  const facts = { name: "Desk Clock", id: "io.github.jane.desk_clock", texts: TEXTS, screenshots: { front: [{ path: "screenshots/front-1.png", scaled: "screenshots/front-1@8x.png" }], back: [{ path: "screenshots/back-1.png", scaled: null }] }, settings: [{ label: "Digits", about: "How big the digits are.", default: "Big" }], license: "MIT" };
  const start = defaultReadme(facts);
  assert.deepEqual(start, { mode: "fields", title: "Desk Clock", intro: "A clock for the desk that shows the time in big digits.", usage: "", markdown: "" });
  assert.equal(readmeProblem(start, facts), null, "How to use is optional (EMU-364)");
  assert.doesNotMatch(readmeMarkdown(start, facts), /How to use/, "and left out when it is empty");
  const text = readmeMarkdown({ ...start, usage: "- Start shows the date\n- Back quits" }, facts);
  assert.ok(text.startsWith(`${README_MARK}\n\n# Desk Clock\n\nA clock for the desk that shows the time in big digits.\n\n<img src="screenshots/front-1@8x.png" width="576"`), text);
  assert.match(text, /<img src="screenshots\/back-1\.png" width="480" alt="Desk Clock, the back display">/);
  assert.match(text, /## How to use\n\n- Start shows the date\n- Back quits\n/);
  assert.match(text, /## Settings\n\nChange them in the BUSY Bar's local web interface\.\n\n- \*\*Digits\*\*: How big the digits are\. Default: Big\.\n/);
  assert.match(text, /## License\n\nMIT: see \[LICENSE\]\(LICENSE\)\./);
  assert.deepEqual(templateLeft(text), [], "nothing of the template's README");
  assert.equal(text.includes("listen("), false);
  // The author's own Markdown is taken as it is, but not with the template's text left in it.
  const template = '# X\n\nA JavaScript app for the BUSY Bar, generated from the BUSY JS app template.\n\n## Input\n\n`listen("input", handler)` delivers the device keys.\n\n## Layout\n';
  assert.deepEqual(templateLeft(template).map((one) => one.id), ["intro", "controls", "sections"]);
  assert.equal(readmeMarkdown({ mode: "markdown", markdown: "# Mine\n" }, facts), "# Mine\n");
  assert.equal(readmeProblem({ mode: "markdown", markdown: template }, facts), "Take out the template's opening line");
  assert.equal(readmeProblem({ mode: "markdown", markdown: " " }, facts), "Write the README");
  assert.equal(firstParagraph("## Heading\n\n- a list\n\nThe first words\nof it.\n\nMore."), "The first words of it.");
});

test("publish readme: preview, set and get; the template's README is replaced, the person's own opens as Markdown", async (t) => {
  const { home, dir } = project(t);
  await cli(home, ["catalog-texts", "set", dir, `--category=${TEXTS.category}`, `--short-description=${TEXTS.short_description}`, `--description=${TEXTS.description}`, `--changelog=${TEXTS.changelog}`]);
  const got = (await cli(home, ["publish", "readme", "get", dir])).json;
  assert.deepEqual([got.state, got.ready, got.saved, got.config.mode, got.problem, got.left.map((one) => one.id)], ["template", false, false, "fields", null, ["intro", "controls"]]);
  assert.match(got.how_to_use_hint, /optional/, "no How to use: a hint");
  assert.deepEqual(got.facts.settings, [{ label: "Digits", about: "How big the digits are.", default: "Big" }, { label: "Seconds", about: "", default: "on" }]);
  // How to use written wrong is refused, with what is wrong and how to fix it (EMU-364).
  const refused = (await cli(home, ["publish", "readme", "set", dir, "--usage=- Press it to begin"])).json;
  assert.deepEqual([refused.ok, refused.code, refused.problem], [false, "readme_incomplete", "How to use, row 1: name a control of the BUSY Bar, Start, Wheel turn, Wheel press or Back"]);
  assert.match(refused.hint, /--controls.*optional/);
  const preview = (await cli(home, ["publish", "readme", "preview", dir, "--usage=- Start shows the date"])).json;
  assert.match(preview.markdown, /## How to use\n\n- Start shows the date/);
  assert.match(readFileSync(path.join(dir, "README.md"), "utf8"), /generated from the BUSY JS app template/, "preview writes nothing");
  const set = (await cli(home, ["publish", "readme", "set", dir, "--usage=- Start shows the date", "--title=Desk Clock"])).json;
  assert.deepEqual([set.ok, set.state, set.ready, set.saved], [true, "ours", true, true]);
  const written = readFileSync(path.join(dir, "README.md"), "utf8");
  assert.deepEqual(templateLeft(written), []);
  assert.match(written, /## Settings/);
  // Repository files makes it again from the same fields, with the project as it is now.
  writeFileSync(path.join(dir, "LICENSE"), readFileSync(path.join(here, "..", "licenses", "MIT.txt"), "utf8"));
  const files = (await cli(home, ["publish", "files", dir, "--write"])).json;
  assert.ok(files.written.includes("README.md"));
  assert.match(readFileSync(path.join(dir, "README.md"), "utf8"), /- Start shows the date[\s\S]*## License\n\nMIT/);
  assert.equal((await cli(home, ["publish", "status", dir])).json.steps.readme, "done");
  // Edited by hand: the person's; the step opens on their Markdown, and the template's text in it holds it back.
  writeFileSync(path.join(dir, "README.md"), "# Desk Clock\n\nMine.\n\n## Input\n\nlisten(\"input\", handler) delivers the device keys.\n");
  rmSync(path.join(dir, ".busy"), { recursive: true });
  const yours = (await cli(home, ["publish", "readme", dir])).json;
  assert.deepEqual([yours.state, yours.config.mode, yours.ready, yours.problem], ["yours", "markdown", false, "Take out the template's text about the keys"]);
  assert.equal((await cli(home, ["publish", "readme", "set", dir, dir])).json.code, "usage");
});

test("catalog-texts --name writes the app's name into its manifest, and refuses one the catalog would not take", async (t) => {
  const { home, dir } = project(t);
  const named = (await cli(home, ["catalog-texts", "set", dir, "--name=Big Clock"])).json;
  assert.deepEqual([named.ok, named.name, named.name_problem], [true, "Big Clock", null]);
  const manifest = JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8"));
  assert.deepEqual([manifest.name, manifest.id, manifest.version], ["Big Clock", "io.github.jane-doe.desk_clock", "0.1.0"]);
  const refused = (await cli(home, ["catalog-texts", "set", dir, "--name=Desk*Clock"])).json;
  assert.deepEqual([refused.ok, refused.code], [false, "bad_name"]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8")).name, "Big Clock");
});

// ---------------------------------------------------------------- screenshots from files

/** An RGB picture of `width`×`height` from a function of the pixel, as PNG bytes. */
function picture(width, height, at) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...at(x, y), 255], (y * width + x) * 4);
  return encodePng({ width, height, channels: 4, data });
}

test("a screenshot from a file: its display by its size, an exact enlargement made small pixel for pixel, anything else refused", (t) => {
  assert.deepEqual([displayOf(72, 16), displayOf(576, 128), displayOf(160, 80), displayOf(480, 240), displayOf(72, 32), displayOf(100, 16)], [{ display: "front", scale: 1 }, { display: "front", scale: 8 }, { display: "back", scale: 1 }, { display: "back", scale: 3 }, null, null]);
  const dir = tempDir(t);
  const color = (x, y) => [x * 3, y * 15, (x + y) % 2 ? 255 : 0];
  const small = picture(72, 16, color);
  const large = picture(576, 128, (x, y) => color(Math.floor(x / 8), Math.floor(y / 8)));
  const smoothed = picture(576, 128, (x, y) => color(Math.floor(x / 8), Math.floor(y / 8)).map((v, c) => (c === 0 && x % 8 === 7 ? (v + 1) % 256 : v)));
  for (const [name, bytes] of Object.entries({ "small.png": small, "large.png": large, "smoothed.png": smoothed, "odd.png": pngOf(100, 20), "fake.png": Buffer.from("not a picture") })) writeFileSync(path.join(dir, name), bytes);
  const a = readScreenshotFile(path.join(dir, "small.png"));
  const b = readScreenshotFile(path.join(dir, "large.png"));
  assert.deepEqual([a.display, a.scale, b.display, b.scale], ["front", 1, "front", 8]);
  assert.deepEqual(b.small, a.small, "the enlargement gives the same picture back, byte for byte");
  const decoded = decodePng(b.small);
  assert.deepEqual([decoded.width, decoded.height, [...decoded.rgba.subarray((5 * 72 + 9) * 4, (5 * 72 + 9) * 4 + 3)]], [72, 16, color(9, 5)]);
  assert.deepEqual([decodePng(b.large).width, decodePng(b.large).height], [576, 128]);
  assert.match(readScreenshotFile(path.join(dir, "smoothed.png")).problem, /not an exact enlargement/);
  assert.match(readScreenshotFile(path.join(dir, "odd.png")).problem, /100×20: a front screenshot is 72×16 and a back one 160×80/);
  assert.match(readScreenshotFile(path.join(dir, "fake.png")).problem, /not a PNG file/);
  // The back display has 16 levels of gray: a color picture is taken as its brightness.
  const back = frameOf({ width: 160, height: 80, rgba: new Uint8Array(160 * 80 * 4).fill(255) });
  assert.deepEqual([back.display, back.frame.length, back.frame[0]], ["back", 6400, 0xff]);
});

test("publish screenshots --upload copies them in after those there, with their @8x copies, and says what it did not take", async (t) => {
  const { home, dir } = project(t);
  const from = path.join(home, "made before");
  mkdirSync(from);
  writeFileSync(path.join(from, "front@8x.png"), picture(576, 128, (x, y) => [Math.floor(x / 8) * 3, 40, 200]));
  writeFileSync(path.join(from, "back.png"), picture(160, 80, (x) => [x, x, x]));
  writeFileSync(path.join(from, "photo.png"), pngOf(640, 480));
  const answer = (await cli(home, ["publish", "screenshots", dir, `--upload=${JSON.stringify([path.join(from, "front@8x.png"), path.join(from, "back.png"), path.join(from, "photo.png")])}`])).json;
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.uploaded.map((one) => [one.path, one.from, one.scale]), [["screenshots/front-3.png", "front@8x.png", 8], ["screenshots/back-2.png", "back.png", 1]]);
  assert.equal(answer.refused.length, 1);
  assert.match(answer.refused[0], /^photo\.png: it is 640×480/);
  for (const file of ["front-3.png", "front-3@8x.png", "back-2.png", "back-2@8x.png"]) assert.ok(existsSync(path.join(dir, "screenshots", file)), file);
  assert.deepEqual(answer.front.map((one) => one.path), ["screenshots/front-1.png", "screenshots/front-2.png", "screenshots/front-3.png"]);
  assert.equal(answer.front[2].problem, null, "the catalog takes what was written");
  // Nothing taken: a failure that says why.
  const none = (await cli(home, ["publish", "screenshots", dir, `--upload=${path.join(from, "photo.png")}`])).json;
  assert.deepEqual([none.ok, none.code], [false, "not_screenshots"]);
  assert.equal((await cli(home, ["publish", "screenshots", dir, "--upload=[1,"])).json.code, "usage");
  // One display's button (--display): the other display's picture is said, not filed under the wrong one.
  const wrong = (await cli(home, ["publish", "screenshots", dir, `--upload=${path.join(from, "back.png")}`, "--display=front"])).json;
  assert.deepEqual([wrong.ok, wrong.code, wrong.hint], [false, "not_screenshots", "A front screenshot is a PNG of 72×16, or an exact enlargement of one."]);
  assert.match(wrong.message, /^back\.png is a back screenshot \(160×80\); upload it with the back's button\.$/);
  const right = (await cli(home, ["publish", "screenshots", dir, `--upload=${path.join(from, "back.png")}`, "--display=back"])).json;
  assert.deepEqual(right.uploaded.map((one) => one.path), ["screenshots/back-3.png"]);
  assert.equal((await cli(home, ["publish", "screenshots", dir, "--display=front"])).json.code, "usage", "--display goes with --upload");
});

test("publish license --from: the person's own license's text copied in as LICENSE; one there is replaced only with --replace", async (t) => {
  const { home, dir } = project(t);
  // The person's file is the project's, or one the app put down for it in the data folder's tmp/ (the file chosen in
  // the window's Upload dialog): never another file of the computer, which LICENSE would publish.
  const elsewhere = path.join(home, "notes.txt");
  writeFileSync(elsewhere, "Not a license: a file of the person's that no caller may publish this way.\n");
  const outside = (await cli(home, ["publish", "license", dir, "--license=other", `--from=${elsewhere}`])).json;
  assert.deepEqual([outside.ok, outside.code], [false, "outside_project"]);
  let linked = true;
  try {
    symlinkSync(elsewhere, path.join(dir, "linked.txt"));
  } catch {
    linked = false; // Windows without the right to make links
  }
  if (linked) {
    assert.equal((await cli(home, ["publish", "license", dir, "--license=other", `--from=${path.join(dir, "linked.txt")}`])).json.code, "outside_project", "a link in the project to a file outside it");
    rmSync(path.join(dir, "linked.txt"));
  }
  assert.equal(existsSync(path.join(dir, "LICENSE")), false, "nothing was copied");
  const staged = path.join(home, "data", "tmp", "license-1");
  mkdirSync(staged, { recursive: true });
  writeFileSync(path.join(staged, "COPYING"), "Copyright 2026 Jane Doe\n\nEveryone may use it, as the window's upload put it.");
  const fromWindow = (await cli(home, ["publish", "license", dir, "--license=other", `--from=${path.join(staged, "COPYING")}`])).json;
  assert.deepEqual([fromWindow.ok, fromWindow.copied], [true, "COPYING"]);
  rmSync(path.join(dir, "LICENSE"));
  const mine = path.join(dir, "my license.txt");
  writeFileSync(mine, "Copyright 2026 Jane Doe\n\nEveryone may use it.");
  const copied = (await cli(home, ["publish", "license", dir, "--license=other", `--from=${mine}`])).json;
  assert.deepEqual([copied.ok, copied.copied, copied.replaced, copied.ready, copied.files.map((one) => one.name)], [true, "my license.txt", [], true, ["LICENSE"]]);
  assert.equal(readFileSync(path.join(dir, "LICENSE"), "utf8"), "Copyright 2026 Jane Doe\n\nEveryone may use it.\n");
  writeFileSync(mine, readFileSync(path.join(here, "..", "licenses", "MIT.txt"), "utf8"));
  const there = (await cli(home, ["publish", "license", dir, "--license=other", `--from=${mine}`])).json;
  assert.deepEqual([there.ok, there.code, there.file], [false, "license_exists", "LICENSE"]);
  assert.match(readFileSync(path.join(dir, "LICENSE"), "utf8"), /Jane Doe/, "kept without --replace");
  const replaced = (await cli(home, ["publish", "license", dir, "--license=other", `--from=${mine}`, "--replace"])).json;
  assert.deepEqual([replaced.ok, replaced.replaced, replaced.files], [true, ["LICENSE"], [{ name: "LICENSE", spdx: "MIT" }]]);
  assert.ok(readdirSync(path.join(dir, ".busy", "removed")).some((name) => name.endsWith("-LICENSE")), "the old one is in .busy/removed");
  writeFileSync(path.join(dir, "picture.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  assert.equal((await cli(home, ["publish", "license", dir, "--license=other", `--from=${path.join(dir, "picture.bin")}`, "--replace"])).json.code, "not_license");
  assert.equal((await cli(home, ["publish", "license", dir, "--license=MIT", `--from=${mine}`])).json.code, "usage", "--from is your own license");
});

test("publish status: the app's two icons as they are in the project; How to use is optional, a wrong one holds the README step (EMU-364)", async (t) => {
  const { home, dir } = project(t);
  const status = (await cli(home, ["publish", "status", dir])).json;
  assert.match(status.icon.front ?? "", /^data:image\/png;base64,iVBORw0KGgo/);
  assert.equal(status.icon.back, null, "the project has no back icon");
  await cli(home, ["catalog-texts", "set", dir, `--category=${TEXTS.category}`, `--short-description=${TEXTS.short_description}`, `--description=${TEXTS.description}`, `--changelog=${TEXTS.changelog}`]);
  // A README without rows is written (an agent's free text is taken), and the step is done: a hint says why rows help.
  const loose = (await cli(home, ["publish", "readme", "set", dir, "--usage=Use it as you like."])).json;
  assert.deepEqual([loose.ok, loose.state, loose.ready, loose.how_to_use], [true, "ours", true, null]);
  assert.match(loose.how_to_use_hint, /How to use is optional.*The catalog does not show it yet\./);
  // The person's own README with no How to use section at all, the owner's case of 20.11: ready, and status says so.
  writeFileSync(path.join(dir, "README.md"), "# Desk Clock\n\nA clock for the desk.\n\n## Features\n\n- Press Start to see the date\n- Turn the wheel to change the city\n");
  const own = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([own.readme.state, own.readme.ready, own.readme.how_to_use, own.steps.readme], ["yours", true, null, "done"]);
  assert.match(own.readme.how_to_use_hint, /optional/);
  // A README from elsewhere with install steps under How to use: a hint that names the rows, never a block, and
  // "Start a session" is no row of Start.
  writeFileSync(path.join(dir, "README.md"), "# Desk Clock\n\nA clock for the desk.\n\n## How to use\n\n- Install it from the catalog\n- Start a session\n");
  const steps = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([steps.readme.ready, steps.readme.how_to_use, steps.steps.readme], [true, null, "done"]);
  assert.match(steps.readme.how_to_use_hint, /^How to use: rows 1 and 2 name no control of the BUSY Bar, so the section reads as plain text, which is fine\. Rows of controls look like - \*\*Start\*\*: Starts the timer/);
  writeFileSync(path.join(dir, "README.md"), "# Desk Clock\n\nA clock for the desk.\n\n## How to use\n\n- **Start**:\n");
  const empty = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([empty.readme.ready, empty.readme.how_to_use], [true, null]);
  assert.match(empty.readme.how_to_use_hint, /^How to use: write what Start does\. The section is optional, so this does not hold the step\.$/);
  // What does hold a README.md that is there is said beside the step in the text: the file's, not the configuration's.
  writeFileSync(path.join(dir, "README.md"), "# Desk Clock\n\nA clock for the desk.\n\n## Layout\n\nsrc/ is the app.\n");
  const text = await cli(home, ["publish", "status", dir], { json: false });
  assert.match(text.stdout, /^readme: todo \(take out the template's sections for developers\)$/m);
  const rows = (await cli(home, ["publish", "readme", "set", dir, "--usage=- **Start**: Shows the date\n- **Wheel turn**: Changes the city"])).json;
  assert.deepEqual([rows.ready, rows.how_to_use], [true, null]);
  assert.match(readFileSync(path.join(dir, "README.md"), "utf8"), /## How to use\n\n- \*\*Start\*\*: Shows the date\n- \*\*Wheel turn\*\*: Changes the city\n/);
});

// ---------------------------------------------------------------- the project's README.md as it is (EMU-365)

/**
 * The owner's case of 20.11: an app in app/ of a larger repository, its README written elsewhere, linking up. With
 * CRLF and a byte that is not UTF-8: any writing of it, even of the text as read, changes its bytes.
 */
const OWN_README = Buffer.concat([Buffer.from("Caf\xe9 note\r\n", "latin1"), Buffer.from("# Desk Clock\r\n\r\nA clock for the desk.\r\n\r\n![Front](screenshots/front-1.png)\r\n\r\nSee [the plugin](../plugin) and [the whole project](../README.md), [the source](src/main.ts), [the build](dist/app.tgz) and [busy.app](https://busy.app).\r\n\r\n```sh\r\ncat ../not-a-link.md\r\n```\r\n\r\n<img src=\"docs/missing.png\">\r\n", "utf8")]);

test("the project's README.md as it is: mode file writes nothing, its problem is only that it is missing or empty", () => {
  const facts = { name: "Desk Clock", id: "x", texts: TEXTS, screenshots: { front: [], back: [] }, settings: [], license: null };
  assert.equal(readmeProblem({ mode: "file" }, { ...facts, file: null }), "There is no README.md in the project");
  assert.equal(readmeProblem({ mode: "file" }, { ...facts, file: " \n" }), "README.md is empty");
  assert.equal(readmeProblem({ mode: "file" }, { ...facts, file: "# Mine, with no How to use\n" }), null);
  assert.equal(readmeProblem({ mode: "file" }, { ...facts, file: '# X\n\nA JavaScript app for the BUSY Bar, generated from the BUSY JS app template.\n' }), null, "what is left of the template is a hint, not a block");
  assert.equal(readmeMarkdown({ mode: "file" }, { ...facts, file: "a\r\nb" }), "a\r\nb", "the file as it is");
});

test("hints of a README.md used as it is: links out of the app's folder, files not published, the template, How to use", (t) => {
  const dir = tempDir(t);
  const text = OWN_README.toString("utf8");
  const hints = readmeFileHints(dir, text, ["README.md", "src/main.ts", "screenshots/front-1.png"]);
  assert.equal(hints.length, 2, hints.join("\n"));
  assert.match(hints[0], /^Links outside the app's folder will break on GitHub, where the public repository holds this folder alone: \.\.\/plugin, \.\.\/README\.md\./);
  assert.equal(hints[1], "Links to files the public repository will not hold (kept out, or not in the project): dist/app.tgz, docs/missing.png.");
  assert.doesNotMatch(hints.join(" "), /not-a-link|busy\.app/, "code and addresses are not links to check");
  assert.deepEqual(readmeFileHints(dir, "# X\n\n[docs](docs/) and [top](#x)\n", ["docs/a.md"]), [], "a folder the repository holds, an anchor");
  assert.deepEqual(readmeFileHints(dir, "# X\n\n## How to use\n\n- **Start**:\n", []), ["How to use: write what Start does. The section is optional, so this does not hold the step."]);
  // No false hints (review of EMU-365): what the flow makes itself, footnotes, comments, code of every kind, escapes.
  const quiet = [
    "[License](LICENSE) and [.gitignore](.gitignore), ![Front](screenshots/front-1@8x.png)",
    "A claim.[^1]\n\n[^1]: Footnote text, not a link",
    "<!-- [old](old/notes.md) -->",
    "    [indented](../code.md)",
    "- A step:\n\n  ```sh\n  cat [x](../in-a-list.md)\n  ```",
    "Run ``[x](../double.md)`` here.",
    "[Plus](docs/notes%2Bv2.md)",
  ].join("\n\n");
  assert.deepEqual(readmeFileHints(dir, quiet, ["docs/notes+v2.md"]), [], "nothing to say");
});

test("publish readme set --keep: README.md stays byte for byte through the README step, Repository files and the package's plan", async (t) => {
  const { home, dir } = project(t);
  await cli(home, ["catalog-texts", "set", dir, `--category=${TEXTS.category}`, `--short-description=${TEXTS.short_description}`, `--description=${TEXTS.description}`, `--changelog=${TEXTS.changelog}`]);
  const file = path.join(dir, "README.md");
  rmSync(file);
  const none = (await cli(home, ["publish", "readme", "set", dir, "--keep"])).json;
  assert.deepEqual([none.ok, none.code, none.problem], [false, "readme_incomplete", "There is no README.md in the project"]);
  writeFileSync(file, "\n");
  assert.equal((await cli(home, ["publish", "readme", "get", dir])).json.keep_problem, "README.md is empty", "the reason the switch is off");
  writeFileSync(file, OWN_README);
  assert.equal((await cli(home, ["publish", "readme", "set", dir, "--keep", "--intro=x"])).json.code, "usage", "--keep takes no text");
  assert.equal((await cli(home, ["publish", "readme", "set", dir, "--mode=file", "--usage=- **Start**: Go"])).json.code, "usage", "nor --mode file");
  assert.deepEqual((await cli(home, ["publish", "readme", "get", dir])).json.file_hints, [], "the file's hints only once it is used as it is");
  const stamp = statSync(file).mtimeMs;
  const kept = await cli(home, ["publish", "readme", "set", dir, "--keep"], { json: false });
  assert.match(kept.stdout, /^Uses .*README\.md as it is: nothing was written\.\n {2}Hint: Links outside the app's folder will break on GitHub/);
  assert.ok(readFileSync(file).equals(OWN_README), "not touched");
  assert.equal(statSync(file).mtimeMs, stamp, "not even written again");
  const status = (await cli(home, ["publish", "status", dir])).json;
  assert.deepEqual([status.readme.state, status.readme.kept, status.readme.ready, status.steps.readme, status.readme.config.mode], ["kept", true, true, "done", "file"]);
  assert.equal(status.readme.markdown, OWN_README.toString("utf8"), "the preview is the file as it is");
  assert.equal(status.readme.file_hints.length, 2);
  // Repository files: the README is published as it is, not made again.
  const files = (await cli(home, ["publish", "files", dir, "--write"])).json;
  assert.deepEqual([files.readme, files.written.includes("README.md"), files.published.some((one) => one.path === "README.md")], ["kept", false, true]);
  assert.ok(readFileSync(file).equals(OWN_README), "Repository files kept it");
  assert.equal(statSync(file).mtimeMs, stamp);
  // Another README over it only with --replace; Markdown alone takes the file's own text, and writes nothing.
  const over = (await cli(home, ["publish", "readme", "set", dir, "--mode=fields", "--title=Desk Clock"])).json;
  assert.deepEqual([over.ok, over.code], [false, "readme_kept"]);
  assert.ok(readFileSync(file).equals(OWN_README));
  const markdown = (await cli(home, ["publish", "readme", "set", dir, "--mode=markdown"])).json;
  assert.deepEqual([markdown.ok, markdown.kept, markdown.config.mode], [true, false, "markdown"]);
  assert.ok(readFileSync(file).equals(OWN_README), "the same text, line ends and all: not written");
  // Kept again, then replaced on purpose.
  await cli(home, ["publish", "readme", "set", dir, "--keep"]);
  const replaced = (await cli(home, ["publish", "readme", "set", dir, "--mode=fields", "--title=Desk Clock", "--replace"])).json;
  assert.deepEqual([replaced.ok, replaced.state, replaced.kept], [true, "ours", false]);
  assert.match(readFileSync(file, "utf8"), /^<!-- Made by BUSY Bar Emulator/);
  assert.match(replaced.moved, /^\.busy\/removed\/\d+-README\.md$/);
  assert.ok(readFileSync(path.join(dir, replaced.moved)).equals(OWN_README), "the one used as it is went to .busy/removed/, as it was");
  // Kept, then the file deleted: Repository files does not make one from the fields behind the person's back.
  writeFileSync(file, OWN_README);
  await cli(home, ["publish", "readme", "set", dir, "--keep"]);
  rmSync(file);
  const gone = (await cli(home, ["publish", "files", dir, "--write"])).json;
  assert.deepEqual([gone.ok, gone.code, existsSync(file)], [false, "readme_gone", false]);
  assert.match(gone.hint, /Put the file back, or choose another README/);
});
