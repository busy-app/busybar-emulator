// The texts of the shell's own messages, in one place. The message page shows them as text, never as markup.
import { APP_NAME } from "./config.mjs";

/**
 * @param {object} state  a state of the server keeper, or { name: "move-app", reason, path }
 * @param {object} config
 * @returns {{ kind: string, title: string, text: string, detail: string | null, actions: string[] }}
 */
export function messageFor(state, config) {
  const log = `The log is at ${config.logFile}`;
  switch (state.name) {
    case "move-app": {
      const why = {
        translocated: "macOS runs it from a temporary read-only place, because it was opened straight from a disk image or from Downloads",
        "read-only-volume": "it is on a read-only disk, as an app opened from a disk image is",
        downloads: "it is in Downloads",
      }[state.reason];
      return {
        kind: "move-app",
        title: `Move ${APP_NAME} to Applications`,
        text: `${APP_NAME} cannot work from where it is now: ${why}. Quit, drag ${APP_NAME} to the Applications folder and open it from there.`,
        detail: state.path,
        actions: ["quit"],
      };
    }
    case "port-busy":
      if (state.reserved) {
        return {
          kind: "port-busy",
          title: `Port ${state.port} is not available`,
          text: `The system does not let ${APP_NAME} listen on 127.0.0.1:${state.port}: the port is reserved, most often by Windows for Hyper-V, WSL or Docker (a range of ports it keeps back), or by a security program. Choose Try again after freeing it. On Windows, "netsh int ipv4 show excludedportrange protocol=tcp" in a Command Prompt lists the reserved ranges; restarting the computer, or stopping Docker Desktop and WSL (wsl --shutdown) first, usually moves them. ${log}.`,
          detail: null,
          actions: ["retry", "quit"],
        };
      }
      return {
        kind: "port-busy",
        title: `Port ${state.port} is in use`,
        text: `The emulated BUSY Bar listens on 127.0.0.1:${state.port}, and another program already does, most likely another copy of the emulator. Stop that program, then choose Try again.`,
        detail: null,
        actions: ["retry", "quit"],
      };
    case "failed": {
      const again = `${log}. Choose Try again; if it fails again, send the log with your report.`;
      const missing = (what) => ({
        text: `${APP_NAME} could not find ${what}, so the emulator was not started: the app is incomplete. Install it again. ${log}.`,
        actions: ["quit"],
      });
      const { text, actions } = {
        "no-node": missing("the Node it runs the emulator server on"),
        "no-server": missing("the emulator server"),
        "no-answer": { text: `The emulator server did not answer within ${Math.round(config.startTimeoutMs / 1000)} s, so it was stopped. ${again}`, actions: ["retry", "quit"] },
        refused: { text: `The emulator server could not start; what it said is below. ${again}`, actions: ["retry", "quit"] },
      }[state.cause] ?? { text: `The emulator server stopped before it was ready. ${again}`, actions: ["retry", "quit"] };
      return { kind: "failed", title: "The emulator did not start", text, detail: state.detail ?? null, actions };
    }
    case "gave-up":
      return {
        kind: "gave-up",
        title: "The emulator keeps stopping",
        text: `The emulator server stopped ${state.deaths} times within ${Math.round(state.withinMs / 1000)} s, so it was not started again. ${log}. Choose Try again to start it once more; if it keeps stopping, send the log with your report.`,
        detail: state.detail ?? null,
        actions: ["retry", "quit"],
      };
    default:
      return {
        kind: "starting",
        title: "Starting the emulator",
        text: `The emulated BUSY Bar is starting. It usually takes a few seconds; if it has not answered within ${Math.round(config.startTimeoutMs / 1000)} s, this window says what went wrong.`,
        detail: null,
        actions: ["quit"],
      };
  }
}
