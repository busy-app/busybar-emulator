// Runs before every page of every session of the app, in the page's top frame, in a world the page cannot reach
// (security.mjs registers it). It gives the page nothing and has no channel to the shell.
//
// It takes WebRTC's constructor out of the page's own world. A page that creates an RTCPeerConnection makes Chromium
// bind UDP sockets on every network interface (EMU-201 fixes, H1), and on Windows the firewall then asks the person
// about the app; no page of the app needs WebRTC. This is one line of several, not a wall: a frame the page makes
// keeps the constructor in its first, empty document, where no preload runs (checked 11.11 on Electron 45.2.3). What
// keeps WebRTC from reaching anything is the proxy of the session; what keeps it from binding port 5353 is mDNS
// switched off for the whole app (security.mjs, FEATURES_OFF).
const { contextBridge } = require("electron");

contextBridge.executeInMainWorld({
  func: () => {
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) delete globalThis[name];
  },
});
