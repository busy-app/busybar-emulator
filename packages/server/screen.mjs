// The bar's displays and the system around the apps: one instance of the screen module
// (emulator/packages/engine/build/<version>/screen.*) for the lifetime of the device. The firmware's LVGL, GUI, canvas and
// display API answer /api/display/draw and render; its desktop, apps menu and JS app launcher decide which app runs
// and ask the host to start or abort it in the runtime module.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { timeOfDayOffset } from "./computer-clock.mjs";
import { appsAssets } from "./firmware.mjs";
import { TickClock } from "./tick-clock.mjs";

// The firmware's assets (shared fonts, images, animations, and the system apps' own) live on the bar's
// /ext/apps_assets; the emulator keeps a copy from the firmware build in emulator/packages/engine/build/apps-assets (build.mjs).
const ASSETS_PREFIX = "/ext/apps_assets/";

// How long a refresh of each display takes a stock bar's GUI, ms: a time from [min, max) for each one (furi_shim.c).
// The front display's is 0: its driver copies the frame (3456 bytes) and sends it on without the GUI waiting
// (front_display.c). The back display's sends 6400 bytes over SPI by polling in a thread of high priority
// (ssd1320.c), after the GUI has drawn the enlarged copy of the front display it shows; how long that takes is not in
// the source, so it is fitted (EMU-231) to a stock bar's pace of the same animation at five frame rates (night of
// 11-12 Nov 2026, firmware 1.3.1; reports/bar-night-2026-11-12.md): emulator / bar, ms a frame, 60 frames a second
// 19.6 / 19.5, 33 33.1 / 33.1, 30, 26 and 25 40.0 / 40.0. The lower bound decides 60 frames a second (9 ms and more
// lock it at 20 ms a frame, 8.5 gives 19.0), the upper one 33 (12.5 gives 32.8, 13 33.1); 30 to 25 frames a second
// keep 40 ms with any of them.
export const BAR_DRAW_MS = { front: [0, 0], back: [8.75, 13] };
// Where the drawing time's sequence starts when the clock is held and no other seed is given; the module starts it there too.
export const HOLD_SEED = 0x9e3779b9;
// How long a hold waits at most for an animation of the firmware's own to finish, ms: the apps menu's standby
// animation (every 5 s) lasts about 1.1 s, the start of the bar about 2.2 s.
const HOLD_MAX_WAIT_MS = 3000;
// emu_screen_drawn() once the GUI has drawn on both displays (1 the front, 2 the back), and how long the module's clock
// may run before that: the GUI draws on its first tick or second, a few seconds is a module that never will.
const BOTH_DRAWN = 3;
export const FIRST_FRAME_MS = 3000;

// JsRunnerEventType and JsRunnerError (js_runner.h), JsAppLauncherStatus (js_app_launcher.h).
const SCRIPT_STARTED = 0;
const SCRIPT_FINISHED = 1;
export const JsRunnerError = { none: 0, unknown: 1, filesystem: 2, outOfMemory: 3, parseException: 4 };
export const LauncherStatus = { ok: 0, timeout: 1, notRunning: 2, invalidAppId: 3, aborted: 4, lowPriority: 5, error: 6 };

// WifiState (wifi_common.h) and BleServiceStatus (ble.h): what the back display's status bar shows for them. BLE "ready"
// and the states before it hide the icon.
export const WifiState = { unknown: 0, disconnected: 1, connected: 2, connecting: 3 };
export const BleStatus = { ready: 2, advertising: 3, connectable: 4, connected: 5, error: 6 };

export const FRONT = { width: 72, height: 16, bytes: 72 * 16 * 3 };
export const BACK = { width: 160, height: 80, bytes: (160 * 80) / 2 };

const UNAVAILABLE = () => ({ status: 503, headers: [["Content-Type", "application/json"]], body: new TextEncoder().encode('{"error":"Service Unavailable"}\n') });

