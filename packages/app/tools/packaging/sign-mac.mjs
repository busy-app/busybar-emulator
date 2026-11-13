// The release's macOS signature (EMU-204): Developer ID with the hardened runtime, Apple's notarization and the stapled
// ticket, so that an app downloaded from GitHub opens at once, with no Gatekeeper block. Only a release is signed this
// way, and only when the build is given an identity (dist.mjs build --mac-identity, --notary-profile; npm run release
// passes release.json's): the test variant and a build for development keep the ad hoc signature and need no
// certificate.
//
// The order, as proven by hand on 0.1.0-beta.3: every program is signed inside out, without --deep (codesign --deep
// does not sign code in Contents/Resources, and gives every program the same options without saying so); the app is
// zipped and notarized, its ticket stapled; the zip of the release is made again from the stapled app (a zip cannot
// carry a ticket of its own); the disk image is made from the stapled app, signed, notarized and stapled.
//
// What the signature needs from this Mac: the identity's certificate and key in the login keychain (security
// find-identity -v -p codesigning lists it) and a notarytool profile in the keychain (xcrun notarytool
// store-credentials). Nothing secret passes through here: notarytool reads its profile itself.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The entitlements of every program in the signed app; the file says why each one is there. */
export const ENTITLEMENTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "entitlements.mac.plist");

/** A Developer ID Application identity as codesign takes it, team in brackets at the end. */
const IDENTITY = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/;

/** The team of an identity name ("Developer ID Application: Name (TEAMID1234)"), or null when it is not one. */
export function teamOf(identity) {
  return IDENTITY.exec(String(identity ?? "").trim())?.[1] ?? null;
}

/** What is wrong with the signing settings of a build, or null. A release is signed with both, or with neither. */
export function signingProblem({ identity = null, profile = null } = {}) {
  if (!identity && !profile) return null;
  if (!identity) return "a notary profile was given without a signing identity";
  if (!profile) return "a signing identity was given without a notary profile (xcrun notarytool store-credentials makes one)";
  if (!teamOf(identity)) return `"${identity}" is not a Developer ID Application identity ("Developer ID Application: Name (TEAMID)")`;
  return null;
}

const MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);

/** Whether a file is a Mach-O program or library, by its first bytes. A universal binary counts; a Java class does not. */
export function isMachO(file) {
  const bytes = Buffer.alloc(8);
  let fd;
  try {
    fd = openSync(file, "r");
    if (readSync(fd, bytes, 0, 8, 0) < 8) return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const magic = bytes.readUInt32BE(0);
  if (MACHO.has(magic)) return true;
  // 0xcafebabe opens both a universal binary (then the number of architectures, a few) and a Java class (then its
  // version, 45 or more).
  if (magic === 0xcafebabe || magic === 0xcafebabf) return bytes.readUInt32BE(4) > 0 && bytes.readUInt32BE(4) < 20;
  return false;
}

const BUNDLE = /\.(app|framework|xpc)$/;

/** The main executable of a bundle: Contents/MacOS/<CFBundleExecutable> of an app, Versions/<Current>/<name> of a framework. */
export function mainExecutableOf(bundle, readPlist = defaultReadPlist) {
  if (bundle.endsWith(".framework")) {
    const versions = path.join(bundle, "Versions");
    let current = "A";
    try {
      current = readlinkSync(path.join(versions, "Current"));
    } catch {
      // A framework without the link: version A, as Electron's are.
    }
    return path.join(versions, current, path.basename(bundle, ".framework"));
  }
  const info = path.join(bundle, "Contents", "Info.plist");
  const name = existsSync(info) ? readPlist(info).CFBundleExecutable : null;
  return name ? path.join(bundle, "Contents", "MacOS", name) : null;
}

function defaultReadPlist(file) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" }));
}

/**
 * Every piece of code in an app, found by reading the files (links are not followed): the Mach-O files, wherever they
 * lie (a native module added later is found too), and the bundles. `order` is the order of signing, inside out: a
 * program that is no bundle's main executable is signed on its own; a bundle after everything inside it (its main
 * executable is signed with it); the app last.
 * @returns {{ machO: string[], order: { path: string, bundle: boolean }[] }}
 */
