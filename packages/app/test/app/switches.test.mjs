// The release takes no Chromium switches from its command line (ADR-0016). The test variant keeps the same rule, so
// it is tested on a copy of the release files marked as the test variant, with the test entry beside them: such a copy
// is the release's code in every respect the rule looks at. A run from the source tree keeps its switches, and the
// last test shows that the switches used here do act when nothing removes them.
//
// Every switch here worked on the shell before (EMU-201 security review, S5): --disable-web-security let the page
// read another origin, --proxy-server and --host-rules put another page under the server's address, --js-flags
// reached V8 in the page, --remote-debugging-port opened Chromium's inspection entry, and --gpu-launcher runs the named
// program in place of a helper of Chromium.
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { releaseFiles } from "../../tools/release-files.mjs";
import { APP_DIR, listening, PORTS, removeFolder, temporaryFolder } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const DEBUGGING = PORTS.other;
const posix = process.platform !== "win32";

let folder;
let copy;
let witness;
let reached = [];
let app;

before(async () => {
  folder = temporaryFolder();
  copy = path.join(folder, "app");
  for (const file of releaseFiles()) {
    mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    cpSync(path.join(APP_DIR, file), path.join(copy, file));
  }
  cpSync(path.join(APP_DIR, "test-variant"), path.join(copy, "test-variant"), { recursive: true });
  writeFileSync(path.join(copy, "build.json"), JSON.stringify({ kind: "test", version: "0.0.0", node: "24.22.2" }));
  // A program Chromium would start its helper with: it leaves a mark and starts the helper. (Run from the source
  // tree on macOS, --gpu-launcher does that; --renderer-cmd-prefix and --utility-cmd-prefix are not given here: they
  // make Electron stop at once on macOS, so a failure would not say which rule broke. Checked 11.11.)
  if (posix) {
    writeFileSync(path.join(folder, "launcher.sh"), `#!/bin/sh\necho "$0 $*" >> "${path.join(folder, "launched")}"\nexec "$@"\n`);
    chmodSync(path.join(folder, "launcher.sh"), 0o755);
  }
  witness = createServer((req, res) => {
    reached.push(req.url);
    res.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "null" });
    res.end("<!doctype html><title>elsewhere</title><p id='elsewhere'>elsewhere</p>");
  });
  await new Promise((resolve) => witness.listen(PORTS.witness, "127.0.0.1", resolve));
});
afterEach(async () => {
  await app?.close();
  app = null;
});
after(async () => {
  witness.closeAllConnections();
  await new Promise((resolve) => witness.close(resolve));
  await removeFolder(folder);
});

const SWITCHES = () => [
  "--disable-web-security",
  `--proxy-server=127.0.0.1:${PORTS.witness}`,
  "--proxy-bypass-list=<-loopback>",
  `--host-rules=MAP 127.0.0.1:${PORTS.app} 127.0.0.1:${PORTS.witness}`,
  "--js-flags=--expose-gc",
  `--remote-debugging-port=${DEBUGGING}`,
  "--remote-allow-origins=*",
  ...(posix ? [`--gpu-launcher=${path.join(folder, "launcher.sh")}`] : []),
  // With one dash, which Chromium reads as well.
  "-lang=de",
];
const NAMES = () => SWITCHES().map((arg) => arg.replace(/^-+/, "").split("=")[0]);

test("the test variant made of the release files takes none of the switches it is given", async () => {
  reached = [];
  app = await launch({ appDir: copy, args: SWITCHES() });
  await app.waitWindow("device");
  assert.equal(await app.run((shell) => shell.config.kind), "test");
  const left = await app.run((_shell, electron, names) => names.filter((name) => electron.app.commandLine.hasSwitch(name) || electron.app.commandLine.hasSwitch(name.toLowerCase())), NAMES());
  assert.deepEqual(left, []);
  // What each would have done.
  assert.equal(await app.page("document.getElementById('fake') !== null && document.getElementById('elsewhere') === null"), true, "the window shows another page");
  assert.equal(await app.page("typeof gc"), "undefined", "--js-flags reached the page");
  assert.notEqual(await app.run((_shell, electron) => electron.app.getLocale()), "de", "-lang set the app's language");
  assert.equal(await listening(DEBUGGING), false, "the remote debugging port is open");
  assert.equal(existsSync(path.join(folder, "launched")), false, "Chromium started the program it was given");
  assert.deepEqual(reached, []);
});

// The other half: without the rule, the same switches act. Only those that cannot touch anything but this test are
// given here: V8's flag in the page, the language, and the debugging port, which listens on 127.0.0.1 in the test's
// range.
test("a run from the source tree keeps its switches: the same ones act there", async () => {
  app = await launch({ args: ["--js-flags=--expose-gc", "-lang=de", `--remote-debugging-port=${DEBUGGING}`] });
  await app.waitWindow("device");
  assert.equal(await app.run((shell) => shell.config.kind), "development");
  assert.equal(await app.page("typeof gc"), "function");
  assert.equal(await app.run((_shell, electron) => electron.app.getLocale()), "de");
  assert.equal(await listening(DEBUGGING), true);
});
