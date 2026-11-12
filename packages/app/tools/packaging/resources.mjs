// The resources folder of a built app: what EMU-202 lays out (the bundled Node, the command line's entry, the marker,
// and the server with the part of the engine it runs on, copied by the list of composition.mjs), and the license
// summary (THIRD_PARTY_NOTICES.md, tools/notices/notices.mjs).
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { NOTICES_FILE, noticesText } from "../notices/notices.mjs";
import { BUILD_MARKER, stageResources, writeBuildMarker } from "../stage-resources.mjs";

/**
 * Lays out <resourcesDir>: Node, bin/, build.json, emulator/ (the committed files of emulatorFiles()), and
 * THIRD_PARTY_NOTICES.md. The summary is made first: if it is older than what the build ships, nothing is laid out.
 */
export async function stageAppResources({ target, resourcesDir, kind, cacheDir, commit, log = () => {} }) {
  const notices = noticesText({ platform: target.split("-")[0], commit });
  const staged = await stageResources({ target, resourcesDir, kind, cacheDir, commit, log });
  writeFileSync(path.join(resourcesDir, NOTICES_FILE), notices);
  return staged;
}

/** The bytes of the marker for a kind of build and its commit, as stage-resources.mjs writes it. */
export function markerBytes(kind, commit = undefined) {
  const folder = path.join(os.tmpdir(), `busy-emulator-marker-${process.pid}-${Date.now()}`);
  try {
    writeBuildMarker(folder, { kind, commit });
    return readFileSync(path.join(folder, BUILD_MARKER), "utf8");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** Every file under a folder, relative, with forward slashes, sorted. Links are listed, not followed. */
export function filesUnder(folder, prefix = "") {
  const out = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...filesUnder(path.join(folder, entry.name), p));
    else out.push(p);
  }
  return out.sort();
}
