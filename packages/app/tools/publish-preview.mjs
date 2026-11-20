#!/usr/bin/env node
// Publish's states, live (EMU-360): a development run of the app from this folder on a stand-in for GitHub
// (test/fixtures/github-stub.mjs, with the tests' stand-in for GitHub CLI), so that every state of Publish to GitHub
// and Send to catalog can be looked at: sending, sent, updated, each failure, a request half made, a project out of
// date. Nothing reaches github.com: the stand-in keeps its repositories in memory, and the app's GitHub CLI is the
// tests' stand-in, signed in as octo-person.
//
//   BUSY_EMULATOR_PORT=8653 BUSY_EMULATOR_DATA=<an empty temporary folder> node tools/publish-preview.mjs [--no-project]
//
// Only a development run reads the variables used here (config.mjs). BUSY_EMULATOR_DATA is required, so that the
// preview never writes to the person's data folder: one that is not empty, or is the emulator's own, is refused. The
// folder is marked as past the first run's greeting. Once the
// app is up, the preview makes a project ready to publish in that folder (the Focus Timer example, through the command
// line: texts, screenshots, README, the MIT license, checked and packaged), unless --no-project. Then, in the window:
// Publish on Focus Timer, Publish to GitHub (Use octo-person), Send to catalog. The terminal takes a number and Enter:
// what GitHub does with the next sends (each stays until another is chosen, but 7, which fails once); e and g switch
// what Sign commits with meets (EMU-366): whether the sign-in may read the account's addresses, and GitHub's GH007,
// which refuses a commit signed with any but the account's private address. A preview run
// again needs a new empty folder. Ctrl+C or
// closing the app ends both.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { FAKE_GH, fakeSignedIn } from "../test/fixtures/fake-gh.mjs";
import { startGithubStub } from "../test/fixtures/github-stub.mjs";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(appDir, "..", "server", "cli", "busy-emulator.mjs");
const { values } = parseArgs({ options: { "no-project": { type: "boolean", default: false } } });
const data = process.env.BUSY_EMULATOR_DATA;
if (!data || !process.env.BUSY_EMULATOR_PORT) {
  console.error("Name a port and a data folder of its own: BUSY_EMULATOR_PORT=8653 BUSY_EMULATOR_DATA=<an empty temporary folder>");
  process.exit(2);
}

/** busy-app/busy-apps-catalog's pull request template as of 18 Nov 2026. */
const TEMPLATE = `# Author checklist

- [ ] I've read the [terms for authors](https://github.com/busy-app/busy-apps-catalog/blob/main/TERMS.md) and my app follows them
- [ ] I'm the author of the app or have write access to its repository
- [ ] The app builds with \`busy-cli build\`, and its lock file is committed
- [ ] The manifest follows the Catalog manifest format
- [ ] I've tested the app on a BUSY Bar running the latest release firmware or using the official [BUSY Bar Emulator](https://github.com/busy-app/busybar-emulator)
- [ ] All screenshots were captured from a BUSY Bar or the official [BUSY Bar Emulator](https://github.com/busy-app/busybar-emulator)
- [ ] (optional) My app takes part in the BUSY JS Apps Contest, and I accept the [contest rules](https://go.busy.app/terms-of-js-apps-contest)

# AI usage

Keep **one** option and delete the others.

- No AI was used
- Partly AI-assisted: describe which parts were AI-generated and what they do
- Fully AI-generated: describe what the generated code does
`;

