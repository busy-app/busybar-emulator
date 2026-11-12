// The device window: draws the frames the emulator streams, sends the buttons and the wheel, shows the app console.
// Everything comes from /_emu/events (device-window.mjs); keys go to /_emu/key (held) and /api/input (wheel clicks).

const FRONT = { width: 72, height: 16 };
const BACK = { width: 160, height: 80 };
// The LED look of busy-lib's LedRenderer: square LEDs with rounded corners, a gap between them, dark ones off.
const LED = { size: 0.85, radius: 0.5, darkThreshold: 0.04 * 255 * 3 };
// Mouse wheel and trackpad: this much scrolling is one click of the encoder.
const WHEEL_STEP = 60;

const $ = (selector) => document.querySelector(selector);
const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
// What comes from a project, an app or a tool (names, ids, paths, the lines a build prints, the titles and messages
// of checks, the labels and values of settings, console lines) is put on the page as text, with textContent or a
// property, and never as markup: markup made of such a string could press the page's buttons. The only markup the
// script writes is its own, with icons by their names.

/** An icon of BUSY's own set (icons/busy), by its name there, from the set's one file; nothing for what is no name. */
const icon = (name) => (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? `<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><use href="/emulator/icons/busy-sprite.svg#bi-${name}"/></svg>` : "");

// ---------------------------------------------------------------- front display: LEDs

const front = $("#front");
const frontCtx = front.getContext("2d");
const frontSource = Object.assign(document.createElement("canvas"), { width: FRONT.width, height: FRONT.height });
const frontSourceCtx = frontSource.getContext("2d");
let frontPixels = new Uint8Array(FRONT.width * FRONT.height * 3);

function sizeFront() {
  const dpr = window.devicePixelRatio || 1;
  front.width = Math.round(front.clientWidth * dpr);
  front.height = Math.round(front.clientHeight * dpr);
  drawFront();
}
new ResizeObserver(sizeFront).observe(front);

function drawFront() {
  const { width, height } = front;
  if (!width || !height) return;
  const cell = width / FRONT.width;
  const ctx = frontCtx;
  ctx.clearRect(0, 0, width, height);

  // The picture in RGB, for the glow under the LEDs.
  const image = frontSourceCtx.createImageData(FRONT.width, FRONT.height);
  for (let i = 0; i < FRONT.width * FRONT.height; i++) {
    image.data.set([frontPixels[i * 3 + 2], frontPixels[i * 3 + 1], frontPixels[i * 3], 255], i * 4);
  }
  frontSourceCtx.putImageData(image, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 0.45;
  ctx.filter = `blur(${cell * 0.9}px)`;
  ctx.drawImage(frontSource, 0, 0, width, height);
  ctx.restore();

  const size = cell * LED.size;
  const radius = (size / 2) * Math.sqrt(LED.radius);
  const offset = (cell - size) / 2;
  for (let y = 0; y < FRONT.height; y++) {
    for (let x = 0; x < FRONT.width; x++) {
      const i = (y * FRONT.width + x) * 3;
      const b = frontPixels[i], g = frontPixels[i + 1], r = frontPixels[i + 2];
      ctx.fillStyle = r + g + b < LED.darkThreshold ? "rgba(255,255,255,0.035)" : `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.roundRect(x * cell + offset, y * cell + offset, size, size, radius);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------- back display: 4-bit OLED

const backCtx = $("#back").getContext("2d");

function drawBack(bytes) {
  const image = backCtx.createImageData(BACK.width, BACK.height);
  for (let i = 0; i < BACK.width * BACK.height; i++) {
    const v = ((bytes[i >> 1] >> ((i & 1) * 4)) & 0xf) * 17;
    image.data.set([v, v, v, 255], i * 4);
  }
  backCtx.putImageData(image, 0, 0);
}

// ---------------------------------------------------------------- keys

const post = (url) => fetch(url, { method: "POST" }).catch(() => {});
const held = new Set();
const downs = new Map(); // a key → its "down" on the way to the bar: its "up" goes after it

function keyDown(key) {
  if (held.has(key)) return;
  held.add(key);
  document.querySelectorAll(`[data-key="${key}"]`).forEach((el) => el.classList.add("down"));
  downs.set(key, post(`/_emu/key?key=${key}&action=down`));
}

function keyUp(key) {
  if (!held.delete(key)) return;
  document.querySelectorAll(`[data-key="${key}"]`).forEach((el) => el.classList.remove("down"));
  Promise.resolve(downs.get(key)).then(() => post(`/_emu/key?key=${key}&action=up`));
}

function holdable(el, key) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    keyDown(key);
  });
  for (const type of ["pointerup", "pointercancel"]) el.addEventListener(type, () => keyUp(key));
}

// Start / Pause and Back, under the bar and on its picture, are held as long as the pointer holds them. The wheel's
// press is the wheel's own gesture, below.
document.querySelectorAll("[data-key]:not(.wheel-ok)").forEach((el) => holdable(el, el.dataset.key));
holdable($("#wheel-hot"), "ok");

// ---------------------------------------------------------------- the wheel

// The encoder: "up" is clockwise (delta +1 in the app's input event), "down" counterclockwise. One click of it turns
// the wheel's ring, with its mark, by one detent; OK in its middle stays upright.
const DETENT = 15; // degrees
const wheel = $("#wheel");
const wheelRing = $("#wheel-ring");
let wheelAngle = 0;

function turn(direction) {
  wheelAngle += direction === "up" ? DETENT : -DETENT;
  wheelRing.style.transform = `rotate(${wheelAngle}deg)`;
  post(`/api/input?key=${direction}`);
}
document.querySelectorAll("[data-wheel]").forEach((el) => el.addEventListener("click", () => turn(el.dataset.wheel)));

/** Where the pointer is around the middle of an element, degrees clockwise from the top, −180 to 180. */
function angleAround(el, e) {
  const box = el.getBoundingClientRect();
  return (Math.atan2(e.clientX - (box.left + box.width / 2), box.top + box.height / 2 - e.clientY) * 180) / Math.PI;
}
/** The shorter way from one angle to another, degrees: positive is clockwise. */
const turned = (from, to) => ((to - from + 540) % 360) - 180;

// One gesture for the whole wheel. Dragged around, it turns: each detent the pointer passes is one click. Pressed
// on its face and not moved, it is OK: a short press when let go at once, a held one after PRESS_AFTER_MS, so that
// the start of a drag across the face is not taken for a press.
const FACE = 0.36; // the radius of OK in the middle, inside the ring, of the wheel's width (window.css)
const PRESS_AFTER_MS = 140;
const DRAG_PX = 5;
let touch = null; // { x, y, mode: "pending" | "press" | "turn", last, rest, timer }

wheel.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  wheel.setPointerCapture(e.pointerId);
  const box = wheel.getBoundingClientRect();
  const onFace = Math.hypot(e.clientX - (box.left + box.width / 2), e.clientY - (box.top + box.height / 2)) <= box.width * FACE;
  const started = { x: e.clientX, y: e.clientY, mode: onFace ? "pending" : "turn", last: angleAround(wheel, e), rest: 0, timer: null };
  if (onFace) {
    started.timer = setTimeout(() => {
      if (touch !== started || started.mode !== "pending") return;
      started.mode = "press";
      keyDown("ok");
    }, PRESS_AFTER_MS);
  }
  touch = started;
});
wheel.addEventListener("pointermove", (e) => {
  if (!touch) return;
  if (touch.mode === "pending" && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) >= DRAG_PX) {
    clearTimeout(touch.timer);
    touch.mode = "turn";
    touch.last = angleAround(wheel, e);
  }
  if (touch.mode !== "turn") return;
  const now = angleAround(wheel, e);
  touch.rest += turned(touch.last, now);
  touch.last = now;
  while (Math.abs(touch.rest) >= DETENT) {
    turn(touch.rest > 0 ? "up" : "down");
    touch.rest -= Math.sign(touch.rest) * DETENT;
  }
});
wheel.addEventListener("pointerup", () => {
  if (!touch) return;
  clearTimeout(touch.timer);
  if (touch.mode === "pending") keyDown("ok");
  if (touch.mode !== "turn") keyUp("ok");
  touch = null;
});
wheel.addEventListener("pointercancel", () => {
  if (!touch) return;
  clearTimeout(touch.timer);
  if (touch.mode === "press") keyUp("ok");
  touch = null;
});

// The mouse wheel and the trackpad, over the bar and over its wheel.
let wheelRest = 0;
function onScroll(e) {
  e.preventDefault();
  wheelRest += e.deltaMode === 0 ? e.deltaY : e.deltaY * WHEEL_STEP;
  while (Math.abs(wheelRest) >= WHEEL_STEP) {
    turn(wheelRest > 0 ? "up" : "down");
    wheelRest -= Math.sign(wheelRest) * WHEEL_STEP;
  }
}
$("#bar").addEventListener("wheel", onScroll, { passive: false });
wheel.addEventListener("wheel", onScroll, { passive: false });

// The keyboard is the bar's: Space is Start, Enter is OK, Escape is Back, the arrows turn the wheel. Two exceptions:
// a field that is typed in, and a control that has the focus, which gets the key itself. A control has the focus
// only when it was reached with the keyboard (Tab): the mouse does not leave it on what it clicks (below), so a
// click and then Space is still the bar's Start. On such a control that is a key of the bar, Enter and Space press
// that key, and it can be held.
const KEYBOARD = { Enter: "ok", NumpadEnter: "ok", Escape: "back", Backspace: "back", " ": "start" };
const ARROWS = { ArrowRight: "up", ArrowDown: "up", ArrowLeft: "down", ArrowUp: "down" };
const CONTROL = "button, a[href], [role=slider]";
const pressed = new Map(); // a key of the keyboard → the key of the bar it holds
let byPointer = false; // the last thing done was done with the pointer
addEventListener("pointerdown", () => (byPointer = true), true);
// A click does not move the focus to a button or a link; a switch, a slider or a list changed with the pointer lets
// the focus go. What is typed in keeps it.
addEventListener("mousedown", (e) => e.target.closest?.(CONTROL) && e.preventDefault());
addEventListener("change", (e) => byPointer && e.target.matches?.("input[type=checkbox], input[type=range], select") && e.target.blur(), true);
addEventListener("keydown", (e) => {
  byPointer = false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest("input, textarea, select")) return;
  const own = e.target.closest(CONTROL);
  if (own) {
    const key = own.dataset?.key;
    if (!key || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (!e.repeat) {
      pressed.set(e.key, key);
      keyDown(key);
    }
  } else if (ARROWS[e.key]) {
    e.preventDefault();
    turn(ARROWS[e.key]);
  } else if (KEYBOARD[e.key]) {
    e.preventDefault();
    if (!e.repeat) {
      pressed.set(e.key, KEYBOARD[e.key]);
      keyDown(KEYBOARD[e.key]);
    }
  }
});
addEventListener("keyup", (e) => {
  if (!pressed.has(e.key)) return;
  keyUp(pressed.get(e.key));
  pressed.delete(e.key);
});
// A button the window lost track of (focus left mid-press) is released, as a finger would be.
addEventListener("blur", () => {
  [...held].forEach(keyUp);
  pressed.clear();
});

// ---------------------------------------------------------------- the mode switch

// The rotary on the left of the top, five positions: each is a key of its own (InputKeyBusy…Settings), sent when the
// switch comes to it. In the controls it is a key-shaped knob (the lever) whose tip points at the position the bar's
// switch is at, the five named on an arc beside it, top to bottom as on the bar: OFF straight left, 20° a position up
// or down. A click on a name moves it there. Dragged round, it goes from detent to detent, and each one it comes to is
// sent, as the real switch passes through the positions between.
const POSITIONS = ["busy", "custom", "off", "apps", "settings"];
const dial = $("#dial");
const lever = $("#lever");
const strip = $("#strip");
const LEVER_STEP = 20; // degrees between two positions
// The knob's pivot in the drawing of the controls (window.css, "the controls"): 900 units across.
const PIVOT = { x: 217, y: 97.3, width: 900 };
let position = null;
let leverDrag = null; // the index the dragged lever stands at

function pointLever(index) {
  lever.style.transform = `rotate(${(2 - index) * LEVER_STEP}deg)`;
}

function renderSelector(current) {
  position = current;
  document.querySelectorAll("[data-select]").forEach((el) => el.classList.toggle("on", el.dataset.select === current));
  const index = POSITIONS.indexOf(current);
  lever.ariaValueNow = String(index);
  lever.ariaValueText = current ?? "";
  if (leverDrag === null && index >= 0) pointLever(index);
}

const select = (pos) => pos !== position && post(`/api/input?key=${pos}`);
document.querySelectorAll("[data-select]").forEach((el) => el.addEventListener("click", () => select(el.dataset.select)));
$("#selector-hot").addEventListener("click", (e) => {
  const i = POSITIONS.indexOf(position);
  select(POSITIONS[(i + (e.shiftKey ? POSITIONS.length - 1 : 1)) % POSITIONS.length]);
});

/** The position the knob's tip would point at with the pointer where it is: by its angle round the pivot. */
function positionAt(e) {
  const box = strip.getBoundingClientRect();
  const unit = box.width / PIVOT.width;
  const up = box.top + PIVOT.y * unit - e.clientY;
  const left = Math.max(1, box.left + PIVOT.x * unit - e.clientX);
  const angle = (Math.atan2(up, left) * 180) / Math.PI;
  return Math.min(POSITIONS.length - 1, Math.max(0, 2 - Math.round(angle / LEVER_STEP)));
}
lever.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  lever.setPointerCapture(e.pointerId);
  leverDrag = Math.max(0, POSITIONS.indexOf(position));
});
lever.addEventListener("pointermove", (e) => {
  if (leverDrag === null) return;
  const index = positionAt(e);
  if (index === leverDrag) return;
  // One detent at a time, through the positions between, as the switch itself turns.
  const step = Math.sign(index - leverDrag);
  while (leverDrag !== index) {
    leverDrag += step;
    post(`/api/input?key=${POSITIONS[leverDrag]}`);
  }
  pointLever(leverDrag);
});
for (const type of ["pointerup", "pointercancel"]) {
  lever.addEventListener(type, () => {
    if (leverDrag === null) return;
    // It stays where it was left until the bar says where the switch is.
    const left = leverDrag;
    leverDrag = null;
    if (POSITIONS[left] === position) pointLever(left);
  });
}
// Reached with the keyboard, the lever turns with the arrows: up towards BUSY, down towards SETTINGS.
lever.addEventListener("keydown", (e) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const index = POSITIONS.indexOf(position) + step;
  if (index >= 0 && index < POSITIONS.length) select(POSITIONS[index]);
});

// ---------------------------------------------------------------- the RGB LEDs beside Start / Pause

// The bar's two RGB LEDs, its status lights, show from under the ends of Start / Pause; the firmware lights them (the
// BUSY timer, the brightness setting, pairing) and so does an app (POST /api/display/draw with
// led_notification_color). The emulator says their state in the event "lights" of /_emu/events:
//   { preset: "off" | "static" | "fade" | "rainbow" | "blink" | "notification", color: "#rrggbb", brightness: 0..1 }
// as the firmware's status_lights_run_preset() and its brightness have it. Both LEDs show the same. Until the event
// comes they are off. A notification is three blinks at full brightness, then dark, as on the bar.
const LIGHT_PRESETS = ["off", "static", "fade", "rainbow", "blink", "notification"];
// The firmware's rainbow is dim: its colors have the HSV value 16 of 255 (status_lights/presets/rainbow_gradient.c),
// under the brightness the lights run at.
const RAINBOW_VALUE = 16 / 255;
const leds = [$("#led-left"), $("#led-right")];

// What the eye makes of a status LED, as the 3D view has it (stage/frame/leds.js, statusLedLook): the firmware drives
// each channel at component / 255 × brightness^1.85 of full PWM, and a real LED even at a few percent of that reads as
// plainly lit and saturated, while its color times the duty on a screen looks dull. So the LED shows its own hue at
// full strength (its largest channel at 255); `glow` 0..1, the cube root of the duty doubled and eased, says how lit
// it looks (the BUSY timer's red at the default brightness: full; the rainbow: about two thirds; the lowest brightness:
// about half); `halo`, the cube root of the duty, how far its light spreads, which grows on with the brightness.
function ledLook(rgb, level, value) {
  const peak = Math.max(...rgb);
  if (!(peak > 0) || !(level > 0)) return null;
  const halo = Math.cbrt(Math.min(1, value ?? peak / 255) * Math.min(1, level) ** 1.85);
  return { hue: rgb.map((v) => Math.round((v / peak) * 255)), glow: Math.min(1, 2 * halo) ** 0.6, halo };
}

function renderLights(lights) {
  const preset = LIGHT_PRESETS.includes(lights?.preset) ? lights.preset : "off";
  const color = /^#[0-9a-f]{6}$/i.test(lights?.color ?? "") ? lights.color.toLowerCase() : "#000000";
  const brightness = preset === "notification" ? 1 : Math.min(1, Math.max(0, Number.isFinite(lights?.brightness) ? lights.brightness : 1));
  // The rainbow turns from red.
  const rgb = preset === "rainbow" ? [255, 0, 0] : [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const look = preset === "off" ? null : ledLook(rgb, brightness, preset === "rainbow" ? RAINBOW_VALUE : undefined);
  const hex = (bytes) => `#${bytes.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const lit = Boolean(look);
  // The core: the hue, toward the dark LED's gray the less lit it looks; at full glow a touch of white, as a lit LED's
  // middle looks hot. The halo: the hue's own light round the shape, wider and stronger with the brightness.
  const hue = lit ? hex(look.hue) : "transparent";
  const core = !lit ? "transparent" : look.glow >= 1 ? `color-mix(in srgb, ${hue} ${Math.round(100 - 18 * look.halo)}%, #fff)` : `color-mix(in srgb, ${hue} ${Math.round(40 + 60 * look.glow)}%, #262626)`;
  const r = (n) => Math.round(n * 10) / 10;
  const filter = !lit ? "none" : `drop-shadow(0 0 ${r(1 + 2 * look.glow)}px ${hue}) drop-shadow(0 0 ${r(4 + 12 * look.halo)}px color-mix(in srgb, ${hue} ${Math.round(35 + 45 * look.halo)}%, transparent)) drop-shadow(0 0 ${r(10 + 22 * look.halo)}px color-mix(in srgb, ${hue} ${Math.round(12 + 28 * look.halo)}%, transparent))`;
  for (const led of leds) {
    for (const name of LIGHT_PRESETS) led.classList.remove(name);
    led.classList.toggle("lit", lit);
    led.style.setProperty("--led", core);
    led.style.setProperty("--led-hue", hue);
    led.style.setProperty("--led-filter", filter);
    if (!lit) continue;
    void led.offsetWidth; // a new notification blinks from its start
    led.classList.add(preset);
  }
}
renderLights(null);

// ---------------------------------------------------------------- the view: 2D, and 3D when it is there

// The view in depth is a module of its own, window.emulatorStage3D: available() says whether it can draw here,
// mount(box) draws the bar in the box that holds its picture, unmount() takes it away. Without the module, or where
// it cannot draw, 3D is not there to be chosen and its tooltip says why.
const deviceView = $("#device-view");
const view2d = $("#view-2d");
const view3d = $("#view-3d");
const stage3d = () => globalThis.emulatorStage3D ?? null;
let canMount = false;
let mounted = false;

async function check3d() {
  let can = false;
  try {
    can = (await stage3d()?.available?.()) === true;
  } catch {
    // It cannot say: it is not there.
  }
  canMount = can;
  aria(view3d, "disabled", can ? "false" : "true");
  view3d.title = can ? "" : stage3d() ? "3D view needs WebGL2" : "3D view is coming";
}

function showView(in3d) {
  mounted = in3d;
  showCameraViews(in3d); // the 3D view's camera, below
  $("#bar").hidden = in3d;
  view2d.classList.toggle("on", !in3d);
  view3d.classList.toggle("on", in3d);
  aria(view2d, "pressed", String(!in3d));
  aria(view3d, "pressed", String(in3d));
}

view3d.addEventListener("click", async () => {
  if (!canMount || mounted) return;
  showView(true);
  try {
    await stage3d().mount(deviceView, { view: cameraView(), onCamera: cameraMoved });
    fitCameraInset();
  } catch {
    // It did not come up: the flat view is back.
    showView(false);
  }
});
view2d.addEventListener("click", async () => {
  if (!mounted) return;
  try {
    await stage3d()?.unmount?.();
  } catch {
    // Gone or not, the picture is shown again.
  }
  showView(false);
});
check3d();
addEventListener("load", check3d);

// ---------------------------------------------------------------- the 3D view's camera: Front, Back, Top, Side

// The bar is turned by hand in 3D (a drag beside its controls); these buttons, in the canvas at its right
// (#canvas-tools-right), are quick views: the camera flies there, and a drag goes on from there. The button of the view
// the camera is at is lit, none once the bar is turned away from it. The window remembers the last one picked for as
// long as it is open (the session): the view comes up there, and a double click on its background goes back there.
const CAMERA_VIEWS = ["front", "back", "top", "side"];
const CAMERA_KEY = "busy-emulator.camera";
function cameraView() {
  let view = null;
  try {
    view = sessionStorage.getItem(CAMERA_KEY);
  } catch {
    // No storage: the front.
  }
  return CAMERA_VIEWS.includes(view) ? view : "front";
}
const cameraGroup = $("#camera-views");
function markCameraView(view) {
  for (const button of cameraGroup.querySelectorAll("button")) {
    const on = button.dataset.camera === view;
    button.classList.toggle("on", on);
    aria(button, "pressed", String(on));
  }
}
function showCameraViews(on) {
  cameraGroup.hidden = !on;
  if (on) markCameraView(cameraView());
}
function pickCameraView(view) {
  try {
    sessionStorage.setItem(CAMERA_KEY, view);
  } catch {
    // Remembered or not, the camera goes there.
  }
  markCameraView(view);
  stage3d()?.camera?.(view);
}
// The view says where its camera went: away from the quick views (null), or back to one by a double click.
function cameraMoved(view) {
  if (!mounted) return;
  if (view) {
    try {
      sessionStorage.setItem(CAMERA_KEY, view);
    } catch {
      // Remembered or not, the button is lit.
    }
  }
  markCameraView(view);
}
cameraGroup.addEventListener("click", (e) => {
  const button = e.target.closest("button[data-camera]");
  if (button && mounted) pickCameraView(button.dataset.camera);
});
// With the keyboard: the arrows go along the column, and the camera with them.
cameraGroup.addEventListener("keydown", (e) => {
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!step || !mounted) return;
  e.preventDefault();
  const buttons = [...cameraGroup.querySelectorAll("button")];
  const at = buttons.indexOf(document.activeElement);
  const next = buttons[(Math.max(0, at) + step + buttons.length) % buttons.length];
  next.focus();
  pickCameraView(next.dataset.camera);
});
// Where the column lies over the view, the view keeps that much clear on both sides, so that the bar stays in the middle.
// The dock of the controls under the bar does the same from below: the model stands above it, and the frame still
// takes the whole canvas, so that a drag around the controls turns the bar.
const dock = $("#dock");
function fitCameraInset() {
  const frame = deviceView.querySelector("iframe.stage3d");
  if (!mounted || !frame) return;
  const view = frame.getBoundingClientRect();
  const tools = cameraGroup.getBoundingClientRect();
  const overlaps = tools.width > 0 && tools.left < view.right && tools.right > view.left && tools.top < view.bottom && tools.bottom > view.top;
  const below = dock.getBoundingClientRect();
  const under = below.height > 0 && below.top < view.bottom ? view.bottom - below.top + 12 : 0;
  stage3d()?.inset?.({ right: overlaps ? view.right - tools.left + 8 : 0, bottom: under });
}
if (typeof ResizeObserver === "function") {
  const watch = new ResizeObserver(fitCameraInset);
  watch.observe(deviceView);
  watch.observe(dock);
}
addEventListener("resize", fitCameraInset);

// ---------------------------------------------------------------- the speaker

// The bar's sounds: raw 16-bit mono PCM at 44100 Hz, fetched when the bar starts one. A browser lets a page make
// sound only after the user has touched it, so until then the speaker in the bar's strip says so.
let audioContext = null;
let audioGain = null;
let audioSource = null;
let audioVolume = 50;
const audioNote = $("#audio-note");

// `playing`: the length of the sound the bar has just started, seconds. One that started while the sound was off
// is not heard: the note turns to the warning color and its tooltip says what was missed.
function renderAudioNote(playing) {
  const ready = audioContext?.state === "running";
  const sound = playing === undefined ? null : `a ${playing.toFixed(1)} s sound`;
  // The note is a speaker in the bar's strip: its words are its name for a screen reader and its tooltip.
  audioNote.textContent = ready ? (sound ? `Playing ${sound}` : "Sound on") : "Click anywhere to turn sound on";
  audioNote.title = !ready && sound ? `The BUSY Bar is playing ${sound}. ${audioNote.textContent}` : audioNote.textContent;
  audioNote.classList.toggle("on", ready);
  audioNote.classList.toggle("missed", !ready && sound !== null);
  const speaker = $("#audio-icon");
  speaker.innerHTML = icon(ready ? "sound" : "sound-off");
  speaker.title = audioNote.title;
  // layout-v2: the speaker is the volume's: its row says what the sound does.
  $(".set.sound").title = `The BUSY Bar's volume. ${audioNote.title}`;
}

renderAudioNote();

function enableAudio() {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: 44100 });
    audioGain = audioContext.createGain();
    audioGain.connect(audioContext.destination);
    audioGain.gain.value = audioVolume / 100;
    // A context made on a click is often running at once, with no resume to wait for: the note follows its state.
    audioContext.addEventListener("statechange", () => renderAudioNote());
    if (audioContext.state === "running") renderAudioNote();
  }
  if (audioContext.state !== "running") audioContext.resume().then(() => renderAudioNote());
}
addEventListener("pointerdown", enableAudio);
addEventListener("keydown", enableAudio);

