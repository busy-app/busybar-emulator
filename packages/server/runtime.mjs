// One running app: an instance of the firmware's JS runtime (emulator/packages/engine/build/<version>/runtime.*) plus the host side the
// runtime calls into — files, clock, timers and the network. A new wasm instance per launch, as the bar gives every
// app a fresh JerryScript context.
//
// At bar speed (bar-speed.mjs) the app is single-threaded and slow, as on the bar: after each entry into the runtime
// (a slice) the app stays busy for the bar's time for the slice's work, counted in byte-code instructions and heap
// bytes. Events that come meanwhile (timers, keys, fetch answers) wait in the order they are due, at most one per
// timer; Date.now() inside a slice advances by the work done so far, and timers and requests the slice starts count
// from the bar's time of the call.
//
// The app keeps its own time: a slice starts when its event is due or when the app is free, whichever is later, not
// when the host's timer happened to fire. setTimeout on Windows fires in steps of ~15.6 ms, so counting from the
// firing would add up to a step to every wait (a fetch is three slices); this way the app's time is the bar's, and the
// wall clock is at most one step behind it. When this computer is busy and the host's timers come late, what the app
// missed is made up the same way, up to MAX_CATCH_UP_MS (tick-clock.mjs): the app's clock lags the computer's for a
// moment and never runs ahead of it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import v8 from "node:v8";
import { pathToFileURL } from "node:url";

import { computerNow } from "./computer-clock.mjs";
import { request } from "./http-client.mjs";
import { BAR_API_PORT } from "./local-access.mjs";
import { MAX_CATCH_UP_MS } from "./tick-clock.mjs";

/**
 * Whether a request is to the bar's own API, which the emulator answers in the process: `http://localhost/...` or
 * `http://127.0.0.1/...` on port 80, as on a bar. Every other request — other ports of localhost among them — goes out
 * through the network client, which keeps this computer's loopback from the app (local-access.mjs).
 */
export const isBarApi = (u) => u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && (Number(u.port) || BAR_API_PORT) === BAR_API_PORT;

// A firmware's runtime, ready to instantiate: loaded and compiled once for each firmware a process runs, and shared
// by every server and every launch of that firmware. Firmware folder → Promise<{ createModule, instantiateWasm }>.
const loaded = new Map();

/**
 * The runtime of `firmware` (firmware.mjs's loadFirmware). The first call for a firmware compiles its wasm, which
 * takes this thread about 0.3 s; a server does it when it starts, so that no app waits for it.
 */
export function loadRuntime(firmware) {
  let runtime = loaded.get(firmware.dir);
  if (!runtime) {
    runtime = compileRuntime(firmware);
    loaded.set(firmware.dir, runtime);
    // A failure is not kept: the next call tries again.
    runtime.catch(() => loaded.delete(firmware.dir));
  }
  return runtime;
}

async function compileRuntime(firmware) {
  const { default: createModule } = await import(pathToFileURL(join(firmware.dir, "runtime.mjs")).href);
  const bytes = readFileSync(join(firmware.dir, "runtime.wasm"));
  // Compiled fully optimised (about 0.3 s), and instantiated per launch. By default V8 first runs wasm code
  // unoptimised and optimises what gets hot, so an app would run several times slower for its first seconds. V8's
  // flags belong to the whole process, so they are switched and switched back in one go, with nothing in between:
  // they are V8's defaults again before anything else compiles (async compiles hang without lazy compilation). Back
  // to the defaults, not to what the process had: one started with --no-liftoff of its own loses it here, and a
  // program with wasm of its own to look after should run the server as a separate process, not load this module.
  // Bar speed does not depend on this (it counts work, not time); --fast and the app's start do.
  v8.setFlagsFromString("--no-liftoff");
  v8.setFlagsFromString("--no-wasm-lazy-compilation");
  let wasmModule;
  try {
    wasmModule = new WebAssembly.Module(bytes);
  } finally {
    v8.setFlagsFromString("--liftoff");
    v8.setFlagsFromString("--wasm-lazy-compilation");
  }
  const instantiateWasm = (imports, receive) => {
    WebAssembly.instantiate(wasmModule, imports).then((instance) => receive(instance, wasmModule));
    return {};
  };
  return { createModule, instantiateWasm };
}

