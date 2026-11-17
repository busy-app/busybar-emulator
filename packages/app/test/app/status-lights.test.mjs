// The status lights, the BUSY Bar's two RGB LEDs beside Start / Pause, in the shell's device window with the real
// server (EMU-329): a draw with led_notification_color blinks them three times by the firmware's timeline, and then
// nothing of it is left lit, in the flat view (no class, no glow) and in the 3D view; a page reloaded, or a 3D view that
// comes up, in the middle of a notification shows the step it is at, and after it shows nothing of it. The steps
// themselves are checked against the firmware's code in packages/server/test/status-lights.test.mjs.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { HAS_REAL_SERVER, PORTS, sleep, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const skipAll = !HAS_REAL_SERVER && "the server is not beside this package";
let app;
// Animation frames a second in the window's page, as stage3d.test.mjs counts them: a hidden window on Windows gets one
// a second. Each reading of the 3D view (its probe) draws the canvas and reads it back, which then waits that long and
// longer (on tride-win, 17.11: "The 3D view did not answer" in 5 s; EMU-328 is the same wait): the 3D view's steps
// cannot be read in time there.
let frames = Infinity;
const stalled = () =>
  frames < 20 &&
  `this hidden window gets ${frames} animation frames a second (Windows draws none for a window that is never shown): each reading of the 3D view waits for one; BUSY_EMULATOR_TEST_VISIBLE=1 runs this test`;

before(async () => {
  if (skipAll) return;
  app = await launch({ server: "real", welcomed: true });
  await app.waitWindow("device");
  await app.waitState("ready");
  frames = await app.page("new Promise((done) => { let n = 0; const count = () => { n++; requestAnimationFrame(count); }; requestAnimationFrame(count); setTimeout(() => done(n), 1000); })");
});
after(() => app?.close());

// presets/blink.c, the notification: on at 0, off at 500, on at 1000, off at 1500, on at 2000, dark from 2500 ms.
const EDGES = [0, 500, 1000, 1500, 2000, 2500];
const litAt = (t) => t >= 0 && t < 2500 && Math.floor(t / 500) % 2 === 0;
// How far from an edge a reading may be taken and still say which side of it the LEDs are on: the page's timers, the
// stream and the test's own requests each take a few ms, more on a loaded machine.
const MARGIN_MS = 150;