// The audio service's fade envelope (audio_i.h): a sound comes in over 1 ms (4410 steps, 100 a sample) and goes out
// over 10 ms (10 a sample) when it is stopped or replaced; the next sound starts after the fade-out.
const FADE_IN_S = 0.001;
const FADE_OUT_S = 0.01;
let audioFade = null; // the playing sound's own gain

// Fades the playing sound out; returns the time, on the audio clock, when it is silent.
function stopAudio() {
  if (!audioSource || !audioContext) return audioContext?.currentTime ?? 0;
  const now = audioContext.currentTime;
  try {
    audioFade.gain.cancelScheduledValues(now);
    audioFade.gain.setValueAtTime(audioFade.gain.value, now);
    audioFade.gain.linearRampToValueAtTime(0, now + FADE_OUT_S);
    audioSource.stop(now + FADE_OUT_S);
  } catch {
    // Already ended.
  }
  audioSource = null;
  audioFade = null;
  return now + FADE_OUT_S;
}

async function onAudio(event) {
  if (event.action === "volume" || event.volume !== undefined) {
    audioVolume = event.volume;
    if (audioGain) audioGain.gain.value = audioVolume / 100;
    renderVolume?.(audioVolume);
  }
  if (event.action === "stop") {
    stopAudio();
    renderAudioNote();
  }
  if (event.action !== "play") return;
  const silentAt = stopAudio();
  if (audioContext?.state !== "running") return renderAudioNote(event.seconds);
  const response = await fetch(`/_emu/audio?id=${event.id}`);
  if (!response.ok) return;
  const pcm = new Int16Array(await response.arrayBuffer());
  if (!pcm.length) return;
  const buffer = audioContext.createBuffer(1, pcm.length, 44100);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
  const startAt = Math.max(audioContext.currentTime, silentAt);
  audioFade = audioContext.createGain();
  audioFade.gain.setValueAtTime(0, startAt);
  audioFade.gain.linearRampToValueAtTime(1, startAt + FADE_IN_S);
  audioFade.connect(audioGain);
  audioSource = audioContext.createBufferSource();
  audioSource.buffer = buffer;
  audioSource.connect(audioFade);
  audioSource.start(startAt);
  renderAudioNote(event.seconds);
}

// ---------------------------------------------------------------- Wi-Fi, USB and the battery

const statusWifi = $("#status-wifi");
const statusUsb = $("#status-usb");
const statusBattery = $("#status-battery");

function renderStatus(status) {
  if (!status) return;
  statusWifi.checked = status.wifi;
  statusUsb.checked = status.usb;
  // The slider is the user's while it is being dragged.
  if (document.activeElement !== statusBattery) statusBattery.value = status.battery;
  statusBattery.style.backgroundSize = `${status.battery}% 100%`;
  $("#status-battery-text").textContent = `${status.battery}%`;
  // The battery's icon is one of the set's five, by the charge, and the charging one while the cable is in.
  $("#battery-icon").innerHTML = icon(`battery-${status.usb ? "charging-" : ""}${Math.max(1, Math.min(5, Math.ceil(status.battery / 20)))}`);
  $("#power-note").hidden = status.powered !== false;
  if (powered !== (status.powered !== false)) {
    powered = status.powered !== false;
    renderAll();
    loadSettings();
  }
}

// ---------------------------------------------------------------- bar-address: the bar's address, its API, Restart bar
//
// The bar answers on this page's own address (the device window comes from the bar's address, ADR-0012): that is what
// the card shows to copy and to open, and its API documentation is there at /docs/. In the desktop app the links open
// in the system's browser (the shell's "browse", only for the bar's own pages); in a browser, in a new tab.
const barAddress = $("#bar-address");
barAddress.textContent = location.origin;
barAddress.href = `${location.origin}/`;
for (const link of [barAddress, $("#api")]) {
  link.addEventListener("click", async (event) => {
    if (!inShell()) return;
    event.preventDefault();
    await actions()
      .browse(link.href)
      .catch(() => false);
  });
}
const barAddressCopy = $("#bar-address-copy");
barAddressCopy.addEventListener("click", async () => {
  const done = await copyText(location.origin);
  barAddressCopy.title = done === "again" ? "Click again" : done ? "Copied" : "Not copied";
  barAddressCopy.classList.toggle("copied", done === true);
  setTimeout(() => {
    barAddressCopy.title = "Copy the address of BUSY Bar";
    barAddressCopy.classList.remove("copied");
  }, 2000);
});

// Restart bar: the restart a bar does when Back and Start are held, whatever its software does. The button turns
// until the bar is up again (the server answers then, wait=1) and says how long it took.
const powerRestart = $("#power-restart");
const powerRestartLabel = powerRestart.querySelector(".label");
let powerRestartReset = null;
powerRestart.addEventListener("click", async () => {
  if (powerRestart.ariaBusy === "true") return;
  clearTimeout(powerRestartReset);
  powerRestart.classList.remove("done");
  powerRestart.ariaBusy = "true";
  powerRestartLabel.textContent = "Restarting";
  let said = "Not restarted";
  try {
    const answer = await fetch("/_emu/power?action=restart&wait=1", { method: "POST" });
    const body = await answer.json().catch(() => ({}));
    if (answer.ok) {
      said = `Back up in ${(body.ms / 1000).toFixed(1)} s`;
      powerRestart.classList.add("done");
    }
  } catch {
    // The server went away: said stays "Not restarted".
  }
  powerRestart.ariaBusy = "false";
  powerRestartLabel.textContent = said;
  powerRestartReset = setTimeout(() => {
    powerRestartLabel.textContent = "Restart BUSY Bar";
    powerRestart.classList.remove("done");
  }, 3000);
});

statusWifi.addEventListener("change", () => post(`/_emu/status?wifi=${statusWifi.checked ? 1 : 0}`));

// layout-v2: the bar's volume, as its settings have it: shown from the speaker's events, set through the bar's API.
const statusVolume = $("#status-volume");
function renderVolume(volume) {
  if (!Number.isFinite(volume)) return;
  if (document.activeElement !== statusVolume) statusVolume.value = volume;
  statusVolume.style.backgroundSize = `${volume}% 100%`;
  $("#status-volume-text").textContent = `${volume}%`;
}
statusVolume.addEventListener("input", () => {
  renderVolume(Number(statusVolume.value));
  post(`/api/audio/volume?volume=${statusVolume.value}`);
});

// layout-v2: what the bar is (its serial number) and how long it has been on, from GET /api/status/system, read
// again now and then; the clock ticks here between.
let uptimeFrom = null; // the computer's time the bar started, ms
function renderUptime() {
  if (uptimeFrom === null) return void ($("#device-uptime").textContent = "");
  const seconds = Math.max(0, Math.floor((Date.now() - uptimeFrom) / 1000));
  const p = (n) => String(n).padStart(2, "0");
  $("#device-uptime").textContent = `up ${p(Math.floor(seconds / 3600))}:${p(Math.floor(seconds / 60) % 60)}:${p(seconds % 60)}`;
}
async function loadDevice() {
  try {
    const [system, device] = await Promise.all(["system", "device"].map((part) => fetch(`/api/status/${part}`).then((r) => (r.ok ? r.json() : null))));
    const m = String(system?.uptime ?? "").match(/^(\d+)d (\d+)h (\d+)m (\d+)s$/);
    // The hours are counted with the days in them (api_status.c).
    uptimeFrom = m ? Date.now() - (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000 : null;
    $("#device-serial").textContent = typeof device?.serial_number === "string" ? device.serial_number : "";
    // bar-address: the serial number is the address line's tooltip.
    $("#bar-address-line").title = $("#device-serial").textContent ? `Serial number ${$("#device-serial").textContent}` : "";
  } catch {
    uptimeFrom = null;
  }
  renderUptime();
}
globalThis.setInterval?.(renderUptime, 1000);
globalThis.setInterval?.(loadDevice, 60_000);
statusUsb.addEventListener("change", () => post(`/_emu/status?usb=${statusUsb.checked ? 1 : 0}`));
statusBattery.addEventListener("input", () => {
  statusBattery.style.backgroundSize = `${statusBattery.value}% 100%`;
  post(`/_emu/status?battery=${statusBattery.value}`);
});

// ---------------------------------------------------------------- apps, projects and the chosen app

// The actions of a project (create, build, run, refresh, check, show its folder) are the desktop app's: it gives
// them as window.emulatorActions (actions.js; the contract is README.md beside this file). In a browser there are
// none: their buttons are not there to be pressed, and say where they are.
const actions = () => globalThis.emulatorActions ?? null;
function inShell() {
  try {
    return actions()?.available?.().shell === true;
  } catch {
    return false;
  }
}
const NEEDS_APP = "Available in the BUSY Bar Emulator app";
const FILE_MANAGER = /win/i.test(globalThis.navigator?.platform ?? "") ? "Explorer" : "Finder";

/**
 * An ARIA state of an element, as the property and as the attribute: the style sheet follows the attribute
 * ([aria-disabled="true"], [aria-selected="true"]), and Chromium does not always restyle for the property alone.
 */
function aria(el, state, value) {
  el[`aria${state[0].toUpperCase()}${state.slice(1)}`] = value;
  el.setAttribute?.(`aria-${state}`, value);
}

/** An element with a class and a text; the text is set as text. */
function make(tag, className = "", text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null) el.textContent = text;
  return el;
}

/**
 * A button with a picture, a word or both. It is there to be pressed, or is not and says why in its tooltip; pressed
 * while not, it does nothing.
 */
function button(className, label, why, onClick, tooltip = "", picture = null) {
  const el = make("button", className);
  if (picture) el.innerHTML = icon(picture);
  if (label) el.append(make("span", "", label));
  el.type = "button";
  aria(el, "disabled", why ? "true" : "false");
  el.title = why ?? tooltip;
  el.addEventListener("click", (e) => {
    e.stopPropagation?.();
    if (!why) onClick(e);
  });
  return el;
}

const appsList = $("#apps");
const appTitle = $("#app-title");
const appActions = $("#app-actions");
const appBody = $("#app-body");
let runningId = null;
let installed = null; // the apps as the bar last listed them; null until it has
let projects = []; // the person's projects, as the desktop app lists them: { id, name, folder, exists, … }
let chosenId = null; // the app the middle section is about
let powered = true;
let notice = null; // what just happened to a project, said in the list for a while
let reveal = false; // the chosen app has changed and its row has not been brought into view yet

// ---- the list

/** The kind of the job that runs on a row's project now, by this page's own word or the list's; null when none does. */
function working(row) {
  if (!row?.project) return null;
  const job = jobs.get(row.project.folder);
  return job?.state === "running" ? job.kind : job ? null : (row.project.job ?? null);
}
const AWAY = "Its folder is not there: is its disk plugged in?";

/**
 * The rows of the list: the person's projects first, each an app bound to its folder, then what else is on the bar.
 * A project whose folder is gone is not listed. An app that runs and is named by neither still has a row.
 */

function rows() {
  const byId = new Map();
  for (const p of projects) {
    // A folder that is gone is not listed; one whose disk is away (unavailable) stays and waits for it.
    if (p.exists !== false || p.unavailable) byId.set(p.id, { id: p.id, name: p.name ?? p.id, version: "", onBar: false, project: p });
  }
  for (const app of installed ?? []) byId.set(app.id, { ...(byId.get(app.id) ?? { project: null }), id: app.id, name: app.name, version: app.version, icon_path: app.icon_path, onBar: true });
  if (runningId !== null && !byId.has(runningId)) byId.set(runningId, { id: runningId, name: runningId, version: "", onBar: true, project: null });
  const all = [...byId.values()];
  return [...all.filter((row) => row.project), ...all.filter((row) => !row.project)];
}
const chosen = () => rows().find((row) => row.id === chosenId) ?? null;

function choose(id) {
  if (id === chosenId) return;
  chosenId = id;
  reveal = true;
  settings = null;
  renderSettings();
  renderApps();
  renderApp();
  loadSettings();
}

/** The app the section is about when nobody chose one, or the chosen one is gone: the running one, else the first. */
function chooseDefault() {
  const all = rows();
  if (all.some((row) => row.id === chosenId)) return;
  chosenId = (all.find((row) => row.id === runningId) ?? all[0])?.id ?? null;
  reveal = true;
  settings = null;
  loadSettings();
}

// An app's icon is the 8×8 PNG of its front display, read from the bar's storage. An app without one has the
// firmware's own picture, in the firmware's format: the row then shows a plain square.
const PNG_START = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const icons = new Map(); // app id → the address of its picture, or null

async function loadIcon(app) {
  if (!String(app.icon_path ?? "").endsWith(".png")) return null;
  try {
    const response = await fetch(`/api/storage/read?path=${encodeURIComponent(app.icon_path)}`);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!PNG_START.every((byte, i) => bytes[i] === byte)) return null;
    return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  } catch {
    return null;
  }
}

async function loadIcons(apps) {
  const loaded = await Promise.all(apps.map(async (app) => [app.id, await loadIcon(app)]));
  const before = [...icons.values()].filter(Boolean);
  icons.clear();
  for (const [id, address] of loaded) icons.set(id, address);
  if (before.length || loaded.some(([, address]) => address)) renderApps();
  for (const address of before) URL.revokeObjectURL(address);
}

// The list is read again on every "apps" event, a Refresh, a Delete, the page's connection: several reads at once
// while an app is installed. Each has its number, and what a read brought is shown only when no later read has shown
// its own: an answer that comes back late never draws the list over a newer one.
//
// What the bar holds is drawn as soon as the bar has said it. The projects come from the desktop app, which runs the
// command line for them (busy-emulator projects --prune): a fraction of a second on a Mac, seconds on a busy Windows
// machine. The list does not wait for them; their rows and notes follow when they come.
let appsReads = 0; // reads begun
let barShownFrom = 0; // the read whose bar list is shown
let projectsShownFrom = 0; // the read whose projects are shown
let projectsKnown = false; // the projects have been read once: until then an app on the bar is not said to be from a package
let projectsReadAt = 0; // when the read whose projects are shown began (app-column: the files-changed notice)

// A bar that is off does not answer: the list it gave last is kept, and the list says the bar is off.
async function loadApps() {
  const read = ++appsReads;
  const began = Date.now();
  if (examples === null) loadExamples();
  const asked = inShell() ? readProjects() : Promise.resolve([]); // under way while the bar answers
  let listed = null;
  try {
    const response = await fetch("/api/apps/list");
    if (response.ok) listed = (await response.json()).apps ?? [];
  } catch {
    // Not connected: the list stays as it was.
  }
  if (listed && read > barShownFrom) {
    barShownFrom = read;
    installed = listed;
    reveal = true; // the list may have a new order: the chosen app stays in view
    renderAll();
    loadIcons(listed);
  }
  const found = await asked;
  if (read > projectsShownFrom) {
    projectsShownFrom = read;
    if (found) showProjects(found);
    if (found) projectsReadAt = began;
    projectsKnown = true;
    reveal = true;
    renderAll();
  }
  loadSettings();
}

/** The person's projects, from the desktop app; null when they could not be read (the list keeps what it had). */
async function readProjects() {
  try {
    return (await actions().projects.list()) ?? [];
  } catch {
    return null;
  }
}

/** The projects as read now. One that was listed and is not any more: its folder is gone. */
function showProjects(listed) {
  const here = (p) => p.exists !== false || p.unavailable;
  const now = new Set(listed.filter(here).map((p) => p.id));
  const gone = projects.filter((p) => here(p) && !now.has(p.id));
  projects = [...listed];
  if (gone.length) say(gone.length === 1 ? `The folder of ${gone[0].name ?? gone[0].id} is gone` : `The folders of ${gone.length} apps are gone`);
}

/** A quiet line in the list, for a few seconds. */
function say(text) {
  const said = { text };
  notice = said;
  renderApps();
  setTimeout(() => {
    if (notice !== said) return;
    notice = null;
    renderApps();
  }, 6000);
}

function renderAll() {
  chooseDefault();
  renderApps();
  renderApp();
}

