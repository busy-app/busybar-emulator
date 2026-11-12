// The emulated BUSY Bar: installed apps on a local "/ext", the running app, the displays and the HTTP API, with the
// paths, JSON and status codes of the firmware (web_server/http_api, openapi/*.yaml). Drawing and frames are the
// firmware's own code in the screen module (screen.mjs).
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { Access } from "./access-api.mjs";
import { AudioPlayer } from "./audio.mjs";
import { cjsonPrint } from "./cjson.mjs";
import { computerNow, computerTimeOfDay, timeOfDayOffset } from "./computer-clock.mjs";
import { deviceKeyAnswer } from "./device-key.mjs";
import { assetsApi, logDump, openUpload, storageApi, uploadTarget } from "./files-api.mjs";
import { appsAssets } from "./firmware.mjs";
import { readJsonFile, setAside, writeFileAtomic } from "./json-store.mjs";
import { createLocalAccess, explainRefusal } from "./local-access.mjs";
import { MEMORY_NOTE_MIN_BYTES, memoryNote, networkErrorNote, redirectNote, TEXT_CODEC_NOTE, usesTextCodec } from "./network-notes.mjs";
import { insideRoots, within } from "./path-boundary.mjs";
import { checkSettingsSchema } from "./projects/settings-schema.mjs";
import { AppRuntime, InputKey, InputType } from "./runtime.mjs";
import { BleStatus, JsRunnerError, LauncherStatus, Screen, WifiState } from "./screen.mjs";
import { emptyFolder, isBusy, retrying, unpackPackage, UnpackError } from "./tar.mjs";
import { visibleNames, volumeMakesSidecars } from "./volume.mjs";

// A zone's offset as the firmware writes it, "+03:00", in minutes east of UTC.
const offsetMinutes = (offset) => (offset[0] === "-" ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));

// The parts of the API that the firmware's own handlers answer, in the screen module (packages/engine/native/emu_screen.c
// lists them): what follows /api/ is one of these, or goes on from one with a slash.
const FIRMWARE_API = ["display/draw", "busy", "name", "time", "ble", "wifi", "update", "account", "smart_home"];

// The bar's name out of the box (packages/engine/native/emu_settings.c).
const DEFAULT_NAME = "BUSY Bar Emulator";

// The displays and the system of a bar that is off or restarting: dark frames, no answers.
function darkScreen() {
  const unavailable = { status: 503, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode('{"error":"Service Unavailable"}\n') };
  return {
    held: false,
    frame: (display) => new Uint8Array(display === 0 ? 72 * 16 * 3 : (160 * 80) / 2),
    asleep: () => true,
    firstFrame: async () => {},
    request: async () => unavailable,
    launch: () => LauncherStatus.error,
    quit: () => LauncherStatus.error,
    now: () => computerNow(),
    dispose() {},
    input() {},
    status() {},
    noteStatus() {},
    scriptStarted() {},
    scriptFinished() {},
    jsFatal() {},
    hold() {},
    advance() {},
    pass: () => 0,
    release() {},
  };
}

// The status lights, the bar's two RGB LEDs beside Start / Pause: the firmware's StatusLightsPreset by number
// (status_lights_common.h), and the names the device window and /_emu/state give them.
export const LIGHT_PRESETS = ["off", "static", "fade", "rainbow", "blink", "notification"];
// A notification is three blinks of 500 ms on and 500 ms off, then dark (status_lights/presets/blink.c: 6 ticks of
// 500 ms from the start, the last one dark, then the lights stop): the lights are dark 2.5 s after it started.
export const NOTIFICATION_MS = 2500;
// The user brightness that automatic stands for: the emulator has no light sensor (the state stream says half too).
const AUTO_BRIGHTNESS = 50;
const LIGHTS_OFF = Object.freeze({ preset: "off", rgb: [0, 0, 0], override: -1, at: 0 });

// How many of the latest log lines POST /api/log_dump writes out.
const LOG_LINES = 2000;

// The firmware's allowlist for requests made by apps (web_server/http_api/api_root.c). It applies when a request
// carries the header js_fetch.c adds to every app request.
const APP_ALLOWLIST = [
  ["apps/settings", "exact", ["GET"]],
  ["display/brightness", "exact", ["GET", "POST"]],
  ["display/draw", "exact", ["POST", "DELETE"]],
  ["audio/play", "exact", ["POST", "DELETE"]],
  ["busy", "prefix", ["GET", "PUT"]],
  ["name", "exact", ["GET"]],
  ["audio/volume", "prefix", ["GET", "POST"]],
  ["time", "prefix", ["GET"]],
  ["wifi/status", "exact", ["GET"]],
  ["version", "exact", ["GET"]],
  ["access", "exact", ["GET"]],
  ["transport", "exact", ["GET"]],
  ["status", "exact", ["GET"]],
  ["status/device", "exact", ["GET"]],
  ["status/firmware", "exact", ["GET"]],
  ["status/system", "exact", ["GET"]],
  ["status/power", "exact", ["GET"]],
];

// The firmware's handlers of the API root (api_root.c handlers_api_root, :667–819) in the order web_server.c tries
// them, which is the order of the arrays: http_handler_add() calls M*LIB's push_back, which puts an item at the head
// of the list, the lists are filled from the end of their arrays, and the list is walked from its head (m-list.h).
// A handler takes a path that starts with its uri (no "/" needed after it) and answers a method it does not take with
// 405 and the methods it does (http_handle_request, web_server.c:454–497). `methods`: what it takes, all when there
// is none; `inner`: the handlers of its own list (api_apps.c :700–746, api_audio.c :261–275, api_display.c
// :1155–1169), which go the same way; `names`: api_status.c's paths, each GET only; `endpoint`: the methods a handler
// of all methods takes at its own path and answers 405 for otherwise (DELETE /api/apps, api_apps.c:540–547). What
// reaches the emulator's router (Device.unrouted) is what none of its own cases took: a handler without `inner` or
// `names` has nothing more for it. status/ws takes only a WebSocket upgrade, whose 405 names GET.
const API_ROOT = [
  { uri: "version", methods: ["GET"] }, { uri: "transport", methods: ["GET"] }, { uri: "assets" }, { uri: "storage" },
  { uri: "display", inner: [{ uri: "draw", methods: ["POST", "DELETE"] }, { uri: "brightness", methods: ["GET", "POST"] }] },
  { uri: "audio", inner: [{ uri: "play", methods: ["POST", "DELETE"] }, { uri: "volume", methods: ["GET", "POST"] }] },
  { uri: "input", methods: ["POST"] }, { uri: "status", names: ["", "device", "firmware", "system", "power"] },
  { uri: "status/ws", methods: [], allow: ["GET"] }, { uri: "wifi" }, { uri: "update" }, { uri: "screen", methods: ["GET"] },
  { uri: "ble" }, { uri: "time" }, { uri: "name", methods: ["GET", "POST"] }, { uri: "log_dump", methods: ["POST"] },
  { uri: "account" }, { uri: "busy" }, { uri: "smart_home" },
  {
    uri: "apps",
    inner: [
      { uri: "", endpoint: ["DELETE"] },
      { uri: "stage", methods: ["POST"] }, { uri: "install", methods: ["POST"] }, { uri: "launch", methods: ["POST"] },
      { uri: "quit", methods: ["POST"] }, { uri: "list", methods: ["GET"] }, { uri: "settings", methods: ["GET", "PUT", "DELETE"] },
    ],
  },
];
// The methods web_server.c knows, in the order a 405's Allow names them (http_methods, :49–59; only the first four
// are ever named).
const HTTP_METHODS = ["GET", "POST", "DELETE", "PUT", "OPTIONS", "HEAD", "CONNECT", "PATCH", "TRACE"];
const API_METHODS = HTTP_METHODS.slice(0, 4);

/**
 * The methods to answer 405 with for a request no case of the emulator took, as the firmware's handlers would
 * (API_ROOT): an array, or null when no handler takes the path at all.
 */
