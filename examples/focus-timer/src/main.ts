import { device } from "@shared/device";
import { createScreen, type Element } from "@shared/screen";
import { choice, color, flag, integer, loadValues } from "@shared/settings";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const WHITE = "#FFFFFFFF";
const GRAY = "#8A8F9CFF";
const AMBER = "#FFB020FF";
const GREEN = "#30E060FF";
const BLUE = "#4FA8FFFF";

/** The tree animation has a section per stage of growth: grow0 … grow11, then bloom; wilt0 … wilt11 for giving up. */
const STAGES = 12;
/** The wheel changes the session's length in steps of this many minutes. */
const STEP_MINUTES = 5;
const MAX_MINUTES = 180;
/** How many small trees of the forest fit beside the growing one. */
const FOREST_ROOM = 5;
const STORAGE_KEY = "forest";

const TREES = ["apple", "sakura", "maple"] as const;
type Tree = (typeof TREES)[number];

/** What the tree bears when the session is done, for the word DONE. */
const BLOOM: Record<Tree, string> = { apple: "#FF6A5AFF", sakura: "#FFA9D0FF", maple: "#FFC04AFF" };

type Settings = {
  minutes: number;
  /** 0: no breaks. */
  breakMinutes: number;
  tree: Tree;
  showTime: boolean;
  timeColor: string;
  sound: boolean;
  keepForest: boolean;
};

async function loadSettings(): Promise<Settings> {
  const values = await loadValues();
  return {
    minutes: integer(values, "minutes", 25, 1, MAX_MINUTES),
    breakMinutes: integer(values, "break_minutes", 5, 0, 60),
    tree: choice(values, "tree", TREES, "apple"),
    showTime: flag(values, "show_time", true),
    timeColor: color(values, "time_color", WHITE),
    sound: flag(values, "sound", true),
    keepForest: flag(values, "keep_forest", false),
  };
}

// ---------------------------------------------------------------------------------------------------- the forest

/** The trees of finished sessions, kept on the bar between runs. Every write goes to flash, so there is one per session. */
type Forest = { day: string; trees: number };

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function loadForest(keep: boolean): Forest {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Forest | null;
    if (saved && typeof saved.trees === "number" && (keep || saved.day === today())) return { day: today(), trees: saved.trees };
  } catch {
    // Nothing kept, or not ours: a new forest.
  }
  return { day: today(), trees: 0 };
}

