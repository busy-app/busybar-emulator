// What the comparison suites (golden, timed, api, power, settings, speed) share: an emulator of their own, the folder
// their pictures go to, and the line of totals the gate reads.
//
// A suite that is not given an address (--emu, --addr) starts its own emulator in its own process: startServer on a
// free port of 127.0.0.1, with a new data folder in the system's temporary folder, on the firmware --firmware names.
// When the suite ends — by itself, by an error, or stopped with Ctrl+C — the server is stopped and the folder removed.
// So suites can run side by side, and none needs an emulator started by hand.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFirmware } from "../packages/server/firmware.mjs";
import { startServer } from "../packages/server/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// The prefix of the test servers' data folders (test/server/helpers.mjs): a folder whose process is gone is removed
// by the next test run that starts.
const FOLDER = "busybar-emulator-test-";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The value of `--name <value>` in `args`, `fallback` without it; a flag with no value after it is an error. */
export function option(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

/** The firmware a suite runs on: --firmware, else EMU_FIRMWARE, else the emulator's default. */
export function firmwareOf(args) {
  return loadFirmware(option(args, "--firmware", process.env.EMU_FIRMWARE || undefined)).name;
}

// What has to be put away when the process ends, however it ends.
const owned = new Set();
let stopping = null;
function putAway() {
  for (const own of owned) {
    try {
      rmSync(own.dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Nothing more can be done from here; the next test run removes it (its process is gone).
    }
  }
}
process.on("exit", putAway);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    // A second signal ends the process at once.
    if (stopping) process.exit(130);
    stopping = Promise.allSettled([...owned].map((own) => own.stop())).finally(() => process.exit(130));
  });
}

/**
 * Copies the apps of test/apps/set.json into a bar's /ext/user_assets, one after another: the apps menu lists apps
 * in the order their folders were made (packages/server/device.mjs, listDir), and the volume must tell them apart.
 */
async function installAppSet(barDir) {
  const set = JSON.parse(readFileSync(join(here, "apps", "set.json"), "utf8"));
  const target = join(barDir, "ext", "user_assets");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const [i, { id }] of set.apps.entries()) {
    // Apart in time: exFAT keeps a folder's time in steps of 10 ms, NTFS in 0.5–15.6 ms.
    if (i) await sleep(30);
    cpSync(join(here, "apps", id), join(target, id), { recursive: true });
  }
  return set.apps.map((a) => a.id);
}

/**
 * An emulator of the suite's own. `apps`: install the apps of test/apps/ first (the system scenes need them).
 * Returns { addr, url, firmware, dataDir, apps, stop() }; stop() is also called when the process ends.
 */
export async function ownEmulator({ firmware, barSpeed = true, apps = false, name = "suite" } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), `${FOLDER}${process.pid}-`));
  const own = { dataDir, stop: async () => {} };
  owned.add(own);
  const installed = apps ? await installAppSet(join(dataDir, "bar", loadFirmware(firmware).name)) : [];
  // The bar's log goes where the suite's pictures go when a gate runs it, and nowhere otherwise.
  const logFile = process.env.EMU_TEST_OUT ? join(outputDir(name), `server-${loadFirmware(firmware).name}.log`) : null;
  const log = logFile ? (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`) : () => {};
  const emulator = await startServer({ dataDir, port: 0, firmware, barSpeed, log, onError: (e) => log(`error: ${e?.stack ?? e}`) });
  let stopped = null;
  own.stop = () =>
    (stopped ??= emulator.stop().finally(() => {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      owned.delete(own);
    }));
  const addr = `127.0.0.1:${emulator.port}`;
  // The apps of the set must be listed in their order, or the system scenes compare another menu.
  if (installed.length) {
    const listed = (await (await fetch(`http://${addr}/api/apps/list`)).json()).apps.map((a) => a.id);
    if (listed.join() !== installed.join()) {
      await own.stop();
      throw new Error(`the apps of test/apps/set.json are listed as ${listed.join(", ")}, not in the order of the set: ${installed.join(", ")}`);
    }
  }
  return { addr, url: emulator.url, firmware: emulator.firmware.name, dataDir, apps: installed, stop: own.stop };
}

/**
 * The emulator a suite talks to: the one at `--emu`/`--addr` when given, else its own. Prints one line saying which.
 * Returns { addr, firmware, own, stop() }.
 */
export async function emulatorFor(args, { flag = "--emu", barSpeed = true, apps = false, name } = {}) {
  const given = option(args, flag);
  if (given) {
    console.log(`emulator at ${given}`);
    return { addr: given, firmware: null, own: false, stop: async () => {} };
  }
  const firmware = firmwareOf(args);
  const started = Date.now();
  const emulator = await ownEmulator({ firmware, barSpeed, apps, name });
  console.log(`emulator of its own at ${emulator.addr}, firmware ${emulator.firmware}${barSpeed ? "" : ", --fast"}${emulator.apps.length ? `, apps ${emulator.apps.join(", ")}` : ""} (started in ${Date.now() - started} ms)`);
  return { addr: emulator.addr, firmware: emulator.firmware, own: true, stop: emulator.stop };
}

let out = null;
/**
 * The folder a suite writes its pictures to: EMU_TEST_OUT when a gate runs it, else a new folder in the system's
 * temporary folder. Never the source tree. Made on first use; the caller prints its path.
 */
export function outputDir(suite) {
  if (out) return out;
  out = process.env.EMU_TEST_OUT || mkdtempSync(join(tmpdir(), `busybar-emulator-${suite}-`));
  mkdirSync(out, { recursive: true });
  return out;
}

/**
 * The suite's last line, read by the gate (test/gate.mjs): how many checks passed, failed and were skipped. Sets the
 * exit code: 1 when anything failed or nothing was checked.
 */
export function totals({ pass, fail, skip = 0 }) {
  console.log(`# totals pass=${pass} fail=${fail} skip=${skip}`);
  process.exitCode = fail || pass + fail === 0 ? 1 : 0;
}

export { sleep };
// Data folders of test processes that are gone: removed here too, so a suite stopped hard leaves nothing for long.
for (const entry of readdirSync(tmpdir())) {
  const pid = entry.startsWith(FOLDER) ? Number(entry.slice(FOLDER.length).split("-")[0]) : NaN;
  if (!Number.isInteger(pid) || pid === process.pid) continue;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code === "ESRCH") rmSync(join(tmpdir(), entry), { recursive: true, force: true });
  }
}
