// The status lights, the bar's two RGB LEDs beside Start / Pause, through the real paths on each firmware: the
// firmware's status_lights_run_preset() in the screen module (emu_screen.c) tells the server, which keeps the state,
// sends it as the event "lights" of /_emu/events and gives it in /_emu/state (device.mjs, lightsState), with how long
// the preset has run (elapsed), by the computer's monotonic clock.
//   - an app's POST /api/display/draw with led_notification_color: a notification of that color at full brightness,
//     dark 2.5 s later (status_lights/presets/blink.c), however the BUSY Bar's clock is moved meanwhile;
//   - the BUSY timer started: static red 150, 0, 0 (busy_timer_status_lights.c), paused: off;
//   - POST /api/display/brightness: the level the lights run at, round(5 + 85 × setting / 100) %;
//   - a window that connects gets the state as it is; a restart puts the lights out.
import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, test } from "node:test";

import { Device } from "../../packages/server/device.mjs";
import { loadFirmware } from "../../packages/server/firmware.mjs";
import { LIGHT_PRESETS } from "../../packages/server/legacy-window/status-lights.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, installApp, port, request, tempDir, until } from "./helpers.mjs";

after(finish);

const FIRMWARES = ["1.4.1", "1.3.1"];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(t, firmware) {
  const lines = [];
  const emulator = await startServer({ port: port(0), dataDir: tempDir(t), firmware, log: (line) => lines.push(line) });
  t.after(() => emulator.stop());
  return Object.assign(emulator, { lines });
}

/** The "lights" events of a window's stream, as they come: { list, close }. */
function watchLights(t, emulator) {
  const list = [];
  const req = http.get(`${emulator.url}/_emu/events`, { agent: false, headers: { Accept: "text/event-stream" } }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event === "lights") list.push({ ...JSON.parse(data), at: Date.now() });
      }
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  const close = () => req.destroy();
  t.after(close);
  return { list, close };
}

const stateLights = async (emulator) => (await get(`${emulator.url}/_emu/state`)).json().lights;
const plain = ({ preset, color, brightness }) => ({ preset, color, brightness });

