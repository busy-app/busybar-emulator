// GET /api/status/ws: the bar's state stream, which the local web reads through busy-lib's LocalStateStream.
// After the client sends {"enable": true}, the bar pushes binary protobuf `State` messages
// (busybar-firmware/assets/proto/state.proto): the parts of its state as they change, key presses, and the front
// display's frames whenever they change (frame.proto), at most every 100 ms as api_status_streaming.c sends them.
// {"send": "all"} asks for the whole state again.
//
// The firmware's state publisher (applications/services/state_publisher) collects the state from the services; here
// it is collected from the same places the API answers from, so the stream and the API always agree: the firmware's
// own handlers in the screen module for Wi-Fi, Bluetooth, updates and the BUSY timer, and the device for the rest.
// Hand-rolled WebSocket (RFC 6455) and protobuf encoding: only what the stream needs, no dependencies.
import { createHash } from "node:crypto";

import { computerNow } from "./computer-clock.mjs";

// FRAME_INTERVAL_MS in web_server/http_api/api_status_streaming.c.
const FRAME_INTERVAL_MS = 100;
// How often the state is looked at for changes, and how often it is sent whole, changed or not: under the local
// web's data timeout, so the stream never shows as stale (a bar's battery readings keep it going).
const STATE_INTERVAL_MS = 250;
const REFRESH_INTERVAL_MS = 1000;

// ---------------------------------------------------------------- protobuf

function varint(n) {
  const out = [];
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}
const zigzag = (n) => (n << 1) ^ (n >> 31);
const key = (field, wire) => varint((field << 3) | wire);
const pb = {
  uint: (field, n) => [...key(field, 0), ...varint(n)],
  sint: (field, n) => [...key(field, 0), ...varint(zigzag(n) >>> 0)],
  bytes: (field, bytes) => [...key(field, 2), ...varint(bytes.length), ...bytes],
  string: (field, s) => pb.bytes(field, [...new TextEncoder().encode(s)]),
  message: (field, parts) => pb.bytes(field, parts.flat()),
  fixed64: (field, n) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return [...key(field, 1), ...b];
  },
};

const text = (bytes) => new TextDecoder().decode(bytes);
// BSB_Util.Json: PLAIN, the text.
const jsonMessage = (field, jsonText) => pb.message(field, [pb.uint(1, 0), pb.bytes(2, [...new TextEncoder().encode(jsonText)])]);
// "02:00" → minutes since midnight.
const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const offsetMinutes = (offset) => (offset[0] === "-" ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));

// The texts api_wifi.c and api_ble.c give, as the enums of state/wifi.proto and state/ble.proto.
const WIFI_SECURITY = { Open: 1, WPA: 2, WPA2: 3, WEP: 4, "WPA/WPA2": 5, WPA3: 6, "WPA2/WPA3": 7 };
const WIFI_STATUS = { connected: 0, connecting: 1, disconnecting: 2, reconnecting: 3 };
const BLE_STATUS = { reset: 0, initialization: 1, disabled: 2, enabled: 3, connectable: 4, connected: 5 };
const CHECK_EVENT = { start: 0, stop: 1, none: 2 };
const CHECK_REASON = { not_available: 0, failure: 1, none: 2 };

/**
 * The bar's state as the StateUpdate messages of state.proto, by field number: { 1: bytes, 2: bytes, ... }, each
 * the content of one `updates` entry of a State.
 */
