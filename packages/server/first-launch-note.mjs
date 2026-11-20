// The firmware's own line on an app's first launch: js_localstorage.c logs "Failed to open file" for the app's
// localstorage.json, which does not exist until the app saves something. A BUSY Bar logs the same, and it is normal.

/** What the log says beside the line: for a person, who may take it for the app's failure. */
export const FIRST_LAUNCH_NOTE = "no saved data yet: the app's first launch, this is normal";

/**
 * Whether a line of the runtime is that one: only "Failed to open file" for this app's own localstorage.json. Any other
 * JsLocalStorage line (a file that exists and does not open, a failed write) or another path is a real error.
 */
export function isFirstLaunchLine(appId, tag, text) {
  return tag === "JsLocalStorage" && String(text).trim().replace(/\.$/, "") === `Failed to open file: "/ext/apps_data/jsrunner/${appId}.localstorage.json"`;
}