/** What a row says under the app's name: its version, and what is to know about it. */
function noteOf(row) {
  return twinFolder(row, rowNote(row));
}

function rowNote(row) {
  const kind = working(row);
  if (kind) return WORKING[kind] ?? "Working";
  if (row.project?.unavailable) return "Folder unavailable";
  const deps = depsTrouble(row);
  if (deps) return `Dependencies not installed: ${deps.reason}`;
  if (row.project?.dependencies?.state === "installing") return WORKING.dependencies;
  if (row.project && jobs.get(row.project.folder)?.state === "failed") return "Failed, see the app";
  if (!row.onBar) return "Not on the BUSY Bar yet";
  if (!row.project && inShell() && projectsKnown) return [row.version, "from a package"].filter(Boolean).join(", ");
  return row.version;
}

function renderApps() {
  const create = $("#create-app");
  aria(create, "disabled", inShell() && !creating ? "false" : "true");
  create.title = !inShell() ? NEEDS_APP : creating ? "Creating the app" : "Create a new app: from a template or an empty one";
  // With no app yet, Create app is the empty list's own button, the one thing to do: the heading's goes.
  create.hidden = powered && inShell() && installed !== null && !creating && rows().length === 0;
  if (!powered) {
    appsList.innerHTML = `<li class="empty"><span class="round">${icon("apps")}</span><b>The BUSY Bar is off</b></li>`;
    return;
  }
  const all = rows();
  $("#apps-count").textContent = all.length ? String(all.length) : "";
  const items = all.map((row) => {
    const li = document.createElement("li");
    const on = row.id === runningId;
    li.className = ["app", on ? "on" : "", row.id === chosenId ? "chosen" : ""].filter(Boolean).join(" ");
    li.title = row.name === row.id ? row.id : `${row.name} ${row.version}\n${row.id}`;
    li.innerHTML = `<span class="app-icon"></span><div class="app-meta"><span class="app-name"></span><span class="app-note"></span></div><div class="row-actions"></div>`;
    if (icons.get(row.id)) {
      const picture = document.createElement("img");
      picture.className = "app-icon";
      picture.alt = "";
      picture.src = icons.get(row.id);
      li.querySelector(".app-icon").replaceWith(picture);
    }
    li.querySelector(".app-name").textContent = row.name;
    li.querySelector(".app-note").textContent = noteOf(row);
    if (depsTrouble(row) && !working(row)) li.querySelector(".app-note").classList.add("trouble");
    const rowActions = li.querySelector(".row-actions");
    if (row.project && depsTrouble(row) && !working(row)) {
      // Its dependencies did not come (create-offline): Retry installs them; when it was a Refresh that stopped at
      // them, the desktop app then goes on with that Refresh.
      const retry = button("btn small row-retry", "Retry", row.project.unavailable ? AWAY : null, () => retryDependencies(row), "Install its dependencies again");
      retry.ariaLabel = `Retry installing the dependencies of ${row.name}`;
      rowActions.append(retry);
    } else if (row.project) {
      const busy = working(row) !== null;
      const refresh = button(`icon-btn small${busy ? " busy" : ""}`, "", busy ? "Working" : row.project.unavailable ? AWAY : null, () => refreshProject(row), "Refresh: build, install and start it again", "refresh");
      refresh.ariaLabel = `Refresh ${row.name}`;
      rowActions.append(refresh);
    }
    if (row.onBar) {
      const start = button(on ? "icon-btn solid" : "icon-btn outline", "", null, () => post(on ? "/api/apps/quit" : `/api/apps/launch?app_id=${encodeURIComponent(row.id)}`), on ? "Stop" : "Start", on ? "control-stop" : "control-play");
      start.ariaLabel = `${on ? "Stop" : "Start"} ${row.name}`;
      rowActions.append(start);
    }
    // A running app says so where its buttons are; they show over it under the pointer.
    if (on) li.append(make("span", "live-state", "Running"));
    li.addEventListener("click", () => openApp(row.id));
    rowMenuHooks(li, row); // the row's menu: right-click, the More button, Shift+F10 (below)
    return li;
  });
  if (creating) items.unshift(make("li", "notice", "Creating the app"));
  else if (notice) items.unshift(make("li", "notice", notice.text));
  appsList.replaceChildren(...items);
  // In a long list the chosen app's row is brought into view: the list scrolls, the page does not.
  const row = items[all.findIndex((one) => one.id === chosenId) + (creating || notice ? 1 : 0)];
  if (reveal && row && all.some((one) => one.id === chosenId)) {
    reveal = false;
    if (row.offsetTop < appsList.scrollTop) appsList.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > appsList.scrollTop + appsList.clientHeight) appsList.scrollTop = row.offsetTop + row.offsetHeight - appsList.clientHeight;
  }
  if (installed !== null && all.length === 0 && !creating) {
    // No app yet. In the desktop app the one thing to do is to create one; in a browser, to install one.
    if (inShell()) {
      appsList.innerHTML = `<li class="empty"><span class="round">${icon("apps")}</span><b>No apps yet</b><span>Start from a template or an empty app</span><button type="button" class="btn solid"></button></li>`;
      const main = appsList.querySelector("button");
      main.textContent = "Create app";
      main.addEventListener("click", createApp);
    } else {
      appsList.innerHTML = `<li class="empty"><span class="round">${icon("apps")}</span><b>No apps installed</b><span>From an app folder:</span><code>npx busy-cli app install --addr <span class="addr"></span></code></li>`;
      appsList.querySelector(".addr").textContent = location.host;
    }
  }
}

$("#refresh-apps").addEventListener("click", () => loadApps().then(retryDependenciesNow));

// ---- the row's menu and Delete (apps-delete)
//
// Every row of the Apps list has a small menu: a right-click (a two-finger click on a trackpad, Ctrl+click on macOS),
// the More button that shows on a row under the pointer or with the focus, or Shift+F10 and the Menu key on a row's
// button. It holds what can already be done to the app (Start or Stop, Show in Finder or Explorer) and Delete…, which
// asks in a dialog: remove the app from the emulator and keep its folder, or move the folder to the Trash as well
// (emulatorActions.apps.delete; packages/app/src/actions.mjs). An app installed from a package has no folder, so it
// has the first choice only. The menu closes on Escape, a click outside it, a scroll and a resize.

const TRASH = FILE_MANAGER === "Explorer" ? "Recycle Bin" : "Trash";
let rowMenu = null; // { el, id, back: the element the focus goes back to }
let menuClosedBy = null; // the More button whose press just closed its menu

function rowMenuHooks(li, row) {
  li.dataset.id = row.id;
  const more = button("icon-btn small row-more", "", null, (e) => {
    // A second click on the button of an open menu closes it (the press outside the menu has done that).
    if (menuClosedBy === more) return void (menuClosedBy = null);
    const box = more.getBoundingClientRect();
    openRowMenu(row.id, { x: box.right, y: box.bottom + 4, alignRight: true, byKey: e.detail === 0, back: more });
  }, "More", "more");
  more.ariaLabel = `More for ${row.name}`;
  more.ariaHasPopup = "menu";
  li.querySelector(".row-actions").append(more);
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openRowMenu(row.id, { x: e.clientX, y: e.clientY, byKey: false, back: null });
  });
  li.addEventListener("keydown", (e) => {
    if (!(e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) return;
    e.preventDefault();
    e.stopPropagation();
    const box = (e.target.closest("button") ?? li).getBoundingClientRect();
    openRowMenu(row.id, { x: box.left, y: box.bottom + 4, byKey: true, back: e.target.closest("button") });
  });
}

function closeRowMenu({ refocus = true } = {}) {
  if (!rowMenu) return;
  const { el, id, back } = rowMenu;
  rowMenu = null;
  el.remove();
  for (const li of appsList.querySelectorAll("li.app.menu-open")) li.classList.remove("menu-open");
  if (!refocus) return;
  // The row may have been drawn again meanwhile: its More button then stands for the one the menu came from.
  const target = back?.isConnected ? back : [...appsList.querySelectorAll("li.app")].find((li) => li.dataset.id === id)?.querySelector(".row-more");
  target?.focus({ preventScroll: true });
}

function menuItem(label, picture, onPick, { why = null, danger = false } = {}) {
  const item = button(`menu-item${danger ? " danger" : ""}`, label, why, () => {
    closeRowMenu({ refocus: false });
    onPick();
  }, why ?? "", picture);
  item.setAttribute("role", "menuitem");
  item.tabIndex = -1;
  return item;
}

function openRowMenu(id, { x, y, alignRight = false, byKey = false, back = null, full = false }) {
  closeRowMenu({ refocus: false });
  const row = rows().find((one) => one.id === id);
  if (!row) return;
  const shell = inShell();
  const on = row.id === runningId;
  const items = [];
  if (full) {
    // The opened app's More (layout-v2): what its page has no button for. Run, Stop and Refresh are on the page.
    const why = projectWhy(row);
    const watching = working(row) === "dev";
    items.push(menuItem("Build", "box", () => act(row, "build", (folder) => actions().projects.build(folder)), { why }));
    items.push(watching ? menuItem("Stop watching", "control-stop", () => dev(row, "stop"), { why: !shell ? NEEDS_APP : null }) : menuItem("Watch the folder", "eye", () => dev(row, "start"), { why }));
    items.push(menuItem("Publish…", "rocket", () => openPublish(row), { why: why ?? publishable(row) }));
    items.push(make("div", "menu-line"));
    if (!row.project && shell) items.push(menuItem("Open project…", "folder", openProject));
  } else if (row.onBar) items.push(menuItem(on ? "Stop" : "Start", on ? "control-stop" : "control-play", () => post(on ? "/api/apps/quit" : `/api/apps/launch?app_id=${encodeURIComponent(row.id)}`)));
  if (row.project) items.push(menuItem(`Show in ${FILE_MANAGER}`, "folder", () => actions().reveal(row.project.folder), { why: !shell ? NEEDS_APP : row.project.unavailable || row.project.exists === false ? AWAY : null }));
  if (items.length && !items.at(-1).classList.contains("menu-line")) items.push(make("div", "menu-line"));
  items.push(menuItem("Delete…", "trash", () => openDeleteDialog(row.id), { why: !shell ? NEEDS_APP : working(row) && working(row) !== "dev" ? "Wait for the work under way" : null, danger: true }));
  const el = make("div", "row-menu");
  el.setAttribute("role", "menu");
  el.ariaLabel = row.name;
  el.append(...items);
  document.body.append(el);
  // At the pointer, and inside the window: it turns to the other side where there is no room.
  const box = el.getBoundingClientRect();
  const left = alignRight ? x - box.width : x;
  el.style.left = `${Math.max(8, Math.min(left, innerWidth - box.width - 8))}px`;
  el.style.top = `${y + box.height + 8 > innerHeight ? Math.max(8, y - box.height - (alignRight ? 36 : 0)) : y}px`;
  rowMenu = { el, id, back };
  [...appsList.querySelectorAll("li.app")].find((li) => li.dataset.id === id)?.classList.add("menu-open");
  const enabled = () => [...el.querySelectorAll(".menu-item")].filter((item) => item.ariaDisabled !== "true");
  el.addEventListener("keydown", (e) => {
    e.stopPropagation(); // the bar's own keys (arrows, Escape, Enter) are not pressed from inside the menu
    const all = enabled();
    const at = all.indexOf(document.activeElement);
    if (e.key === "Escape") closeRowMenu();
    else if (e.key === "Tab") closeRowMenu();
    else if (e.key === "ArrowDown") all[(at + 1) % all.length]?.focus();
    else if (e.key === "ArrowUp") all[(at - 1 + all.length) % all.length]?.focus();
    else if (e.key === "Home") all[0]?.focus();
    else if (e.key === "End") all.at(-1)?.focus();
    else return;
    e.preventDefault();
  });
  // A menu opened from the keyboard has its first item in focus; one opened with the pointer, the menu itself, so that
  // Escape and the arrows work at once.
  el.tabIndex = -1;
  (byKey ? enabled()[0] ?? el : el).focus({ preventScroll: true });
}

addEventListener(
  "pointerdown",
  (e) => {
    menuClosedBy = null;
    if (!rowMenu || rowMenu.el.contains(e.target)) return;
    if (rowMenu.back && rowMenu.back.contains(e.target)) menuClosedBy = rowMenu.back;
    closeRowMenu({ refocus: false });
  },
  true,
);
addEventListener("scroll", (e) => rowMenu && !rowMenu.el.contains(e.target) && closeRowMenu({ refocus: false }), true);
addEventListener("resize", () => closeRowMenu({ refocus: false }));
addEventListener("blur", () => closeRowMenu({ refocus: false }));

// The dialog. Cancel is where the focus starts; the destructive button is red and needs a real click or key (the
// desktop app does nothing for script alone).
let deleting = null; // { el, id, busy, choice: "keep" | "files", said }

function closeDeleteDialog() {
  if (!deleting || deleting.busy) return;
  const { el, id } = deleting;
  deleting = null;
  el.remove();
  document.body.classList.remove("deleting");
  [...appsList.querySelectorAll("li.app")].find((li) => li.dataset.id === id)?.querySelector(".row-more")?.focus({ preventScroll: true });
}

function openDeleteDialog(id) {
  const row = rows().find((one) => one.id === id);
  if (!row || !inShell()) return;
  const project = row.project && row.project.exists !== false ? row.project : null;
  const scrim = make("div", "delete-scrim");
  const box = make("div", "delete-dialog");
  box.setAttribute("role", "alertdialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-labelledby", "delete-title");
  box.setAttribute("aria-describedby", "delete-about");
  scrim.append(box);
  deleting = { el: scrim, id, busy: false, choice: "keep", said: null };

  const title = make("h2", "", `Delete ${row.name}?`);
  title.id = "delete-title";
  const running = row.id === runningId;
  const first = running ? "It is running now and stops first. " : "";
  const about = make("p", "delete-about", project ? `${first}Choose what goes.` : row.project ? `${first}It is taken off the emulated BUSY Bar and the emulator forgets its project. The project folder's disk is not there, so the folder is not touched.` : `${first}It is taken off the emulated BUSY Bar. It was installed from a package, so there is no project folder to delete.`);
  about.id = "delete-about";
  const parts = [title, about];

  let action;
  if (project) {
    const choices = make("div", "delete-choices");
    choices.setAttribute("role", "radiogroup");
    choices.ariaLabel = "What goes";
    const choice = (value, head, text) => {
      const el = make("label", "choice");
      const input = make("input");
      input.type = "radio";
      input.name = "delete-choice";
      input.value = value;
      input.checked = deleting.choice === value;
      input.addEventListener("change", () => {
        deleting.choice = value;
        for (const one of choices.querySelectorAll(".choice")) one.classList.toggle("on", one.querySelector("input").checked);
        action.querySelector("span").textContent = value === "files" ? `Move to ${TRASH}` : "Remove";
      });
      const words = make("span", "words");
      words.append(make("b", "", head), make("span", "", text));
      el.append(input, words);
      el.classList.toggle("on", input.checked);
      return el;
    };
    choices.append(
      choice("keep", "Remove from the emulator", "The app is stopped and taken off the emulated BUSY Bar, and the emulator forgets its project. The folder stays where it is."),
      choice("files", "Remove and delete its files", `The same, and the project folder goes to the ${TRASH}. You can put it back from there.`),
    );
    const where = make("div", "folder");
    const mark = make("span");
    mark.innerHTML = icon("folder");
    where.append(mark, pathLine(project.folder));
    parts.push(choices, where);
  }
  const said = make("p", "delete-said");
  said.setAttribute("role", "alert");
  parts.push(said);

  const cancel = button("btn", "Cancel", null, closeDeleteDialog);
  action = button("btn danger", project ? "Remove" : "Remove from the emulator", null, () => runDelete(row, said, [cancel, action]), "", "trash");
  const foot = make("div", "delete-foot");
  foot.append(cancel, action);
  box.append(...parts, foot);

  box.addEventListener("keydown", (e) => {
    e.stopPropagation(); // nothing typed here goes to the bar
    if (e.key === "Escape") {
      e.preventDefault();
      closeDeleteDialog();
    } else if (e.key === "Tab") {
      // The focus stays in the dialog.
      const all = [...box.querySelectorAll("button, input:checked")].filter((one) => one.ariaDisabled !== "true");
      const at = all.indexOf(document.activeElement);
      e.preventDefault();
      all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
    }
  });
  scrim.addEventListener("pointerdown", (e) => e.target === scrim && closeDeleteDialog());
  document.body.append(scrim);
  document.body.classList.add("deleting");
  cancel.focus({ preventScroll: true });
}

async function runDelete(row, said, buttons) {
  if (!deleting || deleting.busy) return;
  const withFiles = deleting.choice === "files";
  deleting.busy = true;
  for (const one of buttons) aria(one, "disabled", "true");
  buttons[1].classList.add("working");
  said.className = "delete-said working";
  said.textContent = withFiles ? `Removing, then moving the folder to the ${TRASH}` : "Removing";
  let answer;
  try {
    answer = await actions().apps.delete({ id: row.id, withFiles });
  } catch (e) {
    answer = e?.code === NO_GESTURE ? { ok: false, message: "Click again" } : { ok: false, message: String(e?.message ?? e), hint: e?.hint ?? null };
  }
  deleting.busy = false;
  if (answer?.ok === false) {
    for (const one of buttons) aria(one, "disabled", "false");
    buttons[1].classList.remove("working");
    said.className = "delete-said failed";
    said.textContent = [answer.message, windowHint(answer.hint)].filter(Boolean).join(" ");
    // What did happen (the app is off the bar, the folder not moved) shows in the list behind.
    if (answer.code === "trash_failed") await loadApps();
    return;
  }
  closeDeleteDialog();
  if (chosenId === row.id) chosenId = null;
  await loadApps();
  say(answer?.message ?? `Removed ${row.name}`);
}


// ---- a new app: Create app opens its pop-up (create-app.js), over the whole window

let creating = false; // an app is being created: it takes a while
// The examples a new app may start from, read once when the page loads (reading them needs no click), so that the
// pop-up shows them at once.
let examples = null;

async function loadExamples() {
  if (examples !== null || !inShell()) return examples;
  try {
    examples = (await actions().projects.examples?.()) ?? [];
  } catch {
    // No list: the pop-up offers the official template and the empty app.
    examples = [];
  }
  return examples;
}

/** The ids the emulator's projects and the bar's apps have: a new app's id is another. */
function takenIds() {
  return [...new Set([...projects.map((p) => p.id), ...(installed ?? []).map((app) => app.id)].filter((id) => typeof id === "string" && id))];
}

/** Opens Create app's pop-up; what it creates is listed and chosen here. */
async function createApp() {
  if (!inShell() || creating) return;
  const popUp = globalThis.emulatorCreateApp;
  if (typeof popUp?.open !== "function") return say("Create app is not available in this window");
  popUp.open({ examples: examples ?? (await loadExamples()) ?? [], taken: takenIds(), existing: existingApps(), openExisting: (id) => openApp(id), create: createWith, importProject: importWith });
}

/** The person's projects by name and folder: the pop-up says so when a new app would have the name of one. */
function existingApps() {
  return projects.filter((p) => p.exists !== false && p.id).map((p) => ({ id: p.id, name: p.name ?? p.id, folder: p.folder, shown: p.shownFolder ?? p.folder }));
}

/** The pop-up's Create: the desktop app's create, the list read again and the new app chosen. Throws what it refused. */
async function createWith(request) {
  creating = true;
  renderApps();
  let made = null;
  try {
    made = await actions().projects.create(request);
  } finally {
    creating = false;
    renderApps();
  }
  if (!made) return null;
  globalThis.emulatorWelcome?.created?.(made); // the first run's three steps, when the person chose to write the code
  await listAndChoose(made);
  if (Array.isArray(made.unfinished) && made.unfinished.length) say(made.unfinished.join(" "));
  else if (made.dependencies?.state === "failed") say(`Created without its dependencies: ${made.dependencies.reason}. Retry when the network is back.`);
  return made;
}

/** The new or opened project listed and chosen; the Refresh that ended the pop-up's work said in its section. */
async function listAndChoose(made) {
  await loadApps();
  if (made.id) openApp(made.id);
  // The Refresh that ends Create app: its outcome in the app's section, as the Refresh button's would be.
  if (made.refreshed && made.folder) setJob(made.folder, { kind: "refresh", state: made.refreshed.ok ? "done" : "failed", quiet: false, message: made.refreshed.message ?? null, hint: made.refreshed.ok ? null : windowHint(made.refreshed.hint, made.refreshed.code === "tool_failed" ? NEXT.refresh : null) });
}

/** The pop-up's Open existing: the project it found, opened (trust asked), listed, chosen and started. Throws what it refused. */
async function importWith(folder) {
  creating = true;
  renderApps();
  let opened = null;
  try {
    opened = await actions().projects.import(folder);
  } finally {
    creating = false;
    renderApps();
  }
  if (!opened) return null;
  await listAndChoose(opened);
  return opened;
}

