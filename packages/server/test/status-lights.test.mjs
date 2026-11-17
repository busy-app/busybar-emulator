// The status lights' timeline (legacy-window/status-lights.mjs) against the firmware's code: what the LEDs show at
// a moment of each preset, worked out by hand from applications/services/status_lights (status_lights_backend.c and
// presets/*.c, the same in 1.3.1 and 1.4.1) and lib/toolbox/color.c. By the firmware's code; not measured on a BUSY Bar.
import assert from "node:assert/strict";
import { test } from "node:test";

import { LIGHT_PRESETS, lightsAt, lightsLevel, parseLights, PRESETS, redrawDelay, statusLedLook, VIEW_STEP_MS } from "../legacy-window/status-lights.mjs";

const at = (preset, rgb, elapsed, brightness = 0.48, options) => lightsAt({ preset, rgb, brightness }, elapsed, options);

test("the presets are the firmware's StatusLightsPreset in its order, with its periods and repeat counts", () => {
  assert.deepEqual(LIGHT_PRESETS, ["off", "static", "fade", "rainbow", "blink", "notification"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(PRESETS).map(([name, { period, runs, full, end }]) => [name, [period, runs, full, end]])),
    { static: [1000, Infinity, false, Infinity], fade: [10, Infinity, false, Infinity], rainbow: [16, Infinity, false, Infinity], blink: [500, Infinity, false, Infinity], notification: [500, 6, true, 2500] },
  );
});

test("a notification: on at 0, 1000 and 2000 ms for half a second each, at full brightness; dark from 2500 ms on, for good", () => {
  const red = [255, 0, 0];
  const edges = [];
  for (let t = 0; t <= 4000; t += 5) {
    const { rgb, level } = at("notification", red, t, 0.05);
    const lit = rgb[0] > 0 && level > 0;
    if (lit) assert.equal(level, 1, `${t} ms: override_brightness`);
    if (edges.length === 0 ? lit : edges.at(-1).lit !== lit) edges.push({ t, lit });
  }
  assert.deepEqual(edges, [{ t: 0, lit: true }, { t: 500, lit: false }, { t: 1000, lit: true }, { t: 1500, lit: false }, { t: 2000, lit: true }, { t: 2500, lit: false }]);
  // The next change is each run's edge; the last one is the end, and after it nothing changes.
  assert.deepEqual([0, 499, 500, 2000, 2499].map((t) => at("notification", red, t).next), [500, 500, 1000, 2500, 2500]);
  for (const t of [2500, 2501, 10_000, 1e9]) assert.deepEqual(at("notification", red, t), { rgb: [0, 0, 0], level: 0, next: null, ended: true }, `${t} ms`);
  assert.equal(at("notification", red, 2499).ended, false);
});

test("a blink goes on without end: the color first, half a second each, at the brightness setting's level", () => {
  const blue = [0, 0x40, 0xff];
  for (const [t, rgb] of [[0, blue], [499, blue], [500, [0, 0, 0]], [1000, blue], [3_600_000, blue], [3_600_500, [0, 0, 0]]]) {
    const now = at("blink", blue, t, 0.14);
    assert.deepEqual([now.rgb, now.level, now.ended], [rgb, 0.14, false], `${t} ms`);
  }
  assert.equal(at("blink", blue, 3_600_250).next, 3_600_500);
});

test("a fade steps every 10 ms through the firmware's uint8 counter: up to 128, down, a dark run, round again in 2.56 s", () => {
  // color / 128 × brightness, in integers: 255 and 200 follow, 100 stays dark.
  const color = [255, 200, 100];
  const runs = { 0: 1, 1: 2, 126: 127, 127: 128, 128: 127, 129: 126, 254: 1, 255: 0, 256: 1, 383: 128 };
  for (const [n, brightness] of Object.entries(runs)) {
    for (const into of [0, 9]) assert.deepEqual(at("fade", color, Number(n) * 10 + into).rgb, [brightness, brightness, 0], `run ${n}, ${into} ms into it`);
  }
  assert.equal(at("fade", color, 1273).next, 1280);
  // Not 2.5 s: the 250th run, at 2500 ms, is at 5.
  assert.deepEqual(at("fade", color, 2500).rgb, [5, 5, 0]);
  for (let t = 0; t < 2560; t += 7) assert.deepEqual(at("fade", color, t + 2560).rgb, at("fade", color, t).rgb, `${t} ms`);
});

test("the rainbow turns the hue counter once every 16 ms at saturation 255, value 16: a round of 4.096 s", () => {
  // color_hsv_to_rgb by hand: h 1 (the first run) is red; h 42, the end of region 0, has green at 15; h 87 is green; h 0
  // (the 256th run, the counter wrapped) red again.
  for (const [n, rgb] of [[0, [16, 0, 0]], [41, [16, 15, 0]], [86, [0, 16, 0]], [171, [0, 0, 16]], [255, [16, 0, 0]], [256, [16, 0, 0]]]) {
    assert.deepEqual(at("rainbow", [0, 0, 0], n * 16 + 15).rgb, rgb, `run ${n}`);
  }
  for (let t = 0; t < 4096; t += 13) assert.deepEqual(at("rainbow", [0, 0, 0], t + 4096).rgb, at("rainbow", [0, 0, 0], t).rgb, `${t} ms`);
  assert.equal(at("rainbow", [0, 0, 0], 4095).next, 4096);
  // Not 4 s: the 250th run, at 4000 ms, is still short of red (h 251).
  assert.deepEqual(at("rainbow", [0, 0, 0], 4000).rgb, [16, 0, 2]);
});

