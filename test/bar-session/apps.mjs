// The probe apps of the BUSY Bar session: their scripts, made for each run (a marker in the log, a size, an address). Every
// app that could fill the heap waits for OK before it does: after a restart the APPS menu opens the last app again, and
// an app that filled the heap on its own at the start would restart the BUSY Bar again and again.

const PRELUDE = (id, marker) => `
const ID = ${JSON.stringify(id)};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const msg = (e) => String(e && e.message !== undefined ? e.message : e);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function line(text) {
  return fetch("http://localhost/api/display/draw", { method: "POST", body: JSON.stringify({ application_name: ID, priority: 50, elements: [{ id: "t", type: "text", text: String(text), font: "small", x: 0, y: 4 }] }) });
}
${marker ? `console.log(${JSON.stringify(marker)});` : ""}
`;

/** The apps of EMU-350 that fail while they run; golden.mjs draws the same ones (its error scenes). */
export function errorApp(kind, id, marker = "") {
  const head = PRELUDE(id, marker);
  if (kind === "throw") return `${head}line("throw");\nsetTimeout(function () { throw new Error("boom"); }, 2000);\nsetInterval(function () {}, 1000);\n`;
  if (kind === "handler") return `${head}line("handler");\nlisten("input", function () { notDefinedAnywhere(); });\nsetInterval(function () {}, 1000);\n`;
  if (kind === "rejection") {
    // Draws the same line each second, and counts the seconds in its localStorage: whether it still runs.
    return `${head}line("rejection");\nPromise.reject(new Error("x"));\nlet ticks = 0;\nsetInterval(function () { ticks++; save("ticks", ticks); line("rejection"); }, 1000);\n`;
  }
  throw new Error(`no error app ${kind}`);
}

/** EMU-349: every input event with its Date.now(), the last 300, saved a few times a second; the last one shown. */
export function inputApp(id, marker) {
  return `${PRELUDE(id, marker)}
const events = [];
let dirty = false;
listen("input", function (e) {
  const one = { key: e.key, action: e.action, t: Date.now() };
  if (e.delta !== undefined) one.delta = e.delta;
  events.push(one);
  if (events.length > 300) events.shift();
  dirty = true;
  if (e.key === "back" && e.action === "press") console.log("kit-input back press " + one.t);
  line(e.key + " " + e.action);
});
setInterval(function () {
  if (!dirty) return;
  dirty = false;
  save("events", events);
}, 200);
line("ready");
`;
}

/** EMU-350: fills the heap when OK is pressed, not before. */
export function oomApp(id, marker) {
  return `${PRELUDE(id, marker)}
var kept = [];
line("kit probe, do not press");
listen("input", function (e) {
  if (e.key !== "ok" || e.action !== "short") return;
  console.log("kit-oom fill " + Date.now());
  for (;;) kept.push("0123456789abcdef" + kept.length);
});
setInterval(function () {}, 1000);
`;
}

/** EMU-350: JSON.parse of the answer at `url` when OK is pressed; how it went, in localStorage. */
export function jsonApp(id, marker, url) {
  return `${PRELUDE(id, marker)}
line("kit probe, do not press");
listen("input", function (e) {
  if (e.key !== "ok" || e.action !== "short") return;
  save("json", { phase: "fetch" });
  fetch(${JSON.stringify(url)})
    .then((r) => r.text())
    .then((text) => {
      save("json", { phase: "parse", length: text.length });
      const value = JSON.parse(text);
      save("json", { phase: "done", length: text.length, items: value.items.length });
      line("parsed");
    })
    .catch((e) => save("json", { phase: "failed", error: msg(e) }));
});
setInterval(function () {}, 1000);
`;
}

/** EMU-351: r.text() of the answer at `url` when OK is pressed. */
export function textApp(id, marker, url) {
  return `${PRELUDE(id, marker)}
line("kit probe, do not press");
listen("input", function (e) {
  if (e.key !== "ok" || e.action !== "short") return;
  save("text", { phase: "fetch" });
  const t0 = Date.now();
  fetch(${JSON.stringify(url)})
    .then((r) => r.text())
    .then((text) => save("text", { phase: "done", length: text.length, ms: Date.now() - t0 }))
    .catch((e) => save("text", { phase: "failed", error: msg(e), ms: Date.now() - t0 }));
});
setInterval(function () {}, 1000);
`;
}

