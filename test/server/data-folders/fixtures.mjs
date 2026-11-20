// The data folders the releases wrote (record.mjs), for the tests that open them: test/server/data-format.test.mjs and
// packages/app/test/unit/update-chain.test.mjs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = fileURLToPath(new URL(".", import.meta.url));

/** Every recorded folder, oldest release first: { release, version, commit, format, firmwares, apps, files }. */
export function releasedFolders() {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")))
    .sort((a, b) => a.version.localeCompare(b.version, "en", { numeric: true }));
}

/** Lays the recorded folder out in `root`, with `projects` standing for $PROJECTS (the folder of its projects). */
export function layOut(fixture, root, projects) {
  mkdirSync(root, { recursive: true });
  const inJson = JSON.stringify(projects).slice(1, -1);
  for (const [name, value] of Object.entries(fixture.files)) {
    const at = join(root, ...name.split("/").filter(Boolean));
    if (value === null) mkdirSync(at, { recursive: true });
    else writeFileSync(at, value.text !== undefined ? value.text.split("$PROJECTS").join(inJson) : Buffer.from(value.base64, "base64"));
  }
}