export class Screen {
  /**
   * @param {object} o
   * @param {object} o.firmware the firmware whose screen module this is (firmware.mjs's loadFirmware)
   * @param {(path: string) => Uint8Array | null} o.readFile device path → bytes: app images and animations, apps
   * @param {(path: string, bytes: Uint8Array) => boolean} o.writeFile settings the apps menu and the launcher keep
   * @param {(path: string) => {name: string, dir: boolean}[] | null} o.listDir
   * @param {(path: string) => boolean} o.remove a file or a directory with everything in it
   * @param {(runId: number, appId: string, entry: string, heapBytes: number) => void} o.onAppStart the launcher runs an
   *   app; scriptStarted and scriptFinished report on it by runId
   * @param {() => void} o.onAppAbort the launcher stops the running app
   * @param {(path: string) => boolean} [o.onAudioPlay] the firmware plays a sound file
   * @param {(name: string, value: string) => void} [o.onSettingChanged] a settings program changed a setting
   * @param {(preset: number, rgb: number[], override: number, started: boolean) => void} [o.onLights] the firmware
   *   started a preset of the status lights (started) or a program's hold on their brightness changed: the
   *   StatusLightsPreset, its color [r, g, b], the user brightness 0..100 a program holds them at or -1
   * @param {() => string} [o.timezone] the name of the bar's time zone
   * @param {() => string | null} [o.barAddress] the address the bar answers on ("http://127.0.0.1:8640")
   * @param {boolean} [o.barSpeed] the system's animations keep the bar's pace, not the nominal one
   * @param {() => void} [o.onStuck] the firmware hung in a wait that nothing ends (the module says which in the log)
   *   and the system is halted, see guard() below; what to do about it is the owner's (the device restarts the bar)
   * @param {(level: number, tag: string, text: string) => void} o.onLog
   * @param {{computer?: () => number, timeOfDayOffset?: () => number, setTimer?: Function, clearTimer?: Function}} [o.clockHost]
   *   for tests: the computer's clock and timer the module's clock runs by (tick-clock.mjs), and how far the computer's
   *   time of day is from that clock (computer-clock.mjs)
   */
  static async create(o) {
    const screen = new Screen(o);
    await screen.start();
    return screen;
  }

  constructor(o) {
    Object.assign(this, o);
    this.waiting = new Map(); // connection id → resolve
    this.inside = 0; // calls into the module that have not returned yet
    // How far the computer's time of day is from the ticks' clock, and what the module's real-time clock was given.
    this.timeOfDayOffset = o.clockHost?.timeOfDayOffset ?? timeOfDayOffset;
    this.rtcFollow = 0;
    // The module's clock: the GUI's ticks and the module's timers happen by it (tick-clock.mjs).
    this.clock = new TickClock({
      onTick: () =>
        this.guard(() => {
          this.followComputer();
          this.M._emu_tick();
          // The web server's own timers (an account pairing code that does not come); they stand while the clock is held.
          if (!this.clock.held) this.M._emu_web_server_poll();
          this.firstFrameDrawn?.(this.M._emu_screen_drawn());
        }),
      onTimer: (timer) => this.guard(() => this.M._emu_timer_fire(timer)),
      ...o.clockHost,
    });
  }

