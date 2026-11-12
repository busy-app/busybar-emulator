// busy-emulator allow-local against a stand-in for the system: what it asks of the management address, what it says,
// and every way it fails. The command line itself against a real server is in emulator/test/server/allow-local.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { main } from "../busy-emulator.mjs";

const ctx = {
  platform: "darwin",
  kind: "release",
  development: false,
  appPath: "/Applications/BUSY Bar Emulator.app",
  version: "1.2.3",
  dataDir: "/Users/you/Library/Application Support/BUSY Bar Emulator",
  runStateFile: "/Users/you/Library/Application Support/BUSY Bar Emulator/run/emulator.json",
  calledAs: ["/Users/you/.busy-emulator/bin/busy-emulator"],
  testLaunch: null,
};
const SELF = "/Users/you/.busy-emulator/bin/busy-emulator";
const READY = { pid: 4242, exe: "/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator", started: 1_000_000, port: 8640, url: "http://127.0.0.1:8640", state: "ready", detail: null };
const KEY = "k".repeat(43);

/** A stand-in for system.mjs: an emulator in `state` (null: none), and a management address that keeps the ports. */
function fakeSystem({ state = READY, probe = { answering: true }, control = { port: 51234, barPort: 8640, key: KEY }, answer = null, ports = [] } = {}) {
  const calls = [];
  const allowed = new Set(ports);
  return {
    calls,
    readRunState: () => (state === null ? { missing: true } : { state }),
    alive: () => state !== null,
    probe: async () => probe,
    processInfo: () => ({ start: 999_500, exe: READY.exe }),
    samePath: (a, b) => a === b,
    readControl: (dataDir) => (calls.push(["readControl", dataDir]), control),
    async localPorts(port, key, method, localPort) {
      calls.push(["localPorts", port, key, method, localPort]);
      if (answer) return answer;
      const extra = method === "DELETE" ? { withdrawn: allowed.delete(localPort) } : {};
      if (method === "POST") allowed.add(localPort);
      return { status: 200, body: JSON.stringify({ ports: [...allowed].sort((a, b) => a - b), ...extra }) };
    },
  };
}

