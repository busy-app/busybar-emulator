// After stop() the process holds nothing of the server and ends by itself: a start, a busy bar and a stop in a
// process of their own (lifecycle.child.mjs), which never calls process.exit().
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { finish, knownPort, node, tempDir } from "./helpers.mjs";

after(finish);

const here = dirname(fileURLToPath(import.meta.url));

/** Runs a script of this folder as a process, to its own end; returns what it printed, parsed. */
async function report(t, flags, script, ...args) {
  const running = node(t, [...flags, join(here, script), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  running.stdout.setEncoding("utf8").on("data", (text) => (stdout += text));
  running.stderr.setEncoding("utf8").on("data", (text) => (stderr += text));
  // If something kept the process running, the wait would end it and fail.
  const code = await running.exited(60000);
  assert.equal(stderr, "");
  assert.equal(code, 0, "the process ended by itself, without an error");
  return JSON.parse(stdout);
}

test("V8's wasm flags are its defaults again once a server has started", async (t) => {
  const moments = await report(t, ["--allow-natives-syntax"], "flags.child.mjs", String(await knownPort()), tempDir(t));
  const defaults = { lazy: true, liftoff: true };
  assert.deepEqual(moments, { before: defaults, running: defaults, after: defaults });
});

for (const scenario of ["", "restart"]) {
  test(`after a stop${scenario ? " in the middle of a restart of the BUSY Bar" : ""} nothing of the server is left, and the process ends by itself`, async (t) => {
    const dataDir = tempDir(t);
    const port = await knownPort();
    const started = Date.now();
    const { left, memory } = await report(t, ["--expose-gc"], "lifecycle.child.mjs", String(port), dataDir, scenario);
    assert.deepEqual(left, [], `left after the stop:\n${left.map((one) => `${one.type}\n${one.made}`).join("\n\n")}`);
    // A running bar holds two wasm instances, tens of megabytes outside the JS heap; after the stop they are gone.
    assert.ok(memory.running > memory.before + 10, `a running bar takes memory: ${JSON.stringify(memory)}`);
    assert.ok(memory.after < memory.before + 4, `the memory is given back: ${JSON.stringify(memory)}`);
    t.diagnostic(`memory outside the JS heap, MB: ${memory.before.toFixed(1)} before, ${memory.running.toFixed(1)} running, ${memory.after.toFixed(1)} after the stop; the whole run took ${Date.now() - started} ms`);
    // The app the child installed is all that stays, in the data folder.
    assert.deepEqual(readdirSync(join(dataDir, "bar", "1.3.1", "ext", "user_assets")), ["app.test.lifecycle"]);
  });
}
