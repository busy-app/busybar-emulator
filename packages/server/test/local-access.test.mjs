// An app does not reach this computer (ADR-0012 section 5, EMU-187): every way of writing its loopback is refused
// before a connection is made, a name is resolved once and connected to as checked, an allowed port goes through, and
// the emulator's own ports never do. The requests go through the app's network client (http-client.mjs) to a real
// server of the test on 127.0.0.1, which counts what reaches it.
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";

import { request } from "../http-client.mjs";
import { createLocalAccess, destination, explainRefusal, interfaceAddresses, isLoopbackAddress, isLoopbackName, isThisComputer, parseLocalPort, pinnedLookup } from "../local-access.mjs";
import { isBarApi } from "../runtime.mjs";

// The test's own server on 127.0.0.1: a plain answer, and a count of the connections and bytes that came.
let server;
let port;
const seen = { connections: 0, bytes: 0 };
before(async () => {
  server = net.createServer((socket) => {
    seen.connections++;
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      seen.bytes += chunk.length;
      if (chunk.includes("\r\n\r\n")) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});
after(() => new Promise((resolve) => server.close(resolve)));

/** One request through the app's client; what the app got, what was refused, and what reached the server. */
async function fetchVia(url, { access = createLocalAccess(), lookup, stopAfterMs } = {}) {
  const before = { ...seen };
  const result = { error: null, head: null, body: "", refusals: [] };
  await new Promise((resolve) => {
    const stop = request({
      url,
      method: "GET",
      headers: [],
      body: null,
      access,
      lookup,
      onRefused: (refusal) => result.refusals.push(refusal),
      onHead: (head) => (result.head = Buffer.from(head).toString("latin1")),
      onData: (chunk) => (result.body += Buffer.from(chunk).toString("latin1")),
      onError: (message) => (result.error = message),
      onEnd: () => resolve(),
    });
    if (stopAfterMs !== undefined) setTimeout(() => (stop(), resolve()), stopAfterMs);
  });
  // A connection that was made would have been counted by now: the server is on this computer.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ...result, connections: seen.connections - before.connections, bytes: seen.bytes - before.bytes };
}

// Every spelling of the loopback an app could put in a URL that the firmware reads as an address of the bar (mongoose's
// mg_aton: four decimal numbers, "localhost" in any case, IPv6) or as a name its resolver could give the loopback for.
const LOOPBACK_URLS = [
  "127.0.0.1", "127.0.0.2", "127.255.255.254", "0127.0.0.01",
  "0.0.0.0", "0.1.2.3",
  "[::1]", "[0:0:0:0:0:0:0:1]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:0.0.0.0]", "[::127.0.0.1]", "[64:ff9b::127.0.0.1]", "[2002:7f00:1::]", "[fe80::1]",
  "localhost", "LOCALHOST", "localhost.", "app.localhost", "a.b.localhost.",
];
// Spellings a WHATWG parser turns into the loopback, but the firmware does not read as an address: a name no DNS
// server knows (a last label that is a number, a character no name has), so the bar's request is not found. The
// system's resolver would read most of them as 127.0.0.1; the emulator never asks it. ("0177.0.0.1" is 177.0.0.1 to
// the firmware, a public address, and is not tried here.)
const NOT_NAMES = ["127.1", "127.0.1", "2130706433", "0x7f000001", "0x7F.0.0.1", "0x7f.1", "017700000001", "0", "ｌｏｃａｌｈｏｓｔ"];

test("what the firmware does not read as an address or a name is not found, and nothing connects", async () => {
  for (const host of NOT_NAMES) {
    for (const scheme of ["http", "https"]) {
      const url = `${scheme}://${host}:${port}/secret?token=1`;
      let asked = 0;
      const got = await fetchVia(url, { access: createLocalAccess({ allow: [port] }), lookup: async () => (asked++, [{ address: "127.0.0.1", family: 4 }]) });
      assert.equal(got.error, "Failed to connect to server", url);
      assert.equal(got.connections, 0, `${url} reached the computer`);
      assert.equal(asked, 0, `${url} was resolved`);
    }
  }
});

test("every spelling of the loopback is refused before anything connects, with the BUSY Bar's error", async () => {
  for (const host of LOOPBACK_URLS) {
    for (const scheme of ["http", "https"]) {
      const url = `${scheme}://${host}:${port}/secret?token=1`;
      const got = await fetchVia(url);
      assert.equal(got.error, "socket error", url);
      assert.equal(got.connections, 0, `${url} reached the computer`);
      assert.equal(got.refusals.length, 1, url);
      assert.equal(got.refusals[0].why, "not-allowed", url);
      assert.equal(got.refusals[0].port, port, url);
    }
  }
});

test("the default ports of a scheme count too: http://127.0.0.2/ is port 80, https://localhost/ port 443", async () => {
  for (const [url, expected] of [["http://127.0.0.2/", 80], ["https://localhost/", 443], ["http://[::1]/", 80], ["http://localhost.:80/", 80]]) {
    const got = await fetchVia(url);
    assert.equal(got.error, "socket error", url);
    assert.equal(got.refusals[0]?.port, expected, url);
  }
});

test("the BUSY Bar's own API is not the network: http://localhost/ and http://127.0.0.1/ on port 80 only", () => {
  for (const url of ["http://localhost/api/status", "http://127.0.0.1/api/status", "http://localhost:80/api/x", "http://LOCALHOST/api/x", "http://127.1/api/x"]) assert.equal(isBarApi(new URL(url)), true, url);
  for (const url of ["http://localhost:8640/api/status", "http://127.0.0.1:3000/", "https://localhost/api/status", "http://localhost./api/status", "http://127.0.0.2/api/status", "http://[::1]/api/status", "http://example.com/api/status"]) {
    assert.equal(isBarApi(new URL(url)), false, url);
  }
});

test("a name that resolves to the loopback is refused, and so is one with a loopback address among others", async () => {
  for (const addresses of [[{ address: "127.0.0.1", family: 4 }], [{ address: "::1", family: 6 }], [{ address: "198.51.100.7", family: 4 }, { address: "127.0.0.1", family: 4 }], [{ address: "::ffff:127.0.0.1", family: 6 }], [{ address: "fe80::1%lo0", family: 6 }]]) {
    let asked = 0;
    const got = await fetchVia(`http://intranet.example:${port}/`, { lookup: async () => (asked++, addresses) });
    assert.equal(got.error, "socket error", JSON.stringify(addresses));
    assert.equal(got.connections, 0);
    assert.equal(asked, 1);
    assert.equal(got.refusals[0].why, "not-allowed");
  }
});

test("a name is resolved once and connected to as checked: a second answer of 127.0.0.1 (DNS rebinding) is never used", async () => {
  // The first answer is an address of the documentation range, which goes nowhere; every later one is this computer.
  let asked = 0;
  const lookup = async () => (asked++ === 0 ? [{ address: "192.0.2.1", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
  const got = await fetchVia(`http://rebind.example:${port}/`, { lookup, stopAfterMs: 400 });
  assert.equal(asked, 1, "the name was resolved more than once");
  assert.equal(got.connections, 0, "the connection went to the second answer");
  assert.deepEqual(got.refusals, []);
});

test("net.connect goes where the pinned lookup says and resolves nothing itself", async () => {
  const before = seen.connections;
  for (const options of [{}, { autoSelectFamily: false }, { family: 4 }]) {
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: "no-such-name.invalid", port, lookup: pinnedLookup([{ address: "127.0.0.1", family: 4 }]), ...options }, () => (socket.destroy(), resolve()));
      socket.once("error", reject);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(seen.connections - before, 3);
});

test("an allowed port of this computer is reached, by address and by name", async () => {
  const access = createLocalAccess({ allow: [port] });
  for (const host of ["127.0.0.1", "localhost", "LocalHost", "127.000.0.1"]) {
    const got = await fetchVia(`http://${host}:${port}/ok`, { access });
    assert.equal(got.error, null, host);
    assert.match(got.head, /^HTTP\/1\.1 200 OK/, host);
    assert.equal(got.body, "ok", host);
    assert.deepEqual(got.refusals, []);
  }
  // A name goes to the addresses its one resolution gave, not to what the system would say: this one has none there.
  let asked = 0;
  const pinned = await fetchVia(`http://no-such-name.invalid:${port}/ok`, { access, lookup: async () => (asked++, [{ address: "127.0.0.1", family: 4 }]) });
  assert.equal(pinned.error, null, "the connection did not go to the address that was checked");
  assert.equal(pinned.body, "ok");
  assert.equal(asked, 1);
  // Another port of this computer stays refused.
  assert.equal((await fetchVia(`http://127.0.0.1:${port + 1 > 65535 ? port - 1 : port + 1}/`, { access })).error, "socket error");
});

test("a port taken back while the connection is made: the socket is checked on its address, nothing is sent, not even a TLS hello", async () => {
  for (const scheme of ["http", "https"]) {
    // Allowed when the destination is decided, taken back by the time the socket has connected.
    let asked = 0;
    const access = { isThisComputer: (a) => createLocalAccess().isThisComputer(a), refusal: () => (asked++ === 0 ? null : "not-allowed") };
    const got = await fetchVia(`${scheme}://127.0.0.1:${port}/`, { access });
    assert.equal(asked, 2, `${scheme}: the connected socket's address was not checked`);
    assert.equal(got.error, "socket error", scheme);
    assert.equal(got.bytes, 0, `${scheme}: something was sent to a port that is no longer allowed`);
    assert.equal(got.refusals[0]?.why, "not-allowed", scheme);
  }
});

test("https to an allowed port: TLS starts on the checked connection (the test's server speaks no TLS)", async () => {
  const hellos = [];
  const tlsProbe = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (chunk) => (hellos.push(chunk[0]), socket.end("HTTP/1.1 200 OK\r\n\r\n")));
  });
  await new Promise((resolve) => tlsProbe.listen(0, "127.0.0.1", resolve));
  try {
    // The name resolved by the test, to the one address the probe listens on: the system's resolver can take seconds
    // on a busy machine (the 5 s without data count from the start of the request), and localhost's ::1 is another
    // port space, where the same port may belong to some other program.
    const got = await fetchVia(`https://localhost:${tlsProbe.address().port}/`, { access: createLocalAccess({ allow: [tlsProbe.address().port] }), lookup: async () => [{ address: "127.0.0.1", family: 4 }] });
    assert.equal(got.error, "Failed to establish TLS connection");
    assert.deepEqual(hellos, [0x16], "no TLS handshake record came");
  } finally {
    await new Promise((resolve) => tlsProbe.close(resolve));
  }
});

test("the emulator's own ports are refused whatever is allowed, and cannot be allowed", async () => {
  const own = { bar: port, control: port + 1 };
  const access = createLocalAccess({ ownPorts: () => own });
  assert.throws(() => access.allow(port), /own BUSY Bar address/);
  assert.throws(() => access.allow(port + 1), /management address/);
  // Even if a port of theirs had been allowed before they took it (a server started on port 0).
  const early = createLocalAccess({ allow: [port], ownPorts: () => own });
  const got = await fetchVia(`http://127.0.0.1:${port}/`, { access: early });
  assert.equal(got.error, "socket error");
  assert.equal(got.connections, 0);
  assert.equal(got.refusals[0].why, "bar");
  assert.equal(early.refusal(port + 1), "control");
});

test("the rest of the network is not refused", async () => {
  const where = await destination({ hostname: "example.com", port: 443, access: createLocalAccess(), lookup: async () => [{ address: "93.184.215.14", family: 4 }] });
  assert.deepEqual(where, { host: "example.com", addresses: [{ address: "93.184.215.14", family: 4 }] });
  for (const address of ["198.51.100.5", "203.0.113.21", "8.8.8.8", "128.0.0.1", "126.255.255.255", "1.0.0.0", "[2001:db8::1]", "[::ffff:8.8.8.8]", "[fec0::1]"]) {
    assert.equal((await destination({ hostname: address, port: 80, access: createLocalAccess() })).refused, undefined, address);
  }
});

test("what counts as the loopback", () => {
  for (const a of ["127.0.0.1", "127.9.9.9", "0.0.0.0", "0.255.255.255", "::1", "::", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::7f00:1", "64:ff9b::7f00:1", "2002:7f00::1", "fe80::1", "fe80::1%lo0", "FE80::abcd"]) assert.equal(isLoopbackAddress(a), true, a);
  for (const a of ["128.0.0.1", "126.0.0.1", "1.1.1.1", "::2:0:0", "2001:db8::1", "::ffff:8.8.8.8", "localhost", "", "not an address"]) assert.equal(isLoopbackAddress(a), false, a);
  for (const n of ["localhost", "LocalHost", "localhost.", "x.localhost", "x.y.localhost.", ""]) assert.equal(isLoopbackName(n), true, n);
  for (const n of ["localhost.example", "mylocalhost", "localhostx", "example.com"]) assert.equal(isLoopbackName(n), false, n);
});

test("--allow-local takes a port in decimal digits, and never port 80", () => {
  assert.equal(parseLocalPort("3000"), 3000);
  assert.equal(parseLocalPort(" 5173 "), 5173);
  assert.equal(parseLocalPort(65535), 65535);
  for (const bad of ["0", "65536", "-1", "3000x", "0x50", "1e3", "", "3000,3001", 3.5, null, undefined]) assert.throws(() => parseLocalPort(bad), RangeError, String(bad));
  assert.throws(() => parseLocalPort("80"), /BUSY Bar's own API/);
  const access = createLocalAccess({ allow: ["3000"] });
  assert.deepEqual(access.ports(), [3000]);
  assert.equal(access.allow("8080"), 8080);
  assert.deepEqual(access.ports(), [3000, 8080]);
  assert.equal(access.withdraw(3000), true);
  assert.equal(access.withdraw(3000), false);
  assert.deepEqual(access.ports(), [8080]);
});

test("the console says what happened, why and what to do, and does not repeat the request's path or query", () => {
  const text = explainRefusal({ appId: "app.x", url: "http://localhost:3000/hook?token=secret", refusal: { why: "not-allowed", port: 3000, address: "localhost" } });
  assert.match(text, /^App app\.x: its request to http:\/\/localhost:3000 was refused \("socket error"\)/);
  // The command line's own command comes first; the server's option, for one started by hand, after it.
  assert.match(text, /allow the port with this command: busy-emulator allow-local 3000 \(.*--allow-local 3000\)/);
  assert.doesNotMatch(text, /curl|Bearer|_emu/);
  assert.doesNotMatch(text, /secret|hook/);
  assert.match(explainRefusal({ appId: "app.x", url: "http://127.0.0.1:8640/api/status", refusal: { why: "bar", port: 8640, address: "127.0.0.1" } }), /http:\/\/localhost\/api\//);
  assert.match(explainRefusal({ appId: "app.x", url: "http://127.0.0.1:5/", refusal: { why: "control", port: 5, address: "127.0.0.1" } }), /management address, which an app may never reach/);
});

test("this computer's own network addresses are this computer too, read again at every check", async () => {
  // Stand-ins for the addresses of a home network, a VPN and IPv6; the interfaces can change while the emulator runs.
  let interfaces = ["198.51.100.20", "2001:db8::20", "203.0.113.20"];
  const access = createLocalAccess({ interfaces: () => interfaces });
  for (const a of ["198.51.100.20", "::ffff:198.51.100.20", "[2001:db8::20]", "203.0.113.20"]) assert.equal(access.isThisComputer(a), true, a);
  assert.equal(access.isThisComputer("198.51.100.21"), false);
  for (const hostname of ["198.51.100.20", "[2001:db8::20]", "[::ffff:198.51.100.20]"]) assert.equal((await destination({ hostname, port: 3000, access })).refused?.why, "not-allowed", hostname);
  // A name of the computer, such as its name on the router's DNS.
  assert.equal((await destination({ hostname: "laptop.lan", port: 3000, access, lookup: async () => [{ address: "198.51.100.20", family: 4 }] })).refused?.why, "not-allowed");
  // An allowed port goes ahead there too.
  assert.equal(createLocalAccess({ allow: [3000], interfaces: () => interfaces }).refusal(3000), null);
  // The address left the interface: it is somebody else's now.
  interfaces = [];
  assert.equal((await destination({ hostname: "198.51.100.20", port: 3000, access })).refused, undefined);
  // The real interfaces: every address of this computer is refused by default, loopback or not.
  for (const a of interfaceAddresses()) assert.equal(isThisComputer(a), true, a);
});

test("the connected socket is checked against this computer's own addresses too", async () => {
  // The test's server is on 127.0.0.1; an access that knows only "own addresses" and lets the destination through
  // shows that the check after the connection asks isThisComputer, not just the loopback list.
  let asked = 0;
  const access = { isThisComputer: () => asked++ > 0, refusal: () => "not-allowed" };
  const got = await fetchVia(`http://127.0.0.1:${port}/`, { access });
  assert.equal(got.error, "socket error");
  assert.equal(got.bytes, 0);
});
