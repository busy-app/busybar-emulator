// Runs in the app's main window when it shows the device window, before the page, in a world the page cannot reach.
// It gives the page one function that asks the shell for a named action of the bridge, and the progress of the jobs
// those actions start; whether a call is allowed is decided in the main process (bridge.mjs), not here. The page
// wraps it as window.emulatorActions (packages/server/legacy-window/actions.js).
const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Set();
const menuListeners = new Set(); // the app menu's items that open something of the page's own (New App…)
ipcRenderer.on("busy-shell-menu", (_event, item) => {
  for (const listener of menuListeners) {
    try {
      listener(item);
    } catch {
      // As below: one listener that throws does not stop the others.
    }
  }
});
ipcRenderer.on("busy-shell-job", (_event, job) => {
  for (const listener of listeners) {
    try {
      listener(job);
    } catch {
      // A listener of the page's that throws does not stop the others.
    }
  }
});

contextBridge.exposeInMainWorld("busyShell", {
  action: (name, arg) => (arg === undefined ? ipcRenderer.invoke("busy-shell", name) : ipcRenderer.invoke("busy-shell", name, arg)),
  onJob: (listener) => {
    if (typeof listener === "function") listeners.add(listener);
  },
  onMenu: (listener) => {
    if (typeof listener === "function") menuListeners.add(listener);
  },
});
