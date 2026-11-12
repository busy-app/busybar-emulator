// An app's URL as the firmware reads it (http-client.mjs, firmwareUrl: mongoose's src/url.c), and what goes out for it:
// the request line and the Host header as the app wrote them, nothing normalised (finding C16 of the code audit of 11.11).
import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";

import { firmwareAddress, firmwareUrl, request } from "../http-client.mjs";
import { createLocalAccess } from "../local-access.mjs";

test("firmwareUrl reads a URL as mongoose does", () => {
  const cases = [
    ["http://example.com/a/../b/./c?q='x'#part", { host: "example.com", port: 80, uri: "/a/../b/./c?q='x'#part", secure: false }],
    ["https://Example.COM/", { host: "Example.COM", port: 443, uri: "/", secure: true }],
    ["http://example.com", { host: "example.com", port: 80, uri: "/", secure: false }],
    // A query with no path before it: the name runs to the end, the path is "/".
    ["http://example.com?x=1", { host: "example.com?x=1", port: 80, uri: "/", secure: false }],
    ["http://example.com:8080?x=1", { host: "example.com", port: 8080, uri: "/", secure: false }],
    ["http://user:pw@example.com:81/p", { host: "example.com", port: 81, uri: "/p", secure: false }],
    ["http://[::1]:8080/p", { host: "[::1]", port: 8080, uri: "/p", secure: false }],
    ["http://[::1]/p", { host: "[::1]", port: 80, uri: "/p", secure: false }],
    // The scheme is matched in lower case only: no TLS, no default port.
    ["HTTPS://example.com/", { host: "example.com", port: 0, uri: "/", secure: false }],
    ["HTTP://example.com:8080/", { host: "example.com", port: 8080, uri: "/", secure: false }],
    // atoi and the cast to unsigned short.
    ["http://example.com:65616/", { host: "example.com", port: 80, uri: "/", secure: false }],
    ["http://example.com:abc/", { host: "example.com", port: 0, uri: "/", secure: false }],
  ];
  for (const [url, want] of cases) assert.deepEqual(firmwareUrl(url), want, url);
});

/** The request `url` makes, as a server on 127.0.0.1 receives it; `lookup` resolves every name to that server. */
async function sent(url) {
  let text = "";
  const server = net.createServer((s) => {
    s.on("data", (d) => {
      text += d.toString("latin1");
      if (text.includes("\r\n\r\n")) s.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const error = await new Promise((resolve) => {
    let message = null;
    request({
      url: url.replace("{port}", String(port)),
      method: "GET",
      headers: [],
      body: null,
      access: createLocalAccess({ allow: [port] }),
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      onHead() {},
      onData() {},
      onError: (m) => (message = m),
      onEnd: () => resolve(message),
    });
  });
  server.close();
  return { error, lines: text.split("\r\n").slice(0, 2) };
}

test("the request line and the Host header go out as the app wrote them", async () => {
  assert.deepEqual(await sent("http://Example.COM:{port}/a/../b/%2e%2e/c?q='x'#part"), { error: null, lines: ["GET /a/../b/%2e%2e/c?q='x'#part HTTP/1.0", "Host: Example.COM"] });
  assert.deepEqual(await sent("http://example.com:{port}?x=1"), { error: null, lines: ["GET / HTTP/1.0", "Host: example.com"] });
});

test("where the firmware connects for a host (mongoose's mg_aton, else its DNS)", () => {
  const cases = [["", "0.0.0.0"], ["LocalHost", "127.0.0.1"], ["0177.0.0.1", "177.0.0.1"], ["10.0.4.256", null], ["::1", "::1"], ["Example.COM", "Example.COM"],
    ["127.1", null], ["2130706433", null], ["0x7f000001", null], ["example.com?x=1", null], ["ｌｏｃａｌｈｏｓｔ", null]];
  for (const [host, want] of cases) assert.equal(firmwareAddress(host), want, host);
});

test("a name that cannot be one is not found; an empty host is 0.0.0.0, this computer, and refused", async () => {
  assert.deepEqual(await sent("http://example.com?x=1"), { error: "Failed to connect to server", lines: [""] });
  assert.deepEqual(await sent("http://127.1:{port}/"), { error: "Failed to connect to server", lines: [""] });
  assert.deepEqual(await sent("http:///p"), { error: "socket error", lines: [""] });
});

test("port 0 connects nowhere", async () => {
  assert.deepEqual(await sent("HTTP://example.com/p"), { error: "socket error", lines: [""] });
});
