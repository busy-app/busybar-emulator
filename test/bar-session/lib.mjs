// What the BUSY Bar session's groups share: the device they run on (a BUSY Bar, or an emulator that plays one), its API, its
// apps, its log and its CLI, a person at it, the observations a group records and the parts it runs or skips.
//
// A group (groups/*.mjs) is a task of the backlog: its parts, each with what it needs (the owner's consent to a risk,
// a person at the BUSY Bar, the standard BUSY Bar for speed), run one after another. A part either runs a suite's own
// --record (golden, timed, state, api, fetch, speed: the suite writes its recording where it reads it) or records
// observations: values the group's probes saw, written to bar-session/recordings/<firmware>/<group>.json, which
// bar-session.test.mjs replays in an emulator of that firmware and compares, value by value, as each says: `exact`
// (the same), `within` (a number within a tolerance) or `raw` (shown, not compared: what the BUSY Bar does there is
// not known yet, and a check would only guess).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { targz } from "../package.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
export const testDir = dirname(here);

/**
 * The session's state of stopping, shared by all its parts: `stopped` says why the session stops (Ctrl+C, SIGTERM,
 * SIGHUP, the firmware changed), and from then on every request to the device and every pause ends the part with
 * Stop, so that nothing more is sent; `restoring` lets the putting back through; `child` is the suite running now,
 * which a stop is passed on to.
 */
export const control = { stopped: null, restoring: false, child: null, waiters: new Set() };
export class Stop extends Error {}

/** Stops the session (a signal, a firmware that changed, a restart that did not happen): see control. */
export function stopSession(reason) {
  control.stopped ??= reason;
  // What waits on something other than the device, a question to the person, is woken.
  for (const wake of [...control.waiters]) wake();
  return new Stop(control.stopped);
}
const halt = () => {
  if (control.stopped && !control.restoring) throw new Stop(control.stopped);
};

/** A pause that ends the part when the session stops. */
export async function sleep(ms) {
  halt();
  await delay(ms);
  halt();
}

// Before a request that may fill the heap or end the app with a fatal error: the BUSY Bar must have been up this
// long. In its first 30 s the supervisor does not restart it but shows its warning and takes no input until Back and
// Start restart it (supervisor.c); after them it restarts by itself.
export const RISKY_UPTIME_S = 35;

// The standard BUSY Bar, the only one speed and pace are measured on (CLAUDE.md of the monorepo), by the SHA-256 of its
// serial number: the public tree carries no serial number.
export const STANDARD_BAR_SHA256 = "fc953f8a501a69e0209f33f7b78c899d62715199d8b59700b6cca69e0c91060f";
export const sha256 = (text) => createHash("sha256").update(String(text)).digest("hex");

// The prefix of every app the kit installs: what is left of them is removed at the end (restore).
export const KIT_PREFIX = "app.probe.kit.";

/** Text outside ASCII as \u escapes: the same JSON, and the public tree carries no Cyrillic text. */
export const asciiJson = (value) => JSON.stringify(value, null, 1).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Log lines the recordings keep: an app's, the JS runtime's and the services an app uses. Lines of the network, the
// radio and the accounts are left out, and addresses are put back as <ip> and <mac>: the recordings may be published.
const LOG_PRIVATE = /wi-?fi|ssid|wlan|\bble\b|bluetooth|password|passw|token|matter|account|cloud|mqtt|ntp/i;
const LOG_KEEP = /\[(E|W)\]|js|app|audio|storage|interval|loader|supervisor|heap|input|fetch|mongoose|http|probe|kit/i;
export function cleanLog(lines, serial) {
  return lines
    .filter((line) => line.trim() && LOG_KEEP.test(line) && !LOG_PRIVATE.test(line))
    .map((line) =>
      line
        .replaceAll(serial ?? "\u0000", "<serial>")
        .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "<mac>")
        .replace(/\b(?!127\.0\.0\.1\b)(?!10\.0\.4\.2[01]\b)\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>"),
    );
}

