// Runs a test file of fixtures/ the way the scripts of package.json run a test file: the hanging one (hangs.mjs) for
// test/unit/hang.test.mjs and test/app/hang.test.mjs, the one whose first test hangs (cascade.mjs) for
// test/app/cascade.test.mjs.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { APP_DIR, NODE, temporaryFolder } from "./helpers.mjs";

/** The options the scripts give `node --test`, read from package.json, so that the test checks what is run. */
export function testFlags(script) {
  const command = JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")).scripts[script];
  return command.split(/\s+/).filter((word) => word.startsWith("--") && word !== "--test");
}

/** Runs the hanging file (or another of fixtures/) the way the scripts run a test file, with a short time limit put after theirs. */
export function runHanging(env, limitMs, fixture = "hangs.mjs", script = "test") {
  const folder = temporaryFolder();
  const reportFile = path.join(folder, "hang.json");
  const t0 = Date.now();
  // TAP, which the tests read: Node 22 (the Mac's) prints it by default to a pipe, Node 24 (the Windows machine's) the
  // spec reporter's tree (EMU-330: cascade.test.mjs failed on that alone in gate:win).
  const child = spawn(NODE, ["--test", ...testFlags(script), `--test-timeout=${limitMs}`, "--test-reporter=tap", path.join(APP_DIR, "test", "fixtures", fixture)], {
    // Without NODE_TEST_CONTEXT, which would make the inner run take itself for a part of this one.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT")), HANG_REPORT: reportFile, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (out += chunk));
  // A run that does not end by itself is the failure this test is about.
  const guard = setTimeout(() => child.kill("SIGKILL"), limitMs + 60_000);
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      clearTimeout(guard);
      const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
      resolve({ code, signal, out, report, ms: Date.now() - t0, folder });
    });
  });
}

/** What the next test process does on Windows, where a cut-off file had no chance to clean up: loads the helpers. */
export function loadHelpersAgain() {
  return new Promise((resolve) => spawn(NODE, ["--import", new URL("./helpers.mjs", import.meta.url).href, "-e", ""], { stdio: "ignore" }).on("exit", resolve));
}
