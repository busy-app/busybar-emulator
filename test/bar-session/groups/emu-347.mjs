// EMU-347: names in an app's package that the BUSY Bar's unpacker may not take as they are. An app is installed from
// an archive written the way bsdtar writes one (a PAX header for a name outside ASCII or one no ustar split fits; a
// prefix for a path that splits at a slash), with a picture named in Cyrillic, one of 120 characters, one at the end
// of a 130-character path, and a plain one. Recorded: the install's answer, the names the BUSY Bar lists under the
// app's folder, and the app's draw of each picture by the name it has in the project. All of it raw: what the BUSY Bar
// makes of these names is what the session is for.
import { gzipSync } from "node:zlib";

import { namesApp } from "../apps.mjs";
import { Device, Stop } from "../lib.mjs";
import { png } from "../png.mjs";

// By code point: the public tree carries no Cyrillic text.
const CYRILLIC = String.fromCodePoint(0x43a, 0x430, 0x440, 0x442, 0x438, 0x43d, 0x43a, 0x430);
const PICTURE = png({ width: 8, height: 8, type: 2, pixel: (x, y) => ((x + y) & 1 ? [255, 255, 0] : [0, 0, 255]) });

function header(name, size, type, prefix = "") {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "latin1");
  h.write(type === "5" ? "0000755\0" : "0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148);
  h.write(type, 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}
const pad = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length = String(length).length + Buffer.byteLength(body);
  return Buffer.from(`${length}${body}`);
}

/** A .tgz as bsdtar's ustar writer makes it (as packages/server/readiness/test/package-names.test.mjs writes one). */
export function bsdtarLike(files) {
  const blocks = [];
  const dirs = new Set();
  for (const full of Object.keys(files)) {
    const parts = full.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  const entry = (full, data, type) => {
    const ascii = /^[\x20-\x7e]*$/.test(full);
    let name = Buffer.from(full, "utf8").toString("latin1");
    let prefix = "";
    let pax = !ascii;
    if (Buffer.byteLength(full) > 100 && ascii) {
      pax = true;
      for (let i = full.indexOf("/"); i >= 0; i = full.indexOf("/", i + 1)) {
        if (i <= 155 && full.length - i - 1 <= 100 && i < full.length - 1) {
          prefix = full.slice(0, i);
          name = full.slice(i + 1);
          pax = false;
          break;
        }
      }
    }
    if (pax) {
      const record = paxRecord("path", full);
      blocks.push(header(`PaxHeader/${full.split("/").filter(Boolean).pop()}`.slice(0, 100), record.length, "x"), pad(record));
      name = Buffer.from(full, "utf8").subarray(0, 100).toString("latin1");
    }
    blocks.push(header(name, data.length, type, prefix), pad(data));
  };
  for (const dir of [...dirs].sort()) entry(dir, Buffer.alloc(0), "5");
  for (const [full, data] of Object.entries(files)) entry(full, Buffer.from(data), "0");
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

export default {
  id: "EMU-347",
  title: "names in an app's package: Cyrillic, 120 characters, a 130-character path",
  async run(ctx) {
    await ctx.part("names", { firmware: "1.4.1" }, async () => {
      const id = ctx.app("names");
      const long = `${"a".repeat(120)}.png`;
      const deep = `${"d".repeat(40)}/${"e".repeat(40)}/${"f".repeat(30)}.png`;
      const paths = ["assets/plain.png", `assets/${CYRILLIC}.png`, `assets/${long}`, `assets/${deep}`];
      const marker = ctx.marker("names");
      const manifest = { format_version: 1, id, name: "Names", version: "0.1.0", api_version: "27.14.0", description: "A probe of the BUSY Bar session", debug: false };
      const tgz = bsdtarLike({
        [`${id}/appmeta/manifest.json`]: JSON.stringify(manifest),
        [`${id}/scripts/main.js`]: namesApp(id, marker, paths),
        ...Object.fromEntries(paths.map((p) => [`${id}/${p}`, PICTURE])),
      });
      try {
        let installed = "200 OK";
        try {
          await ctx.device.install(id, {}, { tgz });
        } catch (e) {
          if (e instanceof Stop) throw e;
          installed = e.message;
        }
        ctx.observe("names: install", installed, "raw");
        if (installed !== "200 OK") return;
        // What the BUSY Bar unpacked, folder by folder.
        const listed = {};
        const walk = async (path, depth) => {
          const r = await ctx.device.api("GET", `storage/list?path=${encodeURI(path)}`);
          listed[path.slice(`/ext/user_assets/${id}`.length) || "/"] = r.json?.list?.map((f) => `${f.type === "dir" ? "dir " : ""}${f.name}${f.size !== undefined ? ` ${f.size}` : ""}`) ?? Device.short(r);
          for (const f of r.json?.list ?? []) if (f.type === "dir" && depth < 4) await walk(`${path}/${f.name}`, depth + 1);
        };
        await walk(`/ext/user_assets/${id}`, 0);
        ctx.observe("names: the folders as the BUSY Bar lists them", listed, "raw");
        await ctx.device.launch(id);
        const drawn = await ctx.device.waitFor(id, "names", 15000);
        ctx.observe("names: the app draws each picture by its name in the project", drawn, "raw");
        ctx.observe("names: log", await ctx.device.logAfter(marker), "raw");
      } finally {
        await ctx.device.remove(id);
      }
    });
  },
};
