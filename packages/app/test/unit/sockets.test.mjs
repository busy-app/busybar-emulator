// What the socket watcher of the app tests (test/app/sockets.mjs) counts as reachable from the network.
import assert from "node:assert/strict";
import { test } from "node:test";

import { connectedInNetLog, connectedSocket, parseLsof, reachableFromNetwork } from "../app/sockets.mjs";

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

// Chromium's log of the network as --log-net-log writes it: the constants, then the events; a socket's events share
// its source. Here Chromium's check of IPv6 (connected, its own address asked for), a connect that failed, and a
// socket bound to a port (no connect).
const NET_LOG = {
  constants: { logEventTypes: { UDP_CONNECT: 10, UDP_LOCAL_ADDRESS: 11, SOCKET_ALIVE: 12 }, logSourceType: { UDP_SOCKET: 49, URL_REQUEST: 2 }, logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 } },
  events: [
    { source: { id: 1, type: 49 }, type: 12, phase: 1 },
    { source: { id: 1, type: 49 }, type: 10, phase: 1, params: { address: "[2001:4860:4860::8888]:443" } },
    { source: { id: 1, type: 49 }, type: 10, phase: 2 },
    { source: { id: 1, type: 49 }, type: 11, phase: 0, params: { address: "[2001:db8::5]:58719" } },
    { source: { id: 2, type: 49 }, type: 10, phase: 1, params: { address: "[2001:4860:4860::8888]:443" } },
    { source: { id: 2, type: 49 }, type: 10, phase: 2, params: { net_error: -109 } },
    { source: { id: 2, type: 49 }, type: 11, phase: 0, params: { address: "[::]:58720" } },
    { source: { id: 3, type: 49 }, type: 11, phase: 0, params: { address: "0.0.0.0:53975" } },
    { source: { id: 4, type: 2 }, type: 11, phase: 0, params: { address: "192.0.2.10:53976" } },
  ],
};

test("Chromium's log names the UDP sockets it connected to one peer, with their own port; not one that failed or was only bound", () => {
  const text = JSON.stringify(NET_LOG);
  assert.deepEqual(connectedInNetLog(text), [{ family: 6, port: 58719, peer: "[2001:4860:4860::8888]:443" }]);
  // Cut short, as an app that was killed leaves it: read as far as it goes.
  assert.deepEqual(connectedInNetLog(text.slice(0, text.indexOf('{"source":{"id":2'))), [{ family: 6, port: 58719, peer: "[2001:4860:4860::8888]:443" }]);
  assert.deepEqual(connectedInNetLog("not a log"), []);
});

test("netstat's UDP socket on every address is Chromium's connected one only for the same family and port", () => {
  const connected = connectedInNetLog(JSON.stringify(NET_LOG));
  assert.equal(connectedSocket({ protocol: "UDP", local: "[::]:58719" }, connected), true);
  assert.equal(connectedSocket({ protocol: "UDP", local: "0.0.0.0:58719" }, connected), false, "another family");
  assert.equal(connectedSocket({ protocol: "UDP", local: "[::]:58720" }, connected), false, "the connect failed: bound, if anything");
  assert.equal(connectedSocket({ protocol: "UDP", local: "0.0.0.0:53975" }, connected), false, "bound, never connected");
  assert.equal(connectedSocket({ protocol: "TCP", local: "[::]:58719" }, connected), false, "a listener is not a connected UDP socket");
});
