// The 3D view's frame: the bar as a model in the Tride player, with the emulator's pictures on both displays and
// its controls on the model. It runs in a sandboxed frame with no origin and no rights: it loads its own files and
// then talks only to the page that holds it, by messages (the protocol is in ../README.md).
import { BACK, createBackPainter, createLedPainter, FRONT, statusLedLook } from "./leds.js";
import { TrideScene } from "./player/tride-web/tride-web.js";

const POSITIONS = ["busy", "custom", "off", "apps", "settings"];
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- the view
// The bar stands on a turntable in front of a camera with a long lens and fixed lights: `turn` is the turntable's
// angle, `tilt` leans the bar towards the camera (so its top shows); `distance`, `lift` and `shift` place the camera
// so that the bar takes its share of the frame and stands in its middle. The person turns the bar by dragging beside
// its controls and brings it nearer or farther with a pinch or the scroll wheel off the bar; the page's quick views
// (below) fly the camera to one of a few angles, and dragging goes on from there.
const VIEW = {
  // How far the bar leans: from a little below its middle (never under the desk) to straight from above.
  tiltMin: -0.05,
  tiltMax: Math.PI / 2,
  fill: 0.67, // the share of the frame the bar takes, across or up, at the views' distance
  // How much nearer or farther than that the person may bring it: the distance times this.
  zoomMin: 0.5,
  zoomMax: 2,
  fov: 0.126, // the camera's vertical field of view, radians: a 190 mm lens on full frame (the scene contract, frame/scene/scene.json)
  // The bar's box round the turntable's centre, metres: half its length, half its depth, its bottom and its top
  // (the wheel's).
  box: { along: 0.0843, deep: 0.0221, low: -0.0242, high: 0.031 },
};
// The views the page may pick (README, message `camera`). The front and the back are seen a little from above, so
// that the top's controls show; the side is the wheel's end; the top has the front display at the bottom.
const VIEWS = {
  front: { turn: 0, tilt: 0.13 },
  back: { turn: Math.PI, tilt: 0.13 },
  top: { turn: 0, tilt: Math.PI / 2 },
  side: { turn: -Math.PI / 2, tilt: 0.13 },
};
const FIRST_VIEW = "front";
// Dragging beside the controls turns the bar this much a CSS pixel, radians: across turns it round, up and down
// leans it. A drag is a drag (and no longer maybe a click) once it has moved MOVE_PX.
const ORBIT_PER_PX = 0.009;
// Zoom: a pinch (a trackpad sends it as the wheel with Ctrl) or the scroll wheel off the bar; this much scrolling
// doubles or halves the distance.
const ZOOM_DOUBLING = 600;
// A flight from one view to another: eased in and out, this long; a new one starts from wherever the camera is.
const FLIGHT_MS = 750;
// The mouse wheel and the trackpad: this much scrolling is one click of the bar's wheel (as in the flat view).
const SCROLL_STEP = 60;
// A press shorter than this is still seen on the model.
const PRESS_SHOWN_MS = 110;
// A pointer that stays on the wheel this long without moving presses it (OK held); one that moves turns it.
const HOLD_MS = 260;
const MOVE_PX = 4;
// The scene's springs settle within this time after the last change.
const SETTLE_MS = 900;
// How often the displays are redrawn in a window that is not in front.
const UNFOCUSED_FRAME_MS = 100;
// The LED picture: texels a LED takes on each side. More is no sharper on screen (measured: 24 drew the same picture
// as 16 at the views' distance, at 2.25 times the bytes and 2.6 times the painting), and 32 is over the player's limit
// for a picture (2048 pixels a side): the view does not come up.
const LED_CELL = 16;
// The back display's pixels, each this many texels: the scene shows it sharp at any angle.
const BACK_SCALE = 1;

const canvas = document.getElementById("scene");
const host = window.parent;
const say = (message) => host.postMessage(message, "*");

let scene = null;
let info = null; // scene/bar.json: which node is which control, the switch's step
let shown = true; // the page shows the view
let disposed = false;
const problems = [];

// ---------------------------------------------------------------- drawing only when something changes
// A still bar costs nothing: a frame is drawn when a picture came, while something moves, and after a resize.
let raf = 0;
let lastTick = 0;
let movingUntil = 0;
let mustPaint = true;

