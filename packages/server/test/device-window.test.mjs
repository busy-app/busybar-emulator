// The device window's texts (EMU-226): the firmware badge's tooltip, the sound note, the app list while the bar is off,
// and the console lines the server writes. The window's script runs here on a small stand-in for the browser's DOM,
// so these tests need neither a browser nor a running emulator: node --test emulator/packages/server/test/device-window.test.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { attachDeviceWindow } from "../device-window.mjs";
import { Device } from "../device.mjs";
import { loadFirmware } from "../firmware.mjs";

const here = join(dirname(fileURLToPath(import.meta.url)), ".."); // packages/server
const firmwareJson = JSON.parse(readFileSync(join(here, "../engine/firmware.json"), "utf8"));

// ---------------------------------------------------------------- a stand-in for the page

/** An element that keeps what the window's script sets on it and absorbs everything else. */
function element(tag = "div") {
  const listeners = {};
  const classes = new Set();
  const inner = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    textContent: "",
    title: "",
    hidden: false,
    checked: false,
    value: "",
    dataset: {},
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    children: [],
    scrollTop: 0,
    clientHeight: 0,
    scrollHeight: 0,
    clientWidth: 0,
    width: 0,
    height: 0,
    get className() {
      return [...classes].join(" ");
    },
    set className(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
      contains: (c) => classes.has(c),
    },
    _html: "",
    get innerHTML() {
      return this._html;
    },
    set innerHTML(v) {
      this._html = v;
      this.children = [];
      inner.clear();
    },
    get innerText() {
      return this.children.length ? this.children.map((c) => c.innerText).join("\n") : (this._html.replace(/<[^>]*>/g, "") || this.textContent);
    },
    get childElementCount() {
      return this.children.length;
    },
    get firstElementChild() {
      return this.children[0];
    },
    replaceChildren(...nodes) {
      this._html = "";
      this.children = nodes;
    },
    append(...nodes) {
      this.children.push(...nodes);
    },
    remove() {},
    focus() {},
    contains: (other) => other === el,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    getClientRects: () => [],
    querySelector(selector) {
      if (!inner.has(selector)) inner.set(selector, element());
      return inner.get(selector);
    },
    querySelectorAll: () => [],
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    setPointerCapture() {},
    blur() {},
    focus() {},
    setAttribute(name, value) {
      this.attributes = { ...(this.attributes ?? {}), [name]: String(value) };
    },
    prepend(...nodes) {
      this.children.unshift(...nodes);
    },
    contains: () => false,
    closest: () => null,
    replaceWith() {},
    getContext: () => context(),
    // Where the element is on the page, for what follows a pointer around it.
    box: { left: 0, top: 0, width: 0, height: 0 },
    getBoundingClientRect() {
      return this.box;
    },
    /** Sends the element an event, as the page would. */
    fire(type, event = {}) {
      (listeners[type] ?? []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {}, target: el, pointerId: 1, key: "", ...event }));
    },
    listeners,
  };
  return el;
}

function context() {
  return new Proxy(
    {},
    {
      get: (_, name) => (name === "createImageData" ? (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}),
      set: () => true,
    },
  );
}

/** A Web Audio context that starts in `initial` and, if `turnsOn`, goes running by itself a moment later. */
function audioContextClass({ initial, turnsOn = false, resumes = true }) {
  return class FakeAudioContext {
    static made = [];
    constructor() {
      this.state = initial;
      this.currentTime = 0;
      this.destination = {};
      this.listeners = [];
      FakeAudioContext.made.push(this);
      if (turnsOn) setTimeout(() => this.become("running"), 5);
    }
    become(state) {
      this.state = state;
      this.listeners.forEach((fn) => fn());
      this.onstatechange?.();
    }
    addEventListener(type, fn) {
      if (type === "statechange") this.listeners.push(fn);
    }
    resume() {
      return resumes ? Promise.resolve().then(() => this.become("running")) : new Promise(() => {});
    }
    createGain() {
      return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} }, connect() {} };
    }
    createBuffer(_channels, length) {
      return { getChannelData: () => new Float32Array(length) };
    }
    createBufferSource() {
      return { connect() {}, start() {}, stop() {} };
    }
  };
}

/**
 * Runs the window's script on a stand-in page. `apps` answers GET /api/apps/list: a list of apps, a status code, or
 * "unreachable" for a request that does not get through. `settings` names apps with a settings file: id → { schema,
 * values, put? } (put: the status PUT answers with). `actions` is the desktop app's window.emulatorActions, `stage3d`
 * its window.emulatorStage3D; left out, the page has none, as in a browser. `now` is the page's clock, milliseconds.
 * Returns the page's elements, its window listeners, the event stream to drive it and the requests it made.
 */
function openWindow({ AudioContext = audioContextClass({ initial: "suspended" }), apps = () => [], hash = "", settings = {}, actions, stage3d, now = () => Date.now(), filters = [], scripts = [], kept = null, record = true } = {}) {
  const elements = new Map();
  const windowListeners = {};
  const requests = [];
  let stream = null;
  // The controls the page finds by what they are: the positions of the mode switch, the keys, the wheel's buttons.
  const withData = (key, values) => values.map((value) => Object.assign(element("button"), { dataset: { [key]: value } }));
  const found = {
    "[data-select]": withData("select", ["busy", "custom", "off", "apps", "settings"]),
    "[data-key]:not(.wheel-ok)": withData("key", ["start", "back"]),
    "[data-wheel]": withData("wheel", ["down", "up"]),
    // The console's filters, when a test gives them: [kind, checked].
    ".filters input": filters.map(([kind, checked]) => Object.assign(element("input"), { dataset: { kind }, checked })),
    // The opened app's tabs (layout V2).
    "#app-tabs [data-tab]": withData("tab", ["settings", "catalog", "files"]),
  };
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element(selector === "#front" || selector === "#back" ? "canvas" : "div"));
      return elements.get(selector);
    },
    querySelectorAll(selector) {
      const key = /^\[data-key="(\w+)"\]$/.exec(selector)?.[1];
      return key ? found["[data-key]:not(.wheel-ok)"].filter((el) => el.dataset.key === key) : (found[selector] ?? []);
    },
    createElement: (tag) => element(tag),
    body: element("body"),
    get activeElement() {
      return null;
    },
  };
  class EventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      stream = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    }
    emit(type, data) {
      (this.listeners[type] ?? []).forEach((fn) => fn({ data: JSON.stringify(data) }));
    }
  }
  const fetch = async (url, options = {}) => {
    const method = options.method ?? "GET";
    requests.push({ method, url: String(url), ...(options.body === undefined ? {} : { body: options.body }) });
    const address = new URL(String(url), "http://bar");
    if (address.pathname === "/api/apps/settings") {
      const kept = settings[address.searchParams.get("app_id")];
      if (!kept) return { ok: false, status: 404, json: async () => ({ error: "Application has no settings schema" }) };
      if (method === "PUT") return { ok: (kept.put ?? 200) === 200, status: kept.put ?? 200, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ version: kept.schema.version, values: structuredClone(kept.values) }) };
    }
    if (address.pathname === "/api/storage/read" && address.searchParams.get("path").endsWith("/appmeta/settings.json")) {
      const kept = settings[address.searchParams.get("path").split("/")[3]];
      return kept ? { ok: true, status: 200, json: async () => structuredClone(kept.schema) } : { ok: false, status: 404, json: async () => ({}) };
    }
    if (String(url).startsWith("/api/apps/list")) {
      const answer = apps();
      if (answer === "unreachable") throw new TypeError("Failed to fetch");
      if (typeof answer === "number") return { ok: false, status: answer, json: async () => ({ error: "off" }) };
      return { ok: true, status: 200, json: async () => ({ apps: answer }) };
    }
    // Restart BUSY Bar, waited for: the time it took.
    if (address.pathname === "/_emu/power" && address.searchParams.get("wait") === "1") return { ok: true, status: 200, json: async () => ({ powered: true, ms: 1234 }) };
    // A sound of the bar: two samples. Anything else: nothing.
    return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(String(url).startsWith("/_emu/audio") ? 4 : 0) };
  };
  const sandbox = {
    document,
    EventSource,
    fetch,
    AudioContext,
    ResizeObserver: class {
      observe() {}
    },
    getComputedStyle: () => ({}),
    addEventListener: (type, fn) => (windowListeners[type] ??= []).push(fn),
    performance: { now },
    location: { host: "127.0.0.1:8861", origin: "http://127.0.0.1:8861", hash },
    ...(actions ? { emulatorActions: actions } : {}),
    // The publishing flow (publish.js) is a script of its own, with tests of its own: here it notes that it was opened.
    ...(actions ? { emulatorPublish: { open: ({ folder, account }) => actions.calls?.push(account ? ["publish.open", folder, account] : ["publish.open", folder]) } } : {}),
    // Create app's pop-up (create-app.js) too: here it keeps what the window opened it with, for a test to press Create.
    ...(actions ? { emulatorCreateApp: { open: (context) => (actions.calls?.push(["createApp.open", { examples: context.examples.map((one) => one.name), taken: context.taken }]), (actions.popUp = context)) } } : {}),
    ...(stage3d ? { emulatorStage3D: stage3d } : {}),
    // What the window keeps across restarts, when a test gives it a store (a Map).
    ...(kept ? { localStorage: { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)) } } : {}),
    URL,
    URLSearchParams,
    devicePixelRatio: 1,
    innerWidth: 1440,
    innerHeight: 900,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    // The page's own timers (a notice that goes by itself) do not keep the test run alive.
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  // The page's other scripts that come before it (welcome.js), as index.html loads them.
  for (const name of scripts) vm.runInContext(readFileSync(join(here, "legacy-window", name), "utf8"), sandbox, { filename: name });
  // The Record button is shown (RECORD_BUTTON); `record: false` turns it off, as the flag would.
  const source = readFileSync(join(here, "legacy-window/window.js"), "utf8");
  assert.match(source, /^const RECORD_BUTTON = true;$/m);
  vm.runInContext(record ? source : source.replace(/^const RECORD_BUTTON = true;$/m, "const RECORD_BUTTON = false;"), sandbox, { filename: "window.js" });
  const fire = (type, event = {}) => (windowListeners[type] ?? []).forEach((fn) => fn({ preventDefault() {}, target: element(), key: "", ...event }));
  /** The requests the page has made since the last look, as "METHOD address". */
  const sent = () => requests.splice(0).map(({ method, url }) => `${method} ${url}`);
  return { $: (s) => document.querySelector(s), all: (s) => document.querySelectorAll(s), stream, fire, location: sandbox.location, requests, sent, global: sandbox };
}

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const state = (status = {}) => ({ running: null, selector: "apps", barSpeed: true, status: { wifi: true, usb: true, battery: 100, powered: true, ...status } });
const hello = { firmware: { name: "1.3.1", commit: "8edd2da4", summary: "The summary." }, apiVersion: "27.10.0" };

// ---------------------------------------------------------------- 1. the firmware badge

// What a person using the emulator must not see in the badge's tooltip: the project's notes to itself.
const INTERNAL = [/hackathon/i, /participant/i, /\brc\b/i, /\bFW-\d+/, /\b\d{1,2}\.\d{1,2}\.\d{4}\b/, /(?<![\d.])\d{1,2}\.\d{2}(?![\d.])/, /\p{Script=Cyrillic}/u];

test("each firmware has a summary for the person using the emulator, without the project's internal notes", () => {
  for (const [name, version] of Object.entries(firmwareJson.versions)) {
    assert.equal(typeof version.summary, "string", `${name}: no "summary"`);
    // firmware.json goes to the public repository whole: no field of it carries the project's notes.
    for (const [field, value] of Object.entries(version)) {
      if (field !== "commit") for (const pattern of INTERNAL) assert.doesNotMatch(String(value), pattern, `${name}.${field}: "${value}"`);
    }
    assert.match(version.summary, /^[A-Z]/, `${name}: the summary starts with a capital letter`);
    for (const pattern of INTERNAL) assert.doesNotMatch(version.summary, pattern, `${name}: "${version.summary}"`);
  }
  // What an app author needs to know about the two builds.
  assert.match(firmwareJson.versions["1.3.1"].summary, /console\.warn/);
  assert.match(firmwareJson.versions["1.3.1"].summary, /Back/);
  assert.match(firmwareJson.versions.dev.summary, /console\.warn exists/);
  assert.match(firmwareJson.versions.dev.summary, /Back/);
});

// A test that hangs fails after this long. One that leaves something running (the window's frame timer, a bar) would
// keep the run alive after the last test: the watchdog ends it with a failure instead.
const LOUD = { timeout: 10_000 };
after(() => {
  setTimeout(() => {
    console.error("device-window.test.mjs: something the tests started is still running 10 s after the last test");
    process.exit(1);
  }, 10_000).unref();
});

test("the window's hello carries the firmware's summary and not its internal note", LOUD, async () => {
  const device = {
    firmware: loadFirmware(),
    events: new EventEmitter(),
    audio: { events: new EventEmitter(), samples: () => null },
    screen: { frame: () => new Uint8Array(8), asleep: () => false },
    running: null,
    selector: "apps",
    speed: null,
    state: { wifi: true, usb: true, battery: 100, volume: 50 },
    powered: true,
  };
  const handle = attachDeviceWindow(device, { apiVersion: "27.10.0" });
  const req = new EventEmitter();
  let written = "";
  const res = Object.assign(new EventEmitter(), { writeHead() {}, write: (chunk) => (written += chunk), end() {} });
  try {
    assert.equal(handle(req, res, new URL("http://127.0.0.1/_emu/events")), true);
  } finally {
    // The window goes away and the server stops: nothing of the window is left checking frames.
    res.emit("close");
    req.emit("close");
    handle.close?.();
  }
  const data = written.match(/^event: hello\ndata: (.*)$/m);
  assert.ok(data, "a hello event");
  const { firmware } = JSON.parse(data[1]);
  const expected = firmwareJson.versions[firmware.name];
  assert.equal(firmware.summary, expected.summary);
  assert.deepEqual(Object.keys(firmware).sort(), ["commit", "name", "summary"], "the window gets what it shows and nothing else");
});

test("each file of the window is served with its own type, the picture of the BUSY Bar as image/png, the font as font/ttf", () => {
  const device = { events: new EventEmitter(), audio: { events: new EventEmitter() }, state: {}, screen: {} };
  const handle = attachDeviceWindow(device, { apiVersion: "27.10.0" });
  // Every file, those of the folders inside too (icons/), by the path the page asks for it.
  const files = readdirSync(join(here, "legacy-window"), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => relative(join(here, "legacy-window"), join(entry.parentPath, entry.name)).split(sep).join("/"));
  assert.ok(files.includes("busybar-device.png") && files.includes("icons/busy-sprite.svg") && files.includes("icons/busy/index.json"), files.slice(0, 20).join(", "));
  const served = {};
  for (const name of ["", ...files]) {
    let head = null;
    const res = { writeHead: (status, headers) => (head = { status, type: headers["Content-Type"] }), end() {} };
    assert.equal(handle({}, res, new URL(`http://127.0.0.1/emulator/${name}`)), true);
    assert.equal(head.status, 200, name);
    served[name || "/emulator/"] = head.type;
  }
  assert.equal(served["busybar-device.png"], "image/png");
  assert.equal(served["Inter.ttf"], "font/ttf");
  assert.equal(served["icons/busy-sprite.svg"], "image/svg+xml");
  assert.equal(served["icons/busy.js"], "text/javascript");
  assert.equal(served["/emulator/"], "text/html; charset=utf-8");
  for (const [name, type] of Object.entries(served)) assert.notEqual(type, "application/octet-stream", `${name} has a type of its own`);
});

test("the firmware's tooltip is the summary and the build's commit", () => {
  const page = openWindow();
  page.stream.emit("hello", hello);
  assert.equal(page.$("#firmware").title, "The summary.\nCommit 8edd2da4");
  assert.equal(page.$("#firmware").textContent, "Firmware 1.3.1");
  assert.equal(page.$("#api").textContent, "API 27.10.0");
});

// ---------------------------------------------------------------- the page's own files (the window's look)

const windowFile = (name) => readFileSync(join(here, "legacy-window", name), "utf8");

