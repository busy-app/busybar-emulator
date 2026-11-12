// What a bug report and the diagnostics archive must not carry (EMU-277): the person's home folder and user name, the
// computer's name, tokens and passwords, Wi-Fi names, serial numbers, MAC addresses and e-mail addresses. Every text
// that leaves the app for a report (the form's text, each file of the archive) goes through one scrubber, before the
// person sees it, so that what they see is what they send.
//
// The rules are by shape and by the name a value goes by, not by a list of what a log may hold: a token has the
// shapes GitHub and the common services give theirs; a Wi-Fi name and a serial are the values of fields named so
// ("ssid", "serial_number"), in JSON, in key=value and in key: value; a BUSY Bar's serial is also 24 hex digits; a MAC
// is six pairs of hex digits. What is taken out is marked: <temp>, <home>, <user>, <computer>, <token>, <hidden>, <wifi>,
// <serial>, <mac>, <email>, <github-user>, <path>.
//
// EMU-292: the GitHub login (the ones the app knows of, and any a line names as signed in), the folders of a path
// outside the home folder (on another disk, as macOS, Linux and Windows mount them, or on Windows' own disk outside
// its system's folders; and the project folders the app knows of, wherever they are), each folder as <path> with the file's name kept, and the values of a query's
// keys that look like secrets (appid=, key=, sig=, or a value of 32 hex digits or a long mix of letters and digits).
//
// Pure, so that it is tested on plain Node.

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A quoted value or a bare one, after a field's name and its colon or equals sign. */
const VALUE = String.raw`("(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[^\s"',;&}\]]+)`;

/** The value of a field of these names, whatever it is, becomes `mark` (quoted when it was). */
function byField(names, mark) {
  const re = new RegExp(String.raw`((?<![\w-])[\w-]*?(?:${names})\b["']?)(\s*[:=]\s*)${VALUE}`, "gi");
  return (text) => text.replace(re, (_all, name, sep, value) => `${name}${sep}${value.startsWith('"') ? `"${mark}"` : value.startsWith("'") ? `'${mark}'` : mark}`);
}

const TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g, // GitHub's tokens: personal, OAuth, user-to-server, server-to-server, refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,255}/g, // GitHub's fine-grained tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g, // the AI services' keys (sk-..., sk-ant-..., sk-proj-...)
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack's
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, // JSON Web Tokens
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm's
];

const SECRET_FIELDS = byField("tokens?|secrets?|passwords?|passwd|pwd|api[_-]?key|apikey|appid|access[_-]?key|private[_-]?key|credentials?|cookies?|session[_-]?id|nonce", "<hidden>");

/** Google's API keys, by their shape. */
const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;

/** A query's parameter: its key and its value. The keys whose value is secret when it is not a short word. */
const QUERY_PARAM = /([?&;][A-Za-z][\w.-]*=)([^&#\s"'<>]+)/g;
const SECRET_KEYS = /^(?:key|sig|signature|auth|code|access[_-]?id|client[_-]?id|app[_-]?key|hash|hmac)$/i;
/** A value that looks like a key whatever its parameter is called: 32 hex digits and more, or a long mix. */
function looksSecret(value) {
  if (/^[0-9A-Fa-f]{32,}$/.test(value)) return true;
  return value.length >= 32 && /^[\w.~%+/=-]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value) && !/^[\w-]+(?:\.[\w-]+)+$/.test(value);
}
function scrubQuery(text) {
  return text.replace(QUERY_PARAM, (all, key, value) => {
    if (value.startsWith("<")) return all;
    const name = key.slice(1, -1);
    if (looksSecret(value) || (SECRET_KEYS.test(name) && value.length >= 12)) return `${key}<hidden>`;
    return all;
  });
}

/** What a GitHub login may be (gh.mjs LOGIN). */
const LOGIN = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})`;
/** The places a line names a GitHub login: the app's own log lines, the command line's and GitHub CLI's. */
const LOGIN_PLACES = [
  new RegExp(String.raw`(\bsigned in (?:to GitHub )?as @?)(${LOGIN})(?![\w-])`, "gi"),
  new RegExp(String.raw`(\bGitHub CLI's account @?)(${LOGIN})(?![\w-])`, "gi"),
  new RegExp(String.raw`(\bGitHub CLI uses @?)(${LOGIN})(?![\w-])`, "gi"),
  new RegExp(String.raw`(\bLogged in to github\.com (?:account|as) @?)(${LOGIN})(?![\w-])`, "gi"),
  new RegExp(String.raw`(\bit uses @?)(${LOGIN})(?=\))`, "gi"),
  new RegExp(String.raw`("(?:login|previous|account)"\s*:\s*")(${LOGIN})(?=")`, "gi"),
];
/** Words those places may hold that are not a login. */
const NOT_LOGINS = new Set(["the", "a", "an", "another", "one", "it", "you", "someone", "github", "null", "true", "false"]);

