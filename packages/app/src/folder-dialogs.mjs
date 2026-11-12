// The folder dialogs of the window's actions (actions.mjs): where a new app project goes, and which project to open.
// They are dialogs of the system's, shown by the main process; the page names no folder and cannot answer one.
//
// A hidden run puts nothing on the screen, so there nobody chooses: the answer is "none". The tests' stand-in for the
// person's choice is put in through the test entry (test-variant/hook.mjs), which a release does not have and never
// connects: `config.testHook` is null in a release whatever its environment says.
//
// Pure but for what it is given: `showOpenDialog` is Electron's dialog.showOpenDialog, or a test's stand-in.
import path from "node:path";

export const FOLDER_DIALOGS = Object.freeze({
  create: Object.freeze({ title: "New App", message: "Choose or make an empty folder: the app's project is created in it.", button: "Create Here" }),
  open: Object.freeze({ title: "Open App Folder", message: "Choose the folder of an app project.", button: "Open" }),
  // Create app's Location: the folder the new project's own folder is made in.
  parent: Object.freeze({ title: "Location", message: "Choose the folder the app's project folder goes in. You can make a new one here.", button: "Choose" }),
  // Create app's Open existing: the app's folder, or any file in it (project-root.mjs finds the project around it).
  find: Object.freeze({ title: "Open Existing App", message: "Choose the app's folder, or any file in it.", button: "Choose" }),
  // Publish's Screenshots: PNGs made before, one or more; for one display, or for either.
  screenshots: Object.freeze({ title: "Upload Screenshots", message: "Choose PNG screenshots: 72×16 for the front display, 160×80 for the back, or an exact enlargement.", button: "Upload" }),
  "screenshots-front": Object.freeze({ title: "Upload Front Screenshots", message: "Choose PNG screenshots of the front display: 72×16, or an exact enlargement.", button: "Upload" }),
  "screenshots-back": Object.freeze({ title: "Upload Back Screenshots", message: "Choose PNG screenshots of the back display: 160×80, or an exact enlargement.", button: "Upload" }),
  // Publish's License: the person's own license's text, copied in as LICENSE.
  license: Object.freeze({ title: "Upload License File", message: "Choose your license's text file: LICENSE, LICENSE.md or COPYING.", button: "Upload" }),
  // Create app's Install a package: an app package someone built (.tgz), to install on the emulated BUSY Bar.
  package: Object.freeze({ title: "Install a Package", message: "Choose an app package (.tgz), as busy-cli build makes it.", button: "Choose" }),
});

/**
 * @param {object} o
 * @param {(options: object) => Promise<{ canceled: boolean, filePaths: string[] }>} o.showOpenDialog  in front of the
 *   app's window when it has one
 * @param {object} o.config        resolveConfig(): `hidden`, `testHook`
 * @param {string} o.startFolder   where the dialogs open the first time: the person's documents
 * @param {(line: string) => void} o.log
 * @param {() => void} [o.comeForward]
 * @param {string} [o.platform]
 */