export function codeOf(app, { readPlist = defaultReadPlist } = {}) {
  const machO = [];
  const bundles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (BUNDLE.test(entry.name)) bundles.push(p);
        walk(p);
      } else if (entry.isFile() && isMachO(p)) {
        machO.push(p);
      }
    }
  };
  walk(app);
  const mains = new Set([app, ...bundles].map((b) => mainExecutableOf(b, readPlist)).filter(Boolean));
  const depth = (p) => p.split(path.sep).length;
  const order = [...machO.filter((f) => !mains.has(f)).map((p) => ({ path: p, bundle: false })), ...bundles.map((p) => ({ path: p, bundle: true }))];
  order.sort((a, b) => depth(b.path) - depth(a.path) || Number(a.bundle) - Number(b.bundle) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  order.push({ path: app, bundle: true });
  for (const main of mains) if (!existsSync(main) || !lstatSync(main).isFile()) throw new Error(`${path.relative(path.dirname(app), main)}: a bundle's main executable is not there`);
  return { machO: machO.sort(), order };
}

const run = (program, args, options = {}) => execFileSync(program, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
/** What a program said when it failed: its error output, else its message. */
const said = (e) => String(e?.stderr || e?.stdout || e?.message || e).trim();

/**
 * Signs every piece of code in the app with the identity, the hardened runtime, a secure timestamp and the
 * entitlements, inside out; then codesign --verify --deep --strict. `exec` is for tests.
 * @returns {{ signed: number, machO: number }}
 */
export function signMacApp(app, { identity, entitlements = ENTITLEMENTS, exec = run, log = () => {} }) {
  const { machO, order } = codeOf(app);
  log(`signing ${order.length} pieces of code (${machO.length} Mach-O files) as ${identity}`);
  for (const item of order) {
    try {
      exec("/usr/bin/codesign", ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, item.path]);
    } catch (e) {
      throw new Error(`codesign could not sign ${path.relative(path.dirname(app), item.path)}: ${said(e)}`);
    }
  }
  exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  return { signed: order.length, machO: machO.length };
}

/** Signs a disk image with the identity and a secure timestamp (a disk image has no runtime or entitlements). */
export function signDmg(dmg, { identity, exec = run }) {
  exec("/usr/bin/codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
  exec("/usr/bin/codesign", ["--verify", "--strict", dmg]);
}

/** The last JSON object a program printed. */
function lastJson(text) {
  const lines = String(text).trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim().startsWith("{")) continue;
    try {
      return JSON.parse(lines.slice(i).join("\n"));
    } catch {
      // An earlier line.
    }
  }
  return null;
}

/**
 * Sends a file (a zip of the app, or the disk image) to Apple's notary service and waits for its answer. Anything but
 * Accepted fails the build, with the issues of the service's log.
 * @returns {{ id: string, status: string }}
 */
export function notarize(file, { profile, exec = run, log = () => {} }) {
  log(`notarizing ${path.basename(file)} (notarytool, profile ${profile}); Apple answers in a few minutes`);
  let out;
  try {
    out = exec("/usr/bin/xcrun", ["notarytool", "submit", file, "--keychain-profile", profile, "--wait", "--timeout", "1h", "--output-format", "json"], { maxBuffer: 1 << 24 });
  } catch (e) {
    const answer = lastJson(e?.stdout);
    if (!answer?.id) throw new Error(`notarytool could not submit ${path.basename(file)}: ${said(e)}`);
    out = e.stdout;
  }
  const answer = lastJson(out) ?? {};
  if (answer.status === "Accepted") {
    log(`${path.basename(file)}: Accepted, submission ${answer.id}`);
    return { id: answer.id, status: answer.status };
  }
  let issues = "";
  if (answer.id) {
    try {
      const report = lastJson(exec("/usr/bin/xcrun", ["notarytool", "log", answer.id, "--keychain-profile", profile], { maxBuffer: 1 << 24 }));
      issues = (report?.issues ?? []).slice(0, 12).map((i) => `\n    ${i.path ?? ""}: ${i.message ?? ""}`).join("");
    } catch (e) {
      issues = `\n    (its log could not be read: ${said(e)})`;
    }
  }
  throw new Error(`Apple's notary service did not accept ${path.basename(file)}: ${answer.status ?? "no answer"}${answer.id ? `, submission ${answer.id}` : ""}${answer.message ? ` (${answer.message})` : ""}${issues}`);
}

