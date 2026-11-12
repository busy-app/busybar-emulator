// The catalog's own checker for the capture tests: its validate_png and, as its build does, the re-save through Pillow,
// run from a checkout of the catalog repository. Not used by the server. It needs the maintainers' registry tool
// (emulator/tools/catalog-registry), which the public repository does not carry: without it, as without a checkout,
// the tests that compare with the catalog's own checker are skipped and say why.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execProgram } from "../../engine/programs.mjs";

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "catalog-registry", "catalog-registry.mjs");
const { exportCommit, findPython } = existsSync(TOOL) ? await import(pathToFileURL(TOOL).href) : {};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY = JSON.parse(readFileSync(path.join(HERE, "..", "readiness", "catalog-registry.json"), "utf8"));

// ---------------------------------------------------------------- the catalog's own checker

// Runs the catalog's validate_png on each file with the rules it applies to front or back screenshots, then, as its
// build does, checks a copy again and re-saves it as RGBA through Pillow. Prints one JSON line a file.
const DRIVER = `
import json, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from tools.check_png import BACK_SCREENSHOT, BACK_SCREENSHOT_FINAL, SCREENSHOT, SCREENSHOT_FINAL, validate_png
from tools.check_registry import CheckError
try:
    from PIL import Image
    from tools.lib_png import normalize_png
except ImportError:
    normalize_png = None
RULES = {"front": (SCREENSHOT, SCREENSHOT_FINAL), "back": (BACK_SCREENSHOT, BACK_SCREENSHOT_FINAL)}
args = sys.argv[2:]
for screen, name in zip(args[0::2], args[1::2]):
    first, final = RULES[screen]
    result = {"file": name, "id": None, "detail": None, "stage": None, "rgba": None}
    try:
        validate_png(Path(name), *first)
        result["stage"] = "manifest"
        if normalize_png is not None:
            with tempfile.TemporaryDirectory() as work:
                copy = Path(work) / "copy.png"
                shutil.copyfile(name, copy)
                validate_png(copy, *final)
                result["stage"] = "build"
                try:
                    normalize_png(copy, final[0])
                except ValueError as error:
                    raise CheckError(final[1], str(error))
                with Image.open(copy, formats=["PNG"]) as saved:
                    result["rgba"] = saved.tobytes().hex()
                    result["mode"] = saved.mode
    except CheckError as error:
        result["id"] = error.id
        result["detail"] = error.detail
    print(json.dumps(result))
`;

let catalogSetup;

/**
 * The catalog's checker, from the checkout named by BUSY_CATALOG_CHECKOUT at the commit the registry snapshot names.
 * Returns { run(files), pillow, cleanup } or { skip: <why> }. `files` is a list of [display, path].
 */
export function catalogChecker() {
  if (catalogSetup) return catalogSetup;
  if (!exportCommit) return (catalogSetup = { skip: "the registry tool (emulator/tools/catalog-registry) is not in this tree: the catalog's own checker is not run" });
  const checkout = process.env.BUSY_CATALOG_CHECKOUT;
  if (!checkout) {
    return (catalogSetup = { skip: "set BUSY_CATALOG_CHECKOUT to a checkout of the catalog repository to run its own checker" });
  }
  if (!existsSync(checkout)) return (catalogSetup = { skip: `BUSY_CATALOG_CHECKOUT: no such folder ${checkout}` });
  let python;
  try {
    python = findPython();
  } catch (error) {
    return (catalogSetup = { skip: `Python 3 is not available: ${error.message}` });
  }
  const commit = REGISTRY.source.commit;
  let exported;
  try {
    exported = exportCommit(checkout, commit);
  } catch (error) {
    return (catalogSetup = { skip: `cannot read commit ${commit.slice(0, 12)} of ${checkout}: ${error.message}` });
  }
  const [exe, ...pre] = python;
  const run = (files) => {
    const out = execProgram(exe, [...pre, "-I", "-B", "-c", DRIVER, exported.tree, ...files.flatMap(([d, f]) => [d, f])], {
      cwd: HERE,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  };
  const probe = [
    "import platform, zlib",
    "try:\n    import PIL\n    pil = PIL.__version__\nexcept ImportError:\n    pil = None",
    "print(platform.python_version(), zlib.ZLIB_RUNTIME_VERSION, pil or '-')",
  ].join("\n");
  const [pythonVersion, zlibVersion, pil] = execProgram(exe, [...pre, "-I", "-c", probe], { cwd: HERE, encoding: "utf8" }).trim().split(" ");
  const pillow = pil !== "-";
  const versions =
    `catalog checker: commit ${commit.slice(0, 12)}, Python ${pythonVersion} (zlib ${zlibVersion}), ` +
    `Pillow ${pillow ? pil : "not installed"} (the catalog pins Pillow 11.3.0)`;
  catalogSetup = { run, pillow, versions, commit, cleanup: exported.cleanup };
  return catalogSetup;
}
