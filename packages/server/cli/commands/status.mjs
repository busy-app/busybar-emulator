// busy-emulator status: is the emulator running, and in what state.
import { emulatorStatus } from "../lifecycle.mjs";

export default {
  name: "status",
  summary: "Show whether the emulator is running and where its BUSY Bar answers",
  usage: "status",
  async run(ctx, sys) {
    const status = await emulatorStatus(ctx, sys);
    const data = { running: status.running, version: ctx.version, app: ctx.appPath, update_available: status.update ?? null };
    if (!status.running) return { data, text: "The emulator is not running." };
    Object.assign(data, { state: status.state, answering: status.answering, url: status.url, port: status.port, pid: status.pid, detail: status.detail });
    let text;
    if (status.state === "ready" && status.answering) text = `The emulator is running: the BUSY Bar answers at ${status.url} (process ${status.pid}).`;
    else if (status.state === "ready") text = `The emulator is running (process ${status.pid}), but its BUSY Bar does not answer at ${status.url}.`;
    else if (status.state === "starting") text = `The emulator is starting (process ${status.pid}).`;
    else text = `The emulator is running (process ${status.pid}), but its BUSY Bar is not: ${status.state}${status.detail ? ` (${status.detail})` : ""}.`;
    if (status.update) text += `\nA newer version of the emulator is available: ${status.update.version} (${status.update.url}).`;
    return { data, text };
  },
};
