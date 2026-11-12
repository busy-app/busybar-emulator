// busy-emulator update [--check]: the built-in update of the emulator (EMU-221; packages/app/src/updater.mjs).
//
//   update --check   asks GitHub now which version is the latest, through the running app, and says whether this copy
//                    can update itself (and if not, why: the disk image, a folder it may not write to). Changes nothing.
//   update           the same check, then the update itself, which is the person's decision: the emulator's app asks
//                    them in a dialog of its own (as for publishing), and only with their yes downloads the new
//                    version from GitHub, checks its signature and SHA-256, quits and opens again as the new version.
//                    Nothing on the command line gives that yes. The command answers once the app restarts.
//
// Both need the emulator running (not_running otherwise): the app is what checks and updates.
import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

const USAGE = "update [--check]";
const CHECK_WAIT_MS = 60_000;
const UPDATE_WAIT_MS = 31 * 60_000;

export default {
  name: "update",
  summary: "Check for a newer version of the emulator, or update to it (the person confirms in the emulator's window)",
  usage: USAGE,
  maxArguments: 0,
  options: { "--check": { key: "check" } },
  async run(ctx, sys, { options, progress }) {
    const self = commandLine(ctx);
    const checking = options.check === true;
    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) throw new CliError("not_running", "The emulator is not running: its app is what checks for updates and installs them.", `Start it with ${self} start, then run this again.`);
    const control = sys.readControl(ctx.dataDir);
    if (control.blocked) throw new CliError("blocked_file", `This process may not read the emulator's data folder ${ctx.dataDir} (${control.blocked}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
    const unavailable = (why) => new CliError("update_unavailable", `The emulator's app could not be asked about updates: ${why}.`, `Start the BUSY Bar Emulator app (${self} start), then run this again.`);
    if (control.missing) throw unavailable(`its management address cannot be read (${control.missing})`);
    if (!checking) progress?.("Asking the person in the emulator's window whether to update");
    // This process ends with the answer, so the app does not count it among what keeps its folder in use on Windows.
    // The MCP server does not end: it gives no number (and on Windows its tool refuses before it asks, mcp/tools.mjs).
    const answer = await sys.askUpdate(control.port, control.key, checking ? "check" : "install", checking ? CHECK_WAIT_MS : UPDATE_WAIT_MS, ctx.mcp ? null : process.pid);
    if (answer.blocked) throw blockedNetwork(control.port, answer.blocked);
    if (answer.failed) throw unavailable(`127.0.0.1:${control.port} did not answer (${answer.failed})`);
    let body = null;
    try {
      body = JSON.parse(answer.body);
    } catch {
      // below
    }
    if (answer.status !== 200 || !body) throw unavailable(typeof body?.error === "string" ? body.error.replace(/\.$/, "") : `it answered HTTP ${answer.status}`);
    const facts = { current: body.current ?? ctx.version ?? null, latest: body.latest ?? null, available: body.available ?? null, page: body.page ?? null, can_update: body.can_update ?? null, ...(body.why_not ? { why_not: body.why_not } : {}), state: body.state ?? null };
    if (body.ok === false) throw new CliError(body.code ?? "failed", body.message ?? "It failed.", body.hint ?? null, facts);
    if (checking) {
      const lines = [facts.available ? `A newer version is available: ${facts.available} (this is ${facts.current}).` : `This is the newest version, ${facts.current}.`];
      if (facts.available) lines.push(facts.can_update ? `To update: ${self} update (the person confirms in the emulator's window), or Update in the window.` : `This copy cannot update itself: ${facts.why_not} Download it: ${facts.page}`);
      return { data: facts, text: lines.join("\n") };
    }
    return { data: { version: body.version, restarting: true }, text: body.message ?? `The emulator restarts into ${body.version}.` };
  },
};