export function createFolderDialogs({ showOpenDialog, config, startFolder, log, comeForward = () => {}, platform = process.platform }) {
  const standIns = []; // the tests' answers, in the order they are asked for
  let open = false;
  let last = startFolder;
  let shotsFrom = startFolder; // where the screenshots were chosen last

  /**
   * What Open existing's dialog lets the person choose. macOS has one dialog for a folder or a file; on Windows and
   * Linux a dialog is one or the other (Electron shows a folder dialog when both are asked for), so the page offers
   * two buttons there and says which.
   */
  const findProperties = (pick) => {
    if (pick === "file") return ["openFile", "dontAddToRecent"];
    if (pick === "any" && platform === "darwin") return ["openFile", "openDirectory", "dontAddToRecent"];
    return ["openDirectory", "dontAddToRecent"];
  };

  async function choose(kind, from = null, pick = null) {
    const texts = FOLDER_DIALOGS[kind];
    if (config.testHook && standIns.length) {
      const answer = standIns.shift();
      log(`[shell] folder dialog (${texts.title}): answered by the test's stand-in`);
      return answer;
    }
    if (config.hidden) return null;
    if (open) return null;
    open = true;
    try {
      comeForward();
      if (kind === "package") {
        const result = await showOpenDialog({ title: texts.title, message: texts.message, buttonLabel: texts.button, defaultPath: from ?? last, filters: [{ name: "App package", extensions: ["tgz"] }], properties: ["openFile", "dontAddToRecent"] });
        const file = result?.canceled ? null : (result?.filePaths?.[0] ?? null);
        if (typeof file !== "string" || !path.isAbsolute(file)) return null;
        last = path.dirname(file);
        return file;
      }
      if (kind === "license") {
        const result = await showOpenDialog({ title: texts.title, message: texts.message, buttonLabel: texts.button, defaultPath: from ?? last, properties: ["openFile", "dontAddToRecent"] });
        const file = result?.canceled ? null : (result?.filePaths?.[0] ?? null);
        return typeof file === "string" && path.isAbsolute(file) ? file : null;
      }
      if (kind.startsWith("screenshots")) {
        const result = await showOpenDialog({ title: texts.title, message: texts.message, buttonLabel: texts.button, defaultPath: from ?? shotsFrom, filters: [{ name: "PNG", extensions: ["png"] }], properties: ["openFile", "multiSelections", "dontAddToRecent"] });
        const files = result?.canceled ? [] : (result?.filePaths ?? []).filter((file) => typeof file === "string" && path.isAbsolute(file));
        if (files.length) shotsFrom = path.dirname(files[0]);
        return files.length ? files : null;
      }
      const result = await showOpenDialog({
        title: texts.title,
        message: texts.message,
        buttonLabel: texts.button,
        defaultPath: from ?? last,
        // A folder, never a file (but for Open existing); a new one can be made in the dialog (macOS has the button,
        // Windows the menu).
        properties: kind === "find" ? findProperties(pick) : kind === "open" ? ["openDirectory", "dontAddToRecent"] : ["openDirectory", "createDirectory", "promptToCreate", "dontAddToRecent"],
      });
      const folder = result?.canceled ? null : (result?.filePaths?.[0] ?? null);
      if (typeof folder !== "string" || !path.isAbsolute(folder)) return null;
      last = kind === "parent" ? folder : path.dirname(folder);
      return folder;
    } catch (e) {
      log(`[shell] folder dialog (${texts.title}) failed: ${e?.message ?? e}`);
      return null;
    } finally {
      open = false;
    }
  }

  return {
    /** An empty folder the person chose or made, for a new project; null when they chose none. */
    chooseNew: () => choose("create"),
    /** The folder of a project the person chose; null when they chose none. */
    chooseExisting: () => choose("open"),
    /** Where a new project's folder goes, chosen or made in the dialog (it opens at `from`); null when they chose none. */
    chooseParent: (from = null) => choose("parent", from),
    /**
     * Open existing's choice: a folder or a file (`pick` "any", which is a folder outside macOS), a folder ("folder")
     * or a file ("file"); null when they chose none.
     */
    chooseAny: (pick = "any") => choose("find", null, ["any", "folder", "file"].includes(pick) ? pick : "any"),
    /** PNG files the person chose, for Publish's Screenshots; null when they chose none. */
    chooseScreenshots: (display = null) => choose(display === "front" || display === "back" ? `screenshots-${display}` : "screenshots"),
    /** The text file of the person's own license, for Publish's License; null when they chose none. */
    chooseLicense: () => choose("license"),
    /** An app package (.tgz) the person chose, for Install a package; null when they chose none. */
    choosePackage: () => choose("package"),
    /** For the tests: what the next dialog answers (a folder, or null for "none"). Does nothing without the test entry. */
    standIn(answer) {
      if (config.testHook) standIns.push(answer);
    },
  };
}