/** A loopback address other than 127.0.0.1 an app in an emulator can be given for this computer (as fetch.mjs). */
export async function loopbackForApps() {
  for (const [listen, ask] of [["127.0.0.2", "127.0.0.2"], ["127.0.0.1", "0.0.0.0"]]) {
    const probe = net.createServer((socket) => socket.destroy());
    const port = await new Promise((resolve) => probe.once("error", () => resolve(null)).listen(0, listen, () => resolve(probe.address().port)));
    const reached =
      port !== null &&
      (await new Promise((resolve) => {
        const socket = net.connect({ host: ask, port }, () => (socket.destroy(), resolve(true)));
        socket.once("error", () => resolve(false));
      }));
    await new Promise((resolve) => (port === null ? resolve() : probe.close(resolve)));
    if (reached) return { listen, ask };
  }
  throw new Error("no loopback address for the apps' requests: neither 127.0.0.2 nor 0.0.0.0 reaches this computer");
}

/**
 * The device: a BUSY Bar at `addr`, or an emulator that plays one (`emulator`: true; its address on the loopback).
 * `helperPorts`: the ports of this computer the kit's servers listen on (an emulator was started to let apps reach
 * them).
 */
export class Device {
  constructor({ addr, emulator = false, helperPort }) {
    this.addr = addr;
    this.emulator = emulator;
    this.helperPort = helperPort;
    this.serial = null;
  }

