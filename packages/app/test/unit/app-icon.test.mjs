// The emulator's icon (tools/app-icon.mjs, tools/app-icon/art.mjs, tools/packaging/icon.mjs): the drawings made from
// the one master, simpler where the picture gets few pixels; the files a build takes, with every size; and where a
// build puts them. No Electron and no program of the system: the files are read as they are committed.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { createAppSchemeHandler, resolveAppFile } from "../../src/app-scheme.mjs";
import { LOGO_SVG, logoSvg, PICTURES } from "../../tools/app-icon.mjs";
import { bodyPixels, boxOf, compactMargin, detailFor, ICO_SIZES, ICONSET, iconSvg, MAC_BODY, MAC_CANVAS, MASTER, masterParts, pngSize, readIcns, readIco, roundedSquare, writeIco } from "../../tools/app-icon/art.mjs";
import { macIconProblems } from "../../tools/packaging/check.mjs";
import { executableIconProblems, executableIconSizes, ICNS_SOURCE, icnsProblems, ICO_SOURCE, icoProblems, MAC_ICON_FILE, setExecutableIcon } from "../../tools/packaging/icon.mjs";
import { appInfoPlist } from "../../tools/packaging/macos.mjs";
import { installerArguments } from "../../tools/packaging/windows.mjs";
import { buildWindowsLauncher, cSharpArguments } from "../../tools/windows-launcher.mjs";
import { APP_DIR, removeFolder, temporaryFolder } from "../helpers.mjs";

let folder;
before(() => (folder = temporaryFolder()));
after(() => removeFolder(folder));

const parts = masterParts();

// ---------------------------------------------------------------- the drawings

test("the master is BUSY's drawing without Figma's canvas: a gradient, the cutting mat's four layers, the bar and the letters", () => {
  const master = readFileSync(MASTER, "utf8");
  assert.doesNotMatch(master, /#4D4D4D/i, "the gray behind the frame in Figma is not part of the drawing");
  assert.match(parts.background.stops, /#2F86E0.*#2C63C4/);
  for (const layer of [parts.grid1, parts.grid5, parts.grid10, parts.rays]) assert.match(layer, /^<path d="M[^"]+" stroke="white" stroke-opacity="0\.\d+" stroke-width="[\d.]+"/);
  assert.equal(parts.barStroke, 7);
  // The sign and the letters: a triangle and B, U, S, Y, inside the bar.
  const letters = boxOf(parts.letters);
  const bar = boxOf(parts.barPath);
  assert.ok(letters.left > bar.left && letters.right < bar.right && letters.top > bar.top && letters.bottom < bar.bottom, JSON.stringify({ letters, bar }));
  assert.equal(parts.letters.split("M").length - 1, 7, "the triangle, B with its two holes, U, S, Y");
});

test("the fewer pixels the picture gets, the less it shows: the fine grid from 200, any grid from 40", () => {
  assert.deepEqual([1024, 512, 256, 128, 64, 32, 16].map((size) => detailFor(bodyPixels("mac", size))), ["full", "full", "full", "medium", "medium", "compact", "compact"]);
  assert.deepEqual(ICO_SIZES.map((size) => detailFor(bodyPixels("tile", size))), ["compact", "compact", "compact", "compact", "medium", "medium", "medium", "full"]);
  const grid1 = parts.grid1.match(/ d="([^"]{40})/)[1];
  const grid5 = parts.grid5.match(/ d="([^"]{40})/)[1];
  const rays = parts.rays.match(/ d="([^"]{40})/)[1];
  const triangle = parts.letters.split(/(?=M)/).find((d) => d.startsWith("M157"));
  const has = (svg) => ({
    fine: svg.includes(grid1),
    heavy: svg.includes(grid5),
    rays: svg.includes(rays),
    bar: /fill="url\(#bar\)" stroke="white"/.test(svg),
    sign: svg.includes(triangle),
    shadow: svg.includes("filter="),
  });
  assert.deepEqual(has(iconSvg({ shape: "tile", size: 256, parts })), { fine: true, heavy: true, rays: true, bar: true, sign: true, shadow: false });
  assert.deepEqual(has(iconSvg({ shape: "tile", size: 128, parts })), { fine: false, heavy: true, rays: true, bar: true, sign: true, shadow: false });
  assert.deepEqual(has(iconSvg({ shape: "tile", size: 48, parts })), { fine: false, heavy: true, rays: false, bar: true, sign: true, shadow: false });
  assert.deepEqual(has(iconSvg({ shape: "mac", size: 64, parts })), { fine: false, heavy: true, rays: false, bar: true, sign: true, shadow: true });
  // The whole logo at every size, the bar and the sign included; the smallest without grid and without shadow.
  for (const [shape, size] of [["tile", 16], ["tile", 20], ["tile", 24], ["tile", 32], ["mac", 16], ["mac", 32]]) {
    assert.deepEqual(has(iconSvg({ shape, size, parts })), { fine: false, heavy: false, rays: false, bar: true, sign: true, shadow: false }, `${shape} ${size}`);
  }
});

