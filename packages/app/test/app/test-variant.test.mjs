// The test variant is the same code plus the folder test-variant/. A release is made from the list of release files,
// which does not have that folder — and an app without the folder has no test entry, whatever it is told.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { releaseFiles } from "../../tools/release-files.mjs";
import { APP_DIR, CHROMIUM_GONE_WITHIN_MS, listening, removeFolder, sleep, survivors, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

let app;
let copy;
afterEach(async () => {
  await app?.close();
  app = null;
  if (copy) await removeFolder(copy);
  copy = null;
});

test("the list of release files: the app's code, and no test entry, tests or tools", () => {
  const files = releaseFiles();
  assert.deepEqual(files, [
    "package.json",
    "src/actions.mjs",
    "src/app-scheme.mjs",
    "src/assets/app-icon.png",
    "src/bridge.mjs",
    "src/build-feed.mjs",
    "src/build-kind.mjs",
    "src/capture-actions.mjs",
    "src/capture-mp4.mjs",
    "src/capture-preload.cjs",
    "src/capture-window.mjs",
    "src/cli-process.mjs",
    "src/config.mjs",
    "src/external.mjs",
    "src/folder-dialogs.mjs",
    "src/gestures.mjs",
    "src/github/gh.mjs",
    "src/github/github-api.mjs",
    "src/github/local-git.mjs",
    "src/github/publish-flow.mjs",
    "src/github/publish-record.mjs",
    "src/icons/lucide.json",
    "src/icons.mjs",
    "src/install-files.mjs",
    "src/location-check.mjs",
    "src/log.mjs",
    "src/main.mjs",
    "src/menu.mjs",
    "src/messages.mjs",
    "src/page-preload.cjs",
    "src/pages/capture/busybar-device.png",
    "src/pages/capture/capture.html",
    "src/pages/capture/capture.js",
    "src/pages/shell/icon.png",
    "src/pages/shell/message.css",
    "src/pages/shell/message.html",
    "src/pages/shell/message.js",
    "src/path-boundary.mjs",
    "src/permissions.mjs",
    "src/person-question.mjs",
    "src/preload.cjs",
    "src/processes.mjs",
    "src/project-root.mjs",
    "src/report-actions.mjs",
    "src/restart-policy.mjs",
    "src/same-path.mjs",
    "src/scrub.mjs",
    "src/security.mjs",
    "src/server-keeper.mjs",
    "src/server-process.mjs",
    "src/supervisor.mjs",
    "src/terminal.mjs",
    "src/title-bar.mjs",
    "src/update-check.mjs",
    "src/update-helper.mjs",
    "src/update-manifest.mjs",
    "src/update-popup.mjs",
    "src/updater.mjs",
    "src/window-preload.cjs",
    "src/window-texts.mjs",
    "src/windows.mjs",
    "src/zip.mjs",
  ]);
  for (const file of files) assert.doesNotMatch(file, /^(test-variant|test|tools|node_modules)\//);
});

test("an app made of the release files works and has no test entry, even when told where to connect", async () => {
  copy = temporaryFolder();
  for (const file of releaseFiles()) {
    mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    cpSync(path.join(APP_DIR, file), path.join(copy, file));
  }
  assert.equal(existsSync(path.join(copy, "test-variant")), false);
  // Marked as the test variant, so that it takes this test's port and data folder: an unmarked copy outside the source
  // tree is a release (src/build-kind.mjs) and would take the user's own.
  writeFileSync(path.join(copy, "build.json"), JSON.stringify({ kind: "test", version: "0.0.0", node: "24.22.2" }));

  // The same launch as in every other test, with the address of the test entry in the environment.
  app = await launch({ appDir: copy, hook: false, env: { FAKE_SERVER_CHILD: "1" } });
  await until(() => listening(app.port), "the server of the app without the test entry");
  const { pid, child } = await app.fakeReport();
  await until(() => /\[shell\] server: ready/.test(app.log()), "the app to see its server ready");
  await sleep(1500);
  assert.equal(app.hooked(), false, "the app connected to the test entry");
  assert.doesNotMatch(app.log(), /uncaught|did not start/);

  await app.terminate();
  assert.deepEqual(await survivors([pid, child]), []);
  assert.deepEqual(await survivors([app.pid], CHROMIUM_GONE_WITHIN_MS), []);
  assert.equal(await listening(app.port), false);
});

test("the test variant, told the same, connects: the difference is the folder", async () => {
  app = await launch();
  assert.equal(app.hooked(), true);
  assert.equal(await app.run((shell) => shell.testVariant), true);
});
