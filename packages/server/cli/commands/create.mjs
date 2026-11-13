// busy-emulator create <folder>: a new app project from the official template (@busy-app/create-app), with its
// dependencies installed, on the Node inside the app (EMU-206, EMU-217). The generator runs without questions: what
// is not given as an option takes its default. The author, and so the app's id (app.<author>.<app>), is the GitHub
// login when one is signed in (the desktop app's, else GitHub CLI's: ../../projects/author.mjs); else git's user.name,
// as the generator takes it; where git has none either, the name of the account, and the answer says so and how to
// change it (an agent's shell and a new computer often have no git identity). A name many computers share ("User",
// "admin": GENERIC_AUTHORS) is never taken: two people would get the same ids in the catalog (the release dry run,
// 12.11), so create then asks for --author and makes nothing. It is told not to install
// (on Windows its own install fails, `spawn npm ENOENT`); the dependencies are installed here with the bundled npm,
// without install scripts. The project is then trusted: the emulator made it (ADR-0012 §4).
//
// The generator itself is installed into the data folder (tools/create-app) from the npm registry, in the range
// GENERATOR names: its fixes come in, a release that changes its options does not. The registry is named on npm's
// command line, where nothing of the environment overrides it (generatorRegistry): the one in the person's own
// ~/.npmrc, else npm's public one. NPM_CONFIG_REGISTRY, which a project's `npm run` may have set, does not swap the
// generator the project then gets trusted with (audit, 11.11); the proxy and certificates of the person stay.
//
// create <folder> --example <name> starts the project from one of the emulator's example apps instead of the
// template's "Hello": the generator runs as always, then the example's files replace the template's (../examples.mjs).
// create --examples lists them.
//
// The icons: --icon <picture.png> makes both from a PNG of any size, --back-icon <picture.png> the back one alone, by
// the icon command's conversion and checked by the same rules as the window's icon block (capture/icon-rules.mjs); a
// picture that breaks a rule the conversion mends is converted, and the answer says what was changed; one it cannot
// mend (not a PNG, nothing to show) is refused before anything is made. Without them, a project with no icons of its
// own (the template has none; an example has its own) gets the default icon, BUSY's "apps" symbol.
//
// The generator's own options (@busy-app/create-app 0.5.0): --author, --id, --name, --description and --api-version
// go to it as they are; --no-git too (no `git init`, for a project inside a repository of its own). --no-install is
// always given, as said above; --dir is the folder argument. Without git on the computer (often so on Windows) the
// generator makes the project all the same, without a repository and with no author from git: the answer says
// `git: false` and that no repository was made.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { npmVersion } from "../../projects/node-tools.mjs";
import { settleIdentity, takenIds } from "../../projects/app-identity.mjs";
import { isGenericAuthor } from "../../projects/author.mjs";
import { fixTemplate } from "../../projects/template-fixes.mjs";
import { trustProject } from "../../projects/trust.mjs";
import { applyExample, listExamples } from "../examples.mjs";
import { SANDBOX_CODES } from "../system.mjs";
import { CliError } from "../output.mjs";
import { again, appId, commandFor, fixBusyCli, installDependencies, NETWORK_CODES, remember, runNpm, runTool, shellWord, toolFailed } from "../project.mjs";

export const GENERATOR = Object.freeze({ name: "@busy-app/create-app", range: "^0.5.0" });
/** npm's own registry, where @busy-app publishes. */
export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";

/**
 * The registry the generator comes from: `registry=` of the person's ~/.npmrc (a company's mirror), else npm's public
 * one. Never one from the environment. A value with `${…}` (npm would put a variable in) is not taken.
 */