function methodsAllowed(handlers, path, method) {
  for (const h of handlers) {
    if (!path.startsWith(h.uri)) continue;
    if (h.methods && !h.methods.includes(method)) return h.allow ?? h.methods;
    const rest = path.slice(h.uri.length).replace(/^\//, "");
    if (h.inner) {
      const inner = methodsAllowed(h.inner, rest, method);
      if (inner) return inner;
    } else if (h.names?.includes(rest) && method !== "GET") return ["GET"];
    else if (h.endpoint && rest === "" && !h.endpoint.includes(method)) return h.endpoint;
  }
  return null;
}

const methodNotAllowed = (methods) => ({
  status: 405,
  headers: [["Content-Type", "application/json"], ["Allow", API_METHODS.filter((m) => methods.includes(m)).join(", ")]],
  body: new TextEncoder().encode('{"error":"Method Not Allowed"}\n'),
});

// The input service (applications/services/input/input.c): while a button is held, a timer ticks every 150 ms; the
// second tick is "long", every later one "repeat". Released before "long", the button also gives "short".
const PRESS_TICK_MS = 150;
// Back and Start held together for this long restart the bar.
const RESET_HOLD_MS = 2000;
const LONG_PRESS_COUNTS = 2;
// A button pressed while the app's JS held the server's thread reaches the server only once the watchdog has stopped the
// app (runtime.mjs SLICE_LIMIT_MS), all at once. What comes this soon after the stop was pressed during the hang.
const HELD_KEYS_MS = 200;
// The emulator's own notes on an app's mistakes, which a bar keeps to itself (public-docs/differences.md). They go to
// the log as "App <id>: emulator: ...", so that a reader tells them from what the app or the firmware said.
export const UNHANDLED_NOTE = "emulator: unhandled rejection: ";
// The emulator's watchdog stopped the app: its JS held the server's thread for `ms` (runtime.mjs SLICE_LIMIT_MS).
export const OVERDUE_NOTE = (ms) =>
  `emulator: the app's JS ran ${ms / 1000} s without returning and was stopped, as a long Back stops it. Wait with setTimeout, not with a loop or with promises that start each other without end: on a BUSY Bar either one holds the app's JS`;

/**
 * The note for the bar's API refusing a request of the app (an answer of 400 or more), with the bar's own error text:
 * busy-lib's error path calls Response.clone(), which the bar's runtime lacks, so the app itself only gets
 * "TypeError: Expected a function" (docs/requests/busy-tools-issues.md, issue 12).
 * @param {string} method
 * @param {string} url
 * @param {{ status: number, body: Uint8Array }} answer
 */
export function apiRefusalNote(method, url, answer) {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // not a URL: as it is
  }
  const body = Buffer.from(answer.body ?? []).toString("utf8").trim();
  let said = body;
  try {
    const error = JSON.parse(body)?.error;
    if (typeof error === "string") said = error;
  } catch {
    // not JSON: the text as it is
  }
  said = said.replace(/\s+/g, " ");
  if (said.length > 200) said = `${said.slice(0, 199)}…`;
  return `emulator: ${method} ${path} refused: ${answer.status}${said ? ` ${said}` : ""} (busy-lib turns this into "Expected a function")`;
}

// api_input.c: the keys POST /api/input accepts. The last five are the positions of the mode selector on top of the bar.
const API_KEYS = ["up", "down", "ok", "back", "start", "busy", "custom", "off", "apps", "settings"];
const SELECTOR = ["busy", "custom", "off", "apps", "settings"];

const APP_ID_RE = /^[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]{0,31}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const json = (status, value) => ({ status, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode(JSON.stringify(value)) });
const ok = () => json(200, { result: "OK" });
const error = (status, message, extra = {}) => json(status, { error: message, ...extra });
// An error as the bar's web server words it, with the line end (web_server_i.h's MG_REPLY_ERROR_CLOSE).
const errorLine = (status, message) => ({ ...error(status, message), body: new TextEncoder().encode(JSON.stringify({ error: message }) + "\n") });

// The routes that take a file as the body of a POST, and how: the bar's web server hands the body of these to a
// handler as it comes, where every other request is held whole in its receive buffer first (see reception).
//   apps/stage, update      api_apps.c, api_update.c: 100 MiB at most (MAX_UPLOAD_FILE_SIZE), quiet for 5 s at most
//   storage/write,          web_server.c's http_upload_start: any size, quiet for 3 s at most (HTTP_UPLOAD_IDLE_TIMEOUT_MS)
//   assets/upload
const PACKAGE_MAX = 100 * 1024 * 1024;
const PACKAGE_IDLE_MS = 5000;
const FILE_IDLE_MS = 3000;

function semverLE(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return true;
}

// api_apps.c:21, 335–345: the key is read into an 11-byte buffer (at most 10 characters) and parsed with strtoul,
// which must use it all: white space and a sign may lead, a minus wraps, a number too large is ULONG_MAX.
function installKey(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 10) return null;
  const m = /^[ \t\n\v\f\r]*([+-]?)(\d+)$/.exec(text);
  if (!m) return null;
  let n = Number(m[2]);
  if (n > 0xffffffff) n = 0xffffffff;
  return m[1] === "-" ? (0x100000000 - n) % 0x100000000 : n;
}

// What the log adds when Windows would not move or delete a folder after all the tries (tar.mjs retrying).
const IN_USE =
  ". On Windows this most often means that another program has one of these files or folders open (an editor, a terminal standing in the folder, a virus scan): close it and install again";