/** A notification of `color`, as an app's draw starts it; the moment it started by this computer's clock. */
async function notify(color) {
  const body = JSON.stringify({ application_name: "app.test.lights", led_notification_color: `${color}FF`, elements: [{ id: "t", type: "text", text: "LED", font: "small", x: 0, y: 0, display: "front" }] });
  const before = Date.now();
  const answer = await fetch(`http://127.0.0.1:${PORTS.app}/api/display/draw`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(answer.status, 200);
  const state = (await (await fetch(`http://127.0.0.1:${PORTS.app}/_emu/state`)).json()).lights;
  assert.equal(state.preset, "notification");
  // The server's own count, read back now; the draw was answered as the notification started.
  const started = Date.now() - state.elapsed;
  assert.ok(started >= before - 50, `started ${started - before} ms after the draw was sent`);
  return started;
}

// The flat LEDs as the page shows them: lit (the class), the glow on the outer box (computed), the light's opacity.
const FLAT = `(() => {
  const led = document.querySelector("#led-left");
  return { lit: led.classList.contains("lit"), filter: getComputedStyle(led).filter, light: getComputedStyle(led.querySelector(".led-light")).opacity, at: Date.now() };
})()`;
// Every change of the flat LED's class from now on, with this computer's time.
const WATCH = `(() => {
  const led = document.querySelector("#led-left");
  const log = (window.ledLog = [{ lit: led.classList.contains("lit"), at: Date.now() }]);
  new MutationObserver(() => log.push({ lit: led.classList.contains("lit"), at: Date.now() })).observe(led, { attributes: true, attributeFilter: ["class"] });
  return true;
})()`;

const reload = async () => {
  await app.run((shell) => shell.windows.current.win.webContents.reload());
  await until(() => app.page("document.readyState === 'complete' && typeof window.emulatorStage3D === 'object'").catch(() => false), "the device window after a reload");
};

/** The readings, as [ms into the notification, lit], each one on the side of an edge the timeline says. */
function assertOnTimeline(readings, what) {
  for (const [t, lit] of readings) {
    if (EDGES.some((edge) => Math.abs(t - edge) < MARGIN_MS)) continue;
    assert.equal(lit, litAt(t), `${what}: ${lit ? "lit" : "dark"} ${Math.round(t)} ms into the notification: ${JSON.stringify(readings.map(([at, on]) => [Math.round(at), on]))}`);
  }
}

test("a draw with led_notification_color blinks the flat LEDs three times on the firmware's edges, and then they are fully dark", { skip: skipAll }, async () => {
  assert.equal((await app.page(FLAT)).lit, false, "dark at first");
  await app.page(WATCH);
  const started = await notify("#00FF00");
  await sleep(started + 2500 + 400 - Date.now());
  const log = await app.page("window.ledLog");
  // The changes after the draw: on, off, on, off, on, off, each at its edge.
  const changes = log.slice(1).map(({ lit, at }) => [at - started, lit]);
  assert.deepEqual(changes.map(([, lit]) => lit), [true, false, true, false, true, false], JSON.stringify(changes));
  changes.forEach(([t], i) => assert.ok(Math.abs(t - EDGES[i]) < MARGIN_MS, `edge ${i} at ${Math.round(t)} ms, not ${EDGES[i]}: ${JSON.stringify(changes)}`));
  // Nothing of it is left: no lit class, no glow, no light (the bug of 17.11: the glow stayed on).
  assert.deepEqual(await app.page(FLAT).then(({ lit, filter, light }) => ({ lit, filter, light })), { lit: false, filter: "none", light: "0" });
});

test("a page reloaded in the middle of a notification shows the step it is at; reloaded after it, nothing of it", { skip: skipAll }, async () => {
  const started = await notify("#2B7FFF");
  await sleep(started + 700 - Date.now());
  await reload();
  await app.page(WATCH);
  const readings = [];
  while (Date.now() < started + 3000) {
    const { lit, at } = await app.page(FLAT);
    readings.push([at - started, lit]);
    await sleep(60);
  }
  assert.ok(readings.some(([t, lit]) => lit && t < 2500), `lit again before the end: ${JSON.stringify(readings)}`);
  assertOnTimeline(readings, "after the reload");
  // Over: a page that opens now shows nothing of it, and nothing comes after.
  await reload();
  await app.page(WATCH);
  await sleep(800);
  assert.equal((await app.page(FLAT)).lit, false);
  assert.deepEqual((await app.page("window.ledLog")).map(({ lit }) => lit), [false], "nothing lit after the notification");
});

test("the 3D view that comes up during a notification shows the step it is at, and one that comes up after it shows nothing", { skip: skipAll }, async (t) => {
  if (!(await app.page("window.emulatorStage3D.available()"))) return t.skip(`no WebGL2 in this run's hidden window: ${await app.page("window.emulatorStage3D.reason")}`);
  if (stalled()) return t.skip(stalled());
  const mount = () =>
    app.page(`(async () => {
      const box = document.querySelector("#bar");
      for (const child of box.children) child.style.display = "none";
      try { await window.emulatorStage3D.mount(box); return "mounted"; } catch (e) { return "failed: " + e.message; }
    })()`);
  const level = async () => {
    const { lights } = await app.page("window.emulatorStage3D.ask({ type: 'probe' })");
    return lights?.led_left_level ?? 0;
  };
  // Up during it: the view is told the notification with its age when it is ready (mount.js), not as a new one.
  const started = await notify("#00FF00");
  assert.equal(await mount(), "mounted");
  const readings = [];
  while (Date.now() < started + 3200) {
    const at = Date.now();
    readings.push([at - started, (await level()) > 0]);
    await sleep(60);
  }
  assertOnTimeline(readings, "in the 3D view");
  assert.equal(await level(), 0, "dark after the notification");
  // Up again after it: dark, and it stays dark.
  await app.page("window.emulatorStage3D.unmount()");
  assert.equal(await mount(), "mounted");
  for (let i = 0; i < 8; i++) {
    assert.equal(await level(), 0, `${i * 100} ms after the view came up again`);
    await sleep(100);
  }
  await app.page("window.emulatorStage3D.unmount()");
  await reload();
});

test("a brightness set during a notification dims the blink in the 3D view as in the flat view", { skip: skipAll }, async (t) => {
  if (!(await app.page("window.emulatorStage3D.available()"))) return t.skip(`no WebGL2 in this run's hidden window: ${await app.page("window.emulatorStage3D.reason")}`);
  if (stalled()) return t.skip(stalled());
  const base = `http://127.0.0.1:${PORTS.app}`;
  const brightness = async (value) => assert.equal((await fetch(`${base}/api/display/brightness?value=${value}`, { method: "POST" })).status, 200);
  await brightness(100);
  try {
    assert.equal(
      await app.page(`(async () => { const box = document.querySelector("#bar"); for (const c of box.children) c.style.display = "none"; await window.emulatorStage3D.mount(box); return "mounted"; })()`),
      "mounted",
    );
    const level3d = async () => (await app.page("window.emulatorStage3D.ask({ type: 'probe' })")).lights?.led_left_level ?? 0;
    const flatFilter = () => app.page(`document.querySelector("#led-left").style.getPropertyValue("--led-filter")`);
    const started = await notify("#00FF00");
    await sleep(started + 1100 - Date.now()); // the second blink, at full
    const fullFlat = await flatFilter();
    const full3d = await level3d();
    assert.equal(full3d, 1, "the second blink at full in 3D");
    await brightness(0);
    const state = (await (await fetch(`${base}/_emu/state`)).json()).lights;
    assert.ok(Number.isFinite(state.set) && state.brightness === 0.05, JSON.stringify(state));
    await sleep(100); // still inside the second blink (it ends at 1500 ms)
    assert.ok(Date.now() - started < 1450, "still in the second blink");
    assert.notEqual(await flatFilter(), fullFlat, "the flat view dims the blink");
    const dimmed = await level3d();
    assert.ok(dimmed > 0 && dimmed < full3d, `the 3D view dims it too: level ${dimmed}`);
    // The third blink is at full again in both.
    await sleep(started + 2150 - Date.now());
    assert.equal(await level3d(), 1);
    assert.equal(await flatFilter(), fullFlat);
  } finally {
    await app.page("window.emulatorStage3D.mounted && window.emulatorStage3D.unmount()");
    await brightness("auto");
    await reload();
  }
});