$("#create-app").addEventListener("click", () => createApp());
// The app menu's New App… opens the same pop-up.
if (inShell()) actions().on?.("menu", (item) => item === "create" && createApp());
// The first run's greeting (welcome.js) starts the same Create app.
globalThis.emulatorWindow = Object.freeze({ createApp });

async function openProject() {
  try {
    const opened = await actions().projects.open();
    await loadApps();
    if (opened?.id) openApp(opened.id);
  } catch (e) {
    say(e?.code === NO_GESTURE ? "Click again" : [`The folder was not opened: ${e?.message ?? e}`, e?.hint].filter(Boolean).join(" "));
  }
}

// ---- a project's jobs

// What a job is called while it runs, and when it has ended well.
const WORKING = { create: "Creating", open: "Opening", dependencies: "Installing dependencies", build: "Building", run: "Starting", refresh: "Refreshing", dev: "Watching the folder", check: "Checking", submit: "Preparing the submission", publish: "Preparing to publish", stop: "Stopping" };
const FAILED = { create: "Not created", open: "Not opened", dependencies: "Dependencies not installed", build: "Build failed", run: "Run failed", refresh: "Build failed", dev: "Dev stopped", check: "The checks did not run", submit: "Not prepared", publish: "Not prepared", stop: "Not stopped" };
const DONE = { create: "Created", open: "Opened", dependencies: "Dependencies installed", build: "Built", run: "Started", refresh: "Refreshed", dev: "Stopped watching", check: "Checked", submit: "Ready to submit", publish: "Prepared", stop: "Stopped" };
// folder → { kind, state: "running" | "done" | "failed", lines: the last lines it printed, message, hint, checks, folder }
const jobs = new Map();
const KEPT_LINES = 8;

function setJob(folder, change) {
  const job = { lines: [], ...(jobs.get(folder) ?? {}), ...change };
  jobs.set(folder, job);
  renderApps();
  renderApp();
  return job;
}

/** What the desktop app says of a job as it goes: its state, and each line the tool prints. */
function onJob(event) {
  // The list changed by itself: a project's folder was deleted, or its disk went or came back.
  if (event?.kind === "removed" || event?.kind === "changed") return void loadApps();
  if (!event?.folder) return;
  // The publishing flow's own work is shown in its dialog; its lines still go to the console.
  if (event.kind === "publish") {
    if (typeof event.line === "string") addLine({ kind: "build", text: event.line, time: Date.now() });
    return;
  }
  const before = jobs.get(event.folder);
  const fresh = !before || before.id !== event.id;
  const lines = fresh ? [] : before.lines;
  if (typeof event.line === "string") {
    addLine({ kind: "build", text: event.line, time: Date.now() });
    lines.push(event.line);
    if (lines.length > KEPT_LINES) lines.shift();
  }
  const changed = fresh || before.state !== event.state;
  jobs.set(event.folder, { ...(fresh ? {} : before), id: event.id, kind: event.kind, state: event.state, lines });
  if (!changed) return renderJob();
  renderApps();
  renderApp();
  if (event.state !== "running") {
    // What the job wrote shows when the pages are next drawn.
    overview.forget();
    files.forget();
    loadApps();
  }
}

// The desktop app does an action only just after a click or a key in the window (or as a short chain after one).
// Refused for want of one, which a person's click never is but a held-up page may be, the window says so quietly.
const NO_GESTURE = "no_gesture";
const again = (folder, kind) => setJob(folder, { kind, state: "done", quiet: true, message: "Click again", hint: null, lines: [] });

// What to do next, in the window's words. The desktop app's hints are the command line's, and one that names a
// command to type ("then run …/busy-emulator.mjs dev … --once again") is not for a window with buttons.
const NEXT = { refresh: "Fix the error, then press Refresh.", build: "Fix the error, then choose Build again.", run: "Fix the error, then press Run.", dev: "Fix the error and save: it builds again.", check: "Fix these, then press Publish again.", submit: "Fix these, then press Publish again." };
const COMMAND = /busy-emulator|\.m?js\b|\bnpx?\b|\bnode\b/;
function windowHint(hint, fallback = null) {
  return typeof hint === "string" && hint && !COMMAND.test(hint) ? hint : fallback;
}

/** Runs an action of a project and keeps what it answers: { ok, code?, message?, hint? }. */
async function act(row, kind, call) {
  const folder = row.project.folder;
  setJob(folder, { kind, state: "running", quiet: false, message: null, hint: null, checks: null, submission: null, lines: [] });
  let answer;
  try {
    answer = (await call(folder)) ?? { ok: true };
  } catch (e) {
    if (e?.code === NO_GESTURE) return again(folder, kind);
    answer = { ok: false, message: String(e?.message ?? e), hint: e?.hint ?? null };
  }
  setJob(folder, { kind, state: answer.ok ? "done" : "failed", ended: Date.now(), message: answer.message ?? null, hint: answer.ok ? null : windowHint(answer.hint, answer.code === "tool_failed" ? (NEXT[kind] ?? null) : null) });
  await loadApps();
  return answer;
}

const refreshProject = (row) => act(row, "refresh", (folder) => actions().projects.refresh(folder));

// ---- dependencies that did not come (create-offline)
//
// A project created without the network has no dependencies: its row says why ("Dependencies not installed: no
// network") and has Retry, which installs them and nothing else. The desktop app also tries again by itself when the
// network may be back: the system says it came online, the window gets the focus, the Apps' Refresh is pressed, and
// every 30 s while such a row is there (projects.retryDependencies: each project no more often than every 20 s).

/** The dependencies of the row's project when they did not come: { reason, message, retry }; null otherwise. */
function depsTrouble(row) {
  const deps = row?.project?.dependencies;
  return deps && (deps.state === "failed" || deps.state === "interrupted") ? deps : null;
}

async function retryDependencies(row) {
  const answer = await act(row, "dependencies", (folder) => actions().projects.dependencies(folder));
  // The Refresh that had stopped at the dependencies went on after them: its outcome is a Refresh's.
  if (answer?.followed === "refresh") setJob(row.project.folder, { kind: "refresh" });
  return answer;
}

/** The desktop app's own Retry, when a project waits for the network. */
function retryDependenciesNow() {
  if (!inShell() || !projects.some((p) => p.dependencies?.retry && !p.job) || typeof actions().projects.retryDependencies !== "function") return;
  actions()
    .projects.retryDependencies()
    .catch(() => {
      // Not now: the next look tries again.
    });
}
addEventListener("online", retryDependenciesNow);
addEventListener("focus", retryDependenciesNow);
globalThis.setInterval?.(retryDependenciesNow, 30_000);

/** Two rows of the same name: each project's row says its folder too ("focus-timer-2, Not on the bar yet"). */
function twinFolder(row, note) {
  if (!row.project || !rows().some((other) => other.id !== row.id && other.name === row.name)) return note;
  const folder = String(row.project.folder).split(/[\\/]/).filter(Boolean).pop() ?? "";
  return [folder, note].filter(Boolean).join(", ");
}

/** The section's line about dependencies that did not come, with Retry. */
const depsBox = make("div", "job deps");
function renderDeps(row) {
  const deps = depsTrouble(row);
  if (!deps || working(row)) return null;
  const retry = button("btn small", "Retry", row.project.unavailable ? AWAY : null, () => retryDependencies(row), "Install its dependencies again");
  const line = make("div", "job-line failed", `Dependencies not installed: ${deps.reason}`);
  // Retry first: the section scrolls, and npm's words can be long.
  const parts = [line, retry];
  parts.push(make("div", "hint", deps.retry ? "Check the connection and press Retry. The emulator also tries again by itself when the network is back." : "Press Retry to install them again."));
  if (deps.message) parts.push(make("pre", "", deps.message));
  retry.classList.add("deps-retry");
  depsBox.replaceChildren(...parts);
  return depsBox;
}

/** Starts or stops watching the project's folder. How the watching goes is said by the job's events. */
async function dev(row, what) {
  const folder = row.project.folder;
  let answer;
  try {
    answer = await actions().projects.dev[what](folder);
  } catch (e) {
    if (e?.code === NO_GESTURE) return again(folder, "dev");
    answer = { ok: false, message: String(e?.message ?? e), hint: e?.hint ?? null };
  }
  if (answer?.ok === false) setJob(folder, { kind: "dev", state: "failed", message: answer.message ?? null, hint: windowHint(answer.hint, answer.code === "tool_failed" ? NEXT.dev : null) });
}

// ---- publishing

// "Publish" at the top and Publish… in the opened app's More open the same flow (publish.js): a dialog of steps
// from the catalog's checks to a project ready for its public repository and the catalog's pull request. It is for
// the chosen app's project; an app without one has nothing to publish from here.
const publishEntry = $("#publish");

function publishable(row = chosen()) {
  if (!inShell()) return NEEDS_APP;
  if (!globalThis.emulatorPublish) return "Publishing is not in this copy of the window";
  if (!row?.project) return row ? "This app has no project folder to publish from" : "Choose an app with a project folder";
  if (row.project.unavailable) return AWAY;
  return null;
}

function openPublish(row = chosen()) {
  if (publishable(row)) return;
  globalThis.emulatorPublish.open({ folder: row.project.folder, name: row.name });
}

function renderPublishEntry() {
  const why = publishable();
  aria(publishEntry, "disabled", why ? "true" : "false");
  publishEntry.title = why ?? "Get the app ready for its public repository and the catalog. Nothing is sent.";
}

publishEntry.addEventListener("click", () => openPublish());
// The flow changed the project's files: the list and the section read them again.
addEventListener("publish-closed", () => {
  overview.forget();
  files.forget();
  loadApps();
});

// ---- the chosen app (layout-v2: the opened app, in the side column)

// The side column shows the list of apps or the opened app (index.html, #side's data-mode). A row's click opens its app;
// "All apps" goes back. The app the window is about (chosenId) is kept either way: the list marks it, Publish and the
// tools name it.
const side = $("#side");
const appsPane = $("#apps-pane");
const appPane = $("#app-pane");
let sideMode = "all";

function showSide(mode) {
  sideMode = mode === "app" && chosen() ? "app" : "all";
  side.dataset.mode = sideMode;
  appsPane.hidden = sideMode !== "all";
  appPane.hidden = sideMode !== "app";
  if (sideMode === "app") renderApp();
  else renderApps();
}

/** Opens an app in the side column. */
function openApp(id) {
  choose(id);
  showSide("app");
}

$("#all-apps").addEventListener("click", () => showSide("all"));

// The opened app's More: the row's menu with what the page has no button for (openRowMenu, full).
const appMore = $("#app-more");
appMore.addEventListener("click", (e) => {
  // A second click on the button of an open menu closes it (the press outside the menu has done that).
  if (menuClosedBy === appMore) return void (menuClosedBy = null);
  const row = chosen();
  if (!row) return;
  const box = appMore.getBoundingClientRect();
  openRowMenu(row.id, { x: box.right, y: box.bottom + 4, alignRight: true, byKey: e.detail === 0, back: appMore, full: true });
});

// The parts of the opened app. They are made once and filled as things change; the settings form is redrawn only when
// the app's settings are read again, so that what is being typed stays.
const appIcon = $("#app-icon");
const appFacts = $("#app-facts");
const appStatus = $("#app-status");
const appFolder = $("#app-folder");
// app-column: what the folder section was made for, so that it is not made again (a "Copied" stays); the system and
// the command line's path for Copy prompt for AI, once read; the files-changed notice.
let folderShown = null;
let promptFacts = null;
const changedBox = make("div", "files-changed");
const facts = appFacts;
const folderBox = make("div", "folder");
const jobBox = make("div", "job");
const runningBox = make("div", "running");
const settingsBox = make("div", "settings");
const appSettingsLink = $("#app-settings");

/** A folder's path in one line, cut in the middle: its start gives way, the folder's own name stays. */
function pathLine(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  const line = make("span", "path");
  line.title = path;
  line.append(make("span", "head", path.slice(0, cut)), make("span", "tail", path.slice(cut)));
  return line;
}

/** Puts a text on the clipboard: true, false, or "again" when the desktop app wants a fresh click. */
async function copyText(text) {
  try {
    // In the desktop app through its clipboard; in a browser, the browser's.
    if (inShell()) return (await actions().copy(text)) !== false;
    await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    return e?.code === NO_GESTURE ? "again" : false;
  }
}

/** The line of a folder: its path, Copy, and Show in Finder (Explorer on Windows). */
function folderLine(box, path) {
  box.className = "folder";
  const copied = async () => {
    const done = await copyText(path);
    copy.title = done === "again" ? "Click again" : done ? "Copied" : "Not copied";
  };
  const copy = button("icon-btn small", "", null, copied, "Copy the path", "copy");
  copy.ariaLabel = "Copy the path";
  const show = button("btn", "", inShell() ? null : NEEDS_APP, () => actions().reveal(path), `Show in ${FILE_MANAGER}`);
  // The button says "Show"; its tooltip and its name say the rest.
  show.append(make("span", "wide", `Show in ${FILE_MANAGER}`), make("span", "narrow", "Show"));
  show.ariaLabel = `Show in ${FILE_MANAGER}`;
  const mark = make("span");
  mark.innerHTML = icon("folder");
  box.replaceChildren(mark, pathLine(path), copy, show);
}

/** Why the project's actions cannot be pressed now, or null. */
function projectWhy(row) {
  const project = row.project;
  return !inShell() ? NEEDS_APP : !project ? "This app has no project folder" : project.unavailable ? AWAY : working(row) !== null ? "Wait for the work under way" : null;
}

function renderApp() {
  renderPublishEntry();
  const row = chosen();
  appTitle.textContent = row ? row.name : "App";
  appTitle.title = row ? row.name : "";
  if (!row) {
    if (sideMode === "app") showSide("all");
    appActions.replaceChildren();
    appFolder.replaceChildren();
    folderShown = null;
    appStatus.replaceChildren();
    appFacts.replaceChildren();
    appBody.replaceChildren(make("p", "app-empty", powered ? "No app chosen" : "The BUSY Bar is off"));
    return;
  }
  const on = row.id === runningId;
  const project = row.project;
  const shell = inShell();

  // Its icon, as the list shows it, larger.
  appIcon.className = icons.get(row.id) ? "app-head-icon" : "app-head-icon none";
  if (icons.get(row.id)) {
    const picture = make("img");
    picture.alt = "";
    picture.src = icons.get(row.id);
    appIcon.replaceChildren(picture);
  } else appIcon.replaceChildren();

  // What it is: its state, its version, its id.
  const state = make("span", on ? "live" : "state", on ? "Running" : row.onBar ? "Stopped" : "Not on the BUSY Bar");
  const id = make("code", "", row.id);
  id.title = "The app's id";
  facts.replaceChildren(state, ...(row.version ? [make("span", "", row.version)] : []), id);

  // Run, Stop, Refresh. A project's app runs from its folder (build, install, start) and is stopped as its project
  // is, by the desktop app; an app from a package starts and stops on the bar.
  const why = projectWhy(row);
  const run = project
    ? button(on ? "btn" : "btn solid", "Run", why, () => act(row, "run", (folder) => actions().projects.run(folder)), "Build, install and start", "control-play")
    : button(on ? "btn" : "btn solid", "Run", row.onBar ? null : "Not on the BUSY Bar", () => post(`/api/apps/launch?app_id=${encodeURIComponent(row.id)}`), "Start it on the BUSY Bar", "control-play");
  const stop = project && shell
    ? button("btn", "Stop", on ? null : "Not running", () => act(row, "stop", (folder) => actions().projects.stop(folder)), "Stop the app", "control-stop")
    : button("btn", "Stop", on ? null : "Not running", () => post("/api/apps/quit"), "Stop the app", "control-stop");
  const refresh = button("btn", "Refresh", why, () => refreshProject(row), "Build, install and start it again, after you changed its files", "refresh");
  appActions.replaceChildren(run, stop, refresh);
  renderFolder(row);

  // What its work said, its first steps when it is new, its numbers while it runs.
  renderJob();
  const steps = globalThis.emulatorWelcome?.hintFor?.(project) ?? null;
  const status = steps ? [steps] : [];
  const changedNote = filesChanged(row);
  if (changedNote) status.push(changedNote);
  const deps = project ? renderDeps(row) : null;
  if (deps) status.push(deps);
  // The deps box says the failure of a Retry: the job's own box would say it twice.
  else if (project && (jobs.has(project.folder) || working(row) !== null)) status.push(jobBox);
  if (on) status.push(runningBox);
  appStatus.replaceChildren(...status);

  // The page of the tab is made while the opened app is shown, and made again when it is shown next.
  if (sideMode !== "app") return void (tabShown = null);
  renderTab(row);
}

/** How the project's last job stands: a line, the first lines of an error, the checks that fail, the submission. */
function renderJob() {
  const row = chosen();
  let job = row?.project ? jobs.get(row.project.folder) : null;
  // A job this page did not start (the command line's, another window's): the list names its kind.
  if (!job && working(row)) job = { kind: working(row), state: "running", lines: [] };
  if (!job) return jobBox.replaceChildren();
  // A long answer (a build's error, with its code frame) is the job's output, under a short line of its own.
  const long = typeof job.message === "string" && (job.message.includes("\n") || job.message.length > 120);
  const said = job.state === "running" ? (WORKING[job.kind] ?? "Working") : job.state === "done" ? (job.message ?? DONE[job.kind] ?? "Done") : long ? (FAILED[job.kind] ?? "Failed") : (job.message ?? "Failed");
  const parts = [make("div", `job-line ${job.state === "running" ? "working" : job.quiet ? "quiet" : job.state}`, said)];
  if (job.state === "failed") {
    const output = long ? job.message.trim() : job.lines.join("\n");
    if (output && !job.checks) parts.push(make("pre", "", output));
    if (job.hint) parts.push(make("div", "hint", job.hint));
    // A build that failed changed nothing on the bar.
    if (["refresh", "run", "build"].includes(job.kind) && row.onBar) parts.push(make("div", "hint", row.id === runningId ? "The previous version is still running." : "The previous version is still on the BUSY Bar."));
    // The checks that stop the submission first, then those the catalog only warns of.
    const fails = (job.checks ?? []).filter((check) => check.answer === "fails").sort((a, b) => (a.blocking === false) - (b.blocking === false));
    if (fails.length) {
      const list = make("ul", "checks");
      list.append(
        ...fails.map((check) => {
          const item = make("li", check.blocking === false ? "warns" : "fails");
          item.append(make("b", "", check.title ?? check.id), make("span", "", check.message ?? ""));
          return item;
        }),
      );
      parts.push(list);
    }
  }
  if (job.state === "done" && job.submission) {
    const line = make("div");
    folderLine(line, job.submission);
    parts.push(line);
    if (job.steps) parts.push(make("div", "hint", job.steps));
  }
  const unchecked = (job.checks ?? []).filter((check) => check.answer === "unchecked").length;
  if (unchecked && job.state !== "running") parts.push(make("div", "hint", unchecked === 1 ? "1 check could not be made here." : `${unchecked} checks could not be made here.`));
  jobBox.replaceChildren(...parts);
}

// ---- app-column: the opened app's folder, Copy prompt for AI, and the files-changed notice
//
// Under the app's id: its project's folder (from ~ on macOS), Copy the path and Open in Finder (Show in Explorer on
// Windows); under them Copy prompt for AI, the text to go on with this app in an AI agent that runs commands, made at
// the click with the real values (emulatorWelcome.appPrompt: the app's name and id, its folder, the command line's
// path as the desktop app names it, in the platform's form). An app from a package says so and offers Open project.
// In a browser there is no project and no section.
//
// The files-changed notice: the project's files changed after it last put its app on the bar (the command line's
// `projects` says so: stale), so the bar runs an older version. It says so with Refresh, and is not there while the
// folder is watched (dev builds by itself) or any work runs on the project. The list is read again when the window
// gets the focus and every few seconds while an app with a project is open, so that an agent's edits show up.


async function loadPromptFacts() {
  if (promptFacts || !inShell()) return;
  const guess = /win/i.test(globalThis.navigator?.platform ?? "") ? "win32" : "darwin";
  try {
    const answer = await actions().welcome.get();
    promptFacts = { platform: typeof answer?.platform === "string" ? answer.platform : guess, cli: typeof answer?.cli === "string" ? answer.cli : null };
  } catch {
    promptFacts = { platform: guess, cli: null };
  }
}

/** The text of Copy prompt for AI for the row's project, now. */
function promptFor(row) {
  const made = globalThis.emulatorWelcome?.appPrompt;
  if (!made || !row?.project) return null;
  const facts = promptFacts ?? { platform: /win/i.test(globalThis.navigator?.platform ?? "") ? "win32" : "darwin", cli: null };
  return made({ ...facts, name: row.name, id: row.id, folder: row.project.folder });
}

/** Copies a text with the publishing flow's feedback on the button (a tick and Copied), else with its tooltip. */
async function copyWithFeedback(el, text) {
  const copied = globalThis.emulatorPublish?.copied;
  if (copied) return copied(el, text);
  const done = await copyText(text);
  el.title = done === "again" ? "Click again" : done ? "Copied" : "Not copied";
  return done === true;
}