/**
 * The longest one entry into the app's JS (a slice) may hold this thread, ms of this thread's own time. The emulator's
 * own limit: on the bar the app's JS has a thread of its own, and a loop that never returns leaves the bar working
 * until a long Back stops it. Here the app's JS runs on the server's only thread, so the halt handler asks the host
 * (sliceOverdue) and the app is stopped as by a long Back, with a line in the log. 2 s: a long Back takes about one;
 * the shortest wait of the command line for the server is 3 s (probe in cli/system.mjs); and the JS of a slice that
 * runs 2 s on this computer would take minutes on the bar (bar-speed.mjs), so no app that works on a bar is stopped.
 * The thread's time (threadMs), not the clock's: on a computer busy with other programs the JS gets a part of the
 * processor only, and by the clock a slice of half a second of work went past the limit (EMU-294, a gate's load).
 */
export const SLICE_LIMIT_MS = 2000;

/**
 * The clock's own bound on a slice, ms: past it the app is stopped whatever part of the processor its JS had. By the
 * thread's time alone a loop held the server as long as the system took to give it SLICE_LIMIT_MS of work: on a gate's
 * load, 5 s and more by the clock, with every request waiting (a release rehearsal of 12.11). Twice the limit: on a
 * quiet computer the thread's time stops a loop first, at SLICE_LIMIT_MS; a slice of 0.8 s of work runs to its end
 * while the JS gets a fifth of a processor or more.
 */
export const SLICE_CLOCK_LIMIT_MS = 2 * SLICE_LIMIT_MS;

/**
 * The processor time this thread has had, ms: what its JS did, without the time the system gave other programs. The
 * clock's time where Node has no such count.
 */
const threadMs =
  typeof process !== "undefined" && typeof process.threadCpuUsage === "function"
    ? () => {
        const { user, system } = process.threadCpuUsage();
        return (user + system) / 1000;
      }
    : () => performance.now();

// JsRunnerConsoleSeverity in the firmware's js_runner.h, for a firmware whose build does not list them.
const SEVERITIES = ["log", "info", "warn", "error"];

/** Firmware InputKey and InputType values (furi_hal_resources.h, input.h). */
export const InputKey = { up: 0, down: 1, right: 2, left: 3, ok: 4, back: 5, start: 6, busy: 7, custom: 8, off: 9, apps: 10, settings: 11 };
export const InputType = { press: 0, release: 1, short: 2, long: 3, repeat: 4 };

// What of a response may wait for the app, per request: the bar's fetch thread stops reading when the app's queue of
// fetch messages is full (js_runner_i.h MAX_FETCH_MESSAGES, 32), each one read of at most a couple of kilobytes.
export const FETCH_WAITING_BYTES = 32 * 2048;
// The bar's system heap left to an app's requests: the firmware holds a response body there until the app takes it
// (js_fetch.c chunk queue; js_fetch_body_methods.c collects the whole body for text(), json(), arrayBuffer() and
// bytes(), a realloc to the exact size for every read, so the old and the new copy at once). The heap is what the
// U5's 2496 KiB of RAM leave; the figure is an estimate, not measured on a bar (the bar's CLI `free` gives it). More
// than that ends the app as out of memory: on a bar the firmware fails its allocation.
export const SYSTEM_HEAP_FREE_BYTES = 1024 * 1024;
// The app's latest requests to the network the runtime keeps for the emulator's notes (largestResponse), and how long
// before an out-of-memory end a response still counts as its likely cause, ms of the app's time.
const RESPONSES_KEPT = 8;
const RESPONSE_RECENT_MS = 30_000;
const FATAL = { 10: "out of memory", 12: "reference count limit", 13: "disabled byte code", 14: "GC loop limit", 120: "assertion" };
const STATUS_TEXT = { 200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 500: "Internal Server Error", 503: "Service Unavailable" };

