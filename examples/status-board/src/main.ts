import { device } from "@shared/device";
import { createScreen, type Element } from "@shared/screen";
import { flag, integer, loadValues, text } from "@shared/settings";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8F9CFF";
const GREEN = "#22E06AFF";
const AMBER = "#FFB020FF";
const RED = "#FF4030FF";

/** The address that shows every state in turn without a network. */
const DEMO = "demo";
const DEMO_INTERVAL_S = 4;
/** What the wheel steps through, seconds between checks. */
const INTERVALS = [5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
/** An answer larger than this is not read: the app's whole heap is 96 KiB, and a big body would end the app. */
const MAX_BODY_BYTES = 8 * 1024;
/** How long the front display shows the new interval after the wheel moved. */
const NOTE_MS = 1500;

type Settings = {
  url: string;
  label: string;
  /** Path into the JSON answer, as keys; empty: only the HTTP status counts. */
  field: string[];
  healthy: string[];
  interval: number;
  slowMs: number;
  headers: Record<string, string> | null;
  sound: boolean;
};

async function loadSettings(): Promise<Settings> {
  const values = await loadValues();
  const header = text(values, "header", "");
  const colon = header.indexOf(":");
  return {
    url: text(values, "url", "https://www.githubstatus.com/api/v2/status.json") || DEMO,
    label: text(values, "label", "GITHUB").toUpperCase().slice(0, 8),
    field: text(values, "field", "status.indicator")
      .split(".")
      .filter((key) => key !== ""),
    healthy: text(values, "healthy", "none, ok, up, passing, success, operational, green, true")
      .toLowerCase()
      .split(",")
      .map((word) => word.trim())
      .filter((word) => word !== ""),
    interval: integer(values, "interval", 60, 5, 3600),
    slowMs: integer(values, "slow_ms", 4000, 0, 60000),
    headers: colon > 0 ? { [header.slice(0, colon).trim()]: header.slice(colon + 1).trim() } : null,
    sound: flag(values, "sound", false),
  };
}

// ----------------------------------------------------------------------------------------------------- the check

type Health = "wait" | "up" | "slow" | "down";

type Result = {
  health: Health;
  /** The status word on the front display: the field's value, UP, or what went wrong. */
  word: string;
  /** One line for the back display: what was read, or the failure in the bar's own words. */
  detail: string;
  /** How long the answer took; null when there was none. */
  ms: number | null;
  /** When the check ended, bar clock, ms. */
  at: number;
};

const result = (health: Health, word: string, detail: string, ms: number | null): Result => ({ health, word: printable(word).toUpperCase().slice(0, 12) || "?", detail: printable(detail), ms, at: Date.now() });

/** The bar's fonts are printable ASCII; a text element with anything else is refused. */
function printable(value: string): string {
  let out = "";
  for (const ch of value) out += ch >= " " && ch <= "~" ? ch : "?";
  return out.trim();
}

/** Asks the address once. Never throws: every way it can go wrong is a result the screen shows. */
async function check(s: Settings): Promise<Result> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(s.url, s.headers ? { headers: s.headers } : undefined);
  } catch (err) {
    // On the bar `fetch` rejects with a plain string: "Inactivity timeout" after 5 s without data, "Failed to
    // connect to server", "Failed to establish TLS connection", "Incomplete response body".
    const reason = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(reason)) return result("down", "TIMEOUT", reason, null);
    if (!(await online())) return result("down", "NO WIFI", "the bar is not on Wi-Fi", null);
    return result("down", /connect|TLS/i.test(reason) ? "NO ANSWER" : "ERROR", reason, null);
  }
  const ms = Date.now() - started;
  if (!response.ok) return result("down", `HTTP ${response.status}`, `HTTP ${response.status} in ${ms} ms`, ms);
  const speed: Health = s.slowMs > 0 && ms > s.slowMs ? "slow" : "up";
  if (s.field.length === 0) return result(speed, speed === "slow" ? "SLOW" : "UP", `HTTP ${response.status} in ${ms} ms`, ms);

  if (Number(response.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) {
    return result("down", "TOO BIG", `the answer is over ${MAX_BODY_BYTES / 1024} KiB`, ms);
  }
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    return result("down", "BAD JSON", "the answer is not JSON", ms);
  }
  for (const key of s.field) {
    if (value === null || typeof value !== "object" || !(key in (value as object))) {
      return result("down", "NO FIELD", `no ${s.field.join(".")} in the answer`, ms);
    }
    value = (value as Record<string, unknown>)[key];
  }
  const word = typeof value === "string" ? value : JSON.stringify(value);
  const detail = `${s.field.join(".")} = ${word.slice(0, 20)}`;
  // Healthy reads UP whatever the value is called; a value that is not healthy is itself the word: MAJOR, FAILING.
  if (s.healthy.includes(word.toLowerCase())) return result(speed, speed === "slow" ? "SLOW" : "UP", detail, ms);
  return result("down", word, detail, ms);
}