async function run(argv, sys = fakeSystem()) {
  const out = [];
  const err = [];
  const code = await main(["allow-local", ...argv], { ctx, sys, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n"), json: argv.includes("--json") && out.length ? JSON.parse(out.join("\n")) : null, sys };
}

test("a port is allowed, listed and taken back through the management address, with the server's key", async () => {
  const sys = fakeSystem({ ports: [5173] });
  const allowed = await run(["3000", "--json"], sys);
  assert.equal(allowed.code, 0);
  assert.deepEqual(allowed.json, { ok: true, command: "allow-local", action: "allowed", port: 3000, ports: [3000, 5173] });
  assert.deepEqual(sys.calls, [["readControl", ctx.dataDir], ["localPorts", 51234, KEY, "POST", 3000]]);
  assert.deepEqual((await run(["--json"], sys)).json, { ok: true, command: "allow-local", action: "listed", ports: [3000, 5173] });
  assert.deepEqual(sys.calls.at(-1), ["localPorts", 51234, KEY, "GET", null]);
  assert.deepEqual((await run(["--remove", "3000", "--json"], sys)).json, { ok: true, command: "allow-local", action: "removed", port: 3000, was_allowed: true, ports: [5173] });
  assert.deepEqual(sys.calls.at(-1), ["localPorts", 51234, KEY, "DELETE", 3000]);
  assert.deepEqual((await run(["--remove=3000", "--json"], sys)).json.was_allowed, false);
});

test("what a person reads", async () => {
  const sys = fakeSystem();
  assert.equal((await run([], sys)).out, `Apps on the emulated BUSY Bar may reach no port of this computer. Allow one with ${SELF} allow-local <port>.`);
  assert.equal((await run(["3000"], sys)).out, `Apps on the emulated BUSY Bar may reach port 3000 of this computer now, until the emulator quits. Take it back with ${SELF} allow-local --remove 3000.\nAllowed ports: 3000.`);
  assert.equal((await run([], sys)).out, "Apps on the emulated BUSY Bar may reach these ports of this computer: 3000.");
  assert.equal((await run(["--remove", "3000"], sys)).out, "Apps on the emulated BUSY Bar may not reach port 3000 of this computer any more.\nAllowed ports: none.");
  assert.equal((await run(["--remove", "3000"], sys)).out, "Port 3000 was not allowed; nothing changed.\nAllowed ports: none.");
  const help = await main(["help", "allow-local"], { ctx, sys, out: (line) => assert.match(line, /allow-local \[<port>\] \[--remove <port>\] \[--json\]$/), err: assert.fail });
  assert.equal(help, 0);
});

test("a wrong call is told before anything is asked", async () => {
  for (const [args, text] of [[["abc"], /from 1 to 65535, not "abc"/], [["65536"], /from 1 to 65535/], [["80"], /BUSY Bar's own API/], [["--remove", "1.5"], /allow-local --remove takes the number of a port/], [["3000", "--remove", "3000"], /not both/], [["3000", "3001"], /takes no argument "3001"/], [["--remove"], /--remove needs a value/]]) {
    const wrong = await run([...args, "--json"]);
    assert.equal(wrong.code, 2, args.join(" "));
    assert.equal(wrong.json.code, "usage", args.join(" "));
    assert.match(wrong.json.message, text, args.join(" "));
    assert.deepEqual(wrong.sys.calls, [], args.join(" "));
  }
});

test("not running, or not ready: not_running, and the emulator is not started", async () => {
  const none = await run(["3000", "--json"], fakeSystem({ state: null, probe: { answering: false, code: "ECONNREFUSED" } }));
  assert.equal(none.code, 1);
  assert.equal(none.json.code, "not_running");
  assert.equal(none.json.hint, `Start it with ${SELF} start, then run ${SELF} allow-local 3000 again.`);
  assert.deepEqual(none.sys.calls, []);
  const starting = await run(["--remove", "3000", "--json"], fakeSystem({ state: { ...READY, state: "starting" } }));
  assert.equal(starting.json.code, "not_running");
  assert.match(starting.json.message, /its BUSY Bar is not ready: starting/);
  assert.match(starting.json.hint, /allow-local --remove 3000 again/);
});

test("the management address cannot be asked: no_management; a sandbox is named; the emulator's own port is port_refused", async () => {
  const of = async (options) => (await run(["3000", "--json"], fakeSystem(options))).json;
  const missing = await of({ control: { missing: "there is no /data/run/server.lock" } });
  assert.equal(missing.code, "no_management");
  assert.match(missing.message, /there is no \/data\/run\/server\.lock\.$/);
  assert.equal(missing.hint, `Run ${SELF} quit, then ${SELF} start, then ${SELF} allow-local 3000 again.`);
  // The lock of another server than the emulator's: the key goes nowhere.
  const other = await run(["3000", "--json"], fakeSystem({ control: { port: 51234, barPort: 8641, key: KEY } }));
  assert.equal(other.json.code, "no_management");
  assert.equal(other.sys.calls.length, 1);
  assert.equal((await of({ answer: { failed: "ECONNREFUSED" } })).code, "no_management");
  assert.match((await of({ answer: { status: 401, body: '{"error":"Unauthorized"}' } })).message, /did not take the server's key/);
  assert.match((await of({ answer: { status: 200, body: "<html>" } })).message, /it answered 200/);
  assert.equal((await of({ control: { blocked: "EPERM" } })).code, "blocked_file");
  const blocked = await of({ answer: { blocked: "EPERM" } });
  assert.equal(blocked.code, "blocked_network");
  assert.match(blocked.message, /127\.0\.0\.1:51234/);
  const refused = await run(["8640", "--json"], fakeSystem({ answer: { status: 400, body: JSON.stringify({ error: "Port 8640 is the emulator's own bar address; an app on the BUSY Bar may never reach it." }) } }));
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.json, { ok: false, command: "allow-local", code: "port_refused", message: "Port 8640 is the emulator's own bar address; an app on the BUSY Bar may never reach it.", hint: null, port: 8640 });
  // No answer of these shows the key.
  for (const answer of [missing, other.json, blocked, refused.json]) assert.ok(!JSON.stringify(answer).includes(KEY));
});

test("called for the MCP server (ctx.mcp), it refuses before it asks anything: allowing a port is the person's step", async () => {
  const sys = fakeSystem();
  const out = [];
  const code = await main(["allow-local", "3000", "--json"], { ctx: { ...ctx, mcp: true }, sys, out: (line) => out.push(line), err: () => {} });
  const json = JSON.parse(out.join("\n"));
  assert.deepEqual([code, json.ok, json.code], [1, false, "person_only"]);
  assert.match(json.hint, / allow-local <port> in a terminal\.$/);
  assert.deepEqual(sys.calls, [], "nothing asked");
});

test("with the app, the person answers: Don't Allow, no answer, no dialog and another question each say so, and the port stays closed", async () => {
  const reply = (status, body) => fakeSystem({ answer: { status, body: JSON.stringify(body) } });
  const allowed = await run(["5432", "--json"], reply(200, { ports: [5432], allowed: true, asked: true, answer: "allow" }));
  assert.deepEqual(allowed.json, { ok: true, command: "allow-local", action: "allowed", port: 5432, asked: true, ports: [5432] });
  assert.equal(allowed.sys.calls.at(-1)[3], "POST");
  assert.match((await run(["5432"], reply(200, { ports: [5432], allowed: true, asked: true, answer: "allow" }))).out, /^The person allowed it: apps on the emulated BUSY Bar may reach port 5432/);
  const cases = [
    [200, { ports: [], allowed: false, asked: true, answer: "refuse" }, "local_refused", /chose "Don't Allow" for port 5432/],
    [429, { error: "x", retry_after_s: 25 }, "local_refused", /a moment ago/],
    [200, { ports: [], allowed: false, asked: true, answer: "no_answer" }, "local_no_answer", /Nobody answered/],
    [200, { ports: [], allowed: false, asked: true, answer: "unavailable", reason: "the emulator runs hidden and shows no dialog" }, "local_unavailable", /runs hidden/],
    [409, { error: "Another question to the person is open in the emulator (about /x)." }, "local_busy", /Another question/],
  ];
  for (const [status, body, code, said] of cases) {
    const refused = await run(["5432", "--json"], reply(status, body));
    assert.equal(refused.code, 1, code);
    assert.equal(refused.json.code, code);
    assert.match(refused.json.message, said);
  }
});