function schedule() {
  if (!raf && scene && shown && !document.hidden && !disposed) raf = requestAnimationFrame(draw);
}
/** Something started to move: draw every frame until the springs have settled. */
function moving(ms = SETTLE_MS) {
  movingUntil = Math.max(movingUntil, performance.now() + ms);
  schedule();
}
/** Something changed at once (a picture): one frame. */
function changed() {
  mustPaint = true;
  schedule();
}
function draw(now) {
  raf = 0;
  if (!scene || disposed) return;
  // A picture shows in a step of 1/60 s or longer; after a pause the scene is not thrown forward by the whole pause.
  const dt = Math.min(Math.max((now - lastTick) / 1000, 1 / 60), 1 / 20);
  lastTick = now;
  stepFlight(now);
  const painted = scene.tick(dt);
  if (!painted && mustPaint) scene.renderNow({ neverSkip: true });
  mustPaint = false;
  if (now < movingUntil) schedule();
}

// ---------------------------------------------------------------- size and framing
const startView = VIEWS[location.hash.slice(1)] ? location.hash.slice(1) : FIRST_VIEW;
const view = { ...VIEWS[startView], zoom: 1 };
let viewName = startView; // the quick view the camera is at or flying to; null once the person has turned the bar
let homeView = startView; // the last quick view: a double click on the background goes back to it
// What the page keeps clear at the frame's sides, CSS pixels (its own buttons over the frame). Across, the bar keeps
// away from the larger of the two on both sides, so that it stays in the middle. Up and down, it is as large as if it
// kept away from the larger on both sides, and it stands in the middle of what is left clear between the top and the
// bottom: over the controls under it (the page's dock), with as much room under it as over it.
let inset = { x: 0, top: 0, bottom: 0 };

/** The corners of the bar's box, turned and leaned as `turn` and `tilt` say: [towards the camera, up, across]. */
function corners(turn, tilt) {
  const { along, deep, low, high } = VIEW.box;
  const ct = Math.cos(turn), st = Math.sin(turn);
  const cl = Math.cos(-tilt), sl = Math.sin(-tilt);
  const out = [];
  for (const z of [-along, along]) {
    for (const x of [-deep, deep]) {
      // Turned round the vertical axis: towards the camera (x) and across the picture (z).
      const near = x * ct + z * st;
      const across = z * ct - x * st;
      for (const y of [low, high]) out.push([near * cl - y * sl, near * sl + y * cl, across]); // then leaned
    }
  }
  return out;
}

/**
 * Where the camera stands for the bar, turned as it is, to take its share of the frame in the frame's middle: its
 * offset up and across (`lift`, `shift`) puts the middle of the bar's picture in the middle of the frame, and its
 * distance is the nearest at which every corner of the bar's box is inside. A few rounds, as the offset and the
 * distance depend on each other a little (the lens is long: nearly not at all).
 */
function cameraFor(turn, tilt, width, height, zoom = 1) {
  const aspect = width > 0 && height > 0 ? width / height : 3;
  const share = (side, kept) => (VIEW.fill / zoom) * Math.max(0.2, 1 - (2 * kept) / Math.max(1, side));
  const tUp = Math.tan(VIEW.fov / 2) * share(height, Math.max(inset.top, inset.bottom));
  const tAcross = Math.tan(VIEW.fov / 2) * aspect * share(width, inset.x);
  const points = corners(turn, tilt);
  // First as through a lens with no depth: the middle of the box's extent.
  const mid = (i) => (Math.min(...points.map((p) => p[i])) + Math.max(...points.map((p) => p[i]))) / 2;
  let lift = mid(1);
  let shift = mid(2);
  let distance = 0;
  let depth = 0;
  for (let round = 0; round < 3; round++) {
    distance = 0;
    for (const [nearer, up, across] of points) distance = Math.max(distance, nearer + Math.max(Math.abs(up - lift) / tUp, Math.abs(across - shift) / tAcross));
    // Then the picture's middle as the lens sees it, and the camera moved by what it is off.
    let [upMin, upMax, acMin, acMax] = [Infinity, -Infinity, Infinity, -Infinity];
    depth = 0;
    for (const [nearer, up, across] of points) {
      const d = distance - nearer;
      upMin = Math.min(upMin, (up - lift) / d);
      upMax = Math.max(upMax, (up - lift) / d);
      acMin = Math.min(acMin, (across - shift) / d);
      acMax = Math.max(acMax, (across - shift) / d);
      depth += d / points.length;
    }
    lift += ((upMin + upMax) / 2) * depth;
    shift += ((acMin + acMax) / 2) * depth;
  }
  // Then the picture moved up by half of what the bottom keeps more than the top (or down, the other way): the camera
  // looks that much lower. A pixel is 2 tan(fov / 2) × depth / height metres at the bar's depth.
  const up = (inset.bottom - inset.top) / 2;
  if (up && height > 0) lift -= (up / height) * 2 * Math.tan(VIEW.fov / 2) * depth;
  return { distance, lift, shift };
}