export async function collectState(device) {
  const s = device.state;
  const firmware = async (path) => {
    const { status, body } = await device.screen.request("GET", path, "", null);
    return status === 200 ? text(body).trim() : null;
  };
  const parsed = (jsonText) => (jsonText ? JSON.parse(jsonText) : null);
  const updates = {};

  updates[1] = pb.message(1, [pb.string(1, s.name)]); // device_name

  // power.known, as collect_power() maps it: CHARGED only while charging is on and the battery is full.
  const power = device.power();
  const battery = { charging: 1, charged: 2, discharging: 0 }[power.state];
  updates[2] = pb.message(2, [
    pb.message(2, [pb.uint(1, battery), pb.uint(2, power.battery_charge), pb.uint(3, power.battery_voltage), pb.sint(4, power.battery_current), pb.uint(5, power.usb_voltage)]),
  ]);

  // brightness: automatic or manual; the emulator has no light sensor, automatic shows as half.
  updates[3] = pb.message(3, s.brightness === "auto" ? [pb.message(1, []), pb.uint(3, 50)] : [pb.message(2, [pb.uint(1, Number(s.brightness))]), pb.uint(3, Number(s.brightness))]);

  updates[4] = pb.message(4, [pb.uint(1, s.volume)]); // audio_volume

  // wifi: inactive, or active with the network and one IPv4 address (collect_wifi_info).
  const wifi = parsed(await firmware("wifi/status"));
  if (!wifi || wifi.state === "unknown") updates[5] = pb.message(5, [pb.message(1, [])]);
  else if (wifi.state === "disconnected") updates[5] = pb.message(5, [pb.message(2, [])]);
  else {
    const active = [pb.uint(1, WIFI_STATUS[wifi.state] ?? 0), pb.string(2, wifi.ssid ?? ""), pb.string(3, wifi.bssid ?? ""), pb.uint(4, wifi.channel ?? 0), pb.sint(5, wifi.rssi ?? 0), pb.uint(6, WIFI_SECURITY[wifi.security] ?? 0)];
    const ip = wifi.ip_config;
    // The API tells the address only; the gateway and the mask are those of a home network around it.
    const address = ip?.ip_type === "ipv4" ? [pb.message(4, [pb.uint(1, 0), pb.uint(2, ip.ip_method === "static" ? 1 : 0), pb.string(3, ip.address), pb.string(4, ip.address.replace(/\d+$/, "1")), pb.string(5, "255.255.255.0")])] : [];
    updates[5] = pb.message(5, [pb.message(3, active), ...address]);
  }

  // update_state: nothing is ever being installed (EVENT_NONE, ACTION_NONE, OK); update_check from the API.
  updates[6] = pb.message(6, [pb.uint(1, 6), pb.uint(2, 5), pb.uint(3, 0)]);
  const update = parsed(await firmware("update/status"));
  if (update) {
    const check = update.check;
    const status = check.status === "available" ? pb.message(1, [pb.string(1, check.available_version)]) : pb.message(2, [pb.uint(1, CHECK_REASON[check.status] ?? 2)]);
    updates[7] = pb.message(7, [status, pb.uint(3, CHECK_EVENT[check.event] ?? 2)]);
  }

  updates[8] = pb.message(8, [pb.string(1, s.timezone.name), pb.sint(2, offsetMinutes(s.timezone.offset)), pb.string(3, s.timezone.abbr ?? "")]); // timezone

  // matter: in no fabric, and never asked to join one.
  const matter = parsed(await firmware("smart_home/pairing"));
  updates[9] = pb.message(9, [pb.uint(1, matter?.fabric_count ?? 0)]);

  // timer and its two profiles: the JSON of GET /api/busy/snapshot and /api/busy/profiles/<name>.
  const snapshot = await firmware("busy/snapshot");
  if (snapshot) updates[12] = pb.message(12, [jsonMessage(1, snapshot)]);
  const profiles = [];
  for (const name of ["busy", "custom"]) {
    const profile = await firmware(`busy/profiles/${name}`);
    if (profile) profiles.push(pb.message(1, [pb.string(1, name), jsonMessage(2, profile)]));
  }
  updates[15] = pb.message(15, profiles);

  const ble = parsed(await firmware("ble/status"));
  if (ble) updates[13] = pb.message(13, [pb.uint(1, BLE_STATUS[ble.status] ?? 6), ...(ble.address ? [pb.string(2, ble.address)] : [])]);

  const autoupdate = parsed(await firmware("update/autoupdate"));
  if (autoupdate) updates[14] = pb.message(14, [pb.uint(1, autoupdate.is_enabled ? 1 : 0), pb.message(2, [pb.uint(1, minutes(autoupdate.interval_start)), pb.uint(2, minutes(autoupdate.interval_end))])]);

  return updates;
}

