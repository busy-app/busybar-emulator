// Small PNG files for the app's tests of the icon block (Create app, Publish), and the shape of the icons the command
// line writes. Node's own modules only: the app's tests import nothing from the other packages (boundaries.test.mjs).
import { crc32, deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** An 8-bit PNG: 4 channels RGBA (color type 6) or 2, gray and alpha (color type 4); every row filter 0. */
export function encodePng({ width, height, channels, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, channels === 4 ? 6 : 4, 0, 0, 0], 8);
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * The shape of an 8-bit RGBA or gray-and-alpha PNG whose rows all use filter 0 (what the command line's icon writes,
 * and encodePng above), as lines: "#" opaque, "+" half, "." clear.
 */
export function shapeOf(bytes) {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 4 ? 2 : 0;
  if (bytes[24] !== 8 || !channels) throw new Error("not an 8-bit RGBA or gray-and-alpha PNG");
  const data = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString("latin1", at + 4, at + 8) === "IDAT") data.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels + 1;
  return Array.from({ length: height }, (_, y) => {
    if (raw[y * stride] !== 0) throw new Error("a row with a filter other than 0");
    return Array.from({ length: width }, (_, x) => {
      const alpha = raw[y * stride + 1 + x * channels + channels - 1];
      return alpha > 191 ? "#" : alpha > 63 ? "+" : ".";
    }).join("");
  }).join("\n");
}