function saveForest(forest: Forest): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(forest));
  } catch (err) {
    console.error(`${APP}: the forest was not saved: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------------------------------- the screen

type Phase = "ready" | "focus" | "paused" | "done" | "break" | "wilted";

type View = {
  phase: Phase;
  /** 0 … STAGES - 1. */
  stage: number;
  minutes: number;
  /** When the running session or break ends, bar clock, ms. */
  endsAt: number;
  /** What is left of a paused session, ms. */
  left: number;
  trees: number;
};

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** "07:29", or "1:02:03" from an hour up. */
function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const hours = Math.floor(total / 3600);
  const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
  return hours > 0 ? `${hours}:${rest}` : rest;
}

/** The time left, counted down by the firmware itself: the app sends it once and does not redraw it. */
function countdown(id: string, endsAt: number, color: string, extra: Record<string, unknown>): Element {
  return { id, type: "countdown", timestamp: String(Math.round(endsAt / 1000)), direction: "time_left", show_hours: "when_non_zero", color, ...extra };
}

/**
 * The front display, 72x16: the tree grows on the left 24 columns, the time is in the top right corner, and the
 * forest of finished sessions stands under it. The tree is one animation file; the app only names the section to
 * loop, and the firmware plays it (the leaves move in the wind) 25 times a second.
 */
function front(s: Settings, v: View): Element[] {
  const section = v.phase === "wilted" ? `wilt${v.stage}` : v.phase === "done" || v.phase === "break" ? "bloom" : `grow${v.stage}`;
  const elements: Element[] = [
    { id: "ground", type: "rectangle", x: 0, y: 15, width: 72, height: 1, fill: "gradient_h", fill_colors: ["#3F7A22FF", "#12300EFF"], border_width: 0, z_index: 0 },
    { id: "tree", type: "animation", path: `animations/tree_${s.tree}.anim`, section, loop: true, x: 0, y: 0, z_index: 1 },
  ];
  const corner = { x: 72, y: 0, align: "top_right", z_index: 2 };
  const word = (text: string, color: string): Element => ({ id: "word", type: "text", text, font: "small", color, x: 72, y: -1, align: "top_right", z_index: 2 });
  if (v.phase === "ready") {
    elements.push({ id: "minutes", type: "text", text: String(v.minutes), font: "bold", color: WHITE, x: 72 - 17, y: -2, align: "top_right", z_index: 2 });
    elements.push(word("MIN", GRAY));
  } else if (v.phase === "focus") {
    if (s.showTime) elements.push(countdown("time", v.endsAt, s.timeColor, corner));
  } else if (v.phase === "break") {
    elements.push(countdown("time", v.endsAt, BLUE, corner));
  } else if (v.phase === "paused") {
    // A countdown cannot stand still, and an element cannot change its type, so the paused time is a text of its own.
    elements.push(word(clock(v.left), AMBER));
  } else if (v.phase === "done") {
    elements.push(word("DONE", BLOOM[s.tree]));
  } else {
    elements.push(word("GAVE UP", GRAY));
  }
  // The forest, newest tree first from the right. When it outgrows the room, the leftmost place counts the rest.
  const shown = Math.min(v.trees, v.trees > FOREST_ROOM ? FOREST_ROOM - 1 : FOREST_ROOM);
  for (let i = 0; i < shown; i++) {
    elements.push({ id: `forest${i}`, type: "image", path: `images/small_${s.tree}.png`, x: 72 - 8 * (i + 1) + 1, y: 7, z_index: 1 });
  }
  if (v.trees > shown) {
    elements.push({ id: "more", type: "text", text: `+${v.trees - shown}`, font: "small", color: GRAY, x: 72 - 8 * shown - 1, y: 7, align: "top_right", z_index: 2 });
  }
  return elements;
}

const TITLE: Record<Phase, string> = { ready: "READY", focus: "FOCUS", paused: "PAUSED", done: "DONE", break: "BREAK", wilted: "GAVE UP" };

/**
 * The back display, 160x80 in gray, faces the person at the desk: the state, the time, the forest, and what the
 * controls do now. The firmware's status bar takes the right 12 px.
 */
function back(s: Settings, v: View): Element[] {
  const line = (id: string, text: string, font: string, y: number): Element => ({ id, type: "text", text, font, x: 74, y, align: "top_mid", display: "back" });
  const elements = [line("b_title", TITLE[v.phase], "normal", 1)];
  if (v.phase === "focus" || v.phase === "break") {
    elements.push(countdown("b_time", v.endsAt, WHITE, { x: 74, y: 20, align: "top_mid", display: "back" }));
  } else {
    const text = v.phase === "paused" ? clock(v.left) : v.phase === "ready" ? `${v.minutes} min` : v.phase === "done" ? "a tree for the forest" : "the tree wilted";
    elements.push(line("b_text", text, "small", 20));
  }
  elements.push(line("b_forest", v.trees === 1 ? "1 tree in the forest" : `${v.trees} trees in the forest`, "small", 34));
  const start: Record<Phase, string> = {
    ready: "START  begin",
    focus: "START  pause",
    paused: "START  go on",
    done: s.breakMinutes > 0 ? `START  ${s.breakMinutes} min break` : "START  next session",
    break: "START  skip the break",
    wilted: "START  try again",
  };
  elements.push(line("b_start", start[v.phase], "small", 50));
  elements.push(line("b_wheel", v.phase === "ready" ? "WHEEL  minutes" : " ", "small", 59));
  elements.push(line("b_back", v.phase === "focus" || v.phase === "paused" ? "BACK  give up" : "BACK  leave", "small", 68));
  return elements;
}

// ------------------------------------------------------------------------------------------------------- the app

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  const screen = createScreen(APP);
  let settings: Settings | null = null;
  let forest: Forest = { day: "", trees: 0 };
  let phase: Phase = "ready";
  let minutes = 25;
  /** The whole session or break, ms; when it ends; what is left while paused. */
  let total = 0;
  let endsAt = 0;
  let left = 0;
  let stage = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

  /** Clearing a timer that was never set makes the firmware log a warning, so only a pending one is cleared. */
  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function render(led: string | null = null): void {
    if (stopped || !settings) return;
    const view: View = { phase, stage, minutes, endsAt, left, trees: forest.trees };
    void screen.draw([...front(settings, view), ...back(settings, view)], led);
  }

  function sound(path: string): void {
    if (settings?.sound) void device.AudioPlay({ application_name: APP, stock_path: path } as never).catch(report);
  }

  /**
   * The only timer: it fires when the tree reaches its next stage, or when the session or the break ends. Between
   * these moments the app does nothing: the firmware counts the time down and moves the leaves.
   */
  function wake(): void {
    timer = undefined;
    if (stopped || !settings) return;
    const remaining = endsAt - Date.now();
    if (phase === "focus") {
      if (remaining <= 0) {
        phase = "done";
        forest = { day: today(), trees: forest.trees + 1 };
        saveForest(forest);
        sound("shared/sounds/calendar_event_starts.snd");
        render(GREEN);
        return;
      }
      const grown = Math.min(STAGES - 1, Math.floor(((total - remaining) / total) * STAGES));
      if (grown !== stage) {
        stage = grown;
        render();
      }
      const nextStage = total - ((stage + 1) * total) / STAGES;
      timer = setTimeout(wake, Math.max(50, remaining - Math.max(0, nextStage)) + 20);
    } else if (phase === "break") {
      if (remaining <= 0) {
        sound("shared/sounds/calendar_reminder_ends.snd");
        ready();
        render(BLUE);
        return;
      }
      timer = setTimeout(wake, remaining + 20);
    }
  }

  function ready(): void {
    cancel();
    phase = "ready";
    stage = 0;
  }

  function begin(ms: number, next: "focus" | "break"): void {
    cancel();
    phase = next;
    total = ms;
    endsAt = Date.now() + ms;
    if (next === "focus") stage = 0;
    wake();
  }

  // The listener keeps the app alive; a long Back is handled by the firmware and quits it.
  const unbind = listen("input", (event) => {
    if (stopped || !settings) return;
    if (event.key === "encoder") {
      if (phase !== "ready") return;
      // From a length that is not a multiple of five (set in the settings) the wheel goes to the next multiple.
      const stepped = event.delta > 0 ? Math.floor(minutes / STEP_MINUTES) + 1 : Math.ceil(minutes / STEP_MINUTES) - 1;
      minutes = Math.min(MAX_MINUTES, Math.max(STEP_MINUTES, stepped * STEP_MINUTES));
    } else if ((event.key === "start" || event.key === "ok") && event.action === "short") {
      if (phase === "ready") {
        begin(minutes * 60000, "focus");
      } else if (phase === "focus") {
        cancel();
        left = Math.max(0, endsAt - Date.now());
        phase = "paused";
      } else if (phase === "paused") {
        // The session goes on from where it stopped; the tree keeps its size.
        phase = "focus";
        endsAt = Date.now() + left;
        wake();
      } else if (phase === "done" && settings.breakMinutes > 0) {
        begin(settings.breakMinutes * 60000, "break");
      } else {
        ready();
      }
    } else if (event.key === "back" && event.action === "short") {
      // Firmware 1.3.1 clears the app's screen on a short Back, so whatever comes next is drawn from nothing.
      screen.forget();
      if (phase === "focus" || phase === "paused") {
        // Giving up: the tree wilts and does not join the forest.
        cancel();
        phase = "wilted";
      } else {
        // Back leaves the app: with the timer cleared and the handler detached, nothing keeps it alive.
        stopped = true;
        cancel();
        // Not detached from inside the handler itself: the unbind would stop the app while this handler still runs.
        setTimeout(unbind, 0);
        return;
      }
    } else {
      return;
    }
    render();
  });

  void (async () => {
    settings = await loadSettings();
    minutes = settings.minutes;
    forest = loadForest(settings.keepForest);
    render();
  })().catch(report);
}

main();
