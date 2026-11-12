// busy-emulator catalog-texts [get|set] [<folder>] [--name <name>] [--category <id>] [--short-description <text>]
// [--description <text>] [--changelog <text>]: the app's name (its manifest's, which the BUSY Bar and the catalog show) and
// the four texts the BUSY Apps Catalog asks of the app's author, kept in
// catalog.json of the project (../../readiness/texts.mjs holds the rules, the same the catalog's checks apply).
// `get` (the default) reads them and says what the catalog would refuse in each; `set` writes the ones given, keeps
// the others and every other field of catalog.json, and answers the same. A text the catalog would refuse is
// written all the same, so that work is not lost; `taken` says whether the catalog takes all four. Nothing is sent
// anywhere.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { writable } from "../../publish/files.mjs";
import { CliError } from "../output.mjs";
import { projectAt } from "../project.mjs";
import { SANDBOX_CODES } from "../system.mjs";

const USAGE = "catalog-texts [get|set] [<folder>] [--name <name>] [--category <id>] [--short-description <text>] [--description <text>] [--changelog <text>]";
const OPTION_FIELDS = { category: "category", shortDescription: "short_description", description: "description", changelog: "changelog" };
const MAX_TEXT = 8000;

/** catalog.json of the project as an object, or a failure that says why it is not one. */
export function readDetails(file) {
  if (!existsSync(file)) return {};
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CliError("details_unreadable", `${file} is not JSON: ${e.message}.`, "Fix the file, or move it away and set the texts again.", { file });
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new CliError("details_unreadable", `${file} is not a JSON object.`, "Fix the file, or move it away and set the texts again.", { file });
  return json;
}

/** The app's name in its manifest, and what the catalog would say of it (null when it takes it). */
async function nameOf(dir) {
  const { sourceManifest } = await import("../../readiness/facts.mjs");
  const { nameProblem } = await import("../../readiness/rules.mjs");
  const manifest = sourceManifest(dir);
  const name = typeof manifest.json?.name === "string" ? manifest.json.name : "";
  const problem = nameProblem(name);
  return { name, name_problem: problem ? `The name: ${problem}.` : null, manifest: manifest.file };
}

/** The texts of the project and what the catalog would say of each. */
export async function textsAnswer(dir) {
  const { DETAILS_FILE } = await import("../../readiness/facts.mjs");
  const { textProblems, textRules, textsOf } = await import("../../readiness/texts.mjs");
  const file = path.join(dir, DETAILS_FILE);
  const texts = textsOf(readDetails(file));
  const { ok, problems, warnings } = textProblems(texts);
  const { name, name_problem } = await nameOf(dir);
  // `taken`, not `ok`: the answer's own ok says that the command worked.
  return { file, exists: existsSync(file), name, name_problem, texts, taken: ok, problems, warnings, rules: textRules() };
}

