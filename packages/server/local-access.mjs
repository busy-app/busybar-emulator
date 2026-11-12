// What of this computer an app on the emulated bar may reach (ADR-0012 section 5).
//
// On a bar, `localhost` is the bar itself: its own API on port 80, and nothing on any other port. In the emulator a
// request to a loopback address would reach the computer the author works on — its databases, its dev servers, the
// emulator's own management address. So an app's request to this computer — its loopback and its own network
// addresses — is refused, unless its port was allowed: by --allow-local <port> at the start, or later by a program
// that holds the server's key (never by a page).
// The bar's own API (`http://localhost/api/...`, port 80) does not come here: the runtime answers it in the process.
//
// What counts as the loopback, after the address has been made out (the runtime's URL parser already turns
// 2130706433, 0x7f000001, 0177.0.0.1 and 127.1 into 127.0.0.1, and [0:0:0:0:0:0:0:1] into [::1]):
//   - every IPv4 address in 127.0.0.0/8, and 0.0.0.0/8, which the systems deliver to this computer (0.0.0.0);
//   - ::1 and :: in IPv6, the same IPv4 addresses mapped into IPv6 (::ffff:127.0.0.1) or written the old
//     IPv4-compatible way (::127.0.0.1), and those that a NAT64 or 6to4 prefix carries (64:ff9b::127.0.0.1,
//     2002:7f00::); link-local fe80::/10, which on macOS includes fe80::1 of the loopback interface lo0;
//   - the names localhost and *.localhost (RFC 6761), with or without the final dot, before anything is resolved;
//   - any other name whose resolution gives one of those addresses. The name is resolved once, here, and the
//     connection is made to exactly the addresses that were checked (DNS rebinding: a name that answers with a public
//     address for the check and with 127.0.0.1 for the connection gets nowhere); the address the socket connects to
//     is checked again when it is connected.
// This computer is also every address its network interfaces have now (os.networkInterfaces(), read again at every
// check): its address on the home network, its IPv6 addresses, a VPN's (Tailscale), the bar's USB network, and any
// name that resolves to one of them (the computer's own name on the router's DNS). A service that listens on all
// interfaces — app.listen(3000) without a host, a port published by Docker — answers there as on 127.0.0.1, and the
// computer's firewall does not stand between the computer and itself. A real bar on the same network could reach such
// a service by that address, if the computer's firewall lets it in; the emulator refuses it unless its port is allowed,
// because from inside the computer nothing filters it (ADR-0012 section 5).
// The emulator's own ports — the bar's address and the management address — are refused always, allowed or not.
//
// A refused request fails the way a bar's request to a port of its own where nothing listens does: lwIP answers it with
// a reset (the bar's lwipopts.h has LWIP_NETIF_LOOPBACK), and mongoose reports "socket error" (mongoose.c,
// connect_conn and the poll loop) — by the firmware's code, not checked on a device. (A closed port of another
// computer is "socket error" on a bar too: checked on 1.3.1 with test/fetch.mjs --bar, 09.11.)
import dns from "node:dns";
import net from "node:net";
import os from "node:os";

/** The port of the bar's own API: `http://localhost/api/...` on a bar. */
export const BAR_API_PORT = 80;

/** What a refused request gives the app: lib/fetch's error for a connection that did not come about. */
export const REFUSED_ERROR = "socket error";

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addSubnet("0.0.0.0", 8, "ipv4");
for (const [prefix, bits] of [
  ["::", 104], // ::, ::1 and ::0.x.x.x
  ["::7f00:0", 104], // ::127.x.x.x, IPv4-compatible
  ["::ffff:7f00:0", 104], // ::ffff:127.x.x.x, IPv4-mapped (BlockList matches these by the IPv4 rules too; said here outright)
  ["::ffff:0:0", 104], // ::ffff:0.x.x.x
  ["64:ff9b::7f00:0", 104], // NAT64 of 127/8
  ["64:ff9b::", 104], // NAT64 of 0/8
  ["2002:7f00::", 24], // 6to4 of 127/8
  ["2002::", 24], // 6to4 of 0/8
  ["fe80::", 10], // link-local, fe80::1%lo0 among them
]) {
  LOOPBACK.addSubnet(prefix, bits, "ipv6");
}

