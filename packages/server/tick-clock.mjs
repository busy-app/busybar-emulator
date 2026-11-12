// The clock of the screen module and everything that happens by it: the GUI's tick every 8 ms and the module's own
// timers. The firmware's graphics, animations and menus live on ticks, so the module must get as many of them as a
// bar does: 125 for every second of the clock, each seeing the time it was due at.
//
// The host cannot give a tick every 8 ms. Node's timers are late by a millisecond on macOS and fire only every 15.6 ms
// on Windows (its system timer), so a setInterval(8) gave 113 ticks a second on one and 64 on the other (EMU-225).
// A timer that polls the clock is exact but takes a whole core. So the ticks are counted by the clock instead: every
// time the host wakes — on its timer, or because something is about to look at the module or call into it (sync) —
// everything that has come due since is carried out, in the order and at the times it was due:
//
//   - The module's clock during a tick or a timer is the time that tick or timer was due at, not the time the host
//     got round to it. LVGL decides what to run by that clock, so two ticks made up in one go do what two ticks 8 ms
//     apart do on a bar, and an animation keeps its pace whatever the host's timer does. (Two ticks that both read
//     the computer's clock would be one tick to LVGL: nothing is due on the second.)
//   - Outside ticks and timers the clock is the computer's (computer-clock.mjs: one that never goes back, so a
//     clock set back does not stop the ticks; set forward, it moves on with the computer's, as after a stall below).
//   - Whoever calls into the module or reads its frames calls sync() first, so ticks due before a request, a key or
//     a look at the display have been carried out by then: a request never overtakes a tick, and a frame is the one a
//     bar would show at that moment.
//   - What the host's timer does delay is what the module starts by itself on a tick or a timer: the reply to a draw
//     that waited in canvas, a sound of the firmware's, the launcher starting or stopping an app. Those come up to
//     one step of the host's timer late in real time — a millisecond or two on macOS, up to 16 ms on Windows, where
//     the ticks come in twos — though in the right order and at the right time by the module's clock.
//   - At most MAX_CATCH_UP_MS are made up. After a longer stall (the process was stopped in a debugger; the computer
//     slept; its clock was set forward: computer-clock.mjs) the clock jumps as the computer's did, and
//     the ticks older than that are skipped: a bar that was not there for a minute does not play that minute at
//     once. A periodic timer skips the periods older than that as well; a one-shot timer still fires, once.
//
// For tests the clock can be held and stepped (hold, advance, release): then nothing moves by itself, and
// advance(ms) carries out the ticks and timers that fall into those ms by the same rule, with no limit. Every frame
// of an animation can be read that way.

import { computerNow } from "./computer-clock.mjs";

/** GUI_TICK_PERIOD_MS in gui_i.h: how often the GUI service runs LVGL's timers. */
export const TICK_MS = 8;

/**
 * How much of a stall is made up, ms. Twice the worst stall of the server's event loop measured on a loaded computer
 * (245 ms, EMU-200), so an ordinary hiccup loses no tick; and no more than 63 ticks in one go, a few ms of work (37 ms
 * on a heavily loaded computer), so the server never spends long catching up.
 */
export const MAX_CATCH_UP_MS = 500;

export class TickClock {
  /**
   * @param {object} o
   * @param {() => void} o.onTick the GUI's tick
   * @param {(timer: any) => void} o.onTimer a timer started with startTimer() is due
   * @param {() => number} [o.computer] the computer's clock, whole Unix ms; it must not go back
   * @param {(fn: () => void, ms: number) => any} [o.setTimer] the host's timer that wakes the clock, and
   * @param {(handle: any) => void} [o.clearTimer] what stops it
   */
  constructor({ onTick, onTimer, computer = () => Math.floor(computerNow()), setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { onTick, onTimer, computer, setTimer, clearTimer });
    this.timers = new Map(); // timer → { ms, periodic, due }, in the order they were started
    this.held = false; // the clock is stepped by advance() instead of running
    this.skew = 0; // ms the clock is ahead of the computer's, after a hold
    this.time = this.computer(); // the latest time the module has seen
    this.nextTick = this.time + TICK_MS;
    this.running = false; // a tick or a timer is being carried out
    this.wake = null; // the host timer for what is due next
    this.stopped = true;
    this.ticks = 0; // ticks carried out
    this.skipped = 0; // ticks left out after stalls
  }

  /** The clock starts running: the first tick is due a period from now. */
  start() {
    this.stopped = false;
    this.time = this.real();
    this.nextTick = this.time + TICK_MS;
    this.arm();
  }

  /** Nothing ticks or fires any more. */
  stop() {
    this.stopped = true;
    this.disarm();
    this.timers.clear();
  }

  /**
   * Unix ms as the module sees it. Outside ticks and timers that is the computer's clock, and what the module has
   * been shown it is not shown less of afterwards: a tick that is carried out later than a reading sees the reading's
   * time, not its own earlier due time. (That takes a call into the module that lasts past a tick's due time, or a
   * reading without a sync() before it.)
   */
  now() {
    if (this.held || this.running) return this.time;
    return (this.time = this.real());
  }

  /**
   * The computer's clock as the module's: with the skew of a hold. The clock never goes back; should the one it is
   * given do so, the module's time stands until that has caught up, and nothing is left over afterwards.
   */
  real() {
    return Math.max(this.computer() + this.skew, this.time);
  }

