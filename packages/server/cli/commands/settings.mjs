// busy-emulator settings get|set|reset: an app's settings on the emulated BUSY Bar, read and written through the BUSY Bar's own
// API (/api/apps/settings), as the BUSY Bar's web page does it. The agent's way to try a settings page: in the field test
// no agent could write a settings value (`curl` to the BUSY Bar was refused), so none saw its app with another setting.
//
//   settings get [<folder>] [--app <id>]                    the values the BUSY Bar holds: saved ones, defaults for the rest
//   settings set [<folder>] <key>=<value> … [--app <id>] [--restart]
//   settings reset [<folder>] [--app <id>] [--restart]      back to the defaults of settings.json
//
// Which app: --app <id>; else the project in <folder>, or in the caller's folder; else, outside a project, the app
// that runs on the BUSY Bar. A value is read by the kind of the value it replaces: true/false for a switch, a whole number
// for an integer, JSON for a geolocation, the text as it is for the rest; a field of a group is `group.field=value`.
// The BUSY Bar takes the whole document or refuses it (400, with the reason in its log: an unknown option, a number out
// of range); the command reads the reason there. An app reads its settings when it asks for them, which apps do at
// their start: --restart stops the app and starts it again, and says whether it runs. The emulator must be running.
//
// A string field marked "sensitive" in the app's settings.json (a token in a header) is shown as (hidden) to a model
// that calls this through `busy-emulator mcp` (ctx.mcp): a model can be steered by what it reads, and the value is
// the person's. It can still set the value. A person or an agent in a terminal sees the values: they can read the
// BUSY Bar's settings file in the data folder anyway, so hiding them there would protect nothing. The schema is read from
// the BUSY Bar, as its web page reads it; when it cannot be read, every text value is hidden.
import { jsonLine, momentOf, watchStart } from "../app-log.mjs";
import { blockedNetwork, commandLine, emulatorStatus, ready } from "../lifecycle.mjs";
import { CliError } from "../output.mjs";
import { again, commandFor, projectAt, shellWord } from "../project.mjs";

const USAGE = "settings get|set|reset [<folder>] [<key>=<value> …] [--app <id>] [--restart]";
const ACTIONS = ["get", "set", "reset"];
const APP_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,31}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** What a hidden value reads as. */
export const HIDDEN = "(hidden)";

/** The keys ("group.field") of the schema's fields marked sensitive. */
export function sensitiveKeys(fields, prefix = "") {
  if (!isObject(fields)) return [];
  return Object.entries(fields).flatMap(([key, field]) => (field?.type === "group" ? sensitiveKeys(field.fields, `${prefix}${key}.`) : field?.sensitive === true ? [`${prefix}${key}`] : []));
}

/**
 * A copy of `values` with the sensitive ones as HIDDEN: those `keys` names, or with `keys` null (the schema unknown)
 * every text. An empty value stays empty: that it is not set is no secret, and it tells the model it may set one.
 */
export function hideValues(values, keys, prefix = "") {
  if (!isObject(values)) return values;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const at = `${prefix}${key}`;
      if (isObject(value) && !("mode" in value && "name" in value)) return [key, hideValues(value, keys, `${at}.`)];
      const secret = keys === null ? typeof value === "string" : keys.includes(at);
      return [key, secret && value !== "" ? HIDDEN : value];
    }),
  );
}

/** The values as lines, groups indented by their path: "group.field = value". */
function shownValues(values, prefix = "") {
  return Object.entries(values).flatMap(([key, value]) => (isObject(value) && !("mode" in value && "name" in value) ? shownValues(value, `${prefix}${key}.`) : [`${prefix}${key} = ${JSON.stringify(value)}`]));
}

/** `text` as a value of the kind `current` is. Throws a string: why it is not one. */
function valueLike(current, text) {
  if (typeof current === "boolean") {
    if (text === "true" || text === "false") return text === "true";
    throw "it is a switch: true or false";
  }
  if (typeof current === "number") {
    if (/^-?\d+$/.test(text)) return Number(text);
    throw "it is a whole number";
  }
  if (isObject(current)) {
    try {
      const value = JSON.parse(text);
      if (isObject(value)) return value;
    } catch {
      // told below
    }
    throw `it is an object: give JSON, as in '${JSON.stringify(current)}'`;
  }
  return text;
}

