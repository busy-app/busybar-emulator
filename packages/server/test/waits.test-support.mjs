// A server for the tests of waits.test.mjs: the command line itself (index.mjs) as a process of its own on one
// firmware version, with a data folder of its own; both are gone when the test is over (test/server/helpers.mjs).
// Every request has a time limit, so a server that hangs fails the test instead of hanging it, and a hung server is
// killed all the same.
//
// Its port is a free one, read from the server's first line. Where EMU_TEST_PORTS names the ports to use, it is the
// first of them that the server can take, counted from the fourth: the test files run side by side, and
// firmware.test.mjs has the first ones.

import { join } from "node:path";

import { node, port, request, serverModule, tempDir } from "../../../test/server/helpers.mjs";

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The ports to try, in order: any free one, or those of EMU_TEST_PORTS from the fourth on and then the first three. */
function ports() {
  if (port(0) === 0) return [0];
  const named = [];
  try {
    for (let n = 0; ; n++) named.push(port(n));
  } catch {
    // That was the last of them.
  }
  return [...named.slice(3), ...named.slice(0, 3)];
}

/** Starts the server on the first of the ports that it can take; returns { child, address, text }. */
async function start(t, version) {
  const data = join(tempDir(t), "data");
  for (const wanted of ports()) {
    const child = node(t, [serverModule("index.mjs"), "--port", String(wanted), "--data", data, "--firmware", version], { stdio: ["ignore", "pipe", "pipe"] });
    const run = { child, text: "" };
    child.stdout.on("data", (d) => (run.text += d));
    child.stderr.on("data", (d) => (run.text += d));
    for (let i = 0; i < 300 && child.exitCode === null && child.signalCode === null; i++) {
      // Its own line, not just an answer on the port: another test's server may be the one that answers there.
      const said = /^BUSY Bar emulator: (http:\/\/127\.0\.0\.1:\d+)/m.exec(run.text);
      if (said) return Object.assign(run, { address: said[1] });
      await Promise.race([sleep(100), child.exit]);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exit;
      throw new Error(`The server on firmware ${version} did not start on port ${wanted} in 30 s:\n${run.text}`);
    }
    // The port is somebody's: the next one.
    if (!run.text.includes("EADDRINUSE")) throw new Error(`The server on firmware ${version} stopped at once:\n${run.text}`);
  }
  throw new Error("None of the ports of EMU_TEST_PORTS is free.");
}

/**
 * Starts the server on `version` for the test `t` and gives `use` a way to ask it: ask(method, path, body) →
 * { status, text }, with `path` as "/api/version"; it throws when no answer comes in `limit` ms. The second argument
 * of `use` gives the server's output so far. Then the server is stopped.
 *
 * `use` is called `settle` ms after the server is up: by then the bar has started and its first program, the apps
 * menu, is on screen. (The server answers from the first moment, while the bar's desktop still waits 0.1 s to start
 * the program of the selector's position — and that program then takes the place of whatever a request started
 * before it, as the firmware's desktop does.)
 */
export async function withServer(t, version, use, { limit = 5000, settle = 1000 } = {}) {
  const run = await start(t, version);
  try {
    await sleep(settle);
    const ask = async (method, path, body) => {
      let timer;
      const late = new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`${method} ${path}: no answer from the server in ${limit} ms. Its output:\n${run.text}`)), limit)));
      try {
        const answer = await Promise.race([request(method, run.address + path, body ? Buffer.from(body) : null), late]);
        return { status: answer.status, text: answer.text.trim() };
      } finally {
        clearTimeout(timer);
      }
    };
    return await use(ask, () => run.text);
  } finally {
    // A server that spins does not hear a polite signal.
    run.child.kill("SIGKILL");
    await run.child.exit;
  }
}
