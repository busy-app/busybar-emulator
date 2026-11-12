// The test entry of the shell. This folder is what makes a build the test variant; a release does not contain it.
//
// The app connects to the address a test gave it (a local socket or a named pipe) and runs what the test sends, in
// the main process, with the shell's state at hand. One JSON document per line each way:
//   → { id, code, arg }    code is the body of an async function (shell, electron, arg)
//   ← { id, ok: true, value } | { id, ok: false, error }
import * as electron from "electron";
import net from "node:net";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

export function connectTestHook(address, shell) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    let rest = "";
    socket.setEncoding("utf8");
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.on("data", async (chunk) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const { id, code, arg } = JSON.parse(line);
        let answer;
        try {
          answer = { id, ok: true, value: await new AsyncFunction("shell", "electron", "arg", code)(shell, electron, arg) };
        } catch (e) {
          answer = { id, ok: false, error: String(e?.stack ?? e) };
        }
        if (!socket.destroyed) socket.write(`${JSON.stringify(answer) ?? JSON.stringify({ id, ok: true })}\n`);
      }
    });
  });
}
