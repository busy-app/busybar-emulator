import { device } from "@shared/device";
import { createScreen, type Element } from "@shared/screen";
import { choice, flag, integer, loadValues } from "@shared/settings";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

/** The counter moves once a second: one or two small text elements, not the whole screen. */
const TICK_MS = 1000;

const WHITE = "#FFFFFFFF";
const AMBER = "#FFB020FF";
const RED = "#FF4030FF";
const GRAY = "#8A8F9CFF";
const DIM = "#5A5E69FF";

/** The part of the budget after which the number turns amber. */
const WARN_AT = 0.75;

const CURRENCIES = ["usd", "eur", "gbp", "jpy", "none"] as const;
type Currency = (typeof CURRENCIES)[number];

type Settings = {
  people: number;
  /** Per person and hour. */
  rate: number;
  currency: Currency;
  /** 0: no budget. */
  budget: number;
  /** The fire flares each time the amount passes a multiple of this; 0: never. */
  flare: number;
  sound: boolean;
  autostart: boolean;
};

async function loadSettings(): Promise<Settings> {
  const values = await loadValues();
  return {
    people: integer(values, "people", 6, 1, 99),
    rate: integer(values, "rate", 75, 1, 100000),
    currency: choice(values, "currency", CURRENCIES, "usd"),
    budget: integer(values, "budget", 500, 0, 10000000),
    flare: Number(choice(values, "flare", ["0", "10", "50", "100", "500", "1000"] as const, "100")),
    sound: flag(values, "sound", false),
    autostart: flag(values, "autostart", false),
  };
}

// ---------------------------------------------------------------------------------------------------- the screen

/**
 * The front display, 72x16: the fire takes the left 16 columns, the amount is right-aligned in the rest. The bar
 * has no call that measures a text, so the widths of the two fonts used are written down here, as measured:
 * bold digits advance 7 px and a comma 3; small digits 4 px, "1" 3, "." 2.
 */
const RIGHT = 71;
const TEXT_LEFT = 18;
const BOLD_DIGIT = 7;
const BOLD_COMMA = 3;
/** The currency signs are pictures: the bar's fonts are ASCII and have no euro, pound or yen. */
const SIGN_WIDTH = 7;

function smallWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch === "1" || ch === "/" ? 3 : ch === "." ? 2 : ch === "M" ? 6 : 4;
  return width - 1;
}

function boldWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += ch === "," || ch === "." ? BOLD_COMMA : BOLD_DIGIT;
  return width - 1;
}

/** 1234567 → "1,234,567". */
function grouped(n: number): string {
  let text = String(Math.floor(n));
  for (let i = text.length - 3; i > 0; i -= 3) text = `${text.slice(0, i)},${text.slice(i)}`;
  return text;
}

/** The amount in two sizes: the big part, and a small tail (the cents, or a unit). */
function amountParts(amount: number): { big: string; tail: string } {
  if (amount >= 1000000) return { big: (amount / 1000000).toFixed(2), tail: "M" };
  if (amount >= 10000) return { big: grouped(amount), tail: "" };
  const cents = Math.floor(amount * 100) % 100;
  return { big: grouped(amount), tail: `.${cents < 10 ? "0" : ""}${cents}` };
}

/** What an hour of the meeting costs, for the screen before it starts. */
function hourParts(perHour: number): { big: string; tail: string } {
  return perHour >= 1000000 ? { big: (perHour / 1000000).toFixed(2), tail: "M/h" } : { big: grouped(perHour), tail: "/h" };
}

/** The sign, the big part and the tail, right-aligned as one. A tail that would push the sign into the fire is left out. */
function amount(big: string, tail: string, currency: Currency, color: string): Element[] {
  const room = RIGHT + 1 - (TEXT_LEFT - 1) - boldWidth(big) - (currency === "none" ? 0 : SIGN_WIDTH + 1);
  if (tail !== "" && smallWidth(tail) + 1 > room) tail = "";
  const tailWidth = tail === "" ? 0 : smallWidth(tail) + 1;
  const bigRight = RIGHT - tailWidth;
  const elements: Element[] = [{ id: "big", type: "text", text: big, font: "bold", color, x: bigRight + 1, y: -1, align: "top_right", z_index: 2 }];
  if (tail !== "") {
    elements.push({ id: "tail", type: "text", text: tail, font: "small", color, x: RIGHT + 1, y: 1, align: "top_right", z_index: 2 });
  }
  if (currency !== "none") {
    const x = Math.max(TEXT_LEFT - 1, bigRight - boldWidth(big) - SIGN_WIDTH - 1);
    elements.push({ id: "sign", type: "image", path: `images/sign_${currency}.png`, x, y: 0, z_index: 2 });
  }
  return elements;
}

