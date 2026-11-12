// busy-emulator check and submit on a project as the official template makes it and an author finishes it
// (project-fixture.mjs): the finished project passes and submit writes its folder; the same project with one defect
// planted is told about, under the catalog's id for it; what cannot be decided from a folder is said to be so.
// The command line runs in this process, on real folders in the temporary folder; no emulator, network or git.
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { execProgram } from "../../../engine/programs.mjs";
import { main } from "../../cli/busy-emulator.mjs";
import { resolveContext } from "../../cli/context.mjs";
import { system } from "../../cli/system.mjs";
import { checkCatalogPng } from "../../capture/catalog-png.mjs";
import { checkProject, loadPngChecker, loadRegistry, markdownProblem, REGISTRY_FILE } from "../check.mjs";
import { githubRepository, readGit, readIndexPaths } from "../git-folder.mjs";
import { CHECKS, recognizeLicense, RULES_COMMIT } from "../rules.mjs";
import { manifestYaml } from "../submission.mjs";
import { builtFiles, COMMIT, COMMITTED, DETAILS, gitIndex, ID, makeProject, MANIFEST, MIT, pngOf, writeGit, writeIndex, writePackage } from "./project-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "..", "cli", "busy-emulator.mjs");

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busybar-emulator-check-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}

/** The command line's context as a development run has it, with a home and a data folder inside `home`. */
function contextIn(home) {
  return resolveContext({ env: { BUSY_EMULATOR_DATA: path.join(home, "data") }, platform: process.platform, homeDir: home, scriptPath: CLI, execPath: process.execPath, nodeVersion: process.versions.node });
}

/** Runs `busy-emulator <argv>` in this process: { code, out, err, json }. */
async function cli(t, argv, home = tempDir(t)) {
  // The tests read every check: --json alone gives the short form (its own tests below).
  if (argv.includes("--json") && ["check", "submit"].includes(argv[0]) && !argv.includes("--compact")) argv = [...argv, "--full"];
  argv = argv.filter((arg) => arg !== "--compact");
  const out = [];
  const err = [];
  const code = await main(argv, { ctx: contextIn(home), sys: system, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: argv.includes("--json") && out.length ? JSON.parse(out.join("\n")) : null };
}

const by = (json) => Object.fromEntries(json.checks.map((check) => [check.id, check]));
const idsOf = (json, test) => json.checks.filter(test).map((check) => check.id);
const fails = (json) => idsOf(json, (c) => c.status === "fail" && c.blocking);
const warnings = (json) => idsOf(json, (c) => c.status === "fail" && !c.blocking);
const open = (json) => idsOf(json, (c) => c.status === "unchecked" && c.applies);

/** Every file under a folder, relative, sorted. */
function filesIn(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesIn(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name)).split(path.sep).join("/")]))
    .sort();
}

