// What the app itself did for each project in Publish stage 2, kept in its own data folder (github/published.json),
// not in the project: the repository it published the project to, the repository it downloaded the project from
// (Create app's Import from GitHub), and the flagged files the person chose to publish anyway with a click in the window.
//
// The project's .busy/publish.json says the same for the window and the manifest, but a project can arrive with that
// file in it (downloaded, or written by `busy-emulator publish pushed`), so it decides nothing: only this record lets
// a push replace the files of an existing repository, or publish a file that looks like a secret.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const RECORD_FILE = path.join("github", "published.json");

/** @param {string} dataDir  the app's data folder */
export function createPublishRecord(dataDir) {
  const file = path.join(dataDir, RECORD_FILE);
  const read = () => {
    try {
      const all = JSON.parse(readFileSync(file, "utf8"));
      return all && typeof all === "object" && !Array.isArray(all) ? all : {};
    } catch {
      return {};
    }
  };
  const write = (all) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const part = `${file}.${process.pid}.part`;
    writeFileSync(part, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    renameSync(part, file);
  };
  const change = (folder, fn) => {
    const all = read();
    all[folder] = fn({ ...(all[folder] ?? {}) });
    write(all);
  };
  return {
    /**
     * { repo: { owner, name, commit, adopted } | null, imported: { owner, name, commit } | null, keptIn: string[] } for a
     * project folder. `adopted`: the repository was the person's before, and the app publishes into it (catalog-update):
     * files it has and the project has not are kept unless the person agrees to delete them.
     */
    get(folder) {
      const one = read()[folder] ?? {};
      const valid = (r) => Boolean(r && typeof r.owner === "string" && typeof r.name === "string" && /^[0-9a-f]{40}$/.test(r.commit ?? ""));
      const repo = valid(one.repo) ? { owner: one.repo.owner, name: one.repo.name, commit: one.repo.commit, adopted: one.repo.adopted === true } : null;
      const imported = valid(one.imported) ? { owner: one.imported.owner, name: one.imported.name, commit: one.imported.commit } : null;
      return { repo, imported, keptIn: Array.isArray(one.keptIn) ? one.keptIn.filter((rel) => typeof rel === "string") : [] };
    },
    /** The app published the project to this repository, at this commit (`adopted`: one the person had before). */
    pushed(folder, { owner, name, commit, adopted = undefined }) {
      change(folder, (one) => {
        const was = one.repo && one.repo.owner === owner && one.repo.name === name ? one.repo.adopted === true : false;
        return { ...one, repo: { owner, name, commit, ...((adopted ?? was) ? { adopted: true } : {}) } };
      });
    },
    /** The app made this project by downloading this repository at this commit (Create app's Import from GitHub). */
    imported(folder, { owner, name, commit }) {
      change(folder, (one) => ({ ...one, imported: { owner, name, commit } }));
    },
    /** The person chose, in the window, to publish (or again to keep out) a flagged file. */
    keepIn(folder, rel, kept = true) {
      change(folder, (one) => {
        const set = new Set(Array.isArray(one.keptIn) ? one.keptIn : []);
        if (kept) set.add(rel);
        else set.delete(rel);
        return { ...one, keptIn: [...set] };
      });
    },
  };
}
