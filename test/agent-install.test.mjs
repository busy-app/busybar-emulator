// The agent's install sequence (EMU-211): public-docs/install/install-macos.sh and install-windows.ps1, run in a clean
// shell against release files served on 127.0.0.1, never against the real release address and never into the user's
// own folders: every case has a home (macOS) or %LOCALAPPDATA% (Windows) of its own, empty, and nothing else of the
// caller's environment. That stands for a fresh account; no account of the system is made. On macOS the script makes
// its download folder in the user's own temporary folder (mktemp -t ignores TMPDIR there), which every other run of
// this file on the machine shares: each macOS case runs a copy of the script whose one mktemp line makes that folder
// in the case's own folder instead, so that what a run left is its own and nothing else's.
//
// Always: a small stand-in release (an app whose command line only writes the pointer file, as the app does at its
// start; on macOS one for each processor, each saying which it is for) covers every branch on the system it runs on:
// a fresh install, the archive for the Mac's processor (the other processor's answer is given to a copy of the
// script: the test says the replacement), a checksum that does not match, a sum that is
// missing, an app already in ~/Applications or in /Applications (macOS), an app already installed (Windows), a
// pointer file, a pointer file that names nothing. The /Applications case runs a copy of the script with that one path
// replaced by a temporary folder, and the Windows cases a copy that adds /NoShortcut, so that the user's Start menu is
// not touched: the test says each replacement and checks it took place once.
//
// With BUSY_EMULATOR_TEST_INSTALL_BUILD=<the out folder of npm run dist> (a release and the test variant built into
// it) the sequence also runs on the real files:
//   - the release's own file: downloaded, checked, installed, its command line answers `version`. It is not started:
//     a release takes the user's own folders and port 8640. On macOS the installed app passes codesign --verify and
//     carries no quarantine mark; a release signed with Developer ID (EMU-204) is also accepted by Gatekeeper as
//     notarized, an unsigned build keeps the ad hoc signature. On Windows the setup is not marked as coming from the
//     internet.
//   - the test variant packed under the release's name: the whole sequence, started hidden on a port of 8720-8729
//     with the case's own folders, the command line read from the pointer file, `status`, then `quit`.
//   - the release's file changed by one byte on its way: refused before anything is unpacked or run.
// On Windows the test variant needs a desktop session (a scheduled task in the user's session; over SSH there is none).
//
// The doc public-docs/install.md carries each script whole; the first test checks they are the same text.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { execProgram, spawnProgram } from "../packages/engine/programs.mjs";
import { ALL_RELEASE_FILES, RELEASE_FILES } from "../packages/app/tools/packaging/names.mjs";
import { attachScratchVolume } from "../packages/app/tools/packaging/scratch-volume.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, ".."); // emulator/
const installDir = path.join(root, "public-docs", "install");
const MAC_SCRIPT = path.join(installDir, "install-macos.sh");
const WIN_SCRIPT = path.join(installDir, "install-windows.ps1");
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";
// macOS has two archives, for Apple Silicon and for Intel, and the script takes the one for the Mac's processor. ZIP
// is the one for this Mac, asked of the hardware as the script asks it; OTHER_ZIP is the other.
const MAC_ARCH = MAC && execProgram("/bin/sh", ["-c", "/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true"], { encoding: "utf8" }).trim() !== "1" ? "x64" : "arm64";
const OTHER_ARCH = MAC_ARCH === "arm64" ? "x64" : "arm64";
const [, ZIP] = RELEASE_FILES[`darwin-${MAC_ARCH}`];
const [, OTHER_ZIP] = RELEASE_FILES[`darwin-${OTHER_ARCH}`];
const [SETUP] = RELEASE_FILES["win32-x64"];
const APP = "BUSY Bar Emulator.app";
const BUILD = process.env.BUSY_EMULATOR_TEST_INSTALL_BUILD ? path.resolve(process.env.BUSY_EMULATOR_TEST_INSTALL_BUILD) : null;
const PORTS = [8720, 8729];
const LIMIT_MS = 180_000;

const folders = [];
const children = new Set();
let server;
let base;

const volumes = [];

after(async () => {
  for (const child of children) child.kill();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  for (const v of volumes) v.remove();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

function tempFolder(name) {
  // By the system's own temporary folder; on macOS its path goes through a symbolic link (/var), as a user's may.
  const f = mkdtempSync(path.join(os.tmpdir(), `emu-211-${name}-`));
  folders.push(f);
  return f;
}

function freePort(from, to, taken = []) {
  const one = (port) =>
    new Promise((resolve) => {
      const probe = net.createServer().once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
  return (async () => {
    for (let port = from; port <= to; port++) if (!taken.includes(port) && (await one(port))) return port;
    throw new Error(`no free port in ${from}-${to}`);
  })();
}

// The .ps1 is checked out with CRLF (.gitattributes), the doc with LF: compared and edited by lines.
const readText = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * The release server: /<release>/<file> from the folders given to serve(), every request recorded. A release may
 * have one file changed on its way out (one byte, past the first kilobyte), as a damaged or replaced download would be.
 */
const releases = new Map();
const requests = [];
function serve(name, folder, { tamper = null } = {}) {
  releases.set(name, { folder, tamper });
  return `${base}/${name}`;
}
function startServer(port) {
  server = http.createServer((req, res) => {
    requests.push(req.url);
    const [, release, file] = decodeURIComponent(req.url).split("/");
    const r = releases.get(release);
    const at = r && file && !file.includes("\\") && path.join(r.folder, file);
    if (!at || !existsSync(at) || !statSync(at).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(at).size });
    const stream = createReadStream(at);
    if (r.tamper !== file) return stream.pipe(res);
    let seen = 0;
    const flip = new Transform({
      transform(chunk, _enc, done) {
        const copy = Buffer.from(chunk);
        const i = 1024 - seen;
        if (i >= 0 && i < copy.length) copy[i] ^= 0xff;
        seen += chunk.length;
        done(null, copy);
      },
    });
    stream.pipe(flip).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
}
const requested = (url) => requests.filter((r) => `${base}${r}`.startsWith(url)).length;

/** SHA256SUMS for the files of a folder, as dist:sums writes it. */
function writeSums(folder, names) {
  writeFileSync(path.join(folder, "SHA256SUMS"), names.map((n) => `${sha256(path.join(folder, n))}  ${n}\n`).join(""));
}

/** A copy of a script with one piece replaced, exactly once. */
function scriptWith(script, folder, replacements) {
  let text = readText(script);
  for (const [from, to] of replacements) {
    assert.equal(text.split(from).length, 2, `${path.basename(script)} holds ${JSON.stringify(from)} exactly once`);
    text = text.replace(from, () => to);
  }
  const copy = path.join(folder, path.basename(script));
  writeFileSync(copy, text);
  return copy;
}

/** Runs a program with exactly this environment and gives its exit code and output. */
function run(program, args, env, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProgram(program, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill(), LIMIT_MS);
    child.on("error", reject);
    // On Windows an app the script starts may hold the script's output pipe (handles a process inherits pass on to
    // the processes it starts), so the end of the output is not waited for past a moment after the exit.
    const done = (code) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ code, out, err, all: out + err });
    };
    let exited = null;
    child.on("exit", (code) => {
      exited = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done(code);
      }, 2000);
    });
    child.on("close", (code) => {
      if (exited) clearTimeout(exited);
      done(code);
    });
  });
}

