// Runs in the hidden page that encodes a clip (capture-window.mjs), before the page, in a world it cannot reach. It
// gives the page the calls of one channel: the job (the take and the clip's size), the finished samples, a failure,
// and for a recording of the main window the frames that come (onFrame) and the word that one was taken in (ack).
// Whether a call is the encoding page's is decided in the main process, by the page that sends it.
const { contextBridge, ipcRenderer } = require("electron");

const call = (what) => (payload) => ipcRenderer.invoke("busy-capture", what, payload);

contextBridge.exposeInMainWorld("busyCapture", {
  job: call("job"),
  finish: call("finish"),
  fail: call("fail"),
  ack: call("ack"),
  onFrame: (listener) => void ipcRenderer.on("busy-capture-frame", (_event, message) => listener(message)),
});
