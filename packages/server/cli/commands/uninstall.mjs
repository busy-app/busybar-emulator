// busy-emulator uninstall <id|folder> [--delete-files]: the app leaves the emulator. It is stopped when it runs, removed
// from the emulated BUSY Bar (the BUSY Bar's own DELETE /api/apps, as busy-cli app uninstall does: the app's settings stay on the
// BUSY Bar, and come back if it is installed again; settings reset before uninstall clears them), and every project of the emulator's list that is this app
// leaves the list. The project's folder stays where it is, untouched, unless --delete-files is given: then the folder
// goes to the Trash (the Recycle Bin on Windows), from where it can be put back; nothing is ever deleted for good.
//
// --delete-files moves only the folder of a project of the emulator's list (../../path-boundary.mjs): by its real
// path, never a link to somewhere else, never the home folder, the root of a disk or the data folder. The folder is
// checked before anything changes. The emulator must be running: the BUSY Bar is what the app is removed from.
//
// The window's Delete in the Apps list (packages/app/src/actions.mjs, apps.delete) runs this command without
// --delete-files and moves the folder to the Trash itself, with the system's own call.
import { realpathSync } from "node:fs";
import path from "node:path";

import { forgetProject, listProjects } from "../../projects/registry.mjs";
import { trashableFolder } from "../../path-boundary.mjs";
import { samePath } from "../../same-path.mjs";
import { commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

const USAGE = "uninstall <id|folder> [--delete-files]";
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** A folder, not an id: it has a separator in it, or is the current folder or the one above. */
const looksLikePath = (text) => /[\\/]/.test(text) || text === "." || text === "..";


export default {
  name: "uninstall",
  summary: "Remove an app from the emulator: stop it, take it off the emulated BUSY Bar (its settings stay there, as busy-cli app uninstall keeps them; settings reset clears them), forget its project (--delete-files moves the project folder to the Trash)",
  usage: USAGE,
  maxArguments: 1,
  options: { "--delete-files": { key: "deleteFiles" } },
  async run(ctx, sys, { args, options }) {
    const self = commandLine(ctx);
    const given = args[0];
    if (!given) throw new CliError("usage", "uninstall needs the app's id, or its project's folder.", `Usage: ${self} ${USAGE}. ${self} projects lists the projects with their ids.`);
    const listed = listProjects(ctx.dataDir, { platform: ctx.platform, ...(sys.volumePresent ? { present: sys.volumePresent } : {}) });

    // The app: by its id, or by the folder of one of its projects.
    let id;
    let projects;
    if (looksLikePath(given)) {
      const folder = path.resolve(sys.cwd(), given);
      let real = folder;
      try {
        real = realpathSync.native(folder);
      } catch {
        // Gone: the path as given is all there is.
      }
      const named = listed.filter((one) => samePath(one.folder, real, ctx.platform) || samePath(one.folder, folder, ctx.platform));
      if (!named.length || named[0].id === null) throw new CliError("not_a_project", `${folder} is not among the emulator's projects.`, `${self} projects lists them, each with its folder; or name the app by its id.`, { folder });
      id = named[0].id;
      projects = named;
    } else {
      if (!APP_ID.test(given)) throw new CliError("usage", `${JSON.stringify(given)} is not an app's id.`, `Usage: ${self} ${USAGE}`, { argument: given });
      id = given;
      projects = listed.filter((one) => one.id === id);
    }

    // With --delete-files the folder is checked before anything changes.
    let trashing = null;
    if (options.deleteFiles) {
      const there = projects.filter((one) => one.exists);
      if (!there.length) throw new CliError("no_project_folder", `${id} has no project folder in the emulator's list: it was installed from a package, so there are no files to delete.`, `Run ${self} uninstall ${id} without --delete-files.`, { id });
      if (there.length > 1) throw new CliError("several_folders", `${id} has ${there.length} project folders: ${there.map((one) => one.folder).join(", ")}. Not one is deleted.`, `Name the folder to delete: ${self} uninstall <folder> --delete-files.`, { id, folders: there.map((one) => one.folder) });
      const verdict = trashableFolder(there[0].folder, { registered: listed.map((one) => one.folder), dataDir: ctx.dataDir, home: sys.home?.() ?? null, platform: ctx.platform });
      if (verdict.refused) throw new CliError(verdict.refused.code, verdict.refused.message, "Move the folder to the Trash yourself if you mean it.", { id, folder: there[0].folder });
      trashing = verdict.folder;
    }

    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start, then run ${self} uninstall ${given} again.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar to remove the app from.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
    }
    const { port } = status;
    const list = await sys.barGet(port, "/api/apps/list");
    let installed = false;
    try {
      installed = list.status === 200 && JSON.parse(list.body).apps.some((app) => app?.id === id);
    } catch {
      throw new CliError("bar_failed", "The emulated BUSY Bar did not say which apps it holds.", `Check it with ${self} status.`);
    }
    if (!installed && !projects.length) throw new CliError("not_found", `There is no app ${id} on the emulated BUSY Bar and no project of it.`, `${self} projects lists the projects; the window's Apps list shows what is on the BUSY Bar.`, { id });

    let wasRunning = false;
    const state = await sys.barGet(port, "/_emu/state");
    try {
      wasRunning = state.status === 200 && JSON.parse(state.body).running?.id === id;
    } catch {
      // Which app runs is not known: the bar refuses to remove a running one, and says so below.
    }
    if (wasRunning) await sys.barSend(port, "POST", "/api/apps/quit");
    if (installed) {
      const answer = await sys.barSend(port, "DELETE", `/api/apps?app_id=${encodeURIComponent(id)}`);
      if (answer.status !== 200) throw new CliError("uninstall_failed", `The emulated BUSY Bar did not remove ${id} (${answer.failed ?? `HTTP ${answer.status}`}${answer.body ? `: ${String(answer.body).slice(0, 200)}` : ""}).`, `Try again; ${self} status says whether the BUSY Bar is ready.`, { id });
    }
    const forgotten = [];
    for (const project of projects) if (forgetProject(ctx.dataDir, project.folder, { platform: ctx.platform })) forgotten.push(project.folder);
    const kept = forgotten.filter((folder) => folder !== trashing && projects.find((one) => one.folder === folder)?.exists);

    let trashed = null;
    if (trashing) {
      try {
        await sys.trashFolder(trashing, { platform: ctx.platform, windowsDir: ctx.windowsDir, env: ctx.env });
        trashed = trashing;
      } catch (e) {
        throw new CliError("trash_failed", `${id} was removed from the emulator, but its folder ${trashing} could not be moved to the ${ctx.platform === "win32" ? "Recycle Bin" : "Trash"}: ${e?.message ?? e}.`, "The folder is as it was; move it yourself.", { id, removed_from_bar: installed, was_running: wasRunning, forgotten, folder: trashing });
      }
    }

    const bin = ctx.platform === "win32" ? "the Recycle Bin" : "the Trash";
    const text = [
      installed ? `Removed ${id} from the emulated BUSY Bar${wasRunning ? " (it was stopped first)" : ""}.` : `${id} was not on the emulated BUSY Bar.`,
      forgotten.length ? `The emulator forgot its project${forgotten.length > 1 ? "s" : ""}.` : null,
      trashed ? `Moved ${trashed} to ${bin}.` : null,
      kept.length ? `The files stay in ${kept.join(", ")}.` : null,
    ].filter(Boolean).join(" ");
    return { data: { id, removed_from_bar: installed, was_running: wasRunning, forgotten, kept, trashed }, text };
  },
};
