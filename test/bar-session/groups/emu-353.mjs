// EMU-353: the status lights. The owner films them on his phone at 240 frames a second; the kit draws from this
// computer with led_notification_color red, green and white at brightness 0, 50, 100 and auto, and records when each
// draw was answered (ms from the first) and its answer, with what the front display said ("R 50" for red at 50), so that
// the film can be matched to the draws. The times of the flashes come from the film, by hand, into the task. The
// brightness is put back as it was (the session's restore); under automatic brightness, the manual level the owner gives.
import { Device, sleep } from "../lib.mjs";

const COLORS = { R: "#FF0000FF", G: "#00FF00FF", W: "#FFFFFFFF" };
const LEVELS = ["0", "50", "100", "auto"];
// Three blinks and the dark after them take 2.5 s in the firmware's code; a second more between draws.
const GAP_MS = 4000;
export const LIGHTS_APP = "app.probe.kit.lights";

export default {
  id: "EMU-353",
  title: "the status lights: led_notification_color",
  async run(ctx) {
    const device = ctx.device;
    await ctx.part("lights", { firmware: "1.4.1", person: true }, async () => {
      // Automatic brightness keeps a manual level for when it is turned off, which the API does not show and the levels
      // below overwrite: the owner says it, and the session puts it back (lib.mjs, restore).
      if (ctx.snapshot?.brightness === "auto" && ctx.mode === "bar") {
        const level = await ctx.askPerson("\n  >>> The brightness is automatic. Its manual level in SETTINGS (0 to 100), to put back after; Enter if it does not matter: ");
        if (/^\d{1,3}$/.test(level) && Number(level) <= 100) ctx.snapshot.manualLevel = level;
      }
      if (ctx.snapshot) ctx.snapshot.levelsChanged = true;
      await ctx.person("Start filming the status lights at 240 frames a second, the front display in the picture too.", async () => {}, { enter: "Enter once the film runs" });
      const draws = [];
      const t0 = Date.now();
      try {
        for (const level of LEVELS) {
          const set = await device.api("POST", `display/brightness?value=${level}`);
          draws.push({ brightness: level, set: Device.short(set) });
          await sleep(500);
          for (const [name, color] of Object.entries(COLORS)) {
            const label = `${name} ${level}`;
            const sent = Date.now() - t0;
            const r = await device.api("POST", "display/draw", JSON.stringify({ application_name: LIGHTS_APP, priority: 100, led_notification_color: color, elements: [{ id: "t", type: "text", text: label, font: "normal", x: 0, y: 2 }] }));
            draws.push({ label, color, sentMs: sent, answeredMs: Date.now() - t0, answer: Device.short(r) });
            await sleep(GAP_MS);
          }
        }
      } finally {
        await device.api("DELETE", `display/draw?application_name=${LIGHTS_APP}`);
      }
      ctx.observe("lights: the draws' answers", draws.filter((d) => d.answer).map((d) => [d.label, d.answer]));
      ctx.observe("lights: the draws and when they were answered", draws, "raw");
      await ctx.person("Stop the film. The times of the flashes go into EMU-353 from it.", async () => {});
    });
  },
};
