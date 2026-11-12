// busy-emulator quit: end the emulator, as Quit in its menu does. (stop is a project command, EMU-217: it stops the
// app on the BUSY Bar.) A start that is under way is ended too: quit waits until the app that is coming up has named
// itself, then ends it (lifecycle.mjs quitEmulator).
import { quitEmulator } from "../lifecycle.mjs";

export default {
  name: "quit",
  summary: "Quit the emulator",
  usage: "quit",
  async run(ctx, sys) {
    const { wasRunning, pid, duringStart } = await quitEmulator(ctx, sys);
    // during_start only when it was: a start that was under way is ended with its app (it answers start_interrupted).
    return {
      data: { was_running: wasRunning, ...(wasRunning && duringStart ? { during_start: true } : {}) },
      text: !wasRunning ? "The emulator was not running." : duringStart ? `The emulator (process ${pid}) was still starting; it has quit, and the start that was under way ends.` : `The emulator (process ${pid}) has quit.`,
    };
  },
};
