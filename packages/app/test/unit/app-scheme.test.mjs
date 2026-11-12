import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { APP_HOSTS, createAppSchemeHandler, resolveAppFile } from "../../src/app-scheme.mjs";
import { APP_DIR, realPath, removeFolder, temporaryFolder } from "../helpers.mjs";

const SRC = path.join(APP_DIR, "src");
let root;

before(() => {
  // A copy of the layout with things beside the served folder that must stay out of reach.
  root = temporaryFolder();
  mkdirSync(path.join(root, "pages", "shell", "sub"), { recursive: true });
  writeFileSync(path.join(root, "pages", "shell", "page.html"), "<!doctype html><title>page</title>");
  writeFileSync(path.join(root, "pages", "shell", "sub", "deep.js"), "// deep");
  writeFileSync(path.join(root, "pages", "shell", "notes.txt"), "not a served type");
  writeFileSync(path.join(root, "pages", "shell", ".hidden.js"), "// hidden");
  // One level up and two levels up from the served folder.
  writeFileSync(path.join(root, "pages", "secret.js"), "// outside the folder");
  writeFileSync(path.join(root, "pages", "other.html"), "outside the host's folder");
  writeFileSync(path.join(root, "secret.js"), "// outside the folder");
});
after(() => removeFolder(root));

test("the hosts are exactly: shell", () => {
  assert.deepEqual(APP_HOSTS, { shell: "pages/shell", capture: "pages/capture" });
});

test("a file of the host's folder is found, also in a folder below it", () => {
  assert.deepEqual(resolveAppFile("app://shell/page.html", root), { file: path.join(realPath(root), "pages", "shell", "page.html"), type: "text/html; charset=utf-8" });
  assert.equal(resolveAppFile("app://shell/sub/deep.js", root)?.type, "text/javascript; charset=utf-8");
  assert.equal(resolveAppFile("app://shell/page.html?x=1#y", root)?.type, "text/html; charset=utf-8");
});

test("the real message page is found", () => {
  for (const name of ["message.html", "message.js", "message.css"]) assert.ok(resolveAppFile(`app://shell/${name}`, SRC), name);
});

test("nothing outside the folder is served", () => {
  const outside = [
    "app://shell/../secret.js",
    "app://shell/%2e%2e/secret.js",
    "app://shell/..%2fsecret.js",
    "app://shell/..%5csecret.js",
    "app://shell/..%2f..%2fsecret.js",
    "app://shell/..%5c..%5csecret.js",
    "app://shell/sub%2f..%2f..%2f..%2fsecret.js",
    "app://shell/sub/..%2f..%2fsecret.js",
    "app://shell/..%2fother.html",
    "app://shell/sub/../../secret.js",
    "app://shell/sub/%2e%2e/%2e%2e/secret.js",
    "app://shell/sub%2f..%2f..%2fsecret.js",
    "app://shell//secret.js",
    "app://shell/%2fsecret.js",
    "app://shell/../other.html",
    "app://shell/%252e%252e/secret.js",
    `app://shell/${encodeURIComponent(path.join(root, "secret.js"))}`,
    "app://shell/C:%5Csecret.js",
    "app://shell/page.html%00.js",
    "app://shell/%E0%A4%A",
  ];
  for (const address of outside) assert.equal(resolveAppFile(address, root), null, address);
});

test("only the listed hosts, only this scheme, only served types, no folders, no hidden files", () => {
  const refused = [
    "app://other/page.html",
    "app://window/page.html",
    "app://stage/page.html",
    "app://constructor/page.html",
    "app://SHELL@other/page.html",
    "app://shell:81/page.html",
    "app://user@shell/page.html",
    "file://shell/page.html",
    "http://shell/page.html",
    "app://shell/",
    "app://shell",
    "app://shell/sub",
    "app://shell/sub/",
    "app://shell/notes.txt",
    "app://shell/.hidden.js",
    "app://shell/missing.html",
    "not an address",
  ];
  for (const address of refused) assert.equal(resolveAppFile(address, root), null, address);
});

test("a link that leads out of the folder is not followed", (t) => {
  // A link to a folder: a junction on Windows, which needs no privilege.
  symlinkSync(root, path.join(root, "pages", "shell", "up"), "junction");
  assert.equal(resolveAppFile("app://shell/up/secret.js", root), null);
  assert.equal(resolveAppFile("app://shell/up/pages/other.html", root), null);
  try {
    symlinkSync(path.join(root, "secret.js"), path.join(root, "pages", "shell", "link.js"));
  } catch (e) {
    if (e.code === "EPERM") return t.skip("links to files need a privilege on Windows: only the link to a folder was checked");
    throw e;
  }
  assert.equal(resolveAppFile("app://shell/link.js", root), null);
});

test("the handler answers GET with the file and the page policy, and nothing else", async () => {
  const handle = createAppSchemeHandler(root);
  const ok = handle(new Request("app://shell/page.html"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  const policy = ok.headers.get("content-security-policy");
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self'(;|$)/);
  assert.doesNotMatch(policy, /unsafe/);
  assert.equal(await ok.text(), "<!doctype html><title>page</title>");

  assert.equal(handle(new Request("app://shell/../secret.js")).status, 404);
  assert.equal(handle(new Request("app://other/page.html")).status, 404);
  assert.equal(handle(new Request("app://shell/page.html", { method: "POST", body: "x" })).status, 405);
});
