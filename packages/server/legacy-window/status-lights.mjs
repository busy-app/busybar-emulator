// The BUSY Bar's status lights, its two RGB LEDs beside Start / Pause, as the firmware runs them over time. One
// timeline for everything that shows or tells them: the server (device.mjs: /_emu/state and the event "lights"), the
// flat view (window.js) and the 3D view (packages/stage/frame/stage.js, which gets this file at
// /emulator/stage3d/frame/status-lights.mjs: stage3d.mjs). It imports nothing and touches nothing: plain functions of
// the state the event "lights" gives and of the ms since the firmware started the preset.
//
// The firmware, applications/services/status_lights (the same in 1.3.1 and 1.4.1). status_lights_run_preset() hands
// the preset to the BUSY Bar's other processor, where status_lights_backend.c runs it in real time: the preset's run()
// at once, then every period_ms on a periodic timer (status_lights_do_run_preset, status_lights_run_pattern). Each run
// gives the color the LEDs show until the next one. A preset with repeat_count > 0 stops after that many runs, and the
// PWM stops with it: the lights are dark, and the preset that ran before is not brought back. The PWM is the color
// scaled by the brightness the lights run at (status_lights_scale_component): the brightness setting through
// status_lights_curve, 5 to 90 % (brightness_conv.c), or full for a preset with override_brightness. The firmware's
// heap hands out zeroed memory (memmgr_heap.c), so every preset's counter starts at 0.

/** The firmware's StatusLightsPreset by number (status_lights_common.h), by the names the emulator gives them. */
export const LIGHT_PRESETS = Object.freeze(["off", "static", "fade", "rainbow", "blink", "notification"]);

/**
 * Each preset as status_lights_preset_defs.c lists it: `period` is its period_ms, `runs` its repeat_count (Infinity
 * for REPEAT_INFINITE), `full` its override_brightness. `end` is when a preset that stops is dark for good: its last
 * run, at (runs - 1) × period, gives the color it gives (a blink's dark) and stops the PWM
 * (status_lights_run_pattern). `still` is, for a preset that never holds still, the run a view shows when it is asked
 * for less motion. Off has no preset: the PWM stops at once.
 */
const described = ({ period, runs = Infinity, full = false, still }) => Object.freeze({ period, runs, full, end: (runs - 1) * period, ...(still === undefined ? {} : { still }) });
export const PRESETS = Object.freeze({
  // presets/static_color.c: the same color at every run.
  static: described({ period: 1000 }),
  // presets/fade.c: up and down in 256 runs of 10 ms, 2.56 s; held still at its brightest run.
  fade: described({ period: 10, still: 127 }),
  // presets/rainbow_gradient.c: round the hues in 256 runs of 16 ms, 4.096 s; held still at its first color, red.
  rainbow: described({ period: 16, still: 0 }),
  // presets/blink.c: the color and dark by turns, the color first.
  blink: described({ period: 500 }),
  // presets/blink.c, status_lights_preset_notification: the same runs, six of them ("6 tick periods -> 3 blinks"):
  // on 0 to 500 ms, dark, on 1000 to 1500, dark, on 2000 to 2500, dark from the sixth run at 2500 ms on.
  notification: described({ period: 500, runs: 6, full: true }),
});

const DARK = Object.freeze([0, 0, 0]);

/**
 * The level the lights run at, 0..1, for the brightness setting 0..100: status_lights_curve in brightness_conv.c
 * (min 5, max 90, power 0: roundf(5 + 85 × setting / 100)), over 100 as status_lights_normalize_brightness takes it.
 */
export function lightsLevel(setting) {
  const user = Math.min(100, Math.max(0, Number(setting) || 0));
  return Math.round(5 + (85 * user) / 100) / 100;
}

/** presets/fade.c, fade_run: the brightness of run `n`, 0..128, by its uint8 counter as the C code has it. */
function fadeBrightness(n) {
  const tick = n % 256; // instance->tick before the run
  const after = (tick + 1) % 256; // instance->tick++ is done before the branch reads it again
  return tick < 128 ? after : (256 - after) % 256; // stored in a uint8_t: 256 is 0
}

/** lib/toolbox/color.c, color_hsv_to_rgb, in its integer steps. */
function hsvToRgb(h, s, v) {
  if (s === 0) return [v, v, v];
  const region = Math.floor(h / 43);
  const remainder = (h % 43) * 6;
  const p = (v * (255 - s)) >> 8;
  const q = (v * (255 - ((s * remainder) >> 8))) >> 8;
  const t = (v * (255 - ((s * (255 - remainder)) >> 8))) >> 8;
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v]][region] ?? [v, p, q];
}

/** The color, sRGB bytes, of run `n` (0 at the start) of `preset` started with `rgb`. */
function runColor(preset, rgb, n) {
  if (preset === "fade") {
    // color / 128 × brightness per channel, in integers: a channel under 128 stays dark, one of 128 or more follows.
    const brightness = fadeBrightness(n);
    return rgb.map((c) => Math.floor(c / 128) * brightness);
  }
  // presets/rainbow_gradient.c: the hue counter (uint8) goes up before each run; saturation 255, value 16.
  if (preset === "rainbow") return hsvToRgb((n + 1) % 256, 255, 16);
  // presets/blink.c: is_on starts false, and a run shows the color when it is false, then turns it.
  if (preset === "blink" || preset === "notification") return n % 2 === 0 ? [...rgb] : [...DARK];
  return [...rgb];
}

