// The look at an app package before it is installed (app-package.mjs): its app's manifest read in memory, and the
// packages refused, each with its reason: broken, an absolute or ".." path, too big, a bad manifest, no app.
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

import { targz } from "../../../../test/package.mjs";
import { checkAppPackage, MAX_PACKAGE_BYTES } from "../app-package.mjs";

const MANIFEST = { format_version: 1, id: "app.you.clock", name: "Clock", version: "1.2.0", api_version: "0.1.0" };
const app = (manifest = MANIFEST, folder = "app.you.clock", more = {}) => ({ [`${folder}/appmeta/manifest.json`]: JSON.stringify(manifest), [`${folder}/scripts/main.js`]: "draw();\n", ...more });
const problem = (bytes) => {
  try {
    checkAppPackage(bytes);
  } catch (e) {
    return { code: e.code, message: e.message, hint: e.hint };
  }
  return null;
};

test("a package busy-cli builds: the app's id, name, version and API version, read without writing anything", () => {
  const bytes = targz(app(MANIFEST, "app.you.clock", { "app.you.clock/assets/icon.png": "png" }));
  const facts = checkAppPackage(bytes);
  assert.deepEqual({ ...facts, notes: undefined }, { id: "app.you.clock", name: "Clock", version: "1.2.0", api_version: "0.1.0", folder: "app.you.clock", files: 3, size: bytes.length, notes: undefined });
  assert.deepEqual(facts.notes, []);
  // macOS's "._" files are installed by the bar as they are: a note, not a refusal. The top's "._<id>" is not the app.
  const mac = checkAppPackage(targz({ "._app.you.clock": "x", ...app(MANIFEST, "app.you.clock", { "app.you.clock/scripts/._main.js": "x" }) }));
  assert.equal(mac.id, "app.you.clock");
  assert.match(mac.notes.join("\n"), /2 macOS "\._" files/);
  // The first top folder that is an app wins, as on the bar; one with a bad manifest before it is passed over.
  const two = checkAppPackage(targz({ ...app({ ...MANIFEST, id: "other" }, "first"), ...app() }));
  assert.equal(two.id, "app.you.clock");
});

test("refused, each with its reason: broken, an absolute or .. path, too big, a bad manifest, no app", () => {
  assert.equal(problem(Buffer.alloc(0)).code, "broken_package");
  assert.deepEqual(problem(Buffer.from("not a package at all, just text")), { code: "broken_package", message: "The package cannot be read: the archive ends before its end, or is no archive.", hint: "Build the package again with busy-cli build, or ask its author for one." });
  const cut = targz(app());
  assert.match(problem(cut.subarray(0, 40)).message, /cannot be read: the archive ends before its end/);
  const tar = Buffer.from(gzipSync(Buffer.alloc(1024, 7)));
  assert.equal(problem(tar).code, "broken_package", "a bad checksum");
  assert.deepEqual([problem(targz({ "../evil.js": "x", ...app() })).code, problem(targz({ "../evil.js": "x", ...app() })).message], ["unsafe_path", 'The package has "../", a ".." part: an app package made by busy-cli has none.']);
  assert.match(problem(targz({ "app.you.clock/../../evil.js": "x", ...app() })).message, /a "\.\." part/);
  assert.match(problem(targz({ "/etc/evil": "x", ...app() })).message, /an absolute path/);
  assert.match(problem(targz({ "./app.you.clock/scripts/main.js": "x" })).message, /a "\." part/);
  assert.equal(problem(targz({ 'app.you.clock/a"b.js': "x", ...app() })).code, "broken_package");
  assert.deepEqual(problem(Buffer.alloc(MAX_PACKAGE_BYTES + 1, 1)), { code: "package_too_large", message: "The package is larger than the BUSY Bar takes (100 MiB).", hint: "Build a smaller package." });
  for (const [manifest, folder, why] of [
    [{ ...MANIFEST, id: "app.you.other" }, "app.you.clock", /id "app\.you\.other" is not the name of its folder, "app\.you\.clock"/],
    [{ ...MANIFEST, version: "1.2" }, "app.you.clock", /version is not MAJOR\.MINOR\.PATCH/],
    [{ ...MANIFEST, format_version: 2 }, "app.you.clock", /format_version is not 1/],
    [{ ...MANIFEST, name: undefined }, "app.you.clock", /it has no name/],
    [{ ...MANIFEST, heap_size_kib: 4096 }, "app.you.clock", /heap_size_kib/],
  ]) {
    const said = problem(targz(app(manifest, folder)));
    assert.equal(said.code, "bad_manifest");
    assert.match(said.message, why);
  }
  assert.match(problem(targz({ "app.you.clock/appmeta/manifest.json": "{ not json", "app.you.clock/scripts/main.js": "x" })).message, /is not JSON/);
  assert.equal(problem(targz({ "app.you.clock/appmeta/manifest.json": JSON.stringify(MANIFEST) })).code, "no_app", "no scripts/main.js");
  assert.equal(problem(targz({ "readme.txt": "hello" })).code, "no_app");
});