/** Writes the app's name into its manifest, keeping every other field; a name the catalog would refuse is refused. */
async function writeName(dir, name) {
  const { nameProblem } = await import("../../readiness/rules.mjs");
  const problem = nameProblem(name);
  if (problem) throw new CliError("bad_name", `The name is not taken: ${problem}.`, "Give another with --name.");
  const { manifest } = await nameOf(dir);
  if (!manifest) throw new CliError("no_manifest", "The project has no src/appmeta/manifest.json to write the name into.", "Create the project with busy-emulator create.");
  const json = readDetails(manifest);
  json.name = name;
  try {
    writeFileSync(writable(dir, path.relative(dir, manifest).split(path.sep).join("/")), `${JSON.stringify(json, null, 2)}\n`);
  } catch (e) {
    if (e?.code === "outside_project") throw new CliError("outside_project", `${e.message}.`, "Put a file of the project's own in place of the link.", { file: manifest });
    if (SANDBOX_CODES.has(e?.code)) throw new CliError("blocked_file", `This process may not write ${manifest} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.", { file: manifest });
    throw new CliError("write_failed", `Could not write ${manifest}: ${e?.code ?? e?.message ?? e}.`, "Check that the project's folder can be written to.", { file: manifest });
  }
}

export default {
  name: "catalog-texts",
  summary: "Read or write the catalog's four texts of the app (category, short description, description, changelog) and check them by the catalog's rules",
  usage: USAGE,
  maxArguments: 2,
  options: {
    "--name": { key: "name", value: "<name>" },
    "--category": { key: "category", value: "<id>" },
    "--short-description": { key: "shortDescription", value: "<text>" },
    "--description": { key: "description", value: "<text>" },
    "--changelog": { key: "changelog", value: "<text>" },
  },
  async run(ctx, sys, { args, options }) {
    const action = args[0] === "get" || args[0] === "set" ? args[0] : "get";
    const folder = args[0] === "get" || args[0] === "set" ? args[1] : args[0];
    if (args.length === 2 && !(args[0] === "get" || args[0] === "set")) throw new CliError("usage", `catalog-texts takes get or set, then a folder, not ${JSON.stringify(args[0])}.`, `Usage: busy-emulator ${USAGE}`);
    const given = Object.entries(OPTION_FIELDS).filter(([option]) => options[option] !== undefined);
    const named = typeof options.name === "string" ? options.name : null;
    if (action === "get" && named !== null) throw new CliError("usage", "The name is given to catalog-texts set, not get.", `Usage: busy-emulator ${USAGE}`);
    if (action === "get" && given.length) throw new CliError("usage", "The texts are given to catalog-texts set, not get.", `Usage: busy-emulator ${USAGE}`);
    if (action === "set" && !given.length && named === null) throw new CliError("usage", "catalog-texts set needs at least one text: --name, --category, --short-description, --description or --changelog.", `Usage: busy-emulator ${USAGE}`);
    for (const [option] of given) if (typeof options[option] !== "string" || options[option].length > MAX_TEXT) throw new CliError("usage", `--${option.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} takes a text of up to ${MAX_TEXT} characters.`, `Usage: busy-emulator ${USAGE}`);
    const project = projectAt(ctx, sys, folder);
    if (action === "set" && named !== null) await writeName(project.dir, named);
    if (action === "set" && given.length) {
      const { DETAILS_FILE } = await import("../../readiness/facts.mjs");
      const file = path.join(project.dir, DETAILS_FILE);
      const details = readDetails(file);
      // A new file starts with the four fields in the catalog's order.
      const next = { category: "", short_description: "", description: "", changelog: "", ...details };
      for (const [option, field] of given) next[field] = options[option].replace(/\r\n?/g, "\n");
      try {
        writeFileSync(writable(project.dir, DETAILS_FILE), `${JSON.stringify(next, null, 2)}\n`);
      } catch (e) {
        if (e?.code === "outside_project") throw new CliError("outside_project", `${e.message}.`, "Put a file of the project's own in place of the link.", { file });
        if (SANDBOX_CODES.has(e?.code)) throw new CliError("blocked_file", `This process may not write ${file} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.", { file });
        throw new CliError("write_failed", `Could not write ${file}: ${e?.code ?? e?.message ?? e}.`, "Check that the project's folder can be written to.", { file });
      }
      const { noteStep } = await import("../../publish/files.mjs");
      try {
        noteStep(project.dir, "texts", { fields: given.map(([, field]) => field) }, sys.now());
      } catch {
        // The record is the flow's convenience; the texts are written.
      }
    }
    const answer = await textsAnswer(project.dir);
    const lines = [`${action === "set" ? "Wrote" : "The texts in"} ${answer.file}:`, `  name: ${answer.name || "(none)"}${answer.name_problem ? ` (${answer.name_problem})` : ""}`];
    for (const [field, problem] of Object.entries(answer.problems)) lines.push(`  ${field}: ${problem ?? "taken"}${answer.warnings[field] ? ` (${answer.warnings[field]})` : ""}`);
    // The categories to choose from, when none is chosen yet or the one written is not the catalog's.
    if (answer.problems.category) lines.push(`  categories (--category <id>): ${answer.rules.categories.map((one) => `${one.id} (${one.name}: ${one.about})`).join("; ")}`);
    lines.push(answer.taken ? "The catalog takes all four." : "Change what is named above, then set it again.");
    return { data: { folder: project.dir, ...answer }, text: lines.join("\n") };
  },
};