test("a thin line is drawn no thinner than it can be seen: the bar's outline is a pixel at least", () => {
  const outline = (size) => Number(iconSvg({ shape: "tile", size, parts }).match(/fill="url\(#bar\)" stroke="white" stroke-width="([\d.]+)"/)[1]);
  assert.equal(outline(256), 7, "as the master has it where that is more than a pixel");
  assert.equal(outline(48), 1080 / 48);
  for (const size of [16, 20, 24, 32]) assert.ok(Math.abs(outline(size) - 1080 / size) < 0.01, `${size}: one pixel`);
});

test("the compact logo is drawn on whole pixels: its five shapes start on a pixel's edge, whole pixels tall", () => {
  const box = boxOf(parts.letters);
  for (const [shape, size, rows] of [["tile", 16, 3], ["tile", 20, 4], ["tile", 24, 5], ["tile", 32, 8], ["mac", 16, 3], ["mac", 32, 7]]) {
    const svg = iconSvg({ shape, size, parts });
    const pixels = bodyPixels(shape, size);
    const unit = 1080 / pixels;
    const offset = shape === "mac" ? compactMargin(size) : 0;
    const glyphs = [...svg.matchAll(/<path transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+) ([\d.]+)\) translate/g)].map((m) => m.slice(1).map(Number));
    assert.equal(glyphs.length, 5, `${shape} ${size}: the sign, B, U, S, Y`);
    let right = 0;
    for (const [left, top, , scaleY] of glyphs) {
      const x = offset + left / unit;
      const y = offset + top / unit;
      assert.ok(Math.abs(x - Math.round(x)) < 0.01 && Math.abs(y - Math.round(y)) < 0.01, `${shape} ${size}: a shape at ${x}, ${y}`);
      assert.ok(Math.abs(((box.bottom - box.top) * scaleY) / unit - rows) < 0.01, `${shape} ${size}: ${rows} rows`);
      assert.ok(left / unit >= right, `${shape} ${size}: the shapes do not overlap`);
      right = left / unit;
      assert.ok(left / unit >= 2 && top / unit >= 2, `${shape} ${size}: inside the bar`);
    }
  }
  // macOS's small icons fill the canvas: none of Apple's margin at 16, one pixel at 32.
  assert.deepEqual([16, 32].map(compactMargin), [0, 1]);
  assert.match(iconSvg({ shape: "mac", size: 32, parts }), /viewBox="0 0 32 32"[\s\S]*<g transform="translate\(1 1\) scale\(0\.027778\)">/);
});