  async start() {
    const host = {
      log: (level, tag, text) => this.onLog(level, tag, text),
      // The module reads its clock from inside a call into it: no sync here.
      now: () => this.clock.now(),
      fatal: (code) => this.onLog(1, "screen", `fatal ${code}`),
      // The system stops in the middle of a call into the module, which then throws (packages/engine/native/host.c):
      // the firmware restarts the bar or resets it (the host has been told through settingChanged), or it is stuck.
      halt: (stuck) => {
        this.halted = stuck ? "stuck" : "down";
      },
      fileRead: (path) => {
        if (path.startsWith(ASSETS_PREFIX)) {
          const p = resolve(appsAssets, path.slice(ASSETS_PREFIX.length));
          if (!p.startsWith(appsAssets)) return null;
          try {
            return new Uint8Array(readFileSync(p));
          } catch {
            return null;
          }
        }
        return this.readFile(path);
      },
      fileWrite: (path, bytes) => !path.startsWith(ASSETS_PREFIX) && this.writeFile(path, bytes),
      dirList: (path) => this.listDir(path),
      remove: (path) => this.remove(path),
      // Called from inside the screen module; the runtime starts outside it, right after. An abort that comes first
      // cancels the start.
      appStart: (runId, appId, entry, heapBytes) => {
        const start = () => this.pendingStart === start && ((this.pendingStart = null), this.onAppStart(runId, appId, entry, heapBytes));
        this.pendingStart = start;
        queueMicrotask(start);
      },
      // The settings programs: a setting changed on the device, and the time zone they show.
      settingChanged: (name, value) => this.onSettingChanged?.(name, value),
      // The status lights (emu_screen.c): what the firmware lights them with, the moment it does.
      lights: (preset, r, g, b, override, started) => this.onLights?.(preset, [r, g, b], override, started),
      timezone: () => this.timezone?.() ?? "Universal",
      // The address the emulated bar answers on, for the APPS screen with no apps; null when there is none.
      barAddress: () => this.barAddress?.() ?? null,
      // The firmware's own sounds (the BUSY timer's): the same speaker as /api/audio/play.
      audioPlay: (path) => (this.onAudioPlay ? this.onAudioPlay(path) : false),
      appAbort: () => {
        if (this.pendingStart) this.pendingStart = null;
        else this.onAppAbort();
      },
      timerStart: (timer, ms, periodic) => this.clock.startTimer(timer, ms, periodic),
      timerStop: (timer) => this.clock.stopTimer(timer),
      replyReady: (id) => {
        const resolve = this.waiting.get(id);
        if (resolve) queueMicrotask(resolve);
      },
    };
    const { default: createModule } = await import(pathToFileURL(join(this.firmware.dir, "screen.mjs")).href);
    this.M = await createModule({ host, print: () => {}, printErr: (t) => this.onLog(2, "screen", t) });
    this.followComputer();
    this.guard(() => this.M._emu_screen_init());
    // A system that halts while it starts would halt on every restart too.
    if (this.halted) throw new Error("The firmware's system did not start: it halted while starting. The emulator's log says where.");
    // At bar speed the GUI takes the time to draw that a bar's does (furi_shim.c), which is what slows its animations.
    this.setDrawTime(this.barSpeed, 0);
    this.clock.start();
  }

  // ---------------------------------------------------------------- the module's clock
  //
  // The module's time is the computer's, and its ticks and timers are counted by that clock (tick-clock.mjs): the
  // host's timer may be late or coarse, the module still gets a tick for every 8 ms, each at the time it was due.
  // Everything below that calls into the module or reads its frames brings the clock up to date first (enter), so
  // what was due before the call has happened by then. What the module starts by itself on a tick or a timer — a
  // waiting reply, a sound, the start or stop of an app — is as late in real time as the host's timer is: up to 16 ms
  // on Windows.
  //
  // For tests the clock can be held and stepped (hold, advance, release): then nothing moves by itself, and
  // advance(ms) carries out, in order and at their exact times, the ticks and timers that fall into those ms.
  //
  // A hold makes the same steps give the same frames whenever it comes. At bar speed the GUI's draws take a bar's
  // time, by a pseudo-random sequence (furi_shim.c): a GUI tick that comes while the GUI still draws waits for it, and
  // which ticks an animation misses depends on where that sequence is, on what the GUI is still drawing and on when
  // LVGL's timers last ran (the displays' refresh, every 16 ms, and the back display's copy of the front, every 40
  // ms). Running freely, all of it is wherever the ticks since the start have taken it. So a hold stops the clock on a
  // tick: the first one by which the GUI is done drawing, owes no tick and has nothing left to draw, so that the clock
  // reads the tick's own time there (the module never sees its clock go back) and no draw from before falls after the
  // stop. If an animation of the firmware's own is under way (the apps menu's standby animation, every 5 s for about
  // 1.1 s; the start of the bar), the stop moves on with it a tick at a time until it is over. Either wait lasts
  // HOLD_MAX_WAIT_MS at most: a hold during an app's own endless animation (it redraws a display on every refresh)
  // waits that long and stops in the middle of it, maybe with the GUI still drawing, and is not repeatable. At the
  // stop's time, just before its tick, the sequence starts from a given seed and every LVGL timer and every periodic
  // timer of the module starts its period anew; the ticks before it are carried out as they were due.
  //
  // What that makes repeatable: from the stop on, the same steps give the same frames, whatever the history of the
  // clock was — when the ticks before fell, where the drawing time's sequence was, when LVGL's timers and the module's
  // periodic timers last ran. What it does not: the state the history left — what is on the displays, which mode and
  // screen the firmware is in, one-shot timers still pending (a draw waiting in canvas), the time of day (a countdown,
  // the clock's seconds), and an animation that runs longer than HOLD_MAX_WAIT_MS or for ever (above). To be
  // repeatable a test also starts from the same state: it holds the clock first and does everything after in held
  // time (timed.mjs).
  // With the drawing taking no time for the hold (jitter: false) the module shows every frame an animation has, at its
  // nominal times. Releasing the clock puts the sequence back where the hold found it, with the drawing time as it
  // was set, so a clock that runs freely goes on as it always did. Without the drawing time (--fast) the GUI never
  // waits and a hold stops on the next tick.