describe("the status lights", () => {
  for (const firmware of FIRMWARES) {
    test(`${firmware}: an app's draw with led_notification_color blinks that color, dark 2.5 s later`, async (t) => {
      const emulator = await start(t, firmware);
      const window = watchLights(t, emulator);
      await until("the window's first lights", () => window.list.length > 0);
      // Nothing has lit them yet: off, at the brightness automatic stands for (half: 5 + 85 × 0.5 = 47.5, so 48 %).
      assert.deepEqual(plain(window.list[0]), { preset: "off", color: "#000000", brightness: 0.48 });

      const id = "app.test.lights";
      const script = `
        fetch("http://localhost/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          application_name: "${id}", led_notification_color: "#FF8000FF",
          elements: [{ id: "t", type: "text", text: "LED", font: "small", x: 0, y: 0, display: "front" }],
        }) }).then(function (r) { console.log("drawn " + r.status); });
        setInterval(function () {}, 1000);`;
      await installApp(emulator.url, id, script);
      assert.equal((await request("POST", `${emulator.url}/api/apps/launch?app_id=${id}`)).status, 200);
      const lit = await until("the notification", () => window.list.find((l) => l.preset === "notification"));
      // The color without its alpha, at full brightness whatever the setting: the preset overrides it. Told as it
      // starts.
      assert.deepEqual(plain(lit), { preset: "notification", color: "#ff8000", brightness: 1 });
      assert.ok(lit.elapsed >= 0 && lit.elapsed < 100, `elapsed ${lit.elapsed}`);
      // When it started, by this test's clock: the stream's events and the state say the same moment.
      const started = lit.at - lit.elapsed;
      const near = (lights, what) => assert.ok(Math.abs(lights.at - lights.elapsed - started) < 150, `${what}: ${JSON.stringify(lights)}, started ${started}`);
      await until("the draw's answer", () => emulator.lines.some((line) => line.includes("drawn 200")));
      const state = { ...(await stateLights(emulator)), at: Date.now() };
      assert.deepEqual(plain(state), plain(lit));
      near(state, "the state");

      // A window that opens during it gets it as it is, at the step it is at.
      const late = watchLights(t, emulator);
      await until("the late window's lights", () => late.list.length > 0);
      assert.deepEqual(plain(late.list[0]), plain(lit));
      near(late.list[0], "a late window");
      late.close();

      // The BUSY Bar's clock moved meanwhile, on (busy-emulator time advance) and back (time set, time reset): the
      // lights run on the computer's time, as on the bar's other processor, and the notification is neither cut nor
      // stretched.
      assert.equal((await request("POST", `${emulator.url}/_emu/time?pass=30000`)).status, 200);
      assert.equal((await request("POST", `${emulator.url}/api/time/timestamp?timestamp=${new Date(Date.now() - 3_600_000).toISOString().slice(0, 19)}Z`)).status, 200);
      if (Date.now() - started < 2300) assert.equal((await stateLights(emulator)).preset, "notification", "an advance does not end it");

      // Three blinks of a second, the last dark half from 2.5 s: then the lights are out (the window runs the blinks).
      await until("the lights to go out", async () => (await stateLights(emulator)).preset === "off", 6000);
      const out = Date.now() - started;
      assert.ok(out >= 2450 && out < 2900, `out after ${out} ms`);
      const dark = { ...(await stateLights(emulator)), at: Date.now() };
      assert.deepEqual(plain(dark), { preset: "off", color: "#000000", brightness: 0.48 });
      // Off since the notification went dark.
      assert.ok(Math.abs(dark.at - dark.elapsed - (started + 2500)) < 150, JSON.stringify(dark));
      // Nothing is sent for the end: the window darkens by itself, at the same moment.
      assert.equal(window.list.length, 2, JSON.stringify(window.list));
      const fresh = watchLights(t, emulator);
      await until("a new window's lights", () => fresh.list.length > 0);
      assert.equal(fresh.list[0].preset, "off");
    });

    test(`${firmware}: the BUSY timer lights them red, the brightness setting dims them, a restart puts them out`, async (t) => {
      const emulator = await start(t, firmware);
      const window = watchLights(t, emulator);
      await until("the window's first lights", () => window.list.length > 0);
      assert.equal((await request("POST", `${emulator.url}/api/display/brightness?value=100`)).status, 200);
      // Off at another level is not news: nothing is sent.
      await pause(100);
      assert.equal(window.list.length, 1);

      assert.equal((await request("POST", `${emulator.url}/api/input?key=busy`)).status, 200);
      await pause(500);
      assert.equal((await request("POST", `${emulator.url}/api/input?key=start`)).status, 200);
      const red = await until("the timer's red", () => window.list.find((l) => l.preset === "static"), 8000);
      assert.deepEqual(plain(red), { preset: "static", color: "#960000", brightness: 0.9 });

      assert.equal((await request("POST", `${emulator.url}/api/display/brightness?value=0`)).status, 200);
      const dim = await until("the dimmer red", () => window.list.find((l) => l.brightness === 0.05));
      assert.deepEqual(plain(dim), { preset: "static", color: "#960000", brightness: 0.05 });
      assert.equal((await request("POST", `${emulator.url}/api/display/brightness?value=auto`)).status, 200);
      await until("the red at automatic", () => window.list.at(-1).brightness === 0.48);
      assert.deepEqual(plain(await stateLights(emulator)), { preset: "static", color: "#960000", brightness: 0.48 });

      // A window that opens now sees the red.
      const late = watchLights(t, emulator);
      await until("the late window's lights", () => late.list.length > 0);
      assert.deepEqual(plain(late.list[0]), { preset: "static", color: "#960000", brightness: 0.48 });
      late.close();

      // Paused, the timer puts them out.
      const before = window.list.length;
      assert.equal((await request("POST", `${emulator.url}/api/input?key=start`)).status, 200);
      const paused = await until("the pause", () => window.list.slice(before).find((l) => l.preset === "off"), 8000);
      assert.equal(paused.color, "#000000");
      assert.equal((await request("POST", `${emulator.url}/api/input?key=start`)).status, 200);
      await until("the red again", () => window.list.slice(before).find((l) => l.preset === "static"), 8000);

      // A restart: the lights go out with the system.
      const lit = window.list.length;
      assert.equal((await request("POST", `${emulator.url}/_emu/power?action=restart`)).status, 200);
      await until("the lights out", () => window.list.slice(lit).find((l) => l.preset === "off"), 15000);
      await until("the bar up again", async () => (await get(`${emulator.url}/api/version`).catch(() => ({ status: 0 }))).status === 200, 15000);
    });
  }
});

