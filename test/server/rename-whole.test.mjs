// A file in the way that an antivirus, the indexer or OneDrive holds for a moment must not fail the start of the
// server on Windows: the key and the format record are moved into place with retries (data-folder.mjs, renameWhole).
import assert from "node:assert/strict";
import { test } from "node:test";

import { renameWhole } from "../../packages/server/data-folder.mjs";

function onPlatform(name, action) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: name });
  try {
    return action();
  } finally {
    Object.defineProperty(process, "platform", real);
  }
}
const busy = (code) => Object.assign(new Error(code), { code });

test("on Windows a rename refused as EPERM or EBUSY is tried again until it goes through", () => {
  let calls = 0;
  onPlatform("win32", () =>
    renameWhole("a", "b", () => {
      calls += 1;
      if (calls === 1) throw busy("EPERM");
      if (calls === 2) throw busy("EBUSY");
    }),
  );
  assert.equal(calls, 3);
});

test("a lasting refusal still ends in the error, and a refusal that is not a busy file is not tried again", () => {
  let calls = 0;
  assert.throws(() => onPlatform("win32", () => renameWhole("a", "b", () => ((calls += 1), (() => { throw busy("EPERM"); })()))), { code: "EPERM" });
  assert.equal(calls, 10);
  calls = 0;
  assert.throws(() => onPlatform("win32", () => renameWhole("a", "b", () => ((calls += 1), (() => { throw busy("ENOENT"); })()))), { code: "ENOENT" });
  assert.equal(calls, 1);
});
