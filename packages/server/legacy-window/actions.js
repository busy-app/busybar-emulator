// window.emulatorActions: what the window may do to app projects, behind one contract (README.md beside this file).
// The work is done by the app's main process, which this page reaches through the shell's bridge (window.busyShell,
// given by the app to its main window only). In a plain browser there is no bridge: available() says so, and every
// action rejects. No styling and no elements here: the page decides what a button looks like and what it shows.
(() => {
  const bridge = window.busyShell && typeof window.busyShell.action === "function" ? window.busyShell : null;
  const NO_SHELL = "This works in the BUSY Bar Emulator app, not in a browser.";
  const listeners = new Set();
  const captureListeners = new Set(); // the recording's news (the canvas's Record button)
  const updateListeners = new Set(); // the built-in update's state (the top bar's Update)
  const menuListeners = new Set(); // the app menu's items for the page: "create" (New App…), "report" (Report a Bug…)

  async function call(name, arg) {
    if (!bridge) throw Object.assign(new Error(NO_SHELL), { code: "no_shell", hint: null });
    let answer;
    try {
      answer = await bridge.action(name, arg);
    } catch {
      throw Object.assign(new Error("The emulator's app did not take the request."), { code: "refused", hint: null });
    }
    if (answer && answer.ok) return answer.value;
    const error = (answer && answer.error) || {};
    throw Object.assign(new Error(error.message || "The emulator's app could not do it."), { code: error.code || "failed", hint: error.hint || null });
  }

  /** Report a Bug's fields as the app takes them; the screenshot only where it is used. */
  function reportFields(fields, withImage) {
    const o = fields || {};
    const out = { title: String(o.title || ""), what: String(o.what || ""), expected: String(o.expected || ""), log: o.log !== false, screenshot: o.screenshot === true };
    if (withImage && out.screenshot && typeof o.image === "string") out.image = o.image;
    return out;
  }

  if (bridge && typeof bridge.onMenu === "function") {
    bridge.onMenu((item) => {
      if (item !== "create" && item !== "report") return;
      for (const listener of [...menuListeners]) {
        try {
          listener(item);
        } catch (e) {
          console.error(e);
        }
      }
    });
  }

  if (bridge) {
    bridge.onJob((job) => {
      for (const listener of [...(job && job.update === true ? updateListeners : job && job.capture === true ? captureListeners : listeners)]) {
        try {
          listener(job);
        } catch (e) {
          console.error(e);
        }
      }
    });
  }

  window.emulatorActions = Object.freeze({
    available: () => ({ shell: Boolean(bridge) }),
    projects: Object.freeze({
      list: () => call("projects.list"),
      examples: () => call("projects.examples"),
      /** Without `place`, the system's folder dialog; with it, Create app's form: { place, name, id, texts, icon }. */
      create: (options) => {
        const o = options || {};
        const asked = { example: o.example || null };
        for (const key of ["place", "name", "id", "texts", "icon"]) if (o[key] !== undefined && o[key] !== null) asked[key] = o[key];
        return call("projects.create", asked);
      },
      /** Where Create app would make the new project's folder: { parent, shown, folder, path, shownPath, namespace }. */
      place: (options) => call("projects.place", { parent: (options && options.parent) || null, folder: (options && options.folder) || null }),
      /** Create app's Location: the system's dialog for the folder the project's folder goes in; null when closed. */
      choosePlace: (options) => call("projects.place.choose", { from: (options && options.from) || null }),
      open: () => call("projects.open"),
      /**
       * Create app's Open existing: the system's dialog for the app's folder or any file in it (`pick` "any", "folder" or
       * "file"), and the project around it, opened by nothing yet: { found, folder, shownFolder, id, name, listed,
       * trusted, chosen, shownChosen } or { found: false, message, chosen, shownChosen }; null when closed.
       */
      find: (options) => call("projects.find", { pick: (options && options.pick) || "any" }),
      /** Open existing's Open: the project `find` found, through the trust dialog, then built and started once. */
      import: (folder) => call("projects.import", folder),
      refresh: (folder) => call("projects.refresh", folder),
      /** Retry: the project's dependencies installed again, nothing built (a project created without the network). */
      dependencies: (folder) => call("projects.dependencies", folder),
      /** The same by itself, when the network may be back: for every project whose install failed for the network. */
      retryDependencies: () => call("projects.dependencies.auto"),
      build: (folder) => call("projects.build", folder),
      run: (folder) => call("projects.run", folder),
      stop: (folder) => call("projects.stop", folder),
      dev: Object.freeze({
        start: (folder) => call("projects.dev.start", folder),
        stop: (folder) => call("projects.dev.stop", folder),
      }),
      check: (folder) => call("projects.check", folder),
      submit: (folder) => call("projects.submit", folder),
      /**
       * Create app's Install a package: the system's dialog for an app package (.tgz), then the command line's look at
       * it, the dialog that asks whether to install it, and the install and start on the emulated BUSY Bar: { ok, id,
       * name, version, running, message, file }, { ok: false, code: "declined" } after Cancel, or why not; null when
       * no file was chosen.
       */
      installPackage: () => call("projects.package.install"),
    }),
    /**
     * Delete in the Apps list: the app leaves the emulator (stopped, off the bar, its projects forgotten); with
     * withFiles its project folder goes to the Trash too. → { ok, id, trashed, kept, message } or { ok: false, … }.
     */
    apps: Object.freeze({
      delete: (options) => call("apps.delete", { id: (options && options.id) || null, withFiles: Boolean(options && options.withFiles === true) }),
    }),
    /** Whether the console can be opened in the system's terminal: { available, name, label, why }. */
    terminalInfo: () => call("terminal.info"),
    /** The console in the system's terminal, with the console's filters; `app` null is every app's lines. */
    openTerminal: (options) => {
      const o = options || {};
      return call("terminal.open", { app: o.app ?? null, folder: o.folder ?? null, kinds: Array.isArray(o.kinds) ? [...o.kinds] : o.kinds, since: o.since ?? null });
    },
    // Publishing, stage 1: busy-emulator publish and catalog-texts on a project of the list.
    publish: Object.freeze({
      status: (folder) => call("publish.status", folder),
      check: (folder) => call("publish.check", folder),
      texts: ({ folder, name, texts }) => call("publish.texts", { folder, name: name ?? null, texts }),
      /** Application Info's Upload icon: PNGs of 8×8 (front) and, optionally, 11×11 (back), as data: addresses. */
      icon: ({ folder, front, back }) => call("publish.icon", { folder, front, back: back ?? null }),
      /** `upload`: true for either display, or "front" or "back" for that display's button. */
      screenshots: ({ folder, take, upload, order, remove }) => call("publish.screenshots", { folder, take, upload: upload === true || upload === "front" || upload === "back" ? upload : undefined, order, remove }),
      readme: ({ folder, readme }) => call("publish.readme", { folder, readme }),
      /** With `upload: true` (Another license): the system's dialog for the file; `replace: true` answers "replace it?". */
      license: ({ folder, license, author, upload, replace }) => call("publish.license", { folder, license, author, upload: upload === true ? true : undefined, replace: replace === true ? true : undefined }),
      files: ({ folder, write, keepOut, keepIn, readme }) => call("publish.files", { folder, write, keepOut, keepIn, readme }),
      /** With { build: true }: Build and package, the build first, in the one action of the click. */
      package: (folder, options) => call("publish.package", options && options.build === true ? { folder, build: true } : folder),
    }),
    /** The canvas's Screenshot and Record buttons; `target` is { folder, name } of the running app (folder null: none). */
    capture: Object.freeze({
      screenshot: (target) => call("capture.screenshot", { folder: (target && target.folder) || null, name: (target && target.name) || null, ...(target && Array.isArray(target.displays) ? { displays: [...target.displays] } : {}) }),
      record: Object.freeze({
        start: (target) => call("capture.record.start", { folder: (target && target.folder) || null, name: (target && target.name) || null, layout: (target && target.layout) || "window" }),
        stop: () => call("capture.record.stop"),
        state: () => call("capture.record.state"),
      }),
      reveal: (file) => call("capture.reveal", file),
    }),
    // Publishing, stage 2: the app signs in to GitHub and talks to it; the page gets the login, never the token.
    github: Object.freeze({
      status: () => call("github.status"),
      signIn: () => call("github.signin"),
      useExisting: (login) => call("github.use", typeof login === "string" && login ? { login } : {}),
      waitSignIn: () => call("github.signin.wait"),
      cancelSignIn: () => call("github.signin.cancel"),
      openCodePage: () => call("github.code.open"),
      signOut: ({ signOutCli = false, switchBack = false } = {}) => call("github.signout", { signOutCli: signOutCli === true, switchBack: switchBack === true }),
      checkName: ({ folder, name }) => call("github.name", { folder, name }),
      // `into`: { head, deleteOthers } once the person confirmed Publish into their own repository (catalog-update).
      push: ({ folder, name, into = null }) => call("github.push", { folder, name: name ?? null, ...(into ? { into: { head: into.head, deleteOthers: into.deleteOthers === true } } : {}) }),
      /** Cancel of an upload under way. */
      cancel: () => call("github.cancel"),
      /** The catalog's author checklist: its pull request template, read now (or the copy bundled with the app). */
      checklist: ({ catalog }) => call("github.checklist", { catalog }),
      request: ({ folder, catalog, ticked, ai, changelog = null, otherCatalog = null }) => call("github.request", { folder, catalog, ticked: Array.isArray(ticked) ? ticked.filter((one) => typeof one === "string") : [], ai, ...(typeof changelog === "string" ? { changelog } : {}), ...(typeof otherCatalog === "string" ? { otherCatalog } : {}) }),
      /** What the catalog has of the app now: an update or not, the published version and What's new (catalog-update). */
      entry: ({ folder, catalog }) => call("github.entry", { folder, catalog: catalog ?? null }),
      /** The repository Import from GitHub would get. */
      lookup: (repo) => call("github.lookup", { repo }),
      /** Import from GitHub: downloaded into { parent, folder }, then opened as Open existing opens a project. */
      importRepo: ({ repo, place }) => call("github.import", { repo, place }),
      /** A repository that is no app project: its latest release's .tgz, downloaded and installed as installPackage does. */
      installRelease: ({ repo }) => call("github.release.install", { repo }),
    }),
    /**
     * Report a Bug: preview(fields) → { title, body, length, limit, fits, over, lines, repository }, the issue's text
     * as it would open; open(fields) opens it in the browser; save(fields) the diagnostics archive, in the system's Save
     * dialog → { saved, file, shown }; reveal() shows the archive just saved. fields: { title, what, expected, log,
     * screenshot, image } (image: the bar's screenshot as a PNG data: address, for the clipboard and the archive).
     */
    report: Object.freeze({
      preview: (fields) => call("report.preview", reportFields(fields, false)),
      open: (fields) => call("report.open", reportFields(fields, true)),
      save: (fields) => call("report.save", reportFields(fields, true)),
      reveal: () => call("report.reveal"),
    }),
    /**
     * The built-in update: state() → { state, version, current, canInstall, why?, received?, total?, message?, hint? }
     * (state: none, available, downloading, preparing, ready, restarting, failed); download() is Update to <version>,
     * restart() is Restart to update, which the app confirms in a dialog of its own. popup() → whether the update's
     * pop-up shows now: { show: true, version, current, canInstall, why?, page, summary? } (summary: { kind: "list" or
     * "text", lines }), or { show: false, retryMs } (ask again then; null: when the state changes). A yes is given
     * once per version in a run.
     */
    update: Object.freeze({
      state: () => call("update.state"),
      download: () => call("update.download"),
      restart: () => call("update.restart"),
      popup: () => call("update.popup"),
    }),
    reveal: (path) => call("reveal", path),
    open: (path) => call("open", path),
    copy: (text) => call("copy", text),
    /** A page of the emulated bar (its address, its API documentation) in the system's browser. */
    browse: (address) => call("browse", address),
    /**
     * The first run's greeting: get() → { show, way, platform, cli }; seen({ way }) writes down that it was answered,
     * and the way chosen ("code" or "agent"), if one was.
     */
    welcome: Object.freeze({
      get: () => call("welcome.get"),
      seen: (answer) => call("welcome.seen", answer && (answer.way === "code" || answer.way === "agent") ? { way: answer.way } : undefined),
    }),
    /**
     * on("job", cb): cb({ id, kind, folder, state, line?, upload? }); on("capture", cb): cb({ kind: "recording", state, … });
     * on("menu", cb): cb("create"), the app menu's New App…; cb("report"), its Report a Bug…; on("update", cb):
     * cb(the update's state, as update.state() gives it).
     * Returns a function that takes the listener away.
     */
    on(event, listener) {
      if (!["job", "capture", "menu", "update"].includes(event) || typeof listener !== "function") throw new TypeError('emulatorActions.on takes "job", "capture", "menu" or "update" and a function');
      const set = event === "capture" ? captureListeners : event === "menu" ? menuListeners : event === "update" ? updateListeners : listeners;
      set.add(listener);
      return () => void set.delete(listener);
    },
  });
})();
