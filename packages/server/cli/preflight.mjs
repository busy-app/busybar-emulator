// The part of Pre-flight check (publish check) that compiles the app (stale-check). The catalog's checks read the
// project's files and its built package, dist/<id>.tgz; they parse the built scripts, never the source. So a project
// broken after its last build (the product owner deleted the `i` of the first `import` of src/main.ts) passed: busy-cli build
// fails and leaves the old package where it was, and the check read that one. Now the check builds the app first,
// with the project's own busy-cli (the build command), and checks its types with the project's own typecheck script
// when the template has one (the typecheck command); what either says is a failing check of its own, with the file
// and the line, in the check's result.
//
// Both run the project's code (its busy-cli, its compiler), so only for a trusted project, as build and typecheck do;
// an untrusted project's check fails with what to do.
import path from "node:path";

import { hasTypecheck } from "../projects/template-fixes.mjs";
import { CliError } from "./output.mjs";

/** The box drawing and marks busy-cli's output puts before its lines. */
const MARKS = /^[\s│┃|◆◇■□✗✘▲●○└┌╭╰╮╯─━]+/u;
/**
 * A place in the source as the build names it: src/main.ts:1:6 (in "[ src/main.ts:1:6 ]" or "src/main.ts:1:6: ERROR"),
 * with the folders of Windows too (src\main.ts, C:\…\src\main.ts).
 */
const PLACE = /((?:[A-Za-z]:)?(?:[\w@. -]*[\\/])*[\w@.-]+\.(?:[cm]?[jt]sx?|json|anim|png)):(\d+):(\d+)/;

const plain = (line) => line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(MARKS, "").trim();

/**
 * What a failed busy-cli build says, for the check's result: { file, line, column, message } (the first error and
 * where it is), or { message } alone when the output names no place.
 */
export function buildError(output, dir = null) {
  const lines = String(output ?? "").split(/\r?\n/).map(plain).filter(Boolean);
  const placed = lines.map((line) => PLACE.exec(line)).find(Boolean);
  // The error's own words: the line after "The build failed:", else the first line that says error.
  const at = lines.findIndex((line) => /^The build failed:?$/i.test(line));
  const said = (at >= 0 ? lines[at + 1] : null) ?? lines.find((line) => /error|failed|expected|cannot|could not/i.test(line) && !/^Build failed in/i.test(line)) ?? lines.at(-1) ?? "busy-cli build failed";
  const cut = said.replace(/^\[[^\]]*\]\s*/, "").replace(PLACE, "").replace(/^[\s:]*(?:ERROR:\s*)?/i, "").trim();
  const message = /[A-Za-z]{2}/.test(cut) ? cut : "busy-cli build failed";
  if (!placed) return { message };
  // The path as the project names its files: relative, with forward slashes.
  let file = placed[1].trim().replace(/\\/g, "/");
  if (dir && (path.isAbsolute(file) || /^[A-Za-z]:\//.test(file))) {
    const inside = path.relative(dir, placed[1].trim());
    if (inside && !inside.startsWith("..") && !path.isAbsolute(inside)) file = inside.split(path.sep).join("/");
  }
  return { file: file.replace(/^\.\//, ""), line: Number(placed[2]), column: Number(placed[3]), message };
}

const where = (one) => (one.file ? `${one.file}:${one.line}${one.column ? `:${one.column}` : ""}: ` : "");

/** A failing check of the compiling part, shaped as publish/stage.mjs shows a check. */
function failure(id, title, found, place = {}, todo = null) {
  return { id, title, found, why: null, step: null, todo: todo ?? (place.file ? `Fix it in ${place.file}, then run the check again.` : "Fix it, then run the check again."), ...(place.file ? { file: place.file, line: place.line ?? null, column: place.column ?? null } : {}) };
}

/** A failure of the build command (a CliError) as the check's failing check. */
function buildFailure(e, dir) {
  if (e?.code === "tool_failed") {
    const said = buildError(e.extra?.output ?? e.message, dir);
    return failure("compile", "The app builds", `${where(said)}${said.message}`, said);
  }
  if (e?.code === "untrusted_project" || e?.code === "trust_needs_person") {
    return failure("compile", "The app builds", "the project is not trusted on this computer, so it was not built or its types checked: building runs its code", {}, e.hint ?? "Trust the project in the emulator, then run the check again.");
  }
  return failure("compile", "The app builds", String(e?.message ?? e).split("\n")[0].replace(/\.$/, ""), {}, e?.hint ?? null);
}

/** A failure of the typecheck command as the check's failing check: the compiler's first errors, with their places. */
function typeFailure(e) {
  const errors = Array.isArray(e?.extra?.errors) ? e.extra.errors : [];
  if (e?.code !== "typecheck_failed" || !errors.length) return failure("types", "The types check", String(e?.message ?? e).split("\n")[0].replace(/\.$/, ""), {}, e?.hint ?? null);
  const shown = errors.slice(0, 3).map((one) => `${where(one)}${one.message} (${one.code})`);
  const more = errors.length > shown.length ? `; ${errors.length - shown.length} more` : "";
  return failure("types", "The types check", `${shown.join("; ")}${more}`, errors[0]);
}

/**
 * Builds the project and checks its types, as the check's first part: { fails, built, typed }. `fails` are failing
 * checks (the build's and the types'), empty when both pass; `built` and `typed` say what ran and passed. `commands`:
 * the command line's commands (build and typecheck are taken from it); `skipBuild`: the build ran just before
 * (publish prepare), so it is not run again.
 */
export async function compileProject(ctx, sys, project, { commands, progress = () => {}, skipBuild = false } = {}) {
  const command = (name) => commands?.find((one) => one.name === name) ?? null;
  const fails = [];
  let built = skipBuild;
  let typed = null;
  if (!skipBuild) {
    const build = command("build");
    if (!build) throw new CliError("internal", "This copy of the command line has no build command.", "Report this: the app is incomplete.");
    progress("Building the app");
    try {
      await build.run(ctx, sys, { args: [project.dir], options: {}, progress, json: true });
      built = true;
    } catch (e) {
      fails.push(buildFailure(e, project.dir));
      // Not trusted: the types would be refused for the same reason.
      if (e?.code === "untrusted_project" || e?.code === "trust_needs_person") return { fails, built: false, typed: null };
    }
  }
  if (hasTypecheck(project.dir)) {
    const typecheck = command("typecheck");
    if (typecheck) {
      progress("Checking the types");
      try {
        await typecheck.run(ctx, sys, { args: [project.dir], options: {}, progress, json: true });
        typed = true;
      } catch (e) {
        typed = false;
        fails.push(typeFailure(e));
      }
    }
  }
  return { fails, built, typed };
}
