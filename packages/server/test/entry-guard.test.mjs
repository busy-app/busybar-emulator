// The entry guard's word on a request (ADR-0012 sections 1 and 2), without a server: Host, Origin, CORS.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createEntryGuard, normalizeOrigin } from "../entry-guard.mjs";

const BAR = { kind: "bar", port: 8691 };
const CONTROL = { kind: "control", port: 8692 };

/** A request as Node gives it to the server: its line and its raw headers, in pairs. */
const request = (headers, url = "/api/version", method = "GET") => ({ method, url, rawHeaders: Object.entries(headers).flat() });
const raw = (pairs, url = "/api/version") => ({ method: "GET", url, rawHeaders: pairs.flat() });

test("Host: only this address, by 127.0.0.1 or localhost and its own port, once", () => {
  const { admit } = createEntryGuard();
  for (const host of ["127.0.0.1:8691", "localhost:8691", "LOCALHOST:8691"]) assert.equal(admit(BAR, request({ Host: host })).ok, true, host);
  const refused = [
    "evil.example:8691", // DNS rebinding: somebody's name, made to point at 127.0.0.1
    "evil.example",
    "127.0.0.1", // no port
    "localhost",
    "127.0.0.1:8692", // the other address's port
    "127.0.0.1:80",
    "127.0.0.2:8691", // another loopback address
    "0.0.0.0:8691",
    "[::1]:8691",
    "localhost.:8691",
    "127.0.0.1:8691.evil.example",
    "",
  ];
  for (const host of refused) {
    const verdict = admit(BAR, request({ Host: host }));
    assert.equal(verdict.ok, false, host);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.reason, "host");
    assert.match(verdict.error, /^Forbidden: the request was not addressed to this emulator/);
  }
  assert.equal(admit(BAR, request({})).reason, "host", "no Host at all");
  assert.equal(admit(BAR, raw([["Host", "127.0.0.1:8691"], ["host", "127.0.0.1:8691"]])).reason, "host", "Host twice");
  assert.equal(admit(BAR, raw([["Host", "evil.example"], ["Host", "127.0.0.1:8691"]])).reason, "host", "Host twice, the second one ours");
  // The management address has a Host of its own.
  assert.equal(admit(CONTROL, request({ Host: "127.0.0.1:8692" })).ok, true);
  assert.equal(admit(CONTROL, request({ Host: "127.0.0.1:8691" })).reason, "host");
});

test("a request line in absolute form must name this address too", () => {
  const { admit } = createEntryGuard();
  assert.equal(admit(BAR, request({ Host: "127.0.0.1:8691" }, "http://127.0.0.1:8691/api/version")).ok, true);
  assert.equal(admit(BAR, request({ Host: "127.0.0.1:8691" }, "http://evil.example/api/version")).reason, "host");
  assert.equal(admit(BAR, request({ Host: "127.0.0.1:8691" }, "*", "OPTIONS")).reason, "host");
});

test("Origin: none, or the address itself by the name the request came to", () => {
  const { admit } = createEntryGuard();
  assert.deepEqual(admit(BAR, request({ Host: "127.0.0.1:8691" })), { ok: true, origin: null, cors: [] });
  assert.deepEqual(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "http://127.0.0.1:8691" })), { ok: true, origin: "http://127.0.0.1:8691", cors: [] });
  assert.equal(admit(BAR, request({ Host: "localhost:8691", Origin: "http://localhost:8691" })).ok, true);
  // localhost and 127.0.0.1 are two origins for a browser: each is its own only on itself.
  assert.equal(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "http://localhost:8691" })).reason, "origin");
  assert.equal(admit(BAR, request({ Host: "localhost:8691", Origin: "http://127.0.0.1:8691" })).reason, "origin");
  const refused = [
    "https://evil.example",
    "null",
    "http://127.0.0.1:8692", // the management address is another origin
    "http://127.0.0.1:8691.evil.example",
    "https://127.0.0.1:8691",
    "http://127.0.0.1",
    "app://window", // not on the bar's address, and not named
    "file://",
    "",
  ];
  for (const origin of refused) {
    const verdict = admit(BAR, request({ Host: "127.0.0.1:8691", Origin: origin }));
    assert.equal(verdict.ok, false, origin);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.reason, "origin");
  }
  assert.match(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "null" })).error, /Origin: null/);
  // What a user of the desktop app can do comes first: the app takes no options, so "start the emulator with
  // --allow-origin" would be advice nobody can follow there. The option is named as the source's server's.
  for (const origin of ["null", "https://evil.example"]) {
    const { error } = admit(BAR, request({ Host: "127.0.0.1:8691", Origin: origin }));
    assert.match(error, /[Ll]et a program on this computer make the request for the page: a request without an Origin header is answered\./, origin);
    assert.match(error, /The desktop app has no setting that lets a page in; the server started from its source takes --allow-origin /, origin);
    assert.doesNotMatch(error, /start the emulator with/, origin);
  }
  assert.match(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "https://evil.example" })).error, /--allow-origin https:\/\/evil\.example/);
  const twice = raw([["Host", "127.0.0.1:8691"], ["Origin", "http://127.0.0.1:8691"], ["Origin", "https://evil.example"]]);
  assert.equal(admit(BAR, twice).reason, "origin", "Origin twice");
});