  /**
   * The GUI's drawing takes a bar's time (on) or none, with its sequence started from `seed` (0: where it is). Returns
   * the state the sequence was in (furi_shim.c).
   */
  setDrawTime(on, seed) {
    const { front, back } = on ? BAR_DRAW_MS : { front: [0, 0], back: [0, 0] };
    return this.M._emu_gui_draw_time(front[0], front[1], back[0], back[1], seed >>> 0) >>> 0;
  }

  /**
   * How far the module's clock may run ahead of the computer's, ms: the most a GUI pass draws, one refresh of each
   * display (0: drawing takes no time). Its ticks wait for the rest (furi_shim.c).
   */
  wanderRange(on = this.barSpeed) {
    return on ? BAR_DRAW_MS.front[1] + BAR_DRAW_MS.back[1] : 0;
  }

  /** Unix ms as the module sees it, with everything due by now carried out. */
  now() {
    this.sync();
    return this.clock.now();
  }

  /**
   * The bar's real-time clock as the module reads it, Unix ms, but for the bar's own setting (POST /api/time/timestamp,
   * which the device keeps as clockOffset): the module's clock and the offset to the computer's time of day it was
   * given (computer-clock.mjs).
   */
  rtcNow() {
    const now = this.now();
    return now + this.rtcFollow;
  }

  /**
   * Gives the module's real-time clock the offset from the ticks' clock to the computer's time of day, if that has
   * changed (the computer's clock was set back, or put right again). Not from inside a call into the module. The
   * ticks do not follow it: they never go back.
   */
  followComputer() {
    const offset = this.timeOfDayOffset();
    if (offset === this.rtcFollow || this.disposed) return;
    this.rtcFollow = offset;
    this.M._emu_screen_rtc_follow(offset);
  }

  /** The clock and how many ticks it has carried out and left out since the bar started (tick-clock.mjs). */
  clockState() {
    return { now: this.now(), ticks: this.clock.ticks, skipped: this.clock.skipped, held: this.clock.held };
  }

  /** Whether the clock is stepped by advance() instead of running. */
  get held() {
    return this.clock.held;
  }

  /** ms the module's clock is ahead of the computer's, after a hold. */
  get skew() {
    return this.clock.skew;
  }

  /**
   * Carries out the ticks and timers that have come due, with the module's real-time clock put right first
   * (followComputer). Not from inside a call into the module: a callback of the module's that reaches back into the
   * screen (a "setting changed" handler that reads a frame) must not have ticks run in the middle of the call it came
   * from; they are carried out when that call has returned.
   */
  sync() {
    // During a tick or a timer (a callback of the module's that reads the clock) the clock does not move either.
    if (this.disposed || this.inside || this.clock.running) return;
    this.followComputer();
    this.clock.sync();
  }