export class AppRuntime {
  /**
   * @param {object} o
   * @param {object} o.firmware the firmware whose runtime runs the app (firmware.mjs's loadFirmware)
   * @param {string} o.appId
   * @param {number} o.heapKib
   * @param {string} [o.entry] device path of the entry script; the app's scripts/main.js by default
   * @param {(path: string) => Uint8Array | null} o.readFile device path → bytes
   * @param {(path: string, bytes: Uint8Array) => boolean} o.writeFile
   * @param {(req: {method: string, url: string, headers: Record<string,string>, body: Uint8Array | null}) => Promise<{status: number, headers: [string,string][], body: Uint8Array}>} o.localApi
   * @param {(severity: string, text: string) => void} o.onConsole
   * @param {(level: number, tag: string, text: string) => void} o.onLog
   * @param {(text: string) => void} [o.onUnhandled] a promise of the app was rejected and nothing handled it by the end
   *   of the slice: the reason in words, and where it was made or rejected when that is known (emu_runner.c). The
   *   emulator's own note: the bar says nothing of it
   * @param {(reason: string) => void} o.onExit
   * @param {(ms: number) => void} [o.onOverdue] a slice ran longer than `sliceLimitMs` and the app was stopped; onExit
   *   follows with the reason
   * @param {number} [o.sliceLimitMs] the longest a slice may hold this thread (SLICE_LIMIT_MS by default)
   * @param {number} [o.sliceClockLimitMs] the longest a slice may take by the clock (SLICE_CLOCK_LIMIT_MS by default,
   *   twice sliceLimitMs)
   * @param {() => number} [o.tzOffsetMin]
   * @param {() => number} [o.clockOffset] ms the bar's clock is from the computer's ticks' clock (computerNow)
   * @param {() => boolean} [o.online] whether the bar has Wi-Fi; without it requests to the network fail
   * @param {(url: string, method: string) => {status: number, headers: [string,string][], body: Uint8Array} | null} [o.deviceKey]
   *   the emulator's own answer to a request made with the device key (device-key.mjs); null: none, ask the network
   * @param {object} [o.localAccess] the ports of this computer's loopback the app may reach (local-access.mjs's
   *   createLocalAccess); none when left out
   * @param {(url: string, refusal: {why: string, port: number, address: string}) => void} [o.onRefused] a request of the
   *   app to this computer was refused; the app gets lib/fetch's "socket error"
   * @param {(r: {url: string, method: string, status: number, location: string | null}) => void} [o.onRedirect] the
   *   network answered a request of the app with a redirect (3xx), which lib/fetch does not follow
   * @param {(e: {url: string, method: string, message: string, afterHead: boolean, bytes: number}) => void} [o.onNetworkError]
   *   a request of the app to the network failed with lib/fetch's error `message`: before its head came, or after it
   *   with `bytes` of the body (a refusal to this computer is onRefused's)
   * @param {{jsMs: (ops: number, bytes: number) => number, localApiMs: (bytes: number) => number, networkMs: (url: string, bytes: number) => number}} [o.speed] bar speed
   *   (bar-speed.mjs); none: the computer's
   */
  constructor(o) {
    Object.assign(this, o);
    if (!this.firmware) throw new Error("AppRuntime needs the firmware to run the app on (loadFirmware in firmware.mjs)");
    // 1.3.1 has no "warn".
    this.severities = this.firmware.info.consoleSeverities ?? SEVERITIES;
    this.timers = new Map();
    this.fetches = new Map(); // fetch → a function that stops its network request, or null
    this.exited = null;
    this.consoleLine = "";
    // busyMs: the app's JS time as the bar would spend it; draws: display/draw requests.
    this.stats = { calls: 0, wasmMs: 0, maxWasmMs: 0, maxCpuMs: 0, busyMs: 0, draws: 0, heapSize: 0, heapNow: 0, heapPeak: 0 };
    this.queue = []; // { fn, key, due } waiting for the app to be free, by due time
    this.busyUntil = 0; // the app's time (Unix ms) when it is free again
    this.skipped = 0; // ms that passed for the app at once (skip): its time is that far ahead of the computer's
    this.slice = null; // { start, ops, bytes } while JS runs: its start in the app's time and the work counters then
    this.drainTimer = null;
    this.sliceLimitMs ??= SLICE_LIMIT_MS;
    this.sliceClockLimitMs ??= (SLICE_CLOCK_LIMIT_MS / SLICE_LIMIT_MS) * this.sliceLimitMs;
    this.callStart = null; // performance.now() at the start of the current entry into the runtime, while JS runs
    this.callCpu = 0; // threadMs() then
    this.overdue = false; // the watchdog stopped the app (sliceOverdue)
    this.systemHeapBase = null; // the firmware's heap in use once the app's script has run, bytes (emu_system_heap)
    this.responses = []; // the app's latest requests to the network: { url, method, head, bytes, at, refused }
  }