  /**
   * A timer of the module's: due in `ms`, and if periodic, every `ms` from then on. A timer that a tick or a timer
   * starts with no delay is due a millisecond later while the clock runs (as the host's timer made it before), so
   * one that restarts itself again and again takes its turns with the ticks instead of holding the server. A held
   * clock keeps it at the same millisecond, as advance() always did.
   */
  startTimer(timer, ms, periodic) {
    const delay = this.running && !this.held ? Math.max(ms, 1) : ms;
    // Of timers due at the same ms the one started first goes first, and a timer started again is started last.
    this.timers.delete(timer);
    // A periodic timer has a period of 1 ms at the least: with none it would be due again at once, for ever.
    this.timers.set(timer, { ms: Math.max(ms, periodic ? 1 : 0), periodic, due: this.now() + delay });
    // It may be due before what the host timer waits for. (A timer started from a tick is armed after the tick.)
    if (!this.running) this.arm();
  }

  stopTimer(timer) {
    this.timers.delete(timer);
  }

  /**
   * Carries out what has come due by now. Called before anything looks at the module or calls into it, and by the
   * host timer. Does nothing while the clock is held, and from inside a tick or a timer.
   */
  sync() {
    if (this.held || this.running || this.stopped) return;
    const now = this.real();
    this.run(now, now - MAX_CATCH_UP_MS);
  }

  /**
   * The ticks and timers due up to `end`, earliest first; a tick goes before a timer due at the same ms. Nothing
   * older than `floor` is made up: ticks before it are skipped, and what is carried out sees the clock at `floor` at
   * the earliest.
   */
  run(end, floor) {
    if (this.nextTick < floor) {
      const skipped = Math.ceil((floor - this.nextTick) / TICK_MS);
      this.nextTick += skipped * TICK_MS;
      this.skipped += skipped;
    }
    this.running = true;
    try {
      for (;;) {
        let due = this.nextTick;
        let timer = null;
        for (const [id, t] of this.timers) {
          if (t.due < due) {
            due = t.due;
            timer = id;
          }
        }
        // The module may stop the clock from a tick or a timer (the bar powers off).
        if (due > end || this.stopped) break;
        this.time = Math.max(this.time, due, floor);
        if (timer === null) {
          this.nextTick += TICK_MS;
          this.ticks++;
          this.onTick();
        } else {
          const t = this.timers.get(timer);
          if (!t.periodic) this.timers.delete(timer);
          else {
            t.due += t.ms;
            // This firing stands for the periods left out: the next one is the first after `floor`.
            if (t.due <= floor) t.due += (Math.floor((floor - t.due) / t.ms) + 1) * t.ms;
          }
          this.onTimer(timer);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Sets the host timer for the next tick or timer due. */
  arm() {
    this.disarm();
    if (this.held || this.stopped) return;
    let due = this.nextTick;
    for (const t of this.timers.values()) due = Math.min(due, t.due);
    this.wake = this.setTimer(() => {
      this.wake = null;
      try {
        this.sync();
      } finally {
        this.arm();
      }
    }, Math.max(0, due - this.real()));
    // The clock alone does not keep the process alive.
    this.wake?.unref?.();
  }

  disarm() {
    if (this.wake !== null) this.clearTimer(this.wake);
    this.wake = null;
  }

  /**
   * Stops the clock where it is; the next tick is a period from there.
   *
   * With `onTick` the clock stops on a tick instead. It goes on, as advance() would, to the first tick due `lead` ms
   * or more after the latest time the module has seen, calls `onTick()` at that tick's time just before carrying it
   * out, carries it out and stops there. Each periodic timer then counts its period from that tick: the next run of
   * one that fired every 5 s comes 5 s after the stop, not wherever its periods happened to fall. A held clock so
   * always starts at the same point of a tick, a whole number of periods after the ticks before, and its periodic
   * timers at the same points after it; one-shot timers keep their times.
   *
   * With `busy`, the stop moves on a tick at a time while busy() says the module is in the middle of something of its
   * own (an animation of the firmware's that started before the hold), for at most `maxWait` ms.
   */
  hold({ lead = 0, onTick, busy, maxWait = 0 } = {}) {
    if (this.held) return;
    this.sync();
    this.time = this.real();
    this.held = true;
    this.disarm();
    if (!onTick || this.stopped) {
      this.nextTick = this.time + TICK_MS;
      return;
    }
    let at = this.nextTick;
    while (at < this.time + lead) at += TICK_MS;
    for (const limit = this.time + maxWait; busy && at <= limit && busy(); at += TICK_MS) this.run(at, -Infinity);
    this.run(at - 1, -Infinity);
    this.time = at;
    // A periodic timer's next run is a period from the stop, wherever its periods fell before.
    for (const t of this.timers.values()) if (t.periodic) t.due = at + t.ms;
    onTick();
    this.run(at, -Infinity);
  }

  /** With the clock held: moves it `ms` on, doing everything that was due in between. */
  advance(ms) {
    if (!this.held) throw new Error("the clock is not held");
    const end = this.time + ms;
    this.run(end, -Infinity);
    this.time = end;
  }

  /** Lets the clock run again, from the time it was held at. */
  release() {
    if (!this.held) return;
    this.skew = this.time - this.computer();
    this.held = false;
    this.arm();
  }
}
