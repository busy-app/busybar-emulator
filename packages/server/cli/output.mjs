// What the command line prints and how it ends (ADR-0010): with --json one line of JSON on stdout, otherwise text
// for a person; exit code 0 — done, 1 — the operation failed, 2 — a wrong call.

export const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2 });

/**
 * JSON with every character outside ASCII written as \uXXXX: the same value for any reader of JSON, and the same
 * bytes in any code page. PowerShell 5.1 reads a program's output in the console's code page (cp866, cp1251, cp1252),
 * and a path with Cyrillic letters printed as UTF-8 came back broken from ConvertFrom-Json (EMU-249, Windows 10).
 */
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A failure with a code an agent can act on, a message saying what happened and a hint saying what to do. */
export class CliError extends Error {
  constructor(code, message, hint = null, extra = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.extra = extra;
  }
}

export function unknownCommand(name, self) {
  return new CliError("unknown_command", `There is no command ${JSON.stringify(name)}.`, `Run ${self} help to see the commands.`, { argument: name });
}

/** The codes of a wrong call; every other failure exits with 1. */
const USAGE_CODES = new Set(["usage", "unknown_command"]);

export function exitCodeOf(code) {
  return USAGE_CODES.has(code) ? EXIT.usage : EXIT.failed;
}

/** A word of a POSIX shell: as it is when it needs no quotes, otherwise in single quotes. */
export function posixWord(text) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A word of PowerShell: in single quotes, a quote inside doubled. */
export function powershellWord(text) {
  return `'${text.replace(/'/g, "''")}'`;
}

/** A word of cmd.exe: a Windows path has no quotes in it, so double quotes are enough. */
export function cmdWord(text) {
  return /[\s&()^%!<>|,;=]/.test(text) ? `"${text}"` : text;
}

/**
 * A Windows path that runs unquoted, with forward slashes, in PowerShell, Git Bash and cmd alike (the same rule as
 * the first run's text for agents, legacy-window/welcome.js): a drive, then names of letters, digits, `_`, `.`, `-`.
 */
const ANY_SHELL_PATH = /^[A-Za-z]:[\\/](?:[\p{L}\p{N}_.-]+[\\/])*[\p{L}\p{N}_.-]+$/u;

/** A word of Git Bash: a Windows path with forward slashes, quoted as a POSIX shell needs it. */
function gitBashWord(text) {
  return posixWord(/^[A-Za-z]:\\/.test(text) ? text.replace(/\\/g, "/") : text);
}

/**
 * How to run the command again from each shell of the system, for a person or an agent to paste. On Windows `any`
 * is the one form for PowerShell, Git Bash and cmd when every word has one (null otherwise), then each shell's own.
 */
export function pasteForms(words, platform) {
  if (platform === "win32") {
    const any = words.every((word) => ANY_SHELL_PATH.test(word)) ? words.map((word) => word.replace(/\\/g, "/")).join(" ") : null;
    return { any, powershell: `& ${words.map(powershellWord).join(" ")}`, bash: words.map(gitBashWord).join(" "), cmd: words.map(cmdWord).join(" ") };
  }
  return { sh: words.map(posixWord).join(" ") };
}

/** The one way to call the command again that the texts name: on Windows the form for every shell, else PowerShell's. */
export function selfCall(forms) {
  return forms.sh ?? forms.any ?? forms.powershell;
}

/** The lines that tell how to call this command, for help and version. */
export function selfLines(forms) {
  if (forms.sh) return [`This command: ${forms.sh}`];
  if (forms.any) return [`This command, in PowerShell, Git Bash and cmd: ${forms.any}`];
  return [`This command, in PowerShell: ${forms.powershell}`, `In Git Bash: ${forms.bash}`, `In cmd: ${forms.cmd}`];
}

/**
 * Prints the result of a command and gives its exit code.
 * @param {{ ok: true, command: string, data: object, text: string } | { ok: false, command: string, error: CliError }} result
 */
export function emit(result, { json, out, err }) {
  if (result.ok) {
    if (json) out(asciiJson({ ok: true, command: result.command, ...result.data }));
    else if (result.text) out(result.text);
    return EXIT.ok;
  }
  const { error } = result;
  if (json) {
    out(asciiJson({ ok: false, command: result.command, code: error.code, message: error.message, hint: error.hint, ...error.extra }));
  } else {
    err(`busy-emulator: ${error.message}${error.hint ? `\n${error.hint}` : ""}`);
  }
  return exitCodeOf(error.code);
}
