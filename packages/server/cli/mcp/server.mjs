// `busy-emulator mcp` on the standard streams: one JSON-RPC message per line in on stdin and out on stdout, the log on
// stderr (the stdio transport of MCP). Whatever else in this process would write to stdout (a stray console.log of a
// command) goes to stderr: stdout carries only MCP messages. The server ends when stdin ends, after it has answered
// what it was asked.
import { CLI_NAME } from "../context.mjs";
import { asciiJson } from "../output.mjs";
import { createSession } from "./protocol.mjs";
import { readResource, resourceList } from "./resources.mjs";
import { toolList, toolRunner } from "./tools.mjs";

export const INSTRUCTIONS = [
  "BUSY Bar Emulator: a BUSY Bar on this computer, to make, run and look at BUSY Bar apps without the device.",
  "Start with status (and start when it is not running), then create_app, edit the code in the project's folder, refresh, screenshot. For the app catalog: icon, catalog_texts, then publish step by step (screenshots, readme, prepare; then signin, push, pr, which the person confirms in the emulator's window).",
  "Read the resource busy-emulator://guide/start for the steps and busy-emulator://guide/project for how an app is written.",
  "Only the person chooses the license, the AI usage and the GitHub account, and confirms the push and the pull request and ticks the catalog's author checklist in the emulator's window: ask them, never choose or tick for them.",
  "Each answer has ok; a failure has code, message and hint. A hint names a command of the busy-emulator command line: the tool of the same name does it here (create is create_app, dev --once is refresh, settings get/set are settings_get/settings_set).",
  "No tool lets an app reach a port of this computer: when an app's log says a request to this computer was refused, ask the person to run busy-emulator allow-local <port> in a terminal.",
  "Settings marked sensitive (a token) are shown as (hidden); settings_set still sets them.",
  "A tool that takes far longer than it should is stopped with the programs it started and answers tool_timeout; status, logs and screenshot answer while a build runs.",
  "The project tools take only folders the emulator knows (the projects tool): untrusted_project means only the person can trust that folder, by running busy-emulator trust <folder> in a terminal.",
].join(" ");

/**
 * Serves MCP until `input` ends.
 * @param {object} ctx       resolveContext()
 * @param {object} sys       the system (system.mjs)
 * @param {object[]} commands  the command line's commands
 * @param {Function} main      the command line's main() (busy-emulator.mjs)
 */
export async function serveStdio(ctx, sys, commands, main, { input = process.stdin, output = process.stdout, errors = process.stderr } = {}) {
  const write = output.write.bind(output);
  const log = (line) => errors.write(`${CLI_NAME} mcp: ${line}\n`);
  const stdout = output === process.stdout ? process.stdout.write : null;
  if (stdout) process.stdout.write = (...args) => process.stderr.write(...args);
  // The commands take a missing folder as "the caller's folder": here that is a folder that is no project (the data
  // folder), so that a project in the folder a client happened to start this process in is never acted on.
  // ctx.mcp: the caller is a model through this server (the settings command hides sensitive values for it).
  const env = { ctx: { ...ctx, mcp: true }, sys: { ...sys, cwd: () => ctx.dataDir }, commands, main };
  const session = createSession({
    server: { name: CLI_NAME, title: "BUSY Bar Emulator", version: ctx.version ?? "0.0.0" },
    instructions: INSTRUCTIONS,
    tools: toolList,
    callTool: toolRunner(env),
    resources: resourceList,
    readResource,
    send: (message) => write(`${asciiJson(message)}\n`),
    log,
  });
  log(`serving on stdin and stdout (data folder ${ctx.dataDir})`);
  let rest = "";
  input.setEncoding("utf8");
  await new Promise((resolve, reject) => {
    input.on("data", (chunk) => {
      rest += chunk;
      let end;
      while ((end = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, end);
        rest = rest.slice(end + 1);
        session.receive(line);
      }
    });
    input.on("end", resolve);
    input.on("error", reject);
  });
  if (rest) session.receive(rest);
  await session.settled();
  if (stdout) process.stdout.write = stdout;
  log("stdin ended");
}
