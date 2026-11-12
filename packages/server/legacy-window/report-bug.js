// window.openReportBug(): Report a Bug (EMU-277, README.md beside this file). A dialog over the window: what the person
// did and expected, two ticks (the log's last lines, a screenshot of the bar), and on the right the whole text GitHub
// will get, as the desktop app makes it (`report.preview`): scrubbed of home folders, user names, GitHub logins,
// folders outside the home, tokens, Wi-Fi names, serials and MACs. "Open on GitHub" opens that text in the new issue form of the emulator's public repository in the
// browser, where the person sends it, or does not; "Save diagnostics" writes a .zip of the logs and the state where
// they say. Nothing is sent from here.
//
// The window's top bar calls window.openReportBug(); so does the app menu's Help, Report a Bug… (on("menu")). The
// screenshot is the bar's two displays as the bar's own API gives them (GET /api/screen), drawn large: it goes on the
// clipboard to paste into the form, and into the archive. Everything is shown as text, never as markup; every action
// with consequences is called from the person's click, in its handler.
(() => {
  if (typeof document === "undefined" || !document.body) return;

  const actions = () => globalThis.emulatorActions ?? null;
  const icon = (name) => `<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><use href="/emulator/icons/busy-sprite.svg#bi-${name}"/></svg>`;
  const WINDOWS = /Windows/.test(navigator.userAgent);
  const SHOW = WINDOWS ? "Show in Explorer" : "Show in Finder";
  const LIMITS = { title: 200, what: 4000, expected: 4000 };
  const FRONT = { width: 72, height: 16, scale: 8 };
  const BACK = { width: 160, height: 80, scale: 4 };

  function make(tag, className = "", text = null) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== null) el.textContent = text;
    return el;
  }

  // ---------------------------------------------------------------- the dialog, made once

  const root = make("div", "report-bug-scrim");
  root.hidden = true;
  const dialog = make("div", "report-bug");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "report-bug-title");
  root.append(dialog);

  const head = make("header", "report-bug-head");
  const mark = make("span", "report-bug-mark");
  mark.innerHTML = icon("bug");
  const titles = make("div", "report-bug-titles");
  const heading = make("h2", "", "Report a Bug");
  heading.id = "report-bug-title";
  titles.append(heading, make("p", "", "The emulator fills in a new issue on GitHub. You check it in your browser and send it from there."));
  const closeButton = make("button", "icon-btn report-bug-close");
  closeButton.type = "button";
  closeButton.title = "Close";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.innerHTML = icon("cross");
  head.append(mark, titles, closeButton);

  const body = make("div", "report-bug-body");
  const form = make("div", "report-bug-form");

  function field(label, control, about = null) {
    const box = make("label", "report-bug-field");
    const top = make("span", "label");
    top.append(make("b", "", label));
    if (about) top.append(make("span", "about", about));
    box.append(top, control);
    return box;
  }
  const titleInput = make("input", "report-bug-input");
  titleInput.type = "text";
  titleInput.id = "report-bug-title-input";
  titleInput.maxLength = LIMITS.title;
  titleInput.placeholder = "The app stops when the wheel turns";
  titleInput.autocomplete = "off";
  titleInput.spellcheck = true;
  const whatInput = make("textarea", "report-bug-input");
  whatInput.id = "report-bug-what";
  whatInput.maxLength = LIMITS.what;
  whatInput.rows = 5;
  whatInput.placeholder = "1. Open the app\n2. Turn the wheel\n3. …";
  const expectedInput = make("textarea", "report-bug-input");
  expectedInput.id = "report-bug-expected";
  expectedInput.maxLength = LIMITS.expected;
  expectedInput.rows = 3;
  expectedInput.placeholder = "What the BUSY Bar should have done";

  function tick(id, label, about) {
    const box = make("label", "report-bug-tick");
    const input = make("input");
    input.type = "checkbox";
    input.id = id;
    const sign = make("span", "box");
    sign.innerHTML = icon("checkmark");
    const words = make("span", "words");
    words.append(make("b", "", label), make("span", "", about));
    box.append(input, sign, words);
    return { box, input };
  }
  const logTick = tick("report-bug-log", "The last lines of the log", "As many as fit in the form");
  logTick.input.checked = true;
  const shotTick = tick("report-bug-shot", "A screenshot of the BUSY Bar", "Goes on the clipboard, to paste into the issue");
  const thumb = make("img", "report-bug-thumb");
  thumb.alt = "The BUSY Bar's displays";
  thumb.hidden = true;
  shotTick.box.append(thumb);
  const ticks = make("div", "report-bug-ticks");
  ticks.append(logTick.box, shotTick.box);
  form.append(field("Title", titleInput), field("What did you do?", whatInput, "Steps, the app, the BUSY Bar's mode"), field("What did you expect?", expectedInput), ticks);

  const preview = make("section", "report-bug-preview");
  preview.setAttribute("aria-label", "What GitHub gets");
  const previewHead = make("div", "label");
  previewHead.append(make("b", "", "What GitHub gets"), make("span", "about", "github.com/busy-app/busybar-emulator"));
  const previewTitle = make("p", "report-bug-issue-title");
  const previewText = make("pre", "report-bug-text");
  previewText.id = "report-bug-text";
  previewText.tabIndex = 0;
  const fitNote = make("p", "report-bug-fit");
  fitNote.hidden = true;
  const privacy = make("p", "report-bug-note");
  privacy.innerHTML = icon("info");
  privacy.append(make("span", "", "Home folders, user names, GitHub logins, folders outside your home folder, tokens and keys, Wi-Fi names, serial numbers and MAC addresses are taken out before you see it."));
  preview.append(previewHead, previewTitle, previewText, fitNote, privacy);
  body.append(form, preview);

  const foot = make("footer", "report-bug-foot");
  const said = make("span", "report-bug-said");
  said.id = "report-bug-said";
  said.setAttribute("role", "status");
  said.setAttribute("aria-live", "polite");
  const revealButton = make("button", "btn small report-bug-reveal", SHOW);
  revealButton.type = "button";
  revealButton.hidden = true;
  const saveButton = make("button", "btn report-bug-save");
  saveButton.type = "button";
  saveButton.id = "report-bug-save";
  saveButton.title = "A .zip of the logs and the state, scrubbed the same way, in a folder you choose";
  saveButton.innerHTML = icon("archive");
  saveButton.append(make("span", "", "Save diagnostics"));
  const openButton = make("button", "btn solid report-bug-open");
  openButton.type = "button";
  openButton.id = "report-bug-open";
  openButton.title = "Opens the filled-in issue in your browser";
  openButton.innerHTML = icon("arrow-up-right");
  openButton.append(make("span", "", "Open on GitHub"));
  const saidBox = make("div", "report-bug-said-box");
  saidBox.append(said, revealButton);
  foot.append(saidBox, saveButton, openButton);
  dialog.append(head, body, foot);

  // ---------------------------------------------------------------- state

  let mounted = false;
  let returnFocus = null;
  let image = null; // the bar's screenshot as a PNG data: address, taken when the dialog opened
  let shown = null; // the last preview
  let asked = 0;
  let previewTimer = null;
  let busy = false;

  const fields = () => ({ title: titleInput.value, what: whatInput.value, expected: expectedInput.value, log: logTick.input.checked, screenshot: shotTick.input.checked && image !== null, image });

  function say(text, kind = "") {
    said.textContent = text;
    said.className = `report-bug-said${kind ? ` ${kind}` : ""}`;
  }

  function setBusy(on) {
    busy = on;
    for (const button of [saveButton, openButton]) button.ariaDisabled = on || !actions()?.available?.().shell ? "true" : "false";
    if (shown && !shown.fits) openButton.ariaDisabled = "true";
  }

  async function refresh() {
    const mine = ++asked;
    const ask = actions();
    if (!ask?.available?.().shell) {
      previewText.textContent = "";
      say("Report a Bug works in the BUSY Bar Emulator app, not in a browser.", "failed");
      setBusy(false);
      return;
    }
    try {
      const made = await ask.report.preview(fields());
      if (mine !== asked || root.hidden) return;
      shown = made;
      previewTitle.textContent = made.title ? made.title : "No title yet: GitHub asks for one.";
      previewTitle.classList.toggle("empty", !made.title);
      previewText.textContent = made.body;
      if (!made.fits) {
        fitNote.textContent = `Too long for GitHub's form by ${made.over} characters: shorten what you wrote.`;
        fitNote.className = "report-bug-fit failed";
        fitNote.hidden = false;
      } else if (made.lines.shown < made.lines.of) {
        fitNote.textContent = `The form has room for ${made.lines.shown} of the log's last ${made.lines.of} lines. Save diagnostics and attach the archive for the whole log.`;
        fitNote.className = "report-bug-fit";
        fitNote.hidden = false;
      } else {
        fitNote.hidden = true;
      }
      setBusy(busy);
    } catch (e) {
      if (mine !== asked) return;
      say(e?.message ?? "The text could not be made.", "failed");
    }
  }
  const soon = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(refresh, 200);
  };

  /** The bar's two displays from its own API, drawn large on black: the front's LEDs over the back's OLED. */
  async function takeScreenshot() {
    const frame = async (display) => {
      const answer = await fetch(`/api/screen?display=${display}`, { cache: "no-store" });
      if (!answer.ok) throw new Error(`the BUSY Bar answered ${answer.status}`);
      const text = (await answer.text()).trim();
      return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    };
    const [front, back] = await Promise.all([frame(0), frame(1)]);
    if (front.length < FRONT.width * FRONT.height * 3 || back.length < (BACK.width * BACK.height) / 2) throw new Error("the BUSY Bar's frames are not whole");
    const pad = 16;
    const width = BACK.width * BACK.scale + pad * 2;
    const height = pad + FRONT.height * FRONT.scale + pad + BACK.height * BACK.scale + pad;
    const canvas = Object.assign(document.createElement("canvas"), { width, height });
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, width, height);
    const left = Math.round((width - FRONT.width * FRONT.scale) / 2);
    for (let y = 0; y < FRONT.height; y++) {
      for (let x = 0; x < FRONT.width; x++) {
        const i = (y * FRONT.width + x) * 3;
        ctx.fillStyle = `rgb(${front[i + 2]},${front[i + 1]},${front[i]})`;
        ctx.fillRect(left + x * FRONT.scale, pad + y * FRONT.scale, FRONT.scale, FRONT.scale);
      }
    }
    const top = pad + FRONT.height * FRONT.scale + pad;
    for (let i = 0; i < BACK.width * BACK.height; i++) {
      const v = ((back[i >> 1] >> ((i & 1) * 4)) & 0xf) * 17;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(pad + (i % BACK.width) * BACK.scale, top + Math.floor(i / BACK.width) * BACK.scale, BACK.scale, BACK.scale);
    }
    return canvas.toDataURL("image/png");
  }

  async function snap() {
    image = null;
    thumb.hidden = true;
    shotTick.input.disabled = false;
    shotTick.box.title = "";
    try {
      image = await takeScreenshot();
      thumb.src = image;
      thumb.hidden = false;
    } catch {
      shotTick.input.checked = false;
      shotTick.input.disabled = true;
      shotTick.box.title = "The BUSY Bar's screen could not be read: is the BUSY Bar running?";
    }
    soon();
  }

  // ---------------------------------------------------------------- open, close, keys

  function open() {
    if (!mounted) {
      document.body.append(root);
      mounted = true;
      root.addEventListener("mousedown", (e) => e.target === root && (root.dataset.down = "1"));
      root.addEventListener("click", (e) => {
        if (e.target === root && root.dataset.down === "1") close();
        delete root.dataset.down;
      });
      document.addEventListener("keydown", onKey, true);
    }
    if (!root.hidden) return void titleInput.focus();
    returnFocus = document.activeElement ?? null;
    root.hidden = false;
    document.body.classList.add("reporting-bug");
    say("");
    revealButton.hidden = true;
    setBusy(false);
    previewText.textContent = "";
    previewTitle.textContent = "";
    fitNote.hidden = true;
    titleInput.focus();
    void snap();
    void refresh();
  }

  function close() {
    if (root.hidden) return;
    root.hidden = true;
    document.body.classList.remove("reporting-bug");
    clearTimeout(previewTimer);
    try {
      returnFocus?.focus?.();
    } catch {
      // The button that opened it is gone.
    }
  }

  const focusables = () => [...dialog.querySelectorAll("button, input, textarea, [tabindex='0']")].filter((el) => !el.hidden && !el.disabled && el.offsetParent !== null);
  function onKey(e) {
    if (root.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      const all = focusables();
      if (!all.length) return;
      const at = all.indexOf(document.activeElement);
      const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : at === all.length - 1 || at < 0 ? 0 : at + 1;
      e.preventDefault();
      all[next].focus();
    }
    // Keys typed here are the dialog's, not the bar's.
    e.stopPropagation();
  }

  closeButton.addEventListener("click", close);
  for (const input of [titleInput, whatInput, expectedInput]) input.addEventListener("input", soon);
  for (const input of [logTick.input, shotTick.input]) input.addEventListener("change", soon);

  const failed = (e) => (e?.code === "no_gesture" ? say("Click again.", "failed") : say([e?.message ?? "It did not work.", e?.hint].filter(Boolean).join(" "), "failed"));

  openButton.addEventListener("click", async () => {
    if (busy || openButton.ariaDisabled === "true") return;
    setBusy(true);
    say("Opening the form in your browser", "working");
    try {
      const done = await actions().report.open(fields());
      say(done.screenshot ? "Opened in your browser. The screenshot is on the clipboard: paste it into the issue, check the text and send it." : "Opened in your browser: check the text there and send it.", "done");
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  });

  saveButton.addEventListener("click", async () => {
    if (busy || saveButton.ariaDisabled === "true") return;
    setBusy(true);
    revealButton.hidden = true;
    say("Choose where the archive goes", "working");
    try {
      const done = await actions().report.save(fields());
      if (!done.saved) say("");
      else {
        say(`Saved ${done.shown}. Attach it to the issue.`, "done");
        revealButton.hidden = false;
      }
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  });

  revealButton.addEventListener("click", () => {
    actions()
      ?.report.reveal()
      .catch(failed);
  });

  actions()?.on?.("menu", (item) => item === "report" && open());

  /** Opens Report a Bug; the window's top bar and the app menu call it. */
  window.openReportBug = open;
  /** For the window's tests: closes it. */
  window.closeReportBug = close;
})();
