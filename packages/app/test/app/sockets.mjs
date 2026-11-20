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

/**
 * The UDP sockets Chromium connected to one peer, from its log of the network (--log-net-log): [{ family, port, peer }],
 * `port` the socket's own (UDP_LOCAL_ADDRESS, which Chromium logs when it asks the socket for its address, as its
 * check of whether IPv6 reaches the internet does: a socket connected to [2001:4860:4860::8888]:443 that sends
 * nothing). On Windows netstat shows a connected UDP socket as bound to every address ("UDP [::]:58719"), with no
 * peer, so the log is what tells it apart there; lsof names the peer. A log cut short (the app ended before it closed
 * it) is read as far as it goes.
 */
export function connectedInNetLog(text) {
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    const cut = text.lastIndexOf("},");
    try {
      log = JSON.parse(`${text.slice(0, cut + 1)}]}`);
    } catch {
      return [];
    }
  }
  const types = log?.constants?.logEventTypes ?? {};
  const sources = log?.constants?.logSourceType ?? {};
  const phases = log?.constants?.logEventPhase ?? { PHASE_BEGIN: 1, PHASE_END: 2 };
  const sockets = new Map(); // source id → { connected, peer, local }
  for (const e of log?.events ?? []) {
    if (e?.source?.type !== sources.UDP_SOCKET) continue;
    const one = sockets.get(e.source.id) ?? { connected: false, peer: null, local: null };
    sockets.set(e.source.id, one);
    if (e.type === types.UDP_CONNECT && e.phase === phases.PHASE_BEGIN) one.peer = e.params?.address ?? null;
    if (e.type === types.UDP_CONNECT && e.phase === phases.PHASE_END) one.connected = !e.params?.net_error;
    if (e.type === types.UDP_LOCAL_ADDRESS) one.local = e.params?.address ?? null;
  }
  const found = [];
  for (const one of sockets.values()) {
    const m = one.connected && one.peer && one.local ? /^(\[.*\]|[\d.]+):(\d+)$/.exec(one.local) : null;
    if (m) found.push({ family: m[1].startsWith("[") ? 6 : 4, port: Number(m[2]), peer: one.peer });
  }
  return found;
}

/** Whether a socket of netstat ("UDP [::]:58719") is one of `connected` (connectedInNetLog): the same family and port. */
export function connectedSocket({ protocol, local }, connected) {
  const m = protocol === "UDP" ? /^(\[.*\]|[\d.*]+):(\d+)$/.exec(local) : null;
  return Boolean(m) && connected.some((c) => c.port === Number(m[2]) && c.family === (m[1].startsWith("[") ? 6 : 4));
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

/** The command line of a process, for the message about a socket it should not have had ("" when it is gone). */
async function commandOf(pid) {
  if (process.platform === "win32") {
    const shell = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    return (await output(shell, ["-NoProfile", "-NonInteractive", "-Command", `$ProgressPreference='SilentlyContinue'; (Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`])).trim();
  }
  return (await output("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)])).trim();
}

/** A command line short enough for a message: the program and Chromium's type of process, else its start. */
export function shortCommand(command) {
  const type = [...command.matchAll(/--(?:type|utility-sub-type)=\S+/g)].map((m) => m[0]).join(" ");
  if (type) return `${command.split(" --")[0].replace(/^"|"$/g, "").split(/[\\/]/).pop()} ${type}`;
  return command.length > 160 ? `${command.slice(0, 160)}…` : command;
}

/**
 * Starts watching the sockets of a launch.
 * @param {number} rootPid                      the app's main process
 * @param {() => Promise<number[]>} morePids    the processes the app itself knows of (the test entry tells them)
 * @returns stop(): the distinct sockets seen that were not on this machine's own addresses, how many samples, and
 *   for each of those sockets the process that had it ("UDP 0.0.0.0:53975: 1234 (electron.exe --type=utility …)")
 */
export function watchSockets(rootPid, morePids) {
  const known = new Set([rootPid]);
  const offLoopback = new Map();
  const owners = new Map(); // socket → a promise of its process's description, asked for when it is first seen
  let samples = 0;
  let running = true;
  let stopped = null;
  const loop = (async () => {
    while (running) {
      for (const pid of await morePids().catch(() => [])) if (pid) known.add(pid);
      const pids = process.platform === "win32" ? known : await descendants(known);
      for (const pid of pids) known.add(pid);
      for (const socket of await listeningSockets(pids)) {
        if (!reachableFromNetwork(socket)) continue;
        const key = `${socket.protocol} ${socket.local}`;
        offLoopback.set(key, socket);
        if (!owners.has(key)) owners.set(key, commandOf(socket.pid).then((command) => `${key}: ${socket.pid}${command ? ` (${shortCommand(command)})` : ""}`));
      }
      samples += 1;
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
  })();
  return {
    /** Ends the watching (again: the same answer). */
    stop() {
      running = false;
      stopped ??= (async () => {
        await loop;
        return { samples, offLoopback: [...offLoopback.keys()].sort(), sockets: [...offLoopback.values()], owners: (await Promise.all(owners.values())).sort() };
      })();
      return stopped;
    },
  };
}
