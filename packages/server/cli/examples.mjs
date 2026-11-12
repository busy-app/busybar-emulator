// The example apps that come with the emulator (emulator/examples/<name>): what `create --examples` lists and
// `create <folder> --example <name>` starts a project from. An example is a whole project in the official template's
// layout — src/ with the app, its settings and icons, shared/, README.md with its pictures — with its own id, name and
// author in it. `create` first makes the project with the official generator, as always, so the id, the name and the
// author come out as they do for any new project; then the example's files replace the template's, and the project's
// identity is written into them (applyExample).
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the examples lie: beside packages/, in the source tree (emulator/examples), in the public repository
 * (examples) and in the app (<resources>/emulator/examples).
 */
export const EXAMPLES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples");

/** What is never copied out of an example: what a build or an install left there, and what the system leaves behind. */
const LEFT_OUT = new Set(["node_modules", "dist", ".DS_Store", "Thumbs.db"]);

function readJson(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

const manifestOf = (dir) => path.join(dir, "src", "appmeta", "manifest.json");

/**
 * The examples in `dir`, by name: every folder there that holds an app (src/appmeta/manifest.json with a name).
 * @returns {{ name: string, title: string, description: string, dir: string }[]}
 */
export function listExamples(dir = EXAMPLES_DIR) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const examples = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifest = readJson(manifestOf(path.join(dir, entry.name)));
    if (typeof manifest?.name !== "string") continue;
    examples.push({ name: entry.name, title: manifest.name, description: typeof manifest.description === "string" ? manifest.description : "", dir: path.join(dir, entry.name) });
  }
  return examples.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Turns the project the generator just made in `target` into the example: the template's app (src/) goes, the
 * example's files come in over the rest, and the project keeps the identity the generator gave it — its id and
 * author in the manifest, its package name — with the example's name and description unless the caller named others.
 * @param {{ name: string, dir: string }} example
 * @param {string} target  the project's folder
 * @param {{ name?: string, description?: string, apiVersion?: string }} given  what the caller gave to create
 * @returns {{ id: string|null, name: string|null }}
 */
export function applyExample(example, target, given = {}) {
  const madeManifest = readJson(manifestOf(target)) ?? {};
  const madePackage = readJson(path.join(target, "package.json")) ?? {};

  rmSync(path.join(target, "src"), { recursive: true, force: true });
  cpSync(example.dir, target, {
    recursive: true,
    force: true,
    filter: (from) => {
      const base = path.basename(from);
      return !LEFT_OUT.has(base) && !base.startsWith("._");
    },
  });

  const manifest = readJson(manifestOf(target)) ?? {};
  if (madeManifest.id !== undefined) manifest.id = madeManifest.id;
  if (madeManifest.author !== undefined) manifest.author = madeManifest.author;
  if (given.name !== undefined) manifest.name = given.name;
  if (given.description !== undefined) manifest.description = given.description;
  if (given.apiVersion !== undefined && madeManifest.api_version !== undefined) manifest.api_version = madeManifest.api_version;
  writeFileSync(manifestOf(target), `${JSON.stringify(manifest, null, 2)}\n`);

  const pkgFile = path.join(target, "package.json");
  if (existsSync(pkgFile)) {
    const pkg = readJson(pkgFile) ?? {};
    for (const key of ["name", "author"]) if (madePackage[key] !== undefined) pkg[key] = madePackage[key];
    if (typeof manifest.description === "string") pkg.description = manifest.description;
    writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return { id: typeof manifest.id === "string" ? manifest.id : null, name: typeof manifest.name === "string" ? manifest.name : null };
}