  /**
   * The largest response body the app got from the network within `ms` before now (the app's time), or null: what
   * the emulator names when the app runs out of memory soon after.
   * @returns {{ url: string, method: string, bytes: number } | null}
   */
  largestResponse(ms = RESPONSE_RECENT_MS) {
    const since = this.wall() - ms;
    let largest = null;
    for (const r of this.responses) if (r.at >= since && r.bytes > (largest?.bytes ?? 0)) largest = r;
    return largest && { url: largest.url, method: largest.method, bytes: largest.bytes };
  }

  /**
   * The computer's clock, the one the system's ticks and timers go by (computer-clock.mjs): it never goes back. Plus
   * the time that passed for the app at once (skip).
   */
  wall() {
    return computerNow() + this.skipped;
  }

  /**
   * Time passes for the app at once (the device's passTime; busy-emulator time advance): `ms` are over without a
   * wait. Every timer of the app counts from the new time: what was due within those ms is due now and fires at
   * once, in the order it was due, and what was due later is that much nearer. A periodic timer fires once for the
   * periods left out, as a late one does on the bar, and goes on on its beat. A request to the network is not
   * hurried: its answer comes when the network gives it.
   */
  skip(ms) {
    if (this.exited || !(ms > 0)) return;
    this.skipped += ms;
    const now = this.wall();
    for (const t of this.timers.values()) {
      // A periodic timer runs once for the periods passed over: at the last of them, and on its beat from there.
      const period = Math.max(t.ms, 1);
      if (t.periodic && t.due < now) t.due += Math.floor((now - t.due) / period) * period;
    }
    // Earliest first: the host fires timers that are due at once in the order they were set.
    for (const t of [...this.timers.values()].filter((t) => !t.fired).sort((a, b) => a.due - b.due)) this.arm(t);
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.drain();
  }

  /**
   * Sets the host's timer for an app's timer by the app's time as it is now: when it fires, the run is due at the
   * timer's own time, however late the host was. A periodic timer is set again by its run (runTimer), from the time
   * of that run, never by the host's setInterval: that one drops the runs it was late for and drifts by its own
   * lateness every period (a millisecond on macOS, up to 16 ms on Windows), and the app fell behind with it.
   */
  arm(t) {
    clearTimeout(t.handle);
    t.handle = setTimeout(() => {
      t.handle = null;
      // Node fires a timer up to a millisecond early (it counts by the event loop's whole ms). At the computer's speed
      // the run starts when the host fired, so a run the host was late for, landed just before the next period, and
      // that next run, fired early, came in the same ms of the app's clock: one period run twice (EMU-294, a gate's
      // load: "200/0 0/0"). A run is never before its time.
      if (this.wall() < t.due) {
        this.arm(t);
        return;
      }
      this.post((start) => this.runTimer(t, start), t.timer, t.due);
      if (!t.periodic) t.fired = true;
    }, Math.max(0, t.due - this.wall()));
  }

  /**
   * A run of an app's timer, in a slice that starts at `start` (the app's time). A periodic timer is due again as the
   * firmware's event loop has it (furi_event_loop_process_expired_timers): before its callback, at the first of its
   * periods after `start`. So the runs a busy computer delayed are made up one after another, each at its own time,
   * as the bar would have run them; the runs the app itself was too busy for (bar speed) are one run, as on the bar.
   * After more than the ticks make up (MAX_CATCH_UP_MS: a long stall, the computer's clock moved forward, a skip)
   * the drain starts the run at now, and the timer goes on from there.
   */
  runTimer(t, start) {
    // Stopped or started again meanwhile: the firmware drops a run it no longer has a timer for.
    if (this.timers.get(t.timer) !== t) return;
    if (t.periodic) {
      const period = Math.max(t.ms, 1);
      if (start - t.due > MAX_CATCH_UP_MS) t.due = start + period;
      // At the computer's speed the run starts when the host fired, never before t.due (arm).
      else t.due += Math.max(1, Math.floor((start - t.due) / period) + 1) * period;
      this.arm(t);
    }
    this.M._emu_timer_fire(t.timer);
  }

  /** The app's clock: inside a slice it advances by the bar's time for the work done so far. */
  now() {
    if (!this.speed) return this.wall();
    if (this.slice) return this.slice.start + this.sliceMs();
    return Math.max(this.wall(), this.busyUntil);
  }

  /** The work counters of the runtime: instructions executed and heap bytes allocated since it started (32 bits). */
  work() {
    return { ops: this.M._emu_vm_ops_count(), bytes: this.M._emu_alloc_bytes_count() };
  }