test("the page has every element its script looks up, and every key, position and turn of the BUSY Bar", () => {
  const html = windowFile("index.html");
  const script = windowFile("window.js");
  const ids = [...script.matchAll(/\$\("#([\w-]+)"\)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 15, `ids the script looks up: ${ids.length}`);
  for (const id of new Set(ids)) assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} is in the page once`);
  for (const key of ["start", "back", "ok"]) assert.match(html, new RegExp(`<button[^>]* data-key="${key}"`), `a button for ${key}`);
  for (const turn of ["up", "down"]) assert.match(html, new RegExp(`<button[^>]* data-wheel="${turn}"`), `a button that turns the wheel ${turn}`);
  // The mode switch, in the order of its positions on the bar, each named as the bar names it.
  assert.deepEqual([...html.matchAll(/<button data-select="(\w+)" title="([^"]+)">([^<]+)<\/button>/g)].filter((m) => m[3].toUpperCase() === m[2]).map((m) => [m[1], m[2]]), [["busy", "BUSY"], ["custom", "CUSTOM"], ["off", "OFF"], ["apps", "APPS"], ["settings", "SETTINGS"]]);
  // A control that shows a picture and no words is named for a screen reader and has a tooltip.
  const pictures = [...html.matchAll(/<button[^>]*>\s*<svg[^>]*>\s*<use[^>]*\/>\s*<\/svg>\s*<\/button>/g)].map(([tag]) => tag);
  assert.ok(pictures.length >= 5, `buttons that are a picture: ${pictures.length}`);
  for (const tag of pictures) {
    assert.match(tag, / aria-label="[^"]+"/, tag);
    assert.match(tag, / title="[^"]+"/, tag);
  }
  // The controls under the bar: the window's own buttons, each named for a screen reader; the two RGB LEDs beside
  // Start / Pause; icons only from BUSY's set (the test of the icons, below). Nothing of an illustration is left.
  const dock = html.slice(html.indexOf('<div class="dock"'), html.indexOf('<section class="card device-card"'));
  assert.deepEqual([...dock.matchAll(/<(?:button|div) class="(key-start|key-back|wheel-ok|lever)"[^>]* aria-label="([^"]+)"/g)].map((m) => [m[1], m[2]]), [["lever", "Mode switch"], ["key-start", "Start / Pause"], ["key-back", "Back"], ["wheel-ok", "OK / Skip"]]);
  assert.deepEqual([...dock.matchAll(/<span class="led \w+" id="(led-\w+)"/g)].map((m) => m[1]), ["led-left", "led-right"]);
  assert.ok(dock.indexOf('id="led-left"') < dock.indexOf('class="key-start"') && dock.indexOf('class="key-start"') < dock.indexOf('id="led-right"'), "the LEDs at the two ends of Start / Pause");
  // The back display is the bar's card's, under the controls (layout V2).
  assert.ok(html.indexOf('class="dock"') < html.indexOf('class="oled-frame"') && html.indexOf('class="card device-card"') < html.indexOf('class="oled-frame"'), "the back display in the BUSY Bar's card, under the controls");
  assert.doesNotMatch(html, /device-top/);
  assert.equal(existsSync(join(here, "legacy-window", "device-top.svg")), false);
  // The 3D module draws in the box of the bar's picture; the controls and the back display are outside it.
  const view = html.slice(html.indexOf('id="device-view"'), html.indexOf('class="dock"'));
  assert.match(view, /id="bar"/);
  assert.doesNotMatch(view, /id="back"|class="strip"|class="oled-frame"/);
});

test("the page loads nothing from another address: its font is a file of its own", () => {
  const css = windowFile("window.css");
  const addresses = [...`${windowFile("index.html")}\n${css}`.matchAll(/(?:href|src)="([^"]+)"|url\(\s*["']?([^"')]+)/g)].map((m) => m[1] ?? m[2]);
  assert.ok(addresses.length >= 5, addresses.join(" "));
  // Its own files (those of its folders too, and an icon of its sprite: /emulator/icons/busy-sprite.svg#bi-…), the
  // icons of its own page (#…), and pictures written into the style sheet itself; and two links of the bar card that
  // load nothing into the page, the bar's own address and its API documentation (bar-address).
  for (const address of addresses) assert.match(address, /^(\/emulator\/[\w.?=-]+(\/[\w.?=-]+)*(#[\w-]+)?|#[\w-]+|data:image\/svg\+xml,.*|\/|\/docs\/)$/, address);
  assert.match(css, /@font-face\s*{[^}]*font-family:\s*Inter;[^}]*url\(\/emulator\/Inter\.ttf\)/);
  // The one address there is names the kind of picture (SVG) and is not loaded.
  assert.doesNotMatch(`${windowFile("index.html")}${css}`.replaceAll("xmlns='http://www.w3.org/2000/svg'", ""), /https?:\/\//);
});

test("every icon of the window is one of BUSY's own set, and the window draws none of its own", () => {
  const html = windowFile("index.html");
  const script = windowFile("window.js");
  const css = windowFile("window.css");
  const set = new Set(readdirSync(join(here, "legacy-window/icons/busy")).filter((name) => name.endsWith(".svg")).map((name) => name.slice(0, -4)));
  // The icons the page shows from the start, and those its script puts in: icon("name"), and a button's picture.
  const inPage = [...html.matchAll(/busy-sprite\.svg#bi-([a-z0-9-]+)"/g)].map((m) => m[1]);
  const inScript = [
    ...script.matchAll(/\bicon\((?:[^()"`]*\? )?"([a-z0-9-]+)"(?: : "([a-z0-9-]+)")?\)/g),
    ...script.split("\n").filter((line) => line.includes("button(")).flatMap((line) => [...line.matchAll(/, (?:on \? )?"([a-z0-9-]+)"(?: : "([a-z0-9-]+)")?\)[;,]?$/g)]),
    // An icon put in only when it is another one (setIcon): the battery, the speaker, Record.
    ...script.matchAll(/\bsetIcon\([^,]+, (?:[^"()]*\? )?"([a-z0-9-]+)"(?: : "([a-z0-9-]+)")?\)/g),
    // An item of a menu: its words, then its picture.
    ...script.matchAll(/\bmenuItem\([^,]+, (?:on \? )?"([a-z0-9-]+)"(?: : "([a-z0-9-]+)")?/g),
  ].flatMap((m) => m.slice(1).filter(Boolean));
  assert.ok(inPage.length >= 8 && inScript.length >= 8, `${inPage.length} in the page, ${inScript.length} in the script: ${inScript.join(" ")}`);
  assert.ok(["refresh", "copy", "rocket", "folder", "apps", "control-play", "control-stop", "sound", "sound-off"].every((name) => inScript.includes(name)), inScript.join(" "));
  for (const name of [...inPage, ...inScript, ...[1, 2, 3, 4, 5].flatMap((n) => [`battery-${n}`, `battery-charging-${n}`])]) assert.ok(set.has(name), `icons/busy has no ${name}`);
  // No picture is drawn in the page or its style sheet: the illustration's parts and the icons are files of their own.
  assert.doesNotMatch(html, /<(path|symbol|circle|rect|line|polygon)\b/);
  assert.doesNotMatch(css, /data:image/);
});

test("the window's font is the local web's own, byte for byte", () => {
  const own = readFileSync(join(here, "legacy-window/Inter.ttf"));
  for (const name of Object.keys(firmwareJson.versions)) {
    const fonts = join(here, "../engine/build", name, "web/_nuxt");
    const inter = readdirSync(fonts).filter((file) => /^Inter-[0-9a-f]+\.ttf$/.test(file));
    assert.equal(inter.length, 1, `${name}: ${inter.join(", ")}`);
    assert.ok(own.equals(readFileSync(join(fonts, inter[0]))), `${name}: ${inter[0]} differs from the window's Inter.ttf`);
  }
});

// ---------------------------------------------------------------- the notice of a new version (EMU-205)

// The desktop app tells the page of a newer version in the fragment of its address; the page shows one line. Anyone
// can write a fragment (a link on any web page opens this page with one), so the page takes the version from it and
// nothing else: the link is the page's own, to that version among the emulator's releases.
const RELEASE = "https://github.com/busy-app/busybar-emulator/releases/tag/v0.2.0";
const fragment = (version, page) => `#update=${encodeURIComponent(version)}${page === undefined ? "" : `&page=${encodeURIComponent(page)}`}`;

test("without a notice in the address the line of the new version is hidden", () => {
  const page = openWindow();
  assert.equal(page.$("#update-note").hidden, true);
});

test("a notice in the address shows the version and the release page, at the start and when the address changes", () => {
  const page = openWindow({ hash: fragment("0.2.0") });
  assert.equal(page.$("#update-note").hidden, false);
  assert.equal(page.$("#update-version").textContent, "0.2.0");
  assert.equal(page.$("#update-link").href, RELEASE);
  // The app takes the notice away, or changes it: the page follows without loading again.
  page.location.hash = "#";
  page.fire("hashchange");
  assert.equal(page.$("#update-note").hidden, true);
  page.location.hash = fragment("0.3.0");
  page.fire("hashchange");
  assert.equal(page.$("#update-note").hidden, false);
  assert.equal(page.$("#update-version").textContent, "0.3.0");
  assert.equal(page.$("#update-link").href, RELEASE.replace("0.2.0", "0.3.0"));
});

test("the link of the notice is never taken from the address: a page named there is ignored", () => {
  for (const address of [
    "https://github.com/attacker/busybar-emulator/releases/download/v9.9.9/BUSY-Bar-Emulator.dmg",
    "https://github.com/busy-app/busybar-emulator/releases/tag/v1.0.0",
    "https://evil.example/releases",
    "https://github.com.evil.example/x",
    "http://github.com/busy-app/busybar-emulator",
    "javascript:alert(1)",
    "not an address",
    "",
  ]) {
    const page = openWindow({ hash: fragment("9.9.9", address) });
    assert.equal(page.$("#update-note").hidden, false, address);
    assert.equal(page.$("#update-version").textContent, "9.9.9", address);
    assert.equal(page.$("#update-link").href, "https://github.com/busy-app/busybar-emulator/releases/tag/v9.9.9", address);
  }
  // Named twice, or with the version's own name: the same.
  const twice = openWindow({ hash: "#page=https%3A%2F%2Fevil.example%2F&update=9.9.9&page=https%3A%2F%2Fevil.example%2F" });
  assert.equal(twice.$("#update-link").href, "https://github.com/busy-app/busybar-emulator/releases/tag/v9.9.9");
});

test("only a version written as one is shown: numbers and dots, and an optional pre-release", () => {
  for (const version of ["0.2.0", "12.0.3", "0.1.0-beta.2", "1.2.3-rc.1", "1.2.3-beta-2", "0.0.1-0", `1.0.0-${"a".repeat(64)}`]) {
    const page = openWindow({ hash: fragment(version) });
    assert.equal(page.$("#update-note").hidden, false, version);
    assert.equal(page.$("#update-version").textContent, version);
    assert.equal(page.$("#update-link").href, `https://github.com/busy-app/busybar-emulator/releases/tag/v${version}`);
  }
  for (const version of [
    "",
    "latest",
    "1.2",
    "1.2.3.4",
    "v1.2.3",
    "<b>0.2.0</b>",
    "0.2.0 ",
    "0.2.0\n",
    "0.2.0-",
    "0.2.0-rc 1",
    "0.2.0-rc/../../../attacker/x",
    "0.2.0/../../../../attacker",
    "0.2.0?x=1",
    "0.2.0#x",
    "0.2.0-rc%2F..",
    "0.2.0+build",
    "1234567.0.0",
    `0.2.0-${"a".repeat(65)}`,
    "0.2.0-.",
    "0.2.0--",
    "٠.٢.٠",
  ]) {
    const page = openWindow({ hash: fragment(version) });
    assert.equal(page.$("#update-note").hidden, true, JSON.stringify(version));
  }
});

// ---------------------------------------------------------------- "App settings": the local web on a tab (EMU-209)

/** Runs /emulator/local-web.js as its page would, with what the local web's storage holds; returns where it went. */
function openLocalWebOn(search, kept = {}) {
  const storage = new Map(Object.entries(kept));
  const went = [];
  const sandbox = {
    URLSearchParams,
    location: { search, replace: (to) => went.push(to) },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(here, "legacy-window/local-web.js"), "utf8"), sandbox, { filename: "local-web.js" });
  return { went, storage: Object.fromEntries(storage) };
}

test("the device window's App settings leads to the local web's page for the Apps tab", () => {
  const html = readFileSync(join(here, "legacy-window/index.html"), "utf8");
  const link = html.match(/<a [^>]*id="app-settings"[^>]*>([^<]*)<\/a>/);
  assert.ok(link, "no App settings link");
  assert.equal(link[1], "App settings in Local Web");
  assert.match(link[0], /href="\/emulator\/local-web\.html\?tab=apps"/);
  // A new window: the desktop app shows the local web's own window for it, a browser a new tab.
  assert.match(link[0], /target="_blank"/);
});

test("the page for a tab writes the tab where the local web keeps it and goes on to the local web", () => {
  assert.deepEqual(openLocalWebOn("?tab=apps"), { went: ["/"], storage: { tabStore: '{"showHiddenTabs":false,"currentTab":"apps"}' } });
  // What the local web kept besides the tab stays.
  const kept = openLocalWebOn("?tab=settings", { tabStore: '{"currentTab":"network","showHiddenTabs":true}', other: "1" });
  assert.deepEqual(JSON.parse(kept.storage.tabStore), { currentTab: "settings", showHiddenTabs: true });
  assert.equal(kept.storage.other, "1");
  assert.deepEqual(openLocalWebOn("?tab=apps", { tabStore: "not json" }).storage, { tabStore: '{"showHiddenTabs":false,"currentTab":"apps"}' });
});

test("a tab the local web does not have is not written; the page still goes on to the local web", () => {
  for (const search of ["", "?tab=", "?tab=nope", "?tab=__proto__", "?tab=apps%22%3A1", "?other=apps"]) {
    assert.deepEqual(openLocalWebOn(search, { tabStore: '{"currentTab":"network"}' }), { went: ["/"], storage: { tabStore: '{"currentTab":"network"}' } }, search);
  }
});

// ---------------------------------------------------------------- 2. the sound note

const SOUND_ON = "Sound on";
const SOUND_OFF = "Click anywhere to turn sound on";

test("the sound note says sound is off before the window is touched", () => {
  const page = openWindow();
  assert.equal(page.$("#audio-note").textContent, SOUND_OFF);
});

test("a click turns the sound note on at once when the new audio context is already running", async () => {
  const page = openWindow({ AudioContext: audioContextClass({ initial: "running" }) });
  page.fire("pointerdown");
  await settle();
  assert.equal(page.$("#audio-note").textContent, SOUND_ON);
});

test("a click turns the sound note on when the audio context starts running by itself, without resume", async () => {
  const page = openWindow({ AudioContext: audioContextClass({ initial: "suspended", turnsOn: true, resumes: false }) });
  page.fire("pointerdown");
  await settle();
  assert.equal(page.$("#audio-note").textContent, SOUND_ON);
});

test("a click while a sound plays unheard replaces the note about that sound", async () => {
  const page = openWindow({ AudioContext: audioContextClass({ initial: "suspended", turnsOn: true, resumes: false }) });
  page.stream.emit("hello", hello);
  page.stream.emit("audio", { action: "play", id: 1, seconds: 2, volume: 50 });
  await settle(1);
  // The note still says how to turn sound on; what was missed is in its tooltip.
  assert.equal(page.$("#audio-note").textContent, SOUND_OFF);
  assert.equal(page.$("#audio-note").title, "The BUSY Bar is playing a 2.0 s sound. Click anywhere to turn sound on");
  assert.equal(page.$("#audio-note").classList.contains("missed"), true);
  page.fire("pointerdown");
  await settle();
  assert.equal(page.$("#audio-note").textContent, SOUND_ON);
  assert.equal(page.$("#audio-note").title, SOUND_ON, "the speaker's tooltip is what it says");
  assert.equal(page.$("#audio-note").classList.contains("missed"), false);
});

test("a sound that plays heard is named in the note", async () => {
  const page = openWindow({ AudioContext: audioContextClass({ initial: "running" }) });
  page.stream.emit("hello", hello);
  page.fire("pointerdown");
  await settle();
  page.stream.emit("audio", { action: "play", id: 1, seconds: 0.5, volume: 50 });
  await settle();
  assert.equal(page.$("#audio-note").textContent, "Playing a 0.5 s sound");
  page.stream.emit("audio", { action: "stop" });
  assert.equal(page.$("#audio-note").textContent, SOUND_ON);
});

test("the sound note goes back to off when the browser suspends the audio", async () => {
  const AudioContext = audioContextClass({ initial: "running" });
  const page = openWindow({ AudioContext });
  page.fire("pointerdown");
  await settle();
  assert.equal(page.$("#audio-note").textContent, SOUND_ON);
  AudioContext.made[0].become("suspended");
  assert.equal(page.$("#audio-note").textContent, SOUND_OFF);
});

// ---------------------------------------------------------------- 3. the app list while the bar is off

const APP = { id: "app.test.one", name: "One", version: "1.0" };

test("with the BUSY Bar off, the app list says so and not that no apps are installed", async () => {
  let powered = true;
  const page = openWindow({ apps: () => (powered ? [APP] : 503) });
  page.stream.emit("hello", hello);
  page.stream.emit("state", state());
  await settle();
  assert.equal(page.$("#apps").children.length, 1);

  // As the server does it: the app list changes ("apps") while the bar shuts down, then the state says it is off.
  powered = false;
  page.stream.emit("apps", {});
  await settle();
  page.stream.emit("state", state({ powered: false }));
  await settle();
  assert.doesNotMatch(page.$("#apps").innerText, /No apps installed/);
  assert.match(page.$("#apps").innerText, /The BUSY Bar is off/);

  // Turned on again, the list is back.
  powered = true;
  page.stream.emit("apps", {});
  page.stream.emit("state", state());
  await settle();
  assert.equal(page.$("#apps").children.length, 1);
  assert.doesNotMatch(page.$("#apps").innerText, /The BUSY Bar is off/);
});

test("a window opened while the BUSY Bar is off does not say that no apps are installed", async () => {
  const page = openWindow({ apps: () => 503 });
  page.stream.emit("hello", hello);
  page.stream.emit("state", state({ powered: false }));
  await settle();
  assert.doesNotMatch(page.$("#apps").innerText, /No apps installed/);
  assert.match(page.$("#apps").innerText, /The BUSY Bar is off/);
});

test("a BUSY Bar that is on and lists no apps still says that no apps are installed", async () => {
  const page = openWindow({ apps: () => [] });
  page.stream.emit("hello", hello);
  page.stream.emit("state", state());
  await settle();
  assert.match(page.$("#apps").innerText, /No apps installed/);
});

// A list request that fails is not an empty list: the window keeps the list it had.
for (const [how, failure] of [["is answered with an error", 500], ["does not get through", "unreachable"]]) {
  test(`a list request that ${how} keeps the last list`, async () => {
    let answer = [APP];
    const page = openWindow({ apps: () => answer });
    page.stream.emit("hello", hello);
    page.stream.emit("state", state());
    await settle();
    assert.equal(page.$("#apps").children.length, 1);
    answer = failure;
    page.stream.emit("apps", {});
    await settle();
    assert.equal(page.$("#apps").children.length, 1, "the app is still listed");
    assert.doesNotMatch(page.$("#apps").innerText, /No apps installed/);
  });

  test(`a first list request that ${how} does not say that no apps are installed`, async () => {
    const page = openWindow({ apps: () => failure });
    page.stream.emit("hello", hello);
    page.stream.emit("state", state());
    await settle();
    assert.equal(page.$("#apps").children.length, 0);
    assert.doesNotMatch(page.$("#apps").innerText, /No apps installed/);
  });
}

// ---------------------------------------------------------------- bar-address: the card's address, API and Restart

test("the card shows the address of BUSY Bar with Copy, and the API version links to its documentation", async () => {
  const calls = [];
  const page = openWindow({ actions: { available: () => ({ shell: true }), browse: async (address) => (calls.push(["browse", address]), true), copy: async (text) => (calls.push(["copy", text]), true), projects: { list: async () => [] } } });
  page.stream.emit("hello", hello);
  await settle();
  assert.equal(page.$("#bar-address").textContent, "http://127.0.0.1:8861");
  assert.equal(page.$("#bar-address").href, "http://127.0.0.1:8861/");
  assert.equal(page.$("#api").textContent, "API 27.10.0");
  const html = readFileSync(join(here, "legacy-window/index.html"), "utf8");
  assert.match(html, /<a class="build api-docs" id="api" href="\/docs\/" target="_blank"/);
  assert.match(html, /id="bar-address-copy"[^>]*><svg class="bi"[^>]*><use href="\/emulator\/icons\/busy-sprite\.svg#bi-copy"\/>/);
  // In the desktop app both links go to the system's browser through the shell, the page itself opens nothing.
  let prevented = 0;
  page.$("#bar-address").href = "http://127.0.0.1:8861/";
  page.$("#api").href = "http://127.0.0.1:8861/docs/";
  page.$("#bar-address").fire("click", { preventDefault: () => prevented++ });
  page.$("#api").fire("click", { preventDefault: () => prevented++ });
  await settle();
  assert.equal(prevented, 2);
  page.$("#bar-address-copy").fire("click");
  await settle();
  assert.deepEqual(calls.filter(([what]) => what !== "projects"), [["browse", "http://127.0.0.1:8861/"], ["browse", "http://127.0.0.1:8861/docs/"], ["copy", "http://127.0.0.1:8861"]]);
  assert.equal(page.$("#bar-address-copy").title, "Copied");
});

test("in a browser the card's links are plain links: nothing is asked of a shell", async () => {
  const page = openWindow();
  page.stream.emit("hello", hello);
  await settle();
  let prevented = 0;
  page.$("#api").fire("click", { preventDefault: () => prevented++ });
  await settle();
  assert.equal(prevented, 0);
});

test("Restart BUSY Bar waits for the restart, turns meanwhile and says how long it took", async () => {
  const page = await openBar();
  const button = page.$("#power-restart");
  button.fire("click");
  assert.equal(button.ariaBusy, "true");
  assert.equal(button.querySelector(".label").textContent, "Restarting");
  await settle();
  assert.deepEqual(page.sent().filter((line) => line.includes("/_emu/power")), ["POST /_emu/power?action=restart&wait=1"]);
  assert.equal(button.ariaBusy, "false");
  assert.equal(button.querySelector(".label").textContent, "Back up in 1.2 s");
  assert.ok(button.classList.contains("done"));
  const html = readFileSync(join(here, "legacy-window/index.html"), "utf8");
  assert.match(html, /id="power-restart" title="Restart BUSY Bar, as holding Back and Start does on a real BUSY Bar\. Apps and their settings are kept" aria-label="Restart BUSY Bar"><svg class="bi"[^>]*><use href="\/emulator\/icons\/busy-sprite\.svg#bi-restart"\/><\/svg><span class="label">Restart BUSY Bar<\/span>/);
});

// ---------------------------------------------------------------- the controls: the top of the bar (EMU-258)

/** The requests that are keys of the bar, since the last look: "start down", "ok up", "up", "busy". */
const keysSent = (page) =>
  page
    .sent()
    .map((line) => /^POST \/_emu\/key\?key=(\w+)&action=(\w+)$/.exec(line)?.slice(1).join(" ") ?? /^POST \/api\/input\?key=(\w+)$/.exec(line)?.[1])
    .filter(Boolean);

/** A window whose bar is on, with its mode switch at `selector`, and nothing sent yet. */
async function openBar(options = {}, selector = "apps") {
  const page = openWindow(options);
  page.stream.emit("hello", hello);
  page.stream.emit("state", { ...state(), selector });
  await settle();
  page.sent();
  return page;
}

// The wheel is a circle 148 wide; a point at an angle around its middle, as far out as its ticks or on its face.
const WHEEL_BOX = { left: 100, top: 50, width: 148, height: 148 };
const onWheel = (degrees, radius = 68) => ({ clientX: 174 + radius * Math.sin((degrees * Math.PI) / 180), clientY: 124 - radius * Math.cos((degrees * Math.PI) / 180) });

test("dragging the wheel around turns it: one click of the encoder for every detent passed, either way", async () => {
  const page = await openBar();
  const wheel = page.$("#wheel");
  wheel.box = WHEEL_BOX;
  wheel.fire("pointerdown", onWheel(0));
  wheel.fire("pointermove", onWheel(10));
  assert.deepEqual(keysSent(page), [], "less than a detent: no click yet");
  wheel.fire("pointermove", onWheel(47));
  assert.deepEqual(keysSent(page), ["up", "up", "up"], "45 degrees clockwise are three clicks");
  // What was turned past the last detent is kept: 13 degrees more make the fourth.
  wheel.fire("pointermove", onWheel(60));
  assert.deepEqual(keysSent(page), ["up"]);
  wheel.fire("pointermove", onWheel(0));
  assert.deepEqual(keysSent(page), ["down", "down", "down", "down"], "and back, counterclockwise");
  // Across the top, where the angle goes from 180 to −180, the turn goes on the short way.
  wheel.fire("pointermove", onWheel(170));
  page.sent();
  wheel.fire("pointermove", onWheel(-175));
  assert.deepEqual(keysSent(page), ["up"]);
  wheel.fire("pointerup");
  assert.deepEqual(keysSent(page), [], "a turn is not a press");
  // The picture turns with it, in detents.
  assert.match(page.$("#wheel-ring").style.transform, /^rotate\(-?\d+deg\)$/);
  assert.equal(Number(/-?\d+/.exec(page.$("#wheel-ring").style.transform)[0]) % 15, 0);
  // After it is let go, moving the pointer turns nothing.
  wheel.fire("pointermove", onWheel(90));
  assert.deepEqual(keysSent(page), []);
});

test("the wheel pressed on its face is OK: a short press let go at once, a held one for as long as it is held", async () => {
  const page = await openBar();
  const wheel = page.$("#wheel");
  wheel.box = WHEEL_BOX;
  wheel.fire("pointerdown", onWheel(0, 0));
  assert.deepEqual(keysSent(page), [], "not yet: it may be the start of a drag");
  wheel.fire("pointerup");
  await settle();
  assert.deepEqual(keysSent(page), ["ok down", "ok up"]);

  wheel.fire("pointerdown", onWheel(30, 20));
  await settle(200);
  assert.deepEqual(keysSent(page), ["ok down"], "held: the press has begun");
  wheel.fire("pointermove", onWheel(120, 30));
  assert.deepEqual(keysSent(page), [], "a pointer that moves during a press turns nothing");
  await settle(100);
  wheel.fire("pointerup");
  await settle();
  assert.deepEqual(keysSent(page), ["ok up"]);
});

test("a drag that starts on the wheel's face turns the wheel and presses nothing", async () => {
  const page = await openBar();
  const wheel = page.$("#wheel");
  wheel.box = WHEEL_BOX;
  wheel.fire("pointerdown", onWheel(0, 30));
  wheel.fire("pointermove", onWheel(40, 30));
  wheel.fire("pointermove", onWheel(90, 30));
  await settle(200);
  wheel.fire("pointerup");
  await settle();
  assert.deepEqual(keysSent(page), ["up", "up", "up"], "from where the drag was seen, 50 degrees");
});

test("scrolling over the BUSY Bar or its wheel, the arrows and the wheel's own buttons turn it as before", async () => {
  const page = await openBar();
  for (const over of ["#bar", "#wheel"]) {
    page.$(over).fire("wheel", { deltaMode: 0, deltaY: 130 });
    assert.deepEqual(keysSent(page), ["up", "up"], over);
    page.$(over).fire("wheel", { deltaMode: 0, deltaY: -70 });
    assert.deepEqual(keysSent(page), ["down"], `${over}: with what was left of the scroll before`);
  }
  page.fire("keydown", { key: "ArrowRight" });
  page.fire("keydown", { key: "ArrowLeft" });
  assert.deepEqual(keysSent(page), ["up", "down"]);
  const [left, right] = page.all("[data-wheel]");
  left.fire("click");
  right.fire("click");
  assert.deepEqual(keysSent(page), ["down", "up"]);
});

// The controls, here at half their drawing's size from (100, 300): the knob's pivot at (217, 97.3) of the drawing's 900
// across, its tip at OFF straight left, 20° a position. The pointer, 50 px from the pivot at a position's angle (and
// `off` degrees more, up).
const STRIP_BOX = { left: 100, top: 300, width: 450, height: 98 };
const atPosition = (index, off = 0) => {
  const angle = (((2 - index) * 20 + off) * Math.PI) / 180;
  return { clientX: 100 + 108.5 - 50 * Math.cos(angle), clientY: 300 + 48.65 - 50 * Math.sin(angle) };
};

test("dragging the lever of the mode switch goes from detent to detent, and each position it comes to is sent", async () => {
  const page = await openBar({}, "apps");
  page.$("#strip").box = STRIP_BOX;
  const lever = page.$("#lever");
  assert.equal(lever.style.transform, "rotate(-20deg)", "APPS: the tip a position under OFF");
  lever.fire("pointerdown", atPosition(3));
  lever.fire("pointermove", atPosition(3, 8));
  assert.deepEqual(keysSent(page), [], "still at APPS");
  // Up to BUSY: through OFF and CUSTOM, as the switch itself turns.
  lever.fire("pointermove", atPosition(0, 4));
  assert.deepEqual(keysSent(page), ["off", "custom", "busy"]);
  assert.equal(lever.style.transform, "rotate(40deg)");
  // Above the first position there is nothing more.
  lever.fire("pointermove", atPosition(0, 40));
  assert.deepEqual(keysSent(page), []);
  // Below the last, the last: down through every position.
  lever.fire("pointermove", { clientX: 100, clientY: 480 });
  assert.deepEqual(keysSent(page), ["custom", "off", "apps", "settings"]);
  assert.equal(lever.style.transform, "rotate(-40deg)");
  lever.fire("pointerup");
  lever.fire("pointermove", atPosition(2));
  assert.deepEqual(keysSent(page), [], "let go, it follows the pointer no more");
  // The bar says where its switch is: the lever points there, and the position's name is lit.
  page.stream.emit("state", { ...state(), selector: "custom" });
  assert.equal(lever.style.transform, "rotate(20deg)");
  assert.deepEqual(page.all("[data-select]").map((el) => el.classList.contains("on")), [false, true, false, false, false]);
  // Reached with the keyboard, the arrows move it a position at a time.
  lever.fire("keydown", { key: "ArrowDown" });
  lever.fire("keydown", { key: "ArrowUp" });
  assert.deepEqual(keysSent(page), ["off", "busy"]);
});

test("the names of the positions are buttons: a click turns the switch there; the position it is at sends nothing", async () => {
  const page = await openBar({}, "off");
  const names = page.all("[data-select]");
  assert.equal(page.$("#lever").style.transform, "rotate(0deg)", "OFF: the knob's tip points straight left");
  names[0].fire("click");
  names[4].fire("click");
  names[2].fire("click");
  assert.deepEqual(keysSent(page), ["busy", "settings"]);
  // The switch on the bar's picture: the next position, and the one before with Shift.
  page.$("#selector-hot").fire("click", { shiftKey: false });
  page.$("#selector-hot").fire("click", { shiftKey: true });
  assert.deepEqual(keysSent(page), ["apps", "custom"]);
});

test("the RGB LEDs beside Start / Pause are off until the emulator says otherwise, then show its color, lit as the eye sees an LED, and its preset", async () => {
  const page = await openBar();
  const leds = [page.$("#led-left"), page.$("#led-right")];
  const look = () => leds.map((led) => ({ lit: led.classList.contains("lit"), hue: led.style["--led-hue"], color: led.style["--led"], blink: led.classList.contains("blink"), notification: led.classList.contains("notification") }));
  const glow = () => leds[0].style["--led-filter"];
  const dark = { lit: false, hue: "transparent", color: "transparent", blink: false, notification: false };
  const radius = (filter) => Number(/drop-shadow\(0 0 [\d.]+px [^)]+\) drop-shadow\(0 0 ([\d.]+)px/.exec(filter)?.[1]);
  assert.deepEqual(look(), Array(2).fill(dark), "off at first");
  assert.equal(glow(), "none");
  // The BUSY timer's red (150, 0, 0) at the default brightness: the PWM duty is 15 %, a real LED looks plainly lit, so
  // the hue at full strength, the core a touch hot, with a halo.
  page.stream.emit("lights", { preset: "static", color: "#960000", brightness: 0.48 });
  assert.deepEqual(look(), Array(2).fill({ lit: true, hue: "#ff0000", color: "color-mix(in srgb, #ff0000 90%, #fff)", blink: false, notification: false }));
  const halo48 = radius(glow());
  // At the bar's full brightness the halo spreads farther.
  page.stream.emit("lights", { preset: "static", color: "#960000", brightness: 0.9 });
  assert.ok(radius(glow()) > halo48 && halo48 > 0, `${halo48} then ${glow()}`);
  // At the lowest brightness (5 %) still clearly lit: about half way from the dark LED to the hue.
  page.stream.emit("lights", { preset: "static", color: "#960000", brightness: 0.05 });
  assert.deepEqual(look(), Array(2).fill({ lit: true, hue: "#ff0000", color: "color-mix(in srgb, #ff0000 67%, #262626)", blink: false, notification: false }));
  // An app's notification (POST /api/display/draw with led_notification_color): three blinks at full brightness.
  page.stream.emit("lights", { preset: "notification", color: "#2B7FFF", brightness: 0.2 });
  assert.deepEqual(look().map(({ hue, notification }) => ({ hue, notification })), Array(2).fill({ hue: "#2b7fff", notification: true }));
  page.stream.emit("lights", { preset: "blink", color: "#00ff00", brightness: 0.5 });
  assert.deepEqual(look().map(({ lit, hue, blink }) => ({ lit, hue, blink })), Array(2).fill({ lit: true, hue: "#00ff00", blink: true }));
  // The rainbow turns from red, dimmer than the timer as the firmware runs it (HSV value 16 of 255), yet visible.
  page.stream.emit("lights", { preset: "rainbow", color: "#000000", brightness: 0.48 });
  assert.deepEqual(look(), Array(2).fill({ lit: true, hue: "#ff0000", color: "color-mix(in srgb, #ff0000 80%, #262626)", blink: false, notification: false }));
  assert.ok(leds.every((led) => led.classList.contains("rainbow")));
  assert.ok(radius(glow()) < halo48, "a smaller halo than the timer's");
  // Off, black, or what is not a state: dark.
  for (const lights of [{ preset: "off", color: "#ff0000" }, { preset: "static", color: "#000000" }, { preset: "lava", color: "#ff0000" }, { preset: "static", color: "red" }, { preset: "static", color: "#ff0000", brightness: 0 }]) {
    page.stream.emit("lights", lights);
    assert.deepEqual(look(), Array(2).fill(dark), JSON.stringify(lights));
    assert.equal(glow(), "none");
  }
});

test("Start / Pause and Back are held as long as the pointer or the key holds them", async () => {
  const page = await openBar();
  const [start, back] = page.all("[data-key]:not(.wheel-ok)");
  start.fire("pointerdown");
  assert.equal(start.classList.contains("down"), true);
  await settle();
  assert.deepEqual(keysSent(page), ["start down"]);
  start.fire("pointerup");
  await settle();
  assert.deepEqual(keysSent(page), ["start up"]);
  assert.equal(start.classList.contains("down"), false);
  back.fire("pointerdown");
  back.fire("pointercancel");
  await settle();
  assert.deepEqual(keysSent(page), ["back down", "back up"]);

  // The keyboard: Space is Start, Enter is OK, Escape is Back; a key that repeats is one press.
  for (const [key, name] of [[" ", "start"], ["Enter", "ok"], ["Escape", "back"]]) {
    page.fire("keydown", { key });
    page.fire("keydown", { key, repeat: true });
    page.fire("keyup", { key });
    await settle();
    assert.deepEqual(keysSent(page), [`${name} down`, `${name} up`], key);
  }
});

test("a control that has the focus gets the key itself; on a key of the BUSY Bar, Enter and Space press that key", async () => {
  const page = await openBar();
  // A button reached with Tab: the mouse does not leave the focus on what it clicks.
  const reached = (dataset = {}) => {
    const control = Object.assign(element("button"), { dataset });
    control.closest = (selector) => (selector.includes("button") ? control : null);
    return control;
  };
  // A button of the page: Space is its own, and the bar's Start is not pressed.
  page.fire("keydown", { key: " ", target: reached() });
  page.fire("keyup", { key: " ", target: reached() });
  page.fire("keydown", { key: "ArrowRight", target: reached() });
  await settle();
  assert.deepEqual(keysSent(page), []);
  // Back, reached with Tab: Enter presses Back, not OK, and holds it until the key is let go.
  page.fire("keydown", { key: "Enter", target: reached({ key: "back" }) });
  await settle();
  assert.deepEqual(keysSent(page), ["back down"]);
  page.fire("keyup", { key: "Enter", target: reached({ key: "back" }) });
  await settle();
  assert.deepEqual(keysSent(page), ["back up"]);
  // A field that is typed in keeps every key.
  page.fire("keydown", { key: " ", target: Object.assign(element("input"), { closest: () => ({}) }) });
  assert.deepEqual(keysSent(page), []);
  // A click on a button or a link does not take the focus: the next Space is still the bar's Start.
  const prevented = [];
  page.fire("mousedown", { target: reached(), preventDefault: () => prevented.push("button") });
  page.fire("mousedown", { target: element("div"), preventDefault: () => prevented.push("text") });
  assert.deepEqual(prevented, ["button"], "text can still be selected with the mouse");
  // A switch flipped with the pointer lets the focus go; flipped with the keyboard, it keeps it.
  let blurred = 0;
  const flipped = Object.assign(element("input"), { matches: () => true, blur: () => blurred++ });
  page.fire("pointerdown");
  page.fire("change", { target: flipped });
  assert.equal(blurred, 1);
  page.fire("keydown", { key: "Tab" });
  page.fire("change", { target: flipped });
  assert.equal(blurred, 1);
});

// ---------------------------------------------------------------- the view: 2D and 3D (EMU-257)

test("without the 3D module the 3D view is not there to be chosen, and says so", async () => {
  const page = await openBar();
  assert.equal(page.$("#view-3d").ariaDisabled, "true");
  assert.equal(page.$("#view-3d").title, "3D view is coming");
  page.$("#view-3d").fire("click");
  await settle();
  assert.notEqual(page.$("#bar").hidden, true, "the picture stays");
});

test("a 3D module that cannot draw here leaves 3D off, with the reason", async () => {
  const mounts = [];
  const page = await openBar({ stage3d: { available: async () => false, mount: (box) => mounts.push(box), unmount() {} } });
  assert.equal(page.$("#view-3d").ariaDisabled, "true");
  assert.equal(page.$("#view-3d").title, "3D view needs WebGL2");
  page.$("#view-3d").fire("click");
  await settle();
  assert.equal(mounts.length, 0);
});

test("with the 3D module, 3D mounts it in the box of the BUSY Bar's picture and 2D takes it away", async () => {
  const calls = [];
  const page = await openBar({ stage3d: { available: async () => true, mount: (box) => calls.push(["mount", box]), unmount: () => calls.push(["unmount"]) } });
  assert.equal(page.$("#view-3d").ariaDisabled, "false");
  page.$("#view-3d").fire("click");
  await settle();
  assert.deepEqual(calls, [["mount", page.$("#device-view")]]);
  assert.equal(page.$("#bar").hidden, true, "the picture gives its box to the view in depth");
  assert.deepEqual([page.$("#view-2d").ariaPressed, page.$("#view-3d").ariaPressed], ["false", "true"]);
  page.$("#view-3d").fire("click");
  await settle();
  assert.equal(calls.length, 1, "chosen again, it is not mounted twice");
  page.$("#view-2d").fire("click");
  await settle();
  assert.deepEqual(calls.at(-1), ["unmount"]);
  assert.equal(page.$("#bar").hidden, false);
  assert.deepEqual([page.$("#view-2d").ariaPressed, page.$("#view-3d").ariaPressed], ["true", "false"]);
});

test("a 3D view that fails to come up gives the picture back", async () => {
  const page = await openBar({ stage3d: { available: async () => true, mount: async () => Promise.reject(new Error("no context")), unmount() {} } });
  page.$("#view-3d").fire("click");
  await settle();
  assert.equal(page.$("#bar").hidden, false);
  assert.equal(page.$("#view-3d").ariaPressed, "false");
});

// ---------------------------------------------------------------- the list, and the section of the chosen app (EMU-259)

const RUNNING = (id, stats = {}) => ({ id, stats: { heapNow: 2048, heapPeak: 4096, heapSize: 131072, draws: 0, busyMs: 0, ...stats } });
/** The rows of the list: what each says and the buttons it has, by their tooltips. */
const listed = (page) =>
  page.$("#apps").children.filter((row) => row.className !== "notice").map((row) => ({
    name: row.querySelector(".app-name").textContent,
    note: row.querySelector(".app-note").textContent,
    // Every row's More button (its menu: apps-delete.test.mjs in the app's tests) is left out here.
    buttons: row.querySelector(".row-actions").children.filter((b) => !b.className.includes("row-more")).map((b) => b.title),
    chosen: row.classList.contains("chosen"),
    on: row.classList.contains("on"),
  }));
/** The opened app's name: the words of the button in its title (a click copies its id), or the title's own. */
const titleOf = (page) => page.$("#app-title").children[0]?.children[0]?.textContent ?? page.$("#app-title").textContent;
/** The chosen app opened in the side column (layout V2), on a tab. */
function openTab(page, tab) {
  page.$("#apps").children.find((row) => row.classList.contains("chosen"))?.fire("click");
  page.all("#app-tabs [data-tab]").find((button) => button.dataset.tab === tab).fire("click");
}
/**
 * The parts of the opened app, by their class: its state under its name, what its work said (#app-status), the page of
 * its tab (#app-body; the settings form is the Settings tab's).
 */
function part(page, className) {
  if (className === "facts") return page.$("#app-facts").children[0] ?? null;
  if (className === "settings") openTab(page, "settings");
  // The folder's field (or, for an app from a package, its line) is at the top of the opened app, under its name.
  if (className === "folder") return page.$("#app-folder").children[0] ?? null;
  const page_ = page.$("#app-body").children;
  return [...inApp(page), ...page_.flatMap((el) => el.children ?? [])].find((el) => typeof el === "object" && el.className.split(" ")[0] === className) ?? null;
}
/** What the opened app's work said (#app-status), then the page of its tab (#app-body). */
const inApp = (page) => [...page.$("#app-status").children, ...page.$("#app-body").children];
/** The opened app's buttons on the page, left to right, by their names: Copy prompt for AI, Stop, Run (Refresh). */
const pageButtons = (page) => (page.$("#app-actions").children[0]?.children ?? []).filter((b) => b.tagName === "BUTTON");
const named = (b) => [b.ariaLabel || (b.children[0]?.textContent ?? b.title), b];
/** The buttons of the project's actions, by their names: those on the page, then those in its More. */
function actionButtons(page) {
  page.$("#app-more").fire("click", { detail: 1 });
  const menu = page.global.document.body.children.at(-1);
  const items = (menu?.children ?? []).filter((item) => item.className.startsWith("menu-item"));
  return Object.fromEntries([...pageButtons(page), ...items].map(named));
}

test("an app that runs has a row and its numbers even when the list does not name it", async () => {
  const page = openWindow({ apps: () => "unreachable" });
  page.stream.emit("hello", hello);
  page.stream.emit("state", { ...state(), running: RUNNING("app.test.one") });
  await settle();
  assert.deepEqual(listed(page), [{ name: "app.test.one", note: "", buttons: ["Stop"], chosen: true, on: true }]);
  assert.equal(page.$("#apps").children[0].querySelector(".row-actions").children.at(-1).title, "More", "the row's menu is behind its More button");
  // It is the chosen app, and its numbers are in its section.
  assert.equal(titleOf(page), "app.test.one");
  assert.equal(part(page, "ac-heap").querySelector(".ac-heap-text").textContent, "Heap 2.0 of 128 KiB");
  // Stopped, it leaves the list it was not in.
  page.stream.emit("state", state());
  await settle();
  assert.equal(page.$("#apps").children.length, 0);
  assert.equal(titleOf(page), "App");
});

test("the running app is the one with Stop and is the chosen one; a click on a row chooses another", async () => {
  const page = openWindow({ apps: () => [APP, { id: "app.test.two", name: "Two", version: "2.0" }] });
  page.stream.emit("hello", hello);
  page.stream.emit("state", { ...state(), running: RUNNING("app.test.two") });
  await settle();
  assert.deepEqual(listed(page), [
    { name: "One", note: "1.0", buttons: ["Start"], chosen: false, on: false },
    { name: "Two", note: "2.0", buttons: ["Stop"], chosen: true, on: true },
  ]);
  assert.equal(titleOf(page), "Two");
  assert.deepEqual(part(page, "facts").children.map((el) => el.textContent), ["Running"]);
  assert.ok(part(page, "ac-heap"), "the running app's heap");

  page.$("#apps").children[0].fire("click");
  await settle();
  assert.equal(titleOf(page), "One");
  assert.deepEqual(part(page, "facts").children.map((el) => el.textContent), ["Stopped"]);
  assert.equal(part(page, "ac-heap"), null, "an app that does not run has no numbers");
  // Its Start in the row and its Run on the page start it on the bar.
  page.sent();
  page.$("#apps").children[0].querySelector(".row-actions").children[0].fire("click");
  Object.fromEntries(pageButtons(page).map(named)).Run.fire("click");
  assert.deepEqual(page.sent(), ["POST /api/apps/launch?app_id=app.test.one", "POST /api/apps/launch?app_id=app.test.one"]);
});

test("in a browser the actions of a project are not there to be pressed, and say where they are", async () => {
  const page = openWindow({ apps: () => [APP] });
  page.stream.emit("hello", hello);
  page.stream.emit("state", state());
  await settle();
  assert.equal(page.$("#create-app").ariaDisabled, "true");
  assert.equal(page.$("#create-app").title, "Available in the BUSY Bar Emulator app");
  const buttons = actionButtons(page);
  // Run and Stop are the bar's for an app without a project; what is the project's is the desktop app's.
  assert.deepEqual(Object.keys(buttons), ["Stop", "Run", "Build", "Watch the folder", "Publish…", "Delete…"]);
  for (const [name, b] of Object.entries(buttons).filter(([name]) => !["Run", "Stop"].includes(name))) {
    assert.equal(b.ariaDisabled, "true", name);
    assert.equal(b.title, "Available in the BUSY Bar Emulator app", name);
    b.fire("click");
  }
  assert.equal(part(page, "folder"), null, "no folder is known here");
  assert.deepEqual(listed(page), [{ name: "One", note: "1.0", buttons: ["Start"], chosen: true, on: false }]);
});

/** What the page gave, as plain values of this test: the page's own objects are of another realm. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** The desktop app's actions, as far as the page uses them; `calls` gets what was asked. */
function shellActions({ projects = [], answers = {}, examples = [] } = {}) {
  const calls = [];
  const listeners = [];
  const answer = (name, folder) => {
    calls.push(folder === undefined ? [name] : [name, folder]);
    const given = answers[name];
    return Promise.resolve(typeof given === "function" ? given(folder) : (given ?? { ok: true }));
  };
  const menu = [];
  return {
    calls,
    emit: (event) => listeners.forEach((cb) => cb(event)),
    menu: (item) => menu.forEach((cb) => cb(item)),
    available: () => ({ shell: true }),
    on(name, cb) {
      if (name === "menu") menu.push(cb);
      if (name === "job") listeners.push(cb);
      return () => void listeners.splice(listeners.indexOf(cb), 1);
    },
    projects: {
      list: async () => projects,
      examples: async () => examples,
      create: (asked) => {
        calls.push(["create", asked]);
        return Promise.resolve(answers.create ?? null);
      },
      open: () => answer("open"),
      build: (folder) => answer("build", folder),
      run: (folder) => answer("run", folder),
      stop: (folder) => answer("stop", folder),
      refresh: (folder) => answer("refresh", folder),
      dev: { start: (folder) => answer("dev.start", folder), stop: (folder) => answer("dev.stop", folder) },
      check: (folder) => answer("check", folder),
      submit: (folder) => answer("submit", folder),
      dependencies: (folder) => answer("dependencies", folder),
      retryDependencies: () => answer("retryDependencies"),
    },
    reveal: (path) => answer("reveal", path),
    copy: (text) => answer("copy", text),
    terminalInfo: async () => answers.terminalInfo ?? { available: true, name: "Terminal", label: "Open in Terminal", why: null },
    openTerminal: (options) => answer("openTerminal", plain(options)),
  };
}

const PROJECT = { id: "app.test.one", name: "One", folder: "/Users/you/Projects/experiments/one", exists: true };

async function openShell(shell, { apps = [APP], running = null, settings = {}, now, filters, kept, record } = {}) {
  const page = openWindow({ apps: () => apps, actions: shell, settings, now, filters, kept, record });
  page.stream.emit("hello", hello);
  page.stream.emit("state", { ...state(), running });
  await settle();
  return page;
}

test("the list is the person's projects first, each with Refresh, then what else is on the BUSY Bar, named as from a package", async () => {
  const shell = shellActions({ projects: [{ id: "app.test.new", name: "New", folder: "/p/new", exists: true }, PROJECT, { id: "app.test.gone", name: "Gone", folder: "/p/gone", exists: false }] });
  const page = await openShell(shell, { apps: [{ id: "app.test.pkg", name: "Packaged", version: "3.0" }, APP] });
  assert.deepEqual(listed(page).map(({ name, note, buttons }) => [name, note, buttons]), [
    ["New", "Not on the BUSY Bar yet", ["Refresh: build, install and start it again"]],
    ["One", "1.0", ["Refresh: build, install and start it again", "Start"]],
    ["Packaged", "3.0, from a package", ["Start"]],
  ]);
  assert.equal(page.$("#create-app").ariaDisabled, "false");
});

// create-offline: a project created without the network, and three of the same name.
const NO_DEPS = { state: "failed", reason: "no network", message: "npm install could not reach https://registry.npmjs.org/@busy-app%2fcli: ENOTFOUND.", retry: true };

test("a project whose dependencies did not come says why and has Retry; the section says it too; a Retry that works lists it again", async () => {
  const failing = { id: "app.test.focus", name: "Focus Timer", folder: "/p/focus-timer", exists: true, dependencies: NO_DEPS };
  const projects = [failing];
  const shell = shellActions({ projects, answers: { dependencies: () => ((failing.dependencies = { state: "installed" }), { ok: true, message: "Dependencies installed" }) } });
  const page = await openShell(shell, { apps: [] });
  assert.deepEqual(listed(page).map(({ name, note, buttons }) => [name, note, buttons]), [["Focus Timer", "Dependencies not installed: no network", ["Install its dependencies again"]]]);
  assert.ok(page.$("#apps").children[0].querySelector(".app-note").classList.contains("trouble"));
  const box = inApp(page).find((el) => el.className === "job deps");
  assert.ok(box, "the section says it");
  assert.deepEqual(box.children.map((el) => el.textContent), ["Dependencies not installed: no network", "", "Check the connection and press Retry. The emulator also tries again by itself when the network is back.", NO_DEPS.message]);
  assert.equal(box.children[1].title, "Install its dependencies again");
  page.$("#apps").children[0].querySelector(".row-actions").children.find((b) => b.title === "Install its dependencies again").fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls).filter(([name]) => name === "dependencies"), [["dependencies", "/p/focus-timer"]]);
  assert.deepEqual(listed(page).map(({ note, buttons }) => [note, buttons]), [["Not on the BUSY Bar yet", ["Refresh: build, install and start it again"]]]);
  assert.equal(inApp(page).find((el) => el.className === "job deps"), undefined);
});

