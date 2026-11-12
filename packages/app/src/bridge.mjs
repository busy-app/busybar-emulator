// The bridge between a page and the shell: the one list of what a page may ask for.
//
// Every action names the pages that may call it, and the call is checked against the frame it really came from —
// the top frame of a window of the right kind, showing a page of the right origin. What a page says about itself is
// not looked at. Actions with consequences outside the app (choose a folder, build a project: EMU-261; open an
// editor: EMU-215) and the window's right for the server's operations (EMU-031) are added to this list, not beside it.
import { gestureFor, WINDOW_ACTIONS } from "./actions.mjs";
import { originOfHost } from "./app-scheme.mjs";
import { CAPTURE_ACTIONS, CAPTURE_NO_GESTURE } from "./capture-actions.mjs";
import { createRefusalLog } from "./log.mjs";
import { REPORT_ACTIONS, REPORT_NO_GESTURE } from "./report-actions.mjs";

export const BRIDGE_CHANNEL = "busy-shell";

const SHELL_PAGE = Object.freeze({ kind: "message", origin: originOfHost("shell") });
/** The device window's page: the app's main window at the server's own address, which the bridge is told when made. */
export const SERVER_ORIGIN = "the server's";
const DEVICE_PAGE = Object.freeze({ kind: "device", origin: SERVER_ORIGIN });

/**
 * name → { pages: who may call, takes: how many arguments at most (none unless said), run(shell, ...args): what it
 * does }. The shell's own page has three actions without arguments. The device window's page has the actions on app
 * projects (actions.mjs), each with one argument at most, which the action itself checks: a folder it names is only
 * looked up among the emulator's projects. All of them but the ones that only read (the list, the examples) have
 * consequences outside the page and are `gesture` actions (true, or a function of the argument for an action that only
 * reads with some arguments): the page gets one only within two seconds of a click or a key in its window, at most
 * four per click or key (gestures.mjs), so script alone starts none, and an action that runs long opens no other.
 */

/** What the page is told when it asks for a gesture action without the person's click or key just before. */
export const NO_GESTURE = Object.freeze({ ok: false, error: Object.freeze({ code: "no_gesture", message: "The app does this only just after a click or a key in its window.", hint: null }) });

/** The title bar's two: the menu, and an item of it pressed. */
const MENU_ACTIONS = {
  "menu.get": { pages: [DEVICE_PAGE], run: (shell) => shell.titleBar.menu() },
  "menu.run": { pages: [DEVICE_PAGE], takes: 1, gesture: true, run: (shell, id) => shell.titleBar.run(id) },
};
export const MENU_ACTION_NAMES = Object.freeze(Object.keys(MENU_ACTIONS));

