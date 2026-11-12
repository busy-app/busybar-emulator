// The texts of the emulator's notes on an app's network requests (network-notes.mjs). How they come to the log is
// test/server/fetch-notes.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { memoryNote, networkErrorNote, redirectNote, usesTextCodec } from "../network-notes.mjs";

test("a redirect names its target, says the BUSY Bar does not follow it, and points out http to https", () => {
  const note = redirectNote({ method: "GET", url: "http://feeds.example.com/rss.xml", status: 302, location: "https://feeds.example.com/rss.xml" });
  assert.equal(
    note,
    "emulator: GET http://feeds.example.com/rss.xml answered 302, a redirect to https://feeds.example.com/rss.xml. A BUSY Bar does not follow redirects: the app gets the 302 and its body, not the data. Put the final address in the app (https: the server does not answer over plain http)",
  );
  const bare = redirectNote({ method: "GET", url: "https://a.example/x", status: 301, location: null });
  assert.match(bare, /answered 301, a redirect\. A BUSY Bar/);
  assert.doesNotMatch(bare, /https: the server/);
});

test("a failure before the answer and one in its middle say what the app gets in each case", () => {
  const before = networkErrorNote({ method: "GET", url: "https://slow.example/", message: "Inactivity timeout", afterHead: false, bytes: 0 });
  assert.match(before, /failed with "Inactivity timeout": no data came for 5 s.*counted from the start of the request.*fetch\(\) rejects with this string$/);
  const middle = networkErrorNote({ method: "GET", url: "https://slow.example/", message: "Inactivity timeout", afterHead: true, bytes: 2048 });
  assert.match(middle, /ended after 2048 bytes of its body with "Inactivity timeout"/);
  assert.match(middle, /a reader of res\.body gets \{ done: true, value: "Inactivity timeout" \}, not an error, and reader\.closed rejects with "cancelled"$/);
  const tls = networkErrorNote({ method: "GET", url: "https://old.example/", message: "Failed to establish TLS connection", afterHead: false, bytes: 0 });
  assert.match(tls, /The BUSY Bar trusts only the certificate authorities in its firmware's list/);
  const other = networkErrorNote({ method: "POST", url: "http://x.example/", message: "something new", afterHead: false, bytes: 0 });
  assert.match(other, /^emulator: POST http:\/\/x\.example\/ failed with "something new": the request failed\./);
});

test("the memory note names the heap, the response's size and address, and the ways out", () => {
  const note = memoryNote({ heapKib: 128, response: { method: "GET", url: "https://www.githubstatus.com/api/v2/incidents.json", bytes: 297551 } });
  assert.equal(
    note,
    "emulator: the app ran out of its 128 KiB heap after a 291 KiB response to GET https://www.githubstatus.com/api/v2/incidents.json. res.text() and res.json() hold the whole body in the heap at once, and parsed JSON takes several times its size. Ask for less (only the fields you need, a smaller endpoint), or read res.body.getReader() and keep only what you need from each piece. " +
      '"heap_size_kib" in the app\'s manifest raises the heap up to 512 KiB (JSON of about 70 KiB fits 128 KiB, about 275 KiB fits 512)',
  );
  assert.match(memoryNote({ heapKib: 96, response: { method: "GET", url: "https://a.example/", bytes: 5000 } }), /a 4\.9 KiB response/);
});

test("a long address is cut in a note", () => {
  const url = `https://a.example/${"x".repeat(300)}`;
  assert.ok(redirectNote({ method: "GET", url, status: 301, location: null }).length < 400);
});

test("TextDecoder and TextEncoder are recognized in the engine's words", () => {
  assert.ok(usesTextCodec("app.x: TextDecoder is not defined"));
  assert.ok(usesTextCodec("ReferenceError: TextEncoder is not defined"));
  assert.ok(!usesTextCodec("TextDecoder works"));
});