function applyView(settle = true) {
  if (!scene) return;
  const camera = cameraFor(view.turn, view.tilt, canvas.clientWidth, canvas.clientHeight, view.zoom);
  sent = { turn: view.turn, tilt: -view.tilt, ...camera };
  scene.setInputs(sent);
  if (settle) moving();
}

// ---------------------------------------------------------------- flights between the views
let flight = null; // { from, to, start }
let sent = null; // the camera's inputs as last given to the scene (for checks: probe)

/** Tells the page which quick view the camera is at, or null once the person has turned the bar away from it. */
function sayView() {
  say({ type: "camera", view: viewName });
}

/**
 * The camera to view `name`, at the views' distance: flown there, or at once. A flight under way gives way to the new
 * one where it is. `tell`: the page did not ask for it (a double click), so it is told.
 */
function goTo(name, atOnce = false, tell = false) {
  const target = VIEWS[name];
  if (!target) return;
  viewName = name;
  homeView = name;
  if (tell) sayView();
  // The short way round: the turn the nearest to where the bar stands now.
  const turn = target.turn + Math.round((view.turn - target.turn) / TAU) * TAU;
  if (atOnce || !scene) {
    flight = null;
    Object.assign(view, { turn, tilt: target.tilt, zoom: 1 });
    applyView();
    return;
  }
  flight = { from: { ...view }, to: { turn, tilt: target.tilt, zoom: 1 }, start: performance.now() };
  moving(FLIGHT_MS + SETTLE_MS);
}

/** The person turns the bar: by `dx`, `dy` CSS pixels of a drag. The tilt stays within its limits; the turn has none. */
function orbit(dx, dy) {
  flight = null;
  view.turn += dx * ORBIT_PER_PX;
  view.tilt = Math.min(VIEW.tiltMax, Math.max(VIEW.tiltMin, view.tilt + dy * ORBIT_PER_PX));
  if (viewName !== null) {
    viewName = null;
    sayView();
  }
  applyView();
}

/** Nearer (a negative `amount`) or farther, `amount` in scrolled CSS pixels, within the limits. */
function zoomBy(amount) {
  if (flight) {
    // Where the flight would end, at the new distance.
    flight.to.zoom = Math.min(VIEW.zoomMax, Math.max(VIEW.zoomMin, flight.to.zoom * 2 ** (amount / ZOOM_DOUBLING)));
    return;
  }
  const zoom = Math.min(VIEW.zoomMax, Math.max(VIEW.zoomMin, view.zoom * 2 ** (amount / ZOOM_DOUBLING)));
  if (zoom === view.zoom) return;
  view.zoom = zoom;
  applyView();
}
const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
function stepFlight(now) {
  if (!flight) return;
  const k = Math.min(1, Math.max(0, (now - flight.start) / FLIGHT_MS));
  const e = ease(k);
  view.turn = flight.from.turn + (flight.to.turn - flight.from.turn) * e;
  view.tilt = flight.from.tilt + (flight.to.tilt - flight.from.tilt) * e;
  view.zoom = flight.from.zoom * (flight.to.zoom / flight.from.zoom) ** e;
  applyView(false);
  if (k >= 1) flight = null;
}

function resize() {
  if (!scene || canvas.clientWidth < 2 || canvas.clientHeight < 2) return;
  scene.setViewport(canvas.clientWidth, canvas.clientHeight);
  scene.resize(Math.min(window.devicePixelRatio || 1, 2));
  applyView();
  changed();
}