test("a Retry that went on with the Refresh that had stopped at the dependencies is said as that Refresh", async () => {
  const failing = { id: "app.test.focus", name: "Focus Timer", folder: "/p/focus-timer", exists: true, dependencies: NO_DEPS };
  const long = "busy-cli build failed with exit code 1:\nsrc/main.ts(3,1): error TS1005";
  const shell = shellActions({ projects: [failing], answers: { dependencies: () => ((failing.dependencies = { state: "installed" }), { ok: false, code: "tool_failed", message: long, followed: "refresh" }) } });
  const page = await openShell(shell, { apps: [] });
  page.$("#apps").children[0].querySelector(".row-actions").children.find((b) => b.title === "Install its dependencies again").fire("click");
  await settle();
  const job = inApp(page).find((el) => el.className === "job");
  assert.equal(job.children[0].textContent, "Build failed", "a Refresh's words, not the dependencies'");
  assert.equal(listed(page)[0].note, "Failed, see the app");
});

test("the window tries the dependencies again by itself when the network may be back, and not when no project waits for it", async () => {
  const projects = [{ id: "app.test.focus", name: "Focus Timer", folder: "/p/focus-timer", exists: true, dependencies: NO_DEPS }];
  const shell = shellActions({ projects, answers: { retryDependencies: { started: ["/p/focus-timer"] } } });
  const page = await openShell(shell, { apps: [] });
  page.fire("online");
  page.fire("focus");
  await settle();
  assert.equal(plain(shell.calls).filter(([name]) => name === "retryDependencies").length, 2);
  // The heading's Refresh looks too.
  page.$("#refresh-apps").fire("click");
  await settle();
  assert.equal(plain(shell.calls).filter(([name]) => name === "retryDependencies").length, 3);
  projects[0].dependencies = { state: "installed" };
  page.$("#refresh-apps").fire("click");
  await settle();
  page.fire("online");
  await settle();
  assert.equal(plain(shell.calls).filter(([name]) => name === "retryDependencies").length, 3, "nothing waits: nothing is tried");
});