/** The kind of what stands at a path, a link not followed: "dir", "other", or null when nothing does. */
function standsAt(p) {
  try {
    return lstatSync(p).isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

/**
 * Puts folder `from` at `to`. What was at `to` is moved to `aside` first and comes back if `from` cannot be moved in;
 * it is deleted only once `from` is in place. The file `aside`.done is written before that deleting starts and removed
 * after it ends: a folder at `aside` without it is a version that lost its place — the emulator stopped between the
 * two moves, or the move back failed — and Device.settleReplaced puts it back.
 */
function replaceFolder(from, to, aside) {
  const had = existsSync(to);
  if (had) retrying(() => renameSync(to, aside));
  try {
    retrying(() => renameSync(from, to));
  } catch (e) {
    if (had) retrying(() => renameSync(aside, to));
    throw e;
  }
  if (!had) return;
  try {
    writeFileSync(`${aside}.done`, "");
    retrying(() => rmSync(aside, { recursive: true, force: true }));
    rmSync(`${aside}.done`, { force: true });
  } catch {} // what is left is deleted by settleReplaced
}

export class Device {
  /**
   * @param {object} o
   * @param {string} o.dataDir folder that plays the bar's /ext
   * @param {(line: string) => void} o.log
   * @param {object} o.firmware the firmware the bar runs (firmware.mjs's loadFirmware); there is no bar without one
   */
  /** speed: bar speed for the apps (bar-speed.mjs), or null for the computer's. */
  /** sidecars: whether the data folder's volume makes "._" files (volume.mjs); probed when not given. */
  /** clockHost: the computer's clock and timer the bar's clock runs by (TickClock's options), for tests; the real ones when not given. */
  /** localAccess: the ports of this computer an app may reach (local-access.mjs); none when not given. */
  constructor({ dataDir, log, firmware, speed = null, sidecars, clockHost, localAccess = createLocalAccess(), barAddress = () => null }) {
    if (!firmware?.dir) throw new TypeError("Device needs the firmware the BUSY Bar runs: { firmware } (loadFirmware in firmware.mjs)");
    this.firmware = firmware;
    this.speed = speed;
    this.clockHost = clockHost;
    this.localAccess = localAccess;
    // The address the bar answers on, which the firmware's APPS screen with no apps names (patches.mjs).
    this.barAddress = barAddress;
    this.root = resolve(dataDir);
    // What happens on the device, for the terminal and the device window: "log" events { kind, text, time, at }, where
    // kind is the app's console severity, "app" for its lifecycle or "system", time is by the bar's clock and at by
    // the computer's (busy-emulator logs --since); "apps" when the installed or running apps change.
    this.events = new EventEmitter();
    this.logLines = []; // the latest lines, for POST /api/log_dump
    this.log = (text, kind = "system") => {
      log(text);
      const line = { kind, text, time: this.barTime(), at: Date.now() };
      this.logLines.push(line);
      if (this.logLines.length > LOG_LINES) this.logLines.shift();
      this.events.emit("log", line);
    };
    if (sidecars === undefined) {
      const probe = volumeMakesSidecars(this.root);
      sidecars = probe.sidecars;
      if (probe.problem) {
        this.log(
          `Could not check whether the data folder's volume keeps file attributes in "._" files (${probe.problem}); ` +
            "the storage listing shows every \"._\" file. On exFAT, FAT or a network share that includes the ones macOS makes.",
        );
      }
    }
    this.sidecars = sidecars;
    if (this.sidecars) {
      this.log(
        "The data folder is on a volume where macOS keeps file attributes in \"._\" files (exFAT, FAT or a network share). " +
          "Such a \"._X\" file beside an \"X\" cannot be told from one an app archive brings, and the storage listing hides it. " +
          "For a listing exactly like the BUSY Bar's, keep the data folder on the system disk.",
      );
    }
    this.held = new Map(); // key → { counter, timer, lost }: buttons held down
    this.overdueAt = -Infinity; // performance.now() when the watchdog last stopped an app
    // The mode selector, for the device window. Moving it sends the position's key; the firmware's desktop in the
    // screen module switches to that mode's app (the apps menu in APPS, placeholders for the others).
    this.selector = "apps";
    // js_app_installer.c: one staged app at a time, unpacked in the installer's staging folder.
    this.staged = null; // { key, path }
    // The kinds of package ("apps/stage", "update") whose body is coming right now (see reception).
    this.packagesComing = new Set();
    this.running = null; // { id, runtime }
    this.screen = null; // set by start()
    // When the bar started: by the ticks' clock, which uptime counts from, and by the bar's own clock (boot_time).
    this.startedAt = computerNow();
    this.bootTime = computerTimeOfDay();
    // The bar is on. Powered off (the supervisor on an empty battery, the system settings), it shows nothing and
    // answers nothing until a button is pressed (powerOn).
    this.powered = true;
    this.boots = 0; // counts restarts: what an app of an earlier boot reports is dropped
    // brightness: "auto" or "0".."100". wifi, usb and battery are what the device window switches (setStatus).
    // timezone is the bar's zone as GET /api/time/timezone gives it; clockOffset is how far, in ms, the bar's clock
    // was set from the computer's (POST /api/time/timestamp).
    this.state = {
      name: DEFAULT_NAME, brightness: "auto", volume: 50, timezone: { name: "Universal", offset: "+00:00", abbr: "UTC" },
      wifi: true, usb: true, battery: 100, clockOffset: 0,
    };
    // ms that passed at once (passTime) since the screen module started: its clock, and the bar's with it, is that
    // far ahead of the computer's, beside clockOffset.
    this.passed = 0;
    // The status lights as the firmware last lit them (lightsChanged), and what the device window was last told.
    this.lights = LIGHTS_OFF;
    this.lightsShown = null;
    // Who may use the API over Wi-Fi, and the tokens for it.
    this.access = new Access();
    // The speaker; the device window plays what it starts.
    this.audio = new AudioPlayer((p) => this.readFile(p), (text) => this.log(text));
    mkdirSync(this.appsDir(), { recursive: true });
    this.settleReplaced();
  }

  async start() {
    this.screen = await Screen.create({
      firmware: this.firmware,
      readFile: (p) => this.readFile(p),
      writeFile: (p, b) => this.writeFile(p, b),
      listDir: (p) => this.listDir(p),
      remove: (p) => this.removePath(p),
      onAppStart: (runId, id, entry, heapBytes) => this.startApp(runId, id, entry, heapBytes),
      onAppAbort: () => this.running?.runtime.terminate("quit"),
      onAudioPlay: (path) => this.audio.playFile(path),
      onSettingChanged: (name, value) => this.settingChanged(name, value),
      onLights: (preset, rgb, override, started) => this.lightsChanged(preset, rgb, override, started),
      // The firmware hung in a wait that nothing ends and its system is halted (the line before this one in the log
      // says where). Restarting the bar is the emulator's own way out, not what a bar does: on a bar the thread would
      // go on waiting beside the others (furi_shim.c, "waits"); here nothing else would run again.
      onStuck: () => {
        this.log("The BUSY Bar's system is stuck and was stopped: this is a fault of the emulator, not of the app. The BUSY Bar restarts", "error");
        setTimeout(() => this.reboot("the system was stuck"), 0);
      },
      barSpeed: !!this.speed,
      clockHost: this.clockHost,
      timezone: () => this.state.timezone.name,
      barAddress: () => this.barAddress(),
      // GUI errors: often an app's draw request (an image that does not decode), so they are shown as warnings.
      onLog: (level, tag, text) => level <= 2 && this.log(`[${tag}] ${text}`, "warn"),
    });
    // Closed while the screen module was loading: it goes down at once.
    if (this.closed) return this.shutdown();
    this.screen.status({ volume: this.state.volume });
    if (!this.zoneTimer) {
      // A zone's offset changes with daylight saving time.
      this.zoneTimer = setInterval(() => this.powered && this.refreshTimezone(), 60000);
      this.zoneTimer.unref();
      await this.useHostTimezone();
    }
    // The bar is up once its GUI has drawn the first frame on both displays (Screen.firstFrame), a tick or two from
    // here: until then the system is not as a bar's is when its web server answers, and a request to it could go
    // wrong (EMU-253). What waits for start() — the server's readiness, requests during a restart — waits for this.
    // A system that has not drawn in a few seconds of its clock never will: start() fails with the reason.
    await this.screen.firstFrame();
  }

  // ---------------------------------------------------------------- power
  //
  // A restart is a new screen module: the firmware's system starts again, as on a bar. What a bar keeps over a
  // restart is kept: installed apps and their settings (the files), the name, volume, brightness, time zone and the
  // clock; Wi-Fi, USB and the battery are as the device window has them, the mode selector where it stands.

  /** The running app and the system stop; the displays go dark. */
  shutdown() {
    this.boots++;
    for (const state of this.held.values()) clearInterval(state.timer);
    this.held.clear();
    clearTimeout(this.resetTimer);
    this.resetTimer = null;
    const app = this.running;
    this.running = null;
    app?.runtime.terminate("power");
    this.audio.stop();
    // The time that passed at once was in the clock of the screen module that goes: the bar's clock keeps it.
    this.state.clockOffset += this.passed;
    this.passed = 0;
    this.screen.dispose();
    this.screen = darkScreen();
    // The lights go out with the system.
    this.lights = LIGHTS_OFF;
    this.showLights(false);
    this.events.emit("apps");
  }

  /**
   * The emulator lets go of the bar (the server stops): the app and the system stop as when the bar goes down, and
   * nothing starts them again or asks them anything. After this no timer of the bar is left. A restart that was
   * under way cannot be called off: its screen module goes down as soon as it has loaded, and the promise this
   * returns is kept when that is done (at once if there was none).
   */
  close() {
    this.closed = true;
    clearInterval(this.zoneTimer);
    // Before start() there is no screen module yet; one that is loading goes down when it is there (start).
    if (this.screen) this.shutdown();
    return Promise.resolve(this.booting).catch(() => {});
  }

  /** The bar restarts: the supervisor after a fatal JS error, the system settings, or the device window. */
  async reboot(why = "restart") {
    if (this.closed) return;
    if (this.booting) return this.booting;
    this.log(`The BUSY Bar restarts (${why})`, "system");
    this.staged = null; // the installer keeps its key in memory (js_app_installer.c)
    this.shutdown();
    // A restart whose system never draws its first frame (Screen.firstFrame) leaves the bar off, and says why.
    this.booting = this.boot().catch((e) => {
      if (e?.code !== "EMU_FIRST_FRAME") throw e;
      if (this.closed) return;
      this.log(`The BUSY Bar is off after a restart. ${e.message} Press one of its buttons to try again.`, "error");
      this.shutdown();
      this.powered = false;
      this.events.emit("status");
    });
    try {
      await this.booting;
    } finally {
      this.booting = null;
    }
  }

  async boot() {
    this.powered = true;
    this.startedAt = computerNow();
    this.bootTime = this.barTime();
    await this.start();
    const s = this.state;
    this.screen.status({ wifi: s.wifi ? WifiState.connected : WifiState.disconnected, usb: s.usb, charge: s.battery, charging: this.charging(), volume: s.volume });
    // The firmware's services start with their defaults; the bar's kept settings go back into them.
    if (s.name !== DEFAULT_NAME) await this.screen.request("POST", "name", "", new TextEncoder().encode(JSON.stringify({ name: s.name })));
    if (s.clockOffset) {
      const stamp = new Date(this.barTime()).toISOString().slice(0, 19) + "Z";
      await this.screen.request("POST", "time/timestamp", `timestamp=${stamp}`, null);
    }
    if (this.selector !== "apps") this.pressKey(this.selector);
    this.events.emit("apps");
    this.events.emit("status");
  }

  /** The bar powers off: dark until a button is pressed. */
  powerOff(why = "power off") {
    if (!this.powered || this.closed) return;
    this.log(`The BUSY Bar powers off (${why}); press a button to turn it on`, "system");
    this.shutdown();
    this.powered = false;
    this.events.emit("status");
  }

  powerOn() {
    return this.powered ? null : this.reboot("power on");
  }

  /** A request to one of the firmware's own API handlers, answered as JSON. */
  async firmwareJson(path) {
    const { status, body } = await this.screen.request("GET", path, "", null);
    return status === 200 ? JSON.parse(new TextDecoder().decode(body)) : null;
  }

  /**
   * The bar's zone at start: the computer's, so that apps show the local time. The firmware names zones by city: the
   * one named as the computer's zone if it has it, otherwise the first with the computer's offset.
   */
  async useHostTimezone() {
    const zones = (await this.firmwareJson("time/tzlist"))?.list ?? [];
    const offset = -new Date().getTimezoneOffset();
    const city = Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop().replaceAll("_", " ");
    const same = zones.filter((z) => offsetMinutes(z.offset) === offset);
    const zone = same.find((z) => z.name === city) ?? same[0];
    if (zone) this.state.timezone = zone;
  }

  /** The zone's offset and abbreviation as they are now, from the firmware's zone rules. */
  async refreshTimezone() {
    const zone = await this.firmwareJson("time/timezone");
    if (zone?.name === this.state.timezone.name) this.state.timezone = zone;
  }

  // ---------------------------------------------------------------- the state around the app

  /** Minutes east of UTC of the bar's time zone. */
  tzOffsetMin() {
    return offsetMinutes(this.state.timezone.offset);
  }

  /** On USB the battery charges until it is full. */
  charging() {
    return this.state.usb && this.state.battery < 100;
  }

  /**
   * Wi-Fi, USB and the battery, from the device window or POST /_emu/status: { wifi?: boolean, usb?: boolean,
   * battery?: 0..100 }. The status bar, /api/status/power, /api/wifi/status and the app's requests to the network
   * follow.
   */
  setStatus(change) {
    if (typeof change.wifi === "boolean") this.state.wifi = change.wifi;
    if (typeof change.usb === "boolean") this.state.usb = change.usb;
    if (Number.isFinite(change.battery)) this.state.battery = Math.max(0, Math.min(100, Math.round(change.battery)));
    const s = this.state;
    this.screen.status({ wifi: s.wifi ? WifiState.connected : WifiState.disconnected, usb: s.usb, charge: s.battery, charging: this.charging() });
    this.events.emit("status");
  }

  // ---------------------------------------------------------------- the status lights
  //
  // The firmware starts a preset of the status lights (status_lights_run_preset: the BUSY timer, the brightness
  // program, pairing, an app's draw with led_notification_color) and the screen module tells the host at once
  // (emu_screen.c). On a bar the other processor then runs it (status_lights_backend.c) at the brightness the
  // brightness control gives the lights: round(5 + 85 × user brightness / 100) %, or full for a notification. Here the
  // device window runs the preset's look; the server keeps what was started and says it in the event "lights"
  // { preset, color: "#rrggbb", brightness: 0..1 } and in /_emu/state.

  /** The screen module's report (emu_screen.c, host_lights): a preset started, or a program's hold on the brightness. */
  lightsChanged(preset, rgb, override, started) {
    if (started) this.lights = { preset: LIGHT_PRESETS[preset] ?? "off", rgb, override, at: this.barClock() };
    else this.lights = { ...this.lights, override };
    this.showLights(started);
  }

  /** The system's clock, Unix ms, read without moving it: it may be read from inside a call into the module. */
  barClock() {
    return this.screen?.clock?.now() ?? computerNow();
  }

  /**
   * The status lights as they are now: { preset, color: "#rrggbb", brightness: 0..1 }. brightness is the level the
   * lights run the preset at, the firmware's own 0..100 % over 100: 0.05 to 0.9 by the brightness setting, 1 for a
   * notification. A notification that is over is "off".
   */
  lightsState() {
    const { rgb, override, at } = this.lights;
    let { preset } = this.lights;
    if (preset === "notification" && this.barClock() - at >= NOTIFICATION_MS) preset = "off";
    const user = override >= 0 ? override : this.state.brightness === "auto" ? AUTO_BRIGHTNESS : Number(this.state.brightness);
    const brightness = preset === "notification" ? 1 : Math.round(5 + (85 * Math.min(100, Math.max(0, user))) / 100) / 100;
    const color = preset === "off" ? "#000000" : `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    return { preset, color, brightness };
  }

  /**
   * Tells the device window when the lights change: always for a preset the firmware started (a second notification
   * blinks again, as on a bar), otherwise only when a preset that is on shows a new brightness.
   */
  showLights(started) {
    const shown = this.lightsState();
    const last = this.lightsShown;
    if (!started) {
      if (!last || shown.preset === "notification") return;
      if (shown.preset === last.preset && shown.color === last.color && shown.brightness === last.brightness) return;
      // Dark already: nothing to tell.
      if (shown.preset === "off" && (last.preset === "off" || last.preset === "notification")) return;
    }
    this.lightsShown = shown;
    this.events.emit("lights", shown);
  }

  /**
   * A settings program on the device changed a setting (host_setting_changed in the screen module): the state the API
   * answers from follows. Called from inside the screen module, so what goes back into it waits for it to return.
   */
  settingChanged(name, value) {
    if (name === "volume") {
      this.state.volume = Number(value);
      this.events.emit("volume");
      queueMicrotask(() => this.screen.status({ volume: this.state.volume }));
    } else if (name === "brightness") {
      this.state.brightness = value;
      this.showLights(false);
    } else if (name === "timezone") {
      // The name at once: the firmware asks the host for it. The offset comes from the firmware's rules.
      this.state.timezone = { ...this.state.timezone, name: value };
      queueMicrotask(() => this.refreshTimezone());
    } else if (name === "wifi") {
      queueMicrotask(() => this.setStatus({ wifi: value !== "0" }));
    } else if (name === "ble") {
      // The Bluetooth service of the screen module holds the state; the host's copy only follows it.
      this.screen.noteStatus({ ble: value === "1" ? BleStatus.advertising : BleStatus.ready });
      this.events.emit("status");
    } else if (name === "name") {
      this.state.name = value;
      this.events.emit("status");
    } else if (name === "clock") {
      this.state.clockOffset = Number(value);
      this.log(this.state.clockOffset ? `The BUSY Bar's clock was set: ${new Date(this.barTime()).toISOString()}` : "The BUSY Bar's clock was set to the computer's", "system");
    } else if (name === "power") {
      // Asked from inside the screen module, which goes away: after it returns.
      setTimeout(() => (value === "off" ? this.powerOff() : this.reboot()), 0);
    } else if (name === "factory_reset") {
      // A bar erases its data and restarts. The emulated bar only restarts: its apps and settings are the files in
      // the data folder, which the emulator does not delete on its own.
      this.log("Settings: factory reset asked; the emulator keeps its data", "warn");
      setTimeout(() => this.reboot("factory reset"), 0);
    }
  }

  /** GET /api/status/power (api_status.c). The voltages and the current are plausible, not measured. */
  power() {
    const s = this.state;
    return {
      state: this.charging() ? "charging" : s.usb ? "charged" : "discharging",
      battery_charge: s.battery,
      battery_voltage: 3500 + 7 * s.battery,
      battery_current: this.charging() ? 1500 : s.usb ? 0 : -120,
      usb_voltage: s.usb ? 4940 : 0,
    };
  }

  /**
   * The bar's clock, Unix ms: the one the firmware's own code reads (the screen module's real-time clock), which an
   * app's Date.now(), the state stream and every answer of the device go by too (EMU-235). The computer's time of day
   * as the bar follows it (computer-clock.mjs), and how far the bar's clock was set from it (POST
   * /api/time/timestamp). While the bar is off, the same without the screen module; while the device is being made
   * (a line of the log before its state), the computer's time of day.
   */
  barTime() {
    return (this.screen?.rtcNow?.() ?? computerTimeOfDay()) + (this.state?.clockOffset ?? 0);
  }

  /**
   * Time passes at once (POST /_emu/time?pass=ms; busy-emulator time advance): what would be true after waiting `ms`
   * is true now. The bar's clock is `ms` on; the firmware's system has lived through them (the screen module's ticks
   * and timers are carried out: an animation, a scrolling text, a countdown element, an element's timeout, the BUSY
   * timer); the running app's Date.now() is `ms` on and its timers count from there (runtime.mjs, skip). What does
   * not hurry: the app's JS itself and its requests to the network. Returns the ms the clock moved: `ms` but for the
   * fraction the move itself took; 0 while the bar is off.
   */
  passTime(ms) {
    if (!this.powered || this.closed || !this.screen?.M) return 0;
    const moved = this.screen.pass(ms);
    if (!(moved > 0)) return 0;
    this.passed += moved;
    this.running?.runtime.skip(moved);
    this.log(`Time passed at once: ${Math.round(ms / 1000)} s. The BUSY Bar's clock: ${new Date(this.barTime()).toISOString()}`, "system");
    return moved;
  }

  /** The parts of GET /api/status, each also an endpoint of its own. */
  status() {
    const seconds = Math.floor((computerNow() - this.startedAt) / 1000);
    const p = (n) => String(n).padStart(2, "0");
    return {
      device: {
        serial_number: "EMULATOR", usb_mac: "02:00:00:00:00:01", wifi_mac: "02:00:00:00:00:02", ble_mac: "02:00:00:00:00:03",
        otp_valid: true, otp_model: "BB.1", otp_timestamp: 0, firmware_security: "emulator",
      },
      firmware: {
        version: this.firmware.name, target: 22, branch: "emulator", build_date: this.firmware.buildDate, commit_hash: this.firmware.info.firmware,
        intercom_version: this.firmware.info.firmware, nwp_version: "", matter_version: "1.0",
      },
      // api_status.c prints the hours without the days taken out; so does this.
      system: {
        api_semver: this.firmware.apiVersion,
        uptime: `${p(Math.floor(seconds / 86400))}d ${p(Math.floor(seconds / 3600))}h ${p(Math.floor(seconds / 60) % 60)}m ${p(seconds % 60)}s`,
        boot_time: Math.floor(this.bootTime / 1000),
        auto_update_enabled: false,
      },
      power: this.power(),
    };
  }

  // ---------------------------------------------------------------- the /ext file system

  /** Device path (/ext/...) → local path; null outside /ext. */
  /**
   * The file in the data folder for a path of the bar's /ext, or null. A path that leads out of the data folder's ext
   * — through a link in it — is null too (ADR-0012 §6, path-boundary.mjs): every read and write of the storage API
   * comes through here. The answer is the path as the bar names it, under the data folder: a link is never made by the
   * bar's API, so what was checked is what is used.
   */
  local(path) {
    if (path !== "/ext" && !path.startsWith("/ext/")) return null;
    const ext = resolve(this.root, "ext");
    const p = resolve(ext, path.slice(5));
    if (p !== ext && !p.startsWith(ext + sep)) return null;
    return insideRoots(p, [ext], { missing: true }) === null ? null : p;
  }

  readFile(path) {
    // /ext/apps_assets is the firmware's own and the same for every data folder (packages/engine/build/apps-assets).
    if (path.startsWith("/ext/apps_assets/")) {
      const asset = resolve(appsAssets, path.slice("/ext/apps_assets/".length));
      return within(asset, appsAssets) && existsSync(asset) && statSync(asset).isFile() ? new Uint8Array(readFileSync(asset)) : null;
    }
    const p = this.local(path);
    return p && existsSync(p) && statSync(p).isFile() ? new Uint8Array(readFileSync(p)) : null;
  }

  writeFile(path, bytes) {
    const p = this.local(path);
    if (!p) return false;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    return true;
  }

  listDir(path) {
    const p = this.local(path);
    if (!p || !existsSync(p) || !statSync(p).isDirectory()) return null;
    // In the order the entries were made, as a FAT directory lists them on the bar: the apps menu shows apps in the
    // order they were installed. "._name" files are listed like any other, as the bar lists the ones an app archive
    // made on macOS brings (EMU-223) — except on a volume where macOS makes its own (volume.mjs).
    // The order is read from the time each entry was made, so it holds as far as the volume tells two times apart:
    // entries made within one step of its clock come in the volume's own order. The step is 10 ms on exFAT and was
    // 0.5 or 1 ms on NTFS where it was measured (EMU-228; 15.6 ms is the Windows default); APFS has none to speak
    // of. An order kept by the emulator itself is EMU-015.
    const entries = readdirSync(p, { withFileTypes: true });
    const shown = new Set(visibleNames(entries.map((d) => d.name), this.sidecars));
    return entries
      .filter((d) => shown.has(d.name))
      .map((d) => ({ name: d.name, dir: d.isDirectory(), born: statSync(join(p, d.name)).birthtimeMs }))
      .sort((x, y) => x.born - y.born)
      .map(({ name, dir }) => ({ name, dir }));
  }

  removePath(path) {
    const p = this.local(path);
    if (!p || !existsSync(p)) return false;
    rmSync(p, { recursive: true, force: true });
    return true;
  }

  appsDir() {
    return join(this.root, "ext", "user_assets");
  }

  manifest(id) {
    const p = join(this.appsDir(), id, "appmeta", "manifest.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  }

  /** api_apps.c serialize_app_info, for the app in `dir` (a path of the bar); js_app.c:83–99 for the icon. */
  appInfo(m, dir = `/ext/user_assets/${m.id}`) {
    const icon = `${dir}/appmeta/icon_front_8x8.png`;
    const iconFile = this.local(icon);
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      api_version: m.api_version,
      author: m.author ?? "",
      description: m.description ?? "",
      is_debug: m.debug === true,
      icon_path: iconFile && existsSync(iconFile) && statSync(iconFile).isFile() ? icon : "/ext/apps_assets/shared/images/unknown_app_front_8x8.image",
    };
  }

  installedApps() {
    return this.listDir("/ext/user_assets")
      .filter((d) => d.dir)
      .map((d) => this.manifest(d.name))
      .filter(Boolean);
  }

  // ---------------------------------------------------------------- settings (lib/js_app/js_app_settings.c)

  /**
   * The app's settings schema: null when the app has no settings file. Throws for a file the firmware's parser
   * refuses (projects/settings-schema.mjs): one that is not JSON, one that is not a valid schema, one nested deeper
   * than a schema can be. The file's text is checked, depth first, before anything walks the parsed value: a file of
   * twenty thousand nested groups must be a refused schema, not a stack overflow in whatever reads it next.
   */
  settingsSchema(id) {
    const p = join(this.appsDir(), id, "appmeta", "settings.json");
    if (!existsSync(p)) return null;
    const check = checkSettingsSchema(readFileSync(p, "utf8"), { strict: false });
    if (!check.ok) throw new Error(`appmeta/settings.json of ${id} is invalid: ${check.problem}`);
    return check.schema;
  }

  settingsPath(id) {
    // lib/js_app/js_app_settings_storage.c: where the launcher's settings screen and the local web both keep them.
    return join(this.root, "ext", "apps_data", "jsrunner", `${id}.settings.json`);
  }

  /**
   * The stored document, or one materialized from the defaults when there is none, it is not JSON or the schema
   * version changed. Written as the firmware writes it, by cJSON_Print() (setting_provider.c storage_flush_json).
   */
  settingsDocument(id) {
    const schema = this.settingsSchema(id);
    if (!schema) return null;
    const p = this.settingsPath(id);
    // setting_provider_load(): a file that does not parse is reset to the defaults. The emulator does the same, but
    // keeps the broken file aside and says so: the values a person typed in (tokens) are not lost without a word.
    const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const read = readJsonFile(p, { check: (doc) => isObject(doc) && isObject(doc.values) });
    if (read.value?.version === schema.version) return read.value;
    if (read.corrupt) {
      const aside = setAside(p);
      this.log(`The settings of ${id} could not be read (${read.corrupt}): they are back at the defaults, as on a BUSY Bar. The broken file is kept as ${aside}`, "warn");
    }
    const doc = { version: schema.version, values: defaults(schema.fields) };
    writeFileAtomic(p, cjsonPrint(doc));
    return doc;
  }

  // ---------------------------------------------------------------- apps

  /**
   * The manifest of an app folder when the firmware would load an app from it (js_app_load_from_directory), else null.
   * `name` is the folder's name on the bar, when the folder on the disk goes by another.
   */
  loadApp(dir, name = basename(dir)) {
    const isFile = (p) => existsSync(p) && statSync(p).isFile(); // storage_file_exists
    const manifestPath = join(dir, "appmeta", "manifest.json");
    if (!isFile(manifestPath) || !isFile(join(dir, "scripts", "main.js"))) return null;
    let m;
    try {
      m = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return null;
    }
    const valid =
      m && m.format_version === 1 && m.id === name && APP_ID_RE.test(name) && typeof m.name === "string" &&
      SEMVER_RE.test(m.version ?? "") && SEMVER_RE.test(m.api_version ?? "") &&
      (m.heap_size_kib === undefined || (m.heap_size_kib >= 1 && m.heap_size_kib <= 512));
    return valid ? m : null;
  }

  installerDir() {
    return join(this.root, "ext", "apps_data", "js_app_installer");
  }

  stagingDir() {
    return join(this.installerDir(), "staging");
  }

  replacedDir() {
    return join(this.installerDir(), "replaced");
  }

  /**
   * Whether a folder of the bar, links followed, is inside the data folder (ADR-0012 §6). For a folder that is not
   * there yet the answer is for the nearest one above it that is — where making the rest would put it — so it is
   * asked before anything is made.
   */
  insideData(p) {
    return insideRoots(p, [this.root], { missing: true }) !== null;
  }

  /**
   * POST /api/apps/stage (api_apps.c handle_completed_upload, js_app_installer.c handle_stage): the package is
   * unpacked whole into the staging folder, then the folders at its top are tried in the order they were made and the
   * first that holds an app is staged. Files at the top, such as the "._<id>" that macOS tar adds, are not looked at;
   * everything inside the app folder, "._*" files included, is installed (checked on a bar, 10.11).
   */
  stage(bytes) {
    // api_apps.c:254–259, 268–277: an empty body and a package over 100 MiB are refused from the headers, before the
    // installer is asked, so the package staged before stays staged.
    if (bytes.length === 0) return error(400, "Bad Request");
    if (bytes.length > 100 * 1024 * 1024) return error(413, "Payload Too Large");
    this.staged = null;
    const staging = this.stagingDir();
    let topDirs;
    try {
      if (!this.insideData(this.installerDir())) throw new UnpackError("the installer's folder leads out of the data folder");
      mkdirSync(this.installerDir(), { recursive: true });
      emptyFolder(staging);
      const unpacked = unpackPackage(bytes, staging);
      topDirs = unpacked.topDirs;
      unpacked.notes.forEach((line) => this.log(`App package: ${line}`));
    } catch (e) {
      (e?.notes ?? []).forEach((line) => this.log(`App package: ${line}`));
      this.log(`Cannot unpack the app package: ${e?.message ?? e}${isBusy(e) ? IN_USE : ""}`, "error");
      return error(400, "Cannot unpack", { error_code: "unpack_error" });
    }
    for (const name of topDirs) {
      const m = this.loadApp(join(staging, name));
      if (!m) continue;
      // All errors of a stage are 400 (api_apps.c:120–124; checked on a bar, 1.3.1 — the firmware's apps.yaml says 409).
      if (!semverLE(m.api_version, this.firmware.apiVersion)) {
        this.log(`Cannot install ${m.id}: it needs API ${m.api_version}, and the BUSY Bar has API ${this.firmware.apiVersion}`, "error");
        return error(400, "API version mismatch", { error_code: "api_mismatch" });
      }
      const key = 1 + Math.floor(Math.random() * 0x7ffffffe);
      this.staged = { key, path: join(staging, name) };
      const installed = this.manifest(m.id);
      return json(200, { result: "OK", install_key: key, staged: this.appInfo(m, `/ext/apps_data/js_app_installer/staging/${name}`), ...(installed ? { installed: this.appInfo(installed) } : {}) });
    }
    this.log("Cannot install the app package: it has no app folder with scripts/main.js and a valid appmeta/manifest.json (whose id is the folder's name)", "error");
    return error(400, "Wrong app manifest", { error_code: "manifest_error" });
  }

  /**
   * Clears js_app_installer/replaced, where an install keeps the version it is replacing (replaceFolder). A version
   * left there by an install that did not finish goes back to its place when nothing stands there; anything else —
   * a version whose place is taken, one that was only waiting to be deleted (replaced.done), a folder that holds no
   * app, a link — is deleted. Done when the emulator starts and before every install.
   */
  settleReplaced() {
    const aside = this.replacedDir();
    const mark = `${aside}.done`;
    try {
      if (!standsAt(aside) && !standsAt(mark)) return;
      if (!this.insideData(this.installerDir()) || !this.insideData(this.appsDir())) return;
      if (standsAt(aside) === "dir" && !standsAt(mark)) {
        let id;
        try {
          id = JSON.parse(readFileSync(join(aside, "appmeta", "manifest.json"), "utf8")).id;
        } catch {}
        const m = typeof id === "string" && APP_ID_RE.test(id) ? this.loadApp(aside, id) : null;
        if (m && !standsAt(join(this.appsDir(), id))) {
          retrying(() => renameSync(aside, join(this.appsDir(), id)));
          this.log(`Put ${id} ${m.version} back: an install that did not finish had moved it aside`, "app");
          this.events.emit("apps");
          return;
        }
      }
      retrying(() => rmSync(aside, { recursive: true, force: true }));
      rmSync(mark, { force: true });
    } catch (e) {
      this.log(`Cannot clear what an install left in /ext/apps_data/js_app_installer/replaced: ${e?.message ?? e}`);
    }
  }

  /**
   * POST /api/apps/install (api_apps.c:325–360, js_app_installer.c handle_install): the staged app folder takes the
   * installed one's place. Unlike the bar, which deletes the old folder and then moves the new one in, the old folder
   * is moved aside (js_app_installer/replaced) first and is moved back if the new one cannot be moved in. If moving it
   * back fails too, or the emulator stops between the two moves, the old version waits in replaced/ and
   * settleReplaced puts it back — before the next install, or when the emulator starts. (A bar, by the firmware's
   * code, has deleted the old version by then and is left with none.)
   */
  install(key) {
    const staged = this.staged;
    if (!staged || installKey(key) !== staged.key) return error(400, "Bad Request");
    this.staged = null;
    const m = this.loadApp(staged.path);
    let done = false;
    if (m) {
      const id = m.id;
      if (this.running?.id === id) {
        // On the bar this install fails while the app plays an animation (firmware bug "Cannot delete app").
        this.log(`App ${id} was running; quitting it before install (on the BUSY Bar, stop the app first)`, "warn");
        this.quit();
      }
      try {
        mkdirSync(this.appsDir(), { recursive: true });
        if (!this.insideData(this.appsDir())) throw new Error("the apps folder leads out of the data folder");
        this.settleReplaced();
        replaceFolder(staged.path, join(this.appsDir(), id), this.replacedDir());
        done = true;
        this.log(`Installed ${id} ${m.version}`, "app");
        this.events.emit("apps");
      } catch (e) {
        this.log(`Cannot install ${id}: ${e?.message ?? e}${isBusy(e) ? IN_USE : ""}`, "error");
      }
    }
    try {
      emptyFolder(this.stagingDir());
    } catch (e) {
      this.log(`Cannot empty the installer's staging folder: ${e?.message ?? e}`);
    }
    return done ? ok() : error(400, "Bad Request");
  }

  remove(id) {
    if (!id || !APP_ID_RE.test(id)) return error(400, "Bad Request");
    if (!this.manifest(id)) return error(404, "Not Found");
    if (this.running?.id === id) this.quit();
    rmSync(join(this.appsDir(), id), { recursive: true, force: true });
    this.log(`Removed ${id} (settings kept)`, "app");
    this.events.emit("apps");
    return ok();
  }

  // Apps start and stop through the firmware's JS app launcher in the screen module, as POST /api/apps/launch and
  // /quit do on the bar (api_apps.c); the launcher then asks for the app to be run (startApp) or aborted.
  launch(id) {
    if (!id || !APP_ID_RE.test(id)) return error(400, "Bad Request");
    const m = this.manifest(id);
    if (!m) return error(404, "Not Found");
    if (!semverLE(m.api_version, this.firmware.apiVersion)) return error(409, "API version mismatch, please update firmware");
    const status = this.screen.launch(id);
    if (status === LauncherStatus.ok) return ok();
    if (status === LauncherStatus.lowPriority) return error(409, "not started due to low priority");
    return error(503, "failed to launch application");
  }

  quit() {
    const status = this.screen.quit();
    if (status === LauncherStatus.ok) return ok();
    if (status === LauncherStatus.notRunning) return error(409, "application is not running");
    return error(503, "failed to quit from application");
  }

  /** The launcher runs an app: js_runner_run(). What happens to it goes back as js_runner's events. */
  async startApp(runId, id, entry, heapBytes) {
    // Said once for each port in a run: an app that polls a service of the author's would fill the console otherwise.
    const refusalsSaid = new Set();
    // The same for the bar's API refusing a request of the app: once for each request and answer in a run.
    const apiRefusalsSaid = new Set();
    // The notes on the app's requests to the network (network-notes.mjs): each once in a run.
    const networkSaid = new Set();
    const networkNote = (note) => {
      if (networkSaid.has(note)) return;
      networkSaid.add(note);
      this.log(`App ${id}: ${note}`, "warn");
    };
    const appLine = (text) => usesTextCodec(text) && networkNote(TEXT_CODEC_NOTE);
    const runtime = new AppRuntime({
      firmware: this.firmware,
      appId: id,
      heapKib: Math.round(heapBytes / 1024),
      entry,
      readFile: (p) => this.readFile(p),
      writeFile: (p, b) => this.writeFile(p, b),
      localApi: async (req) => {
        const answer = await this.handle(req.method, req.url, req.headers, req.body);
        const note = answer.status >= 400 ? apiRefusalNote(req.method, req.url, answer) : null;
        if (note && !apiRefusalsSaid.has(note)) {
          apiRefusalsSaid.add(note);
          this.log(`App ${id}: ${note}`, "warn");
        }
        return answer;
      },
      speed: this.speed,
      tzOffsetMin: () => this.tzOffsetMin(),
      // The app's Date.now(): the bar's clock, as the screen module's (barTime), on the app's own time.
      clockOffset: () => timeOfDayOffset() + this.state.clockOffset + this.passed,
      online: () => this.state.wifi,
      deviceKey: (url, method) => {
        const answer = deviceKeyAnswer(url, method, this.barTime());
        this.log(`App ${id}: ${method} ${url} asked with the device key, which the emulator does not have: ${answer ? "answered from the emulator's saved answer" : "sent without it"}`, "warn");
        return answer;
      },
      localAccess: this.localAccess,
      onRefused: (url, refusal) => {
        if (refusalsSaid.has(refusal.port)) return;
        refusalsSaid.add(refusal.port);
        this.log(explainRefusal({ appId: id, url, refusal }), "warn");
      },
      onRedirect: (redirect) => networkNote(redirectNote(redirect)),
      onNetworkError: (failure) => networkNote(networkErrorNote(failure)),
      onConsole: (severity, text) => {
        this.log(`${id} ${severity}: ${text}`, severity);
        appLine(text);
      },
      onUnhandled: (text) => {
        this.log(`App ${id}: ${UNHANDLED_NOTE}${text} (the BUSY Bar logs nothing for this)`, "error");
        appLine(text);
      },
      // The emulator's watchdog (runtime.mjs SLICE_LIMIT_MS): on a bar the loop would hold the app until a long Back.
      onOverdue: (ms) => {
        this.overdueAt = performance.now();
        this.log(`App ${id}: ${OVERDUE_NOTE(ms)}`, "error");
      },
      // FuriLogLevel: 2 error, 3 warning. The runtime's errors (a script that throws) are the app's errors.
      onLog: (level, tag, text) => {
        if (level > 3) return;
        this.log(`${id} [${tag}] ${text}`, level <= 2 ? "error" : "warn");
        appLine(text);
      },
      onExit: (reason) => this.onAppExit(id, runtime, reason),
    });
    const app = { id, runtime, runId, started: false, boot: this.boots };
    this.running = app;
    this.log(`Launch ${id} (heap ${Math.round(heapBytes / 1024)} KiB)`, "app");
    this.events.emit("apps");
    const status = await runtime.start();
    app.started = true;
    // The bar went down while the app was loading.
    if (app.boot !== this.boots) return;
    if (runtime.fatal) return this.jsFatal(app);
    // js_runner.c: a file or parse problem ends the run before it starts; a script that throws still started.
    if (status === 1) return this.screen.scriptFinished(runId, JsRunnerError.filesystem);
    if (status === 2 || status === 3) {
      const oom = /possibly out of memory/.test(runtime.startError ?? "");
      return this.screen.scriptFinished(runId, oom ? JsRunnerError.outOfMemory : JsRunnerError.parseException);
    }
    this.screen.scriptStarted(runId);
    if (runtime.exited) this.screen.scriptFinished(runId, this.exitError(runtime));
  }

  exitError(runtime) {
    return /out of memory/.test(runtime.exited) ? JsRunnerError.outOfMemory : JsRunnerError.none;
  }

  /**
   * The app's JS engine failed fatally: on a bar the app's thread never returns, the launcher goes on thinking the
   * app runs, and the supervisor takes over. A bar as owners have it restarts; in its first 30 seconds (and with the
   * debug flag) it shows "JS heap overflow" or "JS fatal error" instead and takes no input until it is restarted.
   */
  jsFatal(app) {
    const oom = app.runtime.fatal === "out of memory";
    this.log(`App ${app.id}: ${oom ? "JS heap overflow" : `JS fatal error (${app.runtime.fatal})`}: the supervisor takes over, as on a BUSY Bar`, "error");
    // Out of memory soon after a large response: most likely its parsing. Say so, and what to do instead.
    const response = oom ? app.runtime.largestResponse?.() : null;
    if (response && response.bytes >= MEMORY_NOTE_MIN_BYTES) this.log(`App ${app.id}: ${memoryNote({ heapKib: app.runtime.heapKib, response })}`, "error");
    this.screen.jsFatal(oom);
  }

  onAppExit(id, runtime, reason) {
    const app = this.running;
    const s = runtime.stats;
    this.log(`App ${id} exited: ${reason}; heap peak ${(s.heapPeak / 1024).toFixed(1)} of ${(s.heapSize / 1024).toFixed(0)} KiB`, "app");
    // After a fatal error the app stays "running" for the system, stuck; startApp tells the supervisor if the run
    // has not started yet.
    if (runtime.fatal && app?.runtime === runtime) {
      if (app.started) this.jsFatal(app);
      this.events.emit("apps");
      return;
    }
    if (app?.runtime === runtime) this.running = null;
    this.events.emit("apps");
    // Before the run has started, startApp reports how it ended.
    if (app?.runtime === runtime && app.started) queueMicrotask(() => app.boot === this.boots && this.screen.scriptFinished(app.runId, this.exitError(runtime)));
  }

  // ---------------------------------------------------------------- input

  /**
   * One event as the input service publishes it: to the running app (whose js_input.c leaves out what apps do not
   * get, such as a long Back) and to the system in the screen module, where the JS app launcher takes a long Back as
   * "leave the app" and canvas may take a short one as "leave the screen".
   */
  publishKey(key, type) {
    this.events.emit("key", key, type);
    this.running?.runtime.input(InputKey[key], InputType[type]);
    this.screen.input(InputKey[key], InputType[type]);
  }

  /** A button goes down (the device window holds it until keyUp). Keys are the names POST /api/input uses. */
  keyDown(key) {
    if (!API_KEYS.includes(key) || this.held.has(key) || this.closed) return false;
    if (!this.powered) {
      // The selector moves even on a bar that is off; a button turns it on.
      if (SELECTOR.includes(key)) this.selector = key;
      else this.powerOn();
      this.events.emit("selector");
      return true;
    }
    if (this.booting) return true;
    // Pressed while the app held the thread, before the watchdog stopped it: on a bar the hung app had the button,
    // and a long Back among such presses is the one the watchdog stood in for. It goes nowhere, so the apps menu the
    // bar is back in does not take it (a Back would leave the app's page there, an OK start the app again). The
    // selector is not a button: it moves.
    const lost = !SELECTOR.includes(key) && performance.now() - this.overdueAt < HELD_KEYS_MS;
    const state = { counter: 0, lost };
    state.timer = setInterval(() => {
      state.counter++;
      if (lost) return;
      if (state.counter === LONG_PRESS_COUNTS) this.publishKey(key, "long");
      else if (state.counter > LONG_PRESS_COUNTS) {
        state.counter--;
        this.publishKey(key, "repeat");
      }
    }, PRESS_TICK_MS);
    this.held.set(key, state);
    if (!lost) this.publishKey(key, "press");
    // Back and Start held together restart a bar whatever its software does (its screens say so when it is stuck).
    // How long they must be held is the emulator's choice.
    if (this.held.has("back") && this.held.has("start") && !this.resetTimer) {
      this.resetTimer = setTimeout(() => {
        this.resetTimer = null;
        if (this.held.has("back") && this.held.has("start")) this.reboot("Back and Start held");
      }, RESET_HOLD_MS);
    }
    return true;
  }

  keyUp(key) {
    const state = this.held.get(key);
    if (!state) return false;
    clearInterval(state.timer);
    this.held.delete(key);
    if (state.lost) return true;
    if (state.counter < LONG_PRESS_COUNTS) this.publishKey(key, "short");
    this.publishKey(key, "release");
    return true;
  }

  /**
   * A press and release at once, as POST /api/input and a wheel click do (input_key_toggle): press, short, release.
   * With `long`, the button is held past the long-press time first.
   */
  pressKey(key, long = false) {
    if (!this.keyDown(key)) return false;
    // A bar that is off or starting took the press as "turn on" or let it pass.
    if (!this.held.has(key)) return true;
    if (SELECTOR.includes(key)) {
      this.selector = key;
      this.events.emit("selector");
    }
    if (long) {
      this.held.get(key).counter = LONG_PRESS_COUNTS;
      if (!this.held.get(key).lost) this.publishKey(key, "long");
    }
    return this.keyUp(key);
  }

  // ---------------------------------------------------------------- HTTP API

  /**
   * What an API request is refused with before it gets to its route, or null: a bar that is not up, a request of an
   * app to a route apps may not use, a client made for another major version of the API. `path` is the part after
   * /api/, `headers` are lower-case.
   */
  async refusal(method, path, query, headers) {
    // A bar that restarts answers once it is up; a bar that is off does not answer at all.
    if (this.booting) await this.booting;
    // Let go of meanwhile, or before (close): nothing is done for a request any more.
    if (this.closed) return error(503, "The emulator has stopped");
    if (!this.powered) return error(503, "The emulated BUSY Bar is powered off: press one of its buttons to turn it on");
    if (headers["x-busybar-fetch"] === "js") {
      const allowed = APP_ALLOWLIST.some(([p, kind, methods]) =>
        (kind === "exact" ? path === p : path === p || path.startsWith(p + "/")) && methods.includes(method));
      if (!allowed) return error(403, "Forbidden");
    }
    // api_root.c's http_api_is_version_allowed(): a client that names the API version it was made for is refused if
    // the major version is another; /api/version itself always answers.
    const clientVersion = headers["x-api-sem-ver"];
    if (clientVersion !== undefined && path !== "version") {
      const major = /^(\d+)\./.exec(clientVersion)?.[1];
      if (major === undefined || Number(major) > 255) return error(400, "Bad Request");
      if (Number(major) !== Number(this.firmware.apiVersion.split(".")[0])) return error(405, "Incompatible API version");
    }
    return null;
  }

  /**
   * How the body of an API request is to be taken in: decided from the request line and the headers, before any of
   * the body is read, as the bar's web server decides it once the headers have come (web_server.c on MG_EV_HTTP_HDRS:
   * api_root.c's http_api_root_hdr_callback, then the on_headers callback of the route). Four routes take a file as
   * the body of a POST (see PACKAGE_MAX); for any other request it is null: the server takes the body in whole, within
   * its own limit, and hands it to handle(). For those four:
   *   { answer }                    the answer, given from the headers: the body is not read
   *   { limit, timeout, done }      the body, `limit` bytes as Content-Length announces them, is taken in whole and
   *                                 handed to handle(); done() once that is over, or the body did not come
   *   { upload, timeout }           the body goes into a file as it comes (files-api.mjs's openUpload)
   * `timeout` is { ms, answer }: a body that stops coming for that long is answered so. As on the bar, the
   * connection is closed after every answer to these requests.
   */
  async reception(method, url, headers) {
    const u = new URL(url, "http://localhost");
    const path = u.pathname.replace(/^\/api\/?/, "");
    if (method !== "POST" || !["apps/stage", "update", "storage/write", "assets/upload"].includes(path)) return null;
    const refused = await this.refusal(method, path, u.searchParams, headers);
    if (refused) return { answer: refused };
    // mongoose's mg_http_parse: a request without Content-Length has no body (one sent in chunks is not read).
    const length = Number(headers["content-length"] ?? 0);
    if (path === "apps/stage" || path === "update") {
      // api_apps.c:254–277, api_update.c:340–364: from the headers, an empty package is 400 and one over 100 MiB 413;
      // the installer is not asked, so a package staged before stays staged with its key (checked on a bar, 1.3.1).
      // After the 413 the bar sends a second answer on the same connection, 508 "Failed to save update package
      // (write error).": its data callback, set up before the size is checked, tries to write what is still in the
      // receive buffer (the headers, and what has come of the body) to a file that was never made. That is a fault
      // of the firmware, not its API, and the emulator does not repeat it.
      if (length === 0) return { answer: errorLine(400, "Bad Request") };
      if (length > PACKAGE_MAX) return { answer: errorLine(413, "Payload Too Large") };
      // The bar takes a package into one file of its own (JS_APP_DOWNLOAD_PATH, UPDATER_DEFAULT_DOWNLOAD_PATH), open
      // until the package has been handled; another package meanwhile cannot open it (temp_file_create fails with
      // FSE_ALREADY_OPEN) and is refused from its headers. Here the package is held in memory, so this also keeps
      // what the server holds to one package of each kind.
      if (this.packagesComing.has(path)) return { answer: errorLine(508, "Failed to save update package (file init error).") };
      this.packagesComing.add(path);
      return { limit: length, timeout: { ms: PACKAGE_IDLE_MS, answer: errorLine(408, "Upload timeout") }, done: () => this.packagesComing.delete(path) };
    }
    const target = uploadTarget(path, u.searchParams);
    if (!target) return { answer: errorLine(400, "Bad Request") };
    const upload = openUpload(this, target.path, target.append);
    if (upload.answer) return { answer: upload.answer };
    // http_upload_start: with nothing to come, the file is written at once.
    if (length === 0) return { answer: upload.finish() };
    return { upload, timeout: { ms: FILE_IDLE_MS, answer: errorLine(408, "Upload timeout") } };
  }

  /** Handles one API request. `headers` are lower-case. Returns { status, headers, body }. */
  async handle(method, url, headers = {}, body = null) {
    const u = new URL(url, "http://localhost");
    const path = u.pathname.replace(/^\/api\/?/, "");
    const q = (name) => u.searchParams.get(name);
    const refused = await this.refusal(method, path, u.searchParams, headers);
    if (refused) return refused;
    const fromApp = headers["x-busybar-fetch"] === "js";
    const text = () => (body ? new TextDecoder().decode(body) : "");

    // The firmware's own handlers, in the screen module.
    if (FIRMWARE_API.some((p) => path === p || path.startsWith(p + "/"))) {
      // An update bundle (POST /api/update with the bundle as the body) has nothing to install on.
      if (method === "POST" && path === "update") return error(400, "Update not allowed: the emulator runs the firmware it was built from");
      return this.screen.request(method, path, u.search.slice(1), body);
    }
    if (path.startsWith("storage/")) {
      const response = storageApi(this, method, path.slice("storage/".length), u.searchParams, body);
      if (response) return response;
    }
    if (path === "assets/upload") return assetsApi(this, method, u.searchParams, body);
    if (path === "log_dump" && method === "POST") return logDump(this, u.searchParams);
    if (path === "access" || path.startsWith("access/tokens")) {
      const response = this.access.request(method, path, u.searchParams, text(), this.barTime());
      if (response) return response;
    }

    switch (`${method} ${path}`) {
      case "GET version":
        return json(200, { api_semver: this.firmware.apiVersion });
      case "GET transport":
        // api_root.c: "wifi" for a request that came over Wi-Fi; an app's request and the emulator's port are not.
        return json(200, { type: "usb" });
      case "GET status":
        return json(200, this.status());
      case "GET status/system":
        return json(200, this.status().system);
      case "GET status/device":
        return json(200, this.status().device);
      case "GET status/firmware":
        return json(200, this.status().firmware);
      case "GET status/power":
        return json(200, this.power());
      case "GET display/brightness":
        return json(200, { value: this.state.brightness });
      case "POST display/brightness": {
        // api_display.c: ?value=auto or 0..100.
        const value = q("value") ?? "";
        if (value !== "auto" && !(/^\d{1,3}$/.test(value) && Number(value) <= 100)) return error(400, "Bad Request");
        this.state.brightness = value === "auto" ? value : String(Number(value));
        this.showLights(false);
        return ok();
      }
      case "GET audio/volume":
        return json(200, { volume: this.state.volume });
      case "POST audio/volume": {
        // api_audio.c: ?volume=0..100, and silent=0|1 if it is there at all.
        const volume = q("volume") ?? "";
        const silent = q("silent");
        if (!/^\d{1,3}$/.test(volume) || Number(volume) > 100 || (silent !== null && silent !== "0" && silent !== "1")) return error(400, "Bad Request");
        this.state.volume = Number(volume);
        this.screen.status({ volume: this.state.volume });
        this.events.emit("volume");
        // The bar answers a new volume with a click, unless asked to be silent.
        if (silent !== "1") this.audio.playFile("/ext/apps_assets/shared/sounds/volume_change.snd");
        return ok();
      }
      case "POST audio/play": {
        const { status, error: message } = this.audio.request(text());
        return status === 200 ? ok() : error(status, message);
      }
      case "DELETE audio/play":
        // The bar answers once the sound has faded out; here it stops at once.
        return this.audio.stop() ? ok() : error(410, "No audio is playing");

      case "GET screen": {
        // web_server/http_api/api_streaming.c: exactly "0" or "1".
        const display = q("display");
        if (display !== "0" && display !== "1") return error(400, "Wrong display");
        const frame = Buffer.from(this.screen.frame(Number(display))).toString("base64");
        return { status: 200, headers: [["Content-Type", "image/bmp"]], body: new TextEncoder().encode(frame) };
      }
      case "POST input":
        return this.pressKey(q("key") ?? "") ? ok() : error(400, "Bad Request");

      case "POST apps/stage":
        return this.stage(body ?? new Uint8Array());
      case "POST apps/install":
        return this.install(q("install_key"));
      case "GET apps/list":
        return json(200, { apps: this.installedApps().map((m) => this.appInfo(m)) });
      case "DELETE apps":
        return this.remove(q("app_id"));
      case "POST apps/launch":
        return this.launch(q("app_id"));
      case "POST apps/quit":
        return this.quit();
      case "GET apps/settings":
      case "PUT apps/settings":
      case "DELETE apps/settings":
        return this.settingsRequest(method, q("app_id"), text(), fromApp);
      default:
        return this.unrouted(method, path);
    }
  }

  /**
   * A request none of the emulator's cases took, answered as the bar's web server would. A handler of the API that
   * takes the path but not the method answers 405 with the methods it takes (API_ROOT). A path no handler of the API
   * takes goes on to the web server's last handler, the local web's files (web_server.c:250, :395–452): GET gets its
   * 404 page (http_serve_html_404, :360–379), any other method 405 with GET.
   */
  unrouted(method, path) {
    // A method web_server.c does not know (HttpMethodUnknown) is refused by the first handler whose uri fits, which
    // for anything under /api is /api itself, of all methods (handlers_root, web_server.c:26–35; :470–473 and, for
    // the headers, :520–523, which also closes the connection).
    if (!HTTP_METHODS.includes(method)) {
      const refused = methodNotAllowed(API_METHODS);
      return { ...refused, headers: [...refused.headers, ["Connection", "close"]] };
    }
    const allowed = methodsAllowed(API_ROOT, path, method);
    if (allowed) return methodNotAllowed(allowed);
    if (method !== "GET") return methodNotAllowed(["GET"]);
    const page = join(this.firmware.web, "404.html");
    if (existsSync(page)) return { status: 404, headers: [["Content-Type", "text/html"]], body: readFileSync(page) };
    return { status: 404, headers: [], body: new TextEncoder().encode("Not found\n") };
  }

  /**
   * GET, PUT and DELETE /api/apps/settings, answered as api_apps_settings_callback() answers them (api_apps.c:627–700),
   * with the firmware's texts: a bad or missing app_id is 400 "Bad Request", an app that is not installed 404 "Not
   * Found", an app asking for another app's settings 403 "Forbidden", an app without a settings schema 404
   * "Application has no settings schema", a schema that is not JSON, or is JSON the firmware's parser refuses, 503
   * "Application settings schema is invalid", and every document PUT refuses 400 "Bad Request". Why the emulator refused a document goes to its log: the bar says nothing.
   */
  settingsRequest(method, id, text, fromApp) {
    if (!id || !APP_ID_RE.test(id)) return error(400, "Bad Request");
    if (!this.manifest(id)) return error(404, "Not Found");
    // An app may read the settings of the app that runs, that is its own (http_api_is_request_from_js).
    if (fromApp && this.running?.id !== id) return error(403, "Forbidden");
    let schema;
    try {
      schema = this.settingsSchema(id);
    } catch {
      return error(503, "Application settings schema is invalid");
    }
    if (!schema) return error(404, "Application has no settings schema");

    if (method === "GET") {
      // api_apps_settings_get(): cJSON_Print() of the document, and a line feed.
      return { status: 200, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode(`${cjsonPrint(this.settingsDocument(id))}\n`) };
    }
    if (method === "DELETE") {
      // api_apps_settings_delete(): back to the defaults.
      rmSync(this.settingsPath(id), { force: true });
      this.settingsDocument(id);
      return ok();
    }
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = undefined;
    }
    const refused = (why) => {
      this.log(`The settings sent for ${id} were refused (the BUSY Bar answers only "Bad Request"): ${why}`, "warn");
      return error(400, "Bad Request");
    };
    // setting_provider_load_document(): an object with a number "version" and an object "values".
    const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    if (!isObject(doc) || !isObject(doc.values)) return refused(doc === undefined ? "not JSON" : 'not an object with "version" and "values"');
    if (doc.version !== schema.version) return refused(`version ${JSON.stringify(doc.version)}, the schema's is ${schema.version}`);
    const problem = validate(schema.fields, doc.values);
    if (problem) return refused(problem);
    const clean = { version: schema.version, values: keepKnown(schema.fields, doc.values) };
    // In one step (a temporary file, then a rename): a write cut short never leaves half a file (audit H3).
    writeFileAtomic(this.settingsPath(id), cjsonPrint(clean));
    return ok();
  }
}

// ---------------------------------------------------------------- settings helpers

function defaults(fields) {
  const out = {};
  for (const [k, f] of Object.entries(fields ?? {})) out[k] = f.type === "group" ? defaults(f.fields) : f.default;
  return out;
}

function keepKnown(fields, values) {
  const out = {};
  for (const [k, f] of Object.entries(fields)) out[k] = f.type === "group" ? keepKnown(f.fields, values[k] ?? {}) : values[k];
  return out;
}

/** Every field must be present and valid (PUT /api/apps/settings). Returns a message, or null. */
function validate(fields, values, prefix = "") {
  for (const [k, f] of Object.entries(fields)) {
    const v = values?.[k];
    const name = prefix + k;
    if (v === undefined) return `Missing value for ${name}`;
    const bad = `Invalid value for ${name}`;
    switch (f.type) {
      case "group": {
        const inner = validate(f.fields, v, `${name}.`);
        if (inner) return inner;
        break;
      }
      case "boolean":
        if (typeof v !== "boolean") return bad;
        break;
      case "integer": {
        const min = f.min ?? -2147483648;
        const max = f.max ?? 2147483647;
        if (!Number.isInteger(v) || v < min || v > max || (v - min) % (f.step ?? 1) !== 0) return bad;
        break;
      }
      case "string": {
        const len = typeof v === "string" ? new TextEncoder().encode(v).length : -1;
        if (len < (f.min_length ?? 0) || len > (f.max_length ?? 64)) return bad;
        break;
      }
      case "enum":
        if (!f.options.some((o) => o.value === v)) return bad;
        break;
      case "color":
        if (typeof v !== "string" || !/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(v)) return bad;
        break;
      case "time":
        if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v)) return bad;
        break;
      case "geolocation":
        if (!v || (v.mode !== "auto" && v.mode !== "fixed") || typeof v.name !== "string") return bad;
        break;
      default:
        return bad;
    }
  }
  return null;
}
