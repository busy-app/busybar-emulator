// Installing app archives the way busy-cli does — POST /api/apps/stage, then POST /api/apps/install?install_key=… —
// and what the emulator leaves on its /ext afterwards, compared with what a bar on firmware 1.3.1 leaves (EMU-223).
// The archives are in archives/ (made by archives/make.mjs); archives/bar-stage-1.3.1.json is what a bar answered to
// each and what its staging folder held right after (10.11.2026). Run: node --test emulator/test/install.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { Device } from "../packages/server/device.mjs";
import { loadFirmware } from "../packages/server/firmware.mjs";
import { MAX_DEPTH, MAX_ENTRIES, MAX_MADE, unpackPackage, UnpackError } from "../packages/server/tar.mjs";
import { visibleNames, volumeMakesSidecars } from "../packages/server/volume.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const archive = (name) => new Uint8Array(readFileSync(join(here, "archives", name)));
const decode = (body) => JSON.parse(new TextDecoder().decode(body));
// Two records of the same bar: the first 18 archives, then oversized-entry.tgz and the two damaged gzip streams. Of
// the latter, gzip-damaged-mid.tgz is one damage position only: the bar left nothing in staging for it, as the
// emulator does, which does not show what it does for damage elsewhere in a stream.
const BAR_STAGE = ["bar-stage-1.3.1.json", "bar-stage-1.3.1-more.json"].flatMap((f) => JSON.parse(readFileSync(join(here, "archives", f), "utf8")));

// On a temporary folder on FAT or exFAT (TMPDIR there), macOS adds its own "._" files, and an archive's "._" files
// beside their files cannot be listed (volume.mjs): the tests that expect those are skipped there.
const TMP_SIDECARS = volumeMakesSidecars(tmpdir()).sidecars;
const NEEDS_NATIVE = TMP_SIDECARS && 'the temporary folder is on a volume where macOS makes "._" files';

const folders = [];
after(() => {
  for (const f of folders) {
    rmSync(f, { recursive: true, force: true });
    rmSync(join(dirname(f), `._${basename(f)}`), { force: true }); // what macOS leaves beside it on FAT and exFAT
  }
});
const tempFolder = (parent = tmpdir()) => {
  const f = mkdtempSync(join(parent, "emu-install-"));
  folders.push(f);
  return f;
};

/** An emulated bar on a fresh data folder; `sidecars` as the volume probe would say (null: probe it). */
function bar({ root = tempFolder(), sidecars = TMP_SIDECARS } = {}) {
  const lines = [];
  const device = new Device({ dataDir: root, firmware: loadFirmware(), log: (line) => lines.push(line), ...(sidecars === null ? {} : { sidecars }) });
  const call = async (method, path, body = null) => {
    const r = await device.handle(method, `http://127.0.0.1${path}`, {}, body);
    return { status: r.status, body: decode(r.body) };
  };
  const list = async (path) => (await call("GET", `/api/storage/list?path=${encodeURIComponent(path)}`)).body.list;
  const listing = async (path, depth = 0) => {
    const out = [];
    for (const e of (await list(path)) ?? []) {
      if (e.type === "dir") out.push(`${"  ".repeat(depth)}${e.name}/`, ...(await listing(`${path}/${e.name}`, depth + 1)));
      else out.push(`${"  ".repeat(depth)}${e.name} (${e.size})`);
    }
    return out;
  };
  return {
    root,
    lines,
    call,
    list,
    /** A folder of the bar through GET /api/storage/list, written as the bar check wrote it: "  " a level, "name (size)". */
    listing,
    stage: (bytes) => call("POST", "/api/apps/stage", bytes),
    installKey: (key) => call("POST", `/api/apps/install?install_key=${key}`),
    async install(bytes) {
      const staged = await call("POST", "/api/apps/stage", bytes);
      if (staged.status !== 200) return { staged };
      return { staged, installed: await call("POST", `/api/apps/install?install_key=${staged.body.install_key}`) };
    },
    /** Every file and folder under /ext/<path> on the disk, as "path" or "path/", sorted. */
    tree(path) {
      const base = join(root, "ext", path);
      if (!existsSync(base)) return null;
      const out = [];
      const walk = (rel) => {
        for (const name of visibleNames(readdirSync(join(base, rel)), sidecars ?? TMP_SIDECARS)) {
          const p = rel ? `${rel}/${name}` : name;
          if (statSync(join(base, p)).isDirectory()) {
            out.push(p + "/");
            walk(p);
          } else out.push(p);
        }
      };
      walk("");
      return out.sort();
    },
  };
}

