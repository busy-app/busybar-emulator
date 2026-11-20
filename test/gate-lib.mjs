// What test/gate.mjs reads out of a suite's output, and how it names a run that is not the whole gate. Kept apart from
// gate.mjs, which runs when it is imported, so that gate-lib.test.mjs can check it against real output of node --test.

/** The last match of `re` in `text` (output a test prints can look like a summary line; the runner's comes last). */
function last(text, re) {
  let found = null;
  for (const m of text.matchAll(re)) found = m;
  return found;
}

/**
 * A node:test run in TAP (--test-reporter=tap) of `files` (the paths as given to node --test): { pass, fail, skip,
 * reasons, problems }. `reasons`: why tests were skipped, a count for each reason. `problems`: what makes the suite
 * fail although node --test may call it a success —
 *   - a file that ran no test: node --test shows such a file as one passing test named by its path (it registered
 *     none, or ended the process before any of its tests ran);
 *   - a skip with no reason (test.skip(), { skip: true }, describe.skip()): nobody can tell when it would run;
 *   - a todo test, failing or not: a test that is not one yet.
 * Each problem counts as a failure. A file that ended its process after some of its tests ran (process.exit(0) in it
 * or in a module it imports) is not seen here: TAP shows only what ran. tallyEvents sees it.
 */
