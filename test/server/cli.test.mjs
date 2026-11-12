// The command line (packages/server/index.mjs): its flags, the environment, and the lines it prints, which other
// tools read.
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";

import { finish, get, installApp, knownPort, node, port, request, serverDir, serverModule, tempDir, until } from "./helpers.mjs";

after(finish);

const entry = serverModule("index.mjs");
// The commit a firmware's build says it was made from, read here from the build itself.
const commit = (name) => JSON.parse(readFileSync(join(serverDir, "..", "engine", "build", name, "build-info.json"), "utf8")).firmware;

/**
 * Runs the command line. Resolves when it has printed its five start-up lines, or has ended: { child, lines (of
 * stdout), stderr(), port, messages (what it sent over the channel, with `channel`), exited(ms): Promise<code> }. The
 * process is ended when the test is over, however the test ends.
 */
async function run(t, args, { env = {}, script = entry, channel = false } = {}) {
  // The environment of the test itself must not name a firmware.
  const { EMU_FIRMWARE: _ignored, ...clean } = process.env;
  const child = node(t, [script, ...args], { env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe", ...(channel ? ["ipc"] : [])] });
  let out = "";
  let err = "";
  const messages = [];
  child.stdout.setEncoding("utf8").on("data", (text) => (out += text));
  child.stderr.setEncoding("utf8").on("data", (text) => (err += text));
  // Each message with what the server said to a request made the moment the message came.
  if (channel) child.on("message", (message) => messages.push({ message, answer: get(`${message.url}/api/version`).then((r) => r.status, (e) => e.code) }));
  const lines = () => out.split(/\r?\n/).slice(0, -1);
  let ended = false;
  child.exit.then(() => (ended = true));
  await until("the start-up lines, or the end of the process", () => lines().length >= 5 || ended, 30000);
  const address = /^BUSY Bar emulator: http:\/\/127\.0\.0\.1:(\d+) /.exec(lines()[0] ?? "");
  return { child, lines, stderr: () => err, port: address ? Number(address[1]) : null, messages, exited: child.exited };
}

/** The five lines as the command line prints them: the four it has always printed, the management address second. */
function startupLines({ port, control, api, firmware, dataDir, fast = false }) {
  return [
    `BUSY Bar emulator: http://127.0.0.1:${port}  (API ${api}, firmware ${firmware} ${commit(firmware)}, data ${dataDir})`,
    `Management: http://127.0.0.1:${control}  (for programs that send the server's key, from ${join(dataDir, "key")})`,
    `Window: http://127.0.0.1:${port}/emulator`,
    fast ? "Apps run at this computer's speed (--fast); on a BUSY Bar they will be much slower" : "Apps run at BUSY Bar speed: their JS takes the time it would take on a BUSY Bar (--fast to turn off)",
    `From an app folder: npx busy-cli app install --addr 127.0.0.1:${port}, then npx busy-cli app run --addr 127.0.0.1:${port}`,
  ];
}

async function expectServer(cli, { firmware, dataDir, fast = false }) {
  assert.ok(cli.port, `no start-up line; stderr: ${cli.stderr()}`);
  if (port(0)) assert.equal(cli.port, port(0));
  const base = `http://127.0.0.1:${cli.port}`;
  const api = (await get(`${base}/api/version`)).json().api_semver;
  const control = Number(/^Management: http:\/\/127\.0\.0\.1:(\d+) /.exec(cli.lines()[1] ?? "")?.[1]);
  assert.ok(control > 0 && control !== cli.port, cli.lines()[1]);
  assert.deepEqual(cli.lines().slice(0, 5), startupLines({ port: cli.port, control, api, firmware, dataDir, fast }));
  assert.equal(cli.stderr(), "");
  const answered = (await get(`${base}/api/status/firmware`)).json();
  assert.equal(answered.version, firmware);
  assert.equal(answered.commit_hash, commit(firmware));
  return base;
}

test("--port and --data: the default firmware at bar speed, the five start-up lines, the BUSY Bar's log with the time", async (t) => {
  const dataDir = tempDir(t);
  const cli = await run(t, ["--port", String(port(0)), "--data", dataDir]);
  const base = await expectServer(cli, { firmware: "1.3.1", dataDir });
  // What happens on the bar is printed with the time of day in front.
  await installApp(base, "app.test.cli", "setInterval(function () {}, 1000);");
  await until("the log line", () => cli.lines().length > 5);
  assert.match(cli.lines()[5], /^\d\d:\d\d:\d\d Installed app\.test\.cli 0\.1\.0$/);
  assert.ok(existsSync(join(dataDir, "bar", "1.3.1", "ext", "user_assets", "app.test.cli")));
});

test("--firmware, --fast and --verbose", async (t) => {
  const dataDir = tempDir(t);
  const cli = await run(t, ["--verbose", "--fast", "--firmware", "dev", "--data", dataDir, "--port", String(port(0))]);
  const base = await expectServer(cli, { firmware: "dev", dataDir, fast: true });
  // --verbose: a request the emulator has no answer for is printed.
  assert.equal((await get(`${base}/api/no/such/thing?x=1`)).status, 404);
  await until("the verbose line", () => cli.lines().length > 5);
  assert.match(cli.lines()[5], /^\d\d:\d\d:\d\d \? GET \/api\/no\/such\/thing\?x=1$/);
  // And one the bar refuses with 405: a method no handler takes there (EMU-232).
  assert.equal((await request("POST", `${base}/api/no/such/thing`)).status, 405);
  await until("the second verbose line", () => cli.lines().length > 6);
  assert.match(cli.lines()[6], /^\d\d:\d\d:\d\d \? POST \/api\/no\/such\/thing$/);
});

test("without --verbose such a request is not printed", async (t) => {
  const dataDir = tempDir(t);
  const cli = await run(t, ["--port", String(port(0)), "--data", dataDir]);
  const base = await expectServer(cli, { firmware: "1.3.1", dataDir });
  assert.equal((await get(`${base}/api/no/such/thing`)).status, 404);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(cli.lines().length, 5);
});

test("EMU_FIRMWARE names the firmware, and --firmware goes before it", async (t) => {
  const dataDir = tempDir(t);
  const fromEnvironment = await run(t, ["--port", String(port(0)), "--data", dataDir], { env: { EMU_FIRMWARE: "dev" } });
  await expectServer(fromEnvironment, { firmware: "dev", dataDir });
  fromEnvironment.child.kill();
  await fromEnvironment.child.exit;
  const fromFlag = await run(t, ["--port", String(port(0)), "--data", dataDir, "--firmware", "1.3.1"], { env: { EMU_FIRMWARE: "dev" } });
  await expectServer(fromFlag, { firmware: "1.3.1", dataDir });
});

test("run through a symbolic link it behaves the same", async (t) => {
  const dataDir = tempDir(t);
  const link = join(tempDir(t), "emulator-server.mjs");
  try {
    symlinkSync(entry, link);
  } catch (e) {
    return t.skip(`cannot make a symbolic link here: ${e.code}`);
  }
  const cli = await run(t, ["--port", String(port(0)), "--data", dataDir, "--firmware", "dev"], { script: link });
  await expectServer(cli, { firmware: "dev", dataDir });
});

test("a port in use: one line that says so, exit code 1, and the process ends by itself", async (t) => {
  const other = net.createServer();
  await new Promise((resolve, reject) => other.once("error", reject).listen(port(0), "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const taken = other.address().port;
  const dataDir = join(tempDir(t), "data");
  const cli = await run(t, ["--port", String(taken), "--data", dataDir]);
  assert.equal(await cli.exited(), 1);
  assert.equal(cli.stderr(), `Port ${taken} on 127.0.0.1 is in use: another emulator or another program listens on it. Stop it, or start this one on another port.\n`);
  assert.deepEqual(cli.lines(), []);
  assert.ok(!existsSync(dataDir), "no data folder is made");
});

test("an unknown firmware and a port that is not a number: a line that says so and exit code 1", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const unknown = await run(t, ["--port", String(port(0)), "--data", dataDir, "--firmware", "no-such-firmware"]);
  assert.equal(await unknown.exited(), 1);
  assert.equal(unknown.stderr(), 'Unknown firmware "no-such-firmware". The emulator has: 1.3.1, dev (emulator/packages/engine/firmware.json).\n');
  // --verbose adds where it failed.
  const verbose = await run(t, ["--port", String(port(0)), "--data", dataDir, "--firmware", "no-such-firmware", "--verbose"]);
  assert.equal(await verbose.exited(), 1);
  assert.match(verbose.stderr(), /^FirmwareError: Unknown firmware "no-such-firmware"\. .*\n    at loadFirmware \(/);
  const fromEnvironment = await run(t, ["--port", String(port(0)), "--data", dataDir], { env: { EMU_FIRMWARE: "no-such-firmware" } });
  assert.equal(await fromEnvironment.exited(), 1);
  assert.match(fromEnvironment.stderr(), /^Unknown firmware "no-such-firmware"/);
  const badPort = await run(t, ["--port", "eighty", "--data", dataDir]);
  assert.equal(await badPort.exited(), 1);
  assert.equal(badPort.stderr(), "The port must be a whole number from 0 to 65535, not NaN\n");
  assert.ok(!existsSync(dataDir), "no data folder is made");
});

// What a program that starts the emulator and waits for it can rely on (README, "Readiness").
test("ready: the first line of stdout and, over a channel, one message; from then on a request is answered", async (t) => {
  const dataDir = tempDir(t);
  // Asked for a free port: the line and the message are where the port is named.
  const cli = await run(t, ["--port", String(port(0)), "--data", dataDir, "--firmware", "dev", "--fast"], { channel: true });
  const base = await expectServer(cli, { firmware: "dev", dataDir, fast: true });
  assert.equal(cli.messages.length, 1);
  const api = (await get(`${base}/api/version`)).json().api_semver;
  const { controlPort, controlUrl, ...rest } = cli.messages[0].message;
  assert.deepEqual(rest, { type: "ready", port: cli.port, url: base, firmware: "dev", apiVersion: api, dataDir, barSpeed: false });
  assert.equal(controlUrl, `http://127.0.0.1:${controlPort}`);
  assert.ok(cli.lines()[1].startsWith(`Management: ${controlUrl}  `));
  assert.equal(await cli.messages[0].answer, 200, "the request made when the message came was answered");
  // Nothing more is sent.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(cli.messages.length, 1);
});

test("while the command line starts, a connection is closed without an answer, not kept until the server is ready", async (t) => {
  const dataDir = tempDir(t);
  const wanted = await knownPort(0);
  const { EMU_FIRMWARE: _ignored, ...clean } = process.env;
  const child = node(t, [entry, "--port", String(wanted), "--data", dataDir], { env: clean, stdio: ["ignore", "pipe", "pipe"] });
  let ready = false;
  child.stdout.once("data", () => (ready = true));
  // One connection after another from the moment the process is started. A new process compiles the runtime, a
  // fraction of a second with the port already taken: connections made then are closed as soon as it is done.
  const attempt = () =>
    new Promise((resolve) => {
      const socket = net.connect(wanted, "127.0.0.1", () => socket.write(`GET /api/version HTTP/1.1\r\nHost: localhost:${wanted}\r\nConnection: close\r\n\r\n`));
      let answer = "";
      socket.on("data", (chunk) => (answer += chunk));
      socket.on("error", (error) => resolve(error.code === "ECONNREFUSED" ? "refused" : "closed"));
      socket.on("close", () => resolve(answer.startsWith("HTTP/1.1 200") ? "answered" : "closed"));
    });
  const seen = { refused: 0, closed: 0, answered: 0 };
  const deadline = Date.now() + 60000;
  while (!ready && Date.now() < deadline) seen[await attempt()]++;
  assert.ok(ready, `the first line came; stderr: ${child.stderr.read() ?? ""}`);
  assert.equal(await attempt(), "answered");
  t.diagnostic(`before the first line: ${seen.refused} connections refused, ${seen.closed} closed without an answer, ${seen.answered} answered`);
  // A connection kept until the server was ready would have been answered then, and none would have been closed.
  // (On Windows a refused connection is tried again for half a second, and the whole start can pass meanwhile.)
  if (process.platform !== "win32" || seen.closed) assert.ok(seen.closed > 0, "at least one connection was closed without an answer");
  // At most the connection that was on its way when the server became ready is answered before the line is seen.
  assert.ok(seen.answered <= 1, JSON.stringify(seen));
});

test("the first line of stdout is not there before the server answers", async (t) => {
  const dataDir = tempDir(t);
  const wanted = await knownPort(0);
  const { EMU_FIRMWARE: _ignored, ...clean } = process.env;
  const child = node(t, [entry, "--port", String(wanted), "--data", dataDir], { env: clean, stdio: ["ignore", "pipe", "pipe"] });
  // A request the moment the first bytes of stdout come: answered, with no second try.
  const [first] = await once(child.stdout, "data");
  const answer = await get(`http://127.0.0.1:${wanted}/api/version`).then((r) => r.status, (e) => e.code);
  assert.match(String(first), new RegExp(`^BUSY Bar emulator: http://127\\.0\\.0\\.1:${wanted} `));
  assert.equal(answer, 200);
});

test("a start that fails says nothing on stdout and sends no message, with a channel too", async (t) => {
  const dataDir = join(tempDir(t), "data");
  const cli = await run(t, ["--port", String(port(0)), "--data", dataDir, "--firmware", "no-such-firmware"], { channel: true });
  // The channel does not keep the process running.
  assert.equal(await cli.exited(), 1);
  assert.deepEqual(cli.lines(), []);
  assert.deepEqual(cli.messages, []);
  assert.match(cli.stderr(), /^Unknown firmware "no-such-firmware"/);
});

test("a data folder that cannot be used: one line that says what is wrong and what to do, exit code 1", async (t) => {
  const file = join(tempDir(t), "a-file");
  writeFileSync(file, "not a folder");
  const cli = await run(t, ["--port", String(port(0)), "--data", file]);
  assert.equal(await cli.exited(), 1);
  assert.equal(cli.stderr(), `The data folder ${file} cannot be used: a file stands where one of its folders should be. Name another folder, or put this one right.\n`);
  assert.deepEqual(cli.lines(), []);
});

// The bar speaks while it starts — of an app it put back, of the data folder's volume — and its log goes to stdout
// like the start-up lines. A program that takes the port from the first line must still find it there.
test("what the BUSY Bar says while it starts comes after the start-up lines, with the time it was said", async (t) => {
  // An install that did not finish left the version it was replacing aside (js_app_installer/replaced): the bar puts
  // it back when it starts, and says so.
  const dataDir = tempDir(t);
  const aside = join(dataDir, "bar", "1.3.1", "ext", "apps_data", "js_app_installer", "replaced");
  mkdirSync(join(aside, "appmeta"), { recursive: true });
  mkdirSync(join(aside, "scripts"));
  writeFileSync(join(aside, "appmeta", "manifest.json"), JSON.stringify({ format_version: 1, id: "app.f.back", name: "Back", version: "0.1.0", api_version: "27.0.0" }));
  writeFileSync(join(aside, "scripts", "main.js"), "setInterval(function () {}, 1000);");
  const cli = await run(t, ["--port", String(port(0)), "--data", dataDir]);
  await expectServer(cli, { firmware: "1.3.1", dataDir });
  await until("the BUSY Bar's line", () => cli.lines().length > 5);
  assert.match(cli.lines()[0], /^BUSY Bar emulator: http:\/\/127\.0\.0\.1:\d+ /);
  assert.match(cli.lines()[5], /^\d\d:\d\d:\d\d Put app\.f\.back 0\.1\.0 back: an install that did not finish had moved it aside$/);
  assert.ok(existsSync(join(dataDir, "bar", "1.3.1", "ext", "user_assets", "app.f.back", "scripts", "main.js")));
});

test("so does what it says of a data folder whose volume it cannot look at", { skip: process.platform !== "darwin" && "the BUSY Bar looks at the volume on macOS only" }, async (t) => {
  if (process.getuid() === 0) return t.skip("root may write anywhere");
  // The bar tries a file in the data folder to learn whether its volume keeps attributes in \"._\" files, as exFAT
  // does; in a folder that takes no new file it cannot, and says so when it is made, before it starts. (The bar's
  // folder, bar/1.3.1: the data folder itself must take the lock.)
  const dataDir = join(tempDir(t), "data");
  const bar = join(dataDir, "bar", "1.3.1");
  mkdirSync(join(bar, "ext", "user_assets"), { recursive: true });
  chmodSync(bar, 0o555);
  const cli = await run(t, ["--port", String(port(0)), "--data", dataDir]);
  try {
    await expectServer(cli, { firmware: "1.3.1", dataDir });
    await until("the BUSY Bar's line", () => cli.lines().length > 5);
    assert.match(cli.lines()[0], /^BUSY Bar emulator: /);
    assert.match(cli.lines()[5], /^\d\d:\d\d:\d\d Could not check whether the data folder's volume keeps file attributes/);
  } finally {
    // The folder can be removed again once the server is gone and it takes files.
    cli.child.kill();
    await cli.child.exit;
    chmodSync(bar, 0o755);
  }
});
