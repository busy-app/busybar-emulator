// The 3D view of the bar, for the device window: window.emulatorStage3D.
//
//   available()        Promise<boolean>: this computer can draw it (WebGL2) and its files are there
//   mount(container, { view })  puts the view into `container` (it fills the box) and resolves once the bar is
//                      drawn, seen as `view` says (one of VIEWS, the front by default); rejects, leaving nothing
//                      behind, when the view does not come up
//                      `onCamera(view)` in the options hears where the camera is: one of VIEWS once flown there by
//                      a double click on the model's background, null once the person has turned the bar by hand
//   camera(view)       the camera flies to one of VIEWS: "front", "back", "top", "side"
//   inset(sides)       what the page keeps clear over the view's sides, CSS pixels ({ left, right, top, bottom }):
//                      the bar is framed away from it, in the middle across and in what is left clear up and down
//   unmount()          takes the view away
//   mounted            true while the view is in the page
//   reason             why available() said no: a short text for a tooltip, "" otherwise
//
// The view itself is a sandboxed frame (packages/stage/frame, served at /emulator/stage3d/frame/): it has no origin,
// no rights and no way to the server. This file is the frame's only link to the bar: it gives the frame the
// displays' pictures and the controls' state, and does for the frame what the flat view's controls do — the same
// requests, to the same addresses. The messages are written down in packages/stage/README.md.
(() => {
  "use strict";
  const FRAME = "/emulator/stage3d/frame/stage.html";
  const KEYS = ["start", "back", "ok"];
  const POSITIONS = ["busy", "custom", "off", "apps", "settings"];
  const VIEWS = ["front", "back", "top", "side"];
  // How long the scene may take to come up: the player compiles its shaders on the first start.
  const READY_TIMEOUT_MS = 30000;

  let reason = "";
  let checked = null; // whether the frame's files are there, once asked
  let current = null; // the mounted view: { frame, events, ... }

  const post = (url) => fetch(url, { method: "POST" }).catch(() => {});
  const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  function hasWebGL2() {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (!gl) return false;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  // WebGL2 is asked again at every call (a context can be lost, and the window asks at load already); whether the
  // frame's files are there is asked once.
  function available() {
    if (!hasWebGL2()) {
      reason = "3D view needs WebGL2";
      return Promise.resolve(false);
    }
    checked ??= (async () => {
      try {
        const answer = await fetch(FRAME, { method: "HEAD" });
        if (answer.ok) return true;
      } catch {
        // The same as not there.
      }
      return false;
    })();
    return checked.then((there) => {
      reason = there ? "" : "3D view is not in this build";
      return there;
    });
  }

  function mount(container, options = {}) {
    if (!(container instanceof Element)) return Promise.reject(new TypeError("mount(container): a box of the page to draw in"));
    const view = VIEWS.includes(options?.view) ? options.view : "front";
    const onCamera = typeof options?.onCamera === "function" ? options.onCamera : null;
    unmount();
    const frame = document.createElement("iframe");
    // Scripts, and nothing else: no origin, no forms, no windows, no way out of the frame.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("title", "The BUSY Bar in 3D");
    frame.setAttribute("scrolling", "no");
    frame.className = "stage3d";
    // The box decides the size; the frame fills it (position: absolute; inset: 0, as the window's contract says:
    // legacy-window/README.md, window.emulatorStage3D). Set here, not in the page's stylesheet, so that the view
    // needs nothing of the page but a positioned box.
    Object.assign(frame.style, { position: "absolute", inset: "0", display: "block", width: "100%", height: "100%", border: "0", background: "transparent", colorScheme: "dark" });
    const state = { frame, container, view, inset: null, lights: null, events: null, sent: { front: "", back: "" }, last: null, mode: null, ready: false, visible: true, focused: true, watchers: [], problems: [] };
    current = state;
    const tell = (message, transfer) => frame.contentWindow?.postMessage(message, "*", transfer ?? []);

    // What the bar shows and where its controls stand: the same stream the flat view reads.
    function sendFrame(force) {
      if (!state.ready || !state.last) return;
      const message = { type: "frame" };
      const transfer = [];
      for (const name of ["front", "back"]) {
        if (!force && state.last[name] === state.sent[name]) continue;
        state.sent[name] = state.last[name];
        message[name] = decode(state.last[name]).buffer;
        transfer.push(message[name]);
      }
      if (transfer.length) tell(message, transfer);
    }
    function connect() {
      const events = new EventSource("/_emu/events");
      state.events = events;
      events.addEventListener("frame", (e) => {
        state.last = JSON.parse(e.data);
        sendFrame(false);
      });
      events.addEventListener("state", (e) => {
        const { selector, status } = JSON.parse(e.data);
        state.mode = selector;
        if (state.ready) tell({ type: "state", mode: selector, powered: status?.powered !== false });
      });
      // The bar's RGB LEDs, the state the flat view's strips show: each event is a preset started again (a second
      // notification blinks again); the frame gives the scene new values only when they change.
      events.addEventListener("lights", (e) => {
        const { preset, color, brightness } = JSON.parse(e.data);
        state.lights = { type: "lights", preset, color, brightness };
        if (state.ready) tell(state.lights);
      });
      events.addEventListener("key", (e) => {
        const { key, type } = JSON.parse(e.data);
        if (state.ready && (type === "press" || type === "release")) tell({ type: "key", key, action: type });
      });
    }

    // What a person does on the model goes to the bar exactly as from the flat view's controls.
    const held = new Set();
    function fromFrame(m) {
      if (m.type === "key" && KEYS.includes(m.key) && (m.action === "down" || m.action === "up")) {
        if (m.action === "down") held.add(m.key);
        else held.delete(m.key);
        post(`/_emu/key?key=${m.key}&action=${m.action}`);
      } else if (m.type === "wheel" && (m.direction === "up" || m.direction === "down")) post(`/api/input?key=${m.direction}`);
      else if (m.type === "mode" && POSITIONS.includes(m.position)) {
        if (m.position !== state.mode) post(`/api/input?key=${m.position}`);
      } else if (m.type === "keyboard" && (m.event === "keydown" || m.event === "keyup") && typeof m.key === "string") {
        // A key pressed while the frame has the focus: the page gets it as its own.
        document.body.dispatchEvent(new KeyboardEvent(m.event, { key: m.key, code: String(m.code ?? ""), repeat: m.repeat === true, shiftKey: m.shiftKey === true, bubbles: true, cancelable: true }));
      } else if (m.type === "camera" && (m.view === null || VIEWS.includes(m.view))) {
        // The person turned the bar by hand (null), or went back to a quick view.
        state.view = m.view;
        try {
          onCamera?.(m.view);
        } catch {
          // The page's own trouble.
        }
      } else if (m.type === "problem" && typeof m.message === "string") {
        if (state.problems.length < 50) state.problems.push(m.message);
      }
    }
    state.release = () => {
      for (const key of held) post(`/_emu/key?key=${key}&action=up`);
      held.clear();
    };

    // The view rests while nobody can see it, and takes it easy while the window is not the one in front.
    function see() {
      const visible = !document.hidden && state.onScreen !== false;
      const focused = document.hasFocus();
      if (visible === state.visible && focused === state.focused) return;
      const back = visible && !state.visible;
      state.visible = visible;
      state.focused = focused;
      if (state.ready) tell({ type: "view", visible, focused });
      if (back) sendFrame(true);
    }
    const onVisibility = () => see();
    document.addEventListener("visibilitychange", onVisibility);
    state.watchers.push(() => document.removeEventListener("visibilitychange", onVisibility));
    // Focus moves between the page and its frame without the window leaving the front: asked once things settle.
    const onFocus = () => setTimeout(see, 0);
    for (const type of ["focus", "blur"]) {
      addEventListener(type, onFocus);
      state.watchers.push(() => removeEventListener(type, onFocus));
    }
    if (typeof IntersectionObserver === "function") {
      const observer = new IntersectionObserver((entries) => {
        state.onScreen = entries[entries.length - 1].isIntersecting;
        see();
      });
      observer.observe(frame);
      state.watchers.push(() => observer.disconnect());
    }

    return new Promise((resolve, reject) => {
      const fail = (error) => {
        if (current === state) unmount();
        else teardown(state);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("The 3D view did not start in time")), READY_TIMEOUT_MS);
      const onMessage = (e) => {
        if (e.source !== frame.contentWindow || !e.data || typeof e.data !== "object") return;
        const m = e.data;
        if (m.type === "ready") {
          clearTimeout(timer);
          state.ready = true;
          state.build = m.build ?? null;
          state.focused = document.hasFocus();
          tell({ type: "view", visible: state.visible, focused: state.focused });
          if (state.mode) tell({ type: "state", mode: state.mode });
          if (state.inset) tell({ type: "inset", ...state.inset });
          if (state.lights) tell(state.lights);
          sendFrame(true);
          resolve();
        } else if (m.type === "error") {
          clearTimeout(timer);
          fail(new Error(`The 3D view did not start: ${String(m.message).slice(0, 300)}`));
        } else if (m.type === "probe" || m.type === "pick") state.answers?.get(m.id)?.(m);
        else if (state.ready) fromFrame(m);
        else if (m.type === "problem") fromFrame(m);
      };
      addEventListener("message", onMessage);
      state.watchers.push(() => removeEventListener("message", onMessage), () => clearTimeout(timer));
      frame.addEventListener("error", () => fail(new Error("The 3D view did not load")));
      connect();
      // The first view is in the address's fragment, so the bar is drawn seen from there from the first frame on.
      frame.src = `${FRAME}#${view}`;
      container.append(frame);
    });
  }

  function teardown(state) {
    state.release?.();
    state.events?.close();
    for (const stop of state.watchers) stop();
    state.frame.remove();
  }

  function unmount() {
    if (!current) return;
    const state = current;
    current = null;
    teardown(state);
  }

  /** For checks: asks the frame something and waits for its answer ({ type: "probe" } or { type: "pick", x, y }). */
  function ask(message, timeoutMs = 5000) {
    const state = current;
    if (!state?.ready) return Promise.reject(new Error("The 3D view is not mounted"));
    state.answers ??= new Map();
    state.asked = (state.asked ?? 0) + 1;
    const id = state.asked;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.answers.delete(id);
        reject(new Error("The 3D view did not answer"));
      }, timeoutMs);
      state.answers.set(id, (answer) => {
        clearTimeout(timer);
        state.answers.delete(id);
        resolve(answer);
      });
      state.frame.contentWindow?.postMessage({ ...message, id }, "*");
    });
  }

  /** The camera to one of VIEWS; `atOnce` skips the flight. */
  function camera(view, atOnce = false) {
    if (!current || !VIEWS.includes(view)) return;
    current.view = view;
    current.frame.contentWindow?.postMessage({ type: "camera", view, atOnce: atOnce === true }, "*");
  }

  /** What the page keeps clear over the view's sides, CSS pixels. */
  function inset(sides) {
    if (!current) return;
    const px = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const next = { left: px(sides?.left), right: px(sides?.right), top: px(sides?.top), bottom: px(sides?.bottom) };
    if (JSON.stringify(next) === JSON.stringify(current.inset)) return;
    current.inset = next;
    if (current.ready) current.frame.contentWindow?.postMessage({ type: "inset", ...next }, "*");
  }

  window.emulatorStage3D = Object.freeze({
    available,
    mount,
    unmount,
    camera,
    inset,
    views: Object.freeze([...VIEWS]),
    /** The quick view the camera is at or flying to, while mounted; null once the bar is turned by hand. */
    get view() {
      return current?.view ?? null;
    },
    get mounted() {
      return current !== null;
    },
    get reason() {
      return reason;
    },
    /**
     * The view by its angles, radians, at once (screenshots, checks), and its distance as a share of the views' (1
     * when left out); without them, the front view.
     */
    look: (turn, tilt, zoom) => {
      if (!current) return;
      current.view = turn === undefined ? "front" : null;
      current.frame.contentWindow?.postMessage(turn === undefined ? { type: "reset" } : { type: "look", turn, tilt, zoom }, "*");
    },
    ask,
    get problems() {
      return current ? [...current.problems] : [];
    },
  });
})();
