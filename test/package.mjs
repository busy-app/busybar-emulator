// App packages for tests: what busy-cli builds, made in memory.
import { gzipSync } from "node:zlib";

// A .tgz the way busy-cli packs an app: ustar entries for the directories and files.
export function targz(files) {
  const blocks = [];
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(type === "5" ? "0000755\0" : "0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const dirs = new Set();
  for (const name of Object.keys(files)) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  for (const dir of [...dirs].sort()) blocks.push(header(dir, 0, "5"));
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    blocks.push(header(name, data.length, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