/** EMU-351: each address `times` times, one request after another: the time from fetch() to the body's text. */
export function networkApp(id, marker, urls, times) {
  return `${PRELUDE(id, marker)}
const urls = ${JSON.stringify(urls)};
const out = {};
let chain = Promise.resolve();
for (const url of urls) {
  out[url] = [];
  for (let i = 0; i < ${times}; i++) {
    chain = chain.then(() => {
      const t0 = Date.now();
      return fetch(url)
        .then((r) => r.text().then((text) => out[url].push({ status: r.status, ms: Date.now() - t0, bytes: text.length })))
        .catch((e) => out[url].push({ error: msg(e), ms: Date.now() - t0 }));
    });
  }
}
chain.then(() => { save("network", out); line("done"); });
`;
}

/** EMU-351: the body of each address read piece by piece (r.body): when the first and the last piece came. */
export function bodyApp(id, marker, urls) {
  return `${PRELUDE(id, marker)}
const urls = ${JSON.stringify(urls)};
const out = {};
let chain = Promise.resolve();
for (const url of urls) {
  chain = chain.then(() => {
    const t0 = Date.now();
    return fetch(url).then((r) => {
      const reader = r.body.getReader();
      let bytes = 0, pieces = 0, first = null, last = null;
      const pump = () => reader.read().then((part) => {
        if (part.done) return { status: r.status, bytes, pieces, headMs: head, firstMs: first, lastMs: last };
        bytes += part.value.length;
        pieces++;
        last = Date.now() - t0;
        if (first === null) first = last;
        return pump();
      });
      const head = Date.now() - t0;
      return pump();
    }).then((v) => { out[url] = v; }, (e) => { out[url] = { error: msg(e), ms: Date.now() - t0 }; });
  });
}
chain.then(() => { save("body", out); line("done"); });
`;
}

/**
 * EMU-352: timers, the order of a zero timeout and an answer, clearTimeout of a timer that fired, localStorage, the
 * console. `big`: instead, values of 1, 16 and 64 KiB in localStorage when OK is pressed (only with the owner's
 * consent: it may fill the heap).
 */
