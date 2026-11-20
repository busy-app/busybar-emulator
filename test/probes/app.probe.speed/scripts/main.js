// Speed probe: the same measurements on a BUSY Bar and in the emulator, for the emulator's bar speed
// (emulator/server/bar-speed.mjs). The results go to localStorage under "speed", where emulator/test/speed.mjs reads
// them back from /ext/apps_data/jsrunner/app.probe.speed.localstorage.json on either side.
//
//   step       the Doom-fire step of app.probe.bench: numbers and typed arrays
//   xpm        a full 72x16 frame of that fire as XPM2 text, 32 colors: strings
//   drawFull   POST /api/display/draw with that frame, from fetch() to the answer's text
//   drawText   the same with one short text element
//   loopFps    step + xpm + draw, one frame after another, as an app animating from JS would
//   calls      an app's frame made the way apps make one: a 72x7 XPM of digits by String(), one call a pixel, and
//              the draw's body around it by JSON.stringify (the drawtime probe of EMU-344): function calls
//   noCalls    the same XPM of digits without a call: a digit taken from a string by index (EMU-344)
//   cheapCalls an empty JS function called as often as calls calls String(): the price of a call alone (EMU-344)
//   drawtime   the drawtime probe itself: its frame made, then drawn, ten times one after another
//   drawtimeFrame  the same JS, but the draw sends this probe's 72x16 frame of 32 colors (made before the clock):
//              whether a heavier frame shows the redraw after a draw (redrawMs, EMU-317)
const APP = "app.probe.speed";
const W = 72;
const H = 16;
const heat = new Uint8Array(W * H);

function step(t) {
  for (let x = 0; x < W; x++) heat[(H - 1) * W + x] = 20 + ((Math.random() * 12) | 0);
  for (let y = 1; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = heat[y * W + x];
      const r = (Math.random() * 3) | 0;
      let dst = x - r + 1;
      if (dst < 0) dst = 0;
      else if (dst >= W) dst = W - 1;
      const v = src - (r & 1) - (t & 1);
      heat[(y - 1) * W + dst] = v > 0 ? v : 0;
    }
  }
}

// 32 colors from black through red and yellow to white, one character each.
const SYMBOLS = "0123456789abcdefghijklmnopqrstuv";
const hex = (n) => (n < 16 ? "0" : "") + n.toString(16);
const PALETTE = [];
for (let i = 0; i < 32; i++) {
  const r = Math.min(255, i * 24);
  const g = Math.max(0, Math.min(255, (i - 10) * 24));
  const b = Math.max(0, Math.min(255, (i - 21) * 24));
  PALETTE.push(SYMBOLS[i] + " c #" + hex(r) + hex(g) + hex(b));
}

function xpm() {
  const lines = ["! XPM2", W + " " + H + " 32 1"].concat(PALETTE);
  for (let y = 0; y < H; y++) {
    let row = "";
    for (let x = 0; x < W; x++) row += SYMBOLS[heat[y * W + x] & 31];
    lines.push(row);
  }
  return lines.join("\n");
}

// The calls piece: what the drawtime probe of EMU-344 timed as "build-only", in the same shape its TypeScript compiles to.
function graph(seed) {
  const rows = [];
  for (let r = 0; r < 7; r += 1) {
    let line = "";
    for (let c = 0; c < 72; c += 1) line += String((r * 7 + c * 3 + seed) % 5);
    rows.push(line);
  }
  return ["! XPM2", "72 7 5 1", "0 c #262C36", "1 c #0E5C2E", "2 c #108F3E", "3 c #2BC653", "4 c #56F08A", ...rows].join("\n");
}

function elements(i) {
  return [
    { id: "t", type: "text", display: "front", align: "top_left", x: 1, y: -1, text: `run ${i}`, font: "small", color: "#FFFFFFFF", z_index: 2 },
    { id: "g", type: "xpmbitmap", display: "front", align: "top_left", x: 0, y: 9, data: graph(i), z_index: 1 },
  ];
}

const calls = (i) => JSON.stringify({ application_name: "app.probe.drawtime", priority: 50, elements: elements(i + 200) });

