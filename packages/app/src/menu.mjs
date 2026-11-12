// The app's menu, as a template for Electron's Menu.buildFromTemplate. The menu proper is EMU-213; this is what the
// first cut needs: on macOS the app's own menu with Quit, copy and paste and the window list; on both systems the
// bar's local web ("App Settings", EMU-209), the switch of the update check (EMU-205), and File with "New App…" and
// "Open App Folder…" (EMU-261: the same actions the window's buttons call), and Help with "Report a Bug…" (EMU-277:
// the window's dialog, which shows the report's text before anything leaves). The default menu is not used: its Help
// items open addresses in the browser.
import { EMULATOR_DOCS_URL, JS_APPS_DOCS_URL } from "./external.mjs";

/**
 * @param {object} o
 * @param {string} o.platform
 * @param {string} o.appName
 * @param {{ allowed: boolean, enabled: boolean }} o.updateCheck  allowed: this build checks at all
 * @param {() => void} o.onAppSettings
 * @param {(on: boolean) => void} o.onUpdateCheck
 * @param {() => void} [o.onNewApp]
 * @param {() => void} [o.onOpenApp]
 * @param {() => void} [o.onReportBug]
 * @param {(url: string) => void} [o.onOpenDocs]  Help, Emulator Docs and JS Apps Docs: the address to open
 */
export function menuTemplate({ platform, appName, updateCheck, onAppSettings, onUpdateCheck, onNewApp = () => {}, onOpenApp = () => {}, onReportBug = () => {}, onOpenDocs = () => {} }) {
  const file = {
    label: "File",
    submenu: [
      { id: "new-app", label: "New App…", accelerator: "CmdOrCtrl+N", click: () => onNewApp() },
      { id: "open-app", label: "Open App Folder…", accelerator: "CmdOrCtrl+O", click: () => onOpenApp() },
    ],
  };
  const help = {
    label: "Help",
    submenu: [
      { id: "report-bug", label: "Report a Bug…", click: () => onReportBug() },
      { id: "emulator-docs", label: "Emulator Docs", click: () => onOpenDocs(EMULATOR_DOCS_URL) },
      { id: "js-apps-docs", label: "JS Apps Docs", click: () => onOpenDocs(JS_APPS_DOCS_URL) },
    ],
  };
  const appSettings = { id: "app-settings", label: "App Settings", accelerator: "CmdOrCtrl+,", click: () => onAppSettings() };
  const updates = {
    id: "update-check",
    label: "Check for New Versions at Start",
    type: "checkbox",
    checked: updateCheck.allowed && updateCheck.enabled,
    enabled: updateCheck.allowed,
    click: (item) => onUpdateCheck(Boolean(item.checked)),
  };
  if (platform === "darwin") {
    return [
      {
        label: appName,
        submenu: [{ role: "about" }, { type: "separator" }, updates, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
      },
      file,
      { role: "editMenu" },
      { label: "BUSY Bar", submenu: [appSettings] },
      { role: "windowMenu" },
      help,
    ];
  }
  return [
    file,
    { label: "BUSY Bar", submenu: [appSettings, { type: "separator" }, { role: "quit" }] },
    { label: "Options", submenu: [updates] },
    help,
  ];
}
