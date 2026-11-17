// The emulated BUSY Bar's firmware as the command line tells it (EMU-321; ADR-0013, epic E12): the firmware the BUSY Bar
// runs, the ones this copy of the emulator has with their API and aliases, and the firmware that would run an app of a
// given api_version. While the emulator runs, its server is asked (GET /_emu/firmware on the management address, with
// the server's key; server.mjs). While it does not, the engine beside the command line is read: the next start runs
// the firmware the BUSY Bar was last switched to (bar/chosen-firmware.json in the data folder), or the latest.
//
// The firmware's own rule decides whether an app goes on a BUSY Bar: an app whose api_version is newer than the
// firmware's API is refused (api_mismatch, web_server_is_api_version_compatible; device.mjs stage and launch). The
// refusal here names both numbers as firmware and API, and both ways out.
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkAppPackage } from "../projects/app-package.mjs";
import { blockedNetwork, commandLine, ready } from "./lifecycle.mjs";
import { CliError } from "./output.mjs";

/** The three numbers of an API version ("27.15.0"), or null. */
function numbers(version) {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version.split(".").map(Number) : null;
}

/** Negative when API `a` is older than `b`, 0 when the same, positive when newer; null when one is no version. */
export function compareApi(a, b) {
  const [x, y] = [numbers(a), numbers(b)];
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** A firmware as the answers name it: { version, api, alias }. */
export const named = (firmware) => (firmware ? { version: firmware.version, api: firmware.api ?? null, alias: firmware.alias ?? null } : null);

/** "1.4.1 (latest)", or "1.4.1". */
export const shownVersion = (firmware) => `${firmware.version}${firmware.alias ? ` (${firmware.alias})` : ""}`;

/**
 * The firmwares of this copy of the emulator, read from its engine (packages/engine: firmware.json and each build's
 * build-info.json), as GET /_emu/firmware lists them: newest first, each { version, api, alias, summary, available,
 * commit, info }. `info` is the build's record (its apps' allowlist, its console's levels); `available` is false for a
 * firmware this copy has no build of. Null when the engine cannot be read.
 */
export async function firmwaresHere() {
  const { firmwareChoices, loadFirmware } = await import("../firmware.mjs");
  let choices;
  try {
    choices = firmwareChoices();
  } catch {
    return null;
  }
  const firmwares = choices.versions.map((version) => {
    let built = null;
    try {
      built = loadFirmware(version);
    } catch {
      // Not built in this copy: it cannot run.
    }
    return { version, api: built?.apiVersion ?? null, alias: choices.aliasOf(version), summary: choices.summaryOf(version), available: built !== null, commit: built?.commit ?? null, info: built?.info ?? null };
  });
  return { latest: choices.latest, previous: choices.previous, firmwares };
}

/**
 * The firmware of `firmwares` that would run an app of API `api`: the oldest whose API is not older than it, or null
 * when none is new enough.
 */
export function firmwareFor(api, firmwares) {
  const fitting = [...firmwares].reverse().filter((one) => one.available !== false && compareApi(one.api, api) >= 0);
  return fitting.sort((a, b) => compareApi(a.api, b.api))[0] ?? null;
}

/**
 * The firmware the next start runs, while the emulator does not run: the one the BUSY Bar was last switched to, if
 * this copy has it, or the latest. `source`: "chosen" or "default".
 */
export function nextStart(ctx, sys, here) {
  let chosen = null;
  try {
    chosen = sys.chosenFirmware?.(ctx.dataDir)?.version ?? null;
  } catch {
    chosen = null;
  }
  const kept = chosen ? here.firmwares.find((one) => one.version === chosen && one.available) : null;
  if (kept) return { firmware: kept, source: "chosen" };
  return { firmware: here.firmwares.find((one) => one.version === here.latest) ?? null, source: "default" };
}

function noManagement(ctx, why, again) {
  const self = commandLine(ctx);
  return new CliError("no_management", `The emulator is running, but its management address cannot be asked: ${why}.`, `Run ${self} quit, then ${self} start, then ${again} again.`);
}

/**
 * GET /_emu/firmware of the running emulator, or POST it with `body`: { status, body } with the body as JSON (null
 * when it is none). Throws the command line's failure when the management address cannot be asked. `again` is the
 * command for the hints.
 */
export async function askEmulator(ctx, sys, status, { method = "GET", body = null, waitMs = 10_000, again }) {
  const control = sys.readControl(ctx.dataDir);
  if (control.blocked) throw new CliError("blocked_file", `This process may not read the emulator's data folder ${ctx.dataDir} (${control.blocked}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.");
  if (control.missing) throw noManagement(ctx, control.missing, again);
  // The lock of another server than the one the app's mirror names: its key is not used.
  if (control.barPort !== status.port) throw noManagement(ctx, `the data folder's server is on port ${control.barPort}, the emulated BUSY Bar on ${status.port}`, again);
  const answer = await sys.askFirmware(control.port, control.key, method, body, waitMs);
  if (answer.blocked) throw blockedNetwork(control.port, answer.blocked);
  if (answer.failed) throw noManagement(ctx, `127.0.0.1:${control.port} did not answer (${answer.failed})`, again);
  if (answer.status === 401) throw noManagement(ctx, "it did not take the server's key (the emulator has just started again)", again);
  let parsed = null;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    // Not the emulator's answer: the caller says so.
  }
  return { status: answer.status, body: parsed };
}

/**
 * The firmware the running emulator's BUSY Bar runs, { version, api, alias, commit }, or null when it does not run or
 * would not say. Never fails: status and version tell what they can. The management address first; the BUSY Bar's
 * own /_emu/state when that cannot be asked.
 */
export async function runningFirmware(ctx, sys, status) {
  if (!ready(status)) return null;
  if (typeof sys.askFirmware === "function" && typeof sys.readControl === "function") {
    try {
      const answer = await askEmulator(ctx, sys, status, { waitMs: 5000, again: "this" });
      const firmware = answer.status === 200 ? answer.body?.firmware : null;
      if (typeof firmware?.version === "string") return { version: firmware.version, api: firmware.api ?? null, alias: firmware.alias ?? null, commit: firmware.commit ?? null };
    } catch {
      // The BUSY Bar's own answer below.
    }
  }
  try {
    const answer = await sys.barGet?.(status.port, "/_emu/state");
    if (answer?.status === 200) {
      const state = JSON.parse(answer.body);
      if (typeof state?.firmware?.name === "string") {
        const alias = (await firmwaresHere().catch(() => null))?.firmwares.find((one) => one.version === state.firmware.name)?.alias ?? null;
        return { version: state.firmware.name, api: state.api_version ?? null, alias, commit: state.firmware.commit ?? null };
      }
    }
  } catch {
    // Nothing to tell.
  }
  return null;
}

/** The firmwares with their API, for a refusal: the running emulator's list, or the engine's. */
async function firmwareList(ctx, sys, status) {
  try {
    if (typeof sys.askFirmware === "function") {
      const answer = await askEmulator(ctx, sys, status, { waitMs: 5000, again: "this" });
      if (answer.status === 200 && Array.isArray(answer.body?.firmwares)) return answer.body.firmwares;
    }
  } catch {
    // The engine's below.
  }
  return (await firmwaresHere())?.firmwares ?? [];
}

/**
 * Where a project's manifest is, as busy-cli builds it: src/appmeta/manifest.json, or appmeta/ at the top. Written
 * with forward slashes on every system, as check names it (readiness/facts.mjs sourceManifest): a path inside the
 * project, which PowerShell, cmd and Git Bash all take.
 */
export function manifestOf(dir) {
  for (const relative of ["src/appmeta/manifest.json", "appmeta/manifest.json"]) {
    try {
      readFileSync(path.join(dir, ...relative.split("/")));
      return relative;
    } catch {
      // the next
    }
  }
  return "src/appmeta/manifest.json";
}

/**
 * The refusal of an app whose api_version is newer than the API of the firmware the BUSY Bar runs: both numbers as
 * firmware and API, then both ways out, in this order: a lower api_version, if the app needs nothing newer; the
 * firmware that runs it (the oldest of this emulator's whose API is not older than the app's).
 * @param {object} o
 * @param {string} o.name        the app, as the text names it
 * @param {string} o.api         the app's api_version
 * @param {string} o.manifest    where its api_version is written, as the author finds it
 * @param {{ version: string, api: string }} o.running  the firmware the BUSY Bar runs
 * @param {object[]} o.firmwares the firmwares there are, with their API
 */
export function apiMismatch(ctx, { id = null, name, api, manifest, running, firmwares }) {
  const self = commandLine(ctx);
  const target = firmwareFor(api, firmwares);
  const newest = [...firmwares].filter((one) => numbers(one.api)).sort((a, b) => compareApi(b.api, a.api))[0] ?? null;
  let message = `${name} needs API ${api}; this BUSY Bar runs firmware ${running.version}, API ${running.api}.`;
  let hint;
  if (target || !newest) {
    hint = `If ${name} needs nothing newer, set api_version to ${running.api} in ${manifest} and build again.${target ? ` Or switch:\n  ${self} firmware use ${target.alias ?? target.version}` : ""}`;
  } else {
    message += ` No firmware here has API ${api}; the newest is ${newest.version}, API ${newest.api}.`;
    hint = `Set api_version to ${newest.api} or lower, or look for a newer emulator:\n  ${self} update --check`;
  }
  return new CliError("api_mismatch", message, hint, { id, api_version: api, firmware: { version: running.version, api: running.api }, needs_firmware: named(target), manifest });
}

/**
 * The refusal for the app `api` on the running BUSY Bar, or null when its firmware takes it: the firmware's rule
 * (api_version not newer than the firmware's API), asked of the BUSY Bar itself (GET /api/version).
 */
export async function refusalFor(ctx, sys, status, { id = null, name, api, manifest }) {
  if (!numbers(api)) return null;
  let barApi = null;
  try {
    const answer = await sys.barGet(status.port, "/api/version");
    barApi = answer.status === 200 ? (JSON.parse(answer.body).api_semver ?? null) : null;
  } catch {
    barApi = null;
  }
  if (!numbers(barApi) || compareApi(api, barApi) <= 0) return null;
  const running = (await runningFirmware(ctx, sys, status)) ?? { version: "(unknown)", api: barApi };
  return apiMismatch(ctx, { id, name, api, manifest, running: { version: running.version, api: barApi }, firmwares: await firmwareList(ctx, sys, status) });
}

/**
 * The refusal for the project's built package (dist/<id>.tgz) on the running BUSY Bar, or null: before busy-cli
 * uploads it, so that the answer names the firmware and the way out rather than an HTTP 400. A package that cannot be
 * read is left to busy-cli, which says why.
 */
export async function packageRefusal(ctx, sys, status, project) {
  if (!project.id) return null;
  let api;
  try {
    api = checkAppPackage(readFileSync(path.join(project.dir, "dist", `${project.id}.tgz`))).api_version;
  } catch {
    return null;
  }
  return refusalFor(ctx, sys, status, { id: project.id, name: project.id, api, manifest: manifestOf(project.dir) });
}
