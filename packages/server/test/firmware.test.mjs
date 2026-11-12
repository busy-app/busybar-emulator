// The firmware the server runs: every version reports its own API version, and a build that is not the one
// firmware.json names is refused in one line.
//
//   node --test "packages/server/test/*.test.mjs"      (from emulator/)
//
// The servers listen on 127.0.0.1, on free ports (or on those EMU_TEST_PORTS names: test/server/helpers.mjs), with
// data folders in the system's temporary folder; both are gone when the test ends.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { port } from "../../../test/server/helpers.mjs";
import { FirmwareError, loadFirmware } from "../firmware.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(server, "../engine");
const emulator = join(server, "../..");
const config = JSON.parse(readFileSync(join(engine, "firmware.json"), "utf8"));

// ---------------------------------------------------------------- servers on different firmwares

// The firmwares in the repository may well report the same API version and ship the same local web (1.3.1 and dev
// do), and then a server that mixes them up, or answers with a version written into its code, looks right. So the
// servers of this test run from a copy where every firmware's build is marked as its own: an API version and a build
// date no other has, and a first page of the local web with the firmware's name in it (changed, not added: the number
// of files stays what build-info.json says).
//
// They run in this process, all at the same time, started by the copy's own startServer: anything about a firmware
// that was kept for the whole process rather than for a server would show as one server answering with another's.
describe("a server on each firmware, all in one process", () => {
  const versions = Object.keys(config.versions);
  const marks = Object.fromEntries(versions.map((version, i) => [version, { api: `27.${90 + i}.${i + 1}`, buildDate: `2001-0${i + 1}-1${i}` }]));
  const servers = {};
  const folders = [];
  let root;

  before(async () => {
    // Its real path: that is where a module loaded from it finds itself (the temporary folder may be a link).
    root = realpathSync(mkdtempSync(join(tmpdir(), "emu-server-marked-")));
    folders.push(root);
    cpSync(server, join(root, "packages/server"), { recursive: true, filter: (from) => from !== join(server, "test") });
    for (const file of ["firmware.json", "checks.mjs", "programs.mjs"]) cpSync(join(engine, file), join(root, "packages/engine", file));
    for (const folder of [...versions, "apps-assets"]) cpSync(join(engine, "build", folder), join(root, "packages/engine/build", folder), { recursive: true });
    for (const version of versions) {
      const dir = join(root, "packages/engine/build", version);
      const info = JSON.parse(readFileSync(join(dir, "build-info.json"), "utf8"));
      writeFileSync(join(dir, "build-info.json"), JSON.stringify({ ...info, ...marks[version] }));
      for (const page of ["index.html", "200.html"]) writeFileSync(join(dir, "web", page), `<!-- the local web of firmware ${version} -->\n${readFileSync(join(dir, "web", page), "utf8")}`);
    }
    const { startServer } = await import(pathToFileURL(join(root, "packages/server/server.mjs")).href);
    for (const [i, version] of versions.entries()) {
      const data = mkdtempSync(join(tmpdir(), "emu-server-test-"));
      folders.push(data);
      servers[version] = await startServer({ port: port(i), dataDir: data, firmware: version });
    }
  });
  after(async () => {
    await Promise.all(Object.values(servers).map((one) => one.stop()));
    for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  test("the marks tell every firmware from the others", () => {
    assert.equal(new Set(versions.map((v) => marks[v].api)).size, versions.length);
    for (const version of versions) assert.notEqual(marks[version].api, JSON.parse(readFileSync(join(engine, "build", version, "build-info.json"), "utf8")).api);
  });

  for (const version of versions) {
    test(`${version} reports the API version and the build date of its own build and serves its own local web, while the others run`, async () => {
      const { api, buildDate } = marks[version];
      const commit = config.versions[version].commit.slice(0, 8);
      const web = join(root, "packages/engine/build", version, "web");
      const running = servers[version];
      // What startServer says it started.
      assert.equal(running.apiVersion, api);
      assert.deepEqual({ name: running.firmware.name, buildDate: running.firmware.buildDate, web: running.firmware.web }, { name: version, buildDate, web });
      // And what the server answers.
      const address = running.url;
      const get = async (path) => (await fetch(`${address}${path}`)).json();
      assert.deepEqual(await get("/api/version"), { api_semver: api });
      assert.equal((await get("/api/status/system")).api_semver, api);
      assert.equal((await get("/api/status")).system.api_semver, api);
      const reported = await get("/api/status/firmware");
      assert.deepEqual({ version: reported.version, build_date: reported.build_date, commit_hash: reported.commit_hash }, { version, build_date: buildDate, commit_hash: commit });
      const state = await get("/_emu/state");
      assert.equal(state.api_version, api);
      assert.deepEqual(state.firmware, { name: version, commit });
      // A client that names the API version it was made for is told by this firmware's version, not another's.
      const sameMajor = await fetch(`${address}/api/status`, { headers: { "X-API-Sem-Ver": api } });
      assert.equal(sameMajor.status, 200);
      const page = await (await fetch(`${address}/`)).text();
      assert.ok(page.startsWith(`<!-- the local web of firmware ${version} -->\n`), `the first page is not the one of ${version}: ${page.slice(0, 60)}`);
      assert.equal(page, readFileSync(join(web, "index.html"), "utf8"));
      // A page inside the local web, and a client-side route, come from the same folder.
      assert.equal(await (await fetch(`${address}/some/route/of/the/app`)).text(), readFileSync(join(web, "200.html"), "utf8"));
    });
  }
});

test("no code answers with an API version of its own", () => {
  // spike/ is not in the public repository (its export leaves it out); where it is, it is read too.
  const sources = [server, join(emulator, "spike")].filter((dir) => dir === server || existsSync(dir)).flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => join(dir, f)));
  assert.ok(sources.length > 10);
  const literal = sources.filter((file) => /api_(semver|version)["']?\s*:\s*["'`]\d/.test(readFileSync(file, "utf8")));
  assert.deepEqual(literal, [], "the version comes from the build of the firmware that runs: firmware.apiVersion");
});

// ---------------------------------------------------------------- builds the server refuses

describe("a build the server cannot run", () => {
  const COMMIT = "1".repeat(40);
  let tmp;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "emu-server-refuse-"));
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  /** An engine folder with a made-up build of firmware "one"; returns the call that loads `firmware` from it. */
  function engineWith(name, { info, webFiles = ["index.html", "_nuxt/app.js"], firmware = "one" }) {
    const made = join(tmp, name);
    mkdirSync(join(made, "build/one"), { recursive: true });
    writeFileSync(join(made, "firmware.json"), JSON.stringify({ default: "one", versions: { one: { commit: COMMIT, summary: "Made up." } } }));
    for (const file of webFiles) {
      mkdirSync(dirname(join(made, "build/one/web", file)), { recursive: true });
      writeFileSync(join(made, "build/one/web", file), "x");
    }
    if (info) writeFileSync(join(made, "build/one/build-info.json"), JSON.stringify(info));
    return () => loadFirmware(firmware, made);
  }

  const good = { version: "one", firmware: COMMIT.slice(0, 8), commit: COMMIT, buildDate: "2001-02-03", api: "1.2.3", web: { files: 2 } };

  /** Refused: an error with this code, whose message is one line that matches every pattern. */
  function refused(load, code, ...patterns) {
    assert.throws(load, (error) => {
      assert.ok(error instanceof FirmwareError, String(error));
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /\n/);
      for (const pattern of patterns) assert.match(error.message, pattern);
      return true;
    });
  }

  test("a whole build of the commit firmware.json names is loaded, by name or as the default", () => {
    for (const firmware of ["one", undefined, ""]) {
      const loaded = engineWith(`good-${firmware}`, { info: good, firmware })();
      assert.deepEqual({ name: loaded.name, commit: loaded.commit, apiVersion: loaded.apiVersion, buildDate: loaded.buildDate }, { name: "one", commit: COMMIT, apiVersion: "1.2.3", buildDate: "2001-02-03" });
      assert.equal(loaded.web, join(tmp, `good-${firmware}`, "build/one/web"));
    }
  });

  test("a firmware that is not in firmware.json", () => {
    refused(engineWith("unknown", { info: good, firmware: "two" }), "unknown-firmware", /Unknown firmware "two"\./, /The emulator has: one/);
  });

  test("no build at all", () => {
    refused(engineWith("none", { info: null }), "not-built", /Firmware "one" is not built/, /build\.mjs --firmware one/, /--emsdk <path>, --firmware-repo <path>/);
  });

  test("a build made before the commit was recorded", () => {
    const old = { version: "one", firmware: COMMIT.slice(0, 8), optimized: true };
    refused(engineWith("old", { info: old }), "old-build", /was made by an older build script/, /does not record the firmware commit/, /build\.mjs --firmware one/);
  });

  test("a build of another commit: both commits in full", () => {
    const other = "2".repeat(40);
    refused(engineWith("other", { info: { ...good, commit: other } }), "other-commit", new RegExp(`was made from firmware commit ${other}, and firmware\\.json names ${COMMIT}\\.`), /build\.mjs --firmware one/);
  });

  test("a local web that lost a file", () => {
    refused(engineWith("partial", { info: { ...good, web: { files: 3 } } }), "web-not-whole", /The local web of firmware "one" in .*web is not whole: 2 of 3 files\./, /build\.mjs --firmware one/);
  });

  test("a local web with only its first page", () => {
    refused(engineWith("first-page", { info: good, webFiles: ["index.html"] }), "web-not-whole", /is not whole: 1 of 2 files\./);
  });

  test("the command line says it in one line and ends with code 1, before it listens anywhere", () => {
    const result = spawnSync(process.execPath, [join(server, "index.mjs"), "--firmware", "no-such-firmware", "--port", "1"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Unknown firmware "no-such-firmware"\. The emulator has: .*\n$/);
  });
});
