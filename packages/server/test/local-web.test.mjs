// The local web as the server gives it (local-web.mjs): the state stream's worker becomes a file of its own address.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadFirmware } from "../firmware.mjs";
import { localWeb, prepareLocalWeb, WORKER_PATH } from "../local-web.mjs";

const DATA = "data:application/javascript;base64,";

// Fails loudly when a firmware's build no longer has the worker in the shape the server knows: then its local web's
// state stream is refused again (Origin: null), and the rewrite has to be looked at.
for (const name of ["1.3.1", "dev"]) {
  test(`${name}: the state stream's worker is found once and given from the local web's own address`, () => {
    const firmware = loadFirmware(name);
    const web = localWeb(firmware);
    assert.deepEqual(web.notes, []);
    assert.equal(web.workerFound, true);
    const { files, worker } = prepareLocalWeb(firmware.web, name);
    assert.equal(files.size, 1, "one script changes");
    const [[path, changed]] = files;
    const original = readFileSync(join(firmware.web, path), "latin1");
    const literal = new RegExp(`"${DATA.replace(/[/+]/g, "\\$&")}([A-Za-z0-9+/=]+)"`).exec(original);
    assert.ok(literal);
    assert.equal(changed.toString("latin1"), original.replace(literal[0], `"${WORKER_PATH}"`), "only the address of the worker changes");
    assert.doesNotMatch(changed.toString("latin1"), new RegExp(DATA));
    assert.deepEqual(worker, Buffer.from(literal[1], "base64"), "the worker is what the data: address held");
    assert.match(worker.toString(), /new WebSocket\(/);
    // As the server gives them.
    assert.deepEqual(web.serve(path).body, changed);
    const served = web.serve(WORKER_PATH);
    assert.deepEqual(served.headers, [["Content-Type", "text/javascript"]]);
    assert.deepEqual(served.body, worker);
  });
}

test("a build without that worker is given unchanged, with a line for the log", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "busybar-emulator-web-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const web = join(dir, "web");
  cpSync(loadFirmware("1.3.1").web, web, { recursive: true });
  const file = join(web, "_nuxt", "wifiStore-7c2bd48.js");
  // Another worker in its place: a data: script that is not the state stream's.
  const text = readFileSync(file, "latin1").replace(/"data:application\/javascript;base64,[A-Za-z0-9+/=]+"/, `"${DATA}${Buffer.from("postMessage(1)").toString("base64")}"`);
  writeFileSync(file, text, "latin1");
  const prepared = localWeb({ web, name: "changed" });
  assert.equal(prepared.workerFound, false);
  assert.match(prepared.notes[0], /^The local web of firmware changed does not have the one state stream worker the emulator knows \(found 0\)/);
  assert.equal(prepared.serve("/_nuxt/wifiStore-7c2bd48.js").body.toString("latin1"), text);
  assert.notEqual(prepared.serve(WORKER_PATH).headers[0][1], "text/javascript", "no worker is made up");
});

test("an address leaves the local web's folder neither by .. nor into a folder beside it whose name starts the same", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "busybar-emulator-web-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const web = join(dir, "web");
  cpSync(loadFirmware("1.3.1").web, web, { recursive: true });
  mkdirSync(join(dir, "web-x"));
  writeFileSync(join(dir, "web-x", "f"), "OUTSIDE");
  writeFileSync(join(dir, "secret.txt"), "OUTSIDE");
  const served = localWeb({ web, name: "beside" });
  for (const address of ["/..%2Fweb-x%2Ff", "/../web-x/f", "/..%2Fsecret.txt", "/%2e%2e/secret.txt", "/a/..%5C..%5Csecret.txt", "/%E0%A4%A"]) {
    const answer = served.serve(address);
    assert.ok(answer === null || !answer.body.toString("latin1").includes("OUTSIDE"), address);
  }
  assert.equal(served.serve("/..%2Fweb-x%2Ff"), null);
  assert.match(served.serve("/").body.toString("latin1"), /<html/i, "the root is its index.html");
  assert.match(served.serve("/apps").body.toString("latin1"), /<html/i, "a route of the page is its 200.html");
});
