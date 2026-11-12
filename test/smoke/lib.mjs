// The parts of the smoke test (test/smoke.mjs) that need no built app, so that test/smoke.test.mjs checks them: where
// a built app keeps its things, the list of what must not be in it, the reader of app.asar's list, the PNG reader that
// compares frames, sizes, and the reading of the system's socket lists.
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";

export const APP_NAME = "BUSY Bar Emulator";

/**
 * Where a built app keeps its parts. macOS: the bundle (<name>.app); Windows: the folder that holds <name>.exe.
 * @returns {{ app: string, exe: string, resources: string, cli: string }}
 */
export function layoutOf(app, platform = process.platform) {
  if (platform === "win32") {
    const resources = path.win32.join(app, "resources");
    return { app, exe: path.win32.join(app, `${APP_NAME}.exe`), resources, cli: path.win32.join(resources, "bin", "busy-emulator.exe") };
  }
  const resources = path.posix.join(app, "Contents", "Resources");
  return { app, exe: path.posix.join(app, "Contents", "MacOS", APP_NAME), resources, cli: path.posix.join(resources, "bin", "busy-emulator") };
}

/**
 * The app `npm run dist -- --kind test` builds, where it puts it by default (packages/app/tools/dist.mjs: <out> is
 * busy-emulator-build/dist beside the cache of the bundled Node, the test variant in <out>/test-variant/<target>).
 */
export function defaultTestVariant({ platform = process.platform, arch = process.arch, home, localAppData }) {
  if (platform === "win32") {
    const base = localAppData || path.win32.join(home, "AppData", "Local");
    return path.win32.join(base, "busy-emulator-build", "dist", "test-variant", `win32-${arch}`, APP_NAME);
  }
  return path.posix.join(home, "Library", "Caches", "busy-emulator-build", "dist", "test-variant", `darwin-${arch}`, `${APP_NAME}.app`);
}

/**
 * The architecture a macOS program is for, read from its Mach-O header: "arm64", "x64", "universal", or null for a
 * file that is none. On Windows the app is x64. Written here on its own, as the rest of this file: the smoke test
 * takes nothing from the packaging it checks.
 */
export function archOfProgram(file, platform = process.platform) {
  if (platform === "win32") return "x64";
  const header = Buffer.alloc(8);
  const fd = openSync(file, "r");
  try {
    if (readSync(fd, header, 0, 8, 0) < 8) return null;
  } finally {
    closeSync(fd);
  }
  const magic = header.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xcafebabf) return "universal";
  if (magic !== 0xcffaedfe) return null;
  return { 0x01000007: "x64", 0x0100000c: "arm64" }[header.readUInt32LE(4)] ?? null;
}

/** The release files that hold an app of a system and architecture (ADR-0002, section 3). */
export function releaseFilesOf(platform, arch) {
  return platform === "win32" ? ["busybar-emulator-win-x64-setup.exe"] : [`busybar-emulator-mac-${arch}.zip`, `busybar-emulator-mac-${arch}.dmg`];
}

// ---------------------------------------------------------------- what must not be in the app

/**
 * What a built app must not hold (EMU-017): tests, the engine's build sources, development dependencies. Written
 * here on its own, not taken from the packaging's list (packages/app/tools/packaging/composition.mjs), so that a
 * mistake in that list is caught rather than repeated. Paths are relative to the part they are in, with "/".
 * The bundled Node (resources/node) is Node's own and npm's, checked by dist:check; Electron's files are Electron's.
 */
