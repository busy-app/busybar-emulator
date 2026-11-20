// EMU-351: fetch.
//   record     fetch.mjs --bar --record: the odd URLs and each case's outcome, what this computer's server received
//              and the case's time, in fetch/bar-<firmware>.json (fetch.mjs compares the emulator with all of it);
//   network    (standard BUSY Bar) HTTP and HTTPS to example.com and apps-api.busy.app, 7 times each: the time from
//              fetch() to the body's text; written to `network` of the firmware in bar-speed.json as for 1.3.1
//              (httpMs, httpsMs, tlsMs), and kept as observations (raw);
//   body       (standard BUSY Bar) bodies of 64 KiB, 256 KiB and 1 MiB from this computer and one of 256 KiB over HTTPS
//              from the internet, read piece by piece: when the head, the first and the last piece came (raw);
//   big-text   (consent heap, reboot) r.text() of answers of 256 KiB to 1.5 MiB, each in a run of its own, smaller
//              first, until one fails; the BUSY Bar's `free` (its CLI) while the app waits (raw).
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { bodyApp, networkApp, textApp } from "../apps.mjs";
import { sleep, testDir } from "../lib.mjs";

const NETWORK = ["http://example.com/", "https://example.com/", "http://apps-api.busy.app/", "https://apps-api.busy.app/"];
const TIMES = 7;
const BODIES = [65536, 262144, 1048576];
const INTERNET_BODY = "https://speed.cloudflare.com/__down?bytes=262144";
const BIG = [256, 512, 768, 1024, 1536];

/** A server on this computer that answers /bytes?n=N with N bytes. */
async function bytesServer(host, port) {
  const server = createServer((req, res) => {
    const n = Number(new URL(req.url, "http://x").searchParams.get("n") ?? 0);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": n });
    const chunk = Buffer.alloc(16384, 0x61);
    let left = n;
    const more = () => {
      while (left > 0) {
        const part = chunk.subarray(0, Math.min(left, chunk.length));
        left -= part.length;
        if (!res.write(part)) return res.once("drain", more);
      }
      res.end();
    };
    more();
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
  return server;
}

const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

/** `network` of the firmware in bar-speed.json, from the times: as 1.3.1's (its note says how it was measured). */
function saveNetwork(root, firmware, measured) {
  const file = root === testDir ? join(testDir, "..", "packages", "server", "bar-speed.json") : join(root, "bar-speed.json");
  let speed;
  try {
    speed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    speed = JSON.parse(readFileSync(join(testDir, "..", "packages", "server", "bar-speed.json"), "utf8"));
  }
  const ok = (url) => (measured[url] ?? []).filter((one) => one.status !== undefined).map((one) => one.ms);
  const http = [...ok(NETWORK[0]), ...ok(NETWORK[2])];
  const https = [...ok(NETWORK[1]), ...ok(NETWORK[3])].sort((a, b) => a - b);
  if (!http.length || !https.length || !speed.firmwares[firmware]) return null;
  const httpMs = median(http);
  const tlsMs = Math.round((median(https) - httpMs) / 50) * 50;
  speed.firmwares[firmware].network = {
    note: `Requests to the internet from an app on the BUSY Bar above, ${new Date().toISOString().slice(0, 10)} (the BUSY Bar session, test/bar-session/groups/emu-351.mjs), fetch() to the body's text, ${TIMES} times each: https to apps-api.busy.app and example.com took ${(https[0] / 1000).toFixed(2)}-${(https.at(-1) / 1000).toFixed(2)} s, http to both ${httpMs} ms (the median). tlsMs is the difference of the medians, the TLS handshake on the BUSY Bar's processor; the emulator makes an https answer wait at least that long.`,
    httpMs,
    httpsMs: https,
    tlsMs,
  };
  writeFileSync(file, JSON.stringify(speed, null, 2) + "\n");
  return file;
}

export default {
  id: "EMU-351",
  title: "fetch: the protocol recorded, HTTPS on 1.4.1, large answers",
  async run(ctx) {
    const device = ctx.device;
    await ctx.part("record", { firmware: "1.4.1", suite: true }, () => ctx.suite("fetch.mjs", ["--bar", ctx.addr, "--record"], "the odd URLs and each case's outcome"));

    await ctx.part("network", { firmware: "1.4.1", standard: true }, async () => {
      const id = ctx.app("network");
      try {
        await device.install(id, { "scripts/main.js": networkApp(id, ctx.marker("network"), NETWORK, TIMES) });
        await device.launch(id);
        const measured = await device.waitFor(id, "network", 180000);
        if (!measured) throw new Error("no times in 3 minutes");
        for (const url of NETWORK) ctx.observe(`network: ${url}`, measured[url], "raw");
        if (ctx.mode !== "replay") {
          const file = saveNetwork(ctx.suiteEnv.EMU_RECORDINGS || testDir, ctx.firmware, measured);
          ctx.say(file ? `      network times written to ${file}` : "      network times not written: a request failed every time");
        }
      } finally {
        await device.remove(id);
      }
    });

    await ctx.part("body", { firmware: "1.4.1", standard: true }, async () => {
      const id = ctx.app("body");
      const server = await bytesServer(await device.listenAddress(), device.helperPort);
      try {
        const address = await device.computerAddress();
        const urls = [...BODIES.map((n) => `http://${address}:${device.helperPort}/bytes?n=${n}`), INTERNET_BODY];
        await device.install(id, { "scripts/main.js": bodyApp(id, ctx.marker("body"), urls) });
        await device.launch(id);
        const got = await device.waitFor(id, "body", 180000);
        if (!got) throw new Error("no times in 3 minutes");
        for (const [i, url] of urls.entries()) ctx.observe(`body: ${i < BODIES.length ? `${BODIES[i] / 1024} KiB from this computer` : "256 KiB over HTTPS from the internet"}`, got[url], "raw");
      } finally {
        server.close();
        await device.remove(id);
      }
    });

    await ctx.part("big-text", { firmware: "1.4.1", consent: ["heap", "reboot"] }, async () => {
      const id = ctx.app("text");
      const server = await bytesServer(await device.listenAddress(), device.helperPort);
      try {
        const address = await device.computerAddress();
        for (const kib of BIG) {
          const marker = ctx.marker(`text ${kib}`);
          await device.install(id, { "scripts/main.js": textApp(id, marker, `http://${address}:${device.helperPort}/bytes?n=${kib * 1024}`) });
          await device.launch(id);
          await sleep(1500);
          if (kib === BIG[0] && ctx.mode === "bar") ctx.observe("big-text: free in the CLI while the app waits", await device.cli("free"), "raw");
          const got = await ctx.risky(id, "text", (v) => ["done", "failed"].includes(v.phase), 60000);
          ctx.observe(`big-text: ${kib} KiB`, got.outcome === "done" ? got.value : { outcome: got.outcome, saved: got.value, displays: got.frames }, "raw");
          ctx.observe(`big-text: ${kib} KiB: log`, await device.logAfter(marker).catch(() => []), "raw");
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