/**
 * Staples the ticket to the app or the disk image and validates it. Right after Accepted the ticket may not be
 * served yet, so stapling is tried a few times. `sleep` is for tests.
 */
export function staple(file, { exec = run, attempts = 6, waitMs = 20_000, sleep = sleepSync, log = () => {} }) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      exec("/usr/bin/xcrun", ["stapler", "staple", file]);
      exec("/usr/bin/xcrun", ["stapler", "validate", file]);
      return;
    } catch (e) {
      last = e;
      if (i < attempts) {
        log(`stapling ${path.basename(file)} failed (${said(e).split("\n").pop()}); again in ${waitMs / 1000} s`);
        sleep(waitMs);
      }
    }
  }
  throw new Error(`The ticket could not be stapled to ${path.basename(file)}: ${said(last)}`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------- the checks

/** What codesign -dv says of one piece of code: authorities, team, flags, timestamp (codesign writes it on stderr). */
export function signatureDetails(file, exec = run) {
  const text = String(exec("/bin/sh", ["-c", '/usr/bin/codesign -dv --verbose=2 "$0" 2>&1 || true', file]));
  return {
    authorities: [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1]),
    team: /^TeamIdentifier=(\S+)$/m.exec(text)?.[1] ?? null,
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/m.test(text),
    timestamp: /^Timestamp=/m.test(text),
    adhoc: /^Signature=adhoc$/m.test(text),
  };
}

/** A check run: ok, and its last lines (spctl and stapler say what they found on stderr). */
function tool(program, args, exec = run) {
  try {
    const out = exec("/bin/sh", ["-c", '"$0" "$@" 2>&1', program, ...args]);
    return { ok: true, said: String(out).trim() };
  } catch (e) {
    return { ok: false, said: said(e) };
  }
}

/**
 * stapler validate asks Apple's ticket service (CloudKit) over the network: a lost connection makes it fail with
 * Error 68 though the ticket is there. It is asked again a few times before the answer counts. `sleep` is for tests.
 */
export function validateTicket(file, { exec = run, attempts = 4, waitMs = 15_000, sleep = sleepSync } = {}) {
  let result;
  for (let i = 1; i <= attempts; i++) {
    result = tool("/usr/bin/xcrun", ["stapler", "validate", file], exec);
    if (result.ok) return { ...result, attempts: i };
    if (i < attempts) sleep(waitMs);
  }
  return { ...result, attempts };
}

const lastLines = (text, n = 3) => text.split("\n").filter(Boolean).slice(-n).join(" | ");

/**
 * The checks of a Developer ID signed and notarized app, each one line in `results`: every Mach-O file in it signed
 * by Developer ID Application with the hardened runtime and a secure timestamp, all by the app's team; codesign
 * --verify --deep --strict; the stapled ticket; Gatekeeper's assessment (accepted, source=Notarized Developer ID).
 * @returns {{ problems: string[], results: object }}
 */
