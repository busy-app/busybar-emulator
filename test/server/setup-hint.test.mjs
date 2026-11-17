// Firmware 1.4.1's SETUP screen on the BUSY Bar edits numbers, switches and lists with the wheel; for a setting it
// cannot edit (a string, a color, a time) OK opens a hint, "Set up via http://10.0.4.20", the bar's USB address
// (js_app_launcher_scene_web_setup.c, 0a11d1f9). In the emulator the hint names the address the emulated bar answers
// on, as the empty APPS screen does (patches.mjs), and its arrow is the firmware's image back_arrow_front_7x7, which
// 1.4.1 added to the app assets (apps-assets.json, "since": a 1.3.1 BUSY Bar does not have it, and neither does the
// emulated one on 1.3.1). Without the image LVGL draws a magenta cross in its place.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { appsAssets } from "../../packages/server/firmware.mjs";
import { startServer } from "../../packages/server/server.mjs";
import { targz } from "../package.mjs";
import { finish, get, port, request, tempDir, until } from "./helpers.mjs";

test.after(finish);

const ID = "app.test.hint";
const SETTINGS = { format_version: 1, version: 1, fields: { title: { type: "string", label: "Title", default: "hello" } } };
const ARROW = "shared/images/back_arrow_front_7x7.image";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The arrow's pixels, from the image the firmware's converter made of its PNG (apps-assets.json): LVGL's I1 format, a
 * 12-byte header (magic 0x19, color format 0x07, width, height, stride), a palette of two colors, then a bit per pixel
 * from the most significant one. bits[y][x]: whether the pixel is the opaque color.
 */
function arrowBits() {
  const image = readFileSync(`${appsAssets}/${ARROW}`);
  assert.deepEqual([image[0], image[1], image.readUInt16LE(4), image.readUInt16LE(6), image.readUInt16LE(8)], [0x19, 0x07, 7, 7, 1], "an I1 image of 7 by 7");
  // The palette: index 0 transparent, index 1 opaque.
  assert.deepEqual([image[15], image[19]], [0x00, 0xff]);
  return [...image.subarray(20, 27)].map((row) => Array.from({ length: 7 }, (_, x) => Boolean(row & (0x80 >> x))));
}

/** Pixel (x, y) of the front display (BGR888, 72×16) is lit. */
const litAt = (front, x, y) => Boolean(front[(y * 72 + x) * 3] | front[(y * 72 + x) * 3 + 1] | front[(y * 72 + x) * 3 + 2]);

/** The places in the front display's columns from..71 where a 7×7 window is lit exactly where the arrow is. */
function arrowsIn(front, from) {
  const bits = arrowBits();
  const found = [];
  for (let oy = 0; oy <= 16 - 7; oy++) {
    for (let ox = from; ox <= 72 - 7; ox++) {
      if (bits.every((row, y) => row.every((bit, x) => bit === litAt(front, ox + x, oy + y)))) found.push([ox, oy]);
    }
  }
  return found;
}

/** Magenta pixels of the front display: LVGL's mark of an image it could not open. */
function magenta(front) {
  let n = 0;
  for (let i = 0; i < front.length; i += 3) if (front[i] > 150 && front[i + 2] > 150 && front[i + 1] < 100) n++;
  return n;
}

/** The pixels in which two frames of a display differ, as [x, y]: front BGR888 72×16, back 4 bits 160×80. */
function differ(a, b, display) {
  const out = [];
  if (display === "front") {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 72; x++) if (a.compare(b, (y * 72 + x) * 3, (y * 72 + x) * 3 + 3, (y * 72 + x) * 3, (y * 72 + x) * 3 + 3) !== 0) out.push([x, y]);
  } else {
    const at = (f, i) => (f[i >> 1] >> ((i & 1) * 4)) & 15;
    for (let y = 0; y < 80; y++) for (let x = 0; x < 160; x++) if (at(a, y * 160 + x) !== at(b, y * 160 + x)) out.push([x, y]);
  }
  return out;
}