async function online(): Promise<boolean> {
  try {
    return (await device.WifiStatusGet()).state === "connected";
  } catch {
    // Not knowing is not "offline".
    return true;
  }
}

/** The demo: every state in turn, as if an address had answered so. */
const DEMO_SCRIPT: Array<[Health, string, string, number | null]> = [
  ["up", "UP", "status.indicator = none", 240],
  ["up", "UP", "status.indicator = none", 310],
  ["slow", "SLOW", "status.indicator = none", 4200],
  ["down", "major", "status.indicator = major", 280],
  ["down", "TIMEOUT", "Inactivity timeout", null],
  ["down", "HTTP 503", "HTTP 503 in 190 ms", 190],
];

// ---------------------------------------------------------------------------------------------------- the screen

const COLOR: Record<Health, string> = { wait: GRAY, up: GREEN, slow: AMBER, down: RED };

/** The small font's letters advance about 4 px. */
const CHAR = 4;

/**
 * The front display, 72x16: the pulse fills it, with the name and the status word over its top five rows. The pulse
 * is one animation with a section per state, which the firmware plays by itself 25 times a second.
 */
function front(s: Settings, last: Result, note: string | null): Element[] {
  const word = note ?? last.word;
  const room = Math.floor((72 - (s.label === "" ? 0 : s.label.length * CHAR + 3)) / CHAR);
  const elements: Element[] = [
    { id: "pulse", type: "animation", path: "animations/pulse.anim", section: last.health, loop: true, x: 0, y: 0, z_index: 0 },
    { id: "word", type: "text", text: word.slice(0, room), font: "small", color: note ? WHITE : COLOR[last.health], x: 72, y: -2, align: "top_right", z_index: 2 },
  ];
  if (s.label !== "") elements.push({ id: "label", type: "text", text: s.label, font: "small", color: GRAY, x: 0, y: -2, align: "top_left", z_index: 2 });
  return elements;
}

/** "https://www.example.com:8443/health?x=1" → "www.example.com:8443". */
function host(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "");
}

