// Names in the built package that a BUSY Bar would not unpack as they are named (EMU-347). The BUSY Bar's unpacker
// (microtar, ../tar.mjs) reads the first 100 bytes of a header's name field and nothing else: not the ustar prefix
// (microtar.c:205), not a PAX or GNU long-name header (skipped with "not extracting unsupported type",
// tar_archive.c:483). A packer writes a path that does not fit into 100 bytes as a ustar prefix when a "/" splits it
// (bsdtar: at most 155 bytes of prefix, then at most 100 of name), and as a PAX header with the whole path when not;
// a name outside ASCII also gets a PAX header. Either way the file reaches the bar under the short name, or a name in
// another encoding. What a bar ends up with for each is not measured yet, so these are warnings, not failures.
// Reads the package of `readPackage` (./package-file.mjs); nothing is written or run.
import { fitsPlainTar, partsOf } from "./package-file.mjs";

/** The most a path may take for the BUSY Bar to unpack it as named: its name field. */
export const MOST_NAME_BYTES = 100;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** "a", "a and b", "a, b and 2 more". */
function list(names, most = 3) {
  const shown = names.slice(0, most).map((name) => `"${name}"`);
  return names.length > most ? `${shown.join(", ")} and ${names.length - most} more` : shown.join(" and ");
}

/**
 * The warnings for a package: [{ id, message, fix, found }], empty when every path is printable ASCII of at most 100
 * bytes. `fix` follows "Change: " in the text.
 * @param {{ entries: { name: string, kind: string }[] } | null} pkg  readPackage's answer
 */
export function packageNameWarnings(pkg) {
  if (!pkg || pkg.unreadable || pkg.tooLarge) return [];
  const warnings = [];
  const paths = pkg.entries.map((entry) => ({ path: partsOf(entry.name).join("/"), folder: entry.kind === "folder" }));
  const notAscii = paths.filter((one) => !PRINTABLE_ASCII.test(one.path));
  if (notAscii.length) {
    warnings.push({
      id: "package_name_not_ascii",
      message: `${list(notAscii.map((one) => one.path))} ${notAscii.length === 1 ? "has" : "have"} characters outside ASCII: the packer writes such a name into a PAX header, which the BUSY Bar skips, and the file reaches the BUSY Bar under another name or none.`,
      fix: "rename it to ASCII under 100 characters (letters, digits, - _ . and /), in src/ and wherever the app names it.",
      found: notAscii.map((one) => one.path),
    });
  }
  const long = paths.filter((one) => PRINTABLE_ASCII.test(one.path) && Buffer.byteLength(one.folder ? `${one.path}/` : one.path) > MOST_NAME_BYTES);
  if (long.length) {
    const split = long.filter((one) => fitsPlainTar(one.path, one.folder));
    const how =
      split.length === long.length
        ? "the packer splits such a path into a ustar prefix, which the BUSY Bar does not read, so the file lands without its folders"
        : split.length
          ? "the packer splits such a path into a ustar prefix (which the BUSY Bar does not read) or writes it into a PAX header (which it skips), so the file lands without its folders or under another name"
          : "the packer writes such a path into a PAX header, which the BUSY Bar skips, so the file reaches the BUSY Bar under another name";
    warnings.push({
      id: "package_name_too_long",
      message: `${list(long.map((one) => one.path))} ${long.length === 1 ? "is" : "are"} longer than ${MOST_NAME_BYTES} characters, which is all of a path the BUSY Bar reads: ${how}.`,
      fix: "shorten its folders and name so the whole path, from the app id, is at most 100 characters: rename it to ASCII under 100 characters.",
      found: long.map((one) => one.path),
    });
  }
  return warnings;
}
