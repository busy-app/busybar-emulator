// JSON as the firmware's cJSON prints it (lib/cjson/cJSON.c, version 1.7.18): cJSON_Print(), the form with tabs that
// the firmware gives for an app's settings document (setting_provider.c, save_document and storage_flush_json).

/**
 * What cJSON_Print() makes of a value parsed from JSON: an object's items each on a line of their own, indented by
 * tabs, as "key":<tab>value; an array's items on one line, apart by ", "; an empty object "{\n}" (with the tabs of its
 * depth before the brace). Strings are escaped as JSON.stringify escapes them, which for a string parsed from JSON is
 * what print_string_ptr() does: \" \\ \b \f \n \r \t, other characters below 0x20 as \u00xx, the rest as they are.
 */
export function cjsonPrint(value, depth = 0) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return cjsonNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => cjsonPrint(item, depth + 1)).join(", ")}]`;
  const tabs = "\t".repeat(depth + 1);
  const items = Object.entries(value).map(([key, item]) => `${tabs}${JSON.stringify(key)}:\t${cjsonPrint(item, depth + 1)}`);
  return `{\n${items.map((item, i) => `${item}${i < items.length - 1 ? "," : ""}\n`).join("")}${"\t".repeat(depth)}}`;
}

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
const DBL_EPSILON = 2.220446049250313e-16;

/**
 * print_number(): "%d" when the number equals its valueint (the number cut to an int, held at INT_MIN..INT_MAX);
 * otherwise "%1.15g", or "%1.17g" if the 15 digits do not give the number back (compare_double). NaN and the
 * infinities, which JSON cannot hold, are "null".
 */
export function cjsonNumber(d) {
  if (!Number.isFinite(d)) return "null";
  const valueint = d >= INT_MAX ? INT_MAX : d <= INT_MIN ? INT_MIN : Math.trunc(d);
  if (d === valueint) return String(valueint);
  const short = formatG(d, 15);
  const back = Number(short);
  return Math.abs(back - d) <= Math.max(Math.abs(back), Math.abs(d)) * DBL_EPSILON ? short : formatG(d, 17);
}

/**
 * C's "%.<p>g": the exponent X the "%e" form would have; exponential if X < -4 or X >= p, else fixed with p-1-X
 * decimals; trailing zeros and a trailing point dropped; the exponent signed and of at least two digits. C rounds a
 * tie to even and JavaScript up; a tie needs a number whose exact binary value ends in a 5 at the 16th or 18th digit,
 * which a setting does not hold.
 */
function formatG(d, p) {
  const [mantissa, exponent] = d.toExponential(p - 1).split("e");
  const x = Number(exponent);
  const trim = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
  if (x < -4 || x >= p) return `${trim(mantissa)}e${x < 0 ? "-" : "+"}${String(Math.abs(x)).padStart(2, "0")}`;
  return trim(d.toFixed(p - 1 - x));
}
