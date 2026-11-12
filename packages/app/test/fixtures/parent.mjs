// Plays the shell for the supervisor's tests: starts a server through the supervisor exactly as the shell does, tells
// the supervisor's process id on its standard output once the server is ready, and then only waits — to be killed.
//   node parent.mjs <node> <supervisor> <server module> <port> <data folder>
import { startServerProcess } from "../../src/server-process.mjs";

const [nodePath, supervisorPath, serverEntry, port, dataDir] = process.argv.slice(2);
const run = startServerProcess({
  nodePath,
  supervisorPath,
  serverEntry,
  serverOptions: { port: Number(port), dataDir },
  env: process.env,
  onLine: () => {},
  onReady: () => console.log(JSON.stringify({ supervisor: run.pid, parent: process.pid })),
});
setInterval(() => {}, 1000);
