// Tests of checks.mjs on small trees made in a temporary folder. No emsdk and no firmware checkout; git is used to
// make a throwaway repository.
//
//   node --test "packages/engine/test/*.test.mjs"      (from emulator/)

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { assetsProblems, dirtyEntries, emscriptenVersion, filesIn, gitTreeId, manifestText, readManifest, refreshAssets, sha256 } from "../checks.mjs";
import { execProgram } from "../programs.mjs";

const engine = join(dirname(fileURLToPath(import.meta.url)), "..");

let tmp;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "emu-engine-checks-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes files given as { "path/in/dir": "text" } and returns the folder. */
function tree(name, files) {
  const dir = join(tmp, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const git = (dir, ...args) => execProgram("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]).toString().trim();

describe("filesIn", () => {
  test("lists files of all folders, sorted, without what macOS leaves behind", () => {
    const dir = tree("files", { "b.txt": "b", "a/z.txt": "z", "a/._z.txt": "fork", ".DS_Store": "finder", "a/b/c.txt": "c" });
    assert.deepEqual(filesIn(dir), ["a/b/c.txt", "a/z.txt", "b.txt"]);
  });

  test("a folder that is not there has no files", () => {
    assert.deepEqual(filesIn(join(tmp, "no-such-folder")), []);
  });
});

describe("gitTreeId", () => {
  test("is the id git itself gives the folder", () => {
    // Names chosen so that git's order (a folder sorts as "name/") differs from plain order of names.
    const repo = tree("tree-repo", { "web/index.html": "<html>", "web/a.b/x.js": "x", "web/a-b.js": "y", "web/a/deep/z.css": "z", "web/a.js": "" });
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "tree");
    assert.equal(gitTreeId(join(repo, "web")), git(repo, "rev-parse", "HEAD:web"));
  });

  test("changes when a byte of one file changes", () => {
    const dir = tree("tree-change", { "index.html": "one", "js/app.js": "two" });
    const id = gitTreeId(dir);
    writeFileSync(join(dir, "js/app.js"), "twO");
    assert.notEqual(gitTreeId(dir), id);
  });
});

describe("the list of app assets", () => {
  const manifestFor = (files) => ({ about: "test", files: Object.fromEntries(Object.entries(files).map(([path, [origin, text]]) => [path, { origin, source: `src/${path}`, sha256: sha256(Buffer.from(text)) }])) });

  test("a folder that is what the list says has no problems", () => {
    const dir = tree("assets-ok", { "shared/a.image": "A", "busy/b.anim": "B" });
    assert.deepEqual(assetsProblems(manifestFor({ "shared/a.image": ["firmware-build", "A"], "busy/b.anim": ["bar", "B"] }), dir), []);
  });

  test("a file that is not listed, a listed file that is missing and a file with other bytes are each reported", () => {
    const dir = tree("assets-bad", { "shared/a.image": "A changed", "shared/extra.bin": "?" });
    const problems = assetsProblems(manifestFor({ "shared/a.image": ["firmware-build", "A"], "busy/b.anim": ["bar", "B"] }), dir);
    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /shared\/extra\.bin is not in apps-assets\.json/);
    assert.match(problems.join("\n"), /lists busy\/b\.anim, which is not in build\/apps-assets/);
    assert.match(problems.join("\n"), /shared\/a\.image does not have the bytes apps-assets\.json records/);
  });

  test("the same names with other bytes are not enough", () => {
    const dir = tree("assets-names-only", { "shared/sounds/click.snd": "from somewhere else" });
    assert.equal(assetsProblems(manifestFor({ "shared/sounds/click.snd": ["bar", "from a bar"] }), dir).length, 1);
  });

  test("a refresh takes the firmware build's files again and leaves the files read from a bar alone", () => {
    const to = tree("refresh-to", { "shared/images/a.image": "A old", "shared/images/kept.image": "same", "shared/sounds/click.snd": "from a bar", "busy/b.anim": "B from a bar" });
    // The firmware build has a sound of the same name, and a file read from a bar in a folder it also fills.
    const from = tree("refresh-from", { "shared/images/a.image": "A new", "shared/images/kept.image": "same", "shared/images/bar.image": "fbt's", "shared/sounds/click.snd": "fbt's" });
    writeFileSync(join(to, "shared/images/bar.image"), "bar's");
    const manifest = manifestFor({
      "shared/images/a.image": ["firmware-build", "A old"],
      "shared/images/kept.image": ["firmware-build", "same"],
      "shared/images/bar.image": ["bar", "bar's"],
      "shared/sounds/click.snd": ["bar", "from a bar"],
      "busy/b.anim": ["bar", "B from a bar"],
    });
    const written = [];
    const { problems, changed } = refreshAssets(manifest, from, to, (bytes, file) => {
      written.push(file);
      writeFileSync(file, bytes);
    });
    assert.deepEqual(problems, []);
    assert.deepEqual(changed, ["shared/images/a.image"]);
    assert.deepEqual(written, [join(to, "shared/images/a.image")]);
    assert.equal(readFileSync(join(to, "shared/images/a.image"), "utf8"), "A new");
    assert.equal(readFileSync(join(to, "shared/sounds/click.snd"), "utf8"), "from a bar");
    assert.equal(readFileSync(join(to, "shared/images/bar.image"), "utf8"), "bar's");
    // The list records the new bytes, so the folder still is what the list says.
    assert.deepEqual(assetsProblems(manifest, to), []);
  });

  test("a refresh from a folder with other names changes nothing and says which", () => {
    const to = tree("refresh-stop-to", { "shared/images/a.image": "A", "shared/images/b.image": "B" });
    const from = tree("refresh-stop-from", { "shared/images/a.image": "A new", "shared/images/c.image": "C" });
    const manifest = manifestFor({ "shared/images/a.image": ["firmware-build", "A"], "shared/images/b.image": ["firmware-build", "B"] });
    const { problems, changed } = refreshAssets(manifest, from, to, () => assert.fail("nothing may be written"));
    assert.deepEqual(changed, []);
    assert.equal(problems.length, 2);
    assert.match(problems.join("\n"), /has no shared\/images\/b\.image/);
    assert.match(problems.join("\n"), /has shared\/images\/c\.image, which is not in apps-assets\.json/);
    assert.equal(manifest.files["shared/images/a.image"].sha256, sha256(Buffer.from("A")));
  });

  test("apps-assets.json is written the way the build writes it, and names where every file comes from", () => {
    const file = join(engine, "apps-assets.json");
    const manifest = readManifest(file);
    assert.equal(manifestText(manifest), readFileSync(file, "utf8"));
    for (const [path, record] of Object.entries(manifest.files)) {
      assert.ok(record.origin in manifest.origins, `${path}: origin ${record.origin}`);
      assert.ok(record.source, `${path}: no source`);
      assert.match(record.sha256, /^[0-9a-f]{64}$/, path);
    }
  });
});

describe("dirtyEntries", () => {
  test("a checkout that is its commit has none; an edit, a new file and a removed one are each reported", () => {
    const repo = tree("dirty-repo", { "src/a.c": "int a;", "src/b.c": "int b;" });
    git(repo, "init", "-q");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "one");
    assert.deepEqual(dirtyEntries(repo), []);

    writeFileSync(join(repo, "src/._a.c"), "what macOS leaves");
    writeFileSync(join(repo, ".DS_Store"), "finder");
    assert.deepEqual(dirtyEntries(repo), [], "macOS clutter is not a change");

    writeFileSync(join(repo, "src/a.c"), "int a = 1;");
    writeFileSync(join(repo, "src/new.c"), "int n;");
    rmSync(join(repo, "src/b.c"));
    const dirty = dirtyEntries(repo);
    assert.equal(dirty.length, 3);
    assert.ok(dirty.some((line) => line.endsWith("src/a.c")));
    assert.ok(dirty.some((line) => line.endsWith("src/b.c")));
    assert.ok(dirty.some((line) => line.endsWith("src/new.c")));
  });
});

describe("emscriptenVersion", () => {
  test("reads the version from the first line of emcc --version", () => {
    assert.equal(emscriptenVersion("emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 7.0.0 (0123abcd)\nCopyright (C) 2026 the Emscripten authors\n"), "7.0.0");
    assert.equal(emscriptenVersion("emcc 6.0.13-git\n"), "6.0.13");
    assert.equal(emscriptenVersion("not a compiler\n"), null);
  });
});
