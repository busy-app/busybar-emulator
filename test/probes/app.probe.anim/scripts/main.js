// Animation probe: the load for the tick meter (emulator/test/ticks.mjs). The firmware plays a 60 frames a second
// animation on the front display, and the app's JS redraws a counter over it five times a second, so both the system
// (the GUI's ticks) and the app's runtime (a timer, fetch, display/draw) work all the time.
const APP = "app.probe.anim";

function draw(elements) {
  const body = JSON.stringify({ application_name: APP, priority: 50, elements });
  return fetch("http://localhost/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body }).then((r) => r.text());
}

let count = 0;
const counter = () => ({ id: "t", type: "text", x: 70, y: 4, align: "top_right", display: "front", font: "small", z_index: 2, text: String(count++ % 1000) });

draw([{ id: "a", type: "animation", x: 0, y: 0, display: "front", z_index: 1, stock_path: "shared/coding_72x16.anim", loop: true }, counter()])
  .then(() => setInterval(() => draw([counter()]), 200))
  .catch((e) => console.log("animation probe failed: " + e));
