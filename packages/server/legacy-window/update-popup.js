// The update's pop-up (packages/app/src/update-popup.mjs): when the emulator opens, or finds later while it is open,
// a newer version, a dialog over the window offers it, so that a hotfix is not missed in the top bar's small notice.
//
//   BUSY Bar Emulator <version> is available       You have <current>. Two or three lines of the release's notes.
//   Update now   Later                             Update now is the top bar's Update to <version>: the download's
//                                                  progress shows here and there, then Restart to update, which the
//                                                  app confirms in its own dialog. Later (or Esc) closes it; the
//                                                  notice stays, and the app offers it again at the next start, or a
//                                                  day later if it stays open.
//   Download     Later                             Where this copy cannot replace itself (the disk image, Downloads,
//                                                  a folder it may not write to): why, and the release page instead.
//
// It waits for the first run's greeting and for any other dialog of the window to close, and the app says no while it
// builds, runs a development loop, publishes, records or a program waits on it (update.popup); the pop-up asks again
// then. The app shows it once per version in a run. Only in the desktop app: a browser has no update. Everything from
// the release is put on the page as text.
(() => {
  const actions = () => window.emulatorActions;
  if (!actions()?.available?.().shell || !actions().update?.popup) return;

  const SPRITE = "/emulator/icons/busy-sprite.svg";
  const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?$/;
  const RELEASES = "https://github.com/busy-app/busybar-emulator/releases/tag/";
  /** While something covers the window, the pop-up looks again this soon. */
  const COVERED_RETRY_MS = 1500;

  let state = null; // the update's state, as update.state() gives it
  let offer = null; // what the open pop-up shows (update.popup's answer); null while it is closed
  let el = null; // the scrim, while it is open
  let timer = null;
  let asking = false;
  let before = null; // the element that had the focus before it opened
  let drawn = null; // what the pop-up's parts were drawn for: they are drawn again only when that changes

  function make(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "bi");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `${SPRITE}#bi-${name}`);
    svg.append(use);
    return svg;
  }
  function button(cls, text, iconName, onClick) {
    const b = make("button", cls);
    b.type = "button";
    if (iconName) b.append(icon(iconName));
    b.append(make("span", "", text));
    b.addEventListener("click", onClick);
    return b;
  }
  /** Download: the release page, built here from the version alone; the app opens it in the browser. */
  function downloadLink(version, cls = "btn solid") {
    const a = make("a", cls);
    a.href = `${RELEASES}v${version}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.id = "update-popup-download";
    a.append(icon("download"), make("span", "", "Download"));
    a.addEventListener("click", () => setTimeout(close, 0));
    return a;
  }

  /** What covers the window now: another dialog (the greeting, Create app, Publish, Report a Bug, Delete), or null. */
  function covered() {
    for (const dialog of document.querySelectorAll('[aria-modal="true"]')) {
      if (el && el.contains(dialog)) continue;
      if (dialog.closest("[hidden]") || !dialog.getClientRects().length) continue;
      return dialog;
    }
    return null;
  }

  function later(ms) {
    clearTimeout(timer);
    timer = ms === null || ms === undefined ? null : setTimeout(consider, Math.max(250, ms));
  }

  /** Whether to show it now: only while a version is offered, nothing covers the window, and the app says yes. */
  async function consider() {
    if (offer || asking || state?.state !== "available") return;
    await (globalThis.emulatorWelcome?.decided ?? Promise.resolve());
    if (offer || asking || state?.state !== "available") return;
    if (covered()) return later(COVERED_RETRY_MS);
    asking = true;
    let answer = null;
    try {
      answer = await actions().update.popup();
    } catch {
      answer = null;
    }
    asking = false;
    if (!answer?.show || !VERSION.test(answer.version ?? "")) return later(answer?.retryMs ?? null);
    open(answer);
  }

  function close() {
    if (!el) return;
    el.remove();
    el = null;
    offer = null;
    drawn = null;
    document.body.classList.remove("update-popping");
    if (before && before.isConnected) before.focus({ preventScroll: true });
    before = null;
  }

  function open(answer) {
    offer = answer;
    before = document.activeElement;
    el = make("div", "update-popup-scrim");
    el.id = "update-popup";
    const box = make("div", "update-popup");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "update-popup-title");
    box.setAttribute("aria-describedby", "update-popup-about");
    box.tabIndex = -1;
    el.append(box);
    el.addEventListener("pointerdown", (e) => e.target === el && close());
    document.body.append(el);
    document.body.classList.add("update-popping");
    render();
    (box.querySelector(".update-popup-foot .solid") ?? box).focus({ preventScroll: true });
  }

  // While it is up, the keys are the pop-up's: Esc is Later, Tab stays in it, and none of them reaches the bar.
  addEventListener(
    "keydown",
    (e) => {
      if (!el) return;
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "Tab") {
        const all = [...el.querySelectorAll("button, a[href]")].filter((one) => one.getAttribute("aria-disabled") !== "true");
        const at = all.indexOf(document.activeElement);
        e.preventDefault();
        all[(at + (e.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      }
    },
    true,
  );

  /** The pop-up's content for the offer and the update's state now. */
  function render() {
    if (!el) return;
    const box = el.firstChild;
    const { version, current } = offer;
    const s = state && state.version === version ? state : { state: "available" };
    const stage = ["downloading", "preparing", "restarting"].includes(s.state) ? "working" : s.state === "ready" ? "ready" : s.state === "failed" ? "failed" : "offer";
    const percent = s.state === "downloading" && s.total ? Math.min(100, Math.floor((100 * s.received) / s.total)) : null;
    const progressText = s.state === "downloading" ? `Downloading ${version}${percent === null ? "" : `, ${percent}%`}` : s.state === "preparing" ? `Checking ${version}` : "Restarting";
    const width = `${s.state === "downloading" ? (percent ?? 0) : 100}%`;
    // The download's news comes several times a second: only the bar and its line change, so that a button under the
    // pointer is never swapped for another between the press and the release.
    const key = JSON.stringify([version, stage, stage === "working" ? s.state : null, s.message ?? null, s.hint ?? null]);
    if (key === drawn) {
      const progress = box.querySelector("#update-popup-progress");
      if (progress) {
        progress.setAttribute("aria-valuenow", String(percent ?? 100));
        progress.querySelector(".update-popup-fill").style.width = width;
        progress.querySelector(".update-popup-progress-text").textContent = progressText;
      }
      return;
    }
    drawn = key;

    const head = make("div", "update-popup-head");
    const logo = make("img", "update-popup-logo");
    logo.src = "/emulator/icons/emulator-logo.svg";
    logo.alt = "";
    logo.width = 40;
    logo.height = 40;
    logo.draggable = false;
    const words = make("div", "update-popup-words");
    const title = make("h2", "", stage === "ready" ? `BUSY Bar Emulator ${version} is ready` : `BUSY Bar Emulator ${version} is available`);
    title.id = "update-popup-title";
    const about = make("p", "update-popup-about", stage === "ready" ? "Restart the emulator to install it. Your projects, apps on the BUSY Bar and their settings stay." : `You are on ${current ?? "an older version"}.`);
    about.id = "update-popup-about";
    words.append(title, about);
    head.append(logo, words);
    const parts = [head];

    const summary = offer.summary && Array.isArray(offer.summary.lines) ? offer.summary.lines.filter((l) => typeof l === "string" && l) : [];
    if (summary.length && stage !== "ready") {
      const notes = make(offer.summary.kind === "list" ? "ul" : "div", "update-popup-notes");
      notes.id = "update-popup-notes";
      for (const line of summary.slice(0, 3)) notes.append(make(offer.summary.kind === "list" ? "li" : "p", "", line));
      parts.push(notes);
    }

    if (!offer.canInstall) {
      const why = make("p", "update-popup-why");
      why.id = "update-popup-why";
      why.append(icon("alert"), make("span", "", `${offer.why ?? "This copy cannot update itself."} Download the new version from its release page instead.`));
      parts.push(why);
    }

    if (stage === "working") {
      const progress = make("div", "update-popup-progress");
      progress.id = "update-popup-progress";
      progress.setAttribute("role", "progressbar");
      progress.setAttribute("aria-valuemin", "0");
      progress.setAttribute("aria-valuemax", "100");
      progress.setAttribute("aria-valuenow", String(percent ?? 100));
      const track = make("span", "update-popup-track");
      const fill = make("span", "update-popup-fill");
      fill.style.width = width;
      track.append(fill);
      progress.append(make("span", "update-popup-progress-text", progressText), track);
      parts.push(progress);
    }
    if (stage === "failed") {
      const failed = make("p", "update-popup-failed", [s.message, s.hint].filter(Boolean).join(" ") || "The update failed.");
      failed.id = "update-popup-failed";
      failed.setAttribute("role", "alert");
      parts.push(failed);
    }

    const foot = make("div", "update-popup-foot");
    const laterButton = button("btn", stage === "working" ? "Hide" : stage === "failed" ? "Close" : "Later", null, close);
    laterButton.id = "update-popup-later";
    if (stage === "working") laterButton.title = "The download goes on; the top bar shows it";
    foot.append(laterButton);
    if (!offer.canInstall || stage === "failed") foot.append(downloadLink(version));
    else if (stage === "offer") foot.append(Object.assign(button("btn solid", "Update now", "download", updateNow), { id: "update-popup-go", title: `Download ${version} from GitHub and check its signature; nothing is installed before you restart` }));
    else if (stage === "ready") foot.append(Object.assign(button("btn solid", "Restart to update", "cycles-arrow", restart), { id: "update-popup-restart" }));
    parts.push(foot);

    const focusedId = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : null;
    box.replaceChildren(...parts);
    const again = focusedId ? box.querySelector(`#${focusedId}`) : null;
    (again ?? box.querySelector(".update-popup-foot .solid") ?? laterButton).focus({ preventScroll: true });
  }

  // Update now and Restart to update are the top bar's own: the app does them only just after the person's click.
  async function updateNow() {
    try {
      await actions().update.download();
    } catch {
      // Said by the app (a dialog), or nothing to do: the state is the truth.
    }
    await refresh();
  }
  async function restart() {
    try {
      await actions().update.restart();
    } catch {
      // The app is going away, or said why not in its dialog.
    }
    await refresh();
  }
  async function refresh() {
    try {
      took(await actions().update.state());
    } catch {
      // The app is going away (restarting).
    }
  }

  function took(next) {
    if (!next || typeof next !== "object") return;
    state = next;
    if (offer) {
      // A newer version than the one shown, or none any more: this pop-up is out of date.
      if (state.state === "none" || (state.version && state.version !== offer.version)) {
        close();
        consider();
      } else render();
      return;
    }
    if (state.state === "available") consider();
    else later(null);
  }

  try {
    actions().on("update", took);
  } catch {
    // An older contract without the update's news: the state below is read once.
  }
  actions()
    .update.state()
    .then(took)
    .catch(() => {});

  // For the window's own script and the tests: whether it is open, and what it offers.
  globalThis.emulatorUpdatePopup = Object.freeze({
    get open() {
      return Boolean(el);
    },
    close,
  });
})();
