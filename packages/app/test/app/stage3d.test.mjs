// The 3D view of the bar in the shell's device window: a sandboxed frame with the Tride player (packages/stage),
// mounted by legacy-window/stage3d/mount.js. The shell's own rules hold for it as for every page: the frame comes
// from the server's address, asks for nothing else, and has no rights.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { sleep, until } from "../helpers.mjs";
import { HAS_REAL_SERVER, launch } from "./harness.mjs";

const skipAll = !HAS_REAL_SERVER && "the server is not beside this package";
let app;
let webgl = false;
// Animation frames a second in the window's page. Windows draws no frames for a window that is never shown (a hidden
// run): the page gets one a second or none, while a shown window, or any window on macOS, gets 60. The view's
// flights, its resizes (ResizeObserver) and so its picks wait for frames; without them the tests below that need
// them are skipped, saying so. Measured on the Windows test machine, 11.11: 1 hidden, 60 shown.
let frames = Infinity;
const stalled = () =>
  frames < 20 &&
  `this hidden window gets ${frames} animation frames a second (Windows draws none for a window that is never shown): the view's flights and resizes wait for them; BUSY_EMULATOR_TEST_VISIBLE=1 runs this test`;

before(async () => {
  if (skipAll) return;
  // The first run's greeting answered: the test clicks on the model behind it.
  app = await launch({ server: "real", welcomed: true });
  await app.waitWindow("device");
  frames = await app.page("new Promise((done) => { let n = 0; const count = () => { n++; requestAnimationFrame(count); }; requestAnimationFrame(count); setTimeout(() => done(n), 1000); })");
  // What Chromium says about every frame of the window: a refusal by a page's policy is a line of the console.
  await app.run((shell) => {
    const lines = (globalThis.stage3dConsole = []);
    shell.windows.current.win.webContents.on("console-message", (event) => {
      const text = String(event.message ?? "");
      if (/Refused to|Content Security Policy|violates the following/i.test(text)) lines.push(text.slice(0, 300));
    });
  });
});
after(() => app?.close());

