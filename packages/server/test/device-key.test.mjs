// The emulator's answer to a request made with the device key (device-key.mjs): the weather forecast the official
// Weather app asks for. The saved answer is composed with a public place, Accra, so the emulator ships no one's
// location (EMU-244); its times are moved to now, and the app gets it through the firmware's own fetch.
//
//   node --test "packages/server/test/*.test.mjs"      (from emulator/)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { deviceKeyAnswer } from "../device-key.mjs";
import { loadFirmware } from "../firmware.mjs";
import { AppRuntime } from "../runtime.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const saved = JSON.parse(readFileSync(join(server, "canned", "weather-forecast.json"), "utf8"));
const firmwares = Object.keys(JSON.parse(readFileSync(join(server, "../engine/firmware.json"), "utf8")).versions);

const FORECAST = "https://apps-api.busy.app/weather/v1/forecast";
const HOUR = 3600000;
const ACCRA = { latitude: 5.6, longitude: -0.2, name: "Accra", timezone: "Africa/Accra", utc_offset_seconds: 0, source: "geoip" };
const body = (answer) => JSON.parse(new TextDecoder().decode(answer.body));
// What the Weather app makes of an hour's time: the place's local time, turned into a moment by the place's offset.
const moment = (time, offsetSeconds) => Date.parse(`${time}Z`) - offsetSeconds * 1000;
const savedAt = (hour) => saved.response.hourly.find((h) => Number(h.time.slice(11, 13)) === hour);

describe("the saved weather answer", () => {
  test("is composed, says so, and its place is Accra", () => {
    assert.match(saved._comment, /^Composed, not recorded: a forecast for Accra/);
    assert.deepEqual(saved.response.location, ACCRA);
  });

  test("has the shape of the API's answer: 24 hours, one of each hour of the day, and 7 days", () => {
    const { current, hourly, daily } = saved.response;
    assert.deepEqual(Object.keys(current).sort(), ["is_day", "temperature", "time", "weather_code"]);
    assert.equal(hourly.length, 24);
    assert.deepEqual(hourly.map((h) => Number(h.time.slice(11, 13))).sort((a, b) => a - b), [...Array(24).keys()]);
    for (const h of hourly) {
      assert.deepEqual(Object.keys(h).sort(), ["is_day", "temperature", "time", "weather_code"]);
      assert.ok(typeof h.temperature === "number" && Number.isInteger(h.weather_code) && typeof h.is_day === "boolean", JSON.stringify(h));
    }
    assert.equal(daily.length, 7);
    for (const d of daily) assert.ok(typeof d.day.temperature === "number" && Number.isInteger(d.day.weather_code) && typeof d.night.temperature === "number" && Number.isInteger(d.night.weather_code), JSON.stringify(d));
  });
});