export function timersApp(id, marker, big = false) {
  if (big) {
    // Only the values, and only when OK is pressed: an app that may fill its heap waits (the note at the top).
    return `${PRELUDE(id, marker)}
const out = {};
line("kit probe, do not press");
listen("input", function (e) {
  if (e.key !== "ok" || e.action !== "short") return;
  out.storage = {};
  for (const size of [1024, 16384, 65536]) {
    let value = "";
    while (value.length < size) value += "0123456789abcdef";
    save("trying", size);
    try {
      localStorage.setItem("v" + size, value);
      const back = localStorage.getItem("v" + size);
      out.storage[size] = back === value ? "kept" : "changed: " + (back === null ? "null" : back.length);
    } catch (e) {
      out.storage[size] = "threw " + msg(e);
    }
    localStorage.removeItem("v" + size);
  }
  save("timers", out);
  line("done");
});
setInterval(function () {}, 1000);
`;
  }
  return `${PRELUDE(id, marker)}
const out = {};
out.persisted = localStorage.getItem("persist");
localStorage.setItem("persist", "set by the run before");
// Which run this is: the kit waits for the result of the run it started.
out.runs = Number(localStorage.getItem("runs") || 0) + 1;
localStorage.setItem("runs", String(out.runs));
// 1. setInterval of 100 ms for 10 s: each run's time.
const ticks = [];
const t0 = Date.now();
const timer = setInterval(function () {
  ticks.push(Date.now() - t0);
  if (ticks.length < 100) return;
  clearInterval(timer);
  out.interval = ticks;
  // Not second() here: a request in the callback of an interval just cleared ends the app in the emulator (a fatal
  // assertion of the runtime, both firmwares; clearThenFetchApp asks the BUSY Bar).
  setTimeout(second, 0);
}, 100);
// Keeps the app running until it is done: in the emulator a timeout set in the callback of an interval just cleared is
// otherwise lost, and the app ends (18.11).
const alive = setInterval(function () {}, 1000);
// 2. A timeout of 0, a promise and a request to the BUSY Bar's own API: in what order they come.
function second() {
  const order = [];
  fetch("http://localhost/api/version").then(() => order.push("fetch answered"), () => order.push("fetch failed"));
  setTimeout(() => order.push("setTimeout 0"), 0);
  Promise.resolve().then(() => order.push("promise"));
  order.push("sync");
  setTimeout(() => { out.order = order; third(); }, 1500);
}
// 3. clearTimeout of a timer that fired already: the log says what (EMU-344).
function third() {
  const handle = setTimeout(function () {
    console.log("kit-timers fired");
    setTimeout(function () { clearTimeout(handle); console.log("kit-timers cleared after it fired"); fourth(); }, 50);
  }, 10);
}
// 4. localStorage: values of 1 and 16 KiB, a key that is not there.
function fourth() {
  const sizes = [1024, 16384];
  out.storage = {};
  for (const size of sizes) {
    let value = "";
    while (value.length < size) value += "0123456789abcdef";
    try {
      localStorage.setItem("v" + size, value);
      const back = localStorage.getItem("v" + size);
      out.storage[size] = back === value ? "kept" : "changed: " + (back === null ? "null" : back.length);
    } catch (e) {
      out.storage[size] = "threw " + msg(e);
    }
    localStorage.removeItem("v" + size);
  }
  const none = localStorage.getItem("no such key");
  out.missing = none === null ? "null" : typeof none + " " + String(none);
  fifth();
}
// 5. The console, every level, a string, a number, an object, 1 KiB.
function fifth() {
  let kib = "";
  while (kib.length < 1024) kib += "kit-console-kib-";
  for (const level of ["log", "info", "warn", "error"]) {
    if (typeof console[level] !== "function") { out["console." + level] = "missing"; continue; }
    console[level]("kit-console " + level + " string");
    console[level](42);
    console[level]({ kit: level, n: 1 });
    console[level](kib);
    out["console." + level] = "called";
  }
  save("timers", out);
  line("done");
  clearInterval(alive);
}
`;
}

/**
 * EMU-352: a request in the callback of an interval that has just cleared itself, when OK is pressed. In the emulator
 * this ends the app with a fatal assertion of the runtime (1.3.1 and 1.4.1, 18.11): what does the BUSY Bar do?
 */
export function clearThenFetchApp(id, marker) {
  return `${PRELUDE(id, marker)}
line("kit probe, do not press");
listen("input", function (e) {
  if (e.key !== "ok" || e.action !== "short") return;
  let n = 0;
  const timer = setInterval(function () {
    n++;
    if (n < 3) return;
    clearInterval(timer);
    save("clear-then-fetch", { phase: "cleared" });
    fetch("http://localhost/api/version").then(
      (r) => save("clear-then-fetch", { phase: "answered", status: r.status }),
      (e) => save("clear-then-fetch", { phase: "failed", error: msg(e) }),
    );
  }, 100);
});
setInterval(function () {}, 1000);
`;
}

/** EMU-354: a string with every code 0..255 written by the app to /ext/data/z.bin. */
export function charsApp(id, marker) {
  return `${PRELUDE(id, marker)}
let s = "";
for (let i = 0; i < 256; i++) s += String.fromCharCode(i);
fetch("http://localhost/api/storage/write?path=/ext/data/z.bin", { method: "POST", body: s })
  .then((r) => r.text().then((text) => ({ status: r.status, text }), (e) => ({ status: r.status, error: msg(e) })), (e) => ({ error: msg(e) }))
  .then((v) => save("chars", v));
setInterval(function () {}, 1000);
`;
}

