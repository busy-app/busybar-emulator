// The emulator's icon as vector drawings, made from the one master (icon/emulator-icon.svg: BUSY's "BUSY Emulator
// Icon", a blue square with a cutting mat's grid and the BUSY logo), and the two file formats of an app's icon.
// No Electron and no program of the system here: app-icon.mjs draws these with Electron, the tests read them.
//
// Two shapes:
//   "mac"   macOS's icon grid: a 1024 canvas, the picture in the rounded square of 824 in its middle, with the soft
//           shadow under it (Apple's template for app icons since macOS 11)
//   "tile"  the rounded square alone, edge to edge: Windows' icon, the mark in the window and in the documents
// Three amounts of detail, chosen by how many pixels the square gets, so that neither the grid nor the logo turns to
// mud (each was looked at, at every size the icon files hold):
//   "full"     everything
//   "medium"   the heavy lines of the grid only, a little thicker
//   "compact"  no grid: the whole logo (the sign and BUSY in the bar's white outline) across nearly the whole square,
//              drawn pixel by pixel for the size (compactMark). In macOS's grid an icon this small has no shadow and
//              its square fills the canvas but for a pixel at each side, from 32 (compactMargin).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MASTER = path.resolve(HERE, "..", "..", "icon", "emulator-icon.svg");

/** The master's side, the canvas of macOS's icon grid, and the rounded square in it. */
export const ART = 1080;
export const MAC_CANVAS = 1024;
export const MAC_BODY = 824;

/** Pixels of the rounded square from which the picture has the fine grid, and from which it has any grid. */
export const FULL_FROM = 200;
export const MEDIUM_FROM = 40;

const number = (value) => String(+value.toFixed(2));

