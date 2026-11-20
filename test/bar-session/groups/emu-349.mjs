// EMU-349: buttons held. The API only gives a short press, so a person does it at the BUSY Bar, step by step, while an
// app records every input event with its Date.now() (the last 300). Each step's events are recorded as
// [key, action, ms from the step's first event]; the replay (bar-session.test.mjs) holds the emulator's buttons down
// and lets them go at the moments the events say, and compares the events and their times within EVENT_MS.
//   short       OK, Start and Back, short;
//   held        OK and Start, held about 2 s each;
//   wheel       one click each way, then 10 fast clicks;
//   back-exit   Back held until the app is gone: the time from its press to the exit, by the log (raw);
//   back-start  (consent reboot) Back and Start held together until the BUSY Bar restarts: the time (raw).
// In an emulator the kit plays the person: the emulator's buttons (/_emu/key) and the wheel through the API.
import { inputApp } from "../apps.mjs";
import { sleep } from "../lib.mjs";

// How far an event's time may be from the BUSY Bar's: the GUI's tick is 8 ms, but the replay holds the emulator's
// buttons by this computer's timers, between requests: a few ticks.
export const EVENT_MS = 40;

const STEPS = [
  {
    name: "short",
    say: "Press OK, then Start, then Back, each one short, about 2 s apart.",
    play: [["ok", 80], ["start", 80], ["back", 80]],
  },
  {
    name: "held",
    say: "Hold OK for about 2 s and let go; wait 2 s; hold Start for about 2 s and let go.",
    play: [["ok", 2000], ["start", 2000]],
  },
  {
    name: "wheel",
    say: "Turn the wheel one click one way, wait 2 s, one click the other way, wait 2 s, then 10 quick clicks either way.",
    wheel: ["up", "down", ...Array(10).fill("up")],
  },
];

/** The events of a step: [key, action, ms from its first event] (and the wheel's delta). */
const stepEvents = (events) => {
  const t0 = events[0]?.t ?? 0;
  return events.map((e) => [e.key, e.action, e.t - t0, ...(e.delta !== undefined ? [e.delta] : [])]);
};

/** How the replay plays a recorded step: each button's press and release at the recorded moments. */
function playRecorded(recorded) {
  const actions = [];
  for (const [key, action, ms] of recorded) {
    if (key === "encoder") {
      if (action === "clockwise" || action === "counterclockwise") actions.push({ ms, wheel: action === "clockwise" ? "up" : "down" });
      continue;
    }
    if (action === "press") actions.push({ ms, key, action: "down" });
    if (action === "release") actions.push({ ms, key, action: "up" });
  }
  return actions;
}

async function play(device, actions) {
  const t0 = performance.now();
  for (const one of actions.sort((a, b) => a.ms - b.ms)) {
    const wait = one.ms - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
    if (one.wheel) await device.api("POST", `input?key=${one.wheel}`);
    else await device.key(one.key, one.action);
  }
}

export default {
  id: "EMU-349",
  title: "buttons held: long, repeat, long Back, Back and Start",
  async run(ctx) {
    const device = ctx.device;
    const id = ctx.app("input");
    const marker = ctx.marker("input");
    let installed = false;
    const ready = async () => {
      if (installed) return;
      await device.install(id, { "scripts/main.js": inputApp(id, marker) });
      await device.launch(id);
      await sleep(1500);
      installed = true;
    };
    const events = async () => JSON.parse((await device.localStorage(id))?.events ?? "[]");
    try {
      for (const step of STEPS) {
        await ctx.part(step.name, { firmware: "1.4.1", person: true }, async () => {
          await ready();
          await sleep(400);
          const before = (await events()).length;
          const recorded = ctx.recorded?.observations[`${step.name}: events`]?.value;
          await ctx.person(step.say, async () => {
            if (recorded) return play(device, playRecorded(recorded));
            const actions = [];
            let at = 0;
            for (const [key, hold] of step.play ?? []) {
              actions.push({ ms: at, key, action: "down" }, { ms: at + hold, key, action: "up" });
              at += hold + 1500;
            }
            for (const [i, wheel] of (step.wheel ?? []).entries()) actions.push({ ms: i < 2 ? i * 2000 : 4000 + (i - 2) * 120, wheel });
            await play(device, actions);
          });
          await sleep(800);
          const all = await events();
          ctx.observe(`${step.name}: events`, stepEvents(all.slice(Math.min(before, all.length))), { events: EVENT_MS });
        });
      }

      await ctx.part("back-exit", { firmware: "1.4.1", person: true }, async () => {
        await ready();
        const recorded = ctx.recorded?.observations["back-exit: events"]?.value;
        const t0 = Date.now();
        await ctx.person("Hold Back until the app is gone (the APPS menu shows), then let go.", async () => {
          if (recorded) return play(device, playRecorded(recorded));
          await play(device, [{ ms: 0, key: "back", action: "down" }, { ms: 2500, key: "back", action: "up" }]);
        });
        await sleep(800);
        const all = (await events()).filter((e) => e.t >= t0 - 500);
        ctx.observe("back-exit: events", stepEvents(all), "raw");
        ctx.observe("back-exit: log", await device.logAfter("kit-input back press"), "raw");
        installed = false;
      });

      await ctx.part("back-start", { firmware: "1.4.1", person: true, consent: ["reboot"] }, async () => {
        await ready();
        await ctx.person(
          "Hold Back and Start together until the BUSY Bar restarts, then let go.",
          () => play(device, [{ ms: 0, key: "back", action: "down" }, { ms: 0, key: "start", action: "down" }, { ms: 6000, key: "back", action: "up" }, { ms: 6000, key: "start", action: "up" }]),
          { enter: "Press Enter, and at once hold them" },
        );
        // From the Enter: a person holds them now. (The kit's own play is over by now, the emulator restarted in it.)
        if (ctx.mode === "bar") ctx.observe("back-start: from Enter until the BUSY Bar restarts, ms", await device.waitDown(30000), "raw");
        await device.waitUp(180000);
        await device.api("POST", "apps/quit").catch(() => {});
        installed = false;
      });
    } finally {
      await device.remove(id);
    }
  },
};
