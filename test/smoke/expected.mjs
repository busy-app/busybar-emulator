#!/usr/bin/env node
// The smoke test's expected frame (test/smoke/front.png): the front frame a bar showed for the scene
// "text-color-center" (test/golden/text-color-center.json, recorded on the bar named there), encoded by the command
// line's own encoder (packages/server/capture/png.mjs). The smoke app (test/smoke/app.busy.smoke) draws the same
// elements from its JS.
//
//   node test/smoke/expected.mjs           writes front.png
//   node test/smoke/expected.mjs --check   exit code 1 if the committed file is not what this makes
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { commandLine } from "../../packages/server/arguments.mjs";
import { encodeScreenPng } from "../../packages/server/capture/png.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN = path.join(here, "..", "golden", "text-color-center.json");
export const EXPECTED = path.join(here, "front.png");

export function expectedPng() {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  return encodeScreenPng("front", Buffer.from(golden.front, "base64"));
}

const same = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && same(realpathSync(process.argv[1]), realpathSync(fileURLToPath(import.meta.url)))) {
  await commandLine(process.argv, { flags: ["--check"] });
  const made = expectedPng();
  if (process.argv.includes("--check")) {
    const same = made.equals(readFileSync(EXPECTED));
    console.log(same ? "front.png is what the golden frame gives" : "front.png differs from what the golden frame gives: run node test/smoke/expected.mjs");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(EXPECTED, made);
  console.log(`wrote ${EXPECTED} (${made.length} bytes)`);
}