// Never the person's data folder, nor one with anything in it: the preview writes a project, a GitHub CLI and
// settings there.
const real = [path.join(os.homedir(), "Library", "Application Support", "BUSY Bar Emulator"), path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "BUSY Bar Emulator"), path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "BUSY Bar Emulator"), path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "BUSY Bar Emulator"), path.join(os.homedir(), ".busy-emulator")];
const resolved = path.resolve(data);
const same = (a, b) => (process.platform === "win32" || process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (real.some((one) => same(path.resolve(one), resolved))) {
  console.error(`${resolved} is the emulator's own data folder: name an empty temporary folder instead.`);
  process.exit(2);
}
if (existsSync(resolved) && (!statSync(resolved).isDirectory() || readdirSync(resolved).length)) {
  console.error(`${resolved} is not an empty folder: name an empty temporary folder (mktemp -d).`);
  process.exit(2);
}
mkdirSync(data, { recursive: true });
const settings = path.join(data, "app-settings.json");
if (!existsSync(settings)) writeFileSync(settings, `${JSON.stringify({ welcomed: true })}\n`);

const github = await startGithubStub({ port: 0 });
github.makeRepo("busy-app", "busy-apps-catalog");
github.commitFiles("busy-app/busy-apps-catalog", "main", { "README.md": "# BUSY Apps Catalog\n", "applications/.gitkeep": "", ".github/PULL_REQUEST_TEMPLATE.md": TEMPLATE });
// GitHub CLI (the stand-in) signed in already: the window offers Use octo-person.
const person = path.join(data, "person");
fakeSignedIn(person, { login: github.login, token: github.token, standIn: github.base });
// The person's git settings, a stand-in's (EMU-366): Sign commits with offers its address too, never the real ones.
writeFileSync(path.join(person, ".gitconfig"), "[user]\n\tname = Preview Person\n\temail = preview.person@example.com\n");

const env = {
  ...process.env,
  BUSY_EMULATOR_NODE: process.env.BUSY_EMULATOR_NODE ?? process.execPath,
  BUSY_EMULATOR_GH: FAKE_GH,
  BUSY_EMULATOR_FAKE_GH_STAND_IN: github.base,
  BUSY_EMULATOR_GH_CONFIG_DIR: path.join(person, "gh"),
  BUSY_EMULATOR_GIT_HOME: person,
};

// ---- what GitHub does with the next sends

const api = (url) => url.pathname.startsWith("/api/");
const writes = (req) => req.method !== "GET" && req.method !== "HEAD";
const MODES = [
  { key: "0", name: "GitHub answers as it should", fail: null, hold: null },
  { key: "1", name: "GitHub is slow: each write waits 4 s (the sending screens stay up)", fail: null, hold: (req, url) => (api(url) && writes(req) ? new Promise((resolve) => setTimeout(resolve, 4000)) : null) },
  { key: "2", name: "No network: GitHub does not answer", fail: (req, url) => (api(url) ? { drop: true } : null) },
  { key: "3", name: "The sign-in has expired: GitHub answers 401 (then 0, and Use octo-person again)", fail: (req, url) => (api(url) ? { status: 401, body: { message: "Bad credentials" } } : null) },
  { key: "4", name: "No access to the fork: the fork is made, a write to it refused", fail: (req, url) => (req.method === "POST" && url.pathname.startsWith(`/api/repos/${github.login}/busy-apps-catalog/git/`) ? { status: 403, body: { message: "Resource not accessible by integration" } } : null) },
  { key: "f", name: "The catalog can't be forked: making the fork is refused", fail: (req, url) => (req.method === "POST" && url.pathname === "/api/repos/busy-app/busy-apps-catalog/forks" ? { status: 403, body: { message: "Resource not accessible by integration" } } : null) },
  { key: "t", name: "The pull request's answer is lost: GitHub opens it, the answer never comes (Check again finds it)", lose: (req, url) => req.method === "POST" && url.pathname === "/api/repos/busy-app/busy-apps-catalog/pulls" },
  { key: "5", name: "GitHub's rate limit: no requests left for an hour", fail: (req, url) => (api(url) ? { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } } : null) },
  { key: "6", name: "The catalog can't be reached: busy-app/busy-apps-catalog answers 404", fail: (req, url) => (req.method === "GET" && url.pathname === "/api/repos/busy-app/busy-apps-catalog" ? { status: 404, body: { message: "Not Found" } } : null) },
  { key: "7", name: "Half made: the fork and the branch are made, the pull request fails once (Try again opens it)", once: true },
  { key: "8", name: "Out of date: GitHub's commit has other files than the project", fail: (req, url) => (req.method === "GET" && url.pathname.startsWith(`/api/repos/${github.login}/`) && url.pathname.includes("/git/trees/") ? { status: 200, body: { sha: "1".repeat(40), truncated: false, tree: [{ path: "extra.txt", mode: "100644", type: "blob", sha: "2".repeat(40), size: 1 }] } } : null) },
  { key: "c", name: "Close the open pull requests: the next send opens a new one (Pull request sent, not updated)" },
  // Sign commits with (EMU-366): these two are switches of their own, beside the mode chosen.
  { key: "e", name: "Switch whether GitHub CLI's sign-in may read the account's e-mail addresses (the scope user:email; Check again in the window)" },
  { key: "g", name: "Switch GitHub's GH007: a commit signed with any address but the private one is refused" },
];
let gh007 = false;
/** GH007 (EMU-366): GitHub refuses a commit signed with an address the account keeps private (any but its own private one). */
const refusesPrivate = (req, url, body) => (gh007 && req.method === "POST" && /^\/api\/repos\/[^/]+\/[^/]+\/git\/commits$/.test(url.pathname) && !String(body?.author?.email ?? "").endsWith("@users.noreply.github.com") ? { status: 422, body: { message: "GH007: Your push would publish a private email address." } } : null);
/** The chosen mode's failure, after GH007's. */
let modeFail = null;
github.hooks.fail = (req, url, body) => refusesPrivate(req, url, body) ?? modeFail?.(req, url) ?? null;
let mode = MODES[0];
function choose(key) {
  const one = MODES.find((m) => m.key === key);
  if (!one) return false;
  if (one.key === "c") {
    for (const pull of github.pulls) pull.state = "closed";
    console.log("Closed the open pull requests.");
    return true;
  }
  if (one.key === "e") {
    github.account.emailScope = !github.account.emailScope;
    console.log(github.account.emailScope ? "GitHub CLI's sign-in may read the e-mail addresses." : "GitHub CLI's sign-in may not read the e-mail addresses.");
    return true;
  }
  if (one.key === "g") {
    gh007 = !gh007;
    console.log(gh007 ? "GH007 on: a commit signed with a real address is refused." : "GH007 off.");
    return true;
  }
  mode = one;
  github.hooks.hold = one.hold ?? null;
  github.hooks.lose = one.lose ?? null;
  if (one.once) {
    let refused = false;
    modeFail = (req, url) => {
      if (refused || req.method !== "POST" || url.pathname !== "/api/repos/busy-app/busy-apps-catalog/pulls") return null;
      refused = true;
      return { status: 422, body: { message: "Validation Failed", errors: [{ message: "GitHub is busy" }] } };
    };
  } else modeFail = one.fail ?? null;
  console.log(`Now: ${one.name}.`);
  return true;
}
function menu() {
  console.log("\nWhat GitHub does with the next sends (a number, then Enter):");
  for (const one of MODES) console.log(`  ${one.key}  ${one.name}${one === mode ? "  (now)" : ""}`);
}

