// The command line's words, said in the window's (actions.mjs). The command line's hints and the catalog's checks name
// commands to type ("then run busy-emulator dev '/…/clock' --once again"); the main window has buttons for most of
// them. A text the window shows names the button instead ("then press Refresh again"); a command the window has no
// button for stays, marked as one for a terminal. No text the page shows names the path of the Node inside the app or
// of the command line: the shell runs the command line with BUSY_EMULATOR_CLI_PATH=busy-emulator (cli-process.mjs),
// so that it names itself `busy-emulator`, and a path that comes through all the same is cut down to that name here.
//
// The command line's own texts are left as they are for a terminal and an agent: the mapping is the window's.

/** The commands of the command line (packages/server/cli/commands); a test holds the list to that folder. */
export const COMMANDS = Object.freeze(["allow-local", "build", "catalog-texts", "check", "create", "dev", "help", "icon", "install", "logs", "mcp", "press", "projects", "publish", "quit", "record", "restart-bar", "run", "screenshot", "settings", "start", "status", "stop", "submit", "time", "trust", "typecheck", "uninstall", "update", "version"]);

/** The button of the window that does what a command does, or null when there is none. */
function buttonFor(command, args) {
  switch (command) {
    case "dev":
      return args.includes("--once") ? "Refresh" : "Watch the folder";
    case "build":
      return "Build";
    case "run":
      return "Run";
    case "stop":
      return "Stop";
    case "check":
    case "submit":
      return "Publish";
    case "publish":
    case "catalog-texts":
      return "Publish";
    case "create":
      return "Create app";
    case "restart-bar":
      return "Restart BUSY Bar";
    default:
      return null;
  }
}

// A word after the command: a quoted one (POSIX, PowerShell or cmd), an option (with its value, for the options that
// take one), a placeholder, a path, or "." for the caller's folder. A word ends before the punctuation of its sentence.
const END = String.raw`(?=[\s,;)]|[.:](?:\s|$)|$)`;
const QUOTED = String.raw`'(?:[^']|'\\'')*'|"[^"]*"`;
const VALUED = String.raw`--(?:text|from|example|catalog|out|wait|app)\s+(?:${QUOTED}|\S+?${END})`;
const PATH = String.raw`(?:~|\.{1,2})?[\\/]\S*?${END}|[A-Za-z]:\\\S*?${END}`;
const ARG = String.raw`(?:${QUOTED}|${VALUED}|--[A-Za-z][\w-]*|<[^<>\s]+>|${PATH}|\.(?=[\s,;)]|$))`;
// The command line by name: bare, in PowerShell's `& 'busy-emulator'`, or in quotes.
const NAME = String.raw`(?:&\s+)?(?:'busy-emulator'|"busy-emulator"|busy-emulator)`;
const COMMAND = new RegExp(String.raw`(\b[Rr]un\s+)?${NAME}\s+(${COMMANDS.join("|")})(?![\w-])((?:\s+${ARG})*)`, "g");

// The command line by a path: the Node inside the app and the script, or a launcher, quoted or not.
const word = (end) => String.raw`(?:'[^']*[\\/]${end}'|"[^"]*[\\/]${end}"|[^\s'"]*[\\/]${end})`;
const BY_PATH = [
  new RegExp(String.raw`(?:&\s+)?${word(String.raw`node(?:\.exe)?`)}\s+${word(String.raw`busy-emulator\.mjs`)}`, "g"),
  new RegExp(String.raw`(?:&\s+)?${word(String.raw`busy-emulator(?:\.exe|\.mjs|\.cmd)?`)}(?![\w.-])`, "g"),
];

/** The paths of the Node and of the command line: never in a text of the window's. */
const withoutPaths = (text) => BY_PATH.reduce((out, pattern) => out.replace(pattern, "busy-emulator"), text);

/**
 * A text of the command line's, in the window's words; anything but a text is given back as it is.
 * @param {unknown} text
 * @param {{ platform?: string }} [o]  the system's: Finder or Explorer
 */
export function windowText(text, { platform = process.platform } = {}) {
  if (typeof text !== "string" || !text) return text;
  const fileManager = platform === "win32" ? "Explorer" : "Finder";
  return withoutPaths(text)
    .replace(COMMAND, (whole, verb, command, rest, offset, all) => {
      const button = buttonFor(command, rest.trim().split(/\s+/));
      // No button for it: the command as one types it, said to be for a terminal.
      if (!button) return `${verb ?? ""}busy-emulator ${command}${rest} (a terminal command)`;
      const before = all.slice(0, offset);
      const after = all.slice(offset + whole.length);
      // "by X", "X writes …": the button by name. "Run X", "then X": press it.
      if (!verb && (/\b(?:by|with)\s+$/.test(before) || /^\s+(?:writes|names|makes|fills|stops|does|says)\b/.test(after))) return button;
      const first = verb ? verb[0] === "R" : /(?:^|[.!?]\s+|\n\s*)$/.test(before);
      return `${first ? "Press" : "press"} ${button}`;
    })
    .replace(/catalog\.json in the project's folder(?! \()/g, `catalog.json in the project's folder (Show in ${fileManager} opens it)`);
}
