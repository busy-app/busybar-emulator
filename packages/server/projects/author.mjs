// The author `create` gives a new app when --author does not name one (the release dry run, 12.11): the app's id is
// app.<author>.<app>, so an author many people share (a Windows account "User", a Mac's "admin") gives them the same
// ids in the catalog. In order:
//
//   1. the GitHub login: the account the desktop app is signed in with (<data>/github/signed-in.json, the note
//      app/src/github/publish-flow.mjs keeps), else the one GitHub CLI uses on this computer (github.com's `user` in
//      gh's hosts.yml). The catalog's pull request comes from that account, and no two accounts have one login.
//   2. git's user.name, as the template's generator takes it, unless it is one of GENERIC_AUTHORS;
//   3. the account's name, unless it is one of them.
//
// Read from files alone: no gh or git is started, nothing goes over the network, no secret is kept (hosts.yml holds
// the token too when gh keeps it there; only the login is read out of it).
import { readFileSync } from "node:fs";
import path from "node:path";

import { genericAuthor } from "../readiness/rules.mjs";
import { idPart } from "./app-identity.mjs";

/** A GitHub login (app/src/github/gh.mjs, LOGIN). */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Whether a name, put into Latin letters as an id's part is, is one many computers share. */
export const isGenericAuthor = (name) => genericAuthor(idPart(name));

/** GitHub CLI's configuration folder, by gh's own rule: GH_CONFIG_DIR, XDG_CONFIG_HOME/gh, %APPDATA%\GitHub CLI, ~/.config/gh. */
export function ghConfigDir({ env = {}, platform = process.platform, home }) {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, "gh");
  if (platform === "win32" && env.APPDATA) return path.win32.join(env.APPDATA, "GitHub CLI");
  return home ? path.join(home, ".config", "gh") : null;
}

/** github.com's active account in the text of gh's hosts.yml (`    user: <login>` under `github.com:`), or null. */
export function activeLogin(hostsText) {
  let inHost = false;
  for (const line of String(hostsText ?? "").split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inHost = /^(["']?)github\.com\1:\s*$/.test(line);
      continue;
    }
    const user = inHost ? /^ {4}user:[ \t]*(["']?)([^"'\s]+)\1[ \t]*$/.exec(line) : null;
    if (user && LOGIN.test(user[2])) return user[2];
  }
  return null;
}

/** The login the desktop app is signed in with, from its note in the data folder; null when none, or it is stale. */
export function appLogin(dataDir, read = (file) => readFileSync(file, "utf8")) {
  if (!dataDir) return null;
  try {
    const note = JSON.parse(read(path.join(dataDir, "github", "signed-in.json")));
    return note?.stale !== true && LOGIN.test(note?.login ?? "") ? note.login : null;
  } catch {
    return null;
  }
}

/** The GitHub login for a new app's author: the desktop app's, else GitHub CLI's active one; null when neither. */
export function githubLogin({ dataDir = null, env = {}, platform = process.platform, home, read = (file) => readFileSync(file, "utf8") }) {
  const noted = appLogin(dataDir, read);
  if (noted) return noted;
  const dir = ghConfigDir({ env, platform, home });
  if (!dir) return null;
  try {
    return activeLogin(read(path.join(dir, "hosts.yml")));
  } catch {
    return null;
  }
}

/** git's user.name from the person's own settings files (~/.gitconfig, then XDG_CONFIG_HOME/git/config), or null. */
export function gitUserName({ env = {}, home, read = (file) => readFileSync(file, "utf8") }) {
  if (!home) return null;
  for (const file of [path.join(home, ".gitconfig"), path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "git", "config")]) {
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    let inUser = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("[")) inUser = /^\[\s*user\s*\]$/i.test(line);
      else if (inUser) {
        const name = /^name\s*=\s*(.*)$/i.exec(line)?.[1].replace(/^"(.*)"$/, "$1").trim();
        if (name) return name;
      }
    }
  }
  return null;
}
