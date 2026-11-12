// Runs in the windows of the shell's own pages, before the page, in a world the page cannot reach. It gives the page
// the named actions of the bridge and nothing else; whether a call is allowed is decided in the main process
// (bridge.mjs), not here. The device window has none of its own; the one every page of the session gets
// (page-preload.cjs) gives a page nothing.
const { contextBridge, ipcRenderer } = require("electron");

const call = (name) => () => ipcRenderer.invoke("busy-shell", name);

contextBridge.exposeInMainWorld("busyShell", {
  message: call("message.get"),
  retry: call("server.retry"),
  quit: call("app.quit"),
});
