// A switch of the BUSY Bar's firmware inside the app (EMU-320): the server switches in its own process, so the window
// stays as it is and reads again what depends on the firmware, the local web's window is loaded again, and the shell
// counts no death. A server that dies afterwards is started again on the firmware chosen last.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "./node-test.mjs";

import { until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

const options = { skip: !HAS_REAL_SERVER && "the server is not beside this package" };

let app;
before(async () => {
  if (!HAS_REAL_SERVER) return;
  app = await launch({ server: "real" });
  await app.waitWindow("device");
});
after(async () => {
  await app?.close();
});

/** POST /_emu/firmware on the management address, with the key the server wrote for this start. */
async function useFirmware(version) {
  const { controlPort } = await app.run((shell) => shell.keeper.state);
  const key = readFileSync(path.join(app.folder, "key"), "utf8").trim();
  const answer = await fetch(`http://127.0.0.1:${controlPort}/_emu/firmware`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ version }) });
  return { status: answer.status, body: await answer.json() };
}
const label = () => app.page(`document.querySelector("#firmware").textContent`);

test("the window lives through a switch and shows the new firmware; the local web is loaded again; no death is counted", options, async () => {
  await until(async () => (await label()) === "Firmware 1.4.1", "the firmware's label");
  // Marks that a reload of either page would take away.
  await app.page(`window.beforeTheSwitch = true`);
  await app.run((_shell, electron) => electron.Menu.getApplicationMenu().getMenuItemById("app-settings").click());
  await until(() => app.run((shell) => !!shell.windows.localWeb?.presented && !shell.windows.localWeb.win.webContents.isLoading()), "the local web's window");
  await app.run((shell) => shell.windows.localWeb.win.webContents.executeJavaScript("window.beforeTheSwitch = true"));
  const pid = (await app.run((shell) => shell.keeper.pids())).server;

  const switched = await useFirmware("previous");
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  assert.equal(switched.body.firmware.version, "1.3.1");

  await until(async () => (await label()) === "Firmware 1.3.1", "the label of the new firmware");
  assert.equal(await app.page(`window.beforeTheSwitch === true`), true, "the device window was not loaded again");
  assert.equal(await app.page(`document.querySelector("#api").textContent`), `API ${switched.body.firmware.api}`);
  await until(
    () => app.run((shell) => shell.windows.localWeb.win.webContents.executeJavaScript("window.beforeTheSwitch === undefined").catch(() => false)),
    "the local web loaded again",
  );
  const shell = await app.run((s) => ({ state: s.keeper.state.name, starts: s.keeper.starts, pid: s.keeper.pids().server }));
  assert.deepEqual(shell, { state: "ready", starts: 1, pid }, "the same server process, never started again");
  assert.match(app.log(), /\[shell\] the BUSY Bar runs firmware 1\.3\.1 now/);
  assert.doesNotMatch(app.log(), /\[shell\] server ended/);
});

test("a server that dies after the switch is started again on the firmware chosen last", options, async () => {
  await app.run((shell) => shell.windows.closeLocalWeb());
  const pid = (await app.run((shell) => shell.keeper.pids())).server;
  process.kill(pid, "SIGKILL");
  await until(() => app.run((shell) => shell.keeper.starts === 2 && shell.keeper.state.name === "ready"), "the server started again", 60_000);
  const lock = JSON.parse(readFileSync(path.join(app.folder, "run", "server.lock"), "utf8"));
  assert.equal(lock.firmware, "1.3.1");
  await app.waitWindow("device");
  await until(async () => (await label().catch(() => null)) === "Firmware 1.3.1", "the label after the restart");
  assert.equal((await useFirmware("latest")).body.firmware.version, "1.4.1");
});
