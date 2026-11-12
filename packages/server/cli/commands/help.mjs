// busy-emulator help [<command>]: the commands, how to call them, and this command line's own path.
import { pasteForms, selfCall, selfLines, unknownCommand } from "../output.mjs";

export default {
  name: "help",
  summary: "List the commands, or show how to call one",
  usage: "help [<command>]",
  maxArguments: 1,
  async run(ctx, _sys, { args, commands }) {
    const paste = pasteForms(ctx.calledAs, ctx.platform);
    const self = selfCall(paste);
    const cli = { path: ctx.calledAs.length === 1 ? ctx.calledAs[0] : null, argv: ctx.calledAs, ...paste };
    if (args.length) {
      const one = commands.find((command) => command.name === args[0]);
      if (!one) throw unknownCommand(args[0], self);
      const details = Array.isArray(one.details) ? one.details : [];
      return { data: { command_help: { name: one.name, usage: one.usage, summary: one.summary, ...(details.length ? { details } : {}) } }, text: `${one.summary}.\n\n  ${self} ${one.usage} [--json]${details.length ? `\n\n${details.join("\n")}` : ""}` };
    }
    // A usage longer than COLUMN gets its summary on the next line, so that the short ones stay readable.
    const COLUMN = 36;
    const width = Math.max(...commands.map((command) => command.usage.length).filter((length) => length <= COLUMN));
    const row = (command) => (command.usage.length <= COLUMN ? `  ${command.usage.padEnd(width)}  ${command.summary}` : `  ${command.usage}\n  ${"".padEnd(width)}  ${command.summary}`);
    const text = [
      "busy-emulator: the command line of BUSY Bar Emulator.",
      "",
      `Usage: ${self} <command> [--json]`,
      "",
      "Commands:",
      ...commands.map(row),
      "",
      "--json prints one line of JSON. Exit codes: 0 done, 1 the command failed, 2 a wrong call.",
      ...selfLines(paste),
    ].join("\n");
    return { data: { commands: commands.map(({ name, usage, summary }) => ({ name, usage, summary })), cli }, text };
  },
};

