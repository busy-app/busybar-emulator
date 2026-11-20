// What a person keeps in the emulator's data folder, read from its files, and what an update may change of it: the
// checks of the update chain after each step (EMU-341, update-chain.mjs), and of the moves between formats
// (test/unit/update-chain.test.mjs runs them on the folders the releases wrote, test/server/data-folders/).
//
// Read straight from the files, by the layout of the folder's format (packages/server/data-folder.mjs): format 1 kept
// a BUSY Bar for each firmware, and the one a person used is that of 1.3.1, the firmware every release of that format
// ran by default; from format 2 there is one BUSY Bar, bar/ext. Nothing here writes.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** The BUSY Bar's storage (its /ext) in a folder of `format`. */
export function barExt(dataDir, format) {
  return format === 1 ? path.join(dataDir, "bar", "1.3.1", "ext") : path.join(dataDir, "bar", "ext");
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** Every file under `dir` by its path with "/", and its SHA-256; {} when there is no such folder. */
function sums(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  const walk = (at, rel) => {
    for (const name of readdirSync(at).sort()) {
      if (name.startsWith("._")) continue;
      const file = path.join(at, name);
      const key = rel ? `${rel}/${name}` : name;
      if (lstatSync(file).isDirectory()) walk(file, key);
      else out[key] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

/**
 * The state of the data folder `dataDir`: its format; each app on the BUSY Bar with the sums of its files, its
 * settings' values and the sums of its data (/ext/apps_data/js_apps/<id>); the firmware last chosen; the projects and
 * the folders trusted; whether the first question was answered; install.json; whether the windows' storage is there.
 */
export function readState(dataDir) {
  const formatText = existsSync(path.join(dataDir, "format")) ? readFileSync(path.join(dataDir, "format"), "utf8") : "";
  const format = Number(formatText.split(/\r?\n/, 1)[0]) || null;
  const ext = barExt(dataDir, format);
  const apps = {};
  const assets = path.join(ext, "user_assets");
  for (const id of existsSync(assets) ? readdirSync(assets).filter((name) => !name.startsWith(".")).sort() : []) {
    apps[id] = {
      files: sums(path.join(assets, id)),
      settings: readJson(path.join(ext, "apps_data", "jsrunner", `${id}.settings.json`))?.values ?? null,
      data: sums(path.join(ext, "apps_data", "js_apps", id)),
    };
  }
  const registry = readJson(path.join(dataDir, "projects", "registry.json"));
  const trusted = readJson(path.join(dataDir, "projects", "trusted.json"));
  const settings = readJson(path.join(dataDir, "app-settings.json"));
  return {
    format,
    apps,
    chosenFirmware: readJson(path.join(dataDir, "bar", "chosen-firmware.json"))?.version ?? null,
    projects: (registry?.projects ?? []).map((p) => ({ path: p.path, id: p.id ?? null })),
    trusted: (trusted?.projects ?? []).map((p) => ({ path: p.path, how: p.how ?? null })),
    welcomed: settings?.welcomed === true,
    install: readJson(path.join(dataDir, "install.json")),
    windowStorage: existsSync(path.join(dataDir, "shell")),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What an update from the state `before` to `after` lost or changed that it must keep, a line each; [] when nothing.
 * Kept: every app with its files, settings and data; the firmware chosen (unless `firmwareMayChange`: the new version
 * no longer has it); the projects, the trusted folders, the first question's answer, the windows' storage; install.json
 * at the same paths. Changed as it must: install.json names `version`; the format is the same or newer. Apps the
 * person added in between are not this function's business: `before` is what must still be there.
 */
export function lostInUpdate(before, after, { version, firmwareMayChange = false } = {}) {
  const lost = [];
  if (!(after.format >= before.format)) lost.push(`the format went from ${before.format} to ${after.format}`);
  for (const [id, app] of Object.entries(before.apps)) {
    const now = after.apps[id];
    if (!now) {
      lost.push(`the app ${id} is no longer on the BUSY Bar`);
      continue;
    }
    for (const [file, sum] of Object.entries(app.files)) if (now.files[file] !== sum) lost.push(`${id}: ${file} ${now.files[file] ? "changed" : "is gone"}`);
    if (!same(app.settings, now.settings)) lost.push(`${id}: its settings were ${JSON.stringify(app.settings)}, now ${JSON.stringify(now.settings)}`);
    for (const [file, sum] of Object.entries(app.data)) if (now.data[file] !== sum) lost.push(`${id}: its data ${file} ${now.data[file] ? "changed" : "is gone"}`);
  }
  if (!firmwareMayChange && before.chosenFirmware !== null && after.chosenFirmware !== before.chosenFirmware) lost.push(`the firmware chosen was ${before.chosenFirmware}, now ${after.chosenFirmware}`);
  if (!same(before.projects, after.projects)) lost.push(`the projects were ${JSON.stringify(before.projects)}, now ${JSON.stringify(after.projects)}`);
  if (!same(before.trusted, after.trusted)) lost.push(`the trusted folders were ${JSON.stringify(before.trusted)}, now ${JSON.stringify(after.trusted)}`);
  if (before.welcomed && !after.welcomed) lost.push("the first question is no longer answered");
  if (before.windowStorage && !after.windowStorage) lost.push("the windows' storage (shell/) is gone");
  if (before.install) {
    if (!after.install) lost.push("install.json is gone");
    else {
      if (after.install.cli !== before.install.cli) lost.push(`install.json names the command line at ${after.install.cli}, not ${before.install.cli}`);
      if (after.install.app !== before.install.app) lost.push(`install.json names the app at ${after.install.app}, not ${before.install.app}`);
      if (version && after.install.version !== version) lost.push(`install.json names version ${after.install.version}, not ${version}`);
    }
  }
  return lost;
}