  /** The bar's time, ms, for what the current slice has done so far. */
  sliceMs() {
    const { ops, bytes } = this.work();
    // The counters wrap around; a slice does not do 4 billion of either.
    return this.speed.jsMs((ops - this.slice.ops) >>> 0, (bytes - this.slice.bytes) >>> 0);
  }

  /**
   * Loads the runtime and runs the entry script. Returns emu_run_file's status: 0 ok, 1 the file could not be read,
   * 2 parse error, 3 link error, 4 the script threw (and `startError` says what).
   */
  async start() {
    const host = {
      log: (level, tag, text) => this.onLog(level, tag, text),
      console: (severity, text, separator) => {
        this.consoleLine += text + (separator === 1 ? " " : "");
        if (separator === 2) {
          this.onConsole(this.severities[severity] ?? "log", this.consoleLine);
          this.consoleLine = "";
        }
      },
      // Date.now(): the bar's clock, on the app's time. clockOffset is how far that is from the ticks' clock: the
      // computer's clock set back (computer-clock.mjs) and the bar's set apart from it (POST /api/time/timestamp).
      // The time that passed at once (skip) is in the bar's clock already, so it is taken off the app's own here.
      now: () => this.now() - this.skipped + (this.clockOffset?.() ?? 0),
      tza: () => (this.tzOffsetMin ? this.tzOffsetMin() : -new Date().getTimezoneOffset()) * 60000,
      fatal: (code) => {
        this.fatal = FATAL[code] ?? `code ${code}`;
      },
      appDone: () => queueMicrotask(() => this.exit("finished")),
      // The halt handler's question, every few thousand backward branches (emu_runner.c): true stops the app.
      sliceOverdue: () => {
        if (this.callStart === null) return false;
        const clock = performance.now() - this.callStart;
        if (clock < this.sliceLimitMs) return false;
        // The clock first, as it costs nothing; then the thread's own time, read only once the clock is past the limit,
        // until the clock's own bound.
        if (clock < this.sliceClockLimitMs && threadMs() - this.callCpu < this.sliceLimitMs) return false;
        this.overdue = true;
        return true;
      },
      fileRead: (path) => this.readFile(path),
      fileWrite: (path, bytes) => this.writeFile(path, bytes),
      timerStart: (timer, ms, periodic) => {
        // Due in the app's time: from the call, which in a slice is the bar's time, not the computer's.
        const t = { timer, ms, periodic: Boolean(periodic), handle: null, due: this.now() + ms, fired: false };
        this.timers.set(timer, t);
        this.arm(t);
      },
      timerStop: (timer) => this.clearTimer(timer),
      fetchStart: (fetch, url, method, headers, body, deviceKey) => {
        this.fetches.set(fetch, null);
        const start = this.now();
        // After the slice: the bar's API (the screen module for display/draw) is not the app's JS and is not slowed.
        queueMicrotask(() => {
          try {
            // A URL the WHATWG parser refuses can still be the firmware's to send (http-client.mjs, firmwareUrl).
            const u = URL.canParse(url) ? new URL(url) : null;
            if (u && isBarApi(u)) this.localFetch(fetch, start, u, url, method, headers, body).catch((e) => this.fetchFailed(fetch, String(e?.message ?? e)));
            else this.networkFetch(fetch, start, url, method, headers, body, deviceKey);
          } catch (e) {
            this.fetchFailed(fetch, String(e?.message ?? e));
          }
        });
      },
      fetchStop: (fetch) => this.dropFetch(fetch),
    };
    const { createModule, instantiateWasm } = await loadRuntime(this.firmware);
    const M = await createModule({ host, instantiateWasm, print: () => {}, printErr: (t) => this.onLog(2, "wasm", t) });
    // Terminated while it was loading: the script never runs.
    if (this.exited) return 0;
    this.M = M;
    this.withString(this.appId, (p) => this.M._emu_init(p, this.heapKib));
    const entry = this.entry ?? `/ext/user_assets/${this.appId}/scripts/main.js`;
    const status = this.call(() => this.withString(entry, (p) => this.M._emu_run_file(p))) ?? 0;
    if (!this.exited) this.systemHeapBase = this.systemHeap()?.used ?? null;
    if (status !== 0) this.startError = this.M.UTF8ToString(this.M._emu_last_error());
    if (!this.exited && status !== 0) {
      const stage = ["", "reading", "parsing", "linking", "running"][status] ?? status;
      this.exit(`error ${stage} main.js: ${this.startError}`);
    }
    return status;
  }

