// The steps of the publishing flow (publish.js) and their rules, apart from the drawing so that they are tested on
// plain Node (packages/server/test/publish-steps.test.mjs). The person goes step by step: a step is done when what it
// makes is there in the project (the command line's `publish status` says so), the steps after the first one not done
// wait, and Next writes what the step holds before it moves on. Nothing here shows a problem of a later step.
//
// What checks a text is given (the catalog's own rules, readiness/texts.mjs and rules.mjs, and the README's,
// publish/readme.mjs), so that this file imports nothing and the window and the tests load the same rules.

/** The steps, in order: stage 1 prepares the project on this computer, stage 2 sends it. */
export const STEPS = Object.freeze([
  { id: "texts", title: "Application Info", stage: 1 },
  { id: "screenshots", title: "Screenshots", stage: 1 },
  { id: "readme", title: "README", stage: 1 },
  { id: "license", title: "License", stage: 1 },
  { id: "files", title: "Repository files", stage: 1 },
  { id: "check", title: "Pre-flight check", stage: 1 },
  { id: "package", title: "Build and package", stage: 1 },
  { id: "github", title: "Publish to GitHub", stage: 2 },
  { id: "catalog", title: "Send to catalog", stage: 2 },
]);
export const STAGE_TITLES = Object.freeze({ 1: "Prepare", 2: "Publish" });

const index = (id) => STEPS.findIndex((step) => step.id === id);
export const stepTitle = (id) => STEPS[index(id)]?.title ?? id;

/**
 * Whether a step is done, by the project as it is (`status`: the answer of publish status). The check counts as done
 * when its last run found nothing to fix, the build and the types included, and no file changed since (stale-check:
 * publish status compares the fingerprint the check recorded with the project now); the package likewise. The rest by
 * the files they make.
 */
export function isDone(id, status) {
  const s = status ?? {};
  switch (id) {
    case "texts":
      return s.texts?.taken === true && !s.texts?.name_problem;
    case "screenshots":
      return s.screenshots?.ready === true;
    case "readme":
      return s.readme?.ready === true;
    case "license":
      return s.license?.ready === true;
    case "files":
      return s.files?.ready === true;
    case "check":
      return Boolean(s.check) && s.check.fails === 0 && s.check.passed !== false && s.check.stale !== true;
    case "package":
      return Boolean(s.package?.submission) && s.package.stale !== true;
    case "github":
      return Boolean(s.github?.repo?.commit);
    case "catalog":
      return Boolean(s.github?.request?.url);
    default:
      return false;
  }
}

/** Whether every step of stage 1 is done: stage 2 opens then. */
export const stageOneDone = (status) => STEPS.filter((step) => step.stage === 1).every((step) => isDone(step.id, status));

/** The step the flow opens on: the first one not done (the last one when all are). */
export function firstOpen(status) {
  return STEPS.find((step) => !isDone(step.id, status))?.id ?? STEPS[STEPS.length - 1].id;
}

/**
 * What the list of steps shows: for each, "done", "current", "next" (the one to do, or one before it) or "later"
 * (waits for an earlier one), and whether it can be opened. A step can be opened when it is done or comes no later
 * than the first one not done.
 */
export function railStates(status, current) {
  const open = index(firstOpen(status));
  return STEPS.map((step, i) => {
    const done = isDone(step.id, status);
    const reachable = done || i <= open || step.id === current;
    return { id: step.id, title: step.title, stage: step.stage, done, reachable, state: step.id === current ? "current" : done ? "done" : reachable ? "next" : "later", waitsFor: reachable ? null : STEPS[open].title };
  });
}

const FIELD_LABELS = { name: "Name", category: "Category", short_description: "Short description", description: "Description", changelog: "What's new" };
const unwritten = { name: "Write the app's name", category: "Choose a category", short_description: "Write the short description", description: "Write the description", changelog: "Write what's new" };
const short = (text) => String(text).replace(/\.$/, "");

/**
 * Why Next cannot go on from a step, in a few words; null when it can. `drafts` is what the person has in the step
 * now (the texts and name as typed, the README's fields, the license and name chosen); `rules` the checks:
 * { textProblems, nameProblem, readmeProblem }.
 */
