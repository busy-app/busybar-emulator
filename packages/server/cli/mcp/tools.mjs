// The tools of `busy-emulator mcp`: each one is a command of the command line, run through its own `main()` with the
// same parsing, checks, codes and hints (busy-emulator.mjs), never a second implementation. A tool builds the words of
// the command from its arguments, `main()` runs it, and its answer becomes the tool's result: the JSON of `--json` as
// `structuredContent`, the command's text as text, and for `screenshot` the picture itself.
//
// What a tool may touch is less than the command line, never more (ADR-0010, ADR-0012 §4):
//
// - A tool that takes a project folder takes only one the emulator knows: one `create` made, or one the person
//   trusted in the emulator's dialog (projects/trusted.json). Any other folder is refused with `untrusted_project`
//   before the command runs, also for `check`, `submit` and `settings`, which on the command line read any project.
//   `create_app` takes a new or empty folder, which `create` itself checks.
// - No tool trusts a folder or asks the person to: that is `busy-emulator trust <folder>`, which the person runs.
// - No tool reads or writes a file that a tool does not name in its answer (the screenshots, what `create`, `build`
//   and `submit` make), and none runs a program or a shell command it is given.
// - No tool lets an app on the bar reach this computer (ADR-0012 §5). Allowing a port is the person's step, in a
//   terminal: `busy-emulator allow-local <port>`. A tool would hand that to the model, and a model can be steered by
//   whatever it reads: create an app that fetches a URL, allow a port, set the URL and read the answer in the logs is a
//   way to read the person's local services, and to scan their ports. A port the person allowed is reachable by the
//   apps a model runs too: that is the person's decision.
// - settings_get and settings_set hide the values of fields marked `sensitive` in the app's settings schema (a token
//   in a header): the command line's settings command hides them for this server (ctx.mcp). settings_set still sets
//   them.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { commandLine } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";
import { projectAt, requireTrust, shellWord } from "../project.mjs";
import { MCP_SCREENSHOT_KEEP_MS, removeOlderThan } from "../../old-files.mjs";
import { isTrusted, readTrusted } from "../../projects/trust.mjs";

const FOLDER = {
  type: "string",
  description: "The project's folder, an absolute path: the `folder` that create_app answered with, or one that the projects tool lists.",
  minLength: 1,
};
const NONE = { type: "object", properties: {}, additionalProperties: false };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CHANGES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Writes only what is not there yet, and the same at every call: check's empty catalog.json. */
const ADDS_ONCE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const projectTool = (properties = {}, required = []) => ({ type: "object", properties: { folder: FOLDER, ...properties }, required: ["folder", ...required], additionalProperties: false });

/** The codes the person has to act on: the text says so, in this server's terms. */
const TRUST_CODES = new Set(["untrusted_project", "trust_needs_person"]);

const MINUTE = 60_000;

/**
 * The tools, in a fixed order. `words(input, env)` gives the command's words (without --json); it may throw a
 * CliError, which is the tool's answer then. `after(answer, input, env)` may add content (the screenshot's picture).
 * `timeout` (ms, or a function of the input): how long the tool may take before it is stopped, with every program it
 * started, and answered with `tool_timeout`; the ones that build and install have minutes, the rest seconds.
 * `parallel`: a tool that only reads (and screenshot, which writes its own new files) does not wait behind a build
 * in the queue of the others.
 */