function small(id: string, text: string, color: string, x: number, align: "top_left" | "top_right"): Element {
  return { id, type: "text", text, font: "small", color, x, y: 8, align, z_index: 2 };
}

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** "07:29", or "1:02:03" past an hour. */
function duration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}

const CODE: Record<Currency, string> = { usd: "USD", eur: "EUR", gbp: "GBP", jpy: "JPY", none: "" };

/**
 * The back display, 160x80 in gray, faces the person at the desk: what the numbers are made of, and what the
 * controls do. The firmware's status bar takes the right 12 px. It is drawn again only when something here changes.
 */
function back(state: "READY" | "RUNNING" | "PAUSED", people: number, settings: Settings): Element[] {
  const line = (id: string, text: string, font: string, y: number): Element => ({ id, type: "text", text, font, x: 74, y, align: "top_mid", display: "back" });
  const code = CODE[settings.currency];
  return [
    line("b_title", `MEETING COST - ${state}`, "small", 3),
    line("b_sum", `${people} x ${settings.rate} = ${grouped(people * settings.rate)}${code === "" ? "" : ` ${code}`}/h`, "normal", 18),
    line("b_budget", settings.budget > 0 ? `budget ${grouped(settings.budget)}` : "no budget", "small", 34),
    line("b_wheel", "WHEEL  people in the room", "small", 50),
    line("b_start", state === "READY" ? "START  begin" : state === "RUNNING" ? "START  pause" : "START  go on", "small", 59),
    line("b_hold", "HOLD START  new meeting", "small", 68),
  ];
}

// ------------------------------------------------------------------------------------------------------- the app

