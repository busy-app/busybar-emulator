// The certificate authorities an app's https request is checked against: the bar's own list (http-client.mjs
// BAR_CA_FILE, the firmware's assets/shared/ca/cacert.pem), not Node's. A server whose certificate no authority of
// that list signed fails as on a bar, "Failed to establish TLS connection"; the same server passes when its
// certificate is trusted (request's `ca`, which only tests give).
import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import tls from "node:tls";
import { test } from "node:test";

import { barCertificates, request } from "../http-client.mjs";
import { createLocalAccess } from "../local-access.mjs";

// A self-signed certificate for the address 127.0.0.1 (https-ip-literal.test.mjs has the same pair).
const CERT = `-----BEGIN CERTIFICATE-----
MIIBjjCCATSgAwIBAgIUDXzzCTJ2YBElY8OZyTal73U5XtcwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTExMTEwMzkxN1oXDTM2MTEwODEw
MzkxN1owFDESMBAGA1UEAwwJMTI3LjAuMC4xMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEBu0rDNJW2nkomm7AprDMoNdXH25vPg7u2yUCM0k6gl1tx5YKJ7X1isrg
3x8ZD5dPKuLls1Xr8TeWrCn4RM88xKNkMGIwHQYDVR0OBBYEFPxUJI2IYMGwZ3Ty
/2JqDTr4uVsGMB8GA1UdIwQYMBaAFPxUJI2IYMGwZ3Ty/2JqDTr4uVsGMA8GA1Ud
EQQIMAaHBH8AAAEwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBD
yYChadCwGHP63G8lAW410aHN3ERN+3d2QyiTmA8sbAIhAMwaaMN3A1mEcvjTxTdo
VDU1r/BuM0PQZaPBQsULupXB
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgDo6kdtTNXoODDR3K
Vu8lR44foWwtSLZjrO3PHPju60KhRANCAAQG7SsM0lbaeSiabsCmsMyg11cfbm8+
Du7bJQIzSTqCXW3HlgontfWKyuDfHxkPl08q4uWzVevxN5asKfhEzzzE
-----END PRIVATE KEY-----
`;

test("the bar's list is the firmware's: Mozilla's roots of 20 Oct 2026, 118 certificates, every one readable", () => {
  const text = barCertificates();
  assert.match(text, /^## Certificate data from Mozilla as of: Tue Oct 20 13:32:40 2026 GMT$/m);
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  assert.equal(pems.length, 118);
  for (const pem of pems) assert.ok(new X509Certificate(pem).ca, "every one is a certificate authority");
  // Byte for byte the firmware's assets/shared/ca/cacert.pem at the commits of firmware.json (1.3.1 and dev have the
  // same file; checked against the firmware checkout 12.11). Whether Node's own roots differ is not this list's
  // business: a Node release may come to trust the same set (24.22.2 does).
  assert.equal(createHash("sha256").update(text).digest("hex"), FIRMWARE_CACERT_SHA256);
});

/** SHA-256 of the firmware's assets/shared/ca/cacert.pem (1.3.1 8edd2da4, dev 4d1c24ac). */
const FIRMWARE_CACERT_SHA256 = "796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe";

/** One https request to a server of this test with the certificate above: the error, or null and the body. */
async function ask(ca) {
  const server = tls.createServer({ cert: CERT, key: KEY }, (s) => {
    s.on("error", () => {});
    s.once("data", () => s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
  });
  server.on("tlsClientError", () => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    return await new Promise((resolve) => {
      let error = null;
      let body = "";
      request({
        url: `https://127.0.0.1:${port}/`,
        method: "GET",
        headers: [],
        body: null,
        access: createLocalAccess({ allow: [port] }),
        ...(ca ? { ca } : {}),
        onHead() {},
        onData: (c) => (body += Buffer.from(c).toString()),
        onError: (m) => (error = m),
        onEnd: () => resolve({ error, body }),
      });
    });
  } finally {
    server.close();
  }
}

test("a certificate no authority of the bar's list signed: the TLS connection fails as on a bar", async () => {
  assert.deepEqual(await ask(), { error: "Failed to establish TLS connection", body: "" });
});

test("the same server with its certificate trusted: the request goes through", async () => {
  assert.deepEqual(await ask(CERT), { error: null, body: "ok" });
});
