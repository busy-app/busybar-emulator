// busy-emulator projects: the app projects the emulator has worked with, and which app on the BUSY Bar each one is
// (EMU-260; ../../projects/registry.mjs). create, build, install, run, dev and stop note the project they work on; an
// app installed from an archive has no project and is not here. For every project: its folder, whether the folder is
// still there and trusted, whether it holds a built package, whether its app is on the emulated BUSY Bar and running now
// (null for both when the emulator is not running), and whether its files changed after it last put the app there
// (stale: the window's "Files changed" notice).
//
//   projects --add <folder>     notes a project nobody has built yet; only a trusted one (trust asks the person)
//   projects --forget <folder>  takes a folder out of the list; nothing on the disk or on the BUSY Bar changes
//   projects --prune            the app in the emulator is its project folder: for every project whose folder was
//                               deleted or moved away, its app is stopped and removed from the emulated BUSY Bar and the
//                               project leaves the list. The emulator's app does this by itself while it runs.
//
// A folder that is gone because its disk is gone (an external disk unplugged, a share offline) is unavailable, not
// deleted: --prune leaves it and its app alone, and it works again when the disk is back. --prune waits for a running
// emulator: without one it removes nothing. Nothing inside a project folder is ever deleted.
//
// The list gives no rights: what may be built is the trusted folders' to say (trust).
import { realpathSync } from "node:fs";
import path from "node:path";