  async api(method, path, body = undefined, { timeout = 15000, headers } = {}) {
    halt();
    const r = await fetch(`http://${this.addr}/api/${path}`, { method, body: method === "GET" ? undefined : body, headers, signal: AbortSignal.timeout(timeout) });
    const bytes = Buffer.from(await r.arrayBuffer());
    const text = bytes.toString("utf8");
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, text, json, bytes };
  }

  /** The status and the error's text, or the result: what a check compares of an answer. */
  static short(r) {
    if (!r) return null;
    const said = r.json?.error ?? r.json?.result;
    return `${r.status} ${said ?? r.text.trim().slice(0, 200)}`.trim();
  }

  async frame(display) {
    return (await this.api("GET", `screen?display=${display}`)).text;
  }

  async frames() {
    return { front: await this.frame(0), back: await this.frame(1) };
  }

  /** Serial number, firmware and API version, as the BUSY Bar says them. */
  async identity() {
    const device = await this.api("GET", "status/device", undefined, { timeout: 8000 });
    const firmware = await this.api("GET", "status/firmware", undefined, { timeout: 8000 });
    const version = await this.api("GET", "version", undefined, { timeout: 8000 });
    if (!device.json || !firmware.json) throw new Error(`no BUSY Bar answers at ${this.addr}: ${device.status} ${firmware.status}`);
    this.serial = device.json.serial_number;
    this.firmware = firmware.json.version;
    return { serial: device.json.serial_number, security: device.json.firmware_security, firmware: firmware.json, api: version.json?.api_semver };
  }

  /** Seconds since the BUSY Bar started (GET /api/status/system: "00d 00h 01m 05s"). */
  /** Seconds since the BUSY Bar started, or null when its answer cannot be read. */
  async uptime() {
    const text = (await this.api("GET", "status/system")).json?.uptime ?? "";
    const [d, h, m, s] = (text.match(/\d+/g) ?? []).map(Number);
    // The hours are not taken out of the days (api_status.c).
    const seconds = h * 3600 + m * 60 + s + (h < 24 ? d * 86400 : 0);
    return Number.isFinite(seconds) ? seconds : null;
  }

  /**
   * Waits until the BUSY Bar answers again (after a restart); returns how long that took, ms, or null. A BUSY Bar that
   * comes back on another firmware (an automatic update) stops the session: its recordings would be of two firmwares.
   */
  async waitUp(ms = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      let up = false;
      try {
        up = (await this.api("GET", "status/system", undefined, { timeout: 2000 })).status === 200;
      } catch (e) {
        if (e instanceof Stop) throw e;
      }
      if (up) {
        const version = (await this.api("GET", "status/firmware", undefined, { timeout: 4000 }).catch(() => null))?.json?.version;
        if (this.firmware && version && version !== this.firmware && !control.restoring) {
          throw stopSession(`the BUSY Bar came back on firmware ${version}, not ${this.firmware} (an automatic update?): the session stops; start it again for ${version}`);
        }
        return Date.now() - t0;
      }
      await sleep(500);
    }
    return null;
  }

  /** When the BUSY Bar last started (GET /api/status/system, boot_time), or null when it does not answer. */
  async bootTime() {
    try {
      return (await this.api("GET", "status/system", undefined, { timeout: 1500 })).json?.boot_time ?? null;
    } catch (e) {
      if (e instanceof Stop) throw e;
      return null;
    }
  }

  /** Waits, saying so, until the BUSY Bar has been up RISKY_UPTIME_S (see there). */
  /**
   * Waits, saying so, until the BUSY Bar has been up RISKY_UPTIME_S (see there). An uptime that cannot be read counts
   * as too early: read again for up to `tries` × 5 s, then the part fails rather than go on blind.
   */
  async pastFirstSeconds(say = () => {}, { tries = 12, pauseMs = 5000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const uptime = await this.uptime().catch((e) => {
        if (e instanceof Stop) throw e;
        return null;
      });
      if (uptime !== null && uptime >= RISKY_UPTIME_S) return;
      if (uptime === null) {
        say("      the BUSY Bar's uptime cannot be read: waiting and reading it again");
        await sleep(pauseMs);
        continue;
      }
      say(`      waiting ${RISKY_UPTIME_S - uptime} s: the BUSY Bar's first 30 s after a start are not for this (the supervisor would lock it)`);
      await sleep((RISKY_UPTIME_S - uptime) * 1000);
    }
    throw new Error(`the BUSY Bar's uptime could not be read: not sending what may fill its heap`);
  }

  /**
   * Waits until the BUSY Bar restarts: it stops answering, or it answers with another boot_time (a restart quicker
   * than a look). `since`: the boot_time before. Returns how long that took, ms, or null.
   */
  async waitDown(ms = 60000, since = undefined) {
    const before = since ?? (await this.bootTime());
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const now = await this.bootTime();
      if (now === null || (before !== null && now !== before)) return Date.now() - t0;
      await sleep(250);
    }
    return null;
  }

  /** Restarts the BUSY Bar: its CLI's `power reboot` (an emulator: its own restart). Only with the owner's consent. */
  /**
   * The restart is made sure of: the BUSY Bar must go and come back with another boot_time. If it does not (the CLI did
   * not answer, the BUSY Bar is locked under the supervisor's warning), the session stops: what follows would run on a
   * BUSY Bar that takes no input. Returns how long it took to come back, ms.
   */
  async reboot({ downMs = 60000, upMs = 180000 } = {}) {
    const before = await this.bootTime();
    if (this.emulator) await fetch(`http://${this.addr}/_emu/power?action=restart`, { method: "POST" }).catch(() => {});
    else await this.cli("power reboot", 2);
    const down = await this.waitDown(downMs, before);
    const up = down === null ? null : await this.waitUp(upMs);
    const after = up === null ? null : await this.bootTime();
    if (down === null || up === null || after === null || after === before) {
      throw stopSession(
        `the kit could not restart the BUSY Bar (${down === null ? "it did not go down" : "it did not come back"}): if it shows "JS heap overflow" or "JS fatal error", hold Back and Start until it restarts, then remove the apps app.probe.kit.*`,
      );
    }
    return up;
  }

  /** A command in the BUSY Bar's CLI over telnet (port 23), its output without colors; null in an emulator. */
  async cli(command, wait = 8) {
    if (this.emulator) return null;
    const host = this.addr.split(":")[0];
    return new Promise((resolve) => {
      const socket = net.connect({ host, port: 23 });
      let out = "";
      let sent = false;
      const done = () => {
        socket.destroy();
        const text = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
        resolve(text.slice(text.indexOf(command) >= 0 ? text.indexOf(command) + command.length : 0).trim());
      };
      const timer = setTimeout(done, wait * 1000 + 3000);
      socket.on("data", (d) => {
        out += d.toString("utf8");
        if (!sent && />:\s*$/.test(out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""))) {
          sent = true;
          out = "";
          socket.write(`${command}\r\n`);
        } else if (sent && />:\s*$/.test(out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")) && out.includes("\n")) {
          clearTimeout(timer);
          done();
        }
      });
      socket.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /**
   * Installs an app of the kit: files { path in the app: text or bytes }, or a whole archive (`tgz`). Its localStorage
   * is removed after, unless `keepStorage`.
   */
  async install(id, files = {}, { manifest = {}, tgz = null, keepStorage = false } = {}) {
    const meta = { format_version: 1, id, name: id.slice(KIT_PREFIX.length).replace(/^\w/, (c) => c.toUpperCase()) || id, version: "0.1.0", api_version: "27.14.0", description: "A probe of the BUSY Bar session", debug: false, ...manifest };
    const archive = tgz ?? targz({ [`${id}/appmeta/manifest.json`]: JSON.stringify(meta), ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`${id}/${k}`, v])) });
    await this.api("POST", "apps/quit");
    await sleep(300);
    const staged = await this.api("POST", "apps/stage", archive);
    if (!staged.json?.install_key) throw new Error(`stage ${id}: ${staged.status} ${staged.text}`);
    const installed = await this.api("POST", `apps/install?install_key=${staged.json.install_key}`);
    if (installed.status !== 200) throw new Error(`install ${id}: ${installed.status} ${installed.text}`);
    await sleep(500);
    // A run of the kit starts from an empty localStorage, unless it is what the probe looks at.
    if (!keepStorage) await this.api("DELETE", `storage/remove?path=${localStoragePath(id)}`);
    return meta;
  }

  async launch(id) {
    const r = await this.api("POST", `apps/launch?app_id=${id}`);
    if (r.status !== 200) throw new Error(`launch ${id}: ${r.status} ${r.text}`);
    return Date.now();
  }

  /** Quits and removes an app of the kit, with its settings, its localStorage and its folder of data. */
  async remove(id) {
    await this.api("POST", "apps/quit").catch(() => {});
    await sleep(800);
    await this.api("DELETE", `apps?app_id=${id}`).catch(() => {});
    for (const path of [localStoragePath(id), `/ext/apps_data/jsrunner/${id}.settings.json`, `/ext/apps_data/js_apps/${id}`]) {
      await this.api("DELETE", `storage/remove?path=${path}`).catch(() => {});
    }
  }

  /** An app's localStorage: { key: value }, or null when it has none yet. */
  async localStorage(id) {
    const r = await this.api("GET", `storage/read?path=${localStoragePath(id)}`);
    if (r.status !== 200) return null;
    try {
      return JSON.parse(r.text).data ?? {};
    } catch {
      return null;
    }
  }

  /** Waits until the app's localStorage has `key` (JSON), or `ms` pass; returns its value, parsed, or null. */
  async waitFor(id, key, ms = 30000, done = () => true) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const data = await this.localStorage(id).catch(() => null);
      if (data && data[key] !== undefined) {
        const value = JSON.parse(data[key]);
        if (done(value)) return value;
      }
      await sleep(700);
    }
    const data = await this.localStorage(id).catch(() => null);
    return data && data[key] !== undefined ? JSON.parse(data[key]) : null;
  }

  /** The BUSY Bar's log from the last line that has `marker` on, cleaned for a recording (cleanLog). */
  async logAfter(marker) {
    const dumped = await this.api("POST", "log_dump?filename=emu_kit_log");
    if (dumped.status !== 200) return [];
    const text = (await this.api("GET", "storage/read?path=/ext/emu_kit_log.txt")).text;
    await this.api("DELETE", "storage/remove?path=/ext/emu_kit_log.txt");
    const lines = text.replace(/\r/g, "").split("\n");
    let from = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].includes(marker)) {
      from = i;
      break;
    }
    return cleanLog(from < 0 ? [] : lines.slice(from), this.serial);
  }

  /** A button held down and let go (an emulator only: on a BUSY Bar a person does it). */
  async key(key, action) {
    const r = await fetch(`http://${this.addr}/_emu/key?key=${key}&action=${action}`, { method: "POST" });
    return r.status === 200;
  }

  /**
   * Where the kit's own servers listen: this computer's address on the BUSY Bar's network only (its USB address), not
   * every network the computer is on; for an emulator, the loopback address its apps are given.
   */
  async listenAddress() {
    return this.emulator ? (await loopbackForApps()).listen : this.computerAddress();
  }

  /** This computer's address as an app on the device reaches it: its address on the BUSY Bar's network, or a loopback one. */
  async computerAddress() {
    if (this.emulator) return (await loopbackForApps()).ask;
    const host = this.addr.split(":")[0];
    const mine = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
    const found = mine.find((a) => a.split(".").slice(0, 3).join(".") === host.split(".").slice(0, 3).join("."));
    if (!found) throw new Error(`this computer has no address on the network of the BUSY Bar ${host}`);
    return found;
  }
}

