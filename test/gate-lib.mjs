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
    if (f.running || f.ended) continue; // the progress lines; see stillRunning
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

/** A comparison suite's last line, "# totals pass=… fail=… skip=…". */
export function tallyTotals(text) {
  const m = last(text, /^# totals pass=(\d+) fail=(\d+) skip=(\d+)$/gm);
  return m ? { pass: Number(m[1]), fail: Number(m[2]), skip: Number(m[3]) } : { pass: NaN, fail: NaN, skip: NaN };
}

/** The export check's summary line. */
export function tallyExport(text) {
  const m = last(text, /(\d+) files checked; (\d+) findings .*?(\d+) stale exceptions, (\d+) exception problems/g);
  return m ? { pass: Number(m[1]) - Number(m[2]), fail: Number(m[2]) + Number(m[3]) + Number(m[4]), skip: 0, unit: "files" } : { pass: NaN, fail: NaN, skip: 0 };
}

/**
 * What makes a run less than the whole gate, or null for a whole run: { only, comparison, firmware, skip } as given.
 * `expectedSkips`: suites a run on this machine leaves out by design (gate:win: the shell's windows and the export
 * check); leaving out exactly those is still a whole run of that machine.
 */
export function partialScope({ only = null, comparison = false, firmware = null, skip = [], expectedSkips = [] }) {
  const parts = [];
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