import { forgetProject, listProjects, rememberProject } from "../../projects/registry.mjs";
import { isTrusted } from "../../projects/trust.mjs";
import { newestChange } from "../../projects/watch.mjs";
import { emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";
import { again, barAppMark, projectAt, trustCommand } from "../project.mjs";

const USAGE = "projects [--add <folder>] [--forget <folder>] [--prune]";

/** What the emulated bar holds now: the ids of its apps and of the running one; null when it would not say. */
async function onTheBar(ctx, sys) {
  let status;
  try {
    status = await emulatorStatus(ctx, sys);
  } catch {
    return null;
  }
  if (!ready(status)) return null;
  const [list, state] = await Promise.all([sys.barGet(status.port, "/api/apps/list"), sys.barGet(status.port, "/_emu/state")]);
  try {
    const apps = JSON.parse(list.body).apps;
    if (list.status !== 200 || !Array.isArray(apps)) return null;
    let running = null;
    try {
      running = state.status === 200 ? (JSON.parse(state.body).running?.id ?? null) : null;
    } catch {
      // The bar's apps are known; which one runs is not.
    }
    return { port: status.port, installed: new Set(apps.map((app) => app?.id).filter((id) => typeof id === "string")), running };
  } catch {
    return null;
  }
}

/**
 * The projects whose folder was deleted (gone, with its disk there) leave the list. The app of each is stopped and
 * removed from the bar when it is this project's own: the project installed it (its entry holds the mark of what it
 * put there), the bar still holds that very build, and no other project that is still there (or only unavailable) is
 * the same app. An app of the same id that came from elsewhere (an archive, the bar's API, another project's build)
 * stays, and the project is only forgotten. An app the bar would not remove keeps its entry for the next time.
 * @returns {Promise<{ id: string|null, folder: string, uninstalled: boolean }[]>} what left
 */
async function prune(ctx, sys, bar, projects) {
  const removed = [];
  for (const project of projects) {
    if (project.exists || project.unavailable) continue;
    const shared = projects.some((other) => other !== project && other.id === project.id && (other.exists || other.unavailable));
    let uninstalled = false;
    const own = project.put !== null && project.put.id === project.id && !shared && bar.installed.has(project.id) && (await barAppMark(sys, bar.port, project.id)) === project.put.mark;
    if (own) {
      if (bar.running === project.id) {
        await sys.barSend(bar.port, "POST", "/api/apps/quit");
        bar.running = null;
      }
      const answer = await sys.barSend(bar.port, "DELETE", `/api/apps?app_id=${encodeURIComponent(project.id)}`);
      if (answer.status !== 200) continue;
      bar.installed.delete(project.id);
      uninstalled = true;
    }
    forgetProject(ctx.dataDir, project.folder, { platform: ctx.platform });
    removed.push({ id: project.id, folder: project.folder, uninstalled });
  }
  return removed;
}

/**
 * Whether the project's files changed after it last put its app on the bar, which still holds it: the app on the bar
 * is older than its files (the window then offers a Refresh). False when nothing says when it was put there.
 */
function staleOf(project, put, installed) {
  if (!project.exists || !installed || put?.id !== project.id || typeof put?.at !== "string") return false;
  const at = Date.parse(put.at);
  return Number.isFinite(at) && newestChange(project.folder) > at;
}

function shownProject(project) {
  const state = [
    project.unavailable ? "the folder's disk is not there" : !project.exists ? "the folder is gone" : !project.trusted ? "not trusted" : null,
    project.exists && project.built ? "built" : null,
    { failed: "its dependencies are not installed: the last install failed", interrupted: "its dependencies are not installed: the last install was cut off", installing: "installing its dependencies" }[project.dependencies?.state] ?? null,
    project.running ? "running on the BUSY Bar" : project.installed ? "on the BUSY Bar" : null,
    project.stale ? "its files changed since" : null,
  ].filter(Boolean);
  return `  ${project.id ?? "(no app id)"}  ${project.folder}${state.length ? `  (${state.join(", ")})` : ""}`;
}

export default {
  name: "projects",
  summary: "List the app projects the emulator has worked with: the app's id, its folder, whether it is built, on the BUSY Bar, running",
  usage: USAGE,
  options: { "--add": { key: "add", value: "<folder>" }, "--forget": { key: "forget", value: "<folder>" }, "--prune": { key: "prune" } },
  async run(ctx, sys, { options }) {
    if (options.add !== undefined && options.forget !== undefined) throw new CliError("usage", "projects takes --add or --forget, not both.", `Usage: ${again(ctx, USAGE)}`);
    let changed = null;
    if (options.add !== undefined) {
      const project = projectAt(ctx, sys, options.add);
      if (!isTrusted(ctx.dataDir, project.dir, ctx.platform)) {
        throw new CliError("untrusted_project", `${project.dir} is not trusted, so it is not added to the emulator's projects.`, `Run ${trustCommand(ctx, { given: options.add })}: the emulator asks the person, in a dialog on their screen, whether they trust the folder; then add it again.`, { folder: project.dir });
      }
      rememberProject(ctx.dataDir, project.dir, { platform: ctx.platform });
      changed = { added: project.dir };
    }
    if (options.forget !== undefined) {
      // By the folder's real path, and by the path as given: the folder itself may be gone.
      const folder = path.resolve(sys.cwd(), options.forget);
      let real = folder;
      try {
        real = realpathSync.native(folder);
      } catch {
        // Gone: the path as given is all there is.
      }
      if (!forgetProject(ctx.dataDir, real, { platform: ctx.platform }) && !forgetProject(ctx.dataDir, folder, { platform: ctx.platform })) {
        throw new CliError("not_a_project", `${folder} is not among the emulator's projects.`, `${again(ctx, "projects")} lists them, each with its folder.`, { folder });
      }
      changed = { forgotten: folder };
    }
    const bar = await onTheBar(ctx, sys);
    const look = () => listProjects(ctx.dataDir, { platform: ctx.platform, ...(sys.volumePresent ? { present: sys.volumePresent } : {}) });
    let listed = look();
    let removed = null;
    if (options.prune) {
      removed = bar ? await prune(ctx, sys, bar, listed) : [];
      if (removed.length) listed = look();
    }
    const projects = listed.map(({ put, ...project }) => {
      const installed = bar && project.id !== null ? bar.installed.has(project.id) : null;
      return { ...project, installed, running: bar && project.id !== null ? bar.running === project.id : null, stale: staleOf(project, put, installed) };
    });
    const left = (removed ?? []).map((one) => `${one.id ?? "The project"} left: its folder ${one.folder} is gone${one.uninstalled ? ", and the app was removed from the BUSY Bar" : ""}.\n`).join("");
    const head = `${changed?.added ? `Added ${changed.added}.\n` : changed?.forgotten ? `Forgot ${changed.forgotten}; the folder and the BUSY Bar are as they were.\n` : ""}${left}`;
    const text = projects.length
      ? [`${head}The emulator's app projects, the latest first${bar ? "" : " (the emulator is not running: what is on the BUSY Bar is not known)"}:`, ...projects.map(shownProject)].join("\n")
      : `${head}The emulator has worked with no app project yet. ${again(ctx, "create <folder>")} makes one.`;
    return { data: { ...changed, ...(removed ? { removed } : {}), bar: bar ? "ready" : "not_running", projects }, text };
  },
};