  /** A key event from the device; returns false if the app has ended. */
  input(key, type) {
    if (this.exited) return false;
    this.post(() => this.M._emu_input(key, type));
    return true;
  }

  /** The firmware's force quit (long Back): the halt handler aborts the script, then the app is gone. */
  terminate(reason = "quit") {
    if (this.exited) return;
    // Nothing to halt in a runtime that is still loading.
    this.M?._emu_terminate();
    this.exit(reason);
  }

  exit(reason) {
    if (this.exited) return;
    this.exited = this.fatal ? `fatal: ${this.fatal}` : reason;
    for (const timer of [...this.timers.keys()]) this.clearTimer(timer);
    this.queue = [];
    clearTimeout(this.drainTimer);
    for (const fetch of [...this.fetches.keys()]) this.dropFetch(fetch);
    this.onExit(this.exited);
  }

  clearTimer(timer) {
    const t = this.timers.get(timer);
    if (t) clearTimeout(t.handle); // stops an interval too, in Node
    this.timers.delete(timer);
  }

  dropFetch(fetch) {
    this.fetches.get(fetch)?.();
    this.fetches.delete(fetch);
  }

  /** An event of a request, for as long as the app still wants it: it may have dropped the request meanwhile. */
  postFetch(fetch, fn, due) {
    this.post(() => this.fetches.has(fetch) && fn(), undefined, due);
  }

  /**
   * A piece of a response body into the firmware, which keeps it until the app takes it. Past SYSTEM_HEAP_FREE_BYTES
   * the bar has no room left: the app ends as out of memory, and its requests stop.
   */
  fetchData(fetch, bytes) {
    this.withBytes(bytes, (p, n) => this.M._emu_fetch_data(fetch, p, n));
    const heap = this.systemHeap();
    if (!heap || this.systemHeapBase === null || this.exited) return;
    if (heap.peak - this.systemHeapBase <= SYSTEM_HEAP_FREE_BYTES) return;
    this.onLog(2, "JsFetch", `out of memory: the firmware held over ${SYSTEM_HEAP_FREE_BYTES / 1024} KiB of response data for the app; a BUSY Bar has no more room for it`);
    this.fatal = FATAL[10];
    this.exit("aborted");
  }

  /** The firmware's heap: bytes in use now and the most at once since the last look (emu_system_heap). */
  systemHeap() {
    // A runtime built before the emulator counted it has no such export.
    if (!this.M?._emu_system_heap) return null;
    const p = this.M._malloc(8);
    this.M._emu_system_heap(p);
    const [used, peak] = this.M.HEAPU32.subarray(p >> 2, (p >> 2) + 2);
    this.M._free(p);
    return { used, peak };
  }

  /** lib/fetch's failure: the error callback with its text, then the end of the request. */
  fetchFailed(fetch, message, due) {
    this.postFetch(fetch, () => this.withString(message, (p) => this.M._emu_fetch_error(fetch, p)), due);
    this.postFetch(fetch, () => this.M._emu_fetch_finish(fetch, 0), due);
  }

