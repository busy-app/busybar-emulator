// The bundled Node gets nothing from the caller that would change how it starts (security S2): one list, held by the
// three entries that start it, and by nodeEnvironment() for every other program on it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { NODE_ENVIRONMENT_UNSET, macLauncherScript } from "../../../app/src/install-files.mjs";
import { NODE_ENVIRONMENT_DENYLIST, nodeEnvironment } from "../node-environment.mjs";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "app");
const sorted = (list) => [...list].sort();

test("the list holds what makes Node load code or trust certificates", () => {
  for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_EXTERNAL_MODULE", "NODE_ICU_DATA", "NODE_V8_COVERAGE", "OPENSSL_CONF"]) {
    assert.ok(NODE_ENVIRONMENT_DENYLIST.includes(name), name);
  }
});

test("the macOS entry inside the app removes exactly the list, and takes nothing from the environment as shell code", () => {
  const script = readFileSync(path.join(APP, "launcher", "macos", "busy-emulator"), "utf8");
  assert.equal(script.split("\n")[0], "#!/bin/sh -p");
  assert.deepEqual(sorted([...script.matchAll(/-u (\S+)/g)].map((m) => m[1])), sorted(NODE_ENVIRONMENT_DENYLIST));
  assert.match(script, /exec \/usr\/bin\/env \\/);
});

test("the launcher the app writes on macOS removes exactly the list", () => {
  assert.deepEqual(sorted(NODE_ENVIRONMENT_UNSET), sorted(NODE_ENVIRONMENT_DENYLIST));
  const script = macLauncherScript({ node: "/n", cli: "/c", launcher: "/l", appPath: "/a" });
  assert.equal(script.split("\n")[0], "#!/bin/sh -p");
  assert.deepEqual(sorted([...script.matchAll(/-u (\S+)/g)].map((m) => m[1])), sorted(NODE_ENVIRONMENT_DENYLIST));
});

test("the Windows entry removes exactly the list", () => {
  const source = readFileSync(path.join(APP, "launcher", "windows", "busy-emulator.cs"), "utf8");
  const block = /NodeEnvironmentDenylist = \{([^}]*)\}/.exec(source)[1];
  assert.deepEqual(sorted([...block.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1])), sorted(NODE_ENVIRONMENT_DENYLIST));
  assert.match(source, /foreach \(string name in NodeEnvironmentDenylist\) start\.EnvironmentVariables\.Remove\(name\);/);
  // The Windows folder by the system's account, set after the caller's environment is taken over (security S5).
  assert.match(source, /start\.EnvironmentVariables\["BUSY_EMULATOR_WINDOWS_DIR"\] = Environment\.GetFolderPath\(Environment\.SpecialFolder\.Windows\);/);
});

test("nodeEnvironment() keeps the rest, and on Windows ignores the letter case of names", () => {
  assert.deepEqual(nodeEnvironment({ NODE_OPTIONS: "--require x", PATH: "/bin", HOME: "/h" }, "darwin"), { PATH: "/bin", HOME: "/h" });
  assert.deepEqual(nodeEnvironment({ node_options: "--require x", Path: "C:\\" }, "win32"), { Path: "C:\\" });
  assert.deepEqual(nodeEnvironment({ node_options: "x" }, "darwin"), { node_options: "x" });
});