/** The GitHub logins `text` names as signed in, by the places above. */
export function loginsIn(text) {
  const found = new Set();
  for (const re of LOGIN_PLACES) for (const match of String(text ?? "").matchAll(re)) if (!NOT_LOGINS.has(match[2].toLowerCase())) found.add(match[2]);
  return [...found];
}

// A path's folders, each as <path>, the file's name kept. A folder's name may hold spaces when a separator follows it;
// the last name is the file's when it has an extension, else it is a folder's too.
const SEP = String.raw`[\\/]+`;
const NAME = String.raw`[^\\/\s"'<>|:*?]+`;
const INNER = String.raw`${NAME}(?: ${NAME})*`;
const LAST = String.raw`[^\\/\s"'<>|:*?,;()\[\]{}]+`;
const TAIL = String.raw`((?:${SEP}${INNER}(?=${SEP}))*)(${SEP}${LAST})?`;
function maskFolders(tail, last) {
  let out = tail.replace(new RegExp(String.raw`(${SEP})(${INNER})`, "g"), (_all, sep) => `${sep}<path>`);
  if (last) {
    const [, sep, name] = last.match(new RegExp(String.raw`^(${SEP})(.*)$`, "s"));
    out += `${sep}${/[^.]\.[A-Za-z0-9]{1,8}$/.test(name) ? name : "<path>"}`;
  }
  return out;
}
/** Folders on another disk than the system's, by the place disks are mounted at; on Windows any letter's but the system's own folders. */
const MOUNTED = new RegExp(String.raw`(?<![\w.<>-])(/Volumes|/mnt|/media|/run/media)(?=/)${TAIL}`, "g");
const DRIVE = new RegExp(String.raw`(?<![\w<>])([A-Za-z]:)(?=${SEP}(?!(?:Users|Windows|Program Files|Program Files \(x86\)|ProgramData)(?:\\|/|$|[\s"']))${NAME})${TAIL}`, "gi");

const WIFI_FIELDS = byField("ssid|wifi[_ -]?name|wifi[_ -]?network|network[_ -]?name|ap[_ -]?name", "<wifi>");
const SERIAL_FIELDS = byField("serial(?:[_ -]?(?:number|no))?|sn", "<serial>");

/**
 * @param {object} [o]
 * @param {string|null} [o.home]  the person's home folder, as the system names it
 * @param {string|null} [o.user]  their user name on this computer
 * @param {string|null} [o.host]  the computer's name
 * @param {string[]} [o.wifi]     Wi-Fi names the app knows of, taken out wherever they stand
 * @param {string[]} [o.temp]     the system's temporary folders
 * @param {string[]} [o.logins]   GitHub logins the app knows of (its sign-in's note), taken out wherever they stand
 * @param {string[]} [o.projects] project folders the app knows of: their folders go as <path>, outside the home folder
 * @returns {(text: string) => string}
 */
