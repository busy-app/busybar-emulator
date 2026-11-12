// The words of a command line, checked against what the command takes, so that a word it does not know is a wrong
// call and not something passed over in silence. The server's command line (index.mjs), the comparison suites in
// emulator/test/ and the benchmark in capture/ check their words here before they do anything.
//
// A command names what it takes: options followed by a value (--port 8640), options alone (--fast), options whose
// value may be left out (--bar, or --bar 10.0.4.20), and the words that are not options. --help (and -h) is always
// known: it prints the command's help and ends with exit code 0. Everything else is a wrong call: one line on stderr
// that names the word and how to get the help, and exit code 2. The command's own code then reads its options as it
// always has; it never sees a word that was not checked.
//
// Nothing here reads the process's arguments or environment (test/server/imports.test.mjs): the command hands its
// own arguments over (argv, as Node gives them).
import { readFileSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export class UsageError extends Error {}

/**
 * Checks the words of a command line: its arguments without Node and the script.
 * @param {string[]} words
 * @param {object} spec
 * @param {string[]} [spec.values]     options followed by a value; a value never starts with "--"
 * @param {string[]} [spec.flags]      options that stand alone
 * @param {string[]} [spec.optional]   options whose value may be left out: the next word is theirs unless it starts with "-"
 * @param {boolean|string[]} [spec.positionals]  words that are not options: none (the default), any (true), or these
 * @param {boolean} [spec.version]     --version is known
 * @returns {{ help: boolean, version: boolean }}
 * @throws {UsageError} with the problem, said in a few words
 */
export function checkArguments(words, { values = [], flags = [], optional = [], positionals = false, version = false } = {}) {
  let help = false;
  let wantsVersion = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === "--help" || word === "-h") help = true;
    else if (version && word === "--version") wantsVersion = true;
    else if (values.includes(word)) {
      const value = words[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${word} needs a value`);
      i++;
    } else if (optional.includes(word)) {
      if (words[i + 1] !== undefined && !words[i + 1].startsWith("-")) i++;
    } else if (flags.includes(word)) {
      // nothing to take
    } else if (word.startsWith("-")) {
      const [name, ...rest] = word.split("=");
      if (rest.length && [...values, ...optional].includes(name)) throw new UsageError(`${word}: put the value after a space, ${name} ${rest.join("=")}`);
      throw new UsageError(`unknown option ${word}`);
    } else if (positionals === true || (Array.isArray(positionals) && positionals.includes(word))) {
      // a word the command takes
    } else {
      throw new UsageError(Array.isArray(positionals) ? `unknown argument ${word} (it takes ${positionals.join(", ")})` : `unexpected argument ${word}`);
    }
  }
  return { help, version: wantsVersion };
}

/** The comment at the top of a script, without its "//": what --help prints when the command has no help of its own. */
export function headerComment(file) {
  const lines = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!lines.length && line.startsWith("#!")) continue;
    if (!line.startsWith("//")) break;
    lines.push(line.replace(/^\/\/ ?/, ""));
  }
  return lines.join("\n");
}

/** How to run the script again from the current folder, as one can paste it into any shell. */
export function runAgain(script) {
  const near = relative(process.cwd(), script);
  const path = near && !near.startsWith("..") && !isAbsolute(near) ? near : script;
  return `node ${/[\s"]/.test(path) ? `"${path}"` : path}`;
}

/** Writes `text` and ends the process with `code` once the text is out (a pipe on macOS takes it later). */
async function finish(stream, text, code) {
  await new Promise((resolve) => stream.write(`${text}\n`, resolve));
  process.exit(code);
}

/** Whether `error` is a refused connection to this computer; then its address. */
function refusedHere(error) {
  // The error itself, what it was caused by (fetch's "fetch failed", a suite's own message around it), and each
  // attempt of a connection that tried more than one address.
  const causes = [];
  for (let e = error; e && causes.length < 10; e = e.cause) causes.push(e, ...(Array.isArray(e.errors) ? e.errors : []));
  const refused = causes.find((e) => e?.code === "ECONNREFUSED" && typeof e.port === "number");
  if (!refused || !/^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(refused.address ?? "")) return null;
  return `${refused.address.includes(":") ? `[${refused.address}]` : refused.address}:${refused.port}`;
}

/**
 * The command line of a script: checks its words, prints the help or the wrong call and ends the process, or returns
 * what checkArguments found.
 * @param {string[]} argv  the script's arguments as Node gives them: Node, the script, then the words
 * @param {object} spec    what checkArguments takes, and:
 * @param {string|(() => string)} [spec.help]      the help; the script's header comment without it
 * @param {() => string} [spec.versionText]        what --version prints (and --version is known)
 * @param {string} [spec.emulator]  the option that names the address of the emulator the script talks to: when nothing
 *   answers there, the script ends with one line that says what it needs (exit code 1), not a trace
 */
export async function commandLine(argv, spec = {}) {
  const [, script, ...words] = argv;
  const name = basename(script);
  let call;
  try {
    call = checkArguments(words, { ...spec, version: Boolean(spec.versionText) });
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    await finish(process.stderr, `${name}: ${error.message}. ${runAgain(script)} --help lists what it takes.`, 2);
  }
  if (call.help) await finish(process.stdout, typeof spec.help === "function" ? spec.help() : (spec.help ?? headerComment(script)), 0);
  if (call.version) await finish(process.stdout, spec.versionText(), 0);
  if (spec.emulator) {
    // A monitor sees the error before Node prints it; any other error is printed as Node always does.
    process.on("uncaughtExceptionMonitor", (error) => {
      const address = refusedHere(error);
      if (!address) return;
      const start = runAgain(join(here, "index.mjs"));
      try {
        writeSync(2, `${name}: nothing answers at ${address}, and the test needs an emulator there. Start one (${start} --port <port> --data <folder>) or name a running one with ${spec.emulator} <host:port>.\n`);
      } finally {
        process.exit(1);
      }
    });
  }
  return call;
}