export const ACTIONS = Object.freeze({
  "message.get": { pages: [SHELL_PAGE], run: (shell) => shell.currentMessage() },
  "server.retry": { pages: [SHELL_PAGE], run: (shell) => void shell.retry() },
  "app.quit": { pages: [SHELL_PAGE], run: (shell) => void shell.quit() },
  ...Object.fromEntries(WINDOW_ACTIONS.map((name) => [name, { pages: [DEVICE_PAGE], takes: 1, gesture: gestureFor(name), run: (shell, arg) => shell.actions.call(name, arg) }])),
  // The console in the system's terminal (terminal.mjs): whether there is one to open reads only; opening one is the
  // person's doing.
  "terminal.info": { pages: [DEVICE_PAGE], run: (shell) => shell.terminal.info() },
  "terminal.open": { pages: [DEVICE_PAGE], takes: 1, gesture: true, run: (shell, arg) => shell.terminal.open(arg) },
  // The canvas's Screenshot and Record buttons (capture-actions.mjs): the same page, the same rules.
  ...Object.fromEntries(CAPTURE_ACTIONS.map((name) => [name, { pages: [DEVICE_PAGE], takes: 1, gesture: !CAPTURE_NO_GESTURE.includes(name), run: (shell, arg) => shell.capture.call(name, arg) }])),
  // Report a Bug (report-actions.mjs): the preview only reads; the browser, the clipboard and the Save dialog are the
  // person's doing.
  ...Object.fromEntries(REPORT_ACTIONS.map((name) => [name, { pages: [DEVICE_PAGE], takes: 1, gesture: !REPORT_NO_GESTURE.includes(name), run: (shell, arg) => shell.report.call(name, arg) }])),
  // The window's own title bar outside macOS (title-bar.mjs): the app menu as it is now, which reads only; and one of
  // its items pressed, which the person does, as with the system's menu. The page gets no power the menu did not give
  // the person already: the items are the menu's own, run by the menu's own clicks.
  ...MENU_ACTIONS,
  // The built-in update (updater.mjs): where it stands reads only; Update and Restart are the person's clicks, and
  // Restart asks them once more in a dialog of the app's.
  "update.state": { pages: [DEVICE_PAGE], run: (shell) => ({ ok: true, value: shell.updater.state }) },
  "update.download": { pages: [DEVICE_PAGE], gesture: true, run: (shell) => shell.updateFromWindow("update.download") },
  "update.restart": { pages: [DEVICE_PAGE], gesture: true, run: (shell) => shell.updateFromWindow("update.restart") },
  // The update's pop-up (update-popup.mjs): whether the window shows it now. Reads, and notes that it was shown.
  "update.popup": { pages: [DEVICE_PAGE], run: (shell) => ({ ok: true, value: shell.updatePopup.ask() }) },
});

export class BridgeRefusal extends Error {}

/**
 * @param {object} o
 * @param {object} o.shell                                 what the actions act on
 * @param {(webContents: object) => string | null} o.kindOf  the kind of window a page lives in
 * @param {(line: string) => void} o.log
 * @param {string | null} [o.serverOrigin]  the origin of the device window's page; without it no page is that page
 * @param {{ allow: (webContents: object) => boolean }} [o.gestures]  createGestures(); without it no gesture action
 *   is ever allowed
 * @returns {(event: object, name: unknown, ...args: unknown[]) => unknown} the handler for ipcMain.handle
 */
export function createBridge({ shell, kindOf, log, serverOrigin = null, gestures = null }) {
  const originOf = (page) => (page.origin === SERVER_ORIGIN ? serverOrigin : page.origin);
  // A page that asks without end fills no log.
  const noted = createRefusalLog(log);
  return (event, name, ...args) => {
    const action = typeof name === "string" && Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
    const frame = event.senderFrame;
    const from = frame?.origin ?? "(no frame)";
    const refuse = (why) => {
      log(`[shell] bridge: refused ${JSON.stringify(String(name)).slice(0, 80)} from ${from}: ${why}`);
      return new BridgeRefusal("This page may not ask the app for that.");
    };
    if (!action) throw refuse("no such action");
    if (args.length > (action.takes ?? 0)) throw refuse("unexpected arguments");
    // The frame may be gone by now, or be a frame inside the page: neither speaks for the window.
    if (!frame || frame !== event.sender.mainFrame) throw refuse("not the top frame of a window");
    const kind = kindOf(event.sender);
    if (!action.pages.some((page) => page.kind === kind && originOf(page) !== null && originOf(page) === frame.origin)) throw refuse("not a page that may call it");
    const gesture = typeof action.gesture === "function" ? action.gesture(args[0]) : action.gesture === true;
    if (!gesture) return action.run(shell, ...args);
    // The page is the right one; what is missing is the person. It is told so in an answer it can act on.
    if (gestures?.allow(event.sender) !== true) {
      noted("bridge-gesture", `[shell] bridge: ${name} not done, no click or key in the window just before`);
      return NO_GESTURE;
    }
    return Promise.resolve().then(() => action.run(shell, ...args));
  };
}