export function generatorRegistry(home = os.homedir()) {
  let text = "";
  try {
    text = readFileSync(path.join(home, ".npmrc"), "utf8");
  } catch {
    // none: npm's public registry
  }
  const named = [...text.matchAll(/^[ \t]*registry[ \t]*=[ \t]*(\S+?)[ \t]*$/gm)].at(-1)?.[1]?.replace(/^"(.*)"$/, "$1");
  return named && /^https?:\/\/[^\s${}"]+$/.test(named) ? named : PUBLIC_REGISTRY;
}

const USAGE = "create <folder> [--example <name>] [--icon <picture.png>] [--back-icon <picture.png>] [--author <name>] [--id <app id>] [--name <name>] [--description <text>] [--api-version <x.y.z>] [--no-git]";

/** The options passed on to the generator as they are; it checks them (an id, the API version). */
const PASSED = Object.freeze({ author: "--author", id: "--id", name: "--name", description: "--description", apiVersion: "--api-version" });

/**
 * The generator puts --author, --name and --description into package.json and the manifest as they are, without JSON
 * escaping (create-app 0.5.0, fill(); busy-tools issue 11): a quote breaks the file, or adds keys to it. Such a value is
 * refused before anything runs (EMU-206 security review, M5).
 */
const TEXT_OPTIONS = Object.freeze({ author: "--author", name: "--name", description: "--description" });
const UNSAFE = /["\\\u0000-\u001f\u007f]/;

/**
 * The account's name as an author, when it can be written into package.json as it is and is not one many computers
 * share; otherwise { refused } with what the name was (null when there was none to take).
 */
export function defaultAuthor(sys) {
  const name = (sys.userName?.() ?? "").trim();
  if (!name || UNSAFE.test(name)) return { refused: null };
  return isGenericAuthor(name) ? { refused: name } : { name, from: "account" };
}

/** create's refusal when no author can be taken: what was found and why it is not used, and --author. */
function authorRequired(ctx, folder, why) {
  return new CliError(
    "author_required",
    `No author for the app: ${why}. The app's id is made from the author (app.<author>.<app>), and a name many computers share would give other people's apps the same id in the catalog. Nothing was created.`,
    `Give your GitHub login or your own name: ${again(ctx, `create ${shellWord(ctx, folder)} --author "your-login"`)}. Or sign in to GitHub (gh auth login, or Publish in the emulator's window): create then takes the login.`,
    { option: "--author" },
  );
}

/** The author the generator wrote into the project's package.json. */
function authorIn(dir) {
  try {
    const author = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).author;
    return typeof author === "string" && author ? author : null;
  } catch {
    return null;
  }
}

/**
 * Missing, or a folder with nothing but .DS_Store in it (so `create .` works in an empty folder). A folder with
 * anything else in it is refused with what is in the way: an agent's own folder has its AGENTS.md or .claude in it,
 * and "is not empty" alone sent it looking (the field test). Unlike the generator's own check, .git counts: the
 * project create makes is trusted, and a .git that was there before holds settings of someone else's (core.fsmonitor,
 * hooks) that git runs as programs in that folder (audit, 11.11). git init comes after create.
 */
function checkTarget(dir) {
  if (!existsSync(dir)) return null;
  if (!statSync(dir).isDirectory()) return { problem: `${dir} exists and is not a folder`, holds: [] };
  const entries = readdirSync(dir).filter((name) => name !== ".DS_Store").sort();
  if (!entries.length) return null;
  const shown = entries.slice(0, 4).join(", ") + (entries.length > 4 ? ` and ${entries.length - 4} more` : "");
  const git = entries.includes(".git") ? "; a git repository that is there already is not made part of a trusted project, so run git init after create" : "";
  return { problem: `${dir} is not empty (it holds ${shown}${git})`, holds: entries };
}

/**
 * The git repository the project would sit inside: the nearest folder above it, up to the home folder or the root,
 * that holds .git; else null. Not refused (an app in a monorepo is ordinary), but said: that repository's hooks and
 * core.fsmonitor run whenever git works in the project (review of pull request 120).
 */
export function repositoryAbove(dir, home = os.homedir()) {
  const stop = home ? path.resolve(home) : null;
  for (let at = path.dirname(path.resolve(dir)); ; at = path.dirname(at)) {
    if (existsSync(path.join(at, ".git"))) return at;
    if (at === stop || path.dirname(at) === at) return null;
  }
}

/** A folder name to offer when the one given cannot be used: from --name or --id, else "my-app". */
function folderNameFor(options) {
  const from = options.id?.split(".").pop() ?? options.name ?? "";
  const name = from.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return name || "my-app";
}

/** The generator's package.json as npm installed it in the data folder, or null. */
function readGenerator(packageDir) {
  try {
    return JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/** The app's name from its manifest. */
function appName(dir) {
  try {
    const name = JSON.parse(readFileSync(path.join(dir, "src", "appmeta", "manifest.json"), "utf8")).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** How the id and the name were chosen, for --json: null when the project has no manifest to say it of. */
function namingData(naming) {
  if (!naming) return null;
  return { from: naming.folder, latin: naming.latin, latin_from: naming.latinFrom, mark: naming.mark, taken: naming.passed.map(({ id, by, folder }) => ({ id, by, ...(folder ? { folder } : {}) })), generator: naming.generator, rewritten: naming.rewritten };
}

/** The lines that say an id or a name other than the folder's own: put into Latin letters, or the next free id. */
function namingText(naming, { id, name }) {
  if (!naming) return [];
  const lines = [];
  const change = 'To change them: "id" and "name" in src/appmeta/manifest.json.';
  const quoted = (texts) => texts.map((text) => JSON.stringify(text)).join(" and ");
  if (naming.mark) lines.push(`${quoted([naming.folder])} has no letter or digit for an app's id, so the id is ${id} and the name "${name}". ${change}`);
  else if (naming.latin) lines.push(`Id ${id} and name "${name}": put into Latin letters from ${quoted(naming.latinFrom)}, since the BUSY Bar and the catalog take Latin letters only. ${change}`);
  if (naming.passed.length) {
    const first = naming.passed[0];
    const by = first.by === "bar" ? "an app on the emulated BUSY Bar" : `the project in ${first.folder}`;
    lines.push(`${first.id} is taken by ${by}${naming.passed.length > 1 ? ` (and ${naming.passed.slice(1).map((one) => one.id).join(", ")} too)` : ""}, so this app's id is ${id}.${naming.latin || naming.mark ? "" : ` ${change}`}`);
  }
  return lines;
}

/** The largest picture `--pictures` gives as a data: address: an icon and a frame of the front display are far smaller. */
const MAX_SHOWN_PICTURE = 64 * 1024;

/** A PNG of an example as a data: address, or null when it is not there (or is no small PNG). */
function pictureOf(file) {
  try {
    const bytes = readFileSync(file);
    return bytes.length <= MAX_SHOWN_PICTURE && bytes.subarray(1, 4).toString("latin1") === "PNG" ? `data:image/png;base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/**
 * create --examples: the examples, a line each. With --pictures (the window's Create app) each has its icon and a
 * frame of its front display (docs/front.png, 72×16) as data: addresses, or null.
 */
function examplesAnswer(ctx, { pictures = false } = {}) {
  const examples = listExamples().map(({ name, title, description, dir }) => ({ name, title, description, ...(pictures ? { icon: pictureOf(path.join(dir, "src", "appmeta", "icon_front_8x8.png")), front: pictureOf(path.join(dir, "docs", "front.png")) } : {}) }));
  const width = Math.max(0, ...examples.map((example) => example.name.length));
  const lines = examples.map((example) => `  ${example.name.padEnd(width)}  ${example.title}. ${example.description}`);
  return {
    data: { examples },
    text: examples.length ? [`Example apps, each a finished project to start from (${again(ctx, "create <folder> --example <name>")}):`, ...lines].join("\n") : "This copy of the emulator has no example apps.",
  };
}

/**
 * --icon and --back-icon: each picture read, checked by the icon's rules and converted when it breaks one the
 * conversion mends. Throws a CliError before anything is made when a picture cannot be used.
 * @returns {Promise<{ front: Buffer|null, back: Buffer|null, notes: string[], given: object }>}
 */
export async function iconsGiven(ctx, sys, options) {
  if (options.icon === undefined && options.backIcon === undefined) return null;
  const { decodePng, encodePng, checkPicture, MAX_PICTURE_BYTES } = await import("../../capture/icon.mjs");
  const { frontPixels, backPixels, REQUIREMENTS } = await import("../../capture/icon-rules.mjs");
  const out = { front: null, back: null, notes: [], given: {} };
  for (const [side, key, flag] of [["front", "icon", "--icon"], ["back", "backIcon", "--back-icon"]]) {
    if (options[key] === undefined) continue;
    const file = path.resolve(sys.cwd(), options[key]);
    let bytes;
    try {
      if (statSync(file).size > MAX_PICTURE_BYTES) throw new CliError("picture_unreadable", `${file} is larger than ${MAX_PICTURE_BYTES / 1024 / 1024} MiB: it cannot be made into an icon.`, `Give a PNG of the icon's size, ${side === "front" ? "8×8" : "11×11"} pixels.`, { option: flag, file });
      bytes = readFileSync(file);
    } catch (e) {
      if (e instanceof CliError) throw e;
      if (SANDBOX_CODES.has(e?.code)) throw new CliError("blocked_file", `This process may not read ${file} (${e.code}): a sandbox is in the way.`, "Run the same busy-emulator command again outside the sandbox.", { option: flag, file });
      throw new CliError("picture_unreadable", `${file} cannot be read (${e?.code ?? e?.message ?? e}).`, "Name a PNG file that is there.", { option: flag, file });
    }
    const verdict = checkPicture(bytes, side);
    const failed = REQUIREMENTS[side].filter(({ id }) => !verdict.results[id].ok).map(({ id }) => verdict.results[id]);
    if (!verdict.ok && !verdict.fix) {
      throw new CliError("picture_unreadable", `${file} cannot be the ${side} icon: ${failed.map((r) => r.problem).join(" ")}`, `${failed.map((r) => r.next).join(" ")} Nothing was created.`, { option: flag, file });
    }
    const picture = decodePng(bytes);
    out.given[side] = { file, width: picture.width, height: picture.height, converted: !verdict.ok };
    if (!verdict.ok) out.notes.push(`The ${side} icon from ${file}: ${failed.map((r) => r.problem.replace(/\.$/, "")).join("; ")}; converted (${verdict.fix.label.toLowerCase()}).`);
    if (side === "front") {
      out.front = encodePng({ width: 8, height: 8, channels: 4, data: frontPixels(picture) });
      if (options.backIcon === undefined) out.back = encodePng({ width: 11, height: 11, channels: 2, data: backPixels(picture) });
    } else out.back = encodePng({ width: 11, height: 11, channels: 2, data: backPixels(picture) });
  }
  return out;
}

/**
 * The project's icons: the ones given, else, where the project has none of its own, the default icon. Returns how
 * each one came: "given", "default", "own" (an example's, kept), or "from-front".
 */
async function writeProjectIcons(dir, given) {
  const { defaultIcons } = await import("../../capture/icon.mjs");
  const folder = path.join(dir, "src", "appmeta");
  const files = { front: path.join(folder, "icon_front_8x8.png"), back: path.join(folder, "icon_back_11x11.png") };
  const fallback = defaultIcons();
  const how = {};
  for (const side of ["front", "back"]) {
    if (given?.[side]) {
      writeFileSync(files[side], given[side]);
      how[side] = side === "back" && !given.given.back ? "from-front" : "given";
    } else if (existsSync(files[side])) how[side] = "own";
    else {
      // A back without a front of its own: the default's; a front given without a back: made from it (above).
      writeFileSync(files[side], fallback[side]);
      how[side] = "default";
    }
  }
  return { files, how };
}

export default {
  name: "create",
  summary: "Create an app project from the official template, or from an example app (create --examples lists them), with its dependencies installed",
  usage: USAGE,
  maxArguments: 1,
  options: {
    "--author": { key: "author", value: "<name>" },
    "--id": { key: "id", value: "<app id>" },
    "--name": { key: "name", value: "<name>" },
    "--description": { key: "description", value: "<text>" },
    "--api-version": { key: "apiVersion", value: "<x.y.z>" },
    "--no-git": { key: "noGit" },
    "--example": { key: "example", value: "<name>" },
    "--examples": { key: "examples" },
    "--pictures": { key: "pictures" },
    "--icon": { key: "icon", value: "<picture.png>" },
    "--back-icon": { key: "backIcon", value: "<picture.png>" },
  },
  async run(ctx, sys, { args, options, progress }) {
    if (options.examples) return examplesAnswer(ctx, { pictures: options.pictures === true });
    if (!args.length || !args[0]) throw new CliError("usage", "create needs the folder to create the project in.", `Usage: ${again(ctx, "create <folder>")}; ${again(ctx, "create --examples")} lists the example apps to start from.`);
    let example = null;
    if (options.example !== undefined) {
      const examples = listExamples();
      example = examples.find((one) => one.name === options.example) ?? null;
      if (!example) {
        const names = examples.map((one) => one.name).join(", ");
        throw new CliError("usage", `There is no example app ${JSON.stringify(options.example)}${names ? `: the examples are ${names}` : ": this copy of the emulator has none"}.`, `${again(ctx, "create --examples")} says what each one is.`, { option: "--example" });
      }
    }
    for (const [key, flag] of Object.entries(TEXT_OPTIONS)) {
      if (options[key] !== undefined && UNSAFE.test(options[key])) {
        throw new CliError("usage", `${flag} may not hold a double quote, a backslash or a control character: the template's generator writes it into package.json as it is.`, `Give ${flag} without them, as in ${flag} "Shows the focus time".`, { option: flag });
      }
    }
    // An id the catalog would refuse (the field test, 12.11: --id pomodoro, and the checks said so only at publish).
    if (options.id !== undefined) {
      const { idProblem, ID_RULE } = await import("../../readiness/rules.mjs");
      const problem = idProblem(options.id);
      if (problem) throw new CliError("usage", `--id ${JSON.stringify(options.id)} is not an id the app catalog takes: ${problem}.`, `An id is ${ID_RULE}. Or leave --id out: one is made from the author and the folder.`, { option: "--id" });
    }
    // The icons given, read and checked before anything is made.
    const givenIcons = await iconsGiven(ctx, sys, options);
    const target = path.resolve(sys.cwd(), args[0]);
    const taken = checkTarget(target);
    if (taken) {
      // A name that is not taken, to give instead: inside the caller's own folder when that was named, else beside
      // the folder that was.
      const here = target === path.resolve(sys.cwd());
      const base = here ? folderNameFor(options) : path.basename(target);
      const parent = here ? target : path.dirname(target);
      let name = here ? base : `${base}-2`;
      for (let n = here ? 2 : 3; existsSync(path.join(parent, name)) && n < 100; n++) name = `${base}-${n}`;
      const suggestion = here ? name : path.join(path.dirname(args[0]), name);
      throw new CliError(
        "folder_not_empty",
        `${taken.problem}: create makes the project's folder itself and needs a name that is not taken, or an empty folder.`,
        `Give a folder name that is not taken; create makes the folder: ${again(ctx, `create ${shellWord(ctx, suggestion)}`)}.`,
        { folder: target, holds: taken.holds.slice(0, 20), suggestion },
      );
    }

    // The generator, from the registry into the data folder. Without the network the one already there is used
    // (create-offline): a create made before put it there; otherwise npm's cache may hold it.
    const generatorDir = path.join(ctx.dataDir, "tools", "create-app");
    mkdirSync(generatorDir, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(generatorDir, "package.json"), `${JSON.stringify({ private: true, description: "The app template's generator, for busy-emulator create", dependencies: { [GENERATOR.name]: GENERATOR.range } }, null, 2)}\n`);
    const packageDir = path.join(generatorDir, "node_modules", ...GENERATOR.name.split("/"));
    // The registry on npm's command line, where the environment does not override it (generatorRegistry).
    const registry = generatorRegistry();
    // --strict-ssl=true: the certificate is checked whatever an .npmrc says; a company's CA file still counts.
    const generatorArgs = ["install", `--registry=${registry}`, `--@busy-app:registry=${registry}`, "--strict-ssl=true", "--ignore-scripts", "--no-workspaces", "--no-package-lock", "--no-audit", "--no-fund"];
    progress(`Getting the app template (${GENERATOR.name}@${GENERATOR.range}) from the npm registry…`);
    const got = await runNpm(ctx, sys, { args: generatorArgs, cwd: generatorDir, progress, what: "Getting the app template" });
    // The network's failure, when the template came without it: the dependencies then go to npm's cache at once.
    let networkDown = null;
    if (got.code !== 0 || got.stopped) {
      const error = toolFailed(ctx, `npm install ${GENERATOR.name}`, got, `Fix what npm says, then run ${again(ctx, "create")} again.`);
      if (!NETWORK_CODES.has(error.code)) throw error;
      if (readGenerator(packageDir)) {
        progress(`${error.code === "network_stalled" ? "The npm registry does not answer" : "The npm registry cannot be reached"}: using the app template already here (${GENERATOR.name} ${readGenerator(packageDir).version ?? ""}).`.replace(" ).", ")."));
      } else {
        progress("The npm registry cannot be reached: trying npm's cache for the app template…");
        const cached = await runNpm(ctx, sys, { args: [...generatorArgs, "--offline"], cwd: generatorDir, progress, what: "Getting the app template from npm's cache" });
        if (cached.code !== 0 || !readGenerator(packageDir)) throw error;
      }
      networkDown = error;
    }
    const generator = readGenerator(packageDir);
    if (!generator) throw new CliError("tool_failed", `npm installed ${GENERATOR.name}, but ${packageDir} has no package.json.`, `Run ${again(ctx, "create")} again.`);
    const bin = typeof generator.bin === "string" ? generator.bin : generator.bin?.["create-app"];

    // The project. The generator runs in its own folder, so that nothing of the caller's folder is taken for a
    // program it starts (git); the project's folder goes to it as a full path.
    // As --flag=<value>: a value that starts with "-" stays a value (audit, 11.11).
    const passed = Object.entries(PASSED).flatMap(([key, flag]) => (options[key] === undefined ? [] : [`${flag}=${options[key]}`]));
    progress(`Creating the project in ${target}…`);
    const generate = (more = []) => runTool(ctx, sys, { tool: "node", args: [path.join(packageDir, bin), target, "--no-install", ...(options.noGit ? ["--no-git"] : []), ...passed, ...more], cwd: generatorDir });
    // Where the author came from: "option" (--author), "github" (the signed-in GitHub login), "git" (user.name, read
    // by the generator) or "account" (the name of the account this runs under).
    let author = options.author !== undefined ? { name: options.author, from: "option" } : null;
    if (!author) {
      const login = sys.githubLogin?.(ctx.dataDir, ctx.env ?? {}) ?? null;
      if (login) author = { name: login, from: "github" };
    }
    // git's user.name, which the generator would take: not one many computers share.
    const gitName = author ? null : (sys.gitUserName?.(ctx.env ?? {}) ?? null);
    if (gitName && isGenericAuthor(gitName)) throw authorRequired(ctx, args[0], `GitHub is not signed in, and git's user.name is "${gitName}"`);
    let made = await generate(author?.from === "github" ? [`--author=${author.name}`] : []);
    if (made.code !== 0 && !author && /an author is required/.test(made.output)) {
      // No --author and no user.name in git. The generator refuses before it writes anything, so it runs again.
      const account = defaultAuthor(sys);
      if (account.refused !== undefined) throw authorRequired(ctx, args[0], account.refused ? `GitHub is not signed in, git has no user.name, and the account's name is "${account.refused}"` : "GitHub is not signed in, git has no user.name, and the account's name cannot be used");
      author = account;
      made = await generate([`--author=${author.name}`]);
    }
    if (made.code !== 0) {
      const required = /an author is required/.test(made.output);
      throw toolFailed(ctx, GENERATOR.name, made, required ? `Name the author: ${again(ctx, `create ${shellWord(ctx, args[0])} --author "Your Name"`)}.` : `Fix what it says and run ${again(ctx, "create")} again.`);
    }
    if (!existsSync(path.join(target, "package.json"))) throw new CliError("tool_failed", `${GENERATOR.name} ended, but ${target} has no package.json.`, "Report this with the generator's version.", { output: made.output });
    const dir = realpathSync.native(target);
    // The id and the name in Latin letters, and an id no other project or app has (projects/app-identity.mjs): the
    // generator gives every folder whose name has a letter outside Latin the same id (busy-tools issue 13).
    let naming = null;
    try {
      naming = settleIdentity(dir, { folderName: path.basename(dir), given: options, taken: takenIds(ctx.dataDir, dir) });
    } catch {
      // The project stays as the generator made it.
    }
    // The example's app in place of the template's, under the id, name and author the project has now.
    if (example) applyExample(example, dir, { name: options.name === undefined ? undefined : (naming?.name ?? options.name), description: options.description, apiVersion: options.apiVersion });
    let icons = null;
    try {
      icons = await writeProjectIcons(dir, givenIcons);
    } catch {
      // The project stays without them; the icon command makes them.
    }
    trustProject(ctx.dataDir, dir, "created", { platform: ctx.platform });
    remember(ctx, { dir });
    // What the template gets wrong for an author without a bar: its settings helper, its AGENTS.md (template-fixes.mjs).
    const template = fixTemplate(dir);

    // Its dependencies, with the bundled npm. When they do not come (no network), the project is there all the same,
    // trusted and in the list: build installs them, and so does the window's Retry (create-offline).
    const build = commandFor(ctx, { given: args[0] }, "build");
    const created = `The project is created in ${dir}, without its dependencies`;
    const dependencies = await installDependencies(ctx, sys, dir, {
      progress,
      networkDown,
      // create again would be refused (the folder is no longer empty), so every answer here names the folder and
      // build (R2).
      hint: `${created}: fix what npm says, then run ${build}; it installs them.`,
      networkHint: (kind) => (kind === "blocked" ? `${created}: run ${build} outside the sandbox; it installs them.` : `${created}: check the connection (a registry or proxy of your own goes into your .npmrc), then run ${build}; it installs them.`),
      extra: { folder: dir, created: true, id: appId(dir), name: appName(dir) },
    });
    const fix = fixBusyCli(ctx, { dir });

    const id = appId(dir);
    author ??= { name: authorIn(dir), from: "git" };
    // An author nobody chose is said, with where it is written: the app's id was made from it too, unless --id was given.
    const chosen = author.from === "option" || author.from === "git" || author.from === "github";
    const change = `"author" in package.json and in src/appmeta/manifest.json${options.id === undefined ? `; the app's id (${id ?? "\"id\" in the manifest"}) was made from it too` : ""}. For a new project: --author "Your Name"`;
    const authorLine = chosen
      ? null
      : `Author: ${author.name} (the name of your account: no --author was given, GitHub is not signed in and git has no user.name). To change it: ${change}.`;
    // The GitHub login is said once: the id was made from it.
    const loginLine = author.from === "github" && options.id === undefined ? `Author: ${author.name}, the GitHub login signed in on this computer; the app's id (${id ?? "\"id\" in the manifest"}) was made from it.` : null;
    const name = appName(dir);
    const namingLines = namingText(naming, { id, name });
    const repository = repositoryAbove(dir);
    const repositoryLines = repository ? [`The project is inside the git repository at ${repository}: its hooks and settings (core.fsmonitor among them) run whenever git works in the project. Make sure that repository is yours.`] : [];
    const relative = path.relative(sys.cwd(), dir) || ".";
    // The first step of the loop that public-docs/agents.md and the project's AGENTS.md give: dev --once (EMU-314).
    const next = [commandFor(ctx, { given: relative }, "dev", " --once")];
    // A git repository of its own: the generator's `git init`, unless --no-git, or git is not on this computer.
    const git = existsSync(path.join(dir, ".git"));
    const gitLine = git ? null : options.noGit ? "No git repository was made (--no-git)." : "No git repository was made: git is not installed on this computer, or git init failed. The project works without one; publishing needs none.";
    return {
      data: { folder: dir, id, name, naming: namingData(naming), example: example?.name ?? null, author: { ...author, change: chosen ? null : change }, icons: icons ? { front: icons.how.front, back: icons.how.back, given: givenIcons?.given ?? null } : null, trusted: "created", generator: { name: GENERATOR.name, version: generator.version ?? null }, npm: npmVersion(ctx.nodeTools), fix, template, dependencies, inside_repository: repository, git, next },
      text: [`Created ${id ?? "the app"}${id && name ? ` ("${name}")` : ""} in ${dir} from ${example ? `the example ${example.name} (on ${GENERATOR.name} ${generator.version ?? ""}`.trimEnd() + ")" : `${GENERATOR.name} ${generator.version ?? ""}`.trimEnd()}, with its dependencies installed${dependencies === "cache" ? " from npm's cache (the npm registry was not reached)" : ""}.`, ...(example ? ["Its README.md says what it shows, what its settings do and how it is made."] : []), ...namingLines, ...(givenIcons?.notes ?? []), ...(icons && icons.how.front === "default" ? [`Icons: the default one (BUSY's apps symbol). Your own: ${commandFor(ctx, { given: args[0] }, "icon", " --from <picture.png> --force")}.`] : []), ...repositoryLines, ...(authorLine ? [authorLine] : []), ...(loginLine ? [loginLine] : []), ...(gitLine ? [gitLine] : []), "", "Next:", ...next.map((line) => `  ${line}`), `It builds, installs and starts the app (exit code 0: it runs). Then follow the emulator's section of AGENTS.md, in ${shellWord(ctx, relative)}.`].join("\n"),
    };
  },
};