/** EMU-354: one refused write of `size` bytes to the app's assets, and whether it ends in 10 s. */
export function refusedWriteApp(id, marker, size) {
  return `${PRELUDE(id, marker)}
let body = "";
while (body.length < ${size}) body += "x";
const t0 = Date.now();
save("write", { phase: "sent" });
fetch("http://localhost/api/storage/write?path=/ext/user_assets/" + ID + "/x", { method: "POST", body })
  .then((r) => r.text().then((text) => ({ status: r.status, text }), (e) => ({ status: r.status, error: msg(e) })), (e) => ({ error: msg(e) }))
  .then((v) => { v.ms = Date.now() - t0; save("write", { phase: "ended", value: v }); });
setInterval(function () {}, 1000);
`;
}

/** EMU-355: the steps of the task, each one's answer and time, in localStorage. */
export function soundApp(id, marker) {
  return `${PRELUDE(id, marker)}
const steps = [];
const call = (name, method, body) => {
  const t = Date.now();
  return fetch("http://localhost/api/audio/play", body === undefined ? { method } : { method, body })
    .then((r) => r.text().then((text) => ({ status: r.status, text }), (e) => ({ status: r.status, error: msg(e) })), (e) => ({ error: msg(e) }))
    .then((v) => { v.ms = Date.now() - t; v.at = t; steps.push([name, v]); save("steps", steps); });
};
const play = (path) => JSON.stringify({ application_name: ID, path });
line("sound");
wait(5000)
  .then(() => call("1 play a.snd on a cold amplifier", "POST", play("sounds/a.snd")))
  .then(() => wait(300)).then(() => call("2 play a.snd while it plays", "POST", play("sounds/a.snd")))
  .then(() => wait(300)).then(() => call("3 play b.snd while a.snd plays", "POST", play("sounds/b.snd")))
  .then(() => wait(100)).then(() => call("4 stop while it plays", "DELETE"))
  .then(() => wait(300)).then(() => call("4 stop when nothing plays", "DELETE"))
  .then(() => wait(5000)).then(() => call("5 a missing file on a cold amplifier", "POST", play("sounds/none.snd")))
  .then(() => call("5 b.snd to warm it", "POST", play("sounds/b.snd")))
  .then(() => wait(1000)).then(() => call("5 a missing file on a warm amplifier", "POST", play("sounds/none.snd")))
  .then(() => call("6 a body without a path", "POST", JSON.stringify({ application_name: ID })))
  .then(() => call("6 a body that is not JSON", "POST", "not json"))
  .then(() => wait(5000)).then(() => call("7 a.snd to its end", "POST", play("sounds/a.snd")))
  .then(() => wait(3000)).then(() => call("7 b.snd 1 s after a.snd ended", "POST", play("sounds/b.snd")))
  .then(() => wait(4500)).then(() => call("7 b.snd 4 s after it ended", "POST", play("sounds/b.snd")))
  .then(() => wait(1000)).then(() => { save("done", true); line("done"); });
`;
}

/** EMU-347: draws each of its pictures by the name it has in the project; each answer in localStorage. */
export function namesApp(id, marker, paths) {
  return `${PRELUDE(id, marker)}
const paths = ${JSON.stringify(paths)};
const out = {};
let chain = Promise.resolve();
for (const path of paths) {
  chain = chain.then(() => fetch("http://localhost/api/display/draw", { method: "POST", body: JSON.stringify({ application_name: ID, priority: 50, elements: [{ id: "p", type: "image", path, x: 0, y: 0 }] }) })
    .then((r) => r.text().then((text) => { out[path] = { status: r.status, text: text.trim() }; }, (e) => { out[path] = { status: r.status, error: msg(e) }; }), (e) => { out[path] = { error: msg(e) }; }));
}
chain.then(() => save("names", out));
setInterval(function () {}, 1000);
`;
}

/** Raw 16-bit mono PCM at 44100 Hz: a soft tone of `ms`, so that the owner hears it play at whatever volume the BUSY Bar has. */
export function tone(ms, hz = 440) {
  const n = Math.round((44100 * ms) / 1000);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 44100) * 1500), i * 2);
  return out;
}
