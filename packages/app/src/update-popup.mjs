// The update's pop-up: when the emulator opens, or later finds, a newer version, the window asks once whether to
// update now (packages/server/legacy-window/update-popup.js). The top bar's notice stays either way; the pop-up only
// makes it hard to miss, so that a hackathon's hotfix reaches the people who build on the emulator.
//
// The window asks (update.popup) while the updater offers a version and nothing of its own covers the window (the
// first run's greeting, another dialog). The answer here is yes at most once per version in a run, and again a day
// later if the person said Later and the app is still open. Not while the app does something a restart would break
// (a build, a development loop, publishing, a recording, a program waiting on it: the updater's `busy`): the window
// asks again a little later. Never in a hidden run or under a test, unless the test asks (config.updatePopup).
import { releasePage } from "./update-check.mjs";

/** After Later, the same version is offered again this long after, if the app is still open. */
export const ASK_AGAIN_MS = 24 * 60 * 60 * 1000;
/** While the app is busy, the window asks again this soon. */
export const BUSY_RETRY_MS = 3000;

/**
 * @param {object} o
 * @param {boolean} o.enabled                  config.updatePopup
 * @param {() => object} o.state               the updater's state (updater.state)
 * @param {() => object | null} o.notice       the update check's notice ({ version, page, summary? }), for the summary
 * @param {() => string | null} o.busy         what the app does that a restart would break, or null
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.now]
 */
export function createUpdatePopup({ enabled, state, notice, busy, log = () => {}, now = Date.now }) {
  const shown = new Map(); // version → when the window showed it in this run

  /**
   * Whether the window shows the pop-up now: { show: true, version, current, canInstall, why?, page, summary? }, or
   * { show: false, retryMs }: ask again in that many milliseconds (null: only when the update's state changes).
   */
  function ask() {
    if (!enabled) return { show: false, retryMs: null };
    const s = state();
    if (s?.state !== "available" || !s.version) return { show: false, retryMs: null };
    const at = shown.get(s.version);
    if (at !== undefined && now() - at < ASK_AGAIN_MS) return { show: false, retryMs: Math.max(1000, ASK_AGAIN_MS - (now() - at)) };
    const doing = busy();
    if (doing) return { show: false, retryMs: BUSY_RETRY_MS };
    shown.set(s.version, now());
    log(`[shell] update: the pop-up offers ${s.version}${s.canInstall ? "" : " to download"}`);
    const n = notice();
    const summary = n?.version === s.version && n.summary ? n.summary : null;
    return {
      show: true,
      version: s.version,
      current: s.current,
      canInstall: Boolean(s.canInstall),
      ...(s.canInstall ? {} : { why: s.why ?? null }),
      page: releasePage(s.version),
      ...(summary ? { summary } : {}),
    };
  }

  return {
    ask,
    get enabled() {
      return enabled;
    },
    /** The versions shown in this run, with when. */
    get shown() {
      return Object.fromEntries(shown);
    },
  };
}
