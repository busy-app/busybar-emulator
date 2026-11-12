// The first run's greeting (EMU-207) in the app as tools/dist.mjs builds it, in its test variant: the server and the
// command line from the app's resources, the launcher written where the test says the home is. The first run shows the
// greeting; the next one does not; Copy gives the text for this system, naming the launcher the app wrote, as
// welcome.js makes it. Hidden, as every launch in this suite.
//
//   node tools/dist.mjs build --kind test --allow-uncommitted       then
//   BUSY_EMULATOR_TEST_BUILT=<out>/test-variant/<target>/<app> npm run test:app
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { launcherPathIn } from "../../src/config.mjs";
import { removeFolder, sleep, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const BUILT = process.env.BUSY_EMULATOR_TEST_BUILT;
const skip = !BUILT && "needs the built test variant: BUSY_EMULATOR_TEST_BUILT=<path of the app tools/dist.mjs built with --kind test>";
const darwin = process.platform === "darwin";
const LIMIT = 180_000;
const executable = () => (darwin ? path.join(BUILT, "Contents", "MacOS", "BUSY Bar Emulator") : path.join(BUILT, "BUSY Bar Emulator.exe"));

/** welcome.js on its own, without a page: the text for agents as the window makes it. */
function welcome() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(here, "..", "..", "..", "server", "legacy-window", "welcome.js"), "utf8"), sandbox, { filename: "welcome.js" });
  return sandbox.emulatorWelcome;
}

let data;
let home;
before(() => {
  if (skip) return;
  data = temporaryFolder();
  home = temporaryFolder();
});
after(async () => {
  if (data) await removeFolder(data);
  if (home) await removeFolder(home);
});

const shown = (app) => app.page(`(() => { const box = document.querySelector("#welcome"); return box && !box.hidden ? [...box.querySelectorAll(".welcome-step")].find((step) => !step.hidden)?.dataset.step : null; })()`);
// The harness answers the greeting for every other test (BUSY_EMULATOR_TEST_GREETED=1); this one is about it.
const start = () => launch({ executable: executable(), server: "bundled", dataDir: data, env: { BUSY_EMULATOR_USER_HOME: home, BUSY_EMULATOR_TEST_GREETED: "" } });
async function ready(app) {
  await app.waitState("ready", 90_000);
  await app.waitWindow("device", 60_000);
  await until(() => app.page(`document.querySelector("#link")?.classList.contains("live")`), "the page connected", 60_000);
}

test("the built app: the first run shows the greeting, and Copy gives the text for this system with the launcher the app wrote", { skip, timeout: LIMIT }, async () => {
  const app = await start();
  try {
    await ready(app);
    await until(async () => (await shown(app)) === "ask", "the greeting", 30_000);
    await app.click('[data-choice="agent"]');
    await until(async () => (await shown(app)) === "agent", "the text for agents");
    await app.click("#welcome-copy");
    await until(() => app.page(`document.querySelector(".welcome-said").textContent === "Copied"`), "Copied");
    const [copied] = await app.run((shell) => shell.offScreen.copied);
    // The launcher the app wrote at its start, at the fixed path in the home the test gave it.
    const launcher = launcherPathIn(home, process.platform);
    assert.ok(existsSync(launcher), launcher);
    const expected = welcome().agentText({ platform: process.platform, cli: launcher });
    assert.equal(copied, expected);
    const call = welcome().cliCall({ platform: process.platform, cli: launcher });
    for (const line of [`2. ${call} dev --once`, `3. ${call} screenshot --scale 8`, `4. ${call} logs`]) assert.ok(copied.split("\n").includes(line), `${line}\n---\n${copied}`);
    assert.match(call, process.platform === "win32" ? /^(?:& '.+busy-emulator\.exe'|[A-Za-z]:\/\S+\/busy-emulator\.exe)$/ : /^'?\/.+\/\.busy-emulator\/bin\/busy-emulator'?$/);
    const settings = JSON.parse(readFileSync(path.join(data, "app-settings.json"), "utf8"));
    assert.equal(settings.welcomed, true);
    assert.equal(settings.welcomeWay, "agent");
  } finally {
    await app.close();
  }
});

test("the built app: the next run does not show the greeting, and Getting started opens it on the way chosen", { skip, timeout: LIMIT }, async () => {
  const app = await start();
  try {
    await ready(app);
    await sleep(2000);
    assert.equal(await shown(app), null, "not asked again");
    await app.click("#welcome-open");
    await until(async () => (await shown(app)) === "agent", "the greeting on the way chosen");
  } finally {
    await app.close();
  }
});
