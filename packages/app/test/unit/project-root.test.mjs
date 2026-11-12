// Create app's Open existing finds the project around the person's choice (src/project-root.mjs): from the folder
// itself, a folder in it or any file in it; never above the home folder; a folder inside node_modules is never the
// project; a package.json or a manifest that is a link out of its folder is refused; a built app with only a manifest
// is told as that; a folder of nothing is said plainly. That the rule of a project is the command line's own
// (node-tools.mjs readProject) is held in packages/server/projects/test/node-tools.test.mjs: the app's tests import
// nothing of the server's.
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { findProjectRoot } from "../../src/project-root.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const root = realpathSync(temporaryFolder());
after(() => removeFolder(root));
const HOME = path.join(root, "home");

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof text === "string" ? text : JSON.stringify(text));
}
/** A project of the official tools: package.json naming @busy-app/cli, the manifest in src/appmeta. */
function project(dir, { id = "app.you.clock", name = "Clock", dev = true } = {}) {
  write(path.join(dir, "package.json"), { name: path.basename(dir), [dev ? "devDependencies" : "dependencies"]: { "@busy-app/cli": "^0.6.0" } });
  write(path.join(dir, "src", "appmeta", "manifest.json"), { id, name });
  write(path.join(dir, "src", "scripts", "main.js"), "// main\n");
  write(path.join(dir, "src", "assets", "picture.png"), "png");
  return dir;
}
const find = (chosen) => findProjectRoot(chosen, { home: HOME });
const canLink = (() => {
  try {
    const at = path.join(root, "link-probe");
    symlinkSync(root, at, "dir");
    return true;
  } catch {
    return false;
  }
})();

test("the folder itself, a folder in it, or any file in it: the same project, with its name and id", () => {
  const clock = project(path.join(HOME, "work", "clock"));
  for (const chosen of [clock, path.join(clock, "src"), path.join(clock, "src", "scripts", "main.js"), path.join(clock, "src", "assets", "picture.png"), path.join(clock, "package.json")]) {
    const answer = find(chosen);
    assert.deepEqual([answer.found, answer.folder, answer.id, answer.name], [true, clock, "app.you.clock", "Clock"], chosen);
  }
  assert.equal(find(path.join(clock, "src", "scripts", "main.js")).start, path.join(clock, "src", "scripts"), "from the folder the file is in");
  // The manifest at the top (appmeta/), and @busy-app/cli among the dependencies, count too.
  const top = path.join(HOME, "work", "top");
  write(path.join(top, "package.json"), { dependencies: { "@busy-app/cli": "0.6.0" } });
  write(path.join(top, "appmeta", "manifest.json"), { id: "app.you.top", name: "Top" });
  assert.deepEqual([find(path.join(top, "appmeta")).folder, find(top).id], [top, "app.you.top"]);
});

test("the nearest project wins; a package of node_modules is never the project", () => {
  const outer = project(path.join(HOME, "work", "outer"), { id: "app.you.outer", name: "Outer" });
  const inner = project(path.join(outer, "examples", "inner"), { id: "app.you.inner", name: "Inner" });
  assert.equal(find(path.join(inner, "src", "scripts", "main.js")).folder, inner);
  assert.equal(find(path.join(outer, "examples")).folder, outer);
  // A package in node_modules that names the command line (a tool of BUSY's own) is passed by.
  const pkg = path.join(outer, "node_modules", "@busy-app", "create-app");
  write(path.join(pkg, "package.json"), { dependencies: { "@busy-app/cli": "0.6.0" } });
  write(path.join(pkg, "index.js"), "");
  assert.equal(find(path.join(pkg, "index.js")).folder, outer);
});

test("nothing found: said plainly; the walk never looks at the home folder or above it", () => {
  const pictures = path.join(HOME, "Pictures", "holiday");
  write(path.join(pictures, "a.png"), "png");
  assert.deepEqual(find(path.join(pictures, "a.png")), { found: false, start: pictures, message: "No BUSY app found in this folder or above it." });
  // A package.json naming the command line in the home folder itself (or above it) is not looked at.
  write(path.join(HOME, "package.json"), { devDependencies: { "@busy-app/cli": "0.6.0" } });
  write(path.join(root, "package.json"), { devDependencies: { "@busy-app/cli": "0.6.0" } });
  assert.equal(find(pictures).found, false);
  assert.equal(find(HOME).found, false);
  // A package.json of another kind is no project either; one that cannot be read neither.
  const web = path.join(HOME, "work", "website");
  write(path.join(web, "package.json"), { devDependencies: { vite: "5" } });
  assert.equal(find(web).found, false);
  write(path.join(HOME, "work", "broken", "package.json"), "{ not json");
  assert.equal(find(path.join(HOME, "work", "broken")).found, false);
  // Not there, not absolute.
  assert.match(find(path.join(HOME, "nowhere", "x.js")).message, /is not there\./);
  assert.equal(findProjectRoot("relative/path", { home: HOME }).found, false);
});

test("a built app or a project of other tools, with a manifest but no package.json naming @busy-app/cli, is told as that", () => {
  const built = path.join(HOME, "downloads", "clock-built");
  write(path.join(built, "appmeta", "manifest.json"), { id: "app.you.clock", name: "Clock" });
  write(path.join(built, "scripts", "main.js"), "");
  const answer = find(path.join(built, "scripts", "main.js"));
  assert.deepEqual([answer.found, answer.manifestOnly], [false, built]);
  assert.match(answer.message, /has an app's manifest, but no package\.json that names @busy-app\/cli/);
});

test("a package.json or a manifest that is a link to a file outside its folder is refused", { skip: !canLink && "this system makes no links here" }, () => {
  const elsewhere = path.join(root, "elsewhere");
  write(path.join(elsewhere, "package.json"), { devDependencies: { "@busy-app/cli": "0.6.0" } });
  write(path.join(elsewhere, "manifest.json"), { id: "app.someone.else", name: "Else" });
  const linked = path.join(HOME, "work", "linked");
  mkdirSync(path.join(linked, "src"), { recursive: true });
  symlinkSync(path.join(elsewhere, "package.json"), path.join(linked, "package.json"), "file");
  const answer = find(path.join(linked, "src"));
  assert.equal(answer.found, false);
  assert.match(answer.message, /package\.json in .*linked is a link to a file outside that folder/);

  const manifestOut = project(path.join(HOME, "work", "manifest-out"));
  const manifest = path.join(manifestOut, "src", "appmeta", "manifest.json");
  rmSync(manifest);
  symlinkSync(path.join(elsewhere, "manifest.json"), manifest, "file");
  const refused = find(manifestOut);
  assert.equal(refused.found, false);
  assert.match(refused.message, /app's manifest in .*manifest-out is a link to a file outside that folder/);

  // A link the person chose is taken where it leads: the project there, by its real path.
  const real = project(path.join(root, "disk", "clock"));
  symlinkSync(real, path.join(HOME, "clock-link"), "dir");
  assert.equal(find(path.join(HOME, "clock-link", "src", "scripts", "main.js")).folder, real);
});
