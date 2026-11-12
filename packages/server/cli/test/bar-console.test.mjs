// What a line of the bar's log says about an app (bar-console.mjs appEvent), on the lines device.mjs writes.
import assert from "node:assert/strict";
import { test } from "node:test";

import { appEvent, engineFailed } from "../bar-console.mjs";

const ID = "app.me.clock";
const line = (kind, text) => ({ kind, text, time: 0 });

test("the app's console, the runtime's errors, the bar's words about the app, its start and its end", () => {
  assert.deepEqual(appEvent(line("log", `${ID} log: hello`), ID), { event: "app_log", level: "log", text: "hello" });
  assert.deepEqual(appEvent(line("info", `${ID} info: a: b`), ID), { event: "app_log", level: "info", text: "a: b" });
  assert.deepEqual(appEvent(line("error", `${ID} error: failed`), ID), { event: "app_error", text: "failed" });
  assert.deepEqual(appEvent(line("error", `${ID} [JsRunner] Error running script: ReferenceError: draw is not defined`), ID), { event: "app_error", text: "[JsRunner] Error running script: ReferenceError: draw is not defined" });
  assert.deepEqual(appEvent(line("warn", `${ID} [JsRunner] slow`), ID), { event: "app_log", level: "warn", text: "[JsRunner] slow" });
  assert.deepEqual(appEvent(line("app", `Launch ${ID} (heap 96 KiB)`), ID), { event: "app_launched" });
  assert.deepEqual(appEvent(line("app", `App ${ID} exited: finished; heap peak 12.1 of 96 KiB`), ID), { event: "app_exited", reason: "finished", crashed: false });
  assert.deepEqual(appEvent(line("app", `App ${ID} exited: quit; heap peak 12.1 of 96 KiB`), ID), { event: "app_exited", reason: "quit", crashed: false });
  assert.deepEqual(appEvent(line("app", `App ${ID} exited: error parsing main.js: SyntaxError: Unexpected token; heap peak 1.0 of 96 KiB`), ID), {
    event: "app_exited",
    reason: "error parsing main.js: SyntaxError: Unexpected token",
    crashed: true,
  });
  const overflow = appEvent(line("error", `App ${ID}: JS heap overflow: the supervisor takes over, as on a bar`), ID);
  assert.deepEqual(overflow, { event: "app_error", text: "JS heap overflow: the supervisor takes over, as on a bar" });
  assert.equal(engineFailed(overflow.text), true);
  assert.equal(engineFailed("failed"), false);
  assert.deepEqual(appEvent(line("warn", `App ${ID}: its request to http://127.0.0.1:3000 was refused`), ID), { event: "app_log", level: "warn", text: "its request to http://127.0.0.1:3000 was refused" });
});

test("lines about another app, about the bar, and the loop's own replacing of the app are not the app's", () => {
  assert.equal(appEvent(line("log", "app.me.clock2 log: hello"), ID), null);
  assert.equal(appEvent(line("app", "App app.other exited: finished; heap peak 1 of 96 KiB"), ID), null);
  assert.equal(appEvent(line("app", `Installed ${ID} 0.1.0`), ID), null);
  assert.equal(appEvent(line("warn", `App ${ID} was running; quitting it before install (on the bar, stop the app first)`), ID), null);
  assert.equal(appEvent(line("system", "The bar restarts (asked)"), ID), null);
});
