// busy-emulator allow-local [<port>] [--remove <port>]: the ports of this computer that apps on the emulated BUSY Bar may
// reach (ADR-0012 section 5, EMU-256). An app's request to this computer is refused unless its port was allowed; the
// desktop app takes no --allow-local at its start, so this command asks the running server: it reads the server's
// management address (run/server.lock) and key (the file "key") from the data folder and sends the key to 127.0.0.1
// alone. A port stays allowed until the emulator quits, as with --allow-local. Without a port the command lists the
// allowed ones. It does not start the emulator: when that is not running and ready, the answer is not_running.
//
// With the desktop app, allowing a port is the person's click, as trusting a folder is (trust.mjs): the app asks in a
// dialog of its own, and the command waits up to two minutes for the answer. The key alone does not do it, since any
// program on this computer can read it, an agent's shell too (audit, 11.11). A server started without the app (from
// the source folder) takes the key's word, as it takes --allow-local from whoever started it.
import { parseLocalPort } from "../../local-access.mjs";
import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";

const USAGE = "allow-local [<port>] [--remove <port>]";
/** How long the person is given to answer the app's question; the server waits as long (TRUST_WAIT_MS). */
const ASK_WAIT_S = 120;

/** The port as it was given, checked here as the server checks it: a wrong one is a wrong call. */
function portOf(value, what, self) {
  try {
    return parseLocalPort(value, what);
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    throw new CliError("usage", e.message, `Usage: ${self} ${USAGE}`, { argument: value });
  }
}

function noManagement(why, self, again) {
  return new CliError("no_management", `The emulator is running, but its management address cannot be asked: ${why}.`, `Run ${self} quit, then ${self} start, then ${again} again.`);
}

const listed = (ports) => (ports.length ? ports.join(", ") : "none");

export default {
  name: "allow-local",
  summary: "Let apps on the BUSY Bar reach a port of this computer until the emulator quits (--remove takes it back; without a port, list the allowed ones)",
  usage: USAGE,
  maxArguments: 1,
  options: { "--remove": { key: "remove", value: "<port>" } },
  async run(ctx, sys, { args, options, progress }) {
    const self = commandLine(ctx);
    // No MCP tool runs this (mcp/tools.mjs): opening a port of the computer is the person's step. Said here as well, so
    // that a tool added later cannot do it by accident.
    if (ctx.mcp) throw new CliError("person_only", "Only the person can let apps reach a port of this computer.", `Ask them to run ${self} allow-local <port> in a terminal.`);
    const removing = options.remove !== undefined;
    if (removing && args.length) {
      throw new CliError("usage", "allow-local takes a port to allow or --remove <port>, not both.", `Usage: ${self} ${USAGE}`, { arguments: args });
    }
    const action = removing ? "removed" : args.length ? "allowed" : "listed";
    const port = removing ? portOf(options.remove, "allow-local --remove", self) : args.length ? portOf(args[0], "allow-local", self) : null;
    const again = `${self} allow-local${removing ? " --remove" : ""}${port === null ? "" : ` ${port}`}`;

    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start, then run ${again} again.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running: ports are allowed while it runs, until it quits.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready: ${status.answering === false ? "it does not answer" : status.state}${status.detail ? ` (${status.detail})` : ""}.`, hint, { state: status.state ?? null });
    }
    const control = sys.readControl(ctx.dataDir);
    if (control.blocked) {
      throw new CliError("blocked_file", `This process may not read the emulator's data folder ${ctx.dataDir} (${control.blocked}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
    }
    if (control.missing) throw noManagement(control.missing, self, again);
    // The lock of another server than the one the app's mirror names: its key is not shown to anybody.
    if (control.barPort !== status.port) throw noManagement(`the data folder's server is on port ${control.barPort}, the emulated BUSY Bar on ${status.port}`, self, again);

    const allowing = !removing && port !== null;
    if (allowing) progress?.(`Asking the person in BUSY Bar Emulator whether apps may reach port ${port} of this computer (waiting up to ${ASK_WAIT_S} s for their click)…`);
    const answer = await sys.localPorts(control.port, control.key, removing ? "DELETE" : port === null ? "GET" : "POST", port, allowing ? (ASK_WAIT_S + 5) * 1000 : undefined);
    if (answer.blocked) throw blockedNetwork(control.port, answer.blocked);
    if (answer.failed) throw noManagement(`127.0.0.1:${control.port} does not answer (${answer.failed})`, self, again);
    let body = null;
    try {
      body = JSON.parse(answer.body);
    } catch {
      // Not the emulator's answer; told below.
    }
    // The emulator's own addresses: the server says which.
    if (answer.status === 400 && typeof body?.error === "string") throw new CliError("port_refused", body.error, null, { port });
    // A server that started since the key was read has another key.
    if (answer.status === 401) throw noManagement("it did not take the server's key (the emulator has just started again)", self, again);
    const said = typeof body?.error === "string" ? body.error.replace(/\.$/, "") : null;
    const notYet = "Do not ask again unless the person tells you to: an app that needs a service of this computer is tried against it by the person.";
    if (answer.status === 409) throw new CliError("local_busy", `${said ?? "Another question to the person is open in the emulator"}.`, `Wait until the person has answered it, then run ${again} again.`, { port });
    if (answer.status === 429) throw new CliError("local_refused", `The person chose "Don't Allow" for port ${port} a moment ago, so the emulator does not ask them again yet. Apps may still not reach it.`, notYet, { port, retry_after_s: Number.isFinite(body?.retry_after_s) ? body.retry_after_s : null });
    if (answer.status === 200 && body?.allowed === false) {
      if (body.answer === "refuse") throw new CliError("local_refused", `The person chose "Don't Allow" for port ${port}: apps on the emulated BUSY Bar may still not reach it.`, notYet, { port });
      if (body.answer === "no_answer") throw new CliError("local_no_answer", `Nobody answered the emulator's question about port ${port} within ${ASK_WAIT_S} s; the dialog was taken away and the port stays closed.`, `Tell the person that BUSY Bar Emulator will ask them about port ${port}, then run ${again} again.`, { port });
      throw new CliError("local_unavailable", `The emulator could not ask the person about port ${port}${body.reason ? `: ${body.reason}` : ""}. The port stays closed.`, `Tell the person: ports are allowed in the emulator's dialog, which needs its app running with its window (${self} start). Then run ${again} again.`, { port });
    }
    if (answer.status !== 200 || !Array.isArray(body?.ports)) throw noManagement(`it answered ${answer.status}`, self, again);

    const { ports } = body;
    const data = { action, ...(port === null ? {} : { port }), ...(removing ? { was_allowed: body.withdrawn === true } : {}), ...(allowing && typeof body.asked === "boolean" ? { asked: body.asked } : {}), ports };
    if (action === "listed") {
      return { data, text: ports.length ? `Apps on the emulated BUSY Bar may reach these ports of this computer: ${listed(ports)}.` : `Apps on the emulated BUSY Bar may reach no port of this computer. Allow one with ${self} allow-local <port>.` };
    }
    if (action === "removed") {
      const first = body.withdrawn === true ? `Apps on the emulated BUSY Bar may not reach port ${port} of this computer any more.` : `Port ${port} was not allowed; nothing changed.`;
      return { data, text: `${first}\nAllowed ports: ${listed(ports)}.` };
    }
    return {
      data,
      text: `${body.asked === true ? "The person allowed it: apps" : "Apps"} on the emulated BUSY Bar may reach port ${port} of this computer now, until the emulator quits. Take it back with ${self} allow-local --remove ${port}.\nAllowed ports: ${listed(ports)}.`,
    };
  },
};