function renderFolder(row) {
  const shell = inShell();
  const project = row.project;
  const key = [row.id, row.name, project?.folder ?? "", project?.shownFolder ?? "", Boolean(project?.unavailable), projectsKnown, shell].join("\n");
  if (folderShown === key) return;
  folderShown = key;
  appFolder.hidden = !shell;
  if (!shell) return appFolder.replaceChildren();
  if (!project) {
    const line = make("div", "folder-line none");
    line.append(make("span", "", projectsKnown ? "Installed from a package" : "Looking for its project"));
    if (projectsKnown) line.append(button("btn small", "Open project", null, openProject, "Choose the folder of this app's project"));
    return appFolder.replaceChildren(line);
  }
  loadPromptFacts();
  const line = make("div", "folder-line");
  const mark = make("span", "folder-mark");
  mark.innerHTML = icon("folder");
  const shown = pathLine(project.shownFolder ?? project.folder);
  shown.title = project.folder;
  const copy = button("icon-btn small", "", null, () => copyWithFeedback(copy, project.folder), "Copy the path", "copy");
  copy.ariaLabel = "Copy the path";
  const label = FILE_MANAGER === "Explorer" ? "Show in Explorer" : "Open in Finder";
  const show = button("btn small folder-open", "", project.unavailable ? AWAY : null, () => actions().reveal(project.folder), label);
  show.append(make("span", "wide", label), make("span", "narrow", FILE_MANAGER === "Explorer" ? "Show" : "Open"));
  show.ariaLabel = label;
  line.append(mark, shown, copy, show);
  const prompt = button("btn solid prompt-ai", "Copy prompt for AI", null, () => {
    const text = promptFor(chosen());
    if (text) copyWithFeedback(prompt, text);
  }, "Copy a prompt to go on with this app in your AI agent: its folder and the emulator's commands", "sparkles");
  prompt.id = "copy-prompt";
  appFolder.replaceChildren(line, prompt);
}

/** The files-changed notice, when it is to be shown for the row; null otherwise. */
function filesChanged(row) {
  const project = row?.project;
  if (!project?.stale || !row.onBar || !inShell() || project.unavailable || working(row) !== null) return null;
  // A Refresh or a Run that ended after the list was read: the list read after it says how things stand.
  const job = jobs.get(project.folder);
  if (job?.state === "done" && ["refresh", "run", "build"].includes(job.kind) && (job.ended ?? 0) >= projectsReadAt) return null;
  const words = make("span", "said", "Files changed. Refresh to run the new version");
  const mark = make("span", "files-changed-mark");
  mark.innerHTML = icon("info");
  const refresh = button("btn small", "Refresh", projectWhy(row), () => refreshProject(row), "Build, install and start it again", "refresh");
  refresh.id = "files-changed-refresh";
  changedBox.replaceChildren(mark, words, refresh);
  return changedBox;
}

// The list is read again for the open app: when the window comes back, and now and then while it is shown.
let lastLook = 0;
function lookAgain() {
  if (!inShell() || sideMode !== "app" || !chosen()?.project || globalThis.document?.visibilityState === "hidden") return;
  if (Date.now() - lastLook < 2000) return;
  lastLook = Date.now();
  loadApps();
}
addEventListener("focus", lookAgain);
globalThis.document?.addEventListener?.("visibilitychange", lookAgain);
globalThis.setInterval?.(() => {
  if (working(chosen() ?? {}) === null) lookAgain();
}, 10_000);

// ---- layout-v2: the opened app's tabs: Overview, Settings, Files

const TABS = ["overview", "settings", "files"];
let appTab = "overview";
const tabButtons = [...document.querySelectorAll("#app-tabs [data-tab]")];

function pickTab(tab) {
  if (!TABS.includes(tab)) return;
  appTab = tab;
  renderApp();
}
for (const tab of tabButtons) tab.addEventListener("click", () => pickTab(tab.dataset.tab));
// The arrows go along the tabs, as in a tab list.
$("#app-tabs").addEventListener("keydown", (e) => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  const next = TABS[(TABS.indexOf(appTab) + step + TABS.length) % TABS.length];
  pickTab(next);
  tabButtons.find((tab) => tab.dataset.tab === next)?.focus();
});

let tabShown = null; // what the page in the body was made for, so that it is not made again while it is up

