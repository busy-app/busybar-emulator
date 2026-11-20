// EMU-355: an app's sound played, replaced and stopped (apps.mjs, soundApp): the seven steps of the task, by an app with
// a.snd of 2 s and b.snd of 0.5 s (16-bit mono PCM at 44100 Hz, a soft tone). Each step's answer is exact; its time
// and the log are raw. The BUSY Bar's volume is not touched.
import { soundApp, tone } from "../apps.mjs";

export default {
  id: "EMU-355",
  title: "an app's sound: played, replaced, stopped",
  async run(ctx) {
    const device = ctx.device;
    await ctx.part("sound", { firmware: "1.4.1" }, async () => {
      const id = ctx.app("sound");
      const marker = ctx.marker("sound");
      try {
        await device.install(id, { "scripts/main.js": soundApp(id, marker), "sounds/a.snd": tone(2000), "sounds/b.snd": tone(500, 660) });
        await device.launch(id);
        const done = await device.waitFor(id, "done", 60000);
        const steps = JSON.parse((await device.localStorage(id))?.steps ?? "[]");
        if (!done) ctx.say("      the app did not finish its steps in 60 s; what it did is kept");
        for (const [name, value] of steps) {
          ctx.observe(`sound: ${name}`, value.error ?? `${value.status} ${(() => { try { const j = JSON.parse(value.text); return j.error ?? j.result; } catch { return value.text.trim(); } })()}`.trim());
        }
        ctx.observe("sound: each step's time from fetch() to the answer, ms", steps.map(([name, v]) => [name, v.ms]), "raw");
        ctx.observe("sound: log", await device.logAfter(marker), "raw");
      } finally {
        await device.remove(id);
      }
    });
  },
};
