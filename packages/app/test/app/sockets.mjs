// Watches what the app listens on while a test runs. The shell and everything it starts keep to this machine: the
// only addresses they may listen on, or bind for UDP, are 127.0.0.1 and ::1. Anything else is a socket the network can
// reach — and on Windows the moment the firewall asks the person at the machine about the app.
//
// The sockets are sampled, about ten times a second, from the system's own list (lsof on macOS, netstat on Windows)
// for the processes of one launch. A socket that lives for less than a sample can be missed.
import { execFile } from "node:child_process";

const LOOPBACK = /^(127\.0\.0\.1|\[::1\]):/;
const PAUSE_MS = 60;

/**
 * Whether the network can reach the socket: one that listens (TCP) or is bound (UDP) on an address other than
 * 127.0.0.1 and ::1. A UDP socket without a port of its own (lsof: "*:*"; Chromium makes one to see whether the
 * computer has IPv6, and sends nothing) and one connected to a single peer (lsof names the peer after "->") take no
 * datagram from anybody else, so they are not counted.
 */
export function reachableFromNetwork({ protocol, local, peer = null }) {
  if (LOOPBACK.test(local)) return false;
  if (protocol === "UDP" && (peer || /:\*$/.test(local))) return false;
  return true;
}

/** lsof -F pPnT output: the sockets that listen (TCP) or are UDP, as { pid, protocol, local, peer }. */
export function parseLsof(text) {
  const sockets = [];
  let pid = 0;
  let protocol = "";
  let name = "";
  let state = "";
  const flush = () => {
    if (name && (protocol === "UDP" || state === "LISTEN")) {
      const [local, peer = null] = name.split("->");
      sockets.push({ pid, protocol, local, peer });
    }
    name = "";
    state = "";
  };
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") {
      flush();
      pid = Number(value);
    } else if (line[0] === "f") flush();
    else if (line[0] === "P") protocol = value;
    else if (line[0] === "n") name = value;
    else if (line[0] === "T" && value.startsWith("ST=")) state = value.slice(3);
  }
  flush();
  return sockets;
}

function output(file, args) {
  return new Promise((resolve) => {
    // lsof ends with a code when a process on its list is gone; what it printed still counts.
    execFile(file, args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => resolve(stdout ?? ""));
  });
}

/** macOS: every process below the root, by the system's list of parents. */
async function descendants(roots) {
  const parents = new Map();
  for (const line of (await output("/bin/ps", ["-axo", "pid=,ppid="])).split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid) parents.set(pid, parent);
  }
  const found = new Set(roots);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, parent] of parents) {
      if (found.has(parent) && !found.has(pid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return found;
}

/** Sockets that listen (TCP) or are bound (UDP), as { pid, protocol, local, peer }, for the given processes. */
async function listeningSockets(pids) {
  const sockets = [];
  if (process.platform === "win32") {
    for (const line of (await output("netstat", ["-ano"])).split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts.at(-1));
      if (!pids.has(pid)) continue;
      if (parts[0] === "UDP" || (parts[0] === "TCP" && parts[3] === "LISTENING")) sockets.push({ pid, protocol: parts[0], local: parts[1] });
    }
    return sockets;
  }
  return parseLsof(await output("/usr/sbin/lsof", ["-nP", "-a", "-p", [...pids].join(","), "-i", "-F", "pPnT"]));
}

/**
 * Starts watching the sockets of a launch.
 * @param {number} rootPid                      the app's main process
 * @param {() => Promise<number[]>} morePids    the processes the app itself knows of (the test entry tells them)
 * @returns stop(): the distinct sockets seen that were not on this machine's own addresses, and how many samples
 */
export function watchSockets(rootPid, morePids) {
  const known = new Set([rootPid]);
  const offLoopback = new Map();
  let samples = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      for (const pid of await morePids().catch(() => [])) if (pid) known.add(pid);
      const pids = process.platform === "win32" ? known : await descendants(known);
      for (const pid of pids) known.add(pid);
      for (const socket of await listeningSockets(pids)) {
        if (reachableFromNetwork(socket)) offLoopback.set(`${socket.protocol} ${socket.local}`, socket);
      }
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { samples, offLoopback: [...offLoopback.keys()].sort() };
    },
  };
}
