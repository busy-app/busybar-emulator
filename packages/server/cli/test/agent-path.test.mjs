// The agent's path past stage 1 (agent-path): choosing among GitHub CLI's accounts with publish signin --user, a sign-in
// whose code comes back at once (--no-wait, for MCP), and the MCP tools that do the rest of the window's path:
// publish, catalog_texts, icon, time, record, uninstall. Each tool is the command line's command with the words it
// builds; what a tool may read is less than the command line, never more.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadCommands, main } from "../busy-emulator.mjs";
import { schemaProblem, TOOLS } from "../mcp/tools.mjs";
import { readResource } from "../mcp/resources.mjs";
import { trustProject } from "../../projects/trust.mjs";
import { markChecked } from "../../publish/test/stale-support.mjs";
import { targz } from "../../../../test/package.mjs";

const commands = await loadCommands();
const KEY = "k".repeat(43);
const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };

function setup(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-agent-path-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const ctx = { platform: process.platform, kind: "release", development: false, appPath: "/Applications/BUSY Bar Emulator.app", dataDir, runStateFile: path.join(dataDir, "run", "emulator.json"), calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"], testLaunch: null, env: {} };
  return { root, ctx };
}

function system(root, answers, asked) {
  return {
    cwd: () => root,
    readRunState: () => ({ state: READY }),
    alive: () => true,
    probe: async () => ({ answering: true }),
    // The app's program as lifecycle.mjs expects it on this system (appExecutable: on Windows the app's path itself).
    processInfo: (_pid, platform) => ({ start: 999_500, exe: platform === "win32" ? "/Applications/BUSY Bar Emulator.app" : READY.exe }),
    samePath: (a, b) => a === b,
    readControl: () => ({ port: 51234, barPort: 8640, key: KEY }),
    askGithub: async (port, key, query, waitMs) => (asked.push([query, waitMs]), { status: 200, body: JSON.stringify(answers[query.op](query)) }),
    now: () => 5_000_000,
  };
}

async function call(argv, ctx, sys) {
  const out = [];
  const err = [];
  const code = await main([...argv, "--json"], { ctx, sys, commands, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, json: JSON.parse(out.at(-1)), err: err.join("\n") };
}

test("publish signin with several accounts of GitHub CLI: choose_account lists them; --user takes one, never another; a code at once with --no-wait", async (t) => {
  const { root, ctx } = setup(t);
  const asked = [];
  let state = { signedIn: false, login: null, signing: null };
  const answers = {
    status: () => ({ ok: true, configured: true, ...state, existing: "octo-own", accounts: [{ login: "octo-own", active: true }, { login: "octo-work", active: false }] }),
    "signin-existing": (q) => ((state = { signedIn: true, login: q.login ?? "octo-own", signing: null }), { ok: true, login: q.login ?? "octo-own", origin: "existing" }),
    signin: () => ((state = { ...state, signing: { userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" } }), { ok: true, userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" }),
    "signin-wait": () => ((state = { signedIn: true, login: "octo-new", signing: null }), { ok: true, login: "octo-new", origin: "app", previous: null, kept: "octo-own" }),
    signout: () => ((state = { signedIn: false, login: null, signing: null }), { ok: true, revokePage: "https://github.com/settings/applications" }),
  };
  const sys = system(root, answers, asked);

  const choose = await call(["publish", "signin"], ctx, sys);
  assert.equal(choose.json.code, "choose_account");
  assert.deepEqual(choose.json.accounts.map((one) => one.login), ["octo-own", "octo-work"]);
  assert.match(choose.json.message, /2 accounts: octo-own, octo-work \(it uses octo-own\)/);
  assert.match(choose.json.hint, /--user <login>/);

  assert.equal((await call(["publish", "signin", "--user", "nobody-here"], ctx, sys)).json.code, "no_existing", "an account GitHub CLI does not have");
  assert.equal((await call(["publish", "signin", "--user", "bad login"], ctx, sys)).json.code, "usage");
  assert.equal((await call(["publish", "signin", "--new-account", "--user", "octo-work"], ctx, sys)).json.code, "usage");
  const used = await call(["publish", "signin", "--user", "octo-work"], ctx, sys);
  assert.deepEqual([used.code, used.json.login], [0, "octo-work"]);
  assert.deepEqual(asked.at(-1)[0], { op: "signin-existing", login: "octo-work" }, "the app is told which account, and asks the person");
  const other = await call(["publish", "signin", "--user", "octo-own"], ctx, sys);
  assert.deepEqual([other.json.code, other.json.login], ["signed_in_other", "octo-work"]);
  await call(["publish", "signout"], ctx, sys);

  // A new account: the code at once, the app goes on waiting; signin again waits for it.
  const code = await call(["publish", "signin", "--new-account", "--no-wait"], ctx, sys);
  assert.deepEqual([code.code, code.json.waiting, code.json.userCode], [0, true, "WDJB-MJHT"]);
  assert.equal(asked.at(-1)[0].op, "signin", "no wait asked");
  const again = await call(["publish", "signin", "--no-wait"], ctx, sys);
  assert.deepEqual([again.json.waiting, again.json.userCode], [true, "WDJB-MJHT"], "the same code, no new sign-in");
  const done = await call(["publish", "signin", "--progress"], ctx, sys);
  assert.deepEqual([done.code, done.json.login, done.json.kept], [0, "octo-new", "octo-own"]);
  assert.equal(asked.at(-1)[0].op, "signin-wait");
  assert.match(done.err, /enter the code WDJB-MJHT/);
});

// ---------------------------------------------------------------- the MCP tools

function mcpEnv(t) {
  const { root, ctx } = setup(t);
  const dir = path.join(root, "pomodoro");
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pomodoro", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.you.pomodoro" }));
  trustProject(ctx.dataDir, dir, "created", { platform: ctx.platform });
  const env = { ctx: { ...ctx, mcp: true }, sys: { cwd: () => ctx.dataDir, samePath: (a, b) => a === b } };
  const words = (name, input) => TOOLS.find((tool) => tool.name === name).words(input, env);
  return { root, ctx, dir: realpathSync(dir), env, words };
}

test("MCP: the tools of the rest of the path are there, each a command of the command line", () => {
  const names = TOOLS.map((tool) => tool.name);
  for (const name of ["publish", "catalog_texts", "icon", "time", "record", "uninstall"]) assert.ok(names.includes(name), name);
  const guide = readResource("busy-emulator://guide/start").text;
  for (const want of ["catalog_texts", "`step: \"prepare\"`", "`step: \"pr\"`", "choose_account", "author checklist", "Only the person can"]) assert.ok(guide.includes(want), want);
  assert.doesNotMatch(guide, /are the person's steps\./, "the guide no longer leaves publishing to the person");
});

test("MCP publish: the words of each step, only the options a step takes, a sign-in that answers with its code", (t) => {
  const { dir, words, root } = mcpEnv(t);
  assert.deepEqual(words("publish", { step: "status", folder: dir }), ["publish", "status", dir]);
  assert.deepEqual(words("publish", { step: "readme", folder: dir, readme_action: "set", intro: "A timer.", controls: [{ control: "Start", text: "Starts" }], usage: "More." }), ["publish", "readme", "set", dir, "--intro=A timer.", '--controls=[{"control":"Start","text":"Starts"}]', "--usage=More."]);
  assert.deepEqual(words("publish", { step: "readme", folder: dir }), ["publish", "readme", "get", dir]);
  assert.deepEqual(words("publish", { step: "prepare", folder: dir, license: "MIT", author: "Pat" }), ["publish", "prepare", dir, "--license=MIT", "--author=Pat"]);
  assert.deepEqual(words("publish", { step: "pr", folder: dir, ai: "partly" }), ["publish", "pr", dir, "--ai=partly"]);
  assert.deepEqual(words("publish", { step: "pr", folder: dir, ai: "none", catalog: "busy-app/busy-apps-catalog-dev" }), ["publish", "pr", dir, "--ai=none", "--catalog=busy-app/busy-apps-catalog-dev"], "--catalog stays, for development");
  assert.deepEqual(words("publish", { step: "signin" }), ["publish", "signin", "--no-wait"]);
  assert.deepEqual(words("publish", { step: "signin", wait: true }), ["publish", "signin"]);
  assert.deepEqual(words("publish", { step: "signin", use_existing: true, user: "octo" }), ["publish", "signin", "--use-existing", "--user=octo"]);
  assert.throws(() => words("publish", { step: "signin", folder: dir }), (e) => e.code === "usage");
  assert.throws(() => words("publish", { step: "push" }), (e) => e.code === "usage" && /needs folder/.test(e.message));
  assert.throws(() => words("publish", { step: "status", folder: dir, ai: "none" }), (e) => e.code === "usage" && /takes no ai/.test(e.message));
  // A folder the emulator does not know: refused before the command runs.
  const stranger = path.join(root, "stranger");
  mkdirSync(stranger);
  assert.throws(() => words("publish", { step: "status", folder: stranger }), (e) => e.code === "untrusted_project" || e.code === "not_a_project");
});

test("MCP: a file a tool reads is inside the project (or the screenshot tool's folder), never elsewhere on this computer", (t) => {
  const { dir, words, root, ctx } = mcpEnv(t);
  writeFileSync(path.join(dir, "shot.png"), "x");
  writeFileSync(path.join(root, "secret.png"), "x");
  assert.deepEqual(words("publish", { step: "screenshots", folder: dir, upload: ["shot.png"] }), ["publish", "screenshots", dir, `--upload=${JSON.stringify([path.join(dir, "shot.png")])}`]);
  mkdirSync(path.join(ctx.dataDir, "mcp", "screenshots"), { recursive: true });
  writeFileSync(path.join(ctx.dataDir, "mcp", "screenshots", "front-1.png"), "x");
  assert.equal(words("publish", { step: "screenshots", folder: dir, upload: [path.join(ctx.dataDir, "mcp", "screenshots", "front-1.png")] }).length, 4);
  for (const bad of [path.join(root, "secret.png"), "../secret.png", path.join(dir, "..", "secret.png")]) {
    assert.throws(() => words("publish", { step: "screenshots", folder: dir, upload: [bad] }), (e) => e.code === "usage" && /not inside the project's folder/.test(e.message), bad);
    assert.throws(() => words("icon", { folder: dir, from: bad }), (e) => e.code === "usage", bad);
  }
  assert.deepEqual(words("icon", { folder: dir, text: "PT", force: true }), ["icon", dir, "--text=PT", "--force"]);
});

test("MCP catalog_texts, time, record, uninstall: their commands' words", (t) => {
  const { dir, words, ctx } = mcpEnv(t);
  assert.deepEqual(words("catalog_texts", { folder: dir }), ["catalog-texts", "get", dir]);
  assert.deepEqual(words("catalog_texts", { folder: dir, category: "productivity", short_description: "A timer." }), ["catalog-texts", "set", dir, "--category=productivity", "--short-description=A timer."]);
  assert.deepEqual(words("time", {}), ["time"]);
  assert.deepEqual(words("time", { action: "advance", value: "25m" }), ["time", "advance", "25m"]);
  assert.throws(() => words("time", { action: "set" }), (e) => e.code === "usage");
  assert.throws(() => words("time", { action: "reset", value: "1m" }), (e) => e.code === "usage");
  assert.deepEqual(words("record", { folder: dir, layout: "post", seconds: 3 }), ["record", "--seconds=3", "--layout=post", "--out", `${path.join(dir, "media")}${path.sep}`]);
  assert.deepEqual(words("record", { gif: true }), ["record", "--gif", "--out", `${path.join(ctx.dataDir, "mcp", "media")}${path.sep}`]);
  assert.deepEqual(words("uninstall", { app: "app.you.pomodoro" }), ["uninstall", "app.you.pomodoro"]);
  assert.throws(() => words("uninstall", {}), (e) => e.code === "usage");
  assert.equal(TOOLS.find((tool) => tool.name === "uninstall").inputSchema.properties.delete_files, undefined, "moving files to the Trash is the person's");
});

test("MCP schemas check lists: items, at least and at most", () => {
  const publish = TOOLS.find((tool) => tool.name === "publish").inputSchema;
  assert.equal(schemaProblem(publish, { step: "readme", controls: [{ control: "Back", text: "Exits" }] }), null);
  assert.match(schemaProblem(publish, { step: "readme", controls: [] }), /at least 1/);
  assert.match(schemaProblem(publish, { step: "readme", controls: [{ control: "OK", text: "x" }] }), /controls\[0\]\.control must be one of/);
  assert.match(schemaProblem(publish, { step: "screenshots", upload: "a.png" }), /must be array/);
  assert.match(schemaProblem(publish, { step: "nope" }), /must be one of/);
});

// ---------------------------------------------------------------- busy-cli's own commands and options

/** A project as create leaves it, with busy-cli installed (no real one: the tool runs are recorded). */
function busyProject(root, ctx, name = "pomodoro") {
  const dir = path.join(root, name);
  const cli = path.join(dir, "node_modules", "@busy-app", "cli");
  mkdirSync(path.join(cli, "dist"), { recursive: true });
  mkdirSync(path.join(dir, "src", "appmeta"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
  writeFileSync(path.join(dir, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.you.pomodoro", version: "1.2.0" }));
  writeFileSync(path.join(cli, "package.json"), JSON.stringify({ name: "@busy-app/cli", version: "0.6.0", bin: { "busy-cli": "dist/index.js" } }));
  writeFileSync(path.join(cli, "dist", "index.js"), "");
  trustProject(ctx.dataDir, dir, "created", { platform: ctx.platform });
  return realpathSync(dir);
}

function barSystem(root, { tool = () => ({ code: 0, signal: null, output: "" }), bar = () => ({ status: 200, body: '{"result":"OK"}' }) } = {}) {
  const tools = [];
  const sent = [];
  let now = 5_000_000;
  return {
    tools,
    sent,
    ...system(root, {}, []),
    barGet: async (port, pathname) => (sent.push(["GET", pathname]), bar("GET", pathname, null)),
    barSend: async (port, method, pathname, body = null) => (sent.push([method, pathname, body]), bar(method, pathname, body)),
    barLog: async () => ({ lines: [] }),
    runTool: async (_setup, request) => (tools.push(request), tool(request)),
    now: () => (now += 10),
    sleep: async (ms) => void (now += ms),
  };
}

test("build passes busy-cli build's own options: --no-minify, --bundle, --emit, --out, --tgz-name; and says where the package went", async (t) => {
  const { root, ctx } = setup(t);
  const dir = busyProject(root, ctx);
  const sys = barSystem(dir);
  const built = await call(["build", "--no-minify", "--bundle"], ctx, sys);
  assert.equal(built.code, 0, JSON.stringify(built.json));
  assert.deepEqual(sys.tools.at(-1).args.slice(1), ["build", "--no-minify", "--bundle"]);
  const elsewhere = await call(["build", "--emit", "both", "--out", "out", "--tgz-name", "{id}-{version}.tgz"], ctx, { ...sys, runTool: async (s, request) => (sys.tools.push(request), mkdirSync(path.join(dir, "out"), { recursive: true }), writeFileSync(path.join(dir, "out", "app.you.pomodoro-1.2.0.tgz"), "x"), { code: 0, signal: null, output: "" }) });
  assert.deepEqual(sys.tools.at(-1).args.slice(1), ["build", "--emit", "both", "--out", path.join(dir, "out"), "--tgz-name", "{id}-{version}.tgz"]);
  assert.equal(elsewhere.json.package, path.join(dir, "out", "app.you.pomodoro-1.2.0.tgz"));
  for (const wrong of [["--emit", "zip"], ["--emit", "dir", "--tgz-name", "a.tgz"], ["--tgz-name", "a/b.tgz"], ["--addr", "10.0.4.20"]]) assert.equal((await call(["build", ...wrong], ctx, sys)).json.code, "usage", wrong.join(" "));
  for (const name of ["dev"]) for (const flag of ["--no-minify", "--bundle"]) assert.ok(commands.find((one) => one.name === name).options[flag], `${name} ${flag}`);
});

test("install <file.tgz>: a package from a trusted folder goes up as busy-cli sends it; from another folder, untrusted_package", async (t) => {
  const { root, ctx } = setup(t);
  const dir = busyProject(root, ctx);
  mkdirSync(path.join(dir, "dist"));
  const pack = targz({ "app.you.pomodoro/appmeta/manifest.json": JSON.stringify({ format_version: 1, id: "app.you.pomodoro", name: "Pomodoro", version: "1.2.0", api_version: "0.1.0" }), "app.you.pomodoro/scripts/main.js": "draw();\n" });
  writeFileSync(path.join(dir, "dist", "app.you.pomodoro.tgz"), pack);
  const away = path.join(root, "downloads");
  mkdirSync(away);
  writeFileSync(path.join(away, "someone.tgz"), pack);
  const sys = barSystem(root, { bar: (method, pathname) => (pathname === "/api/apps/stage" ? { status: 200, body: JSON.stringify({ result: "OK", install_key: "k1", staged: { id: "app.you.pomodoro", version: "1.2.0" } }) } : { status: 200, body: '{"result":"OK"}' }) });
  const refused = await call(["install", path.join(away, "someone.tgz")], ctx, sys);
  assert.deepEqual([refused.json.code, refused.json.folder], ["untrusted_package", away]);
  assert.match(refused.json.hint, / trust /);
  // A link in the trusted project to a package outside it: the folder that counts is the one the package lies in.
  let linked = true;
  try {
    symlinkSync(path.join(away, "someone.tgz"), path.join(dir, "dist", "linked.tgz"));
    symlinkSync(away, path.join(dir, "elsewhere"));
  } catch {
    linked = false; // Windows without the right to make links
  }
  if (linked) {
    for (const through of [path.join(dir, "dist", "linked.tgz"), path.join(dir, "elsewhere", "someone.tgz")]) {
      const out = await call(["install", through], ctx, sys);
      assert.deepEqual([out.json.code, out.json.folder], ["untrusted_package", away], through);
    }
  }
  assert.equal(sys.sent.length, 0, "nothing sent");
  const done = await call(["install", path.join(dir, "dist", "app.you.pomodoro.tgz")], ctx, sys);
  assert.equal(done.code, 0, JSON.stringify(done.json));
  assert.equal(done.json.id, "app.you.pomodoro");
  assert.deepEqual(sys.sent.map(([method, pathname]) => `${method} ${pathname}`), ["POST /api/apps/stage", "POST /api/apps/install?install_key=k1"]);
  assert.deepEqual(Buffer.from(sys.sent[0][2]), pack, "the package's bytes");
  assert.equal((await call(["install", path.join(dir, "nothing.tgz")], ctx, sys)).json.code, "not_found");
  // A package the bar would not take is refused before anything is sent, with its reason.
  writeFileSync(path.join(dir, "dist", "broken.tgz"), Buffer.from([1, 2, 3]));
  writeFileSync(path.join(dir, "dist", "escapes.tgz"), targz({ "../evil.js": "x" }));
  sys.sent.length = 0;
  assert.equal((await call(["install", path.join(dir, "dist", "broken.tgz")], ctx, sys)).json.code, "broken_package");
  assert.equal((await call(["install", path.join(dir, "dist", "escapes.tgz")], ctx, sys)).json.code, "unsafe_path");
  assert.equal(sys.sent.length, 0, "nothing sent");
});

test("install <file.tgz> --check: what app a package holds, from any folder, with nothing installed; its refusals", async (t) => {
  const { root, ctx } = setup(t);
  const away = path.join(root, "downloads");
  mkdirSync(away);
  writeFileSync(path.join(away, "clock.tgz"), targz({ "._app.you.clock": "x", "app.you.clock/appmeta/manifest.json": JSON.stringify({ format_version: 1, id: "app.you.clock", name: "Clock", version: "2.0.1", api_version: "0.1.0" }), "app.you.clock/scripts/main.js": "x" }));
  writeFileSync(path.join(away, "bad.tgz"), targz({ "app.you.clock/appmeta/manifest.json": JSON.stringify({ format_version: 1, id: "app.you.clock", name: "Clock", version: "2", api_version: "0.1.0" }), "app.you.clock/scripts/main.js": "x" }));
  const sys = barSystem(root);
  const seen = await call(["install", path.join(away, "clock.tgz"), "--check"], ctx, sys);
  assert.equal(seen.code, 0, JSON.stringify(seen.json));
  assert.deepEqual([seen.json.id, seen.json.name, seen.json.version, seen.json.api_version, seen.json.installed], ["app.you.clock", "Clock", "2.0.1", "0.1.0", false]);
  assert.equal(seen.json.notes.length, 1, "the ._ file noted");
  const bad = await call(["install", path.join(away, "bad.tgz"), "--check"], ctx, sys);
  assert.deepEqual([bad.json.code, bad.json.file], ["bad_manifest", path.join(away, "bad.tgz")]);
  assert.equal((await call(["install", away, "--check"], ctx, sys)).json.code, "usage");
  assert.equal(sys.sent.length, 0, "nothing sent");
});

test("run <app-id>: an app the bar has, started by its id with no project; one it has not is not_installed", async (t) => {
  const { root, ctx } = setup(t);
  const sys = barSystem(root, { bar: (method, pathname) => (pathname.includes("app.you.gone") ? { status: 404, body: '{"error":"Not Found"}' } : { status: 200, body: '{"result":"OK"}' }) });
  const started = await call(["run", "app.you.pomodoro"], ctx, sys);
  assert.equal(started.code, 0, JSON.stringify(started.json));
  assert.deepEqual(sys.sent.at(-1).slice(0, 2), ["POST", "/api/apps/launch?app_id=app.you.pomodoro"]);
  assert.equal((await call(["run", "app.you.gone"], ctx, sys)).json.code, "not_installed");
});

test("create --no-git goes to the generator; a project without a repository says that none was made", async (t) => {
  const { root, ctx } = setup(t);
  const target = path.join(root, "pomodoro");
  let n = 0;
  const seen = [];
  const sys = barSystem(root, {
    tool(request) {
      n += 1;
      seen.push(request.args);
      if (n === 1) {
        const pkg = path.join(request.cwd, "node_modules", "@busy-app", "create-app");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.5.0", bin: { "create-app": "dist/index.js" } }));
      } else if (n === 2) {
        mkdirSync(path.join(target, "src", "appmeta"), { recursive: true });
        writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "x", author: "X", devDependencies: { "@busy-app/cli": "^0.6.0" } }));
        writeFileSync(path.join(target, "src", "appmeta", "manifest.json"), JSON.stringify({ id: "app.x.pomodoro", name: "Pomodoro" }));
      } else {
        const cli = path.join(target, "node_modules", "@busy-app", "cli");
        mkdirSync(path.join(cli, "dist"), { recursive: true });
        writeFileSync(path.join(cli, "package.json"), JSON.stringify({ bin: { "busy-cli": "dist/index.js" } }));
        writeFileSync(path.join(cli, "dist", "index.js"), "");
      }
      return { code: 0, signal: null, output: "" };
    },
  });
  const made = await call(["create", target, "--author", "X", "--no-git"], ctx, sys);
  assert.equal(made.code, 0, JSON.stringify(made.json));
  assert.ok(seen[1].includes("--no-git"), seen[1].join(" "));
  assert.equal(made.json.git, false);
  assert.equal(seen.length, 3);
});

test("create --id with an id the catalog refuses is a wrong call before anything is made", async (t) => {
  const { root, ctx } = setup(t);
  const sys = barSystem(root);
  const refused = await call(["create", path.join(root, "pomodoro"), "--id", "pomodoro"], ctx, sys);
  assert.deepEqual([refused.code, refused.json.code], [2, "usage"]);
  assert.match(refused.json.message, /0 dot\(s\), an id needs at least two/);
  assert.deepEqual(sys.tools, [], "nothing ran");
});

test("publish push says how far the upload is, from what the app's job says while it works; MCP passes the lines on as progress", async (t) => {
  const { root, ctx } = setup(t);
  const dir = busyProject(root, ctx);
  // Checked and packaged as it is (stale-check): push and pr refuse a project that is not.
  await markChecked(dir);
  const asked = [];
  let polls = 0;
  let finish;
  const facts = [
    { state: "running", line: "Creating the repository github.com/octo/pomodoro", upload: null },
    { state: "running", line: "Uploading 3 files", upload: { phase: "upload", done: 1, total: 3, bytes: 2048, totalBytes: 4096, known: 2, file: "src/main.ts" } },
    { state: "running", line: "Uploading 3 files", upload: { phase: "check", done: 3, total: 3, bytes: 4096, totalBytes: 4096, known: 2, file: null } },
  ];
  const sys = {
    ...system(root, {}, asked),
    askGithub: async (port, key, query, waitMs) => {
      asked.push([query, waitMs]);
      if (query.op === "status") {
        const now = facts[Math.min(polls++, facts.length - 1)];
        if (polls === facts.length + 1) finish();
        return { status: 200, body: JSON.stringify({ ok: true, configured: true, signedIn: true, login: "octo", progress: now }) };
      }
      await new Promise((resolve) => (finish = resolve));
      return { status: 200, body: JSON.stringify({ ok: true, owner: "octo", name: "pomodoro", page: "https://github.com/octo/pomodoro", commit: "a".repeat(40), files: 3, uploaded: 1, created: true, unchanged: false }) };
    },
  };
  const pushed = await call(["publish", "push", dir, "--progress"], ctx, sys);
  assert.equal(pushed.code, 0, JSON.stringify(pushed.json));
  assert.deepEqual(asked.find(([q]) => q.op === "status")[0], { op: "status", folder: dir });
  assert.match(pushed.err, /Creating the repository github\.com\/octo\/pomodoro/);
  assert.match(pushed.err, /Uploading 1 of 3 files \(2 KB of 4 KB\), 2 GitHub has already: src\/main\.ts/);
  assert.match(pushed.err, /Reading the files back from GitHub/);
});

test("MCP: a tools/call with a progress token gets the command's lines as notifications/progress", async () => {
  const { createSession } = await import("../mcp/protocol.mjs");
  const sent = [];
  const session = createSession({
    server: { name: "busy-emulator", title: "t", version: "0" },
    instructions: "x",
    tools: () => [{ name: "publish", inputSchema: { type: "object" } }],
    callTool: async (_name, _args, { progress }) => (progress?.("Uploading 1 of 3 files"), { content: [], isError: false }),
    resources: () => [],
    readResource: () => null,
    send: (message) => sent.push(message),
  });
  session.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
  session.receive(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "publish", arguments: {}, _meta: { progressToken: "p1" } } }));
  session.receive(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "publish", arguments: {} } }));
  await session.settled();
  const notes = sent.filter((one) => one.method === "notifications/progress");
  assert.deepEqual(notes, [{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p1", progress: 1, message: "Uploading 1 of 3 files" } }], "only for the call that asked");
});

test("MCP update: checking reads only; install is marked destructive, and on Windows it is refused before it asks anything", (t) => {
  const { ctx } = setup(t);
  const env = { ctx: { ...ctx, mcp: true } };
  const tool = TOOLS.find((one) => one.name === "update");
  assert.equal(tool.annotations.destructiveHint, true);
  assert.deepEqual(tool.words({}, { ...env, ctx: { ...env.ctx, platform: "win32" } }), ["update", "--check"]);
  assert.deepEqual(tool.words({ install: true }, { ...env, ctx: { ...env.ctx, platform: "darwin" } }), ["update"]);
  assert.throws(() => tool.words({ install: true }, { ...env, ctx: { ...env.ctx, platform: "win32" } }), (e) => e.code === "update_from_window" && /end this agent session, then click Update/.test(e.hint));
});
