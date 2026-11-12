// https to an IP address (EMU-187 review): TLS starts on the checked socket, and the certificate must be checked
// against the URL's IP address, not against "localhost", which Node takes when tls.connect gets a socket and no host.
// Without that, https://1.1.1.1/ failed, and a server reached by its IP address with a trusted certificate for
// "localhost" would have been accepted. The request trusts the test's own certificate in place of the bar's list
// (request's `ca`); it runs in a child Node, and its server is on a free port of 127.0.0.1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// A self-signed certificate for the address 127.0.0.1 alone (no DNS name), valid until 2036; made for this test.
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

const here = fileURLToPath(new URL(".", import.meta.url));

test("https://<IP address> is checked against that address, not against localhost", () => {
  const child = `
    import tls from "node:tls";
    import { request } from ${JSON.stringify(pathToFileURL(join(here, "..", "http-client.mjs")).href)};
    import { createLocalAccess } from ${JSON.stringify(pathToFileURL(join(here, "..", "local-access.mjs")).href)};
    const server = tls.createServer({ cert: ${JSON.stringify(CERT)}, key: ${JSON.stringify(KEY)} }, (s) => {
      s.on("error", () => {});
      s.once("data", () => s.end("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok"));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      let error = null, body = "";
      request({ url: "https://127.0.0.1:" + port + "/", method: "GET", headers: [], body: null,
        access: createLocalAccess({ allow: [port] }), ca: ${JSON.stringify(CERT)},
        onHead() {}, onData: (c) => (body += Buffer.from(c).toString()), onError: (m) => (error = m),
        onEnd: () => { console.log(JSON.stringify({ error, body })); server.close(); } });
    });`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { error: null, body: "ok" });
});
