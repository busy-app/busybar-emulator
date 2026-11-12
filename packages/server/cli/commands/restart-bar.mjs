// busy-emulator restart-bar: restarts the emulated BUSY Bar, as holding Back and Start together restarts a BUSY Bar whatever
// its software does (the firmware's supervisor says so on its warnings), and waits until it answers again. For a BUSY Bar
// an app has hung: its JS heap full in the first 30 seconds (the supervisor's warning, no input taken), or a screen
// that no key changes any more.
//
// A restart is the firmware's: the system starts again, the selector's program opens (the APPS screen, which on a
// bar may start the last app again), the running app is gone with what it held in memory. The installed apps, their
// settings and the BUSY Bar's own settings (name, volume, the clock's offset) are kept, as on a BUSY Bar. A BUSY Bar that is powered
// off is turned on by it. The command does not start the emulator.
//
// It asks the emulator's device window path for it (POST /_emu/power?action=restart&wait=1, the window's Restart bar
// button), which answers once the BUSY Bar has drawn its first frame again; then the BUSY Bar's own API has to answer
// (GET /api/version). It reports how long that took, from the request to the answer.
import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

/** How long the restart may take before the command gives up: a bar's start takes a second or two here. */
const RESTART_TIMEOUT_MS = 30_000;
/** After the restart, how many times the bar's API is asked, and how long apart. */
const PROBES = 20;
const PROBE_GAP_MS = 250;

export default {
  name: "restart-bar",
  summary: "Restart the emulated BUSY Bar, as holding Back and Start does on a real one, and wait until it answers again",
  usage: "restart-bar",
  maxArguments: 0,
  options: {},
  async run(ctx, sys) {
    const self = commandLine(ctx);
    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar to restart.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, `Wait a moment and run ${self} restart-bar again, or ${self} status.`);
    }
    const { port } = status;
    const address = `127.0.0.1:${port}`;
    const from = sys.now();
    const answer = await sys.barSend(port, "POST", "/_emu/power?action=restart&wait=1&why=cli", null, RESTART_TIMEOUT_MS);
    if (answer.blocked) throw blockedNetwork(port, answer.blocked);
    const failed = (what) =>
      new CliError("restart_failed", `The emulated BUSY Bar at ${address} ${what}.`, `${self} logs says what happened; ${self} status says whether the emulator still runs.`, { address });
    if (answer.failed) throw failed(`did not restart (${answer.failed})`);
    if (answer.status === 503) throw failed("is off after the restart: its system did not draw its first frame");
    if (answer.status !== 200) throw failed(`did not take the restart (HTTP ${answer.status})`);
    // Up: the bar's own API answers again.
    let up = false;
    for (let n = 0; n < PROBES && !up; n++) {
      if (n) await sys.sleep(PROBE_GAP_MS);
      up = (await sys.barGet(port, "/api/version")).status === 200;
    }
    if (!up) throw failed("restarted, but its API does not answer");
    const ms = sys.now() - from;
    return {
      data: { address, restarted: true, ms },
      text:
        `The emulated BUSY Bar at ${address} restarted, as holding Back and Start does on a real BUSY Bar, and answers again after ${(ms / 1000).toFixed(1)} s. ` +
        `The installed apps and their settings are kept; BUSY Bar shows the mode selector's screen, as after a real restart. To see it: ${self} screenshot --scale 8.`,
    };
  },
};
