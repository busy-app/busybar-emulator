// The APPS screen with no apps names the address the emulated bar answers on, not the USB address of a real one
// (patches.mjs, apps_menu_scene_empty.c; host_bar_address in native/emu_system.c). The firmware's own text stays when
// the host has no address. Both firmware versions, the screen module as committed.
//
//   node --test "emulator/packages/**/*.test.mjs"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { patches } from "../engine/patches.mjs";
import { loadFirmware } from "./firmware.mjs";
import { InputKey, InputType } from "./runtime.mjs";
import { Screen } from "./screen.mjs";

const T0 = 1_700_000_000_000;

/** The back and front frames of the APPS screen with no apps, on a computer whose clock is the test's. */
async function emptyApps(firmware, barAddress) {
  const c = { t: T0, pending: null };
  const screen = await Screen.create({
    firmware,
    readFile: () => null,
    writeFile: () => true,
    listDir: () => [],
    remove: () => true,
    onAppStart: () => {},
    onAppAbort: () => {},
    onLog: () => {},
    barSpeed: false,
    ...(barAddress === undefined ? {} : { barAddress: () => barAddress }),
    clockHost: {
      computer: () => Math.floor(c.t),
      setTimer: (fn, ms) => (c.pending = { fn, at: c.t + Math.max(ms, 1) }),
      clearTimer: (handle) => c.pending === handle && (c.pending = null),
    },
  });
  const pass = (ms) => {
    const end = c.t + ms;
    while (c.pending && c.pending.at <= end) {
      const { fn, at } = c.pending;
      c.pending = null;
      c.t = Math.max(c.t, at);
      fn();
    }
    c.t = end;
  };
  try {
    // The bar starts on APPS (the boot animation, then the selector's program); OK opens its list, empty here.
    pass(3000);
    screen.input(InputKey.ok, InputType.press);
    screen.input(InputKey.ok, InputType.short);
    screen.input(InputKey.ok, InputType.release);
    pass(1500);
    screen.sync();
    return { back: Buffer.from(screen.frame(1)), front: Buffer.from(screen.frame(0)) };
  } finally {
    screen.dispose();
  }
}

/** The back display's pixels (4 bits each, two a byte) in columns from..to, rows 40..79: where the text stands. */
function lit(back, from, to) {
  let count = 0;
  for (let y = 40; y < 80; y++) for (let x = from; x < to; x++) if ((back[(y * 160 + x) >> 1] >> ((y * 160 + x) & 1 ? 4 : 0)) & 15) count++;
  return count;
}

test("the patch replaces both of the firmware's texts and keeps them for a host without an address", () => {
  const edits = patches["applications/main/apps_menu/scenes/apps_menu_scene_empty.c"];
  assert.ok(edits, "patches.mjs edits the empty APPS scene");
  const replaced = edits.map(([find]) => find).join("\n");
  assert.match(replaced, /No apps yet, go to\\nhttp:\/\/10\.0\.4\.20/);
  assert.match(replaced, /No apps yet\. Add via http:\/\/10\.0\.4\.20/);
  const added = edits.map(([, replace]) => replace).join("\n");
  assert.match(added, /host_bar_address\(\)/);
  // Without an address the firmware's own words, byte for byte.
  assert.match(added, /"No apps yet, go to\\nhttp:\/\/10\.0\.4\.20"/);
  assert.match(added, /"No apps yet\. Add via http:\/\/10\.0\.4\.20"/);
});

for (const name of ["1.3.1", "dev"]) {
  test(`firmware ${name}: the APPS screen with no apps shows the emulator's address, inside the back display's text area`, async () => {
    const firmware = loadFirmware(name);
    assert.match(readFileSync(join(firmware.dir, "screen.mjs"), "utf8"), /Module\.host\.barAddress/, "the screen module asks the host for the address");
    const own = await emptyApps(firmware, undefined);
    const at8640 = await emptyApps(firmware, "http://127.0.0.1:8640");
    const at18930 = await emptyApps(firmware, "http://127.0.0.1:18930");
    const again = await emptyApps(firmware, "http://127.0.0.1:8640");
    assert.ok(lit(own.back, 0, 148) > 0 && lit(at8640.back, 0, 148) > 0, "a text is drawn");
    assert.ok(!own.back.equals(at8640.back), "the back display does not show the firmware's 10.0.4.20");
    assert.ok(!own.front.equals(at8640.front), "nor does the front");
    assert.ok(!at8640.back.equals(at18930.back) && !at8640.front.equals(at18930.front), "the port in use is the one shown");
    assert.ok(at8640.back.equals(again.back) && at8640.front.equals(again.front), "the same address draws the same frames");
    // The longest address there is (a five-digit port) stays left of the status bar (12 px at the right edge): the
    // text area's last columns before it are as dark as with the firmware's shorter address.
    assert.equal(lit(at18930.back, 146, 148), lit(own.back, 146, 148));
  });
}
