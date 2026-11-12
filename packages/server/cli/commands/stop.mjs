// busy-emulator stop [<folder>]: the app running on the emulated BUSY Bar stops, by the project's own busy-cli
// (`busy-cli app stop --addr <the emulator>`) on the Node inside the app (EMU-217). It stops the app, not the emulator:
// the emulator ends with quit.
import { appCommand } from "../project.mjs";

export default appCommand({
  name: "stop",
  summary: "Stop the app running on the emulated BUSY Bar (busy-cli app stop); quit ends the emulator",
  done: (_project, address) => `Stopped the app running on the emulated BUSY Bar at ${address}.`,
});
