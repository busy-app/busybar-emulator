// EMU-352: timers, localStorage and the console, by one app (apps.mjs, timersApp), the results in its localStorage
// and the BUSY Bar's log.
//   timers      setInterval of 100 ms for 10 s (each run's time: raw; how many: exact); a zero timeout, a promise and an
//               answer of the BUSY Bar's own API, in order (exact); clearTimeout of a timer that fired, the log (raw);
//               localStorage of 1 and 16 KiB and a key that is not there (exact); the console at each level (the log:
//               raw); the standard BUSY Bar (the interval's times are pace);
//   persist     what localStorage keeps: after the app quits and starts again, and after it is removed and installed
//               again (exact);
//   storage-64k (consent heap, reboot) a value of 64 KiB, which may fill the app's heap;
//   clear-then-timeout a timeout set in the callback of an interval that has just cleared itself, nothing else
//               pending: in the emulator it never runs and the app ends (18.11); does it run on a BUSY Bar (raw)?
//   clear-then-fetch (consent reboot) a request in the callback of an interval that has just cleared itself: in the
//               emulator a fatal assertion of the runtime ends the app (18.11), which on a BUSY Bar may restart it.
import { clearThenFetchApp, timersApp } from "../apps.mjs";
import { sleep } from "../lib.mjs";

export default {
  id: "EMU-352",
  title: "timers, localStorage and the console",
  async run(ctx) {
    const device = ctx.device;
    const id = ctx.app("timers");
    const once = async (big = false) => {
      const marker = ctx.marker("timers");
      await device.install(id, { "scripts/main.js": timersApp(id, marker, big) });
      await device.launch(id);
      if (big) {
        await sleep(1500);
        const got = await ctx.risky(id, "timers", () => true, 40000);
        return { out: got.outcome === "done" ? got.value : { outcome: got.outcome, saved: got.value, displays: got.frames }, log: await device.logAfter(marker).catch(() => []) };
      }
      const out = await device.waitFor(id, "timers", 40000);
      return { out, log: await device.logAfter(marker).catch(() => []) };
    };

    await ctx.part("timers", { firmware: "1.4.1", standard: true }, async () => {
      try {
        const { out, log } = await once();
        if (!out) throw new Error("no result in 40 s");
        ctx.observe("timers: setInterval 100 ms, how many ran", out.interval?.length);
        ctx.observe("timers: setInterval 100 ms, each run's time", out.interval, "raw");
        ctx.observe("timers: setTimeout 0, a promise and an answer, in order", out.order);
        ctx.observe("timers: localStorage of 1 and 16 KiB", out.storage);
        ctx.observe("timers: localStorage, a key that is not there", out.missing);
        ctx.observe("timers: the console's levels", Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith("console."))));
        ctx.observe("timers: log", log, "raw");
      } finally {
        await device.remove(id);
      }
    });

    await ctx.part("persist", { firmware: "1.4.1" }, async () => {
      try {
        const first = await once();
        ctx.observe("persist: the first run finds", first.out?.persisted ?? null);
        // Quit and start again: the same install.
        await device.api("POST", "apps/quit");
        await sleep(1000);
        await device.launch(id);
        const again = await device.waitFor(id, "timers", 40000, (v) => v.runs === 2);
        ctx.observe("persist: after it quits and starts again", again?.persisted ?? null);
        // Removed (as the BUSY Bar removes an app: its own files are its business) and installed again.
        await device.api("POST", "apps/quit");
        await sleep(1000);
        await device.api("DELETE", `apps?app_id=${id}`);
        await sleep(1000);
        const marker = ctx.marker("persist");
        const archive = { "scripts/main.js": timersApp(id, marker) };
        await device.install(id, archive, { keepStorage: true });
        await device.launch(id);
        // Its first run again (1) if the BUSY Bar dropped the localStorage with the app, its third (3) if it kept it.
        const reinstalled = await device.waitFor(id, "timers", 40000, (v) => v.runs !== 2);
        ctx.observe("persist: after it is removed and installed again", reinstalled?.persisted ?? null);
        ctx.observe("persist: the run the app counts after it is installed again", reinstalled?.runs ?? null);
      } finally {
        await device.remove(id);
      }
    });

    await ctx.part("clear-then-timeout", { firmware: "1.4.1" }, async () => {
      const app = ctx.app("cleartimeout");
      const marker = ctx.marker("clear-then-timeout");
      const script = `console.log(${JSON.stringify(marker)});\nlet n = 0;\nconst timer = setInterval(function () {\n  if (++n < 3) return;\n  clearInterval(timer);\n  setTimeout(function () { localStorage.setItem("ran", "yes"); console.log("kit-timers the timeout ran"); }, 0);\n}, 100);\n`;
      try {
        await device.install(app, { "scripts/main.js": script });
        await device.launch(app);
        await sleep(3000);
        ctx.observe("clear-then-timeout: the timeout ran", (await device.localStorage(app))?.ran === "yes", "raw");
        ctx.observe("clear-then-timeout: log", await device.logAfter(marker), "raw");
      } finally {
        await device.remove(app);
      }
    });

    await ctx.part("clear-then-fetch", { firmware: "1.4.1", consent: ["reboot"] }, async () => {
      const app = ctx.app("clearfetch");
      const marker = ctx.marker("clear-then-fetch");
      try {
        await device.install(app, { "scripts/main.js": clearThenFetchApp(app, marker) });
        await device.launch(app);
        await sleep(1500);
        const got = await ctx.risky(app, "clear-then-fetch", (v) => ["answered", "failed"].includes(v.phase), 10000);
        ctx.observe("clear-then-fetch: what the app got", got.outcome === "done" ? got.value : { outcome: got.outcome, saved: got.value, displays: got.frames }, "raw");
        ctx.observe("clear-then-fetch: log", await device.logAfter(marker).catch(() => []), "raw");
      } finally {
        if ((await device.waitUp(180000)) !== null) await device.remove(app);
      }
    });

    await ctx.part("storage-64k", { firmware: "1.4.1", consent: ["heap", "reboot"] }, async () => {
      try {
        const { out, log } = await once(true);
        ctx.observe("storage-64k: localStorage of 1, 16 and 64 KiB", out?.storage ?? out, "raw");
        ctx.observe("storage-64k: log", log, "raw");
      } finally {
        if ((await device.waitUp(180000)) !== null) await device.remove(id);
      }
    });
  },
};
