// EMU-350: an app that fails while it runs, and the heap.
//   golden     the three failing apps' screens 5 s after the start, as golden scenes (golden.mjs records them);
//   failures   the same apps watched: both displays 0.5, 2 and 5 s after the start, the launch's answer, whether the
//              app is still listed, the log; for the rejection, whether the app still runs a second later and on;
//   oom-early  (consent heap, reboot) the BUSY Bar restarted, then the heap filled in its first 30 s: the supervisor's
//              screens; the BUSY Bar then takes no input, so it is restarted again;
//   oom-late   (consent heap, reboot) the heap filled after 30 s: how long until the BUSY Bar restarts and is back;
//   json       (consent heap, reboot) JSON.parse of answers of 60, 70 and 80 KiB, each in a run of its own, smaller
//              first, until one fails.
// The heap apps fill it only when OK is pressed: after a restart APPS opens the last app again, and it waits there.
// All but the launch's answer is raw: what the BUSY Bar shows and writes is what the session is for.
import { createServer } from "node:http";

import { errorApp, jsonApp, oomApp } from "../apps.mjs";
import { Device, sleep } from "../lib.mjs";

const FAILING = ["throw", "handler", "rejection"];
const AT = [500, 2000, 5000];

/** A server on this computer that answers /json?kib=N with a JSON document of about N KiB. */
async function jsonServer(host, port) {
  const server = createServer((req, res) => {
    const kib = Number(new URL(req.url, "http://x").searchParams.get("kib") ?? 1);
    const items = [];
    let size = 12;
    while (size < kib * 1024) {
      const item = `item ${items.length} ${"x".repeat(40)}`;
      items.push(item);
      size += item.length + 3;
    }
    const body = JSON.stringify({ items });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  return server;
}

export default {
  id: "EMU-350",
  title: "an app's errors: an exception, a rejected promise, the heap filled",
  async run(ctx) {
    const device = ctx.device;
    await ctx.part("golden", { firmware: "1.4.1", suite: true }, () =>
      ctx.suite("golden.mjs", ["--record", "--bar", ctx.addr, "--only", FAILING.map((k) => `system-error-${k}`).join(",")], "the failing apps' screens"),
    );

    await ctx.part("failures", { firmware: "1.4.1" }, async () => {
      for (const kind of FAILING) {
        const id = ctx.app(`error.${kind}`);
        const marker = ctx.marker(kind);
        try {
          await device.install(id, { "scripts/main.js": errorApp(kind, id, marker) });
          const launched = await device.api("POST", `apps/launch?app_id=${id}`);
          const t0 = Date.now();
          ctx.observe(`failures: ${kind}: the launch's answer`, Device.short(launched));
          const frames = {};
          for (const at of AT) {
            if (kind === "handler" && at === 2000) {
              // The handler fails on the first key.
              await sleep(Math.max(0, 1500 - (Date.now() - t0)));
              ctx.observe(`failures: ${kind}: OK's answer`, Device.short(await device.api("POST", "input?key=ok")));
            }
            await sleep(Math.max(0, at - (Date.now() - t0)));
            frames[`${at} ms`] = await device.frames();
          }
          ctx.observe(`failures: ${kind}: both displays after the start`, frames, "raw");
          const listed = ((await device.api("GET", "apps/list")).json?.apps ?? []).some((a) => a.id === id);
          ctx.observe(`failures: ${kind}: still listed in apps/list`, listed, "raw");
          if (kind === "rejection") {
            const ticks = Number((await device.localStorage(id))?.ticks ?? 0);
            ctx.observe(`failures: ${kind}: runs on after the rejection (seconds counted by the app)`, ticks, "raw");
          }
          ctx.observe(`failures: ${kind}: log`, await device.logAfter(marker), "raw");
        } finally {
          await device.remove(id);
        }
      }
    });

    const oom = ctx.app("oom");
    await ctx.part("oom-early", { firmware: "1.4.1", consent: ["heap", "reboot"] }, async () => {
      const marker = ctx.marker("oom-early");
      try {
        await device.install(oom, { "scripts/main.js": oomApp(oom, marker) });
        ctx.say("      restarting the BUSY Bar, to be in its first 30 s");
        const up = await device.reboot();
        if (up === null) throw new Error("the BUSY Bar did not come back after the restart");
        await device.api("POST", "apps/quit");
        await device.launch(oom);
        await sleep(1500);
        const uptime = await device.uptime();
        ctx.observe("oom-early: uptime when OK is pressed, s", uptime, "raw");
        if (uptime >= 28) throw new Error(`the BUSY Bar has been up ${uptime} s: too late for the first 30 s`);
        const t0 = Date.now();
        await device.api("POST", "input?key=ok");
        const frames = {};
        for (const at of [500, 1000, 2000, 3000, 5000, 8000]) {
          await sleep(Math.max(0, at - (Date.now() - t0)));
          frames[`${at} ms`] = await device.frames().catch((e) => `no answer: ${e.message}`);
        }
        ctx.observe("oom-early: both displays after OK", frames, "raw");
        ctx.observe("oom-early: OK's answer while the warning shows", Device.short(await device.api("POST", "input?key=ok").catch(() => null)), "raw");
        ctx.observe("oom-early: uptime 10 s after OK, s", await device.uptime().catch(() => null), "raw");
      } finally {
        // The BUSY Bar takes no input until it is restarted.
        ctx.say("      restarting the BUSY Bar again: after the warning it takes no input");
        await device.reboot();
        await device.api("POST", "apps/quit").catch(() => {});
      }
    });

    await ctx.part("oom-late", { firmware: "1.4.1", consent: ["heap", "reboot"] }, async () => {
      const marker = ctx.marker("oom-late");
      try {
        if (!(await device.api("GET", "apps/list")).json?.apps?.some((a) => a.id === oom)) await device.install(oom, { "scripts/main.js": oomApp(oom, marker) });
        await device.api("POST", "apps/quit");
        await device.launch(oom);
        await sleep(1500);
        await device.pastFirstSeconds(ctx.say);
        ctx.observe("oom-late: uptime when OK is pressed, s", await device.uptime(), "raw");
        const since = await device.bootTime();
        const t0 = Date.now();
        await device.api("POST", "input?key=ok");
        const down = await device.waitDown(60000, since);
        ctx.observe("oom-late: from OK until the BUSY Bar restarts, ms", down ?? "it did not restart in 60 s (the displays are kept; the kit restarted it)", "raw");
        if (down === null) {
          ctx.observe("oom-late: both displays 60 s after OK", await device.frames().catch(() => null), "raw");
          await device.reboot();
        }
        const up = down === null ? null : await device.waitUp(180000);
        ctx.observe("oom-late: from then until it is up again, ms", up, "raw");
        ctx.observe("oom-late: from OK until it answers again, ms", up === null ? null : Date.now() - t0, "raw");
        if (up !== null) {
          // APPS opens the last app again: the heap probe, which waits for OK.
          await sleep(3000);
          ctx.observe("oom-late: both displays after the restart", await device.frames(), "raw");
        }
      } finally {
        await device.remove(oom);
      }
    });

    await ctx.part("json", { firmware: "1.4.1", consent: ["heap", "reboot"] }, async () => {
      const server = await jsonServer(await device.listenAddress(), device.helperPort);
      const address = await device.computerAddress();
      const id = ctx.app("json");
      try {
        for (const kib of [60, 70, 80]) {
          const marker = ctx.marker(`json ${kib}`);
          await device.install(id, { "scripts/main.js": jsonApp(id, marker, `http://${address}:${device.helperPort}/json?kib=${kib}`) });
          await device.launch(id);
          await sleep(1500);
          const got = await ctx.risky(id, "json", (v) => ["done", "failed"].includes(v.phase), 30000);
          ctx.observe(`json: ${kib} KiB`, got.outcome === "done" ? got.value : { outcome: got.outcome, saved: got.value, displays: got.frames }, "raw");
          ctx.observe(`json: ${kib} KiB: log`, await device.logAfter(marker).catch(() => []), "raw");
          await device.remove(id);
          if (got.outcome !== "done" || got.value.phase !== "done") break;
        }
      } finally {
        server.close();
        await device.remove(id);
      }
    });
  },
};
