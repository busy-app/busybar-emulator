// What the emulator asks the person and only the person may answer: whether they trust a project folder the emulator
// did not create (ADR-0012 section 4; `busy-emulator trust <folder>`), whether apps on the bar may reach a port of
// this computer (section 5; `busy-emulator allow-local <port>`, which an agent with a shell could otherwise run
// itself: audit, 11.11), and whether a program may publish a project to GitHub or send it to the catalog
// (`busy-emulator publish push|pr`, ask.confirm below): the same rules for all.
//
// The question comes from the server over the supervisor's channel (server-process.mjs) and is shown here, by the
// main process, as a dialog of the system's. The answer is the click in that dialog and nothing else: no page has a
// way to it (it is not on the bridge, and a page cannot press a button of a native dialog), no address of the server
// takes an answer, and the command line that asked can only wait. "Don't Trust" is the default button and what
// closing the dialog means. One question is shown at a time.
//
// The dialog always hangs on the app's main window (a sheet on macOS), which is first brought to the screen and to
// the front. A dialog without a window cannot be taken away on macOS (Electron: `signal` does nothing for a message
// box without a parent): when nobody answered in time it would stay, a late click on "Trust" would land on a request
// that is over, and every later question would wait behind it. So without a window to hang it on, nobody is asked.
//
// A click on "Trust" that comes within a second of the dialog's appearing is not taken: the dialog takes the focus
// from whatever the person was doing, and a click or a key meant for that must not trust a folder. The question is
// shown again; after three such clicks it is given up.
//
// Pure but for what it is given: `showMessageBox` is Electron's dialog.showMessageBox (or a test's stand-in), so the
// rules can be tested on plain Node.

/** The texts of the trust dialog (docs/quality.md, "Texts": English, one voice, what happens and what to do). */
export const TRUST_DIALOG = Object.freeze({
  message: "Trust this project folder?",
  // `opened`: the person chose the folder themselves, in the app's Open App Folder dialog; otherwise a program asks.
  detail: (folder, opened = false) =>
    [
      folder,
      "",
      opened
        ? "You opened this folder. BUSY Bar Emulator did not create the app project in it, so it asks before it builds it."
        : "A program on this computer (busy-emulator trust, most likely run by your coding agent) asks to build the app project in this folder.",
      "",
      "Building it runs code from the folder on this computer: its dependencies, its npm settings and its build scripts. Trust it only if the project is yours or you know where it came from.",
      "",
      "BUSY Bar Emulator remembers the folders you trust. Projects it created itself are trusted already.",
    ].join("\n"),
  // The order of the system's custom: the safe choice first, and the default.
  buttons: Object.freeze(["Don't Trust", "Trust"]),
  refuse: 0,
  trust: 1,
});

/** The texts of the question about a port of this computer (allow-local). */
export const LOCAL_PORT_DIALOG = Object.freeze({
  message: (port) => `Let apps on the BUSY Bar reach port ${port} of this computer?`,
  detail: (port) =>
    [
      `A program on this computer (busy-emulator allow-local ${port}, most likely run by your coding agent) asks to let apps on the emulated BUSY Bar reach port ${port} of this computer.`,
      "",
      "Whatever listens there (a database, a development server) answers them then, and what it answers can be sent on. An app on a real BUSY Bar does not reach your computer this way.",
      "",
      "Allow it only if you are making the app together with that service. It stays allowed until the emulator quits.",
    ].join("\n"),
  buttons: Object.freeze(["Don't Allow", "Allow"]),
  refuse: 0,
  allow: 1,
});

/** What a question of each kind shows, and what its yes is called. */
function dialogOf(question, opened) {
  if (question?.kind === "trust-folder" && typeof question.path === "string" && question.path) {
    return { about: question.path, message: TRUST_DIALOG.message, detail: TRUST_DIALOG.detail(question.path, opened === true), buttons: TRUST_DIALOG.buttons, refuse: TRUST_DIALOG.refuse, yes: TRUST_DIALOG.trust, answer: "trust", word: "Trust" };
  }
  if (question?.kind === "local-port" && Number.isInteger(question.port) && question.port > 0 && question.port < 65536) {
    return { about: `port ${question.port}`, message: LOCAL_PORT_DIALOG.message(question.port), detail: LOCAL_PORT_DIALOG.detail(question.port), buttons: LOCAL_PORT_DIALOG.buttons, refuse: LOCAL_PORT_DIALOG.refuse, yes: LOCAL_PORT_DIALOG.allow, answer: "allow", word: "Allow" };
  }
  return null;
}

/** A "Trust" sooner than this after the dialog appeared was not a decision. */
export const TRUST_NOT_BEFORE_MS = 1000;
/** How many times the question is shown again after such a click. */
export const TOO_SOON_LIMIT = 3;

/**
 * @param {object} o
 * @param {() => Promise<object | null>} o.windowFor  the app's main window, brought to the screen and to the front,
 *   to hang the dialog on; null when there is none to show
 * @param {(win: object, options: object) => Promise<{ response: number }>} o.showMessageBox  shows the dialog on
 *   that window and resolves with the button's index
 * @param {object} o.config            resolveConfig(): `hidden`, `testTrustAnswer`
 * @param {string} o.appName
 * @param {(line: string) => void} o.log
 * @param {() => number} [o.now]
 * @returns {(question: unknown, signal?: AbortSignal, by?: { opened?: boolean }) => Promise<{ answer: "trust" | "allow" | "refuse" | "unavailable", reason?: string }>}
 *   a question is { kind: "trust-folder", path } or { kind: "local-port", port }; its yes is "trust" or "allow"
 *   `by.opened`: the person chose this very folder in the app's own folder dialog just now (the main process knows;
 *   it is not read from the question, which comes from the server), so the dialog says that, not that a program asks
 */