export function createScrubber({ home = null, user = null, host = null, wifi = [], temp = [], logins = [], projects = [] } = {}) {
  // A folder as written with either separator, and with the separators doubled as JSON writes a Windows path. One
  // class for the separators: an alternation of \\ and \ takes exponential time on a long run of backslashes.
  const folderPattern = (folder) => {
    const bare = folder.replace(/[\\/]+$/, "");
    const parts = bare.split(/[\\/]+/);
    // A folder that starts with a separator (a Unix path): the match starts at the first one of a run, not at each
    // of them, or a long run of slashes takes quadratic time.
    return new RegExp((/^[\\/]/.test(bare) ? String.raw`(?<![\\/])` : "") + parts.map(escape).join(SEP) + String.raw`(?![\w.-])`, "gi");
  };
  const homes = [];
  if (typeof home === "string" && home.replace(/[\\/]+$/, "").length > 1) homes.push(folderPattern(home));
  // The system's temporary folder (os.tmpdir(), %TEMP%, and its real path): on macOS its name carries an id of the
  // account; on Windows it is inside the home. Longest first, so that /private/var/... goes before /var/...
  const temps = [...new Set(temp.filter((one) => typeof one === "string" && one.replace(/[\\/]+$/, "").length > 3))]
    .sort((a, b) => b.length - a.length)
    .map(folderPattern);
  const words = [];
  if (typeof user === "string" && user.length >= 3) words.push([new RegExp(String.raw`(?<![\w.-])${escape(user)}(?![\w-])`, "gi"), "<user>"]);
  if (typeof host === "string" && host) {
    const name = host.replace(/\.local$/i, "");
    for (const one of new Set([host, name])) if (one.length >= 3) words.push([new RegExp(String.raw`(?<![\w.-])${escape(one)}(?![\w-])`, "gi"), "<computer>"]);
  }
  const networks = wifi.filter((one) => typeof one === "string" && one.length >= 2).map((one) => new RegExp(escape(one), "g"));
  const bareHome = typeof home === "string" ? home.replace(/[\\/]+$/, "") : "";
  const inHome = (folder) => bareHome.length > 1 && (folder.toLowerCase() === bareHome.toLowerCase() || /^[\\/]/.test(folder.slice(bareHome.length)) && folder.toLowerCase().startsWith(bareHome.toLowerCase()));
  // A project's folder outside the home folder (one inside goes as <home>/...), longest first.
  const roots = [...new Set(projects.filter((one) => typeof one === "string" && one.replace(/[\\/]+$/, "").length > 3 && !inHome(one.replace(/[\\/]+$/, ""))).map((one) => one.replace(/[\\/]+$/, "")))]
    .sort((a, b) => b.length - a.length)
    .map((root) => {
      const drive = /^[A-Za-z]:/.test(root) ? root.slice(0, 2) : "";
      const parts = root.slice(drive.length).split(/[\\/]+/).filter(Boolean);
      return { drive, re: new RegExp(String.raw`(?<![\w.-${drive ? "" : "\\\\/"}])${escape(drive)}${parts.map((part) => SEP + escape(part)).join("")}(?![\w.-])${TAIL}`, "gi") };
    });
  const knownLogins = logins.filter((one) => typeof one === "string" && new RegExp(`^${LOGIN}$`).test(one));

  return function scrub(text) {
    let out = String(text ?? "");
    // The GitHub logins: the ones the app knows of and the ones the text names, wherever they stand; a name shorter
    // than three letters only where it is named.
    const named = new Set([...knownLogins, ...loginsIn(out)].map((one) => one.toLowerCase()));
    for (const re of LOGIN_PLACES) out = out.replace(re, (_all, place, login) => (NOT_LOGINS.has(login.toLowerCase()) ? _all : `${place}<github-user>`));
    for (const login of [...named].filter((one) => one.length >= 3).sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(String.raw`(?<![\w.<-])${escape(login)}(?![\w>-])`, "gi"), "<github-user>");
    // Secrets first: a token in a path or an address goes as a token.
    for (const re of TOKENS) out = out.replace(re, "<token>");
    out = out.replace(GOOGLE_KEY, "<token>");
    out = out.replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token)\s+)?[^\s"',;]+/gi, (_all, name, scheme) => `${name}${scheme ? `${scheme} ` : ""}<token>`);
    out = out.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi, "$1<hidden>@");
    out = SECRET_FIELDS(out);
    out = scrubQuery(out);
    // Networks, serials, MACs, e-mail addresses.
    for (const re of networks) out = out.replace(re, "<wifi>");
    out = WIFI_FIELDS(out);
    out = out.replace(/\b(wi-?fi|network|ssid)(\s+(?:named|called|name)?\s*)"[^"\n]{1,64}"/gi, '$1$2"<wifi>"');
    out = SERIAL_FIELDS(out);
    out = out.replace(/\b[0-9A-Fa-f]{24}\b/g, "<serial>");
    out = out.replace(/\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g, "<mac>");
    out = out.replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "<email>");
    // The temporary folder (any account's on macOS: /var/folders/<xx>/<id>/T), the home folder, then any other
    // person's folder under Users or home, then the names.
    for (const re of temps) out = out.replace(re, "<temp>");
    out = out.replace(/(?:\/private)?\/var\/folders\/[\w+-]{2}\/[\w+-]+\/T(?![\w.-])/g, "<temp>");
    for (const re of homes) out = out.replace(re, "<home>");
    out = out.replace(/(\/Users\/|\/home\/)(?!Shared\b)[^/\s"':]+/g, "$1<user>");
    out = out.replace(/(\b[A-Za-z]:[\\/]+Users[\\/]+)(?!Public\b)[^\\/\s"':]+/gi, "$1<user>");
    // Folders outside the home folder: the projects the app knows of, then any on another disk.
    for (const { drive, re } of roots) out = out.replace(re, (all, tail, last) => `${drive}${maskFolders(all.slice(drive.length, all.length - (tail?.length ?? 0) - (last?.length ?? 0)), null)}${maskFolders(tail ?? "", last ?? null)}`);
    out = out.replace(MOUNTED, (_all, mount, tail, last) => `${mount}${maskFolders(tail ?? "", last ?? null)}`);
    out = out.replace(DRIVE, (_all, drive, tail, last) => `${drive}${maskFolders(tail ?? "", last ?? null)}`);
    for (const [re, mark] of words) out = out.replace(re, mark);
    return out;
  };
}