export const FORBIDDEN = Object.freeze([
  { what: "a test", test: (p) => /\.test\.(mjs|cjs|js|ts)$/.test(p) || /(^|\/)(test|tests|__tests__|fixtures)\//.test(p) },
  { what: "an engine build source", test: (p) => /(^|\/)packages\/engine\/(native\/|build\.mjs$|patches\.mjs$|apps-assets\.json$)/.test(p) || /\.(c|h|cc|cpp|hpp|s|S)$/.test(p) || /(^|\/)(Makefile|CMakeLists\.txt|SConstruct|SConscript)$/.test(p) },
  { what: "an engine build intermediate", test: (p) => /(^|\/)packages\/engine\/build\/[^/]+\/(obj|src|gen|out)\//.test(p) },
  { what: "a dependency folder", test: (p) => /(^|\/)node_modules\//.test(p) },
  { what: "a lock file or a source map", test: (p) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p) || /\.map$/.test(p) },
]);

/** The test entry that makes a build the test variant (packages/app/README.md): allowed there, never in a release. */
export const TEST_VARIANT_PART = /^test-variant\//;

/**
 * The files of a built app that break the list. `parts`: { name, files } — `name` says where (`app.asar`,
 * `resources/emulator`, ...), `files` relative paths in it. `devDependencies`: names that must appear nowhere.
 * @returns {{ part: string, file: string, what: string }[]}
 */
export function forbiddenFiles(parts, { devDependencies = [], kind = "release" } = {}) {
  const found = [];
  for (const { name, files } of parts) {
    for (const file of files) {
      if (name === "app.asar" && TEST_VARIANT_PART.test(file)) {
        if (kind !== "test") found.push({ part: name, file, what: "the test variant's test entry" });
        continue;
      }
      const rule = FORBIDDEN.find((r) => r.test(file));
      if (rule) {
        found.push({ part: name, file, what: rule.what });
        continue;
      }
      const dep = devDependencies.find((d) => file === d || file.startsWith(`${d}/`) || file.includes(`/${d}/`));
      if (dep) found.push({ part: name, file, what: `the development dependency ${dep}` });
    }
  }
  return found;
}

/** Every file below a folder, relative and with "/", links not followed. */
export function filesBelow(folder) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), at);
      else out.push(at);
    }
  };
  walk(folder, "");
  return out.sort();
}

/**
 * The list of files in an asar archive, read from its header: a pickle (4 bytes of size 4, then the header's pickle
 * size), and in it a string — the JSON tree of the archive — of the length at byte 12, from byte 16.
 */
export function asarFiles(file) {
  const fd = readFileSync(file, { flag: "r" });
  const length = fd.readUInt32LE(12);
  const tree = JSON.parse(fd.subarray(16, 16 + length).toString("utf8"));
  const out = [];
  const walk = (node, rel) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const at = rel ? `${rel}/${name}` : name;
      if (child.files) walk(child, at);
      else out.push(at);
    }
  };
  walk(tree, "");
  return out.sort();
}

// ---------------------------------------------------------------- sizes

/** Bytes of the files below a folder (links counted as links, not followed), and how many files. */
export function sizeOf(folder) {
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else {
        bytes += lstatSync(at).size;
        files++;
      }
    }
  };
  walk(folder);
  return { bytes, files };
}

export const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

// ---------------------------------------------------------------- frames

/**
 * The pixels of an 8-bit PNG without interlace, color type 2 (RGB) or 0 (gray), any of the five row filters: what
 * the command line's screenshot writes (packages/server/capture/png.mjs) and what a person may commit.
 * @returns {{ width: number, height: number, channels: number, pixels: Buffer }}
 */
export function readPng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  let at = 8;
  let header = null;
  const data = [];
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!header) throw new Error("a PNG without IHDR");
  if (header.depth !== 8 || header.interlace !== 0 || ![0, 2].includes(header.color)) throw new Error(`a PNG this reader does not take (depth ${header.depth}, color type ${header.color}, interlace ${header.interlace})`);
  const channels = header.color === 2 ? 3 : 1;
  const raw = inflateSync(Buffer.concat(data));
  const stride = header.width * channels;
  if (raw.length !== (stride + 1) * header.height) throw new Error("the PNG's image data has the wrong size");
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error(`a PNG row with filter ${filter}`);
      pixels[y * stride + x] = (row[x] + predictor) & 0xff;
    }
  }
  return { width: header.width, height: header.height, channels, pixels };
}

/** How many pixels of two PNGs differ; null when their sizes or formats differ. */
export function differingPixels(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) return null;
  let differ = 0;
  for (let i = 0; i < a.pixels.length; i += a.channels) {
    if (!a.pixels.subarray(i, i + a.channels).equals(b.pixels.subarray(i, i + a.channels))) differ++;
  }
  return differ;
}

// ---------------------------------------------------------------- sockets

/** Addresses of this machine only: 127.0.0.0/8 and ::1, in the forms lsof and netstat print them. */
export function loopback(address) {
  const host = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  return /^127\./.test(host) || host === "::1" || host === "localhost" || /^::ffff:127\./i.test(host);
}