  // A request to the bar's own API. The response reaches the runtime the way lib/fetch delivers it on the bar: raw
  // header block, body chunks, finish. At bar speed it comes no sooner than the bar's API answers (bar-speed.mjs),
  // counting from the call.
  async localFetch(fetch, start, u, url, method, headerLines, body) {
    const headers = {};
    for (const line of headerLines) {
      const i = line.indexOf(":");
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    if (method === "POST" && u.pathname === "/api/display/draw") this.stats.draws++;
    const due = this.speed ? start + this.speed.localApiMs(body?.length ?? 0) : start;
    const res = await this.localApi({ method, url, headers, body });
    if (!this.fetches.has(fetch) || this.exited) return;
    const head = `HTTP/1.1 ${res.status} ${STATUS_TEXT[res.status] ?? ""}\r\n${res.headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}Content-Length: ${res.body.length}\r\n\r\n`;
    this.postFetch(fetch, () => this.withBytes(new TextEncoder().encode(head), (p, n) => this.M._emu_fetch_headers(fetch, p, n)), due);
    for (let i = 0; i < res.body.length; i += 2048) {
      const chunk = res.body.subarray(i, i + 2048);
      this.postFetch(fetch, () => this.fetchData(fetch, chunk), due);
    }
    this.postFetch(fetch, () => this.M._emu_fetch_finish(fetch, 1), due);
  }

  // A request to the network, made as the firmware makes it (http-client.mjs): the head and the pieces of the body
  // reach the app as they come, and so do lib/fetch's errors. The header js_fetch.c adds for the bar's own API goes
  // out too, as on the bar.
  networkFetch(fetch, start, url, method, headerLines, body, deviceKey) {
    // Without Wi-Fi the bar cannot resolve the name. (The text and the delay on a bar are not checked.)
    if (this.online && !this.online()) return this.fetchFailed(fetch, "Failed to connect to server");
    // At bar speed nothing of the answer comes sooner than the bar takes for such a request: the TLS handshake of an
    // https request alone is over a second there.
    const soonest = this.speed ? start + this.speed.networkMs(url, body?.length ?? 0) : 0;
    const due = () => Math.max(this.wall(), soonest);
    // Asked with the device key, which the emulator does not have: its own answer where it has one.
    const canned = deviceKey ? this.deviceKey?.(url, method) : null;
    if (canned) {
      const head = `HTTP/1.1 ${canned.status} ${STATUS_TEXT[canned.status] ?? ""}\r\n${canned.headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}Content-Length: ${canned.body.length}\r\nConnection: close\r\n\r\n`;
      this.postFetch(fetch, () => this.withBytes(new TextEncoder().encode(head), (p, n) => this.M._emu_fetch_headers(fetch, p, n)), due());
      for (let i = 0; i < canned.body.length; i += 2048) {
        const piece = canned.body.subarray(i, i + 2048);
        this.postFetch(fetch, () => this.fetchData(fetch, piece), due());
      }
      this.postFetch(fetch, () => this.M._emu_fetch_finish(fetch, 1), due());
      return;
    }
    let waiting = 0; // bytes of the body read and not yet handed to the firmware
    // What the app got of this response, for the emulator's notes (largestResponse, onNetworkError).
    const response = { url, method, head: false, bytes: 0, at: this.wall(), refused: false };
    this.responses.push(response);
    if (this.responses.length > RESPONSES_KEPT) this.responses.shift();
    const stop = request({
      url,
      method,
      headers: headerLines,
      body,
      // The ports of this computer the app may reach; none unless the emulator was told (local-access.mjs).
      access: this.localAccess,
      onRefused: (refusal) => {
        response.refused = true;
        this.onRefused?.(url, refusal);
      },
      onHead: (head) => {
        response.head = true;
        // A redirect, which lib/fetch does not follow: the app gets it as it is.
        const text = Buffer.from(head).toString("latin1");
        const status = Number(/^HTTP\/\d(?:\.\d)? (\d{3})/.exec(text)?.[1]);
        if (status >= 300 && status < 400) {
          const location = /^location:[ \t]*(.*?)[ \t]*$/im.exec(text)?.[1] || null;
          // Said when the app gets the head, so that the note and the app's own lines come in the app's order.
          this.postFetch(fetch, () => this.onRedirect?.({ url, method, status, location }), due());
        }
        this.postFetch(fetch, () => this.withBytes(head, (p, n) => this.M._emu_fetch_headers(fetch, p, n)), due());
      },
      onData: (chunk) => {
        response.bytes += chunk.length;
        response.at = this.wall();
        // The firmware hands over what one read brought; a read is at most a couple of kilobytes there.
        for (let i = 0; i < chunk.length; i += 2048) {
          const piece = chunk.subarray(i, i + 2048);
          waiting += piece.length;
          this.postFetch(fetch, () => {
            waiting -= piece.length;
            if (waiting <= FETCH_WAITING_BYTES / 2) stop.resume();
            this.fetchData(fetch, piece);
          }, due());
        }
        // More waits than the bar's queue holds: the connection is not read until the app has taken some.
        if (waiting > FETCH_WAITING_BYTES) stop.pause();
      },
      onError: (message) => {
        // A refusal has its own note (onRefused).
        if (!response.refused) {
          const failure = { url, method, message, afterHead: response.head, bytes: response.bytes };
          this.postFetch(fetch, () => this.onNetworkError?.(failure), due());
        }
        this.postFetch(fetch, () => this.withString(message, (p) => this.M._emu_fetch_error(fetch, p)), due());
      },
      onEnd: (ok) => this.postFetch(fetch, () => this.M._emu_fetch_finish(fetch, ok ? 1 : 0), due()),
    });
    if (this.fetches.has(fetch)) this.fetches.set(fetch, stop);
    else stop();
  }

  /**
   * An event for the app, due at `due` (the app's time; now by default): runs when it is due and the app is free,
   * after the events due before it. A timer (`key`) waits at most once: on the bar too a late periodic timer fires
   * once, not once per missed period. At the computer's speed events run as they come.
   */
  post(fn, key, due = this.wall()) {
    if (this.exited) return;
    if (key !== undefined && this.queue.some((e) => e.key === key)) return;
    if (!this.speed) due = 0;
    // After everything due no later, so the parts of one answer keep their order.
    const i = this.queue.findIndex((e) => e.due > due);
    this.queue.splice(i < 0 ? this.queue.length : i, 0, { fn, key, due });
    // It may be due before what the drain is waiting for.
    clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.drain();
  }

  /**
   * The app's time for something due at `due`: that, unless it is further behind the computer's clock than the ticks
   * make up (MAX_CATCH_UP_MS, tick-clock.mjs) — after the process stood or the computer's clock jumped forward. Then
   * now: the app does not go on living that far in the past.
   */
  caughtUp(due) {
    const now = this.wall();
    return due < now - MAX_CATCH_UP_MS ? now : due;
  }

  drain() {
    if (this.drainTimer) return;
    while (this.queue.length && !this.exited) {
      const start = Math.max(this.caughtUp(this.queue[0].due), this.busyUntil);
      const wait = start - this.wall();
      if (wait > 0) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = null;
          this.drain();
        }, wait);
        return;
      }
      const { fn } = this.queue.shift();
      this.call(() => fn(start), start);
    }
  }

  /**
   * Every entry into the runtime: timing, heap, and the end of the app on a fatal error (the wasm instance aborts).
   * `start` is the slice's start in the app's time; at the computer's speed it is always now.
   */
  call(fn, start = this.wall()) {
    if (this.exited) return undefined;
    const t0 = performance.now();
    if (this.speed) this.slice = { start, ...this.work() };
    let result;
    this.callStart = t0;
    this.callCpu = threadMs();
    try {
      result = fn();
    } catch (e) {
      this.slice = null;
      this.exit(`aborted: ${e.message}`);
      return undefined;
    } finally {
      this.callStart = null;
    }
    const dt = performance.now() - t0;
    const cpu = threadMs() - this.callCpu;
    // At the computer's speed nothing waits: events run as they come, and the app is busy for as long as its JS ran.
    const busy = this.speed ? this.sliceMs() : dt;
    if (this.speed) this.busyUntil = this.slice.start + busy;
    this.slice = null;
    this.stats.calls++;
    this.stats.wasmMs += dt;
    this.stats.busyMs += busy;
    this.stats.maxWasmMs = Math.max(this.stats.maxWasmMs, dt);
    this.stats.maxCpuMs = Math.max(this.stats.maxCpuMs, cpu);
    this.sampleHeap();
    this.takeUnhandled();
    // The watchdog stopped the script (sliceOverdue): the app ends as after a long Back.
    if (this.overdue && !this.exited) {
      this.onOverdue?.(this.sliceLimitMs);
      this.exit(`stopped: did not return for ${this.sliceLimitMs / 1000} s`);
    }
    return result;
  }

  /** The rejections that nothing handled in the slice just over, for the log; the app is not touched. */
  takeUnhandled() {
    // A runtime built before the emulator noted them has no such export.
    if (!this.M._emu_unhandled_take) return;
    for (;;) {
      const text = this.M.UTF8ToString(this.M._emu_unhandled_take());
      if (!text) return;
      this.onUnhandled?.(text);
    }
  }

  sampleHeap() {
    const p = this.M._malloc(12);
    if (this.M._emu_heap_stats(p)) {
      const [size, now, peak] = this.M.HEAPU32.subarray(p >> 2, (p >> 2) + 3);
      this.stats.heapSize = size;
      this.stats.heapNow = now;
      this.stats.heapPeak = Math.max(this.stats.heapPeak, peak);
    }
    this.M._free(p);
  }

  withBytes(bytes, fn) {
    const p = this.M._malloc(Math.max(bytes.length, 1));
    this.M.HEAPU8.set(bytes, p);
    try {
      return fn(p, bytes.length);
    } finally {
      this.M._free(p);
    }
  }

  withString(text, fn) {
    return this.withBytes(new TextEncoder().encode(text + "\0"), (p) => fn(p));
  }
}