/** An address as a URL or a resolver gives it, without the brackets of IPv6 and without a zone (fe80::1%lo0). */
function bare(address) {
  let a = String(address);
  if (a.startsWith("[") && a.endsWith("]")) a = a.slice(1, -1);
  const zone = a.indexOf("%");
  return zone >= 0 ? a.slice(0, zone) : a;
}

/** Whether `address`, an IP address, is this computer's loopback (see the top of the file). False for a name. */
export function isLoopbackAddress(address) {
  const a = bare(address);
  const family = net.isIP(a);
  if (family === 4) return LOOPBACK.check(a, "ipv4");
  if (family === 6) return LOOPBACK.check(a, "ipv6");
  return false;
}

/** The addresses of this computer's network interfaces as the system gives them now; none if it gives none. */
export function interfaceAddresses() {
  try {
    return Object.values(os.networkInterfaces()).flat().map(({ address }) => address);
  } catch {
    return [];
  }
}

/**
 * Whether `address`, an IP address, is this computer: its loopback, or an address one of its interfaces has
 * (`interfaces()`, read now). An IPv4 address and the same address mapped into IPv6 are one address.
 */
export function isThisComputer(address, interfaces = interfaceAddresses) {
  if (isLoopbackAddress(address)) return true;
  const a = bare(address);
  const family = net.isIP(a);
  if (!family) return false;
  const own = new net.BlockList();
  for (const one of interfaces()) {
    const b = bare(one);
    const f = net.isIP(b);
    if (f) own.addAddress(b, f === 6 ? "ipv6" : "ipv4");
  }
  return own.check(a, family === 6 ? "ipv6" : "ipv4");
}

/** Whether `name` is localhost or a name under it (RFC 6761), with or without the final dot. An empty name too. */
export function isLoopbackName(name) {
  const n = String(name).toLowerCase().replace(/\.$/, "");
  return n === "" || n === "localhost" || n.endsWith(".localhost");
}

/**
 * A port named for --allow-local, or for the management address's command: a whole number from 1 to 65535, given in
 * decimal digits only. Port 80 of localhost is the bar's own API and cannot be given to this computer.
 * @throws {RangeError} that says what is wrong
 */
export function parseLocalPort(value, what = "--allow-local") {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!(port >= 1 && port <= 65535)) throw new RangeError(`${what} takes the number of a port on this computer, from 1 to 65535, not ${JSON.stringify(value)}.`);
  if (port === BAR_API_PORT) throw new RangeError(`${what} ${port}: port ${BAR_API_PORT} of localhost is the BUSY Bar's own API, as on a BUSY Bar; an app reaches it as http://localhost/api/... and it cannot be given to this computer.`);
  return port;
}

/**
 * The ports of this computer that apps may reach.
 * @param {object} [o]
 * @param {Iterable<number|string>} [o.allow] the ports allowed from the start (--allow-local)
 * @param {() => { bar?: number, control?: number }} [o.ownPorts] the emulator's own addresses, which are refused always
 */
export function createLocalAccess({ allow = [], ownPorts = () => ({}), interfaces = interfaceAddresses } = {}) {
  const allowed = new Set([...allow].map((port) => parseLocalPort(port)));
  /** Why `port` of this computer is never an app's: the emulator's own address, or null. */
  const own = (port) => {
    const { bar, control } = ownPorts() ?? {};
    if (port === control) return "control";
    if (port === bar) return "bar";
    return null;
  };
  return {
    /** Whether an IP address is this computer: its loopback or one of its interfaces' addresses now. */
    isThisComputer: (address) => isThisComputer(address, interfaces),
    /** The allowed ports, in order. */
    ports: () => [...allowed].sort((a, b) => a - b),
    /** Allows a port; the port, checked. Throws a RangeError for one that is not a port or is the emulator's own. */
    allow(value) {
      const port = parseLocalPort(value, "A local port");
      const mine = own(port);
      if (mine) throw new RangeError(`Port ${port} is the emulator's own ${mine === "control" ? "management address" : "BUSY Bar address"}; an app on the BUSY Bar may never reach it.`);
      allowed.add(port);
      return port;
    },
    /** Takes a port back; whether it had been allowed. */
    withdraw(value) {
      return allowed.delete(parseLocalPort(value, "A local port"));
    },
    /**
     * Why a connection to `port` of this computer's loopback is refused — "control" or "bar" for the emulator's own
     * addresses, "not-allowed" for a port nobody allowed — or null when it may go ahead.
     */
    refusal(port) {
      return own(port) ?? (allowed.has(port) ? null : "not-allowed");
    },
  };
}

