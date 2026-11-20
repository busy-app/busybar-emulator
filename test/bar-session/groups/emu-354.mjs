// EMU-354: what EMU-337 left open, and the recordings of 1.3.1.
//   chars       the app writes String.fromCharCode(0..255) to /ext/data/z.bin; the computer reads it back: the answer
//               and the bytes (hex), under the names of test/app-files.mjs ("A fromCharCode(0..255)", "file
//               a-chars0.bin"), which takes them as its line for the firmware;
//   empty-snd   audio/play of an app's empty .snd (its answer, the log), then the computer's write to it; another sound,
//               and the write again (raw);
//   refused     the app's refused write to its own assets with a body of 1, 64, 512, 2048 and 8192 bytes, each in a run
//               of its own: whether its fetch ends in 10 s and how (raw: from what size it hangs);
//   playing     the computer's write, append, removal and renames of a sound that plays, as test/app-files.mjs's E
//               lines (exact where app-files says them from a BUSY Bar, the rest: their names, so that app-files
//               takes them);
//   records-1.3.1  on a BUSY Bar with 1.3.1: api.mjs --bar --record and fetch.mjs --bar --record.
import { charsApp, refusedWriteApp, tone } from "../apps.mjs";
import { Device, sleep } from "../lib.mjs";

const SIZES = [1, 64, 512, 2048, 8192];

export default {
  id: "EMU-354",
  title: "what EMU-337 left open, and the recordings of 1.3.1",
  async run(ctx) {
    const device = ctx.device;

    await ctx.part("chars", { firmware: "1.4.1" }, async () => {
      const id = ctx.app("chars");
      try {
        await device.install(id, { "scripts/main.js": charsApp(id, ctx.marker("chars")) });
        await device.launch(id);
        const answer = await device.waitFor(id, "chars", 15000);
        const said = answer?.error ?? (answer ? `${answer.status} ${(() => { try { const j = JSON.parse(answer.text); return j.error ?? j.result; } catch { return answer.text; } })()}`.trim() : "no answer");
        ctx.observe("chars: A fromCharCode(0..255)", said);
        const file = await device.api("GET", `storage/read?path=/ext/apps_data/js_apps/${id}/z.bin`);
        ctx.observe("chars: file a-chars0.bin", file.status === 200 ? file.bytes.toString("hex") : "none");
        ctx.observe("chars: the file's length and first byte", file.status === 200 ? { length: file.bytes.length, first: file.bytes.subarray(0, 1).toString("hex") } : null);
      } finally {
        await device.remove(id);
      }
    });

    await ctx.part("empty-snd", { firmware: "1.4.1" }, async () => {
      const id = ctx.app("empty");
      const marker = ctx.marker("empty");
      try {
        await device.install(id, { "scripts/main.js": `console.log(${JSON.stringify(marker)});\nsetInterval(function () {}, 1000);\n`, "sounds/empty.snd": Buffer.alloc(0), "sounds/short.snd": tone(500) });
        await device.launch(id);
        await sleep(1000);
        const play = async (path) => Device.short(await device.api("POST", "audio/play", JSON.stringify({ application_name: id, path })));
        const write = async () => Device.short(await device.api("POST", `storage/write?path=/ext/user_assets/${id}/sounds/empty.snd`, "x"));
        // A warm amplifier first: on a cold one the answer comes before the file is opened.
        const steps = [];
        steps.push(["play short.snd (warms the amplifier)", await play("sounds/short.snd")]);
        await sleep(800);
        steps.push(["play empty.snd", await play("sounds/empty.snd")]);
        await sleep(300);
        steps.push(["the computer writes to empty.snd", await write()]);
        steps.push(["play short.snd", await play("sounds/short.snd")]);
        await sleep(1000);
        steps.push(["the computer writes to empty.snd after short.snd ended", await write()]);
        ctx.observe("empty-snd: the answers", steps, "raw");
        ctx.observe("empty-snd: log", await device.logAfter(marker), "raw");
      } finally {
        await device.remove(id);
      }
    });

    await ctx.part("refused", { firmware: "1.4.1" }, async () => {
      const id = ctx.app("refused");
      const out = {};
      try {
        for (const size of SIZES) {
          const marker = ctx.marker(`refused ${size}`);
          await device.install(id, { "scripts/main.js": refusedWriteApp(id, marker, size) });
          await device.launch(id);
          const got = await device.waitFor(id, "write", 12000, (v) => v.phase === "ended");
          out[size] = got?.phase === "ended" ? got.value : "no end in 10 s";
          ctx.observe(`refused: ${size} bytes: log`, await device.logAfter(marker), "raw");
          await device.remove(id);
        }
      } finally {
        await device.remove(id);
      }
      ctx.observe("refused: each body size, how the app's fetch ended", out, "raw");
    });

    await ctx.part("playing", { firmware: "1.4.1" }, async () => {
      // As test/app-files.mjs does E: e.snd of 5 s, f.snd of 0.5 s, x.snd written by the computer.
      const id = ctx.app("playing");
      const sounds = `/ext/user_assets/${id}/sounds`;
      try {
        await device.install(id, { "scripts/main.js": "setInterval(function () {}, 1000);\n", "sounds/e.snd": tone(5000), "sounds/f.snd": tone(500, 660) });
        await device.launch(id);
        await sleep(1000);
        const play = async (path) => Device.short(await device.api("POST", "audio/play", JSON.stringify({ application_name: id, path })));
        const e = `storage/write?path=${sounds}/e.snd`;
        const bit = Buffer.alloc(64);
        const folder = async () => ((await device.api("GET", `storage/list?path=${sounds}`)).json?.list ?? []).map((f) => f.name).sort().join(", ");
        await device.api("POST", `storage/write?path=${sounds}/x.snd`, tone(500));
        ctx.observe("playing: E play the app's sound", await play("sounds/e.snd"));
        await sleep(300);
        ctx.observe("playing: E write to it while it plays", Device.short(await device.api("POST", e, bit)));
        ctx.observe("playing: E append to it while it plays", Device.short(await device.api("POST", `${e}&append=1`, bit)));
        ctx.observe("playing: E remove it while it plays", Device.short(await device.api("DELETE", `storage/remove?path=${sounds}/e.snd`)));
        ctx.observe("playing: E rename it while it plays", Device.short(await device.api("POST", `storage/rename?path=${sounds}/e.snd&new_path=${sounds}/e2.snd`)));
        ctx.observe("playing: E rename another file onto it while it plays", Device.short(await device.api("POST", `storage/rename?path=${sounds}/x.snd&new_path=${sounds}/e.snd`)));
        ctx.observe("playing: E the folder after", await folder());
        ctx.observe("playing: E stop", Device.short(await device.api("DELETE", "audio/play")));
        ctx.observe("playing: E write to it after the stop", Device.short(await device.api("POST", e, bit)));
        ctx.observe("playing: E play a short sound", await play("sounds/f.snd"));
        await sleep(2500);
        ctx.observe("playing: E write to it after it ended by itself", Device.short(await device.api("POST", `storage/write?path=${sounds}/f.snd`, bit)));
      } finally {
        await device.remove(id);
      }
    });

    await ctx.part("records-1.3.1", { firmware: "1.3.1", suite: true }, async () => {
      await ctx.suite("api.mjs", ["--bar", ctx.addr, "--record"], "the API's answers on 1.3.1");
      await ctx.suite("fetch.mjs", ["--bar", ctx.addr, "--record"], "fetch on 1.3.1");
    });
  },
};
