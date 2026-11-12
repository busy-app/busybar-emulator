// The person's own doing in a window, for the bridge's actions with consequences (bridge.mjs): building and running a
// project, the clipboard, a folder shown. A page gets such an action only just after a click or a key in its window,
// as it gets an address opened in the browser (external.mjs): script alone, a frame or an injected line starts none.
//
// One click may mean more than one action (Next saves the texts, then reads the repository's files), so a gesture
// allows a short chain: up to CHAIN_MAX actions, each begun within GESTURE_MS of the click or key. What still runs
// does not stretch it: an action that goes on for minutes (a build, a push, a dialog waited for) leaves the page no
// right to start another once the two seconds are over. Work that must follow a long step is done by the shell
// inside the one action the click allowed (Build and package is one `publish.package` with `build`; a new project's
// texts and icons are written by `projects.create`; Delete stops, removes and trashes in `apps.delete`).
import { GESTURE_MS, isGesture } from "./external.mjs";

/** How many actions one click or key may start, all within GESTURE_MS of it. */
export const CHAIN_MAX = 4;

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @returns {{ input: (window: object, type: string) => void, allow: (window: object) => boolean }}
 *   input: an input event arrived in a window (its webContents); allow: that window's page starts an action now, and
 *   is let to (true, and the action counts against the gesture) or not
 */
export function createGestures({ now = Date.now } = {}) {
  // By window, and gone with it: the latest click or key there, and how many actions it has allowed.
  const windows = new WeakMap();
  const isWindow = (window) => (typeof window === "object" && window !== null) || typeof window === "function";
  return {
    input(window, type) {
      if (isWindow(window) && isGesture(type)) windows.set(window, { at: now(), started: 0 });
    },
    allow(window) {
      const gesture = isWindow(window) ? windows.get(window) : null;
      if (!gesture) return false;
      const time = now();
      if (time < gesture.at || time - gesture.at > GESTURE_MS || gesture.started >= CHAIN_MAX) return false;
      gesture.started += 1;
      return true;
    },
  };
}
