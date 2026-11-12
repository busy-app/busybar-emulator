// Whether two paths are one (same-path.mjs): the one helper the project lists, the trusted folders, the removal of a
// project, uninstall and the command line share.
//
//   node --test emulator/packages/server/test/same-path.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { samePath as cliSamePath } from "../cli/system.mjs";
import { samePath, sameRealPath } from "../same-path.mjs";

test("paths as written: letter case aside on Windows only; by real path for the command line", () => {
  const win = (...parts) => path.win32.join(...parts);
  assert.equal(samePath(win("D:", "Work", "Clock"), win("d:", "work", "clock"), "win32"), true);
  assert.equal(samePath(["D:", "Work", "Clock"].join("/"), win("d:", "work", "clock"), "win32"), true, "either separator");
  assert.equal(samePath("/opt/work/Clock", "/opt/work/clock", "darwin"), false);
  assert.equal(samePath("/opt/work/clock", "/opt/work/clock", "linux"), true);
  assert.equal(cliSamePath, sameRealPath);
  assert.equal(sameRealPath(process.cwd(), `${process.cwd()}${path.sep}.`), true, "the real path decides");
});