test("rows of the same name say their folders; the pop-up is told of the apps there are, by name and folder", async () => {
  const projects = [
    { id: "app.test.focus_timer", name: "Focus Timer", folder: "/Users/you/BUSY Bar projects/focus-timer", shownFolder: "~/BUSY Bar projects/focus-timer", exists: true },
    { id: "app.test.focus_timer_2", name: "Focus Timer", folder: "/Users/you/BUSY Bar projects/focus-timer-2", shownFolder: "~/BUSY Bar projects/focus-timer-2", exists: true, dependencies: NO_DEPS },
    { id: "app.test.one", name: "One", folder: "/p/one", exists: true },
  ];
  const shell = shellActions({ projects });
  const page = await openShell(shell, { apps: [{ id: "app.test.focus_timer", name: "Focus Timer", version: "0.1.0" }] });
  assert.deepEqual(listed(page).map(({ name, note }) => [name, note]), [
    ["Focus Timer", "focus-timer, 0.1.0"],
    ["Focus Timer", "focus-timer-2, Dependencies not installed: no network"],
    ["One", "Not on the BUSY Bar yet"],
  ]);
  page.$("#create-app").fire("click");
  await settle();
  assert.deepEqual(plain(shell.popUp.existing).map(({ name, shown }) => [name, shown]), [["Focus Timer", "~/BUSY Bar projects/focus-timer"], ["Focus Timer", "~/BUSY Bar projects/focus-timer-2"], ["One", "/p/one"]]);
  shell.popUp.openExisting("app.test.focus_timer_2");
  await settle();
  assert.deepEqual(listed(page).filter((row) => row.chosen).map(({ note }) => note), ["focus-timer-2, Dependencies not installed: no network"]);
});