/** A State message with the given StateUpdates (each the content of one `updates` entry). */
export function encodeUpdates(updates, now = Date.now()) {
  return Uint8Array.from([...pb.fixed64(1, Math.round(now)), ...updates.flatMap((u) => pb.message(2, [u]))]);
}

// The keys of POST /api/input as the InputEvent of input.proto (input_event_pubsub_callback): the wheel is an
// encoder step, the mode selector a switch position, the three buttons a press or a release.
const BUTTONS = { ok: 0, back: 1, start: 2 };
const SWITCH = { busy: 0, custom: 1, off: 2, apps: 3, settings: 4 };

/** The StateUpdate for a key event, or null for the events the bar does not publish. */
export function encodeInput(key, type) {
  if (type !== "press" && type !== "release") return null;
  if (key in BUTTONS) return pb.message(11, [pb.message(1, [pb.uint(1, BUTTONS[key]), pb.uint(2, type === "press" ? 0 : 1)])]);
  if (type === "release") return null;
  if (key === "up" || key === "down") return pb.message(11, [pb.message(3, [pb.sint(1, key === "up" ? 1 : -1)])]);
  if (key in SWITCH) return pb.message(11, [pb.message(2, [pb.uint(1, SWITCH[key])])]);
  return null;
}

/** A State carrying the front display's frame: Frame{screen FRONT, 72×16, encoding PLAIN, pixel_format RGB888}. */
export function encodeFrame(bytes, now = Date.now()) {
  const frame = pb.message(10, [pb.uint(1, 0), pb.uint(2, 72), pb.uint(3, 16), pb.uint(4, 0), pb.uint(5, 0), pb.bytes(6, [...bytes])]);
  return Uint8Array.from([...pb.fixed64(1, Math.round(now)), ...pb.message(2, [frame])]);
}

// ---------------------------------------------------------------- WebSocket

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? [0x80 | opcode, len] : len < 65536 ? [0x80 | opcode, 126, len >> 8, len & 255] : null;
  if (!head) {
    const h = Buffer.alloc(10);
    h[0] = 0x80 | opcode;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(len), 2);
    return Buffer.concat([h, Buffer.from(payload)]);
  }
  return Buffer.concat([Buffer.from(head), Buffer.from(payload)]);
}

// How much of what a client sends the bar's web server holds at most (MG_MAX_RECV_SIZE, as for a request: server.mjs).
const RECV_MAX = 256 * 1024;

// How much the server keeps waiting to go out to a client that does not read: past it the client is let go of.
const SEND_MAX = 256 * 1024;

/**
 * Parses client frames (always masked); calls onMessage(opcode, payload) for each complete one, and fail(code) for one
 * that ends the connection: a control frame longer than 125 bytes (1002, a protocol error, RFC 6455 §5.5) and a frame
 * larger than the bar would hold (1009).
 */
function reader(fail, onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let pos = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        pos = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        pos = 10;
      }
      const masked = (buf[1] & 0x80) !== 0;
      const maskPos = pos;
      if (masked) pos += 4;
      if (opcode & 0x08 && len > 125) return fail(1002);
      if (pos + len > RECV_MAX) return fail(1009);
      if (buf.length < pos + len) return;
      const payload = Buffer.from(buf.subarray(pos, pos + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskPos + (i % 4)];
      buf = buf.subarray(pos + len);
      onMessage(opcode, payload);
    }
  };
}

/**
 * Attaches the state stream to an http.Server. Returns { clients, close }; close() ends the stream for good: the
 * timers stop and every connection it took over from the server is closed. `admit(req)` is the entry guard's word
 * on a request (entry-guard.mjs): a connection it refuses gets its 403, on any path, before anything else.
 */