export const TOOLS = [
  {
    name: "status",
    timeout: 30_000,
    parallel: true,
    title: "Is the emulator running",
    description: "Whether BUSY Bar Emulator is running and where its emulated BUSY Bar answers. Call it first. `running: false`: call start. Changes nothing.",
    inputSchema: NONE,
    annotations: READ_ONLY,
    words: () => ["status"],
  },
  {
    name: "start",
    timeout: 180_000,
    title: "Start the emulator",
    description:
      "Starts BUSY Bar Emulator with its window and waits (up to a minute) until its BUSY Bar answers; if it is running already, brings its window to the front. Every other tool except status, list_examples, projects and check needs it running; they answer `not_running` otherwise. Errors: `no_app` (the emulator is not installed: the person installs it, see https://github.com/busy-app/busybar-emulator), `start_timeout`, `start_interrupted` (call start again), `port_busy`, `move_app` (the hint says what the person does).",
    inputSchema: NONE,
    annotations: { ...CHANGES, idempotentHint: true },
    words: () => ["start"],
  },
  {
    name: "create_app",
    timeout: 20 * MINUTE,
    title: "Create a BUSY Bar app project",
    description:
      "Creates a new BUSY Bar app project in `folder` from the official template, or from one of the emulator's example apps (`example`, see list_examples), and installs its dependencies with the emulator's own Node and npm (downloads about 60 MB from the npm registry; can take a minute or two). `folder` must be an absolute path that does not exist yet or is empty. The project is trusted: build, run and the rest take it. Answers `folder`, `id`, `author` and `icons`: a project without icons of its own gets the default icon (BUSY's apps symbol), which the icon tool replaces (with `force`). Then edit the code in `src/` (read the project's AGENTS.md, or the resource busy-emulator://guide/project) and call refresh. Errors: `folder_not_empty` (take the `suggestion`), `author_required` (give `author`), `network_failed`, `tool_failed`, `usage`.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", minLength: 1, description: "Absolute path of the new project's folder; it must not exist yet, or be empty." },
        example: { type: "string", minLength: 1, description: "Start from this example app instead of the template (its name from list_examples)." },
        name: { type: "string", minLength: 1, description: "The app's name, as people see it in the APPS menu." },
        description: { type: "string", minLength: 1, description: "One line that says what the app does." },
        author: { type: "string", minLength: 1, description: "The author's name; without it the GitHub login signed in on this computer, git's user.name or the account's name is taken (the answer says which). When create answers author_required (only a name many computers share was found), ask the person for their GitHub login." },
        id: { type: "string", minLength: 1, description: "The app's id, app.<author>.<app>; without it one is made from the author and the folder." },
        no_git: { type: "boolean", description: "No git repository in the new folder (for a project inside a repository of its own). Without git on the computer none is made either; the answer's `git` says." },
      },
      required: ["folder"],
      additionalProperties: false,
    },
    annotations: { ...CHANGES, openWorldHint: true },
    words: (input, env) => [
      "create",
      absolute(input.folder, env, "create_app"),
      ...option("--example", input.example),
      ...option("--name", input.name),
      ...option("--description", input.description),
      ...option("--author", input.author),
      ...option("--id", input.id),
      ...(input.no_git ? ["--no-git"] : []),
    ],
  },
  {
    name: "list_examples",
    timeout: 60_000,
    parallel: true,
    title: "List the example apps",
    description: "The example apps that create_app can start a project from (`example`): `examples`, each with `name`, `title` and `description`. Needs neither the emulator nor the network.",
    inputSchema: NONE,
    annotations: READ_ONLY,
    words: () => ["create", "--examples"],
  },
  {
    name: "projects",
    timeout: 30_000,
    parallel: true,
    title: "List the known projects",
    description:
      "The project folders this emulator knows, which are the only ones the other tools take: those create_app made and those the person trusted. Each has `folder`, `how` (created or trusted), `at` and `present` (false: the folder is gone or was moved, and has to be created again or trusted at its new place). Changes nothing.",
    inputSchema: NONE,
    annotations: READ_ONLY,
    words: null,
    run: (input, env) => ({ ok: true, command: "projects", ...projectsAnswer(env) }),
  },
  {
    name: "build",
    timeout: 15 * MINUTE,
    title: "Build the project",
    description: "Builds the project (busy-cli build; installs its dependencies first when they are missing) into dist/<id>.tgz. Does not install or start it: run or refresh does. Errors: `tool_failed` (the compiler's or bundler's own words in `output`: fix the code and build again), `settings_invalid` (`field` and `problem` name what to change in src/appmeta/settings.json), `untrusted_project`.",
    inputSchema: projectTool({ no_minify: { type: "boolean", description: "busy-cli build --no-minify: readable code in the package, for debugging." }, bundle: { type: "boolean", description: "busy-cli build --bundle: every module in one scripts/main.js." } }),
    annotations: CHANGES,
    words: (input, env) => ["build", known(input.folder, env, "build"), ...(input.no_minify ? ["--no-minify"] : []), ...(input.bundle ? ["--bundle"] : [])],
  },
  {
    name: "typecheck",
    timeout: 15 * MINUTE,
    title: "Check the project's types",
    description: "The project's TypeScript check (its typecheck script, tsc). The build does not check types. Errors: `typecheck_failed` with `errors` (file, line, column, message), `no_typecheck`.",
    inputSchema: projectTool(),
    annotations: { ...CHANGES, idempotentHint: true },
    words: (input, env) => ["typecheck", known(input.folder, env, "typecheck")],
  },
  {
    name: "run",
    timeout: 5 * MINUTE,
    title: "Install and start the app on the BUSY Bar",
    description:
      "Installs the project's last build on the emulated BUSY Bar, starts the app and watches it for a second (or, with `app` instead of `folder`, starts an app the BUSY Bar has by its id). `running: true`: it runs, take a screenshot. `exited: \"finished\"`: its script ended without an error. Errors: `app_crashed` (`message` has the script's first error: fix it, refresh), `not_built` (call build or refresh), `not_running` (call start).",
    inputSchema: { type: "object", properties: { folder: FOLDER, app: { type: "string", minLength: 1, description: "Instead of folder: an app the BUSY Bar has already, by its id (app.<author>.<name>), started as it is." } }, additionalProperties: false },
    annotations: CHANGES,
    words: (input, env) => {
      if ((input.folder === undefined) === (input.app === undefined)) throw new CliError("usage", "run: give folder or app, one of them.", "folder names a project; app names an installed app by its id.");
      if (input.app !== undefined && !/^app\.[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(input.app)) throw new CliError("usage", `run: ${JSON.stringify(input.app)} is not an app's id.`, "An id is app.<author>.<name>.");
      return ["run", input.app ?? known(input.folder, env, "run")];
    },
  },
  {
    name: "refresh",
    timeout: 15 * MINUTE,
    title: "Build, install and start",
    description:
      "After every change of the code: builds the project, installs it on the emulated BUSY Bar, starts it and watches it for a second (the command line's `dev --once`). `running: true`: it runs, take a screenshot. Errors: `tool_failed` (the build's own words in `output`), `settings_invalid`, `app_crashed` (`error` is the script's first error; logs has the rest), `not_running` (call start).",
    inputSchema: projectTool({ no_minify: { type: "boolean", description: "busy-cli build --no-minify: readable code in the package, for debugging." }, bundle: { type: "boolean", description: "busy-cli build --bundle: every module in one scripts/main.js." } }),
    annotations: CHANGES,
    words: (input, env) => ["dev", known(input.folder, env, "dev"), "--once", ...(input.no_minify ? ["--no-minify"] : []), ...(input.bundle ? ["--bundle"] : [])],
  },
  {
    name: "stop",
    timeout: 60_000,
    title: "Stop the app",
    description: "Stops the project's app on the emulated BUSY Bar (not the emulator). Leave the emulator running for the person to look at.",
    inputSchema: projectTool(),
    annotations: { ...CHANGES, idempotentHint: true },
    words: (input, env) => ["stop", known(input.folder, env, "stop")],
  },
  {
    name: "logs",
    timeout: 30_000,
    parallel: true,
    title: "Read the BUSY Bar's log",
    description: "The emulated BUSY Bar's latest log lines (`lines`, each `time`, `kind`, `text`): what apps print with console.log, the runtime's errors, and why an app ended. Call it when the screen shows nothing or the app ended. Changes nothing.",
    inputSchema: { type: "object", properties: { lines: { type: "integer", minimum: 1, maximum: 500, description: "How many of the latest lines (50 unless given)." } }, additionalProperties: false },
    annotations: READ_ONLY,
    words: (input) => ["logs", ...option("--lines", input.lines)],
  },
  {
    name: "screenshot",
    timeout: 60_000,
    parallel: true,
    title: "See the BUSY Bar's screen",
    description:
      "What a display of the emulated BUSY Bar shows now, as a picture you can look at: the front display (72×16 pixels, color) or the back (160×80, gray), enlarged `scale` times (8 for the front and 4 for the back unless given). Give the app a second or two after run. Saves the exact-size PNG, the file the apps catalog takes, and the enlarged copy: with `folder` in the project's screenshots/, else in the emulator's data folder; `file` and `scaled.file` name them. Errors: `not_running`, `screen_failed`.",
    inputSchema: {
      type: "object",
      properties: {
        display: { type: "string", enum: ["front", "back"], description: "front (the default) or back." },
        scale: { type: "integer", minimum: 1, maximum: 32, description: "How many times larger the picture is; 1 gives the exact size." },
        folder: { ...FOLDER, description: "A project folder (absolute; see projects) to save the screenshots in, as the catalog wants them; without it they go to the emulator's data folder." },
      },
      additionalProperties: false,
    },
    annotations: { ...CHANGES, idempotentHint: true },
    words: (input, env) => {
      const back = input.display === "back";
      const scale = input.scale ?? (back ? 4 : 8);
      const folder = input.folder === undefined ? path.join(env.ctx.dataDir, "mcp", "screenshots") : path.join(known(input.folder, env, "screenshot"), "screenshots");
      return ["screenshot", ...(back ? ["--back"] : []), ...(scale > 1 ? ["--scale", String(scale)] : []), "--out", `${folder}${path.sep}`];
    },
    after: (answer, input, env) => {
      // Screenshots outside a project are the agent's to look at now: they go once they are old (audit H12).
      if (input.folder === undefined) removeOlderThan(path.join(env.ctx.dataDir, "mcp", "screenshots"), MCP_SCREENSHOT_KEEP_MS, { match: (name) => /\.png$/i.test(name) });
      const file = answer.data.scaled?.file ?? answer.data.file;
      return [{ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/png" }];
    },
  },
  {
    name: "press",
    // A press holds the button down `hold_ms`, `times` over.
    timeout: (input) => 30_000 + (input.times ?? 1) * ((input.hold_ms ?? 0) + 1000),
    title: "Press a button of the BUSY Bar",
    description: "Presses a button of the emulated BUSY Bar or turns its wheel one click: ok (the wheel's button), start, back, up and down (the wheel). `times` repeats it; `hold_ms` holds a button down (from 300 ms an app gets a long press; a long back quits the app). Take a screenshot after it to see what changed. Error `bar_off`: the BUSY Bar is powered off; `power_on: true` turns it on with the press, which then reaches no app.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", enum: ["ok", "start", "back", "up", "down"] },
        times: { type: "integer", minimum: 1, maximum: 100 },
        hold_ms: { type: "integer", minimum: 1, maximum: 10000, description: "Hold the button down this long (not for up and down)." },
        power_on: { type: "boolean", description: "If the BUSY Bar is powered off, turn it on with this press (as a button does on a BUSY Bar)." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: CHANGES,
    words: (input) => ["press", input.key, ...option("--times", input.times), ...option("--hold", input.hold_ms), ...(input.power_on ? ["--power-on"] : [])],
  },
  {
    name: "restart_bar",
    timeout: 60_000,
    title: "Restart BUSY Bar",
    description:
      "Restarts the emulated BUSY Bar, as holding Back and Start together does on a real BUSY Bar, and waits until it answers again (`ms`: how long it took). For a BUSY Bar an app has hung: the supervisor's warning after the JS heap filled, or a screen no key changes. The running app stops and loses what it held in memory; the installed apps, their settings and the BUSY Bar's own settings are kept, and it shows the mode selector's screen. Error `restart_failed`: it did not come back (the logs tool says why).",
    inputSchema: NONE,
    annotations: { ...CHANGES, destructiveHint: true },
    words: () => ["restart-bar"],
  },
  {
    name: "settings_get",
    timeout: 60_000,
    parallel: true,
    title: "Read an app's settings",
    description: "The values of an app's settings on the emulated BUSY Bar (`values`: the saved ones, the defaults of settings.json for the rest). The app: `folder`'s project, or `app` (its id), or without either the app that runs. Errors: `no_settings`, `not_installed`, `no_app_named`.",
    inputSchema: { type: "object", properties: { folder: FOLDER, app: { type: "string", minLength: 1, description: "The app's id, app.<author>.<name>." } }, additionalProperties: false },
    annotations: READ_ONLY,
    words: (input, env) => ["settings", "get", ...whichApp(input, env, "settings")],
  },
  {
    name: "settings_set",
    timeout: 2 * MINUTE,
    title: "Change an app's settings",
    description:
      "Sets some of an app's settings on the emulated BUSY Bar, as its settings page does. `values` maps a setting's key (a field of a group as `group.field`) to its new value: true or false for a switch, a whole number, the text, or an object for a geolocation. Apps read their settings when they start: `restart: true` starts the app again and says whether it runs. The app: as for settings_get. Errors: `settings_refused` (the BUSY Bar's reason in `message`), `usage` (a key the app does not have: the message lists its keys).",
    inputSchema: {
      type: "object",
      properties: {
        values: { type: "object", minProperties: 1, additionalProperties: { type: ["string", "integer", "boolean", "object"] } },
        restart: { type: "boolean" },
        folder: FOLDER,
        app: { type: "string", minLength: 1, description: "The app's id, app.<author>.<name>." },
      },
      required: ["values"],
      additionalProperties: false,
    },
    annotations: CHANGES,
    words: (input, env) => [
      "settings",
      "set",
      ...whichApp(input, env, "settings"),
      ...(input.restart ? ["--restart"] : []),
      // After "--" every word is a key=value, even one whose key starts with "-".
      "--",
      ...Object.entries(input.values).map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`),
    ],
  },
  {
    name: "check",
    timeout: 5 * MINUTE,
    title: "Check the project against the catalog",
    description:
      "What the BUSY Apps Catalog's checks would answer for the project and its built package: `result` (pass or fail), `counts`, and `checks`, each with `status` (pass, fail, unchecked), `found` and `change` (what to do). The text lists the failures first. It writes only catalog.json, the empty form for the catalog's texts (category, descriptions, changelog), when the project has none: the person's words go there. The emulator need not run. A failure is `check_failed` with the same fields: fix what `change` says, build, check again.",
    inputSchema: projectTool(),
    annotations: ADDS_ONCE,
    words: (input, env) => ["check", known(input.folder, env, "check")],
  },
  {
    name: "submit",
    timeout: 5 * MINUTE,
    title: "Prepare the catalog's pull request",
    description:
      "Runs the checks and, when none fails and the project is built, writes submission/ in the project: the catalog's manifest, the pull request's text and the steps. Sends nothing. Like check, it makes catalog.json for the catalog's texts when it is not there: the person's words go there; then submit again. Errors: `check_failed`, `not_built`, `submission_exists`. The publish tool goes the whole way: the README, the license, the repository's files, then (stage 2, the person confirming in the app) the public repository on GitHub and the pull request.",
    inputSchema: projectTool({ catalog: { type: "string", minLength: 1, description: "For development and tests only: another catalog repository than busy-app/busy-apps-catalog (the default, the BUSY catalog), as owner/repo." } }),
    annotations: CHANGES,
    words: (input, env) => ["submit", known(input.folder, env, "submit"), ...option("--catalog", input.catalog)],
  },
  // ---------------------------------------------------------------- agent-path: the rest of the window's path
  {
    name: "catalog_texts",
    timeout: 60_000,
    parallel: false,
    title: "Read or write the app's catalog texts",
    description:
      "The Application Info step of publishing: the app's `name` (written into its manifest) and the catalog's four texts in the project's catalog.json: `category` (one id of `rules.categories`, each with what belongs in it), `short_description` (plain text, 10 to 120 characters), `description` (50 to 4000, basic Markdown) and `changelog`. Without any of them it only reads; with some it writes those and keeps the rest. Answers `texts`, `problems` (null for a text the catalog takes, else what is wrong), `taken` (all four taken) and `rules`. The person's words: write what they said the app is, ask them when you do not know. Errors: `details_unreadable`, `bad_name`.",
    inputSchema: projectTool({
      name: { type: "string", minLength: 1, description: "The app's name, as the APPS menu and the catalog show it." },
      category: { type: "string", minLength: 1, description: "A category id from rules.categories." },
      short_description: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      changelog: { type: "string", minLength: 1, description: "What is new in this version." },
    }),
    annotations: CHANGES,
    words: (input, env) => {
      const set = ["name", "category", "short_description", "description", "changelog"].some((key) => input[key] !== undefined);
      return ["catalog-texts", set ? "set" : "get", known(input.folder, env, "catalog-texts"), ...option("--name", input.name), ...option("--category", input.category), ...option("--short-description", input.short_description), ...option("--description", input.description), ...option("--changelog", input.changelog)];
    },
  },
  {
    name: "icon",
    timeout: 60_000,
    title: "Make the app's icons",
    description:
      "Writes the app's two icons into the project (src/appmeta/icon_front_8x8.png, 8×8 color, for the front menu and the catalog's card; icon_back_11x11.png, 11×11, its shape in the alpha channel, for the back menu), checked by the catalog's icon rules: from one or two letters or digits (`text`, in `color`) or from a PNG of any size (`from`), with `back` as the back icon's own picture. `from` and `back` are files inside the project's folder. Icons that are there are kept unless `force`. Errors: `icon_exists` (give force), `picture_unreadable`, `usage`.",
    inputSchema: projectTool({
      text: { type: "string", minLength: 1, description: "One or two letters or digits." },
      from: { type: "string", minLength: 1, description: "A PNG inside the project's folder (absolute, or relative to it)." },
      back: { type: "string", minLength: 1, description: "A PNG inside the project's folder for the back icon alone." },
      color: { type: "string", minLength: 1, description: "#RRGGBB of the letters." },
      force: { type: "boolean", description: "Replace icons that are there." },
    }),
    annotations: CHANGES,
    words: (input, env) => {
      const dir = known(input.folder, env, "icon");
      return ["icon", dir, ...option("--text", input.text), ...option("--from", input.from === undefined ? undefined : inside(input.from, [dir], "from")), ...option("--back", input.back === undefined ? undefined : inside(input.back, [dir], "back")), ...option("--color", input.color), ...(input.force ? ["--force"] : [])];
    },
  },
  {
    name: "time",
    timeout: 60_000,
    title: "Read, set or move the BUSY Bar's clock",
    description:
      "The emulated BUSY Bar's clock, to check a timer, a countdown or the hour without waiting. `action`: show (the default; the BUSY Bar's time and how far it is from this computer's), set (`value`: an ISO time or HH:MM[:SS] today in the BUSY Bar's zone; nothing that waits is hurried), advance (`value`: a duration such as 25m, 90s, 1h30m, at most 24h; the app's timers due in between fire now, as do the firmware's countdowns and animations; network requests are not hurried), reset (this computer's time again). Take a screenshot after it. Errors: `not_running`, `bar_off`, `time_failed`, `usage`.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["show", "set", "advance", "reset"] }, value: { type: "string", minLength: 1, description: "For set: the time; for advance: the duration." } },
      additionalProperties: false,
    },
    annotations: CHANGES,
    words: (input) => {
      const action = input.action ?? "show";
      if ((action === "set" || action === "advance") && input.value === undefined) throw new CliError("usage", `time: ${action} needs value.`, action === "set" ? 'Give value: "14:59:50" or an ISO time.' : 'Give value: a duration such as "25m".');
      if ((action === "show" || action === "reset") && input.value !== undefined) throw new CliError("usage", `time: ${action} takes no value.`, "Leave value out.");
      return ["time", ...(action === "show" ? [] : [action]), ...(input.value === undefined ? [] : [input.value])];
    },
  },
  {
    name: "record",
    timeout: 5 * MINUTE,
    title: "Record a short video of the app",
    description:
      "Records a short clip of the app running on the emulated BUSY Bar, for a post: `layout` window (the emulator's window as the person sees it; the window comes to the front), post (1080×1920, the BUSY Bar alone with its LED dots and the app's name), front (the front display alone, enlarged `scale` times) or both (1920×1080). `seconds` (5 unless given), `fps`, `gif` (a GIF of the front display instead of an MP4). Saved in the project's media/ as clip-<n>.mp4 (or .gif) with `folder`, else in the emulator's data folder; `file` names it. Press buttons or move the time before or while it records. Errors: `not_running`, `window_hidden` (the emulator runs without a window: use another layout), `window_loading` and `no_frames` (the window is still loading, or gives no frames: try again), `record_busy`, `record_failed`, `encode_failed`, `usage`.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { ...FOLDER, description: "A project folder (absolute; see projects) whose media/ gets the clip; without it the emulator's data folder." },
        seconds: { type: "integer", minimum: 1, maximum: 60 },
        fps: { type: "integer", minimum: 1, maximum: 60 },
        layout: { type: "string", enum: ["window", "post", "front", "both"] },
        scale: { type: "integer", minimum: 1, maximum: 32 },
        gif: { type: "boolean" },
      },
      additionalProperties: false,
    },
    annotations: CHANGES,
    words: (input, env) => {
      const folder = input.folder === undefined ? path.join(env.ctx.dataDir, "mcp", "media") : path.join(known(input.folder, env, "record"), "media");
      return ["record", ...option("--seconds", input.seconds), ...option("--fps", input.fps), ...option("--layout", input.layout), ...option("--scale", input.scale), ...(input.gif ? ["--gif"] : []), "--out", `${folder}${path.sep}`];
    },
  },
  {
    name: "uninstall",
    timeout: 2 * MINUTE,
    title: "Remove an app from the emulator",
    description:
      "Stops the app, takes it off the emulated BUSY Bar and forgets its project in the emulator's list: by `app` (its id) or by `folder` (a project the projects tool lists). The project's folder and its files stay as they are; moving them to the Trash is the person's step (busy-emulator uninstall <folder> --delete-files in a terminal). Errors: `not_a_project`, `not_found`, `not_running`, `uninstall_failed`, `usage`.",
    inputSchema: { type: "object", properties: { folder: FOLDER, app: { type: "string", minLength: 1, description: "The app's id, app.<author>.<name>." } }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    words: (input, env) => {
      if ((input.folder === undefined) === (input.app === undefined)) throw new CliError("usage", "uninstall: give folder or app, one of them.", "folder names a project; app names an app by its id.");
      return ["uninstall", input.app ?? path.resolve(absolute(input.folder, env, "uninstall"))];
    },
  },
  {
    name: "publish",
    // A sign-in waits for the person's code (16 min at most); push and pr wait for the person's answer in the app.
    timeout: (input) => (input.step === "signin" ? 17 * MINUTE : input.step === "push" || input.step === "pr" ? 12 * MINUTE : input.step === "prepare" ? 20 * MINUTE : 5 * MINUTE),
    title: "Publish the app: prepare it, then send it to the catalog",
    description: [
      "Publishing as the emulator's Publish dialog does it, one `step` a call (the command line's publish <step>; every answer has what the step needs next).",
      "Stage 1, on this computer, nothing sent: status (where every step stands; call it first), screenshots (`take` front|back from the display now, or `upload` PNGs inside the project or saved by the screenshot tool, `order`, `remove`), readme (`readme_action` get|preview|set; `controls` the How to use rows, one per control of the BUSY Bar, Start, Wheel turn, Wheel press, Back, each with a sentence, and `usage` a sentence after them; `title`, `intro`; or `mode` markdown with `markdown`), license (`license` MIT|Apache-2.0|GPL-3.0|other, `author`, `year`: the person's choice, ask them, never pick one; `other` with `from`, their own license file in the project), files (what the public repository will hold; `write` adds the missing .gitignore lines and the README; `keep_out`, `keep_in`), check (the catalog's checks), package (writes submission/; needs a build), prepare (license, files, build and package in one go). The catalog texts and the icons are the catalog_texts and icon tools.",
      "Stage 2, done by the emulator's app, which must be running with its window; the person confirms each step there: signin (with GitHub CLI's accounts on the computer the answer is `choose_account` with `accounts`: ask the person which one, then signin with `use_existing` and `user`, or `new_account`; a new sign-in answers at once with `userCode` and `verificationUri` for the person, then call signin with `wait` once they say they entered it), push (`name` of the public repository; the person confirms in the app; the upload's progress comes as progress notifications when the client asks for them), pr (`ai` none|partly|full: how AI was used, ask the person; the person reads the catalog's author checklist and ticks it in the app, never you), signout.",
      "check builds the app and checks its types first: a build or type error is a failing check with `file` and `line`.",
      "Errors: `check_failed` (fix what `change` says), `not_built`, `readme_incomplete`, `not_checked` and `changed_since_check` / `changed_since_package` (push and pr: a file changed since check or package, named in `changed`; run check and package again), `choose_account`, `refused` (the person chose Cancel: do not ask again unless they say so), `window_hidden`, `not_running`, `github_unavailable`, `usage`.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        step: { type: "string", enum: ["status", "check", "license", "files", "screenshots", "readme", "package", "prepare", "signin", "signout", "push", "pr"] },
        folder: { ...FOLDER, description: "The project's folder (absolute; see projects). Every step but signin and signout takes it." },
        license: { type: "string", enum: ["MIT", "Apache-2.0", "GPL-3.0", "other"], description: "license, prepare: the person's choice." },
        author: { type: "string", minLength: 1, description: "license, prepare: who holds the copyright." },
        from: { type: "string", minLength: 1, description: "license, prepare with license other: the person's own license file, inside the project's folder." },
        replace: { type: "boolean", description: "license with from: put it in place of the license file there (that one goes to .busy/removed)." },
        year: { type: "integer", minimum: 1970, maximum: 9999 },
        write: { type: "boolean", description: "files: write .gitignore's missing lines and the README." },
        keep_out: { type: "string", minLength: 1, description: "files: a path inside the project to keep out of the repository." },
        keep_in: { type: "string", minLength: 1, description: "files: a flagged path to publish all the same." },
        take: { type: "string", enum: ["front", "back"], description: "screenshots: take one of this display now." },
        upload: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 }, description: "screenshots: PNG files inside the project or saved by the screenshot tool." },
        display: { type: "string", enum: ["front", "back"], description: "screenshots with upload: take only this display's." },
        order: { type: "object", properties: { front: { type: "array", items: { type: "string" } }, back: { type: "array", items: { type: "string" } } }, additionalProperties: false, description: "screenshots: the order, by the paths status lists; the first front one is the cover." },
        remove: { type: "string", minLength: 1, description: "screenshots: one to remove, by its path as listed." },
        readme_action: { type: "string", enum: ["get", "preview", "set"], description: "readme: get (the default), preview (the Markdown, nothing written) or set (writes README.md)." },
        mode: { type: "string", enum: ["fields", "markdown"] },
        title: { type: "string", minLength: 1 },
        intro: { type: "string", minLength: 1, description: "readme: what the app does, a paragraph." },
        controls: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: { type: "object", properties: { control: { type: "string", enum: ["Start", "Wheel turn", "Wheel press", "Back"] }, text: { type: "string", minLength: 1 } }, required: ["control", "text"], additionalProperties: false },
          description: "readme: How to use, one row per control of the BUSY Bar with what it does in the app.",
        },
        usage: { type: "string", minLength: 1, description: "readme: How to use's text; with controls, the sentence after the rows." },
        markdown: { type: "string", minLength: 1, description: "readme with mode markdown: the whole README." },
        name: { type: "string", minLength: 1, description: "push: the public repository's name." },
        ai: { type: "string", enum: ["none", "partly", "full"], description: "pr: how AI was used in the app; the person says." },
        catalog: { type: "string", minLength: 1, description: "pr, for development and tests only: another catalog than busy-app/busy-apps-catalog (the default, the BUSY catalog), as owner/name. The person confirms one that is not BUSY's." },
        use_existing: { type: "boolean", description: "signin: one of GitHub CLI's accounts, as the person chose." },
        user: { type: "string", minLength: 1, description: "signin: that account's login, from `accounts`." },
        new_account: { type: "boolean", description: "signin: sign in another account (a code for the person)." },
        wait: { type: "boolean", description: "signin: wait for the sign-in under way, once the person says they entered the code." },
      },
      required: ["step"],
      additionalProperties: false,
    },
    annotations: { ...CHANGES, openWorldHint: true },
    words: (input, env) => publishWords(input, env),
  },
  {
    name: "update",
    // The check answers within a minute; the update waits for the person's answer and a download of some 250 MB.
    timeout: (input) => (input.install ? 32 * MINUTE : 2 * MINUTE),
    title: "Check for a newer emulator, or update it",
    description:
      "Without `install`: asks GitHub now, through the running emulator, whether a newer version of the emulator is out, and whether this copy can update itself (`can_update`; `why_not` and the download `page` when it cannot). Changes nothing. With `install: true`: the update, which is the person's decision: the emulator's app asks them in its window, and only with their yes downloads the new version, checks its signature, quits and opens again as the new version (the answer comes just before it restarts; call status after a few seconds). Ask the person before you call it with install. On Windows `install` is refused at once (`update_from_window`): the setup cannot replace the emulator's folder while this MCP server runs from it, so the person ends this agent session and clicks Update in the emulator's window. Errors: `no_update`, `cannot_update` (give the person `page`), `update_from_window`, `in_use` (another program runs from the emulator's folder: the message names it), `refused` (the person chose Cancel: do not ask again unless they say so), `window_hidden`, `busy`, `network`, `not_running`.",
    inputSchema: { type: "object", properties: { install: { type: "boolean", description: "Update now; the person confirms in the emulator's window." } }, additionalProperties: false },
    // Destructive: with install, the emulator quits and its app is replaced (the person's dialog still decides).
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    words: (input, env) => {
      if (!input.install) return ["update", "--check"];
      // This server runs the app's Node from the emulator's folder for the whole session, and the setup cannot replace
      // a folder a program runs from: on Windows the update can only be done once the session has ended.
      if ((env?.ctx?.platform ?? process.platform) === "win32") {
        throw new CliError(
          "update_from_window",
          "On Windows the emulator cannot update itself while an agent's busy-emulator mcp runs from its folder, and this MCP server is one.",
          "Tell the person: end this agent session, then click Update in the emulator's window. `update` without install still checks.",
        );
      }
      return ["update"];
    },
  },
];

/** The words of `publish <step>` for the publish tool: only what the step takes, paths only inside the project. */
function publishWords(input, env) {
  const step = input.step;
  const noProject = step === "signin" || step === "signout";
  if (noProject && input.folder !== undefined) throw new CliError("usage", `publish: ${step} takes no folder.`, "Leave folder out.");
  if (!noProject && input.folder === undefined) throw new CliError("usage", `publish: ${step} needs folder.`, "Give the project's folder, as projects lists it.");
  const dir = noProject ? null : known(input.folder, env, "publish");
  const words = ["publish", step];
  if (step === "readme") words.push(input.readme_action ?? "get");
  if (dir) words.push(dir);
  const allowed = {
    license: ["license", "author", "year", "from", "replace"],
    prepare: ["license", "author", "year", "from"],
    files: ["write", "keep_out", "keep_in"],
    screenshots: ["take", "upload", "display", "order", "remove"],
    readme: ["readme_action", "mode", "title", "intro", "controls", "usage", "markdown"],
    push: ["name"],
    pr: ["ai", "catalog"],
    signin: ["use_existing", "user", "new_account", "wait"],
  }[step] ?? [];
  const extra = Object.keys(input).filter((key) => key !== "step" && key !== "folder" && !allowed.includes(key));
  if (extra.length) throw new CliError("usage", `publish: ${step} takes no ${extra.join(", ")}.`, allowed.length ? `${step} takes ${allowed.join(", ")}.` : `${step} takes only folder.`);
  words.push(...option("--license", input.license), ...option("--author", input.author), ...option("--year", input.year));
  // The person's own license file: from the project's folder only, as every file a tool reads.
  if (input.from !== undefined) words.push(`--from=${inside(input.from, [dir], "from")}`);
  if (input.replace) words.push("--replace");
  if (input.write) words.push("--write");
  words.push(...option("--keep-out", input.keep_out), ...option("--keep-in", input.keep_in), ...option("--take", input.take));
  // Screenshots come only from the project or from the screenshot tool's own folder (no file of the person's elsewhere).
  if (input.upload !== undefined) words.push("--upload=" + JSON.stringify(input.upload.map((one) => inside(one, [dir, path.join(env.ctx.dataDir, "mcp", "screenshots")], "upload"))));
  words.push(...option("--display", input.display));
  if (input.order !== undefined) words.push(`--order=${JSON.stringify(input.order)}`);
  words.push(...option("--remove", input.remove), ...option("--mode", input.mode), ...option("--title", input.title), ...option("--intro", input.intro));
  if (input.controls !== undefined) words.push(`--controls=${JSON.stringify(input.controls)}`);
  words.push(...option("--usage", input.usage), ...option("--markdown", input.markdown), ...option("--name", input.name), ...option("--ai", input.ai), ...option("--catalog", input.catalog));
  if (input.use_existing) words.push("--use-existing");
  words.push(...option("--user", input.user));
  if (input.new_account) words.push("--new-account");
  // A new sign-in answers with its code at once (a model cannot read the progress of a waiting call); signin again waits.
  if (step === "signin" && !input.use_existing && input.user === undefined && !input.wait) words.push("--no-wait");
  return words;
}

/**
 * A file a tool reads, inside one of `roots` by its real path (a project folder, the tools' own folder in the data
 * folder): a model is not given a way to copy any file of this computer into a project that may be published.
 */
function inside(file, roots, what) {
  const base = roots.find(Boolean);
  const full = path.resolve(base, file);
  let real = full;
  try {
    real = realpathSync(full);
  } catch {
    // Not there: the command says so.
  }
  const within = (root) => {
    let r = root;
    try {
      r = realpathSync(root);
    } catch {
      // as given
    }
    const rel = path.relative(r, real);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  if (!roots.filter(Boolean).some(within)) throw new CliError("usage", `${what}: ${full} is not inside the project's folder.`, "Copy the file into the project's folder first; this server reads no file of this computer elsewhere.", { file: full });
  return real;
}

/** --name value, when the value is given. */
/** An option with the model's value, as --flag=<value>: a value that starts with "-" stays a value. */
function option(flag, value) {
  return value === undefined ? [] : [`${flag}=${String(value)}`];
}

/** An absolute path, as a chat client has no folder of its own that a relative one could be taken from. */
function absolute(folder, env, tool) {
  if (!path.isAbsolute(folder)) {
    throw new CliError("usage", `${tool}: folder must be an absolute path, not ${JSON.stringify(folder)}.`, "Give the whole path, as in /Users/<name>/busy-apps/my-app on macOS or C:\\Users\\<name>\\busy-apps\\my-app on Windows.", { folder });
  }
  return path.resolve(folder);
}

/**
 * A project folder the emulator knows: created by `create` or trusted by the person, at its place. Any other one is
 * refused with the command line's own answer (requireTrust), whatever the command.
 */
function known(folder, env, command) {
  const project = projectAt(env.ctx, env.sys, absolute(folder, env, command));
  requireTrust(env.ctx, env.sys, { ...project, given: project.dir }, {}, command);
  return project.dir;
}

function whichApp(input, env, command) {
  if (input.folder !== undefined && input.app !== undefined) throw new CliError("usage", "Give folder or app, not both.", "folder names a project; app names an app by its id.");
  if (input.folder !== undefined) return [known(input.folder, env, command)];
  return option("--app", input.app);
}

function projectsAnswer(env) {
  const projects = readTrusted(env.ctx.dataDir).map((entry) => {
    let present = false;
    try {
      present = isTrusted(env.ctx.dataDir, entry.path, env.ctx.platform);
    } catch {
      present = false;
    }
    return { folder: entry.path, how: entry.how ?? null, at: entry.at ?? null, present };
  });
  const lines = projects.map((one) => `${one.folder} (${one.how ?? "?"}${one.present ? "" : ", not at this place any more"})`);
  return { data: { projects }, text: projects.length ? `The projects this emulator knows:\n${lines.join("\n")}` : "The emulator knows no project yet: create_app makes one." };
}

// ---------------------------------------------------------------- arguments

/** The first way `value` breaks `schema` (the part of JSON Schema the tools use), or null. */
export function schemaProblem(schema, value, where = "arguments") {
  const types = [schema.type ?? []].flat();
  if (types.length && !types.some((type) => typeOf(value, type))) return `${where} must be ${types.join(" or ")}, not ${JSON.stringify(value)}`;
  if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of ${schema.enum.join(", ")}, not ${JSON.stringify(value)}`;
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) return `${where} must not be empty`;
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${where} needs at least ${schema.minItems} item`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${where} takes at most ${schema.maxItems} items`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const problem = schemaProblem(schema.items, value[i], `${where}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${where} must be at least ${schema.minimum}, not ${value}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${where} must be at most ${schema.maximum}, not ${value}`;
  }
  if (typeOf(value, "object")) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return `${where}.${key} is missing`;
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) return `${where} needs at least ${schema.minProperties} entry, as in { "key": "value" }`;
    for (const [key, item] of Object.entries(value)) {
      let sub;
      if (schema.properties && Object.hasOwn(schema.properties, key)) sub = schema.properties[key];
      else if (schema.additionalProperties === false) return `${where} has no ${JSON.stringify(key)}; it takes ${Object.keys(schema.properties ?? {}).join(", ") || "nothing"}`;
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") sub = schema.additionalProperties;
      else continue;
      const problem = schemaProblem(sub, item, `${where}.${key}`);
      if (problem) return problem;
    }
  }
  return null;
}

function typeOf(value, type) {
  switch (type) {
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

// ---------------------------------------------------------------- running

/** The tools' definitions as tools/list gives them. */
export function toolList() {
  return TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

/** How long a stopped tool's command has to end before the next one in the queue starts all the same. */
export const STOP_WAIT_MS = 5000;

/**
 * Runs the tools that change something one at a time (two such commands of the command line at once in one process
 * is nothing the command line was made for); the ones that only read go at once, beside them. Each gets a
 * CallToolResult. A tool that takes longer than its `timeout`, or whose request the client cancels (`signal`), is
 * stopped: every program it started is killed with what that started in turn (projects/node-tools.mjs), its answer is
 * `tool_timeout` (a canceled one gets none, protocol.mjs), and the queue goes on.
 * @param {{ ctx: object, sys: object, commands: object[], main: Function }} env  sys with cwd() at a folder that is no
 *   project; main(), the command line's (busy-emulator.mjs), handed over by the command: importing it here would wait
 *   for the module that is running this very command
 * @param {object} [o]
 * @param {(tool: object, input: object) => number} [o.timeoutOf]  for the tests: a tool's time
 * @param {number} [o.stopWait]
 */
export function toolRunner(env, { timeoutOf = timeoutFor, stopWait = STOP_WAIT_MS } = {}) {
  let queue = Promise.resolve();
  return (name, input, { signal = null, progress = null } = {}) => {
    const tool = TOOLS.find((one) => one.name === name);
    const run = () => callTool(env, name, input, { signal, progress, timeout: tool ? timeoutOf(tool, input ?? {}) : 30_000, stopWait });
    if (tool?.parallel) return run();
    const result = queue.then(run);
    queue = result.catch(() => {});
    return result;
  };
}

/** A tool's time for this input. */
export function timeoutFor(tool, input) {
  const ms = typeof tool.timeout === "function" ? tool.timeout(input) : tool.timeout;
  return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
}

/** The system of one tool's command: every program it starts is stopped when `signal` aborts. */
function stoppable(sys, signal) {
  return { ...sys, runTool: (setup, request) => sys.runTool(setup, { ...request, signal }) };
}

async function callTool(env, name, input, { signal = null, progress = null, timeout = 60_000, stopWait = STOP_WAIT_MS } = {}) {
  const tool = TOOLS.find((one) => one.name === name);
  const problem = schemaProblem(tool.inputSchema, input);
  if (problem) return resultOf(env, { ok: false, command: name, error: new CliError("usage", `${name}: ${problem}.`, "Call it again with arguments as its input schema says.") });
  // Canceled while it waited in the queue: it does not start.
  if (signal?.aborted) return resultOf(env, { ok: false, command: name, error: canceledError(name) });
  const stop = new AbortController();
  const why = { reason: null };
  const end = (reason) => {
    if (why.reason) return;
    why.reason = reason;
    stop.abort(reason);
  };
  const onCancel = () => end("canceled");
  signal?.addEventListener("abort", onCancel, { once: true });
  const timer = setTimeout(() => end("timeout"), timeout);
  const stopped = new Promise((resolve) => stop.signal.addEventListener("abort", resolve, { once: true }));
  const work = (async () => {
    if (tool.run) return tool.run(input, env);
    const words = tool.words(input, env);
    return runCommand({ ...env, sys: stoppable(env.sys, stop.signal) }, words, progress);
  })().catch((e) => ({ ok: false, command: name, error: e instanceof CliError ? e : new CliError("internal", `Unexpected failure: ${e?.stack ?? e}`, "Report this with the text above.") }));
  let answer;
  try {
    answer = await Promise.race([work, stopped.then(() => null)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCancel);
  }
  if (answer === null) {
    // Its programs are being killed; the command itself ends soon after. The next tool waits for that, but not for
    // ever: what runs in this process (a request that never answers) cannot be killed, only left behind.
    let wait;
    await Promise.race([work, new Promise((resolve) => (wait = setTimeout(resolve, stopWait)))]);
    clearTimeout(wait);
    answer = { ok: false, command: name, error: why.reason === "canceled" ? canceledError(name) : timeoutError(name, timeout) };
  }
  let more = [];
  if (answer.ok && tool.after) {
    try {
      more = tool.after(answer, input, env);
    } catch (e) {
      answer = { ok: false, command: answer.command, error: new CliError("write_failed", `The screenshot was saved, but could not be read back: ${e.message}.`, "Call screenshot again.") };
    }
  }
  return resultOf(env, answer, more);
}

const seconds = (ms) => (ms % 1000 ? (ms / 1000).toFixed(1) : String(ms / 1000));
function timeoutError(name, ms) {
  return new CliError("tool_timeout", `${name} did not end in ${seconds(ms)} s: it was stopped, with the programs it had started.`, `Call ${name} again. If it hangs again, call status and logs to see what the emulator is doing, and tell the person.`, { timeout_s: ms / 1000 });
}
function canceledError(name) {
  return new CliError("canceled", `${name} was canceled: it was stopped, with the programs it had started.`, `Call ${name} again when you want it done.`);
}

/** One command of the command line, in this process, with --json: its answer as main() has it. */
export async function runCommand(env, words, progress = null) {
  let answer = null;
  // With a client that takes progress, the command's own lines (--progress) go to it; otherwise to the log.
  const err = progress ? (line) => (progress(line), process.stderr.write(`${line}\n`)) : (line) => process.stderr.write(`${line}\n`);
  await env.main([...words, "--json", ...(progress ? ["--progress"] : [])], { ctx: env.ctx, sys: env.sys, commands: env.commands, out: () => {}, err, answer: (one) => (answer = one) });
  return answer;
}

/** The text a model reads when its client gives it no structuredContent: the answer as JSON, when that is short. */
const JSON_IN_TEXT_MAX = 8000;

function resultOf(env, answer, more = []) {
  let structured;
  let text;
  if (answer.ok) {
    structured = { ok: true, command: answer.command, ...answer.data };
    text = answer.text || `${answer.command}: done.`;
  } else {
    const { error } = answer;
    structured = { ok: false, command: answer.command, code: error.code, message: error.message, hint: error.hint, ...error.extra };
    text = `${error.code}: ${error.message}${error.hint ? `\nWhat to do: ${error.hint}` : ""}`;
    if (TRUST_CODES.has(error.code)) {
      const folder = error.extra?.folder ?? "<folder>";
      structured.mcp_hint = `No tool of this server trusts a folder or asks the person to. Ask the person to run, in a terminal: ${commandLine(env.ctx)} trust ${shellWord(env.ctx, folder)} (the emulator then asks them in a dialog on its window), or make the project with create_app.`;
      text += `\n${structured.mcp_hint}`;
    }
  }
  const json = JSON.stringify(structured);
  if (json.length <= JSON_IN_TEXT_MAX) text += `\n\n${json}`;
  else text += `\n\n(The whole answer, ${json.length} characters, is in structuredContent.)`;
  return { content: [{ type: "text", text }, ...more], structuredContent: structured, isError: !answer.ok };
}