test("the chosen project's folder is a read-only field with Copy and Open in Finder in it", async () => {
  const shell = shellActions({ projects: [{ ...PROJECT, shownFolder: "~/Projects/experiments/one" }] });
  const page = await openShell(shell);
  const [path, copy, show] = part(page, "folder").children;
  assert.equal(path.tagName, "INPUT");
  assert.equal(path.readOnly, true);
  assert.equal(path.value, "~/Projects/experiments/one");
  assert.deepEqual([path.dataset.tip, path.dataset.tipDetail], ["The project's folder", PROJECT.folder]);
  copy.fire("click");
  show.fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls), [["copy", PROJECT.folder], ["reveal", PROJECT.folder]]);
  assert.equal(copy.dataset.tip, "Copied");
  assert.match(show.ariaLabel, /^(Open in Finder|Show in Explorer)$/);
});

test("a project's app that runs is stopped by the desktop app, as its project is; another app by the BUSY Bar", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  const page = await openShell(shell, { apps: [APP, { id: "app.test.two", name: "Two", version: "2.0" }], running: RUNNING("app.test.one") });
  page.sent();
  Object.fromEntries(pageButtons(page).map(named)).Stop.fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls), [["stop", PROJECT.folder]]);
  assert.deepEqual(page.sent().filter((line) => line.includes("/api/apps/quit")), []);
  // An app without a project: the bar's own stop.
  page.stream.emit("state", { ...state(), running: RUNNING("app.test.two") });
  await settle();
  page.sent();
  Object.fromEntries(pageButtons(page).map(named)).Stop.fire("click");
  assert.deepEqual(page.sent(), ["POST /api/apps/quit"]);
});

test("an app on the BUSY Bar without a project says so, and its project's actions say why they are not there", async () => {
  const shell = shellActions();
  const page = await openShell(shell);
  assert.equal(part(page, "folder").children[0].textContent, "Installed from a package");
  const buttons = actionButtons(page);
  assert.equal(buttons["Copy prompt for AI"], undefined, "no prompt without a project");
  assert.equal(buttons.Build.ariaDisabled, "true");
  assert.equal(buttons.Build.title, "This app has no project folder");
  buttons.Build.fire("click");
  assert.deepEqual(plain(shell.calls), []);
});

test("Refresh builds, installs and starts the project again; the row turns while it works", async () => {
  let done;
  const shell = shellActions({ projects: [PROJECT], answers: { refresh: () => new Promise((resolve) => (done = resolve)) } });
  const page = await openShell(shell, { running: RUNNING("app.test.one") });
  actionButtons(page).Refresh.fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls), [["refresh", PROJECT.folder]]);
  assert.equal(part(page, "job").children[0].textContent, "Refreshing");
  assert.equal(listed(page)[0].note, "Refreshing");
  const rowRefresh = page.$("#apps").children[0].querySelector(".row-actions").children[0];
  assert.match(rowRefresh.className, /\bbusy\b/);
  // While it works, the same thing is not started again.
  rowRefresh.fire("click");
  actionButtons(page).Build.fire("click");
  assert.equal(shell.calls.length, 1);
  // What the tool prints goes to the console, under the Build filter.
  shell.emit({ id: 7, kind: "refresh", folder: PROJECT.folder, state: "running", line: "> busy-cli build" });
  assert.deepEqual(page.$("#console").children.at(-1).className, "line build");
  assert.equal(page.$("#console").children.at(-1).querySelector(".text").textContent, "> busy-cli build");
  done({ ok: true });
  await settle();
  assert.equal(part(page, "job").children[0].textContent, "Refreshed");
  assert.equal(listed(page)[0].note, "1.0");
});

test("a Refresh that fails shows the error's lines and says that the previous version is still running", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  const page = await openShell(shell, { running: RUNNING("app.test.one") });
  shell.projects.refresh = (folder) => {
    shell.emit({ id: 9, kind: "refresh", folder, state: "running" });
    for (const line of ["> busy-cli build", "src/main.ts(14,3): error TS2304: Cannot find name '<b>devcie</b>'.", "Found 1 error."]) shell.emit({ id: 9, kind: "refresh", folder, state: "running", line });
    shell.emit({ id: 9, kind: "refresh", folder, state: "failed" });
    return Promise.resolve({ ok: false, code: "build_failed", message: "Build failed", hint: "Fix the error and refresh again." });
  };
  page.$("#apps").children[0].querySelector(".row-actions").children[0].fire("click");
  await settle();
  const job = part(page, "job").children;
  assert.deepEqual(job.map((el) => [el.className, el.textContent]), [
    ["job-line failed", "Build failed"],
    ["", "> busy-cli build\nsrc/main.ts(14,3): error TS2304: Cannot find name '<b>devcie</b>'.\nFound 1 error."],
    ["hint", "Fix the error and refresh again."],
    ["hint", "The previous version is still running."],
  ]);
  assert.equal(listed(page)[0].note, "Failed, see the app");
  // The whole of it is in the console.
  assert.equal(page.$("#console").children.filter((line) => line.className === "line build").length, 3);
});

test("a build's long error is shown as its output under a short line, and a hint that names a command is said in the window's words", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  const page = await openShell(shell, { running: RUNNING("app.test.one") });
  const error = "busy-cli build failed with exit code 1:\n\u25c7  Building app.test.one v1.0\n\u2717 Build failed in 11ms\n  8 \u2502 const = ;";
  shell.projects.refresh = () => Promise.resolve({ ok: false, code: "tool_failed", message: error, hint: "Fix what busy-cli says, then run /usr/bin/node /x/busy-emulator.mjs dev '/p/one' --once again." });
  actionButtons(page).Refresh.fire("click");
  await settle();
  assert.deepEqual(part(page, "job").children.map((el) => [el.className, el.textContent]), [
    ["job-line failed", "Build failed"],
    ["", error],
    ["hint", "Fix the error, then press Refresh."],
    ["hint", "The previous version is still running."],
  ]);
  // A hint in plain words is kept.
  shell.projects.build = () => Promise.reject(Object.assign(new Error("Another job runs on this project."), { code: "busy", hint: "Wait for it to end." }));
  actionButtons(page).Build.fire("click");
  await settle();
  assert.equal(part(page, "job").children.find((el) => el.className === "hint").textContent, "Wait for it to end.");
});

test("an action the desktop app refuses for want of a click says quietly: Click again", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  const page = await openShell(shell);
  const noGesture = () => Promise.reject(Object.assign(new Error("The app does this only just after a click or a key in its window."), { code: "no_gesture", hint: null }));
  shell.projects.build = noGesture;
  actionButtons(page).Build.fire("click");
  await settle();
  assert.deepEqual(part(page, "job").children.map((el) => [el.className, el.textContent]), [["job-line quiet", "Click again"]]);
  assert.equal(listed(page)[0].note, "1.0", "nothing failed");
  shell.copy = noGesture;
  const copy = part(page, "folder").children[1];
  copy.fire("click");
  await settle();
  assert.equal(copy.dataset.tip, "Click again");
});

// ---- the account menu, the link to the server, icons that do not blink

test("the account menu's Switch account… and Add account… open Publish on Choose a GitHub account for the open app", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  shell.github = { status: async () => ({ configured: true, signedIn: true, login: "octo-person" }), signOut: async () => ({ ok: true }) };
  const page = await openShell(shell);
  await settle();
  assert.equal(page.$("#account").hidden, false);
  assert.equal(page.$("#account-name").textContent, "octo-person");
  assert.equal(page.$("#account-avatar").dataset.mark, "github", "GitHub's mark, signed in or not");
  const menu = () => {
    page.$("#account").fire("click");
    const el = page.global.document.body.children.at(-1);
    return Object.fromEntries(el.children.filter((item) => item.className === "menu-item").map((item) => [item.children[0]?.textContent, item]));
  };
  const items = menu();
  assert.deepEqual(Object.keys(items), ["Open on GitHub", "Switch account…", "Add account…", "Sign out"]);
  items["Switch account…"].fire("click");
  menu()["Add account…"].fire("click");
  assert.deepEqual(plain(shell.calls.filter(([name]) => name === "publish.open")), [["publish.open", PROJECT.folder, "switch"], ["publish.open", PROJECT.folder, "add"]]);
});

test("without an app with a project open, Switch account… and Add account… are not there to be pressed", async () => {
  const shell = shellActions();
  shell.github = { status: async () => ({ configured: true, signedIn: true, login: "octo-person" }) };
  const page = await openShell(shell);
  await settle();
  page.$("#account").fire("click");
  const items = page.global.document.body.children.at(-1).children.filter((item) => item.className === "menu-item");
  const switchItem = items.find((item) => item.children[0]?.textContent === "Switch account…");
  assert.equal(switchItem.getAttribute("aria-disabled"), "true");
  switchItem.fire("click");
  assert.deepEqual(shell.calls.filter(([name]) => name === "publish.open"), []);
});

test("a lost link to the emulator's server says Reconnecting…; while it holds, the dashboard says nothing of it", async () => {
  const page = openWindow();
  page.stream.emit("hello", hello);
  page.stream.emit("state", state());
  await settle();
  assert.equal(page.$("#link").classList.contains("live"), true);
  page.stream.onerror();
  assert.equal(page.$("#link").textContent, "Reconnecting…");
  assert.equal(page.$("#link").classList.contains("live"), false);
});

test("an icon that changes with each state is put in only when it is another one: the same one is not drawn again", async () => {
  const page = openWindow();
  page.stream.emit("hello", hello);
  const battery = page.$("#battery-icon");
  let drawn = 0;
  let html = "";
  Object.defineProperty(battery, "innerHTML", { get: () => html, set: (value) => ((html = value), (drawn += 1)) });
  for (let i = 0; i < 5; i++) page.stream.emit("state", state({ battery: 90, usb: false }));
  await settle();
  assert.equal(drawn, 1, "five states of the same charge draw the icon once");
  assert.match(html, /#bi-battery-5"/);
  page.stream.emit("state", state({ battery: 90, usb: true }));
  page.stream.emit("state", state({ battery: 30, usb: true }));
  assert.equal(drawn, 3);
  assert.match(html, /#bi-battery-charging-2"/);
});

// ---- the console in the system's terminal

const FILTERS = [["app", true], ["build", true], ["system", false]];

test("in a browser Open in Terminal is not there to be pressed, and says where it is", async () => {
  const page = openWindow({ apps: () => [APP] });
  page.stream.emit("hello", hello);
  await settle();
  const button = page.$("#open-terminal");
  assert.equal(button.ariaDisabled, "true");
  assert.equal(button.title, "Open in Terminal: Available in the BUSY Bar Emulator app");
});

test("Open in Terminal asks the desktop app for the console as it is: every app, the filters that are on, the chosen project's folder, from the last Clear", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  const page = await openShell(shell, { filters: FILTERS });
  const button = page.$("#open-terminal");
  assert.deepEqual([button.ariaDisabled, button.title, button.ariaLabel], ["false", "Open in Terminal", "Open in Terminal"]);
  button.fire("click");
  await settle();
  assert.deepEqual(shell.calls.filter(([name]) => name === "openTerminal"), [["openTerminal", { app: null, folder: PROJECT.folder, kinds: ["console", "lifecycle", "build"], since: null }]]);
  // After Clear the terminal starts where the console does now; System turned on is asked for too.
  const before = Date.now();
  page.$("#clear").fire("click");
  page.all(".filters input")[2].checked = true;
  button.fire("click");
  await settle();
  const [, asked] = shell.calls.filter(([name]) => name === "openTerminal").at(-1);
  assert.deepEqual(asked.kinds, ["console", "lifecycle", "build", "system"]);
  assert.ok(asked.since >= before && asked.since <= Date.now(), `since ${asked.since}`);
  // A new connection shows the whole kept log again: so does the terminal.
  page.stream.emit("hello", hello);
  button.fire("click");
  await settle();
  assert.equal(shell.calls.filter(([name]) => name === "openTerminal").at(-1)[1].since, null);
});

test("Open in Terminal: named by the system the app runs on; not there to be pressed when the app has no command line; refused for want of a click: Click again", async () => {
  const windows = shellActions({ answers: { terminalInfo: { available: true, name: "cmd", label: "Open in cmd", why: null } } });
  assert.equal((await openShell(windows)).$("#open-terminal").title, "Open in cmd");
  const none = shellActions({ answers: { terminalInfo: { available: false, name: "Terminal", label: "Open in Terminal", why: "Needs the busy-emulator command" } } });
  const page = await openShell(none);
  const button = page.$("#open-terminal");
  assert.deepEqual([button.ariaDisabled, button.title], ["true", "Open in Terminal: Needs the busy-emulator command"]);
  button.fire("click");
  await settle();
  assert.deepEqual(none.calls.filter(([name]) => name === "openTerminal"), []);
  const refused = shellActions({ answers: { openTerminal: () => Promise.reject(Object.assign(new Error("The app does this only just after a click or a key in its window."), { code: "no_gesture" })) } });
  const again = await openShell(refused);
  again.$("#open-terminal").fire("click");
  await settle();
  assert.equal(again.$("#open-terminal").title, "Click again");
  const failed = shellActions({ answers: { openTerminal: () => Promise.reject(Object.assign(new Error("Terminal did not open."), { code: "failed" })) } });
  const told = await openShell(failed);
  told.$("#open-terminal").fire("click");
  await settle();
  const last = told.$("#console").children.at(-1);
  assert.deepEqual([last.className, last.querySelector(".text").textContent], ["line warn", "Open in Terminal: Terminal did not open."]);
});



test("a project whose disk is away stays in the list and waits: it says so, and its actions are not there", async () => {
  const shell = shellActions({ projects: [{ ...PROJECT, exists: false, unavailable: true }] });
  const page = await openShell(shell);
  assert.deepEqual(listed(page).map(({ name, note }) => [name, note]), [["One", "Folder unavailable"]]);
  const refresh = page.$("#apps").children[0].querySelector(".row-actions").children[0];
  assert.equal(refresh.ariaDisabled, "true");
  assert.equal(refresh.title, "Its folder is not there: is its disk plugged in?");
  refresh.fire("click");
  const project = ["Run", "Refresh", "Build", "Watch the folder", "Publish…", "Show in Finder"];
  for (const b of Object.entries(actionButtons(page)).filter(([name]) => project.includes(name)).map(([, b]) => b)) {
    assert.equal(b.title, "Its folder is not there: is its disk plugged in?");
    b.fire("click");
  }
  assert.deepEqual(plain(shell.calls), []);
});

test("a job the list names, started elsewhere, is shown on the row and in the section, and nothing else is started", async () => {
  const shell = shellActions({ projects: [{ ...PROJECT, job: "dev" }] });
  const page = await openShell(shell);
  assert.equal(listed(page)[0].note, "Watching the folder");
  assert.match(page.$("#apps").children[0].querySelector(".row-actions").children[0].className, /\bbusy\b/);
  assert.equal(part(page, "job").children[0].textContent, "Watching the folder");
  // Dev is under way: its button stops it; the others wait.
  const buttons = actionButtons(page);
  assert.deepEqual(Object.keys(buttons), ["Copy prompt for AI", "Stop", "Run", "Build", "Stop watching", "Publish…", "Show in Finder", "Copy the path", "Delete…"]);
  buttons.Build.fire("click");
  buttons["Stop watching"].fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls), [["dev.stop", PROJECT.folder]]);
});

test("the list is read again when a job ends, and when the desktop app says it changed by itself", async () => {
  const projects = [PROJECT];
  const shell = shellActions({ projects });
  const page = await openShell(shell, { apps: [] });
  projects.push({ id: "app.test.b", name: "B", folder: "/p/b", exists: true });
  shell.emit({ id: 1, kind: "open", folder: "/p/b", state: "done" });
  await settle();
  assert.deepEqual(listed(page).map(({ name }) => name), ["One", "B"]);
  projects.pop();
  shell.emit({ id: 2, kind: "removed", folder: "/p/b", state: "done" });
  await settle();
  assert.deepEqual(listed(page).map(({ name }) => name), ["One"]);
  assert.equal(page.$("#apps").children[0].textContent, "The folder of B is gone");
});