export const localStoragePath = (id) => `/ext/apps_data/jsrunner/${id}.localstorage.json`;

/**
 * What a BUSY Bar holds that the session may change: read before it starts, put back after (restore). The BUSY timer
 * and its two profiles too: a suite stopped half way (state/record.mjs --more) cannot put them back itself.
 */
export async function snapshotOf(device) {
  const json = async (path) => (await device.api("GET", path)).json;
  const brightness = (await json("display/brightness"))?.value;
  return {
    brightness: brightness === undefined ? undefined : String(brightness),
    // The level automatic brightness keeps for when it is turned off is not in the API: asked for at EMU-353.
    manualLevel: null,
    volume: (await json("audio/volume"))?.volume,
    apps: ((await json("apps/list"))?.apps ?? []).map((a) => a.id),
    busy: { snapshot: await json("busy/snapshot"), busy: await json("busy/profiles/busy"), custom: await json("busy/profiles/custom") },
  };
}

// The BUSY timer's state and a profile, without the times that change with every write.
const timeless = (value) => JSON.stringify(value ?? null).replace(/"(snapshot|profile)_timestamp_ms":\d+,?/g, "");

/**
 * Puts the BUSY Bar back: its brightness (and the level under automatic, when the owner said it) and volume (without
 * the click), the BUSY timer and its profiles, no app of the kit left, nothing drawn by the kit. Each step on its own:
 * one that fails does not keep the others from being done. Returns what it did and what it could not, a line each.
 */
