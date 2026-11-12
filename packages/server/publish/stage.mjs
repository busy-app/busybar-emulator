// The catalog's checks as the first stage of publishing sees them. Stage 1 prepares everything on this computer; the
// public repository on GitHub, its commit and the pull request come in stage 2. So the checks of the source on
// GitHub, and those that fail only because nothing is committed yet, are not failures here: they are stage 2's. Each
// other check that fails gets what to do in the window's words and the step of the window that does it.

/** Checks that only a repository on GitHub can pass: stage 2 creates it. */
export const STAGE_TWO = Object.freeze(["source_origin", "source_commit", "source_subdir"]);

/** The step of the publishing flow that puts a check right, by check id. */
const STEP_OF = {
  manifest_readable: "texts",
  manifest_schema: "texts",
  manifest_references: "texts",
  changelog_text: "texts",
  category_public: "texts",
  category_alias: "texts",
  text_resolve: "texts",
  markdown: "texts",
  screenshots_count: "screenshots",
  back_screenshots_count: "screenshots",
  screenshot_png: "screenshots",
  back_screenshot_png: "screenshots",
  screenshot_final: "screenshots",
  back_screenshot_final: "screenshots",
  referenced_file: "screenshots",
  license: "license",
  license_unrecognised: "license",
  build_lockfile: "package",
  build: "package",
  package_missing: "package",
  script_main: "package",
  script_imports: "manifest",
  icon_png: "icons",
  icon_missing: "icons",
  source_archive_size: "folder",
};

/** What to do, in a few words, by the step that does it. */
const TODO = {
  texts: "Write it in Application Info.",
  screenshots: "Take or fix it in Screenshots.",
  license: "Choose one in License.",
  package: "Build in Build and package.",
  manifest: "Fix it in the app's manifest, src/appmeta/manifest.json, then build again.",
  icons: "Put the icon in src/appmeta/ of the project.",
  folder: "Take large files out of the project's folder.",
};

/** A check that fails because a file is not committed yet: committing is stage 2's. */
const notCommitted = (check) => typeof check.found === "string" && /is not added to git|is in git as /.test(check.found);

function stepOf(check) {
  if (STEP_OF[check.id]) return STEP_OF[check.id];
  if (check.stage === "package") return "package";
  if (/^manifest_|^app_id|^invalid_id|^id_style$|^official_namespace$|^firmware_too_old$/.test(check.id)) return "manifest";
  return null;
}

/** One check as the flow shows it. */
function shown(check) {
  const step = stepOf(check);
  return { id: check.id, title: check.title, found: check.found ?? null, why: check.why ?? null, step, todo: step ? TODO[step] : (check.change ?? null) };
}

/**
 * The checks of a result of checkProject(), grouped for stage 1: what fails (and stops the package), the catalog's
 * warnings, what stage 2 does, and what cannot be checked here (one line each).
 */
export function stageOne(result) {
  const applying = result.checks.filter((check) => check.applies !== false);
  const later = (check) => STAGE_TWO.includes(check.id) || (check.status === "fail" && notCommitted(check));
  const fails = applying.filter((check) => check.status === "fail" && check.blocking && !later(check)).map(shown);
  const warnings = applying.filter((check) => check.status === "fail" && !check.blocking && !later(check)).map(shown);
  const stage2 = applying.filter((check) => later(check) && check.status !== "pass").map((check) => ({ id: check.id, title: check.title }));
  // An unchecked one that only waits for something above is not worth a line: it is answered once that is put right.
  const unchecked = applying.filter((check) => check.status === "unchecked" && !check.waits && !later(check)).map((check) => ({ id: check.id, title: check.title, why: check.why }));
  const waiting = applying.filter((check) => check.status === "unchecked" && check.waits && !later(check)).length;
  return { ok: fails.length === 0, built: result.built, fails, warnings, stage2, unchecked, waiting, passes: applying.filter((check) => check.status === "pass").length, total: applying.length };
}