// ---------------------------------------------------------------- the displays
const frontPainter = createLedPainter(LED_CELL);
const backPainter = createBackPainter(BACK_SCALE);
let waiting = { front: null, back: null }; // the newest frames that came before the scene was up, or while hidden

let focused = true; // the window is the one the person works in
let lastShown = 0;
let showLater = 0;

function showFrames({ front, back }, atOnce = false) {
  if (front) waiting.front = front;
  if (back) waiting.back = back;
  if (!scene || !shown || document.hidden) return;
  // In a window that is not in front the displays are redrawn a few times a second: enough to see, and cheap.
  const wait = focused || atOnce ? 0 : UNFOCUSED_FRAME_MS - (performance.now() - lastShown);
  if (wait > 0) {
    showLater ||= setTimeout(() => {
      showLater = 0;
      showFrames({});
    }, wait);
    return;
  }
  lastShown = performance.now();
  if (waiting.front) {
    frontPainter.paint(waiting.front);
    scene.setImagePixels("front", frontPainter);
  }
  if (waiting.back) {
    backPainter.paint(waiting.back);
    scene.setImagePixels("back", backPainter);
  }
  waiting = { front: null, back: null };
  changed();
}

const bytesOf = (value, length) => {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  return bytes && bytes.length === length ? bytes : null;
};

// ---------------------------------------------------------------- the RGB LEDs beside Start
// The bar's two status lights, in the slots of its top at the two ends of Start (the scene's led_light_1 on the
// switch's side, led_light_2 on the wheel's). The page gives their state as the window's event "lights" has it
// (legacy-window/README.md): { preset, color: "#rrggbb", brightness: 0..1 }, the same the flat view's strips show.
// The scene takes each LED's color in linear RGB, an array [r, g, b], and its level 0..1 (its glow is 6 × level);
// black or 0 is dark. It is given what the eye sees of the LED, not the PWM duty (leds.js, statusLedLook): the LED's
// hue at full strength and a level that puts anything the firmware lights clearly on, the BUSY timer's red at 1. The presets move as the firmware's status lights move them (status_lights/presets): blink
// half a second on, half off; a notification three such blinks at full brightness, then dark; fade up and down in
// 2.56 s; the rainbow round in 4 s. The scene is given new values only when they change.
const LIGHT_PRESETS = ["off", "static", "fade", "rainbow", "blink", "notification"];
const LIGHT_TICK_MS = { blink: 500, notification: 500, fade: 40, rainbow: 40 };
const NOTIFICATION_MS = 3000;
let lights = { preset: "off", rgb: [0, 0, 0], brightness: 1, since: 0 };
let lightInputs = null; // the LEDs' inputs as last given to the scene (for checks: probe)
let lightTimer = 0;

/** The color (bytes, sRGB), the level the firmware runs them at and the color's strength (`value`, when it is not
 * the color's own) of the LEDs `t` milliseconds into `state`. */
function lightsAt(state, t) {
  const { preset, rgb, brightness } = state;
  const blinkOn = Math.floor(t / 500) % 2 === 0;
  if (preset === "static") return { rgb, level: brightness };
  if (preset === "blink") return { rgb, level: blinkOn ? brightness : 0 };
  if (preset === "notification") return { rgb, level: t < NOTIFICATION_MS && blinkOn ? 1 : 0 };
  if (preset === "fade") {
    const phase = (t % 2560) / 2560;
    return { rgb, level: brightness * (phase < 0.5 ? phase * 2 : 2 - phase * 2) };
  }
  if (preset === "rainbow") {
    const h = ((t % 4000) / 4000) * 6;
    const x = 1 - Math.abs((h % 2) - 1);
    const [r, g, b] = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(h) % 6];
    // The firmware's rainbow has the HSV value 16 of 255 (status_lights/presets/rainbow_gradient.c): dim.
    return { rgb: [r, g, b].map((v) => Math.round(v * 255)), level: brightness, value: 16 / 255 };
  }
  return { rgb: [0, 0, 0], level: 0 };
}

function setLights(m) {
  const preset = LIGHT_PRESETS.includes(m.preset) ? m.preset : "off";
  const hex = /^#[0-9a-f]{6}$/i.test(m.color ?? "") ? m.color : "#000000";
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const brightness = Number.isFinite(m.brightness) ? Math.min(1, Math.max(0, m.brightness)) : 1;
  lights = { preset, rgb, brightness, since: performance.now() };
  showLights();
}