function renderTab(row) {
  for (const tab of tabButtons) {
    const on = tab.dataset.tab === appTab;
    aria(tab, "selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  appBody.setAttribute?.("aria-labelledby", `tab-${appTab}`);
  // The page is made again only when what it shows of the row changed: what is being typed in it stays.
  const key = [appTab, row.id, row.name, row.project?.folder ?? "", row.onBar, icons.get(row.id) ? "icon" : ""].join("\n");
  if (appTab === "settings") return renderSettingsPage();
  if (tabShown === key && appBody.childElementCount) return;
  tabShown = key;
  if (appTab === "overview") return overview.render(row);
  return files.render(row);
}

/** The Settings tab: the app's settings form, as the bar's local web has it, and the way to the local web. */
function renderSettingsPage() {
  const row = chosen();
  const what = !row?.onBar ? "away" : !powered ? "off" : !settings || settings.id !== row.id ? "reading" : settings.none ? "none" : "form";
  // The form is put in once: drawn again it would lose the field being typed in.
  const key = `settings:${row?.id}:${what}`;
  if (tabShown === key && appBody.childElementCount) return;
  tabShown = key;
  const note = make("p", "page-note");
  note.append("The app reads its settings when it starts. ", appSettingsLink);
  const parts = [];
  if (what === "away") parts.push(make("p", "app-empty", "Not on the BUSY Bar yet: run it first."));
  else if (what === "off") parts.push(make("p", "app-empty", "The BUSY Bar is off"));
  else if (what === "reading") parts.push(make("p", "page-note", "Reading the settings"));
  else if (what === "none") parts.push(make("p", "app-empty", "This app has no settings."));
  else parts.push(settingsBox);
  parts.push(note);
  appBody.replaceChildren(...parts);
}

/** A labelled field of a page: { row, input, hint }. */
function pageField(label, input, hintText = "") {
  const row = make("div", "ov-field");
  const name = make("label", "", label);
  const id = `ov-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  input.id = id;
  name.htmlFor = id;
  const hint = make("span", "hint", hintText);
  hint.hidden = !hintText;
  row.append(name, input, hint);
  return { row, input, hint };
}

// ---- layout-v2: Overview. The app's name, its catalog texts (short description, description, category), its two
// icons and what its controls do (its folder is at the top of the opened app: app-column). The texts are the project's catalog.json and manifest (publish.status
// reads them, publish.texts writes them, as the publishing flow's first step does); what the controls do is the
// "## How to use" section of its README.md, read and written by the publishing flow's module (publish/how-to-use.mjs)
// and written by publish.readme. Save writes what changed. The icons are the project's (publish.status); Upload takes a
// PNG with Create app's checks (emulatorCreateApp.pickIcon) and Use this icon writes it (publish.icon), as the
// publishing flow's Application Info does.

const overview = (() => {
  let page = null; // { folder, status, failed, drafts, dirty: Set, said, saving }
  let howTo = null; // how-to-use.mjs, once loaded
  let asked = 0;

  async function loadHowTo() {
    if (howTo) return howTo;
    try {
      howTo = await import("/emulator/publish/how-to-use.mjs");
    } catch {
      howTo = null;
    }
    return howTo;
  }

  /** The README's How to use as the flow's status has it: in "fields" mode its usage, in "markdown" mode its text. */
  function rowsOfReadme(readme) {
    const config = readme?.config ?? {};
    return config.mode === "markdown" ? howTo.read(config.markdown ?? "") : howTo.rowsOf(config.usage ?? "");
  }

  /** The README configuration with the rows written: one row a control that says something, the others kept. */
  function readmeWith(readme, usage) {
    const config = { mode: "fields", title: "", intro: "", usage: "", markdown: "", ...(readme?.config ?? {}) };
    const rows = [...howTo.CONTROLS.filter((control) => usage.rows[control]?.trim()).map((control) => ({ control, text: usage.rows[control].trim() })), ...usage.others];
    return config.mode === "markdown" ? { ...config, markdown: howTo.write(config.markdown, rows) } : { ...config, usage: howTo.listOf(rows) };
  }

  async function load(row) {
    const folder = row.project.folder;
    const mine = ++asked;
    page = { folder, status: null, failed: null, drafts: null, dirty: new Set(), said: null, saving: false, iconDraft: null };
    let answer;
    try {
      [answer] = await Promise.all([actions().publish.status(folder), loadHowTo()]);
    } catch (e) {
      answer = { ok: false, message: String(e?.message ?? e) };
    }
    if (mine !== asked || page?.folder !== folder) return;
    if (answer?.ok === false || !answer?.texts) page.failed = answer?.message ?? "The project could not be read.";
    else {
      page.status = answer;
      const read = howTo ? rowsOfReadme(answer.readme) : null;
      const usage = read ? { rows: Object.fromEntries(howTo.CONTROLS.map((control) => [control, read.find((row) => row.control === control)?.text ?? ""])), others: read.filter((row) => !howTo.CONTROLS.includes(row.control)) } : null;
      page.drafts = { name: answer.texts.name ?? row.name, texts: { category: "", short_description: "", description: "", changelog: "", ...(answer.texts.texts ?? {}) }, usage };
    }
    if (chosen()?.project?.folder === folder && appTab === "overview" && sideMode === "app") {
      tabShown = null;
      renderApp();
    }
  }

  /** An icon tile: the picture (or the hatch of none), its side and its size. */
  function iconTile(address, side, size) {
    const tile = make("div", "icon-tile");
    const pic = make("span", `pic icon-${side.toLowerCase()}${address ? "" : " none"}`);
    if (address) {
      const img = make("img");
      img.alt = "";
      img.src = address;
      img.addEventListener("error", () => pic.replaceChildren(), { once: true });
      pic.append(img);
    }
    const words = make("span", "words");
    words.append(make("b", "", side), make("span", "", address ? size : `${size}, none yet`));
    tile.append(pic, words);
    return tile;
  }

  function iconsGroup(row) {
    const box = make("div");
    box.append(make("p", "group-label", "Icon"));
    const pair = make("div", "icon-pair");
    // The project's icons when its status is read; else the bar's.
    const ours = Boolean(page && row.project && page.folder === row.project.folder);
    const known = ours ? page.status?.icon : null;
    const draft = ours ? page.iconDraft : null;
    const onBar = row.onBar ? `/api/storage/read?path=${encodeURIComponent(`/ext/user_assets/${row.id}/appmeta/icon_back_11x11.png`)}` : null;
    const front = draft?.front ?? known?.front ?? icons.get(row.id) ?? null;
    // A new front makes a new back from it, unless a back was uploaded too.
    const back = draft?.back ?? (draft?.front ? null : (known ? known.back : onBar));
    const tiles = [iconTile(front, "Front", draft?.front ? "8×8, new" : "8×8"), iconTile(back, "Back", draft?.back ? "11×11, new" : draft?.front ? "11×11, made from the front" : "11×11")];
    const editable = Boolean(row.project && inShell() && page?.drafts && globalThis.emulatorCreateApp?.pickIcon);
    if (editable) {
      for (const [tile, side] of [[tiles[0], "front"], [tiles[1], "back"]]) {
        const upload = button("icon-btn small", "", page.saving ? "Saving" : null, () => uploadIcon(side), side === "front" ? "Upload a PNG of 8×8 pixels" : "Upload a PNG of 11×11 pixels", "upload");
        upload.ariaLabel = `Upload the ${side} icon`;
        tile.append(upload);
      }
    }
    pair.append(...tiles);
    box.append(pair);
    if (ours && page.iconSaid) box.append(make("p", `page-note${page.iconSaid.failed ? " failed" : ""}`, page.iconSaid.text));
    if (editable && draft) {
      const row_ = make("div", "page-save");
      row_.append(button("btn solid small", "Use this icon", page.saving ? "Saving" : null, () => saveIcon(), "", "checkmark"), button("btn small", "Cancel", null, () => {
        page.iconDraft = null;
        page.iconSaid = null;
        rerender();
      }));
      box.append(row_);
    }
    return box;
  }

  /** The page made again, now (what was typed is in the drafts). */
  function rerender() {
    tabShown = null;
    renderApp();
  }

  /** Upload: a PNG of the person's own, checked as Create app checks it; shown in place of the icon until saved. */
  async function uploadIcon(side) {
    const picked = await globalThis.emulatorCreateApp?.pickIcon?.(side);
    if (!picked || !page) return;
    page.iconSaid = picked.problem ? { failed: true, text: picked.problem } : null;
    if (picked.data) page.iconDraft = { ...(page.iconDraft ?? {}), [side]: picked.data };
    rerender();
  }

  /** Use this icon: written into the project (publish.icon); the back is made from the front unless one was given. */
  async function saveIcon() {
    const row = chosen();
    const draft = page?.iconDraft;
    if (!draft || !row?.project || page.saving) return;
    const front = draft.front ?? page.status.icon?.front ?? null;
    if (!front) {
      page.iconSaid = { failed: true, text: "Upload the front icon too, a PNG of 8×8 pixels." };
      return rerender();
    }
    const folder = page.folder;
    page.saving = true;
    rerender();
    let answer;
    try {
      answer = await actions().publish.icon({ folder, front, back: draft.back ?? null });
    } catch (e) {
      answer = { ok: false, message: e?.code === NO_GESTURE ? "Click again" : String(e?.message ?? e) };
    }
    if (page?.folder !== folder) return;
    page.saving = false;
    if (answer?.ok === false) page.iconSaid = { failed: true, text: answer.message ?? "The icon was not saved" };
    else {
      page.iconDraft = null;
      page.status.icon = { front, back: draft.back ?? null };
      page.iconSaid = { text: "Icon saved. Refresh puts it on the BUSY Bar." };
      // The back made from the front: as the project has it now.
      try {
        const fresh = await actions().publish.status(folder);
        if (fresh?.icon && page?.folder === folder) page.status.icon = fresh.icon;
      } catch {
        // The one just written is shown.
      }
    }
    rerender();
  }

  function changed(key) {
    page.dirty.add(key);
    page.iconSaid = null;
    renderSave();
  }

  const saveRow = make("div", "page-save");
  function renderSave() {
    if (!page?.drafts) return saveRow.replaceChildren();
    const dirty = page.dirty.size > 0;
    const save = button("btn solid small", page.saving ? "Saving" : "Save", !dirty || page.saving ? (page.saving ? "Saving" : "Nothing changed") : null, save_);
    const said = make("span", `said${page.iconSaid?.failed ? " failed" : ""}`, page.iconSaid?.text ?? (dirty ? "Not saved yet" : ""));
    saveRow.replaceChildren(save, said);
  }

  async function save_() {
    const row = chosen();
    if (!page?.drafts || !row?.project || page.saving) return;
    const folder = page.folder;
    page.saving = true;
    renderSave();
    const problems = [];
    try {
      if (["name", "category", "short_description", "description"].some((key) => page.dirty.has(key))) {
        const answer = await actions().publish.texts({ folder, name: page.drafts.name, texts: page.drafts.texts });
        if (answer?.ok === false || answer?.name_problem) problems.push(answer?.name_problem ?? answer?.message ?? "The texts were not saved");
        else for (const key of ["name", "category", "short_description", "description"]) page.dirty.delete(key);
      }
      if (page.dirty.has("usage") && howTo) {
        const answer = await actions().publish.readme({ folder, readme: readmeWith(page.status.readme, page.drafts.usage) });
        if (answer?.ok === false) problems.push(answer?.message ?? "README.md was not written");
        else page.dirty.delete("usage");
      }
    } catch (e) {
      problems.push(e?.code === NO_GESTURE ? "Click again" : String(e?.message ?? e));
    }
    if (page?.folder !== folder) return;
    page.saving = false;
    page.said = problems.length ? { failed: true, text: problems.join(". ") } : { text: "Saved" };
    renderSave();
    if (!problems.length) loadApps();
  }

  function render(row) {
    const parts = [];
    const shell = inShell();
    if (!row.project || !shell) {
      // An app from a package, or the window in a browser: what is known, read only.
      const fields = make("div", "field-set");
      const name = make("input", "ov-input");
      name.value = row.name;
      name.disabled = true;
      fields.append(pageField("Name", name).row);
      // In a browser no project is known here.
      parts.push(fields, iconsGroup(row));
      parts.push(make("p", "page-note", !shell ? NEEDS_APP : "Its texts are its project's: open the project's folder to edit them."));
      return appBody.replaceChildren(...parts);
    }
    if (!page || page.folder !== row.project.folder) load(row);
    if (!page.drafts && !page.failed) return appBody.replaceChildren(make("p", "page-note", "Reading the project"), iconsGroup(row));
    if (page.failed) {
      parts.push(make("p", "page-note", page.failed), iconsGroup(row));
      return appBody.replaceChildren(...parts);
    }
    const d = page.drafts;
    const limits = page.status.texts.rules?.limits ?? {};
    const fields = make("div", "field-set");
    const name = make("input", "ov-input");
    name.value = d.name;
    name.maxLength = 64;
    name.spellcheck = false;
    name.addEventListener("input", () => {
      d.name = name.value;
      changed("name");
    });
    fields.append(pageField("Name", name, "On the BUSY Bar and in the catalog").row);
    const short = make("input", "ov-input");
    short.value = d.texts.short_description;
    short.placeholder = "One line on the app's card";
    if (limits.short_description) short.maxLength = limits.short_description;
    short.addEventListener("input", () => {
      d.texts.short_description = short.value;
      changed("short_description");
    });
    fields.append(pageField("Short description", short).row);
    const description = make("textarea", "ov-input");
    description.rows = 4;
    description.value = d.texts.description;
    description.placeholder = "What it does and how to use it";
    description.addEventListener("input", () => {
      d.texts.description = description.value;
      changed("description");
    });
    fields.append(pageField("Description", description).row);
    const category = make("select", "ov-input");
    category.append(Object.assign(make("option", "", "Choose"), { value: "" }));
    for (const one of page.status.texts.rules?.categories ?? []) category.append(Object.assign(make("option", "", one.name), { value: one.id }));
    category.value = d.texts.category ?? "";
    category.addEventListener("change", () => {
      d.texts.category = category.value;
      changed("category");
    });
    const categoryField = pageField("Category", category);
    const chooser = make("span", "ov-select");
    chooser.innerHTML = icon("chevron-down");
    category.replaceWith(chooser);
    chooser.prepend(category);
    fields.append(categoryField.row);
    parts.push(fields, iconsGroup(row));

    if (d.usage && howTo) {
      const box = make("div");
      box.append(make("p", "group-label", "What the controls do"));
      const list = make("div", "controls-list");
      for (const control of howTo.CONTROLS) {
        const line = make("div", "control-row");
        const input = make("input", "ov-input");
        input.value = d.usage.rows[control] ?? "";
        input.placeholder = { Start: "Start or pause", "Wheel turn": "Change a value", "Wheel press": "Confirm", Back: "Go back" }[control] ?? "";
        input.ariaLabel = control;
        input.addEventListener("input", () => {
          d.usage.rows[control] = input.value;
          changed("usage");
        });
        // The control's chip, as the catalog's page shows it (icons/controls), and its name.
        const cap = make("span", "keycap");
        const chip = make("img");
        chip.alt = "";
        chip.src = `/emulator/icons/controls/${control.toLowerCase().replace(/ /g, "-")}.svg`;
        chip.addEventListener("error", () => chip.remove(), { once: true });
        cap.append(chip, make("span", "", control));
        line.append(cap, input);
        list.append(line);
      }
      box.append(list, make("p", "page-note", "The How to use section of README.md: the catalog shows it on the app's page."));
      parts.push(box);
    }
    renderSave();
    parts.push(saveRow);
    appBody.replaceChildren(...parts);
  }

  /** The project's files changed (a job ended, the publishing flow closed): read them again when next shown. */
  function forget() {
    if (page && page.dirty.size === 0 && !page.saving) page = null;
  }

  return { render, forget };
})();

// ---- layout-v2: Files. The project's files as its public repository would have them (publish.files, which only
// reads), those kept out after them; a click opens a text file in the system's app for it, anything else is shown in
// Finder or Explorer.

const files = (() => {
  let list = null; // { folder, answer, failed }
  let asked = 0;

  async function load(folder) {
    const mine = ++asked;
    list = { folder, answer: null, failed: null };
    let answer;
    try {
      answer = await actions().publish.files({ folder });
    } catch (e) {
      answer = { ok: false, message: String(e?.message ?? e) };
    }
    if (mine !== asked) return;
    if (answer?.ok === false || !Array.isArray(answer?.published)) list.failed = answer?.message ?? "The files could not be listed.";
    else list.answer = answer;
    if (chosen()?.project?.folder === folder && appTab === "files" && sideMode === "app") {
      tabShown = null;
      renderApp();
    }
  }

  const join = (folder, rel) => `${folder}${folder.includes("\\") ? "\\" : "/"}${rel.replace(/\//g, folder.includes("\\") ? "\\" : "/")}`;
  const OPENS = /\.(json|md|txt)$/i;

  function fileRow(folder, rel, why, left = false) {
    const li = make("li");
    const mark = make("span");
    mark.innerHTML = icon(rel.endsWith("/") ? "folder" : "file");
    const cut = rel.replace(/\/$/, "").lastIndexOf("/") + 1;
    const name = make("span", "name");
    name.append(make("span", "dir", rel.slice(0, cut)), rel.slice(cut));
    li.append(mark, name);
    if (why) li.append(make("span", "why", why));
    li.title = left ? `${rel}: not published` : OPENS.test(rel) ? `Open ${rel}` : `Show ${rel} in ${FILE_MANAGER}`;
    if (!left) {
      li.tabIndex = 0;
      const go = () => {
        const full = join(folder, rel);
        (OPENS.test(rel) ? actions().open(full) : actions().reveal(full)).catch?.(() => {});
      };
      li.addEventListener("click", go);
      li.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        e.stopPropagation();
        go();
      });
    }
    return li;
  }

  function render(row) {
    if (!row.project || !inShell()) {
      appBody.replaceChildren(make("p", "app-empty", !inShell() ? NEEDS_APP : !projectsKnown ? "Looking for its project" : "Installed from a package: it has no project folder here."));
      return;
    }
    const folder = row.project.folder;
    const head = make("div", "files-head");
    head.append(make("p", "group-label", "Project files"), button("btn small", `Show in ${FILE_MANAGER}`, null, () => actions().reveal(folder), "", "folder"));
    if (!list || list.folder !== folder) {
      load(folder);
      return appBody.replaceChildren(head, make("p", "page-note", "Reading the files"));
    }
    if (list.failed) return appBody.replaceChildren(head, make("p", "page-note", list.failed));
    if (!list.answer) return appBody.replaceChildren(head, make("p", "page-note", "Reading the files"));
    const published = [...list.answer.published].sort((a, b) => a.path.localeCompare(b.path));
    const shown = make("ul", "files");
    shown.append(...published.map((one) => fileRow(folder, one.path, null)));
    const parts = [head, shown];
    const left = (list.answer.left ?? []).map((one) => (typeof one === "string" ? one : one?.path)).filter(Boolean);
    if (left.length) {
      const out = make("ul", "files left");
      out.append(...left.slice(0, 40).map((rel) => fileRow(folder, rel, null, true)));
      parts.push(make("p", "group-label", "Not published"), out);
    }
    appBody.replaceChildren(...parts);
  }

  function forget() {
    list = null;
  }

  return { render, forget };
})();

// The app's pace over the last state update: display/draw requests per second and how much of the time its JS is busy
// (at bar speed, the bar's time).
let lastSample = null;
let lastPace = null;

function pace(running) {
  const now = performance.now();
  const { draws, busyMs } = running.stats;
  const prev = lastSample?.id === running.id ? lastSample : null;
  if (!prev) lastPace = null;
  // Updates closer together than half a second (an app installed or launched) keep the earlier sample.
  if (prev && now - prev.now < 500) return null;
  lastSample = { id: running.id, now, draws, busyMs };
  if (!prev) return null;
  const seconds = (now - prev.now) / 1000;
  return { fps: (draws - prev.draws) / seconds, busy: Math.min(1, (busyMs - prev.busyMs) / 1000 / seconds) };
}

// At bar speed, the default, nothing is said. Started with --fast, the emulator says so: what an app does here it
// does much slower on a bar.
function renderSpeed(barSpeed) {
  const note = $("#speed-note");
  note.hidden = barSpeed;
  note.title = "Started with --fast: apps run as fast as this computer allows. On the BUSY Bar they run much slower.";
}

function renderRunning(running) {
  const id = running?.id ?? null;
  if (id !== runningId) {
    runningId = id;
    // An app that has just started is the one to look at.
    if (id !== null && id !== chosenId) {
      chosenId = id;
      reveal = true;
      settings = null;
      loadSettings();
    }
    renderAll();
  }
  if (!running) return;
  const { heapNow, heapPeak, heapSize } = running.stats;
  const kib = (n) => (n / 1024).toFixed(1);
  const p = pace(running) ?? lastPace;
  lastPace = p;
  runningBox.innerHTML = `<div class="heap"><div class="now"></div><div class="peak"></div></div><div class="stats"><span class="heap-text"></span><span class="speed-text"></span></div>`;
  runningBox.querySelector(".now").style.width = `${(100 * heapNow) / heapSize}%`;
  runningBox.querySelector(".peak").style.left = `${(100 * heapPeak) / heapSize}%`;
  runningBox.querySelector(".heap").title = "The app's JS heap: the white mark is its peak";
  runningBox.querySelector(".heap-text").textContent = `Heap ${kib(heapNow)} of ${Math.round(heapSize / 1024)} KiB, peak ${kib(heapPeak)}`;
  if (p) {
    const speedText = runningBox.querySelector(".speed-text");
    speedText.textContent = `${p.fps.toFixed(1)} draws/s, JS ${Math.round(p.busy * 100)}%`;
    speedText.title = "Draw requests a second, and the share of the time the app's JS is busy";
    // Busy all the time: the app does not keep up, keys and timers wait.
    speedText.classList.toggle("busy", p.busy > 0.9);
  }
}

// ---- the app's settings: a form of our own, from the app's settings file

// The schema is the app's appmeta/settings.json, read from the bar's storage; the values come from and go to the
// bar's API, GET and PUT /api/apps/settings, as the local web's form does it. Labels, descriptions and options are
// the app's own words: they are shown as text and never as markup.
let settings = null; // { id, schema, version, values, dirty } | { id, none } | { id, problem }
let settingsAsked = 0;

async function loadSettings({ keepEdits = true } = {}) {
  const id = chosenId;
  if (id !== null && settings?.id === id && settings.dirty && keepEdits) return;
  const asked = ++settingsAsked;
  let read = null;
  if (id !== null && chosen()?.onBar && powered) {
    try {
      const values = await fetch(`/api/apps/settings?app_id=${encodeURIComponent(id)}`);
      if (values.status === 404) read = { id, none: true };
      else if (!values.ok) read = { id, problem: values.status === 503 ? "The app's settings file is not one the BUSY Bar takes" : `The BUSY Bar did not give the settings (${values.status})` };
      else {
        const doc = await values.json();
        const schema = await (await fetch(`/api/storage/read?path=${encodeURIComponent(`/ext/user_assets/${id}/appmeta/settings.json`)}`)).json();
        read = schema?.fields && doc?.values ? { id, schema, version: doc.version, values: doc.values, dirty: false } : { id, none: true };
      }
    } catch {
      read = { id, problem: "The settings could not be read" };
    }
  }
  if (asked !== settingsAsked) return; // asked again since: that answer is the one shown
  settings = read;
  renderSettings();
}

// ---- the controls of the settings form: those of the local web's own form (its SettingsFields), drawn the same way:
// a number is a stepper (− the value +), a choice a small button that opens a list, a yes or no a switch, a color a
// round button with its swatch. What they do follows the local web too: the stepper keeps to the field's min, max and
// step and repeats while a button is held, the keys step it as the local web's do; a text longer than the bar takes is
// said under the field's words.

// A setting's integer, when the app's file gives no bound: what the bar's settings take (a signed 32-bit number).
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
// The local web writes a number with its thousands grouped (Intl, its locale English); it reads one with or without.
const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
/** The whole number a field's text says, with or without the commas of its groups; null for anything else. */
const wholeOf = (text) => {
  const plain = String(text).replace(/[,\s]/g, "").replace(/^−/, "-");
  return /^-?\d+$/.test(plain) ? Number(plain) : null;
};
// Held down, a stepper's button steps once, again after this long, and then at this pace (reka-ui's usePressedHold,
// which the local web's number field uses).
const HOLD_DELAY_MS = 400;
const HOLD_EVERY_MS = 60;

/** The bounds and the step of an integer field, and what a number becomes in them: on the step from min, in [min, max]. */
function integerRule(field) {
  const min = Number.isInteger(field.min) ? field.min : INT_MIN;
  const max = Number.isInteger(field.max) ? field.max : INT_MAX;
  const step = Number.isInteger(field.step) && field.step > 0 ? field.step : 1;
  const fit = (n) => Math.min(max, Math.max(min, min + Math.round((n - min) / step) * step));
  return { min, max, step, fit };
}

/** The stepper of an integer: its text field, then − and +, laid over the field's two ends. */
function stepperOf(field, values, id, changed) {
  const { min, max, step, fit } = integerRule(field);
  const el = make("input", "input stepper-value");
  el.type = "text";
  el.inputMode = "numeric";
  el.autocomplete = "off";
  el.spellcheck = false;
  el.role = "spinbutton";
  el.ariaLabel = field.label ?? id;
  el.ariaValueMin = String(min);
  el.ariaValueMax = String(max);
  const down = make("button", "step down");
  const up = make("button", "step up");
  down.append(make("span", "minus"));
  up.innerHTML = icon("plus");
  for (const [b, label] of [[down, "Decrement"], [up, "Increment"]]) {
    b.type = "button";
    b.tabIndex = -1;
    b.ariaLabel = label;
    b.title = label === "Decrement" ? "Less" : "More";
  }
  const show = () => {
    const n = values[id];
    el.value = Number.isInteger(n) ? grouped.format(n) : String(n ?? "");
    el.ariaValueNow = String(n ?? "");
    down.disabled = Number.isInteger(n) && n <= min;
    up.disabled = Number.isInteger(n) && n >= max;
  };
  const put = (n) => {
    const next = fit(n);
    if (next !== values[id]) {
      values[id] = next;
      changed();
    }
    show();
  };
  /** The value now, read from the text while it is being typed. */
  const now = () => wholeOf(el.value) ?? (Number.isInteger(values[id]) ? values[id] : fit(0));
  const by = (steps) => put(now() + steps * step);

  // Typed: kept as typed while it is a number, so that Save sends it; set within the bounds when the field is left.
  el.addEventListener("input", () => {
    const n = wholeOf(el.value);
    if (n !== null) values[id] = n;
    changed();
  });
  // Left, or Enter: a number is set within the bounds and on the step; anything else gives the value back.
  const commit = () => {
    const n = wholeOf(el.value);
    if (n === null) show();
    else put(n);
  };
  el.addEventListener("change", commit);
  el.addEventListener("blur", commit);
  el.addEventListener("keydown", (e) => {
    const steps = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (steps !== undefined) by(steps);
    else if (e.key === "Home" && Number.isInteger(field.min)) put(min);
    else if (e.key === "End" && Number.isInteger(field.max)) put(max);
    else if (e.key === "Enter") commit();
    else return;
    e.preventDefault();
  });
  // The wheel steps the value while the field has the focus, as in the local web.
  el.addEventListener(
    "wheel",
    (e) => {
      if (document.activeElement !== el || !e.deltaY) return;
      e.preventDefault();
      by(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  // A button steps once when pressed and keeps stepping while it is held; it does not take the focus from the text.
  for (const [b, steps] of [[down, -1], [up, 1]]) {
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      timer = null;
    };
    const again = () => {
      if (b.disabled) return stop();
      by(steps);
      timer = setTimeout(again, HOLD_EVERY_MS);
    };
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || b.disabled) return;
      e.preventDefault();
      b.setPointerCapture?.(e.pointerId);
      by(steps);
      stop();
      timer = setTimeout(again, HOLD_DELAY_MS);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) b.addEventListener(type, stop);
    // A click with no pointer behind it (an assistive technology's, a script's) steps once.
    b.addEventListener("click", (e) => {
      if (!e.detail) by(steps);
    });
  }
  show();
  return [el, down, up];
}

// The one list of choices open at a time: how to close it.
let openChoice = null;

/** A choice of the app's options: a small button with the chosen one and a chevron, and its list. */
function choiceOf(field, values, id, changed) {
  const options = field.options ?? [];
  const trigger = make("button", "select");
  trigger.type = "button";
  trigger.role = "combobox";
  trigger.ariaHasPopup = "listbox";
  aria(trigger, "expanded", "false");
  trigger.ariaLabel = field.label ?? id;
  const label = make("span", "select-label");
  const chevron = make("span", "select-chevron");
  chevron.innerHTML = icon("chevron-down");
  trigger.append(label, chevron);
  const list = make("div", "select-list");
  list.role = "listbox";
  list.tabIndex = -1;
  list.hidden = true;
  // An option: its label, and the check that marks the chosen one (shown by the style sheet).
  const items = options.map((option) => {
    const item = make("div", "select-option");
    item.role = "option";
    item.value = option.value;
    const check = make("span", "select-check");
    check.innerHTML = icon("checkmark-circle-fill");
    item.append(make("span", "select-text", option.label), check);
    return item;
  });
  list.append(...items);
  // The option the keys are on (or the pointer is over); none when the list was opened with the pointer.
  let lit = -1;
  const chosenIndex = () => Math.max(0, options.findIndex((option) => option.value === values[id]));
  const light = (i) => {
    lit = i < 0 ? -1 : Math.min(items.length - 1, i);
    items.forEach((item, k) => item.classList.toggle("lit", k === lit));
    items[lit]?.scrollIntoView?.({ block: "nearest" });
  };
  const show = () => {
    const chosen = options.find((option) => option.value === values[id]);
    trigger.value = values[id] ?? "";
    label.textContent = chosen ? chosen.label : String(values[id] ?? "");
    items.forEach((item) => {
      const on = item.value === values[id];
      item.classList.toggle("on", on);
      aria(item, "selected", on ? "true" : "false");
    });
  };
  const close = (refocus = true) => {
    if (list.hidden) return;
    list.hidden = true;
    aria(trigger, "expanded", "false");
    globalThis.removeEventListener?.("pointerdown", outside, true);
    globalThis.removeEventListener?.("resize", closeQuietly);
    globalThis.removeEventListener?.("scroll", closeQuietly, true);
    if (openChoice === close) openChoice = null;
    if (refocus) trigger.focus?.();
  };
  const closeQuietly = (e) => {
    if (e?.type === "scroll" && list.contains?.(e.target)) return;
    close(false);
  };
  const outside = (e) => {
    if (!trigger.contains?.(e.target) && !list.contains?.(e.target)) close(false);
  };
  const pick = (i) => {
    const option = options[i];
    if (!option) return close();
    if (values[id] !== option.value) {
      values[id] = option.value;
      changed();
    }
    show();
    close();
  };
  const open = (byKeys) => {
    if (!list.hidden) return;
    openChoice?.(false);
    openChoice = close;
    list.hidden = false;
    aria(trigger, "expanded", "true");
    // Under the button, its left edge with the button's, 8 px apart, as the local web puts it; above it when there is
    // no room below.
    const box = trigger.getBoundingClientRect();
    const room = (globalThis.innerHeight ?? 0) - box.bottom;
    const height = list.getBoundingClientRect?.().height ?? 0;
    const width = Math.max(box.width, list.getBoundingClientRect?.().width ?? 0);
    list.style.minWidth = `${box.width}px`;
    list.style.left = `${Math.max(8, Math.min(box.left, (globalThis.innerWidth ?? Infinity) - 8 - width))}px`;
    list.style.top = room < height + 16 && box.top > room ? `${Math.max(8, box.top - 8 - height)}px` : `${box.bottom + 8}px`;
    light(byKeys ? chosenIndex() : -1);
    addEventListener("pointerdown", outside, true);
    addEventListener("resize", closeQuietly);
    addEventListener("scroll", closeQuietly, true);
    list.focus?.({ preventScroll: true });
  };
  // A click of the pointer has a count (detail); Enter and Space give none, and the list opens on the chosen option.
  trigger.addEventListener("click", (e) => (list.hidden ? open(!e.detail) : close()));
  // Enter and Space press the button (its click); the arrows open the list too. The keys stay the list's: the bar's
  // keyboard (above) does not get them.
  trigger.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.stopPropagation();
    open(true);
  });
  let typed = "";
  let typedAt = 0;
  list.addEventListener("keydown", (e) => {
    const keys = { ArrowDown: () => light(lit < 0 ? chosenIndex() : lit + 1), ArrowUp: () => light(lit < 0 ? chosenIndex() : Math.max(0, lit - 1)), Home: () => light(0), End: () => light(items.length - 1), Enter: () => pick(lit), " ": () => pick(lit), Escape: () => close() };
    if (keys[e.key]) {
      e.preventDefault();
      e.stopPropagation();
      return keys[e.key]();
    }
    if (e.key === "Tab") return close();
    // Letters go to the first option that starts with what was typed in the last second.
    if (e.key.length === 1) {
      const at = Date.now();
      typed = (at - typedAt < 1000 ? typed : "") + e.key.toLowerCase();
      typedAt = at;
      const found = options.findIndex((option) => String(option.label).toLowerCase().startsWith(typed));
      if (found >= 0) light(found);
    }
  });
  items.forEach((item, i) => {
    item.addEventListener("pointermove", () => lit !== i && light(i));
    item.addEventListener("click", () => pick(i));
  });
  show();
  return [trigger, list];
}

/** A color: a round button with its swatch and its #RRGGBB, over the color field that the button opens. */
function colorOf(values, id, changed) {
  const el = make("input", "color-input");
  el.type = "color";
  el.tabIndex = -1;
  el.ariaHidden = "true";
  const pill = make("button", "color-pill");
  pill.type = "button";
  const swatch = make("span", "swatch");
  const hex = make("span", "hex");
  pill.append(swatch, hex);
  const show = () => {
    const value = String(values[id] ?? "#000000");
    el.value = value.slice(0, 7);
    swatch.style.backgroundColor = value.slice(0, 7);
    hex.textContent = value.toUpperCase();
  };
  pill.addEventListener("click", () => {
    try {
      el.showPicker();
    } catch {
      el.click?.();
    }
  });
  // #RRGGBB, or #RRGGBBAA: the color is picked, its last two digits are kept.
  el.addEventListener("input", () => {
    values[id] = el.value.toUpperCase() + String(values[id] ?? "").slice(7);
    show();
    changed();
  });
  show();
  return [el, pill];
}

/** How many bytes a text takes on the bar, and what the local web says of a text the field does not take. */
const textBytes = (text) => [...String(text ?? "")].reduce((sum, c) => sum + (c.codePointAt(0) < 0x80 ? 1 : c.codePointAt(0) < 0x800 ? 2 : c.codePointAt(0) < 0x10000 ? 3 : 4), 0);
function textProblem(field, text) {
  const length = textBytes(text);
  const least = field.min_length ?? 0;
  const most = field.max_length ?? 64;
  if (length < least) return least === 1 ? "Required" : `Too short: ${length}/${least} bytes`;
  if (length > most) return `Too long: ${length}/${most} bytes`;
  return null;
}

/** The control of one field, bound to `values[id]`; `said` is the line under the field's words for what is wrong. */
function controlOf(field, values, id, said) {
  const changed = () => {
    settings.dirty = true;
    saveSaid.textContent = "";
  };
  const input = (type, className = "input") => {
    const el = make("input", className);
    el.type = type;
    return el;
  };
  switch (field.type) {
    case "boolean": {
      const el = input("checkbox", "switch");
      el.role = "switch";
      el.ariaLabel = field.label ?? id;
      el.checked = values[id] === true;
      el.addEventListener("change", () => {
        values[id] = el.checked;
        changed();
      });
      return [el];
    }
    case "integer":
      return stepperOf(field, values, id, changed);
    case "string": {
      const el = input(field.sensitive ? "password" : "text");
      el.maxLength = field.max_length ?? 64;
      el.autocomplete = "off";
      el.ariaLabel = field.label ?? id;
      el.value = String(values[id] ?? "");
      const check = () => {
        const problem = textProblem(field, el.value);
        said.textContent = problem ?? "";
        said.hidden = !problem;
        el.classList.toggle("wrong", Boolean(problem));
      };
      el.addEventListener("input", () => {
        values[id] = el.value;
        check();
        changed();
      });
      check();
      return [el];
    }
    case "enum":
      return choiceOf(field, values, id, changed);
    case "color":
      return colorOf(values, id, changed);
    case "time": {
      // HH:MM, or HH:MM:SS when the app's default has seconds.
      const seconds = String(field.default ?? "").length > 5;
      const el = input("time");
      el.step = seconds ? "1" : "60";
      el.ariaLabel = field.label ?? id;
      el.value = String(values[id] ?? "");
      el.addEventListener("input", () => {
        if (!el.value) return;
        values[id] = seconds ? el.value.padEnd(8, ":00").slice(0, 8) : el.value.slice(0, 5);
        changed();
      });
      return [el];
    }
    default:
      return [make("span", "", String(field.type))];
  }
}

/**
 * The place, as the local web draws it: a card with Auto-detect location and its switch, a line, the field's label
 * and the place's name; turned off, the place is fixed and its name and coordinates are typed under the card (the
 * local web finds a city by its name on BUSY's service instead, which the emulator does not reach).
 */
