// The device window: a page at /emulator with both displays, the controls and the app console, and what it needs
// from the server.
//
//   GET  /emulator                 the page (files in ./legacy-window)
//   GET  /emulator/stage3d/frame/* the 3D view's frame: the files of packages/stage/frame, with their own policy
//                                  (stage3d.mjs)
//   GET  /_emu/events              server-sent events: "hello", "frame" { front, back } when the picture changes
//                                  (base64, as GET /api/screen sends them), "log" { kind, text, time }, "apps",
//                                  "state" { running, selector } every second and on changes, "key" { key, type }
//                                  for every event of a button or the wheel the bar takes (the 3D view moves its
//                                  buttons by them), "lights" { preset, color, brightness } for the status lights
//                                  when the firmware starts a preset or its brightness changes, and on connecting
//                                  (device.mjs, lightsState)
//   POST /_emu/key?key=ok&action=down|up   hold and release a button, as the hardware does
//   GET  /_emu/audio?id=N          the samples of the sound that plays: raw 16-bit mono PCM, 44100 Hz
//   POST /_emu/time?hold=1|0       stop the system's clock (animations, scrolling, the menus' timers) or let it run;
//        &seed=N &jitter=0         holding stops it on a tick and starts the time the GUI takes to draw at bar
//                                  speed from seed N (1..2^32-1; a fixed one by default), or with jitter=0 the GUI
//                                  draws in no time until the release: then the same steps give the same frames
//                                  (screen.mjs)
//   POST /_emu/time?advance=ms     with the clock held: move it on, doing what was due in between
//   POST /_emu/time?pass=ms        time passes at once, for the system and the running app: the bar's clock is ms on,
//                                  the system's ticks and timers of those ms are carried out, the app's timers count
//                                  from the new time (busy-emulator time advance)
//                                  (each answers { held, now, wander }: wander is how far the screen module's
//                                  clock may run ahead of the computer's, ms: what one pass of the GUI draws at
//                                  most, 0 when drawing takes no time; during a restart of the bar, once the bar is
//                                  up, as /api/* does)
//   GET  /_emu/status              { wifi, usb, battery }
//   POST /_emu/status?wifi=0|1&usb=0|1&battery=0..100   Wi-Fi, USB and the battery's charge; any of the three
//   POST /_emu/power?action=restart|off|on   restart the bar, power it off, turn it back on
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { insideFolder } from "./path-boundary.mjs";
import { serveStageFrame, STAGE_FRAME_PATH } from "./stage3d.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, "legacy-window");
// The catalog's rules for the author's texts, which the window's publishing flow checks as the command line does
// (readiness/texts.mjs and the two files it imports, none of which touches a file): served as they are.
const READINESS = Object.freeze({ "readiness/texts.mjs": "texts.mjs", "readiness/rules.mjs": "rules.mjs", "readiness/markdown.mjs": "markdown.mjs" });
// The README step's maker (publish/readme.mjs, which touches no file), for the preview as it is typed, its How to use
// rows (publish/how-to-use.mjs, read by the window's Overview too), and the texts
// of the licenses the License step writes, for "Show the full text": served as they are.
const PUBLISHING = Object.freeze({ "publish/readme.mjs": "readme.mjs", "publish/how-to-use.mjs": "how-to-use.mjs", "publish/licenses/MIT.txt": "licenses/MIT.txt", "publish/licenses/Apache-2.0.txt": "licenses/Apache-2.0.txt", "publish/licenses/GPL-3.0.txt": "licenses/GPL-3.0.txt" });
// The icons' rules and their conversion (capture/icon-rules.mjs, which imports nothing and touches no file), for the
// window's icon block: served as it is.
const CAPTURE = Object.freeze({ "capture/icon-rules.mjs": "icon-rules.mjs" });
const MIME = { ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".json": "application/json", ".md": "text/markdown; charset=utf-8" };

// The page's policy (ADR-0012 section 1): its own files and its own address only, no code that is not in a file of
// its own, no plugins, no other base, no forms, in no other page's frame. Pictures may also be data: and blob:.
// nosniff: a file is only ever what its Content-Type says.
export const WINDOW_POLICY = "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = { "Content-Security-Policy": WINDOW_POLICY, "X-Content-Type-Options": "nosniff" };

// How often the window's picture is checked for changes: the firmware plays animations at 30 FPS.
/** The most time that may pass at once (POST /_emu/time?pass=ms): every 8 ms tick of it is carried out. */
export const MAX_PASS_MS = 24 * 3600 * 1000;
const FRAME_CHECK_MS = 33;
// Console lines a newly opened window gets.
const HISTORY = 500;

