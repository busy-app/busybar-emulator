// The fuses of the release build (ADR-0016, the rules of the shell's security; the list of nine read from the binary of
// Electron 45.2.3 in the security review of EMU-201, S13). Set with @electron/fuses; read back by our own reader, not
// by the library that wrote them, so that a fault in the library is not checked by itself.
import { readFileSync } from "node:fs";
import path from "node:path";

/** The marker Electron puts in front of its fuse wire, and the one wire version this list is for. */
export const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
export const WIRE_VERSION = 1;

/**
 * Every fuse of the wire, by its place in it: what Electron 45.2.3 ships with and what the release has. A wire of
 * another length (a new Electron) fails the check until this list says what its new fuses are.
 */
export const FUSES = Object.freeze([
  { index: 0, name: "RunAsNode", stock: true, release: false, why: "the app's executable must not run as Node (ELECTRON_RUN_AS_NODE)" },
  { index: 1, name: "EnableCookieEncryption", stock: false, release: false, why: "on purpose: no secrets in cookies, and an unsigned build would ask about its keychain item after every update" },
  { index: 2, name: "EnableNodeOptionsEnvironmentVariable", stock: true, release: false, why: "NODE_OPTIONS must not reach the main process" },
  { index: 3, name: "EnableNodeCliInspectArguments", stock: true, release: false, why: "--inspect and the like must not open Node's inspector" },
  { index: 4, name: "EnableEmbeddedAsarIntegrityValidation", stock: false, release: true, why: "the archive is checked against the hash recorded in the app; this protects a signed build only" },
  { index: 5, name: "OnlyLoadAppFromAsar", stock: false, release: true, why: "an app/ folder beside the archive is never loaded" },
  { index: 6, name: "LoadBrowserProcessSpecificV8Snapshot", stock: false, release: false, why: "the app has no snapshot of its own" },
  { index: 7, name: "GrantFileProtocolExtraPrivileges", stock: true, release: false, why: "file:// gets no more than any other scheme" },
  { index: 8, name: "WasmTrapHandlers", stock: true, release: true, why: "left as Electron ships it" },
]);

const bit = (on) => (on ? "1" : "0");
/** The wire as a string of 0 and 1, fuse 0 first. */
export const STOCK_WIRE = FUSES.map((f) => bit(f.stock)).join("");
export const RELEASE_WIRE = FUSES.map((f) => bit(f.release)).join("");

/** The file that holds the fuses: the framework's binary on macOS, the executable on Windows. */
export function fuseFileOf(appPath) {
  if (/\.app$/i.test(appPath)) return path.join(appPath, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  return appPath;
}

/**
 * Reads the fuse wire of a binary. Returns { version, wire } where wire is the states as characters: "0" off, "1" on,
 * "r" removed. Throws when the sentinel is not there or is there more than once (a universal binary is not built).
 */
export function readFuseWire(file, read = readFileSync) {
  const bytes = read(file);
  const sentinel = Buffer.from(SENTINEL, "latin1");
  const at = bytes.indexOf(sentinel);
  if (at < 0) throw new Error(`${file}: no fuse wire (the sentinel is not in the file)`);
  if (bytes.indexOf(sentinel, at + 1) >= 0) throw new Error(`${file}: more than one fuse wire`);
  const version = bytes[at + sentinel.length];
  const length = bytes[at + sentinel.length + 1];
  const wire = bytes.subarray(at + sentinel.length + 2, at + sentinel.length + 2 + length).toString("latin1");
  return { version, wire };
}

/** What is wrong with a wire read from a release, one line each; empty when it is the release's wire. */
export function fuseProblems({ version, wire }) {
  const problems = [];
  if (version !== WIRE_VERSION) problems.push(`fuse wire version ${version}, this list is for version ${WIRE_VERSION}`);
  if (wire.length !== FUSES.length) problems.push(`the wire has ${wire.length} fuses, this list names ${FUSES.length}: say what the new ones are`);
  for (const fuse of FUSES) {
    const state = wire[fuse.index];
    if (state !== bit(fuse.release)) problems.push(`${fuse.name} (fuse ${fuse.index}) is ${state === "1" ? "on" : state === "0" ? "off" : JSON.stringify(state)}, the release has it ${fuse.release ? "on" : "off"}`);
  }
  return problems;
}

/** The fuses as a table for a report: name, the release's state, the state read back. */
export function fuseTable(wire) {
  return FUSES.map((fuse) => ({ index: fuse.index, name: fuse.name, release: fuse.release, read: wire[fuse.index] === "1" ? true : wire[fuse.index] === "0" ? false : wire[fuse.index] ?? null }));
}

/**
 * Sets the release's fuses on an app (the .app bundle or the Windows executable). Every fuse is named, so a wire
 * longer than this list makes @electron/fuses refuse rather than leave a new fuse as Electron ships it.
 */
export async function setReleaseFuses(appPath) {
  const { flipFuses, FuseV1Options, FuseVersion } = await import("@electron/fuses");
  const config = { version: FuseVersion.V1, strictlyRequireAllFuses: true, resetAdHocDarwinSignature: false };
  for (const fuse of FUSES) {
    if (FuseV1Options[fuse.name] !== fuse.index) throw new Error(`@electron/fuses has ${fuse.name} at ${FuseV1Options[fuse.name]}, this list at ${fuse.index}`);
    config[fuse.index] = fuse.release;
  }
  await flipFuses(fuseFileOf(appPath), config);
  const read = readFuseWire(fuseFileOf(appPath));
  const problems = fuseProblems(read);
  if (problems.length) throw new Error(`The fuses did not take: ${problems.join("; ")}`);
  return read;
}
