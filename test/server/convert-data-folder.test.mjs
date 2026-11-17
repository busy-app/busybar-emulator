// test/convert-data-folder.mjs: a data folder of the layout before the format number becomes one the emulator opens,
// with its apps on its one BUSY Bar, whatever the firmware; a folder of today's layout is left alone.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";

import { FORMAT } from "../../packages/server/data-folder.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, node, port, serverDir, tempDir } from "./helpers.mjs";

after(finish);

const script = resolve(serverDir, "..", "..", "test", "convert-data-folder.mjs");

async function convert(t, ...args) {
  const proc = node(t, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk) => (out += chunk));
  proc.stderr.on("data", (chunk) => (err += chunk));
  return { code: await proc.exited(), out, err };
}

function anApp(storage, id) {
  mkdirSync(join(storage, "user_assets", id, "appmeta"), { recursive: true });
  mkdirSync(join(storage, "user_assets", id, "scripts"), { recursive: true });
  writeFileSync(join(storage, "user_assets", id, "appmeta", "manifest.json"), JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.0.0" }));
  writeFileSync(join(storage, "user_assets", id, "scripts", "main.js"), "setInterval(function () {}, 1000);");
}

const appsOn = async (dataDir, firmware) => {
  const emulator = await startServer({ port: port(0), dataDir, firmware });
  try {
    return (await get(`${emulator.url}/api/apps/list`)).json().apps.map((app) => app.id);
  } finally {
    await emulator.stop();
  }
};

test("a comparison copy with ext at its top: refused before, opened after, with its apps on every firmware", async (t) => {
  const root = tempDir(t);
  anApp(join(root, "ext"), "app.test.old");
  await assert.rejects(startServer({ port: port(0), dataDir: root }), { code: "EMU_DATA_FORMAT" });
  const run = await convert(t, root);
  assert.equal(run.code, 0, run.err);
  assert.ok(!existsSync(join(root, "ext")), "moved, not copied");
  assert.deepEqual(readdirSync(join(root, "bar")).filter((name) => !name.startsWith("._")), ["ext"]);
  assert.ok(!existsSync(join(root, "format")), "the record is the emulator's to write");
  assert.deepEqual(await appsOn(root, "1.3.1"), ["app.test.old"]);
  assert.deepEqual(await appsOn(root, "1.4.1"), ["app.test.old"]);
  assert.equal(readFileSync(join(root, "format"), "utf8"), `${FORMAT}\n`);
  // Once in today's layout it is left alone.
  const again = await convert(t, root);
  assert.equal(again.code, 1);
  assert.match(again.err, /has a format record already: it is in today's layout, and is left as it is\.\n$/);
});

test("the app's data folder from before (its bar/ext) needs nothing: the emulator opens it as it is", async (t) => {
  const root = tempDir(t);
  anApp(join(root, "bar", "ext"), "app.test.shell");
  const run = await convert(t, root);
  assert.equal(run.code, 1);
  assert.match(run.err, /bar.ext is there already: the emulator opens this folder as it is, and nothing is moved\.\n$/);
  assert.deepEqual(await appsOn(root), ["app.test.shell"]);
});

test("nothing to move, more than one folder: a line that says so, exit code 1, nothing moved", async (t) => {
  const empty = tempDir(t);
  assert.match((await convert(t, empty)).err, /has no bar's storage of the layout before/);
  const root = tempDir(t);
  anApp(join(root, "ext"), "app.test.kept");
  const two = await convert(t, root, root);
  assert.equal(two.code, 1);
  assert.match(two.err, /^Name one data folder/);
  assert.ok(existsSync(join(root, "ext", "user_assets", "app.test.kept")));
});
