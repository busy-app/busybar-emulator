// The shell's windows. The main one is the device window (the server's page, with the bridge's actions on app
// projects: window-preload.cjs) or the shell's own message page (app://shell, with the bridge's three of its own) —
// never both: showing one closes the other. Beside it there may be one
// window with the bar's local web (EMU-209): the firmware's own page from the server's address, with a storage of its
// own and no bridge, asked for from the menu or by the device window's "App settings".
import { originOfHost } from "./app-scheme.mjs";
import { APP_NAME, LOCAL_WEB_PARTITION } from "./config.mjs";
import { originOf, PAGE_PREFERENCES } from "./security.mjs";
import { OVERLAY_COLORS, titleBarOptions, usesTitleBar } from "./title-bar.mjs";

export const MESSAGE_PAGE = `${originOfHost("shell")}/message.html`;
/**
 * The device window's smallest size, the whole window's (on macOS its title bar takes 28 of the height, on Windows the
 * window's own bar 36). Below it the window would scroll sideways; the participants' smallest laptops (1366×768,
 * a taskbar) still have room for it.
 */
export const DEVICE_MIN_SIZE = Object.freeze({ minWidth: 880, minHeight: 600 });

/**
 * A window's size no larger than the screen it opens on (the work area: without the taskbar and the Dock). Electron
 * does not shrink a window that is asked for more than the screen has: on a 1366×768 laptop, or a full-HD one at 150 %
 * (1280×720 in the units windows are sized in), the 760 high device window would hang below the taskbar with its
 * bottom out of reach. The smallest size gives way too, and a window that was cut is opened in the middle of the work
 * area. Without the work area's size (tests) the size is as asked.
 * @param {{ width: number, height: number, minWidth?: number, minHeight?: number }} want
 * @param {{ width: number, height: number } | null} workArea
 */
export function fitToScreen(want, workArea) {
  if (!workArea || !(workArea.width > 0) || !(workArea.height > 0)) return want;
  const width = Math.min(want.width, workArea.width);
  const height = Math.min(want.height, workArea.height);
  const out = { ...want, width, height };
  if (want.minWidth !== undefined) out.minWidth = Math.min(want.minWidth, width);
  if (want.minHeight !== undefined) out.minHeight = Math.min(want.minHeight, height);
  if (width < want.width || height < want.height) out.center = true;
  return out;
}

/** The paths of the server's address that are not the bar's local web: the device window and its old paths. */
const notLocalWeb = (pathname) => pathname === "/emulator" || pathname.startsWith("/emulator/") || pathname.startsWith("/_emu/");

/** The device window's address with the notice of a new version in its fragment, which the page shows as one line. */
export function deviceAddress(windowUrl, notice) {
  return notice ? `${windowUrl}#update=${encodeURIComponent(notice.version)}&page=${encodeURIComponent(notice.page)}` : windowUrl;
}

/**
 * @param {object} o
 * @param {Function} o.BrowserWindow
 * @param {object} o.registry     createWindowRegistry()
 * @param {object} o.config
 * @param {string} o.preloadPath  preload.cjs
 * @param {string} [o.devicePreloadPath]  window-preload.cjs: what the device window's page gets of the bridge
 * @param {() => void} [o.onDeviceClosed]  the device window is gone: closed by the person, or replaced
 * @param {string} [o.icon]       the windows' icon, a picture's path: Windows shows it in the title bar and on the
 *                                taskbar. Not given on macOS, where a window has the app's icon from its bundle.
 * @param {string} [o.platform]   the system: outside macOS the device window and the message page have the shell's
 *                                own title bar (title-bar.mjs), the local web the system's without the menu's strip
 * @param {() => boolean} [o.systemDark]  the system is in its dark mode: the message page's bar follows it
 * @param {() => ({ width: number, height: number } | null)} [o.workArea]  the size of the screen's work area the
 *                                window opens on (fitToScreen); without it the windows are the size asked for
 * @param {(line: string) => void} o.log
 */
