// What the computer's file system adds to the data folder by itself.
//
// macOS keeps extended attributes of a file on a volume that cannot hold them (exFAT, FAT, many network shares) in a
// "._<name>" file beside it, and on current macOS every file a process writes gets one (com.apple.provenance). An app
// archive made on macOS also brings "._<name>" files, and the bar keeps and lists them as ordinary files (EMU-223).
// On such a volume the two are one and the same file on the disk, so they cannot be told apart by name or content:
// it is the volume that decides.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runProgram } from "../engine/programs.mjs";

const PROBE = /^(?:\._)?\.emu-volume-probe-(\d+)$/;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
};

/**
 * { sidecars, problem }: sidecars is true when macOS writes "._<name>" files for attributes in `dir` — a probe file
 * gets an attribute, and the check is whether its "._" file appears. False on Windows and Linux, and on APFS and
 * HFS+, which keep attributes themselves. `problem` says why the probe could not run (then sidecars is false).
 * Probe files that a stopped emulator left behind are removed first.
 */
export function volumeMakesSidecars(dir) {
  if (process.platform !== "darwin") return { sidecars: false };
  const name = `.emu-volume-probe-${process.pid}`;
  const probe = join(dir, name);
  const sidecar = join(dir, `._${name}`);
  let step = "make the data folder";
  try {
    mkdirSync(dir, { recursive: true });
    step = "remove a probe file left behind";
    for (const left of readdirSync(dir, { withFileTypes: true })) {
      const m = PROBE.exec(left.name);
      // Only files: a folder with such a name is not the emulator's, and is left alone.
      if (m && !left.isDirectory() && Number(m[1]) !== process.pid && !alive(Number(m[1]))) rmSync(join(dir, left.name), { force: true });
    }
    step = "write a file in the data folder";
    writeFileSync(probe, "");
    step = "set an attribute with /usr/bin/xattr";
    runProgram("/usr/bin/xattr", ["-w", "com.busy.emulator.probe", "1", probe], { stdio: "ignore" });
    return { sidecars: existsSync(sidecar) };
  } catch (e) {
    return { sidecars: false, problem: `cannot ${step}: ${e?.code ?? e?.message ?? e}` };
  } finally {
    rmSync(probe, { force: true });
    rmSync(sidecar, { force: true });
  }
}

/**
 * The names of a folder that the bar would list. On a volume with sidecars a "._X" with an "X" beside it is the
 * system's (or, if it came from an archive, cannot be told from the system's) and is left out; elsewhere every name is
 * listed.
 */
export function visibleNames(names, sidecars) {
  if (!sidecars) return names;
  const all = new Set(names);
  return names.filter((n) => !(n.startsWith("._") && all.has(n.slice(2))));
}
