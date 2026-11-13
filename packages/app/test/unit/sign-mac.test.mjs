// The release's macOS signature (tools/packaging/sign-mac.mjs, EMU-204) without a certificate: what is signed and in
// which order, the options of every codesign call, notarytool's answers, stapling again, the reading of codesign -dv,
// the entitlements. A real signature and notarization are made and checked by npm run release (docs/release.md).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { build } from "../../tools/dist.mjs";
import { readPin as readGhPin } from "../../tools/bundled-gh.mjs";
import { ghProblems } from "../../tools/packaging/check.mjs";
import { codeOf, ENTITLEMENTS, validateTicket, isMachO, mainExecutableOf, notarize, quarantineValue, signatureDetails, signedAppProblems, signingProblem, signMacApp, staple, teamOf } from "../../tools/packaging/sign-mac.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const IDENTITY = "Developer ID Application: Some One (ABCDE12345)";
const links = process.platform !== "win32";
let folder;
before(() => {
  folder = temporaryFolder();
});
after(async () => {
  await removeFolder(folder);
});

const MACHO_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]);
const write = (file, bytes) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
};
const readJsonPlist = (file) => JSON.parse(readFileSync(file, "utf8"));

/** A bundle laid out as Electron's: a framework with libraries and helpers, a helper app, Node and a native module in Resources. */
function fakeApp(root) {
  const app = path.join(root, "Some.app");
  const c = path.join(app, "Contents");
  write(path.join(c, "Info.plist"), JSON.stringify({ CFBundleExecutable: "Some" }));
  write(path.join(c, "MacOS", "Some"), MACHO_64);
  const fw = path.join(c, "Frameworks", "Engine.framework");
  write(path.join(fw, "Versions", "A", "Engine"), MACHO_64);
  write(path.join(fw, "Versions", "A", "Libraries", "libgl.dylib"), MACHO_64);
  write(path.join(fw, "Versions", "A", "Helpers", "crash_handler"), MACHO_64);
  write(path.join(fw, "Versions", "A", "Resources", "Info.plist"), "{}");
  if (links) {
    symlinkSync("A", path.join(fw, "Versions", "Current"));
    symlinkSync("Versions/Current/Engine", path.join(fw, "Engine"));
  }
  const helper = path.join(c, "Frameworks", "Some Helper.app");
  write(path.join(helper, "Contents", "Info.plist"), JSON.stringify({ CFBundleExecutable: "Some Helper" }));
  write(path.join(helper, "Contents", "MacOS", "Some Helper"), MACHO_64);
  write(path.join(c, "Resources", "node", "bin", "node"), MACHO_64);
  write(path.join(c, "Resources", "emulator", "module.node"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
  write(path.join(c, "Resources", "bin", "busy-emulator"), "#!/bin/sh\nexec node \"$@\"\n");
  write(path.join(c, "Resources", "Some.class"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34]));
  return app;
}

test("an identity is a Developer ID Application with its team; a build is signed with an identity and a profile, or with neither", () => {
  assert.equal(teamOf(IDENTITY), "ABCDE12345");
  assert.equal(teamOf("Apple Development: Some One (ABCDE12345)"), null);
  assert.equal(teamOf(null), null);
  assert.equal(signingProblem({}), null);
  assert.equal(signingProblem({ identity: IDENTITY, profile: "notary" }), null);
  assert.match(signingProblem({ identity: IDENTITY }), /without a notary profile/);
  assert.match(signingProblem({ profile: "notary" }), /without a signing identity/);
  assert.match(signingProblem({ identity: "Some One", profile: "notary" }), /not a Developer ID Application identity/);
});

test("the test variant is never signed with an identity", async () => {
  await assert.rejects(build({ kind: "test", out: path.join(folder, "out"), macSign: { identity: IDENTITY, profile: "notary" } }), /test variant is never signed/);
});

test("Mach-O files are found by their first bytes: thin and universal programs, not scripts or Java classes", () => {
  const app = fakeApp(path.join(folder, "machO"));
  const c = path.join(app, "Contents");
  assert.equal(isMachO(path.join(c, "MacOS", "Some")), true);
  assert.equal(isMachO(path.join(c, "Resources", "emulator", "module.node")), true, "a universal binary");
  assert.equal(isMachO(path.join(c, "Resources", "bin", "busy-emulator")), false, "a script");
  assert.equal(isMachO(path.join(c, "Resources", "Some.class")), false, "a Java class shares the magic");
  assert.equal(isMachO(path.join(c, "Info.plist")), false);
  assert.equal(isMachO(path.join(c, "nothing-here")), false);
});

test("the code of an app, found in the files, and signed inside out: each bundle after all inside it, the app last", () => {
  const app = fakeApp(path.join(folder, "order"));
  const rel = (p) => path.relative(app, p).split(path.sep).join("/");
  assert.equal(rel(mainExecutableOf(path.join(app, "Contents", "Frameworks", "Engine.framework"), readJsonPlist)), "Contents/Frameworks/Engine.framework/Versions/A/Engine");
  const { machO, order } = codeOf(app, { readPlist: readJsonPlist });
  assert.deepEqual(machO.map(rel), [
    "Contents/Frameworks/Engine.framework/Versions/A/Engine",
    "Contents/Frameworks/Engine.framework/Versions/A/Helpers/crash_handler",
    "Contents/Frameworks/Engine.framework/Versions/A/Libraries/libgl.dylib",
    "Contents/Frameworks/Some Helper.app/Contents/MacOS/Some Helper",
    "Contents/MacOS/Some",
    "Contents/Resources/emulator/module.node",
    "Contents/Resources/node/bin/node",
  ]);
  const signed = order.map((o) => rel(o.path) || ".");
  // A bundle's main executable is signed with its bundle, not on its own.
  for (const main of ["Contents/MacOS/Some", "Contents/Frameworks/Engine.framework/Versions/A/Engine", "Contents/Frameworks/Some Helper.app/Contents/MacOS/Some Helper"]) assert.ok(!signed.includes(main), main);
  assert.equal(signed.at(-1), ".", "the app last");
  assert.equal(signed.length, 7);
  for (const bundle of order.filter((o) => o.bundle)) {
    const at = order.indexOf(bundle);
    for (const inner of order.filter((o) => o.path.startsWith(`${bundle.path}${path.sep}`))) assert.ok(order.indexOf(inner) < at, `${rel(inner.path)} before ${rel(bundle.path) || "the app"}`);
  }
});

test("every codesign call: the identity, the hardened runtime, a secure timestamp, the entitlements, never --deep", { skip: process.platform !== "darwin" }, () => {
  const app = fakeApp(path.join(folder, "sign"));
  const calls = [];
  const exec = (program, args) => {
    calls.push([program, ...args]);
    return "";
  };
  // codeOf reads Info.plist with plutil; the fake bundle's are JSON, which plutil reads as well.
  const result = signMacApp(app, { identity: IDENTITY, exec });
  assert.deepEqual(result, { signed: 7, machO: 7 });
  const signs = calls.filter((c) => c.includes("--sign"));
  assert.equal(signs.length, 7);
  for (const c of signs) {
    assert.equal(c[0], "/usr/bin/codesign");
    assert.deepEqual(c.slice(1, -1), ["--force", "--timestamp", "--options", "runtime", "--entitlements", ENTITLEMENTS, "--sign", IDENTITY]);
  }
  assert.equal(signs.at(-1).at(-1), app);
  assert.ok(!calls.flat().includes("--deep") || calls.at(-1).includes("--verify"), "--deep only to verify");
  assert.deepEqual(calls.at(-1), ["/usr/bin/codesign", "--verify", "--deep", "--strict", app]);
});

test("notarytool: Accepted gives the submission's id; anything else fails with the issues of its log", () => {
  const accepted = () => `Conducting pre-submission checks...\n{"id":"1111-2222","status":"Accepted","message":"Processing complete"}\n`;
  assert.deepEqual(notarize("/x/app.zip", { profile: "notary", exec: accepted }), { id: "1111-2222", status: "Accepted" });
  const calls = [];
  const invalid = (program, args) => {
    calls.push(args);
    if (args[1] === "submit") {
      const e = new Error("exit 1");
      e.stdout = '{"id":"3333","status":"Invalid","message":"Processing complete"}';
      throw e;
    }
    return JSON.stringify({ issues: [{ path: "Some.app/Contents/Resources/node/bin/node", message: "The executable does not have the hardened runtime enabled." }] });
  };
  assert.throws(() => notarize("/x/app.zip", { profile: "notary", exec: invalid }), /did not accept app\.zip: Invalid, submission 3333[\s\S]*node\/bin\/node: The executable does not have the hardened runtime/);
  assert.deepEqual(calls[0], ["notarytool", "submit", "/x/app.zip", "--keychain-profile", "notary", "--wait", "--timeout", "1h", "--output-format", "json"]);
  assert.deepEqual(calls[1], ["notarytool", "log", "3333", "--keychain-profile", "notary"]);
  const offline = () => {
    const e = new Error("exit 1");
    e.stderr = "Error: No Keychain password item found for profile: notary";
    throw e;
  };
  assert.throws(() => notarize("/x/app.zip", { profile: "notary", exec: offline }), /could not submit app\.zip: Error: No Keychain password item/);
});

test("stapling is tried again while the ticket is not served yet, then fails with what stapler said", () => {
  let tries = 0;
  const waits = [];
  const flaky = (program, args) => {
    if (args[1] === "staple" && ++tries < 3) {
      const e = new Error("exit 65");
      e.stderr = "CloudKit query for Some.app failed due to \"Record Not Found\".";
      throw e;
    }
    return "";
  };
  staple("/x/Some.app", { exec: flaky, sleep: (ms) => waits.push(ms) });
  assert.equal(tries, 3);
  assert.deepEqual(waits, [20_000, 20_000]);
  const never = () => {
    const e = new Error("exit 65");
    e.stderr = "The staple and validate action failed! Error 65.";
    throw e;
  };
  assert.throws(() => staple("/x/Some.app", { exec: never, attempts: 2, sleep: () => {} }), /could not be stapled to Some\.app: The staple and validate action failed/);
});

const DEVELOPER_ID = `Executable=/x/Some.app/Contents/MacOS/Some
Identifier=app.busy.emulator
CodeDirectory v=20500 size=1000 flags=0x10000(runtime) hashes=20+7 location=embedded
Signature size=9000
Authority=Developer ID Application: Some One (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=13 Nov 2026 at 12:00:00
TeamIdentifier=ABCDE12345
`;
const AD_HOC = `Executable=/x/Some.app/Contents/MacOS/Some
CodeDirectory v=20400 size=1000 flags=0x2(adhoc) hashes=20+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
`;

test("codesign -dv read: the authority, the team, the hardened runtime, the timestamp; ad hoc is no Developer ID", () => {
  assert.deepEqual(signatureDetails("/x", () => DEVELOPER_ID), { authorities: ["Developer ID Application: Some One (ABCDE12345)", "Developer ID Certification Authority", "Apple Root CA"], team: "ABCDE12345", runtime: true, timestamp: true, adhoc: false });
  assert.deepEqual(signatureDetails("/x", () => AD_HOC), { authorities: [], team: null, runtime: false, timestamp: false, adhoc: true });
});

test("the signed app's checks name every program that is not signed as a release's, and Gatekeeper's refusal", { skip: process.platform !== "darwin" }, () => {
  const app = fakeApp(path.join(folder, "checks"));
  const node = path.join(app, "Contents", "Resources", "node", "bin", "node");
  const exec = (program, args) => {
    const command = args.join(" ");
    if (command.includes("codesign -dv")) return args.at(-1) === node ? AD_HOC : DEVELOPER_ID;
    if (command.includes("spctl")) {
      const e = new Error("exit 3");
      e.stdout = `${app}: rejected\nsource=Unnotarized Developer ID`;
      throw e;
    }
    return `${app}: valid on disk`;
  };
  const { problems, results } = signedAppProblems(app, { exec, sleep: () => {} });
  assert.equal(results.machO, 7);
  assert.deepEqual(problems, ["Contents/Resources/node/bin/node: signed by no one (ad hoc), without the hardened runtime, without a secure timestamp, by team none, not ABCDE12345", `spctl --assess --type execute: ${app}: rejected\nsource=Unnotarized Developer ID`]);
});

test("gh in a signed app carries the app's team, in an unsigned one GitHub's", { skip: process.platform !== "darwin" }, () => {
  const resources = path.join(folder, "gh", "Resources");
  write(path.join(resources, "gh", "bin", "gh"), MACHO_64);
  const pin = readGhPin().version;
  const runWith = (team) => (program, args) => (program === "/bin/sh" ? `Authority=x\nTeamIdentifier=${team}\n` : args[0] === "--version" ? `gh version ${pin} (2026-01-01)\n` : "");
  const work = path.join(folder, "gh", "work");
  assert.deepEqual(ghProblems({ resources, platform: "darwin", workDir: work, run: runWith("VEKTX9H2N7") }).problems, []);
  assert.deepEqual(ghProblems({ resources, platform: "darwin", workDir: work, appTeam: "ABCDE12345", run: runWith("ABCDE12345") }).problems, []);
  assert.match(ghProblems({ resources, platform: "darwin", workDir: work, appTeam: "ABCDE12345", run: runWith("VEKTX9H2N7") }).problems[0], /not signed by the app's team/);
  assert.match(ghProblems({ resources, platform: "darwin", workDir: work, run: runWith("ABCDE12345") }).problems[0], /not signed by GitHub/);
});

test("the entitlements: exactly the three the hardened runtime needs, each with a comment that says why", () => {
  const text = readFileSync(ENTITLEMENTS, "utf8");
  const keys = [...text.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]);
  for (const key of keys) assert.match(text, new RegExp(`<!-- [^>]+ -->\\s*<key>${key.replaceAll(".", "\\.")}</key>\\s*<true/>`), key);
});

test("the quarantine mark of a browser's download", () => {
  assert.equal(quarantineValue(Date.UTC(2026, 10, 13) + 999), `0081;${(Date.UTC(2026, 10, 13) / 1000).toString(16)};Safari;`);
});

test("stapler validate is asked again when Apple's ticket service drops the connection", () => {
  let asked = 0;
  const waits = [];
  const exec = () => {
    if (++asked < 3) {
      const e = new Error("exit 68");
      e.stdout = 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\nThe validate action failed! Error 68.';
      throw e;
    }
    return "The validate action worked!";
  };
  const ok = validateTicket("/x/Some.app", { exec, sleep: (ms) => waits.push(ms) });
  assert.deepEqual([ok.ok, ok.attempts, waits], [true, 3, [15_000, 15_000]]);
  const never = () => {
    const e = new Error("exit 65");
    e.stdout = "Some.app does not have a ticket stapled to it.";
    throw e;
  };
  const failed = validateTicket("/x/Some.app", { exec: never, attempts: 2, sleep: () => {} });
  assert.deepEqual([failed.ok, failed.attempts], [false, 2]);
  assert.match(failed.said, /does not have a ticket/);
});
