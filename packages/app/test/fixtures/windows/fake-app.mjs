// The stand-in emulator that fake-app.exe runs: it listens on 127.0.0.1 as the bar and keeps the mirror of its state
// where the command line looks, as the app does (src/install-files.mjs). fake-app.json beside it says where.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

const here = import.meta.dirname;
const { dataDir, port } = JSON.parse(readFileSync(path.join(here, "fake-app.json"), "utf8"));
const started = Date.now();
const server = createServer((_req, res) => res.end("{}"));
server.listen(port, "127.0.0.1", () => {
  mkdirSync(path.join(dataDir, "run"), { recursive: true });
  writeFileSync(path.join(dataDir, "run", "emulator.json"), JSON.stringify({ pid: process.pid, exe: process.execPath, started, port, url: `http://127.0.0.1:${port}`, state: "ready" }));
});
// Not forever, whatever happens to the test.
setTimeout(() => process.exit(0), 120_000);