test("a program's hold on the lights' brightness (pairing: full) is the level while it holds, and only a lit preset is news", (t) => {
  const device = new Device({ dataDir: tempDir(t), log: () => {}, firmware: loadFirmware(), sidecars: false });
  const sent = [];
  device.events.on("lights", ({ elapsed, ...lights }) => sent.push(lights));
  const blink = LIGHT_PRESETS.indexOf("blink");
  // ble_settings' pairing screen: the override first, then the blink; on its way out the lights off, then no override.
  device.lightsChanged(blink, [0, 0, 0], 100, false);
  assert.deepEqual(sent, [], "an override with nothing lit says nothing");
  device.lightsChanged(blink, [0, 0x40, 0xff], 100, true);
  assert.deepEqual(sent.at(-1), { preset: "blink", color: "#0040ff", brightness: 0.9 });
  device.state.brightness = "10";
  device.showLights(false);
  assert.equal(sent.length, 1, "the setting does not reach lights a program holds");
  device.lightsChanged(blink, [0, 0x40, 0xff], -1, false);
  assert.deepEqual(sent.at(-1), { preset: "blink", color: "#0040ff", brightness: 0.14 });
  device.lightsChanged(LIGHT_PRESETS.indexOf("off"), [0, 0, 0], -1, true);
  assert.deepEqual(sent.at(-1), { preset: "off", color: "#000000", brightness: 0.14 });
  // A second notification is sent although the first is the same: it blinks again.
  const notification = LIGHT_PRESETS.indexOf("notification");
  device.lightsChanged(notification, [255, 0, 0], -1, true);
  device.lightsChanged(notification, [255, 0, 0], -1, true);
  assert.deepEqual(sent.slice(-2), [{ preset: "notification", color: "#ff0000", brightness: 1 }, { preset: "notification", color: "#ff0000", brightness: 1 }]);
});

test("the state tells how long the preset has run by the lights' clock; a notification is off from 2.5 s, and a brightness change does not start a preset over", (t) => {
  const device = new Device({ dataDir: tempDir(t), log: () => {}, firmware: loadFirmware(), sidecars: false });
  let now = 1000;
  device.lightsNow = () => now;
  const sent = [];
  device.events.on("lights", (lights) => sent.push(lights));
  device.lightsChanged(LIGHT_PRESETS.indexOf("notification"), [0, 255, 0], -1, true);
  assert.deepEqual(sent.at(-1), { preset: "notification", color: "#00ff00", brightness: 1, elapsed: 0 });
  // Rounded down, as the views count: 2499.6 ms is still the last blink, not its end.
  now += 2499.6;
  assert.deepEqual(device.lightsState(), { preset: "notification", color: "#00ff00", brightness: 1, elapsed: 2499 });
  now += 0.4;
  assert.deepEqual(device.lightsState(), { preset: "off", color: "#000000", brightness: 0.48, elapsed: 0 });
  now += 60_000;
  assert.deepEqual(device.lightsState(), { preset: "off", color: "#000000", brightness: 0.48, elapsed: 60_000 });
  // The BUSY timer's red; the brightness changes 1.25 s in: the event says the new level and the same start.
  device.lightsChanged(LIGHT_PRESETS.indexOf("blink"), [150, 0, 0], -1, true);
  now += 1250;
  device.state.brightness = "100";
  device.lightsBrightnessSet();
  assert.deepEqual(sent.at(-1), { preset: "blink", color: "#960000", brightness: 0.9, elapsed: 1250 });
  assert.equal(sent.length, 3);
});