function files(folder) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  if (existsSync(folder)) walk(folder, "");
  return out.sort();
}

// Before any hook: the hooks below serve their releases from it. On a port the system gives: a port of the range
// found free here could be taken by another run of this file between the probe and the listen.
await startServer(0);
const serverPort = server.address().port;
base = `http://127.0.0.1:${serverPort}`;

// ------------------------------------------------------------------------------------------- the doc and the scripts

test("public-docs/install.md carries both scripts whole", () => {
  const doc = readText(path.join(root, "public-docs", "install.md"));
  const blocks = [...doc.matchAll(/```(\w+)\n([\s\S]*?)```/g)].map((m) => m[2]);
  for (const script of [MAC_SCRIPT, WIN_SCRIPT]) {
    const text = readText(script);
    assert.ok(blocks.includes(text), `install.md has ${path.basename(script)} as one code block, the same text`);
  }
  // The release address is one parameter, the same in both, and the doc names it.
  const address = "https://github.com/busy-app/busybar-emulator/releases/latest/download";
  for (const script of [MAC_SCRIPT, WIN_SCRIPT]) assert.equal(readText(script).split(address).length, 2, `${path.basename(script)} names the address once`);
  // Every file of a release, by the names the build gives them.
  for (const name of ALL_RELEASE_FILES) assert.ok(doc.includes(`${address}/${name}`), `install.md gives the address of ${name}`);
  assert.ok(ALL_RELEASE_FILES.includes(ZIP) && ALL_RELEASE_FILES.includes(SETUP));
});

// ---------------------------------------------------------------------------------------------------------- macOS

const CLEAN_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A home of its own: the case's whole world. */
function macCase(name) {
  const folder = tempFolder(name);
  const home = path.join(folder, "home");
  mkdirSync(home);
  return { folder, home };
}

/**
 * A case on a scratch volume of its own (packages/app/tools/packaging/scratch-volume.mjs), for a notarized release's
 * app: once its command line has run, macOS's App Management protection lets no process of another team (this test)
 * remove the app, and the volume goes whole instead.
 */
function macCaseOnVolume(name) {
  const volume = attachScratchVolume(tempFolder(name), { name: "case" });
  volumes.push(volume);
  const folder = path.join(volume.mount, name);
  const home = path.join(folder, "home");
  mkdirSync(home, { recursive: true });
  return { folder, home };
}

// The script's download folder: mktemp -d -t on macOS takes the user's own temporary folder whatever TMPDIR says
// (DARWIN_USER_TEMP_DIR, mode 0700), the same for every process of the user. Other runs of this file (another gate,
// another clone) make and remove folders by the same prefix there at any moment, so a folder that appeared there
// during a run is not known to be the run's. Each case's run therefore takes a copy of the script with that one line
// replaced: the same mktemp, with a template in the case's own folder (the first test checks the line is the script's).
// What appears there and is still there after the run is the run's leftover.
const MAKE_DOWNLOADS = "tmp=$(/usr/bin/mktemp -d -t busy-emulator-install)";
const DOWNLOAD_PREFIX = "busy-emulator-install.";
const shellQuoted = (text) => `'${text.replaceAll("'", "'\\''")}'`;
function withOwnDownloads(script, c) {
  const downloads = path.join(c.folder, "downloads");
  mkdirSync(downloads, { recursive: true });
  const text = readText(script);
  // The system's /Applications is the machine's, not the case's: an emulator installed there for real would answer
  // every case as "already installed". A copy that has not replaced it already (the /Applications case) gets an empty
  // folder of the case's own in its place.
  const system = path.join(c.folder, "system-applications");
  const replacements = [
    ...(text.includes(MAKE_DOWNLOADS) ? [[MAKE_DOWNLOADS, `tmp=$(/usr/bin/mktemp -d ${shellQuoted(path.join(downloads, `${DOWNLOAD_PREFIX}XXXXXXXXXX`))})`]] : []),
    ...(text.includes('"/Applications/$name"') ? [['"/Applications/$name"', `"${system}/$name"`]] : []),
  ];
  if (!replacements.length) return { script, downloads };
  mkdirSync(system, { recursive: true });
  const copies = path.join(c.folder, "scripts");
  mkdirSync(copies, { recursive: true });
  return { script: scriptWith(script, copies, replacements), downloads };
}
const downloadsIn = (folder) => new Set(readdirSync(folder).filter((f) => f.startsWith(DOWNLOAD_PREFIX)));

test("macOS: the script makes its download folder by the one line the cases replace, and removes it on exit", () => {
  const text = readText(MAC_SCRIPT);
  assert.equal(text.split(MAKE_DOWNLOADS).length, 2, `install-macos.sh holds ${JSON.stringify(MAKE_DOWNLOADS)} once`);
  assert.ok(text.includes(`${MAKE_DOWNLOADS}\n    trap '/bin/rm -rf "$tmp"' EXIT\n`), "the clean-up is set right after it");
});

/**
 * The script in zsh with no startup files and nothing of the caller's environment but what is named. `left` lists
 * the download folders the run left behind.
 */
async function runMac(given, c, url, extra = {}, { prefix = [] } = {}) {
  const env = { HOME: c.home, PATH: CLEAN_PATH, BUSY_EMULATOR_RELEASE_URL: url, ...extra };
  const { script, downloads } = withOwnDownloads(given, c);
  const before = downloadsIn(downloads);
  const r = await run(prefix[0] ?? "/usr/bin/env", [...prefix.slice(1), ...(prefix.length ? ["/usr/bin/env"] : []), "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/bin/zsh", "-f", script], undefined, { cwd: c.home });
  const left = [...downloadsIn(downloads)].filter((f) => !before.has(f));
  return { ...r, left };
}

