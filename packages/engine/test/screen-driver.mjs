// Runs the screen module of one firmware version on its own, with a host that only keeps time, and plays one
// scenario of waits.test.mjs. A separate process, so that the test can stop a module that never returns.
//
//   node screen-driver.mjs <version> <scenario>      prints the outcome as one line of JSON
//
// The clock is the driver's: it stands still unless a scenario moves it with advance(), which carries out the GUI's
// ticks and the module's timers that fall into the step, in order. So "no time passed" is exact here.

import { readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [version, scenario] = process.argv.slice(2);
const build = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const assets = join(build, "apps-assets");
const ASSETS_PREFIX = "/ext/apps_assets/";
const TICK_MS = 8;

const { default: createModule } = await import(pathToFileURL(join(build, version, "screen.mjs")).href);

let now = 1_800_000_000_000;
let nextTick = now + TICK_MS;
const timers = new Map(); // module timer → { ms, periodic, due }
const files = new Map(); // what the firmware wrote
const logs = []; // [level, tag, text], the level a FuriLogLevel
const settings = []; // [name, value]
const halts = []; // true: stuck, false: the bar goes down

const host = {
  log: (level, tag, text) => logs.push([level, tag, text]),
  now: () => now,
  fatal: (code) => logs.push([1, "driver", `fatal ${code}`]),
  halt: (stuck) => halts.push(stuck),
  fileRead: (path) => {
    if (files.has(path)) return files.get(path);
    if (!path.startsWith(ASSETS_PREFIX)) return null;
    const file = resolve(assets, path.slice(ASSETS_PREFIX.length));
    if (!file.startsWith(assets + sep)) return null;
    try {
      return new Uint8Array(readFileSync(file));
    } catch {
      return null;
    }
  },
  fileWrite: (path, bytes) => (files.set(path, bytes), true),
  dirList: () => null,
  remove: (path) => files.delete(path),
  appStart: () => {},
  appAbort: () => {},
  settingChanged: (name, value) => settings.push([name, value]),
  timezone: () => "Universal",
  audioPlay: () => true,
  timerStart: (timer, ms, periodic) => timers.set(timer, { ms: Math.max(ms, periodic ? 1 : 0), periodic, due: now + ms }),
  timerStop: (timer) => timers.delete(timer),
  replyReady: () => {},
};

const M = await createModule({ host, print: () => {}, printErr: (text) => logs.push([2, "stderr", text]) });

/** Moves the clock `ms` on: the ticks and the timers due in between run at their times, the earliest first. */
function advance(ms) {
  const end = now + ms;
  for (;;) {
    let next = nextTick;
    let timer = null;
    for (const [id, t] of timers) {
      if (t.due < next) {
        next = t.due;
        timer = id;
      }
    }
    if (next > end) break;
    now = Math.max(now, next);
    if (timer === null) {
      nextTick += TICK_MS;
      M._emu_tick();
    } else {
      const t = timers.get(timer);
      if (t.periodic) t.due += t.ms;
      else timers.delete(timer);
      M._emu_timer_fire(timer);
    }
  }
  now = end;
}

/** A request to one of the firmware's API handlers; the answer it had ready when the call returned. */
function request(method, path, body = "") {
  const strings = [method, path, ""].map((s) => M.stringToNewUTF8(s));
  const bytes = new TextEncoder().encode(body);
  const bodyPtr = M._malloc(Math.max(bytes.length, 1));
  M.HEAPU8.set(bytes, bodyPtr);
  const id = M._emu_screen_request(...strings, bodyPtr, bytes.length);
  for (const p of [...strings, bodyPtr]) M._free(p);
  const text = new TextDecoder("latin1").decode(M.HEAPU8.slice(M._emu_screen_reply(id), M._emu_screen_reply(id) + M._emu_screen_reply_size(id)));
  M._emu_screen_release(id);
  const end = text.indexOf("\r\n\r\n");
  return { status: Number(text.split(" ")[1]), body: text.slice(end + 4).trim() };
}

/** The front display's frame as GET /api/screen sends it (B, G, R bytes, 72×16), in hex. */
function frontFrame() {
  const size = 72 * 16 * 3;
  const p = M._malloc(size);
  M._emu_screen_frame(0, p);
  const hex = Buffer.from(M.HEAPU8.slice(p, p + size)).toString("hex");
  M._free(p);
  return hex;
}

/** The programs the loader has started so far, by name, in order. */
const started = () => logs.filter(([, tag, text]) => tag === "EmuSystem" && text.startsWith("Starting ")).map(([, , text]) => text.slice("Starting ".length));

/** Runs `call`; says whether the module threw out of it. */
function attempt(call) {
  try {
    return { returned: call() };
  } catch (e) {
    return { threw: String(e?.message ?? e) };
  }
}

const snapshot = (fields) =>
  JSON.stringify({
    snapshot: { ...fields, busy_bar_settings: { theme: "on_call", show_work_phase_only: false, trigger_smart_home: false } },
    snapshot_timestamp_ms: now,
  });

M._emu_screen_init();
// The bar starts and settles in the apps menu.
advance(2000);

const SCENARIOS = {
  // The BUSY timer is started through the API while another program is on screen: its service asks the desktop for
  // the BUSY program and waits for it. All of it has to happen inside the request: the clock does not move.
  "busy-start": () => {
    const before = started();
    const put = request("PUT", "busy/snapshot", snapshot({ type: "SIMPLE", card_id: "00000000-0000-0000-0000-000000000000", time_left_ms: 600000, is_paused: false }));
    const get = request("GET", "busy/snapshot");
    return { before, put, get, after: started() };
  },
  // A timer set paused while the apps menu is on screen: the BUSY program shows PAUSED over a blurred picture of the
  // screen, which it takes after a sleep "for the Gui to redraw the background". And the same timer paused after it
  // ran for three seconds, where the screen behind PAUSED was the timer's all along.
  "paused-at-once": () => {
    const put = request("PUT", "busy/snapshot", snapshot({ type: "SIMPLE", card_id: "00000000-0000-0000-0000-000000000000", time_left_ms: 600000, is_paused: true }));
    advance(3000);
    return { put, front: frontFrame() };
  },
  "paused-while-running": () => {
    request("PUT", "busy/snapshot", snapshot({ type: "SIMPLE", card_id: "00000000-0000-0000-0000-000000000000", time_left_ms: 600000, is_paused: false }));
    advance(3000);
    const put = request("PUT", "busy/snapshot", snapshot({ type: "SIMPLE", card_id: "00000000-0000-0000-0000-000000000000", time_left_ms: 597000, is_paused: true }));
    advance(3000);
    return { put, front: frontFrame() };
  },
  // The apps menu, three seconds on: what was on screen before the timer was set.
  "apps-menu": () => {
    advance(3000);
    return { front: frontFrame() };
  },
  // A thread that sleeps a hundred times in a row while another message waits for it: every sleep is a turn for the
  // others, its own loop takes nothing meanwhile, and it comes back.
  "sleeps-100": () => attempt(() => M._emu_wait_probe(100)),
  // Calls that come one right after another, each with many sleeps (ticks a host catches up on after a stall): the
  // limit of waits is for one call, they do not add up.
  "sleeps-in-calls": () => attempt(() => [M._emu_wait_probe(6000), M._emu_wait_probe(6000), M._emu_wait_probe(6000)]),
  // A thread that never stops waiting: the module stops it and halts.
  "sleeps-forever": () => attempt(() => M._emu_wait_probe(1_000_000)),
  // The supervisor restarts the bar after a fatal JS error (30 s after the start, as on a bar without the debug flag):
  // on a bar nothing runs after power_reboot().
  restart: () => {
    advance(31_000);
    return attempt(() => M._emu_screen_js_fatal(1));
  },
};

if (!SCENARIOS[scenario]) throw new Error(`Unknown scenario "${scenario}": ${Object.keys(SCENARIOS).join(", ")}`);
const outcome = SCENARIOS[scenario]();
// FuriLogLevelError is 2; what is worse than an error comes with 1.
console.log(JSON.stringify({ ...outcome, halts, settings, errors: logs.filter(([level]) => level <= 2).map(([, tag, text]) => `[${tag}] ${text}`) }));
