#!/usr/bin/env node
// The update's pop-up, live: a development run of the app from this folder that is offered a pretend newer version
// with the release notes of 0.1.0-beta.6 as GitHub has them (test/fixtures/release-notes-v0.1.0-beta.6.md), so that the
// pop-up shows as soon as the window opens. For looking at the pop-up; nothing is downloaded or installed.
//
//   BUSY_EMULATOR_PORT=8653 BUSY_EMULATOR_DATA=<an empty temporary folder> node tools/update-popup-preview.mjs [--download] [--notes <file.md>] [--version <x.y.z>]
//
// Only a development run reads the variables used here (config.mjs): the stand-in for GitHub's answer is on
// 127.0.0.1 at a port of the system's choosing, and a release ignores it. BUSY_EMULATOR_DATA is required, so that the
// preview never writes to the person's data folder; the folder is marked as past the first run's greeting. Without
// --download the app may update itself (Update now; the stand-in has no files, so a click ends in "The update failed"),
// with a copy of a pretend app bundle in the data folder as the one it would replace; with --download it is the copy
// that cannot, and the pop-up offers Download. Release notes and Download open the real release page of the pretend
// version, which GitHub does not have. Ctrl+C or closing the app ends both.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { download: { type: "boolean", default: false }, notes: { type: "string" }, version: { type: "string", default: "0.1.0-beta.99" } } });
const data = process.env.BUSY_EMULATOR_DATA;
if (!data || !process.env.BUSY_EMULATOR_PORT) {
  console.error("Name a port and a data folder of its own: BUSY_EMULATOR_PORT=8653 BUSY_EMULATOR_DATA=<an empty temporary folder>");
  process.exit(2);
}
const notes = readFileSync(values.notes ? path.resolve(values.notes) : path.join(appDir, "test", "fixtures", "release-notes-v0.1.0-beta.6.md"), "utf8");
const answer = JSON.stringify({ tag_name: `v${values.version}`, body: notes });

mkdirSync(data, { recursive: true });
const settings = path.join(data, "app-settings.json");
if (!existsSync(settings)) writeFileSync(settings, `${JSON.stringify({ welcomed: true })}\n`);

const github = createServer((req, res) => {
  const body = req.url.endsWith("/releases/latest") ? answer : "";
  res.writeHead(body ? 200 : 404, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((resolve) => github.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${github.address().port}`;

const env = { ...process.env, BUSY_EMULATOR_NODE: process.env.BUSY_EMULATOR_NODE ?? process.execPath, BUSY_EMULATOR_UPDATE_URL: `${base}/repos/busy-app/busybar-emulator/releases/latest` };
if (!values.download) {
  // What a copy that may replace itself has: the releases' address, a key to check them with, and its own place.
  const preview = path.join(data, "update-preview");
  mkdirSync(preview, { recursive: true });
  const key = path.join(preview, "update-public.pem");
  writeFileSync(key, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }));
  let target;
  if (process.platform === "darwin") {
    target = path.join(preview, "Applications", "BUSY Bar Emulator.app");
    mkdirSync(path.join(target, "Contents", "MacOS"), { recursive: true });
  } else {
    target = path.join(preview, "Programs", "BUSY Bar Emulator");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "busybar-emulator-install.json"), '{"app":"app.busy.emulator","by":"setup"}\r\n');
  }
  Object.assign(env, { BUSY_EMULATOR_UPDATE_RELEASES: `${base}/download`, BUSY_EMULATOR_TEST_UPDATE_KEY: key, BUSY_EMULATOR_TEST_UPDATE_TARGET: target, BUSY_EMULATOR_TEST_UPDATE_ANSWER: "no" });
}

const electron = createRequire(import.meta.url)("electron");
const child = spawn(electron, [appDir], { stdio: "inherit", env });
const end = () => child.kill();
process.on("SIGINT", end);
process.on("SIGTERM", end);
child.on("exit", (code, signal) => {
  github.close();
  process.exit(code ?? (signal ? 1 : 0));
});