const pointerOf = (home) => path.join(home, "Library", "Application Support", "BUSY Bar Emulator", "install.json");

/**
 * The stand-in app: its command line writes what the app writes at its start, and records each call. It says which
 * processor it stands for, so that a case sees which archive was installed.
 */
function standInMacApp(folder, builtFor = MAC_ARCH) {
  const app = path.join(folder, APP);
  const bin = path.join(app, "Contents", "Resources", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(app, "Contents", "Info.plist"), "<plist><dict/></plist>\n");
  writeFileSync(path.join(app, "Contents", "built-for"), `${builtFor}\n`);
  const cli = path.join(bin, "busy-emulator");
  writeFileSync(
    cli,
    [
      "#!/bin/sh",
      'echo "$0 $*" >> "$HOME/calls.log"',
      'if [ "$1" = start ]; then',
      '  data="$HOME/Library/Application Support/BUSY Bar Emulator"',
      '  mkdir -p "$data" "$HOME/.busy-emulator/bin"',
      // Called inside the app, it knows the app; called as the copy at the fixed place, the pointer names it.
      '  case "$0" in',
      '    *.app/Contents/Resources/bin/busy-emulator) app=${0%/Contents/Resources/bin/busy-emulator} ;;',
      '    *) app=$(/usr/bin/plutil -extract app raw -o - "$data/install.json") ;;',
      "  esac",
      '  [ "$0" = "$HOME/.busy-emulator/bin/busy-emulator" ] || cp "$0" "$HOME/.busy-emulator/bin/busy-emulator"',
      '  printf \'{"app":"%s","cli":"%s","version":"0.0.0"}\\n\' "$app" "$HOME/.busy-emulator/bin/busy-emulator" > "$data/install.json"',
      '  echo "The emulator is running."',
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(cli, 0o755);
  return app;
}

let macRelease; // the stand-in release
before(() => {
  if (!MAC) return;
  const folder = tempFolder("mac-release");
  const work = path.join(folder, "work");
  mkdirSync(work);
  const release = path.join(folder, "release");
  mkdirSync(release);
  // Both archives, as a release has them: the app in each says which processor it is for.
  for (const [arch, zip] of [[MAC_ARCH, ZIP], [OTHER_ARCH, OTHER_ZIP]]) {
    const app = standInMacApp(path.join(work, arch), arch);
    execProgram("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", app, path.join(release, zip)]);
  }
  writeSums(release, [ZIP, OTHER_ZIP]);
  // The same files, with a SHA256SUMS that has no line for the archive.
  const noSum = path.join(folder, "no-sum");
  mkdirSync(noSum);
  cpSync(path.join(release, ZIP), path.join(noSum, ZIP));
  writeFileSync(path.join(noSum, "SHA256SUMS"), `${"0".repeat(64)}  busybar-emulator-win-x64-setup.exe\n`);
  macRelease = { folder: release, good: serve("mac-good", release), tampered: serve("mac-tampered", release, { tamper: ZIP }), noSum: serve("mac-no-sum", noSum), missing: serve("mac-missing", path.join(folder, "nothing")), work };
});

const macOnly = !MAC && "macOS only";
/** Which processor the installed stand-in app says it is for. */
const builtFor = (home) => readFileSync(path.join(home, "Applications", APP, "Contents", "built-for"), "utf8").trim();
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const calls = (home) => (existsSync(path.join(home, "calls.log")) ? readFileSync(path.join(home, "calls.log"), "utf8").trim().split("\n") : []);

test("macOS, nothing installed: downloads, checks, unpacks into ~/Applications, starts, reads the pointer", { skip: macOnly }, async () => {
  const c = macCase("fresh");
  const r = await runMac(MAC_SCRIPT, c, macRelease.good);
  assert.equal(r.code, 0, r.all);
  const installed = path.join(c.home, "Applications", APP);
  assert.ok(existsSync(path.join(installed, "Contents", "Resources", "bin", "busy-emulator")), r.all);
  assert.match(r.out, /matches SHA256SUMS/);
  const cli = path.join(c.home, ".busy-emulator", "bin", "busy-emulator");
  assert.ok(r.out.trim().endsWith(`cli=${cli}`), r.out);
  assert.deepEqual(calls(c.home), [`${installed}/Contents/Resources/bin/busy-emulator start`]);
  assert.deepEqual(r.left, [], "the download is gone");
  assert.equal(requested(`${macRelease.good}/${ZIP}`), 1);
  assert.equal(builtFor(c.home), MAC_ARCH, "the archive for this Mac's processor");
});

// The script asks the hardware which processor the Mac has (sysctl hw.optional.arm64: 1 on Apple Silicon, no such
// key on Intel). A test has one Mac, so each answer is given to a copy of the script, with the one question replaced.
for (const [answer, arch, what] of [
  ["", "x64", "a Mac with an Intel processor (the hardware's answer replaced by none, as Intel gives)"],
  ["1", "arm64", "a Mac with Apple Silicon (the hardware's answer replaced by 1)"],
]) {
  test(`macOS, ${what}: takes the ${arch} archive and no other`, { skip: macOnly }, async () => {
    const c = macCase(`processor-${arch}`);
    const script = scriptWith(MAC_SCRIPT, c.folder, [['"$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)"', `"${answer}"`]]);
    const url = serve(`mac-processor-${arch}`, macRelease.folder);
    const r = await runMac(script, c, url);
    assert.equal(r.code, 0, r.all);
    const [, zip] = RELEASE_FILES[`darwin-${arch}`];
    const [, other] = RELEASE_FILES[`darwin-${arch === "x64" ? "arm64" : "x64"}`];
    assert.match(r.out, new RegExp(`${escaped(zip)} matches SHA256SUMS`));
    assert.equal(requested(`${url}/${zip}`), 1);
    assert.equal(requested(`${url}/${other}`), 0, "the other processor's archive is not asked for");
    assert.equal(builtFor(c.home), arch);
    assert.deepEqual(calls(c.home), [`${c.home}/Applications/${APP}/Contents/Resources/bin/busy-emulator start`]);
  });
}

test("macOS, no Mac is refused for its processor: the script names both archives and no longer stops on Intel", () => {
  const text = readText(MAC_SCRIPT);
  for (const target of ["darwin-arm64", "darwin-x64"]) assert.equal(text.split(RELEASE_FILES[target][1]).length, 2, `${RELEASE_FILES[target][1]} is named once`);
  assert.doesNotMatch(text, /Apple Silicon only/);
  assert.doesNotMatch(text, /uname -m\)/, "uname -m says x86_64 in a shell under Rosetta on Apple Silicon: the script does not go by it");
});

