// A plain zip writer and reader, for the payload of the Windows setup and for reading the files of a release on any
// system. The writer is deterministic: entries in the order given, every time stamp 1980-01-01 00:00, no extra
// fields, names in UTF-8. It writes files only (folders come from the paths), deflated when that is smaller, and
// refuses what plain zip cannot hold (an entry of 4 GiB or more, 65535 entries or more) rather than writing ZIP64.
import { closeSync, openSync, readFileSync, readSync, fstatSync, writeSync } from "node:fs";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;
const DOS_DATE_1980 = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const MAX32 = 0xffffffff;

function checkName(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Not a name a zip entry may have: ${JSON.stringify(name)}`);
  }
}

/**
 * Writes a zip.
 * @param {string} out
 * @param {{ name: string, file?: string, bytes?: Buffer }[]} entries  name: forward slashes, relative
 * @param {{ level?: number }} [o]
 * @returns {{ entries: number, bytes: number }}
 */
export function writeZip(out, entries, { level = 9 } = {}) {
  if (entries.length >= 0xffff) throw new Error(`${entries.length} entries: plain zip holds fewer than 65535`);
  const seen = new Set();
  const fd = openSync(out, "w");
  const central = [];
  let offset = 0;
  const put = (buffer) => {
    writeSync(fd, buffer);
    offset += buffer.length;
  };
  try {
    for (const entry of entries) {
      checkName(entry.name);
      if (seen.has(entry.name.toLowerCase())) throw new Error(`Twice in the zip (names are compared without case, as Windows does): ${entry.name}`);
      seen.add(entry.name.toLowerCase());
      const data = entry.bytes ?? readFileSync(entry.file);
      if (data.length >= MAX32) throw new Error(`${entry.name}: ${data.length} bytes, plain zip holds less than 4 GiB per entry`);
      const deflated = deflateRawSync(data, { level });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const crc = crc32(data);
      const name = Buffer.from(entry.name, "utf8");
      if (offset >= MAX32) throw new Error("The zip passed 4 GiB: plain zip cannot address it");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(LOCAL, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(UTF8, 6);
      header.writeUInt16LE(stored ? 0 : 8, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(DOS_DATE_1980, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(body.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28);
      central.push({ name, crc, method: stored ? 0 : 8, compressed: body.length, size: data.length, offset });
      put(header);
      put(name);
      put(body);
    }
    const start = offset;
    for (const e of central) {
      const record = Buffer.alloc(46);
      record.writeUInt32LE(CENTRAL, 0);
      record.writeUInt16LE(20, 4); // made by: MS-DOS attributes, version 2.0
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(UTF8, 8);
      record.writeUInt16LE(e.method, 10);
      record.writeUInt16LE(0, 12);
      record.writeUInt16LE(DOS_DATE_1980, 14);
      record.writeUInt32LE(e.crc, 16);
      record.writeUInt32LE(e.compressed, 20);
      record.writeUInt32LE(e.size, 24);
      record.writeUInt16LE(e.name.length, 28);
      record.writeUInt32LE(e.offset, 42);
      put(record);
      put(e.name);
    }
    const size = offset - start;
    if (offset >= MAX32) throw new Error("The zip passed 4 GiB: plain zip cannot address it");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(END, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    put(end);
  } finally {
    closeSync(fd);
  }
  return { entries: central.length, bytes: offset };
}

function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buffer, done, length - done, position + done);
    if (n === 0) throw new Error(`The file ends at ${position + done}, ${length - done} bytes short`);
    done += n;
  }
  return buffer;
}

/**
 * Opens a zip that lies in a file, alone or inside a larger file (offset and length), and reads its central directory.
 * Returns { entries, read(name), close() }; entries: { name, size, compressed, method, mode, isLink, isDir }.
 */
export function openZip(file, { offset = 0, length = null } = {}) {
  const fd = openSync(file, "r");
  try {
    const total = length ?? fstatSync(fd).size - offset;
    const tailLength = Math.min(total, 22 + 0xffff);
    const tail = readAt(fd, offset + total - tailLength, tailLength);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error(`${file}: no end of a zip's central directory`);
    const count = tail.readUInt16LE(at + 10);
    const size = tail.readUInt32LE(at + 12);
    const start = tail.readUInt32LE(at + 16);
    if (count === 0xffff || size === MAX32 || start === MAX32) throw new Error(`${file}: a ZIP64 archive, not read here`);
    const directory = readAt(fd, offset + start, size);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (directory.readUInt32LE(p) !== CENTRAL) throw new Error(`${file}: the central directory is broken at entry ${i}`);
      const madeBy = directory.readUInt16LE(p + 4) >> 8;
      const flags = directory.readUInt16LE(p + 8);
      const method = directory.readUInt16LE(p + 10);
      const crc = directory.readUInt32LE(p + 16);
      const compressed = directory.readUInt32LE(p + 20);
      const entrySize = directory.readUInt32LE(p + 24);
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      const external = directory.readUInt32LE(p + 38);
      const localOffset = directory.readUInt32LE(p + 42);
      const name = directory.subarray(p + 46, p + 46 + nameLength).toString(flags & UTF8 ? "utf8" : "latin1");
      const mode = madeBy === 3 ? external >>> 16 : 0;
      entries.push({ name, size: entrySize, compressed, method, crc, mode, localOffset, isLink: (mode & 0o170000) === 0o120000, isDir: name.endsWith("/") });
      p += 46 + nameLength + extraLength + commentLength;
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    return {
      entries,
      read(name) {
        const e = byName.get(name);
        if (!e) throw new Error(`${file}: no entry ${name}`);
        const local = readAt(fd, offset + e.localOffset, 30);
        if (local.readUInt32LE(0) !== LOCAL) throw new Error(`${file}: the local header of ${name} is broken`);
        const skip = 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const body = readAt(fd, offset + e.localOffset + skip, e.compressed);
        const data = e.method === 0 ? body : e.method === 8 ? inflateRawSync(body) : null;
        if (!data) throw new Error(`${file}: ${name} is packed with method ${e.method}, not read here`);
        if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`${file}: ${name} does not unpack to what the directory records`);
        return data;
      },
      close() {
        closeSync(fd);
      },
    };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}