describe("deviceKeyAnswer", () => {
  test("answers the forecast with the saved place, its times moved to now: hours keep their hour of the day", () => {
    // 23:40 UTC, which is Accra's time: the last hour of a day, so the forecast runs into the next one.
    const now = Date.UTC(2031, 2, 4, 23, 40, 12);
    const answer = deviceKeyAnswer(FORECAST, "GET", now);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.headers, [["Content-Type", "application/json"], ["x-emulator", "canned"]]);
    const f = body(answer);
    assert.deepEqual(f.location, ACCRA);
    assert.deepEqual(f.current, { time: "2031-03-04T23:30", temperature: savedAt(23).temperature, weather_code: savedAt(23).weather_code, is_day: savedAt(23).is_day });
    assert.equal(f.hourly.length, 24);
    f.hourly.forEach((h, i) => {
      const hour = (23 + i) % 24;
      assert.equal(h.time, i === 0 ? "2031-03-04T23:00" : `2031-03-05T${String(hour).padStart(2, "0")}:00`);
      assert.deepEqual({ ...h, time: undefined }, { ...savedAt(hour), time: undefined }, `hour ${hour}`);
    });
    assert.deepEqual(f.daily.map((d) => d.date), ["2031-03-04", "2031-03-05", "2031-03-06", "2031-03-07", "2031-03-08", "2031-03-09", "2031-03-10"]);
    f.daily.forEach((d, i) => assert.deepEqual({ day: d.day, night: d.night }, { day: saved.response.daily[i].day, night: saved.response.daily[i].night }));
  });

  test("now is the first hour, as the Weather app reads it", () => {
    const now = Date.now();
    const f = body(deviceKeyAnswer(FORECAST, "GET", now));
    const first = moment(f.hourly[0].time, f.location.utc_offset_seconds);
    assert.ok(first <= now && now < first + HOUR, `${f.hourly[0].time} for ${new Date(now).toISOString()}`);
    const today = new Date(now + f.location.utc_offset_seconds * 1000).toISOString().slice(0, 10);
    assert.equal(f.daily[0].date, today);
  });

  test("with coordinates, the place is the one asked for, and so are its time zone, its hours and its day", () => {
    // 16:40 UTC is 02:40 of the next day at 151.2 degrees east (UTC+10, by the longitude).
    const f = body(deviceKeyAnswer(`${FORECAST}?latitude=-33.87&longitude=151.21`, "GET", Date.UTC(2031, 2, 4, 16, 40)));
    assert.deepEqual(f.location, { latitude: -33.9, longitude: 151.2, name: null, timezone: "Etc/GMT-10", utc_offset_seconds: 36000, source: "request" });
    assert.equal(f.current.time, "2031-03-05T02:30");
    assert.equal(f.current.temperature, savedAt(2).temperature);
    assert.equal(f.hourly[0].time, "2031-03-05T02:00");
    assert.equal(f.daily[0].date, "2031-03-05");
  });

  test("another path of the API is 404 as the API says it; another host is not the emulator's to answer", () => {
    const missing = deviceKeyAnswer("https://apps-api.busy.app/weather/v2/forecast", "GET");
    assert.equal(missing.status, 404);
    assert.deepEqual(body(missing), { detail: "Not Found" });
    assert.equal(deviceKeyAnswer("https://example.com/weather/v1/forecast", "GET"), null);
  });
});

// The request the official Weather app (app.busy.weather 0.6.2) makes, and what it reads from the answer, in an app of
// this test's own: the app itself is BUSY's and is not in the repository.
const SCRIPT = `
fetch(${JSON.stringify(FORECAST)}, { dispatcher: { connect: { useDeviceKey: true } } })
  .then((r) => r.json().then((t) => {
    const offset = t.location.utc_offset_seconds;
    const hours = t.hourly.map((h) => Date.parse(h.time + "Z") - offset * 1000);
    console.log(JSON.stringify({ ok: r.ok, status: r.status, canned: r.headers.get("x-emulator"), name: t.location.name, timezone: t.location.timezone,
      now: Date.now(), first: hours[0], hours: hours.length, days: t.daily.length, temp: t.current.temperature }));
  }))
  .catch((e) => console.log(JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) })));
`;

describe("the Weather app's request in the firmware's runtime", () => {
  for (const name of firmwares) {
    test(`firmware ${name}: the app gets the saved answer for Accra, starting at the current hour`, async () => {
      const firmware = loadFirmware(name);
      const asked = [];
      let line;
      await new Promise((resolve, reject) => {
        const runtime = new AppRuntime({
          firmware,
          appId: "app.test.weather",
          heapKib: 96,
          entry: "/test.js",
          readFile: (p) => (p === "/test.js" ? new TextEncoder().encode(SCRIPT) : null),
          writeFile: () => false,
          localApi: async () => ({ status: 404, headers: [], body: new Uint8Array() }),
          deviceKey: (url, method) => (asked.push(`${method} ${url}`), deviceKeyAnswer(url, method)),
          onConsole: (severity, text) => (line = text),
          onLog: () => {},
          onExit: (reason) => (reason === "finished" ? resolve() : reject(new Error(reason))),
        });
        runtime.start().catch(reject);
        setTimeout(() => reject(new Error("the app did not finish in 20 s")), 20000).unref();
      });
      assert.deepEqual(asked, [`GET ${FORECAST}`]);
      const r = JSON.parse(line);
      assert.deepEqual({ ok: r.ok, status: r.status, canned: r.canned, name: r.name, timezone: r.timezone, hours: r.hours, days: r.days }, { ok: true, status: 200, canned: "canned", name: "Accra", timezone: "Africa/Accra", hours: 24, days: 7 });
      // The answer is made when the request is; the app reads the clock a moment later, which may be in the next hour.
      assert.ok(r.first <= r.now && r.now < r.first + HOUR + 5000, JSON.stringify(r));
      assert.equal(typeof r.temp, "number");
    });
  }
});
