import assert from "node:assert/strict";
import { test } from "node:test";

import { messageFor } from "../../src/messages.mjs";

const config = { logFile: "/data/logs/shell.log", startTimeoutMs: 30_000 };
const all = [
  { name: "move-app", reason: "translocated", path: "/somewhere/BUSY Bar Emulator.app" },
  { name: "move-app", reason: "read-only-volume", path: "/somewhere/BUSY Bar Emulator.app" },
  { name: "move-app", reason: "downloads", path: "/somewhere/BUSY Bar Emulator.app" },
  { name: "port-busy", port: 8640 },
  { name: "port-busy", port: 8640, reserved: true },
  { name: "failed", detail: "exit code 1: boom" },
  { name: "failed", cause: "no-node", detail: "Node was not found at /x" },
  { name: "failed", cause: "no-server", detail: "The server was not found at /x" },
  { name: "failed", cause: "no-answer", detail: "no answer in 30 s" },
  { name: "failed", cause: "refused", detail: "The data folder is in use" },
  { name: "failed", cause: "ended", detail: "exit code 5" },
  { name: "gave-up", deaths: 3, withinMs: 60_000, detail: "exit code 3" },
  { name: "starting" },
  { name: "starting", slow: true },
];

test("every message has a title and a text in the product's voice", () => {
  for (const state of all) {
    const message = messageFor(state, config);
    assert.ok(message.title && message.text, state.name);
    for (const text of [message.title, message.text]) {
      assert.doesNotMatch(text, /!|please|oops|undefined|null/i, text);
      assert.match(text, /^[A-Z]/, text);
    }
  }
});

test("the port in use is named, with what to do", () => {
  const message = messageFor({ name: "port-busy", port: 8640 }, config);
  assert.equal(message.title, "Port 8640 is in use");
  assert.match(message.text, /127\.0\.0\.1:8640/);
  assert.deepEqual(message.actions, ["retry", "quit"]);
});

test("a port the system keeps back is named as reserved, with the next step", () => {
  const message = messageFor({ name: "port-busy", port: 8640, reserved: true }, config);
  assert.equal(message.title, "Port 8640 is not available");
  assert.match(message.text, /reserved/);
  assert.match(message.text, /excludedportrange/);
  assert.deepEqual(message.actions, ["retry", "quit"]);
});

test("a failed start and a server that keeps stopping say where the log is", () => {
  const failed = messageFor({ name: "failed", detail: "exit code 1: boom" }, config);
  assert.match(failed.text, /The log is at \/data\/logs\/shell\.log/);
  assert.equal(failed.detail, "exit code 1: boom");
  const gaveUp = messageFor({ name: "gave-up", deaths: 3, withinMs: 60_000, detail: "exit code 3" }, config);
  assert.match(gaveUp.text, /stopped 3 times within 60 s/);
  assert.match(gaveUp.text, /The log is at \/data\/logs\/shell\.log/);
  assert.deepEqual(gaveUp.actions, ["retry", "quit"]);
});

test("an app that must move can only be quit, and is told where it is", () => {
  for (const reason of ["translocated", "read-only-volume", "downloads"]) {
    const message = messageFor({ name: "move-app", reason, path: "/somewhere/BUSY Bar Emulator.app" }, config);
    assert.equal(message.title, "Move BUSY Bar Emulator to Applications");
    assert.match(message.text, /drag BUSY Bar Emulator to the Applications folder/);
    assert.equal(message.detail, "/somewhere/BUSY Bar Emulator.app");
    assert.deepEqual(message.actions, ["quit"]);
  }
});

test("a failed start says what happened: only a server that ended says it stopped before it was ready", () => {
  const text = (cause) => messageFor({ name: "failed", cause, detail: "d" }, config).text;
  assert.match(text("ended"), /stopped before it was ready/);
  assert.match(text(undefined), /stopped before it was ready/);
  for (const cause of ["no-node", "no-server", "no-answer", "refused"]) assert.doesNotMatch(text(cause), /stopped before it was ready/, cause);
  assert.match(text("no-node"), /could not find the Node/);
  assert.match(text("no-server"), /could not find the emulator server/);
  assert.match(text("no-answer"), /did not answer within 30 s, so it was stopped/);
  assert.match(text("refused"), /could not start; what it said is below/);
  for (const cause of ["no-node", "no-server", "no-answer", "refused", "ended"]) assert.match(text(cause), /The log is at \/data\/logs\/shell\.log/, cause);
});

test("a missing part cannot be tried again: the app must be installed again", () => {
  for (const cause of ["no-node", "no-server"]) {
    const message = messageFor({ name: "failed", cause, detail: "d" }, config);
    assert.deepEqual(message.actions, ["quit"], cause);
    assert.match(message.text, /Install it again/);
  }
  assert.deepEqual(messageFor({ name: "failed", cause: "no-answer" }, config).actions, ["retry", "quit"]);
});

test("the starting page says how long the wait may be, and the app can be quit from it", () => {
  const message = messageFor({ name: "starting", slow: true }, config);
  assert.equal(message.title, "Starting the emulator");
  assert.match(message.text, /within 30 s/);
  assert.deepEqual(message.actions, ["quit"]);
});