export function attachDeviceWindow(device, { apiVersion }) {
  const clients = new Set();
  const history = [];
  device.events.on("log", (event) => {
    history.push(event);
    if (history.length > HISTORY) history.shift();
    broadcast("log", event);
  });
  const state = () => ({
    running: device.running && { id: device.running.id, stats: device.running.runtime.stats },
    selector: device.selector,
    barSpeed: !!device.speed, // false: apps run at the computer's speed
    status: { wifi: device.state.wifi, usb: device.state.usb, battery: device.state.battery, powered: device.powered },
  });
  const sendState = () => broadcast("state", state());
  device.events.on("apps", () => {
    broadcast("apps", {});
    sendState();
  });
  device.events.on("selector", sendState);
  device.events.on("key", (key, type) => clients.size && broadcast("key", { key, type }));
  device.events.on("status", sendState);
  device.events.on("lights", (lights) => broadcast("lights", lights));
  // The speaker: the window fetches the samples of sound `id` from /_emu/audio and plays them at the bar's volume.
  device.audio.events.on("play", ({ id, seconds }) => broadcast("audio", { action: "play", id, seconds, volume: device.state.volume }));
  device.audio.events.on("stop", () => broadcast("audio", { action: "stop" }));
  device.events.on("volume", () => broadcast("audio", { action: "volume", volume: device.state.volume }));

  let last = { front: "", back: "" };
  let frames = null;
  // What a person sees: the displays' pictures, or dark panels while they sleep (OFF) or the bar is off. The API's
  // /api/screen gives the buffers themselves, as a bar does.
  const seen = (display) => {
    const frame = device.screen.frame(display);
    return Buffer.from(device.screen.asleep() ? new Uint8Array(frame.length) : frame).toString("base64");
  };
  const checkFrames = () => {
    const front = seen(0);
    const back = seen(1);
    if (front === last.front && back === last.back) return;
    last = { front, back };
    broadcast("frame", last);
  };
  const states = setInterval(() => clients.size && sendState(), 1000).unref();

  function broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(message);
  }

  /** Handles the window's requests; returns false for anything else. */
  function handle(req, res, url) {
    if (url.pathname.startsWith(STAGE_FRAME_PATH)) {
      serveStageFrame(req, res, url);
      return true;
    }
    if (url.pathname === "/emulator" || url.pathname.startsWith("/emulator/")) {
      const name = url.pathname === "/emulator" || url.pathname === "/emulator/" ? "index.html" : url.pathname.slice("/emulator/".length);
      // A file of the window's own folder by its real path (path-boundary.mjs): "..", a link out and a folder beside it
      // whose name starts the same are not.
      const file = Object.hasOwn(READINESS, name) ? join(here, "readiness", READINESS[name]) : Object.hasOwn(CAPTURE, name) ? join(here, "capture", CAPTURE[name]) : Object.hasOwn(PUBLISHING, name) ? join(here, "publish", ...PUBLISHING[name].split("/")) : insideFolder(pages, name);
      try {
        if (file === null) throw new Error("outside");
        const body = readFileSync(file);
        res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache", ...PAGE_HEADERS });
        res.end(body);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain", ...PAGE_HEADERS });
        res.end("Not found");
      }
      return true;
    }

    if (url.pathname === "/_emu/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const { firmware } = device;
      const hello = { firmware: { name: firmware.name, commit: firmware.info.firmware, summary: firmware.summary }, apiVersion };
      res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
      for (const event of history) res.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      // The status lights as they are: a window that opens now shows what a person would see on the bar.
      if (device.lightsState) res.write(`event: lights\ndata: ${JSON.stringify(device.lightsState())}\n\n`);
      res.write(`event: frame\ndata: ${JSON.stringify(last.front ? last : { front: seen(0), back: seen(1) })}\n\n`);
      clients.add(res);
      if (!frames) frames = setInterval(checkFrames, FRAME_CHECK_MS);
      // The response's end, not the request's: the request is over as soon as it has been read.
      res.on("close", () => {
        clients.delete(res);
        if (!clients.size) {
          clearInterval(frames);
          frames = null;
        }
      });
      return true;
    }

    if (url.pathname === "/_emu/time" && req.method === "POST") {
      const seed = url.searchParams.has("seed") ? Number(url.searchParams.get("seed")) : undefined;
      if (url.searchParams.get("hold") === "1" && seed !== undefined && !(Number.isInteger(seed) && seed > 0 && seed <= 0xffffffff)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "seed: a whole number from 1 to 4294967295" }));
        return true;
      }
      // A bar that restarts is up first, as for /api/*: the clock of the screen module that is loading is not there
      // yet, and one held before the bar's first frame would keep the restart, and every request, waiting (EMU-253).
      Promise.resolve(device.booting)
        .catch(() => {})
        .then(() => {
          if (res.destroyed) return;
          const screen = device.screen;
          if (url.searchParams.has("pass")) {
            // Time passes at once, for the system and the running app alike (device.mjs, passTime).
            const ms = Number(url.searchParams.get("pass"));
            if (!(Number.isInteger(ms) && ms >= 1 && ms <= MAX_PASS_MS)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: `pass: a whole number of ms from 1 to ${MAX_PASS_MS} (24 hours)` }));
              return;
            }
            if (!device.powered) {
              res.writeHead(409, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "the BUSY Bar is off" }));
              return;
            }
            // `passed` counts from when this request came: the move itself takes a moment of the computer's time.
            const moved = device.passTime(ms);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ passed: moved > 0 ? ms : 0, bar_time: device.barTime(), app: device.running?.id ?? null, held: device.screen.held }));
            return;
          }
          if (url.searchParams.get("hold") === "1") screen.hold({ seed, jitter: url.searchParams.get("jitter") !== "0" });
          if (url.searchParams.has("advance") && screen.held) screen.advance(Math.max(0, Number(url.searchParams.get("advance")) || 0));
          if (url.searchParams.get("hold") === "0") screen.release();
          res.writeHead(200, { "Content-Type": "application/json" });
          // wander: how far the screen module's clock may run ahead of the computer's, ms (what one GUI pass draws
          // at most at bar speed, 0 without the drawing time).
          res.end(JSON.stringify({ held: screen.held, now: screen.now(), wander: screen.wander ?? 0 }));
        })
        .catch((e) => {
          if (res.headersSent || res.destroyed) return;
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e?.message ?? e) }));
        });
      return true;
    }

    if (url.pathname === "/_emu/audio" && req.method === "GET") {
      const samples = device.audio.samples(url.searchParams.get("id"));
      res.writeHead(samples ? 200 : 404, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
      res.end(samples ? Buffer.from(samples) : "");
      return true;
    }

    if (url.pathname === "/_emu/status" && (req.method === "POST" || req.method === "GET")) {
      if (req.method === "POST") {
        const flag = (name) => (url.searchParams.has(name) ? url.searchParams.get(name) === "1" : undefined);
        const battery = url.searchParams.has("battery") ? Number(url.searchParams.get("battery")) : undefined;
        device.setStatus({ wifi: flag("wifi"), usb: flag("usb"), battery });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state().status));
      return true;
    }

    if (url.pathname === "/_emu/power" && req.method === "POST") {
      const action = url.searchParams.get("action");
      // wait=1: the answer comes once the bar is up again (its first frame drawn, Device.reboot), with how long that
      // took; the window's Restart bar button and `busy-emulator restart-bar` wait so. `why` names who asked, for the
      // log line ("The bar restarts (…)").
      if (action === "restart" && url.searchParams.get("wait") === "1") {
        const from = Date.now();
        const why = url.searchParams.get("why") === "cli" ? "asked from the command line" : "asked in the device window";
        device
          .reboot(why)
          .then(() => {
            if (res.headersSent || res.destroyed) return;
            res.writeHead(device.powered ? 200 : 503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ powered: device.powered, ms: Date.now() - from }));
          })
          .catch((e) => {
            if (res.headersSent || res.destroyed) return;
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: String(e?.message ?? e) }));
          });
        return true;
      }
      if (action === "restart") device.reboot("asked in the device window");
      else if (action === "off") device.powerOff("asked in the device window");
      else if (action === "on") device.powerOn();
      res.writeHead(["restart", "off", "on"].includes(action) ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ powered: device.powered }));
      return true;
    }

    if (url.pathname === "/_emu/key" && req.method === "POST") {
      const key = url.searchParams.get("key") ?? "";
      const ok = url.searchParams.get("action") === "up" ? device.keyUp(key) : device.keyDown(key);
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(ok ? '{"result":"OK"}' : '{"error":"Bad Request"}');
      return true;
    }
    return false;
  }

  /**
   * The server stops: the state is no longer sent every second. The event streams themselves are the server's
   * connections and close with them; the last one to close ends the checking of frames, as when a window is shut.
   */
  handle.close = () => clearInterval(states);
  return handle;
}