test("macOS's shape: the rounded square of 824 in the middle of 1024, with its shadow; the other shape is the square alone", () => {
  const mac = iconSvg({ shape: "mac", size: 1024, parts });
  assert.match(mac, /viewBox="0 0 1024 1024"/);
  assert.match(mac, /<path d="M924 512L[^"]+Z" transform="translate\(0 10\)" fill="#000" fill-opacity="0\.3" filter="url\(#shadow\)"\/>/);
  assert.match(mac, /<g transform="translate\(100 100\) scale\(0\.76\)">/);
  const tile = iconSvg({ shape: "tile", size: 256, parts });
  assert.match(tile, /viewBox="0 0 1080 1080"/);
  assert.doesNotMatch(tile, /shadow|feGaussianBlur/);
  // The corners are continuous: the shape passes through the middle of each side and stays inside the square's corner.
  const points = [...roundedSquare(100, 100, 824).matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  for (const [x, y] of points) assert.ok(x >= 100 && x <= 924 && y >= 100 && y <= 924);
  assert.ok(points.some(([x, y]) => x === 924 && y === 512) && points.some(([x, y]) => Math.abs(x - 512) < 0.01 && y === 924));
  const corner = Math.max(...points.map(([x, y]) => x + y));
  assert.ok(corner > 924 + 512 + 250 && corner < 924 + 924 - 60, `the corner reaches ${corner}`);
  assert.throws(() => iconSvg({ shape: "circle", size: 32, parts }), /"mac" or "tile"/);
  // Several icons in one page: their gradients and shapes have names of their own.
  assert.match(iconSvg({ shape: "tile", size: 32, parts, id: "-a" }), /id="bg-a".*id="bar-a".*id="shape-a".*url\(#shape-a\).*url\(#bg-a\)/s);
});

// ---------------------------------------------------------------- the files

test("an .ico is written and read back: bitmaps with their mask up to 64 pixels, a PNG at 256", () => {
  const picture = (size) => {
    const rgba = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i++) rgba.set(i === 0 ? [0, 0, 0, 0] : [10, 20, 30, 255], i * 4); // the first pixel shows nothing
    return rgba;
  };
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 1, 0, 0, 0, 1, 0, 8, 6, 0, 0, 0])]);
  const ico = writeIco([{ size: 16, rgba: picture(16) }, { size: 48, rgba: picture(48) }, { size: 256, png }]);
  assert.deepEqual(readIco(ico), [{ size: 16, bits: 32, png: false, bytes: 40 + 16 * 16 * 4 + 16 * 4 }, { size: 48, bits: 32, png: false, bytes: 40 + 48 * 48 * 4 + 48 * 8 }, { size: 256, bits: 32, png: true, bytes: png.length }]);
  // The 16 pixel bitmap: rows from the bottom up, blue first; the mask marks the one empty pixel, the first of the top row.
  const at = ico.readUInt32LE(6 + 12);
  assert.equal(ico.readInt32LE(at + 8), 32, "the height counts the mask");
  assert.deepEqual([...ico.subarray(at + 40, at + 44)], [30, 20, 10, 255], "the first pixel of the bottom row");
  assert.deepEqual([...ico.subarray(at + 40 + 15 * 16 * 4, at + 40 + 15 * 16 * 4 + 4)], [0, 0, 0, 0], "the first pixel of the top row");
  const mask = at + 40 + 16 * 16 * 4;
  assert.equal(ico[mask + 15 * 4], 0x80);
  assert.equal(ico[mask], 0);
  assert.throws(() => writeIco([{ size: 16, rgba: Buffer.alloc(8) }]), /16 pixel image has 8 bytes/);
  assert.throws(() => readIco(Buffer.from("not an icon")), /not an \.ico file/);
  assert.throws(() => readIcns(Buffer.from("not an icon")), /not an \.icns file/);
});

test("the app's .icns holds every size macOS asks for, 16 to 512 points, each also @2x", () => {
  const bytes = readFileSync(ICNS_SOURCE);
  assert.deepEqual(icnsProblems(bytes), []);
  const images = readIcns(bytes);
  assert.deepEqual(images.filter((image) => image.size).map((image) => `${image.type}:${image.size}`).sort(), ["ic07:128", "ic08:256", "ic09:512", "ic10:1024", "ic11:32", "ic12:64", "ic13:256", "ic14:512"]);
  // 16 and 32 pixels are kept in macOS's own form.
  for (const type of ["ic04", "ic05"]) assert.ok(images.find((image) => image.type === type)?.bytes > 200, type);
  assert.deepEqual([...new Set(ICONSET.map((entry) => entry.size))], [16, 32, 64, 128, 256, 512, 1024]);
  assert.match(icnsProblems(bytes.subarray(0, 100)).join(), /not an \.icns file/);
  // An icon without the large sizes (Electron's own has them; a hand-made one may not).
  const small = Buffer.concat([Buffer.from("icns"), Buffer.alloc(4), Buffer.from("ic04"), Buffer.from([0, 0, 0, 12]), Buffer.alloc(4)]);
  small.writeUInt32BE(small.length, 4);
  assert.ok(icnsProblems(small).includes("the .icns has no ic10 (1024 pixels)"));
});

