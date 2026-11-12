// The computer's clock as the emulated bar reads it. Two readings:
//
//   computerNow()       the clock the bar's ticks and timers are counted by (tick-clock.mjs) and an app's timers wait
//                       by (runtime.mjs): Unix ms that never go back;
//   computerTimeOfDay() the computer's time of day as the bar's own clock follows it: computerNow() plus
//                       timeOfDayOffset(), which is 0 unless the computer's clock was set back. The bar's real-time
//                       clock in the screen module (screen.mjs gives it the offset), an app's Date.now(), the bar's API
//                       and its state stream all go by this one, with the bar's own setting (POST /api/time/timestamp)
//                       on top (device.mjs, barTime), so they never part.
//
// computerNow() is the time of day the process started at, carried on by a clock that never steps
// (performance.now()). Date.now() alone will not do: when the system corrects or somebody sets the computer's clock
// it steps, back as well as forward, and a step back would stop the firmware's tick counter until the clock caught up
// (the counter never goes back). The monotonic clock alone will not do either: it drifts from the time of day (about
// a millisecond a minute while the system disciplines its clock), misses a clock that was set, and on some systems
// stands still while the computer sleeps. So every reading compares the two (EMU-235), and when they are more than
// MAX_APART_MS apart:
//
//   - the time of day is ahead (the computer slept where the monotonic clock stops; its clock was set forward; the
//     drift added up): computerNow() moves forward by the gap. For the ticks that is a long stall: the ticks of the
//     gap are skipped, not played (tick-clock.mjs), and the bar's clock is right again;
//   - the time of day is behind (the clock was set back): computerNow() does not go back, ever; the bar's clock does,
//     through timeOfDayOffset(). When the computer's clock is put right again the offset goes back to 0, and the
//     ticks have lost nothing.
//
// Within MAX_APART_MS nothing moves: the bar's clock is at most that far from the computer's.
//
// One reference for the whole process, not one per server (EMU-004 runs several in one): the two clocks it compares
// are the computer's, and every server must see a sleep or a set clock the same way and at the same moment. What is a
// server's own — its clock's hold and skew, its ticks — lives in its TickClock.
//
// A computer that sleeps. Either its monotonic clock runs on through the sleep, and the sleep is a long stall; or it
// stands still, and the time of day is ahead at the first reading after the wake, which moves computerNow() on.
// Either way the bar's clock is right within MAX_APART_MS after a sleep, without a restart.
//   - macOS: it runs on. Checked on Darwin 24.6 (Apple Silicon) with Node 22.20: process.hrtime, which
//     performance.now() is counted from, equals mach_continuous_time and is ahead of mach_absolute_time by the time
//     that computer had slept.
//   - Windows: libuv reads QueryPerformanceCounter, and nothing we have says whether that counts sleep. A real sleep
//     with a running emulator has not been tried there; the rule above covers both answers.
//   - Linux: it stands still (CLOCK_MONOTONIC, by clock_gettime(2)); not tried.

/** How far apart the computer's time of day and the bar's clock may be before the bar's clock is put right, ms. */
export const MAX_APART_MS = 1000;

export class ComputerClock {
  /**
   * @param {object} [o]
   * @param {() => number} [o.monotonic] Unix ms, with fractions, by a clock that never steps
   * @param {() => number} [o.timeOfDay] the computer's time of day, Unix ms (Date.now)
   */
  constructor({ monotonic = () => performance.timeOrigin + performance.now(), timeOfDay = Date.now } = {}) {
    Object.assign(this, { monotonic, timeOfDay });
    this.ahead = 0; // ms now() has been moved forward
    this.offset = 0; // timeOfDayOffset(): 0 or less, whole ms
    this.steps = 0; // how many times either was changed
  }

  /** The clock the ticks go by: never back. */
  now() {
    this.check();
    return this.monotonic() + this.ahead;
  }

  /** ms from now() to the computer's time of day as the bar's clock follows it: 0, or less after it was set back. */
  timeOfDayOffset() {
    this.check();
    return this.offset;
  }

  /** Compares the two clocks and moves the reference if they are too far apart. */
  check() {
    const apart = this.timeOfDay() - (this.monotonic() + this.ahead);
    if (apart > MAX_APART_MS) {
      this.ahead += apart;
      this.offset = 0;
      this.steps++;
    } else if (Math.abs(apart - this.offset) > MAX_APART_MS) {
      // Behind, or back from behind (the clock was put right): the ticks stay where they are, the bar's clock follows.
      this.offset = Math.min(0, Math.round(apart));
      this.steps++;
    }
  }
}

/** The process's clock: every server in the process reads this one. */
export const computerClock = new ComputerClock();

/** Unix ms, with fractions, that never go back: the ticks and timers go by them. */
export const computerNow = () => computerClock.now();

/** ms from computerNow() to the time of day the bar's clock follows: 0, or less after the computer's was set back. */
export const timeOfDayOffset = () => computerClock.timeOfDayOffset();

/** The computer's time of day as the bar's clock follows it, Unix ms. */
export const computerTimeOfDay = () => computerNow() + timeOfDayOffset();