/** A tar entry by hand, for what the test archives' maker does not write: links, and files without a folder. */
function tarEntry(name, type, data = Buffer.alloc(0), link = "") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write(link, 157, 100);
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const archiveOf = (entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
const plainEntries = (files = builtFiles()) => [tarEntry(`${ID}/`, "5"), ...Object.entries(files).map(([name, data]) => tarEntry(`${ID}/${name}`, "0", Buffer.from(data)))];

// ---------------------------------------------------------------- the rules and the registry

test("the checks are the catalog's: the same ids, stages and weight as the registry snapshot, in its order", () => {
  // The snapshot ships with the server (readiness/catalog-registry.json): without it there is nothing to compare with.
  const registry = loadRegistry();
  assert.ok(registry, "no registry snapshot (readiness/catalog-registry.json)");
  assert.equal(registry.source.commit, RULES_COMMIT, "rules.mjs was read from another commit than the registry snapshot: read the catalog's rules again");
  assert.deepEqual(CHECKS.map(({ id, stage, blocking }) => ({ id, stage, blocking })), registry.checks.map(({ id, stage, required }) => ({ id, stage, blocking: required })));
  assert.equal(CHECKS.length, 66);
});

// ---------------------------------------------------------------- the finished project

test("a finished project passes: no check fails, and what a folder cannot tell is said to be unchecked, with why", async (t) => {
  const dir = makeProject(tempDir(t));
  const before = filesIn(dir);
  const run = await cli(t, ["check", dir, "--json"]);
  assert.equal(run.code, 0, run.out + run.err);
  assert.equal(run.err, "");
  const { json } = run;
  assert.equal(json.ok, true);
  assert.equal(json.result, "pass");
  assert.equal(json.id, ID);
  assert.equal(json.built, true);
  assert.deepEqual(fails(json), []);
  assert.deepEqual(warnings(json), []);
  assert.deepEqual(open(json), ["pr_scope", "build", "version_not_newer", "source_repository_changed", "author_attestation"]);
  assert.deepEqual(idsOf(json, (c) => !c.applies), ["removal_not_owner", "removal_not_published", "category_offline", "catalog_unavailable", "version_unavailable", "firmware_unavailable", "internal_error"]);
  assert.deepEqual(json.counts, { total: 66, fail: 0, warning: 0, unchecked: 5, not_applicable: 7, pass: 54 });
  for (const check of json.checks) {
    if (check.status === "unchecked") assert.ok(check.why, `${check.id} says why it is not checked`);
    assert.ok(check.title, check.id);
  }
  assert.equal(json.firmware.name, "1.3.1");
  assert.match(by(json).firmware_too_old.found, /api_version 27\.12\.0; firmware 1\.3\.1 has API 27\.14\.0/);
  assert.match(by(json).source_commit.found, /origin\/main/);
  assert.match(by(json).screenshots_count.found, /^2 from screenshots\/front-<n>\.png; the cover is screenshots\/front-1\.png/, "the enlarged copy front-1@8x.png is not a screenshot");
  // The catalog's own words come with each check where this tree has the registry.
  if (existsSync(REGISTRY_FILE)) {
    assert.equal(json.rules.catalog_texts, true);
    assert.equal(by(json).license.title, "Open source license");
    assert.match(by(json).license.catalog.fix, /LICENSE/);
  }
  assert.deepEqual(filesIn(dir), before, "check writes nothing");

  const text = await cli(t, ["check", dir]);
  assert.equal(text.code, 0);
  assert.match(text.out, /^Catalog checks for io\.github\.jane-doe\.desk_clock in /);
  assert.match(text.out, /\n5 cannot be checked here:\n {2}pr_scope: /);
  assert.match(text.out, /\n54 of 66 checks pass; none fails\.\nNext: .* submit /);
  assert.doesNotMatch(text.out, /fail:/);
});

test("check takes the current folder, and a folder that is no project is told so", async (t) => {
  const dir = makeProject(tempDir(t));
  const elsewhere = tempDir(t);
  const none = await cli(t, ["check", elsewhere, "--json"]);
  assert.equal(none.code, 1);
  assert.equal(none.json.code, "not_a_project");
  const extra = await cli(t, ["check", dir, "more", "--json"]);
  assert.equal(extra.code, 2);
  const unknown = await cli(t, ["check", "--fix", "--json"]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.json.code, "usage");
});

// ---------------------------------------------------------------- one defect at a time

const manifestWith = (change) => {
  const manifest = { ...MANIFEST, ...change };
  for (const [key, value] of Object.entries(manifest)) if (value === undefined) delete manifest[key];
  return manifest;
};
/** A project whose app manifest is changed, in the source and in the build alike. */
const withManifest = (change) => (dir) => {
  const manifest = manifestWith(change);
  makeProject(dir, { files: (files) => (files["src/appmeta/manifest.json"] = JSON.stringify(manifest, null, 2)), built: false });
  writePackage(dir, builtFiles(manifest), manifest.id);
};
const withDetails = (change) => (dir) => makeProject(dir, { files: (files) => (files["catalog.json"] = JSON.stringify({ ...DETAILS, ...change })) });
const withFiles = (change) => (dir) => makeProject(dir, { files: change });
const withBuilt = (more) => (dir) => makeProject(dir, { built: builtFiles(MANIFEST, more) });
/** A finished project whose git index holds what `change` makes of the committed files' paths. */
const withIndex = (change) => (dir) => {
  makeProject(dir);
  writeIndex(dir, change([...COMMITTED]));
};
const withArchive = (bytes) => (dir) => {
  makeProject(dir, { built: false });
  mkdirSync(path.join(dir, "dist"), { recursive: true });
  writeFileSync(path.join(dir, "dist", `${ID}.tgz`), bytes);
};

// [family, what is wrong, how the project is made, the checks that fail, the warnings, what the finding says]
const DEFECTS = [
  ["id", "an id with one dot and capitals", withManifest({ id: "Jane.Clock" }), ["manifest_path", "app_id_format", "invalid_id"], [], /Jane\.Clock.*1 dot/],
  ["id", "an id that does not start like a domain", withManifest({ id: "jane.desk.clock" }), [], ["id_style"], /does not start with a domain-like part/],
  ["id", "an app.busy. id in somebody's repository", withManifest({ id: "app.busy.desk_clock" }), [], ["official_namespace"], /official BUSY apps/],
  ["id", "an id of 42 characters, which the catalog's id rule takes and busy-cli does not build", withManifest({ id: "io.github.jane-doe.desk_clock_with_seconds" }), ["build"], [], /is 42 characters long: the catalog's rule for an id allows 63, but busy-cli builds an id of at most 32/],
  ["manifest fields", "no api_version", withManifest({ api_version: undefined }), ["manifest_field"], [], /has no api_version/],
  ["manifest fields", "format_version 2", withManifest({ format_version: 2 }), ["manifest_format_version"], [], /format_version is 2/],
  ["manifest fields", "debug mode on", withManifest({ debug: true }), ["manifest_debug"], [], /"debug": true/],
  ["manifest fields", "a heap beyond the BUSY Bar's", withManifest({ heap_size_kib: 4096 }), ["manifest_heap"], [], /heap_size_kib is 4096/],
  ["manifest fields", "a manifest over 512 bytes", withManifest({ description: "d".repeat(520) }), ["manifest_size"], [], /bytes; the limit is 512/],
  ["manifest fields", "a source manifest that is not JSON", (dir) => makeProject(dir, { files: (files) => (files["src/appmeta/manifest.json"] = "{ id: "), built: false }), ["manifest_path", "app_id_format", "invalid_id", "manifest_json"], [], /not a JSON object/],
  ["names", "a name of 40 characters", withManifest({ name: "The Longest Desk Clock Name In The World" }), ["manifest_name"], [], /40 characters long, the limit is 32/],
  ["names", "a name with letters outside Latin", withManifest({ name: "Uhr für den Tisch" }), ["manifest_name"], [], /"ü"/],
  // check makes the empty form, and the check of the texts names the fields to fill.
  ["descriptions", "no catalog texts at all", withFiles((files) => (files["catalog.json"] = null)), ["manifest_schema"], [], /category: not written yet; short_description: not written yet; description: not written yet; changelog: not written yet/],
  ["descriptions", "catalog.json that is not JSON", withFiles((files) => (files["catalog.json"] = "{ category: clocks }")), ["manifest_readable"], [], /not a JSON object/],
  ["descriptions", "a short description of 5 characters", withDetails({ short_description: "Clock" }), ["manifest_schema"], [], /short_description: 5 characters, the catalog takes 10 to 120/],
  ["descriptions", "a short description of two lines", withDetails({ short_description: "A large clock\nwith the date" }), ["manifest_schema"], [], /one line/],
  ["descriptions", "a description left empty", withDetails({ description: "" }), ["manifest_schema"], [], /description: not written yet/],
  ["descriptions", "a description of 20 characters", withDetails({ description: "Too short a text. Ok" }), ["text_resolve"], [], /20 characters, the catalog takes 50 to 4000/],
  ["descriptions", "a changelog of 3 characters", withDetails({ changelog: "New" }), ["changelog_text"], [], /3 characters, the catalog takes 10 to 4000/],
  ["descriptions", "a picture in the description", withDetails({ description: `${DETAILS.description}\n\n![the clock](https://example.com/clock.png)` }), ["markdown"], [], /description, line 10: an image/],
  ["descriptions", "code in the changelog", withDetails({ changelog: "Added `tick()` to the clock." }), ["markdown"], [], /changelog, line 1: code/],
  ["descriptions", "a field the catalog manifest does not have", withDetails({ descripton: "a typo" }), ["manifest_schema"], [], /"descripton": not a field/],
  ["category", "a category the catalog does not have", withDetails({ category: "fun" }), ["category_public"], [], /"fun" is not a category/],
  ["category", "another name of a category", withDetails({ category: "meetings" }), [], ["category_alias"], /another name of productivity/],
  ["icons", "a front icon of 16×16", withBuilt({ "appmeta/icon_front_8x8.png": pngOf(16, 16) }), ["icon_png"], [], /16×16, expected 8×8/],
  ["icons", "a back icon that is no PNG", withBuilt({ "appmeta/icon_back_11x11.png": "GIF89a" }), ["icon_png"], [], /icon_back_11x11\.png.*not a PNG/],
  ["icons", "no front icon", (dir) => makeProject(dir, { files: (files) => (files["src/appmeta/icon_front_8x8.png"] = null), built: builtFiles(MANIFEST, { "appmeta/icon_front_8x8.png": null }) }), [], ["icon_missing"], /no front icon/],
  ["package", "a file that is no archive", withArchive(Buffer.from("not a package")), ["archive_invalid"], [], /cannot be read as a \.tgz: it is not gzip data/],
  ["package", "an archive cut off", withArchive(gzipSync(Buffer.concat(plainEntries()).subarray(0, 1100))), ["archive_invalid"], [], /ends in the middle of a file/],
  ["package", "no scripts/main.js", withBuilt({ "scripts/main.js": null }), ["script_main", "main_missing"], [], /no scripts\/main\.js/],
  ["package", "a main.js of 300 000 bytes", withBuilt({ "scripts/main.js": `import { tick } from "./lib/tick.js";\ntick();\n${"//".padEnd(300_000, "x")}\n` }), ["javascript_size"], [], /bytes; the BUSY Bar loads at most 256000/],
  ["package", "a script that imports a package", withBuilt({ "scripts/main.js": 'import fs from "node:fs";\nimport { tick } from "./lib/tick.js";\ntick(fs);\n' }), ["script_imports"], [], /main\.js imports "node:fs", which is not a script of the package/],
  ["package", "a script that imports a file that is not there", withBuilt({ "scripts/main.js": 'import { tock } from "./lib/tock.js";\ntock();\n' }), ["script_imports"], [], /imports ".\/lib\/tock\.js"/],
  ["package", "a script that does not parse", withBuilt({ "scripts/lib/tick.js": "export function tick( {\n" }), ["script_imports"], [], /lib\/tick\.js does not parse/],
  ["package", "a file outside the id's folder", withArchive(archiveOf([...plainEntries(), tarEntry("README.md", "0", Buffer.from("hello"))])), ["package_path"], [], /README\.md: not under io\.github/],
  ["package", "a symbolic link in the package", withArchive(archiveOf([...plainEntries(), tarEntry(`${ID}/scripts/link.js`, "2", Buffer.alloc(0), "main.js")])), ["archive_entry"], [], /link\.js is a symbolic link/],
  ["package", "the same path twice", withArchive(archiveOf([...plainEntries(), tarEntry(`${ID}/scripts/main.js`, "0", Buffer.from("1;"))])), ["duplicate_path"], [], /main\.js: in the package more than once/],
  ["package", "a build made before the id was changed", (dir) => (makeProject(dir, { files: (files) => (files["src/appmeta/manifest.json"] = JSON.stringify(MANIFEST)), built: false }), writePackage(dir, builtFiles(manifestWith({ id: "io.github.jane-doe.old_clock" })))), ["manifest_id"], [], /built with the id "io\.github\.jane-doe\.old_clock"/],
  ["screenshots", "no screenshot", withFiles((files) => (files["screenshots/front-1.png"] = files["screenshots/front-2.png"] = null)), ["screenshots_count"], [], /there are no screenshots/],
  ["screenshots", "eleven screenshots", withFiles((files) => Object.assign(files, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`screenshots/front-${i + 3}.png`, pngOf(72, 16)])))), ["screenshots_count"], [], /11 screenshots/],
  ["screenshots", "a screenshot of 144×32", withFiles((files) => (files["screenshots/front-2.png"] = pngOf(144, 32))), ["screenshot_png"], [], /front-2\.png: .*144×32, expected 72×16/],
  ["screenshots", "a screenshot with 16 bits a channel", withFiles((files) => (files["screenshots/front-1.png"] = pngOf(72, 16, { depth: 16 }))), ["screenshot_png"], [], /16 bits per channel/],
  ["screenshots", "a JPEG named .png", withFiles((files) => (files["screenshots/front-1.png"] = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]))), ["screenshot_png"], [], /is not a PNG file/],
  ["screenshots", "a back screenshot of the front's size", withFiles((files) => (files["screenshots/back-1.png"] = pngOf(72, 16))), ["back_screenshot_png"], [], /72×16, expected 160×80/],
  ["screenshots", "a screenshot named that is not there", withDetails({ screenshots: ["screenshots/front-1.png", "art/cover.png"] }), ["referenced_file"], [], /art\/cover\.png: not in the project/],
  ["screenshots", "a screenshot outside the project", withDetails({ screenshots: ["../cover.png"] }), ["manifest_references"], [], /\.\.\/cover\.png leaves the app's folder/],
  ["version", "a version of two numbers", withManifest({ version: "1.0" }), ["manifest_version"], [], /version is "1\.0"/],
  ["version", "a version with a suffix", withManifest({ version: "1.0.0-beta" }), ["manifest_version"], [], /1\.0\.0-beta/],
  ["API version", "an API newer than the released firmware's", withManifest({ api_version: "99.0.0" }), ["firmware_too_old"], [], /api_version is 99\.0\.0; the released firmware in this emulator, 1\.3\.1, has API 27\.14\.0/],
  ["license", "no license file", withFiles((files) => (files.LICENSE = null)), ["license"], [], /no LICENSE, LICENCE or COPYING/],
  ["license", "a license text of the author's own", withFiles((files) => (files.LICENSE = "You may use this app at home. Not for commercial use.")), [], ["license_unrecognised"], /not one the catalog recognizes/],
  ["lock file", "no lock file", withFiles((files) => (files["package-lock.json"] = null)), ["build_lockfile"], [], /no package-lock\.json and no pnpm-lock\.yaml/],
  ["lock file", "two lock files", withFiles((files) => (files["pnpm-lock.yaml"] = "lockfileVersion: '9.0'\n")), ["build_lockfile"], [], /both package-lock\.json and pnpm-lock\.yaml/],
  ["lock file", "a lock file without busy-cli", withFiles((files) => (files["package-lock.json"] = JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }))), ["build_lockfile"], [], /does not pin @busy-app\/cli/],
  ["source", "the app's manifest in appmeta/ at the top, where busy-cli builds it and the catalog does not look", withFiles((files) => ((files["appmeta/manifest.json"] = files["src/appmeta/manifest.json"]), (files["src/appmeta/manifest.json"] = null))), ["app_id_match"], [], /the app's manifest is appmeta\/manifest\.json; the catalog reads the id from src\/appmeta\/manifest\.json/],
  ["source", "a source manifest larger than the catalog reads", (dir) => makeProject(dir, { files: (files) => (files["src/appmeta/manifest.json"] = JSON.stringify({ ...MANIFEST, notes: "n".repeat(4200) })) }), ["app_id_match"], [], /bytes; the catalog reads the id from a file of up to 4096/],
  ["committed", "a screenshot that is not added to git", withIndex((paths) => paths.filter((name) => name !== "screenshots/front-2.png")), ["referenced_file"], [], /screenshots\/front-2\.png is not added to git, so it is not in the commit the catalog reads/],
  ["committed", "a screenshot that git has under another letter case", withIndex((paths) => paths.map((name) => (name === "screenshots/front-1.png" ? "Screenshots/Front-1.png" : name))), ["referenced_file"], [], /screenshots\/front-1\.png is in git as Screenshots\/Front-1\.png: the letter case differs/],
  ["committed", "a license that is not added to git", withIndex((paths) => paths.filter((name) => name !== "LICENSE")), ["license"], [], /LICENSE is not added to git/],
  ["committed", "a lock file that is not added to git", withIndex((paths) => paths.filter((name) => name !== "package-lock.json")), ["build_lockfile"], [], /package-lock\.json is not added to git, so it is not in the commit the catalog reads: the catalog finds no lock file/],
  ["committed", "the app's manifest not added to git", withIndex((paths) => paths.filter((name) => name !== "src/appmeta/manifest.json")), ["app_id_match"], [], /src\/appmeta\/manifest\.json is not added to git/],
  ["committed", "two lock files, both added to git", (dir) => (makeProject(dir, { files: (files) => (files["pnpm-lock.yaml"] = "lockfileVersion: '9.0'\n") }), writeIndex(dir, [...COMMITTED, "pnpm-lock.yaml"])), ["build_lockfile"], [], /both package-lock\.json and pnpm-lock\.yaml/],
  ["source", "no git repository", (dir) => makeProject(dir, { git: false }), ["source_origin"], [], /not in a git repository/],
  ["source", "no remote", (dir) => makeProject(dir, { git: { remote: null } }), ["source_origin"], [], /has no remote/],
  ["source", "a remote that is not GitHub", (dir) => makeProject(dir, { git: { remote: "https://gitlab.com/jane-doe/desk-clock.git" } }), ["source_origin"], [], /at gitlab\.com, not a repository on github\.com/],
];

