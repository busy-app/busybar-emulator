// What the emulator leaves in its data folder that nobody comes back for (audit H12): a clip whose command gave up
// waiting (it is finished in captures/ and never moved to the person's folder), the screenshots an agent took through
// MCP without a project folder (mcp/screenshots/). Each is removed once it is older than its folder's time to keep.
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

/** A clip waits this long in captures/ for the command that asked for it. */
export const CLIP_KEEP_MS = 24 * 3600_000;
/** An agent's screenshot outside a project stays this long: the agent has seen it in its answer. */
export const MCP_SCREENSHOT_KEEP_MS = 7 * 24 * 3600_000;

/**
 * Removes the files of `folder` (not its folders) whose names `match` takes and that were last changed more than
 * `keepMs` ago. Returns the names removed; a folder that is not there, or a file that cannot be removed, is no error.
 */
export function removeOlderThan(folder, keepMs, { match = () => true, now = Date.now() } = {}) {
  let names = [];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!match(name)) continue;
    const file = path.join(folder, name);
    try {
      const stat = statSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= keepMs) continue;
      rmSync(file, { force: true });
      removed.push(name);
    } catch {
      // in use, or gone already
    }
  }
  return removed;
}
