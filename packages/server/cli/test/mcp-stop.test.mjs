// A tool of `busy-emulator mcp` that hangs (finding C5 of the audit): it is stopped after its time with every program it
// started, its grandchild too, the session keeps answering meanwhile, the tools that only read do not wait behind
// it, and a canceled request stops its programs. The tools' commands are stand-ins here; the programs they start are
// real, started by projects/node-tools.mjs as the real commands start npm and busy-cli.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { createSession } from "../mcp/protocol.mjs";
import { toolList, toolRunner, TOOLS } from "../mcp/tools.mjs";
import { CliError } from "../output.mjs";
import { nodeToolsAt, runNodeTool } from "../../projects/node-tools.mjs";
import { alive, gone, hangingTool, personEnvironment, pidsIn, poisonedFolder } from "../../projects/test/test-support.mjs";

const folders = [];
function temporary() {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-mcp-stop-")));
  folders.push(folder);
  return folder;
}
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

/**
 * A session with the real tools and runner, whose `start` stands for a command that starts a program which hangs
 * (and starts one more), and whose other tools answer at once with the words they were given.
 */
function setup({ timeouts = {} } = {}) {
  const folder = temporary();
  const home = path.join(folder, "home");
  mkdirSync(home);
  const tools = { tools: nodeToolsAt({ platform: process.platform, resourcesDir: null, execPath: process.execPath }), dataDir: path.join(folder, "data"), platform: process.platform, env: personEnvironment(home, poisonedFolder(folder)), windowsDir: process.env.SystemRoot ?? null };
  const runs = [];
  let started = 0;
  const env = {
    ctx: { dataDir: folder },
    sys: { runTool: (_setup, request) => runNodeTool(tools, request) },
    commands: [],
    main: async (words, { sys, answer }) => {
      if (words[0] !== "start") return answer({ ok: true, command: words[0], data: { words }, text: `${words[0]}: done.` });
      const pids = path.join(folder, `pids-${started++}.json`);
      const running = sys.runTool(null, { tool: "node", args: [hangingTool(folder, pids)], cwd: folder });
      runs.push({ pids, running });
      const run = await running;
      return answer({ ok: false, command: "start", error: new CliError("interrupted", `stopped (${run.signal})`) });
    },
  };
  const sent = [];
  const one = createSession({
    server: { name: "busy-emulator", title: "BUSY Bar Emulator", version: "0.0.0" },
    instructions: "x",
    tools: toolList,
    callTool: toolRunner(env, { timeoutOf: (tool) => timeouts[tool.name] ?? 60_000, stopWait: 3000 }),
    resources: () => [],
    readResource: () => null,
    send: (message) => sent.push(message),
  });
  const line = (value) => one.receive(JSON.stringify(value));
  line({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  const answered = (id) => sent.find((message) => message.id === id);
  const until = async (what, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 50))) if (what()) return;
    assert.fail("waited too long");
  };
  return { one, sent, line, runs, answered, until };
}

test("every tool has a time of its own: seconds for those that read, minutes for those that build and install", () => {
  const time = (name, input = {}) => {
    const tool = TOOLS.find((one) => one.name === name);
    return typeof tool.timeout === "function" ? tool.timeout(input) : tool.timeout;
  };
  for (const tool of TOOLS) assert.ok(Number.isFinite(time(tool.name, { key: "ok" })) && time(tool.name, { key: "ok" }) > 0, tool.name);
  for (const name of ["status", "logs", "projects"]) assert.ok(time(name) <= 60_000, name);
  for (const name of ["build", "refresh", "create_app", "typecheck"]) assert.ok(time(name) >= 10 * 60_000, name);
  assert.ok(time("create_app") > time("build"));
  assert.ok(time("press", { key: "ok", times: 100, hold_ms: 10_000 }) > 100 * 10_000, "a press of a hundred holds has time for them");
  assert.deepEqual(TOOLS.filter((tool) => tool.parallel).map((tool) => tool.name), ["status", "list_examples", "projects", "logs", "screenshot", "settings_get"]);
});

test("a tool that hangs is stopped after its time with its program and that program's own; the session answers meanwhile, and what reads does not wait", async () => {
  const { one, line, runs, answered, until } = setup({ timeouts: { start: 2500 } });
  line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start", arguments: {} } });
  await until(() => runs.length === 1);
  const { child, grandchild } = await pidsIn(runs[0].pids);
  // While it hangs: the session answers, a tool that changes something waits its turn, the ones that read do not.
  line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "press", arguments: { key: "ok" } } });
  line({ jsonrpc: "2.0", id: 3, method: "ping" });
  line({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status", arguments: {} } });
  line({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "logs", arguments: { lines: 5 } } });
  line({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "screenshot", arguments: {} } });
  await until(() => answered(3) && answered(4) && answered(5) && answered(6));
  assert.equal(answered(1), undefined, "start still hangs");
  assert.equal(answered(2), undefined, "press waits behind it");
  assert.ok(alive(child) && alive(grandchild));
  assert.deepEqual(answered(4).result.structuredContent, { ok: true, command: "status", words: ["status", "--json"] });
  assert.equal(answered(5).result.isError, false);
  // Its time is up: stopped, with both programs, and the queue goes on.
  await until(() => answered(1));
  const stopped = answered(1).result;
  assert.equal(stopped.isError, true);
  assert.deepEqual([stopped.structuredContent.code, stopped.structuredContent.timeout_s], ["tool_timeout", 2.5]);
  assert.match(stopped.content[0].text, /start did not end in 2\.5 s: it was stopped, with the programs it had started/);
  assert.ok(await gone(child), `the hanging program (${child}) is gone`);
  assert.ok(await gone(grandchild), `the program it started (${grandchild}) is gone`);
  await until(() => answered(2));
  assert.equal(answered(2).result.isError, false, "the press that waited ran");
  await one.settled();
});

test("a canceled tool's programs are stopped, its answer dropped; a canceled one still in the queue never starts", async () => {
  const { one, sent, line, runs, answered, until } = setup();
  line({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start", arguments: {} } });
  line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "start", arguments: {} } });
  await until(() => runs.length === 1);
  const { child, grandchild } = await pidsIn(runs[0].pids);
  line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "changed my mind" } });
  line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "too slow" } });
  const at = Date.now();
  assert.ok(await gone(child), `the canceled tool's program (${child}) is gone`);
  assert.ok(await gone(grandchild), `the program it started (${grandchild}) is gone`);
  assert.ok(Date.now() - at < 10_000);
  const run = await runs[0].running;
  assert.equal(run.aborted, true);
  line({ jsonrpc: "2.0", id: 3, method: "ping" });
  await one.settled();
  await until(() => answered(3));
  assert.deepEqual(sent.map((message) => message.id), [0, 3], "neither canceled request is answered");
  assert.equal(runs.length, 1, "the second start, canceled while it waited, started nothing");
});