function showLights() {
  clearTimeout(lightTimer);
  lightTimer = 0;
  if (!scene || disposed) return;
  const t = performance.now() - lights.since;
  const { rgb, level, value } = lightsAt(lights, t);
  const look = statusLedLook(rgb, level, value);
  const color = look ? look.hue.map((v) => Math.round((v / 255) ** 2.2 * 1e4) / 1e4) : [0, 0, 0];
  const glow = look ? look.glow : 0;
  const next = { led_left: color, led_left_level: glow, led_right: [...color], led_right_level: glow };
  if (JSON.stringify(next) !== JSON.stringify(lightInputs)) {
    lightInputs = next;
    scene.setInputs(next);
    changed();
  }
  const tick = LIGHT_TICK_MS[lights.preset];
  if (tick && !(lights.preset === "notification" && t >= NOTIFICATION_MS)) lightTimer = setTimeout(showLights, tick - (t % tick) + 1);
}

// ---------------------------------------------------------------- the controls' state on the model
const pressInput = { start: "press_start", back: "press_back", ok: "press_wheel" };
const pressedAt = {};
const releaseTimers = {};

function showPress(key, down) {
  const input = pressInput[key];
  if (!input || !scene) return;
  clearTimeout(releaseTimers[key]);
  if (down) {
    pressedAt[key] = performance.now();
    scene.setInput(input, 1);
    moving();
    return;
  }
  const wait = PRESS_SHOWN_MS - (performance.now() - (pressedAt[key] ?? 0));
  const release = () => {
    if (!scene || disposed) return;
    scene.setInput(input, 0);
    moving();
  };
  if (wait > 0) releaseTimers[key] = setTimeout(release, wait);
  else release();
}

let wheelAngle = 0; // where the wheel stands, radians; positive is counterclockwise seen from above
let position = "off"; // the mode switch, as the bar has it
const stepAngle = () => TAU / (info?.wheelDetents ?? 24);
const switchAngle = (name) => (POSITIONS.indexOf(name) - 2) * (info?.switchStep ?? 0.672);

// The bar's wheel: "up" is clockwise. A click the frame itself asked for comes back from the bar as its event; the
// wheel has turned already under the finger, so that one is not shown again.
const expected = { up: [], down: [] };
function showWheelClick(direction) {
  const now = performance.now();
  const mine = expected[direction];
  while (mine.length && now - mine[0] > 1000) mine.shift();
  if (mine.length) return void mine.shift();
  if (!scene || drag?.kind === "wheel") return;
  wheelAngle += direction === "up" ? -stepAngle() : stepAngle();
  scene.setInput("wheel", wheelAngle);
  moving();
}

function showPosition(name) {
  // The bar says where its switch stands every second; only a change moves anything.
  if (!POSITIONS.includes(name) || name === position) return;
  position = name;
  if (!scene || drag?.kind === "switch") return;
  scene.setInput("switch", switchAngle(name));
  moving();
}

// ---------------------------------------------------------------- the pointer
let drag = null; // what the pressed pointer does: { kind: "start" | "back" | "wheel" | "switch" | "orbit", ... }

const point = (e) => {
  const box = canvas.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top };
};
function hitsAt(x, y) {
  if (!scene) return [];
  try {
    return scene.pick(x, y);
  } catch {
    return [];
  }
}
function controlAt(x, y) {
  if (!info) return null;
  const hits = hitsAt(x, y);
  return hits.length ? (info.controls[hits[0].node] ?? null) : null;
}
/** Whether the bar is under the point, any part of it. */
const onBar = (x, y) => hitsAt(x, y).length > 0;

function key(name, action) {
  say({ type: "key", key: name, action });
  showPress(name, action === "down");
}

