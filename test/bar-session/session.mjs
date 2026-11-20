// One group of the BUSY Bar session at work: its parts run or skipped, its observations, its suites, the person at the BUSY
// Bar. The same group runs in three modes:
//   bar     on a BUSY Bar: a part that needs the owner's consent runs only with it, a person's step waits for him,
//           the suites write their recordings where the gate reads them;
//   trial   on an emulator that plays the BUSY Bar (run.mjs --emulator): everything is allowed, the person is played
//           by the kit (the emulator's buttons), the suites and the observations go to a folder of their own;
//   replay  bar-session.test.mjs: on an emulator of its own, only the parts a recording has and none that run a suite
//           (each suite reads its own recording), the person played from what the recording says he did.
import { asciiJson, control, KIT_PREFIX, runSuite, sleep, STANDARD_BAR_SHA256, sha256, Stop } from "./lib.mjs";

/** A part that cannot go on here: said once in the summary, not a failure. */
export class Skip extends Error {}

export class GroupRun {
  /**
   * @param {object} o
   * @param {object} o.group the group's module: { id, title, run(ctx) }
   * @param {import("./lib.mjs").Device} o.device
   * @param {"bar"|"trial"|"replay"} o.mode
   * @param {Set<string>} o.consent what the owner agreed to (--consent): heap, reboot
   * @param {boolean} o.person whether someone is at the BUSY Bar (bar mode)
   * @param {object} o.identity the device's identity (Device.identity)
   * @param {object} [o.recorded] the recording a replay follows
   * @param {object} [o.suiteEnv] the environment of the suites (EMU_RECORDINGS, EMU_FETCH_PORT)
   * @param {(line: string) => void} [o.say]
   * @param {(question: string) => Promise<string>} [o.askPerson] asks the person at the BUSY Bar (bar mode)
   * @param {string[]} [o.onlyParts] the parts asked for (--only EMU-350/failures); all when null
   * @param {object} [o.snapshot] what the session puts back at its end (lib.mjs, snapshotOf); a part that changes more
   *   says so there
   */
  constructor({ group, device, mode, consent = new Set(), person = false, identity, recorded = null, suiteEnv = {}, say = console.log, askPerson = null, onlyParts = null, snapshot = null }) {
    Object.assign(this, { group, device, mode, consent, personHere: person, identity, recorded, suiteEnv, say, askPerson, onlyParts, snapshot });
    this.firmware = identity.firmware.version;
    this.observations = {};
    this.parts = [];
    this.skipped = [];
    this.failed = [];
    this.suites = [];
    this.app = (name) => `${KIT_PREFIX}${name}`;
    this.marker = (what) => `kit-mark ${what} ${Date.now().toString(36)}`;
  }

  get standard() {
    return this.mode !== "bar" || sha256(this.identity.serial) === STANDARD_BAR_SHA256;
  }

  /** Records a value the probes saw. compare: "exact" (default), "raw", { within: n }, { events: ms }. */
  observe(name, value, compare = "exact") {
    this.observations[name] = { value: value === undefined ? null : value, compare };
  }

  /**
   * Runs a part if what it needs is there: { consent: ["heap", ...], person: true, standard: true, firmware: "1.4.1",
   * suite: true }. A part that cannot run is skipped with the reason; one that fails is told and the group goes on.
   */
  async part(name, needs, fn) {
    if (control.stopped) throw new Stop(control.stopped);
    const why = this.whyNot(name, needs);
    if (why) {
      this.skipped.push({ part: name, why });
      if (!why.startsWith("not asked for")) this.say(`    skip ${name}: ${why}`);
      return;
    }
    const t0 = Date.now();
    this.say(`    ${name} ...`);
    try {
      await fn();
      this.parts.push(name);
      this.say(`    ${name}: done in ${Math.round((Date.now() - t0) / 1000)} s`);
    } catch (e) {
      // The session stops: nothing more of this group.
      if (e instanceof Stop) {
        // What a stopped part saw is not whole: not written, so that it does not replace a whole one recorded before.
        for (const key of Object.keys(this.observations)) if (key.startsWith(`${name}: `)) delete this.observations[key];
        this.failed.push({ part: name, error: `stopped: ${e.message}` });
        throw e;
      }
      if (e instanceof Skip) {
        this.skipped.push({ part: name, why: e.message });
        this.say(`    skip ${name}: ${e.message}`);
        return;
      }
      this.failed.push({ part: name, error: e.message });
      this.say(`    FAIL ${name}: ${e.stack ?? e.message}`);
    }
  }