export function signedAppProblems(app, { team = null, exec = run, sleep = sleepSync } = {}) {
  const problems = [];
  const results = {};
  const appSignature = signatureDetails(app, exec);
  const want = team ?? appSignature.team;
  results.team = appSignature.team;
  const { machO } = codeOf(app);
  const nested = [];
  for (const file of machO) {
    const s = signatureDetails(file, exec);
    const where = path.relative(app, file);
    const wrong = [];
    if (!s.authorities[0]?.startsWith("Developer ID Application:")) wrong.push(`signed by ${s.authorities[0] ?? (s.adhoc ? "no one (ad hoc)" : "no one")}`);
    if (!s.runtime) wrong.push("without the hardened runtime");
    if (!s.timestamp) wrong.push("without a secure timestamp");
    if (want && s.team !== want) wrong.push(`by team ${s.team ?? "none"}, not ${want}`);
    nested.push({ file: where, authority: s.authorities[0] ?? null, team: s.team, runtime: s.runtime, timestamp: s.timestamp });
    if (wrong.length) problems.push(`${where}: ${wrong.join(", ")}`);
  }
  results.machO = nested.length;
  results.nested = nested;
  if (!nested.length) problems.push("no Mach-O file was found in the app");
  const verify = tool("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], exec);
  results.verify = lastLines(verify.said, 2);
  if (!verify.ok) problems.push(`codesign --verify --deep --strict: ${verify.said}`);
  const ticket = validateTicket(app, { exec, sleep });
  results.ticket = lastLines(ticket.said, 1);
  if (!ticket.ok) problems.push(`stapler validate: ${ticket.said}`);
  const gate = tool("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app], exec);
  results.gatekeeper = lastLines(gate.said, 3);
  if (!gate.ok || !/: accepted/.test(gate.said) || !/source=Notarized Developer ID/.test(gate.said)) problems.push(`spctl --assess --type execute: ${gate.said}`);
  return { problems, results };
}

/** The same for a disk image: signed by the team, its ticket stapled, Gatekeeper accepts it as a download to open. */
export function signedDmgProblems(dmg, { team = null, exec = run, sleep = sleepSync } = {}) {
  const problems = [];
  const results = {};
  const s = signatureDetails(dmg, exec);
  results.authority = s.authorities[0] ?? null;
  results.team = s.team;
  if (!s.authorities[0]?.startsWith("Developer ID Application:")) problems.push(`the disk image is signed by ${s.authorities[0] ?? "no one"}, not a Developer ID Application`);
  if (team && s.team !== team) problems.push(`the disk image is signed by team ${s.team ?? "none"}, not ${team}`);
  if (!s.timestamp) problems.push("the disk image's signature has no secure timestamp");
  const ticket = validateTicket(dmg, { exec, sleep });
  results.ticket = lastLines(ticket.said, 1);
  if (!ticket.ok) problems.push(`stapler validate on the disk image: ${ticket.said}`);
  const gate = tool("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", dmg], exec);
  results.gatekeeper = lastLines(gate.said, 3);
  if (!gate.ok || !/: accepted/.test(gate.said) || !/source=Notarized Developer ID/.test(gate.said)) problems.push(`spctl --assess --type open on the disk image: ${gate.said}`);
  return { problems, results };
}

/** The quarantine mark a browser puts on a download (Safari's agent name; the time now). */
export function quarantineValue(now = Date.now()) {
  return `0081;${Math.floor(now / 1000).toString(16)};Safari;`;
}

/** Marks a file or a bundle as downloaded by a browser. */
export function quarantine(file, { exec = run, now = Date.now() } = {}) {
  exec("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantineValue(now), file]);
}

/** Whether a file carries the quarantine mark. */
export function quarantined(file, exec = run) {
  try {
    exec("/usr/bin/xattr", ["-p", "com.apple.quarantine", file]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gatekeeper's assessment of an app that carries the quarantine mark, or lies on a volume mounted as quarantined
 * (`mounted`): accepted as notarized, or the problem.
 */
export function quarantinedAppProblem(app, { mounted = false, exec = run } = {}) {
  if (!mounted && !quarantined(app, exec)) return `${path.basename(app)} carries no quarantine mark, so the check would prove nothing`;
  const gate = tool("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app], exec);
  if (!gate.ok || !/: accepted/.test(gate.said) || !/source=Notarized Developer ID/.test(gate.said)) return `with the quarantine mark of a download, spctl --assess --type execute: ${gate.said}`;
  return null;
}