test("an action the desktop app refuses is said with its reason and what to do", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  shell.projects.build = () => Promise.reject(Object.assign(new Error("Another job runs on this project."), { code: "busy", hint: "Wait for it to end." }));
  const page = await openShell(shell);
  actionButtons(page).Build.fire("click");
  await settle();
  assert.deepEqual(part(page, "job").children.slice(0, 2).map((el) => [el.className, el.textContent]), [["job-line failed", "Another job runs on this project."], ["hint", "Wait for it to end."]]);
});

test("Create app opens its pop-up with the examples and the ids in use; what it creates is listed and chosen, with its folder", async () => {
  const made = { id: "app.test.made", name: "Made", folder: "/p/made", exists: true };
  const projects = [PROJECT];
  const shell = shellActions({ projects, answers: { create: made }, examples: [{ name: "hello", title: "Hello", summary: "One line" }] });
  const page = await openShell(shell);
  page.$("#create-app").fire("click");
  await settle();
  // The examples were read when the page loaded; the ids are the projects' and the bar's.
  assert.deepEqual(plain(shell.calls), [["createApp.open", { examples: ["hello"], taken: ["app.test.one"] }]]);
  projects.push(made);
  const request = { example: null, name: "Made", id: "app.test.made", place: { parent: "/p", folder: "made" } };
  assert.deepEqual(await shell.popUp.create(request), made);
  assert.deepEqual(plain(shell.calls.at(-1)), ["create", request]);
  assert.deepEqual(listed(page).map(({ name, chosen }) => [name, chosen]), [["One", false], ["Made", true]]);
  assert.equal(part(page, "folder").children[0].value, "/p/made");
});

test("Create app ends with the app running: the Refresh that followed is the Refresh button's, said by the state alone", async () => {
  const made = { id: "app.test.made", name: "Made", folder: "/p/made", exists: true, refreshed: { ok: true, message: "app.test.made is running." } };
  const projects = [PROJECT];
  const shell = shellActions({ projects, answers: { create: made } });
  const page = await openShell(shell);
  page.$("#create-app").fire("click");
  await settle();
  projects.push(made);
  await shell.popUp.create({ example: null, name: "Made", id: "app.test.made", place: { parent: "/p", folder: "made" } });
  await settle();
  assert.deepEqual(listed(page).filter((row) => row.chosen).map(({ name }) => name), ["Made"]);
  // "… is running." says no more than the state under the name: the section does not repeat it.
  assert.equal(inApp(page).find((el) => el.className === "job"), undefined);
});

test("the app menu's New App… opens the same pop-up; another item of the menu does nothing here", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  await openShell(shell);
  shell.menu("something else");
  shell.menu("create");
  await settle();
  assert.deepEqual(plain(shell.calls), [["createApp.open", { examples: [], taken: ["app.test.one"] }]]);
});

test("what the pop-up creates and a step after create could not do is said in the list; a refusal goes back to the pop-up", async () => {
  const made = { id: "app.test.made", name: "Made", folder: "/p/made", exists: true, unfinished: ["The icons were not made: no space."] };
  const projects = [PROJECT];
  const shell = shellActions({ projects, answers: { create: made } });
  const page = await openShell(shell);
  page.$("#create-app").fire("click");
  await settle();
  projects.push(made);
  await shell.popUp.create({ example: null });
  assert.equal(page.$("#apps").children[0].textContent, "The icons were not made: no space.");
  shell.projects.create = () => Promise.reject(Object.assign(new Error("The project was not created."), { code: "tool_failed" }));
  await assert.rejects(shell.popUp.create({ example: null }), /not created/);
  assert.notEqual(page.$("#apps").children[0].textContent, "Creating the app", "the list is free again");
});

// The first run's greeting (welcome.js, EMU-207): "I'll write the code" is the window's own Create app, and the app it
// creates gets three steps at the top of its section. The greeting itself is tested in the app (packages/app/test/app).
test("\"I'll write the code\": the window's Create app, then the new app's three steps, which can be hidden", async () => {
  const made = { id: "app.test.made", name: "Made", folder: "/p/made", exists: true };
  const projects = [];
  const shell = shellActions({ projects, answers: { create: made }, examples: [{ name: "hello", title: "Hello", summary: "One line" }, { name: "clock", summary: "With settings" }] });
  shell.welcome = { get: async () => ({ show: true, way: null, platform: "darwin", cli: null }), seen: async (answer) => void shell.calls.push(["welcome.seen", answer]) };
  const page = openWindow({ apps: () => [], actions: shell, scripts: ["welcome.js"] });
  page.stream.emit("hello", hello);
  page.stream.emit("state", state());
  await settle();
  const welcome = page.global.emulatorWelcome;
  assert.equal(typeof welcome.writeCode, "function");
  welcome.writeCode();
  await settle();
  projects.push(made);
  await shell.popUp.create({ example: "hello" });
  await settle();
  // The way chosen is kept with the answer, for the next "Getting started".
  assert.deepEqual(plain(shell.calls), [["welcome.seen", { way: "code" }], ["createApp.open", { examples: ["hello", "clock"], taken: [] }], ["create", { example: "hello" }]]);
  const text = (el) => (typeof el === "string" ? el : el.children.length ? el.children.map(text).join("") : el.textContent);
  const [steps] = page.$("#app-status").children;
  assert.equal(steps.className, "first-steps");
  assert.equal(text(steps), "Your app is readyEdit src/main.ts in your editor.Show in FinderPress Refresh: the BUSY Bar runs your change.When it is ready, press Publish for the app catalog.");
  // Show in Finder opens the new project's folder (the desktop app opens a folder, its files in view); the cross hides
  // the steps for good.
  const [head, list] = steps.children;
  list.children[0].children[1].fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls.at(-1)), ["reveal", "/p/made"]);
  head.children[1].fire("click");
  page.stream.emit("apps", {});
  await settle();
  assert.notEqual(page.$("#app-status").children[0]?.className, "first-steps");
  // An app created from the Apps section's own button has no steps.
  const other = { id: "app.test.other", name: "Other", folder: "/p/other", exists: true };
  shell.projects.create = async () => other;
  projects.push(other);
  page.$("#create-app").fire("click");
  await settle();
  await shell.popUp.create({ example: null });
  await settle();
  assert.equal(titleOf(page), "Other");
  assert.notEqual(page.$("#app-status").children[0]?.className, "first-steps");
});

test("a project whose folder is gone leaves the list, with one quiet line for a while", async () => {
  const projects = [PROJECT, { id: "app.test.b", name: "B", folder: "/p/b", exists: true }];
  const shell = shellActions({ projects });
  const page = await openShell(shell, { apps: [] });
  assert.deepEqual(listed(page).map(({ name }) => name), ["One", "B"]);
  projects.pop();
  page.stream.emit("apps", {});
  await settle();
  const rows = page.$("#apps").children;
  assert.deepEqual([rows[0].className, rows[0].textContent], ["notice", "The folder of B is gone"]);
  assert.equal(rows.length, 2);
});

test("with no app, the desktop app's list offers Create app; a browser's says how to install one", async () => {
  const shell = shellActions();
  const inApp = await openShell(shell, { apps: [] });
  assert.match(inApp.$("#apps").innerText, /No apps yet/);
  // One thing to do: the heading's Create app gives way to the list's own.
  assert.equal(inApp.$("#create-app").hidden, true);
  inApp.$("#apps").querySelector("button").fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls), [["createApp.open", { examples: [], taken: [] }]]);
  await settle();
  const inBrowser = openWindow({ apps: () => [] });
  inBrowser.stream.emit("hello", hello);
  inBrowser.stream.emit("state", state());
  await settle();
  assert.match(inBrowser.$("#apps").innerText, /No apps installed/);
  assert.equal(inBrowser.$("#apps").querySelector(".addr").textContent, "127.0.0.1:8861");
});

// ---- what comes from outside is text