  whyNot(name, { consent = [], person = false, standard = false, firmware = null, suite = false } = {}) {
    if (this.onlyParts && !this.onlyParts.includes(name)) return "not asked for (--only)";
    if (this.mode === "replay") {
      if (suite) return "its suite compares its own recording";
      if (!this.recorded?.parts.includes(name)) return "not in the recording";
      // A part whose values are all raw has nothing to compare: not run again (it may restart the BUSY Bar, or need
      // the internet).
      const mine = Object.entries(this.recorded.observations).filter(([key]) => key.startsWith(`${name}: `));
      if (mine.every(([, one]) => one.compare === "raw")) return "its values are all raw: nothing to compare";
      return null;
    }
    if (firmware && this.firmware !== firmware) return `needs a BUSY Bar on ${firmware}, this one runs ${this.firmware}`;
    if (standard && !this.standard) return "speed and pace are measured on the standard BUSY Bar only";
    if (this.mode === "bar") {
      const missing = consent.filter((c) => !this.consent.has(c));
      if (missing.length) return `needs the owner's consent: --consent ${missing.join(",")}`;
      if (person && !this.personHere) return "needs a person at the BUSY Bar (run it from a terminal, without --no-person)";
    }
    return null;
  }

  /**
   * A step of the person at the BUSY Bar. On a BUSY Bar: `instruction` is printed and the kit waits for Enter (s and
   * Enter skips the part); `enter` says what the Enter means (when done, by default, or the moment to start). In an emulator the kit plays it: `play()`. Resolves with what the person typed.
   */
  async person(instruction, play, { enter = "Enter when done" } = {}) {
    if (this.mode !== "bar") {
      await play();
      return "";
    }
    const answer = await this.askPerson(`\n  >>> ${instruction}\n      ${enter} (s and Enter: skip this part): `);
    if (answer.toLowerCase() === "s") throw new Skip("the owner skipped it");
    return answer;
  }

  /**
   * OK to a probe app that may fill its heap or end with a fatal error, and what came of it. The BUSY Bar must have
   * been up RISKY_UPTIME_S first (in its first 30 s the supervisor locks it under a warning instead of restarting it).
   * Then the app's `key` in its localStorage is read until `done(value)`, or the BUSY Bar restarts, or `ms` pass. No
   * result and no restart: the app ended or hangs, and the BUSY Bar may show the supervisor's warning, which takes no
   * input; the kit then restarts it (every such part needs the consent `reboot`). Resolves with { value, outcome,
   * frames }: `outcome` says which of the three it was, in words, for the observation.
   */
  async risky(id, key, done, ms = 30000) {
    const device = this.device;
    await device.pastFirstSeconds(this.say);
    const since = await device.bootTime();
    await device.api("POST", "input?key=ok");
    const t0 = Date.now();
    let value = null;
    while (Date.now() - t0 < ms) {
      const now = await device.bootTime();
      if (now !== since) {
        const took = Date.now() - t0;
        await device.waitUp(180000);
        return { value: "the BUSY Bar restarted", outcome: `the BUSY Bar restarted ${took} ms after OK`, frames: null };
      }
      const data = await device.localStorage(id).catch((e) => {
        if (e instanceof Stop) throw e;
        return null;
      });
      value = data?.[key] ? JSON.parse(data[key]) : null;
      if (value && done(value)) return { value, outcome: "done", frames: null };
      await sleep(700);
    }
    const frames = await device.frames().catch(() => null);
    this.say("      no result and no restart: the kit restarts the BUSY Bar (it may show the supervisor's warning)");
    await device.reboot();
    return { value, outcome: `no result and no restart in ${Math.round(ms / 1000)} s (the app ended or hangs; the displays are kept); the kit restarted the BUSY Bar`, frames };
  }

  /** Runs a suite's own recording (its --record). Not in a replay: the suite reads its recording itself. */
  async suite(script, args, what) {
    const code = await runSuite(script, args, this.suiteEnv);
    this.suites.push({ script, args: args.join(" "), code, what });
    // Ended by the session's stop: its recording is not whole.
    if (control.stopped) throw new Stop(control.stopped);
    if (code !== 0) throw new Error(`${script} ${args.join(" ")} ended with ${code}`);
  }

  /** The address of the device for a suite's --bar. */
  get addr() {
    return this.device.addr;
  }

  /** The recording of this run: what bar-session.test.mjs replays. */
  recording() {
    return {
      source: { bar: `BUSY Bar, firmware ${this.firmware}`, firmware: this.identity.firmware.commit_hash, recorded: new Date().toISOString(), mode: this.mode },
      group: this.group.id,
      title: this.group.title,
      parts: this.parts.filter((p) => Object.keys(this.observations).some((name) => name.startsWith(`${p}: `))),
      observations: this.observations,
    };
  }

  /** Whether anything was observed (and so a recording is written). */
  get observed() {
    return Object.keys(this.observations).length > 0;
  }

  toJSON() {
    return JSON.parse(asciiJson(this.recording()));
  }
}
