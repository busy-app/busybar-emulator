// Compare probe: draws its settings (top line) and the last four input events (bottom line).
const APP = "app.probe.cmp";
let top = "...";
const events = [];
function draw() {
  const elements = [
    { id: "s", type: "text", x: 0, y: 0, font: "small", display: "front", text: top },
    { id: "k", type: "text", x: 0, y: 8, font: "small", display: "front", text: events.join(" ") || "-" },
  ];
  return fetch("http://localhost/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ application_name: APP, priority: 50, elements }) }).then((r) => r.text());
}
fetch("http://localhost/api/apps/settings?app_id=" + APP)
  .then((r) => r.text())
  .then((t) => {
    console.log("settings " + t);
    try { const v = JSON.parse(t).values; top = v.label + " " + v.count + " " + (v.flag ? "T" : "F"); } catch (e) { top = "bad"; }
    return draw();
  })
  .catch((e) => { top = "err"; draw(); });
listen("input", (e) => {
  events.push(e.key.slice(0, 2) + (e.action ? e.action.slice(0, 1) : "") + (e.delta !== undefined ? e.delta : ""));
  if (events.length > 4) events.shift();
  draw();
});