for (const [family, what, make, expected, expectedWarnings, says] of DEFECTS) {
  test(`${family}: ${what}`, async (t) => {
    const dir = tempDir(t);
    make(dir);
    const run = await cli(t, ["check", dir, "--json"]);
    const { json } = run;
    assert.deepEqual(fails(json), expected, JSON.stringify(json.checks.filter((c) => c.status === "fail"), null, 1));
    assert.deepEqual(warnings(json), expectedWarnings);
    assert.equal(run.code, expected.length ? 1 : 0, "the exit code is 1 exactly when a check fails; a warning does not fail");
    assert.equal(json.ok, expected.length === 0);
    if (expected.length) {
      assert.equal(json.code, "check_failed");
      assert.match(json.message, new RegExp(`${expected.length} of the catalog's checks fails?.*: ${expected.join(", ")}\\.( Everything else passes\\. .*)?$`));
      // The source in a public GitHub repository is the person's step: alone, it is said in one plain line.
      if (expected.join() === "source_origin") assert.match(json.message, /\. Everything else passes\. The one step left is the person's: .* Then run busy-emulator submit\.$/);
      else assert.doesNotMatch(json.message, /Everything else passes/);
      assert.match(json.hint, / check .* again\.$/);
    }
    const named = json.checks.filter((c) => c.status === "fail");
    assert.ok(named.some((c) => says.test(c.found)), `no finding says ${says}: ${named.map((c) => c.found).join(" | ")}`);
    for (const check of named) assert.ok(check.change, `${check.id} says what to change`);
  });
}

test("every family of checks has a planted defect", () => {
  assert.deepEqual([...new Set(DEFECTS.map(([family]) => family))], ["id", "manifest fields", "names", "descriptions", "category", "icons", "package", "screenshots", "version", "API version", "license", "lock file", "source", "committed"]);
});

test("the text names what fails first, with the catalog's words, what is here and what to change; then what is unchecked; then the count", async (t) => {
  const dir = tempDir(t);
  makeProject(dir, { files: (files) => ((files.LICENSE = null), (files["src/appmeta/icon_front_8x8.png"] = null)), built: builtFiles(MANIFEST, { "appmeta/icon_front_8x8.png": null }) });
  const run = await cli(t, ["check", dir]);
  assert.equal(run.code, 1);
  assert.equal(run.out, "");
  const text = run.err;
  assert.match(text, /^busy-emulator: 1 of the catalog's checks fails for io\.github\.jane-doe\.desk_clock: license\./);
  const order = ["1 check fails:", "  license: ", "Here: there is no LICENSE", "Change: The license is the author's choice: ask them which, do not pick one for them.", "1 warning (the catalog takes the app with it):", "  icon_missing: ", "5 cannot be checked here:", "  pr_scope: ", "1 more wait for what fails above: license_unrecognised.", "51 of 66 checks pass."].map((part) => text.indexOf(part));
  assert.ok(order.every((at) => at >= 0), `${order}\n${text}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), text);
  if (existsSync(REGISTRY_FILE)) assert.match(text, /The catalog: The repository has no license file at the submitted commit\./);
});

test("a project that is not built: the checks of the package say to build first, the rest are answered, nothing fails for it", async (t) => {
  const dir = makeProject(tempDir(t), { built: false });
  const run = await cli(t, ["check", dir, "--json"]);
  assert.equal(run.code, 0);
  assert.equal(run.json.built, false);
  assert.deepEqual(fails(run.json), []);
  const waiting = run.json.checks.filter((c) => c.change === "Run busy-emulator build first.").map((c) => c.id);
  assert.deepEqual(waiting, ["build", "script_main", "script_imports", "package_missing", "package_size", "unpacked_size", "archive_entries", "archive_invalid", "tar_format", "package_path", "duplicate_path", "archive_entry", "javascript_size", "main_missing", "manifest_missing", "manifest_size", "manifest_id"]);
  for (const id of waiting) assert.match(by(run.json)[id].why, /the project is not built: there is no dist\/io\.github\.jane-doe\.desk_clock\.tgz/);
  // What the source manifest tells is told without a build.
  assert.equal(by(run.json).manifest_name.status, "pass");
  assert.equal(by(run.json).firmware_too_old.status, "pass");
  const text = await cli(t, ["check", dir]);
  assert.match(text.out, /The project is not built: the checks of the package wait for it\. Run busy-emulator build, then check again\./);
  assert.match(text.out, /\n17 more wait for the build: build, script_main, .*manifest_id\.\n/);
  assert.ok(waiting.every((id) => by(run.json)[id].waits === true));
  assert.match(text.out, /Next: .* build .*, then .* check .* again\.$/);

  const submit = await cli(t, ["submit", dir, "--json"]);
  assert.equal(submit.code, 1);
  assert.equal(submit.json.code, "not_built");
  assert.ok(!existsSync(path.join(dir, "submission")));
});

test("a build left as a folder (--emit dir) is checked as the archive is; a link in it is told", async (t) => {
  const dir = makeProject(tempDir(t), { built: false });
  const root = path.join(dir, "dist", ID);
  for (const [name, data] of Object.entries(builtFiles())) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), data);
  }
  const whole = await cli(t, ["check", dir, "--json"]);
  assert.deepEqual(fails(whole.json), []);
  assert.equal(whole.json.package.kind, "folder");
  assert.equal(by(whole.json).script_imports.status, "pass");
  if (process.platform === "win32") return t.skip("links need a privilege on Windows: the half with a link ran on macOS and Linux"); // a link needs a right there
  symlinkSync("main.js", path.join(root, "scripts", "also.js"));
  assert.deepEqual(fails((await cli(t, ["check", dir, "--json"])).json), ["archive_entry"]);
});

test("a commit this copy has not seen on the remote is not a failure, and is said: push it", async (t) => {
  const dir = makeProject(tempDir(t), { git: { pushed: false } });
  const { json, code } = await cli(t, ["check", dir, "--json"]);
  assert.equal(code, 0);
  assert.equal(by(json).source_commit.status, "unchecked");
  assert.match(by(json).source_commit.why, /has not seen commit 0123456789ab on origin/);
  assert.match(by(json).source_commit.change, /git push.*https:\/\/github\.com\/jane-doe\/desk-clock\/commit\/0123456789abcdef0123456789abcdef01234567/);
});

test("the remote's address: the forms git writes are read, and a name or token in it is not repeated", async (t) => {
  // Addresses with a user before the host are put together here: written out, they read as e-mail addresses.
  const at = (user, rest) => `${user}@${rest}`;
  for (const url of ["https://github.com/jane-doe/desk-clock", "https://github.com/jane-doe/desk-clock.git", at("git", "github.com:jane-doe/desk-clock.git"), at("ssh://git", "github.com/jane-doe/desk-clock"), at("https://jane-doe", "github.com/jane-doe/desk-clock.git"), at("https://jane:ghp_secret0000", "github.com/jane-doe/desk-clock.git")]) {
    assert.equal(githubRepository(url)?.https, "https://github.com/jane-doe/desk-clock.git", url);
  }
  assert.equal(githubRepository("https://github.com.evil.example/jane-doe/desk-clock.git"), null);
  assert.equal(githubRepository("https://example.com/github.com/jane-doe/desk-clock"), null);
  const dir = makeProject(tempDir(t), { git: { remote: at("https://jane:ghp_secret0000", "gitlab.com/jane-doe/desk-clock.git") } });
  const run = await cli(t, ["check", dir, "--json"]);
  assert.doesNotMatch(run.out, /ghp_secret0000|jane:/);
  assert.match(by(run.json).source_origin.found, /at gitlab\.com,/);
  // An app inside a larger repository: the folder is named, and the license may be at the top.
  const top = tempDir(t);
  const inside = makeProject(path.join(top, "apps", "clock"), { files: (files) => (files.LICENSE = null), git: false });
  writeGit(top);
  writeFileSync(path.join(top, "LICENSE"), MIT);
  const nested = (await cli(t, ["check", inside, "--json"])).json;
  assert.deepEqual(fails(nested), []);
  assert.match(by(nested).source_subdir.found, /apps\/clock\//);
  assert.match(by(nested).license.found, /the repository's top folder/);
});

test("without the registry snapshot and the PNG checker the checks still run: the emulator's titles, pictures unchecked", async (t) => {
  const dir = makeProject(tempDir(t));
  const bare = await checkProject({ dir, firmware: { name: "1.3.1", api: "27.14.0" }, node: process.execPath, registry: null, png: null });
  assert.equal(bare.rules.catalog_texts, false);
  assert.equal(bare.rules.commit, RULES_COMMIT);
  assert.equal(bare.checks.length, 66);
  assert.equal(bare.result, "pass");
  const license = bare.checks.find((c) => c.id === "license");
  assert.equal(license.title, "An open source license file");
  assert.equal(license.catalog, null);
  for (const id of ["screenshot_png", "screenshot_final", "back_screenshot_png", "back_screenshot_final", "icon_png"]) {
    const check = bare.checks.find((c) => c.id === id);
    assert.equal(check.status, "unchecked", id);
    assert.match(check.why, /has no PNG checker/);
  }
  // Without a Node to parse the scripts with, that check alone is left open.
  const noNode = await checkProject({ dir, firmware: null, node: null, registry: null, png: await loadPngChecker() });
  assert.equal(noNode.checks.find((c) => c.id === "script_imports").status, "unchecked");
  assert.equal(noNode.checks.find((c) => c.id === "firmware_too_old").status, "unchecked");
  assert.equal(noNode.result, "pass");
});

test("git's index is read in its three versions; what was only meant to be added does not count; an index kept in two files is not read", (t) => {
  const paths = ["LICENSE", "screenshots/front-1.png", "screenshots/front-2.png", "src/appmeta/manifest.json", "src/main.ts", "notes/later.md"];
  const dir = tempDir(t);
  const file = path.join(dir, "index");
  for (const version of [2, 3, 4]) {
    writeFileSync(file, gitIndex(paths, { version }));
    assert.deepEqual(readIndexPaths(file), [...paths].sort(), `version ${version}`);
  }
  for (const version of [3, 4]) {
    writeFileSync(file, gitIndex(paths, { version, intent: ["notes/later.md"] }));
    assert.deepEqual(readIndexPaths(file), paths.filter((name) => name !== "notes/later.md").sort(), `version ${version}, git add -N`);
  }
  const whole = gitIndex(paths);
  for (const [what, bytes] of [
    ["cut off", whole.subarray(0, whole.length - 30)],
    ["another format", Buffer.concat([Buffer.from("DIRC\0\0\0\x05"), whole.subarray(8)])],
    ["no index", Buffer.from("not an index")],
    ["a split index", Buffer.concat([whole.subarray(0, whole.length - 20), Buffer.from("link\0\0\0\x04abcd"), Buffer.alloc(20)])],
  ]) {
    writeFileSync(file, bytes);
    assert.equal(readIndexPaths(file), null, what);
  }
  assert.equal(readIndexPaths(path.join(dir, "none")), null);

  // In a project: the index is asked by paths from the repository's top, and only once there is a commit.
  const project = makeProject(path.join(dir, "project"));
  assert.equal(readGit(project).index, null, "a repository without an index: nothing is known");
  writeIndex(project, COMMITTED);
  const git = readGit(project);
  assert.equal(git.index.has("LICENSE"), true);
  assert.equal(git.index.has("dist/x.tgz"), false);
  assert.equal(git.index.spelled("license"), "LICENSE");
  assert.equal(git.index.spelled("LICENSE"), null);
});

test("with git's index: a finished project passes; a lock file git does not keep is not the catalog's to see", async (t) => {
  const dir = makeProject(tempDir(t));
  writeIndex(dir, COMMITTED);
  const whole = await cli(t, ["check", dir, "--json"]);
  assert.equal(whole.code, 0, JSON.stringify(whole.json.checks.filter((c) => c.status === "fail")));
  assert.match(by(whole.json).referenced_file.found, /3 file\(s\) are in the project and in git/);

  // pnpm's lock file is committed; npm's lies beside it, left by an install: the catalog sees one lock file.
  const pnpm = makeProject(tempDir(t), {
    files: (files) => {
      files["pnpm-lock.yaml"] = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      '@busy-app/cli':\n        specifier: 0.6.0\n        version: 0.6.0(@types/node@24.13.4)\n";
      files["package.json"] = JSON.stringify({ name: "desk-clock", private: true, packageManager: "pnpm@10.33.0", devDependencies: { "@busy-app/cli": "0.6.0" } });
    },
  });
  writeIndex(pnpm, [...COMMITTED.filter((name) => name !== "package-lock.json"), "pnpm-lock.yaml"]);
  const one = await cli(t, ["check", pnpm, "--json"]);
  assert.equal(one.code, 0, JSON.stringify(one.json.checks.filter((c) => c.status === "fail")));
  assert.equal(by(one.json).build_lockfile.status, "pass");
  assert.match(by(one.json).build_lockfile.found, /pnpm-lock\.yaml pins @busy-app\/cli 0\.6\.0, package\.json pins pnpm@10\.33\.0; both must be committed; package-lock\.json is in the folder too, but not in git, so the catalog does not see it/);
  // Without the index nothing is known of what is committed, and two lock files in the folder fail as before.
  rmSync(path.join(pnpm, ".git", "index"));
  const unknown = await cli(t, ["check", pnpm, "--json"]);
  assert.deepEqual(fails(unknown.json), ["build_lockfile"]);
  assert.match(by(unknown.json).build_lockfile.found, /both package-lock\.json and pnpm-lock\.yaml/);

  // An app in a folder of its repository: the paths are the repository's, and the license at the top counts.
  const repository = tempDir(t);
  const app = makeProject(path.join(repository, "apps", "clock"), { git: false, files: (files) => (files.LICENSE = null) });
  writeGit(repository);
  writeFileSync(path.join(repository, "LICENSE"), MIT);
  writeIndex(repository, [...COMMITTED.filter((name) => name !== "LICENSE").map((name) => `apps/clock/${name}`), "LICENSE"]);
  const inFolder = await cli(t, ["check", app, "--json"]);
  assert.equal(inFolder.code, 0, JSON.stringify(inFolder.json.checks.filter((c) => c.status === "fail")));
  writeIndex(repository, COMMITTED.filter((name) => name !== "LICENSE").map((name) => `apps/clock/${name}`));
  const noLicense = await cli(t, ["check", app, "--json"]);
  assert.deepEqual(fails(noLicense.json), ["license"]);
  assert.match(by(noLicense.json).license.found, /LICENSE is not added to git/);
});

test("the Markdown the catalog takes, and what it refuses", () => {
  const fine = [
    "# Title\n\n## Part\n\nSome **bold** and *italic* text.\n\n- one\n- two\n\n1. first\n2. second",
    "See [the page](https://example.com/a?b=c) or <https://example.com>.",
    "A line  \nbroken in two.",
    "5 < 6 and a & b",
    // What reads like HTML or code and is none to the catalog's parser: an angle bracket that is not closed, a
    // backtick after a backslash, a line of = that is not the second of its paragraph.
    "Shown while temperature<10 or humidity>70.",
    "The key \\` (backtick) switches the layout.",
    "Totals:\nfirst and second\n=====",
    "[the page](<https://example.com/a b>)",
    // A list goes on in indented lines and blocks: nested items, a paragraph of an item.
    "- Wheel: brightness\n    - up: brighter\n    - down: darker\n- OK: 12 or 24 hours",
    "1. Open Setup.\n\n    Choose the city there.\n\n2. Press OK.",
    "- one\n\n    - nested after an empty line\n\n        its own paragraph",
    "[x]: more than an address is no definition",
    "   ",
  ];
  for (const text of fine) assert.deepEqual(markdownProblem(text), { problem: null, unsure: null }, text);
  const refused = [
    ["### Deep", /line 1: a heading below level 2/],
    ["> said", /a quote/],
    ["text\n\n---\n", /line 3: a horizontal line/],
    ["Title\n=====", /line 2: a heading made by underlining/],
    ["# Title\nText\n===", /line 3: a heading made by underlining/],
    ["a `b`", /code/],
    ["![x](y.png)", /an image/],
    ["<b>bold</b>", /HTML/],
    ["a <span\nclass=x> b", /line 1: HTML/],
    ["a &amp; b", /entity/],
    ["[x]: https://example.com", /by reference/],
    ["[x]:\nhttps://example.com", /line 1: a link defined by reference/],
    ["[x](docs/readme.md)", /not http/],
    ["[x](javascript:alert(1))", /not http/],
    ["<ftp://example.com/file>", /angle brackets/],
    ["<jane@example.org>", /angle brackets/],
    // Four spaces or a tab at the start of a block are code, unless a list stands before them.
    ["Steps:\n\n    npm install", /line 3: a code block/],
    ["\tnpm install", /line 1: a code block/],
    ["- one\n\n        too deep for the list", /line 3: a code block/],
    ["- one\n\nA paragraph ends the list.\n\n    so this is code", /line 5: a code block/],
    ["- one\n\n    ### a deep heading in the item", /line 3: a heading below level 2/],
  ];
  for (const [text, says] of refused) {
    const found = markdownProblem(text);
    assert.match(found.problem ?? "", says, text);
    assert.equal(found.unsure, null);
  }
});

test("the Markdown rule answers as the catalog's own validator on the texts recorded from it", () => {
  // markdown-cases.json: texts and whether the catalog's tools/check_markdown.py refused each, recorded by running
  // it (Python-Markdown 3.11.2, as its requirements pin) at the catalog commit of the rules.
  const recorded = JSON.parse(readFileSync(path.join(here, "markdown-cases.json"), "utf8"));
  assert.equal(recorded.catalog_commit, RULES_COMMIT, "recorded at the commit the rules are from; record again when the rules move");
  assert.ok(recorded.cases.length >= 400);
  const wrong = recorded.cases.filter(([text, refused]) => Boolean(markdownProblem(text).problem) !== refused);
  assert.deepEqual(wrong.map(([text, refused]) => `${refused ? "missed" : "false alarm"}: ${JSON.stringify(text)}`), []);
  assert.ok(recorded.cases.filter(([, refused]) => !refused).length >= 100, "enough texts the catalog takes");
});

test("license texts: the standard ones are recognized, a changed one is not", () => {
  assert.equal(recognizeLicense(MIT), "MIT");
  assert.equal(recognizeLicense(`${MIT}\nThe Software may not be used for non-commercial purposes only.`), null);
  assert.equal(recognizeLicense("All rights reserved."), null);
});

// ---------------------------------------------------------------- submit

test("submit again over submission/applications that is a link to a folder of the project: the link goes, the folder stays", async (t) => {
  const dir = makeProject(tempDir(t));
  assert.equal((await cli(t, ["submit", dir, "--json"])).code, 0);
  const mine = path.join(dir, "mine");
  mkdirSync(mine);
  writeFileSync(path.join(mine, "keep.txt"), "keep");
  const applications = path.join(dir, "submission", "applications");
  rmSync(applications, { recursive: true, force: true });
  symlinkSync(mine, applications, process.platform === "win32" ? "junction" : undefined);
  const again = await cli(t, ["submit", dir, "--json"]);
  assert.equal(again.code, 0, again.out + again.err);
  assert.equal(readFileSync(path.join(mine, "keep.txt"), "utf8"), "keep", "the folder the link led to is as it was");
  assert.deepEqual(readdirSync(mine), ["keep.txt"]);
  assert.equal(lstatSync(applications).isSymbolicLink(), false);
  assert.ok(existsSync(path.join(applications, ID, "manifest.yml")));
});

test("submit writes submission/ for a finished project: the manifest, the pull request's text, the steps; nothing else changes", async (t) => {
  const dir = makeProject(tempDir(t));
  const before = filesIn(dir);
  const run = await cli(t, ["submit", dir, "--json"]);
  assert.equal(run.code, 0, run.out + run.err);
  const { json } = run;
  const folder = path.join(dir, "submission");
  assert.deepEqual(json.submission.files, [`applications/${ID}/manifest.yml`, "PR-DESCRIPTION.md", "SUBMIT.md"]);
  assert.equal(json.submission.folder, folder);
  assert.equal(json.submission.catalog, "busy-app/busy-apps-catalog");
  assert.equal(json.submission.commit, COMMIT);
  assert.deepEqual(json.submission.to_check_by_hand.map((item) => item.id), ["pr_scope", "build", "version_not_newer", "source_repository_changed", "author_attestation"]);
  assert.equal(json.made_details, null);
  assert.deepEqual(filesIn(dir), [...before, "submission/.gitignore", `submission/applications/${ID}/manifest.yml`, "submission/PR-DESCRIPTION.md", "submission/SUBMIT.md"].sort());

  // The manifest: the source from git, the author's texts as they wrote them, the screenshots in their order.
  assert.equal(
    readFileSync(path.join(folder, "applications", ID, "manifest.yml"), "utf8"),
    [
      "sourcecode:",
      "  type: git",
      "  location:",
      "    origin: https://github.com/jane-doe/desk-clock.git",
      `    commit_sha: ${COMMIT}`,
      "category: clocks",
      "short_description: A large clock with the date for the desk.",
      "description: |-",
      ...DETAILS.description.split("\n").map((line) => (line ? `  ${line}` : "")),
      "changelog: The first public version.",
      "screenshots:",
      "  - screenshots/front-1.png",
      "  - screenshots/front-2.png",
      "back_screenshots:",
      "  - screenshots/back-1.png",
      "",
    ].join("\n"),
  );
  // The folder keeps itself out of the app's repository.
  assert.match(readFileSync(path.join(folder, ".gitignore"), "utf8"), /\n\*\n$/);

  // The pull request's text: the catalog's fields, no box ticked, and where the app was run, said as it is.
  const pr = readFileSync(path.join(folder, "PR-DESCRIPTION.md"), "utf8");
  for (const line of ["# Author checklist", "- [ ] I'm the author of the app or have write access to its repository", "- [ ] I've tested the app on a BUSY Bar with the latest release firmware", "- [ ] The screenshots are taken from the bar", "# AI usage", "Keep ONE option and delete the others."]) assert.ok(pr.includes(line), line);
  assert.doesNotMatch(pr, /- \[x\]/i);
  assert.match(pr, /Built and run on BUSY Bar Emulator .*with the released firmware 1\.3\.1 \(HTTP API 27\.14\.0\)\. Not run on a physical BUSY Bar\. The screenshots are frames of the emulated BUSY Bar's displays/);
  assert.match(pr, /54 of 66 checks pass, none fails; 5 could not be checked outside the catalog\./);

  // The steps: the fork, the one file at its path, the box to tick first; every block names its language.
  const steps = readFileSync(path.join(folder, "SUBMIT.md"), "utf8");
  assert.match(steps, /^# Submitting Desk Clock \(io\.github\.jane-doe\.desk_clock\) to the BUSY Apps Catalog/);
  assert.match(steps, /Fork https:\/\/github\.com\/busy-app\/busy-apps-catalog /);
  assert.ok(steps.includes(`cp '${path.join(folder, "applications", ID, "manifest.yml")}' applications/${ID}/manifest.yml`));
  assert.match(steps, /Tick "I'm the author of the app or have\s+write access to its repository" before you open the pull request/);
  assert.match(steps, /Not run on a physical BUSY Bar/);
  assert.match(steps, /https:\/\/github\.com\/jane-doe\/desk-clock\/commit\/0123456789abcdef0123456789abcdef01234567 opens in a browser where you are not signed in/);
  for (const id of ["pr_scope", "build", "version_not_newer", "source_repository_changed", "author_attestation"]) assert.ok(steps.includes(`- \`${id}\`, `), id);
  const fences = steps.split("\n").filter((line) => /^\s*```/.test(line));
  assert.deepEqual(fences.map((line) => line.trim()), ["```sh", "```", "```powershell", "```"]);

  // Again, after the author's texts changed and another commit: the folder is made again, from what is there now.
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ ...DETAILS, changelog: "Fixed the date on the first of a month." }));
  writeGit(dir, { commit: "f".repeat(40) });
  const again = await cli(t, ["submit", dir, "--catalog", "busy-app/busy-apps-catalog-dev"]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /^Wrote .*submission:\n {2}applications\/io\.github\.jane-doe\.desk_clock\/manifest\.yml\n {2}PR-DESCRIPTION\.md\n {2}SUBMIT\.md\n/);
  assert.match(again.out, /54 of 66 of the catalog's checks pass and none fails\./);
  assert.match(again.out, /Nothing was sent\. Next: follow .*SUBMIT\.md\.$/);
  const second = readFileSync(path.join(folder, "applications", ID, "manifest.yml"), "utf8");
  assert.match(second, /commit_sha: f{40}\n/);
  assert.match(second, /changelog: Fixed the date on the first of a month\.\n/);
  assert.match(readFileSync(path.join(folder, "SUBMIT.md"), "utf8"), /Fork https:\/\/github\.com\/busy-app\/busy-apps-catalog-dev /);
});

test("submit on a project without the catalog's texts makes catalog.json, empty, names what to write, and writes no submission", async (t) => {
  const dir = makeProject(tempDir(t), { files: (files) => (files["catalog.json"] = null) });
  const run = await cli(t, ["submit", dir, "--json"]);
  assert.equal(run.code, 1);
  assert.equal(run.json.code, "check_failed");
  assert.equal(run.json.made_details, path.join(dir, "catalog.json"));
  assert.deepEqual(fails(run.json), ["manifest_schema"]);
  assert.match(by(run.json).manifest_schema.found, /category: not written yet; short_description: not written yet; description: not written yet; changelog: not written yet/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")), { category: "", short_description: "", description: "", changelog: "" });
  assert.ok(!existsSync(path.join(dir, "submission")), "nothing is guessed and nothing is written until the texts are there");
  // In words, for a person: the fields and what each takes.
  rmSync(path.join(dir, "catalog.json"));
  const text = await cli(t, ["submit", dir]);
  assert.match(text.err, /Made .*catalog\.json for the catalog's texts\. Write in it:\n {2}category: one of productivity, clocks, /);
  assert.match(text.err, /Nothing was written to submission\/: 1 of the catalog's checks fails/);
  // The author's file is never written over.
  writeFileSync(path.join(dir, "catalog.json"), JSON.stringify({ ...DETAILS, category: "" }));
  await cli(t, ["submit", dir, "--json"]);
  assert.equal(JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8")).description, DETAILS.description);
});

test("check on a new project makes catalog.json, empty, and names the fields to fill and where; check, fill, submit then works", async (t) => {
  const dir = makeProject(tempDir(t), { files: (files) => (files["catalog.json"] = null) });
  const file = path.join(dir, "catalog.json");
  const run = await cli(t, ["check", dir, "--json"]);
  assert.equal(run.code, 1);
  assert.equal(run.json.code, "check_failed");
  assert.equal(run.json.made_details, file);
  assert.match(run.json.message, /^Made .*catalog\.json for the catalog's texts\. 1 of the catalog's checks fails .*: manifest_schema\.$/);
  assert.deepEqual(fails(run.json), ["manifest_schema"]);
  assert.match(by(run.json).manifest_schema.change, /^Fill in category, short_description, description and changelog in catalog\.json in the project's folder\. category is one of: productivity, clocks, /);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { category: "", short_description: "", description: "", changelog: "" });
  // Only what is still empty is named.
  writeFileSync(file, JSON.stringify({ ...DETAILS, changelog: "" }));
  const one = await cli(t, ["check", dir, "--json"]);
  assert.equal(one.json.made_details, null);
  assert.match(by(one.json).manifest_schema.change, /^Fill in changelog in catalog\.json in the project's folder\./);
  // In words, for a person: the fields and what each takes.
  rmSync(file);
  const text = await cli(t, ["check", dir]);
  assert.match(text.err, /Made .*catalog\.json for the catalog's texts\. Write in it:\n {2}category: one of productivity, clocks, /);
  // The agent's way: check, fill the texts in, check, submit.
  writeFileSync(file, JSON.stringify(DETAILS));
  const passes = await cli(t, ["check", dir, "--json"]);
  assert.equal(passes.code, 0, passes.out);
  assert.equal(passes.json.made_details, null);
  const submitted = await cli(t, ["submit", dir, "--json"]);
  assert.equal(submitted.code, 0, submitted.out);
  assert.equal(submitted.json.submission.folder, path.join(dir, "submission"));
});

test("check in a folder it may not write to still answers: the check of the texts says the file is missing; submit says why it cannot make it", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "a folder without write permission is a POSIX user's" : false }, async (t) => {
  const dir = makeProject(tempDir(t), { files: (files) => (files["catalog.json"] = null) });
  chmodSync(dir, 0o555);
  let run;
  let submitted;
  try {
    run = await cli(t, ["check", dir, "--json"]);
    submitted = await cli(t, ["submit", dir, "--json"]);
  } finally {
    chmodSync(dir, 0o755);
  }
  assert.equal(run.code, 1);
  assert.equal(run.json.made_details, null);
  assert.match(by(run.json).manifest_schema.found, /there is no catalog\.json/);
  assert.match(by(run.json).manifest_schema.change, /^Run .*check: it makes catalog\.json in the project's folder for you to fill\.$/);
  assert.equal(submitted.code, 1);
  // EACCES is what a sandbox answers too: the command line names it so.
  assert.ok(["blocked_file", "write_failed"].includes(submitted.json.code), submitted.json.code);
  assert.ok(!existsSync(path.join(dir, "catalog.json")));
});

test("submit refuses a failing project, a folder of the author's own named submission, and a wrong --catalog", async (t) => {
  const failing = makeProject(tempDir(t), { files: (files) => (files.LICENSE = null) });
  const refused = await cli(t, ["submit", failing, "--json"]);
  assert.equal(refused.code, 1);
  assert.equal(refused.json.code, "check_failed");
  assert.match(refused.json.message, /^Nothing was written to submission\/: 1 of the catalog's checks fails .*\(license\)\.$/);
  assert.ok(!existsSync(path.join(failing, "submission")));

  const own = makeProject(tempDir(t), { files: (files) => (files["submission/notes.txt"] = "my notes") });
  const kept = await cli(t, ["submit", own, "--json"]);
  assert.equal(kept.code, 1);
  assert.equal(kept.json.code, "submission_exists");
  assert.deepEqual(readdirSync(path.join(own, "submission")), ["notes.txt"]);

  const wrong = await cli(t, ["submit", own, "--catalog", "https://github.com/busy-app/busy-apps-catalog", "--json"]);
  assert.equal(wrong.code, 2);
  assert.equal(wrong.json.code, "usage");
});

test("check --json is short: the counts and only what needs something; --full gives every check", async (t) => {
  const dir = makeProject(tempDir(t), { files: (files) => ((files.LICENSE = null), (files["src/appmeta/icon_front_8x8.png"] = null)), built: builtFiles(MANIFEST, { "appmeta/icon_front_8x8.png": null }) });
  const full = await cli(t, ["check", dir, "--json"]);
  const short = await cli(t, ["check", dir, "--json", "--compact"]);
  assert.equal(short.code, 1);
  assert.equal(short.json.code, "check_failed");
  assert.equal(short.json.full, false);
  assert.equal(full.json.full, true);
  assert.equal(short.json.checks, undefined, "no list of every check");
  assert.deepEqual(short.json.failing.map((c) => c.id), fails(full.json));
  assert.deepEqual(short.json.warnings.map((c) => c.id), warnings(full.json));
  assert.deepEqual([...short.json.unchecked.map((c) => c.id), ...short.json.waiting].sort(), open(full.json).sort());
  const license = short.json.failing[0];
  assert.deepEqual(Object.keys(license), ["id", "title", "message", "fix"]);
  assert.equal(license.message, by(full.json).license.found);
  assert.equal(license.fix, by(full.json).license.change);
  for (const c of short.json.unchecked) assert.ok(c.message, `${c.id} says why it is unchecked`);
  // The field test's agent got 27 KB in one line, which its tool cut: the short answer is a fraction of it.
  const sizes = [short, full].map((run) => JSON.stringify(run.json).length);
  assert.ok(sizes[0] < 8000 && sizes[0] * 3 < sizes[1], `${sizes[0]} bytes short, ${sizes[1]} full`);
  const submitted = await cli(t, ["submit", dir, "--json", "--compact"]);
  assert.equal(submitted.json.checks, undefined);
  assert.deepEqual(submitted.json.failing.map((c) => c.id), ["license"]);
});

test("a project without a license: the author chooses it; nothing writes one, and the answer says so with the licenses the catalog takes", async (t) => {
  const dir = makeProject(tempDir(t), { files: (files) => (files.LICENSE = null) });
  const checked = await cli(t, ["check", dir, "--json", "--compact"]);
  assert.match(checked.json.failing[0].fix, /^The license is the author's choice: ask them which, do not pick one for them\. The catalog recognizes .*Apache-2\.0.*MIT/);
  assert.ok(checked.json.notes.some((note) => /nothing here writes one: which license is the author's decision/.test(note)), checked.json.notes.join("\n"));
  const submitted = await cli(t, ["submit", dir]);
  assert.equal(submitted.code, 1);
  assert.match(submitted.err, /The project has no license, and nothing here writes one/);
  assert.deepEqual(readdirSync(dir).filter((name) => /^(LICEN[CS]E|COPYING)/i.test(name)), [], "no license file was written");
});

test("icon writes the two icons the catalog's rules and checks take, from letters or from a picture; icons that are there are kept", async (t) => {
  const dir = makeProject(tempDir(t), { files: (files) => ((files["src/appmeta/icon_front_8x8.png"] = null), (files["src/appmeta/icon_back_11x11.png"] = null)), built: false });
  const front = path.join(dir, "src", "appmeta", "icon_front_8x8.png");
  const back = path.join(dir, "src", "appmeta", "icon_back_11x11.png");
  const before = await cli(t, ["check", dir, "--json"]);
  assert.equal(by(before.json).icon_missing.status, "fail");
  assert.match(by(before.json).icon_missing.change, /busy-emulator icon --text AB/);

  const made = await cli(t, ["icon", dir, "--text", "FT", "--color", "#FF5533", "--json"]);
  assert.equal(made.code, 0, made.out + made.err);
  assert.deepEqual([made.json.front.file, made.json.back.file], [front, back]);
  assert.deepEqual([made.json.front.width, made.json.back.width], [8, 11]);
  assert.ok(made.json.back.shape.join("").includes("#"), "the back icon has a shape");
  // The catalog's own PNG rules (capture/catalog-png.mjs): only "pass" means ready.
  assert.equal(checkCatalogPng(readFileSync(front), "icon_front").verdict, "pass");
  assert.equal(checkCatalogPng(readFileSync(back), "icon_back").verdict, "pass");
  const after = await cli(t, ["check", dir, "--json"]);
  for (const id of ["icon_missing", "icon_png"]) assert.equal(by(after.json)[id].status, "pass", `${id}: ${by(after.json)[id].found ?? by(after.json)[id].why}`);

  const kept = await cli(t, ["icon", dir, "--text", "AB", "--json"]);
  assert.equal(kept.code, 1);
  assert.equal(kept.json.code, "icon_exists");
  const picture = path.join(tempDir(t), "big.png");
  writeFileSync(picture, readFileSync(front));
  const fromPicture = await cli(t, ["icon", dir, "--from", picture, "--force", "--json"]);
  assert.equal(fromPicture.code, 0, fromPicture.out + fromPicture.err);
  assert.equal(checkCatalogPng(readFileSync(front), "icon_front").verdict, "pass");
  assert.equal(checkCatalogPng(readFileSync(back), "icon_back").verdict, "pass");
  for (const wrong of [["--text", "ABC"], ["--text", "A", "--from", picture], ["--color", "red", "--text", "A"]]) assert.equal((await cli(t, ["icon", dir, "--force", ...wrong, "--json"])).json.code, "usage", wrong.join(" "));

  // --back: the back icon from a picture of its own, drawn at 11×11 (the window's Create app sends one), pixel for
  // pixel; one of another size is scaled to 11×11, as --from scales.
  const { encodePng, asText } = await import("../../capture/icon.mjs");
  const ring = new Uint8Array(11 * 11 * 4);
  for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) if (x === 0 || y === 0 || x === 10 || y === 10) ring.set([255, 0, 0, 255], (y * 11 + x) * 4);
  const own = path.join(tempDir(t), "back.png");
  writeFileSync(own, encodePng({ width: 11, height: 11, channels: 4, data: ring }));
  const withBack = await cli(t, ["icon", dir, "--text", "FT", "--back", own, "--force", "--json"]);
  assert.equal(withBack.code, 0, withBack.out + withBack.err);
  assert.equal(withBack.json.back_from.file, own);
  assert.equal(checkCatalogPng(readFileSync(back), "icon_back").verdict, "pass");
  assert.equal(asText(readFileSync(back)), ["###########", ...Array(9).fill("#.........#"), "###########"].join("\n"));
  const otherSize = await cli(t, ["icon", dir, "--text", "FT", "--back", picture, "--force", "--json"]);
  assert.equal(otherSize.code, 0, otherSize.out + otherSize.err);
  assert.equal(readFileSync(back).readUInt32BE(16), 11);
  assert.equal(checkCatalogPng(readFileSync(back), "icon_back").verdict, "pass");
});

test("the manifest's YAML gives the author's texts back exactly, whatever is in them", (t) => {
  const texts = [
    "plain",
    'quotes " and \\ and a tab\there',
    "colon: at the start\n# not a comment\n- not a list\n\nlast line",
    "  starts with spaces\nand goes on",
    "ends with a break\n",
    "trailing space \nnext",
    `emoji \u{1f550}, ${String.fromCodePoint(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442)} (letters outside Latin, written by their numbers) and \u2028, a line separator`,
    "yes",
    "1.0",
    "@file",
    "line\r\nwith a carriage return",
    // One line each, which is written as it stands only where no YAML reader takes it for anything but this text.
    "No",
    "null",
    "Null and void",
    "On time, every time (really)!",
    "a - b",
    "key: value",
    "ends with a colon:",
    "a #tag",
    "it's fine, isn't it?",
    "two  spaces",
    "NaN",
    "e",
    "1e3",
    "0x1f",
    "Counts up/down by 1.5",
    "trailing space ",
    "- dash first",
    "a\ttab",
  ];
  // Commits a YAML reader could take for a number: all digits, a binary or an exponent's form. One for each text.
  const commits = [COMMIT, "1234567890".repeat(4), `0b${"01".repeat(19)}`, `12e${"4".repeat(37)}`, "0".repeat(40), `${"0".repeat(39)}a`];
  const facts = (text, commit = COMMIT) => ({
    git: { head: commit, subdir: "apps/desk clock", remote: { github: { https: "https://github.com/jane-doe/desk-clock.git" } } },
    details: { json: { category: "meetings", short_description: text.replace(/[\r\n]/g, " "), description: text, changelog: text } },
    screenshots: { front: { files: [{ path: "screenshots/it's: one.png" }] }, back: { files: [] } },
  });
  let python;
  try {
    python = ["python3", "python"].find((name) => {
      try {
        return execProgram(name, ["-I", "-c", "import yaml, sys; print(sys.version_info[0])"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "3";
      } catch {
        return false;
      }
    });
  } catch {
    python = null;
  }
  assert.match(manifestYaml(facts("plain")), /\n {4}commit_sha: 0123456789abcdef0123456789abcdef01234567\n/, "a commit is written as the catalog's examples write it");
  assert.match(manifestYaml(facts("plain", "1234567890".repeat(4))), /\n {4}commit_sha: "1234567890/, "one of digits only is quoted: it would be read as a number");
  assert.match(manifestYaml(facts("On time, every time (really)!")), /\nshort_description: On time, every time \(really\)!\n/);
  assert.match(manifestYaml(facts("key: value")), /\nshort_description: "key: value"\n/);
  assert.match(manifestYaml(facts("No")), /\nshort_description: "No"\n/);
  for (const [index, text] of texts.entries()) {
    const commit = commits[index % commits.length];
    const yaml = manifestYaml(facts(text, commit));
    assert.match(yaml, /^sourcecode:\n {2}type: git\n {2}location:\n {4}origin: https:\/\/github\.com\/jane-doe\/desk-clock\.git\n/);
    assert.match(yaml, /\ncategory: productivity\n/, "another name of a category is written as the category");
    assert.match(yaml, /\n {4}subdir: apps\/desk clock\n/);
    assert.doesNotMatch(yaml, /back_screenshots/);
    if (!python) continue;
    const read = JSON.parse(execProgram(python, ["-I", "-c", "import yaml, sys, json; print(json.dumps(yaml.safe_load(sys.stdin.buffer.read().decode('utf-8'))))"], { input: yaml, encoding: "utf8" }));
    assert.equal(read.description, text, JSON.stringify(text));
    assert.equal(read.changelog, text);
    assert.equal(read.short_description, text.replace(/[\r\n]/g, " "));
    assert.equal(read.sourcecode.location.commit_sha, commit, "the commit is read back as a text, whatever its digits");
    assert.equal(read.sourcecode.location.subdir, "apps/desk clock");
    assert.deepEqual(read.screenshots, ["screenshots/it's: one.png"]);
  }
  t.diagnostic(python ? `read back with PyYAML (${python}), as the catalog reads it` : "PyYAML is not on this machine: the YAML was not read back");
});