export async function restore(device, before, drawnBy = []) {
  control.restoring = true;
  const did = [];
  const attempt = async (what, fn) => {
    try {
      const said = await fn();
      if (said) did.push(said);
    } catch (e) {
      did.push(`NOT PUT BACK: ${what} (${e.message})`);
    }
  };
  const ok = async (what, method, path, body) => {
    const r = await device.api(method, path, body);
    if (r.status !== 200) throw new Error(`${method} /api/${path}: ${r.status} ${r.text.trim().slice(0, 120)}`);
    return r;
  };
  if ((await device.waitUp(60000).catch(() => null)) === null) return ["NOT PUT BACK: anything; the BUSY Bar does not answer"];
  await attempt("quit the app", async () => {
    await device.api("POST", "apps/quit");
    await delay(800);
  });
  let now = before.apps;
  await attempt("the list of apps", async () => {
    now = ((await ok("apps", "GET", "apps/list")).json?.apps ?? []).map((a) => a.id);
  });
  for (const id of now.filter((one) => !before.apps.includes(one) && (one.startsWith("app.probe.") || one.startsWith("app.golden.")))) {
    await attempt(`remove ${id}`, async () => {
      await device.remove(id);
      const still = ((await ok("apps", "GET", "apps/list")).json?.apps ?? []).some((a) => a.id === id);
      if (still) throw new Error("still installed");
      return `removed the probe app ${id}`;
    });
  }
  for (const name of drawnBy) await attempt(`clear what ${name} drew`, () => device.api("DELETE", `display/draw?application_name=${name}`).then(() => null));
  await attempt("the BUSY timer", async () => {
    const snapshot = (await ok("busy", "GET", "busy/snapshot")).json;
    if (!before.busy?.snapshot || timeless(snapshot) === timeless(before.busy.snapshot)) return null;
    await ok("busy", "PUT", "busy/snapshot", JSON.stringify({ ...before.busy.snapshot, snapshot_timestamp_ms: Date.now() }));
    return "the BUSY timer back as it was";
  });
  for (const slot of ["busy", "custom"]) {
    await attempt(`the BUSY profile ${slot}`, async () => {
      const profile = (await ok("profile", "GET", `busy/profiles/${slot}`)).json;
      if (!before.busy?.[slot] || timeless(profile) === timeless(before.busy[slot])) return null;
      await ok("profile", "PUT", `busy/profiles/${slot}`, JSON.stringify({ ...before.busy[slot], profile_timestamp_ms: Date.now() }));
      return `the BUSY profile ${slot} back as it was`;
    });
  }
  await attempt("brightness", async () => {
    const brightness = String((await ok("brightness", "GET", "display/brightness")).json?.value);
    if (before.brightness === undefined) return null;
    if (before.brightness === "auto" && before.manualLevel !== null) {
      // The level under automatic first, then automatic again.
      await ok("brightness", "POST", `display/brightness?value=${before.manualLevel}`);
      await ok("brightness", "POST", "display/brightness?value=auto");
      return `brightness back to auto, its manual level ${before.manualLevel}`;
    }
    if (brightness === before.brightness) {
      return before.brightness === "auto" && before.levelsChanged ? "NOT PUT BACK: the manual level under automatic brightness (not readable through the API); set it in SETTINGS if it matters" : null;
    }
    await ok("brightness", "POST", `display/brightness?value=${before.brightness}`);
    return `brightness back to ${before.brightness}${before.brightness === "auto" && before.levelsChanged ? "; NOT PUT BACK: its manual level (not readable through the API)" : ""}`;
  });
  await attempt("volume", async () => {
    const volume = (await ok("volume", "GET", "audio/volume")).json?.volume;
    if (before.volume === undefined || volume === before.volume) return null;
    await ok("volume", "POST", `audio/volume?volume=${before.volume}&silent=1`);
    return `volume back to ${before.volume}`;
  });
  const missing = before.apps.filter((id) => !now.includes(id));
  if (missing.length) did.push(`NOT PUT BACK: apps that were there and are gone: ${missing.join(", ")}`);
  return did;
}

