// window.emulatorIconBlock: the app's two icons as one block, Front and Back side by side, each with its picture
// (large, pixel-crisp), what it must be, and its own Upload. Application Info (publish.js) and Create app
// (create-app.js) both draw it. The rules and the conversion are the command line's own, capture/icon-rules.mjs,
// which the server serves as it is: an upload is checked here as `create --icon` and `icon` check a picture, a
// requirement it breaks turns into an error in the list with the next step, and when the conversion mends it, one
// button converts it. Nothing invalid is ever taken: what the block hands over (a draft) is a PNG drawn here at the
// icon's size from the picture as the conversion makes it, and the desktop app and the command line check it again.
//
// The block keeps no state of its own: the caller's `model` holds it, the block changes it and calls `onChange`.
//   model = { front: { saved, draft, rejected }, back: { saved, draft, rejected, fromFront } }
//   saved:    the project's icon as a data: address, or null
//   draft:    a valid icon uploaded, not saved yet, as a data: address
//   rejected: { name, url, verdict, pixels }: an upload that breaks a requirement; never used
//   fromFront: the back is to be made from the front (the command line's icon without --back)
// Everything from a file (its name) is shown as text, never as markup.
(() => {
  const SIDES = Object.freeze({ front: { size: 8, title: "Front", line: "8×8, in color" }, back: { size: 11, title: "Back", line: "11×11, a shape" } });
  const icon = (name) => (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? `<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><use href="/emulator/icons/busy-sprite.svg#bi-${name}"/></svg>` : "");

  let rules = null;
  const ready = import("/emulator/capture/icon-rules.mjs")
    .then((module) => (rules = module))
    .catch(() => null);

  function make(tag, className = "", text = null) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== null) el.textContent = text;
    return el;
  }
  function button(className, label, onClick, { picture = null, title = "", disabled = null } = {}) {
    const el = make("button", className);
    el.type = "button";
    if (picture) el.innerHTML = icon(picture);
    if (label) el.append(make("span", "", label));
    el.title = disabled ?? title;
    el.ariaDisabled = disabled ? "true" : "false";
    el.addEventListener("click", (e) => {
      e.stopPropagation?.();
      if (el.ariaDisabled !== "true") onClick(e);
    });
    return el;
  }

  // ---------------------------------------------------------------- pictures

  /** A picture's pixels, 8-bit RGBA, by the page's own decoder: { width, height, rgba }, or null when it is none. */
  function decode(url) {
    return new Promise((resolve) => {
      const picture = new Image();
      picture.onerror = () => resolve(null);
      picture.onload = () => {
        const { naturalWidth: width, naturalHeight: height } = picture;
        if (!width || !height || width > 4096 || height > 4096) return resolve(null);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(picture, 0, 0);
        resolve({ width, height, rgba: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer) });
      };
      picture.src = url;
    });
  }

  /** Pixels as a canvas of their own size (shown enlarged by the style, pixel-crisp). */
  function canvasOf(width, height, rgba) {
    const canvas = make("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    return canvas;
  }
  const pngOf = (width, height, rgba) => canvasOf(width, height, rgba).toDataURL("image/png");

  /** A back icon as the BUSY Bar shows it: its shape lit, whatever its colors. */
  function shapeOnly(rgba) {
    const out = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) out.set([255, 255, 255, rgba[i + 3]], i);
    return out;
  }

  /** The icon the conversion makes of a decoded picture, as a PNG at its size (a data: address). */
  function converted(side, pixels) {
    if (side === "front") return pngOf(8, 8, rules.frontPixels(pixels));
    return pngOf(11, 11, rules.grayToRgba(rules.backPixels(pixels)));
  }

  // The project's own icons and the drafts, decoded once: the made-from-the-front preview and the checks need pixels.
  const cache = new Map(); // url → { pixels, verdicts: { front, back } } | "pending"
  function known(url, onReady) {
    const hit = cache.get(url);
    if (hit && hit !== "pending") return hit;
    if (!hit) {
      cache.set(url, "pending");
      decode(url).then((pixels) => {
        cache.set(url, { pixels, verdicts: {} });
        onReady?.();
      });
    }
    return null;
  }
  function bytesOf(url) {
    const base64 = String(url).split(",")[1] ?? "";
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  /** The project's icon checked by the rules, once it is decoded; null until then. */
  function verdictOf(url, side, onReady) {
    const hit = known(url, onReady);
    if (!hit || !rules) return null;
    hit.verdicts[side] ??= rules.checkIcon(side, { bytes: bytesOf(url), pixels: hit.pixels });
    return hit.verdicts[side];
  }

  let defaults = null;
  /** The default icon (DEFAULT_ICON of the rules) as two data: addresses, for an app that gets no icon of its own. */
  function defaultIcons() {
    if (!rules) return null;
    if (!defaults) {
      const { front, back } = rules.defaultIconPixels();
      defaults = { front: pngOf(8, 8, front), back: pngOf(11, 11, rules.grayToRgba(back)) };
    }
    return defaults;
  }

  /** The system's file dialog for a PNG: resolves with { name, url, bytes } or null when nothing was chosen. */
  function chooseFile() {
    return new Promise((resolve) => {
      const input = make("input");
      input.type = "file";
      input.accept = "image/png,.png";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          // A data: address to decode and show it, for a picture the conversion would read at all.
          const url = bytes.length <= 8 * 1024 * 1024 ? await new Promise((done) => {
            const reader = new FileReader();
            reader.onerror = () => done(null);
            reader.onload = () => done(String(reader.result ?? ""));
            reader.readAsDataURL(file);
          }) : null;
          resolve({ name: file.name, url, bytes });
        } catch {
          resolve({ name: file.name, url: null, bytes: new Uint8Array(0) });
        }
      });
      input.click();
    });
  }

  /**
   * An upload for one side, checked: { draft } when it meets every requirement (drawn again at its size by the
   * conversion), or { rejected }. `file`: { name, url, bytes } (chooseFile, or a test's).
   */
  async function take(side, file) {
    await ready;
    if (!rules) return { rejected: { name: file.name, url: null, pixels: null, verdict: { ok: false, results: { png: { ok: false, problem: "The icon's rules could not load.", next: "Close this and open it again." } }, fix: null } } };
    const pixels = file.url && file.bytes.length <= rules.MAX_PICTURE_BYTES ? await decode(file.url) : null;
    const verdict = rules.checkIcon(side, { bytes: file.bytes, pixels });
    if (verdict.ok) return { draft: converted(side, pixels) };
    return { rejected: { name: file.name, url: pixels ? file.url : null, pixels, verdict } };
  }

  // ---------------------------------------------------------------- the block

  /** The picture that stands for the front now: the draft, the project's, else the default (or none). */
  function frontNow(model, withDefault) {
    return model.front.draft ?? model.front.saved ?? (withDefault ? defaultIcons()?.front ?? null : null);
  }

  /** What one side shows: { url | canvas, caption, state: "new"|"bad"|"", verdict, kind } */
  function shown(model, side, { withDefault, redraw }) {
    const s = model[side];
    if (s.rejected) return { url: s.rejected.url, raw: true, caption: "Not taken", state: "bad", verdict: s.rejected.verdict };
    if (s.draft) return { url: s.draft, caption: "New, not saved yet", state: "new", verdict: { ok: true } };
    const front = model.front.draft ?? model.front.saved;
    if (side === "back" && front && (s.fromFront || model.front.draft)) {
      const hit = known(front, redraw);
      const made = hit?.pixels && rules ? canvasOf(11, 11, rules.grayToRgba(rules.backPixels(hit.pixels))) : null;
      return { canvas: made, caption: "Made from the front", state: model.front.draft || s.fromFront ? "new" : "", verdict: { ok: true } };
    }
    if (s.saved) return { url: s.saved, caption: "", state: "", verdict: verdictOf(s.saved, side, redraw) };
    if (withDefault) {
      const fallback = defaultIcons();
      return { url: fallback?.[side] ?? null, caption: "Default", state: "", verdict: null };
    }
    return { url: null, caption: "None", state: "", verdict: null };
  }

  /**
   * The block. `options`: onChange (called after the model changed; the caller draws again), busy (a reason the
   * buttons are off, or null), withDefault (Create app: no upload means the default icon).
   */
  function render(model, { onChange = () => {}, busy = null, withDefault = false } = {}) {
    const block = make("div", "icon-block");
    if (!rules) ready.then(() => rules && onChange());
    for (const side of ["front", "back"]) block.append(column(model, side, { onChange, busy, withDefault }));
    return block;
  }

  function column(model, side, { onChange, busy, withDefault }) {
    const s = model[side];
    const about = SIDES[side];
    const now = shown(model, side, { withDefault, redraw: onChange });
    const box = make("section", `icon-side icon-${side}`);
    box.dataset.side = side;

    const top = make("div", "top");
    const tile = make("div", `tile${now.state ? ` ${now.state}` : ""}${now.raw ? " raw" : ""}`);
    if (now.canvas) tile.append(now.canvas);
    else if (now.url) {
      const img = make("img");
      img.src = now.url;
      img.alt = `${about.title} icon`;
      tile.append(img);
    } else tile.append(make("span", "none", now.caption || "None"));
    const head = make("div", "head");
    head.append(make("b", "", about.title), make("span", "", about.line));
    if (now.caption) head.append(make("span", `caption${now.state === "bad" ? " bad" : now.state === "new" ? " new" : ""}`, now.caption));
    if (s.rejected?.name) head.append(make("span", "file", s.rejected.name));
    top.append(tile, head);
    box.append(top);

    // The requirements: plain while there is nothing to check; ticked, or an error with its next step, when there is.
    const list = make("ul", "icon-needs");
    for (const need of rules?.REQUIREMENTS[side] ?? []) {
      const result = now.verdict?.results?.[need.id] ?? (now.verdict?.ok ? { ok: true } : null);
      const li = make("li", result ? (result.ok ? "ok" : "bad") : "");
      li.dataset.need = need.id;
      const mark = make("span", "mark");
      mark.innerHTML = result ? icon(result.ok ? "checkmark" : "alert") : "";
      const words = make("span", "words");
      words.append(make("span", "need", need.text));
      if (result && !result.ok) words.append(make("span", "problem", [result.problem, result.next].filter(Boolean).join(" ")));
      li.append(mark, words);
      list.append(li);
    }
    box.append(list);
    if (side === "back" && rules) box.append(make("p", "icon-note", rules.BACK_FROM_FRONT));

    const actions = make("div", "actions");
    if (s.rejected?.verdict?.fix) {
      const fix = button("btn solid", s.rejected.verdict.fix.label, () => {
        const draft = converted(side, s.rejected.pixels);
        Object.assign(s, { draft, rejected: null, fromFront: false });
        onChange();
      }, { picture: "sparkles", title: "Converts it as busy-emulator icon does, and shows the result before it is saved", disabled: busy });
      fix.dataset.part = `fix-${side}`;
      actions.append(fix);
    }
    const upload = button("btn", "Upload", async () => {
      const file = await api.chooseFile();
      if (!file) return;
      const taken = await take(side, file);
      if (taken.draft) Object.assign(s, { draft: taken.draft, rejected: null, fromFront: false });
      else Object.assign(s, { rejected: taken.rejected });
      onChange();
    }, { picture: "upload", title: `A PNG of ${about.size}×${about.size} pixels for the ${side} display; a larger one can be converted`, disabled: busy });
    upload.dataset.part = `upload-${side}`;
    actions.append(upload);
    const front = model.front.draft ?? model.front.saved;
    if (side === "back" && front && (s.draft || s.rejected || (s.saved && !s.fromFront && !model.front.draft))) {
      const again = button("link-btn", "Make it from the front", () => {
        Object.assign(s, { draft: null, rejected: null, fromFront: true });
        onChange();
      }, { disabled: busy });
      again.dataset.part = "back-from-front";
      actions.append(again);
    }
    box.append(actions);
    return box;
  }

  /** A model for an app without icons yet, or with the project's (`saved`: { front, back } data: addresses). */
  function emptyModel(saved = {}) {
    return { front: { saved: saved.front ?? null, draft: null, rejected: null }, back: { saved: saved.back ?? null, draft: null, rejected: null, fromFront: false } };
  }
  /** Whether there is anything to save: a draft, or a back to be made from the front. */
  const hasDraft = (model) => Boolean(model && (model.front.draft || model.back.draft || model.back.fromFront));

  const api = { ready, render, take, emptyModel, hasDraft, defaultIcons, chooseFile, rules: () => rules };
  globalThis.emulatorIconBlock = api;
})();