test("the brightness set during a notification dims the run it comes in, until the next run puts it back at full (status_lights_do_set_brightness)", () => {
  const set = (t, ms) => lightsAt({ preset: "notification", rgb: [0, 255, 0], brightness: 0.14, set: ms }, t);
  // Set 1.2 s in, during the second blink: full before it, 0.14 after it, full again at the third blink.
  assert.deepEqual([1100, 1200, 1499, 2000].map((t) => set(t, 1200).level), [1, 0.14, 0.14, 1]);
  // During a dark run it changes nothing that shows; the next blink is at full.
  assert.deepEqual([set(700, 600).rgb, set(1000, 600).level], [[0, 0, 0], 1]);
  // Told before it comes (a view a moment behind), the change is the next one.
  assert.equal(set(1100, 1200).next, 1200);
  // A blink without full brightness runs at the setting's level anyway.
  assert.equal(lightsAt({ preset: "blink", rgb: [0, 255, 0], brightness: 0.14, set: 100 }, 50).level, 0.14);
});

test("a static color holds; off and what is not a preset are dark; less motion holds the fade and the rainbow on one run", () => {
  assert.deepEqual(at("static", [150, 0, 0], 10_000_000), { rgb: [150, 0, 0], level: 0.48, next: null, ended: false });
  for (const preset of ["off", "lava", undefined]) assert.deepEqual(at(preset, [255, 0, 0], 100), { rgb: [0, 0, 0], level: 0, next: null, ended: false });
  assert.deepEqual(at("fade", [255, 255, 255], 2555, 0.9, { still: true }), { rgb: [128, 128, 128], level: 0.9, next: null, ended: false });
  assert.deepEqual(at("rainbow", [0, 0, 0], 1376, 0.48, { still: true }).rgb, [16, 0, 0]);
  // The blinks say something: they are not held.
  assert.deepEqual(at("notification", [0, 255, 0], 600, 1, { still: true }).rgb, [0, 0, 0]);
  assert.equal(at("notification", [0, 255, 0], 2600, 1, { still: true }).ended, true);
});

test("the level is the firmware's status_lights_curve: 5 to 90 % of the brightness setting", () => {
  assert.deepEqual([0, 10, 50, 100, -5, 200].map(lightsLevel), [0.05, 0.14, 0.48, 0.9, 0.05, 0.9]);
});

test("the event's state is checked, and a view draws again at the next change, at most 25 times a second for the fast presets", () => {
  assert.deepEqual(parseLights({ preset: "blink", color: "#00FF00", brightness: 0.5, elapsed: 750 }), { preset: "blink", rgb: [0, 255, 0], brightness: 0.5, elapsed: 750, set: null });
  assert.deepEqual(parseLights({ preset: "notification", color: "#00FF00", brightness: 0.14, elapsed: 1250, set: 1200 }).set, 1200);
  assert.deepEqual(parseLights(null), { preset: "off", rgb: [0, 0, 0], brightness: 1, elapsed: 0, set: null });
  assert.deepEqual(parseLights({ preset: "lava", color: "red", brightness: 7, elapsed: -3, set: -1 }), { preset: "off", rgb: [0, 0, 0], brightness: 1, elapsed: 0, set: null });
  assert.equal(redrawDelay("notification", 2000.4, 2500), 501);
  assert.equal(redrawDelay("blink", 999.9, 1000), 2);
  assert.equal(redrawDelay("fade", 1273, 1280), VIEW_STEP_MS);
  assert.equal(redrawDelay("rainbow", 4095, 4096), VIEW_STEP_MS);
  assert.equal(redrawDelay("static", 0, null), null);
});

test("a status LED shows its hue at full strength, lit as the eye sees the firmware's PWM: plainly on, never off while lit", () => {
  // The BUSY timer's red, 150 of 255, at the default brightness (0.48): 15 % PWM, fully lit on screen.
  assert.deepEqual(statusLedLook([150, 0, 0], 0.48), { hue: [255, 0, 0], glow: 1, halo: 0.5329 });
  // The rest's green keeps its hue.
  assert.deepEqual(statusLedLook([10, 150, 5], 0.48).hue, [17, 255, 9]);
  // The lowest brightness the setting gives (5 %): about half.
  assert.equal(statusLedLook([150, 0, 0], 0.05).glow, 0.4499);
  // The rainbow (its largest channel 16): dimmer than the timer, still visible.
  const rainbow = statusLedLook(at("rainbow", [0, 0, 0], 0).rgb, 0.48);
  assert.ok(rainbow.glow > 0.6 && rainbow.glow < 0.7 && rainbow.halo < 0.3, JSON.stringify(rainbow));
  // More brightness, a wider halo.
  assert.ok(statusLedLook([150, 0, 0], 0.9).halo > statusLedLook([150, 0, 0], 0.48).halo);
  // Black or level 0: dark.
  assert.equal(statusLedLook([0, 0, 0], 1), null);
  assert.equal(statusLedLook([255, 0, 0], 0), null);
});