  /**
   * A call into the module: what was due before it happens first, and nothing else until it returns. `otherwise` is
   * the answer of a system that is down: one that halted earlier, in a tick that came due before this call, or in
   * the call itself (guard).
   */
  enter(call, otherwise) {
    this.sync();
    if (this.disposed) return otherwise;
    this.inside++;
    try {
      return this.guard(() => call(this.M), otherwise);
    } finally {
      this.inside--;
    }
  }

  /**
   * Runs code of the module — a call into it, a tick, a timer — which the firmware may not let finish: a restart or
   * a reset takes the bar down inside power_reboot(), and a thread that hangs in a wait is stopped by the module
   * (furi_shim.c, "waits"). The module then throws out of the call, half-way through whatever it was doing, and
   * cannot be used again. So this screen is over: its clock stops (the ticks still due are not made up), requests
   * are answered 503 and the displays are dark, until the device replaces it with a new one (a restart).
   */
  guard(run, otherwise) {
    this.guarded = (this.guarded ?? 0) + 1;
    try {
      return run();
    } catch (e) {
      if (!this.halted) throw e;
      // Code of the module that a callback of the module's own has started: the halt ends the outer run too.
      if (this.guarded > 1) throw e;
      this.dispose();
      if (this.halted === "stuck") this.onStuck?.();
      return otherwise;
    } finally {
      this.guarded--;
    }
  }

  /**
   * Stops the clock on the next tick it can (see above), with the drawing time's sequence started from `seed` (a
   * 32-bit number other than 0) and, with `jitter: false`, drawing that takes no time until release(). Holding a held
   * clock does nothing.
   */
  hold({ seed = HOLD_SEED, jitter = true } = {}) {
    if (this.inside) throw new Error("the clock cannot be held from inside a call into the module");
    if (this.disposed || this.clock.held) return;
    if (!(seed >>> 0)) throw new Error("the seed of the drawing time's sequence must not be 0");
    const on = this.barSpeed && jitter;
    this.clock.hold({
      // The GUI may still be drawing past the next tick or have something left to draw (emu_screen.c), or an
      // animation of the firmware's own may be under way. Busy too while the GUI has not drawn its first frame: a stop
      // before it restarts the display's refresh, and the bar would wait for that frame, which comes only on ticks, as
      // long as the clock is held (EMU-253).
      busy: () =>
        !this.disposed &&
        this.guard(() => this.M._emu_screen_drawn() !== BOTH_DRAWN || this.M._emu_screen_drawing() !== 0 || this.M._emu_screen_running_timers() > 0, false),
      maxWait: HOLD_MAX_WAIT_MS,
      onTick: () => {
        // A tick on the way to the stop may have taken the bar down (a halt disposes the screen).
        if (this.disposed) return;
        this.guard(() => {
          this.wanderBeforeHold = this.setDrawTime(on, seed);
          this.M._emu_screen_restart_timers();
          this.heldWander = this.wanderRange(on);
        });
      },
    });
  }

  /** How far the module's clock may now run ahead of the computer's, ms (0: drawing takes no time; see wanderRange). */
  get wander() {
    return this.clock.held && this.heldWander !== undefined ? this.heldWander : this.wanderRange();
  }

  /** With the clock held: moves it `ms` on, doing everything that was due in between. */
  advance(ms) {
    if (this.inside) throw new Error("the clock cannot be moved from inside a call into the module");
    this.clock.advance(ms);
  }