/** A tar made by hand: [name, content] is a file, [name] a folder. */
function tarOf(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const data = content === undefined ? Buffer.alloc(0) : Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(content === undefined ? "5" : "0", 156);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const NAMES_ID = "app.fixture.names";
/** An app package with more entries after the app's own. */
const appWith = (extra) =>
  tarOf([
    [`${NAMES_ID}/`],
    [`${NAMES_ID}/appmeta/`],
    [`${NAMES_ID}/appmeta/manifest.json`, JSON.stringify({ format_version: 1, id: NAMES_ID, name: "Fixture", version: "1.0.0", api_version: "27.12.0" })],
    [`${NAMES_ID}/scripts/`],
    [`${NAMES_ID}/scripts/main.js`, 'console.log("fixture");\n'],
    ...extra,
  ]);

const STAGING = "/ext/apps_data/js_app_installer/staging";
const APP_TREE = ["appmeta/", "appmeta/manifest.json", "scripts/", "scripts/main.js"];
const UNPACK = { error: "Cannot unpack", error_code: "unpack_error" };

/**
 * A listing of the emulator against the bar's, both as lines of `listing`; `dir` is the listed folder on the disk.
 * The emulator lists a folder by the time each entry was made (Device.listDir), which is the bar's order as far as
 * the volume's clock tells two entries apart. APFS tells every entry apart. NTFS stamps entries with a clock that
 * stepped every 0.5 or 1 ms on the Windows 10 it was measured on (15.6 ms is the Windows default) and exFAT every
 * 10 ms, while the unpacker makes an entry in about 0.25 ms (EMU-228). So entries the volume gave one time are
 * compared as a set, and everything else in order.
 */
function assertListedAsOnTheBar(listed, expected, dir) {
  const nest = (lines) => {
    const top = [];
    const open = [top];
    for (const line of lines) {
      const depth = (line.length - line.trimStart().length) / 2;
      const entry = { line: line.trim(), name: line.trim().replace(/\/$| \(\d+\)$/, ""), children: [] };
      open[depth].push(entry);
      open[depth + 1] = entry.children;
    }
    return top;
  };
  const compare = (mine, bars, at) => {
    // Runs of entries made at one time, each run sorted: [["a (1)"], ["b/", "c (2)"], …]
    const runs = (entries) => {
      const out = [];
      let last;
      for (const e of entries) {
        const born = existsSync(join(at, e.name)) ? statSync(join(at, e.name)).birthtimeMs : NaN;
        if (out.length && born === last) out.at(-1).push(e.line);
        else out.push([e.line]);
        last = born;
      }
      return out.map((run) => run.sort());
    };
    assert.deepEqual(runs(mine), runs(bars), `the listing of ${at}`);
    for (const e of bars) compare(mine.find((m) => m.line === e.line).children, e.children, join(at, e.name));
  };
  compare(nest(listed), nest(expected), dir);
}

// ---------------------------------------------------------------- every archive a bar staged

for (const expected of BAR_STAGE) {
  const hidden = expected.staging.some((line) => line.trim().startsWith("._")) && NEEDS_NATIVE;
  test(`${expected.archive}: the answer and the staging folder are the BUSY Bar's`, { skip: hidden }, async () => {
    const b = bar();
    const r = await b.stage(archive(expected.archive));
    const barBody = JSON.parse(expected.body);
    assert.equal(r.status, expected.status, JSON.stringify(r.body));
    if (barBody.install_key !== undefined) {
      assert.ok(Number.isInteger(r.body.install_key) && r.body.install_key > 0);
      r.body.install_key = barBody.install_key;
    }
    assert.deepEqual(r.body, barBody);
    assertListedAsOnTheBar(await b.listing(STAGING), expected.staging, join(b.root, "ext", STAGING.slice(5)));
  });
}

// ---------------------------------------------------------------- installs

test("the archive checked on a BUSY Bar: installed with the same files, listed the same way", { skip: NEEDS_NATIVE }, async () => {
  const b = bar();
  const { staged, installed } = await b.install(archive("bar-probe-appledouble.tgz"));
  assert.equal(staged.status, 200);
  assert.deepEqual(installed, { status: 200, body: { result: "OK" } });
  // GET /api/storage/list on the bar, 10.11.2026 (reports/EMU-223-bar/RESULT.md in the work folder). The fixture is a
  // rebuild of the archive installed there (sha256 e63a2ccb55a7d610335be51cf968fdf696e0a90006393e5abd79d4d76f6489fd)
  // with the same entries in the same order, of the same types and sizes (archives/make.mjs --macos).
  const at = "/ext/user_assets/app.probe.appledouble";
  assertListedAsOnTheBar(
    await b.listing(at),
    ["._appmeta (196)", "appmeta/", "  ._manifest.json (196)", "  manifest.json (230)", "._scripts (196)", "scripts/", "  ._main.js (196)", "  main.js (30)"],
    join(b.root, "ext", at.slice(5)),
  );
  assert.deepEqual(await b.list("/ext/user_assets"), [{ type: "dir", name: "app.probe.appledouble" }]);
  assert.deepEqual(await b.list(STAGING), [], "the staging folder is emptied");
  assert.deepEqual(await b.call("DELETE", "/api/apps?app_id=app.probe.appledouble"), { status: 200, body: { result: "OK" } });
  assert.deepEqual(b.tree("user_assets"), []);
});

async function installs(name, id, tree = APP_TREE) {
  const b = bar();
  const { staged, installed } = await b.install(archive(name));
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  assert.equal(staged.body.staged.id, id);
  assert.deepEqual(installed, { status: 200, body: { result: "OK" } });
  assert.deepEqual(b.tree("user_assets"), [`${id}/`, ...tree.map((p) => `${id}/${p}`)].sort(), "the app, and nothing else");
  assert.deepEqual(b.tree("apps_data/js_app_installer/staging"), [], "the staging folder is emptied");
  return b;
}

const APPLEDOUBLE_TREE = [
  "._appmeta", "._scripts", "appmeta/", "appmeta/._manifest.json", "appmeta/manifest.json", "scripts/", "scripts/._main.js", "scripts/main.js",
];
test("macOS tar with extended attributes: AppleDouble files kept, PAX headers skipped", { skip: NEEDS_NATIVE }, () =>
  installs("macos-appledouble.tgz", "app.fixture.mac", APPLEDOUBLE_TREE));
test("macOS tar with COPYFILE_DISABLE=1", () => installs("macos-clean.tgz", "app.fixture.mac"));
test("GNU format: a long name is cut to its 100-byte name field", () =>
  installs("gnu-tar.tgz", "app.fixture.gnu", [...APP_TREE, `app.fixture.gnu/scripts/${"long-name-".repeat(9)}end.js`.slice(16, 100)].sort()));
test("two app folders: the first one made is installed, the other is not", () => installs("two-apps.tgz", "app.fixture.first"));
test('a folder named "._<id>" before the app: the app is installed', () => installs("dot-underscore-dir.tgz", "app.fixture.hostile"));
test("an absolute name lands inside the staging folder and is not installed; nothing at /abs", async () => {
  await installs("absolute.tgz", "app.fixture.hostile");
  assert.equal(existsSync("/abs/evil.js"), false);
});
test("links are not made, on the disk either", () => installs("links.tgz", "app.fixture.hostile"));
test("the ustar prefix field is not read: the file stays outside the app", () => installs("ustar-prefix.tgz", "app.fixture.hostile"));

test("the icon path is the app's icon when there is one, the shared default otherwise", async () => {
  const b = bar();
  const { staged } = await b.install(archive("macos-clean.tgz"));
  assert.equal(staged.body.staged.icon_path, "/ext/apps_assets/shared/images/unknown_app_front_8x8.image");
  writeFileSync(join(b.root, "ext/user_assets/app.fixture.mac/appmeta/icon_front_8x8.png"), "png");
  const apps = (await b.call("GET", "/api/apps/list")).body.apps;
  assert.equal(apps[0].icon_path, "/ext/user_assets/app.fixture.mac/appmeta/icon_front_8x8.png");
});

// ---------------------------------------------------------------- keys, and refusals before the installer (api_apps.c)

test("one staged app: a new stage drops the earlier key, a key works once", async () => {
  const b = bar();
  const first = await b.stage(archive("macos-clean.tgz"));
  const second = await b.stage(archive("bar-probe-appledouble.tgz"));
  assert.equal((await b.installKey(first.body.install_key)).status, 400);
  assert.equal((await b.installKey(second.body.install_key)).status, 200);
  assert.equal((await b.installKey(second.body.install_key)).status, 400);
});

test("a failed stage drops the earlier key", async () => {
  const b = bar();
  const good = await b.stage(archive("macos-clean.tgz"));
  assert.equal((await b.stage(archive("bad-checksum.tgz"))).status, 400);
  assert.equal((await b.installKey(good.body.install_key)).status, 400);
});

test("a package over 100 MiB: 413 from the headers, and the earlier key still works", async () => {
  const b = bar();
  const good = await b.stage(archive("macos-clean.tgz"));
  assert.deepEqual(await b.stage(new Uint8Array(100 * 1024 * 1024 + 1)), { status: 413, body: { error: "Payload Too Large" } });
  assert.equal((await b.installKey(good.body.install_key)).status, 200);
});

test("an empty body: 400 Bad Request with no error code, and the earlier key still works", async () => {
  const b = bar();
  const good = await b.stage(archive("macos-clean.tgz"));
  assert.deepEqual(await b.call("POST", "/api/apps/stage"), { status: 400, body: { error: "Bad Request" } });
  assert.equal((await b.installKey(good.body.install_key)).status, 200);
});

test("the key is read as the BUSY Bar reads it: at most 10 characters, all of them a number", async () => {
  const b = bar();
  const { body } = await b.stage(archive("macos-clean.tgz"));
  const key = String(body.install_key);
  assert.equal((await b.installKey("0".repeat(11 - key.length) + key)).status, 400, "11 characters");
  assert.equal((await b.installKey(`${key}x`)).status, 400, "not all digits");
  assert.equal((await b.installKey("")).status, 400);
  assert.equal((await b.installKey("0".repeat(10 - key.length) + key)).status, 200, "10 characters with leading zeros");
});

// ---------------------------------------------------------------- the emulator's own protection

test(`more than ${MAX_ENTRIES} entries: "Cannot unpack", quickly, and the log says why`, async () => {
  const headers = [];
  for (let i = 0; i <= MAX_ENTRIES; i++) {
    const h = Buffer.alloc(512);
    h.write(`PaxHeader/d${i}`, 0); // entries that make nothing: only their number counts
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write("00000000000\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("x", 156);
    let sum = 0;
    for (const x of h) sum += x;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    headers.push(h);
  }
  const b = bar();
  const t = Date.now();
  assert.deepEqual(await b.stage(gzipSync(Buffer.concat([...headers, Buffer.alloc(1024)]))), { status: 400, body: UNPACK });
  assert.ok(Date.now() - t < 10_000);
  assert.ok(b.lines.some((l) => l.includes(`more than ${MAX_ENTRIES} entries`)));
});

test("an unpacked package over the size limit: refused before anything is written", () => {
  const dir = tempFolder();
  assert.throws(() => unpackPackage(archive("macos-clean.tgz"), dir, { maxBytes: 4096 }), UnpackError);
  assert.deepEqual(readdirSync(dir), []);
});

test("a gzip stream with a wrong CRC installs, as on a BUSY Bar, and the log says that the checksum does not match", async () => {
  const b = await installs("gzip-bad-crc.tgz", "app.fixture.mac");
  assert.equal(b.lines.filter((l) => /gzip checksum does not match \(CRC-32 74082839 in the archive, 740828c6 of its data\)/.test(l)).length, 1, b.lines.join("\n"));
  const sound = await installs("macos-clean.tgz", "app.fixture.mac");
  assert.equal(sound.lines.filter((l) => /checksum/.test(l)).length, 0);
});

for (const [name, why] of [["deep-folders.tgz", `more than ${MAX_DEPTH} levels deep`], ["many-folders.tgz", `more than ${MAX_MADE} files and folders`]]) {
  test(`${name}: few entries that make a great many folders, refused before writing, quickly`, async () => {
    const b = bar();
    const t = Date.now();
    assert.deepEqual(await b.stage(archive(name)), { status: 400, body: UNPACK });
    assert.ok(Date.now() - t < 3000, `${Date.now() - t} ms`);
    assert.deepEqual(await b.list(STAGING), []);
    assert.ok(b.lines.some((l) => l.includes(why)), b.lines.join("\n"));
    const t2 = Date.now();
    assert.equal((await b.stage(archive("macos-clean.tgz"))).status, 200);
    assert.ok(Date.now() - t2 < 1000, "the next stage has nothing to clear");
  });
}

test(`a path more than ${MAX_DEPTH} levels deep: refused`, async () => {
  const dir = tempFolder();
  const name = `${"a/".repeat(MAX_DEPTH)}x.js`;
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write("00000000000\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  let sum = 0;
  for (const x of h) sum += x;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  assert.throws(() => unpackPackage(Buffer.concat([h, Buffer.alloc(1024)]), dir), /levels deep/);
  assert.deepEqual(readdirSync(dir), []);
});

// "junction": a link to a folder that Windows lets any account make; elsewhere the word is not read.
test("a link out of the data folder above the staging folder is not followed", async () => {
  const root = tempFolder();
  const outside = tempFolder();
  mkdirSync(join(root, "ext", "apps_data"), { recursive: true });
  symlinkSync(outside, join(root, "ext", "apps_data", "js_app_installer"), "junction");
  const b = bar({ root });
  assert.deepEqual(await b.stage(archive("macos-clean.tgz")), { status: 400, body: UNPACK });
  assert.deepEqual(readdirSync(outside), [], "nothing made outside");
});

test("a link out of the data folder two levels above the staging folder: no folder is made outside either", async () => {
  const root = tempFolder();
  const outside = tempFolder();
  mkdirSync(join(root, "ext"));
  symlinkSync(outside, join(root, "ext", "apps_data"), "junction");
  const b = bar({ root });
  assert.deepEqual(await b.stage(archive("macos-clean.tgz")), { status: 400, body: UNPACK });
  assert.deepEqual(readdirSync(outside), [], "nothing made outside");
  assert.ok(b.lines.some((l) => l.includes("leads out of the data folder")), b.lines.join("\n"));
});

const MAC_APP = ["app.fixture.mac/", ...APP_TREE.map((p) => `app.fixture.mac/${p}`)].sort();

// What keeps a folder from being moved: on macOS and Linux, a parent folder that cannot be written; on Windows,
// where folders have no such permission, a file inside it that is open.
test("an install that cannot move the app in keeps the installed version and answers 400, not 500", { skip: TMP_SIDECARS && "permissions cannot be taken away on FAT or exFAT" }, async () => {
  const b = bar();
  assert.equal((await b.install(archive("macos-clean.tgz"))).installed.status, 200);
  const staged = await b.stage(archive("macos-appledouble.tgz"));
  const apps = join(b.root, "ext", "user_assets");
  const windows = process.platform === "win32";
  const held = windows ? openSync(join(apps, "app.fixture.mac", "scripts", "main.js"), "r") : chmodSync(apps, 0o555);
  try {
    const t = Date.now();
    assert.equal((await b.installKey(staged.body.install_key)).status, 400);
    if (!windows) assert.ok(Date.now() - t < 500, "no retries for a lasting refusal");
    else assert.ok(Date.now() - t > 2000, "ten tries over 2.25 s");
  } finally {
    if (windows) closeSync(held);
    else chmodSync(apps, 0o755);
  }
  assert.deepEqual(b.tree("user_assets"), MAC_APP);
  assert.deepEqual(b.tree("apps_data/js_app_installer/staging"), []);
  assert.equal(b.lines.filter((l) => /Cannot install app\.fixture\.mac: .*another program has one of these files or folders open/.test(l)).length, windows ? 1 : 0, b.lines.join("\n"));
  // Once it can be moved, the same install goes through.
  assert.equal((await b.install(archive("macos-appledouble.tgz"))).installed.status, 200);
});

test("the log says what was skipped, one line a kind", async () => {
  const b = bar();
  for (const name of ["links.tgz", "ustar-prefix.tgz", "gnu-tar.tgz", "macos-clean.tgz"]) await b.stage(archive(name));
  const said = (re) => b.lines.filter((l) => re.test(l)).length;
  assert.equal(said(/skipped 1 hard link entry/), 1);
  assert.equal(said(/skipped 1 symbolic link entry/), 1);
  assert.equal(said(/ustar prefix, which the BUSY Bar does not read: "app.fixture.hostile\/scripts\/extra.js" is written as "extra.js"/), 1);
  assert.equal(said(/skipped 1 GNU long name entry/), 1);
  assert.equal(said(/skipped 5 PAX header entries/), 1);
});

// ---------------------------------------------------------------- Windows: a file or a folder that another program uses

const WINDOWS_ONLY = process.platform !== "win32" && "Windows only: elsewhere a folder that a program stands in can be moved and deleted";

/** Another process whose current folder is `folder` for `ms`: on Windows the folder, and those above it, cannot be moved or deleted meanwhile. */
async function standIn(folder, ms) {
  const child = spawn(process.execPath, ["-e", `console.log("there"); setTimeout(() => {}, ${ms})`], { cwd: folder, stdio: ["ignore", "pipe", "ignore"] });
  const gone = once(child, "exit");
  await once(child.stdout, "data");
  return { child, gone };
}

test("Windows: a program that leaves the installed app within the retries — the install waits and goes through", { skip: WINDOWS_ONLY }, async () => {
  const b = bar();
  assert.equal((await b.install(archive("macos-clean.tgz"))).installed.status, 200);
  const staged = await b.stage(archive("macos-appledouble.tgz"));
  const { child, gone } = await standIn(join(b.root, "ext", "user_assets", "app.fixture.mac", "scripts"), 400);
  try {
    assert.deepEqual(await b.installKey(staged.body.install_key), { status: 200, body: { result: "OK" } });
    assert.deepEqual(b.tree("user_assets"), ["app.fixture.mac/", ...APPLEDOUBLE_TREE.map((p) => `app.fixture.mac/${p}`)].sort());
    assert.deepEqual(b.tree("apps_data/js_app_installer"), ["staging/"], "nothing left aside");
  } finally {
    child.kill();
    await gone;
  }
});

test("Windows: a program that leaves the staging folder within the retries — the next stage waits and goes through", { skip: WINDOWS_ONLY }, async () => {
  const b = bar();
  assert.equal((await b.stage(archive("macos-clean.tgz"))).status, 200);
  const { child, gone } = await standIn(join(b.root, "ext", "apps_data", "js_app_installer", "staging", "app.fixture.mac", "scripts"), 400);
  try {
    assert.equal((await b.stage(archive("gnu-tar.tgz"))).status, 200, b.lines.join("\n"));
    assert.deepEqual(await b.list(STAGING), [{ type: "dir", name: "app.fixture.gnu" }]);
  } finally {
    child.kill();
    await gone;
  }
});

test("Windows: a program that stays in the staging folder — the next stage answers 400 and the log says what to do", { skip: WINDOWS_ONLY }, async () => {
  const b = bar();
  assert.equal((await b.stage(archive("macos-clean.tgz"))).status, 200);
  const { child, gone } = await standIn(join(b.root, "ext", "apps_data", "js_app_installer", "staging", "app.fixture.mac", "scripts"), 60_000);
  try {
    assert.deepEqual(await b.stage(archive("gnu-tar.tgz")), { status: 400, body: UNPACK });
    assert.equal(b.lines.filter((l) => /Cannot unpack the app package: .*another program has one of these files or folders open/.test(l)).length, 1, b.lines.join("\n"));
  } finally {
    child.kill();
    await gone;
  }
  assert.equal((await b.stage(archive("gnu-tar.tgz"))).status, 200, "once it has left, the same stage goes through");
});

// ---------------------------------------------------------------- an install that did not finish (js_app_installer/replaced)

/** A data folder as the emulator leaves it when it stops between the two moves of an install: the installed version aside, its place empty. */
async function stoppedBetweenTheMoves() {
  const b = bar();
  assert.equal((await b.install(archive("macos-clean.tgz"))).installed.status, 200);
  const installer = join(b.root, "ext", "apps_data", "js_app_installer");
  renameSync(join(b.root, "ext", "user_assets", "app.fixture.mac"), join(installer, "replaced"));
  return { b, installer };
}

test("the emulator stopped between the two moves of an install: when it starts, the version moved aside is back", async () => {
  const { b: stopped, installer } = await stoppedBetweenTheMoves();
  const b = bar({ root: stopped.root });
  assert.deepEqual(b.tree("user_assets"), MAC_APP);
  assert.deepEqual(b.tree("apps_data/js_app_installer"), ["staging/"]);
  assert.deepEqual((await b.call("GET", "/api/apps/list")).body.apps.map((a) => a.id), ["app.fixture.mac"]);
  assert.equal(b.lines.filter((l) => /Put app\.fixture\.mac 1\.0\.0 back/.test(l)).length, 1, b.lines.join("\n"));
  assert.equal(existsSync(join(installer, "replaced")), false);
});

test("a version left aside while the emulator runs: the next install, of any app, puts it back and does not delete it", async () => {
  const { b } = await stoppedBetweenTheMoves();
  assert.equal((await b.install(archive("gnu-tar.tgz"))).installed.status, 200);
  assert.deepEqual((await b.call("GET", "/api/apps/list")).body.apps.map((a) => a.id).sort(), ["app.fixture.gnu", "app.fixture.mac"]);
  assert.deepEqual(b.tree("user_assets").filter((p) => p.startsWith("app.fixture.mac/")), MAC_APP);
  assert.deepEqual(b.tree("apps_data/js_app_installer"), ["staging/"]);
});

test("a version left aside whose place is taken is deleted, and the one in place is not touched", async () => {
  const { b: stopped, installer } = await stoppedBetweenTheMoves();
  const inPlace = join(stopped.root, "ext", "user_assets", "app.fixture.mac");
  cpSync(join(installer, "replaced"), inPlace, { recursive: true });
  writeFileSync(join(inPlace, "scripts", "main.js"), "// the newer version");
  const b = bar({ root: stopped.root });
  assert.deepEqual(b.tree("user_assets"), MAC_APP);
  assert.equal(readFileSync(join(inPlace, "scripts", "main.js"), "utf8"), "// the newer version");
  assert.deepEqual(b.tree("apps_data/js_app_installer"), ["staging/"]);
});

test("what stands aside but is no app the BUSY Bar would load, or is a link, is deleted and not moved in", async () => {
  // A manifest whose id leads out of the apps folder.
  const { b: first, installer } = await stoppedBetweenTheMoves();
  const manifest = join(installer, "replaced", "appmeta", "manifest.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), id: "../evil" }));
  const b = bar({ root: first.root });
  assert.deepEqual(b.tree("user_assets"), []);
  assert.deepEqual(b.tree("apps_data/js_app_installer"), ["staging/"]);
  assert.equal(existsSync(join(first.root, "ext", "evil")), false);
  // A link to an app outside the data folder.
  const { b: second, installer: installer2 } = await stoppedBetweenTheMoves();
  const outside = join(tempFolder(), "app.fixture.mac");
  renameSync(join(installer2, "replaced"), outside);
  symlinkSync(outside, join(installer2, "replaced"), "junction");
  const b2 = bar({ root: second.root });
  assert.deepEqual(b2.tree("user_assets"), []);
  assert.deepEqual(b2.tree("apps_data/js_app_installer"), ["staging/"]);
  assert.deepEqual(visibleNames(readdirSync(outside), TMP_SIDECARS).sort(), ["appmeta", "scripts"], "what the link led to is left alone");
});

// The old version is deleted only after the new one is in place, and replaced.done says that deleting is all that is
// left. Here the deleting fails (folders that cannot be written), the app is then removed, and the emulator starts
// again: what is left aside must not come back as an app.
test("an old version that could not be deleted after an install is not put back later", { skip: (process.platform === "win32" || TMP_SIDECARS) && "permissions cannot be taken away on Windows, FAT or exFAT" }, async () => {
  const b = bar();
  assert.equal((await b.install(archive("macos-clean.tgz"))).installed.status, 200);
  const old = ["appmeta", "scripts"].map((d) => join(b.root, "ext", "user_assets", "app.fixture.mac", d));
  const aside = ["appmeta", "scripts"].map((d) => join(b.root, "ext", "apps_data", "js_app_installer", "replaced", d));
  old.forEach((d) => chmodSync(d, 0o555)); // the folder moves, its files cannot be deleted
  try {
    assert.equal((await b.install(archive("macos-appledouble.tgz"))).installed.status, 200);
    assert.deepEqual(b.tree("apps_data/js_app_installer").filter((p) => /^[^/]+\/?$/.test(p)), ["replaced.done", "replaced/", "staging/"]);
    assert.deepEqual(await b.call("DELETE", "/api/apps?app_id=app.fixture.mac"), { status: 200, body: { result: "OK" } });
    const again = bar({ root: b.root });
    assert.deepEqual(again.tree("user_assets"), [], "the deleted app is not back");
    assert.ok(again.lines.some((l) => /Cannot clear what an install left/.test(l)), again.lines.join("\n"));
  } finally {
    aside.forEach((d) => existsSync(d) && chmodSync(d, 0o755));
  }
  const cleared = bar({ root: b.root });
  assert.deepEqual(cleared.tree("user_assets"), []);
  assert.deepEqual(cleared.tree("apps_data/js_app_installer"), ["staging/"]);
});

// ---------------------------------------------------------------- names that the computer's file system treats in its own way

const read = (b, path) => readFileSync(join(b.root, "ext", "user_assets", NAMES_ID, path), "utf8");

// FAT has no device names (FatFs, by its code; not checked on a bar), and FatFs drops dots and spaces at the end of
// a name (ff.c:2633–2668). On Windows the files are reached by their "\\?\" paths: checked there, EMU-228.
test("names Windows keeps for devices, and names that end in a dot or a space: written as FatFs writes them, removed with the app", async () => {
  const b = bar();
  const { installed } = await b.install(
    appWith([
      [`${NAMES_ID}/scripts/CON`, "con"], [`${NAMES_ID}/scripts/aux.js`, "aux"], [`${NAMES_ID}/NUL/`], [`${NAMES_ID}/NUL/com1.txt`, "com1"],
      [`${NAMES_ID}/scripts/dot.`, "dot"], [`${NAMES_ID}/sp /space `, "space"],
    ]),
  );
  assert.deepEqual(installed, { status: 200, body: { result: "OK" } });
  assert.deepEqual(
    b.tree("user_assets"),
    [NAMES_ID, "NUL", "NUL/com1.txt", ...APP_TREE.map((p) => p.replace(/\/$/, "")), "scripts/CON", "scripts/aux.js", "scripts/dot", "sp", "sp/space"]
      .map((p) => (p === NAMES_ID ? `${p}/` : `${NAMES_ID}/${p}${["NUL", "appmeta", "scripts", "sp"].includes(p) ? "/" : ""}`))
      .sort(),
  );
  assert.deepEqual(["scripts/CON", "scripts/aux.js", "NUL/com1.txt", "scripts/dot", "sp/space"].map((p) => read(b, p)), ["con", "aux", "com1", "dot", "space"]);
  assert.equal(b.lines.filter((l) => /device names on Windows/.test(l)).length, process.platform === "win32" ? 1 : 0, b.lines.join("\n"));
  assert.deepEqual(await b.call("DELETE", `/api/apps?app_id=${NAMES_ID}`), { status: 200, body: { result: "OK" } });
  assert.deepEqual(b.tree("user_assets"), []);
});

test("on Windows the log names the files that Explorer and the command prompt cannot open; elsewhere it says nothing", () => {
  const pack = appWith([[`${NAMES_ID}/scripts/CON`, "con"], [`${NAMES_ID}/scripts/aux.js`, "aux"], [`${NAMES_ID}/NUL/`], [`${NAMES_ID}/NUL/com1.txt`, "com1"], [`${NAMES_ID}/scripts/console.js`, "not one"]]);
  const windows = unpackPackage(pack, tempFolder(), { platform: "win32" }).notes;
  assert.equal(windows.length, 1);
  assert.match(windows[0], /^4 names are device names on Windows \("app\.fixture\.names\/scripts\/CON"\): written all the same, as FAT has no such names, but Explorer and the command prompt cannot open or delete such a file/);
  assert.deepEqual(unpackPackage(pack, tempFolder(), { platform: "darwin" }).notes, []);
});

// FAT finds a name whatever its case (ff.c cmp_lfn; by the firmware's code, not checked on a bar): the second
// spelling is the first one's file or folder. NTFS and APFS do so themselves; the unpacker does on any volume.
async function namesThatDifferByCase(parent) {
  const b = bar({ root: tempFolder(parent) });
  const { installed } = await b.install(
    appWith([
      [`${NAMES_ID}/scripts/Twin.js`, "first"], [`${NAMES_ID}/scripts/twin.js`, "second"],
      [`${NAMES_ID}/Lib/`], [`${NAMES_ID}/Lib/a.js`, "a"], [`${NAMES_ID}/lib/b.js`, "b"], [`${NAMES_ID}/LIB/A.JS`, "third"],
    ]),
  );
  assert.deepEqual(installed, { status: 200, body: { result: "OK" } });
  assert.deepEqual(b.tree("user_assets"), [`${NAMES_ID}/`, ...[...APP_TREE, "Lib/", "Lib/a.js", "Lib/b.js", "scripts/Twin.js"].map((p) => `${NAMES_ID}/${p}`)].sort());
  assert.deepEqual(["scripts/Twin.js", "Lib/a.js", "Lib/b.js"].map((p) => read(b, p)), ["second", "third", "b"]);
  // The app's folder in another case first: one folder under the first spelling, which is not the app's id.
  const upper = NAMES_ID.toUpperCase();
  const twice = appWith([]).subarray(512); // without the app's own folder entry
  assert.deepEqual(await b.stage(Buffer.concat([tarOf([[`${upper}/`]]).subarray(0, 512), twice])), { status: 400, body: { error: "Wrong app manifest", error_code: "manifest_error" } });
  assert.deepEqual((await b.list(STAGING)).map((e) => e.name), [upper]);
}
test("names that differ only by case are one file and one folder, as on FAT", () => namesThatDifferByCase());

// On a folder named by EMU_TEST_CASE_SENSITIVE_DIR (a folder the test may write into, on a volume that tells "A" from
// "a": Linux, case-sensitive APFS), where the computer's file system would keep both. Skipped when it is not set.
const caseDir = process.env.EMU_TEST_CASE_SENSITIVE_DIR;
test("names that differ only by case, on a volume that tells them apart (EMU_TEST_CASE_SENSITIVE_DIR)", { skip: !caseDir && "set EMU_TEST_CASE_SENSITIVE_DIR to a folder on a case-sensitive volume to run it" }, async () => {
  const probe = tempFolder(caseDir);
  writeFileSync(join(probe, "probe"), "");
  assert.equal(existsSync(join(probe, "PROBE")), false, "EMU_TEST_CASE_SENSITIVE_DIR is on a volume that tells \"A\" from \"a\"");
  await namesThatDifferByCase(caseDir);
});

// ---------------------------------------------------------------- "._" files of the computer's file system (volume.mjs)

test('the listing rule: every name on a volume without sidecars; "._X" beside "X" hidden on one with them', () => {
  const names = ["._a", "a", "._b", "._c.js", "c.js", "d"];
  assert.deepEqual(visibleNames(names, false), names);
  assert.deepEqual(visibleNames(names, true), ["a", "._b", "c.js", "d"]);
});

test("a volume with sidecars: the listing hides the system's files and the log says so once", { skip: NEEDS_NATIVE }, async () => {
  const b = bar({ sidecars: true });
  await b.install(archive("macos-clean.tgz"));
  // The system's files, as macOS makes them on exFAT, written here by hand on a volume that keeps attributes.
  const scripts = join(b.root, "ext/user_assets/app.fixture.mac/scripts");
  writeFileSync(join(scripts, "._main.js"), Buffer.alloc(4096));
  writeFileSync(join(scripts, "._orphan"), "x");
  // Sorted: the two may be made within one step of the volume's clock (assertListedAsOnTheBar).
  assert.deepEqual((await b.list("/ext/user_assets/app.fixture.mac/scripts")).map((e) => e.name).sort(), ["._orphan", "main.js"]);
  assert.equal(b.lines.filter((l) => /keeps file attributes in "\._" files/.test(l)).length, 1);
  assert.equal(bar({ sidecars: false }).lines.filter((l) => /"\._" files/.test(l)).length, 0);
});

test("the volume probe: a probe it cannot run is logged; probe files a stopped emulator left are removed", { skip: (process.platform !== "darwin" && "macOS only") || (TMP_SIDECARS && "permissions cannot be taken away on FAT or exFAT") }, () => {
  const ro = tempFolder();
  mkdirSync(join(ro, "ext"));
  chmodSync(ro, 0o555); // the data folder takes no new file; its ext folder does
  try {
    const probe = volumeMakesSidecars(ro);
    assert.equal(probe.sidecars, false);
    assert.match(probe.problem, /cannot write a file in the data folder/);
    const lines = [];
    new Device({ dataDir: ro, firmware: loadFirmware(), log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /Could not check whether the data folder's volume/.test(l)));
  } finally {
    chmodSync(ro, 0o755);
  }
  const root = tempFolder();
  writeFileSync(join(root, ".emu-volume-probe-999999"), ""); // no process has this number
  writeFileSync(join(root, "._.emu-volume-probe-999999"), "");
  writeFileSync(join(root, `.emu-volume-probe-${process.pid}0`), ""); // not a probe of this process either, and stopped
  mkdirSync(join(root, ".emu-volume-probe-999998")); // a folder with such a name is not a probe file: left alone
  assert.equal(volumeMakesSidecars(root).problem, undefined);
  assert.deepEqual(readdirSync(root).filter((n) => n.includes("emu-volume-probe")), [".emu-volume-probe-999998"]);
});

// On a FAT or exFAT folder named by EMU_TEST_SIDECAR_DIR (a folder the test may write into, on such a volume of this
// Mac): the probe says so, and an archive with no "._" files lists none. Skipped when the variable is not set.
const sidecarDir = process.env.EMU_TEST_SIDECAR_DIR;
test("on a FAT or exFAT folder (EMU_TEST_SIDECAR_DIR)", { skip: !sidecarDir && "set EMU_TEST_SIDECAR_DIR to a folder on a FAT or exFAT volume to run it" }, async () => {
  const root = tempFolder(sidecarDir);
  assert.equal(volumeMakesSidecars(root).sidecars, true, "EMU_TEST_SIDECAR_DIR is on a volume that makes \"._\" files");
  const b = bar({ root, sidecars: null });
  const { installed } = await b.install(archive("macos-clean.tgz"));
  assert.equal(installed.status, 200);
  const names = [];
  for (const p of ["/ext", "/ext/user_assets", "/ext/user_assets/app.fixture.mac", "/ext/user_assets/app.fixture.mac/scripts"]) {
    names.push(...(await b.list(p)).map((e) => e.name));
  }
  assert.deepEqual(names.filter((n) => n.startsWith("._")), []);
  assert.ok(b.lines.some((l) => /keeps file attributes in "\._" files/.test(l)));
});