export function createWindows({ BrowserWindow, registry, config, preloadPath, devicePreloadPath = null, onDeviceClosed = () => {}, icon, platform = process.platform, systemDark = () => false, workArea = () => null, log }) {
  const fit = (want) => {
    try {
      return fitToScreen(want, workArea());
    } catch {
      return want;
    }
  };
  const withIcon = icon ? { icon } : {};
  // ---- the title bar (title-bar.mjs): the device window is dark, the message page as the system is
  const messageColors = () => (systemDark() ? "system-dark" : "system-light");
  const frameOf = (kind) => titleBarOptions(platform, kind === "message" ? messageColors() : "dark");
  let current = null; // { kind, win, presented }
  let dismissed = false; // the human closed the window; it comes back when they ask for it
  let raised = 0; // how many times the window was asked to the front
  // A hidden run (config.hidden) does everything but put the window on the screen.
  const onScreen = !config.hidden;

  const rules = {
    // Temporary exception of the first cut (ADR-0016): the present device window comes from the server's own
    // address. It stays on /emulator; the bar's local web gets its own window (EMU-209).
    device: {
      kind: "device",
      origin: originOf(config.windowUrl),
      allows: (url) => url.pathname === "/emulator" || url.pathname.startsWith("/emulator/"),
    },
    message: { kind: "message", origin: originOfHost("shell"), allows: () => true },
    // The bar's local web: everything of the server's address but the device window, and the one page of the server
    // that opens the local web on a tab (it sets the tab in the page's storage and goes on to "/").
    "local-web": {
      kind: "local-web",
      origin: originOf(config.localWebUrl),
      allows: (url) => !notLocalWeb(url.pathname) || url.pathname === appSettingsPath,
    },
  };
  const appSettingsPath = new URL(config.appSettingsUrl).pathname;
  let notice = null; // { version, page }: a newer version there is, shown by the device window
  let hadNotice = false;
  const addresses = {
    // Once a notice was shown, taking it away keeps a fragment: an address without one would load the page anew.
    get device() {
      return notice ? deviceAddress(config.windowUrl, notice) : hadNotice ? `${config.windowUrl}#` : config.windowUrl;
    },
    message: MESSAGE_PAGE,
  };

  function load(win, kind) {
    win.loadURL(addresses[kind]).catch((e) => log(`[shell] the ${kind} window did not load: ${e.message}`));
  }

  let localWeb = null; // { win, presented }

  /** True for an address a page may ask the local web's window for: the local web itself, or its page for a tab. */
  function isLocalWebAddress(address) {
    try {
      return originOf(address) === rules["local-web"].origin && rules["local-web"].allows(new URL(address));
    } catch {
      return false;
    }
  }

  function raise(entry) {
    raised += 1;
    if (!onScreen) return;
    if (entry.win.isMinimized()) entry.win.restore();
    entry.win.show();
    entry.win.focus();
  }

  /** Shows the local web's window at `address` (the local web itself by default); one that is open comes to the front. */
  function showLocalWeb(address = config.localWebUrl) {
    if (localWeb) return void raise(localWeb);
    const win = new BrowserWindow({
      ...fit({ width: 1100, height: 800, minWidth: 480, minHeight: 320 }),
      show: false,
      skipTaskbar: !onScreen,
      title: `${APP_NAME}: local web`,
      ...withIcon,
      // The firmware's own page, which is not ours to draw a bar in: the system's title bar, and the menu's strip only
      // while Alt is held (the menu's accelerators work there as in the other windows).
      ...(usesTitleBar(platform) ? { autoHideMenuBar: true } : {}),
      // No preload: the page gets nothing of the shell. Its storage is its own, not the device window's.
      webPreferences: { ...PAGE_PREFERENCES, devTools: config.development, partition: LOCAL_WEB_PARTITION },
    });
    registry.register(win.webContents, rules["local-web"]);
    const entry = { win, presented: false };
    win.once("ready-to-show", () => {
      entry.presented = true;
      if (onScreen) win.show();
    });
    win.on("closed", () => {
      if (localWeb === entry) localWeb = null;
    });
    localWeb = entry;
    win.loadURL(isLocalWebAddress(address) ? address : config.localWebUrl).catch((e) => log(`[shell] the local web window did not load: ${e.message}`));
  }

  function show(kind) {
    dismissed = false;
    if (current?.kind === kind) return load(current.win, kind);
    const win = new BrowserWindow({
      // The device window no smaller than the bar, its controls, the app and the console all fit side by side (the
      // layout of window.css holds from here up, without a horizontal scroll); the shell's message page is a page.
      ...fit({ width: 1180, height: 760, ...(kind === "device" ? DEVICE_MIN_SIZE : { minWidth: 480, minHeight: 320 }) }),
      show: false,
      skipTaskbar: !onScreen,
      title: APP_NAME,
      ...withIcon,
      ...frameOf(kind),
      webPreferences: {
        ...PAGE_PREFERENCES,
        devTools: config.development,
        // The shell's own page gets its three actions; the device window's page the actions on app projects. Which
        // page may call what is decided in the main process (bridge.mjs).
        ...(kind === "message" ? { preload: preloadPath } : devicePreloadPath ? { preload: devicePreloadPath } : {}),
      },
    });
    registry.register(win.webContents, rules[kind]);
    const entry = { kind, win, presented: false };
    // The window appears once its page has something to show.
    win.once("ready-to-show", () => {
      entry.presented = true;
      if (onScreen) win.show();
    });
    const previous = current;
    current = entry;
    win.on("closed", () => {
      if (kind === "device") onDeviceClosed();
      if (current?.win !== win) return;
      current = null;
      dismissed = true;
    });
    load(win, kind);
    // The new window exists before the old one goes, so the app never passes through "no windows".
    previous?.win.destroy();
  }

  return {
    get current() {
      return current;
    },
    /** True when the human closed the window and has not asked for it back. */
    get dismissed() {
      return dismissed;
    },
    showDevice: () => show("device"),
    showMessage: () => show("message"),
    /** How many times the window was brought to the front. */
    get raised() {
      return raised;
    },
    /** Brings the window to the front; false when there is none. */
    focus() {
      if (!current) return false;
      raise(current);
      return true;
    },
    /** The local web's window, { win, presented }, or null. */
    get localWeb() {
      return localWeb;
    },
    showLocalWeb,
    isLocalWebAddress,
    closeLocalWeb: () => localWeb?.win.destroy(),
    /** The notice of a new version ({ version, page }, or null to take it away): the device window shows it. */
    setNotice(next) {
      const before = addresses.device;
      notice = next;
      hadNotice ||= Boolean(next);
      // Only the fragment changes: the page stays as it is and reads the notice from its address.
      if (current?.kind === "device" && addresses.device !== before) load(current.win, "device");
    },
    get notice() {
      return notice;
    },
    /** The system went light or dark: the message page's three buttons follow, as its page does. */
    retheme() {
      if (current?.kind !== "message" || !usesTitleBar(platform) || current.win.isDestroyed?.()) return;
      current.win.setTitleBarOverlay?.({ ...OVERLAY_COLORS[messageColors()] });
    },
  };
}
