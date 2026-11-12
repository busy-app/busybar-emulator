// busy-emulator install [<folder> | <file.tgz>]: the project's package (dist/<id>.tgz, made by build) onto the emulated
// BUSY Bar, by the project's own busy-cli (`busy-cli app install --addr <the emulator>`) on the Node inside the app
// (EMU-217).
//
// A package file (agent-path, as `busy-cli app install <file.tgz>` takes one): any app package, a project's or one
// built elsewhere, uploaded to the emulated BUSY Bar as busy-cli uploads it (POST /api/apps/stage, then POST
// /api/apps/install with the key the BUSY Bar gave). It is someone's code, so it is installed only from a folder the person
// trusted (busy-emulator trust <the folder that holds it> asks them in the emulator's dialog), a project's folder
// included. Nothing of it runs on this computer: the app runs on the emulated BUSY Bar, which keeps it from this computer's
// own services as it keeps a project's app (ADR-0012 §5).
//
// Every package is looked at first (projects/app-package.mjs): its app's id, name and version, and the package refused
// when the BUSY Bar would not take it or it has a path that leaves its folder. `install <file.tgz> --check` only looks: it
// says what app the package holds, or why it is refused, and installs nothing. It reads the file and runs nothing, so
// it needs no trusted folder (the window's Install a package shows its answer in the trust dialog).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { insideRoots, realOrNull } from "../../path-boundary.mjs";
import { checkAppPackage, MAX_PACKAGE_BYTES, PackageProblem } from "../../projects/app-package.mjs";
import { isTrusted } from "../../projects/trust.mjs";
import { blockedNetwork, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";
import { again, appCommand, shellWord } from "../project.mjs";

const fromProject = appCommand({
  name: "install",
  summary: "Install the project's built app on the emulated BUSY Bar (busy-cli app install), or a package file from a folder the person trusted",
  done: (project, address) => `Installed ${project.id ?? "the app"} on the emulated BUSY Bar at ${address}.`,
});

/** The most a package may hold: the bar takes 100 MiB (MAX_UPLOAD_FILE_SIZE). */
const MAX_PACKAGE = MAX_PACKAGE_BYTES;

const parsed = (answer) => {
  try {
    return JSON.parse(answer.body);
  } catch {
    return null;
  }
};

/** What app a package holds (checkAppPackage), or the refusal as the command line's. */
function lookAt(file, bytes) {
  try {
    return checkAppPackage(bytes);
  } catch (e) {
    if (e instanceof PackageProblem) throw new CliError(e.code, e.message, e.hint, { file });
    throw e;
  }
}

async function installPackage(ctx, sys, given, progress, { check = false } = {}) {
  const named = path.resolve(sys.cwd(), given);
  // The package by its real path (links followed): the folder trusted is the one it really lies in, never the one a
  // link in a trusted project leads out of (path-boundary.mjs).
  const file = realOrNull(named) ?? named;
  let bytes;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "EISDIR" });
    if (stat.size > MAX_PACKAGE) throw new CliError("package_too_large", `${file} is larger than the BUSY Bar takes (100 MiB).`, "Build a smaller package.", { file });
    bytes = readFileSync(file);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError("not_found", `Could not read the package ${file}: ${e?.code ?? e?.message ?? e}.`, "Name an app package (.tgz) by its path, as busy-cli build makes it.", { file });
  }
  const facts = lookAt(file, bytes);
  if (check) {
    const { folder: _folder, ...app } = facts;
    return { data: { file, ...app, installed: false }, text: [`${file} holds ${app.name} (${app.id}) ${app.version}, for API ${app.api_version}. Nothing was installed.`, ...app.notes].join("\n") };
  }
  // A project's own package lies in its dist/: the project's folder is the one the person trusted.
  const folder = path.dirname(file);
  const trusted = [folder, path.dirname(folder)].find((one) => isTrusted(ctx.dataDir, one, ctx.platform)) ?? null;
  if (!trusted || insideRoots(file, [trusted], { rootItself: false, platform: ctx.platform }) !== file) {
    throw new CliError("untrusted_package", `${file} is in a folder the person has not trusted: an app package is someone's code, and the emulator installs one only from a trusted folder.`, `Ask the person; they can trust its folder with ${again(ctx, "trust")} ${shellWord(ctx, folder)} (the emulator asks them in a dialog), then run this again.`, { file, folder });
  }
  const status = await emulatorStatus(ctx, sys);
  if (!ready(status)) throw new CliError("not_running", status.running ? `The emulator is running, but its BUSY Bar is not ready (${status.state}).` : "The emulator is not running, so there is no BUSY Bar to install the app on.", `Start it with ${again(ctx, "start")}, then run this again.`);
  const address = `127.0.0.1:${status.port}`;
  progress(`Uploading ${path.basename(file)} to the emulated BUSY Bar at ${address}`);
  const staged = await sys.barSend(status.port, "POST", "/api/apps/stage", bytes, 120_000);
  if (staged.blocked) throw blockedNetwork(status.port, staged.blocked);
  const stage = parsed(staged);
  if (staged.status !== 200 || typeof stage?.install_key !== "string") {
    throw new CliError("install_failed", `The emulated BUSY Bar did not take ${path.basename(file)}: ${stage?.error ?? staged.failed ?? `HTTP ${staged.status}`}.`, "Check that it is an app package, as busy-cli build makes it.", { file, ...(stage?.error_code ? { bar_code: stage.error_code } : {}) });
  }
  const done = await sys.barSend(status.port, "POST", `/api/apps/install?install_key=${encodeURIComponent(stage.install_key)}`, null, 120_000);
  if (done.blocked) throw blockedNetwork(status.port, done.blocked);
  if (done.status !== 200) throw new CliError("install_failed", `The emulated BUSY Bar did not install ${path.basename(file)}: ${parsed(done)?.error ?? done.failed ?? `HTTP ${done.status}`}.`, "Check that it is an app package, as busy-cli build makes it.", { file });
  const id = stage.staged?.id ?? null;
  return { data: { file, id, address, version: stage.staged?.version ?? null }, text: `Installed ${id ?? path.basename(file)} on the emulated BUSY Bar at ${address}.${id ? ` Start it with ${again(ctx, "run")} ${id}.` : ""}` };
}

export default {
  ...fromProject,
  usage: "install [<folder> | <file.tgz> [--check]]",
  options: { ...fromProject.options, "--check": { key: "check" } },
  async run(ctx, sys, call) {
    const given = call.args[0];
    if (typeof given === "string" && /\.tgz$/i.test(given)) return installPackage(ctx, sys, given, call.progress, { check: call.options.check === true });
    if (call.options.check) throw new CliError("usage", "--check looks at a package file: name one (<file.tgz>).", `Usage: ${again(ctx, "install")} <file.tgz> --check`);
    return fromProject.run(ctx, sys, call);
  },
};