/** Asks a question on the terminal; resolves with the answer. */
/**
 * Asks a question on the terminal; resolves with the answer, or with "" when there is none to come: the terminal is
 * closed (its input ends), or the session stops (a signal: run.mjs puts the BUSY Bar back after).
 */
export function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      control.waiters.delete(wake);
      resolve(answer);
      rl.close();
    };
    const wake = () => done("");
    control.waiters.add(wake);
    if (control.stopped) return wake();
    // Ctrl+C at a question stops the session as it does anywhere else.
    rl.on("SIGINT", () => {
      done("");
      process.emit("SIGINT");
    });
    // The input ended before an answer (Ctrl+D, the terminal closed): no later question could be answered either, so
    // the session stops here and run.mjs puts the BUSY Bar back, instead of taking it as Enter.
    rl.on("close", () => {
      if (settled) return;
      stopSession("the terminal's input ended");
      done("");
    });
    rl.question(question, (answer) => done(answer.trim()));
  });
}

/**
 * Runs a suite of test/ (golden.mjs, timed.mjs, ...) as its own process, its output indented under the part's line.
 * Resolves with its exit code.
 */
export function runSuite(script, args, env = {}) {
  halt();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(testDir, script), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    // A stop of the session is passed on to it (run.mjs), and the session waits for it to end.
    control.child = child;
    const indent = (stream, to) => {
      let rest = "";
      stream.on("data", (d) => {
        const lines = (rest + d.toString()).split("\n");
        rest = lines.pop();
        for (const line of lines) to.write(`      ${line}\n`);
      });
      stream.on("end", () => rest && to.write(`      ${rest}\n`));
    };
    indent(child.stdout, process.stdout);
    indent(child.stderr, process.stderr);
    child.on("close", (code) => {
      if (control.child === child) control.child = null;
      resolve(code ?? 1);
    });
  });
}

