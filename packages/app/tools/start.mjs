#!/usr/bin/env node
// Development run: the shell from this folder, with the emulator server on the Node that runs this script.
//   npm start        (from emulator/packages/app)
// Port and data folder: BUSY_EMULATOR_PORT, BUSY_EMULATOR_DATA.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [appDir], {
  stdio: "inherit",
  env: { ...process.env, BUSY_EMULATOR_NODE: process.env.BUSY_EMULATOR_NODE ?? process.execPath },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
