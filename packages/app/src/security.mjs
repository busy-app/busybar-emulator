// The security rules of the shell (ADR-0016), applied to every page there is, not window by window: a page the
// shell did not register as one of its windows gets the strictest answer everywhere, and so does a session the shell
// did not name.
import { APP_SCHEME } from "./app-scheme.mjs";
import { createRefusalLog, shortAddress } from "./log.mjs";
import { permissionAllowed } from "./permissions.mjs";

/**
 * How every page runs: in the sandbox, in its own world, without Node, without <webview>. A page shows no system
 * dialog (alert, confirm and prompt answer at once and show nothing: the person would see a window of the app with
 * a foreign page's text in it) and checks no spelling (on Windows Chromium downloads the dictionaries from Google's
 * servers for that, ADR-0014).
 */
export const PAGE_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  navigateOnDragDrop: false,
  disableDialogs: true,
  spellcheck: false,
});

/**
 * WebRTC goes around the page's policy and around the rule on requests (EMU-200, EMU-201 security review S6). This
 * policy closes its direct UDP; its TCP (a TURN server over TCP) is closed by the proxy of the session below, which
 * WebRTC keeps to.
 */
export const WEBRTC_POLICY = "disable_non_proxied_udp";

/**
 * Chromium's features the whole app runs without. WebRtcHideLocalIpsWithMdns binds UDP port 5353 on every network
 * interface as soon as a page creates an RTCPeerConnection (EMU-201 fixes, H1), and on Windows the firewall then asks
 * the person about the app. With the policy above WebRTC has no local addresses to hide.
 */
export const FEATURES_OFF = Object.freeze(["WebRtcHideLocalIpsWithMdns"]);

/** Where the proxy of a closed session sends a request: port 0, on which nothing can listen; connecting fails at once. */
export const NOWHERE = "127.0.0.1:0";

/**
 * The proxy setting of a session whose network is closed but for these addresses ("127.0.0.1:8640"). Every request,
 * WebRTC's and WebTransport's included, that is not for one of them goes to NOWHERE and fails; "<-loopback>" takes away
 * Chromium's own exception for the loopback address, so the other ports of this machine are closed too. The exception
 * names the schemes the server speaks, http: and ws:: one by host and port alone would let every protocol through to
 * that port number, WebTransport's QUIC over UDP among them — to whatever program holds that UDP port (EMU-236
 * security review, M1). For WebTransport and WebRTC this proxy is the only line: the rule on requests does not see them.
 */
export function closedNetwork(addresses) {
  return { mode: "fixed_servers", proxyRules: NOWHERE, proxyBypassRules: ["<-loopback>", ...addresses.flatMap((a) => [`http://${a}`, `ws://${a}`])].join(";") };
}

/**
 * The rule of the app's resolver: no name is looked up, so a page cannot send data out as DNS queries
 * (<link rel=dns-prefetch> asks the system's resolver for any name, under the content policy and the proxy alike:
 * EMU-236 security review, M2). The loopback address is excepted: without that the window does not load.
 */
export const HOST_RESOLVER_RULES = "MAP * ~NOTFOUND, EXCLUDE 127.0.0.1";

/** Schemes that do not leave the app: its own pages, and what a page makes of data it already has. */
export const LOCAL_SCHEMES = Object.freeze([`${APP_SCHEME}:`, "data:", "blob:"]);

const DEFAULT_PORTS = Object.freeze({ "http:": "80", "ws:": "80" });

/**
 * The rule on requests, the second line after the proxy: a request goes out only to one of `addresses` ("host:port",
 * plain HTTP or WebSocket, which is all the server speaks), or stays inside the app (LOCAL_SCHEMES). Anything else —
 * another port, a name for this machine, https:, file: — is refused.
 */
export function requestAllowed(address, addresses) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (LOCAL_SCHEMES.includes(url.protocol)) return true;
  if (!Object.hasOwn(DEFAULT_PORTS, url.protocol)) return false;
  return addresses.includes(`${url.hostname}:${url.port || DEFAULT_PORTS[url.protocol]}`);
}

