// Report a Bug (report-actions.mjs, scrub.mjs, zip.mjs): what the issue's form and the diagnostics archive hold, and
// what they must not. The person's home folder, user and computer names, tokens, Wi-Fi names, serials and MACs are put
// into the data folder's log and state, as they could come there; neither the form's text, nor its address, nor any
// file of the archive has them. The form's address fits GitHub's and Windows' limits however long the log is. Nothing
// here opens a browser: the opener is a stand-in that keeps the address.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";

import { composeIssue, createReportActions, fieldsOf, NEW_ISSUE, pngOf, REPORT_ACTIONS, REPORT_NO_GESTURE, systemOf, URL_LIMITS, urlLimitFor } from "../../src/report-actions.mjs";
import { createScrubber } from "../../src/scrub.mjs";
import { crc32, makeZip, readZip } from "../../src/zip.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const folders = [];
after(async () => {
  for (const folder of folders) await removeFolder(folder);
});

// What a person's machine could leave in a log. Made up, in the shapes the real ones have; put together at run time,
// as the export check keeps such shapes out of the repository's files.
const glue = (...parts) => parts.join("");
const macHome = (name) => ["", "Users", name].join("/");
const winHome = (name, sep = "\\") => ["C:", "Users", name].join(sep);
const PERSON = { home: macHome("dana.l"), user: "dana.l", host: "Danas-MacBook-Pro.local" };
const WINDOWS_PERSON = { home: winHome("Dana"), user: "Dana", host: "DESKTOP-7Q2RT9" };
const SECRETS = {
  ghp: glue("gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8"),
  gho: glue("gh", "o_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt", "3Ss2Rr1Qq0Pp9Oo8"),
  ghs: glue("gh", "s_", "0123456789abcdefghij", "ABCDEFGHIJ012345"),
  pat: glue("github", "_pat_", "11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ0123456789", "abcdefghijklmnopqrstuvwxyzABCDE"),
  bearer: glue("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
  pw: glue("hunter2", "-correct-horse"),
  wifi: "Kitchen Router 5G",
  wifiBare: "CafeNet",
  serial: glue("5eed", "0a1b2c3d4e5f60718293"),
  serialOther: glue("5eed", "ffeeddccbbaa99887766"),
  serialNamed: "SN-AB12CD34",
  mac: ["a4", "83", "e7", "1f", "0c", "9b"].join(":"),
  macDashes: ["A4", "83", "E7", "1F", "0C", "9C"].join("-"),
  email: "dana@example.org",
};
const LEAKS = [PERSON.home, "dana.l", "Danas-MacBook-Pro", winHome("Dana"), winHome("Dana", "\\\\"), ...Object.values(SECRETS)];

const LOG_LINES = [
  `2026-11-12T10:00:00.000Z [shell] started: BUSY Bar Emulator 0.1.0-beta.1 from ${PERSON.home}/Applications/BUSY Bar Emulator.app`,
  `2026-11-12T10:00:01.000Z [server] project ${PERSON.home}/BUSY Bar projects/weather opened on Danas-MacBook-Pro.local by dana.l`,
  `2026-11-12T10:00:02.000Z [github] gh said: token ${SECRETS.ghp} in keyring; GH_TOKEN=${SECRETS.gho}`,
  `2026-11-12T10:00:03.000Z [server] fetch failed: Authorization: Bearer ${SECRETS.bearer}`,
  `2026-11-12T10:00:04.000Z [server] {"ssid": "${SECRETS.wifi}", "password": "${SECRETS.pw}", "serial_number": "${SECRETS.serialNamed}"}`,
  `2026-11-12T10:00:05.000Z [server] wifi: connect ssid=${SECRETS.wifiBare}&pass=x, Wi-Fi "${SECRETS.wifi}" up`,
  `2026-11-12T10:00:06.000Z [server] bar ${SECRETS.serial} and ${SECRETS.serialOther}: usb_mac ${SECRETS.mac}, wifi_mac ${SECRETS.macDashes}`,
  `2026-11-12T10:00:07.000Z [cli] ${winHome("Dana")}\\AppData\\Local\\x and {"path":"${winHome("Dana", "\\\\")}\\\\proj"} on Danas-MacBook-Pro`,
  `2026-11-12T10:00:08.000Z [github] app token ${SECRETS.ghs}; fine-grained ${SECRETS.pat}; mail ${SECRETS.email}`,
  "2026-11-12T10:00:09.000Z [server] 02:04:29 Launch app.example.weather (heap 128 KiB); POST /api/input?key=ok",
];

function dataFolder({ lines = LOG_LINES, extraLines = 0 } = {}) {
  const dataDir = realpathSync(temporaryFolder());
  folders.push(dataDir);
  mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  mkdirSync(path.join(dataDir, "run"), { recursive: true });
  const filler = Array.from({ length: extraLines }, (_, i) => `2026-11-12T09:00:00.000Z [server] filler line ${i} ${"x".repeat(150)} ${PERSON.home}/f${i}`);
  writeFileSync(path.join(dataDir, "logs", "shell.log"), `${[...filler, ...lines].join("\n")}\n`);
  writeFileSync(path.join(dataDir, "logs", "shell.log.1"), `older line in ${PERSON.home}/old with ${SECRETS.ghp}\n`);
  writeFileSync(path.join(dataDir, "run", "server.lock"), JSON.stringify({ pid: 1, exe: `${PERSON.home}/x/node`, firmware: "1.3.1", apiVersion: "27.14.0", nonce: "s3cr3t-nonce-value" }));
  writeFileSync(path.join(dataDir, "run", "emulator.json"), JSON.stringify({ pid: 1, exe: `${PERSON.home}/Applications/BUSY Bar Emulator.app/Contents/MacOS/BUSY Bar Emulator`, state: "ready" }));
  writeFileSync(path.join(dataDir, "run", "build-lines.jsonl"), `${JSON.stringify({ line: `built ${PERSON.home}/BUSY Bar projects/weather`, ssid: SECRETS.wifi })}\n`);
  writeFileSync(path.join(dataDir, "app-settings.json"), JSON.stringify({ welcomed: true, owner: SECRETS.email }));
  return dataDir;
}

const ABOUT = () => ({ version: "0.1.0-beta.1", build: "release", system: systemOf({ platform: "darwin", version: "15.6.0", arch: "arm64" }), electron: "45.2.3" });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a picture, but a PNG's signature")]);
const IMAGE = `data:image/png;base64,${PNG.toString("base64")}`;

function actionsFor(dataDir, { urlLimit, saveAs = null, person = PERSON } = {}) {
  const done = { opened: [], images: [], shown: [], asked: [], logs: [] };
  const actions = createReportActions({
    dataDir,
    logFile: path.join(dataDir, "logs", "shell.log"),
    about: ABOUT,
    openExternal: (url) => done.opened.push(url),
    copyImage: (png) => done.images.push(png),
    dialog: {
      save: async (kind, defaultPath, texts) => {
        done.asked.push({ kind, defaultPath, texts });
        return saveAs;
      },
    },
    show: (file) => done.shown.push(file),
    folders: { downloads: path.join(dataDir, "Downloads") },
    person,
    log: (line) => done.logs.push(line),
    // The paths are this system's; the address's limit is said: the longer one unless a test names Windows'.
    platform: process.platform,
    urlLimit: urlLimit ?? URL_LIMITS.other,
    now: () => Date.UTC(2026, 10, 12, 12, 0, 0),
  });
  return { actions, done };
}

const value = async (call) => {
  const answer = await call;
  assert.equal(answer.ok, true, JSON.stringify(answer.error));
  return answer.value;
};
const bodyOf = (url) => new URL(url).searchParams.get("body");
const assertClean = (text, where) => {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${where} has ${JSON.stringify(leak)}`);
  assert.ok(!/\/Users\/(?!<user>|Shared)[^/\s]/.test(text), `${where} has a /Users/ path`);
};

test("the scrubber takes out home paths, user and computer names, tokens, Wi-Fi names, serials, MACs and e-mail addresses", () => {
  const scrub = createScrubber(PERSON);
  const all = scrub(LOG_LINES.join("\n"));
  assertClean(all, "the scrubbed log");
  assert.match(all, /<home>\/BUSY Bar projects\/weather/);
  assert.match(all, /<token>/);
  assert.match(all, /"ssid": "<wifi>"/);
  assert.match(all, /ssid=<wifi>&/);
  assert.match(all, /Wi-Fi "<wifi>"/);
  assert.match(all, /"serial_number": "<serial>"/);
  assert.match(all, /bar <serial> and <serial>/);
  assert.match(all, /usb_mac <mac>, wifi_mac <mac>/);
  assert.match(all, /"password": "<hidden>"/);
  assert.match(all, /Authorization: Bearer <token>/);
  assert.match(all, /mail <email>/);
  assert.match(all, /on <computer>\.local by <user>|on <computer> by <user>/);
  // Another person's folder on the same machine goes too; what is no one's stays.
  assert.equal(scrub(`${macHome("olga")}/x /Users/Shared/y ${["", "home", "olga"].join("/")}/z`), "/Users/<user>/x /Users/Shared/y /home/<user>/z");
  // The rest of a log line is left as it is: times, sizes, the bar's own keys.
  const plain = "2026-11-12T10:00:09.000Z [server] 02:04:29 Launch app.example.weather (heap 128 KiB); POST /api/input?key=ok; tokenizer: on; commit 7bec67b1a2c3";
  assert.equal(scrub(plain), plain);
});

test("the scrubber knows Windows' homes: either separator, doubled as JSON writes them, any letter case", () => {
  const scrub = createScrubber(WINDOWS_PERSON);
  const olga = ["D:", "Users", "Olga"].join("\\");
  const text = scrub(`${winHome("Dana")}\\AppData\\x; {"p":"${winHome("Dana", "\\\\")}\\\\proj"}; ${["c:", "users", "dana"].join("/")}/y; ${olga}\\z; C:\\Users\\Public\\w; on DESKTOP-7Q2RT9 by Dana`);
  assert.equal(text, String.raw`<home>\AppData\x; {"p":"<home>\\proj"}; <home>/y; D:\Users\<user>\z; C:\Users\Public\w; on <computer> by <user>`);
  // A name too short to tell from a word is not taken as a user name; the folder under Users still goes.
  assert.equal(createScrubber({ home: winHome("al"), user: "al" })(`al in ${winHome("al")}\\x`), "al in <home>\\x");
});

test("the scrubber takes out the system's temporary folder: as given, by its real path, any account's on macOS, inside a Windows home", () => {
  const id = ["sy", "1p8vw6hn6hzfkt5s7k2327jh0000gn"].join("/");
  // Put together at run time, for the export check.
  const folders = ["", "var", "folders"].join("/");
  const temp = `${folders}/${id}/T/`;
  const scrub = createScrubber({ ...PERSON, temp: [temp, `/private${temp}`] });
  assert.equal(scrub(`${temp}busy-app-1-x/data and /private${temp}busy-app-2/y`), "<temp>/busy-app-1-x/data and <temp>/busy-app-2/y");
  // Another account's, or one the app was not told of: the shape alone.
  assert.equal(createScrubber(PERSON)(`${folders}/ab/${"0".repeat(10)}xyz/T/run`), "<temp>/run");
  // On Windows %TEMP% is inside the home: it goes as <temp>, not as <home>\AppData\Local\Temp.
  const winTemp = `${winHome("Dana")}\\AppData\\Local\\Temp`;
  assert.equal(createScrubber({ ...WINDOWS_PERSON, temp: [winTemp] })(`${winTemp}\\busy-app-3\\z and ${winHome("Dana")}\\x`), "<temp>\\busy-app-3\\z and <home>\\x");
});

test("the scrubber takes out GitHub logins: the ones it is told of and the ones a line names as signed in (EMU-292)", () => {
  const scrub = createScrubber({ ...PERSON, logins: ["octo-noted"] });
  const text = scrub(
    [
      "[github] signed in as octo-own through GitHub CLI; GitHub CLI uses octo-before again",
      "[github] using GitHub CLI's account octo-third",
      "GitHub CLI on this computer has 2 accounts: octo-own, octo-before (it uses octo-before).",
      "Logged in to github.com account octo-gh (keyring)",
      "forked https://github.com/octo-noted/busy-apps-catalog for OCTO-NOTED",
      '{"login":"octo-json","previous":"octo-prev"}',
    ].join("\n"),
  );
  for (const login of ["octo-own", "octo-before", "octo-third", "octo-gh", "octo-noted", "OCTO-NOTED", "octo-json", "octo-prev"]) assert.ok(!new RegExp(`(?<![\\w-])${login}(?![\\w-])`).test(text), `${login} in ${text}`);
  assert.match(text, /signed in as <github-user> through GitHub CLI; GitHub CLI uses <github-user> again/);
  assert.match(text, /https:\/\/github\.com\/<github-user>\/busy-apps-catalog/);
  // The words those lines hold that are no login stay, and so does the catalog's owner.
  const plain = "GitHub CLI on this computer is signed in as, the account; busy-app/busy-apps-catalog; signed in as the account";
  assert.equal(scrub(plain), plain);
});

test("the scrubber takes out the folders of paths outside the home folder, the file's name kept (EMU-292)", () => {
  const scrub = createScrubber({ ...PERSON, projects: ["/srv/work/Client Co/weather", ["D:", "Work", "clock"].join("\\")] });
  const volume = ["", "Volumes", "Olga SSD", "Busy", "apps", "weather"].join("/");
  assert.equal(scrub(`built ${volume}/src/main.js:10:5 in 2 s`), "built /Volumes/<path>/<path>/<path>/<path>/<path>/main.js:10:5 in 2 s");
  assert.equal(scrub(`opened ${volume}`), "opened /Volumes/<path>/<path>/<path>/<path>");
  assert.equal(scrub(`file://${volume}/x.png`), "file:///Volumes/<path>/<path>/<path>/<path>/x.png");
  assert.equal(scrub("/mnt/data/projects/a.json"), "/mnt/<path>/<path>/a.json");
  // A project the app knows of, wherever it is.
  assert.equal(scrub("watching /srv/work/Client Co/weather/src/main.js"), "watching /<path>/<path>/<path>/<path>/<path>/main.js");
  // Windows: any disk's folders, either separator, doubled as JSON writes them; the system's own folders stay.
  const win = (...parts) => parts.join("\\");
  assert.equal(
    scrub(`${win("D:", "Work", "clock", "src", "main.js")} and {"p":"${win("E:", "", "Apps", "", "x", "", "app.json")}"} and ${win("C:", "Projects", "a b", "c.json")}`),
    String.raw`D:\<path>\<path>\<path>\main.js and {"p":"E:\\<path>\\<path>\\app.json"} and C:\<path>\<path>\c.json`,
  );
  const system = String.raw`C:\Program Files\BUSY Bar Emulator\x.exe; C:\Windows\System32\cmd.exe`;
  assert.equal(scrub(system), system);
  // Inside the home folder it goes as before; the bar's paths and the server's addresses stay.
  assert.equal(scrub(`${PERSON.home}/BUSY Bar projects/weather/a.js`), "<home>/BUSY Bar projects/weather/a.js");
  const bar = "GET /api/status 200; /ext/user_assets/app.x/scripts/main.js; http://127.0.0.1:8640/api/screen?display=0; /Applications/BUSY Bar Emulator.app";
  assert.equal(scrub(bar), bar);
});