/** Puts `key=value` into a copy of the values. Throws a string: why not. */
function assign(values, key, text) {
  const path = key.split(".");
  let at = values;
  for (const part of path.slice(0, -1)) {
    if (!isObject(at[part])) throw `there is no group ${JSON.stringify(part)}`;
    at = at[part];
  }
  const last = path.at(-1);
  if (!Object.hasOwn(at, last)) throw `the app has no setting ${JSON.stringify(key)}; it has ${shownValues(values).map((line) => line.split(" = ")[0]).join(", ")}`;
  if (isObject(at[last]) && !("mode" in at[last] && "name" in at[last])) throw `${JSON.stringify(key)} is a group: name a field of it, as in ${key}.${Object.keys(at[last])[0] ?? "field"}=…`;
  at[last] = valueLike(at[last], text);
}

function errorOf(answer) {
  try {
    return String(JSON.parse(answer.body).error ?? "");
  } catch {
    return "";
  }
}

export default {
  name: "settings",
  summary: "Read an app's settings on the emulated BUSY Bar, set some (key=value …, --restart starts the app again), or reset them",
  usage: USAGE,
  maxArguments: 64,
  options: { "--app": { key: "app", value: "<id>" }, "--restart": { key: "restart" } },
  async run(ctx, sys, { args, options }) {
    const self = commandLine(ctx);
    const usage = `Usage: ${self} ${USAGE}`;
    const action = args[0];
    if (!ACTIONS.includes(action)) {
      throw new CliError("usage", action ? `settings has no action ${JSON.stringify(action)}: it is get, set or reset.` : "settings needs an action: get, set or reset.", `${usage}. For example: ${self} settings get; ${self} settings set hour24=false --restart.`, { argument: action ?? null });
    }
    const pairs = args.slice(1).filter((word) => word.includes("="));
    const folders = args.slice(1).filter((word) => !word.includes("="));
    if (folders.length > 1) throw new CliError("usage", `settings ${action} takes one folder, not ${folders.map((word) => JSON.stringify(word)).join(" ")}; a value to set is written key=value.`, usage, { arguments: folders });
    if (action === "set" && !pairs.length) throw new CliError("usage", "settings set needs what to set: key=value, one or more.", `${usage}. The keys are in ${self} settings get.`);
    if (action !== "set" && pairs.length) throw new CliError("usage", `settings ${action} takes no key=value; that is settings set.`, usage, { arguments: pairs });
    if (action === "get" && options.restart) throw new CliError("usage", "settings get changes nothing, so there is nothing to restart the app for.", usage, { option: "--restart" });
    if (options.app !== undefined && !APP_ID.test(options.app)) throw new CliError("usage", `--app takes an app's id (app.author.name), not ${JSON.stringify(options.app)}.`, usage, { option: "--app" });
    if (options.app !== undefined && folders.length) throw new CliError("usage", "settings takes a folder or --app <id>, not both.", usage);

    const status = await emulatorStatus(ctx, sys);
    if (!ready(status)) {
      const hint = `Start it with ${self} start, then run ${self} settings ${action} again.`;
      if (!status.running) throw new CliError("not_running", "The emulator is not running, so there is no BUSY Bar that holds the app's settings.", hint);
      throw new CliError("not_running", `The emulator is running, but its BUSY Bar is not ready (${status.state}).`, hint);
    }
    const { port } = status;
    const address = `127.0.0.1:${port}`;

    // Which app.
    let id = options.app ?? null;
    let project = null;
    if (id === null) {
      try {
        project = projectAt(ctx, sys, folders[0]);
        id = project.id;
      } catch (e) {
        // Outside a project, with no folder named: the app that runs on the bar.
        if (!(e instanceof CliError) || e.code !== "not_a_project" || folders.length) throw e;
        const state = await sys.barGet(port, "/_emu/state");
        if (state.blocked) throw blockedNetwork(port, state.blocked);
        try {
          id = JSON.parse(state.body).running?.id ?? null;
        } catch {
          id = null;
        }
      }
      if (id === null) throw new CliError("no_app_named", "This folder is not an app project and no app is running on the emulated BUSY Bar, so there is no app whose settings to read or change.", `Run it in the project's folder, name the folder, or name the app: ${self} settings ${action} --app <id>.`);
    }
    const target = `/api/apps/settings?app_id=${encodeURIComponent(id)}`;
    const build = project ? commandFor(ctx, project, "build") : `${self} build`;
    const run = project ? commandFor(ctx, project, "run") : `${self} run`;

    /** One request about the settings; what the bar refuses with is told in the command's own words. */
    const ask = async (method, body = null) => {
      const answer = method === "GET" ? await sys.barGet(port, target) : await sys.barSend(port, method, target, body);
      if (answer.blocked) throw blockedNetwork(port, answer.blocked);
      if (answer.failed) throw new CliError("settings_failed", `The emulated BUSY Bar at ${address} gave no answer about the settings of ${id} (${answer.failed}).`, `Check that it is the emulator that listens there: ${self} status.`, { id });
      const said = errorOf(answer);
      if (answer.status === 404 && /no settings schema/i.test(said)) {
        throw new CliError("no_settings", `${id} has no settings: the app on the BUSY Bar has no appmeta/settings.json.`, `Describe them in src/appmeta/settings.json of the project (the format is in the project's AGENTS.md), then ${build} and ${run}.`, { id });
      }
      if (answer.status === 404) throw new CliError("not_installed", `${id} is not on the emulated BUSY Bar.`, `Build it and put it there: ${build}, then ${run}.`, { id });
      if (answer.status === 503) throw new CliError("settings_invalid", `The BUSY Bar refuses the settings file of ${id} as it is installed: its appmeta/settings.json is invalid.`, `${build} checks the project's file and names the field at fault; then ${run}.`, { id });
      return answer;
    };

    // What a model may see of the values (see the top of the file).
    let hidden = [];
    if (ctx.mcp) {
      const schema = await sys.barGet(port, `/api/storage/read?path=${encodeURIComponent(`/ext/user_assets/${id}/appmeta/settings.json`)}`);
      try {
        hidden = schema.status === 200 ? sensitiveKeys(JSON.parse(schema.body).fields) : null;
      } catch {
        hidden = null;
      }
    }
    const shown = (values) => (ctx.mcp ? hideValues(values, hidden) : values);

    const read = async () => {
      const answer = await ask("GET");
      try {
        const document = JSON.parse(answer.body);
        if (answer.status === 200 && isObject(document?.values)) return document;
      } catch {
        // told below
      }
      throw new CliError("settings_failed", `The emulated BUSY Bar at ${address} answered the settings of ${id} with HTTP ${answer.status}, not with the values.`, `Check that it is the emulator that listens there: ${self} status.`, { id });
    };

    if (action === "get") {
      const document = await read();
      const values = shown(document.values);
      return { data: { id, address, version: document.version, values }, text: [`The settings of ${id} on the emulated BUSY Bar at ${address}:`, ...shownValues(values).map((line) => `  ${line}`), `Set one with ${self} settings set <key>=<value> --restart.`].join("\n") };
    }

    let changed = [];
    if (action === "set") {
      const document = await read();
      const values = structuredClone(document.values);
      for (const pair of pairs) {
        const at = pair.indexOf("=");
        const key = pair.slice(0, at);
        try {
          assign(values, key, pair.slice(at + 1));
        } catch (why) {
          if (typeof why !== "string") throw why;
          throw new CliError("usage", `${JSON.stringify(pair)} cannot be set: ${why}.`, `The settings and their values now: ${self} settings get${project?.given ? ` ${shellWord(ctx, project.given)}` : options.app ? ` --app ${id}` : ""}.`, { argument: pair, values: shown(document.values) });
        }
        changed.push(key);
      }
      const since = sys.now();
      const answer = await ask("PUT", JSON.stringify({ version: document.version, values }));
      if (answer.status !== 200) {
        // The bar says only "Bad Request"; the emulated bar writes why into its log.
        const log = await sys.barLog(port);
        const why = (log.lines ?? []).filter((line) => momentOf(line) >= since - 1000 && line.text.includes(`The settings sent for ${id} were refused`)).at(-1)?.text.split("): ").slice(1).join("): ");
        throw new CliError("settings_refused", `The BUSY Bar refused the new settings of ${id}${why ? `: ${why}` : ` (HTTP ${answer.status}: ${errorOf(answer) || "no reason given"})`}. Nothing was changed.`, `What a field takes is in the project's src/appmeta/settings.json: an enum only the "value" of one of its options, an integer a number from "min" to "max" in steps of "step", a string up to "max_length" bytes.`, { id, refused: why ?? null, values: shown(document.values) });
      }
    } else {
      const answer = await ask("DELETE");
      if (answer.status !== 200) throw new CliError("settings_failed", `The BUSY Bar did not reset the settings of ${id} (HTTP ${answer.status}: ${errorOf(answer) || "no reason given"}).`, `Check that it is the emulator that listens there: ${self} status.`, { id });
    }
    const now = await read();
    changed = action === "reset" ? shownValues(now.values).map((line) => line.split(" = ")[0]) : changed;
    const data = { id, address, action, changed, version: now.version, values: shown(now.values), restarted: false, running: null };
    const done = action === "reset" ? `The settings of ${id} are back at the defaults of its settings.json:` : `Set ${changed.join(", ")} for ${id} on the emulated BUSY Bar at ${address}. Its settings now:`;
    const lines = [done, ...shownValues(data.values).map((line) => `  ${line}`)];
    const restarting = `${self} settings ${action === "reset" ? "reset" : `set ${pairs.map((pair) => shellWord(ctx, pair)).join(" ")}`}${project?.given ? ` ${shellWord(ctx, project.given)}` : options.app ? ` --app ${id}` : ""} --restart`;

    if (!options.restart) {
      lines.push(`An app reads its settings when it starts: start it again to see them (${restarting}, or ${run}).`);
      return { data, text: lines.join("\n") };
    }

    // Stop the app that runs, whichever it is, and start this one, as the bar's web page does with Restart.
    await sys.barSend(port, "POST", "/api/apps/quit");
    const since = sys.now();
    const launched = await sys.barSend(port, "POST", `/api/apps/launch?app_id=${encodeURIComponent(id)}`);
    if (launched.blocked) throw blockedNetwork(port, launched.blocked);
    if (launched.failed || launched.status !== 200) {
      throw new CliError("restart_failed", `The settings of ${id} are ${action === "reset" ? "reset" : "set"}, but the BUSY Bar did not start the app again (${launched.failed ?? `HTTP ${launched.status}: ${errorOf(launched)}`}).`, `Start it with ${run}.`, data);
    }
    const seen = await watchStart(sys, port, id, since);
    data.restarted = true;
    data.running = seen.running;
    data.errors = seen.errors;
    data.log = seen.lines.map(jsonLine);
    const logs = again(ctx, "logs");
    if (seen.running === false && (seen.errors.length || seen.crashed)) {
      const first = seen.errors[0] ?? seen.exited;
      throw new CliError("app_crashed", `The settings of ${id} are ${action === "reset" ? "reset" : "set"}; started again with them, the app stopped at once: ${first}`, `Its console and the error are in ${logs}.`, { ...data, error: first });
    }
    lines.push(seen.running === true ? `Started ${id} again; it is running with these settings. Its console: ${logs}.` : seen.running === false ? `Started ${id} again; its script ran to its end at once (${seen.exited}).` : `Started ${id} again. Whether it runs could not be read from the BUSY Bar's log; look with ${logs}.`);
    return { data, text: lines.join("\n") };
  },
};