function every(seconds: number): string {
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * The back display, 160x80 in gray, faces the person at the desk: what was asked, what came back, how the checks
 * went. The firmware's status bar takes the right 12 px. The time since the last check counts up by itself.
 */
function back(s: Settings, last: Result, interval: number, checks: number, healthy: number): Element[] {
  const line = (id: string, value: string, font: string, y: number): Element => ({ id, type: "text", text: value.slice(0, 36) || "-", font, x: 74, y, align: "top_mid", display: "back" });
  const elements = [
    line("b_name", `${s.label || "STATUS"}: ${last.health === "wait" ? "CHECKING" : last.health === "down" ? "DOWN" : last.health === "slow" ? "SLOW" : "UP"}`, "normal", 0),
    line("b_host", s.url === DEMO ? "demo: no address is asked" : host(s.url), "small", 16),
    line("b_detail", last.detail, "small", 26),
    line("b_count", checks === 0 ? "first check" : `healthy ${healthy} of ${checks} checks${last.ms === null ? "" : `, ${last.ms} ms`}`, "small", 36),
    line("b_keys", `START  check now`, "small", 58),
    line("b_wheel", `WHEEL  every ${every(interval)}`, "small", 67),
  ];
  if (last.health !== "wait") {
    elements.push({ id: "b_ago_label", type: "text", text: "checked", font: "small", x: 68, y: 46, align: "top_right", display: "back" });
    elements.push({ id: "b_ago", type: "countdown", timestamp: String(Math.round(last.at / 1000)), direction: "time_since", show_hours: "when_non_zero", x: 72, y: 47, align: "top_left", display: "back" });
  }
  return elements;
}

// ------------------------------------------------------------------------------------------------------- the app

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  const screen = createScreen(APP);
  let settings: Settings | null = null;
  let last: Result = result("wait", "CHECKING", "waiting for the first answer", null);
  let interval = 60;
  let checks = 0;
  let healthy = 0;
  let demoStep = 0;
  let checking = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let note: string | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  /** Clearing a timer that was never set makes the firmware log a warning, so only real ones are cleared. */
  const cancel = (id: ReturnType<typeof setTimeout> | undefined) => {
    if (id !== undefined) clearTimeout(id);
  };

  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  function render(led: string | null = null): void {
    if (stopped || !settings) return;
    void screen.draw([...front(settings, last, note), ...back(settings, last, interval, checks, healthy)], led);
  }

  /** One check at a time; the next is scheduled only when this one has ended, so a slow address is not asked twice. */
  async function run(): Promise<void> {
    if (stopped || checking || !settings) return;
    checking = true;
    cancel(timer);
    let now: Result;
    if (settings.url === DEMO) {
      const [health, word, detail, ms] = DEMO_SCRIPT[demoStep++ % DEMO_SCRIPT.length]!;
      now = result(health, word, detail, ms);
    } else {
      now = await check(settings);
    }
    checking = false;
    if (stopped) return;

    const wasDown = last.health === "down";
    const isDown = now.health === "down";
    checks += 1;
    if (!isDown) healthy += 1;
    if (isDown && now.word !== last.word) report(`${settings.url}: ${now.detail}`);
    // The bar's light blinks on the way down and on the way back up, not on every check.
    const led = isDown && !wasDown ? RED : !isDown && wasDown ? GREEN : null;
    if (led === RED && settings.sound) void device.AudioPlay({ application_name: APP, stock_path: "shared/sounds/calendar_event_starts.snd" } as never).catch(report);
    last = now;
    render(led);
    timer = setTimeout(() => void run(), (settings.url === DEMO ? Math.min(interval, DEMO_INTERVAL_S) : interval) * 1000);
  }

  // The listener keeps the app alive; a long Back is handled by the firmware and quits it.
  const unbind = listen("input", (event) => {
    if (stopped || !settings) return;
    if (event.key === "encoder") {
      // The wheel steps through the intervals; the time to the next check starts again.
      let at = INTERVALS.findIndex((seconds) => seconds >= interval);
      if (at < 0) at = INTERVALS.length - 1;
      interval = INTERVALS[Math.min(INTERVALS.length - 1, Math.max(0, at + event.delta))]!;
      note = `EVERY ${every(interval).toUpperCase()}`;
      cancel(noteTimer);
      noteTimer = setTimeout(() => {
        note = null;
        render();
      }, NOTE_MS);
      if (!checking) {
        cancel(timer);
        timer = setTimeout(() => void run(), interval * 1000);
      }
      render();
    } else if ((event.key === "start" || event.key === "ok") && event.action === "short") {
      void run();
    } else if (event.key === "back" && event.action === "short") {
      // Back leaves the app: timers cleared, handler detached; a check on its way ends by itself within 5 s.
      stopped = true;
      cancel(timer);
      cancel(noteTimer);
      // Not detached from inside the handler itself: the unbind would stop the app while this handler still runs.
      setTimeout(unbind, 0);
    }
  });

  void (async () => {
    settings = await loadSettings();
    interval = settings.interval;
    render();
    await run();
  })().catch(report);
}

main();