// The drawtime probe's body as this app sends it: the calls piece under this app's name.
const drawtimeBody = (i) => JSON.stringify({ application_name: APP, priority: 50, elements: elements(i + 200) });

// The calls piece's XPM without a call: the digit by index into a string.
const DIGITS = "01234";
function noCalls(seed) {
  const rows = [];
  for (let r = 0; r < 7; r += 1) {
    let line = "";
    for (let c = 0; c < 72; c += 1) line += DIGITS[(r * 7 + c * 3 + seed) % 5];
    rows.push(line);
  }
  return rows.length;
}

// As many calls as the calls piece makes of String(), to a function that does nothing.
function nothing(x) {}
function cheapCalls(seed) {
  for (let k = 0; k < 504; k += 1) nothing(k + seed);
}

function body(elements) {
  return JSON.stringify({ application_name: APP, priority: 50, elements });
}

const frameBody = () => body([{ id: "f", type: "xpmbitmap", x: 0, y: 0, display: "front", data: xpm() }]);
const textBody = (i) => body([{ id: "t", type: "text", x: 0, y: 4, display: "front", font: "small", text: "12:" + (10 + (i % 50)) }]);

function draw(text) {
  return fetch("http://localhost/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body: text }).then((r) => r.text());
}

// Average ms of fn, run again and again for about `budget` ms (at least 3 times).
function timed(fn, budget) {
  const t0 = Date.now();
  let n = 0;
  while (n < 3 || Date.now() - t0 < budget) fn(n++);
  return (Date.now() - t0) / n;
}

// Average ms of `count` draws made one after another; the bodies are made before the clock starts.
function timedDraws(make, count) {
  const bodies = [];
  for (let i = 0; i < count; i++) bodies.push(make(i));
  const t0 = Date.now();
  let chain = Promise.resolve();
  for (let i = 0; i < count; i++) chain = chain.then(() => draw(bodies[i]));
  return chain.then(() => (Date.now() - t0) / count);
}

// The measurements. Everything above is definitions: speed.mjs runs them on their own to count the pieces' work.
const result = {};
result.stepMs = timed(step, 2000);
result.xpmMs = timed(xpm, 1500);
result.callsMs = timed(calls, 1500);
result.noCallsMs = timed(noCalls, 1500);
result.cheapCallsMs = timed(cheapCalls, 1500);
result.drawFullBytes = frameBody().length;
result.drawTextBytes = textBody(0).length;

timedDraws(textBody, 10)
  .then((ms) => {
    result.drawTextMs = ms;
    return timedDraws(frameBody, 10);
  })
  .then((ms) => {
    result.drawFullMs = ms;
    // The drawtime probe: each draw's body made after the last one's answer, then sent.
    const t0 = Date.now();
    let chain = Promise.resolve();
    for (let i = 0; i < 10; i++) chain = chain.then(() => draw(drawtimeBody(i)));
    return chain.then(() => {
      result.drawtimeMs = (Date.now() - t0) / 10;
    });
  })
  .then(() => {
    // The same JS, this probe's frame drawn.
    const frame = frameBody();
    const t0 = Date.now();
    let chain = Promise.resolve();
    for (let i = 0; i < 10; i++) chain = chain.then(() => (drawtimeBody(i), draw(frame)));
    return chain.then(() => {
      result.drawtimeFrameMs = (Date.now() - t0) / 10;
    });
  })
  .then(() => {
    // Frame after frame for 5 s. Each frame starts from the last one's answer and the promises are not chained, so a
    // fast emulator does not pile them up in the heap.
    return new Promise((resolve) => {
      const t0 = Date.now();
      let frames = 0;
      const next = () => {
        if (Date.now() - t0 >= 5000) return resolve(frames / ((Date.now() - t0) / 1000));
        step(frames);
        frames++;
        draw(frameBody()).then(next);
      };
      next();
    });
  })
  .then((fps) => {
    result.loopFps = fps;
    localStorage.setItem("speed", JSON.stringify(result));
    console.log("speed " + JSON.stringify(result));
    return draw(body([{ id: "f", type: "text", x: 0, y: 4, display: "front", font: "small", text: "done" }]));
  })
  .catch((e) => console.log("speed probe failed: " + e));
