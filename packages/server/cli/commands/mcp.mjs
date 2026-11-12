// busy-emulator mcp: the emulator's commands as tools of the Model Context Protocol, for chat clients that cannot run
// commands (ADR-0010). A client starts this command and speaks MCP to it on stdin and stdout until it closes stdin;
// the tools run the command line's own commands (../mcp/tools.mjs), and grant nothing the command line does not.
import { serveStdio } from "../mcp/server.mjs";

export default {
  name: "mcp",
  summary: "Serve the emulator's commands as MCP tools on stdin and stdout, for chat clients that cannot run commands",
  usage: "mcp",
  async run(ctx, sys, { commands, main }) {
    await serveStdio(ctx, sys, commands, main);
    return { data: {}, text: "" };
  },
};