/** Where a group's observations live: bar-session/recordings/<firmware>/<group>.json under the recordings' root. */
export function observationsFile(root, firmware, group) {
  return join(root, "bar-session", "recordings", firmware, `${group}.json`);
}

/** The observations of a group, as written by the session; null when there are none. */
export function readObservations(root, firmware, group) {
  const file = observationsFile(root, firmware, group);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

export function writeObservations(root, firmware, group, recording) {
  const file = observationsFile(root, firmware, group);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, asciiJson(recording) + "\n");
  return file;
}

/**
 * Whether two lists of input events ([key, action, ms, delta?]) are the same events in the same order, each at a time
 * within `ms` of the other's: null, or what differs.
 */
export function eventsApart(want, got, ms) {
  if (!Array.isArray(got)) return `no events (${JSON.stringify(got)})`;
  const names = (list) => list.map(([key, action, , delta]) => `${key} ${action}${delta !== undefined ? ` ${delta}` : ""}`);
  if (names(want).join() !== names(got).join()) return `BUSY Bar ${names(want).join(", ")} | emulator ${names(got).join(", ")}`;
  const far = want.map((e, i) => [names(want)[i], e[2], got[i][2]]).filter(([, a, b]) => Math.abs(a - b) > ms);
  return far.length ? `times further apart than ${ms} ms: ${far.map(([n, a, b]) => `${n} ${a}/${b}`).join(", ")}` : null;
}

/**
 * Compares a replay's observations with a recording's: [name, ok, detail] for each recorded value, as it says (exact,
 * within, raw). A raw value is never a failure: its line shows both.
 */
export function compareObservations(recorded, replayed) {
  const lines = [];
  const show = (v) => {
    const text = JSON.stringify(v);
    return text === undefined ? "nothing" : text.length > 160 ? `${text.slice(0, 160)}... (${text.length})` : text;
  };
  for (const [name, one] of Object.entries(recorded.observations)) {
    const got = replayed.observations[name];
    if (one.compare === "raw") {
      lines.push([`${name} (raw, not compared)`, true, `BUSY Bar ${show(one.value)} | emulator ${show(got?.value)}`]);
      continue;
    }
    if (!got) {
      lines.push([name, false, `the replay did not get to it; the BUSY Bar ${show(one.value)}`]);
      continue;
    }
    if (one.compare?.events !== undefined) {
      const apart = eventsApart(one.value, got.value, one.compare.events);
      lines.push([name, apart === null, apart ?? `${one.value.length} events, each within ${one.compare.events} ms`]);
      continue;
    }
    if (one.compare?.within !== undefined) {
      const ok = typeof got.value === "number" && Math.abs(got.value - one.value) <= one.compare.within;
      lines.push([name, ok, `BUSY Bar ${show(one.value)}, emulator ${show(got.value)} (within ${one.compare.within})`]);
      continue;
    }
    const ok = JSON.stringify(got.value) === JSON.stringify(one.value);
    lines.push([name, ok, ok ? show(one.value) : `BUSY Bar ${show(one.value)} | emulator ${show(got.value)}`]);
  }
  return lines;
}
