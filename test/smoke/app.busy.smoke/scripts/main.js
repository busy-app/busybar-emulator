// The smoke test's app (emulator/test/smoke.mjs). From its own JS it draws the scene "text-color-center" of
// test/golden.mjs, whose front frame was recorded on a bar (test/golden/text-color-center.json); the expected PNG,
// test/smoke/front.png, is that frame. Then it keeps running until it is stopped, as an app does. The elements are
// written as JSON so that test/smoke.test.mjs can check them against the golden's.
const APP = "app.busy.smoke";
const elements = [{ "id": "t", "type": "text", "text": "Focus 25:00", "font": "normal", "x": 36, "y": 8, "align": "center", "color": "#00C0FFFF" }];
const body = JSON.stringify({ application_name: APP, priority: 50, elements });
fetch("http://localhost/api/display/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body })
  .then((r) => r.text().then((text) => console.log("smoke: draw answered " + r.status + " " + text)))
  .catch((e) => console.log("smoke: draw failed: " + e));
setInterval(() => {}, 1000);
