// busy-emulator start: start the emulator with its window and wait until its BUSY Bar answers; if it runs, bring its window
// to the front. The app gets no arguments (ADR-0016).
import { ensureRunning } from "../lifecycle.mjs";

export default {
  name: "start",
  summary: "Start the emulator and wait until its BUSY Bar answers; bring its window to the front if it is already running",
  usage: "start",
  async run(ctx, sys) {
    const { alreadyRunning, status } = await ensureRunning(ctx, sys, { bringForward: true });
    return {
      data: { already_running: alreadyRunning, url: status.url, port: status.port, pid: status.pid, version: ctx.version },
      text: alreadyRunning ? `The emulator was already running; the BUSY Bar answers at ${status.url}.` : `The emulator is running; the BUSY Bar answers at ${status.url}.`,
    };
  },
};
