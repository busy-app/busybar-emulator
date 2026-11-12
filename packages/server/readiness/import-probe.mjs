// What each script of a built app imports, found by parsing it as a JavaScript module without running it: Node's
// vm.SourceTextModule parses the source and lists its import specifiers; nothing is evaluated or linked, and no file
// is loaded. The parser needs a Node started with --experimental-vm-modules, so it runs in a short process of its own,
// on the Node the command line was given (the one inside the app), started by its full path.
import { startProgram } from "../../engine/programs.mjs";

const PROBE = `
import vm from "node:vm";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const answer = {};
for (const [name, source] of Object.entries(JSON.parse(input))) {
  try {
    const module = new vm.SourceTextModule(source, { identifier: name });
    answer[name] = { imports: module.dependencySpecifiers ?? module.moduleRequests.map((request) => request.specifier) };
  } catch (error) {
    answer[name] = { error: String(error?.message ?? error).split("\\n")[0].slice(0, 300) };
  }
}
process.stdout.write(JSON.stringify(answer));
`;

const TIMEOUT = 20_000;

/**
 * Parses modules. `modules` is { name: source }; the answer has, for each name, { imports: string[] } or { error }.
 * Rejects with what happened when the process cannot be started or does not answer.
 * @param {string} node  the full path of the Node to run on
 * @param {Record<string, string>} modules
 * @param {Record<string, string|undefined>} [env]  the caller's environment; only what a process needs to start is passed on
 */
export function probeImports(node, modules, env = {}) {
  const passed = {};
  for (const name of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR"]) if (env[name]) passed[name] = env[name];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = startProgram(node, ["--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", PROBE], { env: passed, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (err = (err + chunk).slice(-2000)));
    child.stdin.on("error", () => {});
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(signal ? `the parser was stopped (${signal})` : `the parser ended with code ${code}: ${err.trim().split("\n").pop() ?? ""}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("the parser gave no answer"));
      }
    });
    child.stdin.end(JSON.stringify(modules));
  });
}