/**
 * The state the event "lights" (or a message of the same shape) gives, checked: { preset, rgb, brightness, elapsed,
 * set }. What is not one of the presets is off; a color that is not "#rrggbb" is black; brightness is 0..1 (1 when
 * left out); elapsed, the ms the preset had run when the message was sent, is 0 when left out: the preset starts now;
 * set, the ms into the preset at which the brightness was set while it ran (lightsAt), is null when left out.
 */
export function parseLights(message) {
  const preset = LIGHT_PRESETS.includes(message?.preset) ? message.preset : "off";
  const color = /^#[0-9a-f]{6}$/i.test(message?.color ?? "") ? message.color : "#000000";
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const brightness = Number.isFinite(message?.brightness) ? Math.min(1, Math.max(0, message.brightness)) : 1;
  const elapsed = Number.isFinite(message?.elapsed) && message.elapsed > 0 ? message.elapsed : 0;
  const set = Number.isFinite(message?.set) && message.set >= 0 ? message.set : null;
  return { preset, rgb, brightness, elapsed, set };
}

/**
 * What the status lights show `elapsed` ms after the firmware started `lights.preset` with `lights.rgb` (bytes) at
 * `lights.brightness`, the level the brightness setting gives, 0..1. A preset with `full` (the notification) runs at 1
 * whatever that is, but for one thing: when the brightness is set while it runs (`lights.set`, ms into the preset),
 * status_lights_do_set_brightness drives the color of the run that shows at that level, without looking at
 * override_brightness, until the next run puts it back at 1 (status_lights_run_pattern). A blink set that way is
 * dimmer for the rest of its half second. With `still`, a preset that never holds still (fade, rainbow) shows its
 * `still` run and does not change.
 * @returns {{ rgb: number[], level: number, next: number | null, ended: boolean }} the color the firmware drives the
 *   LEDs with (bytes) and the level it scales it by, 0..1 (dark: black or 0); the elapsed ms of the next change, null
 *   when there is none; whether the preset has stopped (a notification after 2.5 s).
 */
export function lightsAt(lights, elapsed, { still = false } = {}) {
  const preset = PRESETS[lights?.preset];
  if (!preset) return { rgb: [...DARK], level: 0, next: null, ended: false };
  const t = Math.max(0, elapsed);
  if (t >= preset.end) return { rgb: [...DARK], level: 0, next: null, ended: true };
  const held = still && preset.still !== undefined;
  const n = held ? preset.still : Math.floor(t / preset.period);
  // A static color never changes; the others change at every run, the last run of one that stops included.
  let next = held || lights.preset === "static" ? null : Math.min((n + 1) * preset.period, preset.end);
  let level = lights.brightness;
  if (preset.full) {
    const set = Number.isFinite(lights.set) && Math.floor(lights.set / preset.period) === n ? lights.set : null;
    level = set !== null && t >= set ? lights.brightness : 1;
    if (set !== null && t < set) next = set;
  }
  return { rgb: runColor(lights.preset, lights.rgb, n), level, next, ended: false };
}

/**
 * How often, at most, a view draws a preset that steps faster than a person needs to see (fade every 10 ms, the
 * rainbow every 16 ms): 25 times a second. The firmware's blinks are drawn at their own edges.
 */
export const VIEW_STEP_MS = 40;

/**
 * How long a view waits, ms, before it draws the lights again after drawing them `elapsed` ms into `preset`, whose
 * next change is at `next` (lightsAt): a millisecond past the change, so that the timer never wakes just before it;
 * no sooner than VIEW_STEP_MS for fade and the rainbow. null when nothing changes any more.
 */
export function redrawDelay(preset, elapsed, next) {
  if (next === null) return null;
  const wait = Math.ceil(next - elapsed) + 1;
  return (PRESETS[preset]?.period ?? Infinity) < VIEW_STEP_MS ? Math.max(wait, VIEW_STEP_MS) : wait;
}

// ---------------------------------------------------------------- how a lit status LED looks on screen
// The firmware drives each channel of a status LED at component / 255 × level^1.85 of full PWM
// (status_lights_backend.c, status_lights_scale_component), `level` the brightness the lights run at. A real LED at a
// few percent of PWM still reads as plainly lit and fully saturated: the eye takes light roughly as a cube root, and
// the LED is a point far brighter than a screen. Its color times its duty on a screen looks dull and dark. So a view
// shows the LED's own hue at full strength (its largest channel at 255) and how lit it looks, `glow` 0..1: the cube
// root of the duty, doubled, eased. Anything the firmware lights shows at about half or more; the BUSY timer's red
// (150, 0, 0) at the default brightness (0.48) at full; the rainbow (its largest channel 16) at about two thirds. The
// flat view and the 3D view both draw by it.

/**
 * How a status LED looks on screen.
 * @param {number[]} rgb  the color the firmware drives it with, sRGB bytes
 * @param {number} level  the brightness the lights run at, 0..1
 * @returns {{ hue: number[], glow: number, halo: number } | null}  the hue at full strength (bytes); glow 0..1; halo
 *   0..1, the cube root of the duty, for what grows on with the brightness past full glow. null when dark.
 */
export function statusLedLook(rgb, level) {
  const peak = Math.max(...rgb);
  if (!(peak > 0) || !(level > 0)) return null;
  const halo = Math.cbrt((Math.min(255, peak) / 255) * Math.min(1, level) ** 1.85);
  return { hue: rgb.map((v) => Math.round((v / peak) * 255)), glow: Math.round(Math.min(1, 2 * halo) ** 0.6 * 1e4) / 1e4, halo: Math.round(halo * 1e4) / 1e4 };
}
