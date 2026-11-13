// The one place where the command line writes to its standard output and standard error (EMU-314). Everything it
// prints goes through here: its own messages and help, the server's answers it passes on, the output of busy-cli, npm
// and the compiler, the BUSY Bar's log. On the way the text's marks become ASCII (output.mjs asciiText): Windows
// PowerShell 5.1 reads a program's output in the console's code page, not UTF-8, and an agent that captured it read
// every times sign, arrow and ellipsis as nonsense. Letters stay as they are, so a path or an app's name in any script
// comes through; a mark in one (an em dash in an app's name) is written in ASCII here and exactly in --json, whose
// JSON writes every character outside ASCII as \uXXXX (asciiJson).
//
// BUSY_EMULATOR_OUTPUT=unicode writes the text as it is: the app sets it for the runs of the command line it reads
// itself (packages/app/src/cli-process.mjs cliEnvironment), whose lines its window shows as UTF-8. Like
// BUSY_EMULATOR_CLI_PATH it changes only what is printed, so a release reads it too.
import { asciiText } from "./output.mjs";

/**
 * How the text is written: as it is when `unicode` (context.mjs unicodeOutput, BUSY_EMULATOR_OUTPUT=unicode), else with
 * its marks in ASCII.
 */
export function consoleText(unicode = false) {
  return unicode ? (text) => String(text) : asciiText;
}

/** A writer of lines to `stream` (process.stdout, process.stderr): each line, then a new line. */
export function lineWriter(stream, unicode = false) {
  const text = consoleText(unicode);
  return (line) => stream.write(`${text(line)}\n`);
}