/** "host:port" or "[v6]:port" (netstat) and "host:port" with a v6 host as lsof prints it ("[::1]:8770"). */
export function splitEndpoint(text) {
  const v6 = /^\[(.*)\]:(\d+|\*)$/.exec(text);
  if (v6) return { host: v6[1], port: v6[2] };
  const at = text.lastIndexOf(":");
  return at < 0 ? { host: text, port: "" } : { host: text.slice(0, at), port: text.slice(at + 1) };
}

/** An address that stands for every address of the machine: *, 0.0.0.0, :: (a socket bound there takes all of them). */
export function wildcard(endpoint) {
  const { host } = splitEndpoint(endpoint);
  return host === "*" || host === "0.0.0.0" || host === "::";
}

/**
 * What a socket of the app does that reaches past this machine: listens or is bound on an address other than
 * loopback, or is connected (or connecting) to one. Null when it stays on this machine.
 * @param {{ protocol: string, local: string, remote: string | null, state: string }} s
 */
export function pastThisMachine(s) {
  if (s.remote && !/^\*:\*$|^0\.0\.0\.0:0$|^\[::\]:0$|^\*:0$/.test(s.remote)) {
    const { host } = splitEndpoint(s.remote);
    if (!loopback(host)) return `${s.protocol} to ${s.remote}${s.state ? ` (${s.state})` : ""}`;
    return null;
  }
  const { host, port } = splitEndpoint(s.local);
  // "*:*": a socket made but not bound to a port yet (lsof); it can neither send nor receive.
  if (!s.remote && (port === "*" || port === "0") && (host === "*" || host === "0.0.0.0" || host === "::")) return null;
  if (!loopback(host)) return `${s.protocol} ${s.state === "LISTEN" || s.state === "LISTENING" ? "listening" : "bound"} on ${s.local}`;
  return null;
}

/** lsof -F pPnT output: the sockets, { pid, protocol, local, remote, state }. */
export function parseLsof(text) {
  const sockets = [];
  let pid = 0;
  let current = null;
  const flush = () => {
    if (current?.name) {
      const [local, remote = null] = current.name.split("->");
      sockets.push({ pid, protocol: current.protocol, local, remote, state: current.state });
    }
    current = null;
  };
  for (const line of text.split("\n")) {
    const value = line.slice(1);
    if (line[0] === "p") {
      flush();
      pid = Number(value);
    } else if (line[0] === "f") {
      flush();
      current = { protocol: "", name: "", state: "" };
    } else if (current && line[0] === "P") current.protocol = value;
    else if (current && line[0] === "n") current.name = value;
    else if (current && line[0] === "T" && value.startsWith("ST=")) current.state = value.slice(3);
  }
  flush();
  return sockets;
}

/** netstat -ano output (Windows): the sockets of the given processes. */
export function parseNetstat(text, pids) {
  const sockets = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== "TCP" && parts[0] !== "UDP") continue;
    const pid = Number(parts.at(-1));
    if (!pids.has(pid)) continue;
    if (parts[0] === "TCP") sockets.push({ pid, protocol: "TCP", local: parts[1], remote: parts[2], state: parts[3] });
    else sockets.push({ pid, protocol: "UDP", local: parts[1], remote: parts[2] === "*:*" ? null : parts[2], state: "" });
  }
  return sockets;
}

// ---------------------------------------------------------------- Chromium's network log

