// The status lights, the bar's two RGB LEDs beside Start / Pause, through the real paths on each firmware: the
// firmware's status_lights_run_preset() in the screen module (emu_screen.c) tells the server, which keeps the state,
// sends it as the event "lights" of /_emu/events and gives it in /_emu/state (device.mjs, lightsState).
//   - an app's POST /api/display/draw with led_notification_color: a notification of that color at full brightness,
//     dark 2.5 s later (status_lights/presets/blink.c);
//   - the BUSY timer started: static red 150, 0, 0 (busy_timer_status_lights.c), paused: off;
//   - POST /api/display/brightness: the level the lights run at, round(5 + 85 × setting / 100) %;
//   - a window that connects gets the state as it is; a restart puts the lights out.
import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, test } from "node:test";

import { Device, LIGHT_PRESETS } from "../../packages/server/device.mjs";
import { loadFirmware } from "../../packages/server/firmware.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { finish, get, installApp, port, request, tempDir, until } from "./helpers.mjs";

after(finish);

const FIRMWARES = ["1.3.1", "dev"];
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
      // The color without its alpha, at full brightness whatever the setting: the preset overrides it.
      assert.deepEqual(plain(lit), { preset: "notification", color: "#ff8000", brightness: 1 });
      await until("the draw's answer", () => emulator.lines.some((line) => line.includes("drawn 200")));
      assert.deepEqual(await stateLights(emulator), plain(lit));

      // A window that opens during it gets it as it is.
      const late = watchLights(t, emulator);
      await until("the late window's lights", () => late.list.length > 0);
      assert.deepEqual(plain(late.list[0]), plain(lit));
      late.close();

      // Three blinks of a second, the last dark half from 2.5 s: then the lights are out (the window runs the blinks).
      await until("the lights to go out", async () => (await stateLights(emulator)).preset === "off", 6000);
      const out = Date.now() - lit.at;
      assert.ok(out >= 2400, `out after ${out} ms`);
      assert.deepEqual(await stateLights(emulator), { preset: "off", color: "#000000", brightness: 0.48 });
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
      assert.deepEqual(await stateLights(emulator), { preset: "static", color: "#960000", brightness: 0.48 });

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
  device.events.on("lights", (lights) => sent.push(lights));
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