canvas.addEventListener("pointerdown", (e) => {
  if (!scene || drag || e.button !== 0) return;
  const { x, y } = point(e);
  const control = controlAt(x, y);
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  if (!control) {
    // Beside the controls (on the bar's body or the background) a drag turns the bar.
    drag = { kind: "orbit", id: e.pointerId, x, y, startX: x, startY: y, moved: false };
    return;
  }
  drag = { kind: control, id: e.pointerId, x, y, startX: x, startY: y, moved: false, shift: e.shiftKey };
  if (control === "start" || control === "back") key(control, "down");
  else if (control === "wheel") {
    // Turned or pressed: it is known once the pointer has moved or has stayed.
    scene.pointer("down", x, y);
    drag.hold = setTimeout(() => {
      if (drag?.kind !== "wheel" || drag.moved) return;
      drag.held = true;
      key("ok", "down");
    }, HOLD_MS);
  } else if (control === "switch") {
    scene.pointer("down", x, y);
    drag.sent = position;
  }
  moving();
});

canvas.addEventListener("pointermove", (e) => {
  const { x, y } = point(e);
  if (!drag) {
    // Nothing pressed: the cursor says what is under it.
    hover = { x, y };
    if (!hoverTimer) hoverTimer = requestAnimationFrame(showHover);
    return;
  }
  if (e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) >= MOVE_PX) drag.moved = true;
  if (drag.kind === "orbit") {
    // Until it is a drag, the bar stays where it is; then it follows the pointer from where the press was.
    if (!drag.moved) return;
    canvas.classList.add("orbiting");
    orbit(x - drag.x, y - drag.y);
    drag.x = x;
    drag.y = y;
    return;
  }
  if ((drag.kind === "wheel" && !drag.held) || drag.kind === "switch") {
    if (drag.moved) scene.pointer("move", x, y);
    moving();
  }
  drag.x = x;
  drag.y = y;
});

function endDrag(e, canceled) {
  if (!drag || (e && e.pointerId !== undefined && e.pointerId !== drag.id)) return;
  const ended = drag;
  drag = null;
  clearTimeout(ended.hold);
  if (ended.kind === "orbit") {
    canvas.classList.remove("orbiting");
    return;
  }
  if (ended.kind === "start" || ended.kind === "back") key(ended.kind, "up");
  else if (ended.kind === "wheel") {
    scene.pointer(canceled ? "cancel" : "up", ended.x, ended.y);
    if (ended.held) key("ok", "up");
    else if (!ended.moved && !canceled) {
      // A click on the wheel: OK, down and up.
      key("ok", "down");
      key("ok", "up");
    }
    // The wheel rests in the middle of the detent it is in.
    wheelAngle = (Math.floor(wheelAngle / stepAngle()) + 0.5) * stepAngle();
    scene.setInput("wheel", wheelAngle);
  } else if (ended.kind === "switch") {
    scene.pointer(canceled ? "cancel" : "up", ended.x, ended.y);
    if (!ended.moved && !canceled) {
      // A click on the switch: the next position, with Shift the one before (as in the flat view).
      const next = POSITIONS[(POSITIONS.indexOf(position) + (ended.shift ? POSITIONS.length - 1 : 1)) % POSITIONS.length];
      say({ type: "mode", position: next });
      position = next;
    } else position = ended.sent;
    scene.setInput("switch", switchAngle(position));
  }
  moving();
}
canvas.addEventListener("pointerup", (e) => endDrag(e, false));
canvas.addEventListener("pointercancel", (e) => endDrag(e, true));
canvas.addEventListener("lostpointercapture", (e) => endDrag(e, true));
addEventListener("blur", () => endDrag(null, true));

let hover = null;
let hoverTimer = 0;
function showHover() {
  hoverTimer = 0;
  if (!hover || drag) return;
  canvas.classList.toggle("over-control", controlAt(hover.x, hover.y) !== null);
}

// Scrolling over the bar turns its wheel, as in the flat view. The bar's own event then turns the wheel on the model.
// Off the bar, scrolling brings the bar nearer or farther, and so does a pinch anywhere (a trackpad's pinch comes as
// the wheel with Ctrl).
let scrollRest = 0;
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const amount = e.deltaMode === 0 ? e.deltaY : e.deltaY * SCROLL_STEP;
    const { x, y } = point(e);
    if (e.ctrlKey || !onBar(x, y)) {
      // A pinch's steps are small: they are made as large as the wheel's.
      zoomBy(e.ctrlKey ? amount * 6 : amount);
      return;
    }
    scrollRest += amount;
    while (Math.abs(scrollRest) >= SCROLL_STEP) {
      say({ type: "wheel", direction: scrollRest > 0 ? "up" : "down" });
      scrollRest -= Math.sign(scrollRest) * SCROLL_STEP;
    }
  },
  { passive: false },
);
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
// A double click beside the controls: back to the last quick view, at its distance.
canvas.addEventListener("dblclick", (e) => {
  const { x, y } = point(e);
  if (!scene || controlAt(x, y)) return;
  e.preventDefault();
  goTo(homeView, false, true);
});