/** The parts of the master, by the names they have in BUSY's file. */
export function masterParts(text = readFileSync(MASTER, "utf8")) {
  const element = (id) => {
    const found = text.match(new RegExp(`<path id="${id}" [^>]*/>`));
    if (!found) throw new Error(`the master has no "${id}"`);
    return found[0].replace(` id="${id}"`, "");
  };
  const attribute = (tag, name) => tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1];
  const gradient = (id) => {
    const found = text.match(new RegExp(`<linearGradient id="${id}"([^>]*)>([\\s\\S]*?)</linearGradient>`));
    if (!found) throw new Error(`the master has no gradient ${id}`);
    return { attrs: found[1].trim(), stops: found[2].replace(/\s*\n\s*/g, "") };
  };
  const bar = text.match(/<g id="Bar outline">([\s\S]*?)<\/g>/)?.[1].trim().split("\n") ?? [];
  // The bar is drawn four times in the file, one on the other: the last fill is opaque and is the only one seen,
  // then the white outline.
  const fills = bar.filter((line) => / fill="/.test(line));
  const outline = bar.find((line) => / stroke="white"/.test(line));
  if (!fills.length || !outline) throw new Error('the master has no "Bar outline" of fills and a white outline');
  const barFill = fills.at(-1);
  const letters = element("Letters outline").replace(' clip-rule="evenodd"', "");
  return {
    background: gradient(text.match(/<rect width="1080" height="1080" fill="url\(#([\w-]+)\)"\/>/)?.[1]),
    barGradient: gradient(attribute(barFill, "fill").match(/#([\w-]+)/)[1]),
    barPath: attribute(outline, "d"),
    barStroke: Number(attribute(outline, "stroke-width")),
    letters: attribute(letters, "d"),
    grid1: element("Grid 1"),
    grid5: element("Grid 5"),
    grid10: element("Grid 10"),
    rays: element("Angle rays 15-75"),
  };
}

/** A square with continuous corners (a superellipse, as macOS and iOS round their icons), as path data. */
export function roundedSquare(x, y, side, power = 5, steps = 240) {
  const half = side / 2;
  const points = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const corner = (v) => Math.sign(v) * Math.abs(v) ** (2 / power);
    points.push(`${number(x + half + half * corner(Math.cos(t)))} ${number(y + half + half * corner(Math.sin(t)))}`);
  }
  return `M${points.join("L")}Z`;
}

/** How much detail a rounded square of so many pixels shows. */
export const detailFor = (bodyPixels) => (bodyPixels >= FULL_FROM ? "full" : bodyPixels >= MEDIUM_FROM ? "medium" : "compact");

/** The pixels left free at each side of a compact icon in macOS's grid, in place of Apple's margin and shadow: none
 * at 16, where every column counts, one at 32. */
export const compactMargin = (size) => Math.floor(size / 32);

/** The pixels of the rounded square in an icon of a size. */
export function bodyPixels(shape, size) {
  if (shape !== "mac") return size;
  const inGrid = (size * MAC_BODY) / MAC_CANVAS;
  return inGrid >= MEDIUM_FROM ? inGrid : size - 2 * compactMargin(size);
}

const withStroke = (tag, width) => tag.replace(/ stroke-width="[^"]*"/, ` stroke-width="${number(width)}"`);
const strokeOf = (tag) => Number(tag.match(/ stroke-width="([^"]*)"/)[1]);

/** The box of path data that has absolute M, L, H, V, C and Z only, as Figma writes it. */
export function boxOf(d) {
  const xs = [];
  const ys = [];
  for (const [, command, rest] of d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    if (!"MLHVCZ".includes(command)) throw new Error(`path command ${command} is not one Figma writes`);
    const values = (rest.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    if (command === "H") xs.push(...values);
    else if (command === "V") ys.push(...values);
    else values.forEach((value, i) => (i % 2 ? ys : xs).push(value));
  }
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/**
 * The whole logo, the sign and the letters in the bar's white outline, drawn for a small square pixel by pixel: the
 * bar across nearly the whole square, its outline one pixel wide on whole pixels, the sign and the letters as large
 * as the bar's inside allows and as many whole pixels tall as that gives, their top on a pixel's edge. The bar keeps
 * its corners in the master's proportion; only its length over its height changes, so that the letters can be larger.
 * @param {number} offset  where the square begins in the picture's pixels
 * @param {object} [o]
 * @param {number} [o.margin]   pixels between the square's edge and the bar, left and right
 * @param {number} [o.gap]      pixels between the outline and the letters, left and right
 * @param {number} [o.gapY]     pixels between the outline and the letters, above and below
 * @param {number} [o.stretch]  how much taller than the master the letters are drawn: 1.2 gives the 24 pixel icon
 *                              letters five pixels tall, the least in which B, U, S and Y stay apart
 */
function compactMark(parts, pixels, offset, id = "", { margin = 1, gap = 1, gapY = 1, stretch = 1.2 } = {}) {
  const unit = ART / pixels;
  const bar = boxOf(parts.barPath);
  const letters = boxOf(parts.letters);
  const aspect = (letters.right - letters.left) / (letters.bottom - letters.top);
  const m = margin;
  const gx = gap;
  const gy = gapY;
  const snap = (start) => Math.round(offset + start) - offset;
  const left = snap(m);
  const width = Math.round(offset + pixels - m) - offset - left;
  const inside = width - 2 - 2 * gx;
  const rows = Math.max(2, Math.round((inside / aspect) * stretch));
  const height = rows + 2 * gy + 2;
  const top = snap((pixels - height) / 2);
  const x = left + 0.5;
  const y = top + 0.5;
  const w = width - 1;
  const h = height - 1;
  const r = Math.min(h / 2, Math.max(1.5, height * (65.52 / (bar.bottom - bar.top))));
  const k = 0.45;
  const u = (v) => number(v * unit);
  const outline = `M${u(x + r)} ${u(y)}H${u(x + w - r)}C${u(x + w - r * k)} ${u(y)} ${u(x + w)} ${u(y + r * k)} ${u(x + w)} ${u(y + r)}V${u(y + h - r)}C${u(x + w)} ${u(y + h - r * k)} ${u(x + w - r * k)} ${u(y + h)} ${u(x + w - r)} ${u(y + h)}H${u(x + r)}C${u(x + r * k)} ${u(y + h)} ${u(x)} ${u(y + h - r * k)} ${u(x)} ${u(y + h - r)}V${u(y + r)}C${u(x)} ${u(y + r * k)} ${u(x + r * k)} ${u(y)} ${u(x + r)} ${u(y)}Z`;
  // Each of the five shapes (the sign, B, U, S, Y) gets whole pixels of width in the master's proportion, its left
  // edge on a pixel's edge, a pixel between them when there is room: their stems then fall on pixels, not between.
  const glyphs = parts.letters
    .split(/(?=M)/)
    .map((d) => ({ d, box: boxOf(d) }))
    .sort((a, b) => a.box.left - b.box.left)
    .reduce((list, glyph) => {
      // A counter (the holes of the B) is a subpath inside the shape before it.
      const last = list.at(-1);
      if (last && glyph.box.left >= last.box.left && glyph.box.right <= last.box.right) {
        last.d += glyph.d;
      } else list.push({ ...glyph });
      return list;
    }, []);
  const between = inside >= 16 ? 1 : 0;
  const room = inside - between * (glyphs.length - 1);
  const masterWidth = glyphs.reduce((sum, g) => sum + g.box.right - g.box.left, 0);
  const exact = glyphs.map((g) => ((g.box.right - g.box.left) / masterWidth) * room);
  const widths = exact.map((w) => Math.max(1, Math.round(w)));
  for (let extra = widths.reduce((a, b) => a + b, 0) - room; extra !== 0; extra -= Math.sign(extra)) {
    // Take from, or give to, the shape whose rounding moved it the most.
    const errors = widths.map((w, i) => (w - exact[i]) * Math.sign(extra));
    widths[errors.indexOf(Math.max(...errors))] -= Math.sign(extra);
  }
  const scaleY = (rows * unit) / (letters.bottom - letters.top);
  let at = left + 1 + gx;
  const drawn = glyphs.map((g, i) => {
    const scaleX = (widths[i] * unit) / (g.box.right - g.box.left);
    const tag = `<path transform="translate(${u(at)} ${u(top + 1 + gy)}) scale(${+scaleX.toFixed(4)} ${+scaleY.toFixed(4)}) translate(${number(-g.box.left)} ${number(-letters.top)})" fill-rule="evenodd" d="${g.d}" fill="white"/>`;
    at += widths[i] + between;
    return tag;
  });
  return [
    `<path d="${outline}" fill="url(#bar${id})" stroke="white" stroke-width="${number(unit)}"/>`,
    ...drawn,
  ].join("");
}

/**
 * The picture itself in the master's 1080 square, without a shape around it.
 * @param {"full" | "medium" | "compact"} detail
 * @param {number} pixels  the pixels the square gets: thin lines are drawn no thinner than they can be seen
 * @param {number} offset  where the square begins in the picture's pixels
 */
export function picture(parts, detail, pixels, id = "", offset = 0) {
  const unit = ART / pixels; // one pixel, in the master's units
  if (detail === "compact") return `<rect width="${ART}" height="${ART}" fill="url(#bg${id})"/>${compactMark(parts, pixels, offset, id)}`;
  const lines = [];
  if (detail === "full") lines.push(parts.grid1, parts.grid5, parts.grid10, parts.rays);
  if (detail === "medium") {
    // The heavy lines, each at least six tenths of a pixel and paler than in the master, so that at these sizes they
    // stay behind the logo; the dotted rays only where their dots are dots.
    const heavy = (tag) => withStroke(tag, Math.max(strokeOf(tag), 0.6 * unit)).replace(/ stroke-opacity="[^"]*"/, ' stroke-opacity="0.35"');
    lines.push(heavy(parts.grid5), heavy(parts.grid10));
    if (pixels >= 96) lines.push(parts.rays);
  }
  // The logo's outline: a pixel at least, never so thick that it reaches the letters.
  const outline = Math.min(Math.max(parts.barStroke, unit), 40);
  return [
    `<rect width="${ART}" height="${ART}" fill="url(#bg${id})"/>`,
    ...lines,
    `<path d="${parts.barPath}" fill="url(#bar${id})" stroke="white" stroke-width="${number(outline)}"/>`,
    `<path fill-rule="evenodd" d="${parts.letters}" fill="white"/>`,
  ].join("");
}

const gradients = (parts, id) => `<linearGradient id="bg${id}" ${parts.background.attrs}>${parts.background.stops}</linearGradient><linearGradient id="bar${id}" ${parts.barGradient.attrs}>${parts.barGradient.stops}</linearGradient>`;

/**
 * The icon as a whole SVG document.
 * @param {object} o
 * @param {"mac" | "tile"} o.shape
 * @param {number} o.size      the pixels it is drawn at (chooses the detail)
 * @param {string} [o.detail]  the detail, when not the one the size gives
 * @param {string} [o.id]      a suffix for the ids, for several icons in one page
 */
export function iconSvg({ shape, size, detail, id = "", parts = masterParts() }) {
  const pixels = bodyPixels(shape, size);
  const shown = detail ?? detailFor(pixels);
  if (shape === "mac" && shown === "compact") {
    // Small enough that Apple's margin and shadow would only take pixels from the logo: the square nearly fills the
    // canvas, on whole pixels.
    const margin = compactMargin(size);
    const inner = picture(parts, shown, pixels, id, margin);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="none"><defs>${gradients(parts, id)}<clipPath id="shape${id}"><path d="${roundedSquare(0, 0, ART)}"/></clipPath></defs><g transform="translate(${margin} ${margin}) scale(${+(pixels / ART).toFixed(6)})"><g clip-path="url(#shape${id})">${inner}</g></g></svg>\n`;
  }
  const inner = picture(parts, shown, pixels, id, shape === "mac" ? (size * (MAC_CANVAS - MAC_BODY)) / 2 / MAC_CANVAS : 0);
  if (shape === "tile") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ART} ${ART}" fill="none"><defs>${gradients(parts, id)}<clipPath id="shape${id}"><path d="${roundedSquare(0, 0, ART)}"/></clipPath></defs><g clip-path="url(#shape${id})">${inner}</g></svg>\n`;
  }
  if (shape !== "mac") throw new Error(`An icon is "mac" or "tile", not ${shape}`);
  const edge = (MAC_CANVAS - MAC_BODY) / 2;
  const body = roundedSquare(edge, edge, MAC_BODY);
  // Apple's template: the shadow of the rounded square is black at 30 %, 10 down, blurred by 10 (of 1024).
  const shadow = `<filter id="shadow${id}" x="0" y="0" width="${MAC_CANVAS}" height="${MAC_CANVAS}" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="10"/></filter>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAC_CANVAS} ${MAC_CANVAS}" fill="none"><defs>${gradients(parts, id)}${shadow}<clipPath id="shape${id}"><path d="${body}"/></clipPath></defs><path d="${body}" transform="translate(0 10)" fill="#000" fill-opacity="0.3" filter="url(#shadow${id})"/><g clip-path="url(#shape${id})"><g transform="translate(${edge} ${edge}) scale(${number(MAC_BODY / ART)})">${inner}</g></g></svg>\n`;
}

// ---------------------------------------------------------------- the files' formats

/** The sizes of the two icon files, in pixels. macOS names its ten by points and scale. */
export const ICO_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 256]);
export const ICONSET = Object.freeze([
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
]);

/** The width and height a PNG file states. */
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString("latin1", 12, 16) !== "IHDR") throw new Error("not a PNG file");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * An .ico file. The images up to 64 pixels are written as bitmaps (32 bits, with the mask Windows asks for), which
 * every reader of the format takes; 256 is a PNG, as Windows itself writes it.
 * @param {{ size: number, rgba: Buffer, png: Buffer }[]} images  rgba: rows from the top, not premultiplied
 */
