// Importing a module of the server starts nothing and reads neither the command line nor the environment; only the
// command line itself (index.mjs) does.
import assert from "node:assert/strict";
import { closeSync, existsSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

import { finish, node, serverDir, tempDir } from "./helpers.mjs";

after(finish);

// The server's command line, and the tools of the folder that are command lines of their own: run, never imported.
// cli/busy-emulator.mjs is the emulator's command line (EMU-202); the rest of cli/ gets what it needs from it.
const ENTRY = "index.mjs";
const COMMANDS = [ENTRY, "capture/png-bench.mjs", "cli/busy-emulator.mjs"];
// The pages of the device window run in a browser, not in the server.
const BROWSER = "legacy-window";
// Tests that live next to the code they test, and what only they use: importing one runs it.
const isTest = (name) => name.endsWith(".test.mjs") || name.endsWith("test-support.mjs");

function modules(dir = serverDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === BROWSER ? [] : modules(join(dir, entry.name));
    return entry.name.endsWith(".mjs") ? [relative(serverDir, join(dir, entry.name)).replaceAll("\\", "/")] : [];
  });
}

const imported = modules().filter((name) => !COMMANDS.includes(name) && !isTest(name));

test("the server has modules to import, and its command lines are the files named here", () => {
  assert.ok(imported.includes("server.mjs") && imported.includes("firmware.mjs") && imported.includes("runtime.mjs"), imported.join(", "));
  for (const name of COMMANDS) assert.ok(modules().includes(name), `${name} is there`);
});

test("only a command line names process.argv or process.env", () => {
  for (const name of imported) {
    const source = readFileSync(join(serverDir, name), "utf8");
    const found = source.match(/process\s*\.\s*(argv|env|execArgv)\b/g) ?? [];
    assert.deepEqual(found, [], `${name} reads ${found.join(", ")}`);
  }
  assert.match(readFileSync(join(serverDir, ENTRY), "utf8"), /process\.argv/);
});

// Each module is imported in a process of its own, whose command line and environment name a firmware that does
// not exist and a port: a module that read them would fail or listen. The process must say nothing, have nothing
// that keeps it running, and end by itself. Its output goes to files: Node counts a pipe of the standard streams
// among what is active as soon as node:http is loaded, and that is not the server's doing.
const CHILD = `
  await import(process.argv[1]);
  await new Promise((resolve) => setImmediate(resolve));
  console.log(JSON.stringify(process.getActiveResourcesInfo()));
`;

for (const name of imported) {
  test(`importing ${name} starts nothing`, async (t) => {
    const dir = tempDir(t);
    const out = openSync(join(dir, "out"), "w");
    const err = openSync(join(dir, "err"), "w");
    t.after(() => (closeSync(out), closeSync(err)));
    const url = pathToFileURL(join(serverDir, name)).href;
    const args = ["--input-type=module", "-e", CHILD, url, "--firmware", "no-such-firmware", "--port", "1", "--data", join(dir, "data")];
    const child = node(t, args, { env: { ...process.env, EMU_FIRMWARE: "no-such-firmware" }, stdio: ["ignore", out, err] });
    const code = await child.exited(30000);
    assert.equal(readFileSync(join(dir, "err"), "utf8"), "");
    assert.equal(code, 0, "the process ends by itself, without an error");
    assert.equal(readFileSync(join(dir, "out"), "utf8").trim(), "[]", "nothing keeps the process running after the import");
    assert.ok(!existsSync(join(dir, "data")), "no data folder is made");
  });
}