/**
 * The names of the switches among the command line's arguments, as Chromium reads them: "--name", "--name=value",
 * "-name", and on Windows also "/name" (where Chromium takes names in any case). The release and the test variant
 * remove every one of them (ADR-0016): --disable-web-security, --proxy-server, --host-rules, --js-flags and the
 * remote debugging switches all worked on the shell before (EMU-201 security review, S5).
 */
export function switchNamesIn(args, platform = process.platform) {
  const prefix = platform === "win32" ? /^(?:--|-|\/)([^=]*)/ : /^(?:--|-)([^=]*)/;
  const names = new Set();
  for (const arg of args) {
    const name = prefix.exec(String(arg))?.[1];
    if (!name) continue;
    names.add(name);
    names.add(name.toLowerCase());
  }
  return [...names];
}

/** "scheme://host[:port]" of an address; "" when it has none. URL.origin is "null" for the app's own scheme. */
export function originOf(address) {
  try {
    const url = new URL(address);
    return url.host ? `${url.protocol}//${url.host}` : "";
  } catch {
    return "";
  }
}

/** Which window a page belongs to: its kind, its origin and the addresses it may show. */
export function createWindowRegistry() {
  const rules = new WeakMap();
  return {
    /** @param {{ kind: string, origin: string, allows: (url: URL) => boolean }} rule */
    register: (webContents, rule) => rules.set(webContents, rule),
    kindOf: (webContents) => rules.get(webContents)?.kind ?? null,
    originOf: (webContents) => rules.get(webContents)?.origin ?? null,
    allows(webContents, address) {
      const rule = rules.get(webContents);
      if (!rule) return false;
      try {
        const url = new URL(address);
        return originOf(address) === rule.origin && rule.allows(url);
      } catch {
        return false;
      }
    },
  };
}

/**
 * @param {object} o
 * @param {object} o.app            Electron's app
 * @param {object} o.session        the session the windows use (the default one)
 * @param {object[]} [o.sessions]   the other sessions the shell's windows use (the local web's): closed before any
 *                                  window is made, like the first
 * @param {object} o.registry       createWindowRegistry()
 * @param {(line: string) => void} o.log
 * @param {(session: object) => string[]} o.addressesOf  where a session's pages may send requests ("127.0.0.1:8640");
 *                                  a session it names nothing for is closed entirely
 * @param {string} o.pagePreload    page-preload.cjs: runs before every page of every session
 * @param {(session: object) => ((address: string) => boolean) | null} [o.answeredInside]  the addresses a session's
 *                                  own handler answers inside the app (the local web's icons, icons.mjs): the rule on
 *                                  requests lets them through to that handler; the proxy still sends them nowhere
 * @param {(contents: object, address: string) => boolean} [o.onWindowAsked]  a page asked for a new window: true when
 *                                  the shell showed a window of its own for the address (the bar's local web)
 * @param {(contents: object, address: string) => void} [o.onExternal]  an address a page tried to leave for: the
 *                                  shell gives it to the user's browser by its own rule (external.mjs) until the
 *                                  server's opener exists (EMU-010)
 * @param {(contents: object, type: string) => void} [o.onInput]  an input event (a click, a key, ...) reached a page:
 *                                  that rule opens an address only just after one, in the same window
 * @returns {Promise<void>} resolved once the given session's network is closed (windows are made after that), rejected
 *                                  when it cannot be
 */
