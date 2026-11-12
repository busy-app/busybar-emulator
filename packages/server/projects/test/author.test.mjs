// A new app's author from files alone (author.mjs): the GitHub login, git's user.name, names many computers share.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { GENERIC_AUTHORS, genericAuthor } from "../../readiness/rules.mjs";
import { activeLogin, appLogin, ghConfigDir, githubLogin, gitUserName, isGenericAuthor } from "../author.mjs";

/** A reader of the files in `files` (full path → text); any other is not there. */
const reader = (files) => (file) => {
  if (!(file in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return files[file];
};

test("names many computers share are generic, letter case, spaces and dots aside; a person's name is not", () => {
  for (const name of ["User", "user", "USERS", "Admin", "Administrator", "owner", "PC", "Guest", "root", "defaultuser0", "Your Name", "BUSY Bar developer", " user ", "user."]) assert.ok(genericAuthor(name), name);
  for (const name of ["jane", "Jane Doe", "octocat", "user42", "superuser", "admin-jane", "", null]) assert.ok(!genericAuthor(name), String(name));
  // Written as an id's part: lower-case, "_" for a space.
  for (const name of GENERIC_AUTHORS) assert.match(name, /^[a-z0-9_-]+$/);
  // Put into Latin letters first: the Russian word for "user" is one of them, a Cyrillic first name is not.
  assert.ok(isGenericAuthor(String.fromCodePoint(0x41f, 0x43e, 0x43b, 0x44c, 0x437, 0x43e, 0x432, 0x430, 0x442, 0x435, 0x43b, 0x44c)));
  assert.ok(!isGenericAuthor(String.fromCodePoint(0x418, 0x432, 0x430, 0x43d)));
});

test("the desktop app's copy of the list is the same (packages/app does not import the server's modules)", () => {
  const source = readFileSync(new URL("../../../app/src/actions.mjs", import.meta.url), "utf8");
  const list = /export const GENERIC_AUTHORS = Object\.freeze\((\[[^\]]*\])\)/.exec(source)?.[1];
  assert.ok(list, "GENERIC_AUTHORS in packages/app/src/actions.mjs");
  assert.deepEqual(JSON.parse(list), [...GENERIC_AUTHORS]);
});

test("gh's configuration folder by gh's own rule", () => {
  assert.equal(ghConfigDir({ env: { GH_CONFIG_DIR: "/x/gh" }, platform: "darwin", home: "/h" }), "/x/gh");
  assert.equal(ghConfigDir({ env: { XDG_CONFIG_HOME: "/x" }, platform: "linux", home: "/h" }), path.join("/x", "gh"));
  const roaming = path.win32.join("D:", "Profile", "Roaming");
  assert.equal(ghConfigDir({ env: { APPDATA: roaming }, platform: "win32", home: path.win32.dirname(roaming) }), path.win32.join(roaming, "GitHub CLI"));
  assert.equal(ghConfigDir({ env: {}, platform: "darwin", home: "/h" }), path.join("/h", ".config", "gh"));
});

test("the active login from gh's hosts.yml: github.com's user only, in both layouts; the token is never read out", () => {
  const multi = ["github.com:", "    users:", "        jane:", "            oauth_token: gho_secret", "        other:", "    git_protocol: https", "    user: jane", "ghe.example.com:", "    user: notthis", ""].join("\n");
  assert.equal(activeLogin(multi), "jane");
  assert.equal(activeLogin("github.com:\r\n    oauth_token: gho_x\r\n    user: \"Jane-Dev\"\r\n"), "Jane-Dev");
  assert.equal(activeLogin("ghe.example.com:\n    user: jane\n"), null);
  assert.equal(activeLogin("github.com:\n    user: not a login\n"), null);
  assert.equal(activeLogin(""), null);
});

test("githubLogin: the desktop app's sign-in first (not a stale one), else GitHub CLI's active account", () => {
  const home = "/h";
  const hosts = path.join(home, ".config", "gh", "hosts.yml");
  const note = path.join("/data", "github", "signed-in.json");
  const files = { [hosts]: "github.com:\n    user: cli-jane\n", [note]: JSON.stringify({ login: "app-jane", origin: "existing" }) };
  assert.equal(githubLogin({ dataDir: "/data", env: {}, platform: "darwin", home, read: reader(files) }), "app-jane");
  assert.equal(githubLogin({ dataDir: "/data", env: {}, platform: "darwin", home, read: reader({ ...files, [note]: JSON.stringify({ login: "app-jane", origin: "app", stale: true }) }) }), "cli-jane");
  assert.equal(githubLogin({ dataDir: "/data", env: {}, platform: "darwin", home, read: reader({ [hosts]: files[hosts] }) }), "cli-jane");
  assert.equal(githubLogin({ dataDir: "/data", env: {}, platform: "darwin", home, read: reader({}) }), null);
  assert.equal(appLogin("/data", reader({ [note]: "not json" })), null);
});

test("gitUserName: user.name of ~/.gitconfig, then of XDG_CONFIG_HOME/git/config", () => {
  const home = "/h";
  assert.equal(gitUserName({ home, read: reader({ [path.join(home, ".gitconfig")]: "[core]\n\tname = no\n[user]\n\temail = j@x\n\tname = \"Jane Doe\"\n" }) }), "Jane Doe");
  assert.equal(gitUserName({ home, env: { XDG_CONFIG_HOME: "/x" }, read: reader({ [path.join("/x", "git", "config")]: "[user]\nname=jane\n" }) }), "jane");
  assert.equal(gitUserName({ home, read: reader({}) }), null);
});