const reload = async () => {
  await app.run((shell) => shell.windows.current.win.webContents.reload());
  await until(() => app.page("document.readyState === 'complete' && typeof window.emulatorStage3D === 'object'").catch(() => false), "the device window after a reload");
};
// Mounts the view where the bar's picture is, the picture's own parts hidden, as the window's 2D / 3D switch does.
const MOUNT = `(async () => {
  const box = document.querySelector("#bar");
  for (const child of box.children) child.style.display = "none";
  try { await window.emulatorStage3D.mount(box); return "mounted"; } catch (e) { return "failed: " + e.message; }
})()`;
const frameBox = () =>
  app.page(`(() => { const r = document.querySelector("iframe.stage3d").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
const probe = () => app.page("window.emulatorStage3D.ask({ type: 'probe' })");
/**
 * The mouse as the browser's own input pipeline routes it, into the frame's process, at a point of the window's page.
 * (webContents.sendInputEvent gives an event to the window's own page only: a frame in another process, as a
 * sandboxed one is, never gets it.)
 */
const mouse = (type, x, y, extra = {}) =>
  app.run(
    async (shell, _electron, event) => {
      const { debugger: dbg } = shell.windows.current.win.webContents;
      if (!dbg.isAttached()) dbg.attach("1.3");
      await dbg.sendCommand("Input.dispatchMouseEvent", event);
    },
    { type, x: Math.round(x), y: Math.round(y), button: type === "mouseMoved" || type === "mouseWheel" ? "none" : "left", buttons: 0, clickCount: 0, ...extra },
  );
const detachMouse = () => app.run((shell) => shell.windows.current.win.webContents.debugger.isAttached() && shell.windows.current.win.webContents.debugger.detach());
/** A drag with the left button from (x, y) by (dx, dy), in steps, at points of the window's page. */
async function drag(x, y, dx, dy, steps = 12) {
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, { buttons: 1, clickCount: 1 });
  for (let k = 1; k <= steps; k++) await mouse("mouseMoved", x + (dx * k) / steps, y + (dy * k) / steps, { button: "left", buttons: 1 });
  await mouse("mouseReleased", x + dx, y + dy, { clickCount: 1 });
}
/** A point of the frame, in its own pixels, where the bar is not: the background. */
async function background() {
  const box = await frameBox();
  for (const [x, y] of [[box.width / 2, 12], [12, 12], [box.width - 12, 12], [12, box.height - 48], [box.width - 80, box.height - 48]]) {
    // Not under the window's own tools over the canvas (the Screenshot module floats at its top left, the dock of the
    // controls is at the bottom in the middle), and with room in the frame for the tests' short drags (60 by 30 pixels)
    // from there. Near the top first: a test drags 400 pixels down from there.
    const free = await app.page(`[[0, 0], [60, 30]].every(([dx, dy]) => document.elementFromPoint(${box.x + x} + dx, ${box.y + y} + dy)?.tagName === "IFRAME")`);
    if (!free) continue;
    const { bar } = await app.page(`window.emulatorStage3D.ask({ type: "pick", x: ${x}, y: ${y} })`);
    if (!bar) return { x: box.x + x, y: box.y + y };
  }
  throw new Error("no background beside the bar");
}
const near = (a, b, within) => Math.abs(a - b) <= within;

test("without WebGL2 the view says it is not available, and the flat view stays", { skip: skipAll }, async () => {
  await reload();
  const answer = await app.page(`(async () => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...rest) { return kind === "webgl2" ? null : real.call(this, kind, ...rest); };
    try {
      return { available: await window.emulatorStage3D.available(), reason: window.emulatorStage3D.reason, mounted: window.emulatorStage3D.mounted,
        frames: document.querySelectorAll("iframe").length, flat: getComputedStyle(document.querySelector("#front")).display !== "none" };
    } finally { HTMLCanvasElement.prototype.getContext = real; }
  })()`);
  assert.deepEqual(answer, { available: false, reason: "3D view needs WebGL2", mounted: false, frames: 0, flat: true });
  await reload();
});

test("the view mounts: the bar is drawn, and the frame's policy refused nothing", { skip: skipAll }, async (t) => {
  webgl = await app.page("window.emulatorStage3D.available()");
  if (!webgl) return t.skip(`no WebGL2 in this run's hidden window: ${await app.page("window.emulatorStage3D.reason")}`);
  assert.equal(await app.page(MOUNT), "mounted");
  const frame = await app.page(`(() => { const f = document.querySelector("iframe.stage3d"); return { sandbox: f.getAttribute("sandbox"), src: new URL(f.src).pathname, reachable: (() => { try { return f.contentDocument !== null; } catch { return false; } })() }; })()`);
  assert.deepEqual(frame, { sandbox: "allow-scripts", src: "/emulator/stage3d/frame/stage.html", reachable: false });
  const seen = await app.page("window.emulatorStage3D.ask({ type: 'probe' })");
  assert.equal(seen.ready, true);
  assert.ok(seen.lit > 0.02, `something is drawn: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen.problems, [], "the player and the frame's policy reported no problem");
  assert.deepEqual(await app.page("window.emulatorStage3D.problems"), []);
  assert.deepEqual(await app.run(() => globalThis.stage3dConsole), [], "no page's policy refused anything");
  assert.doesNotMatch(app.log(), /refused a (request|navigation|permission)/, "the shell refused nothing of the view");
});

test("the camera's views: each one flies there, and the bar is in the middle of the frame and fills it", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  if (stalled()) return t.skip(stalled());
  for (const view of ["back", "top", "side", "front"]) {
    await app.page(`window.emulatorStage3D.camera(${JSON.stringify(view)})`);
    assert.equal(await app.page("window.emulatorStage3D.view"), view);
    // The flight is under a second; the probe names the view once the camera is there.
    let seen;
    await until(async () => (seen = await app.page("window.emulatorStage3D.ask({ type: 'probe' })")).view === view, `the camera at ${view}`);
    await sleep(400);
    seen = await app.page("window.emulatorStage3D.ask({ type: 'probe' })");
    const { left, right, top, bottom } = seen.bounds;
    const where = `${view}: ${JSON.stringify(seen.bounds)}`;
    assert.ok(Math.abs((left + right) / 2 - 0.5) < 0.04 && Math.abs((top + bottom) / 2 - 0.5) < 0.06, `in the middle, ${where}`);
    // About two thirds of the frame one way (stage.js VIEW.fill 0.67), with room round it.
    const most = Math.max(right - left, bottom - top);
    assert.ok(most > 0.6 && most < 0.75, `takes about two thirds of the frame, ${where}`);
    assert.ok(left > 0.02 && right < 0.98 && top > 0.02 && bottom < 0.98, `and is not cut, ${where}`);
  }
});

test("a frame posted to the view changes the picture on the bar's front display", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  if (stalled()) return t.skip(stalled());
  // The bar seen from the front, so that its display takes most of the picture.
  await app.page("window.emulatorStage3D.look(0, 0)");
  await sleep(1500);
  const paint = (b, g, r) =>
    app.page(`(() => { const front = new Uint8Array(72 * 16 * 3); for (let i = 0; i < front.length; i += 3) { front[i] = ${b}; front[i + 1] = ${g}; front[i + 2] = ${r}; }
      document.querySelector("iframe.stage3d").contentWindow.postMessage({ type: "frame", front: front.buffer }, "*"); })()`);
  await paint(0, 0, 0);
  const dark = await app.page("window.emulatorStage3D.ask({ type: 'probe' })");
  await paint(0, 0, 255);
  const red = await app.page("window.emulatorStage3D.ask({ type: 'probe' })");
  await paint(255, 0, 0);
  const blue = await app.page("window.emulatorStage3D.ask({ type: 'probe' })");
  const [r0, , b0] = dark.mean;
  assert.ok(red.mean[0] > r0 + 25 && red.mean[0] > red.mean[2] * 1.5, `red LEDs make the picture redder: ${JSON.stringify({ dark: dark.mean, red: red.mean })}`);
  assert.ok(blue.mean[2] > b0 + 25 && blue.mean[2] > blue.mean[0] * 1.5, `blue LEDs make it bluer: ${JSON.stringify({ dark: dark.mean, blue: blue.mean })}`);
});

test("the RGB LEDs at the ends of Start follow the state the page gives: the hue in linear RGB, a level as the eye sees it, the presets in time", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  // From above: the LEDs are in slots of the top, as on the bar; from the front they do not show.
  await app.page(`window.emulatorStage3D.look(0, ${Math.PI / 2})`);
  await sleep(800);
  const tell = (lights) => app.page(`document.querySelector("iframe.stage3d").contentWindow.postMessage(${JSON.stringify({ type: "lights", ...lights })}, "*")`);
  const inputs = async () => (await probe()).lights;
  const both = (color, level) => ({ led_left: color, led_left_level: level, led_right: color, led_right_level: level });
  const off = both([0, 0, 0], 0);
  assert.deepEqual(await inputs(), off, "dark at first");
  // How red and how blue the picture is: the sum over its pixels of how far red is over blue, and blue over red.
  const tint = () =>
    app.page(`window.emulatorStage3D.ask({ type: "probe", full: true }).then(({ pixels }) => {
      let red = 0, blue = 0;
      for (let i = 0; i < pixels.length; i += 4) { red += Math.max(0, pixels[i] - pixels[i + 2]); blue += Math.max(0, pixels[i + 2] - pixels[i]); }
      return { red, blue };
    })`);
  // The picture once it holds still: the camera's flight to the top and a new color can take more than a few frames
  // in a hidden window (on Windows its frames come slowly), so the tint is read until two readings agree.
  const settled = async () => {
    let last = await tint();
    for (let i = 0; i < 24; i++) {
      await sleep(250);
      const now = await tint();
      if (now.red === last.red && now.blue === last.blue) return now;
      last = now;
    }
    return last;
  };
  const dark = await settled();
  await tell({ preset: "static", color: "#ff0000", brightness: 1 });
  await sleep(200);
  assert.deepEqual(await inputs(), both([1, 0, 0], 1));
  const red = await settled();
  await tell({ preset: "static", color: "#0000FF", brightness: 0.5 });
  await sleep(200);
  assert.deepEqual(await inputs(), both([0, 0, 1], 1), "a real LED at a quarter of its PWM looks fully lit");
  const blue = await settled();
  // The BUSY timer's red (150, 0, 0) at the default brightness: its hue at full strength, fully lit; at the lowest
  // brightness still at about half.
  await tell({ preset: "static", color: "#960000", brightness: 0.48 });
  await sleep(100);
  assert.deepEqual(await inputs(), both([1, 0, 0], 1));
  await tell({ preset: "static", color: "#960000", brightness: 0.05 });
  await sleep(100);
  assert.deepEqual(await inputs(), both([1, 0, 0], 0.4499));
  // The hue's sRGB bytes are linear for the scene: 128 of 255 is about a fifth.
  await tell({ preset: "static", color: "#ff8000", brightness: 1 });
  await sleep(100);
  const orange = await inputs();
  assert.ok(near(orange.led_left[1], 0.2195, 0.002) && orange.led_left[0] === 1 && orange.led_left_level === 1, JSON.stringify(orange));
  // Lit red makes the picture from above redder than dark; blue, bluer.
  const tints = JSON.stringify({ dark, red, blue });
  assert.ok(red.red > dark.red * 1.05 + 500, `red: ${tints}`);
  assert.ok(blue.blue > dark.blue * 1.05 + 500 && blue.blue > red.blue, `blue: ${tints}`);
  // A notification: three blinks at full brightness, half a second on and half off, then dark.
  await tell({ preset: "notification", color: "#00ff00", brightness: 0.2 });
  await sleep(150);
  assert.deepEqual(await inputs(), both([0, 1, 0], 1), "on at once, at full brightness");
  await sleep(500);
  assert.deepEqual(await inputs(), off, "then off for half a second");
  await sleep(2700);
  assert.deepEqual(await inputs(), off, "and dark after the third blink");
  // Black, off, or what is not a state: dark.
  for (const lights of [{ preset: "static", color: "#000000" }, { preset: "off", color: "#ff0000" }, { preset: "lava", color: "#ff0000" }]) {
    await tell(lights);
    await sleep(100);
    assert.deepEqual(await inputs(), off, JSON.stringify(lights));
  }
  assert.deepEqual((await probe()).problems, []);
});

test("a click on Start on the model reaches the bar as the Start key", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  if (stalled()) return t.skip(stalled());
  // From above the controls are large; the bar's own stream of key events says what it received.
  await app.page("window.emulatorStage3D.look(0, 0.9)");
  await sleep(1500);
  await app.page(`(() => { window.barKeys = []; const events = (window.barKeyEvents = new EventSource("/_emu/events")); events.addEventListener("key", (e) => window.barKeys.push(JSON.parse(e.data))); })()`);
  const box = await frameBox();
  const found = await app.page(`(async () => {
    const out = {};
    for (let y = 8; y < ${box.height}; y += 8) for (let x = 8; x < ${box.width}; x += 8) {
      const { control } = await window.emulatorStage3D.ask({ type: "pick", x, y });
      if (control) (out[control] ??= []).push([x, y]);
    }
    return out;
  })()`);
  for (const control of ["start", "back", "wheel", "switch"]) assert.ok(found[control]?.length, `the ${control} is on the model, under the pointer somewhere: ${JSON.stringify(Object.keys(found))}`);
  // The middle of the points that hit Start.
  const [px, py] = found.start[Math.floor(found.start.length / 2)];
  const at = { x: Math.round(box.x + px), y: Math.round(box.y + py) };
  // The pointer as the browser's own input pipeline routes it, into the frame's process. (webContents.sendInputEvent
  // gives an event to the window's own page only: a frame in another process, as a sandboxed one is, never gets it.)
  const camera = (await probe()).camera;
  await mouse("mouseMoved", at.x, at.y);
  await mouse("mousePressed", at.x, at.y, { buttons: 1, clickCount: 1 });
  await until(() => app.page("window.barKeys.some((k) => k.key === 'start' && k.type === 'press')"), "the bar's Start going down");
  assert.equal(await app.page("window.barKeys.some((k) => k.key === 'start' && k.type === 'release')"), false, "held while the pointer is down");
  await mouse("mouseReleased", at.x, at.y, { clickCount: 1 });
  await until(() => app.page("window.barKeys.some((k) => k.key === 'start' && k.type === 'release')"), "the bar's Start coming up");
  await detachMouse();
  assert.deepEqual((await probe()).camera, camera, "a press on a control does not turn the bar");
  assert.deepEqual(await app.page("window.barKeys.filter((k) => k.key !== 'start').map((k) => k.key)"), [], "nothing but Start was pressed");
  await app.page("window.barKeyEvents.close()");
});

test("a drag round the wheel on the model turns it as many clicks one way as the other", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  if (stalled()) return t.skip(stalled());
  // From straight above the wheel's top is a circle round its axis: the middle of the points that hit it is its axis.
  await app.page(`window.emulatorStage3D.look(0, ${Math.PI / 2}, 0.6)`);
  await sleep(1500);
  const box = await frameBox();
  const points = await app.page(`(async () => {
    const out = [];
    for (let y = 2; y < ${box.height}; y += 3) for (let x = 2; x < ${box.width}; x += 3) {
      const { control } = await window.emulatorStage3D.ask({ type: "pick", x, y });
      if (control === "wheel") out.push([x, y]);
    }
    return out;
  })()`);
  assert.ok(points.length > 20, `the wheel is under the pointer somewhere: ${points.length} points`);
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const radius = Math.min(...[0, 1, 2, 3].map((q) => Math.max(...points.map(([x, y]) => (Math.abs(Math.atan2(y - cy, x - cx) - (q * Math.PI) / 2 + Math.PI) < 0.3 ? Math.hypot(x - cx, y - cy) : 0)))));
  await app.page(`(() => { window.barKeys = []; const events = (window.barKeyEvents = new EventSource("/_emu/events")); events.addEventListener("key", (e) => window.barKeys.push(JSON.parse(e.data))); })()`);
  await sleep(300);
  // A quarter of a turn one way along a circle at two thirds of the wheel's radius, and the same back.
  const arc = async (from, to) => {
    const at = (a) => ({ x: box.x + cx + radius * 0.66 * Math.cos(a), y: box.y + cy + radius * 0.66 * Math.sin(a) });
    const start = at(from);
    await mouse("mouseMoved", start.x, start.y);
    await mouse("mousePressed", start.x, start.y, { buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 24; k++) {
      const p = at(from + ((to - from) * k) / 24);
      await mouse("mouseMoved", p.x, p.y, { button: "left", buttons: 1 });
    }
    const end = at(to);
    await mouse("mouseReleased", end.x, end.y, { clickCount: 1 });
    await sleep(600);
    const keys = await app.page("window.barKeys.splice(0).filter((k) => k.type === 'press').map((k) => k.key)");
    return { up: keys.filter((k) => k === "up").length, down: keys.filter((k) => k === "down").length, other: keys.filter((k) => k !== "up" && k !== "down") };
  };
  const one = await arc(-Math.PI / 4, Math.PI / 4);
  const back = await arc(Math.PI / 4, -Math.PI / 4);
  await detachMouse();
  await app.page("window.barKeyEvents.close()");
  const said = JSON.stringify({ one, back });
  t.diagnostic(said);
  // 24 clicks a turn: a quarter is 6, give or take the one the drag starts in.
  assert.deepEqual([one.other, back.other], [[], []], `nothing but the wheel: ${said}`);
  assert.ok((one.up === 0) !== (back.up === 0) && one.down + back.down > 0, `one way up, the other down: ${said}`);
  const a = one.up + one.down;
  const b = back.up + back.down;
  assert.ok(a >= 5 && a <= 7 && b >= 5 && b <= 7 && Math.abs(a - b) <= 1, `as many clicks each way: ${said}`);
});

test("the front display is sharp: its LEDs stand apart, as the picture the page gives the scene has them", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  if (stalled()) return t.skip(stalled());
  // The front straight on, nearer than the views (the display whole in the frame), so that each LED takes several
  // pixels whatever the screen; in a window that gives the BUSY Bar the room the thresholds below were measured in,
  // about 17 pixels an LED (a smaller window, as on Windows, gives the LEDs fewer pixels and blurs the gaps between
  // them; the app column and the dashboard leave the view less room than a 1200x800 window gave it before).
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1680, 1050]);
  await app.page("window.emulatorStage3D.look(0, 0, 0.75)");
  await sleep(1500);
  const result = await app.page(`(async () => {
    const frame = document.querySelector("iframe.stage3d").contentWindow;
    const shot = async (lit) => {
      const front = new Uint8Array(72 * 16 * 3);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 72; x++) if (lit(x, y)) front.fill(255, (y * 72 + x) * 3, (y * 72 + x) * 3 + 3);
      frame.postMessage({ type: "frame", front: front.buffer }, "*");
      return window.emulatorStage3D.ask({ type: "probe", full: true });
    };
    const black = await shot(() => false);
    const white = await shot(() => true);
    const stripes = await shot((x) => x % 2 === 0);
    const { width: w, height: h } = white;
    const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    // The display: where a white picture lights the canvas.
    let most = 0;
    for (let i = 0; i < w * h * 4; i += 4) most = Math.max(most, lum(white.pixels, i) - lum(black.pixels, i));
    let [l, r, top, bottom] = [w, -1, h, -1];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (lum(white.pixels, i) - lum(black.pixels, i) < most * 0.4) continue;
      l = Math.min(l, x); r = Math.max(r, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const cw = (r - l + 1) / 72, ch = (bottom - top + 1) / 16;
    const at = (x, y) => lum(stripes.pixels, (Math.round(y) * w + Math.round(x)) * 4);
    // Across: the middles of the lit LEDs' columns against the middles of the dark ones', down the middle rows.
    let lit = 0, dark = 0, n = 0;
    for (let k = 4; k < 68; k += 2) for (let j = 4; j < 12; j++) {
      lit += at(l + (k + 0.5) * cw, top + (j + 0.5) * ch);
      dark += at(l + (k + 1.5) * cw, top + (j + 0.5) * ch);
      n++;
    }
    // Down a lit column: the middles of the LEDs against the gaps between them.
    let middle = 0, gap = 0, m = 0;
    for (let k = 4; k < 68; k += 2) for (let j = 4; j < 12; j++) {
      middle += at(l + (k + 0.5) * cw, top + (j + 0.5) * ch);
      gap += at(l + (k + 0.5) * cw, top + j * ch);
      m++;
    }
    // The same two numbers on the picture the frame gave the scene, texel by texel: what a perfectly sharp display shows.
    const picture = stripes.front;
    const cell = picture.width / 72;
    const texel = (x, y) => picture.data[(Math.round(y) * picture.width + Math.round(x)) * 4];
    const [tLit, tDark, tGap] = [texel(8.5 * cell, 8.5 * cell), texel(9.5 * cell, 8.5 * cell), texel(8.5 * cell, 8 * cell)];
    return {
      measured: { box: [l, top, r, bottom, w, h], ledPx: [cw, ch], across: (lit - dark) / (lit + dark), down: 1 - gap / middle, lit: lit / n, dark: dark / n },
      ideal: { across: (tLit - tDark) / (tLit + tDark), down: 1 - tGap / tLit },
    };
  })()`);
  const { measured, ideal } = result;
  const said = JSON.stringify({ measured, ideal });
  t.diagnostic(said);
  const [l, top, r, bottom, w, h] = measured.box;
  assert.ok(l > 0 && top > 0 && r < w - 1 && bottom < h - 1 && near(measured.ledPx[0], measured.ledPx[1], 1.5), `the whole display, found: ${said}`);
  assert.ok(measured.ledPx[0] >= 4, `each LED takes pixels enough to tell: ${said}`);
  // Measured on a Mac, 16 pixels a LED: sharp glass (scene 2026-11-11-6) keeps 0.83 of the ideal across and 0.42 of
  // it down; the rough glass before it (2026-11-11-1) blurred the gaps down to 0.23. PBR Neutral tone mapping (scene
  // 2026-11-11-8) rolls the bright white of the LEDs into the gaps: 0.76 across and 0.25 down.
  assert.ok(measured.across > ideal.across * 0.7, `the dark LEDs between lit ones stay dark: ${said}`);
  assert.ok(measured.down > ideal.down * 0.2, `the gaps between the LEDs show: ${said}`);
});

test("unmounting takes the frame away and leaves the page as it was", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  const left = await app.page(`(() => { window.emulatorStage3D.unmount(); for (const child of document.querySelector("#bar").children) child.style.display = "";
    return { mounted: window.emulatorStage3D.mounted, frames: document.querySelectorAll("iframe").length }; })()`);
  assert.deepEqual(left, { mounted: false, frames: 0 });
});

test("in the window's 3D view the bar turns by hand round its middle, within limits, and the quick views fly and light their buttons", { skip: skipAll }, async (t) => {
  if (!webgl) return t.skip("no WebGL2 in this run's hidden window");
  await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [1200, 800]);
  await app.page(`document.querySelector("#view-3d").click()`);
  await until(() => app.page("window.emulatorStage3D.mounted && window.emulatorStage3D.ask({ type: 'probe' }).then((p) => p.ready, () => false)"), "the 3D view in the window", 40_000);
  const lit = () => app.page(`[...document.querySelectorAll("#camera-views button.on")].map((b) => b.dataset.camera)`);
  const settled = async (view) => {
    await until(async () => (await probe()).view === view, `the camera at ${view}`);
    await sleep(300);
    return probe();
  };
  const front = await settled("front");
  assert.deepEqual(await lit(), ["front"]);
  const { tilt: frontTilt, turn: frontTurn } = front.camera;

  // A drag on the background turns the bar (0.009 radians a pixel), and no quick view is lit any more.
  const bg = await background();
  await drag(bg.x, bg.y, 60, 30);
  let seen = await probe();
  assert.equal(seen.view, null);
  assert.ok(near(seen.camera.turn, frontTurn + 0.54, 0.08) && near(seen.camera.tilt, frontTilt - 0.27, 0.08), `turned by the drag: ${JSON.stringify(seen.camera)}`);
  await until(async () => (await lit()).length === 0, "no quick view lit");
  assert.equal(await app.page("window.emulatorStage3D.view"), null);
  // Down as far as it goes: straight from above. Up as far as it goes: a little below the bar's middle, never under it.
  await drag(bg.x, bg.y, 0, 400);
  assert.ok(near((await probe()).camera.tilt, -Math.PI / 2, 1e-6), "no farther than straight from above");
  // From low in the view, inside it whatever room the dashboard leaves.
  const view = await frameBox();
  await drag(bg.x, Math.min(bg.y + 300, view.y + view.height - 24), 0, -600);
  assert.ok(near((await probe()).camera.tilt, 0.05, 1e-6), "no lower than just under the bar's middle");

  // Scrolling off the bar brings it nearer or takes it farther, within limits.
  const distanceAt = async (deltaY) => {
    await mouse("mouseWheel", bg.x, bg.y, { deltaX: 0, deltaY });
    await sleep(100);
    return (await probe()).camera;
  };
  const near1 = await distanceAt(-4000);
  const far1 = await distanceAt(8000);
  assert.deepEqual([near1.zoom, far1.zoom], [0.5, 2], "the distance stops at its limits");
  assert.ok(far1.distance > near1.distance * 3.5, `farther away: ${near1.distance} then ${far1.distance}`);

  // A double click on the background: back to the last quick view, at its distance, and its button lit again.
  await mouse("mouseMoved", bg.x, bg.y);
  for (const clickCount of [1, 2]) {
    await mouse("mousePressed", bg.x, bg.y, { buttons: 1, clickCount });
    await mouse("mouseReleased", bg.x, bg.y, { clickCount });
  }
  seen = await settled("front");
  assert.ok(near(seen.camera.tilt, frontTilt, 1e-6) && seen.camera.zoom === 1, `back at the front: ${JSON.stringify(seen.camera)}`);
  await until(async () => (await lit()).join() === "front", "Front lit again");

  // A quick view flies there; a drag goes on from it.
  await app.page(`document.querySelector('#camera-views button[data-camera="top"]').click()`);
  seen = await settled("top");
  assert.ok(near(seen.camera.tilt, -Math.PI / 2, 1e-6));
  assert.deepEqual(await lit(), ["top"]);
  // From the background at the frame's left edge: from above the bar stands over the middle, clear of the dock under it.
  const box = await frameBox();
  const from = { x: box.x + 12, y: bg.y + 100 };
  assert.equal((await app.page(`window.emulatorStage3D.ask({ type: "pick", x: 12, y: ${from.y - box.y} })`)).bar, false, "the drag starts off the bar");
  await drag(from.x, from.y, 0, -50);
  seen = await probe();
  assert.ok(near(seen.camera.tilt, -Math.PI / 2 + 0.45, 0.08), `on from the top: ${JSON.stringify(seen.camera)}`);
  await until(async () => (await lit()).length === 0, "no quick view lit after the drag");
  await detachMouse();
  await app.page(`document.querySelector("#view-2d").click()`);
  assert.equal(await app.page("window.emulatorStage3D.mounted"), false);
});

test("the camera's views stand under the row of the top tools, at 1200×800 and at 900×650: the 2D / 3D switch covers none of them", { skip: skipAll }, async () => {
  for (const [w, h] of [[1200, 800], [900, 650]]) {
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const box = await app.page(`(() => {
      const views = document.querySelector("#camera-views");
      views.hidden = false;
      const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      const out = { top: rect(document.querySelector("#canvas-tools-top")), views: rect(views), canvas: rect(document.querySelector(".canvas")) };
      views.hidden = true;
      return out;
    })()`);
    assert.ok(box.views.top >= box.top.bottom, `${w}×${h}: the views start at ${box.views.top}, the top tools end at ${box.top.bottom}`);
    assert.ok(box.views.bottom <= box.canvas.bottom && box.views.right <= box.canvas.right, `${w}×${h}: the views stay in the canvas`);
  }
});

test("the controls stand centred under the bar, at 1200×800 and at 900×650, in 2D and in 3D; around them a drag still turns the bar", { skip: skipAll }, async () => {
  const rects = () =>
    app.page(`(() => {
      const rect = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, middle: (r.left + r.right) / 2 }; };
      return { bar: rect("#bar"), dock: rect("#dock"), strip: rect("#strip"), oled: rect(".oled-frame"), canvas: rect(".canvas") };
    })()`);
  if (await app.page("window.emulatorStage3D.mounted")) await app.page(`document.querySelector("#view-2d").click()`);
  await until(async () => (await app.page("window.emulatorStage3D.mounted")) === false, "the flat view");
  for (const [w, h] of [[1200, 800], [900, 650]]) {
    const at = `${w}×${h}`;
    await app.run((shell, _electron, size) => shell.windows.current.win.setContentSize(size[0], size[1]), [w, h]);
    await sleep(300);
    // 2D: the dock (the controls) is centred under the picture of the bar, clear of it, in
    // the canvas.
    const flat = await rects();
    assert.ok(near(flat.dock.middle, flat.bar.middle, 2), `${at} 2D: the dock's middle ${flat.dock.middle}, the bar's ${flat.bar.middle}`);
    assert.ok(flat.dock.top >= flat.bar.bottom, `${at} 2D: the dock starts at ${flat.dock.top}, under the bar, which ends at ${flat.bar.bottom}`);
    assert.ok(flat.dock.left >= flat.canvas.left && flat.dock.right <= flat.canvas.right && flat.dock.bottom <= flat.canvas.bottom, `${at} 2D: the dock in the canvas`);
    assert.ok(flat.oled.top >= flat.canvas.bottom, `${at}: the back display in the bar's card, under the canvas`);
    if (!webgl) continue;
    // 3D: the model stands in the middle across, above the dock; the frame still takes the whole canvas.
    await app.page(`document.querySelector("#view-3d").click()`);
    await until(() => app.page("window.emulatorStage3D.mounted && window.emulatorStage3D.ask({ type: 'probe' }).then((p) => p.ready, () => false)"), `${at}: the 3D view`, 40_000);
    await sleep(1200);
    const deep = await rects();
    const frame = await frameBox();
    const { bounds } = await probe();
    const model = { left: frame.x + bounds.left * frame.width, right: frame.x + bounds.right * frame.width, bottom: frame.y + bounds.bottom * frame.height };
    assert.ok(near(deep.dock.middle, (model.left + model.right) / 2, frame.width * 0.03), `${at} 3D: the dock's middle ${deep.dock.middle}, the model's ${JSON.stringify(model)}`);
    assert.ok(model.bottom <= deep.dock.top, `${at} 3D: the model ends at ${model.bottom}, above the dock at ${deep.dock.top}`);
    assert.ok(frame.y <= deep.canvas.top + 1 && frame.y + frame.height >= deep.canvas.bottom - 1, `${at} 3D: the frame takes the canvas`);
    const beside = await app.page(`document.elementFromPoint(${Math.max(deep.canvas.left + 4, deep.dock.left - 24)}, ${(deep.dock.top + deep.dock.bottom) / 2})?.tagName`);
    assert.equal(beside, "IFRAME", `${at} 3D: beside the dock is the view, where a drag turns the bar`);
    const above = await app.page(`document.elementFromPoint(${deep.dock.middle}, ${deep.dock.top - 4})?.tagName`);
    assert.equal(above, "IFRAME", `${at} 3D: between the model and the dock too`);
    await app.page(`document.querySelector("#view-2d").click()`);
    await until(async () => (await app.page("window.emulatorStage3D.mounted")) === false, `${at}: back to 2D`);
  }
});