/** The resolver of the system, every address of the name, in the order the system gives them. */
function lookupAll(hostname) {
  return new Promise((resolve, reject) => dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => (error ? reject(error) : resolve(addresses))));
}

/**
 * Where a request to `hostname`:`port` may connect, decided once, before any connection is made.
 * @param {object} o
 * @param {string} o.hostname as the URL gives it ([::1] in brackets)
 * @param {number} o.port
 * @param {ReturnType<typeof createLocalAccess>} o.access
 * @param {(hostname: string) => Promise<{ address: string, family: number }[]>} [o.lookup] the resolver
 * @returns {Promise<{ refused: { why: string, port: number, address: string } } | { host: string, addresses: { address:
 *   string, family: number }[] | null }>} `addresses` are those the connection must go to (null for an IP address,
 *   which is connected to as it is). Rejects with the resolver's error when the name does not resolve.
 */
export async function destination({ hostname, port, access, lookup = lookupAll }) {
  const host = bare(hostname);
  const refused = (address) => {
    const why = access.refusal(port);
    return why ? { refused: { why, port, address } } : null;
  };
  if (net.isIP(host)) return (access.isThisComputer(host) && refused(host)) || { host, addresses: null };
  if (isLoopbackName(host)) {
    const no = refused(host);
    if (no) return no;
  }
  const addresses = (await lookup(host)).map(({ address, family }) => ({ address, family: family === 6 || family === "IPv6" ? 6 : 4 }));
  if (!addresses.length) throw Object.assign(new Error(`${host} has no address`), { code: "ENOTFOUND" });
  // One address of this computer among them is enough: the connection could go to it.
  const local = addresses.find(({ address }) => access.isThisComputer(address));
  return (local && refused(local.address)) || { host, addresses };
}

/**
 * A `lookup` for net.connect that gives only `addresses`, already checked, and resolves nothing: the connection goes
 * where the check said, whatever the name would resolve to now. Answers both ways Node asks (one address, or all of
 * them when it tries several families in turn).
 */
export function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    if (typeof options === "function") [callback, options] = [options, {}];
    const family = options?.family === 6 || options?.family === "IPv6" ? 6 : options?.family === 4 || options?.family === "IPv4" ? 4 : 0;
    const list = family ? addresses.filter((a) => a.family === family) : addresses;
    if (!list.length) return callback(Object.assign(new Error(`${hostname} has no IPv${family} address`), { code: "ENOTFOUND" }));
    if (options?.all) return callback(null, list.map((a) => ({ ...a })));
    callback(null, list[0].address, list[0].family);
  };
}

/** The path on the management address that lists, allows and takes back ports (server.mjs). */
export const LOCAL_PORTS_PATH = "/_emu/local-ports";

/**
 * What the app's console says when a request of the app to this computer is refused: what happened, why, what to do.
 * It names the address without its path and query, which may carry an app's secrets. What to do is the command line's
 * `allow-local` first (cli/commands/allow-local.mjs), which asks the running server; --allow-local is for a server
 * started by hand.
 */
export function explainRefusal({ appId, url, refusal }) {
  let where;
  try {
    const u = new URL(url);
    where = `${u.protocol}//${u.host}`;
  } catch {
    where = "an address of this computer";
  }
  const head = `App ${appId}: its request to ${where} was refused ("${REFUSED_ERROR}")`;
  if (refusal.why === "control") return `${head}: port ${refusal.port} is the emulator's management address, which an app may never reach.`;
  if (refusal.why === "bar") {
    return `${head}: port ${refusal.port} is the emulator's own BUSY Bar address. On a BUSY Bar an app reaches its BUSY Bar's API as http://localhost/api/..., and so it does here.`;
  }
  return (
    `${head}: it leads to this computer (${refusal.address}), and an app may not reach this computer's own services; on a BUSY Bar, localhost is the BUSY Bar itself. ` +
    `If the app talks to a service of yours on port ${refusal.port}, allow the port with this command: busy-emulator allow-local ${refusal.port} ` +
    `(it holds until the emulator quits; a server started by hand also takes --allow-local ${refusal.port}). ` +
    "A BUSY Bar would reach such a service by this computer's address on your network; the emulator refuses that address too unless the port is allowed."
  );
}
