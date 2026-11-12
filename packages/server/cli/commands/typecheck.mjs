// busy-emulator typecheck [<folder>]: the project's TypeScript check — its `typecheck` script (`tsc` in the official
// template) — run by the bundled npm on the Node inside the app. The template's AGENTS.md asks for `npm run typecheck`
// before a task is finished; an author without a Node of their own, and an agent that may run only this command line,
// had no way to do it (the field test: refused in every run), and busy-cli's build does not check types.
//
// It runs code of the project (the compiler from its node_modules, its tsconfig), so only a trusted project is
// checked, as with build; its dependencies are installed first when they are missing. Exit code 0: no type errors.
// typecheck_failed: the compiler's own lines, file(line,column): error TSxxxx: …. A project without such a script
// (plain JavaScript) answers no_typecheck.
import { hasTypecheck } from "../../projects/template-fixes.mjs";
import { CliError } from "../output.mjs";
import { commandFor, ensureDependencies, projectAt, requireTrust, runTool, shown, toolFailed, TRUST_OPTION } from "../project.mjs";

/** The compiler's error lines: "src/main.ts(14,3): error TS2304: Cannot find name 'devcie'." */
const ERROR_LINE = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export default {
  name: "typecheck",
  summary: "Check the project's types with its own typecheck script (tsc), on the Node inside the app",
  usage: "typecheck [<folder>]",
  maxArguments: 1,
  options: TRUST_OPTION,
  async run(ctx, sys, { args, options, progress }) {
    const project = projectAt(ctx, sys, args[0]);
    if (!hasTypecheck(project.dir)) {
      throw new CliError("no_typecheck", `${project.dir} has no typecheck script in its package.json, so there are no types to check here.`, `A project in TypeScript has "typecheck": "tsc" among the scripts of package.json; ${commandFor(ctx, project, "build")} builds without checking types.`, { folder: project.dir });
    }
    const trust = requireTrust(ctx, sys, project, options, "typecheck");
    const dependencies = await ensureDependencies(ctx, sys, project, progress);
    progress("npm run typecheck");
    const run = await runTool(ctx, sys, { tool: "npm", args: ["run", "--silent", "--no-workspaces", "typecheck"], cwd: project.dir });
    const output = shown(run.output);
    const errors = output.split("\n").map((line) => ERROR_LINE.exec(line.trim())).filter(Boolean).map(([, file, line, column, code, message]) => ({ file, line: Number(line), column: Number(column), code, message }));
    const data = { folder: project.dir, id: project.id, dependencies, trusted: trust.trusted };
    if (run.code !== 0) {
      // The compiler found errors (its exit code 2, its lines on standard output); anything else is the tool's failure.
      if (!errors.length || run.signal) throw toolFailed(ctx, "npm run typecheck", run, `Fix what it says, then run ${commandFor(ctx, project, "typecheck")} again.`);
      throw new CliError(
        "typecheck_failed",
        `${errors.length} type ${errors.length === 1 ? "error" : "errors"} in ${project.id ?? project.dir}:\n${output}`,
        `Fix ${errors.length === 1 ? "it" : "them"}, then run ${commandFor(ctx, project, "typecheck")} again. (The build does not check types: ${commandFor(ctx, project, "build")} still builds.)`,
        { ...data, errors, output },
      );
    }
    return { data: { ...data, errors: [], output }, text: [output, `No type errors in ${project.id ?? project.dir}.`].filter(Boolean).join("\n") };
  },
};