  /**
   * Time passes at once (the device's passTime): the clock moves `ms` on, with every tick and timer of the module that
   * falls into them carried out in order at its own time, and runs on from there, that far ahead of the computer's.
   * Unlike hold() it does not wait for a quiet tick and restarts nothing: it is not for repeatable frames. A held
   * clock is moved and stays held. Returns the ms the clock moved.
   */
  pass(ms) {
    if (this.inside) throw new Error("the clock cannot be moved from inside a call into the module");
    if (this.disposed || !(ms > 0)) return 0;
    if (this.clock.held) {
      this.clock.advance(ms);
      return ms;
    }
    this.sync();
    const before = this.clock.skew;
    this.clock.hold();
    this.clock.advance(ms);
    this.clock.release();
    return this.clock.skew - before;
  }

  /** Lets the clock run again, from the time it was held at, with the drawing time as it was before the hold. */
  release() {
    if (this.disposed || !this.clock.held) return;
    if (this.wanderBeforeHold !== undefined) this.guard(() => this.setDrawTime(this.barSpeed, this.wanderBeforeHold));
    this.wanderBeforeHold = undefined;
    this.heldWander = undefined;
    this.clock.release();
  }

  /**
   * An API request for one of the firmware's own handlers in the module (emu_screen.c lists them); `path` is what
   * follows /api/, as "display/draw". Returns { status, headers, body }.
   */
  async request(method, path, query, body) {
    if (this.disposed) return UNAVAILABLE();
    const M = this.M;
    const id = this.enter(() => {
      const strings = [method, path, query].map((s) => M.stringToNewUTF8(s));
      const bodyPtr = M._malloc(Math.max(body?.length ?? 0, 1));
      if (body) M.HEAPU8.set(body, bodyPtr);
      const id = M._emu_screen_request(...strings, bodyPtr, body?.length ?? 0);
      for (const p of [...strings, bodyPtr]) M._free(p);
      return id;
    }, 0);
    if (!id) return UNAVAILABLE();
    // A draw with a lower priority than what is on screen waits in canvas for up to 1.5 s; an account pairing code,
    // for 3 s.
    if (!M._emu_screen_reply_size(id)) await new Promise((resolve) => this.waiting.set(id, resolve));
    this.waiting.delete(id);
    if (this.disposed) return UNAVAILABLE();
    const reply = M.HEAPU8.slice(M._emu_screen_reply(id), M._emu_screen_reply(id) + M._emu_screen_reply_size(id));
    M._emu_screen_release(id);
    return parseReply(reply);
  }

  /** POST /api/apps/launch: js_app_launcher_start() in "resume" mode. Returns the JsAppLauncherStatus. */
  launch(appId) {
    return this.enter((M) => {
      const p = M.stringToNewUTF8(appId);
      const status = M._emu_screen_launch(p);
      M._free(p);
      return status;
    }, LauncherStatus.error);
  }

  /** POST /api/apps/quit: js_app_launcher_stop(), forgetting the app. Returns the JsAppLauncherStatus. */
  quit() {
    return this.enter((M) => M._emu_screen_quit(), LauncherStatus.error);
  }

  /** What became of the app the launcher started: js_runner's ScriptStarted, or ScriptFinished with a JsRunnerError. */
  scriptStarted(runId) {
    this.enter((M) => M._emu_screen_script_event(runId, SCRIPT_STARTED, 0));
  }

  scriptFinished(runId, error) {
    this.enter((M) => M._emu_screen_script_event(runId, SCRIPT_FINISHED, error));
  }

  /** The front frame (B, G, R bytes, 72×16) or the back frame (4-bit gray, 160×80), as GET /api/screen sends it. */
  frame(display) {
    const size = display === 0 ? FRONT.bytes : BACK.bytes;
    return this.enter((M) => {
      const p = M._malloc(size);
      M._emu_screen_frame(display, p);
      const bytes = M.HEAPU8.slice(p, p + size);
      M._free(p);
      return bytes;
    }, new Uint8Array(size));
  }