export function tallyTap(text, files = []) {
  const n = (re) => Number(last(text, re)?.[1] ?? NaN);
  const names = new Set(files.flatMap((f) => [f, f.replaceAll("\\", "/"), f.replaceAll("/", "\\")]));
  const reasons = new Map();
  const problems = [];
  for (const m of text.matchAll(/^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b ?(.*))?$/gm)) {
    const [, indent, , name, directive, why] = m;
    const reason = (why ?? "").trim();
    if (!indent && !directive && names.has(name.trim())) problems.push(`${name.trim()}: the file ran no test (it registered none, or ended before its tests did)`);
    if (directive === "SKIP") {
      if (!reason) problems.push(`"${name}": skipped with no reason (give one: { skip: "why" })`);
      else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    if (directive === "TODO") problems.push(`"${name}": a todo test${reason ? ` (${reason})` : ""}: finish it, or skip it with the reason it does not run`);
  }
  const fail = n(/^# fail (\d+)$/gm) + (n(/^# cancelled (\d+)$/gm) || 0);
  return { pass: n(/^# pass (\d+)$/gm), fail: fail + problems.length, skip: n(/^# skipped (\d+)$/gm) + (n(/^# todo (\d+)$/gm) || 0), reasons, problems };
}

/**
 * What gate-reporter.mjs wrote for a run (one JSON line per test file): the problems, one line each, of files whose
 * registered tests did not all finish — the process ended before them. `text` null: the reporter wrote nothing (the
 * run did not get as far as its end).
 */
export function tallyEvents(text) {
  if (text === null) return ["no record of which tests were registered and finished (test/gate-reporter.mjs wrote nothing): the run ended before node --test did"];
  const problems = [];
  for (const line of text.split("\n").filter(Boolean)) {
    let f;
    try {
      f = JSON.parse(line);
    } catch {
      problems.push(`test/gate-reporter.mjs wrote a line that is not JSON: ${line.slice(0, 80)}`);
      continue;
    }
    if (f.running || f.ended || f.failed) continue; // the progress lines (see stillRunning) and the failures (failuresOf)
    if (f.finished < f.registered) {
      const names = f.unfinished.slice(0, 3).map((n) => `"${n}"`).join(", ") + (f.unfinished.length > 3 ? ` and ${f.unfinished.length - 3} more` : "");
      problems.push(`${f.file}: ${f.registered - f.finished} of ${f.registered} registered tests never finished (${names}): the file's process ended before them (process.exit in it or in a module it imports?)`);
    }
  }
  return problems;
}

/** The files gate-reporter.mjs saw start and not end: what was still running when a suite was stopped. */
export function stillRunning(text) {
  const running = new Set();
  for (const line of (text ?? "").split("\n")) {
    try {
      const f = JSON.parse(line);
      if (f.running) running.add(f.running);
      if (f.ended) running.delete(f.ended);
    } catch {
      // A line cut short when the suite's process was killed.
    }
  }
  return [...running];
}

/**
 * The reasons a test may be skipped and the gate still be all green: each says where that test does run, or the
 * backlog task that will run it. A skip for any other reason makes the verdict "green, but N tests skipped" (exit code
 * 3): a reason nobody listed is a test nobody runs. `on`: the systems where the skip is allowed (default: every one);
 * `exported`: allowed only in the exported public tree; `release: false`: not allowed in the release's run of the
 * gate (EMU_GATE_RELEASE=1), which is where those tests run. The first entry whose pattern matches and whose
 * conditions hold names the layer. Add a reason here only with where it runs.
 */
export const ALLOWED_SKIPS = Object.freeze([
  {
    layer: "tests of Windows",
    where: "gate:win runs them on the Windows machine",
    on: ["darwin", "linux"],
    match: [/Windows/, /\bcmd\.exe\b/, /PowerShell/, /a " is a letter of a path elsewhere/],
  },
  {
    layer: "the shell's Electron tests of Windows",
    where: "gate:win --with-app runs the app suite in the Windows machine's desktop session (the title bar's tests among them)",
    on: ["darwin", "linux"],
    match: [/^macOS$/, /^macOS keeps the system's frame and menu bar$/],
  },
  {
    layer: "the installed Electron, when the app layer is not requested",
    where: "gate:win without --with-app leaves the shell's Electron suite (app) to a run with --with-app, where Electron is installed; `appLeftOut` is true only when this machine's gate leaves the app suite out as the machine's own skip",
    appLeftOut: true,
    match: [/^Electron's binary is not installed/],
  },
  {
    layer: "tests of macOS and POSIX systems",
    where: "the Mac's gate runs them",
    on: ["win32"],
    match: [/macOS/, /\bLinux\b/, /POSIX/, /\bsh\b/, /\bzsh\b/, /script\(1\)/, /\bps\b/, /\blinks?\b/, /file modes/, /signal|SIGTERM/, /sandbox-exec/, /\brights\b/, /ACLs/, /may not read/, /pipe is the proof/, /process groups/, /Rosetta/, /\bMac('s)?\b/, /private patterns/, /^Windows$/, /can be made read-only/, /permissions cannot be taken away/, /^closing the last window quits the app on this system$/],
  },
  {
    layer: "the release's own files",
    where: "npm run release runs them on what it built (stage 3: the public tree's gate with BUSY_EMULATOR_TEST_INSTALL_BUILD, BUSY_EMULATOR_SMOKE_APP, BUSY_EMULATOR_TEST_BUILT and BUSY_EMULATOR_TEST_RELEASE set, and EMU_GATE_RELEASE=1, which does not allow these skips)",
    release: false,
    match: [/BUSY_EMULATOR_TEST_INSTALL_BUILD/, /BUSY_EMULATOR_SMOKE_APP/, /BUSY_EMULATOR_TEST_BUILT/, /BUSY_EMULATOR_TEST_RELEASE/],
  },
  {
    layer: "the catalog's own checker",
    where: "EMU-128: needs a checkout of the catalog (BUSY_CATALOG_CHECKOUT) and Python with Pillow; until then by hand",
    match: [/BUSY_CATALOG_CHECKOUT/, /Pillow is not installed/, /no working python/],
  },
  {
    layer: "tests that need a machine of their own",
    where: "EMU-007: a window on the screen (or a system window a failing start may show), the clipboard, the firewall, the user's Start menu, a volume of another file system; until CI, by hand",
    match: [/BUSY_EMULATOR_TEST_DESKTOP/, /BUSY_EMULATOR_TEST_FAILING_STARTS/, /^the macOS tests cover it$/, /BUSY_EMULATOR_TEST_VISIBLE/, /BUSY_EMULATOR_TEST_CLIPBOARD/, /BUSY_EMULATOR_TEST_WEBRTC_OPEN/, /BUSY_EMULATOR_TEST_START_MENU/, /EMU_TEST_CASE_SENSITIVE_DIR/, /EMU_TEST_SIDECAR_DIR/],
  },
  {
    layer: "the guide's pictures",
    where: "by hand when the window changes (EMU-171): GUIDE_SHOTS=<folder> node --test packages/app/test/app/guide-shots.test.mjs, then the pictures into public-docs/images",
    match: [/^GUIDE_SHOTS=<folder> takes the guide's pictures$/],
  },
  {
    layer: "the recording of a BUSY Bar's API answers",
    where: "the api suite compares with test/api/bar-<firmware>.json when there is one; it is made on a BUSY Bar by hand (node emulator/test/api.mjs --bar --record; EMU-317 for 1.4.1)",
    match: [/^no recording of a BUSY Bar's API answers in test\/api\/ /],
  },
  {
    layer: "the engine's build",
    where: "by hand when the WebAssembly is built again (npm run build:engine, with EMU_FIRMWARE_REPO and EMSDK)",
    match: [/EMU_FIRMWARE_REPO/],
  },
  {
    layer: "what the public tree leaves out",
    where: "the monorepo's gate runs them (tools/export/export.json says what is left out and why)",
    exported: true,
    match: [/lives in the monorepo/, /left out of the public/, /test\/unpublished\.json/, /not in the public tree/, /\(emulator\/tools\/[^)]+\) is not in this tree/],
  },
]);

/**
 * Sorts skip reasons ({ reason → count } of every suite) into the allowed ones, by layer, and the rest.
 * Returns { allowed: [{ layer, where, count, reasons: [[reason, count]] }], unexpected: [[reason, count]] }.
 */
export function sortSkips(reasons, { platform = process.platform, exported = false, release = false, appLeftOut = false, allowed = ALLOWED_SKIPS } = {}) {
  const layers = new Map();
  const unexpected = [];
  for (const [reason, count] of reasons) {
    const entry = allowed.find((a) => (!a.on || a.on.includes(platform)) && (!a.exported || exported) && (a.release !== false || !release) && (!a.appLeftOut || appLeftOut) && a.match.some((re) => re.test(reason)));
    if (!entry) {
      unexpected.push([reason, count]);
      continue;
    }
    const layer = layers.get(entry) ?? { layer: entry.layer, where: entry.where, count: 0, reasons: [] };
    layer.count += count;
    layer.reasons.push([reason, count]);
    layers.set(entry, layer);
  }
  return { allowed: [...layers.values()], unexpected };
}

/**
 * The gate's verdict and exit code. 0 only for "all green": every suite ran (on the Windows machine: every one but
 * the two it cannot run, `machine`) and passed, and every skipped test was skipped for an allowed reason. 1: a suite
 * failed. 3: green, but not the whole gate — a partial run, a suite skipped, or tests skipped for reasons not on the
 * list. 130: stopped.
 */
export function verdictOf({ interrupted = false, failed = [], partial = null, machine = null, skippedSuites = [], unexpectedTests = 0 }) {
  if (interrupted) return { code: 130, text: "STOPPED before the end" };
  if (failed.length) return { code: 1, text: `FAILED: ${failed.join(", ")}` };
  if (partial) return { code: 3, text: `green, but a PARTIAL RUN, not the gate (${partial})` };
  const more = [];
  if (skippedSuites.length) more.push(`${skippedSuites.length} suites skipped (${skippedSuites.join(", ")})`);
  if (unexpectedTests) more.push(`${unexpectedTests} tests skipped for reasons not on the list of allowed ones`);
  if (more.length) return { code: 3, text: `green, but ${more.join(" and ")} (see skipped)` };
  return { code: 0, text: machine ? `all green ${machine}` : "all green" };
}

/** The suites the Windows machine cannot run and may leave out (tools/gate/win.mjs), and only it. */
export const MACHINE_SKIPPABLE = Object.freeze(["app", "export"]);

/**
 * Which of the suites named in EMU_GATE_MACHINE_SKIP count as left out by the machine: only on Windows with
 * EMU_GATE_REMOTE=windows (gate:win sets both, and runs there), and only those of MACHINE_SKIPPABLE. Anywhere else,
 * and any other suite, it is a skip on request, which makes the run partial: on a Mac the two variables give nothing.
 * Returns { machine, requested }, each { suite → why }.
 */
export function machineSkipsOf(skips, remote, platform = process.platform) {
  const machine = {};
  const requested = {};
  for (const [suite, why] of Object.entries(skips)) {
    if (remote === "windows" && platform === "win32" && MACHINE_SKIPPABLE.includes(suite)) machine[suite] = why;
    else requested[suite] = why;
  }
  return { machine, requested };
}

/** The reason the gate gives a comparison suite's skips that came without one: it is on no list, so never allowed. */
export const NO_REASON = "skipped with no reason given (own-emulator.mjs totals takes { reasons })";

/**
 * A comparison suite's last line, "# totals pass=… fail=… skip=…", and the reasons of its skips: the lines
 * "# skip <count> <reason>" before it (own-emulator.mjs totals). Skips the lines do not account for are counted under
 * NO_REASON, which no entry of ALLOWED_SKIPS takes: a skip without a reason makes the verdict "green, but …".
 */
export function tallyTotals(text) {
  const m = last(text, /^# totals pass=(\d+) fail=(\d+) skip=(\d+)$/gm);
  const reasons = new Map();
  for (const r of text.matchAll(/^# skip (\d+) (.+)$/gm)) reasons.set(r[2], (reasons.get(r[2]) ?? 0) + Number(r[1]));
  if (!m) return { pass: NaN, fail: NaN, skip: NaN, reasons };
  const given = [...reasons.values()].reduce((sum, n) => sum + n, 0);
  if (Number(m[3]) > given) reasons.set(NO_REASON, Number(m[3]) - given);
  return { pass: Number(m[1]), fail: Number(m[2]), skip: Number(m[3]), reasons };
}

/** The export check's summary line. */
export function tallyExport(text) {
  const m = last(text, /(\d+) files checked; (\d+) findings .*?(\d+) stale exceptions, (\d+) exception problems/g);
  return m ? { pass: Number(m[1]) - Number(m[2]), fail: Number(m[2]) + Number(m[3]) + Number(m[4]), skip: 0, unit: "files" } : { pass: NaN, fail: NaN, skip: 0 };
}

/**
 * What makes a run less than the whole gate, or null for a whole run: { only, comparison, firmware, skip } as given,
 * and `files`, the number of test files of a targeted run (--files, --changed).
 * `expectedSkips`: suites a run on this machine leaves out by design (gate:win: the shell's windows and the export
 * check); leaving out exactly those is still a whole run of that machine.
 */
export function partialScope({ only = null, comparison = false, firmware = null, skip = [], expectedSkips = [], files = null }) {
  const parts = [];
  if (files) parts.push(`targeted: ${files} test files`);
  if (only) parts.push(`--only ${only.join(",")}`);
  if (comparison) parts.push("--comparison");
  if (firmware) parts.push(`--firmware ${firmware.join(",")}`);
  const unexpected = skip.filter((s) => !expectedSkips.includes(s));
  if (unexpected.length) parts.push(`skipped on request: ${unexpected.join(",")}`);
  return parts.length ? parts.join("; ") : null;
}

/**
 * Whether a machine lock's file (its text: the holder's PID) is stale and may be taken away: empty, not a number, a
 * PID of 0 or 1 (process.kill(0, 0) signals the caller's own group and succeeds, so an empty lock once read as a live
 * holder for ever), or a holder that is gone. `alive(pid)` says whether a process is there. An empty or unreadable file
 * younger than `graceMs` may be one another gate has just made and not yet written: it is not stale yet.
 */
export function lockIsStale(text, { alive, ageMs = Infinity, graceMs = 5000 }) {
  const trimmed = String(text ?? "").trim();
  const pid = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(pid) || pid <= 1) return ageMs >= graceMs;
  return !alive(pid);
}

/**
 * The known flakes: tests that fail now and then for a reason that is not the change under test, each with the open
 * backlog task that is to fix it (EMU-330). A failure that matches an entry — its suite, system, file, test and error
 * all — is printed on a line of its own with the task's key and does not make the result red; any other failure does.
 * An entry is taken out once its test has passed 10 runs in a row after the fix; gate-lib.test.mjs checks that every
 * key names a task of the backlog that is not done.
 *   suite: the gate's suite; on: the systems where the failure is known; file: the test file, from the suite's folder,
 *   with "/"; test: the test's name; error: its error (the first line of its message).
 */
export const KNOWN_FLAKES = Object.freeze([
  {
    key: "EMU-328",
    suite: "app",
    on: ["win32"],
    file: "test/app/stage3d.test.mjs",
    test: /^the RGB LEDs at the ends of Start follow the state the page gives/,
    error: /The 3D view did not answer \(probe full\)/,
    why: "a full probe of the hidden 3D view waits for an animation frame, and Windows gives a hidden window one a second",
  },
]);

/**
 * The failures gate-reporter.mjs wrote (its "failed" lines), but the ones that only say that something inside them
 * failed (a describe block, a test whose subtest failed): [{ file, name, nesting, type, error }].
 */
export function failuresOf(text) {
  const failures = [];
  for (const line of (text ?? "").split("\n")) {
    let f;
    try {
      f = JSON.parse(line).failed;
    } catch {
      continue;
    }
    if (f && f.type !== "subtestsFailed") failures.push(f);
  }
  return failures;
}

/**
 * Sorts a suite's failures into the known flakes and the rest. `cwd`: the suite's folder, against which an entry's
 * file is read. Returns { known: [{ key, why, file, name, error }], unknown: [failure] }.
 */
export function sortFailures(failures, { suite, cwd, platform = process.platform, ledger = KNOWN_FLAKES }) {
  const known = [];
  const unknown = [];
  const relativeOf = (file) => {
    const a = String(file).replaceAll("\\", "/");
    const b = `${String(cwd).replaceAll("\\", "/").replace(/\/$/, "")}/`;
    return a.toLowerCase().startsWith(b.toLowerCase()) ? a.slice(b.length) : a;
  };
  for (const f of failures) {
    const file = relativeOf(f.file);
    const entry = ledger.find((e) => e.suite === suite && (!e.on || e.on.includes(platform)) && e.file === file && e.test.test(f.name) && e.error.test(f.error));
    if (entry) known.push({ key: entry.key, why: entry.why, file, name: f.name, error: f.error });
    else unknown.push(f);
  }
  return { known, unknown };
}

/**
 * Whether a red tap suite's failures are all known flakes, so that the suite counts as green (gate.mjs), and how its
 * failures sort. Green only when there was at least one failure, every failure matched an entry, no test the files
 * registered was left unfinished (a file that stopped midway: `unfinished`, tallyEvents), the tally found no other
 * problem, and the number of failed tests is the number of matched failures: a known flake must not hide anything
 * else (EMU-330 review). Returns { green, known, unknown }.
 */
export function flakeVerdict({ failures, unfinished = [], problems = [], fail, suite, cwd, platform = process.platform, ledger = KNOWN_FLAKES }) {
  const { known, unknown } = sortFailures(failures, { suite, cwd, platform, ledger });
  const green = failures.length > 0 && unknown.length === 0 && unfinished.length === 0 && problems.length === 0 && fail === known.length;
  return { green, known, unknown };
}

/**
 * What one gate run did with a test file, for gate:repeat (tools/gate/repeat.mjs): "passed" when at least one of its
 * tests passed, none failed (a known flake is a failure here) and none was left unfinished; "failed" when it failed
 * or the run was red with no test failing (a time limit, a process left behind: nobody can say the file passed);
 * "not run" when the run has no record of the file (a suite this machine leaves out, a file that skipped all its
 * tests) (EMU-330 review: exit code 3 or 0 counted as passed). `texts`: the run's <suite>.tests.jsonl; `file`: from
 * emulator/, with "/"; `runOk`: the run's verdict was green.
 */
export function fileOutcome(texts, file, runOk) {
  const name = `/${file.replaceAll("\\", "/").replace(/^emulator\//, "")}`;
  const mine = (path) => String(path).replaceAll("\\", "/").endsWith(name);
  let failed = false;
  let anyFailure = false;
  let passed = 0;
  let unfinished = 0;
  for (const text of texts) {
    for (const f of failuresOf(text)) {
      anyFailure = true;
      if (mine(f.file)) failed = true;
    }
    for (const line of (text ?? "").split("\n")) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry?.file || entry.registered === undefined || !mine(entry.file)) continue;
      passed += entry.passed ?? 0;
      unfinished += entry.unfinished?.length ?? 0;
    }
  }
  if (failed || unfinished || (!runOk && !anyFailure)) return "failed";
  return passed > 0 ? "passed" : "not run";
}

/** The files a module names: what it imports (import, export from, import()) and what it reads by new URL(…, import.meta.url). */
export function referencesOf(source) {
  const found = new Set();
  for (const re of [/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g]) {
    for (const m of source.matchAll(re)) if (m[1].startsWith(".")) found.add(m[1]);
  }
  return [...found];
}

/**
 * The test files a change touches, for a targeted run (gate --changed): the changed test files, and the test files
 * that reach a changed file through what they import or read (referencesOf), however many steps away. `changed` and
 * `tests`: paths from emulator/, with "/"; `read(file)`: a file's text, or null. Returns { files, why: file → reason }.
 * What a test reaches only through a process it starts (the window's code under the shell, the server under a
 * test's launch) is not seen: those tests are named with --files.
 */
export function touchedTests(changed, tests, read) {
  const changedSet = new Set(changed);
  const memo = new Map();
  const norm = (p) => {
    const parts = [];
    for (const part of p.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  };
  /** The changed file a module reaches, or null. */
  const reaches = (file, seen) => {
    if (memo.has(file)) return memo.get(file);
    if (seen.has(file)) return null;
    seen.add(file);
    let hit = null;
    const text = read(file);
    if (text !== null) {
      for (const ref of referencesOf(text)) {
        const target = norm(`${file.split("/").slice(0, -1).join("/")}/${ref}`);
        if (changedSet.has(target)) hit = target;
        else hit = /\.(mjs|js|cjs)$/.test(target) ? reaches(target, seen) : null;
        if (hit) break;
      }
    }
    memo.set(file, hit);
    return hit;
  };
  const why = new Map();
  for (const t of tests) {
    if (changedSet.has(t)) why.set(t, "changed");
    else {
      const hit = reaches(t, new Set());
      if (hit) why.set(t, `reaches ${hit}`);
    }
  }
  return { files: [...why.keys()], why };
}
