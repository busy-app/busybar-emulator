// busy-emulator build [<folder>]: the project's app built by its own busy-cli (`busy-cli build`) on the Node inside the
// app (EMU-206, EMU-217). When the project has no dependencies installed (a clone, a project made by hand), they are
// installed first with the bundled npm, without install scripts. Only a trusted project is built (ADR-0012 §4).
//
// Before anything runs, the project's settings file (src/appmeta/settings.json) is checked as the firmware checks it:
// busy-cli packs any file, the BUSY Bar then shows only "Settings file is invalid.", and nothing says which field
// (settings_invalid; ../project.mjs requireValidSettings).
//
// build --dependencies-only installs the dependencies when they are needed and builds nothing: the window's Retry of
// an install that failed for want of the network (create-offline). Needed: busy-cli is not there, or the emulator's
// last install failed or was cut off, which may have left node_modules half-written.
//
// busy-cli build's own options go through as they are (agent-path): --no-minify (readable code, for debugging),
// --bundle (one scripts/main.js), --emit tgz|dir|both, --out <folder>, --tgz-name <name with {id} and {version}>. The
// other commands (install, run, dev, check, publish) take the package at dist/<id>.tgz: a build with --out,
// --tgz-name or --emit dir makes none there, and says so. busy-cli's --addr (the address the app talks to, the BUSY Bar it
// runs on) is a BUSY Bar's: an app on the emulated BUSY Bar reaches it as on a BUSY Bar, and the option is not taken.
//
// After the build the sources are read for a font the build could not bundle (`warnings`, font_not_bundled): the app
// would fail on it only when it runs (../../projects/font-check.mjs). A warning, never a failure.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { fontWarnings, fontWarningText } from "../../projects/font-check.mjs";
import { busyCliScript, busyCliVersion } from "../../projects/node-tools.mjs";
import { CliError } from "../output.mjs";
import { buildFailureHint, commandFor, ensureDependencies, fixBusyCli, projectAt, remember, requireTrust, requireValidSettings, runTool, shown, toolFailed, TRUST_OPTION } from "../project.mjs";

export default {
  name: "build",
  summary: "Build the project's app with its own busy-cli, installing its dependencies first if they are missing",
  usage: "build [<folder>] [--dependencies-only] [--no-minify] [--bundle] [--emit tgz|dir|both] [--out <folder>] [--tgz-name <name>]",
  maxArguments: 1,
  options: {
    ...TRUST_OPTION,
    "--dependencies-only": { key: "dependenciesOnly" },
    "--no-minify": { key: "noMinify" },
    "--bundle": { key: "bundle" },
    "--emit": { key: "emit", value: "tgz|dir|both" },
    "--out": { key: "out", value: "<folder>" },
    "--tgz-name": { key: "tgzName", value: "<name>" },
  },
  async run(ctx, sys, { args, options, progress }) {
    const project = projectAt(ctx, sys, args[0]);
    const trust = requireTrust(ctx, sys, project, options, "build");
    remember(ctx, project);
    if (options.dependenciesOnly) {
      const dependencies = await ensureDependencies(ctx, sys, project, progress);
      fixBusyCli(ctx, project);
      return {
        data: { folder: project.dir, id: project.id, dependencies, busy_cli: busyCliVersion(project.dir), trusted: trust.trusted },
        text: dependencies === "present" ? `${project.dir} has its dependencies.` : `Installed the dependencies of ${project.dir}${dependencies === "cache" ? " from npm's cache (the npm registry was not reached)" : ""}. Next: ${commandFor(ctx, project, "build")}`,
      };
    }
    const usage = (message) => new CliError("usage", message, `Usage: ${commandFor(ctx, project, "build")} [--no-minify] [--bundle] [--emit tgz|dir|both] [--out <folder>] [--tgz-name <name>]`);
    if (options.emit !== undefined && !["tgz", "dir", "both"].includes(options.emit)) throw usage(`--emit takes tgz, dir or both, not ${JSON.stringify(options.emit)}.`);
    if (options.tgzName !== undefined && options.emit === "dir") throw usage("--tgz-name names the archive, and --emit dir makes none.");
    if (options.tgzName !== undefined && (/[\\/]/.test(options.tgzName) || !options.tgzName.trim())) throw usage("--tgz-name takes a file name, such as \"{id}-{version}.tgz\".");
    const extra = [...(options.noMinify ? ["--no-minify"] : []), ...(options.bundle ? ["--bundle"] : []), ...(options.emit !== undefined ? ["--emit", options.emit] : []), ...(options.out !== undefined ? ["--out", path.resolve(sys.cwd(), options.out)] : []), ...(options.tgzName !== undefined ? ["--tgz-name", options.tgzName] : [])];
    const settings = requireValidSettings(ctx, project);
    const dependencies = await ensureDependencies(ctx, sys, project, progress);
    const fix = fixBusyCli(ctx, project);
    progress(`busy-cli build${extra.length ? ` ${extra.join(" ")}` : ""}`);
    const run = await runTool(ctx, sys, { tool: "node", args: [busyCliScript(project.dir), "build", ...extra], cwd: project.dir });
    if (run.code !== 0) {
      throw toolFailed(ctx, "busy-cli build", run, buildFailureHint(ctx, project, run, `Fix what busy-cli says, then run ${commandFor(ctx, project, "build")} again.`));
    }
    const file = project.id ? path.join(project.dir, "dist", `${project.id}.tgz`) : null;
    const output = shown(run.output);
    const elsewhere = options.out !== undefined || options.tgzName !== undefined || options.emit === "dir";
    // Where busy-cli put it when told to put it elsewhere: --out, --tgz-name with {id} and {version}.
    let version = null;
    try {
      version = JSON.parse(readFileSync(path.join(project.dir, "src", "appmeta", "manifest.json"), "utf8")).version ?? null;
    } catch {
      // no version: {version} stays as it is
    }
    const named = options.tgzName === undefined ? `${project.id}.tgz` : options.tgzName.replaceAll("{id}", project.id ?? "{id}").replaceAll("{version}", version ?? "{version}");
    const there = options.emit === "dir" || !project.id ? null : path.resolve(options.out === undefined ? path.join(project.dir, "dist") : path.resolve(sys.cwd(), options.out), named);
    const built = elsewhere ? (there && existsSync(there) ? there : null) : file && existsSync(file) ? file : null;
    // A font the build could not see: the app would fail on it when it runs (../../projects/font-check.mjs).
    const fonts = fontWarnings(project.dir);
    const warning = fontWarningText(fonts);
    return {
      data: { folder: project.dir, id: project.id, package: built, ...(extra.length ? { busy_cli_options: extra } : {}), dependencies, busy_cli: busyCliVersion(project.dir), fix, settings, trusted: trust.trusted, warnings: warning ? [{ code: "font_not_bundled", message: warning, places: fonts }] : [], output },
      text: [output, warning ? `Warning: ${warning}` : null, built && !elsewhere ? `Built ${built}. Next: ${commandFor(ctx, project, "install")}` : built ? `Built ${built}. install, run and dev take dist/${project.id}.tgz: build again without --out and --tgz-name for them.` : elsewhere ? "Built. install, run and dev take dist/<id>.tgz, which this build did not make." : "Built."].filter(Boolean).join("\n"),
    };
  },
};