export function attachStateStream(server, device, { admit }) {
  if (typeof admit !== "function") throw new TypeError("attachStateStream needs the entry guard's admit()");
  const clients = new Set();
  // Every connection handed over by the server, a stream's client or not: the server no longer closes them.
  const sockets = new Set();
  // The bar's clock (device.mjs barTime), as the time of every message.
  const now = () => device.barTime();
  // A frame for a client, unless it has left too much unread: then it is let go of.
  const put = (c, bytes) => (c.socket.writableLength > SEND_MAX ? c.close() : c.socket.write(bytes));
  const send = (c, bytes) => c.enabled && put(c, frame(2, bytes));
  const sendAll = async (c) => send(c, encodeUpdates(Object.values(await collectState(device)), now()));

  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // The server has let go of the connection, its handler of errors too: a client that went away is no error here.
    socket.on("error", () => socket.destroy());
    const verdict = admit(req);
    if (!verdict.ok) {
      const text = JSON.stringify({ error: verdict.error });
      socket.end(`HTTP/1.1 ${verdict.status} Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
      return;
    }
    let path = null;
    try {
      path = new URL(req.url, "http://localhost").pathname;
    } catch {
      // Not a path at all ("//[" makes a host of it): nothing is there.
    }
    const wsKey = req.headers["sec-websocket-key"];
    if (path !== "/api/status/ws" || !wsKey) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(wsKey + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const close = () => {
      clients.delete(client);
      socket.destroy();
    };
    const client = { socket, enabled: false, close };
    clients.add(client);
    // A closing frame with the reason, then the connection is closed: once the frame is out, or after a second for a
    // client that reads nothing.
    const fail = (code) => {
      clients.delete(client);
      if (socket.writableEnded) return;
      socket.end(frame(8, Buffer.from([code >> 8, code & 0xff])), () => socket.destroy());
      const late = setTimeout(() => socket.destroy(), 1000);
      socket.once("close", () => clearTimeout(late));
    };
    socket.on(
      "data",
      reader(fail, (opcode, payload) => {
        if (opcode === 8) return close();
        if (opcode === 9) return put(client, frame(10, payload));
        if (opcode !== 1) return;
        try {
          // api_status_streaming.c's client_on_message: "enable" turns the stream on or off, "send": "all" asks for
          // the whole state.
          const message = JSON.parse(payload.toString());
          const wasEnabled = client.enabled;
          if (typeof message.enable === "boolean") client.enabled = message.enable;
          if ((client.enabled && !wasEnabled) || (message.send === "all" && client.enabled)) {
            sendAll(client).catch(() => {});
            send(client, encodeFrame(device.screen.frame(0), now()));
          }
        } catch {
          // Ignore what isn't a request of the stream.
        }
      }),
    );
    socket.on("error", close);
    socket.on("close", () => clients.delete(client));
  });

  // The bar pushes a part of its state when it changes. Here the state is looked at four times a second, and what
  // differs from what was sent last goes out; once a second everything does.
  let sent = {};
  let refreshed = 0;
  let busy = false;
  const states = setInterval(async () => {
    if (busy || ![...clients].some((c) => c.enabled)) return;
    busy = true;
    try {
      const updates = await collectState(device);
      const whole = computerNow() - refreshed >= REFRESH_INTERVAL_MS;
      const changed = Object.entries(updates).filter(([tag, bytes]) => whole || String(bytes) !== String(sent[tag]));
      sent = updates;
      if (whole) refreshed = computerNow();
      if (changed.length) {
        const message = encodeUpdates(changed.map(([, bytes]) => bytes), now());
        for (const c of clients) send(c, message);
      }
    } finally {
      busy = false;
    }
  }, STATE_INTERVAL_MS);
  states.unref();

  // Key presses, as they happen.
  device.events.on("key", (key, type) => {
    const update = encodeInput(key, type);
    if (!update) return;
    const message = encodeUpdates([update], now());
    for (const c of clients) send(c, message);
  });

  // The screen streamer sends a frame only when it differs from the last one.
  let last = "";
  const frames = setInterval(() => {
    if (![...clients].some((c) => c.enabled)) return;
    const bytes = device.screen.frame(0);
    const key = Buffer.from(bytes).toString("base64");
    if (key === last) return;
    last = key;
    const message = encodeFrame(bytes, now());
    for (const c of clients) send(c, message);
  }, FRAME_INTERVAL_MS);
  frames.unref();

  const close = () => {
    clearInterval(states);
    clearInterval(frames);
    for (const socket of sockets) socket.destroy();
  };
  return { clients, close };
}