/** The two frames of the hint on a 1.4.1 emulator on port `onPort` (0: a free one): the app's card, Setup, its first item. */
async function hint(t, onPort) {
  const server = await startServer({ port: onPort, dataDir: tempDir(t), firmware: "1.4.1", barSpeed: false, log: () => {} });
  try {
    const files = { [`${ID}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id: ID, name: "Hint", version: "0.1.0", api_version: "27.14.0" }), [`${ID}/appmeta/settings.json`]: JSON.stringify(SETTINGS), [`${ID}/scripts/main.js`]: "setInterval(function () {}, 1000);" };
    const staged = await request("POST", `${server.url}/api/apps/stage`, targz(files));
    assert.equal((await request("POST", `${server.url}/api/apps/install?install_key=${staged.json().install_key}`)).status, 200);
    // Started once and quit: APPS then opens on the app's card.
    await request("POST", `${server.url}/api/apps/launch?app_id=${ID}`);
    await until("the app to run", async () => (await get(`${server.url}/_emu/state`)).json().running?.id === ID);
    await request("POST", `${server.url}/api/apps/quit`);
    await until("the app to stop", async () => (await get(`${server.url}/_emu/state`)).json().running === null);
    await sleep(1000);
    // OK opens the card, the wheel up goes to Setup, OK opens SETUP, OK on the string opens the hint.
    for (const key of ["ok", "up", "ok", "ok"]) {
      assert.equal((await request("POST", `${server.url}/api/input?key=${key}`)).status, 200);
      await sleep(700);
    }
    const frame = async (display) => Buffer.from((await get(`${server.url}/api/screen?display=${display}`)).text, "base64");
    // Until the hint stands: the arrow, or the cross in its place, at the front's right edge.
    const front = await until("the hint on the front display", async () => {
      const f = await frame(0);
      return arrowsIn(f, 56).length || magenta(f) ? f : null;
    });
    return { port: server.port, front, back: await frame(1) };
  } finally {
    await server.stop();
  }
}

test("1.4.1: the SETUP hint draws the firmware's arrow and names this emulator's address, not the BUSY Bar's USB address", { timeout: 90_000 }, async (t) => {
  const first = await hint(t, port(0));
  const again = await hint(t, first.port);
  const other = await hint(t, port(0) ? port(1) : 0);
  assert.notEqual(first.port, other.port);
  for (const one of [first, again, other]) {
    assert.equal(magenta(one.front), 0, `port ${one.port}: no magenta cross on the front display`);
    // The arrow, pixel for pixel the firmware's image, once, at the front's right edge.
    assert.equal(arrowsIn(one.front, 56).length, 1, `port ${one.port}: the arrow is drawn once, as the image has it`);
  }
  // The same address draws the same frames.
  assert.ok(first.front.equals(again.front) && first.back.equals(again.back), "the same port draws the same hint");
  // Another port: only the address differs. On the front that is the second line, left of the arrow (the icon, "Set
  // up via" and the arrow stay); on the back the line under "Set up via", left of the status bar.
  const front = differ(first.front, other.front, "front");
  const back = differ(first.back, other.back, "back");
  assert.ok(front.length > 0 && back.length > 0, "the port in use is shown on both displays");
  assert.deepEqual(front.filter(([x, y]) => y < 9 || x >= 63), [], "only the front's address line differs");
  assert.deepEqual(back.filter(([x, y]) => y < 53 || y > 66 || x >= 148), [], "only the back's address line differs");
});

test("the arrow is 1.4.1's: the emulated BUSY Bar on 1.3.1 has no such file, as a 1.3.1 BUSY Bar has not", { timeout: 60_000 }, async (t) => {
  for (const [n, firmware] of [[0, "1.4.1"], [1, "1.3.1"]]) {
    const server = await startServer({ port: port(n), dataDir: tempDir(t), firmware, barSpeed: false, log: () => {} });
    try {
      const read = (file) => get(`${server.url}/api/storage/read?path=/ext/apps_assets/${file}`);
      // An image both have, and the arrow.
      assert.equal((await read("shared/images/info_front_8x8.image")).status, 200, firmware);
      assert.equal((await read(ARROW)).status, firmware === "1.4.1" ? 200 : 400, firmware);
      // display/draw takes a stock image from /ext/apps_assets/shared (api_display.c, the same in both).
      const drawn = await request("POST", `${server.url}/api/display/draw`, Buffer.from(JSON.stringify({ application_name: "p", elements: [{ id: "i", type: "image", stock_path: "images/back_arrow_front_7x7.image", x: 10, y: 4, display: "front" }] })));
      if (firmware === "1.4.1") {
        assert.equal(drawn.status, 200, drawn.text);
        const front = await until("the drawing", async () => {
          const f = Buffer.from((await get(`${server.url}/api/screen?display=0`)).text, "base64");
          return arrowsIn(f, 0).length ? f : null;
        });
        assert.deepEqual(arrowsIn(front, 0), [[10, 4]]);
      } else {
        assert.deepEqual([drawn.status, drawn.json()], [400, { error: `elements[0]: failed to decode image /ext/apps_assets/${ARROW}` }]);
      }
    } finally {
      await server.stop();
    }
  }
});
