// The update's helper (EMU-221, updater.mjs): runs on plain Node, apart from the app, after the person chose Restart
// to update. The app copies this file into <data>/tmp/update-<version>/ with a plan beside it and starts it detached:
//
//   node update-helper.mjs <plan.json> <token>
//
// It reads the plan once and deletes it (a plan is used one time only), waits until the app's process has ended, then:
//
//   macOS    the running bundle is renamed into the staging folder beside it (staging/previous/), the new bundle,
//            unpacked and checked by the app, is renamed into its place, and the new version is started. Once the
//            new version writes the plan's `started` mark, the old bundle and the staging folder go. If the new
//            version ends before it writes the mark, the old bundle is put back and started again, and the result
//            says why.
//   Windows  the release's setup.exe runs silently into the install folder (/S /D=<folder>, /NoShortcut for a copy
//            outside the default folder). Exit code 3 is the setup's "a file of the folder is in use": the helper
//            waits and tries again for a while (the app's server, a command line or an agent's MCP server may still
//            be ending). Then the app is started: the new version, or the old one when the setup refused.
//
// What the app checked may have waited hours for the person's Restart, so it is checked again right before it is used:
// the new bundle's code signature on macOS, the setup's SHA-256 (the signed manifest's, given in the plan) on Windows
// before every try. One that no longer holds is not used; the old version starts again and says why.
//
// The plan must be what the app wrote: its token, paths of the shapes below, and nothing else; a plan that is not is
// refused without touching anything. Every program is started by its full path with an argument list, no shell.
// The result goes to the plan's `result` file, which the app reads at its next start; the steps go to its `log`.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const WAIT_FOR_EXIT_MS = 120_000;
const WAIT_FOR_START_MS = 180_000;
const SETUP_RETRY_MS = 90_000;
const MAC_APP = "BUSY Bar Emulator.app";
const MAC_EXE = path.posix.join("Contents", "MacOS", "BUSY Bar Emulator");
const WIN_EXE = "BUSY Bar Emulator.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The SHA-256 of a file, or null when it cannot be read. */
export async function sha256Of(file) {
  try {
    const hash = createHash("sha256");
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

/**
 * What the app checked may have waited hours for the person's Restart: it is checked again right before it is used.
 * macOS: the new bundle's code signature (the app checked its id, version and links when it unpacked it); Windows:
 * the setup's SHA-256 against the signed manifest's. True when it still holds.
 */
export async function stillTheUpdate(plan, { codesign = "/usr/bin/codesign" } = {}) {
  if (plan.platform === "darwin") return spawnSync(codesign, ["--verify", "--deep", "--strict", plan.bundle], { stdio: "ignore" }).status === 0;
  return (await sha256Of(plan.setup)) === plan.setupSha256;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** What is wrong with a plan, or null. The paths are checked against each other: they must be the update's own. */
export function planProblem(plan, { token, platform = process.platform, planFile }) {
  if (!plan || typeof plan !== "object") return "not a plan";
  if (typeof plan.token !== "string" || plan.token.length < 16 || plan.token !== token) return "the token is not the plan's";
  if (plan.platform !== platform) return "a plan of another system";
  if (!Number.isSafeInteger(plan.pid) || plan.pid <= 0) return "no process to wait for";
  if (typeof plan.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(plan.version)) return "no version";
  const p = platform === "win32" ? path.win32 : path.posix;
  const folder = p.dirname(planFile);
  if (p.basename(folder) !== `update-${plan.version}`) return "the plan is not in its update's folder";
  for (const key of ["started", "result", "log"]) if (plan[key] !== p.join(folder, p.basename(String(plan[key])))) return `${key} is not in the update's folder`;
  if (platform === "darwin") {
    if (typeof plan.target !== "string" || !p.isAbsolute(plan.target) || p.basename(plan.target) !== MAC_APP) return "the app to replace is not BUSY Bar Emulator.app";
    if (plan.staging !== p.join(p.dirname(plan.target), `.busy-emulator-update-${plan.version}`)) return "the staging folder is not beside the app";
    if (plan.bundle !== p.join(plan.staging, MAC_APP)) return "the new bundle is not in the staging folder";
    if (plan.previous !== p.join(plan.staging, "previous", MAC_APP)) return "the place of the old bundle is not in the staging folder";
    if (plan.exe !== p.join(plan.target, MAC_EXE)) return "the executable is not the app's";
    return null;
  }
  if (platform === "win32") {
    if (typeof plan.target !== "string" || !p.isAbsolute(plan.target)) return "no install folder";
    if (plan.exe !== p.join(plan.target, WIN_EXE)) return "the executable is not the app's";
    if (plan.setup !== p.join(folder, "busybar-emulator-win-x64-setup.exe")) return "the setup is not the update's";
    if (typeof plan.setupSha256 !== "string" || !/^[0-9a-f]{64}$/.test(plan.setupSha256)) return "the setup's SHA-256 is not given";
    if (plan.setupLog !== p.join(folder, "setup.log")) return "the setup's log is not in the update's folder";
    return null;
  }
  return "a system the updater does not know";
}

async function main() {
  const [planFile, token] = process.argv.slice(2);
  if (!planFile || !token) process.exit(2);
  let plan;
  try {
    plan = JSON.parse(readFileSync(planFile, "utf8"));
  } catch {
    process.exit(2);
  }
  rmSync(planFile, { force: true });
  const problem = planProblem(plan, { token, planFile: path.resolve(planFile) });
  if (problem) {
    // Nothing is touched; the result says why, if there is a place to say it.
    try {
      if (typeof plan?.result === "string" && path.dirname(plan.result) === path.dirname(path.resolve(planFile))) writeFileSync(plan.result, JSON.stringify({ ok: false, code: "bad_plan", message: `the helper refused its plan: ${problem}` }));
    } catch {
      // Nowhere to say it.
    }
    process.exit(2);
  }
  const log = (line) => {
    try {
      appendFileSync(plan.log, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // The log is only for reading later.
    }
  };
  const result = (value) => {
    log(`result: ${JSON.stringify(value)}`);
    writeFileSync(plan.result, JSON.stringify(value));
  };
  log(`helper for the update ${plan.from} -> ${plan.version}, waiting for process ${plan.pid}`);

  const until = Date.now() + WAIT_FOR_EXIT_MS;
  while (alive(plan.pid) && Date.now() < until) await sleep(200);
  if (alive(plan.pid)) {
    result({ ok: false, code: "still_running", message: "the emulator did not quit", hint: "Quit it and open it again, then press Update." });
    return;
  }
  log("the app has quit");

  if (plan.platform === "darwin") await swapMac(plan, log, result);
  else await setupWindows(plan, log, result);
}

/** Starts the app's executable, detached, with the environment the app had (a release reads nothing of it). */
function launch(exe, log) {
  const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false, cwd: path.dirname(exe) });
  child.on("error", (e) => log(`could not start ${exe}: ${e.message}`));
  log(`started ${exe} (process ${child.pid ?? "?"})`);
  return child;
}

/** Waits for the new version's mark, or for its process to end, or for the time to pass: "started" | "ended" | "late". */
async function waitStarted(plan, child) {
  let ended = false;
  child.once("exit", () => (ended = true));
  child.once("error", () => (ended = true));
  const until = Date.now() + WAIT_FOR_START_MS;
  while (Date.now() < until) {
    if (existsSync(plan.started) && readFileSync(plan.started, "utf8").trim() === plan.token) return "started";
    if (ended) return existsSync(plan.started) ? "started" : "ended";
    await sleep(250);
  }
  return "late";
}

async function swapMac(plan, log, result) {
  if (!existsSync(plan.bundle) || !statSync(plan.bundle).isDirectory()) {
    result({ ok: false, code: "bad_plan", message: "the new version was not where the app left it", hint: "Press Update again." });
    launch(plan.exe, log).unref();
    return;
  }
  if (!(await stillTheUpdate(plan))) {
    result({ ok: false, code: "bad_bundle", message: "the new version was changed after the emulator checked it (its code signature no longer holds)", hint: "Press Update to download it again, or download the new version from the release page." });
    rmSync(plan.staging, { recursive: true, force: true });
    launch(plan.exe, log).unref();
    return;
  }
  mkdirSync(path.dirname(plan.previous), { recursive: true });
  rmSync(plan.previous, { recursive: true, force: true });
  try {
    renameSync(plan.target, plan.previous);
  } catch (e) {
    result({ ok: false, code: "disk", message: `the old version could not be moved aside (${e.code})`, hint: "Download the new version from the release page instead." });
    launch(plan.exe, log).unref();
    return;
  }
  try {
    renameSync(plan.bundle, plan.target);
  } catch (e) {
    renameSync(plan.previous, plan.target);
    result({ ok: false, code: "disk", message: `the new version could not be put in place (${e.code})`, hint: "Download the new version from the release page instead." });
    launch(plan.exe, log).unref();
    return;
  }
  log(`${plan.version} is in place, the old version is kept at ${plan.previous}`);
  const child = launch(plan.exe, log);
  const how = await waitStarted(plan, child);
  child.unref();
  if (how === "started") {
    log(`${plan.version} has started: the old version goes`);
    rmSync(plan.staging, { recursive: true, force: true });
    result({ ok: true, version: plan.version });
    return;
  }
  if (how === "late") {
    // Still starting (under Rosetta the first start takes long): it cleans up after itself once it is up.
    result({ ok: true, version: plan.version, late: true });
    return;
  }
  log(`${plan.version} ended before it was up: the old version goes back`);
  const failed = path.join(plan.staging, `did-not-start-${Date.now()}`);
  try {
    renameSync(plan.target, failed);
    renameSync(plan.previous, plan.target);
  } catch (e) {
    result({ ok: false, code: "rollback", message: `the new version did not start, and the old one could not be put back (${e.code})`, hint: "Download the new version from the release page and install it by hand." });
    return;
  }
  result({ ok: false, code: "did_not_start", message: `version ${plan.version} did not start, so the emulator went back to ${plan.from}`, hint: "Download the new version from the release page, or report a bug." });
  launch(plan.exe, log).unref();
}

async function setupWindows(plan, log, result) {
  const args = ["/S", ...(plan.noShortcut ? ["/NoShortcut"] : []), `/LOG=${plan.setupLog}`, `/D=${plan.target}`];
  const until = Date.now() + SETUP_RETRY_MS;
  let code;
  for (let tries = 1; ; tries++) {
    if (!(await stillTheUpdate(plan))) {
      log(`setup (try ${tries}): its SHA-256 is no longer the manifest's`);
      result({ ok: false, code: "bad_file", message: "the downloaded setup was changed after the emulator checked it", hint: "Press Update to download it again, or download the setup from the release page." });
      rmSync(plan.setup, { force: true });
      launch(plan.exe, log).unref();
      return;
    }
    const ran = spawnSync(plan.setup, args, { stdio: "ignore", windowsHide: true, timeout: 600_000 });
    code = ran.status ?? (ran.error ? `error ${ran.error.code}` : "killed");
    log(`setup (try ${tries}): exit code ${code}`);
    if (code !== 3 || Date.now() > until) break;
    await sleep(3000);
  }
  if (code === 0) {
    const child = launch(plan.exe, log);
    const how = await waitStarted(plan, child);
    child.unref();
    result(how === "ended" ? { ok: false, code: "did_not_start", message: `version ${plan.version} was installed but did not start`, hint: "Open BUSY Bar Emulator from the Start menu; if it does not open, download the setup from the release page." } : { ok: true, version: plan.version });
    return;
  }
  const words =
    code === 3
      ? { code: "in_use", message: "a program still runs from the emulator's folder (most likely an agent's busy-emulator mcp or a command line)", hint: "Close the program, or the agent's session, then press Update again." }
      : { code: "setup_failed", message: `the setup ended with code ${code} (its log is ${plan.setupLog})`, hint: "Download the setup from the release page and run it." };
  result({ ok: false, ...words });
  launch(plan.exe, log).unref();
}

// Run as a program, not when a test imports planProblem.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("update-helper.mjs")) {
  main().catch((e) => {
    try {
      process.stderr.write(`${e?.stack ?? e}\n`);
    } finally {
      process.exit(1);
    }
  });
}