export function writeIco(images) {
  const entries = images.map(({ size, rgba, png }) => {
    if (size >= 256) return { size, data: png };
    if (rgba.length !== size * size * 4) throw new Error(`the ${size} pixel image has ${rgba.length} bytes, not ${size * size * 4}`);
    const maskRow = Math.ceil(size / 32) * 4;
    const data = Buffer.alloc(40 + size * size * 4 + maskRow * size);
    data.writeUInt32LE(40, 0);
    data.writeInt32LE(size, 4);
    data.writeInt32LE(size * 2, 8); // the picture and its mask
    data.writeUInt16LE(1, 12);
    data.writeUInt16LE(32, 14);
    data.writeUInt32LE(size * size * 4 + maskRow * size, 20);
    for (let y = 0; y < size; y++) {
      const row = size - 1 - y; // bitmaps go from the bottom up
      for (let x = 0; x < size; x++) {
        const from = (y * size + x) * 4;
        const to = 40 + (row * size + x) * 4;
        data[to] = rgba[from + 2];
        data[to + 1] = rgba[from + 1];
        data[to + 2] = rgba[from];
        data[to + 3] = rgba[from + 3];
        // The mask: a bit for every pixel that shows nothing.
        if (rgba[from + 3] === 0) data[40 + size * size * 4 + row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    return { size, data };
  });
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    head[at] = size >= 256 ? 0 : size;
    head[at + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(data.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((entry) => entry.data)]);
}

/** The images of an .ico file: [{ size, bits, png, bytes }]; an error when the file is not one. */
export function readIco(bytes) {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error("not an .ico file");
  const count = bytes.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const length = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    if (offset + length > bytes.length) throw new Error("an image of the .ico file ends after the file");
    const data = bytes.subarray(offset, offset + length);
    const png = data.readUInt32BE(0) === 0x89504e47;
    const size = png ? pngSize(data).width : data.readInt32LE(4);
    if ((bytes[at] || 256) !== size) throw new Error(`the .ico file lists ${bytes[at] || 256} pixels for an image of ${size}`);
    images.push({ size, bits: bytes.readUInt16LE(at + 6), png, bytes: length });
  }
  return images;
}

/** The images of an .icns file: [{ type, bytes, size? }], size for those that are PNG files. */
export function readIcns(bytes) {
  if (bytes.length < 8 || bytes.toString("latin1", 0, 4) !== "icns" || bytes.readUInt32BE(4) !== bytes.length) throw new Error("not an .icns file");
  const images = [];
  for (let at = 8; at < bytes.length; ) {
    const type = bytes.toString("latin1", at, at + 4);
    const length = bytes.readUInt32BE(at + 4);
    if (length < 8 || at + length > bytes.length) throw new Error(`the .icns file's ${type} ends after the file`);
    const data = bytes.subarray(at + 8, at + length);
    const png = data.length > 24 && data.readUInt32BE(0) === 0x89504e47;
    images.push({ type, bytes: data.length, ...(png ? { size: pngSize(data).width } : {}) });
    at += length;
  }
  return images;
}
