// What the socket watcher of the app tests (test/app/sockets.mjs) counts as reachable from the network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseLsof, reachableFromNetwork } from "../app/sockets.mjs";

// As lsof -F pPnT prints them: a process, then each socket's file, protocol, name and TCP state.
const LSOF = [
  "p100",
  "f20", "PUDP", "n*:*",
  "f21", "PUDP", "n*:5353",
  "f22", "PUDP", "n[2001:db8::1]:60123->[2001:4860:4860::8888]:53",
  "f23", "PTCP", "n127.0.0.1:8831", "TST=LISTEN",
  "f24", "PTCP", "n*:9222", "TST=LISTEN",
  "f25", "PTCP", "n192.0.2.10:50000->198.51.100.4:443", "TST=ESTABLISHED",
  "p101",
  "f30", "PUDP", "n127.0.0.1:61000",
  "f31", "PUDP", "n[::]:61001",
  "",
].join("\n");

test("lsof's lines become the sockets that listen or are UDP, with the peer of a connected one", () => {
  assert.deepEqual(parseLsof(LSOF), [
    { pid: 100, protocol: "UDP", local: "*:*", peer: null },
    { pid: 100, protocol: "UDP", local: "*:5353", peer: null },
    { pid: 100, protocol: "UDP", local: "[2001:db8::1]:60123", peer: "[2001:4860:4860::8888]:53" },
    { pid: 100, protocol: "TCP", local: "127.0.0.1:8831", peer: null },
    { pid: 100, protocol: "TCP", local: "*:9222", peer: null },
    { pid: 101, protocol: "UDP", local: "127.0.0.1:61000", peer: null },
    { pid: 101, protocol: "UDP", local: "[::]:61001", peer: null },
  ]);
});

test("an unbound UDP socket and one connected to one peer are not reachable; a bound one and a listener are", () => {
  const reachable = parseLsof(LSOF).filter(reachableFromNetwork).map((s) => `${s.protocol} ${s.local}`);
  assert.deepEqual(reachable, ["UDP *:5353", "TCP *:9222", "UDP [::]:61001"]);
});

test("netstat's UDP lines on Windows are bound sockets and count off the loopback addresses", () => {
  assert.equal(reachableFromNetwork({ protocol: "UDP", local: "0.0.0.0:5353" }), true);
  assert.equal(reachableFromNetwork({ protocol: "UDP", local: "[::]:56598" }), true);
  assert.equal(reachableFromNetwork({ protocol: "UDP", local: "127.0.0.1:56598" }), false);
  assert.equal(reachableFromNetwork({ protocol: "TCP", local: "[::1]:8831" }), false);
});