test("a brightness change during a notification is told with its moment: that blink runs at the new level until the next one", (t) => {
  const device = new Device({ dataDir: tempDir(t), log: () => {}, firmware: loadFirmware(), sidecars: false });
  let now = 0;
  device.lightsNow = () => now;
  const sent = [];
  device.events.on("lights", (lights) => sent.push(lights));
  device.lightsChanged(LIGHT_PRESETS.indexOf("notification"), [0, 255, 0], -1, true);
  now = 1200;
  device.state.brightness = "10";
  device.lightsBrightnessSet();
  assert.deepEqual(sent.at(-1), { preset: "notification", color: "#00ff00", brightness: 0.14, elapsed: 1200, set: 1200 });
  now = 1499;
  assert.deepEqual(device.lightsState(), { preset: "notification", color: "#00ff00", brightness: 0.14, elapsed: 1499, set: 1200 });
  // The next run is at full again, and so is the state.
  now = 2000;
  assert.deepEqual(device.lightsState(), { preset: "notification", color: "#00ff00", brightness: 1, elapsed: 2000 });
  now = 2500;
  assert.equal(device.lightsState().preset, "off");
});

test("a change of the setting while a program holds the lights' brightness is a set too, at the held level (brightness_control.c, apply_brightness)", (t) => {
  const device = new Device({ dataDir: tempDir(t), log: () => {}, firmware: loadFirmware(), sidecars: false });
  let now = 0;
  device.lightsNow = () => now;
  const sent = [];
  device.events.on("lights", (lights) => sent.push(lights));
  // A program holds the lights at 10 (14 %), then a notification starts: its blinks at full.
  device.lightsChanged(LIGHT_PRESETS.indexOf("off"), [0, 0, 0], 10, false);
  device.lightsChanged(LIGHT_PRESETS.indexOf("notification"), [0, 255, 0], 10, true);
  assert.deepEqual(sent.at(-1), { preset: "notification", color: "#00ff00", brightness: 1, elapsed: 0 });
  // The setting changes to 100: status_lights_set_brightness with the held 10, so that blink runs at 14 %.
  now = 250;
  device.settingChanged("brightness", "100"); // the way the firmware's settings tell the host
  assert.deepEqual(sent.at(-1), { preset: "notification", color: "#00ff00", brightness: 0.14, elapsed: 250, set: 250 });
});

test("the lights go out with the system in the middle of a notification, and the views are told; after its end they are not", (t) => {
  const device = new Device({ dataDir: tempDir(t), log: () => {}, firmware: loadFirmware(), sidecars: false });
  let now = 1000;
  device.lightsNow = () => now;
  const sent = [];
  device.events.on("lights", (lights) => sent.push(lights.preset));
  device.screen = { dispose() {} }; // not started: shutdown() only needs something to dispose
  device.lightsChanged(LIGHT_PRESETS.indexOf("notification"), [0, 255, 0], -1, true);
  now += 700;
  device.shutdown(); // what a power off, a restart and a switch of the firmware do first
  assert.deepEqual(sent, ["notification", "off"], "told 0.7 s in");
  // Over already: the views ran it to its end, nothing to tell.
  device.lightsChanged(LIGHT_PRESETS.indexOf("notification"), [0, 255, 0], -1, true);
  now += 2600;
  device.shutdown();
  assert.deepEqual(sent, ["notification", "off", "notification"]);
});
