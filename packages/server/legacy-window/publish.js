// window.emulatorPublish: the publishing flow of the device window (README.md beside this file, "Publish"). A dialog of
// steps over the window, gone through in order: Application Info (the icon, the name and the catalog texts), the screenshots, the README, the license, the files
// of the public repository, the pre-flight check and the package (stage 1, nothing leaves the computer); then the
// repository on GitHub and the request to the catalog (stage 2). Each step is the command line's `busy-emulator
// publish` (and `catalog-texts`) through the app's bridge, window.emulatorActions: the window decides nothing about the
// files itself. Next writes what the step holds, so that nothing is left to save by hand; a step that is not complete
// keeps Next off and says why in the footer; the steps after the first one not done wait. The rules are in
// publish-steps.mjs. Where each step stands is the project's own (its files, and .busy/publish.json), so the flow
// opens where it was left.
//
// Everything that comes from the project (names, paths, texts, messages) is shown as text, never as markup.
(() => {
  // `prompt`: what the catalog's template asks "Partly" and "Fully" to explain (EMU-359), when its own lines do not say.
  const AI_CHOICES = [
    { id: "none", name: "No AI was used", prompt: null },
    { id: "partly", name: "Partly AI-assisted", prompt: "Describe which parts were AI-generated and what they do" },
    { id: "full", name: "Fully AI-generated", prompt: "Describe what the generated code does" },
  ];
  /** The longest explanation of the AI usage the request sends (publish-flow.mjs MAX_AI_NOTE). */
  const MAX_AI_NOTE = 1000;
  const needsNote = (ai) => ai === "partly" || ai === "full";
  const noteLength = (text) => String(text ?? "").replace(/\s+/g, " ").trim().length;
  const FILE_MANAGER = /win/i.test(globalThis.navigator?.platform ?? "") ? "Explorer" : "Finder";
  const NO_GESTURE = "no_gesture";

  const actions = () => globalThis.emulatorActions ?? null;
  const icon = (name) => (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) ? `<svg class="bi" viewBox="0 0 24 24" aria-hidden="true"><use href="/emulator/icons/busy-sprite.svg#bi-${name}"/></svg>` : "");

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

  // ---------------------------------------------------------------- state

  // { folder, name, step, status, check, said, busy, lines, packaged, files, drafts, … }
  let flow = null;
  // The rules, loaded once: the steps (publish-steps.mjs), the catalog's for the texts (readiness/texts.mjs and
  // rules.mjs) and the README's maker (publish/readme.mjs), the same files the command line uses.
  let steps = null;
  let rules = null;
  let readme = null;
  let howToUse = null;
  const root = make("div", "publish-scrim");
  root.hidden = true;
  const dialog = make("div", "publish");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "publish-title");
  root.append(dialog);
  let mounted = false;

  /** Runs an action of the bridge from a click: { ok, … } or { ok: false, again: true } when it wanted a fresh click. */
  async function act(call) {
    try {
      return (await call()) ?? { ok: true };
    } catch (e) {
      if (e?.code === NO_GESTURE) return { ok: false, again: true, message: "Click again" };
      return { ok: false, code: e?.code ?? "failed", message: String(e?.message ?? e), hint: e?.hint ?? null };
    }
  }

  async function loadModules() {
    if (steps && rules && readme && howToUse) return true;
    try {
      const [s, t, r, m, h] = await Promise.all([import("/emulator/publish-steps.mjs"), import("/emulator/readiness/texts.mjs"), import("/emulator/readiness/rules.mjs"), import("/emulator/publish/readme.mjs"), import("/emulator/publish/how-to-use.mjs")]);
      steps = s;
      howToUse = h;
      // How to use is optional (EMU-364: the catalog does not read it yet). Only rows made in the step's own editor
      // (fields) are checked; a section written in Markdown is said as a hint, never a block.
      const readmeProblem = (config, facts) => m.readmeProblem(config, facts) ?? ((config?.mode ?? "fields") === "fields" ? h.sectionProblem(rowsOfReadme(config)) : null);
      rules = { textProblems: t.textProblems, nameProblem: r.nameProblem, readmeProblem };
      readme = m;
      return true;
    } catch (e) {
      if (flow) flow.said = { failed: true, text: `The publishing flow could not load (${e?.message ?? e}).` };
      return false;
    }
  }

  /** What the person has in the steps now, kept while they go back and forth: taken from the project when untouched. */
  function syncDrafts() {
    const s = flow.status;
    const d = flow.drafts;
    if (!d.textsDirty) {
      d.texts = { ...s.texts.texts };
      d.name = s.texts.name ?? "";
    }
    if (!d.readmeDirty) {
      d.readme = { ...s.readme.config };
      d.rows = rowsOfReadme(d.readme);
    }
    d.license ??= { choice: s.license.choice ?? null, author: s.license.author ?? "" };
  }

  async function loadStatus() {
    if (!flow) return;
    const folder = flow.folder;
    const answer = await act(() => actions().publish.status(folder));
    if (!flow || flow.folder !== folder) return;
    if (answer.ok) {
      flow.status = answer;
      syncDrafts();
    } else flow.said = { failed: true, text: answer.message ?? "The project could not be read." };
  }

  const isDone = (id) => steps.isDone(id, flow.status);

  // ---------------------------------------------------------------- opening and closing

  /** Opens the flow for a project: { folder, name }. It opens on the first step not done. */
  // account: "switch" or "add" (the top bar's account menu) opens Publish on Choose a GitHub account, with another
  // account to choose, or with "Another account" chosen to sign in.
  async function open({ folder, name, account = null }) {
    if (!mounted) {
      document.body.append(root);
      mounted = true;
      root.addEventListener("click", (e) => e.target === root && close());
      // A click anywhere else closes the category's list, without drawing the form again (the field clicked keeps focus).
      dialog.addEventListener("click", (e) => {
        if (!flow?.picking || e.target?.closest?.(".publish-options, .publish-select")) return;
        flow.picking = false;
        dialog.querySelector(".publish-options")?.remove();
        const select = dialog.querySelector(".publish-select");
        select?.classList.remove("open");
        select?.setAttribute("aria-expanded", "false");
      });
      document.addEventListener("keydown", (e) => {
        if (!root.hidden && e.key === "Escape") {
          e.preventDefault?.();
          if (flow?.picking) {
            flow.picking = false;
            render();
            return;
          }
          close();
        }
      });
      actions()?.on?.("job", onJob);
      // stale-check: back from the editor, the project is compared again on a step that relies on the check.
      globalThis.addEventListener?.("focus", () => {
        if (!root.hidden && flow?.status && !flow.busy && (flow.step === "check" ? Boolean(flow.check) : steps?.afterCheck(flow.step))) void backToStale();
      });
    }
    const same = flow?.folder === folder;
    if (!same) flow = { folder, name, step: null, status: null, check: null, said: null, busy: null, lines: [], packaged: null, files: null, drafts: { textsDirty: false, readmeDirty: false, texts: null, name: null, readme: null, rows: [], license: null }, touched: new Set(), pending: null };
    root.hidden = false;
    document.body.classList.add("publishing");
    flow.busy = "Reading the project";
    render();
    const loaded = await loadModules();
    await loadStatus();
    if (!flow) return;
    flow.busy = null;
    if (!loaded || !flow.status) return render();
    // stale-check: a file changed since the check or the package while the dialog was closed.
    if (flow.step && (flow.step === "check" || steps.afterCheck(flow.step)) && goBackIfStale()) return;
    if (account === "switch" || account === "add") {
      flow.step = "github";
      flow.accountMode = true;
      if (account === "add") flow.pick = NEW_ACCOUNT;
      render();
      enter(flow.step);
      return;
    }
    // Opened again: on the step it was left at, unless that one is done, then on the first one not done.
    if (!flow.step || steps.isDone(flow.step, flow.status)) flow.step = steps.firstOpen(flow.status);
    render();
    enter(flow.step);
  }

  function close() {
    // A send under way is seen to its end (EMU-360): the dialog stays until GitHub has answered.
    if (sending()) return;
    root.hidden = true;
    document.body.classList.remove("publishing");
    globalThis.dispatchEvent?.(new Event("publish-closed"));
  }

  function onJob(job) {
    if (!flow || job?.folder !== flow.folder) return;
    if (job.upload || (typeof job.line === "string" && flow.step === "github")) heardUpload(job);
    if (job.upload) return;
    // Build and package: the build's job has ended and the packaging's begins.
    if (flow.busy === "Building" && flow.step === "package" && job.kind === "publish" && job.state === "running" && typeof job.line !== "string") {
      flow.busy = "Packaging";
      render();
    }
    if (typeof job.line !== "string") return;
    if (!["build", "publish"].includes(job.kind)) return;
    flow.lines.push(job.line);
    if (flow.lines.length > 6) flow.lines.shift();
    if (["package", "github", "catalog"].includes(flow.step)) render();
  }

  /** What a step does when it is opened: the check runs, the files are read, GitHub is asked. */
  function enter(step) {
    if (step === "check") runCheck();
    if (step === "files") planFiles();
    if (step === "github" || step === "catalog") loadGithub();
    // What the catalog has of the app is read again each time Send to catalog opens (catalog-update).
    if (step === "catalog" && flow) flow.entry = null;
  }

  /**
   * Goes to a step. What was typed in the catalog texts is written on the way out, as Next would. A step after
   * Pre-flight check is opened only when the check and the package still hold for the project (stale-check).
   */
  async function go(step, { saved = false, compared = false } = {}) {
    if (!flow || !step) return;
    if (!compared && steps.afterCheck(step) && step !== flow.step && (await backToStale())) return;
    if (!saved && flow.step === "texts" && step !== "texts" && (flow.drafts.textsDirty || flow.drafts.name !== flow.status.texts.name)) {
      const save = steps.saveOnNext("texts", flow.status, flow.drafts);
      if (save) saveTexts(save);
    }
    if (!saved && flow.step === "texts" && step !== "texts" && iconDrafted()) saveIcon();
    flow.picking = false;
    if (flow.outcome && flow.outcome.step !== step && flow.outcome.kind !== "sending") flow.outcome = null;
    flow.step = step;
    flow.said = null;
    flow.readmeAsk = null;
    if (flow.changed && flow.changed.step !== step) flow.changed = null;
    render();
    enter(step);
  }

  /** Next: writes what the step holds (publish-steps.mjs saveOnNext), then goes on. */
  async function next() {
    const id = flow.step;
    if (blocked()) return;
    // From Pre-flight check on, Next goes on only when the project is still the one checked and packaged (stale-check).
    if ((id === "check" || steps.afterCheck(id)) && (await backToStale())) return;
    const save = steps.saveOnNext(id, flow.status, flow.drafts);
    let ok = true;
    // The texts go on at once: they are checked here by the catalog's own rules already; the writing runs behind.
    if (id === "texts" && iconDrafted()) saveIcon();
    if (save?.kind === "texts") saveTexts(save);
    else if (save?.kind === "readme") {
      // A README.md used as it is is not written over before the person says so (EMU-365).
      if (replacesKept(save.readme)) {
        flow.readmeAsk = { save };
        render();
        return;
      }
      ok = await saveReadme(save);
    }
    else if (save?.kind === "license") ok = await writeLicense(save.license, save.author);
    else if (save?.kind === "files") ok = await planFiles({ write: true });
    if (!ok || !flow) return;
    const to = steps.nextStep(id);
    if (to) await go(to, { saved: true, compared: id === "check" || steps.afterCheck(id) });
  }

  /** Why Next is off on this step now, or null. */
  function blocked() {
    if (!flow?.status || !steps) return "Wait a moment";
    if (flow.busy) return "Wait for the work under way";
    return steps.nextBlock(flow.step, flow.status, { ...flow.drafts, check: flow.check }, rules);
  }

  // ---------------------------------------------------------------- the actions of the steps

  /** Runs `work` with the footer saying `what`; the project is read again after, so that the step shows it as it is. */
  async function busy(what, work) {
    flow.busy = what;
    flow.said = null;
    render();
    let result;
    try {
      // What Application Info writes behind the next step comes first: one job of a project at a time.
      if (flow.pending) await flow.pending;
      result = await work();
    } finally {
      if (flow) {
        // The project is read again first: the result and the footer's words then come together, in one drawing.
        await loadStatus();
        flow.busy = null;
        render();
      }
    }
    return result;
  }

  const said = (answer, done) => (answer.ok ? (done ? { text: done } : null) : { failed: !answer.again, text: [answer.message, answer.hint].filter(Boolean).join(" ") });

  function runCheck({ byHand = false } = {}) {
    // Run again by hand: what changed is not news any more.
    if (byHand || flow.changed?.step !== "check") flow.changed = null;
    return busy("Checking", async () => {
      const answer = await act(() => actions().publish.check(flow.folder));
      if (answer.ok) flow.check = answer;
      else flow.said = said(answer);
    });
  }

  // ---------------------------------------------------------------- stale-check

  /**
   * The project read again and compared with what Pre-flight check and Build and package saw (publish status, which
   * compares the fingerprints they recorded): when a file changed, the flow goes back to the step that no longer holds
   * and says what changed; the check runs again at once, the package waits for Build and package. True when it went
   * back, so the caller does not go on.
   */
  async function backToStale() {
    if (!flow || flow.busy) return false;
    // Said in the footer while the project is read: the step does not go on before it is compared.
    flow.busy = "Comparing with the check";
    render();
    try {
      await loadStatus();
    } finally {
      if (flow) flow.busy = null;
    }
    if (goBackIfStale()) return true;
    render();
    return false;
  }

  /** backToStale() without reading the project again: by the status the flow has. */
  function goBackIfStale() {
    if (!flow?.status) return false;
    const to = steps.staleStep(flow.status);
    if (!to) return false;
    flow.changed = { step: to, words: steps.changedWords(to === "check" ? flow.status.check : flow.status.package) };
    if (to === "check") flow.check = null;
    flow.packaged = null;
    flow.picking = false;
    flow.step = to;
    flow.said = null;
    render();
    enter(to);
    return true;
  }

  /**
   * A refusal of the shell's that says the project changed since it was checked or packaged: said, and once the work
   * under way has ended and the project was read again (busy()), back to the step that no longer holds (afterStale).
   */
  const changedCodes = new Set(["changed_since_check", "changed_since_package"]);
  function staleRefusal(answer) {
    if (answer?.ok !== false || !changedCodes.has(answer.code)) return false;
    flow.said = said(answer);
    flow.staleAfter = true;
    return true;
  }
  /** After busy(): back to the stale step, when a refusal said so. */
  function afterStale() {
    if (!flow?.staleAfter) return;
    flow.staleAfter = false;
    goBackIfStale();
  }

  /** What changed, at the head of the step it made stale: "Changed since the check: src/main.ts." */
  function changedNotice(step) {
    if (flow.changed?.step !== step) return null;
    const note = make("div", "publish-verdict bad publish-changed");
    note.innerHTML = icon("alert");
    const words = make("div", "words");
    const since = step === "check" ? "Changed since the check" : "Changed since the package";
    words.append(make("b", "", since), make("span", "", step === "check" ? `${flow.changed.words}. ${flow.busy ? "Checking again." : "Checked again."}` : `${flow.changed.words}. Build and package again.`));
    note.append(words);
    return note;
  }

  /**
   * Work that runs behind the step the person went on to (what Application Info writes): one after the other, as the
   * shell runs one job of a project at a time; `busy` waits for it before its own. Drawn again when it ends.
   */
  function behind(work) {
    const folder = flow.folder;
    const before = flow.pending ?? Promise.resolve();
    const run = before.then(() => (flow?.folder === folder ? work() : false));
    const pending = run
      .catch(() => false)
      .finally(() => {
        if (flow?.pending === pending) flow.pending = null;
        if (flow?.folder !== folder) return;
        render();
        void quietRefresh();
      });
    flow.pending = pending;
    return run;
  }

  /**
   * Application Info's writing: one run of the command line (catalog-texts set), behind the step the person went on to.
   * Its answer is the step's state as the command line read it back, so the project is not read again for it (that
   * was three more runs of the command line, a second or more on Windows); what else the texts change (the README's
   * defaults) is read after, quietly. A failure brings the person back to the step and says why.
   */
  function saveTexts(save) {
    return behind(async () => {
      const answer = await act(() => actions().publish.texts({ folder: flow.folder, name: save.name, texts: save.texts }));
      if (!flow) return answer.ok;
      if (answer.ok) {
        const { ok: _ok, folder: _folder, ...texts } = answer;
        flow.status.texts = { ...flow.status.texts, ...texts };
        if (typeof answer.name === "string" && answer.name) flow.status.name = answer.name;
        flow.drafts.textsDirty = false;
        flow.drafts.name = null;
        syncDrafts();
      } else {
        flow.said = said(answer);
        flow.step = "texts";
      }
      return answer.ok;
    });
  }

  /** The project read again without a word in the footer; drawn again unless the person is typing in the pane. */
  async function quietRefresh() {
    if (!flow || flow.busy || flow.pending) return;
    const folder = flow.folder;
    const answer = await act(() => actions().publish.status(folder));
    if (!flow || flow.folder !== folder || flow.busy || flow.pending || !answer.ok) return;
    flow.status = answer;
    syncDrafts();
    const typing = document.activeElement && dialog.contains(document.activeElement) && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (!typing) render();
  }

  // ---- the icons: the shared icon block (icon-block.js), its drafts kept in flow.icons until saved

  const iconBlock = () => globalThis.emulatorIconBlock ?? null;
  /** The block's model, its saved icons the project's as they are now. */
  function iconModel() {
    flow.icons ??= iconBlock()?.emptyModel() ?? null;
    if (flow.icons) {
      flow.icons.front.saved = flow.status?.icon?.front ?? null;
      flow.icons.back.saved = flow.status?.icon?.back ?? null;
    }
    return flow.icons;
  }
  const iconDrafted = () => Boolean(iconBlock()?.hasDraft(flow?.icons));

  /**
   * Writes the icons uploaded (the command line's icon --from and --back, as Create app writes them): the front
   * uploaded or the project's, else the default one; the back uploaded, or made from the front when the front is new
   * or the person asked for it.
   */
  function saveIcon() {
    const model = flow.icons;
    if (!iconBlock()?.hasDraft(model)) return Promise.resolve(true);
    const front = model.front.draft ?? model.front.saved ?? iconBlock().defaultIcons()?.front ?? null;
    const back = model.back.draft ?? (model.front.draft || model.back.fromFront ? null : model.back.saved);
    if (!front) {
      flow.said = { failed: true, text: "The icon's rules did not load: close Publish and open it again." };
      render();
      return Promise.resolve(false);
    }
    flow.icons = null;
    flow.status.icon = { front, back: back ?? flow.status.icon?.back ?? null };
    render();
    return behind(async () => {
      const answer = await act(() => actions().publish.icon({ folder: flow.folder, front, back }));
      if (!flow) return answer.ok;
      if (!answer.ok) {
        flow.icons = model;
        flow.step = "texts";
      }
      flow.said = said(answer, flow.step === "texts" ? "Icons saved" : null);
      return answer.ok;
    });
  }

  function saveReadme(save, { replace = false } = {}) {
    const keep = save.readme?.mode === "file";
    return busy(keep ? "Saving" : "Writing README.md", async () => {
      // The file as it is takes no text: the fields stay in the record as they were.
      const readme = keep ? { mode: "file" } : save.readme;
      const answer = await act(() => actions().publish.readme({ folder: flow.folder, readme, ...(replace ? { replace: true } : {}) }));
      if (answer.ok) flow.readmeAsk = null;
      // A window that did not know the file is used as it is (chosen on the command line meanwhile): it asks the
      // person, as Next does when it knows; the project is read again after the work.
      if (!answer.ok && answer.code === "readme_kept" && !replace) {
        flow.readmeAsk = { save };
        flow.said = null;
        return false;
      }
      if (answer.ok) flow.drafts.readmeDirty = false;
      flow.said = said(answer);
      return answer.ok;
    });
  }

  function screenshots(change, done) {
    return busy(change.take ? "Taking a screenshot" : change.upload ? "Choosing files" : "Saving", async () => {
      const answer = await act(() => actions().publish.screenshots({ folder: flow.folder, ...change }));
      if (change.upload && answer?.ok && Array.isArray(answer.uploaded)) {
        const refused = answer.refused ?? [];
        flow.said = refused.length ? { failed: true, text: `Added ${answer.uploaded.length}. ${refused.join(" ")}` } : { text: `Added ${answer.uploaded.length === 1 ? "1 screenshot" : `${answer.uploaded.length} screenshots`}` };
      } else flow.said = said(answer, done);
    });
  }

  /**
   * Upload license file…: the system's dialog for the person's own license, copied in as LICENSE; the license check
   * runs again with the reading of the project. When the project has a license file, the person is asked first:
   * `replace` is their yes.
   */
  function uploadLicense(replace = false) {
    return busy(replace ? "Replacing LICENSE" : "Choosing the license file", async () => {
      const answer = await act(() => actions().publish.license({ folder: flow.folder, license: "other", ...(replace ? { replace: true } : { upload: true }) }));
      flow.licenseAsk = null;
      if (answer === null) return;
      if (answer.ok === false && answer.code === "license_exists") {
        flow.licenseAsk = { file: answer.file ?? "LICENSE", chosen: answer.chosen ?? "the file" };
        return;
      }
      flow.said = said(answer, answer.copied ? `Copied ${answer.copied} in as LICENSE` : null);
      if (answer.ok) flow.drafts.license = { ...(flow.drafts.license ?? {}), choice: "other" };
    });
  }

  function writeLicense(choice, author) {
    return busy("Writing LICENSE", async () => {
      const answer = await act(() => actions().publish.license({ folder: flow.folder, license: choice, author }));
      flow.said = said(answer);
      return answer.ok;
    });
  }

  function planFiles(change = null) {
    return busy(change ? "Writing" : "Reading the files", async () => {
      const answer = await act(() => actions().publish.files({ folder: flow.folder, ...(change ?? {}) }));
      if (answer.ok) flow.files = answer;
      else flow.said = said(answer);
      return answer.ok;
    });
  }

  function buildAndPackage() {
    flow.lines = [];
    flow.packaged = null;
    // One action of the click: the app builds, then packages (a build takes longer than the click's two seconds, and
    // the page may start nothing after them). Its job's news says when the packaging begins.
    return busy("Building", async () => {
      const packaged = await act(() => actions().publish.package(flow.folder, { build: true }));
      flow.packaged = packaged.ok ? packaged : { failed: packaged.step === "build" ? "build" : "package", ...packaged };
      if (packaged.ok) {
        flow.said = { text: "Packaged" };
        if (flow.changed?.step === "package") flow.changed = null;
      }
    });
  }

  // ---------------------------------------------------------------- stage 2: GitHub

  async function loadGithub() {
    if (!flow) return;
    const answer = await act(() => actions().github.status());
    if (!flow) return;
    flow.gh = answer.ok === false ? { failure: answer } : answer;
    if (!flow.gh.signedIn && !flow.gh.signing) flow.accountMode = false;
    if (!flow.gh.signedIn || !sameLogin(flow.signers?.login, flow.gh.login)) flow.signers = null;
    if (flow.gh.signedIn) await Promise.all([planName(), loadSigners()]);
    render();
    if (flow.gh.signedIn && flow.step === "catalog") void loadChecklist();
  }

  /**
   * Where Publish to GitHub would go, from the app (it alone knows which repository it published this project to):
   * { owner, name, page, mode: "new" | "replace" | "taken", suggestion, commit }.
   */
  let planned = null; // the elements the answer changes in place, so that the field keeps its caret
  async function planName() {
    const folder = flow.folder;
    const answer = await act(() => actions().github.checkName({ folder, name: flow.repoName ?? null }));
    if (!flow || flow.folder !== folder) return;
    flow.where = answer.ok === false ? { mode: "unknown", problem: [answer.message, answer.hint].filter(Boolean).join(" ") } : answer;
    if (answer.ok !== false) flow.repoName ??= answer.name;
    if (planned) showPlan(planned);
  }
  let typing = null;
  function typedName(value) {
    flow.repoName = value.trim();
    clearTimeout(typing);
    typing = setTimeout(() => void planName(), 400);
  }
  /** The words under the name, the button's, and what the button does, for the plan as it is now. */
  function showPlan({ about, source, go, what, count }) {
    const w = flow.where;
    const label = go.querySelector("span");
    if (source) source.textContent = w && w.name === flow.repoName ? namedWords(w) : "";
    if (!w || w.name !== flow.repoName) {
      about.textContent = w?.problem ?? "Looking at your repositories";
      go.ariaDisabled = "true";
      go.title = "Wait a moment";
      if (what) what.textContent = "";
      return;
    }
    const words = intoWords(w, count);
    about.textContent = words.about;
    label.textContent = words.label;
    if (what) what.textContent = words.what;
    const blocked = flow.busy ? "Wait for the work under way" : words.blocked;
    go.ariaDisabled = blocked ? "true" : "false";
    go.title = blocked ?? "";
  }

  /**
   * Sign commits with (EMU-366): { login, signer: { name, email, kind }, offered: [{ email, kind, primary? }], scope,
   * grant } for the account signed in, from the app; the address each commit of the app's is signed with.
   */
  async function loadSigners({ fresh = false } = {}) {
    const folder = flow.folder;
    const answer = await act(() => actions().github.signers({ folder, fresh }));
    if (!flow || flow.folder !== folder) return;
    flow.signers = answer.ok === false ? { failure: [answer.message, answer.hint].filter(Boolean).join(" ") } : answer;
  }
  function chooseSigner(email) {
    const folder = flow.folder;
    return busy("Choosing the address", async () => {
      const answer = await act(() => actions().github.chooseSigner({ email, folder }));
      if (!flow || flow.folder !== folder) return;
      if (answer.ok === false) flow.said = said(answer);
      else if (flow.signers && !flow.signers.failure) flow.signers = { ...flow.signers, signer: answer.signer };
    });
  }
  /** How the commit's author reads: Name <address>. */
  const signedWords = (signer) => `${signer.name} <${signer.email}>`;
  const SIGNER_KINDS = { noreply: "GitHub's private address", verified: "verified on GitHub", git: "git config, not verified on GitHub" };

  /** Sign commits with: a choice of the account's addresses, what the chosen one means, and how to list the others. */
  function signerPart() {
    const s = flow.signers;
    if (!s) return [field("Sign commits with", Object.assign(make("select", "input"), { disabled: true }), { hint: "Asking GitHub for your account's addresses" }).row];
    if (s.failure) return [field("Sign commits with", Object.assign(make("select", "input"), { disabled: true }), { problem: s.failure }).row];
    const select = make("select", "input");
    select.dataset.focus = "signer";
    for (const one of s.offered) {
      const kind = one.kind === "verified" ? ["verified on GitHub", one.primary ? "primary" : null, one.private ? "kept private" : null].filter(Boolean).join(", ") : SIGNER_KINDS[one.kind];
      // git config's address goes with git config's name: the option shows both.
      const label = one.kind === "noreply" ? `${SIGNER_KINDS.noreply}: ${one.email}` : one.kind === "git" && one.name ? `${one.name} <${one.email}> (${kind})` : `${one.email} (${kind})`;
      select.append(Object.assign(make("option", "", label), { value: one.kind === "noreply" ? "noreply" : one.email }));
    }
    select.value = s.signer.kind === "noreply" ? "noreply" : s.signer.email;
    if (flow.busy) select.disabled = true;
    select.addEventListener("change", () => void chooseSigner(select.value));
    const fell = s.signer.fallback === "gone" ? "The address chosen before is no longer one of your account's. " : s.signer.fallback === "unconfirmed" ? "The address chosen before can't be confirmed as your account's now. " : "";
    const hint = s.signer.kind === "noreply" ? `${fell}It shows no e-mail; GitHub counts the commits as ${s.login}'s. The name is ${s.signer.name}.` : s.signer.kind === "git" ? `GitHub has not verified it for ${s.login}: the commits may not count as yours there, and anyone can see the address. The name is git config's, ${s.signer.name}.` : s.signer.private ? "Your account keeps this address private on GitHub: if it blocks commits that show it, GitHub refuses the commit, and the emulator offers the private address. Anyone can see it on a commit." : "Anyone can see it on the commit, in your repository and in the catalog's.";
    const { row } = field("Sign commits with", select, { hint, about: "The author of the commits Publish makes: your repository's, and the one in your copy of the catalog. Kept for this account." });
    const out = [row];
    if (!s.scope) {
      const active = (flow.gh?.accounts ?? []).find((one) => one.active)?.login ?? null;
      const more = make("div", "publish-row");
      more.append(muted(`Your other verified addresses are not listed: GitHub CLI's sign-in may not read them. To list them, run ${s.grant} in a terminal${active && !sameLogin(active, s.login) ? ` while GitHub CLI uses ${s.login} (gh auth switch --user ${s.login})` : ""}, then Check again.`), button("btn", "Check again", () => busy("Asking GitHub for your addresses", () => loadSigners({ fresh: true })), { picture: "refresh" }));
      out.push(more);
    }
    return out;
  }

  /** Sign in with another account (or the first): gh auth login, which adds the account to GitHub CLI. */
  function signIn() {
    flow.signingAnother = (flow.gh?.accounts ?? []).length > 0;
    return busy("Asking GitHub for a code", async () => {
      const answer = await act(() => actions().github.signIn());
      if (answer.ok === false) {
        flow.said = said(answer);
        return;
      }
      if (answer.signedIn) {
        await loadGithub();
        return;
      }
      flow.gh = { ...(flow.gh ?? {}), signing: answer };
      // The wait goes on in the background; the step shows the code meanwhile.
      act(() => actions().github.waitSignIn()).then(async (done) => {
        if (!flow) return;
        flow.said = done.ok === false ? said(done) : { text: signedInWords(done) };
        if (done.ok !== false) flow.accountMode = false;
        await loadGithub();
      });
    });
  }

  /** What GitHub CLI on this computer uses after a sign-in here: said once. */
  function signedInWords(done) {
    if (done.kept) return `Signed in as ${done.login}. GitHub CLI on this computer has it too, and goes on using ${done.kept}.`;
    if (done.renewed && done.previous) return `Signed in as ${done.login}. GitHub CLI on this computer now uses its account ${done.login}, instead of ${done.previous}; you can switch it back when you sign out here.`;
    if (done.renewed) return `Signed in as ${done.login}. GitHub CLI's own sign-in for ${done.login} on this computer was renewed.`;
    if (done.previous) return `Signed in as ${done.login}. GitHub CLI on this computer now uses ${done.login} too, instead of ${done.previous}; you can switch it back when you sign out here.`;
    return `Signed in as ${done.login}. This also signed in GitHub CLI on this computer.`;
  }

  /** Use <login>: one of GitHub CLI's accounts on this computer, as it is. */
  function useExisting(login = null) {
    return busy("Asking GitHub", async () => {
      const answer = await act(() => actions().github.useExisting(login));
      if (answer.ok === false) flow.said = said(answer);
      else {
        flow.said = { text: `Signed in as ${answer.login}, GitHub CLI's account on this computer.` };
        flow.accountMode = false;
        // Another account: another place for the repository.
        flow.where = null;
        flow.pushed = null;
        flow.repoName = null;
      }
      await loadGithub();
    });
  }

  async function cancelSignIn() {
    await act(() => actions().github.cancelSignIn());
    await loadGithub();
  }

  function signOut() {
    const choice = { signOutCli: flow.signOutCli === true, switchBack: flow.switchBack === true };
    return busy("Signing out", async () => {
      const answer = await act(() => actions().github.signOut(choice));
      flow.signOutCli = undefined;
      flow.switchBack = false;
      // The flow answers { signedIn: false, … }, without "ok": a refusal has ok: false.
      if (answer.ok === false) flow.said = said(answer);
      else {
        const cli = answer.cliSignedOut ? " GitHub CLI on this computer was signed out of it too." : answer.switchedBack ? ` GitHub CLI on this computer uses ${answer.cliAccount ?? "its earlier account"} again.` : "";
        flow.said = { text: `Signed out here.${cli} GitHub keeps the access until you revoke GitHub CLI on github.com/settings/applications; that signs out GitHub CLI everywhere you use it with this account.` };
        flow.pick = null;
        flow.where = null;
        flow.pushed = null;
        flow.repoName = null;
      }
      await loadGithub();
    });
  }

  function pushToGithub(into = null) {
    // stale-check: by the status the flow has; the shell compares again, and the bytes, before it uploads.
    if (goBackIfStale()) return Promise.resolve();
    flow.confirmInto = false;
    flow.lines = [];
    flow.pushed = null;
    flow.upload = null;
    flow.canceling = false;
    flow.uploadNews = Date.now();
    const watch = setInterval(() => drawUpload(), 1000);
    flow.outcome = { step: "github", kind: "sending" };
    return busy("Publishing to GitHub", async () => {
      try {
        const answer = await act(() => actions().github.push({ folder: flow.folder, name: flow.repoName || null, into }));
        // GitHub refused the address (GH007): the app no longer signs with it; the choice is read again (EMU-366).
        if (answer.code === "email_private") await loadSigners();
        flow.outcome = outcomeOf("github", answer);
        // Try again publishes the same way: into the person's own repository when they confirmed that (catalog-update).
        if (flow.outcome) flow.outcome.into = into;
        if (staleRefusal(answer)) return;
        if (answer.ok === false) flow.said = flow.outcome ? null : said(answer);
        else {
          flow.pushed = answer;
          flow.repoName = answer.name;
          flow.where = { owner: answer.owner, name: answer.name, page: answer.page, mode: "replace", suggestion: null, commit: answer.commit };
          const links = Array.isArray(answer.skipped) && answer.skipped.length ? ` Left out, as links: ${answer.skipped.slice(0, 5).join(", ")}${answer.skipped.length > 5 ? ", …" : ""}.` : "";
          const removed = answer.removed ? ` ${answer.removed === 1 ? "1 file" : `${answer.removed} files`} the project doesn't have deleted.` : "";
          flow.outcome.notes = `${links}${removed}`.trim() || null;
          flow.reveal = true;
        }
      } finally {
        clearInterval(watch);
        if (flow) flow.upload = null;
        if (flow?.outcome?.kind === "sending") flow.outcome = null;
      }
    }).then(afterStale);
  }

  function sendToCatalog() {
    if (goBackIfStale()) return Promise.resolve();
    flow.lines = [];
    flow.requested = null;
    const list = flow.checklist;
    flow.outcome = { step: "catalog", kind: "sending", started: Date.now() };
    flow.pull = null;
    const ticker = setInterval(() => {
      const line = document.getElementById("publish-waited");
      if (line && flow?.outcome?.kind === "sending") line.textContent = waitedWords(flow.outcome);
    }, 1000);
    return busy("Sending to the catalog", async () => {
      const changelog = flow.entry?.exists && flow.entry.for === entryKey() ? (flow.changelog ?? "") : null;
      const other = list?.busy === false && flow.otherCatalog === list.catalog ? { otherCatalog: list.catalog } : {};
      let answer;
      try {
        answer = await act(() => actions().github.request({ folder: flow.folder, catalog: flow.catalog, ticked: (list?.boxes ?? []).filter((one) => flow.ticks?.has(one)), ai: flow.ai, ...(needsNote(flow.ai) ? { aiNote: flow.aiNote ?? "" } : {}), changelog, ...other }));
      } finally {
        clearInterval(ticker);
        if (flow?.outcome?.kind === "sending") flow.outcome = null;
      }
      if (answer.code === "email_private") await loadSigners();
      flow.outcome = outcomeOf("catalog", answer);
      if (staleRefusal(answer)) return;
      if (answer.ok === false) flow.said = flow.outcome ? null : said(answer);
      else {
        flow.requested = answer;
        flow.entry = null;
        flow.editing = false;
        flow.said = null;
        flow.reveal = true;
      }
    }).then(afterStale);
  }

  // ---------------------------------------------------------------- EMU-360: what came of a send

  /** True while Publish to GitHub or Send to catalog waits for GitHub: the dialog is not closed then. */
  const sending = () => flow?.outcome?.kind === "sending" && Boolean(flow.busy);

  /**
   * What a send came to, drawn in place of the step's form (flow.outcome): { step, kind: "done" | "failed" | "stale",
   * answer }; null for what the form says itself (a refusal for a fresh click, a stopped upload, a project changed
   * since the check, which goes back to that step).
   */
  function outcomeOf(step, answer) {
    if (!answer || answer.again) return null;
    if (answer.ok !== false) return { step, kind: "done", answer };
    if (changedCodes.has(answer.code) || answer.code === "canceled" || answer.code === "usage" || answer.code === "busy") return null;
    if (answer.code === "changed_since_upload") return { step, kind: "stale", answer };
    return { step, kind: "failed", answer };
  }

  /** The request this app last opened for the project, as its record has it, while it names the commit on GitHub now. */
  // The project's record is the project's file: it decides nothing alone (a project can arrive with one). It counts
  // only when it names the commit on GitHub now (the app's own record of the push) and the catalog the step sends to,
  // and GitHub says the pull request is still open (github.pull); a closed or merged one is said as such.
  function keptRequest() {
    const noted = flow.status?.github?.request;
    const repo = flow.where?.mode === "replace" ? flow.where : null;
    const catalog = String(flow.catalog ?? flow.status?.catalog ?? "").toLowerCase();
    if (!noted?.url || !repo?.commit || noted.commit !== repo.commit || String(noted.catalog ?? "").toLowerCase() !== catalog) return null;
    return { url: noted.url, catalog: noted.catalog, created: noted.created !== false };
  }

  /** What GitHub says of the noted pull request (github.pull), asked once for each one: the state, or null while asked. */
  let pullAsked = null;
  function pullOf(kept) {
    const known = flow.pull;
    if (known?.url === kept.url) return known;
    if (pullAsked === kept.url) return null;
    pullAsked = kept.url;
    const folder = flow.folder;
    void act(() => actions().github.pull({ folder })).then((answer) => {
      pullAsked = null;
      if (!flow || flow.folder !== folder) return;
      flow.pull = answer?.ok === false ? { url: kept.url, state: "unknown" } : { url: kept.url, state: answer.state, noted: answer.noted };
      render();
    });
    return null;
  }

  /** The outcome the step shows now: the one of its last send, or, for Send to catalog, the request it has sent. */
  function shownOutcome(step) {
    if (flow.outcome?.step === step) return flow.outcome;
    if (step !== "catalog" || flow.editing || !flow.gh?.signedIn) return null;
    const kept = keptRequest();
    if (!kept) return null;
    const pull = pullOf(kept);
    if (!pull) return { step, kind: "checking" };
    if (pull.state === "open" && pull.noted === flow.where.commit) return { step, kind: "done", answer: kept };
    if (pull.state === "merged" || pull.state === "closed") return { step, kind: pull.state, answer: kept };
    return null;
  }

  /** People's words for a refusal of GitHub's: { title, text }, by its code (and for which step). */
  function failureWords(step, answer) {
    const told = [answer.message, answer.hint].filter(Boolean).join(" ");
    const login = flow.gh?.login;
    switch (answer.code) {
      case "network":
        return { title: "No connection to GitHub", text: "GitHub could not be reached. Check the internet connection, then try again." };
      case "unauthorized":
      case "account_gone":
      case "changed_outside":
        return { title: "Your GitHub sign-in has expired", text: `GitHub no longer accepts the sign-in${login ? ` of ${login}` : ""}. Sign in again, then ${step === "catalog" ? "send the request" : "publish"} again.`, signIn: true };
      case "rate_limited":
        return { title: "GitHub's limit is reached for now", text: `GitHub takes only so many requests an hour from one account. ${answer.hint ?? "Try again in a few minutes."}` };
      case "forbidden": {
        if (step !== "catalog") return { title: "GitHub refused the upload", text: told };
        const where = answer.where ?? {};
        if (where.at === "pull") return { title: "The catalog refused the pull request", text: `GitHub did not let your account open or change a pull request in the catalog. ${told}` };
        if (where.direct) return { title: "No access to the catalog's branch", text: `Your account may write to the catalog, but GitHub refused this branch. ${told}` };
        if (where.at === "push") return { title: "No access to your copy of the catalog", text: `The pull request comes from a copy of the catalog on your account (a fork), and GitHub refused the write to it. ${told}` };
        return { title: "GitHub refused it", text: told };
      }
      case "fork_not_allowed":
        return { title: "The catalog can't be forked", text: `The pull request comes from a copy of the catalog on your account (a fork), and GitHub does not make one. ${told}` };
      case "catalog_closed":
        return { title: "The catalog can't be reached", text: told };
      case "catalog_empty":
        return { title: "The catalog has no files yet", text: told };
      case "timeout":
        return answer.write
          ? { title: "GitHub did not answer in time", text: `${step === "catalog" ? "The request" : "The upload"} may have reached GitHub all the same. Check again: the emulator looks at what GitHub has first, and makes nothing twice.`, again: "Check again" }
          : { title: "GitHub did not answer in time", text: "Nothing was changed on GitHub. Try again in a moment." };
      case "gh_failed":
        return { title: "GitHub CLI did not run", text: told };
      case "token_unreadable":
        return { title: "GitHub CLI could not give your sign-in", text: told, signIn: true };
      case "fork_pending":
        return { title: "GitHub is still making your copy of the catalog", text: told };
      case "email_private":
        return { title: "GitHub keeps that address private", text: `Your account blocks commits that would show the e-mail address they are signed with. Sign them with GitHub's private address instead: it shows no e-mail, and the commits still count as ${login ?? "yours"}'s.`, privateAddress: true };
      default:
        return { title: step === "catalog" ? "The pull request was not opened" : "Nothing was published", text: told };
    }
  }

  /**
   * The facts of an outcome screen (EMU-360): one grid for every row, the labels in the first column (as wide as the
   * longest), each value from the same left edge in the second, truncated with an ellipsis, a row's action (Copy) in
   * the third at the right edge; every row the same height. rows: [{ label, value: Node, action?: Node }].
   */
  function factRows(rows) {
    const list = make("ul", "publish-facts");
    for (const row of rows) {
      const item = make("li");
      const value = make("span", "value");
      value.append(row.value);
      if (row.value?.textContent) value.title = row.value.textContent;
      item.append(make("b", "label", row.label), value, row.action ?? make("span", "action"));
      list.append(item);
    }
    return list;
  }
  /** A small Copy button for a fact's value. */
  function copyButton(text, label) {
    const copy = button("icon-btn small", "", () => copied(copy, text), { picture: "copy", title: "Copy" });
    copy.ariaLabel = label;
    copy.classList.add("action");
    return copy;
  }

  /** How long a send has waited, said: "Waiting for GitHub: 12 s". */
  const waitedWords = (o) => `Waiting for GitHub: ${Math.max(0, Math.round((Date.now() - (o.started ?? Date.now())) / 1000))} s`;

  /** A state of its own in place of the step's form (EMU-360): its picture, title, words, link and buttons. */
  function outcomeScreen({ kind, picture = null, title, text = null, details = [], actions: buttons = [] }) {
    const box = make("div", `publish-outcome ${kind}`);
    box.setAttribute("role", kind === "failed" ? "alert" : "status");
    if (kind === "sending") box.append(make("span", "publish-spinner"));
    else if (picture) {
      const mark = make("span", "mark");
      mark.innerHTML = icon(picture);
      box.append(mark);
    }
    box.append(make("h3", "", title));
    if (text) box.append(make("p", "", text));
    for (const one of details) box.append(one);
    if (buttons.length) {
      const row = make("div", "publish-row");
      row.append(...buttons);
      box.append(row);
    }
    return box;
  }

  /** The outcome of Publish to GitHub or Send to catalog, drawn (outcome as shownOutcome gives it). */
  function outcomePart(o) {
    const back = () => button("btn", "Back", () => {
      if (o.step === "catalog") flow.editing = true;
      flow.outcome = null;
      render();
    });
    if (o.kind === "sending" && o.step === "github") return outcomeScreen({ kind: "sending", title: "Publishing to GitHub…", text: "Uploading the project's files, then reading them back. Keep the window open.", details: [uploadPart()] });
    if (o.kind === "sending") {
      // No Cancel: what GitHub was asked is done or not, either way. The wait has a bound the person sees: each call
      // that GitHub does not answer ends after 2 minutes (gh.mjs REQUEST_TIMEOUT_MS), and the screen then says so.
      const waited = make("p", "publish-muted", waitedWords(o));
      waited.id = "publish-waited";
      return outcomeScreen({ kind: "sending", title: "Opening the pull request…", text: flow.lines.at(-1) ?? "Comparing the project with GitHub", details: [waited, muted("If GitHub stops answering, the emulator stops waiting after 2 minutes without an answer and says what to do.")] });
    }
    if (o.kind === "checking") {
      return outcomeScreen({
        kind: "sending",
        title: "Reading the pull request on GitHub…",
        text: "Whether the request sent from here is still open.",
        actions: [button("btn", "Back", () => {
          flow.editing = true;
          render();
        })],
      });
    }
    if (o.kind === "merged" || o.kind === "closed") {
      const link = factRows([{ label: "Pull request", value: githubLink(o.answer.url, o.answer.url.replace(/^https:\/\//, "")), action: copyButton(o.answer.url, "Copy the address") }]);
      return outcomeScreen({
        kind: "done",
        picture: o.kind === "merged" ? "checkmark-circle-fill" : "alert",
        title: o.kind === "merged" ? "The pull request was merged" : "The pull request was closed",
        text: o.kind === "merged" ? "The catalog has taken the app. A new version goes in a new pull request." : "It was closed without being merged. Read why on GitHub; you can send the app again.",
        details: [link],
        actions: [githubLink(o.answer.url, "Open the pull request", "btn", "link"), button("btn solid", "Send again", () => {
          flow.editing = true;
          render();
        })],
      });
    }
    if (o.kind === "stale") {
      return outcomeScreen({
        kind: "failed",
        picture: "alert",
        title: "The project changed since it was published",
        text: "GitHub has an older copy of its files, and the catalog builds what GitHub has. Publish the project again, then send the request.",
        actions: [button("btn solid", "Publish again", () => go("github"), { picture: "upload" }), back()],
      });
    }
    if (o.kind === "failed") {
      const words = failureWords(o.step, o.answer);
      const done = o.answer.done;
      const details = [];
      if (done?.fork || done?.branch) {
        const made = [done.fork ? `your copy of the catalog, github.com/${done.fork}` : null, done.branch ? `the branch ${done.branch}` : null].filter(Boolean).join(", and ");
        details.push(make("p", "publish-muted", `Made on GitHub so far: ${made}. The pull request is not open yet. Try again goes on from there: nothing is made twice.`));
      }
      const again = o.step === "catalog" ? () => sendToCatalog() : () => pushToGithub(o.into ?? null);
      const first = words.signIn
        ? button("btn solid", "Sign in again", () => {
            flow.outcome = null;
            flow.accountMode = true;
            go("github");
          })
        : words.privateAddress
          ? button("btn solid", o.step === "catalog" ? "Sign with the private address and send" : "Sign with the private address and publish", () => void chooseSigner("noreply").then(() => (flow.signers?.signer?.kind === "noreply" ? again() : render())), { picture: "refresh" })
          : button("btn solid", words.again ?? "Try again", again, { picture: "refresh" });
      return outcomeScreen({ kind: "failed", picture: "alert", title: words.title, text: words.text, details, actions: [first, back()] });
    }
    const a = o.answer;
    if (o.step === "github") {
      const commitPage = `${a.page}/commit/${a.commit}`;
      const list = factRows([
        { label: "Repository", value: githubLink(a.page, a.page.replace(/^https:\/\//, "")), action: copyButton(a.page, "Copy the address") },
        { label: "Commit", value: githubLink(commitPage, a.commit), action: copyButton(a.commit, "Copy the commit") },
        { label: "Checked", value: make("span", "", `${a.files} files on GitHub, the same as sent`) },
      ]);
      const details = [list];
      if (o.notes) details.push(muted(o.notes));
      return outcomeScreen({
        kind: "done",
        picture: "checkmark-circle-fill",
        title: a.unchanged ? "Up to date on GitHub" : "Published to GitHub",
        text: a.unchanged ? "GitHub has every file as the project has it: nothing had changed." : "The files are in your public repository, in one commit. Next, the request to the catalog.",
        details,
        actions: [button("btn solid", "Send to catalog", () => go("catalog"), { picture: "apps-add" }), back()],
      });
    }
    const link = factRows([{ label: "Pull request", value: githubLink(a.url, a.url.replace(/^https:\/\//, "")), action: copyButton(a.url, "Copy the address") }]);
    const edit = button("link-btn", "Change it and send again", () => {
      flow.editing = true;
      flow.outcome = null;
      render();
    });
    return outcomeScreen({
      kind: "done",
      picture: "checkmark-circle-fill",
      // `unchanged`: the open request had these changes already (sent before, its answer perhaps lost): sent, not updated.
      title: a.created || a.unchanged ? "Pull request sent" : "Pull request updated",
      text: a.unchanged && !a.created ? "The open pull request has all of it already, the file and the text: nothing new was sent. The catalog's checks and the review go on there." : a.created || a.unchanged ? "The catalog's checks run on GitHub, then a moderator reviews the app. GitHub tells you about both." : "The open pull request has the new changes: the catalog's checks run on it again.",
      details: [link],
      actions: [githubLink(a.url, "Open the pull request", "btn", "link"), button("btn solid", "Done", close), edit],
    });
  }

  /** A link to a page of github.com, opened in the browser: quiet in a list, or a button (`className`). */
  function githubLink(href, text, className = "quiet-link", picture = null) {
    const a = make("a", className);
    if (picture) a.innerHTML = icon(picture);
    a.append(make("span", "", text));
    if (/^https:\/\/github\.com\//.test(href)) {
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    return a;
  }

  // ---------------------------------------------------------------- drawing

  const LEADS = {
    texts: "What the catalog shows on the app's card and page.",
    screenshots: "The first front screenshot is the app's cover.",
    readme: "The front page of the app's repository.",
    license: "The catalog takes open source apps only. Choose how others may use your code.",
    files: "What goes into the public repository.",
    check: "Builds the app, checks its types, then runs the catalog's checks.",
    package: "Builds the app and writes the catalog's files. Nothing is sent.",
    github: "The app's public repository, on your account.",
    catalog: "A pull request that adds the app to the catalog, or updates it there.",
  };

  let footer = null; // the footer of the drawing, redrawn alone as the person types

  function render() {
    if (!flow || root.hidden) return;
    const status = flow.status;
    const head = make("header", "publish-head");
    const titles = make("div", "publish-titles");
    const title = make("h2", "", `Publish ${status?.name ?? flow.name ?? ""}`.trim());
    title.id = "publish-title";
    const second = steps && flow.step && steps.STEPS.find((one) => one.id === flow.step)?.stage === 2;
    titles.append(title, make("p", "", second ? "Your repository on GitHub, then the request to the catalog." : "Everything is prepared here. Nothing is sent yet."));
    const shut = button("icon-btn", "", close, { picture: "cross", title: "Close (Esc)", disabled: sending() ? "Wait until GitHub has answered" : null });
    shut.ariaLabel = "Close";
    head.append(titles, shut);

    const body = make("div", "publish-body");
    const pane = make("section", "publish-pane");
    if (!status || !steps) {
      pane.append(make("p", "publish-lead", flow.said?.text ?? "Reading the project"));
      body.append(make("nav", "publish-rail"), pane);
    } else {
      body.append(rail(), pane);
      const step = steps.STEPS.find((one) => one.id === flow.step);
      const top = make("div", "publish-pane-head");
      const words = make("div", "words");
      const named = STEP_HEADS[flow.step]?.() ?? null;
      words.append(make("h3", "", named?.title ?? step.title), make("p", "", named?.lead ?? LEADS[flow.step] ?? ""));
      top.append(words);
      const extra = HEAD_ACTIONS[flow.step]?.();
      if (extra) top.append(extra);
      // What a send came to (EMU-360): its own screen, the step's form hidden.
      const outcome = (flow.step === "github" || flow.step === "catalog") && flow.gh?.signedIn ? shownOutcome(flow.step) : null;
      if (outcome) {
        pane.classList.add("outcome");
        pane.append(outcomePart(outcome));
      } else pane.append(top, ...(PANES[flow.step]?.() ?? []));
    }
    footer = foot();
    dialog.replaceChildren(head, body, footer);
    // What a step just made (the repository, the pull request) is brought into view once.
    if (flow.reveal) {
      flow.reveal = false;
      pane.querySelector(".publish-result")?.scrollIntoView?.({ block: "nearest" });
    }
  }

  /** The steps, by stage: done ones ticked, the current one lit, those that wait for an earlier one dimmed. */
  function rail() {
    const nav = make("nav", "publish-rail");
    nav.ariaLabel = "Steps";
    let list = null;
    let stage = null;
    steps.railStates(flow.status, flow.step).forEach((one, i) => {
      if (one.stage !== stage) {
        stage = one.stage;
        nav.append(make("p", "publish-stage", steps.STAGE_TITLES[stage]));
        list = make("ol");
        nav.append(list);
      }
      const item = make("li");
      const pick = make("button", `publish-step ${one.state}${one.done ? " done" : ""}${one.state === "current" ? " on" : ""}`);
      pick.type = "button";
      pick.ariaCurrent = one.state === "current" ? "step" : "false";
      const mark = make("span", "mark");
      if (one.done && one.state !== "current") mark.innerHTML = icon("checkmark-circle-fill");
      else mark.textContent = String(i + 1);
      pick.append(mark, make("span", "", one.title));
      if (!one.reachable) {
        pick.ariaDisabled = "true";
        pick.title = `After ${one.waitsFor}`;
      }
      pick.addEventListener("click", () => one.reachable && one.id !== flow.step && go(one.id));
      item.append(pick);
      list.append(item);
    });
    return nav;
  }

  /**
   * The footer: on the left the one line of what is going on or what came of it; Back and the step's button on the
   * right, and beside them, while Next is off, why (EMU-364: in words, not only in the button's tooltip, and also when
   * the line on the left says something else).
   */
  function foot() {
    const box = make("footer", "publish-foot");
    if (!flow.status || !steps) {
      box.append(make("span", `publish-said${flow.busy ? " working" : flow.said?.failed ? " failed" : ""}`, flow.busy ?? flow.said?.text ?? ""));
      return box;
    }
    // Publish to GitHub has its own buttons (an account, then Publish, then Send to catalog): no Next beside them.
    const why = flow.step === "github" ? null : blocked();
    // Next is drawn on every step but Publish to GitHub, Send to catalog (Done) and Build and package before it is done.
    const withNext = !["github", "catalog"].includes(flow.step) && !(flow.step === "package" && !isDone("package"));
    const line = flow.busy ? { kind: "working", text: flow.busy } : flow.said ? { kind: flow.said.failed ? "failed" : "good", text: flow.said.text } : why && !withNext ? { kind: "why", text: why } : { kind: "", text: "" };
    box.append(make("span", `publish-said ${line.kind}`.trim(), line.text));
    // A send's screen has its own buttons (EMU-360).
    if ((flow.step === "github" || flow.step === "catalog") && flow.gh?.signedIn && shownOutcome(flow.step)) return box;
    // While work is under way the line on the left says so; else the reason Next is off stands beside it.
    if (withNext && why && !flow.busy) box.append(make("span", "publish-why", why));
    const previous = steps.previousStep(flow.step);
    box.append(button("btn", "Back", () => go(previous), { disabled: previous ? (flow.busy ? "Wait for the work under way" : null) : "This is the first step" }));
    if (flow.step === "package" && !isDone("package")) {
      box.append(button("btn solid", "Build and package", buildAndPackage, { picture: "box", disabled: flow.busy ? "Wait for the work under way" : null }));
    } else if (flow.step === "catalog") {
      box.append(button("btn solid", "Done", close));
    } else if (flow.step === "github") {
      // The step's own buttons lead on.
    } else {
      box.append(button("btn solid", "Next", next, { disabled: why }));
    }
    return box;
  }
  /** The footer again, for what typing changes: the reason and Next. */
  function refreshFoot() {
    if (!footer || !flow) return;
    const fresh = foot();
    footer.replaceWith(fresh);
    footer = fresh;
  }

  const section = (title, ...parts) => {
    const box = make("div", "publish-group");
    if (title) box.append(make("h4", "", title));
    box.append(...parts);
    return box;
  };
  const muted = (text) => make("p", "publish-muted", text);
  const inProject = (rel) => (rel ? `${flow.folder}${flow.folder.includes("\\") ? "\\" : "/"}${rel.split("/").join(flow.folder.includes("\\") ? "\\" : "/")}` : flow.folder);
  async function openFile(rel) {
    const answer = await act(() => actions().open(inProject(rel)));
    flow.said = answer === false || answer.ok === false ? { failed: !answer.again, text: answer.again ? "Click again" : `${rel} could not be opened` } : null;
    render();
  }
  async function reveal(rel) {
    await act(() => actions().reveal(inProject(rel)));
  }

  /**
   * A field of a form: its label and count above, the control, one line below (a hint, or what is wrong). `about`: what
   * the field is for, under the label and above the control, where it is read before typing (Application Info).
   */
  function field(label, control, { count = null, hint = "", about = null, problem = null, className = "" } = {}) {
    const row = make(control.tagName === "BUTTON" || control.tagName === "DIV" ? "div" : "label", `publish-field${className ? ` ${className}` : ""}${problem ? " bad" : ""}${about ? " described" : ""}`);
    const top = make("span", "label");
    top.append(make("b", "", label));
    const counter = make("span", "count", count ?? "");
    top.append(counter);
    const below = make("span", "hint", problem ?? hint);
    row.append(top, ...(about ? [make("span", "about", about)] : []), control, below);
    return { row, counter, below, set({ count: c, hint: h, problem: p }) {
      counter.textContent = c ?? "";
      below.textContent = p ?? h ?? "";
      row.classList.toggle("bad", Boolean(p));
    } };
  }
  const counted = (value, [min, max]) => `${[...(value ?? "")].length} / ${max}${min > 1 ? `, at least ${min}` : ""}`;

  /** The icons: the shared block, Front and Back with their requirements; Save icons and Cancel while one is new. */
  function iconPart() {
    const box = make("div", "publish-icon");
    const model = iconModel();
    const words = make("div", "words");
    words.append(make("b", "", "Icons"), make("span", "about", "In the BUSY Bar's APPS menu and on the catalog's card."));
    box.append(words);
    if (!model) return box;
    const busyNow = flow.busy ? "Wait for the work under way" : null;
    box.append(iconBlock().render(model, { onChange: () => render(), busy: busyNow }));
    if (iconBlock().hasDraft(model)) {
      const row = make("div", "publish-row icon-save");
      row.append(
        button("btn solid", "Save icons", () => saveIcon(), { picture: "checkmark", disabled: busyNow }),
        button("btn", "Cancel", () => ((flow.icons = null), render())),
        make("span", "publish-muted", "Not saved yet: Save icons, or Next, saves them."),
      );
      box.append(row);
    }
    return box;
  }

  /** The BUSY icon each category of the catalog is shown with (icons/busy). */
  const CATEGORY_ICONS = { productivity: "hourglass", clocks: "clock", "info-feeds": "globe", social: "user", "dev-monitoring": "code", music: "music", art: "palette", games: "gamepad", "smart-home": "smart-home", utilities: "wrench" };
  const capital = (text) => String(text ?? "").replace(/^./, (c) => c.toUpperCase());

  /**
   * The category: a field that shows the chosen one's icon and name, and opens a list of all ten, each its icon, its
   * name and what goes there, in two columns under the name and the category (all ten seen at once, also at 900×650).
   */
  function categoryPicker(categories, chosen, pick) {
    const current = categories.find((one) => one.id === chosen) ?? null;
    const open = flow.picking === true;
    const button = make("button", `input publish-select${current ? "" : " empty"}${open ? " open" : ""}`);
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", String(open));
    button.dataset.part = "category";
    button.innerHTML = current ? icon(CATEGORY_ICONS[current.id] ?? "apps") : "";
    button.append(make("span", "value", current?.name ?? "Choose a category"));
    const caret = make("span", "caret");
    caret.innerHTML = icon("chevron-down");
    button.append(caret);
    button.addEventListener("click", (e) => {
      e.stopPropagation?.();
      flow.picking = !open;
      render();
      if (!flow.picking) return;
      // The whole list in view (the pane scrolls), the chosen one focused for the arrows.
      dialog.querySelector(".publish-options")?.scrollIntoView?.({ block: "nearest" });
      dialog.querySelector(".publish-options [aria-selected='true'], .publish-options button")?.focus?.({ preventScroll: true });
    });
    if (!open) return { button, list: null };
    const list = make("div", "publish-options");
    list.setAttribute("role", "listbox");
    list.ariaLabel = "Category";
    const options = [];
    for (const one of categories) {
      const option = make("button", `option${one.id === chosen ? " on" : ""}`);
      option.type = "button";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(one.id === chosen));
      option.dataset.category = one.id;
      option.innerHTML = icon(CATEGORY_ICONS[one.id] ?? "apps");
      const words = make("span", "words");
      words.append(make("b", "", one.name), make("span", "", capital(one.about)));
      option.append(words);
      option.addEventListener("click", (e) => {
        e.stopPropagation?.();
        pick(one.id);
        dialog.querySelector(".publish-select")?.focus?.();
      });
      options.push(option);
      list.append(option);
    }
    // The arrows move through the list as in a system's list: left and right between the columns.
    list.addEventListener("keydown", (e) => {
      const at = options.indexOf(document.activeElement);
      const by = { ArrowDown: 2, ArrowUp: -2, ArrowRight: 1, ArrowLeft: -1, Home: -99, End: 99 }[e.key];
      if (by === undefined || at < 0) return;
      e.preventDefault?.();
      options[Math.max(0, Math.min(options.length - 1, at + by))].focus();
    });
    return { button, list };
  }

  /** The README's rows of How to use, as the README holds them (how-to-use.mjs); [] before the modules are there. */
  function rowsOfReadme(config) {
    if (!howToUse || !config || config.mode === "file") return [];
    return config.mode === "markdown" ? howToUse.read(config.markdown ?? "") : howToUse.rowsOf(config.usage ?? "");
  }

  /** Whether writing `config` would put another text over the project's README.md that is used as it is (EMU-365). */
  function replacesKept(config) {
    const r = flow.status?.readme;
    if (!r || r.state !== "kept" || !config || config.mode === "file") return false;
    return readme.readmeMarkdown(config, r.facts) !== String(r.facts.file ?? "").replace(/\r\n?/g, "\n");
  }

  /** The question before the README made here replaces the project's README.md that was used as it is. */
  function readmeQuestion() {
    const ask = flow.readmeAsk;
    if (!ask) return [];
    const box = make("div", "publish-ask");
    box.setAttribute("role", "alertdialog");
    box.append(make("b", "", "Replace README.md?"), make("span", "", "README.md was used as it is. The README made here is written in its place, and the file you have goes to .busy/removed/ in the project's folder."));
    const row = make("div", "publish-row");
    row.append(
      button("btn solid", "Replace README.md", async () => {
        if (await saveReadme(ask.save, { replace: true })) {
          const to = steps.nextStep("readme");
          if (to && flow) await go(to, { saved: true });
        }
      }),
      button("btn", "Keep README.md as it is", () => {
        flow.readmeAsk = null;
        useFile(true);
      }),
    );
    box.append(row);
    return [box];
  }

  /** The switch "Use the project's README.md as it is": on, the step shows the file and writes nothing; off, the editor. */
  function useFile(on) {
    const d = flow.drafts;
    const file = flow.status.readme.facts.file ?? "";
    // Off: the file's own text in Markdown, so that nothing of it is lost and nothing is written unless it is changed.
    d.readme = on ? { ...d.readme, mode: "file" } : { ...d.readme, mode: "markdown", markdown: file.replace(/\r\n?/g, "\n") };
    d.rows = rowsOfReadme(d.readme);
    d.readmeDirty = true;
    flow.said = null;
    render();
  }

  /** The switch's row: on or off, and when there is no file to use, off with the reason beside it. */
  function useFilePart() {
    const r = flow.status.readme;
    const d = flow.drafts;
    const box = make("label", "publish-keep");
    const tick = make("input", "switch");
    tick.type = "checkbox";
    tick.checked = d.readme.mode === "file";
    tick.dataset.part = "readme-keep";
    const reason = r.keep_problem && d.readme.mode !== "file" ? r.keep_problem : null;
    tick.disabled = Boolean(reason) || Boolean(flow.busy);
    tick.addEventListener("change", () => useFile(tick.checked));
    const words = make("span", "words");
    words.append(make("b", "", "Use the project's README.md as it is"), make("span", "", reason ? `${reason}.` : d.readme.mode === "file" ? "Nothing is written: GitHub shows the file as it is below. What the step would check is said as hints." : "For a README you wrote elsewhere: the emulator does not write or change it."));
    box.append(tick, words);
    if (reason) box.classList.add("off");
    return box;
  }

  /** A control's chip, drawn as the catalog draws it (Figma, Control badge): its picture and its name. */
  const CONTROL_PICTURES = { Start: "start", "Wheel turn": "wheel-turn", "Wheel press": "wheel-press", Back: "back" };
  function controlChip(control) {
    const chip = make("span", `control-chip${control ? "" : " none"}`);
    if (control) {
      const picture = make("img");
      picture.src = `/emulator/icons/controls/${CONTROL_PICTURES[control]}.svg`;
      picture.alt = "";
      chip.append(picture);
    }
    chip.append(make("span", "", control ?? "Choose"));
    return chip;
  }

  /**
   * How to use, in the README step: rows of a control chip and one short sentence; a row's chip changes its control,
   * rows are added by their chip, moved and removed. Optional (EMU-364); rows written are checked. `changed()` is
   * called after each change.
   */
  function howToUseEditor(d, changed) {
    const box = make("div", "publish-field publish-howto described");
    const top = make("span", "label");
    const counter = make("span", "count");
    top.append(make("b", "", "How to use"), counter);
    const list = make("ol", "rows");
    const add = make("div", "add");
    const below = make("span", "hint");
    box.append(top, make("span", "about", "Optional. Each control your app answers to, and what it does, in a few words. It helps people reading the README; the catalog does not show it yet."), list, add, below);
    const busyNow = () => (flow.busy ? "Wait for the work under way" : null);
    function set() {
      counter.textContent = `${d.rows.length} / ${howToUse.MAX_ROWS}`;
      // No rows: the section is optional, and the README goes on without it (EMU-364). Rows of the fields are checked;
      // those read from the Markdown are said as a hint.
      const fields = d.readme.mode !== "markdown";
      const problem = fields ? howToUse.sectionProblem(d.rows) : null;
      const hint = fields || !d.rows.length ? null : howToUse.sectionHint(d.rows);
      below.textContent = problem ?? hint ?? (d.rows.length ? "" : "No rows: the README goes on without How to use.");
      box.classList.toggle("bad", Boolean(problem));
    }
    function redraw(focus = null) {
      list.replaceChildren();
      d.rows.forEach((row, i) => {
        const item = make("li", "howto-row");
        const pick = make("span", "chip-pick");
        const select = make("select");
        select.ariaLabel = `Control of row ${i + 1}`;
        if (!row.control) select.append(Object.assign(make("option", "", "Choose"), { value: "" }));
        for (const one of howToUse.CONTROLS) select.append(Object.assign(make("option", "", one), { value: one }));
        select.value = row.control ?? "";
        select.addEventListener("change", () => {
          row.control = select.value || null;
          pick.replaceChildren(controlChip(row.control), select);
          changed();
        });
        pick.append(controlChip(row.control), select);
        const text = make("input", "input");
        text.type = "text";
        text.value = row.text;
        text.maxLength = howToUse.MAX_TEXT;
        text.placeholder = { Start: "Starts or pauses the timer", "Wheel turn": "Changes the length", "Wheel press": "Skips to the next screen", Back: "Ends the session" }[row.control] ?? "What it does";
        text.ariaLabel = `What ${row.control ?? "the control"} does`;
        text.dataset.row = String(i);
        text.addEventListener("input", () => {
          row.text = text.value;
          changed();
        });
        const tools = make("span", "tools");
        const move = (by) => {
          const [taken] = d.rows.splice(i, 1);
          d.rows.splice(i + by, 0, taken);
          redraw(i + by);
          changed();
        };
        const up = button("icon-btn small", "", () => move(-1), { picture: "chevron-up", title: "Up", disabled: i === 0 ? "It is the first" : busyNow() });
        up.ariaLabel = "Up";
        const down = button("icon-btn small", "", () => move(1), { picture: "chevron-down", title: "Down", disabled: i === d.rows.length - 1 ? "It is the last" : busyNow() });
        down.ariaLabel = "Down";
        const away = button("icon-btn small", "", () => {
          d.rows.splice(i, 1);
          redraw();
          changed();
        }, { picture: "trash", title: "Remove", disabled: busyNow() });
        away.ariaLabel = "Remove";
        tools.append(up, down, away);
        item.append(pick, text, tools);
        list.append(item);
      });
      add.replaceChildren(make("span", "add-label", d.rows.length ? "Add" : "Add a control"));
      for (const control of howToUse.CONTROLS) {
        const one = make("button", "chip-add");
        one.type = "button";
        one.title = `Add a row for ${control}`;
        one.ariaDisabled = d.rows.length >= howToUse.MAX_ROWS ? "true" : "false";
        one.append(controlChip(control));
        one.addEventListener("click", (e) => {
          e.stopPropagation?.();
          if (one.ariaDisabled === "true") return;
          d.rows.push({ control, text: "" });
          redraw(d.rows.length - 1);
          changed();
        });
        add.append(one);
      }
      set();
      if (focus !== null) list.querySelector(`input[data-row="${focus}"]`)?.focus?.();
    }
    redraw();
    return { box, set, redraw };
  }

  /** The question before a license file of the project is replaced by the one the person chose. */
  function licenseQuestion() {
    const ask = flow.licenseAsk;
    if (!ask) return [];
    const box = make("div", "publish-ask");
    box.setAttribute("role", "alertdialog");
    box.append(make("b", "", `Replace ${ask.file} with ${ask.chosen}?`), make("span", "", `The project has ${ask.file} already. It goes to .busy/removed in the project's folder.`));
    const row = make("div", "publish-row");
    row.append(button("btn solid", "Replace", () => uploadLicense(true)), button("btn", `Keep ${ask.file}`, () => ((flow.licenseAsk = null), render())));
    box.append(row);
    return [box];
  }

  /** Buttons at the top right of a step. */
  const HEAD_ACTIONS = {
    readme: () => {
      const d = flow.drafts;
      // The project's own README.md as it is has no editor (EMU-365).
      if (d.readme.mode === "file") return null;
      const tabs = make("div", "publish-tabs");
      tabs.setAttribute("role", "tablist");
      for (const [mode, label] of [["fields", "Fields"], ["markdown", "Markdown"]]) {
        const tab = make("button", d.readme.mode === mode ? "on" : "", label);
        tab.type = "button";
        tab.setAttribute("role", "tab");
        tab.ariaSelected = String(d.readme.mode === mode);
        tab.addEventListener("click", () => {
          if (d.readme.mode === mode) return;
          // To Markdown: the text the fields make, to go on from; back to the fields: they are as they were.
          // How to use's rows go along: into the fields' list, or into the Markdown made from the fields.
          const usage = howToUse.listOf(d.rows);
          if (mode === "markdown") d.readme = { ...d.readme, mode, usage, markdown: readme.readmeMarkdown({ ...d.readme, usage, mode: "fields" }, flow.status.readme.facts) };
          else d.readme = { ...d.readme, mode, usage };
          d.rows = rowsOfReadme(d.readme);
          d.readmeDirty = true;
          render();
        });
        tabs.append(tab);
      }
      return tabs;
    },
    check: () => (flow.check ? button("btn", "Run again", () => runCheck({ byHand: true }), { picture: "refresh", disabled: flow.busy ? "Wait for the work under way" : null }) : null),
  };

  const PANES = {
    texts() {
      const s = flow.status.texts;
      const d = flow.drafts;
      const limits = s.rules.limits;
      const form = make("div", "publish-form");
      const all = [];
      const touched = flow.touched;
      const changed = (key) => {
        touched.add(key);
        if (key !== "name") d.textsDirty = true;
        flow.said = null;
        update();
        refreshFoot();
      };
      form.append(iconPart());
      // Name and category side by side; the category's list opens under both.
      const name = make("input", "input");
      name.type = "text";
      name.value = d.name ?? "";
      name.spellcheck = false;
      name.addEventListener("input", () => {
        d.name = name.value;
        changed("name");
      });
      const nameField = field("Name", name, { about: "On the BUSY Bar and in the catalog." });
      all.push(["name", nameField, () => ({ count: `${[...(d.name ?? "")].length} / 32`, problem: d.name && rules.nameProblem(d.name) ? `${rules.nameProblem(d.name)}.`.replace(/^./, (c) => c.toUpperCase()) : null })]);
      const pair = make("div", "publish-pair");
      const picker = categoryPicker(s.rules.categories, d.texts.category, (id) => {
        d.texts.category = id;
        flow.picking = false;
        changed("category");
        render();
      });
      const categoryField = field("Category", picker.button, { className: "narrow", about: "Where the catalog lists the app." });
      all.push(["category", categoryField, () => ({})]);
      pair.append(nameField.row, categoryField.row);
      if (picker.list) pair.append(picker.list);
      form.append(pair);

      const short = make("input", "input");
      short.type = "text";
      short.value = d.texts.short_description;
      short.addEventListener("input", () => {
        d.texts.short_description = short.value;
        changed("short_description");
      });
      const shortField = field("Short description", short, { about: "One line on the app's card." });
      all.push(["short_description", shortField, () => ({ count: counted(d.texts.short_description, limits.short_description) })]);
      form.append(shortField.row);
      for (const [key, label, rows, about] of [
        ["description", "Description", 6, "What it does and how to use it. Headings, bold, lists and links work."],
        ["changelog", "What's new", 3, "For the first version: what it can do."],
      ]) {
        const area = make("textarea", "input");
        area.rows = rows;
        area.value = d.texts[key];
        area.addEventListener("input", () => {
          d.texts[key] = area.value;
          changed(key);
        });
        const one = field(label, area, { about });
        all.push([key, one, () => ({ count: counted(d.texts[key], limits[key]) })]);
        form.append(one.row);
      }
      function update() {
        const now = rules.textProblems(d.texts);
        for (const [key, one, words] of all) {
          const w = words();
          const value = key === "name" ? d.name : d.texts[key];
          // What is wrong shows once there is something written, never as a wall of red on an empty form.
          const problem = key === "name" ? w.problem : value && (touched.has(key) || flow.status.texts.exists) ? (now.problems[key] ?? now.warnings?.[key] ?? null) : null;
          one.set({ ...w, hint: "", problem });
        }
      }
      update();
      return [form];
    },

    screenshots() {
      const s = flow.status.screenshots;
      const busyNow = flow.busy ? "Wait for the work under way" : null;
      const strip = (display, list, size, title) => {
        const box = make("div", `publish-shots shots-${display}`);
        list.forEach((one, i) => {
          const card = make("figure", `shot${one.problem ? " bad" : ""}`);
          const frame = make("div", "frame");
          if (one.data) {
            const picture = make("img");
            picture.src = one.data;
            picture.alt = `${display} screenshot ${i + 1}`;
            frame.append(picture);
          } else frame.append(make("span", "missing", "Not readable"));
          card.append(frame);
          const caption = make("figcaption");
          if (display === "front" && i === 0) caption.append(make("span", "chip live", "Cover"));
          else caption.append(make("span", "name", one.path.split("/").pop()));
          const tools = make("span", "tools");
          const move = (by) => {
            const order = { front: s.front.map((x) => x.path), back: s.back.map((x) => x.path) };
            const own = order[display];
            const [taken] = own.splice(i, 1);
            own.splice(i + by, 0, taken);
            screenshots({ order }, "Order saved");
          };
          const left = button("icon-btn small", "", () => move(-1), { picture: "chevron-left", title: display === "front" && i === 1 ? "Make it the cover" : "Earlier", disabled: i === 0 ? "It is the first" : busyNow });
          left.ariaLabel = "Earlier";
          const right = button("icon-btn small", "", () => move(1), { picture: "chevron-right", title: "Later", disabled: i === list.length - 1 ? "It is the last" : busyNow });
          right.ariaLabel = "Later";
          const away = button("icon-btn small", "", () => screenshots({ remove: one.path }, "Removed. The file is in .busy/removed"), { picture: "trash", title: "Remove", disabled: busyNow });
          away.ariaLabel = "Remove";
          tools.append(left, right, away);
          caption.append(tools);
          if (one.problem) card.title = one.problem;
          card.append(caption);
          box.append(card);
        });
        if (!list.length) box.append(make("p", "publish-empty", display === "front" ? "Run the app on the BUSY Bar, then take it. Or upload one." : "Optional."));
        const take = button("btn", "Take from the BUSY Bar", () => screenshots({ take: display }, "Saved"), { picture: "camera", title: `Saves what the ${display} display shows now`, disabled: busyNow });
        const upload = button("btn", "Upload…", () => screenshots({ upload: display }), { picture: "upload", title: `Add PNG screenshots of the ${display} display you made before: ${display === "front" ? "72×16" : "160×80"}, or an exact enlargement`, disabled: busyNow });
        upload.dataset.part = `upload-${display}`;
        const head = make("div", "publish-row");
        const words = make("div", "words");
        words.append(make("h4", "", title), make("span", "meta", size));
        const buttons = make("div", "buttons");
        buttons.append(take, upload);
        head.append(words, buttons);
        return section(null, head, box);
      };
      const parts = [strip("front", s.front, "72×16, 1 to 10", "Front display"), strip("back", s.back, "160×80, up to 10", "Back display")];
      const bad = s.problems.filter((one) => !/^No front screenshot yet/.test(one));
      if (bad.length) {
        const list = make("ul", "publish-problems");
        for (const problem of bad) list.append(make("li", "", problem));
        parts.push(list);
      }
      return parts;
    },

    readme() {
      const r = flow.status.readme;
      const d = flow.drafts;
      const facts = r.facts;
      // The project's README.md as it is (EMU-365): the switch, the hints of what the step would check, and the file.
      if (d.readme.mode === "file") {
        // The hints made here, by the same rules as the command line's (readme.mjs fileHints), also before it is saved.
        const rows = howToUse.read(facts.file ?? "");
        const fileSaid = [...readme.fileHints(facts.file ?? "", flow.status.files?.published ?? []), ...(rows.length && howToUse.sectionHint(rows) ? [howToUse.sectionHint(rows)] : [])];
        const hints = fileSaid.map((one) => make("p", "publish-warn", one));
        const preview = make("div", "publish-preview");
        preview.replaceChildren(...markdownView(facts.file ?? ""));
        const box = make("div", "publish-preview-box");
        box.append(make("span", "publish-caption", "README.md, as GitHub will show it"), preview);
        return [useFilePart(), ...readmeQuestion(), ...hints, box];
      }
      const editor = make("div", "publish-form");
      const preview = make("div", "publish-preview");
      const notes = make("div", "publish-notes");
      let markdownArea = null;
      const changed = () => {
        d.readmeDirty = true;
        flow.said = null;
        drawPreview();
        refreshFoot();
      };
      // The rows of How to use are the README's: its usage field's list, or the ## How to use section of the Markdown.
      const rowsChanged = () => {
        if (d.readme.mode === "markdown") {
          d.readme.markdown = howToUse.write(d.readme.markdown, d.rows);
          if (markdownArea) markdownArea.value = d.readme.markdown;
        } else d.readme.usage = howToUse.listOf(d.rows);
        changed();
        rows.set();
      };
      const rows = howToUseEditor(d, rowsChanged);
      if (d.readme.mode === "fields") {
        const title = make("input", "input");
        title.type = "text";
        title.value = d.readme.title;
        title.addEventListener("input", () => {
          d.readme.title = title.value;
          changed();
        });
        editor.append(field("Title", title).row);
        const intro = make("textarea", "input");
        intro.rows = 3;
        intro.value = d.readme.intro;
        intro.addEventListener("input", () => {
          d.readme.intro = intro.value;
          changed();
        });
        editor.append(field("About", intro, { hint: "A paragraph: what the app does." }).row);
        const auto = [facts.screenshots.front.length + facts.screenshots.back.length ? "screenshots" : null, facts.settings.length ? "settings" : null, "how to build", facts.license ? "license" : null].filter(Boolean);
        editor.append(muted(`Added for you: ${auto.join(", ")}.`));
      } else {
        const area = make("textarea", "input code");
        markdownArea = area;
        area.rows = 14;
        area.spellcheck = false;
        area.value = d.readme.markdown;
        area.addEventListener("input", () => {
          d.readme.markdown = area.value;
          d.rows = rowsOfReadme(d.readme);
          rows.redraw();
          changed();
        });
        editor.append(area);
      }
      function drawPreview() {
        const markdown = readme.readmeMarkdown(d.readme, facts);
        const left = readme.templateLeft(markdown);
        notes.replaceChildren(...left.map((one) => make("p", "publish-warn", `Still has ${one.what}. Take it out.`)));
        preview.replaceChildren(...markdownView(markdown));
      }
      drawPreview();
      const columns = make("div", "publish-columns");
      const right = make("div", "publish-preview-box");
      right.append(make("span", "publish-caption", "Preview"), preview);
      columns.append(editor, right);
      // How to use first, across the pane: the part only the author can write, and the one the catalog shows as cards.
      const parts = [useFilePart(), ...readmeQuestion(), notes, rows.box, columns];
      if (r.state === "yours" && !r.saved && d.readme.mode === "markdown") parts.unshift(muted("Your README.md, as it is. How to use, if you add rows, is written into it as its own section."));
      return parts;
    },

    license() {
      const s = flow.status.license;
      const d = flow.drafts.license;
      if (s.files.length) {
        const file = s.files[0];
        const kept = make("div", "publish-done");
        kept.innerHTML = icon("checkmark-circle-fill");
        const words = make("div", "words");
        words.append(make("b", "", `${file.name}: ${file.spdx ?? "your own text"}`), make("span", "", file.spdx ? "Kept as it is." : "Kept as it is. The catalog does not recognize the text: a moderator reads it."));
        const tools = make("div", "buttons");
        tools.append(button("btn", "Upload license file…", () => uploadLicense(), { picture: "upload", title: "Put another license's text in its place: you are asked first", disabled: flow.busy ? "Wait for the work under way" : null }), button("btn", `Show in ${FILE_MANAGER}`, () => reveal(file.name)));
        kept.append(words, tools);
        return [kept, ...licenseQuestion()];
      }
      const pick = make("div", "publish-licenses");
      pick.setAttribute("role", "radiogroup");
      pick.ariaLabel = "License";
      const choose = (id) => {
        d.choice = id;
        flow.said = null;
        render();
      };
      for (const one of s.choices) {
        const card = make("label", `license-card${d.choice === one.id ? " on" : ""}`);
        const input = make("input");
        input.type = "radio";
        input.name = "publish-license";
        input.value = one.id;
        input.checked = d.choice === one.id;
        input.addEventListener("change", () => choose(one.id));
        const top = make("span", "top");
        top.append(input, make("b", "", one.name));
        if (one.recommended) top.append(make("span", "chip live", "Recommended"));
        const points = make("ul", "points");
        for (const point of one.points ?? [one.about]) points.append(make("li", "", point));
        card.append(top, points);
        if (one.note) card.append(make("span", "note", one.note));
        pick.append(card);
      }
      const other = make("label", `license-other${d.choice === "other" ? " on" : ""}`);
      const radio = make("input");
      radio.type = "radio";
      radio.name = "publish-license";
      radio.value = "other";
      radio.checked = d.choice === "other";
      radio.addEventListener("change", () => choose("other"));
      other.append(radio, make("span", "", "Another license: I'll add my own LICENSE file"));
      const parts = [pick, other];
      if (d.choice && d.choice !== "other") {
        const name = make("input", "input");
        name.type = "text";
        name.value = d.author ?? "";
        name.placeholder = "Your name, or your organisation's";
        name.addEventListener("input", () => {
          d.author = name.value;
          refreshFoot();
        });
        const holder = field("Copyright holder", name, { count: `© ${s.year}`, hint: "Written into LICENSE on Next." });
        const full = make("div", "publish-fulltext");
        const show = button("link-btn", flow.fullText === d.choice ? "Hide the full text" : "Show the full text", async () => {
          flow.fullText = flow.fullText === d.choice ? null : d.choice;
          if (flow.fullText && !flow.texts?.[d.choice]) {
            try {
              const answer = await fetch(`/emulator/publish/licenses/${encodeURIComponent(d.choice)}.txt`);
              flow.texts = { ...(flow.texts ?? {}), [d.choice]: answer.ok ? await answer.text() : "The text could not be read." };
            } catch {
              flow.texts = { ...(flow.texts ?? {}), [d.choice]: "The text could not be read." };
            }
          }
          render();
        });
        full.append(show);
        if (flow.fullText === d.choice && flow.texts?.[d.choice]) full.append(make("pre", "publish-pre", flow.texts[d.choice]));
        parts.push(holder.row, full);
      }
      if (d.choice === "other") {
        const row = make("div", "publish-row publish-own-license");
        const upload = button("btn solid", "Upload license file…", () => uploadLicense(), { picture: "upload", title: "Choose your license's text: it is copied into the project as LICENSE", disabled: flow.busy ? "Wait for the work under way" : null });
        upload.dataset.part = "upload-license";
        row.append(upload, muted("Copied into the project as LICENSE, then checked."), button("link-btn", `Or put it there yourself: Show in ${FILE_MANAGER}`, () => reveal("")));
        parts.push(row, ...licenseQuestion());
      }
      return parts;
    },

    files() {
      const f = flow.files;
      if (!f) return [muted("Reading the project's files.")];
      const parts = [];
      if (f.findings.length) {
        // One entry a file: what it holds, and whether it would be published.
        const byFile = new Map();
        for (const one of f.findings) {
          const entry = byFile.get(one.path) ?? { path: one.path, published: one.published, keptIn: one.kept_in === true, byDefault: one.by_default === true, kinds: [] };
          entry.kinds.push(`${one.kind}${one.lines.length ? `, line ${one.lines.join(", ")}` : ""}`);
          byFile.set(one.path, entry);
        }
        const list = make("ul", "publish-list");
        for (const one of byFile.values()) {
          const item = make("li", one.published && !one.keptIn ? "danger" : one.published ? "warn" : "");
          const words = make("div", "words");
          const state = one.published ? (one.keptIn ? "Published on purpose." : "Would be published.") : "Kept out.";
          words.append(make("b", "", one.path), make("span", "", `${one.kinds.join("; ")}. ${state}`));
          item.append(words);
          if (one.published) item.append(button("btn", "Keep it out", () => planFiles({ write: true, keepOut: one.path })));
          // Kept out by default: the person may publish it on purpose.
          else if (one.byDefault) item.append(button("btn", "Publish it anyway", () => planFiles({ write: true, keepIn: one.path })));
          list.append(item);
        }
        parts.push(section("Looks like a secret", list));
      }
      const summary = make("ul", "publish-list plain");
      const add = (label, words) => {
        const item = make("li");
        const w = make("div", "words");
        w.append(make("b", "", label), make("span", "", words));
        item.append(w);
        summary.append(item);
        return item;
      };
      const out = f.left.map((one) => (one.folder ? `${one.path}/` : one.path));
      add(`${f.published.length} files go public`, out.length ? `${out.slice(0, 4).join(", ")}${out.length > 4 ? ` and ${out.length - 4} more` : ""} stay here.` : "Nothing is left out.");
      add("README.md", { none: "Made in the README step.", template: "The template's: the README step replaces it.", ours: "From the README step.", yours: "Yours, as it is.", kept: "Yours, used as it is: never written." }[f.readme]);
      add(".gitignore", f.ignore_missing.length ? `Gets ${f.ignore_missing.join(", ")} on Next.` : "Keeps out what is not the source.");
      parts.push(summary);
      const toggle = button("link-btn", flow.showTree ? "Hide the files" : "Show the files", () => {
        flow.showTree = !flow.showTree;
        render();
      });
      parts.push(toggle);
      if (flow.showTree) {
        const tree = make("ul", "publish-tree");
        for (const one of f.published) {
          const item = make("li");
          const box = make("input");
          box.type = "checkbox";
          box.checked = true;
          box.title = "Uncheck to keep it out of the repository (.gitignore)";
          box.addEventListener("change", () => planFiles({ write: true, keepOut: one.path }));
          item.append(box, make("code", "", one.path), make("span", "", one.why));
          tree.append(item);
        }
        for (const one of f.left) {
          const item = make("li", "left");
          const box = make("input");
          box.type = "checkbox";
          box.checked = false;
          box.disabled = true;
          item.append(box, make("code", "", one.folder ? `${one.path}/` : one.path), make("span", "", one.why));
          tree.append(item);
        }
        parts.push(tree);
      }
      return parts;
    },

    check() {
      const c = flow.check;
      const changed = changedNotice("check");
      if (!c) return [...(changed ? [changed] : []), muted(flow.busy ? "Building the app and running the catalog's checks." : "The checks have not run yet.")];
      const parts = changed ? [changed] : [];
      const summary = make("div", `publish-verdict ${c.passed ? "good" : "bad"}`);
      const picture = c.passed ? "checkmark-circle-fill" : "alert";
      summary.innerHTML = icon(picture);
      const words = make("div", "words");
      words.append(make("b", "", c.passed ? "All clear" : `${c.fails.length} to fix`), make("span", "", `${c.passes} of ${c.total} checks pass${c.built || c.fails.some((one) => one.id === "compile") ? "" : ". The package is checked when it is built"}.`));
      summary.append(words);
      parts.push(summary);
      if (c.fails.length) parts.push(checkList(c.fails, "fails"));
      if (c.warnings.length) parts.push(section("Worth a look", checkList(c.warnings, "warns")));
      const later = [...c.stage2, ...c.unchecked];
      if (later.length) {
        const line = muted(`${later.length} more are checked later, on GitHub and by the catalog.`);
        line.title = later.map((one) => one.title).join(", ");
        parts.push(line);
      }
      return parts;
    },

    package() {
      const p = flow.packaged;
      const s = flow.status.package;
      const changed = changedNotice("package");
      const parts = changed && !flow.busy ? [changed] : [];
      if (flow.busy && flow.lines.length) parts.push(make("pre", "publish-pre", flow.lines.join("\n")));
      if (p?.failed === "build") {
        parts.push(section("The build failed", make("pre", "publish-pre", p.message ?? "")));
        if (p.code === "settings_invalid") parts.push(button("btn", "Open settings.json", () => openFile("src/appmeta/settings.json")));
      } else if (p?.failed === "package") {
        parts.push(section(p.message ?? "Not packaged", ...(Array.isArray(p.fails) && p.fails.length ? [checkList(p.fails, "fails")] : [])));
      }
      const built = p?.package ?? s.built;
      // A package that no longer holds (stale-check) is not ready to publish.
      const done = p?.submission ?? (s.stale ? null : s.submission);
      if (done) {
        // What stage 2 sends (publish-flow.mjs): the source files the Repository files step lists, but .github/workflows/,
        // to the person's public repository; and to the catalog one file, the manifest that names that repository.
        const sources = flow.status.files.published.filter((one) => !one.path.startsWith(".github/workflows/")).length;
        const entry = `submission/applications/${flow.status.id}/manifest.yml`;
        const ready = make("div", "publish-verdict good");
        ready.innerHTML = icon("checkmark-circle-fill");
        const words = make("div", "words");
        words.append(make("b", "", "Ready to publish"), make("span", "", `GitHub gets the app's ${sources} source files, in a public repository on your account. The catalog gets one file: its entry, ${entry.replace(/^submission\//, "")}.`));
        const show = button("btn", `Show in ${FILE_MANAGER}`, () => reveal(entry), { picture: "folder", title: `Shows ${entry}` });
        ready.append(words, show);
        parts.push(ready);
        if (built) parts.push(muted(`Built and checked: ${(built.file ?? "").split(/[\\/]/).pop()}, ${size(built.bytes)}, in dist/. It stays on this computer: the catalog builds the app from your repository.`));
        const toggle = button("link-btn", flow.showByHand ? "Hide the steps by hand" : "Rather by hand? Show the steps", () => {
          flow.showByHand = !flow.showByHand;
          render();
        });
        parts.push(toggle);
        if (flow.showByHand) parts.push(byHand());
      } else if (!flow.busy && !p) {
        parts.push(muted("Press Build and package. It takes a minute."));
      }
      return parts;
    },

    github() {
      const gh = flow.gh;
      if (!gh) return [muted("Asking the app about GitHub.")];
      const parts = [];
      if (gh.failure) return [muted([gh.failure.message, gh.failure.hint].filter(Boolean).join(" "))];
      if (!gh.configured) {
        parts.push(section("GitHub CLI is not in this build", muted("Publishing signs in through GitHub CLI. Send the app by hand: the steps are in SUBMIT.md in the project's submission folder.")));
        parts.push(button("btn", `Show in ${FILE_MANAGER}`, () => reveal("submission")));
        return parts;
      }
      // Two views, each with its own heading (STEP_HEADS): the account, then publishing with it.
      if (gh.signing) return signingPart(gh);
      if (!gh.signedIn || flow.accountMode) return accountPart(gh);
      parts.push(publishingAs(gh));
      const status = flow.status;
      if (!steps.stageOneDone(status)) {
        const first = steps.firstOpen(status);
        const row = make("div", "publish-row");
        row.append(muted(`Finish ${steps.stepTitle(first)} first.`), button("btn", "Go there", () => go(first)));
        parts.push(row);
        return parts;
      }
      // What this app published the project to (its own record, through the plan), never the project's own file alone.
      const w = flow.where;
      const repo = flow.pushed ?? (w?.mode === "replace" && w.name === flow.repoName ? { page: w.page, commit: w.commit } : null);
      if (!flow.repoName) flow.repoName = w?.name ?? String(status.id ?? "app").split(".").pop();
      const name = make("input", "input");
      name.type = "text";
      name.value = flow.repoName;
      name.spellcheck = false;
      const repoField = field("Repository", name, { count: "public" });
      const about = repoField.below;
      // Where the name came from, when that is worth saying: the project's git remote, or why not (EMU-358).
      const source = make("span", "hint source");
      repoField.row.append(source);
      parts.push(repoField.row);
      const row = make("div", "publish-row");
      // .github/workflows/ is not published: the sign-in's access does not reach it, and the catalog builds the app.
      const workflows = status.files.published.filter((one) => one.path.startsWith(".github/workflows/")).length;
      const count = status.files.published.length - workflows;
      // Into the person's own repository: the confirmation first, which names what changes (catalog-update).
      const publishButton = button("btn solid", "Publish to GitHub", () => {
        if (publishButton.ariaDisabled === "true") return;
        if (flow.where?.mode === "existing") {
          flow.confirmInto = true;
          flow.deleteOthers = false;
          render();
        } else pushToGithub();
      }, { picture: "upload" });
      const what = muted("");
      planned = { about, source, go: publishButton, what, count: `${count === 1 ? "1 file" : `${count} files`}${workflows ? " (.github/workflows/ stays out)" : ""}` };
      showPlan(planned);
      name.addEventListener("input", () => {
        typedName(name.value);
        showPlan(planned);
      });
      if (w?.mode === "taken" && w.suggestion && w.name === flow.repoName) {
        const use = button("btn", `Use ${w.suggestion}`, () => {
          flow.repoName = w.suggestion;
          render();
          void planName();
        });
        repoField.row.append(use);
      }
      parts.push(...signerPart());
      const signed = flow.signers?.signer ? make("span", "hint signed", `Signed ${signedWords(flow.signers.signer)}`) : null;
      row.append(publishButton, ...(signed ? [signed] : []), what);
      parts.push(row);
      if (flow.confirmInto && w?.mode === "existing" && w.name === flow.repoName && !flow.busy) parts.push(confirmIntoPart(w, planned.count));
      if (flow.busy === "Publishing to GitHub") parts.push(uploadPart());
      else if (flow.busy && flow.lines.length) {
        const list = make("ul", "publish-lines");
        for (const line of flow.lines) list.append(make("li", "", line));
        parts.push(list);
      }
      if (repo) {
        const list = make("ul", "publish-lines");
        const where = make("li");
        where.append(make("b", "", "Repository"), githubLink(repo.page, repo.page.replace(/^https:\/\//, "")));
        const commit = make("li");
        const sha = make("code", "", repo.commit);
        const copy = button("icon-btn small", "", () => copied(copy, repo.commit), { picture: "copy", title: "Copy" });
        copy.ariaLabel = "Copy the commit";
        commit.append(make("b", "", "Commit"), sha, copy);
        list.append(where, commit);
        if (flow.pushed) {
          const checked = make("li");
          checked.append(make("b", "", "Checked"), make("span", "", `${flow.pushed.files} files on GitHub, the same as sent${flow.pushed.unchanged ? "; nothing had changed" : ""}`));
          list.append(checked);
        }
        const next = make("div", "publish-row");
        next.append(githubLink(repo.page, "Open the repository on GitHub", "btn", "link"), button("btn solid", "Send to catalog", () => go("catalog"), { picture: "apps-add" }));
        const result = section(flow.pushed ? "Published" : "On GitHub", list, next);
        result.classList.add("publish-result");
        parts.push(result);
      }
      return parts;
    },

    catalog() {
      const gh = flow.gh;
      if (!gh) return [muted("Asking the app about GitHub.")];
      if (gh.failure) return [muted([gh.failure.message, gh.failure.hint].filter(Boolean).join(" "))];
      if (!gh.configured || !gh.signedIn) return [muted(gh.configured ? "Sign in to GitHub first." : "GitHub CLI is not in this build: send the app by hand (SUBMIT.md)."), button("btn solid", "Publish to GitHub", () => go("github"), { picture: "upload" })];
      const status = flow.status;
      // The repository this app published the project to and checked (its own record), not the project's file.
      const repo = flow.where?.mode === "replace" ? flow.where : null;
      if (!repo?.commit) return [muted("The app is not on GitHub yet."), button("btn solid", "Publish to GitHub", () => go("github"), { picture: "upload" })];
      const parts = [];
      // What was sent comes first, where it is seen without scrolling.
      const made = flow.requested ?? (status.github?.request?.url ? { url: status.github.request.url, catalog: status.github.request.catalog } : null);
      if (made) {
        const list = make("ul", "publish-lines");
        const item = make("li");
        item.append(make("b", "", flow.requested ? (flow.requested.created ? "Opened" : "Updated") : "Request"), githubLink(made.url, made.url.replace(/^https:\/\//, "")));
        list.append(item);
        const open = make("div", "publish-row");
        open.append(githubLink(made.url, "Open the request on GitHub", "btn solid", "link"), muted("The catalog's checks run on GitHub; then a moderator reviews the app."));
        const result = section("Sent", list, open);
        result.classList.add("publish-result");
        parts.push(result);
      }
      flow.catalog ??= status.catalog;
      // The catalog it goes to, as plain text with a link: there is no field to change it (the command line's --catalog is
      // for development and tests).
      const to = make("p", "publish-muted");
      to.append("Goes to ", githubLink(`https://github.com/${flow.catalog}`, flow.catalog), ", the BUSY Apps Catalog.");
      parts.push(to);
      parts.push(...checklistPart(repo));
      if (flow.busy && flow.lines.length) {
        const list = make("ul", "publish-lines");
        for (const line of flow.lines) list.append(make("li", "", line));
        parts.push(list);
      }
      return parts;
    },
  };

  /** A list of checks: each its title, what was found, and the step that puts it right. */
  function checkList(items, kind) {
    const list = make("ul", `publish-list ${kind}`);
    for (const one of items) {
      const item = make("li", kind === "fails" ? "danger" : "");
      const words = make("div", "words");
      words.append(make("b", "", one.title));
      if (one.found) words.append(make("span", "", one.found));
      item.append(words);
      const to = STEP_OF_CHECK[one.step];
      // The build's and the types' failures (stale-check): the file and line they name, opened in the editor.
      if (typeof one.file === "string" && /^[^/\\][^\\]*$/.test(one.file) && !one.file.split("/").includes("..")) item.append(button("btn", `Open ${one.file.split("/").pop()}`, () => openFile(one.file), { title: `Opens ${one.file}${one.line ? `, line ${one.line}` : ""}` }));
      else if (to) item.append(button("btn", `Go to ${steps.stepTitle(to)}`, () => go(to)));
      else if (one.step === "manifest") item.append(button("btn", "Open manifest.json", () => openFile("src/appmeta/manifest.json")));
      else if (one.step === "icons" || one.step === "folder") item.append(button("btn", `Show in ${FILE_MANAGER}`, () => reveal(one.step === "icons" ? "src/appmeta" : "")));
      list.append(item);
    }
    return list;
  }
  const STEP_OF_CHECK = { texts: "texts", screenshots: "screenshots", license: "license", package: "package", readme: "readme" };

  /** The steps by hand, with their commands to copy. */
  function byHand() {
    const steps = make("ol", "publish-hand");
    const all = [];
    for (const step of flow.status.by_hand) {
      const item = make("li");
      item.append(make("span", "", step.text));
      for (const command of step.commands) {
        all.push(command);
        const line = make("div", "command");
        const copy = button("icon-btn small", "", () => copied(copy, command), { picture: "copy", title: "Copy" });
        copy.ariaLabel = "Copy";
        const words = make("code", "", command);
        words.title = command;
        line.append(words, copy);
        item.append(line);
      }
      steps.append(item);
    }
    const copyAll = button("btn", "Copy the commands", () => copied(copyAll, all.join("\n"), { wide: true }), { picture: "copy" });
    const box = section(null, steps, copyAll);
    box.classList.add("publish-by-hand");
    return box;
  }

  // ---------------------------------------------------------------- the README's preview

  /**
   * The Markdown the README step makes, drawn as elements: headings, paragraphs, lists, code, the screenshots, bold,
   * italic, code and links in a line. What GitHub shows, near enough to judge it; never markup from the text.
   */
  function markdownView(markdown) {
    const out = [];
    const shots = [...(flow.status.screenshots.front ?? []), ...(flow.status.screenshots.back ?? [])];
    const pictureOf = (src) => shots.find((one) => one.path === src || one.scaled === src || one.path === src.replace(/@\d+x\.png$/i, ".png"));
    let paragraph = [];
    let list = null;
    let section = null;
    const flush = () => {
      if (paragraph.length) out.push(inline(make("p"), paragraph.join(" ")));
      paragraph = [];
      list = null;
    };
    const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*<!--.*-->\s*$/.test(line)) continue;
      if (/^```/.test(line)) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        out.push(make("pre", "", code.join("\n")));
        continue;
      }
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        section = heading[2].trim().toLowerCase();
        out.push(inline(make(`h${heading[1].length}`), heading[2]));
        continue;
      }
      const picture = /^\s*<img\s[^>]*src="([^"]+)"/i.exec(line) ?? /^\s*!\[[^\]]*\]\(([^)\s]+)/.exec(line);
      if (picture) {
        flush();
        const shot = pictureOf(picture[1]);
        if (shot?.data) out.push(previewPicture(shot, picture[1], out));
        else out.push(make("p", "missing", picture[1]));
        continue;
      }
      const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
      if (item) {
        if (paragraph.length) flush();
        if (!list) {
          list = make(/^\s*\d/.test(line) ? "ol" : "ul");
          out.push(list);
        }
        // How to use: each row with its control's chip, as the catalog's page shows it.
        const row = section === "how to use" && howToUse ? howToUse.rowsOf(line)[0] : null;
        if (row?.control) {
          const li = make("li", "howto");
          li.append(controlChip(row.control), inline(make("span"), row.text));
          list.append(li);
        } else list.append(inline(make("li"), item[1]));
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      if (list) list = null;
      paragraph.push(line.trim());
    }
    flush();
    return out;
  }
  /**
   * A screenshot of the preview: the same element from one drawing to the next (by its place among the pictures), so
   * that typing does not decode the pictures again.
   */
  const pictures = new Map();
  function previewPicture(shot, src, out) {
    const nth = out.filter((one) => one.tagName === "IMG").length;
    const key = `${nth}:${shot.data}`;
    let img = pictures.get(key);
    if (!img) {
      img = make("img", /(^|\/)back-/.test(shot.path) ? "shot shot-back" : "shot shot-front");
      img.decoding = "sync";
      img.src = shot.data;
      pictures.set(key, img);
      if (pictures.size > 40) pictures.delete(pictures.keys().next().value);
    }
    img.alt = src;
    return img;
  }

  /** Bold, italic, code and links of a line, as elements into `el`. */
  function inline(el, text) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
    let at = 0;
    for (const m of text.matchAll(pattern)) {
      if (m.index > at) el.append(text.slice(at, m.index));
      const t = m[0];
      if (t.startsWith("**")) el.append(make("strong", "", t.slice(2, -2)));
      else if (t.startsWith("`")) el.append(make("code", "", t.slice(1, -1)));
      else if (t.startsWith("[")) el.append(make("span", "link", /^\[([^\]]+)\]/.exec(t)[1]));
      else el.append(make("em", "", t.slice(1, -1)));
      at = m.index + t.length;
    }
    if (at < text.length) el.append(text.slice(at));
    return el;
  }

  /** What a sign-in through GitHub CLI means beyond the emulator (security review F3), said before every sign-in. */
  const SHARED_SIGN_IN = "This sign-in belongs to GitHub CLI on this computer: other programs, including AI agents, can use it too. The emulator's confirmations cover only its own commands.";

  /** A tick of the sign-out's, kept in the flow until Sign out. */
  function tickBox(key, title, about) {
    const label = make("label", "choice");
    const tick = make("input");
    tick.type = "checkbox";
    tick.checked = flow[key] === true;
    tick.dataset.tick = key;
    tick.addEventListener("change", () => {
      flow[key] = tick.checked;
      render();
    });
    const words = make("span", "words");
    words.append(make("b", "", title), make("span", "", about));
    label.append(tick, words);
    return label;
  }

  // ---------------------------------------------------------------- shared helpers (publish-prepare): for both stages

  /**
   * Copy with its answer on the button: `text` goes to the clipboard, and `el` shows a tick and "Copied" ("Copied to
   * clipboard" when `wide`) for about two seconds, then is as it was. Not copied: its tooltip says why, and it stays.
   */
  async function copied(el, text, { wide = false } = {}) {
    const answer = await act(() => actions().copy(text));
    if (answer.again || answer === false || answer.ok === false) {
      el.title = answer.again ? "Click again" : "Not copied";
      return false;
    }
    if (!el.dataset.copiedFrom) el.dataset.copiedFrom = el.innerHTML;
    clearTimeout(Number(el.dataset.copiedTimer));
    el.classList.add("copied");
    el.innerHTML = icon("checkmark");
    el.append(make("span", "", wide ? "Copied to clipboard" : "Copied"));
    el.dataset.copiedTimer = String(
      setTimeout(() => {
        el.classList.remove("copied");
        el.innerHTML = el.dataset.copiedFrom;
        delete el.dataset.copiedFrom;
      }, 2000),
    );
    return true;
  }

  const size = (bytes) => (typeof bytes !== "number" ? "" : bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`);

  // ---------------------------------------------------------------- publish-send: the account, the upload, the checklist
  // Stage 2's views of their own (publish-send): Publish to GitHub is two views, each with its heading and one main
  // button — Choose a GitHub account (GitHub CLI's accounts on this computer, or another one signed in), then
  // Publish as <login> — and the upload shows how far it is. Send to catalog shows the catalog's author checklist as its
  // pull request template writes it, read when the step opens; nothing is sent until every box is ticked.

  const NEW_ACCOUNT = "\u0000new";
  const sameLogin = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

  /** The heading of a step when its view is not the step's own: { title, lead }, or null. */
  const STEP_HEADS = {
    github() {
      const gh = flow.gh;
      if (!gh || gh.failure || !gh.configured) return null;
      if (gh.signing) return { title: flow.signingAnother ? "Sign in with another account" : "Sign in to GitHub", lead: "Enter the code on GitHub; the account you authorize there is the one publishing uses." };
      if (!gh.signedIn || flow.accountMode) return { title: "Choose a GitHub account", lead: gh.signedIn ? `Publishing uses ${gh.login} now. Choose another account, or sign out.` : "The account that gets the app's public repository and opens the request to the catalog." };
      return null;
    },
  };
  HEAD_ACTIONS.github = () => {
    const gh = flow.gh;
    if (!gh?.signedIn || gh.signing || !flow.accountMode) return null;
    return button("btn", "Back to Publish", () => {
      flow.accountMode = false;
      flow.said = null;
      render();
    }, { picture: "arrow-left", disabled: flow.busy ? "Wait for the work under way" : null });
  };

  /** Publish view: who it publishes as, and the way to the account view. */
  function publishingAs(gh) {
    const row = make("div", "publish-summary");
    const how = gh.origin === "existing" ? "GitHub CLI's account on this computer" : "Also GitHub CLI's account on this computer";
    row.append(make("b", "good", `Publishing as ${gh.login}`), make("span", "", how), button("btn", "Change account", () => {
      flow.accountMode = true;
      flow.pick = gh.login;
      flow.said = null;
      render();
    }, { picture: "user", disabled: flow.busy ? "Wait for the work under way" : null }));
    return row;
  }

  /** Account view: GitHub CLI's accounts to choose from, or another account to sign in; and signing out. */
  function accountPart(gh) {
    const waiting = flow.busy ? "Wait for the work under way" : null;
    const all = Array.isArray(gh.accounts) ? gh.accounts.filter((one) => typeof one?.login === "string") : [];
    const active = all.find((one) => one.active)?.login ?? null;
    const parts = [];
    if (!all.length) {
      const row = make("div", "publish-row");
      row.append(button("btn solid", "Sign in to GitHub", signIn, { picture: "user", disabled: waiting }), muted("Shows a code to enter on github.com/login/device, in your browser."));
      parts.push(section("No account on this computer yet", muted("BUSY Bar Emulator signs in through GitHub CLI, made by GitHub. GitHub CLI asks for access to your repositories (public and private), your organizations' membership and your gists; the emulator uses it to create the app's public repository and open the request to the catalog. This also signs in GitHub CLI on this computer."), row, muted(SHARED_SIGN_IN)));
    } else {
      if (!flow.pick || (flow.pick !== NEW_ACCOUNT && !all.some((one) => sameLogin(one.login, flow.pick)))) flow.pick = gh.login ?? active ?? all[0].login;
      const list = make("div", "publish-choices one");
      list.setAttribute("role", "radiogroup");
      list.ariaLabel = "GitHub accounts";
      const card = (value, title, about) => {
        const label = make("label", "choice");
        const radio = make("input");
        radio.type = "radio";
        radio.name = "publish-account";
        radio.value = value === NEW_ACCOUNT ? "new" : value;
        radio.checked = flow.pick === value;
        radio.addEventListener("change", () => {
          flow.pick = value;
          flow.said = null;
          render();
        });
        const words = make("span", "words");
        words.append(make("b", "", title), make("span", "", about));
        label.append(radio, words);
        return label;
      };
      for (const one of all) {
        const about = [one.active ? "GitHub CLI's active account on this computer" : "Signed in to GitHub CLI on this computer", sameLogin(one.login, gh.login) ? "publishing uses it now" : null].filter(Boolean).join("; ");
        list.append(card(one.login, one.login, about));
      }
      list.append(card(NEW_ACCOUNT, "Another account", "Sign in on github.com in your browser. It is added to GitHub CLI on this computer."));
      const intro = all.length === 1 && !gh.signedIn ? `GitHub CLI on this computer is signed in as ${all[0].login}. Use this account?` : `GitHub CLI on this computer is signed in to ${all.length} accounts. Choose the one to publish with.`;
      const row = make("div", "publish-row");
      if (flow.pick === NEW_ACCOUNT) {
        row.append(button("btn solid", "Sign in with another account", signIn, { picture: "user", disabled: waiting }), muted(`Shows a code to enter on github.com/login/device. The account you authorize there is added to GitHub CLI${active ? `, which goes on using ${active}` : ""}, and publishing uses it.`));
      } else if (gh.signedIn && sameLogin(flow.pick, gh.login)) {
        row.append(button("btn solid", `Continue as ${gh.login}`, () => {
          flow.accountMode = false;
          render();
        }, { picture: "user", disabled: waiting }), muted(`Back to Publish, with ${gh.login}. Nothing is uploaded yet.`));
      } else {
        row.append(button("btn solid", `Use ${flow.pick}`, () => useExisting(flow.pick), { picture: "user", disabled: waiting }), muted(`Publishes as ${flow.pick}: the app's repository goes to github.com/${flow.pick}. Nothing is uploaded yet: next you name the repository and press Publish to GitHub. GitHub CLI's own active account stays ${active ?? "as it is"}.`));
      }
      parts.push(section(intro, list), row, muted(SHARED_SIGN_IN));
    }
    if (gh.signedIn) parts.push(signOutPart(gh));
    if (gh.failure) parts.push(make("p", "publish-said failed", [gh.failure.message, gh.failure.hint].filter(Boolean).join(" ")));
    return parts;
  }

  /** Who is signed in here, Sign out and its ticks: only an account the app signed in may be signed out of GitHub CLI. */
  function signOutPart(gh) {
    const waiting = flow.busy ? "Wait for the work under way" : null;
    const row = make("div", "publish-summary");
    row.append(make("b", "", `Signed in as ${gh.login}`), make("span", "", gh.origin === "existing" ? "GitHub CLI's account on this computer" : "Also GitHub CLI's account on this computer"), button("btn", "Sign out", signOut, { picture: "logout", disabled: waiting }));
    const box = section("Sign out", row);
    // A sign-in as another account of GitHub CLI's own made it the one GitHub CLI uses: Switch back only.
    if (gh.origin !== "app") {
      if (gh.previous) {
        const back = make("div", "publish-choices one");
        back.append(tickBox("switchBack", `Switch GitHub CLI back to ${gh.previous}`, `GitHub CLI on this computer uses ${gh.login} now. Sign out switches it back; ${gh.login} stays signed in to it.`));
        box.append(back);
      }
      return box;
    }
    // Ticked to start with when GitHub CLI had no account before: the sign-in then served the emulator alone (F3).
    if (flow.signOutCli === undefined) flow.signOutCli = !gh.previous && (gh.accounts ?? []).length <= 1;
    const ticks = make("div", "publish-choices one");
    ticks.append(tickBox("signOutCli", "Also sign out GitHub CLI on this computer", `Sign out signs ${gh.login} out of GitHub CLI too.${gh.previous ? ` GitHub CLI goes back to ${gh.previous}.` : ""}`));
    if (gh.previous && !flow.signOutCli) ticks.append(tickBox("switchBack", `Switch GitHub CLI back to ${gh.previous}`, `GitHub CLI on this computer uses ${gh.login} now. Sign out switches it back; ${gh.login} stays signed in to it.`));
    box.append(ticks);
    return box;
  }

  /** The sign-in under way: the code, Copy, the page to enter it on, Cancel, the wait. */
  function signingPart(gh) {
    const code = make("div", "publish-code");
    code.append(make("b", "", gh.signing.userCode));
    const copy = button("btn", "Copy", () => copied(copy, gh.signing.userCode), { picture: "copy" });
    code.append(copy);
    const row = make("div", "publish-row");
    row.append(button("btn solid", "Open github.com/login/device", () => act(() => actions().github.openCodePage()), { picture: "link" }), button("btn", "Cancel", cancelSignIn));
    const words = ["Open GitHub's page, enter the code and authorize GitHub CLI. This step goes on by itself when you have."];
    if (gh.signing.copied) words.push("GitHub CLI has put the code on the clipboard.");
    return [section("Enter this code on GitHub", muted(words.join(" ")), code, row), make("p", "publish-said working", "Waiting for GitHub")];
  }

  // The upload: what the app says of it as it goes (job.upload), redrawn in place; the time of the last news, for a
  // wait that is GitHub's rather than nothing at all.
  const STALL_MS = 20_000;
  let uploadBox = null;
  function heardUpload(job) {
    if (!flow || flow.busy !== "Publishing to GitHub") return;
    flow.uploadNews = Date.now();
    if (job.upload) flow.upload = job.upload;
    drawUpload();
  }
  function uploadPart() {
    uploadBox = make("div", "publish-upload");
    drawUpload();
    return uploadBox;
  }
  const amount = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function drawUpload() {
    if (!uploadBox || !uploadBox.isConnected || !flow || flow.busy !== "Publishing to GitHub") return;
    const u = flow.upload;
    const bar = make("div", "publish-bar");
    bar.setAttribute("role", "progressbar");
    const fill = make("span");
    bar.append(fill);
    let head;
    let detail = "";
    let share = null;
    if (!u) head = flow.lines.at(-1) ?? "Starting";
    else if (u.phase === "compare") head = "Reading what GitHub holds";
    else if (u.phase === "upload") {
      head = u.total ? `Uploading ${u.done} of ${u.total} ${u.total === 1 ? "file" : "files"}` : "GitHub has every file already";
      share = u.total ? (u.totalBytes ? u.bytes / u.totalBytes : u.done / u.total) : 1;
      detail = [u.totalBytes ? `${amount(u.bytes)} of ${amount(u.totalBytes)}` : "", u.known ? `${u.known} already on GitHub` : "", u.file && u.done < u.total ? `now ${u.file}` : ""].filter(Boolean).join("; ");
    } else if (u.phase === "commit") {
      head = "Making the commit";
      share = 1;
    } else {
      head = "Checking what GitHub holds";
      share = 1;
    }
    if (share === null) bar.classList.add("waiting");
    else {
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
      bar.ariaValueNow = String(Math.round(share * 100));
    }
    const top = make("div", "publish-row");
    const late = u?.phase === "check";
    const stop = button("btn", flow.canceling ? "Stopping" : "Cancel", async () => {
      flow.canceling = true;
      drawUpload();
      await act(() => actions().github.cancel());
    }, { picture: "cross", disabled: flow.canceling ? "Stopping" : late ? "The files are on GitHub: it is being checked" : null });
    top.append(make("b", "", head), stop);
    const out = [top, bar];
    if (detail) out.push(make("p", "publish-muted meta", detail));
    const quiet = Date.now() - (flow.uploadNews ?? Date.now());
    if (quiet >= STALL_MS) out.push(make("p", "publish-said working wrap", `Still waiting for GitHub: no answer for ${Math.round(quiet / 1000)} s. A large file takes longer; you can cancel.`));
    uploadBox.replaceChildren(...out);
  }

  // The checklist of Send to catalog: the target catalog's pull request template (github.checklist), as it is written.
  let checklistAsked = null;
  async function loadChecklist() {
    if (!flow?.catalog) return;
    const catalog = flow.catalog;
    if (checklistAsked === catalog) return;
    checklistAsked = catalog;
    try {
      const answer = await act(() => actions().github.checklist({ catalog }));
      if (!flow || flow.catalog !== catalog) return;
      const before = (flow.checklist?.boxes ?? []).join("\n");
      flow.checklist = answer.ok === false ? { for: catalog, failed: [answer.message, answer.hint].filter(Boolean).join(" "), boxes: [], blocks: [], ai: [] } : { ...answer, for: catalog };
      if (!flow.ticks || before !== flow.checklist.boxes.join("\n")) flow.ticks = new Set();
    } finally {
      if (checklistAsked === catalog) checklistAsked = null;
    }
    render();
  }

  /** A line of the template: its links (https only) open in the browser, its code and bold as such. */
  function linkedText(el, text) {
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
    let at = 0;
    for (const m of text.matchAll(pattern)) {
      if (m.index > at) el.append(text.slice(at, m.index));
      const t = m[0];
      if (t.startsWith("**")) el.append(make("strong", "", t.slice(2, -2)));
      else if (t.startsWith("`")) el.append(make("code", "", t.slice(1, -1)));
      else {
        const [, words, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t);
        if (/^https:\/\//.test(href)) {
          const a = make("a", "publish-inline-link", words);
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.addEventListener("click", (e) => e.stopPropagation?.());
          el.append(a);
        } else el.append(words);
      }
      at = m.index + t.length;
    }
    if (at < text.length) el.append(text.slice(at));
    return el;
  }

  /** The checklist, every box of it, the AI usage as one choice, and Send to catalog. */
  function checklistPart(repo) {
    const list = flow.checklist;
    if (!flow.catalog) return [muted("Name the catalog first.")];
    if (!list || list.for !== flow.catalog) {
      void loadChecklist();
      return [muted("Reading the catalog's checklist.")];
    }
    if (list.failed) return [make("p", "publish-said failed", list.failed)];
    flow.ticks ??= new Set();
    // The AI usage and its explanation as they were left (the project's .busy/publish.json, EMU-359).
    const noted = flow.status?.github?.ai ?? null;
    if (flow.ai === undefined || flow.ai === null) {
      flow.ai = noted?.choice ?? null;
      flow.aiNote ??= noted?.note ?? "";
      flow.aiSaved ??= noted ? aiKey(noted.choice, noted.note) : null;
    }
    const parts = [];
    const source = make("p", "publish-muted");
    if (list.source === "catalog") {
      source.append("As the catalog's pull request template has it: ");
      source.append(githubLink(list.page, `${list.catalog}, ${list.file}`));
      source.append(". Every box goes into the request ticked, so tick only what is true.");
    } else source.append("The catalog's own template could not be read, so this is the copy that comes with the emulator (busy-apps-catalog, 12 Nov 2026). Every box goes into the request ticked, so tick only what is true.");
    parts.push(source);
    let group = null;
    let boxes = null;
    const groups = [];
    const open = (title) => {
      group = { title, nodes: [] };
      boxes = null;
      groups.push(group);
    };
    const aiPick = (options) => {
      const chosen = options.find((one) => one.id === flow.ai);
      const pick = make("div", "publish-choices one");
      pick.setAttribute("role", "radiogroup");
      pick.ariaLabel = "AI usage";
      for (const one of options) {
        const card = make("label", "choice");
        const radio = make("input");
        radio.type = "radio";
        radio.name = "publish-ai";
        radio.value = one.id;
        radio.checked = flow.ai === one.id;
        radio.addEventListener("change", () => {
          flow.ai = one.id;
          saveAi();
          render();
        });
        const w = make("span", "words");
        w.append(linkedText(make("b"), one.text));
        card.append(radio, w);
        pick.append(card);
      }
      if (!chosen || !needsNote(chosen.id)) return pick;
      // "Partly" and "Fully": the catalog asks what AI made and what it does; the request says it after the option.
      const box = make("div", "publish-ai");
      const area = make("textarea", "input");
      area.rows = 3;
      area.id = "publish-ai-note";
      area.maxLength = MAX_AI_NOTE + 200;
      area.value = flow.aiNote ?? "";
      const prompt = chosen.prompt ?? AI_CHOICES.find((one) => one.id === chosen.id)?.prompt ?? "Explain the AI usage";
      const problem = (text) => (noteLength(text) > MAX_AI_NOTE ? `At most ${MAX_AI_NOTE} characters` : null);
      const note = field(prompt, area, { about: "Required: the pull request says it after your choice, as one paragraph of plain text.", count: `${noteLength(area.value)} / ${MAX_AI_NOTE}`, problem: problem(area.value) });
      area.addEventListener("input", () => {
        flow.aiNote = area.value;
        note.set({ count: `${noteLength(area.value)} / ${MAX_AI_NOTE}`, problem: problem(area.value) });
        saveAiSoon();
        refreshSend();
      });
      box.append(pick, note.row);
      return box;
    };
    for (const block of list.blocks ?? []) {
      if (block.kind === "heading") {
        open(block.text);
        continue;
      }
      if (!group) open(null);
      if (block.kind === "box") {
        if (!boxes) group.nodes.push((boxes = make("div", "publish-choices one publish-checklist")));
        const on = flow.ticks.has(block.text);
        const label = make("label", "choice");
        const tick = make("input");
        tick.type = "checkbox";
        tick.checked = on;
        tick.dataset.box = block.text;
        tick.addEventListener("change", () => {
          if (tick.checked) flow.ticks.add(block.text);
          else flow.ticks.delete(block.text);
          render();
        });
        const w = make("span", "words");
        w.append(linkedText(make("b"), block.label ?? block.text));
        if (block.optional) w.append(make("span", "publish-tag", "Optional"));
        label.append(tick, w);
        boxes.append(label);
        continue;
      }
      boxes = null;
      // "Keep ONE option and delete the others" is what the choice below does: one option, the others left out.
      if (block.kind === "ai") group.nodes.push(aiPick(block.options));
      else if (block.kind !== "instruction") group.nodes.push(linkedText(make("p", "publish-muted"), block.text));
    }
    if (!(list.ai ?? []).length) {
      open("AI usage");
      group.nodes.push(aiPick(AI_CHOICES.map((one) => ({ id: one.id, text: one.name }))));
    }
    for (const one of groups) parts.push(section(one.title, ...one.nodes));
    // An app the catalog has already: an update, with its version and What's new (catalog-update).
    const update = updatePart();
    parts.unshift(...update.parts);
    // A catalog that is not BUSY's (the project's catalog.json, or a name typed above): said first, and the request
    // goes there only with its own tick, which names it (security review L3).
    const other = list.busy === false;
    const confirmed = other && flow.otherCatalog === list.catalog;
    if (other) {
      const warn = make("p", "publish-warn", `${list.catalog} is not BUSY's catalog. Apps for BUSY Bar go to busy-app/busy-apps-catalog; whoever keeps ${list.catalog} gets this request, from your account.`);
      const label = make("label", "choice");
      const tick = make("input");
      tick.type = "checkbox";
      tick.checked = confirmed;
      tick.id = "publish-other-catalog";
      tick.addEventListener("change", () => {
        flow.otherCatalog = tick.checked ? list.catalog : null;
        render();
      });
      const w = make("span", "words");
      w.append(make("b", "", `Send it to ${list.catalog} all the same`));
      label.append(tick, w);
      const box = make("div", "publish-choices one");
      box.append(label);
      parts.unshift(warn, box);
    }
    const required = list.required ?? list.boxes;
    const total = required.length;
    const done = required.filter((one) => flow.ticks.has(one)).length;
    const why = flow.busy ? "Wait for the work under way" : update.blocked ?? (other && !confirmed ? `Confirm ${list.catalog}, which is not BUSY's catalog` : done < total ? `Tick every item of the checklist: ${done} of ${total} ticked` : !flow.ai ? "Choose how AI was used" : needsNote(flow.ai) && !noteLength(flow.aiNote) ? "Explain the AI usage" : needsNote(flow.ai) && noteLength(flow.aiNote) > MAX_AI_NOTE ? `Shorten the explanation of the AI usage to ${MAX_AI_NOTE} characters` : null);
    const row = make("div", "publish-row");
    const name = flow.status?.name ?? flow.name ?? flow.status?.id;
    const opens = update.exists ? `Opens the pull request "Update ${name} to ${flow.status?.version}" to ${list.catalog}` : `Opens a pull request to ${list.catalog}`;
    row.append(button("btn solid", update.exists ? "Send update" : "Send to catalog", sendToCatalog, { picture: "apps-add", disabled: why }), muted(`${why && !flow.busy ? `${why}. ` : ""}${opens} from your account with this checklist and your AI ${needsNote(flow.ai) ? "choice and explanation" : "choice"}, naming github.com/${repo.owner}/${repo.name} at ${repo.commit.slice(0, 12)}.${flow.signers?.signer ? ` Its commit is signed ${signedWords(flow.signers.signer)}.` : ""}`));
    parts.push(row);
    return parts;
  }

  // ---------------------------------------------------------------- catalog-update: publish into an existing repository, update in the catalog

  /**
   * Where the repository's name came from, said under the field (EMU-358): the project's git remote; or, when the name
   * is the app id's, why the remote did not give it. Nothing for a name typed, published to or imported from.
   */
  function namedWords(w) {
    const r = w.remote;
    if (w.named === "remote") return `The name is from the project's git remote${r?.remote ? `, ${r.remote}` : ""}.`;
    if (w.named !== "id" || !r?.why) return "";
    const said = r.remote ? `The project's git remote, ${r.remote},` : "The project's git remote";
    if (r.why === "another_account") return `${said} is github.com/${r.repo}, another account's: the name is from the app's id.`;
    if (r.unreadable) return `${said} is an address the emulator cannot read: the name is from the app's id.`;
    if (!r.host) return `${said} is a folder on this computer, not GitHub: the name is from the app's id.`;
    if (/^(?:www\.|ssh\.)?github\.com$/.test(r.host)) return `${said} names no repository on GitHub: the name is from the app's id.`;
    return `${said} is on ${r.host}, not GitHub: the name is from the app's id.`;
  }

  /** The words of the repository's plan: under the name, on the button, beside it; and why the button is off. */
  function intoWords(w, count) {
    const at = `github.com/${w.owner}/${w.name}`;
    const extra = (w.extra ?? []).length;
    if (w.mode === "new") return { about: `A new public repository: ${at}.`, label: "Publish to GitHub", what: `Creates the public repository ${at} and uploads ${count} in one commit. Anyone can see it.`, blocked: null };
    if (w.mode === "replace") {
      if (w.adopted) return { about: `Publishes into ${at}, as before.`, label: "Publish again", what: `Uploads ${count} to ${at} in a new commit.${extra ? ` The ${extra === 1 ? "file" : `${extra} files`} only the repository has ${extra === 1 ? "stays" : "stay"}.` : ""} Anyone can see them.`, blocked: null };
      return { about: `Replaces the files of ${at}, published from here before.`, label: "Publish again", what: `Uploads ${count} to ${at} in one commit: its files become the project's. Anyone can see them.`, blocked: null };
    }
    if (w.mode === "existing") return { about: `You have ${at} already, not published from here.${w.base === "imported" ? " This project was imported from it." : ""}`, label: `Publish into ${w.name}`, what: `Adds a new commit to its branch ${w.branch} with ${count}. Nothing is deleted unless you agree.`, blocked: null };
    if (w.mode === "diverged") {
      const many = w.ahead === 1 ? "a commit" : w.ahead ? `${w.ahead} commits` : "commits";
      const first = w.base === "git" && w.named === "remote" ? "Nothing is sent. Get them with git pull in the project's folder, then publish again." : "Nothing is sent. Import the repository again in Create app (Import from GitHub), carry your changes over and publish from that copy.";
      return { about: `${at} has ${many} this project doesn't have, made on GitHub or on another computer.`, label: "Publish to GitHub", what: first, blocked: "Get those commits first" };
    }
    const why = w.reason === "archived" ? `${at} is archived, so it takes no new commits.` : w.reason === "empty" ? `${at} has no commit yet, so there is nothing to add to.` : `You have a repository named ${w.name} already: it is not touched.`;
    return { about: `${why}${w.suggestion ? ` ${w.suggestion} is free.` : ""}`, label: "Publish to GitHub", what: "Choose another name first.", blocked: "Choose another name" };
  }

  const entryKey = () => `${flow.catalog}\n${flow.status?.version ?? ""}`;
  let entryAsked = null;
  /** What the catalog has of the app now (github.entry): asked once for each catalog and version. */
  async function loadEntry() {
    const key = entryKey();
    if (!flow?.catalog || entryAsked === key) return;
    entryAsked = key;
    try {
      const answer = await act(() => actions().github.entry({ folder: flow.folder, catalog: flow.catalog }));
      if (!flow || entryKey() !== key) return;
      flow.entry = answer.ok === false ? { for: key, failed: [answer.message, answer.hint].filter(Boolean).join(" ") } : { ...answer, for: key };
      // What's new: the project's, unless it is the published version's (then it is to be written anew).
      const mine = flow.status?.texts?.texts?.changelog ?? "";
      if (flow.entry.exists) flow.changelog ??= mine.trim() && mine.trim() !== String(flow.entry.published?.changelog ?? "").trim() ? mine : "";
    } finally {
      if (entryAsked === key) entryAsked = null;
    }
    render();
  }

  /** The update's part of Send to catalog: { exists, parts, blocked }. */
  function updatePart() {
    const e = flow.entry;
    if (!e || e.for !== entryKey()) {
      void loadEntry();
      return { exists: false, parts: [muted("Reading what the catalog has of the app.")], blocked: "Wait a moment" };
    }
    if (e.failed) return { exists: false, parts: [make("p", "publish-said failed", `What the catalog has of the app could not be read: ${e.failed} Send checks it again.`)], blocked: null };
    if (!e.exists) return { exists: false, parts: [], blocked: null };
    const p = e.published ?? {};
    const name = flow.status?.name ?? e.id;
    const nodes = [];
    const facts = make("ul", "publish-lines");
    const one = (b, text, link = null) => {
      const li = make("li");
      li.append(make("b", "", b), link ? githubLink(link, text) : make("span", "", text));
      facts.append(li);
    };
    one("In the catalog", p.version ? `${name} ${p.version}` : `${name}, version not readable`, e.page);
    one("This update", `${name} ${e.version}`);
    if (p.origin) one("From", p.origin.replace(/^https:\/\//, ""), p.origin);
    nodes.push(facts);
    let blocked = null;
    // The same id from another repository of the person's: sending makes this project the catalog's app (said, not
    // refused: the app may have moved to this repository).
    // A warning of its own (publish-warn), not a status line: .publish-said is the step's say of its work.
    if (e.yours !== false && e.elsewhere) nodes.push(make("p", "publish-warn", `The catalog has ${e.id} from ${e.elsewhere}, another repository of yours. Sending replaces that app with this project. If this is another app, give it another id in src/appmeta/manifest.json.`));
    if (e.yours === false) {
      blocked = "This app id is another account's in the catalog";
      nodes.push(make("p", "publish-said failed", `The catalog has ${e.id} from ${p.origin.replace(/^https:\/\//, "")}, a repository of another account: an update comes from its owner. If yours is another app, give it another id in src/appmeta/manifest.json.`));
    } else if (e.higher === false) {
      blocked = `Raise the version above ${p.version}`;
      const row = make("div", "publish-row");
      row.append(make("p", "publish-said failed", `The catalog has version ${p.version}, and this package is ${e.version}: an update needs a higher version. Raise version in src/appmeta/manifest.json, then build and package, and publish to GitHub again.`), button("btn", "Open manifest.json", () => openFile("src/appmeta/manifest.json")));
      nodes.push(row);
    } else if (e.higher === null) nodes.push(muted("The published version could not be read: the catalog's checks compare the two."));
    const area = make("textarea", "input");
    area.rows = 3;
    area.value = flow.changelog ?? "";
    area.id = "publish-changelog";
    const text = (flow.changelog ?? "").trim();
    const problem = !text ? "Write what's new in this version" : [...text].length < 10 ? "At least 10 characters" : [...text].length > 4000 ? "At most 4000 characters" : text.startsWith("@") ? "It may not start with @" : p.changelog && text === String(p.changelog).trim() ? "The same as the published version's: write what's new" : null;
    const changelog = field(`What's new in ${e.version}`, area, { about: "Required for an update: the catalog shows it with the new version.", count: `${[...text].length} / 4000`, problem: text ? problem : null });
    area.addEventListener("input", () => {
      flow.changelog = area.value;
      const t = area.value.trim();
      const p2 = !t ? null : [...t].length < 10 ? "At least 10 characters" : [...t].length > 4000 ? "At most 4000 characters" : t.startsWith("@") ? "It may not start with @" : p.changelog && t === String(p.changelog).trim() ? "The same as the published version's: write what's new" : null;
      changelog.set({ count: `${[...t].length} / 4000`, problem: p2 });
      refreshSend();
    });
    nodes.push(changelog.row);
    blocked ??= problem;
    const box = section("Update", ...nodes);
    box.classList.add("publish-update");
    return { exists: true, parts: [box], blocked };
  }

  // The AI usage and its explanation, noted in the project as they are given (publish.ai, EMU-359): the step opens with
  // them again. While another job of the project runs it is refused as busy; the next change notes them, and Send
  // notes what it sends (github.request).
  const aiKey = (ai, note) => `${ai}\n${needsNote(ai) ? String(note ?? "").replace(/\s+/g, " ").trim() : ""}`;
  let aiTimer = null;
  async function saveAi() {
    clearTimeout(aiTimer);
    if (!flow?.ai || !actions()?.publish?.ai) return;
    const key = aiKey(flow.ai, flow.aiNote);
    if (key === flow.aiSaved || noteLength(flow.aiNote) > MAX_AI_NOTE) return;
    const folder = flow.folder;
    const answer = await act(() => actions().publish.ai({ folder, ai: flow.ai, note: needsNote(flow.ai) ? (flow.aiNote ?? "") : null }));
    if (flow?.folder === folder && answer?.ok !== false) flow.aiSaved = key;
  }
  function saveAiSoon() {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => void saveAi(), 400);
  }

  /** Send's state as What's new is typed, without drawing the step anew (the field keeps its caret). */
  let sendTimer = null;
  function refreshSend() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => {
      // What's new, or the explanation of the AI usage (EMU-359): the one typed in keeps its caret.
      const field = ["publish-changelog", "publish-ai-note"].map((id) => document.getElementById(id)).find((one) => one && document.activeElement === one);
      const at = field ? [field.id, field.selectionStart, field.selectionEnd] : null;
      render();
      if (at) {
        const again = document.getElementById(at[0]);
        again?.focus();
        again?.setSelectionRange?.(at[1], at[2]);
      }
    }, 250);
  }

  /** Publish into <repository>?: what changes, the files only the repository has, kept unless ticked. */
  function confirmIntoPart(w, count) {
    const at = `github.com/${w.owner}/${w.name}`;
    const parts = [muted(`A new commit on its default branch, ${w.branch}, with the project's ${count}. Files of the same name get the project's version; the repository's history stays as it is. Nothing is force-pushed.`)];
    const extra = w.extra ?? [];
    if (extra.length) {
      const tick = make("input");
      tick.type = "checkbox";
      tick.checked = flow.deleteOthers === true;
      tick.addEventListener("change", () => {
        flow.deleteOthers = tick.checked;
        render();
      });
      const label = make("label", "choice");
      const w2 = make("span", "words");
      const names = extra.slice(0, 5).join(", ") + (extra.length > 5 ? `, and ${extra.length - 5} more` : "");
      w2.append(make("b", "", `Also delete the ${extra.length === 1 ? "file" : `${extra.length} files`} the project doesn't have`), make("span", "", `${names}. Unless you tick this, ${extra.length === 1 ? "it stays" : "they stay"}.`));
      label.append(tick, w2);
      const box = make("div", "publish-choices one");
      box.append(label);
      parts.push(box);
    }
    const row = make("div", "publish-row");
    const go = button("btn solid", `Publish into ${w.name}`, () => pushToGithub({ head: w.head, deleteOthers: flow.deleteOthers === true }), { picture: "upload" });
    go.dataset.part = "publish-into";
    row.append(go, button("btn", "Cancel", () => ((flow.confirmInto = false), render())));
    parts.push(row);
    const box = section(`Publish into ${at}?`, ...parts);
    box.classList.add("publish-confirm");
    return box;
  }

  globalThis.emulatorPublish = Object.freeze({ open, close, isOpen: () => !root.hidden });
})();
