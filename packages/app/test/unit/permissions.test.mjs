import assert from "node:assert/strict";
import { test } from "node:test";

import { permissionAllowed, WINDOW_PERMISSIONS } from "../../src/permissions.mjs";

test("the list is exactly: the device window and the local web write to the clipboard, the message page gets nothing", () => {
  assert.deepEqual(WINDOW_PERMISSIONS, { device: ["clipboard-sanitized-write"], "local-web": ["clipboard-sanitized-write"], message: [] });
});

test("everything else is refused, and so is a window of no known kind", () => {
  assert.equal(permissionAllowed("device", "clipboard-sanitized-write"), true);
  for (const permission of ["clipboard-read", "media", "geolocation", "notifications", "midi", "openExternal", "fullscreen", "pointerLock", "hid", "serial", "usb", "display-capture"]) {
    assert.equal(permissionAllowed("device", permission), false, permission);
    assert.equal(permissionAllowed("message", permission), false, permission);
    assert.equal(permissionAllowed("local-web", permission), false, permission);
  }
  assert.equal(permissionAllowed("message", "clipboard-sanitized-write"), false);
  assert.equal(permissionAllowed(null, "clipboard-sanitized-write"), false);
  assert.equal(permissionAllowed("constructor", "clipboard-sanitized-write"), false);
  assert.equal(permissionAllowed("__proto__", "clipboard-sanitized-write"), false);
});
