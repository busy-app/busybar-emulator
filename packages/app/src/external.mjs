// Addresses that leave the app for the user's browser (ADR-0016): a link in a window that points outside, and the
// release page of a new version. The opener of the server (EMU-010) takes this over when it exists; until then the
// shell opens them itself, by these rules: an https: address, without a user name or password in it; only when the
// person has just clicked or pressed a key in the window that asks (a page cannot open the browser by itself, and one
// click or key opens one address); and not many in a row from one window — a page cannot fill the browser with tabs,
// and what one window asks for takes nothing from another: the person's own click on a link there still opens it.
import { createRefusalLog } from "./log.mjs";

export const MAX_OPENS = 3;
export const OPENS_WINDOW_MS = 10_000;
/** How long after a click or a key in a window an address that window leaves for is still the person's doing. */
export const GESTURE_MS = 2000;

/**
 * The input events (Electron's InputEvent.type) that are the person doing something: a button or a key going down or
 * up, a tap. Moving the pointer, the wheel and scrolling are not.
 */
const GESTURES = new Set(["mouseDown", "mouseUp", "rawKeyDown", "keyDown", "char", "touchStart", "touchEnd", "gestureTap", "pointerDown", "pointerUp"]);
export const isGesture = (type) => GESTURES.has(type);

/** The documentation the window and the menu's Help link to; the menu opens these two addresses and no others. */
export const EMULATOR_DOCS_URL = "https://go.busy.app/busy-emulator-docs";
export const JS_APPS_DOCS_URL = "https://go.busy.app/js-apps";
export const DOCS_URLS = Object.freeze([EMULATOR_DOCS_URL, JS_APPS_DOCS_URL]);

/** The address as the browser gets it, or null when it is not one the shell opens. */
export function externalAddress(address) {
  let url;
  try {
    url = new URL(String(address));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  return url.href;
}

/**
 * @param {object} o
 * @param {(address: string) => unknown} o.open   gives the address to the system (Electron's shell.openExternal)
 * @param {(line: string) => void} o.log
 * @param {() => number} [o.now]
 * @returns {{ input: (window: object, type: string) => void, open: (address: string, window: object) => boolean, opened: string[] }}
 *   input: an input event arrived in a window (its webContents); open: that window asks for an address, true when
 *   the system got it; opened: the last addresses given to the system
 */
export function createOpener({ open, log, now = Date.now }) {
  // What is not opened is written down as the other refusals are: so many lines a minute, however often a page asks.
  const refused = createRefusalLog(log, { now });
  // By window, and gone with it: when the person last did something there, and when it last got addresses opened.
  const windows = new WeakMap();
  const opened = [];
  const stateOf = (window) => {
    if (!windows.has(window)) windows.set(window, { gesture: null, times: [] });
    return windows.get(window);
  };
  const isWindow = (window) => (typeof window === "object" && window !== null) || typeof window === "function";
  return {
    opened,
    input(window, type) {
      if (isWindow(window) && isGesture(type)) stateOf(window).gesture = now();
    },
    open(address, window) {
      const href = externalAddress(address);
      if (!href) return false;
      const at = now();
      const state = isWindow(window) ? stateOf(window) : null;
      // No click or key in that window just now: the page asks by itself. This is not counted against the window, so
      // a page that asks without end leaves the person's next click its turn.
      if (!state || state.gesture === null || at < state.gesture || at - state.gesture > GESTURE_MS) {
        refused("browser-gesture", `[shell] not opened in the browser, no click or key in the window just before: ${new URL(href).origin}`);
        return false;
      }
      const { times } = state;
      while (times.length && at - times[0] > OPENS_WINDOW_MS) times.shift();
      if (times.length >= MAX_OPENS) {
        refused("browser", `[shell] not opened in the browser, too many in a row: ${new URL(href).origin}`);
        return false;
      }
      // One click or key opens one address.
      state.gesture = null;
      times.push(at);
      opened.push(href);
      if (opened.length > 20) opened.shift();
      log(`[shell] opened in the browser: ${new URL(href).origin}`);
      try {
        Promise.resolve(open(href)).catch((e) => log(`[shell] the browser did not open: ${e?.message ?? e}`));
      } catch (e) {
        log(`[shell] the browser did not open: ${e?.message ?? e}`);
      }
      return true;
    },
  };
}