test("macOS, the archive does not match SHA256SUMS: stops before unpacking, nothing installed or started", { skip: macOnly }, async () => {
  const c = macCase("tampered");
  const r = await runMac(MAC_SCRIPT, c, macRelease.tampered);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /does not match SHA256SUMS .*nothing unpacked, nothing installed/);
  assert.ok(!existsSync(path.join(c.home, "Applications")), "no ~/Applications made");
  assert.deepEqual(calls(c.home), [], "nothing started");
  assert.deepEqual(r.left, [], "the download is gone");
});

test("macOS, SHA256SUMS has no line for the archive, or the archive is not there: refused", { skip: macOnly }, async () => {
  const a = macCase("no-sum");
  const r = await runMac(MAC_SCRIPT, a, macRelease.noSum);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, new RegExp(`SHA256SUMS has no single sum for ${escaped(ZIP)}`));
  assert.ok(!existsSync(path.join(a.home, "Applications")));
  const b = macCase("missing");
  const s = await runMac(MAC_SCRIPT, b, macRelease.missing);
  assert.equal(s.code, 1, s.all);
  assert.match(s.err, new RegExp(`could not download .*${escaped(ZIP)}`));
  assert.deepEqual(s.left, []);
});

test("macOS, the app is in ~/Applications already: nothing is downloaded, that app starts", { skip: macOnly }, async () => {
  const c = macCase("in-home-apps");
  const app = standInMacApp(path.join(c.home, "Applications"));
  const before = requests.length;
  const r = await runMac(MAC_SCRIPT, c, macRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.equal(requests.length, before, "no download");
  assert.deepEqual(calls(c.home), [`${app}/Contents/Resources/bin/busy-emulator start`]);
});

test("macOS, the app is in /Applications (a temporary folder stands for it): nothing is downloaded, nothing goes to ~/Applications", { skip: macOnly }, async () => {
  const c = macCase("in-system-apps");
  const system = path.join(c.folder, "system-applications");
  const app = standInMacApp(system);
  const script = scriptWith(MAC_SCRIPT, c.folder, [['"/Applications/$name"', `"${system}/$name"`]]);
  const before = requests.length;
  const r = await runMac(script, c, macRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.equal(requests.length, before, "no download");
  assert.ok(!existsSync(path.join(c.home, "Applications")), "no ~/Applications made");
  assert.deepEqual(calls(c.home), [`${app}/Contents/Resources/bin/busy-emulator start`]);
});

test("macOS, the pointer file names the command line: it starts the emulator, nothing is downloaded", { skip: macOnly }, async () => {
  const c = macCase("pointer");
  const first = await runMac(MAC_SCRIPT, c, macRelease.good);
  assert.equal(first.code, 0, first.all);
  const before = requests.length;
  const r = await runMac(MAC_SCRIPT, c, macRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.equal(requests.length, before, "no download");
  assert.match(r.out, /installed: .*install\.json names/);
  assert.equal(calls(c.home).at(-1), `${c.home}/.busy-emulator/bin/busy-emulator start`);
});

test("macOS, the pointer file names a command line that is gone and there is no app: installs", { skip: macOnly }, async () => {
  const c = macCase("stale-pointer");
  mkdirSync(path.dirname(pointerOf(c.home)), { recursive: true });
  writeFileSync(pointerOf(c.home), JSON.stringify({ app: "/nowhere/BUSY Bar Emulator.app", cli: "/nowhere/busy-emulator", version: "0.0.0" }));
  const r = await runMac(MAC_SCRIPT, c, macRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /names no app or command line that exists/);
  assert.ok(existsSync(path.join(c.home, "Applications", APP)));
});

/** What a start of the real app leaves: its own code writes the launcher and the pointer file, both naming `appPath`. */
async function leftByAStartOf(home, appPath) {
  const { writeInstallFiles } = await import(path.join(root, "packages", "app", "src", "install-files.mjs"));
  const resources = path.join(appPath, "Contents", "Resources");
  const r = writeInstallFiles(
    {
      launcher: path.join(home, ".busy-emulator", "bin", "busy-emulator"),
      pointer: pointerOf(home),
      appPath,
      node: path.join(resources, "node", "bin", "node"),
      cli: path.join(resources, "emulator", "packages", "server", "cli", "busy-emulator.mjs"),
      inAppLauncher: path.join(resources, "bin", "busy-emulator"),
    },
    { platform: "darwin", version: "0.0.0" },
  );
  assert.equal(r.ok, true, r.error);
}

test("macOS, the app was put in the Trash (the launcher and the pointer file stay): installs it again", { skip: macOnly }, async () => {
  const c = macCase("trashed");
  await leftByAStartOf(c.home, path.join(c.home, "Applications", APP));
  const r = await runMac(MAC_SCRIPT, c, macRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /names no app or command line that exists/);
  assert.ok(existsSync(path.join(c.home, "Applications", APP)), r.all);
  assert.deepEqual(calls(c.home)[0], `${c.home}/Applications/${APP}/Contents/Resources/bin/busy-emulator start`);
});

test("macOS, the app was moved from ~/Applications to /Applications (a temporary folder stands for it): that app starts", { skip: macOnly }, async () => {
  const c = macCase("moved");
  const system = path.join(c.folder, "system-applications");
  const app = standInMacApp(system);
  await leftByAStartOf(c.home, path.join(c.home, "Applications", APP));
  const script = scriptWith(MAC_SCRIPT, c.folder, [['"/Applications/$name"', `"${system}/$name"`]]);
  const before = requests.length;
  const r = await runMac(script, c, macRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.equal(requests.length, before, "no download");
  assert.deepEqual(calls(c.home), [`${app}/Contents/Resources/bin/busy-emulator start`]);
});

test("macOS, the order: an archive that does not match is never unpacked (a copy without the clean-up shows it)", { skip: macOnly }, async () => {
  // The script removes its download folder whatever happens, so what it unpacked cannot be seen afterwards; this copy
  // keeps the folder, in the case's own folder. The archive served is another valid one under the right name.
  const c = macCase("order");
  const other = path.join(c.folder, "other");
  const app = standInMacApp(path.join(other, "work"));
  writeFileSync(path.join(app, "Contents", "replaced"), "not in the release\n");
  const release = path.join(other, "release");
  mkdirSync(release);
  execProgram("/usr/bin/ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", app, path.join(release, ZIP)]);
  cpSync(path.join(macRelease.folder, "SHA256SUMS"), path.join(release, "SHA256SUMS"));
  const kept = path.join(c.folder, "download");
  const script = scriptWith(MAC_SCRIPT, c.folder, [
    ["    trap '/bin/rm -rf \"$tmp\"' EXIT\n", ""],
    ["tmp=$(/usr/bin/mktemp -d -t busy-emulator-install)", `tmp=${kept}; /bin/mkdir "$tmp"`],
  ]);
  const r = await runMac(script, c, serve("mac-replaced", release));
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /does not match SHA256SUMS/);
  assert.deepEqual(readdirSync(kept).sort(), ["SHA256SUMS", ZIP], "downloaded, nothing unpacked");
});

test("macOS, a shell under Rosetta on Apple Silicon (uname -m says x86_64) still installs", { skip: macOnly || (!rosetta() && "no Rosetta here to run a shell under") }, async () => {
  const c = macCase("rosetta");
  const r = await runMac(MAC_SCRIPT, c, macRelease.good, {}, { prefix: ["/usr/bin/arch", "-x86_64"] });
  assert.equal(r.code, 0, r.all);
  assert.ok(existsSync(path.join(c.home, "Applications", APP)));
  assert.equal(builtFor(c.home), "arm64", "the processor decides, not the shell: Apple Silicon's archive, not Intel's");
});

function rosetta() {
  try {
    return execProgram("/usr/bin/arch", ["-x86_64", "/usr/bin/uname", "-m"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "x86_64";
  } catch {
    return false;
  }
}

test("macOS, the release address: https only (http to 127.0.0.1 for tests), and another address is said", { skip: macOnly }, async () => {
  for (const url of ["file:///tmp/release", "http://example.com/release", "http://127.0.0.1.example.com/release", "ftp://example.com/x"]) {
    const c = macCase("address");
    const r = await runMac(MAC_SCRIPT, c, url);
    assert.equal(r.code, 1, `${url}: ${r.all}`);
    assert.match(r.err, /BUSY_EMULATOR_RELEASE_URL must be an https address/);
    assert.ok(!existsSync(path.join(c.home, "Applications")));
  }
  const c = macCase("address-ok");
  const r = await runMac(MAC_SCRIPT, c, macRelease.good);
  assert.match(r.out, /not the official release: the files come from http:\/\/127\.0\.0\.1/);
});

test("macOS, a home reached through a symbolic link and with a space in its name: the same result", { skip: macOnly }, async () => {
  const c = macCase("linked");
  const real = path.join(c.folder, "a home");
  mkdirSync(real);
  const link = path.join(c.folder, "link");
  symlinkSync(real, link);
  const r = await runMac(MAC_SCRIPT, { ...c, home: link }, macRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.ok(existsSync(path.join(real, "Applications", APP, "Contents", "Resources", "bin", "busy-emulator")));
  assert.ok(r.out.trim().endsWith(`cli=${link}/.busy-emulator/bin/busy-emulator`), r.out);
});

// ---------------------------------------------------------------------------------------------------------- Windows

const winOnly = !WIN && "Windows only";
const appTools = path.join(root, "packages", "app", "tools");

/** A %LOCALAPPDATA% and %TEMP% of the case's own. */
function winCase(name) {
  const folder = tempFolder(name);
  const local = path.join(folder, "Local");
  const temp = path.join(folder, "Temp");
  mkdirSync(local);
  mkdirSync(temp);
  return { folder, local, temp };
}

/** Windows PowerShell with no profile and only the variables Windows itself sets, the case's folders in place of the user's. */
function winEnv(c, url, extra = {}) {
  const sys = process.env.SystemRoot || "C:\\Windows";
  const keep = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "USERNAME", "USERPROFILE", "USERDOMAIN", "COMPUTERNAME"];
  const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  return {
    ...env,
    PATH: [`${sys}\\system32`, sys, `${sys}\\System32\\Wbem`, `${sys}\\System32\\WindowsPowerShell\\v1.0`].join(";"),
    LOCALAPPDATA: c.local,
    APPDATA: path.join(c.folder, "Roaming"),
    TEMP: c.temp,
    TMP: c.temp,
    BUSY_EMULATOR_RELEASE_URL: url,
    ...extra,
  };
}

const POWERSHELL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The script, in Windows PowerShell; with asStandardUser, with the rights of a standard user (its output via a file). */
async function runWin(script, c, url, { extra = {}, asStandardUser = false } = {}) {
  const env = winEnv(c, url, extra);
  if (!asStandardUser) return run(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], env, { cwd: c.folder });
  const log = path.join(c.folder, "output.txt");
  const command = `& '${script.replace(/'/g, "''")}' *> '${log.replace(/'/g, "''")}'; exit $LASTEXITCODE`;
  const r = await run(standardUser, [POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], env, { cwd: c.folder });
  // Windows PowerShell 5.1 writes *> as UTF-16 with a byte order mark.
  const text = existsSync(log) ? readFileSync(log, "utf16le").replace(/^\uFEFF/, "") : "";
  return { ...r, out: text, all: text + r.all };
}

/** A copy of the script that adds /NoShortcut, so that no case touches the user's Start menu. */
const noShortcut = (folder) => scriptWith(WIN_SCRIPT, folder, [["@('/S', \"/D=$appFolder\")", "@('/S', '/NoShortcut', \"/D=$appFolder\")"]]);

const STAND_IN_CLI = `using System; using System.IO;
internal static class StandIn {
  private static int Main(string[] args) {
    string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    File.AppendAllText(Path.Combine(local, "calls.log"), self + " " + string.Join(" ", args) + "\\r\\n");
    if (args.Length > 0 && args[0] == "start") {
      string bin = Path.Combine(local, "busy-emulator", "bin");
      Directory.CreateDirectory(bin);
      string cli = Path.Combine(bin, "busy-emulator.exe");
      // Inside the app it knows the app (the folder above resources\\bin); as the copy at the fixed place, the file beside it says.
      string named = Path.Combine(bin, "app.txt");
      string app;
      if (!string.Equals(self, cli, StringComparison.OrdinalIgnoreCase)) {
        app = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(self))), "BUSY Bar Emulator.exe");
        File.Copy(self, cli, true);
        File.WriteAllText(named, app);
      } else {
        app = File.ReadAllText(named);
      }
      string data = Path.Combine(local, "BUSY Bar Emulator");
      Directory.CreateDirectory(data);
      File.WriteAllText(Path.Combine(data, "install.json"), "{\\"app\\":\\"" + app.Replace("\\\\", "\\\\\\\\") + "\\",\\"cli\\":\\"" + cli.Replace("\\\\", "\\\\\\\\") + "\\",\\"version\\":\\"0.0.0\\"}");
      Console.WriteLine("The emulator is running.");
    }
    return 0;
  }
}
`;

let winRelease;
let standardUser;
before(async () => {
  if (!WIN) return;
  const { compileCSharp } = await import(pathToImport(path.join(appTools, "windows-launcher.mjs")));
  const { buildSetup } = await import(pathToImport(path.join(appTools, "packaging", "windows.mjs")));
  const folder = tempFolder("win-release");
  const app = path.join(folder, "app", "BUSY Bar Emulator");
  mkdirSync(path.join(app, "resources", "bin"), { recursive: true });
  writeFileSync(path.join(app, "BUSY Bar Emulator.exe"), "the app");
  writeFileSync(path.join(folder, "stand-in.cs"), STAND_IN_CLI);
  compileCSharp(path.join(folder, "stand-in.cs"), path.join(app, "resources", "bin", "busy-emulator.exe"));
  const work = path.join(folder, "work");
  mkdirSync(work);
  const release = path.join(folder, "release");
  mkdirSync(release);
  buildSetup({ appFolder: app, work, out: path.join(release, SETUP), version: "0.0.0" });
  writeSums(release, [SETUP]);
  const noSum = path.join(folder, "no-sum");
  mkdirSync(noSum);
  cpSync(path.join(release, SETUP), path.join(noSum, SETUP));
  writeFileSync(path.join(noSum, "SHA256SUMS"), `${"0".repeat(64)}  ${ZIP}\n`);
  standardUser = compileCSharp(path.join(root, "packages", "app", "test", "fixtures", "windows", "standard-user.cs"), path.join(folder, "standard-user.exe"));
  winRelease = { good: serve("win-good", release), tampered: serve("win-tampered", release, { tamper: SETUP }), noSum: serve("win-no-sum", noSum) };
});

function pathToImport(file) {
  return new URL(`file:///${file.replace(/\\/g, "/").replace(/^\/+/, "")}`).href;
}

const winCalls = (local) => (existsSync(path.join(local, "calls.log")) ? readFileSync(path.join(local, "calls.log"), "utf8").trim().split(/\r?\n/) : []);

test("Windows, nothing installed, as a standard user: downloads, checks, runs the setup silently, starts, reads the pointer", { skip: winOnly }, async () => {
  const c = winCase("fresh");
  const r = await runWin(noShortcut(c.folder), c, winRelease.good, { asStandardUser: true });
  assert.equal(r.code, 0, r.all);
  const appFolder = path.join(c.local, "Programs", "BUSY Bar Emulator");
  assert.ok(existsSync(path.join(appFolder, "BUSY Bar Emulator.exe")), r.all);
  assert.match(r.out, /matches SHA256SUMS/);
  const cli = path.join(c.local, "busy-emulator", "bin", "busy-emulator.exe");
  assert.ok(r.out.trim().endsWith(`cli=${cli}`), r.out);
  assert.deepEqual(winCalls(c.local), [`${path.join(appFolder, "resources", "bin", "busy-emulator.exe")} start`]);
  assert.deepEqual(readdirSync(c.temp).filter((f) => f.startsWith("busy-emulator-install-")), [], "the download is gone");
  assert.ok(!existsSync(path.join(c.temp, "busybar-emulator-setup.log")), "the setup's log of an install that succeeded is gone (EMU-314)");
});

test("Windows, the one-line install's copy in %TEMP% removes itself; a copy under another name stays (EMU-314)", { skip: winOnly }, async () => {
  const c = winCase("self-removal");
  const named = path.join(c.temp, "busy-emulator-install.ps1");
  renameSync(noShortcut(c.temp), named);
  const r = await runWin(named, c, winRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.ok(!existsSync(named), "the downloaded copy is gone");
  assert.deepEqual(readdirSync(c.temp), [], "nothing is left in %TEMP%");
  const kept = noShortcut(c.temp);
  const again = await runWin(kept, c, winRelease.good);
  assert.equal(again.code, 0, again.all);
  assert.ok(existsSync(kept), "install-windows.ps1, saved by a person, stays");
});

test("Windows, the setup does not match SHA256SUMS: the setup is not run, nothing installed or started", { skip: winOnly }, async () => {
  const c = winCase("tampered");
  const r = await runWin(noShortcut(c.folder), c, winRelease.tampered);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /does not match SHA256SUMS .*the setup was not run, nothing installed/);
  assert.ok(!existsSync(path.join(c.local, "Programs")), "nothing installed");
  assert.ok(!existsSync(path.join(c.temp, "busybar-emulator-setup.log")), "the setup never ran (it would have logged)");
  assert.deepEqual(winCalls(c.local), []);
  assert.deepEqual(readdirSync(c.temp).filter((f) => f.startsWith("busy-emulator-install-")), [], "the download is gone");
});

test("Windows, SHA256SUMS has no line for the setup: refused", { skip: winOnly }, async () => {
  const c = winCase("no-sum");
  const r = await runWin(noShortcut(c.folder), c, winRelease.noSum);
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /SHA256SUMS has no single sum for busybar-emulator-win-x64-setup\.exe/);
  assert.ok(!existsSync(path.join(c.local, "Programs")));
});

test("Windows, the app is installed but never started, then the pointer file: nothing is downloaded", { skip: winOnly }, async () => {
  const c = winCase("installed");
  const first = await runWin(noShortcut(c.folder), c, winRelease.good);
  assert.equal(first.code, 0, first.all);
  rmSync(path.join(c.local, "BUSY Bar Emulator"), { recursive: true });
  const before = requests.length;
  const r = await runWin(noShortcut(c.folder), c, winRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /found /);
  const s = await runWin(noShortcut(c.folder), c, winRelease.good);
  assert.equal(s.code, 0, s.all);
  assert.match(s.out, /installed: .*install\.json names/);
  assert.equal(requests.length, before, "no download");
  assert.equal(winCalls(c.local).at(-1), `${path.join(c.local, "busy-emulator", "bin", "busy-emulator.exe")} start`);
});

test("Windows, the app was removed (the launcher and the pointer file stay): installs it again", { skip: winOnly }, async () => {
  const c = winCase("removed");
  const first = await runWin(noShortcut(c.folder), c, winRelease.good);
  assert.equal(first.code, 0, first.all);
  const appFolder = path.join(c.local, "Programs", "BUSY Bar Emulator");
  rmSync(appFolder, { recursive: true });
  assert.ok(existsSync(path.join(c.local, "busy-emulator", "bin", "busy-emulator.exe")) && existsSync(path.join(c.local, "BUSY Bar Emulator", "install.json")));
  const r = await runWin(noShortcut(c.folder), c, winRelease.good);
  assert.equal(r.code, 0, r.all);
  assert.match(r.out, /names no app or command line that exists/);
  assert.match(r.out, /matches SHA256SUMS/);
  assert.ok(existsSync(path.join(appFolder, "BUSY Bar Emulator.exe")), r.all);
  assert.equal(winCalls(c.local).at(-1), `${path.join(appFolder, "resources", "bin", "busy-emulator.exe")} start`);
});

test("Windows, the release address: https only (http to 127.0.0.1 for tests), and another address is said", { skip: winOnly }, async () => {
  for (const url of ["file:///C:/release", "//server/share/release", "http://example.com/release", "http://127.0.0.1.example.com/release"]) {
    const c = winCase("address");
    const r = await runWin(noShortcut(c.folder), c, url);
    assert.equal(r.code, 1, `${url}: ${r.all}`);
    assert.match(r.err, /BUSY_EMULATOR_RELEASE_URL must be an https address/);
    assert.ok(!existsSync(path.join(c.local, "Programs")));
  }
  const c = winCase("address-ok");
  const r = await runWin(noShortcut(c.folder), c, winRelease.good);
  assert.match(r.out, /not the official release: the files come from http:\/\/127\.0\.0\.1/);
});

// ------------------------------------------------------------------------------------------------- the real files

const noBuild = !BUILD && "BUSY_EMULATOR_TEST_INSTALL_BUILD names no build";
const builtFolder = (...parts) => path.join(BUILD, ...parts);

/** Processes whose command line holds a folder: what an app started from there left. */
function processesUnder(folder) {
  if (WIN) {
    const out = execProgram(POWERSHELL, ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)\" }"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((l) => l.toLowerCase().includes(folder.toLowerCase()));
  }
  const real = realpathSync(folder);
  return execProgram("/bin/ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.includes(folder) || l.includes(real));
}

test("macOS, the release's own archive: installed, signed (Developer ID and notarized, or ad hoc), no quarantine mark, its command line answers", { skip: macOnly || noBuild }, async () => {
  const c = macCaseOnVolume("real-release");
  const release = path.join(c.folder, "release");
  mkdirSync(release);
  cpSync(builtFolder("release", ZIP), path.join(release, ZIP));
  writeSums(release, [ZIP]);
  // Not started: a release takes the user's own folders and port 8640. Its command line says what it is instead.
  const script = scriptWith(MAC_SCRIPT, c.folder, [['"$start" start\n', '"$start" version --json; exit 0\n']]);
  const r = await runMac(script, c, serve("real-mac", release));
  assert.equal(r.code, 0, r.all);
  const app = path.join(c.home, "Applications", APP);
  const version = JSON.parse(r.out.trim().split("\n").at(-1));
  assert.equal(version.kind, "release", r.out);
  execProgram("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const signature = await run("/usr/bin/codesign", ["-dv", "--verbose=2", app], process.env);
  // A release is signed with Developer ID and notarized; a build without an identity keeps the ad hoc signature.
  const developerId = /^Authority=Developer ID Application: /m.test(signature.all);
  if (!developerId) assert.match(signature.all, /^Signature=adhoc$/m, signature.all);
  else assert.match(signature.all, /flags=0x[0-9a-f]+\([^)]*runtime/, signature.all);
  // Only the marked files are listed: xattr -r lists every attribute of every file (com.apple.provenance on each of
  // some 3,000), more than a child's output may be.
  const marked = execProgram("/usr/bin/find", [app, "-xattrname", "com.apple.quarantine"], { encoding: "utf8" });
  assert.equal(marked.trim(), "", "curl gives no quarantine mark, ditto adds none");
  const gatekeeper = await run("/usr/sbin/spctl", ["--assess", "--type", "execute", "-vv", app], process.env);
  console.log(`# spctl --assess: exit ${gatekeeper.code}: ${gatekeeper.all.trim().replace(/\n/g, " | ").replaceAll(c.home, "$HOME")}`);
  if (developerId) {
    assert.equal(gatekeeper.code, 0, gatekeeper.all);
    assert.match(gatekeeper.all, /source=Notarized Developer ID/, gatekeeper.all);
  }
  console.log(`# ${r.out.trim().split("\n").slice(0, -1).join("\n# ").replaceAll(c.home, "$HOME")}`);
});

test("macOS, the release's archive changed on its way: refused before unpacking", { skip: macOnly || noBuild }, async () => {
  const c = macCase("real-tampered");
  const release = path.join(c.folder, "release");
  mkdirSync(release);
  cpSync(builtFolder("release", ZIP), path.join(release, ZIP));
  writeSums(release, [ZIP]);
  const r = await runMac(MAC_SCRIPT, c, serve("real-mac-tampered", release, { tamper: ZIP }));
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /does not match SHA256SUMS/);
  assert.ok(!existsSync(path.join(c.home, "Applications")));
  assert.deepEqual(r.left, []);
  console.log(`# ${r.all.trim().replaceAll(c.home, "$HOME").replace(/\n/g, "\n# ")}`);
});

test("macOS, the test variant under the release's name: the whole sequence, then status and quit", { skip: macOnly || noBuild, timeout: LIMIT_MS }, async () => {
  const { zipApp } = await import(path.join(appTools, "packaging", "macos.mjs"));
  const c = macCase("real-test-variant");
  const release = path.join(c.folder, "release");
  mkdirSync(release);
  zipApp(builtFolder("test-variant", `darwin-${MAC_ARCH}`, APP), path.join(release, ZIP));
  writeSums(release, [ZIP]);
  const appPort = await freePort(...PORTS, [serverPort]);
  const installed = path.join(c.home, "Applications", APP);
  // The test variant reads these; a release reads none. TEST_LAUNCH starts the app itself instead of through
  // Launch Services, which would give it the user's environment instead of the case's.
  const env = {
    BUSY_EMULATOR_DATA: path.dirname(pointerOf(c.home)),
    BUSY_EMULATOR_USER_HOME: c.home,
    BUSY_EMULATOR_PORT: String(appPort),
    BUSY_EMULATOR_HIDDEN: "1",
    BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([path.join(installed, "Contents", "MacOS", "BUSY Bar Emulator")]),
  };
  try {
    const r = await runMac(MAC_SCRIPT, c, serve("real-mac-test", release), env);
    assert.equal(r.code, 0, r.all);
    const cli = r.out.trim().split("\n").at(-1).replace(/^cli=/, "");
    assert.equal(cli, path.join(c.home, ".busy-emulator", "bin", "busy-emulator"));
    const pointer = JSON.parse(readFileSync(pointerOf(c.home), "utf8"));
    assert.equal(pointer.cli, cli);
    const status = await run("/usr/bin/env", ["-i", `HOME=${c.home}`, `PATH=${CLEAN_PATH}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), cli, "status", "--json"], undefined);
    assert.equal(status.code, 0, status.all);
    assert.equal(JSON.parse(status.out).running, true, status.out);
    console.log(`# ${r.out.trim().replaceAll(c.home, "$HOME").replace(/\n/g, "\n# ")}`);
    console.log(`# status: ${status.out.trim().replaceAll(c.home, "$HOME")}`);
  } finally {
    const quit = await run("/usr/bin/env", ["-i", `HOME=${c.home}`, `PATH=${CLEAN_PATH}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), path.join(installed, "Contents", "Resources", "bin", "busy-emulator"), "quit", "--json"], undefined);
    console.log(`# quit: ${quit.out.trim()}`);
    for (let i = 0; i < 40 && processesUnder(c.home).length; i++) await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(processesUnder(c.home), [], "nothing of the app is left running");
  }
});

test("Windows, the release's own setup: checked, installed silently for this user into the case's folder, its command line answers", { skip: winOnly || noBuild }, async () => {
  const c = winCase("real-release");
  const release = path.join(c.folder, "release");
  mkdirSync(release);
  cpSync(builtFolder("release", SETUP), path.join(release, SETUP));
  writeSums(release, [SETUP]);
  const script = scriptWith(noShortcut(c.folder), c.folder, [["& $start start\n", "& $start version --json; exit 0\n"]]);
  const r = await runWin(script, c, serve("real-win", release), { asStandardUser: true });
  assert.equal(r.code, 0, r.all);
  const version = JSON.parse(r.out.trim().split(/\r?\n/).at(-1));
  assert.equal(version.kind, "release", r.out);
  console.log(`# ${r.out.trim().replaceAll(c.local, "%LOCALAPPDATA%").replace(/\r?\n/g, "\n# ")}`);
});

test("Windows, the release's setup changed on its way: not run", { skip: winOnly || noBuild }, async () => {
  const c = winCase("real-tampered");
  const release = path.join(c.folder, "release");
  mkdirSync(release);
  cpSync(builtFolder("release", SETUP), path.join(release, SETUP));
  writeSums(release, [SETUP]);
  const r = await runWin(noShortcut(c.folder), c, serve("real-win-tampered", release, { tamper: SETUP }));
  assert.equal(r.code, 1, r.all);
  assert.match(r.err, /does not match SHA256SUMS/);
  assert.ok(!existsSync(path.join(c.local, "Programs")));
  console.log(`# ${r.all.trim().replaceAll(c.local, "%LOCALAPPDATA%").replace(/\r?\n/g, "\n# ")}`);
});

test("Windows, the test variant under the release's name: the whole sequence, then status and quit", { skip: winOnly || noBuild, timeout: LIMIT_MS }, async () => {
  const { buildSetup } = await import(pathToImport(path.join(appTools, "packaging", "windows.mjs")));
  const c = winCase("real-test-variant");
  const release = path.join(c.folder, "release");
  const work = path.join(c.folder, "work");
  mkdirSync(release);
  mkdirSync(work);
  buildSetup({ appFolder: builtFolder("test-variant", "win32-x64", "BUSY Bar Emulator"), work, out: path.join(release, SETUP), version: "0.0.0" });
  rmSync(work, { recursive: true, force: true });
  writeSums(release, [SETUP]);
  const appPort = await freePort(...PORTS, [serverPort]);
  const appFolder = path.join(c.local, "Programs", "BUSY Bar Emulator");
  const env = {
    BUSY_EMULATOR_DATA: path.join(c.local, "BUSY Bar Emulator"),
    BUSY_EMULATOR_USER_HOME: c.local,
    BUSY_EMULATOR_PORT: String(appPort),
    BUSY_EMULATOR_HIDDEN: "1",
    BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([path.join(appFolder, "BUSY Bar Emulator.exe")]),
  };
  try {
    const r = await runWin(noShortcut(c.folder), c, serve("real-win-test", release), { extra: env });
    assert.equal(r.code, 0, r.all);
    const cli = r.out.trim().split(/\r?\n/).at(-1).replace(/^cli=/, "");
    assert.equal(cli, path.join(c.local, "busy-emulator", "bin", "busy-emulator.exe"));
    const status = await run(cli, ["status", "--json"], winEnv(c, "", env));
    assert.equal(status.code, 0, status.all);
    assert.equal(JSON.parse(status.out).running, true, status.out);
    console.log(`# ${r.out.trim().replaceAll(c.local, "%LOCALAPPDATA%").replace(/\r?\n/g, "\n# ")}`);
    console.log(`# status: ${status.out.trim().replaceAll(c.local.replace(/\\/g, "\\\\"), "%LOCALAPPDATA%")}`);
  } finally {
    const quit = await run(path.join(appFolder, "resources", "bin", "busy-emulator.exe"), ["quit", "--json"], winEnv(c, "", env));
    console.log(`# quit: ${quit.out.trim()}`);
    for (let i = 0; i < 40 && processesUnder(c.folder).length; i++) await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(processesUnder(c.folder), [], "nothing of the app is left running");
  }
});
