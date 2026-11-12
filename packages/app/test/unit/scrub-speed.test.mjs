// The scrubber reads every line of a log and a bug report's text, so no pattern may take more than linear time on an
// adversarial text: long runs of separators, dots, repeated names, mixed separators. Each input is 10 000 characters or
// more and must be scrubbed in under 200 ms of CPU time (the pattern that took 19 s on 40 backslashes would not finish).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createScrubber } from "../../src/scrub.mjs";

// Made up, and put together at run time: the export check keeps the shapes of real paths out of the repository's files.
const win = (...names) => ["C:", ...names].join("\\");
const unix = (...names) => ["", ...names].join("/");
const HOME = win("Users", "Alex");
const TEMP = win("Users", "Alex", "AppData", "Local", "Temp");
const MAC_TEMP = unix("var", "folders", "ab", "cdef", "T");
const PROJECT = ["D:", "Work", "Project"].join("\\");
const MOUNT = unix("Volumes", "x");

const scrub = createScrubber({
  home: HOME,
  user: "Alex",
  host: "DESKTOP-TEST01",
  wifi: ["Kitchen Router 5G"],
  temp: [TEMP, MAC_TEMP, unix("private") + MAC_TEMP],
  logins: ["octo-person"],
  projects: [PROJECT, unix("Volumes", "ssd", "Busy")],
});

const N = 10_000;
const INPUTS = {
  backslashes: "\\".repeat(N),
  slashes: "/".repeat(N),
  dots: ".".repeat(N),
  "a-backslash-a": "a\\".repeat(N / 2),
  "a-slash-a": "a/".repeat(N / 2),
  "mixed separators": "\\/".repeat(N / 2),
  "temp then backslashes": TEMP + "\\".repeat(N),
  "temp then slashes": MAC_TEMP + "/".repeat(N),
  "home then mixed": HOME + "\\/".repeat(N / 2) + "!",
  "home repeated": (HOME + "\\").repeat(N / 12),
  "drive and names": "E:" + "\\a b".repeat(N / 4),
  "drive, spaces": "E:\\" + " ".repeat(N),
  "mounted names": MOUNT + "/a b".repeat(N / 4),
  "mounted spaces": MOUNT + "/" + "a ".repeat(N / 2),
  "project then names": PROJECT + "\\a b".repeat(N / 4) + '"',
  "query params": "?" + "a=b&".repeat(N / 4),
  "long hex": "0".repeat(N),
  "long word": "a".repeat(N),
  "field names": "token".repeat(N / 5) + "=",
  "field names with dashes": "a-".repeat(N / 2) + "token: ",
  quotes: '"'.repeat(N),
  "unterminated quote value": 'password="' + "\\a".repeat(N / 2),
  "at signs": "a.".repeat(N / 2) + "@",
  "email-like": "a-".repeat(N / 2) + "@b",
  urls: "http://".repeat(N / 7),
  "user and password": ["http", ""].join("://") + "a:".repeat(N / 2),
  authorization: "authorization: " + " ".repeat(N),
};

for (const [name, text] of Object.entries(INPUTS)) {
  test(`scrubbing ${name} (${text.length} characters) takes under 200 ms`, () => {
    // CPU time of this process, not the clock: on a loaded machine (the gate runs beside others) the clock counts the
    // time the process waited for its turn.
    const from = process.cpuUsage();
    const out = scrub(text);
    const used = process.cpuUsage(from);
    const ms = (used.user + used.system) / 1000;
    assert.equal(typeof out, "string");
    assert.ok(ms < 200, `${name}: ${ms.toFixed(0)} ms`);
  });
}
