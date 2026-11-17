// busy-emulator status: is the emulator running, and in what state. `firmware: { version, api, alias }` is the firmware the
// emulated BUSY Bar runs (as version names it; `firmware` lists the others): null while the emulator does not run or
// its BUSY Bar does not answer.
import { runningFirmware } from "../firmware.mjs";
import { emulatorStatus } from "../lifecycle.mjs";

export default {
  name: "status",
  summary: "Show whether the emulator is running, where its BUSY Bar answers and which firmware it runs",
  usage: "status",
  async run(ctx, sys) {
    const status = await emulatorStatus(ctx, sys);
    const data = { running: status.running, version: ctx.version, app: ctx.appPath, update_available: status.update ?? null, firmware: null };
    if (!status.running) return { data, text: "The emulator is not running." };
    const firmware = await runningFirmware(ctx, sys, status);
    Object.assign(data, { state: status.state, answering: status.answering, url: status.url, port: status.port, pid: status.pid, detail: status.detail, firmware: firmware ? { version: firmware.version, api: firmware.api, alias: firmware.alias ?? null } : null });
    const on = firmware ? `, on firmware ${firmware.version}${firmware.alias ? ` (${firmware.alias})` : ""}, API ${firmware.api}` : "";
    let text;
    if (status.state === "ready" && status.answering) text = `The emulator is running: the BUSY Bar answers at ${status.url} (process ${status.pid})${on}.`;
    else if (status.state === "ready") text = `The emulator is running (process ${status.pid}), but its BUSY Bar does not answer at ${status.url}.`;
    else if (status.state === "starting") text = `The emulator is starting (process ${status.pid}).`;
    else text = `The emulator is running (process ${status.pid}), but its BUSY Bar is not: ${status.state}${status.detail ? ` (${status.detail})` : ""}.`;
    if (status.update) text += `\nA newer version of the emulator is available: ${status.update.version} (${status.update.url}).`;
    return { data, text };
  },
};
