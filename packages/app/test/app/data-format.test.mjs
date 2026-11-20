// An app on a data folder it cannot use (EMU-341; ADR-0013, its section on the data folder): a newer version moved the
// folder on, or its format record is broken. It writes nothing there (no log, no windows' storage, no install.json),
// says why (on its error output; a run that is not hidden also in a dialog) and ends with code 4, before its server or
// its window. The check itself is data-format.mjs, tested without Electron in test/server/data-format.test.mjs.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "./node-test.mjs";

import { EXIT_NEWER_DATA_FORMAT } from "../../src/data-format.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";
import { launch } from "./harness.mjs";

let app = null;
let folder = null;

afterEach(async () => {
  await app?.close();
  app = null;
  if (folder) await removeFolder(folder);
  folder = null;
});

/** Every entry under `dir` with its kind, size and time of change; the test's own socket (hook.sock) left out. */
function snapshot(dir) {
  const out = [];
  const walk = (at, rel) => {
    for (const name of readdirSync(at).sort()) {
      if (!rel && name === "hook.sock") continue;
      const stat = lstatSync(path.join(at, name));
      out.push(`${rel}/${name} ${stat.isDirectory() ? "dir" : stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(path.join(at, name), `${rel}/${name}`);
    }
  };
  walk(dir, "");
  return out;
}

test("a data folder of a newer format: the app writes nothing there, says why and ends with code 4", async () => {
  folder = temporaryFolder();
  writeFileSync(path.join(folder, "format"), "99\nwhat the newer version keeps after the number\n");
  mkdirSync(path.join(folder, "bar", "ext", "user_assets", "app.newer.one"), { recursive: true });
  writeFileSync(path.join(folder, "bar", "ext", "user_assets", "app.newer.one", "main.js"), "// the newer version's\n");
  writeFileSync(path.join(folder, "install.json"), '{"app":"the newer one","cli":"its launcher","version":"9.9.9"}\n');
  const before = snapshot(folder);
  // Without waiting for the test entry: the app ends before it would connect to it.
  app = await launch({ dataDir: folder, hook: false });
  const end = await Promise.race([app.exited, new Promise((resolve) => setTimeout(() => resolve(null), 60_000))]);
  assert.deepEqual(end, { code: EXIT_NEWER_DATA_FORMAT, signal: null }, app.stderr());
  assert.match(app.stderr(), /The data folder .* is of format 99: a newer version of BUSY Bar Emulator moved it there, and this one, .*, knows format \d+ at most\. Nothing in it was changed/);
  assert.match(app.stderr(), /https:\/\/github\.com\/busy-app\/busybar-emulator\/releases\/latest/);
  assert.equal(app.hooked(), false, "the app went on to its test entry");
  assert.deepEqual(snapshot(folder), before, "the data folder is exactly as the newer version left it");
});

test("a format record that names no format: the same, as the server would refuse it", async () => {
  folder = temporaryFolder();
  writeFileSync(path.join(folder, "format"), "three\n");
  const before = snapshot(folder);
  // Without waiting for the test entry: the app ends before it would connect to it.
  app = await launch({ dataDir: folder, hook: false });
  const end = await Promise.race([app.exited, new Promise((resolve) => setTimeout(() => resolve(null), 60_000))]);
  assert.deepEqual(end, { code: EXIT_NEWER_DATA_FORMAT, signal: null }, app.stderr());
  assert.match(app.stderr(), /has a format record .* that this version cannot use: it does not name a format\. Nothing in it was changed/);
  assert.deepEqual(snapshot(folder), before);
});