  /**
   * Resolves once the GUI has drawn its first frame on both displays (emu_screen_drawn in emu_screen.c): on the tick
   * that draws it, at once if that has happened, and also if the screen goes down first. Before it the services have
   * not been laid out, and a drawing from outside would miss the back display (EMU-253); a bar's web server answers
   * only long after its GUI has drawn, so the device answers nobody before this either. The GUI draws on its first
   * tick or second; if FIRST_FRAME_MS of the module's clock go by without both frames, it rejects with an error
   * (code "EMU_FIRST_FRAME") that names the display without one. The clock counts only while it runs: held, it waits.
   */
  firstFrame() {
    if (this.enter((M) => M._emu_screen_drawn() === BOTH_DRAWN, true)) return Promise.resolve();
    return (this.firstFrameWait ??= new Promise((resolve, reject) => {
      const until = this.clock.now() + FIRST_FRAME_MS;
      // The clock's own timer does not keep the process alive (tick-clock.mjs); a start that waits for its frame does.
      const alive = setTimeout(() => {}, 2 ** 31 - 1);
      // Called on every tick with what has been drawn, and with undefined when the screen goes down.
      this.firstFrameDrawn = (drawn) => {
        if (drawn !== undefined && drawn !== BOTH_DRAWN && this.clock.now() < until) return;
        clearTimeout(alive);
        this.firstFrameDrawn = null;
        if (drawn === undefined || drawn === BOTH_DRAWN) return resolve();
        const missing = ["front", "back"].filter((_, i) => !(drawn & (1 << i))).join(" and ");
        reject(Object.assign(new Error(`The BUSY Bar's system did not draw a first frame on its ${missing} display within ${FIRST_FRAME_MS / 1000} s of its clock (${this.clock.ticks} GUI ticks since it started). This is a fault of the emulator's screen module, not of an app: the BUSY Bar cannot come up without it.`), { code: "EMU_FIRST_FRAME" }));
      };
    }));
  }

  /** Whether the panels sleep (the OFF position): the buffers keep their picture, a person sees dark displays. */
  asleep() {
    return this.enter((M) => M._emu_screen_asleep() !== 0, true);
  }

  /**
   * What the services the status bar shows report: Wi-Fi and BLE state, volume and charge (0-100), USB and charging.
   * Fields left out keep their value; the start is what the goldens' bar showed (packages/engine/native/emu_status.c).
   */
  status(change) {
    this.statusState = { wifi: WifiState.connected, ble: BleStatus.ready, volume: 50, usb: true, charge: 100, charging: false, ...this.statusState, ...change };
    const s = this.statusState;
    this.enter((M) => M._emu_screen_status(s.wifi, s.ble, s.volume, s.usb ? 1 : 0, s.charge, s.charging ? 1 : 0));
  }

  /**
   * The engine of the running app failed fatally (out of memory, or anything else): what js_runner tells the
   * supervisor on a bar. The supervisor then shows its warning or asks for a restart.
   */
  jsFatal(outOfMemory) {
    this.enter((M) => M._emu_screen_js_fatal(outOfMemory ? 1 : 0));
  }

  /** The bar goes down: nothing ticks or fires any more, and the requests still waiting are answered 503. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clock.stop();
    this.pendingStart = null;
    for (const resolve of this.waiting.values()) resolve();
    this.firstFrameDrawn?.(undefined);
  }

  /** A change the module made itself (Bluetooth turned on in its settings): the host's copy follows. */
  noteStatus(change) {
    this.statusState = { ...this.statusState, ...change };
  }

  /** A key event (firmware InputKey and InputType values), as the input service publishes it. */
  input(key, type) {
    this.enter((M) => M._emu_screen_input(key, type));
  }

}

/** mongoose's reply: "HTTP/1.1 <status> <text>\r\n<headers>\r\n\r\n<body>". */
function parseReply(bytes) {
  const text = new TextDecoder("latin1").decode(bytes);
  const end = text.indexOf("\r\n\r\n");
  const lines = text.slice(0, end).split("\r\n");
  const status = Number(lines[0].split(" ")[1]);
  const headers = lines
    .slice(1)
    .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()])
    .filter(([k]) => !/^(content-length|access-control-.*)$/i.test(k));
  return { status, headers, body: bytes.slice(end + 4) };
}