test("the app's .ico holds 16 to 256 pixels; every picture has clear corners and the blue of the drawing", () => {
  const bytes = readFileSync(ICO_SOURCE);
  assert.deepEqual(icoProblems(bytes), []);
  assert.deepEqual(readIco(bytes).map((image) => image.size), [16, 20, 24, 32, 40, 48, 64, 256]);
  readIco(bytes).forEach((image, i) => {
    if (image.png) return;
    const at = bytes.readUInt32LE(6 + 16 * i + 12) + 40;
    const pixel = (x, y) => [...bytes.subarray(at + ((image.size - 1 - y) * image.size + x) * 4, at + ((image.size - 1 - y) * image.size + x) * 4 + 4)]; // blue, green, red, alpha
    for (const [x, y] of [[0, 0], [image.size - 1, 0], [0, image.size - 1], [image.size - 1, image.size - 1]]) assert.equal(pixel(x, y)[3], 0, `${image.size}: the corner ${x},${y} is clear`);
    // A quarter of the way down the middle: the gradient, above the logo.
    const [blue, green, red, alpha] = pixel(image.size >> 1, image.size >> 2);
    assert.equal(alpha, 255, `${image.size}`);
    assert.ok(blue > 180 && blue > red + 100 && green > red, `${image.size}: ${[red, green, blue]}`);
    // The logo is white: some pixel of the middle rows is nearly white.
    let brightest = 0;
    for (let y = Math.floor(image.size * 0.4); y < image.size * 0.6; y++) for (let x = 0; x < image.size; x++) brightest = Math.max(brightest, Math.min(...pixel(x, y).slice(0, 3)));
    assert.ok(brightest > 200, `${image.size}: the brightest pixel of the logo is ${brightest}`);
  });
  assert.match(icoProblems(writeIco([{ size: 16, rgba: Buffer.alloc(16 * 16 * 4) }])).join(), /holds 16 pixels, expected 16, 20, 24, 32, 40, 48, 64, 256/);
});

test("the pictures made from the master are there, each of its size; the window's mark is the drawing without the grid", () => {
  const sizes = Object.fromEntries(PICTURES.map(({ file, size }) => [path.relative(path.join(APP_DIR, "..", ".."), file).split(path.sep).join("/"), [size, pngSize(readFileSync(file))]]));
  assert.deepEqual(Object.keys(sizes).sort(), [
    "packages/app/src/assets/app-icon.png",
    "packages/app/src/pages/shell/icon.png",
    "packages/server/legacy-window/icons/emulator-logo-32.png",
    "packages/server/legacy-window/icons/emulator-logo-64.png",
    "public-docs/images/emulator-logo.png",
  ]);
  for (const [name, [size, found]] of Object.entries(sizes)) assert.deepEqual(found, { width: size, height: size }, name);
  assert.equal(readFileSync(LOGO_SVG, "utf8"), logoSvg(parts), "run node tools/app-icon.mjs");
  assert.match(logoSvg(parts), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1080 1080" fill="none">/);
  assert.doesNotMatch(logoSvg(parts), /stroke-opacity|<script|href=|style=/, "no grid, nothing a page's policy refuses");
  assert.throws(() => pngSize(Buffer.from("not a picture, not a picture")), /not a PNG file/);
});

test("the documents show the logo from a file of the repository", () => {
  const root = path.join(APP_DIR, "..", "..");
  // The public repository's README: README.public.md here, exported as README.md (tools/export/export.json).
  const readme = existsSync(path.join(root, "README.public.md")) ? "README.public.md" : "README.md";
  for (const [doc, address] of [[readme, "public-docs/images/emulator-logo.png"], ["public-docs/README.md", "images/emulator-logo.png"]]) {
    const text = readFileSync(path.join(root, ...doc.split("/")), "utf8");
    assert.ok(text.startsWith(`<img src="${address}" width="96" height="96" alt="`), doc);
    assert.ok(existsSync(path.join(root, path.dirname(doc), ...address.split("/"))), `${doc}: ${address}`);
  }
});

// ---------------------------------------------------------------- where a build puts them

test("macOS: Info.plist names the app's icon, and the check knows Electron's own from it", () => {
  assert.equal(appInfoPlist({ CFBundleIconFile: "electron.icns" }, { version: "1.2.3", headerHash: "ab", kind: "release" }).CFBundleIconFile, MAC_ICON_FILE);
  assert.equal(appInfoPlist({}, { version: "1.2.3", headerHash: "ab", kind: "test" }).CFBundleIconFile, "app.icns");
  assert.deepEqual(macIconProblems(ICNS_SOURCE), []);
  assert.match(macIconProblems(path.join(folder, "missing.icns")).join(), /has no app\.icns/);
  // Another icon with every size, as Electron's own is: whole, but not the app's.
  const other = path.join(folder, "other.icns");
  const bytes = Buffer.from(readFileSync(ICNS_SOURCE));
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(other, bytes);
  assert.deepEqual(macIconProblems(other), ["app.icns is not the icon of the source (icon/emulator.icns)"]);
  writeFileSync(other, "icns");
  assert.match(macIconProblems(other).join(), /app\.icns: the icon is not an \.icns file/);
});

test("Windows: the icon goes into an executable's resources in place of the one it has, and is read back by its sizes", async () => {
  const ResEdit = await import("resedit");
  const executable = ResEdit.NtExecutable.createEmpty(false, false);
  const resources = ResEdit.NtExecutableResource.from(executable);
  assert.deepEqual(executableIconSizes(ResEdit, resources), []);
  assert.match(executableIconProblems([], "the executable").join(), /the executable has no icon, expected the app's \(16, 20, 24, 32, 40, 48, 64, 256\)/);
  // An executable with another icon, as Electron's has its own.
  const stock = writeIco([{ size: 16, rgba: Buffer.alloc(16 * 16 * 4, 255) }, { size: 32, rgba: Buffer.alloc(32 * 32 * 4, 255) }]);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 7, 1033, ResEdit.Data.IconFile.from(stock).icons.map((item) => item.data));
  assert.deepEqual(executableIconSizes(ResEdit, resources), [16, 32]);
  assert.match(executableIconProblems([16, 32], "the installer").join(), /the installer has an icon of 16, 32 pixels/);

  setExecutableIcon(ResEdit, resources);
  resources.outputResource(executable);
  const written = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(executable.generate()));
  assert.deepEqual(executableIconSizes(ResEdit, written), [...ICO_SIZES]);
  assert.deepEqual(executableIconProblems(executableIconSizes(ResEdit, written), "the executable"), []);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(written.entries);
  assert.deepEqual(groups.map((group) => group.id), [7], "the icon it had is replaced, not joined by another");
  // The pictures themselves are the file's: 256 pixels as the PNG, byte for byte.
  const items = groups[0].getIconItemsFromEntries(written.entries);
  const ico = readFileSync(ICO_SOURCE);
  const last = readIco(ico).at(-1);
  assert.ok(Buffer.from(items.at(-1).bin).equals(ico.subarray(ico.length - last.bytes)));
});

