// The MCP session of `busy-emulator mcp` without a process (../mcp/protocol.mjs), and the check of the tools'
// arguments (../mcp/tools.mjs): what the server answers, and what it never answers. The server as a process, with
// the real commands: emulator/test/server/mcp.test.mjs.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createSession, LEGACY_VERSIONS } from "../mcp/protocol.mjs";
import { schemaProblem, TOOLS, toolList } from "../mcp/tools.mjs";

function session({ callTool = async () => ({ content: [], isError: false }) } = {}) {
  const sent = [];
  const one = createSession({
    server: { name: "busy-emulator", title: "BUSY Bar Emulator", version: "0.0.0" },
    instructions: "x",
    tools: () => [{ name: "slow", inputSchema: { type: "object" } }],
    callTool,
    resources: () => [],
    readResource: () => null,
    send: (message) => sent.push(message),
  });
  const line = (value) => one.receive(typeof value === "string" ? value : JSON.stringify(value));
  return { one, sent, line };
}

test("initialize: a version it has is answered with that version, another with its latest; ping before it works", async () => {
  for (const [asked, answered] of [["2025-06-18", "2025-06-18"], ["2024-11-05", "2024-11-05"], ["2026-07-28", LEGACY_VERSIONS[0]], ["x", LEGACY_VERSIONS[0]]]) {
    const { one, sent, line } = session();
    line({ jsonrpc: "2.0", id: 0, method: "ping" });
    line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await one.settled();
    assert.deepEqual(sent[0], { jsonrpc: "2.0", id: 0, result: {} });
    assert.equal(sent[1].result.protocolVersion, answered);
    assert.deepEqual(Object.keys(sent[1].result.capabilities).sort(), ["resources", "tools"]);
  }
});

test("notifications are never answered, known or not; a response from the client is dropped", async () => {
  const { one, sent, line } = session();
  line({ jsonrpc: "2.0", method: "notifications/initialized" });
  line({ jsonrpc: "2.0", method: "notifications/whatever", params: { a: 1 } });
  line({ jsonrpc: "2.0", id: 5, result: {} });
  line("");
  line("   \r");
  await one.settled();
  assert.deepEqual(sent, []);
});

test("a request canceled while its tool works gets no answer, and its tool is told to stop; the next one does", async () => {
  let release;
  const signals = [];
  const { one, sent, line } = session({ callTool: (_name, _args, { signal }) => (signals.push(signal), new Promise((resolve) => (release = () => resolve({ content: [], isError: false })))) });
  line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals[0].aborted, false);
  line({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" } });
  assert.equal(signals[0].aborted, true, "the tool's signal aborted: it stops what it started");
  assert.equal(signals[0].reason, "canceled");
  release();
  await one.settled();
  assert.deepEqual(sent.map((message) => message.id), [1]);
  line({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slow" } });
  release();
  await one.settled();
  assert.equal(sent.at(-1).id, 3);
  assert.equal(sent.at(-1).result.isError, false);
  assert.equal(signals[1].aborted, false, "a request answered was never told to stop");
});

test("a tool that throws is an internal error with the request's id, and the session goes on", async () => {
  const { one, sent, line } = session({ callTool: async () => { throw new Error("boom"); } });
  line({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "2025-11-25" } });
  line({ jsonrpc: "2.0", id: "b", method: "tools/call", params: { name: "slow" } });
  line({ jsonrpc: "2.0", id: null, method: "ping" });
  line({ jsonrpc: "2.0", id: "c", method: "ping" });
  await one.settled();
  assert.deepEqual(sent.find((message) => message.id === "b").error, { code: -32603, message: "Internal error: boom" });
  assert.equal(sent.find((message) => message.id === null).error.code, -32600);
  assert.deepEqual(sent.find((message) => message.id === "c").result, {});
});

test("the tools' schemas: names as the specification allows, no tool that trusts, arguments checked as the schema says", () => {
  const names = toolList().map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/);
  assert.ok(!names.some((name) => name.includes("trust")));
  const press = TOOLS.find((tool) => tool.name === "press").inputSchema;
  assert.equal(schemaProblem(press, { key: "ok", times: 2 }), null);
  assert.match(schemaProblem(press, {}), /arguments\.key is missing/);
  assert.match(schemaProblem(press, { key: "ok", times: 0 }), /at least 1/);
  assert.match(schemaProblem(press, { key: "ok", times: 1.5 }), /integer/);
  assert.match(schemaProblem(press, { key: "ok", shell: "rm" }), /has no "shell"/);
  const set = TOOLS.find((tool) => tool.name === "settings_set").inputSchema;
  assert.equal(schemaProblem(set, { values: { hour24: false, minutes: 5, theme: "blue", "place.where": { lat: 1 } } }), null);
  assert.match(schemaProblem(set, { values: {} }), /at least 1/);
  assert.match(schemaProblem(set, { values: { a: [1] } }), /arguments\.values\.a must be/);
});

test("a model's value that starts with \"-\" stays a value: create_app's name, settings_set's keys", async () => {
  const { parseArguments, loadCommands } = await import("../busy-emulator.mjs");
  const commands = await loadCommands();
  const optionsOf = (name) => commands.find((command) => command.name === name)?.options ?? null;
  const env = { ctx: {}, sys: {} };
  const folder = path.resolve("/work/new-app");
  const create = parseArguments(TOOLS.find((tool) => tool.name === "create_app").words({ folder, name: "--help", description: "-x", id: "--json" }, env), optionsOf);
  assert.deepEqual([create.name, create.help, create.json, create.args, create.options, create.unknownOptions, create.optionProblems], ["create", false, false, [folder], { name: "--help", description: "-x", id: "--json" }, [], []]);
  const set = parseArguments(TOOLS.find((tool) => tool.name === "settings_set").words({ app: "app.a.b", restart: true, values: { "--app": "app.other.c", "--restart": 1, plain: "-1" } }, env), optionsOf);
  assert.deepEqual([set.name, set.args, set.options, set.unknownOptions], ["settings", ["set", "--app=app.other.c", "--restart=1", "plain=-1"], { app: "app.a.b", restart: true }, []]);
});