test("the script writes markup of its own only: what it puts into innerHTML holds nothing but icons by their names", () => {
  const script = windowFile("window.js");
  const written = [...script.matchAll(/\.innerHTML = ([^\n]+);\n/g)].map((m) => m[1]);
  assert.ok(written.length >= 8, `innerHTML is written in ${written.length} places`);
  for (const value of written) {
    if (value.startsWith("`")) {
      // A template of the script's own: what it takes in is an icon by a name written right there.
      for (const [, taken] of value.matchAll(/\$\{([^}]*)\}/g)) assert.match(taken, /^icon\("[a-z0-9-]+"\)$/, value.slice(0, 80));
    } else assert.match(value, /^(icon\(|GITHUB_MARK$)/, `only an icon is written without a template: ${value.slice(0, 80)}`);
  }
  // Nothing else makes markup or runs text.
  assert.doesNotMatch(script, /insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function|setAttribute\("on/);
});

test("an icon is put in by a name of the set only: anything else writes nothing", async () => {
  const page = openWindow();
  page.stream.emit("hello", hello);
  page.stream.emit("state", state({ battery: 55, usb: false }));
  assert.match(page.$("#battery-icon")._html, /#bi-battery-3"/);
  page.stream.emit("state", state({ battery: '"><img src=x onerror=alert(1)>', usb: false }));
  assert.equal(page.$("#battery-icon")._html, "");
});

test("the names of a project, its folder, a job's lines and a check's words go to the page as text", async () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const project = { id: "app.test.one", name: hostile, folder: `/p/${hostile}`, exists: true };
  const shell = shellActions({ projects: [project], answers: { check: { ok: false, checks: [{ id: "x", title: hostile, answer: "fails", message: hostile, blocking: true }] } } });
  const page = await openShell(shell, { apps: [{ id: "app.test.one", name: hostile, version: hostile }] });
  shell.emit({ id: 1, kind: "build", folder: project.folder, state: "running", line: hostile });
  shell.emit({ id: 1, kind: "build", folder: project.folder, state: "failed" });
  await settle();
  page.stream.emit("log", { kind: "error", text: hostile, time: 0 });
  // It is all there, as text.
  assert.equal(titleOf(page), hostile);
  assert.equal(listed(page)[0].name, hostile);
  assert.equal(part(page, "folder").children[0].value, `/p/${hostile}`);
  // And in no markup the script wrote, anywhere on the page.
  const markup = (el) => (typeof el === "string" ? [] : [el._html, ...el.children.flatMap(markup)]);
  for (const id of ["#apps", "#app-status", "#app-folder", "#app-body", "#app-title", "#app-facts", "#app-actions", "#console"]) {
    for (const html of markup(page.$(id))) assert.doesNotMatch(html, /onerror|<img/, id);
  }
});

// ---- the app's settings: our own form, in the local web's look

const SCHEMA = {
  format_version: 1,
  version: 3,
  fields: {
    title: { type: "string", label: "<b>Title</b>", description: "<img src=x onerror=alert(1)>", default: "A", max_length: 12 },
    hour24: { type: "boolean", label: "24-hour clock", default: true },
    theme: { type: "enum", label: "Theme", default: "amber", options: [{ value: "amber", label: "<u>Amber</u>" }, { value: "blue", label: "Blue" }] },
    timing: { type: "group", label: "Timing", description: "How long", fields: { minutes: { type: "integer", label: "Minutes", default: 25, min: 1, max: 120 }, at: { type: "time", label: "At", default: "09:30" } } },
    tint: { type: "color", label: "Tint", default: "#FF8800CC" },
    place: { type: "geolocation", label: "Place", default: { mode: "auto", name: "Here" } },
  },
};
const VALUES = { title: "A", hour24: true, theme: "amber", timing: { minutes: 25, at: "09:30" }, tint: "#FF8800CC", place: { mode: "auto", name: "Here" } };
/**
 * The rows of the form: the field's words, its kind of control (how wide it is), its controls. Groups are flattened
 * under "Group: ". The place's card gives its switch, then the name and the coordinates under it.
 */
const formRows = (box, prefix = "") =>
  box.children.flatMap((row) => {
    if (row.className === "group") return formRows({ children: row.children.filter((el) => el.tagName !== "H3") }, `${row.children[0].textContent}: `);
    if (row.className === "geo") {
      const [card, fixed] = row.children;
      return [{ name: prefix + card.children[2].children[0].textContent, kind: "geo", controls: [card.children[0].children[1], fixed.children[0], ...fixed.children[1].children], card, fixed }];
    }
    if (!row.classList.contains("field")) return [];
    const [title, about] = row.children[0].children;
    return [{ name: prefix + title.textContent, about: about?.className === "field-wrong" ? undefined : about?.textContent, said: row.children[0].children.at(-1), kind: row.className.split(" ")[1], controls: row.children[1].children }];
  });
const change = (el, props, type = "input") => (Object.assign(el, props), el.fire(type));
/** A form of the app app.test.one with `schema` and `values`, `running` or not. */
async function openForm(schema, values, { running = false, put } = {}) {
  const page = openWindow({ apps: () => [APP], settings: { "app.test.one": { schema, values, put } } });
  page.stream.emit("hello", hello);
  page.stream.emit("state", running ? { ...state(), running: RUNNING("app.test.one") } : state());
  await settle();
  return { page, form: part(page, "settings") };
}

test("the app's settings are our own form, from its settings file, each field drawn as the local web draws it; the app's words are shown as text", async () => {
  const { page, form } = await openForm(SCHEMA, VALUES);
  const rows = formRows(form);
  assert.deepEqual(rows.map((row) => row.name), ["<b>Title</b>", "24-hour clock", "Theme", "Timing: Minutes", "Timing: At", "Tint", "Place"]);
  assert.equal(rows[0].about, "<img src=x onerror=alert(1)>");
  // How wide each control is: a wide one goes under the words first when the form is narrow (window.css).
  assert.deepEqual(rows.map((row) => row.kind), ["wide", "tiny", "small", "mid", "mid", "small", "geo"]);
  const [title, hour24, theme, minutes, at, tint, place] = rows.map((row) => row.controls);
  assert.deepEqual([title[0].type, title[0].value, title[0].maxLength], ["text", "A", 12]);
  assert.deepEqual([hour24[0].type, hour24[0].role, hour24[0].checked], ["checkbox", "switch", true]);
  // A choice: a button with the chosen option's label, and its list, closed.
  const [trigger, list] = theme;
  assert.deepEqual([trigger.tagName, trigger.role, trigger.value, trigger.children[0].textContent, trigger.ariaExpanded], ["BUTTON", "combobox", "amber", "<u>Amber</u>", "false"]);
  assert.equal(list.hidden, true);
  assert.deepEqual(list.children.map((option) => [option.value, option.children[0].textContent, option.classList.contains("on")]), [["amber", "<u>Amber</u>", true], ["blue", "Blue", false]]);
  // A number: the stepper, its text field and then − and +.
  assert.deepEqual([minutes[0].type, minutes[0].role, minutes[0].value, minutes[0].ariaValueMin, minutes[0].ariaValueMax], ["text", "spinbutton", "25", "1", "120"]);
  assert.deepEqual(minutes.slice(1).map((b) => [b.tagName, b.ariaLabel, b.tabIndex, b.disabled]), [["BUTTON", "Decrement", -1, false], ["BUTTON", "Increment", -1, false]]);
  assert.deepEqual([at[0].type, at[0].value], ["time", "09:30"]);
  // A color: the color field, and the round button that shows its swatch and its value with the alpha.
  assert.deepEqual([tint[0].type, tint[0].value, tint[1].className, tint[1].children[1].textContent], ["color", "#FF8800", "color-pill", "#FF8800CC"]);
  assert.deepEqual(place.map((el) => [el.value, el.hidden]), [["", false], ["Here", false], ["", true], ["", true]]);
  assert.equal(place[0].checked, true, "an auto place has Auto-detect on");
  assert.equal(rows[6].fixed.hidden, true);
  assert.equal(rows[6].card.children[2].children.at(-1).children[1].textContent, "Auto");
  // Nothing of the app's own words went into markup.
  const markup = (el) => (typeof el === "string" ? [] : [el._html, ...el.children.flatMap(markup)]);
  for (const html of markup(page.$("#app-body"))) assert.doesNotMatch(html, /Title|Amber|onerror/);
});

test("Save sends the BUSY Bar the form's values with the schema's version; Restart starts the running app again", async () => {
  const { page, form } = await openForm(SCHEMA, VALUES, { running: true });
  const rows = formRows(form);
  const [title, hour24, theme, minutes, at, tint, place] = rows.map((row) => row.controls);
  change(title[0], { value: "<b>B</b>" });
  change(hour24[0], { checked: false }, "change");
  theme[0].fire("click", { detail: 1 });
  theme[1].children[1].fire("click");
  assert.equal(theme[1].hidden, true, "a pick closes the list");
  assert.equal(theme[0].children[0].textContent, "Blue");
  change(minutes[0], { value: "40" });
  change(at[0], { value: "18:05" });
  change(tint[0], { value: "#00aaff" });
  // A made-up point: one and a half degrees north, two and a half east.
  const point = [1.5, 2.5];
  place[2].value = String(point[0]);
  place[3].value = String(point[1]);
  change(place[0], { checked: false }, "change");
  assert.deepEqual(place.map((el) => el.hidden), [false, false, false, false], "a fixed place has its coordinates");
  assert.equal(rows[6].fixed.hidden, false);
  assert.equal(rows[6].card.children[2].children.at(-1).children[1].textContent, "Here");

  const [save, restart, said] = form.children.at(-1).children;
  page.sent();
  save.fire("click");
  await settle();
  const put = page.requests.find((request) => request.method === "PUT");
  assert.equal(put.url, "/api/apps/settings?app_id=app.test.one");
  assert.deepEqual(JSON.parse(put.body), {
    version: 3,
    values: { title: "<b>B</b>", hour24: false, theme: "blue", timing: { minutes: 40, at: "18:05" }, tint: "#00AAFFCC", place: { mode: "fixed", name: "Here", ...Object.fromEntries(["lat", "lon"].map((key, i) => [key, point[i]])) } },
  });
  assert.equal(said.textContent, "Saved. Restart the app to use them.");
  page.requests.length = 0;
  restart.fire("click");
  await settle();
  assert.deepEqual(page.sent(), ["POST /api/apps/quit", "POST /api/apps/launch?app_id=app.test.one"]);
});

test("values the BUSY Bar refuses are said so, and the form keeps them; an app without a settings file has no form", async () => {
  const page = openWindow({ apps: () => [APP, { id: "app.test.two", name: "Two", version: "2.0" }], settings: { "app.test.one": { schema: SCHEMA, values: VALUES, put: 400 } } });
  page.stream.emit("hello", hello);
  page.stream.emit("state", state());
  await settle();
  const form = part(page, "settings");
  const [save, , said] = form.children.at(-1).children;
  const title = formRows(form)[0].controls[0];
  title.value = "kept";
  title.fire("input");
  save.fire("click");
  await settle();
  assert.equal(said.textContent, "The BUSY Bar refused these values. The console says why.");
  assert.equal(said.className, "said failed");
  // The list changing does not take what was typed away.
  page.stream.emit("apps", {});
  await settle();
  assert.equal(formRows(part(page, "settings"))[0].controls[0].value, "kept");
  // Another app, without settings: no form, and the page says so.
  page.$("#apps").children[1].fire("click");
  await settle();
  assert.equal(part(page, "settings"), null);
  assert.ok(inApp(page).some((el) => el.textContent === "This app has no settings."));
});

const NUMBERS = {
  format_version: 1,
  version: 1,
  fields: {
    count: { type: "integer", label: "Count", default: 4, min: 0, max: 10, step: 2 },
    budget: { type: "integer", label: "Budget", default: 500 },
  },
};

test("a number is the local web's stepper: − and + keep to the field's min, max and step, and are off at its ends", async () => {
  const { form } = await openForm(NUMBERS, { count: 4, budget: 1500000 });
  const [[count, down, up], [budget]] = formRows(form).map((row) => row.controls);
  // A click that no pointer made (an assistive technology's) steps once; a pointer's press is below.
  up.fire("click");
  assert.equal(count.value, "6");
  for (let i = 0; i < 5; i++) up.fire("click");
  assert.deepEqual([count.value, up.disabled, down.disabled], ["10", true, false]);
  for (let i = 0; i < 9; i++) down.fire("click");
  assert.deepEqual([count.value, up.disabled, down.disabled], ["0", false, true]);
  // The number is written with its thousands grouped, as the local web writes it.
  assert.equal(budget.value, "1,500,000");
});

test("a number typed in is set within the bounds and on the step when it is left; the keys step it as the local web's do", async () => {
  const { page, form } = await openForm(NUMBERS, { count: 4, budget: 500 });
  const [[count, down, up], [budget]] = formRows(form).map((row) => row.controls);
  const typed = (el, text, then = "change") => (change(el, { value: text }), then === "Enter" ? el.fire("keydown", { key: "Enter" }) : el.fire(then));
  typed(count, "7");
  assert.equal(count.value, "8", "onto the step from min");
  typed(count, "99", "Enter");
  assert.deepEqual([count.value, up.disabled], ["10", true]);
  typed(count, "abc", "blur");
  assert.equal(count.value, "10", "what is not a number gives the value back");
  const key = (name) => count.fire("keydown", { key: name });
  key("ArrowDown");
  assert.equal(count.value, "8");
  key("PageDown");
  assert.deepEqual([count.value, down.disabled], ["0", true]);
  key("PageUp");
  assert.equal(count.value, "10");
  key("Home");
  assert.equal(count.value, "0");
  key("End");
  assert.equal(count.value, "10");
  // With the commas of its groups, or without, and below a bound the field does not have.
  typed(budget, "2,000");
  assert.equal(budget.value, "2,000");
  typed(budget, "-35");
  assert.equal(budget.value, "-35");
  const [save] = form.children.at(-1).children;
  page.sent();
  save.fire("click");
  await settle();
  assert.deepEqual(JSON.parse(page.requests.find((request) => request.method === "PUT").body).values, { count: 10, budget: -35 });
});

test("a stepper's button held down steps again after a moment and keeps stepping until it is let go or the end is reached", async () => {
  const { form } = await openForm(NUMBERS, { count: 0, budget: 0 });
  const [[count, , up], [budget, , more]] = formRows(form).map((row) => row.controls);
  // The right button only: another one does nothing.
  up.fire("pointerdown", { button: 2 });
  assert.equal(count.value, "0");
  more.fire("pointerdown", { button: 0 });
  assert.equal(budget.value, "1", "a press steps at once");
  await settle(300);
  assert.equal(budget.value, "1", "and waits before it repeats");
  await settle(300);
  more.fire("pointerup");
  const held = Number(budget.value);
  assert.ok(held >= 3, `held for 0.6 s: ${held}`);
  await settle(200);
  assert.equal(Number(budget.value), held, "let go, it stops");
  up.fire("pointerdown", { button: 0 });
  await settle(900);
  assert.deepEqual([count.value, up.disabled], ["10", true], "at the end it stops by itself");
  up.fire("pointerup");
});

test("a choice opens its list under it; the keys go through the options and pick one; one list is open at a time", async () => {
  const schema = { format_version: 1, version: 1, fields: { a: SCHEMA.fields.theme, b: { type: "enum", label: "B", default: "x", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Zed" }] } } };
  const { form } = await openForm(schema, { a: "amber", b: "x" });
  const [[a, aList], [b, bList]] = formRows(form).map((row) => row.controls);
  const lit = (list) => list.children.findIndex((option) => option.classList.contains("lit"));
  // Opened with the pointer: no option is lit until the keys or the pointer go to one.
  b.fire("click", { detail: 1 });
  assert.deepEqual([bList.hidden, b.ariaExpanded, lit(bList)], [false, "true", -1]);
  bList.fire("keydown", { key: "ArrowDown" });
  assert.equal(lit(bList), 0, "the first key goes to the chosen option");
  bList.fire("keydown", { key: "ArrowDown" });
  bList.fire("keydown", { key: "End" });
  assert.equal(lit(bList), 2);
  bList.fire("keydown", { key: "Home" });
  bList.fire("keydown", { key: "z" });
  assert.equal(lit(bList), 2, "a letter goes to the option it starts");
  bList.fire("keydown", { key: "Enter" });
  assert.deepEqual([bList.hidden, b.value, b.children[0].textContent, bList.children.map((option) => option.classList.contains("on"))], [true, "z", "Zed", [false, false, true]]);
  // Opened with a key: the chosen option is lit. Escape closes the list and leaves the value.
  b.fire("keydown", { key: "ArrowDown" });
  assert.deepEqual([bList.hidden, lit(bList)], [false, 2]);
  bList.fire("keydown", { key: "ArrowUp" });
  bList.fire("keydown", { key: "Escape" });
  assert.deepEqual([bList.hidden, b.value], [true, "z"]);
  // Another list opening closes the open one.
  a.fire("click", { detail: 1 });
  b.fire("click", { detail: 1 });
  assert.deepEqual([aList.hidden, bList.hidden], [true, false]);
  b.fire("click", { detail: 1 });
  assert.equal(bList.hidden, true, "a second click closes it");
});

test("a text the BUSY Bar does not take is said under the field, in the local web's words", async () => {
  const schema = { format_version: 1, version: 1, fields: { name: { type: "string", label: "Name", default: "a", min_length: 1, max_length: 4 }, note: { type: "string", label: "Note", default: "", min_length: 2 } } };
  const { form } = await openForm(schema, { name: "a", note: "" });
  const [name, note] = formRows(form);
  assert.deepEqual([note.said.hidden, note.said.textContent, note.controls[0].classList.contains("wrong")], [false, "Too short: 0/2 bytes", true]);
  assert.deepEqual([name.said.hidden, name.controls[0].classList.contains("wrong")], [true, false]);
  change(name.controls[0], { value: "" });
  assert.equal(name.said.textContent, "Required");
  // Bytes, not letters: three letters of two bytes each.
  change(name.controls[0], { value: "ééé" });
  assert.deepEqual([name.said.hidden, name.said.textContent], [false, "Too long: 6/4 bytes"]);
  change(name.controls[0], { value: "abcd" });
  assert.deepEqual([name.said.hidden, name.controls[0].classList.contains("wrong")], [true, false]);
});

// ---------------------------------------------------------------- 4. the server's console lines

// Lines that pass on someone else's text keep its form: an app's console ("<id> <severity>: …") and the firmware's log
// ("[tag] …", "<id> [tag] …").
const RELAYED = [/^\$\{id\} \$\{severity\}: /, /^\[\$\{tag\}\] /, /^\$\{id\} \[\$\{tag\}\] /];

/**
 * The window's console gets what goes through the bar's own log: Device's this.log, which the speaker (audio.mjs) is
 * given as its this.log. The server's `log` option of startServer (server.mjs: the start-up lines, `? GET /path` with
 * --verbose) goes to the terminal only and is not checked here.
 *
 * How the lines of each log call start: the string literals that begin its first argument or a branch of `?:` there. */
function logStarts(source) {
  const found = [];
  const call = /(?<![.\w])this\.log\(/g;
  for (let m; (m = call.exec(source)); ) {
    // Scan the call's arguments, skipping over string literals and template expressions.
    let i = m.index + m[0].length;
    let depth = 1;
    let previous = "(";
    let argument = 0; // only the first argument is the text; the second is its kind
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '"' || c === "'" || c === "`") {
        const start = i;
        i = skipLiteral(source, i);
        if (argument === 0 && ["(", "?", ":"].includes(previous)) found.push({ text: source.slice(start + 1, i - 1), line: source.slice(0, start).split("\n").length });
        previous = "literal";
        continue;
      }
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "," && depth === 1) argument++;
      if (!/\s/.test(c)) previous = c;
      i++;
    }
  }
  return found;
}

function skipLiteral(s, i) {
  const quote = s[i++];
  while (i < s.length && s[i] !== quote) {
    if (s[i] === "\\") i += 2;
    else if (quote === "`" && s[i] === "$" && s[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (depth > 0 && i < s.length) {
        if (s[i] === '"' || s[i] === "'" || s[i] === "`") i = skipLiteral(s, i);
        else {
          if (s[i] === "{") depth++;
          if (s[i] === "}") depth--;
          i++;
        }
      }
    } else i++;
  }
  return i + 1;
}

test("the console lines the server writes start with a capital letter", () => {
  const files = readdirSync(here).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  const starts = files.flatMap((file) => logStarts(readFileSync(join(here, file), "utf8")).map((s) => ({ file, ...s })));
  assert.ok(starts.length >= 20, `log calls found: ${starts.length}`);
  const wrong = starts.filter(({ text }) => !RELAYED.some((r) => r.test(text)) && !/^[A-Z]/.test(text));
  assert.deepEqual(wrong.map(({ file, line, text }) => `${file}:${line} ${text.slice(0, 50)}`), []);
});

test("the window keeps the start of the server's own lines and drops only an app's console prefix", () => {
  const page = openWindow();
  page.stream.emit("hello", hello);
  page.stream.emit("log", { kind: "error", text: "App one: JS heap overflow: the supervisor takes over, as on a BUSY Bar", time: 0 });
  page.stream.emit("log", { kind: "warn", text: "one warn: careful", time: 0 });
  const lines = page.$("#console").children.map((line) => line.querySelector(".text").textContent);
  assert.deepEqual(lines, ["App one: JS heap overflow: the supervisor takes over, as on a BUSY Bar", "careful"]);
});

// A failed install is seen in the window's console as it opens: its line is of a kind the console's filters, as the
// page sets them, do not hide (today Lifecycle is on, System is off, and the other kinds have no filter).
const filters = [...readFileSync(join(here, "legacy-window/index.html"), "utf8").matchAll(/<input type="checkbox" data-kind="(\w+)"( checked)?>/g)];
assert.ok(filters.length >= 2, "the console's filters in index.html");
const hiddenByDefault = filters.filter(([, , checked]) => !checked).map(([, kind]) => kind);
const shownByDefault = (kind) => !hiddenByDefault.includes(kind);
const temporary = [];
after(() => temporary.forEach((f) => rmSync(f, { recursive: true, force: true })));

function freshBar() {
  const root = mkdtempSync(join(tmpdir(), "emu-window-"));
  temporary.push(root);
  const device = new Device({ dataDir: root, log: () => {}, firmware: loadFirmware(), sidecars: false });
  const lines = [];
  device.events.on("log", (line) => lines.push(line));
  const stage = (archive) => device.handle("POST", "http://127.0.0.1/api/apps/stage", {}, readFileSync(join(here, "../../test/archives", archive)));
  return { root, device, lines, stage };
}

for (const [archive, said] of [["not-an-archive.tgz", /^Cannot unpack the app package: /], ["no-main.tgz", /^Cannot install the app package: /], ["api-newer.tgz", /^Cannot install \S+: it needs API /]]) {
  test(`a package the BUSY Bar refuses (${archive}) is said in a console line shown by default`, LOUD, async () => {
    const bar = freshBar();
    const answer = await bar.stage(archive);
    assert.equal(answer.status, 400);
    const line = bar.lines.find((l) => said.test(l.text));
    assert.ok(line, bar.lines.map((l) => `${l.kind} ${l.text}`).join("\n"));
    assert.ok(shownByDefault(line.kind), `kind ${line.kind}, hidden until the filter is turned on`);
  });
}

test("an install that fails is said in a console line shown by default", LOUD, async () => {
  const bar = freshBar();
  const staged = await bar.stage("macos-clean.tgz");
  assert.equal(staged.status, 200);
  // The apps folder now leads out of the data folder: the emulator refuses to move the app there.
  const apps = join(bar.root, "ext", "user_assets");
  const outside = mkdtempSync(join(tmpdir(), "emu-window-outside-"));
  temporary.push(outside);
  rmSync(apps, { recursive: true, force: true });
  // A junction on Windows: a symbolic link needs a right a standard user's terminal does not have (Developer Mode off).
  symlinkSync(outside, apps, process.platform === "win32" ? "junction" : undefined);
  const key = JSON.parse(Buffer.from(staged.body).toString()).install_key;
  const installed = await bar.device.handle("POST", `http://127.0.0.1/api/apps/install?install_key=${key}`, {}, null);
  assert.equal(installed.status, 400);
  const line = bar.lines.find((l) => /^Cannot install /.test(l.text));
  assert.ok(line, bar.lines.map((l) => `${l.kind} ${l.text}`).join("\n"));
  assert.ok(shownByDefault(line.kind), `kind ${line.kind}, hidden until the filter is turned on`);
});

// ---- publishing (pull request 82)

test("Publish… in the opened app's More and Publish open the publishing flow for the chosen project, and nothing is checked or written by the click alone", async () => {
  const shell = shellActions({ projects: [PROJECT] });
  const page = await openShell(shell);
  assert.deepEqual([page.$("#publish").ariaDisabled, page.$("#publish").title], ["false", "Get the app ready for its public repository and the catalog. Nothing is sent."]);
  actionButtons(page)["Publish…"].fire("click");
  page.$("#publish").fire("click");
  await settle();
  assert.deepEqual(plain(shell.calls).filter(([name]) => name === "publish.open"), [["publish.open", PROJECT.folder], ["publish.open", PROJECT.folder]]);
  assert.deepEqual(plain(shell.calls).filter(([name]) => ["check", "submit"].includes(name)), [], "the flow runs the checks, not the button");
});

test("Publish is there to press only for an app with a project folder, and says why not", async () => {
  const none = await openShell(shellActions({ projects: [] }), { apps: [APP] });
  assert.deepEqual([none.$("#publish").ariaDisabled, none.$("#publish").title], ["true", "This app has no project folder to publish from"]);
  const browser = openWindow({ apps: () => [APP] });
  browser.stream.emit("hello", hello);
  await settle();
  assert.deepEqual([browser.$("#publish").ariaDisabled, browser.$("#publish").title], ["true", "Available in the BUSY Bar Emulator app"]);
});

test("the publishing flow writes markup of its own only: icons by their names; the project's words go in as text", () => {
  const script = windowFile("publish.js");
  const written = [...script.matchAll(/\.innerHTML = ([^\n]+);\n/g)].map((m) => m[1]);
  assert.ok(written.length >= 3, `innerHTML is written in ${written.length} places`);
  // The category's icon: a name of the set from a table of the script's own, or none.
  for (const value of written) assert.match(value, /^(?:icon\(("[a-z0-9-]+"|picture|CATEGORY_ICONS\[[a-z.]+\] \?\? "apps")\)|current \? icon\(CATEGORY_ICONS\[current\.id\] \?\? "apps"\) : ""|el\.dataset\.copiedFrom)$/, value.slice(0, 80));
  // What copied() puts back is the button's own markup, kept before its tick.
  assert.match(script, /if \(!el\.dataset\.copiedFrom\) el\.dataset\.copiedFrom = el\.innerHTML;/);
  // icon() writes nothing for a name that is not one of the set's form.
  assert.match(script, /const icon = \(name\) => \(\/\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$\/\.test\(name\) \?/);
  assert.doesNotMatch(script, /insertAdjacentHTML|outerHTML|document\.write|\beval\(|new Function|setAttribute\("on/);
});

// ---------------------------------------------------------------- the canvas's tools: Screenshot and Record

/** The desktop app's actions with its capture tools; `answers` gives what each answers, `captured` the page's calls. */
function captureShell({ answers = {}, projects = [PROJECT] } = {}) {
  const shell = shellActions({ projects });
  const captured = [];
  const captureListeners = [];
  const reply = (name, arg) => {
    captured.push(arg === undefined ? [name] : [name, plain(arg)]);
    const given = answers[name];
    return typeof given === "function" ? given(arg) : Promise.resolve(given ?? { ok: true });
  };
  const jobOn = shell.on;
  return Object.assign(shell, {
    captured,
    tell: (event) => captureListeners.forEach((cb) => cb(event)),
    on(name, cb) {
      if (name === "capture") return void captureListeners.push(cb);
      return jobOn(name, cb);
    },
    capture: {
      screenshot: (target) => reply("screenshot", target),
      record: { start: (target) => reply("start", target), stop: () => reply("stop"), state: async () => ({ recording: false, saving: false, startedAt: null, maxSeconds: 120 }) },
      reveal: (file) => reply("reveal", file),
    },
  });
}

test("the tools in a browser are not there to be pressed, and say where they are", async () => {
  const page = openWindow();
  page.stream.emit("hello", hello);
  await settle();
  assert.deepEqual([page.$("#shot-take").ariaDisabled, page.$("#shot-take").title], ["true", "Available in the BUSY Bar Emulator app"]);
  assert.deepEqual([page.$("#capture-record").ariaDisabled, page.$("#capture-record").title], ["true", "Available in the BUSY Bar Emulator app"]);
});

test("the Screenshot module is in the top bar with Front and Back ticked and its button; Record beside it", () => {
  const html = readFileSync(join(here, "legacy-window/index.html"), "utf8");
  const module = html.match(/<div class="seg shot-float" id="shot-float"[^>]*>([\s\S]*?)\n {6}<\/div>/);
  assert.ok(module, "no Screenshot module");
  assert.deepEqual([...module[1].matchAll(/<input type="checkbox" id="(shot-\w+)" checked>/g)].map((m) => m[1]), ["shot-front", "shot-back"]);
  assert.deepEqual([...module[1].matchAll(/<label[^>]*>.*?<\/span>(\w+)<\/label>/g)].map((m) => m[1]), ["Front", "Back"]);
  // The camera alone, named for a screen reader and in its tooltip.
  assert.match(module[1], /<button type="button" class="shot-take" id="shot-take" title="Screenshot" aria-label="Screenshot"><svg[^>]*><use href="\/emulator\/icons\/busy-sprite\.svg#bi-camera"\/><\/svg><\/button>/);
  // In the top bar (layout V2); the old button in the canvas's tools is gone.
  assert.ok(html.indexOf('id="shot-float"') > html.indexOf('<header class="topbar"') && html.indexOf('id="shot-float"') < html.indexOf("</header>"));
  assert.doesNotMatch(html, /id="capture-shot"/);
  // Record: beside the camera, in the same group; hidden in the markup until the window's script shows it, and the flag
  // (RECORD_BUTTON) turns it off again in one place.
  assert.match(module[1], /id="shot-take"[\s\S]*<span class="capture-tools" id="capture-tools" role="group" aria-label="Record" hidden><button type="button" class="tool" id="capture-record"[^>]*><svg[^>]*><use href="\/emulator\/icons\/busy-sprite\.svg#bi-video"\/>/);
  assert.equal(openWindow({ actions: captureShell() }).$("#capture-tools").hidden, false);
  assert.equal(openWindow({ actions: captureShell(), record: false }).$("#capture-tools").hidden, true);
});

test("Front and Back: both ticked at first, the only one ticked stays ticked, and the window remembers them", async () => {
  const kept = new Map();
  const shell = captureShell({ answers: { screenshot: { ok: true, saved: [], message: null } } });
  const page = await openShell(shell, { running: RUNNING("app.test.one"), kept });
  const [front, back] = [page.$("#shot-front"), page.$("#shot-back")];
  assert.deepEqual([front.checked, back.checked], [true, true]);
  page.$("#shot-take").fire("pointerenter");
  assert.equal(page.$("#shot-take").title, "Screenshot of both displays, saved in the screenshots folder of One (Ctrl+Shift+S)");
  front.checked = false;
  front.fire("change");
  assert.deepEqual([front.checked, back.checked], [false, true]);
  assert.equal(kept.get("busy-emulator.screenshot-displays"), '["back"]');
  assert.equal(page.$("#shot-back-tick").classList.contains("last"), true);
  assert.equal(page.$("#shot-back-tick").title, "The back display, 160\u00d780. At least one display is taken");
  assert.equal(page.$("#shot-take").title, "Screenshot of the back display, saved in the screenshots folder of One (Ctrl+Shift+S)");
  // Unticking the last one: it stays.
  back.checked = false;
  back.fire("change");
  assert.deepEqual([front.checked, back.checked], [false, true]);
  assert.equal(kept.get("busy-emulator.screenshot-displays"), '["back"]');
  page.$("#shot-take").fire("click");
  await settle();
  assert.deepEqual(shell.captured, [["screenshot", { folder: PROJECT.folder, name: "One", displays: ["back"] }]]);

  // A new window (or the app again): what was ticked.
  const again = await openShell(captureShell(), { running: RUNNING("app.test.one"), kept });
  assert.deepEqual([again.$("#shot-front").checked, again.$("#shot-back").checked], [false, true]);
  front.checked = true;
  front.fire("change");
  assert.equal(kept.get("busy-emulator.screenshot-displays"), '["front","back"]');
  assert.equal(page.$("#shot-back-tick").classList.contains("last"), false);
  // What is kept and is not a list of displays: both.
  for (const value of ["[]", '["side"]', "front", "{"]) {
    const odd = await openShell(captureShell(), { kept: new Map([["busy-emulator.screenshot-displays", value]]) });
    assert.deepEqual([odd.$("#shot-front").checked, odd.$("#shot-back").checked], [true, true], value);
  }
});

test("Screenshot names the running app's project and the ticked displays; the toast says what was saved, shows it and the way to it", async () => {
  const file = "/Users/you/Projects/experiments/one/screenshots/front-3.png";
  const shell = captureShell({ answers: { screenshot: { ok: true, folder: PROJECT.folder, saved: [{ display: "front", file, relative: "screenshots/front-3.png" }, { display: "back", file: file.replace("front", "back"), relative: "screenshots/back-3.png" }], message: "Saved screenshots/front-3.png and back-3.png" } } });
  const page = await openShell(shell, { running: RUNNING("app.test.one") });
  page.$("#shot-take").fire("click");
  await settle();
  assert.deepEqual(shell.captured, [["screenshot", { folder: PROJECT.folder, name: "One", displays: ["front", "back"] }]]);
  assert.equal(page.$("#capture-toast").hidden, false);
  assert.equal(page.$("#capture-said").textContent, "Saved screenshots/front-3.png and back-3.png");
  assert.deepEqual([page.$("#shot-thumbs").hidden, page.$("#shot-thumb-front").hidden, page.$("#shot-thumb-back").hidden], [false, false, false]);
  assert.equal(page.$("#capture-reveal").textContent, "Show in Finder");
  page.$("#capture-reveal").fire("click");
  await settle();
  assert.deepEqual(shell.captured.at(-1), ["reveal", file]);

  // The keys: Ctrl+Shift+S (Cmd on a Mac) takes one too; S alone is not it.
  page.fire("keydown", { key: "s", ctrlKey: false, shiftKey: true });
  page.fire("keydown", { key: "S", ctrlKey: true, shiftKey: true });
  await settle();
  assert.equal(shell.captured.filter(([name]) => name === "screenshot").length, 2);
  page.fire("keydown", { key: "s", metaKey: true, shiftKey: true });
  await settle();
  assert.equal(shell.captured.filter(([name]) => name === "screenshot").length, 3);

  // Only the front saved (the back failed): only its picture.
  const one = captureShell({ answers: { screenshot: { ok: true, folder: PROJECT.folder, saved: [{ display: "front", file, relative: "screenshots/front-3.png" }], message: "Saved screenshots/front-3.png" } } });
  const page1 = await openShell(one, { running: RUNNING("app.test.one") });
  page1.$("#shot-take").fire("click");
  await settle();
  assert.deepEqual([page1.$("#shot-thumb-front").hidden, page1.$("#shot-thumb-back").hidden], [false, true]);

  // An app with no project: the folder is null, and the desktop app asks where in its Save dialog.
  const other = captureShell({ answers: { screenshot: { ok: true, saved: [], message: null } } });
  const page2 = await openShell(other, { apps: [APP, { id: "app.test.pkg", name: "Packaged", version: "3.0" }], running: RUNNING("app.test.pkg") });
  page2.$("#shot-take").fire("pointerenter");
  assert.equal(page2.$("#shot-take").title, "Screenshot of both displays: choose where to save it (Ctrl+Shift+S)");
  page2.$("#shot-take").fire("click");
  await settle();
  assert.deepEqual(other.captured, [["screenshot", { folder: null, name: "Packaged", displays: ["front", "back"] }]]);
  assert.equal(page2.$("#capture-said").textContent, "", "Cancel in the dialog says nothing");
  // A failure: said, no pictures.
  const failed = captureShell({ answers: { screenshot: { ok: false, code: "screen_failed", message: "The BUSY Bar gave no frame." } } });
  const page3 = await openShell(failed, { running: RUNNING("app.test.one") });
  page3.$("#shot-take").fire("click");
  await settle();
  assert.deepEqual([page3.$("#capture-said").textContent, page3.$("#shot-thumbs").hidden], ["The BUSY Bar gave no frame.", true]);
});

test("Record asks the desktop app for its state once; with the flag off, nothing", async () => {
  const shell = captureShell();
  let asked = 0;
  shell.capture.record.state = async () => (asked++, { recording: false, saving: false, startedAt: null, maxSeconds: 120 });
  await openShell(shell, { running: RUNNING("app.test.one"), record: false });
  assert.equal(asked, 0);
  await openShell(shell, { running: RUNNING("app.test.one") });
  assert.equal(asked, 1);
});

/** The menu Record opens: its items as [layout, label, tooltip]. */
const recordMenuOf = (page) => page.global.document.body.children.filter((el) => el.id === "record-menu").at(-1) ?? null;
const recordItems = (page) => recordMenuOf(page)?.children.map((item) => [item.dataset.layout, item.children[0]?.textContent, item.title]) ?? null;

test("Record's first press opens the menu of what to record: the window, a post, the front display; the choice starts it and is kept", async () => {
  const kept = new Map();
  const shell = captureShell({ answers: { start: { ok: true, layout: "post", startedAt: 1, maxSeconds: 120 } } });
  const page = await openShell(shell, { running: RUNNING("app.test.one"), kept });
  const button = page.$("#capture-record");
  assert.deepEqual([button.ariaHasPopup, button.ariaExpanded], ["menu", "false"]);
  button.fire("click");
  await settle();
  assert.deepEqual(shell.captured, [], "nothing starts at the press");
  assert.deepEqual(recordItems(page), [
    ["window", "Window", "The window as you see it, at most 1920\u00d71080"],
    ["post", "Post, 1080\u00d71920", "Upright, for Reels, TikTok and X: the BUSY Bar, its back display and the app's name"],
    ["front", "Front display", "The front display alone, 1080\u00d7240, for a page or a README"],
  ]);
  assert.equal(button.ariaExpanded, "true");
  assert.match(recordMenuOf(page).children[1].innerHTML, /bi-phone/);
  // A second press closes it.
  button.fire("click");
  assert.equal(button.ariaExpanded, "false");
  button.fire("click");
  recordMenuOf(page).children[1].fire("click");
  await settle();
  assert.deepEqual(shell.captured, [["start", { folder: PROJECT.folder, name: "One", layout: "post" }]]);
  assert.equal(kept.get("busy-emulator.record-layout"), "post");
  assert.deepEqual([button.ariaPressed, button.className.includes("recording")], ["true", true]);
  assert.equal(button.ariaHasPopup, null, "while it records, the press stops it");
});

test("Record of a post that fails while it records: the toast says why, with the hint", async () => {
  const shell = captureShell({ answers: { start: { ok: true, layout: "post", startedAt: 1, maxSeconds: 120 } } });
  const page = await openShell(shell, { running: RUNNING("app.test.one") });
  page.$("#capture-record").fire("click");
  recordMenuOf(page).children[1].fire("click");
  await settle();
  shell.tell({ kind: "recording", state: "failed", message: "The recording failed: the BUSY Bar is off.", hint: "Turn the BUSY Bar on in the emulator's window (any button), then record." });
  assert.equal(page.$("#capture-said").textContent, "The recording failed: the BUSY Bar is off. Turn the BUSY Bar on in the emulator's window (any button), then record.");
  assert.ok(page.$("#capture-toast").className.includes("failed"));
  assert.equal(page.$("#capture-record").ariaPressed, "false");
});

test("Record toggles: the first press starts and the button turns red and counts; the second stops, and the toast names the video", async () => {
  let time = 0;
  let stop;
  const shell = captureShell({ answers: { start: { ok: true, startedAt: 1, maxSeconds: 120 }, stop: () => new Promise((resolve) => (stop = resolve)) } });
  const page = await openShell(shell, { running: RUNNING("app.test.one"), now: () => time });
  const button = page.$("#capture-record");
  assert.deepEqual([button.ariaPressed, button.className.includes("recording"), button.title], ["false", false, "Record a video, up to 2 min"]);
  button.fire("click");
  recordMenuOf(page).children[0].fire("click");
  await settle();
  assert.deepEqual(shell.captured, [["start", { folder: PROJECT.folder, name: "One", layout: "window" }]]);
  assert.deepEqual([button.ariaPressed, button.className.includes("recording"), page.$("#capture-time").hidden, button.title], ["true", true, false, "Stop recording and save the video"]);
  assert.match(button.innerHTML, /bi-control-stop/);
  time = 75_400;
  await settle(300);
  assert.equal(page.$("#capture-time").textContent, "1:15");

  button.fire("click");
  await settle();
  assert.deepEqual(shell.captured.at(-1), ["stop"]);
  assert.deepEqual([button.className.includes("saving"), button.ariaDisabled], [true, "true"], "while the Save dialog is open");
  button.fire("click");
  await settle();
  assert.equal(shell.captured.filter(([name]) => name === "stop").length, 1, "no second stop while saving");
  stop({ ok: true, file: "/Users/you/Projects/experiments/one/media/One 2026-11-11 15.42.07.mp4", name: "One 2026-11-11 15.42.07.mp4", seconds: 75.4, limit: false });
  await settle();
  assert.deepEqual([button.ariaPressed, button.className.includes("recording"), page.$("#capture-time").hidden], ["false", false, true]);
  assert.equal(page.$("#capture-said").textContent, "Saved One 2026-11-11 15.42.07.mp4");
  assert.equal(page.$("#capture-reveal").hidden, false);
  // A video under 3 s is said to be short for Instagram.
  shell.tell({ kind: "recording", state: "recording", startedAt: Date.now(), maxSeconds: 120 });
  shell.tell({ kind: "recording", state: "saved", file: "/m/Short.mp4", name: "Short.mp4", seconds: 1.8, limit: false });
  assert.equal(page.$("#capture-said").textContent, "Saved Short.mp4. Under 3 s: too short for Instagram");
});

test("Record stops by itself at its longest: the page is told, then of the file; a refusal is said, a late click asks for another", async () => {
  const shell = captureShell({ answers: { start: { ok: true, startedAt: 1, maxSeconds: 120 } } });
  const page = await openShell(shell, { running: RUNNING("app.test.one") });
  const button = page.$("#capture-record");
  button.fire("click");
  recordMenuOf(page).children[0].fire("click");
  await settle();
  shell.tell({ kind: "recording", state: "saving", reason: "limit", maxSeconds: 120 });
  assert.deepEqual([button.className.includes("saving"), page.$("#capture-time").textContent], [true, "2:00"]);
  shell.tell({ kind: "recording", state: "saved", file: "/m/One.mp4", name: "One.mp4", limit: true });
  assert.equal(page.$("#capture-said").textContent, "Stopped at 2 min. Saved One.mp4");
  assert.equal(button.className.includes("recording"), false);

  const refused = captureShell({ answers: { start: { ok: false, code: "window_hidden", message: "The window must be on the screen to be recorded." } } });
  const page2 = await openShell(refused, { running: RUNNING("app.test.one") });
  page2.$("#capture-record").fire("click");
  recordMenuOf(page2).children[0].fire("click");
  await settle();
  assert.equal(page2.$("#capture-said").textContent, "The window must be on the screen to be recorded.");
  assert.equal(page2.$("#capture-record").ariaPressed, "false");

  const late = captureShell({ answers: { screenshot: () => Promise.reject(Object.assign(new Error("The app does this only just after a click or a key in its window."), { code: "no_gesture" })) } });
  const page3 = await openShell(late, { running: RUNNING("app.test.one") });
  page3.$("#shot-take").fire("click");
  await settle();
  assert.equal(page3.$("#capture-said").textContent, "Click again");
});

test("an app ended by the BUSY Bar's restart or power-off has not crashed; one ended by an error has", async () => {
  const shell = shellActions();
  const page = await openShell(shell);
  page.$("#apps").children[0].fire("click");
  await settle();
  const crashed = () => page.$("#app-facts").innerText.includes("Ended with an error");
  const end = (reason) => {
    page.stream.emit("log", { kind: "app", text: `Launch ${PROJECT.id} (heap 96 KiB)`, time: 0 });
    page.stream.emit("log", { kind: "app", text: `App ${PROJECT.id} exited: ${reason}; heap peak 3.0 of 96 KiB`, time: 0 });
  };
  assert.equal(crashed(), false, "nothing ended yet");
  end("power");
  await settle();
  assert.equal(crashed(), false, "Restart BUSY Bar ends the app with the reason power: not a crash");
  end("error app main.js: boom");
  await settle();
  assert.equal(crashed(), true, "an error is a crash");
});