test("Windows: the setup (which is also the uninstaller) and the command line's entry are compiled with the app's icon", () => {
  const setup = installerArguments("setup-stub.exe", "setup-info.cs");
  assert.ok(setup.includes(`/win32icon:${ICO_SOURCE}`), setup.join(" "));
  assert.ok(setup.some((arg) => arg.startsWith("/win32manifest:")) && setup.includes("/target:winexe") && setup.includes("/platform:x64"));
  assert.equal(setup.filter((arg) => arg.endsWith(".cs")).length, 3, "setup.cs, uninstall.cs and the generated version");
  assert.deepEqual(cSharpArguments("a.cs", "a.exe"), ["/nologo", "/optimize+", "/target:exe", "/out:a.exe", "a.cs"], "a test's stand-in gets no icon");
  assert.deepEqual(cSharpArguments("a.cs", "a.exe", { target: "winexe", icon: "i.ico" }), ["/nologo", "/optimize+", "/target:winexe", "/win32icon:i.ico", "/out:a.exe", "a.cs"]);
  // The launcher asks for the icon; elsewhere than on Windows the build stops before the compiler.
  assert.match(buildWindowsLauncher.toString(), /icon: ICO_SOURCE/);
  assert.equal(path.relative(APP_DIR, ICO_SOURCE).split(path.sep).join("/"), "icon/emulator.ico");
});

// ---------------------------------------------------------------- in the running app

test("the shell's page has its icon, served as a picture by the app's own scheme", async () => {
  const src = path.join(APP_DIR, "src");
  assert.match(readFileSync(path.join(src, "pages", "shell", "message.html"), "utf8"), /<link rel="icon" type="image\/png" href="icon\.png">/);
  assert.equal(resolveAppFile("app://shell/icon.png", src)?.type, "image/png");
  const response = createAppSchemeHandler(src)(new Request("app://shell/icon.png"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(pngSize(Buffer.from(await response.arrayBuffer())), { width: 32, height: 32 });
});