type Phase = "ready" | "running" | "paused";

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  const screen = createScreen(APP);
  let settings: Settings | null = null;
  let phase: Phase = "ready";
  let people = 1;
  /** What the meeting has cost, and how long it ran, without the pauses. */
  let cost = 0;
  let elapsed = 0;
  /** When the cost was last brought up to date. */
  let last = Date.now();
  let stopped = false;
  /** The fire as the bar was last told to play it; it is told again only when this changes. */
  let fire: Element = fireElement("calm");
  let heat: "calm" | "hot" = "calm";
  let flareStep = 0;
  /** The flare is one request; the request after it queues the steady fire behind it. */
  let flaring = false;
  let overBudget = false;
  let led: string | null = null;

  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  /**
   * The animation is one file with three sections, played by the firmware 25 times a second: `calm` and `hot` loop,
   * `flare` plays once. `after`: wait for the section that is playing to end, so a flare is not cut short.
   */
  function fireElement(section: "calm" | "hot" | "flare", after = false): Element {
    return { id: "fire", type: "animation", path: "animations/fire.anim", section, loop: section !== "flare", await_previous_end: after, opacity: 100, x: 0, y: 0, z_index: 1 };
  }

  function flare(): void {
    fire = fireElement("flare");
    flaring = true;
  }

  /** Brings the cost up to now. People may have come or gone since: what is spent stays spent. */
  function account(): void {
    const now = Date.now();
    if (phase === "running" && settings) {
      const ms = Math.max(0, now - last);
      elapsed += ms;
      cost += (people * settings.rate * ms) / 3600000;
    }
    last = now;
  }

  function elements(s: Settings): Element[] {
    if (phase === "ready") {
      // Before the meeting: the money is whole, and the number is what an hour of these people costs.
      return [
        { id: "money", type: "image", path: "images/money.png", x: 0, y: 0, z_index: 1 },
        ...amount(hourParts(people * s.rate).big, hourParts(people * s.rate).tail, s.currency, WHITE),
        small("people", `${people} ${people === 1 ? "PERSON" : "PEOPLE"}`, GRAY, TEXT_LEFT, "top_left"),
        ...back("READY", people, s),
      ];
    }
    const paused = phase === "paused";
    const part = s.budget > 0 ? cost / s.budget : 0;
    const color = paused ? GRAY : part >= 1 ? RED : part >= WARN_AT ? AMBER : WHITE;
    const { big, tail } = amountParts(cost);
    const out: Element[] = [paused ? { ...fireElement(heat), opacity: 35 } : fire, ...amount(big, tail, s.currency, color)];
    out.push(small("people", paused ? "PAUSED" : `x${people}`, paused ? AMBER : DIM, TEXT_LEFT, "top_left"));
    if (paused) {
      out.push(small("time_still", duration(elapsed), GRAY, RIGHT + 1, "top_right"));
    } else {
      // The firmware counts the meeting's time up by itself: no redraw is needed for it.
      out.push({ id: "time", type: "countdown", timestamp: String(Math.round((Date.now() - elapsed) / 1000)), direction: "time_since", show_hours: "when_non_zero", color: GRAY, x: RIGHT + 1, y: 9, align: "top_right", z_index: 2 });
    }
    out.push(...back(paused ? "PAUSED" : "RUNNING", people, s));
    return out;
  }

  function render(): void {
    if (stopped || !settings) return;
    const light = led;
    led = null;
    void screen.draw(elements(settings), light);
  }

  /** Once a second while the meeting runs. */
  function tick(): void {
    if (!settings || phase !== "running") return;
    account();
    const hot = settings.budget > 0 && cost >= settings.budget;
    if (hot) heat = "hot";
    // A flare is one request, and the request after it queues the steady fire behind it; so the fire flares at most
    // every other second, however fast the round sums pass.
    const flared = flaring;
    if (flaring) {
      fire = fireElement(heat, true);
      flaring = false;
    } else if (fire.section !== heat) {
      fire = fireElement(heat);
    }
    if (settings.flare > 0) {
      const step = Math.floor(cost / settings.flare);
      if (step > flareStep && !flared) flare();
      flareStep = step;
    }
    if (hot && !overBudget) {
      overBudget = true;
      if (!flared) flare();
      led = RED;
      if (settings.sound) void device.AudioPlay({ application_name: APP, stock_path: "shared/sounds/calendar_event_starts.snd" } as never).catch(report);
    }
    render();
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  /** Clearing a timer that was never set makes the firmware log a warning, so only a running one is cleared. */
  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  function begin(): void {
    last = Date.now();
    phase = "running";
    // The fire catches with a flare.
    if (elapsed === 0) flare();
    else fire = fireElement(heat);
    timer = setInterval(tick, TICK_MS);
  }

  function pause(): void {
    account();
    stopTimer();
    phase = "paused";
  }

  function reset(): void {
    stopTimer();
    phase = "ready";
    cost = 0;
    elapsed = 0;
    heat = "calm";
    flareStep = 0;
    flaring = false;
    overBudget = false;
  }

  // The listener keeps the app alive; a long Back is handled by the firmware and quits it.
  const unbind = listen("input", (event) => {
    if (stopped || !settings) return;
    if (event.key === "encoder") {
      // Someone came or left: what is spent so far was spent at the old headcount.
      account();
      people = Math.min(99, Math.max(1, people + event.delta));
    } else if (event.key === "start" || event.key === "ok") {
      if (event.action === "long") reset();
      else if (event.action !== "short") return;
      else if (phase === "running") pause();
      else begin();
    } else if (event.key === "back" && event.action === "short") {
      // Back leaves the app: with the timer cleared and the handler detached, nothing keeps it alive.
      stopped = true;
      stopTimer();
      // Not detached from inside the handler itself: the unbind would stop the app while this handler still runs.
      setTimeout(unbind, 0);
      return;
    } else {
      return;
    }
    render();
  });

  void (async () => {
    settings = await loadSettings();
    people = settings.people;
    if (settings.autostart) begin();
    render();
  })().catch(report);
}

main();