test("the scrubber takes out the values of a query's keys that look like secrets, the keys kept (EMU-292)", () => {
  const scrub = createScrubber(PERSON);
  const hex = glue("0123456789abcdef", "fedcba9876543210");
  const mixed = glue("Zq9xW2", "vK7pL4mN8bR3tY6uA1sD5fG0hJ");
  const google = glue("AIza", "SyA1234567890abcdefghijklmnopqrstuv");
  assert.equal(
    scrub(`fetch https://api.example.org/data/2.5/weather?q=Berlin&appid=${hex}&units=metric`),
    "fetch https://api.example.org/data/2.5/weather?q=Berlin&appid=<hidden>&units=metric",
  );
  assert.equal(scrub(`GET https://x.example/v1?units=metric&lang=en&key=${mixed}`), "GET https://x.example/v1?units=metric&lang=en&key=<hidden>");
  assert.equal(scrub(`?id=${hex}&q=x`), "?id=<hidden>&q=x");
  assert.equal(scrub(`?k=${google}`), "?k=<token>");
  assert.equal(scrub(`?sig=abcdef0123456789&ts=1731400000`), "?sig=<hidden>&ts=1731400000");
  assert.equal(scrub(`appid: ${hex} and appid=short`), "appid: <hidden> and appid=<hidden>");
  // The bar's own keys and the app's ids stay.
  const plain = "POST /api/input?key=ok; GET /api/apps/settings?app_id=app.example.weather.forecast.daily.widget; ?display=1&scale=4";
  assert.equal(scrub(plain), plain);
});