export function nextBlock(id, status, drafts = {}, rules = {}) {
  const s = status ?? {};
  switch (id) {
    case "texts": {
      const name = drafts.name ?? s.texts?.name ?? "";
      if (!name.trim()) return unwritten.name;
      const nameWrong = rules.nameProblem ? rules.nameProblem(name) : null;
      if (nameWrong) return `Name: ${short(nameWrong)}`;
      const texts = drafts.texts ?? s.texts?.texts ?? {};
      const problems = rules.textProblems ? rules.textProblems(texts).problems : (s.texts?.problems ?? {});
      for (const key of ["short_description", "category", "description", "changelog"]) {
        const problem = problems[key];
        if (!problem) continue;
        if (problem === "Not written yet.") return unwritten[key];
        // "12 characters: the description needs at least 50." in the footer is "Description: at least 50 characters".
        const length = /(at least|at most) (\d+)\.?$/.exec(problem);
        if (length && /^\d+ characters/.test(problem)) return `${FIELD_LABELS[key]}: ${length[1]} ${length[2]} characters`;
        return `${FIELD_LABELS[key]}: ${short(problem)}`;
      }
      return null;
    }
    case "screenshots": {
      const shots = s.screenshots ?? {};
      if (!(shots.front ?? []).length) return "Add a front screenshot";
      if ((shots.front ?? []).length > 10 || (shots.back ?? []).length > 10) return "At most 10 of each";
      if ([...(shots.front ?? []), ...(shots.back ?? [])].some((one) => one.problem)) return "Remove the screenshot marked red";
      return null;
    }
    case "readme": {
      const config = drafts.readme ?? s.readme?.config ?? null;
      if (rules.readmeProblem) return rules.readmeProblem(config, s.readme?.facts ?? {});
      return s.readme?.problem ?? null;
    }
    case "license": {
      if (s.license?.files?.length) return null;
      const choice = drafts.license?.choice ?? null;
      if (!choice) return "Choose a license";
      if (choice === "other") return "Upload your license file";
      const author = drafts.license?.author ?? "";
      if (!author.trim()) return "Write the copyright holder";
      if ([...author].length > 100) return "The name is at most 100 characters";
      return null;
    }
    case "files":
      return (s.files?.findings ?? []).some((one) => one.published && !one.kept_in) ? "Keep the secret files out first" : null;
    case "check": {
      const check = drafts.check ?? null;
      if (!check) return "Run the check";
      if (check.fails?.length) return `${check.fails.length} to fix first`;
      return null;
    }
    case "package":
      return isDone("package", s) ? null : "Build and package first";
    case "github":
      return isDone("github", s) ? null : "Publish to GitHub first";
    default:
      return null;
  }
}

/**
 * What Next writes before it moves on, so that nothing is left to save by hand: { kind, … } or null for nothing.
 * texts: the name and texts when changed; readme: README.md when it is not written yet or was changed here; license:
 * LICENSE with the chosen license and name; files: .gitignore's lines and README.md when they are missing.
 */
export function saveOnNext(id, status, drafts = {}) {
  const s = status ?? {};
  switch (id) {
    case "texts": {
      const nameChanged = typeof drafts.name === "string" && drafts.name !== (s.texts?.name ?? "");
      return drafts.textsDirty || nameChanged ? { kind: "texts", name: nameChanged ? drafts.name : null, texts: drafts.texts ?? s.texts?.texts ?? {} } : null;
    }
    case "readme":
      return drafts.readmeDirty || !isDone("readme", s) ? { kind: "readme", readme: drafts.readme ?? s.readme?.config ?? null } : null;
    case "license":
      if (s.license?.files?.length) return null;
      return drafts.license?.choice && drafts.license.choice !== "other" ? { kind: "license", license: drafts.license.choice, author: drafts.license.author ?? "" } : null;
    case "files":
      return isDone("files", s) ? null : { kind: "files" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- stale-check

/**
 * The step a file changed since, by the project as it is (`status`): "check" when the check no longer holds, else
 * "package" when the package does not; null when both hold (or were not done). Every step after Pre-flight check
 * asks it before it goes on.
 */
export function staleStep(status) {
  const s = status ?? {};
  if (s.check && s.check.stale === true) return "check";
  if (s.package?.submission && s.package.stale === true) return "package";
  return null;
}

/** Whether `id` comes after Pre-flight check: going there needs the check to hold. */
export const afterCheck = (id) => index(id) > index("check");

/**
 * What changed, in a few words, from a step's state ({ changed, more, unknown } of publish status): "src/main.ts",
 * "src/main.ts and README.md", "src/main.ts, README.md, LICENSE and 2 more".
 */
export function changedWords(state) {
  const list = Array.isArray(state?.changed) ? state.changed : [];
  if (!list.length) return state?.unknown ? "it was checked by an older version of the emulator" : "a file changed";
  const more = Number(state.more) || 0;
  if (list.length === 1 && !more) return list[0];
  const shown = list.slice(0, 3);
  const rest = list.length - shown.length + more;
  return rest ? `${shown.join(", ")} and ${rest} more` : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** The step after `id`, or null after the last. */
export const nextStep = (id) => STEPS[index(id) + 1]?.id ?? null;
/** The step before `id`, or null before the first. */
export const previousStep = (id) => (index(id) > 0 ? STEPS[index(id) - 1].id : null);