export function installSecurity({ app, session, sessions = [], registry, log, addressesOf, pagePreload, answeredInside = () => null, onWindowAsked = () => false, onExternal = () => {}, onInput = () => {} }) {
  const refused = createRefusalLog(log);

  app.on("web-contents-created", (_event, contents) => {
    // No new windows, from any page. What a page asks a new window for is either a window the shell shows itself (the
    // bar's local web), or an address for the user's browser, or nothing.
    contents.setWindowOpenHandler(({ url }) => {
      if (onWindowAsked(contents, url)) return { action: "deny" };
      refused("window", `[shell] refused a new window: ${shortAddress(url)}`);
      onExternal(contents, url);
      return { action: "deny" };
    });

    // What the person does in the window, as Chromium gets it from the system (a page's script cannot make one).
    contents.on("input-event", (_event, input) => onInput(contents, input?.type));

    // A page stays on the addresses of its window; this covers the top frame and every frame in it.
    const stay = (event) => {
      if (registry.allows(contents, event.url)) return;
      event.preventDefault();
      refused("navigation", `[shell] refused a navigation: ${shortAddress(event.url)}`);
      if (event.isMainFrame) onExternal(contents, event.url);
    };
    contents.on("will-frame-navigate", stay);
    contents.on("will-redirect", stay);

    // <webview> is off in the preferences; this is the second lock.
    contents.on("will-attach-webview", (event) => event.preventDefault());

    // A page cannot keep its window open ("beforeunload"): otherwise Quit stops the server and then the window
    // refuses to close, and the app is left running without it.
    contents.on("will-prevent-unload", (event) => event.preventDefault());

    contents.setWebRTCIPHandlingPolicy(WEBRTC_POLICY);
  });

  // Permissions by the window's list, and only for the window's own origin: a frame from elsewhere inherits nothing.
  const decide = (contents, permission, requester) => {
    const allowed =
      Boolean(contents) && originOf(requester ?? "") === registry.originOf(contents) && permissionAllowed(registry.kindOf(contents), permission);
    if (!allowed) refused("permission", `[shell] refused permission ${permission} for ${originOf(requester ?? "") || "(unknown page)"}`);
    return allowed;
  };

  // Without these Electron allows almost everything, so every session gets them as it is made, not only the one the
  // windows use today (ADR-0016).
  const secured = new WeakMap();
  function secure(ses) {
    if (secured.has(ses)) return secured.get(ses);
    const addresses = addressesOf(ses);
    const inside = answeredInside(ses);
    ses.setPermissionRequestHandler((contents, permission, answer, details) => answer(decide(contents, permission, details?.requestingUrl)));
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => decide(contents, permission, requestingOrigin));
    // No device is ever chosen for a page (there is no handler for select-hid-device and the like), so none may be used.
    ses.setDevicePermissionHandler(() => false);
    // Nothing is saved to disk from a page.
    ses.on("will-download", (event) => event.preventDefault());
    ses.setSpellCheckerEnabled(false);
    // The network: the rule on requests here, at once; the proxy below, which WebRTC keeps to as well.
    ses.webRequest.onBeforeRequest((details, answer) => {
      const allowed = requestAllowed(details.url, addresses) || Boolean(inside?.(details.url));
      if (!allowed) refused("request", `[shell] refused a request: ${shortAddress(details.url)}`);
      answer({ cancel: !allowed });
    });
    // No service worker: one registered on the server's origin would answer for the server from then on, across
    // restarts of the app (EMU-201 security review, S15). Its script is asked for with this header.
    ses.webRequest.onBeforeSendHeaders((details, answer) => {
      const worker = Object.entries(details.requestHeaders ?? {}).some(([name, value]) => name.toLowerCase() === "service-worker" && value === "script");
      if (worker) refused("service worker", `[shell] refused a service worker: ${shortAddress(details.url)}`);
      answer({ cancel: worker });
    });
    ses.registerPreloadScript({ type: "frame", id: "busy-emulator-page", filePath: pagePreload });
    const closed = ses.setProxy(closedNetwork(addresses));
    secured.set(ses, closed);
    return closed;
  }
  app.on("session-created", (ses) => {
    const later = () => secure(ses).catch((e) => log(`[shell] could not close the network of a session: ${e?.message ?? e}`));
    if (app.isReady()) later();
    else app.whenReady().then(later);
  });
  // The windows' own sessions: if the network of one cannot be closed, the app does not start.
  return Promise.all([session, ...sessions].map(secure)).then(() => {});
}