test("an origin named with --allow-origin is let in on both addresses: the bar's address answers it as a bar does", () => {
  const { admit } = createEntryGuard({ allowOrigins: ["http://localhost:3000", "HTTPS://Tools.Example"] });
  assert.deepEqual(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "http://localhost:3000" })), {
    ok: true,
    origin: "http://localhost:3000",
    cors: [["Access-Control-Allow-Origin", "*"], ["Access-Control-Allow-Headers", "*"], ["Vary", "Origin"]],
  });
  assert.equal(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "https://tools.example" })).ok, true);
  assert.deepEqual(admit(CONTROL, request({ Host: "127.0.0.1:8692", Origin: "http://localhost:3000" })).cors, [["Access-Control-Allow-Origin", "http://localhost:3000"], ["Vary", "Origin"]]);
  // Only those: a neighbour of one is somebody else.
  for (const origin of ["http://localhost:3001", "https://localhost:3000", "http://tools.example", "null"]) {
    assert.equal(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: origin })).ok, false, origin);
  }
  // A page of its own and a program get no CORS headers.
  assert.deepEqual(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "http://127.0.0.1:8691" })).cors, []);
  assert.deepEqual(admit(BAR, request({ Host: "127.0.0.1:8691" })).cors, []);
});

test("the app window's origin is the emulator's own on the management address only", () => {
  const { admit } = createEntryGuard({ windowOrigin: "app://window" });
  assert.deepEqual(admit(CONTROL, request({ Host: "127.0.0.1:8692", Origin: "app://window" })), {
    ok: true,
    origin: "app://window",
    cors: [["Access-Control-Allow-Origin", "app://window"], ["Vary", "Origin"]],
  });
  for (const origin of ["app://stage", "app://shell", "app://window2", "app://windo", "null", "http://127.0.0.1:8691"]) {
    assert.equal(admit(CONTROL, request({ Host: "127.0.0.1:8692", Origin: origin })).reason, "origin", origin);
  }
  assert.equal(admit(BAR, request({ Host: "127.0.0.1:8691", Origin: "app://window" })).reason, "origin");
  // Without it, the window's origin is nobody's.
  assert.equal(createEntryGuard().admit(CONTROL, request({ Host: "127.0.0.1:8692", Origin: "app://window" })).reason, "origin");
});

test("origins given at the start are checked: no wildcard, no null, no path", () => {
  assert.equal(normalizeOrigin("http://LocalHost:3000"), "http://localhost:3000");
  assert.equal(normalizeOrigin("https://tools.example:443"), "https://tools.example");
  assert.equal(normalizeOrigin("app://window"), "app://window");
  for (const bad of ["*", "null", "NULL", "http://localhost:3000/", "http://localhost:3000/page", "localhost:3000", "http://", "http://a b", "http://user@host", "", undefined]) {
    assert.throws(() => normalizeOrigin(bad), RangeError, String(bad));
    assert.throws(() => createEntryGuard({ allowOrigins: [bad] }), RangeError, String(bad));
  }
  assert.throws(() => createEntryGuard({ windowOrigin: "*" }), /--window-origin/);
});