export function createPersonQuestions({ showMessageBox, windowFor, config, appName, log, now = Date.now }) {
  let open = false;

  /**
   * A yes-or-no question of the app's own (publishing, asked by a program): with the trust question's rules. One
   * question at a time; nothing in a hidden run or without a window; the dialog hangs on the main window and goes when
   * the caller stops waiting; the safe button first and the default; a yes within TRUST_NOT_BEFORE_MS of the dialog's
   * appearing is not taken (shown again, given up after TOO_SOON_LIMIT). `yes`: the index of the button that agrees.
   * Resolves with { answer: "yes" | "no" | "unavailable", checked?, reason? } (`checked`: the dialog's checkbox).
   */
  async function confirm({ about, message, detail, buttons, yes = 1, checkboxLabel = null }, signal) {
    if (config.hidden) return { answer: "unavailable", reason: "the emulator runs hidden and shows no dialog" };
    if (open) return { answer: "unavailable", reason: "another question is open" };
    const takenAway = () => ({ answer: "unavailable", reason: "the question was taken away" });
    if (signal?.aborted) return takenAway();
    open = true;
    try {
      const win = await windowFor();
      if (signal?.aborted) return takenAway();
      if (!win) return { answer: "unavailable", reason: "the emulator has no window on the screen to show the question in" };
      for (let shows = 1; ; shows++) {
        log(`[shell] question (${about}): shown to the person`);
        const shownAt = now();
        const result = await showMessageBox(win, { type: "question", title: appName, message, detail, buttons: [...buttons], defaultId: 0, cancelId: 0, noLink: true, ...(checkboxLabel ? { checkboxLabel, checkboxChecked: false } : {}), signal });
        if (signal?.aborted) return takenAway();
        if (result?.response !== yes) {
          log(`[shell] question (${about}): the person said no`);
          return { answer: "no" };
        }
        if (now() - shownAt >= TRUST_NOT_BEFORE_MS) {
          log(`[shell] question (${about}): the person said yes`);
          return { answer: "yes", checked: result.checkboxChecked === true };
        }
        log(`[shell] question (${about}): a yes ${now() - shownAt} ms after the dialog appeared is not taken`);
        if (shows >= TOO_SOON_LIMIT) return { answer: "unavailable", reason: "the question was answered sooner than a person reads it, three times" };
      }
    } catch (e) {
      log(`[shell] question (${about}): the dialog failed: ${e?.message ?? e}`);
      return { answer: "unavailable", reason: "the dialog could not be shown" };
    } finally {
      open = false;
    }
  }

  async function ask(question, signal, { opened = false } = {}) {
    const shown = dialogOf(question, opened);
    if (!shown) return { answer: "unavailable", reason: "the app does not know this question" };
    const about = shown.about;
    const kind = question.kind === "trust-folder" ? "trust question" : "local port question";
    // The tests' stand-in for the click. config.testTrustAnswer is null in a release whatever its environment says.
    if (config.testTrustAnswer) {
      log(`[shell] ${kind} about ${about}: answered by the test's stand-in (${config.testTrustAnswer})`);
      return { answer: config.testTrustAnswer === "trust" ? shown.answer : "refuse" };
    }
    // A hidden run puts nothing on the screen, and a dialog nobody sees is no question.
    if (config.hidden) return { answer: "unavailable", reason: "the emulator runs hidden and shows no dialog" };
    if (open) return { answer: "unavailable", reason: "another question is open" };
    const takenAway = () => ({ answer: "unavailable", reason: "the question was taken away" });
    if (signal?.aborted) return takenAway();
    open = true;
    try {
      const win = await windowFor();
      if (signal?.aborted) return takenAway();
      if (!win) {
        log(`[shell] ${kind} about ${about}: not asked, the app has no window to show it in`);
        return { answer: "unavailable", reason: "the emulator has no window on the screen to show the question in" };
      }
      for (let shows = 1; ; shows++) {
        log(`[shell] ${kind} about ${about}: shown to the person`);
        const shownAt = now();
        const result = await showMessageBox(win, {
          type: "question",
          title: appName,
          message: shown.message,
          detail: shown.detail,
          buttons: [...shown.buttons],
          defaultId: shown.refuse,
          cancelId: shown.refuse,
          noLink: true,
          signal,
        });
        // A dialog taken away (the caller stopped waiting) was not answered.
        if (signal?.aborted) {
          log(`[shell] ${kind} about ${about}: taken away before an answer`);
          return takenAway();
        }
        if (result?.response !== shown.yes) {
          log(`[shell] ${kind} about ${about}: the person chose ${shown.buttons[shown.refuse]}`);
          return { answer: "refuse" };
        }
        if (now() - shownAt >= TRUST_NOT_BEFORE_MS) {
          log(`[shell] ${kind} about ${about}: the person chose ${shown.word}`);
          return { answer: shown.answer };
        }
        log(`[shell] ${kind} about ${about}: a ${shown.word} ${now() - shownAt} ms after the dialog appeared is not taken`);
        if (shows >= TOO_SOON_LIMIT) return { answer: "unavailable", reason: `${shown.word} was chosen sooner than a person reads the question, three times` };
      }
    } catch (e) {
      log(`[shell] ${kind} about ${about}: the dialog failed: ${e?.message ?? e}`);
      return { answer: "unavailable", reason: "the dialog could not be shown" };
    } finally {
      open = false;
    }
  }
  ask.confirm = confirm;
  return ask;
}