test("a long run of backslashes, as JSON escapes a Windows path again and again, takes no time (EMU-292)", () => {
  const scrub = createScrubber({ ...WINDOWS_PERSON, projects: [["D:", "Work", "clock"].join("\\")] });
  const started = Date.now();
  const text = `${"\\".repeat(4000)} a b c ${"\\".repeat(60)}D:${"\\".repeat(60)}x`;
  scrub(text.repeat(50));
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

test("the form and the archive are scrubbed of the noted login, the logins the log names and the listed projects' folders (EMU-292)", async () => {
  const project = ["", "srv", "Client Co", "weather"].join("/");
  const hex = glue("0123456789abcdef", "fedcba9876543210");
  const dataDir = dataFolder({
    lines: [
      ...LOG_LINES,
      "2026-11-12T10:01:00.000Z [github] signed in as octo-own through GitHub CLI",
      "2026-11-12T10:01:01.000Z [github] forked busy-app/busy-apps-catalog to octo-own/busy-apps-catalog for octo-noted",
      `2026-11-12T10:01:02.000Z [server] build ${project}/src/main.js; fetch https://api.example.org/w?q=x&appid=${hex}`,
    ],
  });
  mkdirSync(path.join(dataDir, "github"), { recursive: true });
  writeFileSync(path.join(dataDir, "github", "signed-in.json"), JSON.stringify({ login: "octo-noted", origin: "app" }));
  mkdirSync(path.join(dataDir, "projects"), { recursive: true });
  writeFileSync(path.join(dataDir, "projects", "registry.json"), JSON.stringify({ version: 1, projects: [{ path: project, id: "app.x" }] }));
  const out = path.join(dataDir, "Chosen");
  mkdirSync(out);
  const { actions } = actionsFor(dataDir, { saveAs: path.join(out, "r") });
  const leaks = ["octo-own", "octo-noted", "Client Co", hex];
  const preview = await value(actions.call("report.preview", { title: "x", what: "as octo-noted", log: true }));
  for (const leak of leaks) assert.ok(!preview.body.includes(leak), `the preview has ${leak}`);
  assert.match(preview.body, /forked busy-app\/busy-apps-catalog to <github-user>\/busy-apps-catalog for <github-user>/);
  assert.match(preview.body, /build \/<path>\/<path>\/<path>\/<path>\/main\.js; fetch https:\/\/api\.example\.org\/w\?q=x&appid=<hidden>/);
  const saved = await value(actions.call("report.save", { title: "x", what: "as octo-noted", log: true }));
  for (const [name, data] of readZip(readFileSync(saved.file))) for (const leak of leaks) assert.ok(!data.toString("utf8").includes(leak), `${name} has ${leak}`);
});

test("the actions the page may ask for: the preview reads, the rest need the person's click", () => {
  assert.deepEqual(REPORT_ACTIONS, ["report.preview", "report.open", "report.save", "report.reveal"]);
  assert.deepEqual(REPORT_NO_GESTURE, ["report.preview"]);
  assert.equal(urlLimitFor("win32"), URL_LIMITS.win32);
  assert.equal(urlLimitFor("darwin"), URL_LIMITS.other);
  assert.ok(URL_LIMITS.win32 <= 2048 && URL_LIMITS.other <= 8192);
});

test("the form's text: what the person wrote, the emulator, the system, the firmware and the log, scrubbed; the address opens it as shown", async () => {
  const dataDir = dataFolder();
  const { actions, done } = actionsFor(dataDir);
  const fields = { title: `Crash in ${PERSON.home}/weather`, what: `Opened the app from ${PERSON.home}/BUSY Bar projects/weather with ${SECRETS.ghp}`, expected: "It runs", log: true, screenshot: false };
  const preview = await value(actions.call("report.preview", fields));
  assertClean(`${preview.title}\n${preview.body}`, "the preview");
  assert.equal(preview.title, "Crash in <home>/weather");
  assert.match(preview.body, /^### What I did\nOpened the app from <home>\/BUSY Bar projects\/weather with <token>\n\n### What I expected\nIt runs\n/);
  assert.match(preview.body, /- Version: 0\.1\.0-beta\.1\n- System: macOS 15\.6\.0, arm64\n- Firmware: 1\.3\.1, API 27\.14\.0/);
  assert.match(preview.body, /The last 11 lines of the emulator's log:/);
  assert.ok(!preview.body.includes("s3cr3t-nonce-value"));
  assert.equal(preview.repository, "busy-app/busybar-emulator");
  assert.equal(preview.fits, true);

  const opened = await value(actions.call("report.open", fields));
  assert.equal(opened.opened, true);
  assert.equal(done.opened.length, 1);
  const url = done.opened[0];
  assert.ok(url.startsWith(`${NEW_ISSUE}?`), url);
  assert.equal(new URL(url).searchParams.get("title"), preview.title);
  assert.equal(bodyOf(url), preview.body, "the browser gets the text the dialog showed");
  assertClean(decodeURIComponent(url), "the address");
  assert.ok(url.length <= URL_LIMITS.other);
  // No screenshot asked for: the clipboard is left alone.
  assert.deepEqual(done.images, []);

  // Without the log's lines, the text has none; without anything written, it says so.
  const bare = await value(actions.call("report.preview", { log: false }));
  assert.ok(!bare.body.includes("### Log"));
  assert.match(bare.body, /### What I did\n_Not filled in\._/);
  assert.equal(bare.title, "");
  await value(actions.call("report.open", { log: false }));
  assert.ok(!new URL(done.opened[1]).searchParams.has("title"), "no empty title");
});

test("the form opens with the log's lines the dialog showed, not with lines the log got after", async () => {
  const dataDir = dataFolder();
  const { actions, done } = actionsFor(dataDir);
  const preview = await value(actions.call("report.preview", { what: "x" }));
  writeFileSync(path.join(dataDir, "logs", "shell.log"), "2026-11-12T11:00:00.000Z [shell] a line written after the preview\n", { flag: "a" });
  await value(actions.call("report.open", { what: "x" }));
  assert.equal(bodyOf(done.opened[0]), preview.body);
  // The next preview reads the log anew.
  assert.match((await value(actions.call("report.preview", { what: "x" }))).body, /a line written after the preview/);
});

test("a long log is cut to the lines that fit, from the newest back; the form says the archive has the rest; Windows' limit is kept", async () => {
  const dataDir = dataFolder({ extraLines: 400 });
  for (const limit of [URL_LIMITS.other, URL_LIMITS.win32]) {
    const { actions, done } = actionsFor(dataDir, { urlLimit: limit });
    const preview = await value(actions.call("report.preview", { what: "x", expected: "y" }));
    assert.equal(preview.fits, true);
    assert.ok(preview.length <= limit, `${preview.length} > ${limit}`);
    assert.ok(preview.lines.shown < preview.lines.of, JSON.stringify(preview.lines));
    assert.equal(preview.lines.of, 40);
    assert.match(preview.body, /the rest did not fit in the form\. The whole log is in the diagnostics archive/);
    // The newest line is there; the cut is at the old end.
    if (preview.lines.shown > 0) assert.match(preview.body, /POST \/api\/input\?key=ok\n`{3,}/);
    await value(actions.call("report.open", { what: "x", expected: "y" }));
    assert.ok(done.opened[0].length <= limit);
    assertClean(decodeURIComponent(done.opened[0]), `the address at ${limit}`);
  }
  // Text of the person's own too long for Windows' address: refused with what to do, nothing opened.
  const { actions, done } = actionsFor(dataDir, { urlLimit: URL_LIMITS.win32 });
  const preview = await value(actions.call("report.preview", { what: String.fromCharCode(0x44b).repeat(900) }));
  assert.equal(preview.fits, false);
  assert.ok(preview.over > 0);
  const refused = await actions.call("report.open", { what: String.fromCharCode(0x44b).repeat(900) });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "too_long");
  assert.deepEqual(done.opened, []);
});

test("a line of the log cannot end the log's block early, and a line is cut to its limit", () => {
  const made = composeIssue({ fields: fieldsOf({}), about: ABOUT(), bar: { firmware: null, apiVersion: null }, lines: ["a ``` b", "````"], limit: Infinity, scrub: (text) => text });
  assert.match(made.body, /`{5}text\na ``` b\n````\n`{5}/);
  assert.match(made.body, /- Firmware: not running/);
});

test("the screenshot goes on the clipboard when ticked, and only a PNG", async () => {
  const dataDir = dataFolder();
  const { actions, done } = actionsFor(dataDir);
  const opened = await value(actions.call("report.open", { screenshot: true, image: IMAGE }));
  assert.equal(opened.screenshot, true);
  assert.deepEqual(done.images, [PNG]);
  assert.match(bodyOf(done.opened[0]), /### Screenshot\n_Paste the screenshot of the BUSY Bar here: the emulator put it on the clipboard\._/);
  // Not ticked, or not a PNG: nothing on the clipboard.
  await value(actions.call("report.open", { screenshot: false, image: IMAGE }));
  await value(actions.call("report.open", { screenshot: true, image: "data:image/png;base64,AAAA" }));
  await value(actions.call("report.open", { screenshot: true, image: "https://example.com/x.png" }));
  assert.equal(done.images.length, 1);
  assert.equal(pngOf(`data:image/jpeg;base64,${PNG.toString("base64")}`), null);
});

test("Save diagnostics: the archive goes where the person said, and every file in it is scrubbed; only it can be shown", async () => {
  const dataDir = dataFolder();
  const out = path.join(dataDir, "Chosen");
  mkdirSync(out);
  const { actions, done } = actionsFor(dataDir, { saveAs: path.join(out, "my report") });
  assert.equal(await value(actions.call("report.reveal")), false, "nothing saved yet");
  const saved = await value(actions.call("report.save", { title: "Freeze", what: `in ${PERSON.home}/x`, expected: "no freeze", screenshot: true, image: IMAGE }));
  assert.equal(saved.saved, true);
  assert.equal(saved.file, path.join(out, "my report.zip"));
  assert.equal(done.asked.length, 1);
  assert.equal(done.asked[0].texts.title, "Save Diagnostics");
  assert.match(done.asked[0].defaultPath, /Downloads[\\/]BUSY Bar Emulator diagnostics 2026-11-12 \d\d\.00\.00\.zip$/);
  const files = readZip(readFileSync(saved.file));
  assert.deepEqual([...files.keys()], ["report.md", "about.json", "logs/shell.log", "logs/shell.log.1", "run/emulator.json", "run/build-lines.jsonl", "app-settings.json", "screenshot.png"]);
  for (const [name, data] of files) if (name !== "screenshot.png") assertClean(data.toString("utf8"), name);
  assert.deepEqual(files.get("screenshot.png"), PNG);
  const report = files.get("report.md").toString("utf8");
  assert.match(report, /^# Freeze\n\n### What I did\nin <home>\/x/);
  assert.match(report, /The last 11 lines of the emulator's log:/);
  assert.match(files.get("logs/shell.log").toString("utf8"), /<home>\/BUSY Bar projects\/weather/);
  const about = JSON.parse(files.get("about.json").toString("utf8"));
  assert.deepEqual([about.version, about.bar.firmware, about.bar.apiVersion], ["0.1.0-beta.1", "1.3.1", "27.14.0"]);
  // The server's lock (its nonce) and its key are not taken.
  for (const data of files.values()) assert.ok(!data.toString("latin1").includes("s3cr3t-nonce-value"));
  assert.equal(await value(actions.call("report.reveal")), true);
  assert.deepEqual(done.shown, [saved.file]);
  // The dialog closed: nothing written, nothing else to show.
  const closed = actionsFor(dataDir).actions;
  assert.deepEqual(await value(closed.call("report.save", {})), { saved: false });
  assert.equal(await value(closed.call("report.reveal")), false);
});

test("a file of the data folder that is a link to somewhere else is not taken into the archive", async (t) => {
  if (process.platform === "win32") return t.skip("links need rights on Windows");
  const dataDir = dataFolder();
  const outside = realpathSync(temporaryFolder());
  folders.push(outside);
  writeFileSync(path.join(outside, "secret.txt"), "outside the data folder\n");
  const { symlinkSync, rmSync } = await import("node:fs");
  rmSync(path.join(dataDir, "app-settings.json"));
  symlinkSync(path.join(outside, "secret.txt"), path.join(dataDir, "app-settings.json"));
  const { actions } = actionsFor(dataDir, { saveAs: path.join(dataDir, "a.zip") });
  const saved = await value(actions.call("report.save", {}));
  assert.ok(!readZip(readFileSync(saved.file)).has("app-settings.json"));
});

test("the zip is a zip: names in UTF-8, deflated or stored, checksums right", () => {
  const files = [
    { name: "a.txt", data: "hello ".repeat(100) },
    { name: "logs/b.log", data: "x" },
    { name: `${String.fromCharCode(0x421, 0x43d, 0x438, 0x43c, 0x43e, 0x43a)}.png`, data: PNG },
  ];
  const zip = makeZip(files, new Date(2026, 10, 12, 15, 42, 8));
  assert.deepEqual(zip.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const back = readZip(zip);
  assert.deepEqual([...back.keys()], files.map((one) => one.name));
  assert.equal(back.get("a.txt").toString(), "hello ".repeat(100));
  assert.deepEqual(back.get(`${String.fromCharCode(0x421, 0x43d, 0x438, 0x43c, 0x43e, 0x43a)}.png`), PNG);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});