// ---- the app, then the project

const electron = createRequire(import.meta.url)("electron");
// The terminal's input is the menu's, not the app's.
const child = spawn(electron, [appDir], { stdio: ["ignore", "inherit", "inherit"], env });
const end = () => child.kill();
process.on("SIGINT", end);
process.on("SIGTERM", end);
child.on("exit", (code, signal) => {
  github.close();
  process.exit(code ?? (signal ? 1 : 0));
});

/** The command line on the preview's data folder: its answer (the last line: dev prints its events before it), or null. */
function busy(...args) {
  const run = spawnSync(process.execPath, [cli, ...args, "--json"], { env, encoding: "utf8", timeout: 10 * 60_000 });
  try {
    return JSON.parse(String(run.stdout).trim().split("\n").at(-1));
  } catch {
    return null;
  }
}

async function makeProject() {
  for (let i = 0; i < 120; i++) {
    const status = busy("status");
    if (status?.running && status.answering && status.state === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const dir = path.join(data, "preview-projects", "focus-timer");
  const steps = [
    ["Making the Focus Timer example", () => (existsSync(dir) ? { ok: true } : busy("create", dir, "--example", "focus-timer", "--author", "Preview Person"))],
    ["Running it on the BUSY Bar", () => busy("dev", dir, "--once")],
    ["Writing the catalog's texts", () => busy("catalog-texts", "set", dir, "--category", "productivity", "--short-description", "Focus sessions with breaks, on the front display", "--description", "Focus Timer counts focus sessions and breaks on the BUSY Bar. Start begins a session; the wheel sets its length.", "--changelog", "The first version: focus sessions and breaks.")],
    ["Taking the front screenshot", () => busy("publish", "screenshots", dir, "--take", "front")],
    ["Taking the back screenshot", () => busy("publish", "screenshots", dir, "--take", "back")],
    ["Writing the README", () => busy("publish", "readme", "set", dir, "--mode", "fields", "--intro", "Focus sessions and breaks on the BUSY Bar.", "--controls", JSON.stringify({ Start: "Starts or pauses a session", "Wheel turn": "Sets the length", "Wheel press": "Skips the break", Back: "Leaves the app" }))],
    ["The license, the check and the package", () => busy("publish", "prepare", dir, "--license", "MIT")],
  ];
  for (const [what, run] of steps) {
    process.stdout.write(`${what}… `);
    const answer = run();
    console.log(answer?.ok ? "done" : `failed: ${answer?.message ?? "no answer"}`);
    if (!answer?.ok) return;
  }
  console.log(`\nReady: ${dir}\nIn the window: Publish on Focus Timer, Publish to GitHub (Use ${github.login}), then Send to catalog.`);
}

if (!values["no-project"]) await makeProject();
menu();
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (!choose(line.trim())) console.log("Type one of the numbers, or c.");
  menu();
});