function placeOf(field, values, id) {
  const changed = () => {
    settings.dirty = true;
    saveSaid.textContent = "";
  };
  const place = { mode: "auto", name: "", ...(values[id] ?? {}) };
  const box = make("div", "geo");
  const card = make("div", "geo-card");
  const autoRow = make("label", "geo-auto");
  const auto = make("input", "switch");
  auto.type = "checkbox";
  auto.role = "switch";
  auto.checked = place.mode !== "fixed";
  autoRow.append(make("span", "geo-auto-text", "Auto-detect location"), auto);
  const where = make("div", "geo-where");
  const label = make("div", "geo-label", field.label ?? id);
  const nameRow = make("div", "geo-name-row");
  const mark = make("span", "geo-mark");
  mark.innerHTML = icon("location");
  const shown = make("span", "geo-name");
  nameRow.append(mark, shown);
  where.append(label, ...(field.description ? [make("div", "geo-about", field.description)] : []), nameRow);
  card.append(autoRow, make("div", "geo-line"), where);
  const fixed = make("div", "geo-fixed");
  const input = (className, placeholder) => {
    const el = make("input", className);
    el.type = "text";
    el.placeholder = placeholder;
    el.ariaLabel = placeholder;
    el.autocomplete = "off";
    return el;
  };
  const name = input("input geo-name-input", "Name");
  name.value = place.name;
  name.maxLength = 128;
  const lat = input("input", "Latitude");
  const lon = input("input", "Longitude");
  for (const [el, key] of [[lat, "lat"], [lon, "lon"]]) {
    el.inputMode = "decimal";
    el.value = place[key] === undefined ? "" : String(place[key]);
  }
  const coordinates = make("div", "geo-coordinates");
  coordinates.append(lat, lon);
  fixed.append(name, coordinates);
  const show = () => {
    const isFixed = !auto.checked;
    fixed.hidden = !isFixed;
    lat.hidden = lon.hidden = !isFixed;
    card.classList.toggle("open", isFixed);
    shown.textContent = isFixed ? name.value || "Not named" : "Auto";
  };
  const put = () => {
    const isFixed = !auto.checked;
    values[id] = isFixed ? { mode: "fixed", name: name.value, lat: Number(lat.value), lon: Number(lon.value) } : { mode: "auto", name: name.value };
    show();
    changed();
  };
  auto.addEventListener("change", put);
  for (const el of [name, lat, lon]) el.addEventListener("input", put);
  show();
  box.append(card, fixed);
  return box;
}

// How wide a field's control is, by its kind: the row puts it under the field's words when the form is too narrow
// for both side by side (window.css, the container queries of .settings).
const CONTROL_WIDTH = { integer: "mid", time: "mid", string: "wide", enum: "small", color: "small", boolean: "tiny" };

/** The rows of the fields of one level; a group is a heading and its own rows. */
function fieldRows(fields, values) {
  return Object.entries(fields ?? {}).map(([id, field]) => {
    if (field.type === "group") {
      if (values[id] === null || typeof values[id] !== "object") values[id] = {};
      const group = make("div", "group");
      group.append(make("h3", "", field.label ?? id), ...(field.description ? [make("p", "group-about", field.description)] : []), ...fieldRows(field.fields, values[id]));
      return group;
    }
    if (field.type === "geolocation") {
      return placeOf(field, values, id);
    }
    const row = make("div", `field ${CONTROL_WIDTH[field.type] ?? "mid"}`);
    const name = make("span", "field-name");
    const title = make("b", "", field.label ?? id);
    title.title = field.label ?? id;
    name.append(title);
    if (field.description) name.append(make("span", "", field.description));
    const said = make("span", "field-wrong");
    said.hidden = true;
    const control = make("span", `field-input ${field.type}`);
    control.append(...controlOf(field, values, id, said));
    name.append(said);
    row.append(name, control);
    return row;
  });
}

const saveRow = make("div", "save");
const saveSaid = make("span", "said");

function renderSettings() {
  openChoice?.(false);
  if (!settings || settings.id !== chosenId || settings.none) settingsBox.replaceChildren();
  else if (settings.problem) settingsBox.replaceChildren(make("div", "hint", settings.problem));
  else {
    saveSaid.textContent = "";
    saveSaid.className = "said";
    saveRow.replaceChildren(button("btn solid", "Save", null, saveSettings), button("btn", "Restart", null, restartApp, "Start the app again: it reads its settings when it starts"), saveSaid);
    settingsBox.replaceChildren(...fieldRows(settings.schema.fields, settings.values), saveRow);
  }
  // The Settings tab shows the form as soon as it is read.
  if (appTab === "settings" && sideMode === "app") renderSettingsPage();
}

