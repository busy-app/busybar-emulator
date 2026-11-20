// The checks of the update chain on the data folder (EMU-341; packages/app/test/update-chain/data-checks.mjs), on the
// folders the releases wrote (data-folders/): they read what a person keeps, see none of it lost when the folder is
// moved to this format, and name what an update lost.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { lostInUpdate, readState } from "../../packages/app/test/update-chain/data-checks.mjs";
import { openDataFolder } from "../../packages/server/data-folder.mjs";
import { layOut, releasedFolders } from "./data-folders/fixtures.mjs";

function folder(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emu-update-chain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A folder a release wrote, laid out in a temporary folder: { root, projects }. */
function released(t, release) {
  const fixture = releasedFolders().find((f) => f.release === release);
  assert.ok(fixture, `no folder of ${release} recorded`);
  const dir = folder(t);
  const root = path.join(dir, "data");
  layOut(fixture, root, path.join(dir, "projects"));
  return { fixture, root };
}

test("the data checks: what beta.5 and beta.6 kept is read from their folders, and the move to this format loses none of it", async (t) => {
  for (const release of ["beta.5", "beta.6"]) {
    const { fixture, root } = released(t, release);
    const before = readState(root);
    assert.equal(before.format, fixture.format);
    assert.deepEqual(Object.keys(before.apps).sort(), fixture.format === 1 ? ["app.chain.probe"] : ["app.chain.other", "app.chain.probe"]);
    assert.deepEqual(before.apps["app.chain.probe"].settings, { minutes: 40, tree: "sakura", sound: false });
    assert.deepEqual(Object.keys(before.apps["app.chain.probe"].data), ["progress.json"]);
    assert.equal(before.chosenFirmware, fixture.format === 1 ? null : "1.3.1");
    assert.equal(before.projects.length, 1);
    assert.deepEqual(before.trusted.map((p) => p.how), ["created"]);
    assert.equal(before.welcomed, true);
    assert.equal(before.windowStorage, true);
    assert.equal(before.install.version, fixture.version);

    const opened = await openDataFolder(root, { record: { port: 1 } });
    opened.release();
    const after = readState(root);
    assert.deepEqual(lostInUpdate(before, after), [], release);
    // install.json is the app's to rewrite at its start; the checks hold the new version to naming itself.
    assert.deepEqual(lostInUpdate(before, after, { version: "0.1.0" }), [`install.json names version ${fixture.version}, not 0.1.0`]);
  }
});

test("the data checks name what an update lost: an app, its settings, its data, a project, the trust, the answer, the chosen firmware", (t) => {
  const { root } = released(t, "beta.6");
  const before = readState(root);
  const ext = path.join(root, "bar", "ext");
  unlinkSync(path.join(ext, "apps_data", "js_apps", "app.chain.probe", "progress.json"));
  writeFileSync(path.join(ext, "apps_data", "jsrunner", "app.chain.probe.settings.json"), '{"version":1,"values":{"minutes":25}}');
  rmSync(path.join(ext, "user_assets", "app.chain.other"), { recursive: true });
  writeFileSync(path.join(root, "projects", "registry.json"), '{"version":1,"projects":[]}');
  writeFileSync(path.join(root, "projects", "trusted.json"), '{"version":2,"projects":[]}');
  writeFileSync(path.join(root, "app-settings.json"), "{}");
  writeFileSync(path.join(root, "bar", "chosen-firmware.json"), '{"version":"1.4.1"}');
  rmSync(path.join(root, "shell"), { recursive: true });
  const lost = lostInUpdate(before, readState(root));
  for (const line of [
    /^app\.chain\.probe: its data progress\.json is gone$/,
    /^app\.chain\.probe: its settings were .*"minutes":40.*, now \{"minutes":25\}$/,
    /^the app app\.chain\.other is no longer on the BUSY Bar$/,
    /^the projects were /,
    /^the trusted folders were /,
    /^the first question is no longer answered$/,
    /^the firmware chosen was 1\.3\.1, now 1\.4\.1$/,
    /^the windows' storage \(shell\/\) is gone$/,
  ]) assert.ok(lost.some((l) => line.test(l)), `${line} in ${JSON.stringify(lost, null, 1)}`);
  assert.deepEqual(lostInUpdate(before, readState(root), { firmwareMayChange: true }).filter((l) => l.startsWith("the firmware")), []);
  assert.ok(!existsSync(path.join(root, "shell")));
});

