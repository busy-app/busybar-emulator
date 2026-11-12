// The app's copy of the path rule (src/path-boundary.mjs) is the server's (packages/server/path-boundary.mjs), byte for
// byte: one rule for the window's Delete, Show and Open and for the command line (EMU-010). The rule's own tests are
// packages/server/test/path-boundary.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const name of ["path-boundary.mjs", "same-path.mjs"]) {
  test(`src/${name} is the server's ${name}`, () => {
    const app = readFileSync(path.join(APP, "src", name), "utf8");
    const server = readFileSync(path.join(APP, "..", "server", name), "utf8");
    assert.ok(app === server, `copy packages/server/${name} over packages/app/src/${name} (or the other way): they must not differ`);
  });
}
