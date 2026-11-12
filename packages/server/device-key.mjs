// Requests an app makes with the bar's own key: fetch(url, { dispatcher: { connect: { useDeviceKey: true } } }).
// On a bar the TLS connection is then signed with the device's certificate, which is how BUSY's apps API
// (apps-api.busy.app) knows a bar is asking; without it the API answers 403. The emulator has no such key, so for the
// API's known endpoints it answers itself, from saved answers (canned/) with their times moved to now. A saved answer
// is composed in the shape of what a real bar got, never recorded as it came: the API places a bar by its address,
// so a recorded answer names the place of whoever recorded it. The weather's place is Accra.
//
// Anything else asked with the device key goes out without it, as an ordinary request, and the server decides.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const forecast = JSON.parse(readFileSync(join(here, "canned", "weather-forecast.json"), "utf8"));

const HOUR = 3600000;
const pad = (n) => String(n).padStart(2, "0");
// "2026-11-09T23:00" of a moment in the place's local time.
const localMinute = (ms, offsetMs) => new Date(ms + offsetMs).toISOString().slice(0, 16);

/**
 * The weather forecast: the saved one, starting now. Hours keep their place in the day (the temperature and the
 * weather of 14:00 stay at 14:00), days follow from today. With ?latitude=&longitude= the place is the one asked for,
 * as the API answers a request with coordinates; its time zone is taken from the longitude.
 */
function weatherForecast(url, now) {
  const base = forecast.response;
  const lat = Number(url.searchParams.get("latitude"));
  const lon = Number(url.searchParams.get("longitude"));
  const asked = url.searchParams.has("latitude") && url.searchParams.has("longitude") && Number.isFinite(lat) && Number.isFinite(lon);
  const offsetHours = asked ? Math.round(lon / 15) : base.location.utc_offset_seconds / 3600;
  const offsetMs = offsetHours * HOUR;
  const location = asked
    ? { latitude: Math.round(lat * 10) / 10, longitude: Math.round(lon * 10) / 10, name: null, timezone: offsetHours ? `Etc/GMT${offsetHours > 0 ? "-" : "+"}${Math.abs(offsetHours)}` : "Etc/UTC", utc_offset_seconds: offsetHours * 3600, source: "request" }
    : base.location;
  // The saved hours by hour of the day.
  const byHour = new Map(base.hourly.map((h) => [Number(h.time.slice(11, 13)), h]));
  const at = (ms) => {
    const hour = new Date(ms + offsetMs).getUTCHours();
    const h = byHour.get(hour) ?? base.hourly[0];
    return { temperature: h.temperature, weather_code: h.weather_code, is_day: h.is_day };
  };
  const firstHour = Math.floor((now + offsetMs) / HOUR) * HOUR - offsetMs;
  const hourly = base.hourly.map((_, i) => ({ time: localMinute(firstHour + i * HOUR, offsetMs), ...at(firstHour + i * HOUR) }));
  const quarter = Math.floor(now / (15 * 60000)) * 15 * 60000;
  const today = new Date(now + offsetMs);
  const daily = base.daily.map((d, i) => {
    const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
    return { ...d, date: `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}` };
  });
  return { location, current: { time: localMinute(quarter, offsetMs), ...at(now) }, hourly, daily };
}

const reply = (status, value) => ({ status, headers: [["Content-Type", "application/json"], ["x-emulator", "canned"]], body: new TextEncoder().encode(JSON.stringify(value)) });

/**
 * The emulator's own answer to a request made with the device key, or null when it has none and the request should
 * go to the network without the key.
 * @returns {{ status: number, headers: [string, string][], body: Uint8Array } | null}
 */
export function deviceKeyAnswer(urlText, method, now = Date.now()) {
  const url = new URL(urlText);
  if (url.hostname !== "apps-api.busy.app") return null;
  if (method === "GET" && url.pathname === "/weather/v1/forecast") return reply(200, weatherForecast(url, now));
  // What the API says of a path it does not have.
  return reply(404, { detail: "Not Found" });
}