// The keyboard is the page's: a key pressed while the frame has the focus goes to the page as it is.
for (const type of ["keydown", "keyup"]) {
  addEventListener(type, (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    say({ type: "keyboard", event: type, key: e.key, code: e.code, repeat: e.repeat, shiftKey: e.shiftKey });
  });
}

// ---------------------------------------------------------------- what the scene says
function onInputChange({ name, value, previous }) {
  if (name === "wheel" && drag?.kind === "wheel") wheelAngle = value;
  if (name === "wheel_step" && drag?.kind === "wheel" && !drag.held) {
    // Each detent the finger passes is one click of the bar's wheel; counterclockwise is "down".
    const direction = value > previous ? "down" : "up";
    for (let n = Math.min(Math.abs(value - previous), 48); n > 0; n--) {
      expected[direction].push(performance.now());
      say({ type: "wheel", direction });
    }
  }
  if (name === "switch" && drag?.kind === "switch") {
    const step = info.switchStep;
    const now = POSITIONS[Math.min(4, Math.max(0, Math.round(value / step) + 2))];
    if (now !== drag.sent) {
      drag.sent = now;
      say({ type: "mode", position: now });
    }
  }
}

// ---------------------------------------------------------------- messages from the page
function probe(id, full = false) {
  // What is on the canvas, for a check from outside: drawn now and read in the same task. `full`: its pixels too, all
  // of them, RGBA, and the front display's picture as given to the scene (for a check of how sharp it is shown).
  if (!scene) return say({ type: "probe", id, ready: false });
  showFrames({}, true);
  scene.tick(1 / 60);
  scene.renderNow({ neverSkip: true });
  const w = 128;
  const h = Math.max(1, Math.round((w * canvas.height) / Math.max(1, canvas.width)));
  const copy = new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true });
  copy.drawImage(canvas, 0, 0, w, h);
  const { data } = copy.getImageData(0, 0, w, h);
  const mean = [0, 0, 0];
  let lit = 0;
  for (let i = 0; i < data.length; i += 4) {
    mean[0] += data[i];
    mean[1] += data[i + 1];
    mean[2] += data[i + 2];
    if (data[i] + data[i + 1] + data[i + 2] > 96) lit++;
  }
  const count = data.length / 4;
  // Where the bar is: the box of the pixels that are not the background's (a corner's) color, as shares of the frame.
  const bounds = { left: 1, right: 0, top: 1, bottom: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(data[i] - data[0]) + Math.abs(data[i + 1] - data[1]) + Math.abs(data[i + 2] - data[2]) <= 24) continue;
      bounds.left = Math.min(bounds.left, x / w);
      bounds.right = Math.max(bounds.right, (x + 1) / w);
      bounds.top = Math.min(bounds.top, y / h);
      bounds.bottom = Math.max(bounds.bottom, (y + 1) / h);
    }
  }
  let pixels;
  let front;
  if (full) {
    front = { width: frontPainter.width, height: frontPainter.height, data: frontPainter.data.slice() };
    const whole = new OffscreenCanvas(canvas.width, canvas.height).getContext("2d", { willReadFrequently: true });
    whole.drawImage(canvas, 0, 0);
    pixels = whole.getImageData(0, 0, canvas.width, canvas.height).data;
  }
  say({ type: "probe", id, ready: true, width: canvas.width, height: canvas.height, mean: mean.map((v) => v / count), lit: lit / count, bounds, view: flight ? null : viewName, camera: { ...sent, zoom: view.zoom }, lights: lightInputs, problems: [...problems], pixels, front });
}

