// BUSY's own interface icons for the device window (legacy-window/icons): every icon is one color in a 24 by 24
// box, the sprite holds each of them as it is in its file, no mark of another company is among them, and busyIcon()
// makes what a page needs. No browser and no emulator: node --test emulator/packages/server/test/busy-icons.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const icons = join(dirname(fileURLToPath(import.meta.url)), "../legacy-window/icons");
// The list: the names by frame of BUSY's set. Here also name by name.
const frames = JSON.parse(readFileSync(join(icons, "busy/index.json"), "utf8"));
const index = Object.fromEntries(Object.entries(frames).flatMap(([frame, list]) => list.map((name) => [name, frame])));
const names = Object.keys(index).sort();
const file = (name) => readFileSync(join(icons, "busy", `${name}.svg`), "utf8");
const ROOT = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 24 24" fill="currentColor">(.+)<\/svg>\n$/;
// The colors an icon may name: its one color, none, and a badge's, which is the icon's color unless the page
// sets --bi-accent.
const COLORS = ["currentColor", "none", "var(--bi-accent, currentColor)"];

test("the list and the files are the same icons, a few hundred of them, each from a frame of BUSY's set", () => {
  const files = readdirSync(join(icons, "busy")).filter((name) => name.endsWith(".svg")).map((name) => name.slice(0, -4)).sort();
  assert.deepEqual(files, names);
  assert.equal(Object.values(frames).flat().length, names.length, "no name is in the list twice");
  for (const [frame, list] of Object.entries(frames)) assert.deepEqual(list, [...list].sort(), `${frame} is in the alphabet's order`);
  assert.ok(names.length >= 280, `icons: ${names.length}`);
  for (const name of names) assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/, name);
  for (const name of ["refresh", "wifi-4", "usb", "battery-3", "control-play", "control-stop", "trash", "chevron-left", "chevron-right", "settings", "busy-bar"]) assert.ok(name in index, name);
  assert.equal(index.refresh, "various");
  assert.equal(index["wifi-4"], "wi-fi");
});

test("no mark of another company is in the set", () => {
  for (const [name, frame] of Object.entries(index)) {
    assert.ok(!["logos", "social"].includes(frame), `${name} is from the frame ${frame}`);
    assert.doesNotMatch(name, /^logo-|-logo$|google|slack|microsoft|matter|home-assistant|discord|reddit|instagram|tiktok|youtube/, name);
  }
  assert.doesNotMatch(readFileSync(join(icons, "busy-sprite.svg"), "utf8"), /id="bi-logo-/);
});

test("every icon is one line: a 24 by 24 box, no size, no ids, no styles, no color but the text's", () => {
  for (const name of names) {
    const inner = file(name).match(ROOT)?.[1];
    assert.ok(inner, `${name}.svg has the root every icon has`);
    assert.doesNotMatch(inner, /\s(id|style|class|clip-path|transform|href|xlink:href)=|<(script|style|image|use|foreignObject|defs|clipPath|mask|filter)\b/, name);
    for (const [, color] of inner.matchAll(/\s(?:fill|stroke)="([^"]*)"/g)) assert.ok(COLORS.includes(color), `${name}.svg: the color ${color}`);
    assert.doesNotMatch(inner, /#[0-9a-fA-F]{3,8}\b|rgb\(|white|black/, `${name}.svg names a color`);
    assert.match(inner, /<(path|rect|circle)\b/, `${name}.svg draws something`);
    // What is drawn is in the box: every number of the path data is between a little before 0 and a little past 24.
    for (const [, d] of inner.matchAll(/\sd="([^"]*)"/g)) {
      for (const n of d.match(/-?\d*\.?\d+/g).map(Number)) assert.ok(n >= -1 && n <= 25, `${name}.svg: ${n} is outside the box`);
    }
  }
});

test("the sprite holds every icon as its file has it, under bi-<name>, and nothing else", () => {
  const sprite = readFileSync(join(icons, "busy-sprite.svg"), "utf8");
  const symbols = [...sprite.matchAll(/<symbol id="bi-([\w-]+)" viewBox="0 0 24 24" fill="currentColor">(.+)<\/symbol>/g)];
  assert.deepEqual(symbols.map((m) => m[1]), names);
  for (const [, name, inner] of symbols) assert.equal(inner, file(name).match(ROOT)[1], name);
  assert.equal(sprite, `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.map((m) => m[0]).join("\n")}\n</svg>\n`, "run node emulator/tools/busy-icons/build.mjs");
});

// ---------------------------------------------------------------- busyIcon()

function page() {
  const made = (tag) => ({ tag, attrs: {}, children: [], setAttribute(name, value) { this.attrs[name] = String(value); }, append(child) { this.children.push(child); } });
  const asked = [];
  const sandbox = {
    document: { createElementNS: (ns, tag) => ({ ns, ...made(tag) }) },
    fetch: async (address) => (asked.push(address), { json: async () => frames }),
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(icons, "busy.js"), "utf8"), sandbox, { filename: "busy.js" });
  return { busyIcon: sandbox.busyIcon, asked };
}

test("busyIcon() makes an <svg> as large as the text, in its color, hidden from screen readers, that points into the sprite", () => {
  const { busyIcon } = page();
  const svg = busyIcon("refresh");
  assert.equal(svg.tag, "svg");
  assert.equal(svg.ns, "http://www.w3.org/2000/svg");
  assert.deepEqual(svg.attrs, { class: "bi bi-refresh", viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "currentColor", focusable: "false", "aria-hidden": "true" });
  assert.deepEqual(svg.children.map((c) => [c.tag, c.attrs]), [["use", { href: "/emulator/icons/busy-sprite.svg#bi-refresh" }]]);

  const sized = busyIcon("alert", { size: 20, label: "Warning" });
  assert.equal(sized.attrs.width, "20px");
  assert.equal(sized.attrs.height, "20px");
  assert.equal(sized.attrs.role, "img");
  assert.equal(sized.attrs["aria-label"], "Warning");
  assert.ok(!("aria-hidden" in sized.attrs));
});

test("busyIcon.html() is the same as a string, with what it is given written safely", () => {
  const { busyIcon } = page();
  assert.equal(busyIcon.html("usb"), '<svg class="bi bi-usb" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" focusable="false" aria-hidden="true"><use href="/emulator/icons/busy-sprite.svg#bi-usb"/></svg>');
  assert.match(busyIcon.html("alert", { size: "1.5em", label: 'A "b" <c>' }), / width="1\.5em" height="1\.5em" .* role="img" aria-label="A &quot;b&quot; &lt;c&gt;"><use /);
});

test("a name that could not be an icon's is refused, not written into the page", () => {
  const { busyIcon } = page();
  for (const name of ['x"><script>', "../window", "", "Refresh", undefined]) {
    assert.throws(() => busyIcon(name), /is not an icon's name/, String(name));
    assert.throws(() => busyIcon.html(name), /is not an icon's name/, String(name));
  }
});

test("busyIcon.names() and busyIcon.frames() read the list once", async () => {
  const { busyIcon, asked } = page();
  assert.deepEqual([...(await busyIcon.names())], names);
  assert.deepEqual(Object.keys(await busyIcon.frames()), Object.keys(frames));
  await busyIcon.names();
  assert.deepEqual(asked, ["/emulator/icons/busy/index.json"]);
});

test("the files a page asks for by busyIcon's addresses are there", () => {
  const { busyIcon } = page();
  assert.equal(busyIcon.sprite, "/emulator/icons/busy-sprite.svg");
  assert.ok(readFileSync(join(icons, "..", busyIcon.sprite.slice("/emulator/".length))).length > 10000);
});
