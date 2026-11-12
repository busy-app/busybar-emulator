// app.asar: the app's own files in one archive, made with @electron/asar from an explicit list in a fixed order, every
// file with the same mode, so that two builds of one commit give the same archive on any system. The hash of its
// header is what Electron checks the archive against (ADR-0016: the check protects a signed build only).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { UNPACKED_IN_ARCHIVE } from "./composition.mjs";

/**
 * Writes <dest> (and <dest>.unpacked for UNPACKED_IN_ARCHIVE) from the entries of composition.archiveEntries().
 * @returns {{ file: string, headerHash: string, files: string[] }}
 */
export async function writeAppArchive(dest, entries) {
  const asar = await import("@electron/asar");
  rmSync(dest, { force: true });
  rmSync(`${dest}.unpacked`, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  const folders = new Set();
  const streams = [];
  for (const entry of entries) {
    const parts = entry.name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (folders.has(folder)) continue;
      folders.add(folder);
      // A folder marked unpacked makes every file in it unpacked to the reader: only the files are marked.
      streams.push({ path: folder, type: "directory", unpacked: false });
    }
    const bytes = entry.bytes ?? readFileSync(entry.file);
    streams.push({
      path: entry.name,
      type: "file",
      unpacked: UNPACKED_IN_ARCHIVE.includes(entry.name),
      // One mode for every file: whether a source file happens to be executable on this machine changes nothing.
      stat: { mode: 0o100644, size: bytes.length },
      streamGenerator: () => Readable.from([bytes]),
    });
  }
  await asar.createPackageFromStreams(dest, streams);
  return { file: dest, headerHash: headerHashOf(dest, asar), files: listArchive(dest, asar) };
}

/** The SHA-256 of the archive's header, as Electron computes it for the integrity check. */
export function headerHashOf(file, asar) {
  const { headerString } = asar.getRawHeader(file);
  return createHash("sha256").update(headerString).digest("hex");
}

/** Every file in the archive (not folders), relative, with forward slashes, sorted; unpacked ones included. */
export function listArchive(file, asar) {
  const { header } = asar.getRawHeader(file);
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else out.push(p);
    }
  };
  walk(header, "");
  return out.sort();
}

/** The files marked as unpacked in the archive's header. */
export function unpackedInArchive(file, asar) {
  const { header } = asar.getRawHeader(file);
  const out = [];
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, p);
      else if (child.unpacked) out.push(p);
    }
  };
  walk(header, "");
  return out.sort();
}

export async function loadAsar() {
  return import("@electron/asar");
}