async function saveSettings() {
  const saved = settings;
  if (!saved?.schema) return;
  // A number still being typed is set within its bounds first, as leaving its field does (Save does not take the
  // focus: the window's buttons never do).
  if (settingsBox.contains?.(document.activeElement)) document.activeElement.blur();
  let answer = null;
  try {
    answer = await fetch(`/api/apps/settings?app_id=${encodeURIComponent(saved.id)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: saved.version, values: saved.values }) });
  } catch {
    // Not sent: said below.
  }
  if (settings !== saved) return;
  saveSaid.className = answer?.ok ? "said" : "said failed";
  if (answer?.ok) {
    saved.dirty = false;
    saveSaid.textContent = saved.id === runningId ? "Saved. Restart the app to use them." : "Saved";
  } else {
    saveSaid.textContent = answer?.status === 400 ? "The BUSY Bar refused these values. The console says why." : "Not saved";
  }
}

/** Stops the app that runs, if one does, and starts the chosen one. */
async function restartApp() {
  const id = chosenId;
  if (runningId !== null) await post("/api/apps/quit");
  await post(`/api/apps/launch?app_id=${encodeURIComponent(id)}`);
  saveSaid.textContent = "";
}

// The desktop app's word about a job. Its actions may come after this page has started: they are looked for again
// when the page has loaded.
let listening = false;
function listen() {
  if (listening || !actions()?.on) return;
  try {
    actions().on("job", onJob);
    listening = true;
  } catch {
    // No events: the answers of the actions are shown all the same.
  }
}
listen();
addEventListener("load", () => {
  if (!inShell()) return;
  listen();
  loadApps();
});

// ---------------------------------------------------------------- console

const consoleBox = $("#console");
const MAX_LINES = 2000;

function addLine({ kind, text, time }) {
  const stick = consoleBox.scrollTop + consoleBox.clientHeight >= consoleBox.scrollHeight - 4;
  const line = document.createElement("div");
  line.className = `line ${kind}`;
  const t = new Date(time);
  const stamp = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
  // An app's console line arrives as "<app id> <severity>: <text>"; the color already says the severity.
  // The server's own lines of these kinds ("App <id>: …") keep their start.
  const shown = ["log", "info", "warn", "error"].includes(kind) ? text.replace(new RegExp(`^\\S+ ${kind}: `), "") : text;
  line.innerHTML = `<span class="time"></span><span class="text"></span>`;
  line.querySelector(".time").textContent = stamp;
  line.querySelector(".text").textContent = shown;
  consoleBox.append(line);
  while (consoleBox.childElementCount > MAX_LINES) consoleBox.firstElementChild.remove();
  if (stick) consoleBox.scrollTop = consoleBox.scrollHeight;
  if (shownKind(kind)) consoleBox.classList.remove("blank");
  if (kind === "error") renderErrors(errorCount + 1);
}

/** Whether lines of a kind show with the filters as they are: not a kind turned off, and an error or a warning when
    the console shows the errors only. */
const shownKind = (kind) => !consoleBox.classList.contains(`hide-${kind}`) && (!consoleBox.classList.contains("only-errors") || kind === "error" || kind === "warn");

// A console that shows no line, because it has none or its filters hide them all, says so.
function renderBlank() {
  consoleBox.classList.toggle("blank", ![...consoleBox.children].some((line) => shownKind(line.className.replace("line ", ""))));
}

// layout-v2: how many errors the console holds, beside its name; and All or Errors.
let errorCount = 0;
function renderErrors(count) {
  errorCount = count;
  const badge = $("#error-count");
  badge.hidden = count === 0;
  badge.textContent = count > 999 ? "999+" : String(count);
  badge.title = count === 1 ? "1 error" : `${count} errors`;
}
const showAll = $("#show-all");
const showErrors = $("#show-errors");
function onlyErrors(on) {
  consoleBox.classList.toggle("only-errors", on);
  showAll.classList.toggle("on", !on);
  showErrors.classList.toggle("on", on);
  aria(showAll, "pressed", String(!on));
  aria(showErrors, "pressed", String(on));
  renderBlank();
}
showAll.addEventListener("click", () => onlyErrors(false));
// In a narrow console the kinds of line are a menu behind the filter button; a click elsewhere closes it.
const kindsButton = $("#console-kinds-btn");
const kinds = $("#console-kinds");
function openKinds(open) {
  kinds.classList.toggle("open", open);
  aria(kindsButton, "expanded", String(open));
}
kindsButton.addEventListener("click", () => openKinds(!kinds.classList.contains("open")));
addEventListener("pointerdown", (e) => kinds.classList.contains("open") && !kinds.contains(e.target) && !kindsButton.contains(e.target) && openKinds(false), true);
showErrors.addEventListener("click", () => onlyErrors(true));

for (const box of document.querySelectorAll(".filters input")) {
  const apply = () => {
    consoleBox.classList.toggle(`hide-${box.dataset.kind}`, !box.checked);
    renderBlank();
  };
  box.addEventListener("change", apply);
  apply();
}
renderBlank();
let consoleFrom = null; // when the person last pressed Clear (the computer's clock, ms); null: the console shows all
$("#clear").addEventListener("click", () => {
  consoleBox.replaceChildren();
  consoleFrom = Date.now();
  renderErrors(0);
  renderBlank();
});

// layout-v2: the console collapses to its head, and its top edge resizes it; both are kept (localStorage).
const consoleCard = $("#console-card");
const CONSOLE_KEY = "busy-emulator.console";
const CONSOLE_MIN = 120;
function keptConsole() {
  try {
    const kept = JSON.parse(localStorage.getItem(CONSOLE_KEY) ?? "null");
    return kept && typeof kept === "object" ? kept : {};
  } catch {
    return {};
  }
}
function keepConsole(change) {
  try {
    localStorage.setItem(CONSOLE_KEY, JSON.stringify({ ...keptConsole(), ...change }));
  } catch {
    // Not kept: this window still has it.
  }
}
/** The tallest the console may be: the stage keeps room for the bar, its controls and the bar's card. */
function consoleMax() {
  const stage = $("#stage").getBoundingClientRect();
  const card = $(".device-card").getBoundingClientRect();
  return Math.max(CONSOLE_MIN, stage.height - card.height - 300);
}
function sizeConsole(height) {
  if (!Number.isFinite(height)) return consoleCard.style.removeProperty?.("--console-h");
  consoleCard.style.setProperty("--console-h", `${Math.round(Math.min(consoleMax(), Math.max(CONSOLE_MIN, height)))}px`);
}
function collapseConsole(collapsed) {
  consoleCard.classList.toggle("collapsed", collapsed);
  for (const el of [$("#console-collapse"), $("#console-toggle")]) aria(el, "expanded", String(!collapsed));
  $("#console-collapse").title = collapsed ? "Show the console" : "Collapse the console";
  $("#console-collapse").ariaLabel = $("#console-collapse").title;
}
const toggleConsole = () => {
  const collapsed = !consoleCard.classList.contains("collapsed");
  collapseConsole(collapsed);
  keepConsole({ collapsed });
};
$("#console-collapse").addEventListener("click", toggleConsole);
$("#console-toggle").addEventListener("click", toggleConsole);
{
  const kept = keptConsole();
  collapseConsole(kept.collapsed === true);
  if (Number.isFinite(kept.height)) sizeConsole(kept.height);
}
const grip = $("#console-grip");
let gripFrom = null; // { y, height }
grip.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  gripFrom = { y: e.clientY, height: consoleCard.getBoundingClientRect().height };
  grip.classList.add("dragging");
});
grip.addEventListener("pointermove", (e) => gripFrom && sizeConsole(gripFrom.height + gripFrom.y - e.clientY));
for (const type of ["pointerup", "pointercancel"]) {
  grip.addEventListener(type, () => {
    if (!gripFrom) return;
    gripFrom = null;
    grip.classList.remove("dragging");
    keepConsole({ height: consoleCard.getBoundingClientRect().height });
  });
}
// With the keyboard: the arrows make it taller or shorter.
grip.addEventListener("keydown", (e) => {
  const step = { ArrowUp: 24, ArrowDown: -24 }[e.key];
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  sizeConsole(consoleCard.getBoundingClientRect().height + step);
  keepConsole({ height: consoleCard.getBoundingClientRect().height });
});
// A smaller window: a console kept tall gives the stage its room back.
addEventListener("resize", () => {
  const kept = keptConsole();
  if (Number.isFinite(kept.height)) sizeConsole(kept.height);
});

// ---- the console in the system's terminal: "Open in Terminal" on macOS, "Open in cmd" on Windows. The desktop app
// opens it in the chosen app's project folder, running busy-emulator logs --follow with the filters that are on and
// from the last Clear (README.md beside this file, terminalInfo and openTerminal).

const terminalButton = $("#open-terminal");
const CONSOLE_KIND = { app: "lifecycle", build: "build", system: "system" }; // a filter's data-kind → logs --kind
let terminal = null; // what the desktop app said: { available, name, label, why }

function renderTerminal(said = null) {
  const guess = /win/i.test(globalThis.navigator?.platform ?? "") ? "Open in cmd" : "Open in Terminal";
  const label = terminal?.label ?? guess;
  const why = !inShell() ? NEEDS_APP : !terminal ? "Not available" : terminal.available ? null : terminal.why;
  terminalButton.ariaLabel = label;
  aria(terminalButton, "disabled", why ? "true" : "false");
  terminalButton.title = said ?? (why ? `${label}: ${why}` : label);
}

async function loadTerminal() {
  if (inShell()) {
    try {
      terminal = await actions().terminalInfo();
    } catch {
      terminal = null;
    }
  }
  renderTerminal();
}

terminalButton.addEventListener("click", async () => {
  if (terminalButton.ariaDisabled === "true") return;
  const kinds = ["console", ...[...document.querySelectorAll(".filters input")].filter((box) => box.checked).map((box) => CONSOLE_KIND[box.dataset.kind]).filter(Boolean)];
  const project = chosen()?.project;
  const folder = project && project.exists !== false && !project.unavailable ? project.folder : null;
  try {
    // The console shows every app's lines: so does the terminal.
    await actions().openTerminal({ app: null, folder, kinds, since: consoleFrom });
    renderTerminal();
  } catch (e) {
    if (e?.code === "no_gesture") return renderTerminal("Click again");
    renderTerminal(e?.message ?? "Not opened");
    addLine({ kind: "warn", text: `${terminal?.label ?? "Open in a terminal"}: ${e?.message ?? "not opened"}`, time: Date.now() });
  }
});
renderTerminal();
loadTerminal();
addEventListener("load", loadTerminal);

// ---------------------------------------------------------------- events

function connect() {
  const events = new EventSource("/_emu/events");
  const link = $("#link");
  events.addEventListener("hello", (e) => {
    const { firmware, apiVersion } = JSON.parse(e.data);
    $("#firmware").textContent = `Firmware ${firmware.name}`;
    // What this firmware means for an app's author, and which build it is.
    $("#firmware").title = [firmware.summary, `Commit ${firmware.commit}`].filter(Boolean).join("\n");
    $("#api").textContent = `API ${apiVersion}`;
    link.textContent = "Connected";
    link.classList.add("live");
    consoleBox.replaceChildren();
    consoleFrom = null;
    renderErrors(0);
    renderBlank();
    loadApps();
    loadDevice();
    loadVolume();
    loadAccount();
  });
  events.addEventListener("frame", (e) => {
    const { front: f, back: b } = JSON.parse(e.data);
    frontPixels = decode(f);
    drawFront();
    drawBack(decode(b));
  });
  events.addEventListener("log", (e) => addLine(JSON.parse(e.data)));
  events.addEventListener("apps", loadApps);
  events.addEventListener("audio", (e) => onAudio(JSON.parse(e.data)));
  events.addEventListener("lights", (e) => renderLights(JSON.parse(e.data)));
  events.addEventListener("state", (e) => {
    const { running, selector, barSpeed, status } = JSON.parse(e.data);
    renderSpeed(barSpeed);
    renderStatus(status);
    renderRunning(running);
    renderSelector(selector);
    renderCapture(); // the canvas's tools name the running app
  });
  events.onerror = () => {
    link.textContent = "Not connected";
    link.classList.remove("live");
  };
}

// ---------------------------------------------------------------- the emulator's mark
// The mark is a file of its own (icons/emulator-logo.svg); the header shows it once it has loaded, and has no empty
// place for it before.
const logo = $("#logo");
const showLogo = () => (logo.hidden = !(logo.naturalWidth > 0));
if (logo.complete) showLogo();
else logo.addEventListener?.("load", showLogo);

// ---------------------------------------------------------------- layout-v2: the top bar

// The bar's volume, read when the page connects (the speaker's events say it after).
async function loadVolume() {
  try {
    const answer = await fetch("/api/audio/volume");
    if (answer.ok) renderVolume(Number((await answer.json())?.volume));
  } catch {
    // Not read: the speaker's next event says it.
  }
}

// Report a Bug: its dialog is a file of its own, which defines window.openReportBug; without it the button is not
// there.
const reportBug = $("#report-bug");
const renderReportBug = () => (reportBug.hidden = typeof globalThis.openReportBug !== "function");
reportBug.addEventListener("click", () => globalThis.openReportBug?.());
renderReportBug();
addEventListener("load", renderReportBug);
// The documentation links beside it: an anchor with target _blank, which the shell hands to the browser on the person's click.
$("#docs-emulator").href = "https://go.busy.app/busy-emulator-docs";
$("#docs-js-apps").href = "https://go.busy.app/js-apps";

// The GitHub account Publish sends with (github.status, which only reads): its first letter and its name, a menu with
// the way to its page and Sign out. Signed out, the button says so and opens Publish, where the sign-in is. In a
// browser, or a build without GitHub, it is not there.
const account = $("#account");
let accountSaid = null; // what github.status answered
async function loadAccount() {
  if (!inShell() || typeof actions().github?.status !== "function") return renderAccount();
  try {
    accountSaid = await actions().github.status();
  } catch {
    accountSaid = null;
  }
  renderAccount();
}
function renderAccount() {
  const said = accountSaid;
  account.hidden = !inShell() || !said?.configured;
  if (account.hidden) return;
  const login = said.signedIn && typeof said.login === "string" ? said.login : null;
  account.classList.toggle("signed-out", !login);
  const avatar = $("#account-avatar");
  if (login) avatar.textContent = login.charAt(0);
  else avatar.innerHTML = icon("user");
  $("#account-name").textContent = login ?? "Sign in";
  account.title = login ? `GitHub: ${login}` : "Not signed in to GitHub: you sign in when you publish";
  account.ariaLabel = account.title;
}
account.addEventListener("click", () => {
  if (!accountSaid?.signedIn) return openPublish();
  closeRowMenu({ refocus: false });
  const box = account.getBoundingClientRect();
  const el = make("div", "row-menu");
  el.setAttribute("role", "menu");
  const item = (label, picture, onPick) => {
    const one = button("menu-item", label, null, () => {
      el.remove();
      onPick();
    }, "", picture);
    one.setAttribute("role", "menuitem");
    return one;
  };
  const page = make("a", "menu-item");
  page.href = `https://github.com/${encodeURIComponent(accountSaid.login)}`;
  page.target = "_blank";
  page.rel = "noopener noreferrer";
  page.setAttribute("role", "menuitem");
  page.innerHTML = icon("open-in-new");
  page.append(make("span", "", "Open on GitHub"));
  page.addEventListener("click", () => el.remove());
  el.append(make("div", "menu-head", `Signed in as ${accountSaid.login}`), page, make("div", "menu-line"), item("Sign out", "logout", async () => {
    try {
      await actions().github.signOut();
    } catch {
      // Said by the next status.
    }
    loadAccount();
  }));
  document.body.append(el);
  const width = el.getBoundingClientRect().width;
  el.style.left = `${Math.max(8, box.right - width)}px`;
  el.style.top = `${box.bottom + 6}px`;
  el.tabIndex = -1;
  el.focus({ preventScroll: true });
  const close = (e) => {
    if (e.type === "keydown" ? e.key !== "Escape" : el.contains(e.target)) return;
    el.remove();
    removeEventListener("pointerdown", close, true);
    removeEventListener("keydown", close, true);
  };
  addEventListener("pointerdown", close, true);
  addEventListener("keydown", close, true);
});
// Publishing may have signed in or out.
addEventListener("publish-closed", loadAccount);
addEventListener("focus", loadAccount);

// ---------------------------------------------------------------- a new version
// The desktop app tells the page of a newer version in the address's fragment: #update=<version>. The page shows one
// line with a link; the link asks for a new window, and the app gives its address to the user's browser.
//
// Anyone can write a fragment: a link on any web page can open this page with one. So the page takes nothing from it
// but the version, and only one written as a version is: three numbers, then an optional pre-release of letters,
// digits, dots and hyphens ("0.1.0-beta.2"; the app itself may be one, and so may the release it names). The link is
// built here, to that version's page among the emulator's own releases, and never taken from the address.
const RELEASES = "https://github.com/busy-app/busybar-emulator/releases/tag/";
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/;

// The built-in update (EMU-221; packages/app/src/updater.mjs) comes from the app itself, not from the address: its
// state through emulatorActions.update. Where the app can install the new version, the line is a button: Update to
// <version>, then a bar while it downloads and is checked, then Restart to update (the app asks once more in a
// dialog). Where it cannot (a browser, the disk image, a folder it may not write to), the line stays the link to the
// download page, and its tooltip says why.
let updateState = null;

function renderUpdate() {
  const told = new URLSearchParams((location.hash ?? "").slice(1)).get("update") ?? "";
  // The app's update state decides once it can install, or once it has done something (a download, a failure);
  // otherwise the address's notice does, as before.
  const s = updateState && updateState.state !== "none" && VERSION.test(updateState.version ?? "") && (updateState.canInstall || updateState.state !== "available") ? updateState : null;
  const why = updateState && updateState.canInstall === false && updateState.why ? updateState.why : null;
  const version = s ? s.version : told;
  const show = VERSION.test(version);
  $("#update-note").hidden = !show;
  if (!show) return;
  const link = $("#update-link");
  const go = $("#update-go");
  const progress = $("#update-progress");
  $("#update-version").textContent = version;
  link.href = `${RELEASES}v${version}`;
  const installing = s && s.canInstall;
  const working = installing && ["downloading", "preparing", "restarting"].includes(s.state);
  link.hidden = Boolean(installing && s.state !== "failed");
  link.title = why ? `Version ${version} is available. ${why} Open its download page.` : s?.state === "failed" ? `${s.message ?? "The update failed."} ${s.hint ?? ""} Open the download page.`.trim() : "A newer version of the emulator is available: open its download page";
  go.hidden = !installing || working;
  progress.hidden = !working;
  if (installing && !working) {
    const ready = s.state === "ready";
    $("#update-go-icon").setAttribute("href", `/emulator/icons/busy-sprite.svg#${ready ? "bi-cycles-arrow" : "bi-download"}`);
    $("#update-go-text").replaceChildren(...(ready ? [document.createTextNode("Restart to update")] : [document.createTextNode(s.state === "failed" ? "Try again: " : "Update to "), make("b", "", version)]));
    go.title = ready ? `Version ${version} is downloaded and checked: restart the emulator to install it` : s.state === "failed" ? `${s.message ?? "The update failed."} ${s.hint ?? ""}`.trim() : `Download version ${version} from GitHub and check its signature; nothing is installed before you restart`;
  }
  if (working) {
    const percent = s.state === "downloading" && s.total ? Math.min(100, Math.floor((100 * s.received) / s.total)) : null;
    $("#update-fill").style.width = `${s.state === "downloading" ? (percent ?? 0) : 100}%`;
    progress.setAttribute("aria-valuenow", String(percent ?? 100));
    $("#update-progress-text").textContent = s.state === "downloading" ? `Downloading ${version}${percent === null ? "" : `, ${percent}%`}` : s.state === "preparing" ? `Checking ${version}` : "Restarting";
  }
}
addEventListener("hashchange", renderUpdate);
renderUpdate();

$("#update-go").addEventListener("click", async () => {
  const update = actions()?.update;
  if (!update) return;
  try {
    updateState = updateState?.state === "ready" ? await update.restart() : await update.download();
  } catch {
    // Said by the app (a dialog), or nothing to do: the state below is the truth.
  }
  try {
    updateState = await update.state();
  } catch {
    // The app is going away (restarting).
  }
  renderUpdate();
});

if (actions()?.available().shell && actions().update) {
  try {
    actions().on("update", (state) => {
      updateState = state;
      renderUpdate();
    });
  } catch {
    // An older contract without the update's news: the state below is read once.
  }
  actions()
    .update.state()
    .then((state) => {
      updateState = state;
      renderUpdate();
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- the canvas's tools: Screenshot and Record
// Both are the desktop app's (emulatorActions.capture; packages/app/src/capture-actions.mjs). Screenshot (shot-float
// below) saves what the ticked displays show into the running app's project, screenshots/front-<n>.png and
// back-<n>.png (the files Publish takes), or, for an app without a project, where the person says in the Save dialog.
// Record (record-menu below): the first press asks what to record (the window, a clip for a post, the front display)
// and starts; the button turns red and counts; the second press stops, and the Save dialog asks where the video goes.
// A recording stops by itself at its longest. In a browser neither is there, and the tooltips say so.

// Record is shown (the owner, 12.11), beside the camera in the top bar: the button, its state from the desktop app and
// its news go with this flag.
const RECORD_BUTTON = true;

const shotButton = $("#shot-take");
const recordButton = $("#capture-record");
const recordTime = $("#capture-time");
const captureToast = $("#capture-toast");
const captureSaid = $("#capture-said");
const captureReveal = $("#capture-reveal");
const capture = { shooting: false, starting: false, recording: false, saving: false, startedAt: 0, maxSeconds: 120, tick: null, toast: null, file: null };
let recordMenu = null; // the open menu of what Record records (record-menu below): { el }
$("#capture-tools").hidden = !RECORD_BUTTON;

// ---- shot-float: the Screenshot module at the canvas's top left. Two ticks, Front and Back, say which displays a
// screenshot takes; both at first, and never neither: the only one ticked stays ticked. The window remembers them
// (localStorage: across restarts of the app too). Cmd+Shift+S (Ctrl+Shift+S on Windows) takes one as the button does.
const SHOT_DISPLAYS = ["front", "back"];
const SHOT_KEY = "busy-emulator.screenshot-displays";
const SHOT_KEYS = /mac/i.test(globalThis.navigator?.platform ?? "") ? "\u2318\u21e7S" : "Ctrl+Shift+S";
const shotTicks = { front: $("#shot-front"), back: $("#shot-back") };
const shotTickLabels = { front: $("#shot-front-tick"), back: $("#shot-back-tick") };
const SHOT_TICK_TITLES = { front: "The front display, 72\u00d716", back: "The back display, 160\u00d780" };

/** The displays ticked, front then back. */
function shotDisplays() {
  return SHOT_DISPLAYS.filter((one) => shotTicks[one].checked);
}

function renderShotTicks() {
  const ticked = shotDisplays();
  for (const one of SHOT_DISPLAYS) {
    const last = ticked.length === 1 && ticked[0] === one;
    shotTickLabels[one].classList.toggle("last", last);
    shotTickLabels[one].title = last ? `${SHOT_TICK_TITLES[one]}. At least one display is taken` : SHOT_TICK_TITLES[one];
  }
}

function loadShotDisplays() {
  let kept = null;
  try {
    kept = JSON.parse(localStorage.getItem(SHOT_KEY) ?? "null");
  } catch {
    // Nothing kept, or not readable: both.
  }
  const valid = Array.isArray(kept) && kept.length > 0 && kept.every((one) => SHOT_DISPLAYS.includes(one));
  for (const one of SHOT_DISPLAYS) shotTicks[one].checked = valid ? kept.includes(one) : true;
  renderShotTicks();
}

for (const one of SHOT_DISPLAYS) {
  shotTicks[one].addEventListener("change", () => {
    if (!shotDisplays().length) shotTicks[one].checked = true;
    try {
      localStorage.setItem(SHOT_KEY, JSON.stringify(shotDisplays()));
    } catch {
      // Not remembered: this window still takes what is ticked.
    }
    renderShotTicks();
    renderCapture();
  });
}
loadShotDisplays();

/** What the ticks take, in words for the tooltip. */
function shotWhat() {
  const ticked = shotDisplays();
  return ticked.length === 2 ? "both displays" : `the ${ticked[0]} display`;
}

// The pictures in the toast: what the displays showed at the press, drawn from the frames the window has (the front's
// pixels, BGR; the back's canvas), so that they are there in 3D too.
const shotThumbs = $("#shot-thumbs");
const shotThumbCanvas = { front: $("#shot-thumb-front"), back: $("#shot-thumb-back") };
function snapShotThumbs(displays) {
  for (const one of SHOT_DISPLAYS) {
    const canvas = shotThumbCanvas[one];
    canvas.hidden = !displays.includes(one);
    if (canvas.hidden) continue;
    const ctx = canvas.getContext("2d");
    if (one === "back") {
      ctx.drawImage($("#back"), 0, 0);
      continue;
    }
    const image = ctx.createImageData(FRONT.width, FRONT.height);
    for (let i = 0; i < FRONT.width * FRONT.height; i++) image.data.set([frontPixels[i * 3 + 2], frontPixels[i * 3 + 1], frontPixels[i * 3], 255], i * 4);
    ctx.putImageData(image, 0, 0);
  }
}

/** The running app, as the tools name it: its project's folder (null when it has none) and its name. */
function captureTarget() {
  const project = runningId === null ? null : (projects.find((p) => p.id === runningId && p.exists !== false && !p.unavailable) ?? null);
  const row = runningId === null ? null : rows().find((one) => one.id === runningId);
  return { folder: project?.folder ?? null, name: project?.name ?? row?.name ?? runningId ?? null };
}

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const minutes = (seconds) => (seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`);

function renderCapture() {
  const shell = inShell();
  const target = captureTarget();
  aria(shotButton, "disabled", shell && !capture.shooting ? "false" : "true");
  shotButton.classList.toggle("working", capture.shooting);
  shotButton.title = !shell ? NEEDS_APP : capture.shooting ? "Taking the screenshot" : `${target.folder ? `Screenshot of ${shotWhat()}, saved in the screenshots folder of ${target.name}` : `Screenshot of ${shotWhat()}: choose where to save it`} (${SHOT_KEYS})`;
  if (!RECORD_BUTTON) return;
  aria(recordButton, "disabled", shell && !capture.saving ? "false" : "true");
  aria(recordButton, "pressed", String(capture.recording));
  recordButton.classList.toggle("recording", capture.recording || capture.saving);
  recordButton.classList.toggle("saving", capture.saving);
  recordButton.innerHTML = icon(capture.recording || capture.saving ? "control-stop" : "video");
  recordButton.append(recordTime);
  recordTime.hidden = !(capture.recording || capture.saving);
  recordButton.ariaLabel = capture.recording ? "Stop recording" : "Record";
  recordButton.ariaHasPopup = capture.recording || capture.saving ? null : "menu";
  recordButton.ariaExpanded = capture.recording || capture.saving ? null : String(recordMenu !== null);
  recordButton.title = !shell ? NEEDS_APP : capture.saving ? "Saving the recording" : capture.recording ? "Stop recording and save the video" : `Record a video, up to ${minutes(capture.maxSeconds)}`;
}

function renderRecordTime() {
  if (!capture.recording) return;
  const seconds = Math.max(0, (performance.now() - capture.startedAt) / 1000);
  recordTime.textContent = clock(Math.min(seconds, capture.maxSeconds));
  capture.tick = setTimeout(renderRecordTime, 250);
}

/** One line under the Screenshot module for a few seconds; with a file, the way to it in Finder or Explorer; with
    pictures, the ones just saved. */
function captureNotice(text, { file = null, failed = false, pictures = false } = {}) {
  clearTimeout(capture.toast);
  shotThumbs.hidden = !pictures;
  capture.file = file;
  captureSaid.textContent = text;
  captureToast.classList.toggle("failed", failed);
  captureReveal.textContent = `Show in ${FILE_MANAGER}`;
  captureReveal.hidden = !file;
  captureToast.hidden = false;
  capture.toast = setTimeout(() => (captureToast.hidden = true), file ? 8000 : 6000);
}

/** What the desktop app answered when it refused or failed: its message, or "Click again" for a click that came late. */
function captureFailed(e) {
  if (e?.code === NO_GESTURE) return captureNotice("Click again");
  captureNotice([e?.message || "It did not work.", windowHint(e?.hint)].filter(Boolean).join(" "), { failed: true });
}

// The tooltips name the running app as it is when the pointer comes.
shotButton.addEventListener("pointerenter", renderCapture);
recordButton.addEventListener("pointerenter", renderCapture);

/** The ticked displays of the running app, saved; the toast shows them and says where they went. */
async function takeScreenshot() {
  if (!inShell() || capture.shooting) return;
  const displays = shotDisplays();
  capture.shooting = true;
  renderCapture();
  snapShotThumbs(displays);
  try {
    const answer = await actions().capture.screenshot({ ...captureTarget(), displays });
    if (!answer?.ok) captureFailed(answer);
    else if (answer.saved.length) {
      // The pictures are those of the press; only the displays that were saved stay.
      for (const one of SHOT_DISPLAYS) shotThumbCanvas[one].hidden ||= !answer.saved.some((shot) => shot.display === one);
      captureNotice(answer.message, { file: answer.saved[0].file, pictures: true });
    }
  } catch (e) {
    captureFailed(e);
  } finally {
    capture.shooting = false;
    renderCapture();
  }
}
shotButton.addEventListener("click", takeScreenshot);
// The shortcut, wherever the focus is: Cmd+Shift+S, or Ctrl+Shift+S on Windows.
addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || (e.key ?? "").toLowerCase() !== "s" || e.repeat) return;
  e.preventDefault();
  takeScreenshot();
});

function recordingStarted(startedAt = performance.now()) {
  capture.recording = true;
  capture.saving = false;
  capture.startedAt = startedAt;
  clearTimeout(capture.tick);
  renderCapture();
  renderRecordTime();
}

function recordingEnded() {
  capture.recording = false;
  capture.saving = false;
  clearTimeout(capture.tick);
  recordTime.textContent = "0:00";
  renderCapture();
}

/** The take's end as the desktop app tells it: saved where the person chose, discarded, failed. */
function recordingOutcome(answer) {
  recordingEnded();
  if (!answer) return;
  if (answer.ok === false) return captureFailed(answer);
  // Instagram takes a Reel of 3 s or more: a shorter video is said to be short.
  const short = typeof answer.seconds === "number" && answer.seconds < 3 ? ". Under 3 s: too short for Instagram" : "";
  if (answer.file) captureNotice(`${answer.limit ? `Stopped at ${minutes(capture.maxSeconds)}. ` : ""}Saved ${answer.name ?? answer.file}${short}`, { file: answer.file });
  else if (!answer.discarded) captureNotice("The recording was not saved");
}

// ---- record-menu: what Record records, asked at its first press. A small card under the button, wherever the top
// bar puts it: the window as the person sees it; a clip for a post, upright; the front display alone. The last one
// chosen is kept (localStorage) and has the focus when the menu opens. The texts are the sizes the clips have.
const RECORD_CHOICES = [
  { layout: "window", label: "Window", picture: "laptop", about: "The window as you see it, at most 1920\u00d71080" },
  { layout: "post", label: "Post, 1080\u00d71920", picture: "phone", about: "Upright, for Reels, TikTok and X: the BUSY Bar, its back display and the app's name" },
  { layout: "front", label: "Front display", picture: "busy-bar", about: "The front display alone, 1080\u00d7240, for a page or a README" },
];
const RECORD_KEY = "busy-emulator.record-layout";

function lastRecordLayout() {
  try {
    const kept = localStorage.getItem(RECORD_KEY);
    if (RECORD_CHOICES.some((one) => one.layout === kept)) return kept;
  } catch {
    // Not readable: the window.
  }
  return "window";
}

function closeRecordMenu({ refocus = true } = {}) {
  if (!recordMenu) return;
  recordMenu.el.remove();
  recordMenu = null;
  renderCapture();
  if (refocus) recordButton.focus({ preventScroll: true });
}

function openRecordMenu() {
  closeRecordMenu({ refocus: false });
  const el = make("div", "row-menu record-menu");
  el.id = "record-menu";
  el.setAttribute("role", "menu");
  el.ariaLabel = "Record";
  const last = lastRecordLayout();
  const items = RECORD_CHOICES.map((choice) => {
    const item = button("menu-item", choice.label, null, () => {
      try {
        localStorage.setItem(RECORD_KEY, choice.layout);
      } catch {
        // Not remembered: it records all the same.
      }
      closeRecordMenu();
      startRecording(choice.layout);
    }, choice.about, choice.picture);
    item.setAttribute("role", "menuitem");
    item.dataset.layout = choice.layout;
    item.tabIndex = -1;
    return item;
  });
  el.append(...items);
  document.body.append(el);
  // Under the button, its right edge at the button's, inside the window.
  const at = recordButton.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(at.right - box.width, innerWidth - box.width - 8))}px`;
  el.style.top = `${at.bottom + 6 + box.height + 8 > innerHeight ? Math.max(8, at.top - box.height - 6) : at.bottom + 6}px`;
  recordMenu = { el };
  el.addEventListener("keydown", (e) => {
    e.stopPropagation(); // the bar's own keys are not pressed from inside the menu
    const at = items.indexOf(document.activeElement);
    if (e.key === "Escape" || e.key === "Tab") closeRecordMenu();
    else if (e.key === "ArrowDown") items[(at + 1) % items.length].focus();
    else if (e.key === "ArrowUp") items[(at - 1 + items.length) % items.length].focus();
    else if (e.key === "Home") items[0].focus();
    else if (e.key === "End") items.at(-1).focus();
    else return;
    e.preventDefault();
  });
  (items.find((item) => item.dataset.layout === last) ?? items[0]).focus({ preventScroll: true });
  renderCapture();
}

addEventListener(
  "pointerdown",
  (e) => {
    if (!recordMenu || recordMenu.el.contains(e.target) || recordButton.contains(e.target)) return;
    closeRecordMenu({ refocus: false });
  },
  true,
);
addEventListener("resize", () => closeRecordMenu({ refocus: false }));
addEventListener("blur", () => closeRecordMenu({ refocus: false }));

/** Starts a recording of the layout chosen in the menu. */
async function startRecording(layout) {
  if (!inShell() || capture.recording || capture.saving || capture.starting) return;
  capture.starting = true;
  recordButton.classList.add("working");
  try {
    const answer = await actions().capture.record.start({ ...captureTarget(), layout });
    if (!answer?.ok) return captureFailed(answer);
    capture.maxSeconds = answer.maxSeconds ?? capture.maxSeconds;
    recordingStarted();
  } catch (e) {
    captureFailed(e);
  } finally {
    capture.starting = false;
    recordButton.classList.remove("working");
  }
}

recordButton.addEventListener("click", async () => {
  if (!inShell() || capture.saving || capture.starting) return;
  if (!capture.recording) {
    if (recordMenu) closeRecordMenu();
    else openRecordMenu();
    return;
  }
  capture.recording = false;
  capture.saving = true;
  renderCapture();
  try {
    recordingOutcome(await actions().capture.record.stop());
  } catch (e) {
    recordingEnded();
    captureFailed(e);
  }
});

captureReveal.addEventListener("click", async () => {
  if (!capture.file) return;
  try {
    await actions().capture.reveal(capture.file);
  } catch (e) {
    captureFailed(e);
  }
});

// What the recording does by itself: it stops at its longest and asks where it goes; a take of another load of this
// page (the page was reloaded while it recorded) is shown as it stands.
function onCapture(event) {
  if (event?.kind !== "recording") return;
  if (event.state === "recording" && !capture.recording) {
    closeRecordMenu({ refocus: false });
    capture.maxSeconds = event.maxSeconds ?? capture.maxSeconds;
    recordingStarted(performance.now() - Math.max(0, Date.now() - (event.startedAt ?? Date.now())));
  } else if (event.state === "saving") {
    capture.recording = false;
    capture.saving = true;
    clearTimeout(capture.tick);
    if (event.reason === "limit") recordTime.textContent = clock(capture.maxSeconds);
    renderCapture();
  } else if (event.state === "saved" || event.state === "discarded" || event.state === "failed") {
    // The press that stopped it says the outcome itself; a take that stopped by itself is said here.
    if (!capture.saving && !capture.recording) return;
    if (event.state === "failed") recordingOutcome({ ok: false, code: "record_failed", message: event.message, hint: event.hint ?? null });
    else recordingOutcome(event.state === "saved" ? { ok: true, file: event.file, name: event.name, seconds: event.seconds, limit: event.limit } : { ok: true, file: null });
  }
}

if (RECORD_BUTTON && inShell()) {
  try {
    actions().on("capture", onCapture);
    actions()
      .capture.record.state()
      .then((state) => {
        capture.maxSeconds = state?.maxSeconds ?? capture.maxSeconds;
        if (state?.recording && !state.saving) onCapture({ kind: "recording", state: "recording", startedAt: state.startedAt, maxSeconds: state.maxSeconds });
        else renderCapture();
      })
      .catch(() => {});
  } catch {
    // An older desktop app without the tools: the buttons say what they can.
  }
}
renderCapture();

connect();