addEventListener("message", (e) => {
  if (e.source !== host || !e.data || typeof e.data !== "object") return;
  const m = e.data;
  if (m.type === "frame") showFrames({ front: bytesOf(m.front, FRONT.width * FRONT.height * 3), back: bytesOf(m.back, (BACK.width * BACK.height) / 2) });
  else if (m.type === "lights") setLights(m);
  else if (m.type === "state") {
    if (typeof m.mode === "string") showPosition(m.mode);
  } else if (m.type === "key") {
    if (m.key === "up" || m.key === "down") {
      if (m.action === "press") showWheelClick(m.key);
    } else if (m.action === "press" || m.action === "release") {
      // A button the pointer holds on the model stays down whatever else released it.
      const mine = drag && (drag.kind === m.key || (drag.kind === "wheel" && drag.held && m.key === "ok"));
      if (!mine) showPress(m.key, m.action === "press");
    }
  } else if (m.type === "view") {
    shown = m.visible !== false;
    focused = m.focused !== false;
    if (shown) {
      showFrames({});
      changed();
    }
  } else if (m.type === "camera") {
    if (VIEWS[m.view]) goTo(m.view, m.atOnce === true);
  } else if (m.type === "inset") {
    const px = (v) => (Number.isFinite(v) && v > 0 ? Math.min(v, 4000) : 0);
    inset = { x: Math.max(px(m.left), px(m.right)), top: px(m.top), bottom: px(m.bottom) };
    applyView();
  } else if (m.type === "reset") goTo(FIRST_VIEW);
  else if (m.type === "look") {
    // For screenshots and checks: a view by its angles (and its distance, as a share of the views'), at once.
    flight = null;
    if (Number.isFinite(m.turn)) view.turn = m.turn;
    if (Number.isFinite(m.tilt)) view.tilt = Math.min(VIEW.tiltMax, Math.max(VIEW.tiltMin, m.tilt));
    view.zoom = Number.isFinite(m.zoom) ? Math.min(VIEW.zoomMax, Math.max(VIEW.zoomMin, m.zoom)) : 1;
    viewName = null;
    applyView();
  } else if (m.type === "probe") probe(m.id, m.full === true);
  else if (m.type === "pick") say({ type: "pick", id: m.id, control: controlAt(m.x, m.y), bar: onBar(m.x, m.y) });
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  showFrames({});
  changed();
});

// What the frame's policy refused: nothing should be, and a check from outside can see it.
document.addEventListener("securitypolicyviolation", (e) => {
  const text = `policy: ${e.violatedDirective} refused ${e.blockedURI || "inline code"}`;
  if (problems.length < 20) problems.push(text);
  say({ type: "problem", message: text });
});

// ---------------------------------------------------------------- start
async function start() {
  const at = (path) => new URL(path, import.meta.url).href;
  const [loadedInfo, made] = await Promise.all([
    fetch(at("scene/bar.json")).then((r) => {
      if (!r.ok) throw new Error(`scene/bar.json: ${r.status}`);
      return r.json();
    }),
    TrideScene.create(canvas, {
      filamentScriptUrl: at("player/filament/filament.js"),
      iblBase: at("player/ibl"),
      // The scene has no text: the runtime without fonts is enough, and the only one shipped.
      runtimeBuild: "lite",
      onProblem: (problem) => {
        const text = `${problem?.code ?? "problem"}: ${problem?.message ?? problem}`;
        if (problems.length < 20) problems.push(text);
        say({ type: "problem", message: text });
      },
    }),
  ]);
  info = loadedInfo;
  scene = made;
  await scene.load(at("scene/bar.trd"));
  if (disposed) return;
  scene.onInputChange(onInputChange);
  scene.setInputs({ wheel: wheelAngle, switch: switchAngle(position) });
  showLights();
  new ResizeObserver(resize).observe(canvas);
  resize();
  // The first frame at once, whatever the renderer would rather skip; then the springs are let to rest where they are.
  lastTick = performance.now();
  for (let i = 0; i < 90; i++) scene.tick(1 / 30);
  scene.renderNow({ neverSkip: true });
  showFrames({});
  canvas.classList.add("ready");
  say({ type: "ready", build: await TrideScene.buildInfo().catch(() => null) });
  moving();
}

addEventListener("pagehide", () => {
  disposed = true;
  cancelAnimationFrame(raf);
  try {
    scene?.dispose();
  } catch {
    // Going away anyway.
  }
});

start().catch((error) => say({ type: "error", message: String(error?.message ?? error) }));
