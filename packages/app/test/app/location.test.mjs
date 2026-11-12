// macOS: an app that runs from a disk image, from a translocated place or from Downloads asks to be moved before it
// does anything else.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { listening, mountReadOnlyImage, removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const macOnly = { skip: process.platform !== "darwin" && "macOS only" };
let app;
let folder;
let mounted = null;

afterEach(async () => {
  await app?.close();
  app = null;
  mounted?.detach();
  mounted = null;
  if (folder) await removeFolder(folder);
  folder = null;
});

const shownMessage = () =>
  until(() => app.page(`document.body.dataset.kind && ({
    kind: document.body.dataset.kind,
    origin: location.origin,
    title: document.getElementById("title").textContent,
    detail: document.getElementById("detail").textContent,
    buttons: [...document.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent),
  })`), "the message");

async function expectMoveMessage(location) {
  app = await launch({ env: { BUSY_EMULATOR_APP_LOCATION: location } });
  await app.waitWindow("message");
  assert.deepEqual(await shownMessage(), { kind: "move-app", origin: "app://shell", title: "Move BUSY Bar Emulator to Applications", detail: location, buttons: ["Quit"] });
  // Before anything else: the server was never started.
  await sleep(500);
  assert.equal(await app.run((shell) => shell.keeper.starts), 0);
  assert.equal((await app.state()).name, "idle");
  assert.equal(await listening(app.port), false);
}

test("an app on a mounted read-only disk image asks to be moved and starts no server", macOnly, async (t) => {
  folder = temporaryFolder();
  const image = mountReadOnlyImage(folder, "BUSY Bar Emulator.app");
  if (!image.app) return t.skip(image.why);
  mounted = image;
  await expectMoveMessage(image.app);
  assert.match(app.log(), /the app must be moved: read-only-volume/);
});

test("an app in a translocated place asks to be moved; Try again is not offered and Quit quits", macOnly, async () => {
  folder = temporaryFolder();
  const location = path.join(folder, "AppTranslocation", "0A1B2C3D-0000-4000-8000-123456789ABC", "d", "BUSY Bar Emulator.app");
  mkdirSync(location, { recursive: true });
  await expectMoveMessage(location);
  assert.match(app.log(), /the app must be moved: translocated/);
  // The bridge's retry does nothing here.
  await app.page("window.busyShell.retry()");
  await sleep(300);
  assert.equal(await app.run((shell) => shell.keeper.starts), 0);
  await app.pids();
  await app.page(`document.getElementById("quit").click()`);
  assert.equal((await app.exited).code, 0);
});

test("an app in an ordinary place starts as usual", macOnly, async () => {
  folder = temporaryFolder();
  const location = path.join(folder, "Applications", "BUSY Bar Emulator.app");
  mkdirSync(location, { recursive: true });
  app = await launch({ env: { BUSY_EMULATOR_APP_LOCATION: location } });
  await app.waitWindow("device");
});

test("other systems have no such check: the same place starts the app", { skip: process.platform === "darwin" && "the macOS tests cover it" }, async () => {
  folder = temporaryFolder();
  const location = path.join(folder, "AppTranslocation", "x", "d", "BUSY Bar Emulator.app");
  mkdirSync(location, { recursive: true });
  app = await launch({ env: { BUSY_EMULATOR_APP_LOCATION: location } });
  await app.waitWindow("device");
});