/** The events of a network log, and whether it was closed. A log cut short is read up to where it stops. */
function parseNetLog(text) {
  try {
    const log = JSON.parse(text);
    return { constants: log.constants ?? {}, events: log.events ?? [], complete: true };
  } catch {
    // A log the process did not close: the constants, then one event per line.
  }
  const at = text.search(/"events"\s*:\s*\[/);
  if (at < 0) return { constants: {}, events: [], complete: false };
  let constants = {};
  try {
    constants = JSON.parse(`${text.slice(0, at).replace(/,\s*$/, "")}}`).constants ?? {};
  } catch {
    // Without names for the event types nothing below can be told.
  }
  const events = [];
  for (const line of text.slice(text.indexOf("[", at) + 1).split("\n")) {
    const item = line.trim().replace(/,$/, "");
    if (!item.startsWith("{")) continue;
    try {
      events.push(JSON.parse(item));
    } catch {
      // The last line of a log cut short.
    }
  }
  return { constants, events, complete: false };
}

const hostOf = (text) => {
  if (text.includes("://")) {
    try {
      return new URL(text).hostname;
    } catch {
      return text;
    }
  }
  return splitEndpoint(text).port && !/^[0-9a-f:]+$/i.test(text) ? splitEndpoint(text).host : text;
};

/**
 * What Chromium's network log (--log-net-log) says the app's Chromium asked of the network beyond this machine:
 * requests to URLs that are not the app's own, names it looked up, TCP connections it made or tried, and UDP
 * datagrams it sent. A UDP socket that is only connected sends nothing — connect() on UDP picks a route and no packet
 * leaves; Chromium does that to 2001:4860:4860::8888 to learn whether IPv6 works (HOST_RESOLVER_MANAGER_IPV6_
 * REACHABILITY_CHECK) — and is given apart, as `probes`.
 * `probeLocals`: the probes' own ends, an address of this machine each (Windows' netstat shows only that end).
 * @returns {{ events: number, complete: boolean, named: boolean, reached: string[], probes: string[], probeLocals: string[] }}
 */
export function readNetLog(text) {
  const { constants, events, complete } = parseNetLog(text);
  const eventName = Object.fromEntries(Object.entries(constants.logEventTypes ?? {}).map(([name, id]) => [id, name]));
  const sourceName = Object.fromEntries(Object.entries(constants.logSourceType ?? {}).map(([name, id]) => [id, name]));
  const reached = new Set();
  const udpConnects = new Map(); // source id -> address
  const linked = new Map(); // source id -> the ids it depends on, and back
  const sending = new Set(); // UDP sources that sent bytes
  const udpLocals = new Map(); // UDP source id -> its own end
  const link = (a, b) => {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!linked.has(x)) linked.set(x, new Set());
      linked.get(x).add(y);
    }
  };
  const own = (url) => /^(app|devtools|chrome|chrome-extension|data|blob|about|file):/i.test(url) || /^(https?|wss?):\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
  for (const event of events) {
    const p = event.params ?? {};
    const type = eventName[event.type] ?? String(event.type);
    const source = sourceName[event.source?.type] ?? "";
    const id = event.source?.id;
    if (p.source_dependency?.id !== undefined && id !== undefined) link(id, p.source_dependency.id);
    if (/BYTES_SENT$/.test(type) && /^UDP/.test(source)) sending.add(id);
    for (const key of ["url", "original_url", "new_url"]) if (typeof p[key] === "string" && !own(p[key])) reached.add(`request ${p[key]}`);
    if (typeof p.host === "string" && !loopback(hostOf(p.host))) reached.add(`lookup ${p.host}`);
    // The socket's own end (UDP_LOCAL_ADDRESS, the local address of a connection) is this machine, whatever it is.
    if (/LOCAL_ADDRESS/.test(type) && /^UDP/.test(source) && typeof p.address === "string") udpLocals.set(id, p.address);
    const addresses = /LOCAL_ADDRESS/.test(type) ? [] : [p.address, p.remote_address, p.server_address, ...(Array.isArray(p.address_list) ? p.address_list : [])].filter((a) => typeof a === "string" && a);
    for (const address of addresses) {
      if (loopback(splitEndpoint(address).host)) continue;
      if (/^UDP/.test(source)) udpConnects.set(id, address);
      else reached.add(`${/CONNECT/.test(type) ? "connection to" : `${type} names`} ${address}`);
    }
  }
  const probes = new Set();
  const probeLocals = new Set();
  for (const [id, address] of udpConnects) {
    const group = new Set([id, ...(linked.get(id) ?? [])]);
    if ([...group].some((g) => sending.has(g))) reached.add(`UDP datagrams to ${address}`);
    else {
      probes.add(address);
      for (const g of group) if (udpLocals.has(g)) probeLocals.add(udpLocals.get(g));
    }
  }
  return { events: events.length, complete, named: Object.keys(eventName).length > 0, reached: [...reached].sort(), probes: [...probes].sort(), probeLocals: [...probeLocals].sort() };
}
